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

/* ---------- versione 3.0: richieste, DDT interni e merce in viaggio ---------- */

function statoLogistica() {
  return {
    richiesteRighe: [
      { id: 'rr1', richiestaId: 'R1', articoloId: 'a1', quantita: 10, approvata: 8, ordine: 0, nota: '' },
      { id: 'rr2', richiestaId: 'R1', articoloId: 'a2', quantita: 5, approvata: null, ordine: 1, nota: 'urgente' },
      { id: 'rr3', richiestaId: 'R2', articoloId: 'a1', quantita: 3, approvata: null, ordine: 0, nota: '' }
    ],
    ddt: [
      { id: 'D1', richiestaId: 'R1', stato: 'ricevuto_con_differenze', origineId: 'far', destinazioneId: 'deg' },
      { id: 'D2', richiestaId: 'R1', stato: 'in_preparazione', origineId: 'far', destinazioneId: 'deg' },
      { id: 'D3', richiestaId: 'R1', stato: 'annullato', origineId: 'far', destinazioneId: 'deg' },
      { id: 'D4', richiestaId: null, stato: 'in_transito', origineId: 'far', destinazioneId: 'deg' },
      { id: 'D5', richiestaId: 'R1', stato: 'in_transito', origineId: 'far', destinazioneId: 'deg' }
    ],
    ddtRighe: [
      { id: 'x1', ddtId: 'D1', articoloId: 'a1', richiestaRigaId: 'rr1', lotto: 'A', quantita: 3, ricevuta: 2 },
      { id: 'x2', ddtId: 'D1', articoloId: 'a1', richiestaRigaId: 'rr1', lotto: 'B', quantita: 1, ricevuta: 1 },
      { id: 'x3', ddtId: 'D2', articoloId: 'a1', richiestaRigaId: 'rr1', lotto: 'B', quantita: 2 },
      { id: 'x4', ddtId: 'D3', articoloId: 'a2', richiestaRigaId: 'rr2', lotto: '', quantita: 5 },
      { id: 'x5', ddtId: 'D4', articoloId: 'a1', richiestaRigaId: null, lotto: 'A', quantita: 7 },
      { id: 'x6', ddtId: 'D5', articoloId: 'a2', richiestaRigaId: 'rr2', lotto: '', quantita: 1.5 }
    ]
  };
}

test('avanzamento di una richiesta: approvata, in preparazione, spedita (DDT annullati esclusi), residuo', () => {
  const s = statoLogistica();
  const r = C.avanzamentoRichiesta(s, 'R1');
  assert.deepEqual(r.map((x) => [x.rigaId, x.base, x.inPreparazione, x.spedita, x.residuo]), [
    ['rr1', 8, 2, 4, 2],     // approvate 8: 4 partite (anche se ricevute con differenze), 2 in preparazione
    ['rr2', 5, 0, 1.5, 3.5]  // non ancora approvata: vale la quantità richiesta; il DDT annullato non conta
  ]);
  assert.equal(r[1].nota, 'urgente');
  const t = C.totaliRichiesta(s, 'R1');
  assert.equal(t.righe, 2);
  assert.equal(t.base, 13);
  assert.equal(t.spedita, 5.5);
  assert.equal(t.residuo, 5.5);
  assert.equal(t.percentuale, 42);
  assert.deepEqual(C.avanzamentoRichiesta(s, 'R2').map((x) => x.residuo), [3]);
  assert.deepEqual(C.avanzamentoRichiesta({}, 'R1'), []);
  // spedito più dell'approvato (approvazione ridotta dopo): il residuo non va sotto zero
  s.richiesteRighe[0].approvata = 3;
  assert.equal(C.avanzamentoRichiesta(s, 'R1')[0].residuo, 0);
  assert.equal(C.totaliRichiesta(s, 'R1').percentuale, 56);
});

test('merce in viaggio: solo i DDT partiti e non ancora ricevuti, per articolo e magazzino di arrivo', () => {
  const v = C.merceInViaggio(statoLogistica());
  assert.deepEqual(v, { 'a1|deg': 7, 'a2|deg': 1.5 });
  assert.deepEqual(C.merceInViaggio({}), {});
});

test('movimenti dei DDT: il magazzino vero dall\'altra parte al posto di "In transito"', () => {
  const s = statoLogistica();
  const partenza = { tipo: 'trasferimento', repartoId: 'far', repartoDestId: 'r-transito', ddtId: 'D4' };
  const arrivo = { tipo: 'trasferimento', repartoId: 'r-transito', repartoDestId: 'deg', ddtId: 'D4' };
  const rientro = { tipo: 'trasferimento', repartoId: 'r-transito', repartoDestId: 'far', ddtId: 'D4' };
  const perdita = { tipo: 'perdita', repartoId: 'r-transito', ddtId: 'D4' };
  assert.equal(C.controparteDdt(s, partenza).controparteId, 'deg');
  assert.equal(C.controparteDdt(s, arrivo).controparteId, 'far');
  assert.equal(C.controparteDdt(s, rientro).controparteId, 'deg');
  assert.equal(C.controparteDdt(s, perdita).controparteId, null);
  assert.equal(C.controparteDdt(s, partenza).ddt.id, 'D4');
  assert.equal(C.controparteDdt(s, { tipo: 'consumo' }), null);
  assert.equal(C.controparteDdt(s, { tipo: 'trasferimento', ddtId: 'nessuno' }), null);
});

test('nota consumi con i DDT: l\'origine esce alla partenza, il destinatario entra alla ricezione', () => {
  const T = 'r-transito';
  const s = stato([
    mov('carico', '2026-10-01', 50, { lotto: 'A', scadenza: '2027-03' }),
    // DDT partito il 30 ottobre, ricevuto il 2 novembre: 18 arrivano, 1 rientra, 1 perso in viaggio
    mov('trasferimento', '2026-10-30', 20, { repartoDestId: T, lotto: 'A', scadenza: '2027-03', ddtId: 'D' }),
    mov('trasferimento', '2026-11-02', 18, { repartoId: T, repartoDestId: 'deg', lotto: 'A', scadenza: '2027-03', ddtId: 'D' }),
    mov('trasferimento', '2026-11-02', 1, { repartoId: T, repartoDestId: 'far', lotto: 'A', scadenza: '2027-03', ddtId: 'D' }),
    mov('perdita', '2026-11-02', 1, { repartoId: T, lotto: 'A', scadenza: '2027-03', ddtId: 'D' })
  ]);
  const ottFar = C.registroMensile(s, { repartoId: 'far', anno: 2026, mese: 10, categoria: 'FARMACI' }).righe[0];
  assert.equal(ottFar.consumi[29], 20);
  assert.equal(ottFar.residui, 30);
  const ottDeg = C.registroMensile(s, { repartoId: 'deg', anno: 2026, mese: 10, categoria: 'FARMACI' });
  assert.equal(ottDeg.righe.length, 0, 'a ottobre la Degenza non ha ancora ricevuto niente');
  const novDeg = C.registroMensile(s, { repartoId: 'deg', anno: 2026, mese: 11, categoria: 'FARMACI' }).righe[0];
  assert.equal(novDeg.carichi, 18);
  assert.equal(novDeg.residui, 18);
  assert.equal(novDeg.scadenza, '2027-03');
  const novFar = C.registroMensile(s, { repartoId: 'far', anno: 2026, mese: 11, categoria: 'FARMACI' }).righe[0];
  assert.equal(novFar.carichi, 1, 'la differenza rientrata è un carico per l\'origine');
  assert.equal(C.giacenza(s, 'a1', T, '2026-10-31'), 20);
  assert.equal(C.giacenza(s, 'a1', T), 0);
  assert.deepEqual(C.lotti(s, 'a1', 'deg'), [{ lotto: 'A', scadenza: '2027-03', quantita: 18 }]);
});

/* ---------- Code 128 dei DDT (js/codice128.js) ---------- */

const K = require('../js/codice128.js');

// lettore indipendente dall'encoder: dalle larghezze ai valori, controllo e testo
function leggi128(moduli) {
  const mappa = {};
  K.SIMBOLI.forEach((p, v) => { mappa[p] = v; });
  const valori = [];
  for (let i = 0; i < moduli.length;) {
    const lung = moduli.length - i === 7 ? 7 : 6;
    const v = mappa[moduli.slice(i, i + lung).join('')];
    assert.notEqual(v, undefined, 'simbolo sconosciuto alla posizione ' + i);
    valori.push(v);
    i += lung;
  }
  assert.equal(valori[valori.length - 1], 106, 'manca lo stop');
  const dati = valori.slice(0, -2);
  let somma = dati[0];
  for (let j = 1; j < dati.length; j++) somma += dati[j] * j;
  assert.equal(somma % 103, valori[valori.length - 2], 'cifra di controllo sbagliata');
  let set = dati[0] === 105 ? 'C' : dati[0] === 104 ? 'B' : 'A';
  let testo = '';
  dati.slice(1).forEach((v) => {
    if (set === 'B' && v === 99) { set = 'C'; return; }
    if (set === 'C' && v === 100) { set = 'B'; return; }
    testo += set === 'C' ? String(v).padStart(2, '0') : String.fromCharCode(v + 32);
  });
  return testo;
}

test('Code 128: tabella dei simboli coerente (11 moduli, barre pari, tutti diversi)', () => {
  assert.equal(K.SIMBOLI.length, 107);
  assert.equal(new Set(K.SIMBOLI).size, 107);
  K.SIMBOLI.forEach((p, v) => {
    const w = p.split('').map(Number);
    assert.equal(w.reduce((a, b) => a + b, 0), v === 106 ? 13 : 11, 'simbolo ' + v);
    const barre = w.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
    assert.equal(barre % 2, 0, 'le barre del simbolo ' + v + ' devono sommare un numero pari');
  });
});

test('Code 128: numeri dei DDT e altri testi si rileggono uguali, con il set C per le cifre', () => {
  for (const t of ['DDT-2026-0001', 'DDT-2026-1234', 'RIC-2027-0042', '12345678', '1234567', 'A1', 'x', 'Lotto 12/a', '9', '0001-ABC', 'AB-123456-CD']) {
    assert.equal(leggi128(K.codifica(t).moduli), t, t);
  }
  const v = K.valori('DDT-2026-0001');
  assert.equal(v[0], 104, 'inizia con il set B');
  assert.ok(v.includes(99), 'passa al set C per le ultime cifre');
  assert.equal(v.length, 15);
  assert.equal(K.valori('12345678')[0], 105, 'solo cifre: set C dall\'inizio');
  // "PJJ123C" resta tutto nel set B: controllo = (start 104 + somma dei valori per la posizione) modulo 103 = 55
  const pjj = K.valori('PJJ123C');
  assert.equal(pjj[0], 104);
  assert.equal(pjj[pjj.length - 2], 55);
  assert.throws(() => K.valori(''), /vuoto/);
  assert.throws(() => K.valori('àè'), /non ammesso/);
});

test('Code 128: SVG con zona di silenzio, barre e testo leggibile', () => {
  const s = K.svg('DDT-2026-0007', { modulo: 2, altezza: 40 });
  assert.match(s, /^<svg [^>]*viewBox="0 0 \d+ 54"/);
  assert.match(s, /aria-label="Codice a barre DDT-2026-0007"/);
  assert.match(s, />DDT-2026-0007<\/text>/);
  const larghezza = Number(/viewBox="0 0 (\d+)/.exec(s)[1]);
  const moduli = K.codifica('DDT-2026-0007').moduli.reduce((a, b) => a + b, 0);
  assert.equal(larghezza, moduli + 2 * K.ZONA_SILENZIO);
  assert.equal((s.match(/M\d+ 0h/g) || []).length, Math.ceil(K.codifica('DDT-2026-0007').moduli.length / 2), 'una barra ogni due larghezze');
  assert.doesNotMatch(K.svg('A<&"', { testo: false }), /<text/);
  assert.match(K.svg('A<&"'), /A&lt;&amp;&quot;/);
});
