/*
 * Copie di sicurezza del database.
 * - una copia automatica al giorno del magazzino (farmacia.db) e degli accessi (accessi.db), ultime 30
 * - copie manuali dall'amministratore, ultime 30
 * - ripristino di una copia del magazzino (prima salva una copia dello stato attuale)
 * Le copie si fanno con VACUUM INTO: il file risultante è un database completo e coerente.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var DatabaseSync = require('node:sqlite').DatabaseSync;
var errore = require('./accessi.js').errore;

var TENERE = 30;
var NOME_VALIDO = /^(farmacia|accessi)_\d{4}-\d{2}-\d{2}_\d{6}_(auto|manuale|prima-del-ripristino)\.db$/;

function due(n) { return String(n).padStart(2, '0'); }

function marcaTempo(d) {
  return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate()) + '_' + due(d.getHours()) + due(d.getMinutes()) + due(d.getSeconds());
}

function Backup(database, log) {
  this.database = database;
  this.log = log || function () {};
  this.cartella = path.join(database.cartella, 'backup');
  fs.mkdirSync(this.cartella, { recursive: true });
}

Backup.prototype.copia = function (db, prefisso, tipo) {
  var nome = prefisso + '_' + marcaTempo(new Date()) + '_' + tipo + '.db';
  var file = path.join(this.cartella, nome);
  var n = 1;
  while (fs.existsSync(file)) {
    nome = prefisso + '_' + marcaTempo(new Date(Date.now() + 1000 * n++)) + '_' + tipo + '.db';
    file = path.join(this.cartella, nome);
  }
  db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
  return nome;
};

Backup.prototype.crea = function (tipo) {
  var nome = this.copia(this.database.dati, 'farmacia', tipo || 'manuale');
  this.pulisci();
  this.log('Copia di sicurezza creata: ' + nome);
  return nome;
};

Backup.prototype.elenco = function () {
  var self = this;
  return fs.readdirSync(this.cartella)
    .filter(function (n) { return NOME_VALIDO.test(n) && n.indexOf('farmacia_') === 0; })
    .map(function (n) {
      var st = fs.statSync(path.join(self.cartella, n));
      var tipo = n.replace(/^.*_(auto|manuale|prima-del-ripristino)\.db$/, '$1');
      var m = n.match(/_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})_/);
      var data = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString() : st.mtime.toISOString();
      return { nome: n, dimensione: st.size, data: data, tipo: tipo };
    })
    .sort(function (a, b) { return a.nome < b.nome ? 1 : -1; })
    .sort(function (a, b) { return a.data < b.data ? 1 : a.data > b.data ? -1 : 0; });
};

Backup.prototype.percorso = function (nome) {
  if (!NOME_VALIDO.test(String(nome || ''))) throw errore(404, 'Copia non trovata.');
  var file = path.join(this.cartella, nome);
  if (!fs.existsSync(file)) throw errore(404, 'Copia non trovata.');
  return file;
};

Backup.prototype.pulisci = function () {
  var self = this;
  var gruppi = {};
  fs.readdirSync(this.cartella).filter(function (n) { return NOME_VALIDO.test(n); }).forEach(function (n) {
    var k = n.split('_')[0] + '_' + n.replace(/^.*_(auto|manuale|prima-del-ripristino)\.db$/, '$1');
    (gruppi[k] = gruppi[k] || []).push(n);
  });
  Object.keys(gruppi).forEach(function (k) {
    gruppi[k].sort().reverse().slice(TENERE).forEach(function (n) {
      try { fs.unlinkSync(path.join(self.cartella, n)); } catch (e) { self.log('Copia vecchia non eliminata: ' + n + ' ' + e.message); }
    });
  });
};

/* Copia automatica del giorno, se manca. */
Backup.prototype.automatica = function () {
  var oggi = marcaTempo(new Date()).slice(0, 10);
  var esistenti = fs.readdirSync(this.cartella);
  var fatto = false;
  if (!esistenti.some(function (n) { return n.indexOf('farmacia_' + oggi) === 0 && /_auto\.db$/.test(n); })) {
    this.copia(this.database.dati, 'farmacia', 'auto');
    fatto = true;
  }
  if (!esistenti.some(function (n) { return n.indexOf('accessi_' + oggi) === 0 && /_auto\.db$/.test(n); })) {
    this.copia(this.database.accessi, 'accessi', 'auto');
    fatto = true;
  }
  if (fatto) {
    this.pulisci();
    this.log('Copia di sicurezza automatica del ' + oggi + ' creata.');
  }
};

Backup.prototype.pianifica = function () {
  var self = this;
  function giro() {
    try { self.automatica(); } catch (e) { self.log('Copia automatica non riuscita: ' + e.message); }
  }
  giro();
  this.timer = setInterval(giro, 30 * 60 * 1000);
  if (this.timer.unref) this.timer.unref();
};

Backup.prototype.ferma = function () {
  if (this.timer) clearInterval(this.timer);
};

/* Controlla che il file sia un archivio del magazzino integro. */
function controllaCopia(file) {
  var db = new DatabaseSync(file, { readOnly: true });
  try {
    var ok = db.prepare('PRAGMA integrity_check').get();
    if (!ok || Object.values(ok)[0] !== 'ok') throw errore(400, 'La copia è danneggiata e non si può ripristinare.');
    ['meta', 'impostazioni', 'reparti', 'articoli', 'movimenti'].forEach(function (t) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) throw errore(400, 'Il file non è una copia del magazzino.');
    });
    return Number(db.prepare("SELECT valore FROM meta WHERE chiave = 'rev'").get().valore) || 0;
  } finally {
    db.close();
  }
}

/*
 * Ripristina una copia del magazzino. La revisione riparte da sopra quella attuale e diventa la "base":
 * i client che chiedono cambiamenti da una revisione precedente ricevono tutto (completo: true).
 */
Backup.prototype.ripristina = function (nome) {
  var file = this.percorso(nome);
  if (nome.indexOf('farmacia_') !== 0) throw errore(400, 'Si possono ripristinare solo le copie del magazzino.');
  var revCopia = controllaCopia(file);
  var revAttuale = this.database.rev();
  var sicurezza = this.copia(this.database.dati, 'farmacia', 'prima-del-ripristino');
  var destinazione = this.database.fileDati;
  var temporaneo = destinazione + '.ripristino';
  fs.copyFileSync(file, temporaneo);
  this.database.chiudiDati();
  try {
    ['-wal', '-shm'].forEach(function (s) { try { fs.unlinkSync(destinazione + s); } catch (e) { /* non c'era */ } });
    fs.renameSync(temporaneo, destinazione);
  } finally {
    this.database.apri();
  }
  var nuova = Math.max(revAttuale, revCopia) + 1;
  this.database.impostaMeta('rev', nuova);
  this.database.impostaMeta('rev_base', nuova);
  this.pulisci();
  this.log('Ripristinata la copia ' + nome + ' (copia dello stato precedente: ' + sicurezza + ').');
  return { rev: nuova, sicurezza: sicurezza };
};

module.exports = { Backup: Backup };
