import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { saleEstimate, suggestedMinutes } from './format';
import { blankLine, ExpenseLines, ExpenseRow, LineRow, ProductLines, SaleFields } from './order-sections';
import type { Quote, QuotesView } from './quote-types';
import { api, Field, Form, Select, today, useClosePanel } from './ui';

type DetailRow = { key: number; label: string; value: string };

/** Calendar day `days` after today in Brasília, as the API suggests it. */
function validitySuggestion(days: number) {
  const date = new Date(today() + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const wholeOrNull = (text: string, label: string) => {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new Error('Informe ' + label + ' em números inteiros maiores que zero.');
  return value;
};

/** Creates a quote or, when one is given, edits it while it is a draft or sent. */
export function QuoteForm({ view, quote, seeCosts, done }: { view: QuotesView; quote?: Quote; seeCosts: boolean; done: (text: string) => Promise<void> }) {
  const [rows, setRows] = useState<LineRow[]>(() => quote ? quote.items.map((item, key) => ({
    key, productId: item.productId, quantity: item.quantity, salePrice: item.salePrice, marginPercent: item.marginPercent ?? '',
  })) : [blankLine(0)]);
  const [details, setDetails] = useState<DetailRow[]>(() => (quote?.details ?? []).map((row, key) => ({ key, ...row })));
  const [expenses, setExpenses] = useState<ExpenseRow[]>(() => (quote?.expenses ?? []).map((row, key) => ({ key, ...row })));
  const [hours, setHours] = useState(() => quote && quote.estimatedMinutes >= 60 ? String(Math.floor(quote.estimatedMinutes / 60)) : '');
  const [minutes, setMinutes] = useState(() => quote && quote.estimatedMinutes % 60 ? String(quote.estimatedMinutes % 60) : '');
  const [discount, setDiscount] = useState(() => quote && Number(quote.discountPercent) > 0 ? quote.discountPercent : '');
  const [paymentId, setPaymentId] = useState(quote?.paymentMethodId ?? '');
  const [fee, setFee] = useState(() => quote?.customFee ? quote.feePercent : '');
  const closePanel = useClosePanel();
  const estimatedMinutes = Number(hours || 0) * 60 + Number(minutes || 0);
  // A quote may keep a printer, method or product that has since left the active lists.
  const printers = quote && !view.printers.some(row => row.id === quote.printer.id) ? [...view.printers, quote.printer] : view.printers;
  const payments = quote?.paymentMethodId && !view.paymentMethods.some(row => row.id === quote.paymentMethodId)
    ? [...view.paymentMethods, { id: quote.paymentMethodId, name: quote.paymentName ?? 'Forma inativa', feePercent: quote.feePercent }] : view.paymentMethods;
  const products = [...view.products, ...(quote?.items ?? []).filter(item => !view.products.some(row => row.id === item.productId))
    .map(item => ({ id: item.productId, sku: item.sku, name: item.name, symbol: item.symbol, salePrice: item.salePrice, marginPercent: item.marginPercent }))];
  const payment = payments.find(method => method.id === paymentId);
  const sale = saleEstimate(rows, discount, fee.trim() ? fee : payment?.feePercent ?? '0');
  const timeSuggestion = !hours.trim() && !minutes.trim()
    ? suggestedMinutes(rows.filter(row => row.productId).map(row => ({ quantity: row.quantity, printMinutes: view.products.find(item => item.id === row.productId)?.printMinutes })))
    : null;
  const changeDetail = (key: number, values: Partial<DetailRow>) => setDetails(items => items.map(item => item.key === key ? { ...item, ...values } : item));
  if (!quote && (!view.printers.length || !view.products.length)) return <div className="info">
    {!view.printers.length ? 'Cadastre uma impressora ativa em Produção → Impressoras.' : 'Monte a ficha técnica de um produto fabricado em Cadastros → Produtos.'}
  </div>;
  return <Form label={quote ? 'Salvar alterações' : 'Criar orçamento'} cancel="Cancelar" action={async values => {
    if (!Number.isInteger(estimatedMinutes) || estimatedMinutes <= 0) throw new Error('Informe o tempo de impressão em horas e minutos inteiros.');
    const text = (name: string) => String(values.get(name) ?? '');
    await api('quotes' + (quote ? '/' + quote.id : ''), {
      customerName: text('customerName'), customerContact: text('customerContact'), title: text('title'), description: text('description'),
      details: details.map(({ label, value }) => ({ label, value })),
      printPlates: wholeOrNull(text('printPlates'), 'as placas'), deliveryDays: wholeOrNull(text('deliveryDays'), 'o prazo de entrega'),
      estimatedMinutes, validUntil: text('validUntil'), printerId: text('printerId'), notes: text('notes'),
      manualExpenses: expenses.map(({ title, value }) => ({ title, value })),
      discountPercent: discount.trim() || '0', paymentMethodId: paymentId || null, feePercent: fee.trim() || null,
      items: rows.map(row => ({
        productId: row.productId, quantity: row.quantity, salePrice: row.salePrice.trim(),
        ...(seeCosts ? { marginPercent: row.marginPercent.trim() || null } : {}),
      })),
    }, quote ? 'PATCH' : 'POST');
    await done(quote ? 'Orçamento atualizado.' : 'Orçamento criado.');
    closePanel?.();
  }}>
    <h3>Cliente</h3>
    <div className="form-grid">
      <Field name="customerName" label="Nome" defaultValue={quote?.customerName} />
      <Field name="customerContact" label="Contato" required={false} placeholder="Telefone, e-mail ou rede social" defaultValue={quote?.customerContact ?? undefined} />
    </div>
    <h3>Pedido</h3>
    <Field name="title" label="Título" placeholder="Estatueta decorativa" defaultValue={quote?.title} />
    <label>Descrição<textarea name="description" rows={3} maxLength={2000} defaultValue={quote?.description ?? undefined} />
      <span className="hint">Aparece no PDF, abaixo do título.</span></label>
    <ProductLines rows={rows} setRows={setRows} products={products} estimates={quote?.budget?.items} seeCosts={seeCosts} scope="este orçamento" priceRequired />
    <h3>Detalhes para o cliente</h3>
    <p className="hint">Linhas livres da tabela do PDF, como tamanho, cores e personalização.</p>
    {details.map((row, index) => <div className="component-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) auto' }} key={row.key}>
      <label>Descrição<input aria-label={'Descrição do detalhe ' + (index + 1)} required maxLength={60} value={row.label} placeholder="Tamanho"
        onChange={event => changeDetail(row.key, { label: event.target.value })} /></label>
      <label>Detalhe<input aria-label={'Detalhe ' + (index + 1)} required maxLength={300} value={row.value} placeholder="15 cm de altura"
        onChange={event => changeDetail(row.key, { value: event.target.value })} /></label>
      <button type="button" className="icon-button" aria-label={'Remover detalhe ' + (index + 1)}
        onClick={() => setDetails(items => items.filter(item => item.key !== row.key))}><Trash2 size={18} aria-hidden="true" /></button>
    </div>)}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }} disabled={details.length >= 20}
      onClick={() => setDetails(items => [...items, { key: Math.max(-1, ...items.map(item => item.key)) + 1, label: '', value: '' }])}>
      <Plus size={16} aria-hidden="true" />Adicionar detalhe</button>
    <h3>Produção e prazo</h3>
    <Select name="printerId" label="Impressora" options={printers} defaultValue={quote?.printer.id} />
    <div className="form-grid">
      <label>Tempo de impressão (horas)<input name="hours" inputMode="numeric" placeholder="10" value={hours} onChange={event => setHours(event.target.value)} /></label>
      <label>Minutos<input name="minutes" inputMode="numeric" placeholder="0" value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
      <Field name="printPlates" label="Placas de impressão" inputMode="numeric" required={false} defaultValue={quote?.printPlates?.toString()} />
    </div>
    {timeSuggestion !== null && <div className="section-head">
      <span className="hint">Pela ficha técnica: <strong>{Math.floor(timeSuggestion / 60)} h {timeSuggestion % 60} min</strong></span>
      <button type="button" className="btn secondary small" onClick={() => {
        setHours(String(Math.floor(timeSuggestion / 60)));
        setMinutes(timeSuggestion % 60 ? String(timeSuggestion % 60) : '');
      }}>Usar sugestão</button>
    </div>}
    <div className="form-grid">
      <Field name="deliveryDays" label="Prazo de entrega (dias)" inputMode="numeric" required={false} defaultValue={quote?.deliveryDays?.toString()} />
      <Field name="validUntil" label="Válido até" type="date" defaultValue={quote?.validUntil ?? validitySuggestion(view.quoteValidityDays)}
        hint={quote ? undefined : 'Sugerido pelo cadastro da empresa: ' + view.quoteValidityDays + ' dias.'} />
    </div>
    <h3>Despesas</h3>
    <p className="hint">As despesas de compra dos insumos entram sozinhas no custo. Adicione aqui o que for só deste orçamento. O cliente não vê despesas.</p>
    <ExpenseLines expenses={expenses} setExpenses={setExpenses} />
    <h3>Venda</h3>
    <SaleFields discount={discount} setDiscount={setDiscount} payments={payments} paymentId={paymentId} setPaymentId={setPaymentId} fee={fee} setFee={setFee} sale={sale} />
    <Field name="notes" label="Observação interna" required={false} placeholder="Não aparece no PDF" defaultValue={quote?.notes ?? undefined} />
  </Form>;
}
