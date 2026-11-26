import {
  BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable, NotFoundException, Param, Put, Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { canAccess } from '../access/security';
import { Audit, auditChange } from '../audit/recorder';
import { Database, idField, nonnegative, parse, positive, serial } from '../shared';
import { printerHourCost } from '../stock/cost';
import { inBase, productInclude } from './catalog';
import { colorKey, colorLabel, colorLabelSelect, colorMembers, colorOptions, ensureColorInput } from './colors';
import { currentEnergyRate, printMinutesField } from './pricing';

export const recipeFields = z.object({
  wastePercent: nonnegative.refine(value => value.lte(100) && value.decimalPlaces() <= 2, 'Informe a perda entre 0 e 100, com até 2 casas'),
  inputs: z.array(z.object({ inputId: idField, unitId: idField, quantity: positive })).max(100),
  /** Lines that accept any brand of a color. Clients that do not send them keep none. */
  colorInputs: z.array(z.object({ typeId: idField, groupId: idField.nullable(), colorId: idField, unitId: idField, quantity: positive })).max(50).default([]),
  printMinutes: printMinutesField.nullable().default(null),
  printerId: idField.nullable().default(null),
});
type Recipe = z.infer<typeof recipeFields>;
const recipeAudit = {
  wastePercent: true, printMinutes: true, printerId: true, printer: { select: { name: true } }, recipe: { select: { quantity: true, input: { select: { sku: true } } } },
  colorRecipe: { select: { quantity: true, colorInput: { select: colorLabelSelect } } },
} as const;
type AuditedRecipe = Prisma.ProductGetPayload<{ select: typeof recipeAudit }>;
const recipeValues = (product: AuditedRecipe) => ({
  'Perda (%)': product.wastePercent.toFixed(),
  Insumos: product.recipe.map(item => item.input.sku + ' × ' + item.quantity.toFixed()).sort(),
  'Insumos por cor': product.colorRecipe.map(item => colorLabel(item.colorInput) + ' × ' + item.quantity.toFixed()).sort(),
  'Tempo por peça (min)': product.printMinutes?.toFixed() ?? null, Impressora: product.printer?.name ?? null,
});

/** True when the product would end up consuming itself, directly or through another manufactured input. */
export function formsCycle(productId: string, inputIds: string[], edges: { productId: string; inputId: string }[]) {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.productId !== productId) next.set(edge.productId, [...next.get(edge.productId) ?? [], edge.inputId]);
  }
  const pending = [...inputIds];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === productId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...next.get(current) ?? []);
  }
  return false;
}

@Injectable()
export class RecipeService {
  constructor(@Inject(Database) private db: Database) {}

  /**
   * Costs only leave the API for people who can already see them in the stock.
   * Without an id, it lists what a product not saved yet can use: an empty recipe and active inputs and printers.
   */
  async view(id: string | null, canSeeCost: boolean) {
    const [product, candidates, printers, energyRate, offered] = await Promise.all([
      id ? this.db.product.findUnique({ where: { id }, select: {
        wastePercent: true, printMinutes: true, printerId: true, recipe: { select: { inputId: true, quantity: true } },
        colorRecipe: { select: { quantity: true, colorInput: { select: colorLabelSelect } } },
      } }) : { wastePercent: new Prisma.Decimal(0), printMinutes: null, printerId: null, recipe: [], colorRecipe: [] },
      this.db.product.findMany({
        where: id ? { id: { not: id }, OR: [{ active: true, type: { isInput: true } }, { usedInRecipes: { some: { productId: id } } }] } : { active: true, type: { isInput: true } },
        select: { id: true, sku: true, name: true, active: true, currentCost: true, typeId: true, groupId: true, colorId: true, ...productInclude }, orderBy: { sku: 'asc' },
      }),
      // An inactive printer leaves the list, but stays on the recipe that already uses it.
      this.db.printer.findMany({ where: id ? { OR: [{ active: true }, { products: { some: { id } } }] } : { active: true }, orderBy: { name: 'asc' } }),
      currentEnergyRate(this.db),
      colorOptions(this.db),
    ]);
    if (!product) throw new NotFoundException('Produto não encontrado.');
    // A color already in the recipe stays choosable even when no active brand fills it today.
    const saved = product.colorRecipe.map(({ quantity, colorInput: { id: _id, type, group, color, ...key } }) => ({ ...key, quantity, label: colorLabel({ type, group, color }) }));
    const colors = [...offered, ...saved.filter(row => !offered.some(option => colorKey(option) === colorKey(row)))
      .map(({ quantity: _quantity, ...row }) => ({ ...row, brands: 0 }))];
    return {
      wastePercent: product.wastePercent, inputs: product.recipe, canSeeCost, printMinutes: product.printMinutes, printerId: product.printerId,
      colorInputs: saved, colors,
      candidates: candidates.map(({ currentCost, ...item }) => canSeeCost ? { ...item, currentCost } : item),
      printers: printers.map(printer => ({
        id: printer.id, name: printer.name, active: printer.active,
        ...(canSeeCost ? { hourCost: printerHourCost(printer.powerWatts, energyRate, printer.hourlyCost) } : {}),
      })),
    };
  }

  save(id: string, data: Recipe) {
    return serial(this.db, async tx => {
      const { before, after, saved } = await applyRecipe(tx, id, data);
      auditChange(before, after);
      return saved;
    });
  }
}

/** Saves the recipe inside the caller's transaction and returns the readable values for the audit. */
export async function applyRecipe(tx: Prisma.TransactionClient, id: string, data: Recipe) {
  const inputIds = data.inputs.map(item => item.inputId);
  if (new Set(inputIds).size !== inputIds.length) throw new BadRequestException('Inclua cada insumo apenas uma vez.');
  if (inputIds.includes(id)) throw new BadRequestException('Um produto não pode consumir a si mesmo.');
  const product = await tx.product.findUnique({ where: { id }, select: { ...recipeAudit, type: { select: { isManufactured: true } } } });
  if (!product) throw new NotFoundException('Produto não encontrado.');
  if (!product.type.isManufactured) throw new ConflictException('Só produtos de tipo fabricado têm ficha técnica.');
  if (data.printerId && data.printerId !== product.printerId) {
    const printer = await tx.printer.findUnique({ where: { id: data.printerId } });
    if (!printer) throw new NotFoundException('Impressora não encontrada.');
    if (!printer.active) throw new ConflictException('A impressora ' + printer.name + ' está inativa.');
  }
  const [inputs, units, edges] = await Promise.all([
    tx.product.findMany({ where: { id: { in: inputIds } }, include: { unit: true, type: true } }),
    tx.unit.findMany({ where: { id: { in: data.inputs.map(item => item.unitId) } } }),
    tx.productInput.findMany({ select: { productId: true, inputId: true } }),
  ]);
  const rows = data.inputs.map(item => {
    const input = inputs.find(row => row.id === item.inputId);
    const unit = units.find(row => row.id === item.unitId);
    if (!input || !unit) throw new NotFoundException('Insumo ou unidade não encontrado.');
    if (!input.type.isInput) throw new BadRequestException(input.sku + ' não é de um tipo usado como insumo.');
    if (!input.active) throw new BadRequestException('Insumo inativo: ' + input.sku + '.');
    return { inputId: input.id, quantity: inBase(unit, input.unit.familyId, item.quantity) };
  });
  const colorRows = await colorLines(tx, data.colorInputs);
  // Today's brands of each color count as inputs, so a product can neither fill its own color nor reach itself through one.
  const memberIds = colorRows.length ? (await tx.product.findMany({ where: { OR: colorRows.map(row => colorMembers(row.color)) }, select: { id: true } })).map(row => row.id) : [];
  if (memberIds.includes(id)) throw new BadRequestException('Um produto não pode consumir a si mesmo.');
  if (formsCycle(id, [...inputIds, ...memberIds], edges)) throw new ConflictException('Esta ficha faria o produto consumir a si mesmo por meio de outro insumo.');
  const saved = await tx.product.update({
    where: { id },
    data: {
      wastePercent: data.wastePercent, printMinutes: data.printMinutes, printerId: data.printerId, recipe: { deleteMany: {}, create: rows },
      colorRecipe: { deleteMany: {}, create: colorRows.map(row => ({ colorInputId: row.color.id, quantity: row.quantity })) },
    },
    select: recipeAudit,
  });
  return { before: recipeValues(product), after: recipeValues(saved), saved: { id, wastePercent: saved.wastePercent, printMinutes: saved.printMinutes, printerId: saved.printerId } };
}

/**
 * Checks each color line and registers its color the first time. The type must be used as input, the color and the
 * group must be registered as such, and the quantity is kept in the base unit of the chosen unit's family.
 */
async function colorLines(tx: Prisma.TransactionClient, lines: Recipe['colorInputs']) {
  if (new Set(lines.map(colorKey)).size !== lines.length) throw new BadRequestException('Inclua cada cor apenas uma vez.');
  if (!lines.length) return [];
  const [types, references, units] = await Promise.all([
    tx.productType.findMany({ where: { id: { in: lines.map(line => line.typeId) } } }),
    tx.reference.findMany({ where: { id: { in: lines.flatMap(line => line.groupId ? [line.colorId, line.groupId] : [line.colorId]) } } }),
    tx.unit.findMany({ where: { id: { in: lines.map(line => line.unitId) } } }),
  ]);
  const rows = [];
  for (const line of lines) {
    const type = types.find(row => row.id === line.typeId);
    const color = references.find(row => row.id === line.colorId && row.kind === 'COR');
    const group = line.groupId ? references.find(row => row.id === line.groupId && row.kind === 'GRUPO') : null;
    const unit = units.find(row => row.id === line.unitId);
    if (!type || !color || group === undefined || !unit) throw new NotFoundException('Tipo, grupo, cor ou unidade não encontrado.');
    if (!type.isInput) throw new BadRequestException('O tipo ' + type.name + ' não é usado como insumo.');
    const saved = await ensureColorInput(tx, { typeId: type.id, groupId: group?.id ?? null, colorId: color.id, familyId: unit.familyId });
    rows.push({ color: saved, quantity: inBase(unit, saved.familyId, line.quantity) });
  }
  return rows;
}

@Controller('catalog')
export class RecipeController {
  constructor(@Inject(RecipeService) private recipes: RecipeService) {}

  @Require('catalog:operate')
  @Get('recipe-options')
  options(@Req() request: Authenticated) {
    return this.recipes.view(null, canAccess(request.identity.permissions, 'stock:view'));
  }

  @Require('catalog:operate')
  @Get('products/:id/recipe')
  view(@Req() request: Authenticated, @Param('id') id: string) {
    return this.recipes.view(parse(idField, id), canAccess(request.identity.permissions, 'stock:view'));
  }

  @Require('catalog:operate')
  @Audit('Alterar ficha técnica')
  @Put('products/:id/recipe')
  save(@Param('id') id: string, @Body() body: unknown) {
    return this.recipes.save(parse(idField, id), parse(recipeFields, body));
  }
}
