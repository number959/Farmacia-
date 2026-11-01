// Prove della parte E (versione 3.0): giornale delle modifiche, copie verificate a scaglioni, base dati che si cura
// da sola (file danneggiati davvero, a server spento), prova di ripristino, seconda cartella, pagina Sistema.
// node --test tests/salute.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { DatabaseSync } = require('node:sqlite');
const B = require('../server/backup.js');
const G = require('../server/giornale.js');
const Sal = require('../server/salute.js');
const D = require('../server/db.js');

const ESEGUIBILE = process.env.GF_ESEGUIBILE; // per provare l'exe compilato (Linux) invece dei sorgenti
const PW = 'Password-123';
const TABELLE = ['reparti', 'articoli', 'movimenti', 'armadi', 'assortimento', 'richieste', 'richiesteRighe', 'ddt', 'ddtRighe'];

function portaLibera() {
  return new Promise((ok) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}

const CARTELLE = []; // cartelle temporanee da togliere alla fine
function cartellaNuova(nome) {
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-salute-' + (nome || '') + '-'));
  CARTELLE.push(c);
  return c;
}

/* opz.precarica: file JS caricato nel server prima di tutto (node -r), per esempio una seconda cartella lenta. */
async function avviaServer(dati, opz) {
  const porta = await portaLibera();
  dati = dati || cartellaNuova();
  const comando = ESEGUIBILE || process.execPath;
  const prima = !ESEGUIBILE && opz && opz.precarica ? ['-r', opz.precarica] : [];
  const argomenti = (ESEGUIBILE ? [] : prima.concat([path.join(__dirname, '..', 'server', 'main.js')])).concat(['--porta', String(porta), '--dati', dati]);
  const proc = spawn(comando, argomenti, { stdio: ['ignore', 'pipe', 'pipe'] });
  let uscita = '';
  proc.stdout.on('data', (d) => { uscita += d; });
  proc.stderr.on('data', (d) => { uscita += d; });
  const base = 'http://127.0.0.1:' + porta;
  let pronto = false;
  for (let i = 0; i < (ESEGUIBILE ? 600 : 150) && !pronto; i++) {
    try { pronto = (await fetch(base + '/api/stato')).ok; } catch (e) { /* non ancora pronto */ }
    if (!pronto) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(pronto, 'il server non parte: ' + uscita);
  const fine = new Promise((ok) => proc.once('exit', ok));
  return {
    porta, base, dati, proc, uscita: () => uscita,
    ferma: () => { proc.kill('SIGTERM'); return fine; },
    // spegnimento improvviso: niente copia di chiusura
    uccidi: () => { proc.kill('SIGKILL'); return fine; }
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
    let json = null;
    if ((r.headers.get('content-type') || '').includes('json')) json = await r.json(); else await r.arrayBuffer();
    return { stato: r.status, json };
  }
  get(p) { return this.chiama('GET', p); }
  post(p, c) { return this.chiama('POST', p, c || {}); }
  put(p, c) { return this.chiama('PUT', p, c || {}); }
  del(p) { return this.chiama('DELETE', p); }
}

function ok200(r) { assert.equal(r.stato, 200, JSON.stringify(r.json)); return r.json; }

function oggi() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* Tutti i dati del magazzino in una forma confrontabile (righe ordinate per id). */
function istantanea(d) {
  const out = { impostazioni: d.impostazioni };
  TABELLE.forEach((k) => { out[k] = d[k].slice().sort((a, b) => (a.id < b.id ? -1 : 1)); });
  return out;
}

async function utente(admin, base, username, ruolo, reparti) {
  ok200(await admin.post('/api/utenti', { username, nome: 'Utente ' + username, ruolo, reparti: reparti || [], password: 'Provvisoria1' }));
  const c = new Client(base);
  ok200(await c.post('/api/login', { username, password: 'Provvisoria1' }));
  ok200(await c.post('/api/password', { attuale: 'Provvisoria1', nuova: PW }));
  return c;
}

/* Il file si riapre e si chiude: il WAL rimasto dopo lo spegnimento improvviso finisce nel file principale. */
function chiudiBene(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  ['-wal', '-shm'].forEach((s) => { try { fs.unlinkSync(file + s); } catch (e) { /* non c'è */ } });
}

/* Danno vero: sovrascrive pagine nel mezzo del file con dati senza senso. */
function sovrascriviMezzo(file) {
  const dim = fs.statSync(file).size;
  const pagina = 4096;
  const da = Math.max(2 * pagina, Math.floor(dim / pagina / 2) * pagina - 4 * pagina);
  const quanti = Math.min(16 * pagina, dim - da - pagina);
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.alloc(quanti, 0x5a), 0, quanti, da);
  fs.closeSync(fd);
}

function quickCheck(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const r = db.prepare('PRAGMA quick_check').all().map((x) => Object.values(x)[0]);
    db.close();
    return r.join(' ');
  } catch (e) { return e.message; }
}

/* Seconda cartella lenta come un disco di rete carico: ogni file copiato in sottofondo aspetta ms millisecondi. */
function precaricaLenta(ms) {
  const f = path.join(cartellaNuova('lenta-js'), 'lenta.js');
  fs.writeFileSync(f, "const fsp = require('fs').promises;\nconst orig = fsp.copyFile.bind(fsp);\n" +
    'fsp.copyFile = (a, b, m) => new Promise((r) => setTimeout(r, ' + ms + ')).then(() => orig(a, b, m));\n');
  return f;
}

/* Aspetta che cond() sia vera (al massimo ms millisecondi). cosa: testo, o funzione che lo dà (letta alla fine). */
async function aspetta(cond, ms, cosa) {
  const fine = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fine) assert.fail('dopo ' + ms + ' ms ancora no: ' + (typeof cosa === 'function' ? cosa() : cosa));
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* Un po' di lavoro di ogni tipo: articolo, carico, richiesta → DDT spedito e ricevuto, armadio, impostazioni. */
async function lavora(a, etichetta) {
  const art = ok200(await a.post('/api/articoli', { nome: 'ART ' + etichetta, categoria: 'FARMACI', prezzo: 2 })).articolo;
  ok200(await a.post('/api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(), articoloId: art.id, repartoId: 'r-farmacia', quantita: 50, lotto: 'L-' + etichetta, scadenza: '2030-01' }] }));
  const ric = ok200(await a.post('/api/richieste', { repartoId: 'r-degenza', invia: true, righe: [{ articoloId: art.id, quantita: 5 }] }));
  const p = ok200(await a.post('/api/richieste/' + ric.richiesta.id + '/ddt', {}));
  ok200(await a.post('/api/ddt/' + p.ddt.id + '/spedisci', { trasportatoreNome: 'Gino' }));
  ok200(await a.post('/api/ddt/' + p.ddt.id + '/ricevi', {}));
  ok200(await a.post('/api/armadi', { repartoId: 'r-degenza', nome: 'Armadio ' + etichetta, ripiani: 2, colonne: 3 }));
  const imp = ok200(await a.get('/api/dati?da=0')).impostazioni;
  ok200(await a.put('/api/impostazioni', Object.assign({}, imp, { giorniAvvisoScadenza: 30 + etichetta.length })));
  return { art, ric: ric.richiesta, ddt: p.ddt };
}

function righeGiornale(dati) {
  const cartella = path.join(dati, 'giornale');
  return fs.readdirSync(cartella).filter((n) => /\.jsonl$/.test(n)).sort()
    .flatMap((n) => fs.readFileSync(path.join(cartella, n), 'utf8').split('\n').filter(Boolean).map((r) => JSON.parse(r)));
}

/* ---------- conservazione a scaglioni (date finte) ---------- */

test('conservazione a scaglioni delle copie automatiche', () => {
  const adesso = new Date(2026, 10, 1, 12, 30).getTime(); // 1 novembre 2026, 12:30 (ora locale)
  const ORA = 3600 * 1000;
  // una copia ogni ora per 400 giorni
  const copie = [];
  for (let i = 0; i < 400 * 24; i++) {
    const t = adesso - i * ORA - 10 * 60 * 1000;
    copie.push({ nome: 'c' + i, data: new Date(t).toISOString(), verificata: true });
  }
  const tenere = B.daConservare(copie, adesso);
  const tenute = copie.filter((c) => tenere.has(c.nome)).map((c) => new Date(c.data).getTime());
  // tutte quelle delle ultime 24 ore
  assert.equal(tenute.filter((t) => adesso - t < 24 * ORA).length, 24);
  // una per ognuno degli ultimi 14 giorni
  const giorni = new Set(tenute.filter((t) => adesso - t < 14 * 24 * ORA).map((t) => new Date(t).toDateString()));
  assert.ok(giorni.size >= 14, 'giorni: ' + giorni.size);
  // 12 mesi: la copia più vecchia tenuta ha circa un anno, nessuna oltre 13 mesi
  const piuVecchia = Math.min(...tenute);
  assert.ok(adesso - piuVecchia > 300 * 24 * ORA && adesso - piuVecchia < 400 * 24 * ORA, 'più vecchia: ' + new Date(piuVecchia));
  // numero totale: 24 orarie + 14 giornaliere + 8 settimanali + 12 mensili, con le sovrapposizioni
  assert.ok(tenere.size >= 40 && tenere.size <= 24 + 14 + 8 + 12, 'tenute ' + tenere.size);
  // una per settimana nelle ultime 8 settimane
  const settimane = new Set(tenute.filter((t) => adesso - t < 7 * 8 * 24 * ORA).map((t) => B.settimana(new Date(t))));
  assert.ok(settimane.size >= 8, 'settimane: ' + settimane.size);

  // dentro lo scaglione si preferisce una copia verificata; la verificata più recente resta sempre
  const ieri = new Date(2026, 9, 31, 22, 0).getTime();
  const due = [
    { nome: 'ieri-sera-rotta', data: new Date(ieri).toISOString(), verificata: false },
    { nome: 'ieri-pomeriggio', data: new Date(ieri - 5 * ORA).toISOString(), verificata: true },
    { nome: 'futuro', data: new Date(adesso + 48 * ORA).toISOString(), verificata: true }
  ];
  const t2 = B.daConservare(due, adesso + 30 * ORA);
  assert.ok(t2.has('ieri-pomeriggio'));
  assert.ok(!t2.has('ieri-sera-rotta'));
  assert.ok(t2.has('futuro'), 'una copia "dal futuro" (orologio spostato) non si tocca');

  // settimane ISO
  assert.equal(B.settimana(new Date(2026, 0, 1)), '2026-W01');
  assert.equal(B.settimana(new Date(2024, 11, 30)), '2025-W01');
  assert.equal(B.settimana(new Date(2027, 0, 1)), '2026-W53');

  // copie manuali e "prima del ripristino": le ultime 30, separatamente per magazzino e accessi
  const manuali = [];
  for (let i = 0; i < 35; i++) {
    const d = new Date(2026, 0, 1 + i, 10, 0, 0);
    const nome = 'farmacia_2026-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '_100000_manuale.db';
    manuali.push({ nome, prefisso: 'farmacia', tipo: 'manuale', data: d.toISOString() });
  }
  manuali.push({ nome: 'accessi_2026-01-01_100000_manuale.db', prefisso: 'accessi', tipo: 'manuale', data: new Date(2026, 0, 1).toISOString() });
  const via = B.daEliminare(manuali, adesso);
  assert.equal(via.length, 5);
  assert.ok(via.every((n) => n.startsWith('farmacia_2026-01-0')), via.join());
});

test('verifica delle copie: un file danneggiato non passa', () => {
  const dir = cartellaNuova('verifica');
  const file = path.join(dir, 'prova.db');
  const db = D.apriDati(file);
  db.exec("VACUUM INTO '" + path.join(dir, 'copia.db') + "'");
  db.close();
  const buona = B.verificaFile(path.join(dir, 'copia.db'), 'farmacia');
  assert.equal(buona.verificata, true, JSON.stringify(buona));
  assert.equal(buona.rev, 1);
  assert.ok(buona.conteggi.reparti >= 5);
  fs.truncateSync(path.join(dir, 'copia.db'), Math.floor(fs.statSync(path.join(dir, 'copia.db')).size / 2));
  const rotta = B.verificaFile(path.join(dir, 'copia.db'), 'farmacia');
  assert.equal(rotta.verificata, false);
  assert.ok(rotta.errore);
  fs.writeFileSync(path.join(dir, 'niente.db'), 'questo non è un database');
  assert.equal(B.verificaFile(path.join(dir, 'niente.db'), 'farmacia').verificata, false);
  // un archivio degli accessi non è una copia del magazzino
  const acc = D.apriAccessi(path.join(dir, 'acc.db'));
  acc.close();
  assert.match(B.verificaFile(path.join(dir, 'acc.db'), 'farmacia').errore, /mancano le tabelle/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('giornale: catena senza buchi e linee diverse', () => {
  const voci = [
    { rev: 5, base: 0, cambiamenti: {} }, { rev: 6, base: 0, cambiamenti: {} }, { rev: 8, base: 0, cambiamenti: {} },
    { rev: 10, base: 10, tipo: 'ripristino' }, { rev: 11, base: 10, cambiamenti: {} }
  ];
  const c = G.catena(voci, 4, 0);
  assert.deepEqual(c.voci.map((v) => v.rev), [5, 6]);
  assert.equal(c.finoA, 6);
  assert.deepEqual(c.buco, { da: 7, a: 7 });
  assert.deepEqual(c.lineaNuova, { rev: 10, base: 10 });
  const c2 = G.catena(voci, 10, 10);
  assert.deepEqual(c2.voci.map((v) => v.rev), [11]);
  assert.equal(c2.buco, null);
  assert.equal(c2.lineaNuova, null);
});

/* ---------- server vero: magazzino danneggiato ---------- */

let S;          // server della prova principale
let admin;
let ART;        // articolo dei dati di prova con giacenza in farmacia

test('giornale delle modifiche: una riga per scrittura, con fsync, nella forma di /api/dati', async () => {
  S = await avviaServer(cartellaNuova('principale'));
  admin = new Client(S.base);
  ok200(await admin.post('/api/setup', { username: 'admin', nome: 'Amministratore', password: PW }));
  ok200(await admin.post('/api/demo'));
  const d = ok200(await admin.get('/api/dati?da=0'));
  const righe = righeGiornale(S.dati);
  const ultima = righe[righe.length - 1];
  assert.equal(ultima.rev, d.rev);
  assert.equal(typeof ultima.storia, 'string');
  assert.equal(typeof ultima.base, 'number');
  assert.ok(!isNaN(Date.parse(ultima.quando)));
  // i dati di prova sono una scrittura sola: tutti i movimenti nella stessa riga
  assert.equal(ultima.cambiamenti.movimenti.length, d.movimenti.length);
  assert.ok(ultima.cambiamenti.articoli.length > 5);
  const nuovo = ok200(await admin.post('/api/articoli', { nome: 'GIORNALE DI PROVA', categoria: 'FARMACI' }));
  const r2 = righeGiornale(S.dati);
  const v = r2[r2.length - 1];
  assert.equal(v.rev, nuovo.rev);
  assert.deepEqual(Object.keys(v.cambiamenti), ['articoli'], 'solo le tabelle toccate');
  assert.equal(v.cambiamenti.articoli[0].nome, 'GIORNALE DI PROVA');
  // un articolo con giacenza nella farmacia centrale, per richieste e DDT
  const g = {};
  d.movimenti.filter((m) => m.repartoId === 'r-farmacia' && m.tipo === 'carico').forEach((m) => { g[m.articoloId] = (g[m.articoloId] || 0) + m.quantita; });
  ART = d.articoli.find((a) => g[a.id] > 20);
  assert.ok(ART);
});

test('permessi: solo l\'amministratore vede e usa la pagina Sistema', async () => {
  const farma = await utente(admin, S.base, 'farma', 'farmacista');
  const dir = await utente(admin, S.base, 'dir', 'consultazione');
  for (const c of [farma, dir]) {
    assert.equal((await c.get('/api/sistema')).stato, 403);
    assert.equal((await c.post('/api/sistema/controlla')).stato, 403);
    assert.equal((await c.post('/api/sistema/copia')).stato, 403);
    assert.equal((await c.post('/api/sistema/prova-ripristino')).stato, 403);
    assert.equal((await c.put('/api/sistema/seconda-cartella', { percorso: os.tmpdir() })).stato, 403);
  }
  const anonimo = new Client(S.base);
  assert.equal((await anonimo.get('/api/sistema')).stato, 401);
  const st = ok200(await admin.get('/api/sistema'));
  assert.equal(st.versione.split('.')[0], '3');
  assert.ok(st.file.farmacia.dimensione > 0);
  assert.ok(st.disco && st.disco.libero > 0);
  assert.ok(st.giornale.ultimaRevisione >= st.revisione - 0);
  assert.ok(['ok', 'attenzione', 'problema'].includes(st.stato));
  assert.ok(Array.isArray(st.motivi));
  assert.ok(st.copie.some((c) => c.prefisso === 'farmacia' && c.tipo === 'auto' && c.verificata === true));
  assert.ok(st.copie.some((c) => c.prefisso === 'accessi' && c.verificata === true));
  assert.ok(st.controllo.ultimo);
});

test('copie verificate e controllo completo dalla pagina Sistema', async () => {
  const c = ok200(await admin.post('/api/sistema/copia'));
  assert.equal(c.copie.length, 2);
  assert.ok(c.copie.every((x) => x.verificata === true));
  const mag = c.copie.find((x) => x.prefisso === 'farmacia');
  assert.equal(mag.rev, ok200(await admin.get('/api/dati?da=0')).rev);
  assert.ok(mag.conteggi.movimenti > 1000);
  // la scheda della verifica sta accanto alla copia
  const scheda = JSON.parse(fs.readFileSync(path.join(S.dati, 'backup', mag.nome.replace(/\.db$/, '.json')), 'utf8'));
  assert.equal(scheda.verificata, true);
  assert.equal(scheda.integrita, 'ok');
  // l'elenco della 2.x (Configura) resta com'era, con in più l'esito della verifica
  const el = ok200(await admin.get('/api/backup'));
  assert.ok(el.backup.every((b) => b.nome.startsWith('farmacia_') && b.dimensione > 0 && b.data && b.tipo));
  assert.ok(el.backup.some((b) => b.nome === mag.nome && b.verificata === true));
  const k = ok200(await admin.post('/api/sistema/controlla'));
  assert.equal(k.controllo.esito, 'ok');
  assert.equal(k.controllo.file.farmacia.esito, 'ok');
  assert.equal(k.sistema.controllo.ultimo.tipo, 'manuale');
  const ev = ok200(await admin.get('/api/attivita?azione=sistema.'));
  assert.ok(ev.eventi.some((e) => e.azione === 'sistema.copia'));
  assert.ok(ev.eventi.some((e) => e.azione === 'sistema.controlla'));
});

let PRIMA;      // dati prima del danno

/* Di nuovo il server sulla stessa cartella dati (su un'altra porta): la sessione dell'amministratore resta valida. */
async function riavvia() {
  S = await avviaServer(S.dati);
  admin.base = S.base;
}

test('scritture dopo l\'ultima copia (richieste, DDT, armadi, cancellazioni, impostazioni) e prova di ripristino', async () => {
  // richiesta → DDT spedito e ricevuto, armadio, articolo cancellato, impostazioni, movimento annullato
  const ric = ok200(await admin.post('/api/richieste', { repartoId: 'r-degenza', invia: true, righe: [{ articoloId: ART.id, quantita: 3, nota: 'per la notte' }] }));
  const p = ok200(await admin.post('/api/richieste/' + ric.richiesta.id + '/ddt', {}));
  const me = ok200(await admin.get('/api/stato')).utente;
  ok200(await admin.post('/api/ddt/' + p.ddt.id + '/spedisci', { trasportatoreId: me.id }));
  ok200(await admin.post('/api/ddt/' + p.ddt.id + '/ricevi', {}));
  ok200(await admin.post('/api/armadi', { repartoId: 'r-degenza', nome: 'Armadio della prova', ripiani: 3, colonne: 4 }));
  const via = ok200(await admin.post('/api/articoli', { nome: 'DA CANCELLARE', categoria: 'PRESIDI' }));
  ok200(await admin.del('/api/articoli/' + via.articolo.id));
  ok200(await admin.post('/api/articoli', { nome: 'DOPO LA COPIA', categoria: 'FARMACI', barcode: ['cod:DOPO1'], pezziConfezione: 10 }));
  const mov = ok200(await admin.post('/api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', quantita: 7, lotto: 'GIORNALE', scadenza: '2030-01', prezzo: 2.5 }] }));
  ok200(await admin.post('/api/movimenti/' + mov.movimenti[0].id + '/annulla', { motivo: 'prova del giornale' }));
  const imp = ok200(await admin.get('/api/dati?da=0')).impostazioni;
  ok200(await admin.put('/api/impostazioni', Object.assign({}, imp, { giorniAvvisoScadenza: 45 })));
  PRIMA = ok200(await admin.get('/api/dati?da=0'));
  assert.ok(PRIMA.richieste.length && PRIMA.ddt.length && PRIMA.ddtRighe.length && PRIMA.armadi.length);
  assert.equal(PRIMA.impostazioni.giorniAvvisoScadenza, 45);

  // la prova di ripristino ricostruisce ultima copia + giornale e trova gli stessi dati
  const pr = ok200(await admin.post('/api/sistema/prova-ripristino'));
  assert.equal(pr.prova.esito, 'ok', JSON.stringify(pr.prova));
  assert.ok(pr.prova.riapplicate >= 8, 'modifiche riapplicate: ' + pr.prova.riapplicate);
  assert.equal(pr.prova.revRicostruita, PRIMA.rev);
  assert.ok(pr.prova.tabelle.every((t) => t.uguale));
  assert.ok(pr.prova.tabelle.find((t) => t.tabella === 'movimenti').attuale.righe === PRIMA.movimenti.length);
});

test('farmacia.db danneggiato a server spento: al riavvio si cura da solo (copia + giornale), senza perdere niente', async () => {
  const copiaManuale = ok200(await admin.get('/api/sistema')).copie.find((c) => c.prefisso === 'farmacia' && c.tipo === 'manuale');
  await S.uccidi(); // spegnimento improvviso: niente copia di chiusura
  const file = path.join(S.dati, 'farmacia.db');
  chiudiBene(file);
  sovrascriviMezzo(file);
  assert.notEqual(quickCheck(file), 'ok', 'il file deve risultare danneggiato');
  // anche l'ultima copia è rovinata (la sua scheda dice ancora "verificata"): la cura deve accorgersene e usare la precedente
  const fileCopia = path.join(S.dati, 'backup', copiaManuale.nome);
  fs.truncateSync(fileCopia, Math.floor(fs.statSync(fileCopia).size / 2));

  await riavvia();
  assert.match(S.uscita(), /farmacia\.db .*danneggiato/);
  assert.match(S.uscita(), /nessun dato perso/);
  const dopo = ok200(await admin.get('/api/dati?da=0')); // la sessione resta: accessi.db non è stato toccato
  assert.equal(dopo.rev, PRIMA.rev);
  assert.deepEqual(istantanea(dopo), istantanea(PRIMA));

  const st = ok200(await admin.get('/api/sistema'));
  const cura = st.cure[0];
  assert.equal(cura.file, 'farmacia.db');
  assert.equal(cura.esito, 'curato');
  assert.equal(cura.perse, 0);
  assert.notEqual(cura.copia, copiaManuale.nome, 'la copia rovinata si salta');
  assert.ok(cura.riapplicate > 8);
  assert.ok(cura.messaggi.some((m) => m.includes(copiaManuale.nome)), JSON.stringify(cura.messaggi));
  assert.equal(st.stato, 'attenzione', 'dopo una cura il semaforo è giallo per qualche giorno');
  assert.ok(st.motivi.some((m) => /curato farmacia\.db/.test(m.testo)));
  // il file danneggiato resta in dati/danneggiati per un controllo a mano
  assert.ok(fs.readdirSync(path.join(S.dati, 'danneggiati')).some((n) => /^farmacia_.*\.db$/.test(n)));
  const ev = ok200(await admin.get('/api/attivita?azione=sistema.cura')).eventi;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].username, 'sistema');

  // si lavora di nuovo: il giornale continua e la prova di ripristino torna
  const n = ok200(await admin.post('/api/articoli', { nome: 'DOPO LA CURA', categoria: 'FARMACI' }));
  assert.equal(n.rev, PRIMA.rev + 1);
  const righe = righeGiornale(S.dati);
  assert.equal(righe[righe.length - 1].rev, n.rev);
  assert.equal(ok200(await admin.post('/api/sistema/prova-ripristino')).prova.esito, 'ok');
});

test('farmacia.db troncato: si cura anche così', async () => {
  const prima = ok200(await admin.get('/api/dati?da=0'));
  await S.uccidi();
  const file = path.join(S.dati, 'farmacia.db');
  chiudiBene(file);
  fs.truncateSync(file, Math.floor(fs.statSync(file).size / 3));
  await riavvia();
  const dopo = ok200(await admin.get('/api/dati?da=0'));
  assert.deepEqual(istantanea(dopo), istantanea(prima));
  const st = ok200(await admin.get('/api/sistema'));
  assert.equal(st.cure[0].esito, 'curato');
  assert.equal(st.cure.length, 2);
});

test('seconda cartella: copie e giornale anche su un altro disco; non raggiungibile = avviso', async () => {
  const altra = cartellaNuova('seconda');
  assert.equal((await admin.put('/api/sistema/seconda-cartella', { percorso: 'cartella/relativa' })).stato, 400);
  assert.equal((await admin.put('/api/sistema/seconda-cartella', { percorso: path.join(S.dati, 'dentro') })).stato, 400);
  const r = ok200(await admin.put('/api/sistema/seconda-cartella', { percorso: altra }));
  assert.equal(r.seconda.raggiungibile, true, JSON.stringify(r.seconda));
  const nomi = fs.readdirSync(altra);
  assert.ok(nomi.some((n) => /^farmacia_.*\.db$/.test(n)));
  assert.ok(nomi.some((n) => /^accessi_.*\.db$/.test(n)));
  assert.ok(fs.readdirSync(path.join(altra, 'giornale')).some((n) => /\.jsonl$/.test(n)));
  // una cartella che non si può creare: avviso, non errore
  const fileNormale = path.join(altra, 'un-file.txt');
  fs.writeFileSync(fileNormale, 'x');
  const r2 = ok200(await admin.put('/api/sistema/seconda-cartella', { percorso: path.join(fileNormale, 'sotto') }));
  assert.equal(r2.seconda.raggiungibile, false);
  assert.ok(r2.sistema.motivi.some((m) => /seconda cartella/.test(m.testo)));
  const r3 = ok200(await admin.put('/api/sistema/seconda-cartella', { percorso: '' }));
  assert.equal(r3.seconda.percorso, '');
  fs.rmSync(altra, { recursive: true, force: true });
});

test('dopo un ripristino manuale il giornale riparte da una linea nuova e la cura la rispetta', async () => {
  const a = ok200(await admin.post('/api/articoli', { nome: 'PRIMA DEL RIPRISTINO', categoria: 'FARMACI' }));
  const copia = ok200(await admin.post('/api/backup')).nome;
  ok200(await admin.post('/api/articoli', { nome: 'SPARISCE COL RIPRISTINO', categoria: 'FARMACI' }));
  const rip = ok200(await admin.post('/api/backup/' + copia + '/ripristina'));
  const segno = righeGiornale(S.dati).filter((v) => v.tipo === 'ripristino');
  assert.equal(segno.length, 1);
  assert.equal(segno[0].rev, rip.rev);
  assert.equal(segno[0].base, rip.rev);
  ok200(await admin.post('/api/articoli', { nome: 'DOPO IL RIPRISTINO', categoria: 'FARMACI' }));
  const prima = ok200(await admin.get('/api/dati?da=0'));
  assert.ok(prima.articoli.some((x) => x.id === a.articolo.id));
  assert.ok(!prima.articoli.some((x) => x.nome === 'SPARISCE COL RIPRISTINO'));
  assert.equal(ok200(await admin.post('/api/sistema/prova-ripristino')).prova.esito, 'ok');

  await S.uccidi();
  const file = path.join(S.dati, 'farmacia.db');
  chiudiBene(file);
  sovrascriviMezzo(file);
  await riavvia();
  const dopo = ok200(await admin.get('/api/dati?da=0'));
  assert.deepEqual(istantanea(dopo), istantanea(prima));
  assert.ok(!dopo.articoli.some((x) => x.nome === 'SPARISCE COL RIPRISTINO'), 'la linea vecchia non torna');
  assert.equal(ok200(await admin.get('/api/sistema')).cure[0].perse, 0);
});

test('spegnimento improvviso: le ultime scritture perse dal magazzino tornano dal giornale', async () => {
  const copia = ok200(await admin.post('/api/sistema/copia')).copie.find((c) => c.prefisso === 'farmacia');
  ok200(await admin.post('/api/articoli', { nome: 'SCRITTO PRIMA DEL GUASTO 1', categoria: 'FARMACI' }));
  ok200(await admin.post('/api/articoli', { nome: 'SCRITTO PRIMA DEL GUASTO 2', categoria: 'PRESIDI' }));
  const prima = ok200(await admin.get('/api/dati?da=0'));
  await S.uccidi();
  // il magazzino "torna indietro" come dopo una mancanza di corrente (le ultime transazioni del WAL non erano sul disco)
  const file = path.join(S.dati, 'farmacia.db');
  ['', '-wal', '-shm'].forEach((s) => { try { fs.unlinkSync(file + s); } catch (e) { /* non c'è */ } });
  fs.copyFileSync(path.join(S.dati, 'backup', copia.nome), file);
  fs.writeFileSync(file + '-wal', Buffer.alloc(64)); // WAL rimasto dallo spegnimento (illeggibile: SQLite lo ignora)
  await riavvia();
  assert.match(S.uscita(), /spegnimento improvviso/);
  const dopo = ok200(await admin.get('/api/dati?da=0'));
  assert.deepEqual(istantanea(dopo), istantanea(prima));
  assert.equal(dopo.rev, prima.rev);
});

test('un file sostituito a mano con una copia vecchia NON viene riportato avanti, e il giornale resta coerente', async () => {
  const copia = ok200(await admin.post('/api/sistema/copia')).copie.find((c) => c.prefisso === 'farmacia');
  const vecchi = ok200(await admin.get('/api/dati?da=0'));
  ok200(await admin.post('/api/articoli', { nome: 'DOPO LA COPIA MESSA A MANO', categoria: 'FARMACI' }));
  await S.ferma();
  const file = path.join(S.dati, 'farmacia.db');
  ['', '-wal', '-shm'].forEach((s) => { try { fs.unlinkSync(file + s); } catch (e) { /* non c'è */ } });
  fs.copyFileSync(path.join(S.dati, 'backup', copia.nome), file);
  await riavvia();
  const dopo = ok200(await admin.get('/api/dati?da=0'));
  assert.deepEqual(istantanea(dopo).articoli, istantanea(vecchi).articoli);
  assert.ok(dopo.rev > vecchi.rev + 1, 'linea nuova sopra il giornale');
  assert.match(S.uscita(), /linea nuova/);
  // quello che il giornale ha e il magazzino no non sparisce in silenzio: cura con perdite, semaforo rosso
  const st = ok200(await admin.get('/api/sistema'));
  assert.equal(st.cure[0].metodo, 'linea-nuova');
  assert.equal(st.cure[0].esito, 'curato-con-perdite');
  assert.equal(st.cure[0].perse, 1);
  assert.match(st.cure[0].messaggio, /1 articolo/);
  assert.equal(st.stato, 'problema');
  assert.ok(st.motivi.some((m) => /più indietro del giornale/.test(m.testo)), JSON.stringify(st.motivi));
  ok200(await admin.post('/api/articoli', { nome: 'SULLA LINEA NUOVA', categoria: 'FARMACI' }));
  assert.equal(ok200(await admin.post('/api/sistema/prova-ripristino')).prova.esito, 'ok');
});

test('un giornale incompleto: la prova di ripristino lo dice', async () => {
  ok200(await admin.post('/api/sistema/copia'));
  ok200(await admin.post('/api/articoli', { nome: 'BUCO 1', categoria: 'FARMACI' }));
  ok200(await admin.post('/api/articoli', { nome: 'BUCO 2', categoria: 'FARMACI' }));
  // tolgo la penultima riga del giornale
  const cartella = path.join(S.dati, 'giornale');
  const nome = fs.readdirSync(cartella).filter((n) => /\.jsonl$/.test(n)).sort().pop();
  const righe = fs.readFileSync(path.join(cartella, nome), 'utf8').split('\n').filter(Boolean);
  righe.splice(righe.length - 2, 1);
  fs.writeFileSync(path.join(cartella, nome), righe.join('\n') + '\n');
  const pr = ok200(await admin.post('/api/sistema/prova-ripristino'));
  assert.equal(pr.prova.esito, 'differenze');
  assert.ok(pr.prova.messaggi.some((m) => /mancano/.test(m)), JSON.stringify(pr.prova.messaggi));
  assert.ok(pr.sistema.motivi.some((m) => /prova di ripristino/.test(m.testo)));
  await S.ferma();
  S = null;
});

/* ---------- accessi.db ---------- */

test('accessi.db danneggiato: ripristino dalla copia, gli utenti tornano', async () => {
  const dati = cartellaNuova('accessi');
  const seconda = cartellaNuova('accessi-seconda');
  // seconda cartella scritta nel file di configurazione: dalla pagina non si cambia
  fs.writeFileSync(path.join(dati, 'configurazione.json'), JSON.stringify({ secondaCartella: seconda }));
  // seconda cartella lenta (ogni file 800 ms): la copia di adesso deve arrivarci anche se la sincronizzazione delle
  // copie automatiche dell'avvio è ancora in corso (prima la prova a volte ripristinava la copia vuota dell'avvio)
  let s = await avviaServer(dati, { precarica: precaricaLenta(800) });
  try {
    const a = new Client(s.base);
    ok200(await a.post('/api/setup', { username: 'admin', nome: 'Amministratore', password: PW }));
    await utente(a, s.base, 'mario', 'farmacista');
    const copia = ok200(await a.post('/api/sistema/copia'));
    const copiaAccessi = copia.copie.find((c) => c.prefisso === 'accessi').nome;
    // con la seconda cartella la risposta arriva dopo la sincronizzazione (al massimo 20 s): la copia è già lì
    await aspetta(() => fs.existsSync(path.join(seconda, copiaAccessi)), 30000, 'la copia ' + copiaAccessi + ' nella seconda cartella');
    await utente(a, s.base, 'luigi', 'farmacista'); // dopo la copia: si perde (accessi.db non ha giornale)
    const st = ok200(await a.get('/api/sistema'));
    assert.equal(st.secondaCartella.origine, 'configurazione');
    assert.equal(st.secondaDaConfigurazione, true);
    assert.equal((await a.put('/api/sistema/seconda-cartella', { percorso: '' })).stato, 409);
    await s.uccidi();
    const file = path.join(dati, 'accessi.db');
    chiudiBene(file);
    fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2));
    assert.notEqual(quickCheck(file), 'ok');
    // le copie della cartella dati spariscono: si usano quelle della seconda cartella
    fs.readdirSync(path.join(dati, 'backup')).filter((n) => n.startsWith('accessi_')).forEach((n) => fs.unlinkSync(path.join(dati, 'backup', n)));
    assert.ok(fs.existsSync(path.join(seconda, copiaAccessi)), 'la copia di accessi.db fatta prima del danno è nella seconda cartella');

    s = await avviaServer(dati);
    assert.match(s.uscita(), /accessi\.db .*danneggiato/);
    // le sessioni della copia restano valide: chi era collegato prima della copia non deve rientrare
    const collegato = new Client(s.base);
    collegato.cookie = a.cookie;
    const stato = ok200(await collegato.get('/api/stato'));
    assert.equal(stato.utente && stato.utente.username, 'admin', JSON.stringify(stato).slice(0, 200));
    const a2 = new Client(s.base);
    ok200(await a2.post('/api/login', { username: 'admin', password: PW }));
    const m = new Client(s.base);
    ok200(await m.post('/api/login', { username: 'mario', password: PW }));
    const l = new Client(s.base);
    assert.notEqual((await l.post('/api/login', { username: 'luigi', password: PW })).stato, 200);
    const st2 = ok200(await a2.get('/api/sistema'));
    const cura = st2.cure.find((c) => c.file === 'accessi.db');
    assert.equal(cura.metodo, 'copia');
    assert.equal(cura.esito, 'curato-con-perdite');
    assert.equal(st2.stato, 'problema', 'una cura con perdite è rossa per un giorno');
    assert.ok(fs.readdirSync(path.join(dati, 'danneggiati')).some((n) => /^accessi_.*\.db$/.test(n)));
    // il registro attività (ripristinato dalla copia) ha l'evento della cura
    assert.ok(ok200(await a2.get('/api/attivita?azione=sistema.cura')).eventi.length >= 1);
  } finally {
    await s.ferma();
    fs.rmSync(seconda, { recursive: true, force: true });
  }
});

test('disco del server rotto: un server nuovo riparte da copie e giornale della seconda cartella', async () => {
  const vecchia = cartellaNuova('disco-rotto');
  const seconda = cartellaNuova('disco-rotto-seconda');
  let s = await avviaServer(vecchia);
  let prima;
  try {
    const a = new Client(s.base);
    ok200(await a.post('/api/setup', { username: 'admin', nome: 'Amministratore', password: PW }));
    ok200(await a.post('/api/demo'));
    ok200(await a.post('/api/sistema/copia'));
    // scritte dopo l'ultima copia: arrivano nella seconda cartella solo con il giornale
    ok200(await a.post('/api/articoli', { nome: 'SOLO NEL GIORNALE 1', categoria: 'FARMACI' }));
    ok200(await a.post('/api/articoli', { nome: 'SOLO NEL GIORNALE 2', categoria: 'PRESIDI' }));
    const r = ok200(await a.put('/api/sistema/seconda-cartella', { percorso: seconda }));
    assert.equal(r.seconda.raggiungibile, true);
    prima = ok200(await a.get('/api/dati?da=0'));
  } finally {
    await s.uccidi();
  }
  // server nuovo: cartella dati vuota, solo la configurazione con la seconda cartella
  const nuova = cartellaNuova('server-nuovo');
  fs.writeFileSync(path.join(nuova, 'configurazione.json'), JSON.stringify({ secondaCartella: seconda }));
  s = await avviaServer(nuova);
  try {
    assert.match(s.uscita(), /farmacia\.db .*mancante/);
    const a = new Client(s.base);
    ok200(await a.post('/api/login', { username: 'admin', password: PW }));
    const dopo = ok200(await a.get('/api/dati?da=0'));
    assert.deepEqual(istantanea(dopo), istantanea(prima));
    const cura = ok200(await a.get('/api/sistema')).cure.find((c) => c.file === 'farmacia.db');
    assert.equal(cura.esito, 'curato');
    assert.ok(cura.riapplicate >= 2);
  } finally {
    await s.ferma();
  }
});

test('riapplicazione: le conversioni inverse ricostruiscono righe identiche in ogni tabella', () => {
  // archivio con una riga per tabella, riletto con *DaRiga e riscritto con rigaDaOggetto in un archivio vuoto
  const dir = cartellaNuova('inverse');
  const db = D.apriDati(path.join(dir, 'a.db'));
  db.exec("INSERT INTO articoli (id, nome, categoria, barcode, attributi, lead_time, fornitore, rev) VALUES ('a1', 'ART', 'FARMACI', '[\"cod:X\"]', '[\"frigo\"]', 5, 'Ditta', 2)");
  db.exec("INSERT INTO movimenti (id, tipo, data, articolo_id, reparto_id, reparto_dest_id, quantita, creato, annullato_il, annullato_da, annullato_motivo, ddt_id, rev) VALUES ('m1', 'trasferimento', '2026-01-01', 'a1', 'r-farmacia', 'r-degenza', 3, 1, '2026-01-02T00:00:00.000Z', 'Io', 'errore', NULL, 2)");
  db.exec("INSERT INTO armadi (id, reparto_id, nome, rev) VALUES ('ar1', 'r-degenza', 'A', 2)");
  db.exec("INSERT INTO assortimento (id, reparto_id, articolo_id, scorta_min, armadio_id, ripiano, posizione, rev) VALUES ('as1', 'r-degenza', 'a1', 2, 'ar1', 1, NULL, 2)");
  db.exec("INSERT INTO richieste (id, numero, anno, progressivo, reparto_id, fornitore_id, urgente, creata_il, rev) VALUES ('q1', 'RIC-2026-0001', 2026, 1, 'r-degenza', 'r-farmacia', 1, '2026-01-01T00:00:00.000Z', 2)");
  db.exec("INSERT INTO richieste_righe (id, richiesta_id, articolo_id, quantita, approvata, rev) VALUES ('qr1', 'q1', 'a1', 4, NULL, 2)");
  db.exec("INSERT INTO ddt (id, numero, anno, progressivo, origine_id, destinazione_id, richiesta_id, preparato_il, rev) VALUES ('d1', 'DDT-2026-0001', 2026, 1, 'r-farmacia', 'r-degenza', 'q1', '2026-01-01T00:00:00.000Z', 2)");
  db.exec("INSERT INTO ddt_righe (id, ddt_id, articolo_id, richiesta_riga_id, lotto, quantita, ricevuta, rev) VALUES ('dr1', 'd1', 'a1', 'qr1', 'L1', 4, 3.5, 2)");
  const b = D.apriDati(path.join(dir, 'b.db'));
  const voce = { rev: 2, base: 0, cambiamenti: {} };
  D.TABELLE_SYNC.forEach((t) => {
    voce.cambiamenti[t.chiave] = JSON.parse(JSON.stringify(db.prepare('SELECT * FROM ' + t.tabella + ' WHERE rev = 2').all().map(t.daRiga)));
  });
  Sal.riapplica(b, [voce]);
  D.TABELLE_SYNC.forEach((t) => {
    const x = db.prepare('SELECT * FROM ' + t.tabella + ' ORDER BY id').all().map(t.daRiga);
    const y = b.prepare('SELECT * FROM ' + t.tabella + ' ORDER BY id').all().map(t.daRiga);
    assert.deepEqual(y, x, t.tabella);
  });
  assert.equal(b.prepare("SELECT valore FROM meta WHERE chiave = 'rev'").get().valore, '2');
  db.close();
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- chiave della verifica in due passaggi nelle copie di accessi.db (integrazione 3.0) ---------- */

test('le copie di accessi.db nella cartella dati portano la chiave della 2FA; la seconda cartella no', async () => {
  const dati = cartellaNuova('chiave2fa');
  const seconda = cartellaNuova('chiave2fa-seconda');
  const cartellaCopie = path.join(dati, 'backup');
  const db = new D.Database(dati);
  try {
    const b = new B.Backup(db, () => {}, {});
    // nessuno ha mai attivato la 2FA: il file della chiave non c'è e non si copia niente
    const prime = b.creaTutte('manuale');
    const acc0 = prime.find((n) => n.startsWith('accessi_'));
    assert.equal(fs.existsSync(B.fileChiave(path.join(cartellaCopie, acc0))), false);
    // con la chiave (stesso nome che usa server/accessi.js)
    assert.equal(B.FILE_CHIAVE_2FA, 'chiave-2fa.key');
    const chiave = require('node:crypto').randomBytes(32).toString('base64') + '\n';
    fs.writeFileSync(path.join(dati, B.FILE_CHIAVE_2FA), chiave, { mode: 0o600 });
    const nomi = b.creaTutte('manuale');
    const acc = nomi.find((n) => n.startsWith('accessi_'));
    const far = nomi.find((n) => n.startsWith('farmacia_'));
    const fk = B.fileChiave(path.join(cartellaCopie, acc));
    assert.equal(path.basename(fk), acc.replace(/\.db$/, '.chiave-2fa.key'));
    assert.equal(fs.readFileSync(fk, 'utf8'), chiave, 'la copia della chiave è identica all\'originale');
    if (process.platform !== 'win32') assert.equal(fs.statSync(fk).mode & 0o777, 0o600, 'leggibile solo dal servizio');
    assert.equal(fs.existsSync(B.fileChiave(path.join(cartellaCopie, far))), false, 'le copie del magazzino non hanno la chiave');
    assert.equal(JSON.parse(fs.readFileSync(path.join(cartellaCopie, acc.replace(/\.db$/, '.json')), 'utf8')).chiave2fa, true);
    // l'elenco delle copie (pagina Sistema, cura) resta fatto dei soli .db
    assert.ok(B.copieIn(cartellaCopie).every((c) => /\.db$/.test(c.nome)));
    // seconda cartella: le copie e le schede sì, la chiave no
    b.impostaSeconda(seconda, 'pagina');
    const st = await b.sincronizzaSeconda();
    assert.equal(st.raggiungibile, true, JSON.stringify(st));
    const laggiu = fs.readdirSync(seconda);
    assert.ok(laggiu.includes(acc) && laggiu.includes(far), laggiu.join(', '));
    assert.ok(!laggiu.some((n) => /\.key$/.test(n)), 'nessuna chiave nella seconda cartella: ' + laggiu.join(', '));
    // conservazione: una copia tolta perché vecchia porta via anche la sua chiave
    for (let g = 1; g <= 30; g++) {
      const n = 'accessi_2020-01-' + String(g).padStart(2, '0') + '_120000_manuale.db';
      fs.copyFileSync(path.join(cartellaCopie, acc), path.join(cartellaCopie, n));
      fs.writeFileSync(B.fileChiave(path.join(cartellaCopie, n)), chiave);
    }
    b.pulisci();
    const resto = fs.readdirSync(cartellaCopie);
    // 32 copie manuali di accessi.db: restano le 30 più recenti, le due del 1° e 2 gennaio 2020 se ne vanno con la chiave
    ['accessi_2020-01-01_120000_manuale', 'accessi_2020-01-02_120000_manuale'].forEach((base) => {
      assert.ok(!resto.includes(base + '.db') && !resto.includes(base + '.chiave-2fa.key'), base);
    });
    assert.ok(resto.includes('accessi_2020-01-03_120000_manuale.chiave-2fa.key'));
    assert.ok(resto.includes(path.basename(fk)));
  } finally {
    db.chiudi();
  }
});

/* ---------- revisione dei dati 3.0: WAL perso, giornale come fonte di verità, numeri, seconda cartella ---------- */

test('spegnimento improvviso con il WAL sparito, vuoto o con la testata rovinata: le scritture tornano dal giornale', async () => {
  const dati = cartellaNuova('wal');
  const file = path.join(dati, 'farmacia.db');
  let s = await avviaServer(dati);
  const a = new Client(s.base);
  try {
    ok200(await a.post('/api/setup', { username: 'admin', nome: 'Amministratore', password: PW }));
    await lavora(a, 'prima sessione');
    await s.ferma(); // arresto ordinato: tutto nel file principale
    let righe = righeGiornale(dati);
    assert.equal(righe[righe.length - 1].tipo, 'chiusura', 'l’arresto ordinato si segna nel giornale');
    assert.equal(righe[righe.length - 1].durevole, true);
    // WAL sparito, vuoto (una mancanza di corrente su NTFS), testata rovinata; e dopo il checkpoint del controllo
    // completo (come di notte) con il WAL vuoto
    for (const danno of ['senza-wal', 'wal-vuoto', 'testata-rovinata', 'dopo-il-controllo']) {
      s = await avviaServer(dati);
      a.base = s.base; // la sessione dell'amministratore resta valida
      righe = righeGiornale(dati);
      assert.equal(righe[righe.length - 1].tipo, 'avvio');
      assert.equal(righe[righe.length - 1].durevole, true, 'all’avvio il WAL si riversa nel file principale');
      if (danno === 'dopo-il-controllo') ok200(await a.post('/api/sistema/controlla'));
      await lavora(a, danno);
      const prima = ok200(await a.get('/api/dati?da=0'));
      await s.uccidi();
      assert.ok(fs.statSync(file + '-wal').size > 0, 'le scritture di questa sessione sono solo nel WAL');
      if (danno === 'senza-wal') fs.unlinkSync(file + '-wal');
      else if (danno === 'testata-rovinata') {
        const fd = fs.openSync(file + '-wal', 'r+');
        fs.writeSync(fd, Buffer.alloc(32, 0x77), 0, 32, 0);
        fs.closeSync(fd);
      } else fs.truncateSync(file + '-wal', 0);
      try { fs.unlinkSync(file + '-shm'); } catch (e) { /* non c'è */ }

      s = await avviaServer(dati);
      a.base = s.base;
      assert.match(s.uscita(), /spegnimento improvviso/, danno);
      const dopo = ok200(await a.get('/api/dati?da=0'));
      assert.deepEqual(istantanea(dopo), istantanea(prima), danno + ': nessuna scrittura persa');
      assert.equal(dopo.rev, prima.rev, danno);
      const st = ok200(await a.get('/api/sistema'));
      assert.equal(st.cure[0].metodo, 'coda', danno);
      assert.equal(st.cure[0].esito, 'curato', danno);
      assert.equal(st.cure[0].perse, 0, danno);
      assert.ok(st.cure[0].riapplicate >= 8, danno + ': riapplicate ' + st.cure[0].riapplicate);
      assert.equal(st.stato, 'attenzione', danno + ': ' + JSON.stringify(st.motivi));
      await s.ferma();
    }
  } finally {
    await s.ferma();
  }
});

test('un file rimesso a mano da una copia di prima dell’ultimo avvio: non si riporta avanti, cura con perdite, numeri non riusati', async () => {
  const dati = cartellaNuova('a-mano');
  const file = path.join(dati, 'farmacia.db');
  let s = await avviaServer(dati);
  const a = new Client(s.base);
  try {
    ok200(await a.post('/api/setup', { username: 'admin', nome: 'Amministratore', password: PW }));
    await lavora(a, 'uno');
    const copia = ok200(await a.post('/api/backup')).nome;
    const vecchi = ok200(await a.get('/api/dati?da=0'));
    await lavora(a, 'due');
    await s.uccidi(); // spegnimento improvviso (il WAL resta: al prossimo avvio finisce nel file)
    s = await avviaServer(dati);
    a.base = s.base;
    const tre = await lavora(a, 'tre');
    assert.match(tre.ric.numero, /-0003$/);
    assert.match(tre.ddt.numero, /-0003$/);
    await s.uccidi();
    // qualcuno rimette a mano la copia vecchia (il file era già stato riversato su disco più avanti, all'avvio)
    ['', '-wal', '-shm'].forEach((x) => { try { fs.unlinkSync(file + x); } catch (e) { /* non c'è */ } });
    fs.copyFileSync(path.join(dati, 'backup', copia), file);

    s = await avviaServer(dati);
    a.base = s.base;
    const dopo = ok200(await a.get('/api/dati?da=0'));
    assert.deepEqual(istantanea(dopo).articoli, istantanea(vecchi).articoli, 'la copia rimessa a mano non si riporta avanti');
    assert.deepEqual(istantanea(dopo).ddt, istantanea(vecchi).ddt);
    const st = ok200(await a.get('/api/sistema'));
    const cura = st.cure[0];
    assert.equal(cura.metodo, 'linea-nuova');
    assert.equal(cura.esito, 'curato-con-perdite');
    assert.ok(cura.perse >= 16, 'modifiche perse: ' + cura.perse);
    assert.match(cura.messaggio, /2 articoli/);
    assert.match(cura.messaggio, /2 DDT/);
    assert.equal(st.stato, 'problema', 'semaforo rosso: ' + JSON.stringify(st.motivi));
    assert.equal(ok200(await a.get('/api/attivita?azione=sistema.cura')).eventi.length, 1);
    assert.equal(ok200(await a.get('/api/attivita?azione=sistema.linea-nuova')).eventi.length, 1);
    // i numeri RIC e DDT già dati (fino a 0003, anche se non sono più nel magazzino) non tornano liberi
    const quattro = await lavora(a, 'quattro');
    assert.match(quattro.ric.numero, /-0004$/, quattro.ric.numero);
    assert.match(quattro.ddt.numero, /-0004$/, quattro.ddt.numero);
  } finally {
    await s.ferma();
  }
});

test('farmacia.db sparito e nessuna copia del magazzino: si ricostruisce dal solo giornale (non è un archivio nuovo)', async () => {
  const dati = cartellaNuova('solo-giornale');
  let s = await avviaServer(dati);
  const a = new Client(s.base);
  try {
    ok200(await a.post('/api/setup', { username: 'admin', nome: 'Amministratore', password: PW }));
    await lavora(a, 'uno');
    await lavora(a, 'due');
    const prima = ok200(await a.get('/api/dati?da=0'));
    await s.ferma();
    ['', '-wal', '-shm'].forEach((x) => { try { fs.unlinkSync(path.join(dati, 'farmacia.db' + x)); } catch (e) { /* non c'è */ } });
    fs.readdirSync(path.join(dati, 'backup')).filter((n) => n.startsWith('farmacia_')).forEach((n) => fs.unlinkSync(path.join(dati, 'backup', n)));

    s = await avviaServer(dati);
    a.base = s.base;
    assert.match(s.uscita(), /farmacia\.db .*mancante/);
    const dopo = ok200(await a.get('/api/dati?da=0'));
    assert.deepEqual(istantanea(dopo), istantanea(prima));
    const cura = ok200(await a.get('/api/sistema')).cure[0];
    assert.equal(cura.file, 'farmacia.db');
    assert.equal(cura.metodo, 'giornale');
    assert.equal(cura.esito, 'curato');
    assert.match(cura.messaggio, /archivio vuoto/);
  } finally {
    await s.ferma();
  }
});

test('ultima scrittura non arrivata nel giornale e file illeggibile: la cura lo dice, non "nessun dato perso"', async () => {
  const dati = cartellaNuova('coda-giornale');
  const file = path.join(dati, 'farmacia.db');
  let s = await avviaServer(dati);
  const a = new Client(s.base);
  try {
    ok200(await a.post('/api/setup', { username: 'admin', nome: 'Amministratore', password: PW }));
    ok200(await a.post('/api/sistema/copia'));
    await lavora(a, 'uno');
    const ultima = ok200(await a.post('/api/articoli', { nome: 'ULTIMA SCRITTURA', categoria: 'FARMACI' }));
    await s.uccidi();
    // il giornale non ha l'ultima scrittura (per esempio non si poteva scrivere), il registro attività sì
    const cartella = path.join(dati, 'giornale');
    const nome = fs.readdirSync(cartella).filter((n) => /\.jsonl$/.test(n)).sort().pop();
    const righe = fs.readFileSync(path.join(cartella, nome), 'utf8').split('\n').filter(Boolean);
    assert.equal(JSON.parse(righe[righe.length - 1]).rev, ultima.rev);
    assert.equal(typeof JSON.parse(righe[righe.length - 1]).evento, 'number', 'la voce ricorda il numero del registro attività');
    righe.pop();
    fs.writeFileSync(path.join(cartella, nome), righe.join('\n') + '\n');
    // e il file si rompe nella testata: la sua revisione non si sa più
    chiudiBene(file);
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.alloc(8192, 0x3c), 0, 8192, 0);
    fs.closeSync(fd);

    s = await avviaServer(dati);
    a.base = s.base;
    const st = ok200(await a.get('/api/sistema'));
    const cura = st.cure.find((c) => c.file === 'farmacia.db');
    assert.equal(cura.esito, 'curato-con-perdite');
    assert.equal(cura.perse, 1);
    assert.doesNotMatch(cura.messaggio, /nessun dato perso/);
    assert.ok(cura.messaggi.some((m) => /registro attività/.test(m) && /articoli\.crea/.test(m)), JSON.stringify(cura.messaggi));
    assert.equal(st.stato, 'problema');
    assert.match(s.uscita(), /farmacia\.db danneggiato, curato CON PERDITE/);
    // l'evento della cura nel registro attività ha il resoconto giusto
    const ev = ok200(await a.get('/api/attivita?azione=sistema.cura')).eventi[0];
    assert.equal(JSON.parse(typeof ev.dettagli === 'string' ? ev.dettagli : JSON.stringify(ev.dettagli)).esito, 'curato-con-perdite');
  } finally {
    await s.ferma();
  }
});

test('dopo il ripristino di una copia i numeri di DDT e richieste già dati non tornano liberi', async () => {
  const dati = cartellaNuova('numeri');
  let s = await avviaServer(dati);
  const a = new Client(s.base);
  try {
    ok200(await a.post('/api/setup', { username: 'admin', nome: 'Amministratore', password: PW }));
    const art = ok200(await a.post('/api/articoli', { nome: 'NUMERI', categoria: 'FARMACI' })).articolo;
    ok200(await a.post('/api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(), articoloId: art.id, repartoId: 'r-farmacia', quantita: 100 }] }));
    const ddt = async () => ok200(await a.post('/api/ddt', { origineId: 'r-farmacia', destinazioneId: 'r-degenza', righe: [{ articoloId: art.id, quantita: 1 }] })).ddt;
    const ric = async () => ok200(await a.post('/api/richieste', { repartoId: 'r-degenza', invia: true, righe: [{ articoloId: art.id, quantita: 1 }] })).richiesta;
    assert.match((await ddt()).numero, /-0001$/);
    assert.match((await ric()).numero, /-0001$/);
    const copia = ok200(await a.post('/api/backup')).nome;
    for (let i = 0; i < 2; i++) {
      const d = await ddt(); // stampato, partito con il codice sul pacco
      ok200(await a.post('/api/ddt/' + d.id + '/spedisci', { trasportatoreNome: 'Gino' }));
      await ric();
    }
    ok200(await a.post('/api/backup/' + copia + '/ripristina'));
    const d4 = await ddt();
    assert.match(d4.numero, /-0004$/, 'dopo il ripristino: ' + d4.numero);
    assert.match((await ric()).numero, /-0004$/);
    // la linea nuova del ripristino è già nel file principale: resta anche dopo un riavvio
    await s.ferma();
    s = await avviaServer(dati);
    a.base = s.base;
    assert.match((await ddt()).numero, /-0005$/);
    const r = righeGiornale(dati).filter((v) => v.tipo === 'ripristino');
    assert.equal(r.length, 1);
    assert.equal(r[0].durevole, true);
  } finally {
    await s.ferma();
  }
});

test('seconda cartella lenta: una copia fatta mentre si sincronizza ci arriva lo stesso; il giornale nuovo anche senza copie', async () => {
  const dati = cartellaNuova('lenta');
  const seconda = cartellaNuova('lenta-seconda');
  const db = new D.Database(dati);
  const fsp = fs.promises;
  const copyFile = fsp.copyFile;
  fsp.copyFile = (x, y, m) => new Promise((r) => setTimeout(r, 150)).then(() => copyFile.call(fsp, x, y, m));
  try {
    const b = new B.Backup(db, () => {}, { secondaCartella: seconda });
    const prime = b.creaTutte('auto');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(b.seconda.inCorso, true, 'il primo giro sta ancora copiando');
    db.scrivi((rev) => { db.dati.prepare("INSERT INTO articoli (id, nome, categoria, rev) VALUES ('a1', 'DOPO', 'FARMACI', ?)").run(rev); });
    const altre = b.creaTutte('manuale');
    const tutte = prime.concat(altre);
    await aspetta(() => tutte.every((n) => fs.existsSync(path.join(seconda, n))) && !b.seconda.inCorso, 15000,
      () => 'nella seconda cartella ci sono ' + fs.readdirSync(seconda).join(', ') + '; servono ' + tutte.join(', '));
    assert.equal(b.seconda.raggiungibile, true);

    // il giornale arriva nella seconda cartella anche fra una copia e l'altra (giro ogni 5 minuti)
    const g = new G.Giornale(db, {});
    g.collega();
    b.giornale = g;
    db.scrivi((rev) => { db.dati.prepare("INSERT INTO articoli (id, nome, categoria, rev) VALUES ('a2', 'SOLO NEL GIORNALE', 'FARMACI', ?)").run(rev); });
    assert.equal(b.giornaleDaPortare(), true);
    await b.sincronizzaSeconda();
    assert.equal(b.giornaleDaPortare(), false);
    const laggiu = G.leggi(path.join(seconda, 'giornale')).voci;
    assert.equal(laggiu[laggiu.length - 1].cambiamenti.articoli[0].nome, 'SOLO NEL GIORNALE');
  } finally {
    fsp.copyFile = copyFile;
    db.chiudi();
  }
});

test.after(async () => {
  if (S) await S.ferma();
  CARTELLE.forEach((c) => { try { fs.rmSync(c, { recursive: true, force: true }); } catch (e) { /* già tolta */ } });
});
