import { useState } from 'react';
import { api, baseUnit, decimal, Field, fields, Form, Kit, message, Product, productOptions, Section, Select, StockView, Table, unitOptions, useData } from './ui';

import { RegistrationData, referenceKinds } from './registrations';

type CatalogView = StockView & RegistrationData;

export function Catalog({ page, edit }: { page: 'products' | 'kits'; edit: boolean }) {
  const { data, error, reload } = useData<CatalogView>('catalog');
  const [product, setProduct] = useState<Product>();
  const [kit, setKit] = useState<Kit>();
  const [notice, setNotice] = useState('');
  if (!data) return message(error) || <p className="empty">Carregando catálogo…</p>;
  async function save(path: string, payload: unknown, id?: string) {
    await api('catalog/' + path + (id ? '/' + id : ''), payload, id ? 'PATCH' : 'POST');
    setNotice('Registro salvo.');
    await reload();
  }

  return <>
    {message(error)}{notice && <p className="success" role="status">{notice}</p>}
    {page === 'products' && <Section title="Lista de produtos" subtitle="Organize os itens por SKU, classificação e família de medida.">
      <Table columns={['SKU', 'Produto', 'Unidade', 'Classificação', ...(edit ? ['Ação'] : [])]} rows={data.products.map(row => [
        row.sku, row.name, row.unit.symbol,
        referenceKinds.map(kind => data.references.find(item => item.id === row[kind.field])?.name).filter(Boolean).join(' · ') || '—',
        ...(edit ? [<button type="button" className="secondary" onClick={() => setProduct(row)}>Editar</button>] : []),
      ])} />
      {edit && <details open><summary>{product ? 'Editar produto ' + product.sku : 'Novo produto'}</summary>
        <Form key={product?.id ?? 'new'} label="Salvar produto" reset={!product} action={async values => {
          const input = fields(values);
          await save('products', { ...input, ...Object.fromEntries(referenceKinds.map(kind => [kind.field, input[kind.field] || null])) }, product?.id);
          setProduct(undefined);
        }}>
          {!product && <Field name="sku" label="SKU" />}
          <Field name="name" label="Nome do produto" defaultValue={product?.name} />
          {!product && <Select name="unitId" label="Unidade do produto" options={unitOptions(data.units)} />}
          {referenceKinds.map(kind => <Select key={kind.id} name={kind.field} label={kind.name} required={false}
            defaultValue={product?.[kind.field] ?? undefined} options={data.references.filter(item => item.kind === kind.id)} />)}
          {product && <button type="button" className="secondary" onClick={() => setProduct(undefined)}>Cancelar edição</button>}
        </Form>
      </details>}
    </Section>}
    {page === 'kits' && <Section title="Lista de kits" subtitle="A composição usa itens já cadastrados no catálogo.">
      <Table columns={['SKU', 'Kit', 'Componentes', ...(edit ? ['Ação'] : [])]} rows={data.kits.map(row => [
        row.sku, row.name, row.components.map(item => decimal(item.quantity) + ' ' + baseUnit(item.product).symbol + ' · ' + item.product.sku).join(' / '),
        ...(edit ? [<button type="button" className="secondary" onClick={() => setKit(row)}>Editar</button>] : []),
      ])} />
      {edit && <details open><summary>{kit ? 'Editar kit ' + kit.sku : 'Novo kit'}</summary>
        <KitForm key={kit?.id ?? 'new'} data={data} kit={kit} cancel={() => setKit(undefined)} save={async payload => {
          await save('kits', payload, kit?.id); setKit(undefined);
        }} />
      </details>}
    </Section>}
  </>;
}

function KitForm({ data, kit, cancel, save }: { data: CatalogView; kit?: Kit; cancel: () => void; save: (body: unknown) => Promise<void> }) {
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
      {kit && <button type="button" className="secondary" onClick={cancel}>Cancelar edição</button>}
    </div>
  </Form>;
}
