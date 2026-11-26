import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, Badge, brl, by, decimal, Field, fields, Loading, matches, message, Modal, ModalForm, notify, PageActions, SearchInput, Select, Table, useData } from './ui';

export type CostItem = { id: string; name: string; mode: 'VALUE' | 'PERCENT'; base: 'COST' | 'SALE'; value: string; active: boolean };
type Row = CostItem & { purchases: number; deleteBlock: string | null };

export const costModes = [{ id: 'VALUE', name: 'Valor (R$)' }, { id: 'PERCENT', name: 'Percentual (%)' }];
const bases = [{ id: 'COST', name: 'Sobre o custo' }, { id: 'SALE', name: 'Sobre o preço de venda' }];
export const costTypeLabel = (row: Pick<CostItem, 'mode'>) => row.mode === 'PERCENT' ? 'Percentual' : 'Valor fixo';
export const costBaseLabel = (row: Pick<CostItem, 'mode' | 'base'>) => row.mode === 'PERCENT' ? (row.base === 'SALE' ? 'Sobre a venda' : 'Sobre o custo') : '—';
export const costValue = (row: Pick<CostItem, 'mode' | 'value'>) => row.mode === 'PERCENT' ? decimal(row.value) + '%' : brl(row.value);

export function Costs({ edit }: { edit: boolean }) {
  const { data, error, loading, reload } = useData<Row[]>('costs');
  const [cost, setCost] = useState<Row | null>();
  const [mode, setMode] = useState('VALUE');
  const [removal, setRemoval] = useState<Row>();
  const [query, setQuery] = useState('');
  const open = (row: Row | null) => { setMode(row?.mode ?? 'VALUE'); setCost(row); };
  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => open(null)}><Plus size={16} aria-hidden="true" />Novo custo</button></PageActions>}
    {message(error)}
    {!data ? loading && <Loading label="Carregando custos…" /> : <>
      <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder="Buscar custo" /></div>
      <Table empty={query ? 'Nenhum custo encontrado.' : 'Nenhum custo cadastrado.'}
        columns={['Custo', 'Tipo', 'Base do %', { label: 'Valor', end: true }, 'Situação', { label: 'Compras', end: true }, ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
        rows={data.filter(row => matches(query, row.name)).map(row => [
          by(row.name, <span className="cell-title">{row.name}</span>),
          costTypeLabel(row),
          costBaseLabel(row),
          by(Number(row.value), <span className="num">{costValue(row)}</span>),
          by(row.active ? 'Ativo' : 'Inativo', row.active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>),
          by(row.purchases, <span className="num">{row.purchases}</span>),
          ...(edit ? [<div className="actions">
            <button type="button" className="btn secondary small" onClick={() => open(row)}><Pencil size={14} aria-hidden="true" />Editar</button>
            <button type="button" className={'btn ghost small' + (row.deleteBlock ? ' unavailable' : '')} title={row.deleteBlock ?? undefined}
              onClick={() => setRemoval(row)}><Trash2 size={14} aria-hidden="true" />Excluir</button>
          </div>] : []),
        ])} />
    </>}
    {edit && cost !== undefined && <ModalForm title={cost ? 'Editar custo' : 'Novo custo'} label="Salvar" close={() => setCost(undefined)}
      subtitle="As compras copiam o custo ao lançar, então mudar o cadastro não altera compras já lançadas."
      action={async values => {
        const { name, mode: chosen, base, value } = fields(values);
        await api('costs' + (cost ? '/' + cost.id : ''), { name, mode: chosen, base: base ?? 'COST', value, active: !cost || values.has('active') }, cost ? 'PATCH' : 'POST');
        notify(cost ? 'Alterações salvas.' : 'Custo cadastrado.');
        await reload();
      }}>
      <Field name="name" label="Descrição" placeholder="Ex.: Embalagem" defaultValue={cost?.name} />
      <Select name="mode" label="Tipo" options={costModes} defaultValue={mode} onChange={setMode} />
      {mode === 'PERCENT' && <Select name="base" label="Base do percentual" options={bases} defaultValue={cost?.base ?? 'COST'} />}
      <Field key={mode} name="value" label={mode === 'PERCENT' ? 'Percentual (%)' : 'Valor (R$)'} inputMode="decimal" defaultValue={cost?.mode === mode ? cost.value : undefined}
        hint={mode === 'PERCENT' ? 'Na compra, o percentual vale sobre o total das mercadorias.' : undefined} />
      {cost && <label className="check"><input name="active" type="checkbox" defaultChecked={cost.active} />Ativo nas listas de compra</label>}
    </ModalForm>}
    {edit && removal?.deleteBlock && <Modal title={'Não é possível excluir ' + removal.name} close={() => setRemoval(undefined)}>
      <p className="muted">{removal.deleteBlock}</p>
    </Modal>}
    {edit && removal && !removal.deleteBlock && <ModalForm title={'Excluir ' + removal.name} label="Excluir definitivamente" danger close={() => setRemoval(undefined)}
      action={async () => {
        await api('costs/' + removal.id, undefined, 'DELETE');
        notify(removal.name + ' excluído.');
        await reload();
      }}>
      <p className="muted">Esta ação não pode ser desfeita, e a exclusão fica registrada na auditoria.</p>
    </ModalForm>}
  </>;
}
