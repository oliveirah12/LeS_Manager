import { ArrowDownRight, ArrowUpRight, Boxes, ChevronRight, Package, PackageX, RefreshCw, Tag, Wallet } from 'lucide-react';
import type { Page } from './main';
import {
  baseUnit, brl, dateTime, Empty, Identity, Loading, message, PageActions, Product, quantity, relativeTime, StockView, stockValue, today, useData,
} from './ui';

type Movement = { id: string; kind: string; quantity: string; createdAt: string; product: Pick<Product, 'sku' | 'name' | 'unit'>; user: { name: string } };
type Provider = { id: string; name: string };
type Transaction = { key: string | null; direction: string; amount: string; reconciliation: unknown };
const kindLabels: Record<string, string> = {
  PURCHASE: 'Compra', OUT: 'Saída', ADJUSTMENT: 'Ajuste', INITIAL: 'Carga inicial', KIT_OUT: 'Saída de kit', INVENTORY: 'Inventário',
};

export function Home({ identity, can, navigate }: { identity: Identity; can: (permission: string) => boolean; navigate: (page: Page) => void }) {
  const stock = can('stock:view');
  const finance = can('finance:view');
  const catalog = can('catalog:view');
  return <>
    {stock && can('stock:operate') && <PageActions>
      <button type="button" className="btn" onClick={() => navigate('stock')}><Package size={16} aria-hidden="true" />Ir para o estoque</button>
    </PageActions>}
    {stock && <StockSummary navigate={navigate} />}
    {finance && <FinanceSummary navigate={navigate} edit={can('finance:operate')} />}
    {!stock && !finance && <section className="section">
      <div className="section-head"><div><h2>Atalhos</h2><p>Áreas disponíveis para o perfil {identity.profileName}.</p></div></div>
      <div className="list card">
        {catalog && <button type="button" className="list-row" onClick={() => navigate('products')}>
          <span className="icon-tile brand"><Tag size={16} aria-hidden="true" /></span>
          <span className="grow"><span className="title">Catálogo</span><span className="sub">Produtos e kits</span></span>
          <ChevronRight size={16} aria-hidden="true" className="muted" /></button>}
        {can('registrations:view') && <button type="button" className="list-row" onClick={() => navigate('GRUPO')}>
          <span className="icon-tile"><Boxes size={16} aria-hidden="true" /></span>
          <span className="grow"><span className="title">Cadastros</span><span className="sub">Classificações e unidades</span></span>
          <ChevronRight size={16} aria-hidden="true" className="muted" /></button>}
        {!catalog && !can('registrations:view') && <Empty>Seu perfil ainda não tem acesso a nenhum módulo. Fale com o administrador.</Empty>}
      </div>
    </section>}
  </>;
}

/* Stock only: products, stock value and movements. No bank data here. */
function StockSummary({ navigate }: { navigate: (page: Page) => void }) {
  const view = useData<StockView>('stock');
  const history = useData<{ movements: Movement[] }>('stock/movements');
  const products = view.data?.products ?? [];
  const empty = products.filter(product => Number(product.quantity) === 0);
  const value = products.reduce((sum, product) => sum + stockValue(product), 0);
  const kits = view.data?.kits ?? [];
  return <section className="stack" aria-labelledby="home-stock">
    <div className="section-head">
      <h2 id="home-stock" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Package size={18} aria-hidden="true" />Estoque</h2>
      <button type="button" className="btn ghost small" onClick={() => navigate('stock')}>Abrir estoque<ChevronRight size={16} aria-hidden="true" /></button>
    </div>
    {message(view.error)}
    {view.loading && !view.data ? <Loading label="Carregando estoque…" /> : <div className="kpis">
      <div className="card kpi"><span>Produtos ativos</span><strong>{products.length}</strong><small>{empty.length ? empty.length + ' sem saldo' : 'Todos com saldo'}</small></div>
      <div className="card kpi"><span>Valor em estoque</span><strong>{brl(value)}</strong><small>Pelo custo médio</small></div>
      <div className="card kpi"><span>Kits disponíveis</span><strong>{kits.filter(kit => Number(kit.available) > 0).length}</strong>
        <small>de {kits.length} ativos</small></div>
    </div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))', gap: 12, alignItems: 'start' }}>
      <section className="card">
        <div className="section-head" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}><h3>Últimas movimentações</h3></div>
        {message(history.error)}
        {history.loading && !history.data ? <div style={{ padding: '0 16px' }}><Loading /></div> :
          history.data?.movements.length ? <div className="list">{history.data.movements.slice(0, 6).map(movement => {
            const entering = !movement.quantity.startsWith('-');
            return <div className="list-row" key={movement.id}>
              <span className={'icon-tile' + (entering ? ' ok' : '')}>{entering ? <ArrowUpRight size={16} aria-hidden="true" /> : <ArrowDownRight size={16} aria-hidden="true" />}</span>
              <span className="grow"><span className="title">{movement.product.name}</span>
                <span className="sub">{kindLabels[movement.kind]} · {movement.user.name} · {relativeTime(movement.createdAt)}</span></span>
              <span className="num" style={{ fontWeight: 600, color: entering ? 'var(--ok)' : undefined, whiteSpace: 'nowrap' }}>
                {entering ? '+ ' : ''}{quantity(movement.quantity)} {baseUnit(movement.product).symbol}</span>
            </div>;
          })}</div> : <Empty>Nenhuma movimentação registrada.</Empty>}
      </section>
      <section className="card">
        <div className="section-head" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}><h3>Sem saldo</h3>
          {empty.length > 0 && <span className="badge warn">{empty.length}</span>}</div>
        {view.data && (empty.length ? <div className="list">{empty.slice(0, 5).map(product =>
          <button type="button" className="list-row" key={product.id} onClick={() => navigate('stock')}>
            <span className="icon-tile warn"><PackageX size={16} aria-hidden="true" /></span>
            <span className="grow"><span className="title">{product.name}</span><span className="sub mono">{product.sku}</span></span>
            <ChevronRight size={16} aria-hidden="true" className="muted" />
          </button>)}</div> : <Empty>Todos os produtos ativos têm saldo.</Empty>)}
      </section>
    </div>
  </section>;
}

/* Bank only: balance and reconciliation of the provider's statement. No stock data here. */
function FinanceSummary({ navigate, edit }: { navigate: (page: Page) => void; edit: boolean }) {
  const providers = useData<Provider[]>('finance/providers');
  const provider = providers.data?.[0];
  const to = today();
  const from = new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10);
  const balance = useData<{ balance: { available: string; updatedAt: string } | null }>(provider ? 'finance/balance?' + new URLSearchParams({ provider: provider.id }) : null);
  const statement = useData<{ transactions: Transaction[]; importedDays: number }>(provider ? 'finance?' + new URLSearchParams({ provider: provider.id, from, to }) : null);
  const transactions = statement.data?.transactions ?? [];
  const pending = transactions.filter(row => row.key && !row.reconciliation).length;
  const total = (direction: string) => transactions.filter(row => row.direction === direction).reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
  const current = balance.data?.balance;
  return <section className="stack" aria-labelledby="home-finance">
    <div className="section-head">
      <h2 id="home-finance" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Wallet size={18} aria-hidden="true" />Financeiro{provider ? ' · ' + provider.name : ''}</h2>
      <button type="button" className="btn ghost small" onClick={() => navigate('statement')}>Ver extrato<ChevronRight size={16} aria-hidden="true" /></button>
    </div>
    {message(providers.error || balance.error || statement.error)}
    {(providers.loading || balance.loading) && !current ? <Loading label="Carregando dados bancários…" /> : <div className="kpis">
      <div className="card kpi"><span>Saldo disponível</span><strong>{brl(current?.available ?? null)}</strong>
        <small>{current ? 'Sincronizado ' + relativeTime(current.updatedAt) : 'Aguardando a primeira sincronização'}</small></div>
      <div className="card kpi"><span>Entradas · 30 dias</span><strong style={{ color: 'var(--ok)' }}>{brl(total('C'))}</strong><small>Extrato importado</small></div>
      <div className="card kpi"><span>Saídas · 30 dias</span><strong>{brl(total('D'))}</strong><small>Extrato importado</small></div>
      <button type="button" className="card kpi" style={{ textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit' }} onClick={() => navigate('reconciliation')}>
        <span>A conciliar · 30 dias</span><strong style={{ color: pending ? 'var(--warn)' : undefined }}>{pending}</strong>
        <small>{pending ? 'Abrir conciliação' : 'Tudo conferido'}</small></button>
    </div>}
    {current && edit && <p className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.85rem' }}>
      <RefreshCw size={14} aria-hidden="true" />Última sincronização em {dateTime(current.updatedAt)}. Atualize pelo Extrato.</p>}
  </section>;
}
