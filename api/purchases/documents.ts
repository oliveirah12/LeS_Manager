import {
  BadRequestException, Body, Controller, Delete, Get, Header, Inject, Injectable, NotFoundException, Param, Post, Req, StreamableFile, UploadedFile,
} from '@nestjs/common';
import { PurchaseDocumentType } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { Audit, auditContext } from '../audit/recorder';
import { FileService } from '../files/files';
import { attachmentHeader, hasDocumentExtension, matchesDocumentContent, purchaseDocumentLimit, purchaseDocumentMessage } from '../files/rules';
import { FileUpload } from '../files/upload';
import { Database, idField, parse } from '../shared';

export const documentTypeLabels: Record<PurchaseDocumentType, string> = {
  INVOICE: 'Nota fiscal', RECEIPT: 'Recibo', PAYMENT_PROOF: 'Comprovante de pagamento', QUOTE: 'Orçamento', OTHER: 'Outro',
};
export const documentTypeField = z.enum(PurchaseDocumentType);
const attachFields = z.object({ type: documentTypeField });
export const documentSelect = {
  type: true,
  file: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true, createdAt: true, createdBy: { select: { name: true } } } },
} as const;

type DocumentRow = { type: PurchaseDocumentType; file: { id: string; originalName: string; mimeType: string; sizeBytes: number; createdAt: Date; createdBy: { name: string } } };
export const publicDocument = ({ type, file: { createdBy, ...file } }: DocumentRow) => ({ ...file, type, author: createdBy.name });

@Injectable()
export class PurchaseDocumentService {
  constructor(@Inject(Database) private db: Database, @Inject(FileService) private files: FileService) {}

  async list(purchaseId: string) {
    if (!await this.db.purchase.count({ where: { id: purchaseId } })) throw new NotFoundException('Compra não encontrada.');
    const rows = await this.db.purchaseDocument.findMany({
      where: { purchaseId, file: { available: true } }, select: documentSelect, orderBy: [{ file: { createdAt: 'desc' } }, { fileId: 'asc' }],
    });
    return rows.map(publicDocument);
  }

  async attach(purchaseId: string, type: PurchaseDocumentType, upload: Express.Multer.File, authorId: string) {
    const purchase = await this.db.purchase.findUnique({ where: { id: purchaseId }, select: { number: true } });
    if (!purchase) throw new NotFoundException('Compra não encontrada.');
    auditContext({ Compra: purchase.number, 'Tipo do documento': documentTypeLabels[type] });
    const { createdBy, ...file } = await this.files.store(
      upload, authorId, async (tx, fileId) => { await tx.purchaseDocument.create({ data: { fileId, purchaseId, type } }); },
      { content: matchesDocumentContent, message: purchaseDocumentMessage },
    );
    return { ...file, type, author: createdBy.name };
  }

  open(purchaseId: string, fileId: string) { return this.files.open({ id: fileId, purchaseDocument: { purchaseId } }); }

  async remove(purchaseId: string, fileId: string) {
    const document = await this.db.purchaseDocument.findFirst({ where: { fileId, purchaseId }, select: { type: true, purchase: { select: { number: true } } } });
    if (!document) throw new NotFoundException('Arquivo não encontrado.');
    auditContext({ Compra: document.purchase.number, 'Tipo do documento': documentTypeLabels[document.type] });
    return this.files.remove({ id: fileId, purchaseDocument: { purchaseId } });
  }

  /** The temporary file is gone after a successful save; on any failure this clears it. */
  discard(upload: Express.Multer.File) { return this.files.discard(upload); }
}

@Controller('purchases/:id/documents')
export class PurchaseDocumentController {
  constructor(@Inject(PurchaseDocumentService) private documents: PurchaseDocumentService) {}

  @Require('purchases:view')
  @Get()
  list(@Param('id') id: string) { return this.documents.list(parse(idField, id)); }

  @Require('purchases:view')
  @Get(':fileId/download')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(@Param('id') id: string, @Param('fileId') fileId: string) {
    const file = await this.documents.open(parse(idField, id), parse(idField, fileId));
    // Always generic binary: the browser saves the file and never runs or renders it.
    return new StreamableFile(file.content, { type: 'application/octet-stream', disposition: attachmentHeader(file.name), length: file.size });
  }

  // The guard runs before the upload, so a refused profile never writes to the disk.
  @Require('purchases:operate')
  @Audit('Anexar documento da compra')
  @Post()
  @FileUpload(purchaseDocumentLimit, { name: hasDocumentExtension, message: purchaseDocumentMessage })
  async attach(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Envie um arquivo.');
    try {
      const { type } = parse(attachFields, body);
      return await this.documents.attach(parse(idField, id), type, file, request.identity.id);
    } finally {
      await this.documents.discard(file);
    }
  }

  @Require('purchases:operate')
  @Audit('Excluir documento da compra')
  @Delete(':fileId')
  remove(@Param('id') id: string, @Param('fileId') fileId: string) {
    return this.documents.remove(parse(idField, id), parse(idField, fileId));
  }
}
