// Prove della verifica in due passaggi (2FA, parte C della 3.0): accesso in due passi, sfida, codici sbagliati e blocco,
// codici riusati, codici di recupero, computer attendibili, criterio dell'amministratore, azzeramento, permessi.
// Il server vero gira su una porta libera con una cartella dati temporanea; le prove sul tempo (scadenze di 5 minuti,
// 15 minuti, 30 giorni) usano gli stessi moduli dentro il processo, con un orologio simulato.
// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const Totp = require('../js/totp.js');

const PW = 'Password-123';

function portaLibera() {
  return new Promise((ok) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
  });
}

async function avviaServer() {
  const porta = await portaLibera();
  const dati = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-sicurezza-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'main.js'), '--porta', String(porta), '--dati', dati], { stdio: ['ignore', 'pipe', 'pipe'] });
  let uscita = '';
  proc.stdout.on('data', (d) => { uscita += d; });
  proc.stderr.on('data', (d) => { uscita += d; });
  const base = 'http://127.0.0.1:' + porta;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/stato'); if (r.ok) break; } catch (e) { /* non ancora pronto */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { porta, base, dati, proc, uscita: () => uscita, ferma: () => new Promise((ok) => { proc.once('exit', ok); proc.kill('SIGTERM'); }) };
}

/* Client con i cookie come un browser (sessione e computer attendibile, ognuno col suo Path). */
class Client {
  constructor(base) { this.base = base; this.cookie = {}; this.ultimiCookie = []; }
  intestazioneCookie(percorso) {
    return Object.keys(this.cookie).filter((k) => percorso.indexOf(this.cookie[k].path) === 0)
      .map((k) => k + '=' + this.cookie[k].valore).join('; ');
  }
  async chiama(metodo, percorso, corpo) {
    const h = { 'Content-Type': 'application/json' };
    if (metodo !== 'GET') h['X-Richiesta'] = '1';
    const c = this.intestazioneCookie(percorso.split('?')[0]);
    if (c) h.Cookie = c;
    const r = await fetch(this.base + percorso, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    this.ultimiCookie = r.headers.getSetCookie();
    for (const sc of this.ultimiCookie) {
      const parti = sc.split(';').map((x) => x.trim());
      const [nome, ...resto] = parti[0].split('=');
      const valore = resto.join('=');
      const p = (parti.find((x) => /^path=/i.test(x)) || 'Path=/').slice(5);
      const eta = parti.find((x) => /^max-age=/i.test(x));
      if (!valore || (eta && Number(eta.slice(8)) <= 0)) delete this.cookie[nome];
      else this.cookie[nome] = { valore, path: p, completo: sc };
    }
    let json = null;
    if ((r.headers.get('content-type') || '').includes('json')) json = await r.json(); else await r.arrayBuffer();
    return { stato: r.status, json };
  }
  get(p) { return this.chiama('GET', p); }
  post(p, c) { return this.chiama('POST', p, c || {}); }
  put(p, c) { return this.chiama('PUT', p, c || {}); }
  del(p) { return this.chiama('DELETE', p); }
  dimenticaSessione() { delete this.cookie.gf_sessione; }
}

function ok200(r) { assert.equal(r.stato, 200, JSON.stringify(r.json)); return r.json; }

/*
 * Codice dell'app per il segreto, mai lo stesso passo due volte (il server non accetta un codice già usato):
 * il passo attuale o quello dopo (dentro la finestra di ±30 secondi); se sono già usati aspetta il passo nuovo.
 */
const ultimoPasso = new Map();
async function codiceNuovo(segreto) {
  for (;;) {
    const p = Totp.passo(Date.now());
    const u = ultimoPasso.has(segreto) ? ultimoPasso.get(segreto) : -1;
    const scelto = u < p ? p : (u < p + 1 ? p + 1 : null);
    if (scelto !== null) { ultimoPasso.set(segreto, scelto); return Totp.hotp(segreto, scelto); }
    await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 50));
  }
}

/* Un codice di 6 cifre sicuramente sbagliato in questo momento. */
function codiceSbagliato(segreto) {
  const giusti = [-1, 0, 1].map((d) => Totp.totp(segreto, Date.now() + d * 30000));
  for (let i = 0; ; i++) {
    const c = String((Number(giusti[1]) + 111111 * (i + 1)) % 1000000).padStart(6, '0');
    if (!giusti.includes(c)) return c;
  }
}

function ipRete() {
  const r = Object.values(os.networkInterfaces()).flat().find((x) => x && x.family === 'IPv4' && !x.internal);
  return r ? r.address : null;
}

let S;
const U = {};        // username -> { id, client, segreto?, recupero? }

test.before(async () => { S = await avviaServer(); });
test.after(async () => { if (S) await S.ferma(); });

/*
 * Accesso completo con la 2FA (password + codice dell'app, oppure un codice di recupero con opz.recupero), per un client
 * nuovo. I codici dell'app sono pochi per passo di 30 secondi: dove non serve proprio il codice si usa quello di recupero.
 */
async function accedi2fa(username, opz) {
  opz = opz || {};
  const c = opz.client || new Client(S.base);
  const l = ok200(await c.post('/api/login', { username, password: PW }));
  assert.equal(l.dueFattori, true, 'serve il codice');
  const secondo = opz.recupero ? { codiceRecupero: U[username].recupero.pop() } : { codice: await codiceNuovo(U[username].segreto) };
  ok200(await c.post('/api/login/2fa', Object.assign({ sfida: l.sfida, ricorda: !!opz.ricorda }, secondo)));
  return c;
}

/* Attiva la 2FA dell'utente collegato con il client: restituisce { segreto, codici }. */
async function attiva(c) {
  const ini = ok200(await c.post('/api/2fa/inizia'));
  const conf = ok200(await c.post('/api/2fa/conferma', { codice: await codiceNuovo(ini.segretoBase32) }));
  return { segreto: ini.segretoBase32, codici: conf.codiciRecupero, ini };
}

test('primo amministratore, utenti di prova e stato della verifica in due passaggi', async () => {
  const admin = new Client(S.base);
  ok200(await admin.post('/api/setup', { username: 'admin', nome: 'Amministratore Prova', password: PW }));
  const st = ok200(await admin.get('/api/stato'));
  assert.equal(st.utente.dueFattori, false);
  assert.equal(st.utente.dueFattoriObbligatoria, false);
  assert.equal(st.utente.dueFattoriDaAttivare, false);
  U.admin = { id: st.utente.id, client: admin };
  const crea = async (username, nome, ruolo, reparti) => {
    const r = ok200(await admin.post('/api/utenti', { username, nome, ruolo, reparti, password: 'Provvisoria1' }));
    const c = new Client(S.base);
    ok200(await c.post('/api/login', { username, password: 'Provvisoria1' }));
    ok200(await c.post('/api/password', { attuale: 'Provvisoria1', nuova: PW }));
    U[username] = { id: r.utente.id, client: c };
  };
  await crea('farma', 'Maria Farmacista', 'farmacista', []);
  await crea('rep', 'Luca Infermiere', 'reparto', ['r-degenza']);
  await crea('dir', 'Direzione', 'consultazione', []);
  await crea('admin2', 'Secondo Amministratore', 'amministratore', []);
  const s = ok200(await admin.get('/api/2fa'));
  assert.equal(s.attiva, false);
  assert.equal(s.obbligatoria, false);
  assert.equal(s.criterio, 'nessuno');
  assert.equal(s.codiciRimasti, 0);
  assert.ok(Math.abs(Date.parse(s.oraServer) - Date.now()) < 5000, 'ora del server');
});

test('attivazione: chiave per l’app, codice sbagliato, conferma, codici di recupero, segreto cifrato', async () => {
  const admin = U.admin.client;
  // un'altra sessione dello stesso utente (altro computer): dopo l'attivazione si chiude
  const altra = new Client(S.base);
  ok200(await altra.post('/api/login', { username: 'admin', password: PW }));
  // senza aver iniziato non si conferma
  assert.equal((await admin.post('/api/2fa/conferma', { codice: '123456' })).stato, 409);
  const ini = ok200(await admin.post('/api/2fa/inizia'));
  assert.match(ini.segretoBase32, /^[A-Z2-7]{32}$/, '20 byte in base32');
  assert.equal(ini.chiave.replace(/ /g, ''), ini.segretoBase32);
  assert.equal(ini.emittente, 'NefroCenter Pharmacy');
  assert.equal(ini.uri, 'otpauth://totp/NefroCenter%20Pharmacy:admin?secret=' + ini.segretoBase32 + '&issuer=NefroCenter%20Pharmacy&algorithm=SHA1&digits=6&period=30');
  assert.equal(ini.cambio, false);
  // prima della conferma non è attiva
  assert.equal(ok200(await admin.get('/api/2fa')).attiva, false);
  const sbagliato = await admin.post('/api/2fa/conferma', { codice: codiceSbagliato(ini.segretoBase32) });
  assert.equal(sbagliato.stato, 400);
  assert.match(sbagliato.json.errore, /non è giusto/);
  assert.equal((await admin.post('/api/2fa/conferma', { codice: 'abc' })).stato, 400);
  const conf = ok200(await admin.post('/api/2fa/conferma', { codice: await codiceNuovo(ini.segretoBase32) }));
  assert.equal(conf.codiciRecupero.length, 10);
  for (const c of conf.codiciRecupero) assert.match(c, /^[2-9a-hj-km-np-z]{5}-[2-9a-hj-km-np-z]{5}$/);
  assert.equal(new Set(conf.codiciRecupero).size, 10);
  assert.equal(conf.utente.dueFattori, true);
  U.admin.segreto = ini.segretoBase32;
  U.admin.recupero = conf.codiciRecupero;
  const s = ok200(await admin.get('/api/2fa'));
  assert.equal(s.attiva, true);
  assert.equal(s.codiciRimasti, 10);
  assert.ok(s.attivataIl);
  // la sessione che ha attivato resta, le altre si chiudono
  assert.equal((await admin.get('/api/dati?da=0')).stato, 200);
  assert.equal((await altra.get('/api/dati?da=0')).stato, 401);

  // il segreto è cifrato con la chiave della cartella dati; i codici di recupero sono solo hash
  const chiave = Buffer.from(fs.readFileSync(path.join(S.dati, 'chiave-2fa.key'), 'utf8').trim(), 'base64');
  assert.equal(chiave.length, 32);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(S.dati, 'chiave-2fa.key')).mode & 0o077, 0, 'chiave leggibile solo dal servizio');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(S.dati, 'accessi.db'), { readOnly: true });
  const riga = db.prepare('SELECT * FROM utenti WHERE id = ?').get(U.admin.id);
  db.close();
  assert.match(riga.totp_segreto, /^v1\./);
  assert.ok(!riga.totp_segreto.includes(ini.segretoBase32));
  assert.equal(riga.totp_attivo, 1);
  for (const c of conf.codiciRecupero) assert.ok(!riga.codici_recupero.includes(c) && !riga.codici_recupero.includes(c.replace('-', '')));
  assert.equal(JSON.parse(riga.codici_recupero).length, 10);
});

test('accesso in due passi: con la sola password nessuna sessione, poi il codice', async () => {
  const c = new Client(S.base);
  const l = ok200(await c.post('/api/login', { username: 'admin', password: PW }));
  assert.equal(l.dueFattori, true);
  assert.match(l.sfida, /^[A-Za-z0-9_-]{30,}$/);
  assert.equal(l.utente, undefined, 'niente dati dell’utente prima del codice');
  assert.deepEqual(c.ultimiCookie, [], 'nessun cookie di sessione dopo la sola password');
  assert.equal((await c.get('/api/dati?da=0')).stato, 401);
  assert.equal(ok200(await c.get('/api/stato')).utente, null);
  // password sbagliata: come sempre
  assert.equal((await c.post('/api/login', { username: 'admin', password: 'sbagliata' })).stato, 401);
  // codice sbagliato: si riprova con la stessa sfida (dal server stesso gli errori non contano: niente tentativi rimasti)
  const no = await c.post('/api/login/2fa', { sfida: l.sfida, codice: codiceSbagliato(U.admin.segreto) });
  assert.equal(no.stato, 400);
  assert.match(no.json.errore, /non è giusto/);
  assert.equal(no.json.tentativiRimasti, undefined);
  assert.equal((await c.post('/api/login/2fa', { sfida: l.sfida, codice: '' })).stato, 400);
  // codice giusto (anche con lo spazio in mezzo, come lo mostrano le app)
  const codice = await codiceNuovo(U.admin.segreto);
  const si = ok200(await c.post('/api/login/2fa', { sfida: l.sfida, codice: codice.slice(0, 3) + ' ' + codice.slice(3) }));
  assert.equal(si.utente.username, 'admin');
  assert.equal(si.permessi.sicurezza, true);
  assert.ok(c.cookie.gf_sessione, 'sessione aperta');
  assert.ok(!c.cookie.gf_dispositivo, 'senza «ricorda» niente computer attendibile');
  assert.equal((await c.get('/api/dati?da=0')).stato, 200);
  U.admin.ultimoCodice = codice;

  // la sfida vale una volta sola
  const ancora = await new Client(S.base).post('/api/login/2fa', { sfida: l.sfida, codice: Totp.totp(U.admin.segreto) });
  assert.equal(ancora.stato, 401);
  assert.equal(ancora.json.sfidaScaduta, true);
  // una sfida inventata non vale
  assert.equal((await c.post('/api/login/2fa', { sfida: 'x'.repeat(32), codice: '123456' })).stato, 401);
  // registro attività
  const ev = ok200(await U.admin.client.get('/api/attivita?azione=accesso.entrata&limite=5')).eventi;
  assert.equal(ev[0].dettagli.dueFattori, 'codice');
});

test('la sfida vale solo dal computer che ha scritto la password', async () => {
  const ip = ipRete();
  if (!ip) return; // senza una rete non si può simulare un altro computer
  const qui = new Client(S.base);
  const l = ok200(await qui.post('/api/login', { username: 'admin', password: PW }));
  const altrove = new Client('http://' + ip + ':' + S.porta);
  const r = await altrove.post('/api/login/2fa', { sfida: l.sfida, codice: Totp.totp(U.admin.segreto) });
  assert.equal(r.stato, 401);
});

test('lo stesso codice non vale una seconda volta', async () => {
  const c = new Client(S.base);
  const l = ok200(await c.post('/api/login', { username: 'admin', password: PW }));
  const r = await c.post('/api/login/2fa', { sfida: l.sfida, codice: U.admin.ultimoCodice });
  assert.equal(r.stato, 400);
  assert.equal(r.json.codiceUsato, true);
  assert.match(r.json.errore, /già stato usato/);
  // il codice nuovo sì, con la stessa sfida
  ok200(await c.post('/api/login/2fa', { sfida: l.sfida, codice: await codiceNuovo(U.admin.segreto) }));
});

test('codici di recupero: entrano una volta sola, anche scritti nel campo del codice', async () => {
  const c = new Client(S.base);
  let l = ok200(await c.post('/api/login', { username: 'admin', password: PW }));
  const primo = U.admin.recupero.shift();
  const r = ok200(await c.post('/api/login/2fa', { sfida: l.sfida, codiceRecupero: primo.toUpperCase().replace('-', ' ') }));
  assert.equal(r.codiciRimasti, 9);
  // già usato: non vale più
  const c2 = new Client(S.base);
  l = ok200(await c2.post('/api/login', { username: 'admin', password: PW }));
  const no = await c2.post('/api/login/2fa', { sfida: l.sfida, codiceRecupero: primo });
  assert.equal(no.stato, 400);
  assert.match(no.json.errore, /recupero/);
  // un altro, scritto nel campo del codice (ha lettere: il server capisce che è di recupero)
  const si = ok200(await c2.post('/api/login/2fa', { sfida: l.sfida, codice: U.admin.recupero.shift() }));
  assert.equal(si.codiciRimasti, 8);
  assert.equal(ok200(await c2.get('/api/2fa')).codiciRimasti, 8);
  const ev = ok200(await U.admin.client.get('/api/attivita?azione=accesso.2fa.recupero')).eventi;
  assert.equal(ev.length, 2);
  assert.equal(ev[0].dettagli.codiciRimasti, 8);
});

test('computer attendibile: «Ricorda questo computer per 30 giorni» e «dimentica i computer»', async () => {
  const c = await accedi2fa('admin', { ricorda: true, recupero: true });
  const disp = c.cookie.gf_dispositivo;
  assert.ok(disp, 'cookie del computer attendibile');
  assert.equal(disp.path, '/api/login', 'mandato solo alle pagine di accesso');
  assert.match(disp.completo, /HttpOnly/);
  assert.match(disp.completo, /SameSite=Strict/);
  assert.match(disp.completo, /Max-Age=2592000/);
  assert.equal(ok200(await c.get('/api/2fa')).dispositivi, 1);
  // uscita e nuovo accesso: basta la password
  ok200(await c.post('/api/logout'));
  const l = ok200(await c.post('/api/login', { username: 'admin', password: PW }));
  assert.equal(l.dueFattori, undefined);
  assert.equal(l.utente.username, 'admin');
  assert.equal((await c.get('/api/dati?da=0')).stato, 200);
  // il computer è attendibile solo per quell'utente: rep (con la 2FA) sullo stesso browser deve scrivere il codice
  const rep = U.rep.client;
  const att = await attiva(rep);
  U.rep.segreto = att.segreto;
  U.rep.recupero = att.codici;
  c.dimenticaSessione();
  const lr = ok200(await c.post('/api/login', { username: 'rep', password: PW }));
  assert.equal(lr.dueFattori, true);
  ok200(await c.post('/api/login/2fa', { sfida: lr.sfida, codice: await codiceNuovo(U.rep.segreto), ricorda: true }));
  assert.equal(c.cookie.gf_dispositivo.valore.split('.').length, 2, 'due utenti ricordati sullo stesso computer');
  // il cookie copiato in un altro browser senza la password non serve a niente: la password resta necessaria
  const copia = new Client(S.base);
  copia.cookie.gf_dispositivo = { valore: c.cookie.gf_dispositivo.valore, path: '/api/login' };
  assert.equal((await copia.post('/api/login', { username: 'admin', password: 'sbagliata' })).stato, 401);
  // admin dimentica i suoi computer: al prossimo accesso torna il codice (rep invece resta ricordato)
  c.dimenticaSessione();
  ok200(await c.post('/api/login', { username: 'admin', password: PW }));
  const tolti = ok200(await c.del('/api/2fa/dispositivi'));
  assert.equal(tolti.tolti, 1);
  assert.ok(!c.cookie.gf_dispositivo, 'cookie tolto da questo browser');
  assert.equal(ok200(await c.get('/api/2fa')).dispositivi, 0);
  c.cookie.gf_dispositivo = copia.cookie.gf_dispositivo; // il browser di prima avrebbe ancora il token
  c.dimenticaSessione();
  assert.equal(ok200(await c.post('/api/login', { username: 'admin', password: PW })).dueFattori, true);
  c.dimenticaSessione();
  assert.equal(ok200(await c.post('/api/login', { username: 'rep', password: PW })).dueFattori, undefined);
});

test('5 codici sbagliati bloccano la verifica per 15 minuti (mai dal server stesso)', async () => {
  const ip = ipRete();
  if (!ip) return; // senza una rete non si può simulare un altro computer
  const fuori = new Client('http://' + ip + ':' + S.porta);
  const l = ok200(await fuori.post('/api/login', { username: 'rep', password: PW }));
  assert.equal(l.dueFattori, true);
  for (let i = 1; i <= 4; i++) {
    const r = await fuori.post('/api/login/2fa', { sfida: l.sfida, codice: codiceSbagliato(U.rep.segreto) });
    assert.equal(r.stato, 400);
    assert.equal(r.json.tentativiRimasti, 5 - i);
  }
  // anche un codice di recupero sbagliato conta
  const ultimo = await fuori.post('/api/login/2fa', { sfida: l.sfida, codiceRecupero: 'aaaaa-bbbbb' });
  assert.equal(ultimo.stato, 429);
  assert.match(ultimo.json.errore, /15 minuti/);
  // bloccato: la sfida non vale più e la password giusta non basta a riprovare
  assert.equal((await fuori.post('/api/login/2fa', { sfida: l.sfida, codice: Totp.totp(U.rep.segreto) })).stato, 401);
  assert.equal((await fuori.post('/api/login', { username: 'rep', password: PW })).stato, 429);
  const stato = ok200(await U.admin.client.get('/api/sicurezza')).utenti.find((u) => u.username === 'rep');
  assert.equal(stato.bloccato, true);
  // dal server stesso il vero utente entra comunque (accesso d'emergenza), e il blocco finisce
  const qui = new Client(S.base);
  const lq = ok200(await qui.post('/api/login', { username: 'rep', password: PW }));
  ok200(await qui.post('/api/login/2fa', { sfida: lq.sfida, codiceRecupero: U.rep.recupero.pop() }));
  assert.equal(ok200(await fuori.post('/api/login', { username: 'rep', password: PW })).dueFattori, true);
  const ev = ok200(await U.admin.client.get('/api/attivita?azione=accesso.2fa.bloccato')).eventi;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].dettagli.utente, 'rep');
});

test('criterio dell’amministratore: chi deve attivare la 2FA può solo attivarla', async () => {
  const admin = U.admin.client;
  const farma = U.farma.client;
  // criterio non valido; solo l'amministratore lo cambia
  assert.equal((await admin.put('/api/sicurezza', { richiedi2fa: 'qualcuno' })).stato, 400);
  assert.equal((await farma.put('/api/sicurezza', { richiedi2fa: 'tutti' })).stato, 403);
  // un amministratore senza 2FA non può imporla a sé stesso (si chiuderebbe fuori)
  const no = await U.admin2.client.put('/api/sicurezza', { richiedi2fa: 'amministratori' });
  assert.equal(no.stato, 409);
  assert.equal(no.json.attivaPrima, true);

  const r = ok200(await admin.put('/api/sicurezza', { richiedi2fa: 'farmacisti' }));
  assert.equal(r.richiedi2fa, 'farmacisti');
  assert.equal(r.daAttivare, 2, 'farma e admin2');
  assert.ok(r.rev > 0);
  // il criterio arriva anche con i dati (impostazioni)
  assert.equal(ok200(await admin.get('/api/dati?da=0')).impostazioni.richiedi2fa, 'farmacisti');

  // la sessione già aperta di farma ora serve solo ad attivare la 2FA
  const dati = await farma.get('/api/dati?da=0');
  assert.equal(dati.stato, 401);
  assert.equal(dati.json.attiva2fa, true);
  assert.equal((await farma.get('/api/eventi')).stato, 401);
  assert.equal((await farma.post('/api/movimenti', { movimenti: [] })).stato, 401);
  const st = ok200(await farma.get('/api/stato'));
  assert.equal(st.utente.dueFattoriDaAttivare, true);
  assert.equal(st.utente.dueFattoriObbligatoria, true);
  const s2 = ok200(await farma.get('/api/2fa'));
  assert.equal(s2.daAttivare, true);
  assert.equal(s2.obbligatoria, true);
  // la direzione (sola lettura) non è toccata
  assert.equal((await U.dir.client.get('/api/dati?da=0')).stato, 200);
  // ma se l'amministratore le dà un ruolo per cui il criterio la richiede, la sessione diventa limitata subito
  ok200(await admin.put('/api/utenti/' + U.dir.id, { nome: 'Direzione', ruolo: 'farmacista', reparti: [], attivo: true }));
  assert.equal((await U.dir.client.get('/api/dati?da=0')).stato, 401);
  ok200(await admin.put('/api/utenti/' + U.dir.id, { nome: 'Direzione', ruolo: 'consultazione', reparti: [], attivo: true }));
  assert.equal((await U.dir.client.get('/api/dati?da=0')).stato, 200);
  // un nuovo accesso con la sola password dà la stessa sessione limitata
  const nuova = new Client(S.base);
  const ln = ok200(await nuova.post('/api/login', { username: 'farma', password: PW }));
  assert.equal(ln.dueFattori, undefined);
  assert.equal(ln.utente.dueFattoriDaAttivare, true);
  assert.equal((await nuova.get('/api/dati?da=0')).stato, 401);
  // amministratore che deve attivarla: niente pagina Sicurezza finché non l'attiva
  assert.equal((await U.admin2.client.get('/api/sicurezza')).stato, 401);

  // attivazione: da qui tutto normale (la sessione che ha attivato resta, l'altra si chiude)
  const att = await attiva(farma);
  U.farma.segreto = att.segreto;
  U.farma.recupero = att.codici;
  assert.equal((await farma.get('/api/dati?da=0')).stato, 200);
  assert.equal((await nuova.get('/api/dati?da=0')).stato, 401);
  // obbligatoria: non si disattiva
  const dis = await farma.post('/api/2fa/disattiva', { password: PW, codice: Totp.totp(U.farma.segreto) });
  assert.equal(dis.stato, 409);
  assert.match(dis.json.errore, /richiede/);

  // utente nuovo con password provvisoria: prima la password, poi la 2FA
  ok200(await admin.post('/api/utenti', { username: 'nuovo', nome: 'Nuovo Farmacista', ruolo: 'farmacista', reparti: [], password: 'Provvisoria1' }));
  const n = new Client(S.base);
  const lnn = ok200(await n.post('/api/login', { username: 'nuovo', password: 'Provvisoria1' }));
  assert.equal(lnn.utente.cambioPassword, true);
  assert.equal(lnn.utente.dueFattoriDaAttivare, true);
  assert.equal((await n.get('/api/2fa')).stato, 403);
  ok200(await n.post('/api/password', { attuale: 'Provvisoria1', nuova: PW }));
  assert.equal((await n.get('/api/dati?da=0')).stato, 401);
  assert.equal(ok200(await n.get('/api/2fa')).daAttivare, true);

  // tutti: anche il responsabile in sola lettura
  ok200(await admin.put('/api/sicurezza', { richiedi2fa: 'tutti' }));
  assert.equal((await U.dir.client.get('/api/dati?da=0')).stato, 401);
  // di nuovo facoltativa: tutto torna normale
  const fine = ok200(await admin.put('/api/sicurezza', { richiedi2fa: 'nessuno' }));
  assert.equal(fine.daAttivare, 0);
  assert.equal((await U.dir.client.get('/api/dati?da=0')).stato, 200);
  assert.equal((await n.get('/api/dati?da=0')).stato, 200);
  const ev = ok200(await admin.get('/api/attivita?azione=accesso.2fa.criterio')).eventi;
  assert.equal(ev.length, 3);
  assert.equal(ev[2].dettagli.dopo, 'amministratori e farmacisti');
});

test('nuovi codici di recupero e disattivazione: servono password e codice', async () => {
  const rep = U.rep.client;
  assert.equal((await rep.post('/api/2fa/codici', { password: 'sbagliata' })).stato, 400);
  const nuovi = ok200(await rep.post('/api/2fa/codici', { password: PW })).codiciRecupero;
  assert.equal(nuovi.length, 10);
  // i codici vecchi non valgono più, quelli nuovi sì
  const c = new Client(S.base);
  const l = ok200(await c.post('/api/login', { username: 'rep', password: PW }));
  assert.equal((await c.post('/api/login/2fa', { sfida: l.sfida, codiceRecupero: U.rep.recupero[0] })).stato, 400);
  ok200(await c.post('/api/login/2fa', { sfida: l.sfida, codiceRecupero: nuovi[0] }));
  // disattivazione: codice o password sbagliati no
  assert.equal((await rep.post('/api/2fa/disattiva', { password: PW, codice: codiceSbagliato(U.rep.segreto) })).stato, 400);
  assert.equal((await rep.post('/api/2fa/disattiva', { password: 'sbagliata', codice: Totp.totp(U.rep.segreto) })).stato, 400);
  // anche con un codice di recupero
  const dis = ok200(await rep.post('/api/2fa/disattiva', { password: PW, codice: nuovi[1] }));
  assert.equal(dis.utente.dueFattori, false);
  assert.equal((await rep.post('/api/2fa/disattiva', { password: PW, codice: '123456' })).stato, 409);
  assert.equal((await rep.post('/api/2fa/codici', { password: PW })).stato, 409);
  // senza 2FA: si entra con la sola password, anche il computer ricordato non serve più
  const c2 = new Client(S.base);
  assert.equal(ok200(await c2.post('/api/login', { username: 'rep', password: PW })).dueFattori, undefined);
  assert.equal(ok200(await rep.get('/api/2fa')).dispositivi, 0);
  delete U.rep.segreto;
  // troppi errori con una sessione: la sessione si chiude (come nel cambio password)
  const f = await accedi2fa('farma', { recupero: true });
  for (let i = 0; i < 4; i++) assert.equal((await f.post('/api/2fa/codici', { password: 'sbagliata' })).stato, 400);
  assert.equal((await f.post('/api/2fa/codici', { password: 'sbagliata' })).stato, 401);
  assert.equal((await f.get('/api/dati?da=0')).stato, 401);
});

test('cambio di telefono: serve la password, la chiave nuova vale solo dopo la conferma', async () => {
  const farma = U.farma.client;
  // con la verifica già attiva serve la password (come per disattivarla o creare codici nuovi)
  const senza = await farma.post('/api/2fa/inizia');
  assert.equal(senza.stato, 400);
  assert.equal(senza.json.servePassword, true);
  assert.equal(senza.json.segretoBase32, undefined, 'nessuna chiave senza password');
  const sbagliata = await farma.post('/api/2fa/inizia', { password: 'sbagliata' });
  assert.equal(sbagliata.stato, 400);
  assert.equal(sbagliata.json.segretoBase32, undefined);
  const ini = ok200(await farma.post('/api/2fa/inizia', { password: PW }));
  assert.equal(ini.cambio, true);
  // finché non conferma vale ancora il telefono vecchio
  const c = await accedi2fa('farma');
  // la chiave vale solo per la sessione che ha scritto la password: un'altra sessione dello stesso utente non la conferma
  const altrove = await c.post('/api/2fa/conferma', { codice: Totp.totp(ini.segretoBase32) });
  assert.equal(altrove.stato, 409);
  assert.equal(altrove.json.ricomincia, true);
  const conf = ok200(await farma.post('/api/2fa/conferma', { codice: await codiceNuovo(ini.segretoBase32) }));
  assert.equal(conf.codiciRecupero.length, 10);
  U.farma.segreto = ini.segretoBase32;
  U.farma.recupero = conf.codiciRecupero.slice();
  assert.equal((await c.get('/api/dati?da=0')).stato, 401, 'le altre sessioni si chiudono');
  await accedi2fa('farma');
  const ev = ok200(await U.admin.client.get('/api/attivita?azione=accesso.2fa.riconfigurata')).eventi;
  assert.equal(ev.length, 1);
});

test('pagina Sicurezza: solo l’amministratore; azzeramento della 2FA di un utente', async () => {
  const admin = U.admin.client;
  for (const nome of ['farma', 'rep', 'dir']) {
    const c = U[nome].client;
    assert.equal((await c.get('/api/sicurezza')).stato, 403, nome);
    assert.equal((await c.put('/api/sicurezza', { richiedi2fa: 'nessuno' })).stato, 403, nome);
    assert.equal((await c.post('/api/utenti/' + U.farma.id + '/2fa/azzera')).stato, 403, nome);
  }
  const s = ok200(await admin.get('/api/sicurezza'));
  assert.equal(s.richiedi2fa, 'nessuno');
  assert.deepEqual(s.criteri, ['nessuno', 'amministratori', 'farmacisti', 'tutti']);
  const f = s.utenti.find((u) => u.username === 'farma');
  assert.equal(f.dueFattori, true);
  assert.ok(f.attivataIl);
  assert.equal(f.codiciRimasti, 10);
  assert.equal(f.ruolo, 'farmacista');
  const r = s.utenti.find((u) => u.username === 'rep');
  assert.equal(r.dueFattori, false);
  assert.equal(r.codiciRimasti, 0);
  for (const u of s.utenti) {
    assert.equal(u.hash, undefined);
    assert.equal(u.totp_segreto, undefined);
    assert.equal(u.codici_recupero, undefined);
  }
  assert.equal((await admin.post('/api/utenti/u-inesistente/2fa/azzera')).stato, 404);
  // azzera: la 2FA di farma sparisce e le sue sessioni si chiudono
  const fc = await accedi2fa('farma', { ricorda: true, recupero: true });
  const az = ok200(await admin.post('/api/utenti/' + U.farma.id + '/2fa/azzera'));
  assert.equal(az.utente.dueFattori, false);
  assert.equal((await fc.get('/api/dati?da=0')).stato, 401);
  // anche il computer ricordato non vale più; si entra con la password
  fc.dimenticaSessione();
  const l = ok200(await fc.post('/api/login', { username: 'farma', password: PW }));
  assert.equal(l.dueFattori, undefined);
  assert.equal(l.utente.dueFattori, false);
  const ev = ok200(await admin.get('/api/attivita?azione=accesso.2fa')).eventi.map((e) => e.azione);
  for (const a of ['accesso.2fa.attivata', 'accesso.2fa.fallito', 'accesso.2fa.codice-riusato', 'accesso.2fa.recupero', 'accesso.2fa.bloccato',
    'accesso.2fa.ricorda-computer', 'accesso.2fa.dimentica-computer', 'accesso.2fa.criterio', 'accesso.2fa.nuovi-codici', 'accesso.2fa.disattivata',
    'accesso.2fa.azzerata']) {
    if (a === 'accesso.2fa.bloccato' && !ipRete()) continue;
    assert.ok(ev.includes(a), 'registro: ' + a);
  }
});

/*
 * Revisione di sicurezza, D2: con la 2FA già attiva, «Cambia telefono» salvava un segreto nuovo e 10 codici di recupero
 * nuovi senza password. Chi rubava il cookie di sessione collegava il suo telefono e chiudeva fuori l'utente vero.
 */
test('sessione rubata: senza la password non si collega un altro telefono né si prendono codici di recupero', async () => {
  const admin = U.admin.client;
  ok200(await admin.post('/api/utenti', { username: 'vittima', nome: 'Vittima Prova', ruolo: 'farmacista', reparti: [], password: 'Provvisoria1' }));
  const vittima = new Client(S.base);
  ok200(await vittima.post('/api/login', { username: 'vittima', password: 'Provvisoria1' }));
  ok200(await vittima.post('/api/password', { attuale: 'Provvisoria1', nuova: PW }));
  // prima attivazione dalla propria sessione: la password non serve di nuovo
  const att = await attiva(vittima);
  assert.equal(att.ini.cambio, false);

  // il ladro ha solo il cookie della sessione (non la password, non il telefono)
  const ladro = new Client(S.base);
  ladro.cookie = JSON.parse(JSON.stringify(vittima.cookie));
  assert.equal(ok200(await ladro.get('/api/2fa')).attiva, true, 'la sessione rubata vale');
  const senza = await ladro.post('/api/2fa/inizia');
  assert.equal(senza.stato, 400);
  assert.equal(senza.json.servePassword, true);
  assert.equal(senza.json.segretoBase32, undefined);
  // niente chiave da confermare: nessun codice di recupero nuovo
  const conferma = await ladro.post('/api/2fa/conferma', { codice: '123456' });
  assert.equal(conferma.stato, 409);
  assert.equal(conferma.json.codiciRecupero, undefined);

  // la vittima intanto cambia telefono con la sua password: con la stessa sessione il ladro non indovina il codice nuovo
  const ini = ok200(await vittima.post('/api/2fa/inizia', { password: PW }));
  assert.equal(ini.cambio, true);
  for (let i = 1; i < 10; i++) assert.equal((await ladro.post('/api/2fa/conferma', { codice: codiceSbagliato(ini.segretoBase32) })).stato, 400, 'codice ' + i);
  const decimo = await ladro.post('/api/2fa/conferma', { codice: codiceSbagliato(ini.segretoBase32) });
  assert.equal(decimo.stato, 409);
  assert.equal(decimo.json.ricomincia, true);
  // dopo 10 codici sbagliati quella chiave non vale più, nemmeno con il codice giusto
  assert.equal((await vittima.post('/api/2fa/conferma', { codice: Totp.totp(ini.segretoBase32) })).stato, 409);

  // password tirate a indovinare: alla quinta la sessione rubata si chiude (la password mancante non conta)
  for (let i = 1; i <= 4; i++) assert.equal((await ladro.post('/api/2fa/inizia', { password: 'sbagliata-' + i })).stato, 400);
  const quinta = await ladro.post('/api/2fa/inizia', { password: 'sbagliata-5' });
  assert.equal(quinta.stato, 401);
  assert.equal((await ladro.get('/api/dati?da=0')).stato, 401);

  // il telefono della vittima vale ancora (il segreto non è cambiato) e i suoi codici di recupero pure
  const c = new Client(S.base);
  const l = ok200(await c.post('/api/login', { username: 'vittima', password: PW }));
  ok200(await c.post('/api/login/2fa', { sfida: l.sfida, codice: await codiceNuovo(att.segreto) }));
  const c2 = new Client(S.base);
  const l2 = ok200(await c2.post('/api/login', { username: 'vittima', password: PW }));
  assert.equal(ok200(await c2.post('/api/login/2fa', { sfida: l2.sfida, codiceRecupero: att.codici[0] })).codiciRimasti, 9);
  // registro attività: le password sbagliate e la chiave annullata, nessun cambio di telefono
  const eventi = async (azione) => ok200(await admin.get('/api/attivita?azione=' + azione + '&utente=vittima')).eventi;
  assert.equal((await eventi('accesso.2fa.cambio-telefono-fallito')).length, 5);
  assert.equal((await eventi('accesso.2fa.chiave-annullata')).length, 1);
  assert.equal((await eventi('accesso.2fa.riconfigurata')).length, 0);
});

/*
 * Revisione di sicurezza, D1: dal server stesso il secondo passo non si blocca mai (accesso d'emergenza), ma la sfida
 * restava valida dopo i codici sbagliati e il codice si indovinava in pochi minuti con la sola password.
 */
test('dal server stesso: 10 codici sbagliati annullano la sfida, senza blocco', async () => {
  const c = new Client(S.base); // 127.0.0.1: il server stesso
  let l = ok200(await c.post('/api/login', { username: 'admin', password: PW }));
  for (let i = 1; i <= 9; i++) {
    const r = await c.post('/api/login/2fa', { sfida: l.sfida, codice: codiceSbagliato(U.admin.segreto) });
    assert.equal(r.stato, 400, 'codice sbagliato ' + i);
    assert.equal(r.json.tentativiRimasti, undefined, 'dal server stesso nessun blocco da contare');
  }
  const decimo = await c.post('/api/login/2fa', { sfida: l.sfida, codice: codiceSbagliato(U.admin.segreto) });
  assert.equal(decimo.stato, 401);
  assert.equal(decimo.json.sfidaScaduta, true);
  assert.match(decimo.json.errore, /Troppi codici sbagliati/);
  // la sfida non vale più nemmeno con il codice giusto: serve di nuovo la password
  assert.equal((await c.post('/api/login/2fa', { sfida: l.sfida, codice: Totp.totp(U.admin.segreto) })).stato, 401);
  // nessun blocco: si riscrive la password ed entra (qui con un codice di recupero, per non aspettare un codice nuovo dell'app)
  l = ok200(await c.post('/api/login', { username: 'admin', password: PW }));
  assert.equal(l.dueFattori, true);
  ok200(await c.post('/api/login/2fa', { sfida: l.sfida, codiceRecupero: U.admin.recupero.pop() }));
  assert.equal(ok200(await U.admin.client.get('/api/sicurezza')).utenti.find((u) => u.username === 'admin').bloccato, false);
  const ev = ok200(await U.admin.client.get('/api/attivita?azione=accesso.2fa.sfida-annullata')).eventi;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].dettagli.daServer, true);
  assert.equal(ev[0].dettagli.codiciSbagliati, 10);
});

test('orologio simulato: sfida di 5 minuti, blocco di 15, computer di 30 giorni, accesso d’emergenza', () => {
  const { Database } = require('../server/db.js');
  const { Accessi } = require('../server/accessi.js');
  const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-sicurezza-tempo-'));
  const database = new Database(cartella);
  try {
    const acc = new Accessi(database, () => {});
    let ora = Date.UTC(2026, 10, 2, 9, 0, 0);
    acc.adesso = () => ora;
    const ctx = { ip: '10.1.2.3', locale: false };
    const u = acc.creaUtente(ctx, { username: 'tempo', nome: 'Prova Tempo', ruolo: 'farmacista', password: PW }, database.reparti(), true);
    const ctxU = { ip: '10.1.2.3', utente: u, tokenHash: 'prova' };
    const ini = acc.inizia2fa(ctxU, 'Prova');
    const seg = ini.segretoBase32;
    // la chiave mostrata vale un'ora
    ora += 61 * 60000;
    assert.throws(() => acc.conferma2fa(ctxU, Totp.totp(seg, ora)), (e) => e.stato === 409);
    const ini2 = acc.inizia2fa(ctxU, 'Prova');
    acc.conferma2fa(ctxU, Totp.totp(ini2.segretoBase32, ora));
    const s2 = ini2.segretoBase32;
    const avanti = (ms) => { ora += ms; };
    const codice = () => Totp.totp(s2, ora);

    // sfida: 5 minuti
    avanti(60000);
    let l = acc.login(ctx, 'tempo', PW, 'prova', {});
    assert.equal(l.dueFattori, true);
    avanti(5 * 60000 + 1000);
    assert.throws(() => acc.loginDueFattori(ctx, { sfida: l.sfida, codice: codice() }, 'prova'), (e) => e.stato === 401);
    l = acc.login(ctx, 'tempo', PW, 'prova', {});
    avanti(4 * 60000);
    const s = acc.loginDueFattori(ctx, { sfida: l.sfida, codice: codice(), ricorda: true }, 'prova');
    assert.ok(s.token);
    assert.match(s.dispositivo, /^[A-Za-z0-9_-]{40,}$/);

    // computer attendibile: 30 giorni
    avanti(29 * 86400000);
    assert.ok(acc.login(ctx, 'tempo', PW, 'prova', { dispositivi: [s.dispositivo] }).token);
    avanti(2 * 86400000);
    assert.equal(acc.login(ctx, 'tempo', PW, 'prova', { dispositivi: [s.dispositivo] }).dueFattori, true);

    // blocco: 5 codici sbagliati in 15 minuti; dopo 15 minuti si riprova
    const sbagliato = () => { const giusti = [-1, 0, 1].map((d) => Totp.totp(s2, ora + d * 30000)); let c = '000000'; for (let i = 1; giusti.includes(c); i++) c = String(i * 7).padStart(6, '0'); return c; };
    l = acc.login(ctx, 'tempo', PW, 'prova', {});
    for (let i = 1; i <= 4; i++) assert.throws(() => acc.loginDueFattori(ctx, { sfida: l.sfida, codice: sbagliato() }, 'prova'), (e) => e.stato === 400 && e.dati.tentativiRimasti === 5 - i);
    assert.throws(() => acc.loginDueFattori(ctx, { sfida: l.sfida, codice: sbagliato() }, 'prova'), (e) => e.stato === 429);
    avanti(14 * 60000);
    assert.throws(() => acc.login(ctx, 'tempo', PW, 'prova', {}), (e) => e.stato === 429 && /minut/.test(e.message));
    avanti(60000 + 1000);
    l = acc.login(ctx, 'tempo', PW, 'prova', {});
    assert.equal(l.dueFattori, true);
    // gli errori di più di 15 minuti fa non contano
    for (let i = 0; i < 4; i++) assert.throws(() => acc.loginDueFattori(ctx, { sfida: l.sfida, codice: sbagliato() }, 'prova'), (e) => e.stato === 400);
    avanti(16 * 60000);
    l = acc.login(ctx, 'tempo', PW, 'prova', {});
    assert.throws(() => acc.loginDueFattori(ctx, { sfida: l.sfida, codice: sbagliato() }, 'prova'), (e) => e.stato === 400 && e.dati.tentativiRimasti === 4);
    assert.ok(acc.loginDueFattori(ctx, { sfida: l.sfida, codice: codice() }, 'prova').token);

    // file della chiave rovinato: errore chiaro, il file non si sostituisce
    const acc2 = new Accessi(database, () => {});
    acc2.adesso = () => ora;
    const fileChiave = path.join(cartella, 'chiave-2fa.key');
    const buona = fs.readFileSync(fileChiave, 'utf8');
    fs.writeFileSync(fileChiave, 'rovinata');
    l = acc2.login(ctx, 'tempo', PW, 'prova', {});
    assert.throws(() => acc2.loginDueFattori(ctx, { sfida: l.sfida, codice: codice() }, 'prova'), (e) => e.stato === 500 && /chiave-2fa\.key/.test(e.message));
    assert.equal(fs.readFileSync(fileChiave, 'utf8'), 'rovinata');
    // chiave diversa (cartella dati copiata senza il file): messaggio per l'amministratore
    fs.writeFileSync(fileChiave, require('node:crypto').randomBytes(32).toString('base64'));
    const acc3 = new Accessi(database, () => {});
    acc3.adesso = () => ora;
    l = acc3.login(ctx, 'tempo', PW, 'prova', {});
    assert.throws(() => acc3.loginDueFattori(ctx, { sfida: l.sfida, codice: codice() }, 'prova'), (e) => e.stato === 409 && /azzerarla/.test(e.message));
    fs.writeFileSync(fileChiave, buona);

    // accesso d'emergenza dal server: nuova password provvisoria e 2FA azzerata
    const provvisoria = acc.passwordEmergenza('tempo');
    const dopo = acc.login(ctx, 'tempo', provvisoria, 'prova', {});
    assert.ok(dopo.token);
    assert.equal(dopo.utente.dueFattori, false);
    assert.equal(dopo.utente.cambioPassword, true);
  } finally {
    database.chiudi();
  }
});

/* Codice di 6 cifre sicuramente sbagliato per il segreto all'istante "ora" (finestra di ±30 secondi). */
function sbagliatoAlle(segreto, ora) {
  const giusti = [-1, 0, 1].map((d) => Totp.totp(segreto, ora + d * 30000));
  let c = '000000';
  for (let i = 1; giusti.includes(c); i++) c = String(i * 7).padStart(6, '0');
  return c;
}

test('orologio simulato: cambio di telefono solo con la password e dalla stessa sessione (D2)', () => {
  const { Database } = require('../server/db.js');
  const { Accessi } = require('../server/accessi.js');
  const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-sicurezza-cambio-'));
  const database = new Database(cartella);
  try {
    const acc = new Accessi(database, () => {});
    let ora = Date.UTC(2026, 10, 2, 9, 0, 0);
    acc.adesso = () => ora;
    const ctx = { ip: '10.1.2.3', locale: false };
    const u = acc.creaUtente(ctx, { username: 'cambio', nome: 'Prova Cambio', ruolo: 'farmacista', password: PW }, database.reparti(), true);
    const sessA = { ip: '10.1.2.3', utente: u, tokenHash: 'sessione-a' };
    const sessB = { ip: '10.1.2.4', utente: u, tokenHash: 'sessione-b' };
    // prima attivazione: niente password; la chiave vale solo per la sessione che l'ha chiesta
    const k0 = acc.inizia2fa(sessA, 'Prova');
    assert.equal(k0.cambio, false);
    assert.throws(() => acc.conferma2fa(sessB, Totp.totp(k0.segretoBase32, ora)), (e) => e.stato === 409 && e.dati.ricomincia);
    acc.conferma2fa(sessA, Totp.totp(k0.segretoBase32, ora));

    // con la verifica attiva: senza password 400 { servePassword } (non conta), sbagliata 400 (conta), giusta 200
    assert.throws(() => acc.inizia2fa(sessA, 'Prova'), (e) => e.stato === 400 && e.dati.servePassword);
    assert.throws(() => acc.inizia2fa(sessA, 'Prova', ''), (e) => e.stato === 400 && e.dati.servePassword);
    assert.throws(() => acc.inizia2fa(sessA, 'Prova', 'sbagliata'), (e) => e.stato === 400 && !e.dati);
    const k1 = acc.inizia2fa(sessB, 'Prova', PW);
    assert.equal(k1.cambio, true);
    // una password sbagliata non toglie la chiave già chiesta con quella giusta
    assert.throws(() => acc.inizia2fa(sessB, 'Prova', 'sbagliata'), (e) => e.stato === 400);
    // un'altra sessione dello stesso utente non conferma la chiave di B, nemmeno col codice giusto
    assert.throws(() => acc.conferma2fa(sessA, Totp.totp(k1.segretoBase32, ora)), (e) => e.stato === 409 && e.dati.ricomincia);
    // testi che non possono essere un codice non contano; i codici sbagliati sì: al decimo la chiave non vale più
    assert.throws(() => acc.conferma2fa(sessB, 'abc'), (e) => e.stato === 400);
    for (let i = 1; i < 10; i++) {
      // anche scritto "1-2-3-4-5-6": per il server è un codice come gli altri
      const c = sbagliatoAlle(k1.segretoBase32, ora);
      assert.throws(() => acc.conferma2fa(sessB, i % 2 ? c : c.split('').join('-')), (e) => e.stato === 400, 'codice ' + i);
    }
    assert.throws(() => acc.conferma2fa(sessB, sbagliatoAlle(k1.segretoBase32, ora)), (e) => e.stato === 409 && e.dati.ricomincia && /Troppi codici/.test(e.message));
    assert.throws(() => acc.conferma2fa(sessB, Totp.totp(k1.segretoBase32, ora)), (e) => e.stato === 409);
    // con la password di nuovo: chiave nuova, confermata
    ora += 30000;
    const k2 = acc.inizia2fa(sessB, 'Prova', PW);
    const fatto = acc.conferma2fa(sessB, Totp.totp(k2.segretoBase32, ora));
    assert.equal(fatto.codiciRecupero.length, 10);
    // il telefono vecchio non vale più, quello nuovo sì
    ora += 30000;
    let l = acc.login(ctx, 'cambio', PW, 'prova', {});
    assert.throws(() => acc.loginDueFattori(ctx, { sfida: l.sfida, codice: Totp.totp(k0.segretoBase32, ora) }, 'prova'), (e) => e.stato === 400);
    assert.ok(acc.loginDueFattori(ctx, { sfida: l.sfida, codice: Totp.totp(k2.segretoBase32, ora) }, 'prova').token);
    // cinque password sbagliate con la stessa sessione la chiudono (come nel cambio password)
    const sessC = { ip: '10.1.2.6', utente: u, tokenHash: 'sessione-c' };
    for (let i = 1; i <= 4; i++) assert.throws(() => acc.inizia2fa(sessC, 'Prova', 'sbagliata-' + i), (e) => e.stato === 400);
    assert.throws(() => acc.inizia2fa(sessC, 'Prova', 'sbagliata-5'), (e) => e.stato === 401);

    // chiave chiesta senza password quando la verifica non era attiva: se intanto si attiva, non vale per cambiare telefono
    const v = acc.creaUtente(ctx, { username: 'senza2fa', nome: 'Senza 2FA', ruolo: 'farmacista', password: PW }, database.reparti(), true);
    const sessV = { ip: '10.1.2.5', utente: v, tokenHash: 'sessione-v' };
    const kv = acc.inizia2fa(sessV, 'Prova');
    database.accessi.prepare('UPDATE utenti SET totp_attivo = 1 WHERE id = ?').run(v.id);
    assert.throws(() => acc.conferma2fa(sessV, Totp.totp(kv.segretoBase32, ora)), (e) => e.stato === 409 && e.dati.servePassword && e.dati.ricomincia);
  } finally {
    database.chiudi();
    fs.rmSync(cartella, { recursive: true, force: true });
  }
});

test('orologio simulato: dal server stesso la sfida si annulla e le sfide nuove rallentano, mai un blocco (D1)', () => {
  const { Database } = require('../server/db.js');
  const { Accessi } = require('../server/accessi.js');
  const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-sicurezza-locale-'));
  const database = new Database(cartella);
  try {
    const acc = new Accessi(database, () => {});
    let ora = Date.UTC(2026, 10, 2, 9, 0, 0);
    acc.adesso = () => ora;
    const qui = { ip: '127.0.0.1', locale: true }; // il server stesso
    const u = acc.creaUtente(qui, { username: 'locale', nome: 'Prova Locale', ruolo: 'amministratore', password: PW }, database.reparti(), true);
    const sess = { ip: '127.0.0.1', locale: true, utente: u, tokenHash: 'sessione' };
    const k = acc.inizia2fa(sess, 'Prova');
    acc.conferma2fa(sess, Totp.totp(k.segretoBase32, ora));
    const seg = k.segretoBase32;
    const sbagliato = () => sbagliatoAlle(seg, ora);
    const sfida = () => acc.login(qui, 'locale', PW, 'prova', {}).sfida;
    const prova = (s, codice) => acc.loginDueFattori(qui, { sfida: s, codice: codice }, 'prova');

    // al massimo 3 sfide insieme dallo stesso computer: la quarta toglie la più vecchia
    const s1 = sfida(), s2 = sfida(), s3 = sfida(), s4 = sfida();
    assert.throws(() => prova(s1, sbagliato()), (e) => e.stato === 401 && e.dati.sfidaScaduta);
    // 10 codici sbagliati con la stessa sfida: dal server stesso nessun blocco, ma la sfida non vale più
    for (let i = 1; i <= 9; i++) assert.throws(() => prova(s2, sbagliato()), (e) => e.stato === 400 && !e.dati, 'codice ' + i);
    assert.throws(() => prova(s2, sbagliato()), (e) => e.stato === 401 && e.dati.sfidaScaduta && /Troppi codici/.test(e.message));
    assert.throws(() => prova(s2, Totp.totp(seg, ora + 30000)), (e) => e.stato === 401);
    // altri 10 con un'altra sfida: 20 codici sbagliati in 15 minuti
    for (let i = 1; i <= 10; i++) assert.throws(() => prova(s3, sbagliato()), (e) => e.stato === (i < 10 ? 400 : 401));
    // da qui una sfida nuova ogni 30 secondi (un'attesa, non un blocco)
    assert.throws(() => sfida(), (e) => e.stato === 429 && e.dati.attesaSecondi === 30 && /30 secondi/.test(e.message));
    ora += 29000;
    assert.throws(() => sfida(), (e) => e.stato === 429 && e.dati.attesaSecondi === 1 && /1 secondo/.test(e.message));
    ora += 1000;
    const s5 = sfida();
    assert.ok(s5);
    // anche senza errori nel frattempo, la sfida dopo aspetta altri 30 secondi
    assert.throws(() => sfida(), (e) => e.stato === 429 && e.dati.attesaSecondi === 30);
    // le sfide già date valgono ancora: s4 ha i suoi tentativi, e il codice giusto entra subito (mai un blocco)
    assert.throws(() => prova(s4, sbagliato()), (e) => e.stato === 400);
    const entrato = prova(s5, Totp.totp(seg, ora));
    assert.ok(entrato.token);
    assert.equal(database.accessi.prepare('SELECT bloccato_fino FROM utenti WHERE id = ?').get(u.id).bloccato_fino, 0, 'nessun blocco dal server stesso');
    // dopo un accesso riuscito gli errori di prima non contano più
    assert.ok(sfida());

    // gli errori di più di 15 minuti fa non contano
    for (let n = 0; n < 2; n++) {
      const s = sfida();
      for (let i = 1; i <= 10; i++) assert.throws(() => prova(s, sbagliato()), (e) => e.stato === (i < 10 ? 400 : 401));
    }
    assert.throws(() => sfida(), (e) => e.stato === 429);
    ora += 15 * 60000 + 1000;
    assert.ok(sfida());

    // dalla rete invece valgono come prima i 5 tentativi e il blocco di 15 minuti (prima di arrivare a 10)
    const rete = { ip: '10.9.8.7', locale: false };
    const lr = acc.login(rete, 'locale', PW, 'prova', {});
    for (let i = 1; i <= 4; i++) assert.throws(() => acc.loginDueFattori(rete, { sfida: lr.sfida, codice: sbagliato() }, 'prova'), (e) => e.stato === 400 && e.dati.tentativiRimasti === 5 - i);
    assert.throws(() => acc.loginDueFattori(rete, { sfida: lr.sfida, codice: sbagliato() }, 'prova'), (e) => e.stato === 429);
    // ...e dal server stesso si entra anche con l'utente bloccato per la rete (accesso d'emergenza)
    ora += 30000;
    assert.ok(prova(sfida(), Totp.totp(seg, ora)).token);

    // accesso d'emergenza da riga di comando (un altro processo: non tocca la memoria del server) dopo 20 codici sbagliati
    for (let n = 0; n < 2; n++) {
      const s = sfida();
      for (let i = 1; i <= 10; i++) assert.throws(() => prova(s, sbagliato()), (e) => e.stato === (i < 10 ? 400 : 401));
    }
    assert.throws(() => sfida(), (e) => e.stato === 429);
    const provvisoria = new Accessi(database, () => {}).passwordEmergenza('locale');
    // si entra con la password provvisoria, senza codice e senza attese
    const dopo = acc.login(qui, 'locale', provvisoria, 'prova', {});
    assert.ok(dopo.token);
    assert.equal(dopo.utente.dueFattori, false);
    assert.equal(dopo.utente.cambioPassword, true);
    // nuova password e verifica di nuovo attiva con un telefono nuovo: la password non si chiede di nuovo e gli errori
    // della chiave vecchia non fanno più aspettare
    const sessN = { ip: '127.0.0.1', locale: true, utente: dopo.utente, tokenHash: dopo.tokenHash };
    acc.cambiaPassword(sessN, provvisoria, 'Nuova-Password-1');
    const kn = acc.inizia2fa(sessN, 'Prova');
    assert.equal(kn.cambio, false);
    acc.conferma2fa(sessN, Totp.totp(kn.segretoBase32, ora));
    const ln = acc.login(qui, 'locale', 'Nuova-Password-1', 'prova', {});
    assert.equal(ln.dueFattori, true);
    assert.throws(() => prova(ln.sfida, Totp.totp(seg, ora + 30000)), (e) => e.stato === 400, 'il telefono vecchio non vale');
    ora += 30000;
    assert.ok(prova(ln.sfida, Totp.totp(kn.segretoBase32, ora)).token);
  } finally {
    database.chiudi();
    fs.rmSync(cartella, { recursive: true, force: true });
  }
});
