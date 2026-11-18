const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { hasOpenssl, makeCertificate } = require('./certificates.cjs');

process.env.CONFIG_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const { BankConnectionService, inspectCertificate } = require('../dist/api/finance/connection.js');
const { InterReader } = require('../dist/api/finance/inter.js');

const skip = hasOpenssl() ? false : 'openssl não está disponível para gerar certificados de teste.';
const pair = skip ? null : makeCertificate('Empresa de Teste');
const other = skip ? null : makeCertificate('Outra Empresa');

/** Just enough of Prisma for BankConnectionService, keeping rows in memory. */
function memoryDatabase() {
  const rows = new Map();
  return {
    rows,
    bankConnection: {
      findUnique: async ({ where, include }) => {
        const row = rows.get(where.provider);
        return row ? { ...row, ...(include ? { updatedBy: { name: 'Admin' } } : {}) } : null;
      },
      upsert: async ({ where, create, update }) => {
        const previous = rows.get(where.provider);
        rows.set(where.provider, { ...(previous ?? create), ...(previous ? update : {}), updatedAt: new Date(Date.now() + rows.size) });
      },
    },
  };
}

const connected = [];
const provider = { id: 'inter', name: 'Inter', connect: config => { connected.push(config); return { balance: async () => '10.00' }; } };
const fields = { environment: 'sandbox', clientId: 'cliente-123', secret: 'segredo-forte', account: '1234' };
const files = () => ({ certificate: Buffer.from(pair.certificate), privateKey: Buffer.from(pair.privateKey) });

test('accepts a matching pair and reads its holder and expiry', { skip }, () => {
  const { subject, expires } = inspectCertificate(pair.certificate, pair.privateKey);
  assert.equal(subject, 'Empresa de Teste');
  assert.ok(expires > new Date());
});

test('rejects a key from another certificate, an expired certificate and invalid files', { skip }, () => {
  assert.throws(() => inspectCertificate(pair.certificate, other.privateKey), /não corresponde/);
  const later = new Date(Date.now() + 365 * 86400000);
  assert.throws(() => inspectCertificate(pair.certificate, pair.privateKey, later), /venceu/);
  assert.throws(() => inspectCertificate('texto', pair.privateKey), /certificado PEM/);
  assert.throws(() => inspectCertificate(pair.certificate, 'texto'), /chave privada PEM/);
});

test('saves encrypted secrets and never describes them', { skip }, async () => {
  const db = memoryDatabase();
  const service = new BankConnectionService(db);
  assert.deepEqual(await service.describe(provider), { provider: 'inter', configured: false });
  const described = await service.save(provider, fields, files(), 'user-1');
  const row = db.rows.get('inter');
  assert.match(row.secret, /^v1:/);
  assert.match(row.privateKey, /^v1:/);
  assert.equal(row.secret.includes('segredo-forte'), false);
  assert.equal(row.privateKey.includes('PRIVATE KEY'), false);
  const text = JSON.stringify(described);
  assert.equal(text.includes('segredo-forte'), false);
  assert.equal(text.includes('PRIVATE KEY'), false);
  assert.equal(described.certificate.subject, 'Empresa de Teste');
});

test('a blank secret and no new files keep what was saved', { skip }, async () => {
  const db = memoryDatabase();
  const service = new BankConnectionService(db);
  await service.save(provider, fields, files(), 'user-1');
  await service.save(provider, { ...fields, secret: undefined, clientId: 'cliente-novo' }, {}, 'user-1');
  connected.length = 0;
  await service.reader(provider);
  assert.equal(connected[0].secret, 'segredo-forte');
  assert.equal(connected[0].clientId, 'cliente-novo');
  assert.equal(connected[0].privateKey, pair.privateKey);
});

test('the first save needs the secret and both files', { skip }, async () => {
  const service = new BankConnectionService(memoryDatabase());
  await assert.rejects(service.save(provider, { ...fields, secret: undefined }, files(), 'user-1'), /Client Secret/);
  await assert.rejects(service.save(provider, fields, { certificate: files().certificate }, 'user-1'), /certificado e a chave/);
});

test('reuses the reader until the configuration changes', { skip }, async () => {
  const service = new BankConnectionService(memoryDatabase());
  await assert.rejects(service.reader(provider), /não foi configurada/);
  await service.save(provider, fields, files(), 'user-1');
  const first = await service.reader(provider);
  assert.equal(await service.reader(provider), first);
  await service.save(provider, { ...fields, environment: 'production' }, {}, 'user-1');
  assert.notEqual(await service.reader(provider), first);
  assert.deepEqual(await service.test(provider), { ok: true });
});

test('the Inter reader is built from the saved PEM texts', { skip }, () => {
  assert.ok(InterReader.fromConfig({ ...fields, ...pair }) instanceof InterReader);
});
