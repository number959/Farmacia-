/*
 * Versione 3.0 – parte A: codici a barre Code 128 (SVG) per i DDT.
 * UMD come js/calcoli.js: module.exports in Node, window.Codice128 nel browser. Contratto: docs/NOVITA-3.0.md.
 */
(function (root) {
  'use strict';
  var Codice128 = {};
  if (typeof module === 'object' && module.exports) module.exports = Codice128;
  else root.Codice128 = Codice128;
})(typeof window !== 'undefined' ? window : this);
