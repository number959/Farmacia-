/*
 * Guida sullo schermo ("Guidami"): giri passo per passo sulle pagine del programma (NefroCenter Pharmacy).
 *
 * window.Tour
 *   avvia(id)          avvia un giro (false se non esiste o non è permesso all'utente)
 *   ferma()            chiude il giro aperto
 *   elenco()           [{ id, titolo, descrizione, pagina, ico, gruppo }] dei giri permessi all'utente, nell'ordine
 *                      dell'elenco (raggruppati come il menu: GRUPPI)
 *   perPagina(pagina)  id del giro della pagina (null se la pagina non ne ha uno); se una pagina ne ha più d'uno
 *                      (Richieste: chiedere ed evadere) sceglie quello adatto all'utente e a quello che sta guardando
 *   apriElenco()       piccolo elenco dei giri, sotto il pulsante Guidami
 *   stato(), bersagli() per le prove automatiche (strumenti/prova-tour.js)
 *
 * Un giro: { id, gruppo, perPagina?, pagina (id | function | null), ico, titolo, descrizione, se?, qui?, passi }
 *   qui?: function () → true se il giro è quello giusto per la vista aperta (perPagina sceglie lui fra più giri)
 *
 * Un passo: { pagina?, el?: selettore | function () → selettore o elemento, titolo, testo (testo o function () → testo),
 *             posizione?: 'sopra'|'sotto'|'destra'|'sinistra', facoltativo?: true, prima?: function () {},
 *             se?: function () → false per saltarlo, insieme?: true (evidenzia tutti gli elementi trovati),
 *             risali?: selettore (evidenzia il contenitore più vicino, per esempio l'etichetta di una spunta),
 *             riparo?: 'fondo'|'cima' (dove appoggiare il fumetto se non c'è posto accanto all'elemento),
 *             vista?: { segno, parametri } (una vista della pagina, aperta con App.vai(pagina, parametri): il dettaglio
 *                     di una richiesta, il modulo di una richiesta nuova, la ricezione di un DDT, una scheda…;
 *                     "segno" è un selettore (dentro #contenuto) o una funzione che dice se quella vista è già aperta:
 *                     allora il giro non ridisegna la pagina. "parametri" può essere una funzione che restituisce null
 *                     quando la vista non si può aprire (per esempio nessuna richiesta da evadere): il passo facoltativo
 *                     allora manca, quello obbligatorio resta sulla vista che c'è),
 *             ambiente?: { id, apri, chiudi, aperto } (una finestra o un menu che il giro apre per il passo e chiude
 *                     quando si passa a un passo che non ne ha bisogno, o alla fine; apri() → null se non si può) }
 * Senza "pagina" il passo usa la pagina del giro; con pagina: null resta dove si trova.
 *
 * Il giro non scrive niente: apre le pagine e le loro viste (App.vai), le porta in vista, sul telefono apre il menu
 * laterale quando il passo è lì; preme solo i pulsanti che cambiano quello che si vede (il menu del tuo utente, la
 * modalità Disponi degli armadi, le schede delle Previsioni e il dettaglio di un articolo) e alla fine li rimette come erano.
 */
(function (root) {
  'use strict';

  var App = root.App;
  var h = App.h;

  var ATTESA_MAX = 3000;   // quanto aspetto al massimo che una pagina mostri l'elemento del passo
  var ATTESA_MINIMA = 500; // sulla pagina già aperta da un po'
  var MARGINE = 6;         // aria tra l'elemento e il riquadro luminoso
  var DISTANZA = 14;       // tra il riquadro e il fumetto (ci sta la freccia)
  var BORDO = 10;          // il fumetto resta a questa distanza dai bordi dello schermo
  var DURATA_SCORRIMENTO = 1000; // uno scorrimento morbido della pagina finisce entro questo tempo

  /* ======================= condizioni comuni ======================= */

  function puo(p) { return function () { return App.puo(p); }; }

  function valore(x) { return typeof x === 'function' ? x() : x; }

  // movimenti che l'utente può annullare: amministratore e farmacista tutti, il reparto i propri consumi e perdite
  function puoAnnullareQualcosa() { return App.puo('annullaTutti') || App.puo('consumo') || App.puo('perdita'); }

  function puoCorreggereRegistro() {
    var sel = document.getElementById('r-rep');
    return App.puo('registro') && (!sel || App.repartoPermesso(sel.value));
  }

  // pagine dove compare la barra del lettore di codici a barre (la scrive js/scanner.js)
  var PAGINE_LETTORE = ['carico', 'consumi', 'trasferimenti', 'perdite', 'inventario'];

  function paginaLettore() {
    if (PAGINE_LETTORE.indexOf(App.paginaCorrente) >= 0 && App.paginaPermessa(App.paginaCorrente)) return App.paginaCorrente;
    var p = PAGINE_LETTORE.filter(function (x) { return App.paginaPermessa(x); })[0];
    return p || null;
  }

  function conLettore() { return !!paginaLettore(); }

  /* Casella di oggi della prima riga della nota consumi (o l'ultima, se il mese mostrato è più corto). */
  function cellaDiOggi() {
    var riga = document.querySelector('#r-tab table.registro tbody tr');
    if (!riga) return null;
    var celle = riga.querySelectorAll('td.g');
    if (!celle.length) return null;
    return celle[Math.min(new Date().getDate(), celle.length) - 1];
  }

  function nomeProdotto() {
    var imp = App.S && App.S.impostazioni;
    return (imp && imp.nomeProdotto) || 'NefroCenter Pharmacy';
  }

  function dati(nome) { return (App.S && App.S[nome]) || []; }

  // la farmacia centrale (farmacista, amministratore): evade le richieste dei magazzini di piano
  function eFarmacia() { return App.puo('evadiRichieste'); }

  // chi può chiedere merce alla farmacia per almeno un magazzino
  function puoChiedere() { return App.puo('richieste') && App.repartiScrivibili().length > 0; }

  // responsabile di magazzino: vede e lavora solo sui suoi magazzini
  function soloSuoiMagazzini() { return !!(App.permessi && App.permessi.reparti); }

  // la finestra "Sicurezza dell'account" (js/sicurezza.js) c'è e il menu dell'utente ha la sua voce
  function conAccount() {
    return !!(App.Sicurezza && typeof App.Sicurezza.apriAccount === 'function' && document.getElementById('utente-sicurezza'));
  }

  // il modulo di una richiesta (nuova o da modificare) è aperto
  function moduloRichiestaAperto() { return App.paginaCorrente === 'richieste' && !!document.querySelector('#contenuto #rn-rep'); }

  /* ---------- i dati che i giri mostrano nelle viste di dettaglio (sempre gli stessi, finché i dati non cambiano) ---------- */

  function perData(campo) { return function (a, b) { return String(a[campo] || '').localeCompare(String(b[campo] || '')); }; }

  // una richiesta che la farmacia deve evadere: prima quelle appena inviate (si vede "Prendi in carico"), le urgenti in cima
  function richiestaDaEvadere() {
    if (!eFarmacia()) return null;
    var aperte = dati('richieste').filter(function (r) {
      return (r.stato === 'inviata' || r.stato === 'in_lavorazione') && App.repartoPermesso(r.fornitoreId);
    });
    aperte.sort(function (a, b) {
      return (a.stato === 'inviata' ? 0 : 1) - (b.stato === 'inviata' ? 0 : 1) ||
        (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0) || perData('inviataIl')(a, b);
    });
    return aperte[0] || null;
  }

  // un DDT pronto da spedire da un magazzino dell'utente
  function ddtDaSpedire() {
    if (!App.puo('ddt')) return null;
    return dati('ddt').filter(function (d) { return d.stato === 'in_preparazione' && App.repartoPermesso(d.origineId); })
      .sort(perData('preparatoIl'))[0] || null;
  }

  // un DDT in viaggio verso un magazzino dell'utente
  function ddtDaRicevere() {
    if (!App.puo('riceviDdt')) return null;
    return dati('ddt').filter(function (d) { return d.stato === 'in_transito' && App.repartoPermesso(d.destinazioneId); })
      .sort(perData('partitoIl'))[0] || null;
  }

  // numero del documento mostrato nell'intestazione del dettaglio (richiesta o DDT)
  function numeroMostrato() {
    var n = document.querySelector('#contenuto .log-intestazione .log-numero');
    return n ? n.textContent.trim() : '';
  }

  /* ---------- armadi ---------- */

  function conArmadi(repId) { return dati('armadi').some(function (a) { return a.repartoId === repId && a.attivo !== false; }); }

  function puoDisporreIn(repId) { return App.puo('ubicazioni') && App.repartoPermesso(repId); }

  // il magazzino da mostrare negli armadi: uno dei tuoi con armadi, altrimenti uno qualsiasi con armadi
  function magazzinoConArmadi() {
    var lista = App.repartiAttivi().filter(function (r) { return conArmadi(r.id); });
    return lista.filter(function (r) { return puoDisporreIn(r.id); })[0] || lista[0] || null;
  }

  function magazzinoMostrato() {
    var s = document.getElementById('ar-magazzino');
    return s ? s.value : null;
  }

  /* ---------- viste delle pagine (App.vai con i parametri) ---------- */

  var V_RICHIESTE = { segno: '#ric-pannello', parametri: {} };
  var V_RICHIESTA_NUOVA = { segno: '#rn-rep', parametri: { nuova: true } };
  var V_RICHIESTA_APERTA = {
    segno: function () { var r = richiestaDaEvadere(); return !!r && !!document.querySelector('#contenuto #ric-indietro') && numeroMostrato() === r.numero; },
    parametri: function () { var r = richiestaDaEvadere(); return r ? { id: r.id } : null; }
  };
  var V_DDT = { segno: '#ddt-pannello', parametri: {} };
  var V_DDT_DA_SPEDIRE = {
    segno: function () { var d = ddtDaSpedire(); return !!d && !!document.querySelector('#contenuto #ddt-indietro') && numeroMostrato() === d.numero; },
    parametri: function () { var d = ddtDaSpedire(); return d ? { id: d.id } : null; }
  };
  var V_DDT_DA_RICEVERE = {
    segno: function () { var d = ddtDaRicevere(); return !!d && !!document.querySelector('#contenuto #ddt-indietro') && numeroMostrato() === d.numero; },
    parametri: function () { var d = ddtDaRicevere(); return d ? { id: d.id } : null; }
  };
  var V_RICEZIONE = {
    segno: function () {
      var d = ddtDaRicevere();
      var t = document.querySelector('#contenuto .log-ricezione h2');
      return !!d && !!t && t.textContent.indexOf(d.numero) >= 0;
    },
    parametri: function () { var d = ddtDaRicevere(); return d ? { id: d.id, ricevi: true } : null; }
  };
  // gli armadi di un magazzino che ne ha (meglio uno dei tuoi)
  var V_ARMADI = {
    segno: function () {
      var m = magazzinoMostrato();
      if (!m || !conArmadi(m)) return false;
      if (puoDisporreIn(m)) return true;
      var x = magazzinoConArmadi();
      return !x || !puoDisporreIn(x.id);
    },
    parametri: function () { var x = magazzinoConArmadi(); return x ? { repartoId: x.id } : null; }
  };
  // gli armadi di un magazzino dove puoi disporre gli articoli
  var V_ARMADI_MIO = {
    segno: function () { var m = magazzinoMostrato(); return !!m && conArmadi(m) && puoDisporreIn(m); },
    parametri: function () { var x = magazzinoConArmadi(); return x && puoDisporreIn(x.id) ? { repartoId: x.id } : null; }
  };
  var V_MG_DATI = { segno: '#mg-tab-dati[aria-selected="true"]', parametri: { scheda: 'dati' } };
  var V_MG_ARMADI = { segno: '#mg-tab-armadi[aria-selected="true"]', parametri: { scheda: 'armadi' } };
  var V_MG_ASSORTIMENTO = { segno: '#mg-tab-assortimento[aria-selected="true"]', parametri: { scheda: 'assortimento' } };

  /* ---------- finestre e menu che il giro apre (e richiude) da solo ---------- */

  function pausa(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

  // il menu del tuo utente (in alto a destra): password, Sicurezza dell'account, tema, Esci.
  // Si apre come con un clic dell'utente (js/app.js segna il tema scelto e mostra le voci giuste).
  var TENDINA_UTENTE = {
    id: 'tendina-utente',
    aperto: function () { var t = document.getElementById('utente-tendina'); return !!t && !t.hidden; },
    apri: function () {
      var b = document.getElementById('utente-btn');
      if (!b || !document.getElementById('utente-tendina')) return null;
      b.click();
      return pausa(rid() ? 30 : 280); // la tendina entra con una breve animazione
    },
    chiudi: function () {
      var b = document.getElementById('utente-btn');
      if (b && TENDINA_UTENTE.aperto()) b.click();
    }
  };

  // la finestra "Sicurezza dell'account" (js/sicurezza.js): legge lo stato dal server, non cambia niente
  var FINESTRA_ACCOUNT = {
    id: 'finestra-account',
    aperto: function () {
      var m = document.getElementById('modale');
      return !!m && !m.hidden && !!m.querySelector('#sic-account');
    },
    apri: function () {
      if (!conAccount()) return null;
      App.Sicurezza.apriAccount();
      // aspetto lo stato letto dal server e che la finestra abbia finito di comparire (e di prendere il fuoco)
      return aspettaChe(function () { return document.querySelector('#sic-account .sic-stato, #sic-account .banda'); }, ATTESA_MAX)
        .then(function () { return pausa(rid() ? 80 : 320); });
    },
    chiudi: function () { if (FINESTRA_ACCOUNT.aperto()) App.chiudiModale(); }
  };

  // la modalità Disponi della pagina Armadi (pulsante "✋ Disponi" / "✓ Fine disposizione"): solo la vista cambia
  var MODO_DISPONI = {
    id: 'disponi',
    aperto: function () { var b = document.getElementById('ar-disponi'); return !!b && b.getAttribute('aria-pressed') === 'true'; },
    apri: function () {
      var b = document.getElementById('ar-disponi');
      if (!b || b.hidden) return null;
      b.click();
      return aspettaChe(function () { return document.querySelector('#ar-voci'); }, 1500);
    },
    chiudi: function () { if (MODO_DISPONI.aperto()) document.getElementById('ar-disponi').click(); }
  };

  /* ---------- pagina Previsioni: le sue schede e la finestra di dettaglio di un articolo (solo la vista cambia) ---------- */

  // due elementi uno accanto all'altro (computer) e non uno sotto l'altro (telefono)
  function affiancati(a, b) {
    var x = document.querySelector(a), y = document.querySelector(b);
    if (!x || !y) return root.innerWidth > 700;
    var rx = x.getBoundingClientRect(), ry = y.getBoundingClientRect();
    return Math.abs(rx.top - ry.top) < Math.min(rx.height, ry.height) / 2;
  }

  function schedaPrevisioniScelta() {
    var b = document.querySelector('#pv-schede [role="tab"][aria-selected="true"]');
    return b ? b.getAttribute('data-scheda') : null;
  }

  // il calcolo delle previsioni è finito: indicatori e scheda aperta sono disegnati (prima i clic sulle schede non valgono)
  function previsioniPronte() {
    var att = document.getElementById('pv-attesa');
    var pan = document.getElementById('pv-pannello');
    return !!att && att.hidden && !!pan && pan.children.length > 0;
  }

  function apriSchedaPrevisioni(id) {
    var b = document.getElementById('pv-tab-' + id);
    if (!b || b.hidden) return false;
    if (b.getAttribute('aria-selected') !== 'true') b.click();
    return true;
  }

  // la scheda "id" (fabbisogno, abc, ordine); chiudendo torna quella che l'utente aveva aperto
  function schedaPrevisioni(id) {
    var a = {
      id: 'previsioni-' + id,
      prima: null,
      aperto: function () { return previsioniPronte() && schedaPrevisioniScelta() === id; },
      apri: function () {
        if (!document.getElementById('pv-tab-' + id)) return null;
        return aspettaChe(previsioniPronte, ATTESA_MAX).then(function (pronte) {
          if (!pronte) return;
          a.prima = schedaPrevisioniScelta();
          if (!apriSchedaPrevisioni(id)) return;
          return aspettaChe(a.aperto, 1500);
        });
      },
      chiudi: function () {
        var prima = a.prima;
        a.prima = null;
        if (prima && prima !== id) apriSchedaPrevisioni(prima);
      }
    };
    return a;
  }

  var SCHEDA_FABBISOGNO = schedaPrevisioni('fabbisogno');
  var SCHEDA_ABC = schedaPrevisioni('abc');
  var SCHEDA_ORDINE = schedaPrevisioni('ordine');

  // la finestra di dettaglio del primo articolo della tabella del fabbisogno (grafico, giorni della settimana, modelli)
  var DETTAGLIO_PREVISIONE = {
    id: 'previsioni-dettaglio',
    scheda: null,
    aperto: function () {
      var m = document.getElementById('modale');
      return !!m && !m.hidden && !!m.querySelector('#pvd-grafico');
    },
    apri: function () {
      if (!document.getElementById('pv-schede')) return null;
      return aspettaChe(previsioniPronte, ATTESA_MAX).then(function (pronte) {
        if (!pronte) return;
        var prima = schedaPrevisioniScelta();
        if (prima !== 'fabbisogno' && apriSchedaPrevisioni('fabbisogno')) DETTAGLIO_PREVISIONE.scheda = prima;
        var b = document.querySelector('#pv-tabella .an-art-btn');
        if (!b) return;
        b.click();
        // aspetto il grafico dell'articolo e che la finestra abbia finito di comparire (e di prendere il fuoco)
        return aspettaChe(function () { return document.querySelector('#modale:not([hidden]) #pvd-grafico canvas'); }, ATTESA_MAX)
          .then(function () { return pausa(rid() ? 80 : 320); });
      });
    },
    chiudi: function () {
      if (DETTAGLIO_PREVISIONE.aperto()) App.chiudiModale();
      var prima = DETTAGLIO_PREVISIONE.scheda;
      DETTAGLIO_PREVISIONE.scheda = null;
      if (prima) apriSchedaPrevisioni(prima);
    }
  };

  /* ======================= i giri ======================= */

  var BARRA_LETTORE = {
    el: '.barra-scanner', facoltativo: true, posizione: 'sotto',
    titolo: 'Lettore di codici a barre',
    testo: 'Leggi la confezione con il lettore (o con la fotocamera del telefono): la riga si compila da sola, con lotto e scadenza se il codice li ha.'
  };

  function copia(o, extra) {
    var x = {};
    Object.keys(o).forEach(function (k) { x[k] = o[k]; });
    Object.keys(extra || {}).forEach(function (k) { x[k] = extra[k]; });
    return x;
  }

  // titoli dei gruppi nell'elenco dei giri (nell'ordine del menu)
  var GRUPPI = {
    inizio: 'Per cominciare',
    giorno: 'Lavoro di ogni giorno',
    magazzino: 'Magazzino',
    analisi: 'Analisi',
    archivio: 'Registri e archivio',
    amministrazione: 'Amministrazione'
  };

  var GIRI = [
    /* ---------------- per cominciare ---------------- */
    {
      id: 'benvenuto', gruppo: 'inizio', perPagina: 'oggi', pagina: 'oggi', ico: '👋',
      titolo: 'Primo giro del programma',
      descrizione: 'Menu, pagina Oggi con i numeri del giorno e le cose da fare, ricerca rapida, il tuo utente e la guida.',
      passi: [
        { titolo: function () { return 'Benvenuto in ' + nomeProdotto(); },
          testo: 'In un minuto ti mostro dove sono le cose. Vai avanti con <b>Avanti</b> o con la freccia <kbd>→</kbd>; esci quando vuoi con <kbd>Esc</kbd>.' },
        { el: '#menu', posizione: 'destra', riparo: 'fondo', titolo: 'Il menu',
          testo: 'Qui ci sono tutte le pagine che il tuo ruolo può usare, divise per argomento. Il numero accanto a una voce dice quante cose ti aspettano (richieste, DDT, scadenze). La lettera a destra è il <b>tasto rapido</b>: con la tastiera, premila (fuori dai campi) per aprire la pagina.' },
        { el: '.azioni-rapide', facoltativo: true, posizione: 'sotto', titolo: 'Il lavoro di ogni giorno',
          testo: 'I pulsanti per le operazioni più frequenti del tuo ruolo, con il loro tasto rapido.' },
        { el: '#cr-vista', facoltativo: true, posizione: 'sotto', titolo: 'Quale magazzino guardare',
          testo: function () {
            return (soloSuoiMagazzini() ? 'Tutti i tuoi magazzini' : 'Tutta la struttura') + ' oppure un magazzino solo: numeri, grafici ed elenchi della pagina cambiano subito.';
          } },
        { el: '#contenuto .indicatori', posizione: 'sotto', titolo: 'I numeri di oggi',
          testo: 'Valore della merce, articoli sotto scorta, lotti scaduti e in scadenza, richieste e DDT da seguire, consumi di oggi. Tocca un numero per aprire l’elenco completo.' },
        { el: '#cr-andamento', facoltativo: true, posizione: 'destra', titolo: 'Andamento dei consumi',
          testo: 'I consumi degli ultimi 30 giorni, in unità o in euro, con la media degli ultimi 7 giorni. Passa sopra una barra (o toccala) per leggere il giorno.' },
        { el: '#cr-fare', facoltativo: true, posizione: 'sinistra', titolo: 'Cosa fare adesso',
          testo: 'Le cose da sbrigare, dalla più urgente: richieste da evadere, DDT da spedire o da ricevere, lotti scaduti da togliere, articoli da riordinare. Un clic e sei sulla pagina giusta.' },
        { el: '#apri-ricerca', posizione: 'sotto', titolo: 'Ricerca rapida',
          testo: 'Premi <kbd>Ctrl</kbd> <kbd>K</kbd> (oppure <kbd>/</kbd>) da qualsiasi pagina, scrivi il nome di un articolo o di una pagina e premi Invio.' },
        { el: '#utente-btn', posizione: 'sotto', titolo: 'Il tuo utente',
          testo: 'Il pulsante con le tue iniziali apre il menu del tuo utente. Te lo apro io.' },
        { el: '#utente-tendina', ambiente: TENDINA_UTENTE, posizione: 'sinistra', titolo: 'Password, sicurezza e tema',
          testo: function () {
            return 'Da qui cambi la password' + (conAccount() ? ', apri <b>Sicurezza dell’account</b> (la verifica in due passaggi con il telefono)' : '') +
              ', scegli il tema dello schermo (<b>chiaro</b>, <b>scuro</b> o <b>automatico</b>) ed esci. Se il computer è condiviso, esci sempre a fine turno.';
          } },
        { el: '#collegamento', facoltativo: true, posizione: 'sotto', titolo: 'Collegamento al server',
          testo: '<b>● In linea</b>: quello che registrano gli altri lo vedi subito. Se compare <b>⚠ Server non raggiungibile</b>, non registrare finché il collegamento non torna.' },
        { el: '#guidami', posizione: 'sotto', titolo: 'Guidami',
          testo: 'In ogni pagina questo pulsante ti mostra, passo per passo, cosa fare lì. Dalla pagina Guida ti propone tutti i giri.' },
        { el: '#menu a[data-pagina="guida"]', posizione: 'destra', titolo: 'Guida e videoguide',
          testo: 'Nella Guida trovi le istruzioni scritte e i video di ogni operazione. Buon lavoro!' }
      ]
    },
    {
      id: 'account', gruppo: 'inizio', pagina: null, ico: '🔐', se: conAccount,
      titolo: 'Sicurezza dell’account',
      descrizione: 'Attivare la verifica in due passaggi con il telefono: app, codice QR e codici di recupero.',
      passi: [
        { titolo: 'Verifica in due passaggi',
          testo: 'Oltre alla password, per entrare serve un codice di 6 cifre che un’app sul tuo telefono cambia ogni 30 secondi. Se qualcuno scopre la tua password, senza il tuo telefono non entra.' },
        { el: '#utente-btn', posizione: 'sotto', titolo: 'Il menu del tuo utente',
          testo: 'Si parte dal pulsante con le tue iniziali, in alto a destra.' },
        { el: '#utente-sicurezza', ambiente: TENDINA_UTENTE, posizione: 'sinistra', titolo: 'Sicurezza dell’account',
          testo: 'Questa voce apre la finestra della sicurezza del tuo utente. Te la apro io.' },
        { el: '#sic-account .sic-stato', ambiente: FINESTRA_ACCOUNT, posizione: 'sotto', titolo: 'A che punto sei',
          testo: 'Qui vedi se la verifica è attiva e da quando. Se l’amministratore la chiede al tuo ruolo c’è scritto: allora non si può togliere.' },
        { el: '#sic-attiva', ambiente: FINESTRA_ACCOUNT, facoltativo: true, posizione: 'sopra', titolo: 'Attivala in tre passi',
          testo: '<b>1.</b> Installa sul telefono un’app come Google Authenticator, Microsoft Authenticator o FreeOTP. <b>2.</b> Premi questo pulsante, inquadra con l’app il codice QR che compare e scrivi il codice di 6 cifre che l’app ti mostra. <b>3.</b> Salva i <b>10 codici di recupero</b>: scaricali, stampali o copiali.' },
        { el: '#sic-nuovi-codici', ambiente: FINESTRA_ACCOUNT, facoltativo: true, posizione: 'sopra', titolo: 'Nuovi codici di recupero',
          testo: 'Quando ne restano pochi creane di nuovi (serve la password): quelli vecchi smettono di valere.' },
        { el: '#sic-cambia', ambiente: FINESTRA_ACCOUNT, facoltativo: true, posizione: 'sopra', titolo: 'Telefono nuovo',
          testo: 'Hai cambiato telefono o reinstallato l’app? Per sicurezza scrivi la tua password, poi collega di nuovo l’app con un codice QR nuovo: il telefono vecchio smette di valere.' },
        { ambiente: FINESTRA_ACCOUNT, titolo: 'I codici di recupero',
          testo: 'Servono per entrare se non hai il telefono: ognuno vale una volta sola. Tienili lontano dal computer, per esempio stampati in un cassetto chiuso. Se perdi telefono e codici, l’amministratore può azzerare la verifica del tuo utente.' },
        { ambiente: FINESTRA_ACCOUNT, titolo: 'Come si entra dopo',
          testo: 'Scrivi utente e password come sempre, poi il codice dell’app. Sul computer che usi di solito puoi spuntare <b>Ricorda questo computer per 30 giorni</b>: per un mese lì non te lo chiede più.' }
      ]
    },

    /* ---------------- lavoro di ogni giorno ---------------- */
    {
      id: 'carico', gruppo: 'giorno', perPagina: 'carico', pagina: 'carico', ico: '📥',
      titolo: 'Carico della merce',
      descrizione: 'Registrare la merce arrivata dal fornitore, con lotto e scadenza.',
      passi: [
        { el: '#contenuto .scheda .modulo', posizione: 'sotto', titolo: 'Intestazione del carico',
          testo: 'Data, magazzino che riceve (di solito la farmacia centrale), fornitore e numero del documento di trasporto o della fattura.' },
        BARRA_LETTORE,
        { el: '#righe tr:first-child .r-art', posizione: 'sotto', titolo: 'Articolo',
          testo: 'Scrivi le prime lettere e scegli dall’elenco. Sotto compare la giacenza attuale del magazzino.' },
        { el: '#righe tr:first-child .r-q', posizione: 'sotto', titolo: 'Quantità',
          testo: 'Quante unità sono arrivate: compresse, fiale, pezzi… come l’unità dell’articolo.' },
        { el: '#righe tr:first-child .r-lotto, #righe tr:first-child .r-scad', insieme: true, posizione: 'sotto', titolo: 'Lotto e scadenza',
          testo: 'Copiali dalla confezione: servono al controllo delle scadenze e ai lotti che escono per primi.' },
        { el: '#righe tr:first-child .r-prezzo', posizione: 'sotto', titolo: 'Prezzo unitario',
          testo: 'Facoltativo. Se lo scrivi, diventa il prezzo dell’articolo usato nella nota consumi.' },
        { el: '#riga-piu', posizione: 'sopra', titolo: 'Una riga per articolo',
          testo: 'Aggiungi una riga per ogni articolo. <kbd>Invio</kbd> passa alla riga sotto; la ✕ toglie una riga.' },
        { el: '#nuovo-art', se: puo('articoli'), facoltativo: true, posizione: 'sopra', titolo: 'Articolo nuovo',
          testo: 'Se l’articolo non c’è ancora, crealo da qui senza perdere il carico che stai scrivendo.' },
        { el: '#registra', posizione: 'sopra', titolo: 'Registra il carico',
          testo: 'Controlla le righe e premi <b>Registra carico</b>: la giacenza si aggiorna subito, per tutti.' },
        { el: '#recenti', facoltativo: true, posizione: 'sopra', titolo: 'Ultimi carichi',
          testo: 'Se hai sbagliato, premi <b>Annulla</b> sulla riga e scrivi il motivo: il movimento resta, barrato.' }
      ]
    },
    {
      id: 'consumi', gruppo: 'giorno', perPagina: 'consumi', pagina: 'consumi', ico: '💊',
      titolo: 'Consumi del giorno',
      descrizione: 'Il foglio dei consumi di un reparto: scrivi le quantità usate e registra.',
      passi: [
        { el: '#c-data, #c-rep', insieme: true, posizione: 'sotto', titolo: 'Giorno e reparto',
          testo: 'Scegli la data e il reparto (il suo magazzino). Vedi solo quelli in cui puoi registrare.' },
        copia(BARRA_LETTORE, { testo: 'Ogni lettura aggiunge il consumo dell’articolo letto: una unità, o una confezione intera se lo scegli.' }),
        { el: '#c-cat, #c-cerca', insieme: true, posizione: 'sotto', titolo: 'Trova in fretta',
          testo: 'Filtra per categoria (farmaci o presidi) o scrivi parte del nome.' },
        { el: '#c-tutti', risali: '.spunta', posizione: 'sotto', titolo: 'Articoli senza giacenza',
          testo: 'Di solito vedi solo gli articoli presenti nel magazzino del reparto. Spunta qui se quello che cerchi non c’è.' },
        { el: '#c-foglio input.q', facoltativo: true, posizione: 'sinistra', titolo: 'Quantità usate',
          testo: 'Scrivi quante unità sono state usate. <kbd>Invio</kbd> passa alla riga sotto; le righe compilate diventano verdi.' },
        { el: '#c-registra', posizione: 'sotto', titolo: 'Registra consumi',
          testo: 'Un clic registra tutte le righe compilate. Se la giacenza non basta, il programma te lo chiede prima.' },
        { el: '#c-fatti', posizione: 'sopra', titolo: 'Già registrati',
          testo: 'Qui sotto ci sono i consumi di quel giorno. Un errore? <b>Annulla</b> sulla riga, con il motivo.' }
      ]
    },
    {
      id: 'richieste', gruppo: 'giorno', perPagina: 'richieste', pagina: 'richieste', ico: '📝', se: puoChiedere,
      // "Guidami" sul modulo di una richiesta: questo giro anche per la farmacia
      qui: moduloRichiestaAperto,
      titolo: 'Chiedere merce alla farmacia',
      descrizione: 'Richiesta dal magazzino di piano: lettore, «Proponi le quantità», invio e attesa del DDT.',
      passi: [
        { el: '.log-schede', vista: V_RICHIESTE, posizione: 'sotto', titolo: 'Le richieste',
          testo: function () {
            return '<b>Da inviare</b>: le bozze salvate. ' + (eFarmacia()
              ? '<b>Da evadere</b>: quelle arrivate alla farmacia. '
              : '<b>In attesa</b>: quelle inviate, finché la farmacia non ha spedito tutto. ') +
              '<b>Archivio</b>: evase, chiuse, rifiutate o annullate. Il numero dice quante sono.';
          } },
        { el: '#ric-cerca', vista: V_RICHIESTE, posizione: 'sotto', titolo: 'Cerca',
          testo: 'Per numero (per esempio RIC-2026-0012), per magazzino o per nome di un articolo.' },
        { el: '#ric-nuova', vista: V_RICHIESTE, posizione: 'sotto', titolo: 'Nuova richiesta',
          testo: 'Apre il modulo per chiedere alla farmacia quello che serve al tuo magazzino. Ti mostro com’è fatto.' },
        { el: '#rn-rep, #rn-forn', insieme: true, vista: V_RICHIESTA_NUOVA, posizione: 'sotto', titolo: 'Chi chiede, a chi',
          testo: 'Il magazzino che chiede (il tuo) e a chi chiedi: di solito la farmacia centrale, già scelta.' },
        { el: '#rn-urgente', risali: '.spunta', vista: V_RICHIESTA_NUOVA, posizione: 'sotto', titolo: 'Urgente',
          testo: 'Spunta solo se serve subito: la farmacia vede la richiesta in cima all’elenco, in rosso.' },
        copia(BARRA_LETTORE, { vista: V_RICHIESTA_NUOVA,
          testo: 'Leggi le confezioni con il lettore (o con la fotocamera): ogni lettura aggiunge l’articolo alla richiesta, o ne aumenta la quantità.' }),
        { el: '#rn-proponi', vista: V_RICHIESTA_NUOVA, posizione: 'sotto', titolo: 'Proponi le quantità',
          testo: 'Il programma guarda l’assortimento del magazzino: per gli articoli arrivati al punto di riordino propone quanto serve per tornare alla scorta massima e coprire il consumo previsto. Contano anche la merce in viaggio e le richieste già aperte. Controlla e correggi prima di inviare.' },
        { el: '#righe tr:first-child .r-art, #righe tr:first-child .r-q', insieme: true, vista: V_RICHIESTA_NUOVA, posizione: 'sotto', titolo: 'Articoli e quantità',
          testo: 'Scrivi le prime lettere, scegli dall’elenco e scrivi la quantità. Sotto la riga vedi la giacenza del magazzino, la sua scorta e quanto ne ha libero la farmacia.' },
        { el: '#rn-note', vista: V_RICHIESTA_NUOVA, posizione: 'sotto', titolo: 'Note per la farmacia',
          testo: 'Facoltative: per esempio «per il paziente del letto 12» o «servono entro le 14».' },
        { el: '#rn-bozza, #rn-invia', insieme: true, vista: V_RICHIESTA_NUOVA, posizione: 'sopra', titolo: 'Salva o invia',
          testo: '<b>Salva come bozza</b> la tiene da parte (la ritrovi in «Da inviare»). <b>Invia la richiesta</b> la manda alla farmacia, che riceve subito un avviso. Finché la farmacia non la prende in carico puoi ancora modificarla o annullarla.' },
        { el: '.log-schede', vista: V_RICHIESTE, posizione: 'sotto', titolo: 'E poi?',
          testo: 'La farmacia approva le quantità e prepara il DDT. Quando la merce parte la trovi in <b>DDT e consegne</b>, nella scheda «Da ricevere»: lì registri la ricezione.' }
      ]
    },
    {
      id: 'richieste-evadi', gruppo: 'giorno', perPagina: 'richieste', pagina: 'richieste', ico: '✋', se: puo('evadiRichieste'),
      qui: function () { return eFarmacia() && !moduloRichiestaAperto(); },
      titolo: 'Evadere le richieste',
      descrizione: 'Farmacia centrale: prendere in carico una richiesta, approvare le quantità e preparare il DDT.',
      passi: [
        { el: '#ric-evadere', vista: V_RICHIESTE, posizione: 'sotto', titolo: 'Da evadere',
          testo: 'Le richieste arrivate dai magazzini di piano: le urgenti in cima, poi dalla più vecchia. Il numero nel menu ti dice quante sono.' },
        { el: '#ric-pannello .log-voce', vista: V_RICHIESTE, facoltativo: true, posizione: 'sotto', titolo: 'Una richiesta',
          testo: 'Numero, magazzino che chiede, primi articoli e quanto è già partito. Tocca la richiesta per aprirla: te ne apro una io.' },
        { el: '.log-intestazione', vista: V_RICHIESTA_APERTA, facoltativo: true, posizione: 'sotto', titolo: 'Chi chiede e che cosa',
          testo: 'Numero, stato, urgenza e note del reparto. La barra dice quanta merce approvata è già partita.' },
        { el: '#ric-prendi', vista: V_RICHIESTA_APERTA, facoltativo: true, posizione: 'sotto', titolo: 'Prendi in carico',
          testo: 'Il reparto vede che te ne stai occupando e da quel momento non può più cambiarla. Anche «Prepara DDT» la prende in carico da solo.' },
        { el: '.ric-appr', vista: V_RICHIESTA_APERTA, facoltativo: true, posizione: 'sotto', titolo: 'Quantità approvata',
          testo: 'All’inizio è quella chiesta: puoi approvarne meno, o di più per arrivare alla confezione intera. La colonna <b>Libera</b> dice quanto ne hai, senza la merce già messa in altri DDT.' },
        { el: '#ric-prepara', vista: V_RICHIESTA_APERTA, facoltativo: true, posizione: 'sotto', titolo: 'Prepara DDT',
          testo: 'Prepara il documento di trasporto con quello che resta da spedire, scegliendo i lotti che scadono prima. Se in farmacia manca qualcosa te lo dice: il resto lo spedisci con un altro DDT.' },
        { el: '#ric-rifiuta, #ric-chiudi', insieme: true, vista: V_RICHIESTA_APERTA, facoltativo: true, posizione: 'sotto', titolo: 'Rifiuta o chiudi',
          testo: '<b>Rifiuta</b> se non si può evadere, scrivendo il motivo. Dopo un DDT parziale, <b>Chiudi con residuo</b> chiude la richiesta senza spedire il resto.' },
        { el: '.log-scheda-cron', vista: V_RICHIESTA_APERTA, facoltativo: true, posizione: 'sinistra', titolo: 'Cronologia',
          testo: 'Chi ha chiesto, chi ha preso in carico, chi ha preparato, chi ha portato la merce e chi l’ha ricevuta, con data e ora.' },
        { el: '.log-schede', vista: V_RICHIESTE, posizione: 'sotto', titolo: 'Dopo il DDT',
          testo: 'Il DDT preparato lo trovi in <b>DDT e consegne</b>, nella scheda «Da preparare»: lì scegli chi porta la merce e lo spedisci.' }
      ]
    },
    {
      id: 'consegne', gruppo: 'giorno', perPagina: 'consegne', pagina: 'consegne', ico: '🚚',
      titolo: 'DDT e consegne',
      descrizione: 'Spedire un DDT con chi lo trasporta, stamparlo con QR e firme, riceverlo con il lettore e segnare le differenze.',
      passi: [
        { el: '.log-schede', vista: V_DDT, posizione: 'sotto', titolo: 'Le schede',
          testo: function () {
            return (App.puo('ddt') ? '<b>Da preparare</b>: DDT pronti, ancora da spedire. ' : '') +
              '<b>In viaggio</b>: merce partita e non ancora arrivata. ' +
              (App.puo('riceviDdt') ? '<b>Da ricevere</b>: DDT in arrivo nei tuoi magazzini. ' : '') +
              '<b>Archivio</b>: ricevuti o annullati. Il numero dice quanti sono.';
          } },
        copia(BARRA_LETTORE, { vista: V_DDT, titolo: 'Leggi il DDT',
          testo: 'Leggi con il lettore il codice a barre o il QR stampato sul DDT: si apre da solo. Puoi anche scrivere il numero (per esempio DDT-2026-0007) e premere Invio.' }),
        { el: '#ddt-cerca', vista: V_DDT, posizione: 'sotto', titolo: 'Cerca',
          testo: 'Per numero, magazzino, trasportatore o causale.' },
        { el: '#ddt-nuovo', vista: V_DDT, facoltativo: true, posizione: 'sotto', titolo: 'Nuovo DDT',
          testo: 'Per spostare merce senza una richiesta, anche un reso alla farmacia: apre la pagina Trasferimenti.' },
        { el: '.log-intestazione', vista: V_DDT_DA_SPEDIRE, facoltativo: true, posizione: 'sotto', titolo: 'Un DDT da spedire',
          testo: 'Te ne apro uno. In alto: numero, da quale magazzino a quale, causale, colli e la richiesta da cui è nato. Finché non parte, le giacenze non cambiano.' },
        { el: '#ddt-modifica', vista: V_DDT_DA_SPEDIRE, facoltativo: true, posizione: 'sotto', titolo: 'Modifica righe',
          testo: 'Prima della partenza puoi cambiare righe, lotti, causale e colli, oppure annullare il DDT.' },
        { el: '#ddt-stampa', vista: V_DDT_DA_SPEDIRE, facoltativo: true, posizione: 'sotto', titolo: 'Stampa con QR e firme',
          testo: 'Il DDT su un foglio A4: codice a barre e QR del numero, articoli con lotto e scadenza, e gli spazi per le firme di chi prepara, di chi trasporta e di chi riceve. Mettilo nella scatola.' },
        { el: '#ddt-spedisci', vista: V_DDT_DA_SPEDIRE, facoltativo: true, posizione: 'sotto', titolo: 'Spedisci',
          testo: 'Scegli chi porta la merce (un collega dall’elenco, oppure scrivi nome e cognome) e quanti colli. Da quel momento la merce è <b>in viaggio</b>: esce dal magazzino di partenza e chi la riceve vede l’avviso.' },
        { el: '.log-codici', vista: V_DDT_DA_SPEDIRE, facoltativo: true, posizione: 'sopra', titolo: 'Codice a barre e QR',
          testo: 'Contengono il numero del DDT: chi lo riceve lo legge con il lettore e il DDT si apre da solo.' },
        { el: '#ddt-ricevi', vista: V_DDT_DA_RICEVERE, facoltativo: true, posizione: 'sotto', titolo: 'Registra la ricezione',
          testo: 'Ecco un DDT in arrivo. Quando la merce arriva, controlla le confezioni e premi qui: ti mostro il modulo.' },
        { el: '.log-tab-ricezione', vista: V_RICEZIONE, facoltativo: true, posizione: 'sopra', titolo: 'Quanto è arrivato',
          testo: 'Una riga per articolo e lotto. La quantità ricevuta è già quella partita: correggi solo quello che manca.' },
        copia(BARRA_LETTORE, { vista: V_RICEZIONE, titolo: 'Conta con il lettore',
          testo: 'Leggi le confezioni una per una: la quantità ricevuta diventa quella letta, e quelle che non leggi risultano mancanti.' }),
        { el: '.log-tab-ricezione .rc-esito', vista: V_RICEZIONE, facoltativo: true, posizione: 'sotto', titolo: 'Se manca qualcosa',
          testo: 'Scegli se la differenza <b>rientra</b> nel magazzino che l’ha spedita o se è <b>persa in viaggio</b> (rotta, smarrita). Nella <b>Nota</b> puoi scrivere cosa è successo.' },
        { el: '#rc-conferma', vista: V_RICEZIONE, facoltativo: true, posizione: 'sopra', titolo: 'Conferma la ricezione',
          testo: 'La merce entra nel tuo magazzino e il DDT va in archivio come ricevuto, o ricevuto con differenze. Chi l’ha spedito lo vede subito.' },
        { el: '.log-schede', vista: V_DDT, posizione: 'sotto', titolo: 'Tutto tracciato',
          testo: 'Ogni DDT conserva chi l’ha preparato, chi l’ha portato, chi l’ha ricevuto e quando, con le eventuali differenze: lo ritrovi in <b>Archivio</b>.' }
      ]
    },
    {
      id: 'trasferimenti', gruppo: 'giorno', perPagina: 'trasferimenti', pagina: 'trasferimenti', ico: '🔁',
      titolo: 'Trasferimenti con un DDT',
      descrizione: 'Spostare merce fra due magazzini, anche i resi alla farmacia, preparando un DDT.',
      passi: [
        { el: '#t-da, #t-a', insieme: true, posizione: 'sotto', titolo: 'Da dove, a dove',
          testo: 'Il magazzino che spedisce e quello che riceve: dalla farmacia a un piano, fra due piani, oppure un reso alla farmacia.' },
        BARRA_LETTORE,
        { el: '#t-causale, #t-colli', insieme: true, posizione: 'sotto', titolo: 'Causale e colli',
          testo: 'La causale si scrive da sola (rifornimento, reso alla farmacia, trasferimento interno): cambiala se serve. I colli sono le scatole che partono.' },
        { el: '#righe tr:first-child .r-art, #righe tr:first-child .r-q', insieme: true, posizione: 'sotto', titolo: 'Articolo e quantità',
          testo: 'Scegli l’articolo e scrivi quanto spedisci. Sotto vedi la giacenza del magazzino di partenza e quanta è libera (senza la merce già messa in altri DDT).' },
        { el: '#righe tr:first-child .r-lotto-scelta', posizione: 'sotto', titolo: 'Lotto',
          testo: 'Lascia <b>automatico</b>: parte per primo il lotto che scade prima. Scegline uno solo se spedisci proprio quello.' },
        { el: '#t-note', posizione: 'sotto', titolo: 'Note',
          testo: 'Chi ritira, per quale paziente o richiesta… quello che serve per ritrovarlo.' },
        { el: '#registra', posizione: 'sopra', titolo: 'Prepara il DDT',
          testo: 'Il DDT nasce <b>da spedire</b>: le giacenze non cambiano ancora. Lo spedisci da <b>DDT e consegne</b>, scegliendo chi porta la merce; chi la riceve registra la ricezione.' },
        { el: '#recenti', facoltativo: true, posizione: 'sopra', titolo: 'Ultimi DDT preparati qui',
          testo: 'Un clic apre il DDT: da lì lo stampi, lo spedisci o lo annulli.' }
      ]
    },
    {
      id: 'perdite', gruppo: 'giorno', perPagina: 'perdite', pagina: 'perdite', ico: '🗑️',
      titolo: 'Perdite e scaduti',
      descrizione: 'Confezioni scadute, rotte, smarrite o rese al fornitore.',
      passi: [
        { el: '#t-data, #t-rep', insieme: true, posizione: 'sotto', titolo: 'Data e magazzino',
          testo: 'Il giorno e il magazzino da cui escono le confezioni.' },
        BARRA_LETTORE,
        { el: '#righe tr:first-child .r-art, #righe tr:first-child .r-q', insieme: true, posizione: 'sotto', titolo: 'Articolo e quantità',
          testo: 'Cosa togli dal magazzino e quante unità.' },
        { el: '#righe tr:first-child .r-lotto-scelta', posizione: 'sotto', titolo: 'Lotto',
          testo: 'Per uno scaduto scegli il lotto scaduto. Dalla pagina Scadenze, <b>Togli dal magazzino</b> compila tutto da solo.' },
        { el: '#righe tr:first-child .r-causale', posizione: 'sotto', titolo: 'Causale',
          testo: 'Scaduto, rotto, smarrito, reso al fornitore… Nella nota consumi finisce nella colonna <b>Perdite</b>.' },
        { el: '#registra', posizione: 'sopra', titolo: 'Registra perdita',
          testo: 'Controlla e registra. Si può sempre annullare, con il motivo.' }
      ]
    },
    {
      id: 'scanner', gruppo: 'giorno', pagina: paginaLettore, se: conLettore, ico: '📷',
      titolo: 'Lettore di codici a barre',
      descrizione: 'Caricare, scaricare, chiedere e ricevere merce leggendo le confezioni, con il lettore o la fotocamera.',
      passi: [
        { titolo: 'Lettore di codici a barre',
          testo: 'Puoi leggere le confezioni con un <b>lettore USB o Bluetooth</b>, oppure con la <b>fotocamera</b> del telefono o del tablet.' },
        { el: '.barra-scanner', facoltativo: true, posizione: 'sotto', titolo: 'La barra di lettura',
          testo: 'Compare in cima alle pagine dove registri: carico, consumi, trasferimenti, perdite, inventario, nuova richiesta, DDT e ricezione dei DDT.' },
        { el: '#scanner-campo', facoltativo: true, posizione: 'sotto', titolo: 'Campo di lettura',
          testo: 'Clicca qui e leggi il codice. Se il lettore non lo legge, scrivi il codice a mano e premi <kbd>Invio</kbd>. Il lettore funziona anche con il cursore in un altro campo.' },
        { el: '#scanner-modo', facoltativo: true, posizione: 'sotto', titolo: 'Quanto vale una lettura',
          testo: 'Una <b>unità</b> o una <b>confezione</b> intera (i pezzi per confezione si scrivono nell’articolo). La scelta si ricorda per ogni pagina.' },
        { el: '#scanner-fotocamera', facoltativo: true, posizione: 'sotto', titolo: 'Fotocamera',
          testo: 'Inquadra il codice: la finestra si chiude alla prima lettura, oppure scegli la lettura continua per molte confezioni.' },
        { titolo: 'Codice sconosciuto',
          testo: 'Se il programma non conosce il codice te lo dice. Chi gestisce gli articoli lo collega a un articolo (o ne crea uno nuovo): da quel momento viene riconosciuto.' },
        { titolo: 'Nelle altre pagine',
          testo: 'In Oggi, Giacenze e Scadenze una lettura apre la scheda dell’articolo; in Armadi mostra dove si trova; in DDT e consegne il codice o il QR di un DDT apre il DDT.' }
      ]
    },

    /* ---------------- magazzino ---------------- */
    {
      id: 'struttura', gruppo: 'magazzino', perPagina: 'struttura', pagina: 'struttura', ico: '🏥',
      titolo: 'Struttura: la mappa dei piani',
      descrizione: 'L’edificio piano per piano con i magazzini, e i DDT in viaggio da un piano all’altro.',
      passi: [
        { el: '.st-sommario', posizione: 'sotto', titolo: 'In breve',
          testo: 'Quanti magazzini e piani ci sono, gli articoli sotto scorta in tutta la struttura e i DDT in viaggio adesso.' },
        { el: '#st-corpo', posizione: 'sopra', titolo: 'Lo spaccato dell’edificio',
          testo: 'Ogni piano con i suoi magazzini, come in un disegno dell’edificio: i piani alti in alto, il piano terra (e il seminterrato) in basso. La farmacia centrale ha la croce ✚.' },
        { el: '.st-stanza', posizione: 'sotto', titolo: 'Un magazzino',
          testo: 'Nome, articoli sotto scorta, lotti in scadenza, richieste e DDT in arrivo, quanti armadi e articoli ha e chi ne è responsabile. Toccalo per vedere i suoi armadi.' },
        { el: '.st-viaggio', facoltativo: true, posizione: 'sopra', titolo: 'DDT in viaggio',
          testo: 'Ogni DDT partito e non ancora ricevuto, con chi lo sta portando. Sulla mappa è un punto che va dal magazzino che spedisce a quello che riceve, passando dal vano scale. <b>Apri</b> mostra il DDT.' },
        { el: '#st-gestisci', se: puo('struttura'), facoltativo: true, posizione: 'sotto', titolo: 'Gestisci magazzini',
          testo: 'Per aggiungere un magazzino o cambiarne piano, colore e descrizione: pagina <b>Magazzini e assortimento</b>.' }
      ]
    },
    {
      id: 'armadi', gruppo: 'magazzino', perPagina: 'armadi', pagina: 'armadi', ico: '🗄️',
      titolo: 'Armadi: dove si trova ogni cosa',
      descrizione: 'Trovare un farmaco negli armadi (anche con il lettore), leggere il pannello, disporre gli articoli trascinandoli.',
      passi: [
        { el: '#ar-magazzino', vista: V_ARMADI, posizione: 'sotto', titolo: 'Magazzino',
          testo: 'Scegli il magazzino: sotto compaiono i suoi armadi.' },
        { el: '#ar-cerca', vista: V_ARMADI, posizione: 'sotto', titolo: 'Dove si trova?',
          testo: 'Scrivi il nome di un farmaco: si apre l’armadio giusto e la sua scatola lampeggia. Puoi anche leggere la confezione con il lettore di codici a barre, da qualsiasi punto della pagina.' },
        { el: '#ar-armadi', vista: V_ARMADI, facoltativo: true, posizione: 'sotto', titolo: 'Gli armadi del magazzino',
          testo: 'Armadi, frigorifero, cassettiere, carrelli e cassaforte. La barra colorata sotto il nome dice se dentro c’è qualcosa da controllare.' },
        { el: '#ar-vista', vista: V_ARMADI, posizione: 'destra', titolo: 'L’armadio aperto',
          testo: 'Ogni scatola è un articolo al suo posto (ripiano e posto). Colore e segno dicono lo stato: in ordine, da riordinare, sotto scorta, in scadenza. L’altezza dice quanta merce c’è rispetto alla scorta massima. Tocca una scatola per i dettagli.' },
        { el: '#ar-legenda', vista: V_ARMADI, facoltativo: true, posizione: 'sopra', titolo: 'Legenda',
          testo: 'Tocca uno stato per far risaltare solo quelle scatole; toccalo di nuovo per vederle tutte.' },
        { el: '#ar-lato', vista: V_ARMADI, posizione: 'sinistra', titolo: 'Il pannello',
          testo: 'Il riepilogo dell’armadio. Dopo aver toccato una scatola: giacenza, scorte, lotti e scadenze dell’articolo, con i pulsanti per consumi, perdite, richiesta alla farmacia e scheda dell’articolo.' },
        { el: '#ar-disponi', vista: V_ARMADI_MIO, se: puo('ubicazioni'), facoltativo: true, posizione: 'sotto', titolo: 'Disponi',
          testo: 'Per sistemare gli articoli negli armadi dei tuoi magazzini. Te lo apro io: niente si sposta finché non lo fai tu.' },
        { el: '#ar-voci', vista: V_ARMADI_MIO, ambiente: MODO_DISPONI, se: puo('ubicazioni'), facoltativo: true, posizione: 'sinistra', titolo: 'Trascina al posto giusto',
          testo: 'Trascina un articolo dall’elenco in una casella dell’armadio (con il mouse, o con il dito sulla maniglia ⠿). Trascina una scatola su un’altra casella per spostarla, oppure qui sull’elenco per toglierla. Da tastiera: <b>Metti</b>, poi le frecce e Invio.' },
        { el: '#ar-auto', vista: V_ARMADI_MIO, ambiente: MODO_DISPONI, se: puo('ubicazioni'), facoltativo: true, posizione: 'sotto', titolo: 'Disposizione automatica',
          testo: 'Sistema da sola gli articoli ancora senza posto, per categoria e per nome, ripiano dopo ripiano. Gli articoli da frigorifero vanno nel frigorifero, gli stupefacenti nella cassaforte. <b>Svuota</b> toglie tutto dall’armadio.' },
        { el: '#ar-disponi', vista: V_ARMADI_MIO, ambiente: MODO_DISPONI, se: puo('ubicazioni'), facoltativo: true, posizione: 'sotto', titolo: 'Ogni spostamento si salva',
          testo: 'Gli spostamenti si salvano subito e li vedono tutti. Quando hai finito premi <b>✓ Fine disposizione</b> (lo stesso pulsante) per tornare alla vista normale.' }
      ]
    },
    {
      id: 'giacenze', gruppo: 'magazzino', perPagina: 'giacenze', pagina: 'giacenze', ico: '📦',
      titolo: 'Giacenze',
      descrizione: 'Quanto c’è in ogni magazzino, valore della merce, articoli sotto scorta.',
      passi: [
        { el: '#g-rep', posizione: 'sotto', titolo: 'Magazzino',
          testo: '<b>Tutti</b> mette un magazzino per colonna; scegliendone uno vedi anche la prossima scadenza.' },
        { el: '#g-cat, #g-cerca', insieme: true, posizione: 'sotto', titolo: 'Cerca',
          testo: 'Per categoria, nome, principio attivo o codice.' },
        { el: '#g-sotto', risali: '.spunta', posizione: 'sotto', titolo: 'Solo sotto scorta',
          testo: 'Gli articoli sotto la scorta minima: quella dell’assortimento di ogni magazzino (per la farmacia centrale anche quella dell’anagrafica). È la lista da riordinare.' },
        { el: '#g-tab', posizione: 'sopra', titolo: 'La tabella',
          testo: 'Tocca una riga per aprire la scheda dell’articolo, con lotti e ultimi movimenti. In fondo il valore della merce.' },
        { el: '#g-stampa, #g-excel', insieme: true, posizione: 'sotto', titolo: 'Stampa ed Excel',
          testo: 'Stampano o esportano esattamente quello che vedi, con gli stessi filtri.' }
      ]
    },
    {
      id: 'scadenze', gruppo: 'magazzino', perPagina: 'scadenze', pagina: 'scadenze', ico: '⏳',
      titolo: 'Scadenze',
      descrizione: 'Lotti in giacenza ordinati per scadenza; togliere gli scaduti.',
      passi: [
        { el: '#z-entro', posizione: 'sotto', titolo: 'Quali lotti',
          testo: 'Solo scaduti, entro 30 o 60 giorni, entro il preavviso impostato, o tutti.' },
        { el: '#z-rep, #z-cat', insieme: true, posizione: 'sotto', titolo: 'Magazzino e categoria',
          testo: 'Per vedere un magazzino solo, o solo farmaci o presidi.' },
        { el: '#z-tab', posizione: 'sopra', titolo: 'Dal più urgente',
          testo: 'Le etichette rosse sono lotti scaduti o che scadono entro 30 giorni; le arancioni entro il preavviso.' },
        { el: '#z-tab [data-perdita]', se: puo('perdita'), facoltativo: true, posizione: 'sinistra', titolo: 'Togli dal magazzino',
          testo: 'Per un lotto scaduto apre <b>Perdite</b> già compilata: controlli e registri.' },
        { el: '#z-stampa, #z-excel', insieme: true, posizione: 'sotto', titolo: 'Stampa ed Excel',
          testo: 'L’elenco da stampare per il controllo sugli scaffali, o da esportare.' }
      ]
    },
    {
      id: 'movimenti', gruppo: 'magazzino', perPagina: 'movimenti', pagina: 'movimenti', ico: '🧾',
      titolo: 'Movimenti e annullo',
      descrizione: 'L’elenco completo con i filtri; annullare un movimento sbagliato.',
      passi: [
        { el: '#v-dal, #v-al', insieme: true, posizione: 'sotto', titolo: 'Periodo',
          testo: 'Di base dal primo del mese a oggi.' },
        { el: '#v-tipo, #v-rep, #v-cerca', insieme: true, posizione: 'sotto', titolo: 'Filtri',
          testo: 'Tipo di movimento, magazzino, e una ricerca su articolo, lotto, fornitore o documento (anche il numero di un DDT).' },
        { el: '#v-ann', risali: '.spunta', posizione: 'sotto', titolo: 'Annullati',
          testo: 'I movimenti annullati restano nell’elenco, barrati, con chi li ha annullati e perché.' },
        { el: '#v-tab', posizione: 'sopra', titolo: 'Elenco',
          testo: 'Ogni riga ha l’operatore che l’ha registrata. Tocca il nome dell’articolo per aprirne la scheda.' },
        { el: '#v-tab [data-annulla]', se: puoAnnullareQualcosa, facoltativo: true, posizione: 'sinistra', titolo: 'Annullare',
          testo: 'Un movimento non si cancella: si <b>annulla</b> scrivendo il motivo. Vedi il pulsante solo sui movimenti che puoi annullare; quelli nati da un DDT si annullano annullando il DDT.' },
        { el: '#v-excel', posizione: 'sotto', titolo: 'Excel',
          testo: 'Esporta i movimenti filtrati, con tutte le colonne.' }
      ]
    },
    {
      id: 'inventario', gruppo: 'magazzino', perPagina: 'inventario', pagina: 'inventario', ico: '✅',
      titolo: 'Inventario',
      descrizione: 'Foglio di conta: le differenze diventano rettifiche.',
      passi: [
        { el: '#i-data, #i-rep', insieme: true, posizione: 'sotto', titolo: 'Data e magazzino',
          testo: 'Il giorno della conta e il magazzino che stai contando.' },
        copia(BARRA_LETTORE, { testo: 'Ogni lettura aggiunge alla quantità contata dell’articolo: puoi contare passando le confezioni al lettore.' }),
        { el: '#i-stampa', posizione: 'sotto', titolo: 'Foglio di conta',
          testo: 'Stampalo e portalo con te mentre conti sugli scaffali.' },
        { el: '#i-tab input.q', facoltativo: true, posizione: 'sinistra', titolo: 'Quantità contata',
          testo: 'Scrivi solo quello che hai contato: le righe vuote non cambiano. La differenza compare subito accanto.' },
        { el: '#i-registra', posizione: 'sotto', titolo: 'Registra differenze',
          testo: 'Le differenze diventano rettifiche d’inventario. Prima di registrare il programma ti chiede conferma.' }
      ]
    },

    /* ---------------- analisi ---------------- */
    {
      id: 'previsioni', gruppo: 'analisi', perPagina: 'previsioni', pagina: 'previsioni', ico: '📈',
      titolo: 'Previsioni e fabbisogno',
      descrizione: 'Filtri, indicatori, grafico con la previsione, fabbisogno e dettaglio di un articolo, classi ABC-XYZ, proposta d’ordine con Excel.',
      passi: [
        { el: '#pv-rep', posizione: 'sotto', titolo: 'Per quale magazzino',
          testo: function () {
            return (soloSuoiMagazzini() ? 'Uno dei tuoi magazzini, o tutti insieme.' : 'Tutta la struttura, la sola farmacia centrale o un magazzino di piano.') +
              ' Le previsioni nascono dai consumi e dalle perdite registrati (i trasferimenti fra magazzini non sono consumi).';
          } },
        { el: '#pv-cat, #pv-cerca', insieme: true, posizione: 'sotto', titolo: 'Categoria e ricerca',
          testo: 'Solo farmaci o solo presidi, oppure un articolo per nome o principio attivo.' },
        { el: 'input[name="pv-orizzonte"]', risali: '.an-segmenti', posizione: 'sotto', titolo: 'Quanto lontano guardare',
          testo: 'Previsione a 7, 30 o 90 giorni. Con <b>Vista</b> raggruppi il grafico per giorno, settimana o mese.' },
        { el: '#pv-ind', posizione: 'sotto', titolo: 'Gli indicatori',
          testo: 'Consumo previsto nel periodo e il suo valore, articoli al punto di riordino, quelli che finiranno prima della prossima consegna e quanti ce ne sono da ordinare.' },
        { el: '#pv-grafico', posizione: 'sopra', titolo: 'Consumi e previsione',
          testo: 'Linea piena: i consumi veri. Linea tratteggiata: la previsione, con la fascia in cui il consumo cadrà 9 volte su 10 (più si guarda lontano, più si allarga). Sopra il grafico scegli pezzi o euro.' },
        { el: '#pv-schede', posizione: 'sotto', titolo: 'Le schede',
          testo: function () {
            return '<b>Fabbisogno per articolo</b>, <b>Classi ABC-XYZ</b>' + (App.puo('ordini') ? ' e <b>Proposta d’ordine</b>' : '') +
              ': toccane una per aprirla. Te le mostro una per una.';
          } },
        { el: '#pv-tabella thead', ambiente: SCHEDA_FABBISOGNO, facoltativo: true, posizione: 'sotto', titolo: 'Fabbisogno per articolo',
          testo: function () {
            return 'Per ogni articolo: consumo medio, tendenza, per quanti giorni basta, quando finirà, scorta di sicurezza, punto di riordino e quanto ' +
              (eFarmacia() ? 'ordinare' : 'chiedere alla farmacia') + '. Di base in cima ci sono gli articoli che finiscono prima; tocca un’intestazione per ordinare la tabella in un altro modo.';
          } },
        { el: '#pv-tabella .an-art-btn', ambiente: SCHEDA_FABBISOGNO, facoltativo: true, posizione: 'sotto', titolo: 'Il dettaglio di un articolo',
          testo: 'Tocca il nome di un articolo per vedere il suo dettaglio. Te lo apro io.' },
        { el: '#modale .an-mini-griglia', ambiente: DETTAGLIO_PREVISIONE, facoltativo: true, posizione: 'sotto', titolo: 'I numeri dell’articolo',
          testo: 'Consumo medio al giorno, a settimana e al mese, quanto ce n’è (anche in viaggio), per quanti giorni basta, punto di riordino, quanto ordinare e il metodo di previsione usato, con la sua affidabilità.' },
        { el: '#pvd-grafico', ambiente: DETTAGLIO_PREVISIONE, facoltativo: true, posizione: 'sotto', titolo: 'Consumi e previsione dell’articolo',
          testo: 'Come nel grafico grande, ma per questo articolo solo: i consumi veri, la previsione tratteggiata e la sua fascia. Sopra scegli se vederli per giorno, per settimana o per mese.' },
        { el: '#modale .an-dett-due', ambiente: DETTAGLIO_PREVISIONE, facoltativo: true, posizione: 'sopra', titolo: 'Giorni della settimana e metodi',
          testo: function () {
            // sul computer i due grafici stanno uno accanto all'altro, sul telefono uno sotto l'altro
            var lato = affiancati('#pvd-calore', '#pvd-modelli');
            return (lato ? 'A sinistra' : 'Sopra') + ' i consumi per giorno della settimana nelle ultime 12 settimane: più scuro, più consumo. ' +
              (lato ? 'A destra' : 'Sotto') + ' il confronto dei metodi di previsione: il programma usa quello che ha sbagliato meno nelle ultime 4 settimane. Chiudo io la finestra.';
          } },
        { el: '#pv-excel', ambiente: SCHEDA_FABBISOGNO, facoltativo: true, posizione: 'sotto', titolo: 'Excel',
          testo: 'Esporta la tabella del fabbisogno, con gli stessi filtri.' },
        { el: '#pv-pannello .an-abc-griglia', ambiente: SCHEDA_ABC, facoltativo: true, posizione: 'destra', titolo: 'Classi ABC-XYZ',
          testo: '<b>A, B, C</b>: quanto pesa l’articolo sul valore dei consumi (gli A fanno l’80% della spesa). <b>X, Y, Z</b>: quanto è regolare il consumo da una settimana all’altra (X costante, Z a sbalzi). Tocca una casella per vedere quegli articoli nella tabella del fabbisogno: gli <b>AZ</b> si seguono da vicino, i <b>CZ</b> si tengono al minimo.' },
        { el: '#pv-pareto', ambiente: SCHEDA_ABC, facoltativo: true, posizione: 'sinistra', titolo: 'Curva ABC',
          testo: 'Gli articoli che pesano di più sulla spesa, dal più caro, e la quota cumulata: le linee all’80% e al 95% separano gli A, i B e i C.' },
        { el: function () {
            return document.querySelector('#pv-proposta .an-fornitore') ? '#pv-proposta .an-fornitore' : document.querySelector('#pv-proposta') ? '#pv-proposta' : '#pv-pannello';
          },
          ambiente: SCHEDA_ORDINE, se: puo('ordini'), facoltativo: true, posizione: 'sopra', riparo: 'cima', titolo: 'Proposta d’ordine',
          testo: 'Quanto ordinare ai fornitori per tutta la struttura, diviso per fornitore: consumo previsto fino al prossimo ordine più la scorta di sicurezza, meno quello che c’è già (anche in viaggio), arrotondato a confezioni intere.' },
        { el: '#pv-proposta .an-conf', ambiente: SCHEDA_ORDINE, se: puo('ordini'), facoltativo: true, posizione: 'sinistra', titolo: 'Confezioni da ordinare',
          testo: 'Puoi cambiare le confezioni: importi e totali si aggiornano subito e la proposta le ricorda finché resti collegato. <b>Ripristina la proposta</b> torna ai numeri calcolati.' },
        { el: '#pv-ordine-stampa, #pv-ordine-excel', insieme: true, ambiente: SCHEDA_ORDINE, se: puo('ordini'), facoltativo: true, posizione: 'sotto', titolo: 'Excel e stampa',
          testo: '<b>Excel</b> crea un foglio per ogni fornitore, pronto da mandare; <b>Stampa</b> mette la proposta su carta. Nessun ordine parte da solo: decidi tu.' }
      ]
    },
    {
      id: 'distribuzione', gruppo: 'analisi', perPagina: 'distribuzione', pagina: 'distribuzione', ico: '🧭',
      titolo: 'Distribuzione ai magazzini',
      descrizione: 'Quanto la farmacia centrale ha dato a ogni magazzino, cosa ne è stato e dove si trova la merce adesso.',
      passi: [
        { el: '#ds-periodo', posizione: 'sotto', titolo: 'Periodo',
          testo: 'Il mese in corso, gli ultimi 3, 6 o 12 mesi, oppure due date a scelta.' },
        { el: '#ds-cat, #ds-cerca', insieme: true, posizione: 'sotto', titolo: 'Categoria e articolo',
          testo: 'Solo farmaci o presidi, oppure un articolo per nome.' },
        { el: 'input[name="ds-misura"]', risali: '.an-segmenti', posizione: 'sotto', titolo: 'Pezzi o euro',
          testo: 'Tutti i numeri e i grafici in pezzi oppure in valore.' },
        { el: '#ds-ind', posizione: 'sotto', titolo: 'In breve',
          testo: 'Quanto la farmacia ha dato ai magazzini nel periodo, quanto è stato consumato e perso, i resi e la merce in viaggio.' },
        { el: '#ds-sankey', posizione: 'sopra', titolo: 'Dalla farmacia ai magazzini',
          testo: 'La farmacia centrale, quanto ha dato a ogni magazzino (più è spesso il flusso, più merce) e cosa ne è stato: consumato, perso o reso. Passa sopra un flusso (o toccalo) per leggere i numeri.' },
        { el: '#ds-mesi', posizione: 'sopra', titolo: 'Dato ogni mese',
          testo: 'Quanto ha ricevuto ogni magazzino, mese per mese.' },
        { el: '#ds-dove', posizione: 'sopra', titolo: 'Dove si trova la merce adesso',
          testo: 'La giacenza di oggi magazzino per magazzino, compresa la merce in viaggio: più grande il riquadro, più merce.' },
        { el: '#ds-art', posizione: 'sotto', titolo: 'Dove si trova un articolo',
          testo: 'Scegli un articolo: il grafico mostra quante confezioni ci sono in ogni magazzino.' },
        { el: function () { return document.querySelector('#ds-tabella-box thead') || document.querySelector('#ds-tabella-box'); },
          posizione: 'sotto', titolo: 'Articolo per magazzino',
          testo: 'Per ogni articolo e ogni magazzino: <b>Dato</b> dalla farmacia centrale nel periodo, <b>Cons.</b> (consumi e perdite) e <b>Giac.</b>, quanto ne resta adesso. Il camioncino 🚚 indica la merce in viaggio.' },
        { el: '#ds-excel', posizione: 'sotto', titolo: 'Excel',
          testo: 'Tre fogli: per magazzino, dato mese per mese e articolo per magazzino.' }
      ]
    },

    /* ---------------- registri e archivio ---------------- */
    {
      id: 'registro', gruppo: 'archivio', perPagina: 'registro', pagina: 'registro', ico: '📅',
      titolo: 'Nota consumi mensile',
      descrizione: 'Il modulo del mese per reparto: correzioni, stampa ed Excel.',
      passi: [
        { el: '#r-rep, #r-mese, #r-cat', insieme: true, posizione: 'sotto', titolo: 'Quale modulo',
          testo: 'Reparto, mese e modulo (Farmaci o Presidi): è lo stesso foglio di sempre, già compilato.' },
        { el: '#r-tutti', risali: '.spunta', posizione: 'sotto', titolo: 'Tutti gli articoli',
          testo: 'Spunta per avere nel modulo anche gli articoli senza movimenti nel mese.' },
        { el: '#r-tab table.registro thead', facoltativo: true, posizione: 'sotto', titolo: 'Le colonne',
          testo: 'Residui, carichi, consumi giorno per giorno, perdite, residui finali e importo: si calcolano da soli dai movimenti. La merce arrivata con un DDT conta il giorno della ricezione.' },
        { el: cellaDiOggi, se: puoCorreggereRegistro, facoltativo: true, posizione: 'sotto', titolo: 'Le caselle dei giorni',
          testo: 'Clicca la casella di un giorno e scrivi il consumo, come sul foglio: il valore sostituisce i consumi di quel giorno.' },
        { el: cellaDiOggi, se: puoCorreggereRegistro, facoltativo: true, posizione: 'sotto', titolo: 'Frecce e Invio',
          testo: '<kbd>Invio</kbd> o <kbd>↓</kbd> salva e scende, <kbd>Tab</kbd> o <kbd>→</kbd> va al giorno dopo, <kbd>Esc</kbd> annulla quello che hai scritto.' },
        { el: cellaDiOggi, se: function () { return !puoCorreggereRegistro(); }, facoltativo: true, posizione: 'sotto', titolo: 'Sola lettura',
          testo: 'Il tuo utente può consultare questo modulo, stamparlo ed esportarlo, ma non correggerlo.' },
        { el: '#r-stampa', posizione: 'sotto', titolo: 'Stampa',
          testo: 'Stampa il modulo in A4 orizzontale, con le firme in fondo.' },
        { el: '#r-excel', posizione: 'sotto', titolo: 'Esporta nel modulo Excel',
          testo: 'Crea il file Excel originale della clinica, già compilato. Oltre 48 articoli aggiunge altri fogli identici.' }
      ]
    },
    {
      id: 'articoli', gruppo: 'archivio', perPagina: 'articoli', pagina: 'articoli', ico: '🏷️',
      titolo: 'Articoli',
      descrizione: 'L’anagrafica di farmaci e presidi, importazione da Excel.',
      passi: [
        { el: '#a-cerca', posizione: 'sotto', titolo: 'Cerca',
          testo: 'Per nome, principio attivo o codice.' },
        { el: '#a-cat, #a-non', insieme: true, posizione: 'sotto', titolo: 'Filtri',
          testo: 'Farmaci o presidi; spunta <b>Mostra non attivi</b> per vedere anche gli articoli nascosti.' },
        { el: '#a-tab .tabella tbody tr', facoltativo: true, posizione: 'sotto', titolo: 'Scheda dell’articolo',
          testo: 'Tocca una riga per vedere giacenze e lotti di ogni magazzino e gli ultimi movimenti.' },
        { el: '#a-tab [data-modifica]', se: puo('articoli'), facoltativo: true, posizione: 'sinistra', titolo: 'Modifica',
          testo: 'Per correggere nome, unità, prezzo, scorta minima, fornitore abituale, giorni di consegna e caratteristiche. Un articolo già usato (movimenti, richieste, DDT o assortimento) non si elimina: togli la spunta <b>Articolo attivo</b>.' },
        { el: '#a-nuovo', se: puo('articoli'), posizione: 'sotto', titolo: 'Nuovo articolo',
          testo: 'Denominazione, categoria, unità, codice AIC, prezzo e scorta minima; poi <b>Fornitore abituale</b>, <b>Giorni di consegna</b> (vuoto = quelli generali) e le caratteristiche: <b>Da frigorifero 2–8 °C</b> e <b>Stupefacente (cassaforte)</b> dicono agli armadi dove metterlo.' },
        { el: '#a-importa', se: puo('articoli'), posizione: 'sotto', titolo: 'Importa da Excel',
          testo: 'Anche dai vecchi moduli <b>Nota consumi</b> compilati: gli articoli già presenti non si duplicano.' },
        { el: '#a-excel', posizione: 'sotto', titolo: 'Esporta Excel',
          testo: 'L’anagrafica completa in un file Excel.' }
      ]
    },
    {
      id: 'magazzini', gruppo: 'archivio', perPagina: 'magazzini', pagina: 'magazzini', ico: '🏬',
      titolo: 'Magazzini e assortimento',
      descrizione: 'Dati dei magazzini, armadi, assortimento con le scorte e «Proponi dai consumi».',
      passi: [
        { el: '#mg-lista', posizione: 'destra', titolo: 'I magazzini',
          testo: 'La farmacia centrale e i magazzini di piano, raggruppati per piano. Il numero rosso: articoli sotto scorta. Tocca un magazzino per aprirlo.' },
        { el: '#mg-nuovo', se: puo('struttura'), posizione: 'sotto', titolo: 'Nuovo magazzino',
          testo: 'Nome, piano, colore… Dopo averlo creato aggiungi i suoi armadi e il suo assortimento.' },
        { el: '.mg-schede', posizione: 'sotto', titolo: 'Tre schede',
          testo: '<b>Dati</b> del magazzino, i suoi <b>Armadi</b> e il suo <b>Assortimento</b> con le scorte. Te le mostro una per una.' },
        { el: '#mg-nome', risali: '.scheda', vista: V_MG_DATI, se: puo('struttura'), facoltativo: true, posizione: 'destra', titolo: 'Dati del magazzino',
          testo: 'Nome, tipo (farmacia centrale o magazzino di piano), piano e livello, colore e descrizione. La farmacia centrale è una sola. Un magazzino già usato non si elimina: si toglie la spunta «Magazzino attivo».' },
        { el: '#mg-stanza', vista: V_MG_DATI, se: puo('struttura'), facoltativo: true, posizione: 'sinistra', titolo: 'Come appare sulla mappa',
          testo: 'L’anteprima cambia mentre scrivi. Poi premi <b>Salva</b>.' },
        { el: '#mg-pannello', vista: V_MG_ARMADI, facoltativo: true, posizione: 'sopra', titolo: 'Armadi',
          testo: function () {
            return 'Armadi, frigorifero, cassettiere, carrelli e cassaforte, ognuno con i suoi ripiani e posti. <b>Apri</b> lo mostra nella pagina Armadi' +
              (App.puo('struttura') ? '; <b>+ Nuovo armadio</b> ne aggiunge uno.' : '.');
          } },
        { el: '#as-tab', vista: V_MG_ASSORTIMENTO, facoltativo: true, posizione: 'sopra', titolo: 'Assortimento e scorte',
          testo: 'Gli articoli che il magazzino tiene, con <b>scorta minima</b>, <b>punto di riordino</b> e <b>scorta massima</b>, la giacenza e per quanti giorni basta. Le scorte servono agli avvisi «sotto scorta» e a «Proponi le quantità» delle richieste.' },
        { el: '#as-nuovo, #as-agg, #as-usati', insieme: true, vista: V_MG_ASSORTIMENTO, se: puo('assortimento'), facoltativo: true, posizione: 'sotto', titolo: 'Aggiungi articoli',
          testo: 'Scrivi il nome e premi <b>Aggiungi</b>, oppure aggiungi in un colpo quelli usati dal magazzino negli ultimi 90 giorni.' },
        { el: '#as-proponi', vista: V_MG_ASSORTIMENTO, se: puo('assortimento'), facoltativo: true, posizione: 'sotto', titolo: 'Proponi dai consumi',
          testo: 'Per gli articoli dell’assortimento propone le scorte dal consumo medio degli ultimi 90 giorni: scorta minima pari a circa 3 giorni di consumo, punto di riordino 7 giorni, scorta massima 14 giorni. Puoi scegliere se toccare solo gli articoli senza scorte o tutti; poi controlla e correggi.' },
        { el: '#as-salva', vista: V_MG_ASSORTIMENTO, se: puo('assortimento'), facoltativo: true, posizione: 'sopra', titolo: 'Salva assortimento',
          testo: 'Le modifiche restano da parte (anche se cambi scheda) finché non premi <b>Salva assortimento</b>; <b>Annulla le modifiche</b> le toglie.' }
      ]
    },

    /* ---------------- amministrazione ---------------- */
    {
      id: 'utenti', gruppo: 'amministrazione', perPagina: 'utenti', pagina: 'utenti', ico: '👥',
      titolo: 'Utenti e ruoli',
      descrizione: 'Creare gli utenti, cambiare ruolo e magazzini, dare una nuova password.',
      passi: [
        { el: '#contenuto > .banda.info', posizione: 'sotto', titolo: 'I ruoli',
          testo: 'Cosa può fare ogni ruolo: amministratore, farmacista della farmacia centrale, responsabile di magazzino, direzione (sola lettura). Il menu di ogni utente mostra solo le pagine che può usare.' },
        { el: '#u-nuovo', posizione: 'sotto', titolo: 'Nuovo utente',
          testo: 'Nome utente, nome e cognome, ruolo, i magazzini (per il responsabile di magazzino) e una password provvisoria (<b>Genera</b> ne crea una facile da dettare). Al primo accesso l’utente sceglie la sua.' },
        { el: '#u-tab', posizione: 'sopra', titolo: 'Elenco',
          testo: 'Per ognuno ruolo, magazzini, stato (attivo, password provvisoria, bloccato, disattivato) e ultimo accesso.' },
        { el: '#u-tab [data-modifica]', facoltativo: true, posizione: 'sinistra', titolo: 'Modifica',
          testo: 'Cambia ruolo e magazzini. Togli la spunta <b>Utente attivo</b> per bloccare l’accesso senza perdere i suoi movimenti.' },
        { el: '#u-tab [data-password]', facoltativo: true, posizione: 'sinistra', titolo: 'Nuova password',
          testo: function () {
            return 'Per chi l’ha dimenticata o è bloccato dopo 5 tentativi: dai una password provvisoria, da cambiare al primo accesso.' +
              (App.paginaPermessa('sicurezza') ? ' La verifica in due passaggi di chi ha perso il telefono si azzera dalla pagina <b>Sicurezza</b>.' : '');
          } },
        { el: '#u-anche', risali: '.spunta', posizione: 'sotto', titolo: 'Utenti disattivati',
          testo: 'Spunta per vederli e, se serve, riattivarli.' }
      ]
    },
    {
      id: 'sicurezza', gruppo: 'amministrazione', perPagina: 'sicurezza', pagina: 'sicurezza', ico: '🛡️',
      titolo: 'Sicurezza: verifica in due passaggi',
      descrizione: 'Chi deve usare la verifica con il telefono, a che punto sono gli utenti, azzerarla a chi ha perso il telefono.',
      passi: [
        { el: '.sic-spiega', posizione: 'sotto', titolo: 'Cos’è',
          testo: 'Oltre alla password serve un codice di 6 cifre che l’app sul telefono dell’utente cambia ogni 30 secondi. Chi scopre una password, senza il telefono non entra.' },
        { el: '#sic-mio', posizione: 'sotto', titolo: 'Prima la tua',
          testo: 'Attivala prima sul tuo utente: questo pulsante apre la finestra <b>Sicurezza dell’account</b> (c’è anche un giro guidato apposta, «Sicurezza dell’account»).' },
        { el: '.sic-criteri', posizione: 'sotto', titolo: 'Chi deve usarla',
          testo: '<b>Nessuno</b> (ognuno sceglie), <b>solo gli amministratori</b>, <b>amministratori e farmacisti</b>, oppure <b>tutti</b>. Sotto vedi quanti utenti dovranno ancora attivarla.' },
        { el: '#sic-salva-criterio', posizione: 'sotto', titolo: 'Salva il criterio',
          testo: 'Chi deve averla e non l’ha attivata, al prossimo accesso (o subito, se è collegato) viene guidato passo per passo: finché non la attiva non può lavorare.' },
        { el: '.sic-tabella', facoltativo: true, posizione: 'sopra', titolo: 'Gli utenti',
          testo: 'Per ognuno: verifica attiva, da attivare o non attiva, codici di recupero rimasti, computer ricordati e ultimo accesso.' },
        { el: '#sic-utenti [data-azzera]', facoltativo: true, posizione: 'sinistra', titolo: 'Azzera',
          testo: 'Per chi ha perso il telefono e i codici di recupero: toglie la verifica e i computer ricordati e chiude le sue sessioni. Se il criterio la richiede, al prossimo accesso la riattiva.' }
      ]
    },
    {
      id: 'attivita', gruppo: 'amministrazione', perPagina: 'attivita', pagina: 'attivita', ico: '📜',
      titolo: 'Registro attività',
      descrizione: 'Chi ha fatto cosa e quando: accessi e operazioni.',
      passi: [
        { el: '#t-dal, #t-al', insieme: true, posizione: 'sotto', titolo: 'Periodo',
          testo: 'Di base l’ultima settimana.' },
        { el: '#t-utente, #t-azione', insieme: true, posizione: 'sotto', titolo: 'Utente e azione',
          testo: 'Un utente solo, oppure un tipo di azione: accessi e sicurezza, movimenti, richieste e DDT, struttura, sistema…' },
        { el: '#t-tab', posizione: 'sopra', titolo: 'Il registro',
          testo: 'Quando, chi, cosa e da quale computer (indirizzo IP). In rosso gli accessi non riusciti.' },
        { el: '#t-aggiorna, #t-excel', insieme: true, posizione: 'sotto', titolo: 'Aggiorna ed Excel',
          testo: 'Il registro si aggiorna da solo quando altri lavorano; con Excel lo esporti.' }
      ]
    },
    {
      id: 'sistema', gruppo: 'amministrazione', perPagina: 'sistema', pagina: 'sistema', ico: '🩺',
      titolo: 'Sistema: base dati e copie',
      descrizione: 'Semaforo, controllo, copia, prova di ripristino e seconda cartella delle copie.',
      passi: [
        { el: '#sis-semaforo, #sis-stato-titolo, #sis-spiega', insieme: true, posizione: 'sotto', titolo: 'Il semaforo',
          testo: '<b>Verde</b>: tutto a posto. <b>Giallo</b>: qualcosa da guardare, per esempio una copia vecchia o poco spazio sul disco. <b>Rosso</b>: un problema, e il riquadro dice cosa fare. Il programma controlla la base dati all’avvio e ogni notte e, se serve, si ripara da solo.' },
        { el: '#sis-controlla', posizione: 'sotto', titolo: 'Controlla adesso',
          testo: 'Controllo completo di magazzino e utenti. Si può fare anche mentre gli altri lavorano.' },
        { el: '#sis-copia', posizione: 'sotto', titolo: 'Copia adesso',
          testo: 'Fa subito una copia di magazzino e utenti e la verifica (la riapre e la controlla). Utile prima di un cambiamento importante.' },
        { el: '#sis-prova', posizione: 'sotto', titolo: 'Prova di ripristino',
          testo: 'Ricostruisce i dati dall’ultima copia più il giornale delle modifiche, da parte e per finta, e li confronta con quelli veri tabella per tabella. Se tutto coincide, in caso di guasto il ripristino funzionerà.' },
        { el: '#sis-numeri', posizione: 'sotto', titolo: 'I numeri',
          testo: 'Dimensione della base dati, copie, spazio libero sul disco, ultima revisione e ultimo controllo.' },
        { el: '#sis-grafico', posizione: 'sopra', titolo: 'Crescita nel tempo',
          testo: 'Come cresce la base dati e quanto occupano le copie. Sotto il grafico, gli stessi dati in tabella.' },
        { el: '#sis-copie', posizione: 'sopra', titolo: 'Copie di sicurezza',
          testo: 'Ogni ora, se c’è stato lavoro, una copia verificata: tutte quelle delle ultime 24 ore, poi una al giorno per 14 giorni, una alla settimana per 8 settimane, una al mese per un anno.' },
        { el: '#sis-cronologia', posizione: 'sopra', titolo: 'Controlli e cure',
          testo: 'Quando il programma ha controllato la base dati e, se mai è servito, quando l’ha riparata e da quale copia.' },
        { el: '#sis-seconda', posizione: 'sopra', titolo: 'Seconda cartella',
          testo: 'Un disco esterno o una cartella di rete: il server ci mette una seconda copia delle copie e del giornale. Se si rompe il disco del server, i dati si recuperano da lì.' }
      ]
    },
    {
      id: 'configura', gruppo: 'amministrazione', perPagina: 'configura', pagina: 'configura', ico: '⚙️',
      titolo: 'Configurazione e copie di sicurezza',
      descrizione: 'Magazzini, marchio e nome del programma, modulo stampato, previsioni e ordini, copie di sicurezza.',
      passi: [
        { el: '#k-reparti', risali: '.scheda', se: puo('impostazioni'), posizione: 'sotto', titolo: 'Magazzini e reparti',
          testo: 'L’elenco dei magazzini attivi: la farmacia centrale e i magazzini di piano. Si creano e si cambiano, con armadi e assortimento, dalla pagina <b>Magazzini e assortimento</b>.' },
        { el: '#k-vai-magazzini', se: puo('impostazioni'), posizione: 'sotto', titolo: 'Apri Magazzini e assortimento',
          testo: 'Questo pulsante ti porta alla pagina dei magazzini.' },
        { el: '#k-prodotto', risali: '.scheda', se: puo('impostazioni'), posizione: 'sotto', titolo: 'Marchio e nome del programma',
          testo: function () {
            return 'Il nome del programma (oggi «' + h(nomeProdotto()) + '»), la sigla, il nome della struttura e il sottotitolo, il logo, il colore d’accento e il tema predefinito. ' +
              'Compaiono nel menu, nella schermata di accesso e nelle stampe. L’anteprima mostra il menu mentre scrivi; poi premi <b>Salva</b>.';
          } },
        { el: '#k-societa', risali: '.scheda', se: puo('impostazioni'), posizione: 'sotto', titolo: 'Modulo stampato e scadenze',
          testo: 'Società, città e codice che compaiono sulla Nota consumi stampata e in Excel, e con quanti giorni di anticipo avvisare delle scadenze.' },
        { el: '#k-lead', risali: '.scheda', se: puo('impostazioni'), posizione: 'sotto', titolo: 'Previsioni e ordini',
          testo: 'Giorni di consegna del fornitore, ogni quanti giorni si ordina, livello di servizio e quanto storico usare: servono alle previsioni e alla proposta d’ordine.' },
        { el: '#k-backup-crea', risali: '.scheda', se: puo('backup'), posizione: 'sopra', titolo: 'Copie di sicurezza',
          testo: function () {
            return 'Il server copia magazzino e utenti ogni ora (se c’è stato lavoro) e verifica ogni copia. Puoi crearne una adesso, scaricarla o ripristinarla.' +
              (App.paginaPermessa('sistema') ? ' Stato della base dati e seconda cartella delle copie sono nella pagina <b>Sistema</b>.' : '');
          } },
        { el: '#k-importa-archivio', risali: '.scheda', se: function () { return App.eAmministratore() && App.archivioVuoto(); }, facoltativo: true,
          posizione: 'sopra', titolo: 'Archivio vuoto',
          testo: 'Per cominciare: importa l’archivio della versione per un solo PC, oppure carica i dati di prova per imparare.' }
      ]
    }
  ];

  /* ======================= utilità ======================= */

  function giro(id) { return GIRI.filter(function (g) { return g.id === id; })[0] || null; }

  function paginaDelGiro(g) { return typeof g.pagina === 'function' ? g.pagina() : g.pagina; }

  function giroPermesso(g) {
    if (!g || !App.S || !App.utente) return false;
    if (g.se && !g.se()) return false;
    var p = paginaDelGiro(g);
    return !p || App.paginaPermessa(p);
  }

  function lista(x) { return Array.prototype.slice.call(x || []); }

  function rid() { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  /* Aspetta che cond() dia un valore "vero" (al massimo ms millisecondi): restituisce l'ultimo valore. */
  function aspettaChe(cond, ms) {
    return new Promise(function (ok) {
      var fine = Date.now() + ms;
      (function prova() {
        var r = cond();
        if (r || Date.now() >= fine) { ok(r); return; }
        setTimeout(prova, 80);
      })();
    });
  }

  /* Aspetta che un elemento smetta di muoversi (per esempio il menu laterale che entra scorrendo). */
  function aspettaFermo(e, ms) {
    var prima = null, fermo = 0;
    return aspettaChe(function () {
      var r = e ? e.getBoundingClientRect() : null;
      var ora = r ? Math.round(r.left) + ',' + Math.round(r.top) : '';
      fermo = ora === prima ? fermo + 1 : 0;
      prima = ora;
      return fermo >= 2;
    }, ms);
  }

  function visibile(e) {
    if (!e || !e.isConnected || e.closest('.tour')) return false;
    var r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    var s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  /* Elementi da evidenziare per un passo (anche più di uno, con "insieme"). */
  function trova(p) {
    if (!p || !p.el) return [];
    var sel = typeof p.el === 'function' ? p.el() : p.el;
    if (!sel) return [];
    var el;
    if (typeof sel !== 'string') el = [sel];
    else {
      try { el = p.insieme ? lista(document.querySelectorAll(sel)) : [document.querySelector(sel)]; } catch (e) { el = []; }
    }
    return el.filter(Boolean).map(function (e) { return p.risali ? (e.closest(p.risali) || e) : e; }).filter(visibile);
  }

  /* ---------- viste delle pagine ---------- */

  // parametri per aprire la vista (null: la vista non si può aprire, per esempio non c'è nessun DDT da ricevere)
  function parametriVista(v) {
    var x;
    try { x = typeof v.parametri === 'function' ? v.parametri() : v.parametri; } catch (e) { console.error(e); x = null; }
    return x || null;
  }

  // la vista è già quella sullo schermo?
  function segnoPresente(v) {
    try {
      if (typeof v.segno === 'function') return !!v.segno();
      var cont = document.getElementById('contenuto');
      return !!(cont && cont.querySelector(v.segno));
    } catch (e) { return false; }
  }

  function rettangoloDi(elementi) {
    var r = null;
    elementi.forEach(function (e) {
      var b = e.getBoundingClientRect();
      if (!r) r = { l: b.left, t: b.top, r: b.right, b: b.bottom };
      else { r.l = Math.min(r.l, b.left); r.t = Math.min(r.t, b.top); r.r = Math.max(r.r, b.right); r.b = Math.max(r.b, b.bottom); }
    });
    return r;
  }

  // sul telefono il menu laterale è nascosto: il pulsante ☰ è visibile
  function menuNascosto() {
    var b = document.getElementById('apri-menu');
    return !!b && getComputedStyle(b).display !== 'none';
  }

  function nelMenu(elementi) { return elementi.some(function (e) { return !!e.closest('#laterale'); }); }

  function altezzaTesta() {
    var t = document.querySelector('.testa-fissa');
    return t ? Math.max(0, t.getBoundingClientRect().bottom) : 0;
  }

  function accessoVisibile() { return !!(root.Accesso && root.Accesso.visibile && root.Accesso.visibile()); }

  // il programma si vede ed è in uso: non c'è la schermata di accesso sopra (uscita, sessione scaduta)
  function appUsabile() {
    var app = document.getElementById('app');
    return !!app && !app.hidden && !accessoVisibile();
  }

  function appPronta() { return !!(App.S && App.utente) && appUsabile(); }

  /* Una finestra aperta con qualcosa di scritto (per esempio un articolo nuovo): il giro non la chiude. */
  function finestraConDatiScritti() {
    var m = document.getElementById('modale');
    if (!m || m.hidden) return false;
    var tipi = ['text', 'number', 'month', 'date', 'password', 'email', 'tel', 'url', 'search'];
    return lista(m.querySelectorAll('input, textarea')).some(function (i) {
      if (i.tagName !== 'TEXTAREA' && tipi.indexOf((i.getAttribute('type') || 'text').toLowerCase()) < 0) return false;
      return i.value !== i.defaultValue;
    });
  }

  /* Campi scritti e non ancora registrati nella pagina aperta (cambiando pagina o vista andrebbero persi). */
  function modificheNonRegistrate() {
    var cont = document.getElementById('contenuto');
    if (!cont) return false;
    return lista(cont.querySelectorAll('input, textarea')).some(function (i) {
      var t = (i.getAttribute('type') || 'text').toLowerCase();
      if (['text', 'number', 'month'].indexOf(t) < 0 && i.tagName !== 'TEXTAREA') return false;
      // filtri, quantità tenute da parte dalle pagine (consumi, confezioni della proposta d'ordine), caselle del registro
      // (si salvano da sole), lettore
      if (i.closest('.strumenti, .barra-scanner') || i.matches('input.q[data-art], input.an-conf, td.g input')) return false;
      if (i.value === i.defaultValue) return false;
      // un valore proposto dalla pagina fra i suggerimenti del campo (per esempio la causale di un DDT): niente di scritto
      if (i.list && lista(i.list.options).some(function (o) { return o.value === i.value; })) return false;
      return true;
    });
  }

  /* Il giro cambierà pagina o vista (il modulo aperto si ridisegnerebbe): serve chiedere prima di perdere le righe scritte. */
  function cambiaPaginaOVista(g) {
    var pag = paginaDelGiro(g);
    if (pag && pag !== App.paginaCorrente) return true;
    return g.passi.some(function (p) {
      if (p.se && !p.se()) return false;
      var pp = p.pagina === undefined ? pag : p.pagina;
      if (pp && pp !== App.paginaCorrente) return true;
      return !!(p.vista && pp && parametriVista(p.vista) && !segnoPresente(p.vista));
    });
  }

  /* ======================= memoria dell'invito (localStorage, per utente) ======================= */

  var memoriaDiRiserva = {};

  function chiaveInvito() { return 'gf-giro-invito:' + (App.utente ? App.utente.id || App.utente.username : ''); }

  function leggiMemoria(k) {
    try { var v = root.localStorage.getItem(k); return v === null ? memoriaDiRiserva[k] || null : v; } catch (e) { return memoriaDiRiserva[k] || null; }
  }

  function scriviMemoria(k, v) {
    memoriaDiRiserva[k] = v;
    try { root.localStorage.setItem(k, v); } catch (e) { /* memoria del browser non disponibile: vale per questa pagina */ }
  }

  /* ======================= stato del giro ======================= */

  var corsa = null;    // giro in corso
  var radice = null;   // elementi del giro sullo schermo
  var timerPosizione = null;
  var rafPosizione = 0;
  // scorrimento morbido della pagina chiesto dal giro e forse non ancora finito: { y (destinazione), fino (ms) }
  var scorrimento = null;

  function el(c) { return radice ? radice.querySelector(c) : null; }

  function costruisci() {
    var r = document.createElement('div');
    r.className = 'tour';
    r.id = 'tour';
    r.innerHTML =
      '<div class="tour-blocco"></div>' +
      '<div class="tour-luce vuota"></div>' +
      // una colonna che può stringersi: il titolo lungo di un giro si accorcia (…) e "Passo N di M" resta nel fumetto
      '<div class="tour-fumetto" role="dialog" aria-modal="true" aria-labelledby="tour-titolo" aria-describedby="tour-testo" hidden style="grid-template-columns:minmax(0,1fr)">' +
      '<span class="tour-freccia" aria-hidden="true"></span>' +
      '<div class="tour-testa"><span class="tour-giro"></span><span class="tour-conta"></span></div>' +
      '<div class="tour-avanzamento" aria-hidden="true"><span></span></div>' +
      '<h3 id="tour-titolo"></h3>' +
      '<div class="tour-testo" id="tour-testo" aria-live="polite"></div>' +
      '<div class="tour-piede">' +
      '<button class="btn fantasma piccolo" type="button" data-tour="esci">Esci</button>' +
      '<button class="btn fantasma piccolo" type="button" data-tour="altri" hidden>Altri giri</button>' +
      '<span class="spazio"></span>' +
      '<button class="btn piccolo" type="button" data-tour="indietro">‹ Indietro</button>' +
      '<button class="btn primario piccolo" type="button" data-tour="avanti">Avanti ›</button>' +
      '</div>' +
      '<p class="tour-tasti" aria-hidden="true"><kbd>←</kbd> <kbd>→</kbd> per spostarti · <kbd>Invio</kbd> avanti · <kbd>Esc</kbd> esci</p>' +
      '</div>';
    r.addEventListener('click', function (e) {
      // i clic nel giro restano nel giro: il menu dell'utente aperto per un passo non si chiude come per un clic fuori
      e.stopPropagation();
      var b = e.target.closest('[data-tour]');
      if (!b || !corsa) return;
      var cosa = b.getAttribute('data-tour');
      if (cosa === 'avanti') avanti();
      else if (cosa === 'indietro') indietro();
      else if (cosa === 'esci') Tour.ferma();
      else if (cosa === 'altri') { Tour.ferma(); Tour.apriElenco(); }
    });
    // un tocco sulla parte scura non fa niente: il giro si chiude solo con Esci o Esc
    r.querySelector('.tour-blocco').addEventListener('mousedown', function (e) { e.preventDefault(); });
    document.body.appendChild(r);
    // il primo fotogramma senza classe, poi la dissolvenza
    void r.offsetWidth;
    r.classList.add('visibile');
    return r;
  }

  function avanti() {
    if (!corsa || corsa.inAttesa) return;
    if (corsa.i >= corsa.passi.length - 1) { Tour.ferma(); return; }
    vaiAlPasso(corsa.i + 1, 1);
  }

  function indietro() {
    if (!corsa || corsa.inAttesa || corsa.i <= 0) return;
    vaiAlPasso(corsa.i - 1, -1);
  }

  function paginaDelPasso(p) {
    if (p.pagina === null) return null;
    return p.pagina !== undefined ? p.pagina : corsa.pagina;
  }

  function segnaAttesa(si) {
    if (!corsa) return;
    corsa.inAttesa = si;
    var f = el('.tour-fumetto');
    if (f) { f.classList.toggle('in-attesa', si); f.setAttribute('aria-busy', si ? 'true' : 'false'); }
  }

  /* ---------- finestre e menu dei passi ---------- */

  function chiudiAmbiente(c) {
    var a = c.ambiente, mio = c.ambienteMio;
    c.ambiente = null;
    c.ambienteMio = false;
    if (a && mio) { try { a.chiudi(); } catch (e) { console.error(e); } }
  }

  /* Apre la finestra o il menu del passo (se serve): true, false se non si può aprire, oppure una promessa. */
  function apriAmbiente(c, p) {
    var a = p.ambiente;
    if (!a || corsa !== c) return true;
    if (a.aperto()) {
      if (!c.ambiente) { c.ambiente = a; c.ambienteMio = false; } // era già aperto: alla fine resta com'era
      return true;
    }
    var r;
    try { r = a.apri(); } catch (e) { console.error(e); r = null; }
    if (r === null || r === false) return false;
    c.ambiente = a;
    c.ambienteMio = true;
    return Promise.resolve(r).then(function () { return true; });
  }

  /* Il passo i non c'è (elemento facoltativo mancante, vista che non si può aprire): lo tolgo e passo al vicino. */
  function saltaPasso(c, i, verso) {
    var p = c.passi[i];
    c.saltati.push(valore(p.titolo));
    c.passi.splice(i, 1);
    if (!c.passi.length) { Tour.ferma(); return; }
    if (verso < 0) vaiAlPasso(Math.max(0, i - 1), i > 0 ? -1 : 1);
    // mancavano gli ultimi passi (per esempio nessun armadio da disporre): il passo di prima diventa l'ultimo e mostra
    // "Fine ✓" (e "Altri giri"), invece di chiudere il giro di colpo
    else if (i >= c.passi.length && i > 0) vaiAlPasso(i - 1, -1);
    else vaiAlPasso(i, 1);
  }

  /* Mostra il passo i (verso: 1 avanti, -1 indietro): apre la pagina e la vista, aspetta l'elemento, lo porta in vista. */
  function vaiAlPasso(i, verso) {
    var c = corsa;
    if (!c) return;
    if (i >= c.passi.length) { Tour.ferma(); return; }
    if (i < 0) i = 0;
    var gettone = ++c.gettone;
    var vivo = function () { return corsa === c && c.gettone === gettone; };
    c.i = i;
    var p = c.passi[i];
    segnaAttesa(true);

    // la finestra o il menu del passo di prima, se a questo non servono, si chiudono subito (prima di cambiare pagina)
    if (c.ambiente && (!p.ambiente || p.ambiente.id !== c.ambiente.id)) chiudiAmbiente(c);

    var pag = paginaDelPasso(p);
    var parVista = p.vista && pag ? parametriVista(p.vista) : null;
    // la vista del passo non si può aprire (per esempio nessun DDT da ricevere): il passo facoltativo manca
    if (p.vista && pag && !parVista && p.facoltativo) { saltaPasso(c, i, verso); return; }
    var cambiaVista = !!(parVista && !(App.paginaCorrente === pag && segnoPresente(p.vista)));
    var apertura = Promise.resolve();
    if (pag && (App.paginaCorrente !== pag || cambiaVista)) {
      c.paginaAttesa = pag;
      c.navigatoIl = Date.now();
      scorrimento = null; // la pagina ridisegnata riparte dall'alto
      App.vai(pag, cambiaVista ? parVista : undefined);
      apertura = aspettaChe(function () { return App.paginaCorrente === pag && (!cambiaVista || segnoPresente(p.vista)); }, ATTESA_MAX);
    }
    apertura.then(function () {
      if (!vivo()) return null;
      if (p.prima) { try { return p.prima(); } catch (e) { console.error(e); } }
      return null;
    }).then(function () {
      if (!vivo()) return null;
      return apriAmbiente(c, p);
    }).then(function (ambienteOk) {
      if (!vivo()) return null;
      if (ambienteOk === false) return 'manca';
      if (!p.el) return [];
      // dopo un cambio di pagina aspetto fino a ~3 s in tutto; sulla pagina già pronta mezzo secondo basta
      var limite = Math.max(ATTESA_MINIMA, ATTESA_MAX - (Date.now() - c.navigatoIl));
      return aspettaChe(function () { var t = trova(p); return t.length ? t : null; }, limite);
    }).then(function (trovati) {
      if (!vivo()) return null;
      var manca = trovati === 'manca' || (p.el && !(trovati && trovati.length));
      if (manca) {
        if (p.facoltativo || trovati === 'manca') {
          // l'elemento (o la finestra) non c'è, per esempio una parte senza dati: salto il passo
          saltaPasso(c, i, verso);
          return null;
        }
        trovati = []; // non c'è e non è facoltativo: fumetto al centro
      }
      trovati = trovati || [];
      return menuPerIlPasso(c, trovati).then(function () {
        if (!vivo()) return;
        c.bersagli = trovati;
        if (trovati.length) portaInVista(trovati);
        disegnaPasso();
        segnaAttesa(false);
      });
    }).catch(function (e) {
      console.error(e);
      if (vivo()) { segnaAttesa(false); disegnaPasso(); }
    });
  }

  /* Telefono: i passi sul menu laterale aprono il menu, gli altri lo chiudono (finito il movimento del menu). */
  function menuPerIlPasso(c, trovati) {
    var app = document.getElementById('app');
    var serveMenu = trovati.length && menuNascosto() && nelMenu(trovati);
    if (serveMenu && !app.classList.contains('menu-aperto')) {
      app.classList.add('menu-aperto');
      c.menuAperto = true;
      return aspettaFermo(document.getElementById('laterale'), 700);
    }
    if (!serveMenu && c.menuAperto) {
      app.classList.remove('menu-aperto');
      c.menuAperto = false;
    }
    return Promise.resolve();
  }

  /*
   * Finestra ridimensionata o telefono ruotato: l'elemento del passo può essere uscito dallo schermo, e il menu
   * laterale può essere diventato nascosto (o di nuovo sempre visibile). Finito il ridimensionamento lo riporto in vista.
   */
  var timerRidimensiona = null;

  function suRidimensiona() {
    var c = corsa;
    if (!c) return;
    var w = root.innerWidth, a = root.innerHeight;
    var d = c.dimensioni || [w, a];
    // la barra degli indirizzi del telefono che compare e scompare mentre si scorre: non riporto indietro la pagina
    if (w === d[0] && Math.abs(a - d[1]) < d[1] * 0.25) return;
    c.dimensioni = [w, a];
    clearTimeout(timerRidimensiona);
    timerRidimensiona = setTimeout(riallinea, 200);
  }

  function riallinea() {
    timerRidimensiona = null;
    var c = corsa;
    if (!c || c.inAttesa) return;
    var gettone = c.gettone;
    var p = c.passi[c.i];
    var trovati = p && p.el ? trova(p) : [];
    menuPerIlPasso(c, trovati).then(function () {
      if (corsa !== c || c.gettone !== gettone || c.inAttesa) return;
      c.bersagli = trovati;
      if (trovati.length) portaInVista(trovati);
      c.ultimaPosizione = null;
    });
  }

  /* Lo scorrimento morbido chiesto dal giro non è ancora finito: la destinazione, altrimenti null. */
  function scorrimentoInCorso() {
    if (!scorrimento) return null;
    if (Date.now() > scorrimento.fino || Math.abs(root.scrollY - scorrimento.y) < 1) { scorrimento = null; return null; }
    return scorrimento;
  }

  /* Porta in vista gli elementi: prima i riquadri che scorrono (menu, tabelle), poi la pagina. */
  function portaInVista(elementi) {
    var primo = elementi[0];
    // niente scrollIntoView: su una pagina più larga dello schermo sposterebbe di lato anche la vista del telefono
    scorriContenitori(primo);
    liberaDalleColonneFisse(primo);
    // gli elementi fissi (barra in alto, menu laterale, finestre) non si spostano scorrendo la pagina: dentro una
    // finestra basta lo scorrimento del suo corpo (scorriContenitori)
    if (elementi.some(function (e) { return e.closest('.testa-fissa, .laterale, #modale'); })) return;
    var r = rettangoloDi(elementi);
    var v = vista();
    var alto = Math.max(v.y, altezzaTesta());
    var fondo = v.y + v.h;
    // la pagina sta ancora scorrendo verso il passo di prima (Indietro e Avanti in fretta): conta dove sarà l'elemento
    // alla fine di quello scorrimento, non dove si trova adesso (ora può sembrare già in vista e poi uscire)
    var inCorso = scorrimentoInCorso();
    var spostamento = inCorso ? root.scrollY - inCorso.y : 0;
    if (r.t + spostamento >= alto + 8 && r.b + spostamento <= fondo - 8) return;
    var disponibile = fondo - alto;
    var altezza = r.b - r.t;
    var cima = altezza + 32 < disponibile ? alto + (disponibile - altezza) / 2 : alto + 16;
    var massimo = Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - root.innerHeight);
    var y = Math.round(Math.min(massimo, Math.max(0, root.scrollY + r.t - cima)));
    var morbido = !rid();
    try { root.scrollTo({ top: y, behavior: morbido ? 'smooth' : 'auto' }); } catch (e) { root.scrollTo(0, y); }
    scorrimento = morbido && Math.abs(root.scrollY - y) >= 1 ? { y: y, fino: Date.now() + DURATA_SCORRIMENTO } : null;
    // finito lo scorrimento controllo che l'elemento si veda davvero
    var c = corsa, i = c ? c.i : -1;
    setTimeout(function () { if (corsa === c && c && c.i === i) avvicinaVista(elementi); }, morbido ? 480 : 0);
  }

  /*
   * Sul telefono, se una pagina è più larga dello schermo, la parte visibile è più piccola della finestra e il fondo
   * della pagina si raggiunge solo spostando la vista. La sposto con una "sonda" invisibile messa nella colonna già
   * visibile: così la vista si muove solo in verticale, mai di lato.
   */
  function avvicinaVista(elementi) {
    var r = rettangoloDi(elementi.filter(function (e) { return e.isConnected; }));
    if (!r) return;
    var v = vista();
    if (r.b > v.y + 8 && r.t < v.y + v.h - 8) return;
    // la pagina sta ancora scorrendo verso l'elemento: ci arriva da sola
    if (scorrimentoInCorso()) return;
    var sonda = document.createElement('div');
    sonda.className = 'tour-sonda';
    sonda.style.left = Math.round(root.scrollX + v.x + 1) + 'px';
    sonda.style.top = Math.round(root.scrollY + r.t + Math.max(0, Math.min(r.b - r.t, v.h - 160)) / 2) + 'px';
    document.body.appendChild(sonda);
    try { sonda.scrollIntoView({ block: 'center', inline: 'nearest' }); } finally { sonda.remove(); }
  }

  /* Fa scorrere i riquadri che contengono l'elemento (menu laterale, tabelle, nota consumi, finestre) quel tanto che
     basta a mostrarlo; la pagina intera la fa scorrere portaInVista, solo in verticale. */
  function scorriContenitori(e) {
    for (var a = e.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      var st = getComputedStyle(a);
      var oy = /(auto|scroll)/.test(st.overflowY) && a.scrollHeight > a.clientHeight + 1;
      var ox = /(auto|scroll)/.test(st.overflowX) && a.scrollWidth > a.clientWidth + 1;
      if (!ox && !oy) continue;
      var ra = a.getBoundingClientRect();
      var su = ra.top + a.clientTop, giu = su + a.clientHeight;
      var sx = ra.left + a.clientLeft, dx = sx + a.clientWidth;
      var r = e.getBoundingClientRect();
      if (oy) {
        if (r.top < su) a.scrollTop -= su - r.top + 8;
        else if (r.bottom > giu) a.scrollTop += Math.max(0, Math.min(r.bottom - giu + 8, r.top - su - 8));
      }
      if (ox) {
        if (r.left < sx) a.scrollLeft -= sx - r.left + 8;
        else if (r.right > dx) a.scrollLeft += Math.max(0, Math.min(r.right - dx + 8, r.left - sx - 8));
      }
    }
  }

  /* Nella nota consumi la denominazione (a sinistra) e le intestazioni (in alto) restano ferme scorrendo:
     la casella da mostrare va al centro della parte che scorre, non sotto di loro. */
  function liberaDalleColonneFisse(e) {
    var cont = e.closest('.registro-contenitore');
    if (!cont) return;
    var rc = cont.getBoundingClientRect();
    var re = e.getBoundingClientRect();
    var den = cont.querySelector('thead .den');
    var testa = cont.querySelector('thead');
    var sx = den ? den.getBoundingClientRect().width : 0;
    var hy = testa ? testa.getBoundingClientRect().height : 0;
    if (!e.closest('.den')) cont.scrollLeft += (re.left + re.width / 2) - (rc.left + sx + (rc.width - sx) / 2);
    if (!e.closest('thead') && re.top < rc.top + hy) cont.scrollTop -= rc.top + hy - re.top + 4;
  }

  function disegnaPasso() {
    var c = corsa;
    if (!c || !radice) return;
    var p = c.passi[c.i];
    var n = c.i + 1, tot = c.passi.length;
    var ultimo = n === tot;
    var f = el('.tour-fumetto');
    el('.tour-giro').textContent = (c.giro.ico ? c.giro.ico + ' ' : '') + c.giro.titolo;
    el('.tour-conta').textContent = 'Passo ' + n + ' di ' + tot;
    el('.tour-avanzamento span').style.width = Math.round(n / tot * 100) + '%';
    el('#tour-titolo').textContent = valore(p.titolo);
    el('#tour-testo').innerHTML = valore(p.testo) || '';
    var ind = el('[data-tour="indietro"]');
    ind.disabled = c.i === 0;
    ind.hidden = c.i === 0;
    var av = el('[data-tour="avanti"]');
    av.textContent = ultimo ? 'Fine ✓' : 'Avanti ›';
    el('[data-tour="esci"]').hidden = ultimo;
    el('[data-tour="altri"]').hidden = !ultimo || Tour.elenco().length < 2;
    el('.tour-tasti').hidden = c.i !== 0;
    f.hidden = false;
    // animazione d'entrata a ogni passo
    f.classList.remove('entra');
    void f.offsetWidth;
    f.classList.add('entra');
    var luce = el('.tour-luce');
    luce.classList.add('muove');
    clearTimeout(c.timerMuove);
    c.timerMuove = setTimeout(function () { if (luce) luce.classList.remove('muove'); }, 420);
    c.ultimaPosizione = null;
    posiziona();
    // il fuoco nel fumetto: i tasti non finiscono nei campi della pagina
    try { av.focus({ preventScroll: true }); } catch (e) { av.focus(); }
  }

  /*
   * La parte di pagina che si vede davvero (in coordinate della pagina). Di solito è tutta la finestra; sul telefono,
   * con lo zoom delle dita o con una pagina più larga dello schermo, è più piccola della "finestra" dei fixed.
   */
  function vista() {
    var vv = root.visualViewport;
    if (vv && vv.width > 0) return { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height };
    return { x: 0, y: 0, w: document.documentElement.clientWidth, h: root.innerHeight };
  }

  /* Calcola riquadro luminoso e posto del fumetto (anche mentre la pagina scorre o cambia). */
  function posiziona() {
    var c = corsa;
    if (!c || !radice) return;
    var f = el('.tour-fumetto');
    var luce = el('.tour-luce');
    if (f.hidden) return;
    var v = vista();
    var W = v.w, H = v.h;
    var p = c.passi[c.i];

    // larghezza del fumetto: fissa sul computer, tutto lo schermo (meno i margini) sul telefono
    var largo = Math.round(W <= 600 ? W - 2 * BORDO : Math.min(344, W - 2 * BORDO));
    if (c.larghezza !== largo) { c.larghezza = largo; f.style.width = largo + 'px'; f.style.maxWidth = 'none'; }

    // gli elementi della pagina possono essere stati ridisegnati (aggiornamenti da altri utenti)
    if (c.bersagli && c.bersagli.length && !c.bersagli.every(function (e) { return e.isConnected; })) c.bersagli = trova(p);
    var bersagli = (c.bersagli || []).filter(visibile);
    var r = bersagli.length ? rettangoloDi(bersagli) : null;
    if (r) {
      // da qui in poi tutto è misurato dalla parte visibile
      r = { l: r.l - v.x - MARGINE, t: r.t - v.y - MARGINE, r: r.r - v.x + MARGINE, b: r.b - v.y + MARGINE };
      // dentro lo schermo; un elemento uscito del tutto dallo schermo non si evidenzia
      r.l = Math.max(r.l, 3); r.t = Math.max(r.t, 3); r.r = Math.min(r.r, W - 3); r.b = Math.min(r.b, H - 3);
      if (r.r - r.l < 4 || r.b - r.t < 4) r = null;
    }
    c.centrato = !r;

    var bw = f.offsetWidth, bh = Math.min(f.offsetHeight, H - 2 * BORDO);
    var pos = null;
    if (r) pos = sceltaPosto(r, bw, bh, W, H, p.posizione);
    if (!pos) {
      if (r) {
        // non c'è posto accanto all'elemento: il fumetto si appoggia in basso (o in alto) senza coprirne il centro
        var centro = (r.t + r.b) / 2;
        var giu = p.riparo ? p.riparo === 'fondo' : centro < H / 2;
        pos = { lato: giu ? 'fondo' : 'cima', x: (W - bw) / 2, y: giu ? H - bh - BORDO : BORDO };
      } else {
        pos = { lato: 'centro', x: (W - bw) / 2, y: Math.max(BORDO, (H - bh) / 2 - H * 0.06) };
      }
    }

    // gira a ogni fotogramma: scrivo nella pagina solo se qualcosa è cambiato
    var chiave = [v.x, v.y, W, H].map(Math.round).join(',') + '|' + (r ? [r.l, r.t, r.r, r.b].map(Math.round).join(',') : 'centro') + '|' +
      pos.lato + ',' + Math.round(pos.x) + ',' + Math.round(pos.y) + ',' + Math.round(pos.freccia || 0);
    if (chiave === c.ultimaPosizione) return;
    c.ultimaPosizione = chiave;

    if (r) {
      luce.classList.remove('vuota');
      luce.style.left = (v.x + r.l) + 'px';
      luce.style.top = (v.y + r.t) + 'px';
      luce.style.width = (r.r - r.l) + 'px';
      luce.style.height = (r.b - r.t) + 'px';
      luce.style.borderRadius = Math.min(12, (r.b - r.t) / 2) + 'px';
    } else {
      luce.classList.add('vuota');
      luce.style.left = (v.x + W / 2) + 'px';
      luce.style.top = (v.y + H / 2) + 'px';
      luce.style.width = '0px';
      luce.style.height = '0px';
    }
    f.setAttribute('data-lato', pos.lato);
    f.style.left = Math.round(v.x + pos.x) + 'px';
    f.style.top = Math.round(v.y + pos.y) + 'px';
    f.style.maxHeight = Math.round(H - 2 * BORDO) + 'px';
    var freccia = el('.tour-freccia');
    if (pos.freccia !== undefined) {
      if (pos.lato === 'sotto' || pos.lato === 'sopra') { freccia.style.left = Math.round(pos.freccia - 7) + 'px'; freccia.style.top = ''; }
      else { freccia.style.top = Math.round(pos.freccia - 7) + 'px'; freccia.style.left = ''; }
    }
  }

  function limita(v, min, max) { return Math.max(min, Math.min(max, v)); }

  /* Primo posto libero tra quello chiesto e gli altri; null se il fumetto non sta accanto all'elemento. */
  function sceltaPosto(r, bw, bh, W, H, preferito) {
    var ordine = ['sotto', 'sopra', 'destra', 'sinistra'];
    if (preferito && ordine.indexOf(preferito) >= 0) ordine = [preferito].concat(ordine.filter(function (x) { return x !== preferito; }));
    var cx = (r.l + r.r) / 2, cy = (r.t + r.b) / 2;
    for (var k = 0; k < ordine.length; k++) {
      var lato = ordine[k];
      var x, y;
      if (lato === 'sotto' || lato === 'sopra') {
        y = lato === 'sotto' ? r.b + DISTANZA : r.t - DISTANZA - bh;
        if (y < BORDO || y + bh > H - BORDO) continue;
        x = limita(cx - bw / 2, BORDO, W - bw - BORDO);
        return { lato: lato, x: x, y: y, freccia: limita(cx - x, 18, bw - 18) };
      }
      x = lato === 'destra' ? r.r + DISTANZA : r.l - DISTANZA - bw;
      if (x < BORDO || x + bw > W - BORDO) continue;
      y = limita(cy - bh / 2, BORDO, H - bh - BORDO);
      return { lato: lato, x: x, y: y, freccia: limita(cy - y, 18, bh - 18) };
    }
    return null;
  }

  /* Riquadro e fumetto seguono l'elemento a ogni fotogramma: scorrimento, menu che entra, pagina ridisegnata. */
  function seguiElemento() {
    rafPosizione = 0;
    if (!corsa) return;
    posiziona();
    rafPosizione = root.requestAnimationFrame(seguiElemento);
  }

  /* ---------- tastiera: con il giro aperto i tasti servono al giro (e non aprono altre pagine) ---------- */
  function tasti(e) {
    if (!corsa || !radice) return;
    var f = el('.tour-fumetto');
    var dentro = f && f.contains(document.activeElement);
    e.stopPropagation();
    switch (e.key) {
      case 'Escape': e.preventDefault(); Tour.ferma(); return;
      case 'ArrowRight': case 'PageDown': e.preventDefault(); avanti(); return;
      case 'ArrowLeft': case 'PageUp': e.preventDefault(); indietro(); return;
      case 'Enter':
        // Invio su un pulsante del fumetto preme quel pulsante; altrove va avanti
        if (dentro && document.activeElement.tagName === 'BUTTON') return;
        e.preventDefault(); avanti(); return;
      case 'Tab': {
        // il fuoco resta nei pulsanti del fumetto
        var b = lista(f.querySelectorAll('button')).filter(function (x) { return !x.hidden && !x.disabled; });
        if (!b.length) return;
        var i = b.indexOf(document.activeElement);
        e.preventDefault();
        var j = e.shiftKey ? (i <= 0 ? b.length - 1 : i - 1) : (i < 0 || i >= b.length - 1 ? 0 : i + 1);
        b[j].focus();
        return;
      }
      default:
        // niente scrittura nei campi della pagina mentre il giro è aperto (lo scorrimento con le frecce resta)
        if (!dentro && e.key && e.key.length === 1) e.preventDefault();
    }
  }

  function suHashchange() {
    nascondiInvito(true);
    if (!corsa) return;
    // la pagina è cambiata senza il giro (per esempio con il tasto Indietro del browser): il giro si chiude
    var qui = location.hash.slice(1);
    if (corsa.paginaAttesa && qui && qui !== corsa.paginaAttesa) Tour.ferma();
  }

  function controllo() {
    if (!corsa) return;
    // uscita, sessione scaduta: niente giro sopra la schermata di accesso
    if (!appPronta()) Tour.ferma();
  }

  /* ======================= avvio e fine ======================= */

  function chiudiAltro() {
    // finestre, ricerca e menu dell'utente si chiudono: il giro deve vedere la pagina
    if (!document.getElementById('modale').hidden) App.chiudiModale();
    var ric = document.getElementById('ricerca');
    if (ric && !ric.hidden) {
      if (App.chiudiRicerca) App.chiudiRicerca();
      else {
        ric.hidden = true;
        if (document.getElementById('modale').hidden) document.getElementById('velo').hidden = true;
      }
    }
    var t = document.getElementById('utente-tendina');
    if (t && !t.hidden) { t.hidden = true; document.getElementById('utente-btn').setAttribute('aria-expanded', 'false'); }
    // il menu laterale aperto a mano (finestra stretta) coprirebbe la pagina: lo riapre il giro nei passi sul menu
    var app = document.getElementById('app');
    if (app) app.classList.remove('menu-aperto');
    chiudiElenco();
    nascondiInvito(false);
  }

  function inizia(g) {
    if (corsa) Tour.ferma();
    chiudiAltro();
    var pagina = paginaDelGiro(g) || App.paginaCorrente;
    corsa = {
      giro: g,
      pagina: pagina,
      passi: [],
      i: 0,
      gettone: 0,
      saltati: [],
      bersagli: [],
      centrato: true,
      inAttesa: true,
      menuAperto: false,
      ambiente: null,
      ambienteMio: false,
      navigatoIl: 0,
      paginaAttesa: App.paginaCorrente,
      fuocoPrima: document.activeElement,
      dimensioni: [root.innerWidth, root.innerHeight]
    };
    scorrimento = null;
    corsa.passi = g.passi.filter(function (p) {
      if (p.se && !p.se()) return false;
      var pag = paginaDelPasso(p);
      return !pag || App.paginaPermessa(pag);
    });
    if (!corsa.passi.length) { corsa = null; return false; }
    // chi avvia un giro l'invito non lo vede più
    if (App.utente) scriviMemoria(chiaveInvito(), 'fatto');
    radice = costruisci();
    root.addEventListener('keydown', tasti, true);
    root.addEventListener('resize', suRidimensiona);
    timerPosizione = setInterval(controllo, 250);
    rafPosizione = root.requestAnimationFrame(seguiElemento);
    vaiAlPasso(0, 1);
    return true;
  }

  var Tour = {};

  Tour.avvia = function (id) {
    var g = giro(id);
    if (!appPronta() || !giroPermesso(g)) return false;
    // una finestra con qualcosa di scritto non si chiude da sola (si perderebbe): prima la chiude chi la sta usando
    if (finestraConDatiScritti()) {
      App.avviso('Prima chiudi la finestra aperta (o salva quello che hai scritto), poi avvia il giro guidato.', 'errore');
      return false;
    }
    // il giro cambia pagina o vista: se qui c'è qualcosa di scritto e non registrato, chiedo prima
    if (modificheNonRegistrate() && cambiaPaginaOVista(g)) {
      App.conferma('Giro guidato', 'Il giro apre un’altra pagina: quello che hai scritto qui e non hai ancora registrato andrebbe perso.', 'Continua lo stesso')
        .then(function (ok) { if (ok) inizia(g); });
      return true;
    }
    return inizia(g);
  };

  Tour.ferma = function () {
    var c = corsa;
    corsa = null;
    scorrimento = null;
    clearInterval(timerPosizione);
    timerPosizione = null;
    if (rafPosizione) { root.cancelAnimationFrame(rafPosizione); rafPosizione = 0; }
    root.removeEventListener('keydown', tasti, true);
    root.removeEventListener('resize', suRidimensiona);
    clearTimeout(timerRidimensiona);
    timerRidimensiona = null;
    if (c && c.menuAperto) document.getElementById('app').classList.remove('menu-aperto');
    if (c) { clearTimeout(c.timerMuove); chiudiAmbiente(c); }
    var r = radice;
    radice = null;
    // il fuoco torna dove era solo se è ancora nel giro: se nel frattempo è andato altrove (per esempio nel campo
    // password della sessione scaduta) non lo sposto
    var attivo = document.activeElement;
    var fuocoNelGiro = !attivo || attivo === document.body || (!!r && r.contains(attivo));
    if (c && fuocoNelGiro && appUsabile()) {
      var prima = c.fuocoPrima;
      // l'elemento di prima non c'è più (pagina cambiata, elenco dei giri o invito chiusi): il pulsante Guidami
      var dove = prima && prima !== document.body && prima.isConnected && typeof prima.focus === 'function' &&
        !prima.closest('.tour-elenco, .tour-invito') ? prima : document.getElementById('guidami');
      if (dove) { try { dove.focus({ preventScroll: true }); } catch (e) { /* niente */ } }
    }
    if (r) {
      r.classList.remove('visibile');
      r.classList.add('esce');
      setTimeout(function () { r.remove(); }, rid() ? 0 : 180);
    }
  };

  Tour.elenco = function () {
    return GIRI.filter(giroPermesso).map(function (g) {
      return { id: g.id, titolo: g.titolo, descrizione: g.descrizione, pagina: paginaDelGiro(g) || null, ico: g.ico, gruppo: g.gruppo || '' };
    });
  };

  Tour.perPagina = function (pagina) {
    var candidati = GIRI.filter(function (x) { return x.perPagina === pagina; });
    if (!candidati.length) return null;
    var permessi = candidati.filter(giroPermesso);
    var g = permessi.filter(function (x) { try { return x.qui && x.qui(); } catch (e) { return false; } })[0] || permessi[0] || candidati[0];
    return g.id;
  };

  /* Per le prove automatiche: cosa sta mostrando il giro. */
  Tour.stato = function () {
    if (!corsa) return { attivo: false };
    var p = corsa.passi[corsa.i] || {};
    return {
      attivo: true,
      giro: corsa.giro.id,
      indice: corsa.i + 1,
      totale: corsa.passi.length,
      titolo: valore(p.titolo),
      selettore: typeof p.el === 'string' ? p.el : (p.el ? '(funzione)' : null),
      facoltativo: !!p.facoltativo,
      conElemento: !!p.el,
      centrato: !!corsa.centrato,
      inAttesa: !!corsa.inAttesa,
      menuAperto: !!corsa.menuAperto,
      ambiente: corsa.ambiente ? corsa.ambiente.id : null,
      saltati: corsa.saltati.slice(),
      pagina: App.paginaCorrente
    };
  };

  Tour.bersagli = function () { return corsa ? (corsa.bersagli || []).slice() : []; };

  /* ======================= elenco dei giri (pulsante Guidami) ======================= */

  var elenco = null;

  function elencoAperto() { return !!(elenco && elenco.isConnected); }

  function chiudiElenco() {
    if (!elenco) return;
    elenco.remove();
    elenco = null;
    document.removeEventListener('click', clicFuoriElenco, true);
    root.removeEventListener('keydown', tastiElenco, true);
    root.removeEventListener('resize', posizionaElenco);
    var g = document.getElementById('guidami');
    if (g) g.setAttribute('aria-expanded', 'false');
  }

  function clicFuoriElenco(e) {
    if (!elenco || elenco.contains(e.target) || e.target.closest('#guidami')) return;
    chiudiElenco();
  }

  function tastiElenco(e) {
    if (!elencoAperto()) return;
    e.stopPropagation();
    var b = lista(elenco.querySelectorAll('button[data-giro]'));
    var i = b.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); chiudiElenco(); var g = document.getElementById('guidami'); if (g) g.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); b[(i + 1) % b.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); b[(i - 1 + b.length) % b.length].focus(); }
    else if (e.key === 'Tab') { if (!elenco.contains(document.activeElement) || (e.shiftKey ? i === 0 : i === b.length - 1)) chiudiElenco(); }
  }

  function posizionaElenco() {
    if (!elenco) return;
    var g = document.getElementById('guidami');
    var v = vista();
    var r = g ? g.getBoundingClientRect() : { left: v.x + v.w - 60, bottom: v.y + 60, right: v.x + v.w - 16 };
    var largo = Math.min(380, v.w - 24);
    elenco.style.width = largo + 'px';
    elenco.style.top = Math.round(r.bottom + 8) + 'px';
    elenco.style.left = Math.round(limita(r.right - largo, v.x + 12, v.x + v.w - largo - 12)) + 'px';
    elenco.style.maxHeight = Math.round(v.y + v.h - r.bottom - 20) + 'px';
    var freccia = elenco.querySelector('.tour-freccia');
    if (freccia && g) freccia.style.left = Math.round(limita((r.left + r.right) / 2 - parseFloat(elenco.style.left) - 7, 14, largo - 28)) + 'px';
  }

  // titolo di un gruppo nell'elenco (stile con le variabili del tema: css/tour.css non ha ancora una regola apposta)
  var STILE_GRUPPO = 'list-style:none;padding:10px 10px 3px;font-size:10.5px;font-weight:700;letter-spacing:.07em;' +
    'text-transform:uppercase;color:var(--tenue)';

  Tour.apriElenco = function () {
    if (!appPronta()) return;
    if (elencoAperto()) { chiudiElenco(); return; }
    var giri = Tour.elenco();
    var qui = Tour.perPagina(App.paginaCorrente);
    var gruppoPrima = null;
    elenco = document.createElement('div');
    elenco.className = 'tour-elenco';
    elenco.setAttribute('role', 'dialog');
    elenco.setAttribute('aria-label', 'Giri guidati');
    elenco.innerHTML = '<span class="tour-freccia" aria-hidden="true"></span>' +
      '<div class="tour-elenco-testa"><b>🧭 Giri guidati</b><span>Scegli cosa vuoi vedere: ti accompagno passo per passo, senza registrare niente.</span></div>' +
      '<ul>' + giri.map(function (g) {
        var titoloGruppo = '';
        if (g.gruppo && g.gruppo !== gruppoPrima && GRUPPI[g.gruppo]) {
          titoloGruppo = '<li class="tour-elenco-gruppo" role="presentation" style="' + STILE_GRUPPO + '">' + h(GRUPPI[g.gruppo]) + '</li>';
        }
        gruppoPrima = g.gruppo;
        return titoloGruppo + '<li><button type="button" data-giro="' + h(g.id) + '"' + (g.id === qui ? ' class="qui"' : '') + '>' +
          '<span class="ico" aria-hidden="true">' + h(g.ico || '🧭') + '</span>' +
          '<span class="testi"><b>' + h(g.titolo) + '</b><small>' + h(g.descrizione) + '</small></span></button></li>';
      }).join('') + '</ul>' +
      '<p class="tour-elenco-piede">Le istruzioni scritte e i video sono nella <a href="#guida">Guida</a>.</p>';
    elenco.addEventListener('click', function (e) {
      var b = e.target.closest('[data-giro]');
      if (b) { var id = b.getAttribute('data-giro'); chiudiElenco(); Tour.avvia(id); return; }
      if (e.target.closest('a[href="#guida"]')) chiudiElenco();
    });
    document.body.appendChild(elenco);
    posizionaElenco();
    var gb = document.getElementById('guidami');
    if (gb) gb.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', clicFuoriElenco, true);
    root.addEventListener('keydown', tastiElenco, true);
    root.addEventListener('resize', posizionaElenco);
    var primo = elenco.querySelector('button.qui') || elenco.querySelector('button[data-giro]');
    if (primo) {
      try { primo.focus({ preventScroll: true }); } catch (e) { primo.focus(); }
      // il giro della pagina in vista anche in fondo a un elenco lungo
      if (primo.classList.contains('qui')) scorriContenitori(primo);
    }
  };

  /* Pulsante 🧭 Guidami nella barra: il giro della pagina aperta, altrimenti l'elenco. */
  function suGuidami() {
    if (!appPronta()) return;
    var id = Tour.perPagina(App.paginaCorrente);
    if (id && giroPermesso(giro(id))) { chiudiElenco(); Tour.avvia(id); }
    else Tour.apriElenco();
  }

  /* ======================= invito al primo accesso ======================= */

  var invito = null;
  var timerInvito = null;

  function daInvitare() {
    if (!App.utente || !App.S) return false;
    var v = leggiMemoria(chiaveInvito());
    if (!v) return true;
    // "Non ora": si richiede in un altro giorno
    var m = /^dopo:(\d{4}-\d{2}-\d{2})$/.exec(v);
    return !!(m && m[1] < App.oggi());
  }

  function nascondiInvito(rimanda) {
    clearTimeout(timerInvito);
    timerInvito = null;
    if (!invito) return;
    // ignorato (si è passati a un'altra pagina): come "Non ora"
    if (rimanda && App.utente) scriviMemoria(chiaveInvito(), 'dopo:' + App.oggi());
    var x = invito;
    invito = null;
    x.classList.add('esce');
    setTimeout(function () { x.remove(); }, rid() ? 0 : 160);
  }

  function mostraInvito() {
    timerInvito = null;
    if (invito || corsa || !daInvitare()) return;
    var app = document.getElementById('app');
    if (!app || app.hidden || (root.Accesso && root.Accesso.visibile())) return;
    if (!document.getElementById('modale').hidden) return;
    invito = document.createElement('div');
    invito.className = 'tour-invito';
    invito.setAttribute('role', 'dialog');
    invito.setAttribute('aria-labelledby', 'tour-invito-titolo');
    invito.innerHTML = '<span class="tour-invito-ico" aria-hidden="true">🧭</span>' +
      '<div class="tour-invito-corpo"><b id="tour-invito-titolo">Vuoi un giro guidato di un minuto?</b>' +
      '<p>Ti mostro il menu, la pagina Oggi, la ricerca e dove trovare la guida. Puoi uscire quando vuoi.</p>' +
      '<div class="tour-invito-azioni">' +
      '<button class="btn primario piccolo" type="button" data-invito="si">Sì, fammi vedere</button>' +
      '<button class="btn piccolo" type="button" data-invito="dopo">Non ora</button>' +
      '<button class="btn fantasma piccolo" type="button" data-invito="mai">Non chiedere più</button>' +
      '</div></div>';
    invito.addEventListener('click', function (e) {
      var b = e.target.closest('[data-invito]');
      if (!b) return;
      var scelta = b.getAttribute('data-invito');
      scriviMemoria(chiaveInvito(), scelta === 'mai' ? 'mai' : scelta === 'si' ? 'fatto' : 'dopo:' + App.oggi());
      nascondiInvito(false);
      if (scelta === 'si') Tour.avvia('benvenuto');
    });
    document.body.appendChild(invito);
  }

  /*
   * L'app diventa visibile dopo l'accesso (anche dopo una sessione scaduta, magari con un altro utente): un attimo dopo,
   * se è il primo accesso di quell'utente su questo browser, l'invito. Quando sopra compare la schermata di accesso
   * (uscita, sessione scaduta) giro, elenco e invito si chiudono subito.
   */
  function osservaIngresso() {
    var app = document.getElementById('app');
    var acc = document.getElementById('accesso');
    if (!app || !root.MutationObserver) return;
    var usabilePrima = appUsabile();
    var oss = new root.MutationObserver(function () {
      var ora = appUsabile();
      if (ora === usabilePrima) return;
      usabilePrima = ora;
      if (!ora) { nascondiInvito(false); chiudiElenco(); if (corsa) Tour.ferma(); return; }
      clearTimeout(timerInvito);
      timerInvito = setTimeout(mostraInvito, 1200);
    });
    oss.observe(app, { attributes: true, attributeFilter: ['hidden'] });
    if (acc) oss.observe(acc, { attributes: true, attributeFilter: ['hidden'] });
  }

  /* ======================= collegamenti ======================= */

  var bottone = document.getElementById('guidami');
  if (bottone) {
    bottone.setAttribute('aria-haspopup', 'dialog');
    bottone.addEventListener('click', suGuidami);
  }
  root.addEventListener('hashchange', suHashchange);
  osservaIngresso();

  root.Tour = Tour;
})(this);
