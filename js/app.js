/*
 * NefroCenter Pharmacy (Gestionale Farmacia) — nucleo dell'applicazione:
 * stato, utente e permessi, menu, tasti rapidi, ricerca, finestre e avvisi; aspetto (tema chiaro/scuro,
 * colore d'accento, marchio e nome del prodotto) e passaggio animato fra le pagine.
 * I dati arrivano dal server (api.js), l'accesso è in accesso.js,
 * le pagine stanno in pagine.js, amministrazione.js e pagine-*.js e si registrano in App.pagine.
 *
 * Aspetto (versione 3.0, parte F di docs/NOVITA-3.0.md):
 *   App.temaScelto()      'chiaro' | 'scuro' | 'automatico' (scelta dell'utente in localStorage 'gf-tema',
 *                         altrimenti l'impostazione "tema" della struttura)
 *   App.temaEffettivo()   'chiaro' | 'scuro' (con 'automatico' segue il computer)
 *   App.scegliTema(t)     scelta dell'utente ('' = torna al tema predefinito della struttura)
 *   App.applicaAspetto()  tema, colore d'accento (impostazione coloreAccento) e titolo della finestra
 *   App.disegnaMarchio()  logo, nome del prodotto e struttura nel menu laterale (chiama anche applicaAspetto)
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
    { id: 'richieste', voce: 'Richieste', ico: '📝', tasto: 'Q', perm: ['richieste', 'evadiRichieste'], conta: 'richieste' },
    { id: 'consegne', voce: 'DDT e consegne', ico: '🚚', tasto: 'D', perm: ['ddt', 'riceviDdt'], conta: 'consegne' },
    { id: 'trasferimenti', voce: 'Trasferimenti', ico: '🔁', tasto: 'T', perm: 'ddt' },
    { id: 'perdite', voce: 'Perdite e scaduti', ico: '🗑️', tasto: 'P', perm: 'perdita' },
    { gruppo: 'Magazzino' },
    { id: 'struttura', voce: 'Struttura', ico: '🏥', tasto: 'K' },
    { id: 'armadi', voce: 'Armadi', ico: '🗄️', tasto: 'B' },
    { id: 'giacenze', voce: 'Giacenze', ico: '📦', tasto: 'G' },
    { id: 'scadenze', voce: 'Scadenze', ico: '⏳', tasto: 'Z', conta: 'scadenze' },
    { id: 'movimenti', voce: 'Movimenti', ico: '🧾', tasto: 'M' },
    { id: 'inventario', voce: 'Inventario', ico: '✅', tasto: 'I', perm: 'rettifica' },
    { gruppo: 'Analisi' },
    { id: 'previsioni', voce: 'Previsioni e fabbisogno', ico: '📈', tasto: 'E', perm: 'previsioni' },
    { id: 'distribuzione', voce: 'Distribuzione', ico: '🧭', tasto: 'N', perm: 'previsioni' },
    { gruppo: 'Registri' },
    { id: 'registro', voce: 'Nota consumi mensile', ico: '📅', tasto: 'R' },
    { gruppo: 'Archivio' },
    { id: 'articoli', voce: 'Articoli', ico: '🏷️', tasto: 'A' },
    { id: 'magazzini', voce: 'Magazzini e assortimento', ico: '🏬', tasto: 'W', perm: ['struttura', 'assortimento'] },
    { id: 'utenti', voce: 'Utenti', ico: '👥', tasto: 'U', perm: 'utenti' },
    { id: 'sicurezza', voce: 'Sicurezza', ico: '🔐', tasto: 'Y', perm: 'sicurezza' },
    { id: 'attivita', voce: 'Attività', ico: '📜', tasto: 'V', perm: 'attivita' },
    { id: 'sistema', voce: 'Sistema', ico: '🩺', tasto: 'X', perm: 'sistema' },
    { id: 'configura', voce: 'Configura', ico: '⚙️', tasto: 'F', perm: ['impostazioni', 'backup'] },
    { id: 'guida', voce: 'Guida', ico: '❓', tasto: 'H' }
  ];

  // pagine solo di consultazione: si ridisegnano da sole quando altri utenti cambiano i dati.
  // Previsioni e Distribuzione NO: si ridisegnerebbero mentre si scrivono le confezioni della proposta d'ordine
  // (hanno App.rinfresca e mostrano la banda "Aggiorna").
  App.PAGINE_CONSULTAZIONE = ['oggi', 'giacenze', 'scadenze', 'movimenti', 'articoli', 'attivita', 'sistema'];

  // id invariati dalla 2.x, etichette della 3.0 (uguali a server/accessi.js)
  App.RUOLI = {
    amministratore: 'Amministratore',
    farmacista: 'Farmacista (farmacia centrale)',
    reparto: 'Responsabile di magazzino',
    consultazione: 'Direzione (sola lettura)'
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
    // i movimenti nati da un DDT non si annullano da soli: si annulla il DDT (pagina DDT e consegne)
    if (m && m.ddtId) return false;
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

  // magazzini attivi (escluso il magazzino di sistema "In transito": la merce in viaggio non sta in nessun magazzino vero)
  App.repartiAttivi = function () {
    return App.S.reparti.filter(function (r) { return r.attivo !== false && r.tipo !== 'transito'; });
  };

  App.magazzinoTransito = function () {
    return App.S.reparti.filter(function (r) { return r.tipo === 'transito'; })[0] || null;
  };

  App.magazziniPeriferici = function () {
    return App.repartiAttivi().filter(function (r) { return !r.centrale && r.tipo !== 'centrale'; });
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

  /*
   * Scorta minima di un articolo in un magazzino, con le stesse regole del cruscotto "Oggi" (js/pagine-cruscotto.js):
   * quella dell'assortimento del magazzino; nella farmacia centrale, se l'assortimento non ha soglie (minima o punto di
   * riordino) per quell'articolo, la scorta minima dell'anagrafica. 0 = nessuna soglia.
   * Si ricalcola quando cambiano i dati (App._giacenze azzerato dalla sincronizzazione).
   */
  var cacheSoglie = null;
  App.scortaMinima = function (articolo, repartoId) {
    if (!articolo || !App.S) return 0;
    var g = App.giacenze();
    if (!cacheSoglie || cacheSoglie.g !== g || cacheSoglie.S !== App.S) {
      var minime = {}, coperti = {};
      (App.S.assortimento || []).forEach(function (r) {
        if (r.attivo === false) return;
        var k = r.articoloId + '|' + r.repartoId;
        var min = Number(r.scortaMin) || 0;
        if (min > 0 || Number(r.puntoRiordino) > 0) coperti[k] = true;
        if (min > 0) minime[k] = min;
      });
      var c = App.repartoCentrale();
      cacheSoglie = { g: g, S: App.S, minime: minime, coperti: coperti, centrale: c ? c.id : null };
    }
    var k = articolo.id + '|' + repartoId;
    if (cacheSoglie.minime[k]) return cacheSoglie.minime[k];
    if (cacheSoglie.coperti[k] || repartoId !== cacheSoglie.centrale) return 0;
    return Number(articolo.scortaMinima) || 0;
  };

  /* Magazzini attivi (o solo repartoId) in cui l'articolo è sotto la scorta minima. Gli articoli non attivi non contano. */
  App.magazziniSottoScorta = function (a, repartoId) {
    if (!a || a.attivo === false) return [];
    var reparti = repartoId ? [App.reparto(repartoId)].filter(Boolean) : App.repartiAttivi();
    return reparti.filter(function (r) {
      var min = App.scortaMinima(a, r.id);
      return min > 0 && App.giacenza(a.id, r.id) < min;
    });
  };

  App.sottoScorta = function (a, repartoId) { return App.magazziniSottoScorta(a, repartoId).length > 0; };

  /*
   * Lotti di tutte le coppie (articolo, magazzino) con giacenza: { 'articolo|magazzino': [{ lotto, scadenza, quantita }] }.
   * Una sola passata sui movimenti (raggruppati per coppia) invece di una per coppia: con decine di migliaia di
   * movimenti e centinaia di articoli il menu (contatore delle scadenze) e la pagina Oggi restano immediati.
   * Si ricalcola quando cambiano le giacenze (App._giacenze azzerato dalla sincronizzazione).
   */
  var cacheLotti = null;
  App.lottiPerCoppia = function () {
    var g = App.giacenze();
    if (cacheLotti && cacheLotti.g === g && cacheLotti.S === App.S) return cacheLotti.lotti;
    var gruppi = {};
    App.S.movimenti.forEach(function (m) {
      if (m.annullato) return;
      var k1 = m.articoloId + '|' + m.repartoId;
      if (g[k1]) (gruppi[k1] || (gruppi[k1] = [])).push(m);
      if (m.tipo === 'trasferimento' && m.repartoDestId && m.repartoDestId !== m.repartoId) {
        var k2 = m.articoloId + '|' + m.repartoDestId;
        if (g[k2]) (gruppi[k2] || (gruppi[k2] = [])).push(m);
      }
    });
    var out = {};
    Object.keys(gruppi).forEach(function (k) {
      var i = k.indexOf('|');
      // stesso calcolo di Calcoli.lotti, sui soli movimenti della coppia
      out[k] = C.lotti({ movimenti: gruppi[k] }, k.slice(0, i), k.slice(i + 1));
    });
    cacheLotti = { g: g, S: App.S, lotti: out };
    return out;
  };

  /* Lotti con giacenza in tutti i reparti, con i giorni alla scadenza. */
  App.lottiInGiacenza = function () {
    var g = App.giacenze();
    var lp = App.lottiPerCoppia();
    var oggi = App.oggi();
    var out = [];
    App.S.articoli.forEach(function (a) {
      App.S.reparti.forEach(function (r) {
        if (!g[a.id + '|' + r.id]) return;
        (lp[a.id + '|' + r.id] || []).forEach(function (l) {
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
  var ricercaApertaDa = null; // lo stesso per la ricerca rapida

  /*
   * Con una finestra aperta o la schermata di accesso davanti, la pagina sotto non si raggiunge con Tab né con i clic.
   * Con la schermata di accesso davanti non si raggiungono nemmeno finestra, ricerca e fotocamera rimaste aperte sotto.
   */
  App.aggiornaInerte = function () {
    var app = document.getElementById('app');
    var m = document.getElementById('modale');
    var acc = document.getElementById('accesso');
    if (!app) return;
    var accesso = !!(acc && !acc.hidden);
    app.inert = accesso || !!(m && !m.hidden);
    if (accesso) {
      // i "fratelli" della schermata di accesso (di solito i figli di body; anche se la pagina è avvolta in un contenitore)
      Array.prototype.forEach.call(acc.parentNode.children, function (el) {
        if (el === app || el === acc || el.id === 'avvisi' || /^(SCRIPT|STYLE|LINK)$/.test(el.tagName)) return;
        if (!el.inert) { el.inert = true; el.setAttribute('data-inerte-accesso', ''); }
      });
    } else {
      Array.prototype.forEach.call(document.querySelectorAll('[data-inerte-accesso]'), function (el) {
        el.inert = false;
        el.removeAttribute('data-inerte-accesso');
      });
    }
  };

  /*
   * Elemento a cui tornerà il fuoco (escluso quello dentro "dentro"). Ricerca rapida e menu dell'utente si chiudono
   * quando aprono una finestra: il fuoco torna a chi aveva aperto la ricerca, o al pulsante dell'utente.
   */
  function fuocoDaRicordare(dentro) {
    var a = document.activeElement;
    if (!a || a === document.body || (dentro && dentro.contains(a))) return null;
    if (a.closest('#utente-menu')) return document.getElementById('utente-btn');
    if (a.closest('#ricerca')) return ricercaApertaDa && ricercaApertaDa.isConnected ? ricercaApertaDa : null;
    return a;
  }

  App.apriModale = function (opz) {
    var m = document.getElementById('modale');
    // una finestra aperta da un'altra finestra torna comunque a chi ha aperto la prima
    if (m.hidden) apertaDa = fuocoDaRicordare(m);
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
    var primo = m.querySelector('.modale-corpo input:not([type=checkbox]):not([type=hidden]):not([hidden]):not([readonly]), .modale-corpo select, .modale-corpo textarea');
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
    // il fuoco torna dove era (se c'è ancora e nessun altro l'ha già preso). Un fuoco rimasto nella pagina è quello
    // di prima dell'apertura (con la finestra aperta la pagina era inerte): per esempio la voce del menu dell'utente
    // appena nascosta, se la finestra si chiude prima di aver preso il fuoco
    var ora = document.activeElement;
    if (torna && torna.isConnected && (!ora || ora === document.body || document.getElementById('app').contains(ora))) {
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
    // animazione d'entrata solo quando si arriva su una pagina (o su una sua vista con parametri), non nei ridisegni
    var arrivo = pagina !== paginaMostrata || Object.keys(App.parametri || {}).length > 0;
    paginaMostrata = pagina;
    App.paginaCorrente = pagina;
    App.rinfresca = null;
    App.gestoreScansione = null; // ogni pagina che usa il lettore di codici a barre lo reimposta (js/scanner.js)
    App.nascondiBanda();
    var voce = App.MENU.filter(function (v) { return v.id === pagina; })[0];
    document.getElementById('titolo-pagina').textContent = voce ? voce.voce : '';
    document.getElementById('data-oggi').textContent = App.dataLunga(App.oggi());
    App.aggiornaTitolo();
    document.querySelectorAll('#menu a').forEach(function (a) {
      var attiva = a.getAttribute('data-pagina') === pagina;
      a.classList.toggle('attivo', attiva);
      if (attiva) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.getElementById('app').classList.remove('menu-aperto');
    var cont = document.getElementById('contenuto');
    // contenitore nuovo: gli ascoltatori della pagina precedente se ne vanno con il vecchio
    var nuovo = cont.cloneNode(false);
    cont.parentNode.replaceChild(nuovo, cont);
    // i grafici della pagina di prima sono usciti dalla pagina: si liberano subito
    if (root.Grafici && root.Grafici.libera) root.Grafici.libera();
    App.pagine[pagina](nuovo, App.parametri || {});
    App.parametri = {};
    if (arrivo && root.Motion && root.Motion.pagina) root.Motion.pagina(nuovo);
    window.scrollTo(0, 0);
  };

  var paginaMostrata = null; // ultima pagina disegnata da App.mostra (per l'animazione d'entrata)

  /* Titolo della finestra: pagina · nome del prodotto · struttura. */
  App.aggiornaTitolo = function () {
    var imp = impostazioniAspetto();
    var base = (imp.nomeProdotto || 'NefroCenter Pharmacy') + (imp.struttura ? ' · ' + imp.struttura : '');
    var voce = App.S && App.utente ? App.MENU.filter(function (v) { return v.id === App.paginaCorrente; })[0] : null;
    document.title = (voce ? voce.voce + ' · ' : '') + base;
  };

  App.ridisegna = function () { App.mostra(App.paginaCorrente); };

  /* Contatori delle voci del menu (voci con "conta: nome"): ogni parte registra il suo. */
  var contatori = {};
  App.registraContatore = function (nome, fn) { contatori[nome] = fn; };

  // ultimi numeri mostrati nel menu: quando cambiano, il contatore pulsa (null = primo disegno dopo l'accesso)
  var contePrima = null;

  App.disegnaMenu = function () {
    var conte = { scadenze: App.contaScadenze() };
    Object.keys(contatori).forEach(function (k) {
      try { conte[k] = Number(contatori[k]()) || 0; } catch (e) { conte[k] = 0; }
    });
    var voci = [];
    App.MENU.forEach(function (v) {
      if (v.gruppo) { voci.push(v); return; }
      if (App.paginaPermessa(v.id)) voci.push(v);
    });
    // tolgo i gruppi rimasti senza voci
    voci = voci.filter(function (v, i) { return !v.gruppo || (voci[i + 1] && !voci[i + 1].gruppo); });
    var titoli = { scadenze: 'Lotti in scadenza o scaduti', richieste: 'Richieste da gestire', consegne: 'DDT da preparare o da ricevere' };
    document.getElementById('menu').innerHTML = voci.map(function (v) {
      if (v.gruppo) return '<div class="menu-gruppo">' + h(v.gruppo) + '</div>';
      var c = v.conta && conte[v.conta] ? '<span class="conta" data-conta="' + h(v.conta) + '" title="' + h(titoli[v.conta] || '') + '">' + conte[v.conta] +
        '<span class="nascosto"> ' + h(titoli[v.conta] || 'da vedere') + '</span></span>' : '';
      var attiva = v.id === App.paginaCorrente;
      return '<a href="#' + v.id + '" data-pagina="' + v.id + '"' + (attiva ? ' class="attivo" aria-current="page"' : '') + '>' +
        '<span class="ico" aria-hidden="true">' + v.ico + '</span><span class="voce">' + h(v.voce) + '</span>' + c +
        '<kbd title="Tasto rapido">' + v.tasto + '</kbd></a>';
    }).join('');
    // contatori cambiati dall'ultima volta: un impulso per farli notare
    if (contePrima) {
      Object.keys(conte).forEach(function (k) {
        if (contePrima[k] === undefined || contePrima[k] === conte[k] || !conte[k]) return;
        var el = document.querySelector('#menu .conta[data-conta="' + k + '"]');
        if (!el) return;
        el.classList.add('cambiato');
        if (root.Motion && root.Motion.evidenzia) root.Motion.evidenzia(el);
      });
    }
    contePrima = conte;
  };

  /* ---------- marchio, nome del prodotto, tema e colore d'accento ---------- */

  App.MARCHIO = 'brand/marchio.png'; // simbolo incorporato (impostazione logo = ''); l'anteprima non ha la cartella brand/
  var SIMBOLO = '<svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true"><path d="M13 6h6v7h7v6h-7v7h-6v-7H6v-6h7z" fill="#fff"/></svg>';

  // impostazioni dell'aspetto: quelle caricate, oppure (prima dell'accesso) quelle pubbliche di /api/stato
  function impostazioniAspetto() {
    if (App.S && App.S.impostazioni) return App.S.impostazioni;
    return (root.Accesso && root.Accesso.stato) || {};
  }

  /*
   * HTML del marchio del menu laterale: logo (impostazione logo: '' = marchio incorporato App.MARCHIO, 'nessuno' =
   * simbolo neutro, data URL = immagine caricata), nome del prodotto come titolo (ultima parola più leggera), struttura
   * sotto e sottotitolo. Lo usa anche l'anteprima della pagina Configura, così è identica al menu vero.
   */
  App.htmlMarchio = function (imp) {
    imp = imp || {};
    var logo = imp.logo || '';
    var box;
    if (logo === 'nessuno') box = '<div class="logo simbolo">' + SIMBOLO + '</div>';
    else if (/^data:image\//.test(logo)) box = '<div class="logo immagine"><img src="' + h(logo) + '" alt=""></div>';
    else box = '<div class="logo"><img src="' + h(App.MARCHIO) + '" alt=""></div>';
    var nome = String(imp.nomeProdotto || 'NefroCenter Pharmacy').trim();
    var parole = nome.split(/\s+/);
    // ultima parola più leggera ("NefroCenter Pharmacy"), come nel marchio
    var nomeHtml = parole.length > 1 ? h(parole.slice(0, -1).join(' ')) + ' <span>' + h(parole[parole.length - 1]) + '</span>' : h(nome);
    return box +
      '<div><div class="nome">' + nomeHtml + '</div>' + (imp.struttura ? '<div class="sotto">' + h(imp.struttura) + '</div>' : '') + '</div>' +
      (imp.sottotitolo ? '<div class="prodotto">' + h(imp.sottotitolo) + '</div>' : '');
  };

  /* Un logo che non si carica (marchio assente, immagine rovinata) lascia il posto al simbolo neutro, senza icona rotta. */
  App.collegaLogo = function (el) {
    var img = el && el.querySelector('.logo img');
    if (!img) return;
    var togli = function () {
      var b = img.parentNode;
      if (!b || !b.isConnected) return;
      b.className = 'logo simbolo';
      b.innerHTML = SIMBOLO;
    };
    img.addEventListener('error', togli);
    if (img.complete && !img.naturalWidth && img.getAttribute('src')) togli();
  };

  App.disegnaMarchio = function () {
    if (!App.S) return;
    var imp = App.S.impostazioni || {};
    var nome = String(imp.nomeProdotto || 'NefroCenter Pharmacy').trim();
    var el = document.getElementById('marchio');
    el.innerHTML = App.htmlMarchio(imp);
    el.title = nome + (imp.struttura ? ' · ' + imp.struttura : '');
    App.collegaLogo(el);
    App.applicaAspetto();
  };

  App.TEMI = { chiaro: 'Chiaro', scuro: 'Scuro', automatico: 'Automatico' };
  var CHIAVE_TEMA = 'gf-tema';

  function sceltaUtente() {
    try {
      var v = root.localStorage ? root.localStorage.getItem(CHIAVE_TEMA) : '';
      return App.TEMI[v] ? v : '';
    } catch (e) { return ''; }
  }

  function sistemaScuro() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { return false; }
  }

  App.temaScelto = function () {
    var imp = impostazioniAspetto();
    return sceltaUtente() || (App.TEMI[imp.tema] ? imp.tema : 'automatico');
  };

  App.temaEffettivo = function () {
    var t = App.temaScelto();
    return t === 'automatico' ? (sistemaScuro() ? 'scuro' : 'chiaro') : t;
  };

  /* Tema scelto dall'utente in questo browser ('' = quello predefinito della struttura). */
  App.scegliTema = function (tema) {
    try {
      if (root.localStorage) {
        if (App.TEMI[tema]) root.localStorage.setItem(CHIAVE_TEMA, tema);
        else root.localStorage.removeItem(CHIAVE_TEMA);
      }
    } catch (e) { /* memoria del browser non disponibile: vale fino alla chiusura della pagina */ temaDiRiserva = tema; }
    App.applicaTema();
  };
  var temaDiRiserva = '';

  App.applicaTema = function () {
    var t = temaDiRiserva && App.TEMI[temaDiRiserva] ? (temaDiRiserva === 'automatico' ? (sistemaScuro() ? 'scuro' : 'chiaro') : temaDiRiserva) : App.temaEffettivo();
    var html = document.documentElement;
    var prima = html.getAttribute('data-tema');
    if (prima !== t) html.setAttribute('data-tema', t);
    segnaTemaNelMenu();
    if (prima && prima !== t) dopoCambioTema();
  };

  // grafici e pagine che leggono i colori dalle variabili CSS si ridisegnano col tema nuovo (se non si perde niente)
  function dopoCambioTema() {
    if (root.Grafici && root.Grafici.ritema) root.Grafici.ritema();
    if (App.pronta && App.S && App.utente && !document.getElementById('app').hidden) App.aggiornaVista();
  }

  function segnaTemaNelMenu() {
    var scelto = temaDiRiserva || App.temaScelto();
    var bott = document.querySelectorAll('#utente-tendina [data-scegli-tema]');
    Array.prototype.forEach.call(bott, function (b) {
      b.setAttribute('aria-checked', b.getAttribute('data-scegli-tema') === scelto ? 'true' : 'false');
    });
  }

  /* Colore d'accento della struttura (impostazione coloreAccento, '' = rosso del marchio). */
  App.applicaAccento = function () {
    var c = String(impostazioniAspetto().coloreAccento || '');
    var st = document.documentElement.style;
    if (/^#[0-9a-fA-F]{6}$/.test(c)) {
      st.setProperty('--accento', c);
      // sotto un testo bianco (contatori del menu): un po' più scuro, così si legge anche con un colore chiaro
      st.setProperty('--accento-pieno', 'color-mix(in srgb, ' + c + ' 82%, #000)');
      st.setProperty('--accento-chiaro', 'color-mix(in srgb, ' + c + ' 14%, var(--superficie))');
    } else {
      st.removeProperty('--accento');
      st.removeProperty('--accento-pieno');
      st.removeProperty('--accento-chiaro');
    }
  };

  App.applicaAspetto = function () {
    App.applicaAccento();
    App.applicaTema();
    App.aggiornaTitolo();
  };

  App.nomeRuolo = function (ruolo) { return App.RUOLI[ruolo] || ruolo || ''; };

  // iniziali per il cerchietto dell'utente ("Giovanni Amministratore" -> "GA")
  function iniziali(nome) {
    var p = String(nome || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    var x = p.length > 1 ? p[0].charAt(0) + p[p.length - 1].charAt(0) : p[0].slice(0, 2);
    return x.toUpperCase();
  }

  /* Pulsante utente nella barra in alto: "Nome · Ruolo" con il menu (password, sicurezza, tema, esci). */
  App.disegnaUtente = function () {
    var u = App.utente;
    var b = document.getElementById('utente-btn');
    var chi = document.getElementById('utente-chi');
    if (!u) { b.innerHTML = ''; b.removeAttribute('aria-label'); if (chi) chi.innerHTML = ''; return; }
    var nome = u.nome || u.username;
    b.innerHTML = '<span class="utente-ico" aria-hidden="true">' + h(iniziali(nome)) + '</span><span class="utente-nome">' + h(nome) + '</span>' +
      '<span class="utente-ruolo"> · ' + h(App.nomeRuolo(u.ruolo)) + '</span><span aria-hidden="true" class="utente-freccia">▾</span>';
    b.title = 'Collegato come ' + u.username;
    // sul telefono il nome non si vede: il lettore dello schermo lo legge comunque
    b.setAttribute('aria-label', nome + ', ' + App.nomeRuolo(u.ruolo) + ': menu dell’utente');
    if (chi) chi.innerHTML = '<b>' + h(nome) + '</b>' + h(App.nomeRuolo(u.ruolo)) + ' · ' + h(u.username);
    var sic = document.getElementById('utente-sicurezza');
    if (sic) sic.hidden = !(App.Sicurezza && App.Sicurezza.apriAccount);
    segnaTemaNelMenu();
  };

  App.aggiornaLaterale = function () {
    if (!App.S) return;
    App.disegnaMenu();
    var S = App.S;
    var u = App.utente || {};
    var attivi = S.movimenti.filter(function (m) { return !m.annullato; }).length;
    var reparti = u.ruolo === 'reparto' && App.permessi && App.permessi.reparti
      ? '<div>Magazzini: ' + h(App.permessi.reparti.map(App.nomeReparto).join(', ') || 'nessuno') + '</div>' : '';
    var st = (root.Accesso && root.Accesso.stato) || {};
    var sigla = S.impostazioni.sigla || S.impostazioni.nomeProdotto || '';
    document.getElementById('stato-archivio').innerHTML =
      '<div>👤 <b>' + h(u.nome || u.username || '') + '</b> · ' + h(App.nomeRuolo(u.ruolo)) + '</div>' + reparti +
      '<div><b>' + App.fmtNum(S.articoli.length) + '</b> articoli · <b>' + App.fmtNum(attivi) + '</b> movimenti</div>' +
      (sigla || st.versione ? '<div class="versione">' + h(sigla) + (st.versione ? (sigla ? ' · ' : '') + 'versione ' + h(st.versione) : '') + '</div>' : '');
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
    if (r.hidden) ricercaApertaDa = fuocoDaRicordare(r);
    r.hidden = false;
    document.getElementById('velo').hidden = false;
    var inp = document.getElementById('ricerca-testo');
    inp.value = '';
    cercaRapida('');
    inp.focus();
  };

  function chiudiRicerca() {
    var r = document.getElementById('ricerca');
    var a = document.activeElement;
    // il fuoco è nella ricerca, o su nessun elemento (un clic sul velo lo toglie prima di chiuderla)
    var conFuoco = !a || a === document.body || r.contains(a);
    r.hidden = true;
    if (document.getElementById('modale').hidden) document.getElementById('velo').hidden = true;
    // il fuoco torna dove era prima della ricerca (anche dentro una finestra aperta)
    if (conFuoco && ricercaApertaDa && ricercaApertaDa.isConnected) {
      try { ricercaApertaDa.focus({ preventScroll: true }); } catch (e) { /* elemento non più attivabile */ }
    }
  }
  App.chiudiRicerca = chiudiRicerca;

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
    // "Vai a" con una finestra aperta: la finestra non resta sopra la pagina nuova
    if (r.tipo === 'pagina') { App.chiudiModale(); App.vai(r.id); }
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

  function vociTendina() {
    return Array.prototype.filter.call(document.querySelectorAll('#utente-tendina button'), function (b) { return !b.hidden && !b.disabled; });
  }

  function apriTendina(apri) {
    var t = document.getElementById('utente-tendina');
    if (apri) {
      var sic = document.getElementById('utente-sicurezza');
      if (sic) sic.hidden = !(App.Sicurezza && App.Sicurezza.apriAccount);
      segnaTemaNelMenu();
    }
    t.hidden = !apri;
    document.getElementById('utente-btn').setAttribute('aria-expanded', apri ? 'true' : 'false');
    if (apri) { var v = vociTendina(); if (v[0]) v[0].focus(); }
  }

  // frecce, Inizio e Fine fra le voci del menu dell'utente (come un menu del sistema)
  function tastiTendina(e) {
    var v = vociTendina();
    if (!v.length) return;
    var i = v.indexOf(document.activeElement);
    var dove = null;
    if (e.key === 'ArrowDown') dove = i < 0 ? 0 : (i + 1) % v.length;
    else if (e.key === 'ArrowUp') dove = i < 0 ? v.length - 1 : (i - 1 + v.length) % v.length;
    else if (e.key === 'Home') dove = 0;
    else if (e.key === 'End') dove = v.length - 1;
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && document.activeElement && document.activeElement.hasAttribute('data-scegli-tema')) {
      // fra i tre temi anche con destra e sinistra
      var temi = v.filter(function (b) { return b.hasAttribute('data-scegli-tema'); });
      var j = temi.indexOf(document.activeElement);
      dove = v.indexOf(temi[(j + (e.key === 'ArrowRight' ? 1 : temi.length - 1)) % temi.length]);
    }
    if (dove === null) return;
    e.preventDefault();
    v[dove].focus();
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
      // nome del prodotto, struttura, logo e aspetto per la schermata di accesso: quelli attuali, anche se cambiati
      // dopo l'avvio (gli stessi campi pubblici di GET /api/stato)
      var imp = App.S && App.S.impostazioni;
      if (imp && root.Accesso.stato) {
        ['nomeProdotto', 'sigla', 'struttura', 'sottotitolo', 'logo', 'coloreAccento', 'tema'].forEach(function (k) {
          if (imp[k] !== undefined) root.Accesso.stato[k] = imp[k];
        });
      }
      App.chiudiModale();
      chiudiRicerca();
      App.utente = null;
      App.permessi = null;
      App.S = null;
      App._giacenze = null;
      root.Api.rev = 0;
      root.Api.storia = null;
      contePrima = null;
      paginaMostrata = null;
      if (App.dimenticaScelte) App.dimenticaScelte();
      if (root.Grafici && root.Grafici.libera) root.Grafici.libera(document.getElementById('contenuto'));
      document.getElementById('contenuto').innerHTML = '';
      document.getElementById('menu').innerHTML = '';
      document.getElementById('stato-archivio').innerHTML = '';
      document.getElementById('app').hidden = true;
      App.applicaAspetto(); // titolo della finestra senza la pagina; tema e accento dalle impostazioni copiate qui sopra
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
      // pagina cambiata dal tasto Indietro/Avanti o dall'indirizzo (non da App.vai): finestra e ricerca non restano sopra
      if (!App._parametriInAttesa) {
        if (!document.getElementById('ricerca').hidden) chiudiRicerca();
        if (!document.getElementById('modale').hidden) App.chiudiModale();
      }
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
    var sic = document.getElementById('utente-sicurezza');
    if (sic) {
      sic.addEventListener('click', function () {
        apriTendina(false);
        if (App.Sicurezza && App.Sicurezza.apriAccount) App.Sicurezza.apriAccount();
      });
    }
    // tema: la scelta vale subito; il menu resta aperto per provare l'altro
    Array.prototype.forEach.call(document.querySelectorAll('#utente-tendina [data-scegli-tema]'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        App.scegliTema(b.getAttribute('data-scegli-tema'));
        var nomi = { chiaro: 'Tema chiaro', scuro: 'Tema scuro', automatico: 'Tema automatico: segue le impostazioni del computer' };
        App.avviso(nomi[b.getAttribute('data-scegli-tema')] || 'Tema cambiato', 'ok');
      });
    });
    document.getElementById('utente-tendina').addEventListener('keydown', tastiTendina);
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
      contePrima = null;
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
    App.applicaTema();
    collegaInterfaccia();
    // tema predefinito, colore e nome della struttura per la schermata di accesso (js/accesso.js, GET /api/stato)
    document.addEventListener('gf-stato', function () { App.applicaAspetto(); });
    // tema automatico: segue il computer anche mentre il programma è aperto
    try {
      var mq = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)');
      if (mq) {
        var segui = function () { if (App.temaScelto() === 'automatico') App.applicaTema(); };
        if (mq.addEventListener) mq.addEventListener('change', segui); else if (mq.addListener) mq.addListener(segui);
      }
    } catch (e) { /* browser senza matchMedia */ }
    // la scelta fatta in un'altra scheda dello stesso browser vale anche qui
    root.addEventListener('storage', function (e) { if (e.key === CHIAVE_TEMA) App.applicaTema(); });
    root.Accesso.avvia();
  };

  // tema subito, prima ancora dell'avvio: la pagina non lampeggia col tema sbagliato
  try { App.applicaTema(); } catch (e) { /* documento non pronto */ }

  root.App = App;
})(this);
