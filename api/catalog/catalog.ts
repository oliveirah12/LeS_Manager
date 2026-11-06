import { BadRequestException, Body, Controller, Get, Inject, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { Prisma, ReferenceKind } from '@prisma/client';
import { z } from 'zod';
import { Require } from '../access/access';
import { Database, idField, nameField, parse, positive, serial, skuField, storedDecimal } from '../shared';

const referenceField = z.object({ kind: z.enum(ReferenceKind), name: nameField });
const symbolField = z.string().trim().min(1).max(24);
const familyField = z.object({ name: nameField, baseSymbol: symbolField });
const unitField = z.object({
  familyId: idField, symbol: symbolField,
  factor: positive.refine(value => value.lt('1000000000000'), 'Fator fora da precisão permitida'),
});
export const productFields = z.object({
  sku: skuField, name: nameField, unitId: idField,
  groupId: idField.nullish(), brandId: idField.nullish(), colorId: idField.nullish(), departmentId: idField.nullish(),
});
const productUpdate = productFields.omit({ sku: true, unitId: true });
const kitFields = z.object({
  sku: skuField, name: nameField,
  components: z.array(z.object({ productId: idField, unitId: idField, quantity: positive })).min(1).max(100),
});
export const productInclude = { unit: { include: { family: { include: { units: { where: { isBase: true } } } } } } } as const;
const catalogProduct = {
  id: true, sku: true, name: true, unitId: true, groupId: true, brandId: true, colorId: true, departmentId: true,
  ...productInclude,
} as const;
const references = [
  ['groupId', ReferenceKind.GRUPO], ['brandId', ReferenceKind.MARCA],
  ['colorId', ReferenceKind.COR], ['departmentId', ReferenceKind.DEPARTAMENTO],
] as const;

export function inBase(unit: { familyId: string; factor: Prisma.Decimal }, familyId: string, quantity: Prisma.Decimal) {
  if (unit.familyId !== familyId) throw new BadRequestException('A unidade não pertence à família de medida do produto.');
  return storedDecimal(quantity.times(unit.factor));
}

@Injectable()
export class CatalogService {
  constructor(@Inject(Database) private db: Database) {}

  async registrations() {
    const [families, units, references] = await Promise.all([
      this.db.unitFamily.findMany({ orderBy: { name: 'asc' } }),
      this.db.unit.findMany({ orderBy: { symbol: 'asc' } }),
      this.db.reference.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] }),
    ]);
    return { families, units, references };
  }

  async overview() {
    const [registrations, products, kits] = await Promise.all([
      this.registrations(),
      this.db.product.findMany({ select: catalogProduct, orderBy: { sku: 'asc' } }),
      this.db.kit.findMany({
        include: { components: { include: { product: { select: catalogProduct } } } },
        orderBy: { sku: 'asc' },
      }),
    ]);
    return { ...registrations, products, kits };
  }

  async stockView() {
    const [products, kits] = await Promise.all([
      this.db.product.findMany({ include: productInclude, orderBy: { sku: 'asc' } }),
      this.db.kit.findMany({ include: { components: { include: { product: { include: productInclude } } } }, orderBy: { sku: 'asc' } }),
    ]);
    const kitsWithAvailability = kits.map(kit => ({
      ...kit,
      available: Prisma.Decimal.min(...kit.components.map(component => component.product.quantity.div(component.quantity).floor())),
    }));
    return { products, kits: kitsWithAvailability };
  }

  async assertReferences(tx: Prisma.TransactionClient, data: z.infer<typeof productUpdate>) {
    const ids = references.flatMap(([field]) => data[field] ? [data[field]] : []);
    const found = await tx.reference.findMany({ where: { id: { in: ids } } });
    for (const [field, kind] of references) {
      if (data[field] && !found.some(reference => reference.id === data[field] && reference.kind === kind)) {
        throw new BadRequestException('Classificação inválida: ' + kind);
      }
    }
  }

  async createProduct(tx: Prisma.TransactionClient, data: z.infer<typeof productFields>) {
    await this.assertReferences(tx, data);
    return tx.product.create({ data, include: productInclude });
  }

  async saveKit(data: z.infer<typeof kitFields>, id?: string) {
    const uniqueIds = new Set(data.components.map(component => component.productId));
    if (uniqueIds.size !== data.components.length) throw new BadRequestException('Inclua cada produto apenas uma vez no kit.');
    return serial(this.db, async tx => {
      const [products, units] = await Promise.all([
        tx.product.findMany({ where: { id: { in: [...uniqueIds] } }, include: { unit: true } }),
        tx.unit.findMany({ where: { id: { in: data.components.map(item => item.unitId) } } }),
      ]);
      const components = data.components.map(item => {
        const product = products.find(row => row.id === item.productId);
        const unit = units.find(row => row.id === item.unitId);
        if (!product || !unit) throw new NotFoundException('Produto ou unidade do kit não encontrado.');
        return { productId: product.id, quantity: inBase(unit, product.unit.familyId, item.quantity) };
      });
      if (id) {
        return tx.kit.update({
          where: { id }, data: { sku: data.sku, name: data.name, components: { deleteMany: {}, create: components } },
        });
      }
      return tx.kit.create({ data: { sku: data.sku, name: data.name, components: { create: components } } });
    });
  }
}

@Controller('catalog')
export class CatalogController {
  constructor(@Inject(Database) private db: Database, @Inject(CatalogService) private catalog: CatalogService) {}

  @Require('catalog:view')
  @Get()
  overview() { return this.catalog.overview(); }

  @Require('registrations:view')
  @Get('registrations')
  registrations() { return this.catalog.registrations(); }

  @Require('registrations:operate')
  @Post('references')
  addReference(@Body() body: unknown) { return this.db.reference.create({ data: parse(referenceField, body) }); }

  @Require('registrations:operate')
  @Patch('references/:id')
  updateReference(@Param('id') id: string, @Body() body: unknown) {
    return this.db.reference.update({ where: { id: parse(idField, id) }, data: parse(referenceField.pick({ name: true }), body) });
  }

  @Require('admin')
  @Post('families')
  family(@Body() body: unknown) {
    const data = parse(familyField, body);
    return this.db.unitFamily.create({
      data: { name: data.name, units: { create: { symbol: data.baseSymbol, factor: 1, isBase: true } } },
      include: { units: true },
    });
  }

  @Require('admin')
  @Post('units')
  unit(@Body() body: unknown) { return this.db.unit.create({ data: parse(unitField, body) }); }

  @Require('catalog:operate')
  @Post('products')
  addProduct(@Body() body: unknown) {
    const data = parse(productFields, body);
    return serial(this.db, tx => this.catalog.createProduct(tx, data));
  }

  @Require('catalog:operate')
  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() body: unknown) {
    const data = parse(productUpdate, body);
    const productId = parse(idField, id);
    return serial(this.db, async tx => {
      await this.catalog.assertReferences(tx, data);
      return tx.product.update({ where: { id: productId }, data, select: catalogProduct });
    });
  }

  @Require('catalog:operate')
  @Post('kits')
  addKit(@Body() body: unknown) { return this.catalog.saveKit(parse(kitFields, body)); }

  @Require('catalog:operate')
  @Patch('kits/:id')
  updateKit(@Param('id') id: string, @Body() body: unknown) {
    return this.catalog.saveKit(parse(kitFields, body), parse(idField, id));
  }
}
