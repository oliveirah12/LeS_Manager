import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  api, applyFilters, Badge, by, decimal, Field, fields, Loading, matches, message, Modal, ModalForm, notify, PageActions, SearchInput, Select, Table, TableFilter,
  TableFilters, Unit, useData, yesNo, yesNoOptions,
} from './ui';

export const referenceKinds = [
  { id: 'GRUPO', name: 'Grupo', label: 'Grupos', field: 'groupId' },
  { id: 'MARCA', name: 'Marca', label: 'Marcas', field: 'brandId' },
  { id: 'COR', name: 'Cor', label: 'Cores', field: 'colorId' },
  { id: 'DEPARTAMENTO', name: 'Departamento', label: 'Departamentos', field: 'departmentId' },
] as const;
type Reference = { id: string; name: string; kind: string; products?: number };
export type ProductType = { id: string; name: string; isInput: boolean; isManufactured: boolean; products: number; isDefault: boolean; deleteBlock: string | null };
type Family = { id: string; name: string; products?: number; deleteBlock?: string | null };
type MeasureUnit = Unit & { products?: number; factorBlock?: string | null; deleteBlock?: string | null };
type Removal = { path: 'families' | 'units'; id: string; name: string; block?: string | null };
export type RegistrationData = { families: Family[]; references: Reference[]; units: MeasureUnit[]; productTypes: ProductType[] };
export type RegistrationPage = typeof referenceKinds[number]['id'] | 'families' | 'units' | 'product-types';

const inUseFilter = <T extends { products?: number }>(): TableFilter<T> => ({
  id: 'inUse', label: 'Em uso', options: yesNoOptions, value: row => yesNo((row.products ?? 0) > 0),
});
const typeFilters: TableFilter<ProductType>[] = [
  { id: 'isInput', label: 'Usado como insumo', options: yesNoOptions, value: row => yesNo(row.isInput) },
  { id: 'isManufactured', label: 'É fabricado', options: yesNoOptions, value: row => yesNo(row.isManufactured) },
  inUseFilter<ProductType>(),
];
const unitFilters = (families: Family[]): TableFilter<MeasureUnit>[] => [
  { id: 'familyId', label: 'Família', options: families, value: row => row.familyId },
  { id: 'unitKind', label: 'Tipo', options: [{ id: 'base', name: 'Base' }, { id: 'conversion', name: 'Conversão' }], value: row => row.isBase ? 'base' : 'conversion' },
  inUseFilter<MeasureUnit>(),
];

function ProductTypes({ types, edit, reload }: { types: ProductType[]; edit: boolean; reload: () => Promise<unknown> }) {
  const [type, setType] = useState<ProductType | null>();
  const [removal, setRemoval] = useState<ProductType>();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>({});
  const flag = (active: boolean) => by(active ? 'Sim' : 'Não', active ? <Badge tone="ok">Sim</Badge> : <span className="muted">Não</span>);
  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => setType(null)}><Plus size={16} aria-hidden="true" />Novo tipo</button></PageActions>}
    <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder="Buscar tipo" /></div>
    <TableFilters filters={typeFilters} selected={selected} onChange={setSelected} />
    <Table empty="Nenhum tipo encontrado." columns={['Tipo', 'Usado como insumo', 'É fabricado', { label: 'Produtos', end: true }, ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
      rows={applyFilters(types.filter(item => matches(query, item.name)), typeFilters, selected).map(item => [
        by(item.name, <span className="cell-title with-badge">{item.name}{item.isDefault && <Badge tone="brand">Padrão</Badge>}</span>),
        flag(item.isInput), flag(item.isManufactured), by(item.products, <span className="num">{item.products}</span>),
        ...(edit ? [<div className="actions">
          <button type="button" className="btn secondary small" onClick={() => setType(item)}><Pencil size={14} aria-hidden="true" />Editar</button>
          <button type="button" className={'btn ghost small' + (item.deleteBlock ? ' unavailable' : '')} title={item.deleteBlock ?? undefined}
            onClick={() => setRemoval(item)}><Trash2 size={14} aria-hidden="true" />Excluir</button>
        </div>] : []),
      ])} />
    {edit && type !== undefined && <ModalForm title={type ? 'Editar tipo de produto' : 'Novo tipo de produto'} close={() => setType(undefined)} label="Salvar"
      action={async values => {
        await api('catalog/product-types' + (type ? '/' + type.id : ''), {
          name: values.get('name'), isInput: values.has('isInput'), isManufactured: values.has('isManufactured'),
        }, type ? 'PATCH' : 'POST');
        notify(type ? 'Alterações salvas.' : 'Cadastro criado.');
        await reload();
      }}>
      <Field name="name" label="Nome" placeholder="Ex.: Resina" defaultValue={type?.name} />
      <label className="check"><input name="isInput" type="checkbox" defaultChecked={type?.isInput} />Usado como insumo na produção</label>
      <label className="check"><input name="isManufactured" type="checkbox" defaultChecked={type?.isManufactured} />É fabricado por ordem de produção</label>
    </ModalForm>}
    {edit && removal?.deleteBlock && <Modal title={'Não é possível excluir ' + removal.name} close={() => setRemoval(undefined)}>
      <p className="muted">{removal.deleteBlock}</p>
    </Modal>}
    {edit && removal && !removal.deleteBlock && <ModalForm title={'Excluir ' + removal.name} label="Excluir definitivamente" danger
      close={() => setRemoval(undefined)} action={async () => {
        await api('catalog/product-types/' + removal.id, undefined, 'DELETE');
        notify(removal.name + ' excluído.');
        await reload();
      }}>
      <p className="muted">Esta ação não pode ser desfeita, e a exclusão fica registrada na auditoria.</p>
    </ModalForm>}
  </>;
}

export function Registrations({ page, edit, admin }: { page: RegistrationPage; edit: boolean; admin: boolean }) {
  const { data, error, loading, reload } = useData<RegistrationData>('catalog/registrations');
  const [reference, setReference] = useState<Reference | null>();
  const [creating, setCreating] = useState(false);
  const [family, setFamily] = useState<Family>();
  const [unit, setUnit] = useState<MeasureUnit>();
  const [removal, setRemoval] = useState<Removal>();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Record<string, string>>({});
  const measureActions = (open: () => void, target: Removal) => <div className="actions">
    <button type="button" className="btn secondary small" onClick={open}><Pencil size={14} aria-hidden="true" />Editar</button>
    <button type="button" className={'btn ghost small' + (target.block ? ' unavailable' : '')} title={target.block ?? undefined}
      onClick={() => setRemoval(target)}><Trash2 size={14} aria-hidden="true" />Excluir</button>
  </div>;
  async function save(path: string, payload: unknown, id?: string) {
    await api('catalog/' + path + (id ? '/' + id : ''), payload, id ? 'PATCH' : 'POST');
    notify(id ? 'Alterações salvas.' : 'Cadastro criado.');
    await reload();
  }
  const kind = referenceKinds.find(item => item.id === page);
  const article = kind?.id === 'MARCA' || kind?.id === 'COR' ? 'Nova' : 'Novo';

  return <>
    {kind && edit && <PageActions><button type="button" className="btn" onClick={() => setReference(null)}><Plus size={16} aria-hidden="true" />{article} {kind.name.toLowerCase()}</button></PageActions>}
    {page === 'families' && admin && <PageActions><button type="button" className="btn" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />Nova família</button></PageActions>}
    {page === 'units' && admin && <PageActions><button type="button" className="btn" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />Nova unidade</button></PageActions>}
    {message(error)}
    {!data ? loading && <Loading label="Carregando cadastros…" /> : <>
      {page === 'product-types' && <ProductTypes types={data.productTypes} edit={edit} reload={reload} />}
      {kind && <>
        <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder={'Buscar ' + kind.name.toLowerCase()} /></div>
        <TableFilters filters={[inUseFilter<Reference>()]} selected={selected} onChange={setSelected} />
        <Table empty={query || selected.inUse ? 'Nada encontrado.' : 'Nenhum registro.'} columns={['Nome', { label: 'Produtos', end: true }, ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
          rows={applyFilters(data.references.filter(item => item.kind === kind.id && matches(query, item.name)), [inUseFilter<Reference>()], selected).map(item => [
            by(item.name, <span className="cell-title">{item.name}</span>), by(item.products ?? 0, <span className="num">{item.products ?? 0}</span>),
            ...(edit ? [<button type="button" className="btn secondary small" onClick={() => setReference(item)}><Pencil size={14} aria-hidden="true" />Editar</button>] : []),
          ])} />
      </>}
      {page === 'families' && <>
        <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder="Buscar família" /></div>
        <TableFilters filters={[inUseFilter<Family>()]} selected={selected} onChange={setSelected} />
        <Table empty="Nenhuma família encontrada." columns={['Família', 'Unidade base', { label: 'Produtos', end: true }, ...(admin ? [{ label: 'Ações', actions: true }] : [])]}
          rows={applyFilters(data.families.filter(item => matches(query, item.name)), [inUseFilter<Family>()], selected).map(item => [
            by(item.name, <span className="cell-title">{item.name}</span>), data.units.find(row => row.familyId === item.id && row.isBase)?.symbol ?? '—',
            by(item.products ?? 0, <span className="num">{item.products ?? 0}</span>),
            ...(admin ? [measureActions(() => setFamily(item), { path: 'families', id: item.id, name: item.name, block: item.deleteBlock })] : []),
          ])} />
      </>}
      {page === 'units' && <>
        <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder="Buscar unidade" /></div>
        <TableFilters filters={unitFilters(data.families)} selected={selected} onChange={setSelected} />
        <Table empty="Nenhuma unidade encontrada." columns={['Unidade', 'Família', { label: 'Fator', end: true }, 'Tipo', { label: 'Produtos', end: true }, ...(admin ? [{ label: 'Ações', actions: true }] : [])]}
          rows={applyFilters(data.units.filter(item => matches(query, item.symbol)), unitFilters(data.families), selected).map(item => [
        by(item.symbol, <span className="cell-title">{item.symbol}</span>), by(data.families.find(row => row.id === item.familyId)?.name),
        by(item.factor, <span className="num">{decimal(item.factor)}</span>),
        by(item.isBase ? 'Base' : 'Conversão', item.isBase ? <Badge tone="brand">Base</Badge> : <span className="muted">Conversão</span>),
        by(item.products ?? 0, <span className="num">{item.products ?? 0}</span>),
        ...(admin ? [measureActions(() => setUnit(item), { path: 'units', id: item.id, name: item.symbol, block: item.deleteBlock })] : []),
          ])} />
      </>}
    </>}

    {kind && edit && reference !== undefined && <ModalForm title={(reference ? 'Editar ' : 'Cadastrar ') + kind.name.toLowerCase()}
      close={() => setReference(undefined)} label="Salvar" action={values => save('references', { ...fields(values), kind: kind.id }, reference?.id)}>
      <Field name="name" label="Nome" defaultValue={reference?.name} />
    </ModalForm>}
    {page === 'families' && admin && creating && <ModalForm title="Nova família de medida" close={() => setCreating(false)} label="Cadastrar família"
      action={values => save('families', fields(values))}>
      <Field name="name" label="Família" placeholder="Peso" />
      <Field name="baseSymbol" label="Símbolo da unidade base" placeholder="g" hint="As quantidades e custos ficam guardados nesta unidade." />
    </ModalForm>}
    {page === 'units' && admin && creating && data && <ModalForm title="Nova unidade" close={() => setCreating(false)} label="Cadastrar unidade"
      action={values => save('units', fields(values))}>
      <Select name="familyId" label="Família" options={data.families} />
      <Field name="symbol" label="Símbolo" placeholder="kg" />
      <Field name="factor" label="Fator de conversão" placeholder="1000" inputMode="decimal" hint="Quantas unidades base cabem em uma desta. Exemplo: 1 kg = 1000 g." />
    </ModalForm>}
    {page === 'families' && admin && family && <ModalForm title="Editar família" close={() => setFamily(undefined)} label="Salvar"
      action={values => save('families', { name: values.get('name') }, family.id)}>
      <Field name="name" label="Família" defaultValue={family.name} />
    </ModalForm>}
    {page === 'units' && admin && unit && <ModalForm title={'Editar unidade ' + unit.symbol} close={() => setUnit(undefined)} label="Salvar"
      action={values => save('units', { symbol: values.get('symbol'), factor: unit.factorBlock ? unit.factor : values.get('factor') }, unit.id)}>
      <Field name="symbol" label="Símbolo" defaultValue={unit.symbol} />
      {unit.factorBlock
        ? <label>Fator de conversão<input value={decimal(unit.factor)} disabled /><span className="hint">{unit.factorBlock} O fator não pode mudar.</span></label>
        : <Field name="factor" label="Fator de conversão" inputMode="decimal" defaultValue={unit.factor} hint="Quantas unidades base cabem em uma desta." />}
    </ModalForm>}
    {admin && removal?.block && <Modal title={'Não é possível excluir ' + removal.name} close={() => setRemoval(undefined)}>
      <p className="muted">{removal.block}</p>
    </Modal>}
    {admin && removal && !removal.block && <ModalForm title={'Excluir ' + removal.name} label="Excluir definitivamente" danger close={() => setRemoval(undefined)}
      action={async () => {
        await api('catalog/' + removal.path + '/' + removal.id, undefined, 'DELETE');
        notify(removal.name + ' excluído.');
        await reload();
      }}>
      <p className="muted">{removal.path === 'families' ? 'A família e todas as suas unidades serão removidas. ' : ''}Esta ação não pode ser desfeita, e a exclusão fica registrada na auditoria.</p>
    </ModalForm>}
  </>;
}
