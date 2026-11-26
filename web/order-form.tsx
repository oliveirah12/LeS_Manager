import { useState } from 'react';
import { saleEstimate, suggestedMinutes } from './format';
import { blankLine, ExpenseLines, LineRow, ProductLines, SaleFields } from './order-sections';
import type { Order, OrdersView } from './orders';
import { localValue } from './slots';
import { StartPicker } from './start-picker';
import { api, brl, dateTime, Field, Form, quantity, Select, useClosePanel } from './ui';

const orderRows = (order: Order): LineRow[] => order.items.map((item, key) => ({
  key, productId: item.productId, quantity: item.planned, salePrice: item.salePrice ?? '', marginPercent: item.marginPercent ?? '',
}));

/** Creates an order or, when one is given, edits it while it is still planned. */
export function OrderForm({ view, order, seeCosts, done }: { view: OrdersView; order?: Order; seeCosts: boolean; done: (text: string) => Promise<void> }) {
  const [rows, setRows] = useState<LineRow[]>(() => order ? orderRows(order) : [blankLine(0)]);
  const [plannedStart, setPlannedStart] = useState(() => order ? localValue(new Date(order.plannedStart)) : '');
  const [printerId, setPrinterId] = useState(order?.printer.id ?? '');
  const [agenda, setAgenda] = useState(0);
  const [blocked, setBlocked] = useState('');
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
  const timeSuggestion = !hours.trim() && !minutes.trim()
    ? suggestedMinutes(rows.filter(row => row.productId).map(row => ({ quantity: row.quantity, printMinutes: view.products.find(item => item.id === row.productId)?.printMinutes })))
    : null;
  if (!order && (!view.printers.length || !view.products.length)) return <div className="info">
    {!view.printers.length ? 'Cadastre uma impressora ativa em Produção → Impressoras.' : 'Monte a ficha técnica de um produto fabricado em Cadastros → Produtos.'}
  </div>;
  return <Form label={order ? 'Salvar alterações' : 'Criar ordem'} cancel="Cancelar" action={async values => {
    if (!validTime) throw new Error('Informe o tempo de impressão em horas e minutos inteiros.');
    if (!plannedStart) throw new Error('Escolha o dia e o horário de início.');
    if (blocked) throw new Error(blocked);
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
    {timeSuggestion !== null && <div className="section-head">
      <span className="hint">Pela ficha técnica: <strong>{Math.floor(timeSuggestion / 60)} h {timeSuggestion % 60} min</strong></span>
      <button type="button" className="btn secondary small" onClick={() => {
        setHours(String(Math.floor(timeSuggestion / 60)));
        setMinutes(timeSuggestion % 60 ? String(timeSuggestion % 60) : '');
      }}>Usar sugestão</button>
    </div>}
    <StartPicker key={agenda} printerId={printerId} minutes={validTime ? estimatedMinutes : 0} value={plannedStart} onChange={setPlannedStart} onBlocked={setBlocked}
      ignoreOrderId={order?.id} keepValue={sameSchedule} />
    <p className="hint" role="status">{expectedEnd ? <>Término previsto: <strong>{dateTime(expectedEnd)}</strong></> : 'Informe o início e o tempo para calcular o término.'}</p>
    <h3>Produtos da impressão</h3>
    <ProductLines rows={rows} setRows={setRows} products={products} estimates={order?.budget?.items} seeCosts={seeCosts} scope="esta ordem" />
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
    <ExpenseLines expenses={expenses} setExpenses={setExpenses} />
    <h3>Venda</h3>
    <SaleFields discount={discount} setDiscount={setDiscount} payments={payments} paymentId={paymentId} setPaymentId={setPaymentId} fee={fee} setFee={setFee} sale={sale} />
    <Field name="notes" label="Observação" required={false} placeholder="Pedido, cliente ou lote" defaultValue={order?.notes ?? undefined} />
  </Form>;
}
