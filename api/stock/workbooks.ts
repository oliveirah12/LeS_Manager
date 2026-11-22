import { BadRequestException } from '@nestjs/common';
import { inflateRawSync } from 'node:zlib';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';

type Column = readonly [header: string, key: string];
const formats = {
  initial: [
    ['SKU', 'sku'], ['Nome', 'name'], ['Tipo', 'type'], ['Unidade', 'unit'], ['Quantidade', 'quantity'], ['Custo total', 'totalCost'], ['Perda (%)', 'wastePercent'],
    ['Grupo', 'group'], ['Marca', 'brand'], ['Cor', 'color'], ['Departamento', 'department'],
    ['Estoque mínimo', 'minStock'], ['Margem (%)', 'marginPercent'], ['Preço de venda', 'salePrice'],
    ['Comprimento (mm)', 'lengthMm'], ['Largura (mm)', 'widthMm'], ['Altura (mm)', 'heightMm'], ['Diâmetro (mm)', 'diameterMm'], ['URL de compra', 'purchaseUrl'],
    ['Data da compra', 'purchaseDate'], ['Fornecedor', 'supplier'], ['Despesas da compra', 'purchaseExpenses'],
  ],
  inventory: [['SKU', 'sku'], ['Quantidade', 'quantity'], ['Unidade', 'unit']],
} as const satisfies Record<string, readonly Column[]>;
export type WorkbookKind = keyof typeof formats;
/** Files made before the total cost keep their meaning: "Custo" is the cost per declared unit. */
const legacyCost: Column = ['Custo', 'unitCost'];
const recipeSheet = 'Ficha técnica';
const recipeColumns: readonly Column[] = [['SKU do produto', 'product'], ['SKU do insumo', 'input'], ['Quantidade', 'quantity'], ['Unidade', 'unit']];
const measureSheet = 'Medidas';
const measureColumns: readonly Column[] = [['SKU', 'sku'], ['Nome', 'name'], ['Valor', 'value'], ['Unidade', 'unit']];
const requiredInitial = ['SKU', 'Nome', 'Unidade', 'Quantidade'];
const decimalKeys = new Set([
  'quantity', 'unitCost', 'totalCost', 'wastePercent', 'minStock', 'marginPercent', 'salePrice', 'lengthMm', 'widthMm', 'heightMm', 'diameterMm', 'value', 'purchaseExpenses',
]);
const lastRow = 501;
/** Current registrations offered as dropdowns, by column header. */
export type WorkbookLists = Record<string, string[]>;

function addSheet(workbook: ExcelJS.Workbook, name: string, columns: readonly Column[]) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map(([header, key]) => ({ header, key, width: 22, style: { numFmt: '@' } }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return sheet;
}

function addDropdowns(sheet: ExcelJS.Worksheet, columns: readonly Column[], ranges: Map<string, string>) {
  columns.forEach(([header], index) => {
    const range = ranges.get(header);
    if (!range) return;
    for (let line = 2; line <= lastRow; line++) {
      sheet.getCell(line, index + 1).dataValidation = {
        type: 'list', allowBlank: true, formulae: [range], showErrorMessage: true,
        errorTitle: header, error: 'Escolha um valor da aba Listas.',
      };
    }
  });
}

export async function workbookTemplate(kind: WorkbookKind, lists: WorkbookLists = {}) {
  const workbook = new ExcelJS.Workbook();
  if (kind === 'inventory') {
    addSheet(workbook, 'Inventário', formats.inventory);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
  const sheet = addSheet(workbook, 'Carga inicial', formats.initial);
  const recipes = addSheet(workbook, recipeSheet, recipeColumns);
  addSheet(workbook, measureSheet, measureColumns);
  const listSheet = workbook.addWorksheet('Listas');
  const ranges = new Map<string, string>();
  Object.entries(lists).forEach(([header, values], index) => {
    const column = listSheet.getColumn(index + 1);
    column.width = 22;
    listSheet.getCell(1, index + 1).value = header;
    values.forEach((value, line) => { listSheet.getCell(line + 2, index + 1).value = value; });
    if (values.length) ranges.set(header, 'Listas!$' + column.letter + '$2:$' + column.letter + '$' + (values.length + 1));
  });
  listSheet.getRow(1).font = { bold: true };
  addDropdowns(sheet, formats.initial, ranges);
  addDropdowns(recipes, recipeColumns, ranges);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Excel turns a typed address into a link object, so the link cell is read by its target. */
function linkTarget(value: ExcelJS.CellValue) {
  return value && typeof value === 'object' && 'hyperlink' in value ? value.hyperlink : value;
}

/** A date cell arrives as a Date or as an Excel serial number. Text such as 22/11/2026 is validated later. */
function dateText(value: ExcelJS.CellValue) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'number') return value;
  const date = new Date(Math.round((value - 25569) * 86400000));
  // Out of the calendar range: the row validation refuses it with a clear message.
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

/** Reads a sheet by its headers, so column order does not matter and older templates still work. */
function readSheet(sheet: ExcelJS.Worksheet, known: readonly Column[], required: readonly string[]) {
  if (sheet.rowCount > lastRow || sheet.columnCount > known.length) {
    throw new BadRequestException('Use o modelo e preencha até 500 linhas.');
  }
  const columns = new Map<number, string | null>();
  const headers = new Set<string>();
  for (let index = 1; index <= sheet.columnCount; index++) {
    const header = sheet.getRow(1).getCell(index).text.trim();
    const column = known.find(item => item[0] === header);
    if ((header && !column) || headers.has(header)) throw new BadRequestException('Cabeçalho incorreto. Baixe o modelo desta operação.');
    if (header) headers.add(header);
    columns.set(index, column?.[1] ?? null);
  }
  if (required.some(header => !headers.has(header))) throw new BadRequestException('Cabeçalho incorreto. Baixe o modelo desta operação.');
  if (headers.has('Custo') && headers.has('Custo total')) throw new BadRequestException('Use apenas uma coluna de custo.');
  const rows: Record<string, string>[] = [];
  for (let line = 2; line <= sheet.rowCount; line++) {
    const row = sheet.getRow(line);
    const values: Record<string, string> = {};
    for (const [index, key] of columns) {
      const cell = row.getCell(index).value;
      const value = key === 'purchaseUrl' ? linkTarget(cell) : key === 'purchaseDate' ? dateText(cell) : cell;
      if (value == null || value === '') continue;
      if (!key) throw new BadRequestException('Há valor em uma coluna sem título na linha ' + line + '.');
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new BadRequestException('Use valores simples, sem fórmulas, na linha ' + line + '.');
      }
      const text = typeof value === 'number' && decimalKeys.has(key) ? new Prisma.Decimal(value).toFixed() : String(value).trim();
      if (text) values[key] = text;
    }
    if (Object.keys(values).length) rows.push(values);
  }
  return rows;
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
  if (!sheet) throw new BadRequestException('Use o modelo e preencha até 500 linhas.');
  if (kind === 'inventory') return { rows: readSheet(sheet, formats.inventory, formats.inventory.map(([header]) => header)) };
  const recipes = workbook.getWorksheet(recipeSheet);
  const measureTab = workbook.getWorksheet(measureSheet);
  const measures = measureTab ? readSheet(measureTab, measureColumns, measureColumns.map(([header]) => header)) : [];
  return {
    rows: readSheet(sheet, [...formats.initial, legacyCost], requiredInitial),
    recipes: recipes ? readSheet(recipes, recipeColumns, recipeColumns.map(([header]) => header)) : [],
    ...(measures.length ? { measures } : {}),
  };
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
