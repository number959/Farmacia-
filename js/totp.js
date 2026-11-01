/*
 * Versione 3.0 – parte C: TOTP (RFC 6238) con SHA-1 e HMAC in JavaScript puro, condiviso fra server e anteprima.
 * UMD come js/calcoli.js: module.exports in Node, window.Totp nel browser. Contratto: docs/NOVITA-3.0.md.
 */
(function (root) {
  'use strict';
  var Totp = {};
  if (typeof module === 'object' && module.exports) module.exports = Totp;
  else root.Totp = Totp;
})(typeof window !== 'undefined' ? window : this);
