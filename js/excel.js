/*
 * Excel: compila il modulo originale "Nota consumi" e importa elenchi di articoli.
 * Usa ExcelJS (vendor/exceljs.min.js), che conserva bordi, celle unite e impaginazione del modulo.
 */
(function (root) {
  'use strict';

  // Righe del modulo che accolgono gli articoli: prima pagina e seconda pagina.
  var RIGHE_MODULO = [];
  for (var r = 9; r <= 31; r++) RIGHE_MODULO.push(r);
  for (r = 37; r <= 61; r++) RIGHE_MODULO.push(r);

  // Colonne dei giorni 1-31 (L e M sono colonne nascoste del modulo).
  var COLONNE_GIORNI = ['H', 'I', 'J', 'K', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM', 'AN'];

  var MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto',
    'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

  function base64InBuffer(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function numero(v) { return v ? v : null; }

  function caricaModello() {
    var wb = new root.ExcelJS.Workbook();
    return wb.xlsx.load(base64InBuffer(root.MODELLO_NOTA_CONSUMI)).then(function () { return wb; });
  }

  function intestazione(ws, imp, reparto, anno, mese, categoria, pagina, pagine) {
    ws.getCell('A1').value = (imp.struttura || 'CLINICA POSILLIPO').toUpperCase();
    ws.getCell('A2').value = imp.societa || '';
    ws.getCell('A3').value = imp.citta || '';
    ws.getCell('Q2').value = reparto;
    ws.getCell('Z2').value = MESI[mese - 1] + ' ' + anno + (pagine > 1 ? '  (foglio ' + pagina + ' di ' + pagine + ')' : '');
    ws.getCell('AO2').value = categoria;
    ws.getCell('AK32').value = imp.codiceModulo || '';
    // la seconda pagina del modulo ha intestazioni di una versione precedente: le allineo alla prima
    ws.getCell('G34').value = ws.getCell('G6').value;
    ws.getCell('AQ34').value = ws.getCell('AQ6').value;
    ws.getCell('AT34').value = ws.getCell('AT6').value;
    ws.getCell('AV34').value = ws.getCell('AV6').value;
    ws.getCell('AR34').value = ws.getCell('AR6').value;
    // seconda pagina più compatta, così sta in un foglio A4 con le firme
    for (var r = 37; r <= 61; r++) ws.getRow(r).height = 22.5;
    ws.pageSetup.printArea = 'A1:AV65';
    ws.pageSetup.fitToPage = true;
    ws.pageSetup.fitToWidth = 1;
    ws.pageSetup.fitToHeight = 0;
    ws.getRow(31).addPageBreak();
    ws.getCell('S82').border = {}; // bordo isolato fuori dal modulo che stampava una pagina in più
  }

  function scriviRiga(ws, riga, r, calcoli) {
    var den = ws.getCell('B' + riga);
    den.value = r.denominazione;
    den.font = { name: 'Arial', size: 8 };
    den.alignment = { vertical: 'middle', shrinkToFit: true };
    ws.getCell('C' + riga).value = numero(r.residuiPrec);
    ws.getCell('F' + riga).value = numero(r.carichi);
    ws.getCell('G' + riga).value = numero(r.totaleCarico);
    r.consumi.forEach(function (q, i) { ws.getCell(COLONNE_GIORNI[i] + riga).value = numero(q); });
    ws.getCell('AO' + riga).value = numero(r.totaleConsumo);
    ws.getCell('AP' + riga).value = numero(r.perdite);
    ws.getCell('AQ' + riga).value = numero(r.totaleScarico);
    ws.getCell('AR' + riga).value = r.prezzo || null;
    ws.getCell('AT' + riga).value = calcoli.scadenzaBreve(r.scadenza) || null;
    ws.getCell('AV' + riga).value = r.residui;
  }

  /*
   * Crea il file Excel della nota consumi del mese: uno o più fogli identici al modulo
   * (48 articoli per foglio). Restituisce un Blob.
   */
  function esportaNotaConsumi(registro, opz) {
    var calcoli = root.Calcoli;
    var perFoglio = RIGHE_MODULO.length;
    var pagine = Math.max(1, Math.ceil(registro.righe.length / perFoglio));
    var cartelle = [];
    var catene = [];
    for (var p = 0; p < pagine; p++) catene.push(caricaModello());
    return Promise.all(catene).then(function (lista) {
      cartelle = lista;
      var principale = cartelle[0];
      var primo = principale.getWorksheet('Foglio1');
      // tolgo i fogli vuoti del modulo
      ['Foglio2', 'Foglio3'].forEach(function (n) {
        var f = principale.getWorksheet(n);
        if (f) principale.removeWorksheet(f.id);
      });
      primo.name = pagine > 1 ? 'Foglio 1' : opz.categoria;
      for (var i = 0; i < pagine; i++) {
        var ws;
        if (i === 0) ws = primo;
        else {
          // copio il foglio del modulo da una seconda copia caricata
          var sorgente = cartelle[i].getWorksheet('Foglio1');
          ws = principale.addWorksheet('Foglio ' + (i + 1));
          ws.model = Object.assign({}, sorgente.model, { name: 'Foglio ' + (i + 1), id: ws.id });
        }
        intestazione(ws, opz.impostazioni, opz.reparto, opz.anno, opz.mese, opz.categoria, i + 1, pagine);
        var blocco = registro.righe.slice(i * perFoglio, (i + 1) * perFoglio);
        blocco.forEach(function (r, k) { scriviRiga(ws, RIGHE_MODULO[k], r, calcoli); });
      }
      return principale.xlsx.writeBuffer();
    }).then(function (buf) {
      return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });
  }

  /* Elenco semplice in Excel (giacenze, scadenze, movimenti): colonne [{titolo, larghezza}], righe di valori. */
  function esportaElenco(titolo, colonne, righe) {
    var wb = new root.ExcelJS.Workbook();
    var ws = wb.addWorksheet(titolo.slice(0, 31));
    ws.columns = colonne.map(function (c) { return { header: c.titolo, width: c.larghezza || 14 }; });
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6EEF3' } };
    righe.forEach(function (r) { ws.addRow(r); });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.pageSetup.orientation = 'landscape';
    ws.pageSetup.fitToPage = true;
    ws.pageSetup.fitToWidth = 1;
    ws.pageSetup.fitToHeight = 0;
    return wb.xlsx.writeBuffer().then(function (buf) {
      return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });
  }

  function testo(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map(function (t) { return t.text; }).join('');
      if (v.result !== undefined) return testo(v.result);
      if (v.text !== undefined) return String(v.text);
      if (v instanceof Date) return v.toISOString().slice(0, 10);
    }
    return String(v).trim();
  }

  function num(v) {
    var t = testo(v).replace(',', '.');
    var n = parseFloat(t);
    return isFinite(n) ? n : 0;
  }

  function normalizza(s) {
    return testo(s).toLowerCase().replace(/[^a-zà-ù0-9]+/g, ' ').trim();
  }

  /*
   * Legge un file Excel e restituisce gli articoli trovati:
   * [{ nome, categoria, prezzo, giacenza, scortaMinima, unita }].
   * Riconosce il modulo "Nota consumi" (prende i residui finali) oppure un elenco con intestazioni.
   */
  function importaArticoli(buffer, categoriaPredefinita) {
    var wb = new root.ExcelJS.Workbook();
    return wb.xlsx.load(buffer).then(function () {
      var trovati = [];
      wb.eachSheet(function (ws) {
        var cat = categoriaPredefinita;
        var marchio = normalizza(ws.getCell('AO2').value);
        if (marchio.indexOf('presid') === 0) cat = 'PRESIDI';
        else if (marchio.indexOf('farmac') === 0) cat = 'FARMACI';
        var eModulo = normalizza(ws.getCell('A6').value) === 'denominazione';
        if (eModulo) {
          RIGHE_MODULO.forEach(function (riga) {
            var nome = testo(ws.getCell('B' + riga).value);
            if (!nome) return;
            var residui = testo(ws.getCell('AV' + riga).value) !== '' ? num(ws.getCell('AV' + riga).value)
              : num(ws.getCell('G' + riga).value) - num(ws.getCell('AQ' + riga).value);
            trovati.push({ nome: nome, categoria: cat, prezzo: num(ws.getCell('AR' + riga).value), giacenza: residui, scortaMinima: 0, unita: '' });
          });
          return;
        }
        // elenco con intestazioni nelle prime 10 righe
        var colonne = null;
        var rigaIntestazione = 0;
        for (var r = 1; r <= Math.min(10, ws.rowCount) && !colonne; r++) {
          var mappa = {};
          ws.getRow(r).eachCell(function (c, col) {
            var t = normalizza(c.value);
            if (/^(denominazione|nome|articolo|descrizione|prodotto|farmaco)/.test(t)) mappa.nome = mappa.nome || col;
            else if (/^(giacenza|quantit|qta|residu|esistenza|scorta attuale)/.test(t)) mappa.giacenza = mappa.giacenza || col;
            else if (/^(prezzo|costo)/.test(t)) mappa.prezzo = mappa.prezzo || col;
            else if (/^(categoria|tipo)/.test(t)) mappa.categoria = mappa.categoria || col;
            else if (/^(scorta min|minimo|soglia)/.test(t)) mappa.scorta = mappa.scorta || col;
            else if (/^(unit|u m|confezione)/.test(t)) mappa.unita = mappa.unita || col;
          });
          if (mappa.nome) { colonne = mappa; rigaIntestazione = r; }
        }
        if (!colonne) return;
        for (var k = rigaIntestazione + 1; k <= ws.rowCount; k++) {
          var row = ws.getRow(k);
          var nome = testo(row.getCell(colonne.nome).value);
          if (!nome) continue;
          var c = cat;
          if (colonne.categoria) {
            var tc = normalizza(row.getCell(colonne.categoria).value);
            if (tc.indexOf('presid') === 0) c = 'PRESIDI';
            else if (tc.indexOf('farmac') === 0) c = 'FARMACI';
          }
          trovati.push({
            nome: nome,
            categoria: c,
            prezzo: colonne.prezzo ? num(row.getCell(colonne.prezzo).value) : 0,
            giacenza: colonne.giacenza ? num(row.getCell(colonne.giacenza).value) : 0,
            scortaMinima: colonne.scorta ? num(row.getCell(colonne.scorta).value) : 0,
            unita: colonne.unita ? testo(row.getCell(colonne.unita).value) : ''
          });
        }
      });
      return trovati;
    });
  }

  root.ExcelFarmacia = {
    esportaNotaConsumi: esportaNotaConsumi,
    esportaElenco: esportaElenco,
    importaArticoli: importaArticoli,
    MESI: MESI
  };
})(this);
