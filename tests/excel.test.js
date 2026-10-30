// Prova dell'esportazione nel modulo Excel originale: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ExcelJS = require('../vendor/exceljs.min.js');
const Calcoli = require('../js/calcoli.js');

function caricaModuli() {
  const ctx = { ExcelJS, Calcoli, atob, Blob, Uint8Array, Promise, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['js/modello.js', 'js/excel.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

function registroFinto(n) {
  const righe = [];
  for (let i = 0; i < n; i++) {
    const consumi = new Array(31).fill(0);
    consumi[0] = 1; consumi[30] = 2;
    righe.push({ denominazione: 'ARTICOLO ' + String(i + 1).padStart(3, '0'), residuiPrec: 10, carichi: 5, totaleCarico: 15,
      consumi, totaleConsumo: 3, perdite: 1, totaleScarico: 4, residui: 11, prezzo: 1.5, scadenza: '2027-03', importoScarico: 6 });
  }
  return { righe, giorni: 31 };
}

const opz = { impostazioni: { struttura: 'Clinica Posillipo', societa: 'ME.MI. SRL', citta: 'NAPOLI', codiceModulo: 'PRQ 1501.4EV.1' },
  reparto: 'Degenza', anno: 2026, mese: 10, categoria: 'FARMACI' };

test('compila il modulo con i valori nelle celle giuste', async () => {
  const ctx = caricaModuli();
  const blob = await ctx.ExcelFarmacia.esportaNotaConsumi(registroFinto(3), opz);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  assert.equal(wb.worksheets.length, 1);
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell('Q2').value, 'Degenza');
  assert.equal(ws.getCell('Z2').value, 'Ottobre 2026');
  assert.equal(ws.getCell('AO2').value, 'FARMACI');
  assert.equal(ws.getCell('B9').value, 'ARTICOLO 001');
  assert.equal(ws.getCell('H9').value, 1);
  assert.equal(ws.getCell('AN9').value, 2);
  assert.equal(ws.getCell('AT9').value, '03/27');
  assert.equal(ws.getCell('AV11').value, 11);
  assert.equal(ws.getCell('B12').value, null);
  assert.ok(ws.getColumn('M').hidden);
});

test('oltre 48 articoli aggiunge altri fogli uguali al modulo', async () => {
  const ctx = caricaModuli();
  const blob = await ctx.ExcelFarmacia.esportaNotaConsumi(registroFinto(50), opz);
  const buf = Buffer.from(await blob.arrayBuffer());
  if (process.env.SALVA_ESEMPIO) fs.writeFileSync(process.env.SALVA_ESEMPIO, buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.equal(wb.worksheets.length, 2);
  assert.equal(wb.worksheets[0].getCell('B61').value, 'ARTICOLO 048');
  assert.equal(wb.worksheets[1].getCell('B9').value, 'ARTICOLO 049');
  assert.equal(wb.worksheets[1].getCell('B10').value, 'ARTICOLO 050');
  assert.equal(wb.worksheets[1].getCell('A6').value, 'DENOMINAZIONE');
  assert.match(wb.worksheets[1].getCell('Z2').value, /foglio 2 di 2/);
});

test('importa gli articoli da un modulo compilato', async () => {
  const ctx = caricaModuli();
  const blob = await ctx.ExcelFarmacia.esportaNotaConsumi(registroFinto(2), Object.assign({}, opz, { categoria: 'PRESIDI' }));
  const articoli = await ctx.ExcelFarmacia.importaArticoli(await blob.arrayBuffer(), 'FARMACI');
  assert.equal(articoli.length, 2);
  assert.equal(articoli[0].nome, 'ARTICOLO 001');
  assert.equal(articoli[0].categoria, 'PRESIDI');
  assert.equal(articoli[0].giacenza, 11);
  assert.equal(articoli[0].prezzo, 1.5);
});

test('importa un elenco semplice con intestazioni', async () => {
  const ctx = caricaModuli();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Elenco');
  ws.addRow(['Denominazione', 'Categoria', 'Quantità', 'Prezzo']);
  ws.addRow(['Garze 10x10', 'Presidi', 200, 0.12]);
  ws.addRow(['Paracetamolo 1 g fl', 'Farmaci', '30', '1,20']);
  const buf = await wb.xlsx.writeBuffer();
  const articoli = await ctx.ExcelFarmacia.importaArticoli(buf, 'FARMACI');
  assert.deepEqual(JSON.parse(JSON.stringify(articoli.map(a => [a.nome, a.categoria, a.giacenza, a.prezzo]))),
    [['Garze 10x10', 'PRESIDI', 200, 0.12], ['Paracetamolo 1 g fl', 'FARMACI', 30, 1.2]]);
});
