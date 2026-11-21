import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Require } from '../access/access';
import { Audit, auditChange } from '../audit/recorder';
import { Database, idField, nameField, nonnegative, parse, positive, serial } from '../shared';
import { printerHourCost } from '../stock/cost';

const settingsId = 'default';
const printerFields = z.object({
  name: nameField,
  powerWatts: positive.refine(value => value.lt('10000000000') && value.decimalPlaces() <= 2, 'Informe a potência com até 2 casas'),
  hourlyCost: nonnegative,
});
const rateFields = z.object({ energyRate: nonnegative });
const statusFields = z.strictObject({ active: z.boolean() });
type PrinterData = z.infer<typeof printerFields>;
const printerValues = (printer: { name: string; powerWatts: Prisma.Decimal; hourlyCost: Prisma.Decimal }) => ({
  Nome: printer.name, 'Potência (W)': printer.powerWatts.toFixed(), 'Custo por hora': printer.hourlyCost.toFixed(),
});
const situation = (active: boolean) => active ? 'Ativa' : 'Inativa';

@Injectable()
export class ProductionService {
  constructor(@Inject(Database) private db: Database) {}

  async printers() {
    const [settings, printers] = await Promise.all([
      this.db.productionSettings.findUniqueOrThrow({ where: { id: settingsId } }),
      this.db.printer.findMany({ orderBy: { name: 'asc' } }),
    ]);
    return {
      energyRate: settings.energyRate,
      printers: printers.map(printer => ({ ...printer, hourCost: printerHourCost(printer.powerWatts, settings.energyRate, printer.hourlyCost) })),
    };
  }

  savePrinter(data: PrinterData, id?: string) {
    return serial(this.db, async tx => {
      const before = id ? await tx.printer.findUnique({ where: { id } }) : null;
      if (id && !before) throw new NotFoundException('Impressora não encontrada.');
      auditChange(before && printerValues(before), printerValues(data));
      return id ? tx.printer.update({ where: { id }, data }) : tx.printer.create({ data });
    });
  }

  setPrinterActive(id: string, active: boolean) {
    return serial(this.db, async tx => {
      const printer = await tx.printer.findUnique({ where: { id } });
      if (!printer) throw new NotFoundException('Impressora não encontrada.');
      auditChange({ 'Situação': situation(printer.active) }, { 'Situação': situation(active) });
      await tx.printer.update({ where: { id }, data: { active } });
      return { id, active };
    });
  }

  deletePrinter(id: string) {
    return serial(this.db, async tx => {
      const printer = await tx.printer.findUnique({ where: { id } });
      if (!printer) throw new NotFoundException('Impressora não encontrada.');
      await tx.printer.delete({ where: { id } });
      auditChange(printerValues(printer), null);
      return { id };
    });
  }

  saveEnergyRate(energyRate: Prisma.Decimal) {
    return serial(this.db, async tx => {
      const before = await tx.productionSettings.findUniqueOrThrow({ where: { id: settingsId } });
      auditChange({ 'Tarifa (R$/kWh)': before.energyRate.toFixed() }, { 'Tarifa (R$/kWh)': energyRate.toFixed() });
      await tx.productionSettings.update({ where: { id: settingsId }, data: { energyRate } });
      return { energyRate };
    });
  }
}

@Controller('production')
export class ProductionController {
  constructor(@Inject(ProductionService) private production: ProductionService) {}

  @Require('production:view')
  @Get('printers')
  printers() { return this.production.printers(); }

  @Require('production:operate')
  @Audit('Criar impressora')
  @Post('printers')
  addPrinter(@Body() body: unknown) { return this.production.savePrinter(parse(printerFields, body)); }

  @Require('production:operate')
  @Audit('Alterar impressora')
  @Patch('printers/:id')
  updatePrinter(@Param('id') id: string, @Body() body: unknown) {
    return this.production.savePrinter(parse(printerFields, body), parse(idField, id));
  }

  @Require('production:operate')
  @Audit('Alterar situação da impressora')
  @Post('printers/:id/status')
  @HttpCode(200)
  printerStatus(@Param('id') id: string, @Body() body: unknown) {
    return this.production.setPrinterActive(parse(idField, id), parse(statusFields, body).active);
  }

  @Require('production:operate')
  @Audit('Excluir impressora')
  @Delete('printers/:id')
  removePrinter(@Param('id') id: string) { return this.production.deletePrinter(parse(idField, id)); }

  @Require('production:operate')
  @Audit('Alterar tarifa de energia')
  @Put('energy-rate')
  energyRate(@Body() body: unknown) { return this.production.saveEnergyRate(parse(rateFields, body).energyRate); }
}
