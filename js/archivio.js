/*
 * Archivio del gestionale: tutto lo stato sta in IndexedDB su questo PC.
 * - salvataggio a ogni modifica
 * - copia di sicurezza automatica una volta al giorno (le ultime 30)
 * - copia su file a scelta (Edge e Chrome) aggiornata a ogni modifica
 * - esporta e ripristina un file .json
 */
(function (root) {
  'use strict';

  var NOME_DB = 'gestionale-farmacia-posillipo';
  var VERSIONE_DB = 1;
  var MAX_COPIE = 30;
  var VERSIONE_DATI = 1;

  function statoVuoto() {
    return {
      versione: VERSIONE_DATI,
      impostazioni: {
        struttura: 'Clinica Posillipo',
        sottotitolo: 'Longevity Institute',
        societa: 'ME.MI. SRL',
        citta: 'NAPOLI',
        logo: '',
        operatore: '',
        giorniAvvisoScadenza: 90,
        codiceModulo: 'PRQ 1501.4EV.1'
      },
      reparti: [
        { id: 'r-farmacia', nome: 'Farmacia', centrale: true, attivo: true },
        { id: 'r-degenza', nome: 'Degenza', attivo: true },
        { id: 'r-sala', nome: 'Sala operatoria', attivo: true },
        { id: 'r-ambulatori', nome: 'Ambulatori', attivo: true }
      ],
      articoli: [],
      movimenti: [],
      ultimaCopiaFile: null,
      ultimaEsportazione: null
    };
  }

  function apri() {
    return new Promise(function (ok, ko) {
      var req = indexedDB.open(NOME_DB, VERSIONE_DB);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('stato')) db.createObjectStore('stato');
        if (!db.objectStoreNames.contains('copie')) db.createObjectStore('copie', { keyPath: 'giorno' });
        if (!db.objectStoreNames.contains('varie')) db.createObjectStore('varie');
      };
      req.onsuccess = function () { ok(req.result); };
      req.onerror = function () { ko(req.error); };
    });
  }

  var dbPromessa = null;
  function db() {
    if (!dbPromessa) dbPromessa = apri();
    return dbPromessa;
  }

  function richiesta(store, modo, fn) {
    return db().then(function (d) {
      return new Promise(function (ok, ko) {
        var tx = d.transaction(store, modo);
        var r = fn(tx.objectStore(store));
        tx.oncomplete = function () { ok(r && r.result); };
        tx.onerror = function () { ko(tx.error); };
        tx.onabort = function () { ko(tx.error); };
      });
    });
  }

  function completa(stato) {
    // aggiunge i campi nuovi a un archivio salvato da una versione precedente
    var base = statoVuoto();
    Object.keys(base).forEach(function (k) { if (stato[k] === undefined) stato[k] = base[k]; });
    Object.keys(base.impostazioni).forEach(function (k) {
      if (stato.impostazioni[k] === undefined) stato.impostazioni[k] = base.impostazioni[k];
    });
    stato.versione = VERSIONE_DATI;
    return stato;
  }

  function carica() {
    return richiesta('stato', 'readonly', function (s) { return s.get('corrente'); })
      .then(function (st) { return st ? completa(st) : statoVuoto(); });
  }

  function oggi() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function salva(stato) {
    var copia = JSON.parse(JSON.stringify(stato));
    return richiesta('stato', 'readwrite', function (s) { return s.put(copia, 'corrente'); })
      .then(function () { return copiaDelGiorno(copia); })
      .then(function () { return scriviSuFile(copia); });
  }

  // Una copia per giorno: la prima modifica del giorno salva lo stato com'era.
  function copiaDelGiorno(stato) {
    var giorno = oggi();
    return richiesta('copie', 'readonly', function (s) { return s.get(giorno); }).then(function (c) {
      if (c) return;
      return richiesta('copie', 'readwrite', function (s) {
        return s.put({ giorno: giorno, ora: new Date().toISOString(), dati: stato });
      }).then(potaCopie);
    });
  }

  function elencoCopie() {
    return richiesta('copie', 'readonly', function (s) { return s.getAll(); }).then(function (l) {
      return (l || []).sort(function (a, b) { return a.giorno < b.giorno ? 1 : -1; });
    });
  }

  function potaCopie() {
    return elencoCopie().then(function (l) {
      var vecchie = l.slice(MAX_COPIE);
      if (!vecchie.length) return;
      return richiesta('copie', 'readwrite', function (s) {
        vecchie.forEach(function (c) { s.delete(c.giorno); });
      });
    });
  }

  /* ---- copia su file (File System Access API) ---- */

  function fileSupportato() { return typeof root.showSaveFilePicker === 'function'; }

  var maniglia = null;
  var permessoOk = false;

  function leggiManiglia() {
    return richiesta('varie', 'readonly', function (s) { return s.get('file'); }).then(function (h) {
      maniglia = h || null;
      return maniglia;
    }).catch(function () { return null; });
  }

  function scegliFile() {
    return root.showSaveFilePicker({
      suggestedName: 'archivio-farmacia-posillipo.json',
      types: [{ description: 'Archivio gestionale farmacia', accept: { 'application/json': ['.json'] } }]
    }).then(function (h) {
      maniglia = h;
      permessoOk = true;
      return richiesta('varie', 'readwrite', function (s) { return s.put(h, 'file'); });
    });
  }

  function togliFile() {
    maniglia = null;
    permessoOk = false;
    return richiesta('varie', 'readwrite', function (s) { return s.delete('file'); });
  }

  // Il browser chiede di nuovo il permesso a ogni avvio: va chiesto dopo un clic.
  function riattivaFile() {
    if (!maniglia) return Promise.resolve(false);
    return maniglia.requestPermission({ mode: 'readwrite' }).then(function (p) {
      permessoOk = p === 'granted';
      return permessoOk;
    });
  }

  function statoFile() {
    if (!maniglia) return Promise.resolve({ attivo: false, nome: '' });
    var nome = maniglia.name;
    if (permessoOk) return Promise.resolve({ attivo: true, nome: nome, permesso: true });
    return maniglia.queryPermission({ mode: 'readwrite' }).then(function (p) {
      permessoOk = p === 'granted';
      return { attivo: true, nome: nome, permesso: permessoOk };
    }).catch(function () { return { attivo: true, nome: nome, permesso: false }; });
  }

  function scriviSuFile(stato) {
    if (!maniglia || !permessoOk) return Promise.resolve();
    return maniglia.createWritable().then(function (w) {
      return w.write(JSON.stringify(stato, null, 1)).then(function () { return w.close(); });
    }).catch(function (e) {
      permessoOk = false;
      console.warn('Copia su file non riuscita', e);
    });
  }

  function valida(dati) {
    if (!dati || typeof dati !== 'object') throw new Error('Il file non contiene un archivio.');
    if (!Array.isArray(dati.articoli) || !Array.isArray(dati.movimenti) || !Array.isArray(dati.reparti)) {
      throw new Error('Il file non è un archivio del gestionale farmacia.');
    }
    return completa(dati);
  }

  root.Archivio = {
    statoVuoto: statoVuoto,
    carica: carica,
    salva: salva,
    elencoCopie: elencoCopie,
    valida: valida,
    fileSupportato: fileSupportato,
    leggiManiglia: leggiManiglia,
    scegliFile: scegliFile,
    togliFile: togliFile,
    riattivaFile: riattivaFile,
    statoFile: statoFile,
    oggi: oggi
  };
})(this);
