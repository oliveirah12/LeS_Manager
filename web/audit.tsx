import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge, dateTime, Field, Filters, Loading, message, PageActions, Select, Table, useData } from './ui';

type Values = Record<string, string | number | boolean | null | string[]>;
type Details = { before?: Values; after?: Values; context?: Values };
type AuditEvent = {
  id: string; action: string; actorName: string | null; targetId: string | null; status: number | null; createdAt: string;
  details: Details | null;
};
type AuditPage = { events: AuditEvent[]; nextCursor: string | null };
type Filters = { userId?: string; action?: string; from?: string; to?: string; result?: string };

function Outcome({ status }: { status: number | null }) {
  if (status === null) return <Badge>Em andamento</Badge>;
  if (status === 499) return <Badge>Interrompido</Badge>;
  if (status < 400) return <Badge tone="ok">Concluído</Badge>;
  if (status === 401 || status === 403) return <Badge tone="danger">Negado</Badge>;
  return <Badge tone="warn">Falhou ({status})</Badge>;
}

function show(value: Values[string] | undefined) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}

function Changes({ details }: { details: Details | null }) {
  if (!details) return <span className="muted">—</span>;
  const { before, after, context } = details;
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  return <div className="changes">
    {context && Object.entries(context).map(([key, value]) => <div key={'c' + key}><span className="muted">{key}:</span> {show(value)}</div>)}
    {keys.map(key => <div key={key}>
      <span className="muted">{key}:</span> {before && key in before ? <><del>{show(before[key])}</del> → </> : null}<strong>{show(after?.[key])}</strong>
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
  const active = Object.values(filters).filter(Boolean).length;

  return <>
    <PageActions><button type="button" className="btn secondary" disabled={loading} onClick={() => { if (cursor) setCursors([]); else void reload(); }}>
      <RefreshCw size={16} aria-hidden="true" />Atualizar</button></PageActions>
    <Filters active={active} apply={values => { setFilters(values); setCursors([]); }} clear={() => { setFilters({}); setCursors([]); }}>
      <Select name="userId" label="Usuário" required={false} placeholder="Todos" options={options.data?.users ?? []} />
      <Select name="action" label="Ação" required={false} placeholder="Todas" options={(options.data?.actions ?? []).map(action => ({ id: action, name: action }))} />
      <Select name="result" label="Resultado" required={false} placeholder="Todos"
        options={[{ id: 'success', name: 'Concluído' }, { id: 'denied', name: 'Negado' }, { id: 'error', name: 'Falhou' }]} />
      <Field name="from" label="De" type="date" required={false} />
      <Field name="to" label="Até" type="date" required={false} />
    </Filters>
    {message(options.error)}{message(error)}
    {loading && !data ? <Loading label="Carregando auditoria…" /> : data && <Table empty="Nenhum evento encontrado."
      columns={['Ação', 'Usuário', 'Data', 'Detalhes', 'Resultado']}
      rows={data.events.map(event => [
        <span className="cell-title">{event.action}</span>, event.actorName ?? <span className="muted">—</span>, dateTime(event.createdAt),
        <Changes details={event.details} />, <Outcome status={event.status} />,
      ])}
      footer={(cursor || data.nextCursor) && <>
        <span>Página {cursors.length + 1}</span>
        <div className="actions">
          <button type="button" className="btn secondary small" disabled={!cursor} onClick={() => setCursors(cursors.slice(0, -1))}>Anterior</button>
          <button type="button" className="btn secondary small" disabled={!data.nextCursor} onClick={() => setCursors([...cursors, data.nextCursor!])}>Próxima</button>
        </div>
      </>} />}
  </>;
}
