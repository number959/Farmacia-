/*
 * Versione 3.0 – parte D (docs/NOVITA-3.0.md): file Excel della proposta d'ordine e della distribuzione alle periferiche.
 * Usa ExcelJS (vendor/exceljs.min.js) con lo stesso stile di js/excel.js. Restituisce dei Blob: la pagina li scarica
 * con App.scarica.
 *   ExcelOrdini.propostaOrdine(dati)  riepilogo per fornitore + un foglio per ogni fornitore (da mandare così com'è)
 *   ExcelOrdini.distribuzione(dati)   per magazzino, dato per mese, articolo × magazzino
 */
(function (root) {
  'use strict';

  var TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  var FORMATO_Q = '#,##0.###';
  var FORMATO_EURO = '#,##0.00 "€"';
  var SFONDO_TESTA = 'FFE6EEF3';
  var SFONDO_GRUPPO = 'FFF2F5FA';

  function dataIt(d) {
    if (!d) return '';
    var p = String(d).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(d);
  }

  function num(v) { var n = Number(v); return isFinite(n) ? Math.round(n * 1000) / 1000 : 0; }
  function euro(v) { return Math.round((Number(v) || 0) * 100) / 100; }

  /* Nome di foglio valido (al massimo 31 caratteri, senza : \ / ? * [ ]) e diverso da quelli già usati. */
  function nomeFoglio(nome, usati) {
    var base = String(nome || 'Foglio').replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim() || 'Foglio';
    base = base.slice(0, 31);
    var n = base, i = 2;
    while (usati[n.toLowerCase()]) { var suff = ' (' + i++ + ')'; n = base.slice(0, 31 - suff.length) + suff; }
    usati[n.toLowerCase()] = true;
    return n;
  }

  function impagina(ws) {
    ws.pageSetup.orientation = 'landscape';
    ws.pageSetup.fitToPage = true;
    ws.pageSetup.fitToWidth = 1;
    ws.pageSetup.fitToHeight = 0;
    ws.pageSetup.margins = { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 };
  }

  function titolo(ws, righe) {
    righe.forEach(function (t, i) {
      var r = ws.addRow([t]);
      r.font = i === 0 ? { bold: true, size: 14 } : { size: 10, color: { argb: 'FF5B687C' } };
    });
    ws.addRow([]);
  }

  function intestazione(ws, colonne) {
    var r = ws.addRow(colonne.map(function (c) { return c.titolo; }));
    r.font = { bold: true };
    r.eachCell(function (c) {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SFONDO_TESTA } };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFB9C5CD' } } };
      c.alignment = { vertical: 'middle', wrapText: true };
    });
    colonne.forEach(function (c, i) {
      var col = ws.getColumn(i + 1);
      col.width = c.larghezza || 14;
      if (c.formato) col.numFmt = c.formato;
    });
    return r.number;
  }

  function blob(wb) {
    return wb.xlsx.writeBuffer().then(function (buf) { return new Blob([buf], { type: TIPO_XLSX }); });
  }

  /* ---------- proposta d'ordine ---------- */

  function quantiPezzi(r) { return num((Number(r.confezioni) || 0) * (Number(r.pezziConfezione) || 1)); }
  function importo(r) { return euro(quantiPezzi(r) * (Number(r.prezzo) || 0)); }

  /*
   * dati: { struttura, data: 'AAAA-MM-GG', note, gruppi: [{ fornitore, righe: [{ nome, codice, confezione, pezziConfezione,
   *         confezioni, unita, disponibile, fabbisogno, prezzo }] }] }
   * Le righe con 0 confezioni non si scrivono.
   */
  function propostaOrdine(dati) {
    var wb = new root.ExcelJS.Workbook();
    wb.creator = dati.struttura || '';
    wb.created = new Date();
    var usati = {};
    var gruppi = (dati.gruppi || []).map(function (g) {
      return { fornitore: g.fornitore || '', righe: (g.righe || []).filter(function (r) { return Number(r.confezioni) > 0; }) };
    }).filter(function (g) { return g.righe.length; });

    // riepilogo con tutti i fornitori
    var ws = wb.addWorksheet(nomeFoglio('Proposta d’ordine', usati));
    titolo(ws, ['Proposta d’ordine' + (dati.struttura ? ' — ' + dati.struttura : ''), 'Data: ' + dataIt(dati.data)].concat(dati.note ? [dati.note] : []));
    var colonne = [
      { titolo: 'Articolo', larghezza: 40 }, { titolo: 'Codice', larghezza: 18 }, { titolo: 'Confezione', larghezza: 18 },
      { titolo: 'Pezzi per confezione', larghezza: 12, formato: FORMATO_Q }, { titolo: 'Confezioni da ordinare', larghezza: 13, formato: FORMATO_Q },
      { titolo: 'Unità', larghezza: 10, formato: FORMATO_Q }, { titolo: 'U.M.', larghezza: 8 },
      { titolo: 'Disponibile nella struttura', larghezza: 14, formato: FORMATO_Q }, { titolo: 'Fabbisogno', larghezza: 12, formato: FORMATO_Q },
      { titolo: 'Prezzo unitario', larghezza: 12, formato: FORMATO_EURO }, { titolo: 'Importo stimato', larghezza: 14, formato: FORMATO_EURO }
    ];
    var testa = intestazione(ws, colonne);
    ws.views = [{ state: 'frozen', ySplit: testa }];
    var totale = 0;
    gruppi.forEach(function (g) {
      var rg = ws.addRow([g.fornitore || 'Senza fornitore']);
      rg.font = { bold: true };
      rg.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SFONDO_GRUPPO } };
      ws.mergeCells(rg.number, 1, rg.number, colonne.length);
      var parziale = 0;
      g.righe.forEach(function (r) {
        var imp = importo(r);
        parziale += imp;
        ws.addRow([r.nome, r.codice || '', r.confezione || '', num(r.pezziConfezione || 1), num(r.confezioni), quantiPezzi(r), r.unita || '',
          num(r.disponibile), num(r.fabbisogno), euro(r.prezzo), imp]);
      });
      var rt = ws.addRow(['Totale ' + (g.fornitore || 'senza fornitore'), '', '', '', '', '', '', '', '', '', euro(parziale)]);
      rt.font = { bold: true };
      totale += parziale;
    });
    ws.addRow([]);
    var rf = ws.addRow(['Totale proposta', '', '', '', '', '', '', '', '', '', euro(totale)]);
    rf.font = { bold: true, size: 12 };
    impagina(ws);

    // un foglio per fornitore, pronto da mandare
    gruppi.forEach(function (g) {
      var f = wb.addWorksheet(nomeFoglio(g.fornitore || 'Senza fornitore', usati));
      titolo(f, ['Ordine a: ' + (g.fornitore || 'fornitore da scegliere'), (dati.struttura ? dati.struttura + ' · ' : '') + dataIt(dati.data)]);
      var col = [
        { titolo: 'Articolo', larghezza: 40 }, { titolo: 'Codice', larghezza: 18 }, { titolo: 'Confezione', larghezza: 18 },
        { titolo: 'Pezzi per confezione', larghezza: 12, formato: FORMATO_Q }, { titolo: 'Confezioni', larghezza: 12, formato: FORMATO_Q },
        { titolo: 'Unità', larghezza: 10, formato: FORMATO_Q }, { titolo: 'U.M.', larghezza: 8 },
        { titolo: 'Prezzo unitario', larghezza: 12, formato: FORMATO_EURO }, { titolo: 'Importo stimato', larghezza: 14, formato: FORMATO_EURO }
      ];
      var t = intestazione(f, col);
      f.views = [{ state: 'frozen', ySplit: t }];
      var s = 0;
      g.righe.forEach(function (r) {
        var imp = importo(r);
        s += imp;
        f.addRow([r.nome, r.codice || '', r.confezione || '', num(r.pezziConfezione || 1), num(r.confezioni), quantiPezzi(r), r.unita || '', euro(r.prezzo), imp]);
      });
      var rt = f.addRow(['Totale', '', '', '', '', '', '', '', euro(s)]);
      rt.font = { bold: true };
      impagina(f);
    });
    return blob(wb);
  }

  /* ---------- distribuzione alle periferiche ---------- */

  /*
   * dati: { struttura, periodo (testo), misura (testo), magazzini: [{ id, nome }],
   *         perMagazzino: [{ nome, dato, resi, consumato, perdite, giacenza, inViaggio }],
   *         mesi: [{ etichetta, valori: [uno per magazzino, nello stesso ordine] }],
   *         righe: [{ nome, categoria, magazzino, dato, resi, consumato, perdite, giacenza, inViaggio }] }
   */
  function distribuzione(dati) {
    var wb = new root.ExcelJS.Workbook();
    wb.creator = dati.struttura || '';
    wb.created = new Date();
    var euroMisura = /€|valore/i.test(dati.misura || '');
    var fq = euroMisura ? FORMATO_EURO : FORMATO_Q;
    var sotto = (dati.struttura ? dati.struttura + ' · ' : '') + (dati.periodo || '') + (dati.misura ? ' · ' + dati.misura : '');
    var usati = {};

    var ws = wb.addWorksheet(nomeFoglio('Per magazzino', usati));
    titolo(ws, ['Distribuzione alle periferiche', sotto]);
    var t = intestazione(ws, [
      { titolo: 'Magazzino', larghezza: 30 }, { titolo: 'Dato dalla farmacia', larghezza: 14, formato: fq }, { titolo: 'Resi alla farmacia', larghezza: 14, formato: fq },
      { titolo: 'Consumato', larghezza: 13, formato: fq }, { titolo: 'Perdite', larghezza: 12, formato: fq },
      { titolo: 'Giacenza attuale', larghezza: 14, formato: fq }, { titolo: 'In viaggio', larghezza: 12, formato: fq }
    ]);
    ws.views = [{ state: 'frozen', ySplit: t }];
    (dati.perMagazzino || []).forEach(function (r) {
      ws.addRow([r.nome, num(r.dato), num(r.resi), num(r.consumato), num(r.perdite), num(r.giacenza), num(r.inViaggio)]);
    });
    impagina(ws);

    var mags = dati.magazzini || [];
    var wm = wb.addWorksheet(nomeFoglio('Dato per mese', usati));
    var tm = intestazione(wm, [{ titolo: 'Mese', larghezza: 14 }].concat(mags.map(function (m) { return { titolo: m.nome, larghezza: 14, formato: fq }; }))
      .concat([{ titolo: 'Totale', larghezza: 14, formato: fq }]));
    wm.views = [{ state: 'frozen', ySplit: tm, xSplit: 1 }];
    (dati.mesi || []).forEach(function (m) {
      var v = (m.valori || []).map(num);
      wm.addRow([m.etichetta].concat(v).concat([num(v.reduce(function (a, b) { return a + b; }, 0))]));
    });
    impagina(wm);

    var wr = wb.addWorksheet(nomeFoglio('Articolo × magazzino', usati));
    var tr = intestazione(wr, [
      { titolo: 'Articolo', larghezza: 40 }, { titolo: 'Categoria', larghezza: 11 }, { titolo: 'Magazzino', larghezza: 24 },
      { titolo: 'Dato dalla farmacia', larghezza: 14, formato: fq }, { titolo: 'Resi alla farmacia', larghezza: 14, formato: fq },
      { titolo: 'Consumato', larghezza: 13, formato: fq }, { titolo: 'Perdite', larghezza: 12, formato: fq },
      { titolo: 'Giacenza attuale', larghezza: 14, formato: fq }, { titolo: 'In viaggio', larghezza: 12, formato: fq }
    ]);
    wr.views = [{ state: 'frozen', ySplit: tr }];
    wr.autoFilter = { from: { row: tr, column: 1 }, to: { row: tr, column: 9 } };
    (dati.righe || []).forEach(function (r) {
      wr.addRow([r.nome, r.categoria || '', r.magazzino, num(r.dato), num(r.resi), num(r.consumato), num(r.perdite), num(r.giacenza), num(r.inViaggio)]);
    });
    impagina(wr);
    return blob(wb);
  }

  root.ExcelOrdini = { propostaOrdine: propostaOrdine, distribuzione: distribuzione, nomeFoglio: nomeFoglio };
})(typeof window !== 'undefined' ? window : this);
