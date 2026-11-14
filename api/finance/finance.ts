import { createHash } from 'node:crypto';
import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable, Post, Query, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Authenticated, Require } from '../access/access';
import { Audit, auditChange, auditContext, auditTarget } from '../audit/recorder';
import { Database, parse, serial } from '../shared';
import { BankEntry, BankReader } from './bank';
import { BankProvider, bankProvider, providers } from './providers';

const providerFields = z.object({ provider: z.string().optional() });
const rangeFields = providerFields.extend({ from: z.iso.date(), to: z.iso.date() });
const reconciliationFields = providerFields.extend({
  date: z.iso.date(), key: z.string().regex(/^[a-f0-9]{64}$/), matched: z.boolean(),
  reference: z.string().trim().max(160).optional(),
});
type Range = Pick<z.infer<typeof rangeFields>, 'from' | 'to'>;
type Reconciliation = z.infer<typeof reconciliationFields>;

function dateRange(input: unknown) {
  const range = parse(rangeFields, input);
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86400000;
  if (days < 0 || days >= 90) throw new BadRequestException('Selecione um período de até 90 dias.');
  return range;
}

export function groupByDay(range: Range, entries: BankEntry[]) {
  const days = new Map<string, BankEntry[]>();
  for (let date = Date.parse(range.from); date <= Date.parse(range.to); date += 86400000) {
    days.set(new Date(date).toISOString().slice(0, 10), []);
  }
  for (const entry of entries) {
    const rows = days.get(entry.date);
    if (!rows) throw new Error('Lançamento fora do período.');
    rows.push(entry);
  }
  return days;
}

function statementKeys(entries: BankEntry[]) {
  const occurrences = new Map<string, number>();
  for (const entry of entries) if (entry.id) occurrences.set(entry.id, (occurrences.get(entry.id) ?? 0) + 1);
  // Only IDs known to distinguish a transaction survive refresh as reconciliation keys.
  return entries.map(entry => entry.id && occurrences.get(entry.id) === 1
    ? createHash('sha256').update(entry.id).digest('hex') : null);
}

function readEntries(entries: Prisma.JsonValue) {
  return entries as unknown as BankEntry[];
}

@Injectable()
export class FinanceService {
  private readers = new Map<string, BankReader>();
  private refreshing = new Set<string>();
  constructor(@Inject(Database) private db: Database) {}

  async balance(provider = bankProvider().id) {
    return { balance: await this.db.bankBalance.findUnique({ where: { provider } }) };
  }

  async view(range: Range, provider = bankProvider().id) {
    return this.db.$transaction(async tx => {
      const balance = await tx.bankBalance.findUnique({ where: { provider } });
      const date = { gte: range.from, lte: range.to };
      const days = await tx.bankDay.findMany({ where: { provider, date }, orderBy: { date: 'desc' } });
      const reconciled = await tx.bankReconciliation.findMany({
        where: { provider, date }, select: { date: true, key: true, reference: true, updatedAt: true },
      });
      const byKey = new Map(reconciled.map(row => [row.date + ':' + row.key, row]));
      const transactions = days.flatMap(day => {
        const entries = readEntries(day.entries);
        const keys = statementKeys(entries);
        return entries.map((entry, index) => {
          const key = keys[index];
          return { ...entry, key, reconciliation: byKey.get(day.date + ':' + key) ?? null };
        });
      });
      return {
        balance, transactions, importedDays: days.length,
        requestedDays: (Date.parse(range.to) - Date.parse(range.from)) / 86400000 + 1,
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async reconcile(provider: string, data: Reconciliation, userId: string) {
    const { date, key, matched, reference } = data;
    return serial(this.db, async tx => {
      const day = await tx.bankDay.findUnique({ where: { provider_date: { provider, date } } });
      if (!day || !statementKeys(readEntries(day.entries)).includes(key)) {
        throw new ConflictException('Lançamento indisponível para conciliação. Atualize o extrato.');
      }
      const where = { provider, date, key };
      const before = await tx.bankReconciliation.findUnique({ where: { provider_date_key: where } });
      auditChange({ Conferido: before !== null, 'Referência': before?.reference ?? null },
        { Conferido: matched, 'Referência': matched ? reference || null : null });
      if (matched) {
        await tx.bankReconciliation.upsert({
          where: { provider_date_key: where },
          create: { ...where, userId, reference: reference || null },
          update: { userId, reference: reference || null },
        });
      } else {
        await tx.bankReconciliation.deleteMany({ where });
      }
      return { ok: true };
    });
  }

  async refresh(range: Range, source: BankProvider) {
    const { id: provider } = source;
    if (this.refreshing.has(provider)) throw new ConflictException('Já existe uma atualização em andamento para este provedor.');
    this.refreshing.add(provider);
    const startedAt = new Date();
    try {
      let balance: string;
      let days: Map<string, BankEntry[]>;
      try {
        let bank = this.readers.get(provider);
        if (!bank) { bank = source.open(); this.readers.set(provider, bank); }
        balance = await bank.balance();
        days = groupByDay(range, await bank.statement(range.from, range.to));
      } catch {
        throw new BadGatewayException('Não foi possível consultar o provedor. Confira a configuração e tente novamente. Os dados salvos foram mantidos.');
      }
      const updatedAt = new Date();
      await serial(this.db, async tx => {
        const previous = await tx.bankBalance.findUnique({ where: { provider } });
        if (!previous || previous.updatedAt <= startedAt) {
          await tx.bankBalance.upsert({
            where: { provider }, create: { provider, available: balance, updatedAt }, update: { available: balance, updatedAt },
          });
        }
        const newerDays = await tx.bankDay.findMany({
          where: { provider, date: { gte: range.from, lte: range.to }, updatedAt: { gt: startedAt } },
          select: { date: true },
        });
        const skip = new Set(newerDays.map(day => day.date));
        for (const [date, entries] of days) {
          if (skip.has(date)) continue;
          await tx.bankDay.upsert({
            where: { provider_date: { provider, date } }, create: { provider, date, entries, updatedAt }, update: { entries, updatedAt },
          });
        }
      });
      return this.view(range, provider);
    } finally {
      this.refreshing.delete(provider);
    }
  }
}

@Controller('finance')
export class FinanceController {
  constructor(@Inject(FinanceService) private finance: FinanceService) {}

  @Require('finance:view')
  @Get('providers')
  providers() { return providers.map(({ id, name }) => ({ id, name })); }

  @Require('finance:view')
  @Get('balance')
  balance(@Query() query: unknown) { return this.finance.balance(bankProvider(parse(providerFields, query).provider).id); }

  @Require('finance:view')
  @Get()
  view(@Query() query: unknown) {
    const range = dateRange(query);
    return this.finance.view(range, bankProvider(range.provider).id);
  }

  @Require('finance:operate')
  @Audit('Sincronizar dados bancários')
  @Post('refresh')
  refresh(@Body() body: unknown) {
    const range = dateRange(body);
    auditContext({ Provedor: bankProvider(range.provider).name, De: range.from, 'Até': range.to });
    return this.finance.refresh(range, bankProvider(range.provider));
  }

  @Require('finance:operate')
  @Audit('Alterar conciliação bancária')
  @Post('reconciliation')
  reconcile(@Req() request: Authenticated, @Body() body: unknown) {
    const data = parse(reconciliationFields, body);
    const provider = bankProvider(data.provider).id;
    auditTarget([provider, data.date, data.key].join(':'));
    return this.finance.reconcile(provider, data, request.identity.id);
  }
}
