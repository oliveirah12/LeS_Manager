import { PrismaClient } from '@prisma/client';
import { emailField, hashToken, newToken } from './access/security';

async function main() {
  const name = process.argv[2]?.trim();
  const email = emailField.safeParse(process.argv[3]);
  if (!name || !email.success) throw new Error('Uso: npm run admin:create -- "Nome" email@empresa.com');
  const db = new PrismaClient();
  try {
    const code = newToken();
    const activationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.$transaction(async tx => {
      const profile = await tx.profile.upsert({
        where: { name: 'Administrador' },
        create: { name: 'Administrador', permissions: ['admin'] },
        update: {},
      });
      if (!profile.permissions.includes('admin')) throw new Error('O nome Administrador está reservado.');
      const existing = await tx.user.findUnique({ where: { email: email.data } });
      if (existing && (existing.profileId !== profile.id || !existing.active || existing.passwordHash)) {
        throw new Error('O e-mail já pertence a uma conta que não pode ser reativada por este comando.');
      }
      const activation = { activationHash: hashToken(code), activationExpires };
      if (existing) await tx.user.update({ where: { id: existing.id }, data: activation });
      else await tx.user.create({ data: { name, email: email.data, profileId: profile.id, ...activation } });
    });
    console.log('E-mail:', email.data, '\nCódigo de primeiro acesso (24h):', code);
  } finally {
    await db.$disconnect();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
