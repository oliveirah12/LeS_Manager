import { Badge, brl, dateTime, Loading, message, Modal, quantity, Table, Title, useData } from './ui';

type Named = { sku: string; name: string; active: boolean; quantity: string };
type ProductDetails = {
  sku: string; name: string; active: boolean; symbol: string; type: { name: string; isInput: boolean; isManufactured: boolean };
  kits: Named[];
  recipe: { wastePercent: string; inputs: { sku: string; name: string; symbol: string; quantity: string }[]; usedIn: Named[] } | null;
  orders: { number: number; status: 'PLANNED' | 'PRINTING'; planned: string }[] | null;
  stock: {
    quantity: string; reserved: string; available: string; currentCost: string | null; value: string; lastPurchaseCost: string | null;
    minStock: string | null; belowMinimum: boolean; salePrice: string | null; margin: { profit: string; percent: string } | null;
    lastMovement: { kind: string; quantity: string; createdAt: string } | null;
    purchases: { quantity: string; unitCost: string | null; createdAt: string }[];
    estimate: { unitCost: string; partialCost: boolean; producible: string; limiting: string } | null;
  } | null;
};
type KitDetails = {
  sku: string; name: string; active: boolean;
  components: { productId: string; sku: string; name: string; symbol: string; quantity: string; cost?: string | null; yields?: string }[];
  stock: { totalCost: string; partialCost: boolean; available: string; limiting: string | null } | null;
};
export type DetailTarget = { kind: 'products' | 'kits'; id: string; sku: string };

const movementNames: Record<string, string> = {
  INITIAL: 'Carga inicial', PURCHASE: 'Compra', OUT: 'Saída', ADJUSTMENT: 'Ajuste', KIT_OUT: 'Saída de kit', INVENTORY: 'Inventário',
  PRODUCTION_IN: 'Entrada de produção', PRODUCTION_OUT: 'Consumo de produção',
};
const orderNames = { PLANNED: 'Planejada', PRINTING: 'Em impressão' };

export function CatalogDetails({ target, close }: { target: DetailTarget; close: () => void }) {
  return <Modal wide title={'Detalhes de ' + target.sku} close={close}>
    {target.kind === 'products' ? <ProductPanel id={target.id} /> : <KitPanel id={target.id} />}
  </Modal>;
}

function ProductPanel({ id }: { id: string }) {
  const { data, error, loading } = useData<ProductDetails>('catalog/products/' + id + '/details');
  if (!data) return <>{message(error)}{loading && <Loading label="Carregando detalhes…" />}</>;
  const { stock, recipe, symbol } = data;
  const amount = (value: string) => quantity(value) + ' ' + symbol;
  return <div className="stack">
    <dl className="dl">
      <div><dt>Produto</dt><dd>{data.name}</dd></div>
      <div><dt>Tipo</dt><dd>{data.type.name}</dd></div>
      <div><dt>Situação</dt><dd>{data.active ? 'Ativo' : 'Inativo'}</dd></div>
      {stock && <>
        <div><dt>Saldo</dt><dd>{amount(stock.quantity)}</dd></div>
        <div><dt>Reservado</dt><dd>{amount(stock.reserved)}</dd></div>
        <div><dt>Disponível</dt><dd>{amount(stock.available)}</dd></div>
        <div><dt>Estoque mínimo</dt><dd>{stock.minStock === null ? '—' : amount(stock.minStock)}{stock.belowMinimum && <> <Badge tone="warn">Abaixo</Badge></>}</dd></div>
        <div><dt>Custo médio</dt><dd>{brl(stock.currentCost)}</dd></div>
        <div><dt>Valor em estoque</dt><dd>{brl(stock.value)}</dd></div>
        <div><dt>Última compra</dt><dd>{brl(stock.lastPurchaseCost)}</dd></div>
        <div><dt>Preço de venda</dt><dd>{brl(stock.salePrice)}</dd></div>
        <div><dt>Margem</dt><dd>{stock.margin ? quantity(stock.margin.percent) + '% · ' + brl(stock.margin.profit) + ' por ' + symbol : '—'}</dd></div>
        <div><dt>Última movimentação</dt><dd>{stock.lastMovement
          ? (movementNames[stock.lastMovement.kind] ?? stock.lastMovement.kind) + ' · ' + dateTime(stock.lastMovement.createdAt) : '—'}</dd></div>
      </>}
    </dl>
    {stock?.estimate && <>
      <h3>Produção estimada</h3>
      {stock.estimate.partialCost && <div className="info" role="alert">Há insumo sem custo registrado, então o custo considera apenas os demais.</div>}
      <dl className="dl">
        <div><dt>Insumos por peça, com perda</dt><dd>≈ {brl(stock.estimate.unitCost)}</dd></div>
        <div><dt>Dá para produzir</dt><dd>{quantity(stock.estimate.producible)} {symbol}</dd></div>
        <div><dt>Insumo limitante</dt><dd>{stock.estimate.limiting}</dd></div>
      </dl>
      <p className="hint">Não inclui máquina e energia, que dependem da impressora e do tempo de cada ordem.</p>
    </>}
    {recipe && recipe.inputs.length > 0 && <>
      <h3>Ficha técnica · perda de {quantity(recipe.wastePercent)}%</h3>
      <Table responsive={false} columns={['Insumo', { label: 'Por peça', end: true }]}
        rows={recipe.inputs.map(row => [<Title name={row.name} code={row.sku} />, quantity(row.quantity) + ' ' + row.symbol])} />
    </>}
    {recipe && recipe.usedIn.length > 0 && <>
      <h3>Produtos que consomem</h3>
      <Table responsive={false} columns={['Produto', { label: 'Por peça', end: true }]}
        rows={recipe.usedIn.map(row => [<Title name={row.name} code={row.sku} />, amount(row.quantity)])} />
    </>}
    {data.kits.length > 0 && <>
      <h3>Kits que usam</h3>
      <Table responsive={false} columns={['Kit', { label: 'Quantidade', end: true }]}
        rows={data.kits.map(row => [<Title name={row.name} code={row.sku} />, amount(row.quantity)])} />
    </>}
    {!!data.orders?.length && <>
      <h3>Ordens em andamento</h3>
      <Table responsive={false} columns={['Ordem', 'Situação', { label: 'Previsto', end: true }]}
        rows={data.orders.map(row => ['#' + row.number, <Badge tone={row.status === 'PRINTING' ? 'brand' : undefined}>{orderNames[row.status]}</Badge>, amount(row.planned)])} />
    </>}
    {!!stock?.purchases.length && <>
      <h3>Últimas compras</h3>
      <Table responsive={false} columns={['Data', { label: 'Quantidade', end: true }, { label: 'Custo unitário', end: true }]}
        rows={stock.purchases.map(row => [dateTime(row.createdAt), amount(row.quantity), brl(row.unitCost)])} />
    </>}
  </div>;
}

function KitPanel({ id }: { id: string }) {
  const { data, error, loading } = useData<KitDetails>('catalog/kits/' + id + '/details');
  if (!data) return <>{message(error)}{loading && <Loading label="Carregando detalhes…" />}</>;
  const { stock } = data;
  return <div className="stack">
    <dl className="dl">
      <div><dt>Kit</dt><dd>{data.name}</dd></div>
      <div><dt>Situação</dt><dd>{data.active ? 'Ativo' : 'Inativo'}</dd></div>
      {stock && <>
        <div><dt>Custo do kit</dt><dd>{brl(stock.totalCost)}</dd></div>
        <div><dt>Disponíveis</dt><dd>{quantity(stock.available)}</dd></div>
        <div><dt>Item limitante</dt><dd>{stock.limiting ?? '—'}</dd></div>
      </>}
    </dl>
    {stock?.partialCost && <div className="info" role="alert">Há componente sem custo registrado, então o custo considera apenas os demais.</div>}
    <Table responsive={false} columns={['Componente', { label: 'Quantidade', end: true },
      ...(stock ? [{ label: 'Custo', end: true }, { label: 'Rende', end: true }] : [])]}
      rows={data.components.map(row => [
        <Title name={row.name} code={row.sku} />, quantity(row.quantity) + ' ' + row.symbol,
        ...(stock ? [brl(row.cost), quantity(row.yields ?? '0')] : []),
      ])} />
  </div>;
}
