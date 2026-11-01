// Prove della logistica (versione 3.0, parte A): richieste, DDT interni, spedizione, ricezione, annullo.
// Server vero su una porta libera con una cartella dati temporanea; per il cambio d'anno il modulo si prova direttamente.
// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const C = require('../js/calcoli.js');

const ESEGUIBILE = process.env.GF_ESEGUIBILE; // per provare l'exe compilato (Linux) invece dei sorgenti
const PW = 'Password-123';
const T = 'r-transito';

function portaLibera() {
  return new Promise((ok) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}

async function avviaServer() {
  const porta = await portaLibera();
  const dati = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-logistica-'));
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
    porta, base, dati, proc, uscita: () => uscita,
    ferma: () => new Promise((ok) => { proc.once('exit', () => { fs.rmSync(dati, { recursive: true, force: true }); ok(); }); proc.kill('SIGTERM'); })
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

function oggi() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function ok200(r, testo) { assert.equal(r.stato, 200, (testo || '') + ' ' + JSON.stringify(r.json)); return r.json; }

let S;
let admin;
const U = {};
const ART = {};
const ANNO = new Date().getFullYear();

async function dati(client) { return ok200(await client.get('/api/dati?da=0')); }
async function giacenza(client, articoloId, repartoId) {
  const d = await dati(client);
  return C.giacenza({ movimenti: d.movimenti, articoli: d.articoli }, articoloId, repartoId);
}

test.before(async () => {
  S = await avviaServer();
  admin = new Client(S.base);
  ok200(await admin.post('/api/setup', { username: 'admin', nome: 'Amministratore Prova', password: PW }));
  const mk = async (username, nome, ruolo, reparti) => {
    const r = ok200(await admin.post('/api/utenti', { username, nome, ruolo, reparti, password: 'Provvisoria1' }));
    const c = new Client(S.base);
    ok200(await c.post('/api/login', { username, password: 'Provvisoria1' }));
    ok200(await c.post('/api/password', { attuale: 'Provvisoria1', nuova: PW }));
    U[username] = { client: c, id: r.utente.id, nome };
  };
  await mk('farma', 'Maria Farmacista', 'farmacista', []);
  await mk('deg', 'Luca Infermiere', 'reparto', ['r-degenza']);
  await mk('sala', 'Anna Sala', 'reparto', ['r-sala']);
  await mk('dir', 'Direzione Sanitaria', 'consultazione', []);
  const f = U.farma.client;
  for (const [k, nome] of [['para', 'PARACETAMOLO 1 g fl'], ['keto', 'KETOROLAC 30 mg f'], ['garze', 'GARZE 10x10']]) {
    ART[k] = ok200(await f.post('/api/articoli', { nome, categoria: k === 'garze' ? 'PRESIDI' : 'FARMACI', unita: 'pz', prezzo: 1 })).articolo;
  }
  ok200(await f.post('/api/movimenti', { movimenti: [
    { tipo: 'carico', data: oggi(), articoloId: ART.para.id, repartoId: 'r-farmacia', quantita: 20, lotto: 'P-TARDI', scadenza: '2028-06' },
    { tipo: 'carico', data: oggi(), articoloId: ART.para.id, repartoId: 'r-farmacia', quantita: 10, lotto: 'P-PRESTO', scadenza: '2027-01' },
    { tipo: 'carico', data: oggi(), articoloId: ART.keto.id, repartoId: 'r-farmacia', quantita: 4, lotto: 'K1', scadenza: '2027-09' },
    { tipo: 'carico', data: oggi(), articoloId: ART.garze.id, repartoId: 'r-farmacia', quantita: 100, lotto: 'G1', scadenza: '2029-01' },
    { tipo: 'carico', data: oggi(), articoloId: ART.garze.id, repartoId: 'r-degenza', quantita: 30, lotto: 'G0', scadenza: '2029-01' }
  ] }));
});

test.after(async () => { if (S) await S.ferma(); });

test('sincronizzazione: tabelle nuove e magazzino "In transito"', async () => {
  const d = await dati(admin);
  for (const k of ['armadi', 'assortimento', 'richieste', 'richiesteRighe', 'ddt', 'ddtRighe']) assert.ok(Array.isArray(d[k]), k);
  const t = d.reparti.find((r) => r.id === T);
  assert.equal(t.tipo, 'transito');
  assert.equal(t.nome, 'In transito');
  const tr = ok200(await U.farma.client.get('/api/trasportatori'));
  assert.ok(tr.utenti.some((u) => u.nome === 'Luca Infermiere'));
  assert.equal((await U.dir.client.get('/api/trasportatori')).stato, 403);
});

let RIC;

test('richiesta: permessi per ruolo e magazzino, bozza, modifica e invio', async () => {
  const deg = U.deg.client;
  assert.equal((await U.dir.client.post('/api/richieste', { repartoId: 'r-degenza', righe: [{ articoloId: ART.para.id, quantita: 1 }] })).stato, 403);
  assert.equal((await deg.post('/api/richieste', { repartoId: 'r-sala', righe: [{ articoloId: ART.para.id, quantita: 1 }] })).stato, 403);
  assert.equal((await deg.post('/api/richieste', { repartoId: 'r-degenza', righe: [] })).stato, 400);
  assert.equal((await deg.post('/api/richieste', { repartoId: 'r-degenza', righe: [{ articoloId: ART.para.id, quantita: 0 }] })).stato, 400);
  assert.equal((await deg.post('/api/richieste', { repartoId: 'r-degenza', fornitoreId: 'r-degenza', righe: [{ articoloId: ART.para.id, quantita: 1 }] })).stato, 400);
  assert.equal((await deg.post('/api/richieste', { repartoId: T, righe: [{ articoloId: ART.para.id, quantita: 1 }] })).stato, 400);

  const r = ok200(await deg.post('/api/richieste', {
    repartoId: 'r-degenza', urgente: true, note: 'Per il fine settimana',
    righe: [{ articoloId: ART.para.id, quantita: 10, nota: 'prima' }, { articoloId: ART.keto.id, quantita: 6 }, { articoloId: ART.para.id, quantita: 5, nota: 'seconda' }]
  }));
  RIC = r.richiesta;
  assert.equal(RIC.numero, 'RIC-' + ANNO + '-0001');
  assert.equal(RIC.stato, 'bozza');
  assert.equal(RIC.fornitoreId, 'r-farmacia', 'senza fornitore si chiede alla farmacia centrale');
  assert.equal(RIC.creataDaNome, 'Luca Infermiere');
  assert.equal(RIC.urgente, true);
  assert.deepEqual(r.righe.map((x) => [x.articoloId, x.quantita, x.nota]), [[ART.para.id, 15, 'prima · seconda'], [ART.keto.id, 6, '']]);

  // un altro magazzino non la tocca; la farmacia non prende una bozza
  assert.equal((await U.sala.client.put('/api/richieste/' + RIC.id, { note: 'x' })).stato, 403);
  assert.equal((await U.farma.client.post('/api/richieste/' + RIC.id + '/prendi')).stato, 409);
  assert.equal((await deg.post('/api/richieste/' + RIC.id + '/prendi')).stato, 403);

  // modifica: tolgo i keto, aggiungo garze; la riga tolta arriva ai browser come cancellata
  const prima = ok200(await deg.get('/api/dati?da=0')).rev;
  const rigaKeto = r.righe.find((x) => x.articoloId === ART.keto.id);
  const m = ok200(await deg.put('/api/richieste/' + RIC.id, {
    righe: [{ id: r.righe[0].id, articoloId: ART.para.id, quantita: 15 }, { articoloId: ART.keto.id, quantita: 6 }, { articoloId: ART.garze.id, quantita: 40 }]
  }));
  assert.equal(m.righe.length, 3);
  assert.equal(m.righe[0].id, r.righe[0].id, 'la riga che resta tiene il suo id');
  const m2 = ok200(await deg.put('/api/richieste/' + RIC.id, { righe: m.righe.filter((x) => x.articoloId !== ART.keto.id).map((x) => ({ id: x.id, articoloId: x.articoloId, quantita: x.quantita })) }));
  assert.equal(m2.righe.length, 2);
  const cambi = ok200(await deg.get('/api/dati?da=' + prima));
  assert.ok(cambi.cancellati.some((c) => c.tabella === 'richiesteRighe'), JSON.stringify(cambi.cancellati));
  assert.ok(!cambi.cancellati.some((c) => c.id === rigaKeto.id && c.tabella !== 'richiesteRighe'));
  assert.ok(cambi.richieste.some((x) => x.id === RIC.id));

  const inv = ok200(await deg.post('/api/richieste/' + RIC.id + '/invia'));
  assert.equal(inv.richiesta.stato, 'inviata');
  assert.ok(inv.richiesta.inviataIl);
  assert.equal((await deg.post('/api/richieste/' + RIC.id + '/invia')).stato, 409);
});

let DDT1;

test('evasione: presa in carico, approvazione, DDT con lotti FEFO e merce che non basta', async () => {
  const f = U.farma.client;
  const deg = U.deg.client;
  const app = ok200(await f.post('/api/richieste/' + RIC.id + '/approva', {
    righe: [{ id: (await righeDi(RIC.id)).find((x) => x.articoloId === ART.para.id).id, approvata: 14 }]
  }));
  assert.equal(app.richiesta.stato, 'in_lavorazione', 'approvare prende in carico');
  assert.equal(app.richiesta.presaDaNome, 'Maria Farmacista');
  const para = app.righe.find((x) => x.articoloId === ART.para.id);
  const garze = app.righe.find((x) => x.articoloId === ART.garze.id);
  assert.equal(para.approvata, 14);
  assert.equal(garze.approvata, 40, 'le righe non toccate partono dalla quantità chiesta');

  // presa in carico: il richiedente non la modifica né la annulla più
  const mod = await deg.put('/api/richieste/' + RIC.id, { note: 'cambio' });
  assert.equal(mod.stato, 409);
  assert.match(mod.json.errore, /preso in carico/);
  assert.equal((await deg.post('/api/richieste/' + RIC.id + '/annulla', { motivo: 'x' })).stato, 409);
  assert.equal((await U.sala.client.post('/api/richieste/' + RIC.id + '/approva', { righe: [] })).stato, 403);

  // garze: in farmacia ce ne sono 100 → il DDT prende 40; paracetamolo: prima il lotto che scade prima
  const p = ok200(await f.post('/api/richieste/' + RIC.id + '/ddt', { righe: [{ rigaId: para.id, quantita: 14 }, { rigaId: garze.id, quantita: 40 }] }));
  DDT1 = p.ddt;
  assert.equal(DDT1.numero, 'DDT-' + ANNO + '-0001');
  assert.equal(DDT1.stato, 'in_preparazione');
  assert.equal(DDT1.origineId, 'r-farmacia');
  assert.equal(DDT1.destinazioneId, 'r-degenza');
  assert.equal(DDT1.richiestaId, RIC.id);
  assert.equal(DDT1.preparatoDaNome, 'Maria Farmacista');
  assert.deepEqual(p.righe.filter((x) => x.articoloId === ART.para.id).map((x) => [x.lotto, x.scadenza, x.quantita]), [['P-PRESTO', '2027-01', 10], ['P-TARDI', '2028-06', 4]]);
  assert.ok(p.righe.every((x) => x.richiestaRigaId), 'le righe sono collegate alla richiesta');
  assert.deepEqual(p.mancanti, []);
  // in preparazione le giacenze non si muovono
  assert.equal(await giacenza(f, ART.para.id, 'r-farmacia'), 30);
  // non c'è altro da preparare: tutto l'approvato è già in un DDT
  const ancora = await f.post('/api/richieste/' + RIC.id + '/ddt', {});
  assert.equal(ancora.stato, 409);
  assert.match(ancora.json.errore, /non resta niente/);
  // massimo il residuo
  assert.equal((await f.post('/api/richieste/' + RIC.id + '/ddt', { righe: [{ rigaId: para.id, quantita: 1 }] })).stato, 400);
  // approvare meno di quanto è già nel DDT: no
  assert.equal((await f.post('/api/richieste/' + RIC.id + '/approva', { righe: [{ id: para.id, approvata: 3 }] })).stato, 409);
  // non si rifiuta una richiesta con un DDT; non si chiude con un DDT in preparazione
  assert.equal((await f.post('/api/richieste/' + RIC.id + '/rifiuta', { motivo: 'no' })).stato, 409);
  assert.equal((await f.post('/api/richieste/' + RIC.id + '/chiudi', { motivo: 'no' })).stato, 409);

  // la merce libera conta i DDT in preparazione: dei 30 paracetamolo 14 sono impegnati
  const troppo = await f.post('/api/ddt', { origineId: 'r-farmacia', destinazioneId: 'r-sala', righe: [{ articoloId: ART.para.id, quantita: 17 }] });
  assert.equal(troppo.stato, 409);
  assert.match(troppo.json.errore, /liberi 16 su 17/);

  // richiesta con più di quanto c'è: il DDT prepara quello che c'è e lo dice
  const r2 = ok200(await U.sala.client.post('/api/richieste', { repartoId: 'r-sala', invia: true, righe: [{ articoloId: ART.keto.id, quantita: 10 }] }));
  assert.equal(r2.richiesta.stato, 'inviata');
  assert.equal(r2.richiesta.numero, 'RIC-' + ANNO + '-0002');
  const p2 = ok200(await f.post('/api/richieste/' + r2.richiesta.id + '/ddt', {}));
  assert.deepEqual(p2.righe.map((x) => [x.lotto, x.quantita]), [['K1', 4]]);
  assert.deepEqual(p2.mancanti.map((x) => [x.articoloId, x.richiesta, x.preparata]), [[ART.keto.id, 10, 4]]);
  assert.equal(p2.richiesta.stato, 'in_lavorazione');
  // il DDT della Sala si annulla (in preparazione: niente da muovere) e la richiesta si chiude con il residuo
  const an = ok200(await f.post('/api/ddt/' + p2.ddt.id + '/annulla', { motivo: 'Arriva dal grossista' }));
  assert.equal(an.ddt.stato, 'annullato');
  assert.equal(an.ddt.motivoAnnullo, 'Arriva dal grossista');
  const ch = ok200(await f.post('/api/richieste/' + r2.richiesta.id + '/chiudi', { motivo: 'Il resto la settimana prossima' }));
  assert.equal(ch.richiesta.stato, 'chiusa');
  assert.equal(ch.richiesta.chiusaDaNome, 'Maria Farmacista');
  assert.equal((await f.post('/api/richieste/' + r2.richiesta.id + '/ddt', {})).stato, 409);
});

async function righeDi(richiestaId) {
  return (await dati(admin)).richiesteRighe.filter((x) => x.richiestaId === richiestaId);
}

test('DDT in preparazione: modifica delle righe, poi spedizione con il trasportatore', async () => {
  const f = U.farma.client;
  const righe = (await dati(f)).ddtRighe.filter((x) => x.ddtId === DDT1.id);
  // tolgo 2 garze (38 invece di 40) e scelgo io il lotto del paracetamolo
  const nuove = righe.map((x) => ({ articoloId: x.articoloId, quantita: x.articoloId === ART.garze.id ? 38 : x.quantita, lotto: x.lotto, richiestaRigaId: x.richiestaRigaId }));
  const m = ok200(await f.put('/api/ddt/' + DDT1.id, { righe: nuove, colli: 2, note: 'Fragile' }));
  assert.equal(m.ddt.colli, 2);
  assert.equal(m.righe.find((x) => x.articoloId === ART.garze.id).quantita, 38);
  // oltre l'approvato della riga della richiesta: no
  const oltre = nuove.map((x) => Object.assign({}, x, { quantita: x.articoloId === ART.garze.id ? 41 : x.quantita }));
  assert.equal((await f.put('/api/ddt/' + DDT1.id, { righe: oltre })).stato, 400);
  // chi non scrive nella farmacia non spedisce
  assert.equal((await U.deg.client.post('/api/ddt/' + DDT1.id + '/spedisci', { trasportatoreNome: 'x' })).stato, 403);
  // serve chi trasporta
  assert.equal((await f.post('/api/ddt/' + DDT1.id + '/spedisci', {})).stato, 400);
  assert.equal((await f.post('/api/ddt/' + DDT1.id + '/spedisci', { trasportatoreId: 'u-inesistente' })).stato, 400);
  // il richiedente non può ancora ricevere
  assert.equal((await U.deg.client.post('/api/ddt/' + DDT1.id + '/ricevi', {})).stato, 409);

  const sp = ok200(await f.post('/api/ddt/' + DDT1.id + '/spedisci', { trasportatoreId: U.deg.id }));
  assert.equal(sp.ddt.stato, 'in_transito');
  assert.equal(sp.ddt.trasportatoreNome, 'Luca Infermiere');
  assert.equal(sp.ddt.trasportatoreId, U.deg.id);
  assert.ok(sp.ddt.partitoIl);
  assert.equal((await f.post('/api/ddt/' + DDT1.id + '/spedisci', { trasportatoreNome: 'x' })).stato, 409, 'già partito');
  assert.equal((await f.put('/api/ddt/' + DDT1.id, { note: 'x' })).stato, 409, 'partito: non si modifica');

  const d = await dati(f);
  const mov = d.movimenti.filter((x) => x.ddtId === DDT1.id);
  assert.equal(mov.length, 3);
  assert.ok(mov.every((x) => x.tipo === 'trasferimento' && x.repartoId === 'r-farmacia' && x.repartoDestId === T && x.documento === DDT1.numero && x.data === oggi()));
  const s = { movimenti: d.movimenti, articoli: d.articoli };
  assert.equal(C.giacenza(s, ART.para.id, 'r-farmacia'), 16);
  assert.equal(C.giacenza(s, ART.para.id, T), 14, 'la merce partita è "in transito"');
  assert.equal(C.giacenza(s, ART.garze.id, T), 38);
  assert.deepEqual(C.merceInViaggio(d), { [ART.para.id + '|r-degenza']: 14, [ART.garze.id + '|r-degenza']: 38 });
  // la richiesta: le garze approvate erano 40, ne partono 38 → non ancora evasa
  const ric = d.richieste.find((x) => x.id === RIC.id);
  assert.equal(ric.stato, 'in_lavorazione');
  const t = C.totaliRichiesta(d, RIC.id);
  assert.equal(t.spedita, 52);
  assert.equal(t.residuo, 2);

  // i movimenti del DDT non si annullano dalla pagina Movimenti
  const no = await f.post('/api/movimenti/' + mov[0].id + '/annulla', { motivo: 'prova' });
  assert.equal(no.stato, 409);
  assert.match(no.json.errore, /annulla il DDT/);
  // niente movimenti a mano sul magazzino in transito
  assert.equal((await f.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi(), articoloId: ART.para.id, repartoId: T, quantita: 1 }] })).stato, 400);
  assert.equal((await f.post('/api/movimenti', { movimenti: [{ tipo: 'trasferimento', data: oggi(), articoloId: ART.para.id, repartoId: 'r-farmacia', repartoDestId: T, quantita: 1 }] })).stato, 400);
});

test('ricezione con differenze: quello che arriva entra, la differenza rientra o è persa in viaggio', async () => {
  const deg = U.deg.client;
  const righe = (await dati(deg)).ddtRighe.filter((x) => x.ddtId === DDT1.id);
  const presto = righe.find((x) => x.lotto === 'P-PRESTO');
  const tardi = righe.find((x) => x.lotto === 'P-TARDI');
  const garze = righe.find((x) => x.articoloId === ART.garze.id);
  // un altro magazzino non riceve; chi è in consultazione nemmeno
  assert.equal((await U.sala.client.post('/api/ddt/' + DDT1.id + '/ricevi', {})).stato, 403);
  assert.equal((await U.dir.client.post('/api/ddt/' + DDT1.id + '/ricevi', {})).stato, 403);
  // differenza senza dire cosa farne: no; più di quanto è partito: no
  assert.equal((await deg.post('/api/ddt/' + DDT1.id + '/ricevi', { righe: [{ id: presto.id, ricevuta: 9 }] })).stato, 400);
  assert.equal((await deg.post('/api/ddt/' + DDT1.id + '/ricevi', { righe: [{ id: presto.id, ricevuta: 11 }] })).stato, 400);

  const r = ok200(await deg.post('/api/ddt/' + DDT1.id + '/ricevi', {
    note: 'Una scatola aperta',
    righe: [
      { id: presto.id, ricevuta: 9, esito: 'rientro', nota: 'una fiala in più nel carrello' },
      { id: tardi.id, ricevuta: 3, esito: 'perdita', nota: 'fiala rotta' },
      { id: garze.id, ricevuta: 38 }
    ]
  }));
  assert.equal(r.ddt.stato, 'ricevuto_con_differenze');
  assert.equal(r.ddt.ricevutoDaNome, 'Luca Infermiere');
  assert.equal(r.ddt.noteRicezione, 'Una scatola aperta');
  assert.deepEqual(r.righe.map((x) => [x.lotto, x.ricevuta, x.esito]).sort(), [['G1', 38, ''], ['P-PRESTO', 9, 'rientro'], ['P-TARDI', 3, 'perdita']]);
  assert.equal((await deg.post('/api/ddt/' + DDT1.id + '/ricevi', {})).stato, 409, 'già ricevuto');
  assert.equal((await U.farma.client.post('/api/ddt/' + DDT1.id + '/annulla', { motivo: 'x' })).stato, 409, 'ricevuto: si fa un reso');

  const d = await dati(deg);
  const s = { movimenti: d.movimenti, articoli: d.articoli };
  assert.equal(C.giacenza(s, ART.para.id, 'r-degenza'), 12);
  assert.equal(C.giacenza(s, ART.para.id, 'r-farmacia'), 17, 'la fiala in più rientra in farmacia');
  assert.equal(C.giacenza(s, ART.para.id, T), 0);
  assert.equal(C.giacenza(s, ART.garze.id, 'r-degenza'), 68);
  assert.deepEqual(C.lotti(s, ART.para.id, 'r-degenza').map((l) => [l.lotto, l.quantita]), [['P-PRESTO', 9], ['P-TARDI', 3]]);
  const persa = d.movimenti.find((x) => x.ddtId === DDT1.id && x.tipo === 'perdita');
  assert.equal(persa.repartoId, T);
  assert.equal(persa.quantita, 1);
  assert.equal(persa.causale, 'Differenza alla ricezione DDT ' + DDT1.numero);
  const rientro = d.movimenti.find((x) => x.ddtId === DDT1.id && x.repartoDestId === 'r-farmacia');
  assert.equal(rientro.quantita, 1);
  assert.equal(rientro.causale, 'Differenza alla ricezione DDT ' + DDT1.numero);
  assert.deepEqual(C.merceInViaggio(d), {});
  // la fiala rientrata torna da spedire (come con l'annullo); quella persa in viaggio resta spedita
  const avPara = C.avanzamentoRichiesta(d, RIC.id).find((x) => x.articoloId === ART.para.id);
  assert.deepEqual([avPara.base, avPara.spedita, avPara.residuo], [14, 13, 1]);
  assert.equal(d.richieste.find((x) => x.id === RIC.id).stato, 'in_lavorazione');
});

test('annullo di un DDT partito: tutto rientra all\'origine e la richiesta torna in lavorazione', async () => {
  const f = U.farma.client;
  // la fiala rientrata alla ricezione e le 2 garze che mancavano: un secondo DDT evade la richiesta
  const p = ok200(await f.post('/api/richieste/' + RIC.id + '/ddt', {}));
  assert.deepEqual(p.righe.map((x) => [x.articoloId, x.quantita]), [[ART.para.id, 1], [ART.garze.id, 2]]);
  ok200(await f.post('/api/ddt/' + p.ddt.id + '/spedisci', { trasportatoreNome: 'Gino del magazzino', colli: 1 }));
  let d = await dati(f);
  assert.equal(d.richieste.find((x) => x.id === RIC.id).stato, 'evasa', 'tutto l\'approvato è partito');
  assert.equal(C.giacenza(d, ART.garze.id, 'r-farmacia'), 60);
  // chi non scrive nell'origine non annulla
  assert.equal((await U.deg.client.post('/api/ddt/' + p.ddt.id + '/annulla', { motivo: 'x' })).stato, 403);
  const an = ok200(await f.post('/api/ddt/' + p.ddt.id + '/annulla', { motivo: 'Carrello sbagliato' }));
  assert.equal(an.ddt.stato, 'annullato');
  assert.equal(an.ddt.annullatoDa, 'Maria Farmacista');
  d = await dati(f);
  assert.equal(C.giacenza(d, ART.garze.id, 'r-farmacia'), 62, 'rientrate');
  assert.equal(C.giacenza(d, ART.garze.id, T), 0);
  const rientro = d.movimenti.find((x) => x.ddtId === p.ddt.id && x.repartoId === T);
  assert.equal(rientro.repartoDestId, 'r-farmacia');
  assert.equal(rientro.causale, 'Annullo DDT ' + p.ddt.numero);
  assert.equal(d.richieste.find((x) => x.id === RIC.id).stato, 'in_lavorazione');
  assert.equal((await f.post('/api/ddt/' + p.ddt.id + '/annulla', { motivo: 'x' })).stato, 409);
});

test('concorrenza: la giacenza si ricontrolla alla spedizione', async () => {
  const f = U.farma.client;
  // DDT con tutti i 4 keto, poi la farmacia ne consuma 3: la spedizione non passa
  const d1 = ok200(await f.post('/api/ddt', { origineId: 'r-farmacia', destinazioneId: 'r-sala', causale: 'Rifornimento', righe: [{ articoloId: ART.keto.id, quantita: 4, lotto: 'K1' }] }));
  assert.equal(d1.ddt.richiestaId, null);
  assert.deepEqual(d1.righe.map((x) => [x.lotto, x.quantita]), [['K1', 4]]);
  ok200(await f.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi(), articoloId: ART.keto.id, repartoId: 'r-farmacia', quantita: 3 }] }));
  const no = await f.post('/api/ddt/' + d1.ddt.id + '/spedisci', { trasportatoreNome: 'Gino' });
  assert.equal(no.stato, 409);
  assert.match(no.json.errore, /KETOROLAC 30 mg f lotto K1: 1 invece di 4/);
  assert.equal((await dati(f)).ddt.find((x) => x.id === d1.ddt.id).stato, 'in_preparazione', 'niente è cambiato');
  // lotto scelto che non c'è
  assert.equal((await f.put('/api/ddt/' + d1.ddt.id, { righe: [{ articoloId: ART.keto.id, quantita: 1, lotto: 'NESSUNO' }] })).stato, 409);
  ok200(await f.put('/api/ddt/' + d1.ddt.id, { righe: [{ articoloId: ART.keto.id, quantita: 1 }] }));
  // due spedizioni contemporanee dello stesso DDT: una sola passa
  const [a, b] = await Promise.all([
    f.post('/api/ddt/' + d1.ddt.id + '/spedisci', { trasportatoreNome: 'Gino' }),
    admin.post('/api/ddt/' + d1.ddt.id + '/spedisci', { trasportatoreNome: 'Pino' })
  ]);
  assert.deepEqual([a.stato, b.stato].sort(), [200, 409]);
  const d = await dati(f);
  assert.equal(d.movimenti.filter((x) => x.ddtId === d1.ddt.id).length, 1);
  assert.equal(C.giacenza(d, ART.keto.id, 'r-farmacia'), 0);
  // ricevuto per intero (nessuna riga indicata)
  const ric = ok200(await U.sala.client.post('/api/ddt/' + d1.ddt.id + '/ricevi', {}));
  assert.equal(ric.ddt.stato, 'ricevuto');
});

test('reso dal magazzino periferico e rifiuto di una richiesta', async () => {
  const deg = U.deg.client;
  // il reparto prepara DDT solo dai propri magazzini
  assert.equal((await deg.post('/api/ddt', { origineId: 'r-farmacia', destinazioneId: 'r-degenza', righe: [{ articoloId: ART.garze.id, quantita: 1 }] })).stato, 403);
  assert.equal((await deg.post('/api/ddt', { origineId: 'r-degenza', destinazioneId: 'r-degenza', righe: [{ articoloId: ART.garze.id, quantita: 1 }] })).stato, 400);
  assert.equal((await deg.post('/api/ddt', { origineId: 'r-degenza', destinazioneId: T, righe: [{ articoloId: ART.garze.id, quantita: 1 }] })).stato, 400);
  const reso = ok200(await deg.post('/api/ddt', { origineId: 'r-degenza', destinazioneId: 'r-farmacia', causale: 'Reso alla farmacia', righe: [{ articoloId: ART.garze.id, quantita: 5, lotto: 'G0' }] }));
  assert.deepEqual(reso.righe.map((x) => [x.lotto, x.quantita]), [['G0', 5]]);
  ok200(await deg.post('/api/ddt/' + reso.ddt.id + '/spedisci', { trasportatoreNome: 'Luca' }));
  // il reparto non riceve in farmacia; la farmacista sì
  assert.equal((await deg.post('/api/ddt/' + reso.ddt.id + '/ricevi', {})).stato, 403);
  ok200(await U.farma.client.post('/api/ddt/' + reso.ddt.id + '/ricevi', {}));
  const d = await dati(deg);
  assert.equal(C.giacenza(d, ART.garze.id, 'r-degenza'), 63);

  const r = ok200(await deg.post('/api/richieste', { repartoId: 'r-degenza', invia: true, righe: [{ articoloId: ART.para.id, quantita: 2 }] }));
  assert.equal((await U.farma.client.post('/api/richieste/' + r.richiesta.id + '/rifiuta', {})).stato, 400, 'serve il motivo');
  const rif = ok200(await U.farma.client.post('/api/richieste/' + r.richiesta.id + '/rifiuta', { motivo: 'Usate quello in armadio' }));
  assert.equal(rif.richiesta.stato, 'rifiutata');
  assert.equal(rif.richiesta.motivo, 'Usate quello in armadio');
  assert.equal(rif.richiesta.presaDaNome, 'Maria Farmacista');

  const b = ok200(await deg.post('/api/richieste', { repartoId: 'r-degenza', righe: [{ articoloId: ART.para.id, quantita: 2 }] }));
  const an = ok200(await deg.post('/api/richieste/' + b.richiesta.id + '/annulla', { motivo: 'Doppione' }));
  assert.equal(an.richiesta.stato, 'annullata');
  assert.equal((await deg.post('/api/richieste/' + b.richiesta.id + '/invia')).stato, 409);
});

test('nota consumi e registro attività coerenti con i DDT', async () => {
  const d = await dati(admin);
  const [anno, mese] = oggi().split('-').map(Number);
  const giorno = Number(oggi().slice(8, 10));
  const reg = (rep, cat) => C.registroMensile(d, { repartoId: rep, anno, mese, categoria: cat }).righe;
  // farmacia: il paracetamolo partito con i DDT è un'uscita del giorno di partenza; quello che rientra (1 alla
  // ricezione del primo DDT, 1 con l'annullo del secondo) non è un carico ma toglie l'uscita: 14 + 1 − 1 − 1 = 13
  const farPara = reg('r-farmacia', 'FARMACI').find((x) => x.articoloId === ART.para.id);
  assert.equal(farPara.consumi[giorno - 1], 13);
  assert.equal(farPara.carichi, 30);
  assert.equal(farPara.residui, 17);
  assert.equal(farPara.trasferiti[giorno - 1], 13, 'la casella è tutta merce partita con i DDT, niente consumi');
  // degenza: entra solo quello ricevuto
  const degPara = reg('r-degenza', 'FARMACI').find((x) => x.articoloId === ART.para.id);
  assert.equal(degPara.carichi, 12);
  assert.equal(degPara.residui, 12);
  // "In transito" non ha residui
  assert.ok(reg(T, 'FARMACI').every((x) => x.residui === 0));

  const ev = ok200(await admin.get('/api/attivita?limite=500')).eventi.map((e) => e.azione);
  for (const a of ['richieste.crea', 'richieste.modifica', 'richieste.invia', 'richieste.approva', 'richieste.chiudi', 'richieste.rifiuta', 'richieste.annulla',
    'ddt.crea', 'ddt.modifica', 'ddt.spedisci', 'ddt.ricevi', 'ddt.annulla']) {
    assert.ok(ev.includes(a), 'manca ' + a);
  }
  const ricevi = ok200(await admin.get('/api/attivita?azione=ddt.ricevi')).eventi;
  assert.ok(ricevi.some((e) => e.dettagli.differenze && e.dettagli.differenze.length === 2));
});

test('magazzino "In transito": non si modifica né si elimina', async () => {
  assert.equal((await admin.del('/api/reparti/' + T)).stato, 400);
  const d = await dati(admin);
  const lista = d.reparti.map((r) => ({ id: r.id, nome: r.id === T ? 'Rinominato' : r.nome, centrale: r.centrale, attivo: r.id === T ? false : r.attivo }));
  ok200(await admin.put('/api/reparti', { reparti: lista }));
  const t = (await dati(admin)).reparti.find((r) => r.id === T);
  assert.equal(t.nome, 'In transito');
  assert.equal(t.attivo, true);
  assert.equal(t.tipo, 'transito');
  const doppio = await admin.put('/api/reparti', { reparti: lista.filter((r) => r.id !== T).concat([{ nome: 'In transito', centrale: false, attivo: true }]) });
  assert.equal(doppio.stato, 400);
  const centrale = (await dati(admin)).reparti.find((r) => r.id === 'r-farmacia');
  assert.equal(centrale.tipo, 'centrale');
  assert.equal((await dati(admin)).reparti.find((r) => r.id === 'r-degenza').tipo, 'periferico');
  // un reparto con richieste o DDT non si elimina (risposta chiara, non un errore del server)
  const nuovo = ok200(await admin.put('/api/reparti', { reparti: lista.filter((r) => r.id !== T).concat([{ nome: 'Day hospital', centrale: false, attivo: true }]) }));
  const dh = nuovo.reparti.find((r) => r.nome === 'Day hospital');
  ok200(await U.farma.client.post('/api/richieste', { repartoId: dh.id, righe: [{ articoloId: ART.para.id, quantita: 1 }] }));
  const el = await admin.del('/api/reparti/' + dh.id);
  assert.equal(el.stato, 409);
  assert.match(el.json.errore, /richieste o DDT/);
});

test('notifiche: ogni passaggio avvisa i browser collegati', async () => {
  const ctrl = new AbortController();
  const r = await fetch(S.base + '/api/eventi', { headers: { Cookie: U.farma.client.cookie }, signal: ctrl.signal });
  const lettore = r.body.getReader();
  let testo = '';
  const leggi = (async () => { for (;;) { const { value, done } = await lettore.read(); if (done) break; testo += Buffer.from(value).toString(); } })().catch(() => {});
  await new Promise((ok) => setTimeout(ok, 200));
  const prima = (testo.match(/event: rev/g) || []).length;
  ok200(await U.deg.client.post('/api/richieste', { repartoId: 'r-degenza', invia: true, righe: [{ articoloId: ART.garze.id, quantita: 3 }] }));
  await new Promise((ok) => setTimeout(ok, 300));
  ctrl.abort();
  await leggi;
  assert.ok((testo.match(/event: rev/g) || []).length > prima, testo);
});

/* ---------- correzioni dopo la revisione (approvazioni contemporanee, rientri, lotti) ---------- */

function giorno(piu) {
  const d = new Date();
  d.setDate(d.getDate() + piu);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* Mese di scadenza (AAAA-MM) già passato: due mesi fa. */
function meseScaduto() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 2);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

async function articoloNuovo(nome) {
  return ok200(await U.farma.client.post('/api/articoli', { nome, categoria: 'FARMACI', unita: 'pz', prezzo: 1 })).articolo;
}

test('trasportatori: solo nome e id degli utenti attivi, senza ruoli', async () => {
  const tr = ok200(await U.farma.client.get('/api/trasportatori'));
  assert.ok(tr.utenti.length >= 4);
  assert.ok(tr.utenti.every((u) => JSON.stringify(Object.keys(u).sort()) === '["id","nome"]'), JSON.stringify(tr.utenti[0]));
});

test('approvazione: chi salva quantità viste prima di un cambiamento riceve 409 e non sovrascrive', async () => {
  const a = await articoloNuovo('MORFINA 10 mg f');
  const r = ok200(await U.deg.client.post('/api/richieste', { repartoId: 'r-degenza', invia: true, righe: [{ articoloId: a.id, quantita: 20 }] }));
  const riga = r.righe[0].id;
  // la pagina della richiesta inviata mostra "non approvata" (prima: null): salvare così prende in carico
  ok200(await U.farma.client.post('/api/richieste/' + r.richiesta.id + '/approva', { righe: [{ id: riga, approvata: 4, prima: null }] }));
  // l'amministratore aveva la pagina aperta da prima (non approvata): 409, l'approvata resta 4
  const vecchia = await admin.post('/api/richieste/' + r.richiesta.id + '/approva', { righe: [{ id: riga, approvata: 20, prima: null }] });
  assert.equal(vecchia.stato, 409);
  assert.match(vecchia.json.errore, /Maria Farmacista ha cambiato la quantità approvata di MORFINA 10 mg f \(ora 4\)/);
  assert.equal((await righeDi(r.richiesta.id))[0].approvata, 4);
  // con la pagina ricaricata (prima: 4) si salva
  const nuova = ok200(await admin.post('/api/richieste/' + r.richiesta.id + '/approva', { righe: [{ id: riga, approvata: 5, prima: 4 }] }));
  assert.equal(nuova.righe[0].approvata, 5);
  // e chi aveva visto 4 adesso trova 5
  assert.equal((await U.farma.client.post('/api/richieste/' + r.richiesta.id + '/approva', { righe: [{ id: riga, approvata: 3, prima: 4 }] })).stato, 409);
  assert.equal((await righeDi(r.richiesta.id))[0].approvata, 5);
});

test('ricezione con merce che rientra: la richiesta evasa torna in lavorazione e il residuo si rispedisce', async () => {
  const f = U.farma.client;
  const a = await articoloNuovo('RIENTRO 1 g fl');
  ok200(await f.post('/api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(), articoloId: a.id, repartoId: 'r-farmacia', quantita: 50, lotto: 'R1', scadenza: '2031-01' }] }));
  const r = ok200(await U.deg.client.post('/api/richieste', { repartoId: 'r-degenza', invia: true, righe: [{ articoloId: a.id, quantita: 10 }] }));
  const p = ok200(await f.post('/api/richieste/' + r.richiesta.id + '/ddt', {}));
  ok200(await f.post('/api/ddt/' + p.ddt.id + '/spedisci', { trasportatoreNome: 'Gino' }));
  assert.equal((await dati(f)).richieste.find((x) => x.id === r.richiesta.id).stato, 'evasa');
  ok200(await U.deg.client.post('/api/ddt/' + p.ddt.id + '/ricevi', { righe: [{ id: p.righe[0].id, ricevuta: 6, esito: 'rientro', nota: 'scatola sbagliata' }] }));
  let d = await dati(f);
  assert.equal(d.richieste.find((x) => x.id === r.richiesta.id).stato, 'in_lavorazione', 'i 4 rientrati sono di nuovo da spedire');
  const av = C.avanzamentoRichiesta(d, r.richiesta.id)[0];
  assert.deepEqual([av.spedita, av.residuo], [6, 4]);
  assert.deepEqual([C.giacenza(d, a.id, 'r-degenza'), C.giacenza(d, a.id, 'r-farmacia')], [6, 44]);
  const ev = ok200(await admin.get('/api/attivita?azione=ddt.ricevi')).eventi.find((e) => e.dettagli.numero === p.ddt.numero);
  assert.equal(ev.dettagli.richiesta, 'in_lavorazione');
  // la farmacia rispedisce i 4
  const p2 = ok200(await f.post('/api/richieste/' + r.richiesta.id + '/ddt', {}));
  assert.deepEqual(p2.righe.map((x) => x.quantita), [4]);
  ok200(await f.post('/api/ddt/' + p2.ddt.id + '/spedisci', { trasportatoreNome: 'Gino' }));
  // la perdita in viaggio invece resta spedita: la richiesta resta evasa
  ok200(await U.deg.client.post('/api/ddt/' + p2.ddt.id + '/ricevi', { righe: [{ id: p2.righe[0].id, ricevuta: 3, esito: 'perdita' }] }));
  d = await dati(f);
  assert.equal(d.richieste.find((x) => x.id === r.richiesta.id).stato, 'evasa');
  assert.equal(C.avanzamentoRichiesta(d, r.richiesta.id)[0].residuo, 0);
});

test('nota consumi dell\'origine: DDT annullato in viaggio e differenze che rientrano non sono consumi né carichi', async () => {
  const f = U.farma.client;
  const a = await articoloNuovo('NOTA T5 cpr');
  ok200(await f.post('/api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(), articoloId: a.id, repartoId: 'r-farmacia', quantita: 40, lotto: 'E1', scadenza: '2031-05' }] }));
  const ddt = async (q) => {
    const x = ok200(await f.post('/api/ddt', { origineId: 'r-farmacia', destinazioneId: 'r-degenza', righe: [{ articoloId: a.id, quantita: q }] }));
    ok200(await f.post('/api/ddt/' + x.ddt.id + '/spedisci', { trasportatoreNome: 'X' }));
    return x;
  };
  const d1 = await ddt(15);
  ok200(await U.deg.client.post('/api/ddt/' + d1.ddt.id + '/ricevi', { righe: [{ id: d1.righe[0].id, ricevuta: 12, esito: 'perdita' }] }));
  const d2 = await ddt(5);
  ok200(await U.deg.client.post('/api/ddt/' + d2.ddt.id + '/ricevi', { righe: [{ id: d2.righe[0].id, ricevuta: 3, esito: 'rientro' }] }));
  const d3 = await ddt(4);
  ok200(await f.post('/api/ddt/' + d3.ddt.id + '/annulla', { motivo: 'sbagliato' }));
  const d = await dati(admin);
  const [anno, mese] = oggi().split('-').map(Number);
  const g = Number(oggi().slice(8, 10));
  const far = C.registroMensile(d, { repartoId: 'r-farmacia', anno, mese, categoria: 'FARMACI' }).righe.find((x) => x.articoloId === a.id);
  // uscito davvero: 15 + 5 − 2 rientrati = 18 (di cui 3 persi in viaggio); il DDT annullato non c'è
  assert.deepEqual([far.carichi, far.consumi[g - 1], far.totaleScarico, far.importoScarico, far.residui], [40, 18, 18, 18, 22]);
  const deg = C.registroMensile(d, { repartoId: 'r-degenza', anno, mese, categoria: 'FARMACI' }).righe.find((x) => x.articoloId === a.id);
  assert.deepEqual([deg.carichi, deg.residui], [15, 15]);
});

test('consumo registrato in ritardo dopo la partenza di un DDT: non prende il lotto già partito', async () => {
  const f = U.farma.client;
  const a = await articoloNuovo('RITARDO T11 cpr');
  ok200(await f.post('/api/movimenti', { movimenti: [
    { tipo: 'carico', data: giorno(-3), articoloId: a.id, repartoId: 'r-farmacia', quantita: 10, lotto: 'PRIMO', scadenza: '2030-12' },
    { tipo: 'carico', data: giorno(-3), articoloId: a.id, repartoId: 'r-farmacia', quantita: 10, lotto: 'SECONDO', scadenza: '2031-12' }
  ] }));
  const x = ok200(await f.post('/api/ddt', { origineId: 'r-farmacia', destinazioneId: 'r-degenza', righe: [{ articoloId: a.id, quantita: 10 }] }));
  assert.deepEqual(x.righe.map((r) => [r.lotto, r.quantita]), [['PRIMO', 10]]);
  ok200(await f.post('/api/ddt/' + x.ddt.id + '/spedisci', { trasportatoreNome: 'X' }));
  // il consumo di ieri, scritto stamattina: alla data di ieri PRIMO c'era, ma adesso è tutto partito
  const c = ok200(await f.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: giorno(-1), articoloId: a.id, repartoId: 'r-farmacia', quantita: 4 }] }));
  assert.deepEqual(c.movimenti.map((m) => [m.lotto, m.quantita]), [['SECONDO', 4]]);
  // scegliere a mano il lotto partito: 409
  const scelto = await f.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: giorno(-1), articoloId: a.id, repartoId: 'r-farmacia', quantita: 1, lotto: 'PRIMO' }] });
  assert.equal(scelto.stato, 409);
  ok200(await U.deg.client.post('/api/ddt/' + x.ddt.id + '/ricevi', {}));
  const d = await dati(f);
  const tot = (lotto) => ['r-farmacia', 'r-degenza', T].reduce((t, rep) => t + ((C.lotti(d, a.id, rep).find((l) => l.lotto === lotto) || {}).quantita || 0), 0);
  assert.deepEqual([tot('PRIMO'), tot('SECONDO')], [10, 6]);
  assert.deepEqual(C.lotti(d, a.id, 'r-farmacia').map((l) => [l.lotto, l.quantita]), [['SECONDO', 6]]);
});

test('lotti scaduti: DDT e consumi non li prendono da soli (si possono scegliere), la perdita sì', async () => {
  const f = U.farma.client;
  const a = await articoloNuovo('SCADUTI cpr');
  const vecchio = meseScaduto();
  ok200(await f.post('/api/movimenti', { movimenti: [
    { tipo: 'carico', data: giorno(-90), articoloId: a.id, repartoId: 'r-farmacia', quantita: 5, lotto: 'VECCHIO', scadenza: vecchio },
    { tipo: 'carico', data: oggi(), articoloId: a.id, repartoId: 'r-farmacia', quantita: 3, lotto: 'BUONO', scadenza: '2031-01' }
  ] }));
  // DDT automatico: solo il lotto buono, anche se il vecchio "scade prima"
  const x = ok200(await f.post('/api/ddt', { origineId: 'r-farmacia', destinazioneId: 'r-sala', righe: [{ articoloId: a.id, quantita: 3 }] }));
  assert.deepEqual(x.righe.map((r) => [r.lotto, r.quantita]), [['BUONO', 3]]);
  const no = await f.post('/api/ddt', { origineId: 'r-farmacia', destinazioneId: 'r-sala', righe: [{ articoloId: a.id, quantita: 2 }] });
  assert.equal(no.stato, 409);
  assert.match(no.json.errore, /altri 5 sono in lotti scaduti/);
  // un reso dello scaduto si fa scegliendo il lotto
  const reso = ok200(await f.post('/api/ddt', { origineId: 'r-farmacia', destinazioneId: 'r-sala', righe: [{ articoloId: a.id, quantita: 2, lotto: 'VECCHIO' }] }));
  assert.deepEqual(reso.righe.map((r) => [r.lotto, r.quantita]), [['VECCHIO', 2]]);
  ok200(await f.post('/api/ddt/' + x.ddt.id + '/annulla', { motivo: 'prova' }));
  ok200(await f.post('/api/ddt/' + reso.ddt.id + '/annulla', { motivo: 'prova' }));
  // consumo automatico: il lotto buono
  const c = ok200(await f.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi(), articoloId: a.id, repartoId: 'r-farmacia', quantita: 1 }] }));
  assert.deepEqual(c.movimenti.map((m) => m.lotto), ['BUONO']);
  // perdita "Scaduto" senza lotto: prende lo scaduto
  const p = ok200(await f.post('/api/movimenti', { movimenti: [{ tipo: 'perdita', data: oggi(), articoloId: a.id, repartoId: 'r-farmacia', quantita: 5, causale: 'Scaduto' }] }));
  assert.deepEqual(p.movimenti.map((m) => [m.lotto, m.quantita]), [['VECCHIO', 5]]);
  const d = await dati(f);
  assert.deepEqual(C.lotti(d, a.id, 'r-farmacia').map((l) => [l.lotto, l.quantita]), [['BUONO', 2]]);
});

/* ---------- numerazione per anno (modulo provato direttamente, con l'ora simulata) ---------- */

test('numeri RIC e DDT progressivi per anno, anche dopo il cambio d\'anno', async () => {
  const { Database } = require('../server/db.js');
  const { Accessi } = require('../server/accessi.js');
  const { Operazioni } = require('../server/operazioni.js');
  const { Logistica } = require('../server/logistica.js');
  const A = require('../server/accessi.js');
  const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-numeri-'));
  const database = new Database(cartella);
  try {
    const accessi = new Accessi(database, () => {});
    const operazioni = new Operazioni(database, accessi, () => {});
    let notifiche = 0;
    const L = new Logistica({ database, accessi, operazioni, notifica: () => { notifiche++; } });
    const utente = { id: 'u-1', username: 'farma', nome: 'Farmacista', ruolo: 'farmacista', reparti: [] };
    const ctx = { utente, permessi: A.permessi(utente), ip: '127.0.0.1' };
    const art = operazioni.creaArticolo(ctx, { nome: 'Prova', categoria: 'FARMACI' }).articolo;
    operazioni.registraMovimenti(ctx, [{ tipo: 'carico', data: oggi(), articoloId: art.id, repartoId: 'r-farmacia', quantita: 100 }]);
    let ora = new Date(2026, 11, 31, 23, 50);
    L.adesso = () => ora;
    const nuova = () => L.creaRichiesta(ctx, { repartoId: 'r-degenza', righe: [{ articoloId: art.id, quantita: 1 }] }).richiesta;
    const ddt = () => L.creaDdt(ctx, { origineId: 'r-farmacia', destinazioneId: 'r-degenza', righe: [{ articoloId: art.id, quantita: 1 }] }).ddt;
    assert.deepEqual([nuova().numero, nuova().numero], ['RIC-2026-0001', 'RIC-2026-0002']);
    assert.equal(ddt().numero, 'DDT-2026-0001');
    ora = new Date(2027, 0, 1, 0, 5);
    const r = nuova();
    assert.equal(r.numero, 'RIC-2027-0001');
    assert.equal(r.anno, 2027);
    assert.equal(r.progressivo, 1);
    assert.equal(ddt().numero, 'DDT-2027-0001');
    assert.equal(database.meta('prog_ric_2027'), '1');
    assert.equal(database.meta('prog_ric_2026'), '2');
    // una scrittura fallita non consuma il numero
    assert.throws(() => L.creaDdt(ctx, { origineId: 'r-farmacia', destinazioneId: 'r-degenza', righe: [{ articoloId: art.id, quantita: 1000 }] }), /abbastanza/);
    assert.equal(ddt().numero, 'DDT-2027-0002');
    // contatore perso (copia vecchia ripristinata): il numero non si ripete
    database.impostaMeta('prog_ddt_2027', 0);
    assert.equal(ddt().numero, 'DDT-2027-0003');
    assert.equal(notifiche, 7, 'una notifica per ogni scrittura riuscita');
  } finally {
    database.chiudi();
    fs.rmSync(cartella, { recursive: true, force: true });
  }
});
