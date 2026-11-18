// Test-only certificates, created at run time so no key is ever committed.
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** A self-signed certificate and its unencrypted private key, both as PEM text. */
function makeCertificate(name = 'LeS Teste') {
  const folder = mkdtempSync(join(tmpdir(), 'les-cert-'));
  try {
    const key = join(folder, 'key.pem');
    const cert = join(folder, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=' + name,
    ], { stdio: 'ignore' });
    return { certificate: readFileSync(cert, 'utf8'), privateKey: readFileSync(key, 'utf8') };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

module.exports = { hasOpenssl, makeCertificate };
