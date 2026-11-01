/*
 * Versione 3.0 – parte D: previsioni statistiche dei consumi e del fabbisogno, condivise fra pagine e prove.
 * UMD come js/calcoli.js: module.exports in Node, window.Previsioni nel browser. Contratto: docs/NOVITA-3.0.md.
 */
(function (root) {
  'use strict';
  var Previsioni = {};
  if (typeof module === 'object' && module.exports) module.exports = Previsioni;
  else root.Previsioni = Previsioni;
})(typeof window !== 'undefined' ? window : this);
