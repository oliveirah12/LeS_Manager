const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');

const databaseUrl = process.env.TEST_DATABASE_URL;

test('API REST com PostgreSQL', {
  skip: databaseUrl ? false : 'Defina TEST_DATABASE_URL para um banco PostgreSQL de testes já migrado.',
  timeout: 90_000,
}, async t => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.COOKIE_SECURE = 'false';
  const { PrismaClient } = require('@prisma/client');
  const { Workbook } = require('exceljs');
  const { hashPassword } = require('../dist/api/access/security.js');
  const { createApp } = require('../dist/api/main.js');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  t.after(() => db.$disconnect());
  const app = await createApp();
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  // Each run uses its own records so the suite can be repeated on an isolated database.
  const run = randomUUID().slice(0, 8).toUpperCase();
  const sku = name => run + '-' + name;
  const adminEmail = run.toLowerCase() + '-admin@example.com';
  const password = 'Senha-testes9';
  await db.user.create({
    data: {
      email: adminEmail,
      name: 'Administrador de teste',
      passwordHash: await hashPassword(password),
      profile: { create: { name: sku('ADMIN'), permissions: ['admin'] } },
    },
  });

  async function request(path, { method = 'GET', cookie, body } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(baseUrl + '/api' + path, { method, headers, body });
    const data = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.arrayBuffer();
    return {
      status: response.status,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
      cacheControl: response.headers.get('cache-control'),
      data,
    };
  }

  function expectStatus(response, expected) {
    const statuses = Array.isArray(expected) ? expected : [expected];
    assert.ok(statuses.includes(response.status), `Esperado ${statuses.join(' ou ')}, recebido ${response.status}: ${JSON.stringify(response.data)}`);
    return response.data;
  }

  const login = await request('/access/login', { method: 'POST', body: { email: adminEmail, password } });
  expectStatus(login, 200);
  assert.match(login.cookie, /^les_session=/);
  const admin = (path, options = {}) => request(path, { ...options, cookie: login.cookie });
  const post = (path, body) => admin(path, { method: 'POST', body });
  async function loadTemplate(path) {
    const bytes = expectStatus(await admin(path), 200);
    const workbook = new Workbook();
    await workbook.xlsx.load(Buffer.from(bytes));
    return workbook;
  }
  async function uploadWorkbook(path, workbook) {
    const bytes = await workbook.xlsx.writeBuffer();
    const file = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const body = new FormData();
    body.append('file', file, 'estoque.xlsx');
    return post(path, body);
  }
  const createFamily = (name, baseSymbol) => post('/catalog/families', { name: sku(name), baseSymbol }).then(response => expectStatus(response, 201));
  const createProduct = (name, unitId) => post('/catalog/products', {
    sku: sku(name), name, unitId,
  }).then(response => expectStatus(response, 201));
  const movement = (productId, unitId, kind, quantity, unitCost) => post('/stock/movements', {
    productId, unitId, kind, quantity, unitCost, reason: 'Movimentação de teste',
  });
  const productRow = id => db.product.findUniqueOrThrow({ where: { id } });
  const productMovements = (productId, kind) => db.movement.findMany({
    where: { productId, kind },
  });

  const weight = await createFamily('PESO', sku('G'));
  const gram = weight.units[0];
  const kilogram = expectStatus(await post('/catalog/units', {
    familyId: weight.id, symbol: sku('KG'), factor: '1000',
  }), 201);
  const pieces = await createFamily('CONTAGEM', sku('UN'));
  const unit = pieces.units[0];

  await t.test('ativação obrigatória, senha válida, expiração, uso único e autorização', async () => {
    const anonymous = await request('/stock');
    expectStatus(anonymous, 401);
    assert.equal(anonymous.cacheControl, 'no-store');
    const profile = expectStatus(await post('/access/profiles', { name: sku('LEITURA'), permissions: ['stock:view'] }), 201);
    const email = run.toLowerCase() + '-estoque@example.com';
    const user = expectStatus(await post('/access/users', { name: 'Pessoa de estoque', email, profileId: profile.id }), 201);
    assert.ok(new Date(user.expiresAt).getTime() - Date.now() > 23 * 60 * 60 * 1_000);
    const pending = await request('/access/login', { method: 'POST', body: { email, password } });
    expectStatus(pending, 401);
    assert.equal(pending.cookie, undefined);

    const activate = (code, newPassword = password, confirmation = newPassword) => request('/access/activate', {
      method: 'POST', body: { email, code, password: newPassword, confirmation },
    });
    await db.user.update({ where: { id: user.id }, data: { activationExpires: new Date(0) } });
    expectStatus(await activate(user.code), 401);
    const replacement = expectStatus(await post(`/access/users/${user.id}/code`), 201);
    expectStatus(await activate(user.code), 401);
    for (const weak of ['abc1234', 'abcdefgh', '12345678']) {
      const invalid = await activate(replacement.code, weak);
      expectStatus(invalid, 400);
      assert.equal(invalid.cookie, undefined);
    }
    expectStatus(await activate(replacement.code, password, 'Outra-senha5'), 400);
    const attempts = await Promise.all([activate(replacement.code), activate(replacement.code)]);
    assert.deepEqual(attempts.map(response => response.status).sort(), [200, 401]);
    const { cookie } = attempts.find(response => response.status === 200);
    assert.match(cookie, /^les_session=/);
    assert.deepEqual(expectStatus(await request('/access/me', { cookie }), 200).permissions, ['stock:view']);
    const authorized = await request('/stock', { cookie });
    expectStatus(authorized, 200);
    assert.equal(authorized.cacheControl, 'no-store');
    expectStatus(await request('/stock/movements', { method: 'POST', cookie, body: {} }), 403);
    expectStatus(await request('/catalog', { cookie }), 403);
    expectStatus(await request('/access/users', { cookie }), 403);
    expectStatus(await activate(replacement.code), 401);
    const otherSession = await request('/access/login', { method: 'POST', body: { email, password } });
    expectStatus(otherSession, 200);
    const updateMe = body => request('/access/me', { cookie, method: 'PATCH', body });
    const self = expectStatus(await updateMe({ name: 'Nome atualizado' }), 200);
    assert.equal(self.name, 'Nome atualizado');
    assert.equal(self.profileName, profile.name);
    assert.deepEqual(self.permissions, ['stock:view']);
    expectStatus(await updateMe({ name: 'Outra pessoa', profileId: randomUUID() }), 400);
    assert.equal(expectStatus(await request('/access/me', { cookie }), 200).name, 'Nome atualizado');

    const newPassword = 'Nova-senha12';
    const changePassword = currentPassword => request('/access/me/password', {
      cookie, method: 'POST', body: { currentPassword, password: newPassword, confirmation: newPassword },
    });
    expectStatus(await changePassword('Senha-incorreta1'), 403);
    expectStatus(await changePassword(password), 200);
    expectStatus(await request('/access/me', { cookie }), 401);
    expectStatus(await request('/access/me', { cookie: otherSession.cookie }), 401);
    expectStatus(await request('/access/login', { method: 'POST', body: { email, password } }), 401);
    expectStatus(await request('/access/login', { method: 'POST', body: { email, password: newPassword } }), 200);
  });

  await t.test('permissões independentes para catálogo, cadastros, estoque e financeiro', async () => {
    const product = await createProduct('CATALOGO-RESTRITO', unit.id);
    expectStatus(await movement(product.id, unit.id, 'PURCHASE', '9', '3'), 201);
    const kit = expectStatus(await post('/catalog/kits', {
      sku: sku('KIT-RESTRITO'), name: 'Kit sem exposição de saldo',
      components: [{ productId: product.id, quantity: '2', unitId: unit.id }],
    }), 201);
    const profile = expectStatus(await post('/access/profiles', {
      name: sku('CATALOGO'), permissions: ['catalog:operate'],
    }), 201);
    const email = run.toLowerCase() + '-catalogo@example.com';
    const user = expectStatus(await post('/access/users', { name: 'Pessoa de catálogo', email, profileId: profile.id }), 201);
    const activation = await request('/access/activate', {
      method: 'POST', body: { email, code: user.code, password, confirmation: password },
    });
    expectStatus(activation, 200);
    const catalog = (path, options = {}) => request(path, { ...options, cookie: activation.cookie });
    const overview = expectStatus(await catalog('/catalog'), 200);
    const item = overview.products.find(row => row.id === product.id);
    const kitItem = overview.kits.find(row => row.id === kit.id);
    for (const row of [item, kitItem.components[0].product]) {
      assert.equal(row.sku, product.sku);
      assert.equal('quantity' in row, false);
      assert.equal('currentCost' in row, false);
    }
    assert.equal('available' in kitItem, false);
    const encodedProduct = '%' + product.id.charCodeAt(0).toString(16) + product.id.slice(1);
    expectStatus(await catalog('/catalog/products/' + encodedProduct, { method: 'PATCH', body: { name: 'Produto editado' } }), 200);
    expectStatus(await catalog('/audit'), 403);
    const audit = expectStatus(await admin('/audit'), 200);
    assert.ok(audit.events.some(event => event.action === 'Alterar produto' && event.actorId === user.id &&
      event.targetId === product.id && event.status === 200));
    assert.equal(JSON.stringify(audit).includes(password), false);
    expectStatus(await catalog('/catalog/registrations'), 403);
    expectStatus(await catalog('/catalog/references', { method: 'POST', body: { kind: 'COR', name: sku('COR') } }), 403);
    expectStatus(await catalog('/stock'), 403);
    expectStatus(await catalog('/stock/initial/template'), 403);
    expectStatus(await catalog('/stock/initial/preview', { method: 'POST' }), 403);
    expectStatus(await catalog(`/stock/initial/${randomUUID()}/confirm`, { method: 'POST' }), 403);
    expectStatus(await catalog('/finance/balance'), 403);

    expectStatus(await admin('/access/profiles/' + profile.id, {
      method: 'PATCH', body: { name: profile.name, permissions: ['registrations:operate', 'finance:view'] },
    }), 200);
    expectStatus(await catalog('/catalog'), 403);
    expectStatus(await catalog('/catalog/registrations'), 200);
    expectStatus(await catalog('/catalog/references', { method: 'POST', body: { kind: 'COR', name: sku('COR') } }), 201);
    expectStatus(await catalog('/catalog/families', { method: 'POST', body: { name: sku('OUTRA'), baseSymbol: sku('X') } }), 403);
    assert.equal('balance' in expectStatus(await catalog('/finance/balance'), 200), true);
    expectStatus(await catalog('/finance/refresh', { method: 'POST' }), 403);
  });

  await t.test('conciliação persiste na reimportação e isola provedores', async () => {
    const { FinanceService } = require('../dist/api/finance/finance.js');
    const finance = app.get(FinanceService);
    const date = '2099-01-01';
    const range = { from: date, to: date };
    const entry = { id: randomUUID(), date, amount: '19.90', direction: 'C', type: 'PIX', title: 'Teste', description: '' };
    const duplicate = { ...entry, id: 'duplicate-' + run };
    let entries = [entry, duplicate, duplicate, { ...entry, id: null }];
    const source = id => ({ id, name: id, open: () => ({ balance: async () => '50.00', statement: async () => entries }) });
    await finance.refresh(range, source('inter'));
    const read = await admin('/finance?' + new URLSearchParams({ ...range, provider: 'inter' }));
    const { transactions } = expectStatus(read, 200);
    const [{ key }] = transactions;
    assert.ok(key);
    assert.ok(transactions.slice(1).every(row => row.key === null));

    const update = { provider: 'inter', date, key, matched: true, reference: 'Documento QA' };
    expectStatus(await post('/finance/reconciliation', update), 201);
    entries = [...entries].reverse();
    const refreshed = await finance.refresh(range, source('inter'));
    assert.equal(refreshed.transactions.at(-1).reconciliation.reference, 'Documento QA');
    const other = await finance.refresh(range, source('qa-' + run));
    assert.equal(other.transactions.at(-1).reconciliation, null);
    expectStatus(await post('/finance/reconciliation', { ...update, matched: false }), 201);
    const unlinked = await finance.view(range, 'inter');
    assert.equal(unlinked.transactions.at(-1).reconciliation, null);
  });

  await t.test('conversão exata e preservação do custo registrado em cada saída', async () => {
    const product = await createProduct('PESO', gram.id);
    expectStatus(await movement(product.id, kilogram.id, 'PURCHASE', '2', '14.25'), 201);
    expectStatus(await movement(product.id, gram.id, 'OUT', '250'), 201);
    assert.equal((await productRow(product.id)).quantity.toString(), '1750');
    expectStatus(await movement(product.id, kilogram.id, 'PURCHASE', '1', '19.5'), 201);
    expectStatus(await movement(product.id, gram.id, 'OUT', '500'), 201);

    const out = await productMovements(product.id, 'OUT');
    assert.deepEqual(new Map(out.map(row => [row.quantity.abs().toString(), row.unitCost.toString()])), new Map([
      ['250', '0.01425'], ['500', '0.0195'],
    ]));
    const stock = await productRow(product.id);
    assert.equal(stock.quantity.toString(), '2250');
    assert.equal(stock.currentCost.toString(), '0.0195');

    const precise = await createProduct('PRECISAO', gram.id);
    expectStatus(await movement(precise.id, gram.id, 'PURCHASE', '123456789012345678.123456789012', '1'), 201);
    expectStatus(await movement(precise.id, gram.id, 'ADJUSTMENT', '0.000000000001'), 201);
    assert.equal((await productRow(precise.id)).quantity.toFixed(), '123456789012345678.123456789013');
  });

  await t.test('a baixa do kit é atômica e registra todos os componentes quando há saldo', async () => {
    const first = await createProduct('KIT-PRIMEIRO', unit.id);
    const second = await createProduct('KIT-SEGUNDO', gram.id);
    expectStatus(await movement(first.id, unit.id, 'PURCHASE', '5', '8'), 201);
    expectStatus(await movement(second.id, gram.id, 'PURCHASE', '10', '2'), 201);
    const kit = expectStatus(await post('/catalog/kits', {
      sku: sku('KIT'), name: 'Kit de teste',
      components: [
        { productId: first.id, quantity: '2', unitId: unit.id },
        { productId: second.id, quantity: '100', unitId: gram.id },
      ],
    }), 201);
    const out = () => post(`/stock/kits/${kit.id}/out`, { quantity: '1', reason: 'Saída de kit de teste' });
    expectStatus(await out(), [400, 409]);
    assert.equal((await productRow(first.id)).quantity.toString(), '5');
    assert.equal((await productRow(second.id)).quantity.toString(), '10');
    assert.equal(await db.movement.count({ where: { kitId: kit.id } }), 0);

    expectStatus(await movement(second.id, gram.id, 'PURCHASE', '120', '3'), 201);
    expectStatus(await out(), 201);
    assert.equal((await productRow(first.id)).quantity.toString(), '3');
    assert.equal((await productRow(second.id)).quantity.toString(), '30');
    assert.equal(await db.movement.count({ where: { kitId: kit.id, kind: 'KIT_OUT' } }), 2);
  });

  await t.test('saídas concorrentes nunca deixam saldo negativo', async () => {
    const product = await createProduct('CONCORRENCIA', unit.id);
    expectStatus(await movement(product.id, unit.id, 'PURCHASE', '5', '1'), 201);
    const requests = await Promise.all([
      movement(product.id, unit.id, 'OUT', '4'), movement(product.id, unit.id, 'OUT', '4'),
    ]);
    assert.equal(requests.filter(response => response.status === 201).length, 1);
    expectStatus(requests.find(response => response.status !== 201), [400, 409]);
    assert.equal((await productRow(product.id)).quantity.toString(), '1');
    assert.equal((await productMovements(product.id, 'OUT')).length, 1);
  });

  await t.test('inventário rejeita uma prévia desatualizada e ajusta somente os produtos contados', async () => {
    const first = await createProduct('CONTADO-1', unit.id);
    const second = await createProduct('CONTADO-2', unit.id);
    const uncounted = await createProduct('NAO-CONTADO', unit.id);
    for (const product of [first, second, uncounted]) {
      expectStatus(await movement(product.id, unit.id, 'PURCHASE', '5', '2'), 201);
    }
    const preview = async () => expectStatus(await post('/stock/inventory/preview', { rows: [
      { sku: first.sku, quantity: '3', unit: unit.symbol },
      { sku: second.sku, quantity: '7', unit: unit.symbol },
    ] }), 201);

    const batch = await preview();
    expectStatus(await movement(second.id, unit.id, 'OUT', '1'), 201);
    expectStatus(await post(`/stock/inventory/${batch.id}/confirm`), 409);
    assert.equal((await productRow(first.id)).quantity.toString(), '5');
    assert.equal((await productRow(second.id)).quantity.toString(), '4');

    const workbook = await loadTemplate('/stock/inventory/template');
    const sheet = workbook.worksheets[0];
    assert.deepEqual(sheet.getRow(1).values.slice(1), ['SKU', 'Quantidade', 'Unidade']);
    sheet.getRow(2).values = [first.sku, '3', unit.symbol];
    sheet.getRow(3).values = [second.sku, '7', unit.symbol];
    const fresh = expectStatus(await uploadWorkbook('/stock/inventory/upload', workbook), 201);
    expectStatus(await post(`/stock/inventory/${fresh.id}/confirm`), [200, 201]);
    assert.equal((await productRow(first.id)).quantity.toString(), '3');
    assert.equal((await productRow(second.id)).quantity.toString(), '7');
    assert.equal((await productRow(uncounted.id)).quantity.toString(), '5');
    assert.equal((await productRow(second.id)).currentCost.toString(), '2');
    assert.equal((await productMovements(uncounted.id, 'INVENTORY')).length, 0);
  });

  await t.test('a planilha inválida não grava produtos e a confirmação da carga é idempotente', async () => {
    const workbook = await loadTemplate('/stock/initial/template');
    const first = sku('IMPORTADO-1');
    const second = sku('IMPORTADO-2');
    const sheet = workbook.worksheets[0];
    assert.deepEqual(sheet.getRow(1).values.slice(1, 6), ['SKU', 'Nome', 'Unidade', 'Quantidade', 'Custo']);
    sheet.getRow(2).values = [first, 'Produto por unidade', unit.symbol, '4', '15.00'];
    sheet.getRow(3).values = [second, 'Produto por peso', sku('UNIDADE-INVALIDA'), '2.5', '12.00'];

    const upload = () => uploadWorkbook('/stock/initial/preview', workbook);
    const products = () => db.product.findMany({ where: { sku: { in: [first, second] } }, orderBy: { sku: 'asc' } });
    expectStatus(await upload(), 400);
    assert.equal((await products()).length, 0);
    sheet.getCell('C3').value = kilogram.symbol;
    const batch = expectStatus(await upload(), 201);
    assert.equal((await products()).length, 0);

    const confirm = () => post(`/stock/initial/${batch.id}/confirm`);
    expectStatus(await confirm(), [200, 201]);
    expectStatus(await confirm(), [200, 201]);
    const imported = await products();
    assert.deepEqual(imported.map(product => [product.sku, product.quantity.toString(), product.currentCost.toString()]), [
      [first, '4', '15'], [second, '2500', '0.012'],
    ]);
    assert.equal(await db.movement.count({ where: { kind: 'INITIAL', productId: { in: imported.map(product => product.id) } } }), 2);
  });
});
