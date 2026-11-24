import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { revisionChanges } from './format';
import type { Order, OrdersView } from './orders';
import { api, brl, by, dateTime, Field, Form, Loading, message, quantity, Select, Table, Title, useClosePanel, useData } from './ui';

type Values = Record<string, unknown>;
type Move = {
  productId: string; sku: string; name: string; symbol: string; kind: 'PRODUCTION_ADJUST_IN' | 'PRODUCTION_ADJUST_OUT'; quantity: string;
  unitCost?: string | null; balanceBefore?: string; balanceAfter?: string;
};
type Preview = {
  revision: number; stock: { productId: string; revision: number }[]; before: Values; after: Values; shippedOut: boolean; moves: Move[];
  costInStock?: string; costIssued?: string; averages?: { productId: string; sku: string; before: string | null; after: string | null }[];
};
type Revision = {
  id: string; number: number; reason: string; user: { name: string }; createdAt: string; before: Values; after: Values; costInStock?: string; costIssued?: string;
};

const typed = (value: FormDataEntryValue | null) => String(value ?? '').trim().replace(',', '.');
/** Compares decimals as text, so a value the person did not touch is never sent. */
const plain = (value: string | null | undefined) => {
  const text = typed(value ?? '');
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
};
const changed = (value: string, current: string | null | undefined) => plain(value) !== plain(current);

function Differences({ before, after }: { before: Values; after: Values }) {
  return <Table responsive={false} empty="Nenhum valor visível mudou." columns={['Campo', 'Antes', 'Depois']}
    rows={revisionChanges(before, after).map(([key, old, next]) => [key, old, <strong>{next}</strong>])} />;
}

export function CorrectOrder({ order, view, seeCosts, done }: { order: Order; view: OrdersView; seeCosts: boolean; done: (text: string) => Promise<void> }) {
  const [review, setReview] = useState<{ payload: Values; preview: Preview }>();
  const [manual, setManual] = useState(() => order.expenses.filter(row => row.source === 'MANUAL').map((row, key) => ({ key, title: row.title, value: row.value })));
  const closePanel = useClosePanel();
  const path = 'production/orders/' + order.id + '/correction';
  const inputExpense = (inputId: string) => order.expenses.find(row => row.source === 'INPUT' && row.inputId === inputId)?.value ?? '0';
  const printers = view.printers.some(row => row.id === order.printer.id) ? view.printers : [order.printer, ...view.printers];
  const payments = [...view.paymentMethods];
  if (order.sale.paymentMethodId && !payments.some(row => row.id === order.sale.paymentMethodId)) {
    payments.unshift({ id: order.sale.paymentMethodId, name: order.sale.paymentName ?? 'Forma atual', feePercent: null });
  }

  function payload(values: FormData) {
    const body: Values = { reason: String(values.get('reason') ?? '').trim() };
    const minutes = typed(values.get('printMinutes'));
    if (minutes !== String(order.printMinutes)) body.printMinutes = Number(minutes);
    if (values.get('printerId') !== order.printer.id) body.printerId = values.get('printerId');
    if (values.has('absorbLoss') !== order.absorbLoss) body.absorbLoss = values.has('absorbLoss');
    if (seeCosts) {
      for (const [key, current] of [['powerWatts', order.powerWatts], ['energyRate', order.energyRate], ['hourlyCost', order.hourlyCost]] as const) {
        const value = typed(values.get(key));
        if (changed(value, current)) body[key] = value;
      }
    }
    body.items = order.items.flatMap(item => {
      const lost = typed(values.get('lost' + item.productId)) || '0';
      const price = typed(values.get('price' + item.productId));
      const row: Values = { productId: item.productId };
      if (changed(lost, item.lost)) row.lost = lost;
      if (changed(price, item.salePrice)) row.salePrice = price || null;
      return Object.keys(row).length > 1 ? [row] : [];
    });
    body.inputs = order.inputs.flatMap(input => {
      const used = typed(values.get('used' + input.inputId)) || '0';
      return changed(used, input.used) ? [{ inputId: input.inputId, used }] : [];
    });
    body.inputExpenses = order.inputs.flatMap(input => {
      const value = typed(values.get('expense' + input.inputId)) || '0';
      return changed(value, inputExpense(input.inputId)) ? [{ inputId: input.inputId, value }] : [];
    });
    const current = order.expenses.filter(row => row.source === 'MANUAL').map(row => row.title + '|' + plain(row.value));
    const next = manual.map(row => ({ title: row.title.trim(), value: typed(row.value) }));
    if (JSON.stringify(current) !== JSON.stringify(next.map(row => row.title + '|' + plain(row.value)))) body.manualExpenses = next;
    const discount = typed(values.get('discountPercent')) || '0';
    if (changed(discount, order.sale.discountPercent)) body.discountPercent = discount;
    const paymentId = String(values.get('paymentMethodId') ?? '');
    if (paymentId !== (order.sale.paymentMethodId ?? '')) body.paymentMethodId = paymentId || null;
    const fee = typed(values.get('feePercent'));
    if (!fee) { if (Number(order.sale.feePercent) > 0 && !body.paymentMethodId) body.feePercent = null; } else if (changed(fee, order.sale.feePercent)) body.feePercent = fee;
    return body;
  }

  return <>
    <div hidden={!!review}>
      <Form label="Conferir impacto" cancel="Cancelar" action={async values => {
        const body = payload(values);
        setReview({ payload: body, preview: await api<Preview>(path + '/preview', body) });
      }}>
        <div className="info">As movimentações originais não mudam. A diferença entra como nova movimentação e fica no histórico de revisões.</div>
        <Field name="reason" label="Motivo da correção" hint="Fica registrado na revisão e na auditoria." />
        <h3>Tempo e máquina</h3>
        <div className="form-grid">
          <Field name="printMinutes" label="Tempo cobrado (min)" inputMode="numeric" defaultValue={String(order.printMinutes ?? '')} />
          <Select name="printerId" label="Impressora" options={printers} defaultValue={order.printer.id} />
          {seeCosts && <>
            <Field name="powerWatts" label="Potência (W)" inputMode="decimal" defaultValue={order.powerWatts ?? ''} />
            <Field name="energyRate" label="Tarifa (R$/kWh)" inputMode="decimal" defaultValue={order.energyRate ?? ''} />
            <Field name="hourlyCost" label="Custo por hora" inputMode="decimal" defaultValue={order.hourlyCost ?? ''} />
          </>}
        </div>
        <h3>Peças e preço</h3>
        {order.items.map(item => <div className="form-grid" key={item.productId}>
          <Field name={'lost' + item.productId} label={item.sku + ' · perdidas (' + item.symbol + ')'} inputMode="decimal" required={false} defaultValue={item.lost ?? '0'}
            hint={'De ' + quantity(item.planned) + ' ' + item.symbol + ' na ordem'} />
          <Field name={'price' + item.productId} label={item.sku + ' · preço de venda'} inputMode="decimal" required={false} defaultValue={item.salePrice ?? ''} />
        </div>)}
        <label className="check"><input name="absorbLoss" type="checkbox" defaultChecked={order.absorbLoss} />Embutir a perda no custo das peças boas</label>
        <h3>Consumo e despesas de compra</h3>
        {order.inputs.map(input => <div className="form-grid" key={input.inputId}>
          <Field name={'used' + input.inputId} label={input.sku + ' · consumo (' + input.symbol + ')'} inputMode="decimal" defaultValue={input.used ?? '0'} />
          <Field name={'expense' + input.inputId} label={input.sku + ' · despesa'} inputMode="decimal" required={false} defaultValue={inputExpense(input.inputId)} />
        </div>)}
        <h3>Despesas manuais</h3>
        {manual.map(row => <div className="form-grid" key={row.key}>
          <label>Título<input required value={row.title} onChange={event => setManual(rows => rows.map(line => line.key === row.key ? { ...line, title: event.target.value } : line))} /></label>
          <label>Valor<input required inputMode="decimal" value={row.value} onChange={event => setManual(rows => rows.map(line => line.key === row.key ? { ...line, value: event.target.value } : line))} /></label>
          <button type="button" className="btn ghost small" style={{ alignSelf: 'end' }} onClick={() => setManual(rows => rows.filter(line => line.key !== row.key))}>
            <Trash2 size={14} aria-hidden="true" />Remover</button>
        </div>)}
        <button type="button" className="btn secondary small" style={{ alignSelf: 'flex-start' }}
          onClick={() => setManual(rows => [...rows, { key: Math.max(-1, ...rows.map(line => line.key)) + 1, title: '', value: '' }])}>
          <Plus size={14} aria-hidden="true" />Adicionar despesa</button>
        <h3>Venda</h3>
        <div className="form-grid">
          <Field name="discountPercent" label="Desconto (%)" inputMode="decimal" required={false} defaultValue={order.sale.discountPercent} />
          <Select name="paymentMethodId" label="Forma de pagamento" options={payments} required={false} placeholder="Sem forma de pagamento" defaultValue={order.sale.paymentMethodId ?? ''} />
          <Field name="feePercent" label="Taxa (%)" inputMode="decimal" required={false} defaultValue={order.sale.feePercent} hint="Vazio: usa a taxa da forma de pagamento." />
        </div>
      </Form>
    </div>
    {review && <div className="stack">
      <h3>O que muda na ordem</h3>
      <Differences before={review.preview.before} after={review.preview.after} />
      <h3>Compensação no estoque</h3>
      {review.preview.moves.length === 0 ? <p className="muted">Nenhuma movimentação de quantidade.</p> : <Table responsive={false}
        columns={['Produto', 'Tipo', { label: 'Quantidade', end: true }, ...(seeCosts ? [{ label: 'Custo unitário', end: true }, { label: 'Saldo depois', end: true }] : [])]}
        rows={review.preview.moves.map(row => [
          by(row.name, <Title name={row.name} code={row.sku} />), row.kind === 'PRODUCTION_ADJUST_IN' ? 'Entrada' : 'Saída', by(row.quantity, quantity(row.quantity) + ' ' + row.symbol),
          ...(seeCosts ? [by(row.unitCost, brl(row.unitCost)), by(row.balanceAfter, quantity(row.balanceAfter ?? '0') + ' ' + row.symbol)] : []),
        ])} />}
      {seeCosts && <dl className="dl">
        <div><dt>Diferença aplicada à média</dt><dd>{brl(review.preview.costInStock)}</dd></div>
        <div><dt>Parte já baixada (só registrada)</dt><dd>{brl(review.preview.costIssued)}</dd></div>
        {review.preview.averages?.map(row => <div key={row.productId}><dt>Custo médio de {row.sku}</dt><dd>{brl(row.before)} → <strong>{brl(row.after)}</strong></dd></div>)}
      </dl>}
      {review.preview.shippedOut && <div className="info">Esta ordem teve saída direta. Peças a mais entram no estoque, e peças a menos precisam de saldo disponível.</div>}
      <Form label="Confirmar correção" extra={<button type="button" className="btn secondary" onClick={() => setReview(undefined)}>Voltar</button>} action={async () => {
        await api(path, { ...review.payload, expectedRevision: review.preview.revision, stock: review.preview.stock });
        await done('Ordem corrigida.');
        closePanel?.();
      }} />
    </div>}
  </>;
}

export function RevisionHistory({ orderId, seeCosts }: { orderId: string; seeCosts: boolean }) {
  const { data, error, loading } = useData<Revision[]>('production/orders/' + orderId + '/revisions');
  return <>
    <h3>Histórico de revisões</h3>
    {message(error)}
    {loading && !data && <Loading label="Carregando revisões…" />}
    {data?.map(row => <div className="stack" key={row.id} style={{ gap: 6 }}>
      <strong>Revisão {row.number} · {dateTime(row.createdAt)} · {row.user.name}</strong>
      <span>Motivo: {row.reason}</span>
      {seeCosts && <span className="hint">Aplicado à média: {brl(row.costInStock)} · Já baixado: {brl(row.costIssued)}</span>}
      <Differences before={row.before} after={row.after} />
    </div>)}
  </>;
}
