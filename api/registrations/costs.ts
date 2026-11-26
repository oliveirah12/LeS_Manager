import { Body, ConflictException, Controller, Delete, Get, Inject, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { CostItem } from '@prisma/client';
import { z } from 'zod';
import { Require } from '../access/access';
import { Audit, auditChange } from '../audit/recorder';
import { Database, idField, nameField, parse, positive, serial } from '../shared';

const costModeLabels = { VALUE: 'Valor (R$)', PERCENT: 'Percentual (%)' } as const;
const costBaseLabels = { COST: 'Sobre o custo', SALE: 'Sobre a venda' } as const;
type CostTerms = Pick<CostItem, 'mode' | 'base' | 'value'>;
/** Readable terms of a cost for the audit, such as "6% sobre a venda" or "R$ 2.5". */
export const costSummary = (cost: CostTerms) => cost.mode === 'PERCENT'
  ? cost.value.toFixed() + '% ' + costBaseLabels[cost.base].toLowerCase() : 'R$ ' + cost.value.toFixed();

const costShape = z.object({
  name: nameField,
  mode: z.enum(['VALUE', 'PERCENT'], { error: 'Escolha o tipo: valor ou percentual' }),
  base: z.enum(['COST', 'SALE'], { error: 'Escolha a base do percentual: custo ou venda' }).default('COST'),
  value: positive,
  active: z.boolean().default(true),
});
type CostShape = z.infer<typeof costShape>;

function checkPercent(cost: CostShape, context: z.RefinementCtx) {
  if (cost.mode !== 'PERCENT') return;
  if (cost.value.gt(100)) context.addIssue({ code: 'custom', path: ['value'], message: 'O percentual precisa ficar entre 0 e 100' });
  // A sale percentage of 100 or more leaves no room for the price, so it can never be met.
  else if (cost.base === 'SALE' && cost.value.eq(100)) context.addIssue({ code: 'custom', path: ['value'], message: 'O percentual sobre a venda precisa ficar abaixo de 100' });
}
// A fixed value is added as it is, so its base carries no meaning.
const normalize = (cost: CostShape) => cost.mode === 'VALUE' ? { ...cost, base: 'COST' as const } : cost;

export const costItemFields = costShape.superRefine(checkPercent).transform(normalize);
// Saving an edit states the situation, so a partial request never reactivates an inactive cost.
export const costItemUpdateFields = costShape.extend({ active: z.boolean() }).superRefine(checkPercent).transform(normalize);
type CostItemData = z.infer<typeof costItemFields>;

const usage = { _count: { select: { purchaseCosts: true } } } as const;
const usedBlock = 'O custo já foi usado em compras. Inative-o para tirá-lo das listas.';
const values = (cost: Pick<CostItem, 'name' | 'mode' | 'base' | 'value' | 'active'>) => ({
  Nome: cost.name, Tipo: costModeLabels[cost.mode], 'Base do percentual': cost.mode === 'PERCENT' ? costBaseLabels[cost.base] : null,
  Valor: cost.value.toFixed(), Situação: cost.active ? 'Ativo' : 'Inativo',
});

@Injectable()
export class CostItemService {
  constructor(@Inject(Database) private db: Database) {}

  async list() {
    const rows = await this.db.costItem.findMany({ include: usage, orderBy: { name: 'asc' } });
    return rows.map(({ _count, ...cost }) => ({ ...cost, purchases: _count.purchaseCosts, deleteBlock: _count.purchaseCosts ? usedBlock : null }));
  }

  async create(data: CostItemData) {
    const cost = await this.db.costItem.create({ data });
    auditChange(null, values(cost));
    return cost;
  }

  update(id: string, data: CostItemData) {
    return serial(this.db, async tx => {
      const before = await tx.costItem.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Custo não encontrado.');
      const cost = await tx.costItem.update({ where: { id }, data });
      auditChange(values(before), values(cost));
      return cost;
    });
  }

  remove(id: string) {
    return serial(this.db, async tx => {
      const cost = await tx.costItem.findUnique({ where: { id }, include: usage });
      if (!cost) throw new NotFoundException('Custo não encontrado.');
      if (cost._count.purchaseCosts) throw new ConflictException(usedBlock);
      await tx.costItem.delete({ where: { id } });
      auditChange(values(cost), null);
      return { id };
    });
  }
}

@Controller('costs')
export class CostItemController {
  constructor(@Inject(CostItemService) private costs: CostItemService) {}

  @Require('registrations:view')
  @Get()
  list() { return this.costs.list(); }

  @Require('registrations:operate')
  @Audit('Cadastrar custo')
  @Post()
  create(@Body() body: unknown) { return this.costs.create(parse(costItemFields, body)); }

  @Require('registrations:operate')
  @Audit('Alterar custo')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) { return this.costs.update(parse(idField, id), parse(costItemUpdateFields, body)); }

  @Require('registrations:operate')
  @Audit('Excluir custo')
  @Delete(':id')
  remove(@Param('id') id: string) { return this.costs.remove(parse(idField, id)); }
}
