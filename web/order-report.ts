import { brl, decimal, duration, quantity, revisionChanges } from './format';
import type { Order } from './orders';
import type { Report, ReportSection } from './pdf';

export type ReportRevision = {
  number: number; reason: string; user: { name: string }; createdAt: string;
  before: Record<string, unknown>; after: Record<string, unknown>; costInStock?: string; costIssued?: string;
};

const when = (value: string | Date) => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const named = (name: string, sku: string) => name + ' (' + sku + ')';
const filled = (fields: ([string, string] | false | null | undefined)[]) => fields.filter(Boolean) as [string, string][];

/** The same facts as the order's details. Costs enter only for a profile with stock:view. */
export function orderReport(order: Order, statusName: string, seeCosts: boolean, revisions: ReportRevision[], now = new Date()): Report {
  const finished = order.items.some(item => item.good !== null);
  const usedInputs = order.inputs.some(input => input.used !== null);
  const budget = seeCosts ? order.budget : null;
  const sale = order.sale.values;
  const sections: ReportSection[] = [{
    heading: 'Dados da ordem',
    fields: filled([
      ['Impressora', order.printer.name], ['Criada por', order.user.name],
      ['Início previsto', when(order.plannedStart)], ['Término previsto', when(order.expectedEnd)],
      ['Tempo estimado', duration(order.estimatedMinutes)],
      !!order.startedAt && ['Início real', when(order.startedAt)],
      !!order.finishedAt && ['Encerrada em', when(order.finishedAt)],
      order.printMinutes !== null && ['Tempo cobrado', duration(order.printMinutes)],
      !!order.notes && ['Observação', order.notes],
    ]),
  }];
  if (seeCosts && (order.totalCost != null || order.machineCost != null)) sections.push({
    heading: 'Custos',
    fields: filled([
      order.machineCost != null && ['Máquina e energia', brl(order.machineCost)],
      order.expenseCost != null && ['Despesas', brl(order.expenseCost)],
      order.totalCost != null && ['Custo total', brl(order.totalCost)],
      order.lossCost != null && ['Valor da perda', brl(order.lossCost) + (order.absorbLoss ? ' (embutida nas peças boas)' : '')],
    ]),
  });
  if (budget) sections.push({
    heading: 'Orçamento estimado',
    notes: [
      'Usa o custo médio, a impressora e a tarifa de agora. Nada é congelado até a ordem ser concluída.',
      ...(budget.partialCost ? ['Orçamento parcial. Sem custo registrado: ' + budget.missingCost.join(', ') + '.'] : []),
    ],
    fields: [
      ['Insumos previstos', '≈ ' + brl(budget.materialCost)], ['Máquina e energia (' + duration(order.estimatedMinutes) + ')', '≈ ' + brl(budget.machineCost)],
      ['Despesas', '≈ ' + brl(budget.expenseCost)], ['Total estimado', '≈ ' + brl(budget.totalCost)],
    ],
  });
  if (sale) sections.push({
    heading: 'Venda',
    notes: sale.partial ? ['Há item sem preço, então a venda considera apenas os demais.'] : [],
    fields: filled([
      ['Bruto', brl(sale.gross)], ['Desconto', brl(sale.discount)], ['Total da venda', brl(sale.total)], ['Pagamento', order.sale.paymentName ?? '—'],
      ['Taxa (' + decimal(order.sale.feePercent) + '%)', brl(sale.fee)], ['Líquido', brl(sale.net)],
      seeCosts && sale.profit !== undefined && ['Resultado', brl(sale.profit) + (sale.marginPercent != null ? ' · ' + decimal(sale.marginPercent) + '%' : '')],
    ]),
  });
  sections.push({
    heading: 'Produtos',
    table: {
      columns: [
        { label: 'Produto', weight: 3 }, { label: 'Ordem', end: true },
        ...(finished ? [{ label: 'Boas', end: true }, { label: 'Perdidas', end: true }, ...(seeCosts ? [{ label: 'Custo por peça', end: true }] : [])] : []),
        { label: 'Preço', end: true },
        ...(budget ? [{ label: 'Total estimado', end: true }, { label: 'Estimado por peça', end: true }, { label: 'Preço sugerido', end: true }] : []),
      ],
      rows: order.items.map(item => {
        const estimate = budget?.items.find(row => row.productId === item.productId);
        return [
          named(item.name, item.sku), quantity(item.planned) + ' ' + item.symbol,
          ...(finished ? [quantity(item.good ?? '0'), quantity(item.lost ?? '0'), ...(seeCosts ? [brl(item.unitCost)] : [])] : []),
          item.salePrice === null ? '—' : brl(item.salePrice),
          ...(budget ? ['≈ ' + brl(estimate?.totalCost), '≈ ' + brl(estimate?.unitCost), estimate?.suggestedPrice ? brl(estimate.suggestedPrice) : '—'] : []),
        ];
      }),
    },
  }, {
    heading: 'Insumos',
    table: {
      columns: [{ label: 'Insumo', weight: 3 }, { label: 'Previsto', end: true }, ...(usedInputs ? [{ label: 'Real', end: true }] : [])],
      rows: order.inputs.map(input => [
        named(input.name, input.sku) + (input.replaces.length ? ' · substitui ' + input.replaces.join(', ') : ''),
        quantity(input.planned) + ' ' + input.symbol,
        ...(usedInputs ? [input.used === null ? '—' : quantity(input.used) + ' ' + input.symbol] : []),
      ]),
    },
  });
  if (order.expenses.length) sections.push({
    heading: 'Despesas',
    table: {
      columns: [{ label: 'Despesa', weight: 3 }, { label: 'Origem' }, { label: 'Valor', end: true }],
      rows: order.expenses.map(row => [row.title, row.source === 'INPUT' ? (row.edited ? 'Insumo (editada)' : 'Insumo') : 'Manual', brl(row.value)]),
    },
  });
  for (const revision of revisions) sections.push({
    heading: 'Revisão ' + revision.number + ' · ' + when(revision.createdAt) + ' · ' + revision.user.name,
    notes: ['Motivo: ' + revision.reason, ...(seeCosts ? ['Aplicado à média: ' + brl(revision.costInStock) + ' · Já baixado: ' + brl(revision.costIssued)] : [])],
    table: { columns: [{ label: 'Campo' }, { label: 'Antes', weight: 2 }, { label: 'Depois', weight: 2 }], rows: revisionChanges(revision.before, revision.after) },
  });
  return { title: 'Ordem de produção #' + order.number, status: statusName, generated: 'Gerado em ' + when(now), sections };
}
