// Prove dei calcoli di magazzino: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calcoli.js');

let seq = 0;
function mov(tipo, data, quantita, extra) {
  return Object.assign({ id: 'm' + (++seq), tipo, data, quantita, articoloId: 'a1', repartoId: 'far', creato: seq }, extra || {});
}

function stato(movimenti) {
  return {
    articoli: [
      { id: 'a1', nome: 'TACHIPIRINA 1000 mg cpr', categoria: 'FARMACI', prezzo: 0.5 },
      { id: 'a2', nome: 'GARZE STERILI 10x10', categoria: 'PRESIDI', prezzo: 0.1 }
    ],
    reparti: [{ id: 'far', nome: 'Farmacia' }, { id: 'deg', nome: 'Degenza' }],
    movimenti
  };
}

test('giacenza somma carichi e toglie consumi, perdite e trasferimenti', () => {
  const s = stato([
    mov('carico', '2026-10-01', 100),
    mov('consumo', '2026-10-02', 10),
    mov('perdita', '2026-10-03', 5),
    mov('trasferimento', '2026-10-04', 20, { repartoDestId: 'deg' }),
    mov('rettifica', '2026-10-05', -1)
  ]);
  assert.equal(C.giacenza(s, 'a1', 'far'), 64);
  assert.equal(C.giacenza(s, 'a1', 'deg'), 20);
  assert.equal(C.giacenza(s, 'a1', 'far', '2026-10-02'), 90);
  const tutte = C.tutteLeGiacenze(s);
  assert.equal(tutte['a1|far'], 64);
  assert.equal(tutte['a1|deg'], 20);
});

test('i movimenti annullati non contano', () => {
  const s = stato([mov('carico', '2026-10-01', 10), mov('consumo', '2026-10-02', 4, { annullato: true })]);
  assert.equal(C.giacenza(s, 'a1', 'far'), 10);
});

test('le uscite senza lotto scalano prima il lotto che scade prima', () => {
  const s = stato([
    mov('carico', '2026-10-01', 10, { lotto: 'B', scadenza: '2027-06' }),
    mov('carico', '2026-10-01', 10, { lotto: 'A', scadenza: '2026-12' }),
    mov('consumo', '2026-10-02', 12)
  ]);
  const l = C.lotti(s, 'a1', 'far');
  assert.deepEqual(l.map(x => [x.lotto, x.quantita]), [['B', 8]]);
});

test('allocaUscita divide l\'uscita sui lotti in ordine di scadenza', () => {
  const s = stato([
    mov('carico', '2026-10-01', 5, { lotto: 'A', scadenza: '2026-12' }),
    mov('carico', '2026-10-01', 10, { lotto: 'B', scadenza: '2027-06' })
  ]);
  const parti = C.allocaUscita(s, 'a1', 'far', '2026-10-10', 8);
  assert.deepEqual(parti, [{ lotto: 'A', scadenza: '2026-12', quantita: 5 }, { lotto: 'B', scadenza: '2027-06', quantita: 3 }]);
  const scelto = C.allocaUscita(s, 'a1', 'far', '2026-10-10', 3, 'B');
  assert.deepEqual(scelto, [{ lotto: 'B', scadenza: '2027-06', quantita: 3 }]);
  const oltre = C.allocaUscita(s, 'a1', 'far', '2026-10-10', 20);
  assert.equal(oltre.reduce((t, p) => t + p.quantita, 0), 20);
  assert.equal(oltre[oltre.length - 1].lotto, '');
});

test('registro mensile con le colonne del modulo', () => {
  const s = stato([
    mov('carico', '2026-09-20', 30, { lotto: 'A', scadenza: '2027-03' }),
    mov('consumo', '2026-09-25', 10),
    mov('carico', '2026-10-01', 10, { lotto: 'B', scadenza: '2026-11' }),
    mov('consumo', '2026-10-01', 2),
    mov('consumo', '2026-10-01', 1),
    mov('consumo', '2026-10-31', 3),
    mov('trasferimento', '2026-10-15', 4, { repartoDestId: 'deg' }),
    mov('perdita', '2026-10-20', 1),
    mov('rettifica', '2026-10-30', 2)
  ]);
  const reg = C.registroMensile(s, { repartoId: 'far', anno: 2026, mese: 10, categoria: 'FARMACI' });
  assert.equal(reg.giorni, 31);
  assert.equal(reg.righe.length, 1);
  const r = reg.righe[0];
  assert.equal(r.residuiPrec, 20);
  assert.equal(r.carichi, 12);
  assert.equal(r.totaleCarico, 32);
  assert.equal(r.consumi[0], 3);
  assert.equal(r.consumi[14], 4);
  assert.equal(r.consumi[30], 3);
  assert.equal(r.totaleConsumo, 10);
  assert.equal(r.perdite, 1);
  assert.equal(r.totaleScarico, 11);
  assert.equal(r.residui, 21);
  assert.equal(r.residui, C.giacenza(s, 'a1', 'far', '2026-10-31'));
  assert.equal(r.importoScarico, 5.5);
  assert.equal(r.scadenza, '2027-03');

  const deg = C.registroMensile(s, { repartoId: 'deg', anno: 2026, mese: 10, categoria: 'FARMACI' });
  assert.equal(deg.righe[0].carichi, 4);
  assert.equal(deg.righe[0].residui, 4);
});

test('registro: articoli senza movimenti solo se richiesti', () => {
  const s = stato([]);
  assert.equal(C.registroMensile(s, { repartoId: 'far', anno: 2026, mese: 2, categoria: 'PRESIDI' }).righe.length, 0);
  const tutti = C.registroMensile(s, { repartoId: 'far', anno: 2026, mese: 2, categoria: 'PRESIDI', includiTutti: true });
  assert.equal(tutti.righe.length, 1);
  assert.equal(tutti.giorni, 28);
});

test('date e scadenze', () => {
  assert.equal(C.giornoPrima('2026-03-01'), '2026-02-28');
  assert.equal(C.giornoPrima('2024-03-01'), '2024-02-29');
  assert.equal(C.scadenzaBreve('2027-03'), '03/27');
  assert.equal(C.giorniAllaScadenza('2026-10', '2026-10-30'), 1);
  assert.equal(C.giorniAllaScadenza('2026-09', '2026-10-30'), -30);
});

test('un lotto scelto non riceve mai più della sua disponibilità', () => {
  const s = stato([
    mov('carico', '2026-10-01', 5, { lotto: 'OLD', scadenza: '2026-12' }),
    mov('carico', '2026-10-01', 100, { lotto: 'NEW', scadenza: '2029-06' }),
    mov('consumo', '2026-10-02', 5)
  ]);
  const parti = C.allocaUscita(s, 'a1', 'far', '2026-10-03', 5, 'OLD');
  assert.deepEqual(parti, [{ lotto: 'NEW', scadenza: '2029-06', quantita: 5 }]);
  assert.equal(C.disponibilitaLotto(s, 'a1', 'far', '2026-10-03', 'OLD'), 0);
  assert.equal(C.disponibilitaLotto(s, 'a1', 'far', '2026-10-03', 'NEW'), 100);
});

test('un\'uscita registrata prima del carico non lascia lotti negativi', () => {
  const s = stato([
    mov('consumo', '2026-10-05', 5),
    mov('trasferimento', '2026-10-05', 20, { repartoId: 'far', repartoDestId: 'deg', lotto: 'C1', scadenza: '2027-01' }),
    mov('consumo', '2026-10-05', 15, { repartoId: 'deg' })
  ].map((m, i) => i === 0 ? Object.assign(m, { repartoId: 'deg' }) : m));
  assert.equal(C.giacenza(s, 'a1', 'deg'), 0);
  assert.deepEqual(C.lotti(s, 'a1', 'deg'), []);
});

test('decimali: nessun resto da arrotondamento', () => {
  const s = stato([
    mov('carico', '2026-10-01', 0.3, { lotto: 'A', scadenza: '2027-01' }),
    mov('consumo', '2026-10-02', 0.1),
    mov('consumo', '2026-10-03', 0.2)
  ]);
  assert.equal(C.giacenza(s, 'a1', 'far'), 0);
  assert.deepEqual(C.lotti(s, 'a1', 'far'), []);
  const r = C.registroMensile(s, { repartoId: 'far', anno: 2026, mese: 10, categoria: 'FARMACI' }).righe[0];
  assert.equal(r.residui, 0);
  assert.ok(!Object.is(r.residui, -0));
  const nov = C.registroMensile(s, { repartoId: 'far', anno: 2026, mese: 11, categoria: 'FARMACI' });
  assert.equal(nov.righe.length, 0);
  const s2 = stato([mov('carico', '2026-10-01', 1, { lotto: 'A', scadenza: '2027-01' }), mov('carico', '2026-10-01', 5, { lotto: 'B', scadenza: '2028-01' }), mov('consumo', '2026-10-02', 0.9)]);
  assert.deepEqual(C.allocaUscita(s2, 'a1', 'far', '2026-10-03', 0.1), [{ lotto: 'A', scadenza: '2027-01', quantita: 0.1 }]);
});
