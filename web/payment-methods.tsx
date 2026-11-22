import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, Badge, by, decimal, Field, fields, Loading, matches, message, Modal, ModalForm, notify, PageActions, SearchInput, Table, useData } from './ui';

type PaymentMethod = { id: string; name: string; feePercent: string | null; active: boolean; orders: number; deleteBlock: string | null };

export function PaymentMethods({ edit }: { edit: boolean }) {
  const { data, error, loading, reload } = useData<PaymentMethod[]>('payment-methods');
  const [method, setMethod] = useState<PaymentMethod | null>();
  const [removal, setRemoval] = useState<PaymentMethod>();
  const [query, setQuery] = useState('');
  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => setMethod(null)}><Plus size={16} aria-hidden="true" />Nova forma</button></PageActions>}
    {message(error)}
    {!data ? loading && <Loading label="Carregando formas de pagamento…" /> : <>
      <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder="Buscar forma de pagamento" /></div>
      <Table empty={query ? 'Nenhuma forma encontrada.' : 'Nenhuma forma de pagamento cadastrada.'}
        columns={['Forma de pagamento', { label: 'Taxa', end: true }, 'Situação', { label: 'Ordens', end: true }, ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
        rows={data.filter(row => matches(query, row.name)).map(row => [
          by(row.name, <span className="cell-title">{row.name}</span>),
          by(row.feePercent ?? '0', <span className="num">{row.feePercent === null ? '—' : decimal(row.feePercent) + '%'}</span>),
          by(row.active ? 'Ativa' : 'Inativa', row.active ? <Badge tone="ok">Ativa</Badge> : <Badge>Inativa</Badge>),
          by(row.orders, <span className="num">{row.orders}</span>),
          ...(edit ? [<div className="actions">
            <button type="button" className="btn secondary small" onClick={() => setMethod(row)}><Pencil size={14} aria-hidden="true" />Editar</button>
            <button type="button" className={'btn ghost small' + (row.deleteBlock ? ' unavailable' : '')} title={row.deleteBlock ?? undefined}
              onClick={() => setRemoval(row)}><Trash2 size={14} aria-hidden="true" />Excluir</button>
          </div>] : []),
        ])} />
    </>}
    {edit && method !== undefined && <ModalForm title={method ? 'Editar forma de pagamento' : 'Nova forma de pagamento'} label="Salvar" close={() => setMethod(undefined)}
      action={async values => {
        const { name, feePercent } = fields(values);
        await api('payment-methods' + (method ? '/' + method.id : ''), { name, feePercent, active: !method || values.has('active') }, method ? 'PATCH' : 'POST');
        notify(method ? 'Alterações salvas.' : 'Forma de pagamento cadastrada.');
        await reload();
      }}>
      <Field name="name" label="Nome" placeholder="Ex.: Pix" defaultValue={method?.name} />
      <Field name="feePercent" label="Taxa (%)" required={false} inputMode="decimal" placeholder="0" defaultValue={method?.feePercent ?? undefined}
        hint="Reduz o valor líquido e a margem da ordem, sem entrar no custo." />
      {method && <label className="check"><input name="active" type="checkbox" defaultChecked={method.active} />Ativa nas ordens de produção</label>}
    </ModalForm>}
    {edit && removal?.deleteBlock && <Modal title={'Não é possível excluir ' + removal.name} close={() => setRemoval(undefined)}>
      <p className="muted">{removal.deleteBlock}</p>
    </Modal>}
    {edit && removal && !removal.deleteBlock && <ModalForm title={'Excluir ' + removal.name} label="Excluir definitivamente" danger close={() => setRemoval(undefined)}
      action={async () => {
        await api('payment-methods/' + removal.id, undefined, 'DELETE');
        notify(removal.name + ' excluída.');
        await reload();
      }}>
      <p className="muted">Esta ação não pode ser desfeita, e a exclusão fica registrada na auditoria.</p>
    </ModalForm>}
  </>;
}
