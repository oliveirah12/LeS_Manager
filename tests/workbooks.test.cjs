const assert = require('node:assert/strict');
const { test } = require('node:test');
const ExcelJS = require('exceljs');
const { initialFields } = require('../dist/api/stock/stock.js');
const { workbookRows, workbookTemplate } = require('../dist/api/stock/workbooks.js');

const asFile = async workbook => ({ originalname: 'carga.xlsx', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
async function template(lists = { Tipo: ['Filamento', 'Impresso 3D'], Unidade: ['g', 'kg', 'un'], Grupo: [] }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await workbookTemplate('initial', lists));
  return workbook;
}
function legacy(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Carga inicial');
  sheet.addRow(['SKU', 'Nome', 'Unidade', 'Quantidade', 'Custo', 'Grupo', 'Marca', 'Cor', 'Departamento']);
  rows.forEach(row => sheet.addRow(row));
  return workbook;
}

test('the template has the load, technical sheet and list tabs with dropdowns', async () => {
  const workbook = await template();
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Carga inicial', 'Ficha técnica', 'Listas']);
  const [load, recipes, lists] = workbook.worksheets;
  assert.deepEqual(load.getRow(1).values.slice(1, 8), ['SKU', 'Nome', 'Tipo', 'Unidade', 'Quantidade', 'Custo total', 'Perda (%)']);
  assert.deepEqual(recipes.getRow(1).values.slice(1), ['SKU do produto', 'SKU do insumo', 'Quantidade', 'Unidade']);
  assert.equal(lists.getCell('A3').value, 'Impresso 3D');
  assert.deepEqual(load.getCell('C2').dataValidation.formulae, ['Listas!$A$2:$A$3']);
  assert.deepEqual(recipes.getCell('D501').dataValidation.formulae, ['Listas!$B$2:$B$4']);
  assert.equal(load.getCell('H2').dataValidation, undefined);
});

test('an empty template with dropdowns reads as no rows', async () => {
  assert.deepEqual(await workbookRows('initial', await asFile(await template())), { rows: [], recipes: [] });
});

test('reads the new columns and the technical sheet', async () => {
  const workbook = await template();
  workbook.worksheets[0].getRow(2).values = ['pla', 'PLA', 'Filamento', 'kg', 3, 300];
  workbook.worksheets[0].getRow(3).values = ['peca', 'Peça', 'Impresso 3D', 'un', 0, null, 5];
  workbook.worksheets[1].getRow(2).values = ['peca', 'pla', 120, 'g'];
  const data = await workbookRows('initial', await asFile(workbook));
  assert.deepEqual(data.rows[0], { sku: 'pla', name: 'PLA', type: 'Filamento', unit: 'kg', quantity: '3', totalCost: '300' });
  assert.equal(data.rows[1].wastePercent, '5');
  assert.deepEqual(data.recipes, [{ product: 'peca', input: 'pla', quantity: '120', unit: 'g' }]);
  assert.equal(initialFields.safeParse(data).success, true);
});

test('an older file keeps Custo as the cost per declared unit', async () => {
  const data = await workbookRows('initial', await asFile(legacy([['A', 'Antigo', 'kg', 2, 15]])));
  assert.deepEqual(data, { rows: [{ sku: 'A', name: 'Antigo', unit: 'kg', quantity: '2', unitCost: '15' }], recipes: [] });
  assert.equal(initialFields.safeParse(data).success, true);
});

test('rejects unknown headers, two cost columns and missing required columns', async () => {
  for (const headers of [['SKU', 'Nome', 'Unidade', 'Quantidade', 'Preço'], ['SKU', 'Nome', 'Unidade', 'Quantidade', 'Custo', 'Custo total'], ['SKU', 'Nome', 'Quantidade']]) {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Carga inicial').addRow(headers);
    await assert.rejects(workbookRows('initial', await asFile(workbook)), { status: 400 }, headers.join());
  }
});

const row = fields => ({ sku: 'A', name: 'Nome', unit: 'un', quantity: '1', ...fields });
test('validates the cost and waste of each row', () => {
  const valid = fields => initialFields.safeParse({ rows: [row(fields)] }).success;
  assert.equal(valid({ totalCost: '10' }), true);
  assert.equal(valid({ unitCost: '10' }), true);
  assert.equal(valid({}), false);
  assert.equal(valid({ unitCost: '1', totalCost: '1' }), false);
  assert.equal(valid({ quantity: '0', totalCost: '10' }), false);
  assert.equal(valid({ quantity: '0' }), true);
  assert.equal(valid({ totalCost: '10', wastePercent: '100.01' }), false);
});
