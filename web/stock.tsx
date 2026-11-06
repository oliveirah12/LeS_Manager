import { useState } from 'react';
import {
  api, baseUnit, brl, dateTime, decimal, Field, fields, Form, message, Product, productOptions, Section, Select,
  StockView, Table, unitOptions, useData,
} from './ui';

type History = { product: Product; user: { name: string }; createdAt: string; quantity: string; unitCost: string | null; kind: string; reason: string; kit?: { sku: string } };
type CountPreview = { id: string; rows: { product: { sku: string; name: string; unit: Product['unit'] }; expected: string; counted: string; difference: string }[] };
type InitialPreview = { id: string; rows: { sku: string; name: string; unit: string; quantity: string; unitCost?: string }[] };
const kinds = [
  { id: 'PURCHASE', name: 'Entrada de compra' }, { id: 'OUT', name: 'Saída' }, { id: 'ADJUSTMENT', name: 'Ajuste manual' },
];
const labels: Record<string, string> = { PURCHASE: 'Compra', OUT: 'Saída', ADJUSTMENT: 'Ajuste', INITIAL: 'Carga inicial', KIT_OUT: 'Saída de kit', INVENTORY: 'Inventário' };

export function Stock({ edit, importInitial }: { edit: boolean; importInitial: boolean }) {
  const stock = useData<StockView>('stock');
  const history = useData<History[]>('stock/movements');
  const [notice, setNotice] = useState('');
  const data = stock.data;
  if (!data) return message(stock.error) || <p className="empty">Carregando estoque…</p>;
  async function saved(text: string) {
    setNotice(text);
    await Promise.all([stock.reload(), history.reload()]);
  }

  return <>
    {message(stock.error)}{notice && <p className="success" role="status">{notice}</p>}
    <Section title="Saldos de estoque" subtitle="Quantidades e custos exibidos na unidade base de cada família de medida.">
      <Table columns={['SKU', 'Produto', 'Saldo', 'Último custo por unidade base']} rows={data.products.map(item => [
        item.sku, item.name, decimal(item.quantity) + ' ' + baseUnit(item).symbol, brl(item.currentCost),
      ])} />
      {edit && <details open><summary>Registrar movimentação</summary><MovementForm data={data} saved={saved} /></details>}
    </Section>
    <Section title="Disponibilidade de kits">
      <Table columns={['SKU', 'Kit', 'Disponível']} rows={data.kits.map(item => [item.sku, item.name, decimal(item.available)])} />
      {edit && data.kits.length > 0 && <Form label="Dar saída em kit" reset action={async values => {
        const { kit, quantity, reason } = fields(values);
        await api('stock/kits/' + kit + '/out', { quantity, reason });
        await saved('Saída do kit registrada.');
      }}>
        <Select name="kit" label="Kit" options={data.kits} />
        <Field name="quantity" label="Quantidade de kits" />
        <Field name="reason" label="Motivo" />
      </Form>}
    </Section>
    {edit && <Inventory data={data} saved={saved} />}
    {importInitial && <InitialImport saved={saved} />}
    <Section title="Histórico" subtitle="Últimas 200 movimentações.">
      {message(history.error)}
      <Table columns={['Data', 'SKU', 'Movimento', 'Quantidade', 'Custo na data', 'Usuário', 'Motivo']} rows={(history.data ?? []).map(item => [
        dateTime(item.createdAt), item.product.sku, labels[item.kind], decimal(item.quantity) + ' ' + baseUnit(item.product).symbol,
        brl(item.unitCost), item.user.name, item.reason + (item.kit ? ' · ' + item.kit.sku : ''),
      ])} />
    </Section>
  </>;
}

function MovementForm({ data, saved }: { data: StockView; saved: (message: string) => Promise<void> }) {
  const [kind, setKind] = useState('');
  const [productId, setProduct] = useState('');
  const product = data.products.find(item => item.id === productId);
  return <Form label="Registrar movimentação" reset action={async values => {
    await api('stock/movements', fields(values));
    setKind(''); setProduct('');
    await saved('Movimentação registrada.');
  }}>
    <Select name="kind" label="Operação" options={kinds} onChange={setKind} />
    <Select name="productId" label="Produto" options={productOptions(data.products)} onChange={setProduct} />
    <Select key={productId} name="unitId" label="Unidade" defaultValue={product?.unit.id}
      options={unitOptions(data.units.filter(unit => unit.familyId === product?.unit.familyId))} />
    <Field name="quantity" label={kind === 'ADJUSTMENT' ? 'Variação (+ entrada / − saída)' : 'Quantidade'} />
    {kind === 'PURCHASE' && <Field name="unitCost" label="Custo por unidade informada (R$)" placeholder="0,00" />}
    <Field name="reason" label="Motivo" />
  </Form>;
}

function Upload({ action }: { action: (file: FormData) => Promise<void> }) {
  return <Form label="Gerar prévia da planilha" action={action}>
    <label>Arquivo Excel<input type="file" name="file" accept=".xlsx" required /></label>
  </Form>;
}

function Inventory({ data, saved }: { data: StockView; saved: (text: string) => Promise<void> }) {
  const [items, setItems] = useState<{ key: number; sku: string }[]>([{ key: 0, sku: '' }]);
  const [preview, setPreview] = useState<CountPreview>();
  return <Section title="Inventário físico" subtitle="Informe apenas os SKUs contados. Confira as diferenças antes de aplicar o inventário.">
    <div className="columns">
      <Form label="Conferir contagem manual" action={async values => {
        const input = fields(values);
        setPreview(await api<CountPreview>('stock/inventory/preview', {
          rows: items.map(({ key }) => ({ sku: input['sku' + key], quantity: input['qty' + key], unit: input['unit' + key] })),
        }));
      }}>
        {items.map(({ key, sku }, index) => {
          const product = data.products.find(item => item.sku === sku);
          return <div className="inline-row" key={key}>
            <Select name={'sku' + key} label={'SKU ' + (index + 1)}
              options={data.products.map(item => ({ id: item.sku, name: item.sku + ' · ' + item.name }))}
              onChange={value => setItems(rows => rows.map(row => row.key === key ? { key, sku: value } : row))} />
            <Field name={'qty' + key} label="Quantidade contada" />
            <Select key={sku} name={'unit' + key} label="Unidade" defaultValue={product?.unit.symbol}
              options={unitOptions(data.units.filter(unit => unit.familyId === product?.unit.familyId), true)} />
          </div>;
        })}
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setItems([...items, { key: items[items.length - 1].key + 1, sku: '' }])}>Adicionar SKU</button>
          {items.length > 1 && <button type="button" className="secondary" onClick={() => setItems(items.slice(0, -1))}>Remover último</button>}
        </div>
      </Form>
      <div>
        <a className="download" href="/api/stock/inventory/template">Baixar modelo de inventário</a>
        <Upload action={async file => setPreview(await api<CountPreview>('stock/inventory/upload', file))} />
      </div>
    </div>
    {preview && <div className="preview">
      <h3>Prévia da contagem</h3>
      <Table columns={['SKU', 'Produto', 'Unidade base', 'Saldo atual', 'Contagem', 'Diferença']} rows={preview.rows.map(row => [
        row.product.sku, row.product.name, baseUnit(row.product).symbol, decimal(row.expected), decimal(row.counted), decimal(row.difference),
      ])} />
      <Form key={preview.id} label="Confirmar inventário" action={async () => {
        await api('stock/inventory/' + preview.id + '/confirm', {}); setPreview(undefined); await saved('Inventário aplicado.');
      }}><button type="button" className="secondary" onClick={() => setPreview(undefined)}>Descartar prévia</button></Form>
    </div>}
  </Section>;
}

function InitialImport({ saved }: { saved: (text: string) => Promise<void> }) {
  const [preview, setPreview] = useState<InitialPreview>();
  return <Section title="Carga inicial por planilha" subtitle="Use SKUs novos, unidades e classificações já cadastradas. O custo é por unidade informada.">
    <a className="download" href="/api/stock/initial/template">Baixar modelo de carga inicial</a>
    <Upload action={async file => setPreview(await api<InitialPreview>('stock/initial/preview', file))} />
    {preview && <div className="preview">
      <h3>Prévia da carga inicial</h3>
      <Table columns={['SKU', 'Produto', 'Saldo informado', 'Custo']} rows={preview.rows.map(row => [
        row.sku, row.name, decimal(row.quantity) + ' ' + row.unit, brl(row.unitCost ?? null),
      ])} />
      <Form key={preview.id} label="Confirmar carga inicial" action={async () => {
        await api('stock/initial/' + preview.id + '/confirm', {}); setPreview(undefined); await saved('Produtos e saldos iniciais cadastrados.');
      }}><button type="button" className="secondary" onClick={() => setPreview(undefined)}>Descartar prévia</button></Form>
    </div>}
  </Section>;
}
