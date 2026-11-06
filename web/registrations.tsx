import { useState } from 'react';
import { api, decimal, Field, fields, Form, message, Section, Select, Table, Unit, useData } from './ui';

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
  const { data, error, reload } = useData<RegistrationData>('catalog/registrations');
  const [reference, setReference] = useState<Reference>();
  const [notice, setNotice] = useState('');
  if (!data) return message(error) || <p className="empty">Carregando cadastros…</p>;

  async function save(path: string, payload: unknown, id?: string) {
    await api('catalog/' + path + (id ? '/' + id : ''), payload, id ? 'PATCH' : 'POST');
    setNotice('Registro salvo.');
    await reload();
  }

  const kind = referenceKinds.find(item => item.id === page);
  return <>
    {message(error)}{notice && <p role="status" className="success">{notice}</p>}
    {kind && <Section title="Registros">
      <Table columns={['Nome', ...(edit ? ['Ação'] : [])]} rows={data.references.filter(item => item.kind === kind.id).map(item => [
        item.name, ...(edit ? [<button type="button" className="secondary" onClick={() => setReference(item)}>Editar</button>] : []),
      ])} />
      {edit && <Form key={reference?.id ?? kind.id} label={reference ? 'Salvar edição' : 'Cadastrar ' + kind.name.toLowerCase()} reset action={async values => {
        await save('references', { ...fields(values), kind: kind.id }, reference?.id); setReference(undefined);
      }}>
        <Field name="name" label={'Nome · ' + kind.name} defaultValue={reference?.name} />
        {reference && <button type="button" className="secondary" onClick={() => setReference(undefined)}>Cancelar edição</button>}
      </Form>}
    </Section>}
    {page === 'families' && <Section title="Famílias de medida" subtitle="Cada família tem uma unidade base, como g para peso.">
      <Table columns={['Família', 'Unidade base']} rows={data.families.map(family => [
        family.name, data.units.find(unit => unit.familyId === family.id && unit.isBase)?.symbol ?? '—',
      ])} />
      {admin && <Form label="Cadastrar família" reset action={values => save('families', fields(values))}>
        <Field name="name" label="Família" placeholder="Peso" />
        <Field name="baseSymbol" label="Símbolo base" placeholder="g" />
      </Form>}
    </Section>}
    {page === 'units' && <Section title="Unidades cadastradas" subtitle="O fator indica quantas unidades base equivalem a uma unidade cadastrada. Exemplo: 1 kg = 1000 g.">
      <Table columns={['Família', 'Unidade', 'Fator', 'Base']} rows={data.units.map(unit => [
        data.families.find(family => family.id === unit.familyId)?.name, unit.symbol, decimal(unit.factor), unit.isBase ? 'Sim' : '—',
      ])} />
      {admin && <Form label="Cadastrar unidade" reset action={values => save('units', fields(values))}>
        <Select name="familyId" label="Família" options={data.families} />
        <Field name="symbol" label="Símbolo" placeholder="kg" />
        <Field name="factor" label="Fator de conversão" placeholder="1000" />
      </Form>}
    </Section>}
  </>;
}
