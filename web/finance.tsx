import { useState } from 'react';
import { CalendarRange, CheckCircle2, ChevronRight, RefreshCw } from 'lucide-react';
import {
  api, Badge, brl, dateTime, displayDate, Empty, Field, fields, Loading, matches, message, ModalForm, notify, PageActions, relativeTime,
  SearchInput, Segmented, Select, Table, today, useData,
} from './ui';

type Balance = { available: string; updatedAt: string };
type Provider = { id: string; name: string };
type Transaction = { key: string | null; date: string; direction: string; amount: string; type: string; title: string; description: string;
  reconciliation: { reference: string | null; updatedAt: string } | null };
type BankView = { transactions: Transaction[]; totals: { credits: string; debits: string }; importedDays: number; requestedDays: number };
type Range = { from: string; to: string };
type Page = 'balance' | 'statement' | 'reconciliation';

const shift = (date: string, days: number) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
const presets = () => {
  const now = today();
  return [
    { id: 'month', name: 'Este mês', range: { from: now.slice(0, 8) + '01', to: now } },
    { id: '7', name: 'Últimos 7 dias', range: { from: shift(now, -6), to: now } },
    { id: '30', name: 'Últimos 30 dias', range: { from: shift(now, -29), to: now } },
  ];
};
const credit = (row: Transaction) => row.direction === 'C';

export function Finance({ page, edit, openStatement }: { page: Page; edit: boolean; openStatement: () => void }) {
  const [selected, setSelected] = useState('');
  const providers = useData<Provider[]>('finance/providers');
  const provider = providers.data?.find(item => item.id === selected) ?? providers.data?.[0];
  if (!provider) return message(providers.error) || (providers.loading ? <Loading label="Carregando provedores…" /> :
    <Empty>Nenhum provedor bancário disponível.</Empty>);
  return <>
    {(providers.data?.length ?? 0) > 1 && <div className="toolbar" style={{ maxWidth: 320 }}>
      <Select name="provider" label="Banco" defaultValue={provider.id} options={providers.data ?? []} onChange={id => { if (id) setSelected(id); }} />
    </div>}
    {page === 'balance' ? <BalanceScreen provider={provider} edit={edit} openStatement={openStatement} /> :
      <Statement key={provider.id} provider={provider} reconciling={page === 'reconciliation'} edit={edit} />}
  </>;
}

function SyncForm({ provider, range, close, done }: { provider: Provider; range: Range; close: () => void; done: () => Promise<void> }) {
  return <ModalForm title="Sincronizar com o banco" label="Sincronizar" close={close} action={async () => {
    await api('finance/refresh', { ...range, provider: provider.id });
    notify('Saldo e extrato atualizados.');
    await done();
  }}>
    <p className="muted">Consulta o saldo e o extrato de {displayDate(range.from)} a {displayDate(range.to)} no {provider.name}.
      Os dias consultados substituem a versão gravada, e as conciliações dos lançamentos identificados são preservadas.</p>
  </ModalForm>;
}

function BalanceScreen({ provider, edit, openStatement }: { provider: Provider; edit: boolean; openStatement: () => void }) {
  const { data, error, loading, reload } = useData<{ balance: Balance | null }>('finance/balance?' + new URLSearchParams({ provider: provider.id }));
  const [sync, setSync] = useState(false);
  const balance = data?.balance;
  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => setSync(true)}><RefreshCw size={16} aria-hidden="true" />Sincronizar</button></PageActions>}
    {message(error)}
    {loading && !data ? <Loading label="Consultando saldo…" /> : <section className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 560 }}>
      <span className="muted">Saldo disponível · {provider.name}</span>
      <strong className="num" style={{ fontSize: '2.2rem', letterSpacing: '-.02em', lineHeight: 1.15 }}>{brl(balance?.available ?? null)}</strong>
      <span className="muted" style={{ fontSize: '.85rem' }}>{balance ? 'Sincronizado ' + relativeTime(balance.updatedAt) + ' · ' + dateTime(balance.updatedAt)
        : 'Aguardando a primeira sincronização.'}</span>
      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn secondary" onClick={openStatement}>Ver extrato<ChevronRight size={16} aria-hidden="true" /></button>
      </div>
    </section>}
    {sync && <SyncForm provider={provider} range={presets()[0].range} close={() => setSync(false)} done={reload} />}
  </>;
}

function Statement({ provider, reconciling, edit }: { provider: Provider; reconciling: boolean; edit: boolean }) {
  const [range, setRange] = useState<Range>(() => presets()[0].range);
  const [dialog, setDialog] = useState<'period' | 'sync'>();
  const [transaction, setTransaction] = useState<Transaction>();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'pending' | 'done' | 'all'>(reconciling ? 'pending' : 'all');
  const { data, error, loading, reload } = useData<BankView>('finance?' + new URLSearchParams({ ...range, provider: provider.id }));
  const transactions = data?.transactions ?? [];
  const pending = transactions.filter(row => row.key && !row.reconciliation);
  const rows = transactions.filter(row => matches(query, row.title, row.type, row.description, row.reconciliation?.reference) &&
    (status === 'all' || (status === 'pending' ? row.key && !row.reconciliation : row.reconciliation)));
  const description = (row: Transaction) => <><span className="cell-title">{row.title || row.type}</span>
    {row.description && <span className="cell-sub">{row.description}</span>}</>;
  const amount = (row: Transaction) => <strong style={{ color: credit(row) ? 'var(--ok)' : undefined }}>{credit(row) ? '+ ' : '− '}{brl(Math.abs(Number(row.amount)))}</strong>;

  return <>
    {edit && <PageActions><button type="button" className="btn" onClick={() => setDialog('sync')}><RefreshCw size={16} aria-hidden="true" />Sincronizar período</button></PageActions>}
    <div className="toolbar">
      <button type="button" className="btn secondary" onClick={() => setDialog('period')}>
        <CalendarRange size={16} aria-hidden="true" />{displayDate(range.from)} – {displayDate(range.to)}</button>
      <SearchInput value={query} onChange={setQuery} placeholder="Buscar descrição ou referência" />
      {reconciling && <Segmented label="Situação" value={status} onChange={setStatus}
        options={[{ id: 'pending', name: 'Pendentes' }, { id: 'done', name: 'Conciliados' }, { id: 'all', name: 'Todos' }]} />}
    </div>
    {message(error)}
    {data && <div className="kpis">
      <div className="card kpi"><span>Entradas</span><strong style={{ color: 'var(--ok)' }}>{brl(data?.totals.credits ?? null)}</strong>
        <small>{transactions.filter(credit).length} lançamentos</small></div>
      <div className="card kpi"><span>Saídas</span><strong>{brl(data?.totals.debits ?? null)}</strong>
        <small>{transactions.filter(row => !credit(row)).length} lançamentos</small></div>
      {reconciling ? <div className="card kpi"><span>A conciliar</span><strong style={{ color: pending.length ? 'var(--warn)' : undefined }}>{pending.length}</strong>
        <small>{transactions.length - pending.length} conferidos ou sem identificador</small></div>
        : <div className="card kpi"><span>Dias importados</span><strong>{data.importedDays} de {data.requestedDays}</strong>
          <small>{data.importedDays < data.requestedDays ? 'Sincronize para completar o período' : 'Período completo'}</small></div>}
    </div>}
    {loading && !data ? <Loading label="Carregando lançamentos…" /> : data && <Table empty={transactions.length ? 'Nenhum lançamento com esses filtros.' : 'Nenhum lançamento importado para o período.'}
      columns={['Descrição', 'Data', { label: 'Valor', end: true }, ...(reconciling ? ['Conciliação', ...(edit ? [{ label: 'Ações', actions: true }] : [])] : [])]}
      rows={rows.map(row => [
        description(row), displayDate(row.date), amount(row),
        ...(reconciling ? [
          row.reconciliation ? <Badge tone="ok"><CheckCircle2 size={12} aria-hidden="true" />{row.reconciliation.reference || 'Conciliado'}</Badge>
            : row.key ? <Badge tone="warn">Pendente</Badge> : <Badge>Sem identificador</Badge>,
          ...(edit ? [row.key ? <button type="button" className="btn secondary small" onClick={() => setTransaction(row)}>
            {row.reconciliation ? 'Editar' : 'Conciliar'}</button> : <span />] : []),
        ] : []),
      ])} />}

    {dialog === 'period' && <ModalForm title="Período" label="Aplicar" close={() => setDialog(undefined)} action={async values => {
      const { from, to } = fields(values);
      if (from > to || Date.parse(to) - Date.parse(from) >= 90 * 86400000) throw new Error('Selecione um período de até 90 dias.');
      setRange({ from, to });
    }}>
      <div className="actions">{presets().map(preset => <button type="button" key={preset.id} className="btn secondary small" onClick={event => {
        const form = event.currentTarget.form!;
        (form.elements.namedItem('from') as HTMLInputElement).value = preset.range.from;
        (form.elements.namedItem('to') as HTMLInputElement).value = preset.range.to;
      }}>{preset.name}</button>)}</div>
      <div className="form-grid">
        <Field name="from" label="De" type="date" defaultValue={range.from} />
        <Field name="to" label="Até" type="date" defaultValue={range.to} />
      </div>
      <p className="hint">Até 90 dias por consulta.</p>
    </ModalForm>}
    {dialog === 'sync' && <SyncForm provider={provider} range={range} close={() => setDialog(undefined)} done={reload} />}
    {transaction && <ModalForm title="Conciliar lançamento" subtitle={displayDate(transaction.date) + ' · ' + (transaction.title || transaction.type)}
      label="Salvar conciliação" close={() => setTransaction(undefined)} action={async values => {
        const { matched, reference } = fields(values);
        await api('finance/reconciliation', { provider: provider.id, date: transaction.date, key: transaction.key, matched: matched === 'yes', reference });
        notify(matched === 'yes' ? 'Lançamento conciliado.' : 'Conciliação removida.');
        await reload();
      }}>
      <div className="info" style={{ justifyContent: 'space-between' }}><span>{transaction.description || transaction.type}</span>{amount(transaction)}</div>
      <Select name="matched" label="Situação" defaultValue="yes" options={[{ id: 'yes', name: 'Conciliado' }, { id: 'no', name: 'Pendente' }]} />
      <Field name="reference" label="Referência interna (opcional)" defaultValue={transaction.reconciliation?.reference ?? ''} required={false}
        placeholder="Pedido, nota fiscal ou documento" />
    </ModalForm>}
  </>;
}
