import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  api, baseUnit, brl, Form, Loading, message, Product, productOptions, quantity, Select, Unit, unitOptions, useClosePanel, useData,
} from './ui';

type Candidate = Pick<Product, 'id' | 'sku' | 'name' | 'active' | 'unit'> & { currentCost?: string | null; typeId: string; groupId: string | null; colorId: string | null };
type ColorKey = { typeId: string; groupId: string | null; colorId: string };
/** A color offered by today's active inputs. Brands counts how many of them can fill it. */
type ColorOption = ColorKey & { familyId: string; label: string; brands: number; averageCost?: string | null };
export type RecipeView = {
  wastePercent: string; inputs: { inputId: string; quantity: string }[]; candidates: Candidate[]; canSeeCost: boolean;
  colorInputs: (ColorKey & { familyId: string; label: string; quantity: string })[]; colors: ColorOption[];
  printMinutes: string | null; printerId: string | null; printers: { id: string; name: string; active: boolean; hourCost?: string }[];
};
type Row = { key: number; inputId: string; unitId: string; quantity: string };
/** A line that accepts any brand of a color. The color is kept as its key, so it can be compared without a saved id. */
type ColorRow = { key: number; color: string; unitId: string; quantity: string };
/** What the person typed in the recipe, before it is saved. */
export type RecipeDraft = { waste: string; minutes: string; printerId: string; rows: Row[]; colorRows: ColorRow[] };
export const colorKey = (row: ColorKey) => [row.typeId, row.groupId ?? '', row.colorId].join('|');
const nextKey = (rows: { key: number }[]) => Math.max(-1, ...rows.map(item => item.key)) + 1;
const baseOf = (units: Unit[], familyId: string) => units.find(unit => unit.familyId === familyId && unit.isBase);
const number = (value: string) => Number(value.replace(',', '.'));

/** A saved product loads its recipe; a product not saved yet loads only what it can use. */
export const recipePath = (productId?: string) => productId ? 'catalog/products/' + productId + '/recipe' : 'catalog/recipe-options';

export const recipeDraft = (view: RecipeView, units: Unit[]): RecipeDraft => ({
  colorRows: view.colorInputs.map((item, key) => ({ key, color: colorKey(item), unitId: baseOf(units, item.familyId)?.id ?? '', quantity: item.quantity })),
  waste: Number(view.wastePercent) ? view.wastePercent : '', minutes: view.printMinutes ?? '', printerId: view.printerId ?? '',
  rows: view.inputs.map((item, key) => {
    const input = view.candidates.find(row => row.id === item.inputId);
    return { key, inputId: item.inputId, unitId: input ? baseUnit(input).id : '', quantity: item.quantity };
  }),
});

export const recipePayload = (draft: RecipeDraft) => ({
  wastePercent: draft.waste.trim() || '0', inputs: draft.rows.map(({ inputId, unitId, quantity: amount }) => ({ inputId, unitId, quantity: amount })),
  colorInputs: draft.colorRows.map(({ color, unitId, quantity: amount }) => {
    const [typeId, groupId, colorId] = color.split('|');
    return { typeId, groupId: groupId || null, colorId, unitId, quantity: amount };
  }),
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
  // A color is estimated at the average of its brands. The order later uses the cost of the brand it takes.
  const colorLines = draft.colorRows.map(row => {
    const option = view.colors.find(item => colorKey(item) === row.color);
    const unit = units.find(item => item.id === row.unitId);
    const amount = number(row.quantity);
    if (!option || !unit || !(amount > 0)) return null;
    const consumed = amount * Number(unit.factor) * factor;
    return { consumed, cost: option.averageCost == null ? null : consumed * Number(option.averageCost) };
  });
  const all = [...lines, ...colorLines];
  const hourCost = view.printers.find(printer => printer.id === draft.printerId)?.hourCost;
  return {
    lines, colorLines, material: all.reduce((sum, line) => sum + (line?.cost ?? 0), 0), partial: all.some(line => line?.cost === null),
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
  const [draft, setDraft] = useState(() => recipeDraft(view, units));
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
  const { rows, colorRows } = draft;
  const setRows = (update: (rows: Row[]) => Row[]) => change(current => ({ ...current, rows: update(current.rows) }));
  const update = (key: number, edit: Partial<Row>) => setRows(items => items.map(item => item.key === key ? { ...item, ...edit } : item));
  const setColorRows = (update: (rows: ColorRow[]) => ColorRow[]) => change(current => ({ ...current, colorRows: update(current.colorRows) }));
  const updateColor = (key: number, edit: Partial<ColorRow>) => setColorRows(items => items.map(item => item.key === key ? { ...item, ...edit } : item));
  const colorOf = (input?: Candidate) => input?.colorId ? view.colors.find(option => option.familyId === input.unit.familyId
    && colorKey(option) === colorKey({ typeId: input.typeId, groupId: input.groupId, colorId: input.colorId! })) : undefined;
  // Moves an exact input to its color, keeping what was typed, so the recipe accepts any brand of it.
  const anyBrand = (row: Row, option: ColorOption) => change(current => ({
    ...current, rows: current.rows.filter(item => item.key !== row.key),
    colorRows: [...current.colorRows, { key: nextKey(current.colorRows), color: colorKey(option), unitId: row.unitId, quantity: row.quantity }],
  }));
  const cost = recipeCost(view, draft, units);
  return <>
    <p className="hint">Informe o consumo para fabricar <strong>1 {symbol}</strong> {name ? 'de ' + name : 'deste produto'}.</p>
    {!view.candidates.length && <div className="info">Nenhum produto ativo é de um tipo usado como insumo. Cadastre o filamento antes de montar a ficha.</div>}
    {rows.map((row, index) => {
      const input = view.candidates.find(item => item.id === row.inputId);
      const options = view.candidates.filter(item => item.id === row.inputId || !rows.some(other => other.inputId === item.id));
      const line = cost.lines[index];
      const color = colorOf(input);
      const colorTaken = color && colorRows.some(item => item.color === colorKey(color));
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
        {color && !colorTaken && <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }} onClick={() => anyBrand(row, color)}>
          Aceitar qualquer marca de {color.label}</button>}
      </div>;
    })}
    {colorRows.map((row, index) => {
      const option = view.colors.find(item => colorKey(item) === row.color);
      const options = view.colors.filter(item => colorKey(item) === row.color || !colorRows.some(other => other.color === colorKey(item)));
      const line = cost.colorLines[index];
      return <div className="stack" style={{ gap: 4 }} key={'color' + row.key}>
        <div className="component-row">
          <Select name={'recipeColor' + row.key} label={'Por cor ' + (index + 1)} defaultValue={row.color}
            options={options.map(item => ({ id: colorKey(item), name: item.label + ' · ' + (item.brands === 1 ? '1 marca' : item.brands + ' marcas') }))}
            onChange={color => updateColor(row.key, { color, unitId: baseOf(units, view.colors.find(item => colorKey(item) === color)?.familyId ?? '')?.id ?? '' })} />
          <label>Quantidade<input name={'recipeColorQuantity' + row.key} inputMode="decimal" required value={row.quantity}
            onChange={event => updateColor(row.key, { quantity: event.target.value })} /></label>
          <Select key={row.color} name={'recipeColorUnit' + row.key} label="Unidade" defaultValue={row.unitId}
            options={unitOptions(units.filter(item => item.familyId === option?.familyId))} onChange={unitId => updateColor(row.key, { unitId })} />
          <button type="button" className="icon-button" aria-label={'Remover cor ' + (index + 1)}
            onClick={() => setColorRows(items => items.filter(item => item.key !== row.key))}><Trash2 size={18} aria-hidden="true" /></button>
        </div>
        {option && <span className="hint">{line && <>Consome <strong className="num">{quantity(String(line.consumed))} {baseOf(units, option.familyId)?.symbol}</strong> · </>}
          {line && view.canSeeCost && <>{line.cost === null ? 'sem custo registrado' : <>média das marcas <strong className="num">{brl(line.cost)}</strong></>} · </>}
          {option.brands ? 'a ordem escolhe a marca' : 'nenhuma marca ativa desta cor no momento'}</span>}
      </div>;
    })}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }} disabled={rows.length >= view.candidates.length}
      onClick={() => setRows(items => [...items, { key: nextKey(items), inputId: '', unitId: '', quantity: '' }])}>
      <Plus size={16} aria-hidden="true" />Adicionar insumo</button>
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }} disabled={colorRows.length >= view.colors.length}
      onClick={() => setColorRows(items => [...items, { key: nextKey(items), color: '', unitId: '', quantity: '' }])}>
      <Plus size={16} aria-hidden="true" />Adicionar por cor</button>
    {view.colors.length > 0 && <span className="hint">Por cor aceita qualquer marca do mesmo tipo, grupo e cor. A ordem de produção escolhe qual usar.</span>}
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
    {view.canSeeCost && ([...cost.lines, ...cost.colorLines].some(Boolean) || cost.machine !== null) && <div className="info">
      Custo de insumos por {symbol}: <strong className="num">{brl(cost.material)}</strong>
      {cost.partial && ' (parcial, há insumo sem custo registrado)'}
      {cost.machine !== null && <> · máquina e energia: <strong className="num">{brl(cost.machine)}</strong> · total: <strong className="num">{brl(cost.material + cost.machine)}</strong></>}
    </div>}
  </>;
}
