import { useState } from 'react';
import { ArrowLeftRight, ClipboardList, Download, Eye, FileSpreadsheet, PackageMinus, Plus } from 'lucide-react';
import {
  api, Badge, baseUnit, brl, dateTime, Field, fields, FileField, Filters, Form, Kit, Loading, matches, message, Modal, ModalForm, PageActions,
  Product, productOptions, quantity, SearchInput, Segmented, Select, StockKit, StockView, Table, Tabs, Title, unitOptions, useClosePanel,
  useData, notify,
} from './ui';

type History = { id: string; product: Product; user: { name: string }; createdAt: string; quantity: string; unitCost: string | null; kind: string; reason: string; kit?: { sku: string } };
type HistoryPage = { movements: History[]; nextCursor: string | null };
type HistoryFilters = { productId?: string; kind?: string; from?: string; to?: string };
type CountPreview = { id: string; rows: { product: { sku: string; name: string; unit: Product['unit'] }; expected: string; counted: string; difference: string }[] };
type InitialPreview = {
  id: string;
  rows: { sku: string; name: string; unit: string; quantity: string; typeName: string; totalCost?: string; declaredCost: string | null; wastePercent?: string }[];
  recipes: { product: string; input: string; quantity: string; unit: string }[];
};
type Dialog = { kind: 'movement'; product?: Product } | { kind: 'kit'; kit: Kit } | { kind: 'kitDetails'; kit: StockKit } | { kind: 'inventory' } | { kind: 'initial' };
const kinds = [{ id: 'PURCHASE', name: 'Compra' }, { id: 'OUT', name: 'Saída' }, { id: 'ADJUSTMENT', name: 'Ajuste' }] as const;
const labels: Record<string, string> = { PURCHASE: 'Compra', OUT: 'Saída', ADJUSTMENT: 'Ajuste', INITIAL: 'Carga inicial', KIT_OUT: 'Saída de kit', INVENTORY: 'Inventário', PRODUCTION_IN: 'Entrada de produção', PRODUCTION_OUT: 'Consumo de produção' };

export function Stock({ edit, importInitial }: { edit: boolean; importInitial: boolean }) {
  const stock = useData<StockView>('stock');
  const [tab, setTab] = useState<'balances' | 'kits' | 'history'>('balances');
  const [dialog, setDialog] = useState<Dialog>();
  const [version, setVersion] = useState(0);
  const data = stock.data;
  async function saved(text: string) {
    notify(text);
    setVersion(value => value + 1);
    await stock.reload();
  }

  return <>
    {edit && <PageActions>
      <button type="button" className="btn secondary" onClick={() => setDialog({ kind: 'inventory' })}><ClipboardList size={16} aria-hidden="true" />Inventário</button>
      {importInitial && <button type="button" className="btn secondary" onClick={() => setDialog({ kind: 'initial' })}><FileSpreadsheet size={16} aria-hidden="true" />Carga por planilha</button>}
      <button type="button" className="btn" onClick={() => setDialog({ kind: 'movement' })}><Plus size={16} aria-hidden="true" />Registrar movimentação</button>
    </PageActions>}
    <Tabs label="Seções do estoque" value={tab} onChange={setTab}
      tabs={[{ id: 'balances', name: 'Saldos' }, { id: 'kits', name: 'Kits' }, { id: 'history', name: 'Histórico' }]} />
    {message(stock.error)}
    {!data ? stock.loading && <Loading label="Carregando estoque…" /> : <>
      {tab === 'balances' && <Balances data={data} edit={edit} move={product => setDialog({ kind: 'movement', product })} />}
      {tab === 'kits' && <Kits data={data} edit={edit} out={kit => setDialog({ kind: 'kit', kit })} details={kit => setDialog({ kind: 'kitDetails', kit })} />}
      {tab === 'history' && <HistoryTab key={version} products={data.products} />}
    </>}

    {data && dialog?.kind === 'movement' && <Modal title="Registrar movimentação" close={() => setDialog(undefined)}>
      <MovementForm data={data} initial={dialog.product} saved={saved} /></Modal>}
    {data && dialog?.kind === 'kit' && <ModalForm title={'Saída do kit ' + dialog.kit.sku} subtitle={dialog.kit.name + ' · ' + quantity(dialog.kit.available) + ' disponíveis'}
      label="Confirmar saída" close={() => setDialog(undefined)} action={async values => {
        const { quantity: amount, reason } = fields(values);
        await api('stock/kits/' + dialog.kit.id + '/out', { quantity: amount, reason });
        await saved('Saída do kit registrada.');
      }}>
      <Field name="quantity" label="Quantidade de kits" inputMode="numeric" />
      <Field name="reason" label="Motivo" placeholder="Pedido, venda ou observação" />
    </ModalForm>}
    {dialog?.kind === 'kitDetails' && <Modal wide title={'Componentes de ' + dialog.kit.sku} subtitle={dialog.kit.name} close={() => setDialog(undefined)}>
      <KitDetails kit={dialog.kit} /></Modal>}
    {data && dialog?.kind === 'inventory' && <Modal wide title="Inventário físico" subtitle="Informe só os SKUs contados e confira as diferenças antes de aplicar."
      close={() => setDialog(undefined)}><Inventory data={data} saved={saved} /></Modal>}
    {dialog?.kind === 'initial' && <Modal wide title="Carga inicial por planilha" subtitle="Cadastra produtos novos com o saldo e o custo iniciais."
      close={() => setDialog(undefined)}><InitialImport saved={saved} /></Modal>}
  </>;
}

function Balances({ data, edit, move }: { data: StockView; edit: boolean; move: (product: Product) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'empty'>('all');
  const rows = data.products.filter(product => matches(query, product.sku, product.name) && (filter === 'all' || Number(product.quantity) === 0));
  return <div className="tab-panel" role="tabpanel">
    <div className="toolbar">
      <SearchInput value={query} onChange={setQuery} />
      <Segmented label="Saldo" value={filter} onChange={setFilter} options={[{ id: 'all', name: 'Todos' }, { id: 'empty', name: 'Sem saldo' }]} />
      <span className="summary">{data.products.length} produtos · <strong className="num">{brl(data.totalValue)}</strong> em estoque</span>
    </div>
    <Table empty={query || filter === 'empty' ? 'Nenhum produto encontrado.' : 'Nenhum produto ativo.'}
      columns={['Produto', { label: 'Saldo', end: true }, { label: 'Custo médio', end: true }, { label: 'Última compra', end: true },
        { label: 'Valor em estoque', end: true }, ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
      rows={rows.map(product => [
        <Title name={product.name} code={product.sku} />,
        Number(product.quantity) === 0 ? <Badge tone="warn">Sem saldo</Badge> :
          <span><strong>{quantity(product.quantity)}</strong> <span className="muted">{baseUnit(product).symbol}</span>
            {Number(product.reserved) > 0 && <span className="hint" style={{ display: 'block' }}>{quantity(product.reserved!)} reservado</span>}</span>,
        brl(product.currentCost), <span className="muted">{brl(product.lastPurchaseCost)}</span>,
        <strong>{brl(product.value)}</strong>,
        ...(edit ? [<button type="button" className="btn secondary small" onClick={() => move(product)}><ArrowLeftRight size={14} aria-hidden="true" />Movimentar</button>] : []),
      ])} />
  </div>;
}

function KitCost({ kit }: { kit: StockKit }) {
  return <span><strong>{brl(kit.totalCost)}</strong>{kit.partialCost && <> <Badge tone="warn">Parcial</Badge></>}</span>;
}

function KitDetails({ kit }: { kit: StockKit }) {
  const percent = (value: string | null) => value === null ? '—' : Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%';
  return <div className="stack">
    {kit.partialCost && <div className="info">Há componente sem custo registrado, então o total considera apenas os demais.</div>}
    <Table columns={['Componente', { label: 'Por kit', end: true }, { label: 'Saldo', end: true }, { label: 'Rende', end: true },
      { label: 'Custo médio', end: true }, { label: 'Custo no kit', end: true }, { label: '% do kit', end: true }]}
      rows={kit.components.map(item => {
        const unit = baseUnit(item.product).symbol;
        return [
          <Title name={item.product.name} code={item.product.sku} />,
          quantity(item.quantity) + ' ' + unit, quantity(item.product.quantity) + ' ' + unit,
          <span>{quantity(item.yields)} {Number(item.yields) === 1 ? 'kit' : 'kits'}{Number(item.yields) === Number(kit.available) && <> <Badge tone="warn">Limita</Badge></>}</span>,
          brl(item.product.currentCost), <strong>{brl(item.cost)}</strong>, percent(item.share),
        ];
      })}
      footer={<>
        <span>Dá para montar <strong>{quantity(kit.available)}</strong> {Number(kit.available) === 1 ? 'kit' : 'kits'}</span>
        <span>Custo total: <KitCost kit={kit} /></span>
      </>} />
  </div>;
}

function Kits({ data, edit, out, details }: { data: StockView; edit: boolean; out: (kit: Kit) => void; details: (kit: StockKit) => void }) {
  const [query, setQuery] = useState('');
  const rows = data.kits.filter(kit => matches(query, kit.sku, kit.name));
  return <div className="tab-panel" role="tabpanel">
    <div className="toolbar"><SearchInput value={query} onChange={setQuery} placeholder="Buscar kit" /></div>
    <Table empty="Nenhum kit ativo."
      columns={['Kit', 'Componentes', { label: 'Custo total', end: true }, { label: 'Disponível', end: true }, ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
      rows={rows.map(kit => [
        <Title name={kit.name} code={kit.sku} />,
        <button type="button" className="btn ghost small" aria-label={'Ver componentes de ' + kit.sku} onClick={() => details(kit)}>
          <Eye size={14} aria-hidden="true" />{kit.components.length} {kit.components.length === 1 ? 'componente' : 'componentes'}</button>,
        <KitCost kit={kit} />,
        Number(kit.available) > 0 ? <strong>{quantity(kit.available)}</strong> : <Badge tone="warn">Indisponível</Badge>,
        ...(edit ? [<button type="button" className="btn secondary small" disabled={Number(kit.available) <= 0} onClick={() => out(kit)}>
          <PackageMinus size={14} aria-hidden="true" />Dar saída</button>] : []),
      ])} />
  </div>;
}

function HistoryTab({ products }: { products: Product[] }) {
  const [filters, setFilters] = useState<HistoryFilters>({});
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const query = new URLSearchParams(Object.entries({ ...filters, cursor }).filter((entry): entry is [string, string] => !!entry[1]));
  const history = useData<HistoryPage>('stock/movements' + (query.size ? '?' + query : ''));
  const active = Object.values(filters).filter(Boolean).length;
  return <div className="tab-panel" role="tabpanel">
    <Filters active={active} apply={values => { setFilters(values); setCursors([]); }} clear={() => { setFilters({}); setCursors([]); }}>
      <Select name="productId" label="Produto" required={false} placeholder="Todos" options={productOptions(products)} />
      <Select name="kind" label="Movimento" required={false} placeholder="Todos" options={Object.entries(labels).map(([id, name]) => ({ id, name }))} />
      <Field name="from" label="De" type="date" required={false} />
      <Field name="to" label="Até" type="date" required={false} />
    </Filters>
    {message(history.error)}
    {history.loading && !history.data ? <Loading label="Carregando movimentações…" /> : history.data && <Table empty="Nenhuma movimentação encontrada."
      columns={['Produto', 'Movimento', { label: 'Quantidade', end: true }, { label: 'Custo', end: true }, 'Usuário', 'Data', 'Motivo']}
      rows={history.data.movements.map(item => [
        <Title name={item.product.name} code={item.product.sku} />,
        labels[item.kind] + (item.kit ? ' · ' + item.kit.sku : ''),
        <strong style={{ color: item.quantity.startsWith('-') ? undefined : 'var(--ok)' }}>
          {item.quantity.startsWith('-') ? '' : '+ '}{quantity(item.quantity)} {baseUnit(item.product).symbol}</strong>,
        brl(item.unitCost), item.user.name, dateTime(item.createdAt), <span className="muted">{item.reason}</span>,
      ])}
      footer={(cursor || history.data.nextCursor) && <>
        <span>Página {cursors.length + 1}</span>
        <div className="actions">
          <button type="button" className="btn secondary small" disabled={!cursor} onClick={() => setCursors(cursors.slice(0, -1))}>Anterior</button>
          <button type="button" className="btn secondary small" disabled={!history.data.nextCursor}
            onClick={() => setCursors([...cursors, history.data!.nextCursor!])}>Próxima</button>
        </div>
      </>} />}
  </div>;
}

/** Moving weighted average after a purchase, in base units. Display only: the backend computes the stored value. */
function previewAverage(product: Product, amount: number, unitCost: number) {
  const balance = Number(product.quantity);
  const current = product.currentCost === null ? null : Number(product.currentCost);
  if (!(amount > 0) || !(unitCost >= 0)) return null;
  if (current === null || balance <= 0) return unitCost;
  return (balance * current + amount * unitCost) / (balance + amount);
}

function MovementForm({ data, initial, saved }: { data: StockView; initial?: Product; saved: (message: string) => Promise<void> }) {
  const [kind, setKind] = useState<'PURCHASE' | 'OUT' | 'ADJUSTMENT'>('PURCHASE');
  const [productId, setProduct] = useState(initial?.id ?? '');
  const [unitId, setUnit] = useState(initial?.unit.id ?? '');
  const [amount, setAmount] = useState('');
  const [total, setTotal] = useState('');
  const closePanel = useClosePanel();
  const product = data.products.find(item => item.id === productId);
  const units = data.units.filter(unit => unit.familyId === product?.unit.familyId);
  const unit = units.find(item => item.id === unitId) ?? product?.unit;
  const factor = Number(unit?.factor ?? 1);
  const informed = Number(amount.replace(',', '.'));
  const paid = Number(total.replace(',', '.'));
  const average = kind === 'PURCHASE' && product && total.trim()
    ? previewAverage(product, informed * factor, paid / (informed * factor)) : null;
  const submitLabel = { PURCHASE: 'Registrar compra', OUT: 'Registrar saída', ADJUSTMENT: 'Registrar ajuste' }[kind];
  return <Form label={submitLabel} cancel="Cancelar" action={async values => {
    await api('stock/movements', { ...fields(values), kind });
    await saved('Movimentação registrada.');
    closePanel?.();
  }}>
    <fieldset>
      <legend className="sr-only">Operação</legend>
      <div className="choice-grid">{kinds.map(item => <button type="button" key={item.id} aria-pressed={kind === item.id}
        onClick={() => setKind(item.id)}>{item.name}</button>)}</div>
    </fieldset>
    <Select name="productId" label="Produto" defaultValue={initial?.id} options={productOptions(data.products)}
      onChange={id => { setProduct(id); setUnit(data.products.find(item => item.id === id)?.unit.id ?? ''); }} />
    {product && <p className="hint">Saldo atual: <strong>{quantity(product.quantity)} {baseUnit(product).symbol}</strong> · custo médio {brl(product.currentCost)}
      {Number(product.reserved) > 0 && <> · <strong>{quantity(product.reserved!)} {baseUnit(product).symbol}</strong> reservado para impressão</>}</p>}
    <div className="form-grid">
      <label>{kind === 'ADJUSTMENT' ? 'Variação (+ entrada / − saída)' : 'Quantidade'}
        <input name="quantity" inputMode="decimal" required value={amount} onChange={event => setAmount(event.target.value)} /></label>
      <label>Unidade<select key={productId} name="unitId" required value={unitId} onChange={event => setUnit(event.target.value)}>
        <option value="">Selecione</option>
        {unitOptions(units).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select></label>
    </div>
    {kind === 'PURCHASE' && <label>Custo total da compra (R$)
      <input name="totalCost" inputMode="decimal" required placeholder="0,00" value={total} onChange={event => setTotal(event.target.value)} />
      {average !== null && product && <span className="hint"><strong className="num">{brl(paid / informed)}</strong> por {unit?.symbol} · novo custo
        médio <strong className="num">{brl(average)}</strong> por {baseUnit(product).symbol}</span>}
    </label>}
    <Field name="reason" label="Motivo" placeholder="Nota fiscal, pedido ou observação" />
  </Form>;
}

function Upload({ action, disabled }: { action: (file: FormData) => Promise<void>; disabled?: boolean }) {
  return <Form label="Gerar prévia" action={action} disabled={disabled}>
    <FileField name="file" label="Arquivo Excel (.xlsx)" accept=".xlsx" />
  </Form>;
}

function Inventory({ data, saved }: { data: StockView; saved: (text: string) => Promise<void> }) {
  const [items, setItems] = useState<{ key: number; sku: string }[]>([{ key: 0, sku: '' }]);
  const [preview, setPreview] = useState<CountPreview>();
  const [previewing, setPreviewing] = useState(false);
  const closePanel = useClosePanel();
  async function generate(path: string, payload: unknown) {
    setPreview(undefined);
    setPreviewing(true);
    try { setPreview(await api<CountPreview>(path, payload)); }
    finally { setPreviewing(false); }
  }
  if (preview) return <div className="stack">
    <div className="section-head"><div><h3>Prévia da contagem</h3><p>Só os produtos com diferença serão ajustados.</p></div></div>
    <Table columns={['Produto', { label: 'Saldo atual', end: true }, { label: 'Contagem', end: true }, { label: 'Diferença', end: true }]}
      rows={preview.rows.map(row => {
        const unit = baseUnit(row.product).symbol;
        const difference = Number(row.difference);
        return [<Title name={row.product.name} code={row.product.sku} />, quantity(row.expected) + ' ' + unit, quantity(row.counted) + ' ' + unit,
          <strong style={{ color: difference > 0 ? 'var(--ok)' : difference < 0 ? 'var(--danger)' : 'var(--muted)' }}>
            {difference > 0 ? '+ ' : ''}{quantity(row.difference)} {unit}</strong>];
      })} />
    <Form key={preview.id} label="Aplicar inventário" extra={<button type="button" className="btn secondary" onClick={() => setPreview(undefined)}>Voltar</button>}
      action={async () => {
        await api('stock/inventory/' + preview.id + '/confirm', {});
        await saved('Inventário aplicado.');
        closePanel?.();
      }} />
  </div>;
  return <div className="stack">
    <section className="stack">
      <h3>Contagem manual</h3>
      <Form label="Conferir contagem" disabled={previewing} action={async values => {
        const input = fields(values);
        await generate('stock/inventory/preview', {
          rows: items.map(({ key }) => ({ sku: input['sku' + key], quantity: input['qty' + key], unit: input['unit' + key] })),
        });
      }} extra={<>
        <button type="button" className="btn secondary" onClick={() => setItems([...items, { key: items[items.length - 1].key + 1, sku: '' }])}>
          <Plus size={16} aria-hidden="true" />Adicionar SKU</button>
        {items.length > 1 && <button type="button" className="btn ghost" onClick={() => setItems(items.slice(0, -1))}>Remover último</button>}
      </>}>
        {items.map(({ key, sku }, index) => {
          const product = data.products.find(item => item.sku === sku);
          return <div className="component-row" key={key}>
            <Select name={'sku' + key} label={'Produto ' + (index + 1)} options={data.products.map(item => ({ id: item.sku, name: item.sku + ' · ' + item.name }))}
              onChange={value => setItems(rows => rows.map(row => row.key === key ? { key, sku: value } : row))} />
            <Field name={'qty' + key} label="Contagem" inputMode="decimal" />
            <Select key={sku} name={'unit' + key} label="Unidade" defaultValue={product?.unit.symbol}
              options={unitOptions(data.units.filter(unit => unit.familyId === product?.unit.familyId), true)} />
          </div>;
        })}
      </Form>
    </section>
    <section className="preview-box">
      <div className="section-head"><h3>Ou envie a planilha</h3>
        <a className="btn ghost small" href="/api/stock/inventory/template"><Download size={14} aria-hidden="true" />Baixar modelo</a></div>
      <Upload disabled={previewing} action={file => generate('stock/inventory/upload', file)} />
    </section>
  </div>;
}

function InitialImport({ saved }: { saved: (text: string) => Promise<void> }) {
  const [preview, setPreview] = useState<InitialPreview>();
  const closePanel = useClosePanel();
  if (preview) return <div className="stack">
    <div className="section-head"><div><h3>Prévia da carga inicial</h3><p>{preview.rows.length} produtos novos serão cadastrados.</p></div></div>
    <Table columns={['Produto', 'Tipo', { label: 'Saldo informado', end: true }, { label: 'Custo total', end: true }, { label: 'Custo por unidade', end: true }, { label: 'Perda', end: true }]}
      rows={preview.rows.map(row => [
        <Title name={row.name} code={row.sku} />, row.typeName, quantity(row.quantity) + ' ' + row.unit, brl(row.totalCost),
        row.declaredCost === null ? '—' : brl(row.declaredCost) + ' / ' + row.unit, row.wastePercent ? quantity(row.wastePercent) + '%' : '—',
      ])} />
    {preview.recipes.length > 0 && <>
      <h3>Fichas técnicas</h3>
      <Table columns={['Produto', 'Insumo', { label: 'Consumo por unidade', end: true }]}
        rows={preview.recipes.map(row => [row.product, row.input, quantity(row.quantity) + ' ' + row.unit])} />
    </>}
    <Form key={preview.id} label="Confirmar carga inicial" extra={<button type="button" className="btn secondary" onClick={() => setPreview(undefined)}>Voltar</button>}
      action={async () => {
        await api('stock/initial/' + preview.id + '/confirm', {});
        await saved('Produtos e saldos iniciais cadastrados.');
        closePanel?.();
      }} />
  </div>;
  return <div className="stack">
    <div className="info">Use SKUs novos e os tipos, unidades e classificações da aba Listas. Informe o custo total da linha, e o sistema calcula o valor por unidade.
      Para produtos fabricados, preencha a aba Ficha técnica com o consumo de uma unidade.</div>
    <a className="btn secondary" style={{ alignSelf: 'flex-start' }} href="/api/stock/initial/template"><Download size={16} aria-hidden="true" />Baixar modelo</a>
    <Upload action={async file => { setPreview(undefined); setPreview(await api<InitialPreview>('stock/initial/preview', file)); }} />
  </div>;
}
