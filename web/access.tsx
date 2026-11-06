import { useState } from 'react';
import { api, dateTime, Field, fields, Identity, Loading, message, Modal, ModalForm, Section, Select, Table, useData } from './ui';

type Profile = { id: string; name: string; permissions: string[] };
type User = { id: string; name: string; email: string; active: boolean; pending: boolean; profileId: string; activationExpires: string | null };
type Code = { code: string; expiresAt: string };
const modules = [
  { id: 'catalog', name: 'Catálogo' }, { id: 'registrations', name: 'Cadastros' },
  { id: 'stock', name: 'Estoque' }, { id: 'finance', name: 'Financeiro' },
];

export function SignIn({ signedIn, notice }: { signedIn: () => Promise<void>; notice?: string }) {
  const [mode, setMode] = useState<'login' | 'activate'>();
  const activate = mode === 'activate';
  return <main className="signin">
    <div className="intro"><img src="/brand.png" alt="" width="88" height="88" /><span className="eyebrow">Gestão interna</span><h1>LeS Manager</h1><p>Catálogo, estoque e financeiro em um só painel.</p></div>
    <div className="login-card">
      <h2>Acesse seu painel</h2>
      {notice && <p className="success" role="status">{notice}</p>}
      <p className="muted">Entre com a conta criada pelo administrador da empresa.</p>
      <div className="actions">
        <button type="button" onClick={() => setMode('login')}>Entrar</button>
        <button type="button" className="secondary" onClick={() => setMode('activate')}>Primeiro acesso</button>
      </div>
      {mode && <ModalForm title={activate ? 'Primeiro acesso' : 'Entrar'} close={() => setMode(undefined)}
        label={activate ? 'Ativar conta' : 'Entrar no painel'} action={async data => {
        await api(activate ? 'access/activate' : 'access/login', fields(data)); await signedIn();
      }}>
        <label>E-mail<input name="email" type="email" required autoComplete="username" /></label>
        {activate && <label>Código temporário<input name="code" autoComplete="one-time-code" required /></label>}
        <label>Senha<input name="password" type="password" autoComplete={activate ? 'new-password' : 'current-password'} minLength={activate ? 8 : undefined} required /></label>
        {activate && <>
          <label>Confirme a senha<input name="confirmation" type="password" autoComplete="new-password" minLength={8} required /></label>
          <p className="muted">Use pelo menos 8 caracteres, incluindo uma letra e um número.</p>
        </>}
      </ModalForm>}
    </div>
  </main>;
}

export function AccountSettings({ identity, changed, passwordChanged }: {
  identity: Identity; changed: (identity: Identity) => void; passwordChanged: () => void;
}) {
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'name' | 'password'>();
  return <>
    <Section title="Dados da conta">
      <dl className="account-info"><div><dt>Nome</dt><dd>{identity.name}</dd></div><div><dt>E-mail</dt><dd>{identity.email}</dd></div><div><dt>Perfil de acesso</dt><dd>{identity.profileName}</dd></div></dl>
      <div className="actions">
        <button type="button" onClick={() => setDialog('name')}>Alterar nome</button>
        <button type="button" className="secondary" onClick={() => setDialog('password')}>Alterar senha</button>
      </div>
      {dialog === 'name' && <ModalForm title="Alterar nome" close={() => setDialog(undefined)} label="Salvar nome" action={async data => {
        changed(await api<Identity>('access/me', fields(data), 'PATCH'));
        setNotice('Nome atualizado.');
      }}>
        <Field name="name" label="Nome" defaultValue={identity.name} />
      </ModalForm>}
      {notice && <p role="status" className="success">{notice}</p>}
    </Section>
    {dialog === 'password' && <ModalForm title="Alterar senha" close={() => setDialog(undefined)} label="Salvar nova senha" action={async data => {
        await api('access/me/password', fields(data));
        passwordChanged();
      }}>
        <label>Senha atual<input name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required /></label>
        <label>Nova senha<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
        <label>Confirme a nova senha<input name="confirmation" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
        <p className="muted">Use pelo menos 8 caracteres, incluindo uma letra e um número. Ao salvar, suas sessões serão encerradas.</p>
      </ModalForm>}
  </>;
}

export function Administration({ onUserChanged }: { onUserChanged: (id: string) => Promise<void> }) {
  const profiles = useData<Profile[]>('access/profiles');
  const users = useData<User[]>('access/users');
  const [profile, setProfile] = useState<Profile | null>();
  const [user, setUser] = useState<User | null>();
  const [renew, setRenew] = useState<User>();
  const [code, setCode] = useState<Code>();
  return <>
    {message(profiles.error || users.error)}
    <Section title="Perfis de acesso" subtitle="Permitir operação também libera a visualização do módulo.">
      <button type="button" onClick={() => setProfile(null)}>Criar perfil</button>
      {profiles.loading && <Loading label="Carregando perfis…" />}
      {profiles.data && <Table columns={['Perfil', 'Permissões', 'Ação']} rows={profiles.data.map(item => [
        item.name, item.permissions.includes('admin') ? 'Acesso total' : item.permissions.map(permission => {
          const [module, action] = permission.split(':');
          return modules.find(entry => entry.id === module)?.name + ' · ' + (action === 'view' ? 'Visualizar' : 'Operar');
        }).join(' / ') || 'Nenhuma',
        item.permissions.includes('admin') ? 'Reservado' : <button type="button" className="secondary" onClick={() => setProfile(item)}>Editar</button>,
      ])} />}
      {profile !== undefined && <ModalForm title={profile ? 'Editar perfil' : 'Criar perfil'} close={() => setProfile(undefined)} label="Salvar perfil" action={async data => {
        await api(profile ? 'access/profiles/' + profile.id : 'access/profiles',
          { name: data.get('name'), permissions: data.getAll('permissions') }, profile ? 'PATCH' : 'POST');
        await profiles.reload();
      }}>
        <Field name="name" label="Nome do perfil" defaultValue={profile?.name} />
        <div className="permissions">
          {modules.map(item => <div key={item.id}><strong>{item.name}</strong>
            <label><input name="permissions" type="checkbox" value={item.id + ':view'} defaultChecked={profile?.permissions.includes(item.id + ':view')} /> Visualizar</label>
            <label><input name="permissions" type="checkbox" value={item.id + ':operate'} defaultChecked={profile?.permissions.includes(item.id + ':operate')} /> Operar</label>
          </div>)}
        </div>
      </ModalForm>}
    </Section>
    <Section title="Usuários" subtitle="Crie a conta, atribua um perfil e entregue o código de ativação à pessoa.">
      <button type="button" onClick={() => setUser(null)}>Criar usuário</button>
      {users.loading && <Loading label="Carregando usuários…" />}
      {users.data && <Table columns={['Nome', 'E-mail', 'Perfil', 'Situação', 'Ação']} rows={users.data.map(item => [
        item.name, item.email, profiles.data?.find(role => role.id === item.profileId)?.name,
        item.active ? (item.pending ? 'Aguardando ativação' : 'Ativo') : 'Inativo',
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setUser(item)}>Editar</button>
          {item.active && item.pending && <button type="button" className="secondary" onClick={() => setRenew(item)}>Gerar novo código</button>}
        </div>,
      ])} />}
      {renew && !code && <ModalForm title="Gerar novo código" label="Gerar código" close={() => setRenew(undefined)} action={async () => {
        setCode(await api<Code>('access/users/' + renew.id + '/code', {})); await users.reload();
      }}><p>O código anterior de {renew.name} deixará de funcionar.</p></ModalForm>}
      {user !== undefined && !code && <ModalForm title={user ? 'Editar usuário' : 'Criar usuário'} label="Salvar usuário" close={() => setUser(undefined)} action={async data => {
        const values = fields(data);
        if (user) {
          await api('access/users/' + user.id, { ...values, active: data.has('active') }, 'PATCH');
          await onUserChanged(user.id);
        }
        else setCode(await api<Code>('access/users', values));
        await users.reload();
      }}>
        <Field name="name" label="Nome da pessoa" defaultValue={user?.name} />
        {!user && <Field name="email" label="E-mail" type="email" />}
        <Select name="profileId" label="Perfil" options={profiles.data ?? []} defaultValue={user?.profileId} />
        {user && <>
          <label className="check"><input name="active" type="checkbox" defaultChecked={user.active} /> Conta ativa</label>
        </>}
      </ModalForm>}
      {code && <Modal title="Código de primeiro acesso" close={() => setCode(undefined)}>
        <p><code>{code.code}</code></p>
        <p className="muted">Válido até {dateTime(code.expiresAt)}. Compartilhe-o diretamente com a pessoa.</p>
        <button type="button" className="secondary" onClick={() => setCode(undefined)}>Ocultar código</button>
      </Modal>}
    </Section>
  </>;
}
