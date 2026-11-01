/*
 * Grafici (Apache ECharts, vendor/echarts.min.js) con lo stile del programma.
 *   Grafici.crea(elemento, opzioni) -> istanza ECharts (o null se ECharts manca)
 *   Grafici.colori() -> tavolozza corrente (variabili CSS --grafico-1 … --grafico-8)
 *   Grafici.tema() -> 'chiaro' | 'scuro'
 * Ridimensionamento automatico; le istanze dei grafici tolti dalla pagina si liberano da sole.
 * Versione 3.0 – parte F (docs/NOVITA-3.0.md).
 */
(function (root) {
  'use strict';
  var PREDEFINITI = ['#1C4184', '#E10717', '#2E8B57', '#D98E04', '#4F79C4', '#7A4FB5', '#0F8A8A', '#8B93A3'];
  var istanze = [];

  function variabile(nome, predefinito) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
      return v || predefinito;
    } catch (e) { return predefinito; }
  }

  function pulisci() {
    istanze = istanze.filter(function (x) {
      if (x.el.isConnected) return true;
      try { x.g.dispose(); } catch (e) { /* già liberata */ }
      return false;
    });
  }

  var Grafici = {
    tema: function () {
      var t = document.documentElement.getAttribute('data-tema');
      return t === 'scuro' ? 'scuro' : 'chiaro';
    },
    colori: function () {
      var out = [];
      for (var i = 1; i <= 8; i++) out.push(variabile('--grafico-' + i, PREDEFINITI[i - 1]));
      return out;
    },
    crea: function (el, opzioni) {
      if (!root.echarts || !el) return null;
      pulisci();
      var g = root.echarts.init(el, null, { renderer: 'canvas' });
      var ridotto = root.Motion && root.Motion.ridotto && root.Motion.ridotto();
      var base = {
        color: Grafici.colori(),
        textStyle: { fontFamily: variabile('--carattere', 'Inter, sans-serif'), color: variabile('--tenue', '#5B687C') },
        animation: !ridotto,
        animationDuration: 700,
        animationEasing: 'cubicOut'
      };
      g.setOption(Object.assign(base, opzioni || {}));
      istanze.push({ el: el, g: g });
      return g;
    },
    ridimensiona: function () {
      pulisci();
      istanze.forEach(function (x) { try { x.g.resize(); } catch (e) { /* nascosto */ } });
    }
  };

  if (root.addEventListener) root.addEventListener('resize', function () { Grafici.ridimensiona(); });
  root.Grafici = Grafici;
})(typeof window !== 'undefined' ? window : this);
