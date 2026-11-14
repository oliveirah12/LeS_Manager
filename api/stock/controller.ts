import { Body, Controller, Get, Inject, Param, Post, Req, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Authenticated, Require } from '../access/access';
import { Audit } from '../audit/recorder';
import { CatalogService } from '../catalog/catalog';
import { Database, idField, parse } from '../shared';
import { countFields, initialFields, kitOutFields, movementFields, StockService } from './stock';
import { WorkbookKind, workbookRows, workbookTemplate } from './workbooks';

const Upload = () => UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }));

async function template(kind: WorkbookKind) {
  const filename = kind === 'initial' ? 'carga-inicial.xlsx' : 'inventario.xlsx';
  return new StreamableFile(await workbookTemplate(kind), {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    disposition: 'attachment; filename="' + filename + '"',
  });
}

@Controller('stock')
export class StockController {
  constructor(
    @Inject(StockService) private stock: StockService,
    @Inject(CatalogService) private catalog: CatalogService,
    @Inject(Database) private db: Database,
  ) {}

  @Require('stock:view')
  @Get()
  async overview() {
    const [view, units] = await Promise.all([this.catalog.stockView(), this.db.unit.findMany({ orderBy: { symbol: 'asc' } })]);
    return { ...view, units };
  }

  @Require('stock:view')
  @Get('movements')
  movements() {
    return this.db.movement.findMany({
      include: {
        product: { select: { sku: true, name: true, unit: { include: { family: { include: { units: { where: { isBase: true } } } } } } } },
        user: { select: { name: true } }, kit: { select: { sku: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200,
    });
  }

  @Require('stock:operate')
  @Audit('Registrar movimentação')
  @Post('movements')
  movement(@Req() request: Authenticated, @Body() body: unknown) {
    return this.stock.movement(parse(movementFields, body), request.identity.id);
  }

  @Require('stock:operate')
  @Audit('Registrar saída de kit')
  @Post('kits/:id/out')
  kitOut(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.stock.kitOut(parse(idField, id), parse(kitOutFields, body), request.identity.id);
  }

  @Require('stock:operate')
  @Get('inventory/template')
  inventoryTemplate() { return template('inventory'); }

  @Require('stock:operate')
  @Audit(false)
  @Post('inventory/preview')
  inventoryPreview(@Req() request: Authenticated, @Body() body: unknown) {
    return this.stock.previewCount(parse(countFields, body), request.identity.id);
  }

  @Require('stock:operate')
  @Audit(false)
  @Post('inventory/upload')
  @Upload()
  async inventoryUpload(@Req() request: Authenticated, @UploadedFile() file?: Express.Multer.File) {
    return this.stock.previewCount(parse(countFields, await workbookRows('inventory', file)), request.identity.id);
  }

  @Require('stock:operate')
  @Audit('Confirmar inventário')
  @Post('inventory/:id/confirm')
  inventoryConfirm(@Req() request: Authenticated, @Param('id') id: string) {
    return this.stock.confirmCount(parse(idField, id), request.identity.id);
  }

  @Require('catalog:operate', 'stock:operate')
  @Get('initial/template')
  initialTemplate() { return template('initial'); }

  @Require('catalog:operate', 'stock:operate')
  @Audit(false)
  @Post('initial/preview')
  @Upload()
  async initialPreview(@Req() request: Authenticated, @UploadedFile() file?: Express.Multer.File) {
    return this.stock.previewInitial(parse(initialFields, await workbookRows('initial', file)), request.identity.id);
  }

  @Require('catalog:operate', 'stock:operate')
  @Audit('Confirmar carga inicial')
  @Post('initial/:id/confirm')
  initialConfirm(@Req() request: Authenticated, @Param('id') id: string) {
    return this.stock.confirmInitial(parse(idField, id), request.identity.id);
  }
}
