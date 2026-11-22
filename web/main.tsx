/// <reference types="vite/client" />
import { ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ChevronDown, Home as HomeIcon, Layers, LogOut, Menu, Moon, MoreHorizontal, Package, PanelLeftClose, PanelLeftOpen, Printer,
  ShieldCheck, ShoppingCart, Sun, Tag, UserRound, Users, Wallet,
} from 'lucide-react';
import { AccountSettings, Administration, SignIn } from './access';
import { Audit } from './audit';
import { Catalog } from './catalog';
import { Finance } from './finance';
import { Home } from './home';
import { pageFromHash } from './format';
import { ProductionOrders } from './orders';
import { PaymentMethods } from './payment-methods';
import { Printers } from './production';
import { PurchaseDocuments } from './purchase-documents';
import { Purchases } from './purchases';
import { InstallApp } from './pwa';
import { referenceKinds, Registrations } from './registrations';
import { Stock } from './stock';
import { Suppliers } from './suppliers';
import { accessible, api, Identity, Loading, ModalForm, PageActionsProvider, sessionExpired, Toaster } from './ui';
import './style.css';

const groups = [
  { id: 'home', label: 'Início', icon: HomeIcon, section: 'ops', permission: null, pages: [{ id: 'home', label: 'Início' }] },
  { id: 'stock', label: 'Estoque', icon: Package, section: 'ops', permission: 'stock:view', pages: [{ id: 'stock', label: 'Estoque' }] },
  { id: 'purchases', label: 'Compras', icon: ShoppingCart, section: 'ops', permission: 'purchases:view', pages: [{ id: 'purchases', label: 'Compras' }, { id: 'purchase-documents', label: 'Documentos' }] },
  { id: 'catalog', label: 'Catálogo', icon: Tag, section: 'ops', permission: 'catalog:view', pages: [
    { id: 'products', label: 'Produtos' }, { id: 'inputs', label: 'Insumos' }, { id: 'kits', label: 'Kits' },
  ] },
  { id: 'finance', label: 'Financeiro', icon: Wallet, section: 'ops', permission: 'finance:view', pages: [
    { id: 'balance', label: 'Saldo' }, { id: 'statement', label: 'Extrato' }, { id: 'reconciliation', label: 'Conciliação' }, { id: 'integration', label: 'Integração' },
  ] },
  { id: 'production', label: 'Produção', icon: Printer, section: 'ops', permission: 'production:view', pages: [
    { id: 'production-orders', label: 'Ordens' }, { id: 'printers', label: 'Impressoras' },
  ] },
  { id: 'registrations', label: 'Cadastros', icon: Layers, section: 'admin', permission: 'registrations:view', pages: [
    { id: 'register-products', label: 'Produtos' }, { id: 'register-kits', label: 'Kits' }, { id: 'suppliers', label: 'Fornecedores' }, { id: 'payment-methods', label: 'Formas de pagamento' }, { id: 'product-types', label: 'Tipos de produto' },
    ...referenceKinds.map(({ id, label }) => ({ id, label })),
    { id: 'families', label: 'Famílias de medida' }, { id: 'units', label: 'Unidades de medida' },
  ] },
  { id: 'audit', label: 'Auditoria', icon: ShieldCheck, section: 'admin', permission: 'admin', pages: [{ id: 'audit', label: 'Auditoria' }] },
  { id: 'admin', label: 'Acessos', icon: Users, section: 'admin', permission: 'admin', pages: [
    { id: 'admin', label: 'Usuários e perfis' }, { id: 'admin-account', label: 'Minha conta' },
  ] },
] as const;
type Group = typeof groups[number];
export type Page = Group['pages'][number]['id'] | 'account';

const pageDescriptions: Record<Page, string> = {
  home: '', products: 'Consulte os produtos do catálogo.', inputs: 'Materiais usados nas fichas técnicas e na produção.', kits: 'Consulte os kits e suas composições.',
  'register-products': 'Cadastre, edite e inative produtos.', 'register-kits': 'Monte e edite a composição dos kits.',
  suppliers: 'Empresas e pessoas de quem você compra.',
  'payment-methods': 'Formas de pagamento e taxas usadas na venda das ordens.',
  'product-types': 'Defina o que cada produto é e como ele se comporta na produção.',
  GRUPO: 'Organize os produtos por grupos.', MARCA: 'Gerencie as marcas do catálogo.',
  COR: 'Mantenha a lista de cores disponíveis.', DEPARTAMENTO: 'Organize os departamentos do catálogo.',
  families: 'Cada família tem uma unidade base, como g para peso.', units: 'Unidades e fatores de conversão para a unidade base.',
  stock: 'Saldos e custos na unidade base de cada produto.',
  purchases: 'Lance compras com vários itens, custos adicionais e rateio.',
  'purchase-documents': 'Encontre e baixe as notas, recibos e comprovantes das compras.',
  balance: 'Saldo da conta bancária na última sincronização.', statement: 'Transações bancárias por período.',
  reconciliation: 'Confira os lançamentos do banco com as referências internas.',
  integration: 'Credenciais e certificado usados para ler o saldo e o extrato.',
  'production-orders': 'Planeje, acompanhe e conclua as impressões.',
  printers: 'Impressoras e tarifa de energia usadas no custo da produção.',
  audit: 'Inclusões, alterações, acessos e tentativas negadas dos últimos 12 meses.',
  admin: 'Perfis de acesso e contas da equipe.', 'admin-account': 'Seus dados e sua senha.', account: 'Seus dados e sua senha.',
};

// Each screen has its own address so reload, back/forward and shared links keep the page.
const paths: Record<Page, string> = {
  home: '', products: 'catalogo/produtos', inputs: 'catalogo/insumos', kits: 'catalogo/kits',
  'register-products': 'cadastros/produtos', 'register-kits': 'cadastros/kits', suppliers: 'cadastros/fornecedores', 'payment-methods': 'cadastros/formas-de-pagamento', 'product-types': 'cadastros/tipos-de-produto',
  GRUPO: 'cadastros/grupos', MARCA: 'cadastros/marcas', COR: 'cadastros/cores', DEPARTAMENTO: 'cadastros/departamentos',
  families: 'cadastros/familias', units: 'cadastros/unidades', stock: 'estoque', purchases: 'compras', 'purchase-documents': 'compras/documentos',
  balance: 'financeiro/saldo', statement: 'financeiro/extrato', reconciliation: 'financeiro/conciliacao', integration: 'financeiro/integracao',
  'production-orders': 'producao/ordens', printers: 'producao/impressoras',
  audit: 'auditoria', admin: 'acessos/usuarios', 'admin-account': 'acessos/minha-conta', account: 'conta',
};
const hashOf = (page: Page) => '#/' + paths[page];

const currentPage = () => pageFromHash(location.hash, paths);

function useHashPage() {
  const [page, setPage] = useState(currentPage);
  useEffect(() => {
    const changed = () => setPage(currentPage());
    addEventListener('hashchange', changed);
    return () => removeEventListener('hashchange', changed);
  }, []);
  return page;
}

function readPreference(key: string) {
  try { return localStorage.getItem('les-manager.' + key); } catch { return null; }
}

function savePreference(key: string, value: string) {
  try { localStorage.setItem('les-manager.' + key, value); } catch { /* Preferences remain available in memory. */ }
}

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const changed = (event: MediaQueryListEvent) => setMatch(event.matches);
    list.addEventListener('change', changed);
    return () => list.removeEventListener('change', changed);
  }, [query]);
  return match;
}

function AccountMenu({ identity, theme, toggleTheme, openAccount, signOut }: {
  identity: Identity; theme: string; toggleTheme: () => void; openAccount: () => void; signOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const choose = (action: () => void) => () => { setOpen(false); action(); };
  return <div className="account" ref={root}>
    <button type="button" aria-expanded={open} aria-haspopup="menu" aria-label={'Conta de ' + identity.name} onClick={() => setOpen(!open)}>
      <span className="avatar" aria-hidden="true">{identity.name.trim().slice(0, 1).toUpperCase()}</span>
      <span className="account-name"><strong>{identity.name}</strong><small>{identity.profileName}</small></span>
      <ChevronDown size={16} aria-hidden="true" className="muted" />
    </button>
    {open && <div className="menu" role="menu">
      <div className="menu-head"><strong>{identity.name}</strong><br /><small>{identity.email}</small></div>
      <button type="button" role="menuitem" onClick={choose(openAccount)}><UserRound size={16} aria-hidden="true" />Minha conta</button>
      <button type="button" role="menuitem" onClick={choose(toggleTheme)}>
        {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}{theme === 'dark' ? 'Tema claro' : 'Tema escuro'}</button>
      <button type="button" role="menuitem" onClick={choose(signOut)}><LogOut size={16} aria-hidden="true" />Sair</button>
    </div>}
  </div>;
}

function App() {
  const [identity, setIdentity] = useState<Identity | null>();
  const requested = useHashPage();
  const [expanded, setExpanded] = useState<Partial<Record<Group['id'], boolean>>>({});
  const [notice, setNotice] = useState('');
  const [logout, setLogout] = useState(false);
  const [theme, setTheme] = useState(() => readPreference('theme') ??
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const mobile = useMediaQuery('(max-width: 760px)');
  const [collapsed, setCollapsed] = useState(() => readPreference('sidebar.desktop') === 'closed');
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const shownPage = useRef<Page | undefined>(undefined);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#121011' : '#f6f5f4');
  }, [theme]);
  useEffect(() => {
    const changed = () => setScrolled(scrollY > 4);
    addEventListener('scroll', changed, { passive: true });
    return () => removeEventListener('scroll', changed);
  }, []);
  useEffect(() => { if (!mobile) setMenuOpen(false); }, [mobile]);
  async function signIn() { setIdentity(await api<Identity>('access/me')); setNotice(''); }
  useEffect(() => { void signIn().catch(() => setIdentity(null)); }, []);
  useEffect(() => {
    // Keeps the current address so the person returns to the same screen after signing in again.
    const expired = () => { setIdentity(null); setNotice('Sua sessão expirou. Entre novamente.'); setLogout(false); setMenuOpen(false); };
    addEventListener(sessionExpired, expired);
    return () => removeEventListener(sessionExpired, expired);
  }, []);

  const can = (permission: string) => accessible(identity?.permissions ?? [], permission);
  const admin = can('admin');
  const allowed = groups.map(group => ({
    ...group,
    pages: [...group.pages].filter(page => {
      if (page.id === 'register-products' || page.id === 'register-kits') return can('catalog:operate');
      if (page.id === 'integration') return can('admin');
      return !group.permission || can(group.permission);
    }),
  })).filter(group => group.pages.length);
  const allowedPages = allowed.flatMap(group => [...group.pages]);
  // Administrators keep their account page under Acessos; everyone else uses the standalone page.
  const selected = requested === 'account' && admin ? 'admin-account' : requested === 'admin-account' && !admin ? 'account' : requested;
  const screen = allowedPages.find(page => page.id === selected) ??
    (selected === 'account' && !admin ? { id: 'account' as const, label: 'Minha conta' } : allowedPages[0]);
  const currentGroup = allowed.find(group => group.pages.some(page => page.id === screen?.id));

  // Unknown or unauthorized addresses fall back to the first allowed screen without a new history entry.
  useEffect(() => {
    if (!identity || !screen) return;
    if (location.hash !== hashOf(screen.id)) history.replaceState(null, '', hashOf(screen.id));
    if (shownPage.current && shownPage.current !== screen.id) {
      heading.current?.focus({ preventScroll: true });
      scrollTo({ top: 0 });
    }
    shownPage.current = screen.id;
  }, [identity, screen?.id]);

  function navigate(page: Page) {
    const group = allowed.find(item => item.pages.some(itemPage => itemPage.id === page));
    if (group && group.pages.length > 1) setExpanded(previous => ({ ...previous, [group.id]: true }));
    setMenuOpen(false);
    if (location.hash === hashOf(page)) requestAnimationFrame(() => heading.current?.focus());
    else location.hash = hashOf(page);
  }
  function signedOut(message = '') {
    setIdentity(null); setExpanded({}); setNotice(message); setLogout(false);
    shownPage.current = undefined;
    history.replaceState(null, '', hashOf('home'));
    dispatchEvent(new HashChangeEvent('hashchange'));
  }
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); savePreference('theme', next);
  }
  function toggleCollapsed() {
    setCollapsed(!collapsed); savePreference('sidebar.desktop', collapsed ? 'open' : 'closed');
  }
  function closeMenu() { setMenuOpen(false); menuButton.current?.focus(); }

  if (identity === undefined) return <div className="signin"><Loading /></div>;
  if (identity === null) return <><SignIn signedIn={signIn} notice={notice} />{import.meta.env.PROD && <InstallApp />}<Toaster /></>;

  const rail = collapsed && !mobile;
  const navSection = (section: 'ops' | 'admin', label?: string) => {
    const items = allowed.filter(group => group.section === section);
    if (!items.length) return null;
    return <div className="nav">
      {label && <div className="nav-label">{label}</div>}
      {items.map(group => {
        const Icon = group.icon;
        const active = currentGroup?.id === group.id;
        if (group.pages.length === 1) return <button type="button" className="nav-item" key={group.id} title={rail ? group.label : undefined}
          aria-current={active ? 'page' : undefined} onClick={() => navigate(group.pages[0].id)}>
          <Icon size={18} aria-hidden="true" /><span className="label">{group.label}</span></button>;
        const open = !rail && (expanded[group.id] ?? active);
        return <div key={group.id}>
          <button type="button" className={'nav-item' + (active && !open ? ' current' : '')} aria-expanded={open} aria-controls={'menu-' + group.id}
            title={rail ? group.label : undefined} onClick={() => {
              if (rail) { toggleCollapsed(); setExpanded(previous => ({ ...previous, [group.id]: true })); return; }
              setExpanded(previous => ({ ...previous, [group.id]: !open }));
            }}>
            <Icon size={18} aria-hidden="true" /><span className="label">{group.label}</span><ChevronDown className="chevron" size={16} aria-hidden="true" />
          </button>
          <div id={'menu-' + group.id} className="nav-sub" data-open={open} inert={!open}>
            <div><ul>{group.pages.map(page => <li key={page.id}>
              <button type="button" aria-current={screen?.id === page.id ? 'page' : undefined} onClick={() => navigate(page.id)}>{page.label}</button>
            </li>)}</ul></div>
          </div>
        </div>;
      })}
    </div>;
  };

  // Phone bottom bar: the main operational areas plus "Mais", which opens the full menu.
  const bottomItems = allowed.filter(group => group.section === 'ops').slice(0, 4);
  const page = screen?.id;
  const content: ReactNode = <>
    {page === 'home' && <Home identity={identity} can={can} navigate={navigate} />}
    {(page === 'products' || page === 'inputs' || page === 'kits') && <Catalog key={page} page={page} edit={false} seeStock={can('stock:view')} />}
    {(page === 'register-products' || page === 'register-kits') &&
      <Catalog key={page} page={page === 'register-products' ? 'products' : 'kits'} edit={can('catalog:operate')} editStock={can('stock:operate')} />}
    {(page === 'product-types' || page === 'GRUPO' || page === 'MARCA' || page === 'COR' || page === 'DEPARTAMENTO' || page === 'families' || page === 'units') &&
      <Registrations key={page} page={page} edit={can('registrations:operate')} admin={admin} />}
    {page === 'suppliers' && <Suppliers edit={can('registrations:operate')} />}
    {page === 'payment-methods' && <PaymentMethods edit={can('registrations:operate')} />}
    {page === 'purchases' && <Purchases edit={can('purchases:operate')} />}
    {page === 'purchase-documents' && <PurchaseDocuments edit={can('purchases:operate')} />}
    {page === 'stock' && <Stock edit={can('stock:operate')} importInitial={can('stock:operate') && can('catalog:operate')} />}
    {(page === 'balance' || page === 'statement' || page === 'reconciliation' || page === 'integration') &&
      <Finance key={page} page={page} edit={can('finance:operate')} admin={admin} openStatement={() => navigate('statement')}
        openIntegration={() => navigate('integration')} />}
    {page === 'production-orders' && <ProductionOrders edit={can('production:operate')} seeCosts={can('stock:view')} />}
    {page === 'printers' && <Printers edit={can('production:operate')} />}
    {page === 'admin' && <Administration onUserChanged={async id => { if (id === identity.id) await signIn(); }} />}
    {page === 'audit' && <Audit />}
    {(page === 'account' || page === 'admin-account') && <AccountSettings identity={identity} changed={setIdentity}
      passwordChanged={() => signedOut('Senha atualizada. Entre com a nova senha.')} />}
  </>;

  return <div className={'app' + (rail ? ' collapsed' : '') + (menuOpen ? ' menu-open' : '')}
    onKeyDown={event => { if (event.key === 'Escape' && menuOpen) closeMenu(); }}>
    {mobile && <button type="button" className="scrim" aria-label="Fechar menu" tabIndex={menuOpen ? 0 : -1} aria-hidden={!menuOpen} onClick={closeMenu} />}
    <aside className="sidebar" id="app-sidebar" aria-label="Menu principal" inert={mobile && !menuOpen}>
      <a href={hashOf('home')} className="brand" onClick={event => { event.preventDefault(); navigate('home'); }}>
        <img src="/brand.png" alt="" width="34" height="34" /><span>LeS Manager</span></a>
      <nav aria-label="Módulos" className="stack sidebar-nav" style={{ gap: 18 }}>
        {navSection('ops')}
        {navSection('admin', 'Administração')}
      </nav>
      {!mobile && <div className="sidebar-foot">
        <button type="button" className="nav-item" onClick={toggleCollapsed} aria-label={rail ? 'Expandir menu' : 'Recolher menu'}>
          {rail ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}<span className="label">Recolher menu</span>
        </button>
      </div>}
    </aside>

    <div className="main-column" inert={mobile && menuOpen}>
      <header className={'topbar' + (scrolled ? ' scrolled' : '')}>
        {mobile && <button ref={menuButton} type="button" className="icon-button" aria-label="Abrir menu" aria-controls="app-sidebar"
          aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={20} aria-hidden="true" /></button>}
        <a href={hashOf('home')} className="brand" onClick={event => { event.preventDefault(); navigate('home'); }}>
          <img src="/brand.png" alt="" width="30" height="30" /><span>LeS Manager</span></a>
        <span className="spacer" />
        <AccountMenu identity={identity} theme={theme} toggleTheme={toggleTheme}
          openAccount={() => navigate(admin ? 'admin-account' : 'account')} signOut={() => setLogout(true)} />
      </header>
      <main className="content">
        {screen && <div className="page" key={screen.id}>
          <div className="page-head">
            <div>
              {currentGroup && currentGroup.label !== screen.label && <span className="eyebrow">{currentGroup.label}</span>}
              <h1 ref={heading} tabIndex={-1}>{screen.id === 'home' ? greeting(identity.name) : screen.label}</h1>
              {pageDescriptions[screen.id] && <p>{pageDescriptions[screen.id]}</p>}
            </div>
            <div className="actions" ref={setActionsSlot} />
          </div>
          <PageActionsProvider value={actionsSlot}>{content}</PageActionsProvider>
        </div>}
      </main>
    </div>

    {mobile && <nav className="bottom-nav" aria-label="Atalhos">
      {bottomItems.map(group => {
        const Icon = group.icon;
        return <button type="button" key={group.id} aria-current={currentGroup?.id === group.id && !menuOpen ? 'page' : undefined}
          onClick={() => navigate(group.pages[0].id)}><Icon size={22} aria-hidden="true" />{group.label}</button>;
      })}
      <button type="button" aria-current={menuOpen ? 'page' : undefined} aria-expanded={menuOpen} aria-controls="app-sidebar"
        onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={22} aria-hidden="true" />Mais</button>
    </nav>}

    {import.meta.env.PROD && <InstallApp />}
    <Toaster />
    {logout && <ModalForm title="Sair do LeS Manager" label="Sair" close={() => setLogout(false)} action={async () => {
      await api('access/logout', {}); signedOut();
    }}><p className="muted">Deseja encerrar esta sessão neste dispositivo?</p></ModalForm>}
  </div>;
}

function greeting(name: string) {
  const hour = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).format(new Date()));
  const first = name.trim().split(/\s+/)[0];
  return (hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite') + ', ' + first;
}

createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/service-worker.js').catch(error => console.warn('Service worker indisponível', error));
  });
}
