import { FormEvent, useState } from 'react';
import { dateTime, Loading, message, Section, Table, useData } from './ui';

type Values = Record<string, string | number | boolean | null | string[]>;
type Details = { before?: Values; after?: Values; context?: Values };
type AuditEvent = {
  id: string; action: string; actorName: string | null; targetId: string | null; status: number | null; createdAt: string;
  details: Details | null;
};
type AuditPage = { events: AuditEvent[]; nextCursor: string | null };
type Filters = { userId?: string; action?: string; from?: string; to?: string; result?: string };

function outcome(status: number | null) {
  if (status === null) return 'Aguardando conclusão';
  if (status === 499) return 'Conexão interrompida';
  if (status < 400) return 'Concluído';
  if (status === 401 || status === 403) return 'Acesso negado';
  return 'Falhou (' + status + ')';
}

function show(value: Values[string] | undefined) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}

function Changes({ details }: { details: Details | null }) {
  if (!details) return <>—</>;
  const { before, after, context } = details;
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return <div className="audit-details">
    {context && Object.entries(context).map(([key, value]) => <div key={'c' + key}><strong>{key}:</strong> {show(value)}</div>)}
    {keys.map(key => <div key={key}>
      <strong>{key}:</strong> {before ? <><del>{show(before[key])}</del> → </> : null}{show(after?.[key])}
    </div>)}
  </div>;
}

export function Audit() {
  const [filters, setFilters] = useState<Filters>({});
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const options = useData<{ actions: string[]; users: { id: string; name: string }[] }>('audit/filters');
  const query = new URLSearchParams(Object.entries({ ...filters, cursor }).filter((entry): entry is [string, string] => !!entry[1]));
  const { data, error, loading, reload } = useData<AuditPage>('audit' + (query.size ? '?' + query : ''));

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, String(value)]));
    setFilters(values);
    setCursors([]);
  }

  return <Section title="Histórico de alterações" subtitle="Inclusões, alterações, acessos e tentativas negadas dos últimos 12 meses.">
    <form className="filters" onSubmit={apply} onReset={() => { setFilters({}); setCursors([]); }}>
      <label>Usuário<select name="userId" defaultValue="">
        <option value="">Todos</option>
        {options.data?.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select></label>
      <label>Ação<select name="action" defaultValue="">
        <option value="">Todas</option>
        {options.data?.actions.map(action => <option key={action} value={action}>{action}</option>)}
      </select></label>
      <label>Resultado<select name="result" defaultValue="">
        <option value="">Todos</option>
        <option value="success">Concluído</option>
        <option value="denied">Acesso negado</option>
        <option value="error">Falhou</option>
      </select></label>
      <label>De<input type="date" name="from" /></label>
      <label>Até<input type="date" name="to" /></label>
      <div className="actions">
        <button type="submit">Filtrar</button>
        <button type="reset" className="secondary">Limpar</button>
        <button type="button" className="secondary" disabled={loading} onClick={() => { if (cursor) setCursors([]); else void reload(); }}>Atualizar</button>
      </div>
    </form>
    {message(options.error)}{message(error)}{loading && <Loading label="Carregando auditoria…" />}
    {data && <>
      <Table columns={['Data', 'Usuário', 'Ação', 'Detalhes', 'Resultado']} rows={data.events.map(event => [
        dateTime(event.createdAt), event.actorName ?? '—', event.action, <Changes details={event.details} />, outcome(event.status),
      ])} empty="Nenhum evento encontrado." />
      <div className="actions">
        {cursor && <button type="button" className="secondary" onClick={() => setCursors(cursors.slice(0, -1))}>Página anterior</button>}
        {data.nextCursor && <button type="button" className="secondary" onClick={() => setCursors([...cursors, data.nextCursor!])}>Mais registros</button>}
      </div>
    </>}
  </Section>;
}
