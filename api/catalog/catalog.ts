import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Patch, Post,
} from '@nestjs/common';
import { Prisma, ProductionStatus, ReferenceKind } from '@prisma/client';
import { z } from 'zod';
import { Require } from '../access/access';
import { Audit, auditChange } from '../audit/recorder';
import { Database, idField, nameField, parse, positive, serial, skuField, storedDecimal } from '../shared';
import { kitCosting, stockValue, sumValues } from '../stock/cost';

const referenceField = z.object({ kind: z.enum(ReferenceKind), name: nameField });
const symbolField = z.string().trim().min(1).max(24);
const familyField = z.object({ name: nameField, baseSymbol: symbolField });
const unitField = z.object({
  familyId: idField, symbol: symbolField,
  factor: positive.refine(value => value.lt('1000000000000'), 'Fator fora da precisão permitida'),
});
const unitUpdate = unitField.omit({ familyId: true });
export const productFields = z.object({
  sku: skuField, name: nameField, unitId: idField, typeId: idField.optional(),
  groupId: idField.nullish(), brandId: idField.nullish(), colorId: idField.nullish(), departmentId: idField.nullish(),
});
const productUpdate = productFields.partial({ sku: true, unitId: true });
const productTypeFields = z.object({ name: nameField, isInput: z.boolean(), isManufactured: z.boolean() });
/** Default type of every product, created by the migration. */
export const defaultProductType = '00000000-0000-4000-8000-000000000001';
const statusFields = z.strictObject({ active: z.boolean() });
const situation = (active: boolean) => active ? 'Ativo' : 'Inativo';
const kitFields = z.object({
  sku: skuField, name: nameField,
  components: z.array(z.object({ productId: idField, unitId: idField, quantity: positive })).min(1).max(100),
});
export const productInclude = { unit: { include: { family: { include: { units: { where: { isBase: true } } } } } } } as const;
const catalogProduct = {
  id: true, sku: true, name: true, active: true, typeId: true, unitId: true, groupId: true, brandId: true, colorId: true, departmentId: true,
  ...productInclude,
} as const;
const references = [
  ['groupId', ReferenceKind.GRUPO], ['brandId', ReferenceKind.MARCA],
  ['colorId', ReferenceKind.COR], ['departmentId', ReferenceKind.DEPARTAMENTO],
] as const;

const productAudit = {
  sku: true, name: true, type: { select: { name: true } }, unit: { select: { symbol: true } }, group: { select: { name: true } }, brand: { select: { name: true } },
  color: { select: { name: true } }, department: { select: { name: true } },
} as const;
type AuditedProduct = Prisma.ProductGetPayload<{ select: typeof productAudit }>;
const productValues = (product: AuditedProduct) => ({
  SKU: product.sku, Nome: product.name, Tipo: product.type.name, Unidade: product.unit.symbol, Grupo: product.group?.name ?? null,
  Marca: product.brand?.name ?? null, Cor: product.color?.name ?? null, Departamento: product.department?.name ?? null,
});
type AuditedKit = { sku: string; name: string; components: { quantity: Prisma.Decimal; product: { sku: string } }[] };
const kitValues = (kit: AuditedKit) => ({
  SKU: kit.sku, Nome: kit.name,
  Componentes: kit.components.map(item => item.product.sku + ' × ' + item.quantity.toFixed()).sort(),
});
const kitAudit = { components: { include: { product: { select: { sku: true } } } } } as const;
const productUsage = {
  _count: { select: {
    movements: true, kitComponents: true, recipe: true, usedInRecipes: true, productionItems: true, productionInputs: true, inventoryRows: { where: { batch: { confirmedAt: { not: null } } } },
  } },
} as const;
const kitUsage = { _count: { select: { movements: true } } } as const;

/** Why a product is in use. Such a product cannot be deleted or moved to another unit family. */
function productBlock(usage: {
  movements: number; kitComponents: number; inventoryRows: number; recipe: number; usedInRecipes: number; productionItems: number; productionInputs: number;
}) {
  if (usage.movements) return 'O produto tem movimentações no histórico.';
  if (usage.productionItems || usage.productionInputs) return 'O produto consta em ordens de produção.';
  if (usage.kitComponents) return 'O produto compõe um kit.';
  if (usage.inventoryRows) return 'O produto consta em inventário confirmado.';
  if (usage.recipe) return 'O produto tem ficha técnica.';
  return usage.usedInRecipes ? 'O produto é insumo de uma ficha técnica.' : null;
}
const kitBlock = (usage: { movements: number }) => usage.movements ? 'O kit tem saídas no histórico.' : null;
function productTypeBlock(id: string, products: number) {
  if (id === defaultProductType) return 'Este é o tipo padrão dos produtos.';
  return products ? 'O tipo está em uso por ' + products + (products === 1 ? ' produto.' : ' produtos.') : null;
}
/**
 * Stored quantities do not record the unit that was typed, so any balance or history
 * in a family means its conversion factors may already be part of the data.
 */
const usedProduct: Prisma.ProductWhereInput = {
  OR: [
    { quantity: { not: 0 } }, { movements: { some: {} } }, { kitComponents: { some: {} } }, { inventoryRows: { some: {} } },
    { recipe: { some: {} } }, { usedInRecipes: { some: {} } }, { productionItems: { some: {} } }, { productionInputs: { some: {} } },
  ],
};
const familyInUseMessage = 'A família já tem saldo ou histórico.';
const familyBlock = (products: number) => products ? 'A família tem produtos cadastrados.' : null;
function unitFactorBlock(unit: { isBase: boolean }, familyInUse: boolean) {
  if (unit.isBase) return 'A unidade base sempre tem fator 1.';
  return familyInUse ? familyInUseMessage : null;
}
function unitDeleteBlock(unit: { isBase: boolean }, products: number, familyInUse: boolean) {
  if (unit.isBase) return 'A unidade base só sai junto com a família.';
  if (products) return 'Há produtos cadastrados nesta unidade.';
  return familyInUse ? familyInUseMessage : null;
}
const unitValues = (unit: { symbol: string; factor: Prisma.Decimal; family: { name: string } }) => ({
  'Símbolo': unit.symbol, Fator: unit.factor.toFixed(), 'Família': unit.family.name,
});
const yesNo = (value: boolean) => value ? 'Sim' : 'Não';
const productTypeValues = (type: z.infer<typeof productTypeFields>) => ({
  Nome: type.name, 'Usado como insumo': yesNo(type.isInput), 'É fabricado': yesNo(type.isManufactured),
});

export function inBase(unit: { familyId: string; factor: Prisma.Decimal }, familyId: string, quantity: Prisma.Decimal) {
  if (unit.familyId !== familyId) throw new BadRequestException('A unidade não pertence à família de medida do produto.');
  return storedDecimal(quantity.times(unit.factor));
}

@Injectable()
export class CatalogService {
  constructor(@Inject(Database) private db: Database) {}

  async registrations() {
    const [families, units, storedReferences, types, usedUnits] = await Promise.all([
      this.db.unitFamily.findMany({ orderBy: { name: 'asc' } }),
      this.db.unit.findMany({ include: { _count: { select: { products: true } } }, orderBy: { symbol: 'asc' } }),
      this.db.reference.findMany({
        include: { _count: { select: { groups: true, brands: true, colors: true, departments: true } } },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      }),
      this.db.productType.findMany({ include: { _count: { select: { products: true } } }, orderBy: { name: 'asc' } }),
      this.db.unit.findMany({ where: { products: { some: usedProduct } }, select: { familyId: true }, distinct: ['familyId'] }),
    ]);
    const productTypes = types.map(({ _count, ...type }) => ({
      ...type, products: _count.products, isDefault: type.id === defaultProductType, deleteBlock: productTypeBlock(type.id, _count.products),
    }));
    const inUse = new Set(usedUnits.map(unit => unit.familyId));
    const references = storedReferences.map(({ _count, ...reference }) => ({
      ...reference, products: _count.groups + _count.brands + _count.colors + _count.departments,
    }));
    return {
      references, productTypes,
      families: families.map(family => {
        const products = units.filter(unit => unit.familyId === family.id).reduce((total, unit) => total + unit._count.products, 0);
        return { ...family, products, deleteBlock: familyBlock(products) };
      }),
      units: units.map(({ _count, ...unit }) => ({
        ...unit, products: _count.products,
        factorBlock: unitFactorBlock(unit, inUse.has(unit.familyId)),
        deleteBlock: unitDeleteBlock(unit, _count.products, inUse.has(unit.familyId)),
      })),
    };
  }

  private async familyInUse(tx: Prisma.TransactionClient, familyId: string) {
    return await tx.product.count({ where: { unit: { familyId }, ...usedProduct } }) > 0;
  }

  updateFamily(id: string, name: string) {
    return serial(this.db, async tx => {
      const before = await tx.unitFamily.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Família não encontrada.');
      auditChange({ Nome: before.name }, { Nome: name });
      return tx.unitFamily.update({ where: { id }, data: { name } });
    });
  }

  /** A family without products goes away with all of its units. */
  deleteFamily(id: string) {
    return serial(this.db, async tx => {
      const family = await tx.unitFamily.findUnique({ where: { id }, include: { units: { orderBy: { symbol: 'asc' } } } });
      if (!family) throw new NotFoundException('Família não encontrada.');
      const block = familyBlock(await tx.product.count({ where: { unit: { familyId: id } } }));
      if (block) throw new ConflictException(block);
      await tx.unit.deleteMany({ where: { familyId: id } });
      await tx.unitFamily.delete({ where: { id } });
      auditChange({ Nome: family.name, Unidades: family.units.map(unit => unit.symbol) }, null);
      return { id };
    });
  }

  updateUnit(id: string, data: z.infer<typeof unitUpdate>) {
    return serial(this.db, async tx => {
      const before = await tx.unit.findUnique({ where: { id }, include: { family: { select: { name: true } } } });
      if (!before) throw new NotFoundException('Unidade não encontrada.');
      if (!data.factor.eq(before.factor)) {
        const block = unitFactorBlock(before, await this.familyInUse(tx, before.familyId));
        if (block) throw new ConflictException(block + ' O fator não pode mudar.');
      }
      const unit = await tx.unit.update({ where: { id }, data, include: { family: { select: { name: true } } } });
      auditChange(unitValues(before), unitValues(unit));
      const { family: _family, ...saved } = unit;
      return saved;
    });
  }

  deleteUnit(id: string) {
    return serial(this.db, async tx => {
      const unit = await tx.unit.findUnique({
        where: { id }, include: { family: { select: { name: true } }, _count: { select: { products: true } } },
      });
      if (!unit) throw new NotFoundException('Unidade não encontrada.');
      const block = unitDeleteBlock(unit, unit._count.products, await this.familyInUse(tx, unit.familyId));
      if (block) throw new ConflictException(block);
      await tx.unit.delete({ where: { id } });
      auditChange(unitValues(unit), null);
      return { id };
    });
  }

  saveProductType(data: z.infer<typeof productTypeFields>, id?: string) {
    return serial(this.db, async tx => {
      const before = id ? await tx.productType.findUnique({ where: { id } }) : null;
      if (id && !before) throw new NotFoundException('Tipo de produto não encontrado.');
      if (before?.isManufactured && !data.isManufactured && await tx.productInput.count({ where: { product: { typeId: id } } })) {
        throw new ConflictException('Há produtos deste tipo com ficha técnica, então ele precisa continuar fabricado.');
      }
      if (before?.isInput && !data.isInput && await tx.productInput.count({ where: { input: { typeId: id } } })) {
        throw new ConflictException('Há produtos deste tipo em fichas técnicas, então ele precisa continuar como insumo.');
      }
      auditChange(before && productTypeValues(before), productTypeValues(data));
      return id ? tx.productType.update({ where: { id }, data }) : tx.productType.create({ data });
    });
  }

  deleteProductType(id: string) {
    return serial(this.db, async tx => {
      const type = await tx.productType.findUnique({ where: { id }, include: { _count: { select: { products: true } } } });
      if (!type) throw new NotFoundException('Tipo de produto não encontrado.');
      const block = productTypeBlock(id, type._count.products);
      if (block) throw new ConflictException(block);
      await tx.productType.delete({ where: { id } });
      auditChange(productTypeValues(type), null);
      return { id };
    });
  }

  async overview() {
    const [registrations, products, kits] = await Promise.all([
      this.registrations(),
      this.db.product.findMany({ select: { ...catalogProduct, ...productUsage }, orderBy: { sku: 'asc' } }),
      this.db.kit.findMany({
        include: { components: { include: { product: { select: catalogProduct } } }, ...kitUsage },
        orderBy: { sku: 'asc' },
      }),
    ]);
    return {
      ...registrations,
      products: products.map(({ _count, ...product }) => ({ ...product, hasRecipe: _count.recipe > 0, deleteBlock: productBlock(_count) })),
      kits: kits.map(({ _count, ...kit }) => ({ ...kit, deleteBlock: kitBlock(_count) })),
    };
  }

  /** Balance and cost of every product, kept apart from the catalog because they need stock:view. */
  async balances() {
    const [products, reservations] = await Promise.all([
      this.db.product.findMany({ select: { id: true, quantity: true, currentCost: true } }),
      this.db.productionConsumption.groupBy({ by: ['inputId'], where: { item: { order: { status: 'PRINTING' } } }, _sum: { planned: true } }),
    ]);
    const reservedById = new Map(reservations.map(row => [row.inputId, row._sum.planned ?? new Prisma.Decimal(0)]));
    return products.map(product => {
      const reserved = reservedById.get(product.id) ?? new Prisma.Decimal(0);
      return {
        ...product, reserved, available: Prisma.Decimal.max(0, product.quantity.minus(reserved)), value: stockValue(product.quantity, product.currentCost),
      };
    });
  }

  async stockView() {
    const [products, kits, reservations] = await Promise.all([
      this.db.product.findMany({
        where: { active: true }, include: { ...productInclude, type: { select: { isManufactured: true } } }, orderBy: { sku: 'asc' },
      }),
      this.db.kit.findMany({
        where: { active: true }, include: { components: { include: { product: { include: productInclude } } } }, orderBy: { sku: 'asc' },
      }),
      this.db.productionConsumption.groupBy({ by: ['inputId'], where: { item: { order: { status: 'PRINTING' } } }, _sum: { planned: true } }),
    ]);
    const reserved = (id: string) => reservations.find(row => row.inputId === id)?._sum.planned ?? new Prisma.Decimal(0);
    // Values are computed here with exact decimals, so the panel only formats them.
    const valued = products.map(product => ({ ...product, reserved: reserved(product.id), value: stockValue(product.quantity, product.currentCost) }));
    return {
      products: valued,
      kits: kits.map(kit => ({
        ...kit, ...kitCosting(kit.components.map(item => ({ ...item, product: { ...item.product, reserved: reserved(item.productId) } }))),
      })),
      totalValue: sumValues(valued.map(product => product.value)),
    };
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

  async createProduct(tx: Prisma.TransactionClient, data: z.infer<typeof productFields> & { wastePercent?: Prisma.Decimal }) {
    await this.assertReferences(tx, data);
    const product = await tx.product.create({ data, include: productInclude });
    auditChange(null, productValues(await tx.product.findUniqueOrThrow({ where: { id: product.id }, select: productAudit })));
    return product;
  }

  async updateProduct(id: string, data: z.infer<typeof productUpdate>) {
    return serial(this.db, async tx => {
      await this.assertReferences(tx, data);
      const before = await tx.product.findUnique({
        where: { id }, select: { ...productAudit, typeId: true, unitId: true, unit: { select: { symbol: true, familyId: true } }, ...productUsage },
      });
      if (!before) throw new NotFoundException('Produto não encontrado.');
      if (data.typeId && data.typeId !== before.typeId) {
        const type = await tx.productType.findUnique({ where: { id: data.typeId } });
        if (!type) throw new NotFoundException('Tipo de produto não encontrado.');
        if (before._count.recipe && !type.isManufactured) throw new ConflictException('O produto tem ficha técnica, então o tipo precisa ser fabricado.');
        if (before._count.usedInRecipes && !type.isInput) throw new ConflictException('O produto está em fichas técnicas, então o tipo precisa ser usado como insumo.');
      }
      const newUnitId = data.unitId && data.unitId !== before.unitId ? data.unitId : undefined;
      if (newUnitId) {
        const unit = await tx.unit.findUnique({ where: { id: newUnitId } });
        if (!unit) throw new NotFoundException('Unidade não encontrada.');
        // Balances are stored in the family's base unit, so a new family would reinterpret them.
        const block = productBlock(before._count);
        if (unit.familyId !== before.unit.familyId && block) throw new ConflictException(block + ' Escolha uma unidade da mesma família.');
      }
      // The revision change invalidates inventory previews counted with the previous unit.
      await tx.product.update({ where: { id }, data: { ...data, ...(newUnitId ? { revision: { increment: 1 } } : {}) } });
      auditChange(productValues(before), productValues(await tx.product.findUniqueOrThrow({ where: { id }, select: productAudit })));
      return tx.product.findUniqueOrThrow({ where: { id }, select: catalogProduct });
    });
  }

  /** Deletes a product that never entered the history. Unconfirmed count previews do not hold it back. */
  deleteProduct(id: string) {
    return serial(this.db, async tx => {
      const product = await tx.product.findUnique({ where: { id }, select: { ...productAudit, ...productUsage } });
      if (!product) throw new NotFoundException('Produto não encontrado.');
      const block = productBlock(product._count);
      if (block) throw new ConflictException(block + ' Inative o produto em vez de excluir.');
      await tx.inventoryRow.deleteMany({ where: { productId: id } });
      await tx.product.delete({ where: { id } });
      auditChange(productValues(product), null);
      return { id };
    });
  }

  deleteKit(id: string) {
    return serial(this.db, async tx => {
      const kit = await tx.kit.findUnique({ where: { id }, include: { ...kitAudit, ...kitUsage } });
      if (!kit) throw new NotFoundException('Kit não encontrado.');
      const block = kitBlock(kit._count);
      if (block) throw new ConflictException(block + ' Inative o kit em vez de excluir.');
      await tx.kitComponent.deleteMany({ where: { kitId: id } });
      await tx.kit.delete({ where: { id } });
      auditChange(kitValues(kit), null);
      return { id };
    });
  }

  /** Only products without balance and outside active kits can be inactivated; reactivation is always allowed. */
  setProductActive(id: string, active: boolean) {
    return serial(this.db, async tx => {
      const product = await tx.product.findUnique({
        where: { id }, include: { kitComponents: { where: { kit: { active: true } }, include: { kit: { select: { sku: true } } } } },
      });
      if (!product) throw new NotFoundException('Produto não encontrado.');
      if (!active && !product.quantity.eq(0)) {
        throw new ConflictException('Zere o saldo de ' + product.sku + ' antes de inativar. Saldo atual: ' + product.quantity.toFixed() + '.');
      }
      if (!active && product.kitComponents.length) {
        throw new ConflictException('Inative antes os kits que usam ' + product.sku + ': ' + product.kitComponents.map(item => item.kit.sku).join(', ') + '.');
      }
      if (!active) {
        const recipes = await tx.productInput.findMany({ where: { inputId: id, product: { active: true } }, select: { product: { select: { sku: true } } } });
        if (recipes.length) {
          throw new ConflictException('Retire ' + product.sku + ' das fichas técnicas de: ' + recipes.map(item => item.product.sku).join(', ') + '.');
        }
        const open = { in: ['PLANNED', 'PRINTING'] as ProductionStatus[] };
        const orders = await tx.productionItem.count({ where: { productId: id, order: { status: open } } }) +
          await tx.productionConsumption.count({ where: { inputId: id, item: { order: { status: open } } } });
        if (orders) throw new ConflictException('Conclua ou cancele as ordens de produção em aberto que usam ' + product.sku + '.');
      }
      auditChange({ 'Situação': situation(product.active) }, { 'Situação': situation(active) });
      // The revision change invalidates inventory previews that counted this product.
      await tx.product.update({ where: { id }, data: { active, revision: { increment: 1 } } });
      return { id, active };
    });
  }

  setKitActive(id: string, active: boolean) {
    return serial(this.db, async tx => {
      const kit = await tx.kit.findUnique({ where: { id }, include: { components: { include: { product: { select: { sku: true, active: true } } } } } });
      if (!kit) throw new NotFoundException('Kit não encontrado.');
      const inactive = kit.components.filter(item => !item.product.active);
      if (active && inactive.length) {
        throw new ConflictException('Reative antes os produtos do kit: ' + inactive.map(item => item.product.sku).join(', ') + '.');
      }
      auditChange({ 'Situação': situation(kit.active) }, { 'Situação': situation(active) });
      await tx.kit.update({ where: { id }, data: { active } });
      return { id, active };
    });
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
        if (!product.active) throw new BadRequestException('Produto inativo no kit: ' + product.sku + '.');
        return { productId: product.id, quantity: inBase(unit, product.unit.familyId, item.quantity) };
      });
      const before = id ? await tx.kit.findUnique({ where: { id }, include: kitAudit }) : null;
      if (id && !before) throw new NotFoundException('Kit não encontrado.');
      const kit = id
        ? await tx.kit.update({
          where: { id }, data: { sku: data.sku, name: data.name, components: { deleteMany: {}, create: components } }, include: kitAudit,
        })
        : await tx.kit.create({ data: { sku: data.sku, name: data.name, components: { create: components } }, include: kitAudit });
      auditChange(before && kitValues(before), kitValues(kit));
      const { components: _components, ...saved } = kit;
      return saved;
    });
  }
}

@Controller('catalog')
export class CatalogController {
  constructor(@Inject(Database) private db: Database, @Inject(CatalogService) private catalog: CatalogService) {}

  @Require('catalog:view')
  @Get()
  overview() { return this.catalog.overview(); }

  @Require('stock:view')
  @Get('balances')
  balances() { return this.catalog.balances(); }

  @Require('registrations:view')
  @Get('registrations')
  registrations() { return this.catalog.registrations(); }

  @Require('registrations:operate')
  @Audit('Criar classificação')
  @Post('references')
  addReference(@Body() body: unknown) {
    const data = parse(referenceField, body);
    auditChange(null, { Tipo: data.kind, Nome: data.name });
    return this.db.reference.create({ data });
  }

  @Require('registrations:operate')
  @Audit('Alterar classificação')
  @Patch('references/:id')
  updateReference(@Param('id') id: string, @Body() body: unknown) {
    const referenceId = parse(idField, id);
    const data = parse(referenceField.pick({ name: true }), body);
    return serial(this.db, async tx => {
      const before = await tx.reference.findUnique({ where: { id: referenceId } });
      if (!before) throw new NotFoundException('Classificação não encontrada.');
      auditChange({ Tipo: before.kind, Nome: before.name }, { Tipo: before.kind, Nome: data.name });
      return tx.reference.update({ where: { id: referenceId }, data });
    });
  }

  @Require('registrations:operate')
  @Audit('Criar tipo de produto')
  @Post('product-types')
  addProductType(@Body() body: unknown) { return this.catalog.saveProductType(parse(productTypeFields, body)); }

  @Require('registrations:operate')
  @Audit('Alterar tipo de produto')
  @Patch('product-types/:id')
  updateProductType(@Param('id') id: string, @Body() body: unknown) {
    return this.catalog.saveProductType(parse(productTypeFields, body), parse(idField, id));
  }

  @Require('registrations:operate')
  @Audit('Excluir tipo de produto')
  @Delete('product-types/:id')
  removeProductType(@Param('id') id: string) { return this.catalog.deleteProductType(parse(idField, id)); }

  // Units define how every quantity is stored, so only administrators create families and units.
  // The movement history holds quantities converted with these factors, so a factor only changes while the family is unused.
  @Require('admin')
  @Audit('Criar família de medida')
  @Post('families')
  family(@Body() body: unknown) {
    const data = parse(familyField, body);
    auditChange(null, { Nome: data.name, 'Unidade base': data.baseSymbol });
    return this.db.unitFamily.create({
      data: { name: data.name, units: { create: { symbol: data.baseSymbol, factor: 1, isBase: true } } },
      include: { units: true },
    });
  }

  @Require('admin')
  @Audit('Criar unidade')
  @Post('units')
  async unit(@Body() body: unknown) {
    const data = parse(unitField, body);
    const unit = await this.db.unit.create({ data, include: { family: { select: { name: true } } } });
    auditChange(null, { 'Símbolo': unit.symbol, Fator: unit.factor, 'Família': unit.family.name });
    const { family: _family, ...saved } = unit;
    return saved;
  }

  @Require('admin')
  @Audit('Alterar família de medida')
  @Patch('families/:id')
  updateFamily(@Param('id') id: string, @Body() body: unknown) {
    return this.catalog.updateFamily(parse(idField, id), parse(familyField.pick({ name: true }), body).name);
  }

  @Require('admin')
  @Audit('Excluir família de medida')
  @Delete('families/:id')
  removeFamily(@Param('id') id: string) { return this.catalog.deleteFamily(parse(idField, id)); }

  @Require('admin')
  @Audit('Alterar unidade')
  @Patch('units/:id')
  updateUnit(@Param('id') id: string, @Body() body: unknown) {
    return this.catalog.updateUnit(parse(idField, id), parse(unitUpdate, body));
  }

  @Require('admin')
  @Audit('Excluir unidade')
  @Delete('units/:id')
  removeUnit(@Param('id') id: string) { return this.catalog.deleteUnit(parse(idField, id)); }

  @Require('catalog:operate')
  @Audit('Criar produto')
  @Post('products')
  addProduct(@Body() body: unknown) {
    const data = parse(productFields, body);
    return serial(this.db, tx => this.catalog.createProduct(tx, data));
  }

  @Require('catalog:operate')
  @Audit('Alterar produto')
  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() body: unknown) {
    const data = parse(productUpdate, body);
    return this.catalog.updateProduct(parse(idField, id), data);
  }

  @Require('catalog:operate')
  @Audit('Alterar situação do produto')
  @Post('products/:id/status')
  @HttpCode(200)
  productStatus(@Param('id') id: string, @Body() body: unknown) {
    return this.catalog.setProductActive(parse(idField, id), parse(statusFields, body).active);
  }

  @Require('catalog:operate')
  @Audit('Excluir produto')
  @Delete('products/:id')
  removeProduct(@Param('id') id: string) { return this.catalog.deleteProduct(parse(idField, id)); }

  @Require('catalog:operate')
  @Audit('Criar kit')
  @Post('kits')
  addKit(@Body() body: unknown) { return this.catalog.saveKit(parse(kitFields, body)); }

  @Require('catalog:operate')
  @Audit('Alterar kit')
  @Patch('kits/:id')
  updateKit(@Param('id') id: string, @Body() body: unknown) {
    return this.catalog.saveKit(parse(kitFields, body), parse(idField, id));
  }

  @Require('catalog:operate')
  @Audit('Alterar situação do kit')
  @Post('kits/:id/status')
  @HttpCode(200)
  kitStatus(@Param('id') id: string, @Body() body: unknown) {
    return this.catalog.setKitActive(parse(idField, id), parse(statusFields, body).active);
  }

  @Require('catalog:operate')
  @Audit('Excluir kit')
  @Delete('kits/:id')
  removeKit(@Param('id') id: string) { return this.catalog.deleteKit(parse(idField, id)); }
}
