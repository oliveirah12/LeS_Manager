const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const databaseUrl = process.env.TEST_DATABASE_URL;

test('API REST com PostgreSQL', {
  skip: databaseUrl ? false : 'Defina TEST_DATABASE_URL para um banco PostgreSQL de testes já migrado.',
  timeout: 90_000,
}, async t => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.COOKIE_SECURE = 'false';
  // Requests without X-Forwarded-For keep the socket address, so only the limit test below sets it.
  process.env.TRUST_PROXY = '1';
  process.env.CONFIG_ENCRYPTION_KEY ??= require('node:crypto').randomBytes(32).toString('base64');
  const fileRoot = mkdtempSync(join(tmpdir(), 'les-http-files-'));
  process.env.FILE_STORAGE_DIR = fileRoot;
  t.after(() => rmSync(fileRoot, { recursive: true, force: true }));
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

  async function request(path, { method = 'GET', cookie, body, headers: extra = {} } = {}) {
    const headers = { ...extra };
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
  // A refused request never reaches the interceptor, so its event is completed just after the response.
  async function waitForAuditEvent(filters, matches, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { events } = expectStatus(await admin('/audit?' + new URLSearchParams(filters)), 200);
      const event = events.find(matches);
      if (event) return event;
      if (Date.now() >= deadline) assert.fail(`Evento de auditoria não concluído em ${timeoutMs} ms: ${JSON.stringify(filters)}`);
      await delay(25);
    }
  }
  async function loadTemplate(path) {
    const bytes = expectStatus(await admin(path), 200);
    const workbook = new Workbook();
    await workbook.xlsx.load(Buffer.from(bytes));
    return workbook;
  }
  async function uploadWorkbook(path, workbook, caller = admin) {
    const bytes = await workbook.xlsx.writeBuffer();
    const file = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const body = new FormData();
    body.append('file', file, 'estoque.xlsx');
    return caller(path, { method: 'POST', body });
  }
  const createFamily = (name, baseSymbol) => post('/catalog/families', { name: sku(name), baseSymbol }).then(response => expectStatus(response, 201));
  const createProduct = (name, unitId) => post('/catalog/products', {
    sku: sku(name), name, unitId,
  }).then(response => expectStatus(response, 201));
  // Entries with a cost are purchases, which live in their own module.
  const movement = (productId, unitId, kind, quantity, unitCost) => kind === 'PURCHASE' ? post('/purchases', {
    purchaseDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date()),
    items: [{ productId, unitId, quantity, totalCost: new (require('@prisma/client').Prisma.Decimal)(quantity).times(unitCost).toFixed() }],
  }) : post('/stock/movements', {
    productId, unitId, kind, quantity, reason: 'Movimentação de teste',
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
    // Calls without a valid session are refused before the audit, so they cannot fill it.
    const eventsBefore = await db.auditEvent.count();
    expectStatus(await request('/stock/movements', { method: 'POST', body: {} }), 401);
    expectStatus(await request('/stock/movements', { method: 'POST', cookie: 'les_session=' + 'x'.repeat(32), body: {} }), 401);
    assert.equal(await db.auditEvent.count(), eventsBefore);
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

  await t.test('limite de tentativas pelo endereço real e por conta', async () => {
    const from = address => ({ 'x-forwarded-for': '203.0.113.' + address });
    const login = (email, attempt, address) => request('/access/login', { method: 'POST', headers: from(address), body: { email, password: attempt } });
    const email = run.toLowerCase() + '-bloqueio@example.com';
    await db.user.create({
      data: {
        email, name: 'Pessoa bloqueada', passwordHash: await hashPassword(password),
        profile: { create: { name: sku('BLOQUEIO'), permissions: ['stock:view'] } },
      },
    });
    // Ten failures from different addresses lock the account, even for the right password.
    for (let address = 1; address <= 10; address++) expectStatus(await login(email, 'Senha-errada1', address), 401);
    expectStatus(await login(email, password, 11), 429);

    // The address limit follows the forwarded client, not the proxy, and spares other clients.
    const stranger = attempt => run.toLowerCase() + '-ninguem' + attempt + '@example.com';
    for (let attempt = 0; attempt < 20; attempt++) expectStatus(await login(stranger(attempt), password, 100), 401);
    expectStatus(await login(stranger(20), password, 100), 429);
    expectStatus(await login(stranger(21), password, 101), 401);
  });

  await t.test('permissões independentes para catálogo, cadastros, estoque e financeiro', async () => {
    const product = await createProduct('CATALOGO-RESTRITO', unit.id);
    expectStatus(await movement(product.id, unit.id, 'PURCHASE', '9', '3'), 201);
    const kit = expectStatus(await post('/catalog/kits', {
      sku: sku('KIT-RESTRITO'), name: 'Kit sem exposição de saldo',
      components: [{ productId: product.id, quantity: '2', unitId: unit.id }],
    }), 201);
    assert.equal('currentCost' in product, false);
    assert.equal('quantity' in product, false);
    const stockView = expectStatus(await admin('/stock'), 200);
    const stockRows = [stockView.products.find(row => row.id === product.id), stockView.kits.find(row => row.id === kit.id).components[0].product];
    for (const row of stockRows) {
      assert.equal(row.currentCost, '3');
      for (const field of ['wastePercent', 'revision', 'typeId', 'groupId']) assert.equal(field in row, false, field);
    }
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
    const audit = expectStatus(await admin('/audit?' + new URLSearchParams({ userId: user.id })), 200);
    assert.ok(audit.events.every(event => event.actorId === user.id));
    const edited = audit.events.find(event => event.action === 'Alterar produto' && event.targetId === product.id && event.status === 200);
    assert.deepEqual(edited.details.before, { Nome: 'CATALOGO-RESTRITO' });
    assert.deepEqual(edited.details.after, { Nome: 'Produto editado' });
    assert.ok(audit.events.some(event => event.action === 'Ativar conta' && event.details.context['E-mail'] === email));
    assert.equal(audit.events.some(event => event.action.startsWith('Consultar')), false);
    assert.equal(JSON.stringify(audit).includes(password), false);
    assert.equal(JSON.stringify(audit).includes(user.code), false);
    expectStatus(await catalog('/catalog/registrations'), 403);
    expectStatus(await catalog('/catalog/references', { method: 'POST', body: { kind: 'COR', name: sku('COR') } }), 403);
    await waitForAuditEvent({ result: 'denied', action: 'Criar classificação' },
      event => event.actorId === user.id && event.status === 403 && !event.details?.after);
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

  let sessions = 0;
  // Each profile activates from its own address, so the suite does not use up the limit of 20 attempts per minute.
  async function session(name, permissions) {
    const profile = expectStatus(await post('/access/profiles', { name: sku(name), permissions }), 201);
    const email = (run + '-' + name).toLowerCase() + '@example.com';
    const user = expectStatus(await post('/access/users', { name, email, profileId: profile.id }), 201);
    const activation = await request('/access/activate', {
      method: 'POST', headers: { 'x-forwarded-for': '198.51.100.' + ++sessions }, body: { email, code: user.code, password, confirmation: password },
    });
    expectStatus(activation, 200);
    return (path, options = {}) => request(path, { ...options, cookie: activation.cookie });
  }

  await t.test('mínimo, margem e preço exigem as permissões de estoque', async () => {
    const product = await createProduct('COMERCIAL', unit.id);
    expectStatus(await movement(product.id, unit.id, 'PURCHASE', '1', '60'), 201);
    const settings = '/stock/products/' + product.id + '/settings';
    const details = '/catalog/products/' + product.id + '/details';
    const body = { minStock: '2', salePrice: '90', marginPercent: '40' };

    const stranger = await session('COM-SEM', ['finance:view']);
    expectStatus(await stranger('/stock'), 403);
    expectStatus(await stranger(settings, { method: 'PATCH', body }), 403);

    const cataloger = await session('COM-CATALOGO', ['catalog:operate']);
    expectStatus(await cataloger(settings, { method: 'PATCH', body }), 403);
    expectStatus(await cataloger('/catalog/products/' + product.id, { method: 'PATCH', body: { name: 'COMERCIAL', ...body } }), 200);
    const untouched = await productRow(product.id);
    assert.deepEqual([untouched.minStock, untouched.salePrice, untouched.marginPercent], [null, null, null]);
    const hidden = expectStatus(await cataloger(details), 200);
    assert.equal(hidden.stock, null);
    assert.equal(JSON.stringify(hidden).includes('marginPercent'), false);
    assert.equal('marginPercent' in expectStatus(await cataloger('/catalog'), 200).products.find(row => row.id === product.id), false);

    const operator = await session('COM-OPERA', ['stock:operate']);
    expectStatus(await operator(settings, { method: 'PATCH', body: { ...body, marginPercent: '100' } }), 400);
    expectStatus(await operator(settings, { method: 'PATCH', body }), 200);
    const reader = await session('COM-LEITURA', ['stock:view', 'catalog:view']);
    expectStatus(await reader(settings, { method: 'PATCH', body }), 403);
    const low = expectStatus(await reader('/stock'), 200).products.find(row => row.id === product.id);
    assert.deepEqual([low.marginPercent, low.suggestedPrice, low.belowTargetMargin, low.salePrice], ['40', '100', true, '90']);
    assert.equal(expectStatus(await reader(details), 200).stock.suggestedPrice, '100');

    // The suggestion never changes the price by itself, and a client without the margin keeps it.
    expectStatus(await operator(settings, { method: 'PATCH', body: { minStock: '2', salePrice: '100' } }), 200);
    const confirmed = expectStatus(await reader('/stock'), 200).products.find(row => row.id === product.id);
    assert.deepEqual([confirmed.marginPercent, confirmed.belowTargetMargin], ['40', false]);
    const { events } = expectStatus(await admin('/audit?' + new URLSearchParams({ action: 'Alterar parâmetros de estoque' })), 200);
    assert.ok(events.some(row => row.targetId === product.id && row.details?.after?.['Margem desejada (%)'] === '40'));
  });

  await t.test('dados técnicos do produto respeitam leitura e operação do catálogo', async () => {
    const product = expectStatus(await post('/catalog/products', {
      sku: sku('TECNICO'), name: 'Técnico', unitId: unit.id, lengthMm: '120.5', diameterMm: '1,75',
      purchaseUrl: 'https://loja.example/item', measures: [{ name: 'Passo', value: '0.4', unit: 'mm' }],
    }), 201);
    assert.equal(product.lengthMm, '120.5');
    assert.equal(product.diameterMm, '1.75');
    const path = '/catalog/products/' + product.id;
    const change = { name: 'Técnico', widthMm: '30', measures: [{ name: 'Bico', value: '0.6', unit: 'mm' }] };

    const stranger = await session('TEC-SEM', ['finance:view']);
    expectStatus(await stranger('/catalog'), 403);
    expectStatus(await stranger(path + '/details'), 403);
    expectStatus(await stranger(path, { method: 'PATCH', body: change }), 403);

    const reader = await session('TEC-LEITURA', ['catalog:view']);
    const listed = expectStatus(await reader('/catalog'), 200).products.find(row => row.id === product.id);
    assert.equal(listed.purchaseUrl, 'https://loja.example/item');
    assert.deepEqual(listed.measures, [{ name: 'Passo', value: '0.4', unit: 'mm' }]);
    assert.equal('currentCost' in listed, false);
    const details = expectStatus(await reader(path + '/details'), 200);
    assert.equal(details.technical.lengthMm, '120.5');
    assert.equal(details.stock, null);
    expectStatus(await reader(path, { method: 'PATCH', body: change }), 403);
    assert.equal((await productRow(product.id)).widthMm, null);

    const operator = await session('TEC-OPERA', ['catalog:operate']);
    expectStatus(await operator(path, { method: 'PATCH', body: { name: 'Técnico', purchaseUrl: 'javascript:alert(1)' } }), 400);
    assert.equal((await productRow(product.id)).purchaseUrl, 'https://loja.example/item');
    const saved = expectStatus(await operator(path, { method: 'PATCH', body: change }), 200);
    assert.equal(saved.widthMm, '30');
    assert.equal(saved.lengthMm, '120.5');
    assert.deepEqual(saved.measures, [{ name: 'Bico', value: '0.6', unit: 'mm' }]);
    const kept = expectStatus(await operator(path, { method: 'PATCH', body: { name: 'Técnico' } }), 200);
    assert.equal(kept.measures.length, 1);
    const { events } = expectStatus(await admin('/audit?' + new URLSearchParams({ action: 'Alterar produto' })), 200);
    const event = events.find(row => row.targetId === product.id && row.details?.after?.['Largura (mm)'] === '30');
    assert.deepEqual(event.details.after.Medidas, ['Bico: 0.6 mm']);

    expectStatus(await operator(path, { method: 'DELETE' }), 200);
    assert.equal(await db.productMeasure.count({ where: { productId: product.id } }), 0);
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
      ['250', '0.01425'], ['500', '0.016159090909'],
    ]));
    const stock = await productRow(product.id);
    assert.equal(stock.quantity.toString(), '2250');
    // (1750 g × 0.01425 + 1000 g × 0.0195) / 2750 g
    assert.equal(stock.currentCost.toString(), '0.016159090909');
    assert.equal(stock.lastPurchaseCost.toString(), '0.0195');
    const outs = expectStatus(await admin('/stock/movements?' + new URLSearchParams({ productId: product.id, kind: 'OUT' })), 200);
    assert.deepEqual(outs.movements.map(row => row.quantity), ['-500', '-250']);
    assert.equal(outs.nextCursor, null);
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const future = expectStatus(await admin('/stock/movements?' + new URLSearchParams({ productId: product.id, from: tomorrow })), 200);
    assert.equal(future.movements.length, 0);
    expectStatus(await admin('/stock/movements?kind=INVALIDO'), 400);
    const sortedOuts = async sort => expectStatus(await admin('/stock/movements?' + new URLSearchParams({ productId: product.id, kind: 'OUT', sort })), 200).movements.map(row => row.quantity);
    assert.deepEqual(await sortedOuts('quantity:asc'), ['-500', '-250']);
    assert.deepEqual(await sortedOuts('quantity:desc'), ['-250', '-500']);
    expectStatus(await admin('/stock/movements?sort=unitCost:asc'), 400);
    expectStatus(await admin('/audit?sort=actorName:asc'), 400);
    expectStatus(await admin('/audit?sort=action:asc'), 200);
    const orderPage = expectStatus(await admin('/production/orders?page=1&sort=printer:asc'), 200);
    assert.equal(orderPage.page, 1);
    assert.equal(typeof orderPage.total, 'number');
    expectStatus(await admin('/production/orders?sort=notes:asc'), 400);
    expectStatus(await admin('/production/orders?page=0'), 400);

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

    const view = expectStatus(await admin('/stock'), 200).kits.find(row => row.id === kit.id);
    const [firstRow, secondRow] = [await productRow(first.id), await productRow(second.id)];
    assert.ok(firstRow.currentCost.times(2).plus(secondRow.currentCost.times(100)).toDecimalPlaces(10)
      .eq(new (require('@prisma/client').Prisma.Decimal)(view.totalCost).toDecimalPlaces(10)));
    assert.equal(view.partialCost, false);
    assert.equal(view.available, '0');
    assert.equal(view.components.find(row => row.productId === first.id).yields, '1');
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

  await t.test('edição e exclusão respeitam o histórico', async () => {
    const symbol = 'T' + Date.now();
    const family = expectStatus(await post('/catalog/families', { name: 'Família ' + symbol, baseSymbol: symbol }), 201);
    const otherUnit = family.units[0];
    const patch = (path, body) => admin(path, { method: 'PATCH', body });
    const remove = path => admin(path, { method: 'DELETE' });

    const unused = await createProduct('SEM-USO', unit.id);
    const newSku = sku('RENOMEADO');
    const changed = expectStatus(await patch('/catalog/products/' + unused.id, { sku: newSku, name: 'Sem uso', unitId: otherUnit.id }), 200);
    assert.equal(changed.sku, newSku);
    assert.equal(changed.unitId, otherUnit.id);
    expectStatus(await remove('/catalog/products/' + unused.id), 200);
    assert.equal(await db.product.count({ where: { id: unused.id } }), 0);

    const used = await createProduct('COM-USO', unit.id);
    expectStatus(await movement(used.id, unit.id, 'PURCHASE', '2', '3'), 201);
    expectStatus(await patch('/catalog/products/' + used.id, { name: 'Com uso', unitId: otherUnit.id }), 409);
    expectStatus(await remove('/catalog/products/' + used.id), 409);

    const component = await createProduct('COMPONENTE', unit.id);
    const newKit = () => post('/catalog/kits', {
      sku: sku('KIT-EXCLUSAO'), name: 'Kit para excluir', components: [{ productId: component.id, quantity: '1', unitId: unit.id }],
    });
    const freeKit = expectStatus(await newKit(), 201);
    expectStatus(await remove('/catalog/products/' + component.id), 409);
    expectStatus(await remove('/catalog/kits/' + freeKit.id), 200);
    expectStatus(await remove('/catalog/products/' + component.id), 200);

    const soldKit = expectStatus(await post('/catalog/kits', {
      sku: sku('KIT-VENDIDO'), name: 'Kit vendido', components: [{ productId: used.id, quantity: '1', unitId: unit.id }],
    }), 201);
    expectStatus(await post(`/stock/kits/${soldKit.id}/out`, { quantity: '1', reason: 'Venda' }), 201);
    expectStatus(await remove('/catalog/kits/' + soldKit.id), 409);
  });

  await t.test('tipos de produto definem comportamento e ficam protegidos em uso', async () => {
    const standard = '00000000-0000-4000-8000-000000000001';
    const remove = path => admin(path, { method: 'DELETE' });
    const product = await createProduct('TIPADO', unit.id);
    assert.equal((await productRow(product.id)).typeId, standard);

    const type = expectStatus(await post('/catalog/product-types', { name: 'Tipo ' + sku('T'), isInput: true, isManufactured: false }), 201);
    expectStatus(await admin('/catalog/products/' + product.id, { method: 'PATCH', body: { name: 'Tipado', typeId: type.id } }), 200);
    assert.equal((await productRow(product.id)).typeId, type.id);
    const listed = expectStatus(await admin('/catalog/registrations'), 200).productTypes.find(row => row.id === type.id);
    assert.equal(listed.products, 1);
    assert.ok(listed.deleteBlock);

    expectStatus(await remove('/catalog/product-types/' + type.id), 409);
    expectStatus(await remove('/catalog/product-types/' + standard), 409);
    expectStatus(await admin('/catalog/products/' + product.id, { method: 'PATCH', body: { name: 'Tipado', typeId: standard } }), 200);
    expectStatus(await remove('/catalog/product-types/' + type.id), 200);
  });

  await t.test('ficha técnica valida insumos e protege o que está em uso', async () => {
    const [standard, filamentType, printedType] = [1, 2, 3].map(n => '00000000-0000-4000-8000-00000000000' + n);
    const patch = (id, name, typeId) => admin('/catalog/products/' + id, { method: 'PATCH', body: { name, typeId } });
    const saveRecipe = (id, wastePercent, inputs) => admin(`/catalog/products/${id}/recipe`, { method: 'PUT', body: { wastePercent, inputs } });
    const line = inputId => [{ inputId, unitId: unit.id, quantity: '120' }];
    const filament = await createProduct('FILAMENTO', unit.id);
    const printed = await createProduct('IMPRESSO', unit.id);
    const common = await createProduct('COMUM', unit.id);
    expectStatus(await patch(filament.id, 'Filamento', filamentType), 200);

    expectStatus(await saveRecipe(printed.id, '5', line(filament.id)), 409);
    expectStatus(await patch(printed.id, 'Impresso', printedType), 200);
    expectStatus(await saveRecipe(printed.id, '5', line(common.id)), 400);
    expectStatus(await saveRecipe(printed.id, '5', line(printed.id)), 400);
    expectStatus(await saveRecipe(printed.id, '101', line(filament.id)), 400);
    expectStatus(await saveRecipe(printed.id, '5', line(filament.id)), 200);
    const recipe = expectStatus(await admin(`/catalog/products/${printed.id}/recipe`), 200);
    assert.equal(recipe.wastePercent, '5');
    assert.deepEqual(recipe.inputs, [{ inputId: filament.id, quantity: '120' }]);
    const listed = expectStatus(await admin('/catalog'), 200).products;
    assert.equal(listed.find(row => row.id === printed.id).hasRecipe, true);
    assert.equal(listed.find(row => row.id === filament.id).hasRecipe, false);

    expectStatus(await admin('/catalog/products/' + filament.id, { method: 'DELETE' }), 409);
    expectStatus(await post(`/catalog/products/${filament.id}/status`, { active: false }), 409);
    expectStatus(await patch(filament.id, 'Filamento', standard), 409);
    expectStatus(await patch(printed.id, 'Impresso', standard), 409);
    expectStatus(await admin('/catalog/product-types/' + filamentType, {
      method: 'PATCH', body: { name: 'Filamento', isInput: false, isManufactured: false },
    }), 409);
    expectStatus(await saveRecipe(printed.id, '0', []), 200);
    expectStatus(await admin('/catalog/products/' + filament.id, { method: 'DELETE' }), 200);
  });

  await t.test('impressoras somam energia e desgaste no custo por hora', async () => {
    const name = sku('IMPRESSORA');
    const printer = expectStatus(await post('/production/printers', { name, powerWatts: '200', hourlyCost: '2' }), 201);
    expectStatus(await post('/production/printers', { name, powerWatts: '200', hourlyCost: '2' }), 409);
    expectStatus(await post('/production/printers', { name: sku('INVALIDA'), powerWatts: '0', hourlyCost: '2' }), 400);
    expectStatus(await admin('/production/energy-rate', { method: 'PUT', body: { energyRate: '0,9' } }), 200);
    const listed = expectStatus(await admin('/production/printers'), 200).printers.find(row => row.id === printer.id);
    assert.equal(listed.hourCost, '2.18');
    expectStatus(await post(`/production/printers/${printer.id}/status`, { active: false }), 200);
    expectStatus(await admin('/production/printers/' + printer.id, { method: 'DELETE' }), 200);
  });

  await t.test('ordem de produção reserva, baixa o consumo real e congela o custo', async () => {
    const [filamentType, printedType] = [2, 3].map(n => '00000000-0000-4000-8000-00000000000' + n);
    const typed = async (name, typeId) => {
      const product = await createProduct(name, unit.id);
      expectStatus(await admin('/catalog/products/' + product.id, { method: 'PATCH', body: { name, typeId } }), 200);
      return product;
    };
    const filament = await typed('ORDEM-FILAMENTO', filamentType);
    const printed = await typed('ORDEM-PECA', printedType);
    expectStatus(await movement(filament.id, unit.id, 'PURCHASE', '3000', '0.1'), 201);
    expectStatus(await admin(`/catalog/products/${printed.id}/recipe`, {
      method: 'PUT', body: { wastePercent: '5', inputs: [{ inputId: filament.id, unitId: unit.id, quantity: '120' }] },
    }), 200);
    expectStatus(await admin('/production/energy-rate', { method: 'PUT', body: { energyRate: '0.9' } }), 200);
    const printer = expectStatus(await post('/production/printers', { name: sku('ORDEM-IMPRESSORA'), powerWatts: '200', hourlyCost: '2' }), 201);
    const newOrder = (pieces, plannedStart = '2026-11-21T10:00:00.000Z') => post('/production/orders', {
      printerId: printer.id, plannedStart, estimatedMinutes: 600, items: [{ productId: printed.id, quantity: pieces }],
    });
    const action = (id, name, body) => post(`/production/orders/${id}/${name}`, body);
    const started = '2026-11-21T10:00:00.000Z';
    const closing = { finishedAt: '2026-11-21T20:00:00.000Z', items: [{ productId: printed.id, lost: '1' }], inputs: [{ inputId: filament.id, used: '2520' }] };

    const tooBig = expectStatus(await newOrder('100'), 201);
    expectStatus(await action(tooBig.id, 'start', { startedAt: started }), 409);
    expectStatus(await action(tooBig.id, 'cancel', {}), 200);

    const order = expectStatus(await newOrder('20'), 201);
    assert.equal(order.inputs[0].planned, '2520');
    assert.equal(order.expectedEnd, '2026-11-21T20:00:00.000Z');
    expectStatus(await action(order.id, 'finish', closing), 409);
    expectStatus(await action(order.id, 'start', { startedAt: started }), 200);
    assert.equal((await productRow(filament.id)).quantity.toString(), '3000');
    const stock = expectStatus(await admin('/stock'), 200).products.find(row => row.id === filament.id);
    assert.equal(stock.reserved, '2520');
    expectStatus(await movement(filament.id, unit.id, 'OUT', '500'), 409);
    expectStatus(await movement(filament.id, unit.id, 'OUT', '480'), 201);

    const preview = expectStatus(await action(order.id, 'preview', { ...closing, absorbLoss: true }), 200);
    assert.equal(preview.items[0].unitCost, '14.410526315789');
    assert.equal((await productRow(printed.id)).quantity.toString(), '0');
    const finished = expectStatus(await action(order.id, 'finish', closing), 200);
    assert.equal(finished.status, 'DONE');
    assert.equal(finished.totalCost, '273.8');
    assert.equal(finished.items[0].unitCost, '13.69');
    assert.equal(finished.lossCost, '13.69');
    assert.equal((await productRow(filament.id)).quantity.toString(), '0');
    const piece = await productRow(printed.id);
    assert.equal(piece.quantity.toString(), '19');
    assert.equal(piece.currentCost.toString(), '13.69');
    assert.equal(await db.movement.count({ where: { productionOrderId: order.id } }), 2);
    expectStatus(await action(order.id, 'cancel', {}), 409);
    expectStatus(await admin('/production/printers/' + printer.id, { method: 'DELETE' }), 409);
    expectStatus(await admin('/catalog/products/' + printed.id, { method: 'DELETE' }), 409);

    expectStatus(await movement(filament.id, unit.id, 'PURCHASE', '1000', '0.1'), 201);
    const canceled = expectStatus(await newOrder('5', '2099-02-01T10:00:00.000Z'), 201);
    expectStatus(await action(canceled.id, 'start', { startedAt: started }), 200);
    const closed = expectStatus(await action(canceled.id, 'cancel', { inputs: [{ inputId: filament.id, used: '100' }] }), 200);
    assert.equal(closed.lossCost, '10');
    assert.equal((await productRow(filament.id)).quantity.toString(), '900');
    assert.equal(expectStatus(await admin('/stock'), 200).products.find(row => row.id === filament.id).reserved, '0');

    // Costs of an order need stock:view on every route, reads and writes alike.
    const noCosts = value => assert.doesNotMatch(JSON.stringify(value), /cost|energyRate|powerWatts/i);
    const listedOrder = async (client, id) => expectStatus(await client('/production/orders'), 200).orders.find(row => row.id === id);
    const stranger = await session('ORDEM-SEM', ['finance:view']);
    expectStatus(await stranger('/production/orders'), 403);
    const reader = await session('ORDEM-LEITURA', ['production:view']);
    noCosts(await listedOrder(reader, order.id));
    expectStatus(await reader('/production/orders', { method: 'POST', body: {} }), 403);
    expectStatus(await reader(`/production/orders/${order.id}/preview`, { method: 'POST', body: closing }), 403);

    const operator = await session('ORDEM-OPERA', ['production:operate']);
    const send = (path, body) => operator('/production/orders' + path, { method: 'POST', body });
    const operated = expectStatus(await send('', {
      printerId: printer.id, plannedStart: '2099-02-02T10:00:00.000Z', estimatedMinutes: 60, items: [{ productId: printed.id, quantity: '1' }],
    }), 201);
    noCosts(operated);
    noCosts(await listedOrder(operator, operated.id));
    noCosts(expectStatus(await send(`/${operated.id}/start`, { startedAt: started }), 200));
    const ending = { finishedAt: '2026-11-21T11:00:00.000Z', items: [{ productId: printed.id, lost: '0' }], inputs: [{ inputId: filament.id, used: '126' }] };
    const reviewed = expectStatus(await send(`/${operated.id}/preview`, ending), 200);
    noCosts(reviewed);
    assert.equal(reviewed.items[0].good, '1');
    noCosts(expectStatus(await send(`/${operated.id}/finish`, ending), 200));

    const costs = await session('ORDEM-CUSTOS', ['production:view', 'stock:view']);
    assert.ok(Number((await listedOrder(costs, operated.id)).totalCost) > 0);
  });

  await t.test('formas de pagamento e venda da ordem respeitam acessos e congelam ao concluir', async () => {
    const reader = await session('PAGTO-LEITURA', ['registrations:view']);
    const operator = await session('PAGTO-OPERA', ['registrations:operate']);
    const stranger = await session('PAGTO-SEM', ['production:view']);
    const name = sku('PIX');
    expectStatus(await stranger('/payment-methods'), 403);
    expectStatus(await reader('/payment-methods'), 200);
    expectStatus(await reader('/payment-methods', { method: 'POST', body: { name } }), 403);
    expectStatus(await operator('/payment-methods', { method: 'POST', body: { name, feePercent: '101' } }), 400);
    const method = expectStatus(await operator('/payment-methods', { method: 'POST', body: { name, feePercent: '5' } }), 201);
    const hidden = expectStatus(await operator('/payment-methods', { method: 'POST', body: { name: sku('INATIVA'), active: false } }), 201);
    assert.equal(expectStatus(await stranger('/production/orders'), 200).paymentMethods.some(row => row.id === hidden.id), false);

    const input = await createProduct('VENDA-INSUMO', unit.id);
    const piece = await createProduct('VENDA-PECA', unit.id);
    for (const [product, typeId] of [[input, 2], [piece, 3]]) {
      expectStatus(await admin('/catalog/products/' + product.id, { method: 'PATCH', body: { name: product.name, typeId: '00000000-0000-4000-8000-00000000000' + typeId } }), 200);
    }
    expectStatus(await movement(input.id, unit.id, 'PURCHASE', '100', '1'), 201);
    expectStatus(await admin(`/catalog/products/${piece.id}/recipe`, { method: 'PUT', body: { wastePercent: '0', inputs: [{ inputId: input.id, unitId: unit.id, quantity: '10' }] } }), 200);
    const printer = expectStatus(await post('/production/printers', { name: sku('VENDA-IMPRESSORA'), powerWatts: '100', hourlyCost: '0' }), 201);
    const base = { printerId: printer.id, plannedStart: '2026-11-21T10:00:00.000Z', estimatedMinutes: 60, discountPercent: '10', paymentMethodId: method.id };
    expectStatus(await post('/production/orders', { ...base, paymentMethodId: hidden.id, items: [{ productId: piece.id, quantity: '2', salePrice: '50' }] }), 409);
    const order = expectStatus(await post('/production/orders', { ...base, items: [{ productId: piece.id, quantity: '2', salePrice: '50', marginPercent: '40' }] }), 201);
    assert.equal(order.sale.values.net, '85.5');
    expectStatus(await admin('/payment-methods/' + method.id, { method: 'DELETE' }), 409);
    expectStatus(await post(`/production/orders/${order.id}/start`, { startedAt: '2026-11-21T10:00:00.000Z' }), 200);
    const done = expectStatus(await post(`/production/orders/${order.id}/finish`, {
      finishedAt: '2026-11-21T11:00:00.000Z', items: [{ productId: piece.id, lost: '1' }], inputs: [{ inputId: input.id, used: '20' }],
    }), 200);
    assert.deepEqual([done.sale.values.gross, done.sale.values.total, done.sale.values.net], ['50', '45', '42.75']);
    expectStatus(await admin('/payment-methods/' + method.id, { method: 'PATCH', body: { name: name + '-NOVO', feePercent: '50', active: false } }), 200);
    const frozen = expectStatus(await admin('/production/orders'), 200).orders.find(row => row.id === order.id);
    assert.deepEqual([frozen.sale.paymentName, frozen.sale.feePercent, frozen.sale.values.net], [name, '5', '42.75']);
  });

  await t.test('custos cadastrados respeitam acessos e só são excluídos sem uso', async () => {
    const reader = await session('CUSTO-LEITURA', ['registrations:view']);
    const operator = await session('CUSTO-OPERA', ['registrations:operate']);
    const stranger = await session('CUSTO-SEM', ['purchases:view']);
    const name = sku('EMBALAGEM');
    expectStatus(await stranger('/costs'), 403);
    expectStatus(await reader('/costs'), 200);
    expectStatus(await reader('/costs', { method: 'POST', body: { name, mode: 'VALUE', value: '2' } }), 403);
    expectStatus(await operator('/costs', { method: 'POST', body: { name, mode: 'PERCENT', base: 'SALE', value: '100' } }), 400);
    const cost = expectStatus(await operator('/costs', { method: 'POST', body: { name, mode: 'VALUE', base: 'SALE', value: '2.5' } }), 201);
    assert.equal(cost.base, 'COST');
    expectStatus(await operator('/costs/' + cost.id, { method: 'PATCH', body: { name, mode: 'PERCENT', base: 'SALE', value: '6' } }), 400);
    const edited = expectStatus(await operator('/costs/' + cost.id, { method: 'PATCH', body: { name, mode: 'PERCENT', base: 'SALE', value: '6', active: false } }), 200);
    assert.deepEqual([edited.base, edited.value, edited.active], ['SALE', '6', false]);
    const listed = expectStatus(await reader('/costs'), 200).find(row => row.id === cost.id);
    assert.deepEqual([listed.purchases, listed.deleteBlock], [0, null]);
    expectStatus(await reader('/costs/' + cost.id, { method: 'DELETE' }), 403);
    expectStatus(await operator('/costs/' + cost.id, { method: 'DELETE' }), 200);
    expectStatus(await operator('/costs/' + cost.id, { method: 'DELETE' }), 404);

    // The purchase copies the typed values, so later edits to the registered cost never reach it.
    const freight = expectStatus(await operator('/costs', { method: 'POST', body: { name: sku('FRETE'), mode: 'PERCENT', value: '10' } }), 201);
    const hidden = expectStatus(await operator('/costs', { method: 'POST', body: { name: sku('FRETE-INATIVO'), mode: 'VALUE', value: '3', active: false } }), 201);
    const options = expectStatus(await admin('/purchases/options'), 200);
    assert.deepEqual(options.costs.filter(row => [freight.id, hidden.id].includes(row.id)).map(row => row.id), [freight.id]);
    const product = await createProduct('CUSTO-COMPRA', unit.id);
    const items = [{ productId: product.id, unitId: unit.id, quantity: '10', totalCost: '200' }];
    expectStatus(await post('/purchases', { purchaseDate: '2026-01-01', items, costs: [{ costItemId: hidden.id, title: 'Frete', mode: 'VALUE', value: '3', split: 'VALUE' }] }), 409);
    const purchase = expectStatus(await post('/purchases', {
      purchaseDate: '2026-01-01', items, costs: [{ costItemId: freight.id, title: 'Frete expresso', mode: 'PERCENT', value: '5', split: 'VALUE' }],
    }), 201);
    expectStatus(await operator('/costs/' + freight.id, { method: 'PATCH', body: { name: freight.name, mode: 'VALUE', value: '99', active: true } }), 200);
    const [stored] = expectStatus(await admin('/purchases/' + purchase.id), 200).costs;
    assert.deepEqual([stored.costItemId, stored.title, stored.mode, stored.value, stored.amount], [freight.id, 'Frete expresso', 'PERCENT', '5', '10']);
    const used = expectStatus(await reader('/costs'), 200).find(row => row.id === freight.id);
    assert.deepEqual([used.purchases, typeof used.deleteBlock], [1, 'string']);
    expectStatus(await operator('/costs/' + freight.id, { method: 'DELETE' }), 409);
  });

  await t.test('despesas entram uma única vez no custo e na média do fabricado', async () => {
    const input = await createProduct('DESPESA-INSUMO', unit.id);
    const piece = await createProduct('DESPESA-PECA', unit.id);
    for (const [product, typeId] of [[input, 2], [piece, 3]]) {
      expectStatus(await admin('/catalog/products/' + product.id, { method: 'PATCH', body: { name: product.name, typeId: '00000000-0000-4000-8000-00000000000' + typeId } }), 200);
    }
    expectStatus(await post('/purchases', {
      purchaseDate: '2026-01-01', items: [{ productId: input.id, unitId: unit.id, quantity: '100', totalCost: '100' }],
      costs: [{ title: 'Frete', mode: 'VALUE', value: '50', split: 'VALUE' }],
    }), 201);
    const stocked = await productRow(input.id);
    assert.deepEqual([stocked.currentCost.toString(), stocked.lastPurchaseExpense.toString()], ['1', '0.5']);
    expectStatus(await admin(`/catalog/products/${piece.id}/recipe`, { method: 'PUT', body: { wastePercent: '0', inputs: [{ inputId: input.id, unitId: unit.id, quantity: '10' }] } }), 200);
    const printer = expectStatus(await post('/production/printers', { name: sku('DESPESA-IMPRESSORA'), powerWatts: '100', hourlyCost: '0' }), 201);
    await db.productionSettings.update({ where: { id: 'default' }, data: { energyRate: 0 } });
    const order = expectStatus(await post('/production/orders', {
      printerId: printer.id, plannedStart: '2026-11-21T10:00:00.000Z', estimatedMinutes: 60,
      manualExpenses: [{ title: 'Embalagem', value: '2' }], items: [{ productId: piece.id, quantity: '2' }],
    }), 201);
    assert.deepEqual(order.expenses.map(row => [row.source, row.value]).sort(), [['INPUT', '10'], ['MANUAL', '2']]);
    expectStatus(await post(`/production/orders/${order.id}/start`, { startedAt: '2026-11-21T10:00:00.000Z' }), 200);
    const done = expectStatus(await post(`/production/orders/${order.id}/finish`, {
      finishedAt: '2026-11-21T11:00:00.000Z', items: [{ productId: piece.id, lost: '0' }], inputs: [{ inputId: input.id, used: '20' }],
    }), 200);
    // 20 g at the average of 1, plus 20 g × 0.5 of purchase expense, plus 2 of packaging.
    assert.deepEqual([done.expenseCost, done.totalCost], ['12', '32']);
    assert.equal((await productRow(piece.id)).currentCost.toString(), '16');
    assert.equal((await productRow(input.id)).currentCost.toString(), '1');
    await db.product.update({ where: { id: input.id }, data: { lastPurchaseExpense: 9 } });
    const frozen = expectStatus(await admin('/production/orders'), 200).orders.find(row => row.id === order.id);
    assert.equal(frozen.expenses.find(row => row.source === 'INPUT').value, '10');
  });

  await t.test('ordem planejada é editável e aceita filamento substituto', async () => {
    const typed = async (name, typeId, unitId = unit.id) => {
      const product = await createProduct(name, unitId);
      expectStatus(await admin('/catalog/products/' + product.id, { method: 'PATCH', body: { name, typeId: '00000000-0000-4000-8000-00000000000' + typeId } }), 200);
      return product;
    };
    const original = await typed('EDITA-PLA', 2);
    const substitute = await typed('EDITA-PETG', 2);
    const piece = await typed('EDITA-PECA', 3);
    const other = await typed('EDITA-OUTRA', 3);
    const family = expectStatus(await post('/catalog/families', { name: 'Edita ' + sku('F'), baseSymbol: sku('un') }), 201);
    const foreign = await typed('EDITA-PARAFUSO', 2, family.units[0].id);
    const notInput = await createProduct('EDITA-COMUM', unit.id);
    expectStatus(await movement(original.id, unit.id, 'PURCHASE', '100', '1'), 201);
    expectStatus(await movement(substitute.id, unit.id, 'PURCHASE', '15', '2'), 201);
    for (const product of [piece, other]) {
      expectStatus(await admin(`/catalog/products/${product.id}/recipe`, { method: 'PUT', body: { wastePercent: '0', inputs: [{ inputId: original.id, unitId: unit.id, quantity: '10' }] } }), 200);
    }
    const printer = expectStatus(await post('/production/printers', { name: sku('EDITA-IMPRESSORA'), powerWatts: '100', hourlyCost: '0' }), 201);
    const plan = { printerId: printer.id, plannedStart: '2026-11-21T10:00:00.000Z', estimatedMinutes: 60 };
    const order = expectStatus(await post('/production/orders', { ...plan, items: [{ productId: piece.id, quantity: '2', salePrice: '50' }] }), 201);
    const edit = (body, client = admin) => client('/production/orders/' + order.id, { method: 'PATCH', body: { ...plan, items: [{ productId: piece.id, quantity: '2' }], ...body } });
    const swap = substituteId => ({ replacements: [{ inputId: original.id, substituteId }] });

    expectStatus(await edit(swap(foreign.id)), 409);
    expectStatus(await edit(swap(notInput.id)), 409);
    const reader = await session('EDITA-LEITURA', ['production:view']);
    expectStatus(await edit(swap(substitute.id), reader), 403);
    const unrelated = await session('EDITA-SEM', ['stock:operate']);
    expectStatus(await edit(swap(substitute.id), unrelated), 403);

    const swapped = expectStatus(await edit({ ...swap(substitute.id), estimatedMinutes: 90 }), 200);
    assert.deepEqual([swapped.inputs[0].inputId, swapped.inputs[0].planned, swapped.inputs[0].replaces, swapped.estimatedMinutes], [substitute.id, '20', [sku('EDITA-PLA')], 90]);
    assert.equal(swapped.items[0].salePrice, '50');
    const listed = expectStatus(await admin('/production/orders'), 200).orders.find(row => row.id === order.id);
    assert.equal(listed.budget.materialCost, '40');

    // 20 g of the substitute with only 15 g in stock: the plan is saved, but the print cannot start.
    expectStatus(await post(`/production/orders/${order.id}/start`, { startedAt: plan.plannedStart }), 409);
    assert.equal((await productRow(substitute.id)).quantity.toString(), '15');
    const fitted = expectStatus(await edit({ inputs: [{ inputId: substitute.id, planned: '15' }] }), 200);
    assert.equal(fitted.inputs[0].planned, '15');

    const operator = await session('EDITA-OPERA', ['production:operate']);
    const kept = expectStatus(await edit({ items: [{ productId: piece.id, quantity: '2', marginPercent: '90' }] }, operator), 200);
    assert.equal(kept.items[0].marginPercent, undefined);
    assert.equal((await db.productionItem.findFirst({ where: { orderId: order.id } })).marginPercent, null);

    const grown = expectStatus(await edit({ items: [{ productId: piece.id, quantity: '1' }, { productId: other.id, quantity: '1' }] }), 200);
    assert.deepEqual(grown.inputs.map(row => row.planned).sort(), ['10', '7.5']);
    expectStatus(await edit({ items: [{ productId: piece.id, quantity: '1' }], inputs: [{ inputId: substitute.id, planned: '10' }] }), 200);
    expectStatus(await post(`/production/orders/${order.id}/start`, { startedAt: plan.plannedStart }), 200);
    expectStatus(await edit({}), 409);

    // The default list follows the start date, whatever the order number, and the real start replaces the planned one.
    const items = [{ productId: other.id, quantity: '1' }];
    const later = expectStatus(await post('/production/orders', { ...plan, plannedStart: '2099-01-02T10:00:00.000Z', items }), 201);
    const earlier = expectStatus(await post('/production/orders', { ...plan, plannedStart: '2099-01-01T10:00:00.000Z', items }), 201);
    const positions = async query => {
      const ids = expectStatus(await admin('/production/orders' + query), 200).orders.map(row => row.id);
      return [order.id, earlier.id, later.id].map(id => ids.indexOf(id));
    };
    const [startedRow, earlierRow, laterRow] = await positions('');
    assert.ok(laterRow >= 0 && laterRow < earlierRow && earlierRow < startedRow);
    const [startedAsc, earlierAsc, laterAsc] = await positions('?sort=start:asc');
    assert.ok(startedAsc >= 0 && startedAsc < earlierAsc && earlierAsc < laterAsc);

    // The same printer cannot hold two prints at once, on create, on edit or in a race.
    const book = plannedStart => post('/production/orders', { ...plan, plannedStart, items });
    expectStatus(await book('2099-01-02T10:30:00.000Z'), 409);
    expectStatus(await book('2099-01-02T11:00:00.000Z'), 201);
    const moveEarlier = plannedStart => admin('/production/orders/' + earlier.id, { method: 'PATCH', body: { ...plan, plannedStart, items } });
    expectStatus(await moveEarlier('2099-01-02T09:30:00.000Z'), 409);
    expectStatus(await moveEarlier('2099-01-01T10:00:00.000Z'), 200);
    const race = await Promise.all([book('2099-01-05T10:00:00.000Z'), book('2099-01-05T10:00:00.000Z')]);
    assert.deepEqual(race.map(response => response.status).sort(), [201, 409]);

    // The agenda needs production:view and shows only numbers and times.
    const window = { printerId: printer.id, from: '2099-01-02T00:00:00.000Z', to: '2099-01-03T00:00:00.000Z' };
    const agenda = (client, values = {}) => client('/production/orders/schedule?' + new URLSearchParams({ ...window, ...values }));
    expectStatus(await agenda(unrelated), 403);
    const { busy } = expectStatus(await agenda(reader), 200);
    assert.deepEqual(busy.map(row => [row.start, row.end]), [
      ['2099-01-02T10:00:00.000Z', '2099-01-02T11:00:00.000Z'], ['2099-01-02T11:00:00.000Z', '2099-01-02T12:00:00.000Z'],
    ]);
    assert.equal(busy[0].number, later.number);
    assert.deepEqual(Object.keys(busy[0]).sort(), ['end', 'number', 'start']);
    const editing = expectStatus(await agenda(reader, { ignoreOrderId: later.id }), 200).busy;
    assert.equal(editing.some(row => row.number === later.number), false);
    expectStatus(await agenda(admin, { to: window.from }), 400);
    expectStatus(await agenda(admin, { to: '2099-06-01T00:00:00.000Z' }), 400);

    // Filters combine, and the total follows them so the pagination stays right.
    const filtered = async values => expectStatus(await admin('/production/orders?' + new URLSearchParams({ printerId: printer.id, ...values })), 200);
    const running = await filtered({ status: 'PRINTING' });
    assert.deepEqual([running.orders.map(row => row.id), running.total], [[order.id], 1]);
    const firstDay = await filtered({ from: '2099-01-01', to: '2099-01-01' });
    assert.deepEqual([firstDay.orders.map(row => row.id), firstDay.total], [[earlier.id], 1]);
    assert.equal((await filtered({ status: 'DONE' })).total, 0);
    assert.equal((await filtered({ status: '', from: '', to: '' })).total, 5);
    assert.ok(running.filterPrinters.some(row => row.id === printer.id));
    expectStatus(await admin('/production/orders?status=OUTRA'), 400);
    expectStatus(await admin('/production/orders?from=2099-01-02&to=2099-01-01'), 400);

    // The search finds an order by SKU, by product name without accents, or by its number.
    const found = async search => (await filtered({ search })).orders.map(row => row.id);
    assert.deepEqual(await found(piece.sku.toLowerCase()), [order.id]);
    const accentedName = 'Ação ' + sku('BUSCA');
    await db.product.update({ where: { id: piece.id }, data: { name: accentedName } });
    assert.deepEqual(await found(accentedName.replace('Ação', 'acao')), [order.id]);
    // Plain digits may also match a SKU, while the # asks for the number alone.
    assert.ok((await found(String(later.number))).includes(later.id));
    assert.deepEqual(await found('#' + earlier.number), [earlier.id]);
    assert.deepEqual(await found('%'), []);
    assert.deepEqual((await filtered({ search: piece.sku, status: 'PLANNED' })).orders, []);
    expectStatus(await admin('/production/orders?search=' + 'x'.repeat(121)), 400);
  });

  await t.test('correção técnica compensa por diferença e preserva o histórico', async () => {
    const typed = async (name, typeId) => {
      const product = await createProduct(name, unit.id);
      expectStatus(await admin('/catalog/products/' + product.id, { method: 'PATCH', body: { name, typeId: '00000000-0000-4000-8000-00000000000' + typeId } }), 200);
      return product;
    };
    const input = await typed('CORRIGE-INSUMO', 2);
    const piece = await typed('CORRIGE-PECA', 3);
    expectStatus(await movement(input.id, unit.id, 'PURCHASE', '120', '1'), 201);
    expectStatus(await admin(`/catalog/products/${piece.id}/recipe`, { method: 'PUT', body: { wastePercent: '0', inputs: [{ inputId: input.id, unitId: unit.id, quantity: '10' }] } }), 200);
    const printer = expectStatus(await post('/production/printers', { name: sku('CORRIGE-IMPRESSORA'), powerWatts: '100', hourlyCost: '0' }), 201);
    await db.productionSettings.update({ where: { id: 'default' }, data: { energyRate: 0 } });
    const started = '2026-11-21T10:00:00.000Z';
    let day = 0;
    const freeSlot = () => new Date(Date.UTC(2099, 2, ++day, 10)).toISOString();
    const produce = async (quantity, lost, salePrice) => {
      const order = expectStatus(await post('/production/orders', {
        printerId: printer.id, plannedStart: freeSlot(), estimatedMinutes: 60, items: [{ productId: piece.id, quantity, ...(salePrice ? { salePrice } : {}) }],
      }), 201);
      expectStatus(await post(`/production/orders/${order.id}/start`, { startedAt: started }), 200);
      return expectStatus(await post(`/production/orders/${order.id}/finish`, {
        finishedAt: '2026-11-21T11:00:00.000Z', items: [{ productId: piece.id, lost }], inputs: [{ inputId: input.id, used: String(Number(quantity) * 10) }],
      }), 200);
    };
    const order = await produce('10', '0');
    assert.equal((await productRow(piece.id)).currentCost.toString(), '10');
    expectStatus(await movement(piece.id, unit.id, 'OUT', '4'), 201);
    expectStatus(await movement(input.id, unit.id, 'PURCHASE', '180', '3'), 201);
    assert.equal((await productRow(input.id)).currentCost.toString(), '2.8');
    const original = await db.movement.findMany({ where: { OR: [{ productionOrderId: order.id }, { productId: piece.id, kind: 'OUT' }] }, orderBy: { id: 'asc' } });

    const path = `/production/orders/${order.id}/correction`;
    const more = { reason: 'Pesagem refeita', inputs: [{ inputId: input.id, used: '120' }] };
    const noCosts = value => assert.doesNotMatch(JSON.stringify(value), /cost|energyRate|powerWatts|balance|averages/i);
    for (const [name, permissions] of [['COR-SEM', ['stock:operate']], ['COR-LE', ['production:view']], ['COR-OPERA', ['production:operate', 'stock:operate']], ['COR-SO', ['production:correct']]]) {
      const client = await session(name, permissions);
      expectStatus(await client(path + '/preview', { method: 'POST', body: more }), 403);
      expectStatus(await client(path, { method: 'POST', body: { ...more, expectedRevision: 0, stock: [] } }), 403);
    }
    const corrector = await session('COR-CORRIGE', ['production:view', 'production:correct']);
    const hidden = expectStatus(await corrector(path + '/preview', { method: 'POST', body: more }), 200);
    noCosts(hidden);
    expectStatus(await corrector(path + '/preview', { method: 'POST', body: { ...more, hourlyCost: '1' } }), 403);
    expectStatus(await post(path + '/preview', { inputs: more.inputs }), 400);
    expectStatus(await post(path + '/preview', { reason: 'Sem mudança' }), 400);
    const planned = expectStatus(await post(`/production/orders`, { printerId: printer.id, plannedStart: freeSlot(), estimatedMinutes: 60, items: [{ productId: piece.id, quantity: '1' }] }), 201);
    expectStatus(await post(`/production/orders/${planned.id}/correction/preview`, more), 409);

    // Partial balance: 20 g more at the average of 2.8 raises the piece from 10 to 15.6, and only the 6 still in stock reach the average.
    const preview = expectStatus(await post(path + '/preview', more), 200);
    assert.deepEqual([preview.costInStock, preview.costIssued, preview.averages[0].after], ['33.6', '22.4', '15.6']);
    assert.equal((await productRow(input.id)).quantity.toString(), '200');
    const confirm = (plan, body, client = admin) => client(path, { method: 'POST', body: { ...body, expectedRevision: plan.revision, stock: plan.stock } });
    const first = expectStatus(await confirm(preview, more, corrector), 200);
    noCosts(first);
    assert.equal(first.revision, 1);
    expectStatus(await confirm(preview, { ...more, inputs: [{ inputId: input.id, used: '125' }] }), 409);
    let stockedPiece = await productRow(piece.id);
    assert.deepEqual([stockedPiece.quantity.toString(), stockedPiece.currentCost.toString()], ['6', '15.6']);
    const stockedInput = await productRow(input.id);
    assert.deepEqual([stockedInput.quantity.toString(), stockedInput.currentCost.toString()], ['180', '2.8']);
    const untouched = await db.movement.findMany({ where: { id: { in: original.map(row => row.id) } }, orderBy: { id: 'asc' } });
    assert.deepEqual(JSON.parse(JSON.stringify(untouched)), JSON.parse(JSON.stringify(original)));
    const adjust = await db.movement.findFirst({ where: { productionOrderId: order.id, kind: 'PRODUCTION_ADJUST_OUT' } });
    assert.deepEqual([adjust.quantity.toString(), adjust.unitCost.toString()], ['-20', '2.8']);

    // Reserved balance cannot pay for extra consumption.
    const reserving = expectStatus(await post('/production/orders', { printerId: printer.id, plannedStart: freeSlot(), estimatedMinutes: 60, items: [{ productId: piece.id, quantity: '17' }] }), 201);
    expectStatus(await post(`/production/orders/${reserving.id}/start`, { startedAt: started }), 200);
    expectStatus(await post(path + '/preview', { reason: 'Mais insumo', inputs: [{ inputId: input.id, used: '140' }] }), 409);
    expectStatus(await post(`/production/orders/${reserving.id}/cancel`, {}), 200);
    expectStatus(await post(path + '/preview', { reason: 'Demais', inputs: [{ inputId: input.id, used: '100000' }] }), 409);

    // Zero balance: the difference stays on the revision and the average does not move.
    expectStatus(await movement(piece.id, unit.id, 'OUT', '6'), 201);
    expectStatus(await post(path + '/preview', { reason: 'Peças a menos', items: [{ productId: piece.id, lost: '1' }] }), 409);
    const machine = { reason: 'Custo da máquina', hourlyCost: '10' };
    const zero = expectStatus(await post(path + '/preview', machine), 200);
    assert.deepEqual([zero.costInStock, zero.costIssued, zero.averages], ['0', '10', []]);
    const second = expectStatus(await confirm(zero, machine), 200);
    assert.deepEqual([second.revision, second.totalCost, second.machineCost], [2, '166', '10']);
    stockedPiece = await productRow(piece.id);
    assert.deepEqual([stockedPiece.quantity.toString(), stockedPiece.currentCost.toString()], ['0', '15.6']);

    // Two simultaneous corrections from the same preview: exactly one goes through.
    const back = { reason: 'Sobrou filamento', inputs: [{ inputId: input.id, used: '110' }] };
    const race = expectStatus(await post(path + '/preview', back), 200);
    const results = await Promise.all([confirm(race, back), confirm(race, back)]);
    assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
    assert.equal((await productRow(input.id)).quantity.toString(), '190');
    assert.equal(await db.productionRevision.count({ where: { orderId: order.id } }), 3);

    const history = expectStatus(await corrector(`/production/orders/${order.id}/revisions`), 200);
    assert.deepEqual(history.map(row => row.number), [3, 2, 1]);
    assert.equal(history[2].reason, 'Pesagem refeita');
    noCosts(history);
    const full = expectStatus(await admin(`/production/orders/${order.id}/revisions`), 200);
    assert.deepEqual([full[2].costInStock, full[2].costIssued, full[2].after['Custo total']], ['33.6', '22.4', '156']);
    const audit = await waitForAuditEvent({ action: 'Corrigir ordem de produção concluída' }, row => row.details?.context?.Motivo === 'Pesagem refeita');
    assert.deepEqual([audit.details.before['Custo total'], audit.details.after['Custo total']], ['100', '156']);

    // Recovered pieces enter at the new cost, and the sale follows the good pieces.
    const lossy = await produce('2', '1', '50');
    assert.equal(lossy.sale.values.total, '50');
    const fixed = { reason: 'Peça aproveitada', items: [{ productId: piece.id, lost: '0' }] };
    const recovered = expectStatus(await admin(`/production/orders/${lossy.id}/correction/preview`, { method: 'POST', body: fixed }), 200);
    const updated = expectStatus(await admin(`/production/orders/${lossy.id}/correction`, { method: 'POST', body: { ...fixed, expectedRevision: recovered.revision, stock: recovered.stock } }), 200);
    assert.deepEqual([updated.items[0].good, updated.sale.values.total], ['2', '100']);
    assert.equal((await productRow(piece.id)).quantity.toString(), '2');
  });

  await t.test('famílias e unidades só mudam o que não afeta o histórico', async () => {
    const id = 'M' + Date.now();
    const patch = (path, body) => admin(path, { method: 'PATCH', body });
    const remove = path => admin(path, { method: 'DELETE' });
    const family = expectStatus(await post('/catalog/families', { name: 'Família ' + id, baseSymbol: id + 'b' }), 201);
    const base = family.units[0];
    const box = expectStatus(await post('/catalog/units', { familyId: family.id, symbol: id + 'c', factor: '12' }), 201);
    const spare = expectStatus(await post('/catalog/units', { familyId: family.id, symbol: id + 'd', factor: '6' }), 201);

    expectStatus(await patch('/catalog/families/' + family.id, { name: 'Renomeada ' + id }), 200);
    expectStatus(await patch('/catalog/units/' + base.id, { symbol: base.symbol, factor: '2' }), 409);
    assert.equal(expectStatus(await patch('/catalog/units/' + spare.id, { symbol: spare.symbol, factor: '24' }), 200).factor, '24');
    expectStatus(await remove('/catalog/units/' + base.id), 409);
    expectStatus(await remove('/catalog/units/' + spare.id), 200);

    const product = await createProduct('MEDIDA', base.id);
    expectStatus(await remove('/catalog/families/' + family.id), 409);
    expectStatus(await movement(product.id, box.id, 'PURCHASE', '1', '24'), 201);
    assert.equal((await productRow(product.id)).quantity.toString(), '12');
    expectStatus(await patch('/catalog/units/' + box.id, { symbol: box.symbol, factor: '10' }), 409);
    expectStatus(await remove('/catalog/units/' + box.id), 409);
    expectStatus(await patch('/catalog/units/' + box.id, { symbol: id + 'x', factor: '12' }), 200);
    const listed = expectStatus(await admin('/catalog/registrations'), 200).units.find(row => row.id === box.id);
    assert.ok(listed.factorBlock);
    assert.ok(listed.deleteBlock);

    const empty = expectStatus(await post('/catalog/families', { name: 'Vazia ' + id, baseSymbol: id + 'v' }), 201);
    expectStatus(await post('/catalog/units', { familyId: empty.id, symbol: id + 'w', factor: '5' }), 201);
    expectStatus(await remove('/catalog/families/' + empty.id), 200);
    assert.equal(await db.unit.count({ where: { familyId: empty.id } }), 0);
  });

  await t.test('entrada manual de produto fabricado exige ciência de que não baixa insumos', async () => {
    const product = await createProduct('ENTRADA-FABRICADO', unit.id);
    expectStatus(await admin('/catalog/products/' + product.id, {
      method: 'PATCH', body: { name: 'Fabricado', typeId: '00000000-0000-4000-8000-000000000003' },
    }), 200);
    const entry = extra => post('/purchases', { purchaseDate: '2026-01-01', items: [{ productId: product.id, unitId: unit.id, quantity: '2', totalCost: '10' }], ...extra });
    expectStatus(await entry(), 409);
    assert.equal((await productRow(product.id)).quantity.toString(), '0');
    expectStatus(await entry({ acknowledgeNoInputs: true }), 201);
    assert.equal((await productRow(product.id)).quantity.toString(), '2');
    expectStatus(await movement(product.id, unit.id, 'OUT', '1'), 201);
  });

  await t.test('inativação exige saldo zerado, bloqueia movimentações e preserva o histórico', async () => {
    const product = await createProduct('INATIVO', unit.id);
    expectStatus(await movement(product.id, unit.id, 'PURCHASE', '2', '3'), 201);
    const kit = expectStatus(await post('/catalog/kits', {
      sku: sku('KIT-INATIVO'), name: 'Kit para inativar', components: [{ productId: product.id, quantity: '1', unitId: unit.id }],
    }), 201);
    const status = (kind, id, active) => post(`/catalog/${kind}/${id}/status`, { active });

    expectStatus(await status('products', product.id, false), 409);
    expectStatus(await movement(product.id, unit.id, 'OUT', '2'), 201);
    expectStatus(await status('products', product.id, false), 409);
    expectStatus(await status('kits', kit.id, false), 200);
    expectStatus(await post(`/stock/kits/${kit.id}/out`, { quantity: '1', reason: 'Kit inativo' }), 409);
    expectStatus(await status('products', product.id, false), 200);

    expectStatus(await movement(product.id, unit.id, 'PURCHASE', '1', '3'), 409);
    expectStatus(await status('kits', kit.id, true), 409);
    const stock = expectStatus(await admin('/stock'), 200);
    assert.equal(stock.products.some(row => row.id === product.id), false);
    // The API values each product and sums the stock with exact decimals.
    const { Prisma } = require('@prisma/client');
    for (const row of stock.products) {
      const value = new Prisma.Decimal(row.quantity).times(row.currentCost ?? 0).toDecimalPlaces(12);
      assert.ok(new Prisma.Decimal(row.value).eq(value), row.sku + ': ' + row.value + ' ≠ ' + value.toFixed());
    }
    const expected = stock.products.reduce((sum, row) => sum.plus(row.value), new Prisma.Decimal(0));
    assert.equal(new Prisma.Decimal(stock.totalValue).toFixed(), expected.toFixed());
    const catalog = expectStatus(await admin('/catalog'), 200);
    assert.equal(catalog.products.find(row => row.id === product.id).active, false);
    assert.equal((await productMovements(product.id, 'OUT')).length, 1);
    const audit = expectStatus(await admin('/audit?' + new URLSearchParams({ action: 'Alterar situação do produto' })), 200);
    assert.ok(audit.events.some(event => event.targetId === product.id && event.details?.after?.['Situação'] === 'Inativo'));

    expectStatus(await status('products', product.id, true), 200);
    expectStatus(await movement(product.id, unit.id, 'PURCHASE', '1', '3'), 201);
  });

  await t.test('integração bancária: somente administradores, sem expor segredos', async () => {
    const { makeCertificate } = require('./certificates.cjs');
    const pair = makeCertificate('Empresa HTTP');
    const secret = 'segredo-http-' + run;
    const form = () => {
      const data = new FormData();
      for (const [key, value] of Object.entries({ environment: 'sandbox', clientId: 'cliente-' + run, secret, account: '1234' })) data.append(key, value);
      data.append('certificate', new Blob([pair.certificate]), 'cert.crt');
      data.append('privateKey', new Blob([pair.privateKey]), 'key.key');
      return data;
    };
    const saved = expectStatus(await admin('/finance/connection', { method: 'POST', body: form() }), 200);
    assert.equal(saved.configured, true);
    assert.equal(saved.certificate.subject, 'Empresa HTTP');
    const described = expectStatus(await admin('/finance/connection'), 200);
    for (const text of [JSON.stringify(saved), JSON.stringify(described)]) {
      assert.equal(text.includes(secret), false);
      assert.equal(text.includes('PRIVATE KEY'), false);
    }
    const stored = await db.bankConnection.findUniqueOrThrow({ where: { provider: 'inter' } });
    assert.match(stored.secret, /^v1:/);
    assert.equal(stored.secret.includes(secret), false);
    const audit = expectStatus(await admin('/audit?' + new URLSearchParams({ action: 'Alterar integração bancária' })), 200);
    assert.ok(audit.events.length);
    const trail = JSON.stringify(audit);
    assert.equal(trail.includes(secret), false);
    assert.equal(trail.includes('PRIVATE KEY'), false);
    assert.equal(trail.includes('BEGIN CERTIFICATE'), false);

    // Someone who operates the finance module still cannot see or change the integration.
    const email = run.toLowerCase() + '-financeiro@example.com';
    await db.user.create({
      data: {
        email, name: 'Pessoa do financeiro', passwordHash: await hashPassword(password),
        profile: { create: { name: sku('FINANCEIRO'), permissions: ['finance:operate'] } },
      },
    });
    const session = await request('/access/login', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.200' }, body: { email, password } });
    expectStatus(session, 200);
    const finance = (path, options = {}) => request(path, { ...options, cookie: session.cookie });
    expectStatus(await finance('/finance/connection'), 403);
    expectStatus(await finance('/finance/connection', { method: 'POST', body: form() }), 403);
    expectStatus(await finance('/finance/connection/test', { method: 'POST', body: {} }), 403);
  });

  await t.test('a limpeza remove somente prévias antigas não confirmadas', async () => {
    const { PreviewCleanup } = require('../dist/api/stock/stock.js');
    const { id: userId } = await db.user.findUniqueOrThrow({ where: { email: adminEmail } });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const batch = data => db.inventoryBatch.create({ data: { userId, ...data } });
    const abandoned = await batch({ createdAt: old });
    const confirmed = await batch({ createdAt: old, confirmedAt: old });
    const recent = await batch({});
    const oldImport = await db.initialImport.create({ data: { userId, data: [], createdAt: old } });
    await app.get(PreviewCleanup).removeExpired();
    const kept = await db.inventoryBatch.findMany({ where: { id: { in: [abandoned.id, confirmed.id, recent.id] } } });
    assert.deepEqual(kept.map(row => row.id).sort(), [confirmed.id, recent.id].sort());
    assert.equal(await db.initialImport.findUnique({ where: { id: oldImport.id } }), null);
  });

  await t.test('a planilha inválida não grava produtos e a confirmação da carga é idempotente', async () => {
    const workbook = await loadTemplate('/stock/initial/template');
    const first = sku('IMPORTADO-1');
    const second = sku('IMPORTADO-2');
    const sheet = workbook.worksheets[0];
    assert.deepEqual(sheet.getRow(1).values.slice(1, 8), ['SKU', 'Nome', 'Tipo', 'Unidade', 'Quantidade', 'Custo total', 'Perda (%)']);
    sheet.getRow(2).values = [first, 'Produto por unidade', '', unit.symbol, '4', '60.00'];
    sheet.getRow(3).values = [second, 'Produto por peso', '', sku('UNIDADE-INVALIDA'), '2.5', '30.00'];

    const upload = () => uploadWorkbook('/stock/initial/preview', workbook);
    const products = () => db.product.findMany({ where: { sku: { in: [first, second] } }, orderBy: { sku: 'asc' } });
    expectStatus(await upload(), 400);
    assert.equal((await products()).length, 0);
    sheet.getCell('D3').value = kilogram.symbol;
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

  await t.test('a carga grava cadastro e medidas de forma atômica e aceita o arquivo antigo', async () => {
    const fill = (sheet, line, values) => sheet.getRow(1).eachCell((cell, column) => {
      if (cell.text in values) sheet.getCell(line, column).value = values[cell.text];
    });
    const workbook = await loadTemplate('/stock/initial/template');
    const sheet = workbook.getWorksheet('Carga inicial');
    const [first, second] = [sku('CADASTRO-1'), sku('CADASTRO-2')];
    fill(sheet, 2, {
      SKU: first, Nome: 'Com cadastro', Unidade: unit.symbol, Quantidade: '2', 'Custo total': '120', 'Estoque mínimo': '1', 'Margem (%)': '40',
      'Preço de venda': '100', 'Comprimento (mm)': '12.5', 'URL de compra': 'https://loja.example/a',
    });
    fill(sheet, 3, { SKU: second, Nome: 'Com erro', Unidade: unit.symbol, Quantidade: '0', 'Margem (%)': '100' });
    fill(workbook.getWorksheet('Medidas'), 2, { SKU: first, Nome: 'Passo', Valor: '0.4', Unidade: 'mm' });
    const stored = () => db.product.count({ where: { sku: { in: [first, second] } } });
    expectStatus(await uploadWorkbook('/stock/initial/preview', workbook), 400);
    assert.equal(await stored(), 0);

    fill(sheet, 3, { 'Margem (%)': '10' });
    const batch = expectStatus(await uploadWorkbook('/stock/initial/preview', workbook), 201);
    assert.equal(batch.rows[0].marginPercent, '40');
    assert.deepEqual(batch.measures.map(row => [row.sku, row.value]), [[first, '0.4']]);

    // A conflict in the second row at confirmation also keeps the first one out.
    const blocker = expectStatus(await post('/catalog/products', { sku: second, name: 'Bloqueio', unitId: unit.id }), 201);
    expectStatus(await post(`/stock/initial/${batch.id}/confirm`), 409);
    assert.equal(await db.product.count({ where: { sku: first } }), 0);
    expectStatus(await admin('/catalog/products/' + blocker.id, { method: 'DELETE' }), 200);

    expectStatus(await post(`/stock/initial/${batch.id}/confirm`), [200, 201]);
    const product = await db.product.findUniqueOrThrow({ where: { sku: first }, include: { measures: true } });
    assert.deepEqual([product.minStock, product.marginPercent, product.salePrice, product.lengthMm, product.currentCost].map(value => value.toString()), ['1', '40', '100', '12.5', '60']);
    assert.equal(product.purchaseUrl, 'https://loja.example/a');
    assert.deepEqual(product.measures.map(row => [row.name, row.value.toString(), row.unit]), [['Passo', '0.4', 'mm']]);

    const legacy = new Workbook();
    const legacySku = sku('CADASTRO-ANTIGO');
    legacy.addWorksheet('Carga inicial').addRows([['SKU', 'Nome', 'Unidade', 'Quantidade', 'Custo'], [legacySku, 'Antigo', unit.symbol, '2', '15']]);
    const oldBatch = expectStatus(await uploadWorkbook('/stock/initial/preview', legacy), 201);
    expectStatus(await post(`/stock/initial/${oldBatch.id}/confirm`), [200, 201]);
    const old = await db.product.findUniqueOrThrow({ where: { sku: legacySku } });
    assert.deepEqual([old.quantity.toString(), old.currentCost.toString(), old.marginPercent, old.purchaseUrl], ['2', '15', null, null]);
  });

  await t.test('a carga inicial cadastra tipos, perda e ficha técnica de forma atômica', async () => {
    const workbook = await loadTemplate('/stock/initial/template');
    const [sheet, recipes] = [workbook.getWorksheet('Carga inicial'), workbook.getWorksheet('Ficha técnica')];
    const filament = sku('CARGA-PLA');
    const printed = sku('CARGA-PECA');
    sheet.getRow(2).values = [filament, 'PLA da carga', 'Filamento', kilogram.symbol, '3', '300'];
    sheet.getRow(3).values = [printed, 'Peça da carga', 'Produto normal', unit.symbol, '0', '', '5'];
    recipes.getRow(2).values = [printed, filament, '120', gram.symbol];
    const packing = sku('CARGA-EMBALAGEM');
    workbook.getWorksheet('Custos').getRow(2).values = [packing, 'Percentual', 'Venda', '6'];
    const upload = () => uploadWorkbook('/stock/initial/preview', workbook);
    const stored = () => db.product.count({ where: { sku: { in: [filament, printed] } } });
    // Costs are registrations, so loading them also needs registrations:operate.
    const loader = await session('CARGA-SEM-CUSTOS', ['catalog:operate', 'stock:operate']);
    expectStatus(await uploadWorkbook('/stock/initial/preview', workbook, loader), 403);

    expectStatus(await upload(), 400);
    sheet.getCell('C3').value = 'Impresso 3D';
    recipes.getCell('B2').value = printed;
    expectStatus(await upload(), 400);
    recipes.getCell('B2').value = filament;
    const batch = expectStatus(await upload(), 201);
    assert.equal(batch.rows[0].declaredCost, '100');
    assert.equal(batch.rows[1].typeName, 'Impresso 3D');
    assert.deepEqual(batch.costs, [{ name: packing, mode: 'PERCENT', base: 'SALE', value: '6', active: true }]);
    assert.equal(await stored(), 0);
    assert.equal(await db.costItem.count({ where: { name: packing } }), 0);

    expectStatus(await post(`/stock/initial/${batch.id}/confirm`), [200, 201]);
    const cost = await db.costItem.findUniqueOrThrow({ where: { name: packing } });
    assert.deepEqual([cost.mode, cost.base, cost.value.toString(), cost.active], ['PERCENT', 'SALE', '6', true]);
    const [input, product] = await Promise.all([
      db.product.findUniqueOrThrow({ where: { sku: filament } }),
      db.product.findUniqueOrThrow({ where: { sku: printed }, include: { recipe: true } }),
    ]);
    assert.equal(input.quantity.toString(), '3000');
    assert.equal(input.currentCost.toString(), '0.1');
    assert.equal(product.wastePercent.toString(), '5');
    assert.deepEqual(product.recipe.map(row => [row.inputId, row.quantity.toString()]), [[input.id, '120']]);
  });

  await t.test('arquivos do produto respeitam permissão, nome, tipo e exclusão', async () => {
    const family = await createFamily('ARQUIVOS', sku('ARQ'));
    const product = await createProduct('COM-ARQUIVO', family.units[0].id);
    const path = '/catalog/products/' + product.id + '/files';
    const form = (bytes, name, type = 'application/pdf') => {
      const body = new FormData();
      body.append('file', new Blob([bytes], { type }), name);
      return body;
    };
    const stored = () => readdirSync(fileRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
    async function sessionWith(permissions, index) {
      const label = 'ARQ' + index;
      const email = run.toLowerCase() + '-' + label.toLowerCase() + '@example.com';
      await db.user.create({ data: {
        email, name: 'Perfil ' + label, passwordHash: await hashPassword(password),
        profile: { create: { name: sku(label), permissions } },
      } });
      const session = await request('/access/login', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.' + (index + 1) }, body: { email, password } });
      expectStatus(session, 200);
      const call = (route, options = {}) => request(route, { ...options, cookie: session.cookie });
      call.cookie = session.cookie;
      return call;
    }
    const [none, viewer, operator] = await Promise.all([['stock:view'], ['catalog:view'], ['catalog:operate']].map(sessionWith));

    expectStatus(await request(path), 401);
    expectStatus(await none(path), 403);
    expectStatus(await none(path, { method: 'POST', body: form('x', 'a.pdf') }), 403);
    expectStatus(await viewer(path, { method: 'POST', body: form('x', 'a.pdf') }), 403);
    assert.deepEqual(stored(), [], 'perfil recusado não grava em disco');

    const file = expectStatus(await operator(path, { method: 'POST', body: form('conteudo', 'Peça "final".pdf', 'text/html') }), 201);
    assert.equal(file.originalName, 'Peça _final_.pdf');
    assert.equal('storageKey' in file, false);
    assert.equal(file.sizeBytes, 8);
    const row = await db.storedFile.findUniqueOrThrow({ where: { id: file.id } });
    assert.equal(row.available, true);
    assert.match(row.storageKey, /^[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    assert.equal(stored().length, 1);
    const audit = await waitForAuditEvent({ action: 'Enviar arquivo do produto' }, event => event.targetId === product.id && event.status === 201);
    assert.equal(audit.details.after.Arquivo, 'Peça _final_.pdf');

    const listed = expectStatus(await viewer(path), 200);
    assert.deepEqual(listed.map(item => item.id), [file.id]);
    assert.equal('storageKey' in listed[0], false);
    expectStatus(await none(path + '/' + file.id + '/download'), 403);
    const download = await fetch(baseUrl + '/api' + path + '/' + file.id + '/download', { headers: { cookie: viewer.cookie } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.match(download.headers.get('content-disposition'), /^attachment; filename="Peca _final_.pdf"; filename\*=UTF-8''/);
    assert.equal(await download.text(), 'conteudo');

    expectStatus(await operator(path, { method: 'POST', body: form('x', 'setup.exe') }), 415);
    expectStatus(await operator(path, { method: 'POST', body: form('MZ executavel', 'manual.pdf') }), 415);
    expectStatus(await operator(path, { method: 'POST', body: form('', 'vazio.pdf') }), 400);
    expectStatus(await operator('/catalog/products/' + randomUUID() + '/files', { method: 'POST', body: form('x', 'a.pdf') }), 404);
    assert.equal(stored().length, 1, 'envios recusados não deixam temporários');

    const other = await createProduct('SEM-ARQUIVO', family.units[0].id);
    expectStatus(await admin('/catalog/products/' + other.id + '/files/' + file.id + '/download'), 404);
    expectStatus(await admin('/catalog/products/' + other.id + '/files/' + file.id, { method: 'DELETE' }), 404);

    expectStatus(await viewer(path + '/' + file.id, { method: 'DELETE' }), 403);
    expectStatus(await operator(path + '/' + file.id, { method: 'DELETE' }), 200);
    assert.equal(await db.storedFile.count({ where: { id: file.id } }), 0);
    assert.deepEqual(stored(), []);

    const attached = expectStatus(await operator(path, { method: 'POST', body: form('outro', 'b.stl') }), 201);
    expectStatus(await admin('/catalog/products/' + product.id, { method: 'DELETE' }), 200);
    assert.equal(await db.storedFile.count({ where: { id: attached.id } }), 0);
    assert.deepEqual(stored(), [], 'excluir o produto não deixa arquivo órfão');

    const pictured = await createProduct('COM-IMAGEM', family.units[0].id);
    const imagePath = '/catalog/products/' + pictured.id + '/image';
    const png = Buffer.from('89504e470d0a1a0a00', 'hex');
    expectStatus(await viewer(imagePath, { method: 'POST', body: form(png, 'foto.png', 'image/png') }), 403);
    expectStatus(await operator(imagePath, { method: 'POST', body: form('<svg/>', 'foto.svg', 'image/svg+xml') }), 415);
    expectStatus(await operator(imagePath, { method: 'POST', body: form('texto', 'foto.png', 'image/png') }), 415);
    assert.deepEqual(stored(), [], 'imagem recusada não fica no disco');
    const first = expectStatus(await operator(imagePath, { method: 'POST', body: form(png, 'foto.png', 'text/html') }), 201);
    expectStatus(await none(imagePath), 403);
    const shown = await fetch(baseUrl + '/api' + imagePath, { headers: { cookie: viewer.cookie } });
    assert.equal(shown.status, 200);
    assert.equal(shown.headers.get('content-type'), 'image/png');
    assert.equal(shown.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(shown.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await shown.arrayBuffer()), png);
    const listedImage = expectStatus(await viewer('/catalog'), 200).products.find(row => row.id === pictured.id);
    assert.equal(listedImage.imageFileId, first.id);
    const second = expectStatus(await operator(imagePath, { method: 'POST', body: form(png, 'nova.png', 'image/png') }), 201);
    assert.equal(await db.storedFile.count({ where: { id: first.id } }), 0, 'a imagem trocada sai do banco');
    assert.equal(stored().length, 1, 'a imagem trocada sai do disco');
    expectStatus(await viewer(imagePath, { method: 'DELETE' }), 403);
    expectStatus(await operator(imagePath, { method: 'DELETE' }), 200);
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: pictured.id } })).imageFileId, null);
    assert.equal(await db.storedFile.count({ where: { id: second.id } }), 0);
    expectStatus(await viewer(imagePath), 404);
    const last = expectStatus(await operator(imagePath, { method: 'POST', body: form(png, 'final.png', 'image/png') }), 201);
    expectStatus(await admin('/catalog/products/' + pictured.id, { method: 'DELETE' }), 200);
    assert.equal(await db.storedFile.count({ where: { id: last.id } }), 0);
    assert.deepEqual(stored(), [], 'excluir o produto leva a imagem junto');
  });

  await t.test('compras: permissões, produto repetido, rateio, atomicidade e estorno', async () => {
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const purchase = (items, extra = {}) => ({ purchaseDate: day, items, ...extra });
    const line = (product, quantity, totalCost, unitId = unit.id) => ({ productId: product.id, unitId, quantity, totalCost });
    const none = await session('COMPRA-NADA', ['catalog:view']);
    const viewer = await session('COMPRA-VER', ['purchases:view']);
    const operator = await session('COMPRA-OPERA', ['purchases:operate']);
    const registrar = await session('COMPRA-CAD', ['registrations:operate']);
    const first = await createProduct('COMPRA-A', unit.id);
    const second = await createProduct('COMPRA-B', unit.id);
    const body = purchase([line(first, '1', '10')]);

    expectStatus(await none('/purchases'), 403);
    expectStatus(await none('/purchases', { method: 'POST', body }), 403);
    expectStatus(await viewer('/purchases'), 200);
    expectStatus(await viewer('/purchases/options'), 403);
    expectStatus(await viewer('/purchases', { method: 'POST', body }), 403);
    expectStatus(await none('/suppliers'), 403);
    expectStatus(await operator('/suppliers', { method: 'POST', body: { name: sku('FORN-X') } }), 403);
    const supplier = expectStatus(await registrar('/suppliers', { method: 'POST', body: { name: sku('FORN'), document: '12.345.678/0001-95' } }), 201);
    assert.equal(supplier.document, '12345678000195');
    const options = expectStatus(await operator('/purchases/options'), 200);
    assert.ok(options.suppliers.some(row => row.id === supplier.id));
    assert.equal(JSON.stringify(options.products).includes('currentCost'), false);

    // Repeated lines become one entry with the combined cost, and the extra cost stays out of the average.
    const posted = expectStatus(await operator('/purchases', { method: 'POST', body: purchase(
      [line(first, '2', '10'), line(second, '1', '30'), line(first, '2', '30')],
      { supplierId: supplier.id, documentNumber: 'NF-1', purchaseDate: '2026-01-15', costs: [{ title: 'Frete', mode: 'VALUE', value: '10', split: 'QUANTITY' }, { title: 'Taxa', mode: 'PERCENT', value: '10', split: 'VALUE' }] },
    ) }), 201);
    let row = await productRow(first.id);
    // Freight 10 over 5 pieces gives 8 to this item; the 7 of the fee follow the value, 40 of 70, so 4. Together 12 over 4 pieces.
    assert.deepEqual([row.quantity.toString(), row.currentCost.toString(), row.lastPurchaseCost.toString(), row.lastPurchaseExpense.toString()], ['4', '10', '10', '3']);
    assert.equal(row.lastSupplierId, supplier.id);
    assert.equal(row.lastPurchaseAt.toISOString().slice(0, 10), '2026-01-15');
    assert.equal((await productMovements(first.id, 'PURCHASE')).length, 1);
    const details = expectStatus(await viewer('/purchases/' + posted.id), 200);
    assert.deepEqual([details.goodsTotal, details.costsTotal, details.reversalBlock], ['70', '17', null]);
    assert.equal(details.items.reduce((total, item) => total + Number(item.expenseTotal), 0), 17);
    assert.equal(JSON.stringify(details).includes('previousCost'), false);

    // A failure on the last line leaves nothing behind.
    const inactive = await createProduct('COMPRA-INATIVO', unit.id);
    await db.product.update({ where: { id: inactive.id }, data: { active: false } });
    const before = await db.purchase.count();
    expectStatus(await operator('/purchases', { method: 'POST', body: purchase([line(first, '1', '99'), line(inactive, '1', '1')]) }), 409);
    assert.equal(await db.purchase.count(), before);
    assert.equal((await productRow(first.id)).quantity.toString(), '4');
    expectStatus(await operator('/purchases', { method: 'POST', body: purchase([line(first, '1', '1')], { purchaseDate: '2999-01-01' }) }), 400);

    // Informative data changes without touching stock, and reaches the product summary.
    expectStatus(await viewer('/purchases/' + posted.id, { method: 'PATCH', body: { purchaseDate: '2026-01-20' } }), 403);
    expectStatus(await operator('/purchases/' + posted.id, { method: 'PATCH', body: { purchaseDate: '2026-01-20', documentNumber: 'NF-2', supplierId: supplier.id } }), 200);
    row = await productRow(first.id);
    assert.equal(row.lastPurchaseAt.toISOString().slice(0, 10), '2026-01-20');
    assert.equal(row.quantity.toString(), '4');

    // A later purchase blocks the older one; reversing the newest restores the state before it.
    const later = expectStatus(await operator('/purchases', { method: 'POST', body: purchase([line(first, '4', '80')]) }), 201);
    assert.equal((await productRow(first.id)).currentCost.toString(), '15');
    expectStatus(await operator('/purchases/' + posted.id + '/reversal', { method: 'POST', body: { reason: 'Erro' } }), 409);
    expectStatus(await viewer('/purchases/' + later.id + '/reversal', { method: 'POST', body: { reason: 'Erro' } }), 403);
    expectStatus(await operator('/purchases/' + later.id + '/reversal', { method: 'POST', body: {} }), 400);
    expectStatus(await operator('/purchases/' + later.id + '/reversal', { method: 'POST', body: { reason: 'Nota errada' } }), 201);
    row = await productRow(first.id);
    assert.deepEqual([row.quantity.toString(), row.currentCost.toString(), row.lastPurchaseCost.toString(), row.lastPurchaseExpense.toString()], ['4', '10', '10', '3']);
    assert.equal(row.lastPurchaseAt.toISOString().slice(0, 10), '2026-01-20');
    assert.equal(row.lastSupplierId, supplier.id);
    assert.equal((await productMovements(first.id, 'PURCHASE_REVERSAL')).length, 1);
    expectStatus(await operator('/purchases/' + later.id + '/reversal', { method: 'POST', body: { reason: 'De novo' } }), 409);
    expectStatus(await operator('/purchases/' + later.id, { method: 'PATCH', body: { purchaseDate: day } }), 409);

    // Any later movement blocks the reversal.
    expectStatus(await movement(first.id, unit.id, 'OUT', '1'), 201);
    assert.match(expectStatus(await viewer('/purchases/' + posted.id), 200).reversalBlock, /movimentação ou alteração posterior/);
    expectStatus(await operator('/purchases/' + posted.id + '/reversal', { method: 'POST', body: { reason: 'Tarde' } }), 409);
    assert.equal((await productRow(second.id)).quantity.toString(), '1', 'o bloqueio de um item barra a compra inteira');

    // The free balance must cover the reversal when a running print holds the input.
    const held = await createProduct('COMPRA-RESERVA', unit.id);
    const heldPurchase = expectStatus(await operator('/purchases', { method: 'POST', body: purchase([line(held, '5', '5')]) }), 201);
    const printer = await db.printer.create({ data: { name: sku('COMPRA-IMP'), powerWatts: '100', hourlyCost: '1' } });
    const piece = await createProduct('COMPRA-PECA', unit.id);
    const adminUser = await db.user.findUniqueOrThrow({ where: { email: adminEmail } });
    const order = await db.productionOrder.create({ data: {
      status: 'PRINTING', printerId: printer.id, userId: adminUser.id, plannedStart: new Date(), estimatedMinutes: 10, expectedEnd: new Date(),
      items: { create: { productId: piece.id, planned: '1', consumption: { create: { inputId: held.id, planned: '2' } } } },
    } });
    assert.match(expectStatus(await viewer('/purchases/' + heldPurchase.id), 200).reversalBlock, /reservado/);
    expectStatus(await operator('/purchases/' + heldPurchase.id + '/reversal', { method: 'POST', body: { reason: 'Reservado' } }), 409);
    assert.equal((await productRow(held.id)).quantity.toString(), '5');
    await db.productionOrder.update({ where: { id: order.id }, data: { status: 'CANCELED' } });

    // A converted purchase keeps its data editable, without a reversal.
    const convertedMovement = await db.movement.create({ data: { kind: 'PURCHASE', quantity: '1', unitCost: '1', reason: 'Antiga', productId: second.id, userId: adminUser.id } });
    const converted = await db.purchase.create({ data: {
      purchaseDate: new Date('2025-01-01'), goodsTotal: '1', converted: true, userId: adminUser.id,
      items: { create: { productId: second.id, movementId: convertedMovement.id, declaredQuantity: '1', declaredUnit: unit.symbol, quantity: '1', goodsTotal: '1', unitCost: '1' } },
    } });
    expectStatus(await operator('/purchases/' + converted.id + '/reversal', { method: 'POST', body: { reason: 'Antiga' } }), 409);
    expectStatus(await operator('/purchases/' + converted.id, { method: 'PATCH', body: { purchaseDate: '2025-01-02', documentNumber: 'ANTIGA' } }), 200);

    // A supplier with history is inactivated, not removed, and leaves the purchase form.
    expectStatus(await registrar('/suppliers/' + supplier.id, { method: 'DELETE' }), 409);
    expectStatus(await registrar('/suppliers/' + supplier.id, { method: 'PATCH', body: { name: supplier.name, active: false } }), 200);
    expectStatus(await operator('/purchases', { method: 'POST', body: purchase([line(first, '1', '1')], { supplierId: supplier.id }) }), 409);
    await waitForAuditEvent({ action: 'Estornar compra' }, item => item.targetId === later.id && item.status === 201);
  });

  await t.test('documentos de compra: permissões, limite, tipos, filtros e nenhum arquivo órfão', async () => {
    const fileRootFiles = () => readdirSync(process.env.FILE_STORAGE_DIR, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length;
    const pdf = Buffer.from('%PDF-1.7 nota');
    const form = (bytes, name, type = 'INVOICE') => {
      const body = new FormData();
      if (type) body.append('type', type);
      body.append('file', new Blob([bytes]), name);
      return body;
    };
    const none = await session('DOC-NADA', ['stock:operate']);
    const viewer = await session('DOC-VER', ['purchases:view']);
    const operator = await session('DOC-OPERA', ['purchases:operate']);
    const supplier = expectStatus(await post('/suppliers', { name: sku('FORN-DOC') }), 201);
    const product = await createProduct('DOC-A', unit.id);
    const otherProduct = await createProduct('DOC-B', unit.id);
    const buy = (item, extra) => post('/purchases', { purchaseDate: '2026-03-10', items: [{ productId: item.id, unitId: unit.id, quantity: '1', totalCost: '10' }], ...extra });
    const purchase = expectStatus(await buy(product, { supplierId: supplier.id, documentNumber: run + '_NF-77' }), 201);
    const other = expectStatus(await buy(otherProduct, { purchaseDate: '2026-04-20', documentNumber: run + 'XNF-77' }), 201);
    const path = '/purchases/' + purchase.id + '/documents';
    const before = fileRootFiles();

    expectStatus(await request(path), 401);
    expectStatus(await none(path), 403);
    expectStatus(await none('/purchase-documents'), 403);
    expectStatus(await none('/purchase-documents/filters'), 403);
    expectStatus(await none(path, { method: 'POST', body: form(pdf, 'a.pdf') }), 403);
    expectStatus(await viewer(path, { method: 'POST', body: form(pdf, 'a.pdf') }), 403);

    // Refused uploads leave nothing behind: limit, blocked or wrong type, renamed content, missing type.
    expectStatus(await operator(path, { method: 'POST', body: form(Buffer.concat([pdf, Buffer.alloc(20 * 1024 * 1024)]), 'grande.pdf') }), 413);
    expectStatus(await operator(path, { method: 'POST', body: form('MZ', 'setup.exe') }), 415);
    expectStatus(await operator(path, { method: 'POST', body: form('<svg/>', 'a.svg') }), 415);
    expectStatus(await operator(path, { method: 'POST', body: form('PK', 'a.zip') }), 415);
    expectStatus(await operator(path, { method: 'POST', body: form('MZ executavel', 'nota.pdf') }), 415);
    expectStatus(await operator(path, { method: 'POST', body: form('texto comum', 'nota.pdf') }), 415);
    expectStatus(await operator(path, { method: 'POST', body: form(pdf, 'a.pdf', 'NADA') }), 400);
    expectStatus(await operator(path, { method: 'POST', body: form(pdf, 'a.pdf', null) }), 400);
    expectStatus(await operator('/purchases/' + randomUUID() + '/documents', { method: 'POST', body: form(pdf, 'a.pdf') }), 404);
    assert.equal(fileRootFiles(), before, 'envios recusados não deixam arquivo');

    const invoice = expectStatus(await operator(path, { method: 'POST', body: form(pdf, 'nota.pdf') }), 201);
    assert.equal('storageKey' in invoice, false);
    const audit = await waitForAuditEvent({ action: 'Anexar documento da compra' }, event => event.targetId === purchase.id && event.status === 201);
    assert.equal(audit.details.after.Arquivo, 'nota.pdf');
    assert.equal(audit.details.context['Tipo do documento'], 'Nota fiscal');
    const xml = expectStatus(await operator('/purchases/' + other.id + '/documents', { method: 'POST', body: form('<?xml version="1.0"?><nfe/>', 'nfe.xml', 'RECEIPT') }), 201);

    // Converted and reversed purchases still accept documents.
    expectStatus(await operator('/purchases/' + other.id + '/reversal', { method: 'POST', body: { reason: 'Teste' } }), 201);
    const late = expectStatus(await operator('/purchases/' + other.id + '/documents', { method: 'POST', body: form(pdf, 'estorno.pdf', 'OTHER') }), 201);
    const adminUser = await db.user.findUniqueOrThrow({ where: { email: adminEmail } });
    const oldMovement = await db.movement.create({ data: { kind: 'PURCHASE', quantity: '1', unitCost: '1', reason: 'Antiga', productId: otherProduct.id, userId: adminUser.id } });
    const converted = await db.purchase.create({ data: {
      purchaseDate: new Date('2025-01-01'), goodsTotal: '1', converted: true, userId: adminUser.id,
      items: { create: { productId: otherProduct.id, movementId: oldMovement.id, declaredQuantity: '1', declaredUnit: unit.symbol, quantity: '1', goodsTotal: '1', unitCost: '1' } },
    } });
    const old = expectStatus(await operator('/purchases/' + converted.id + '/documents', { method: 'POST', body: form(pdf, 'antiga.pdf', 'QUOTE') }), 201);

    // A file is only reached through its own purchase.
    expectStatus(await none(path + '/' + invoice.id + '/download'), 403);
    expectStatus(await viewer('/purchases/' + other.id + '/documents/' + invoice.id + '/download'), 404);
    expectStatus(await operator('/purchases/' + other.id + '/documents/' + invoice.id, { method: 'DELETE' }), 404);
    const download = await viewer(path + '/' + invoice.id + '/download');
    expectStatus(download, 200);
    assert.equal(Buffer.from(download.data).toString(), pdf.toString());
    assert.deepEqual(expectStatus(await viewer(path), 200).map(row => row.id), [invoice.id]);

    // Filters. Each search is narrowed to this run through its product or document number.
    const search = async query => expectStatus(await viewer('/purchase-documents?' + new URLSearchParams(query)), 200);
    const ids = async query => (await search(query)).documents.map(row => row.id).sort();
    const sorted = list => [...list].sort();
    assert.deepEqual(await ids({ supplierId: supplier.id }), [invoice.id]);
    assert.deepEqual(await ids({ productId: otherProduct.id }), sorted([xml.id, late.id, old.id]));
    assert.deepEqual(await ids({ productId: otherProduct.id, type: 'RECEIPT' }), [xml.id]);
    assert.deepEqual(await ids({ productId: otherProduct.id, from: '2026-04-01', to: '2026-04-30' }), sorted([xml.id, late.id]));
    assert.deepEqual(await ids({ productId: otherProduct.id, to: '2025-12-31' }), [old.id]);
    assert.deepEqual(await ids({ number: run.toLowerCase() + '_nf' }), [invoice.id], 'o sublinhado é literal');
    assert.deepEqual(await ids({ number: String(converted.number) }), [old.id]);
    expectStatus(await viewer('/purchase-documents?from=2026-02-01&to=2026-01-01'), 400);
    expectStatus(await viewer('/purchase-documents?sort=storageKey:asc'), 400);
    expectStatus(await viewer('/purchase-documents?page=0'), 400);

    // Sorting and paging happen on the server.
    const names = async (sort, page = 1) => (await search({ productId: otherProduct.id, sort, page })).documents.map(row => row.originalName);
    assert.deepEqual(await names('name:asc'), ['antiga.pdf', 'estorno.pdf', 'nfe.xml']);
    assert.deepEqual(await names('name:desc'), ['nfe.xml', 'estorno.pdf', 'antiga.pdf']);
    assert.deepEqual((await names('purchaseDate:asc'))[0], 'antiga.pdf');
    const page = await search({ productId: otherProduct.id, page: 2 });
    assert.deepEqual([page.total, page.page, page.documents.length], [3, 2, 0]);
    assert.equal(JSON.stringify(await search({ productId: otherProduct.id })).includes('storageKey'), false);
    const filters = expectStatus(await viewer('/purchase-documents/filters'), 200);
    assert.ok(filters.suppliers.some(row => row.id === supplier.id));
    assert.ok(filters.products.some(row => row.id === product.id));
    assert.equal(JSON.stringify(filters).includes('currentCost'), false);

    // Removing clears the row and the content.
    expectStatus(await viewer(path + '/' + invoice.id, { method: 'DELETE' }), 403);
    const filesBefore = fileRootFiles();
    expectStatus(await operator(path + '/' + invoice.id, { method: 'DELETE' }), 200);
    assert.equal(await db.storedFile.count({ where: { id: invoice.id } }), 0);
    assert.equal(await db.purchaseDocument.count({ where: { fileId: invoice.id } }), 0);
    assert.equal(fileRootFiles(), filesBefore - 1, 'excluir não deixa arquivo órfão');
    await waitForAuditEvent({ action: 'Excluir documento da compra' }, event => event.targetId === purchase.id && event.status === 200);
  });

  await t.test('carga inicial: colunas de compra, fornecedor desconhecido e lote sem gravação parcial', async () => {
    const supplier = expectStatus(await post('/suppliers', { name: sku('FORN-CARGA') }), 201);
    const workbook = await loadTemplate('/stock/initial/template');
    const sheet = workbook.worksheets[0];
    const put = (line, values) => sheet.getRow(1).eachCell((cell, column) => { if (cell.text in values) sheet.getCell(line, column).value = values[cell.text]; });
    put(2, { SKU: sku('CARGA-A'), Nome: 'Carga A', Unidade: unit.symbol, Quantidade: '4', 'Custo total': '40', 'Data da compra': '15/01/2026', Fornecedor: supplier.name, 'Despesas da compra': '8' });
    put(3, { SKU: sku('CARGA-B'), Nome: 'Carga B', Unidade: unit.symbol, Quantidade: '1', 'Custo total': '1', Fornecedor: sku('INEXISTENTE') });
    const refused = await uploadWorkbook('/stock/initial/preview', workbook);
    expectStatus(refused, 400);
    assert.match(refused.data.message, /Fornecedor desconhecido/);
    assert.equal(await db.product.count({ where: { sku: { in: [sku('CARGA-A'), sku('CARGA-B')] } } }), 0);
    put(3, { Fornecedor: supplier.name });
    const preview = expectStatus(await uploadWorkbook('/stock/initial/preview', workbook), 201);
    assert.equal(preview.rows[0].purchaseExpenses, '8');
    expectStatus(await post('/stock/initial/' + preview.id + '/confirm', {}), 201);
    const row = await db.product.findUniqueOrThrow({ where: { sku: sku('CARGA-A') } });
    assert.deepEqual([row.currentCost.toString(), row.lastPurchaseCost.toString(), row.lastPurchaseExpense.toString(), row.lastSupplierId], ['10', '10', '2', supplier.id]);
    assert.equal(row.lastPurchaseAt.toISOString().slice(0, 10), '2026-01-15');
    assert.equal(await db.purchaseItem.count({ where: { productId: row.id } }), 0, 'a carga não vira compra');
  });
});
