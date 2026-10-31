/*
 * Gestionale Farmacia · Clinica Posillipo — nucleo dell'applicazione:
 * stato, utente e permessi, menu, tasti rapidi, ricerca, finestre e avvisi.
 * I dati arrivano dal server (api.js), l'accesso è in accesso.js,
 * le pagine stanno in pagine.js e amministrazione.js e si registrano in App.pagine.
 */
(function (root) {
  'use strict';

  var C = root.Calcoli;

  var App = {
    S: null,               // { impostazioni, reparti, articoli, movimenti } come li manda il server
    utente: null,          // utente collegato
    permessi: null,        // permessi calcolati dal server
    pagine: {},
    paginaCorrente: 'oggi',
    parametri: {},
    rinfresca: null,       // ridisegno "leggero" della pagina corrente (conserva i filtri)
    pronta: false,         // interfaccia già mostrata almeno una volta
    _giacenze: null
  };

  /* ---------- menu: stessa impostazione del Gestionale Agende, un tasto per pagina ---------- */
  // perm: permesso (o elenco di permessi, ne basta uno) che serve per vedere la pagina
  App.MENU = [
    { gruppo: 'Lavoro di ogni giorno' },
    { id: 'oggi', voce: 'Oggi', ico: '🏠', tasto: 'O' },
    { id: 'carico', voce: 'Carico', ico: '📥', tasto: 'C', perm: 'carico' },
    { id: 'consumi', voce: 'Consumi del giorno', ico: '💊', tasto: 'S', perm: 'consumo' },
    { id: 'trasferimenti', voce: 'Trasferimenti', ico: '🔁', tasto: 'T', perm: 'trasferimento' },
    { id: 'perdite', voce: 'Perdite e scaduti', ico: '🗑️', tasto: 'P', perm: 'perdita' },
    { gruppo: 'Magazzino' },
    { id: 'giacenze', voce: 'Giacenze', ico: '📦', tasto: 'G' },
    { id: 'scadenze', voce: 'Scadenze', ico: '⏳', tasto: 'Z', conta: 'scadenze' },
    { id: 'movimenti', voce: 'Movimenti', ico: '🧾', tasto: 'M' },
    { id: 'inventario', voce: 'Inventario', ico: '✅', tasto: 'I', perm: 'rettifica' },
    { gruppo: 'Registri' },
    { id: 'registro', voce: 'Nota consumi mensile', ico: '📅', tasto: 'R' },
    { gruppo: 'Archivio' },
    { id: 'articoli', voce: 'Articoli', ico: '🏷️', tasto: 'A' },
    { id: 'utenti', voce: 'Utenti', ico: '👥', tasto: 'U', perm: 'utenti' },
    { id: 'attivita', voce: 'Attività', ico: '📜', tasto: 'V', perm: 'attivita' },
    { id: 'configura', voce: 'Configura', ico: '⚙️', tasto: 'F', perm: ['impostazioni', 'backup'] },
    { id: 'guida', voce: 'Guida', ico: '❓', tasto: 'H' }
  ];

  // pagine solo di consultazione: si ridisegnano da sole quando altri utenti cambiano i dati
  App.PAGINE_CONSULTAZIONE = ['oggi', 'giacenze', 'scadenze', 'movimenti', 'articoli', 'attivita'];

  App.RUOLI = {
    amministratore: 'Amministratore',
    farmacista: 'Farmacista',
    reparto: 'Reparto',
    consultazione: 'Consultazione'
  };

  /* ---------- utilità ---------- */
  App.h = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var h = App.h;

  App.id = function (prefisso) {
    return (prefisso || 'x') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  };

  App.oggi = function () {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  App.fmtData = function (d) {
    if (!d) return '';
    var p = d.split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : d;
  };

  App.fmtScadenza = function (s) {
    if (!s) return '—';
    var p = s.split('-');
    return p[1] + '/' + p[0];
  };

  App.fmtNum = function (n) {
    if (n === null || n === undefined || n === '') return '';
    var v = Math.round(Number(n) * 1000) / 1000;
    return v.toLocaleString('it-IT', { maximumFractionDigits: 3 });
  };

  App.fmtEuro = function (n) {
    return (Number(n) || 0).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
  };

  // data e ora da un ISO o da millisecondi
  App.fmtDataOra = function (v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString('it-IT') + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  };

  App.fmtDimensione = function (byte) {
    var n = Number(byte) || 0;
    if (n < 1024) return n + ' byte';
    if (n < 1024 * 1024) return App.fmtNum(Math.round(n / 1024)) + ' KB';
    return App.fmtNum(Math.round(n / 1024 / 1024 * 10) / 10) + ' MB';
  };

  App.dataLunga = function (d) {
    var p = d.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };

  /* Numero per le caselle da modificare: senza separatore delle migliaia, con la virgola decimale. */
  App.fmtCampo = function (n) {
    if (n === null || n === undefined || n === '' || !Number(n)) return '';
    return String(Math.round(Number(n) * 1000) / 1000).replace('.', ',');
  };

  /*
   * Legge un numero scritto all'italiana: "12,5", "1.234,5", "12.000" (punto delle migliaia).
   * "1.5" resta 1,5 (un solo decimale dopo il punto non è un separatore delle migliaia).
   */
  App.numero = function (v) {
    var t = String(v === undefined || v === null ? '' : v).trim().replace(/\s/g, '');
    if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    var n = parseFloat(t);
    return isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
  };

  App.TIPI = {
    carico: 'Carico',
    consumo: 'Consumo',
    trasferimento: 'Trasferimento',
    perdita: 'Perdita',
    rettifica: 'Rettifica inventario'
  };

  App.CAUSALI_PERDITA = ['Scaduto', 'Rotto o danneggiato', 'Smarrito', 'Reso al fornitore', 'Altro'];

  /* ---------- utente e permessi (il controllo vero lo fa sempre il server) ---------- */
  App.puo = function (permesso) {
    return !!(App.permessi && App.permessi[permesso]);
  };

  App.eAmministratore = function () {
    return !!(App.utente && App.utente.ruolo === 'amministratore');
  };

  // true se l'utente può scrivere in quel reparto (reparti null = tutti)
  App.repartoPermesso = function (id) {
    var r = App.permessi && App.permessi.reparti;
    return !r || r.indexOf(id) >= 0;
  };

  // reparti attivi in cui l'utente può registrare
  App.repartiScrivibili = function () {
    return App.repartiAttivi().filter(function (r) { return App.repartoPermesso(r.id); });
  };

  App.paginaPermessa = function (id) {
    var voce = App.MENU.filter(function (v) { return v.id === id; })[0];
    if (!voce || !voce.perm) return true;
    var lista = typeof voce.perm === 'string' ? [voce.perm] : voce.perm;
    return lista.some(function (p) { return App.puo(p); });
  };

  App.vociPermesse = function () {
    return App.MENU.filter(function (v) { return v.id && App.paginaPermessa(v.id); });
  };

  // "Annulla" su un movimento: chi può annullare tutto, oppure i propri consumi e perdite nei propri reparti
  App.puoAnnullare = function (m) {
    if (!m || m.annullato) return false;
    if (App.puo('annullaTutti')) return true;
    if (m.tipo !== 'consumo' && m.tipo !== 'perdita') return false;
    if (!App.utente || m.utenteId !== App.utente.id) return false;
    return App.puo(m.tipo) && App.repartoPermesso(m.repartoId);
  };

  /* ---------- dati ---------- */
  App.articolo = function (id) { return App.S.articoli.filter(function (a) { return a.id === id; })[0]; };
  App.reparto = function (id) { return App.S.reparti.filter(function (r) { return r.id === id; })[0]; };
  App.nomeArticolo = function (id) { var a = App.articolo(id); return a ? a.nome : '(articolo eliminato)'; };
  App.nomeReparto = function (id) { var r = App.reparto(id); return r ? r.nome : '—'; };

  App.repartiAttivi = function () {
    return App.S.reparti.filter(function (r) { return r.attivo !== false; });
  };

  App.repartoCentrale = function () {
    var c = App.S.reparti.filter(function (r) { return r.centrale && r.attivo !== false; })[0];
    return c || App.repartiAttivi()[0];
  };

  App.articoliAttivi = function (categoria) {
    return App.S.articoli
      .filter(function (a) { return a.attivo !== false && (!categoria || a.categoria === categoria); })
      .sort(function (x, y) { return x.nome.localeCompare(y.nome, 'it'); });
  };

  App.articoloPerNome = function (nome) {
    var n = String(nome || '').trim().toLowerCase();
    return App.S.articoli.filter(function (a) { return a.nome.toLowerCase() === n; })[0];
  };

  App.archivioVuoto = function () {
    return !App.S || (!App.S.articoli.length && !App.S.movimenti.length);
  };

  App.giacenze = function () {
    if (!App._giacenze) App._giacenze = C.tutteLeGiacenze(App.S);
    return App._giacenze;
  };

  App.giacenza = function (articoloId, repartoId) {
    return App.giacenze()[articoloId + '|' + repartoId] || 0;
  };

  App.giacenzaTotale = function (articoloId) {
    var g = App.giacenze();
    return App.S.reparti.reduce(function (s, r) { return s + (g[articoloId + '|' + r.id] || 0); }, 0);
  };

  App.sottoScorta = function (a) {
    if (!a.scortaMinima) return false;
    var c = App.repartoCentrale();
    return !!c && App.giacenza(a.id, c.id) < a.scortaMinima;
  };

  /* Lotti con giacenza in tutti i reparti, con i giorni alla scadenza. */
  App.lottiInGiacenza = function () {
    var g = App.giacenze();
    var oggi = App.oggi();
    var out = [];
    App.S.articoli.forEach(function (a) {
      App.S.reparti.forEach(function (r) {
        if (!g[a.id + '|' + r.id]) return;
        C.lotti(App.S, a.id, r.id).forEach(function (l) {
          if (l.quantita <= 0) return;
          out.push({ articolo: a, reparto: r, lotto: l.lotto, scadenza: l.scadenza, quantita: l.quantita, giorni: C.giorniAllaScadenza(l.scadenza, oggi) });
        });
      });
    });
    return out;
  };

  App.statoScadenza = function (giorni) {
    if (giorni === null) return { classe: '', testo: 'senza scadenza' };
    if (giorni < 0) return { classe: 'pericolo', testo: 'scaduto' };
    if (giorni <= 30) return { classe: 'pericolo', testo: 'entro 30 giorni' };
    if (giorni <= (App.S.impostazioni.giorniAvvisoScadenza || 90)) return { classe: 'attenzione', testo: 'entro ' + (App.S.impostazioni.giorniAvvisoScadenza || 90) + ' giorni' };
    return { classe: 'ok', testo: 'valido' };
  };

  App.contaScadenze = function () {
    var soglia = App.S.impostazioni.giorniAvvisoScadenza || 90;
    return App.lottiInGiacenza().filter(function (l) { return l.giorni !== null && l.giorni <= soglia; }).length;
  };

  /* ---------- registrazioni: tutto passa dal server ---------- */

  /*
   * Registra i movimenti di un modulo. Per consumo, perdita e trasferimento si manda una riga
   * per ogni riga del modulo (con 'lotto' solo se scelto): la ripartizione sui lotti la fa il server.
   * L'operatore è l'utente collegato: lo mette il server.
   */
  App.aggiungiMovimenti = function (lista) {
    var movimenti = lista.map(function (m) {
      var x = {};
      Object.keys(m).forEach(function (k) {
        if (k === 'id' || k === 'creato' || k === 'operatore' || k === 'utenteId') return;
        if (m[k] === undefined || m[k] === null) return;
        if (k === 'lotto' && !m[k]) return;
        x[k] = m[k];
      });
      x.quantita = Number(m.quantita);
      return x;
    });
    return root.Api.scrivi('POST', '/api/movimenti', { movimenti: movimenti });
  };

  App.annullaMovimento = function (id, motivo) {
    return root.Api.scrivi('POST', '/api/movimenti/' + encodeURIComponent(id) + '/annulla', { motivo: motivo || '' });
  };

  /* Correzione dal registro mensile: il consumo del giorno diventa 'quantita' (0 = nessun consumo). */
  /*
   * Correzione di una casella del registro. "prima" è il consumo che l'utente vedeva: se nel frattempo
   * un altro utente ha registrato consumi per quel giorno il server risponde 409 e non cancella niente;
   * in quel caso risincronizzo prima di rifiutare, così il registro si ridisegna con i dati veri.
   */
  App.impostaConsumoGiorno = function (articoloId, repartoId, data, quantita, prima) {
    return root.Api.scrivi('POST', '/api/consumo-giorno', { articoloId: articoloId, repartoId: repartoId, data: data, quantita: quantita, prima: prima })
      .catch(function (e) {
        if (e && e.stato === 409) return root.Api.sincronizza().then(function () { throw e; }, function () { throw e; });
        throw e;
      });
  };

  /* ---------- file ---------- */
  App.scarica = function (blob, nome) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  };

  App.scegliFileDaLeggere = function (accetta) {
    return new Promise(function (ok) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = accetta || '';
      inp.addEventListener('change', function () { ok(inp.files && inp.files[0]); });
      inp.click();
    });
  };

  /* ---------- avvisi e finestre ---------- */
  App.avviso = function (testo, tipo) {
    var box = document.getElementById('avvisi');
    var d = document.createElement('div');
    d.className = 'avviso ' + (tipo || '');
    d.textContent = testo;
    box.appendChild(d);
    setTimeout(function () { d.remove(); }, tipo === 'errore' ? 7000 : 3500);
  };

  var chiusuraModale = null;
  var apertaDa = null; // elemento che aveva il fuoco quando si è aperta la finestra: ci torna alla chiusura

  /* Con una finestra aperta o la schermata di accesso davanti, la pagina sotto non si raggiunge con Tab né con i clic. */
  App.aggiornaInerte = function () {
    var app = document.getElementById('app');
    var m = document.getElementById('modale');
    var acc = document.getElementById('accesso');
    if (!app) return;
    app.inert = !!((m && !m.hidden) || (acc && !acc.hidden));
  };

  App.apriModale = function (opz) {
    var m = document.getElementById('modale');
    var attivo = document.activeElement;
    // una finestra aperta da un'altra finestra torna comunque a chi ha aperto la prima
    if (m.hidden) apertaDa = attivo && attivo !== document.body && !m.contains(attivo) ? attivo : null;
    m.className = 'modale' + (opz.largo ? ' largo' : '');
    m.innerHTML =
      '<div class="modale-testa"><h2 id="modale-titolo">' + h(opz.titolo) + '</h2>' +
      '<button class="btn fantasma" type="button" data-chiudi aria-label="Chiudi">✕</button></div>' +
      '<div class="modale-corpo">' + opz.corpo + '</div>' +
      '<div class="modale-piede">' + (opz.piede || '<button class="btn" type="button" data-chiudi>Chiudi</button>') + '</div>';
    m.hidden = false;
    document.getElementById('velo').hidden = false;
    App.aggiornaInerte();
    chiusuraModale = opz.allaChiusura || null;
    m.querySelectorAll('[data-chiudi]').forEach(function (b) { b.addEventListener('click', App.chiudiModale); });
    var primo = m.querySelector('.modale-corpo input:not([type=checkbox]):not([readonly]), .modale-corpo select, .modale-corpo textarea');
    setTimeout(function () {
      // se l'utente sta già scrivendo nella finestra non gli sposto il cursore
      if (m.contains(document.activeElement)) return;
      // la finestra può essere già stata chiusa (Esc premuto subito)
      var el = primo && primo.isConnected ? primo : (m.querySelector('.modale-piede .btn.primario') || m.querySelector('[data-chiudi]'));
      if (el) el.focus();
    }, 30);
    if (opz.dopo) opz.dopo(m);
    return m;
  };

  App.chiudiModale = function () {
    var m = document.getElementById('modale');
    if (m.hidden) return;
    m.hidden = true;
    m.innerHTML = '';
    document.getElementById('velo').hidden = true;
    App.aggiornaInerte();
    var torna = apertaDa;
    apertaDa = null;
    // il fuoco torna dove era (se c'è ancora e nessun altro l'ha già preso)
    if (torna && torna.isConnected && (!document.activeElement || document.activeElement === document.body)) {
      try { torna.focus({ preventScroll: true }); } catch (e) { /* elemento non più attivabile */ }
    }
    var f = chiusuraModale;
    chiusuraModale = null;
    if (f) f();
  };

  App.conferma = function (titolo, testo, etichetta, pericolo) {
    return new Promise(function (ok) {
      var risposta = false;
      App.apriModale({
        titolo: titolo,
        corpo: '<p>' + testo + '</p>',
        piede: '<button class="btn" type="button" data-chiudi>Annulla</button>' +
          '<button class="btn ' + (pericolo ? 'pericolo pieno' : 'primario') + '" type="button" id="conferma-si">' + h(etichetta || 'Conferma') + '</button>',
        allaChiusura: function () { ok(risposta); },
        dopo: function (m) {
          m.querySelector('#conferma-si').addEventListener('click', function () { risposta = true; App.chiudiModale(); });
          setTimeout(function () { var b = m.querySelector('#conferma-si'); if (b) b.focus(); }, 40);
        }
      });
    });
  };

  /* Conferma forte: bisogna scrivere una parola (per esempio RIPRISTINA) per abilitare il pulsante. */
  App.confermaForte = function (titolo, testoHtml, parola, etichetta) {
    return new Promise(function (ok) {
      var risposta = false;
      App.apriModale({
        titolo: titolo,
        corpo: '<div class="banda pericolo"><p>' + testoHtml + '</p></div>' +
          '<label class="campo"><span>Per confermare scrivi ' + h(parola) + '</span><input id="forte-parola" autocomplete="off" spellcheck="false"></label>',
        piede: '<button class="btn" type="button" data-chiudi>Annulla</button>' +
          '<button class="btn pericolo pieno" type="button" id="forte-si" disabled>' + h(etichetta || 'Conferma') + '</button>',
        allaChiusura: function () { ok(risposta); },
        dopo: function (m) {
          var inp = m.querySelector('#forte-parola');
          var si = m.querySelector('#forte-si');
          function giusta() { return inp.value.trim().toUpperCase() === parola.toUpperCase(); }
          inp.addEventListener('input', function () { si.disabled = !giusta(); });
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && giusta()) { risposta = true; App.chiudiModale(); } });
          si.addEventListener('click', function () { if (giusta()) { risposta = true; App.chiudiModale(); } });
        }
      });
    });
  };

  App.chiedi = function (titolo, testo, predefinito, etichetta) {
    return new Promise(function (ok) {
      var risposta = null;
      App.apriModale({
        titolo: titolo,
        corpo: '<label class="campo"><span>' + h(testo) + '</span><input id="chiedi-testo" value="' + h(predefinito || '') + '"></label>',
        piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="chiedi-ok">' + h(etichetta || 'OK') + '</button>',
        allaChiusura: function () { ok(risposta); },
        dopo: function (m) {
          var inp = m.querySelector('#chiedi-testo');
          function vai() { risposta = inp.value.trim(); App.chiudiModale(); }
          m.querySelector('#chiedi-ok').addEventListener('click', vai);
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') vai(); });
        }
      });
    });
  };

  /* ---------- banda "altri utenti hanno cambiato i dati" ---------- */
  App.mostraBanda = function (testo) {
    var b = document.getElementById('aggiornamenti');
    document.getElementById('aggiornamenti-testo').textContent = testo;
    b.hidden = false;
  };

  App.nascondiBanda = function () {
    var b = document.getElementById('aggiornamenti');
    if (b) b.hidden = true;
  };

  /* ---------- navigazione ---------- */
  App.vai = function (pagina, parametri) {
    App.parametri = parametri || {};
    if (location.hash !== '#' + pagina) {
      App._parametriInAttesa = App.parametri;
      location.hash = pagina;
    } else {
      App.mostra(pagina);
    }
  };

  App.mostra = function (pagina) {
    if (!App.S) return;
    if (!App.pagine[pagina] || !App.paginaPermessa(pagina)) {
      // pagina inesistente o non permessa (per esempio aperta dall'indirizzo): vado su Oggi
      pagina = 'oggi';
      if (location.hash && location.hash !== '#oggi' && history.replaceState) history.replaceState(null, '', '#oggi');
    }
    App.paginaCorrente = pagina;
    App.rinfresca = null;
    App.gestoreScansione = null; // ogni pagina che usa il lettore di codici a barre lo reimposta (js/scanner.js)
    App.nascondiBanda();
    var voce = App.MENU.filter(function (v) { return v.id === pagina; })[0];
    document.getElementById('titolo-pagina').textContent = voce ? voce.voce : '';
    document.getElementById('data-oggi').textContent = App.dataLunga(App.oggi());
    document.title = (voce ? voce.voce + ' · ' : '') + 'Gestionale Farmacia · ' + (App.S.impostazioni.struttura || '');
    document.querySelectorAll('#menu a').forEach(function (a) {
      a.classList.toggle('attivo', a.getAttribute('data-pagina') === pagina);
    });
    document.getElementById('app').classList.remove('menu-aperto');
    var cont = document.getElementById('contenuto');
    // contenitore nuovo: gli ascoltatori della pagina precedente se ne vanno con il vecchio
    var nuovo = cont.cloneNode(false);
    cont.parentNode.replaceChild(nuovo, cont);
    App.pagine[pagina](nuovo, App.parametri || {});
    App.parametri = {};
    window.scrollTo(0, 0);
  };

  App.ridisegna = function () { App.mostra(App.paginaCorrente); };

  App.disegnaMenu = function () {
    var conte = { scadenze: App.contaScadenze() };
    var voci = [];
    App.MENU.forEach(function (v) {
      if (v.gruppo) { voci.push(v); return; }
      if (App.paginaPermessa(v.id)) voci.push(v);
    });
    // tolgo i gruppi rimasti senza voci
    voci = voci.filter(function (v, i) { return !v.gruppo || (voci[i + 1] && !voci[i + 1].gruppo); });
    document.getElementById('menu').innerHTML = voci.map(function (v) {
      if (v.gruppo) return '<div class="menu-gruppo">' + h(v.gruppo) + '</div>';
      var c = v.conta && conte[v.conta] ? '<span class="conta" title="Lotti in scadenza o scaduti">' + conte[v.conta] + '</span>' : '';
      return '<a href="#' + v.id + '" data-pagina="' + v.id + '"' + (v.id === App.paginaCorrente ? ' class="attivo"' : '') + '>' +
        '<span class="ico" aria-hidden="true">' + v.ico + '</span><span class="voce">' + h(v.voce) + '</span>' + c +
        '<kbd title="Tasto rapido">' + v.tasto + '</kbd></a>';
    }).join('');
  };

  App.disegnaMarchio = function () {
    var imp = App.S.impostazioni;
    var logo = imp.logo
      ? '<img src="' + h(imp.logo) + '" alt="">'
      : '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="M13 6h6v7h7v6h-7v7h-6v-7H6v-6h7z" fill="#fff"/></svg>';
    document.getElementById('marchio').innerHTML =
      '<div class="logo">' + logo + '</div>' +
      '<div><div class="nome">' + h(imp.struttura) + '</div><div class="sotto">' + h(imp.sottotitolo) + '</div></div>' +
      '<div class="prodotto">Gestionale Farmacia · carico e scarico</div>';
  };

  App.nomeRuolo = function (ruolo) { return App.RUOLI[ruolo] || ruolo || ''; };

  /* Pulsante utente nella barra in alto: "Nome · Ruolo" con il menu Cambia password / Esci. */
  App.disegnaUtente = function () {
    var u = App.utente;
    var b = document.getElementById('utente-btn');
    if (!u) { b.innerHTML = ''; return; }
    b.innerHTML = '<span class="utente-ico" aria-hidden="true">👤</span><span class="utente-nome">' + h(u.nome || u.username) + '</span>' +
      '<span class="utente-ruolo"> · ' + h(App.nomeRuolo(u.ruolo)) + '</span><span aria-hidden="true" class="utente-freccia">▾</span>';
    b.title = 'Collegato come ' + u.username;
  };

  App.aggiornaLaterale = function () {
    if (!App.S) return;
    App.disegnaMenu();
    var S = App.S;
    var u = App.utente || {};
    var attivi = S.movimenti.filter(function (m) { return !m.annullato; }).length;
    var reparti = u.ruolo === 'reparto' && App.permessi && App.permessi.reparti
      ? '<div>Reparti: ' + h(App.permessi.reparti.map(App.nomeReparto).join(', ') || 'nessuno') + '</div>' : '';
    document.getElementById('stato-archivio').innerHTML =
      '<div>👤 <b>' + h(u.nome || u.username || '') + '</b> · ' + h(App.nomeRuolo(u.ruolo)) + '</div>' + reparti +
      '<div><b>' + S.articoli.length + '</b> articoli · <b>' + attivi + '</b> movimenti</div>';
  };

  /* Dopo un cambio dei propri permessi (per esempio l'amministratore ha cambiato il suo ruolo). */
  App.aggiornaUtente = function (ridisegna) {
    App.disegnaUtente();
    App.aggiornaLaterale();
    if (!App.paginaPermessa(App.paginaCorrente)) { App.vai('oggi'); return; }
    if (!ridisegna) return;
    // pulsanti e reparti della pagina dipendono dai permessi: ridisegno se non si perde quello che si sta scrivendo
    var attivo = document.activeElement;
    var cont = document.getElementById('contenuto');
    if (attivo && cont.contains(attivo) && inCampo(attivo)) App.mostraBanda('I tuoi permessi sono cambiati.');
    else App.ridisegna();
    App.avviso('L’amministratore ha cambiato il tuo ruolo o i tuoi reparti.', 'ok');
  };

  /* ---------- aggiornamenti arrivati dal server ---------- */

  // Chiamata da Api.sincronizza dopo aver unito i dati nuovi.
  App.dopoSincronizzazione = function (cambi, opz) {
    if (!App.pronta || !App.S || !cambi.qualcosa) return;
    if (cambi.impostazioni) App.disegnaMarchio();
    App.aggiornaLaterale();
    if ((cambi.articoli || cambi.cancellati) && App.datalistArticoli) App.datalistArticoli();
    if (opz && opz.remota) App.aggiornamentoRemoto(cambi);
  };

  function rinfrescaPagina() {
    if (App.rinfresca) { App.rinfresca(); return; }
    // ridisegno completo: la pagina resta dove l'utente l'aveva fatta scorrere
    var x = window.scrollX, y = window.scrollY;
    App.ridisegna();
    window.scrollTo(x, y);
  }

  /*
   * Dopo una propria modifica fatta da una finestra (per esempio un articolo aperto dalla scheda):
   * ridisegna la pagina solo se non si perde niente (pagine di consultazione, ridisegni leggeri);
   * nelle pagine dove si scrive aggiorna solo menu e contatori, così il modulo compilato resta.
   */
  App.aggiornaVista = function () {
    if (App.rinfresca || App.PAGINE_CONSULTAZIONE.indexOf(App.paginaCorrente) >= 0) rinfrescaPagina();
    else App.aggiornaLaterale();
  };

  /*
   * Altri utenti hanno cambiato i dati. Le pagine di consultazione si ridisegnano da sole;
   * nelle pagine dove si scrive non ridisegno (si perderebbe quello che l'utente sta scrivendo):
   * aggiorno menu e contatori e mostro una banda con il pulsante "Aggiorna".
   */
  App.aggiornamentoRemoto = function (cambi) {
    var pag = App.paginaCorrente;
    if (pag === 'guida') return;
    if ((pag === 'configura' || pag === 'utenti') && !cambi.reparti && !cambi.impostazioni && !cambi.cancellati) return;
    // Utenti: ridisegno solo l'elenco (i nomi dei reparti possono essere cambiati)
    if (pag === 'utenti' && App.rinfresca) { App.rinfresca(); return; }
    // Consumi e Inventario tengono da parte le quantità scritte: si possono aggiornare subito
    if ((pag === 'consumi' || pag === 'inventario') && App.rinfresca) { App.rinfresca(); return; }
    var cont = document.getElementById('contenuto');
    var attivo = document.activeElement;
    var campoAttivo = !!(attivo && cont.contains(attivo) && inCampo(attivo));
    if (pag === 'registro') {
      // il registro si ridisegna se nessuna cella è in modifica
      if (!(campoAttivo && attivo.matches('td.g input'))) { rinfrescaPagina(); return; }
    } else if (App.PAGINE_CONSULTAZIONE.indexOf(pag) >= 0) {
      // con App.rinfresca si ridisegnano solo i risultati: i filtri (anche quello col cursore) restano
      if (App.rinfresca || !campoAttivo) { rinfrescaPagina(); return; }
    }
    App.mostraBanda(cambi.movimenti ? 'Altri utenti hanno registrato dei movimenti.' : 'Altri utenti hanno modificato i dati.');
  };

  /* ---------- ricerca rapida (Ctrl+K o /) ---------- */
  var sceltaRicerca = 0;
  var risultatiRicerca = [];

  App.apriRicerca = function () {
    if (!App.S) return;
    var r = document.getElementById('ricerca');
    r.hidden = false;
    document.getElementById('velo').hidden = false;
    var inp = document.getElementById('ricerca-testo');
    inp.value = '';
    cercaRapida('');
    inp.focus();
  };

  function chiudiRicerca() {
    document.getElementById('ricerca').hidden = true;
    if (document.getElementById('modale').hidden) document.getElementById('velo').hidden = true;
  }

  function cercaRapida(testo) {
    var t = testo.trim().toLowerCase();
    var art = App.S.articoli.filter(function (a) {
      return !t || a.nome.toLowerCase().indexOf(t) >= 0 || (a.principio || '').toLowerCase().indexOf(t) >= 0 || (a.codice || '').toLowerCase().indexOf(t) >= 0;
    }).sort(function (x, y) {
      var px = x.nome.toLowerCase().indexOf(t) === 0 ? 0 : 1;
      var py = y.nome.toLowerCase().indexOf(t) === 0 ? 0 : 1;
      return px - py || x.nome.localeCompare(y.nome, 'it');
    }).slice(0, 12).map(function (a) {
      return { tipo: 'articolo', id: a.id, testo: a.nome, nota: a.categoria + ' · giacenza ' + App.fmtNum(App.giacenzaTotale(a.id)) + (a.unita ? ' ' + a.unita : '') };
    });
    var pagine = App.vociPermesse().filter(function (v) { return t && v.voce.toLowerCase().indexOf(t) >= 0; }).map(function (v) {
      return { tipo: 'pagina', id: v.id, testo: 'Vai a: ' + v.voce, nota: 'tasto ' + v.tasto };
    });
    risultatiRicerca = pagine.concat(art);
    sceltaRicerca = 0;
    var ul = document.getElementById('ricerca-risultati');
    if (!risultatiRicerca.length) {
      ul.innerHTML = '<li class="tenue">Nessun risultato' + (t ? ' per “' + h(testo) + '”' : '') + '</li>';
      return;
    }
    ul.innerHTML = risultatiRicerca.map(function (r, i) {
      return '<li data-i="' + i + '"' + (i === 0 ? ' class="scelto"' : '') + '><span>' + (r.tipo === 'pagina' ? '↪' : '💊') + '</span>' +
        '<span class="chi">' + h(r.testo) + '</span><span class="tenue">' + h(r.nota) + '</span></li>';
    }).join('');
  }

  function apriRisultato(i) {
    var r = risultatiRicerca[i];
    if (!r) return;
    chiudiRicerca();
    if (r.tipo === 'pagina') App.vai(r.id);
    else App.schedaArticolo(r.id);
  }

  function evidenzia() {
    document.querySelectorAll('#ricerca-risultati li[data-i]').forEach(function (li) {
      li.classList.toggle('scelto', Number(li.getAttribute('data-i')) === sceltaRicerca);
      if (Number(li.getAttribute('data-i')) === sceltaRicerca) li.scrollIntoView({ block: 'nearest' });
    });
  }

  /* ---------- menu dell'utente (barra in alto) ---------- */
  function tendinaAperta() { return !document.getElementById('utente-tendina').hidden; }

  function apriTendina(apri) {
    var t = document.getElementById('utente-tendina');
    t.hidden = !apri;
    document.getElementById('utente-btn').setAttribute('aria-expanded', apri ? 'true' : 'false');
    if (apri) t.querySelector('button').focus();
  }

  App.cambiaPassword = function () {
    App.apriModale({
      titolo: 'Cambia la tua password',
      corpo: '<form class="modulo" id="cp-form" autocomplete="on">' +
        '<input type="text" name="username" autocomplete="username" value="' + h(App.utente ? App.utente.username : '') + '" hidden>' +
        '<label class="campo largo"><span>Password attuale</span><input type="password" id="cp-attuale" autocomplete="current-password"></label>' +
        '<label class="campo"><span>Nuova password (almeno 8 caratteri)</span><input type="password" id="cp-nuova" autocomplete="new-password"></label>' +
        '<label class="campo"><span>Ripeti la nuova password</span><input type="password" id="cp-ripeti" autocomplete="new-password"></label>' +
        '</form><p class="piccolo tenue">Le altre sessioni aperte con il tuo utente (su altri PC) verranno chiuse.</p>',
      piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="cp-salva">Cambia password</button>',
      dopo: function (m) {
        var b = m.querySelector('#cp-salva');
        function salva() {
          var attuale = m.querySelector('#cp-attuale').value;
          var nuova = m.querySelector('#cp-nuova').value;
          var ripeti = m.querySelector('#cp-ripeti').value;
          if (!attuale) { App.avviso('Scrivi la password attuale.', 'errore'); return; }
          if (nuova.length < 8) { App.avviso('La nuova password deve avere almeno 8 caratteri.', 'errore'); return; }
          if (nuova !== ripeti) { App.avviso('Le due password nuove non sono uguali.', 'errore'); return; }
          if (nuova === attuale) { App.avviso('La nuova password deve essere diversa da quella attuale.', 'errore'); return; }
          b.disabled = true;
          // password attuale sbagliata = 400; un 401 qui vuol dire sessione scaduta: torna la schermata di accesso
          root.Api.richiesta('POST', '/api/password', { attuale: attuale, nuova: nuova }).then(function () {
            App.chiudiModale();
            App.avviso('Password cambiata', 'ok');
          }, function (e) {
            b.disabled = false;
            App.avviso(e.message, 'errore');
          });
        }
        b.addEventListener('click', salva);
        m.querySelector('#cp-form').addEventListener('submit', function (e) { e.preventDefault(); salva(); });
        m.querySelector('#cp-ripeti').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); salva(); } });
      }
    });
  };

  /* Esce: chiude la sessione sul server, toglie i dati dalla pagina e torna all'accesso. */
  App.esci = function () {
    var fine = function () {
      root.Api.fermaAggiornamenti();
      // nome e logo della struttura per la schermata di accesso: quelli attuali, anche se cambiati dopo l'avvio
      var imp = App.S && App.S.impostazioni;
      if (imp && root.Accesso.stato) {
        root.Accesso.stato.struttura = imp.struttura;
        root.Accesso.stato.sottotitolo = imp.sottotitolo;
        root.Accesso.stato.logo = imp.logo;
      }
      App.chiudiModale();
      chiudiRicerca();
      App.utente = null;
      App.permessi = null;
      App.S = null;
      App._giacenze = null;
      root.Api.rev = 0;
      root.Api.storia = null;
      if (App.dimenticaScelte) App.dimenticaScelte();
      document.getElementById('contenuto').innerHTML = '';
      document.getElementById('menu').innerHTML = '';
      document.getElementById('stato-archivio').innerHTML = '';
      document.getElementById('app').hidden = true;
      root.Accesso.mostraAccesso();
    };
    root.Api.richiesta('POST', '/api/logout', {}, { senza401: true }).then(fine, fine);
  };

  /* ---------- tasti rapidi ---------- */
  function inCampo(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }
  App.inCampo = inCampo;

  function tasti(e) {
    if (!App.S || !App.utente || (root.Accesso && root.Accesso.visibile())) return;
    var ricercaAperta = !document.getElementById('ricerca').hidden;
    var modaleAperto = !document.getElementById('modale').hidden;
    if ((e.ctrlKey || e.metaKey) && e.key && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      apriTendina(false);
      App.apriRicerca();
      return;
    }
    if (e.key === 'Escape') {
      document.getElementById('app').classList.remove('menu-aperto');
      if (tendinaAperta()) { apriTendina(false); document.getElementById('utente-btn').focus(); }
      else if (ricercaAperta) chiudiRicerca();
      else if (modaleAperto) App.chiudiModale();
      return;
    }
    if (ricercaAperta) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sceltaRicerca = Math.min(sceltaRicerca + 1, risultatiRicerca.length - 1); evidenzia(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sceltaRicerca = Math.max(sceltaRicerca - 1, 0); evidenzia(); }
      else if (e.key === 'Enter') { e.preventDefault(); apriRisultato(sceltaRicerca); }
      return;
    }
    if (modaleAperto || tendinaAperta() || inCampo(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); App.apriRicerca(); return; }
    // solo le pagine permesse hanno il tasto rapido
    var voce = App.vociPermesse().filter(function (v) { return v.tasto && e.key && v.tasto.toLowerCase() === e.key.toLowerCase(); })[0];
    if (voce) { e.preventDefault(); App.vai(voce.id); }
  }

  /* ---------- avvio ---------- */

  // Ascoltatori dell'interfaccia: si collegano una volta sola.
  function collegaInterfaccia() {
    window.addEventListener('hashchange', function () {
      if (!App.S || !App.utente) return;
      App.parametri = App._parametriInAttesa || {};
      App._parametriInAttesa = null;
      App.mostra(location.hash.slice(1));
    });
    document.addEventListener('keydown', tasti);
    document.getElementById('apri-ricerca').addEventListener('click', App.apriRicerca);
    document.getElementById('apri-menu').addEventListener('click', function () {
      document.getElementById('app').classList.toggle('menu-aperto');
    });
    document.getElementById('velo').addEventListener('click', function () {
      if (!document.getElementById('ricerca').hidden) chiudiRicerca();
      else App.chiudiModale();
    });
    // telefono: il menu laterale si chiude toccando il contenuto o una voce (anche quella già aperta)
    document.getElementById('contenuto').parentNode.addEventListener('click', function (e) {
      var app = document.getElementById('app');
      if (app.classList.contains('menu-aperto') && !e.target.closest('#apri-menu')) app.classList.remove('menu-aperto');
    });
    document.getElementById('menu').addEventListener('click', function (e) {
      if (e.target.closest('a')) document.getElementById('app').classList.remove('menu-aperto');
    });
    var inp = document.getElementById('ricerca-testo');
    inp.addEventListener('input', function () { cercaRapida(inp.value); });
    document.getElementById('ricerca-risultati').addEventListener('click', function (e) {
      var li = e.target.closest('li[data-i]');
      if (li) apriRisultato(Number(li.getAttribute('data-i')));
    });
    // menu dell'utente
    document.getElementById('utente-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      apriTendina(!tendinaAperta());
    });
    document.getElementById('utente-password').addEventListener('click', function () { apriTendina(false); App.cambiaPassword(); });
    document.getElementById('utente-esci').addEventListener('click', function () { apriTendina(false); App.esci(); });
    document.addEventListener('click', function (e) {
      if (tendinaAperta() && !e.target.closest('#utente-menu')) apriTendina(false);
    });
    // banda degli aggiornamenti
    document.getElementById('aggiornamenti-btn').addEventListener('click', function () { App.nascondiBanda(); App.ridisegna(); });
    document.getElementById('aggiornamenti-chiudi').addEventListener('click', App.nascondiBanda);
  }

  /*
   * Entra nel programma con l'utente collegato: carica i dati dal server e mostra l'app.
   * Se è lo stesso utente di prima (sessione scaduta e nuovo accesso) risincronizza e resta sulla pagina.
   */
  App.entra = function (utente, permessi) {
    var prima = App.utente;
    var stessoUtente = !!(prima && utente && prima.id === utente.id && App.S && App.pronta);
    App.utente = utente;
    App.permessi = permessi || {};
    var Api = root.Api;
    var sinc;
    if (stessoUtente) {
      sinc = Api.sincronizza({ remota: true });
    } else {
      // utente diverso (o primo ingresso): niente di quello che era aperto deve restare
      App.chiudiModale();
      chiudiRicerca();
      apriTendina(false);
      App.nascondiBanda();
      App.S = null;
      Api.rev = 0;
      Api.storia = null;
      if (App.dimenticaScelte) App.dimenticaScelte(); // date e filtri dell'utente di prima
      sinc = Api.sincronizza({ completa: true });
    }
    return sinc.then(function () {
      root.Accesso.nascondi();
      document.getElementById('app').hidden = false;
      App.disegnaMarchio();
      App.disegnaUtente();
      App.aggiornaLaterale();
      if (!App.pronta) {
        App.pronta = true;
        App.mostra((location.hash || '#oggi').slice(1));
      } else if (!stessoUtente) {
        App.mostra((location.hash || '#oggi').slice(1));
      } else if (!App.paginaPermessa(App.paginaCorrente)) {
        App.vai('oggi');
      } else if ((App.paginaCorrente === 'utenti' || App.paginaCorrente === 'attivita') && App.rinfresca) {
        // pagine che leggono direttamente dal server: la lettura fallita per la sessione scaduta si ripete
        App.rinfresca();
      }
      Api.avviaAggiornamenti();
    });
  };

  App.avvia = function () {
    document.getElementById('data-oggi').textContent = App.dataLunga(App.oggi());
    collegaInterfaccia();
    root.Accesso.avvia();
  };

  root.App = App;
})(this);
