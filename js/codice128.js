/*
 * Versione 3.0 – parte A: codici a barre Code 128 (SVG) per i DDT.
 * UMD come js/calcoli.js: module.exports in Node, window.Codice128 nel browser. Contratto: docs/NOVITA-3.0.md.
 *
 *   Codice128.codifica(testo)  -> { valori: [start, …, controllo, stop], moduli: [larghezze barra/spazio…] }
 *   Codice128.svg(testo, opz)  -> testo SVG (barre nere su bianco, zona di silenzio compresa)
 *       opz: { altezza (moduli, 50), modulo (larghezza in pixel di un modulo, 2), testo (true: numero sotto le barre),
 *              titolo (testo per i lettori di schermo) }
 *
 * Set B per lettere e simboli (ASCII da 32 a 126), set C per le sequenze di cifre lunghe (due cifre per simbolo):
 * "DDT-2026-0001" diventa B "DDT-2026-" + C "0001" (le 4 cifre in mezzo non accorciano il codice). Cifra di controllo modulo 103.
 */
(function (root) {
  'use strict';

  // larghezze barra/spazio dei 107 simboli (valore 0 … 105, 106 = stop)
  var SIMBOLI = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
  ];
  var START_B = 104;
  var START_C = 105;
  var CODICE_B = 100; // passa al set B (dal set C)
  var CODICE_C = 99;  // passa al set C (dal set B)
  var STOP = 106;
  var ZONA_SILENZIO = 10; // moduli bianchi prima e dopo le barre

  function cifre(testo, da) {
    var n = 0;
    while (da + n < testo.length && testo.charCodeAt(da + n) >= 48 && testo.charCodeAt(da + n) <= 57) n++;
    return n;
  }

  /* Valori dei simboli (con start, controllo e stop). Errore per i caratteri che il set B non ha. */
  function valori(testo) {
    testo = String(testo === undefined || testo === null ? '' : testo);
    if (!testo.length) throw new Error('Testo vuoto: niente da codificare.');
    for (var k = 0; k < testo.length; k++) {
      var c = testo.charCodeAt(k);
      if (c < 32 || c > 126) throw new Error('Carattere non ammesso nel codice a barre: «' + testo.charAt(k) + '».');
    }
    var out = [];
    var set = null;
    var i = 0;
    while (i < testo.length) {
      var n = cifre(testo, i);
      // set C conviene per almeno 4 cifre (6 in mezzo al testo, 4 all'inizio o alla fine, 2 se il testo è solo di cifre)
      var soglia = (i === 0 && n === testo.length) ? 2 : (i === 0 || i + n === testo.length) ? 4 : 6;
      if (n >= soglia) {
        var coppie = Math.floor(n / 2);
        // con un numero dispari di cifre, quella in più va in B prima del set C (all'inizio del testo resta in fondo)
        if (n % 2 === 1 && i > 0) {
          if (set !== 'B') { out.push(set === null ? START_B : CODICE_B); set = 'B'; }
          out.push(testo.charCodeAt(i) - 32);
          i++;
        }
        out.push(set === null ? START_C : CODICE_C);
        set = 'C';
        for (var p = 0; p < coppie; p++) {
          out.push(Number(testo.substr(i, 2)));
          i += 2;
        }
        continue;
      }
      if (set !== 'B') { out.push(set === null ? START_B : CODICE_B); set = 'B'; }
      out.push(testo.charCodeAt(i) - 32);
      i++;
    }
    var somma = out[0];
    for (var j = 1; j < out.length; j++) somma += out[j] * j;
    out.push(somma % 103);
    out.push(STOP);
    return out;
  }

  function codifica(testo) {
    var v = valori(testo);
    var moduli = [];
    v.forEach(function (x) { SIMBOLI[x].split('').forEach(function (w) { moduli.push(Number(w)); }); });
    return { valori: v, moduli: moduli };
  }

  function xml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function svg(testo, opz) {
    opz = opz || {};
    var c = codifica(testo);
    var alto = opz.altezza || 50;
    var modulo = opz.modulo || 2;
    var conTesto = opz.testo !== false;
    var largo = ZONA_SILENZIO * 2 + c.moduli.reduce(function (s, w) { return s + w; }, 0);
    var altoTot = alto + (conTesto ? 14 : 0);
    var x = ZONA_SILENZIO;
    var barre = '';
    c.moduli.forEach(function (w, i) {
      if (i % 2 === 0) barre += 'M' + x + ' 0h' + w + 'v' + alto + 'h-' + w + 'z';
      x += w;
    });
    var titolo = opz.titolo === undefined ? 'Codice a barre ' + testo : opz.titolo;
    return '<svg xmlns="http://www.w3.org/2000/svg" class="codice128" viewBox="0 0 ' + largo + ' ' + altoTot + '" width="' + (largo * modulo) +
      '" height="' + (altoTot * modulo) + '" shape-rendering="crispEdges" role="img" aria-label="' + xml(titolo) + '">' +
      '<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="' + barre + '"/>' +
      (conTesto ? '<text x="' + (largo / 2) + '" y="' + (alto + 11) + '" text-anchor="middle" font-family="monospace" font-size="10" fill="#000">' + xml(testo) + '</text>' : '') +
      '</svg>';
  }

  var Codice128 = { SIMBOLI: SIMBOLI, valori: valori, codifica: codifica, svg: svg, ZONA_SILENZIO: ZONA_SILENZIO };
  if (typeof module === 'object' && module.exports) module.exports = Codice128;
  else root.Codice128 = Codice128;
})(typeof window !== 'undefined' ? window : this);
