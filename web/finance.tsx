import { useState } from 'react';
import { api, brl, dateTime, Field, fields, Form, message, Section, Table, today, useData } from './ui';

type Balance = { available: string; updatedAt: string };
type BankView = {
  transactions: { date: string; direction: string; amount: string; type: string; title: string; description: string }[];
  importedDays: number; requestedDays: number;
};
type Range = { from: string; to: string };

export function Finance({ page, edit, openStatement }: { page: 'balance' | 'statement'; edit: boolean; openStatement: () => void }) {
  const [range, setRange] = useState<Range>(() => ({ from: today().slice(0, 8) + '01', to: today() }));
  return page === 'balance' ? <BalanceScreen openStatement={openStatement} /> :
    <Statement edit={edit} range={range} setRange={setRange} />;
}

function BalanceScreen({ openStatement }: { openStatement: () => void }) {
  const { data, error } = useData<{ balance: Balance | null }>('finance/balance');
  const balance = data?.balance;
  return <Section title="Saldo disponível" subtitle="Inter Empresas · última consulta bem-sucedida">
    {message(error)}
    <div className="balance">{brl(balance?.available ?? null)}</div>
    {balance ? <p className="muted">Última atualização em {dateTime(balance.updatedAt)}</p> :
      balance === null && <p className="muted">Aguardando a primeira atualização.</p>}
    <button type="button" onClick={openStatement}>Ver extrato <span aria-hidden="true">→</span></button>
  </Section>;
}

function Statement({ edit, range, setRange }: { edit: boolean; range: Range; setRange: (range: Range) => void }) {
  const { data, error, reload } = useData<BankView>('finance?' + new URLSearchParams(range));
  const [notice, setNotice] = useState('');
  return <Section title="Lançamentos" subtitle="Consulte períodos de até 90 dias.">
    {message(error)}{notice && <p className="success" role="status">{notice}</p>}
    <div className="columns">
      <Form label="Filtrar extrato" action={async values => {
        const { from, to } = fields(values); setRange({ from, to }); setNotice('');
      }}>
        <Field name="from" label="De" type="date" defaultValue={range.from} />
        <Field name="to" label="Até" type="date" defaultValue={range.to} />
      </Form>
      {edit && <Form label="Atualizar saldo e extrato do período" action={async () => {
        setNotice(''); await api('finance/refresh', range); await reload(); setNotice('Dados atualizados.');
      }}><p className="muted">Período selecionado: {range.from.split('-').reverse().join('/')} a {range.to.split('-').reverse().join('/')}</p></Form>}
    </div>
    {data && <p className="muted">{data.importedDays} de {data.requestedDays} dias consultados no Inter.</p>}
    <Table columns={['Data', 'Operação', 'Descrição', 'Valor']} rows={(data?.transactions ?? []).map(row => [
      row.date.split('-').reverse().join('/'), row.direction, [row.title || row.type, row.description].filter(Boolean).join(' · '), brl(row.amount),
    ])} empty="Nenhum lançamento disponível para o período." />
  </Section>;
}
