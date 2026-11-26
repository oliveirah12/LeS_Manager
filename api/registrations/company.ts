import { BadRequestException, Body, Controller, Get, Header, Inject, Injectable, Post, Put, Req, StreamableFile, UploadedFile } from '@nestjs/common';
import { CompanySettings } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { Audit, auditChange } from '../audit/recorder';
import { FileService } from '../files/files';
import { hasImageExtension, imageType, productImageLimit, productImageMessage } from '../files/rules';
import { FileUpload } from '../files/upload';
import { Database, idField, nameField, parse, serial } from '../shared';

const settingsId = 'default';
export const blankToNull = (value: unknown) => typeof value === 'string' && !value.trim() ? null : value;
export const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max, 'Use até ' + max + ' caracteres').nullable()).default(null);

export const companyFields = z.object({
  name: nameField,
  tagline: optionalText(160),
  contact: optionalText(500),
  footer: optionalText(500),
  quoteValidityDays: z.coerce.number({ error: 'Informe a validade em dias' }).int('Informe a validade em dias inteiros')
    .min(1, 'A validade precisa ser de pelo menos 1 dia').max(365, 'A validade pode ser de até 365 dias'),
  /** A pending image becomes the new logo, null removes the current one, and leaving it out keeps it. */
  logoFileId: idField.nullable().optional(),
});
type CompanyData = z.infer<typeof companyFields>;

const values = (company: Pick<CompanySettings, 'name' | 'tagline' | 'contact' | 'footer' | 'quoteValidityDays'>, logo: string | null) => ({
  Nome: company.name, Slogan: company.tagline, Contato: company.contact, Rodapé: company.footer,
  'Validade do orçamento (dias)': company.quoteValidityDays, Logo: logo,
});

@Injectable()
export class CompanyService {
  constructor(@Inject(Database) private db: Database, @Inject(FileService) private files: FileService) {}

  /** The letterhead of the documents sent to customers. The row always exists, created by the migration. */
  async get() {
    const { logoFile, ...company } = await this.db.companySettings.findUniqueOrThrow({ where: { id: settingsId }, include: { logoFile: { select: { originalName: true } } } });
    return { ...company, logoName: logoFile?.originalName ?? null };
  }

  /** Data and logo share one transaction and one audit entry. The replaced logo is cleared after the commit. */
  async save({ logoFileId, ...data }: CompanyData, authorId: string) {
    const replaced = await serial(this.db, async tx => {
      const before = await tx.companySettings.findUniqueOrThrow({ where: { id: settingsId }, include: { logoFile: { select: { originalName: true } } } });
      const logo = logoFileId === undefined ? null : await this.files.linkCompanyLogo(tx, logoFileId, authorId);
      const after = await tx.companySettings.update({ where: { id: settingsId }, data });
      const beforeLogo = before.logoFile?.originalName ?? null;
      auditChange(values(before, beforeLogo), values(after, logo ? logo.after : beforeLogo));
      return logo?.replaced ?? null;
    });
    if (replaced) await this.files.purge([replaced]);
    return this.get();
  }

  openLogo() { return this.files.openCompanyLogo(); }
}

@Controller('company')
export class CompanyController {
  constructor(@Inject(CompanyService) private company: CompanyService, @Inject(FileService) private files: FileService) {}

  @Require('registrations:view')
  @Get()
  show() { return this.company.get(); }

  @Require('registrations:view')
  @Get('logo')
  @Header('X-Content-Type-Options', 'nosniff')
  async logo() {
    const file = await this.company.openLogo();
    // The type comes from the checked extension, never from what the browser declared.
    return new StreamableFile(file.content, { type: imageType(file.name), disposition: 'inline', length: file.size });
  }

  @Require('registrations:operate')
  @Audit('Alterar dados da empresa')
  @Put()
  save(@Req() request: Authenticated, @Body() body: unknown) { return this.company.save(parse(companyFields, body), request.identity.id); }

  /** The logo goes up before the save, like the product image. Only the save links and audits it. */
  @Require('registrations:operate')
  @Audit(false)
  @Post('uploads/logo')
  @FileUpload(productImageLimit, { name: hasImageExtension, message: productImageMessage })
  async uploadLogo(@Req() request: Authenticated, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Envie uma imagem.');
    try {
      return await this.files.storePending(file, request.identity.id, true);
    } finally {
      await this.files.discard(file);
    }
  }
}
