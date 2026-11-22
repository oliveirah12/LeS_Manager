require('reflect-metadata');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { Controller, Module, Post, UploadedFile } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const {
  attachmentHeader, hasBlockedExtension, hasDocumentExtension, hasExecutableSignature, matchesDocumentContent, purchaseDocumentLimit, safeFileName, safeMimeType,
} = require('../dist/api/files/rules.js');
const { DiskFileStorage, newStorageKey, storageRoot } = require('../dist/api/files/storage.js');
const { FileUpload } = require('../dist/api/files/upload.js');

async function withRoot(work) {
  const previous = process.env.FILE_STORAGE_DIR;
  const root = await mkdtemp(join(tmpdir(), 'les-files-'));
  process.env.FILE_STORAGE_DIR = root;
  try {
    return await work(root);
  } finally {
    if (previous === undefined) delete process.env.FILE_STORAGE_DIR;
    else process.env.FILE_STORAGE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('a malicious name loses its path and forbidden characters', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('..\\..\\Windows\\win.ini'), 'win.ini');
  assert.equal(safeFileName('a\r\nSet-Cookie: x.pdf'), 'a__Set-Cookie_ x.pdf');
  assert.equal(safeFileName('nota"<>|?*.pdf'), 'nota______.pdf');
  assert.equal(safeFileName('...'), 'arquivo');
  assert.equal(safeFileName(''), 'arquivo');
  assert.equal(safeFileName('Peça final.3mf'), 'Peça final.3mf');
  const long = safeFileName('a'.repeat(400) + '.stl');
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('.stl'));
});

test('executables are blocked by extension, even disguised, and by content', () => {
  for (const name of ['setup.exe', 'SETUP.EXE', 'a.pdf.bat', 'x.ps1', 'run.sh', 'virus.exe.', 'virus.exe   ', 'pasta/app.msi', 'a.lnk', 'b.js']) assert.ok(hasBlockedExtension(name), name);
  for (const name of ['peca.stl', 'modelo.3mf', 'nota.pdf', 'foto.jpeg', 'semextensao', 'exe', 'a.exe.pdf']) assert.ok(!hasBlockedExtension(name), name);
  for (const head of ['4d5a9000', '7f454c46', 'cffaedfe', 'cafebabe', '2321']) assert.ok(hasExecutableSignature(Buffer.from(head, 'hex')), head);
  for (const head of ['25504446', '89504e47', '504b0304', '', '4d']) assert.ok(!hasExecutableSignature(Buffer.from(head, 'hex')), head);
});

test('purchase documents accept PDF, images and XML, with content matching the extension', () => {
  assert.equal(purchaseDocumentLimit, 20 * 1024 * 1024);
  for (const name of ['nota.PDF', 'foto.jpg', 'foto.jpeg', 'a.png', 'a.webp', 'a.gif', 'a.tif', 'a.tiff', 'nfe.xml']) assert.ok(hasDocumentExtension(name), name);
  for (const name of ['a.svg', 'a.html', 'a.zip', 'a.docx', 'semextensao', 'pdf', 'a.pdf.exe']) assert.ok(!hasDocumentExtension(name), name);
  const accepted = [['a.pdf', '25504446'], ['a.png', '89504e47'], ['a.jpg', 'ffd8ffe0'], ['a.webp', '52494646'], ['a.gif', '47494638'], ['a.tif', '49492a00'], ['a.tiff', '4d4d002a'],
    ['a.xml', '3c3f786d'], ['a.xml', 'efbbbf3c'], ['a.xml', '0a203c6e'], ['a.xml', 'fffe3c00']];
  for (const [name, head] of accepted) assert.ok(matchesDocumentContent(name, Buffer.from(head, 'hex')), name + ' ' + head);
  const refused = [['a.pdf', '89504e47'], ['a.png', '25504446'], ['a.jpg', '4d5a9000'], ['a.xml', '25504446'], ['a.xml', '20202020'], ['a.pdf', ''], ['a.svg', '3c737667']];
  for (const [name, head] of refused) assert.ok(!matchesDocumentContent(name, Buffer.from(head, 'hex')), name + ' ' + head);
});

test('the declared type and the download header cannot inject anything', () => {
  assert.equal(safeMimeType('application/pdf; charset=x'), 'application/pdf');
  assert.equal(safeMimeType('text/html\r\nX: y'), 'application/octet-stream');
  assert.equal(safeMimeType(undefined), 'application/octet-stream');
  const header = attachmentHeader('Peça "final"\r\n.pdf');
  assert.ok(header.startsWith('attachment; filename="'));
  assert.ok(!/[\r\n]/.test(header));
  assert.ok(header.includes("filename*=UTF-8''Pe%C3%A7a"));
});

test('the storage refuses keys outside its format and has no default folder', async () => {
  const previous = process.env.FILE_STORAGE_DIR;
  delete process.env.FILE_STORAGE_DIR;
  assert.throws(() => storageRoot(), /não está configurado/);
  if (previous !== undefined) process.env.FILE_STORAGE_DIR = previous;
  await withRoot(async root => {
    const storage = new DiskFileStorage();
    for (const key of ['../fora', '..\\fora', 'ab/../../fora', join(root, 'x')]) await assert.rejects(() => storage.open(key), /inválida/);
    assert.equal(await storage.open(newStorageKey()), null);
  });
});

test('the storage saves, reads and removes a file, and only clears old temporaries', async () => withRoot(async root => {
  const storage = new DiskFileStorage();
  const folder = join(root, '.tmp');
  await require('node:fs/promises').mkdir(folder);
  const temporary = join(folder, 'envio.part');
  await writeFile(temporary, 'conteudo');
  const { sha256, head } = await storage.inspect(temporary);
  assert.equal(sha256, require('node:crypto').createHash('sha256').update('conteudo').digest('hex'));
  assert.equal(head.toString(), 'conteudo');
  const key = newStorageKey();
  await storage.save(temporary, key);
  assert.deepEqual(await readdir(folder), []);
  const chunks = [];
  for await (const chunk of await storage.open(key)) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'conteudo');
  await storage.remove(key);
  assert.equal(await storage.open(key), null);

  await writeFile(join(folder, 'recente.part'), 'x');
  await storage.removeTemporaries(60_000);
  assert.deepEqual(await readdir(folder), ['recente.part']);
  await storage.removeTemporaries(-1000);
  assert.deepEqual(await readdir(folder), []);
  const outside = join(root, 'fora.txt');
  await writeFile(outside, 'x');
  await storage.discard(outside);
  assert.ok(await stat(outside));
}));

test('the upload goes to disk under a generated name, within the limit', async () => withRoot(async root => {
  class Probe {
    receive(file) { return { name: file.originalname, stored: file.filename, path: file.path, inMemory: file.buffer !== undefined, size: file.size }; }
  }
  const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'receive');
  UploadedFile()(Probe.prototype, 'receive', 0);
  Reflect.decorate([Post('upload'), FileUpload(1024)], Probe.prototype, 'receive', descriptor);
  Reflect.decorate([Controller()], Probe);
  class ProbeModule {}
  Reflect.decorate([Module({ controllers: [Probe] })], ProbeModule);
  const app = await NestFactory.create(ProbeModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const url = await app.getUrl();
    const send = (bytes, name) => {
      const body = new FormData();
      body.append('file', new Blob([bytes]), name);
      return fetch(url + '/upload', { method: 'POST', body });
    };
    const temporaries = () => readdir(join(root, '.tmp')).catch(() => []);

    const accepted = await send(Buffer.alloc(1024, 1), '../../Peça.stl');
    assert.equal(accepted.status, 201);
    const data = await accepted.json();
    assert.equal(data.inMemory, false);
    assert.equal(data.size, 1024);
    assert.equal(data.name, 'Peça.stl');
    assert.match(data.stored, /^[0-9a-f-]{36}\.part$/);
    assert.equal(join(root, '.tmp', data.stored), data.path);
    await rm(data.path);

    const tooLarge = await send(Buffer.alloc(1025, 1), 'grande.stl');
    assert.equal(tooLarge.status, 413);
    assert.match((await tooLarge.json()).message, /limite de/);
    assert.deepEqual(await temporaries(), [], 'o envio recusado não deixa temporário');

    const blocked = await send(Buffer.from('MZ'), 'setup.exe');
    assert.equal(blocked.status, 415);
    assert.deepEqual(await temporaries(), []);
  } finally {
    await app.close();
  }
}));
