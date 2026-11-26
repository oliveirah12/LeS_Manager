import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  api, baseUnit, brl, Form, Loading, message, Product, productOptions, quantity, Select, Unit, unitOptions, useClosePanel, useData,
} from './ui';

type Candidate = Pick<Product, 'id' | 'sku' | 'name' | 'active' | 'unit'> & { currentCost?: string | null };
type RecipeView = {
  wastePercent: string; inputs: { inputId: string; quantity: string }[]; candidates: Candidate[]; canSeeCost: boolean;
  printMinutes: string | null; printerId: string | null; printers: { id: string; name: string; active: boolean; hourCost?: string }[];
};
type Row = { key: number; inputId: string; unitId: string; quantity: string };
const number = (value: string) => Number(value.replace(',', '.'));

export function RecipeEditor({ product, units, saved }: { product: Product; units: Unit[]; saved: () => Promise<void> }) {
  const { data, error, loading } = useData<RecipeView>('catalog/products/' + product.id + '/recipe');
  return <>
    {message(error)}
    {!data ? loading && <Loading label="Carregando ficha técnica…" /> : <RecipeForm product={product} view={data} units={units} saved={saved} />}
  </>;
}

function RecipeForm({ product, view, units, saved }: { product: Product; view: RecipeView; units: Unit[]; saved: () => Promise<void> }) {
  const [waste, setWaste] = useState(Number(view.wastePercent) ? view.wastePercent : '');
  const [minutes, setMinutes] = useState(view.printMinutes ?? '');
  const [printerId, setPrinterId] = useState(view.printerId ?? '');
  const [rows, setRows] = useState<Row[]>(() => view.inputs.map((item, key) => {
    const input = view.candidates.find(row => row.id === item.inputId);
    return { key, inputId: item.inputId, unitId: input ? baseUnit(input).id : '', quantity: item.quantity };
  }));
  const closePanel = useClosePanel();
  const update = (key: number, change: Partial<Row>) => setRows(items => items.map(item => item.key === key ? { ...item, ...change } : item));
  const factor = 1 + (number(waste) || 0) / 100;
  // Display only: the production order computes the stored cost with exact decimals.
  const preview = rows.map(row => {
    const input = view.candidates.find(item => item.id === row.inputId);
    const unit = units.find(item => item.id === row.unitId);
    const amount = number(row.quantity);
    if (!input || !unit || !(amount > 0)) return null;
    const consumed = amount * Number(unit.factor) * factor;
    return { consumed, symbol: baseUnit(input).symbol, cost: input.currentCost == null ? null : consumed * Number(input.currentCost) };
  });
  const missingCost = preview.some(item => item?.cost === null);
  const total = preview.reduce((sum, item) => sum + (item?.cost ?? 0), 0);
  const hourCost = view.printers.find(printer => printer.id === printerId)?.hourCost;
  const machine = hourCost && number(minutes) > 0 ? Number(hourCost) * number(minutes) / 60 : null;

  return <Form label="Salvar ficha técnica" cancel="Cancelar" action={async () => {
    await api('catalog/products/' + product.id + '/recipe', {
      wastePercent: waste.trim() || '0', inputs: rows.map(({ inputId, unitId, quantity: amount }) => ({ inputId, unitId, quantity: amount })),
      printMinutes: minutes.trim() || null, printerId: printerId || null,
    }, 'PUT');
    await saved();
    closePanel?.();
  }}>
    <p className="hint">Informe o consumo para fabricar <strong>1 {baseUnit(product).symbol}</strong> de {product.name}.</p>
    {!view.candidates.length && <div className="info">Nenhum produto ativo é de um tipo usado como insumo. Cadastre o filamento antes de montar a ficha.</div>}
    {rows.map((row, index) => {
      const input = view.candidates.find(item => item.id === row.inputId);
      const options = view.candidates.filter(item => item.id === row.inputId || !rows.some(other => other.inputId === item.id));
      const line = preview[index];
      return <div className="stack" style={{ gap: 4 }} key={row.key}>
        <div className="component-row">
          <Select name={'input' + row.key} label={'Insumo ' + (index + 1)} defaultValue={row.inputId} options={productOptions(options as Product[])}
            onChange={id => {
              const chosen = view.candidates.find(item => item.id === id);
              update(row.key, { inputId: id, unitId: chosen ? baseUnit(chosen).id : '' });
            }} />
          <label>Quantidade<input name={'quantity' + row.key} inputMode="decimal" required value={row.quantity}
            onChange={event => update(row.key, { quantity: event.target.value })} /></label>
          <Select key={row.inputId} name={'unit' + row.key} label="Unidade" defaultValue={row.unitId}
            options={unitOptions(units.filter(unit => unit.familyId === input?.unit.familyId))} onChange={unitId => update(row.key, { unitId })} />
          <button type="button" className="icon-button" aria-label={'Remover insumo ' + (index + 1)}
            onClick={() => setRows(items => items.filter(item => item.key !== row.key))}><Trash2 size={18} aria-hidden="true" /></button>
        </div>
        {line && <span className="hint">Consome <strong className="num">{quantity(String(line.consumed))} {line.symbol}</strong>
          {view.canSeeCost && <> · {line.cost === null ? 'sem custo registrado' : <strong className="num">{brl(line.cost)}</strong>}</>}</span>}
      </div>;
    })}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }} disabled={rows.length >= view.candidates.length}
      onClick={() => setRows(items => [...items, { key: Math.max(-1, ...items.map(item => item.key)) + 1, inputId: '', unitId: '', quantity: '' }])}>
      <Plus size={16} aria-hidden="true" />Adicionar insumo</button>
    <label>Perda de material (%)
      <input name="wastePercent" inputMode="decimal" placeholder="0" value={waste} onChange={event => setWaste(event.target.value)} />
      <span className="hint">Opcional. Cobre suportes, purga e sobras previstas em cada peça.</span>
    </label>
    <div className="form-grid">
      <label>Tempo de impressão por {baseUnit(product).symbol} (min)
        <input name="printMinutes" inputMode="decimal" placeholder="Ex.: 45" value={minutes} onChange={event => setMinutes(event.target.value)} />
        <span className="hint">Opcional. Soma o custo da máquina ao preço e sugere o tempo da ordem.</span>
      </label>
      <Select name="printerId" label="Impressora padrão" required={false} placeholder="Sem impressora" defaultValue={printerId}
        options={view.printers.map(printer => ({ id: printer.id, name: printer.name + (printer.active ? '' : ' (inativa)') }))} onChange={setPrinterId} />
    </div>
    {view.canSeeCost && (preview.some(Boolean) || machine !== null) && <div className="info">
      Custo de insumos por {baseUnit(product).symbol}: <strong className="num">{brl(total)}</strong>
      {missingCost && ' (parcial, há insumo sem custo registrado)'}
      {machine !== null && <> · máquina e energia: <strong className="num">{brl(machine)}</strong> · total: <strong className="num">{brl(total + machine)}</strong></>}
    </div>}
  </Form>;
}
