import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const emailField = z.email().max(254).transform(value => value.toLowerCase());
export const passwordField = z.string().max(128).refine(value =>
  Array.from(value).length >= 8 && /\p{L}/u.test(value) && /\p{Nd}/u.test(value),
  'A senha deve ter pelo menos 8 caracteres, com letra e número.',
);
export const activationFields = z.object({
  email: emailField,
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{32}$/),
  password: passwordField,
  confirmation: z.string().max(128),
}).refine(data => data.password === data.confirmation, { path: ['confirmation'], message: 'As senhas precisam ser iguais.' });
export const passwordChangeFields = z.object({
  currentPassword: z.string().min(1).max(128),
  password: passwordField,
  confirmation: z.string().max(128),
}).refine(data => data.password === data.confirmation, { path: ['confirmation'], message: 'As senhas precisam ser iguais.' });

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(24).toString('base64url');

export async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const key = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 16384, r: 8, p: 5 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
  return salt + ':' + key.toString('hex');
}

export async function verifyPassword(password: string, hash: string | null) {
  const dummy = '0'.repeat(32) + ':' + '0'.repeat(128);
  const [salt] = (hash ?? dummy).split(':');
  const candidate = await hashPassword(password, salt);
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(hash ?? dummy)) && hash !== null;
}

export const modules = ['catalog', 'registrations', 'stock', 'finance', 'production', 'purchases'] as const;
/** production:correct stands alone: operating production never implies it, and only admin has it by default. */
export const standalonePermissions = ['production:correct'];
export const configurablePermissions = [...modules.flatMap(module => [module + ':view', module + ':operate']), ...standalonePermissions];
export const administrator = 'admin';

export function canAccess(permissions: string[], permission: string) {
  return permissions.includes(administrator) || permissions.includes(permission) ||
    (permission.endsWith(':view') && permissions.includes(permission.replace(':view', ':operate')));
}
