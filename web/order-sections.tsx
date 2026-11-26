import type { Dispatch, SetStateAction } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { brl, Select } from './ui';

/** Sections shared by the production order and the quote: products with price and margin, manual expenses and sale terms. */
export type LineRow = { key: number; productId: string; quantity: string; salePrice: string; marginPercent: string };
export const blankLine = (key: number): LineRow => ({ key, productId: '', quantity: '', salePrice: '', marginPercent: '' });
export type LineProduct = { id: string; sku: string; name: string; symbol: string; salePrice?: string | null; marginPercent?: string | null };
type Estimate = { productId: string; suggestedPrice: string | null; belowTargetMargin: boolean };
export type ExpenseRow = { key: number; title: string; value: string };
type PaymentOption = { id: string; name: string; feePercent: string | null };

/** Choosing a product brings its registered price and margin, which stay editable for this document only. */
export function ProductLines({ rows, setRows, products, estimates = [], seeCosts, scope, priceRequired = false }: {
  rows: LineRow[]; setRows: Dispatch<SetStateAction<LineRow[]>>; products: LineProduct[]; estimates?: Estimate[]; seeCosts: boolean;
  scope: string; priceRequired?: boolean;
}) {
  const change = (key: number, values: Partial<LineRow>) => setRows(items => items.map(item => item.key === key ? { ...item, ...values } : item));
  function choose(key: number, productId: string) {
    const product = products.find(item => item.id === productId);
    change(key, { productId, salePrice: product?.salePrice ?? '', marginPercent: product?.marginPercent ?? '' });
  }
  return <>
    {rows.map((row, index) => {
      const product = products.find(item => item.id === row.productId);
      const options = products.filter(item => item.id === row.productId || !rows.some(other => other.productId === item.id));
      const estimate = estimates.find(item => item.productId === row.productId);
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
          <label>Preço por unidade<input aria-label={'Preço do produto ' + (index + 1)} inputMode="decimal" required={priceRequired} value={row.salePrice}
            placeholder={priceRequired ? undefined : seeCosts ? 'Sem preço' : 'Preço do cadastro'} onChange={event => change(row.key, { salePrice: event.target.value })} />
            {estimate?.suggestedPrice && estimate.suggestedPrice !== row.salePrice && <button type="button" className="btn ghost small" style={{ alignSelf: 'flex-start' }}
              onClick={() => change(row.key, { salePrice: estimate.suggestedPrice! })}>Usar sugerido: {brl(estimate.suggestedPrice)}</button>}
            {estimate?.belowTargetMargin && <span className="hint">O preço está abaixo da margem desejada.</span>}</label>
          {seeCosts && <label>Margem desejada (%)<input aria-label={'Margem do produto ' + (index + 1)} inputMode="decimal" value={row.marginPercent}
            onChange={event => change(row.key, { marginPercent: event.target.value })} /><span className="hint">Vale só para {scope}.</span></label>}
        </div>
      </div>;
    })}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }} disabled={rows.length >= products.length}
      onClick={() => setRows(items => [...items, blankLine(Math.max(...items.map(item => item.key)) + 1)])}>
      <Plus size={16} aria-hidden="true" />Adicionar produto</button>
  </>;
}

export function ExpenseLines({ expenses, setExpenses }: { expenses: ExpenseRow[]; setExpenses: Dispatch<SetStateAction<ExpenseRow[]>> }) {
  const change = (key: number, values: Partial<ExpenseRow>) => setExpenses(items => items.map(item => item.key === key ? { ...item, ...values } : item));
  return <>
    {expenses.map((row, index) => <div className="component-row" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) auto' }} key={row.key}>
      <label>Título<input aria-label={'Título da despesa ' + (index + 1)} required maxLength={120} value={row.title} onChange={event => change(row.key, { title: event.target.value })} /></label>
      <label>Valor<input aria-label={'Valor da despesa ' + (index + 1)} required inputMode="decimal" value={row.value} onChange={event => change(row.key, { value: event.target.value })} /></label>
      <button type="button" className="icon-button" aria-label={'Remover despesa ' + (index + 1)}
        onClick={() => setExpenses(items => items.filter(item => item.key !== row.key))}><Trash2 size={18} aria-hidden="true" /></button>
    </div>)}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }}
      onClick={() => setExpenses(items => [...items, { key: Math.max(-1, ...items.map(item => item.key)) + 1, title: '', value: '' }])}>
      <Plus size={16} aria-hidden="true" />Adicionar despesa</button>
  </>;
}

/** Discount over the whole sale, the payment method and its fee, with the totals the API will compute. */
export function SaleFields({ discount, setDiscount, payments, paymentId, setPaymentId, fee, setFee, sale }: {
  discount: string; setDiscount: (value: string) => void; payments: PaymentOption[]; paymentId: string; setPaymentId: (value: string) => void;
  fee: string; setFee: (value: string) => void; sale: Record<'gross' | 'discount' | 'total' | 'fee' | 'net', string | number> | null;
}) {
  const payment = payments.find(method => method.id === paymentId);
  return <>
    <div className="form-grid">
      <label>Desconto sobre o total (%)<input name="discountPercent" inputMode="decimal" placeholder="0" value={discount} onChange={event => setDiscount(event.target.value)} /></label>
      <Select name="paymentMethodId" label="Forma de pagamento" required={false} options={payments} defaultValue={paymentId || undefined} onChange={setPaymentId} />
      <label>Taxa (%)<input name="feePercent" inputMode="decimal" value={fee} placeholder={payment?.feePercent ?? '0'} onChange={event => setFee(event.target.value)} />
        <span className="hint">Vazio: usa a taxa da forma de pagamento.</span></label>
    </div>
    {sale && <p className="hint" role="status">Bruto {brl(sale.gross)} · Desconto {brl(sale.discount)} · Total {brl(sale.total)} · Taxa {brl(sale.fee)} · <strong>Líquido {brl(sale.net)}</strong></p>}
  </>;
}
