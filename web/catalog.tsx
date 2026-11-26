import { ReactNode, useState } from 'react';
import { ClipboardList, Eye, Pencil, Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { CatalogDetails, DetailTarget } from './catalog-details';
import { ProductFiles } from './product-files';
import { ProductImageField, ProductThumb } from './product-image';
import { CommercialSection, measureRows, technicalPayload, TechnicalFields } from './product-form';
import { RecipeEditor } from './recipe';
import { RegistrationData, referenceKinds } from './registrations';
import {
  api, applyFilters, Badge, baseUnit, brl, by, Field, fields, Form, Kit, Loading, matches, message, Modal, ModalForm, notify, PageActions, Product, productOptions,
  quantity, SearchInput, Segmented, Select, StockKit, StockView, Table, TableFilter, TableFilters, Title, unitOptions, useClosePanel, useData, yesNo, yesNoOptions,
} from './ui';

type CatalogView = StockView & RegistrationData;
type Situation = 'active' | 'inactive' | 'all';
type Status = { kind: 'products' | 'kits'; id: string; sku: string; active: boolean };
type Removal = { kind: Status['kind']; id: string; sku: string; block?: string | null; files?: number };

const productFilters = (data: CatalogView): TableFilter<CatalogView['products'][number]>[] => [
  { id: 'typeId', label: 'Tipo', options: data.productTypes, value: row => row.typeId },
  { id: 'unitId', label: 'Unidade', options: unitOptions(data.units), value: row => row.unit.id },
  ...referenceKinds.map(kind => ({
    id: kind.field, label: kind.name, options: data.references.filter(item => item.kind === kind.id),
    value: (row: Product) => row[kind.field],
  })),
  { id: 'hasRecipe', label: 'Ficha técnica', options: yesNoOptions, value: row => yesNo(!!row.hasRecipe) },
];
const kitFilters = (data: CatalogView): TableFilter<StockKit>[] => [
  { id: 'component', label: 'Produto componente', options: productOptions(data.products), value: row => row.components.map(item => item.productId) },
];
type Balance = { id: string; quantity: string; reserved: string; available: string; currentCost: string | null; value: string };
const balanceOptions = [{ id: 'available', name: 'Com saldo livre' }, { id: 'reserved', name: 'Com reserva' }, { id: 'empty', name: 'Sem saldo' }];
function balanceStates(balance?: Balance) {
  if (!balance || Number(balance.quantity) <= 0) return ['empty'];
  return [...(Number(balance.available) > 0 ? ['available'] : []), ...(Number(balance.reserved) > 0 ? ['reserved'] : [])];
}
const inputFilters = (data: CatalogView, balances?: Balance[]): TableFilter<CatalogView['products'][number]>[] => [
  { id: 'typeId', label: 'Tipo', options: data.productTypes.filter(type => type.isInput), value: row => row.typeId },
  ...referenceKinds.filter(kind => kind.id !== 'DEPARTAMENTO').map(kind => ({
    id: kind.field, label: kind.name, options: data.references.filter(item => item.kind === kind.id),
    value: (row: Product) => row[kind.field],
  })),
  ...(balances ? [{ id: 'balance', label: 'Saldo', options: balanceOptions, value: (row: Product) => balanceStates(balances.find(item => item.id === row.id)) }] : []),
];

export function Catalog({ page, edit, seeStock = false, editStock = false }: {
  page: 'products' | 'inputs' | 'kits'; edit: boolean; seeStock?: boolean; editStock?: boolean;
}) {
  const { data, error, loading, reload } = useData<CatalogView>('catalog');
  const { data: balances, error: balanceError } = useData<Balance[]>(page === 'inputs' && seeStock ? 'catalog/balances' : null);
  const [product, setProduct] = useState<Product | null>();
  const [kit, setKit] = useState<Kit | null>();
  const [status, setStatus] = useState<Status>();
  const [removal, setRemoval] = useState<Removal>();
  const [recipe, setRecipe] = useState<Product>();
  const [query, setQuery] = useState('');
  const [situation, setSituation] = useState<Situation>('active');
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<DetailTarget>();
  const detailsButton = (kind: DetailTarget['kind'], row: { id: string; sku: string }) => <button type="button" className="btn ghost small"
    aria-label={'Detalhes de ' + row.sku} onClick={() => setDetails({ kind, id: row.id, sku: row.sku })}><Eye size={14} aria-hidden="true" />Detalhes</button>;
  async function save(path: string, payload: unknown, id?: string) {
    await api('catalog/' + path + (id ? '/' + id : ''), payload, id ? 'PATCH' : 'POST');
    notify(id ? 'Alterações salvas.' : 'Cadastro criado.');
    await reload();
  }
  const visible = <T extends { active: boolean; sku: string; name: string }>(rows: T[]) => rows.filter(row =>
    matches(query, row.sku, row.name) && (situation === 'all' || row.active === (situation === 'active')));
  const situationBadge = (row: { active: boolean }) => by(row.active ? 'Ativo' : 'Inativo', row.active
    ? <Badge tone="ok"><span className="dot" />Ativo</Badge> : <Badge>Inativo</Badge>);
  const rowActions = (kind: Status['kind'], row: { id: string; sku: string; active: boolean; deleteBlock?: string | null; fileCount?: number }, open: () => void, extra?: ReactNode) => <div className="actions">
    <button type="button" className="btn secondary small" onClick={open}><Pencil size={14} aria-hidden="true" />Editar</button>
    {extra}
    <button type="button" className="btn ghost small" onClick={() => setStatus({ kind, id: row.id, sku: row.sku, active: !row.active })}>
      {row.active ? <PowerOff size={14} aria-hidden="true" /> : <Power size={14} aria-hidden="true" />}{row.active ? 'Inativar' : 'Reativar'}</button>
    <button type="button" className={'btn ghost small' + (row.deleteBlock ? ' unavailable' : '')} title={row.deleteBlock ?? undefined}
      onClick={() => setRemoval({ kind, id: row.id, sku: row.sku, block: row.deleteBlock, files: row.fileCount })}><Trash2 size={14} aria-hidden="true" />Excluir</button>
  </div>;

  return <>
    {edit && <PageActions>
      <button type="button" className="btn" onClick={() => page === 'products' ? setProduct(null) : setKit(null)}>
        <Plus size={16} aria-hidden="true" />{page === 'products' ? 'Novo produto' : 'Novo kit'}</button>
    </PageActions>}
    <div className="toolbar">
      <SearchInput value={query} onChange={setQuery} placeholder={page === 'kits' ? 'Buscar kit' : page === 'inputs' ? 'Buscar insumo' : 'Buscar por SKU ou nome'} />
      <Segmented label="Situação" value={situation} onChange={setSituation}
        options={[{ id: 'active', name: 'Ativos' }, { id: 'inactive', name: 'Inativos' }, { id: 'all', name: 'Todos' }]} />
    </div>
    {message(error ?? balanceError)}
    {!data ? loading && <Loading label="Carregando catálogo…" /> : <>
      {page === 'products' && <TableFilters filters={productFilters(data)} selected={selected} onChange={setSelected} />}
      {page === 'inputs' && <TableFilters key={balances ? 'stock' : 'plain'} filters={inputFilters(data, balances)} selected={selected} onChange={setSelected} />}
      {page === 'kits' && <TableFilters filters={kitFilters(data)} selected={selected} onChange={setSelected} />}
      {page === 'inputs' && <Table empty="Nenhum insumo encontrado."
        columns={['Insumo', 'Tipo', ...(balances ? [{ label: 'Saldo', end: true }, { label: 'Reservado', end: true }, { label: 'Custo médio', end: true }] : []), 'Situação', { label: 'Ações', actions: true }]}
        rows={applyFilters(visible(data.products.filter(row => data.productTypes.find(type => type.id === row.typeId)?.isInput)), inputFilters(data, balances), selected).map(row => {
          const balance = balances?.find(item => item.id === row.id);
          const symbol = baseUnit(row).symbol;
          return [
            by(row.name, <div className="product-cell"><ProductThumb product={row} /><Title name={row.name} code={row.sku} /></div>), data.productTypes.find(type => type.id === row.typeId)?.name ?? '—',
            ...(balances ? [by(balance?.quantity ?? '0', quantity(balance?.quantity ?? '0') + ' ' + symbol), by(balance?.reserved ?? '0', quantity(balance?.reserved ?? '0') + ' ' + symbol),
              by(balance?.currentCost, brl(balance?.currentCost))] : []),
            situationBadge(row), detailsButton('products', row),
          ];
        })} />}
      {page === 'products' && <Table empty="Nenhum produto encontrado."
        columns={['Produto', 'Tipo', ...(edit ? ['Unidade', 'Classificação'] : []), 'Situação', { label: 'Ações', actions: true }]}
        rows={applyFilters(visible(data.products), productFilters(data), selected).map(row => {
          const classes = referenceKinds.map(kind => data.references.find(item => item.id === row[kind.field])?.name).filter(Boolean);
          return [
            by(row.name, <div className="product-cell"><ProductThumb product={row} /><Title name={row.name} code={row.sku} /></div>), data.productTypes.find(type => type.id === row.typeId)?.name ?? '—',
            ...(edit ? [row.unit.symbol, by(classes.join(' '), <div className="actions">{classes.map(name => <Badge key={name}>{name}</Badge>)}</div>)] : []),
            situationBadge(row),
            edit ? rowActions('products', row, () => setProduct(row),
              data.productTypes.find(type => type.id === row.typeId)?.isManufactured &&
                <button type="button" className="btn secondary small" onClick={() => setRecipe(row)}><ClipboardList size={14} aria-hidden="true" />Ficha técnica</button>)
              : detailsButton('products', row),
          ];
        })} />}
      {page === 'kits' && <Table empty="Nenhum kit encontrado."
        columns={['Kit', edit ? 'Componentes' : 'Itens', 'Situação', { label: 'Ações', actions: true }]}
        rows={applyFilters(visible(data.kits), kitFilters(data), selected).map(row => [
          by(row.name, <Title name={row.name} code={row.sku} />),
          by(row.components.length, edit ? <span className="muted">{row.components.map(item => quantity(item.quantity) + ' ' + baseUnit(item.product).symbol + ' ' + item.product.sku).join(' · ')}</span>
            : row.components.length),
          situationBadge(row),
          edit ? rowActions('kits', row, () => setKit(row)) : detailsButton('kits', row),
        ])} />}
    </>}
    {details && <CatalogDetails target={details} close={() => setDetails(undefined)} />}

    {data && edit && product !== undefined && <Modal wide title={product ? 'Editar produto' : 'Novo produto'} subtitle={product?.sku} close={() => setProduct(undefined)}>
      <ProductForm data={data} product={product} editStock={editStock} save={payload => save('products', payload, product?.id)}
        savedStock={async () => { notify('Preço e estoque salvos.'); }} filesChanged={reload} />
    </Modal>}
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
    {data && edit && recipe && <Modal wide title={'Ficha técnica de ' + recipe.sku} subtitle={recipe.name} close={() => setRecipe(undefined)}>
      <RecipeEditor product={recipe} units={data.units} saved={async () => { notify('Ficha técnica salva.'); await reload(); }} />
    </Modal>}
    {edit && removal?.block && <Modal title={'Não é possível excluir ' + removal.sku} close={() => setRemoval(undefined)}>
      <p className="muted">{removal.block} Se o item saiu de linha, use Inativar para preservar o histórico.</p>
    </Modal>}
    {edit && removal && !removal.block && <ModalForm title={'Excluir ' + removal.sku} label="Excluir definitivamente" danger
      close={() => setRemoval(undefined)} action={async () => {
        await api('catalog/' + removal.kind + '/' + removal.id, undefined, 'DELETE');
        notify(removal.sku + ' excluído.');
        await reload();
      }}>
      <p className="muted">Esta ação não pode ser desfeita. O cadastro será removido, e a exclusão fica registrada na auditoria.</p>
      {!!removal.files && <div className="info" role="alert">{removal.files === 1 ? 'O arquivo anexado também será excluído.' : 'Os ' + removal.files + ' arquivos anexados também serão excluídos.'}</div>}
    </ModalForm>}
  </>;
}

/** Registry and technical data share one route. Stock and sale values have their own permission, route and save button. */
function ProductForm({ data, product, editStock, save, savedStock, filesChanged }: {
  data: CatalogView; product: Product | null; editStock: boolean; save: (body: unknown) => Promise<void>; savedStock: () => Promise<void>; filesChanged: () => Promise<void>;
}) {
  const [measures, setMeasures] = useState(() => measureRows(product));
  const closePanel = useClosePanel();
  const hasStockSection = !!product && editStock;
  return <div className="stack">
    <Form label={product ? 'Salvar cadastro' : 'Cadastrar produto'} cancel={hasStockSection ? 'Fechar' : 'Cancelar'} action={async values => {
      const input = fields(values);
      await save({
        sku: input.sku, name: input.name, typeId: input.typeId, unitId: input.unitId,
        ...Object.fromEntries(referenceKinds.map(kind => [kind.field, input[kind.field] || null])),
        ...technicalPayload(input, measures),
      });
      if (!hasStockSection) closePanel?.();
    }}>
      <h3>Identificação</h3>
      <Field name="sku" label="SKU" placeholder="Ex.: CX-KRAFT-2020" defaultValue={product?.sku} />
      <Field name="name" label="Nome do produto" defaultValue={product?.name} />
      <Select name="typeId" label="Tipo" options={data.productTypes}
        defaultValue={product?.typeId ?? data.productTypes.find(type => type.isDefault)?.id} />
      <Select name="unitId" label="Unidade" defaultValue={product?.unit.id}
        options={unitOptions(product?.deleteBlock ? data.units.filter(unit => unit.familyId === product.unit.familyId) : data.units)} />
      {product?.deleteBlock && <p className="hint">Como este produto já tem histórico, só aceita unidades da mesma família.</p>}
      <div className="form-grid">
        {referenceKinds.map(kind => <Select key={kind.id} name={kind.field} label={kind.name} required={false}
          defaultValue={product?.[kind.field] ?? undefined} options={data.references.filter(item => item.kind === kind.id)} />)}
      </div>
      <h3>Dados técnicos</h3>
      <TechnicalFields product={product} rows={measures} setRows={setMeasures} />
    </Form>
    {hasStockSection && <CommercialSection id={product.id} saved={savedStock} />}
    {product && <ProductImageField product={product} changed={filesChanged} />}
    {product && <ProductFiles productId={product.id} edit changed={filesChanged} />}
    {!product && <p className="hint">{editStock ? 'Mínimo, margem, preço, imagem e arquivos ficam' : 'A imagem e os arquivos ficam'} disponíveis depois de cadastrar o produto.</p>}
  </div>;
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
