import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MovementKind, Prisma } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { canAccess } from '../access/security';
import { Audit } from '../audit/recorder';
import { CatalogService } from '../catalog/catalog';
import { PricingService, stockSettingsFields } from '../catalog/pricing';
import { Database, dayRange, idField, parse, sortField } from '../shared';
import { countFields, initialFields, kitOutFields, movementFields, StockService } from './stock';
import { WorkbookKind, WorkbookLists, workbookRows, workbookTemplate } from './workbooks';

// Costs in the load are registrations, so they also need that permission.
const registersCosts = (request: Authenticated) => canAccess(request.identity.permissions, 'registrations:operate');

const pageSize = 100;
// Only required columns of the movement: a cursor cannot continue past a NULL in the sorted column.
const historySort = ['kind', 'quantity', 'createdAt', 'reason'] as const;
const historyFields = z.object({
  cursor: idField.optional(), productId: idField.optional(), sort: sortField(historySort).optional(),
  kind: z.enum(MovementKind).optional(), from: z.iso.date().optional(), to: z.iso.date().optional(),
});

const Upload = () => UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }));

async function template(kind: WorkbookKind, lists?: WorkbookLists) {
  const filename = kind === 'initial' ? 'carga-inicial.xlsx' : 'inventario.xlsx';
  return new StreamableFile(await workbookTemplate(kind, lists), {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    disposition: 'attachment; filename="' + filename + '"',
  });
}

@Controller('stock')
export class StockController {
  constructor(
    @Inject(StockService) private stock: StockService,
    @Inject(CatalogService) private catalog: CatalogService,
    @Inject(PricingService) private pricing: PricingService,
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
  async movements(@Query() query: unknown) {
    const { cursor, sort, productId, kind, from, to } = parse(historyFields, query);
    const { key, direction } = sort ?? { key: 'createdAt' as const, direction: 'desc' as const };
    const movements = await this.db.movement.findMany({
      where: { productId, kind, createdAt: dayRange(from, to) },
      include: {
        product: { select: { sku: true, name: true, unit: { include: { family: { include: { units: { where: { isBase: true } } } } } } } },
        user: { select: { name: true } }, kit: { select: { sku: true } },
      },
      orderBy: [{ [key]: direction } as Prisma.MovementOrderByWithRelationInput, { id: direction }],
      take: pageSize + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return { movements: movements.slice(0, pageSize), nextCursor: movements.length > pageSize ? movements[pageSize - 1].id : null };
  }

  @Require('stock:operate')
  @Audit('Registrar movimentação')
  @Post('movements')
  movement(@Req() request: Authenticated, @Body() body: unknown) {
    return this.stock.movement(parse(movementFields, body), request.identity.id);
  }

  /** The price panel: base cost, linked costs and the active costs that can be linked. */
  @Require('stock:operate')
  @Get('products/:id/pricing')
  pricingView(@Param('id') id: string) {
    return this.pricing.view(parse(idField, id));
  }

  @Require('stock:operate')
  @Audit('Alterar parâmetros de estoque')
  @Patch('products/:id/settings')
  settings(@Param('id') id: string, @Body() body: unknown) {
    return this.pricing.saveSettings(parse(idField, id), parse(stockSettingsFields, body));
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
  async initialTemplate() {
    const [{ productTypes, units, references }, suppliers, printers] = await Promise.all([
      this.catalog.registrations(), this.db.supplier.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: 'asc' } }),
      this.db.printer.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: 'asc' } }),
    ]);
    const names = (kind: string) => references.filter(item => item.kind === kind).map(item => item.name);
    return template('initial', {
      Tipo: productTypes.map(type => type.name), Unidade: units.map(unit => unit.symbol), Grupo: names('GRUPO'),
      Marca: names('MARCA'), Cor: names('COR'), Departamento: names('DEPARTAMENTO'), Fornecedor: suppliers.map(supplier => supplier.name),
      Impressora: printers.map(printer => printer.name),
    });
  }

  @Require('catalog:operate', 'stock:operate')
  @Audit(false)
  @Post('initial/preview')
  @Upload()
  async initialPreview(@Req() request: Authenticated, @UploadedFile() file?: Express.Multer.File) {
    return this.stock.previewInitial(parse(initialFields, await workbookRows('initial', file)), request.identity.id, registersCosts(request));
  }

  @Require('catalog:operate', 'stock:operate')
  @Audit('Confirmar carga inicial')
  @Post('initial/:id/confirm')
  initialConfirm(@Req() request: Authenticated, @Param('id') id: string) {
    return this.stock.confirmInitial(parse(idField, id), request.identity.id, registersCosts(request));
  }
}
