// Prove delle previsioni statistiche (versione 3.0, parte D): node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../js/previsioni.js');

const OGGI = '2026-11-01'; // domenica
const vicino = (a, b, tolleranza, testo) => assert.ok(Math.abs(a - b) <= tolleranza, (testo || '') + ': ' + a + ' invece di ' + b + ' (±' + tolleranza + ')');

// generatore con seme fisso: le prove danno sempre lo stesso risultato
function casuale(seme) {
  return () => { seme = (seme * 1664525 + 1013904223) % 4294967296; return seme / 4294967296; };
}
function normale(rnd) {
  let u = 0;
  while (!u) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

let seq = 0;
function mov(tipo, data, quantita, extra) {
  return Object.assign({ id: 'm' + (++seq), tipo, data, quantita, articoloId: 'a1', repartoId: 'deg', creato: seq }, extra || {});
}

function stato(movimenti, extra) {
  return Object.assign({
    impostazioni: { leadTimeGiorni: 7, periodoRevisioneGiorni: 7, livelloServizio: 0.95, storicoGiorni: 180 },
    reparti: [
      { id: 'far', nome: 'Farmacia', tipo: 'centrale', centrale: true },
      { id: 'deg', nome: 'Degenza', tipo: 'periferico' },
      { id: 'chi', nome: 'Chirurgia', tipo: 'periferico' },
      { id: 'r-transito', nome: 'In transito', tipo: 'transito' }
    ],
    articoli: [
      { id: 'a1', nome: 'PARACETAMOLO 1000 mg', categoria: 'FARMACI', prezzo: 1, pezziConfezione: 1, versione: 1 },
      { id: 'a2', nome: 'GARZE 10x10', categoria: 'PRESIDI', prezzo: 0.1, pezziConfezione: 1, versione: 1 }
    ],
    movimenti,
    ddt: [],
    ddtRighe: [],
    assortimento: []
  }, extra || {});
}

/* Consumi giornalieri per n giorni fino a ieri: valore(i) con i = 0 il giorno più vecchio. */
function consumiDa(n, valore, extra) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const q = Math.round(valore(i) * 1000) / 1000;
    if (q > 0) out.push(mov('consumo', P.aggiungiGiorni(OGGI, -n + i), q, extra));
  }
  return out;
}

test('inversa della normale', () => {
  vicino(P.normInv(0.5), 0, 1e-9, 'mediana');
  vicino(P.normInv(0.95), 1.644854, 1e-5, '95%');
  vicino(P.normInv(0.975), 1.959964, 1e-5, '97,5%');
  vicino(P.normInv(0.99), 2.326348, 1e-5, '99%');
  vicino(P.normInv(0.01), -2.326348, 1e-5, '1%');
});

test('serie giornaliera: consumi e perdite, giorni a zero, niente trasferimenti né annullati', () => {
  P.svuotaMemoria();
  const s = stato([
    mov('carico', '2026-10-20', 100, { repartoId: 'far' }),
    mov('trasferimento', '2026-10-21', 50, { repartoId: 'far', repartoDestId: 'deg' }),
    mov('consumo', '2026-10-22', 3),
    mov('consumo', '2026-10-22', 2),
    mov('perdita', '2026-10-24', 1),
    mov('consumo', '2026-10-25', 9, { annullato: { il: '2026-10-25T10:00:00Z', da: 'x', motivo: 'errore' } }),
    mov('rettifica', '2026-10-26', -4),
    mov('consumo', '2026-10-28', 4, { repartoId: 'chi' }),
    mov('consumo', '2026-11-01', 7) // oggi: la storia finisce ieri
  ]);
  const deg = P.serie(s, 'a1', 'deg', { oggi: OGGI });
  assert.equal(deg.inizio, '2026-10-21'); // primo movimento in Degenza (il trasferimento ricevuto)
  assert.equal(deg.fine, '2026-10-31');
  assert.deepEqual(deg.valori, [0, 5, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  const tutta = P.serie(s, 'a1', null, { oggi: OGGI });
  assert.equal(tutta.inizio, '2026-10-20'); // primo movimento nella struttura (il carico)
  assert.equal(tutta.valori.reduce((a, b) => a + b, 0), 10);
  const due = P.serie(s, 'a1', ['deg', 'chi'], { oggi: OGGI });
  assert.equal(due.valori.reduce((a, b) => a + b, 0), 10);
  assert.deepEqual(P.serie(s, 'a2', null, { oggi: OGGI }).valori, []);
  // la storia non va oltre storicoGiorni
  const lunga = stato(consumiDa(400, () => 1));
  assert.equal(P.serie(lunga, 'a1', null, { oggi: OGGI }).valori.length, 180);
});

test('raggruppamento per settimana (da lunedì) e per mese', () => {
  const serie = { inizio: '2026-10-01', valori: new Array(31).fill(1) }; // 1° ottobre 2026 è giovedì
  const sett = P.aggrega(serie, 'settimana');
  assert.equal(sett[0].chiave, '2026-09-28');
  assert.equal(sett[0].valore, 4);
  assert.equal(sett[0].completo, false);
  assert.equal(sett[1].chiave, '2026-10-05');
  assert.equal(sett[1].valore, 7);
  assert.equal(sett[1].completo, true);
  assert.equal(sett.reduce((a, p) => a + p.valore, 0), 31);
  const mesi = P.aggrega({ inizio: '2026-09-29', valori: new Array(5).fill(2) }, 'mese');
  assert.deepEqual(mesi.map((p) => [p.chiave, p.valore, p.completo]), [['2026-09', 4, false], ['2026-10', 6, false]]);
  assert.equal(mesi[1].etichetta, 'ott 2026');
});

test('serie costante: previsione uguale, nessuna incertezza, punto di riordino = consumo × giorni di consegna', () => {
  P.svuotaMemoria();
  const s = stato([mov('carico', P.aggiungiGiorni(OGGI, -120), 1000, { repartoId: 'far' })].concat(consumiDa(120, () => 5)));
  const st = P.stima(P.serie(s, 'a1', null, { oggi: OGGI }).valori);
  assert.deepEqual(st.prevedi(5), [5, 5, 5, 5, 5]);
  vicino(st.mae, 0, 1e-9, 'errore di retro-verifica');
  vicino(st.sigma, 0, 1e-9, 'sigma');
  const r = P.analizza(s, { oggi: OGGI, orizzonte: 30 }).righe.find((x) => x.articoloId === 'a1');
  vicino(r.mediaGiorno, 5, 1e-9, 'media giornaliera');
  vicino(r.mediaSettimana, 35, 1e-9, 'media settimanale');
  vicino(r.mediaMese, 5 * 365.25 / 12, 1e-9, 'media mensile');
  assert.equal(r.tendenza, 0);
  assert.equal(r.scortaSicurezza, 0);
  assert.equal(r.puntoRiordino, 35);
  assert.equal(r.fabbisogno, 70);
  assert.equal(r.giacenza, 400); // 1000 caricati (carico in farmacia) − 600 consumati
  assert.equal(r.copertura, 80);
  assert.equal(r.esaurimento, P.aggiungiGiorni(OGGI, 79));
  assert.equal(r.daOrdinare, 0);
  assert.equal(r.previstoOrizzonte, 150);
});

test('tendenza in crescita: Holt (o Holt-Winters) segue la crescita', () => {
  const rnd = casuale(21);
  const y = Array.from({ length: 150 }, (_, i) => Math.max(0, 5 + 0.08 * i + 0.5 * normale(rnd)));
  const st = P.stima(y);
  assert.ok(st.id === 'holt' || st.id === 'holtWinters', 'modello scelto: ' + st.id);
  const f = st.prevedi(7);
  const vero = 5 + 0.08 * 153;
  vicino(f[3], vero, 1.2, 'previsione fra 4 giorni');
  assert.ok(f[6] > f[0], 'la previsione cresce');
  assert.ok(P.tendenza(y) > 10, 'tendenza % positiva: ' + P.tendenza(y));
  // la media mobile resterebbe indietro: errore maggiore
  const mm = st.candidati.find((c) => c.id === 'mediaMobile');
  assert.ok(mm.mae > st.mae, 'media mobile peggiore');
});

test('stagionalità settimanale: Holt-Winters ritrova il ritmo dei giorni', () => {
  const rnd = casuale(5);
  const ritmo = [10, 12, 11, 13, 12, 4, 2];
  const y = Array.from({ length: 140 }, (_, i) => Math.max(0, ritmo[i % 7] + 0.6 * normale(rnd)));
  const st = P.stima(y);
  assert.equal(st.id, 'holtWinters');
  const f = st.prevedi(14);
  for (let h = 0; h < 14; h++) vicino(f[h], ritmo[(140 + h) % 7], 1.5, 'giorno ' + h);
  assert.ok(st.affidabilita.id === 'alta', 'affidabilità ' + st.affidabilita.id);
  // con meno di 4 settimane Holt-Winters non è fra i candidati
  assert.ok(P.candidati(y.slice(0, 27)).indexOf('holtWinters') < 0);
  assert.ok(P.candidati(y.slice(0, 28)).indexOf('holtWinters') >= 0);
});

test('domanda intermittente: Croston-SBA è fra i candidati e la media prevista è giusta', () => {
  const rnd = casuale(77);
  // un giorno su tre, 3-9 pezzi: media 2 al giorno
  const y = Array.from({ length: 168 }, () => (rnd() < 1 / 3 ? 3 + Math.floor(rnd() * 7) : 0));
  const vera = y.reduce((a, b) => a + b, 0) / y.length;
  assert.ok(P.candidati(y).indexOf('croston') >= 0);
  const cr = P.MODELLI.croston.adatta(y);
  const f = cr.prevedi(3);
  assert.equal(f[0], f[2]); // previsione piatta
  vicino(f[0], vera, vera * 0.25, 'Croston-SBA');
  // su molte serie l'errore medio del modello scelto resta piccolo (una serie sola può essere sfortunata)
  let errore = 0;
  for (let k = 0; k < 30; k++) {
    const z = Array.from({ length: 168 }, () => (rnd() < 1 / 3 ? 3 + Math.floor(rnd() * 7) : 0));
    errore += Math.abs(P.stima(z).prevedi(28).reduce((a, b) => a + b, 0) / 28 - 2) / 2;
  }
  assert.ok(errore / 30 < 0.25, 'errore relativo medio ' + (errore / 30));
  // a giorni alterni: 4, 0, 4, 0… → 2 al giorno
  const alterni = Array.from({ length: 120 }, (_, i) => (i % 2 ? 0 : 4));
  vicino(P.stima(alterni).prevedi(1)[0], 2, 0.15, 'giorni alterni');
});

test('l’intervallo di previsione si allarga con l’orizzonte', () => {
  const rnd = casuale(3);
  const y = Array.from({ length: 120 }, () => Math.max(0, 10 + 2 * normale(rnd)));
  const st = P.stima(y);
  assert.ok(st.sigma > 1 && st.sigma < 3.5, 'sigma ' + st.sigma);
  const b = P.banda(st, 30, 0.9);
  const larghezze = b.alto.map((a, i) => a - b.basso[i]);
  for (let i = 1; i < 30; i++) assert.ok(larghezze[i] >= larghezze[i - 1] - 1e-9, 'giorno ' + i);
  assert.ok(larghezze[29] > larghezze[0]);
  vicino(larghezze[0], 2 * P.normInv(0.95) * st.sigma, 1e-9, 'primo giorno: ±z·σ');
  // un periodo di 7 giorni ha più incertezza di un giorno, ma meno di 7 giorni presi uno per uno
  const s7 = P.sigmaPeriodo(st, 0, 7);
  assert.ok(s7 > st.sigma && s7 < 7 * P.sigmaPeriodo(st, 6, 1));
});

test('scorta di sicurezza, punto di riordino e quantità da ordinare (confezioni intere, merce in viaggio)', () => {
  P.svuotaMemoria();
  const rnd = casuale(9);
  const movimenti = [mov('carico', P.aggiungiGiorni(OGGI, -150), 2000, { repartoId: 'far', fornitore: 'Deposito Sud' })]
    .concat(consumiDa(140, () => Math.max(1, 10 + 2 * normale(rnd))));
  movimenti.push(mov('trasferimento', P.aggiungiGiorni(OGGI, -2), 30, { repartoId: 'far', repartoDestId: 'r-transito', ddtId: 'd1' }));
  const s = stato(movimenti, {
    ddt: [{ id: 'd1', numero: 'DDT-2026-0001', origineId: 'far', destinazioneId: 'chi', stato: 'in_transito' }],
    ddtRighe: [{ id: 'dr1', ddtId: 'd1', articoloId: 'a1', quantita: 30 }]
  });
  s.articoli[0].pezziConfezione = 10;
  s.articoli[0].leadTime = 5;
  s.impostazioni.livelloServizio = 0.9;
  const an = P.analizza(s, { oggi: OGGI, orizzonte: 30 });
  const r = an.righe.find((x) => x.articoloId === 'a1');
  const z = P.normInv(0.9);
  assert.equal(r.leadTime, 5); // giorni di consegna dell'articolo, non quelli generali
  vicino(r.scortaSicurezza, z * r.sigma * Math.sqrt(5), 0.001, 'scorta = z·σ·√LT');
  const prev = r.stima.prevedi(12);
  vicino(r.puntoRiordino, prev.slice(0, 5).reduce((a, b) => a + b, 0) + r.scortaSicurezza, 0.002, 'punto di riordino');
  vicino(r.fabbisogno, prev.reduce((a, b) => a + b, 0) + r.scortaSicurezza, 0.002, 'fabbisogno su LT + revisione');
  assert.equal(r.inViaggio, 30);
  const consumato = movimenti.filter((m) => m.tipo === 'consumo').reduce((a, m) => a + m.quantita, 0);
  vicino(r.giacenza, 2000 - consumato - 30, 0.001, 'giacenza della struttura (senza la merce in viaggio)');
  assert.equal(r.disponibile, Math.round((r.giacenza + 30) * 1000) / 1000);
  const manca = r.fabbisogno - r.disponibile;
  assert.equal(r.confezioni, manca > 0 ? Math.ceil(manca / 10) : 0);
  assert.equal(r.daOrdinare, r.confezioni * 10);
  assert.equal(r.daOrdinare % 10, 0);
  assert.equal(r.fornitore, 'Deposito Sud'); // dall'ultimo carico
  // con poca merce si ordina, sempre a confezioni intere e mai in negativo
  s.movimenti.push(mov('perdita', P.aggiungiGiorni(OGGI, 0), r.giacenza - 3, { repartoId: 'far' }));
  s.movimenti = s.movimenti.slice();
  const r2 = P.analizza(s, { oggi: OGGI, orizzonte: 30 }).righe.find((x) => x.articoloId === 'a1');
  assert.equal(r2.disponibile, 33);
  assert.ok(r2.sottoRiordino);
  assert.equal(r2.confezioni, Math.ceil((r2.fabbisogno - 33) / 10));
  assert.ok(r2.daOrdinare >= r2.fabbisogno - 33 && r2.daOrdinare < r2.fabbisogno - 33 + 10);
  assert.ok(r2.copertura < 5);
});

test('ABC per valore (80/15/5) e XYZ per variabilità', () => {
  const righe = [
    { id: 'x', valoreStorico: 700, totaleStorico: 1 },
    { id: 'y', valoreStorico: 150, totaleStorico: 1 },
    { id: 'z', valoreStorico: 90, totaleStorico: 1 },
    { id: 'w', valoreStorico: 50, totaleStorico: 1 },
    { id: 'v', valoreStorico: 10, totaleStorico: 1 },
    { id: 'u', valoreStorico: 0, totaleStorico: 0 }
  ];
  P.classificaABC(righe);
  // quota cumulata prima dell'articolo: 0% A, 70% A, 85% B, 94% B, 99% C; senza valore C
  assert.deepEqual(righe.map((r) => r.abc).join(''), 'AABBCC');
  // regolare: X; settimane molto diverse: Z
  assert.equal(P.classeXYZ(P.coefficienteVariazione(new Array(56).fill(3))), 'X');
  const irregolare = new Array(56).fill(0);
  irregolare[3] = 40; irregolare[30] = 2;
  assert.equal(P.classeXYZ(P.coefficienteVariazione(irregolare)), 'Z');
  const medio = [];
  for (let w = 0; w < 8; w++) for (let d = 0; d < 7; d++) medio.push(w % 2 ? 3 : 4); // settimane da 21 e 28
  assert.equal(P.classeXYZ(P.coefficienteVariazione(medio)), 'X');
  assert.equal(P.classeXYZ(0.8), 'Y');
  assert.equal(P.classeXYZ(null), null);
});

test('analisi di un ambito: matrice ABC-XYZ, totali e memoria', () => {
  P.svuotaMemoria();
  const s = stato(consumiDa(90, () => 4).concat(consumiDa(90, (i) => (i % 3 ? 0 : 6), { articoloId: 'a2', repartoId: 'chi' })));
  const an = P.analizza(s, { oggi: OGGI, orizzonte: 7 });
  assert.equal(an.righe.length, 2);
  assert.equal(an.totali.conConsumi, 2);
  const somma = Object.keys(an.matrice).reduce((t, k) => t + an.matrice[k].articoli, 0);
  assert.equal(somma, 2);
  assert.equal(an.righe.find((r) => r.articoloId === 'a1').abc, 'A');
  assert.equal(P.analizza(s, { oggi: OGGI, orizzonte: 7 }), an, 'stesso risultato dalla memoria');
  // un magazzino: solo gli articoli che vi si muovono
  const chi = P.analizza(s, { oggi: OGGI, orizzonte: 7, reparti: 'chi' });
  assert.deepEqual(chi.righe.map((r) => r.articoloId), ['a2']);
  // dati nuovi (un altro elenco di movimenti): si ricalcola
  const s2 = Object.assign({}, s, { movimenti: s.movimenti.concat([mov('consumo', P.aggiungiGiorni(OGGI, -1), 100)]) });
  const an2 = P.analizza(s2, { oggi: OGGI, orizzonte: 7 });
  assert.notEqual(an2, an);
  assert.ok(an2.righe.find((r) => r.articoloId === 'a1').totaleStorico > an.righe.find((r) => r.articoloId === 'a1').totaleStorico);
});

test('prepara a pezzi e poi analizza subito', async () => {
  P.svuotaMemoria();
  const s = stato(consumiDa(60, () => 2));
  assert.equal(P.pronto(s, { oggi: OGGI }), false);
  let ultimo = null;
  await P.prepara(s, { oggi: OGGI }, (fatti, tot) => { ultimo = [fatti, tot]; });
  assert.deepEqual(ultimo, [2, 2]);
  assert.equal(P.pronto(s, { oggi: OGGI }), true);
});

test('consumo giornaliero previsto (richieste) e consumo medio (assortimento)', () => {
  P.svuotaMemoria();
  const movimenti = consumiDa(84, () => 3);
  // la farmacia centrale dà 70 a Degenza negli ultimi 70 giorni e consuma 1 al giorno
  for (let i = 1; i <= 70; i++) movimenti.push(mov('trasferimento', P.aggiungiGiorni(OGGI, -i), 1, { repartoId: 'far', repartoDestId: 'deg' }));
  movimenti.push(mov('consumo', P.aggiungiGiorni(OGGI, -5), 7, { repartoId: 'far' }));
  const s = stato(movimenti);
  vicino(P.consumoGiornaliero(s, 'a1', 'deg', { oggi: OGGI }), 3, 0.001, 'Degenza');
  assert.equal(P.consumoGiornaliero(s, 'a2', 'deg', { oggi: OGGI }), 0);
  // consumoMedio: ultimi 28 giorni (oggi compreso): Degenza consuma 3 al giorno per 27 giorni (oggi niente)
  vicino(P.consumoMedio(s, 'a1', 'deg', 28, { oggi: OGGI }), 3 * 27 / 28, 1e-9, 'Degenza');
  // per la farmacia centrale contano anche i trasferimenti agli altri magazzini: (27 + 7) / 28
  vicino(P.consumoMedio(s, 'a1', 'far', 28, { oggi: OGGI }), (27 + 7) / 28, 1e-9, 'Farmacia');
  // storia del magazzino più corta: si divide per i giorni che ci sono
  vicino(P.consumoMedio(s, 'a1', 'far', 90, { oggi: OGGI }), (70 + 7) / 71, 1e-9, 'storia corta');
});

test('distribuzione: quanto la centrale ha dato a ogni magazzino (DDT ricevuti e trasferimenti diretti)', () => {
  P.svuotaMemoria();
  const s = stato([
    mov('carico', '2026-09-01', 500, { repartoId: 'far' }),
    // trasferimento diretto della 2.x
    mov('trasferimento', '2026-09-10', 40, { repartoId: 'far', repartoDestId: 'deg' }),
    // DDT ricevuto: partenza (verso In transito) e arrivo
    mov('trasferimento', '2026-10-05', 30, { repartoId: 'far', repartoDestId: 'r-transito', ddtId: 'd1' }),
    mov('trasferimento', '2026-10-06', 28, { repartoId: 'r-transito', repartoDestId: 'deg', ddtId: 'd1' }),
    mov('trasferimento', '2026-10-06', 2, { repartoId: 'r-transito', repartoDestId: 'far', ddtId: 'd1' }), // rientro della differenza
    // DDT ancora in viaggio verso Chirurgia
    mov('trasferimento', '2026-10-30', 12, { repartoId: 'far', repartoDestId: 'r-transito', ddtId: 'd2' }),
    // reso di Degenza alla farmacia
    mov('trasferimento', '2026-10-20', 5, { repartoId: 'deg', repartoDestId: 'far' }),
    mov('consumo', '2026-10-10', 9),
    mov('perdita', '2026-10-11', 1),
    mov('consumo', '2026-10-12', 50, { annullato: { il: 'x', da: 'y', motivo: 'z' } })
  ], {
    ddt: [
      { id: 'd1', origineId: 'far', destinazioneId: 'deg', stato: 'ricevuto_con_differenze' },
      { id: 'd2', origineId: 'far', destinazioneId: 'chi', stato: 'in_transito' }
    ],
    ddtRighe: [{ id: 'r1', ddtId: 'd1', articoloId: 'a1', quantita: 30 }, { id: 'r2', ddtId: 'd2', articoloId: 'a1', quantita: 12 }]
  });
  const d = P.distribuzione(s, { dal: '2026-09-01', al: '2026-10-31' });
  assert.equal(d.centraleId, 'far');
  assert.deepEqual(d.mesi, ['2026-09', '2026-10']);
  const deg = d.perArticolo.a1.deg;
  assert.equal(deg.dato, 68);
  assert.equal(deg.resi, 5);
  assert.equal(deg.consumato, 9);
  assert.equal(deg.perdite, 1);
  assert.equal(deg.giacenza, 40 + 28 - 5 - 9 - 1);
  assert.equal(d.perArticolo.a1.chi.inViaggio, 12);
  assert.equal(d.perArticolo.a1.chi.dato, 0);
  assert.equal(d.perMese['2026-09'].deg.a1, 40);
  assert.equal(d.perMese['2026-10'].deg.a1, 28);
  // solo ottobre
  const ott = P.distribuzione(s, { dal: '2026-10-01', al: '2026-10-31' });
  assert.equal(ott.perArticolo.a1.deg.dato, 28);
  const t = P.totaliDistribuzione(d, null, (a, q) => q * 2);
  assert.equal(t.totali.dato, 136);
  assert.equal(t.perMese['2026-10'].deg, 56);
  assert.equal(t.perMagazzino.chi.inViaggio, 24);
});

test('prestazioni: 50.000 movimenti e 300 articoli in tempi da pagina web', () => {
  P.svuotaMemoria();
  const rnd = casuale(42);
  const s = stato([]);
  s.articoli = [];
  for (let i = 0; i < 300; i++) s.articoli.push({ id: 'p' + i, nome: 'ART ' + i, categoria: i % 3 ? 'FARMACI' : 'PRESIDI', prezzo: 1 + (i % 7), pezziConfezione: 1 + (i % 4) * 5, versione: 1 });
  for (let k = 0; k < 50000; k++) {
    const d = P.aggiungiGiorni(OGGI, -Math.floor(rnd() * 365));
    const a = 'p' + Math.floor(rnd() * 300);
    const t = rnd();
    if (t < 0.05) s.movimenti.push({ id: 'x' + k, tipo: 'carico', data: d, articoloId: a, repartoId: 'far', quantita: 100 });
    else if (t < 0.15) s.movimenti.push({ id: 'x' + k, tipo: 'trasferimento', data: d, articoloId: a, repartoId: 'far', repartoDestId: rnd() < 0.5 ? 'deg' : 'chi', quantita: 10 });
    else s.movimenti.push({ id: 'x' + k, tipo: 'consumo', data: d, articoloId: a, repartoId: rnd() < 0.5 ? 'deg' : 'chi', quantita: 1 + Math.floor(rnd() * 4) });
  }
  let t0 = Date.now();
  const an = P.analizza(s, { oggi: OGGI, orizzonte: 30 });
  const prima = Date.now() - t0;
  assert.equal(an.righe.length, 300);
  t0 = Date.now();
  P.analizza(s, { oggi: OGGI, orizzonte: 90 });
  const seconda = Date.now() - t0;
  t0 = Date.now();
  P.distribuzione(s, { dal: '2026-01-01', al: OGGI });
  const distr = Date.now() - t0;
  // limiti larghi: servono a scoprire un rallentamento grave, non a misurare la macchina
  assert.ok(prima < 4000, 'prima analisi ' + prima + ' ms');
  assert.ok(seconda < 500, 'cambio di orizzonte ' + seconda + ' ms (le stime restano in memoria)');
  assert.ok(distr < 1000, 'distribuzione ' + distr + ' ms');
});

/* ---------- esportazione Excel della proposta d'ordine (js/excel-ordini.js) ---------- */

// ExcelJS si carica nello stesso contesto della pagina finta: gli elenchi passati a addRow devono essere suoi
function caricaExcel() {
  const ExcelJS = require('../vendor/exceljs.min.js');
  const ctx = { Blob, Uint8Array, Promise, console, Date, Math, setTimeout, clearTimeout, setImmediate, TextDecoder, TextEncoder, Buffer, process };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['vendor/exceljs.min.js', 'js/excel-ordini.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, ExcelJS };
}

test('Excel della proposta d’ordine: riepilogo e un foglio per fornitore', async () => {
  const { ctx, ExcelJS } = caricaExcel();
  const blob = await ctx.ExcelOrdini.propostaOrdine({
    struttura: 'Clinica Demo',
    data: '2026-11-01',
    note: 'Giorni di consegna 7 · revisione ogni 7 giorni · livello di servizio 95%',
    gruppi: [
      { fornitore: 'Deposito Sud', righe: [
        { nome: 'PARACETAMOLO 1000 mg', codice: 'AIC 012345676', confezione: 'scatola da 10', pezziConfezione: 10, confezioni: 3, unita: 'fl', disponibile: 12, fabbisogno: 40, prezzo: 1.2 },
        { nome: 'KETOROLAC 30 mg', codice: '', confezione: '', pezziConfezione: 1, confezioni: 5, unita: 'f', disponibile: 0, fabbisogno: 5, prezzo: 0.45 }
      ] },
      { fornitore: '', righe: [{ nome: 'GARZE 10x10', codice: '', confezione: '', pezziConfezione: 100, confezioni: 2, unita: 'pz', disponibile: 50, fabbisogno: 230, prezzo: 0.02 }] }
    ]
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  const nomi = wb.worksheets.map((w) => w.name);
  assert.deepEqual(nomi, ['Proposta d’ordine', 'Deposito Sud', 'Senza fornitore']);
  const ws = wb.getWorksheet('Deposito Sud');
  const celle = [];
  ws.eachRow((r) => celle.push(r.values.slice(1)));
  const riga = celle.find((v) => v[0] === 'PARACETAMOLO 1000 mg');
  assert.ok(riga, 'riga dell’articolo');
  assert.ok(riga.indexOf(3) >= 0, 'confezioni');
  assert.ok(riga.indexOf(30) >= 0, 'unità = confezioni × pezzi');
  const tutto = JSON.stringify(celle);
  assert.ok(/Totale/.test(tutto));
  assert.ok(/Clinica Demo/.test(JSON.stringify(wb.getWorksheet('Proposta d’ordine').getRow(1).values)));
});

test('Excel della distribuzione: fogli per magazzino, per mese e articolo × magazzino', async () => {
  const { ctx, ExcelJS } = caricaExcel();
  const blob = await ctx.ExcelOrdini.distribuzione({
    struttura: 'Clinica Demo', periodo: 'dal 01/09/2026 al 31/10/2026', misura: 'Quantità',
    magazzini: [{ id: 'deg', nome: 'Degenza' }, { id: 'chi', nome: 'Chirurgia' }],
    perMagazzino: [{ nome: 'Degenza', dato: 68, resi: 5, consumato: 9, perdite: 1, giacenza: 53, inViaggio: 0 }],
    mesi: [{ etichetta: 'set 2026', valori: [40, 0] }, { etichetta: 'ott 2026', valori: [28, 0] }],
    righe: [{ nome: 'PARACETAMOLO', categoria: 'FARMACI', magazzino: 'Degenza', dato: 68, resi: 5, consumato: 9, perdite: 1, giacenza: 53, inViaggio: 0 }]
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  assert.equal(wb.worksheets.length, 3);
  const mesi = wb.worksheets[1];
  const valori = [];
  mesi.eachRow((r) => valori.push(r.values.slice(1)));
  assert.ok(valori.some((v) => v[0] === 'set 2026' && v[1] === 40));
});
