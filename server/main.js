/*
 * Gestionale Farmacia · Clinica Posillipo — server multiutente.
 *
 *   GestionaleFarmacia.exe [--porta 8080] [--host 0.0.0.0] [--dati <cartella>]
 *   node server/main.js     (durante lo sviluppo)
 */
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var http = require('http');
var https = require('https');

var Database = require('./db.js').Database;
var Accessi = require('./accessi.js').Accessi;
var Operazioni = require('./operazioni.js').Operazioni;
var Backup = require('./backup.js').Backup;
var Server = require('./http.js').Server;

var VERSIONE = '2.0.0';

/* Scrive in console senza mai bloccare il programma: avviato come attività pianificata non c'è una console. */
function stampa(testo, errore) {
  try {
    if (errore) console.error(testo); else console.log(testo);
  } catch (e) { /* nessuna console: resta il file di log */ }
}

function eSea() {
  try { return require('node:sea').isSea(); } catch (e) { return false; }
}

function argomenti(argv) {
  var out = {};
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    var m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    var v = m[2] !== undefined ? m[2] : (argv[i + 1] && argv[i + 1].indexOf('--') !== 0 ? argv[++i] : true);
    out[m[1]] = v;
  }
  return out;
}

function cartellaProgramma() {
  return eSea() ? path.dirname(process.execPath) : path.join(__dirname, '..');
}

function aspettaInvio() {
  // se l'exe è stato aperto con un doppio clic, la finestra resta aperta per leggere l'errore
  var tty = false;
  try { tty = !!process.stdin.isTTY; } catch (e) { tty = false; }
  if (!tty) return Promise.resolve();
  return new Promise(function (ok) {
    stampa('\nPremi Invio per chiudere.');
    process.stdin.resume();
    process.stdin.once('data', function () { ok(); });
  });
}

function fatale(messaggio) {
  stampa('\n' + messaggio + '\n', true);
  try {
    var dir = path.resolve(String(argomenti(process.argv.slice(2)).dati || process.env.GESTIONALE_FARMACIA_DATI || path.join(cartellaProgramma(), 'dati')), 'log');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'errori-avvio.log'), new Date().toISOString() + '  ' + messaggio + os.EOL);
  } catch (e) { /* niente da fare */ }
  aspettaInvio().then(function () { process.exit(1); });
}

function indirizziRete() {
  var out = [];
  var reti = os.networkInterfaces();
  Object.keys(reti).forEach(function (n) {
    (reti[n] || []).forEach(function (r) {
      if (r.family === 'IPv4' && !r.internal) out.push(r.address);
    });
  });
  return out;
}

function avvia() {
  // una console chiusa o assente non deve generare errori a catena
  try { process.stdout.on('error', function () {}); process.stderr.on('error', function () {}); } catch (e) { /* nessuna console */ }
  var arg = argomenti(process.argv.slice(2));
  if (arg.help || arg.aiuto) {
    stampa('Gestionale Farmacia ' + VERSIONE + '\n\n  --porta <n>       porta HTTP (predefinita 8080)\n  --host <ind>      indirizzo di ascolto (predefinito 0.0.0.0, tutta la rete)\n  --dati <cartella> cartella dei dati (predefinita: "dati" accanto al programma)\n');
    return;
  }
  var cartellaDati = path.resolve(String(arg.dati || process.env.GESTIONALE_FARMACIA_DATI || path.join(cartellaProgramma(), 'dati')));
  try { fs.mkdirSync(path.join(cartellaDati, 'log'), { recursive: true }); } catch (e) {
    return fatale('Non riesco a creare la cartella dei dati ' + cartellaDati + ': ' + e.message);
  }

  var conf = {};
  var fileConf = path.join(cartellaDati, 'configurazione.json');
  if (fs.existsSync(fileConf)) {
    try { conf = JSON.parse(fs.readFileSync(fileConf, 'utf8')); } catch (e) {
      return fatale('Il file ' + fileConf + ' non è un JSON valido: ' + e.message);
    }
  }
  var porta = Number(arg.porta || conf.porta || 8080);
  var host = String(arg.host || conf.host || '0.0.0.0');

  function log(msg) {
    var riga = new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + msg;
    stampa(riga);
    try {
      fs.appendFileSync(path.join(cartellaDati, 'log', 'server-' + riga.slice(0, 7) + '.log'), riga + os.EOL);
    } catch (e) { /* il log su file non è indispensabile */ }
  }

  var database;
  try {
    database = new Database(cartellaDati);
  } catch (e) {
    return fatale('Non riesco ad aprire il database in ' + cartellaDati + ': ' + e.message +
      '\nForse il programma è già in esecuzione, oppure la cartella non è scrivibile.');
  }
  var accessi = new Accessi(database, log);
  var server;
  var operazioni = new Operazioni(database, accessi, function (rev) { server.notifica(rev); });
  var backup = new Backup(database, log);

  var opzHttps = null;
  if (conf.https) {
    try {
      var rel = function (f) { return path.resolve(cartellaDati, f); };
      opzHttps = conf.https.pfx
        ? { pfx: fs.readFileSync(rel(conf.https.pfx)), passphrase: conf.https.passphrase }
        : { cert: fs.readFileSync(rel(conf.https.cert)), key: fs.readFileSync(rel(conf.https.key)) };
    } catch (e) {
      return fatale('Certificato HTTPS non leggibile: ' + e.message);
    }
  }

  server = new Server({ database: database, accessi: accessi, operazioni: operazioni, backup: backup, log: log, versione: VERSIONE, https: !!opzHttps });
  var srv = opzHttps ? https.createServer(opzHttps, server.gestore()) : http.createServer(server.gestore());
  srv.keepAliveTimeout = 65000;
  srv.headersTimeout = 70000;

  srv.on('error', function (e) {
    if (e.code === 'EADDRINUSE') return fatale('La porta ' + porta + ' è già usata da un altro programma (forse il Gestionale è già avviato).\nChiudilo, oppure avvia con --porta e un altro numero.');
    if (e.code === 'EACCES') return fatale('Non ho il permesso di usare la porta ' + porta + '. Usa un numero sopra 1024 o avvia come amministratore.');
    fatale('Errore del server: ' + e.message);
  });

  srv.listen(porta, host, function () {
    var schema = opzHttps ? 'https' : 'http';
    log('Gestionale Farmacia ' + VERSIONE + ' avviato. Dati in ' + cartellaDati);
    stampa('');
    stampa('  Sul server:          ' + schema + '://localhost:' + porta + '/');
    indirizziRete().forEach(function (ip) { stampa('  Dagli altri computer: ' + schema + '://' + ip + ':' + porta + '/'); });
    if (!accessi.contaUtenti()) {
      stampa('');
      stampa('  PRIMO AVVIO: apri ' + schema + '://localhost:' + porta + '/ su questo server e crea l’amministratore.');
    }
    stampa('');
    stampa('  Per fermare il programma chiudi questa finestra o premi Ctrl+C.');
    stampa('');
    backup.pianifica();
  });

  var chiusura = false;
  function chiudi() {
    if (chiusura) return;
    chiusura = true;
    log('Arresto del server…');
    backup.ferma();
    server.chiudiTutto();
    srv.close();
    try { database.chiudi(); } catch (e) { /* già chiuso */ }
    setTimeout(function () { process.exit(0); }, 300).unref();
  }
  process.on('SIGINT', chiudi);
  process.on('SIGTERM', chiudi);
  process.on('SIGBREAK', chiudi);
  process.on('uncaughtException', function (e) {
    log('Errore imprevisto: ' + (e && (e.stack || e.message)));
  });
}

avvia();
