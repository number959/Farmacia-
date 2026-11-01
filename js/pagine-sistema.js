/*
 * Versione 3.0 – parte E (docs/NOVITA-3.0.md): pagina Sistema (#sistema), solo per l'amministratore (permesso 'sistema').
 * Stato della base dati in parole semplici: semaforo, numeri, crescita nel tempo, copie di sicurezza verificate,
 * controlli e cure, seconda cartella, prova di ripristino. I dati arrivano da GET /api/sistema (server/salute.js);
 * il controllo vero dei permessi lo fa il server.
 */
(function (root) {
  'use strict';

  var App = root.App;
  var h = App.h;

  var ETICHETTE_STATO = {
    ok: { titolo: 'Tutto in ordine', testo: 'I dati sono integri, le copie di sicurezza sono recenti e verificate. Non c’è niente da fare.', classe: 'ok' },
    attenzione: { titolo: 'Da guardare', testo: 'Niente di grave: leggi i punti qui sotto. Il programma continua a funzionare normalmente.', classe: 'attenzione' },
    problema: { titolo: 'Serve attenzione', testo: 'Leggi i punti qui sotto. Se non è chiaro cosa fare, chiama l’assistenza prima di continuare a lavorare.', classe: 'pericolo' }
  };
  var TIPI_COPIA = { auto: 'automatica', manuale: 'fatta a mano', 'prima-del-ripristino': 'prima di un ripristino' };
  var FILE_COPIA = { farmacia: 'Magazzino', accessi: 'Utenti' };
  var TIPI_CONTROLLO = { avvio: 'Controllo all’avvio', notte: 'Controllo notturno', periodico: 'Controllo completo', manuale: 'Controllo chiesto dall’amministratore' };
  var NOMI_TABELLE = {
    reparti: 'Magazzini', articoli: 'Articoli', movimenti: 'Movimenti', armadi: 'Armadi', assortimento: 'Assortimento',
    richieste: 'Richieste', richiesteRighe: 'Righe delle richieste', ddt: 'DDT', ddtRighe: 'Righe dei DDT', impostazioni: 'Impostazioni'
  };
  var RIGHE_COPIE = 10;
  var RIGHE_CRONOLOGIA = 8;
  var AGGIORNA_MS = 60 * 1000;

  function api() { return root.Api; }
  function messaggio(e) { return e && e.message ? e.message : String(e); }

  /* "3 minuti fa", "ieri alle 22:10"… (per le cose recenti), altrimenti data e ora. */
  function quandoFa(iso, adesso) {
    if (!iso) return '—';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '—';
    var d = Math.round(((adesso || Date.now()) - t) / 60000);
    if (d < 1 && d > -2) return 'adesso';
    if (d >= 1 && d < 60) return d === 1 ? '1 minuto fa' : d + ' minuti fa';
    if (d >= 60 && d < 24 * 60) { var o = Math.round(d / 60); return o === 1 ? '1 ora fa' : o + ' ore fa'; }
    return App.fmtDataOra(iso);
  }

  var MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

  /* Data e ora brevi per le tabelle: "1 nov 06:31" (con l'anno solo se non è quello di adesso). */
  function dataBreve(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var ora = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return d.getDate() + ' ' + MESI[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '') + ' ' + ora;
  }

  function durata(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 1000) return App.fmtNum(Math.max(1, ms)) + ' ms';
    return App.fmtNum(Math.round(ms / 100) / 10) + ' s';
  }

  function megabyte(byte) { return Math.round((Number(byte) || 0) / 1024 / 1024 * 100) / 100; }

  /* Valore e unità per mostrare una dimensione con Motion.conta (MB o GB, una cifra decimale). */
  function grandezza(byte) {
    var n = Number(byte) || 0;
    if (n >= 1024 * 1024 * 1024) return { v: Math.round(n / 1024 / 1024 / 1024 * 10) / 10, u: 'GB', dec: 1 };
    if (n >= 1024 * 1024) return { v: Math.round(n / 1024 / 1024 * 10) / 10, u: 'MB', dec: 1 };
    return { v: Math.round(n / 1024), u: 'KB', dec: 0 };
  }

  function formatoNumero(dec) {
    return function (v) { return (Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec)).toLocaleString('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec }); };
  }

  function scheda(id, titolo, corpo, nota, classe) {
    return '<section class="scheda' + (classe ? ' ' + classe : '') + '" aria-labelledby="' + id + '-titolo">' +
      '<div class="scheda-testa"><h2 id="' + id + '-titolo">' + titolo + '</h2>' + (nota ? '<span class="nota">' + nota + '</span>' : '') + '</div>' +
      '<div class="scheda-corpo" id="' + id + '">' + corpo + '</div></section>';
  }

  App.pagine.sistema = function (cont) {
    var stato = null;          // ultima risposta di GET /api/sistema
    var valoriMostrati = {};   // numeri già mostrati: al rinfresco scorrono dal valore vecchio al nuovo
    var inCorso = false;       // un'azione (controllo, copia, prova) in corso
    var tutteLeCopie = false;
    var tuttaLaCronologia = false;
    var ultimaLettura = 0;
    var timer = null;

    cont.innerHTML =
      '<div class="sis" id="sis">' +
      '<section class="scheda sis-stato" aria-labelledby="sis-stato-titolo" id="sis-stato">' +
      '<div class="sis-semaforo" id="sis-semaforo" role="img" aria-label="Stato della base dati: in lettura">' +
      '<span class="sis-luce rosso"></span><span class="sis-luce giallo"></span><span class="sis-luce verde"></span></div>' +
      '<div class="sis-stato-testo"><p class="sis-sopra">Stato della base dati</p>' +
      '<h2 id="sis-stato-titolo">Controllo in corso…</h2><p class="sis-spiega" id="sis-spiega">Leggo lo stato dal server.</p>' +
      '<ul class="sis-motivi" id="sis-motivi"></ul></div>' +
      '<div class="sis-azioni" role="group" aria-label="Azioni sulla base dati">' +
      '<button class="btn" type="button" id="sis-controlla" title="Controllo completo dell’integrità di magazzino e utenti">Controlla adesso</button>' +
      '<button class="btn primario" type="button" id="sis-copia" title="Copia verificata di magazzino e utenti">Copia adesso</button>' +
      '<button class="btn" type="button" id="sis-prova" title="Ricostruisce i dati dall’ultima copia e dal giornale, per finta, e li confronta con quelli veri">Prova di ripristino</button>' +
      '</div>' +
      '<p class="sis-esito" id="sis-esito" role="status" aria-live="polite"></p>' +
      '</section>' +
      '<div class="indicatori sis-numeri" id="sis-numeri" aria-live="off"></div>' +
      scheda('sis-crescita', 'Crescita nel tempo', '<div class="sis-grafico" id="sis-grafico" role="img" aria-label="Grafico della dimensione della base dati nel tempo"></div>' +
        '<details class="sis-dati-grafico"><summary>Dati del grafico in tabella</summary><div id="sis-grafico-tabella"></div></details>',
        'dimensione del magazzino e delle copie') +
      '<div class="sis-griglia">' +
      scheda('sis-copie', 'Copie di sicurezza', '<p class="tenue piccolo">Carico…</p>', '', 'sis-scheda-copie') +
      scheda('sis-cronologia', 'Controlli e cure', '<p class="tenue piccolo">Carico…</p>') +
      '</div>' +
      '<div class="sis-griglia">' +
      scheda('sis-prova-esito', 'Prova di ripristino', '<p class="tenue piccolo">Carico…</p>') +
      scheda('sis-seconda', 'Seconda cartella delle copie', '<p class="tenue piccolo">Carico…</p>') +
      '</div>' +
      scheda('sis-come', 'Come si protegge da sola la base dati', spiegazione(), '', 'sis-scheda-come') +
      '</div>';

    var el = function (id) { return cont.querySelector('#' + id); };

    el('sis-controlla').addEventListener('click', function () {
      azione(this, 'Controllo in corso…', '/api/sistema/controlla', function (r) {
        var c = r.controllo;
        if (c.esito === 'ok') return { testo: 'Controllo completo finito in ' + durata(c.durataMs) + ': magazzino e utenti sono integri.', tipo: 'ok' };
        return { testo: 'Il controllo ha trovato un danno. ' + (r.sistema.problema ? r.sistema.problema.testo : 'Guarda “Controlli e cure”.'), tipo: 'errore' };
      });
    });
    el('sis-copia').addEventListener('click', function () {
      azione(this, 'Copia in corso…', '/api/sistema/copia', function (r) {
        var buone = r.copie.filter(function (c) { return c.verificata === true; });
        if (buone.length === r.copie.length) {
          return { testo: 'Copie fatte e verificate: ' + r.copie.map(function (c) { return FILE_COPIA[c.prefisso] + ' (' + App.fmtDimensione(c.dimensione) + ')'; }).join(' e ') + '.', tipo: 'ok', nuove: r.copie.map(function (c) { return c.nome; }) };
        }
        return { testo: 'Copia fatta ma NON verificata: ' + r.copie.filter(function (c) { return c.verificata !== true; }).map(function (c) { return c.errore || c.nome; }).join('; '), tipo: 'errore' };
      });
    });
    el('sis-prova').addEventListener('click', function () {
      azione(this, 'Prova in corso…', '/api/sistema/prova-ripristino', function (r) {
        var p = r.prova;
        if (p.esito === 'ok') return { testo: 'La cura funzionerebbe: ricostruiti esattamente gli stessi dati (' + p.tabelle.length + ' tabelle su ' + p.tabelle.length + ' uguali).', tipo: 'ok', prova: true };
        return { testo: 'La prova ha trovato differenze: ' + p.messaggi.join(' '), tipo: 'errore', prova: true };
      });
    });

    /* Un pulsante d'azione: scrive, aspetta, mostra l'esito e ridisegna con lo stato nuovo. */
    function azione(btn, testoAttesa, percorso, esito) {
      if (inCorso) return;
      inCorso = true;
      var testo = btn.textContent;
      var pulsanti = cont.querySelectorAll('.sis-azioni .btn');
      Array.prototype.forEach.call(pulsanti, function (b) { b.disabled = true; });
      btn.textContent = testoAttesa;
      btn.setAttribute('aria-busy', 'true');
      mostraEsito('', '');
      api().richiesta('POST', percorso, {}).then(function (r) {
        var e = esito(r);
        stato = r.sistema;
        ultimaLettura = Date.now();
        disegna();
        mostraEsito(e.testo, e.tipo);
        if (e.nuove) evidenziaCopie(e.nuove);
        if (e.prova && root.Motion) root.Motion.evidenzia(el('sis-prova-esito'));
      }, function (e) {
        mostraEsito(messaggio(e), 'errore');
      }).then(function () {
        inCorso = false;
        btn.textContent = testo;
        btn.removeAttribute('aria-busy');
        Array.prototype.forEach.call(pulsanti, function (b) { b.disabled = false; });
      });
    }

    function mostraEsito(testo, tipo) {
      var p = el('sis-esito');
      p.className = 'sis-esito' + (tipo ? ' ' + tipo : '');
      p.textContent = testo;
      if (testo && root.Motion) root.Motion.entra(p, { distanza: 4 });
    }

    function evidenziaCopie(nomi) {
      nomi.forEach(function (n) {
        var r = cont.querySelector('tr[data-copia="' + n + '"]');
        if (r) {
          r.classList.add('sis-nuova');
          if (root.Motion) root.Motion.evidenzia(r.querySelector('.sis-verifica'));
        }
      });
    }

    /* ---------- lettura dello stato ---------- */

    function carica() {
      ultimaLettura = Date.now();
      return api().richiesta('GET', '/api/sistema').then(function (r) {
        if (!cont.isConnected) return;
        stato = r;
        disegna();
      }, function (e) {
        if (!cont.isConnected) return;
        el('sis-stato-titolo').textContent = 'Stato non disponibile';
        el('sis-spiega').textContent = 'Non riesco a leggere lo stato dal server: ' + messaggio(e);
      });
    }

    // altri utenti hanno scritto: lo stato cambia (revisione, dimensioni), ma non serve rileggerlo più di ogni 10 secondi
    App.rinfresca = function () {
      if (inCorso || Date.now() - ultimaLettura < 10000) return;
      carica();
    };
    timer = setInterval(function () {
      if (!cont.isConnected) { clearInterval(timer); return; }
      if (document.hidden || inCorso) return;
      carica();
    }, AGGIORNA_MS);

    /* ---------- disegno ---------- */

    function disegna() {
      if (!stato || !cont.isConnected) return;
      var primo = !cont.querySelector('#sis').classList.contains('pronta');
      disegnaSemaforo();
      disegnaNumeri();
      disegnaGrafico();
      disegnaCopie();
      disegnaCronologia();
      disegnaProva();
      disegnaSeconda();
      if (primo) {
        cont.querySelector('#sis').classList.add('pronta');
        if (root.Motion) root.Motion.entra(cont.querySelectorAll('.sis-numeri .indicatore, #sis > .scheda, .sis-griglia > .scheda'), { ritardo: 40 });
      }
    }

    function disegnaSemaforo() {
      var e = ETICHETTE_STATO[stato.stato] || ETICHETTE_STATO.attenzione;
      var sem = el('sis-semaforo');
      var prima = sem.getAttribute('data-stato');
      sem.setAttribute('data-stato', stato.stato);
      sem.setAttribute('aria-label', 'Stato della base dati: ' + e.titolo);
      el('sis-stato').setAttribute('data-stato', stato.stato);
      el('sis-stato-titolo').textContent = e.titolo;
      el('sis-spiega').textContent = e.testo;
      el('sis-motivi').innerHTML = (stato.motivi || []).map(function (m) {
        return '<li class="' + (m.livello === 'problema' ? 'problema' : 'attenzione') + '">' + h(m.testo) + '</li>';
      }).join('');
      if (prima && prima !== stato.stato && root.Motion) root.Motion.evidenzia(sem);
    }

    function numero(chiave, valore) {
      var v = Number(valore) || 0;
      var da = valoriMostrati[chiave] === undefined ? 0 : valoriMostrati[chiave];
      valoriMostrati[chiave] = v;
      return { da: da, a: v };
    }

    function disegnaNumeri() {
      var f = stato.file;
      var db = grandezza(f.farmacia.dimensione + f.farmacia.wal);
      var rc = stato.copieRiassunto || {};
      var g = stato.giornale || {};
      var disco = stato.disco ? grandezza(stato.disco.libero) : null;
      var ultimoCompleto = stato.controllo && stato.controllo.ultimoCompleto;
      var schede = [
        {
          id: 'db', titolo: 'Magazzino (farmacia.db)', classe: '', n: numero('db', db.v), unita: db.u, dec: db.dec,
          sotto: 'utenti e registro: ' + App.fmtDimensione(f.accessi.dimensione + f.accessi.wal)
        },
        {
          id: 'rev', titolo: 'Modifiche registrate', classe: '', n: numero('rev', stato.revisione), unita: '', dec: 0,
          sotto: (stato.conteggi && stato.conteggi.movimenti !== undefined ? App.fmtNum(stato.conteggi.movimenti) + ' movimenti, ' + App.fmtNum(stato.conteggi.articoli) + ' articoli' : '')
        },
        {
          id: 'copie', titolo: 'Copie verificate', classe: rc.ultimaVerificata ? (rc.nonRiuscite ? 'attenzione' : 'ok') : 'pericolo',
          n: numero('copie', rc.verificate), unita: rc.totale ? 'su ' + rc.totale : '', dec: 0,
          sotto: rc.ultimaVerificata ? 'ultima: ' + quandoFa(rc.ultimaVerificata.data) : 'nessuna copia verificata'
        },
        {
          id: 'giornale', titolo: 'Giornale delle modifiche', classe: g.errore ? 'pericolo' : '', n: numero('giornale', megabyte(g.dimensione)), unita: 'MB', dec: 2,
          sotto: g.errore ? 'non si scrive!' : (g.ultimaScrittura ? 'ultima riga: ' + quandoFa(g.ultimaScrittura) : 'ancora nessuna modifica') + (g.file ? ' · ' + g.file + (g.file === 1 ? ' giorno' : ' giorni') : '')
        },
        disco ? {
          id: 'disco', titolo: 'Spazio libero sul disco', classe: stato.disco.libero < 1024 * 1024 * 1024 ? 'attenzione' : '', n: numero('disco', disco.v), unita: disco.u, dec: disco.dec,
          sotto: 'su ' + (function (t) { return formatoNumero(t.dec)(t.v) + ' ' + t.u; })(grandezza(stato.disco.totale)) + ' in tutto'
        } : null,
        {
          id: 'controllo', titolo: 'Ultimo controllo completo', classe: ultimoCompleto ? (ultimoCompleto.esito === 'ok' ? 'ok' : 'pericolo') : 'attenzione',
          testo: ultimoCompleto ? (ultimoCompleto.esito === 'ok' ? 'Integro' : 'Danneggiato') : 'Mai fatto',
          sotto: ultimoCompleto ? quandoFa(ultimoCompleto.quando) + ' · prossimo: ' + App.fmtDataOra(stato.controllo.prossimoNotturno) : 'si fa ogni notte'
        }
      ].filter(Boolean);
      var box = el('sis-numeri');
      box.innerHTML = schede.map(function (s) {
        return '<div class="indicatore sis-numero ' + s.classe + '" data-numero="' + s.id + '">' +
          '<span class="titolo">' + h(s.titolo) + '</span>' +
          '<span class="valore">' + (s.testo ? h(s.testo) : '<span class="sis-cifra">' + formatoNumero(s.dec)(s.n.da) + '</span>' + (s.unita ? ' <small>' + h(s.unita) + '</small>' : '')) + '</span>' +
          '<span class="piccolo tenue">' + h(s.sotto || '') + '</span></div>';
      }).join('');
      schede.forEach(function (s) {
        if (s.testo) return;
        var cifra = box.querySelector('[data-numero="' + s.id + '"] .sis-cifra');
        if (root.Motion) root.Motion.conta(cifra, s.n.da, s.n.a, { formato: formatoNumero(s.dec) });
        else cifra.textContent = formatoNumero(s.dec)(s.n.a);
      });
    }

    /* ---------- grafico della crescita ---------- */

    function serieGrafico() {
      var dimensioni = (stato.crescita || []).map(function (c) {
        return [new Date(c.giorno + 'T12:00:00').getTime(), megabyte(c.dimensione), c.movimenti];
      });
      var copie = (stato.copie || []).filter(function (c) { return c.prefisso === 'farmacia'; }).map(function (c) {
        return [new Date(c.data).getTime(), megabyte(c.dimensione), c.verificata === true ? 'verificata' : c.verificata === false ? 'non riuscita' : 'da verificare'];
      }).sort(function (a, b) { return a[0] - b[0]; });
      return { dimensioni: dimensioni, copie: copie };
    }

    function disegnaGrafico() {
      var s = serieGrafico();
      el('sis-grafico-tabella').innerHTML = '<div class="tabella-contenitore" style="max-height:260px"><table class="tabella"><thead><tr>' +
        '<th scope="col">Giorno</th><th scope="col" class="n">Magazzino (MB)</th><th scope="col" class="n">Movimenti</th></tr></thead><tbody>' +
        s.dimensioni.slice().reverse().map(function (d) {
          return '<tr><td>' + h(new Date(d[0]).toLocaleDateString('it-IT')) + '</td><td class="n">' + h(App.fmtNum(d[1])) + '</td><td class="n">' + h(App.fmtNum(d[2])) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      var box = el('sis-grafico');
      if (!root.Grafici || !root.echarts) {
        box.innerHTML = '<p class="tenue piccolo">Grafico non disponibile in questo browser: i dati sono nella tabella qui sotto.</p>';
        box.classList.add('senza');
        return;
      }
      var colori = root.Grafici.colori();
      var stile = getComputedStyle(document.documentElement);
      var linea = (stile.getPropertyValue('--linea') || '#dbe2e7').trim();
      var tenue = (stile.getPropertyValue('--tenue') || '#5b6b75').trim();
      var tempi = s.dimensioni.map(function (d) { return d[0]; }).concat(s.copie.map(function (c) { return c[0]; }));
      var arco = tempi.length ? Math.max.apply(null, tempi) - Math.min.apply(null, tempi) : 0;
      var opzioni = {
        grid: { left: 64, right: 18, top: 36, bottom: 30 },
        legend: { top: 0, right: 0, textStyle: { color: tenue }, itemWidth: 14, itemHeight: 8 },
        tooltip: {
          trigger: 'item',
          formatter: function (p) {
            var d = new Date(p.value[0]);
            var quando = p.seriesIndex === 0 ? d.toLocaleDateString('it-IT') : App.fmtDataOra(d.toISOString());
            return h(p.seriesName) + '<br>' + h(quando) + ': <b>' + h(App.fmtNum(p.value[1])) + ' MB</b>' +
              (p.seriesIndex === 0 && p.value[2] !== undefined ? '<br>' + h(App.fmtNum(p.value[2])) + ' movimenti' : '') +
              (p.seriesIndex === 1 ? '<br>' + h(p.value[2]) : '');
          }
        },
        xAxis: {
          type: 'time', axisLine: { lineStyle: { color: linea } }, splitLine: { show: false },
          axisLabel: {
            color: tenue, hideOverlap: true,
            // date in italiano (ECharts da solo scrive i mesi in inglese)
            formatter: function (v) {
              var d = new Date(v);
              if (arco < 2 * 24 * 3600 * 1000) return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
              return d.getDate() === 1 ? MESI[d.getMonth()] + (d.getMonth() === 0 ? ' ' + d.getFullYear() : '') : String(d.getDate());
            }
          }
        },
        yAxis: {
          type: 'value', min: 0, splitLine: { lineStyle: { color: linea } },
          axisLabel: { color: tenue, formatter: function (v) { return App.fmtNum(v) + ' MB'; } }
        },
        series: [
          {
            name: 'Magazzino', type: 'line', data: s.dimensioni, showSymbol: s.dimensioni.length < 40, symbolSize: 6, smooth: 0.2,
            lineStyle: { width: 2, color: colori[0] }, itemStyle: { color: colori[0] },
            areaStyle: { color: colori[0], opacity: 0.08 }
          },
          {
            // le copie non riuscite in rosso (colore del singolo punto); la legenda resta col colore delle copie buone
            name: 'Copie di sicurezza', type: 'scatter', symbolSize: 7, itemStyle: { color: colori[2] },
            data: s.copie.map(function (c) { return c[2] === 'non riuscita' ? { value: c, itemStyle: { color: colori[1] } } : c; })
          }
        ]
      };
      var esistente = root.echarts.getInstanceByDom && root.echarts.getInstanceByDom(box);
      if (esistente) esistente.setOption(opzioni);
      else root.Grafici.crea(box, opzioni);
      var ultimo = s.dimensioni[s.dimensioni.length - 1];
      box.setAttribute('aria-label', 'Grafico della dimensione della base dati nel tempo' + (ultimo ? ': oggi ' + App.fmtNum(ultimo[1]) + ' MB, ' + s.copie.length + ' copie del magazzino' : ''));
    }

    /* ---------- copie ---------- */

    function verifica(c) {
      if (c.verificata === true) return '<span class="etichetta ok sis-verifica" title="Riaperta e controllata subito dopo la copia' + (c.verificataIl ? ': ' + h(App.fmtDataOra(c.verificataIl)) : '') + '">✓ Verificata</span>';
      if (c.verificata === false) return '<span class="etichetta pericolo sis-verifica" title="' + h(c.errore || '') + '">✕ Non riuscita</span>';
      return '<span class="etichetta sis-verifica" title="Copia della versione precedente: si verifica a poco a poco, una ogni 5 minuti">Da verificare</span>';
    }

    function disegnaCopie() {
      var copie = stato.copie || [];
      var rc = stato.copieRiassunto || {};
      var mostrate = tutteLeCopie ? copie : copie.slice(0, RIGHE_COPIE);
      var corpo = '<p class="sis-riassunto">' + (copie.length
        ? '<b>' + rc.verificate + '</b> copie verificate su ' + rc.totale + ' · ' + h(App.fmtDimensione(rc.dimensione)) + ' in tutto' + (rc.nonRiuscite ? ' · <span class="sis-rosso">' + rc.nonRiuscite + ' non riuscite</span>' : '')
        : 'Ancora nessuna copia.') + '</p>';
      if (copie.length) {
        corpo += '<div class="tabella-contenitore"><table class="tabella sis-tabella-copie"><thead><tr>' +
          '<th scope="col">Quando</th><th scope="col">Copia</th><th scope="col" class="n sis-largo">Dimensione</th><th scope="col">Verifica</th>' +
          '</tr></thead><tbody>' +
          mostrate.map(function (c) {
            return '<tr data-copia="' + h(c.nome) + '" title="' + h(c.nome) + '"><td><span class="sis-quando">' + h(dataBreve(c.data)) + '</span>' +
              (c.seconda ? ' <span class="sis-seconda-segno" title="Anche nella seconda cartella" aria-label="anche nella seconda cartella">⧉</span>' : '') + '</td>' +
              '<td><span class="sis-cosa">' + h(FILE_COPIA[c.prefisso] || c.prefisso) + '</span><span class="sis-tipo">' + h(TIPI_COPIA[c.tipo] || c.tipo) + '</span></td>' +
              '<td class="n sis-largo">' + h(App.fmtDimensione(c.dimensione)) + '</td><td>' + verifica(c) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
        if (copie.length > RIGHE_COPIE) {
          corpo += '<div class="sis-altro"><button class="btn piccolo" type="button" id="sis-copie-tutte" aria-expanded="' + tutteLeCopie + '">' +
            (tutteLeCopie ? 'Mostra solo le più recenti' : 'Mostra tutte le ' + copie.length + ' copie') + '</button></div>';
        }
      }
      corpo += '<p class="piccolo tenue sis-nota">Il programma tiene tutte le copie delle ultime 24 ore, poi una al giorno per 14 giorni, una alla settimana per 8 settimane e una al mese per un anno. Le copie fatte a mano restano (ultime 30). ' +
        (App.puo('backup') ? 'Per scaricare o ripristinare una copia del magazzino vai in <a href="#configura">Configura</a>.' : '') + '</p>';
      el('sis-copie').innerHTML = corpo;
      var b = el('sis-copie-tutte');
      if (b) b.addEventListener('click', function () { tutteLeCopie = !tutteLeCopie; disegnaCopie(); var n = el('sis-copie-tutte'); if (n) n.focus(); });
    }

    /* ---------- controlli e cure ---------- */

    function voceControllo(c) {
      var file = c.file || {};
      var danni = Object.keys(file).filter(function (k) { return file[k].esito === 'danneggiato' || file[k].esito === 'mancante'; });
      var nuovi = Object.keys(file).filter(function (k) { return file[k].esito === 'nuovo'; });
      var ok = c.esito === 'ok';
      var testo = ok ? (nuovi.length === Object.keys(file).length && nuovi.length ? 'archivio nuovo' : 'magazzino e utenti integri')
        : danni.map(function (k) { return k + '.db ' + (file[k].esito === 'mancante' ? 'mancante' : 'danneggiato'); }).join(', ');
      return {
        quando: c.quando, livello: ok ? 'ok' : 'problema', titolo: (TIPI_CONTROLLO[c.tipo] || 'Controllo') + ': ' + (ok ? 'tutto in ordine' : 'trovato un danno'),
        dettaglio: testo + (c.durataMs !== undefined ? ' · ' + durata(c.durataMs) : '')
      };
    }

    function voceCura(c) {
      var buona = c.esito === 'curato';
      return {
        quando: c.quando, livello: buona ? 'cura' : 'problema',
        titolo: 'Cura di ' + c.file + (buona ? ': nessun dato perso' : c.esito === 'curato-con-perdite' ? ': qualche dato perso' : ': ripartito da vuoto'),
        dettaglio: c.messaggio || ''
      };
    }

    function disegnaCronologia() {
      var voci = (stato.controlli || []).map(voceControllo).concat((stato.cure || []).map(voceCura))
        .sort(function (a, b) { return a.quando < b.quando ? 1 : a.quando > b.quando ? -1 : 0; });
      var mostrate = tuttaLaCronologia ? voci : voci.slice(0, RIGHE_CRONOLOGIA);
      var html = voci.length ? '<ol class="sis-cronologia">' + mostrate.map(function (v) {
        return '<li class="' + v.livello + '"><span class="sis-punto" aria-hidden="true"></span><div><p class="sis-voce-titolo">' + h(v.titolo) + '</p>' +
          '<p class="piccolo tenue"><time datetime="' + h(v.quando) + '">' + h(App.fmtDataOra(v.quando)) + '</time>' + (v.dettaglio ? ' · ' + h(v.dettaglio) : '') + '</p></div></li>';
      }).join('') + '</ol>' : '<p class="tenue piccolo">Ancora nessun controllo.</p>';
      if (voci.length > RIGHE_CRONOLOGIA) {
        html += '<div class="sis-altro"><button class="btn piccolo" type="button" id="sis-cronologia-tutta" aria-expanded="' + tuttaLaCronologia + '">' +
          (tuttaLaCronologia ? 'Mostra solo gli ultimi' : 'Mostra tutto (' + voci.length + ')') + '</button></div>';
      }
      html += '<p class="piccolo tenue sis-nota">Controllo rapido a ogni avvio, controllo completo ogni notte. Se un file si rovina, il programma lo cura da solo e lo scrive qui e nel <a href="#attivita">registro attività</a>.</p>';
      el('sis-cronologia').innerHTML = html;
      var b = el('sis-cronologia-tutta');
      if (b) b.addEventListener('click', function () { tuttaLaCronologia = !tuttaLaCronologia; disegnaCronologia(); var n = el('sis-cronologia-tutta'); if (n) n.focus(); });
    }

    /* ---------- prova di ripristino ---------- */

    function disegnaProva() {
      var p = stato.provaRipristino;
      var box = el('sis-prova-esito');
      if (!p) {
        box.innerHTML = '<p>Non è ancora stata fatta. La prova ricostruisce i dati <b>per finta</b>, in una cartella temporanea, partendo dall’ultima copia e dal giornale delle modifiche, ' +
          'poi li confronta con quelli veri. I dati veri non cambiano.</p><p class="piccolo tenue sis-nota">Premi <b>Prova di ripristino</b> in alto: ci vogliono pochi secondi.</p>';
        return;
      }
      var ok = p.esito === 'ok';
      var html = '<div class="sis-prova-testa ' + (ok ? 'ok' : 'pericolo') + '"><span class="etichetta ' + (ok ? 'ok' : 'pericolo') + '">' + (ok ? '✓ La cura funzionerebbe' : '✕ Differenze') + '</span>' +
        '<span class="piccolo tenue">' + h(App.fmtDataOra(p.quando)) + ' · ' + h(durata(p.durataMs)) + '</span></div>' +
        '<p>' + (p.copia ? 'Partendo dalla copia del <b>' + h(App.fmtDataOra(p.copiaData)) + '</b> e riapplicando <b>' + App.fmtNum(p.riapplicate) + '</b> ' + (p.riapplicate === 1 ? 'modifica' : 'modifiche') + ' dal giornale, ' : '') +
        (ok ? 'si ottengono <b>esattamente</b> i dati di adesso.' : 'i dati ricostruiti non coincidono con quelli di adesso.') + '</p>';
      (p.messaggi || []).concat(p.avvisi || []).forEach(function (m) { html += '<p class="piccolo sis-rosso">' + h(m) + '</p>'; });
      html += '<div class="tabella-contenitore"><table class="tabella sis-tabella-prova"><thead><tr><th scope="col">Dati</th><th scope="col" class="n">Adesso</th><th scope="col" class="n">Ricostruiti</th><th scope="col">Uguali</th></tr></thead><tbody>' +
        (p.tabelle || []).map(function (t) {
          return '<tr><td>' + h(NOMI_TABELLE[t.tabella] || t.tabella) + '</td><td class="n">' + App.fmtNum(t.attuale.righe) + '</td><td class="n">' + App.fmtNum(t.ricostruita.righe) + '</td>' +
            '<td>' + (t.uguale ? '<span class="sis-verde" aria-label="sì">✓</span>' : '<span class="sis-rosso" aria-label="no">✕</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<p class="piccolo tenue sis-nota">Il confronto guarda righe, revisioni e quantità di ogni tabella. I dati veri non sono stati toccati.</p>';
      box.innerHTML = html;
    }

    /* ---------- seconda cartella ---------- */

    function disegnaSeconda() {
      var s = stato.secondaCartella || {};
      var fissa = !!stato.secondaDaConfigurazione;
      var box = el('sis-seconda');
      var attivo = document.activeElement;
      var scritto = attivo && attivo.id === 'sis-seconda-percorso' ? attivo.value : null;
      var stato2 = '';
      if (s.percorso) {
        if (s.raggiungibile === true) stato2 = '<p class="sis-seconda-stato ok"><span class="etichetta ok">✓ Raggiungibile</span> <span class="piccolo tenue">ultimo aggiornamento ' + h(quandoFa(s.ultimaSincronizzazione)) + '</span></p>';
        else if (s.raggiungibile === false) stato2 = '<p class="sis-seconda-stato"><span class="etichetta attenzione">Non raggiungibile</span> <span class="piccolo">' + h(s.errore || '') + '</span></p>' +
          '<p class="piccolo tenue">Non è un errore grave: le copie restano nella cartella dati. Controlla che il disco sia collegato o che la cartella di rete sia accessibile; il programma riprova da solo ogni 5 minuti.</p>';
        else stato2 = '<p class="sis-seconda-stato"><span class="etichetta">In prova…</span></p>';
      }
      box.innerHTML =
        '<p>Per sicurezza in più, le copie verificate e il giornale delle modifiche si possono mettere <b>anche su un altro disco</b> (per esempio un disco esterno o una cartella di rete). ' +
        'Se il disco del server si rompe, i dati si recuperano da lì.</p>' +
        (fissa
          ? '<p class="piccolo">Cartella scritta nel file <span class="mono">configurazione.json</span> della cartella dati: <b class="mono sis-percorso">' + h(s.percorso) + '</b>. Si cambia in quel file.</p>'
          : '<form class="sis-seconda-modulo" id="sis-seconda-modulo" novalidate><label class="campo"><span>Percorso completo della cartella</span>' +
            '<input id="sis-seconda-percorso" class="mono" autocomplete="off" spellcheck="false" placeholder="E:\\CopieFarmacia oppure \\\\server\\condivisa\\Farmacia" value="' + h(scritto !== null ? scritto : s.percorso || '') + '"></label>' +
            '<div class="strumenti"><button class="btn primario" type="submit" id="sis-seconda-salva">Salva e prova</button>' +
            (s.percorso ? '<button class="btn" type="button" id="sis-seconda-togli">Non usarla più</button>' : '') + '</div></form>') +
        stato2;
      if (fissa) return;
      el('sis-seconda-modulo').addEventListener('submit', function (e) {
        e.preventDefault();
        salvaSeconda(el('sis-seconda-percorso').value.trim());
      });
      var togli = el('sis-seconda-togli');
      if (togli) togli.addEventListener('click', function () { salvaSeconda(''); });
      if (scritto !== null) { var i = el('sis-seconda-percorso'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
    }

    function salvaSeconda(percorso) {
      var b = el('sis-seconda-salva');
      if (b) { b.disabled = true; b.textContent = percorso ? 'Provo a scrivere…' : 'Salvo…'; b.setAttribute('aria-busy', 'true'); }
      api().richiesta('PUT', '/api/sistema/seconda-cartella', { percorso: percorso }).then(function (r) {
        stato = r.sistema;
        disegna();
        var s = r.seconda || {};
        if (!percorso) App.avviso('Seconda cartella tolta: le copie restano solo nella cartella dati.', 'ok');
        else if (s.raggiungibile) App.avviso('Seconda cartella salvata: copie e giornale sono anche lì.', 'ok');
        else App.avviso('Seconda cartella salvata, ma adesso non è raggiungibile: ' + (s.errore || '') + '. Il programma riprova da solo.', 'errore');
      }, function (e) {
        App.avviso(messaggio(e), 'errore');
        if (b) { b.disabled = false; b.textContent = 'Salva e prova'; b.removeAttribute('aria-busy'); }
      });
    }

    carica();
  };

  /* Spiegazione per chi non è informatico. */
  function spiegazione() {
    return '<div class="sis-come">' +
      '<div><h3>Controlli</h3><p>A ogni avvio il programma controlla in pochi istanti che i file dei dati siano sani; ogni notte fa un controllo completo e li riordina perché restino veloci.</p></div>' +
      '<div><h3>Giornale delle modifiche</h3><p>Ogni registrazione (un carico, un consumo, un DDT…) viene scritta subito anche in un quaderno a parte, il <b>giornale</b>, che resta sul disco anche se manca la corrente.</p></div>' +
      '<div><h3>Copie verificate</h3><p>Ogni ora, se qualcuno ha lavorato, il programma copia magazzino e utenti e <b>riapre la copia</b> per controllare che sia buona. Una copia che non passa il controllo è segnata in rosso.</p></div>' +
      '<div><h3>Se un file si rovina</h3><p>All’avvio il file rovinato si mette da parte (cartella <span class="mono">danneggiati</span>), si riprende l’ultima copia buona e si rifanno sopra le modifiche del giornale: si riparte <b>senza perdere niente</b>.</p></div>' +
      '<div><h3>Prova di ripristino</h3><p>Fa la stessa ricostruzione per finta e la confronta con i dati veri. Se dice “La cura funzionerebbe”, in caso di guasto i dati tornerebbero tutti.</p></div>' +
      '<div><h3>Seconda cartella</h3><p>Copie e giornale anche su un altro disco o in rete: protegge anche dal guasto del disco del server.</p></div>' +
      '</div>';
  }
})(window);
