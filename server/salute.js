/*
 * Versione 3.0 – parte E (docs/NOVITA-3.0.md): base dati che si cura da sola.
 *
 *  - all'avvio, PRIMA di aprire il database per l'uso: controllo rapido (PRAGMA quick_check) di farmacia.db e
 *    accessi.db. Un file danneggiato (o illeggibile, o sparito) si sposta in dati/danneggiati/ con la data e si cura:
 *      1. recupero dal file stesso (VACUUM INTO, se SQLite riesce ancora a leggerlo tutto) più il giornale;
 *      2. copia valida più recente più il giornale delle modifiche riapplicato dalla sua revisione in poi;
 *      3. (magazzino) archivio vuoto più tutto il giornale, se il giornale c'è dall'inizio;
 *    si tiene la ricostruzione che arriva più avanti (a parità, copia + giornale: è fatta solo di dati verificati),
 *    poi controllo di integrità completo, evento nel registro attività e messaggio nel registro del server;
 *  - dopo uno spegnimento improvviso il magazzino può aver perso le ultime scritture (WAL non ancora sul disco,
 *    perso o con la testata rovinata): si riapplicano dal giornale, che si scrive con fsync. Il giornale è la fonte di
 *    verità: le segnalazioni 'avvio' e 'chiusura' (WAL riversato nel file) dicono fin dove il file era sicuramente
 *    arrivato, così una coda persa si distingue da un file rimesso a mano da una copia vecchia;
 *  - quello che il giornale ha e il magazzino no (e non si può riapplicare) è una cura "con perdite" (semaforo rosso),
 *    mai un silenzio; i numeri di richieste e DDT già dati non tornano liberi;
 *  - il resoconto di una cura si confronta anche con il registro attività: scritture registrate lì ma assenti dal
 *    giornale sono perdite da controllare;
 *  - ogni notte: controllo completo (integrity_check), PRAGMA optimize, pulizia del WAL; se il magazzino risulta
 *    danneggiato mentre il programma è acceso si ricostruisce subito (copia + giornale), se si può farlo senza perdite;
 *  - copie automatiche orarie (server/backup.js), "prova di ripristino" su richiesta, stato per la pagina Sistema.
 *
 * Rotte (permesso 'sistema', solo amministratore):
 *   GET  /api/sistema                    stato completo (vedi Salute.prototype.stato)
 *   POST /api/sistema/controlla          controllo completo adesso → { controllo, sistema }
 *   POST /api/sistema/copia              copia verificata di magazzino e accessi adesso → { copie, sistema }
 *   POST /api/sistema/prova-ripristino   ricostruisce in una cartella temporanea ultima copia + giornale e la confronta
 *                                        con il database attuale → { prova, sistema }
 *   PUT  /api/sistema/seconda-cartella   { percorso } ('' = nessuna) → { seconda, sistema }
 */
'use strict';

var fs = require('fs');
var path = require('path');
var DatabaseSync = require('node:sqlite').DatabaseSync;
var D = require('./db.js');
var G = require('./giornale.js');
var B = require('./backup.js');
var errore = require('./accessi.js').errore;

var FILE = ['farmacia', 'accessi'];
var FILE_STATO = 'salute.json';
var MAX_STORIA = 60;
var MAX_CRESCITA = 400;
var GIORNO_MS = 24 * 60 * 60 * 1000;
var GIRO_MS = 5 * 60 * 1000;
var ORE_NOTTE = [2, 3, 4, 5]; // il controllo completo si fa di notte (alla prima occasione fra le 2 e le 6)
// azioni del registro attività che scrivono nel magazzino (le altre: accessi, utenti, copie, sistema…)
var AZIONI_MAGAZZINO = /^(articoli|movimenti|registro|impostazioni|reparti|magazzini|armadi|assortimento|ubicazioni|richieste|ddt|archivio)\.|^accesso\.2fa\.criterio$/;

function due(n) { return String(n).padStart(2, '0'); }
function marcaTempo(d) {
  return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate()) + '_' + due(d.getHours()) + due(d.getMinutes()) + due(d.getSeconds());
}
function giorno(d) { return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate()); }
function dataOra(ms) {
  var d = new Date(ms);
  return due(d.getDate()) + '/' + due(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + due(d.getHours()) + ':' + due(d.getMinutes());
}
function primoValore(riga) { return riga ? Object.values(riga)[0] : null; }
function dimensione(f) { try { return fs.statSync(f).size; } catch (e) { return 0; } }
function esiste(f) { try { fs.statSync(f); return true; } catch (e) { return false; } }
function togli(f) { try { fs.unlinkSync(f); } catch (e) { /* non c'era */ } }
function chiudi(db) { if (db) { try { db.close(); } catch (e) { /* già chiuso */ } } }
function plurale(n, uno, molti) { return n + ' ' + (n === 1 ? uno : molti); }

/* ---------- controllo di un file ---------- */

/* Messaggi di quick_check/integrity_check in poche righe leggibili (senza "*** in database main ***"). */
function pulisciMessaggi(righe) {
  var out = [];
  righe.forEach(function (r) {
    String(r || '').split('\n').forEach(function (x) {
      x = x.trim();
      if (x && !/^\*\*\*/.test(x) && out.length < 5) out.push(x);
    });
  });
  return out;
}

/*
 * Controllo di un file del database. tipo: 'rapido' (quick_check) o 'completo' (integrity_check).
 * Risposta { esito: 'ok' | 'danneggiato' | 'mancante', messaggi: [], durataMs, rev, base, sessione }
 * (rev, base e sessione solo per il magazzino, se si leggono).
 */
function controllaFile(file, tipo, magazzino) {
  var inizio = Date.now();
  var out = { esito: 'ok', messaggi: [], durataMs: 0, rev: null, base: null, sessione: null };
  if (!esiste(file)) { out.esito = 'mancante'; return out; }
  var db;
  try {
    db = new DatabaseSync(file);
    out.messaggi = db.prepare(tipo === 'completo' ? 'PRAGMA integrity_check(20)' : 'PRAGMA quick_check(20)').all().map(primoValore);
    if (out.messaggi.length !== 1 || out.messaggi[0] !== 'ok') { out.esito = 'danneggiato'; out.messaggi = pulisciMessaggi(out.messaggi); }
    else out.messaggi = [];
    if (magazzino && out.esito === 'ok') {
      try {
        var meta = {};
        db.prepare('SELECT chiave, valore FROM meta').all().forEach(function (r) { meta[r.chiave] = r.valore; });
        out.rev = Number(meta.rev) || 0;
        out.base = Number(meta.rev_base) || 0;
        out.sessione = meta.sessione || null;
      } catch (e) { /* archivio nuovo, senza tabelle */ }
    }
  } catch (e) {
    out.esito = 'danneggiato';
    out.messaggi = [e.message];
  } finally {
    chiudi(db);
  }
  out.durataMs = Date.now() - inizio;
  return out;
}

/* Controllo su una connessione già aperta (controllo notturno o manuale, a programma acceso). */
function controllaConnessione(db, tipo) {
  var inizio = Date.now();
  var out = { esito: 'ok', messaggi: [], durataMs: 0, chiaviEsterne: 0 };
  try {
    out.messaggi = db.prepare(tipo === 'completo' ? 'PRAGMA integrity_check(20)' : 'PRAGMA quick_check(20)').all().map(primoValore);
    if (out.messaggi.length !== 1 || out.messaggi[0] !== 'ok') { out.esito = 'danneggiato'; out.messaggi = pulisciMessaggi(out.messaggi); }
    else out.messaggi = [];
    if (out.esito === 'ok') out.chiaviEsterne = db.prepare('PRAGMA foreign_key_check').all().length;
  } catch (e) {
    out.esito = 'danneggiato';
    out.messaggi = [e.message];
  }
  out.durataMs = Date.now() - inizio;
  return out;
}

/* ---------- riapplicazione del giornale ---------- */

function camel(nome) { return nome.replace(/_([a-z])/g, function (m, l) { return l.toUpperCase(); }); }

/*
 * Conversione inversa per le TABELLE_SYNC: oggetto nella forma di App.S (server/db.js, *DaRiga) → riga SQL.
 * Il nome della colonna è quello dell'oggetto in snake_case (repartoId → reparto_id, scortaMinima → scorta_minima…);
 * casi particolari: movimenti.annullato { il, da, motivo } → annullato_il/_da/_motivo; vero/falso → 1/0;
 * elenchi (codici a barre, attributi) → testo JSON. Le colonne che l'oggetto non ha restano col valore predefinito.
 * colonne: PRAGMA table_info della tabella; rev: revisione della voce del giornale.
 */
function rigaDaOggetto(tabella, colonne, o, rev) {
  var riga = {};
  colonne.forEach(function (c) {
    var n = c.name;
    var v;
    if (n === 'rev') v = rev;
    else if (tabella === 'movimenti' && n === 'annullato_il') v = o.annullato ? (o.annullato.il || null) : null;
    else if (tabella === 'movimenti' && n === 'annullato_da') v = o.annullato ? (o.annullato.da || '') : null;
    else if (tabella === 'movimenti' && n === 'annullato_motivo') v = o.annullato ? (o.annullato.motivo || '') : null;
    else v = o[camel(n)];
    if (v === undefined) return;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    else if (v !== null && typeof v === 'object') v = JSON.stringify(v);
    riga[n] = v;
  });
  return riga;
}

var PER_CHIAVE = {};
D.TABELLE_SYNC.forEach(function (t) { PER_CHIAVE[t.chiave] = t; });

/* Istruzioni preparate per riapplicare il giornale su una connessione. */
function Riapplicatore(db) {
  this.db = db;
  this.colonne = {};
  this.ist = {};
}

Riapplicatore.prototype.st = function (chiave, sql) {
  if (!this.ist[chiave]) this.ist[chiave] = this.db.prepare(sql);
  return this.ist[chiave];
};

Riapplicatore.prototype.colonneDi = function (tabella) {
  if (!this.colonne[tabella]) this.colonne[tabella] = this.db.prepare('PRAGMA table_info(' + tabella + ')').all();
  return this.colonne[tabella];
};

Riapplicatore.prototype.scriviRiga = function (t, o, rev) {
  var riga = rigaDaOggetto(t.tabella, this.colonneDi(t.tabella), o, rev);
  var nomi = Object.keys(riga);
  var st = this.st('ins:' + t.tabella + ':' + nomi.join(','),
    'INSERT OR REPLACE INTO ' + t.tabella + ' (' + nomi.join(', ') + ') VALUES (' + nomi.map(function () { return '?'; }).join(', ') + ')');
  st.run.apply(st, nomi.map(function (n) { return riga[n]; }));
  // una riga tornata a esistere non è più fra le cancellate (come fa il programma quando la ricrea)
  this.st('canc-via', 'DELETE FROM cancellati WHERE tabella = ? AND id = ?').run(t.chiave, String(o.id));
};

/* Una voce del giornale: prima le cancellazioni, poi le righe (una riga cancellata e ricreata nella stessa revisione resta). */
Riapplicatore.prototype.applica = function (v) {
  var self = this;
  var c = v.cambiamenti || {};
  (c.cancellati || []).forEach(function (x) {
    var t = PER_CHIAVE[x.tabella];
    if (!t) return;
    self.st('del:' + t.tabella, 'DELETE FROM ' + t.tabella + ' WHERE id = ?').run(String(x.id));
    self.st('canc', 'INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)').run(x.tabella, String(x.id), v.rev);
  });
  D.TABELLE_SYNC.forEach(function (t) {
    (c[t.chiave] || []).forEach(function (o) { if (o && o.id !== undefined) self.scriviRiga(t, o, v.rev); });
  });
  if (c.impostazioni && typeof c.impostazioni === 'object') {
    Object.keys(c.impostazioni).forEach(function (k) {
      self.st('imp', 'INSERT INTO impostazioni (chiave, valore, rev) VALUES (?, ?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore, rev = excluded.rev')
        .run(k, JSON.stringify(c.impostazioni[k]), v.rev);
    });
  }
};

/*
 * Riapplica le voci (già in ordine e senza buchi) in una transazione e porta meta.rev all'ultima.
 * I vincoli fra tabelle si sospendono durante la riapplicazione (le righe di una revisione arrivano in un ordine
 * qualsiasi e INSERT OR REPLACE non deve cancellare a cascata le righe collegate).
 */
function riapplica(db, voci) {
  if (!voci.length) return 0;
  var r = new Riapplicatore(db);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      voci.forEach(function (v) { r.applica(v); });
      db.prepare("UPDATE meta SET valore = ? WHERE chiave = 'rev'").run(String(voci[voci.length - 1].rev));
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* già chiusa */ }
      throw e;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return voci.length;
}

function leggiMeta(db) {
  var meta = {};
  db.prepare('SELECT chiave, valore FROM meta').all().forEach(function (x) { meta[x.chiave] = x.valore; });
  return { rev: Number(meta.rev) || 0, base: Number(meta.rev_base) || 0 };
}

/*
 * Ricostruisce un magazzino in "dest": parte dal file "partenza" (una copia, o un recupero), lo porta allo schema
 * attuale e riapplica il giornale della sua linea dalla sua revisione in poi.
 * Risposta { file, revIniziale, base, finoA, riapplicate, buco, lineaNuova, ultimaNota }.
 */
function ricostruisci(partenza, dest, cartellaGiornale, dopoMs) {
  togliDb(dest);
  if (partenza) fs.copyFileSync(partenza, dest);
  var db = D.apriDati(dest);
  try {
    var m = leggiMeta(db);
    var letti = G.leggi(cartellaGiornale, { daRev: m.rev, dopo: dopoMs || 0 });
    var c = G.catena(letti.voci, m.rev, m.base);
    riapplica(db, c.voci);
    return {
      file: dest, revIniziale: m.rev, base: m.base, finoA: c.voci.length ? c.finoA : m.rev, riapplicate: c.voci.length,
      buco: c.buco, lineaNuova: c.lineaNuova, ultimaNota: Math.max(c.ultimaNota, m.rev), illeggibili: letti.illeggibili
    };
  } finally {
    chiudi(db);
  }
}

function dataModifica(f) { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } }

function togliDb(f) { ['', '-wal', '-shm', '-journal'].forEach(function (s) { togli(f + s); }); }

/* Recupero dal file danneggiato: lo copio (con il suo WAL) in una cartella di lavoro e provo VACUUM INTO. */
function recupera(danneggiato, dest) {
  var lavoro = dest + '.lettura';
  togliDb(lavoro);
  togliDb(dest);
  try {
    fs.copyFileSync(danneggiato, lavoro);
    if (esiste(danneggiato + '-wal')) fs.copyFileSync(danneggiato + '-wal', lavoro + '-wal');
    var db = new DatabaseSync(lavoro);
    try { db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'"); } finally { chiudi(db); }
    var c = controllaFile(dest, 'completo', false);
    if (c.esito !== 'ok') throw new Error('il file recuperato non supera il controllo: ' + c.messaggi.slice(0, 2).join(' · '));
    return true;
  } catch (e) {
    togliDb(dest);
    return e.message;
  } finally {
    togliDb(lavoro);
  }
}

/* ---------- Salute ---------- */

/*
 * opz: { cartella (dati), log, versione, secondaCartella (dal file configurazione.json) }
 * Uso (server/main.js):
 *   var salute = new Salute(opz);
 *   salute.curaAllAvvio();                       // prima di new Database(cartella)
 *   … database, accessi, backup, giornale …
 *   salute.collega({ database, accessi, backup, giornale });
 *   salute.pianifica();                          // copie orarie e controllo notturno
 *   salute.chiusura();                           // all'arresto: copia finale se c'è stato lavoro
 */
function Salute(opz) {
  opz = opz || {};
  this.cartella = opz.cartella;
  this.log = opz.log || function () {};
  this.versione = opz.versione || '';
  this.secondaConfigurazione = opz.secondaCartella ? String(opz.secondaCartella) : '';
  this.avvio = new Date().toISOString();
  this.fileStato = path.join(this.cartella, FILE_STATO);
  this.cartellaGiornale = path.join(this.cartella, 'giornale');
  this.cartellaBackup = path.join(this.cartella, 'backup');
  this.cartellaDanneggiati = path.join(this.cartella, 'danneggiati');
  this.statoSalvato = this.carica();
  this.daRegistrare = [];    // eventi per il registro attività, scritti appena gli accessi sono aperti
  // dopo curaAllAvvio, per collega: { copia: bool (fare una copia), cura: cura del magazzino di questo avvio,
  // ultimaGiornale: ultima voce del giornale vista dalla cura, controllo: controllo d'avvio }
  this.dopoApertura = null;
  this.problemaAttivo = null; // danno trovato a programma acceso e non ancora curato
}

Salute.prototype.carica = function () {
  var s = null;
  try { s = JSON.parse(fs.readFileSync(this.fileStato, 'utf8')); } catch (e) { s = null; }
  if (!s || typeof s !== 'object') s = {};
  if (!Array.isArray(s.cure)) s.cure = [];
  if (!Array.isArray(s.controlli)) s.controlli = [];
  if (!Array.isArray(s.crescita)) s.crescita = [];
  if (!s.impostazioni || typeof s.impostazioni !== 'object') s.impostazioni = {};
  // ultima revisione del magazzino vista dal programma acceso (ogni 5 minuti e all'arresto): { rev, base, quando }
  if (!s.ultimaVista || typeof s.ultimaVista.rev !== 'number') s.ultimaVista = null;
  return s;
};

Salute.prototype.salva = function () {
  var s = this.statoSalvato;
  s.cure = s.cure.slice(-MAX_STORIA);
  s.controlli = s.controlli.slice(-MAX_STORIA);
  s.crescita = s.crescita.slice(-MAX_CRESCITA);
  try {
    fs.mkdirSync(this.cartella, { recursive: true });
    var tmp = this.fileStato + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, this.fileStato);
  } catch (e) {
    this.log('Stato della base dati non salvato (' + this.fileStato + '): ' + e.message);
  }
};

Salute.prototype.registraControllo = function (c) {
  this.statoSalvato.controlli.push(c);
  if (c.tipo !== 'avvio') this.statoSalvato.ultimoCompleto = c.quando;
  this.salva();
};

Salute.prototype.registraCura = function (c) {
  this.statoSalvato.cure.push(c);
  this.salva();
  this.daRegistrare.push({ azione: 'sistema.cura', dettagli: c });
};

/*
 * Copie valide di un file (dalla più recente): verificate, o della 2.x non ancora verificate.
 * conSeconda: anche quelle della seconda cartella (solo quando servono davvero: una cartella di rete che non risponde
 * può fermare il programma per decine di secondi).
 */
Salute.prototype.copieUtilizzabili = function (prefisso, conSeconda) {
  var cartelle = [this.cartellaBackup];
  var seconda = this.secondaCartella();
  if (conSeconda && seconda) cartelle.push(seconda);
  var visti = {};
  var out = [];
  cartelle.forEach(function (c, i) {
    B.copieIn(c).forEach(function (x) {
      if (x.prefisso !== prefisso || x.verificata === false || visti[x.nome]) return;
      visti[x.nome] = true;
      x.percorso = path.join(c, x.nome);
      x.cartella = i;
      out.push(x);
    });
  });
  // prima quelle della cartella dati, poi quelle della seconda cartella; ognuna dalla più recente
  return out.sort(function (a, b) { return a.cartella - b.cartella || B.perRecenza(a, b); });
};

/* Prova le copie una per una (prima la cartella dati, poi la seconda cartella) finché prova(copia) non riesce. */
Salute.prototype.provaCopie = function (prefisso, ordina, prova, messaggi) {
  var locali = this.copieUtilizzabili(prefisso, false);
  var gruppi = [ordina(locali)];
  var self = this;
  for (var g = 0; g < 2; g++) {
    if (g === 1) {
      if (!this.secondaCartella()) break;
      gruppi.push(ordina(this.copieUtilizzabili(prefisso, true).filter(function (c) { return c.cartella === 1; })));
      if (gruppi[1].length) self.log('Provo anche le copie della seconda cartella: ' + this.secondaCartella());
    }
    var elenco = gruppi[g];
    for (var i = 0; i < elenco.length; i++) {
      var c = elenco[i];
      var v = B.verificaFile(c.percorso, prefisso);
      if (!v.verificata) {
        messaggi.push('Copia ' + c.nome + ' non valida: ' + v.errore);
        if (c.cartella === 0) B.segnaNonValida(c.percorso, v);
        continue;
      }
      try {
        if (prova(c)) return c;
      } catch (e) { messaggi.push('Copia ' + c.nome + ': ' + e.message); }
    }
  }
  return null;
};

Salute.prototype.secondaCartella = function () {
  return this.secondaConfigurazione || this.statoSalvato.impostazioni.secondaCartella || '';
};

/*
 * Controllo rapido all'avvio e cura dei file danneggiati. Si chiama PRIMA di aprire il database per l'uso.
 * Non lancia errori se non quando non si può fare niente (per esempio un file danneggiato tenuto aperto da un
 * altro programma): allora il messaggio spiega cosa fare.
 */
Salute.prototype.curaAllAvvio = function () {
  var self = this;
  fs.mkdirSync(this.cartella, { recursive: true });
  this.togliAvanzi();
  var controllo = { quando: new Date().toISOString(), tipo: 'avvio', esito: 'ok', file: {}, durataMs: 0 };
  var inizio = Date.now();
  this.dopoApertura = { copia: false, cura: null, ultimaGiornale: null, controllo: controllo };
  FILE.forEach(function (nome) {
    var file = path.join(self.cartella, nome + '.db');
    var c = controllaFile(file, 'rapido', nome === 'farmacia');
    // file sparito: si guarda anche nella seconda cartella (un server nuovo dopo la rottura del disco del vecchio)
    var copie = c.esito === 'mancante' ? self.copieUtilizzabili(nome, true)
      : c.esito === 'ok' && dimensione(file) === 0 ? self.copieUtilizzabili(nome, false) : [];
    // del magazzino resta anche il giornale delle modifiche: con il giornale non è un'installazione nuova
    var traccia = copie.length > 0 || (nome === 'farmacia' && (c.esito === 'mancante' || dimensione(file) === 0) && self.giornalePresente());
    if (c.esito === 'mancante') {
      // installazione nuova: niente da curare. Se però ci sono copie o il giornale, il file è sparito (cancellato per
      // errore, messo in quarantena dall'antivirus, disco del server sostituito…) e si ricostruisce.
      if (!traccia) { controllo.file[nome] = { esito: 'nuovo' }; return; }
    } else if (c.esito === 'ok' && dimensione(file) === 0 && traccia) {
      // un file vuoto (troncato a zero) sembra un archivio nuovo: con delle copie o il giornale è un danno
      c.esito = 'danneggiato';
      c.messaggi = ['il file è vuoto'];
    }
    controllo.file[nome] = { esito: c.esito, messaggi: c.messaggi.slice(0, 5), durataMs: c.durataMs };
    if (c.esito === 'ok') return;
    controllo.esito = 'danneggiato';
    var motivo = c.esito === 'mancante' ? 'il file non c’è più' : (c.messaggi.slice(0, 2).join(' · ') || 'danneggiato');
    self.log('ATTENZIONE: ' + nome + '.db ' + (c.esito === 'mancante' ? 'non c’è più' : 'è danneggiato (' + motivo + ')') + ': provo a curarlo.');
    var cura = nome === 'farmacia' ? self.curaMagazzino(file, motivo) : self.curaAccessi(file, motivo);
    controllo.file[nome].cura = cura.esito;
  });
  controllo.durataMs = Date.now() - inizio;
  this.registraControllo(controllo);
  return controllo;
};

/* C'è un giornale delle modifiche (nella cartella dati o nella seconda cartella)? */
Salute.prototype.giornalePresente = function () {
  if (G.ultimaVoce(this.cartellaGiornale)) return true;
  var seconda = this.secondaCartella();
  if (!seconda) return false;
  try { return !!G.ultimaVoce(path.join(seconda, 'giornale')); } catch (e) { return false; }
};

/* Cartelle di lavoro rimaste da una cura o da una prova di ripristino interrotte (programma fermato a metà). */
Salute.prototype.togliAvanzi = function () {
  var self = this;
  var nomi = [];
  try { nomi = fs.readdirSync(this.cartella); } catch (e) { return; }
  nomi.filter(function (n) { return /^(cura|cura-[A-Za-z0-9]+|prova-ripristino-[A-Za-z0-9]+)$/.test(n); }).forEach(function (n) {
    try { fs.rmSync(path.join(self.cartella, n), { recursive: true, force: true }); } catch (e) { /* si riprova al prossimo avvio */ }
  });
};

/* Sposta il file danneggiato (con WAL e SHM) in dati/danneggiati/. Restituisce il percorso nuovo del .db (o null se non c'era). */
Salute.prototype.spostaDanneggiato = function (file, nome) {
  fs.mkdirSync(this.cartellaDanneggiati, { recursive: true });
  var dest = path.join(this.cartellaDanneggiati, nome + '_' + marcaTempo(new Date()) + '.db');
  var n = 1;
  while (esiste(dest)) dest = path.join(this.cartellaDanneggiati, nome + '_' + marcaTempo(new Date()) + '_' + (n++) + '.db');
  var spostato = null;
  ['', '-wal', '-shm', '-journal'].forEach(function (s) {
    if (!esiste(file + s)) return;
    try {
      fs.renameSync(file + s, dest + s);
      if (!s) spostato = dest;
    } catch (e) {
      throw new Error(nome + '.db è danneggiato ma non riesco a spostarlo (' + e.message + '). Forse un altro programma lo tiene aperto ' +
        '(il Gestionale è già avviato, un antivirus, un programma di copie): chiudilo e avvia di nuovo.');
    }
  });
  return spostato;
};

/* Cura di farmacia.db: recupero + giornale, copia + giornale, vuoto + giornale; vince chi arriva più avanti. */
Salute.prototype.curaMagazzino = function (file, motivo) {
  var inizio = Date.now();
  var self = this;
  var spostato = this.spostaDanneggiato(file, 'farmacia');
  var lavoro = path.join(this.cartella, 'cura');
  fs.mkdirSync(lavoro, { recursive: true });
  var messaggi = [];
  var candidati = [];
  this.recuperaGiornaleDallaSeconda(messaggi);
  var ultima = G.ultimaVoce(this.cartellaGiornale);

  // 1. recupero dal file danneggiato
  if (spostato) {
    var fileRec = path.join(lavoro, 'farmacia-recupero.db');
    var esitoRec = recupera(spostato, fileRec);
    if (esitoRec === true) {
      try {
        var r1 = ricostruisci(fileRec, path.join(lavoro, 'farmacia-recupero-giornale.db'), this.cartellaGiornale, dataModifica(spostato));
        r1.metodo = 'recupero';
        candidati.push(r1);
      } catch (e) { messaggi.push('Recupero dal file danneggiato: ' + e.message); }
      togliDb(fileRec);
    } else {
      messaggi.push('Il file danneggiato non si legge più per intero (' + esitoRec + ').');
    }
  }

  // 2. copia valida più recente (della linea più recente del giornale, se c'è) + giornale
  this.provaCopie('farmacia', function (copie) {
    if (!ultima) return copie;
    var stessaLinea = copie.filter(function (c) { return c.base === ultima.base || c.base === null; });
    return stessaLinea.concat(copie.filter(function (c) { return stessaLinea.indexOf(c) < 0; }));
  }, function (c) {
    var r2 = ricostruisci(c.percorso, path.join(lavoro, 'farmacia-copia.db'), self.cartellaGiornale, c.ms);
    r2.metodo = 'copia';
    r2.copia = c.nome;
    r2.copiaData = c.data;
    candidati.push(r2);
    return true;
  }, messaggi);

  // 3. archivio vuoto + tutto il giornale (solo se il giornale c'è dalla prima revisione)
  if (!candidati.length && ultima) {
    try {
      var r3 = ricostruisci(null, path.join(lavoro, 'farmacia-vuoto.db'), this.cartellaGiornale, 0);
      if (r3.riapplicate) { r3.metodo = 'giornale'; candidati.push(r3); } else togliDb(r3.file);
    } catch (e) { messaggi.push('Ricostruzione dal solo giornale: ' + e.message); }
  }

  // la ricostruzione che arriva più avanti; a parità, copia + giornale (fatta solo di dati verificati)
  var ordine = { copia: 0, giornale: 1, recupero: 2 };
  candidati.sort(function (a, b) { return b.finoA - a.finoA || ordine[a.metodo] - ordine[b.metodo]; });
  var scelto = candidati[0] || null;
  candidati.slice(1).forEach(function (x) { togliDb(x.file); });

  // ultima revisione nota: del giornale e della ricostruzione. Se la ricostruzione è di una linea più vecchia
  // (copia di prima di un ripristino) le modifiche della linea nuova sono perse
  var lineaDiversa = !!(ultima && scelto && ultima.base !== scelto.base);
  var ultimaNota = Math.max(ultima ? ultima.rev : 0, scelto ? scelto.ultimaNota : 0);
  var cura = {
    quando: new Date().toISOString(), file: 'farmacia.db', motivo: motivo, metodo: scelto ? scelto.metodo : 'vuoto',
    esito: 'curato', copia: scelto && scelto.copia || null, revCopia: scelto ? scelto.revIniziale : null,
    riapplicate: scelto ? scelto.riapplicate : 0, revFinale: scelto ? scelto.finoA : null, perse: 0,
    spostatoIn: spostato ? path.relative(this.cartella, spostato) : null, messaggi: messaggi, durataMs: 0
  };
  if (scelto) {
    var controllo = controllaFile(scelto.file, 'completo', true);
    if (controllo.esito !== 'ok') {
      cura.messaggi.push('La ricostruzione non supera il controllo completo: ' + controllo.messaggi.slice(0, 2).join(' · '));
      togliDb(scelto.file);
      scelto = null;
      cura.metodo = 'vuoto';
    }
  }
  if (scelto) {
    togliDb(file);
    fs.renameSync(scelto.file, file);
    // con modifiche perse, all'apertura il magazzino riparte da una linea nuova sopra il giornale (allineaLinea)
    cura.perse = Math.max(lineaDiversa ? 1 : 0, ultimaNota - scelto.finoA);
    // il programma acceso aveva visto il magazzino più avanti di dove arriva la ricostruzione (salute.json): le
    // modifiche fra le due revisioni non sono nel giornale (scritte mentre il giornale non funzionava)
    var vista = this.statoSalvato.ultimaVista;
    if (vista && vista.base === scelto.base && vista.rev > scelto.finoA) {
      cura.perse = Math.max(cura.perse, vista.rev - scelto.finoA);
      messaggi.push('Il ' + dataOra(new Date(vista.quando).getTime()) + ' il magazzino era già alla revisione ' + vista.rev +
        ', la ricostruzione arriva alla ' + scelto.finoA + ': le modifiche in mezzo non sono nel giornale.');
    }
    cura.esito = cura.perse > 0 ? 'curato-con-perdite' : 'curato';
  } else {
    // niente da cui ripartire: archivio vuoto (il file danneggiato resta in dati/danneggiati per un recupero a mano)
    cura.esito = 'ricreato';
  }
  try { fs.rmSync(lavoro, { recursive: true, force: true }); } catch (e) { /* resta la cartella di lavoro */ }
  this.dopoApertura.copia = true;
  // collega() confronta la cura con il registro attività (accessi.db è aperto solo dopo) e non ne registra un'altra
  this.dopoApertura.cura = cura;
  this.dopoApertura.ultimaGiornale = ultima;
  cura.durataMs = Date.now() - inizio;
  cura.dataCopia = scelto && scelto.copiaData || null;
  cura.messaggio = descriviCura(cura, scelto);
  this.log((cura.esito === 'curato' ? '' : 'ATTENZIONE: ') + cura.messaggio);
  messaggi.forEach(function (m) { self.log('  ' + m); });
  this.registraCura(cura);
  return cura;
};

/*
 * Prima di una cura: i file del giornale che nella seconda cartella sono più lunghi (o che qui mancano) si riportano
 * nella cartella dati. Serve quando il disco del server è stato sostituito: copie e giornale tornano dalla seconda cartella.
 */
Salute.prototype.recuperaGiornaleDallaSeconda = function (messaggi) {
  var seconda = this.secondaCartella();
  if (!seconda) return 0;
  var self = this;
  var n = 0;
  try {
    var remoti = G.elencoFile(path.join(seconda, 'giornale'));
    if (!remoti.length) return 0;
    fs.mkdirSync(this.cartellaGiornale, { recursive: true });
    remoti.forEach(function (f) {
      var locale = path.join(self.cartellaGiornale, f.nome);
      if (dimensione(locale) >= f.dimensione) return;
      fs.copyFileSync(f.percorso, locale);
      n++;
    });
  } catch (e) {
    messaggi.push('Giornale della seconda cartella non leggibile: ' + e.message);
  }
  if (n) messaggi.push('Riportati ' + plurale(n, 'file', 'file') + ' del giornale dalla seconda cartella.');
  return n;
};

/* Cura di accessi.db: recupero dal file, altrimenti la copia valida più recente, altrimenti un file nuovo. */
Salute.prototype.curaAccessi = function (file, motivo) {
  var inizio = Date.now();
  var spostato = this.spostaDanneggiato(file, 'accessi');
  var messaggi = [];
  var cura = {
    quando: new Date().toISOString(), file: 'accessi.db', motivo: motivo, metodo: 'nuovo', esito: 'ricreato', copia: null,
    spostatoIn: spostato ? path.relative(this.cartella, spostato) : null, messaggi: messaggi, durataMs: 0
  };
  var fatto = false;
  if (spostato) {
    var tmp = file + '.recupero';
    var esito = recupera(spostato, tmp);
    if (esito === true) {
      togliDb(file);
      fs.renameSync(tmp, file);
      cura.metodo = 'recupero';
      cura.esito = 'curato';
      fatto = true;
    } else {
      messaggi.push('Il file danneggiato non si legge più per intero (' + esito + ').');
    }
  }
  if (!fatto) {
    this.provaCopie('accessi', function (copie) { return copie; }, function (c) {
      // prima una copia accanto, poi la sostituzione in un colpo solo: mai un accessi.db copiato a metà
      var tmp2 = file + '.ripristino';
      togliDb(tmp2);
      fs.copyFileSync(c.percorso, tmp2);
      togliDb(file);
      fs.renameSync(tmp2, file);
      cura.metodo = 'copia';
      cura.copia = c.nome;
      cura.copiaData = c.data;
      cura.esito = 'curato-con-perdite';
      fatto = true;
      return true;
    }, messaggi);
  }
  this.dopoApertura.copia = true;
  cura.durataMs = Date.now() - inizio;
  cura.messaggio = descriviCura(cura, null);
  this.log('ATTENZIONE: ' + cura.messaggio);
  this.registraCura(cura);
  return cura;
};

function descriviCura(c, scelto) {
  if (c.metodo === 'linea-nuova') {
    return 'Il magazzino è più indietro del giornale delle modifiche: ' + plurale(c.perse, 'modifica registrata nel giornale non è', 'modifiche registrate nel giornale non sono') +
      ' nel magazzino' + (c.riassunto ? ' (' + c.riassunto + ')' : '') + '. Il file è stato rimesso da una copia vecchia o il disco ha perso le ultime scritture: ' +
      'controlla le registrazioni più recenti. Il dettaglio resta nel giornale (cartella dati, giornale).';
  }
  var chi = c.file + (c.motivo === 'il file non c’è più' ? ' non c’era più' : ' era danneggiato');
  if (c.file === 'accessi.db') {
    if (c.metodo === 'recupero') return chi + ': recuperato dal file stesso, utenti e registro attività sono al loro posto.';
    if (c.metodo === 'copia') return chi + ': ripristinata la copia del ' + dataOra(new Date(c.copiaData).getTime()) +
      '. Utenti, password e accessi cambiati dopo quell’ora vanno rifatti; chi era collegato deve rientrare.';
    return chi + ' e non c’era nessuna copia: creato un archivio utenti nuovo. Crea di nuovo l’amministratore aprendo il programma sul server (http://localhost).';
  }
  if (c.metodo === 'vuoto') return chi + ' e non c’era niente da cui ricostruirlo: il programma riparte con un archivio vuoto. ' +
    'Il file danneggiato è in ' + (c.spostatoIn || 'dati/danneggiati') + ': chiedi assistenza prima di lavorare.';
  var dataCopia = scelto && scelto.copiaData || c.dataCopia;
  var come = c.metodo === 'copia' ? 'ricostruito dalla copia del ' + dataOra(new Date(dataCopia).getTime())
    : c.metodo === 'recupero' ? 'recuperato dal file stesso' : 'ricostruito dal giornale delle modifiche';
  var mod = !c.riapplicate ? '' : c.metodo === 'giornale' ? ' (' + plurale(c.riapplicate, 'modifica riapplicata', 'modifiche riapplicate') + ' su un archivio vuoto)'
    : ' più ' + plurale(c.riapplicate, 'modifica', 'modifiche') + ' riapplicate dal giornale';
  var perdite = c.perse > 0 ? ' ATTENZIONE: ' + plurale(c.perse, 'modifica non si è potuta', 'modifiche non si sono potute') +
    ' recuperare: controlla le registrazioni più recenti.' : ': nessun dato perso.';
  return chi + ': ' + come + mod + perdite;
}

/*
 * Dopo l'apertura del database: riapplica le scritture perse in uno spegnimento improvviso, completa il giornale,
 * riparte da una linea nuova se il magazzino è più indietro del giornale (cura con perdite), confronta la cura con il
 * registro attività, scrive nel registro attività gli eventi della cura, fa una copia se c'è stata una cura.
 * oggetti: { database, accessi, backup, giornale }
 */
Salute.prototype.collega = function (oggetti) {
  this.database = oggetti.database;
  this.accessi = oggetti.accessi || null;
  this.backup = oggetti.backup || null;
  this.giornale = oggetti.giornale || null;
  if (this.backup) {
    this.backup.salute = this;
    if (this.giornale) this.backup.giornale = this.giornale;
    var seconda = this.secondaCartella();
    if (seconda && !this.backup.seconda.percorso) this.backup.impostaSeconda(seconda, this.secondaConfigurazione ? 'configurazione' : 'pagina');
  }
  var dopo = this.dopoApertura || {};
  if (this.giornale) {
    if (this.recuperaCoda()) dopo.copia = true;
    this.completaGiornale();
    if (this.allineaLinea()) dopo.copia = true;
  }
  // una cura (o una coda riapplicata) dice "nessun dato perso" solo se anche il registro attività è d'accordo
  if (dopo.cura) this.verificaRegistro(dopo.cura, dopo.ultimaGiornale);
  if (dopo.copia && this.backup) {
    try { this.backup.automatica({ forza: true }); } catch (e) { this.log('Copia dopo la cura non riuscita: ' + e.message); }
  }
  this.registraEventi();
  this.campionaCrescita();
  this.dopoApertura = null;
};

/*
 * Il server ascolta: da qui il file del magazzino appartiene a questa sessione (un secondo avvio sulla stessa
 * cartella, che si ferma perché la porta è occupata, non arriva fin qui). Il WAL si riversa nel file principale e il
 * giornale segna l'avvio: fin qui il magazzino è sicuramente nel file. Poi copie orarie e controllo notturno.
 */
Salute.prototype.avviato = function () {
  try { this.database.segnaSessione(); } catch (e) { this.log('Sessione non segnata nel magazzino: ' + e.message); }
  this.segnaDurevole('avvio');
  this.pianifica();
};

/* Checkpoint completo del magazzino e segnalazione nel giornale (avvio, chiusura). */
Salute.prototype.segnaDurevole = function (tipo, dettagli) {
  if (!this.giornale || !this.database || !this.database.dati) return false;
  var durevole = this.database.fissaSulDisco();
  try {
    this.giornale.segnaLinea(tipo, Object.assign({}, dettagli || {}, durevole ? { durevole: true } : {}));
  } catch (e) { this.log('Segnalazione «' + tipo + '» non scritta nel giornale: ' + e.message); }
  return durevole;
};

/* Eventi della cura nel registro attività (come "sistema", senza utente). */
Salute.prototype.registraEventi = function () {
  if (!this.accessi) return;
  var self = this;
  this.daRegistrare.forEach(function (e) { self.accessi.evento({ username: 'sistema', ip: '' }, e.azione, e.dettagli); });
  this.daRegistrare = [];
};

/*
 * Scritture del magazzino registrate nel registro attività DOPO l'ultima voce del giornale "ultima": il giornale non
 * le ha, quindi nessuna cura le può riapplicare. L'evento di una scrittura si registra subito dopo la sua voce nel
 * giornale (voce.evento = ultimo numero del registro in quel momento): il primo evento dopo una voce di scrittura è
 * il suo e non conta. Senza il numero (giornale più vecchio) si confrontano le ore.
 * Risposta: [{ id, quando, username, azione }] (al massimo 200).
 */
Salute.prototype.scrittureDopo = function (ultima) {
  var acc = this.accessi ? this.accessi.db() : (this.database && this.database.accessi);
  if (!ultima || !ultima.quando || !acc) return [];
  var righe;
  var conNumero = typeof ultima.evento === 'number';
  try {
    righe = conNumero
      ? acc.prepare('SELECT id, quando, username, azione FROM eventi WHERE id > ? AND quando >= ? ORDER BY id LIMIT 1000').all(ultima.evento, ultima.quando)
      : acc.prepare('SELECT id, quando, username, azione FROM eventi WHERE quando > ? ORDER BY id LIMIT 1000').all(ultima.quando);
  } catch (e) { return []; }
  var scritture = righe.filter(function (r) { return AZIONI_MAGAZZINO.test(r.azione); });
  if (!ultima.tipo && scritture.length) {
    var primo = scritture[0];
    var suo = conNumero ? primo.id === ultima.evento + 1 : Date.parse(primo.quando) - Date.parse(ultima.quando) < 5000;
    if (suo) scritture = scritture.slice(1);
  }
  return scritture.slice(0, 200);
};

/*
 * Confronta una cura del magazzino fatta in questo avvio con il registro attività: se ci sono scritture registrate
 * dopo l'ultima voce del giornale, quelle modifiche non sono tornate. La cura diventa "con perdite" e le elenca.
 */
Salute.prototype.verificaRegistro = function (cura, ultima) {
  if (!cura || cura.esito === 'ricreato') return;
  var dopo = this.scrittureDopo(ultima);
  if (!dopo.length) return;
  var elenco = dopo.slice(0, 5).map(function (e) { return dataOra(Date.parse(e.quando)) + ' ' + (e.username || '?') + ' ' + e.azione; }).join('; ');
  cura.perse = Math.max(cura.perse || 0, dopo.length);
  cura.esito = 'curato-con-perdite';
  cura.scrittureSenzaGiornale = dopo.length;
  cura.messaggi = (cura.messaggi || []).concat(['Dopo l’ultima riga del giornale delle modifiche (' + dataOra(Date.parse(ultima.quando)) + ') il registro attività ha ' +
    plurale(dopo.length, 'scrittura', 'scritture') + ' che non si sono potute recuperare: ' + elenco + (dopo.length > 5 ? '…' : '') + '.']);
  cura.messaggio = ridescrivi(cura);
  this.salva();
  if (this.dopoApertura && this.dopoApertura.controllo && this.dopoApertura.controllo.file.farmacia) this.dopoApertura.controllo.file.farmacia.cura = cura.esito;
  this.log('ATTENZIONE: ' + cura.messaggio);
  this.log('  ' + cura.messaggi[cura.messaggi.length - 1]);
};

function ridescrivi(c) { return c.metodo === 'coda' ? descriviCoda(c) : descriviCura(c, null); }

function descriviCoda(c) {
  return 'Dopo uno spegnimento improvviso mancavano le ultime scritture del magazzino: ' +
    plurale(c.riapplicate, 'modifica riapplicata', 'modifiche riapplicate') + ' dal giornale' +
    (c.perse ? '; ATTENZIONE: ' + plurale(c.perse, 'modifica non si è potuta', 'modifiche non si sono potute') + ' recuperare: controlla le registrazioni più recenti.' : ', nessun dato perso.');
}

/*
 * Scritture perse in uno spegnimento improvviso: il magazzino è integro ma più indietro del giornale (che si scrive
 * con fsync), sulla stessa linea. Il WAL può essere sparito, vuoto (dopo il checkpoint notturno) o con la testata
 * rovinata: per questo si guarda sempre il giornale, non il WAL.
 * Si riapplicano le voci successive, senza buchi, SE il file non era già stato riversato su disco più avanti di
 * così: una segnalazione 'avvio', 'chiusura', 'ripristino' o 'nuova-linea' durevole oltre la revisione del file vuol
 * dire che il file è stato sostituito a mano con uno più vecchio (o il disco ha perso dati già al sicuro). Allora non
 * si riporta avanti: ci pensa allineaLinea (linea nuova, cura con perdite).
 * Restituisce il numero di voci riapplicate.
 */
Salute.prototype.recuperaCoda = function () {
  var ultima = this.giornale.ultimaVoce();
  if (!ultima) return 0;
  var rev = this.database.rev();
  var base = Number(this.database.meta('rev_base') || 0);
  if (ultima.base !== base || ultima.rev <= rev) return 0;
  var letti = this.giornale.coda(rev);
  var sostituito = letti.voci.some(function (v) {
    return v.tipo && v.durevole === true && v.base === base && v.rev > rev;
  });
  if (sostituito) return 0;
  var c = G.catena(letti.voci, rev, base);
  if (!c.voci.length) return 0;
  var inizio = Date.now();
  try {
    riapplica(this.database.dati, c.voci);
  } catch (e) {
    this.log('ATTENZIONE: non riesco a riapplicare le ultime modifiche dal giornale: ' + e.message);
    return 0;
  }
  var cura = {
    quando: new Date().toISOString(), file: 'farmacia.db', motivo: 'spegnimento improvviso: mancavano le ultime scritture',
    metodo: 'coda', esito: c.buco ? 'curato-con-perdite' : 'curato', copia: null, revCopia: rev, riapplicate: c.voci.length,
    revFinale: c.finoA, perse: c.buco ? c.ultimaNota - c.finoA : 0, spostatoIn: null, messaggi: [], durataMs: Date.now() - inizio
  };
  if (c.buco) cura.messaggi.push('Nel giornale mancano le revisioni da ' + c.buco.da + ' a ' + c.buco.a + '.');
  cura.messaggio = descriviCoda(cura);
  this.log((cura.perse ? 'ATTENZIONE: ' : '') + cura.messaggio);
  this.registraCura(cura);
  if (this.dopoApertura) {
    this.dopoApertura.cura = cura;
    this.dopoApertura.ultimaGiornale = this.dopoApertura.ultimaGiornale || ultima;
  }
  return c.voci.length;
};

/*
 * Il programma si è fermato fra il salvataggio di una scrittura e la sua riga nel giornale: le revisioni che il
 * magazzino ha e il giornale no si scrivono adesso (le righe di quelle revisioni sono ancora nel magazzino).
 */
Salute.prototype.completaGiornale = function () {
  var ultima = this.giornale.ultimaVoce();
  if (!ultima) return 0;
  var rev = this.database.rev();
  var base = Number(this.database.meta('rev_base') || 0);
  if (ultima.base !== base || rev <= ultima.rev || rev - ultima.rev > 1000) return 0;
  for (var r = ultima.rev + 1; r <= rev; r++) this.giornale.scriviRevisione(r);
  this.log('Giornale delle modifiche completato con ' + plurale(rev - ultima.rev, 'revisione', 'revisioni') + ' salvate nel magazzino ma non ancora scritte nel giornale.');
  return rev - ultima.rev;
};

/* Righe diverse per tabella nelle voci (per descrivere le modifiche perse: "2 articoli, 10 movimenti…"). */
var NOMI_TABELLE = {
  reparti: ['magazzino', 'magazzini'], articoli: ['articolo', 'articoli'], movimenti: ['movimento', 'movimenti'],
  armadi: ['armadio', 'armadi'], assortimento: ['riga di assortimento', 'righe di assortimento'],
  richieste: ['richiesta', 'richieste'], richiesteRighe: ['riga di richiesta', 'righe di richieste'], ddt: ['DDT', 'DDT'],
  ddtRighe: ['riga di DDT', 'righe di DDT']
};
function riassuntoVoci(voci) {
  var ids = {};
  var canc = {};
  var imp = {};
  function conta(k, id) { if (!ids[k]) ids[k] = {}; ids[k][id] = true; }
  voci.forEach(function (v) {
    var c = v.cambiamenti || {};
    Object.keys(NOMI_TABELLE).forEach(function (k) { (Array.isArray(c[k]) ? c[k] : []).forEach(function (r) { if (r && r.id !== undefined) conta(k, String(r.id)); }); });
    (Array.isArray(c.cancellati) ? c.cancellati : []).forEach(function (x) { canc[x.tabella + ':' + x.id] = true; });
    if (c.impostazioni && typeof c.impostazioni === 'object') Object.keys(c.impostazioni).forEach(function (k) { imp[k] = true; });
  });
  var parti = Object.keys(NOMI_TABELLE).filter(function (k) { return ids[k]; }).map(function (k) {
    return plurale(Object.keys(ids[k]).length, NOMI_TABELLE[k][0], NOMI_TABELLE[k][1]);
  });
  if (Object.keys(canc).length) parti.push(plurale(Object.keys(canc).length, 'cancellazione', 'cancellazioni'));
  if (Object.keys(imp).length) parti.push(plurale(Object.keys(imp).length, 'impostazione', 'impostazioni'));
  return parti.join(', ');
}

/* Contatori dei numeri (prog_ric_AAAA, prog_ddt_AAAA) usati nelle voci del giornale: { chiave: progressivo più alto }. */
function contatoriDaVoci(voci) {
  var out = {};
  voci.forEach(function (v) {
    var c = v.cambiamenti || {};
    [['ric', c.richieste], ['ddt', c.ddt]].forEach(function (x) {
      (Array.isArray(x[1]) ? x[1] : []).forEach(function (r) {
        if (!r || typeof r.anno !== 'number' || typeof r.progressivo !== 'number') return;
        var k = 'prog_' + x[0] + '_' + r.anno;
        if (r.progressivo > (out[k] || 0)) out[k] = r.progressivo;
      });
    });
  });
  return out;
}

/*
 * Il magazzino è più indietro del giornale (modifiche perse in una cura, il WAL perso dopo un file già riversato più
 * avanti, oppure il file sostituito a mano con uno più vecchio): le revisioni successive esistono già nel giornale e
 * non devono ripetersi. Il magazzino riparte da una linea nuova sopra l'ultima revisione nota (come dopo un
 * ripristino): i browser ricaricano tutto e il giornale resta coerente. Quello che il giornale ha e il magazzino no
 * è una cura "con perdite" (semaforo rosso), con il riassunto di cosa manca; i contatori dei numeri di richieste e DDT
 * salgono oltre quelli già usati. Restituisce true se ha cambiato linea.
 */
Salute.prototype.allineaLinea = function () {
  var ultima = this.giornale.ultimaVoce();
  if (!ultima) return false;
  var db = this.database;
  var rev = db.rev();
  var base = Number(db.meta('rev_base') || 0);
  if (ultima.rev <= rev && ultima.base <= base) return false;
  // le modifiche del giornale che il magazzino non ha
  var letti = this.giornale.coda(rev);
  var mancanti = letti.voci.filter(function (v) { return !v.tipo && v.rev > rev; });
  var revs = {};
  mancanti.forEach(function (v) { revs[v.rev + ':' + v.base] = true; });
  var perse = Object.keys(revs).length;
  var nuova = Math.max(ultima.rev, rev) + 1;
  db.impostaMeta('rev', nuova);
  db.impostaMeta('rev_base', nuova);
  var contatori = B.portaContatori(db, contatoriDaVoci(mancanti));
  var durevole = db.fissaSulDisco();
  this.giornale.segnaLinea('nuova-linea', Object.assign({ revFile: rev, revGiornale: ultima.rev, perse: perse }, durevole ? { durevole: true } : {}));
  this.log('Il magazzino è alla revisione ' + rev + ' ma il giornale arriva alla ' + ultima.rev + ': riparto da una linea nuova (revisione ' + nuova + '). ' +
    'Le modifiche del giornale successive alla revisione ' + rev + ' non sono nel magazzino' + (perse ? ' (' + plurale(perse, 'modifica', 'modifiche') + ')' : '') + '.');
  if (Object.keys(contatori).length) this.log('Numeri di richieste e DDT già usati nel giornale: i prossimi ripartono da ' + Object.keys(contatori).map(function (k) { return k + ' = ' + contatori[k]; }).join(', ') + '.');
  this.daRegistrare.push({ azione: 'sistema.linea-nuova', dettagli: { revFile: rev, revGiornale: ultima.rev, nuova: nuova, perse: perse } });
  var giaCurato = this.dopoApertura && this.dopoApertura.cura;
  if (perse && giaCurato && perse > (giaCurato.perse || 0)) {
    // la cura di questo avvio ha già detto quante modifiche mancano: se il giornale ne mostra di più, vale il giornale
    giaCurato.perse = perse;
    giaCurato.esito = 'curato-con-perdite';
    giaCurato.messaggio = ridescrivi(giaCurato);
    this.salva();
  }
  if (perse && !giaCurato) {
    var cura = {
      quando: new Date().toISOString(), file: 'farmacia.db', motivo: 'il magazzino è più indietro del giornale delle modifiche',
      metodo: 'linea-nuova', esito: 'curato-con-perdite', copia: null, revCopia: rev, riapplicate: 0, revFinale: rev, perse: perse,
      revGiornale: ultima.rev, riassunto: riassuntoVoci(mancanti), spostatoIn: null, messaggi: [], durataMs: 0
    };
    cura.messaggio = descriviCura(cura, null);
    this.log('ATTENZIONE: ' + cura.messaggio);
    this.registraCura(cura);
    // anche qui il resoconto si confronta con il registro attività (collega, verificaRegistro)
    if (this.dopoApertura) {
      this.dopoApertura.cura = cura;
      this.dopoApertura.ultimaGiornale = ultima;
    }
  }
  return true;
};

/* Un campione al giorno della dimensione della base dati (grafico della crescita nella pagina Sistema). */
Salute.prototype.campionaCrescita = function () {
  if (!this.database || !this.database.dati) return;
  var oggi = giorno(new Date());
  var c = {
    giorno: oggi,
    dimensione: dimensione(this.database.fileDati) + dimensione(this.database.fileDati + '-wal'),
    accessi: dimensione(this.database.fileAccessi) + dimensione(this.database.fileAccessi + '-wal'),
    movimenti: 0,
    rev: 0
  };
  try {
    c.movimenti = this.database.dati.prepare('SELECT COUNT(*) n FROM movimenti').get().n;
    c.rev = this.database.rev();
    this.statoSalvato.ultimaVista = { rev: c.rev, base: Number(this.database.meta('rev_base') || 0), quando: new Date().toISOString() };
  } catch (e) { /* magazzino chiuso un attimo */ }
  var cr = this.statoSalvato.crescita;
  if (cr.length && cr[cr.length - 1].giorno === oggi) cr[cr.length - 1] = c;
  else cr.push(c);
  this.salva();
};

/* ---------- controlli a programma acceso ---------- */

/*
 * Controllo completo dei due file aperti (integrity_check, vincoli fra tabelle), poi PRAGMA optimize e pulizia del WAL.
 * tipo: 'notte' | 'manuale'. Se il magazzino è danneggiato prova la cura subito (curaACaldo).
 */
Salute.prototype.controlloCompleto = function (tipo) {
  var inizio = Date.now();
  var controllo = { quando: new Date().toISOString(), tipo: tipo || 'manuale', esito: 'ok', file: {}, durataMs: 0 };
  [['farmacia', this.database.dati], ['accessi', this.database.accessi]].forEach(function (x) {
    var c = controllaConnessione(x[1], 'completo');
    controllo.file[x[0]] = { esito: c.esito, messaggi: c.messaggi.slice(0, 5), durataMs: c.durataMs, chiaviEsterne: c.chiaviEsterne };
    if (c.esito !== 'ok') controllo.esito = 'danneggiato';
    if (c.esito === 'ok') {
      try {
        x[1].exec('PRAGMA optimize');
        x[1].exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (e) { /* non indispensabile */ }
    }
  });
  controllo.durataMs = Date.now() - inizio;
  if (controllo.esito === 'ok') {
    this.problemaAttivo = null;
    this.log('Controllo completo della base dati (' + ({ notte: 'notturno', periodico: 'periodico', manuale: 'chiesto dall’amministratore' }[tipo] || tipo) + '): tutto in ordine (' + controllo.durataMs + ' ms).');
  } else {
    this.log('ATTENZIONE: il controllo completo ha trovato danni: ' + JSON.stringify(controllo.file));
    if (controllo.file.farmacia.esito !== 'ok') {
      var cura = this.curaACaldo(controllo.file.farmacia.messaggi[0] || 'danneggiato');
      controllo.file.farmacia.cura = cura ? cura.esito : 'da-riavviare';
    }
    if (controllo.file.accessi.esito !== 'ok') {
      this.problemaAttivo = { quando: controllo.quando, file: 'accessi.db', testo: 'L’archivio degli utenti (accessi.db) è danneggiato: riavvia il servizio, all’avvio il programma lo cura da solo.' };
    }
  }
  this.registraControllo(controllo);
  // il controllo chiesto dall'amministratore lo registra la rotta, con il suo nome
  if (this.accessi && controllo.tipo !== 'manuale') {
    this.accessi.evento({ username: 'sistema', ip: '' }, 'sistema.controllo', { tipo: controllo.tipo, esito: controllo.esito, durataMs: controllo.durataMs });
  }
  return controllo;
};

/*
 * Magazzino danneggiato a programma acceso: se copia + giornale arrivano fino all'ultima revisione, si sostituisce
 * il file subito (i browser ricaricano tutto da soli); altrimenti si avvisa di riavviare (la cura all'avvio prova
 * anche il recupero dal file).
 */
Salute.prototype.curaACaldo = function (motivo) {
  var db = this.database;
  var obiettivo = 0;
  try { obiettivo = db.rev(); } catch (e) { obiettivo = 0; }
  var ultima = this.giornale ? this.giornale.ultimaVoce() : null;
  if (ultima && ultima.rev > obiettivo) obiettivo = ultima.rev;
  // scritture registrate nel registro attività ma non nel giornale: copia + giornale non arriverebbero fin lì
  var senzaGiornale = this.scrittureDopo(ultima);
  if (senzaGiornale.length) {
    this.problemaAttivo = { quando: new Date().toISOString(), file: 'farmacia.db', testo: 'Il magazzino (farmacia.db) è danneggiato: riavvia il servizio, all’avvio il programma lo cura da solo.' };
    this.log('ATTENZIONE: farmacia.db è danneggiato e il giornale non ha le ultime ' + plurale(senzaGiornale.length, 'scrittura', 'scritture') + ' del registro attività: niente cura a programma acceso, riavvia il servizio.');
    return null;
  }
  var lavoro = fs.mkdtempSync(path.join(this.cartella, 'cura-'));
  var scelto = null;
  try {
    var self = this;
    var base = ultima ? ultima.base : null;
    this.provaCopie('farmacia', function (copie) {
      return copie.filter(function (c) { return base === null || c.base === null || c.base === base; });
    }, function (c) {
      var r = ricostruisci(c.percorso, path.join(lavoro, 'farmacia.db'), self.cartellaGiornale, c.ms);
      if (r.finoA >= obiettivo && controllaFile(r.file, 'completo', true).esito === 'ok') { r.copia = c; scelto = r; return true; }
      return false;
    }, []);
    if (!scelto) {
      this.problemaAttivo = { quando: new Date().toISOString(), file: 'farmacia.db', testo: 'Il magazzino (farmacia.db) è danneggiato: riavvia il servizio, all’avvio il programma lo cura da solo.' };
      this.log('ATTENZIONE: farmacia.db è danneggiato e non si può ricostruire senza perdite a programma acceso: riavvia il servizio.');
      return null;
    }
    var inizio = Date.now();
    db.chiudiDati();
    var spostato = null;
    try {
      spostato = this.spostaDanneggiato(db.fileDati, 'farmacia');
      try {
        fs.renameSync(scelto.file, db.fileDati);
      } catch (e) {
        // non si deve MAI riaprire una cartella senza magazzino (si creerebbe un archivio vuoto): rimetto il file di prima
        ['', '-wal', '-shm', '-journal'].forEach(function (s) { if (spostato && esiste(spostato + s)) fs.renameSync(spostato + s, db.fileDati + s); });
        spostato = null;
        throw e;
      }
    } finally {
      db.apri();
    }
    db.segnaSessione();
    var cura = {
      quando: new Date().toISOString(), file: 'farmacia.db', motivo: motivo, metodo: 'copia', esito: 'curato',
      copia: scelto.copia.nome, revCopia: scelto.revIniziale, riapplicate: scelto.riapplicate, revFinale: scelto.finoA, perse: 0,
      spostatoIn: spostato ? path.relative(this.cartella, spostato) : null, messaggi: [], durataMs: Date.now() - inizio, aCaldo: true
    };
    cura.messaggio = descriviCura(cura, { copiaData: scelto.copia.data });
    this.log(cura.messaggio);
    this.registraCura(cura);
    this.registraEventi();
    this.problemaAttivo = null;
    if (this.backup) { try { this.backup.automatica({ forza: true }); } catch (e) { this.log('Copia dopo la cura non riuscita: ' + e.message); } }
    if (this.server) this.server.notifica(db.rev());
    return cura;
  } catch (e) {
    this.log('ATTENZIONE: cura a programma acceso non riuscita: ' + e.message);
    this.problemaAttivo = { quando: new Date().toISOString(), file: 'farmacia.db', testo: 'Il magazzino (farmacia.db) è danneggiato: riavvia il servizio, all’avvio il programma lo cura da solo.' };
    return null;
  } finally {
    try { fs.rmSync(lavoro, { recursive: true, force: true }); } catch (e) { /* resta la cartella di lavoro */ }
  }
};

/* ---------- prova di ripristino ---------- */

/* Conteggi e somme di controllo di una tabella: righe, somma delle revisioni, somma delle quantità, impronta id+rev. */
function riassuntoTabella(db, tabella) {
  var colonne = db.prepare('PRAGMA table_info(' + tabella + ')').all().map(function (c) { return c.name; });
  var somma = colonne.indexOf('quantita') >= 0 ? 'quantita' : colonne.indexOf('prezzo') >= 0 ? 'prezzo' : null;
  var r = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(rev), 0) sr' + (somma ? ', COALESCE(ROUND(SUM(' + somma + '), 6), 0) sq' : '') + ' FROM ' + tabella).get();
  var h = require('crypto').createHash('sha1');
  db.prepare('SELECT id, rev FROM ' + tabella + ' ORDER BY id').all().forEach(function (x) { h.update(String(x.id) + ':' + x.rev + ';'); });
  return { righe: r.n, sommaRev: r.sr, somma: somma ? r.sq : null, campoSomma: somma, impronta: h.digest('hex').slice(0, 16) };
}

function riassuntoImpostazioni(db) {
  var h = require('crypto').createHash('sha1');
  var n = 0;
  db.prepare('SELECT chiave, valore FROM impostazioni ORDER BY chiave').all().forEach(function (x) { n++; h.update(x.chiave + '=' + x.valore + ';'); });
  return { righe: n, sommaRev: null, somma: null, campoSomma: null, impronta: h.digest('hex').slice(0, 16) };
}

/*
 * "Prova che la cura funzionerebbe": ricostruisce in una cartella temporanea l'ultima copia verificata più il giornale
 * e la confronta, tabella per tabella, con il database attuale (righe, somme, impronta delle righe e delle revisioni).
 */
Salute.prototype.provaRipristino = function () {
  var inizio = Date.now();
  var db = this.database;
  var attuale = db.rev();
  var base = Number(db.meta('rev_base') || 0);
  var adatta = function (c) { return c.verificata === true && (c.base === null || c.base === base) && (c.rev === null || c.rev <= attuale); };
  if (!this.copieUtilizzabili('farmacia').filter(adatta).length) {
    throw errore(409, 'Non c’è ancora nessuna copia verificata del magazzino da cui partire: fai prima una copia (“Copia adesso”).');
  }
  // cartella temporanea sullo stesso disco dei dati (spazio e permessi noti, anche per il servizio di Windows)
  var cartella = fs.mkdtempSync(path.join(this.cartella, 'prova-ripristino-'));
  var prova = { quando: new Date().toISOString(), esito: 'ok', copia: null, revCopia: null, riapplicate: 0, revRicostruita: null, revAttuale: attuale, tabelle: [], messaggi: [], durataMs: 0 };
  var self = this;
  try {
    // come farebbe la cura: dalla copia più recente, saltando quelle che non superano più la verifica
    var r = null;
    var scartate = [];
    var c = this.provaCopie('farmacia', function (copie) { return copie.filter(adatta); }, function (x) {
      r = ricostruisci(x.percorso, path.join(cartella, 'farmacia.db'), self.cartellaGiornale, x.ms);
      return true;
    }, scartate);
    if (!c) throw errore(409, 'Nessuna copia del magazzino supera la verifica: fai una copia nuova (“Copia adesso”) e riprova. ' + scartate.join(' '));
    scartate.forEach(function (m) { prova.messaggi.push(m); });
    prova.copia = c.nome;
    prova.copiaData = c.data;
    prova.revCopia = r.revIniziale;
    prova.riapplicate = r.riapplicate;
    prova.revRicostruita = r.finoA;
    if (r.buco) prova.messaggi.push('Nel giornale mancano le revisioni da ' + r.buco.da + ' a ' + r.buco.a + '.');
    var ric = D.apriDati(r.file);
    try {
      var integrita = controllaConnessione(ric, 'completo');
      if (integrita.esito !== 'ok') prova.messaggi.push('La ricostruzione non supera il controllo di integrità.');
      D.TABELLE_SYNC.forEach(function (t) {
        var a = riassuntoTabella(db.dati, t.tabella);
        var b = riassuntoTabella(ric, t.tabella);
        prova.tabelle.push({ tabella: t.chiave, attuale: a, ricostruita: b, uguale: a.righe === b.righe && a.sommaRev === b.sommaRev && a.somma === b.somma && a.impronta === b.impronta });
      });
      var ia = riassuntoImpostazioni(db.dati);
      var ib = riassuntoImpostazioni(ric);
      prova.tabelle.push({ tabella: 'impostazioni', attuale: ia, ricostruita: ib, uguale: ia.righe === ib.righe && ia.impronta === ib.impronta });
    } finally { chiudi(ric); }
    var diverse = prova.tabelle.filter(function (t) { return !t.uguale; });
    if (prova.revRicostruita !== attuale) prova.messaggi.push('La ricostruzione arriva alla revisione ' + prova.revRicostruita + ', il magazzino è alla ' + attuale + '.');
    if (diverse.length) prova.messaggi.push('Tabelle diverse: ' + diverse.map(function (t) { return t.tabella; }).join(', ') + '.');
    prova.esito = !diverse.length && prova.revRicostruita === attuale && !prova.messaggi.length ? 'ok' : 'differenze';
  } finally {
    try { fs.rmSync(cartella, { recursive: true, force: true }); } catch (e) { /* cartella temporanea */ }
  }
  prova.durataMs = Date.now() - inizio;
  this.statoSalvato.provaRipristino = prova;
  this.salva();
  this.log('Prova di ripristino: ' + (prova.esito === 'ok' ? 'la cura funzionerebbe (copia ' + prova.copia + ' + ' + plurale(prova.riapplicate, 'modifica', 'modifiche') + ' dal giornale)' : 'DIFFERENZE: ' + prova.messaggi.join(' ')));
  return prova;
};

/* ---------- pianificazione ---------- */

/* Ogni 5 minuti: copie orarie, una copia vecchia da verificare, campione della crescita, controllo notturno. */
Salute.prototype.pianifica = function () {
  var self = this;
  if (this.timer) return;
  function giro() { self.giro(); }
  giro();
  this.timer = setInterval(giro, GIRO_MS);
  if (this.timer.unref) this.timer.unref();
};

Salute.prototype.giro = function () {
  var self = this;
  if (!this.database || !this.database.dati) return;
  var adesso = new Date();
  if (this.backup) {
    try {
      this.backup.automatica();
      this.backup.ultimoErrore = null;
    } catch (e) {
      this.backup.ultimoErrore = { quando: adesso.toISOString(), messaggio: e.message };
      this.log('Copia automatica non riuscita: ' + e.message);
    }
    try { this.backup.verificaUnaVecchia(); } catch (e) { this.log('Verifica di una copia vecchia non riuscita: ' + e.message); }
    // ritenta una cartella di rete che prima non rispondeva; porta il giornale nuovo anche fra una copia e l'altra
    // (se il disco del server si rompe, nella seconda cartella mancano al massimo 5 minuti di lavoro)
    if (this.backup.seconda.percorso && !this.backup.seconda.inCorso && (this.backup.seconda.raggiungibile !== true || this.backup.giornaleDaPortare())) {
      this.backup.sincronizzaSeconda();
    }
  }
  try { this.campionaCrescita(); } catch (e) { /* non indispensabile */ }
  var ultimo = this.statoSalvato.ultimoCompleto ? new Date(this.statoSalvato.ultimoCompleto) : null;
  var giaOggi = ultimo && giorno(ultimo) === giorno(adesso);
  var vecchio = !ultimo || adesso - ultimo > 3 * GIORNO_MS;
  var diNotte = ORE_NOTTE.indexOf(adesso.getHours()) >= 0;
  if ((diNotte && !giaOggi) || vecchio) {
    try { self.controlloCompleto(diNotte ? 'notte' : 'periodico'); } catch (e) { this.log('Controllo completo non riuscito: ' + e.message); }
  }
};

Salute.prototype.ferma = function () {
  if (this.timer) clearInterval(this.timer);
  this.timer = null;
};

/*
 * All'arresto ordinato: copia finale se dall'ultima è cambiato qualcosa, WAL riversato nel file principale e
 * segnalazione 'chiusura' nel giornale (al prossimo avvio un file più indietro di così è stato rimesso a mano),
 * poi chiude il giornale.
 */
Salute.prototype.chiusura = function () {
  this.ferma();
  if (this.backup && this.database && this.database.dati) {
    try { this.backup.copiaFinale(); } catch (e) { this.log('Copia di chiusura non riuscita: ' + e.message); }
  }
  if (this.database && this.database.dati) {
    try { this.campionaCrescita(); } catch (e) { /* non indispensabile */ }
    this.segnaDurevole('chiusura');
  }
  if (this.giornale) this.giornale.chiudi();
};

/* ---------- stato per la pagina Sistema ---------- */

Salute.prototype.stato = function () {
  var db = this.database;
  var s = this.statoSalvato;
  var adesso = Date.now();
  var copie = this.backup ? this.backup.elencoCompleto() : B.copieIn(this.cartellaBackup);
  var giornale = this.giornale ? this.giornale.stato() : null;
  var disco = B.spazioLibero(this.cartella);
  var conteggi = {};
  var revisione = null;
  var base = null;
  try {
    D.TABELLE_SYNC.forEach(function (t) { conteggi[t.chiave] = db.dati.prepare('SELECT COUNT(*) n FROM ' + t.tabella).get().n; });
    conteggi.utenti = db.accessi.prepare('SELECT COUNT(*) n FROM utenti').get().n;
    conteggi.eventi = db.accessi.prepare('SELECT COUNT(*) n FROM eventi').get().n;
    revisione = db.rev();
    base = Number(db.meta('rev_base') || 0);
  } catch (e) { /* magazzino chiuso un attimo */ }
  var file = {
    farmacia: { dimensione: dimensione(db.fileDati), wal: dimensione(db.fileDati + '-wal') },
    accessi: { dimensione: dimensione(db.fileAccessi), wal: dimensione(db.fileAccessi + '-wal') }
  };
  var controlli = s.controlli.slice(-20).reverse();
  var ultimoCompleto = s.controlli.filter(function (c) { return c.tipo !== 'avvio'; }).slice(-1)[0] || null;
  var stato = {
    versione: this.versione,
    avvio: this.avvio,
    adesso: new Date(adesso).toISOString(),
    cartella: this.cartella,
    file: file,
    revisione: revisione,
    base: base,
    conteggi: conteggi,
    controllo: {
      ultimo: controlli[0] || null,
      ultimoCompleto: ultimoCompleto,
      prossimoNotturno: prossimoNotturno(new Date(adesso), s.ultimoCompleto)
    },
    controlli: controlli,
    cure: s.cure.slice(-20).reverse(),
    copie: copie,
    copieRiassunto: riassuntoCopie(copie, adesso),
    giornale: giornale,
    disco: disco ? { libero: disco.libero, totale: disco.totale } : null,
    secondaCartella: this.backup ? this.backup.statoSeconda() : { percorso: this.secondaCartella(), origine: '', raggiungibile: null },
    secondaDaConfigurazione: !!this.secondaConfigurazione,
    provaRipristino: s.provaRipristino || null,
    crescita: s.crescita.slice(-120),
    erroreCopie: this.backup ? this.backup.ultimoErrore : null,
    problema: this.problemaAttivo
  };
  var semaforo = valutaSemaforo(stato, adesso);
  stato.stato = semaforo.stato;
  stato.motivi = semaforo.motivi;
  return stato;
};

function riassuntoCopie(copie, adesso) {
  var mag = copie.filter(function (c) { return c.prefisso === 'farmacia'; });
  var verificate = copie.filter(function (c) { return c.verificata === true; });
  var ultimaVer = mag.filter(function (c) { return c.verificata === true; })[0] || null;
  return {
    totale: copie.length,
    verificate: verificate.length,
    nonRiuscite: copie.filter(function (c) { return c.verificata === false; }).length,
    daVerificare: copie.filter(function (c) { return c.verificata === null; }).length,
    dimensione: copie.reduce(function (s, c) { return s + c.dimensione; }, 0),
    ultimaVerificata: ultimaVer ? { nome: ultimaVer.nome, data: ultimaVer.data, rev: ultimaVer.rev } : null,
    oreDallUltima: ultimaVer ? Math.round((adesso - new Date(ultimaVer.data).getTime()) / 36e5 * 10) / 10 : null
  };
}

/* Quando si farà il prossimo controllo completo notturno (fra le 2 e le 6, una volta al giorno). */
function prossimoNotturno(adesso, ultimoCompleto) {
  var fattoOggi = !!ultimoCompleto && giorno(new Date(ultimoCompleto)) === giorno(adesso);
  var ora = adesso.getHours();
  if (!fattoOggi && ORE_NOTTE.indexOf(ora) >= 0) return new Date(adesso.getTime() + GIRO_MS).toISOString();
  var d = new Date(adesso);
  if (fattoOggi || ora > ORE_NOTTE[ORE_NOTTE.length - 1]) d.setDate(d.getDate() + 1);
  d.setHours(ORE_NOTTE[0], 0, 0, 0);
  return d.toISOString();
}

/*
 * Semaforo: 'ok' (verde), 'attenzione' (giallo), 'problema' (rosso), con i motivi in parole semplici.
 */
function valutaSemaforo(st, adesso) {
  var motivi = [];
  function m(livello, testo) { motivi.push({ livello: livello, testo: testo }); }
  if (st.problema) m('problema', st.problema.testo);
  var u = st.controllo.ultimo;
  if (u && u.esito !== 'ok' && !st.problema && u.tipo !== 'avvio') m('problema', 'L’ultimo controllo ha trovato un danno.');
  if (st.giornale && st.giornale.errore) m('problema', 'Il giornale delle modifiche non si scrive: ' + st.giornale.errore.messaggio);
  var rc = st.copieRiassunto;
  if (!rc.ultimaVerificata) m('problema', 'Non c’è nessuna copia verificata del magazzino.');
  else if (rc.oreDallUltima > 26) m('attenzione', 'L’ultima copia verificata ha più di un giorno.');
  if (st.erroreCopie) m('attenzione', 'L’ultima copia automatica non è riuscita: ' + st.erroreCopie.messaggio);
  var recenti = (st.copie || []).filter(function (c) { return c.verificata === false && adesso - new Date(c.data).getTime() < 2 * GIORNO_MS; });
  if (recenti.length) m('attenzione', plurale(recenti.length, 'copia recente non ha', 'copie recenti non hanno') + ' superato la verifica.');
  if (st.disco) {
    var db = st.file.farmacia.dimensione + st.file.farmacia.wal;
    if (st.disco.libero < 200 * 1024 * 1024) m('problema', 'Il disco della cartella dati è quasi pieno.');
    else if (st.disco.libero < Math.max(1024 * 1024 * 1024, db * 10)) m('attenzione', 'Sul disco della cartella dati resta poco spazio.');
  }
  var ultimaCura = st.cure[0];
  var etaCura = ultimaCura ? adesso - new Date(ultimaCura.quando).getTime() : Infinity;
  if (etaCura < 7 * GIORNO_MS) {
    // una cura con perdite è rossa per un giorno (bisogna controllare le ultime registrazioni), poi gialla
    m(ultimaCura.esito === 'curato' || etaCura > GIORNO_MS ? 'attenzione' : 'problema', ultimaCura.metodo === 'linea-nuova'
      ? 'Il ' + dataOra(new Date(ultimaCura.quando).getTime()) + ' il magazzino era più indietro del giornale delle modifiche: ' + plurale(ultimaCura.perse || 0, 'modifica non è tornata', 'modifiche non sono tornate') + '. Controlla le registrazioni più recenti.'
      : 'Il ' + dataOra(new Date(ultimaCura.quando).getTime()) + ' il programma ha curato ' + ultimaCura.file + ': ' + (ultimaCura.esito === 'curato' ? 'nessun dato perso.' : 'controlla le registrazioni più recenti.'));
  }
  var completo = st.controllo.ultimoCompleto;
  if (!completo || adesso - new Date(completo.quando).getTime() > 3 * GIORNO_MS) m('attenzione', 'Il controllo completo non si fa da più di tre giorni.');
  var sc = st.secondaCartella;
  if (sc && sc.percorso && sc.raggiungibile === false) m('attenzione', 'La seconda cartella delle copie non è raggiungibile.');
  var pr = st.provaRipristino;
  if (pr && pr.esito !== 'ok' && adesso - new Date(pr.quando).getTime() < 7 * GIORNO_MS) m('attenzione', 'L’ultima prova di ripristino ha trovato differenze.');
  var stato = motivi.some(function (x) { return x.livello === 'problema'; }) ? 'problema' : motivi.length ? 'attenzione' : 'ok';
  return { stato: stato, motivi: motivi };
}

/* ---------- seconda cartella ---------- */

function percorsoValido(p) {
  if (typeof p !== 'string') return false;
  if (p.length > 400 || /[\0\r\n]/.test(p)) return false;
  return path.isAbsolute(p) || /^\\\\[^\\]+\\[^\\]+/.test(p) || path.win32.isAbsolute(p);
}

Salute.prototype.impostaSeconda = function (percorso) {
  if (this.secondaConfigurazione) throw errore(409, 'La seconda cartella è scritta nel file configurazione.json della cartella dati: si cambia lì.');
  percorso = String(percorso === undefined || percorso === null ? '' : percorso).trim();
  if (percorso && !percorsoValido(percorso)) throw errore(400, 'Scrivi il percorso completo della cartella, per esempio E:\\CopieFarmacia oppure \\\\server\\condivisa\\Farmacia.');
  if (percorso) {
    var dentro = path.resolve(percorso).toLowerCase();
    var dati = path.resolve(this.cartella).toLowerCase();
    if (dentro === dati || dentro.indexOf(dati + path.sep) === 0) throw errore(400, 'La seconda cartella deve stare fuori dalla cartella dati (meglio su un altro disco o in rete).');
  }
  this.statoSalvato.impostazioni.secondaCartella = percorso;
  this.salva();
  if (this.backup) this.backup.impostaSeconda(percorso, 'pagina');
  this.log(percorso ? 'Seconda cartella delle copie: ' + percorso : 'Seconda cartella delle copie tolta.');
  return percorso;
};

/* ---------- rotte ---------- */

function inviaJson(res, stato, oggetto) {
  if (res.headersSent) return;
  var corpo = Buffer.from(JSON.stringify(oggetto));
  res.writeHead(stato, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': corpo.length, 'Cache-Control': 'no-store' });
  res.end(corpo);
}

var ATTESA_COPIA_MS = 20 * 1000;

/* La promessa, o niente dopo ms millisecondi (non fallisce mai). */
function entro(promessa, ms) {
  var timer;
  return Promise.race([
    Promise.resolve(promessa).catch(function () { return null; }),
    new Promise(function (ok) { timer = setTimeout(ok, ms); if (timer.unref) timer.unref(); })
  ]).then(function (x) { clearTimeout(timer); return x; });
}

/* Risposta di una rotta che finisce dopo (promessa): http.js non risponde se il gestore restituisce undefined. */
function rispondiPoi(server, ctx, promessa) {
  promessa.then(function (x) { inviaJson(ctx.res, 200, x); }, function (e) {
    if (e && e.stato) return inviaJson(ctx.res, e.stato, { errore: e.message });
    if (server.log) server.log('Errore su ' + ctx.percorso + ': ' + (e && (e.stack || e.message)));
    inviaJson(ctx.res, 500, { errore: 'Errore interno del server. Il dettaglio è nel registro del server.' });
  });
  return undefined;
}

module.exports.rotte = function (server) {
  var SISTEMA = { permesso: 'sistema' };
  function salute() {
    var s = server.backup && server.backup.salute;
    if (!s) {
      // server creato senza main.js (per esempio da uno strumento): una Salute senza cura all'avvio
      s = new Salute({ cartella: server.database.cartella, log: server.log, versione: server.versione });
      s.dopoApertura = null;
      s.collega({ database: server.database, accessi: server.accessi, backup: server.backup, giornale: server.backup ? server.backup.giornale : null });
    }
    s.server = server;
    return s;
  }
  function controllaPermesso(ctx) {
    if (!ctx.permessi || !ctx.permessi.sistema) throw errore(403, 'Il tuo utente non può fare questa operazione.');
  }

  server.rotta('GET', '/api/sistema', SISTEMA, function (ctx) {
    controllaPermesso(ctx);
    return salute().stato();
  });

  server.rotta('POST', '/api/sistema/controlla', SISTEMA, function (ctx) {
    controllaPermesso(ctx);
    var s = salute();
    var c = s.controlloCompleto('manuale');
    server.accessi.evento(ctx, 'sistema.controlla', { esito: c.esito, durataMs: c.durataMs });
    return { controllo: c, sistema: s.stato() };
  });

  server.rotta('POST', '/api/sistema/copia', SISTEMA, function (ctx) {
    controllaPermesso(ctx);
    var s = salute();
    if (!server.backup) throw errore(409, 'Copie di sicurezza non disponibili.');
    var nomi = server.backup.creaTutte('manuale');
    function copie() { return server.backup.elencoCompleto().filter(function (c) { return nomi.indexOf(c.nome) >= 0; }); }
    function risposta() { return { copie: copie(), sistema: s.stato() }; }
    server.accessi.evento(ctx, 'sistema.copia', { copie: nomi, verificate: copie().every(function (c) { return c.verificata === true; }) });
    if (!server.backup.seconda.percorso) return risposta();
    // con la seconda cartella si risponde quando le copie sono arrivate anche lì (al massimo dopo ATTESA_COPIA_MS:
    // una cartella di rete lenta non tiene fermo il pulsante; lo stato dice se si sta ancora aggiornando)
    return rispondiPoi(server, ctx, entro(server.backup.attesaSeconda || server.backup.sincronizzaSeconda(), ATTESA_COPIA_MS).then(risposta));
  });

  server.rotta('POST', '/api/sistema/prova-ripristino', SISTEMA, function (ctx) {
    controllaPermesso(ctx);
    var s = salute();
    var p = s.provaRipristino();
    server.accessi.evento(ctx, 'sistema.prova-ripristino', { esito: p.esito, copia: p.copia, riapplicate: p.riapplicate, durataMs: p.durataMs });
    return { prova: p, sistema: s.stato() };
  });

  server.rotta('PUT', '/api/sistema/seconda-cartella', SISTEMA, function (ctx) {
    controllaPermesso(ctx);
    var s = salute();
    var percorso = s.impostaSeconda(ctx.corpo.percorso);
    server.accessi.evento(ctx, 'sistema.seconda-cartella', { percorso: percorso });
    if (!percorso || !server.backup) return { seconda: server.backup ? server.backup.statoSeconda() : null, sistema: s.stato() };
    // si prova subito a scriverci (senza fermare il server): la risposta dice se è raggiungibile
    return rispondiPoi(server, ctx, server.backup.sincronizzaSeconda().then(function (seconda) {
      return { seconda: seconda, sistema: s.stato() };
    }));
  });
};

module.exports.Salute = Salute;
module.exports.controllaFile = controllaFile;
module.exports.rigaDaOggetto = rigaDaOggetto;
module.exports.riapplica = riapplica;
module.exports.ricostruisci = ricostruisci;
module.exports.valutaSemaforo = valutaSemaforo;
