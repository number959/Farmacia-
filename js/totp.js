/*
 * Versione 3.0 – parte C: codici a tempo per la verifica in due passaggi (2FA), come Google o Microsoft Authenticator.
 *
 *   TOTP (RFC 6238) = HOTP (RFC 4226) con il contatore uguale ai "passi" di 30 secondi trascorsi dal 1970.
 *   HOTP = HMAC-SHA1(segreto, contatore) troncato a 6 cifre.
 *
 * Tutto in JavaScript puro (SHA-1 e HMAC compresi), senza librerie e senza crypto.subtle: le stesse funzioni
 * servono al server (Node), al browser (anteprima, prove) e ai test. UMD come js/calcoli.js:
 * module.exports in Node, window.Totp nel browser. Contratto: docs/NOVITA-3.0.md.
 *
 * I segreti sono byte (Array, Uint8Array o Buffer) oppure testo base32 (RFC 4648, quello delle app).
 */
(function (root) {
  'use strict';

  var ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  /* ---------- base32 (RFC 4648) ---------- */

  /* Byte → testo base32 maiuscolo. Con riempimento true aggiunge gli "=" finali (le app non li vogliono). */
  function base32Codifica(byte, riempimento) {
    var b = inByte(byte);
    var out = '';
    var buffer = 0;
    var bit = 0;
    for (var i = 0; i < b.length; i++) {
      buffer = ((buffer << 8) | b[i]) & 0xffff;
      bit += 8;
      while (bit >= 5) {
        out += ALFABETO.charAt((buffer >>> (bit - 5)) & 31);
        bit -= 5;
      }
    }
    if (bit > 0) out += ALFABETO.charAt((buffer << (5 - bit)) & 31);
    if (riempimento) while (out.length % 8) out += '=';
    return out;
  }

  /*
   * Testo base32 → byte (Array). Accetta minuscole, spazi, trattini e "=" finali (la chiave scritta a mano
   * a gruppi di quattro). Lettere fuori dall'alfabeto: errore.
   */
  function base32Decodifica(testo) {
    var t = String(testo === null || testo === undefined ? '' : testo).toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/, '');
    var out = [];
    var buffer = 0;
    var bit = 0;
    for (var i = 0; i < t.length; i++) {
      var v = ALFABETO.indexOf(t.charAt(i));
      if (v < 0) throw new Error('Chiave non valida: contiene il carattere «' + t.charAt(i) + '».');
      buffer = ((buffer << 5) | v) & 0xffff;
      bit += 5;
      if (bit >= 8) {
        out.push((buffer >>> (bit - 8)) & 255);
        bit -= 8;
      }
    }
    return out;
  }

  /* ---------- SHA-1 (FIPS 180-4) e HMAC (RFC 2104) ---------- */

  function inByte(x) {
    if (x === null || x === undefined) return [];
    if (typeof x === 'string') {
      // testo: UTF-8
      var u = unescape(encodeURIComponent(x));
      var a = new Array(u.length);
      for (var i = 0; i < u.length; i++) a[i] = u.charCodeAt(i);
      return a;
    }
    return x; // Array, Uint8Array, Buffer: si leggono per indice
  }

  function ruota(x, n) { return (x << n) | (x >>> (32 - n)); }

  /* SHA-1 di byte (o di un testo in UTF-8): Array di 20 byte. */
  function sha1(dati) {
    var m = inByte(dati);
    var n = m.length;
    var blocchi = ((n + 8) >> 6) + 1;          // blocchi da 64 byte, con 0x80 e la lunghezza in fondo
    var w32 = new Array(blocchi * 16);
    var i;
    for (i = 0; i < w32.length; i++) w32[i] = 0;
    for (i = 0; i < n; i++) w32[i >> 2] |= (m[i] & 255) << (24 - (i % 4) * 8);
    w32[n >> 2] |= 0x80 << (24 - (n % 4) * 8);
    // lunghezza in bit (64 bit, qui bastano i 53 dei numeri JavaScript)
    var bitTot = n * 8;
    w32[blocchi * 16 - 1] = bitTot >>> 0;
    w32[blocchi * 16 - 2] = Math.floor(bitTot / 0x100000000) >>> 0;

    var h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    var w = new Array(80);
    for (var b = 0; b < blocchi; b++) {
      for (i = 0; i < 16; i++) w[i] = w32[b * 16 + i] | 0;
      for (i = 16; i < 80; i++) w[i] = ruota(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      var a = h0, bb = h1, c = h2, d = h3, e = h4;
      for (i = 0; i < 80; i++) {
        var f, k;
        if (i < 20) { f = (bb & c) | (~bb & d); k = 0x5a827999; }
        else if (i < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; }
        else if (i < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = bb ^ c ^ d; k = 0xca62c1d6; }
        var t = (ruota(a, 5) + f + e + k + w[i]) | 0;
        e = d;
        d = c;
        c = ruota(bb, 30);
        bb = a;
        a = t;
      }
      h0 = (h0 + a) | 0;
      h1 = (h1 + bb) | 0;
      h2 = (h2 + c) | 0;
      h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0;
    }
    var out = [];
    [h0, h1, h2, h3, h4].forEach(function (x) {
      out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
    });
    return out;
  }

  /* HMAC-SHA1(chiave, messaggio): Array di 20 byte. */
  function hmacSha1(chiave, messaggio) {
    var k = inByte(chiave);
    if (k.length > 64) k = sha1(k);
    var interna = new Array(64);
    var esterna = new Array(64);
    for (var i = 0; i < 64; i++) {
      var x = i < k.length ? k[i] & 255 : 0;
      interna[i] = x ^ 0x36;
      esterna[i] = x ^ 0x5c;
    }
    var m = inByte(messaggio);
    var primo = interna.concat(Array.prototype.slice.call(m));
    return sha1(esterna.concat(sha1(primo)));
  }

  function esadecimale(byte) {
    var s = '';
    for (var i = 0; i < byte.length; i++) s += (byte[i] < 16 ? '0' : '') + (byte[i] & 255).toString(16);
    return s;
  }

  /* ---------- HOTP e TOTP ---------- */

  function segretoInByte(segreto) {
    if (typeof segreto === 'string') return base32Decodifica(segreto);
    return inByte(segreto);
  }

  function cifreDa(opz) {
    var c = opz && opz.cifre ? Math.floor(Number(opz.cifre)) : 6;
    return c >= 6 && c <= 8 ? c : 6;
  }

  function passoDa(opz) {
    var p = opz && opz.passo ? Number(opz.passo) : 30;
    return p > 0 ? p : 30;
  }

  /* HOTP (RFC 4226): codice di `cifre` cifre (con gli zeri davanti) per il contatore indicato. */
  function hotp(segreto, contatore, opz) {
    var c = Math.floor(Number(contatore) || 0);
    if (c < 0) c = 0;
    var alto = Math.floor(c / 0x100000000);
    var basso = c >>> 0;
    var msg = [
      (alto >>> 24) & 255, (alto >>> 16) & 255, (alto >>> 8) & 255, alto & 255,
      (basso >>> 24) & 255, (basso >>> 16) & 255, (basso >>> 8) & 255, basso & 255
    ];
    var h = hmacSha1(segretoInByte(segreto), msg);
    var o = h[19] & 0xf;
    var bin = ((h[o] & 0x7f) * 0x1000000) + (h[o + 1] << 16) + (h[o + 2] << 8) + h[o + 3];
    var cifre = cifreDa(opz);
    var codice = String(bin % Math.pow(10, cifre));
    while (codice.length < cifre) codice = '0' + codice;
    return codice;
  }

  /* Numero del passo di tempo (30 secondi) per l'istante in millisecondi. */
  function passo(tempoMs, opz) {
    return Math.floor(Number(tempoMs) / 1000 / passoDa(opz));
  }

  /* TOTP (RFC 6238): il codice che l'app mostra all'istante tempoMs (predefinito: adesso). */
  function totp(segreto, tempoMs, opz) {
    if (tempoMs === undefined || tempoMs === null) tempoMs = Date.now();
    return hotp(segreto, passo(tempoMs, opz), opz);
  }

  /* Confronto che non si ferma al primo carattere diverso. */
  function uguali(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /* Solo le cifre del codice scritto ("123 456", "123-456" → "123456"). */
  function pulisciCodice(codice) {
    return String(codice === null || codice === undefined ? '' : codice).replace(/[\s-]+/g, '');
  }

  /*
   * Verifica un codice scritto dall'utente all'istante tempoMs. Accetta anche il passo prima e quello dopo
   * (opz.finestra, predefinita 1: ±30 secondi per gli orologi un po' avanti o indietro).
   * opz.ultimoPasso: passo dell'ultimo codice già accettato; i passi fino a quello non valgono più
   * (lo stesso codice non si usa due volte).
   * Restituisce il numero del passo del codice giusto, oppure -1.
   */
  function verifica(segreto, codice, tempoMs, opz) {
    opz = opz || {};
    var cifre = cifreDa(opz);
    var c = pulisciCodice(codice);
    if (!new RegExp('^\\d{' + cifre + '}$').test(c)) return -1;
    if (tempoMs === undefined || tempoMs === null) tempoMs = Date.now();
    var finestra = opz.finestra === undefined ? 1 : Math.max(0, Math.min(10, Math.floor(Number(opz.finestra) || 0)));
    var ultimo = typeof opz.ultimoPasso === 'number' && isFinite(opz.ultimoPasso) ? opz.ultimoPasso : -Infinity;
    var byte = segretoInByte(segreto);
    var adesso = passo(tempoMs, opz);
    var trovato = -1;
    // prima il passo attuale, poi quelli vicini; si provano tutti, così il tempo non dice quale era giusto
    for (var d = 0; d <= finestra; d++) {
      var candidati = d === 0 ? [adesso] : [adesso - d, adesso + d];
      for (var i = 0; i < candidati.length; i++) {
        var p = candidati[i];
        if (p < 0) continue;
        if (uguali(hotp(byte, p, opz), c) && trovato < 0 && p > ultimo) trovato = p;
      }
    }
    return trovato;
  }

  /*
   * Indirizzo otpauth:// da mettere nel codice QR (formato "Key Uri" di Google Authenticator):
   * otpauth://totp/Emittente:utente?secret=…&issuer=Emittente&algorithm=SHA1&digits=6&period=30
   */
  function uriOtpauth(opz) {
    opz = opz || {};
    var emittente = String(opz.emittente || 'Gestionale Farmacia').replace(/:/g, ' ').trim();
    var utente = String(opz.utente || '').replace(/:/g, ' ').trim();
    var segreto = String(opz.segretoBase32 || '').toUpperCase().replace(/[\s=-]+/g, '');
    return 'otpauth://totp/' + encodeURIComponent(emittente) + ':' + encodeURIComponent(utente) +
      '?secret=' + segreto + '&issuer=' + encodeURIComponent(emittente) +
      '&algorithm=SHA1&digits=' + cifreDa(opz) + '&period=' + passoDa(opz);
  }

  /* Chiave da scrivere a mano nell'app: gruppi di quattro lettere ("ABCD EFGH …"). */
  function formattaChiave(segretoBase32) {
    return String(segretoBase32 || '').toUpperCase().replace(/[\s=-]+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
  }

  /* Byte casuali per un segreto nuovo (20 byte = 160 bit, come raccomanda RFC 4226). */
  function segretoCasuale(n) {
    n = n || 20;
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      return Array.prototype.slice.call(require('crypto').randomBytes(n));
    }
    var c = root.crypto || root.msCrypto;
    if (!c || !c.getRandomValues) throw new Error('Questo browser non sa generare numeri casuali sicuri.');
    var b = new Uint8Array(n);
    c.getRandomValues(b);
    return Array.prototype.slice.call(b);
  }

  var Totp = {
    base32Codifica: base32Codifica,
    base32Decodifica: base32Decodifica,
    sha1: sha1,
    hmacSha1: hmacSha1,
    esadecimale: esadecimale,
    hotp: hotp,
    totp: totp,
    passo: passo,
    verifica: verifica,
    pulisciCodice: pulisciCodice,
    uriOtpauth: uriOtpauth,
    formattaChiave: formattaChiave,
    segretoCasuale: segretoCasuale
  };

  if (typeof module === 'object' && module.exports) module.exports = Totp;
  else root.Totp = Totp;
})(typeof window !== 'undefined' ? window : this);
