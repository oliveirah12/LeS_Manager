import {
  Body, ConflictException, Controller, Delete, Get, Header, HttpCode, Inject, Injectable, NotFoundException, Param, Patch, Post, Query, Req, StreamableFile,
} from '@nestjs/common';
import { Prisma, QuoteStatus } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { canAccess } from '../access/security';
import { Audit, auditChange, auditContext } from '../audit/recorder';
import { marginField, productInclude } from '../catalog/catalog';
import { currentEnergyRate, pricingSelect } from '../catalog/pricing';
import { FileService } from '../files/files';
import { imageType } from '../files/rules';
import { InputUse, suggestedExpense } from '../production/expenses';
import { matchingProductIds, orderSearch } from '../production/order-search';
import { manualExpenses, minutesField, ProductionOrderService, recipeConsumption, requireManufactured, symbolOf } from '../production/orders';
import { orderSale, saleFields, saleResult } from '../production/sale';
import { CompanyService, optionalText } from '../registrations/company';
import { Database, dayRange, idField, nameField, parse, positive, serial, sortField, storedDecimal } from '../shared';
import { pricingBreakdown, printerHourCost, productionBudget } from '../stock/cost';
import { addDays, quoteActions, QuoteAction, quoteBlock, quoteStatusNames } from './rules';

const detailField = z.object({
  label: z.string().trim().min(1, 'Informe o nome do detalhe').max(60, 'Use até 60 caracteres no nome do detalhe'),
  value: z.string().trim().min(1, 'Informe o valor do detalhe').max(300, 'Use até 300 caracteres no detalhe'),
});
const wholeField = (max: number, message: string) => z.number().int(message).min(1, message).max(max, message).nullable().default(null);
export const quoteFields = z.object({
  customerName: nameField,
  customerContact: optionalText(160),
  title: z.string().trim().min(1, 'Informe o título do orçamento').max(160),
  description: optionalText(2000),
  details: z.array(detailField).max(20).default([]),
  printPlates: wholeField(1000, 'Informe as placas em números inteiros, de 1 a 1.000'),
  estimatedMinutes: minutesField,
  deliveryDays: wholeField(365, 'Informe o prazo em dias inteiros, de 1 a 365'),
  /** Left out on creation, the validity follows the company settings. */
  validUntil: z.iso.date().optional(),
  printerId: idField,
  notes: optionalText(500),
  ...saleFields,
  items: z.array(z.object({ productId: idField, quantity: positive, salePrice: positive, marginPercent: marginField.nullable().optional() })).min(1).max(50),
  manualExpenses: manualExpenses.default([]),
});
type QuoteData = z.infer<typeof quoteFields>;
const approveFields = z.object({ plannedStart: z.iso.datetime().transform(value => new Date(value)) });

const quotePageSize = 50;
const filterField = <T extends z.ZodType>(field: T) => z.preprocess(value => value === '' ? undefined : value, field.optional());
const listFields = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  sort: sortField(['number', 'customer', 'status', 'validUntil'] as const).optional(),
  status: filterField(z.enum(QuoteStatus)),
  from: filterField(z.iso.date()), to: filterField(z.iso.date()), search: filterField(z.string().trim().max(120)),
}).refine(({ from, to }) => !from || !to || from <= to, 'O início do período não pode ser depois do fim');
type QuoteList = z.infer<typeof listFields>;

/** What prices a product of the quote: its recipe with the input costs, the linked costs and the image. */
const quotedProduct = {
  select: {
    id: true, sku: true, name: true, active: true, imageFileId: true, salePrice: true, marginPercent: true, wastePercent: true, printMinutes: true,
    type: { select: { isManufactured: true } }, unit: productInclude.unit, costs: pricingSelect.costs,
    recipe: { select: { inputId: true, quantity: true, input: { select: { sku: true, currentCost: true, lastPurchaseExpense: true, unit: { select: { familyId: true } } } } } },
  },
} as const;
const quoteInclude = {
  printer: true, paymentMethod: true, user: { select: { name: true } }, productionOrder: { select: { id: true, number: true } },
  expenses: { orderBy: { title: 'asc' } }, items: { orderBy: { productId: 'asc' }, include: { product: quotedProduct } },
} as const;
type LoadedQuote = Prisma.QuoteGetPayload<{ include: typeof quoteInclude }>;
type Detail = z.infer<typeof detailField>;

const day = (value: Date) => value.toISOString().slice(0, 10);
const brazilToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const quoteFee = (quote: LoadedQuote) => quote.feePercent ?? quote.paymentMethod?.feePercent ?? new Prisma.Decimal(0);

/**
 * Live cost of a quote, as the order it would become: recipes with waste at the current average, the printer's hour for the
 * estimated time, the purchase expenses of the inputs and the manual ones. Each product then gets its linked costs and margin.
 */
function quoteBudget(quote: LoadedQuote, energyRate: Prisma.Decimal) {
  const rows = quote.items.flatMap(item => item.product.recipe.map(row => ({
    productId: item.productId, inputId: row.inputId, familyId: row.input.unit.familyId, unitCost: row.input.currentCost, sku: row.input.sku, unitExpense: row.input.lastPurchaseExpense,
    planned: row.quantity.times(item.quantity).times(item.product.wastePercent.div(100).plus(1)).toDecimalPlaces(12),
  })));
  const uses = new Map<string, InputUse>();
  for (const row of rows) uses.set(row.inputId, { unitExpense: row.unitExpense, quantity: (uses.get(row.inputId)?.quantity ?? new Prisma.Decimal(0)).plus(row.planned) });
  const budget = productionBudget({
    items: quote.items.map(item => ({ productId: item.productId, planned: item.quantity })), rows, minutes: quote.estimatedMinutes,
    hourCost: printerHourCost(quote.printer.powerWatts, energyRate, quote.printer.hourlyCost),
    expenses: [
      ...[...uses].map(([inputId, use]) => ({ inputId, value: suggestedExpense(use) })),
      ...quote.expenses.map(row => ({ inputId: null, value: row.value })),
    ],
  });
  return {
    ...budget, missingCost: [...new Set(rows.filter(row => row.unitCost === null).map(row => row.sku))].sort(),
    items: budget.items.map(row => {
      const item = quote.items.find(line => line.productId === row.productId)!;
      const costs = item.product.costs.map(link => link.costItem).filter(cost => cost.active);
      const pricing = pricingBreakdown(row.unitCost, costs, item.marginPercent, item.salePrice);
      return {
        ...row, pricedCost: pricing.totalCost, suggestedPrice: pricing.suggestedPrice, realMargin: pricing.realMargin, belowTargetMargin: pricing.belowTargetMargin,
      };
    }),
  };
}

/** Fields are listed one by one, so a cost never leaves the API by accident. Margin and budget need stock:view. */
function presentQuote(quote: LoadedQuote, seeCosts: boolean, energyRate: Prisma.Decimal) {
  const sale = orderSale(quote.items.map(item => ({ quantity: item.quantity, salePrice: item.salePrice })), quote.discountPercent, quoteFee(quote));
  const budget = seeCosts ? quoteBudget(quote, energyRate) : null;
  return {
    id: quote.id, number: quote.number, status: quote.status, actions: quoteActions(quote.status),
    customerName: quote.customerName, customerContact: quote.customerContact, title: quote.title, description: quote.description,
    details: quote.details as Detail[], printPlates: quote.printPlates, estimatedMinutes: quote.estimatedMinutes, deliveryDays: quote.deliveryDays,
    validUntil: day(quote.validUntil), expired: day(quote.validUntil) < brazilToday(), notes: quote.notes,
    printer: { id: quote.printer.id, name: quote.printer.name }, user: quote.user,
    createdAt: quote.createdAt, sentAt: quote.sentAt, decidedAt: quote.decidedAt, productionOrder: quote.productionOrder,
    discountPercent: quote.discountPercent, paymentMethodId: quote.paymentMethodId, paymentName: quote.paymentMethod?.name ?? null,
    feePercent: quoteFee(quote), customFee: quote.feePercent !== null,
    items: quote.items.map(item => ({
      productId: item.productId, sku: item.product.sku, name: item.product.name, symbol: symbolOf(item.product), imageFileId: item.product.imageFileId,
      quantity: item.quantity, salePrice: item.salePrice, total: item.quantity.times(item.salePrice).toDecimalPlaces(12), ...(seeCosts ? { marginPercent: item.marginPercent } : {}),
    })),
    expenses: quote.expenses.map(row => ({ title: row.title, value: row.value })),
    sale: sale && { gross: sale.gross, discount: sale.discount, total: sale.total, fee: sale.fee, net: sale.net, ...(budget ? saleResult(sale, budget.totalCost) : {}) },
    budget,
  };
}

/** Readable picture of a quote, so the audit shows what each change did. */
const quoteValues = (quote: LoadedQuote) => ({
  'Orçamento': quote.number, 'Situação': quoteStatusNames[quote.status], Cliente: quote.customerName, Contato: quote.customerContact,
  'Título': quote.title, 'Descrição': quote.description, Detalhes: (quote.details as Detail[]).map(row => row.label + ': ' + row.value),
  Placas: quote.printPlates, 'Tempo (min)': quote.estimatedMinutes, 'Prazo (dias)': quote.deliveryDays, Validade: day(quote.validUntil),
  Impressora: quote.printer.name, 'Observação': quote.notes,
  Produtos: quote.items.map(item => item.product.sku + ' × ' + item.quantity.toFixed() + ' · preço ' + item.salePrice.toFixed()).sort(),
  Despesas: quote.expenses.map(row => row.title + ': ' + row.value.toFixed()).sort(),
  'Desconto (%)': quote.discountPercent.toFixed(), 'Forma de pagamento': quote.paymentMethod?.name ?? null, 'Taxa (%)': quote.feePercent?.toFixed() ?? null,
});

function quoteWhere({ status, from, to }: QuoteList, found: { text: string; number: number | null; productIds: string[] } | null): Prisma.QuoteWhereInput {
  const created = dayRange(from, to);
  return {
    ...(status ? { status } : {}), ...(created ? { createdAt: created } : {}),
    ...(found ? { OR: [
      { customerName: { contains: found.text, mode: 'insensitive' } }, { title: { contains: found.text, mode: 'insensitive' } },
      { items: { some: { productId: { in: found.productIds } } } },
      ...(found.number === null ? [] : [{ number: found.number }]),
    ] } : {}),
  };
}

const quoteOrder = (sort: QuoteList['sort']): Prisma.QuoteOrderByWithRelationInput[] => {
  if (!sort) return [{ number: 'desc' }];
  const key = { number: 'number', customer: 'customerName', status: 'status', validUntil: 'validUntil' }[sort.key];
  return [{ [key]: sort.direction }, { number: 'desc' }];
};

@Injectable()
export class QuoteService {
  constructor(
    @Inject(Database) private db: Database, @Inject(ProductionOrderService) private orders: ProductionOrderService,
    @Inject(CompanyService) private company: CompanyService, @Inject(FileService) private files: FileService,
  ) {}

  private async load(tx: Prisma.TransactionClient, id: string, action?: QuoteAction) {
    const quote = await tx.quote.findUnique({ where: { id }, include: quoteInclude });
    if (!quote) throw new NotFoundException('Orçamento não encontrado.');
    auditContext({ 'Orçamento': quote.number });
    const block = action && quoteBlock(quote.status, action);
    if (block) throw new ConflictException(block);
    return quote;
  }

  async overview(filters: QuoteList, seeCosts: boolean) {
    const { page, sort } = filters;
    const term = filters.search ? orderSearch(filters.search) : null;
    const where = quoteWhere(filters, term && { text: filters.search!, number: term.number, productIds: await matchingProductIds(this.db, term.pattern) });
    const [energyRate, quotes, total, printers, paymentMethods, products, company] = await Promise.all([
      currentEnergyRate(this.db),
      this.db.quote.findMany({ where, include: quoteInclude, orderBy: quoteOrder(sort), skip: (page - 1) * quotePageSize, take: quotePageSize }),
      this.db.quote.count({ where }),
      this.db.printer.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.db.paymentMethod.findMany({ where: { active: true }, select: { id: true, name: true, feePercent: true }, orderBy: { name: 'asc' } }),
      // Only what an approval can turn into an order: active manufactured products with a recipe.
      this.db.product.findMany({
        where: { active: true, type: { isManufactured: true }, recipe: { some: {} } },
        select: { id: true, sku: true, name: true, salePrice: true, marginPercent: true, printMinutes: true, ...productInclude }, orderBy: { sku: 'asc' },
      }),
      this.db.companySettings.findUniqueOrThrow({ where: { id: 'default' }, select: { quoteValidityDays: true } }),
    ]);
    return {
      quotes: quotes.map(quote => presentQuote(quote, seeCosts, energyRate)),
      page, pageSize: quotePageSize, total, printers, paymentMethods, quoteValidityDays: company.quoteValidityDays,
      products: products.map(product => ({
        id: product.id, sku: product.sku, name: product.name, symbol: symbolOf(product), printMinutes: product.printMinutes, salePrice: product.salePrice,
        ...(seeCosts ? { marginPercent: product.marginPercent } : {}),
      })),
    };
  }

  /** Every product must be one an approval can produce, and inactive printers or methods only stay on a quote that already had them. */
  private async lines(tx: Prisma.TransactionClient, data: QuoteData, seeCosts: boolean, current?: LoadedQuote) {
    const ids = data.items.map(item => item.productId);
    if (new Set(ids).size !== ids.length) throw new ConflictException('Inclua cada produto apenas uma vez.');
    const printer = await tx.printer.findUnique({ where: { id: data.printerId } });
    if (!printer || (!printer.active && printer.id !== current?.printerId)) throw new ConflictException('Escolha uma impressora ativa.');
    const paymentMethodId = data.paymentMethodId === undefined ? current?.paymentMethodId ?? null : data.paymentMethodId;
    if (paymentMethodId) {
      const method = await tx.paymentMethod.findUnique({ where: { id: paymentMethodId } });
      if (!method) throw new NotFoundException('Forma de pagamento não encontrada.');
      if (!method.active && paymentMethodId !== current?.paymentMethodId) throw new ConflictException('Escolha uma forma de pagamento ativa.');
    }
    const products = await tx.product.findMany({ where: { id: { in: ids } }, include: { type: true, recipe: { include: { input: true } } } });
    const items = data.items.map(item => {
      const product = requireManufactured(products.find(row => row.id === item.productId));
      if (!current?.items.some(row => row.productId === product.id)) recipeConsumption(product, item.quantity);
      const before = current?.items.find(row => row.productId === product.id);
      return {
        productId: product.id, quantity: storedDecimal(item.quantity), salePrice: storedDecimal(item.salePrice),
        // Without stock:view the margin cannot be seen, so it keeps what the quote or the product had.
        marginPercent: seeCosts && item.marginPercent !== undefined ? item.marginPercent : before ? before.marginPercent : product.marginPercent,
      };
    });
    return {
      printerId: printer.id, paymentMethodId,
      customerName: data.customerName, customerContact: data.customerContact, title: data.title, description: data.description,
      details: data.details, printPlates: data.printPlates, estimatedMinutes: data.estimatedMinutes, deliveryDays: data.deliveryDays, notes: data.notes,
      discountPercent: data.discountPercent ?? current?.discountPercent ?? 0,
      feePercent: data.feePercent === undefined ? current?.feePercent ?? null : data.feePercent,
      items: { create: items },
      expenses: { create: data.manualExpenses.map(row => ({ title: row.title, value: storedDecimal(row.value) })) },
    };
  }

  create(data: QuoteData, userId: string, seeCosts: boolean) {
    return serial(this.db, async tx => {
      const values = await this.lines(tx, data, seeCosts);
      const { quoteValidityDays } = await tx.companySettings.findUniqueOrThrow({ where: { id: 'default' } });
      const validUntil = new Date(data.validUntil ?? addDays(brazilToday(), quoteValidityDays));
      const quote = await tx.quote.create({ data: { ...values, validUntil, userId }, include: quoteInclude });
      auditChange(null, quoteValues(quote));
      return presentQuote(quote, seeCosts, await currentEnergyRate(tx));
    });
  }

  /** Items and expenses are rebuilt from the form, as nothing has moved yet. */
  update(id: string, data: QuoteData, seeCosts: boolean) {
    return serial(this.db, async tx => {
      const before = await this.load(tx, id, 'edit');
      const values = await this.lines(tx, data, seeCosts, before);
      await tx.quoteItem.deleteMany({ where: { quoteId: id } });
      await tx.quoteExpense.deleteMany({ where: { quoteId: id } });
      const quote = await tx.quote.update({
        where: { id }, data: { ...values, ...(data.validUntil ? { validUntil: new Date(data.validUntil) } : {}) }, include: quoteInclude,
      });
      auditChange(quoteValues(before), quoteValues(quote));
      return presentQuote(quote, seeCosts, await currentEnergyRate(tx));
    });
  }

  private decide(id: string, action: 'send' | 'reject', seeCosts: boolean) {
    return serial(this.db, async tx => {
      const before = await this.load(tx, id, action);
      const now = new Date();
      const quote = await tx.quote.update({
        where: { id }, data: action === 'send' ? { status: 'SENT', sentAt: now } : { status: 'REJECTED', decidedAt: now }, include: quoteInclude,
      });
      auditChange({ 'Situação': quoteStatusNames[before.status] }, { 'Situação': quoteStatusNames[quote.status] });
      return presentQuote(quote, seeCosts, await currentEnergyRate(tx));
    });
  }

  send(id: string, seeCosts: boolean) { return this.decide(id, 'send', seeCosts); }
  reject(id: string, seeCosts: boolean) { return this.decide(id, 'reject', seeCosts); }

  /**
   * The planned order takes the quote's printer, time, items, prices, margins, discount, payment and expenses.
   * Both are saved in one transaction, so a busy printer or an inactive product leaves the quote as it was.
   */
  approve(id: string, plannedStart: Date, userId: string, seeCosts: boolean) {
    return serial(this.db, async tx => {
      const before = await this.load(tx, id, 'approve');
      const order = await this.orders.createIn(tx, {
        printerId: before.printerId, plannedStart, estimatedMinutes: before.estimatedMinutes,
        notes: ('Orçamento #' + before.number + ' · ' + before.customerName).slice(0, 500),
        discountPercent: before.discountPercent, paymentMethodId: before.paymentMethodId, feePercent: before.feePercent,
        items: before.items.map(item => ({ productId: item.productId, quantity: item.quantity, salePrice: item.salePrice, marginPercent: item.marginPercent })),
        manualExpenses: before.expenses.map(row => ({ title: row.title, value: row.value })),
      }, userId, true);
      const quote = await tx.quote.update({
        where: { id }, data: { status: 'APPROVED', decidedAt: new Date(), productionOrderId: order.id }, include: quoteInclude,
      });
      // The order describes itself in the same event; the quote's own keys come last so they win.
      auditChange({ 'Situação': quoteStatusNames[before.status] }, { 'Situação': quoteStatusNames.APPROVED, 'Ordem de produção': order.number });
      return presentQuote(quote, seeCosts, await currentEnergyRate(tx));
    });
  }

  remove(id: string) {
    return serial(this.db, async tx => {
      const quote = await this.load(tx, id, 'delete');
      await tx.quote.delete({ where: { id } });
      auditChange(quoteValues(quote), null);
      return { id };
    });
  }

  /** The letterhead for the customer's PDF. Reading it needs quotes:view, not access to the company settings. */
  letterhead() { return this.company.get(); }
  logo() { return this.company.openLogo(); }

  /** Only the image of a product that is in some quote, so this route never becomes a way into the whole catalog. */
  async productImage(productId: string) {
    if (!await this.db.quoteItem.count({ where: { productId } })) throw new NotFoundException('Imagem não encontrada.');
    return this.files.openProductImage(productId);
  }
}

const seesCosts = (request: Authenticated) => canAccess(request.identity.permissions, 'stock:view');
// The type comes from the checked extension, never from what the browser declared.
const image = (file: Awaited<ReturnType<FileService['open']>>) => new StreamableFile(file.content, { type: imageType(file.name), disposition: 'inline', length: file.size });

@Controller('quotes')
export class QuoteController {
  constructor(@Inject(QuoteService) private quotes: QuoteService) {}

  @Require('quotes:view')
  @Get()
  overview(@Req() request: Authenticated, @Query() query: unknown) { return this.quotes.overview(parse(listFields, query), seesCosts(request)); }

  @Require('quotes:view')
  @Get('letterhead')
  letterhead() { return this.quotes.letterhead(); }

  @Require('quotes:view')
  @Get('letterhead/logo')
  @Header('X-Content-Type-Options', 'nosniff')
  async logo() { return image(await this.quotes.logo()); }

  @Require('quotes:view')
  @Get('products/:id/image')
  @Header('X-Content-Type-Options', 'nosniff')
  async productImage(@Param('id') id: string) { return image(await this.quotes.productImage(parse(idField, id))); }

  @Require('quotes:operate')
  @Audit('Criar orçamento')
  @Post()
  create(@Req() request: Authenticated, @Body() body: unknown) { return this.quotes.create(parse(quoteFields, body), request.identity.id, seesCosts(request)); }

  @Require('quotes:operate')
  @Audit('Editar orçamento')
  @Patch(':id')
  update(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.quotes.update(parse(idField, id), parse(quoteFields, body), seesCosts(request));
  }

  @Require('quotes:operate')
  @Audit('Enviar orçamento')
  @Post(':id/send')
  @HttpCode(200)
  send(@Req() request: Authenticated, @Param('id') id: string) { return this.quotes.send(parse(idField, id), seesCosts(request)); }

  @Require('quotes:operate')
  @Audit('Recusar orçamento')
  @Post(':id/reject')
  @HttpCode(200)
  reject(@Req() request: Authenticated, @Param('id') id: string) { return this.quotes.reject(parse(idField, id), seesCosts(request)); }

  /** Approving books the printer, so it also needs production:operate. */
  @Require('quotes:operate', 'production:operate')
  @Audit('Aprovar orçamento')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@Req() request: Authenticated, @Param('id') id: string, @Body() body: unknown) {
    return this.quotes.approve(parse(idField, id), parse(approveFields, body).plannedStart, request.identity.id, seesCosts(request));
  }

  @Require('quotes:operate')
  @Audit('Excluir orçamento')
  @Delete(':id')
  remove(@Param('id') id: string) { return this.quotes.remove(parse(idField, id)); }
}
