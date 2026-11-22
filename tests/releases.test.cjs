const assert = require('node:assert/strict');
const { test } = require('node:test');
const { require: load } = require('tsx/cjs/api');
const { currentVersion, releases } = load('../web/releases.ts', __filename);
const { version } = require('../package.json');

test('every version has its notes, and the newest one is the version in package.json', () => {
  assert.equal(currentVersion, version);
  assert.equal(new Set(releases.map(release => release.version)).size, releases.length);
  for (const release of releases) {
    assert.match(release.version, /^\d+\.\d+\.\d+$/);
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(release.title.trim());
    assert.ok(release.changes.length);
  }
});

test('only real JPG, PNG and WebP files are accepted as product images', () => {
  const { hasImageExtension, imageType, matchesImageContent } = require('../dist/api/files/rules.js');
  const webp = Buffer.from('52494646000000005745425056503820', 'hex');
  assert.ok(matchesImageContent('foto.PNG', Buffer.from('89504e47', 'hex')));
  assert.ok(matchesImageContent('foto.jpg', Buffer.from('ffd8ffe0', 'hex')));
  assert.ok(matchesImageContent('foto.webp', webp));
  assert.ok(!matchesImageContent('foto.png', Buffer.from('ffd8ffe0', 'hex')));
  assert.ok(!matchesImageContent('foto.webp', Buffer.from('52494646000000005741564500000000', 'hex')));
  assert.ok(!hasImageExtension('desenho.svg'));
  assert.equal(imageType('foto.jpeg'), 'image/jpeg');
});
