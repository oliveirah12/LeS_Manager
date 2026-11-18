import { createPrivateKey, KeyObject, X509Certificate } from 'node:crypto';
import {
  BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { auditChange } from '../audit/recorder';
import { Database } from '../shared';
import { open, seal, VaultError } from '../vault';
import { BankReader } from './bank';
import { BankProvider } from './providers';

export const connectionFields = z.object({
  provider: z.string().optional(),
  environment: z.enum(['sandbox', 'production']),
  clientId: z.string().trim().min(1, 'Informe o Client ID').max(200),
  // Blank keeps the saved secret, so the certificate can be replaced alone.
  secret: z.string().trim().max(500).optional().transform(value => value || undefined),
  account: z.string().trim().max(40).optional().transform(value => value || null),
});
type ConnectionFields = z.infer<typeof connectionFields>;
export type ConnectionFiles = { certificate?: Buffer; privateKey?: Buffer };

const environmentName = (environment: string) => environment === 'production' ? 'Produção' : 'Sandbox';
const day = (date: Date) => date.toISOString().slice(0, 10);

/** Turns vault failures, such as a missing CONFIG_ENCRYPTION_KEY, into a clear answer for the panel. */
function unsealed<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof VaultError) throw new ServiceUnavailableException(error.message);
    throw error;
  }
}

/** Checks that the PEM texts form a valid, current pair and returns what the panel shows about the certificate. */
export function inspectCertificate(certificate: string, privateKey: string, now = new Date()) {
  let parsed: X509Certificate;
  let key: KeyObject;
  try { parsed = new X509Certificate(certificate); } catch {
    throw new BadRequestException('O arquivo do certificado não é um certificado PEM válido.');
  }
  try { key = createPrivateKey(privateKey); } catch {
    throw new BadRequestException('O arquivo da chave não é uma chave privada PEM válida. Envie a chave sem senha.');
  }
  if (!parsed.checkPrivateKey(key)) throw new BadRequestException('A chave privada não corresponde ao certificado.');
  const expires = new Date(parsed.validTo);
  if (!(expires > now)) throw new BadRequestException('O certificado venceu em ' + day(expires) + '. Gere um novo no portal do banco.');
  return { expires, subject: commonName(parsed) };
}

@Injectable()
export class BankConnectionService {
  // One reader per provider, replaced whenever the saved configuration changes.
  private readers = new Map<string, { version: number; reader: BankReader }>();
  constructor(@Inject(Database) private db: Database) {}

  /** What the panel shows. Secrets and the private key never leave the server. */
  async describe(provider: BankProvider) {
    const row = await this.db.bankConnection.findUnique({ where: { provider: provider.id }, include: { updatedBy: { select: { name: true } } } });
    if (!row) return { provider: provider.id, configured: false as const };
    return {
      provider: provider.id, configured: true as const, environment: row.environment, clientId: row.clientId, account: row.account,
      certificate: { subject: commonName(new X509Certificate(row.certificate)), expiresAt: row.certificateExpires },
      updatedAt: row.updatedAt, updatedBy: row.updatedBy.name,
    };
  }

  async save(provider: BankProvider, data: ConnectionFields, files: ConnectionFiles, userId: string) {
    const current = await this.db.bankConnection.findUnique({ where: { provider: provider.id } });
    const certificate = files.certificate?.toString('utf8') ?? current?.certificate;
    const privateKey = files.privateKey?.toString('utf8') ?? (current ? unsealed(() => open(current.privateKey, provider.id)) : undefined);
    const secret = data.secret ?? (current ? unsealed(() => open(current.secret, provider.id)) : undefined);
    if (!certificate || !privateKey) throw new BadRequestException('Envie o certificado e a chave privada.');
    if (!secret) throw new BadRequestException('Informe o Client Secret.');
    const inspected = inspectCertificate(certificate, privateKey);
    const values = {
      environment: data.environment, clientId: data.clientId, account: data.account, certificate,
      certificateExpires: inspected.expires, updatedById: userId,
      secret: unsealed(() => seal(secret, provider.id)), privateKey: unsealed(() => seal(privateKey, provider.id)),
    };
    // Only readable facts go to the audit trail: never the secret, the key or the certificate itself.
    const described = (row: { environment: string; clientId: string; account: string | null; certificateExpires: Date }) => ({
      Ambiente: environmentName(row.environment), 'Client ID': row.clientId, Conta: row.account, 'Certificado vence em': day(row.certificateExpires),
    });
    auditChange(current ? { ...described(current), 'Client Secret': 'configurado', 'Chave privada': 'configurada' } : null, {
      ...described(values),
      'Client Secret': current && data.secret ? 'alterado' : 'configurado',
      'Chave privada': current && files.privateKey ? 'alterada' : 'configurada',
    });
    await this.db.bankConnection.upsert({ where: { provider: provider.id }, create: { provider: provider.id, ...values }, update: values });
    this.readers.delete(provider.id);
    return this.describe(provider);
  }

  /** The reader built from the saved credentials, reused until the configuration changes. */
  async reader(provider: BankProvider) {
    const row = await this.db.bankConnection.findUnique({ where: { provider: provider.id } });
    if (!row) throw new ConflictException('Configure a integração em Financeiro → Integração.');
    const cached = this.readers.get(provider.id);
    if (cached?.version === row.updatedAt.getTime()) return cached.reader;
    const reader = provider.connect({
      environment: row.environment, clientId: row.clientId, account: row.account, certificate: row.certificate,
      secret: unsealed(() => open(row.secret, provider.id)), privateKey: unsealed(() => open(row.privateKey, provider.id)),
    });
    this.readers.set(provider.id, { version: row.updatedAt.getTime(), reader });
    return reader;
  }

  /** Reads the balance to confirm that credentials and certificate work. */
  async test(provider: BankProvider) {
    const bank = await this.reader(provider);
    try {
      await bank.balance();
    } catch (error) {
      throw new BadGatewayException('O banco recusou a conexão: ' + (error as Error).message + '. Confira o ambiente, as credenciais e o certificado.');
    }
    return { ok: true };
  }
}

/** The holder's name (CN), or the whole subject when the certificate has no CN. */
function commonName(certificate: X509Certificate) {
  return certificate.subject.split('\n').find(line => line.startsWith('CN='))?.slice(3) ?? certificate.subject;
}
