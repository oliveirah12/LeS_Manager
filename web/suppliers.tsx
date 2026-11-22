import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, Badge, by, Field, fields, Loading, matches, message, Modal, ModalForm, notify, PageActions, SearchInput, Table, useData } from './ui';

type Supplier = { id: string; name: string; document: string | null; contact: string | null; active: boolean; purchases: number; deleteBlock: string | null };

export function Suppliers({ edit }: { edit: boolean }) {
  const { data, error, loading, reload } = useData<Supplier[]>('suppliers');
  const [supplier, setSupplier] = useState<Supplier | null>();
  const [removal, setRemoval] = useState<Supplier>();
  const [query, setQuery] = useState('');
  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => setSupplier(null)}><Plus size={16} aria-hidden="true" />Novo fornecedor</button></PageActions>}
    {message(error)}
    {!data ? loading && <Loading label="Carregando fornecedores…" /> : <>
      <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder="Buscar por nome, documento ou contato" /></div>
      <Table empty={query ? 'Nenhum fornecedor encontrado.' : 'Nenhum fornecedor cadastrado.'}
        columns={['Fornecedor', 'CPF/CNPJ', 'Contato', 'Situação', { label: 'Compras', end: true }, ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
        rows={data.filter(row => matches(query, row.name, row.document, row.contact)).map(row => [
          by(row.name, <span className="cell-title">{row.name}</span>), by(row.document, row.document ?? '—'), by(row.contact, row.contact ?? '—'),
          by(row.active ? 'Ativo' : 'Inativo', row.active ? <Badge tone="ok">Ativo</Badge> : <Badge>Inativo</Badge>),
          by(row.purchases, <span className="num">{row.purchases}</span>),
          ...(edit ? [<div className="actions">
            <button type="button" className="btn secondary small" onClick={() => setSupplier(row)}><Pencil size={14} aria-hidden="true" />Editar</button>
            <button type="button" className={'btn ghost small' + (row.deleteBlock ? ' unavailable' : '')} title={row.deleteBlock ?? undefined}
              onClick={() => setRemoval(row)}><Trash2 size={14} aria-hidden="true" />Excluir</button>
          </div>] : []),
        ])} />
    </>}
    {edit && supplier !== undefined && <ModalForm title={supplier ? 'Editar fornecedor' : 'Novo fornecedor'} label="Salvar" close={() => setSupplier(undefined)}
      action={async values => {
        const { name, document, contact } = fields(values);
        await api('suppliers' + (supplier ? '/' + supplier.id : ''), { name, document, contact, active: !supplier || values.has('active') }, supplier ? 'PATCH' : 'POST');
        notify(supplier ? 'Alterações salvas.' : 'Fornecedor cadastrado.');
        await reload();
      }}>
      <Field name="name" label="Nome" defaultValue={supplier?.name} />
      <Field name="document" label="CPF ou CNPJ" required={false} defaultValue={supplier?.document ?? undefined} />
      <Field name="contact" label="Contato" required={false} placeholder="Telefone, e-mail ou site" defaultValue={supplier?.contact ?? undefined} />
      {supplier && <label className="check"><input name="active" type="checkbox" defaultChecked={supplier.active} />Ativo nas listas de compra</label>}
    </ModalForm>}
    {edit && removal?.deleteBlock && <Modal title={'Não é possível excluir ' + removal.name} close={() => setRemoval(undefined)}>
      <p className="muted">{removal.deleteBlock}</p>
    </Modal>}
    {edit && removal && !removal.deleteBlock && <ModalForm title={'Excluir ' + removal.name} label="Excluir definitivamente" danger close={() => setRemoval(undefined)}
      action={async () => {
        await api('suppliers/' + removal.id, undefined, 'DELETE');
        notify(removal.name + ' excluído.');
        await reload();
      }}>
      <p className="muted">Esta ação não pode ser desfeita, e a exclusão fica registrada na auditoria.</p>
    </ModalForm>}
  </>;
}
