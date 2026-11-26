import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  api, baseUnit, brl, Form, Loading, message, Product, productOptions, quantity, Select, Unit, unitOptions, useClosePanel, useData,
} from './ui';

type Candidate = Pick<Product, 'id' | 'sku' | 'name' | 'active' | 'unit'> & { currentCost?: string | null };
export type RecipeView = {
  wastePercent: string; inputs: { inputId: string; quantity: string }[]; candidates: Candidate[]; canSeeCost: boolean;
  printMinutes: string | null; printerId: string | null; printers: { id: string; name: string; active: boolean; hourCost?: string }[];
};
type Row = { key: number; inputId: string; unitId: string; quantity: string };
/** What the person typed in the recipe, before it is saved. */
export type RecipeDraft = { waste: string; minutes: string; printerId: string; rows: Row[] };
const number = (value: string) => Number(value.replace(',', '.'));

/** A saved product loads its recipe; a product not saved yet loads only what it can use. */
export const recipePath = (productId?: string) => productId ? 'catalog/products/' + productId + '/recipe' : 'catalog/recipe-options';

export const recipeDraft = (view: RecipeView): RecipeDraft => ({
  waste: Number(view.wastePercent) ? view.wastePercent : '', minutes: view.printMinutes ?? '', printerId: view.printerId ?? '',
  rows: view.inputs.map((item, key) => {
    const input = view.candidates.find(row => row.id === item.inputId);
    return { key, inputId: item.inputId, unitId: input ? baseUnit(input).id : '', quantity: item.quantity };
  }),
});

export const recipePayload = (draft: RecipeDraft) => ({
  wastePercent: draft.waste.trim() || '0', inputs: draft.rows.map(({ inputId, unitId, quantity: amount }) => ({ inputId, unitId, quantity: amount })),
  printMinutes: draft.minutes.trim() || null, printerId: draft.printerId || null,
});

/** Display only: the API keeps the exact decimals. Null costs mean the person cannot see costs. */
export function recipeCost(view: RecipeView, draft: RecipeDraft, units: Unit[]) {
  const factor = 1 + (number(draft.waste) || 0) / 100;
  const lines = draft.rows.map(row => {
    const input = view.candidates.find(item => item.id === row.inputId);
    const unit = units.find(item => item.id === row.unitId);
    const amount = number(row.quantity);
    if (!input || !unit || !(amount > 0)) return null;
    const consumed = amount * Number(unit.factor) * factor;
    return { consumed, symbol: baseUnit(input).symbol, cost: input.currentCost == null ? null : consumed * Number(input.currentCost) };
  });
  const hourCost = view.printers.find(printer => printer.id === draft.printerId)?.hourCost;
  return {
    lines, material: lines.reduce((sum, line) => sum + (line?.cost ?? 0), 0), partial: lines.some(line => line?.cost === null),
    machine: hourCost && number(draft.minutes) > 0 ? Number(hourCost) * number(draft.minutes) / 60 : null,
  };
}

/** The recipe on its own, opened from the catalog table. */
export function RecipeEditor({ product, units, saved }: { product: Product; units: Unit[]; saved: () => Promise<void> }) {
  const { data, error, loading } = useData<RecipeView>(recipePath(product.id));
  return <>
    {message(error)}
    {!data ? loading && <Loading label="Carregando ficha técnica…" /> : <RecipeForm product={product} view={data} units={units} saved={saved} />}
  </>;
}

function RecipeForm({ product, view, units, saved }: { product: Product; view: RecipeView; units: Unit[]; saved: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => recipeDraft(view));
  const closePanel = useClosePanel();
  return <Form label="Salvar ficha técnica" cancel="Cancelar" action={async () => {
    await api(recipePath(product.id), recipePayload(draft), 'PUT');
    await saved();
    closePanel?.();
  }}>
    <RecipeFields view={view} draft={draft} change={setDraft} units={units} symbol={baseUnit(product).symbol} name={product.name} />
  </Form>;
}

/** The recipe fields, controlled by whoever saves them: the recipe editor or the product form. */
export function RecipeFields({ view, draft, change, units, symbol, name }: {
  view: RecipeView; draft: RecipeDraft; change: (update: (draft: RecipeDraft) => RecipeDraft) => void; units: Unit[]; symbol: string; name: string;
}) {
  const { rows } = draft;
  const setRows = (update: (rows: Row[]) => Row[]) => change(current => ({ ...current, rows: update(current.rows) }));
  const update = (key: number, edit: Partial<Row>) => setRows(items => items.map(item => item.key === key ? { ...item, ...edit } : item));
  const cost = recipeCost(view, draft, units);
  return <>
    <p className="hint">Informe o consumo para fabricar <strong>1 {symbol}</strong> {name ? 'de ' + name : 'deste produto'}.</p>
    {!view.candidates.length && <div className="info">Nenhum produto ativo é de um tipo usado como insumo. Cadastre o filamento antes de montar a ficha.</div>}
    {rows.map((row, index) => {
      const input = view.candidates.find(item => item.id === row.inputId);
      const options = view.candidates.filter(item => item.id === row.inputId || !rows.some(other => other.inputId === item.id));
      const line = cost.lines[index];
      return <div className="stack" style={{ gap: 4 }} key={row.key}>
        <div className="component-row">
          <Select name={'recipeInput' + row.key} label={'Insumo ' + (index + 1)} defaultValue={row.inputId} options={productOptions(options as Product[])}
            onChange={id => {
              const chosen = view.candidates.find(item => item.id === id);
              update(row.key, { inputId: id, unitId: chosen ? baseUnit(chosen).id : '' });
            }} />
          <label>Quantidade<input name={'recipeQuantity' + row.key} inputMode="decimal" required value={row.quantity}
            onChange={event => update(row.key, { quantity: event.target.value })} /></label>
          <Select key={row.inputId} name={'recipeUnit' + row.key} label="Unidade" defaultValue={row.unitId}
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
      <input name="wastePercent" inputMode="decimal" placeholder="0" value={draft.waste} onChange={event => change(current => ({ ...current, waste: event.target.value }))} />
      <span className="hint">Opcional. Cobre suportes, purga e sobras previstas em cada peça.</span>
    </label>
    <div className="form-grid">
      <label>Tempo de impressão por {symbol} (min)
        <input name="printMinutes" inputMode="decimal" placeholder="Ex.: 45" value={draft.minutes} onChange={event => change(current => ({ ...current, minutes: event.target.value }))} />
        <span className="hint">Opcional. Soma o custo da máquina ao preço e sugere o tempo da ordem.</span>
      </label>
      <Select name="printerId" label="Impressora padrão" required={false} placeholder="Sem impressora" defaultValue={draft.printerId}
        options={view.printers.map(printer => ({ id: printer.id, name: printer.name + (printer.active ? '' : ' (inativa)') }))}
        onChange={printerId => change(current => ({ ...current, printerId }))} />
    </div>
    {view.canSeeCost && (cost.lines.some(Boolean) || cost.machine !== null) && <div className="info">
      Custo de insumos por {symbol}: <strong className="num">{brl(cost.material)}</strong>
      {cost.partial && ' (parcial, há insumo sem custo registrado)'}
      {cost.machine !== null && <> · máquina e energia: <strong className="num">{brl(cost.machine)}</strong> · total: <strong className="num">{brl(cost.material + cost.machine)}</strong></>}
    </div>}
  </>;
}
