import { AsyncLocalStorage } from 'node:async_hooks';
import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { concatMap, Observable } from 'rxjs';
import { DailyTask, Database, idField } from '../shared';

export const AUDIT = 'audit';
/** Records the route in the audit trail under a stable label, or `false` to keep it out deliberately. */
export const Audit = (action: string | false) => SetMetadata(AUDIT, action);

type Value = string | number | boolean | null | string[];
export type AuditValues = Record<string, Value>;
type Actor = { id: string; name: string };
type AuditRecord = {
  id: string; targetId?: string; actor?: Actor;
  before?: AuditValues; after?: AuditValues; context?: AuditValues; finalized?: boolean;
};

const storage = new AsyncLocalStorage<AuditRecord>();
const retentionDays = () => Math.max(1, Number(process.env.AUDIT_RETENTION_DAYS ?? 365) || 365);

function normalize(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
    value instanceof Prisma.Decimal ? value.toFixed() : value instanceof Date ? value.toISOString() : (value ?? null) as Value]));
}

/** Adds values before and after the change. Repeated keys keep the latest attempt. */
export function auditChange(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const record = storage.getStore();
  if (!record) return;
  if (before) record.before = { ...record.before, ...normalize(before) };
  if (after) record.after = { ...record.after, ...normalize(after) };
}

/** Adds identifying context that stays in the event even when the operation fails. Never pass secrets. */
export function auditContext(values: Record<string, unknown>) {
  const record = storage.getStore();
  if (record) record.context = { ...record.context, ...normalize(values) };
}

export function auditActor(actor: Actor) {
  const record = storage.getStore();
  if (record) record.actor = { id: actor.id, name: actor.name };
}

export function auditTarget(targetId: string) {
  const record = storage.getStore();
  if (record) record.targetId = targetId;
}

function changes(record: AuditRecord, status: number) {
  const before = status < 400 ? record.before : undefined;
  let after = status < 400 ? record.after : undefined;
  if (before && after) {
    const changed = (key: string) => JSON.stringify(before[key]) !== JSON.stringify(after![key]);
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(changed);
    // A key missing from `before` was created by this operation, so it has no previous value to show.
    return { before: Object.fromEntries(keys.filter(key => key in before).map(key => [key, before[key]])),
      after: Object.fromEntries(keys.map(key => [key, after![key] ?? null])), context: record.context };
  }
  if (!before && !after && !record.context) return undefined;
  return { before, after, context: record.context };
}

/** Opens the event before authorization so denied attempts are also recorded. Fails closed. */
export async function beginAudit(db: Database, context: ExecutionContext, action: string) {
  const request = context.switchToHttp().getRequest<Request & { identity?: Actor }>();
  const response = context.switchToHttp().getResponse<Response>();
  const param = request.params?.id;
  const targetId = typeof param === 'string' && idField.safeParse(param).success ? param.toLowerCase() : undefined;
  const { id } = await db.auditEvent.create({ data: { action, targetId }, select: { id: true } });
  const record: AuditRecord = { id, targetId };
  response.locals.audit = record;

  async function finalize(status: number, result?: unknown) {
    if (record.finalized) return;
    record.finalized = true;
    const actor = request.identity ?? record.actor;
    const resultId = result && typeof result === 'object' && 'id' in result ? idField.safeParse(result.id) : undefined;
    const details = changes(record, status);
    await db.auditEvent.update({
      where: { id },
      data: {
        status, completedAt: new Date(), actorId: actor?.id, actorName: actor?.name,
        targetId: record.targetId ?? (resultId?.success ? resultId.data : undefined),
        details: details as Prisma.InputJsonValue | undefined,
      },
    }).catch(() => console.error('Falha ao concluir evento de auditoria.'));
  }
  response.locals.finalizeAudit = finalize;
  response.once('finish', () => { void finalize(response.statusCode); });
  response.once('close', () => { void finalize(499); });
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const response = context.switchToHttp().getResponse<Response>();
    const record = response.locals.audit as AuditRecord | undefined;
    const finalize = response.locals.finalizeAudit as ((status: number, result: unknown) => Promise<void>) | undefined;
    if (!record || !finalize) return next.handle();
    // The handler runs inside the audit context so services can describe their changes.
    return new Observable(subscriber => storage.run(record, () => next.handle().subscribe(subscriber)))
      .pipe(concatMap(result => finalize(response.statusCode, result).then(() => result)));
  }
}

@Injectable()
export class AuditRetention extends DailyTask {
  constructor(@Inject(Database) private db: Database) { super(); }

  protected async run() {
    const limit = new Date(Date.now() - retentionDays() * 24 * 60 * 60 * 1000);
    await this.db.auditEvent.deleteMany({ where: { createdAt: { lt: limit } } })
      .catch(() => console.error('Falha ao aplicar a retenção da auditoria.'));
  }
}
