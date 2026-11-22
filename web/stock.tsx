import { useState } from 'react';
import { ArrowLeftRight, ClipboardList, Download, Eye, FileSpreadsheet, PackageMinus, Plus, SlidersHorizontal } from 'lucide-react';
import { CommercialForm } from './product-form';
import {
  api, Badge, baseUnit, brl, by, dateTime, Field, fields, FileField, Filters, Form, Kit, Loading, matches, message, Modal, ModalForm, PageActions,
  Product, productOptions, quantity, SearchInput, Segmented, Select, sortParam, SortState, StockKit, StockProduct, StockView, Table, Tabs, Title, unitOptions, useClosePanel,
  useData, notify,
} from './ui';

type History = { id: string; product: Product; user: { name: string }; createdAt: string; quantity: string; unitCost: string | null; kind: string; reason: string; kit?: { sku: string } };
type HistoryPage = { movements: History[]; nextCursor: string | null };
type HistoryFilters = { productId?: string; kind?: string; from?: string; to?: string };
type CountPreview = { id: string; rows: { product: { sku: string; name: string; unit: Product['unit'] }; expected: string; counted: string; difference: string }[] };
type InitialPreview = {
  id: string;
  rows: ({ sku: string; name: string; unit: string; quantity: string; typeName: string; totalCost?: string; declaredCost: string | null; wastePercent?: string } & InitialRegistry)[];
  recipes: { product: string; input: string; quantity: string; unit: string }[];
  measures: { sku: string; name: string; value: string; unit: string }[];
};
type InitialRegistry = {
  minStock?: string; marginPercent?: string; salePrice?: string; lengthMm?: string; widthMm?: string; heightMm?: string; diameterMm?: string; purchaseUrl?: string;
  purchaseDate?: string; supplier?: string; purchaseExpenses?: string;
};
const dimensions = (row: InitialRegistry) => ([['C', row.lengthMm], ['L', row.widthMm], ['A', row.heightMm], ['Ø', row.diameterMm]] as const)
  .flatMap(([label, value]) => value ? [label + ' ' + quantity(value)] : []).join(' · ');
type Dialog = { kind: 'settings'; product: StockProduct } | { kind: 'movement'; product?: Product } | { kind: 'kit'; kit: Kit } | { kind: 'kitDetails'; kit: StockKit } | { kind: 'inventory' } | { kind: 'initial' };
const kinds = [{ id: 'OUT', name: 'Saída' }, { id: 'ADJUSTMENT', name: 'Ajuste' }] as const;
const labels: Record<string, string> = { PURCHASE: 'Compra', OUT: 'Saída', ADJUSTMENT: 'Ajuste', INITIAL: 'Carga inicial', KIT_OUT: 'Saída de kit', INVENTORY: 'Inventário', PRODUCTION_IN: 'Entrada de produção', PRODUCTION_OUT: 'Consumo de produção', PURCHASE_REVERSAL: 'Estorno de compra', PRODUCTION_ADJUST_IN: 'Correção de produção (entrada)', PRODUCTION_ADJUST_OUT: 'Correção de produção (saída)' };

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
      {tab === 'balances' && <Balances data={data} edit={edit} move={product => setDialog({ kind: 'movement', product })}
        configure={product => setDialog({ kind: 'settings', product })} />}
      {tab === 'kits' && <Kits data={data} edit={edit} out={kit => setDialog({ kind: 'kit', kit })} details={kit => setDialog({ kind: 'kitDetails', kit })} />}
      {tab === 'history' && <HistoryTab key={version} products={data.products} />}
    </>}

    {dialog?.kind === 'settings' && <Modal title={'Estoque e venda de ' + dialog.product.sku} subtitle={dialog.product.name} close={() => setDialog(undefined)}>
      <CommercialForm closeOnSave product={{ ...dialog.product, symbol: baseUnit(dialog.product).symbol }} saved={() => saved('Estoque e venda salvos.')} />
    </Modal>}
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

function Balances({ data, edit, move, configure }: {
  data: StockView; edit: boolean; move: (product: Product) => void; configure: (product: StockProduct) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'empty' | 'below'>('all');
  const rows = data.products.filter(product => matches(query, product.sku, product.name) &&
    (filter === 'all' || (filter === 'below' ? product.belowMinimum : Number(product.quantity) === 0)));
  return <div className="tab-panel" role="tabpanel">
    <div className="toolbar">
      <SearchInput value={query} onChange={setQuery} />
      <Segmented label="Saldo" value={filter} onChange={setFilter} options={[{ id: 'all', name: 'Todos' }, { id: 'below', name: 'Abaixo do mínimo' }, { id: 'empty', name: 'Sem saldo' }]} />
      <span className="summary">{data.products.length} produtos · <strong className="num">{brl(data.totalValue)}</strong> em estoque</span>
    </div>
    <Table empty={query || filter !== 'all' ? 'Nenhum produto encontrado.' : 'Nenhum produto ativo.'}
      columns={['Produto', { label: 'Saldo', end: true }, { label: 'Custo médio', end: true }, { label: 'Última compra', end: true },
        { label: 'Valor em estoque', end: true }, { label: 'Margem', end: true }, ...(edit ? [{ label: 'Ações', actions: true }] : [])]}
      rows={rows.map(product => [
        by(product.name, <Title name={product.name} code={product.sku} />),
        by(product.quantity, Number(product.quantity) === 0 ? <Badge tone="warn">Sem saldo</Badge> :
          <span><strong>{quantity(product.quantity)}</strong> <span className="muted">{baseUnit(product).symbol}</span>
            {Number(product.reserved) > 0 && <span className="hint" style={{ display: 'block' }}>{quantity(product.reserved!)} reservado</span>}
            {product.belowMinimum && <span style={{ display: 'block', marginTop: 4 }}><Badge tone="warn">Abaixo do mínimo</Badge></span>}</span>),
        by(product.currentCost, brl(product.currentCost)), by(product.lastPurchaseCost, <span className="muted">{brl(product.lastPurchaseCost)}
          {Number(product.lastPurchaseExpense) > 0 && <span className="hint" style={{ display: 'block' }}>+ {brl(product.lastPurchaseExpense)} de despesas</span>}
          {product.lastPurchaseAt && <span className="hint" style={{ display: 'block' }}>{new Date(product.lastPurchaseAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}{product.lastSupplier ? ' · ' + product.lastSupplier.name : ''}</span>}</span>),
        by(product.value, <strong>{brl(product.value)}</strong>),
        by(product.margin?.percent, product.margin ? <span>{product.margin.percent.startsWith('-') ? <Badge tone="warn">{quantity(product.margin.percent)}%</Badge> : <strong>{quantity(product.margin.percent)}%</strong>}
          <span className="hint" style={{ display: 'block' }}>Venda {brl(product.salePrice)}</span>
          {product.belowTargetMargin && <span style={{ display: 'block', marginTop: 4 }}><Badge tone="warn">Abaixo de {quantity(product.marginPercent)}%</Badge></span>}</span> : <span className="muted">—</span>),
        ...(edit ? [<div className="actions">
          <button type="button" className="btn secondary small" onClick={() => move(product)}><ArrowLeftRight size={14} aria-hidden="true" />Movimentar</button>
          <button type="button" className="btn ghost small" aria-label={'Parâmetros de ' + product.sku} onClick={() => configure(product)}>
            <SlidersHorizontal size={14} aria-hidden="true" />Parâmetros</button>
        </div>] : []),
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
          by(item.product.name, <Title name={item.product.name} code={item.product.sku} />),
          by(item.quantity, quantity(item.quantity) + ' ' + unit), by(item.product.quantity, quantity(item.product.quantity) + ' ' + unit),
          by(item.yields, <span>{quantity(item.yields)} {Number(item.yields) === 1 ? 'kit' : 'kits'}{Number(item.yields) === Number(kit.available) && <> <Badge tone="warn">Limita</Badge></>}</span>),
          by(item.product.currentCost, brl(item.product.currentCost)), by(item.cost, <strong>{brl(item.cost)}</strong>), by(item.share, percent(item.share)),
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
        by(kit.name, <Title name={kit.name} code={kit.sku} />),
        by(kit.components.length, <button type="button" className="btn ghost small" aria-label={'Ver componentes de ' + kit.sku} onClick={() => details(kit)}>
          <Eye size={14} aria-hidden="true" />{kit.components.length} {kit.components.length === 1 ? 'componente' : 'componentes'}</button>),
        by(kit.totalCost, <KitCost kit={kit} />),
        by(kit.available, Number(kit.available) > 0 ? <strong>{quantity(kit.available)}</strong> : <Badge tone="warn">Indisponível</Badge>),
        ...(edit ? [<button type="button" className="btn secondary small" disabled={Number(kit.available) <= 0} onClick={() => out(kit)}>
          <PackageMinus size={14} aria-hidden="true" />Dar saída</button>] : []),
      ])} />
  </div>;
}

function HistoryTab({ products }: { products: Product[] }) {
  const [filters, setFilters] = useState<HistoryFilters>({});
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const [sort, setSort] = useState<SortState>(null);
  const query = new URLSearchParams(Object.entries({ ...filters, cursor, sort: sortParam(sort) }).filter((entry): entry is [string, string] => !!entry[1]));
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
      sort={sort} onSort={next => { setSort(next); setCursors([]); }}
      columns={['Produto', { label: 'Movimento', sortKey: 'kind' }, { label: 'Quantidade', end: true, sortKey: 'quantity' }, { label: 'Custo', end: true }, 'Usuário',
        { label: 'Data', sortKey: 'createdAt' }, { label: 'Motivo', sortKey: 'reason' }]}
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

function MovementForm({ data, initial, saved }: { data: StockView; initial?: Product; saved: (message: string) => Promise<void> }) {
  const [kind, setKind] = useState<'OUT' | 'ADJUSTMENT'>('OUT');
  const [productId, setProduct] = useState(initial?.id ?? '');
  const [unitId, setUnit] = useState(initial?.unit.id ?? '');
  const [amount, setAmount] = useState('');
  const closePanel = useClosePanel();
  const product = data.products.find(item => item.id === productId);
  const units = data.units.filter(unit => unit.familyId === product?.unit.familyId);
  const submitLabel = { OUT: 'Registrar saída', ADJUSTMENT: 'Registrar ajuste' }[kind];
  const entersPieces = kind === 'ADJUSTMENT' && !amount.trim().startsWith('-') && Number(amount.replace(',', '.')) > 0;
  const needsAcknowledge = !!product?.type?.isManufactured && entersPieces;
  return <Form label={submitLabel} cancel="Cancelar" action={async values => {
    const { acknowledgeNoInputs, ...input } = fields(values);
    await api('stock/movements', { ...input, kind, ...(needsAcknowledge ? { acknowledgeNoInputs: !!acknowledgeNoInputs } : {}) });
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
      <Select key={productId} name="unitId" label="Unidade" defaultValue={unitId} options={unitOptions(units)} onChange={setUnit} />
    </div>
    <Field name="reason" label="Motivo" placeholder="Pedido, perda ou observação" />
    {needsAcknowledge && <div className="info stack" role="alert" key={productId + kind} style={{ gap: 8 }}>
      <span><strong>Esta entrada não baixa filamento nem outros insumos.</strong> Para produzir consumindo o estoque, use Produção → Ordens.</span>
      <label className="check"><input name="acknowledgeNoInputs" type="checkbox" required />Estou ciente e quero registrar mesmo assim</label>
    </div>}
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
        return [by(row.product.name, <Title name={row.product.name} code={row.product.sku} />), by(row.expected, quantity(row.expected) + ' ' + unit), by(row.counted, quantity(row.counted) + ' ' + unit),
          by(row.difference, <strong style={{ color: difference > 0 ? 'var(--ok)' : difference < 0 ? 'var(--danger)' : 'var(--muted)' }}>
            {difference > 0 ? '+ ' : ''}{quantity(row.difference)} {unit}</strong>)];
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
        by(row.name, <Title name={row.name} code={row.sku} />), row.typeName, by(row.quantity, quantity(row.quantity) + ' ' + row.unit), by(row.totalCost, brl(row.totalCost)),
        by(row.declaredCost, row.declaredCost === null ? '—' : brl(row.declaredCost) + ' / ' + row.unit), by(row.wastePercent, row.wastePercent ? quantity(row.wastePercent) + '%' : '—'),
      ])} />
    {preview.recipes.length > 0 && <>
      <h3>Fichas técnicas</h3>
      <Table columns={['Produto', 'Insumo', { label: 'Consumo por unidade', end: true }]}
        rows={preview.recipes.map(row => [row.product, row.input, by(row.quantity, quantity(row.quantity) + ' ' + row.unit)])} />
    </>}
    {preview.rows.some(row => row.minStock || row.marginPercent || row.salePrice || dimensions(row) || row.purchaseUrl) && <>
      <h3>Dados do cadastro</h3>
      <Table columns={['SKU', { label: 'Mínimo', end: true }, { label: 'Margem', end: true }, { label: 'Preço de venda', end: true }, 'Dimensões (mm)', 'URL de compra']}
        rows={preview.rows.filter(row => row.minStock || row.marginPercent || row.salePrice || dimensions(row) || row.purchaseUrl).map(row => [
          row.sku, by(row.minStock, row.minStock ? quantity(row.minStock) + ' ' + row.unit : '—'), by(row.marginPercent, row.marginPercent ? quantity(row.marginPercent) + '%' : '—'),
          by(row.salePrice, row.salePrice ? brl(row.salePrice) : '—'), dimensions(row) || '—', row.purchaseUrl ?? '—',
        ])} />
    </>}
    {preview.rows.some(row => row.purchaseDate || row.supplier || row.purchaseExpenses) && <>
      <h3>Dados da última compra</h3>
      <Table columns={['SKU', 'Data', 'Fornecedor', { label: 'Despesas', end: true }]}
        rows={preview.rows.filter(row => row.purchaseDate || row.supplier || row.purchaseExpenses).map(row => [
          row.sku, row.purchaseDate ? new Date(row.purchaseDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—', row.supplier ?? '—',
          by(row.purchaseExpenses, row.purchaseExpenses ? brl(row.purchaseExpenses) : '—'),
        ])} />
    </>}
    {preview.measures.length > 0 && <>
      <h3>Medidas extras</h3>
      <Table columns={['SKU', 'Medida', { label: 'Valor', end: true }]}
        rows={preview.measures.map(row => [row.sku, row.name, by(row.value, quantity(row.value) + ' ' + row.unit)])} />
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
      Para produtos fabricados, preencha a aba Ficha técnica com o consumo de uma unidade. Mínimo, margem, preço, dimensões, URL, dados da compra e a aba Medidas são opcionais. As despesas da compra ficam fora do custo médio.</div>
    <a className="btn secondary" style={{ alignSelf: 'flex-start' }} href="/api/stock/initial/template"><Download size={16} aria-hidden="true" />Baixar modelo</a>
    <Upload action={async file => { setPreview(undefined); setPreview(await api<InitialPreview>('stock/initial/preview', file)); }} />
  </div>;
}
