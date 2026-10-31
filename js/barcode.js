/*
 * Codici a barre dei farmaci e dei presidi: analisi del testo letto da un lettore (o dalla fotocamera)
 * e chiavi normalizzate da salvare sull'articolo. Funzioni pure, senza interfaccia:
 * le usa il browser (window.Barcode), il server per controllare le chiavi e le prove con Node.
 *
 *   Barcode.analizza(testo) -> { grezzo, tipo: 'gs1'|'aic'|'ean'|'altro', chiavi: [...], gtin, aic, lotto, scadenza, seriale }
 *
 * Codici riconosciuti:
 *   GS1        Data Matrix dei farmaci, UDI dei dispositivi medici, GS1-128: (01) GTIN, (17) scadenza AAMMGG,
 *              (10) lotto, (21) seriale, (716) AIC italiano (chiave 'aic:' in più a 'gtin:').
 *              Con il separatore GS (\x1D), con le parentesi "(01)…(17)…" oppure
 *              senza separatori quando i campi di lunghezza variabile sono in fondo.
 *   AIC        Code 32 dei farmaci italiani: "A" + 9 cifre, 9 cifre, oppure le 6 lettere/cifre in base 32
 *              che un lettore impostato su Code 39 restituisce così come sono.
 *   EAN/UPC    EAN-13, EAN-8, UPC-A (e GTIN-14) con la cifra di controllo giusta.
 *   altro      tutto il resto (codici interni, Code 128 qualsiasi…).
 *
 * Chiavi: 'aic:' + 9 cifre, 'gtin:' + 14 cifre, 'cod:' + testo maiuscolo senza spazi (al massimo 60 caratteri).
 */
(function (root) {
  'use strict';

  var GS = '\x1D';
  var BASE32 = '0123456789BCDFGHJKLMNPQRSTUVWXYZ';
  var MAX_COD = 60;

  // prefissi AIM (identificatore della simbologia: "]" + lettera + carattere) che dicono "questo è un codice GS1"
  var AIM_GS1 = { ']d2': true, ']C1': true, ']e0': true, ']Q3': true, ']J1': true };

  /* ---------- cifre di controllo ---------- */

  // GTIN (EAN-8, UPC-A, EAN-13, GTIN-14): pesi 3 e 1 a partire da destra, esclusa la cifra di controllo
  function cifraGtin(corpo) {
    var s = 0;
    for (var i = 0; i < corpo.length; i++) {
      var c = Number(corpo.charAt(corpo.length - 1 - i));
      s += i % 2 === 0 ? c * 3 : c;
    }
    return (10 - (s % 10)) % 10;
  }

  function gtinValido(cifre) {
    cifre = String(cifre || '');
    if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(cifre)) return false;
    return cifraGtin(cifre.slice(0, -1)) === Number(cifre.slice(-1));
  }

  function gtin14(cifre) {
    return String(cifre).padStart(14, '0');
  }

  // AIC (Code 32): posizioni dispari sommate, posizioni pari raddoppiate con la somma delle cifre; totale mod 10
  function cifraAic(otto) {
    var s = 0;
    for (var i = 0; i < 8; i++) {
      var c = Number(otto.charAt(i));
      if (i % 2 === 0) s += c;
      else { var d = c * 2; s += d > 9 ? d - 9 : d; }
    }
    return s % 10;
  }

  function aicValido(nove) {
    nove = String(nove || '');
    return /^\d{9}$/.test(nove) && cifraAic(nove.slice(0, 8)) === Number(nove.charAt(8));
  }

  /* Le 6 lettere/cifre del Code 32 (base 32) -> le 9 cifre dell'AIC, oppure '' se non è un AIC valido. */
  function aicDaBase32(sei) {
    var t = String(sei || '').toUpperCase();
    if (!/^[0-9BCDFGHJKLMNPQRSTUVWXYZ]{6}$/.test(t)) return '';
    var n = 0;
    for (var i = 0; i < 6; i++) n = n * 32 + BASE32.indexOf(t.charAt(i));
    if (n >= 1e9) return '';
    var nove = String(n).padStart(9, '0');
    return aicValido(nove) ? nove : '';
  }

  /* Le 9 cifre dell'AIC -> le 6 lettere/cifre che stanno nel codice a barre Code 32. */
  function aicInBase32(nove) {
    var n = Number(nove);
    var out = '';
    for (var i = 0; i < 6; i++) { out = BASE32.charAt(n % 32) + out; n = Math.floor(n / 32); }
    return out;
  }

  /* ---------- GS1 ---------- */

  // quante cifre ha l'AI (Application Identifier) che inizia in posizione i (0 = sconosciuto)
  function lunghezzaAi(t, i) {
    var p = t.substr(i, 2);
    if (!/^\d\d$/.test(p)) return 0;
    if (/^(0[0-3]|1[0-7]|2[0-2]|30|37|9\d)$/.test(p)) return 2;
    if (/^(2[3-5]|4[0-2]|71)$/.test(p)) return 3;
    if (/^(3[1-69]|43|7[02-9]|8\d)$/.test(p)) return 4;
    return 0;
  }

  // lunghezza fissa dei dati dell'AI (0 = lunghezza variabile, finisce al GS o in fondo)
  function lunghezzaDati(ai) {
    var fissi = { '00': 18, '01': 14, '02': 14, '03': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
    if (fissi[ai]) return fissi[ai];
    if (/^3[1-6]\d\d$/.test(ai)) return 6;   // pesi e misure
    if (/^41\d$/.test(ai)) return 13;        // GLN
    return 0;
  }

  function dataAammggPlausibile(d) {
    if (!/^\d{6}$/.test(d)) return false;
    var mese = Number(d.slice(2, 4));
    var giorno = Number(d.slice(4, 6));
    return mese >= 1 && mese <= 12 && giorno <= 31;
  }

  /*
   * Scadenza GS1 AAMMGG -> 'AAAA-MM' (il giorno 00 vuol dire "fine mese": nel programma conta solo il mese).
   * Secolo secondo la regola GS1: l'anno sta tra 49 anni prima e 50 anni dopo l'anno attuale.
   */
  function scadenzaGs1(aammgg, adesso) {
    if (!dataAammggPlausibile(aammgg)) return '';
    var anno = (adesso || new Date()).getFullYear();
    var secolo = Math.floor(anno / 100) * 100;
    var aa = Number(aammgg.slice(0, 2));
    var diff = aa - (anno % 100);
    var pieno = secolo + aa;
    if (diff >= 51) pieno -= 100;
    else if (diff <= -50) pieno += 100;
    return pieno + '-' + aammgg.slice(2, 4);
  }

  /* Forma con le parentesi: "(01)08012345678901(17)250600(10)ABC". */
  function campiConParentesi(t) {
    if (!/^\(\d{2,4}\)/.test(t)) return null;
    var campi = {};
    var re = /\((\d{2,4})\)([^()]*)/g;
    var m;
    var letto = 0;
    while ((m = re.exec(t))) {
      if (m.index !== letto) return null;
      // il testo stampato sotto il codice e quello scritto a mano hanno spesso degli spazi: "(01) 0801… (17) 271130"
      campi[m[1]] = m[2].split(GS).join('').trim();
      letto = re.lastIndex;
    }
    return letto === t.length ? campi : null;
  }

  /* Forma "grezza": AI e dati uno dopo l'altro, con il GS dopo i campi di lunghezza variabile (o senza, se sono in fondo). */
  function campiGrezzi(t) {
    var conSeparatori = t.indexOf(GS) >= 0;
    var campi = {};
    var i = 0;
    var trovati = 0;
    while (i < t.length) {
      if (t.charAt(i) === GS) { i++; continue; }
      var n = lunghezzaAi(t, i);
      if (!n || i + n > t.length || !/^\d+$/.test(t.substr(i, n))) return null;
      var ai = t.substr(i, n);
      i += n;
      var fisso = lunghezzaDati(ai);
      var valore;
      if (fisso) {
        valore = t.substr(i, fisso);
        if (valore.length < fisso) return null;
        i += fisso;
      } else {
        var fine = t.indexOf(GS, i);
        if (fine < 0) fine = t.length;
        valore = t.slice(i, fine);
        if (!conSeparatori) {
          // lettori che non trasmettono il GS: se il campo variabile in fondo finisce con una scadenza (17 + AAMMGG)
          // e la scadenza non c'era ancora, la scadenza è un campo a sé ("10LOTTO1" + "17300430").
          // Se la scadenza c'è già, un lotto come "AB12171231" resta intero
          var d = /^(.+)17(\d{6})$/.exec(valore);
          if (d && !campi['17'] && dataAammggPlausibile(d[2])) { valore = d[1]; fine = i + d[1].length; }
        }
        i = fine;
        if (!valore) continue; // campo variabile vuoto (per esempio "10" senza lotto): si salta
      }
      campi[ai] = valore;
      trovati++;
    }
    return trovati ? campi : null;
  }

  /* ---------- analisi ---------- */

  function vuoto(grezzo) {
    return { grezzo: grezzo, tipo: 'altro', chiavi: [], gtin: '', aic: '', lotto: '', scadenza: '', seriale: '' };
  }

  function chiaveCod(testo) {
    var t = String(testo || '').replace(/[\s\x00-\x1F\x7F]/g, '').toUpperCase().slice(0, MAX_COD);
    return t ? 'cod:' + t : '';
  }

  /* Toglie il prefisso AIM ("]d2", "]C1", "]E0"…) e i caratteri che i lettori aggiungono in fondo. */
  function pulisci(testo) {
    var t = String(testo === undefined || testo === null ? '' : testo).replace(/^[\r\n\t ]+|[\r\n\t ]+$/g, '');
    var simbologia = '';
    var m = /^\][A-Za-z][0-9A-Za-z]/.exec(t);
    if (m) { simbologia = m[0]; t = t.slice(3); }
    // alcuni lettori scrivono il separatore GS come testo
    t = t.replace(/<GS>|\{GS\}|\[GS\]/gi, GS);
    return { testo: t, simbologia: simbologia };
  }

  function analizza(testo) {
    var grezzo = String(testo === undefined || testo === null ? '' : testo).replace(/^[\r\n\t ]+|[\r\n\t ]+$/g, '');
    var out = vuoto(grezzo);
    var p = pulisci(testo);
    var t = p.testo;
    if (!t) return out;

    // GS1: dichiarato dal prefisso AIM, con il GS, con le parentesi, oppure "01" + GTIN valido seguito da altri campi
    var senzaFnc1 = t.replace(/^\x1D+/, '');
    var campi = null;
    if (/^\(\d{2,4}\)/.test(senzaFnc1)) campi = campiConParentesi(senzaFnc1);
    else if (AIM_GS1[p.simbologia] || t.indexOf(GS) >= 0 ||
      (/^01\d{14}/.test(senzaFnc1) && senzaFnc1.length >= 16 && gtinValido(senzaFnc1.substr(2, 14)))) {
      campi = campiGrezzi(senzaFnc1);
    }
    if (campi && (campi['01'] || campi['02'] || campi['10'] || campi['17'] || campi['21'] || campi['00'] || campi['716'])) {
      out.tipo = 'gs1';
      var g = campi['01'] || campi['02'] || '';
      if (/^\d{14}$/.test(g) && gtinValido(g)) out.gtin = g;
      // AI 716: codice AIC (Italia) nel Data Matrix dei farmaci; vale anche come chiave "aic:", così la confezione
      // si riconosce anche se all'articolo è stato associato il bollino (Code 32)
      var a716 = String(campi['716'] || '').replace(/^[Aa]/, '');
      if (/^\d{9}$/.test(a716) && aicValido(a716)) out.aic = a716;
      out.lotto = (campi['10'] || '').slice(0, 60);
      out.seriale = (campi['21'] || '').slice(0, 60);
      out.scadenza = campi['17'] ? scadenzaGs1(campi['17']) : '';
      if (out.gtin) out.chiavi.push('gtin:' + out.gtin);
      if (out.aic) out.chiavi.push('aic:' + out.aic);
      return out;
    }

    var compatto = t.replace(/\s+/g, '');
    // AIC: "A" + 9 cifre, 9 cifre, oppure Code 39 grezzo in base 32
    var aic = '';
    if (/^[Aa]?\d{9}$/.test(compatto)) aic = aicValido(compatto.replace(/^[Aa]/, '')) ? compatto.replace(/^[Aa]/, '') : '';
    else if (compatto.length === 6) aic = aicDaBase32(compatto);
    if (aic) {
      out.tipo = 'aic';
      out.aic = aic;
      out.chiavi = ['aic:' + aic];
      return out;
    }

    // EAN-13, EAN-8, UPC-A, GTIN-14
    if (/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(compatto) && gtinValido(compatto)) {
      out.tipo = 'ean';
      out.gtin = gtin14(compatto);
      out.chiavi = ['gtin:' + out.gtin];
      return out;
    }

    var c = chiaveCod(t);
    if (c) out.chiavi = [c];
    return out;
  }

  /*
   * Chiave scritta a mano o arrivata al server -> forma normalizzata, oppure null se non è valida
   * (AIC e GTIN con la cifra di controllo sbagliata non sono validi).
   */
  function normalizzaChiave(chiave) {
    var m = /^\s*(aic|gtin|cod)\s*:(.*)$/i.exec(String(chiave === undefined || chiave === null ? '' : chiave));
    if (!m) return null;
    var tipo = m[1].toLowerCase();
    var v = m[2];
    if (tipo === 'aic') {
      v = v.replace(/\s+/g, '');
      return aicValido(v) ? 'aic:' + v : null;
    }
    if (tipo === 'gtin') {
      v = v.replace(/\s+/g, '');
      return gtinValido(v) ? 'gtin:' + gtin14(v) : null;
    }
    v = v.replace(/[\s\x00-\x1F\x7F]/g, '').toUpperCase();
    if (!v || v.length > MAX_COD) return null;
    return 'cod:' + v;
  }

  /* Chiave -> testo da mostrare: "AIC 012345676", "EAN 8012345678901", "ABC123". */
  function descrivi(chiave) {
    var k = String(chiave || '');
    if (k.indexOf('aic:') === 0) return 'AIC ' + k.slice(4);
    if (k.indexOf('gtin:') === 0) {
      var g = k.slice(5);
      if (/^000000/.test(g)) return 'EAN ' + g.slice(6);
      if (g.charAt(0) === '0') return 'EAN ' + g.slice(1);
      return 'GTIN ' + g;
    }
    if (k.indexOf('cod:') === 0) return k.slice(4);
    return k;
  }

  /* Testo letto da mostrare (il separatore GS diventa uno spazio, niente caratteri di controllo). */
  function leggibile(testo) {
    return String(testo || '').replace(/\x1D/g, ' ').replace(/[\x00-\x1F\x7F]/g, '').slice(0, 200);
  }

  var api = {
    analizza: analizza,
    normalizzaChiave: normalizzaChiave,
    descrivi: descrivi,
    leggibile: leggibile,
    gtinValido: gtinValido,
    cifraGtin: cifraGtin,
    aicValido: aicValido,
    cifraAic: cifraAic,
    aicDaBase32: aicDaBase32,
    aicInBase32: aicInBase32,
    scadenzaGs1: scadenzaGs1,
    GS: GS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Barcode = api;
})(this);
