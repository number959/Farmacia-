// Prove della parte B (versione 3.0): magazzini, armadi, assortimento e ubicazioni (server/struttura.js).
// Avvia il server vero su una porta libera con una cartella dati temporanea.   node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ESEGUIBILE = process.env.GF_ESEGUIBILE;
const PW = 'Password-123';

function portaLibera() {
  return new Promise((ok) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}

async function avviaServer() {
  const porta = await portaLibera();
  const dati = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-struttura-'));
  const comando = ESEGUIBILE || process.execPath;
  const argomenti = (ESEGUIBILE ? [] : [path.join(__dirname, '..', 'server', 'main.js')]).concat(['--porta', String(porta), '--dati', dati]);
  const proc = spawn(comando, argomenti, { stdio: ['ignore', 'pipe', 'pipe'] });
  let uscita = '';
  proc.stdout.on('data', (d) => { uscita += d; });
  proc.stderr.on('data', (d) => { uscita += d; });
  const base = 'http://127.0.0.1:' + porta;
  for (let i = 0; i < (ESEGUIBILE ? 600 : 100); i++) {
    try { const r = await fetch(base + '/api/stato'); if (r.ok) break; } catch (e) { /* non ancora pronto */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base, dati, uscita: () => uscita,
    ferma: () => new Promise((ok) => {
      proc.once('exit', () => { try { fs.rmSync(dati, { recursive: true, force: true }); } catch (e) { /* resta */ } ok(); });
      proc.kill('SIGTERM');
    })
  };
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async chiama(metodo, percorso, corpo) {
    const h = { 'Content-Type': 'application/json' };
    if (metodo !== 'GET') h['X-Richiesta'] = '1';
    if (this.cookie) h.Cookie = this.cookie;
    const r = await fetch(this.base + percorso, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const tipo = r.headers.get('content-type') || '';
    const json = tipo.includes('json') ? await r.json() : (await r.arrayBuffer(), null);
    return { stato: r.status, json };
  }
  get(p) { return this.chiama('GET', p); }
  post(p, c) { return this.chiama('POST', p, c || {}); }
  put(p, c) { return this.chiama('PUT', p, c || {}); }
  del(p) { return this.chiama('DELETE', p); }
}

function oggi() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

let S;
let admin;
const U = {}; // farma, rep (Degenza), dir (consultazione)
const ART = {}; // id degli articoli di prova

async function dati(c, da) { return (await (c || admin).get('/api/dati?da=' + (da || 0))).json; }
function trova(lista, id) { return lista.find((x) => x.id === id); }

test.before(async () => {
  S = await avviaServer();
  admin = new Client(S.base);
  const setup = await admin.post('/api/setup', { username: 'admin', nome: 'Amministratore Prova', password: PW });
  assert.equal(setup.stato, 200, JSON.stringify(setup.json));
  for (const [chiave, username, ruolo, reparti] of [['farma', 'farma', 'farmacista', []], ['rep', 'infermiera', 'reparto', ['r-degenza']], ['dir', 'direzione', 'consultazione', []]]) {
    const r = await admin.post('/api/utenti', { username, nome: username, ruolo, reparti, password: 'Provvisoria1' });
    assert.equal(r.stato, 200, JSON.stringify(r.json));
    const c = new Client(S.base);
    assert.equal((await c.post('/api/login', { username, password: 'Provvisoria1' })).stato, 200);
    assert.equal((await c.post('/api/password', { attuale: 'Provvisoria1', nuova: PW })).stato, 200);
    U[chiave] = { client: c, id: r.json.utente.id };
  }
  for (const [chiave, nome] of [['para', 'PARACETAMOLO 1000 mg prova'], ['keto', 'KETOROLAC 30 mg prova'], ['garze', 'GARZE STERILI prova'], ['insu', 'INSULINA prova']]) {
    const r = await admin.post('/api/articoli', { nome, categoria: chiave === 'garze' ? 'PRESIDI' : 'FARMACI', unita: 'pz' });
    assert.equal(r.stato, 200, JSON.stringify(r.json));
    ART[chiave] = r.json.articolo.id;
  }
});

test.after(async () => { if (S) await S.ferma(); });

test('magazzini: creazione, controlli e permessi', async () => {
  const r = await admin.post('/api/magazzini', { nome: 'Degenza 2° piano', livello: 2, colore: '#3366CC', descrizione: 'Corridoio est' });
  assert.equal(r.stato, 200, JSON.stringify(r.json));
  const m = r.json.magazzino;
  assert.equal(m.tipo, 'periferico');
  assert.equal(m.centrale, false);
  assert.equal(m.piano, '2° piano'); // dal livello, se il piano non è scritto
  assert.equal(m.livello, 2);
  assert.equal(m.colore, '#3366cc');
  assert.equal(m.attivo, true);
  const d = await dati();
  assert.ok(trova(d.reparti, m.id), 'il magazzino nuovo arriva con /api/dati');

  assert.equal((await admin.post('/api/magazzini', { nome: 'degenza 2° PIANO' })).stato, 409, 'nome già usato');
  assert.equal((await admin.post('/api/magazzini', { nome: '' })).stato, 400);
  assert.equal((await admin.post('/api/magazzini', { nome: 'X', colore: 'rosso' })).stato, 400);
  assert.equal((await admin.post('/api/magazzini', { nome: 'X', tipo: 'transito' })).stato, 400);
  assert.equal((await admin.post('/api/magazzini', { nome: 'X', livello: 2.5 })).stato, 400);
  assert.equal((await admin.post('/api/magazzini', { nome: 'X', tipo: 'centrale', attivo: false })).stato, 400);
  for (const c of [U.farma, U.rep, U.dir]) {
    assert.equal((await c.client.post('/api/magazzini', { nome: 'Abusivo' })).stato, 403);
    assert.equal((await c.client.put('/api/magazzini/' + m.id, { nome: 'Abusivo' })).stato, 403);
    assert.equal((await c.client.del('/api/magazzini/' + m.id)).stato, 403);
  }

  // modifica parziale: i campi che mancano restano come sono
  const p = await admin.put('/api/magazzini/' + m.id, { piano: 'Secondo piano', ordine: 7 });
  assert.equal(p.stato, 200, JSON.stringify(p.json));
  assert.equal(p.json.magazzino.piano, 'Secondo piano');
  assert.equal(p.json.magazzino.nome, 'Degenza 2° piano');
  assert.equal(p.json.magazzino.ordine, 7);
  assert.equal((await admin.put('/api/magazzini/nessuno', { nome: 'Y' })).stato, 404);

  const att = await admin.get('/api/attivita?azione=magazzini');
  assert.ok(att.json.eventi.some((e) => e.azione === 'magazzini.crea'));
  assert.ok(att.json.eventi.some((e) => e.azione === 'magazzini.modifica'));
});

test('magazzini: un solo centrale, la farmacia centrale non si toglie', async () => {
  const nuovo = (await admin.post('/api/magazzini', { nome: 'Farmacia nuova', livello: -1 })).json.magazzino;
  const r = await admin.put('/api/magazzini/' + nuovo.id, { tipo: 'centrale' });
  assert.equal(r.stato, 200, JSON.stringify(r.json));
  let d = await dati();
  const centrali = d.reparti.filter((x) => x.tipo === 'centrale');
  assert.equal(centrali.length, 1);
  assert.equal(centrali[0].id, nuovo.id);
  assert.equal(centrali[0].centrale, true);
  const vecchia = trova(d.reparti, 'r-farmacia');
  assert.equal(vecchia.tipo, 'periferico');
  assert.equal(vecchia.centrale, false);
  // la centrale non diventa periferica da sola, non si disattiva e non si elimina
  assert.equal((await admin.put('/api/magazzini/' + nuovo.id, { tipo: 'periferico' })).stato, 400);
  assert.equal((await admin.put('/api/magazzini/' + nuovo.id, { attivo: false })).stato, 400);
  assert.equal((await admin.del('/api/magazzini/' + nuovo.id)).stato, 400);
  // si torna alla farmacia di prima
  const indietro = await admin.put('/api/magazzini/r-farmacia', { tipo: 'centrale' });
  assert.equal(indietro.stato, 200);
  d = await dati();
  assert.deepEqual(d.reparti.filter((x) => x.tipo === 'centrale').map((x) => x.id), ['r-farmacia']);
  assert.equal(trova(d.reparti, nuovo.id).centrale, false);
  // anche un magazzino nuovo può nascere centrale
  const terza = await admin.post('/api/magazzini', { nome: 'Farmacia di prova', tipo: 'centrale' });
  assert.equal(terza.stato, 200);
  d = await dati();
  assert.deepEqual(d.reparti.filter((x) => x.tipo === 'centrale').map((x) => x.id), [terza.json.magazzino.id]);
  assert.equal((await admin.put('/api/magazzini/r-farmacia', { tipo: 'centrale' })).stato, 200);
  assert.equal((await admin.del('/api/magazzini/' + terza.json.magazzino.id)).stato, 200);
  assert.equal((await admin.del('/api/magazzini/' + nuovo.id)).stato, 200);
});

test('magazzino «In transito»: intoccabile', async () => {
  assert.equal((await admin.put('/api/magazzini/r-transito', { nome: 'Altro' })).stato, 400);
  assert.equal((await admin.put('/api/magazzini/r-transito', { tipo: 'centrale' })).stato, 400);
  assert.equal((await admin.del('/api/magazzini/r-transito')).stato, 400);
  assert.equal((await admin.post('/api/armadi', { repartoId: 'r-transito', nome: 'Armadio' })).stato, 400);
  assert.equal((await U.farma.client.put('/api/assortimento', { repartoId: 'r-transito', righe: [{ articoloId: ART.para }] })).stato, 400);
  const d = await dati();
  const t = trova(d.reparti, 'r-transito');
  assert.equal(t.nome, 'In transito');
  assert.equal(t.tipo, 'transito');
});

test('armadi: creazione, controlli, riduzione ed eliminazione', async () => {
  const r = await admin.post('/api/armadi', { repartoId: 'r-degenza', nome: 'Armadio farmaci', tipo: 'armadio', ripiani: 4, colonne: 6, colore: '#AA5500' });
  assert.equal(r.stato, 200, JSON.stringify(r.json));
  const a = r.json.armadio;
  assert.deepEqual(Object.keys(a).sort(), ['attivo', 'colonne', 'colore', 'id', 'nome', 'note', 'ordine', 'repartoId', 'ripiani', 'tipo']);
  assert.equal(a.colore, '#aa5500');
  assert.equal(a.attivo, true);
  const frigo = await admin.post('/api/armadi', { repartoId: 'r-degenza', nome: 'Frigo', tipo: 'frigorifero', ripiani: 3, colonne: 4 });
  assert.equal(frigo.stato, 200);
  assert.equal(frigo.json.armadio.ordine, a.ordine + 1, 'ordine predefinito: in fondo');

  assert.equal((await admin.post('/api/armadi', { repartoId: 'r-degenza', nome: 'armadio FARMACI' })).stato, 409, 'nome già usato nel magazzino');
  assert.equal((await admin.post('/api/armadi', { repartoId: 'r-sala', nome: 'Armadio farmaci' })).stato, 200, 'stesso nome in un altro magazzino');
  assert.equal((await admin.post('/api/armadi', { repartoId: 'r-degenza', nome: 'X', ripiani: 13 })).stato, 400);
  assert.equal((await admin.post('/api/armadi', { repartoId: 'r-degenza', nome: 'X', colonne: 0 })).stato, 400);
  assert.equal((await admin.post('/api/armadi', { repartoId: 'r-degenza', nome: 'X', colonne: 21 })).stato, 400);
  assert.equal((await admin.post('/api/armadi', { repartoId: 'r-degenza', nome: 'X', tipo: 'scaffale' })).stato, 400);
  assert.equal((await admin.post('/api/armadi', { repartoId: 'nessuno', nome: 'X' })).stato, 400);
  assert.equal((await admin.post('/api/armadi', { nome: 'X' })).stato, 400);
  for (const c of [U.farma, U.rep, U.dir]) {
    assert.equal((await c.client.post('/api/armadi', { repartoId: 'r-degenza', nome: 'Abusivo' })).stato, 403);
    assert.equal((await c.client.put('/api/armadi/' + a.id, { nome: 'Abusivo' })).stato, 403);
    assert.equal((await c.client.del('/api/armadi/' + a.id)).stato, 403);
  }

  // due articoli negli ultimi posti: riducendo i posti per ripiano tornano liberi
  const u = await admin.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [
    { articoloId: ART.para, armadioId: a.id, ripiano: 1, posizione: 6 },
    { articoloId: ART.keto, armadioId: a.id, ripiano: 2, posizione: 1 }
  ] });
  assert.equal(u.stato, 200, JSON.stringify(u.json));
  const rid = await admin.put('/api/armadi/' + a.id, { colonne: 5 });
  assert.equal(rid.stato, 200, JSON.stringify(rid.json));
  assert.equal(rid.json.liberati, 1);
  assert.equal(rid.json.armadio.colonne, 5);
  assert.equal(rid.json.armadio.ripiani, 4, 'i campi che mancano restano come sono');
  let d = await dati();
  const riga = (art) => d.assortimento.find((x) => x.repartoId === 'r-degenza' && x.articoloId === art);
  assert.equal(riga(ART.para).armadioId, null);
  assert.equal(riga(ART.keto).armadioId, a.id);
  // non si sposta in un altro magazzino un armadio con articoli dentro
  assert.equal((await admin.put('/api/armadi/' + a.id, { repartoId: 'r-sala' })).stato, 409);

  // eliminando l'armadio le caselle tornano libere e i browser lo sanno
  const prima = d.rev;
  const del = await admin.del('/api/armadi/' + a.id);
  assert.equal(del.stato, 200);
  assert.equal(del.json.liberati, 1);
  const cambi = await dati(admin, prima);
  assert.equal(cambi.completo, false);
  assert.ok(cambi.cancellati.some((c) => c.tabella === 'armadi' && c.id === a.id), 'cancellazione sincronizzata con la chiave di App.S');
  const k = cambi.assortimento.find((x) => x.articoloId === ART.keto && x.repartoId === 'r-degenza');
  assert.ok(k, 'la riga dell’assortimento liberata arriva fra i cambiamenti');
  assert.equal(k.armadioId, null);
  assert.equal(k.ripiano, null);
  assert.equal(k.posizione, null);
  assert.equal((await admin.del('/api/armadi/' + a.id)).stato, 404);
  d = await dati();
  assert.ok(!trova(d.armadi, a.id));
  const att = await admin.get('/api/attivita?azione=armadi');
  assert.ok(['armadi.crea', 'armadi.modifica', 'armadi.elimina'].every((x) => att.json.eventi.some((e) => e.azione === x)));
});

test('assortimento: soglie, permessi, nessuna scrittura inutile, articolo tolto', async () => {
  const f = U.farma.client;
  const r = await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [
    { articoloId: ART.para, scortaMin: 5, puntoRiordino: 10, scortaMax: 20, note: 'prova' },
    { articoloId: ART.garze, scortaMin: '2,5', puntoRiordino: 0, scortaMax: 0 }
  ] });
  assert.equal(r.stato, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, Object.assign({ rev: r.json.rev }, { nuove: 2, modificate: 0, tolte: 0 }));
  let d = await dati();
  const riga = (rep, art) => d.assortimento.find((x) => x.repartoId === rep && x.articoloId === art);
  const p = riga('r-sala', ART.para);
  assert.deepEqual(Object.keys(p).sort(), ['armadioId', 'articoloId', 'attivo', 'id', 'note', 'posizione', 'puntoRiordino', 'repartoId', 'ripiano', 'scortaMax', 'scortaMin']);
  assert.equal(p.scortaMin, 5);
  assert.equal(p.puntoRiordino, 10);
  assert.equal(p.scortaMax, 20);
  assert.equal(p.attivo, true);
  assert.equal(riga('r-sala', ART.garze).scortaMin, 2.5);

  // stesse righe: niente da scrivere, la revisione non cambia
  const uguale = await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.para, scortaMin: 5, puntoRiordino: 10, scortaMax: 20, note: 'prova' }] });
  assert.equal(uguale.stato, 200);
  assert.equal(uguale.json.modificate, 0);
  assert.equal(uguale.json.rev, d.rev);

  // controlli: minima ≤ riordino ≤ massima (quando indicate)
  const e1 = await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.para, scortaMin: 12, puntoRiordino: 10, scortaMax: 20 }] });
  assert.equal(e1.stato, 400);
  assert.match(e1.json.errore, /PARACETAMOLO.*scorta minima/);
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.para, scortaMin: 1, puntoRiordino: 30, scortaMax: 20 }] })).stato, 400);
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.para, scortaMin: 25, puntoRiordino: 0, scortaMax: 20 }] })).stato, 400);
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.para, scortaMin: -1 }] })).stato, 400);
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.para, scortaMin: 'tanti' }] })).stato, 400);
  // solo con la massima indicata, senza punto di riordino: va bene
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.keto, scortaMin: 3, scortaMax: 9 }] })).stato, 200);
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [] })).stato, 400);
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: 'nessuno' }] })).stato, 400);
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.para }, { articoloId: ART.para }] })).stato, 400);
  // il responsabile di magazzino e la direzione non cambiano l'assortimento
  assert.equal((await U.rep.client.put('/api/assortimento', { repartoId: 'r-degenza', righe: [{ articoloId: ART.para, scortaMin: 1 }] })).stato, 403);
  assert.equal((await U.dir.client.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.para, scortaMin: 1 }] })).stato, 403);

  // articolo tolto: la riga resta (attivo false) e lascia libera la casella
  const arm = (await admin.post('/api/armadi', { repartoId: 'r-sala', nome: 'Carrello', tipo: 'carrello', ripiani: 3, colonne: 4 })).json.armadio;
  assert.equal((await admin.put('/api/ubicazioni', { repartoId: 'r-sala', righe: [{ articoloId: ART.para, armadioId: arm.id, ripiano: 1, posizione: 1 }] })).stato, 200);
  const tolta = await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.para, attivo: false }] });
  assert.equal(tolta.stato, 200, JSON.stringify(tolta.json));
  assert.equal(tolta.json.tolte, 1);
  d = await dati();
  const t = riga('r-sala', ART.para);
  assert.equal(t.attivo, false);
  assert.equal(t.armadioId, null);
  assert.equal(t.scortaMin, 5, 'le soglie restano per quando si rimette');
  // si rimette: torna attivo con le soglie di prima
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: ART.para, attivo: true }] })).json.modificate, 1);
  d = await dati();
  assert.equal(riga('r-sala', ART.para).attivo, true);
  const att = await admin.get('/api/attivita?azione=assortimento');
  assert.ok(att.json.eventi.some((e) => e.azione === 'assortimento.modifica' && e.username === 'farma'));

  // un articolo non attivo non entra in un assortimento né in un armadio; dove c'è già, le soglie si cambiano
  const vecchio = (await admin.post('/api/articoli', { nome: 'ARTICOLO DISMESSO prova', categoria: 'FARMACI', unita: 'pz' })).json.articolo;
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: vecchio.id, scortaMin: 1 }] })).stato, 200);
  const spento = await admin.put('/api/articoli/' + vecchio.id, Object.assign({}, vecchio, { attivo: false }));
  assert.equal(spento.stato, 200, JSON.stringify(spento.json));
  assert.equal((await f.put('/api/assortimento', { repartoId: 'r-sala', righe: [{ articoloId: vecchio.id, scortaMin: 2 }] })).stato, 200);
  const nuovoSpento = await f.put('/api/assortimento', { repartoId: 'r-ambulatori', righe: [{ articoloId: vecchio.id, scortaMin: 1 }] });
  assert.equal(nuovoSpento.stato, 400);
  assert.match(nuovoSpento.json.errore, /non è attivo/);
  assert.equal((await admin.put('/api/ubicazioni', { repartoId: 'r-ambulatori', righe: [{ articoloId: vecchio.id, armadioId: null }] })).stato, 200, 'toglierlo da un armadio va sempre bene');
});

test('ubicazioni: una casella un articolo, magazzini propri, aggiunta all’assortimento', async () => {
  const arm = (await admin.post('/api/armadi', { repartoId: 'r-degenza', nome: 'Armadio corridoio', ripiani: 2, colonne: 3 })).json.armadio;
  const altroMag = (await admin.post('/api/armadi', { repartoId: 'r-ambulatori', nome: 'Armadio ambulatori', ripiani: 2, colonne: 2 })).json.armadio;
  const rep = U.rep.client;
  // l'insulina non è nell'assortimento della Degenza: ci entra con le scorte a zero
  const r = await rep.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.insu, armadioId: arm.id, ripiano: 1, posizione: 1 }] });
  assert.equal(r.stato, 200, JSON.stringify(r.json));
  assert.equal(r.json.aggiunte, 1);
  let d = await dati();
  const riga = (art) => d.assortimento.find((x) => x.repartoId === 'r-degenza' && x.articoloId === art);
  const i = riga(ART.insu);
  assert.equal(i.armadioId, arm.id);
  assert.equal(i.ripiano, 1);
  assert.equal(i.posizione, 1);
  assert.equal(i.scortaMin, 0);
  assert.equal(i.scortaMax, 0);
  assert.equal(i.attivo, true);

  // casella occupata
  const occ = await rep.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.garze, armadioId: arm.id, ripiano: 1, posizione: 1 }] });
  assert.equal(occ.stato, 409);
  assert.match(occ.json.errore, /INSULINA/);
  // scambio di due articoli nella stessa richiesta: va bene
  assert.equal((await rep.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.garze, armadioId: arm.id, ripiano: 2, posizione: 3 }] })).stato, 200);
  const scambio = await rep.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [
    { articoloId: ART.garze, armadioId: arm.id, ripiano: 1, posizione: 1 },
    { articoloId: ART.insu, armadioId: arm.id, ripiano: 2, posizione: 3 }
  ] });
  assert.equal(scambio.stato, 200, JSON.stringify(scambio.json));
  assert.equal(scambio.json.spostate, 2);
  d = await dati();
  assert.equal(riga(ART.garze).ripiano, 1);
  assert.equal(riga(ART.insu).ripiano, 2);
  // stessa posizione di prima: niente da scrivere
  const ferma = await rep.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.garze, armadioId: arm.id, ripiano: 1, posizione: 1 }] });
  assert.equal(ferma.json.spostate, 0);
  assert.equal(ferma.json.rev, d.rev);

  // controlli
  assert.equal((await rep.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.keto, armadioId: arm.id, ripiano: 3, posizione: 1 }] })).stato, 400);
  assert.equal((await rep.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.keto, armadioId: arm.id, ripiano: 1, posizione: 4 }] })).stato, 400);
  assert.equal((await rep.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.keto, armadioId: arm.id }] })).stato, 400);
  assert.equal((await rep.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.keto, armadioId: altroMag.id, ripiano: 1, posizione: 1 }] })).stato, 400, 'armadio di un altro magazzino');
  assert.equal((await rep.put('/api/ubicazioni', { repartoId: 'r-ambulatori', righe: [{ articoloId: ART.keto, armadioId: altroMag.id, ripiano: 1, posizione: 1 }] })).stato, 403, 'magazzino non suo');
  assert.equal((await U.dir.client.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.keto, armadioId: null }] })).stato, 403);
  // armadio non attivo
  assert.equal((await admin.put('/api/armadi/' + altroMag.id, { attivo: false })).stato, 200);
  assert.equal((await admin.put('/api/ubicazioni', { repartoId: 'r-ambulatori', righe: [{ articoloId: ART.keto, armadioId: altroMag.id, ripiano: 1, posizione: 1 }] })).stato, 400);
  // il farmacista sistema gli armadi di tutti i magazzini
  assert.equal((await U.farma.client.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.keto, armadioId: arm.id, ripiano: 1, posizione: 2 }] })).stato, 200);

  // togliere dall'armadio (armadioId null)
  const via = await rep.put('/api/ubicazioni', { repartoId: 'r-degenza', righe: [{ articoloId: ART.insu, armadioId: null }] });
  assert.equal(via.stato, 200);
  d = await dati();
  assert.equal(riga(ART.insu).armadioId, null);
  assert.equal(riga(ART.insu).attivo, true, 'resta nell’assortimento');
  const att = await admin.get('/api/attivita?azione=ubicazioni');
  assert.ok(att.json.eventi.some((e) => e.azione === 'ubicazioni.modifica' && e.username === 'infermiera'));
});

test('magazzini: eliminazione solo se mai usato, con armadi, assortimento e utenti', async () => {
  const m = (await admin.post('/api/magazzini', { nome: 'Day hospital', livello: 3 })).json.magazzino;
  const arm = (await admin.post('/api/armadi', { repartoId: m.id, nome: 'Armadio DH' })).json.armadio;
  assert.equal((await U.farma.client.put('/api/assortimento', { repartoId: m.id, righe: [{ articoloId: ART.para, scortaMin: 1 }] })).stato, 200);
  assert.equal((await admin.put('/api/ubicazioni', { repartoId: m.id, righe: [{ articoloId: ART.para, armadioId: arm.id, ripiano: 1, posizione: 1 }] })).stato, 200);
  // un responsabile assegnato anche al magazzino nuovo
  assert.equal((await admin.put('/api/utenti/' + U.rep.id, { nome: 'infermiera', ruolo: 'reparto', reparti: ['r-degenza', m.id], attivo: true })).stato, 200);
  let d = await dati();
  const prima = d.rev;
  const rigaAss = d.assortimento.find((x) => x.repartoId === m.id);

  const del = await admin.del('/api/magazzini/' + m.id);
  assert.equal(del.stato, 200, JSON.stringify(del.json));
  const cambi = await dati(admin, prima);
  assert.ok(cambi.cancellati.some((c) => c.tabella === 'reparti' && c.id === m.id));
  assert.ok(cambi.cancellati.some((c) => c.tabella === 'armadi' && c.id === arm.id));
  assert.ok(cambi.cancellati.some((c) => c.tabella === 'assortimento' && c.id === rigaAss.id));
  const utenti = (await admin.get('/api/utenti')).json.utenti;
  assert.deepEqual(utenti.find((u) => u.id === U.rep.id).reparti, ['r-degenza']);
  assert.equal((await admin.del('/api/magazzini/' + m.id)).stato, 404);

  // con un movimento non si elimina: si disattiva
  const usato = (await admin.post('/api/magazzini', { nome: 'Dialisi', livello: 1 })).json.magazzino;
  const mov = await admin.post('/api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(), articoloId: ART.garze, repartoId: usato.id, quantita: 10, lotto: 'L1', scadenza: '2030-01' }] });
  assert.equal(mov.stato, 200, JSON.stringify(mov.json));
  const no = await admin.del('/api/magazzini/' + usato.id);
  assert.equal(no.stato, 409);
  assert.match(no.json.errore, /Attivo/);
  // con un DDT da spedire non si disattiva (né si elimina): prima si annulla
  const ddt = await admin.post('/api/ddt', { origineId: usato.id, destinazioneId: 'r-degenza', righe: [{ articoloId: ART.garze, quantita: 2 }] });
  assert.equal(ddt.stato, 200, JSON.stringify(ddt.json));
  const occupato = await admin.put('/api/magazzini/' + usato.id, { attivo: false });
  assert.equal(occupato.stato, 409);
  assert.match(occupato.json.errore, /DDT/);
  assert.equal((await admin.del('/api/magazzini/' + usato.id)).stato, 409);
  assert.equal((await admin.post('/api/ddt/' + ddt.json.ddt.id + '/annulla', { motivo: 'prova' })).stato, 200);
  const dis = await admin.put('/api/magazzini/' + usato.id, { attivo: false });
  assert.equal(dis.stato, 200);
  assert.equal(dis.json.magazzino.attivo, false);
  d = await dati();
  assert.equal(trova(d.reparti, usato.id).attivo, false);
});
