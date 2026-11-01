/*
 * Utenti, password, sessioni, ruoli e registro attività.
 * Versione 3.0 (parte C): verifica in due passaggi (2FA, codici TOTP come Google o Microsoft Authenticator),
 * codici di recupero, computer attendibili e criterio dell'amministratore (docs/NOVITA-3.0.md, "2FA").
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var Totp = require('../js/totp.js');

// id invariati dalla 2.x, etichette della 3.0 (docs/NOVITA-3.0.md)
var RUOLI = {
  amministratore: 'Amministratore',
  farmacista: 'Farmacista (farmacia centrale)',
  reparto: 'Responsabile di magazzino',
  consultazione: 'Direzione (sola lettura)'
};

var SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
var LUNGHEZZA_CHIAVE = 64;
var TENTATIVI_MAX = 5;
var BLOCCO_MS = 15 * 60 * 1000;
var INATTIVITA_MS = 8 * 60 * 60 * 1000;
var DURATA_MAX_MS = 14 * 60 * 60 * 1000;
var PASSWORD_MIN = 8;

/* ---------- verifica in due passaggi (2FA) ---------- */
var SFIDA_MS = 5 * 60 * 1000;                     // tempo per scrivere il codice dopo la password giusta
var DISPOSITIVO_MS = 30 * 24 * 60 * 60 * 1000;    // "Ricorda questo computer per 30 giorni"
var ATTIVAZIONE_MS = 60 * 60 * 1000;              // chiave mostrata nel QR e non ancora confermata
// codici sbagliati con la stessa sfida (anche dal server stesso, dove non c'è il blocco di 15 minuti): poi di nuovo la password
var ERRORI_SFIDA_MAX = 10;
var SFIDE_PER_COMPUTER = 3;                       // sfide valide insieme per lo stesso utente dallo stesso computer
// dal server stesso: dopo 20 codici sbagliati in 15 minuti per lo stesso utente, una sfida nuova ogni 30 secondi
// (un'attesa breve, mai un blocco: è l'accesso d'emergenza)
var ERRORI_SENZA_ATTESA = 20;
var ATTESA_LOCALE_MS = 30 * 1000;
// codici sbagliati per la stessa chiave mostrata nel QR: poi la chiave non vale più e si ricomincia
var ERRORI_ATTIVAZIONE_MAX = 10;
var CODICI_RECUPERO = 10;
var MAX_DISPOSITIVI_COOKIE = 5;                   // più utenti sullo stesso computer
var CRITERI_2FA = ['nessuno', 'amministratori', 'farmacisti', 'tutti'];
var FILE_CHIAVE = 'chiave-2fa.key';               // nella cartella dati: cifra i segreti TOTP in accessi.db
var ALFABETO_RECUPERO = '23456789abcdefghjkmnpqrstuvwxyz'; // niente 0/o, 1/l/i: si leggono senza dubbi

/* Errore con stato HTTP; "dati" (facoltativo) si aggiunge alla risposta JSON accanto a "errore". */
function errore(stato, messaggio, dati) {
  var e = new Error(messaggio);
  e.stato = stato;
  if (dati) e.dati = dati;
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
    // versione 3.0
    richieste: farm || rep,
    evadiRichieste: farm,
    ddt: farm || rep,
    riceviDdt: farm || rep,
    struttura: admin,
    assortimento: farm,
    ubicazioni: farm || rep,
    previsioni: true,
    ordini: farm,
    sistema: admin,
    sicurezza: admin,
    reparti: rep ? (utente.reparti || []).slice() : null
  };
}

function puoScrivereReparto(perm, repartoId) {
  return perm.reparti === null || perm.reparti.indexOf(repartoId) >= 0;
}

/* ---------- conversione ---------- */

/* Il criterio dell'amministratore chiede la verifica in due passaggi a questo ruolo? */
function obbligo2fa(ruolo, criterio) {
  if (criterio === 'tutti') return true;
  if (criterio === 'farmacisti') return ruolo === 'amministratore' || ruolo === 'farmacista';
  if (criterio === 'amministratori') return ruolo === 'amministratore';
  return false;
}

/*
 * Utente come lo vede il client. Campi della 3.0: dueFattori (verifica in due passaggi attiva),
 * dueFattoriObbligatoria (il criterio la chiede al suo ruolo), dueFattoriDaAttivare (obbligatoria e non ancora attiva:
 * la sessione serve solo ad attivarla, come la password provvisoria serve solo a cambiarla).
 */
function utenteDaRiga(r, criterio) {
  if (!r) return null;
  var reparti = [];
  try { reparti = JSON.parse(r.reparti || '[]'); } catch (e) { reparti = []; }
  var attiva = !!r.totp_attivo;
  var obbligatoria = obbligo2fa(r.ruolo, criterio);
  return {
    id: r.id, username: r.username, nome: r.nome, ruolo: r.ruolo, reparti: reparti,
    attivo: !!r.attivo, cambioPassword: !!r.cambio_password, ultimoAccesso: r.ultimo_accesso || null,
    bloccato: r.bloccato_fino > Date.now(),
    dueFattori: attiva, dueFattoriObbligatoria: obbligatoria, dueFattoriDaAttivare: obbligatoria && !attiva
  };
}

function listaJson(testo) {
  try {
    var l = JSON.parse(testo || '[]');
    return Array.isArray(l) ? l.filter(function (x) { return typeof x === 'string'; }) : [];
  } catch (e) { return []; }
}

function Accessi(database, log) {
  this.database = database;
  this.log = log || function () {};
  this.fallitiPerIp = {};      // ip -> [istanti degli errori]
  this.fallitiPerCoppia = {};  // 'utente|ip' -> [istanti degli errori]
  this.ipSegnalati = {};       // ip -> istante dell'ultimo evento "bloccato-ip" registrato
  this.erroriCambioPassword = {}; // hash della sessione -> numero di password attuali sbagliate
  // verifica in due passaggi
  this.sfide = {};             // hash della sfida -> { utenteId, ip, scade, creata, errori }: password giusta, manca il codice
  // id utente -> { segreto (byte), scade, sessione (hash del token), cambio, errori }: chiave mostrata nel QR, da confermare
  this.attivazioni = {};
  this.ultimoErrore2fa = {};   // id utente -> istante dell'ultimo codice sbagliato (gli errori vecchi non contano)
  // id utente -> { errori: [istanti dei codici sbagliati, ultimi 15 minuti], ultimaData }: rallenta le sfide dal server stesso
  this.erroriCodice = {};
  this.chiave = null;          // chiave AES-256 dei segreti TOTP (file nella cartella dati)
  this.criterioNoto = 'nessuno';
}

Accessi.prototype.db = function () { return this.database.accessi; };

/* Orologio (le prove lo sostituiscono per simulare il passare del tempo). */
Accessi.prototype.adesso = function () { return Date.now(); };

/* Criterio dell'amministratore (impostazione richiedi2fa nel database del magazzino). */
Accessi.prototype.criterio2fa = function () {
  try {
    // solo questa riga: le impostazioni intere contengono anche il logo, che può essere grande
    var r = this.database.dati.prepare("SELECT valore FROM impostazioni WHERE chiave = 'richiedi2fa'").get();
    var c = r ? JSON.parse(r.valore) : 'nessuno';
    this.criterioNoto = CRITERI_2FA.indexOf(c) >= 0 ? c : 'nessuno';
  } catch (e) { /* database del magazzino chiuso un attimo (ripristino di una copia): vale l'ultimo letto */ }
  return this.criterioNoto;
};

Accessi.prototype.contaUtenti = function () {
  return this.db().prepare('SELECT COUNT(*) n FROM utenti').get().n;
};

Accessi.prototype.utente = function (id) {
  return utenteDaRiga(this.db().prepare('SELECT * FROM utenti WHERE id = ?').get(id), this.criterio2fa());
};

Accessi.prototype.elencoUtenti = function () {
  var criterio = this.criterio2fa();
  return this.db().prepare('SELECT * FROM utenti ORDER BY nome COLLATE NOCASE').all().map(function (r) { return utenteDaRiga(r, criterio); });
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
    self.db().prepare('UPDATE utenti SET hash = ?, sale = ?, cambio_password = 1, tentativi = 0, tentativi_2fa = 0, bloccato_fino = 0 WHERE id = ?').run(pw.hash, pw.sale, id);
    self.db().prepare('DELETE FROM sessioni WHERE utente_id = ?').run(id);
  });
  delete this.ultimoErrore2fa[id];
  delete this.erroriCodice[id];
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

/*
 * Primo passo dell'accesso: nome utente e password.
 * opz.dispositivi: token dei "computer attendibili" letti dal cookie del browser.
 * Restituisce { token, tokenHash, utente } (sessione aperta) oppure, se l'utente ha la verifica in due passaggi
 * attiva e questo computer non è attendibile, { dueFattori: true, sfida } SENZA sessione: si continua con
 * loginDueFattori(sfida, codice).
 */
Accessi.prototype.login = function (ctx, username, password, agente, opz) {
  opz = opz || {};
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  var adesso = this.adesso();
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

  if (riga.totp_attivo) {
    // computer attendibile (cookie "Ricorda questo computer"): il codice non serve
    if (this.dispositivoAttendibile(riga.id, opz.dispositivi, adesso)) {
      return this.apriSessione(ctx, riga, agente, { dueFattori: 'computer attendibile' });
    }
    if (!locale && riga.bloccato_fino > adesso) throw errore(429, messaggioBlocco2fa(riga.bloccato_fino, adesso));
    if (locale) {
      // dal server stesso nessun blocco, ma dopo tanti codici sbagliati le sfide nuove arrivano piano
      var attesa = this.attesaSfidaLocale(riga.id, adesso, true);
      if (attesa > 0) {
        var secondi = Math.ceil(attesa / 1000);
        throw errore(429, 'Troppi codici sbagliati per questo utente: riprova tra ' + secondi + (secondi === 1 ? ' secondo' : ' secondi') +
          '. Controlla che l’ora del telefono sia giusta e scrivi il codice che l’app mostra in quel momento.', { attesaSecondi: secondi });
      }
    }
    return { dueFattori: true, sfida: this.nuovaSfida(riga.id, ctx.ip, adesso) };
  }
  return this.apriSessione(ctx, riga, agente, {});
};

/* Apre la sessione dell'utente (password giusta e, se serve, secondo fattore giusto). */
Accessi.prototype.apriSessione = function (ctx, riga, agente, dettagli) {
  var db = this.db();
  var adesso = this.adesso();
  var token = crypto.randomBytes(32).toString('base64url');
  var th = hashToken(token);
  this.database.transazioneAccessi(function () {
    db.prepare('UPDATE utenti SET tentativi = 0, bloccato_fino = 0, ultimo_accesso = ? WHERE id = ?').run(new Date(adesso).toISOString(), riga.id);
    db.prepare('INSERT INTO sessioni (token_hash, utente_id, creata, ultimo_uso, ip, agente) VALUES (?, ?, ?, ?, ?, ?)')
      .run(th, riga.id, adesso, adesso, ctx.ip || '', String(agente || '').slice(0, 300));
    // sessioni scadute di tutti: le tolgo qui, è un buon momento (e anche i computer attendibili scaduti)
    db.prepare('DELETE FROM sessioni WHERE ultimo_uso < ? OR creata < ?').run(adesso - INATTIVITA_MS, adesso - DURATA_MAX_MS);
    db.prepare('DELETE FROM dispositivi WHERE scade < ?').run(adesso);
  });
  var utente = this.utente(riga.id);
  this.evento({ utente: utente, ip: ctx.ip }, 'accesso.entrata', dettagli || {});
  return { token: token, tokenHash: th, utente: utente };
};

/* ---------- verifica in due passaggi: sfida, codici, computer attendibili ---------- */

function messaggioBlocco2fa(fino, adesso) {
  var minuti = Math.max(1, Math.ceil((fino - adesso) / 60000));
  return 'Troppi codici sbagliati: la verifica in due passaggi di questo utente è bloccata per ' + minuti +
    (minuti === 1 ? ' minuto' : ' minuti') + '. Riprova dopo, oppure chiedi aiuto all’amministratore.';
}

/*
 * Sfida: prova che la password era giusta. Vale 5 minuti, dallo stesso computer, si usa una volta sola e non vale più
 * dopo 10 codici sbagliati (anche dal server stesso: lì non c'è il blocco di 15 minuti, ma il codice non si può tirare
 * a indovinare con una password sola).
 */
Accessi.prototype.nuovaSfida = function (utenteId, ip, adesso) {
  this.pulisciSfide(adesso);
  var self = this;
  // al massimo 3 sfide valide insieme per lo stesso utente dallo stesso computer: la più vecchia non vale più
  // (altrimenti chi ha la password ne preparerebbe tante e proverebbe 10 codici con ognuna)
  var stesse = Object.keys(this.sfide).filter(function (k) { return self.sfide[k].utenteId === utenteId && self.sfide[k].ip === (ip || ''); })
    .sort(function (a, b) { return self.sfide[a].creata - self.sfide[b].creata; });
  stesse.slice(0, Math.max(0, stesse.length - SFIDE_PER_COMPUTER + 1)).forEach(function (k) { delete self.sfide[k]; });
  var sfida = crypto.randomBytes(24).toString('base64url');
  this.sfide[hashToken(sfida)] = { utenteId: utenteId, ip: ip || '', scade: adesso + SFIDA_MS, creata: adesso, errori: 0 };
  return sfida;
};

/*
 * Millisecondi da aspettare, dal server stesso, prima di una sfida nuova (0 = subito). Dopo 20 codici sbagliati per lo
 * stesso utente negli ultimi 15 minuti passano almeno 30 secondi fra l'ultimo errore (o l'ultima sfida data) e la sfida
 * dopo. Si contano i codici e non le sfide: le sfide tolte perché ne sono arrivate di nuove non servono a evitarlo.
 * Con prenota, se si può subito, segna l'istante: la sfida successiva aspetterà di nuovo.
 */
Accessi.prototype.attesaSfidaLocale = function (utenteId, adesso, prenota) {
  var st = this.erroriCodice[utenteId];
  if (!st) return 0;
  st.errori = recenti(st.errori, adesso);
  if (!st.errori.length) { delete this.erroriCodice[utenteId]; return 0; }
  if (st.errori.length < ERRORI_SENZA_ATTESA) return 0;
  var ultima = Math.max(st.errori[st.errori.length - 1], st.ultimaData || 0);
  var attesa = Math.max(0, ultima + ATTESA_LOCALE_MS - adesso);
  if (!attesa && prenota) st.ultimaData = adesso;
  return attesa;
};

Accessi.prototype.segnaCodiceSbagliato = function (utenteId, adesso) {
  var st = this.erroriCodice[utenteId] = this.erroriCodice[utenteId] || { errori: [], ultimaData: 0 };
  st.errori = recenti(st.errori, adesso);
  st.errori.push(adesso);
};

Accessi.prototype.pulisciSfide = function (adesso) {
  var self = this;
  var chiavi = Object.keys(this.sfide);
  chiavi.forEach(function (k) { if (self.sfide[k].scade <= adesso) delete self.sfide[k]; });
  // ogni sfida richiede la password giusta: tante insieme non ce ne sono, ma la memoria non deve crescere senza limiti
  chiavi = Object.keys(this.sfide);
  if (chiavi.length > 1000) {
    chiavi.sort(function (a, b) { return self.sfide[a].creata - self.sfide[b].creata; })
      .slice(0, chiavi.length - 1000).forEach(function (k) { delete self.sfide[k]; });
  }
  Object.keys(this.attivazioni).forEach(function (k) { if (self.attivazioni[k].scade <= adesso) delete self.attivazioni[k]; });
};

/* Token validi del cookie dei computer attendibili (al massimo 5, solo caratteri base64url). */
function tokenDispositivi(lista) {
  if (!Array.isArray(lista)) lista = String(lista || '').split('.');
  return lista.map(String).filter(function (t) { return /^[A-Za-z0-9_-]{20,100}$/.test(t); }).slice(0, MAX_DISPOSITIVI_COOKIE);
}

/* Hash del token se uno dei token del browser è un computer attendibile (non scaduto) di questo utente. */
Accessi.prototype.dispositivoAttendibile = function (utenteId, tokens, adesso) {
  var st = this.db().prepare('SELECT token_hash FROM dispositivi WHERE token_hash = ? AND utente_id = ? AND scade > ?');
  var lista = tokenDispositivi(tokens);
  for (var i = 0; i < lista.length; i++) {
    var th = hashToken(lista[i]);
    if (st.get(th, utenteId, adesso)) return th;
  }
  return null;
};

/*
 * Secondo passo dell'accesso: { sfida, codice | codiceRecupero, ricorda }.
 * Restituisce { token, tokenHash, utente, dispositivo?, codiciRimasti? }.
 * Errori: 401 sfida scaduta o già usata (si ricomincia dalla password), 400 codice sbagliato (si riprova con la
 * stessa sfida), 429 troppi codici sbagliati (5: blocco di 15 minuti, tranne che dal server stesso).
 * Dal server stesso non si blocca mai (accesso d'emergenza), ma dopo 10 codici sbagliati la sfida non vale più:
 * 401 { sfidaScaduta } e si riscrive la password. Così il codice non si indovina provandone milioni con una sfida sola.
 */
Accessi.prototype.loginDueFattori = function (ctx, dati, agente) {
  dati = dati || {};
  var adesso = this.adesso();
  this.pulisciSfide(adesso);
  var chiave = hashToken(String(dati.sfida || '').slice(0, 200));
  var sfida = this.sfide[chiave];
  var scaduta = errore(401, 'La verifica è scaduta: scrivi di nuovo nome utente e password.', { sfidaScaduta: true });
  if (!sfida || sfida.ip !== (ctx.ip || '')) throw scaduta;
  var db = this.db();
  var riga = db.prepare('SELECT * FROM utenti WHERE id = ?').get(sfida.utenteId);
  if (!riga || !riga.attivo || !riga.totp_attivo) { delete this.sfide[chiave]; throw scaduta; }
  var locale = !!ctx.locale;
  var conNome = { ip: ctx.ip, username: riga.username };
  if (!locale && riga.bloccato_fino > adesso) {
    delete this.sfide[chiave];
    throw errore(429, messaggioBlocco2fa(riga.bloccato_fino, adesso));
  }
  var esito = this.controllaSecondoFattore(riga, dati.codiceRecupero ? { codiceRecupero: dati.codiceRecupero } : { codice: dati.codice }, adesso);
  if (!esito.ok) {
    if (esito.motivo === 'gia-usato') {
      // lo stesso codice due volte (per esempio visto da qualcuno): non vale, ma non conta come tentativo
      this.evento(conNome, 'accesso.2fa.codice-riusato', { utente: riga.username });
      throw errore(400, 'Questo codice è già stato usato. Aspetta che l’app mostri il codice nuovo (cambia ogni 30 secondi) e scrivi quello.', { codiceUsato: true });
    }
    var n = 0;
    if (!locale) {
      var ultimo = this.ultimoErrore2fa[riga.id];
      // gli errori di più di 15 minuti fa non contano più (un codice sbagliato ogni tanto non deve bloccare nessuno)
      n = (ultimo && adesso - ultimo < BLOCCO_MS ? riga.tentativi_2fa : 0) + 1;
      this.ultimoErrore2fa[riga.id] = adesso;
      if (n >= TENTATIVI_MAX) {
        db.prepare('UPDATE utenti SET tentativi_2fa = 0, bloccato_fino = ? WHERE id = ?').run(adesso + BLOCCO_MS, riga.id);
        delete this.ultimoErrore2fa[riga.id];
        delete this.sfide[chiave];
        this.evento(conNome, 'accesso.2fa.bloccato', { utente: riga.username, tentativi: n });
        throw errore(429, messaggioBlocco2fa(adesso + BLOCCO_MS, adesso));
      }
      db.prepare('UPDATE utenti SET tentativi_2fa = ? WHERE id = ?').run(n, riga.id);
    }
    sfida.errori = (sfida.errori || 0) + 1;
    this.segnaCodiceSbagliato(riga.id, adesso);
    this.evento(conNome, 'accesso.2fa.fallito', { utente: riga.username, tipo: esito.tipo, tentativo: n || sfida.errori });
    if (sfida.errori >= ERRORI_SFIDA_MAX) {
      // anche dal server stesso: la sfida non vale più, si riscrive la password (niente blocco: resta l'accesso d'emergenza)
      delete this.sfide[chiave];
      this.evento(conNome, 'accesso.2fa.sfida-annullata', { utente: riga.username, codiciSbagliati: sfida.errori, daServer: locale });
      throw errore(401, 'Troppi codici sbagliati: per sicurezza scrivi di nuovo nome utente e password, poi il codice che mostra l’app adesso.', { sfidaScaduta: true });
    }
    var rimasti = locale ? null : TENTATIVI_MAX - n;
    throw errore(400, esito.tipo === 'recupero'
      ? 'Questo codice di recupero non è giusto o è già stato usato.' + (rimasti !== null ? ' Tentativi rimasti: ' + rimasti + '.' : '')
      : 'Il codice non è giusto. Controlla di leggere il codice di questo programma nell’app e che l’ora del telefono sia giusta.' +
        (rimasti !== null ? ' Tentativi rimasti: ' + rimasti + '.' : ''), rimasti !== null ? { tentativiRimasti: rimasti } : null);
  }
  // giusto: la sfida non vale più, il passo usato nemmeno (niente codici ripetuti)
  delete this.sfide[chiave];
  delete this.ultimoErrore2fa[riga.id];
  delete this.erroriCodice[riga.id];
  var dispositivo = null;
  var self = this;
  this.database.transazioneAccessi(function () {
    if (esito.tipo === 'codice') db.prepare('UPDATE utenti SET totp_ultimo_passo = ?, tentativi_2fa = 0 WHERE id = ?').run(esito.passo, riga.id);
    else db.prepare('UPDATE utenti SET codici_recupero = ?, tentativi_2fa = 0 WHERE id = ?').run(JSON.stringify(esito.codici), riga.id);
    if (dati.ricorda) {
      dispositivo = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO dispositivi (token_hash, utente_id, creato, scade, ip, agente) VALUES (?, ?, ?, ?, ?, ?)')
        .run(hashToken(dispositivo), riga.id, adesso, adesso + DISPOSITIVO_MS, ctx.ip || '', String(agente || '').slice(0, 300));
    }
  });
  if (esito.tipo === 'recupero') this.evento(conNome, 'accesso.2fa.recupero', { utente: riga.username, codiciRimasti: esito.codici.length });
  if (dispositivo) self.evento(conNome, 'accesso.2fa.ricorda-computer', { utente: riga.username, giorni: DISPOSITIVO_MS / 86400000 });
  var s = this.apriSessione(ctx, riga, agente, { dueFattori: esito.tipo === 'codice' ? 'codice' : 'codice di recupero' });
  s.dispositivo = dispositivo;
  if (esito.tipo === 'recupero') s.codiciRimasti = esito.codici.length;
  return s;
};

/*
 * Controlla il secondo fattore di un utente con la 2FA attiva.
 * dati: { codice } (6 cifre dell'app; un testo con lettere si prova come codice di recupero) oppure { codiceRecupero }.
 * → { ok: true, tipo: 'codice', passo } | { ok: true, tipo: 'recupero', codici: [hash rimasti] }
 *   | { ok: false, tipo, motivo: 'sbagliato' | 'gia-usato' }
 */
Accessi.prototype.controllaSecondoFattore = function (riga, dati, adesso) {
  var codice = String(dati.codice === undefined || dati.codice === null ? '' : dati.codice).slice(0, 100);
  var recupero = dati.codiceRecupero !== undefined && dati.codiceRecupero !== null && dati.codiceRecupero !== ''
    ? String(dati.codiceRecupero).slice(0, 100)
    : (/[a-z]/i.test(codice) ? codice : null);
  if (recupero !== null) {
    var codici = listaJson(riga.codici_recupero);
    var i = codici.indexOf(hashRecupero(riga.id, recupero));
    if (i < 0) return { ok: false, tipo: 'recupero', motivo: 'sbagliato' };
    codici.splice(i, 1);
    return { ok: true, tipo: 'recupero', codici: codici };
  }
  var segreto = this.decifraSegreto(riga);
  var passo = Totp.verifica(segreto, codice, adesso, { finestra: 1, ultimoPasso: riga.totp_ultimo_passo || 0 });
  if (passo >= 0) return { ok: true, tipo: 'codice', passo: passo };
  if (Totp.verifica(segreto, codice, adesso, { finestra: 1 }) >= 0) return { ok: false, tipo: 'codice', motivo: 'gia-usato' };
  return { ok: false, tipo: 'codice', motivo: 'sbagliato' };
};

/* ---------- segreti cifrati (AES-256-GCM, chiave in un file della cartella dati) ---------- */

/*
 * La chiave sta in <dati>/chiave-2fa.key (32 byte casuali in base64), creata al primo uso e leggibile solo dal
 * servizio. Senza questo file i segreti in accessi.db non servono a niente: chi copia solo accessi.db non può
 * calcolare i codici. Un file presente ma rovinato NON si sostituisce (i segreti diventerebbero illeggibili per sempre).
 */
Accessi.prototype.chiaveSegreti = function () {
  if (this.chiave) return this.chiave;
  var file = path.join(this.database.cartella, FILE_CHIAVE);
  var testo = null;
  try { testo = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (testo === null) {
    var nuova = crypto.randomBytes(32);
    try {
      fs.writeFileSync(file, nuova.toString('base64') + '\n', { mode: 384 /* 0600 */, flag: 'wx' });
      this.log('Creata la chiave della verifica in due passaggi: ' + file);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    testo = fs.readFileSync(file, 'utf8'); // anche se un altro processo l'ha creata un attimo prima
  }
  var chiave = Buffer.from(String(testo).trim(), 'base64');
  if (chiave.length !== 32) {
    this.log('File ' + file + ' non valido: la verifica in due passaggi non si può controllare.');
    throw errore(500, 'Il file della chiave della verifica in due passaggi (' + FILE_CHIAVE + ' nella cartella dati) è rovinato. Rimettilo da una copia di sicurezza della cartella dati.');
  }
  this.chiave = chiave;
  return chiave;
};

function cifra(chiave, utenteId, segreto) {
  var iv = crypto.randomBytes(12);
  var c = crypto.createCipheriv('aes-256-gcm', chiave, iv);
  c.setAAD(Buffer.from('totp:' + utenteId)); // il segreto cifrato vale solo per il suo utente
  var dati = Buffer.concat([c.update(Buffer.from(segreto)), c.final()]);
  return 'v1.' + iv.toString('base64url') + '.' + c.getAuthTag().toString('base64url') + '.' + dati.toString('base64url');
}

Accessi.prototype.cifraSegreto = function (utenteId, segreto) {
  return cifra(this.chiaveSegreti(), utenteId, segreto);
};

Accessi.prototype.decifraSegreto = function (riga) {
  var parti = String(riga.totp_segreto || '').split('.');
  try {
    if (parti.length !== 4 || parti[0] !== 'v1') throw new Error('formato');
    var d = crypto.createDecipheriv('aes-256-gcm', this.chiaveSegreti(), Buffer.from(parti[1], 'base64url'));
    d.setAAD(Buffer.from('totp:' + riga.id));
    d.setAuthTag(Buffer.from(parti[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parti[3], 'base64url')), d.final()]);
  } catch (e) {
    if (e.stato) throw e;
    this.log('Segreto TOTP di ' + riga.username + ' non leggibile: ' + e.message);
    throw errore(409, 'La verifica in due passaggi di questo utente non si può controllare: la chiave del server è cambiata (cartella dati copiata senza il file ' +
      FILE_CHIAVE + '?). Chiedi all’amministratore di azzerarla, poi attivala di nuovo.');
  }
};

/* ---------- codici di recupero ---------- */

function nuovoCodiceRecupero() {
  var s = '';
  for (var i = 0; i < 10; i++) s += ALFABETO_RECUPERO.charAt(crypto.randomInt(ALFABETO_RECUPERO.length));
  return s.slice(0, 5) + '-' + s.slice(5);
}

/* Codice scritto dall'utente → hash salvato (maiuscole, spazi e trattini non contano). */
function hashRecupero(utenteId, codice) {
  var pulito = String(codice || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return crypto.createHash('sha256').update('recupero:' + utenteId + ':' + pulito).digest('hex');
}

function nuoviCodiciRecupero(utenteId) {
  var chiari = [];
  while (chiari.length < CODICI_RECUPERO) {
    var c = nuovoCodiceRecupero();
    if (chiari.indexOf(c) < 0) chiari.push(c);
  }
  return { chiari: chiari, hash: chiari.map(function (c) { return hashRecupero(utenteId, c); }) };
}

/* ---------- verifica in due passaggi: gestione dal proprio account ---------- */

Accessi.prototype.riga = function (id) {
  var r = this.db().prepare('SELECT * FROM utenti WHERE id = ?').get(id);
  if (!r) throw errore(404, 'Utente non trovato.');
  return r;
};

function contaDispositivi(db, utenteId, adesso) {
  return db.prepare('SELECT COUNT(*) n FROM dispositivi WHERE utente_id = ? AND scade > ?').get(utenteId, adesso).n;
}

/* Stato della 2FA dell'utente collegato (GET /api/2fa). */
Accessi.prototype.stato2fa = function (utenteId) {
  var r = this.riga(utenteId);
  var adesso = this.adesso();
  var u = utenteDaRiga(r, this.criterio2fa());
  return {
    attiva: u.dueFattori,
    attivataIl: r.totp_attivato_il || null,
    obbligatoria: u.dueFattoriObbligatoria,
    daAttivare: u.dueFattoriDaAttivare,
    criterio: this.criterio2fa(),
    codiciRimasti: u.dueFattori ? listaJson(r.codici_recupero).length : 0,
    dispositivi: contaDispositivi(this.db(), utenteId, adesso),
    giorniDispositivo: DISPOSITIVO_MS / 86400000,
    oraServer: new Date(adesso).toISOString()
  };
};

/*
 * Primo passo dell'attivazione (o del cambio di telefono): una chiave nuova da inquadrare con l'app.
 * Finché non si conferma con un codice resta solo in memoria (un'ora); la 2FA già attiva continua a valere.
 *
 * Cambio di telefono (2FA già attiva): serve la password, come per disattivarla o creare codici di recupero nuovi.
 * Altrimenti chi ruba una sessione aperta collegherebbe il suo telefono, si terrebbe 10 codici di recupero e chiuderebbe
 * fuori l'utente vero. Le password sbagliate contano come nel cambio password (5 chiudono la sessione); la chiave nuova
 * vale solo per la sessione che ha scritto la password.
 * Prima attivazione: la password non serve di nuovo. Non sostituisce un secondo fattore che c'era già (senza 2FA basta la
 * password per entrare) e chi la deve attivare per il criterio dell'amministratore l'ha appena scritta per entrare: la sua
 * sessione serve solo a questo.
 */
Accessi.prototype.inizia2fa = function (ctx, emittente, password) {
  var r = this.riga(ctx.utente.id);
  var adesso = this.adesso();
  this.pulisciSfide(adesso);
  var cambio = !!r.totp_attivo;
  if (cambio) {
    // password mancante (programma vecchio nel browser): non è un tentativo, non conta fra gli errori
    if (password === undefined || password === null || password === '') {
      throw errore(400, 'Per collegare un telefono nuovo scrivi la tua password.', { servePassword: true });
    }
    this.controllaPasswordSessione(ctx, password, 'accesso.2fa.cambio-telefono');
    delete this.erroriCambioPassword[ctx.tokenHash];
  }
  var segreto = crypto.randomBytes(20);
  this.attivazioni[r.id] = { segreto: segreto, scade: adesso + ATTIVAZIONE_MS, sessione: ctx.tokenHash || '', cambio: cambio, errori: 0 };
  var base32 = Totp.base32Codifica(segreto);
  return {
    segretoBase32: base32,
    chiave: Totp.formattaChiave(base32),
    uri: Totp.uriOtpauth({ emittente: emittente, utente: r.username, segretoBase32: base32 }),
    emittente: emittente,
    utente: r.username,
    cambio: cambio,
    oraServer: new Date(adesso).toISOString()
  };
};

/*
 * Conferma dell'attivazione con il primo codice dell'app: da qui la 2FA vale.
 * Restituisce i 10 codici di recupero in chiaro (si vedono solo adesso). Le altre sessioni dell'utente si chiudono.
 * Con la 2FA già attiva (cambio di telefono) vale solo una chiave chiesta con la password da questa stessa sessione.
 * 10 codici sbagliati per la stessa chiave: la chiave non vale più (409 ricomincia), così non si indovina.
 */
Accessi.prototype.conferma2fa = function (ctx, codice) {
  var r = this.riga(ctx.utente.id);
  var adesso = this.adesso();
  this.pulisciSfide(adesso);
  var att = this.attivazioni[r.id];
  if (!att) throw errore(409, 'La chiave mostrata non vale più (è passata più di un’ora o il server è stato riavviato). Ricomincia: il programma ne mostrerà una nuova.', { ricomincia: true });
  // la chiave vale solo per la sessione che l'ha chiesta (per il cambio di telefono, quella che ha scritto la password)
  if (att.sessione !== (ctx.tokenHash || '')) {
    throw errore(409, 'Questa chiave è stata chiesta da un’altra finestra o da un altro computer. Ricomincia da qui: il programma mostrerà un codice QR nuovo.', { ricomincia: true });
  }
  if (r.totp_attivo && !att.cambio) {
    // chiave chiesta senza password quando la 2FA non era attiva, e nel frattempo è stata attivata: non vale per cambiare telefono
    throw errore(409, 'La verifica in due passaggi è già attiva: per collegare un telefono nuovo serve la tua password. Ricomincia da «Cambia telefono».', { ricomincia: true, servePassword: true });
  }
  var passo = Totp.verifica(att.segreto, codice, adesso, { finestra: 1 });
  if (passo < 0) {
    // stessa pulizia di Totp.verifica: ogni testo che potrebbe essere un codice conta come tentativo
    var formatoGiusto = /^\d{6}$/.test(String(codice === undefined || codice === null ? '' : codice).replace(/[\s-]+/g, ''));
    if (formatoGiusto) att.errori = (att.errori || 0) + 1;
    if (att.errori >= ERRORI_ATTIVAZIONE_MAX) {
      delete this.attivazioni[r.id];
      this.evento(ctx, 'accesso.2fa.chiave-annullata', { codiciSbagliati: att.errori, cambio: !!r.totp_attivo });
      throw errore(409, 'Troppi codici sbagliati: per sicurezza quella chiave non vale più. Togli dall’app il collegamento appena aggiunto e ricomincia: il programma mostrerà un codice QR nuovo.', { ricomincia: true });
    }
    throw errore(400, formatoGiusto
      ? 'Il codice non è giusto. Controlla di aver inquadrato il codice QR qui sopra (o scritto bene la chiave) e che l’ora del telefono sia impostata in automatico.'
      : 'Scrivi le 6 cifre che mostra l’app.');
  }
  var segretoCifrato = this.cifraSegreto(r.id, att.segreto);
  var codici = nuoviCodiciRecupero(r.id);
  var db = this.db();
  var giaAttiva = !!r.totp_attivo;
  this.database.transazioneAccessi(function () {
    db.prepare('UPDATE utenti SET totp_segreto = ?, totp_attivo = 1, totp_attivato_il = ?, totp_ultimo_passo = ?, codici_recupero = ?, tentativi_2fa = 0 WHERE id = ?')
      .run(segretoCifrato, new Date(adesso).toISOString(), passo, JSON.stringify(codici.hash), r.id);
    // le altre sessioni sono state aperte senza il secondo fattore: si chiudono
    db.prepare('DELETE FROM sessioni WHERE utente_id = ? AND token_hash != ?').run(r.id, ctx.tokenHash || '');
  });
  delete this.attivazioni[r.id];
  // i codici sbagliati di prima erano per la chiave vecchia: non contano più (anche dopo --reimposta-password, che gira in un
  // altro processo e non può pulire la memoria di questo)
  delete this.ultimoErrore2fa[r.id];
  delete this.erroriCodice[r.id];
  this.evento(ctx, giaAttiva ? 'accesso.2fa.riconfigurata' : 'accesso.2fa.attivata', { codiciRecupero: CODICI_RECUPERO });
  return { codiciRecupero: codici.chiari, utente: this.utente(r.id) };
};

/*
 * Password attuale giusta? Con una sessione rubata non si deve poter indovinare la password (o il codice) all'infinito:
 * 5 errori chiudono la sessione, come nel cambio password.
 */
Accessi.prototype.controllaPasswordSessione = function (ctx, password, azione) {
  var riga = this.riga(ctx.utente.id);
  if (passwordGiusta(String(password || '').slice(0, 200), riga)) return riga;
  this.erroreSessione(ctx, azione, 'La password non è giusta.');
};

Accessi.prototype.erroreSessione = function (ctx, azione, messaggio) {
  var n = (this.erroriCambioPassword[ctx.tokenHash] || 0) + 1;
  this.erroriCambioPassword[ctx.tokenHash] = n;
  this.evento(ctx, azione + '-fallito', { tentativo: n });
  if (n >= TENTATIVI_MAX) {
    delete this.erroriCambioPassword[ctx.tokenHash];
    this.db().prepare('DELETE FROM sessioni WHERE token_hash = ?').run(ctx.tokenHash || '');
    throw errore(401, 'Troppi errori: per sicurezza la sessione è stata chiusa. Accedi di nuovo.');
  }
  throw errore(400, messaggio);
};

/* Disattiva la propria 2FA: servono password e codice (dell'app o di recupero). Non se il criterio la richiede. */
Accessi.prototype.disattiva2fa = function (ctx, password, codice) {
  var r = this.riga(ctx.utente.id);
  if (!r.totp_attivo) throw errore(409, 'La verifica in due passaggi non è attiva.');
  if (obbligo2fa(r.ruolo, this.criterio2fa())) {
    throw errore(409, 'L’amministratore richiede la verifica in due passaggi per il tuo ruolo: non si può disattivare. Se hai cambiato telefono usa «Cambia telefono».');
  }
  this.controllaPasswordSessione(ctx, password, 'accesso.2fa.disattiva');
  var esito = this.controllaSecondoFattore(r, { codice: codice }, this.adesso());
  if (!esito.ok) this.erroreSessione(ctx, 'accesso.2fa.disattiva', esito.motivo === 'gia-usato' ? 'Questo codice è già stato usato: aspetta il codice nuovo nell’app.' : 'Il codice non è giusto.');
  delete this.erroriCambioPassword[ctx.tokenHash];
  this.azzera(r.id);
  this.evento(ctx, 'accesso.2fa.disattivata', {});
  return { utente: this.utente(r.id) };
};

/* Toglie segreto, codici di recupero e computer attendibili. */
Accessi.prototype.azzera = function (utenteId) {
  var db = this.db();
  var tolti = 0;
  this.database.transazioneAccessi(function () {
    db.prepare("UPDATE utenti SET totp_segreto = '', totp_attivo = 0, totp_attivato_il = NULL, totp_ultimo_passo = 0, codici_recupero = '[]', tentativi_2fa = 0, bloccato_fino = 0 WHERE id = ?").run(utenteId);
    tolti = Number(db.prepare('DELETE FROM dispositivi WHERE utente_id = ?').run(utenteId).changes) || 0;
  });
  delete this.attivazioni[utenteId];
  delete this.ultimoErrore2fa[utenteId];
  delete this.erroriCodice[utenteId];
  var self = this;
  Object.keys(this.sfide).forEach(function (k) { if (self.sfide[k].utenteId === utenteId) delete self.sfide[k]; });
  return tolti;
};

/* Nuovi codici di recupero (quelli vecchi non valgono più): serve la password. */
Accessi.prototype.nuoviCodici2fa = function (ctx, password) {
  var r = this.riga(ctx.utente.id);
  if (!r.totp_attivo) throw errore(409, 'Prima attiva la verifica in due passaggi.');
  this.controllaPasswordSessione(ctx, password, 'accesso.2fa.nuovi-codici');
  delete this.erroriCambioPassword[ctx.tokenHash];
  var codici = nuoviCodiciRecupero(r.id);
  this.db().prepare('UPDATE utenti SET codici_recupero = ? WHERE id = ?').run(JSON.stringify(codici.hash), r.id);
  this.evento(ctx, 'accesso.2fa.nuovi-codici', { codiciRecupero: CODICI_RECUPERO });
  return { codiciRecupero: codici.chiari };
};

/* Dimentica tutti i computer attendibili dell'utente collegato. */
Accessi.prototype.dimenticaDispositivi = function (ctx) {
  var n = Number(this.db().prepare('DELETE FROM dispositivi WHERE utente_id = ?').run(ctx.utente.id).changes) || 0;
  this.evento(ctx, 'accesso.2fa.dimentica-computer', { computer: n });
  return { ok: true, tolti: n };
};

/* ---------- verifica in due passaggi: amministratore ---------- */

/* Utenti con lo stato della 2FA (GET /api/sicurezza). */
Accessi.prototype.statoSicurezza = function () {
  var criterio = this.criterio2fa();
  var adesso = this.adesso();
  var db = this.db();
  var disp = {};
  db.prepare('SELECT utente_id, COUNT(*) n FROM dispositivi WHERE scade > ? GROUP BY utente_id').all(adesso).forEach(function (x) { disp[x.utente_id] = x.n; });
  var utenti = db.prepare('SELECT * FROM utenti ORDER BY nome COLLATE NOCASE').all().map(function (r) {
    var u = utenteDaRiga(r, criterio);
    return {
      id: u.id, username: u.username, nome: u.nome, ruolo: u.ruolo, attivo: u.attivo,
      dueFattori: u.dueFattori, attivataIl: r.totp_attivato_il || null,
      obbligatoria: u.dueFattoriObbligatoria, daAttivare: u.dueFattoriDaAttivare,
      codiciRimasti: u.dueFattori ? listaJson(r.codici_recupero).length : 0,
      dispositivi: disp[u.id] || 0,
      ultimoAccesso: u.ultimoAccesso, bloccato: u.bloccato
    };
  });
  return { richiedi2fa: criterio, criteri: CRITERI_2FA.slice(), utenti: utenti, oraServer: new Date(adesso).toISOString() };
};

/* Utenti attivi che con questo criterio dovrebbero attivare la 2FA e non l'hanno ancora fatto. */
Accessi.prototype.utentiDaAttivare = function (criterio) {
  return this.db().prepare('SELECT * FROM utenti WHERE attivo = 1 AND totp_attivo = 0').all()
    .filter(function (r) { return obbligo2fa(r.ruolo, criterio); })
    .map(function (r) { return r.id; });
};

/* L'amministratore azzera la 2FA di un utente (telefono perso): al prossimo accesso basta la password. */
Accessi.prototype.azzera2fa = function (ctx, utenteId) {
  var r = this.riga(utenteId);
  var aveva = !!r.totp_attivo;
  var computer = this.azzera(r.id);
  // le sessioni aperte dell'utente si chiudono (tranne quella di chi sta azzerando, se è la sua)
  this.db().prepare('DELETE FROM sessioni WHERE utente_id = ? AND token_hash != ?').run(r.id, ctx.tokenHash || '');
  this.evento(ctx, 'accesso.2fa.azzerata', { utente: r.username, eraAttiva: aveva, computer: computer });
  return { utente: this.utente(r.id) };
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
  // chi usa l'accesso d'emergenza spesso ha perso anche il telefono: la verifica in due passaggi si azzera
  // (se il criterio la richiede, al prossimo accesso il programma guida a riattivarla)
  var aveva2fa = !!riga.totp_attivo;
  this.azzera(riga.id);
  this.evento({ ip: 'riga di comando sul server', username: riga.username }, 'utenti.password-emergenza', { utente: riga.username, dueFattoriAzzerata: aveva2fa });
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
  var adesso = this.adesso();
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
  obbligo2fa: obbligo2fa,
  tokenDispositivi: tokenDispositivi,
  CRITERI_2FA: CRITERI_2FA,
  INATTIVITA_MS: INATTIVITA_MS,
  DURATA_MAX_MS: DURATA_MAX_MS,
  SFIDA_MS: SFIDA_MS,
  DISPOSITIVO_MS: DISPOSITIVO_MS,
  MAX_DISPOSITIVI_COOKIE: MAX_DISPOSITIVI_COOKIE
};
