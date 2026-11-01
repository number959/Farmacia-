/*
 * Gestionale Farmacia · Clinica Posillipo — server multiutente.
 *
 *   GestionaleFarmacia.exe [--porta 8080] [--host <indirizzo>] [--dati <cartella>]
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

var VERSIONE = '3.0.0';

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
  // se l'exe è stato aperto con un doppio clic, la finestra resta aperta per leggere l'errore.
  // Avviato come servizio (--servizio) non c'è nessuno a premere Invio: si esce subito, e
  // comunque dopo 2 minuti, così l'attività pianificata può riprovare.
  if (argomenti(process.argv.slice(2)).servizio) return Promise.resolve();
  var tty = false;
  try { tty = !!process.stdin.isTTY; } catch (e) { tty = false; }
  if (!tty) return Promise.resolve();
  return new Promise(function (ok) {
    stampa('\nPremi Invio per chiudere.');
    setTimeout(ok, 120000).unref();
    try {
      process.stdin.resume();
      process.stdin.once('data', function () { ok(); });
    } catch (e) { ok(); }
  });
}

/* Ora locale per il registro del server (le copie di sicurezza usano la stessa ora nel nome). */
function oraLocale(d) {
  function due(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate()) + ' ' + due(d.getHours()) + ':' + due(d.getMinutes()) + ':' + due(d.getSeconds());
}

/* configurazione.json scritto con il Blocco note o con PowerShell può avere il BOM o essere in UTF-16. */
function leggiJson(file) {
  var b = fs.readFileSync(file);
  var testo = b[0] === 0xff && b[1] === 0xfe ? b.slice(2).toString('utf16le') : b.toString('utf8');
  return JSON.parse(testo.replace(/^\uFEFF/, ''));
}

function fatale(messaggio) {
  stampa('\n' + messaggio + '\n', true);
  try {
    var dir = path.resolve(String(argomenti(process.argv.slice(2)).dati || process.env.GESTIONALE_FARMACIA_DATI || path.join(cartellaProgramma(), 'dati')), 'log');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'errori-avvio.log'), oraLocale(new Date()) + '  ' + messaggio + os.EOL);
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
  process.on('uncaughtException', function (e) {
    // prima dell'avvio completo un errore va almeno in dati\log\errori-avvio.log
    fatale('Errore imprevisto: ' + (e && (e.stack || e.message)));
  });
  var arg = argomenti(process.argv.slice(2));
  if (arg.help || arg.aiuto) {
    stampa('Gestionale Farmacia ' + VERSIONE + '\n\n' +
      '  --porta <n>                    porta HTTP (predefinita 8080)\n' +
      '  --host <ind>                   indirizzo di ascolto (predefinito: tutta la rete, IPv4 e IPv6)\n' +
      '  --dati <cartella>              cartella dei dati (predefinita: "dati" accanto al programma)\n' +
      '  --reimposta-password <utente>  accesso d\'emergenza: nuova password provvisoria per l\'utente, poi esce\n');
    return;
  }
  var cartellaDati = path.resolve(String(arg.dati || process.env.GESTIONALE_FARMACIA_DATI || path.join(cartellaProgramma(), 'dati')));
  try { fs.mkdirSync(path.join(cartellaDati, 'log'), { recursive: true }); } catch (e) {
    return fatale('Non riesco a creare la cartella dei dati ' + cartellaDati + ': ' + e.message);
  }

  var conf = {};
  var fileConf = path.join(cartellaDati, 'configurazione.json');
  if (fs.existsSync(fileConf)) {
    try { conf = leggiJson(fileConf); } catch (e) {
      return fatale('Il file ' + fileConf + ' non è un JSON valido: ' + e.message);
    }
  }
  var porta = Number(arg.porta || conf.porta || 8080);
  if (!(porta >= 1 && porta <= 65535 && Math.floor(porta) === porta)) return fatale('Porta non valida: ' + (arg.porta || conf.porta) + '. Usa un numero intero tra 1 e 65535.');
  // senza --host ascolta su IPv4 e IPv6: su Windows "localhost" prova prima ::1 e con solo IPv4 ogni collegamento
  // da localhost aspetterebbe un paio di secondi prima di ripiegare su 127.0.0.1
  var host = arg.host || conf.host ? String(arg.host || conf.host) : null;

  function log(msg) {
    var riga = oraLocale(new Date()) + '  ' + msg;
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

  // accesso d'emergenza: si usa sul server, anche mentre il servizio è in funzione
  if (arg['reimposta-password']) {
    try {
      var provvisoria = accessi.passwordEmergenza(String(arg['reimposta-password']));
      stampa('\nNuova password provvisoria per "' + arg['reimposta-password'] + '":  ' + provvisoria +
        '\nAl prossimo accesso il programma chiederà di cambiarla. L\'utente è stato anche riattivato.\n');
      database.chiudi();
      return aspettaInvio().then(function () { process.exit(0); });
    } catch (e) {
      database.chiudi();
      return fatale(e.message);
    }
  }
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
  var srv;
  try {
    srv = opzHttps ? https.createServer(opzHttps, server.gestore()) : http.createServer(server.gestore());
  } catch (e) {
    return fatale('Certificato HTTPS non valido (chiave, passphrase o formato): ' + e.message);
  }
  srv.keepAliveTimeout = 65000;
  srv.headersTimeout = 70000;
  srv.requestTimeout = 60000; // una richiesta deve arrivare intera entro un minuto

  srv.on('error', function (e) {
    if (!host && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL') && !srv.soloIpv4) {
      // IPv6 disattivato sul server: solo IPv4
      srv.soloIpv4 = true;
      return srv.listen(porta, '0.0.0.0');
    }
    if (e.code === 'EADDRINUSE') return fatale('La porta ' + porta + ' è già usata da un altro programma (forse il Gestionale è già avviato).\nChiudilo, oppure avvia con --porta e un altro numero.');
    if (e.code === 'EACCES') return fatale('Non ho il permesso di usare la porta ' + porta + '. Usa un numero sopra 1024 o avvia come amministratore.');
    fatale('Errore del server: ' + e.message);
  });

  srv.once('listening', avviato);
  if (host) srv.listen(porta, host);
  else srv.listen({ port: porta, host: '::', ipv6Only: false });

  function avviato() {
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
  }

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
  // da qui in poi un errore imprevisto si registra ma il server resta in funzione
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', function (e) {
    log('Errore imprevisto: ' + (e && (e.stack || e.message)));
  });
}

avvia();
