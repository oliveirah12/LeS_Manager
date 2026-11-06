import { useState } from 'react';
import { api, baseUnit, decimal, Field, fields, Form, Kit, Loading, message, Modal, ModalForm, Product, productOptions, Section, Select, StockView, Table, unitOptions, useData } from './ui';

import { RegistrationData, referenceKinds } from './registrations';

type CatalogView = StockView & RegistrationData;

export function Catalog({ page, edit }: { page: 'products' | 'kits'; edit: boolean }) {
  const { data, error, reload } = useData<CatalogView>('catalog');
  const [product, setProduct] = useState<Product | null>();
  const [kit, setKit] = useState<Kit | null>();
  const [notice, setNotice] = useState('');
  if (!data) return message(error) || <Loading label="Carregando catálogo…" />;
  async function save(path: string, payload: unknown, id?: string) {
    await api('catalog/' + path + (id ? '/' + id : ''), payload, id ? 'PATCH' : 'POST');
    setNotice('Registro salvo.');
    await reload();
  }

  return <>
    {message(error)}{notice && <p className="success" role="status">{notice}</p>}
    {page === 'products' && <Section title="Lista de produtos" subtitle="Organize os itens por SKU, classificação e família de medida.">
      {edit && <button type="button" onClick={() => setProduct(null)}>Novo produto</button>}
      <Table columns={['SKU', 'Produto', 'Unidade', 'Classificação', ...(edit ? ['Ação'] : [])]} rows={data.products.map(row => [
        row.sku, row.name, row.unit.symbol,
        referenceKinds.map(kind => data.references.find(item => item.id === row[kind.field])?.name).filter(Boolean).join(' · ') || '—',
        ...(edit ? [<button type="button" className="secondary" onClick={() => setProduct(row)}>Editar</button>] : []),
      ])} />
      {edit && product !== undefined && <ModalForm title={product ? 'Editar produto ' + product.sku : 'Novo produto'}
        close={() => setProduct(undefined)} label="Salvar produto" action={async values => {
          const input = fields(values);
          await save('products', { ...input, ...Object.fromEntries(referenceKinds.map(kind => [kind.field, input[kind.field] || null])) }, product?.id);
        }}>
          {!product && <Field name="sku" label="SKU" />}
          <Field name="name" label="Nome do produto" defaultValue={product?.name} />
          {!product && <Select name="unitId" label="Unidade do produto" options={unitOptions(data.units)} />}
          {referenceKinds.map(kind => <Select key={kind.id} name={kind.field} label={kind.name} required={false}
            defaultValue={product?.[kind.field] ?? undefined} options={data.references.filter(item => item.kind === kind.id)} />)}
      </ModalForm>}
    </Section>}
    {page === 'kits' && <Section title="Lista de kits" subtitle="A composição usa itens já cadastrados no catálogo.">
      {edit && <button type="button" onClick={() => setKit(null)}>Novo kit</button>}
      <Table columns={['SKU', 'Kit', 'Componentes', ...(edit ? ['Ação'] : [])]} rows={data.kits.map(row => [
        row.sku, row.name, row.components.map(item => decimal(item.quantity) + ' ' + baseUnit(item.product).symbol + ' · ' + item.product.sku).join(' / '),
        ...(edit ? [<button type="button" className="secondary" onClick={() => setKit(row)}>Editar</button>] : []),
      ])} />
      {edit && kit !== undefined && <Modal title={kit ? 'Editar kit ' + kit.sku : 'Novo kit'} close={() => setKit(undefined)}>
        <KitForm key={kit?.id ?? 'new'} data={data} kit={kit ?? undefined} save={async payload => {
          await save('kits', payload, kit?.id); setKit(undefined);
        }} />
      </Modal>}
    </Section>}
  </>;
}

function KitForm({ data, kit, save }: { data: CatalogView; kit?: Kit; save: (body: unknown) => Promise<void> }) {
  const [components, setComponents] = useState(kit?.components.map(item => item.productId) ?? ['']);
  return <Form label="Salvar kit" reset={!kit} action={async values => {
    const input = fields(values);
    await save({ sku: input.sku, name: input.name, components: components.map((_, index) => ({
      productId: input['product' + index], unitId: input['unit' + index], quantity: input['quantity' + index],
    })) });
    setComponents(['']);
  }}>
    <Field name="sku" label="SKU do kit" defaultValue={kit?.sku} />
    <Field name="name" label="Nome do kit" defaultValue={kit?.name} />
    {components.map((productId, index) => {
      const product = data.products.find(item => item.id === productId);
      const units = data.units.filter(unit => unit.familyId === product?.unit.familyId);
      return <div className="inline-row" key={index}>
        <Select name={'product' + index} label={'Componente ' + (index + 1)} options={productOptions(data.products)}
          defaultValue={productId} onChange={value => setComponents(items => items.map((item, i) => i === index ? value : item))} />
        <Field name={'quantity' + index} label="Quantidade" defaultValue={kit?.components[index]?.quantity} />
        <Select key={productId} name={'unit' + index} label="Unidade" options={unitOptions(units)} defaultValue={product && baseUnit(product).id} />
      </div>;
    })}
    <div className="actions"><button type="button" className="secondary" onClick={() => setComponents([...components, ''])}>Adicionar componente</button>
      {components.length > 1 && <button type="button" className="secondary" onClick={() => setComponents(components.slice(0, -1))}>Remover último</button>}
    </div>
  </Form>;
}
