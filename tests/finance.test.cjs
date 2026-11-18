const assert = require('node:assert/strict');
const { test } = require('node:test');
const { InterReader } = require('../dist/api/finance/inter.js');
const { FinanceService } = require('../dist/api/finance/finance.js');

const date = '2026-01-03';
const range = { from: date, to: date };
const entry = { dataTransacao: date, valor: '3.47', tipoOperacao: 'C', tipoTransacao: 'PIX' };
function provider(failPage = false) {
  const calls = [];
  const reader = new InterReader({ clientId: 'test', secret: 'test', account: '1234' }, async (path, headers, body) => {
    calls.push(path);
    if (path === '/oauth/v2/token') {
      assert.equal(new URLSearchParams(body).get('scope'), 'extrato.read');
      return { access_token: 'abc', expires_in: 3600 };
    }
    assert.equal(headers.authorization, 'Bearer abc');
    assert.equal(headers['x-conta-corrente'], '1234');
    if (path.endsWith('/saldo')) return { disponivel: '50.00' };
    const query = new URL(path, 'https://example.test').searchParams;
    assert.equal(query.get('dataInicio'), date);
    assert.equal(query.get('dataFim'), date);
    if (failPage && query.get('pagina') === '1') throw new Error('timeout');
    return { totalPaginas: 2, totalElementos: 2, transacoes: [entry] };
  });
  return { reader, calls };
}

function memoryDatabase() {
  let balance = null;
  const days = new Map();
  let writes = 0;
  const tx = {
    bankReconciliation: { findMany: async () => [] },
    bankBalance: {
      findUnique: async () => balance,
      upsert: async ({ create }) => { balance = create; writes++; },
    },
    bankDay: {
      findMany: async ({ where }) => [...days.values()].filter(day =>
        day.provider === where.provider && (!where.updatedAt || day.updatedAt > where.updatedAt.gt)),
      upsert: async ({ create }) => { days.set(create.provider + ':' + create.date, create); writes++; },
    },
  };
  return { $transaction: async work => work(tx), get writes() { return writes; } };
}

test('refresh fetches every page and reuses its read-only token', async () => {
  const { reader, calls } = provider();
  assert.equal(await reader.balance(), '50.00');
  assert.equal((await reader.statement(date, date)).length, 2);
  assert.equal(calls.filter(path => path === '/oauth/v2/token').length, 1);
  assert.equal(calls.filter(path => path.includes('/extrato/completo')).length, 2);
});

test('reimport replaces the day and preserves legitimately identical rows', async () => {
  const finance = new FinanceService(memoryDatabase());
  const { reader } = provider();
  const source = { id: 'inter', name: 'Inter', open: () => reader };
  await finance.refresh(range, source);
  const result = await finance.refresh(range, source);
  assert.equal(result.balance.available, '50.00');
  assert.equal(result.transactions.length, 2);
  assert.deepEqual(result.transactions[0], result.transactions[1]);
  assert.equal(result.importedDays, 1);
});

test('failure on a later page leaves the last successful update intact', async () => {
  const db = memoryDatabase();
  const finance = new FinanceService(db);
  const good = { id: 'inter', name: 'Inter', open: () => provider().reader };
  const broken = { ...good, open: () => provider(true).reader };
  const saved = await finance.refresh(range, good);
  const writes = db.writes;
  await assert.rejects(new FinanceService(db).refresh(range, broken), { status: 502 });
  assert.equal(db.writes, writes);
  assert.deepEqual(await finance.view(range), saved);
});

test('sums credits and debits exactly, in absolute values', () => {
  const { statementTotals } = require('../dist/api/finance/finance.js');
  const rows = [
    { amount: '0.10', direction: 'C' }, { amount: '0.20', direction: 'C' },
    { amount: '-1250.37', direction: 'D' }, { amount: '0.01', direction: 'D' },
  ];
  assert.deepEqual(statementTotals(rows), { credits: '0.30', debits: '1250.38' });
  assert.deepEqual(statementTotals([]), { credits: '0.00', debits: '0.00' });
});
