/*
 * Giornale delle modifiche del magazzino (versione 3.0 – parte E, docs/NOVITA-3.0.md).
 *
 * Dopo ogni scrittura riuscita (database.dopoScrittura) aggiunge una riga JSON al file del giorno
 * dati/giornale/AAAA-MM-GG.jsonl e la forza sul disco (fsync):
 *
 *   { rev, base, storia, quando, cambiamenti: { reparti: [...], articoli: [...], …, cancellati: [{ tabella, id }],
 *     impostazioni: { chiave: valore } } }
 *
 * "cambiamenti" ha la forma di /api/dati (database.cambiamenti) ma contiene solo le righe scritte in QUELLA
 * revisione e solo le tabelle toccate (le chiavi vuote non si scrivono); le impostazioni sono solo quelle cambiate.
 * "base" è la revisione dell'ultimo ripristino (meta rev_base): le voci di una base diversa appartengono a un'altra
 * "linea" della storia e non si mescolano. Un ripristino o una cura che riparte da una revisione nuova scrivono una
 * voce di segnalazione { rev, base, tipo: 'ripristino' | 'nuova-linea', … } senza cambiamenti.
 *
 * Con una copia di sicurezza (che conosce la propria revisione) e il giornale si ricostruisce il magazzino fino
 * all'ultima scrittura: lo fa server/salute.js quando un file è danneggiato.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var D = require('./db.js');

var NOME_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
var MARGINE_MS = 2 * 60 * 60 * 1000; // file modificati fino a 2 ore prima di una copia: possono avere voci successive

function due(n) { return String(n).padStart(2, '0'); }

function giorno(d) {
  return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate());
}

function Giornale(database, opz) {
  opz = opz || {};
  this.database = database;
  this.log = opz.log || function () {};
  this.cartella = opz.cartella || path.join(database.cartella, 'giornale');
  fs.mkdirSync(this.cartella, { recursive: true });
  this.fd = null;
  this.fileAperto = null;
  this.errore = null;         // { quando, messaggio } dell'ultima scrittura non riuscita (si azzera alla prossima riuscita)
  this.ultima = null;         // { rev, base, storia, quando } dell'ultima voce scritta o letta all'avvio
  this.scritteSessione = 0;
  this.istruzioni = null;     // istruzioni preparate, legate alla connessione del magazzino
  this.connessione = null;
}

/* Scrive una voce dopo ogni scrittura del magazzino. */
Giornale.prototype.collega = function () {
  var self = this;
  if (this.collegato) return;
  this.collegato = true;
  this.database.dopoScrittura(function (x) { self.scriviRevisione(x.rev); });
};

/* Istruzioni "righe di questa revisione" per ogni tabella (si rifanno se la connessione è cambiata, per esempio dopo un ripristino). */
Giornale.prototype.preparate = function () {
  var db = this.database.dati;
  if (this.connessione === db && this.istruzioni) return this.istruzioni;
  var ist = { tabelle: [] };
  D.TABELLE_SYNC.forEach(function (t) {
    ist.tabelle.push({ t: t, st: db.prepare('SELECT * FROM ' + t.tabella + ' WHERE rev = ?') });
  });
  ist.cancellati = db.prepare('SELECT tabella, id FROM cancellati WHERE rev = ?');
  ist.impostazioni = db.prepare('SELECT chiave, valore FROM impostazioni WHERE rev = ?');
  this.istruzioni = ist;
  this.connessione = db;
  return ist;
};

/* Le righe scritte nella revisione rev, nella forma di /api/dati (solo le tabelle toccate). */
Giornale.prototype.cambiamentiRevisione = function (rev) {
  var ist = this.preparate();
  var out = {};
  ist.tabelle.forEach(function (x) {
    var righe = x.st.all(rev);
    if (righe.length) out[x.t.chiave] = righe.map(x.t.daRiga);
  });
  var canc = ist.cancellati.all(rev);
  if (canc.length) out.cancellati = canc.map(function (r) { return { tabella: r.tabella, id: r.id }; });
  var imp = ist.impostazioni.all(rev);
  if (imp.length) {
    out.impostazioni = {};
    imp.forEach(function (r) {
      try { out.impostazioni[r.chiave] = JSON.parse(r.valore); } catch (e) { /* valore illeggibile: non si può riscrivere */ }
    });
  }
  return out;
};

Giornale.prototype.scriviRevisione = function (rev) {
  var voce;
  try {
    voce = {
      rev: rev,
      base: Number(this.database.meta('rev_base') || 0),
      storia: this.database.storia,
      quando: new Date().toISOString(),
      cambiamenti: this.cambiamentiRevisione(rev)
    };
  } catch (e) {
    this.segnaErrore('lettura della revisione ' + rev + ': ' + e.message);
    return;
  }
  this.scrivi(voce);
};

/* Voce di segnalazione: da qui comincia una linea nuova (ripristino di una copia o cura con dati persi). */
Giornale.prototype.segnaLinea = function (tipo, dettagli) {
  var voce = Object.assign({
    rev: this.database.rev(),
    base: Number(this.database.meta('rev_base') || 0),
    storia: this.database.storia,
    quando: new Date().toISOString(),
    tipo: tipo
  }, dettagli || {});
  this.scrivi(voce);
};

Giornale.prototype.segnaErrore = function (messaggio) {
  var primo = !this.errore;
  this.errore = { quando: new Date().toISOString(), messaggio: messaggio };
  // nel registro una volta sola finché non torna a funzionare
  if (primo) this.log('ATTENZIONE: il giornale delle modifiche non si scrive (' + messaggio + '). I dati sono salvati, ma la cura automatica potrebbe non recuperare le ultime modifiche.');
};

/* Aggiunge la voce al file del suo giorno e la forza sul disco. */
Giornale.prototype.scrivi = function (voce) {
  var riga = JSON.stringify(voce) + '\n';
  var nome = giorno(new Date(voce.quando)) + '.jsonl';
  try {
    if (this.fileAperto !== nome) this.apriFile(nome);
    fs.writeSync(this.fd, riga);
    fs.fsyncSync(this.fd);
    if (this.errore) this.log('Il giornale delle modifiche si scrive di nuovo.');
    this.errore = null;
    this.ultima = { rev: voce.rev, base: voce.base, storia: voce.storia, quando: voce.quando };
    this.scritteSessione++;
  } catch (e) {
    this.chiudi();
    this.segnaErrore(e.message);
  }
};

Giornale.prototype.apriFile = function (nome) {
  this.chiudi();
  var file = path.join(this.cartella, nome);
  fs.mkdirSync(this.cartella, { recursive: true });
  var fd = fs.openSync(file, 'a+');
  try {
    // dopo uno spegnimento improvviso l'ultima riga può essere a metà: la chiudo, così la prossima resta leggibile
    var dim = fs.fstatSync(fd).size;
    if (dim > 0) {
      var b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, dim - 1);
      if (b[0] !== 0x0a) fs.writeSync(fd, '\n');
    }
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  this.fd = fd;
  this.fileAperto = nome;
};

Giornale.prototype.chiudi = function () {
  if (this.fd !== null) {
    try { fs.closeSync(this.fd); } catch (e) { /* già chiuso */ }
  }
  this.fd = null;
  this.fileAperto = null;
};

/* File del giornale, dal più vecchio: [{ nome, percorso, dimensione, modificato (ms) }] */
Giornale.prototype.file = function () {
  return elencoFile(this.cartella);
};

function elencoFile(cartella) {
  var nomi;
  try { nomi = fs.readdirSync(cartella); } catch (e) { return []; }
  return nomi.filter(function (n) { return NOME_FILE.test(n); }).sort().map(function (n) {
    var p = path.join(cartella, n);
    var st;
    try { st = fs.statSync(p); } catch (e) { return null; }
    return { nome: n, percorso: p, dimensione: st.size, modificato: st.mtimeMs };
  }).filter(Boolean);
}

/* Righe di un file (una voce per riga). Le righe illeggibili (scritte a metà) si contano e si saltano. */
function leggiFile(percorso, conta) {
  var testo;
  try { testo = fs.readFileSync(percorso, 'utf8'); } catch (e) { conta.illeggibili++; return []; }
  var out = [];
  testo.split('\n').forEach(function (riga) {
    if (!riga.trim()) return;
    try {
      var v = JSON.parse(riga);
      if (v && typeof v.rev === 'number') out.push(v);
      else conta.illeggibili++;
    } catch (e) { conta.illeggibili++; }
  });
  return out;
}

/*
 * Legge il giornale: voci con rev > opz.daRev, ordinate per revisione (a parità, nell'ordine in cui sono scritte).
 * opz.dopo (ms): legge solo i file modificati dopo quel momento (meno un margine), per non rileggere un anno di giornale.
 * Risposta { voci, illeggibili }.
 */
function leggi(cartella, opz) {
  opz = opz || {};
  var daRev = Number(opz.daRev) || 0;
  var dopo = opz.dopo ? Number(opz.dopo) - MARGINE_MS : 0;
  var conta = { illeggibili: 0 };
  var voci = [];
  elencoFile(cartella).forEach(function (f) {
    if (dopo && f.modificato < dopo) return;
    leggiFile(f.percorso, conta).forEach(function (v) { if (v.rev > daRev) voci.push(v); });
  });
  voci.forEach(function (v, i) { v._i = i; });
  voci.sort(function (a, b) { return a.rev - b.rev || a._i - b._i; });
  voci.forEach(function (v) { delete v._i; });
  return { voci: voci, illeggibili: conta.illeggibili };
}

Giornale.prototype.leggi = function (opz) { return leggi(this.cartella, opz); };

/*
 * Catena da riapplicare a un file che è alla revisione daRev della linea "base": le voci della stessa base con
 * rev > daRev, una per revisione e senza buchi. Si ferma al primo buco (una voce mancante: dopo non si può
 * riapplicare niente senza rischiare dati incoerenti).
 * Risposta { voci, finoA, ultimaNota, buco: { da, a } | null, lineaNuova: { rev, base } | null }:
 *   finoA       revisione a cui arriva il file dopo aver riapplicato le voci
 *   ultimaNota  ultima revisione nota nel giornale per quella linea
 *   lineaNuova  c'è una linea più recente (un ripristino o una cura dopo): questa copia è superata
 */
function catena(voci, daRev, base) {
  var perRev = {};
  var ultimaNota = daRev;
  var lineaNuova = null;
  voci.forEach(function (v) {
    if (v.base !== base) {
      if (v.base > base && (!lineaNuova || v.base > lineaNuova.base)) lineaNuova = { rev: v.rev, base: v.base };
      return;
    }
    if (v.tipo) return; // segnalazioni: nessun cambiamento da applicare
    if (v.rev <= daRev) return;
    perRev[v.rev] = v; // la più recente vince (non dovrebbe mai esserci un doppione)
    if (v.rev > ultimaNota) ultimaNota = v.rev;
  });
  var out = [];
  var r = daRev + 1;
  while (perRev[r]) { out.push(perRev[r]); r++; }
  var finoA = r - 1;
  return {
    voci: out,
    finoA: finoA,
    ultimaNota: ultimaNota,
    buco: finoA < ultimaNota ? { da: finoA + 1, a: nextOltre(perRev, finoA) } : null,
    lineaNuova: lineaNuova
  };
}

/* Prima revisione presente dopo un buco (per descriverlo: "mancano le revisioni da X a Y"). */
function nextOltre(perRev, finoA) {
  var revs = Object.keys(perRev).map(Number).filter(function (x) { return x > finoA; }).sort(function (a, b) { return a - b; });
  return revs.length ? revs[0] - 1 : finoA + 1;
}

/* Ultima voce del file più recente (letta dalla coda del file, senza leggerlo tutto). */
function ultimaVoce(cartella) {
  var files = elencoFile(cartella).sort(function (a, b) { return a.modificato - b.modificato || (a.nome < b.nome ? -1 : 1); });
  for (var i = files.length - 1; i >= 0; i--) {
    var v = ultimaVoceFile(files[i].percorso);
    if (v) return v;
  }
  return null;
}

function ultimaVoceFile(percorso) {
  var fd;
  try { fd = fs.openSync(percorso, 'r'); } catch (e) { return null; }
  try {
    var dim = fs.fstatSync(fd).size;
    var pezzo = 64 * 1024;
    var letto = Buffer.alloc(0);
    var pos = dim;
    while (pos > 0) {
      var n = Math.min(pezzo, pos);
      pos -= n;
      var b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, pos);
      letto = Buffer.concat([b, letto]);
      var righe = letto.toString('utf8').split('\n');
      // la prima riga del pezzo può essere incompleta (se non siamo all'inizio del file): si guarda dalla fine
      for (var k = righe.length - 1; k >= (pos > 0 ? 1 : 0); k--) {
        if (!righe[k].trim()) continue;
        try {
          var v = JSON.parse(righe[k]);
          if (v && typeof v.rev === 'number') return { rev: v.rev, base: v.base, storia: v.storia, quando: v.quando, tipo: v.tipo };
        } catch (e) { /* riga scritta a metà: si guarda la precedente */ }
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

Giornale.prototype.ultimaVoce = function () {
  if (!this.ultima) this.ultima = ultimaVoce(this.cartella);
  return this.ultima;
};

/* Riassunto per la pagina Sistema. */
Giornale.prototype.stato = function () {
  var files = this.file();
  var ultima = this.ultimaVoce();
  return {
    cartella: this.cartella,
    file: files.length,
    dimensione: files.reduce(function (s, f) { return s + f.dimensione; }, 0),
    dal: files.length ? files[0].nome.slice(0, 10) : null,
    ultimaRevisione: ultima ? ultima.rev : null,
    ultimaScrittura: ultima ? ultima.quando : null,
    scritteSessione: this.scritteSessione,
    errore: this.errore
  };
};

/*
 * Conservazione: si tengono almeno i file che servono a riapplicare il giornale sopra la copia più vecchia
 * conservata (con un margine di due giorni); quelli più vecchi si cancellano. Il file di oggi resta sempre.
 * limiteMs: data della copia più vecchia conservata (ms).
 */
Giornale.prototype.pulisci = function (limiteMs) {
  if (!limiteMs) return 0;
  var self = this;
  var soglia = limiteMs - 2 * 24 * 60 * 60 * 1000;
  var oggi = giorno(new Date()) + '.jsonl';
  var tolti = 0;
  this.file().forEach(function (f) {
    if (f.nome === oggi || f.nome === self.fileAperto || f.modificato >= soglia) return;
    try { fs.unlinkSync(f.percorso); tolti++; } catch (e) { self.log('File del giornale non eliminato: ' + f.nome + ' ' + e.message); }
  });
  return tolti;
};

module.exports = {
  Giornale: Giornale,
  leggi: leggi,
  catena: catena,
  ultimaVoce: ultimaVoce,
  elencoFile: elencoFile,
  giorno: giorno
};
