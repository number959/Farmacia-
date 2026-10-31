/*
 * Lettore di codici a barre nell'interfaccia (window.Scanner).
 *
 * - Lettori USB o Bluetooth (emulazione tastiera): scrivono il codice in una raffica di tasti velocissima
 *   (pochi millisecondi tra un tasto e l'altro) e finiscono con Invio o Tab. La raffica si riconosce ovunque,
 *   anche con il cursore in un altro campo: i caratteri letti non restano nel campo (torna il valore di prima)
 *   e l'Invio non arriva alla pagina. Chi scrive a mano non è mai così veloce, quindi non viene scambiato per un lettore.
 * - Campo di lettura (#scanner-campo) nella barra in cima alle pagine dove si registra: si legge o si scrive il codice e Invio.
 * - Fotocamera (telefono o tablet, BarcodeDetector in un contesto sicuro).
 *
 * Il codice letto si analizza con js/barcode.js e si cerca l'articolo che ha quella chiave. Poi:
 * - se la pagina ha impostato App.gestoreScansione(info, articolo, passo), la pagina lo usa (carico, consumi, …);
 * - altrimenti si apre la scheda dell'articolo;
 * - codice sconosciuto: finestra "Codice non riconosciuto" (associa a un articolo o crea un articolo nuovo).
 */
(function (root) {
  'use strict';

  var App = root.App;
  var h = App.h;

  /* ---------- riconoscimento delle raffiche ---------- */
  var GAP_MAX = 60;       // ms: un intervallo più lungo tra due tasti non fa parte della stessa raffica
  var MEDIA_MAX = 35;     // ms: intervallo medio massimo tra i tasti di un lettore
  var INVIO_MAX = 150;    // ms: l'Invio (o il Tab) deve arrivare subito dopo l'ultimo carattere
  var MIN_CARATTERI = 4;  // i codici più corti non si considerano letture
  var DOPPIO_FINE = 80;   // ms: un secondo Invio/Tab subito dopo una lettura (lettori con suffisso CR+LF) non arriva alla pagina

  var FORMATI = ['data_matrix', 'ean_13', 'ean_8', 'code_39', 'code_128', 'upc_a', 'qr_code'];
  var GS = '\x1D';

  var Scanner = {};
  var cattura = null;   // { fn, el }: una finestra che riceve le letture (per esempio il modulo dell'articolo)
  var raffica = null;   // raffica di tasti in corso
  var fineLettura = -1e9; // momento dell'Invio (o Tab) che ha chiuso l'ultima lettura

  function attivo() {
    return !!(App.S && App.utente && !(root.Accesso && root.Accesso.visibile && root.Accesso.visibile()));
  }

  /* ---------- preferenze per pagina ---------- */
  function chiaveModo(pagina) { return 'gf-scanner-modo:' + (pagina || ''); }

  function leggiModo(pagina) {
    try { return root.localStorage.getItem(chiaveModo(pagina)) || ''; } catch (e) { return ''; }
  }

  function salvaModo(pagina, modo) {
    try { root.localStorage.setItem(chiaveModo(pagina), modo); } catch (e) { /* memoria del browser non disponibile */ }
  }

  /* ---------- suoni (WebAudio) ---------- */
  var audio = null;

  /*
   * Contesto audio, creato o riattivato al primo uso. Va chiamato anche durante un clic o un tasto (per esempio
   * all'apertura della fotocamera): i telefoni lasciano suonare solo un contesto nato o riattivato così, e le letture
   * della fotocamera arrivano fuori da un clic.
   */
  function contestoAudio() {
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    if (!audio) audio = new AC();
    if (audio.state === 'suspended' && audio.resume) { var p = audio.resume(); if (p && p.catch) p.catch(function () { /* resta muto */ }); }
    return audio;
  }

  Scanner.suono = function (tipo) {
    try {
      if (!contestoAudio()) return;
      // [frequenza, inizio, durata] in secondi
      var note = tipo === 'ok' ? [[1250, 0, 0.09]]
        : tipo === 'sconosciuto' ? [[740, 0, 0.12], [520, 0.15, 0.18]]
          : [[260, 0, 0.28]];
      var t0 = audio.currentTime + 0.01;
      note.forEach(function (n) {
        var osc = audio.createOscillator();
        var vol = audio.createGain();
        osc.type = tipo === 'errore' ? 'square' : 'sine';
        osc.frequency.value = n[0];
        vol.gain.setValueAtTime(0.0001, t0 + n[1]);
        vol.gain.exponentialRampToValueAtTime(tipo === 'errore' ? 0.08 : 0.18, t0 + n[1] + 0.012);
        vol.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
        osc.connect(vol);
        vol.connect(audio.destination);
        osc.start(t0 + n[1]);
        osc.stop(t0 + n[1] + n[2] + 0.03);
      });
    } catch (e) { /* niente audio: resta l'avviso scritto */ }
  };

  /* ---------- messaggi ---------- */
  function ultima(testo, tipo) {
    var el = document.querySelector('#contenuto .scanner-ultima');
    if (!el) return;
    el.textContent = testo;
    el.className = 'scanner-ultima ' + (tipo || '');
  }

  function segnala(testo, tipo) {
    Scanner.suono(tipo === 'ok' ? 'ok' : 'errore');
    App.avviso(testo, tipo || 'errore');
    ultima(testo, tipo || 'errore');
  }

  /* ---------- barra di lettura ---------- */

  Scanner.fotocameraDisponibile = function () {
    return !!(root.BarcodeDetector && root.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  };

  var ICONA = '<svg class="scanner-ico" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 5h2v14H3zM6 5h1v14H6zM9 5h2v14H9zM12 5h1v14h-1zM15 5h1v14h-1zM17 5h2v14h-2zM20 5h1v14h-1z" fill="currentColor"/></svg>';

  /*
   * HTML della barra di lettura da mettere in cima alla pagina.
   * opz: { pagina, predefinito: 'unita'|'confezione' } (la scelta dell'utente si ricorda per pagina)
   */
  Scanner.barra = function (opz) {
    opz = opz || {};
    var pagina = opz.pagina || App.paginaCorrente;
    var modo = leggiModo(pagina) || opz.predefinito || 'unita';
    if (modo !== 'unita' && modo !== 'confezione') modo = 'unita';
    return '<div class="barra-scanner" data-pagina="' + h(pagina) + '">' + ICONA +
      '<label class="scanner-campo"><span class="scanner-nascosto">Codice a barre</span>' +
      '<input id="scanner-campo" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="done" placeholder="Leggi un codice a barre…"></label>' +
      '<label class="scanner-modo"><span>Ogni lettura vale</span><select id="scanner-modo">' +
      '<option value="unita"' + (modo === 'unita' ? ' selected' : '') + '>1 unità</option>' +
      '<option value="confezione"' + (modo === 'confezione' ? ' selected' : '') + '>1 confezione</option></select></label>' +
      (Scanner.fotocameraDisponibile() ? '<button class="btn" type="button" id="scanner-fotocamera" title="Leggi il codice con la fotocamera" aria-label="Leggi il codice con la fotocamera">📷 <span>Fotocamera</span></button>' : '') +
      '<span class="scanner-aiuto">' + h(opz.aiuto || 'Usa il lettore in qualsiasi momento, anche con il cursore in un altro campo; oppure scrivi il codice qui e premi Invio.') + '</span>' +
      '<span class="scanner-ultima" aria-live="polite"></span>' +
      '</div>';
  };

  /* Collega gli eventi della barra disegnata con Scanner.barra dentro il contenitore della pagina. */
  Scanner.collega = function (cont) {
    var barra = cont && cont.querySelector('.barra-scanner');
    if (!barra) return;
    var pagina = barra.getAttribute('data-pagina');
    var campo = barra.querySelector('#scanner-campo');
    campo.addEventListener('keydown', function (e) {
      // codice scritto a mano: le letture del lettore le intercetta prima il riconoscimento delle raffiche (suTasto)
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var testo = campo.value;
      campo.value = '';
      if (testo.trim()) Scanner.elabora(testo, 'campo');
    });
    var modo = barra.querySelector('#scanner-modo');
    modo.addEventListener('change', function () { salvaModo(pagina, modo.value); });
    var foto = barra.querySelector('#scanner-fotocamera');
    if (foto) foto.addEventListener('click', function () { Scanner.apriFotocamera(); });
  };

  /* Quantità per lettura: 1 unità, oppure i pezzi di una confezione dell'articolo (secondo #scanner-modo). */
  Scanner.passo = function (articolo) {
    var sel = document.getElementById('scanner-modo');
    var modo = sel ? sel.value : (leggiModo(App.paginaCorrente) || 'unita');
    if (modo !== 'confezione') return 1;
    var p = Number(articolo && articolo.pezziConfezione);
    return p > 0 ? p : 1;
  };

  /* Articolo che ha una delle chiavi del codice letto, oppure null. */
  Scanner.trova = function (info) {
    var chiavi = (info && info.chiavi) || [];
    if (!chiavi.length || !App.S) return null;
    return App.S.articoli.filter(function (a) {
      return (a.barcode || []).some(function (k) { return chiavi.indexOf(k) >= 0; });
    })[0] || null;
  };

  /* Riga (o elemento) appena toccata da una lettura: evidenziata e portata in vista se non si vede. */
  Scanner.evidenzia = function (el) {
    if (!el) return;
    el.classList.remove('scanner-evidenziata');
    void el.offsetWidth; // fa ripartire l'animazione
    el.classList.add('scanner-evidenziata');
    setTimeout(function () { el.classList.remove('scanner-evidenziata'); }, 1800);
    var r = el.getBoundingClientRect();
    var testa = document.querySelector('.testa-fissa');
    var alto = testa ? testa.getBoundingClientRect().bottom : 0;
    if (r.top < alto + 6 || r.bottom > root.innerHeight - 6) el.scrollIntoView({ block: 'center' });
  };

  /* Una finestra (per esempio il modulo dell'articolo) riceve le letture finché l'elemento el è nella pagina. */
  Scanner.cattura = function (fn, el) { cattura = { fn: fn, el: el }; };
  Scanner.rilascia = function (el) { if (cattura && (!el || cattura.el === el)) cattura = null; };

  function catturaAttiva() {
    if (cattura && cattura.el && cattura.el.isConnected) return cattura;
    cattura = null;
    return null;
  }

  /* ---------- cosa fare con un codice letto ---------- */

  function descrizioneLetto(info) {
    var parti = [];
    if (info.lotto) parti.push('lotto ' + info.lotto);
    if (info.scadenza) parti.push('scad. ' + App.fmtScadenza(info.scadenza));
    return parti.length ? ' · ' + parti.join(' · ') : '';
  }

  function applica(info, articolo) {
    var gestore = App.gestoreScansione;
    if (typeof gestore !== 'function') {
      // pagine di consultazione: la lettura apre la scheda dell'articolo
      Scanner.suono('ok');
      App.schedaArticolo(articolo.id);
      var m = document.getElementById('modale');
      if (!m.hidden) m.classList.add('da-lettura');
      ultima('Letto: ' + articolo.nome, 'ok');
      return;
    }
    if (articolo.attivo === false) {
      segnala('«' + articolo.nome + '» non è attivo: per registrarlo riattivalo da Articoli.', 'errore');
      return;
    }
    var passo = Scanner.passo(articolo);
    var esito;
    try {
      esito = gestore(info, articolo, passo);
    } catch (e) {
      segnala('Lettura non registrata: ' + (e && e.message ? e.message : e), 'errore');
      return;
    }
    if (esito === false) { Scanner.suono('errore'); return; }
    var testo = typeof esito === 'string' ? esito : 'Letto: ' + articolo.nome + ' (+' + App.fmtNum(passo) + ')';
    Scanner.suono('ok');
    App.avviso(testo, 'ok');
    ultima(testo, 'ok');
  }

  /*
   * Codice letto (dal lettore, dal campo di lettura o dalla fotocamera).
   * origine: 'lettore' | 'campo' | 'fotocamera' (solo informativa).
   */
  Scanner.elabora = function (testo, origine) {
    if (!attivo()) return;
    var info = root.Barcode.analizza(testo);
    info.origine = origine || '';
    if (!info.grezzo) return;
    var c = catturaAttiva();
    if (c) { c.fn(info); return; }
    // ricerca rapida aperta: si chiude, il codice letto vale come ricerca
    var ric = document.getElementById('ricerca');
    if (ric && !ric.hidden) {
      ric.hidden = true;
      if (document.getElementById('modale').hidden) document.getElementById('velo').hidden = true;
    }
    var m = document.getElementById('modale');
    if (!m.hidden) {
      // la finestra aperta da una lettura precedente (scheda, codice sconosciuto) lascia il posto alla nuova lettura
      if (m.classList.contains('da-lettura')) App.chiudiModale();
      else { segnala('Chiudi prima la finestra aperta, poi leggi di nuovo il codice.', 'errore'); return; }
    }
    if (!info.chiavi.length) {
      segnala('Il codice letto non identifica un prodotto: leggi il codice a barre della confezione.', 'errore');
      return;
    }
    var articolo = Scanner.trova(info);
    if (!articolo) { sconosciuto(info); return; }
    applica(info, articolo);
  };

  /* ---------- codice non riconosciuto ---------- */

  function sconosciuto(info) {
    Scanner.suono('sconosciuto');
    var chiave = info.chiavi[0];
    var puo = App.puo('articoli');
    ultima('Codice non riconosciuto: ' + root.Barcode.descrivi(chiave), 'errore');
    var dettagli = '<dl class="scanner-letto">' +
      '<div><dt>Codice</dt><dd class="mono">' + h(root.Barcode.descrivi(chiave)) + '</dd></div>' +
      (info.lotto ? '<div><dt>Lotto</dt><dd class="mono">' + h(info.lotto) + '</dd></div>' : '') +
      (info.scadenza ? '<div><dt>Scadenza</dt><dd>' + h(App.fmtScadenza(info.scadenza)) + '</dd></div>' : '') +
      '</dl>';
    App.apriModale({
      titolo: 'Codice non riconosciuto',
      corpo: '<p>Il codice letto non è associato a nessun articolo.</p>' + dettagli +
        (puo
          ? '<label class="campo"><span>Di quale articolo si tratta? Scrivi il nome e sceglilo: da ora in poi il codice lo riconosco.</span>' +
            '<input id="sc-cerca" type="search" autocomplete="off" spellcheck="false" placeholder="Nome, principio attivo, codice…"></label>' +
            '<ul class="scanner-scelte" id="sc-scelte"></ul>'
          : '<p class="tenue">Chiedi alla farmacia di associare questo codice all’articolo giusto: poi la lettura funzionerà anche per te.</p>'),
      piede: puo
        ? '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="sc-nuovo">+ Nuovo articolo con questo codice</button>'
        : '<button class="btn primario" type="button" data-chiudi>Chiudi</button>',
      dopo: function (m) {
        m.classList.add('da-lettura');
        if (!puo) return;
        var cerca = m.querySelector('#sc-cerca');
        var ul = m.querySelector('#sc-scelte');
        var trovati = [];
        function elenca() {
          var t = cerca.value.trim().toLowerCase();
          if (!t) {
            trovati = [];
            ul.innerHTML = '<li class="tenue piccolo">Scrivi qualche lettera del nome per cercare l’articolo.</li>';
            return;
          }
          trovati = App.articoliAttivi().filter(function (a) {
            return (a.nome + ' ' + (a.principio || '') + ' ' + (a.codice || '')).toLowerCase().indexOf(t) >= 0;
          }).sort(function (x, y) {
            return (x.nome.toLowerCase().indexOf(t) === 0 ? 0 : 1) - (y.nome.toLowerCase().indexOf(t) === 0 ? 0 : 1) || x.nome.localeCompare(y.nome, 'it');
          }).slice(0, 8);
          ul.innerHTML = trovati.length ? trovati.map(function (a) {
            var n = (a.barcode || []).length;
            return '<li><button type="button" class="scanner-scelta" data-art="' + h(a.id) + '"><b>' + h(a.nome) + '</b>' +
              '<span class="tenue piccolo">' + (a.categoria === 'PRESIDI' ? 'Presidio' : 'Farmaco') + (a.confezione ? ' · ' + h(a.confezione) : '') +
              (n ? ' · ' + n + (n === 1 ? ' codice già associato' : ' codici già associati') : '') + '</span></button></li>';
          }).join('') : '<li class="tenue piccolo">Nessun articolo trovato: crealo con “Nuovo articolo con questo codice”.</li>';
        }
        function associa(id, bottone) {
          var a = App.articolo(id);
          if (!a) return;
          if (bottone) bottone.disabled = true;
          root.Api.scrivi('POST', '/api/articoli/' + encodeURIComponent(id) + '/barcode', { chiave: chiave }).then(function (r) {
            App.chiudiModale();
            var art = App.articolo(id) || (r && r.articolo) || a;
            App.avviso('Codice ' + root.Barcode.descrivi(chiave) + ' associato a ' + art.nome, 'ok');
            applica(info, art);
          }, function (e) {
            if (bottone && bottone.isConnected) bottone.disabled = false;
            Scanner.suono('errore');
            App.avviso('Codice non associato: ' + (e && e.message ? e.message : e), 'errore');
          });
        }
        cerca.addEventListener('input', elenca);
        cerca.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); if (trovati[0]) associa(trovati[0].id, null); }
        });
        ul.addEventListener('click', function (e) {
          var b = e.target.closest('[data-art]');
          if (b) associa(b.getAttribute('data-art'), b);
        });
        m.querySelector('#sc-nuovo').addEventListener('click', function () {
          App.chiudiModale();
          App.formArticolo(null, function (id) {
            var art = App.articolo(id);
            if (art) applica(info, art);
          }, { barcode: [chiave], codice: info.aic || '' });
        });
        elenca();
      }
    });
  }

  /* ---------- fotocamera ---------- */
  var foto = null; // { finestra, video, stream, timer, chiusa, … }

  function chiudiFotocamera() {
    var f = foto;
    foto = null;
    if (!f) return;
    f.chiusa = true;
    clearTimeout(f.timer);
    if (f.stream) f.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* già ferma */ } });
    if (f.video) { try { f.video.pause(); } catch (e) { /* niente */ } f.video.srcObject = null; }
    if (f.finestra && f.finestra.parentNode) f.finestra.parentNode.removeChild(f.finestra);
    if (f.ritornaA && f.ritornaA.isConnected) { try { f.ritornaA.focus(); } catch (e) { /* niente */ } }
  }
  Scanner.chiudiFotocamera = chiudiFotocamera;
  Scanner.fotocameraAperta = function () { return !!foto; };

  /*
   * Finestra con l'anteprima della fotocamera posteriore. Alla prima lettura valida si chiude,
   * oppure resta aperta con "Lettura continua". opz.alLeggere(testo): chi riceve il codice (predefinito: Scanner.elabora).
   */
  Scanner.apriFotocamera = function (opz) {
    opz = opz || {};
    if (!Scanner.fotocameraDisponibile()) {
      segnala('La lettura con la fotocamera non è disponibile in questo browser (serve Chrome o Edge su telefono o tablet, con indirizzo https).', 'errore');
      return;
    }
    chiudiFotocamera();
    try { contestoAudio(); } catch (e) { /* niente audio */ }
    var finestra = document.createElement('div');
    finestra.className = 'scanner-fotocamera';
    finestra.setAttribute('role', 'dialog');
    finestra.setAttribute('aria-modal', 'true');
    finestra.setAttribute('aria-label', 'Leggi il codice con la fotocamera');
    finestra.innerHTML = '<div class="scanner-foto-scheda">' +
      '<div class="scanner-foto-testa"><h2>📷 Leggi con la fotocamera</h2><button class="btn fantasma" type="button" data-foto-chiudi aria-label="Chiudi">✕</button></div>' +
      '<div class="scanner-foto-video"><video muted playsinline autoplay></video><div class="scanner-mirino" aria-hidden="true"></div></div>' +
      '<p class="scanner-foto-stato" aria-live="polite">Avvio la fotocamera…</p>' +
      '<div class="scanner-foto-piede"><label class="spunta"><input type="checkbox" id="scanner-continua"' + (opz.continua ? ' checked' : '') + '> Lettura continua (per caricare molte confezioni)</label>' +
      '<span class="spazio"></span><button class="btn primario" type="button" data-foto-chiudi>Fine</button></div></div>';
    document.body.appendChild(finestra);
    var f = foto = {
      finestra: finestra,
      video: finestra.querySelector('video'),
      stato: finestra.querySelector('.scanner-foto-stato'),
      continua: finestra.querySelector('#scanner-continua'),
      stream: null, timer: null, chiusa: false, visti: {}, letture: 0,
      ritornaA: document.activeElement
    };
    finestra.querySelectorAll('[data-foto-chiudi]').forEach(function (b) { b.addEventListener('click', chiudiFotocamera); });
    finestra.addEventListener('click', function (e) { if (e.target === finestra) chiudiFotocamera(); });
    setTimeout(function () { var b = finestra.querySelector('.scanner-foto-piede .btn'); if (b && !f.chiusa) b.focus(); }, 30);

    var alLeggere = opz.alLeggere || function (testo) {
      // se la lettura apre una finestra (scheda, codice sconosciuto) la fotocamera si chiude, altrimenti la coprirebbe
      // (un codice senza chiave dà solo un avviso: con la lettura continua la fotocamera resta aperta)
      var info = root.Barcode.analizza(testo);
      var apreFinestra = info.chiavi.length > 0 && (!Scanner.trova(info) || typeof App.gestoreScansione !== 'function');
      if (!catturaAttiva() && apreFinestra) chiudiFotocamera();
      Scanner.elabora(testo, 'fotocamera');
    };

    var formati = root.BarcodeDetector.getSupportedFormats ? root.BarcodeDetector.getSupportedFormats() : Promise.resolve(FORMATI);
    Promise.resolve(formati).then(function (supportati) {
      var usati = FORMATI.filter(function (x) { return !supportati || supportati.indexOf(x) >= 0; });
      if (!usati.length) throw new Error('questo dispositivo non legge i codici dei farmaci');
      f.rivelatore = new root.BarcodeDetector({ formats: usati });
      // risoluzione più alta della predefinita (640×480): i Data Matrix delle confezioni sono piccoli
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    }).then(function (stream) {
      if (f.chiusa) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      f.stream = stream;
      f.video.srcObject = stream;
      var p = f.video.play();
      if (p && p.catch) p.catch(function () { /* parte da sola con autoplay */ });
      f.stato.textContent = 'Inquadra il codice a barre o il Data Matrix della confezione.';
      cerca();
    }).catch(function (e) {
      if (f.chiusa) return;
      var motivo = e && e.name === 'NotAllowedError' ? 'il permesso di usare la fotocamera è stato negato'
        : e && e.name === 'NotFoundError' ? 'non trovo nessuna fotocamera'
          : (e && e.message) || String(e);
      f.stato.textContent = 'Non riesco a usare la fotocamera: ' + motivo + '.';
      f.stato.classList.add('errore');
    });

    // tra i codici inquadrati insieme: quello di un articolo conosciuto, poi un GS1 con il GTIN, poi un AIC, un EAN…
    function migliore(lista) {
      var PESO = { gs1: 3, aic: 2, ean: 1, altro: 0 };
      var voti = lista.map(function (c) {
        var info = root.Barcode.analizza(c);
        return { c: c, v: (info.chiavi.length ? 10 : 0) + (Scanner.trova(info) ? 100 : 0) + (PESO[info.tipo] || 0) };
      });
      voti.sort(function (x, y) { return y.v - x.v; });
      return voti[0].c;
    }

    function cerca() {
      if (f.chiusa) return;
      if (!App.utente) { chiudiFotocamera(); return; }
      if (f.video.readyState < 2) { f.timer = setTimeout(cerca, 150); return; }
      f.rivelatore.detect(f.video).then(function (codici) {
        if (f.chiusa) return;
        var adesso = Date.now();
        var visti = (codici || []).map(function (c) { return c && c.rawValue; }).filter(Boolean);
        if (visti.length) {
          // Una confezione conta una volta sola finché resta inquadrata, anche se ha due codici (per esempio il
          // Code 32 e il Data Matrix) che il rivelatore restituisce ora uno ora l'altro, in ordine diverso:
          // è una lettura nuova solo se nessuno dei codici inquadrati si è visto nell'ultimo secondo.
          // Così lo stesso codice si conta di nuovo solo dopo che è uscito dall'inquadratura (più confezioni uguali).
          var giaVisto = visti.some(function (c) { return adesso - (f.visti[c] || -1e9) <= 1200; });
          Object.keys(f.visti).forEach(function (c) { if (adesso - f.visti[c] > 5000) delete f.visti[c]; });
          visti.forEach(function (c) { f.visti[c] = adesso; });
          if (!giaVisto) {
            var codice = migliore(visti);
            f.letture++;
            if (!f.continua.checked) chiudiFotocamera();
            else f.stato.textContent = 'Letto (' + f.letture + '): ' + root.Barcode.leggibile(codice) + ' — inquadra la confezione successiva.';
            alLeggere(codice);
          }
        }
        if (!f.chiusa) f.timer = setTimeout(cerca, 120);
      }, function () {
        if (!f.chiusa) f.timer = setTimeout(cerca, 300);
      });
    }
  };

  /* ---------- lettori USB o Bluetooth: raffiche di tasti ---------- */

  var TIPI_TESTO = ['text', 'search', 'number', 'tel', 'url', 'email', 'date', 'month', 'week', 'time', 'datetime-local'];

  // campo in cui i caratteri si scrivono: la raffica passa e alla fine si ripristina il valore
  function campoTesto(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TIPI_TESTO.indexOf(String(el.type || 'text').toLowerCase()) >= 0;
  }

  function campoPassword(el) {
    return !!el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password';
  }

  /*
   * Carattere del tasto (null = non è un carattere che un lettore scrive).
   * Il separatore GS dei codici GS1 arriva come Ctrl+] (tasto BracketRight, che sulla tastiera italiana è il "+"):
   * vale come GS solo dentro una raffica già iniziata, così Ctrl e + (ingrandimento della pagina) resta libero.
   */
  function carattere(e, inRaffica) {
    if (e.key === 'GroupSeparator' || e.key === GS) return GS;
    var altGr = e.getModifierState && e.getModifierState('AltGraph');
    if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === ']' || e.code === 'BracketRight')) return inRaffica ? GS : null;
    if ((e.ctrlKey || e.altKey || e.metaKey) && !altGr) return null;
    return e.key && e.key.length === 1 ? e.key : null;
  }

  function valoreDi(el) {
    return el.isContentEditable ? el.textContent : el.value;
  }

  function nuovaRaffica(el, t) {
    var r = { el: el, modo: campoTesto(el) ? 'testo' : 'trattieni', caratteri: '', tempi: [], ultimo: t, trattenuti: [], foto: null, timer: null };
    if (r.modo === 'testo') {
      r.foto = { valore: valoreDi(el), inizio: null, fine: null };
      try { r.foto.inizio = el.selectionStart; r.foto.fine = el.selectionEnd; } catch (e) { /* campi senza selezione (data, mese…) */ }
    }
    return r;
  }

  function letturaValida(r, t) {
    if (!r || r.caratteri.length < MIN_CARATTERI) return false;
    if (t - r.ultimo > INVIO_MAX) return false;
    var somma = 0;
    for (var i = 1; i < r.tempi.length; i++) {
      var d = r.tempi[i] - r.tempi[i - 1];
      if (d > GAP_MAX) return false;
      somma += d;
    }
    return somma / (r.tempi.length - 1) <= MEDIA_MAX;
  }

  // campi in cui il testo che si vede può essere diverso da value (numero con lettere: value ''; data scritta a metà)
  var TIPI_SPECIALI = ['number', 'date', 'month', 'week', 'time', 'datetime-local'];

  /*
   * Il campo torna com'era prima della raffica e la pagina riceve un "input" per aggiornarsi; se durante la raffica
   * il campo ha mandato un "change" (i campi data e mese lo mandano a ogni cifra) riceve anche il "change" del ripristino.
   */
  function ripristina(r) {
    var el = r.el;
    if (!r.foto || !el || !el.isConnected) return;
    var speciale = el.tagName === 'INPUT' && TIPI_SPECIALI.indexOf(String(el.type).toLowerCase()) >= 0;
    var cambiato = valoreDi(el) !== r.foto.valore;
    if (!cambiato && !speciale && !r.cambiato) return;
    if (el.isContentEditable) el.textContent = r.foto.valore;
    else el.value = r.foto.valore; // nei campi speciali cancella anche le cifre e le lettere rimaste a vista
    if (r.foto.inizio !== null) { try { el.setSelectionRange(r.foto.inizio, r.foto.fine); } catch (e) { /* niente selezione */ } }
    if (cambiato || r.cambiato) el.dispatchEvent(new Event('input', { bubbles: true }));
    if (r.cambiato) el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // "change" mandato dal campo durante la raffica (vedi ripristina)
  document.addEventListener('change', function (e) {
    if (e.isTrusted && raffica && raffica.modo === 'testo' && e.target === raffica.el) raffica.cambiato = true;
  }, true);

  // tasti trattenuti che non erano una lettura: li riceve la pagina (per esempio i tasti rapidi del menu)
  var digitazioneSelect = { el: null, testo: '', t: 0 };

  function scegliInSelect(sel, testo) {
    var adesso = Date.now();
    if (digitazioneSelect.el !== sel || adesso - digitazioneSelect.t > 1000) digitazioneSelect = { el: sel, testo: '', t: adesso };
    digitazioneSelect.testo += testo.toLowerCase();
    digitazioneSelect.t = adesso;
    var cerca = digitazioneSelect.testo;
    var stessa = cerca.split('').every(function (c) { return c === cerca.charAt(0); });
    if (stessa) cerca = cerca.charAt(0);
    var norm = function (s) { return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); };
    var n = sel.options.length;
    var da = stessa ? sel.selectedIndex + 1 : Math.max(sel.selectedIndex, 0);
    for (var k = 0; k < n; k++) {
      var o = sel.options[(da + k) % n];
      if (!o.disabled && norm(o.text).indexOf(cerca) === 0) {
        if (o.index !== sel.selectedIndex) {
          sel.selectedIndex = o.index;
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
    }
  }

  function replica(r) {
    if (!r.trattenuti.length) return;
    var dest = r.el && r.el.isConnected ? r.el : document.body;
    if (dest.tagName === 'SELECT') {
      // la scelta per iniziali di un elenco a discesa, come la fa il browser
      scegliInSelect(dest, r.trattenuti.map(function (d) { return d.key; }).join(''));
      return;
    }
    r.trattenuti.forEach(function (d) {
      var ev = new KeyboardEvent('keydown', d);
      ev.gfReplica = true;
      dest.dispatchEvent(ev);
    });
  }

  function chiudiRaffica() {
    var r = raffica;
    raffica = null;
    if (!r) return;
    clearTimeout(r.timer);
    if (r.modo === 'trattieni') replica(r);
  }

  function programmaFine(r) {
    clearTimeout(r.timer);
    var limite = r.caratteri.length >= MIN_CARATTERI ? INVIO_MAX : GAP_MAX;
    r.timer = setTimeout(function fine() {
      if (raffica !== r) return;
      // i tasti possono essere ancora in coda: controllo il tempo vero passato dall'ultimo
      var passato = (root.performance ? root.performance.now() : Date.now()) - r.ultimo;
      if (passato < limite) { r.timer = setTimeout(fine, limite - passato + 5); return; }
      chiudiRaffica();
    }, limite + 5);
  }

  function suTasto(e) {
    if (e.gfReplica) return;
    var k = e.key;
    if (k === 'Escape' && foto) {
      e.preventDefault();
      e.stopImmediatePropagation();
      chiudiFotocamera();
      return;
    }
    if (!attivo()) { if (raffica) chiudiRaffica(); return; }
    if (e.isComposing || k === 'Process' || k === 'Dead') { chiudiRaffica(); return; }
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'AltGraph' || k === 'Meta' || k === 'CapsLock' || k === 'NumLock') return;
    var el = document.activeElement;
    if (campoPassword(el)) { chiudiRaffica(); return; }
    var t = e.timeStamp || (root.performance ? root.performance.now() : Date.now());

    if ((k === 'Enter' || k === 'Tab') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      var r = raffica;
      if (r && r.el === el && letturaValida(r, t)) {
        // è una lettura: l'Invio non arriva alla pagina e i caratteri non restano nel campo
        e.preventDefault();
        e.stopImmediatePropagation();
        clearTimeout(r.timer);
        raffica = null;
        fineLettura = t;
        if (r.modo === 'testo') ripristina(r);
        Scanner.elabora(r.caratteri, 'lettore');
        return;
      }
      if (!r && t - fineLettura >= 0 && t - fineLettura < DOPPIO_FINE) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      chiudiRaffica();
      return;
    }

    var c = carattere(e, !!(raffica && raffica.el === el && t - raffica.ultimo <= GAP_MAX && raffica.caratteri.length));
    if (c === null || e.repeat) { chiudiRaffica(); return; }
    if (raffica && (raffica.el !== el || t - raffica.ultimo > GAP_MAX)) chiudiRaffica();
    // lo spazio su un pulsante lo preme: non lo trattengo se non è dentro una raffica
    if (!raffica && c === ' ' && !campoTesto(el)) return;
    if (!raffica) raffica = nuovaRaffica(el, t);
    var r2 = raffica;
    r2.caratteri += c;
    r2.tempi.push(t);
    r2.ultimo = t;
    if (r2.modo === 'trattieni') {
      // fuori dai campi di testo i tasti farebbero altro (tasti rapidi, scelta negli elenchi): li trattengo
      // finché non si capisce se è una lettura; se non lo è, li ripasso alla pagina
      e.preventDefault();
      e.stopImmediatePropagation();
      r2.trattenuti.push({ key: e.key, code: e.code, location: e.location, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true });
    } else if (c === GS) {
      e.preventDefault();
    }
    programmaFine(r2);
  }

  root.addEventListener('keydown', suTasto, true);
  // cambio di pagina o scheda nascosta: la fotocamera si spegne
  root.addEventListener('hashchange', function () { chiudiFotocamera(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) chiudiFotocamera(); });
  root.addEventListener('pagehide', function () { chiudiFotocamera(); });

  root.Scanner = Scanner;
})(this);
