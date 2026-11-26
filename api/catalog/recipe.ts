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
import { currentEnergyRate } from './pricing';

export const recipeFields = z.object({
  wastePercent: nonnegative.refine(value => value.lte(100) && value.decimalPlaces() <= 2, 'Informe a perda entre 0 e 100, com até 2 casas'),
  inputs: z.array(z.object({ inputId: idField, unitId: idField, quantity: positive })).max(100),
  printMinutes: positive.refine(value => value.lt(1000000) && value.decimalPlaces() <= 2, 'Informe o tempo por peça abaixo de 1.000.000 minutos, com até 2 casas').nullable().default(null),
  printerId: idField.nullable().default(null),
});
type Recipe = z.infer<typeof recipeFields>;
const recipeAudit = {
  wastePercent: true, printMinutes: true, printerId: true, printer: { select: { name: true } }, recipe: { select: { quantity: true, input: { select: { sku: true } } } },
} as const;
type AuditedRecipe = Prisma.ProductGetPayload<{ select: typeof recipeAudit }>;
const recipeValues = (product: AuditedRecipe) => ({
  'Perda (%)': product.wastePercent.toFixed(),
  Insumos: product.recipe.map(item => item.input.sku + ' × ' + item.quantity.toFixed()).sort(),
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

  /** Costs only leave the API for people who can already see them in the stock. */
  async view(id: string, canSeeCost: boolean) {
    const [product, candidates, printers, energyRate] = await Promise.all([
      this.db.product.findUnique({ where: { id }, select: { wastePercent: true, printMinutes: true, printerId: true, recipe: { select: { inputId: true, quantity: true } } } }),
      this.db.product.findMany({
        where: { id: { not: id }, OR: [{ active: true, type: { isInput: true } }, { usedInRecipes: { some: { productId: id } } }] },
        select: { id: true, sku: true, name: true, active: true, currentCost: true, ...productInclude }, orderBy: { sku: 'asc' },
      }),
      // An inactive printer leaves the list, but stays on the recipe that already uses it.
      this.db.printer.findMany({ where: { OR: [{ active: true }, { products: { some: { id } } }] }, orderBy: { name: 'asc' } }),
      currentEnergyRate(this.db),
    ]);
    if (!product) throw new NotFoundException('Produto não encontrado.');
    return {
      wastePercent: product.wastePercent, inputs: product.recipe, canSeeCost, printMinutes: product.printMinutes, printerId: product.printerId,
      candidates: candidates.map(({ currentCost, ...item }) => canSeeCost ? { ...item, currentCost } : item),
      printers: printers.map(printer => ({
        id: printer.id, name: printer.name, active: printer.active,
        ...(canSeeCost ? { hourCost: printerHourCost(printer.powerWatts, energyRate, printer.hourlyCost) } : {}),
      })),
    };
  }

  save(id: string, data: Recipe) {
    const inputIds = data.inputs.map(item => item.inputId);
    if (new Set(inputIds).size !== inputIds.length) throw new BadRequestException('Inclua cada insumo apenas uma vez.');
    if (inputIds.includes(id)) throw new BadRequestException('Um produto não pode consumir a si mesmo.');
    return serial(this.db, async tx => {
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
      if (formsCycle(id, inputIds, edges)) throw new ConflictException('Esta ficha faria o produto consumir a si mesmo por meio de outro insumo.');
      const saved = await tx.product.update({
        where: { id }, data: { wastePercent: data.wastePercent, printMinutes: data.printMinutes, printerId: data.printerId, recipe: { deleteMany: {}, create: rows } },
        select: recipeAudit,
      });
      auditChange(recipeValues(product), recipeValues(saved));
      return { id, wastePercent: saved.wastePercent, printMinutes: saved.printMinutes, printerId: saved.printerId };
    });
  }
}

@Controller('catalog/products/:id/recipe')
export class RecipeController {
  constructor(@Inject(RecipeService) private recipes: RecipeService) {}

  @Require('catalog:operate')
  @Get()
  view(@Req() request: Authenticated, @Param('id') id: string) {
    return this.recipes.view(parse(idField, id), canAccess(request.identity.permissions, 'stock:view'));
  }

  @Require('catalog:operate')
  @Audit('Alterar ficha técnica')
  @Put()
  save(@Param('id') id: string, @Body() body: unknown) {
    return this.recipes.save(parse(idField, id), parse(recipeFields, body));
  }
}
