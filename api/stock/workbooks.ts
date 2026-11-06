import { BadRequestException } from '@nestjs/common';
import { inflateRawSync } from 'node:zlib';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';

const formats = {
  initial: [
    ['SKU', 'sku'], ['Nome', 'name'], ['Unidade', 'unit'], ['Quantidade', 'quantity'], ['Custo', 'unitCost'],
    ['Grupo', 'group'], ['Marca', 'brand'], ['Cor', 'color'], ['Departamento', 'department'],
  ],
  inventory: [['SKU', 'sku'], ['Quantidade', 'quantity'], ['Unidade', 'unit']],
} as const;
export type WorkbookKind = keyof typeof formats;

export async function workbookTemplate(kind: WorkbookKind) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(kind === 'initial' ? 'Carga inicial' : 'Inventário');
  sheet.columns = formats[kind].map(([header, key]) => ({ header, key, width: 22, style: { numFmt: '@' } }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function workbookRows(kind: WorkbookKind, file?: Express.Multer.File) {
  if (!file || !file.originalname.toLowerCase().endsWith('.xlsx')) {
    throw new BadRequestException('Selecione um arquivo .xlsx.');
  }
  const workbook = new ExcelJS.Workbook();
  try {
    assertZipSize(file.buffer);
    await workbook.xlsx.load(file.buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new BadRequestException('Arquivo .xlsx inválido ou grande demais.');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount > 501 || sheet.columnCount > formats[kind].length) {
    throw new BadRequestException('Use o modelo e preencha até 500 linhas.');
  }
  const columns = formats[kind];
  for (const [index, [header]] of columns.entries()) {
    if (sheet.getRow(1).getCell(index + 1).text.trim() !== header) {
      throw new BadRequestException('Cabeçalho incorreto. Baixe o modelo desta operação.');
    }
  }
  const rows: Record<string, string>[] = [];
  for (let line = 2; line <= sheet.rowCount; line++) {
    const row = sheet.getRow(line);
    const values: Record<string, string> = {};
    for (const [index, [, key]] of columns.entries()) {
      const value = row.getCell(index + 1).value;
      if (value == null || value === '') continue;
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new BadRequestException('Use valores simples, sem fórmulas, na linha ' + line + '.');
      }
      const isDecimal = key === 'quantity' || key === 'unitCost';
      const text = typeof value === 'number' && isDecimal ? new Prisma.Decimal(value).toFixed() : String(value).trim();
      if (text) values[key] = text;
    }
    if (Object.keys(values).length) rows.push(values);
  }
  return { rows };
}

// Bound decompression before handing the uploaded ZIP to ExcelJS.
function assertZipSize(zip: Buffer) {
  const marker = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = zip.lastIndexOf(marker);
  if (end < 0 || end + 22 > zip.length || end + 22 + zip.readUInt16LE(end + 20) !== zip.length) throw new Error();
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const centralStart = offset;
  const maxExpanded = 8 * 1024 * 1024;
  let total = 0;
  if (count > 100 || zip.readUInt32LE(end + 12) + offset !== end) throw new Error();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) throw new Error();
    const expanded = zip.readUInt32LE(offset + 24);
    const compressed = zip.readUInt32LE(offset + 20);
    const method = zip.readUInt16LE(offset + 10);
    const local = zip.readUInt32LE(offset + 42);
    if (local + 30 > centralStart || zip.readUInt32LE(local) !== 0x04034b50 || total + expanded > maxExpanded) throw new Error();
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + compressed > centralStart) throw new Error();
    if (method === 0) {
      if (compressed !== expanded) throw new Error();
    } else if (method === 8) {
      const data = zip.subarray(start, start + compressed);
      if (inflateRawSync(data, { maxOutputLength: Math.max(1, expanded) }).length !== expanded) throw new Error();
    } else {
      throw new Error();
    }
    total += expanded;
    offset += 46 + zip.readUInt16LE(offset + 28) + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  if (offset !== end) throw new Error();
}
