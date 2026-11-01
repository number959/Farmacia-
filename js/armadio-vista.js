/*
 * Vista grafica di un armadio (versione 3.0 – parte B, docs/NOVITA-3.0.md): armadio a due ante, frigorifero,
 * cassettiera, carrello, cassaforte per gli stupefacenti. HTML e CSS (css/struttura.css) in 2.5D: niente WebGL,
 * gira anche su PC modesti. Il movimento usa anime.js (globale "anime") solo se l'utente non preferisce meno movimento.
 *
 *   ArmadioVista.disegna(contenitore, opz) → vista { el, evidenzia(articoloId), seleziona(articoloId), casella(articoloId) }
 *     opz.armadio   { id, nome, tipo, ripiani, colonne, colore, note, attivo }
 *     opz.caselle   [{ articolo, giacenza, stato, lotti, ripiano, posizione, riempimento (0…1), soglie: { min, riordino, max } }]
 *                   stato: 'ok' | 'riordino' | 'sotto-minimo' | 'esaurito' | 'in-scadenza' | 'scaduto'
 *                   lotti: [{ lotto, scadenza: 'AAAA-MM', quantita, giorni }]
 *     opz.modifica  true: gli articoli si spostano trascinandoli (mouse o dito) o con la tastiera (Invio, frecce, Invio)
 *     opz.suCasella(casella)          clic, Invio o tocco su un articolo
 *     opz.suSposta({ articoloId, ripiano, posizione, da, occupante })   rilascio su una casella (modalità modifica)
 *     opz.suTogli(articoloId)         Canc su un articolo (modalità modifica): toglilo dall'armadio
 *     opz.selezionato                 articolo da mostrare scelto
 *     opz.ingresso                    true: le ante si aprono (primo disegno di quell'armadio)
 *     opz.anteprima                   true: disegno piccolo, senza dettagli né tastiera (finestra dell'armadio)
 *   Ridisegnando lo stesso armadio nello stesso contenitore, le scatole spostate scivolano al posto nuovo.
 *
 *   ArmadioVista.trascina(evento pointerdown, { articoloId, testo, stato })  trascinamento da fuori (elenco dell'assortimento):
 *     sulle caselle chiama suSposta della vista; su un elemento con data-av-togli manda l'evento 'av-rilascio' (detail = dati).
 *   ArmadioVista.prendi(articoloId, testo)   alternativa da tastiera: il fuoco va nell'armadio, frecce + Invio per posare.
 *   ArmadioVista.STATI, ArmadioVista.SEGNI, ArmadioVista.TIPI   etichette per le pagine.
 * Caselle: ripiano 1 = in alto, posizione 1 = a sinistra (come in server/struttura.js).
 */
(function (root) {
  'use strict';

  var App = root.App;
  var h = App.h;

  var STATI = {
    ok: 'scorta regolare',
    riordino: 'da riordinare',
    'sotto-minimo': 'sotto la scorta minima',
    esaurito: 'esaurito',
    'in-scadenza': 'lotti in scadenza',
    scaduto: 'lotti scaduti'
  };
  // segno accanto al colore: lo stato non si capisce solo dal colore
  var SEGNI = { ok: '', riordino: '↻', 'sotto-minimo': '!', esaurito: '∅', 'in-scadenza': '⏳', scaduto: '⚠' };
  var TIPI = {
    armadio: { nome: 'Armadio', ico: '🗄️', ante: 2 },
    frigorifero: { nome: 'Frigorifero', ico: '❄️', ante: 1 },
    cassettiera: { nome: 'Cassettiera', ico: '🗃️', ante: 0 },
    carrello: { nome: 'Carrello', ico: '🛒', ante: 0 },
    cassaforte: { nome: 'Cassaforte', ico: '🔒', ante: 1 }
  };

  function anime() { return root.anime && root.anime.animate ? root.anime : null; }
  function ridotto() { return !!(root.Motion && root.Motion.ridotto && root.Motion.ridotto()); }
  function movimento() { return !ridotto() ? anime() : null; }

  function fmt(n) { return App.fmtNum ? App.fmtNum(n) : String(n); }

  // nome corto per la scatola: le prime parole fino a ~14 caratteri
  function nomeCorto(nome) {
    var parole = String(nome || '').split(/\s+/);
    var out = '';
    for (var i = 0; i < parole.length; i++) {
      if ((out + ' ' + parole[i]).trim().length > 14 && out) break;
      out = (out + ' ' + parole[i]).trim();
    }
    return out.length > 16 ? out.slice(0, 15) + '…' : out;
  }

  function descriviCasella(c, r, p) {
    var pos = 'Ripiano ' + r + ', posto ' + p;
    if (!c) return pos + ': libero';
    var a = c.articolo || {};
    return pos + ': ' + a.nome + ', ' + fmt(c.giacenza) + (a.unita ? ' ' + a.unita : '') + ', ' + (STATI[c.stato] || c.stato);
  }

  /* ---------- disegno ---------- */

  function htmlScatola(c) {
    var a = c.articolo || {};
    var pieno = Math.max(0, Math.min(1, Number(c.riempimento) || 0));
    var segno = SEGNI[c.stato] || '';
    return '<div class="av-scatola av-s-' + h(c.stato || 'ok') + '" data-articolo="' + h(a.id) + '" style="--av-pieno:' + pieno.toFixed(3) + '">' +
      '<span class="av-nome-art">' + h(nomeCorto(a.nome)) + '</span>' +
      '<span class="av-corpo-scatola"><span class="av-quantita">' + h(fmt(c.giacenza)) + '</span></span>' +
      (segno ? '<span class="av-segno" aria-hidden="true">' + segno + '</span>' : '') +
      '</div>';
  }

  function htmlAnte(tipo) {
    var n = (TIPI[tipo] || TIPI.armadio).ante;
    if (!n) return '';
    var ante = n === 2
      ? '<div class="av-anta av-anta-sx"><span class="av-maniglia"></span></div><div class="av-anta av-anta-dx"><span class="av-maniglia"></span></div>'
      : '<div class="av-anta av-anta-unica">' + (tipo === 'cassaforte' ? '<span class="av-combinazione"></span>' : '') + '<span class="av-maniglia"></span></div>';
    return '<div class="av-ante" aria-hidden="true">' + ante + '</div>';
  }

  function cimasa(arm) {
    var t = TIPI[arm.tipo] || TIPI.armadio;
    var segno = arm.tipo === 'frigorifero' ? '<span class="av-targa av-freddo" title="Frigorifero: 2–8 °C">❄ 2–8 °C</span>'
      : arm.tipo === 'cassaforte' ? '<span class="av-targa av-chiuso" title="Cassaforte degli stupefacenti">🔒 Stupefacenti</span>'
        : '<span class="av-targa">' + t.ico + ' ' + h(t.nome) + '</span>';
    return '<div class="av-cimasa"><span class="av-titolo">' + h(arm.nome) + '</span>' + segno + '</div>';
  }

  function zoccolo(arm) {
    if (arm.tipo === 'carrello') return '<div class="av-zoccolo av-ruote" aria-hidden="true"><span></span><span></span><span></span></div>';
    return '<div class="av-zoccolo" aria-hidden="true"></div>';
  }

  // testo leggibile sul colore scelto per il mobile: scuro sui colori chiari, chiaro sugli scuri
  function testoSu(colore) {
    var m = /^#([0-9a-f]{6})$/i.exec(colore || '');
    if (!m) return 'var(--primario-testo)';
    var n = parseInt(m[1], 16);
    var luce = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return luce > 0.6 ? 'var(--testo)' : 'var(--primario-testo)';
  }

  function costruisci(opz, mappa) {
    var arm = opz.armadio;
    var interattiva = !opz.anteprima;
    var righe = [];
    for (var r = 1; r <= arm.ripiani; r++) {
      var celle = [];
      for (var p = 1; p <= arm.colonne; p++) {
        var c = mappa[r + '|' + p];
        var attr = ' data-ripiano="' + r + '" data-posizione="' + p + '"';
        if (interattiva) {
          attr += ' role="gridcell" tabindex="-1" aria-label="' + h(descriviCasella(c, r, p)) + '"' +
            (c && opz.selezionato && c.articolo && c.articolo.id === opz.selezionato ? ' aria-selected="true"' : '');
        }
        celle.push('<div class="av-cella' + (c ? ' av-piena' : ' av-libera') + '"' + attr + '>' + (c ? htmlScatola(c) : '') + '</div>');
      }
      righe.push('<div class="av-ripiano"' + (interattiva ? ' role="row"' : '') + ' data-ripiano="' + r + '">' + celle.join('') +
        (arm.tipo === 'cassettiera' ? '<span class="av-frontale" aria-hidden="true"><span></span></span>' : '') + '</div>');
    }
    var stile = '--av-colonne:' + arm.colonne + ';--av-ripiani:' + arm.ripiani +
      (arm.colore ? ';--av-tinta:' + arm.colore + ';--av-testo:' + testoSu(arm.colore) : '');
    var etichetta = (TIPI[arm.tipo] || TIPI.armadio).nome + ' «' + arm.nome + '»: ' + arm.ripiani + ' ripiani, ' + arm.colonne + ' posti per ripiano';
    return '<div class="av av-' + h(arm.tipo || 'armadio') + (opz.modifica ? ' av-modifica' : '') + (opz.anteprima ? ' av-anteprima' : '') +
      (arm.attivo === false ? ' av-spento' : '') + '" data-armadio="' + h(arm.id || '') + '" style="' + h(stile) + '">' +
      '<div class="av-scena"><div class="av-mobile">' + cimasa(arm) +
      '<div class="av-vano"><div class="av-griglia"' + (interattiva ? ' role="grid" aria-label="' + h(etichetta) + '"' +
        (opz.modifica ? ' aria-describedby="av-aiuto-' + h(arm.id || 'x') + '"' : '') : '') + '>' + righe.join('') + '</div>' +
      htmlAnte(arm.tipo) + '</div>' + zoccolo(arm) + '</div></div>' +
      (interattiva ? '<div class="av-dettaglio" role="tooltip" hidden></div>' +
        '<p class="av-aiuto" id="av-aiuto-' + h(arm.id || 'x') + '"' + (opz.modifica ? '' : ' hidden') + '>' +
        'Trascina gli articoli con il mouse o con il dito. Da tastiera: frecce per muoverti, Invio per prendere un articolo e Invio per posarlo, Esc per lasciare, Canc per toglierlo dall’armadio.</p>' +
        '<p class="av-annuncio" aria-live="polite"></p>' : '') +
      '</div>';
  }

  /* ---------- animazioni ---------- */

  function apriAnte(el, arm) {
    var A = movimento();
    var ante = el.querySelectorAll('.av-anta');
    var scatole = el.querySelectorAll('.av-scatola');
    var ripiani = el.querySelectorAll('.av-ripiano');
    if (!A) { el.classList.add('av-aperto'); return; }
    var angoli = { 'av-anta-sx': -108, 'av-anta-dx': 108, 'av-anta-unica': -104 };
    Array.prototype.forEach.call(ante, function (a) {
      var classe = a.classList.contains('av-anta-sx') ? 'av-anta-sx' : a.classList.contains('av-anta-dx') ? 'av-anta-dx' : 'av-anta-unica';
      A.animate(a, { rotateY: { from: 0, to: angoli[classe] }, duration: arm.tipo === 'cassaforte' ? 1150 : 900, delay: 120, ease: 'inOutCubic' });
    });
    var dopo = ante.length ? 520 : 0;
    if (arm.tipo === 'carrello') {
      // il carrello arriva su ruote
      A.animate(el.querySelector('.av-mobile'), { translateX: { from: -40, to: 0 }, opacity: { from: 0, to: 1 }, duration: 700, ease: 'outCubic' });
      dopo = 300;
    }
    if (arm.tipo === 'cassettiera') {
      // i cassetti escono uno dopo l'altro
      A.animate(ripiani, { translateY: { from: -10, to: 0 }, scaleX: { from: 0.97, to: 1 }, opacity: { from: 0.2, to: 1 }, delay: A.stagger(70), duration: 420, ease: 'outBack(1.4)' });
      dopo = 200;
    }
    if (scatole.length) {
      A.animate(scatole, {
        opacity: { from: 0, to: 1 },
        translateY: { from: 14, to: 0 },
        scaleY: { from: 0.2, to: 1 },
        delay: A.stagger(Math.max(8, Math.min(28, 600 / scatole.length)), { start: dopo }),
        duration: 460,
        ease: 'outCubic'
      });
    }
    setTimeout(function () { el.classList.add('av-aperto'); }, dopo + 900);
  }

  // le scatole che hanno cambiato posto o livello scivolano dal punto di prima (FLIP)
  function scivola(el, prima) {
    var A = movimento();
    if (!A) return;
    Array.prototype.forEach.call(el.querySelectorAll('.av-scatola[data-articolo]'), function (b) {
      var p = prima[b.getAttribute('data-articolo')];
      var r = b.getBoundingClientRect();
      if (!p) {
        A.animate(b, { opacity: { from: 0, to: 1 }, scale: { from: 0.5, to: 1 }, duration: 420, ease: 'outBack(1.6)' });
        return;
      }
      var dx = p.left - r.left;
      var dy = p.bottom - r.bottom;
      var sy = r.height ? p.height / r.height : 1;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sy - 1) < 0.02) return;
      A.animate(b, {
        translateX: { from: dx, to: 0 }, translateY: { from: dy, to: 0 }, scaleY: { from: sy, to: 1 },
        duration: 560, ease: 'outCubic'
      });
    });
  }

  /* ---------- dettagli al passaggio del mouse o col fuoco ---------- */

  function htmlDettaglio(c) {
    var a = c.articolo || {};
    var s = c.soglie || {};
    var soglie = [];
    if (s.min) soglie.push('min ' + fmt(s.min));
    if (s.riordino) soglie.push('riordino ' + fmt(s.riordino));
    if (s.max) soglie.push('max ' + fmt(s.max));
    var lotti = (c.lotti || []).slice(0, 4).map(function (l) {
      var cl = l.giorni === null || l.giorni === undefined ? '' : l.giorni < 0 ? ' av-l-scaduto' : l.giorni <= 30 ? ' av-l-vicino' : '';
      return '<li class="' + cl + '"><span class="mono">' + h(l.lotto || 'senza lotto') + '</span><span>' + h(l.scadenza ? App.fmtScadenza(l.scadenza) : '—') +
        '</span><b>' + h(fmt(l.quantita)) + '</b></li>';
    }).join('');
    var altri = (c.lotti || []).length > 4 ? '<li class="tenue">e altri ' + ((c.lotti || []).length - 4) + ' lotti</li>' : '';
    return '<b class="av-d-nome">' + h(a.nome) + '</b>' +
      '<span class="av-d-stato av-s-' + h(c.stato) + '">' + h(SEGNI[c.stato] || '●') + ' ' + h(STATI[c.stato] || c.stato) + '</span>' +
      '<span class="av-d-giac"><b>' + h(fmt(c.giacenza)) + '</b> ' + h(a.unita || '') + (soglie.length ? ' · ' + h(soglie.join(' · ')) : '') + '</span>' +
      (lotti || altri ? '<ul class="av-d-lotti">' + lotti + altri + '</ul>' : '') +
      '<span class="av-d-pos">Ripiano ' + c.ripiano + ' · posto ' + c.posizione + '</span>';
  }

  function mostraDettaglio(vista, cella) {
    var box = vista.el.querySelector('.av-dettaglio');
    if (!box) return;
    var c = cella && vista.caselle[cella.getAttribute('data-ripiano') + '|' + cella.getAttribute('data-posizione')];
    if (!c || trascinamento) { box.hidden = true; return; }
    box.innerHTML = htmlDettaglio(c);
    box.hidden = false;
    var rr = vista.el.getBoundingClientRect();
    var rc = cella.getBoundingClientRect();
    var larghezza = box.offsetWidth;
    var x = rc.left - rr.left + rc.width / 2 - larghezza / 2;
    x = Math.max(4, Math.min(x, rr.width - larghezza - 4));
    var sopra = rc.top - rr.top - box.offsetHeight - 10;
    var y = sopra >= 0 || rc.top - box.offsetHeight > 70 ? sopra : rc.bottom - rr.top + 10;
    box.style.left = x + 'px';
    box.style.top = y + 'px';
  }

  function nascondiDettaglio(vista) {
    var box = vista.el.querySelector('.av-dettaglio');
    if (box) box.hidden = true;
  }

  /* ---------- tastiera e "presa" (alternativa al trascinamento) ---------- */

  var presa = null; // { articoloId, testo, da: { armadioId, ripiano, posizione } | null }

  function annuncia(vista, testo) {
    var a = vista.el.querySelector('.av-annuncio');
    if (a) { a.textContent = ''; setTimeout(function () { a.textContent = testo; }, 30); }
  }

  function segnaPresa(vista) {
    Array.prototype.forEach.call(vista.el.querySelectorAll('.av-presa'), function (x) { x.classList.remove('av-presa'); });
    vista.el.classList.toggle('av-con-presa', !!presa);
    if (presa && presa.da && presa.da.armadioId === vista.armadio.id) {
      var c = cellaDi(vista, presa.da.ripiano, presa.da.posizione);
      if (c) c.classList.add('av-presa');
    }
  }

  function cellaDi(vista, r, p) {
    return vista.el.querySelector('.av-cella[data-ripiano="' + r + '"][data-posizione="' + p + '"]');
  }

  function attivaCella(vista, cella, conFuoco) {
    if (!cella) return;
    Array.prototype.forEach.call(vista.el.querySelectorAll('.av-cella[tabindex="0"]'), function (x) { x.setAttribute('tabindex', '-1'); });
    cella.setAttribute('tabindex', '0');
    if (conFuoco) cella.focus({ preventScroll: false });
  }

  function rilascia(vista, r, p, dati) {
    var occupante = vista.caselle[r + '|' + p];
    var da = dati.da || null;
    if (da && da.armadioId === vista.armadio.id && da.ripiano === r && da.posizione === p) return false; // stesso posto
    if (typeof vista.opz.suSposta !== 'function') return false;
    vista.opz.suSposta({
      articoloId: dati.articoloId, armadioId: vista.armadio.id, ripiano: r, posizione: p, da: da,
      occupante: occupante && occupante.articolo && occupante.articolo.id !== dati.articoloId ? occupante.articolo.id : null
    });
    return true;
  }

  function tasto(vista, e) {
    var cella = e.target.closest && e.target.closest('.av-cella');
    if (!cella || !vista.el.contains(cella)) return;
    var r = Number(cella.getAttribute('data-ripiano'));
    var p = Number(cella.getAttribute('data-posizione'));
    var arm = vista.armadio;
    var dir = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (dir) {
      e.preventDefault();
      var nr = Math.max(1, Math.min(arm.ripiani, r + dir[0]));
      var np = Math.max(1, Math.min(arm.colonne, p + dir[1]));
      attivaCella(vista, cellaDi(vista, nr, np), true);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      attivaCella(vista, cellaDi(vista, e.ctrlKey ? (e.key === 'Home' ? 1 : arm.ripiani) : r, e.key === 'Home' ? 1 : arm.colonne), true);
      return;
    }
    var c = vista.caselle[r + '|' + p];
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (vista.opz.modifica && presa) {
        var dati = presa;
        presa = null;
        segnaPresa(vista);
        if (!rilascia(vista, r, p, dati)) annuncia(vista, 'Lasciato al suo posto.');
        else annuncia(vista, dati.testo + ': ripiano ' + r + ', posto ' + p + '.');
        return;
      }
      if (vista.opz.modifica && c) {
        presa = { articoloId: c.articolo.id, testo: c.articolo.nome, da: { armadioId: arm.id, ripiano: r, posizione: p } };
        segnaPresa(vista);
        annuncia(vista, 'Preso ' + c.articolo.nome + '. Scegli il posto con le frecce e premi Invio; Esc per lasciarlo dov’è.');
        return;
      }
      if (c && typeof vista.opz.suCasella === 'function') vista.opz.suCasella(c);
      else if (!c && typeof vista.opz.suVuota === 'function') vista.opz.suVuota({ ripiano: r, posizione: p });
      return;
    }
    if (e.key === 'Escape' && presa) {
      e.preventDefault();
      e.stopPropagation();
      presa = null;
      segnaPresa(vista);
      annuncia(vista, 'Spostamento annullato.');
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && vista.opz.modifica && c && typeof vista.opz.suTogli === 'function') {
      e.preventDefault();
      vista.opz.suTogli(c.articolo.id);
    }
  }

  /* ---------- trascinamento (mouse e dito: Pointer Events) ---------- */

  var trascinamento = null;

  function bersaglio(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return null;
    var cella = el.closest('.av-modifica .av-cella');
    if (cella) return { tipo: 'cella', el: cella };
    var zona = el.closest('[data-av-togli]');
    if (zona) return { tipo: 'zona', el: zona };
    return null;
  }

  function vistaDi(el) {
    var radice = el && el.closest('.av');
    return radice && radice._avVista ? radice._avVista : null;
  }

  function avviaTrascinamento(e, dati) {
    if (e.button !== undefined && e.button !== 0) return;
    if (trascinamento) return;
    var x0 = e.clientX;
    var y0 = e.clientY;
    var t = { dati: dati, avviato: false, fantasma: null, sopra: null, id: e.pointerId };
    trascinamento = t;

    function evidenziaSopra(b) {
      if (t.sopra && (!b || b.el !== t.sopra.el)) t.sopra.el.classList.remove('av-sopra');
      t.sopra = b;
      if (b) b.el.classList.add('av-sopra');
    }
    function muovi(ev) {
      if (t.id !== undefined && ev.pointerId !== undefined && ev.pointerId !== t.id) return;
      if (!t.avviato) {
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 6) return;
        t.avviato = true;
        t.fantasma = document.createElement('div');
        t.fantasma.className = 'av-fantasma av-s-' + (dati.stato || 'ok');
        t.fantasma.textContent = dati.testo || '';
        t.fantasma.setAttribute('aria-hidden', 'true');
        document.body.appendChild(t.fantasma);
        document.body.classList.add('av-trascina');
        Array.prototype.forEach.call(document.querySelectorAll('.av .av-dettaglio'), function (d) { d.hidden = true; });
      }
      ev.preventDefault();
      t.fantasma.style.left = ev.clientX + 'px';
      t.fantasma.style.top = ev.clientY + 'px';
      evidenziaSopra(bersaglio(ev.clientX, ev.clientY));
      // vicino ai bordi la pagina scorre (telefono)
      if (ev.clientY < 70) root.scrollBy(0, -12);
      else if (ev.clientY > root.innerHeight - 50) root.scrollBy(0, 12);
    }
    function fine(ev, annullato) {
      root.removeEventListener('pointermove', muovi);
      root.removeEventListener('pointerup', su);
      root.removeEventListener('pointercancel', annulla);
      trascinamento = null;
      if (!t.avviato) return;
      // il clic che segue il rilascio non deve aprire la casella
      ignoraClicFino = Date.now() + 400;
      document.body.classList.remove('av-trascina');
      if (t.fantasma) t.fantasma.remove();
      var b = annullato ? null : bersaglio(ev.clientX, ev.clientY);
      evidenziaSopra(null);
      if (!b) return;
      if (b.tipo === 'cella') {
        var v = vistaDi(b.el);
        if (v) rilascia(v, Number(b.el.getAttribute('data-ripiano')), Number(b.el.getAttribute('data-posizione')), t.dati);
      } else {
        b.el.dispatchEvent(new CustomEvent('av-rilascio', { detail: t.dati, bubbles: true }));
      }
    }
    function su(ev) { fine(ev, false); }
    function annulla(ev) { fine(ev, true); }
    root.addEventListener('pointermove', muovi, { passive: false });
    root.addEventListener('pointerup', su);
    root.addEventListener('pointercancel', annulla);
  }

  var ignoraClicFino = 0;

  /* ---------- collegamento degli eventi ---------- */

  function collega(vista) {
    var el = vista.el;
    if (vista.opz.anteprima) return;
    el.addEventListener('click', function (e) {
      if (Date.now() < ignoraClicFino) return;
      var cella = e.target.closest('.av-cella');
      if (!cella) return;
      attivaCella(vista, cella, false);
      var c = vista.caselle[cella.getAttribute('data-ripiano') + '|' + cella.getAttribute('data-posizione')];
      if (vista.opz.modifica && presa) {
        var dati = presa;
        presa = null;
        segnaPresa(vista);
        rilascia(vista, Number(cella.getAttribute('data-ripiano')), Number(cella.getAttribute('data-posizione')), dati);
        return;
      }
      if (c && typeof vista.opz.suCasella === 'function') vista.opz.suCasella(c);
      else if (!c && typeof vista.opz.suVuota === 'function') vista.opz.suVuota({ ripiano: Number(cella.getAttribute('data-ripiano')), posizione: Number(cella.getAttribute('data-posizione')) });
    });
    el.addEventListener('keydown', function (e) { tasto(vista, e); });
    el.addEventListener('mouseover', function (e) {
      var cella = e.target.closest('.av-cella.av-piena');
      if (cella && cella !== vista.sopra) { vista.sopra = cella; mostraDettaglio(vista, cella); }
    });
    el.addEventListener('mouseleave', function () { vista.sopra = null; nascondiDettaglio(vista); });
    el.addEventListener('focusin', function (e) {
      var cella = e.target.closest('.av-cella');
      if (cella && cella.classList.contains('av-piena')) mostraDettaglio(vista, cella);
      else nascondiDettaglio(vista);
    });
    el.addEventListener('focusout', function (e) {
      if (!el.contains(e.relatedTarget)) nascondiDettaglio(vista);
    });
    if (vista.opz.modifica) {
      el.addEventListener('pointerdown', function (e) {
        var b = e.target.closest('.av-scatola');
        if (!b) return;
        var cella = b.closest('.av-cella');
        var c = vista.caselle[cella.getAttribute('data-ripiano') + '|' + cella.getAttribute('data-posizione')];
        if (!c) return;
        avviaTrascinamento(e, {
          articoloId: c.articolo.id, testo: c.articolo.nome, stato: c.stato,
          da: { armadioId: vista.armadio.id, ripiano: c.ripiano, posizione: c.posizione }
        });
      });
    }
  }

  /* ---------- API ---------- */

  var ArmadioVista = {
    STATI: STATI,
    SEGNI: SEGNI,
    TIPI: TIPI,

    disegna: function (cont, opz) {
      opz = opz || {};
      var arm = opz.armadio;
      if (!cont || !arm) return null;
      var mappa = {};
      (opz.caselle || []).forEach(function (c) {
        if (!c || !c.ripiano || !c.posizione || c.ripiano > arm.ripiani || c.posizione > arm.colonne) return;
        var k = c.ripiano + '|' + c.posizione;
        if (!mappa[k]) mappa[k] = c;
      });
      // stesso armadio già disegnato qui: ricordo dove stavano le scatole per farle scivolare
      var prima = {};
      var precedente = cont._avVista;
      var stesso = precedente && precedente.armadio.id === arm.id && precedente.el.isConnected;
      if (stesso && !opz.ingresso) {
        Array.prototype.forEach.call(cont.querySelectorAll('.av-scatola[data-articolo]'), function (b) {
          prima[b.getAttribute('data-articolo')] = b.getBoundingClientRect();
        });
      }
      var fuoco = stesso && precedente.el.contains(document.activeElement) && document.activeElement.closest('.av-cella');
      var fuocoPos = fuoco ? [fuoco.getAttribute('data-ripiano'), fuoco.getAttribute('data-posizione')] : null;
      cont.innerHTML = costruisci(opz, mappa);
      var el = cont.querySelector('.av');
      var vista = {
        el: el, armadio: arm, caselle: mappa, opz: opz, sopra: null,
        evidenzia: function (articoloId) { return ArmadioVista.evidenzia(vista, articoloId); },
        seleziona: function (articoloId) { return ArmadioVista.seleziona(vista, articoloId); },
        casella: function (articoloId) {
          var k = Object.keys(mappa).filter(function (x) { return mappa[x].articolo && mappa[x].articolo.id === articoloId; })[0];
          return k ? mappa[k] : null;
        }
      };
      el._avVista = vista;
      cont._avVista = vista;
      collega(vista);
      if (!opz.anteprima) {
        // una sola casella raggiungibile con Tab (le altre con le frecce)
        var iniziale = (fuocoPos && cellaDi(vista, fuocoPos[0], fuocoPos[1])) ||
          (opz.selezionato && el.querySelector('.av-scatola[data-articolo="' + cssId(opz.selezionato) + '"]') && el.querySelector('.av-scatola[data-articolo="' + cssId(opz.selezionato) + '"]').closest('.av-cella')) ||
          el.querySelector('.av-cella');
        attivaCella(vista, iniziale, !!fuocoPos);
        segnaPresa(vista);
      }
      // l'anteprima piccola non si anima all'ingresso (ce ne possono essere tante insieme)
      if (opz.anteprima && !stesso) el.classList.add('av-aperto');
      else if (opz.ingresso || !stesso) apriAnte(el, arm);
      else { el.classList.add('av-aperto'); scivola(el, prima); }
      return vista;
    },

    /* Impulso sulla casella dell'articolo (lettura del codice a barre, ricerca "dove si trova"). */
    evidenzia: function (vista, articoloId) {
      if (!vista || !vista.el || !vista.el.isConnected) return false;
      var b = vista.el.querySelector('.av-scatola[data-articolo="' + cssId(articoloId) + '"]');
      if (!b) return false;
      var cella = b.closest('.av-cella');
      ArmadioVista.seleziona(vista, articoloId);
      attivaCella(vista, cella, false);
      try { cella.scrollIntoView({ block: 'center', inline: 'center', behavior: ridotto() ? 'auto' : 'smooth' }); } catch (e) { cella.scrollIntoView(); }
      cella.classList.remove('av-impulso');
      void cella.offsetWidth; // fa ripartire l'animazione
      cella.classList.add('av-impulso');
      setTimeout(function () { cella.classList.remove('av-impulso'); }, 2600);
      if (root.Motion && root.Motion.evidenzia) root.Motion.evidenzia(b);
      return true;
    },

    seleziona: function (vista, articoloId) {
      if (!vista || !vista.el) return;
      Array.prototype.forEach.call(vista.el.querySelectorAll('.av-cella[aria-selected]'), function (x) { x.removeAttribute('aria-selected'); });
      var b = articoloId && vista.el.querySelector('.av-scatola[data-articolo="' + cssId(articoloId) + '"]');
      if (b) b.closest('.av-cella').setAttribute('aria-selected', 'true');
      vista.opz.selezionato = articoloId || null;
    },

    trascina: function (e, dati) { avviaTrascinamento(e, dati); },

    /* Alternativa da tastiera al trascinamento da fuori: il fuoco va nella prima casella libera dell'armadio in modifica. */
    prendi: function (articoloId, testo, cont, da) {
      presa = { articoloId: articoloId, testo: testo || '', da: da || null };
      var el = (cont || document).querySelector('.av.av-modifica');
      var vista = el && el._avVista;
      if (!vista) return false;
      segnaPresa(vista);
      var libera = el.querySelector('.av-cella.av-libera') || el.querySelector('.av-cella');
      attivaCella(vista, libera, true);
      annuncia(vista, 'Preso ' + (testo || '') + '. Scegli il posto con le frecce e premi Invio; Esc per annullare.');
      return true;
    },

    annullaPresa: function () { presa = null; }
  };

  // valore sicuro dentro un selettore [data-articolo="…"]
  function cssId(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return root.CSS && root.CSS.escape ? root.CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  }

  root.ArmadioVista = ArmadioVista;
})(window);
