/*
 * Grafici (Apache ECharts 6, vendor/echarts.min.js) con lo stile del programma.
 *   Grafici.crea(elemento, opzioni, eventi?) -> istanza ECharts (o null se ECharts manca)
 *       opzioni: le opzioni di ECharts, oppure una FUNZIONE che le restituisce: al cambio di tema la funzione si
 *       richiama, così anche i colori letti dalle variabili CSS (Grafici.css('--testo')) cambiano col tema.
 *       eventi: { click: function (parametri) {…}, … } collegati al grafico (anche quando si ridisegna per il tema).
 *       Ridimensionamento automatico (finestra e riquadro); tooltip, assi e legenda con lo stile del programma.
 *   Grafici.aggiorna(elemento, opzioni?) -> dati nuovi nello stesso grafico, con la transizione animata
 *       (senza opzioni richiama la funzione data a crea); se il grafico non c'è restituisce null
 *   Grafici.colori() -> tavolozza corrente (variabili CSS --grafico-1 … --grafico-8; il 2 è il rosso del marchio)
 *   Grafici.tema() -> 'chiaro' | 'scuro'
 *   Grafici.css(nome, predefinito) -> valore di una variabile CSS (per esempio '--tenue')
 *   Grafici.ritema() -> ridisegna i grafici aperti con il tema attuale (lo chiama js/app.js al cambio di tema)
 *   Grafici.libera(contenitore?) -> libera i grafici tolti dalla pagina (o quelli dentro il contenitore);
 *       lo fa da solo js/app.js a ogni cambio di pagina
 *   Grafici.scintilla(el, valori, opz) -> piccola linea di tendenza in SVG (leggera, senza ECharts)
 *       opz: { colore: 'var(--primario)', area: true, punto: true, etichetta: 'testo per il lettore dello schermo' }
 *   Grafici.anello(el, valore, max, colore, opz) -> anello di avanzamento in SVG (valore/max)
 *       opz: { testo: 'al centro' (predefinito: percentuale), etichetta, spessore: 6 }
 * Senza movimento (Motion.ridotto()) i grafici non si animano.
 * Versione 3.0 – parte F (docs/NOVITA-3.0.md).
 */
(function (root) {
  'use strict';
  var PREDEFINITI = ['#1C4184', '#E10717', '#2E8B57', '#D98E04', '#4F79C4', '#7A4FB5', '#0F8A8A', '#8B93A3'];
  var SVG = 'http://www.w3.org/2000/svg';
  var istanze = [];          // { el, g, opzioni (oggetto o funzione), eventi, tema }
  var osservatore = null;    // ResizeObserver condiviso
  var conta = 0;             // per gli id dei gradienti SVG

  function css(nome, predefinito) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
      return v || predefinito;
    } catch (e) { return predefinito; }
  }

  function ridotto() { return !!(root.Motion && root.Motion.ridotto && root.Motion.ridotto()); }

  function nomeTema() { return 'nc-' + Grafici.tema(); }

  /* Tema di ECharts costruito dalle variabili CSS del tema attuale (si ricostruisce a ogni cambio). */
  function registraTema() {
    if (!root.echarts || !root.echarts.registerTheme) return;
    var testo = css('--testo', '#12244A');
    var tenue = css('--tenue', '#5B687C');
    var linea = css('--linea', '#E3E9F4');
    var forte = css('--linea-forte', '#C5D0E2');
    var superficie = css('--superficie', '#ffffff');
    var carattere = css('--carattere', 'Inter, sans-serif');
    var asse = {
      axisLine: { show: true, lineStyle: { color: forte } },
      axisTick: { show: false, lineStyle: { color: forte } },
      axisLabel: { color: tenue, fontSize: 11, fontFamily: carattere },
      splitLine: { show: true, lineStyle: { color: linea, type: [3, 3] } },
      splitArea: { show: false },
      nameTextStyle: { color: tenue, fontSize: 11 }
    };
    var valori = Object.assign({}, asse, { axisLine: { show: false, lineStyle: { color: forte } } });
    root.echarts.registerTheme(nomeTema(), {
      color: Grafici.colori(),
      backgroundColor: 'transparent',
      textStyle: { fontFamily: carattere, color: testo },
      title: { textStyle: { color: testo, fontFamily: css('--carattere-titoli', carattere), fontWeight: 700, fontSize: 14 }, subtextStyle: { color: tenue } },
      legend: { textStyle: { color: tenue, fontSize: 12 }, pageTextStyle: { color: tenue }, inactiveColor: forte, icon: 'roundRect', itemWidth: 12, itemHeight: 8 },
      tooltip: stileTooltip(),
      categoryAxis: Object.assign({}, asse, { splitLine: { show: false, lineStyle: { color: linea } } }),
      valueAxis: valori,
      timeAxis: Object.assign({}, asse, { splitLine: { show: false, lineStyle: { color: linea } } }),
      logAxis: valori,
      line: { symbol: 'circle', symbolSize: 5, lineStyle: { width: 2 }, smooth: false },
      bar: { itemStyle: { borderRadius: [3, 3, 0, 0] } },
      pie: { itemStyle: { borderColor: superficie, borderWidth: 2 }, label: { color: testo } },
      gauge: { title: { color: tenue }, detail: { color: testo } },
      dataZoom: { textStyle: { color: tenue }, borderColor: linea, fillerColor: 'rgba(79,121,196,.15)', handleStyle: { color: superficie, borderColor: forte } },
      markLine: { lineStyle: { color: tenue } }
    });
  }

  /* Tooltip con lo stile del programma (riquadro come le finestre, numeri tabulari). */
  function stileTooltip() {
    return {
      backgroundColor: css('--superficie', '#ffffff'),
      borderColor: css('--linea-forte', '#C5D0E2'),
      borderWidth: 1,
      padding: [8, 11],
      textStyle: { color: css('--testo', '#12244A'), fontSize: 12, fontFamily: css('--carattere', 'Inter, sans-serif') },
      extraCssText: 'border-radius:8px;box-shadow:0 10px 28px rgba(10,24,52,.18);font-variant-numeric:tabular-nums;',
      confine: true,
      axisPointer: { lineStyle: { color: css('--linea-forte', '#C5D0E2') }, shadowStyle: { color: 'rgba(79,121,196,.08)' }, label: { backgroundColor: css('--blu-notte', '#14294F') } }
    };
  }

  /* Opzioni di chi chiama + le parti comuni (colori, carattere, animazione); i valori di chi chiama vincono. */
  function opzioniComplete(opzioni) {
    var o = typeof opzioni === 'function' ? opzioni() : opzioni;
    o = Object.assign({}, o || {});
    if (!o.color) o.color = Grafici.colori();
    if (!o.textStyle) o.textStyle = { fontFamily: css('--carattere', 'Inter, sans-serif'), color: css('--tenue', '#5B687C') };
    if (o.tooltip && !Array.isArray(o.tooltip)) {
      var base = stileTooltip();
      var t = Object.assign({}, o.tooltip);
      Object.keys(base).forEach(function (k) { if (t[k] === undefined) t[k] = base[k]; });
      o.tooltip = t;
    }
    var animato = !ridotto();
    if (!animato) o.animation = false;
    else {
      if (o.animation === undefined) o.animation = true;
      if (o.animationDuration === undefined) o.animationDuration = 700;
      if (o.animationEasing === undefined) o.animationEasing = 'cubicOut';
      if (o.animationDurationUpdate === undefined) o.animationDurationUpdate = 450;
    }
    return o;
  }

  function osserva(el) {
    if (!root.ResizeObserver) return;
    if (!osservatore) {
      osservatore = new root.ResizeObserver(function (voci) {
        voci.forEach(function (v) {
          var x = istanze.filter(function (i) { return i.el === v.target; })[0];
          if (!x) return;
          // solo se le dimensioni sono cambiate davvero (la prima notifica arriva subito e fermerebbe l'animazione d'entrata)
          var w = Math.round(v.contentRect.width), hh = Math.round(v.contentRect.height);
          try {
            if (w > 0 && hh > 0 && (Math.abs(w - x.g.getWidth()) > 1 || Math.abs(hh - x.g.getHeight()) > 1)) x.g.resize();
          } catch (e) { /* nascosto o liberato */ }
        });
      });
    }
    try { osservatore.observe(el); } catch (e) { /* elemento non osservabile */ }
  }

  function chiudi(x) {
    if (osservatore) { try { osservatore.unobserve(x.el); } catch (e) { /* già tolto */ } }
    try { x.g.dispose(); } catch (e) { /* già liberata */ }
  }

  function pulisci(dentro) {
    istanze = istanze.filter(function (x) {
      var via = !x.el.isConnected || (dentro && dentro.contains(x.el)) || (x.g.isDisposed && x.g.isDisposed());
      if (via) chiudi(x);
      return !via;
    });
  }

  function collegaEventi(g, eventi) {
    Object.keys(eventi || {}).forEach(function (nome) {
      if (typeof eventi[nome] === 'function') g.on(nome, eventi[nome]);
    });
  }

  function crea(el, opzioni, eventi) {
    // ECharts non si inizializza due volte sullo stesso elemento: il grafico di prima si libera
    var esistente = root.echarts.getInstanceByDom && root.echarts.getInstanceByDom(el);
    if (esistente) {
      istanze = istanze.filter(function (x) { if (x.el === el) { chiudi(x); return false; } return true; });
      try { esistente.dispose(); } catch (e) { /* già liberata */ }
    }
    var g = root.echarts.init(el, nomeTema(), { renderer: 'canvas' });
    g.setOption(opzioniComplete(opzioni));
    collegaEventi(g, eventi);
    istanze.push({ el: el, g: g, opzioni: opzioni, eventi: eventi || null, tema: Grafici.tema() });
    osserva(el);
    return g;
  }

  var Grafici = {
    tema: function () {
      var t = document.documentElement.getAttribute('data-tema');
      return t === 'scuro' ? 'scuro' : 'chiaro';
    },
    colori: function () {
      var out = [];
      for (var i = 1; i <= 8; i++) out.push(css('--grafico-' + i, PREDEFINITI[i - 1]));
      return out;
    },
    css: css,
    crea: function (el, opzioni, eventi) {
      if (!root.echarts || !el) return null;
      pulisci();
      registraTema();
      try {
        return crea(el, opzioni, eventi);
      } catch (e) {
        if (root.console) root.console.error(e);
        return null;
      }
    },
    aggiorna: function (el, opzioni) {
      var x = istanze.filter(function (i) { return i.el === el; })[0];
      if (!x || (x.g.isDisposed && x.g.isDisposed())) return null;
      if (opzioni) x.opzioni = opzioni;
      try { x.g.setOption(opzioniComplete(x.opzioni)); } catch (e) { if (root.console) root.console.error(e); }
      return x.g;
    },
    ridimensiona: function () {
      pulisci();
      istanze.forEach(function (x) { try { x.g.resize(); } catch (e) { /* nascosto */ } });
    },
    libera: function (contenitore) { pulisci(contenitore || null); },
    // grafici con un tema diverso da quello attuale: si ridisegnano (le opzioni-funzione si richiamano)
    ritema: function () {
      if (!root.echarts) return;
      pulisci();
      registraTema();
      var tema = Grafici.tema();
      istanze.slice().forEach(function (x) {
        if (x.tema === tema) return;
        x.tema = tema;
        try {
          if (typeof x.opzioni === 'function' || !x.g.setTheme) {
            istanze = istanze.filter(function (y) { return y !== x; });
            chiudi(x);
            crea(x.el, x.opzioni, x.eventi);
          } else {
            x.g.setTheme(nomeTema());
          }
        } catch (e) { if (root.console) root.console.error(e); }
      });
    },

    /* Piccola linea di tendenza (SVG). valori: numeri; disegna nell'elemento (che ne decide le dimensioni via CSS). */
    scintilla: function (el, valori, opz) {
      if (!el) return null;
      opz = opz || {};
      var v = (valori || []).map(function (x) { return Number(x) || 0; });
      var L = 120, A = 32, M = 3;
      var max = Math.max.apply(null, v.concat([0]));
      var min = Math.min.apply(null, v.concat([max]));
      if (max === min) { max = max + 1; min = Math.max(0, min - 1); }
      var passo = v.length > 1 ? (L - 2 * M) / (v.length - 1) : 0;
      var punti = v.map(function (x, i) {
        return [M + i * passo, A - M - (x - min) / (max - min) * (A - 2 * M)];
      });
      var colore = opz.colore || 'var(--primario)';
      var id = 'gs' + (++conta);
      var linea = punti.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
      var area = punti.length ? linea + ' L' + punti[punti.length - 1][0].toFixed(1) + ' ' + A + ' L' + punti[0][0].toFixed(1) + ' ' + A + ' Z' : '';
      var ultimo = punti[punti.length - 1];
      el.innerHTML = '<svg class="grafico-scintilla" viewBox="0 0 ' + L + ' ' + A + '" preserveAspectRatio="none" role="img"' +
        (opz.etichetta ? ' aria-label="' + String(opz.etichetta).replace(/"/g, '&quot;') + '"' : ' aria-hidden="true"') + ' style="color:' + colore + '">' +
        '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/>' +
        '<stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>' +
        (punti.length > 1 && opz.area !== false ? '<path d="' + area + '" fill="url(#' + id + ')" stroke="none"/>' : '') +
        (punti.length > 1 ? '<path class="gs-linea" d="' + linea + '" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" pathLength="100"/>' : '') +
        (ultimo && opz.punto !== false ? '<circle cx="' + ultimo[0].toFixed(1) + '" cy="' + ultimo[1].toFixed(1) + '" r="2.4" fill="currentColor" vector-effect="non-scaling-stroke"/>' : '') +
        '</svg>';
      var svg = el.firstChild;
      var p = svg.querySelector('.gs-linea');
      if (p && !ridotto() && p.animate) {
        try { p.animate([{ strokeDasharray: '0 100' }, { strokeDasharray: '100 0' }], { duration: 900, easing: 'cubic-bezier(.2,.8,.2,1)' }); } catch (e) { /* senza Web Animations */ }
      }
      return svg;
    },

    /* Anello di avanzamento (SVG): valore su max, colore (predefinito il colore principale). */
    anello: function (el, valore, max, colore, opz) {
      if (!el) return null;
      opz = opz || {};
      var m = Number(max) || 0;
      var q = m > 0 ? Math.max(0, Math.min(1, (Number(valore) || 0) / m)) : 0;
      var s = opz.spessore || 6;
      var r = 20 - s / 2;
      var giro = 2 * Math.PI * r;
      var testo = opz.testo !== undefined ? opz.testo : Math.round(q * 100) + '%';
      el.innerHTML = '<svg class="grafico-anello" viewBox="0 0 40 40" role="img" aria-label="' +
        String(opz.etichetta || (Math.round(q * 100) + '%')).replace(/"/g, '&quot;') + '" style="color:' + (colore || 'var(--primario)') + '">' +
        '<circle cx="20" cy="20" r="' + r + '" fill="none" stroke="var(--linea)" stroke-width="' + s + '"/>' +
        '<circle class="ga-arco" cx="20" cy="20" r="' + r + '" fill="none" stroke="currentColor" stroke-width="' + s + '" stroke-linecap="round"' +
        ' stroke-dasharray="' + giro.toFixed(2) + '" stroke-dashoffset="' + (giro * (1 - q)).toFixed(2) + '" transform="rotate(-90 20 20)"/>' +
        (testo !== '' ? '<text x="20" y="20" text-anchor="middle" dominant-baseline="central" font-size="9.5" font-weight="700" fill="var(--testo)" font-family="var(--carattere-titoli)">' +
          String(testo).replace(/[<&]/g, '') + '</text>' : '') + '</svg>';
      var arco = el.querySelector('.ga-arco');
      if (arco && !ridotto() && arco.animate && q > 0) {
        try { arco.animate([{ strokeDashoffset: giro.toFixed(2) }, { strokeDashoffset: (giro * (1 - q)).toFixed(2) }], { duration: 900, easing: 'cubic-bezier(.2,.8,.2,1)' }); } catch (e) { /* senza Web Animations */ }
      }
      return el.firstChild;
    }
  };

  // senza ResizeObserver (browser vecchi) i grafici seguono almeno la finestra
  if (root.addEventListener && !root.ResizeObserver) root.addEventListener('resize', function () { Grafici.ridimensiona(); });
  root.Grafici = Grafici;
})(typeof window !== 'undefined' ? window : this);
