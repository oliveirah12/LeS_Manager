import { ReactNode, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { costValue, type CostItem } from './costs';
import { marginShortfall, suggestedPrice } from './format';
import { api, brl, Form, Loading, message, quantity, Select, Table, useClosePanel, useData } from './ui';

export type LinkedCost = Pick<CostItem, 'id' | 'name' | 'mode' | 'base' | 'value' | 'active'>;
/** Where the base cost comes from: the recipe (inputs and machine) or the moving average. */
export type PricingBase = {
  symbol: string; source: 'RECIPE' | 'AVERAGE'; materialCost: string | null; partialCost: boolean; machineCost: string | null;
  printMinutes: string | null; printer: { name: string } | null; baseCost: string | null;
};
export type PricingView = PricingBase & {
  id: string; minStock: string | null; marginPercent: string | null; salePrice: string | null; costs: LinkedCost[]; options: LinkedCost[];
};
/** What the person typed in the price panel, before it is saved. */
export type PricingDraft = { minStock: string; margin: string; price: string; costs: LinkedCost[] };
const number = (value: string | null) => Number((value ?? '').replace(',', '.'));
const impossibleMessage = 'A margem somada aos custos sobre a venda chega a 100%. Reduza a margem ou os percentuais.';

export const pricingDraft = (view?: Pick<PricingView, 'minStock' | 'marginPercent' | 'salePrice' | 'costs'>): PricingDraft => ({
  minStock: view?.minStock ?? '', margin: view?.marginPercent ?? '', price: view?.salePrice ?? '', costs: view?.costs ?? [],
});

export const pricingPayload = (draft: PricingDraft) => ({
  minStock: draft.minStock.trim() || null, salePrice: draft.price.trim() || null, marginPercent: draft.margin.trim() || null,
  costItemIds: draft.costs.map(cost => cost.id),
});

const saleShare = (draft: PricingDraft) => draft.costs.filter(cost => cost.active && cost.mode === 'PERCENT' && cost.base === 'SALE')
  .reduce((sum, cost) => sum + number(cost.value), 0);
/** The API refuses it too; checking first spares the person a failed save. */
export const pricingBlock = (draft: PricingDraft) => number(draft.margin) + saleShare(draft) >= 100 ? impossibleMessage : null;

/** The price of a product on its own, opened from the stock page. */
export function PricingSection({ id, saved, closeOnSave = false }: { id: string; saved: () => Promise<void>; closeOnSave?: boolean }) {
  const { data, error, loading, reload } = useData<PricingView>('stock/products/' + id + '/pricing');
  const done = async () => { await reload(); await saved(); };
  return <>
    {message(error)}
    {!data ? loading && <Loading label="Carregando formação de preço…" /> : <PricingForm key={JSON.stringify(data)} view={data} saved={done} closeOnSave={closeOnSave} />}
  </>;
}

function PricingForm({ view, saved, closeOnSave }: { view: PricingView; saved: () => Promise<void>; closeOnSave: boolean }) {
  const [draft, setDraft] = useState(() => pricingDraft(view));
  const closePanel = useClosePanel();
  return <Form label="Salvar preço e estoque" cancel={closeOnSave ? 'Cancelar' : undefined} action={async () => {
    const block = pricingBlock(draft);
    if (block) throw new Error(block);
    await api('stock/products/' + view.id + '/settings', pricingPayload(draft), 'PATCH');
    await saved();
    if (closeOnSave) closePanel?.();
  }}>
    <PricingFields base={view} options={view.options} draft={draft} change={setDraft} />
  </Form>;
}

/**
 * The price fields, controlled by whoever saves them: the stock page or the product form.
 * The margin only suggests a price: what is saved is the price the person confirms. Linked costs read their current registered value.
 */
export function PricingFields({ base, options, draft, change }: {
  base: PricingBase; options: LinkedCost[]; draft: PricingDraft; change: (update: (draft: PricingDraft) => PricingDraft) => void;
}) {
  const [adding, setAdding] = useState(0);
  const { margin, price, costs } = draft;
  const set = (edit: Partial<PricingDraft>) => change(current => ({ ...current, ...edit }));
  const active = costs.filter(cost => cost.active);
  const suggestion = suggestedPrice(base.baseCost, margin, active);
  const shortfall = marginShortfall(price, base.baseCost, margin, active);
  const impossible = !!pricingBlock(draft);
  const baseValue = number(base.baseCost);
  // Display only: the API keeps the exact decimals and recomputes everything when the price is used.
  const amount = (cost: LinkedCost) => cost.mode === 'VALUE' ? number(cost.value)
    : cost.base === 'COST' ? baseValue * number(cost.value) / 100 : suggestion ? number(suggestion) * number(cost.value) / 100 : null;
  const unit = ' / ' + base.symbol;
  const baseRows: [string, ReactNode][] = base.source === 'RECIPE' ? [
    ['Insumos com perda', <span className="num">{brl(base.materialCost)}{base.partialCost && ' (parcial)'}</span>],
    ['Máquina e energia', base.machineCost === null
      ? <span className="hint">Informe o tempo por peça e a impressora na ficha técnica.</span>
      : <span className="num" title={base.printer ? base.printer.name + ' · ' + quantity(base.printMinutes) + ' min' : undefined}>{brl(base.machineCost)}</span>],
  ] : [['Custo médio', <span className="num">{brl(base.baseCost)}</span>]];
  const choices = options.filter(option => !costs.some(cost => cost.id === option.id));
  return <>
    <label>{'Estoque mínimo (' + base.symbol + ')'}
      <input name="minStock" inputMode="decimal" value={draft.minStock} onChange={event => set({ minStock: event.target.value })} />
      <span className="hint">Vazio: sem alerta. O aviso compara com o saldo livre, sem o que está reservado.</span>
    </label>
    <Table columns={['Composição', { label: 'Valor' + unit, end: true }, { label: '', actions: true }]}
      rows={[
        ...baseRows.map(([label, value]) => [label, value, '']),
        ...costs.map(cost => [
          <span>{cost.name} <span className="hint">· {costValue(cost)}{!cost.active && ' · inativo, fora do cálculo'}</span></span>,
          <span className="num">{cost.active ? brl(amount(cost)) : '—'}</span>,
          <button type="button" className="icon-button" aria-label={'Desvincular ' + cost.name}
            onClick={() => set({ costs: costs.filter(item => item.id !== cost.id) })}><Trash2 size={16} aria-hidden="true" /></button>,
        ]),
      ]} />
    {choices.length > 0 && <Select key={adding} name="addCost" label="Adicionar custo cadastrado" required={false} placeholder="Escolha um custo"
      options={choices.map(cost => ({ id: cost.id, name: cost.name + ' · ' + costValue(cost) }))}
      onChange={costId => {
        const cost = choices.find(item => item.id === costId);
        if (cost) set({ costs: [...costs, cost] });
        setAdding(value => value + 1);
      }} />}
    <div className="form-grid">
      <label>Margem desejada (%)
        <input name="marginPercent" inputMode="decimal" value={margin} onChange={event => set({ margin: event.target.value })} />
        <span className="hint">Parte do preço que fica como lucro, depois de todos os custos.</span>
      </label>
      <label>{'Preço de venda por ' + base.symbol + ' (R$)'}
        <input name="salePrice" inputMode="decimal" value={price} onChange={event => set({ price: event.target.value })} />
      </label>
    </div>
    {impossible && <div className="info" role="alert">A margem somada aos custos sobre a venda chega a 100%, e nenhum preço cobriria isso.</div>}
    {suggestion && <div className="section-head">
      <span>Preço sugerido: <strong className="num">{brl(suggestion)}</strong></span>
      <button type="button" className="btn secondary small" onClick={() => set({ price: suggestion })}>Usar sugestão</button>
    </div>}
    {!suggestion && !impossible && <p className="hint">{base.baseCost === null || baseValue <= 0 ? 'Sem custo conhecido, ainda não há preço sugerido.' : 'Informe a margem para ver o preço sugerido.'}</p>}
    {shortfall && <div className="info" role="alert">A margem real é de <strong>{quantity(shortfall)}%</strong>, abaixo da desejada de {quantity(margin.replace(',', '.'))}%.</div>}
  </>;
}
