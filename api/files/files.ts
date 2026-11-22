import {
  BadRequestException, Controller, Delete, Get, Header, Inject, Injectable, NotFoundException, Param, Post, Req, StreamableFile, UnsupportedMediaTypeException, UploadedFile,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Authenticated, Require } from '../access/access';
import { Audit, auditChange, auditContext } from '../audit/recorder';
import { DailyTask, Database, idField, parse, serial } from '../shared';
import { attachmentHeader, hasBlockedExtension, hasExecutableSignature, productFileLimit, safeFileName, safeMimeType } from './rules';
import { FileStorage, newStorageKey } from './storage';
import { blockedFileMessage, FileUpload } from './upload';

const hour = 60 * 60 * 1000;
/** What leaves the API. The internal key stays private. */
const publicFile = {
  id: true, originalName: true, mimeType: true, sizeBytes: true, sha256: true, createdAt: true, createdBy: { select: { name: true } },
} as const;
const fileValues = (file: { originalName: string; mimeType: string; sizeBytes: number; sha256: string }) => ({
  Arquivo: file.originalName, Tipo: file.mimeType, 'Tamanho (bytes)': file.sizeBytes, 'SHA-256': file.sha256,
});

@Injectable()
export class FileService {
  constructor(@Inject(Database) private db: Database, @Inject(FileStorage) private storage: FileStorage) {}

  /**
   * Keeps a received file. The row is written first and only becomes available once the
   * content is in place, so a failure at any step never shows a file that does not exist.
   * `link` ties the file to its owner in the same transaction.
   */
  async store(upload: Express.Multer.File, authorId: string, link: (tx: Prisma.TransactionClient, fileId: string) => Promise<void>) {
    if (!upload.size) throw new BadRequestException('O arquivo está vazio.');
    const originalName = safeFileName(upload.originalname);
    if (hasBlockedExtension(originalName)) throw new UnsupportedMediaTypeException(blockedFileMessage);
    const { sha256, head } = await this.storage.inspect(upload.path);
    if (hasExecutableSignature(head)) throw new UnsupportedMediaTypeException(blockedFileMessage);
    const storageKey = newStorageKey();
    const file = await serial(this.db, async tx => {
      const row = await tx.storedFile.create({
        data: { originalName, mimeType: safeMimeType(upload.mimetype), sizeBytes: upload.size, sha256, storageKey, createdById: authorId }, select: publicFile,
      });
      await link(tx, row.id);
      return row;
    });
    try {
      await this.storage.save(upload.path, storageKey);
      await this.db.storedFile.update({ where: { id: file.id }, data: { available: true } });
    } catch (error) {
      await this.purge([file.id]);
      throw error;
    }
    auditChange(null, fileValues(file));
    return file;
  }

  /** The temporary file is gone after a successful save; on any failure this clears it. */
  discard(upload: Express.Multer.File) { return this.storage.discard(upload.path); }

  /** Removes contents and rows of files already marked unavailable. What fails stays marked for the next maintenance. */
  async purge(ids: string[]) {
    const files = await this.db.storedFile.findMany({ where: { id: { in: ids }, available: false }, select: { id: true, storageKey: true } });
    for (const file of files) {
      try {
        await this.storage.remove(file.storageKey);
        await this.db.storedFile.delete({ where: { id: file.id } });
      } catch {
        console.error('Falha ao remover arquivo armazenado.');
      }
    }
  }

  /** Finishes uploads and removals that a crash interrupted. */
  async maintain() {
    const stale = await this.db.storedFile.findMany({ where: { available: false, updatedAt: { lt: new Date(Date.now() - hour) } }, select: { id: true } });
    await this.purge(stale.map(file => file.id));
    if (process.env.FILE_STORAGE_DIR?.trim()) await this.storage.removeTemporaries(24 * hour);
  }

  async listForProduct(productId: string) {
    if (!await this.db.product.count({ where: { id: productId } })) throw new NotFoundException('Produto não encontrado.');
    const files = await this.db.storedFile.findMany({
      where: { available: true, product: { productId } }, select: publicFile, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return files.map(({ createdBy, ...file }) => ({ ...file, author: createdBy.name }));
  }

  async attachToProduct(productId: string, upload: Express.Multer.File, authorId: string) {
    const product = await this.db.product.findUnique({ where: { id: productId }, select: { sku: true } });
    if (!product) throw new NotFoundException('Produto não encontrado.');
    auditContext({ Produto: product.sku });
    const { createdBy, ...file } = await this.store(upload, authorId, async (tx, fileId) => {
      // Checked again inside the transaction, in case the product was deleted during the upload.
      if (!await tx.product.count({ where: { id: productId } })) throw new NotFoundException('Produto não encontrado.');
      await tx.productFile.create({ data: { fileId, productId } });
    });
    return { ...file, author: createdBy.name };
  }

  async openForProduct(productId: string, fileId: string) {
    const file = await this.db.storedFile.findFirst({
      where: { id: fileId, available: true, product: { productId } }, select: { originalName: true, sizeBytes: true, storageKey: true },
    });
    const content = file && await this.storage.open(file.storageKey);
    if (!file || !content) throw new NotFoundException('Arquivo não encontrado.');
    return { name: file.originalName, size: file.sizeBytes, content };
  }

  async removeFromProduct(productId: string, fileId: string) {
    await serial(this.db, async tx => {
      const file = await tx.storedFile.findFirst({
        where: { id: fileId, available: true, product: { productId } },
        select: { originalName: true, mimeType: true, sizeBytes: true, sha256: true, product: { select: { product: { select: { sku: true } } } } },
      });
      if (!file) throw new NotFoundException('Arquivo não encontrado.');
      auditContext({ Produto: file.product!.product.sku });
      auditChange(fileValues(file), null);
      await tx.storedFile.update({ where: { id: fileId }, data: { available: false } });
    });
    await this.purge([fileId]);
    return { id: fileId };
  }

  /** Part of the product deletion: call `purge` with the returned ids after the transaction commits. */
  async releaseProductFiles(tx: Prisma.TransactionClient, productId: string) {
    const links = await tx.productFile.findMany({ where: { productId }, select: { fileId: true, file: { select: { originalName: true, available: true } } } });
    const ids = links.map(link => link.fileId);
    await tx.storedFile.updateMany({ where: { id: { in: ids } }, data: { available: false } });
    await tx.productFile.deleteMany({ where: { productId } });
    return { ids, names: links.filter(link => link.file.available).map(link => link.file.originalName).sort() };
  }
}

@Injectable()
export class FileMaintenance extends DailyTask {
  constructor(@Inject(FileService) private files: FileService) { super(); }

  protected async run() {
    await this.files.maintain().catch(() => console.error('Falha na manutenção dos arquivos.'));
  }
}

@Controller('catalog/products/:id/files')
export class ProductFilesController {
  constructor(@Inject(FileService) private files: FileService) {}

  @Require('catalog:view')
  @Get()
  list(@Param('id') id: string) { return this.files.listForProduct(parse(idField, id)); }

  @Require('catalog:view')
  @Get(':fileId/download')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(@Param('id') id: string, @Param('fileId') fileId: string) {
    const file = await this.files.openForProduct(parse(idField, id), parse(idField, fileId));
    // Always generic binary: the browser saves the file and never runs or renders it.
    return new StreamableFile(file.content, { type: 'application/octet-stream', disposition: attachmentHeader(file.name), length: file.size });
  }

  // The guard runs before the upload, so a refused profile never writes to the disk.
  @Require('catalog:operate')
  @Audit('Enviar arquivo do produto')
  @Post()
  @FileUpload(productFileLimit)
  async upload(@Req() request: Authenticated, @Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Envie um arquivo.');
    try {
      return await this.files.attachToProduct(parse(idField, id), file, request.identity.id);
    } finally {
      await this.files.discard(file);
    }
  }

  @Require('catalog:operate')
  @Audit('Excluir arquivo do produto')
  @Delete(':fileId')
  remove(@Param('id') id: string, @Param('fileId') fileId: string) {
    return this.files.removeFromProduct(parse(idField, id), parse(idField, fileId));
  }
}
