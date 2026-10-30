/*
 * Database SQLite del server (modulo integrato node:sqlite).
 *
 * Due file nella cartella dati:
 *   farmacia.db  dati di magazzino: impostazioni, reparti, articoli, movimenti
 *   accessi.db   utenti, sessioni e registro attività
 * Sono separati perché il ripristino di una copia riguarda solo il magazzino:
 * utenti e registro attività restano quelli attuali.
 *
 * Ogni scrittura sul magazzino incrementa la revisione globale (meta.rev) e la scrive nelle
 * righe toccate: i client chiedono "cosa è cambiato dopo la revisione N".
 */
'use strict';

// node:sqlite stampa un avviso "experimental" a ogni avvio: lo nascondo
var emitOriginale = process.emitWarning;
process.emitWarning = function (avviso) {
  var testo = typeof avviso === 'string' ? avviso : (avviso && avviso.message) || '';
  if (/SQLite is an experimental feature/.test(testo)) return;
  return emitOriginale.apply(process, arguments);
};

var DatabaseSync = require('node:sqlite').DatabaseSync;
var path = require('path');
var fs = require('fs');

var VERSIONE_SCHEMA_DATI = 1;
var VERSIONE_SCHEMA_ACCESSI = 1;

var IMPOSTAZIONI_PREDEFINITE = {
  struttura: 'Clinica Posillipo',
  sottotitolo: 'Longevity Institute',
  societa: 'ME.MI. SRL',
  citta: 'NAPOLI',
  logo: '',
  giorniAvvisoScadenza: 90,
  codiceModulo: 'PRQ 1501.4EV.1'
};

var REPARTI_PREDEFINITI = [
  { id: 'r-farmacia', nome: 'Farmacia', centrale: true },
  { id: 'r-degenza', nome: 'Degenza' },
  { id: 'r-sala', nome: 'Sala operatoria' },
  { id: 'r-ambulatori', nome: 'Ambulatori' }
];

function apriFile(file) {
  var db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return db;
}

function versioneSchema(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function creaSchemaDati(db) {
  if (versioneSchema(db) >= VERSIONE_SCHEMA_DATI) return;
  db.exec([
    'CREATE TABLE IF NOT EXISTS meta (chiave TEXT PRIMARY KEY, valore TEXT NOT NULL);',
    'CREATE TABLE IF NOT EXISTS impostazioni (chiave TEXT PRIMARY KEY, valore TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0);',
    'CREATE TABLE IF NOT EXISTS reparti (',
    '  id TEXT PRIMARY KEY, nome TEXT NOT NULL, centrale INTEGER NOT NULL DEFAULT 0, attivo INTEGER NOT NULL DEFAULT 1,',
    '  ordine INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0);',
    'CREATE TABLE IF NOT EXISTS articoli (',
    '  id TEXT PRIMARY KEY, nome TEXT NOT NULL COLLATE NOCASE UNIQUE, categoria TEXT NOT NULL,',
    "  unita TEXT NOT NULL DEFAULT '', principio TEXT NOT NULL DEFAULT '', confezione TEXT NOT NULL DEFAULT '',",
    "  codice TEXT NOT NULL DEFAULT '', prezzo REAL NOT NULL DEFAULT 0, scorta_minima REAL NOT NULL DEFAULT 0,",
    "  note TEXT NOT NULL DEFAULT '', attivo INTEGER NOT NULL DEFAULT 1, versione INTEGER NOT NULL DEFAULT 1,",
    '  rev INTEGER NOT NULL DEFAULT 0);',
    'CREATE TABLE IF NOT EXISTS movimenti (',
    '  id TEXT PRIMARY KEY, tipo TEXT NOT NULL, data TEXT NOT NULL,',
    '  articolo_id TEXT NOT NULL REFERENCES articoli(id), reparto_id TEXT NOT NULL REFERENCES reparti(id),',
    '  reparto_dest_id TEXT REFERENCES reparti(id), quantita REAL NOT NULL,',
    "  lotto TEXT NOT NULL DEFAULT '', scadenza TEXT NOT NULL DEFAULT '', fornitore TEXT NOT NULL DEFAULT '',",
    "  documento TEXT NOT NULL DEFAULT '', causale TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',",
    "  prezzo REAL, operatore TEXT NOT NULL DEFAULT '', utente_id TEXT, creato INTEGER NOT NULL,",
    '  annullato_il TEXT, annullato_da TEXT, annullato_motivo TEXT, rev INTEGER NOT NULL DEFAULT 0);',
    'CREATE INDEX IF NOT EXISTS movimenti_articolo ON movimenti(articolo_id, data);',
    'CREATE INDEX IF NOT EXISTS movimenti_rev ON movimenti(rev);',
    'CREATE INDEX IF NOT EXISTS movimenti_data ON movimenti(data);',
    'CREATE INDEX IF NOT EXISTS articoli_rev ON articoli(rev);',
    'CREATE TABLE IF NOT EXISTS cancellati (tabella TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (tabella, id));'
  ].join('\n'));
  var ins = db.prepare('INSERT OR IGNORE INTO meta (chiave, valore) VALUES (?, ?)');
  ins.run('rev', '1');
  ins.run('rev_base', '0');
  ins.run('creato', new Date().toISOString());
  var imp = db.prepare('INSERT OR IGNORE INTO impostazioni (chiave, valore, rev) VALUES (?, ?, 1)');
  Object.keys(IMPOSTAZIONI_PREDEFINITE).forEach(function (k) { imp.run(k, JSON.stringify(IMPOSTAZIONI_PREDEFINITE[k])); });
  var rep = db.prepare('INSERT OR IGNORE INTO reparti (id, nome, centrale, attivo, ordine, rev) VALUES (?, ?, ?, 1, ?, 1)');
  REPARTI_PREDEFINITI.forEach(function (r, i) { rep.run(r.id, r.nome, r.centrale ? 1 : 0, i); });
  db.exec('PRAGMA user_version = ' + VERSIONE_SCHEMA_DATI);
}

function creaSchemaAccessi(db) {
  if (versioneSchema(db) >= VERSIONE_SCHEMA_ACCESSI) return;
  db.exec([
    'CREATE TABLE IF NOT EXISTS utenti (',
    '  id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, nome TEXT NOT NULL, ruolo TEXT NOT NULL,',
    "  reparti TEXT NOT NULL DEFAULT '[]', hash TEXT NOT NULL, sale TEXT NOT NULL, attivo INTEGER NOT NULL DEFAULT 1,",
    '  cambio_password INTEGER NOT NULL DEFAULT 0, tentativi INTEGER NOT NULL DEFAULT 0, bloccato_fino INTEGER NOT NULL DEFAULT 0,',
    '  creato TEXT NOT NULL, ultimo_accesso TEXT);',
    'CREATE TABLE IF NOT EXISTS sessioni (',
    '  token_hash TEXT PRIMARY KEY, utente_id TEXT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,',
    "  creata INTEGER NOT NULL, ultimo_uso INTEGER NOT NULL, ip TEXT NOT NULL DEFAULT '', agente TEXT NOT NULL DEFAULT '');",
    'CREATE INDEX IF NOT EXISTS sessioni_utente ON sessioni(utente_id);',
    'CREATE TABLE IF NOT EXISTS eventi (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT, quando TEXT NOT NULL, utente_id TEXT, username TEXT NOT NULL DEFAULT \'\',',
    "  azione TEXT NOT NULL, dettagli TEXT NOT NULL DEFAULT '{}', ip TEXT NOT NULL DEFAULT '');",
    'CREATE INDEX IF NOT EXISTS eventi_quando ON eventi(quando);'
  ].join('\n'));
  db.exec('PRAGMA user_version = ' + VERSIONE_SCHEMA_ACCESSI);
}

/* ---------- conversione righe <-> oggetti del client ---------- */

function articoloDaRiga(r) {
  return {
    id: r.id, nome: r.nome, categoria: r.categoria, unita: r.unita, principio: r.principio, confezione: r.confezione,
    codice: r.codice, prezzo: r.prezzo, scortaMinima: r.scorta_minima, note: r.note, attivo: !!r.attivo, versione: r.versione
  };
}

function repartoDaRiga(r) {
  return { id: r.id, nome: r.nome, centrale: !!r.centrale, attivo: !!r.attivo };
}

function movimentoDaRiga(r) {
  return {
    id: r.id, tipo: r.tipo, data: r.data, articoloId: r.articolo_id, repartoId: r.reparto_id,
    repartoDestId: r.reparto_dest_id || undefined, quantita: r.quantita, lotto: r.lotto, scadenza: r.scadenza,
    fornitore: r.fornitore, documento: r.documento, causale: r.causale, note: r.note,
    prezzo: r.prezzo === null ? undefined : r.prezzo, operatore: r.operatore, utenteId: r.utente_id || undefined,
    creato: r.creato,
    annullato: r.annullato_il ? { il: r.annullato_il, da: r.annullato_da || '', motivo: r.annullato_motivo || '' } : null
  };
}

/* ---------- apertura ---------- */

function Database(cartella) {
  this.cartella = cartella;
  this.fileDati = path.join(cartella, 'farmacia.db');
  this.fileAccessi = path.join(cartella, 'accessi.db');
  this.apri();
}

Database.prototype.apri = function () {
  fs.mkdirSync(this.cartella, { recursive: true });
  this.dati = apriFile(this.fileDati);
  creaSchemaDati(this.dati);
  // "storia" del magazzino: cambia a ogni avvio e a ogni ripristino. I browser che la trovano diversa
  // ricaricano tutto invece dei soli cambiamenti: così anche il ripristino di una copia della cartella
  // dati (per esempio dal backup della macchina virtuale) non mescola due storie diverse.
  this.storia = require('crypto').randomBytes(8).toString('hex');
  if (!this.accessi) {
    this.accessi = apriFile(this.fileAccessi);
    creaSchemaAccessi(this.accessi);
  }
};

Database.prototype.chiudiDati = function () {
  if (this.dati) { this.dati.close(); this.dati = null; }
};

Database.prototype.chiudi = function () {
  this.chiudiDati();
  if (this.accessi) { this.accessi.close(); this.accessi = null; }
};

/* Esegue fn in una transazione del magazzino con una nuova revisione: fn(rev) */
Database.prototype.scrivi = function (fn) {
  var db = this.dati;
  db.exec('BEGIN IMMEDIATE');
  try {
    var rev = Number(db.prepare("SELECT valore FROM meta WHERE chiave = 'rev'").get().valore) + 1;
    db.prepare("UPDATE meta SET valore = ? WHERE chiave = 'rev'").run(String(rev));
    var risultato = fn(rev);
    db.exec('COMMIT');
    return { rev: rev, risultato: risultato };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* già chiusa */ }
    throw e;
  }
};

Database.prototype.transazioneAccessi = function (fn) {
  var db = this.accessi;
  db.exec('BEGIN IMMEDIATE');
  try {
    var r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* già chiusa */ }
    throw e;
  }
};

Database.prototype.meta = function (chiave) {
  var r = this.dati.prepare('SELECT valore FROM meta WHERE chiave = ?').get(chiave);
  return r ? r.valore : null;
};

Database.prototype.impostaMeta = function (chiave, valore) {
  this.dati.prepare('INSERT INTO meta (chiave, valore) VALUES (?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore').run(chiave, String(valore));
};

Database.prototype.rev = function () { return Number(this.meta('rev')); };

Database.prototype.impostazioni = function () {
  var out = {};
  Object.keys(IMPOSTAZIONI_PREDEFINITE).forEach(function (k) { out[k] = IMPOSTAZIONI_PREDEFINITE[k]; });
  this.dati.prepare('SELECT chiave, valore FROM impostazioni').all().forEach(function (r) {
    try { out[r.chiave] = JSON.parse(r.valore); } catch (e) { /* valore illeggibile: resta il predefinito */ }
  });
  return out;
};

Database.prototype.reparti = function () {
  return this.dati.prepare('SELECT * FROM reparti ORDER BY ordine, nome').all().map(repartoDaRiga);
};

Database.prototype.reparto = function (id) {
  var r = this.dati.prepare('SELECT * FROM reparti WHERE id = ?').get(id);
  return r ? repartoDaRiga(r) : null;
};

Database.prototype.articolo = function (id) {
  var r = this.dati.prepare('SELECT * FROM articoli WHERE id = ?').get(id);
  return r ? articoloDaRiga(r) : null;
};

Database.prototype.articoloPerNome = function (nome) {
  var r = this.dati.prepare('SELECT * FROM articoli WHERE nome = ? COLLATE NOCASE').get(String(nome).trim());
  return r ? articoloDaRiga(r) : null;
};

Database.prototype.movimentiArticolo = function (articoloId) {
  return this.dati.prepare('SELECT * FROM movimenti WHERE articolo_id = ? ORDER BY data, creato').all(articoloId).map(movimentoDaRiga);
};

Database.prototype.movimento = function (id) {
  var r = this.dati.prepare('SELECT * FROM movimenti WHERE id = ?').get(id);
  return r ? movimentoDaRiga(r) : null;
};

Database.prototype.contaMagazzino = function () {
  return {
    articoli: this.dati.prepare('SELECT COUNT(*) n FROM articoli').get().n,
    movimenti: this.dati.prepare('SELECT COUNT(*) n FROM movimenti').get().n
  };
};

/*
 * Cambiamenti dopo la revisione `da`. Se `da` è 0, precede l'ultimo ripristino (rev_base)
 * o è oltre la revisione attuale, restituisce tutto con completo: true.
 */
Database.prototype.cambiamenti = function (da, storia) {
  var rev = this.rev();
  var base = Number(this.meta('rev_base') || 0);
  da = Number(da) || 0;
  var completo = da <= 0 || da < base || da > rev || (storia !== undefined && storia !== null && storia !== this.storia);
  var soglia = completo ? -1 : da;
  var db = this.dati;
  var out = {
    rev: rev,
    storia: this.storia,
    completo: completo,
    reparti: db.prepare('SELECT * FROM reparti WHERE rev > ? ORDER BY ordine, nome').all(soglia).map(repartoDaRiga),
    articoli: db.prepare('SELECT * FROM articoli WHERE rev > ?').all(soglia).map(articoloDaRiga),
    movimenti: db.prepare('SELECT * FROM movimenti WHERE rev > ? ORDER BY data, creato').all(soglia).map(movimentoDaRiga),
    cancellati: completo ? [] : db.prepare('SELECT tabella, id FROM cancellati WHERE rev > ?').all(soglia).map(function (r) { return { tabella: r.tabella, id: r.id }; })
  };
  var impCambiate = db.prepare('SELECT COUNT(*) n FROM impostazioni WHERE rev > ?').get(soglia).n;
  if (completo || impCambiate) out.impostazioni = this.impostazioni();
  return out;
};

module.exports = {
  Database: Database,
  articoloDaRiga: articoloDaRiga,
  repartoDaRiga: repartoDaRiga,
  movimentoDaRiga: movimentoDaRiga,
  IMPOSTAZIONI_PREDEFINITE: IMPOSTAZIONI_PREDEFINITE,
  REPARTI_PREDEFINITI: REPARTI_PREDEFINITI
};
