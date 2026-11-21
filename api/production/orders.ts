import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Post, Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { Audit, auditChange, auditContext } from '../audit/recorder';
import { productInclude } from '../catalog/catalog';
import { Database, idField, nonnegative, parse, positive, serial, storedDecimal } from '../shared';
import { printerHourCost, productionCosting, sumValues } from '../stock/cost';
import { StockService } from '../stock/stock';

const dateField = z.iso.datetime().transform(value => new Date(value));
const minutesField = z.number().int().positive().max(1000000);
const createFields = z.object({
  printerId: idField, plannedStart: dateField, estimatedMinutes: minutesField,
  notes: z.string().trim().max(500).optional(),
  items: z.array(z.object({ productId: idField, quantity: positive })).min(1).max(50),
});
const startFields = z.object({ startedAt: dateField.optional() });
const usedField = z.array(z.object({ inputId: idField, used: nonnegative })).max(200);
export const finishFields = z.object({
  finishedAt: dateField, printMinutes: minutesField.optional(), absorbLoss: z.boolean().default(false), shipOut: z.boolean().default(false),
  items: z.array(z.object({ productId: idField, lost: nonnegative })).max(50), inputs: usedField,
});
const cancelFields = z.object({ inputs: usedField.default([]) });
type Finish = z.infer<typeof finishFields>;

const orderInclude = {
  printer: true, user: { select: { name: true } },
  items: {
    orderBy: { productId: 'asc' },
    include: {
      product: { select: { sku: true, name: true, ...productInclude } },
      consumption: { orderBy: { inputId: 'asc' }, include: { input: { select: { sku: true, name: true, currentCost: true, ...productInclude } } } },
    },
  },
} as const;
type LoadedOrder = Prisma.ProductionOrderGetPayload<{ include: typeof orderInclude }>;
const statusNames = { PLANNED: 'Planejada', PRINTING: 'Em impressão', DONE: 'Concluída', CANCELED: 'Cancelada' } as const;
const symbolOf = (product: { unit: { symbol: string; family: { units: { symbol: string }[] } } }) => product.unit.family.units[0]?.symbol ?? product.unit.symbol;

/** One line per input, with the exact sums the panel shows. */
function orderInputs(order: LoadedOrder) {
  const inputs = new Map<string, { inputId: string; sku: string; name: string; symbol: string; planned: Prisma.Decimal; used: Prisma.Decimal | null }>();
  for (const row of order.items.flatMap(item => item.consumption)) {
    const line = inputs.get(row.inputId) ?? {
      inputId: row.inputId, sku: row.input.sku, name: row.input.name, symbol: symbolOf(row.input), planned: new Prisma.Decimal(0), used: null,
    };
    line.planned = line.planned.plus(row.planned);
    if (row.used !== null) line.used = (line.used ?? new Prisma.Decimal(0)).plus(row.used);
    inputs.set(row.inputId, line);
  }
  return [...inputs.values()];
}

function present(order: LoadedOrder) {
  const { items, printer, ...fields } = order;
  return {
    ...fields, printer: { id: printer.id, name: printer.name }, inputs: orderInputs(order),
    items: items.map(({ consumption: _consumption, product, ...item }) => ({ ...item, sku: product.sku, name: product.name, symbol: symbolOf(product) })),
  };
}

/** Everything a conclusion decides, shared by the preview and the real finish so both show the same numbers. */
function closing(order: LoadedOrder, energyRate: Prisma.Decimal, data: Finish) {
  if (order.status !== 'PRINTING' || !order.startedAt) throw new ConflictException('Só uma ordem em impressão pode ser concluída.');
  if (data.finishedAt <= order.startedAt) throw new BadRequestException('O término precisa ser depois do início.');
  if (data.items.some(row => !order.items.some(item => item.productId === row.productId))) throw new BadRequestException('Produto fora da ordem.');
  const inputs = orderInputs(order);
  if (data.inputs.some(row => !inputs.some(input => input.inputId === row.inputId))) throw new BadRequestException('Insumo fora da ordem.');
  const items = order.items.map(item => {
    const lost = storedDecimal(data.items.find(row => row.productId === item.productId)?.lost ?? new Prisma.Decimal(0));
    if (lost.gt(item.planned)) throw new BadRequestException('A perda de ' + item.product.sku + ' passa da quantidade da ordem.');
    return { productId: item.productId, planned: item.planned, lost };
  });
  const used = new Map(inputs.map(input => [
    input.inputId, storedDecimal(data.inputs.find(row => row.inputId === input.inputId)?.used ?? input.planned),
  ]));
  const printMinutes = data.printMinutes ?? Math.max(1, Math.round((data.finishedAt.getTime() - order.startedAt.getTime()) / 60000));
  const hourCost = printerHourCost(order.printer.powerWatts, energyRate, order.printer.hourlyCost);
  const machineCost = hourCost.times(printMinutes).div(60).toDecimalPlaces(12);
  const rows = order.items.flatMap(item => item.consumption.map(row => ({
    productId: row.productId, inputId: row.inputId, planned: row.planned, familyId: row.input.unit.familyId, unitCost: row.input.currentCost,
  })));
  return { printMinutes, machineCost, used, costing: productionCosting({ items, rows, used, machineCost, absorbLoss: data.absorbLoss }) };
}

@Injectable()
export class ProductionOrderService {
  constructor(@Inject(Database) private db: Database, @Inject(StockService) private stock: StockService) {}

  private async load(tx: Prisma.TransactionClient, id: string) {
    const order = await tx.productionOrder.findUnique({ where: { id }, include: orderInclude });
    if (!order) throw new NotFoundException('Ordem de produção não encontrada.');
    auditContext({ Ordem: order.number });
    return order;
  }

  private energyRate(tx: Prisma.TransactionClient) {
    return tx.productionSettings.findUniqueOrThrow({ where: { id: 'default' } }).then(settings => settings.energyRate);
  }

  async overview() {
    const [orders, printers, products] = await Promise.all([
      this.db.productionOrder.findMany({ include: orderInclude, orderBy: { number: 'desc' }, take: 200 }),
      this.db.printer.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.db.product.findMany({
        where: { active: true, type: { isManufactured: true }, recipe: { some: {} } },
        select: { id: true, sku: true, name: true, ...productInclude }, orderBy: { sku: 'asc' },
      }),
    ]);
    return {
      orders: orders.map(present), printers,
      products: products.map(product => ({ id: product.id, sku: product.sku, name: product.name, symbol: symbolOf(product) })),
    };
  }

  create(data: z.infer<typeof createFields>, userId: string) {
    const ids = data.items.map(item => item.productId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Inclua cada produto apenas uma vez.');
    return serial(this.db, async tx => {
      const printer = await tx.printer.findUnique({ where: { id: data.printerId } });
      if (!printer?.active) throw new ConflictException('Escolha uma impressora ativa.');
      const products = await tx.product.findMany({ where: { id: { in: ids } }, include: { type: true, recipe: { include: { input: true } } } });
      const items = data.items.map(item => {
        const product = products.find(row => row.id === item.productId);
        if (!product) throw new NotFoundException('Produto não encontrado.');
        if (!product.active || !product.type.isManufactured) throw new ConflictException(product.sku + ' não é um produto fabricado ativo.');
        if (!product.recipe.length) throw new ConflictException(product.sku + ' ainda não tem ficha técnica.');
        const inactive = product.recipe.find(row => !row.input.active);
        if (inactive) throw new ConflictException('Insumo inativo na ficha de ' + product.sku + ': ' + inactive.input.sku + '.');
        const factor = product.wastePercent.div(100).plus(1);
        return {
          productId: product.id, planned: storedDecimal(item.quantity),
          consumption: { create: product.recipe.map(row => ({
            inputId: row.inputId, planned: storedDecimal(row.quantity.times(item.quantity).times(factor).toDecimalPlaces(12)),
          })) },
        };
      });
      const expectedEnd = new Date(data.plannedStart.getTime() + data.estimatedMinutes * 60000);
      const order = await tx.productionOrder.create({
        data: {
          printerId: printer.id, userId, notes: data.notes || null, plannedStart: data.plannedStart,
          estimatedMinutes: data.estimatedMinutes, expectedEnd, items: { create: items },
        },
        include: orderInclude,
      });
      auditChange(null, {
        Ordem: order.number, Impressora: printer.name, 'Situação': statusNames.PLANNED,
        Produtos: order.items.map(item => item.product.sku + ' × ' + item.planned.toFixed()).sort(),
      });
      return present(order);
    });
  }

  /** Starting reserves the inputs, so two running prints never count on the same balance. */
  start(id: string, data: z.infer<typeof startFields>) {
    return serial(this.db, async tx => {
      const order = await this.load(tx, id);
      if (order.status !== 'PLANNED') throw new ConflictException('Só uma ordem planejada pode ser iniciada.');
      if (!order.printer.active) throw new ConflictException('A impressora desta ordem está inativa.');
      for (const input of orderInputs(order)) {
        const product = await tx.product.findUniqueOrThrow({ where: { id: input.inputId } });
        const free = product.quantity.minus(await this.stock.reservedBalance(tx, product.id));
        if (!product.active) throw new ConflictException('O insumo ' + product.sku + ' está inativo.');
        if (free.lt(input.planned)) {
          throw new ConflictException('Saldo insuficiente de ' + product.sku + ': faltam ' + input.planned.minus(free).toFixed() + ' ' + input.symbol + '.');
        }
      }
      const startedAt = data.startedAt ?? new Date();
      auditChange({ 'Situação': statusNames.PLANNED }, { 'Situação': statusNames.PRINTING });
      const updated = await tx.productionOrder.update({
        where: { id },
        data: { status: 'PRINTING', startedAt, expectedEnd: new Date(startedAt.getTime() + order.estimatedMinutes * 60000) },
        include: orderInclude,
      });
      return present(updated);
    });
  }

  async preview(id: string, data: Finish) {
    const order = await this.load(this.db, id);
    const result = closing(order, await this.energyRate(this.db), data);
    return {
      printMinutes: result.printMinutes, machineCost: result.machineCost, totalCost: result.costing.totalCost,
      lossCost: result.costing.lossCost, partialCost: result.costing.partialCost,
      items: result.costing.items.map(item => {
        const product = order.items.find(row => row.productId === item.productId)!.product;
        return { ...item, sku: product.sku, name: product.name, symbol: symbolOf(product) };
      }),
    };
  }

  private async consume(tx: Prisma.TransactionClient, order: LoadedOrder, used: Map<string, Prisma.Decimal>, userId: string) {
    for (const input of orderInputs(order)) {
      const amount = used.get(input.inputId);
      if (!amount?.gt(0)) continue;
      const product = await tx.product.findUniqueOrThrow({ where: { id: input.inputId } });
      await this.stock.record(tx, product, amount.neg(), 'PRODUCTION_OUT', userId, 'Ordem de produção #' + order.number, product.currentCost, undefined, order.id);
    }
  }

  finish(id: string, data: Finish, userId: string) {
    return serial(this.db, async tx => {
      const order = await this.load(tx, id);
      const energyRate = await this.energyRate(tx);
      const { printMinutes, machineCost, used, costing } = closing(order, energyRate, data);
      await this.consume(tx, order, used, userId);
      for (const row of costing.rows) {
        await tx.productionConsumption.update({
          where: { orderId_productId_inputId: { orderId: id, productId: row.productId, inputId: row.inputId } },
          data: { used: row.used, unitCost: row.unitCost },
        });
      }
      for (const item of costing.items) {
        await tx.productionItem.update({
          where: { orderId_productId: { orderId: id, productId: item.productId } },
          data: { good: item.good, lost: item.lost, unitCost: item.unitCost, totalCost: item.totalCost, lossCost: item.lossCost },
        });
        if (item.good.lte(0)) continue;
        const product = await tx.product.findUniqueOrThrow({ where: { id: item.productId } });
        await this.stock.record(tx, product, item.good, 'PRODUCTION_IN', userId, 'Ordem de produção #' + order.number, item.unitCost, undefined, id);
        if (!data.shipOut) continue;
        const stocked = await tx.product.findUniqueOrThrow({ where: { id: item.productId } });
        await this.stock.record(tx, stocked, item.good.neg(), 'OUT', userId, 'Encomenda · ordem de produção #' + order.number, stocked.currentCost, undefined, id);
      }
      auditChange({ 'Situação': statusNames.PRINTING }, {
        'Situação': statusNames.DONE, 'Custo total': costing.totalCost.toFixed(), 'Custo da perda': costing.lossCost.toFixed(),
        'Perda nas peças boas': data.absorbLoss ? 'Sim' : 'Não', 'Saída direta': data.shipOut ? 'Sim' : 'Não',
      });
      const updated = await tx.productionOrder.update({
        where: { id },
        data: {
          status: 'DONE', finishedAt: data.finishedAt, printMinutes, absorbLoss: data.absorbLoss, machineCost, energyRate,
          powerWatts: order.printer.powerWatts, hourlyCost: order.printer.hourlyCost, totalCost: costing.totalCost, lossCost: costing.lossCost,
        },
        include: orderInclude,
      });
      return present(updated);
    });
  }

  /** A canceled print only takes from stock what it really used; the rest of the reservation is released. */
  cancel(id: string, data: z.infer<typeof cancelFields>, userId: string) {
    return serial(this.db, async tx => {
      const order = await this.load(tx, id);
      if (order.status !== 'PLANNED' && order.status !== 'PRINTING') throw new ConflictException('Esta ordem já foi encerrada.');
      const inputs = orderInputs(order);
      if (data.inputs.some(row => !inputs.some(input => input.inputId === row.inputId))) throw new BadRequestException('Insumo fora da ordem.');
      if (order.status === 'PLANNED' && data.inputs.some(row => row.used.gt(0))) throw new BadRequestException('Uma ordem planejada ainda não consumiu insumos.');
      const used = new Map(inputs.map(input => [
        input.inputId, storedDecimal(data.inputs.find(row => row.inputId === input.inputId)?.used ?? new Prisma.Decimal(0)),
      ]));
      await this.consume(tx, order, used, userId);
      const costs = [];
      for (const item of order.items) {
        for (const row of item.consumption) {
          const total = inputs.find(input => input.inputId === row.inputId)!.planned;
          const amount = used.get(row.inputId)!.times(row.planned).div(total).toDecimalPlaces(12);
          costs.push(amount.times(row.input.currentCost ?? 0));
          await tx.productionConsumption.update({
            where: { orderId_productId_inputId: { orderId: id, productId: row.productId, inputId: row.inputId } },
            data: { used: amount, unitCost: row.input.currentCost },
          });
        }
      }
      const lossCost = sumValues(costs).toDecimalPlaces(12);
      auditChange({ 'Situação': statusNames[order.status] }, { 'Situação': statusNames.CANCELED, 'Custo da perda': lossCost.toFixed() });
      const updated = await tx.productionOrder.update({
        where: { id }, data: { status: 'CANCELED', finishedAt: new Date(), totalCost: lossCost, lossCost }, include: orderInclude,
      });
      return present(updated);
    });
  }
}

@Controller('production/orders')
export class ProductionOrderController {
  constructor(@Inject(ProductionOrderService) private orders: ProductionOrderService) {}

  @Require('production:view')
  @Get()
  overview() { return this.orders.overview(); }

  @Require('production:operate')
  @Audit('Criar ordem de produção')
  @Post()
  create(@Req() request: Authenticated, @Body() body: unknown) { return this.orders.create(parse(createFields, body), request.identity.id); }

  @Require('production:operate')
  @Audit('Iniciar ordem de produção')
  @Post(':id/start')
  @HttpCode(200)
  start(@Param('id') id: string, @Body() body: unknown) { return this.orders.start(parse(idField, id), parse(startFields, body)); }

  @Require('production:operate')
  @Audit(false)
  @Post(':id/preview')
  @HttpCode(200)
  preview(@Param('id') id: string, @Body() body: unknown) { return this.orders.preview(parse(idField, id), parse(finishFields, body)); }

  @Require('production:operate')
  @Audit('Concluir ordem de produção')
  @Post(':id/finish')
  @HttpCode(200)
  finish(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.orders.finish(parse(idField, id), parse(finishFields, body), request.identity.id);
  }

  @Require('production:operate')
  @Audit('Cancelar ordem de produção')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.orders.cancel(parse(idField, id), parse(cancelFields, body), request.identity.id);
  }
}
