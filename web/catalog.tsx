import { useState } from 'react';
import { Pencil, Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { RegistrationData, referenceKinds } from './registrations';
import {
  api, Badge, baseUnit, Field, fields, Form, Kit, Loading, matches, message, Modal, ModalForm, notify, PageActions, Product, productOptions,
  quantity, SearchInput, Segmented, Select, StockView, Table, Title, unitOptions, useClosePanel, useData,
} from './ui';

type CatalogView = StockView & RegistrationData;
type Situation = 'active' | 'inactive' | 'all';
type Status = { kind: 'products' | 'kits'; id: string; sku: string; active: boolean };

export function Catalog({ page, edit }: { page: 'products' | 'kits'; edit: boolean }) {
  const { data, error, loading, reload } = useData<CatalogView>('catalog');
  const [product, setProduct] = useState<Product | null>();
  const [kit, setKit] = useState<Kit | null>();
  const [status, setStatus] = useState<Status>();
  const [query, setQuery] = useState('');
  const [situation, setSituation] = useState<Situation>('active');
  async function save(path: string, payload: unknown, id?: string) {
    await api('catalog/' + path + (id ? '/' + id : ''), payload, id ? 'PATCH' : 'POST');
    notify(id ? 'Alterações salvas.' : 'Cadastro criado.');
    await reload();
  }
  const visible = <T extends { active: boolean; sku: string; name: string }>(rows: T[]) => rows.filter(row =>
    matches(query, row.sku, row.name) && (situation === 'all' || row.active === (situation === 'active')));
  const situationBadge = (row: { active: boolean }) => row.active
    ? <Badge tone="ok"><span className="dot" />Ativo</Badge> : <Badge>Inativo</Badge>;
  const rowActions = (kind: Status['kind'], row: { id: string; sku: string; active: boolean }, open: () => void) => <div className="actions">
    <button type="button" className="btn secondary small" onClick={open}><Pencil size={14} aria-hidden="true" />Editar</button>
    <button type="button" className="btn ghost small" onClick={() => setStatus({ kind, id: row.id, sku: row.sku, active: !row.active })}>
      {row.active ? <PowerOff size={14} aria-hidden="true" /> : <Power size={14} aria-hidden="true" />}{row.active ? 'Inativar' : 'Reativar'}</button>
  </div>;

  return <>
    {edit && <PageActions>
      <button type="button" className="btn" onClick={() => page === 'products' ? setProduct(null) : setKit(null)}>
        <Plus size={16} aria-hidden="true" />{page === 'products' ? 'Novo produto' : 'Novo kit'}</button>
    </PageActions>}
    <div className="toolbar">
      <SearchInput value={query} onChange={setQuery} placeholder={page === 'products' ? 'Buscar por SKU ou nome' : 'Buscar kit'} />
      <Segmented label="Situação" value={situation} onChange={setSituation}
        options={[{ id: 'active', name: 'Ativos' }, { id: 'inactive', name: 'Inativos' }, { id: 'all', name: 'Todos' }]} />
    </div>
    {message(error)}
    {!data ? loading && <Loading label="Carregando catálogo…" /> : <>
      {page === 'products' && <Table empty="Nenhum produto encontrado."
        columns={['Produto', 'Unidade', 'Classificação', 'Situação', ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
        rows={visible(data.products).map(row => [
          <Title name={row.name} code={row.sku} />, row.unit.symbol,
          <div className="actions">{referenceKinds.map(kind => data.references.find(item => item.id === row[kind.field])?.name)
            .filter(Boolean).map(name => <Badge key={name}>{name}</Badge>)}</div>,
          situationBadge(row),
          ...(edit ? [rowActions('products', row, () => setProduct(row))] : []),
        ])} />}
      {page === 'kits' && <Table empty="Nenhum kit encontrado."
        columns={['Kit', 'Componentes', 'Situação', ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
        rows={visible(data.kits).map(row => [
          <Title name={row.name} code={row.sku} />,
          <span className="muted">{row.components.map(item => quantity(item.quantity) + ' ' + baseUnit(item.product).symbol + ' ' + item.product.sku).join(' · ')}</span>,
          situationBadge(row),
          ...(edit ? [rowActions('kits', row, () => setKit(row))] : []),
        ])} />}
    </>}

    {data && edit && product !== undefined && <ModalForm title={product ? 'Editar produto' : 'Novo produto'} subtitle={product?.sku}
      close={() => setProduct(undefined)} label={product ? 'Salvar alterações' : 'Cadastrar produto'} action={async values => {
        const input = fields(values);
        await save('products', { ...input, ...Object.fromEntries(referenceKinds.map(kind => [kind.field, input[kind.field] || null])) }, product?.id);
      }}>
      {!product && <Field name="sku" label="SKU" placeholder="Ex.: CX-KRAFT-2020" />}
      <Field name="name" label="Nome do produto" defaultValue={product?.name} />
      {product ? <label>Unidade<input value={product.unit.symbol} disabled />
        <span className="hint">A unidade não muda depois do cadastro, para manter o histórico coerente.</span></label>
        : <Select name="unitId" label="Unidade" options={unitOptions(data.units)} />}
      <div className="form-grid">
        {referenceKinds.map(kind => <Select key={kind.id} name={kind.field} label={kind.name} required={false}
          defaultValue={product?.[kind.field] ?? undefined} options={data.references.filter(item => item.kind === kind.id)} />)}
      </div>
    </ModalForm>}
    {data && edit && kit !== undefined && <Modal wide title={kit ? 'Editar kit' : 'Novo kit'} subtitle={kit?.sku} close={() => setKit(undefined)}>
      <KitForm data={data} kit={kit ?? undefined} save={payload => save('kits', payload, kit?.id)} />
    </Modal>}
    {edit && status && <ModalForm title={(status.active ? 'Reativar ' : 'Inativar ') + status.sku} label={status.active ? 'Reativar' : 'Inativar'}
      danger={!status.active} close={() => setStatus(undefined)} action={async () => {
        await api('catalog/' + status.kind + '/' + status.id + '/status', { active: status.active });
        notify(status.sku + (status.active ? ' reativado.' : ' inativado.'));
        await reload();
      }}>
      <p className="muted">{status.active
        ? 'O item volta a aparecer no estoque e pode receber movimentações.'
        : 'O item sai do estoque e das listas de seleção, e o histórico é preservado. ' +
          (status.kind === 'products' ? 'O saldo precisa estar zerado e o produto não pode compor kits ativos.' : 'Não será possível dar saída neste kit.')}</p>
    </ModalForm>}
  </>;
}

function KitForm({ data, kit, save }: { data: CatalogView; kit?: Kit; save: (body: unknown) => Promise<void> }) {
  const [components, setComponents] = useState(() => (kit?.components.map(item => item.productId) ?? ['']).map((productId, key) => ({ key, productId })));
  const closePanel = useClosePanel();
  const options = productOptions(data.products.filter(item => item.active || components.some(component => component.productId === item.id)));
  return <Form label={kit ? 'Salvar alterações' : 'Cadastrar kit'} cancel="Cancelar" action={async values => {
    const input = fields(values);
    await save({ sku: input.sku, name: input.name, components: components.map(({ key }) => ({
      productId: input['product' + key], unitId: input['unit' + key], quantity: input['quantity' + key],
    })) });
    closePanel?.();
  }}>
    <div className="form-grid">
      <Field name="sku" label="SKU do kit" defaultValue={kit?.sku} />
      <Field name="name" label="Nome do kit" defaultValue={kit?.name} />
    </div>
    <h3>Componentes</h3>
    {components.map(({ key, productId }, index) => {
      const product = data.products.find(item => item.id === productId);
      const units = data.units.filter(unit => unit.familyId === product?.unit.familyId);
      return <div className="component-row" key={key}>
        <Select name={'product' + key} label={'Produto ' + (index + 1)} options={options} defaultValue={productId}
          onChange={value => setComponents(items => items.map(item => item.key === key ? { key, productId: value } : item))} />
        <Field name={'quantity' + key} label="Quantidade" inputMode="decimal" defaultValue={kit?.components.find(item => item.productId === productId)?.quantity} />
        <Select key={productId} name={'unit' + key} label="Unidade" options={unitOptions(units)} defaultValue={product && baseUnit(product).id} />
        <button type="button" className="icon-button" aria-label={'Remover produto ' + (index + 1)} disabled={components.length === 1}
          onClick={() => setComponents(items => items.filter(item => item.key !== key))}><Trash2 size={18} aria-hidden="true" /></button>
      </div>;
    })}
    <button type="button" className="btn secondary" style={{ alignSelf: 'flex-start' }}
      onClick={() => setComponents(items => [...items, { key: Math.max(...items.map(item => item.key)) + 1, productId: '' }])}>
      <Plus size={16} aria-hidden="true" />Adicionar componente</button>
  </Form>;
}
