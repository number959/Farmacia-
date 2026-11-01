/*
 * Versione 3.0 – parte D (docs/NOVITA-3.0.md): pagine di analisi.
 *   Previsioni e fabbisogno (#previsioni)  consumi previsti, fabbisogno per articolo, classi ABC-XYZ e
 *                                          proposta d'ordine della farmacia centrale (permesso "ordini")
 *   Distribuzione (#distribuzione)         quanto la farmacia centrale ha dato a ogni magazzino, quanto si è consumato,
 *                                          dove si trova la merce adesso
 * Tutto si calcola nel browser dai dati già sincronizzati (js/previsioni.js): nessuna scrittura sul server.
 * Il responsabile di magazzino vede solo i suoi magazzini (App.permessi.reparti).
 * Grafici con js/grafici.js (ECharts), animazioni con js/motion.js: con "riduci movimento" niente animazioni.
 */
(function (root) {
  'use strict';

  var App = root.App;
  var h = App.h;
  var P = App.pagine;

  function Pv() { return root.Previsioni; }
  function ridotto() { return !root.Motion || root.Motion.ridotto(); }

  var ORIZZONTI = [{ v: 7, t: '7 giorni' }, { v: 30, t: '30 giorni' }, { v: 90, t: '90 giorni' }];
  var VISTE = [{ v: 'giorno', t: 'Giorno' }, { v: 'settimana', t: 'Settimana' }, { v: 'mese', t: 'Mese' }];
  var MISURE = [{ v: 'valore', t: 'Valore €' }, { v: 'quantita', t: 'Pezzi' }];
  var PERIODI = [{ v: 'mese', t: 'Mese corrente' }, { v: '3', t: 'Ultimi 3 mesi' }, { v: '6', t: 'Ultimi 6 mesi' }, { v: '12', t: 'Ultimi 12 mesi' }, { v: 'intervallo', t: 'Intervallo…' }];
  var GIORNI = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
  var GIORNI_LUNGHI = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
  var AFFIDABILITA = { alta: 'ok', media: 'attenzione', bassa: 'pericolo' };
  var ORDINE_AFF = { alta: 0, media: 1, bassa: 2, scarsa: 3, nessuna: 4 };
  var MAX_RIGHE = 150;          // righe mostrate subito nelle tabelle lunghe ("Mostra tutti" per le altre)
  var LIVELLO_BANDA = 0.9;      // intervallo di previsione al 90%

  /* ======================= scelte ricordate durante la sessione ======================= */

  function memoriaIniziale() {
    return {
      prev: { rep: null, cat: '', cerca: '', orizzonte: 30, vista: 'settimana', misura: 'valore', scheda: 'fabbisogno', col: 'copertura', dir: 1, classe: '', anche: false, tutte: false },
      dist: { periodo: '3', dal: '', al: '', cat: '', cerca: '', misura: 'quantita', art: '', tutte: false },
      ordine: {} // confezioni cambiate a mano nella proposta d'ordine: articoloId -> numero
    };
  }
  var mem = memoriaIniziale();

  // con un altro utente (o dopo l'uscita) le scelte di prima si dimenticano, come nelle altre pagine
  var dimenticaPrima = App.dimenticaScelte;
  App.dimenticaScelte = function () {
    if (dimenticaPrima) dimenticaPrima();
    mem = memoriaIniziale();
  };

  /* ======================= formati ======================= */

  function n1(v) {
    var x = Math.round((Number(v) || 0) * 10) / 10;
    return (x === 0 ? 0 : x).toLocaleString('it-IT', { maximumFractionDigits: 1 });
  }
  function intero(v) { return Math.round(Number(v) || 0).toLocaleString('it-IT'); }
  function euro0(v) { return (Number(v) || 0).toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }); }
  function fmtMisura(misura) { return misura === 'valore' ? euro0 : n1; }
  function dataBreve(d) { return d ? App.fmtData(d) : '—'; }

  function scheda(titolo, corpo, extraTesta, stretto, id) {
    return '<section class="scheda"' + (id ? ' id="' + id + '"' : '') + '><div class="scheda-testa"><h2>' + titolo + '</h2>' + (extraTesta || '') + '</div>' +
      '<div class="scheda-corpo' + (stretto ? ' stretto' : '') + '">' + corpo + '</div></section>';
  }
  function vuoto(titolo, testo) { return '<div class="vuoto"><b>' + h(titolo) + '</b>' + (testo || '') + '</div>'; }

  /* Gruppo di scelte a pulsanti (radio: si usa con le frecce della tastiera). */
  function segmenti(nome, etichetta, voci, scelto, nascondiEtichetta) {
    return '<fieldset class="an-segmenti"><legend' + (nascondiEtichetta ? ' class="an-sr"' : '') + '>' + h(etichetta) + '</legend><div class="an-segmenti-voci">' +
      voci.map(function (v) {
        return '<label><input type="radio" name="' + nome + '" value="' + h(v.v) + '"' + (String(v.v) === String(scelto) ? ' checked' : '') + '><span>' + h(v.t) + '</span></label>';
      }).join('') + '</div></fieldset>';
  }

  function opzioni(voci, scelto) {
    return voci.map(function (v) { return '<option value="' + h(v.v) + '"' + (String(v.v) === String(scelto) ? ' selected' : '') + '>' + h(v.t) + '</option>'; }).join('');
  }

  function opzioniCategoria(scelta) {
    return opzioni([{ v: '', t: 'Farmaci e presidi' }, { v: 'FARMACI', t: 'Farmaci' }, { v: 'PRESIDI', t: 'Presidi' }], scelta);
  }

  /* Indicatori in alto: [{ id, titolo, valore, formato, nota, classe }]; i numeri scorrono (Motion.conta). */
  function htmlIndicatori(voci) {
    return voci.map(function (v) {
      return '<div class="indicatore an-ind ' + (v.classe || '') + '" id="' + v.id + '"><span class="titolo">' + h(v.titolo) + '</span>' +
        '<span class="valore" data-valore="' + (Number(v.valore) || 0) + '">' + v.formato(v.valore) + '</span>' +
        (v.nota ? '<span class="an-ind-nota">' + v.nota + '</span>' : '') + '</div>';
    }).join('');
  }

  function animaIndicatori(box, voci) {
    var M = root.Motion;
    if (!M) return;
    M.entra(box.querySelectorAll('.an-ind'), { ritardo: 45, distanza: 8 });
    voci.forEach(function (v) {
      var el = box.querySelector('#' + v.id + ' .valore');
      if (el) M.conta(el, 0, Number(v.valore) || 0, { formato: v.formato, durata: 900 });
    });
  }

  /* ======================= magazzini visibili ======================= */

  function vedeTutto() { return !(App.permessi && App.permessi.reparti); }

  function nomeMag(r) {
    if (!r) return '—';
    return r.nome + (r.piano ? ' · ' + r.piano : '');
  }

  function magazziniVisibili() {
    var mie = App.permessi && App.permessi.reparti;
    return App.repartiAttivi().filter(function (r) { return !mie || mie.indexOf(r.id) >= 0; });
  }

  function eCentrale(r) { return !!r && (r.tipo === 'centrale' || (r.centrale && r.tipo !== 'periferico')); }

  // scelte del filtro "Magazzino": tutta la struttura (chi vede tutto) o i magazzini propri
  function vociAmbito() {
    var lista = magazziniVisibili();
    var out = [];
    if (vedeTutto()) out.push({ v: '', t: 'Tutta la struttura' });
    else if (lista.length > 1) out.push({ v: '*', t: 'Tutti i miei magazzini' });
    lista.forEach(function (r) { out.push({ v: r.id, t: nomeMag(r) + (eCentrale(r) ? ' (farmacia centrale)' : '') }); });
    return out;
  }

  // valore del filtro -> ambito per js/previsioni.js (null = tutta la struttura)
  function ambitoDa(valore) {
    if (valore === '' && vedeTutto()) return null;
    if (valore === '*' || valore === '') return magazziniVisibili().map(function (r) { return r.id; });
    return [valore];
  }

  /* ======================= grafici: colori e utilità ======================= */

  function css(nome, predefinito) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
      return v || predefinito;
    } catch (e) { return predefinito; }
  }

  function stile() {
    var colori = root.Grafici ? root.Grafici.colori() : ['#1C4184', '#E10717', '#2E8B57', '#D98E04', '#4F79C4', '#7A4FB5', '#0F8A8A', '#8B93A3'];
    return {
      colori: colori,
      testo: css('--testo', '#12244A'),
      tenue: css('--tenue', '#5B687C'),
      linea: css('--linea', '#E3E9F4'),
      superficie: css('--superficie', '#ffffff'),
      superficie2: css('--superficie-2', '#F8FAFD'),
      primario: css('--primario', colori[0]),
      accento: css('--accento', colori[1]),
      ok: css('--ok', '#2E8B57'),
      attenzione: css('--attenzione', '#D98E04'),
      pericolo: css('--pericolo', '#B42318')
    };
  }

  // '#rrggbb' (o '#rgb') con trasparenza; gli altri formati restano come sono
  function rgba(colore, a) {
    var c = String(colore || '').trim();
    if (/^#[0-9a-f]{3}$/i.test(c)) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    if (!/^#[0-9a-f]{6}$/i.test(c)) return c;
    return 'rgba(' + parseInt(c.slice(1, 3), 16) + ',' + parseInt(c.slice(3, 5), 16) + ',' + parseInt(c.slice(5, 7), 16) + ',' + a + ')';
  }

  function sfumatura(colore, alto, basso) {
    if (!root.echarts || !root.echarts.graphic) return rgba(colore, alto);
    return new root.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: rgba(colore, alto) }, { offset: 1, color: rgba(colore, basso) }]);
  }

  function assi(s) {
    return {
      asse: { axisLine: { lineStyle: { color: s.linea } }, axisTick: { show: false }, axisLabel: { color: s.tenue, fontSize: 11 }, splitLine: { lineStyle: { color: s.linea } } },
      tooltip: { backgroundColor: s.superficie, borderColor: s.linea, textStyle: { color: s.testo, fontSize: 12 }, confine: true }
    };
  }

  /*
   * Grafico in un riquadro: ogni volta una tela nuova dentro il riquadro (ECharts non si inizializza due volte sullo
   * stesso elemento); la tela vecchia esce dalla pagina e js/grafici.js libera il suo grafico.
   */
  function grafico(el, opzioni) {
    if (!el || !root.Grafici) return null;
    el.innerHTML = '<div class="an-tela"></div>';
    return root.Grafici.crea(el.firstChild, opzioni);
  }

  function stretto() { return (root.innerWidth || 1024) < 640; }

  /* Mini linea di tendenza (SVG): ultime 12 settimane piene e 4 previste, tratteggiate. */
  function sparkline(storia, prossime, nome) {
    var tutti = storia.concat(prossime);
    if (!tutti.length) return '';
    var L = 92, A = 26, max = Math.max.apply(null, tutti.concat([0.0001]));
    var passo = tutti.length > 1 ? (L - 4) / (tutti.length - 1) : 0;
    function punto(v, i) { return (2 + i * passo).toFixed(1) + ',' + (A - 3 - (v / max) * (A - 6)).toFixed(1); }
    var p1 = storia.map(punto).join(' ');
    var k = storia.length - 1;
    var p2 = prossime.map(function (v, i) { return punto(v, k + 1 + i); });
    if (storia.length) p2.unshift(punto(storia[k], k));
    var testo = 'Ultime ' + storia.length + ' settimane: ' + storia.map(n1).join(', ') + '. Prossime ' + prossime.length + ' previste: ' + prossime.map(n1).join(', ');
    return '<svg class="an-spark" viewBox="0 0 ' + L + ' ' + A + '" width="' + L + '" height="' + A + '" role="img" aria-label="' + h(nome + '. ' + testo) + '"><title>' + h(testo) + '</title>' +
      (p1 ? '<polyline class="an-spark-storia" points="' + p1 + '"/>' : '') +
      (p2.length > 1 ? '<polyline class="an-spark-prev" points="' + p2.join(' ') + '"/>' : '') + '</svg>';
  }

  /* ======================= andamento: storia + previsione con la banda ======================= */

  /*
   * Somma storia e previsione di più articoli, raggruppata per giorno/settimana/mese.
   * opz: { vista, orizzonte, fine (ieri), storico, fattore(riga) -> moltiplicatore (prezzo o 1) }
   * Restituisce { etichette, storico, previsto, basso, banda, oggi (indice del primo periodo previsto), periodi }.
   */
  function datiAndamento(righe, opz) {
    var Pr = Pv();
    var fineN = Pr.numeroGiorno(opz.fine);
    var oggiN = fineN + 1;
    // finestra della storia: 8 settimane a giorni, 26 settimane, oppure i mesi interi dello storico
    var inizioN;
    if (opz.vista === 'giorno') inizioN = oggiN - 56;
    else if (opz.vista === 'settimana') {
      inizioN = oggiN - 26 * 7;
      inizioN -= Pr.giornoSettimana(inizioN);
      var minimo = fineN - opz.storico + 1;
      while (inizioN < minimo) inizioN += 7;
    } else {
      var primo = Pr.dataDa(fineN - opz.storico + 1);
      var y = Number(primo.slice(0, 4)), m = Number(primo.slice(5, 7));
      if (primo.slice(8) !== '01') { m++; if (m > 12) { m = 1; y++; } }
      inizioN = Pr.numeroGiorno(y + '-' + (m < 10 ? '0' : '') + m + '-01');
      if (inizioN > fineN) inizioN = fineN - 27;
    }
    // niente mesi vuoti prima dei primi dati degli articoli scelti
    var primoDato = null;
    righe.forEach(function (r) {
      if (r.serie && r.serie.inizio && opz.fattore(r)) {
        var g0 = Pr.numeroGiorno(r.serie.inizio);
        if (primoDato === null || g0 < primoDato) primoDato = g0;
      }
    });
    if (primoDato !== null && primoDato > inizioN) {
      if (opz.vista === 'settimana') primoDato -= Pr.giornoSettimana(primoDato);
      else if (opz.vista === 'mese') primoDato = Pr.numeroGiorno(Pr.dataDa(primoDato).slice(0, 8) + '01');
      inizioN = Math.min(Math.max(inizioN, primoDato), fineN - 6);
    }
    var nStorico = oggiN - inizioN;
    // la previsione arriva alla fine dell'ultimo periodo (una settimana o un mese non restano a metà)
    var ultimoN = oggiN + opz.orizzonte - 1;
    if (opz.vista === 'settimana') ultimoN += 6 - Pr.giornoSettimana(ultimoN);
    else if (opz.vista === 'mese') {
      var u = Pr.dataDa(ultimoN);
      ultimoN = Pr.numeroGiorno(u.slice(0, 8) + '01') + new Date(Date.UTC(Number(u.slice(0, 4)), Number(u.slice(5, 7)), 0)).getUTCDate() - 1;
    }
    var H = ultimoN - oggiN + 1;
    var storico = [], prev = [], i;
    for (i = 0; i < nStorico; i++) storico.push(0);
    for (i = 0; i < H; i++) prev.push(0);
    righe.forEach(function (r) {
      var f = opz.fattore(r);
      if (!f) return;
      var s = r.serie;
      if (s && s.inizio) {
        var s0 = Pr.numeroGiorno(s.inizio);
        for (var j = 0; j < s.valori.length; j++) {
          var d = s0 + j;
          if (d >= inizioN && d <= fineN && s.valori[j]) storico[d - inizioN] += s.valori[j] * f;
        }
      }
      var pv = r.stima.prevedi(H);
      for (var k = 0; k < H; k++) prev[k] += pv[k] * f;
    });
    var periodi = Pr.periodi(Pr.dataDa(inizioN), nStorico + H, opz.vista);
    var z = Pr.normInv(1 - (1 - LIVELLO_BANDA) / 2);
    var out = { etichette: [], storico: [], previsto: [], basso: [], banda: [], oggi: -1, periodi: periodi, parziali: [] };
    periodi.forEach(function (p, idx) {
      var fineStoria = Math.min(p.a, nStorico);
      var gia = 0, fut = 0, x;
      for (x = p.da; x < fineStoria; x++) gia += storico[x];
      out.etichette.push(p.etichetta);
      if (p.a <= nStorico) {
        out.storico.push(gia);
        out.previsto.push(null);
        out.basso.push(null);
        out.banda.push(null);
        out.parziali.push(0);
        return;
      }
      if (out.oggi < 0) out.oggi = idx;
      var da = Math.max(p.da, nStorico) - nStorico, a = p.a - nStorico;
      for (x = da; x < a; x++) fut += prev[x];
      var varianza = 0;
      righe.forEach(function (r) {
        var f = opz.fattore(r);
        if (!f || !r.stima.sigma) return;
        var sd = Pr.sigmaPeriodo(r.stima, da, a - da) * f;
        varianza += sd * sd;
      });
      var v = gia + fut, sd = Math.sqrt(varianza);
      out.storico.push(null);
      out.previsto.push(v);
      out.basso.push(Math.max(0, v - z * sd));
      out.banda.push(v + z * sd - Math.max(0, v - z * sd));
      out.parziali.push(gia);
    });
    // la linea prevista parte dall'ultimo punto della storia
    if (out.oggi > 0) {
      var k0 = out.oggi - 1;
      out.previsto[k0] = out.storico[k0];
      out.basso[k0] = out.storico[k0];
      out.banda[k0] = 0;
    }
    return out;
  }

  function opzioniAndamento(d, misura, s, altezzaStretta, vista) {
    var A = assi(s);
    var fmt = fmtMisura(misura);
    var cPrev = s.colori[4] || s.primario;
    var curva = vista === 'giorno' ? false : 0.25;
    return {
      grid: { left: 8, right: 14, top: altezzaStretta ? 58 : 34, bottom: 8, containLabel: true },
      legend: { top: 0, left: 0, itemWidth: 14, itemHeight: 8, textStyle: { color: s.tenue, fontSize: 11.5 },
        data: ['Consumo registrato', 'Previsione', 'Intervallo al 90%'] },
      tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: s.linea } },
        formatter: function (lista) {
          var i = lista[0] ? lista[0].dataIndex : 0;
          var p = d.periodi[i];
          var righe = ['<b>' + h(p.inizio === p.fine ? App.fmtData(p.inizio) : App.fmtData(p.inizio) + ' – ' + App.fmtData(p.fine)) + '</b>'];
          if (d.storico[i] !== null) righe.push('Consumo registrato: <b>' + fmt(d.storico[i]) + '</b>');
          if (d.previsto[i] !== null && i >= d.oggi && d.oggi >= 0) {
            righe.push('Previsione: <b>' + fmt(d.previsto[i]) + '</b>');
            righe.push('Intervallo al 90%: ' + fmt(d.basso[i]) + ' – ' + fmt(d.basso[i] + d.banda[i]));
            if (d.parziali[i]) righe.push('<span style="opacity:.75">di cui già consumato: ' + fmt(d.parziali[i]) + '</span>');
          }
          return righe.join('<br>');
        } }, A.tooltip),
      xAxis: Object.assign({ type: 'category', boundaryGap: false, data: d.etichette }, A.asse, { splitLine: { show: false },
        axisLabel: { color: s.tenue, fontSize: 11, hideOverlap: true } }),
      yAxis: Object.assign({ type: 'value', min: 0, splitNumber: altezzaStretta ? 3 : 4 }, A.asse, {
        axisLabel: { color: s.tenue, fontSize: 11, formatter: function (v) { return misura === 'valore' ? euro0(v) : n1(v); } } }),
      series: [
        { name: 'Intervallo al 90%', type: 'line', stack: 'banda', data: d.basso, lineStyle: { opacity: 0 }, symbol: 'none', silent: true, tooltip: { show: false }, legendHoverLink: false,
          itemStyle: { color: rgba(cPrev, 0.18) } },
        { name: 'Intervallo al 90%', type: 'line', stack: 'banda', data: d.banda, lineStyle: { opacity: 0 }, symbol: 'none', silent: true,
          areaStyle: { color: rgba(cPrev, 0.18) }, itemStyle: { color: rgba(cPrev, 0.35) } },
        { name: 'Consumo registrato', type: 'line', data: d.storico, smooth: curva, symbol: 'circle', symbolSize: 4, showSymbol: d.etichette.length < 40,
          lineStyle: { width: 2.4, color: s.primario }, itemStyle: { color: s.primario }, areaStyle: { color: sfumatura(s.primario, 0.22, 0.01) },
          markLine: d.oggi > 0 ? { silent: true, symbol: 'none', label: { formatter: 'oggi', color: s.accento, fontWeight: 700, fontSize: 11 },
            lineStyle: { color: s.accento, type: 'dashed', width: 1.4 }, data: [{ xAxis: d.oggi - 1 }] } : undefined },
        { name: 'Previsione', type: 'line', data: d.previsto, smooth: curva, symbol: 'circle', symbolSize: 4, showSymbol: d.etichette.length < 40,
          lineStyle: { width: 2.4, type: [6, 4], color: cPrev }, itemStyle: { color: cPrev } }
      ],
      animationDuration: 900,
      animationEasing: 'cubicOut'
    };
  }

  /* ======================= PREVISIONI E FABBISOGNO ======================= */

  P.previsioni = function (cont) {
    var Pr = Pv();
    if (!Pr) { cont.innerHTML = scheda('Previsioni', vuoto('Il modulo delle previsioni non è stato caricato', 'Ricarica la pagina.')); return; }
    var voci = vociAmbito();
    if (!voci.length) {
      cont.innerHTML = scheda('Previsioni', vuoto('Il tuo utente non ha magazzini assegnati', 'Chiedi all’amministratore di assegnarti i magazzini.'));
      return;
    }
    var st = mem.prev;
    if (st.rep === null || !voci.some(function (v) { return v.v === st.rep; })) st.rep = voci[0].v;
    var conOrdini = App.puo('ordini');
    if (st.scheda === 'ordine' && !conOrdini) st.scheda = 'fabbisogno';

    cont.innerHTML =
      '<div class="an-pagina" id="pv">' +
      '<div class="strumenti an-filtri">' +
      '<label class="campo"><span>Magazzino</span><select id="pv-rep">' + opzioni(voci, st.rep) + '</select></label>' +
      '<label class="campo"><span>Categoria</span><select id="pv-cat">' + opzioniCategoria(st.cat) + '</select></label>' +
      '<label class="campo an-cerca"><span>Cerca</span><input id="pv-cerca" type="search" placeholder="Nome, principio attivo…" value="' + h(st.cerca) + '" autocomplete="off"></label>' +
      segmenti('pv-orizzonte', 'Orizzonte', ORIZZONTI, st.orizzonte) +
      segmenti('pv-vista', 'Vista', VISTE, st.vista) +
      '</div>' +
      '<div class="an-attesa" id="pv-attesa" role="status" hidden></div>' +
      '<div class="indicatori an-indicatori" id="pv-ind"></div>' +
      '<section class="scheda an-andamento" id="pv-andamento"><div class="scheda-testa"><h2>Andamento dei consumi e previsione</h2>' +
      '<span class="nota" id="pv-andamento-nota"></span>' + segmenti('pv-misura', 'Misura', MISURE, st.misura, true) + '</div>' +
      '<div class="scheda-corpo"><div class="an-grafico an-grafico-alto" id="pv-grafico" role="img" aria-label="Grafico dei consumi registrati e previsti"></div>' +
      '<p class="piccolo tenue an-legenda">Linea piena: consumi e perdite registrati (i trasferimenti fra magazzini non sono consumi). Linea tratteggiata: previsione; ' +
      'la fascia è l’intervallo in cui il consumo cadrà 9 volte su 10, e si allarga più si guarda lontano.</p></div></section>' +
      '<div class="an-schede" role="tablist" aria-label="Sezioni delle previsioni" id="pv-schede">' +
      schedaBtn('fabbisogno', 'Fabbisogno per articolo') + schedaBtn('abc', 'Classi ABC-XYZ') + (conOrdini ? schedaBtn('ordine', 'Proposta d’ordine') : '') +
      '</div>' +
      '<div id="pv-pannello" class="an-pannello" role="tabpanel" tabindex="-1" aria-labelledby="pv-tab-' + st.scheda + '"></div>' +
      '</div>';

    function schedaBtn(id, testo) {
      var sel = st.scheda === id;
      return '<button type="button" role="tab" id="pv-tab-' + id + '" data-scheda="' + id + '" aria-selected="' + sel + '" aria-controls="pv-pannello" tabindex="' + (sel ? 0 : -1) + '">' + h(testo) + '</button>';
    }

    var ultima = null;     // ultima analisi calcolata
    var gettone = 0;       // calcolo in corso: uno nuovo annulla il vecchio
    var primaVolta = true;

    function opzAnalisi() {
      return { reparti: ambitoDa(st.rep), categoria: st.cat || undefined, orizzonte: st.orizzonte, oggi: App.oggi() };
    }

    function attesa(frazione) {
      var box = cont.querySelector('#pv-attesa');
      box.hidden = false;
      var perc = Math.round(Math.max(0, Math.min(1, frazione)) * 100);
      if (!box.firstChild) {
        box.innerHTML = '<span class="an-attesa-testo">Calcolo le previsioni degli articoli…</span>' +
          '<span class="an-attesa-barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Avanzamento del calcolo"><span class="an-attesa-piena"></span></span>';
      }
      box.querySelector('.an-attesa-barra').setAttribute('aria-valuenow', perc);
      box.querySelector('.an-attesa-piena').style.width = perc + '%';
    }

    function calcola() {
      var o = opzAnalisi();
      var mio = ++gettone;
      if (Pr.pronto(App.S, o)) { mostra(Pr.analizza(App.S, o)); return; }
      attesa(0);
      Pr.prepara(App.S, o, function (fatti, tot) { if (mio === gettone) attesa(tot ? fatti / tot : 1); }).then(function () {
        if (mio !== gettone || !cont.isConnected) return;
        mostra(Pr.analizza(App.S, opzAnalisi()));
      });
    }

    function filtrate(an) {
      var t = st.cerca.trim().toLowerCase();
      return an.righe.filter(function (r) {
        if (!st.anche && !(r.totaleStorico > 0) && !(r.confezioni > 0)) return false;
        if (st.classe && (r.abc + (r.xyz || '')) !== st.classe) return false;
        if (t) {
          var a = r.articolo;
          if ((a.nome + ' ' + (a.principio || '') + ' ' + (a.codice || '')).toLowerCase().indexOf(t) < 0) return false;
        }
        return true;
      });
    }

    function mostra(an) {
      ultima = an;
      cont.querySelector('#pv-attesa').hidden = true;
      var righe = filtrate(an);
      disegnaIndicatori(an, righe);
      disegnaAndamento(righe);
      disegnaPannello();
      if (primaVolta && root.Motion) {
        root.Motion.entra(cont.querySelectorAll('#pv-andamento, #pv-schede, #pv-pannello'), { ritardo: 70, distanza: 12 });
      }
      primaVolta = false;
    }

    // per i magazzini periferici la quantità mancante si chiede alla farmacia centrale (pagina Richieste)
    function daChiedere() {
      if (!ultima || !ultima.reparti) return false;
      return ultima.reparti.some(function (id) { return !eCentrale(App.reparto(id)); });
    }

    /* --- indicatori --- */
    function disegnaIndicatori(an, righe) {
      var p = an.parametri;
      var t = { previsto: 0, valore: 0, sotto: 0, esaurimento: 0, daOrdinare: 0, valoreOrdine: 0, conConsumi: 0 };
      var limite = Pr.aggiungiGiorni(p.oggi, p.leadTime);
      righe.forEach(function (r) {
        t.previsto += r.previstoOrizzonte;
        t.valore += r.previstoOrizzonte * r.prezzo;
        if (r.sottoRiordino) t.sotto++;
        if (r.totaleStorico > 0 && r.esaurimento && r.esaurimento <= limite) t.esaurimento++;
        if (r.confezioni > 0) { t.daOrdinare++; t.valoreOrdine += r.valoreOrdine; }
        if (r.totaleStorico > 0) t.conConsumi++;
      });
      var voci = [
        { id: 'pv-k-previsto', titolo: 'Consumo previsto nei prossimi ' + p.orizzonte + ' giorni', valore: t.valore, formato: euro0, nota: n1(t.previsto) + ' pezzi in tutto' },
        { id: 'pv-k-articoli', titolo: 'Articoli con consumi', valore: t.conConsumi, formato: intero, nota: 'su ' + intero(righe.length) + ' mostrati · storia di ' + p.storico + ' giorni' },
        { id: 'pv-k-sotto', titolo: 'Al punto di riordino o sotto', valore: t.sotto, formato: intero, classe: t.sotto ? 'pericolo' : 'ok', nota: 'merce disponibile ≤ consumo durante la consegna + scorta di sicurezza' },
        { id: 'pv-k-esaurimento', titolo: 'In esaurimento entro ' + p.leadTime + ' giorni', valore: t.esaurimento, formato: intero, classe: t.esaurimento ? 'attenzione' : 'ok', nota: 'prima che arrivi un ordine fatto oggi' },
        { id: 'pv-k-ordine', titolo: daChiedere() ? 'Articoli da chiedere alla farmacia' : 'Articoli da ordinare', valore: t.daOrdinare, formato: intero, nota: 'per circa ' + euro0(t.valoreOrdine) + ' · copre ' + p.leadTime + ' + ' + p.revisione + ' giorni' }
      ];
      var box = cont.querySelector('#pv-ind');
      box.innerHTML = htmlIndicatori(voci);
      if (primaVolta) animaIndicatori(box, voci);
      else voci.forEach(function (v) { var el = box.querySelector('#' + v.id + ' .valore'); if (el) el.textContent = v.formato(v.valore); });
    }

    /* --- grafico dell'andamento --- */
    function disegnaAndamento(righe) {
      var el = cont.querySelector('#pv-grafico');
      var p = ultima.parametri;
      var misura = st.misura;
      var d = datiAndamento(righe, { vista: st.vista, orizzonte: p.orizzonte, fine: p.fine, storico: p.storico,
        fattore: function (r) { return misura === 'valore' ? r.prezzo : 1; } });
      var nota = righe.length === 1 ? righe[0].nome : righe.length + ' articoli';
      cont.querySelector('#pv-andamento-nota').textContent = nota + ' · ' + (misura === 'valore' ? 'valore in euro' : 'pezzi');
      var fmt = fmtMisura(misura);
      var tot = righe.reduce(function (s, r) { return s + r.previstoOrizzonte * (misura === 'valore' ? r.prezzo : 1); }, 0);
      el.setAttribute('aria-label', 'Consumi registrati e previsti (' + nota + '): previsti ' + fmt(tot) + ' nei prossimi ' + p.orizzonte + ' giorni.');
      if (!righe.length) { el.innerHTML = vuoto('Nessun articolo da mostrare', 'Cambia i filtri.'); return; }
      grafico(el, opzioniAndamento(d, misura, stile(), stretto(), st.vista));
    }

    /* --- schede --- */
    function disegnaPannello() {
      var pan = cont.querySelector('#pv-pannello');
      pan.setAttribute('aria-labelledby', 'pv-tab-' + st.scheda);
      if (st.scheda === 'abc') pannelloAbc(pan);
      else if (st.scheda === 'ordine') pannelloOrdine(pan);
      else pannelloFabbisogno(pan);
    }

    /* ---------- fabbisogno per articolo ---------- */
    var COLONNE = [
      { col: 'nome', titolo: 'Articolo', testo: true },
      { col: 'mediaGiorno', titolo: 'Al giorno', tit: 'Consumo medio al giorno (storia)' },
      { col: 'mediaSettimana', titolo: 'A settimana', tit: 'Consumo medio a settimana (storia)' },
      { col: 'mediaMese', titolo: 'Al mese', tit: 'Consumo medio al mese (storia)' },
      { col: 'tendenza', titolo: 'Tendenza', tit: 'Ultime 4 settimane rispetto alle 4 prima' },
      { col: null, titolo: 'Andamento', tit: 'Ultime 12 settimane e prossime 4 previste' },
      { col: 'disponibile', titolo: 'Disponibile', tit: 'Giacenza più la merce in viaggio' },
      { col: 'copertura', titolo: 'Copertura', tit: 'Per quanti giorni basta la merce disponibile e quando finisce' },
      { col: 'puntoRiordino', titolo: 'Punto di riordino', tit: 'Consumo previsto durante la consegna + scorta di sicurezza' },
      { col: 'daOrdinare', titolo: 'Da ordinare', tit: 'Per coprire consegna e periodo fino al prossimo ordine, a confezioni intere' },
      { col: 'affidabilita', titolo: 'Modello', tit: 'Modello scelto e affidabilità della previsione' }
    ];

    function valoreOrdina(r, col) {
      switch (col) {
        case 'nome': return r.nome.toLowerCase();
        case 'copertura': return r.totaleStorico > 0 ? r.copertura : Infinity;
        case 'esaurimento': return r.esaurimento || '9999';
        case 'affidabilita': return ORDINE_AFF[r.affidabilita.id] === undefined ? 9 : ORDINE_AFF[r.affidabilita.id];
        case 'tendenza': return r.tendenza === null ? -Infinity : r.tendenza;
        default: return Number(r[col]) || 0;
      }
    }

    function ordinate(righe) {
      var col = st.col, dir = st.dir;
      return righe.slice().sort(function (x, y) {
        var a = valoreOrdina(x, col), b = valoreOrdina(y, col);
        if (a === b) return x.nome.localeCompare(y.nome, 'it');
        if (typeof a === 'string') return a.localeCompare(b, 'it') * dir;
        if (a === Infinity || b === -Infinity) return 1;
        if (b === Infinity || a === -Infinity) return -1;
        return (a < b ? -1 : 1) * dir;
      });
    }

    function chipCopertura(r) {
      if (!(r.totaleStorico > 0)) return '<span class="tenue">—</span>';
      if (r.copertura === Infinity) return '<span class="etichetta ok">oltre un anno</span>';
      var cl = r.copertura < r.leadTime ? 'pericolo' : (r.copertura < r.leadTime + r.revisione ? 'attenzione' : 'ok');
      var testo = r.copertura <= 0 ? 'esaurito' : (r.copertura < 1 ? 'meno di 1 g' : intero(Math.floor(r.copertura)) + ' gg');
      return '<span class="etichetta ' + cl + '">' + testo + '</span>';
    }

    function testoOrdine(r) {
      if (!(r.confezioni > 0)) return '<span class="tenue">—</span>';
      var u = h(r.unita || 'pz');
      return r.pezziConfezione > 1 ? '<b>' + intero(r.confezioni) + ' conf.</b><span class="an-sotto">' + App.fmtNum(r.daOrdinare) + ' ' + u + '</span>'
        : '<b>' + App.fmtNum(r.daOrdinare) + '</b> <span class="tenue">' + u + '</span>';
    }

    function chipAff(r) {
      var a = r.affidabilita || {};
      return '<span class="etichetta ' + (AFFIDABILITA[a.id] || '') + '">' + h(a.testo || '—') + '</span>';
    }

    function rigaHtml(r) {
      var a = r.articolo;
      var tend = r.tendenza === null ? '<span class="tenue">—</span>'
        : '<span class="an-tend ' + (r.tendenza > 5 ? 'su' : r.tendenza < -5 ? 'giu' : 'piatta') + '">' + (r.tendenza > 5 ? '▲' : r.tendenza < -5 ? '▼' : '▶') + ' ' +
          (r.tendenza > 0 ? '+' : '') + n1(r.tendenza) + '%</span>';
      var classi = (r.abc ? '<span class="an-classe an-classe-' + r.abc + '" title="Classe ABC per valore dei consumi">' + r.abc + (r.xyz || '') + '</span>' : '');
      return '<tr data-id="' + h(r.articoloId) + '"' + (r.sottoRiordino ? ' class="an-urgente"' : '') + '>' +
        '<th scope="row" class="an-art"><button type="button" class="an-art-btn" data-dettaglio="' + h(r.articoloId) + '">' + h(r.nome) + '</button>' +
        '<span class="an-sotto">' + classi + (a.categoria === 'PRESIDI' ? 'Presidio' : 'Farmaco') + (r.unita ? ' · ' + h(r.unita) : '') + '</span></th>' +
        '<td class="n">' + n1(r.mediaGiorno) + '</td><td class="n">' + n1(r.mediaSettimana) + '</td><td class="n">' + n1(r.mediaMese) + '</td>' +
        '<td class="n">' + tend + '</td>' +
        '<td class="an-c-spark">' + sparkline(r.settimane, r.totaleStorico > 0 ? r.prossime : [], r.nome) + '</td>' +
        '<td class="n">' + App.fmtNum(r.disponibile) + (r.inViaggio ? '<span class="an-sotto" title="Partito con un DDT e non ancora ricevuto">🚚 ' + App.fmtNum(r.inViaggio) + ' in viaggio</span>' : '') + '</td>' +
        '<td class="n">' + chipCopertura(r) + (r.totaleStorico > 0 && r.esaurimento ? '<span class="an-sotto">finisce il ' + dataBreve(r.esaurimento) + '</span>' : '') + '</td>' +
        '<td class="n">' + (r.totaleStorico > 0 ? n1(r.puntoRiordino) : '<span class="tenue">—</span>') + '</td>' +
        '<td class="n">' + testoOrdine(r) + '</td>' +
        '<td class="an-nowrap">' + h(r.breveModello) + ' ' + chipAff(r) + '</td></tr>';
    }

    function pannelloFabbisogno(pan) {
      var righe = ordinate(filtrate(ultima));
      COLONNE.forEach(function (c) { if (c.col === 'daOrdinare') c.titolo = daChiedere() ? 'Da chiedere' : 'Da ordinare'; });
      var p = ultima.parametri;
      var tante = righe.length > MAX_RIGHE && !st.tutte;
      var mostrate = tante ? righe.slice(0, MAX_RIGHE) : righe;
      var testa = COLONNE.map(function (c) {
        var attiva = c.col && st.col === c.col;
        var aria = attiva ? ' aria-sort="' + (st.dir > 0 ? 'ascending' : 'descending') + '"' : '';
        var cl = (c.testo ? '' : 'n') + (c.col === null ? ' an-c-spark' : '') + (c.col === 'nome' ? ' an-art' : '');
        var dentro = c.col ? '<button type="button" class="an-ordina" data-col="' + c.col + '"' + (c.tit ? ' title="' + h(c.tit) + '"' : '') + '>' + h(c.titolo) +
          '<span class="an-freccia" aria-hidden="true">' + (attiva ? (st.dir > 0 ? '▲' : '▼') : '↕') + '</span></button>' : '<span title="' + h(c.tit || '') + '">' + h(c.titolo) + '</span>';
        return '<th scope="col" class="' + cl.trim() + '"' + aria + '>' + dentro + '</th>';
      }).join('');
      var filtroClasse = st.classe ? '<button type="button" class="btn piccolo an-filtro-classe" id="pv-togli-classe" aria-label="Togli il filtro della classe ' + h(st.classe) + '">Classe ' + h(st.classe) + ' ✕</button>' : '';
      var soloCentrale = ultima.reparti && ultima.reparti.length === 1 && eCentrale(App.reparto(ultima.reparti[0]));
      pan.innerHTML = (soloCentrale ? '<div class="banda info an-banda"><p>Per la farmacia centrale da sola contano solo i suoi consumi diretti. ' +
        'Per sapere quanto ordinare ai fornitori scegli <b>Tutta la struttura</b> o apri la <b>Proposta d’ordine</b>.</p></div>' : '') +
        scheda('Fabbisogno per articolo',
        (righe.length ? '<div class="tabella-contenitore an-tabella-box"><table class="tabella an-tabella" id="pv-tabella"><caption class="an-sr">Fabbisogno per articolo, ordinabile per colonna</caption>' +
          '<thead><tr>' + testa + '</tr></thead><tbody>' + mostrate.map(rigaHtml).join('') + '</tbody></table></div>' +
          (tante ? '<div class="an-piede"><button type="button" class="btn" id="pv-tutte">Mostra tutti gli articoli (' + righe.length + ')</button></div>' : '')
          : vuoto('Nessun articolo da mostrare', st.anche ? 'Cambia i filtri.' : 'Cambia i filtri o spunta “Anche senza consumi”.')) +
        '<p class="piccolo tenue an-nota-tabella">Consegna in <b>' + p.leadTime + ' giorni</b> (o quelli dell’articolo), un ordine ogni <b>' + p.revisione + ' giorni</b>, ' +
        'livello di servizio <b>' + n1(p.servizio * 100) + '%</b> (si cambiano in Configura). Clic sul nome per il dettaglio con i grafici.</p>',
        '<span class="nota">' + righe.length + ' articoli</span>' + filtroClasse +
        '<label class="spunta"><input type="checkbox" id="pv-anche"' + (st.anche ? ' checked' : '') + '> Anche senza consumi</label>' +
        '<button type="button" class="btn piccolo" id="pv-excel">Excel</button>', true);
      if (root.Motion && !ridotto()) root.Motion.entra(pan.querySelectorAll('#pv-tabella tbody tr:nth-child(-n+20)'), { ritardo: 18, distanza: 6 });
    }

    function esportaFabbisogno() {
      var righe = ordinate(filtrate(ultima));
      var colonne = [{ titolo: 'Articolo', larghezza: 40 }, { titolo: 'Categoria', larghezza: 11 }, { titolo: 'Classe', larghezza: 8 },
        { titolo: 'Medio al giorno', larghezza: 12 }, { titolo: 'Medio a settimana', larghezza: 12 }, { titolo: 'Medio al mese', larghezza: 12 },
        { titolo: 'Tendenza %', larghezza: 11 }, { titolo: 'Giacenza', larghezza: 11 }, { titolo: 'In viaggio', larghezza: 11 },
        { titolo: 'Copertura (giorni)', larghezza: 12 }, { titolo: 'Esaurimento', larghezza: 12 }, { titolo: 'Scorta di sicurezza', larghezza: 12 },
        { titolo: 'Punto di riordino', larghezza: 12 }, { titolo: 'Fabbisogno', larghezza: 12 }, { titolo: 'Confezioni da ordinare', larghezza: 12 },
        { titolo: 'Unità da ordinare', larghezza: 12 }, { titolo: 'Modello', larghezza: 22 }, { titolo: 'Affidabilità', larghezza: 11 }];
      var r1 = function (v) { return Math.round((Number(v) || 0) * 10) / 10; };
      var dati = righe.map(function (r) {
        return [r.nome, r.categoria, r.abc + (r.xyz || ''), r1(r.mediaGiorno), r1(r.mediaSettimana), r1(r.mediaMese), r.tendenza === null ? '' : r.tendenza,
          r.giacenza, r.inViaggio, r.totaleStorico > 0 ? (r.copertura === Infinity ? 'oltre un anno' : r1(r.copertura)) : '', r.esaurimento ? App.fmtData(r.esaurimento) : '',
          r1(r.scortaSicurezza), r1(r.puntoRiordino), r1(r.fabbisogno), r.confezioni, r.daOrdinare, r.nomeModello, r.affidabilita.testo];
      });
      root.ExcelFarmacia.esportaElenco('Fabbisogno', colonne, dati).then(function (b) {
        App.scarica(b, 'Fabbisogno_' + App.oggi() + '.xlsx');
      }, function (e) { App.avviso('Esportazione non riuscita: ' + (e && e.message ? e.message : e), 'errore'); });
    }

    /* ---------- classi ABC-XYZ ---------- */
    function pannelloAbc(pan) {
      var righe = ultima.righe.filter(function (r) { return r.totaleStorico > 0; });
      var tot = righe.reduce(function (s, r) { return s + r.valoreStorico; }, 0) || 1;
      var m = {};
      righe.forEach(function (r) {
        var k = r.abc + (r.xyz || 'Z');
        var c = m[k] || (m[k] = { n: 0, v: 0 });
        c.n++;
        c.v += r.valoreStorico;
      });
      var DESCR_ABC = { A: 'pochi articoli, gran parte della spesa', B: 'spesa intermedia', C: 'molti articoli, poca spesa' };
      var DESCR_XYZ = { X: 'consumo regolare', Y: 'consumo variabile', Z: 'consumo irregolare' };
      var celle = '<div class="an-abc-angolo" aria-hidden="true"></div>' + ['X', 'Y', 'Z'].map(function (y) {
        return '<div class="an-abc-testa"><b>' + y + '</b><span>' + DESCR_XYZ[y] + '</span></div>';
      }).join('');
      ['A', 'B', 'C'].forEach(function (x) {
        celle += '<div class="an-abc-testa an-abc-riga"><b>' + x + '</b><span>' + DESCR_ABC[x] + '</span></div>';
        ['X', 'Y', 'Z'].forEach(function (y) {
          var c = m[x + y] || { n: 0, v: 0 };
          var quota = c.v / tot;
          var intensita = Math.min(1, 0.08 + quota * 1.6);
          var sel = st.classe === x + y;
          celle += '<button type="button" class="an-abc-cella' + (sel ? ' scelta' : '') + (intensita > 0.55 ? ' scura' : '') + '" data-classe="' + x + y + '" style="--quota:' + intensita.toFixed(3) + '"' +
            ' aria-pressed="' + sel + '" aria-label="Classe ' + x + y + ': ' + c.n + ' articoli, ' + n1(quota * 100) + '% della spesa. Mostra nella tabella"' + (c.n ? '' : ' disabled') + '>' +
            '<span class="an-abc-sigla">' + x + y + '</span><span class="an-abc-n">' + c.n + '</span><span class="an-abc-quota">' + n1(quota * 100) + '% della spesa</span></button>';
        });
      });
      pan.innerHTML = '<div class="griglia-2 an-abc">' +
        scheda('Matrice ABC-XYZ', '<div class="an-abc-griglia">' + celle + '</div>' +
          '<div class="guida piccolo an-abc-guida"><p><b>ABC</b>: valore dei consumi (pezzi × prezzo) dello storico; gli articoli <b>A</b> fanno l’80% della spesa, i <b>B</b> il 15%, i <b>C</b> il 5%.</p>' +
          '<p><b>XYZ</b>: quanto varia il consumo da una settimana all’altra. Gli <b>AX</b> si ordinano con fiducia e scorte basse; gli <b>AZ</b> vanno seguiti da vicino; i <b>CZ</b> si possono tenere a scorta minima.</p>' +
          '<p>Clic su una casella per vedere quegli articoli nella tabella del fabbisogno.</p></div>', '<span class="nota">' + righe.length + ' articoli con consumi</span>') +
        scheda('Curva ABC (Pareto)', '<div class="an-grafico" id="pv-pareto" role="img" aria-label="Valore dei consumi per articolo, dal più alto, con la quota cumulata"></div>' +
          '<p class="piccolo tenue an-legenda">Barre: valore dei consumi degli articoli più costosi; linea: quota cumulata della spesa. Le linee all’80% e al 95% separano A, B e C.</p>') +
        '</div>';
      disegnaPareto(pan.querySelector('#pv-pareto'), righe, tot);
      if (root.Motion) root.Motion.entra(pan.querySelectorAll('.an-abc-cella'), { ritardo: 40, distanza: 10 });
    }

    function disegnaPareto(el, righe, tot) {
      if (!el) return;
      var ordinate = righe.slice().sort(function (a, b) { return b.valoreStorico - a.valoreStorico; });
      var primi = ordinate.slice(0, 30);
      var cum = 0, quota = [];
      ordinate.forEach(function (r, i) { cum += r.valoreStorico; if (i < 30) quota.push(Math.round(cum / tot * 1000) / 10); });
      if (!primi.length) { el.innerHTML = vuoto('Nessun consumo nello storico', ''); return; }
      var s = stile(), A = assi(s);
      var colore = { A: s.primario, B: s.colori[4] || s.primario, C: s.colori[7] || s.tenue };
      grafico(el, {
        grid: { left: 8, right: 8, top: 26, bottom: 8, containLabel: true },
        tooltip: Object.assign({ trigger: 'axis', formatter: function (l) {
          var i = l[0].dataIndex, r = primi[i];
          return '<b>' + h(r.nome) + '</b><br>Classe ' + r.abc + (r.xyz || '') + ' · ' + App.fmtEuro(r.valoreStorico) + '<br>Quota cumulata: ' + n1(quota[i]) + '%';
        } }, A.tooltip),
        xAxis: Object.assign({ type: 'category', data: primi.map(function (r) { return r.nome; }) }, A.asse, { axisLabel: { show: false } }),
        yAxis: [
          Object.assign({ type: 'value', min: 0 }, A.asse, { axisLabel: { color: s.tenue, fontSize: 11, formatter: function (v) { return euro0(v); } } }),
          Object.assign({ type: 'value', min: 0, max: 100 }, A.asse, { splitLine: { show: false }, axisLabel: { color: s.tenue, fontSize: 11, formatter: '{value}%' } })
        ],
        series: [
          { type: 'bar', data: primi.map(function (r) { return { value: r.valoreStorico, itemStyle: { color: colore[r.abc] || s.primario, borderRadius: [3, 3, 0, 0] } }; }), barMaxWidth: 18,
            animationDelay: function (i) { return i * 25; } },
          { type: 'line', yAxisIndex: 1, data: quota, smooth: true, symbol: 'none', lineStyle: { color: s.accento, width: 2 },
            markLine: { silent: true, symbol: 'none', lineStyle: { color: s.tenue, type: 'dashed' }, label: { color: s.tenue, fontSize: 10, position: 'insideStartTop', formatter: '{c}%' },
              data: [{ yAxis: 80 }, { yAxis: 95 }] } }
        ]
      });
    }

    /* ---------- proposta d'ordine della farmacia centrale ---------- */
    function confezioniDi(r) { return mem.ordine[r.articoloId] !== undefined ? mem.ordine[r.articoloId] : r.confezioni; }

    function righeOrdine() {
      return ultima.righe.filter(function (r) { return r.confezioni > 0 || (mem.ordine[r.articoloId] || 0) > 0; });
    }

    function gruppiOrdine(righe) {
      var per = {};
      righe.forEach(function (r) { (per[r.fornitore] = per[r.fornitore] || []).push(r); });
      return Object.keys(per).sort(function (a, b) {
        if (!a) return 1;
        if (!b) return -1;
        return a.localeCompare(b, 'it');
      }).map(function (f) { return { fornitore: f, righe: per[f].sort(function (x, y) { return x.nome.localeCompare(y.nome, 'it'); }) }; });
    }

    function pannelloOrdine(pan) {
      if (ultima.reparti) {
        pan.innerHTML = scheda('Proposta d’ordine', '<div class="banda info"><p>La proposta d’ordine della farmacia centrale si calcola su <b>tutta la struttura</b>: ' +
          'consumi di tutti i magazzini, giacenze ovunque e merce in viaggio.</p><button type="button" class="btn primario" id="pv-a-struttura">Passa a tutta la struttura</button></div>');
        return;
      }
      var p = ultima.parametri;
      var gruppi = gruppiOrdine(righeOrdine());
      var totale = 0, nArt = 0;
      var corpo = gruppi.map(function (g, gi) {
        var parziale = 0;
        var righe = g.righe.map(function (r) {
          var conf = confezioniDi(r);
          var imp = conf * r.pezziConfezione * r.prezzo;
          parziale += imp;
          if (conf > 0) nArt++;
          var cambiata = mem.ordine[r.articoloId] !== undefined && mem.ordine[r.articoloId] !== r.confezioni;
          return '<tr data-id="' + h(r.articoloId) + '"' + (cambiata ? ' class="an-cambiata"' : '') + '>' +
            '<th scope="row" class="an-art"><button type="button" class="an-art-btn" data-dettaglio="' + h(r.articoloId) + '">' + h(r.nome) + '</button>' +
            '<span class="an-sotto">' + (r.articolo.confezione ? h(r.articolo.confezione) + ' · ' : '') + (r.pezziConfezione > 1 ? r.pezziConfezione + ' ' + h(r.unita || 'pz') + ' per confezione' : 'unità: ' + h(r.unita || 'pezzi')) + '</span></th>' +
            '<td class="n">' + App.fmtNum(r.disponibile) + '</td><td class="n">' + n1(r.fabbisogno) + '</td>' +
            '<td class="n">' + intero(r.confezioni) + '</td>' +
            '<td class="n"><input class="q an-conf" type="number" min="0" step="1" inputmode="numeric" value="' + conf + '" data-id="' + h(r.articoloId) + '" aria-label="Confezioni da ordinare: ' + h(r.nome) + '"></td>' +
            '<td class="n an-unita">' + App.fmtNum(conf * r.pezziConfezione) + '</td>' +
            '<td class="n">' + App.fmtEuro(r.prezzo) + '</td><td class="n an-importo">' + App.fmtEuro(imp) + '</td></tr>';
        }).join('');
        totale += parziale;
        return '<section class="an-fornitore" data-gruppo="' + gi + '"><div class="an-fornitore-testa"><h3>' + h(g.fornitore || 'Senza fornitore abituale') + '</h3>' +
          '<span class="nota">' + g.righe.length + ' articoli · <b class="an-parziale">' + App.fmtEuro(parziale) + '</b></span></div>' +
          '<div class="tabella-contenitore"><table class="tabella an-ordine"><thead><tr><th scope="col" class="an-art">Articolo</th><th scope="col" class="n">Disponibile</th>' +
          '<th scope="col" class="n" title="Consumo previsto su consegna + periodo fino al prossimo ordine, più la scorta di sicurezza">Fabbisogno</th>' +
          '<th scope="col" class="n">Proposta (conf.)</th><th scope="col" class="n">Confezioni</th><th scope="col" class="n">Unità</th>' +
          '<th scope="col" class="n">Prezzo</th><th scope="col" class="n">Importo</th></tr></thead><tbody>' + righe + '</tbody></table></div></section>';
      }).join('');
      var imp = App.S.impostazioni || {};
      pan.innerHTML = '<section class="scheda an-proposta" id="pv-proposta">' +
        '<div class="an-solo-stampa an-stampa-testa"><b>Proposta d’ordine</b> — ' + h(imp.struttura || '') + ' · ' + App.fmtData(App.oggi()) + '</div>' +
        '<div class="scheda-testa"><h2>Proposta d’ordine della farmacia centrale</h2><span class="nota" id="pv-ordine-tot">' + nArt + ' articoli · ' + App.fmtEuro(totale) + '</span>' +
        '<button type="button" class="btn piccolo" id="pv-ordine-ripristina"' + (Object.keys(mem.ordine).length ? '' : ' disabled') + '>Ripristina la proposta</button>' +
        '<button type="button" class="btn piccolo" id="pv-ordine-stampa">Stampa</button>' +
        '<button type="button" class="btn piccolo primario" id="pv-ordine-excel">Excel</button></div>' +
        '<div class="scheda-corpo">' +
        '<p class="piccolo tenue an-nota-ordine">Quantità = consumo previsto per ' + p.leadTime + ' giorni di consegna + ' + p.revisione + ' giorni fino al prossimo ordine + scorta di sicurezza, ' +
        'meno quello che c’è già in tutta la struttura e in viaggio, arrotondato a confezioni intere. Il fornitore è quello dell’articolo o dell’ultimo carico. ' +
        'Puoi cambiare le confezioni: la proposta le ricorda finché resti collegato.</p>' +
        (gruppi.length ? corpo : vuoto('Niente da ordinare', 'Con le scorte attuali e la merce in viaggio il fabbisogno è coperto.')) +
        '</div></section>';
    }

    function aggiornaTotaliOrdine(pan) {
      var totale = 0, nArt = 0;
      pan.querySelectorAll('.an-fornitore').forEach(function (sez) {
        var parziale = 0;
        sez.querySelectorAll('tbody tr').forEach(function (tr) {
          var r = rigaDi(tr.getAttribute('data-id'));
          if (!r) return;
          var conf = confezioniDi(r);
          var imp = conf * r.pezziConfezione * r.prezzo;
          parziale += imp;
          if (conf > 0) nArt++;
          tr.querySelector('.an-unita').textContent = App.fmtNum(conf * r.pezziConfezione);
          tr.querySelector('.an-importo').textContent = App.fmtEuro(imp);
          tr.classList.toggle('an-cambiata', mem.ordine[r.articoloId] !== undefined && mem.ordine[r.articoloId] !== r.confezioni);
        });
        sez.querySelector('.an-parziale').textContent = App.fmtEuro(parziale);
        totale += parziale;
      });
      var t = pan.querySelector('#pv-ordine-tot');
      if (t) t.textContent = nArt + ' articoli · ' + App.fmtEuro(totale);
      var rip = pan.querySelector('#pv-ordine-ripristina');
      if (rip) rip.disabled = !Object.keys(mem.ordine).length;
    }

    function rigaDi(id) { return ultima ? ultima.righe.filter(function (r) { return r.articoloId === id; })[0] : null; }

    function codiceArticolo(a) {
      if (a.codice) return a.codice;
      var k = (a.barcode || []).filter(function (x) { return /^aic:/.test(x); })[0] || (a.barcode || [])[0];
      return k && root.Barcode ? root.Barcode.descrivi(k) : '';
    }

    function esportaOrdine() {
      if (!root.ExcelOrdini) { App.avviso('Esportazione non disponibile: ricarica la pagina.', 'errore'); return; }
      var p = ultima.parametri;
      var gruppi = gruppiOrdine(righeOrdine()).map(function (g) {
        return { fornitore: g.fornitore, righe: g.righe.map(function (r) {
          return { nome: r.nome, codice: codiceArticolo(r.articolo), confezione: r.articolo.confezione || '', pezziConfezione: r.pezziConfezione,
            confezioni: confezioniDi(r), unita: r.unita, disponibile: r.disponibile, fabbisogno: Math.round(r.fabbisogno * 10) / 10, prezzo: r.prezzo };
        }) };
      });
      var imp = App.S.impostazioni || {};
      root.ExcelOrdini.propostaOrdine({
        struttura: imp.struttura || '', data: App.oggi(), gruppi: gruppi,
        note: 'Consegna ' + p.leadTime + ' giorni · un ordine ogni ' + p.revisione + ' giorni · livello di servizio ' + n1(p.servizio * 100) + '%' + (st.cat ? ' · ' + (st.cat === 'FARMACI' ? 'solo farmaci' : 'solo presidi') : '')
      }).then(function (b) {
        App.scarica(b, 'Proposta_ordine_' + App.oggi() + '.xlsx');
      }, function (e) { App.avviso('Esportazione non riuscita: ' + (e && e.message ? e.message : e), 'errore'); });
    }

    function stampaOrdine() {
      var corpo = document.body;
      corpo.classList.add('an-stampa');
      var tolto = false;
      function togli() { if (tolto) return; tolto = true; corpo.classList.remove('an-stampa'); root.removeEventListener('afterprint', togli); }
      root.addEventListener('afterprint', togli);
      root.print();
      setTimeout(togli, 1500);
    }

    /* ---------- dettaglio di un articolo ---------- */
    function apriDettaglio(id) {
      var r = rigaDi(id);
      if (!r) return;
      dettaglioArticolo(r, ultima.parametri, st.vista);
    }

    /* ---------- eventi ---------- */
    var attesaCerca = null;
    cont.querySelector('#pv-rep').addEventListener('change', function (e) { st.rep = e.target.value; st.classe = ''; calcola(); });
    cont.querySelector('#pv-cat').addEventListener('change', function (e) { st.cat = e.target.value; calcola(); });
    cont.querySelector('#pv-cerca').addEventListener('input', function (e) {
      st.cerca = e.target.value;
      clearTimeout(attesaCerca);
      attesaCerca = setTimeout(function () { if (ultima) mostra(ultima); }, 160);
    });
    cont.addEventListener('change', function (e) {
      var t = e.target;
      if (t.name === 'pv-orizzonte') { st.orizzonte = Number(t.value); calcola(); }
      else if (t.name === 'pv-vista') { st.vista = t.value; if (ultima) disegnaAndamento(filtrate(ultima)); }
      else if (t.name === 'pv-misura') { st.misura = t.value; if (ultima) disegnaAndamento(filtrate(ultima)); }
      else if (t.id === 'pv-anche') { st.anche = t.checked; if (ultima) mostra(ultima); }
    });
    cont.addEventListener('input', function (e) {
      var t = e.target;
      if (!t.classList.contains('an-conf')) return;
      var id = t.getAttribute('data-id');
      var r = rigaDi(id);
      if (!r) return;
      var v = Math.max(0, Math.round(Number(String(t.value).replace(',', '.')) || 0));
      if (v === r.confezioni) delete mem.ordine[id]; else mem.ordine[id] = v;
      aggiornaTotaliOrdine(cont.querySelector('#pv-pannello'));
    });
    cont.addEventListener('click', function (e) {
      var t = e.target;
      var b = t.closest('[data-dettaglio]');
      if (b) { apriDettaglio(b.getAttribute('data-dettaglio')); return; }
      var o = t.closest('.an-ordina');
      if (o) {
        var col = o.getAttribute('data-col');
        if (st.col === col) st.dir = -st.dir;
        else { st.col = col; st.dir = col === 'nome' || col === 'copertura' || col === 'esaurimento' || col === 'affidabilita' ? 1 : -1; }
        pannelloFabbisogno(cont.querySelector('#pv-pannello'));
        var nuovo = cont.querySelector('.an-ordina[data-col="' + col + '"]');
        if (nuovo) nuovo.focus();
        return;
      }
      var c = t.closest('.an-abc-cella');
      if (c) { st.classe = st.classe === c.getAttribute('data-classe') ? '' : c.getAttribute('data-classe'); vaiScheda('fabbisogno'); mostra(ultima); return; }
      if (t.closest('#pv-togli-classe')) { st.classe = ''; mostra(ultima); var cerca = cont.querySelector('#pv-anche'); if (cerca) cerca.focus(); return; }
      if (t.closest('#pv-tutte')) { st.tutte = true; pannelloFabbisogno(cont.querySelector('#pv-pannello')); return; }
      if (t.closest('#pv-excel')) { esportaFabbisogno(); return; }
      if (t.closest('#pv-ordine-excel')) { esportaOrdine(); return; }
      if (t.closest('#pv-ordine-stampa')) { stampaOrdine(); return; }
      if (t.closest('#pv-ordine-ripristina')) { mem.ordine = {}; pannelloOrdine(cont.querySelector('#pv-pannello')); App.avviso('Proposta ripristinata', 'ok'); return; }
      if (t.closest('#pv-a-struttura')) { st.rep = ''; cont.querySelector('#pv-rep').value = ''; calcola(); }
    });

    // schede accessibili: frecce, Home e Fine
    var lista = cont.querySelector('#pv-schede');
    function vaiScheda(id, fuoco) {
      st.scheda = id;
      lista.querySelectorAll('[role=tab]').forEach(function (x) {
        var s = x.getAttribute('data-scheda') === id;
        x.setAttribute('aria-selected', s ? 'true' : 'false');
        x.tabIndex = s ? 0 : -1;
        if (s && fuoco) x.focus();
      });
    }
    lista.addEventListener('click', function (e) {
      var b = e.target.closest('[role=tab]');
      if (!b || !ultima) return;
      vaiScheda(b.getAttribute('data-scheda'));
      disegnaPannello();
    });
    lista.addEventListener('keydown', function (e) {
      var tabs = Array.prototype.slice.call(lista.querySelectorAll('[role=tab]'));
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
      if (j === null) return;
      e.preventDefault();
      vaiScheda(tabs[(j + tabs.length) % tabs.length].getAttribute('data-scheda'), true);
      if (ultima) disegnaPannello();
    });

    // dati cambiati (anche da altri utenti, dopo "Aggiorna"): si ricalcola con gli stessi filtri
    App.rinfresca = calcola;
    calcola();
  };

  /* ======================= finestra di dettaglio di un articolo ======================= */

  function dettaglioArticolo(r, p, vista) {
    var st = r.stima;
    var u = r.unita || 'pz';
    function kpi(t, v, nota) { return '<div class="an-mini"><span>' + h(t) + '</span><b>' + v + '</b>' + (nota ? '<small>' + nota + '</small>' : '') + '</div>'; }
    var copertura = !(r.totaleStorico > 0) ? '—' : (r.copertura === Infinity ? 'oltre un anno' : n1(r.copertura) + ' giorni');
    var vistaD = vista || 'settimana';
    var corpo =
      '<div class="an-mini-griglia">' +
      kpi('Consumo medio', n1(r.mediaGiorno) + ' ' + h(u) + '/giorno', n1(r.mediaSettimana) + ' a settimana · ' + n1(r.mediaMese) + ' al mese') +
      kpi('Disponibile', App.fmtNum(r.disponibile) + ' ' + h(u), r.inViaggio ? 'di cui 🚚 ' + App.fmtNum(r.inViaggio) + ' in viaggio' : 'giacenza, nessun DDT in viaggio') +
      kpi('Copertura', copertura, r.esaurimento ? 'finisce verso il ' + App.fmtData(r.esaurimento) : '') +
      kpi('Punto di riordino', n1(r.puntoRiordino) + ' ' + h(u), 'scorta di sicurezza ' + n1(r.scortaSicurezza) + ' (consegna ' + r.leadTime + ' gg)') +
      kpi('Da ordinare', r.confezioni > 0 ? (r.pezziConfezione > 1 ? intero(r.confezioni) + ' conf. (' + App.fmtNum(r.daOrdinare) + ' ' + h(u) + ')' : App.fmtNum(r.daOrdinare) + ' ' + h(u)) : 'niente',
        'fabbisogno ' + n1(r.fabbisogno) + ' per ' + (r.leadTime + r.revisione) + ' giorni') +
      kpi('Modello', h(st.breve), (st.affidabilita ? 'affidabilità ' + h(st.affidabilita.testo).toLowerCase() : '') + (st.mae !== null && st.mae !== undefined ? ' · errore medio ±' + n1(st.mae) + ' al giorno' : '')) +
      '</div>' +
      '<div class="an-dett-testa"><h3>Consumi e previsione</h3>' + segmenti('pvd-vista', 'Vista', VISTE, vistaD, true) + '</div>' +
      '<div class="an-grafico" id="pvd-grafico" role="img" aria-label="Consumi registrati e previsione di ' + h(r.nome) + '"></div>' +
      '<div class="an-dett-due">' +
      '<div><h3>Consumi per giorno della settimana</h3><div class="an-grafico an-grafico-calore" id="pvd-calore" role="img" aria-label="Mappa di calore dei consumi per giorno della settimana nelle ultime 12 settimane"></div>' +
      '<p class="piccolo tenue" id="pvd-calore-nota"></p></div>' +
      '<div><h3>Confronto dei modelli</h3><div class="an-grafico an-grafico-calore" id="pvd-modelli" role="img" aria-label="Retro-verifica dei modelli sulle ultime settimane"></div>' +
      '<div id="pvd-modelli-tab"></div></div>' +
      '</div>' +
      '<details class="an-come"><summary>Come si legge</summary><div class="guida piccolo">' +
      '<p>La previsione usa i consumi e le perdite degli ultimi ' + (p ? p.storico : 180) + ' giorni (i trasferimenti fra magazzini non sono consumi). ' +
      'Il programma prova più modelli: fa finta di essere 4 settimane fa, prevede le 4 settimane successive e controlla quale sbaglia meno (errore medio assoluto). Vince il più preciso; a parità, il più semplice.</p>' +
      '<p><b>Scorta di sicurezza</b> = z × σ × √(giorni di consegna): σ è l’errore tipico della previsione di un giorno, z dipende dal livello di servizio. ' +
      '<b>Punto di riordino</b> = consumo previsto durante la consegna + scorta di sicurezza. <b>Da ordinare</b> = consumo previsto per consegna e periodo fino al prossimo ordine + scorta − merce disponibile, a confezioni intere.</p>' +
      '</div></details>';
    App.apriModale({
      titolo: r.nome,
      largo: true,
      corpo: corpo,
      piede: '<button class="btn" type="button" id="pvd-scheda">Scheda dell’articolo</button><span class="spazio"></span><button class="btn primario" type="button" data-chiudi>Chiudi</button>',
      dopo: function (m) {
        m.classList.add('an-modale');
        m.querySelector('#pvd-scheda').addEventListener('click', function () { App.chiudiModale(); App.schedaArticolo(r.articoloId); });
        m.querySelector('.an-dett-testa').addEventListener('change', function (e) {
          if (e.target.name === 'pvd-vista') { vistaD = e.target.value; disegnaStoria(); }
        });
        function disegnaStoria() {
          var el = m.querySelector('#pvd-grafico');
          var d = datiAndamento([r], { vista: vistaD, orizzonte: p.orizzonte, fine: p.fine, storico: p.storico, fattore: function () { return 1; } });
          grafico(el, opzioniAndamento(d, 'quantita', stile(), stretto(), vistaD));
        }
        // dopo l'apertura (la finestra ha già le sue misure)
        setTimeout(function () {
          if (!m.isConnected || m.hidden) return;
          disegnaStoria();
          disegnaCalore(m, r);
          disegnaModelli(m, r);
          if (root.Motion) root.Motion.entra(m.querySelectorAll('.an-mini'), { ritardo: 40, distanza: 8 });
        }, 40);
      }
    });
  }

  function disegnaCalore(m, r) {
    var Pr = Pv();
    var el = m.querySelector('#pvd-calore');
    var s = r.serie;
    if (!s || !s.inizio || !s.valori.length) { el.innerHTML = vuoto('Nessun consumo registrato', ''); return; }
    var s0 = Pr.numeroGiorno(s.inizio);
    var fine = s0 + s.valori.length - 1;
    // ultime 12 settimane intere (da lunedì a domenica) fino a ieri
    var ultimaDom = fine - ((Pr.giornoSettimana(fine) + 1) % 7);
    var settimane = [], dati = [], max = 0, perGiorno = [0, 0, 0, 0, 0, 0, 0], conte = [0, 0, 0, 0, 0, 0, 0];
    for (var w = 11; w >= 0; w--) {
      var lun = ultimaDom - 6 - w * 7;
      if (lun + 6 < s0) continue;
      settimane.push(App.fmtData(Pr.dataDa(lun)).slice(0, 5));
      for (var g = 0; g < 7; g++) {
        var d = lun + g;
        if (d < s0) continue;
        var v = s.valori[d - s0] || 0;
        dati.push([g, settimane.length - 1, v]);
        if (v > max) max = v;
        perGiorno[g] += v;
        conte[g]++;
      }
    }
    if (!settimane.length) { el.innerHTML = vuoto('Storia troppo corta', 'Servono almeno una settimana intera di consumi.'); return; }
    var medie = perGiorno.map(function (x, i) { return conte[i] ? x / conte[i] : 0; });
    var top = medie.indexOf(Math.max.apply(null, medie));
    var nota = m.querySelector('#pvd-calore-nota');
    if (nota) nota.textContent = medie[top] > 0 ? 'Giorno con più consumi: ' + GIORNI_LUNGHI[top] + ' (media ' + n1(medie[top]) + '). ' +
      'Domenica: media ' + n1(medie[6]) + '.' : '';
    var st = stile(), A = assi(st);
    grafico(el, {
      grid: { left: 6, right: 10, top: 6, bottom: 44, containLabel: true },
      tooltip: Object.assign({ formatter: function (x) { return 'Settimana del ' + settimane[x.value[1]] + '<br>' + GIORNI_LUNGHI[x.value[0]] + ': <b>' + n1(x.value[2]) + '</b>'; } }, A.tooltip),
      xAxis: Object.assign({ type: 'category', data: GIORNI, splitArea: { show: false } }, A.asse, { axisLine: { show: false } }),
      yAxis: Object.assign({ type: 'category', data: settimane, inverse: true }, A.asse, { axisLine: { show: false }, axisLabel: { color: st.tenue, fontSize: 10 } }),
      visualMap: { min: 0, max: Math.max(1, max), calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 120, itemWidth: 10,
        textStyle: { color: st.tenue, fontSize: 10 }, inRange: { color: [st.superficie2, rgba(st.primario, 0.45), st.primario] }, text: ['di più', 'niente'] },
      series: [{ type: 'heatmap', data: dati, itemStyle: { borderColor: st.superficie, borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: st.accento } }, animationDuration: 600 }]
    });
  }

  function disegnaModelli(m, r) {
    var Pr = Pv();
    var el = m.querySelector('#pvd-modelli');
    var tab = m.querySelector('#pvd-modelli-tab');
    var st = r.stima;
    if (!st.retro || !st.candidati.length) {
      el.innerHTML = vuoto('Storia troppo corta per il confronto', 'Il modello si è scelto con una regola semplice.');
      tab.innerHTML = '';
      return;
    }
    var H = st.retro.giorni;
    var inizio = Pr.numeroGiorno(r.serie.fine) - H + 1;
    var etichette = [];
    for (var i = 0; i < H; i++) etichette.push(App.fmtData(Pr.dataDa(inizio + i)).slice(0, 5));
    var s = stile(), A = assi(s);
    var colori = [s.colori[4], s.colori[2], s.colori[3], s.colori[5], s.colori[6]];
    var serie = [{ name: 'Consumo vero', type: 'bar', data: st.retro.reali, itemStyle: { color: rgba(s.primario, 0.28), borderRadius: [2, 2, 0, 0] }, barMaxWidth: 12 }];
    st.candidati.forEach(function (c, k) {
      var scelto = c.id === st.id;
      serie.push({ name: c.breve, type: 'line', data: c.previsti.map(function (v) { return Math.round(v * 100) / 100; }), symbol: 'none', smooth: 0.2,
        lineStyle: { width: scelto ? 3 : 1.4, color: scelto ? s.accento : colori[k % colori.length], type: scelto ? 'solid' : [4, 3] },
        itemStyle: { color: scelto ? s.accento : colori[k % colori.length] }, z: scelto ? 5 : 3 });
    });
    grafico(el, {
      grid: { left: 6, right: 10, top: 30, bottom: 6, containLabel: true },
      legend: { top: 0, left: 0, type: 'scroll', itemWidth: 12, itemHeight: 8, textStyle: { color: s.tenue, fontSize: 10.5 } },
      tooltip: Object.assign({ trigger: 'axis', valueFormatter: function (v) { return n1(v); } }, A.tooltip),
      xAxis: Object.assign({ type: 'category', data: etichette }, A.asse, { axisLabel: { color: s.tenue, fontSize: 10, hideOverlap: true } }),
      yAxis: Object.assign({ type: 'value', min: 0, splitNumber: 3 }, A.asse),
      series: serie
    });
    var righe = st.candidati.slice().sort(function (a, b) { return a.mae - b.mae; });
    tab.innerHTML = '<table class="tabella an-modelli"><caption class="an-sr">Errore dei modelli nella retro-verifica</caption><thead><tr><th scope="col">Modello</th>' +
      '<th scope="col" class="n" title="Errore assoluto medio al giorno sulle ultime ' + H + ' giorni">Errore al giorno</th>' +
      '<th scope="col" class="n" title="Errore medio sulle somme di 7 giorni, riportato al giorno">Sulla settimana</th></tr></thead><tbody>' +
      righe.map(function (c) {
        var scelto = c.id === st.id;
        return '<tr' + (scelto ? ' class="an-scelto"' : '') + '><td>' + h(c.nome) + (scelto ? ' <span class="etichetta ok">scelto</span>' : '') + '</td>' +
          '<td class="n">' + n1(c.mae) + '</td><td class="n">' + n1(c.maeSettimane) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  /* ======================= DISTRIBUZIONE ALLE PERIFERICHE ======================= */

  function primoDelMese(d, mesiPrima) {
    var y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - (mesiPrima || 0);
    while (m < 1) { m += 12; y--; }
    return y + '-' + (m < 10 ? '0' : '') + m + '-01';
  }

  function periodoDa(st) {
    var oggi = App.oggi();
    if (st.periodo === 'intervallo') {
      var dal = /^\d{4}-\d{2}-\d{2}$/.test(st.dal) ? st.dal : Pv().aggiungiGiorni(oggi, -29);
      var al = /^\d{4}-\d{2}-\d{2}$/.test(st.al) ? st.al : oggi;
      if (dal > al) { var x = dal; dal = al; al = x; }
      return { dal: dal, al: al };
    }
    if (st.periodo === 'mese') return { dal: primoDelMese(oggi, 0), al: oggi };
    var n = Number(st.periodo) || 3;
    return { dal: primoDelMese(oggi, n - 1), al: oggi };
  }

  P.distribuzione = function (cont) {
    var Pr = Pv();
    if (!Pr) { cont.innerHTML = scheda('Distribuzione', vuoto('Il modulo delle previsioni non è stato caricato', 'Ricarica la pagina.')); return; }
    var st = mem.dist;
    var centrale = App.repartoCentrale();
    var visibili = magazziniVisibili();
    if (!visibili.length) {
      cont.innerHTML = scheda('Distribuzione', vuoto('Il tuo utente non ha magazzini assegnati', 'Chiedi all’amministratore di assegnarti i magazzini.'));
      return;
    }
    if (!st.dal || !st.al) { var pp = periodoDa({ periodo: '3' }); st.dal = st.dal || pp.dal; st.al = st.al || pp.al; }

    cont.innerHTML =
      '<div class="an-pagina" id="ds">' +
      '<div class="strumenti an-filtri">' +
      '<label class="campo"><span>Periodo</span><select id="ds-periodo">' + opzioni(PERIODI, st.periodo) + '</select></label>' +
      '<label class="campo an-data"' + (st.periodo === 'intervallo' ? '' : ' hidden') + '><span>Dal</span><input type="date" id="ds-dal" value="' + h(st.dal) + '"></label>' +
      '<label class="campo an-data"' + (st.periodo === 'intervallo' ? '' : ' hidden') + '><span>Al</span><input type="date" id="ds-al" value="' + h(st.al) + '"></label>' +
      '<label class="campo"><span>Categoria</span><select id="ds-cat">' + opzioniCategoria(st.cat) + '</select></label>' +
      '<label class="campo an-cerca"><span>Cerca</span><input id="ds-cerca" type="search" placeholder="Nome dell’articolo…" value="' + h(st.cerca) + '" autocomplete="off"></label>' +
      segmenti('ds-misura', 'Misura', [{ v: 'quantita', t: 'Pezzi' }, { v: 'valore', t: 'Valore €' }], st.misura) +
      '<span class="spazio"></span><button type="button" class="btn" id="ds-excel">Excel</button>' +
      '</div>' +
      '<div class="indicatori an-indicatori" id="ds-ind"></div>' +
      '<div class="an-griglia-grafici">' +
      scheda('Dalla farmacia centrale ai magazzini', '<div class="an-grafico an-grafico-alto" id="ds-sankey" role="img"></div>' +
        '<p class="piccolo tenue an-legenda">Da sinistra: quello che la farmacia centrale ha dato a ogni magazzino nel periodo (DDT ricevuti e trasferimenti diretti), poi quanto ogni magazzino ha consumato, perso o reso.</p>', '', false, 'ds-flussi') +
      scheda('Dato ogni mese', '<div class="an-grafico an-grafico-alto" id="ds-mesi" role="img"></div>', '', false, 'ds-mesi-box') +
      '</div>' +
      scheda('Dove si trova la merce adesso', '<div class="an-grafico an-grafico-alto" id="ds-dove" role="img"></div><p class="piccolo tenue an-legenda" id="ds-dove-nota"></p>',
        '<label class="campo an-scegli-art"><span class="an-sr">Articolo</span><select id="ds-art"></select></label>', false, 'ds-dove-box') +
      '<div id="ds-tabella-box"></div>' +
      '</div>';

    var primaVolta = true;
    var ultimo = null;

    function prezzo(id) { var a = App.articolo(id); return a ? Number(a.prezzo) || 0 : 0; }
    function misura(id, q) { return st.misura === 'valore' ? q * prezzo(id) : q; }

    function filtroArticoli() {
      var t = st.cerca.trim().toLowerCase();
      return function (id) {
        var a = App.articolo(id);
        if (!a) return false;
        if (st.cat && a.categoria !== st.cat) return false;
        if (t && (a.nome + ' ' + (a.principio || '') + ' ' + (a.codice || '')).toLowerCase().indexOf(t) < 0) return false;
        return true;
      };
    }

    // magazzini nelle colonne: periferici visibili, anche non attivi se hanno movimenti nel periodo
    function colonneMagazzini(d) {
      var conDati = {};
      Object.keys(d.perArticolo).forEach(function (a) { Object.keys(d.perArticolo[a]).forEach(function (r) { conDati[r] = true; }); });
      var mie = App.permessi && App.permessi.reparti;
      return App.S.reparti.filter(function (r) {
        if (r.tipo === 'transito' || eCentrale(r) || (centrale && r.id === centrale.id)) return false;
        if (mie && mie.indexOf(r.id) < 0) return false;
        return r.attivo !== false || conDati[r.id];
      }).sort(function (a, b) { return (a.ordine || 0) - (b.ordine || 0) || a.nome.localeCompare(b.nome, 'it'); });
    }

    function coloreMag(r, i, s) { return r.colore && /^#[0-9a-f]{6}$/i.test(r.colore) ? r.colore : s.colori[(i + 2) % s.colori.length]; }

    function calcola() {
      var per = periodoDa(st);
      var d = Pr.distribuzione(App.S, { dal: per.dal, al: per.al, centraleId: centrale ? centrale.id : null });
      var mags = colonneMagazzini(d);
      var filtro = filtroArticoli();
      var t = Pr.totaliDistribuzione(d, filtro, misura);
      ultimo = { d: d, mags: mags, t: t, filtro: filtro, per: per };
      disegna();
    }

    function disegna() {
      var d = ultimo.d, mags = ultimo.mags, t = ultimo.t;
      var fmt = fmtMisura(st.misura);
      var tot = { dato: 0, consumato: 0, giacenza: 0, inViaggio: 0, resi: 0 };
      mags.forEach(function (r) {
        var x = t.perMagazzino[r.id] || {};
        Object.keys(tot).forEach(function (k) { tot[k] += x[k] || 0; });
      });
      var cx = centrale ? (t.perMagazzino[centrale.id] || {}) : {};
      var periodo = 'dal ' + App.fmtData(d.dal) + ' al ' + App.fmtData(d.al);
      var voci = [
        { id: 'ds-k-dato', titolo: 'Dato ai magazzini', valore: tot.dato, formato: fmt, nota: periodo },
        { id: 'ds-k-consumato', titolo: 'Consumato nei magazzini', valore: tot.consumato, formato: fmt, nota: 'consumi registrati nel periodo' },
        { id: 'ds-k-giacenza', titolo: 'Giacenza nei magazzini', valore: tot.giacenza, formato: fmt, nota: 'adesso' },
        { id: 'ds-k-viaggio', titolo: 'In viaggio', valore: tot.inViaggio, formato: fmt, nota: 'DDT partiti e non ancora ricevuti', classe: tot.inViaggio ? 'attenzione' : '' }
      ];
      if (vedeTutto() && centrale) voci.push({ id: 'ds-k-centrale', titolo: 'In farmacia centrale', valore: cx.giacenza || 0, formato: fmt, nota: 'giacenza adesso' });
      if (tot.resi) voci.push({ id: 'ds-k-resi', titolo: 'Resi alla farmacia', valore: tot.resi, formato: fmt, nota: 'nel periodo' });
      var box = cont.querySelector('#ds-ind');
      box.innerHTML = htmlIndicatori(voci);
      if (primaVolta) {
        animaIndicatori(box, voci);
        if (root.Motion) root.Motion.entra(cont.querySelectorAll('#ds-flussi, #ds-mesi-box, #ds-dove-box, #ds-tabella-box'), { ritardo: 80, distanza: 12 });
      }
      primaVolta = false;
      disegnaSankey();
      disegnaMesi();
      opzioniArticolo();
      disegnaDove();
      disegnaTabella();
    }

    function disegnaSankey() {
      var el = cont.querySelector('#ds-sankey');
      var t = ultimo.t, mags = ultimo.mags;
      var s = stile(), A = assi(s);
      var fmt = fmtMisura(st.misura);
      var nomi = {}, valori = {}, nodi = [], link = [];
      var idC = centrale ? centrale.id : '';
      function nodo(id, nome, colore) { if (nomi[id]) return; nomi[id] = nome; nodi.push({ name: id, itemStyle: { color: colore, borderColor: colore } }); }
      // valore mostrato: per la farmacia quanto ha dato, per i magazzini quanto hanno ricevuto, per le uscite il totale
      function valore(x) { return valori[x.name] !== undefined ? valori[x.name] : x.value; }
      // sul telefono (in verticale) il nome dentro la barra, corto; il valore è nel suggerimento
      var CORTI = { 'x-consumato': 'Consumato', 'x-perdite': 'Perdite', 'x-resi': 'Resi' };
      function breve(id) {
        var t = CORTI[id] || (id === idC && centrale ? centrale.nome : nomi[id]) || '';
        return t.length > 12 ? t.slice(0, 11) + '…' : t;
      }
      var uscite = { 'x-consumato': 0, 'x-perdite': 0, 'x-resi': 0 };
      mags.forEach(function (r, i) {
        var x = t.perMagazzino[r.id] || {};
        var col = coloreMag(r, i, s);
        if (x.dato > 0) {
          nodo(idC, nomeMag(centrale), s.primario);
          nodo(r.id, r.nome, col);
          link.push({ source: idC, target: r.id, value: x.dato });
          valori[r.id] = x.dato;
        }
        [['consumato', 'x-consumato'], ['perdite', 'x-perdite'], ['resi', 'x-resi']].forEach(function (k) {
          if (x[k[0]] > 0) { nodo(r.id, r.nome, col); link.push({ source: r.id, target: k[1], value: x[k[0]] }); uscite[k[1]] += x[k[0]]; }
        });
      });
      valori[idC] = link.filter(function (l) { return l.source === idC; }).reduce(function (t, l) { return t + l.value; }, 0);
      if (uscite['x-consumato']) nodo('x-consumato', 'Consumato', s.colori[2] || s.ok);
      if (uscite['x-perdite']) nodo('x-perdite', 'Perdite e scaduti', s.pericolo);
      if (uscite['x-resi']) nodo('x-resi', 'Resi alla farmacia', s.colori[3] || s.attenzione);
      var dati = link.length > 0;
      el.setAttribute('aria-label', dati ? 'Flussi: ' + mags.map(function (r) { var x = t.perMagazzino[r.id] || {}; return r.nome + ' ricevuto ' + fmt(x.dato || 0) + ', consumato ' + fmt(x.consumato || 0); }).join('; ')
        : 'Nessun passaggio nel periodo');
      if (!dati) { el.innerHTML = vuoto('Nessun passaggio nel periodo', 'Nessun DDT ricevuto, trasferimento o consumo per i filtri scelti.'); return; }
      var verticale = stretto();
      grafico(el, {
        tooltip: Object.assign({ trigger: 'item', formatter: function (x) {
          if (x.dataType === 'edge') return h(nomi[x.data.source]) + ' → ' + h(nomi[x.data.target]) + ': <b>' + fmt(x.data.value) + '</b>';
          return h(nomi[x.name]) + ': <b>' + fmt(valore(x)) + '</b>' + (valori[x.name] !== undefined && x.name !== idC ? ' ricevuto' : '');
        } }, A.tooltip),
        series: [{
          type: 'sankey', data: nodi, links: link, orient: verticale ? 'vertical' : 'horizontal',
          left: 8, right: verticale ? 8 : 110, top: 12, bottom: 12,
          nodeWidth: verticale ? 22 : 14, nodeGap: 12, draggable: false, layoutIterations: 32,
          emphasis: { focus: 'adjacency' },
          lineStyle: { color: 'gradient', opacity: 0.35, curveness: 0.5 },
          label: verticale
            ? { position: 'inside', color: '#fff', fontSize: 10.5, fontWeight: 600, formatter: function (x) { return breve(x.name); } }
            : { color: s.testo, fontSize: 11.5, formatter: function (x) { return nomi[x.name] + '\n{v|' + fmt(valore(x)) + '}'; }, rich: { v: { color: s.tenue, fontSize: 10.5, lineHeight: 16 } } },
          animationDuration: 1100
        }]
      });
    }

    function disegnaMesi() {
      var el = cont.querySelector('#ds-mesi');
      var d = ultimo.d, t = ultimo.t, mags = ultimo.mags;
      var s = stile(), A = assi(s);
      var fmt = fmtMisura(st.misura);
      var etichette = d.mesi.map(function (k) { var p = k.split('-'); return ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'][Number(p[1]) - 1] + ' ' + p[0].slice(2); });
      var qualcosa = false;
      var serie = mags.map(function (r, i) {
        var dati = d.mesi.map(function (k) { var v = (t.perMese[k] || {})[r.id] || 0; if (v) qualcosa = true; return Math.round(v * 100) / 100; });
        return { name: r.nome, type: 'bar', stack: 'dato', data: dati, barMaxWidth: 46, itemStyle: { color: coloreMag(r, i, s) }, emphasis: { focus: 'series' },
          animationDelay: function (k) { return k * 60 + i * 30; } };
      });
      el.setAttribute('aria-label', 'Dato ogni mese ai magazzini: ' + d.mesi.map(function (k, i) {
        var somma = mags.reduce(function (x, r) { return x + ((t.perMese[k] || {})[r.id] || 0); }, 0);
        return etichette[i] + ' ' + fmt(somma);
      }).join(', '));
      if (!qualcosa) { el.innerHTML = vuoto('Niente dato nel periodo', ''); return; }
      serie.forEach(function (x, i) { if (i === serie.length - 1) x.itemStyle.borderRadius = [3, 3, 0, 0]; });
      grafico(el, {
        grid: { left: 8, right: 10, top: mags.length > 3 ? 54 : 30, bottom: 8, containLabel: true },
        legend: { top: 0, left: 0, type: 'scroll', itemWidth: 12, itemHeight: 8, textStyle: { color: s.tenue, fontSize: 11 } },
        tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: fmt }, A.tooltip),
        xAxis: Object.assign({ type: 'category', data: etichette }, A.asse, { splitLine: { show: false } }),
        yAxis: Object.assign({ type: 'value', min: 0, splitNumber: 4 }, A.asse, { axisLabel: { color: s.tenue, fontSize: 11, formatter: function (v) { return st.misura === 'valore' ? euro0(v) : n1(v); } } }),
        series: serie
      });
    }

    function opzioniArticolo() {
      var sel = cont.querySelector('#ds-art');
      var d = ultimo.d, filtro = ultimo.filtro;
      var ids = Object.keys(d.perArticolo).filter(function (a) {
        if (!filtro(a)) return false;
        var x = d.perArticolo[a];
        return Object.keys(x).some(function (r) { return x[r].giacenza || x[r].inViaggio; });
      }).sort(function (a, b) { return App.nomeArticolo(a).localeCompare(App.nomeArticolo(b), 'it'); });
      if (st.art && ids.indexOf(st.art) < 0) st.art = '';
      sel.innerHTML = '<option value="">Tutti gli articoli (mappa)</option>' + ids.map(function (a) {
        return '<option value="' + h(a) + '"' + (a === st.art ? ' selected' : '') + '>' + h(App.nomeArticolo(a)) + '</option>';
      }).join('');
    }

    // magazzini da mostrare in "dove si trova": la farmacia centrale (chi vede tutto) e i periferici
    function luoghi() {
      var l = ultimo.mags.slice();
      if (vedeTutto() && centrale) l.unshift(centrale);
      return l;
    }

    function disegnaDove() {
      var el = cont.querySelector('#ds-dove');
      var nota = cont.querySelector('#ds-dove-nota');
      var d = ultimo.d, filtro = ultimo.filtro;
      var s = stile(), A = assi(s);
      var fmt = fmtMisura(st.misura);
      var posti = luoghi();
      if (st.art) {
        var x = d.perArticolo[st.art] || {};
        var nomiP = posti.map(function (r) { return r.nome; });
        var giac = posti.map(function (r) { return Math.max(0, misura(st.art, (x[r.id] || {}).giacenza || 0)); });
        var viaggio = posti.map(function (r) { return misura(st.art, (x[r.id] || {}).inViaggio || 0); });
        nota.textContent = App.nomeArticolo(st.art) + ': giacenza per magazzino e merce in viaggio verso ognuno.';
        el.setAttribute('aria-label', App.nomeArticolo(st.art) + ': ' + posti.map(function (r, i) { return r.nome + ' ' + fmt(giac[i]) + (viaggio[i] ? ' più ' + fmt(viaggio[i]) + ' in viaggio' : ''); }).join(', '));
        grafico(el, {
          grid: { left: 8, right: 24, top: 26, bottom: 8, containLabel: true },
          legend: { top: 0, left: 0, itemWidth: 12, itemHeight: 8, textStyle: { color: s.tenue, fontSize: 11 }, data: ['In giacenza', 'In viaggio'] },
          tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: fmt }, A.tooltip),
          xAxis: Object.assign({ type: 'value', min: 0 }, A.asse),
          yAxis: Object.assign({ type: 'category', data: nomiP, inverse: true }, A.asse, { axisLabel: { color: s.testo, fontSize: 11.5, width: 120, overflow: 'truncate' } }),
          series: [
            { name: 'In giacenza', type: 'bar', stack: 'q', data: giac.map(function (v, i) { return { value: v, itemStyle: { color: i === 0 && vedeTutto() && centrale ? s.primario : coloreMag(posti[i], i - (vedeTutto() && centrale ? 1 : 0), s) } }; }),
              barMaxWidth: 22, animationDelay: function (i) { return i * 70; } },
            { name: 'In viaggio', type: 'bar', stack: 'q', data: viaggio, barMaxWidth: 22, itemStyle: { color: rgba(s.attenzione, 0.55), borderRadius: [0, 4, 4, 0] } }
          ]
        });
        return;
      }
      // mappa: un riquadro per magazzino, dentro gli articoli (i primi 24 per magazzino, il resto insieme)
      var radici = [];
      posti.forEach(function (r, i) {
        var figli = [];
        Object.keys(d.perArticolo).forEach(function (a) {
          if (!filtro(a)) return;
          var g = (d.perArticolo[a][r.id] || {}).giacenza || 0;
          if (g > 0) figli.push({ name: App.nomeArticolo(a), value: Math.round(misura(a, g) * 100) / 100 });
        });
        figli.sort(function (x, y) { return y.value - x.value; });
        if (figli.length > 24) {
          var altri = figli.slice(24).reduce(function (t, x) { return t + x.value; }, 0);
          figli = figli.slice(0, 24).concat([{ name: 'Altri ' + (figli.length - 24) + ' articoli', value: Math.round(altri * 100) / 100 }]);
        }
        var tot = figli.reduce(function (t, x) { return t + x.value; }, 0);
        if (tot > 0) {
          var col = i === 0 && vedeTutto() && centrale ? s.primario : coloreMag(r, i - (vedeTutto() && centrale ? 1 : 0), s);
          radici.push({ name: r.nome, value: tot, children: figli, itemStyle: { color: col, borderColor: col } });
        }
      });
      var viaggioTot = 0, figliV = [];
      Object.keys(d.perArticolo).forEach(function (a) {
        if (!filtro(a)) return;
        var v = 0;
        posti.forEach(function (r) { v += (d.perArticolo[a][r.id] || {}).inViaggio || 0; });
        if (v > 0) { figliV.push({ name: App.nomeArticolo(a), value: Math.round(misura(a, v) * 100) / 100 }); viaggioTot += misura(a, v); }
      });
      if (viaggioTot > 0) radici.push({ name: 'In viaggio', value: viaggioTot, children: figliV, itemStyle: { color: s.attenzione, borderColor: s.attenzione } });
      nota.textContent = 'Ogni riquadro è un magazzino, grande quanto la sua merce' + (st.misura === 'valore' ? ' (in euro)' : ' (in pezzi)') + '; dentro, gli articoli. Scegli un articolo per vedere dove si trova.';
      el.setAttribute('aria-label', 'Merce per magazzino: ' + radici.map(function (r) { return r.name + ' ' + fmt(r.value); }).join(', '));
      if (!radici.length) { el.innerHTML = vuoto('Nessuna giacenza', 'Non c’è merce per i filtri scelti.'); return; }
      grafico(el, {
        tooltip: Object.assign({ formatter: function (x) {
          var percorso = (x.treePathInfo || []).slice(1).map(function (p) { return h(p.name); }).join(' › ');
          return percorso + ': <b>' + fmt(x.value) + '</b>';
        } }, A.tooltip),
        series: [{
          type: 'treemap', data: radici, roam: false, nodeClick: false, breadcrumb: { show: false },
          left: 0, right: 0, top: 0, bottom: 0, leafDepth: 2, visibleMin: 40, squareRatio: 0.9,
          label: { show: true, fontSize: 11, color: '#fff', overflow: 'truncate', formatter: function (x) { return x.name + '\n' + fmt(x.value); } },
          itemStyle: { borderColor: s.superficie, borderWidth: 1, gapWidth: 1 },
          // il nome del magazzino sta nella fascia in alto del suo riquadro (che ha il colore del bordo del magazzino)
          upperLabel: { show: false, height: 24, color: '#fff', fontWeight: 700, fontSize: 12, formatter: function (x) { return x.name + '  ·  ' + fmt(x.value); } },
          levels: [
            { itemStyle: { borderWidth: 0, gapWidth: 4, borderColor: s.superficie } },
            { upperLabel: { show: true }, itemStyle: { borderWidth: 2, gapWidth: 1 } },
            { colorSaturation: [0.3, 0.6], itemStyle: { borderColorSaturation: 0.7, borderWidth: 1, gapWidth: 1 } }
          ],
          animationDuration: 900
        }]
      });
    }

    /* tabella articolo × magazzino: dato, consumato e giacenza */
    function righeTabella() {
      var d = ultimo.d, filtro = ultimo.filtro, mags = ultimo.mags;
      return Object.keys(d.perArticolo).filter(filtro).map(function (a) {
        var x = d.perArticolo[a];
        var r = { id: a, nome: App.nomeArticolo(a), art: App.articolo(a), per: {}, tot: { dato: 0, consumato: 0, giacenza: 0, resi: 0, perdite: 0, inViaggio: 0 } };
        mags.forEach(function (m) {
          var y = x[m.id] || {};
          r.per[m.id] = y;
          Object.keys(r.tot).forEach(function (k) { r.tot[k] += y[k] || 0; });
        });
        return r;
      }).filter(function (r) {
        return r.tot.dato || r.tot.consumato || r.tot.giacenza || r.tot.inViaggio;
      }).sort(function (a, b) { return misura(b.id, b.tot.dato) - misura(a.id, a.tot.dato) || a.nome.localeCompare(b.nome, 'it'); });
    }

    function disegnaTabella() {
      var box = cont.querySelector('#ds-tabella-box');
      var mags = ultimo.mags;
      var righe = righeTabella();
      var fmt = st.misura === 'valore' ? function (id, q) { return q ? euro0(misura(id, q)) : '<span class="tenue">·</span>'; }
        : function (id, q) { return q ? App.fmtNum(q) : '<span class="tenue">·</span>'; };
      var tante = righe.length > MAX_RIGHE && !st.tutte;
      var mostrate = tante ? righe.slice(0, MAX_RIGHE) : righe;
      var t1 = '<tr><th scope="col" rowspan="2" class="an-art">Articolo</th>' + mags.map(function (m) { return '<th scope="colgroup" colspan="3" class="an-gruppo">' + h(m.nome) + '</th>'; }).join('') +
        '<th scope="colgroup" colspan="3" class="an-gruppo an-totale">Totale</th></tr>';
      var sotto = '<th scope="col" class="n" title="Dato dalla farmacia centrale nel periodo">Dato</th><th scope="col" class="n" title="Consumi e perdite nel periodo">Cons.</th><th scope="col" class="n" title="Giacenza adesso">Giac.</th>';
      var t2 = '<tr>' + mags.map(function () { return sotto; }).join('') + sotto + '</tr>';
      var corpo = mostrate.map(function (r) {
        return '<tr><th scope="row" class="an-art"><button type="button" class="an-art-btn" data-scheda-art="' + h(r.id) + '">' + h(r.nome) + '</button></th>' +
          mags.map(function (m) {
            var y = r.per[m.id] || {};
            return '<td class="n an-primo">' + fmt(r.id, y.dato) + '</td><td class="n">' + fmt(r.id, (y.consumato || 0) + (y.perdite || 0)) + '</td><td class="n">' + fmt(r.id, y.giacenza) +
              (y.inViaggio ? '<span class="an-sotto" title="In viaggio">🚚 ' + fmt(r.id, y.inViaggio) + '</span>' : '') + '</td>';
          }).join('') +
          '<td class="n an-primo an-totale"><b>' + fmt(r.id, r.tot.dato) + '</b></td><td class="n an-totale">' + fmt(r.id, r.tot.consumato + r.tot.perdite) + '</td><td class="n an-totale">' + fmt(r.id, r.tot.giacenza) + '</td></tr>';
      }).join('');
      box.innerHTML = scheda('Articolo per magazzino',
        righe.length ? '<div class="tabella-contenitore an-tabella-box"><table class="tabella an-tabella an-incrocio"><caption class="an-sr">Per ogni articolo: dato dalla farmacia, consumato e giacenza in ogni magazzino</caption>' +
          '<thead>' + t1 + t2 + '</thead><tbody>' + corpo + '</tbody></table></div>' +
          (tante ? '<div class="an-piede"><button type="button" class="btn" id="ds-tutte">Mostra tutti gli articoli (' + righe.length + ')</button></div>' : '')
          : vuoto('Nessun articolo nel periodo', 'Cambia il periodo o i filtri.'),
        '<span class="nota">' + righe.length + ' articoli · ' + (st.misura === 'valore' ? 'valori in euro' : 'pezzi') + ' · Dato = dalla farmacia centrale, Cons. = consumi e perdite, Giac. = adesso</span>', true);
    }

    function esporta() {
      if (!root.ExcelOrdini) { App.avviso('Esportazione non disponibile: ricarica la pagina.', 'errore'); return; }
      var d = ultimo.d, t = ultimo.t, mags = ultimo.mags;
      var v = function (id, q) { var x = misura(id, q || 0); return Math.round(x * 100) / 100; };
      var righe = [];
      righeTabella().forEach(function (r) {
        mags.forEach(function (m) {
          var y = r.per[m.id] || {};
          if (!y.dato && !y.consumato && !y.giacenza && !y.inViaggio && !y.resi && !y.perdite) return;
          righe.push({ nome: r.nome, categoria: r.art ? r.art.categoria : '', magazzino: m.nome, dato: v(r.id, y.dato), resi: v(r.id, y.resi), consumato: v(r.id, y.consumato),
            perdite: v(r.id, y.perdite), giacenza: v(r.id, y.giacenza), inViaggio: v(r.id, y.inViaggio) });
        });
      });
      var imp = App.S.impostazioni || {};
      root.ExcelOrdini.distribuzione({
        struttura: imp.struttura || '', periodo: 'dal ' + App.fmtData(d.dal) + ' al ' + App.fmtData(d.al), misura: st.misura === 'valore' ? 'Valore in euro' : 'Quantità (pezzi)',
        magazzini: mags.map(function (m) { return { id: m.id, nome: m.nome }; }),
        perMagazzino: mags.map(function (m) {
          var x = t.perMagazzino[m.id] || {};
          return { nome: m.nome, dato: x.dato || 0, resi: x.resi || 0, consumato: x.consumato || 0, perdite: x.perdite || 0, giacenza: x.giacenza || 0, inViaggio: x.inViaggio || 0 };
        }),
        mesi: d.mesi.map(function (k) {
          var p = k.split('-');
          return { etichetta: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'][Number(p[1]) - 1] + ' ' + p[0], valori: mags.map(function (m) { return (t.perMese[k] || {})[m.id] || 0; }) };
        }),
        righe: righe
      }).then(function (b) {
        App.scarica(b, 'Distribuzione_' + d.dal + '_' + d.al + '.xlsx');
      }, function (e) { App.avviso('Esportazione non riuscita: ' + (e && e.message ? e.message : e), 'errore'); });
    }

    /* ---------- eventi ---------- */
    var attesaCerca = null;
    cont.querySelector('#ds-periodo').addEventListener('change', function (e) {
      st.periodo = e.target.value;
      cont.querySelectorAll('.an-data').forEach(function (l) { l.hidden = st.periodo !== 'intervallo'; });
      if (st.periodo === 'intervallo') { var x = cont.querySelector('#ds-dal'); if (x) x.focus(); }
      calcola();
    });
    ['#ds-dal', '#ds-al'].forEach(function (sel) {
      cont.querySelector(sel).addEventListener('change', function (e) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) return;
        if (sel === '#ds-dal') st.dal = e.target.value; else st.al = e.target.value;
        calcola();
      });
    });
    cont.querySelector('#ds-cat').addEventListener('change', function (e) { st.cat = e.target.value; calcola(); });
    cont.querySelector('#ds-cerca').addEventListener('input', function (e) {
      st.cerca = e.target.value;
      clearTimeout(attesaCerca);
      attesaCerca = setTimeout(calcola, 180);
    });
    cont.querySelector('#ds-art').addEventListener('change', function (e) { st.art = e.target.value; disegnaDove(); });
    cont.addEventListener('change', function (e) {
      if (e.target.name === 'ds-misura') { st.misura = e.target.value; calcola(); }
    });
    cont.addEventListener('click', function (e) {
      var b = e.target.closest('[data-scheda-art]');
      if (b) { App.schedaArticolo(b.getAttribute('data-scheda-art')); return; }
      if (e.target.closest('#ds-tutte')) { st.tutte = true; disegnaTabella(); return; }
      if (e.target.closest('#ds-excel')) esporta();
    });

    App.rinfresca = calcola;
    calcola();
  };

  /* Per le prove e per le altre pagine. */
  App.Analisi = { datiAndamento: datiAndamento, dettaglioArticolo: dettaglioArticolo };
})(window);
