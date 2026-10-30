// Prove del server multiutente: avvia il server su una porta libera con una cartella dati temporanea.
// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ESEGUIBILE = process.env.GF_ESEGUIBILE; // per provare l'exe compilato (Linux) invece dei sorgenti

function portaLibera() {
  return new Promise((ok) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}

async function avviaServer() {
  const porta = await portaLibera();
  const dati = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-prova-'));
  const comando = ESEGUIBILE || process.execPath;
  const argomenti = (ESEGUIBILE ? [] : [path.join(__dirname, '..', 'server', 'main.js')]).concat(['--porta', String(porta), '--dati', dati]);
  const proc = spawn(comando, argomenti, { stdio: ['ignore', 'pipe', 'pipe'] });
  let uscita = '';
  proc.stdout.on('data', (d) => { uscita += d; });
  proc.stderr.on('data', (d) => { uscita += d; });
  const base = 'http://127.0.0.1:' + porta;
  // l'eseguibile compilato (soprattutto l'exe Windows sotto Wine) può metterci di più a partire
  for (let i = 0; i < (ESEGUIBILE ? 600 : 100); i++) {
    try { const r = await fetch(base + '/api/stato'); if (r.ok) break; } catch (e) { /* non ancora pronto */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { porta, base, dati, proc, uscita: () => uscita, ferma: () => new Promise((ok) => { proc.once('exit', ok); proc.kill('SIGTERM'); }) };
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async chiama(metodo, percorso, corpo, opz) {
    const h = { 'Content-Type': 'application/json' };
    if (metodo !== 'GET' && !(opz && opz.senzaCsrf)) h['X-Richiesta'] = '1';
    if (this.cookie) h.Cookie = this.cookie;
    if (opz && opz.origin) h.Origin = opz.origin;
    const r = await fetch(this.base + percorso, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let json = null;
    const tipo = r.headers.get('content-type') || '';
    if (tipo.includes('json')) json = await r.json(); else await r.arrayBuffer();
    return { stato: r.status, json, headers: r.headers };
  }
  get(p) { return this.chiama('GET', p); }
  post(p, c, o) { return this.chiama('POST', p, c || {}, o); }
  put(p, c) { return this.chiama('PUT', p, c || {}); }
  del(p) { return this.chiama('DELETE', p); }
  async accedi(username, password) {
    const r = await this.post('/api/login', { username, password });
    assert.equal(r.stato, 200, JSON.stringify(r.json));
    return r.json;
  }
}

function oggi(piu) {
  const d = new Date();
  d.setDate(d.getDate() + (piu || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

let S;
let admin;
const PW = 'Password-123';

test.before(async () => {
  S = await avviaServer();
  admin = new Client(S.base);
});

test.after(async () => {
  if (S) await S.ferma();
});

test('primo avvio: stato, setup solo una volta', async () => {
  const st = await admin.get('/api/stato');
  assert.equal(st.json.inizializzato, false);
  assert.equal(st.json.daServer, true);
  // DNS rebinding: un sito esterno che punta a 127.0.0.1 arriva con un altro nome nell'intestazione Host
  const rebinding = await new Promise((ok, ko) => {
    const corpo = JSON.stringify({ username: 'intruso', nome: 'Intruso', password: PW });
    const req = require('node:http').request({ host: '127.0.0.1', port: S.porta, path: '/api/setup', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Richiesta': '1', Host: 'attaccante.example:' + S.porta, 'Content-Length': Buffer.byteLength(corpo) } },
    (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
    req.on('error', ko);
    req.end(corpo);
  });
  assert.equal(rebinding, 403);
  const corta = await admin.post('/api/setup', { username: 'admin', nome: 'Amministratore Prova', password: 'corta' });
  assert.equal(corta.stato, 400);
  const ok = await admin.post('/api/setup', { username: 'admin', nome: 'Amministratore Prova', password: PW });
  assert.equal(ok.stato, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.utente.ruolo, 'amministratore');
  assert.equal(ok.json.permessi.utenti, true);
  const ancora = await new Client(S.base).post('/api/setup', { username: 'altro', nome: 'Altro', password: PW });
  assert.equal(ancora.stato, 409);
});

test('setup rifiutato se la richiesta non arriva dal server stesso', async () => {
  const ip = Object.values(os.networkInterfaces()).flat().find((r) => r && r.family === 'IPv4' && !r.internal);
  if (!ip) return; // nessuna rete: prova non eseguibile qui
  const st = await (await fetch('http://' + ip.address + ':' + S.porta + '/api/stato')).json();
  assert.equal(st.daServer, false);
});

test('protezione CSRF e intestazioni di sicurezza', async () => {
  const senza = await admin.post('/api/articoli', { nome: 'X', categoria: 'FARMACI' }, { senzaCsrf: true });
  assert.equal(senza.stato, 403);
  const altroSito = await admin.post('/api/articoli', { nome: 'X', categoria: 'FARMACI' }, { origin: 'http://cattivo.example' });
  assert.equal(altroSito.stato, 403);
  const pagina = await fetch(S.base + '/');
  assert.match(pagina.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(pagina.headers.get('x-content-type-options'), 'nosniff');
  for (const p of ['/server/db.js', '/js/../server/db.js', '/%2e%2e/server/db.js', '/dati/farmacia.db', '/package.json']) {
    const r = await fetch(S.base + p);
    assert.equal(r.status, 404, p);
  }
});

test('senza accesso le API rispondono 401', async () => {
  const anon = new Client(S.base);
  assert.equal((await anon.get('/api/dati?da=0')).stato, 401);
  assert.equal((await anon.post('/api/movimenti', { movimenti: [] })).stato, 401);
  assert.equal((await anon.get('/api/eventi')).stato, 401);
});

const U = {};
let ART;

test('utenti: creazione, ruoli, password provvisoria da cambiare', async () => {
  const mk = async (username, nome, ruolo, reparti) => {
    const r = await admin.post('/api/utenti', { username, nome, ruolo, reparti, password: 'Provvisoria1' });
    assert.equal(r.stato, 200, JSON.stringify(r.json));
    assert.equal(r.json.utente.cambioPassword, true);
    const c = new Client(S.base);
    await c.accedi(username, 'Provvisoria1');
    const bloccato = await c.get('/api/dati?da=0');
    assert.equal(bloccato.stato, 403); // prima deve cambiare la password
    const cambio = await c.post('/api/password', { attuale: 'Provvisoria1', nuova: PW });
    assert.equal(cambio.stato, 200, JSON.stringify(cambio.json));
    assert.equal((await c.get('/api/dati?da=0')).stato, 200);
    U[username] = { client: c, id: r.json.utente.id };
  };
  await mk('farma', 'Farmacista Prova', 'farmacista', []);
  await mk('infdeg', 'Infermiere Degenza', 'reparto', ['r-degenza']);
  await mk('infsala', 'Infermiere Sala', 'reparto', ['r-sala']);
  await mk('dir', 'Direzione Sanitaria', 'consultazione', []);
  const doppio = await admin.post('/api/utenti', { username: 'FARMA', nome: 'Doppio', ruolo: 'farmacista', password: PW });
  assert.equal(doppio.stato, 409);
  const senzaReparto = await admin.post('/api/utenti', { username: 'rep2', nome: 'Rep', ruolo: 'reparto', reparti: [], password: PW });
  assert.equal(senzaReparto.stato, 400);
  const elenco = await U.farma.client.get('/api/utenti');
  assert.equal(elenco.stato, 403);
});

test('anagrafica: crea, nome doppio, versione in conflitto', async () => {
  const f = U.farma.client;
  const r = await f.post('/api/articoli', { nome: 'PARACETAMOLO 1 g fl', categoria: 'FARMACI', prezzo: 1.2, scortaMinima: 10, unita: 'fl' });
  assert.equal(r.stato, 200, JSON.stringify(r.json));
  ART = r.json.articolo;
  assert.equal(ART.versione, 1);
  assert.equal((await f.post('/api/articoli', { nome: 'paracetamolo 1 G FL', categoria: 'FARMACI' })).stato, 409);
  assert.equal((await U.infdeg.client.post('/api/articoli', { nome: 'Altro', categoria: 'FARMACI' })).stato, 403);
  const m1 = await admin.put('/api/articoli/' + ART.id, Object.assign({}, ART, { scortaMinima: 12 }));
  assert.equal(m1.stato, 200);
  const m2 = await f.put('/api/articoli/' + ART.id, Object.assign({}, ART, { scortaMinima: 20 })); // versione vecchia
  assert.equal(m2.stato, 409);
  ART = m1.json.articolo;
  assert.equal(ART.versione, 2);
});

async function giacenza(client, articoloId, repartoId) {
  const C = require('../js/calcoli.js');
  const d = (await client.get('/api/dati?da=0')).json;
  return C.giacenza({ movimenti: d.movimenti, articoli: d.articoli }, articoloId, repartoId);
}

test('movimenti: permessi per ruolo e per reparto', async () => {
  const f = U.farma.client;
  const car = await f.post('/api/movimenti', { movimenti: [
    { tipo: 'carico', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', quantita: 10, lotto: 'A', scadenza: '2027-01', fornitore: 'Prova', prezzo: 1.5 },
    { tipo: 'carico', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', quantita: 20, lotto: 'B', scadenza: '2028-01' }
  ] });
  assert.equal(car.stato, 200, JSON.stringify(car.json));
  assert.equal(car.json.movimenti[0].operatore, 'Farmacista Prova');
  const tr = await f.post('/api/movimenti', { movimenti: [{ tipo: 'trasferimento', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', repartoDestId: 'r-degenza', quantita: 15 }] });
  assert.equal(tr.stato, 200, JSON.stringify(tr.json));
  // ripartito sui lotti: prima A (scade prima), poi B
  assert.deepEqual(tr.json.movimenti.map((m) => [m.lotto, m.quantita]), [['A', 10], ['B', 5]]);
  assert.equal(await giacenza(f, ART.id, 'r-degenza'), 15);

  const deg = U.infdeg.client;
  assert.equal((await deg.post('/api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(), articoloId: ART.id, repartoId: 'r-degenza', quantita: 1 }] })).stato, 403);
  assert.equal((await deg.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi(), articoloId: ART.id, repartoId: 'r-sala', quantita: 1 }] })).stato, 403);
  assert.equal((await U.dir.client.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi(), articoloId: ART.id, repartoId: 'r-degenza', quantita: 1 }] })).stato, 403);
  const cons = await deg.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi(), articoloId: ART.id, repartoId: 'r-degenza', quantita: 2 }] });
  assert.equal(cons.stato, 200, JSON.stringify(cons.json));
  assert.equal(cons.json.movimenti[0].lotto, 'A');
  assert.equal(cons.json.movimenti[0].utenteId, U.infdeg.id);

  // validazione
  const futuro = await f.post('/api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(5), articoloId: ART.id, repartoId: 'r-farmacia', quantita: 1 }] });
  assert.equal(futuro.stato, 400);
  const zero = await f.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', quantita: 0 }] });
  assert.equal(zero.stato, 400);
  const tutto = await f.post('/api/movimenti', { movimenti: [
    { tipo: 'carico', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', quantita: 1 },
    { tipo: 'carico', data: oggi(), articoloId: 'inesistente', repartoId: 'r-farmacia', quantita: 1 }
  ] });
  assert.equal(tutto.stato, 400); // nessuno dei due registrato: stessa transazione
  assert.equal(await giacenza(f, ART.id, 'r-farmacia'), 15);
});

test('annullo: il reparto annulla solo i propri consumi', async () => {
  const deg = U.infdeg.client;
  const d = (await deg.get('/api/dati?da=0')).json;
  const mio = d.movimenti.find((m) => m.tipo === 'consumo' && m.utenteId === U.infdeg.id);
  const carico = d.movimenti.find((m) => m.tipo === 'carico');
  assert.equal((await deg.post('/api/movimenti/' + carico.id + '/annulla', { motivo: 'prova' })).stato, 403);
  assert.equal((await U.infsala.client.post('/api/movimenti/' + mio.id + '/annulla', { motivo: 'prova' })).stato, 403);
  const ok = await deg.post('/api/movimenti/' + mio.id + '/annulla', { motivo: 'Sbagliato' });
  assert.equal(ok.stato, 200);
  assert.equal((await deg.post('/api/movimenti/' + mio.id + '/annulla', { motivo: 'ancora' })).stato, 409);
  assert.equal(await giacenza(deg, ART.id, 'r-degenza'), 15);
});

test('scritture contemporanee di più utenti non si perdono', async () => {
  const clienti = [U.farma.client, U.infdeg.client, admin];
  const richieste = [];
  for (let i = 0; i < 30; i++) {
    const c = clienti[i % 3];
    richieste.push(c.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi(), articoloId: ART.id, repartoId: 'r-degenza', quantita: 0.5 }] }));
  }
  const esiti = await Promise.all(richieste);
  esiti.forEach((e) => assert.equal(e.stato, 200, JSON.stringify(e.json)));
  assert.equal(await giacenza(admin, ART.id, 'r-degenza'), 0);
  const revs = new Set(esiti.map((e) => e.json.rev));
  assert.equal(revs.size, 30);
});

test('registro mensile: correzione del consumo di un giorno', async () => {
  const f = U.farma.client;
  await f.post('/api/movimenti', { movimenti: [{ tipo: 'trasferimento', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', repartoDestId: 'r-sala', quantita: 5 }] });
  const sala = U.infsala.client;
  const r = await sala.post('/api/consumo-giorno', { articoloId: ART.id, repartoId: 'r-sala', data: oggi(), quantita: 3 });
  assert.equal(r.stato, 200, JSON.stringify(r.json));
  assert.equal(await giacenza(sala, ART.id, 'r-sala'), 2);
  await sala.post('/api/consumo-giorno', { articoloId: ART.id, repartoId: 'r-sala', data: oggi(), quantita: 1 });
  assert.equal(await giacenza(sala, ART.id, 'r-sala'), 4);
  assert.equal((await sala.post('/api/consumo-giorno', { articoloId: ART.id, repartoId: 'r-degenza', data: oggi(), quantita: 1 })).stato, 403);
});

test('conflitti: registro, inventario e lotto scelti su dati vecchi', async () => {
  const f = U.farma.client;
  const deg = U.infdeg.client;
  await f.post('/api/movimenti', { movimenti: [{ tipo: 'trasferimento', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', repartoDestId: 'r-degenza', quantita: 1 }] });
  // registro: il farmacista vede 0 per oggi in Degenza, intanto l'infermiere registra 0,5
  await deg.post('/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi(), articoloId: ART.id, repartoId: 'r-degenza', quantita: 0.5 }] });
  const d0 = (await f.get('/api/dati?da=0')).json;
  const visti = d0.movimenti.filter((m) => !m.annullato && m.tipo === 'consumo' && m.repartoId === 'r-degenza' && m.data === oggi()).reduce((t, m) => t + m.quantita, 0);
  const vecchio = await f.post('/api/consumo-giorno', { articoloId: ART.id, repartoId: 'r-degenza', data: oggi(), quantita: 0.3, prima: visti - 0.5 });
  assert.equal(vecchio.stato, 409);
  const ok = await f.post('/api/consumo-giorno', { articoloId: ART.id, repartoId: 'r-degenza', data: oggi(), quantita: visti, prima: visti });
  assert.equal(ok.stato, 200, JSON.stringify(ok.json));
  // inventario: la giacenza vista è cambiata nel frattempo
  const g = await giacenza(f, ART.id, 'r-farmacia');
  const rett = await f.post('/api/movimenti', { movimenti: [{ tipo: 'rettifica', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', quantita: -1, teorica: g + 3 }] });
  assert.equal(rett.stato, 409);
  const rett2 = await f.post('/api/movimenti', { movimenti: [{ tipo: 'rettifica', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', quantita: 1, teorica: g }] });
  assert.equal(rett2.stato, 200, JSON.stringify(rett2.json));
  // lotto scelto ma ormai esaurito
  const lottoA = await f.post('/api/movimenti', { movimenti: [{ tipo: 'trasferimento', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', repartoDestId: 'r-sala', quantita: 1, lotto: 'A' }] });
  assert.equal(lottoA.stato, 409);
});

test('importazione articoli ripetuta: la giacenza iniziale non si raddoppia', async () => {
  const f = U.farma.client;
  const corpo = { articoli: [{ nome: 'IMPORTATO DUE VOLTE', categoria: 'PRESIDI', giacenza: 40 }], repartoId: 'r-farmacia', data: oggi(), conGiacenza: true, origine: 'prova.xlsx' };
  const p1 = await f.post('/api/articoli/importa', corpo);
  assert.equal(p1.json.carichi, 1);
  const p2 = await f.post('/api/articoli/importa', corpo);
  assert.equal(p2.json.carichi, 0);
  assert.equal(p2.json.saltati, 1);
  const d = (await f.get('/api/dati?da=0')).json;
  const a = d.articoli.find((x) => x.nome === 'IMPORTATO DUE VOLTE');
  assert.equal(await giacenza(f, a.id, 'r-farmacia'), 40);
});

test('troppe righe in una richiesta e permesso controllato prima del corpo', async () => {
  const righe = Array.from({ length: 501 }, () => ({ tipo: 'consumo', data: oggi(), articoloId: ART.id, repartoId: 'r-degenza', quantita: 1 }));
  assert.equal((await U.infdeg.client.post('/api/movimenti', { movimenti: righe })).stato, 400);
  const t = Date.now();
  const r = await U.infdeg.client.post('/api/importa-archivio', { articoli: [], movimenti: [], reparti: [], zavorra: 'x'.repeat(5 * 1024 * 1024) });
  assert.equal(r.stato, 403);
  assert.ok(Date.now() - t < 5000);
});

test('sincronizzazione per revisione e cancellazioni', async () => {
  const f = U.farma.client;
  const prima = (await f.get('/api/dati?da=0')).json;
  assert.equal(prima.completo, true);
  const nuovo = await f.post('/api/articoli', { nome: 'DA CANCELLARE', categoria: 'PRESIDI' });
  const delta = (await f.get('/api/dati?da=' + prima.rev)).json;
  assert.equal(delta.completo, false);
  assert.equal(delta.articoli.length, 1);
  assert.equal(delta.movimenti.length, 0);
  assert.equal(delta.impostazioni, undefined);
  await f.del('/api/articoli/' + nuovo.json.articolo.id);
  const delta2 = (await f.get('/api/dati?da=' + delta.rev)).json;
  assert.deepEqual(delta2.cancellati, [{ tabella: 'articoli', id: nuovo.json.articolo.id }]);
  assert.equal((await f.del('/api/articoli/' + ART.id)).stato, 409); // ha movimenti
  const futuro = (await f.get('/api/dati?da=999999')).json;
  assert.equal(futuro.completo, true);
  assert.ok(delta2.storia);
  assert.equal((await f.get('/api/dati?da=' + delta2.rev + '&storia=' + delta2.storia)).json.completo, false);
  assert.equal((await f.get('/api/dati?da=' + delta2.rev + '&storia=altra')).json.completo, true);
});

test('notifiche in tempo reale (Server-Sent Events)', async () => {
  const ctrl = new AbortController();
  const r = await fetch(S.base + '/api/eventi', { headers: { Cookie: U.dir.client.cookie }, signal: ctrl.signal });
  assert.equal(r.status, 200);
  const lettore = r.body.getReader();
  let testo = '';
  const leggi = async (finoA) => {
    while (!finoA.test(testo)) {
      const { value, done } = await lettore.read();
      if (done) break;
      testo += Buffer.from(value).toString();
    }
  };
  await leggi(/event: rev/);
  const rev0 = Number(/"rev":(\d+)/.exec(testo)[1]);
  testo = '';
  const scr = await U.farma.client.post('/api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(), articoloId: ART.id, repartoId: 'r-farmacia', quantita: 1 }] });
  await leggi(/"rev":\d+/);
  assert.equal(Number(/"rev":(\d+)/.exec(testo)[1]), scr.json.rev);
  assert.ok(scr.json.rev > rev0);
  ctrl.abort();
});

test('impostazioni e reparti solo per l\'amministratore', async () => {
  assert.equal((await U.farma.client.put('/api/impostazioni', { struttura: 'X' })).stato, 403);
  const r = await admin.put('/api/impostazioni', { struttura: 'Clinica Posillipo', sottotitolo: 'Longevity Institute', societa: 'ME.MI. SRL', citta: 'NAPOLI', codiceModulo: 'PRQ', giorniAvvisoScadenza: 60 });
  assert.equal(r.stato, 200, JSON.stringify(r.json));
  assert.equal(r.json.impostazioni.giorniAvvisoScadenza, 60);
  const logoBrutto = await admin.put('/api/impostazioni', { struttura: 'Clinica Posillipo', logo: 'javascript:alert(1)' });
  assert.equal(logoBrutto.stato, 400);
  const rep = (await admin.get('/api/dati?da=0')).json.reparti;
  const nuovi = rep.map((x) => ({ id: x.id, nome: x.nome, centrale: x.centrale, attivo: x.attivo })).concat([{ nome: 'Day hospital', attivo: true }]);
  const sr = await admin.put('/api/reparti', { reparti: nuovi });
  assert.equal(sr.stato, 200, JSON.stringify(sr.json));
  const dh = sr.json.reparti.find((x) => x.nome === 'Day hospital');
  assert.ok(dh);
  assert.equal((await admin.del('/api/reparti/r-degenza')).stato, 409); // ha movimenti
  assert.equal((await admin.del('/api/reparti/' + dh.id)).stato, 200);
});

function ipRete() {
  const r = Object.values(os.networkInterfaces()).flat().find((x) => x && x.family === 'IPv4' && !x.internal);
  return r ? r.address : null;
}

test('tentativi sbagliati: blocco per utente e computer, mai dal server stesso', async () => {
  const ip = ipRete();
  if (!ip) return; // senza una rete non si può simulare un altro computer
  const c = new Client('http://' + ip + ':' + S.porta);
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/login', { username: 'infsala', password: 'sbagliata' })).stato, 401);
  assert.equal((await c.post('/api/login', { username: 'infsala', password: 'sbagliata' })).stato, 429);
  assert.equal((await c.post('/api/login', { username: 'infsala', password: PW })).stato, 429);
  // un nome inesistente si comporta allo stesso modo: non si scopre quali utenti esistono
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/login', { username: 'nessuno', password: 'x' })).stato, 401);
  assert.equal((await c.post('/api/login', { username: 'nessuno', password: 'x' })).stato, 429);
  // dal server stesso l'utente vero entra comunque (accesso d'emergenza)
  const locale = new Client(S.base);
  assert.equal((await locale.post('/api/login', { username: 'infsala', password: PW })).stato, 200);
  // l'amministratore che dà una nuova password sblocca anche gli altri computer
  assert.equal((await admin.post('/api/utenti/' + U.infsala.id + '/password', { nuova: 'Sblocco-123' })).stato, 200);
  const dopo = await c.post('/api/login', { username: 'infsala', password: 'Sblocco-123' });
  assert.equal(dopo.stato, 200);
  assert.equal(dopo.json.utente.cambioPassword, true);
  assert.equal((await U.infsala.client.get('/api/dati?da=0')).stato, 401); // le vecchie sessioni non valgono più
  const nuovo = new Client(S.base);
  await nuovo.accedi('infsala', 'Sblocco-123');
  assert.equal((await nuovo.post('/api/password', { attuale: 'Sblocco-123', nuova: PW })).stato, 200);
  U.infsala.client = nuovo;
});

test('accessi falliti: niente corpi grandi né nomi lunghi nel registro', async () => {
  const anon = new Client(S.base);
  const grande = await anon.post('/api/login', { username: 'x'.repeat(100000), password: 'x' });
  assert.equal(grande.stato, 413);
  const lungo = await anon.post('/api/login', { username: 'x'.repeat(5000), password: 'x' });
  assert.equal(lungo.stato, 401);
  const segreto = await anon.post('/api/login', { username: 'Rossi.Maria#2026', password: 'x' });
  assert.equal(segreto.stato, 401);
  const ev = (await admin.get('/api/attivita?limite=50&azione=accesso.fallito')).json.eventi;
  assert.ok(ev.every((e) => JSON.stringify(e).length < 5000));
  assert.ok(!JSON.stringify(ev).toLowerCase().includes('rossi.maria'), 'i nomi utente inesistenti non si registrano');
  assert.equal((await admin.get('/api/attivita?limite=2.5')).stato, 200);
});

test('sessione: cookie estranei, utente cambiato in un\'altra scheda, password attuale indovinata', async () => {
  const r = await fetch(S.base + '/api/stato', { headers: { Cookie: 'altra_app=sconto 100%; ' + admin.cookie } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).utente.username, 'admin');
  const conAltro = await fetch(S.base + '/api/dati?da=0', { headers: { Cookie: admin.cookie, 'X-Utente': U.farma.id } });
  assert.equal(conAltro.status, 401);
  const giusto = await fetch(S.base + '/api/dati?da=0', { headers: { Cookie: admin.cookie, 'X-Utente': (await admin.get('/api/stato')).json.utente.id } });
  assert.equal(giusto.status, 200);
  const c = new Client(S.base);
  await c.accedi('dir', PW);
  for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/password', { attuale: 'no-' + i, nuova: 'Altra-123456' })).stato, 400);
  assert.equal((await c.post('/api/password', { attuale: 'no-5', nuova: 'Altra-123456' })).stato, 401);
  assert.equal((await c.get('/api/dati?da=0')).stato, 401);
});

test('disattivare un utente chiude le sue sessioni; resta almeno un amministratore', async () => {
  const r = await admin.put('/api/utenti/' + U.dir.id, { nome: 'Direzione Sanitaria', ruolo: 'consultazione', reparti: [], attivo: false });
  assert.equal(r.stato, 200);
  assert.equal((await U.dir.client.get('/api/dati?da=0')).stato, 401);
  const me = (await admin.get('/api/stato')).json.utente;
  const togli = await admin.put('/api/utenti/' + me.id, { nome: me.nome, ruolo: 'farmacista', reparti: [] });
  assert.equal(togli.stato, 400);
});

test('registro attività', async () => {
  const r = await U.farma.client.get('/api/attivita?limite=1000');
  assert.equal(r.stato, 200);
  const azioni = new Set(r.json.eventi.map((e) => e.azione));
  ['accesso.entrata', 'accesso.fallito', 'movimenti.registra', 'movimenti.annulla', 'articoli.crea', 'utenti.crea', 'registro.consumo-giorno'].forEach((a) => assert.ok(azioni.has(a), a));
  assert.equal((await U.infdeg.client.get('/api/attivita')).stato, 403);
});

test('copie di sicurezza: crea, scarica, ripristina', async () => {
  const el = await admin.get('/api/backup');
  assert.equal(el.stato, 200);
  assert.ok(el.json.backup.some((b) => b.tipo === 'auto'));
  const c = await admin.post('/api/backup');
  assert.equal(c.stato, 200);
  const nome = c.json.nome;
  const prima = (await admin.get('/api/dati?da=0')).json;
  // dopo la copia aggiungo un articolo, poi ripristino
  await admin.post('/api/articoli', { nome: 'DOPO LA COPIA', categoria: 'FARMACI' });
  const dl = await fetch(S.base + '/api/backup/' + nome, { headers: { Cookie: admin.cookie } });
  assert.equal(dl.status, 200);
  assert.ok((await dl.arrayBuffer()).byteLength > 1000);
  assert.equal((await fetch(S.base + '/api/backup/..%2Ffarmacia.db', { headers: { Cookie: admin.cookie } })).status, 404);
  assert.equal((await U.farma.client.post('/api/backup/' + nome + '/ripristina')).stato, 403);
  const rip = await admin.post('/api/backup/' + nome + '/ripristina');
  assert.equal(rip.stato, 200, JSON.stringify(rip.json));
  const dopo = (await admin.get('/api/dati?da=' + prima.rev)).json;
  assert.equal(dopo.completo, true);
  assert.ok(!dopo.articoli.some((a) => a.nome === 'DOPO LA COPIA'));
  assert.equal(dopo.movimenti.length, prima.movimenti.length);
  // utenti e sessioni restano
  assert.equal((await U.farma.client.get('/api/dati?da=0')).stato, 200);
});

test('dati di prova e importazione dell\'archivio solo con archivio vuoto', async () => {
  assert.equal((await admin.post('/api/demo')).stato, 409);
  assert.equal((await admin.post('/api/importa-archivio', { articoli: [], movimenti: [], reparti: [] })).stato, 409);
});

test('importazione dell\'archivio della versione per un solo PC', async () => {
  const S2 = await avviaServer();
  try {
    const a = new Client(S2.base);
    await a.post('/api/setup', { username: 'admin', nome: 'Admin', password: PW });
    const C = require('../js/calcoli.js');
    const D = require('../js/demo.js');
    const demo = D.crea(C, { centrale: 'r-farmacia', reparti: ['r-degenza', 'r-sala', 'r-ambulatori'], oggi: new Date() });
    const archivio = {
      versione: 1,
      impostazioni: { struttura: 'Clinica Posillipo', sottotitolo: 'Longevity Institute', societa: 'ME.MI. SRL', citta: 'NAPOLI', operatore: 'Vecchio', giorniAvvisoScadenza: 45, codiceModulo: 'PRQ 1501.4EV.1', logo: '' },
      reparti: [{ id: 'r-farmacia', nome: 'Farmacia', centrale: true, attivo: true }, { id: 'r-degenza', nome: 'Degenza', attivo: true }, { id: 'r-sala', nome: 'Sala operatoria', attivo: true }, { id: 'r-ambulatori', nome: 'Ambulatori', attivo: true }],
      articoli: demo.articoli,
      movimenti: demo.movimenti.concat([{ id: 'x', tipo: 'boh', data: '2026-01-01', articoloId: 'nessuno', repartoId: 'r-farmacia', quantita: 1 }])
    };
    archivio.movimenti[5].annullato = { il: new Date().toISOString(), da: 'Vecchio', motivo: 'errore' };
    const r = await a.post('/api/importa-archivio', archivio);
    assert.equal(r.stato, 200, JSON.stringify(r.json));
    assert.equal(r.json.articoli, demo.articoli.length);
    assert.equal(r.json.movimenti, demo.movimenti.length);
    assert.equal(r.json.scartati, 1);
    const d = (await a.get('/api/dati?da=0')).json;
    assert.equal(d.impostazioni.giorniAvvisoScadenza, 45);
    assert.equal(d.movimenti.filter((m) => m.annullato).length, 1);
    const st = { articoli: d.articoli, movimenti: d.movimenti };
    const st1 = { articoli: demo.articoli, movimenti: demo.movimenti.map((m, i) => i === 5 ? Object.assign({}, m, { annullato: {} }) : m) };
    demo.articoli.forEach((art) => {
      ['r-farmacia', 'r-degenza'].forEach((rep) => assert.equal(C.giacenza(st, art.id, rep), C.giacenza(st1, art.id, rep)));
    });
  } finally {
    await S2.ferma();
  }
});

test('dati di prova in un archivio nuovo', async () => {
  const S3 = await avviaServer();
  try {
    const a = new Client(S3.base);
    await a.post('/api/setup', { username: 'admin', nome: 'Admin', password: PW });
    const r = await a.post('/api/demo');
    assert.equal(r.stato, 200, JSON.stringify(r.json));
    assert.ok(r.json.movimenti > 1000);
    assert.equal((await a.post('/api/demo')).stato, 409);
  } finally {
    await S3.ferma();
  }
});

function eseguiProgramma(argomenti, ms) {
  const comando = ESEGUIBILE || process.execPath;
  const tutti = (ESEGUIBILE ? [] : [path.join(__dirname, '..', 'server', 'main.js')]).concat(argomenti);
  return new Promise((ok) => {
    const p = spawn(comando, tutti, { stdio: ['ignore', 'pipe', 'pipe'] });
    let testo = '';
    p.stdout.on('data', (d) => { testo += d; });
    p.stderr.on('data', (d) => { testo += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); ok({ codice: 'scaduto', testo }); }, ms || 20000);
    p.on('exit', (codice) => { clearTimeout(t); ok({ codice, testo }); });
  });
}

test('modalità servizio: con la porta occupata esce subito e scrive il motivo nel registro', async () => {
  const dati = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-servizio-'));
  const r = await eseguiProgramma(['--porta', String(S.porta), '--dati', dati, '--servizio'], 20000);
  assert.equal(r.codice, 1, r.testo);
  const log = fs.readFileSync(path.join(dati, 'log', 'errori-avvio.log'), 'utf8');
  assert.match(log, /porta .* già usata/);
});

test('configurazione.json salvato con BOM dal Blocco note', async () => {
  const S4dati = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-bom-'));
  const porta = await portaLibera();
  fs.writeFileSync(path.join(S4dati, 'configurazione.json'), '﻿{ "porta": ' + porta + ' }');
  const proc = spawn(ESEGUIBILE || process.execPath, (ESEGUIBILE ? [] : [path.join(__dirname, '..', 'server', 'main.js')]).concat(['--dati', S4dati]), { stdio: 'ignore' });
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) {
    try { ok = (await fetch('http://127.0.0.1:' + porta + '/api/stato')).ok; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  await new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); });
  assert.ok(ok, 'il server deve partire sulla porta scritta nel file con BOM');
});

test('accesso d\'emergenza da riga di comando, anche con il server in funzione', async () => {
  const r = await eseguiProgramma(['--dati', S.dati, '--reimposta-password', 'admin'], 20000);
  assert.equal(r.codice, 0, r.testo);
  const m = /provvisoria per "admin":\s+(\S+)/.exec(r.testo);
  assert.ok(m, r.testo);
  const c = new Client(S.base);
  const acc = await c.accedi('admin', m[1]);
  assert.equal(acc.utente.cambioPassword, true);
  assert.equal((await admin.get('/api/dati?da=0')).stato, 401); // le sessioni di prima sono chiuse
  const sconosciuto = await eseguiProgramma(['--dati', S.dati, '--reimposta-password', 'nessuno'], 20000);
  assert.equal(sconosciuto.codice, 1);
});
