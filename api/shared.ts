import {
  ArgumentsHost, BadRequestException, Catch, ConflictException, ExceptionFilter, Injectable, OnApplicationBootstrap, OnModuleDestroy,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

Prisma.Decimal.set({ precision: 64 });

@Injectable()
export class Database extends PrismaClient implements OnModuleDestroy {
  onModuleDestroy() { return this.$disconnect(); }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const messages = result.error.issues.map(issue => [issue.path.join('.'), issue.message].filter(Boolean).join(': '));
    throw new BadRequestException(messages);
  }
  return result.data;
}

export const nameField = z.string().trim().min(1, 'Informe um valor').max(160);
export const idField = z.uuid();
export const skuField = z.string().trim().min(1).max(64).transform(value => value.toUpperCase());
export const decimalField = z.string().trim().regex(/^[+-]?\d{1,18}(?:[.,]\d{1,12})?$/, 'Use um decimal com até 12 casas')
  .transform(value => new Prisma.Decimal(value.replace(',', '.')));
export const positive = decimalField.refine(value => value.gt(0), 'Informe um valor maior que zero');
export const nonnegative = decimalField.refine(value => value.gte(0), 'Informe um valor não negativo');
export const money = (value: Prisma.Decimal) => value.toDecimalPlaces(12);
export const storedDecimal = (value: Prisma.Decimal) => {
  if (value.decimalPlaces() > 12 || value.abs().gte('1000000000000000000')) {
    throw new BadRequestException('Valor fora da precisão do estoque');
  }
  return value;
};

/** Maintenance that runs when the API starts and then once a day. */
export abstract class DailyTask implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  protected abstract run(): Promise<void>;

  onApplicationBootstrap() {
    void this.run();
    this.timer = setInterval(() => void this.run(), 24 * 60 * 60 * 1000);
    this.timer.unref();
  }

  onModuleDestroy() { clearInterval(this.timer); }
}

/** Filter for calendar days in Brasília time, from the start of `from` to the end of `to`. */
export function dayRange(from?: string, to?: string) {
  if (!from && !to) return undefined;
  const start = (day: string) => new Date(day + 'T00:00:00-03:00');
  return {
    ...(from ? { gte: start(from) } : {}),
    ...(to ? { lt: new Date(start(to).getTime() + 86400000) } : {}),
  };
}

export async function serial<T>(db: Database, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: 'Serializable', timeout: 20000 });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034') throw error;
      if (attempt === 3) throw new ConflictException('Outra operação alterou estes dados. Tente novamente.');
    }
  }
}

@Catch(Prisma.PrismaClientKnownRequestError)
export class DatabaseErrors implements ExceptionFilter {
  catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (error.code === 'P2002') return response.status(409).json({ message: 'Já existe um registro com esses dados.' });
    if (error.code === 'P2003' || error.code === 'P2025') return response.status(409).json({ message: 'O registro relacionado não está disponível.' });
    if (error.code === 'P2020') return response.status(400).json({ message: 'Valor fora da precisão do banco.' });
    console.error('Erro do banco:', error.code);
    return response.status(500).json({ message: 'Falha ao gravar ou consultar dados.' });
  }
}
