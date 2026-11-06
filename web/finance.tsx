import { useState } from 'react';
import { api, brl, dateTime, Field, fields, Loading, message, ModalForm, Section, Select, Table, today, useData } from './ui';

type Balance = { available: string; updatedAt: string };
type Provider = { id: string; name: string };
type Transaction = { key: string | null; date: string; direction: string; amount: string; type: string; title: string; description: string;
  reconciliation: { reference: string | null; updatedAt: string } | null };
type BankView = { transactions: Transaction[]; importedDays: number; requestedDays: number };
type Range = { from: string; to: string };
type Page = 'balance' | 'statement' | 'reconciliation';
const displayDate = (value: string) => value.split('-').reverse().join('/');

export function Finance({ page, edit, openStatement }: { page: Page; edit: boolean; openStatement: () => void }) {
  const [range, setRange] = useState<Range>(() => ({ from: today().slice(0, 8) + '01', to: today() }));
  const [selected, setSelected] = useState('');
  const providers = useData<Provider[]>('finance/providers');
  const provider = providers.data?.find(item => item.id === selected) ?? providers.data?.[0];
  if (!provider) return message(providers.error) || (providers.loading ? <Loading label="Carregando provedores…" /> :
    <p className="empty">Nenhum provedor bancário disponível.</p>);
  return <>
    {(providers.data?.length ?? 0) > 1 ? <div className="provider-select">
      <Select name="provider" label="Provedor bancário" defaultValue={provider.id} options={providers.data ?? []} onChange={id => { if (id) setSelected(id); }} />
    </div> : <p className="provider-label">Provedor bancário · {provider.name}</p>}
    {page === 'balance' ? <BalanceScreen provider={provider} openStatement={openStatement} /> :
      <Statement key={page + provider.id} provider={provider} page={page} edit={edit} range={range} setRange={setRange} />}
  </>;
}

function BalanceScreen({ provider, openStatement }: { provider: Provider; openStatement: () => void }) {
  const { data, error, loading } = useData<{ balance: Balance | null }>('finance/balance?' + new URLSearchParams({ provider: provider.id }));
  const balance = data?.balance;
  return <Section title="Saldo disponível" subtitle="Última consulta bem-sucedida ao provedor.">
    {message(error)}{loading && <Loading label="Consultando saldo…" />}
    {data && <>
      <div className="balance">{brl(balance?.available ?? null)}</div>
      <p className="muted">{balance ? 'Última atualização em ' + dateTime(balance.updatedAt) : 'Aguardando a primeira atualização.'}</p>
    </>}
    <button type="button" onClick={openStatement}>Ver extrato <span aria-hidden="true">→</span></button>
  </Section>;
}

function Statement({ provider, page, edit, range, setRange }: {
  provider: Provider; page: Exclude<Page, 'balance'>; edit: boolean; range: Range; setRange: (range: Range) => void;
}) {
  const params = { ...range, provider: provider.id };
  const { data, error, loading, reload } = useData<BankView>('finance?' + new URLSearchParams(params));
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'filter' | 'sync'>();
  const [transaction, setTransaction] = useState<Transaction>();
  const reconciling = page === 'reconciliation';
  return <Section title={reconciling ? 'Conferência bancária' : 'Lançamentos'}
    subtitle={reconciling ? 'Confira os lançamentos importados e registre, se houver, a referência interna correspondente.' : 'Consulte períodos de até 90 dias.'}>
    {message(error)}{notice && <p className="success" role="status">{notice}</p>}
    <p className="muted">{displayDate(range.from)} a {displayDate(range.to)}</p>
    <div className="actions">
      <button type="button" className="secondary" onClick={() => setDialog('filter')}>Filtrar período</button>
      {edit && <button type="button" onClick={() => setDialog('sync')}>Atualizar dados bancários</button>}
    </div>
    {dialog === 'filter' && <ModalForm title="Filtrar período" label="Aplicar filtro" close={() => setDialog(undefined)} action={async values => {
      const { from, to } = fields(values);
      if (from > to || Date.parse(to) - Date.parse(from) >= 90 * 86400000) throw new Error('Selecione um período de até 90 dias.');
      setRange({ from, to }); setNotice('');
    }}>
      <Field name="from" label="De" type="date" defaultValue={range.from} />
      <Field name="to" label="Até" type="date" defaultValue={range.to} />
    </ModalForm>}
    {dialog === 'sync' && <ModalForm title="Atualizar dados bancários" label="Sincronizar" close={() => setDialog(undefined)} action={async () => {
      setNotice(''); await api('finance/refresh', params); await reload(); setNotice('Dados atualizados.');
    }}><p>{provider.name} · {displayDate(range.from)} a {displayDate(range.to)}. A sincronização consulta o saldo e o extrato.</p></ModalForm>}
    {loading && <Loading label="Carregando lançamentos…" />}
    {data && <>
      <p className="muted">{data.importedDays} de {data.requestedDays} dias consultados.</p>
      <Table columns={['Data', 'Operação', 'Descrição', 'Valor', ...(reconciling ? ['Conciliação'] : [])]} rows={data.transactions.map(row => [
        displayDate(row.date), row.direction, [row.title || row.type, row.description].filter(Boolean).join(' · '), brl(row.amount),
        ...(reconciling ? [<div className="reconciliation-status">
          <span>{row.reconciliation ? 'Conciliado' + (row.reconciliation.reference ? ' · ' + row.reconciliation.reference : '') :
            row.key ? 'Pendente' : 'Sem identificador único'}</span>
          {edit && row.key && <button type="button" className="secondary" onClick={() => setTransaction(row)}>
            {row.reconciliation ? 'Editar' : 'Conciliar'}
          </button>}
        </div>] : []),
      ])} empty="Nenhum lançamento disponível para o período." />
    </>}
    {transaction && <ModalForm title="Conciliar lançamento" label="Salvar conciliação" close={() => setTransaction(undefined)} action={async values => {
      const { matched, reference } = fields(values);
      await api('finance/reconciliation', { provider: provider.id, date: transaction.date, key: transaction.key, matched: matched === 'yes', reference });
      await reload(); setNotice('Conciliação atualizada.');
    }}>
      <p>{displayDate(transaction.date)} · {transaction.title || transaction.type} · {brl(transaction.amount)}</p>
      <Select name="matched" label="Situação" defaultValue="yes" options={[{ id: 'yes', name: 'Conciliado' }, { id: 'no', name: 'Pendente' }]} />
      <Field name="reference" label="Referência interna (opcional)" defaultValue={transaction.reconciliation?.reference ?? ''} required={false} />
    </ModalForm>}
  </Section>;
}
