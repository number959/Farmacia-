/*
 * Versione 3.0 – parte D: previsioni statistiche dei consumi e del fabbisogno, condivise fra pagine e prove.
 * UMD come js/calcoli.js: module.exports in Node, window.Previsioni nel browser. Contratto: docs/NOVITA-3.0.md.
 *
 * Funzioni pure sullo stato dell'archivio (App.S o un oggetto con la stessa forma). In breve:
 *   serie(stato, articoloId, reparti, opz)        consumi giornalieri (consumo + perdita, esclusi gli annullati;
 *                                                 i trasferimenti NON sono consumo), con i giorni a zero
 *   periodi(inizio, n, vista) / aggrega(...)       raggruppamento per giorno, settimana (lunedì–domenica) o mese
 *   MODELLI, stima(valori, opz)                    media mobile, livellamento esponenziale, Holt smorzato,
 *                                                 Holt-Winters additivo settimanale, Croston-SBA; scelta automatica
 *                                                 per errore assoluto medio (MAE) di retro-verifica sulle ultime 4 settimane
 *   sigmaPeriodo(stima, scarto, giorni)            incertezza (deviazione standard) di un periodo previsto
 *   analizza(stato, opz)                           fabbisogno di tutti gli articoli di un ambito, con ABC e XYZ
 *   consumoGiornaliero(stato, articoloId, repId)   unità al giorno previste (proposta delle richieste, parte A)
 *   consumoMedio(stato, articoloId, repId, giorni) uscite medie al giorno degli ultimi giorni (assortimento, parte B)
 *   distribuzione(stato, opz)                      quanto la farmacia centrale ha dato a ogni magazzino, consumi, giacenze
 *
 * "reparti" (ambito) vale null = tutta la struttura, un id, oppure un elenco di id di magazzini.
 * Le date sono 'AAAA-MM-GG'. La storia finisce ieri (l'ultimo giorno completo) e la previsione comincia oggi.
 * I calcoli costosi si ricordano finché i dati non cambiano (revisione di Api.rev nel browser, impronta in Node).
 */
(function (root) {
  'use strict';

  var GIORNO_MS = 86400000;
  var GIORNI_MESE = 365.25 / 12;
  var STAGIONE = 7;              // stagionalità settimanale
  var RETRO = 28;                // giorni della retro-verifica (4 settimane)
  var ORIZZONTE_MAX = 366;       // giorni previsti per copertura ed esaurimento
  var MESI_BREVI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

  /* ======================= numeri e date ======================= */

  function r3(x) {
    var v = Math.round((Number(x) || 0) * 1000) / 1000;
    return v === 0 ? 0 : v;
  }

  function numero(v, predefinito) {
    if (v === null || v === undefined || v === '') return predefinito;
    var n = Number(v);
    return isFinite(n) ? n : predefinito;
  }

  function limita(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // 'AAAA-MM-GG' -> numero del giorno (giorni dal 1° gennaio 1970, UTC)
  function numeroGiorno(d) {
    var p = String(d).split('-');
    return Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / GIORNO_MS);
  }

  function dataDa(n) {
    var d = new Date(n * GIORNO_MS);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function aggiungiGiorni(d, n) { return dataDa(numeroGiorno(d) + n); }

  function oggiLocale() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // 0 = lunedì … 6 = domenica
  function giornoSettimana(n) { return (new Date(n * GIORNO_MS).getUTCDay() + 6) % 7; }

  function etichettaData(d) { var p = d.split('-'); return p[2] + '/' + p[1]; }
  function etichettaMese(chiave) { var p = chiave.split('-'); return MESI_BREVI[Number(p[1]) - 1] + ' ' + p[0]; }

  function somma(v, da, a) {
    var s = 0;
    for (var i = Math.max(0, da || 0), f = Math.min(a === undefined ? v.length : a, v.length); i < f; i++) s += v[i];
    return s;
  }

  function media(v, da, a) {
    da = Math.max(0, da || 0);
    a = Math.min(a === undefined ? v.length : a, v.length);
    return a > da ? somma(v, da, a) / (a - da) : 0;
  }

  function deviazione(v) {
    if (v.length < 2) return 0;
    var m = media(v), s = 0;
    for (var i = 0; i < v.length; i++) s += (v[i] - m) * (v[i] - m);
    return Math.sqrt(s / (v.length - 1));
  }

  /*
   * Inversa della normale standard (algoritmo di Acklam, errore relativo < 1,2e-9):
   * normInv(0.95) = 1,645; normInv(0.975) = 1,960.
   */
  function normInv(p) {
    if (!(p > 0)) return -Infinity;
    if (!(p < 1)) return Infinity;
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    var basso = 0.02425, q, r;
    if (p < basso) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - basso) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /* ======================= modelli di previsione ======================= */
  /*
   * Ogni modello: adatta(valori, parametri?) -> { parametri, adattati, alfa, prevedi(h) }
   *   adattati[t]  previsione "un passo avanti" di valori[t] fatta con i dati fino a t-1 (per i residui)
   *   alfa         quanto in fretta il modello segue i dati: allarga l'intervallo con l'orizzonte
   *   prevedi(h)   i prossimi h giorni (mai sotto zero)
   * Senza parametri il modello li sceglie da solo (griglia, errore quadratico un passo avanti più piccolo).
   */

  // i primi giorni servono a partire: non contano nell'errore
  function riscaldo(n) { return Math.min(STAGIONE, Math.max(1, Math.floor(n / 3))); }

  function nonNegativi(v) {
    for (var i = 0; i < v.length; i++) if (!(v[i] > 0)) v[i] = 0;
    return v;
  }

  function griglia(liste) {
    var out = [[]];
    liste.forEach(function (l) {
      var nuovo = [];
      out.forEach(function (base) { l.forEach(function (x) { nuovo.push(base.concat([x])); }); });
      out = nuovo;
    });
    return out;
  }

  function migliore(y, combinazioni, filtra) {
    var meglio = null, sseMeglio = Infinity;
    for (var i = 0; i < combinazioni.length; i++) {
      var sse = filtra(y, combinazioni[i], null).sse;
      if (sse < sseMeglio - 1e-12) { sseMeglio = sse; meglio = combinazioni[i]; }
    }
    return meglio || combinazioni[0];
  }

  /* --- media mobile delle ultime 4 settimane --- */
  function mmAdatta(y, par) {
    var n = y.length;
    var k = par && par.finestra ? par.finestra : Math.max(1, Math.min(RETRO, n));
    var adattati = new Array(n);
    var finestra = 0;
    var iniz = media(y, 0, Math.min(STAGIONE, n));
    for (var t = 0; t < n; t++) {
      var quanti = Math.min(t, k);
      adattati[t] = quanti ? finestra / quanti : iniz;
      finestra += y[t];
      if (t - k >= 0) finestra -= y[t - k];
    }
    var livello = media(y, n - k, n);
    return {
      parametri: { finestra: k },
      adattati: adattati,
      alfa: 2 / (k + 1),
      prevedi: function (h) { var f = []; for (var i = 0; i < h; i++) f.push(livello); return nonNegativi(f); }
    };
  }

  /* --- livellamento esponenziale semplice --- */
  var ALFA_SES = [0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 0.45, 0.6];

  function sesFiltra(y, p, adattati) {
    var a = p[0], l = media(y, 0, Math.min(STAGIONE, y.length)), sse = 0, r = riscaldo(y.length);
    for (var t = 0; t < y.length; t++) {
      var e = y[t] - l;
      if (adattati) adattati[t] = l;
      if (t >= r) sse += e * e;
      l += a * e;
    }
    return { sse: sse, livello: l };
  }

  function sesAdatta(y, par) {
    var p = par && par.alfa !== undefined ? [par.alfa] : migliore(y, ALFA_SES.map(function (a) { return [a]; }), sesFiltra);
    var adattati = new Array(y.length);
    var f = sesFiltra(y, p, adattati);
    return {
      parametri: { alfa: p[0] },
      adattati: adattati,
      alfa: p[0],
      prevedi: function (h) { var v = []; for (var i = 0; i < h; i++) v.push(f.livello); return nonNegativi(v); }
    };
  }

  /* --- Holt con tendenza smorzata --- */
  var GRIGLIA_HOLT = griglia([[0.05, 0.1, 0.2, 0.35, 0.5], [0.02, 0.05, 0.1, 0.2], [0.8, 0.9, 0.98]]);

  function inizioTendenza(y) {
    var l = media(y, 0, Math.min(STAGIONE, y.length));
    var b = y.length >= 2 * STAGIONE ? (media(y, STAGIONE, 2 * STAGIONE) - l) / STAGIONE : 0;
    return { l: l, b: b };
  }

  function holtFiltra(y, p, adattati) {
    var a = p[0], be = p[1], phi = p[2];
    var i0 = inizioTendenza(y), l = i0.l, b = i0.b, sse = 0, r = riscaldo(y.length);
    for (var t = 0; t < y.length; t++) {
      var f = l + phi * b, e = y[t] - f;
      if (adattati) adattati[t] = f;
      if (t >= r) sse += e * e;
      var ln = f + a * e;
      b = be * (ln - l) + (1 - be) * phi * b;
      l = ln;
    }
    return { sse: sse, l: l, b: b };
  }

  function holtAdatta(y, par) {
    var p = par && par.alfa !== undefined ? [par.alfa, par.beta, par.phi] : migliore(y, GRIGLIA_HOLT, holtFiltra);
    var adattati = new Array(y.length);
    var f = holtFiltra(y, p, adattati);
    return {
      parametri: { alfa: p[0], beta: p[1], phi: p[2] },
      adattati: adattati,
      alfa: p[0],
      prevedi: function (h) {
        var v = [], cum = 0, pot = 1;
        for (var i = 0; i < h; i++) { pot *= p[2]; cum += pot; v.push(f.l + cum * f.b); }
        return nonNegativi(v);
      }
    };
  }

  /* --- Holt-Winters additivo con stagionalità settimanale (tendenza smorzata) --- */
  var GRIGLIA_HW = griglia([[0.05, 0.15, 0.3, 0.5], [0.01, 0.05], [0.05, 0.15, 0.3], [0.9, 0.98]]);

  function inizioStagione(y) {
    var sett = Math.min(4, Math.floor(y.length / STAGIONE));
    var medie = [];
    for (var w = 0; w < sett; w++) medie.push(media(y, w * STAGIONE, (w + 1) * STAGIONE));
    var s = [];
    for (var i = 0; i < STAGIONE; i++) {
      var x = 0;
      for (w = 0; w < sett; w++) x += y[w * STAGIONE + i] - medie[w];
      s.push(sett ? x / sett : 0);
    }
    var ms = media(s);
    for (i = 0; i < STAGIONE; i++) s[i] -= ms;
    return { l: medie[0] || 0, b: sett >= 2 ? (medie[sett - 1] - medie[0]) / ((sett - 1) * STAGIONE) : 0, s: s };
  }

  function hwFiltra(y, p, adattati) {
    var a = p[0], be = p[1], g = p[2], phi = p[3];
    var i0 = inizioStagione(y), l = i0.l, b = i0.b, s = i0.s.slice(), sse = 0, r = riscaldo(y.length);
    for (var t = 0; t < y.length; t++) {
      var k = t % STAGIONE;
      var f = l + phi * b + s[k], e = y[t] - f;
      if (adattati) adattati[t] = f;
      if (t >= r) sse += e * e;
      var ln = a * (y[t] - s[k]) + (1 - a) * (l + phi * b);
      b = be * (ln - l) + (1 - be) * phi * b;
      s[k] = g * (y[t] - ln) + (1 - g) * s[k];
      l = ln;
    }
    return { sse: sse, l: l, b: b, s: s, n: y.length };
  }

  function hwAdatta(y, par) {
    var p = par && par.alfa !== undefined ? [par.alfa, par.beta, par.gamma, par.phi] : migliore(y, GRIGLIA_HW, hwFiltra);
    var adattati = new Array(y.length);
    var f = hwFiltra(y, p, adattati);
    return {
      parametri: { alfa: p[0], beta: p[1], gamma: p[2], phi: p[3] },
      adattati: adattati,
      alfa: p[0],
      prevedi: function (h) {
        var v = [], cum = 0, pot = 1;
        for (var i = 1; i <= h; i++) { pot *= p[3]; cum += pot; v.push(f.l + cum * f.b + f.s[(f.n + i - 1) % STAGIONE]); }
        return nonNegativi(v);
      }
    };
  }

  /* --- Croston con la correzione di Syntetos-Boylan (SBA), per l'uso a giorni alterni --- */
  var ALFA_CROSTON = [0.05, 0.1, 0.2, 0.3, 0.4];

  function crostonFiltra(y, p, adattati) {
    var a = p[0], n = y.length, inizio = Math.min(n, RETRO), conte = 0, tot = 0;
    for (var i = 0; i < inizio; i++) if (y[i] > 0) { conte++; tot += y[i]; }
    // partenza: domanda media e intervallo medio dei primi giorni (oppure del primo giorno con consumo)
    var z, q0;
    if (conte) { z = tot / conte; q0 = inizio / conte; } else {
      for (i = 0; i < n && !(y[i] > 0); i++) { /* primo consumo */ }
      z = i < n ? y[i] : 0;
      q0 = i < n ? i + 1 : 1;
    }
    var intervallo = q0, dopo = 0, sse = 0, r = riscaldo(n), k = 1 - a / 2;
    for (var t = 0; t < n; t++) {
      var f = z > 0 ? k * z / intervallo : 0, e = y[t] - f;
      if (adattati) adattati[t] = f;
      if (t >= r) sse += e * e;
      dopo++;
      if (y[t] > 0) {
        z += a * (y[t] - z);
        intervallo += a * (dopo - intervallo);
        dopo = 0;
      }
    }
    return { sse: sse, livello: z > 0 ? k * z / intervallo : 0 };
  }

  function crostonAdatta(y, par) {
    var p = par && par.alfa !== undefined ? [par.alfa] : migliore(y, ALFA_CROSTON.map(function (a) { return [a]; }), crostonFiltra);
    var adattati = new Array(y.length);
    var f = crostonFiltra(y, p, adattati);
    return {
      parametri: { alfa: p[0] },
      adattati: adattati,
      alfa: p[0],
      prevedi: function (h) { var v = []; for (var i = 0; i < h; i++) v.push(f.livello); return nonNegativi(v); }
    };
  }

  // semplicita: a parità di errore (entro il 2%) vince il modello più semplice
  var MODELLI = {
    mediaMobile: { id: 'mediaMobile', nome: 'Media mobile (4 settimane)', breve: 'Media mobile', semplicita: 0, adatta: mmAdatta },
    esponenziale: { id: 'esponenziale', nome: 'Livellamento esponenziale', breve: 'Esponenziale', semplicita: 1, adatta: sesAdatta },
    croston: { id: 'croston', nome: 'Croston-SBA (uso a giorni alterni)', breve: 'Croston', semplicita: 2, adatta: crostonAdatta },
    holt: { id: 'holt', nome: 'Holt smorzato (con tendenza)', breve: 'Holt', semplicita: 3, adatta: holtAdatta },
    holtWinters: { id: 'holtWinters', nome: 'Holt-Winters (ritmo settimanale)', breve: 'Holt-Winters', semplicita: 4, adatta: hwAdatta }
  };
  var NESSUNO = { id: 'nessuno', nome: 'Nessun consumo', breve: '—', semplicita: -1 };

  /* Modelli adatti a una serie: Holt-Winters solo con almeno 4 settimane, Croston se ci sono giorni senza consumo. */
  function candidati(y) {
    var n = y.length, nz = 0;
    for (var i = 0; i < n; i++) if (y[i] > 0) nz++;
    var ids = ['mediaMobile', 'esponenziale'];
    if (nz >= 2 && (n - nz) / n >= 0.1) ids.push('croston');
    if (n >= 2 * STAGIONE) ids.push('holt');
    if (n >= 4 * STAGIONE) ids.push('holtWinters');
    return ids;
  }

  /* Errore relativo sulle settimane (somma degli scarti settimanali / somma dei consumi), dalla fine. */
  function erroreSettimanale(previsti, reali) {
    var n = reali.length, num = 0, den = 0;
    for (var fine = n; fine - STAGIONE >= 0; fine -= STAGIONE) {
      var p = somma(previsti, fine - STAGIONE, fine), r = somma(reali, fine - STAGIONE, fine);
      num += Math.abs(p - r);
      den += r;
    }
    return den > 0 ? num / den : (num > 0 ? Infinity : 0);
  }

  /*
   * MAE delle somme di 7 giorni consecutivi (finestre mobili), riportato al giorno: misura quanto il modello
   * sbaglia il livello dei consumi, che è quello che conta per ordinare. Sulle domande intermittenti l'errore
   * giornaliero da solo premia le previsioni troppo basse (la mediana dei giorni è zero).
   */
  function maeSettimane(previsti, reali) {
    var n = reali.length;
    if (n < STAGIONE) return 0;
    var sp = somma(previsti, 0, STAGIONE), sr = somma(reali, 0, STAGIONE), err = Math.abs(sp - sr), k = 1;
    for (var i = STAGIONE; i < n; i++) {
      sp += previsti[i] - previsti[i - STAGIONE];
      sr += reali[i] - reali[i - STAGIONE];
      err += Math.abs(sp - sr);
      k++;
    }
    return err / k / STAGIONE;
  }

  function giudizio(errSett, n) {
    if (n < 4 * STAGIONE || !isFinite(errSett)) return { id: 'scarsa', testo: 'Pochi dati' };
    if (errSett <= 0.25) return { id: 'alta', testo: 'Alta' };
    if (errSett <= 0.5) return { id: 'media', testo: 'Media' };
    return { id: 'bassa', testo: 'Bassa' };
  }

  /*
   * Stima di una serie giornaliera: sceglie il modello per errore assoluto medio (MAE) sulle ultime 4 settimane
   * (retro-verifica: ogni modello impara dai giorni prima e prevede le 4 settimane, che poi si confrontano con il vero),
   * poi lo riadatta a tutta la serie con gli stessi parametri. Il punteggio è il MAE giornaliero più il MAE delle somme
   * di 7 giorni (riportato al giorno): il primo premia chi coglie il ritmo dei giorni, il secondo chi coglie il livello.
   * A parità (entro il 2%) vince il modello più semplice.
   * opz.modello: forza un modello; opz.criterio 'giornaliero': solo il MAE giornaliero; opz.tolleranza (0.02).
   * Restituisce:
   *   { id, nome, breve, parametri, alfa, sigma, mae, wape, errSett, affidabilita, giorni, retro: { giorni, reali },
   *     candidati: [{ id, nome, breve, mae, maeSettimane, punteggio, wape, errSett, previsti }], prevedi(h) }
   */
  function stima(valori, opz) {
    opz = opz || {};
    var y = valori.map(function (x) { return Number(x) || 0; });
    var n = y.length;
    var tot = somma(y);
    if (!n || !(tot > 0)) {
      return {
        id: NESSUNO.id, nome: NESSUNO.nome, breve: NESSUNO.breve, parametri: {}, alfa: 0, sigma: 0, mae: null, wape: null, errSett: null,
        affidabilita: n ? { id: 'nessuna', testo: 'Nessun consumo' } : { id: 'nessuna', testo: 'Nessun dato' }, giorni: n, candidati: [], retro: null,
        prevedi: function (h) { var v = []; for (var i = 0; i < h; i++) v.push(0); return v; }
      };
    }
    var H = n >= RETRO + 3 * STAGIONE ? RETRO : (n >= 3 * STAGIONE ? Math.max(STAGIONE, Math.floor(n / 3 / STAGIONE) * STAGIONE) : 0);
    var lista = [];
    var scelto = null;
    if (H) {
      var studio = y.slice(0, n - H), prova = y.slice(n - H);
      var ids = opz.modello && MODELLI[opz.modello] ? [opz.modello] : candidati(studio);
      lista = ids.map(function (id) {
        var m = MODELLI[id].adatta(studio);
        var previsti = m.prevedi(H);
        var err = 0, den = 0;
        for (var i = 0; i < H; i++) { err += Math.abs(previsti[i] - prova[i]); den += prova[i]; }
        var c = {
          id: id, nome: MODELLI[id].nome, breve: MODELLI[id].breve, parametri: m.parametri,
          mae: err / H, maeSettimane: maeSettimane(previsti, prova), wape: den > 0 ? err / den : null,
          errSett: erroreSettimanale(previsti, prova), previsti: previsti
        };
        c.punteggio = opz.criterio === 'giornaliero' ? c.mae : c.mae + c.maeSettimane;
        return c;
      });
      var minimo = Math.min.apply(null, lista.map(function (c) { return c.punteggio; }));
      lista.forEach(function (c) {
        if (c.punteggio <= minimo * (1 + (opz.tolleranza === undefined ? 0.02 : opz.tolleranza)) + 1e-9 && (!scelto || MODELLI[c.id].semplicita < MODELLI[scelto.id].semplicita)) scelto = c;
      });
    } else {
      // storia troppo corta per la retro-verifica: regola semplice
      var nz = 0;
      for (var i = 0; i < n; i++) if (y[i] > 0) nz++;
      var id = opz.modello && MODELLI[opz.modello] ? opz.modello : (n < STAGIONE ? 'mediaMobile' : (nz >= 2 && nz / n <= 0.7 ? 'croston' : 'esponenziale'));
      scelto = { id: id, mae: null, wape: null, errSett: Infinity, parametri: null };
    }
    var def = MODELLI[scelto.id];
    var m = def.adatta(y, scelto.parametri);
    // residui un passo avanti dopo il riscaldo
    var r = riscaldo(n), sq = 0, k = 0;
    for (var t = r; t < n; t++) { var e = y[t] - m.adattati[t]; sq += e * e; k++; }
    var sigma = k >= 3 ? Math.sqrt(sq / k) : deviazione(y);
    var memo = null;
    return {
      id: def.id, nome: def.nome, breve: def.breve, parametri: m.parametri, alfa: m.alfa, sigma: sigma,
      mae: scelto.mae, wape: scelto.wape, errSett: scelto.errSett,
      affidabilita: giudizio(scelto.errSett, n), giorni: n,
      retro: H ? { giorni: H, reali: y.slice(n - H) } : null,
      candidati: lista,
      prevedi: function (h) {
        if (!memo || memo.length < h) memo = m.prevedi(Math.max(h, memo ? memo.length : 0));
        return memo.slice(0, h);
      }
    };
  }

  /*
   * Deviazione standard della somma prevista di "giorni" giorni che cominciano dopo "scarto" giorni di previsione.
   * Modello a livello locale: ogni errore futuro sposta il livello di alfa·errore, così l'incertezza cresce con l'orizzonte.
   *   giorno singolo h (scarto h-1, giorni 1): sigma·√(1 + (h-1)·alfa²)
   */
  function sigmaPeriodo(st, scarto, giorni) {
    var s = st && st.sigma ? st.sigma : 0;
    if (!s || giorni <= 0) return 0;
    var a = st.alfa || 0, v = 0;
    for (var m = 0; m < giorni; m++) v += (1 + a * m) * (1 + a * m);
    v += giorni * giorni * a * a * Math.max(0, scarto);
    return s * Math.sqrt(v);
  }

  /* Previsione giorno per giorno con la banda: { previsti, basso, alto } (livello: 0.9 = intervallo al 90%). */
  function banda(st, h, livello) {
    var z = normInv(1 - (1 - (livello || 0.9)) / 2);
    var f = st.prevedi(h), basso = [], alto = [];
    for (var i = 0; i < h; i++) {
      var s = sigmaPeriodo(st, i, 1);
      basso.push(Math.max(0, f[i] - z * s));
      alto.push(f[i] + z * s);
    }
    return { previsti: f, basso: basso, alto: alto };
  }

  /* ======================= indice dei dati (un passaggio sui movimenti) ======================= */

  var memoria = { chiave: null, movimenti: null, indice: null, stime: {}, analisi: {}, distribuzioni: {} };

  function lista(stato, k) { return stato && Array.isArray(stato[k]) ? stato[k] : []; }

  /*
   * Chiave dei dati: nel browser la revisione dei dati (Api.rev) basta; in Node (prove) un'impronta delle tabelle.
   * La memoria vale anche solo finché l'elenco dei movimenti è lo stesso oggetto.
   */
  function chiaveDati(stato) {
    var mov = lista(stato, 'movimenti');
    var Api = root && root.Api, App = root && root.App;
    var conte = mov.length + ':' + lista(stato, 'ddt').length + ':' + lista(stato, 'ddtRighe').length + ':' + lista(stato, 'reparti').length;
    if (Api && App && App.S === stato && isFinite(Api.rev)) return 'rev:' + Api.rev + ':' + conte;
    var annullati = 0;
    for (var i = 0; i < mov.length; i++) if (mov[i].annullato) annullati++;
    var ddt = lista(stato, 'ddt').map(function (d) { return d.id + d.stato; }).join(',');
    return 'imp:' + conte + ':' + annullati + ':' + (mov.length ? mov[0].id + ':' + mov[mov.length - 1].id : '') + ':' + ddt;
  }

  function aggiungiA(oggetto, a, b, v) {
    var x = oggetto[a] || (oggetto[a] = {});
    x[b] = (x[b] || 0) + v;
  }

  function primoA(oggetto, a, b, g) {
    var x = oggetto[a] || (oggetto[a] = {});
    if (x[b] === undefined || g < x[b]) x[b] = g;
  }

  function costruisciIndice(stato) {
    var giorni = {};
    function g(d) { var x = giorni[d]; if (x === undefined) x = giorni[d] = numeroGiorno(d); return x; }
    var transito = {};
    lista(stato, 'reparti').forEach(function (r) { if (r.tipo === 'transito') transito[r.id] = true; });
    var I = {
      cons: {},       // articolo -> magazzino ('*' = struttura) -> giorno -> consumo + perdita
      usc: {},        // articolo -> magazzino -> giorno -> trasferimenti in uscita (per la farmacia centrale)
      primo: {},      // articolo -> magazzino ('*') -> primo giorno con un movimento qualsiasi
      primoRep: {},   // magazzino -> primo giorno con un movimento
      giac: {},       // articolo -> magazzino -> giacenza attuale
      fornitore: {},  // articolo -> { chiave, nome } dell'ultimo carico con fornitore
      viaggio: {},    // articolo -> magazzino di arrivo -> merce partita con un DDT e non ancora ricevuta
      transito: transito,
      ultimo: null    // ultimo giorno con movimenti
    };
    var mov = lista(stato, 'movimenti');
    for (var i = 0; i < mov.length; i++) {
      var m = mov[i];
      if (!m || m.annullato || !m.data) continue;
      var q = Number(m.quantita) || 0;
      var d = g(m.data);
      var a = m.articoloId, r = m.repartoId;
      if (I.ultimo === null || d > I.ultimo) I.ultimo = d;
      primoA(I.primo, a, r, d);
      primoA(I.primo, a, '*', d);
      if (I.primoRep[r] === undefined || d < I.primoRep[r]) I.primoRep[r] = d;
      switch (m.tipo) {
        case 'consumo':
        case 'perdita':
          aggiungiA(I.cons[a] || (I.cons[a] = {}), r, d, q);
          aggiungiA(I.cons[a], '*', d, q);
          aggiungiA(I.giac, a, r, -q);
          break;
        case 'carico':
          aggiungiA(I.giac, a, r, q);
          if (m.fornitore) {
            var f = I.fornitore[a];
            if (!f || m.data > f.data || (m.data === f.data && (m.creato || 0) >= f.creato)) I.fornitore[a] = { data: m.data, creato: m.creato || 0, nome: m.fornitore };
          }
          break;
        case 'rettifica':
          aggiungiA(I.giac, a, r, q);
          break;
        case 'trasferimento':
          var dest = m.repartoDestId;
          aggiungiA(I.giac, a, r, -q);
          aggiungiA(I.giac, a, dest, q);
          primoA(I.primo, a, dest, d);
          if (I.primoRep[dest] === undefined || d < I.primoRep[dest]) I.primoRep[dest] = d;
          if (!transito[r]) aggiungiA(I.usc[a] || (I.usc[a] = {}), r, d, q);
          break;
        default:
          break;
      }
    }
    // merce in viaggio: righe dei DDT partiti e non ancora ricevuti (come Calcoli.merceInViaggio)
    var arrivo = {};
    lista(stato, 'ddt').forEach(function (x) { if (x.stato === 'in_transito') arrivo[x.id] = x.destinazioneId; });
    lista(stato, 'ddtRighe').forEach(function (x) {
      var dest = arrivo[x.ddtId];
      if (dest) aggiungiA(I.viaggio, x.articoloId, dest, Number(x.quantita) || 0);
    });
    return I;
  }

  function indice(stato) {
    var k = chiaveDati(stato);
    if (memoria.indice && memoria.chiave === k && memoria.movimenti === stato.movimenti) return memoria.indice;
    memoria = { chiave: k, movimenti: stato.movimenti, indice: costruisciIndice(stato), stime: {}, analisi: {}, distribuzioni: {} };
    return memoria.indice;
  }

  function svuota() { memoria = { chiave: null, movimenti: null, indice: null, stime: {}, analisi: {}, distribuzioni: {} }; }

  /* ======================= ambito e serie ======================= */

  // null = tutta la struttura; altrimenti elenco di id di magazzini
  function ambito(reparti) {
    if (reparti === null || reparti === undefined || reparti === '' || reparti === '*') return null;
    var l = Array.isArray(reparti) ? reparti.filter(Boolean) : [reparti];
    return l.length ? l.slice().sort() : null;
  }

  function chiaveAmbito(amb) { return amb ? amb.join(',') : '*'; }

  /* Parametri dalle impostazioni (docs/NOVITA-3.0.md) con i valori predefiniti. */
  function parametri(stato, opz) {
    opz = opz || {};
    var imp = (stato && stato.impostazioni) || {};
    var oggi = opz.oggi || oggiLocale();
    return {
      oggi: oggi,
      fine: opz.fine || aggiungiGiorni(oggi, -1),
      leadTime: limita(Math.round(numero(imp.leadTimeGiorni, 7)), 0, 365),
      revisione: limita(Math.round(numero(imp.periodoRevisioneGiorni, 7)), 1, 365),
      servizio: limita(numero(imp.livelloServizio, 0.95), 0.5, 0.9999),
      storico: limita(Math.round(numero(opz.storico, numero(imp.storicoGiorni, 180))), 14, 3650),
      orizzonte: limita(Math.round(numero(opz.orizzonte, 30)), 1, ORIZZONTE_MAX)
    };
  }

  function mappeAmbito(perMagazzino, amb) {
    if (!perMagazzino) return [];
    if (!amb) return perMagazzino['*'] ? [perMagazzino['*']] : [];
    return amb.map(function (r) { return perMagazzino[r]; }).filter(Boolean);
  }

  /*
   * Consumi giornalieri (consumo + perdita) di un articolo in un ambito, dal primo movimento dell'articolo
   * nell'ambito (al massimo "storico" giorni prima) fino a "fine" (predefinito: ieri), con i giorni a zero.
   * Restituisce { inizio, fine, valori } (inizio null e valori vuoti se l'articolo non si è mai mosso lì).
   */
  function serie(stato, articoloId, reparti, opz) {
    var I = indice(stato);
    var p = parametri(stato, opz);
    return serieDa(I, articoloId, ambito(reparti), numeroGiorno(p.fine), p.storico);
  }

  function serieDa(I, articoloId, amb, fine, storico) {
    var primi = I.primo[articoloId] || {};
    var primo;
    if (!amb) primo = primi['*'];
    else amb.forEach(function (r) { if (primi[r] !== undefined && (primo === undefined || primi[r] < primo)) primo = primi[r]; });
    if (primo === undefined || primo > fine) return { inizio: null, fine: dataDa(fine), valori: [] };
    var inizio = Math.max(fine - storico + 1, primo);
    var n = fine - inizio + 1;
    var v = new Array(n);
    for (var i = 0; i < n; i++) v[i] = 0;
    mappeAmbito(I.cons[articoloId], amb).forEach(function (mappa) {
      for (var k in mappa) {
        var d = Number(k);
        if (d >= inizio && d <= fine) v[d - inizio] += mappa[k];
      }
    });
    for (i = 0; i < n; i++) v[i] = r3(v[i]);
    return { inizio: dataDa(inizio), fine: dataDa(fine), valori: v };
  }

  /*
   * Periodi di una serie che comincia il giorno "inizio" e dura n giorni:
   * [{ chiave, etichetta, inizio, fine, da, a }] (da/a: indici nella serie, a escluso).
   * vista: 'giorno' | 'settimana' (da lunedì) | 'mese'.
   */
  function periodi(inizio, n, vista) {
    var out = [];
    if (!inizio || n <= 0) return out;
    var g0 = numeroGiorno(inizio);
    var corrente = null;
    for (var i = 0; i < n; i++) {
      var g = g0 + i, d = dataDa(g), chiave;
      if (vista === 'mese') chiave = d.slice(0, 7);
      else if (vista === 'settimana') chiave = dataDa(g - giornoSettimana(g));
      else chiave = d;
      if (!corrente || corrente.chiave !== chiave) {
        if (corrente) out.push(corrente);
        var etichetta = vista === 'mese' ? etichettaMese(chiave) : (vista === 'settimana' ? 'sett. ' + etichettaData(chiave) : etichettaData(d));
        corrente = { chiave: chiave, etichetta: etichetta, inizio: d, fine: d, da: i, a: i + 1 };
      } else {
        corrente.fine = d;
        corrente.a = i + 1;
      }
    }
    if (corrente) out.push(corrente);
    return out;
  }

  /* Somma di una serie per periodo: [{ …periodo, valore, giorni, completo }] (completo: settimana o mese intero). */
  function aggrega(serieO, vista) {
    return periodi(serieO.inizio, serieO.valori.length, vista).map(function (p) {
      var giorni = p.a - p.da;
      var pieno = vista === 'settimana' ? 7 : (vista === 'mese' ? new Date(Date.UTC(Number(p.chiave.slice(0, 4)), Number(p.chiave.slice(5, 7)), 0)).getUTCDate() : 1);
      return Object.assign({}, p, { valore: r3(somma(serieO.valori, p.da, p.a)), giorni: giorni, completo: giorni === pieno });
    });
  }

  /* Totali delle settimane complete, dalla fine all'indietro (le più vecchie prima). */
  function settimaneComplete(v) {
    var out = [];
    for (var fine = v.length; fine - STAGIONE >= 0; fine -= STAGIONE) out.unshift(somma(v, fine - STAGIONE, fine));
    return out;
  }

  /* Stima memorizzata per articolo e ambito. */
  function stimaPer(I, articoloId, amb, p) {
    var fine = numeroGiorno(p.fine);
    var k = articoloId + '|' + chiaveAmbito(amb) + '|' + fine + '|' + p.storico;
    var x = memoria.stime[k];
    if (!x) {
      var s = serieDa(I, articoloId, amb, fine, p.storico);
      x = memoria.stime[k] = { serie: s, stima: stima(s.valori) };
    }
    return x;
  }

  /* ======================= indicatori per articolo ======================= */

  function giacenzaAmbito(I, articoloId, amb) {
    var g = I.giac[articoloId] || {}, v = I.viaggio[articoloId] || {}, giac = 0, viaggio = 0, k;
    if (!amb) {
      for (k in g) if (!I.transito[k]) giac += g[k];
      for (k in v) viaggio += v[k];
    } else {
      amb.forEach(function (r) { giac += g[r] || 0; viaggio += v[r] || 0; });
    }
    return { giacenza: r3(giac), inViaggio: r3(viaggio) };
  }

  /* Tendenza %: ultime 4 settimane contro le 4 prima (o le due metà della storia se è più corta). */
  function tendenza(v) {
    var k = Math.min(RETRO, Math.floor(v.length / 2));
    if (k < STAGIONE) return null;
    var dopo = somma(v, v.length - k), prima = somma(v, v.length - 2 * k, v.length - k);
    if (!(prima > 0)) return null;
    return Math.round((dopo - prima) / prima * 1000) / 10;
  }

  /* Giorni di copertura della merce disponibile e data stimata di esaurimento (null = non si esaurisce entro un anno). */
  function copertura(previsti, disponibile, oggi) {
    if (!(disponibile > 0)) return { giorni: 0, esaurimento: oggi };
    var resto = disponibile;
    for (var i = 0; i < previsti.length; i++) {
      if (previsti[i] >= resto - 1e-9) {
        var giorni = Math.round((i + resto / previsti[i]) * 10) / 10;
        return { giorni: giorni, esaurimento: aggiungiGiorni(oggi, i) };
      }
      resto -= previsti[i];
    }
    return { giorni: Infinity, esaurimento: null };
  }

  function fornitoreDi(I, a) {
    if (a && a.fornitore) return String(a.fornitore);
    var f = a && I.fornitore[a.id];
    return f ? f.nome : '';
  }

  /*
   * Fabbisogno di un articolo in un ambito. Restituisce la riga della tabella:
   *   mediaGiorno/Settimana/Mese (storia), tendenza %, previstoOrizzonte, giacenza, inViaggio, disponibile,
   *   copertura (giorni), esaurimento, leadTime, sigma, scortaSicurezza = z·σ·√LT, puntoRiordino = previsione su LT + scorta,
   *   fabbisogno = previsione su (LT + revisione) + scorta, daOrdinare (unità, a confezioni intere), confezioni,
   *   modello, affidabilita, valoreStorico, valoreOrdine, fornitore, settimane (sparkline), stima, serie.
   */
  function rigaArticolo(I, a, amb, p) {
    var x = stimaPer(I, a.id, amb, p);
    var v = x.serie.valori, st = x.stima, n = v.length;
    var tot = somma(v);
    var mediaG = n ? tot / n : 0;
    var lt = a.leadTime !== null && a.leadTime !== undefined && a.leadTime !== '' && isFinite(Number(a.leadTime)) ? limita(Math.round(Number(a.leadTime)), 0, 365) : p.leadTime;
    var copre = lt + p.revisione;
    var lunghezza = Math.max(ORIZZONTE_MAX, copre, p.orizzonte);
    var previsti = st.prevedi(lunghezza);
    var z = normInv(p.servizio);
    var scorta = st.sigma > 0 ? z * st.sigma * Math.sqrt(Math.max(lt, 1)) : 0;
    var g = giacenzaAmbito(I, a.id, amb);
    var disponibile = r3(Math.max(0, g.giacenza) + g.inViaggio);
    var puntoRiordino = r3(somma(previsti, 0, lt) + scorta);
    var fabbisogno = r3(somma(previsti, 0, copre) + scorta);
    var pezzi = Number(a.pezziConfezione) > 0 ? Number(a.pezziConfezione) : 1;
    var manca = fabbisogno - disponibile;
    var confezioni = manca > 1e-6 ? Math.ceil(manca / pezzi - 1e-9) : 0;
    var cop = copertura(previsti, disponibile, p.oggi);
    var prezzo = Number(a.prezzo) || 0;
    var prossime = [];
    for (var w = 0; w < 4; w++) prossime.push(r3(somma(previsti, w * STAGIONE, (w + 1) * STAGIONE)));
    return {
      articoloId: a.id,
      articolo: a,
      nome: a.nome,
      categoria: a.categoria,
      unita: a.unita || '',
      prezzo: prezzo,
      pezziConfezione: pezzi,
      giorniStorico: n,
      totaleStorico: r3(tot),
      mediaGiorno: mediaG,
      mediaSettimana: mediaG * 7,
      mediaMese: mediaG * GIORNI_MESE,
      tendenza: tendenza(v),
      previstoOrizzonte: r3(somma(previsti, 0, p.orizzonte)),
      previstoGiorno: somma(previsti, 0, p.orizzonte) / p.orizzonte,
      giacenza: g.giacenza,
      inViaggio: g.inViaggio,
      disponibile: disponibile,
      copertura: cop.giorni,
      esaurimento: cop.esaurimento,
      leadTime: lt,
      revisione: p.revisione,
      sigma: st.sigma,
      scortaSicurezza: r3(scorta),
      puntoRiordino: puntoRiordino,
      fabbisogno: fabbisogno,
      sottoRiordino: tot > 0 && disponibile <= puntoRiordino,
      confezioni: confezioni,
      daOrdinare: r3(confezioni * pezzi),
      modello: st.id,
      nomeModello: st.nome,
      breveModello: st.breve,
      affidabilita: st.affidabilita,
      mae: st.mae,
      valoreStorico: Math.round(tot * prezzo * 100) / 100,
      valoreOrdine: Math.round(confezioni * pezzi * prezzo * 100) / 100,
      fornitore: fornitoreDi(I, a),
      settimane: settimaneComplete(v).slice(-12),
      prossime: prossime,
      abc: 'C',
      xyz: null,
      stima: st,
      serie: x.serie
    };
  }

  /* ======================= classificazione ABC e XYZ ======================= */

  /* ABC per valore dei consumi (quantità × prezzo; senza prezzi, per quantità): A fino all'80%, B fino al 95%, poi C. */
  function classificaABC(righe) {
    var conValore = righe.some(function (r) { return r.valoreStorico > 0; });
    var val = function (r) { return conValore ? r.valoreStorico : r.totaleStorico; };
    var totale = righe.reduce(function (s, r) { return s + val(r); }, 0);
    var ordinate = righe.slice().sort(function (x, y) { return val(y) - val(x); });
    var cum = 0;
    ordinate.forEach(function (r) {
      var v = val(r);
      if (!(v > 0) || !(totale > 0)) r.abc = 'C';
      else r.abc = cum / totale < 0.8 ? 'A' : (cum / totale < 0.95 ? 'B' : 'C');
      cum += v;
    });
    return righe;
  }

  /*
   * XYZ per variabilità (coefficiente di variazione dei consumi settimanali, che per gli articoli usati a giorni
   * alterni è più stabile di quello giornaliero): X fino a 0,5, Y fino a 1, Z oltre. Senza consumi: null.
   */
  function coefficienteVariazione(v) {
    var sett = settimaneComplete(v);
    if (sett.length >= 4) {
      var m = media(sett);
      return m > 0 ? deviazione(sett) / m : null;
    }
    if (v.length >= 2 * STAGIONE) {
      var mg = media(v);
      return mg > 0 ? deviazione(v) / mg / Math.sqrt(STAGIONE) : null;
    }
    return null;
  }

  function classeXYZ(cv) {
    if (cv === null || cv === undefined || !isFinite(cv)) return null;
    return cv <= 0.5 ? 'X' : (cv <= 1 ? 'Y' : 'Z');
  }

  function classificaXYZ(righe) {
    righe.forEach(function (r) {
      r.cv = coefficienteVariazione(r.serie.valori);
      r.xyz = r.totaleStorico > 0 ? classeXYZ(r.cv) : null;
    });
    return righe;
  }

  /* ======================= analisi di un ambito ======================= */

  /*
   * Articoli da considerare: attivi della categoria; per un magazzino solo quelli che vi si sono mossi o che sono
   * nel suo assortimento.
   */
  function articoliAmbito(stato, I, amb, opz) {
    var inAss = {};
    if (amb) lista(stato, 'assortimento').forEach(function (x) { if (x.attivo !== false && amb.indexOf(x.repartoId) >= 0) inAss[x.articoloId] = true; });
    var filtro = opz.articoli ? opz.articoli.reduce(function (o, id) { o[id] = true; return o; }, {}) : null;
    return lista(stato, 'articoli').filter(function (a) {
      if (filtro) return !!filtro[a.id];
      if (a.attivo === false) return false;
      if (opz.categoria && a.categoria !== opz.categoria) return false;
      if (!amb) return true;
      if (inAss[a.id]) return true;
      var pr = I.primo[a.id] || {};
      return amb.some(function (r) { return pr[r] !== undefined; });
    });
  }

  /*
   * Analisi del fabbisogno di un ambito: { parametri, righe, abcxyz, totali }.
   * opz: { reparti (null = struttura), categoria, orizzonte (giorni), oggi, articoli: [id] (facoltativo) }
   * Il risultato si ricorda finché dati e impostazioni non cambiano.
   */
  function analizza(stato, opz) {
    opz = opz || {};
    var I = indice(stato);
    var p = parametri(stato, opz);
    var amb = ambito(opz.reparti);
    var artFirma = lista(stato, 'articoli').length + ':' + lista(stato, 'articoli').reduce(function (s, a) { return s + (Number(a.versione) || 0); }, 0);
    var k = [chiaveAmbito(amb), opz.categoria || '', p.oggi, p.fine, p.orizzonte, p.leadTime, p.revisione, p.servizio, p.storico,
      artFirma, lista(stato, 'assortimento').length, opz.articoli ? opz.articoli.join(',') : ''].join('|');
    if (memoria.analisi[k]) return memoria.analisi[k];
    var righe = articoliAmbito(stato, I, amb, opz).map(function (a) { return rigaArticolo(I, a, amb, p); });
    classificaABC(righe);
    classificaXYZ(righe);
    var matrice = {};
    ['A', 'B', 'C'].forEach(function (x) { ['X', 'Y', 'Z'].forEach(function (y) { matrice[x + y] = { articoli: 0, valore: 0 }; }); });
    var totali = { articoli: righe.length, conConsumi: 0, valoreStorico: 0, previsto: 0, valorePrevisto: 0, daOrdinare: 0, valoreOrdine: 0, sottoRiordino: 0, inEsaurimento: 0 };
    var limite = aggiungiGiorni(p.oggi, p.leadTime);
    righe.forEach(function (r) {
      if (r.totaleStorico > 0) totali.conConsumi++;
      totali.valoreStorico += r.valoreStorico;
      totali.previsto += r.previstoOrizzonte;
      totali.valorePrevisto += r.previstoOrizzonte * r.prezzo;
      if (r.confezioni > 0) totali.daOrdinare++;
      totali.valoreOrdine += r.valoreOrdine;
      if (r.sottoRiordino) totali.sottoRiordino++;
      if (r.esaurimento && r.esaurimento <= limite && r.totaleStorico > 0) totali.inEsaurimento++;
      if (r.xyz) { var c = matrice[r.abc + r.xyz]; c.articoli++; c.valore += r.valoreStorico; }
    });
    totali.valoreStorico = Math.round(totali.valoreStorico * 100) / 100;
    totali.valorePrevisto = Math.round(totali.valorePrevisto * 100) / 100;
    totali.valoreOrdine = Math.round(totali.valoreOrdine * 100) / 100;
    totali.previsto = r3(totali.previsto);
    var ris = { parametri: p, reparti: amb, righe: righe, matrice: matrice, totali: totali };
    memoria.analisi[k] = ris;
    return ris;
  }

  /*
   * Le stime di un ambito sono già pronte (analizza() sarà immediata)?
   * Con molti articoli la pagina usa prepara() per non bloccare il browser.
   */
  function pronto(stato, opz) {
    opz = opz || {};
    var I = indice(stato);
    var p = parametri(stato, opz);
    var amb = ambito(opz.reparti);
    var suffisso = '|' + chiaveAmbito(amb) + '|' + numeroGiorno(p.fine) + '|' + p.storico;
    return articoliAmbito(stato, I, amb, opz).every(function (a) { return !!memoria.stime[a.id + suffisso]; });
  }

  /*
   * Prepara a pezzi le stime di un ambito (ogni pezzo lavora al massimo ~20 ms, poi lascia respirare la pagina).
   * avanzamento(fatti, totale) facoltativo. Restituisce una Promise; se nel frattempo i dati cambiano si ferma
   * (la pagina che ridisegna ricomincia con i dati nuovi).
   */
  function prepara(stato, opz, avanzamento) {
    opz = opz || {};
    var I = indice(stato);
    var p = parametri(stato, opz);
    var amb = ambito(opz.reparti);
    var articoli = articoliAmbito(stato, I, amb, opz);
    var i = 0;
    var aspetta = root && root.setTimeout ? root.setTimeout : setTimeout;
    return new Promise(function (ok) {
      function pezzo() {
        if (memoria.indice !== I) { ok(false); return; }
        var t0 = Date.now();
        while (i < articoli.length && Date.now() - t0 < 20) { stimaPer(I, articoli[i].id, amb, p); i++; }
        if (avanzamento) { try { avanzamento(i, articoli.length); } catch (e) { /* solo informativo */ } }
        if (i < articoli.length) aspetta(pezzo, 0); else ok(true);
      }
      pezzo();
    });
  }

  /* ======================= funzioni per le altre parti ======================= */

  /*
   * Unità al giorno previste per un articolo in un magazzino (null = tutta la struttura): media della previsione
   * sul prossimo periodo di revisione (almeno una settimana). 0 se non ci sono consumi.
   * La usa la proposta delle quantità delle richieste (js/pagine-logistica.js).
   */
  function consumoGiornaliero(stato, articoloId, repartoId, opz) {
    var p = parametri(stato, opz);
    var x = stimaPer(indice(stato), articoloId, ambito(repartoId), p);
    var giorni = Math.max(STAGIONE, p.revisione);
    return r3(somma(x.stima.prevedi(giorni)) / giorni);
  }

  /*
   * Uscite medie al giorno degli ultimi "giorni" giorni (oggi compreso) di un articolo in un magazzino: consumi e perdite;
   * per la farmacia centrale anche quello che dà agli altri magazzini. Con una storia del magazzino più corta si divide
   * per i giorni che ci sono (almeno 7). La usa "Proponi dai consumi" dell'assortimento (js/pagine-struttura.js).
   */
  function consumoMedio(stato, articoloId, repartoId, giorni, opz) {
    var I = indice(stato);
    giorni = Math.max(1, Math.round(numero(giorni, 90)));
    var oggi = numeroGiorno((opz && opz.oggi) || oggiLocale());
    var dal = oggi - giorni + 1;
    var rep = (lista(stato, 'reparti').filter(function (r) { return r.id === repartoId; })[0]) || {};
    var centrale = rep.tipo === 'centrale' || (rep.centrale && rep.tipo !== 'periferico');
    var tot = 0;
    [I.cons, centrale ? I.usc : null].forEach(function (fonte) {
      var mappa = fonte && fonte[articoloId] && fonte[articoloId][repartoId];
      if (!mappa) return;
      for (var k in mappa) { var d = Number(k); if (d >= dal && d <= oggi) tot += mappa[k]; }
    });
    var div = giorni;
    var primo = I.primoRep[repartoId];
    if (primo !== undefined && primo > dal) div = Math.max(STAGIONE, oggi - primo + 1);
    return tot / div;
  }

  /* ======================= distribuzione alle periferiche ======================= */

  function meseDi(d) { return d.slice(0, 7); }

  function mesiTra(dal, al) {
    var out = [];
    var a = Number(dal.slice(0, 4)), m = Number(dal.slice(5, 7));
    var fine = meseDi(al);
    for (var i = 0; i < 600; i++) {
      var k = a + '-' + pad(m);
      out.push(k);
      if (k >= fine) break;
      m++;
      if (m > 12) { m = 1; a++; }
    }
    return out;
  }

  function centraleDi(stato) {
    var r = lista(stato, 'reparti');
    var c = r.filter(function (x) { return x.tipo === 'centrale' && x.attivo !== false; })[0] || r.filter(function (x) { return x.centrale && x.attivo !== false; })[0];
    return c ? c.id : null;
  }

  /*
   * Movimenti fra magazzini, consumi e giacenze per la pagina Distribuzione.
   * opz: { dal, al, centraleId (predefinito: la farmacia centrale) }
   * Restituisce {
   *   dal, al, centraleId, mesi: ['AAAA-MM'],
   *   perArticolo: { articoloId: { magazzinoId: { dato, resi, daAltri, adAltri, consumato, perdite, giacenza, inViaggio } } },
   *   perMese:     { 'AAAA-MM': { magazzinoId: { articoloId: dato } } }
   * }
   *   dato      arrivato dalla farmacia centrale: DDT ricevuti (alla data di ricezione) e trasferimenti diretti della 2.x
   *   resi      mandato indietro alla farmacia centrale (arrivato)
   *   daAltri / adAltri  scambi con altri magazzini periferici
   * La merce che rientra all'origine (DDT annullato o differenze) non è un passaggio. Le perdite in viaggio stanno
   * sul magazzino "In transito".
   */
  function distribuzione(stato, opz) {
    opz = opz || {};
    var I = indice(stato);
    var al = opz.al || oggiLocale();
    var dal = opz.dal || aggiungiGiorni(al, -364);
    var cent = opz.centraleId || centraleDi(stato);
    var k = dal + '|' + al + '|' + cent;
    if (memoria.distribuzioni[k]) return memoria.distribuzioni[k];
    var ddt = {};
    lista(stato, 'ddt').forEach(function (d) { ddt[d.id] = d; });
    var per = {}, perMese = {};
    function rec(a, r) {
      var x = per[a] || (per[a] = {});
      return x[r] || (x[r] = { dato: 0, resi: 0, daAltri: 0, adAltri: 0, consumato: 0, perdite: 0, giacenza: 0, inViaggio: 0 });
    }
    lista(stato, 'movimenti').forEach(function (m) {
      if (!m || m.annullato || !m.data || m.data < dal || m.data > al) return;
      var q = Number(m.quantita) || 0;
      if (m.tipo === 'consumo') { rec(m.articoloId, m.repartoId).consumato += q; return; }
      if (m.tipo === 'perdita') { rec(m.articoloId, m.repartoId).perdite += q; return; }
      if (m.tipo !== 'trasferimento') return;
      var dest = m.repartoDestId;
      if (I.transito[dest]) return; // partenza di un DDT: conta all'arrivo
      var origine = m.repartoId;
      if (m.ddtId && ddt[m.ddtId]) {
        var d = ddt[m.ddtId];
        if (dest !== d.destinazioneId) return; // rientro all'origine: non è un passaggio
        origine = d.origineId;
      }
      if (I.transito[origine] || origine === dest) return;
      if (origine === cent) {
        rec(m.articoloId, dest).dato += q;
        var mm = perMese[meseDi(m.data)] || (perMese[meseDi(m.data)] = {});
        var md = mm[dest] || (mm[dest] = {});
        md[m.articoloId] = (md[m.articoloId] || 0) + q;
      } else if (dest === cent) {
        rec(m.articoloId, origine).resi += q;
      } else {
        rec(m.articoloId, dest).daAltri += q;
        rec(m.articoloId, origine).adAltri += q;
      }
    });
    // giacenze attuali e merce in viaggio (per magazzino di arrivo)
    Object.keys(I.giac).forEach(function (a) {
      Object.keys(I.giac[a]).forEach(function (r) {
        if (I.transito[r]) return;
        var g = r3(I.giac[a][r]);
        if (g) rec(a, r).giacenza = g;
      });
    });
    Object.keys(I.viaggio).forEach(function (a) {
      Object.keys(I.viaggio[a]).forEach(function (r) { var v = r3(I.viaggio[a][r]); if (v) rec(a, r).inViaggio = v; });
    });
    Object.keys(per).forEach(function (a) {
      Object.keys(per[a]).forEach(function (r) {
        var x = per[a][r];
        Object.keys(x).forEach(function (c) { x[c] = r3(x[c]); });
      });
    });
    var ris = { dal: dal, al: al, centraleId: cent, mesi: mesiTra(dal, al), perArticolo: per, perMese: perMese };
    memoria.distribuzioni[k] = ris;
    return ris;
  }

  /*
   * Totali della distribuzione per gli articoli scelti, con una misura (quantità o valore):
   *   filtro(articoloId) -> bool; misura(articoloId, quantita) -> numero (predefinito: la quantità)
   * { perMagazzino: { id: { dato, resi, daAltri, adAltri, consumato, perdite, giacenza, inViaggio } },
   *   perMese: { 'AAAA-MM': { id: valore } }, totali: { … come sopra, sui soli magazzini diversi dalla centrale } }
   */
  function totaliDistribuzione(d, filtro, misura) {
    misura = misura || function (a, q) { return q; };
    var CAMPI = ['dato', 'resi', 'daAltri', 'adAltri', 'consumato', 'perdite', 'giacenza', 'inViaggio'];
    var perMag = {}, perMese = {}, totali = {};
    CAMPI.forEach(function (c) { totali[c] = 0; });
    Object.keys(d.perArticolo).forEach(function (a) {
      if (filtro && !filtro(a)) return;
      Object.keys(d.perArticolo[a]).forEach(function (r) {
        var x = d.perArticolo[a][r];
        var t = perMag[r] || (perMag[r] = {});
        CAMPI.forEach(function (c) {
          if (!x[c]) return;
          var v = misura(a, x[c]);
          t[c] = (t[c] || 0) + v;
          if (r !== d.centraleId) totali[c] += v;
        });
      });
    });
    Object.keys(perMag).forEach(function (r) { CAMPI.forEach(function (c) { perMag[r][c] = r3(perMag[r][c] || 0); }); });
    CAMPI.forEach(function (c) { totali[c] = r3(totali[c]); });
    d.mesi.forEach(function (mese) {
      var mm = d.perMese[mese] || {};
      var out = perMese[mese] = {};
      Object.keys(mm).forEach(function (r) {
        var s = 0;
        Object.keys(mm[r]).forEach(function (a) { if (!filtro || filtro(a)) s += misura(a, mm[r][a]); });
        if (s) out[r] = r3(s);
      });
    });
    return { perMagazzino: perMag, perMese: perMese, totali: totali };
  }

  var Previsioni = {
    // date e numeri
    numeroGiorno: numeroGiorno,
    dataDa: dataDa,
    aggiungiGiorni: aggiungiGiorni,
    giornoSettimana: giornoSettimana,
    oggi: oggiLocale,
    normInv: normInv,
    GIORNI_MESE: GIORNI_MESE,
    // serie
    parametri: parametri,
    serie: serie,
    periodi: periodi,
    aggrega: aggrega,
    // modelli
    MODELLI: MODELLI,
    candidati: candidati,
    stima: stima,
    sigmaPeriodo: sigmaPeriodo,
    banda: banda,
    // indicatori e analisi
    tendenza: tendenza,
    copertura: copertura,
    classificaABC: classificaABC,
    classificaXYZ: classificaXYZ,
    coefficienteVariazione: coefficienteVariazione,
    classeXYZ: classeXYZ,
    analizza: analizza,
    pronto: pronto,
    prepara: prepara,
    articolo: function (stato, articoloId, opz) {
      opz = opz || {};
      var a = lista(stato, 'articoli').filter(function (x) { return x.id === articoloId; })[0];
      return a ? rigaArticolo(indice(stato), a, ambito(opz.reparti), parametri(stato, opz)) : null;
    },
    // per le altre parti
    consumoGiornaliero: consumoGiornaliero,
    consumoMedio: consumoMedio,
    // distribuzione
    distribuzione: distribuzione,
    totaliDistribuzione: totaliDistribuzione,
    mesiTra: mesiTra,
    // memoria
    svuotaMemoria: svuota
  };

  if (typeof module === 'object' && module.exports) module.exports = Previsioni;
  else root.Previsioni = Previsioni;
})(typeof window !== 'undefined' ? window : this);
