import { Body, ConflictException, Controller, Delete, Get, Inject, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { z } from 'zod';
import { Require } from '../access/access';
import { Audit, auditChange } from '../audit/recorder';
import { Database, idField, nameField, parse, serial } from '../shared';
import { percentField } from './sale';

const blankToNull = (value: unknown) => typeof value === 'string' && !value.trim() ? null : value;
export const paymentFields = z.object({
  name: nameField,
  feePercent: z.preprocess(blankToNull, percentField.nullable()).default(null),
  active: z.boolean().default(true),
});
// Saving an edit states the situation, so a partial request never reactivates an inactive method.
export const paymentUpdateFields = paymentFields.extend({ active: z.boolean() });
type PaymentData = z.infer<typeof paymentFields>;

const usage = { _count: { select: { orders: true, quotes: true } } } as const;
const usedBlock = 'A forma de pagamento já foi usada em ordens de produção ou orçamentos. Inative-a para tirá-la das listas.';
const used = (count: { orders: number; quotes: number }) => count.orders + count.quotes > 0;
const values = (method: Pick<PaymentMethod, 'name' | 'feePercent' | 'active'>) => ({
  Nome: method.name, 'Taxa (%)': method.feePercent?.toFixed() ?? null, Situação: method.active ? 'Ativa' : 'Inativa',
});

@Injectable()
export class PaymentMethodService {
  constructor(@Inject(Database) private db: Database) {}

  async list() {
    const rows = await this.db.paymentMethod.findMany({ include: usage, orderBy: { name: 'asc' } });
    return rows.map(({ _count, ...method }) => ({ ...method, orders: _count.orders, deleteBlock: used(_count) ? usedBlock : null }));
  }

  async create(data: PaymentData) {
    const method = await this.db.paymentMethod.create({ data });
    auditChange(null, values(method));
    return method;
  }

  update(id: string, data: PaymentData) {
    return serial(this.db, async tx => {
      const before = await tx.paymentMethod.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Forma de pagamento não encontrada.');
      const method = await tx.paymentMethod.update({ where: { id }, data });
      auditChange(values(before), values(method));
      return method;
    });
  }

  remove(id: string) {
    return serial(this.db, async tx => {
      const method = await tx.paymentMethod.findUnique({ where: { id }, include: usage });
      if (!method) throw new NotFoundException('Forma de pagamento não encontrada.');
      if (used(method._count)) throw new ConflictException(usedBlock);
      await tx.paymentMethod.delete({ where: { id } });
      auditChange(values(method), null);
      return { id };
    });
  }
}

@Controller('payment-methods')
export class PaymentMethodController {
  constructor(@Inject(PaymentMethodService) private methods: PaymentMethodService) {}

  @Require('registrations:view')
  @Get()
  list() { return this.methods.list(); }

  @Require('registrations:operate')
  @Audit('Cadastrar forma de pagamento')
  @Post()
  create(@Body() body: unknown) { return this.methods.create(parse(paymentFields, body)); }

  @Require('registrations:operate')
  @Audit('Alterar forma de pagamento')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) { return this.methods.update(parse(idField, id), parse(paymentUpdateFields, body)); }

  @Require('registrations:operate')
  @Audit('Excluir forma de pagamento')
  @Delete(':id')
  remove(@Param('id') id: string) { return this.methods.remove(parse(idField, id)); }
}
