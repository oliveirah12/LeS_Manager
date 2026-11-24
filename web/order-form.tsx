import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { saleEstimate } from './format';
import type { Order, OrdersView } from './orders';
import { localValue } from './slots';
import { StartPicker } from './start-picker';
import { api, brl, dateTime, Field, Form, quantity, Select, useClosePanel } from './ui';

type Row = { key: number; productId: string; quantity: string; salePrice: string; marginPercent: string };
const blankRow = (key: number): Row => ({ key, productId: '', quantity: '', salePrice: '', marginPercent: '' });

const orderRows = (order: Order): Row[] => order.items.map((item, key) => ({
  key, productId: item.productId, quantity: item.planned, salePrice: item.salePrice ?? '', marginPercent: item.marginPercent ?? '',
}));

/** Creates an order or, when one is given, edits it while it is still planned. */
export function OrderForm({ view, order, seeCosts, done }: { view: OrdersView; order?: Order; seeCosts: boolean; done: (text: string) => Promise<void> }) {
  const [rows, setRows] = useState<Row[]>(() => order ? orderRows(order) : [blankRow(0)]);
  const [plannedStart, setPlannedStart] = useState(() => order ? localValue(new Date(order.plannedStart)) : '');
  const [printerId, setPrinterId] = useState(order?.printer.id ?? '');
  const [agenda, setAgenda] = useState(0);
  const [hours, setHours] = useState(() => order && order.estimatedMinutes >= 60 ? String(Math.floor(order.estimatedMinutes / 60)) : '');
  const [minutes, setMinutes] = useState(() => order && order.estimatedMinutes % 60 ? String(order.estimatedMinutes % 60) : '');
  const [discount, setDiscount] = useState(() => order && Number(order.sale.discountPercent) > 0 ? order.sale.discountPercent : '');
  const [paymentId, setPaymentId] = useState(order?.sale.paymentMethodId ?? '');
  const [fee, setFee] = useState(() => order?.sale.customFee ? order.sale.feePercent : '');
  const [expenses, setExpenses] = useState<{ key: number; title: string; value: string }[]>(() => (order?.expenses ?? [])
    .filter(row => row.source === 'MANUAL').map((row, key) => ({ key, title: row.title, value: row.value })));
  const [substitutes, setSubstitutes] = useState<Record<string, string>>({});
  const [typedInputs, setTypedInputs] = useState<Record<string, string>>({});
  const [typedExpenses, setTypedExpenses] = useState<Record<string, string | null>>({});
  const closePanel = useClosePanel();
  const estimatedMinutes = Number(hours || 0) * 60 + Number(minutes || 0);
  const validTime = Number.isInteger(estimatedMinutes) && estimatedMinutes > 0;
  const startTime = new Date(plannedStart).getTime();
  const expectedEnd = validTime && Number.isFinite(startTime) ? new Date(startTime + estimatedMinutes * 60000).toISOString() : null;
  // The field has no seconds, so an untouched schedule sends the stored start and the API does not read it as a move.
  const sameSchedule = Boolean(order && printerId === order.printer.id && estimatedMinutes === order.estimatedMinutes && plannedStart === localValue(new Date(order.plannedStart)));
  // An order may keep a printer, method or product that has since left the active lists.
  const printers = order && !view.printers.some(row => row.id === order.printer.id) ? [...view.printers, order.printer] : view.printers;
  const payments = order?.sale.paymentMethodId && !view.paymentMethods.some(row => row.id === order.sale.paymentMethodId)
    ? [...view.paymentMethods, { id: order.sale.paymentMethodId, name: order.sale.paymentName ?? 'Forma inativa', feePercent: order.sale.feePercent }] : view.paymentMethods;
  const products = [...view.products, ...(order?.items ?? []).filter(item => !view.products.some(row => row.id === item.productId))
    .map(item => ({ id: item.productId, sku: item.sku, name: item.name, symbol: item.symbol, salePrice: item.salePrice, marginPercent: item.marginPercent }))];
  const orderInputs = (order?.inputs ?? []).filter(input => input.parts.some(part => rows.some(row => row.productId === part.productId)));
  const inputExpenses = (order?.expenses ?? []).filter(row => row.source === 'INPUT' && orderInputs.some(input => input.inputId === row.inputId));
  const payment = payments.find(method => method.id === paymentId);
  const sale = saleEstimate(rows, discount, fee.trim() ? fee : payment?.feePercent ?? '0');
  const change = (key: number, values: Partial<Row>) => setRows(items => items.map(item => item.key === key ? { ...item, ...values } : item));
  /** Choosing a product brings its registered price and margin, which stay editable for this order only. */
  function choose(key: number, productId: string) {
    const product = products.find(item => item.id === productId);
    change(key, { productId, salePrice: product?.salePrice ?? '', marginPercent: product?.marginPercent ?? '' });
  }
  if (!order && (!view.printers.length || !view.products.length)) return <div className="info">
    {!view.printers.length ? 'Cadastre uma impressora ativa em Produção → Impressoras.' : 'Monte a ficha técnica de um produto fabricado em Cadastros → Produtos.'}
  </div>;
  return <Form label={order ? 'Salvar alterações' : 'Criar ordem'} cancel="Cancelar" action={async values => {
    if (!validTime) throw new Error('Informe o tempo de impressão em horas e minutos inteiros.');
    if (!plannedStart) throw new Error('Escolha o início no calendário.');
    const edits = order ? {
      replacements: orderInputs.filter(input => substitutes[input.inputId] && substitutes[input.inputId] !== input.inputId)
        .map(input => ({ inputId: input.inputId, substituteId: substitutes[input.inputId] })),
      inputs: orderInputs.filter(input => typedInputs[input.inputId]?.trim()).map(input => ({ inputId: input.inputId, planned: typedInputs[input.inputId].trim() })),
      inputExpenses: inputExpenses.filter(row => typedExpenses[row.inputId!] !== undefined).map(row => ({ inputId: row.inputId, value: typedExpenses[row.inputId!]?.trim() || null })),
    } : {};
    await api('production/orders' + (order ? '/' + order.id : ''), {
      ...edits,
      printerId: values.get('printerId'), plannedStart: sameSchedule ? order!.plannedStart : new Date(plannedStart).toISOString(), estimatedMinutes, notes: String(values.get('notes') ?? ''),
      manualExpenses: expenses.map(({ title, value }) => ({ title, value })),
      discountPercent: discount.trim() || '0', paymentMethodId: paymentId || null, feePercent: fee.trim() || null,
      items: rows.map(row => ({
        productId: row.productId, quantity: row.quantity,
        ...(row.salePrice.trim() ? { salePrice: row.salePrice.trim() } : seeCosts || order ? { salePrice: null } : {}),
        ...(seeCosts ? { marginPercent: row.marginPercent.trim() || null } : {}),
      })),
    }, order ? 'PATCH' : 'POST').catch(error => {
      // Someone may have taken this time after the calendar loaded, so it reads the agenda again.
      setAgenda(version => version + 1);
      throw error;
    });
    await done(order ? 'Ordem atualizada.' : 'Ordem criada.');
    closePanel?.();
  }}>
    <Select name="printerId" label="Impressora" options={printers} defaultValue={order?.printer.id} onChange={setPrinterId} />
    <div className="form-grid">
      <label>Tempo de impressão (horas)<input name="hours" inputMode="numeric" placeholder="10" value={hours} onChange={event => setHours(event.target.value)} /></label>
      <label>Minutos<input name="minutes" inputMode="numeric" placeholder="0" value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
    </div>
    <StartPicker key={agenda} printerId={printerId} minutes={validTime ? estimatedMinutes : 0} value={plannedStart} onChange={setPlannedStart}
      ignoreOrderId={order?.id} allowPast={Boolean(order)} keepValue={sameSchedule} />
    <p className="hint" role="status">{expectedEnd ? <>Término previsto: <strong>{dateTime(expectedEnd)}</strong></> : 'Informe o início e o tempo para calcular o término.'}</p>
    <h3>Produtos da impressão</h3>
    {rows.map((row, index) => {
      const product = products.find(item => item.id === row.productId);
      const options = products.filter(item => item.id === row.productId || !rows.some(other => other.productId === item.id));
      const estimate = order?.budget?.items.find(item => item.productId === row.productId);
      return <div className="stack" style={{ gap: 8 }} key={row.key}>
        <div className="component-row" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto' }}>
          <Select name={'product' + row.key} label={'Produto ' + (index + 1)} options={options.map(item => ({ id: item.id, name: item.sku + ' · ' + item.name }))} defaultValue={row.productId}
            onChange={value => choose(row.key, value)} />
          <label>{'Quantidade' + (product ? ' (' + product.symbol + ')' : '')}
            <input name={'quantity' + row.key} inputMode="decimal" required value={row.quantity} onChange={event => change(row.key, { quantity: event.target.value })} /></label>
          <button type="button" className="icon-button" aria-label={'Remover produto ' + (index + 1)} disabled={rows.length === 1}
            onClick={() => setRows(items => items.filter(item => item.key !== row.key))}><Trash2 size={18} aria-hidden="true" /></button>
        </div>
        <div className="form-grid">
          <label>Preço por unidade<input aria-label={'Preço do produto ' + (index + 1)} inputMode="decimal" value={row.salePrice} placeholder={seeCosts ? 'Sem preço' : 'Preço do cadastro'}
            onChange={event => change(row.key, { salePrice: event.target.value })} />
            {estimate?.suggestedPrice && estimate.suggestedPrice !== row.salePrice && <button type="button" className="btn ghost small" style={{ alignSelf: 'flex-start' }}
              onClick={() => change(row.key, { salePrice: estimate.suggestedPrice! })}>Usar sugerido: {brl(estimate.suggestedPrice)}</button>}
            {estimate?.belowTargetMargin && <span className="hint">O preço está abaixo da margem desejada.</span>}</label>
          {seeCosts && <label>Margem desejada (%)<input aria-label={'Margem do produto ' + (index + 1)} inputMode="decimal" value={row.marginPercent}
            onChange={event => change(row.key, { marginPercent: event.target.value })} /><span className="hint">Vale só para esta ordem.</span></label>}
        </div>
      </div>;
    })}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }} disabled={rows.length >= products.length}
      onClick={() => setRows(items => [...items, blankRow(Math.max(...items.map(item => item.key)) + 1)])}>
      <Plus size={16} aria-hidden="true" />Adicionar produto</button>
    {orderInputs.length > 0 && <>
      <h3>Insumos</h3>
      <p className="hint">Troque por outro insumo da mesma família ou ajuste o total. Produtos novos usam a ficha técnica ao salvar.</p>
      {orderInputs.map(input => {
        const options = view.inputs.filter(item => item.familyId === input.familyId && item.id !== input.inputId && !rows.some(row => row.productId === item.id));
        return <div className="form-grid" key={input.inputId}>
          <Select name={'substitute' + input.inputId} label={'Insumo ' + input.sku} required={false} placeholder={input.sku + ' · manter'}
            options={options.map(item => ({ id: item.id, name: item.sku + ' · ' + item.name }))}
            onChange={value => setSubstitutes(items => ({ ...items, [input.inputId]: value }))} />
          <label>{'Total (' + input.symbol + ')'}<input aria-label={'Total de ' + input.sku} inputMode="decimal" placeholder={quantity(input.planned)} value={typedInputs[input.inputId] ?? ''}
            onChange={event => setTypedInputs(items => ({ ...items, [input.inputId]: event.target.value }))} />
            <span className="hint">{input.replaces.length ? 'Substitui ' + input.replaces.join(', ') + '. ' : ''}Vazio: mantém a proporção.</span></label>
        </div>;
      })}
    </>}
    <h3>Despesas</h3>
    <p className="hint">As despesas de compra dos insumos entram sozinhas, pelo consumo. Adicione aqui o que for só desta ordem.</p>
    {inputExpenses.map(row => {
      const typed = typedExpenses[row.inputId!];
      return <label key={row.id}>{row.title}
        <input aria-label={row.title} inputMode="decimal" value={typed ?? (typed === null ? row.suggested ?? '' : row.value)}
          onChange={event => setTypedExpenses(items => ({ ...items, [row.inputId!]: event.target.value }))} />
        {row.edited && typed !== null && <button type="button" className="btn ghost small" style={{ alignSelf: 'flex-start' }}
          onClick={() => setTypedExpenses(items => ({ ...items, [row.inputId!]: null }))}>Usar sugestão: {brl(row.suggested)}</button>}
      </label>;
    })}
    {expenses.map((row, index) => <div className="component-row" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto' }} key={row.key}>
      <label>Título<input aria-label={'Título da despesa ' + (index + 1)} required maxLength={120} value={row.title}
        onChange={event => setExpenses(items => items.map(item => item.key === row.key ? { ...item, title: event.target.value } : item))} /></label>
      <label>Valor<input aria-label={'Valor da despesa ' + (index + 1)} required inputMode="decimal" value={row.value}
        onChange={event => setExpenses(items => items.map(item => item.key === row.key ? { ...item, value: event.target.value } : item))} /></label>
      <button type="button" className="icon-button" aria-label={'Remover despesa ' + (index + 1)}
        onClick={() => setExpenses(items => items.filter(item => item.key !== row.key))}><Trash2 size={18} aria-hidden="true" /></button>
    </div>)}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }}
      onClick={() => setExpenses(items => [...items, { key: Math.max(-1, ...items.map(item => item.key)) + 1, title: '', value: '' }])}>
      <Plus size={16} aria-hidden="true" />Adicionar despesa</button>
    <h3>Venda</h3>
    <div className="form-grid">
      <label>Desconto sobre o total (%)<input name="discountPercent" inputMode="decimal" placeholder="0" value={discount} onChange={event => setDiscount(event.target.value)} /></label>
      <Select name="paymentMethodId" label="Forma de pagamento" required={false} options={payments} defaultValue={order?.sale.paymentMethodId ?? undefined} onChange={setPaymentId} />
      <label>Taxa (%)<input name="feePercent" inputMode="decimal" value={fee} placeholder={payment?.feePercent ?? '0'} onChange={event => setFee(event.target.value)} />
        <span className="hint">Vazio: usa a taxa da forma de pagamento.</span></label>
    </div>
    {sale && <p className="hint" role="status">Bruto {brl(sale.gross)} · Desconto {brl(sale.discount)} · Total {brl(sale.total)} · Taxa {brl(sale.fee)} · <strong>Líquido {brl(sale.net)}</strong></p>}
    <Field name="notes" label="Observação" required={false} placeholder="Pedido, cliente ou lote" defaultValue={order?.notes ?? undefined} />
  </Form>;
}
