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

var VERSIONE_SCHEMA_DATI = 3; // 2: codici a barre e pezzi per confezione; 3: magazzini, armadi, assortimento, richieste, DDT (versione 3.0)
var VERSIONE_SCHEMA_ACCESSI = 2; // 2: autenticazione a due fattori (versione 3.0)

var IMPOSTAZIONI_PREDEFINITE = {
  nomeProdotto: 'NefroCenter Pharmacy',
  sigla: 'NC Pharmacy',
  struttura: 'Clinica Posillipo',
  sottotitolo: 'Longevity Institute · Gruppo NefroCenter',
  societa: 'ME.MI. SRL',
  citta: 'NAPOLI',
  logo: '',
  giorniAvvisoScadenza: 90,
  codiceModulo: 'PRQ 1501.4EV.1',
  // versione 3.0 (docs/NOVITA-3.0.md)
  coloreAccento: '',
  tema: 'automatico',
  leadTimeGiorni: 7,
  periodoRevisioneGiorni: 7,
  livelloServizio: 0.95,
  storicoGiorni: 180,
  richiedi2fa: 'nessuno'
};

// magazzino di sistema per la merce in viaggio fra due magazzini (DDT partiti e non ancora ricevuti)
var ID_TRANSITO = 'r-transito';

// piano e livello dei reparti predefiniti, per le installazioni che arrivano dalla 2.x
var PIANI_PREDEFINITI = {
  'r-farmacia': { piano: 'Piano terra', livello: 0 },
  'r-degenza': { piano: '1° piano', livello: 1 },
  'r-sala': { piano: '1° piano', livello: 1 },
  'r-ambulatori': { piano: 'Piano terra', livello: 0 }
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
  var versione = versioneSchema(db);
  if (versione >= VERSIONE_SCHEMA_DATI) return;
  if (versione < 1) creaSchemaDatiV1(db);
  aggiornaSchemaDati(db);
}

function creaSchemaDatiV1(db) {
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
  db.exec('PRAGMA user_version = 1');
}

/*
 * Aggiornamenti dello schema del magazzino, uno dopo l'altro. Valgono per i database nuovi, per quelli
 * della versione precedente (all'apertura) e per le copie di sicurezza vecchie che si ripristinano.
 */
function aggiornaSchemaDati(db) {
  if (versioneSchema(db) < 2) {
    // versione 2: codici a barre (array JSON di chiavi normalizzate, vedi js/barcode.js) e pezzi per confezione
    db.exec('BEGIN IMMEDIATE');
    try {
      var colonne = db.prepare('PRAGMA table_info(articoli)').all().map(function (c) { return c.name; });
      if (colonne.indexOf('barcode') < 0) db.exec("ALTER TABLE articoli ADD COLUMN barcode TEXT NOT NULL DEFAULT '[]'");
      if (colonne.indexOf('pezzi_confezione') < 0) db.exec('ALTER TABLE articoli ADD COLUMN pezzi_confezione REAL NOT NULL DEFAULT 1');
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* già chiusa */ }
      throw e;
    }
  }
  if (versioneSchema(db) < 3) {
    // versione 3: magazzini (centrale, periferici, in transito), armadi, assortimento, richieste e DDT interni
    db.exec('BEGIN IMMEDIATE');
    try {
      var colRep = db.prepare('PRAGMA table_info(reparti)').all().map(function (c) { return c.name; });
      if (colRep.indexOf('tipo') < 0) db.exec("ALTER TABLE reparti ADD COLUMN tipo TEXT NOT NULL DEFAULT 'periferico'");
      if (colRep.indexOf('piano') < 0) db.exec("ALTER TABLE reparti ADD COLUMN piano TEXT NOT NULL DEFAULT ''");
      if (colRep.indexOf('livello') < 0) db.exec('ALTER TABLE reparti ADD COLUMN livello INTEGER NOT NULL DEFAULT 0');
      if (colRep.indexOf('colore') < 0) db.exec("ALTER TABLE reparti ADD COLUMN colore TEXT NOT NULL DEFAULT ''");
      if (colRep.indexOf('descrizione') < 0) db.exec("ALTER TABLE reparti ADD COLUMN descrizione TEXT NOT NULL DEFAULT ''");
      db.exec("UPDATE reparti SET tipo = CASE WHEN centrale = 1 THEN 'centrale' ELSE 'periferico' END WHERE tipo <> 'transito'");
      var piano = db.prepare("UPDATE reparti SET piano = ?, livello = ? WHERE id = ? AND piano = ''");
      Object.keys(PIANI_PREDEFINITI).forEach(function (id) { piano.run(PIANI_PREDEFINITI[id].piano, PIANI_PREDEFINITI[id].livello, id); });
      var revAttuale = Number((db.prepare("SELECT valore FROM meta WHERE chiave = 'rev'").get() || { valore: '1' }).valore) || 1;
      db.prepare("INSERT OR IGNORE INTO reparti (id, nome, centrale, attivo, ordine, rev, tipo, piano, livello, descrizione) " +
        "VALUES (?, 'In transito', 0, 1, 9999, ?, 'transito', '', 0, 'Merce partita con un DDT e non ancora ricevuta')").run(ID_TRANSITO, revAttuale);

      var colArt = db.prepare('PRAGMA table_info(articoli)').all().map(function (c) { return c.name; });
      if (colArt.indexOf('attributi') < 0) db.exec("ALTER TABLE articoli ADD COLUMN attributi TEXT NOT NULL DEFAULT '[]'");
      if (colArt.indexOf('lead_time') < 0) db.exec('ALTER TABLE articoli ADD COLUMN lead_time REAL');
      if (colArt.indexOf('fornitore') < 0) db.exec("ALTER TABLE articoli ADD COLUMN fornitore TEXT NOT NULL DEFAULT ''");

      var colMov = db.prepare('PRAGMA table_info(movimenti)').all().map(function (c) { return c.name; });
      if (colMov.indexOf('ddt_id') < 0) db.exec('ALTER TABLE movimenti ADD COLUMN ddt_id TEXT');

      db.exec([
        'CREATE INDEX IF NOT EXISTS movimenti_ddt ON movimenti(ddt_id);',
        'CREATE INDEX IF NOT EXISTS movimenti_reparto ON movimenti(reparto_id, data);',
        'CREATE INDEX IF NOT EXISTS reparti_rev ON reparti(rev);',
        'CREATE TABLE IF NOT EXISTS armadi (',
        '  id TEXT PRIMARY KEY, reparto_id TEXT NOT NULL REFERENCES reparti(id), nome TEXT NOT NULL,',
        "  tipo TEXT NOT NULL DEFAULT 'armadio', ripiani INTEGER NOT NULL DEFAULT 4, colonne INTEGER NOT NULL DEFAULT 6,",
        "  ordine INTEGER NOT NULL DEFAULT 0, colore TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',",
        '  attivo INTEGER NOT NULL DEFAULT 1, rev INTEGER NOT NULL DEFAULT 0);',
        'CREATE INDEX IF NOT EXISTS armadi_reparto ON armadi(reparto_id);',
        'CREATE INDEX IF NOT EXISTS armadi_rev ON armadi(rev);',
        'CREATE TABLE IF NOT EXISTS assortimento (',
        '  id TEXT PRIMARY KEY, reparto_id TEXT NOT NULL REFERENCES reparti(id), articolo_id TEXT NOT NULL REFERENCES articoli(id),',
        '  scorta_min REAL NOT NULL DEFAULT 0, punto_riordino REAL NOT NULL DEFAULT 0, scorta_max REAL NOT NULL DEFAULT 0,',
        '  armadio_id TEXT REFERENCES armadi(id) ON DELETE SET NULL, ripiano INTEGER, posizione INTEGER,',
        "  note TEXT NOT NULL DEFAULT '', attivo INTEGER NOT NULL DEFAULT 1, rev INTEGER NOT NULL DEFAULT 0,",
        '  UNIQUE (reparto_id, articolo_id));',
        'CREATE INDEX IF NOT EXISTS assortimento_rev ON assortimento(rev);',
        'CREATE INDEX IF NOT EXISTS assortimento_armadio ON assortimento(armadio_id);',
        'CREATE TABLE IF NOT EXISTS richieste (',
        '  id TEXT PRIMARY KEY, numero TEXT NOT NULL UNIQUE, anno INTEGER NOT NULL, progressivo INTEGER NOT NULL,',
        '  reparto_id TEXT NOT NULL REFERENCES reparti(id), fornitore_id TEXT NOT NULL REFERENCES reparti(id),',
        "  stato TEXT NOT NULL DEFAULT 'bozza', urgente INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',",
        "  creata_da TEXT, creata_da_nome TEXT NOT NULL DEFAULT '', creata_il TEXT NOT NULL, inviata_il TEXT,",
        "  presa_da TEXT, presa_da_nome TEXT NOT NULL DEFAULT '', presa_il TEXT,",
        "  chiusa_il TEXT, chiusa_da TEXT, chiusa_da_nome TEXT NOT NULL DEFAULT '', motivo TEXT NOT NULL DEFAULT '',",
        '  rev INTEGER NOT NULL DEFAULT 0);',
        'CREATE INDEX IF NOT EXISTS richieste_rev ON richieste(rev);',
        'CREATE INDEX IF NOT EXISTS richieste_stato ON richieste(stato, reparto_id);',
        'CREATE TABLE IF NOT EXISTS richieste_righe (',
        '  id TEXT PRIMARY KEY, richiesta_id TEXT NOT NULL REFERENCES richieste(id) ON DELETE CASCADE,',
        '  articolo_id TEXT NOT NULL REFERENCES articoli(id), quantita REAL NOT NULL, approvata REAL,',
        "  nota TEXT NOT NULL DEFAULT '', ordine INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0);",
        'CREATE INDEX IF NOT EXISTS richieste_righe_richiesta ON richieste_righe(richiesta_id);',
        'CREATE INDEX IF NOT EXISTS richieste_righe_rev ON richieste_righe(rev);',
        'CREATE TABLE IF NOT EXISTS ddt (',
        '  id TEXT PRIMARY KEY, numero TEXT NOT NULL UNIQUE, anno INTEGER NOT NULL, progressivo INTEGER NOT NULL,',
        '  origine_id TEXT NOT NULL REFERENCES reparti(id), destinazione_id TEXT NOT NULL REFERENCES reparti(id),',
        "  richiesta_id TEXT REFERENCES richieste(id), stato TEXT NOT NULL DEFAULT 'in_preparazione',",
        "  causale TEXT NOT NULL DEFAULT 'Trasferimento interno', colli INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '',",
        "  preparato_da TEXT, preparato_da_nome TEXT NOT NULL DEFAULT '', preparato_il TEXT NOT NULL,",
        "  trasportatore_id TEXT, trasportatore_nome TEXT NOT NULL DEFAULT '', partito_il TEXT,",
        "  ricevuto_da TEXT, ricevuto_da_nome TEXT NOT NULL DEFAULT '', ricevuto_il TEXT, note_ricezione TEXT NOT NULL DEFAULT '',",
        "  annullato_il TEXT, annullato_da TEXT, motivo_annullo TEXT NOT NULL DEFAULT '', rev INTEGER NOT NULL DEFAULT 0);",
        'CREATE INDEX IF NOT EXISTS ddt_rev ON ddt(rev);',
        'CREATE INDEX IF NOT EXISTS ddt_stato ON ddt(stato, destinazione_id);',
        'CREATE INDEX IF NOT EXISTS ddt_richiesta ON ddt(richiesta_id);',
        'CREATE TABLE IF NOT EXISTS ddt_righe (',
        '  id TEXT PRIMARY KEY, ddt_id TEXT NOT NULL REFERENCES ddt(id) ON DELETE CASCADE,',
        '  articolo_id TEXT NOT NULL REFERENCES articoli(id), richiesta_riga_id TEXT REFERENCES richieste_righe(id),',
        "  lotto TEXT NOT NULL DEFAULT '', scadenza TEXT NOT NULL DEFAULT '', quantita REAL NOT NULL, ricevuta REAL,",
        "  esito TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '', ordine INTEGER NOT NULL DEFAULT 0,",
        '  rev INTEGER NOT NULL DEFAULT 0);',
        'CREATE INDEX IF NOT EXISTS ddt_righe_ddt ON ddt_righe(ddt_id);',
        'CREATE INDEX IF NOT EXISTS ddt_righe_rev ON ddt_righe(rev);',
        'CREATE INDEX IF NOT EXISTS ddt_righe_riga ON ddt_righe(richiesta_riga_id);'
      ].join('\n'));
      db.exec('PRAGMA user_version = 3');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* già chiusa */ }
      throw e;
    }
  }
}

function creaSchemaAccessi(db) {
  if (versioneSchema(db) >= VERSIONE_SCHEMA_ACCESSI) return;
  if (versioneSchema(db) >= 1) { aggiornaSchemaAccessi(db); return; }
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
  aggiornaSchemaAccessi(db);
}

/* Aggiornamenti dello schema degli accessi (anche per i database della versione precedente). */
function aggiornaSchemaAccessi(db) {
  if (versioneSchema(db) < 2) {
    // versione 2: autenticazione a due fattori (TOTP) e dispositivi attendibili
    db.exec('BEGIN IMMEDIATE');
    try {
      var col = db.prepare('PRAGMA table_info(utenti)').all().map(function (c) { return c.name; });
      if (col.indexOf('totp_segreto') < 0) db.exec("ALTER TABLE utenti ADD COLUMN totp_segreto TEXT NOT NULL DEFAULT ''");
      if (col.indexOf('totp_attivo') < 0) db.exec('ALTER TABLE utenti ADD COLUMN totp_attivo INTEGER NOT NULL DEFAULT 0');
      if (col.indexOf('totp_attivato_il') < 0) db.exec('ALTER TABLE utenti ADD COLUMN totp_attivato_il TEXT');
      if (col.indexOf('totp_ultimo_passo') < 0) db.exec('ALTER TABLE utenti ADD COLUMN totp_ultimo_passo INTEGER NOT NULL DEFAULT 0');
      if (col.indexOf('codici_recupero') < 0) db.exec("ALTER TABLE utenti ADD COLUMN codici_recupero TEXT NOT NULL DEFAULT '[]'");
      if (col.indexOf('tentativi_2fa') < 0) db.exec('ALTER TABLE utenti ADD COLUMN tentativi_2fa INTEGER NOT NULL DEFAULT 0');
      db.exec([
        'CREATE TABLE IF NOT EXISTS dispositivi (',
        '  token_hash TEXT PRIMARY KEY, utente_id TEXT NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,',
        "  creato INTEGER NOT NULL, scade INTEGER NOT NULL, ip TEXT NOT NULL DEFAULT '', agente TEXT NOT NULL DEFAULT '');",
        'CREATE INDEX IF NOT EXISTS dispositivi_utente ON dispositivi(utente_id);'
      ].join('\n'));
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* già chiusa */ }
      throw e;
    }
  }
}

/* ---------- conversione righe <-> oggetti del client ---------- */

function codiciDaTesto(testo) {
  try {
    var l = JSON.parse(testo || '[]');
    return Array.isArray(l) ? l.filter(function (k) { return typeof k === 'string'; }) : [];
  } catch (e) { return []; }
}

function articoloDaRiga(r) {
  return {
    id: r.id, nome: r.nome, categoria: r.categoria, unita: r.unita, principio: r.principio, confezione: r.confezione,
    codice: r.codice, prezzo: r.prezzo, scortaMinima: r.scorta_minima, note: r.note, attivo: !!r.attivo, versione: r.versione,
    barcode: codiciDaTesto(r.barcode), pezziConfezione: r.pezzi_confezione > 0 ? r.pezzi_confezione : 1,
    attributi: codiciDaTesto(r.attributi), leadTime: r.lead_time === null || r.lead_time === undefined ? null : r.lead_time,
    fornitore: r.fornitore || ''
  };
}

function repartoDaRiga(r) {
  return {
    id: r.id, nome: r.nome, centrale: !!r.centrale, attivo: !!r.attivo, ordine: r.ordine,
    tipo: r.tipo || (r.centrale ? 'centrale' : 'periferico'), piano: r.piano || '', livello: r.livello || 0,
    colore: r.colore || '', descrizione: r.descrizione || ''
  };
}

function nullo(v) { return v === undefined ? null : v; }

function armadioDaRiga(r) {
  return {
    id: r.id, repartoId: r.reparto_id, nome: r.nome, tipo: r.tipo, ripiani: r.ripiani, colonne: r.colonne,
    ordine: r.ordine, colore: r.colore, note: r.note, attivo: !!r.attivo
  };
}

function assortimentoDaRiga(r) {
  return {
    id: r.id, repartoId: r.reparto_id, articoloId: r.articolo_id, scortaMin: r.scorta_min, puntoRiordino: r.punto_riordino,
    scortaMax: r.scorta_max, armadioId: nullo(r.armadio_id), ripiano: nullo(r.ripiano), posizione: nullo(r.posizione),
    note: r.note, attivo: !!r.attivo
  };
}

function richiestaDaRiga(r) {
  return {
    id: r.id, numero: r.numero, anno: r.anno, progressivo: r.progressivo, repartoId: r.reparto_id, fornitoreId: r.fornitore_id,
    stato: r.stato, urgente: !!r.urgente, note: r.note, creataDa: nullo(r.creata_da), creataDaNome: r.creata_da_nome,
    creataIl: r.creata_il, inviataIl: nullo(r.inviata_il), presaDa: nullo(r.presa_da), presaDaNome: r.presa_da_nome,
    presaIl: nullo(r.presa_il), chiusaIl: nullo(r.chiusa_il), chiusaDa: nullo(r.chiusa_da), chiusaDaNome: r.chiusa_da_nome,
    motivo: r.motivo
  };
}

function richiestaRigaDaRiga(r) {
  return {
    id: r.id, richiestaId: r.richiesta_id, articoloId: r.articolo_id, quantita: r.quantita, approvata: nullo(r.approvata),
    nota: r.nota, ordine: r.ordine
  };
}

function ddtDaRiga(r) {
  return {
    id: r.id, numero: r.numero, anno: r.anno, progressivo: r.progressivo, origineId: r.origine_id, destinazioneId: r.destinazione_id,
    richiestaId: nullo(r.richiesta_id), stato: r.stato, causale: r.causale, colli: r.colli, note: r.note,
    preparatoDa: nullo(r.preparato_da), preparatoDaNome: r.preparato_da_nome, preparatoIl: r.preparato_il,
    trasportatoreId: nullo(r.trasportatore_id), trasportatoreNome: r.trasportatore_nome, partitoIl: nullo(r.partito_il),
    ricevutoDa: nullo(r.ricevuto_da), ricevutoDaNome: r.ricevuto_da_nome, ricevutoIl: nullo(r.ricevuto_il),
    noteRicezione: r.note_ricezione, annullatoIl: nullo(r.annullato_il), annullatoDa: nullo(r.annullato_da),
    motivoAnnullo: r.motivo_annullo
  };
}

function ddtRigaDaRiga(r) {
  return {
    id: r.id, ddtId: r.ddt_id, articoloId: r.articolo_id, richiestaRigaId: nullo(r.richiesta_riga_id), lotto: r.lotto,
    scadenza: r.scadenza, quantita: r.quantita, ricevuta: nullo(r.ricevuta), esito: r.esito, nota: r.nota, ordine: r.ordine
  };
}

/*
 * Tabelle sincronizzate con i browser (/api/dati): chiave in App.S, tabella SQL, ordinamento, conversione.
 * Nelle cancellazioni (tabella "cancellati") si usa la chiave di App.S.
 */
var TABELLE_SYNC = [
  { chiave: 'reparti', tabella: 'reparti', ordine: 'ordine, nome', daRiga: repartoDaRiga },
  { chiave: 'articoli', tabella: 'articoli', ordine: '', daRiga: articoloDaRiga },
  { chiave: 'movimenti', tabella: 'movimenti', ordine: 'data, creato', daRiga: movimentoDaRiga },
  { chiave: 'armadi', tabella: 'armadi', ordine: 'reparto_id, ordine, nome', daRiga: armadioDaRiga },
  { chiave: 'assortimento', tabella: 'assortimento', ordine: '', daRiga: assortimentoDaRiga },
  { chiave: 'richieste', tabella: 'richieste', ordine: 'anno, progressivo', daRiga: richiestaDaRiga },
  { chiave: 'richiesteRighe', tabella: 'richieste_righe', ordine: 'richiesta_id, ordine', daRiga: richiestaRigaDaRiga },
  { chiave: 'ddt', tabella: 'ddt', ordine: 'anno, progressivo', daRiga: ddtDaRiga },
  { chiave: 'ddtRighe', tabella: 'ddt_righe', ordine: 'ddt_id, ordine', daRiga: ddtRigaDaRiga }
];

function movimentoDaRiga(r) {
  return {
    id: r.id, tipo: r.tipo, data: r.data, articoloId: r.articolo_id, repartoId: r.reparto_id,
    repartoDestId: r.reparto_dest_id || undefined, quantita: r.quantita, lotto: r.lotto, scadenza: r.scadenza,
    fornitore: r.fornitore, documento: r.documento, causale: r.causale, note: r.note,
    prezzo: r.prezzo === null ? undefined : r.prezzo, operatore: r.operatore, utenteId: r.utente_id || undefined,
    creato: r.creato,
    annullato: r.annullato_il ? { il: r.annullato_il, da: r.annullato_da || '', motivo: r.annullato_motivo || '' } : null,
    ddtId: r.ddt_id || null
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
  var rev;
  var risultato;
  try {
    rev = Number(db.prepare("SELECT valore FROM meta WHERE chiave = 'rev'").get().valore) + 1;
    db.prepare("UPDATE meta SET valore = ? WHERE chiave = 'rev'").run(String(rev));
    risultato = fn(rev);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* già chiusa */ }
    throw e;
  }
  // dopo il commit: chi ascolta (per esempio il giornale delle modifiche) riceve la revisione appena scritta
  var self = this;
  (this.ascoltatoriScrittura || []).forEach(function (f) {
    try { f({ rev: rev }); } catch (e) { if (self.log) self.log('Errore dopo la scrittura: ' + (e && e.message)); }
  });
  return { rev: rev, risultato: risultato };
};

/* Registra fn({ rev }) da chiamare dopo ogni scrittura riuscita del magazzino. */
Database.prototype.dopoScrittura = function (fn) {
  if (!this.ascoltatoriScrittura) this.ascoltatoriScrittura = [];
  this.ascoltatoriScrittura.push(fn);
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

/* Articolo che ha già il codice a barre `chiave` (escluso eventualmente `tranneId`), oppure null. */
Database.prototype.articoloConCodice = function (chiave, tranneId) {
  var r = this.dati.prepare('SELECT a.* FROM articoli a, json_each(a.barcode) j WHERE j.value = ? AND a.id <> ? LIMIT 1')
    .get(String(chiave), String(tranneId || ''));
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
    completo: completo
  };
  TABELLE_SYNC.forEach(function (t) {
    out[t.chiave] = db.prepare('SELECT * FROM ' + t.tabella + ' WHERE rev > ?' + (t.ordine ? ' ORDER BY ' + t.ordine : '')).all(soglia).map(t.daRiga);
  });
  out.cancellati = completo ? [] : db.prepare('SELECT tabella, id FROM cancellati WHERE rev > ?').all(soglia).map(function (r) { return { tabella: r.tabella, id: r.id }; });
  var impCambiate = db.prepare('SELECT COUNT(*) n FROM impostazioni WHERE rev > ?').get(soglia).n;
  if (completo || impCambiate) out.impostazioni = this.impostazioni();
  return out;
};

module.exports = {
  Database: Database,
  articoloDaRiga: articoloDaRiga,
  repartoDaRiga: repartoDaRiga,
  movimentoDaRiga: movimentoDaRiga,
  armadioDaRiga: armadioDaRiga,
  assortimentoDaRiga: assortimentoDaRiga,
  richiestaDaRiga: richiestaDaRiga,
  richiestaRigaDaRiga: richiestaRigaDaRiga,
  ddtDaRiga: ddtDaRiga,
  ddtRigaDaRiga: ddtRigaDaRiga,
  TABELLE_SYNC: TABELLE_SYNC,
  ID_TRANSITO: ID_TRANSITO,
  IMPOSTAZIONI_PREDEFINITE: IMPOSTAZIONI_PREDEFINITE,
  REPARTI_PREDEFINITI: REPARTI_PREDEFINITI
};
