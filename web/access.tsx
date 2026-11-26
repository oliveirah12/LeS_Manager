import { useState } from 'react';
import { Copy, KeyRound, Pencil, Plus, UserRound } from 'lucide-react';
import {
  api, Badge, by, dateTime, Field, fields, Form, Identity, Loading, message, Modal, ModalForm, notify, PageActions, PasswordField, Section, Segmented, Select, Table,
  Tabs, Title, useData,
} from './ui';

type Profile = { id: string; name: string; permissions: string[] };
type User = { id: string; name: string; email: string; active: boolean; pending: boolean; profileId: string; activationExpires: string | null };
type Code = { code: string; expiresAt: string; name: string };
const modules = [
  { id: 'catalog', name: 'Catálogo' }, { id: 'registrations', name: 'Cadastros' },
  { id: 'stock', name: 'Estoque' }, { id: 'finance', name: 'Financeiro' }, { id: 'production', name: 'Produção' }, { id: 'purchases', name: 'Compras' },
  { id: 'quotes', name: 'Orçamentos' },
];
const correctPermission = 'production:correct';

export function SignIn({ signedIn, notice }: { signedIn: () => Promise<void>; notice?: string }) {
  const [mode, setMode] = useState<'login' | 'activate'>('login');
  const activate = mode === 'activate';
  return <main className="signin">
    <div className="card signin-card">
      <div className="brand"><img src="/brand.png" alt="" width="44" height="44" /><span>LeS Manager</span></div>
      <div><h1 style={{ fontSize: '1.4rem' }}>{activate ? 'Ative sua conta' : 'Entre no painel'}</h1>
        <p className="muted" style={{ marginTop: 4 }}>{activate ? 'Use o código entregue pelo administrador e crie sua senha.' : 'Use a conta criada pelo administrador da empresa.'}</p></div>
      {notice && <p className="success" role="status">{notice}</p>}
      <Segmented label="Tipo de acesso" value={mode} onChange={setMode} options={[{ id: 'login', name: 'Entrar' }, { id: 'activate', name: 'Primeiro acesso' }]} />
      <Form key={mode} label={activate ? 'Ativar conta' : 'Entrar'} action={async data => {
        await api(activate ? 'access/activate' : 'access/login', fields(data)); await signedIn();
      }}>
        <label>E-mail<input name="email" type="email" required autoComplete="username" /></label>
        {activate && <label>Código de primeiro acesso<input name="code" autoComplete="one-time-code" required /></label>}
        <PasswordField name="password" label={activate ? 'Nova senha' : 'Senha'} autoComplete={activate ? 'new-password' : 'current-password'} minLength={activate ? 8 : undefined} />
        {activate && <PasswordField name="confirmation" label="Confirme a senha" autoComplete="new-password" minLength={8}
          hint="Pelo menos 8 caracteres, com uma letra e um número." />}
      </Form>
    </div>
  </main>;
}

export function AccountSettings({ identity, changed, passwordChanged }: {
  identity: Identity; changed: (identity: Identity) => void; passwordChanged: () => void;
}) {
  const [dialog, setDialog] = useState<'name' | 'password'>();
  return <>
    <Section title="Dados da conta" actions={<>
      <button type="button" className="btn secondary" onClick={() => setDialog('name')}><Pencil size={16} aria-hidden="true" />Alterar nome</button>
      <button type="button" className="btn secondary" onClick={() => setDialog('password')}><KeyRound size={16} aria-hidden="true" />Alterar senha</button>
    </>}>
      <dl className="dl">
        <div><dt>Nome</dt><dd>{identity.name}</dd></div>
        <div><dt>E-mail</dt><dd>{identity.email}</dd></div>
        <div><dt>Perfil de acesso</dt><dd>{identity.profileName}</dd></div>
      </dl>
    </Section>
    {dialog === 'name' && <ModalForm title="Alterar nome" close={() => setDialog(undefined)} label="Salvar nome" action={async data => {
      changed(await api<Identity>('access/me', fields(data), 'PATCH'));
      notify('Nome atualizado.');
    }}>
      <Field name="name" label="Nome" defaultValue={identity.name} />
    </ModalForm>}
    {dialog === 'password' && <ModalForm title="Alterar senha" subtitle="Ao salvar, todas as suas sessões serão encerradas." close={() => setDialog(undefined)}
      label="Salvar nova senha" action={async data => {
        await api('access/me/password', fields(data));
        passwordChanged();
      }}>
      <PasswordField name="currentPassword" label="Senha atual" autoComplete="current-password" maxLength={128} />
      <PasswordField name="password" label="Nova senha" autoComplete="new-password" minLength={8} maxLength={128} />
      <PasswordField name="confirmation" label="Confirme a nova senha" autoComplete="new-password" minLength={8} maxLength={128}
        hint="Pelo menos 8 caracteres, com uma letra e um número." />
    </ModalForm>}
  </>;
}

function permissionSummary(profile: Profile) {
  if (profile.permissions.includes('admin')) return [<Badge key="admin" tone="brand">Acesso total</Badge>];
  const items = modules.flatMap(module => {
    if (profile.permissions.includes(module.id + ':operate')) return [<Badge key={module.id} tone="ok">{module.name} · operar</Badge>];
    if (profile.permissions.includes(module.id + ':view')) return [<Badge key={module.id}>{module.name} · ver</Badge>];
    return [];
  });
  if (profile.permissions.includes(correctPermission)) items.push(<Badge key={correctPermission} tone="warn">Produção · corrigir concluídas</Badge>);
  return items.length ? items : [<span key="none" className="muted">Nenhuma permissão</span>];
}

export function Administration({ onUserChanged }: { onUserChanged: (id: string) => Promise<void> }) {
  const profiles = useData<Profile[]>('access/profiles');
  const users = useData<User[]>('access/users');
  const [tab, setTab] = useState<'users' | 'profiles'>('users');
  const [profile, setProfile] = useState<Profile | null>();
  const [user, setUser] = useState<User | null>();
  const [renew, setRenew] = useState<User>();
  const [code, setCode] = useState<Code>();
  const profileName = (id: string) => profiles.data?.find(item => item.id === id)?.name ?? '—';

  return <>
    <PageActions>
      {tab === 'users' ? <button type="button" className="btn" onClick={() => setUser(null)}><Plus size={16} aria-hidden="true" />Novo usuário</button>
        : <button type="button" className="btn" onClick={() => setProfile(null)}><Plus size={16} aria-hidden="true" />Novo perfil</button>}
    </PageActions>
    <Tabs label="Acessos" value={tab} onChange={setTab} tabs={[{ id: 'users', name: 'Usuários' }, { id: 'profiles', name: 'Perfis' }]} />
    {message(profiles.error || users.error)}
    {tab === 'users' && <div className="tab-panel" role="tabpanel">
      {users.loading && !users.data ? <Loading label="Carregando usuários…" /> : users.data && <Table empty="Nenhum usuário."
        columns={['Usuário', 'Perfil', 'Situação', { label: 'Ações', actions: true }]}
        rows={users.data.map(item => [
          by(item.name, <Title name={item.name} code={item.email} mono={false} />), profileName(item.profileId),
          by(!item.active ? 'Inativo' : item.pending ? 'Aguardando ativação' : 'Ativo',
            !item.active ? <Badge>Inativo</Badge> : item.pending ? <Badge tone="warn">Aguardando ativação</Badge> : <Badge tone="ok"><span className="dot" />Ativo</Badge>),
          <div className="actions">
            <button type="button" className="btn secondary small" onClick={() => setUser(item)}><Pencil size={14} aria-hidden="true" />Editar</button>
            {item.active && item.pending && <button type="button" className="btn ghost small" onClick={() => setRenew(item)}><KeyRound size={14} aria-hidden="true" />Novo código</button>}
          </div>,
        ])} />}
    </div>}
    {tab === 'profiles' && <div className="tab-panel" role="tabpanel">
      <p className="muted">Permitir operar também libera a visualização do módulo.</p>
      {profiles.loading && !profiles.data ? <Loading label="Carregando perfis…" /> : profiles.data && <Table empty="Nenhum perfil."
        columns={['Perfil', 'Permissões', { label: 'Ações', actions: true }]}
        rows={profiles.data.map(item => [
          by(item.name, <span className="cell-title">{item.name}</span>), <div className="actions">{permissionSummary(item)}</div>,
          item.permissions.includes('admin') ? <span className="muted">Reservado</span> :
            <button type="button" className="btn secondary small" onClick={() => setProfile(item)}><Pencil size={14} aria-hidden="true" />Editar</button>,
        ])} />}
    </div>}

    {profile !== undefined && <ModalForm title={profile ? 'Editar perfil' : 'Novo perfil'} close={() => setProfile(undefined)} label="Salvar perfil" action={async data => {
      await api(profile ? 'access/profiles/' + profile.id : 'access/profiles', { name: data.get('name'), permissions: data.getAll('permissions') }, profile ? 'PATCH' : 'POST');
      notify('Perfil salvo.');
      await profiles.reload();
    }}>
      <Field name="name" label="Nome do perfil" defaultValue={profile?.name} />
      <div className="stack" style={{ gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: '.9rem' }}>Permissões</span>
        {modules.map(item => <div key={item.id} className="card" style={{ padding: '10px 14px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 20px' }}>
          <strong style={{ flex: '1 1 8rem' }}>{item.name}</strong>
          <label className="check"><input name="permissions" type="checkbox" value={item.id + ':view'} defaultChecked={profile?.permissions.includes(item.id + ':view')} />Ver</label>
          <label className="check"><input name="permissions" type="checkbox" value={item.id + ':operate'} defaultChecked={profile?.permissions.includes(item.id + ':operate')} />Operar</label>
          {item.id === 'production' && <label className="check" title="Altera custos e estoque de ordens concluídas. Não vem junto com Operar e também exige Ver.">
            <input name="permissions" type="checkbox" value={correctPermission} defaultChecked={profile?.permissions.includes(correctPermission)} />Corrigir concluídas</label>}
        </div>)}
      </div>
    </ModalForm>}
    {user !== undefined && <ModalForm title={user ? 'Editar usuário' : 'Novo usuário'} subtitle={user?.email} label="Salvar usuário" close={() => setUser(undefined)} action={async data => {
      const values = fields(data);
      if (user) {
        await api('access/users/' + user.id, { ...values, active: data.has('active') }, 'PATCH');
        notify('Usuário atualizado.');
        await onUserChanged(user.id);
      } else {
        const created = await api<Omit<Code, 'name'>>('access/users', values);
        setCode({ ...created, name: values.name });
      }
      await users.reload();
    }}>
      <Field name="name" label="Nome da pessoa" defaultValue={user?.name} />
      {!user && <Field name="email" label="E-mail" type="email" hint="A pessoa recebe um código para criar a própria senha." />}
      <Select name="profileId" label="Perfil" options={profiles.data ?? []} defaultValue={user?.profileId} />
      {user && <label className="check"><input name="active" type="checkbox" defaultChecked={user.active} />Conta ativa</label>}
    </ModalForm>}
    {renew && <ModalForm title="Gerar novo código" label="Gerar código" close={() => setRenew(undefined)} action={async () => {
      const created = await api<Omit<Code, 'name'>>('access/users/' + renew.id + '/code', {});
      setCode({ ...created, name: renew.name });
      await users.reload();
    }}><p className="muted">O código anterior de {renew.name} deixará de funcionar.</p></ModalForm>}
    {code && <Modal title="Código de primeiro acesso" subtitle={code.name} close={() => setCode(undefined)}>
      <div className="stack">
        <div className="info" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <code style={{ fontSize: '1rem', overflowWrap: 'anywhere' }}>{code.code}</code>
          <button type="button" className="icon-button" aria-label="Copiar código" onClick={() => {
            void navigator.clipboard?.writeText(code.code).then(() => notify('Código copiado.'));
          }}><Copy size={18} aria-hidden="true" /></button>
        </div>
        <p className="muted"><UserRound size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Válido até {dateTime(code.expiresAt)}.
          Entregue-o diretamente à pessoa. Ele não será exibido de novo.</p>
        <button type="button" className="btn" onClick={() => setCode(undefined)}>Concluir</button>
      </div>
    </Modal>}
  </>;
}
