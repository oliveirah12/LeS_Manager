/// <reference types="vite/client" />
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountSettings, Administration, SignIn } from './access';
import { Audit } from './audit';
import { Catalog } from './catalog';
import { Finance } from './finance';
import { InstallApp } from './pwa';
import { referenceKinds, Registrations } from './registrations';
import { Stock } from './stock';
import { accessible, api, Identity, Loading, ModalForm } from './ui';
import './style.css';

const groups = [
  { id: 'home', label: 'Início', permission: null, pages: [{ id: 'home', label: 'Início' }] },
  { id: 'catalog', label: 'Catálogo', permission: 'catalog:view', pages: [
    { id: 'products', label: 'Produtos' }, { id: 'kits', label: 'Kits' },
  ] },
  { id: 'registrations', label: 'Cadastros', permission: 'registrations:view', pages: [
    { id: 'register-products', label: 'Produtos' }, { id: 'register-kits', label: 'Kits' },
    ...referenceKinds.map(({ id, label }) => ({ id, label })),
    { id: 'families', label: 'Famílias de medida' }, { id: 'units', label: 'Unidades de medida' },
  ] },
  { id: 'stock', label: 'Estoque', permission: 'stock:view', pages: [{ id: 'stock', label: 'Estoque' }] },
  { id: 'finance', label: 'Financeiro', permission: 'finance:view', pages: [
    { id: 'balance', label: 'Saldo' }, { id: 'statement', label: 'Extrato' }, { id: 'reconciliation', label: 'Conciliação' },
  ] },
  { id: 'audit', label: 'Auditoria', permission: 'admin', pages: [{ id: 'audit', label: 'Auditoria' }] },
  { id: 'admin', label: 'Acessos', permission: 'admin', pages: [
    { id: 'admin', label: 'Usuários e perfis' }, { id: 'admin-account', label: 'Minha conta' },
  ] },
] as const;
type Group = typeof groups[number];
type Page = Group['pages'][number]['id'] | 'account';

const pageDescriptions: Record<Page, string> = {
  home: 'Acesse os atalhos dos módulos disponíveis para o seu perfil.',
  products: 'Consulte os itens do catálogo.', kits: 'Consulte os kits e suas composições.',
  'register-products': 'Cadastre ou edite produtos.', 'register-kits': 'Cadastre ou edite a composição de kits.',
  GRUPO: 'Organize os produtos por grupos.', MARCA: 'Gerencie as marcas do catálogo.',
  COR: 'Mantenha a lista de cores disponíveis.', DEPARTAMENTO: 'Organize os departamentos do catálogo.',
  families: 'Configure as famílias e suas unidades base.', units: 'Consulte as unidades e os fatores de conversão.',
  stock: 'Acompanhe saldos, movimentações, inventário e cargas iniciais.',
  balance: 'Consulte o saldo da conta bancária.', statement: 'Consulte as transações por período.',
  reconciliation: 'Confira e concilie lançamentos importados por provedor.',
  audit: 'Acompanhe as operações e os acessos ao sistema.',
  admin: 'Gerencie os usuários e os perfis de acesso.', 'admin-account': 'Atualize seus dados e sua senha.',
  account: 'Atualize seus dados e sua senha.',
};

function readPreference(key: string) {
  try { return localStorage.getItem('les-manager.' + key); } catch { return null; }
}

function savePreference(key: string, value: string) {
  try { localStorage.setItem('les-manager.' + key, value); } catch { /* Preferences remain available in memory. */ }
}

const mobileQuery = '(max-width: 740px)';
function useSidebar() {
  const [mobile, setMobile] = useState(() => matchMedia(mobileQuery).matches);
  const [desktopOpen, setDesktopOpen] = useState(() => readPreference('sidebar.desktop') !== 'closed');
  const [mobileOpen, setMobileOpen] = useState(() => readPreference('sidebar.mobile') === 'open');
  useEffect(() => {
    const query = matchMedia(mobileQuery);
    const changed = (event: MediaQueryListEvent) => setMobile(event.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  function setOpen(open: boolean) {
    (mobile ? setMobileOpen : setDesktopOpen)(open);
    savePreference(mobile ? 'sidebar.mobile' : 'sidebar.desktop', open ? 'open' : 'closed');
  }
  return { mobile, open: mobile ? mobileOpen : desktopOpen, setOpen };
}

function App() {
  const [identity, setIdentity] = useState<Identity | null>();
  const [selected, setSelected] = useState<Page>();
  const [expanded, setExpanded] = useState<Partial<Record<Group['id'], boolean>>>({});
  const [notice, setNotice] = useState('');
  const [logout, setLogout] = useState(false);
  const [theme, setTheme] = useState(() => readPreference('theme') ??
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const sidebar = useSidebar();
  const heading = useRef<HTMLHeadingElement>(null);
  const menuToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (selected) heading.current?.focus(); }, [selected]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#27181e' : '#a52d40');
  }, [theme]);
  async function signIn() { setIdentity(await api<Identity>('access/me')); setNotice(''); }
  useEffect(() => { void signIn().catch(() => setIdentity(null)); }, []);
  const can = (permission: string) => accessible(identity?.permissions ?? [], permission);
  const admin = can('admin');
  const allowed = groups.map(group => ({
    ...group,
    pages: [...group.pages].filter(page => {
      if (page.id === 'register-products' || page.id === 'register-kits') return can('catalog:operate');
      return !group.permission || can(group.permission);
    }),
  })).filter(group => group.pages.length);
  const allowedPages = allowed.flatMap(group => [...group.pages]);
  const screen = allowedPages.find(page => page.id === selected) ??
    (selected === 'account' && !admin ? { id: 'account' as const, label: 'Minha conta' } : allowedPages[0]);
  const currentGroup = allowed.find(group => group.pages.some(page => page.id === screen?.id));

  function navigate(page: Page) {
    setSelected(page);
    const group = allowed.find(item => item.pages.some(itemPage => itemPage.id === page));
    if (group) setExpanded(previous => ({ ...previous, [group.id]: true }));
    if (sidebar.mobile) sidebar.setOpen(false);
    if (page === selected) requestAnimationFrame(() => heading.current?.focus());
  }
  function closeMobileMenu() {
    sidebar.setOpen(false);
    menuToggle.current?.focus();
  }
  function signedOut(message = '') {
    setIdentity(null); setSelected(undefined); setExpanded({}); setNotice(message); setLogout(false);
  }
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); savePreference('theme', next);
  }
  const themeLabel = theme === 'dark' ? 'Modo claro' : 'Modo escuro';
  const themeButton = <button type="button" className="secondary theme-toggle" onClick={toggleTheme}>{themeLabel}</button>;

  return <>
    <header className="header"><div className="header-inner">
      <div className="header-start">
        {identity && <button ref={menuToggle} type="button" className="sidebar-toggle" aria-controls="app-sidebar" aria-expanded={sidebar.open}
          aria-label={sidebar.open ? 'Fechar menu' : 'Abrir menu'} onClick={() => sidebar.setOpen(!sidebar.open)}
          onKeyDown={event => { if (event.key === 'Escape' && sidebar.mobile && sidebar.open) closeMobileMenu(); }}>
          <svg aria-hidden="true" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
        </button>}
        <a href="/" className="brand" aria-label="LeS Manager · Início" onClick={event => {
          if (identity && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate('home'); }
        }}><img src="/brand.png" alt="" width="36" height="36" /><span>LeS <strong>Manager</strong></span></a>
      </div>
      {identity ? <details className="account-menu">
        <summary aria-label={'Conta de ' + identity.name}><span className="avatar" aria-hidden="true">{identity.name.trim().slice(0, 1).toUpperCase()}</span>
          <span className="account-label"><strong>{identity.name}</strong><small>{identity.profileName}</small></span><span aria-hidden="true">⌄</span>
        </summary>
        <div className="account-popover">
          <p className="account-email">{identity.email}</p>
          <button type="button" className="secondary" onClick={event => {
            event.currentTarget.closest('details')?.removeAttribute('open');
            navigate(admin ? 'admin-account' : 'account');
          }}>Configurações da conta</button>
          {themeButton}
          <button type="button" onClick={() => setLogout(true)}>Sair</button>
        </div>
      </details> : themeButton}
    </div></header>
    {identity === undefined ? <main className="layout"><Loading /></main> :
      identity === null ? <SignIn signedIn={signIn} notice={notice} /> :
      <div className={'dashboard' + (sidebar.open ? ' sidebar-open' : '')} onKeyDown={event => {
        if (event.key === 'Escape' && sidebar.mobile && sidebar.open) closeMobileMenu();
      }}>
        {sidebar.mobile && <button type="button" className="sidebar-backdrop" aria-label="Fechar menu lateral"
          aria-hidden={!sidebar.open} inert={!sidebar.open} onClick={closeMobileMenu} />}
        <aside className="sidebar" id="app-sidebar" aria-hidden={!sidebar.open} inert={!sidebar.open}>
          <p className="eyebrow">Painel interno</p>
          <nav aria-label="Módulos">{allowed.map(group => {
            if (group.pages.length === 1 && group.id !== 'registrations') return <button type="button" className="nav-group" key={group.id}
              aria-current={screen?.id === group.pages[0].id ? 'page' : undefined} onClick={() => navigate(group.pages[0].id)}>{group.label}</button>;
            const open = expanded[group.id] ?? (currentGroup?.id === group.id);
            return <div key={group.id}>
              <button type="button" className="nav-group" aria-expanded={open} aria-controls={'menu-' + group.id}
                onClick={() => setExpanded(previous => ({ ...previous, [group.id]: !open }))}>
                {group.label}<span aria-hidden="true">{open ? '−' : '+'}</span>
              </button>
              <div id={'menu-' + group.id} className="nav-submenu" aria-hidden={!open} inert={!open}>
                <div className="nav-clip"><div className="nav-children">
                  {group.pages.map(page => <button type="button" key={page.id} aria-current={screen?.id === page.id ? 'page' : undefined}
                    onClick={() => navigate(page.id)}>{page.label}</button>)}
                </div></div>
              </div>
            </div>;
          })}</nav>
        </aside>
        <main className="content" inert={sidebar.mobile && sidebar.open}>
          <div className="page-heading" key={screen?.id}>
            {currentGroup && currentGroup.label !== screen?.label && <span className="eyebrow">{currentGroup.label}</span>}
            <h1 ref={heading} tabIndex={-1}>{screen?.label ?? 'Bem-vindo'}</h1>
            {screen && <p>{pageDescriptions[screen.id]}</p>}
          </div>
          {screen?.id === 'home' && <div className="home-grid">
            {allowed.filter(group => group.id !== 'home').map(group => <section className="section home-card" key={group.id}>
              <h2>{group.label}</h2>
              <div className="shortcuts">{group.pages.map(page => <button type="button" key={page.id}
                className="secondary" onClick={() => navigate(page.id)}>{page.label}<span aria-hidden="true">→</span></button>)}</div>
            </section>)}
            {!admin && <section className="section home-card"><h2>Conta</h2><div className="shortcuts">
              <button type="button" className="secondary" onClick={() => navigate('account')}>Minha conta<span aria-hidden="true">→</span></button>
            </div></section>}
          </div>}
          {(screen?.id === 'products' || screen?.id === 'kits') && <Catalog key={screen.id} page={screen.id} edit={false} />}
          {(screen?.id === 'register-products' || screen?.id === 'register-kits') &&
            <Catalog key={screen.id} page={screen.id === 'register-products' ? 'products' : 'kits'} edit={can('catalog:operate')} />}
          {(screen?.id === 'GRUPO' || screen?.id === 'MARCA' || screen?.id === 'COR' || screen?.id === 'DEPARTAMENTO' ||
            screen?.id === 'families' || screen?.id === 'units') && <Registrations key={screen.id} page={screen.id} edit={can('registrations:operate')} admin={admin} />}
          {screen?.id === 'stock' && <Stock edit={can('stock:operate')} importInitial={can('stock:operate') && can('catalog:operate')} />}
          {(screen?.id === 'balance' || screen?.id === 'statement' || screen?.id === 'reconciliation') &&
            <Finance page={screen.id} edit={can('finance:operate')} openStatement={() => navigate('statement')} />}
          {screen?.id === 'admin' && <Administration onUserChanged={async id => { if (id === identity.id) await signIn(); }} />}
          {screen?.id === 'audit' && <Audit />}
          {(screen?.id === 'account' || screen?.id === 'admin-account') && <AccountSettings identity={identity} changed={setIdentity}
            passwordChanged={() => signedOut('Senha atualizada. Entre com a nova senha.')} />}
        </main>
      </div>}
    {import.meta.env.PROD && <InstallApp />}
    {logout && <ModalForm title="Sair do LeS Manager" label="Sair" close={() => setLogout(false)} action={async () => {
      await api('access/logout', {}); signedOut();
    }}><p>Deseja encerrar esta sessão?</p></ModalForm>}
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/service-worker.js').catch(error => console.warn('Service worker indisponível', error));
  });
}
