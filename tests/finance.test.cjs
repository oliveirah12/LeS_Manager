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
    bankBalance: {
      findUnique: async () => balance,
      upsert: async ({ create }) => { balance = create; writes++; },
    },
    bankDay: {
      findMany: async () => [...days.values()],
      upsert: async ({ create }) => { days.set(create.date, create); writes++; },
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
  await finance.refresh(range, reader);
  const result = await finance.refresh(range, reader);
  assert.equal(result.balance.available, '50.00');
  assert.equal(result.transactions.length, 2);
  assert.deepEqual(result.transactions[0], result.transactions[1]);
  assert.equal(result.importedDays, 1);
});

test('failure on a later page leaves the last successful update intact', async () => {
  const db = memoryDatabase();
  const finance = new FinanceService(db);
  const saved = await finance.refresh(range, provider().reader);
  const writes = db.writes;
  await assert.rejects(finance.refresh(range, provider(true).reader), { status: 502 });
  assert.equal(db.writes, writes);
  assert.deepEqual(await finance.view(range), saved);
});
