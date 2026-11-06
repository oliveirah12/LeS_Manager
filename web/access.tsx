import { useState } from 'react';
import { api, dateTime, Field, fields, Form, Identity, message, Section, Select, Table, useData } from './ui';

type Profile = { id: string; name: string; permissions: string[] };
type User = { id: string; name: string; email: string; active: boolean; pending: boolean; profileId: string; activationExpires: string | null };
type Code = { code: string; expiresAt: string };
const modules = [
  { id: 'catalog', name: 'Catálogo' }, { id: 'registrations', name: 'Cadastros' },
  { id: 'stock', name: 'Estoque' }, { id: 'finance', name: 'Financeiro' },
];

export function SignIn({ signedIn, notice }: { signedIn: () => Promise<void>; notice?: string }) {
  const [activate, setActivate] = useState(false);
  return <main className="signin">
    <div className="intro"><img src="/brand.png" alt="" width="88" height="88" /><span className="eyebrow">Gestão interna</span><h1>LeS Manager</h1><p>Catálogo, estoque e financeiro em um só painel.</p></div>
    <div className="login-card">
      <h2>{activate ? 'Primeiro acesso' : 'Entrar'}</h2>
      {notice && <p className="success" role="status">{notice}</p>}
      <p className="muted">{activate ? 'Use o código entregue pelo administrador e escolha sua senha.' : 'Entre com a conta criada pelo administrador da empresa.'}</p>
      <Form key={String(activate)} label={activate ? 'Ativar conta' : 'Entrar no painel'} action={async data => {
        await api(activate ? 'access/activate' : 'access/login', fields(data)); await signedIn();
      }}>
        <label>E-mail<input name="email" type="email" required autoComplete="username" /></label>
        {activate && <label>Código temporário<input name="code" autoComplete="one-time-code" required /></label>}
        <label>Senha<input name="password" type="password" autoComplete={activate ? 'new-password' : 'current-password'} minLength={activate ? 8 : undefined} required /></label>
        {activate && <>
          <label>Confirme a senha<input name="confirmation" type="password" autoComplete="new-password" minLength={8} required /></label>
          <p className="muted">Use pelo menos 8 caracteres, incluindo uma letra e um número.</p>
        </>}
      </Form>
      <button type="button" className="secondary" onClick={() => setActivate(!activate)}>{activate ? 'Voltar para entrar' : 'Primeiro acesso'}</button>
    </div>
  </main>;
}

export function AccountSettings({ identity, changed, passwordChanged }: {
  identity: Identity; changed: (identity: Identity) => void; passwordChanged: () => void;
}) {
  const [notice, setNotice] = useState('');
  return <>
    <Section title="Dados da conta">
      <dl className="account-info"><div><dt>E-mail</dt><dd>{identity.email}</dd></div><div><dt>Perfil de acesso</dt><dd>{identity.profileName}</dd></div></dl>
      <Form label="Salvar nome" action={async data => {
        changed(await api<Identity>('access/me', fields(data), 'PATCH'));
        setNotice('Nome atualizado.');
      }}>
        <Field name="name" label="Nome" defaultValue={identity.name} />
      </Form>
      {notice && <p role="status" className="success">{notice}</p>}
    </Section>
    <Section title="Alterar senha" subtitle="Ao salvar, todas as sessões da sua conta serão encerradas.">
      <Form label="Salvar nova senha" action={async data => {
        await api('access/me/password', fields(data));
        passwordChanged();
      }}>
        <label>Senha atual<input name="currentPassword" type="password" autoComplete="current-password" maxLength={128} required /></label>
        <label>Nova senha<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
        <label>Confirme a nova senha<input name="confirmation" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
        <p className="muted">Use pelo menos 8 caracteres, incluindo uma letra e um número.</p>
      </Form>
    </Section>
  </>;
}

export function Administration({ onUserChanged }: { onUserChanged: (id: string) => Promise<void> }) {
  const profiles = useData<Profile[]>('access/profiles');
  const users = useData<User[]>('access/users');
  const [profile, setProfile] = useState<Profile>();
  const [user, setUser] = useState<User>();
  const [code, setCode] = useState<Code>();
  return <>
    {message(profiles.error || users.error)}
    <Section title="Perfis de acesso" subtitle="Permitir operação também libera a visualização do módulo.">
      <Table columns={['Perfil', 'Permissões', 'Ação']} rows={(profiles.data ?? []).map(item => [
        item.name, item.permissions.includes('admin') ? 'Acesso total' : item.permissions.map(permission => {
          const [module, action] = permission.split(':');
          return modules.find(entry => entry.id === module)?.name + ' · ' + (action === 'view' ? 'Visualizar' : 'Operar');
        }).join(' / ') || 'Nenhuma',
        item.permissions.includes('admin') ? 'Reservado' : <button type="button" className="secondary" onClick={() => setProfile(item)}>Editar</button>,
      ])} />
      <Form key={profile?.id ?? 'new'} label={profile ? 'Salvar perfil' : 'Criar perfil'} reset action={async data => {
        await api(profile ? 'access/profiles/' + profile.id : 'access/profiles',
          { name: data.get('name'), permissions: data.getAll('permissions') }, profile ? 'PATCH' : 'POST');
        setProfile(undefined); await profiles.reload();
      }}>
        <Field name="name" label="Nome do perfil" defaultValue={profile?.name} />
        <div className="permissions">
          {modules.map(item => <div key={item.id}><strong>{item.name}</strong>
            <label><input name="permissions" type="checkbox" value={item.id + ':view'} defaultChecked={profile?.permissions.includes(item.id + ':view')} /> Visualizar</label>
            <label><input name="permissions" type="checkbox" value={item.id + ':operate'} defaultChecked={profile?.permissions.includes(item.id + ':operate')} /> Operar</label>
          </div>)}
        </div>
        {profile && <button type="button" className="secondary" onClick={() => setProfile(undefined)}>Cancelar edição</button>}
      </Form>
    </Section>
    <Section title="Usuários" subtitle="Crie a conta, atribua um perfil e entregue o código de ativação à pessoa.">
      <Table columns={['Nome', 'E-mail', 'Perfil', 'Situação', 'Ação']} rows={(users.data ?? []).map(item => [
        item.name, item.email, profiles.data?.find(role => role.id === item.profileId)?.name,
        item.active ? (item.pending ? 'Aguardando ativação' : 'Ativo') : 'Inativo',
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setUser(item)}>Editar</button>
          {item.active && item.pending && <Form label="Gerar novo código" className="compact" action={async () => {
            setCode(await api<Code>('access/users/' + item.id + '/code', {})); await users.reload();
          }} />}
        </div>,
      ])} />
      <Form key={user?.id ?? 'new'} label={user ? 'Salvar usuário' : 'Criar usuário'} reset action={async data => {
        const values = fields(data);
        if (user) {
          await api('access/users/' + user.id, { ...values, active: data.has('active') }, 'PATCH');
          await onUserChanged(user.id);
        }
        else setCode(await api<Code>('access/users', values));
        setUser(undefined); await users.reload();
      }}>
        <Field name="name" label="Nome da pessoa" defaultValue={user?.name} />
        {!user && <Field name="email" label="E-mail" type="email" />}
        <Select name="profileId" label="Perfil" options={profiles.data ?? []} defaultValue={user?.profileId} />
        {user && <>
          <label className="check"><input name="active" type="checkbox" defaultChecked={user.active} /> Conta ativa</label>
          <button type="button" className="secondary" onClick={() => setUser(undefined)}>Cancelar edição</button>
        </>}
      </Form>
      {code && <div className="preview" role="status">
        <strong>Código de primeiro acesso</strong><p><code>{code.code}</code></p>
        <p className="muted">Válido até {dateTime(code.expiresAt)}. Compartilhe-o diretamente com a pessoa.</p>
        <button type="button" className="secondary" onClick={() => setCode(undefined)}>Ocultar código</button>
      </div>}
    </Section>
  </>;
}
