/*
 * Animazioni (anime.js 4, vendor/anime.umd.min.js, globale "anime"). Senza anime.js o con
 * "riduci movimento" attivo nel sistema, ogni funzione porta subito l'elemento allo stato finale.
 *   Motion.entra(elementi, { ritardo, distanza, durata })  comparsa a cascata (elementi: nodo, elenco o selettore)
 *   Motion.conta(el, da, a, { durata, formato })           numero che scorre (formato(v) -> testo; predefinito intero)
 *   Motion.evidenzia(el)                                    impulso per attirare l'attenzione
 *   Motion.pagina(el)                                       comparsa breve della pagina appena disegnata (CSS)
 *   Motion.ridotto()                                        true se l'utente preferisce meno movimento
 * A fine animazione gli stili messi da anime.js si tolgono: un "transform" rimasto cambierebbe il riferimento
 * degli elementi "position: fixed" dentro l'elemento animato (fumetti, menu).
 * Versione 3.0 – parte F (docs/NOVITA-3.0.md).
 */
(function (root) {
  'use strict';
  function lista(x) {
    if (!x) return [];
    if (typeof x === 'string') return Array.prototype.slice.call(document.querySelectorAll(x));
    if (x.length !== undefined && !x.nodeType) return Array.prototype.slice.call(x).filter(Boolean);
    return [x];
  }
  function a() { return root.anime && root.anime.animate ? root.anime : null; }

  function pulisci(els) {
    els.forEach(function (el) { el.style.opacity = ''; el.style.transform = ''; });
  }

  // animazioni ancora in corso per elemento (un nuovo "conta" sullo stesso numero ferma quello di prima)
  var inCorso = typeof WeakMap === 'function' ? new WeakMap() : null;
  function ferma(el) {
    if (!inCorso) return;
    var x = inCorso.get(el);
    if (x) { try { x.pause(); } catch (e) { /* già finita */ } inCorso.delete(el); }
  }

  var Motion = {
    ridotto: function () {
      try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
    },

    entra: function (elementi, opz) {
      var els = lista(elementi);
      opz = opz || {};
      if (!els.length) return;
      var A = a();
      if (!A || Motion.ridotto()) { pulisci(els); return; }
      var distanza = opz.distanza === undefined ? 10 : opz.distanza;
      // stato iniziale subito, così gli elementi in attesa del loro turno non si vedono "prima"
      els.forEach(function (el) { el.style.opacity = '0'; el.style.transform = 'translateY(' + distanza + 'px)'; });
      try {
        A.animate(els, {
          opacity: { from: 0, to: 1 },
          translateY: { from: distanza, to: 0 },
          delay: A.stagger(opz.ritardo === undefined ? 35 : opz.ritardo),
          duration: opz.durata || 420,
          ease: 'outCubic',
          onComplete: function () { pulisci(els); }
        });
      } catch (e) { pulisci(els); }
    },

    conta: function (el, da, verso, opz) {
      opz = opz || {};
      var formato = opz.formato || function (v) { return String(Math.round(v)); };
      if (!el) return;
      ferma(el);
      var A = a();
      var fine = Number(verso) || 0;
      if (!A || Motion.ridotto() || Number(da) === fine) { el.textContent = formato(fine); return; }
      var stato = { v: Number(da) || 0 };
      el.textContent = formato(stato.v);
      try {
        var anim = A.animate(stato, {
          v: fine,
          duration: opz.durata || 900,
          ease: 'outExpo',
          onUpdate: function () { el.textContent = formato(stato.v); },
          onComplete: function () { el.textContent = formato(fine); if (inCorso) inCorso.delete(el); }
        });
        if (inCorso && anim) inCorso.set(el, anim);
      } catch (e) { el.textContent = formato(fine); }
    },

    evidenzia: function (el) {
      var els = lista(el);
      if (!els.length) return;
      var A = a();
      if (!A || Motion.ridotto()) return;
      try {
        A.animate(els, {
          scale: [{ to: 1.08, duration: 160 }, { to: 1, duration: 360 }],
          ease: 'outQuad',
          onComplete: function () { els.forEach(function (x) { x.style.transform = ''; }); }
        });
      } catch (e) { /* niente impulso */ }
    },

    /* Comparsa della pagina: classe CSS "pagina-entra" (css/app.css), tolta a fine animazione. */
    pagina: function (el) {
      if (!el || Motion.ridotto()) return;
      el.classList.remove('pagina-entra');
      // rilancio dell'animazione anche se la classe c'era già
      void el.offsetWidth;
      el.classList.add('pagina-entra');
      var fine = function (e) { if (e.target === el) via(); };
      var via = function () { el.classList.remove('pagina-entra'); el.removeEventListener('animationend', fine); };
      el.addEventListener('animationend', fine);
      setTimeout(via, 600);
    }
  };
  root.Motion = Motion;
})(typeof window !== 'undefined' ? window : this);
