import { brl, decimal, displayDate, duration, quantity } from './format';
import type { Report, ReportBrand, ReportImage } from './pdf';
import type { Quote } from './quote-types';

/**
 * Only what the customer may read. The function picks each field by name and never reads the budget, the margins,
 * the expenses or the result, so a profile that sees costs still sends a clean document.
 */
export type CustomerQuote = Pick<Quote,
  'number' | 'customerName' | 'customerContact' | 'title' | 'description' | 'details' | 'printPlates' | 'estimatedMinutes' | 'deliveryDays' | 'validUntil' | 'discountPercent'
> & {
  items: Pick<Quote['items'][number], 'productId' | 'name' | 'symbol' | 'quantity' | 'salePrice' | 'total'>[];
  sale: Pick<NonNullable<Quote['sale']>, 'gross' | 'discount' | 'total'> | null;
};

const plural = (count: number, one: string, many: string) => count + ' ' + (count === 1 ? one : many);
const amount = (item: CustomerQuote['items'][number]) => quantity(item.quantity) + ' ' + item.symbol;

export function quoteReport(quote: CustomerQuote, letterhead: { brand: ReportBrand; footer: string | null }, image: ReportImage | null, now = new Date()): Report {
  const single = quote.items.length === 1;
  const time = [quote.printPlates ? plural(quote.printPlates, 'placa', 'placas') : '', duration(quote.estimatedMinutes)].filter(Boolean).join(' · ');
  const rows: [string, string][] = [
    ...quote.items.map((item, index): [string, string] => [single ? 'Produto' : 'Produto ' + (index + 1), single ? item.name : item.name + ' · ' + amount(item)]),
    ...quote.details.map((row): [string, string] => [row.label, row.value]),
    ...(single ? [['Quantidade', amount(quote.items[0])] as [string, string]] : []),
    ['Tempo estimado', time],
    ...(quote.deliveryDays ? [['Prazo de entrega', plural(quote.deliveryDays, 'dia', 'dias')] as [string, string]] : []),
  ];
  const discounted = Number(quote.discountPercent) > 0 && quote.sale;
  const lines: [string, string][] = [
    ...(single ? [['Valor por unidade', brl(quote.items[0].salePrice)], ['Quantidade', amount(quote.items[0])]] as [string, string][]
      : quote.items.map((item): [string, string] => [item.name + ' (' + amount(item) + ' × ' + brl(item.salePrice) + ')', brl(item.total)])),
    ...(discounted ? [['Subtotal', brl(quote.sale!.gross)], ['Desconto (' + decimal(quote.discountPercent) + '%)', '− ' + brl(quote.sale!.discount)]] as [string, string][] : []),
  ];
  return {
    title: 'Orçamento #' + quote.number, status: 'Válido até ' + displayDate(quote.validUntil),
    generated: 'Emitido em ' + now.toLocaleDateString('pt-BR'), brand: letterhead.brand, footer: letterhead.footer,
    sections: [
      { heading: 'Cliente', fields: [['Nome', quote.customerName], ...(quote.customerContact ? [['Contato', quote.customerContact] as [string, string]] : [])] },
      { heading: quote.title, notes: quote.description ? [quote.description] : [], image },
      { heading: 'Pedido', table: { columns: [{ label: 'Descrição', weight: 1 }, { label: 'Detalhes', weight: 2 }], rows } },
      {
        heading: 'Valores', total: { lines, label: 'VALOR TOTAL', value: brl(quote.sale?.total) },
        notes: ['Orçamento válido até ' + displayDate(quote.validUntil) + '.'],
      },
    ],
  };
}
