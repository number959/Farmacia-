/*
 * Animazioni (anime.js 4, vendor/anime.umd.min.js, globale "anime"). Senza anime.js o con
 * "riduci movimento" attivo nel sistema, ogni funzione porta subito l'elemento allo stato finale.
 *   Motion.entra(elementi, { ritardo, distanza })  comparsa a cascata
 *   Motion.conta(el, da, a, { durata, formato })   numero che scorre
 *   Motion.evidenzia(el)                           impulso per attirare l'attenzione
 *   Motion.ridotto()                               true se l'utente preferisce meno movimento
 * Versione 3.0 – parte F (docs/NOVITA-3.0.md).
 */
(function (root) {
  'use strict';
  function lista(x) {
    if (!x) return [];
    if (typeof x === 'string') return Array.prototype.slice.call(document.querySelectorAll(x));
    if (x.length !== undefined && !x.nodeType) return Array.prototype.slice.call(x);
    return [x];
  }
  function a() { return root.anime && root.anime.animate ? root.anime : null; }

  var Motion = {
    ridotto: function () {
      try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
    },
    entra: function (elementi, opz) {
      var els = lista(elementi);
      opz = opz || {};
      if (!els.length) return;
      var A = a();
      if (!A || Motion.ridotto()) { els.forEach(function (el) { el.style.opacity = ''; el.style.transform = ''; }); return; }
      A.animate(els, {
        opacity: { from: 0, to: 1 },
        translateY: { from: opz.distanza === undefined ? 10 : opz.distanza, to: 0 },
        delay: A.stagger(opz.ritardo === undefined ? 35 : opz.ritardo),
        duration: opz.durata || 420,
        ease: 'outCubic'
      });
    },
    conta: function (el, da, verso, opz) {
      opz = opz || {};
      var formato = opz.formato || function (v) { return String(Math.round(v)); };
      if (!el) return;
      var A = a();
      if (!A || Motion.ridotto() || da === verso) { el.textContent = formato(verso); return; }
      var stato = { v: Number(da) || 0 };
      A.animate(stato, {
        v: Number(verso) || 0,
        duration: opz.durata || 900,
        ease: 'outExpo',
        onUpdate: function () { el.textContent = formato(stato.v); },
        onComplete: function () { el.textContent = formato(verso); }
      });
    },
    evidenzia: function (el) {
      var els = lista(el);
      if (!els.length) return;
      var A = a();
      if (!A || Motion.ridotto()) return;
      A.animate(els, { scale: [{ to: 1.06, duration: 160 }, { to: 1, duration: 340 }], ease: 'outQuad' });
    }
  };
  root.Motion = Motion;
})(typeof window !== 'undefined' ? window : this);
