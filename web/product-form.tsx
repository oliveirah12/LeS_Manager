import { Plus, Trash2 } from 'lucide-react';
import { PricingSection } from './pricing';
import { Field, Product } from './ui';

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

export function CommercialSection({ id, saved }: { id: string; saved: () => Promise<void> }) {
  return <section className="preview-box">
    <div className="section-head"><h3>Formação de preço</h3></div>
    <PricingSection id={id} saved={saved} />
  </section>;
}
