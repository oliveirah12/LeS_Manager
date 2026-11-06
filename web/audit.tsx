import { useState } from 'react';
import { dateTime, Loading, message, Section, Table, useData } from './ui';

type AuditEvent = { id: string; action: string; actorName: string | null; targetId: string | null; status: number | null; createdAt: string };
type AuditPage = { events: AuditEvent[]; nextCursor: string | null };

function outcome(status: number | null) {
  if (status === null) return 'Aguardando conclusão';
  if (status === 499) return 'Conexão interrompida';
  if (status < 400) return 'Concluído';
  if (status === 401 || status === 403) return 'Acesso negado';
  return 'Falhou (' + status + ')';
}

export function Audit() {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const { data, error, loading, reload } = useData<AuditPage>('audit' + (cursor ? '?' + new URLSearchParams({ cursor }) : ''));
  return <Section title="Histórico de atividades" subtitle="Consulte ações, usuários, registros e resultados a partir da ativação da auditoria.">
    <button type="button" className="secondary" disabled={loading} onClick={() => { if (cursor) setCursors([]); else void reload(); }}>Atualizar histórico</button>
    {message(error)}{loading && <Loading label="Carregando auditoria…" />}
    {data && <>
      <Table columns={['Data', 'Usuário', 'Ação', 'Registro', 'Resultado']} rows={data.events.map(event => [
        dateTime(event.createdAt), event.actorName ?? '—', event.action, event.targetId ? <code>{event.targetId}</code> : '—', outcome(event.status),
      ])} />
      <div className="actions">
        {cursor && <button type="button" className="secondary" onClick={() => setCursors(cursors.slice(0, -1))}>Página anterior</button>}
        {data.nextCursor && <button type="button" className="secondary" onClick={() => setCursors([...cursors, data.nextCursor!])}>Mais registros</button>}
      </div>
    </>}
  </Section>;
}
