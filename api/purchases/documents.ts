import {
  BadRequestException, Body, Controller, Delete, Get, Header, Inject, Injectable, NotFoundException, Param, Post, Query, Req, StreamableFile, UploadedFile,
} from '@nestjs/common';
import { Prisma, PurchaseDocumentType } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { Audit, auditContext } from '../audit/recorder';
import { FileService } from '../files/files';
import { attachmentHeader, hasDocumentExtension, matchesDocumentContent, purchaseDocumentLimit, purchaseDocumentMessage } from '../files/rules';
import { FileUpload } from '../files/upload';
import { Database, idField, parse, sortField } from '../shared';
import { storedDate } from './rules';

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

const searchSort = {
  uploadedAt: direction => ({ file: { createdAt: direction } }),
  name: direction => ({ file: { originalName: direction } }),
  size: direction => ({ file: { sizeBytes: direction } }),
  type: direction => ({ type: direction }),
  purchaseNumber: direction => ({ purchase: { number: direction } }),
  purchaseDate: direction => ({ purchase: { purchaseDate: direction } }),
  documentNumber: direction => ({ purchase: { documentNumber: { sort: direction, nulls: 'last' } } }),
  supplier: direction => ({ purchase: { supplier: { name: direction } } }),
} satisfies Record<string, (direction: Prisma.SortOrder) => Prisma.PurchaseDocumentOrderByWithRelationInput>;
const sortKeys = Object.keys(searchSort) as (keyof typeof searchSort)[];
const blankToUndefined = (value: unknown) => typeof value === 'string' && !value.trim() ? undefined : value;
const optional = <T extends z.ZodType>(field: T) => z.preprocess(blankToUndefined, field.optional());
export const searchFields = z.object({
  supplierId: optional(idField), productId: optional(idField), type: optional(documentTypeField),
  number: optional(z.string().trim().max(60)), from: optional(z.iso.date()), to: optional(z.iso.date()),
  sort: optional(sortField(sortKeys)), page: z.coerce.number().int().min(1).max(1_000_000).default(1),
}).refine(({ from, to }) => !from || !to || from <= to, 'O início do período não pode ser depois do fim');
export const searchPageSize = 25;

/** `contains` treats these characters as wildcards, and a document number is literal text. */
const literal = (value: string) => value.replace(/[\\%_]/g, '\\$&');

/** Only files that exist. The number matches the supplier's document or, when numeric, the purchase itself. */
export function searchWhere({ supplierId, productId, type, number, from, to }: z.infer<typeof searchFields>): Prisma.PurchaseDocumentWhereInput {
  const purchase: Prisma.PurchaseWhereInput = {
    ...(supplierId ? { supplierId } : {}),
    ...(productId ? { items: { some: { productId } } } : {}),
    ...(from || to ? { purchaseDate: { ...(from ? { gte: storedDate(from) } : {}), ...(to ? { lte: storedDate(to) } : {}) } } : {}),
    ...(number ? { OR: [
      { documentNumber: { contains: literal(number), mode: 'insensitive' as const } },
      ...(/^\d{1,9}$/.test(number) ? [{ number: Number(number) }] : []),
    ] } : {}),
  };
  return { file: { available: true }, ...(type ? { type } : {}), purchase };
}

@Injectable()
export class PurchaseDocumentSearch {
  constructor(@Inject(Database) private db: Database) {}

  async search(filters: z.infer<typeof searchFields>) {
    const where = searchWhere(filters);
    const { key, direction } = filters.sort ?? { key: 'uploadedAt' as const, direction: 'desc' as const };
    const [total, rows] = await Promise.all([
      this.db.purchaseDocument.count({ where }),
      this.db.purchaseDocument.findMany({
        where, orderBy: [searchSort[key](direction), { fileId: direction }], skip: (filters.page - 1) * searchPageSize, take: searchPageSize,
        select: {
          ...documentSelect,
          purchase: { select: { id: true, number: true, purchaseDate: true, documentNumber: true, converted: true, reversedAt: true, supplier: { select: { name: true } } } },
        },
      }),
    ]);
    return { documents: rows.map(({ purchase, ...row }) => ({ ...publicDocument(row), purchase })), total, page: filters.page, pageSize: searchPageSize };
  }

  /** Inactive suppliers and products stay listed, because their old documents are still searched. It carries no costs. */
  async filters() {
    const [suppliers, products] = await Promise.all([
      this.db.supplier.findMany({ where: { purchases: { some: {} } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.db.product.findMany({ where: { purchaseItems: { some: {} } }, select: { id: true, sku: true, name: true }, orderBy: { sku: 'asc' } }),
    ]);
    return { suppliers, products: products.map(({ id, sku, name }) => ({ id, name: sku + ' · ' + name })) };
  }
}

@Controller('purchase-documents')
export class PurchaseDocumentSearchController {
  constructor(@Inject(PurchaseDocumentSearch) private documents: PurchaseDocumentSearch) {}

  @Require('purchases:view')
  @Get()
  search(@Query() query: unknown) { return this.documents.search(parse(searchFields, query)); }

  @Require('purchases:view')
  @Get('filters')
  filters() { return this.documents.filters(); }
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
