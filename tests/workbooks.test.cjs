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
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Carga inicial', 'Ficha técnica', 'Medidas', 'Custos', 'Listas']);
  const [load, recipes, measures, costs, lists] = workbook.worksheets;
  assert.deepEqual(measures.getRow(1).values.slice(1), ['SKU', 'Nome', 'Valor', 'Unidade']);
  assert.equal(measures.getCell('D2').dataValidation, undefined);
  assert.deepEqual(load.getRow(1).values.slice(20), [
    'Data da compra', 'Fornecedor', 'Despesas da compra', 'Tempo por peça (min)', 'Impressora', 'Custos vinculados',
  ]);
  assert.deepEqual(load.getRow(1).values.slice(12, 20), [
    'Estoque mínimo', 'Margem (%)', 'Preço de venda', 'Comprimento (mm)', 'Largura (mm)', 'Altura (mm)', 'Diâmetro (mm)', 'URL de compra',
  ]);
  assert.deepEqual(load.getRow(1).values.slice(1, 8), ['SKU', 'Nome', 'Tipo', 'Unidade', 'Quantidade', 'Custo total', 'Perda (%)']);
  assert.deepEqual(recipes.getRow(1).values.slice(1), ['SKU do produto', 'SKU do insumo', 'Quantidade', 'Unidade']);
  assert.equal(lists.getCell('A3').value, 'Impresso 3D');
  assert.deepEqual(load.getCell('C2').dataValidation.formulae, ['Listas!$A$2:$A$3']);
  assert.deepEqual(recipes.getCell('D501').dataValidation.formulae, ['Listas!$B$2:$B$4']);
  assert.equal(load.getCell('H2').dataValidation, undefined);
  assert.deepEqual(costs.getRow(1).values.slice(1), ['Descrição', 'Tipo do custo', 'Base do %', 'Valor']);
  assert.deepEqual([lists.getCell('D1').value, lists.getCell('E3').value], ['Tipo do custo', 'Venda']);
  assert.deepEqual(costs.getCell('B2').dataValidation.formulae, ['Listas!$D$2:$D$3']);
  assert.equal(costs.getCell('D2').dataValidation, undefined);
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

test('reads print time, printer and linked costs, also from a stored preview', async () => {
  const workbook = await template({ Tipo: ['Impresso 3D'], Unidade: ['un'], Impressora: ['Bambu A1'] });
  const load = workbook.worksheets[0];
  const column = header => load.getRow(1).values.indexOf(header);
  load.getRow(2).values = ['peca', 'Peça', 'Impresso 3D', 'un', 0];
  load.getCell(2, column('Tempo por peça (min)')).value = 45.5;
  load.getCell(2, column('Impressora')).value = 'Bambu A1';
  load.getCell(2, column('Custos vinculados')).value = 'Embalagem; Taxa da loja ;';
  assert.deepEqual(load.getCell(2, column('Impressora')).dataValidation.formulae.length, 1);
  const data = await workbookRows('initial', await asFile(workbook));
  assert.deepEqual([data.rows[0].printMinutes, data.rows[0].printer, data.rows[0].linkedCosts], ['45.5', 'Bambu A1', 'Embalagem; Taxa da loja ;']);
  const parsed = initialFields.parse(data);
  assert.deepEqual([parsed.rows[0].printMinutes.toFixed(), parsed.rows[0].linkedCosts], ['45.5', ['Embalagem', 'Taxa da loja']]);
  const stored = JSON.parse(JSON.stringify({ ...data, rows: [{ ...data.rows[0], linkedCosts: parsed.rows[0].linkedCosts }] }));
  assert.deepEqual(initialFields.parse(stored).rows[0].linkedCosts, ['Embalagem', 'Taxa da loja']);
  assert.equal(initialFields.safeParse({ rows: [{ ...data.rows[0], printMinutes: '0' }] }).success, false);
});

test('reads the cost tab by its labels and applies the cost rules', async () => {
  const workbook = await template();
  workbook.worksheets[0].getRow(2).values = ['pla', 'PLA', 'Filamento', 'kg', 0];
  const costs = workbook.getWorksheet('Custos');
  costs.getRow(2).values = ['Embalagem', 'Valor', 'Venda', 2.5];
  costs.getRow(3).values = ['Imposto', 'Percentual', 'Venda', 6];
  costs.getRow(4).values = ['Perda', 'Percentual', null, '3'];
  const data = await workbookRows('initial', await asFile(workbook));
  assert.deepEqual(data.costs[0], { name: 'Embalagem', mode: 'Valor', base: 'Venda', value: '2.5' });
  const parsed = initialFields.parse(data);
  assert.deepEqual(parsed.costs.map(cost => [cost.name, cost.mode, cost.base, cost.value.toFixed()]), [
    ['Embalagem', 'VALUE', 'COST', '2.5'], ['Imposto', 'PERCENT', 'SALE', '6'], ['Perda', 'PERCENT', 'COST', '3'],
  ]);
  // A stored preview keeps the ids, and they read back the same way.
  const stored = JSON.parse(JSON.stringify({ ...data, costs: parsed.costs.map(cost => ({ ...cost, value: cost.value.toFixed() })) }));
  assert.deepEqual(initialFields.parse(stored).costs.map(cost => cost.base), ['COST', 'SALE', 'COST']);
  costs.getRow(5).values = ['Taxa', 'Outro', null, 1];
  assert.equal(initialFields.safeParse(await workbookRows('initial', await asFile(workbook))).success, false);
});

test('an older file keeps Custo as the cost per declared unit', async () => {
  const data = await workbookRows('initial', await asFile(legacy([['A', 'Antigo', 'kg', 2, 15]])));
  assert.deepEqual(data, { rows: [{ sku: 'A', name: 'Antigo', unit: 'kg', quantity: '2', unitCost: '15' }], recipes: [] });
  assert.equal(initialFields.safeParse(data).success, true);
});

const fill = (sheet, line, values) => sheet.getRow(1).eachCell((cell, column) => {
  if (cell.text in values) sheet.getCell(line, column).value = values[cell.text];
});

test('reads the registry columns, a typed link and the measures tab', async () => {
  const workbook = await template();
  fill(workbook.worksheets[0], 2, {
    SKU: 'pla', Nome: 'PLA', Unidade: 'un', Quantidade: 0, 'Estoque mínimo': 2.5, 'Margem (%)': '40', 'Preço de venda': 99.9,
    'Comprimento (mm)': 120.5, 'Diâmetro (mm)': '1,75', 'URL de compra': { text: 'Loja', hyperlink: 'https://loja.example/item' },
  });
  fill(workbook.getWorksheet('Medidas'), 2, { SKU: 'pla', Nome: 'Passo', Valor: 0.4, Unidade: 'mm' });
  const data = await workbookRows('initial', await asFile(workbook));
  assert.deepEqual(data.rows[0], {
    sku: 'pla', name: 'PLA', unit: 'un', quantity: '0', minStock: '2.5', marginPercent: '40', salePrice: '99.9',
    lengthMm: '120.5', diameterMm: '1,75', purchaseUrl: 'https://loja.example/item',
  });
  assert.deepEqual(data.measures, [{ sku: 'pla', name: 'Passo', value: '0.4', unit: 'mm' }]);
  const parsed = initialFields.parse(data);
  assert.equal(parsed.rows[0].diameterMm.toFixed(), '1.75');
  assert.equal(parsed.measures[0].sku, 'PLA');
});

test('reads the purchase columns, with the date typed or as a real date', async () => {
  const workbook = await template({ Tipo: ['Filamento'], Unidade: ['g'], Fornecedor: ['Loja A', 'Loja B'] });
  const load = workbook.worksheets[0];
  fill(load, 2, { SKU: 'a', Nome: 'A', Unidade: 'g', Quantidade: 10, 'Custo total': 50, 'Data da compra': '22/01/2026', Fornecedor: 'Loja B', 'Despesas da compra': 5.5 });
  fill(load, 3, { SKU: 'b', Nome: 'B', Unidade: 'g', Quantidade: 1, 'Custo total': 1, 'Data da compra': new Date(Date.UTC(2026, 0, 23)) });
  fill(load, 4, { SKU: 'c', Nome: 'C', Unidade: 'g', Quantidade: 1, 'Custo total': 1, 'Data da compra': 46045 });
  const data = await workbookRows('initial', await asFile(workbook));
  assert.deepEqual([data.rows[0].supplier, data.rows[0].purchaseExpenses], ['Loja B', '5.5']);
  const parsed = initialFields.parse(data);
  assert.deepEqual(parsed.rows.map(row => row.purchaseDate), ['2026-01-22', '2026-01-23', '2026-01-23']);
  assert.equal(parsed.rows[0].purchaseExpenses.toFixed(), '5.5');
  const header = load.getRow(1).values.indexOf('Fornecedor');
  assert.deepEqual(load.getCell(2, header).dataValidation.formulae, ['Listas!$C$2:$C$3']);
});

test('validates the purchase columns of each row', () => {
  const valid = fields => initialFields.safeParse({ rows: [{ sku: 'A', name: 'Nome', unit: 'un', quantity: '1', totalCost: '1', ...fields }] }).success;
  for (const fields of [{ purchaseDate: '2026-01-22' }, { supplier: 'Loja' }, { purchaseExpenses: '0' }]) assert.equal(valid(fields), true, JSON.stringify(fields));
  for (const fields of [{ purchaseDate: '31/02/2026' }, { purchaseDate: '2999-01-01' }, { purchaseExpenses: '-1' }]) assert.equal(valid(fields), false, JSON.stringify(fields));
  assert.equal(initialFields.safeParse({ rows: [{ sku: 'A', name: 'Nome', unit: 'un', quantity: '0', purchaseExpenses: '1' }] }).success, false);
});

test('a preview stored before the registry fields stays valid', () => {
  const parsed = initialFields.parse({ rows: [{ sku: 'A', name: 'Antigo', unit: 'un', quantity: '1', totalCost: '5' }], recipes: [] });
  assert.deepEqual(parsed.measures, []);
  assert.equal(parsed.rows[0].marginPercent, undefined);
});

test('validates the registry fields of each row', () => {
  const valid = fields => initialFields.safeParse({ rows: [{ sku: 'A', name: 'Nome', unit: 'un', quantity: '0', ...fields }] }).success;
  for (const fields of [{ marginPercent: '99.99' }, { marginPercent: '0' }, { minStock: '0' }, { salePrice: '0.01' }, { heightMm: '3' }]) assert.equal(valid(fields), true, JSON.stringify(fields));
  for (const fields of [{ marginPercent: '100' }, { marginPercent: '1.234' }, { minStock: '-1' }, { salePrice: '0' }, { widthMm: '0' }, { purchaseUrl: 'javascript:alert(1)' }]) {
    assert.equal(valid(fields), false, JSON.stringify(fields));
  }
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
