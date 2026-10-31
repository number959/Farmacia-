/*
 * Server HTTP: interfaccia web (file statici), API JSON e notifiche in tempo reale (Server-Sent Events).
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var A = require('./accessi.js');
var errore = A.errore;

var COOKIE = 'gf_sessione';
var LIMITE_CORPO = 2 * 1024 * 1024;
var LIMITE_PUBBLICO = 16 * 1024; // accesso, primo amministratore, uscita: non servono corpi grandi
var LIMITE_ARCHIVIO = 50 * 1024 * 1024;

var TIPI_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

var CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
  "font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/* ---------- file dell'interfaccia: dall'exe (asset SEA) o dalla cartella del progetto ---------- */

function Statici() {
  this.sea = null;
  try {
    var sea = require('node:sea');
    if (sea.isSea()) this.sea = sea;
  } catch (e) { /* node senza SEA */ }
  this.radice = path.join(__dirname, '..');
  this.cache = {};
}

Statici.prototype.leggi = function (rel) {
  if (this.cache[rel]) return this.cache[rel];
  var dati = null;
  if (this.sea) {
    try { dati = Buffer.from(this.sea.getAsset(rel)); } catch (e) { dati = null; }
  } else {
    var file = path.join(this.radice, rel);
    if (file.indexOf(this.radice + path.sep) === 0 && fs.existsSync(file) && fs.statSync(file).isFile()) dati = fs.readFileSync(file);
  }
  if (!dati) return null;
  var voce = { dati: dati, etag: '"' + crypto.createHash('sha1').update(dati).digest('base64url').slice(0, 20) + '"' };
  if (this.sea) this.cache[rel] = voce;
  return voce;
};

function percorsoStatico(url) {
  var p = decodeURIComponent(url.split('?')[0]);
  if (p === '/' || p === '') return 'index.html';
  if (p.indexOf('\0') >= 0 || p.indexOf('..') >= 0 || p.indexOf('\\') >= 0) return null;
  var rel = p.replace(/^\/+/, '');
  if (rel === 'index.html') return rel;
  if (/^(css|js|vendor)\/[A-Za-z0-9._-]+\.(js|css)$/.test(rel)) return rel;
  if (/^guide\/[a-z0-9-]+\.(mp4|webm|vtt|jpg|png)$/.test(rel)) return rel; // videoguide
  return null;
}

/* ---------- utilità ---------- */

function leggiCookie(req) {
  var out = {};
  String(req.headers.cookie || '').split(';').forEach(function (c) {
    var i = c.indexOf('=');
    if (i <= 0) return;
    // altri programmi sullo stesso server possono lasciare cookie non decodificabili: si ignorano
    try { out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch (e) { /* cookie di altri */ }
  });
  return out;
}

function ipDi(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function eLocale(req) {
  var ip = ipDi(req);
  return ip === '127.0.0.1' || ip === '::1';
}

/* Il nome con cui il browser ha chiamato il server è "localhost" (protezione dal DNS rebinding). */
function hostLocale(req) {
  var h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function intestazioniSicurezza(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function inviaJson(res, stato, oggetto) {
  var corpo = Buffer.from(JSON.stringify(oggetto));
  res.writeHead(stato, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': corpo.length, 'Cache-Control': 'no-store' });
  res.end(corpo);
}

function leggiCorpo(req, limite) {
  return new Promise(function (ok, ko) {
    var pezzi = [];
    var dim = 0;
    var finito = false;
    req.on('data', function (c) {
      if (finito) return;
      dim += c.length;
      if (dim > limite) {
        finito = true;
        ko(errore(413, 'Dati troppo grandi.'));
        req.resume();
        return;
      }
      pezzi.push(c);
    });
    req.on('end', function () {
      if (finito) return;
      finito = true;
      var testo = Buffer.concat(pezzi).toString('utf8');
      if (!testo) return ok({});
      try { ok(JSON.parse(testo)); } catch (e) { ko(errore(400, 'Richiesta non valida (JSON).')); }
    });
    req.on('error', function (e) { if (!finito) { finito = true; ko(e); } });
  });
}

/* ---------- server ---------- */

function Server(opz) {
  this.database = opz.database;
  this.accessi = opz.accessi;
  this.operazioni = opz.operazioni;
  this.backup = opz.backup;
  this.log = opz.log;
  this.versione = opz.versione;
  this.https = !!opz.https;
  this.statici = new Statici();
  this.ascoltatori = new Set();
  this.rotte = [];
  this.definisciRotte();
}

/* Notifica a tutti i browser collegati che c'è una nuova revisione. */
Server.prototype.notifica = function (rev) {
  var msg = 'event: rev\ndata: ' + JSON.stringify({ rev: rev }) + '\n\n';
  this.ascoltatori.forEach(function (a) {
    try { a.res.write(msg); } catch (e) { /* connessione chiusa */ }
  });
};

Server.prototype.rotta = function (metodo, schema, opz, gestore) {
  var nomi = [];
  var re = new RegExp('^' + schema.replace(/:([a-zA-Z]+)/g, function (_, n) { nomi.push(n); return '([^/]+)'; }) + '$');
  this.rotte.push({ metodo: metodo, re: re, nomi: nomi, opz: opz, gestore: gestore });
};

Server.prototype.cookieSessione = function (token, durataS) {
  return COOKIE + '=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + durataS + (this.https ? '; Secure' : '');
};

Server.prototype.statoPubblico = function (ctx) {
  var imp = this.database.impostazioni();
  return {
    inizializzato: this.accessi.contaUtenti() > 0,
    daServer: ctx.locale,
    struttura: imp.struttura,
    sottotitolo: imp.sottotitolo,
    logo: imp.logo,
    versione: this.versione,
    utente: ctx.utente || null,
    permessi: ctx.utente ? A.permessi(ctx.utente) : null
  };
};

Server.prototype.definisciRotte = function () {
  var self = this;
  var acc = this.accessi;
  var op = this.operazioni;
  var db = this.database;
  var PUBBLICA = { pubblica: true, limite: LIMITE_PUBBLICO };
  var LIBERA = { anchePasswordDaCambiare: true, limite: LIMITE_PUBBLICO };

  this.rotta('GET', '/api/stato', PUBBLICA, function (ctx) { return self.statoPubblico(ctx); });

  this.rotta('POST', '/api/setup', PUBBLICA, function (ctx) {
    if (acc.contaUtenti() > 0) throw errore(409, 'Il primo amministratore esiste già.');
    if (!ctx.locale || !hostLocale(ctx.req)) throw errore(403, 'Il primo amministratore si crea aprendo il programma sul server stesso, all’indirizzo http://localhost.');
    var c = ctx.corpo;
    var reparti = db.reparti();
    var u = acc.creaUtente(ctx, { username: c.username, nome: c.nome, ruolo: 'amministratore', password: c.password }, reparti, true);
    var s = acc.login(ctx, u.username, c.password, ctx.req.headers['user-agent']);
    ctx.res.setHeader('Set-Cookie', self.cookieSessione(s.token, A.DURATA_MAX_MS / 1000));
    ctx.utente = s.utente;
    return self.statoPubblico(ctx);
  });

  this.rotta('POST', '/api/login', PUBBLICA, function (ctx) {
    var s = acc.login(ctx, ctx.corpo.username, ctx.corpo.password, ctx.req.headers['user-agent']);
    ctx.res.setHeader('Set-Cookie', self.cookieSessione(s.token, A.DURATA_MAX_MS / 1000));
    return { utente: s.utente, permessi: A.permessi(s.utente) };
  });

  this.rotta('POST', '/api/logout', PUBBLICA, function (ctx) {
    if (ctx.utente) acc.logout(ctx);
    ctx.res.setHeader('Set-Cookie', self.cookieSessione('', 0));
    return { ok: true };
  });

  this.rotta('POST', '/api/password', LIBERA, function (ctx) {
    acc.cambiaPassword(ctx, ctx.corpo.attuale, ctx.corpo.nuova);
    return { ok: true, utente: acc.utente(ctx.utente.id) };
  });

  this.rotta('GET', '/api/dati', {}, function (ctx) { return db.cambiamenti(ctx.query.get('da'), ctx.query.get('storia')); });

  this.rotta('POST', '/api/movimenti', {}, function (ctx) { return op.registraMovimenti(ctx, ctx.corpo.movimenti); });
  this.rotta('POST', '/api/movimenti/:id/annulla', {}, function (ctx) { return op.annullaMovimento(ctx, ctx.par.id, ctx.corpo.motivo); });
  this.rotta('POST', '/api/consumo-giorno', {}, function (ctx) { return op.consumoGiorno(ctx, ctx.corpo); });

  this.rotta('POST', '/api/articoli', {}, function (ctx) { return op.creaArticolo(ctx, ctx.corpo); });
  this.rotta('POST', '/api/articoli/importa', {}, function (ctx) { return op.importaArticoli(ctx, ctx.corpo); });
  this.rotta('PUT', '/api/articoli/:id', {}, function (ctx) { return op.modificaArticolo(ctx, ctx.par.id, ctx.corpo); });
  this.rotta('POST', '/api/articoli/:id/barcode', { permesso: 'articoli' }, function (ctx) { return op.associaCodice(ctx, ctx.par.id, ctx.corpo.chiave); });
  this.rotta('DELETE', '/api/articoli/:id', {}, function (ctx) { return op.eliminaArticolo(ctx, ctx.par.id); });

  this.rotta('PUT', '/api/impostazioni', {}, function (ctx) { return op.salvaImpostazioni(ctx, ctx.corpo); });
  this.rotta('PUT', '/api/reparti', {}, function (ctx) { return op.salvaReparti(ctx, ctx.corpo); });
  this.rotta('DELETE', '/api/reparti/:id', { permesso: 'impostazioni' }, function (ctx) {
    var r = op.eliminaReparto(ctx, ctx.par.id);
    self.notificaPermessi(r.utentiAggiornati || []);
    return { rev: r.rev };
  });

  function soloAdmin(ctx, permesso) {
    if (!ctx.permessi[permesso]) throw errore(403, 'Il tuo utente non può fare questa operazione.');
  }
  // il permesso nelle opzioni si controlla prima di leggere il corpo della richiesta
  var UTENTI = { permesso: 'utenti' };
  var BACKUP = { permesso: 'backup' };

  this.rotta('GET', '/api/utenti', UTENTI, function (ctx) {
    soloAdmin(ctx, 'utenti');
    return { utenti: acc.elencoUtenti() };
  });
  this.rotta('POST', '/api/utenti', UTENTI, function (ctx) {
    soloAdmin(ctx, 'utenti');
    return { utente: acc.creaUtente(ctx, ctx.corpo, db.reparti(), false) };
  });
  this.rotta('PUT', '/api/utenti/:id', UTENTI, function (ctx) {
    soloAdmin(ctx, 'utenti');
    var u = acc.modificaUtente(ctx, ctx.par.id, ctx.corpo, db.reparti());
    self.chiudiSseUtente(u);
    self.notificaPermessi([u.id]);
    return { utente: u };
  });
  this.rotta('POST', '/api/utenti/:id/password', UTENTI, function (ctx) {
    soloAdmin(ctx, 'utenti');
    acc.reimpostaPassword(ctx, ctx.par.id, ctx.corpo.nuova);
    return { ok: true };
  });

  this.rotta('GET', '/api/attivita', { permesso: 'attivita' }, function (ctx) {
    soloAdmin(ctx, 'attivita');
    var q = ctx.query;
    var al = q.get('al');
    if (al && /^\d{4}-\d{2}-\d{2}$/.test(al)) {
      var d = new Date(al + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      al = d.toISOString();
    }
    var dal = q.get('dal');
    if (dal && /^\d{4}-\d{2}-\d{2}$/.test(dal)) dal = new Date(dal + 'T00:00:00').toISOString();
    return { eventi: acc.eventi({ dal: dal, al: al, utente: q.get('utente'), azione: q.get('azione'), limite: q.get('limite') }) };
  });

  this.rotta('GET', '/api/backup', BACKUP, function (ctx) {
    soloAdmin(ctx, 'backup');
    return { backup: self.backup.elenco(), cartella: self.backup.cartella };
  });
  this.rotta('POST', '/api/backup', BACKUP, function (ctx) {
    soloAdmin(ctx, 'backup');
    var nome = self.backup.crea('manuale');
    acc.evento(ctx, 'backup.crea', { copia: nome });
    return { nome: nome, backup: self.backup.elenco() };
  });
  this.rotta('GET', '/api/backup/:nome', BACKUP, function (ctx) {
    soloAdmin(ctx, 'backup');
    var file = self.backup.percorso(ctx.par.nome);
    acc.evento(ctx, 'backup.scarica', { copia: ctx.par.nome });
    var st = fs.statSync(file);
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': 'attachment; filename="' + ctx.par.nome + '"',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(file).pipe(ctx.res);
    return undefined; // risposta già inviata
  });
  this.rotta('POST', '/api/backup/:nome/ripristina', BACKUP, function (ctx) {
    soloAdmin(ctx, 'backup');
    var r = self.backup.ripristina(ctx.par.nome);
    // gli utenti di reparto non devono restare legati a reparti che nella copia non esistono
    var esistenti = db.reparti().map(function (x) { return x.id; });
    var toccati = op.allineaRepartiUtenti(esistenti);
    acc.evento(ctx, 'backup.ripristina', { copia: ctx.par.nome, copiaDiSicurezza: r.sicurezza, utentiAggiornati: toccati.length });
    self.notifica(r.rev);
    self.notificaPermessi(toccati);
    return { rev: r.rev, sicurezza: r.sicurezza };
  });

  this.rotta('POST', '/api/importa-archivio', { limite: LIMITE_ARCHIVIO, permesso: 'impostazioni' }, function (ctx) {
    soloAdmin(ctx, 'impostazioni');
    if (!op.archivioVuoto()) throw errore(409, 'L’archivio della versione per un solo PC si può importare solo in un archivio vuoto.');
    // copia di sicurezza prima di un'operazione grande
    self.backup.crea('manuale');
    return op.importaArchivio(ctx, ctx.corpo);
  });
  this.rotta('POST', '/api/demo', {}, function (ctx) { return op.caricaDemo(ctx); });
};

/* Avvisa i browser degli utenti indicati che ruolo o reparti sono cambiati. */
Server.prototype.notificaPermessi = function (utentiIds) {
  if (!utentiIds || !utentiIds.length) return;
  this.ascoltatori.forEach(function (a) {
    if (utentiIds.indexOf(a.utenteId) >= 0) { try { a.res.write('event: permessi\ndata: {}\n\n'); } catch (e) { /* chiusa */ } }
  });
};

Server.prototype.chiudiSseUtente = function (utente) {
  if (utente.attivo) return;
  this.ascoltatori.forEach(function (a) {
    if (a.utenteId === utente.id) { try { a.res.end(); } catch (e) { /* già chiusa */ } }
  });
};

Server.prototype.contesto = function (req, res) {
  var url = new URL(req.url, 'http://localhost');
  var ctx = {
    req: req, res: res, ip: ipDi(req), locale: eLocale(req), percorso: url.pathname, query: url.searchParams,
    utente: null, permessi: null, tokenHash: null
  };
  var token = leggiCookie(req)[COOKIE];
  ctx.token = token;
  if (token) {
    var automatica = req.method === 'GET' && (url.pathname === '/api/dati' || url.pathname === '/api/eventi');
    var s = this.accessi.sessione(token, automatica);
    if (s) {
      ctx.utente = s.utente;
      ctx.tokenHash = s.tokenHash;
      ctx.permessi = A.permessi(s.utente);
    }
  }
  return ctx;
};

Server.prototype.gestisciApi = function (req, res) {
  var self = this;
  var ctx;
  try {
    ctx = this.contesto(req, res);
  } catch (e) {
    this.log('Errore: ' + (e.stack || e.message));
    return inviaJson(res, 500, { errore: 'Errore interno del server.' });
  }
  var metodo = req.method;
  if (ctx.percorso === '/api/eventi' && metodo === 'GET') return this.eventi(ctx);
  var trovata = null;
  var par = {};
  var percorsoNoto = false;
  for (var i = 0; i < this.rotte.length; i++) {
    var r = this.rotte[i];
    var m = r.re.exec(ctx.percorso);
    if (!m) continue;
    percorsoNoto = true;
    if (r.metodo !== metodo) continue;
    trovata = r;
    try {
      r.nomi.forEach(function (n, k) { par[n] = decodeURIComponent(m[k + 1]); });
    } catch (e) {
      return inviaJson(res, 400, { errore: 'Indirizzo non valido.' });
    }
    break;
  }
  if (!trovata) return inviaJson(res, percorsoNoto ? 405 : 404, { errore: percorsoNoto ? 'Metodo non permesso.' : 'Indirizzo non trovato.' });
  ctx.par = par;

  if (metodo !== 'GET' && metodo !== 'HEAD') {
    // protezione CSRF: intestazione personalizzata (un altro sito non può aggiungerla senza permesso)
    if (req.headers['x-richiesta'] !== '1') return inviaJson(res, 403, { errore: 'Richiesta non permessa.' });
    var origine = req.headers.origin;
    if (origine && origine !== 'null') {
      try {
        if (new URL(origine).host !== req.headers.host) return inviaJson(res, 403, { errore: 'Richiesta da un altro sito non permessa.' });
      } catch (e) { return inviaJson(res, 403, { errore: 'Richiesta non permessa.' }); }
    }
  }
  if (!trovata.opz.pubblica) {
    if (!ctx.utente) return inviaJson(res, 401, { errore: 'Sessione scaduta: accedi di nuovo.' });
    if (utenteDiverso(req, ctx)) return inviaJson(res, 401, { errore: 'In questo browser è entrato un altro utente: accedi di nuovo.', altroUtente: true });
    if (ctx.utente.cambioPassword && !trovata.opz.anchePasswordDaCambiare) return inviaJson(res, 403, { errore: 'Prima di continuare cambia la password.' });
    if (trovata.opz.permesso && !ctx.permessi[trovata.opz.permesso]) return inviaJson(res, 403, { errore: 'Il tuo utente non può fare questa operazione.' });
  }

  var corpo = metodo === 'GET' || metodo === 'HEAD' ? Promise.resolve({}) : leggiCorpo(req, trovata.opz.limite || LIMITE_CORPO);
  corpo.then(function (c) {
    ctx.corpo = c && typeof c === 'object' ? c : {};
    if (!trovata.opz.pubblica && metodo !== 'GET') {
      // mentre arrivava il corpo l'utente potrebbe essere stato disattivato o declassato: ricontrollo
      var s = self.accessi.sessione(ctx.token, true);
      if (!s) throw errore(401, 'Sessione scaduta: accedi di nuovo.');
      ctx.utente = s.utente;
      ctx.permessi = A.permessi(s.utente);
      if (ctx.utente.cambioPassword && !trovata.opz.anchePasswordDaCambiare) throw errore(403, 'Prima di continuare cambia la password.');
      if (trovata.opz.permesso && !ctx.permessi[trovata.opz.permesso]) throw errore(403, 'Il tuo utente non può fare questa operazione.');
    }
    var risultato = trovata.gestore(ctx);
    if (risultato !== undefined && !res.headersSent) inviaJson(res, 200, risultato);
  }).catch(function (e) {
    if (res.headersSent) { try { res.end(); } catch (x) { /* già chiusa */ } return; }
    if (e && e.stato) return inviaJson(res, e.stato, { errore: e.message });
    if (e && /UNIQUE constraint failed: articoli\.nome/.test(e.message)) return inviaJson(res, 409, { errore: 'Esiste già un articolo con questo nome.' });
    self.log('Errore su ' + metodo + ' ' + ctx.percorso + ': ' + (e && (e.stack || e.message)));
    inviaJson(res, 500, { errore: 'Errore interno del server. Il dettaglio è nel registro del server.' });
  });
};

/*
 * Il client dice quale utente crede di essere (intestazione X-Utente, o ?utente= per le notifiche):
 * se nello stesso browser un'altra scheda è entrata con un altro utente, il cookie è cambiato
 * e questa scheda non deve registrare a nome dell'altro.
 */
function utenteDiverso(req, ctx) {
  var atteso = req.headers['x-utente'] || ctx.query.get('utente');
  return !!atteso && !!ctx.utente && atteso !== ctx.utente.id;
}

Server.prototype.eventi = function (ctx) {
  var self = this;
  if (!ctx.utente || utenteDiverso(ctx.req, ctx)) return inviaJson(ctx.res, 401, { errore: 'Sessione scaduta: accedi di nuovo.' });
  var res = ctx.res;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 5000\n');
  res.write('event: rev\ndata: ' + JSON.stringify({ rev: this.database.rev() }) + '\n\n');
  var voce = { res: res, utenteId: ctx.utente.id, token: leggiCookie(ctx.req)[COOKIE] };
  this.ascoltatori.add(voce);
  var ping = setInterval(function () {
    // la sessione potrebbe essere scaduta o l'utente disattivato
    if (!self.accessi.sessione(voce.token, true)) { try { res.end(); } catch (e) { /* già chiusa */ } return; }
    try { res.write(': ping\n\n'); } catch (e) { /* chiusa */ }
  }, 25000);
  function chiudi() {
    clearInterval(ping);
    self.ascoltatori.delete(voce);
  }
  ctx.req.on('close', chiudi);
  res.on('close', chiudi);
};

Server.prototype.gestisciStatico = function (req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Metodo non permesso');
  }
  var rel;
  try { rel = percorsoStatico(req.url); } catch (e) { rel = null; }
  var voce = rel ? this.statici.leggi(rel) : null;
  if (!voce) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Pagina non trovata');
  }
  if (req.headers['if-none-match'] === voce.etag) {
    res.writeHead(304, { ETag: voce.etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  // i video si chiedono a pezzi (Range): serve per spostarsi avanti e indietro nel lettore
  var intervallo = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (intervallo && (intervallo[1] || intervallo[2])) {
    var tot = voce.dati.length;
    var da = intervallo[1] ? Number(intervallo[1]) : Math.max(0, tot - Number(intervallo[2]));
    var a = intervallo[1] && intervallo[2] ? Math.min(Number(intervallo[2]), tot - 1) : tot - 1;
    if (da >= tot || da > a) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + tot });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': TIPI_MIME[path.extname(rel)] || 'application/octet-stream',
      'Content-Length': a - da + 1,
      'Content-Range': 'bytes ' + da + '-' + a + '/' + tot,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      ETag: voce.etag
    });
    return res.end(req.method === 'HEAD' ? undefined : voce.dati.subarray(da, a + 1));
  }
  res.writeHead(200, {
    'Content-Type': TIPI_MIME[path.extname(rel)] || 'application/octet-stream',
    'Content-Length': voce.dati.length,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
    ETag: voce.etag
  });
  res.end(req.method === 'HEAD' ? undefined : voce.dati);
};

Server.prototype.gestore = function () {
  var self = this;
  return function (req, res) {
    intestazioniSicurezza(res);
    var p = String(req.url || '/');
    if (p === '/api' || p.indexOf('/api/') === 0) return self.gestisciApi(req, res);
    return self.gestisciStatico(req, res);
  };
};

Server.prototype.chiudiTutto = function () {
  this.ascoltatori.forEach(function (a) { try { a.res.end(); } catch (e) { /* già chiusa */ } });
  this.ascoltatori.clear();
};

module.exports = { Server: Server, percorsoStatico: percorsoStatico };
