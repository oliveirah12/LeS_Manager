import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { api, Badge, decimal, Field, fields, Loading, matches, message, ModalForm, notify, PageActions, SearchInput, Select, Table, Unit, useData } from './ui';

export const referenceKinds = [
  { id: 'GRUPO', name: 'Grupo', label: 'Grupos', field: 'groupId' },
  { id: 'MARCA', name: 'Marca', label: 'Marcas', field: 'brandId' },
  { id: 'COR', name: 'Cor', label: 'Cores', field: 'colorId' },
  { id: 'DEPARTAMENTO', name: 'Departamento', label: 'Departamentos', field: 'departmentId' },
] as const;
type Reference = { id: string; name: string; kind: string };
export type RegistrationData = { families: { id: string; name: string }[]; references: Reference[]; units: Unit[] };
export type RegistrationPage = typeof referenceKinds[number]['id'] | 'families' | 'units';

export function Registrations({ page, edit, admin }: { page: RegistrationPage; edit: boolean; admin: boolean }) {
  const { data, error, loading, reload } = useData<RegistrationData>('catalog/registrations');
  const [reference, setReference] = useState<Reference | null>();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
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
      {kind && <>
        <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder={'Buscar ' + kind.name.toLowerCase()} /></div>
        <Table empty={query ? 'Nada encontrado.' : 'Nenhum registro.'} columns={['Nome', ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
          rows={data.references.filter(item => item.kind === kind.id && matches(query, item.name)).map(item => [
            <span className="cell-title">{item.name}</span>,
            ...(edit ? [<button type="button" className="btn secondary small" onClick={() => setReference(item)}><Pencil size={14} aria-hidden="true" />Editar</button>] : []),
          ])} />
      </>}
      {page === 'families' && <Table columns={['Família', 'Unidade base']} rows={data.families.map(family => [
        <span className="cell-title">{family.name}</span>, data.units.find(unit => unit.familyId === family.id && unit.isBase)?.symbol ?? '—',
      ])} />}
      {page === 'units' && <Table columns={['Unidade', 'Família', { label: 'Fator', end: true }, 'Tipo']} rows={data.units.map(unit => [
        <span className="cell-title">{unit.symbol}</span>, data.families.find(family => family.id === unit.familyId)?.name,
        <span className="num">{decimal(unit.factor)}</span>, unit.isBase ? <Badge tone="brand">Base</Badge> : <span className="muted">Conversão</span>,
      ])} />}
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
  </>;
}
