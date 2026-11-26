import { useState } from 'react';
import { saleEstimate, suggestedMinutes } from './format';
import { blankLine, ExpenseLines, LineRow, ProductLines, SaleFields } from './order-sections';
import type { Order, OrderInput, OrdersView } from './orders';
import { localValue } from './slots';
import { StartPicker } from './start-picker';
import { Plus, Trash2 } from 'lucide-react';
import { api, brl, dateTime, Field, Form, quantity, Select, useClosePanel } from './ui';

type Brand = { key: number; inputId: string; planned: string };
/** The brands of one recipe color across the order, with what each one takes. */
type ColorGroup = { id: string; label: string; symbol: string; familyId: string; typeId: string; groupId: string | null; colorId: string; brands: { inputId: string; planned: number }[] };

/** Groups the color lines of the order by color, keeping only the products still in the form. */
function colorGroups(inputs: OrderInput[], productIds: string[]) {
  const groups = new Map<string, ColorGroup>();
  for (const input of inputs) {
    for (const part of input.parts) {
      if (!part.colorInputId || !productIds.includes(part.productId)) continue;
      const color = input.colors.find(item => item.id === part.colorInputId)!;
      const group = groups.get(color.id) ?? { ...color, symbol: input.symbol, familyId: input.familyId, brands: [] };
      const brand = group.brands.find(item => item.inputId === input.inputId);
      if (brand) brand.planned += Number(part.planned);
      else group.brands.push({ inputId: input.inputId, planned: Number(part.planned) });
      groups.set(color.id, group);
    }
  }
  return [...groups.values()];
}

/** The exact part of each input: what the recipe names directly, outside any color. */
function exactInputs(inputs: OrderInput[], productIds: string[]) {
  return inputs.map(input => {
    const parts = input.parts.filter(part => !part.colorInputId && productIds.includes(part.productId));
    return { ...input, planned: String(parts.reduce((sum, part) => sum + Number(part.planned), 0)), parts };
  }).filter(input => input.parts.length > 0);
}

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
  // Only a color the person touched is sent. Its brands then replace the ones in the order.
  const [splits, setSplits] = useState<Record<string, Brand[]>>({});
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
  const productIds = rows.map(row => row.productId);
  const orderInputs = exactInputs(order?.inputs ?? [], productIds);
  const colors = colorGroups(order?.inputs ?? [], productIds);
  const inputExpenses = (order?.expenses ?? []).filter(row => row.source === 'INPUT' && (order?.inputs ?? []).some(input => input.inputId === row.inputId
    && input.parts.some(part => productIds.includes(part.productId))));
  const brandsOf = (group: ColorGroup) => splits[group.id] ?? group.brands.map((brand, key) => ({ key, inputId: brand.inputId, planned: String(brand.planned) }));
  const setBrands = (group: ColorGroup, update: (brands: Brand[]) => Brand[]) => setSplits(items => ({ ...items, [group.id]: update(items[group.id] ?? brandsOf(group)) }));
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
      colorSplits: colors.filter(group => splits[group.id]).map(group => ({
        colorInputId: group.id, lines: splits[group.id].map(brand => ({ inputId: brand.inputId, planned: brand.planned.trim() })),
      })),
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
    {colors.length > 0 && <>
      <h3>Insumos por cor</h3>
      <p className="hint">Escolha a marca de cada cor ou divida entre marcas. Cada produto mantém sua parte da cor.</p>
      {colors.map(group => {
        const brands = brandsOf(group);
        const options = view.inputs.filter(item => item.familyId === group.familyId && item.typeId === group.typeId
          && item.groupId === group.groupId && item.colorId === group.colorId);
        const total = brands.reduce((sum, brand) => sum + (Number(brand.planned.replace(',', '.')) || 0), 0);
        return <div className="stack" style={{ gap: 4 }} key={group.id}>
          <strong>{group.label}</strong>
          {brands.map((brand, index) => <div className="component-row" key={brand.key}>
            <Select name={'brand' + group.id + brand.key} label={'Marca ' + (index + 1)} defaultValue={brand.inputId}
              options={options.filter(item => item.id === brand.inputId || !brands.some(other => other.inputId === item.id)).map(item => ({ id: item.id, name: item.sku + ' · ' + item.name }))}
              onChange={inputId => setBrands(group, items => items.map(item => item.key === brand.key ? { ...item, inputId } : item))} />
            <label>{'Quantidade (' + group.symbol + ')'}<input aria-label={'Quantidade da marca ' + (index + 1) + ' de ' + group.label} inputMode="decimal" required value={brand.planned}
              onChange={event => setBrands(group, items => items.map(item => item.key === brand.key ? { ...item, planned: event.target.value } : item))} /></label>
            <button type="button" className="icon-button" aria-label={'Remover marca ' + (index + 1) + ' de ' + group.label} disabled={brands.length === 1}
              onClick={() => setBrands(group, items => items.filter(item => item.key !== brand.key))}><Trash2 size={18} aria-hidden="true" /></button>
          </div>)}
          <div className="section-head">
            <span className="hint">Total da cor: <strong className="num">{quantity(String(total))} {group.symbol}</strong></span>
            <button type="button" className="btn secondary small" disabled={brands.length >= options.length}
              onClick={() => setBrands(group, items => [...items, { key: Math.max(-1, ...items.map(item => item.key)) + 1, inputId: '', planned: '' }])}>
              <Plus size={16} aria-hidden="true" />Dividir com outra marca</button>
          </div>
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
