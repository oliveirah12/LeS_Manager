import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { saleEstimate } from './format';
import type { OrdersView } from './orders';
import { api, brl, dateTime, Field, Form, Select, useClosePanel } from './ui';

const localValue = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
type Row = { key: number; productId: string; quantity: string; salePrice: string; marginPercent: string };
const blankRow = (key: number): Row => ({ key, productId: '', quantity: '', salePrice: '', marginPercent: '' });

export function OrderForm({ view, seeCosts, done }: { view: OrdersView; seeCosts: boolean; done: (text: string) => Promise<void> }) {
  const [rows, setRows] = useState<Row[]>([blankRow(0)]);
  const [plannedStart, setPlannedStart] = useState(() => localValue());
  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const [discount, setDiscount] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [fee, setFee] = useState('');
  const [expenses, setExpenses] = useState<{ key: number; title: string; value: string }[]>([]);
  const closePanel = useClosePanel();
  const estimatedMinutes = Number(hours || 0) * 60 + Number(minutes || 0);
  const validTime = Number.isInteger(estimatedMinutes) && estimatedMinutes > 0;
  const startTime = new Date(plannedStart).getTime();
  const expectedEnd = validTime && Number.isFinite(startTime) ? new Date(startTime + estimatedMinutes * 60000).toISOString() : null;
  const payment = view.paymentMethods.find(method => method.id === paymentId);
  const sale = saleEstimate(rows, discount, fee.trim() ? fee : payment?.feePercent ?? '0');
  const change = (key: number, values: Partial<Row>) => setRows(items => items.map(item => item.key === key ? { ...item, ...values } : item));
  /** Choosing a product brings its registered price and margin, which stay editable for this order only. */
  function choose(key: number, productId: string) {
    const product = view.products.find(item => item.id === productId);
    change(key, { productId, salePrice: product?.salePrice ?? '', marginPercent: product?.marginPercent ?? '' });
  }
  if (!view.printers.length || !view.products.length) return <div className="info">
    {!view.printers.length ? 'Cadastre uma impressora ativa em Produção → Impressoras.' : 'Monte a ficha técnica de um produto fabricado em Cadastros → Produtos.'}
  </div>;
  return <Form label="Criar ordem" cancel="Cancelar" action={async values => {
    if (!validTime) throw new Error('Informe o tempo de impressão em horas e minutos inteiros.');
    await api('production/orders', {
      printerId: values.get('printerId'), plannedStart: new Date(plannedStart).toISOString(), estimatedMinutes, notes: String(values.get('notes') ?? ''),
      manualExpenses: expenses.map(({ title, value }) => ({ title, value })),
      discountPercent: discount.trim() || '0', paymentMethodId: paymentId || null, feePercent: fee.trim() || null,
      items: rows.map(row => ({
        productId: row.productId, quantity: row.quantity,
        ...(row.salePrice.trim() ? { salePrice: row.salePrice.trim() } : seeCosts ? { salePrice: null } : {}),
        ...(seeCosts ? { marginPercent: row.marginPercent.trim() || null } : {}),
      })),
    });
    await done('Ordem criada.');
    closePanel?.();
  }}>
    <div className="form-grid">
      <Select name="printerId" label="Impressora" options={view.printers} />
      <label>Início previsto<input name="plannedStart" type="datetime-local" required value={plannedStart} onChange={event => setPlannedStart(event.target.value)} /></label>
    </div>
    <div className="form-grid">
      <label>Tempo de impressão (horas)<input name="hours" inputMode="numeric" placeholder="10" value={hours} onChange={event => setHours(event.target.value)} /></label>
      <label>Minutos<input name="minutes" inputMode="numeric" placeholder="0" value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
    </div>
    <p className="hint" role="status">{expectedEnd ? <>Término previsto: <strong>{dateTime(expectedEnd)}</strong></> : 'Informe o início e o tempo para calcular o término.'}</p>
    <h3>Produtos da impressão</h3>
    {rows.map((row, index) => {
      const product = view.products.find(item => item.id === row.productId);
      const options = view.products.filter(item => item.id === row.productId || !rows.some(other => other.productId === item.id));
      return <div className="stack" style={{ gap: 8 }} key={row.key}>
        <div className="component-row" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto' }}>
          <Select name={'product' + row.key} label={'Produto ' + (index + 1)} options={options.map(item => ({ id: item.id, name: item.sku + ' · ' + item.name }))}
            onChange={value => choose(row.key, value)} />
          <label>{'Quantidade' + (product ? ' (' + product.symbol + ')' : '')}
            <input name={'quantity' + row.key} inputMode="decimal" required value={row.quantity} onChange={event => change(row.key, { quantity: event.target.value })} /></label>
          <button type="button" className="icon-button" aria-label={'Remover produto ' + (index + 1)} disabled={rows.length === 1}
            onClick={() => setRows(items => items.filter(item => item.key !== row.key))}><Trash2 size={18} aria-hidden="true" /></button>
        </div>
        <div className="form-grid">
          <label>Preço por unidade<input aria-label={'Preço do produto ' + (index + 1)} inputMode="decimal" value={row.salePrice} placeholder={seeCosts ? 'Sem preço' : 'Preço do cadastro'}
            onChange={event => change(row.key, { salePrice: event.target.value })} /></label>
          {seeCosts && <label>Margem desejada (%)<input aria-label={'Margem do produto ' + (index + 1)} inputMode="decimal" value={row.marginPercent}
            onChange={event => change(row.key, { marginPercent: event.target.value })} /><span className="hint">Vale só para esta ordem.</span></label>}
        </div>
      </div>;
    })}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }} disabled={rows.length >= view.products.length}
      onClick={() => setRows(items => [...items, blankRow(Math.max(...items.map(item => item.key)) + 1)])}>
      <Plus size={16} aria-hidden="true" />Adicionar produto</button>
    <h3>Despesas adicionais</h3>
    <p className="hint">As despesas de compra dos insumos entram sozinhas, pelo consumo. Adicione aqui o que for só desta ordem.</p>
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
      <Select name="paymentMethodId" label="Forma de pagamento" required={false} options={view.paymentMethods} onChange={setPaymentId} />
      <label>Taxa (%)<input name="feePercent" inputMode="decimal" value={fee} placeholder={payment?.feePercent ?? '0'} onChange={event => setFee(event.target.value)} />
        <span className="hint">Vazio: usa a taxa da forma de pagamento.</span></label>
    </div>
    {sale && <p className="hint" role="status">Bruto {brl(sale.gross)} · Desconto {brl(sale.discount)} · Total {brl(sale.total)} · Taxa {brl(sale.fee)} · <strong>Líquido {brl(sale.net)}</strong></p>}
    <Field name="notes" label="Observação" required={false} placeholder="Pedido, cliente ou lote" />
  </Form>;
}
