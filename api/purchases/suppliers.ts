import { Body, ConflictException, Controller, Delete, Get, Inject, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { Supplier } from '@prisma/client';
import { z } from 'zod';
import { Require } from '../access/access';
import { Audit, auditChange } from '../audit/recorder';
import { Database, idField, nameField, parse, serial } from '../shared';
import { supplierDocumentField } from './rules';

const blankToNull = (value: unknown) => typeof value === 'string' && !value.trim() ? null : value;
export const supplierFields = z.object({
  name: nameField,
  document: z.preprocess(blankToNull, supplierDocumentField.nullable()).default(null),
  contact: z.preprocess(blankToNull, z.string().trim().max(160).nullable()).default(null),
  active: z.boolean().default(true),
});
// Saving an edit states the situation, so a partial request never reactivates an inactive supplier.
export const supplierUpdateFields = supplierFields.extend({ active: z.boolean() });
type SupplierData = z.infer<typeof supplierFields>;

const usage = { _count: { select: { purchases: true, lastProducts: true, undoItems: true } } } as const;
const values = (supplier: Pick<Supplier, 'name' | 'document' | 'contact' | 'active'>) => ({
  Nome: supplier.name, 'CPF/CNPJ': supplier.document, Contato: supplier.contact, Situação: supplier.active ? 'Ativo' : 'Inativo',
});

@Injectable()
export class SupplierService {
  constructor(@Inject(Database) private db: Database) {}

  async list() {
    const rows = await this.db.supplier.findMany({ include: usage, orderBy: { name: 'asc' } });
    return rows.map(({ _count, ...supplier }) => ({
      ...supplier, purchases: _count.purchases,
      deleteBlock: _count.purchases || _count.lastProducts || _count.undoItems ? 'O fornecedor tem histórico de compras. Inative-o para tirá-lo das listas.' : null,
    }));
  }

  async create(data: SupplierData) {
    const supplier = await this.db.supplier.create({ data });
    auditChange(null, values(supplier));
    return supplier;
  }

  update(id: string, data: SupplierData) {
    return serial(this.db, async tx => {
      const before = await tx.supplier.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Fornecedor não encontrado.');
      const supplier = await tx.supplier.update({ where: { id }, data });
      auditChange(values(before), values(supplier));
      return supplier;
    });
  }

  remove(id: string) {
    return serial(this.db, async tx => {
      const supplier = await tx.supplier.findUnique({ where: { id }, include: usage });
      if (!supplier) throw new NotFoundException('Fornecedor não encontrado.');
      const { purchases, lastProducts, undoItems } = supplier._count;
      if (purchases || lastProducts || undoItems) throw new ConflictException('O fornecedor tem histórico de compras. Inative-o para tirá-lo das listas.');
      await tx.supplier.delete({ where: { id } });
      auditChange(values(supplier), null);
      return { id };
    });
  }
}

@Controller('suppliers')
export class SupplierController {
  constructor(@Inject(SupplierService) private suppliers: SupplierService) {}

  @Require('registrations:view')
  @Get()
  list() { return this.suppliers.list(); }

  @Require('registrations:operate')
  @Audit('Cadastrar fornecedor')
  @Post()
  create(@Body() body: unknown) { return this.suppliers.create(parse(supplierFields, body)); }

  @Require('registrations:operate')
  @Audit('Alterar fornecedor')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) { return this.suppliers.update(parse(idField, id), parse(supplierUpdateFields, body)); }

  @Require('registrations:operate')
  @Audit('Excluir fornecedor')
  @Delete(':id')
  remove(@Param('id') id: string) { return this.suppliers.remove(parse(idField, id)); }
}
