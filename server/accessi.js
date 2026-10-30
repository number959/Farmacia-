/*
 * Utenti, password, sessioni, ruoli e registro attività.
 */
'use strict';

var crypto = require('crypto');

var RUOLI = {
  amministratore: 'Amministratore',
  farmacista: 'Farmacista',
  reparto: 'Reparto',
  consultazione: 'Consultazione'
};

var SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
var LUNGHEZZA_CHIAVE = 64;
var TENTATIVI_MAX = 5;
var BLOCCO_MS = 15 * 60 * 1000;
var INATTIVITA_MS = 8 * 60 * 60 * 1000;
var DURATA_MAX_MS = 14 * 60 * 60 * 1000;
var PASSWORD_MIN = 8;

function errore(stato, messaggio) {
  var e = new Error(messaggio);
  e.stato = stato;
  return e;
}

function hashPassword(password, sale) {
  return crypto.scryptSync(String(password), Buffer.from(sale, 'hex'), LUNGHEZZA_CHIAVE, SCRYPT).toString('hex');
}

function nuovaPassword(password) {
  controllaPassword(password);
  var sale = crypto.randomBytes(16).toString('hex');
  return { sale: sale, hash: hashPassword(password, sale) };
}

function controllaPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw errore(400, 'La password deve avere almeno ' + PASSWORD_MIN + ' caratteri.');
  }
  if (password.length > 200) throw errore(400, 'La password è troppo lunga.');
}

function passwordGiusta(password, utente) {
  var calcolato = Buffer.from(hashPassword(password, utente.sale), 'hex');
  var atteso = Buffer.from(utente.hash, 'hex');
  return calcolato.length === atteso.length && crypto.timingSafeEqual(calcolato, atteso);
}

// per non far capire dai tempi di risposta se un nome utente esiste
var SALE_FINTO = crypto.randomBytes(16).toString('hex');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function nuovoId(prefisso) {
  return prefisso + '-' + crypto.randomBytes(9).toString('base64url');
}

/* ---------- permessi ---------- */

function permessi(utente) {
  if (!utente) return null;
  var r = utente.ruolo;
  var admin = r === 'amministratore';
  var farm = admin || r === 'farmacista';
  var rep = r === 'reparto';
  return {
    utenti: admin,
    impostazioni: admin,
    backup: admin,
    attivita: farm,
    articoli: farm,
    carico: farm,
    trasferimento: farm,
    rettifica: farm,
    consumo: farm || rep,
    perdita: farm || rep,
    registro: farm || rep,
    annullaTutti: farm,
    reparti: rep ? (utente.reparti || []).slice() : null
  };
}

function puoScrivereReparto(perm, repartoId) {
  return perm.reparti === null || perm.reparti.indexOf(repartoId) >= 0;
}

/* ---------- conversione ---------- */

function utenteDaRiga(r) {
  if (!r) return null;
  var reparti = [];
  try { reparti = JSON.parse(r.reparti || '[]'); } catch (e) { reparti = []; }
  return {
    id: r.id, username: r.username, nome: r.nome, ruolo: r.ruolo, reparti: reparti,
    attivo: !!r.attivo, cambioPassword: !!r.cambio_password, ultimoAccesso: r.ultimo_accesso || null,
    bloccato: r.bloccato_fino > Date.now()
  };
}

function Accessi(database, log) {
  this.database = database;
  this.log = log || function () {};
  this.fallitiPerIp = {};      // ip -> [istanti degli errori]
  this.fallitiPerCoppia = {};  // 'utente|ip' -> [istanti degli errori]
  this.ipSegnalati = {};       // ip -> istante dell'ultimo evento "bloccato-ip" registrato
  this.erroriCambioPassword = {}; // hash della sessione -> numero di password attuali sbagliate
}

Accessi.prototype.db = function () { return this.database.accessi; };

Accessi.prototype.contaUtenti = function () {
  return this.db().prepare('SELECT COUNT(*) n FROM utenti').get().n;
};

Accessi.prototype.utente = function (id) {
  return utenteDaRiga(this.db().prepare('SELECT * FROM utenti WHERE id = ?').get(id));
};

Accessi.prototype.elencoUtenti = function () {
  return this.db().prepare('SELECT * FROM utenti ORDER BY nome COLLATE NOCASE').all().map(utenteDaRiga);
};

/* ---------- registro attività ---------- */

var MAX_DETTAGLI = 4000;

Accessi.prototype.evento = function (ctx, azione, dettagli) {
  var u = ctx && ctx.utente;
  try {
    var testoDettagli = JSON.stringify(dettagli || {});
    // un evento non può far crescere il registro senza limiti
    if (testoDettagli.length > MAX_DETTAGLI) testoDettagli = JSON.stringify({ troncato: true, testo: testoDettagli.slice(0, MAX_DETTAGLI) });
    this.db().prepare('INSERT INTO eventi (quando, utente_id, username, azione, dettagli, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), u ? u.id : null, u ? u.username : String((ctx && ctx.username) || '').slice(0, 40), azione,
        testoDettagli, String((ctx && ctx.ip) || '').slice(0, 60));
  } catch (e) {
    this.log('Registro attività non scritto: ' + e.message);
  }
};

Accessi.prototype.eventi = function (filtro) {
  var where = [];
  var par = [];
  if (filtro.dal) { where.push('quando >= ?'); par.push(filtro.dal); }
  if (filtro.al) { where.push('quando < ?'); par.push(filtro.al); }
  if (filtro.utente) { where.push('username = ? COLLATE NOCASE'); par.push(filtro.utente); }
  if (filtro.azione) { where.push('azione LIKE ?'); par.push(filtro.azione + '%'); }
  var limite = Math.min(Math.max(Math.floor(Number(filtro.limite)) || 500, 1), 5000);
  var sql = 'SELECT * FROM eventi' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ' + limite;
  var st = this.db().prepare(sql);
  return st.all.apply(st, par).map(function (r) {
    var det = {};
    try { det = JSON.parse(r.dettagli); } catch (e) { det = { testo: r.dettagli }; }
    return { id: r.id, quando: r.quando, username: r.username, azione: r.azione, dettagli: det, ip: r.ip };
  });
};

/* ---------- validazione utenti ---------- */

function validaUtente(dati, reparti, nuovo) {
  var out = {};
  if (nuovo) {
    var username = String(dati.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
      throw errore(400, 'Il nome utente deve avere da 3 a 40 caratteri: lettere, numeri, punto, trattino.');
    }
    out.username = username;
  }
  var nome = String(dati.nome || '').trim();
  if (!nome || nome.length > 100) throw errore(400, 'Scrivi nome e cognome.');
  out.nome = nome;
  if (!RUOLI[dati.ruolo]) throw errore(400, 'Ruolo non valido.');
  out.ruolo = dati.ruolo;
  var lista = Array.isArray(dati.reparti) ? dati.reparti.map(String) : [];
  var esistenti = reparti.map(function (r) { return r.id; });
  lista = lista.filter(function (id, i) { return esistenti.indexOf(id) >= 0 && lista.indexOf(id) === i; });
  if (out.ruolo === 'reparto' && !lista.length) throw errore(400, 'Un utente di reparto deve avere almeno un reparto.');
  out.reparti = out.ruolo === 'reparto' ? lista : [];
  return out;
}

Accessi.prototype.creaUtente = function (ctx, dati, reparti, primo) {
  var v = validaUtente(dati, reparti, true);
  var pw = nuovaPassword(dati.password);
  var db = this.db();
  if (db.prepare('SELECT 1 FROM utenti WHERE username = ?').get(v.username)) throw errore(409, 'Esiste già un utente con questo nome.');
  var id = nuovoId('u');
  db.prepare('INSERT INTO utenti (id, username, nome, ruolo, reparti, hash, sale, attivo, cambio_password, creato) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .run(id, v.username, v.nome, v.ruolo, JSON.stringify(v.reparti), pw.hash, pw.sale, primo ? 0 : 1, new Date().toISOString());
  this.evento(ctx, primo ? 'utenti.primo-amministratore' : 'utenti.crea', { utente: v.username, nome: v.nome, ruolo: v.ruolo, reparti: v.reparti });
  return this.utente(id);
};

Accessi.prototype.contaAmministratoriAttivi = function (tranneId) {
  return this.db().prepare("SELECT COUNT(*) n FROM utenti WHERE ruolo = 'amministratore' AND attivo = 1 AND id != ?").get(tranneId || '').n;
};

Accessi.prototype.modificaUtente = function (ctx, id, dati, reparti) {
  var prima = this.utente(id);
  if (!prima) throw errore(404, 'Utente non trovato.');
  var v = validaUtente(dati, reparti, false);
  var attivo = dati.attivo === undefined ? prima.attivo : !!dati.attivo;
  var restaAdmin = v.ruolo === 'amministratore' && attivo;
  if (prima.ruolo === 'amministratore' && prima.attivo && !restaAdmin && this.contaAmministratoriAttivi(id) === 0) {
    throw errore(400, 'Deve restare almeno un amministratore attivo.');
  }
  var self = this;
  this.database.transazioneAccessi(function () {
    self.db().prepare('UPDATE utenti SET nome = ?, ruolo = ?, reparti = ?, attivo = ? WHERE id = ?')
      .run(v.nome, v.ruolo, JSON.stringify(v.reparti), attivo ? 1 : 0, id);
    if (!attivo) self.db().prepare('DELETE FROM sessioni WHERE utente_id = ?').run(id);
  });
  this.evento(ctx, 'utenti.modifica', { utente: prima.username, prima: { nome: prima.nome, ruolo: prima.ruolo, reparti: prima.reparti, attivo: prima.attivo }, dopo: { nome: v.nome, ruolo: v.ruolo, reparti: v.reparti, attivo: attivo } });
  return this.utente(id);
};

Accessi.prototype.reimpostaPassword = function (ctx, id, nuova) {
  var u = this.utente(id);
  if (!u) throw errore(404, 'Utente non trovato.');
  var pw = nuovaPassword(nuova);
  var self = this;
  this.database.transazioneAccessi(function () {
    self.db().prepare('UPDATE utenti SET hash = ?, sale = ?, cambio_password = 1, tentativi = 0, bloccato_fino = 0 WHERE id = ?').run(pw.hash, pw.sale, id);
    self.db().prepare('DELETE FROM sessioni WHERE utente_id = ?').run(id);
  });
  this.sblocca(u.username);
  this.evento(ctx, 'utenti.nuova-password', { utente: u.username });
};

Accessi.prototype.cambiaPassword = function (ctx, attuale, nuova) {
  var riga = this.db().prepare('SELECT * FROM utenti WHERE id = ?').get(ctx.utente.id);
  if (!riga || !passwordGiusta(String(attuale || '').slice(0, 200), riga)) {
    // con una sessione rubata non si deve poter indovinare la password all'infinito
    var n = (this.erroriCambioPassword[ctx.tokenHash] || 0) + 1;
    this.erroriCambioPassword[ctx.tokenHash] = n;
    this.evento(ctx, 'accesso.cambio-password-fallito', { tentativo: n });
    if (n >= TENTATIVI_MAX) {
      delete this.erroriCambioPassword[ctx.tokenHash];
      this.db().prepare('DELETE FROM sessioni WHERE token_hash = ?').run(ctx.tokenHash || '');
      throw errore(401, 'Troppe password attuali sbagliate: per sicurezza la sessione è stata chiusa. Accedi di nuovo.');
    }
    throw errore(400, 'La password attuale non è giusta.');
  }
  delete this.erroriCambioPassword[ctx.tokenHash];
  if (String(nuova) === String(attuale)) throw errore(400, 'La nuova password deve essere diversa da quella attuale.');
  var pw = nuovaPassword(nuova);
  var self = this;
  this.database.transazioneAccessi(function () {
    self.db().prepare('UPDATE utenti SET hash = ?, sale = ?, cambio_password = 0 WHERE id = ?').run(pw.hash, pw.sale, riga.id);
    // chiude le altre sessioni dello stesso utente
    self.db().prepare('DELETE FROM sessioni WHERE utente_id = ? AND token_hash != ?').run(riga.id, ctx.tokenHash || '');
  });
  this.evento(ctx, 'accesso.cambio-password', {});
};

/* ---------- accesso ---------- */

/*
 * Protezione dai tentativi:
 * - 5 errori per la stessa coppia (utente, computer) in 15 minuti bloccano quella coppia, non l'utente:
 *   da un altro computer (e sempre dal server stesso) l'utente vero può ancora entrare;
 * - 100 errori dallo stesso computer in 15 minuti bloccano quel computer (tentativi a tappeto).
 * La risposta è la stessa per utenti esistenti e inesistenti, così non si scopre quali nomi esistono.
 */
var ERRORI_IP_MAX = 100;

function recenti(lista, adesso) {
  return (lista || []).filter(function (t) { return adesso - t < BLOCCO_MS; });
}

Accessi.prototype.pulisciContatori = function (adesso) {
  var self = this;
  [this.fallitiPerIp, this.fallitiPerCoppia].forEach(function (mappa) {
    Object.keys(mappa).forEach(function (k) {
      mappa[k] = recenti(mappa[k], adesso);
      if (!mappa[k].length) delete mappa[k];
    });
  });
  Object.keys(this.ipSegnalati).forEach(function (k) {
    if (adesso - self.ipSegnalati[k] > BLOCCO_MS) delete self.ipSegnalati[k];
  });
};

Accessi.prototype.sblocca = function (username) {
  var self = this;
  Object.keys(this.fallitiPerCoppia).forEach(function (k) {
    if (k.indexOf(username + '|') === 0) delete self.fallitiPerCoppia[k];
  });
};

Accessi.prototype.login = function (ctx, username, password, agente) {
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  var adesso = Date.now();
  this.pulisciContatori(adesso);
  var valido = /^[a-z0-9._-]{3,40}$/.test(username) && password.length <= 200;
  var coppia = username.slice(0, 40) + '|' + ctx.ip;
  var locale = !!ctx.locale; // dal server stesso non si blocca mai: è l'accesso d'emergenza
  var self = this;

  function fallito(motivo, conNome) {
    if (!locale) {
      (self.fallitiPerIp[ctx.ip] = self.fallitiPerIp[ctx.ip] || []).push(adesso);
      if (valido) (self.fallitiPerCoppia[coppia] = self.fallitiPerCoppia[coppia] || []).push(adesso);
    }
    // il nome scritto si registra solo se è di un utente vero: spesso nel campo sbagliato finisce la password
    self.evento({ ip: ctx.ip, username: conNome ? username : '' }, 'accesso.fallito', conNome ? { utente: username, motivo: motivo } : { motivo: motivo });
    if (!locale && valido && self.fallitiPerCoppia[coppia].length >= TENTATIVI_MAX) {
      throw errore(429, 'Troppi tentativi sbagliati: per questo utente da questo computer riprova tra 15 minuti, oppure chiedi all’amministratore una nuova password.');
    }
    throw errore(401, 'Nome utente o password non giusti.');
  }

  if (!locale) {
    if (recenti(this.fallitiPerIp[ctx.ip], adesso).length >= ERRORI_IP_MAX) {
      if (!this.ipSegnalati[ctx.ip]) {
        this.ipSegnalati[ctx.ip] = adesso;
        this.evento({ ip: ctx.ip }, 'accesso.bloccato-ip', {});
      }
      throw errore(429, 'Troppi tentativi da questo computer: riprova tra 15 minuti.');
    }
    if (valido && recenti(this.fallitiPerCoppia[coppia], adesso).length >= TENTATIVI_MAX) {
      throw errore(429, 'Troppi tentativi sbagliati: per questo utente da questo computer riprova tra 15 minuti, oppure chiedi all’amministratore una nuova password.');
    }
  }
  var db = this.db();
  var riga = valido ? db.prepare('SELECT * FROM utenti WHERE username = ?').get(username) : null;
  if (!riga) {
    hashPassword(password.slice(0, 200), SALE_FINTO);
    return fallito('utente inesistente', false);
  }
  if (!passwordGiusta(password, riga)) return fallito('password sbagliata', true);
  if (!riga.attivo) {
    this.evento({ ip: ctx.ip, username: username }, 'accesso.fallito', { utente: username, motivo: 'utente disattivato' });
    throw errore(403, 'Questo utente è disattivato. Rivolgiti all’amministratore.');
  }
  delete this.fallitiPerCoppia[coppia];
  var token = crypto.randomBytes(32).toString('base64url');
  var th = hashToken(token);
  this.database.transazioneAccessi(function () {
    db.prepare('UPDATE utenti SET tentativi = 0, bloccato_fino = 0, ultimo_accesso = ? WHERE id = ?').run(new Date(adesso).toISOString(), riga.id);
    db.prepare('INSERT INTO sessioni (token_hash, utente_id, creata, ultimo_uso, ip, agente) VALUES (?, ?, ?, ?, ?, ?)')
      .run(th, riga.id, adesso, adesso, ctx.ip || '', String(agente || '').slice(0, 300));
    // sessioni scadute di tutti: le tolgo qui, è un buon momento
    db.prepare('DELETE FROM sessioni WHERE ultimo_uso < ? OR creata < ?').run(adesso - INATTIVITA_MS, adesso - DURATA_MAX_MS);
  });
  var utente = this.utente(riga.id);
  this.evento({ utente: utente, ip: ctx.ip }, 'accesso.entrata', {});
  return { token: token, tokenHash: th, utente: utente };
};

/* Accesso d'emergenza da riga di comando sul server: nuova password provvisoria per un utente. */
Accessi.prototype.passwordEmergenza = function (username) {
  var riga = this.db().prepare('SELECT * FROM utenti WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!riga) throw errore(404, 'Utente "' + username + '" non trovato.');
  var provvisoria = crypto.randomBytes(9).toString('base64url');
  var pw = nuovaPassword(provvisoria);
  var self = this;
  this.database.transazioneAccessi(function () {
    self.db().prepare('UPDATE utenti SET hash = ?, sale = ?, cambio_password = 1, attivo = 1, tentativi = 0, bloccato_fino = 0 WHERE id = ?').run(pw.hash, pw.sale, riga.id);
    self.db().prepare('DELETE FROM sessioni WHERE utente_id = ?').run(riga.id);
  });
  this.evento({ ip: 'riga di comando sul server', username: riga.username }, 'utenti.password-emergenza', { utente: riga.username });
  return provvisoria;
};

/*
 * Utente della sessione o null. Aggiorna l'ultimo uso al massimo una volta al minuto,
 * tranne per le richieste automatiche (notifiche e sincronizzazione), che non contano come attività:
 * altrimenti una scheda lasciata aperta non scadrebbe mai per inattività.
 */
Accessi.prototype.sessione = function (token, automatica) {
  if (!token) return null;
  var th = hashToken(token);
  var db = this.db();
  var s = db.prepare('SELECT * FROM sessioni WHERE token_hash = ?').get(th);
  if (!s) return null;
  var adesso = Date.now();
  if (adesso - s.ultimo_uso > INATTIVITA_MS || adesso - s.creata > DURATA_MAX_MS) {
    db.prepare('DELETE FROM sessioni WHERE token_hash = ?').run(th);
    return null;
  }
  var utente = this.utente(s.utente_id);
  if (!utente || !utente.attivo) {
    db.prepare('DELETE FROM sessioni WHERE token_hash = ?').run(th);
    return null;
  }
  if (!automatica && adesso - s.ultimo_uso > 60000) db.prepare('UPDATE sessioni SET ultimo_uso = ? WHERE token_hash = ?').run(adesso, th);
  return { utente: utente, tokenHash: th };
};

Accessi.prototype.logout = function (ctx) {
  if (ctx.tokenHash) this.db().prepare('DELETE FROM sessioni WHERE token_hash = ?').run(ctx.tokenHash);
  this.evento(ctx, 'accesso.uscita', {});
};

module.exports = {
  Accessi: Accessi,
  RUOLI: RUOLI,
  permessi: permessi,
  puoScrivereReparto: puoScrivereReparto,
  errore: errore,
  nuovoId: nuovoId,
  INATTIVITA_MS: INATTIVITA_MS,
  DURATA_MAX_MS: DURATA_MAX_MS
};
