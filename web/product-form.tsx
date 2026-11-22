import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { marginShortfall, suggestedPrice } from './format';
import { api, brl, Field, Form, Loading, message, Product, quantity, useClosePanel, useData } from './ui';

export type MeasureRow = { key: number; name: string; value: string; unit: string };
export const measureRows = (product?: Product | null): MeasureRow[] => (product?.measures ?? []).map((row, key) => ({ ...row, key }));

/** Technical part of the product payload. An empty field clears the stored value. */
export function technicalPayload(input: Record<string, string>, rows: MeasureRow[]) {
  return {
    lengthMm: input.lengthMm || null, widthMm: input.widthMm || null, heightMm: input.heightMm || null, diameterMm: input.diameterMm || null,
    purchaseUrl: input.purchaseUrl?.trim() || null,
    measures: rows.map(({ key }) => ({ name: input['measureName' + key], value: input['measureValue' + key], unit: input['measureUnit' + key] })),
  };
}

export function TechnicalFields({ product, rows, setRows }: {
  product?: Product | null; rows: MeasureRow[]; setRows: (update: (rows: MeasureRow[]) => MeasureRow[]) => void;
}) {
  const dimension = (name: 'lengthMm' | 'widthMm' | 'heightMm' | 'diameterMm', label: string) =>
    <Field name={name} label={label} inputMode="decimal" required={false} defaultValue={product?.[name] ?? undefined} />;
  return <>
    <div className="form-grid">
      {dimension('lengthMm', 'Comprimento (mm)')}
      {dimension('widthMm', 'Largura (mm)')}
      {dimension('heightMm', 'Altura (mm)')}
      {dimension('diameterMm', 'Diâmetro (mm)')}
    </div>
    <Field name="purchaseUrl" label="URL de compra" type="url" required={false} placeholder="https://" defaultValue={product?.purchaseUrl ?? undefined} />
    {rows.map((row, index) => <div className="component-row" key={row.key}>
      <Field name={'measureName' + row.key} label={'Medida ' + (index + 1)} placeholder="Ex.: Passo da rosca" defaultValue={row.name} />
      <Field name={'measureValue' + row.key} label="Valor" inputMode="decimal" defaultValue={row.value} />
      <Field name={'measureUnit' + row.key} label="Unidade" placeholder="mm" defaultValue={row.unit} />
      <button type="button" className="icon-button" aria-label={'Remover medida ' + (index + 1)}
        onClick={() => setRows(items => items.filter(item => item.key !== row.key))}><Trash2 size={18} aria-hidden="true" /></button>
    </div>)}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }}
      onClick={() => setRows(items => [...items, { key: Math.max(-1, ...items.map(item => item.key)) + 1, name: '', value: '', unit: '' }])}>
      <Plus size={16} aria-hidden="true" />Adicionar medida</button>
  </>;
}

type CommercialValues = { id: string; symbol: string; currentCost: string | null; minStock: string | null; salePrice: string | null; marginPercent: string | null };

/** Minimum, margin and price. The margin only suggests a price: what is saved is the price the person confirms. */
export function CommercialForm({ product, saved, closeOnSave = false }: { product: CommercialValues; saved: () => Promise<void>; closeOnSave?: boolean }) {
  const [margin, setMargin] = useState(product.marginPercent ?? '');
  const [price, setPrice] = useState(product.salePrice ?? '');
  const closePanel = useClosePanel();
  const suggestion = suggestedPrice(product.currentCost, margin);
  const shortfall = marginShortfall(price, product.currentCost, margin);
  return <Form label="Salvar estoque e venda" cancel={closeOnSave ? 'Cancelar' : undefined} action={async values => {
    await api('stock/products/' + product.id + '/settings', {
      minStock: String(values.get('minStock') ?? '').trim() || null, salePrice: price.trim() || null, marginPercent: margin.trim() || null,
    }, 'PATCH');
    await saved();
    if (closeOnSave) closePanel?.();
  }}>
    <Field name="minStock" label={'Estoque mínimo (' + product.symbol + ')'} inputMode="decimal" required={false}
      defaultValue={product.minStock ?? undefined} hint="Vazio: sem alerta. O aviso compara com o saldo livre, sem o que está reservado." />
    <div className="form-grid">
      <label>Margem desejada (%)
        <input name="marginPercent" inputMode="decimal" value={margin} onChange={event => setMargin(event.target.value)} />
        <span className="hint">Parte do preço que fica como lucro.</span>
      </label>
      <label>{'Preço de venda por ' + product.symbol + ' (R$)'}
        <input name="salePrice" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} />
        <span className="hint">Custo médio atual: {brl(product.currentCost)}</span>
      </label>
    </div>
    {suggestion && <div className="section-head">
      <span>Preço sugerido: <strong className="num">{brl(suggestion)}</strong></span>
      <button type="button" className="btn secondary small" onClick={() => setPrice(suggestion)}>Usar sugestão</button>
    </div>}
    {shortfall && <div className="info" role="alert">A margem real é de <strong>{quantity(shortfall)}%</strong>, abaixo da desejada de {quantity(margin.replace(',', '.'))}%.</div>}
  </Form>;
}

type CommercialDetails = { symbol: string; stock: { currentCost: string | null; minStock: string | null; salePrice: string | null; marginPercent: string | null } | null };

export function CommercialSection({ id, saved }: { id: string; saved: () => Promise<void> }) {
  const { data, error, loading } = useData<CommercialDetails>('catalog/products/' + id + '/details');
  return <section className="preview-box">
    <div className="section-head"><h3>Estoque e venda</h3></div>
    {message(error)}
    {!data ? loading && <Loading label="Carregando valores…" />
      : data.stock && <CommercialForm product={{ id, symbol: data.symbol, ...data.stock }} saved={saved} />}
  </section>;
}
