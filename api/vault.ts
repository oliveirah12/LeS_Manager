import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts secrets kept in the database, such as bank credentials, with AES-256-GCM.
 * The master key comes from CONFIG_ENCRYPTION_KEY and never reaches the database, so a leaked
 * backup alone does not reveal the secrets. GCM also rejects any altered ciphertext.
 */
const version = 'v1';
const keyHelp = 'Defina CONFIG_ENCRYPTION_KEY com 32 bytes em base64. Gere com: ' +
  'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"';

export class VaultError extends Error {}

function masterKey() {
  const value = process.env.CONFIG_ENCRYPTION_KEY?.trim();
  const key = value ? Buffer.from(value, 'base64') : undefined;
  if (!key || key.length !== 32) throw new VaultError(keyHelp);
  return key;
}

/**
 * Encrypts the text. The context, such as the provider id, is authenticated but not stored,
 * so a value copied to another record does not decrypt there.
 */
export function seal(text: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [version, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Decrypts a value from seal. Fails for another key, another context or any change to the value. */
export function open(sealed: string, context: string) {
  const [prefix, iv, tag, data] = sealed.split(':');
  if (prefix !== version || !iv || !tag || data === undefined) throw new VaultError('Segredo em formato desconhecido.');
  const key = masterKey();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new VaultError('Não foi possível abrir o segredo. Confira a CONFIG_ENCRYPTION_KEY ou salve a integração de novo.');
  }
}
