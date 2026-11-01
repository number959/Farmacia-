/*
 * Copie di sicurezza del database (versione 3.0 – parte E, docs/NOVITA-3.0.md).
 *
 * - copie automatiche ORARIE del magazzino (farmacia.db) e degli accessi (accessi.db), fatte solo se qualcosa è
 *   cambiato dall'ultima (e comunque una al giorno); conservazione a scaglioni: tutte quelle delle ultime 24 ore,
 *   poi una al giorno per 14 giorni, una alla settimana per 8 settimane, una al mese per 12 mesi;
 * - copie manuali dall'amministratore (ultime 30) e "prima del ripristino" (ultime 30), come nella 2.x;
 * - ogni copia si fa con VACUUM INTO (file completo e coerente) e si VERIFICA subito: si riapre, integrity_check,
 *   conteggi delle tabelle, revisione. L'esito sta in un file .json accanto alla copia (stesso nome);
 * - seconda cartella facoltativa (disco esterno o cartella di rete): ci finiscono le copie verificate e il giornale
 *   delle modifiche. Se non è raggiungibile è un avviso, non un errore: le copie restano comunque nella cartella dati;
 * - ripristino di una copia del magazzino (prima salva una copia dello stato attuale); dopo il ripristino il giornale
 *   riparte da una linea nuova (meta rev_base) e si fa subito una copia verificata dello stato ripristinato;
 * - le copie di accessi.db nella cartella dati portano con sé la chiave della verifica in due passaggi
 *   (chiave-2fa.key, server/accessi.js): accanto a accessi_….db c'è accessi_….chiave-2fa.key (permessi 0600), così
 *   chi rimette la cartella dati da una copia non perde la 2FA degli utenti. La chiave NON va nella seconda cartella
 *   (disco esterno o di rete, spesso meno protetto): lì ci sono solo le copie e il giornale; senza la chiave i segreti
 *   cifrati in accessi.db non servono a niente, e restano validi i codici di recupero (salvati come hash).
 */
'use strict';

var fs = require('fs');
var fsp = fs.promises;
var path = require('path');
var DatabaseSync = require('node:sqlite').DatabaseSync;
var errore = require('./accessi.js').errore;

var TENERE = 30; // copie manuali e "prima del ripristino", per ciascun file
var ORA_MS = 60 * 60 * 1000;
var GIORNO_MS = 24 * ORA_MS;
var SCAGLIONI = { ore: 24, giorni: 14, settimane: 8, mesi: 12 };
var NOME_VALIDO = /^(farmacia|accessi)_\d{4}-\d{2}-\d{2}_\d{6}_(auto|manuale|prima-del-ripristino)\.db$/;
var TABELLE_MAGAZZINO = ['meta', 'impostazioni', 'reparti', 'articoli', 'movimenti'];
var TABELLE_ACCESSI = ['utenti', 'sessioni', 'eventi'];
var ATTESA_SECONDA_MS = 60 * 1000; // una cartella di rete che non risponde entro un minuto è "non raggiungibile"
var FILE_CHIAVE_2FA = 'chiave-2fa.key'; // stesso nome di FILE_CHIAVE in server/accessi.js (cartella dati)


/* Rinomina con pazienza (come in salute.js): su Windows antivirus e programmi di copia bloccano i file per qualche istante. */
var CODICI_BLOCCO = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'];
function aspettaMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { var fine = Date.now() + ms; while (Date.now() < fine) { /* attesa */ } }
}
function rinomina(da, a) {
  var limite = Date.now() + 10000;
  var pausa = 50;
  for (;;) {
    try { fs.renameSync(da, a); return; } catch (e) {
      if (CODICI_BLOCCO.indexOf(e.code) < 0 || Date.now() >= limite) throw e;
      aspettaMs(pausa);
      pausa = Math.min(pausa * 2, 1000);
    }
  }
}

function due(n) { return String(n).padStart(2, '0'); }

function marcaTempo(d) {
  return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate()) + '_' + due(d.getHours()) + due(d.getMinutes()) + due(d.getSeconds());
}

/* Nome della copia → { nome, prefisso, tipo, data (ms, ora locale del nome) } */
function infoNome(nome) {
  var m = /^(farmacia|accessi)_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})_(auto|manuale|prima-del-ripristino)\.db$/.exec(nome);
  if (!m) return null;
  return { nome: nome, prefisso: m[1], tipo: m[8], data: new Date(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]).getTime() };
}

function fileScheda(file) { return file.replace(/\.db$/, '.json'); }

/* Chiave della 2FA salvata accanto a una copia di accessi.db (solo nella cartella dati, mai nella seconda cartella). */
function fileChiave(file) { return file.replace(/\.db$/, '.' + FILE_CHIAVE_2FA); }

/* Toglie una copia con la sua scheda .json e, per accessi.db, la sua chiave della 2FA. */
function togliCopia(file) {
  fs.unlinkSync(file);
  try { fs.unlinkSync(fileScheda(file)); } catch (e) { /* senza scheda (copia della 2.x) */ }
  try { fs.unlinkSync(fileChiave(file)); } catch (e) { /* senza chiave (copia del magazzino, o 2FA mai usata) */ }
}

function leggiScheda(file) {
  try { return JSON.parse(fs.readFileSync(fileScheda(file), 'utf8')); } catch (e) { return null; }
}

function scriviScheda(file, dati) {
  var dest = fileScheda(file);
  var tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dati, null, 1));
  rinomina(tmp, dest);
}

function primoValore(riga) { return riga ? Object.values(riga)[0] : null; }

/*
 * Verifica di un file di copia: si apre in sola lettura, controllo di integrità completo, tabelle attese, conteggi,
 * revisione (magazzino) o "firma" (accessi: ultimo evento e numero di utenti, per sapere se è cambiato qualcosa).
 */
function verificaFile(file, prefisso) {
  var inizio = Date.now();
  var out = { verificata: false, quando: new Date().toISOString(), integrita: '', conteggi: {}, rev: null, base: null, schema: null, firma: null };
  var db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    var righe = db.prepare('PRAGMA integrity_check(20)').all().map(primoValore);
    out.integrita = righe.join('\n');
    var attese = prefisso === 'accessi' ? TABELLE_ACCESSI : TABELLE_MAGAZZINO;
    var tabelle = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(function (r) { return r.name; });
    var mancanti = attese.filter(function (t) { return tabelle.indexOf(t) < 0; });
    tabelle.forEach(function (t) { out.conteggi[t] = db.prepare('SELECT COUNT(*) n FROM "' + t.replace(/"/g, '""') + '"').get().n; });
    out.schema = db.prepare('PRAGMA user_version').get().user_version;
    if (prefisso === 'accessi') {
      if (!mancanti.length) out.firma = (db.prepare('SELECT MAX(id) m FROM eventi').get().m || 0) + ':' + out.conteggi.utenti;
    } else if (!mancanti.length) {
      out.rev = Number(primoValore(db.prepare("SELECT valore FROM meta WHERE chiave = 'rev'").get())) || 0;
      out.base = Number(primoValore(db.prepare("SELECT valore FROM meta WHERE chiave = 'rev_base'").get())) || 0;
    }
    if (righe.length !== 1 || righe[0] !== 'ok') out.errore = 'controllo di integrità non superato: ' + righe.slice(0, 3).join(' · ');
    else if (mancanti.length) out.errore = 'mancano le tabelle ' + mancanti.join(', ');
    else out.verificata = true;
  } catch (e) {
    out.errore = 'il file non si apre: ' + e.message;
  } finally {
    if (db) { try { db.close(); } catch (e) { /* già chiuso */ } }
  }
  out.durataMs = Date.now() - inizio;
  return out;
}

/* Copie presenti in una cartella, dalla più recente: [{ nome, prefisso, tipo, data (ISO), ms, dimensione, verificata, rev, … }] */
function copieIn(cartella) {
  var nomi;
  try { nomi = fs.readdirSync(cartella); } catch (e) { return []; }
  return nomi.filter(function (n) { return NOME_VALIDO.test(n); }).map(function (n) {
    var info = infoNome(n);
    var file = path.join(cartella, n);
    var st;
    try { st = fs.statSync(file); } catch (e) { return null; }
    var sc = leggiScheda(file) || {};
    return {
      nome: n,
      prefisso: info.prefisso,
      tipo: info.tipo,
      data: new Date(info.data).toISOString(),
      ms: info.data,
      dimensione: st.size,
      // null = copia della versione 2.x o non ancora verificata
      verificata: typeof sc.verificata === 'boolean' ? sc.verificata : null,
      verificataIl: sc.quando || null,
      errore: sc.errore || null,
      rev: typeof sc.rev === 'number' ? sc.rev : null,
      base: typeof sc.base === 'number' ? sc.base : null,
      firma: sc.firma || null,
      conteggi: sc.conteggi || null,
      seconda: !!sc.seconda
    };
  }).filter(Boolean).sort(perRecenza);
}

/* Dalla più recente; nello stesso secondo vince la revisione più alta (lo stato più avanti). */
function perRecenza(a, b) {
  return b.ms - a.ms || (b.rev || 0) - (a.rev || 0) || (a.nome < b.nome ? 1 : -1);
}

/* Una copia che al momento di usarla non supera più la verifica (il disco l'ha rovinata): la scheda lo ricorda. */
function segnaNonValida(file, esito) {
  var sc = leggiScheda(file) || {};
  sc.verificata = false;
  sc.errore = esito.errore || 'non supera più la verifica';
  sc.quando = new Date().toISOString();
  try { scriviScheda(file, sc); } catch (e) { /* cartella in sola lettura: resta l'esito vecchio */ }
}

/* Settimana ISO (lunedì–domenica) di una data locale: 'AAAA-Wnn' */
function settimana(d) {
  var g = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var giornoSett = (g.getDay() + 6) % 7; // lunedì = 0
  g.setDate(g.getDate() - giornoSett + 3); // giovedì della stessa settimana
  var primoGiovedi = new Date(g.getFullYear(), 0, 4);
  var n = 1 + Math.round(((g - primoGiovedi) / GIORNO_MS - 3 + ((primoGiovedi.getDay() + 6) % 7)) / 7);
  return g.getFullYear() + '-W' + due(n);
}

/*
 * Conservazione a scaglioni delle copie automatiche di UN file (farmacia o accessi). Restituisce l'insieme dei nomi
 * da tenere:
 *   - tutte le copie delle ultime 24 ore;
 *   - la più recente di ciascuno degli ultimi 14 giorni che hanno copie;
 *   - la più recente di ciascuna delle ultime 8 settimane che hanno copie;
 *   - la più recente di ciascuno degli ultimi 12 mesi che hanno copie;
 *   - sempre la copia verificata più recente, e le copie "dal futuro" (orologio spostato: non si toccano).
 * Dentro ogni scaglione si preferisce una copia verificata (o della 2.x, non ancora verificata) a una non riuscita.
 * copie: [{ nome, data (ISO | ms | Date), verificata }]; adesso: ms.
 */
function daConservare(copie, adesso, scaglioni) {
  scaglioni = scaglioni || SCAGLIONI;
  adesso = adesso === undefined ? Date.now() : Number(adesso);
  var elenco = copie.map(function (c) { return { c: c, t: new Date(c.data).getTime() }; })
    .sort(function (a, b) { return b.t - a.t; });
  var tenere = new Set();
  elenco.forEach(function (x) {
    if (x.t > adesso || adesso - x.t < scaglioni.ore * ORA_MS) tenere.add(x.c.nome);
  });
  var verificata = elenco.filter(function (x) { return x.c.verificata === true; })[0];
  if (verificata) tenere.add(verificata.c.nome);
  function scaglione(chiave, quanti) {
    var gruppi = [];
    var perChiave = {};
    elenco.forEach(function (x) {
      var k = chiave(new Date(x.t));
      if (!perChiave[k]) { perChiave[k] = []; gruppi.push(k); }
      perChiave[k].push(x);
    });
    gruppi.slice(0, quanti).forEach(function (k) {
      var g = perChiave[k];
      var buona = g.filter(function (x) { return x.c.verificata !== false; })[0];
      tenere.add((buona || g[0]).c.nome);
    });
  }
  scaglione(function (d) { return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate()); }, scaglioni.giorni);
  scaglione(settimana, scaglioni.settimane);
  scaglione(function (d) { return d.getFullYear() + '-' + due(d.getMonth() + 1); }, scaglioni.mesi);
  return tenere;
}

/*
 * Nomi da eliminare fra le copie di una cartella: scaglioni per le automatiche, ultime 30 per le altre,
 * separatamente per farmacia e accessi.
 */
function daEliminare(copie, adesso) {
  var via = [];
  ['farmacia', 'accessi'].forEach(function (pref) {
    var mie = copie.filter(function (c) { return c.prefisso === pref; });
    var auto = mie.filter(function (c) { return c.tipo === 'auto'; });
    var tenere = daConservare(auto, adesso);
    auto.forEach(function (c) { if (!tenere.has(c.nome)) via.push(c.nome); });
    ['manuale', 'prima-del-ripristino'].forEach(function (tipo) {
      mie.filter(function (c) { return c.tipo === tipo; })
        .sort(function (a, b) { return a.nome < b.nome ? 1 : -1; })
        .slice(TENERE).forEach(function (c) { via.push(c.nome); });
    });
  });
  return via;
}

function spazioLibero(cartella) {
  try {
    var s = fs.statfsSync(cartella);
    return { libero: s.bavail * s.bsize, totale: s.blocks * s.bsize };
  } catch (e) { return null; }
}

function dimensioneFile(f) { try { return fs.statSync(f).size; } catch (e) { return 0; } }

/* ---------- Backup ---------- */

/*
 * opz (facoltativo): { secondaCartella: percorso dal file configurazione.json }
 * Dopo la creazione: backup.giornale (server/giornale.js) e backup.salute (server/salute.js), se ci sono.
 */
function Backup(database, log, opz) {
  opz = opz || {};
  this.database = database;
  this.log = log || function () {};
  this.cartella = path.join(database.cartella, 'backup');
  fs.mkdirSync(this.cartella, { recursive: true });
  this.giornale = null;
  this.seconda = {
    percorso: opz.secondaCartella ? String(opz.secondaCartella) : '',
    origine: opz.secondaCartella ? 'configurazione' : '',
    raggiungibile: null,
    ultimaSincronizzazione: null,
    errore: null,
    inCorso: false,
    revGiornale: null // revisione del giornale arrivata nella seconda cartella con l'ultima sincronizzazione riuscita
  };
  this.ultimoErrore = null; // { quando, messaggio } dell'ultima copia automatica non riuscita
}

/*
 * Crea la copia di un database (db: connessione aperta) e la verifica. Restituisce il nome del file.
 * Una copia non verificata resta nella cartella (si può scaricare e guardare) ma è segnata come non riuscita
 * e non si usa per la cura automatica.
 */
Backup.prototype.copia = function (db, prefisso, tipo) {
  var spazio = spazioLibero(this.cartella);
  var serve = dimensioneFile(prefisso === 'accessi' ? this.database.fileAccessi : this.database.fileDati) + 20 * 1024 * 1024;
  if (spazio && spazio.libero < serve) {
    throw errore(507, 'Spazio su disco insufficiente per una copia di sicurezza: liberane un po’ nel disco della cartella dati.');
  }
  var nome = prefisso + '_' + marcaTempo(new Date()) + '_' + tipo + '.db';
  var file = path.join(this.cartella, nome);
  var n = 1;
  while (fs.existsSync(file)) {
    nome = prefisso + '_' + marcaTempo(new Date(Date.now() + 1000 * n++)) + '_' + tipo + '.db';
    file = path.join(this.cartella, nome);
  }
  db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
  var esito = verificaFile(file, prefisso);
  esito.nome = nome;
  esito.file = prefisso;
  esito.tipo = tipo;
  esito.creata = new Date().toISOString();
  esito.dimensione = dimensioneFile(file);
  if (prefisso === 'farmacia') esito.storia = this.database.storia;
  if (prefisso === 'accessi') esito.chiave2fa = this.copiaChiave2fa(file);
  try { scriviScheda(file, esito); } catch (e) { this.log('Esito della verifica non salvato per ' + nome + ': ' + e.message); }
  if (!esito.verificata) this.log('ATTENZIONE: la copia ' + nome + ' NON ha superato la verifica (' + esito.errore + ').');
  return nome;
};

/*
 * Copia la chiave della verifica in due passaggi (<dati>/chiave-2fa.key) accanto alla copia di accessi.db, leggibile
 * solo dal servizio come l'originale. Senza file della chiave (nessuno ha mai attivato la 2FA) non c'è niente da copiare.
 * Restituisce true se la copia della chiave c'è. Un errore qui non ferma la copia: si scrive nel registro del server.
 */
Backup.prototype.copiaChiave2fa = function (fileCopia) {
  var origine = path.join(this.database.cartella, FILE_CHIAVE_2FA);
  var dest = fileChiave(fileCopia);
  try {
    var chiave = fs.readFileSync(origine);
    fs.writeFileSync(dest, chiave, { mode: 384 /* 0600 */ });
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') this.log('ATTENZIONE: chiave della verifica in due passaggi non copiata con ' + path.basename(fileCopia) + ': ' + e.message);
    return false;
  }
};

/* Copia del magazzino (come nella 2.x: POST /api/backup). */
Backup.prototype.crea = function (tipo) {
  var nome = this.copia(this.database.dati, 'farmacia', tipo || 'manuale');
  this.pulisci();
  this.log('Copia di sicurezza creata: ' + nome);
  this.sincronizzaSeconda();
  return nome;
};

/* Copia di magazzino e accessi insieme (pagina Sistema, "Copia adesso"). */
Backup.prototype.creaTutte = function (tipo) {
  var nomi = [this.copia(this.database.dati, 'farmacia', tipo || 'manuale'), this.copia(this.database.accessi, 'accessi', tipo || 'manuale')];
  this.pulisci();
  this.log('Copie di sicurezza create: ' + nomi.join(', '));
  this.sincronizzaSeconda();
  return nomi;
};

/* Elenco delle copie del magazzino (GET /api/backup, pagina Configura): come nella 2.x, più l'esito della verifica. */
Backup.prototype.elenco = function () {
  return this.elencoCompleto().filter(function (c) { return c.prefisso === 'farmacia'; });
};

/* Tutte le copie (magazzino e accessi), dalla più recente. */
Backup.prototype.elencoCompleto = function () {
  return copieIn(this.cartella).map(function (c) {
    return {
      nome: c.nome, prefisso: c.prefisso, tipo: c.tipo, data: c.data, dimensione: c.dimensione,
      verificata: c.verificata, verificataIl: c.verificataIl, errore: c.errore, rev: c.rev, base: c.base, firma: c.firma,
      conteggi: c.conteggi, seconda: c.seconda
    };
  });
};

Backup.prototype.percorso = function (nome) {
  if (!NOME_VALIDO.test(String(nome || ''))) throw errore(404, 'Copia non trovata.');
  var file = path.join(this.cartella, nome);
  if (!fs.existsSync(file)) throw errore(404, 'Copia non trovata.');
  return file;
};

/* Ultima copia di un file (prefisso), di qualsiasi tipo o di un tipo solo. */
Backup.prototype.ultima = function (prefisso, tipo) {
  return copieIn(this.cartella).filter(function (c) { return c.prefisso === prefisso && (!tipo || c.tipo === tipo); })[0] || null;
};

/* Conservazione: elimina le copie in più (e il loro .json), poi il giornale più vecchio della copia più vecchia. */
Backup.prototype.pulisci = function () {
  var self = this;
  var copie = copieIn(this.cartella);
  var via = daEliminare(copie, Date.now());
  via.forEach(function (n) {
    var file = path.join(self.cartella, n);
    try {
      togliCopia(file);
    } catch (e) { self.log('Copia vecchia non eliminata: ' + n + ' ' + e.message); }
  });
  if (this.giornale) {
    var rimaste = copie.filter(function (c) { return c.prefisso === 'farmacia' && via.indexOf(c.nome) < 0; });
    var piuVecchia = rimaste.length ? rimaste[rimaste.length - 1].ms : 0;
    try { this.giornale.pulisci(piuVecchia); } catch (e) { this.log('Giornale vecchio non eliminato: ' + e.message); }
  }
  return via.length;
};

/*
 * Copie automatiche (si chiama ogni pochi minuti): magazzino e accessi se dall'ultima copia automatica è passata
 * almeno un'ora ed è cambiato qualcosa dall'ultima copia (di qualsiasi tipo), oppure se sono passate 24 ore.
 * opz.forza: subito, se è cambiato qualcosa. opz.motivo: testo per il registro del server.
 * Restituisce i nomi delle copie create.
 */
Backup.prototype.automatica = function (opz) {
  opz = opz || {};
  var adesso = Date.now();
  var fatte = [];
  var self = this;
  var rev = this.database.rev();
  var firma = firmaAccessi(this.database.accessi);
  [
    { pref: 'farmacia', db: this.database.dati, cambiato: function (u) { return !u || u.rev !== rev; } },
    { pref: 'accessi', db: this.database.accessi, cambiato: function (u) { return !u || u.firma !== firma; } }
  ].forEach(function (x) {
    var u = self.ultima(x.pref, 'auto');
    var eta = u ? adesso - u.ms : Infinity;
    var cambiato = x.cambiato(self.ultima(x.pref));
    var serve = !u || eta >= GIORNO_MS || ((opz.forza || eta >= ORA_MS - 2 * 60 * 1000) && cambiato);
    if (!serve) return;
    fatte.push(self.copia(x.db, x.pref, 'auto'));
  });
  if (fatte.length) {
    this.pulisci();
    this.log((opz.motivo || 'Copia di sicurezza automatica') + ': ' + fatte.join(', '));
    this.sincronizzaSeconda();
  }
  return fatte;
};

function firmaAccessi(db) {
  try {
    return (db.prepare('SELECT MAX(id) m FROM eventi').get().m || 0) + ':' + db.prepare('SELECT COUNT(*) n FROM utenti').get().n;
  } catch (e) { return null; }
}

/* Alla chiusura del programma: una copia se dall'ultima è cambiato qualcosa. */
Backup.prototype.copiaFinale = function () {
  return this.automatica({ forza: true, motivo: 'Copia di chiusura' });
};

/* Verifica una copia vecchia mai verificata (per esempio della 2.x): una per volta, per non fermare il server. */
Backup.prototype.verificaUnaVecchia = function () {
  var c = copieIn(this.cartella).filter(function (x) { return x.verificata === null; })[0];
  if (!c) return null;
  var file = path.join(this.cartella, c.nome);
  var esito = verificaFile(file, c.prefisso);
  esito.nome = c.nome;
  esito.file = c.prefisso;
  esito.tipo = c.tipo;
  esito.dimensione = c.dimensione;
  esito.creata = c.data;
  try { scriviScheda(file, esito); } catch (e) { this.log('Esito della verifica non salvato per ' + c.nome + ': ' + e.message); }
  if (!esito.verificata) this.log('ATTENZIONE: la copia ' + c.nome + ' non ha superato la verifica (' + esito.errore + ').');
  return esito;
};

/* Per compatibilità con la 2.x: la pianificazione ora la fa server/salute.js (copie orarie e controllo notturno). */
Backup.prototype.pianifica = function () {
  var self = this;
  function giro() {
    try { self.automatica(); } catch (e) { self.log('Copia automatica non riuscita: ' + e.message); }
  }
  giro();
  if (this.timer) return;
  this.timer = setInterval(giro, 5 * 60 * 1000);
  if (this.timer.unref) this.timer.unref();
};

Backup.prototype.ferma = function () {
  if (this.timer) clearInterval(this.timer);
  this.timer = null;
};

/*
 * Contatori dei numeri di richieste e DDT (RIC-AAAA-NNNN, DDT-AAAA-NNNN, server/logistica.js prossimoNumero): stanno in
 * meta (prog_ric_AAAA, prog_ddt_AAAA), che il giornale non registra. Un numero già stampato su un DDT partito non deve
 * tornare libero: dopo un ripristino o una linea nuova i contatori ripartono dal più alto fra file attuale, copia e
 * giornale. leggiContatori: { chiave: progressivo più alto } da meta e dalle righe di richieste e DDT.
 */
function leggiContatori(db) {
  var out = {};
  function tieni(k, n) { n = Number(n) || 0; if (n > (out[k] || 0)) out[k] = n; }
  try {
    db.prepare("SELECT chiave, valore FROM meta WHERE chiave LIKE 'prog_%'").all().forEach(function (r) {
      if (/^prog_(ric|ddt)_\d{4}$/.test(r.chiave)) tieni(r.chiave, r.valore);
    });
    [['ric', 'richieste'], ['ddt', 'ddt']].forEach(function (x) {
      db.prepare('SELECT anno, MAX(progressivo) m FROM ' + x[1] + ' GROUP BY anno').all().forEach(function (r) { tieni('prog_' + x[0] + '_' + r.anno, r.m); });
    });
  } catch (e) { /* archivio senza le tabelle della 3.0 */ }
  return out;
}

/* Porta i contatori del magazzino aperto (database: server/db.js) almeno ai valori di "contatori". Restituisce quelli alzati. */
function portaContatori(database, contatori) {
  var alzati = {};
  Object.keys(contatori || {}).forEach(function (k) {
    if (!/^prog_(ric|ddt)_\d{4}$/.test(k)) return;
    var n = Number(contatori[k]) || 0;
    if (n > (Number(database.meta(k)) || 0)) { database.impostaMeta(k, n); alzati[k] = n; }
  });
  return alzati;
}

/* Controlla che il file sia un archivio del magazzino integro: restituisce la sua revisione. */
function controllaCopia(file) {
  var v = verificaFile(file, 'farmacia');
  if (/mancano le tabelle/.test(v.errore || '')) throw errore(400, 'Il file non è una copia del magazzino.');
  if (!v.verificata) throw errore(400, 'La copia è danneggiata e non si può ripristinare.');
  return v.rev || 0;
}

/*
 * Ripristina una copia del magazzino. La revisione riparte da sopra quella attuale e diventa la "base":
 * i client che chiedono cambiamenti da una revisione precedente ricevono tutto (completo: true).
 * Il giornale segna l'inizio della linea nuova e si fa subito una copia verificata dello stato ripristinato:
 * da lì la cura automatica potrà ricostruire le modifiche successive.
 */
Backup.prototype.ripristina = function (nome) {
  var file = this.percorso(nome);
  if (nome.indexOf('farmacia_') !== 0) throw errore(400, 'Si possono ripristinare solo le copie del magazzino.');
  var revCopia = controllaCopia(file);
  var revAttuale = this.database.rev();
  // i numeri di richieste e DDT già dati (anche dopo la copia) restano usati
  var contatori = leggiContatori(this.database.dati);
  var sicurezza = this.copia(this.database.dati, 'farmacia', 'prima-del-ripristino');
  var destinazione = this.database.fileDati;
  var temporaneo = destinazione + '.ripristino';
  fs.copyFileSync(file, temporaneo);
  this.database.chiudiDati();
  try {
    ['-wal', '-shm'].forEach(function (s) { try { fs.unlinkSync(destinazione + s); } catch (e) { /* non c'era */ } });
    rinomina(temporaneo, destinazione);
  } finally {
    this.database.apri();
  }
  var nuova = Math.max(revAttuale, revCopia, this.giornale && this.giornale.ultimaVoce() ? this.giornale.ultimaVoce().rev : 0) + 1;
  this.database.impostaMeta('rev', nuova);
  this.database.impostaMeta('rev_base', nuova);
  this.database.segnaSessione();
  portaContatori(this.database, contatori);
  // la linea nuova va subito nel file principale: senza, un WAL perso riporterebbe il magazzino alla linea vecchia
  var durevole = this.database.fissaSulDisco();
  if (this.giornale) this.giornale.segnaLinea('ripristino', durevole ? { copia: nome, revCopia: revCopia, durevole: true } : { copia: nome, revCopia: revCopia });
  var dopo = null;
  try { dopo = this.copia(this.database.dati, 'farmacia', 'auto'); } catch (e) { this.log('Copia dopo il ripristino non riuscita: ' + e.message); }
  this.pulisci();
  this.log('Ripristinata la copia ' + nome + ' (copia dello stato precedente: ' + sicurezza + (dopo ? '; copia dello stato ripristinato: ' + dopo : '') + ').');
  this.sincronizzaSeconda();
  return { rev: nuova, sicurezza: sicurezza };
};

/* ---------- seconda cartella ---------- */

Backup.prototype.impostaSeconda = function (percorso, origine) {
  this.seconda.percorso = percorso ? String(percorso) : '';
  this.seconda.origine = percorso ? (origine || 'pagina') : '';
  this.seconda.raggiungibile = null;
  this.seconda.errore = null;
  this.seconda.ultimaSincronizzazione = null;
  this.seconda.revGiornale = null;
};

Backup.prototype.statoSeconda = function () {
  var s = this.seconda;
  return {
    percorso: s.percorso || '',
    origine: s.origine || '',
    raggiungibile: s.percorso ? s.raggiungibile : null,
    ultimaSincronizzazione: s.ultimaSincronizzazione,
    errore: s.errore,
    inCorso: s.inCorso
  };
};

function conAttesa(promessa, ms) {
  var timer;
  return Promise.race([
    promessa,
    new Promise(function (ok, ko) {
      timer = setTimeout(function () { ko(new Error('la cartella non risponde da ' + Math.round(ms / 1000) + ' secondi')); }, ms);
      if (timer.unref) timer.unref();
    })
  ]).then(function (x) { clearTimeout(timer); return x; }, function (e) { clearTimeout(timer); throw e; });
}

function esisteAsync(f) {
  return fsp.stat(f).then(function (st) { return st; }, function () { return null; });
}

/* Copia un file nella seconda cartella passando da un nome temporaneo (un file a metà non sembra mai una copia). */
function copiaAsync(da, a) {
  var tmp = a + '.parziale';
  return fsp.copyFile(da, tmp).then(function () { return fsp.rename(tmp, a); });
}

/*
 * Sincronizza la seconda cartella (in sottofondo, senza fermare il server): copie verificate che mancano, scaglioni
 * di conservazione anche lì, file del giornale cambiati. Restituisce una promessa che non fallisce mai: l'esito sta
 * in statoSeconda().
 * Se arriva mentre un giro è già in corso (una copia fatta mentre la seconda cartella si aggiorna), il giro in corso
 * può non vederla: se ne fa un altro appena finisce (uno solo, per quante chiamate arrivino), e la promessa
 * restituita aspetta anche quello.
 */
Backup.prototype.sincronizzaSeconda = function () {
  // l'ultima promessa data: chi ha appena fatto una copia (POST /api/sistema/copia) aspetta che arrivi anche lì
  this.attesaSeconda = this.giroSeconda();
  return this.attesaSeconda;
};

Backup.prototype.giroSeconda = function () {
  var self = this;
  var s = this.seconda;
  if (!s.percorso) return Promise.resolve(this.statoSeconda());
  if (s.inCorso) {
    if (!this.giroDopo) {
      this.giroDopo = (this.fineGiro || Promise.resolve()).then(function () {
        self.giroDopo = null;
        return self.sincronizzaSeconda();
      });
    }
    // chi aspetta non aspetta per sempre una cartella di rete appesa: dopo il limite risponde con lo stato attuale
    var stato = function () { return self.statoSeconda(); };
    return conAttesa(this.giroDopo, 2 * ATTESA_SECONDA_MS).then(stato, stato);
  }
  var dest = s.percorso;
  s.inCorso = true;
  var copiate = 0;
  // revisione del giornale che questo giro porta nella seconda cartella (server/salute.js: giro ogni 5 minuti)
  var revGiornale = null;
  try { revGiornale = this.giornale && this.giornale.ultimaVoce() ? this.giornale.ultimaVoce().rev : null; } catch (e) { revGiornale = null; }
  var lavoro = fsp.mkdir(dest, { recursive: true }).then(function () {
    return fsp.readdir(dest);
  }).then(function (presenti) {
    // file rimasti a metà da una sincronizzazione interrotta (programma fermato mentre copiava)
    presenti.filter(function (n) { return /\.parziale$/.test(n); }).forEach(function (n) { fsp.unlink(path.join(dest, n)).catch(function () { /* già tolto */ }); });
    var locali = copieIn(self.cartella).filter(function (c) { return c.verificata === true; });
    // dalla più vecchia: se la cartella si riempie, almeno le copie in ordine
    return locali.reverse().reduce(function (p, c) {
      return p.then(function () {
        if (presenti.indexOf(c.nome) >= 0) return null;
        var file = path.join(self.cartella, c.nome);
        // solo la copia e la sua scheda: la chiave della 2FA (accessi_….chiave-2fa.key) resta nella cartella dati
        return copiaAsync(file, path.join(dest, c.nome)).then(function () {
          copiate++;
          return copiaAsync(fileScheda(file), path.join(dest, c.nome.replace(/\.db$/, '.json'))).catch(function () { /* senza scheda */ });
        }).then(function () {
          // la copia locale ricorda di essere anche nella seconda cartella
          var sc = leggiScheda(file);
          if (sc) { sc.seconda = true; try { scriviScheda(file, sc); } catch (e) { /* non indispensabile */ } }
        });
      });
    }, Promise.resolve());
  }).then(function () {
    // conservazione a scaglioni anche nella seconda cartella (mai copiando le cancellazioni della cartella dati:
    // se il disco del server si rompe e si riparte da zero, la seconda cartella non deve svuotarsi)
    return fsp.readdir(dest).then(function (nomi) {
      var copie = nomi.filter(function (n) { return NOME_VALIDO.test(n); }).map(function (n) {
        var i = infoNome(n);
        return { nome: n, prefisso: i.prefisso, tipo: i.tipo, data: i.data, ms: i.data, verificata: null };
      });
      var via = daEliminare(copie, Date.now());
      return Promise.all(via.map(function (n) {
        return fsp.unlink(path.join(dest, n)).then(function () {
          return fsp.unlink(path.join(dest, n.replace(/\.db$/, '.json'))).catch(function () { /* senza scheda */ });
        }).catch(function () { /* già tolta */ });
      }));
    });
  }).then(function () {
    if (!self.giornale) return null;
    var destGiornale = path.join(dest, 'giornale');
    return fsp.mkdir(destGiornale, { recursive: true }).then(function () {
      return self.giornale.file().reduce(function (p, f) {
        return p.then(function () {
          return esisteAsync(path.join(destGiornale, f.nome)).then(function (st) {
            if (st && st.size === f.dimensione) return null;
            return copiaAsync(f.percorso, path.join(destGiornale, f.nome));
          });
        });
      }, Promise.resolve());
    });
  });
  // un'operazione rimasta appesa (cartella di rete che non risponde) libera il posto solo quando finisce davvero
  function fine() { s.inCorso = false; }
  this.fineGiro = lavoro.then(fine, fine);
  return conAttesa(lavoro, ATTESA_SECONDA_MS).then(function () {
    if (s.percorso !== dest) return;
    if (s.raggiungibile === false) self.log('La seconda cartella delle copie è di nuovo raggiungibile: ' + dest);
    s.raggiungibile = true;
    s.errore = null;
    s.ultimaSincronizzazione = new Date().toISOString();
    s.revGiornale = revGiornale;
    if (copiate) self.log('Seconda cartella aggiornata (' + copiate + (copiate === 1 ? ' copia nuova' : ' copie nuove') + '): ' + dest);
  }, function (e) {
    if (s.percorso !== dest) return;
    if (s.raggiungibile !== false) self.log('ATTENZIONE: la seconda cartella delle copie non è raggiungibile (' + dest + '): ' + e.message + '. Le copie restano nella cartella dati.');
    s.raggiungibile = false;
    s.errore = e.message;
  }).then(function () {
    return self.statoSeconda();
  });
};

/* Il giornale è andato avanti dall'ultima sincronizzazione riuscita della seconda cartella? */
Backup.prototype.giornaleDaPortare = function () {
  var s = this.seconda;
  if (!s.percorso || !this.giornale) return false;
  var u = null;
  try { u = this.giornale.ultimaVoce(); } catch (e) { u = null; }
  return !!u && u.rev !== s.revGiornale;
};

module.exports = {
  Backup: Backup,
  verificaFile: verificaFile,
  leggiContatori: leggiContatori,
  portaContatori: portaContatori,
  segnaNonValida: segnaNonValida,
  perRecenza: perRecenza,
  copieIn: copieIn,
  daConservare: daConservare,
  daEliminare: daEliminare,
  settimana: settimana,
  infoNome: infoNome,
  fileChiave: fileChiave,
  FILE_CHIAVE_2FA: FILE_CHIAVE_2FA,
  spazioLibero: spazioLibero,
  NOME_VALIDO: NOME_VALIDO,
  SCAGLIONI: SCAGLIONI
};
