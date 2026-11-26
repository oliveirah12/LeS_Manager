import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { costValue, type CostItem } from './costs';
import { marginShortfall, suggestedPrice } from './format';
import { api, brl, Field, Form, Loading, message, quantity, Select, Table, useClosePanel, useData } from './ui';

type LinkedCost = Pick<CostItem, 'id' | 'name' | 'mode' | 'base' | 'value' | 'active'>;
type PricingView = {
  id: string; symbol: string; minStock: string | null; source: 'RECIPE' | 'AVERAGE';
  materialCost: string | null; partialCost: boolean; machineCost: string | null; printMinutes: string | null; printer: { name: string } | null;
  baseCost: string | null; marginPercent: string | null; salePrice: string | null; costs: LinkedCost[]; options: LinkedCost[];
};
const number = (value: string | null) => Number((value ?? '').replace(',', '.'));

/** Loads and edits the price of a product: minimum, linked costs, margin and the confirmed price. */
export function PricingSection({ id, saved, closeOnSave = false }: { id: string; saved: () => Promise<void>; closeOnSave?: boolean }) {
  const { data, error, loading, reload } = useData<PricingView>('stock/products/' + id + '/pricing');
  const done = async () => { await reload(); await saved(); };
  return <>
    {message(error)}
    {!data ? loading && <Loading label="Carregando formação de preço…" /> : <PricingForm key={JSON.stringify(data)} view={data} saved={done} closeOnSave={closeOnSave} />}
  </>;
}

/** The margin only suggests a price: what is saved is the price the person confirms. Linked costs read their current registered value. */
function PricingForm({ view, saved, closeOnSave }: { view: PricingView; saved: () => Promise<void>; closeOnSave: boolean }) {
  const [margin, setMargin] = useState(view.marginPercent ?? '');
  const [price, setPrice] = useState(view.salePrice ?? '');
  const [costs, setCosts] = useState(view.costs);
  const [adding, setAdding] = useState(0);
  const closePanel = useClosePanel();
  const active = costs.filter(cost => cost.active);
  const suggestion = suggestedPrice(view.baseCost, margin, active);
  const shortfall = marginShortfall(price, view.baseCost, margin, active);
  const saleShare = active.filter(cost => cost.mode === 'PERCENT' && cost.base === 'SALE').reduce((sum, cost) => sum + number(cost.value), 0);
  const impossible = number(margin) + saleShare >= 100;
  const base = number(view.baseCost);
  // Display only: the API keeps the exact decimals and recomputes everything when the price is used.
  const amount = (cost: LinkedCost) => cost.mode === 'VALUE' ? number(cost.value)
    : cost.base === 'COST' ? base * number(cost.value) / 100 : suggestion ? number(suggestion) * number(cost.value) / 100 : null;
  const unit = ' / ' + view.symbol;
  const baseRows = view.source === 'RECIPE' ? [
    ['Insumos com perda', <span className="num">{brl(view.materialCost)}{view.partialCost && ' (parcial)'}</span>],
    ['Máquina e energia', view.machineCost === null
      ? <span className="hint">Informe o tempo por peça e a impressora na ficha técnica.</span>
      : <span className="num" title={view.printer ? view.printer.name + ' · ' + quantity(view.printMinutes) + ' min' : undefined}>{brl(view.machineCost)}</span>],
  ] : [['Custo médio', <span className="num">{brl(view.baseCost)}</span>]];
  const choices = view.options.filter(option => !costs.some(cost => cost.id === option.id));
  return <Form label="Salvar preço e estoque" cancel={closeOnSave ? 'Cancelar' : undefined} action={async values => {
    if (impossible) throw new Error('A margem somada aos custos sobre a venda chega a 100%. Reduza a margem ou os percentuais.');
    await api('stock/products/' + view.id + '/settings', {
      minStock: String(values.get('minStock') ?? '').trim() || null, salePrice: price.trim() || null, marginPercent: margin.trim() || null,
      costItemIds: costs.map(cost => cost.id),
    }, 'PATCH');
    await saved();
    if (closeOnSave) closePanel?.();
  }}>
    <Field name="minStock" label={'Estoque mínimo (' + view.symbol + ')'} inputMode="decimal" required={false}
      defaultValue={view.minStock ?? undefined} hint="Vazio: sem alerta. O aviso compara com o saldo livre, sem o que está reservado." />
    <Table columns={['Composição', { label: 'Valor' + unit, end: true }, { label: '', actions: true }]}
      rows={[
        ...baseRows.map(([label, value]) => [label, value, '']),
        ...costs.map(cost => [
          <span>{cost.name} <span className="hint">· {costValue(cost)}{!cost.active && ' · inativo, fora do cálculo'}</span></span>,
          <span className="num">{cost.active ? brl(amount(cost)) : '—'}</span>,
          <button type="button" className="icon-button" aria-label={'Desvincular ' + cost.name}
            onClick={() => setCosts(items => items.filter(item => item.id !== cost.id))}><Trash2 size={16} aria-hidden="true" /></button>,
        ]),
      ]} />
    {choices.length > 0 && <Select key={adding} name="addCost" label="Adicionar custo cadastrado" required={false} placeholder="Escolha um custo"
      options={choices.map(cost => ({ id: cost.id, name: cost.name + ' · ' + costValue(cost) }))}
      onChange={costId => {
        const cost = choices.find(item => item.id === costId);
        if (cost) setCosts(items => [...items, cost]);
        setAdding(value => value + 1);
      }} />}
    <div className="form-grid">
      <label>Margem desejada (%)
        <input name="marginPercent" inputMode="decimal" value={margin} onChange={event => setMargin(event.target.value)} />
        <span className="hint">Parte do preço que fica como lucro, depois de todos os custos.</span>
      </label>
      <label>{'Preço de venda por ' + view.symbol + ' (R$)'}
        <input name="salePrice" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} />
      </label>
    </div>
    {impossible && <div className="info" role="alert">A margem somada aos custos sobre a venda chega a 100%, e nenhum preço cobriria isso.</div>}
    {suggestion && <div className="section-head">
      <span>Preço sugerido: <strong className="num">{brl(suggestion)}</strong></span>
      <button type="button" className="btn secondary small" onClick={() => setPrice(suggestion)}>Usar sugestão</button>
    </div>}
    {!suggestion && !impossible && <p className="hint">{view.baseCost === null || base <= 0 ? 'Sem custo conhecido, ainda não há preço sugerido.' : 'Informe a margem para ver o preço sugerido.'}</p>}
    {shortfall && <div className="info" role="alert">A margem real é de <strong>{quantity(shortfall)}%</strong>, abaixo da desejada de {quantity(margin.replace(',', '.'))}%.</div>}
  </Form>;
}
