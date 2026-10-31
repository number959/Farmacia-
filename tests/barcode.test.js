// Prove dell'analisi dei codici a barre (js/barcode.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../js/barcode.js');

const GS = '\x1D';
// GTIN-14 di prova con la cifra di controllo giusta
const GTIN = '0801234567890' + B.cifraGtin('0801234567890');
const EAN13 = GTIN.slice(1);

test('cifre di controllo GTIN e AIC', () => {
  assert.equal(GTIN, '08012345678907');
  assert.ok(B.gtinValido('4006381333931')); // EAN-13 noto
  assert.ok(B.gtinValido('96385074')); // EAN-8 noto
  assert.ok(B.gtinValido('036000291452')); // UPC-A noto
  assert.ok(!B.gtinValido('4006381333932'));
  // AIC: posizioni dispari sommate, pari raddoppiate con la somma delle cifre
  assert.equal(B.cifraAic('01234567'), 6);
  assert.ok(B.aicValido('012345676'));
  assert.ok(!B.aicValido('012345677'));
});

test('GS1 Data Matrix con il separatore GS e prefisso AIM ]d2', () => {
  const r = B.analizza(']d201' + GTIN + '17271130' + '10LOT-7A' + GS + '21SER123');
  assert.equal(r.tipo, 'gs1');
  assert.equal(r.gtin, GTIN);
  assert.equal(r.lotto, 'LOT-7A');
  assert.equal(r.seriale, 'SER123');
  assert.equal(r.scadenza, '2027-11');
  assert.deepEqual(r.chiavi, ['gtin:' + GTIN]);
  // FNC1 iniziale trasmesso come GS (fotocamera), data di produzione (11) ignorata
  const f = B.analizza(GS + '01' + GTIN + '11250101' + '21ABC' + GS + '10L9');
  assert.equal(f.tipo, 'gs1');
  assert.equal(f.lotto, 'L9');
  assert.equal(f.seriale, 'ABC');
  assert.equal(f.scadenza, '');
});

test('GS1 con le parentesi e GS1-128 (]C1)', () => {
  const r = B.analizza('(01)' + GTIN + '(17)280615(10)AB 12(21)XYZ');
  assert.equal(r.tipo, 'gs1');
  assert.equal(r.gtin, GTIN);
  assert.equal(r.scadenza, '2028-06');
  assert.equal(r.lotto, 'AB 12');
  assert.equal(r.seriale, 'XYZ');
  const c = B.analizza(']C101' + GTIN + '10L1' + GS + '17260131');
  assert.equal(c.tipo, 'gs1');
  assert.equal(c.lotto, 'L1');
  assert.equal(c.scadenza, '2026-01');
});

test('GS1 senza separatori: i campi variabili in fondo', () => {
  const r = B.analizza('01' + GTIN + '17290300' + '10XYZ-99');
  assert.equal(r.tipo, 'gs1');
  assert.equal(r.scadenza, '2029-03');
  assert.equal(r.lotto, 'XYZ-99');
  // lettore che non trasmette il GS: la scadenza in fondo dopo un campo variabile resta riconosciuta
  const s = B.analizza('01' + GTIN + '10LOTTO1' + '17300430');
  assert.equal(s.lotto, 'LOTTO1');
  assert.equal(s.scadenza, '2030-04');
});

test('scadenza con il giorno 00 (fine mese) e secolo', () => {
  const r = B.analizza('(01)' + GTIN + '(17)270200');
  assert.equal(r.scadenza, '2027-02');
  assert.equal(B.scadenzaGs1('991231', new Date(2026, 0, 1)), '1999-12');
  assert.equal(B.scadenzaGs1('751231', new Date(2026, 0, 1)), '2075-12');
  assert.equal(B.scadenzaGs1('271300'), ''); // mese 13
});

test('Code 32 (AIC) nelle due forme', () => {
  const a = B.analizza('A012345676');
  assert.equal(a.tipo, 'aic');
  assert.equal(a.aic, '012345676');
  assert.deepEqual(a.chiavi, ['aic:012345676']);
  // lettore impostato su Code 39: restituisce le 6 lettere/cifre in base 32
  assert.equal(B.aicInBase32('012345676'), '0CSSBD');
  const b = B.analizza('0CSSBD');
  assert.equal(b.tipo, 'aic');
  assert.equal(b.aic, '012345676');
  assert.deepEqual(b.chiavi, a.chiavi);
  // 9 cifre senza la "A"
  assert.equal(B.analizza('012345676').aic, '012345676');
  // cifra di controllo sbagliata: non è un AIC
  const s = B.analizza('A012345677');
  assert.equal(s.tipo, 'altro');
  assert.deepEqual(s.chiavi, ['cod:A012345677']);
});

test('EAN-13, EAN-8, UPC-A e cifra di controllo sbagliata', () => {
  const e = B.analizza(EAN13);
  assert.equal(e.tipo, 'ean');
  assert.equal(e.gtin, GTIN);
  assert.deepEqual(e.chiavi, ['gtin:' + GTIN]);
  assert.equal(B.analizza('96385074').gtin, '00000096385074');
  assert.equal(B.analizza('036000291452').gtin, '00036000291452');
  const sbagliato = B.analizza(EAN13.slice(0, 12) + ((Number(EAN13.slice(-1)) + 1) % 10));
  assert.equal(sbagliato.tipo, 'altro');
  assert.equal(sbagliato.gtin, '');
});

test('prefissi AIM tolti', () => {
  assert.equal(B.analizza(']E0' + EAN13).gtin, GTIN);
  assert.equal(B.analizza(']e001' + GTIN + '10L').tipo, 'gs1');
  assert.equal(B.analizza(']Q301' + GTIN + '10L').lotto, 'L');
  assert.equal(B.analizza(']A0A012345676').aic, '012345676');
  assert.deepEqual(B.analizza(']C0INTERNO-1').chiavi, ['cod:INTERNO-1']);
});

test('altri codici: chiave cod maiuscola, senza spazi, al massimo 60 caratteri', () => {
  assert.deepEqual(B.analizza(' abc 123\r\n').chiavi, ['cod:ABC123']);
  const lungo = B.analizza('x'.repeat(100));
  assert.equal(lungo.chiavi[0], 'cod:' + 'X'.repeat(60));
  assert.deepEqual(B.analizza('').chiavi, []);
  // GS1 senza GTIN (per esempio solo il lotto): nessuna chiave
  assert.deepEqual(B.analizza('(10)SOLO-LOTTO').chiavi, []);
});

test('chiavi normalizzate e descrizione', () => {
  assert.equal(B.normalizzaChiave('COD: abc 1'), 'cod:ABC1');
  assert.equal(B.normalizzaChiave('gtin:' + EAN13), 'gtin:' + GTIN);
  assert.equal(B.normalizzaChiave('aic:012345676'), 'aic:012345676');
  assert.equal(B.normalizzaChiave('aic:012345677'), null);
  assert.equal(B.normalizzaChiave('gtin:123'), null);
  assert.equal(B.normalizzaChiave('cod:'), null);
  assert.equal(B.normalizzaChiave('cod:' + 'A'.repeat(61)), null);
  assert.equal(B.normalizzaChiave('qualcosa'), null);
  assert.equal(B.descrivi('aic:012345676'), 'AIC 012345676');
  assert.equal(B.descrivi('gtin:' + GTIN), 'EAN ' + EAN13);
  assert.equal(B.descrivi('gtin:00000096385074'), 'EAN 96385074');
  assert.equal(B.descrivi('cod:ABC'), 'ABC');
});

test('GS1: parentesi con gli spazi, lotto che finisce come una data, campo variabile vuoto', () => {
  // testo stampato sotto il codice, scritto a mano con gli spazi
  const r = B.analizza('(01) ' + GTIN + ' (17) 271130 (10) LOT1');
  assert.equal(r.gtin, GTIN);
  assert.equal(r.scadenza, '2027-11');
  assert.equal(r.lotto, 'LOT1');
  // senza GS e con la scadenza già letta: il lotto in fondo resta intero anche se finisce con "17" + 6 cifre
  const s = B.analizza('01' + GTIN + '17271130' + '10AB17260101');
  assert.equal(s.lotto, 'AB17260101');
  assert.equal(s.scadenza, '2027-11');
  // né un'altra data (12 = data di pagamento) staccata per sbaglio
  assert.equal(B.analizza('01' + GTIN + '17271130' + '10AB12171231').lotto, 'AB12171231');
  // "10" senza lotto in fondo: il GTIN resta riconosciuto
  const v = B.analizza('01' + GTIN + '17271130' + '10');
  assert.equal(v.tipo, 'gs1');
  assert.deepEqual(v.chiavi, ['gtin:' + GTIN]);
  assert.equal(v.lotto, '');
});
