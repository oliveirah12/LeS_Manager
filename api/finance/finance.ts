import { BadGatewayException, BadRequestException, Body, Controller, Get, Inject, Injectable, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../access/access';
import { Database, parse, serial } from '../shared';
import { BankEntry, BankReader, InterReader } from './inter';

const provider = 'inter';
const rangeFields = z.object({ from: z.iso.date(), to: z.iso.date() });
type Range = z.infer<typeof rangeFields>;

function dateRange(input: unknown): Range {
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
    // Replace each complete day, preserving even identical bank rows.
    rows.push(entry);
  }
  return days;
}

@Injectable()
export class FinanceService {
  private reader?: BankReader;
  private refreshing = false;
  constructor(@Inject(Database) private db: Database) {}

  async balance() {
    return { balance: await this.db.bankBalance.findUnique({ where: { provider } }) };
  }

  async view(range: Range) {
    return this.db.$transaction(async tx => {
      const balance = await tx.bankBalance.findUnique({ where: { provider } });
      const days = await tx.bankDay.findMany({
        where: { provider, date: { gte: range.from, lte: range.to } }, orderBy: { date: 'desc' },
      });
      return {
        balance,
        transactions: days.flatMap(day => day.entries as unknown as BankEntry[]),
        importedDays: days.length,
        requestedDays: (Date.parse(range.to) - Date.parse(range.from)) / 86400000 + 1,
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async refresh(range: Range, reader?: BankReader) {
    if (this.refreshing) throw new BadRequestException('Já existe uma atualização em andamento.');
    this.refreshing = true;
    const startedAt = new Date();
    try {
      let balance: string;
      let days: Map<string, BankEntry[]>;
      try {
        const bank = reader ?? (this.reader ??= InterReader.fromEnv());
        balance = await bank.balance();
        days = groupByDay(range, await bank.statement(range.from, range.to));
      } catch {
        throw new BadGatewayException('Não foi possível consultar o Inter. Confira a configuração e tente novamente. Os dados salvos foram mantidos.');
      }
      const updatedAt = new Date();
      await serial(this.db, async tx => {
        const previous = await tx.bankBalance.findUnique({ where: { provider } });
        if (previous && previous.updatedAt > startedAt) return;
        await tx.bankBalance.upsert({
          where: { provider }, create: { provider, available: balance, updatedAt }, update: { available: balance, updatedAt },
        });
        for (const [date, entries] of days) {
          await tx.bankDay.upsert({
            where: { provider_date: { provider, date } }, create: { provider, date, entries, updatedAt }, update: { entries, updatedAt },
          });
        }
      });
      return this.view(range);
    } finally {
      this.refreshing = false;
    }
  }
}

@Controller('finance')
export class FinanceController {
  constructor(@Inject(FinanceService) private finance: FinanceService) {}

  @Require('finance:view')
  @Get('balance')
  balance() { return this.finance.balance(); }

  @Require('finance:view')
  @Get()
  view(@Query() query: unknown) { return this.finance.view(dateRange(query)); }

  @Require('finance:operate')
  @Post('refresh')
  refresh(@Body() body: unknown) { return this.finance.refresh(dateRange(body)); }
}
