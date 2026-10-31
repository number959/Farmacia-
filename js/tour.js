/*
 * Guida sullo schermo ("Guidami"): giri passo per passo sulle pagine del Gestionale Farmacia.
 *
 * window.Tour
 *   avvia(id)          avvia un giro (false se non esiste o non è permesso all'utente)
 *   ferma()            chiude il giro aperto
 *   elenco()           [{ id, titolo, descrizione, pagina, ico }] dei giri permessi all'utente
 *   perPagina(pagina)  id del giro della pagina (null se la pagina non ne ha uno)
 *   apriElenco()       piccolo elenco dei giri, sotto il pulsante Guidami
 *   stato(), bersagli() per le prove automatiche (strumenti/prova-tour.js)
 *
 * Un passo: { pagina?, el?: selettore | function () → selettore o elemento, titolo, testo,
 *             posizione?: 'sopra'|'sotto'|'destra'|'sinistra', facoltativo?: true, prima?: function () {},
 *             se?: function () → false per saltarlo, insieme?: true (evidenzia tutti gli elementi trovati),
 *             risali?: selettore (evidenzia il contenitore più vicino, per esempio l'etichetta di una spunta),
 *             riparo?: 'fondo'|'cima' (dove appoggiare il fumetto se non c'è posto accanto all'elemento) }
 * Senza "pagina" il passo usa la pagina del giro; con pagina: null resta dove si trova.
 *
 * Il giro non scrive niente e non preme pulsanti: apre le pagine (App.vai), le porta in vista e,
 * sul telefono, apre il menu laterale quando il passo è lì.
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

  /* ======================= condizioni comuni ======================= */

  function puo(p) { return function () { return App.puo(p); }; }

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

  var GIRI = [
    {
      id: 'benvenuto', perPagina: 'oggi', pagina: 'oggi', ico: '👋',
      titolo: 'Primo giro del programma',
      descrizione: 'Menu, pagina Oggi, ricerca rapida, il tuo utente e dove trovare la guida.',
      passi: [
        { titolo: 'Benvenuto nel Gestionale Farmacia',
          testo: 'In un minuto ti mostro dove sono le cose. Vai avanti con <b>Avanti</b> o con la freccia <kbd>→</kbd>; esci quando vuoi con <kbd>Esc</kbd>.' },
        { el: '#menu', posizione: 'destra', riparo: 'fondo', titolo: 'Il menu',
          testo: 'Qui ci sono tutte le pagine che il tuo ruolo può usare. La lettera a destra è il <b>tasto rapido</b>: premila (fuori dai campi) per aprire la pagina.' },
        { el: '.azioni-rapide', facoltativo: true, posizione: 'sotto', titolo: 'Il lavoro di ogni giorno',
          testo: 'I pulsanti per le operazioni più frequenti, con il loro tasto rapido.' },
        { el: '.indicatori', posizione: 'sotto', titolo: 'Cosa controllare oggi',
          testo: 'Articoli sotto la scorta minima, lotti scaduti e lotti in scadenza. Toccane uno per aprire l’elenco completo.' },
        { el: '#apri-ricerca', posizione: 'sotto', titolo: 'Ricerca rapida',
          testo: 'Premi <kbd>Ctrl</kbd> <kbd>K</kbd> (oppure <kbd>/</kbd>) da qualsiasi pagina, scrivi il nome di un articolo o di una pagina e premi Invio.' },
        { el: '#utente-menu', posizione: 'sotto', titolo: 'Il tuo utente',
          testo: 'Da qui cambi la password ed esci. Se il computer è condiviso, esci sempre a fine turno.' },
        { el: '#collegamento', facoltativo: true, posizione: 'sotto', titolo: 'Collegamento al server',
          testo: '<b>● In linea</b>: quello che registrano gli altri lo vedi subito. Se compare <b>⚠ Server non raggiungibile</b>, non registrare finché il collegamento non torna.' },
        { el: '#guidami', posizione: 'sotto', titolo: 'Guidami',
          testo: 'In ogni pagina questo pulsante ti mostra, passo per passo, cosa fare lì.' },
        { el: '#menu a[data-pagina="guida"]', posizione: 'destra', titolo: 'Guida e videoguide',
          testo: 'Nella Guida trovi le istruzioni scritte e i video di ogni operazione. Buon lavoro!' }
      ]
    },
    {
      id: 'carico', perPagina: 'carico', pagina: 'carico', ico: '📥',
      titolo: 'Carico della merce',
      descrizione: 'Registrare la merce arrivata dal fornitore, con lotto e scadenza.',
      passi: [
        { el: '#contenuto .scheda .modulo', posizione: 'sotto', titolo: 'Intestazione del carico',
          testo: 'Data, reparto che riceve (di solito la Farmacia), fornitore e numero del DDT o della fattura.' },
        BARRA_LETTORE,
        { el: '#righe tr:first-child .r-art', posizione: 'sotto', titolo: 'Articolo',
          testo: 'Scrivi le prime lettere e scegli dall’elenco. Sotto compare la giacenza attuale del reparto.' },
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
      id: 'consumi', perPagina: 'consumi', pagina: 'consumi', ico: '💊',
      titolo: 'Consumi del giorno',
      descrizione: 'Il foglio dei consumi di un reparto: scrivi le quantità usate e registra.',
      passi: [
        { el: '#c-data, #c-rep', insieme: true, posizione: 'sotto', titolo: 'Giorno e reparto',
          testo: 'Scegli la data e il reparto. Vedi solo i reparti in cui puoi registrare.' },
        copia(BARRA_LETTORE, { testo: 'Ogni lettura aggiunge il consumo dell’articolo letto: una unità, o una confezione intera se lo scegli.' }),
        { el: '#c-cat, #c-cerca', insieme: true, posizione: 'sotto', titolo: 'Trova in fretta',
          testo: 'Filtra per categoria (farmaci o presidi) o scrivi parte del nome.' },
        { el: '#c-tutti', risali: '.spunta', posizione: 'sotto', titolo: 'Articoli senza giacenza',
          testo: 'Di solito vedi solo gli articoli presenti nel reparto. Spunta qui se quello che cerchi non c’è.' },
        { el: '#c-foglio input.q', facoltativo: true, posizione: 'sinistra', titolo: 'Quantità usate',
          testo: 'Scrivi quante unità sono state usate. <kbd>Invio</kbd> passa alla riga sotto; le righe compilate diventano verdi.' },
        { el: '#c-registra', posizione: 'sotto', titolo: 'Registra consumi',
          testo: 'Un clic registra tutte le righe compilate. Se la giacenza non basta, il programma te lo chiede prima.' },
        { el: '#c-fatti', posizione: 'sopra', titolo: 'Già registrati',
          testo: 'Qui sotto ci sono i consumi di quel giorno. Un errore? <b>Annulla</b> sulla riga, con il motivo.' }
      ]
    },
    {
      id: 'trasferimenti', perPagina: 'trasferimenti', pagina: 'trasferimenti', ico: '🔁',
      titolo: 'Trasferimenti ai reparti',
      descrizione: 'Dalla Farmacia ai reparti (o tra reparti), con il lotto che si sposta.',
      passi: [
        { el: '#t-da, #t-a', insieme: true, posizione: 'sotto', titolo: 'Da dove, a dove',
          testo: 'Di solito dalla Farmacia al reparto. Per la Farmacia è uno scarico, per il reparto un carico.' },
        BARRA_LETTORE,
        { el: '#righe tr:first-child .r-art, #righe tr:first-child .r-q', insieme: true, posizione: 'sotto', titolo: 'Articolo e quantità',
          testo: 'Scegli l’articolo e scrivi quanto consegni. Sotto vedi la giacenza nel reparto di partenza.' },
        { el: '#righe tr:first-child .r-lotto-scelta', posizione: 'sotto', titolo: 'Lotto',
          testo: 'Lascia <b>automatico</b>: parte per primo il lotto che scade prima. Scegline uno solo se consegni proprio quello.' },
        { el: '#t-note', posizione: 'sotto', titolo: 'Note',
          testo: 'Numero della richiesta, chi ritira… quello che serve per ritrovarlo.' },
        { el: '#registra', posizione: 'sopra', titolo: 'Registra trasferimento',
          testo: 'Le giacenze dei due reparti cambiano insieme, nello stesso momento.' },
        { el: '#recenti', facoltativo: true, posizione: 'sopra', titolo: 'Ultimi trasferimenti',
          testo: 'Un trasferimento sbagliato si annulla da qui, con il motivo.' }
      ]
    },
    {
      id: 'perdite', perPagina: 'perdite', pagina: 'perdite', ico: '🗑️',
      titolo: 'Perdite e scaduti',
      descrizione: 'Confezioni scadute, rotte, smarrite o rese al fornitore.',
      passi: [
        { el: '#t-data, #t-rep', insieme: true, posizione: 'sotto', titolo: 'Data e reparto',
          testo: 'Il giorno e il reparto da cui escono le confezioni.' },
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
      id: 'giacenze', perPagina: 'giacenze', pagina: 'giacenze', ico: '📦',
      titolo: 'Giacenze',
      descrizione: 'Quanto c’è in ogni reparto, valore del magazzino, articoli sotto scorta.',
      passi: [
        { el: '#g-rep', posizione: 'sotto', titolo: 'Reparto',
          testo: '<b>Tutti i reparti</b> mette un reparto per colonna; scegliendone uno vedi anche la prossima scadenza.' },
        { el: '#g-cat, #g-cerca', insieme: true, posizione: 'sotto', titolo: 'Cerca',
          testo: 'Per categoria, nome, principio attivo o codice.' },
        { el: '#g-sotto', risali: '.spunta', posizione: 'sotto', titolo: 'Solo sotto scorta',
          testo: 'Gli articoli sotto la scorta minima nella Farmacia: è la lista da ordinare.' },
        { el: '#g-tab', posizione: 'sopra', titolo: 'La tabella',
          testo: 'Tocca una riga per aprire la scheda dell’articolo, con lotti e ultimi movimenti. In fondo il valore del magazzino.' },
        { el: '#g-stampa, #g-excel', insieme: true, posizione: 'sotto', titolo: 'Stampa ed Excel',
          testo: 'Stampano o esportano esattamente quello che vedi, con gli stessi filtri.' }
      ]
    },
    {
      id: 'scadenze', perPagina: 'scadenze', pagina: 'scadenze', ico: '⏳',
      titolo: 'Scadenze',
      descrizione: 'Lotti in giacenza ordinati per scadenza; togliere gli scaduti.',
      passi: [
        { el: '#z-entro', posizione: 'sotto', titolo: 'Quali lotti',
          testo: 'Solo scaduti, entro 30 o 60 giorni, entro il preavviso impostato, o tutti.' },
        { el: '#z-rep, #z-cat', insieme: true, posizione: 'sotto', titolo: 'Reparto e categoria',
          testo: 'Per vedere un reparto solo, o solo farmaci o presidi.' },
        { el: '#z-tab', posizione: 'sopra', titolo: 'Dal più urgente',
          testo: 'Le etichette rosse sono lotti scaduti o che scadono entro 30 giorni; le arancioni entro il preavviso.' },
        { el: '#z-tab [data-perdita]', se: puo('perdita'), facoltativo: true, posizione: 'sinistra', titolo: 'Togli dal magazzino',
          testo: 'Per un lotto scaduto apre <b>Perdite</b> già compilata: controlli e registri.' },
        { el: '#z-stampa, #z-excel', insieme: true, posizione: 'sotto', titolo: 'Stampa ed Excel',
          testo: 'L’elenco da stampare per il controllo sugli scaffali, o da esportare.' }
      ]
    },
    {
      id: 'movimenti', perPagina: 'movimenti', pagina: 'movimenti', ico: '🧾',
      titolo: 'Movimenti e annullo',
      descrizione: 'L’elenco completo con i filtri; annullare un movimento sbagliato.',
      passi: [
        { el: '#v-dal, #v-al', insieme: true, posizione: 'sotto', titolo: 'Periodo',
          testo: 'Di base dal primo del mese a oggi.' },
        { el: '#v-tipo, #v-rep, #v-cerca', insieme: true, posizione: 'sotto', titolo: 'Filtri',
          testo: 'Tipo di movimento, reparto, e una ricerca su articolo, lotto, fornitore o documento.' },
        { el: '#v-ann', risali: '.spunta', posizione: 'sotto', titolo: 'Annullati',
          testo: 'I movimenti annullati restano nell’elenco, barrati, con chi li ha annullati e perché.' },
        { el: '#v-tab', posizione: 'sopra', titolo: 'Elenco',
          testo: 'Ogni riga ha l’operatore che l’ha registrata. Tocca il nome dell’articolo per aprirne la scheda.' },
        { el: '#v-tab [data-annulla]', se: puoAnnullareQualcosa, facoltativo: true, posizione: 'sinistra', titolo: 'Annullare',
          testo: 'Un movimento non si cancella: si <b>annulla</b> scrivendo il motivo. Vedi il pulsante solo sui movimenti che puoi annullare.' },
        { el: '#v-excel', posizione: 'sotto', titolo: 'Excel',
          testo: 'Esporta i movimenti filtrati, con tutte le colonne.' }
      ]
    },
    {
      id: 'inventario', perPagina: 'inventario', pagina: 'inventario', ico: '✅',
      titolo: 'Inventario',
      descrizione: 'Foglio di conta: le differenze diventano rettifiche.',
      passi: [
        { el: '#i-data, #i-rep', insieme: true, posizione: 'sotto', titolo: 'Data e reparto',
          testo: 'Il giorno della conta e il reparto che stai contando.' },
        copia(BARRA_LETTORE, { testo: 'Ogni lettura aggiunge alla quantità contata dell’articolo: puoi contare passando le confezioni al lettore.' }),
        { el: '#i-stampa', posizione: 'sotto', titolo: 'Foglio di conta',
          testo: 'Stampalo e portalo con te mentre conti sugli scaffali.' },
        { el: '#i-tab input.q', facoltativo: true, posizione: 'sinistra', titolo: 'Quantità contata',
          testo: 'Scrivi solo quello che hai contato: le righe vuote non cambiano. La differenza compare subito accanto.' },
        { el: '#i-registra', posizione: 'sotto', titolo: 'Registra differenze',
          testo: 'Le differenze diventano rettifiche d’inventario. Prima di registrare il programma ti chiede conferma.' }
      ]
    },
    {
      id: 'registro', perPagina: 'registro', pagina: 'registro', ico: '📅',
      titolo: 'Nota consumi mensile',
      descrizione: 'Il modulo del mese per reparto: correzioni, stampa ed Excel.',
      passi: [
        { el: '#r-rep, #r-mese, #r-cat', insieme: true, posizione: 'sotto', titolo: 'Quale modulo',
          testo: 'Reparto, mese e modulo (Farmaci o Presidi): è lo stesso foglio di sempre, già compilato.' },
        { el: '#r-tutti', risali: '.spunta', posizione: 'sotto', titolo: 'Tutti gli articoli',
          testo: 'Spunta per avere nel modulo anche gli articoli senza movimenti nel mese.' },
        { el: '#r-tab table.registro thead', facoltativo: true, posizione: 'sotto', titolo: 'Le colonne',
          testo: 'Residui, carichi, consumi giorno per giorno, perdite, residui finali e importo: si calcolano da soli dai movimenti.' },
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
      id: 'articoli', perPagina: 'articoli', pagina: 'articoli', ico: '🏷️',
      titolo: 'Articoli',
      descrizione: 'L’anagrafica di farmaci e presidi, importazione da Excel.',
      passi: [
        { el: '#a-cerca', posizione: 'sotto', titolo: 'Cerca',
          testo: 'Per nome, principio attivo o codice.' },
        { el: '#a-cat, #a-non', insieme: true, posizione: 'sotto', titolo: 'Filtri',
          testo: 'Farmaci o presidi; spunta <b>Mostra non attivi</b> per vedere anche gli articoli nascosti.' },
        { el: '#a-tab .tabella tbody tr', facoltativo: true, posizione: 'sotto', titolo: 'Scheda dell’articolo',
          testo: 'Tocca una riga per vedere giacenze e lotti di ogni reparto e gli ultimi movimenti.' },
        { el: '#a-tab [data-modifica]', se: puo('articoli'), facoltativo: true, posizione: 'sinistra', titolo: 'Modifica',
          testo: 'Per correggere nome, unità, prezzo, scorta minima. Un articolo con movimenti non si elimina: togli la spunta <b>Attivo</b>.' },
        { el: '#a-nuovo', se: puo('articoli'), posizione: 'sotto', titolo: 'Nuovo articolo',
          testo: 'Denominazione, categoria, unità, codice AIC, prezzo e scorta minima.' },
        { el: '#a-importa', se: puo('articoli'), posizione: 'sotto', titolo: 'Importa da Excel',
          testo: 'Anche dai vecchi moduli <b>Nota consumi</b> compilati: gli articoli già presenti non si duplicano.' },
        { el: '#a-excel', posizione: 'sotto', titolo: 'Esporta Excel',
          testo: 'L’anagrafica completa in un file Excel.' }
      ]
    },
    {
      id: 'scanner', pagina: paginaLettore, se: conLettore, ico: '📷',
      titolo: 'Lettore di codici a barre',
      descrizione: 'Caricare e scaricare leggendo le confezioni, con il lettore o la fotocamera.',
      passi: [
        { titolo: 'Lettore di codici a barre',
          testo: 'Puoi leggere le confezioni con un <b>lettore USB o Bluetooth</b>, oppure con la <b>fotocamera</b> del telefono o del tablet.' },
        { el: '.barra-scanner', facoltativo: true, posizione: 'sotto', titolo: 'La barra di lettura',
          testo: 'Compare in cima alle pagine dove registri: carico, consumi, trasferimenti, perdite, inventario.' },
        { el: '#scanner-campo', facoltativo: true, posizione: 'sotto', titolo: 'Campo di lettura',
          testo: 'Clicca qui e leggi il codice. Se il lettore non lo legge, scrivi il codice a mano e premi <kbd>Invio</kbd>. Il lettore funziona anche con il cursore in un altro campo.' },
        { el: '#scanner-modo', facoltativo: true, posizione: 'sotto', titolo: 'Quanto vale una lettura',
          testo: 'Una <b>unità</b> o una <b>confezione</b> intera (i pezzi per confezione si scrivono nell’articolo). La scelta si ricorda per ogni pagina.' },
        { el: '#scanner-fotocamera', facoltativo: true, posizione: 'sotto', titolo: 'Fotocamera',
          testo: 'Inquadra il codice: la finestra si chiude alla prima lettura, oppure scegli la lettura continua per molte confezioni.' },
        { titolo: 'Codice sconosciuto',
          testo: 'Se il programma non conosce il codice te lo dice. Chi gestisce gli articoli lo collega a un articolo (o ne crea uno nuovo): da quel momento viene riconosciuto.' },
        { titolo: 'Nelle altre pagine',
          testo: 'In Oggi, Giacenze e Scadenze una lettura apre la scheda dell’articolo, con giacenze e lotti.' }
      ]
    },
    {
      id: 'utenti', perPagina: 'utenti', pagina: 'utenti', ico: '👥',
      titolo: 'Utenti e ruoli',
      descrizione: 'Creare gli utenti, cambiare ruolo e reparti, dare una nuova password.',
      passi: [
        { el: '#contenuto > .banda.info', posizione: 'sotto', titolo: 'I ruoli',
          testo: 'Cosa può fare ogni ruolo. Il menu di ogni utente mostra solo le pagine che può usare.' },
        { el: '#u-nuovo', posizione: 'sotto', titolo: 'Nuovo utente',
          testo: 'Nome utente, nome e cognome, ruolo e una password provvisoria (<b>Genera</b> ne crea una facile da dettare). Al primo accesso l’utente sceglie la sua.' },
        { el: '#u-tab', posizione: 'sopra', titolo: 'Elenco',
          testo: 'Per ognuno lo stato (attivo, password provvisoria, bloccato, disattivato) e l’ultimo accesso.' },
        { el: '#u-tab [data-modifica]', facoltativo: true, posizione: 'sinistra', titolo: 'Modifica',
          testo: 'Cambia ruolo e reparti. Togli la spunta <b>Utente attivo</b> per bloccare l’accesso senza perdere i suoi movimenti.' },
        { el: '#u-tab [data-password]', facoltativo: true, posizione: 'sinistra', titolo: 'Nuova password',
          testo: 'Per chi l’ha dimenticata o è bloccato dopo 5 tentativi: dai una password provvisoria, da cambiare al primo accesso.' },
        { el: '#u-anche', risali: '.spunta', posizione: 'sotto', titolo: 'Utenti disattivati',
          testo: 'Spunta per vederli e, se serve, riattivarli.' }
      ]
    },
    {
      id: 'attivita', perPagina: 'attivita', pagina: 'attivita', ico: '📜',
      titolo: 'Registro attività',
      descrizione: 'Chi ha fatto cosa e quando: accessi e operazioni.',
      passi: [
        { el: '#t-dal, #t-al', insieme: true, posizione: 'sotto', titolo: 'Periodo',
          testo: 'Di base l’ultima settimana.' },
        { el: '#t-utente, #t-azione', insieme: true, posizione: 'sotto', titolo: 'Utente e azione',
          testo: 'Un utente solo, oppure un tipo di azione: accessi, movimenti, correzioni del registro, articoli, utenti…' },
        { el: '#t-tab', posizione: 'sopra', titolo: 'Il registro',
          testo: 'Quando, chi, cosa e da quale computer (indirizzo IP). In rosso gli accessi non riusciti.' },
        { el: '#t-aggiorna, #t-excel', insieme: true, posizione: 'sotto', titolo: 'Aggiorna ed Excel',
          testo: 'Il registro si aggiorna da solo quando altri lavorano; con Excel lo esporti.' }
      ]
    },
    {
      id: 'configura', perPagina: 'configura', pagina: 'configura', ico: '⚙️',
      titolo: 'Configurazione e copie di sicurezza',
      descrizione: 'Struttura, reparti, copie di sicurezza del server.',
      passi: [
        { el: '#k-struttura', risali: '.scheda', se: puo('impostazioni'), posizione: 'destra', titolo: 'Struttura',
          testo: 'Nome e logo (compaiono anche nell’accesso), dati del modulo stampato e giorni di preavviso per le scadenze.' },
        { el: '#k-reparti', risali: '.scheda', se: puo('impostazioni'), posizione: 'sinistra', titolo: 'Reparti',
          testo: 'Il reparto <b>centrale</b> è la Farmacia. Un reparto con movimenti non si elimina: togli la spunta <b>Attivo</b>.' },
        { el: '#k-backup-crea', risali: '.scheda', se: puo('backup'), posizione: 'sopra', titolo: 'Copie di sicurezza',
          testo: 'Il server fa una copia al giorno e tiene le ultime 30. Puoi crearne una adesso, scaricarla o ripristinarla.' },
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

  /* Campi scritti e non ancora registrati nella pagina aperta (cambiando pagina andrebbero persi). */
  function modificheNonRegistrate() {
    var cont = document.getElementById('contenuto');
    if (!cont) return false;
    return lista(cont.querySelectorAll('input, textarea')).some(function (i) {
      var t = (i.getAttribute('type') || 'text').toLowerCase();
      if (['text', 'number', 'month'].indexOf(t) < 0 && i.tagName !== 'TEXTAREA') return false;
      // filtri, quantità tenute da parte dalle pagine, caselle del registro (si salvano da sole), lettore
      if (i.closest('.strumenti, .barra-scanner') || i.matches('input.q[data-art], td.g input')) return false;
      return i.value !== i.defaultValue;
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

  function el(c) { return radice ? radice.querySelector(c) : null; }

  function costruisci() {
    var r = document.createElement('div');
    r.className = 'tour';
    r.id = 'tour';
    r.innerHTML =
      '<div class="tour-blocco"></div>' +
      '<div class="tour-luce vuota"></div>' +
      '<div class="tour-fumetto" role="dialog" aria-modal="true" aria-labelledby="tour-titolo" aria-describedby="tour-testo" hidden>' +
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

  /* Mostra il passo i (verso: 1 avanti, -1 indietro): apre la pagina, aspetta l'elemento, lo porta in vista. */
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

    var pag = paginaDelPasso(p);
    var apertura = Promise.resolve();
    if (pag && App.paginaCorrente !== pag) {
      c.paginaAttesa = pag;
      c.navigatoIl = Date.now();
      App.vai(pag);
      apertura = aspettaChe(function () { return App.paginaCorrente === pag; }, ATTESA_MAX);
    }
    apertura.then(function () {
      if (!vivo()) return null;
      if (p.prima) { try { return p.prima(); } catch (e) { console.error(e); } }
      return null;
    }).then(function () {
      if (!vivo()) return null;
      if (!p.el) return [];
      // dopo un cambio di pagina aspetto fino a ~3 s in tutto; sulla pagina già pronta mezzo secondo basta
      var limite = Math.max(ATTESA_MINIMA, ATTESA_MAX - (Date.now() - c.navigatoIl));
      return aspettaChe(function () { var t = trova(p); return t.length ? t : null; }, limite);
    }).then(function (trovati) {
      if (!vivo()) return null;
      if (p.el && !(trovati && trovati.length)) {
        if (p.facoltativo) {
          // l'elemento non c'è (per esempio una parte non ancora pronta del programma): salto il passo
          c.saltati.push(p.titolo);
          c.passi.splice(i, 1);
          if (!c.passi.length) { Tour.ferma(); return null; }
          if (verso < 0) vaiAlPasso(Math.max(0, i - 1), i > 0 ? -1 : 1);
          else vaiAlPasso(i, 1);
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

  /* Porta in vista gli elementi: prima i riquadri che scorrono (menu, tabelle), poi la pagina. */
  function portaInVista(elementi) {
    var primo = elementi[0];
    // niente scrollIntoView: su una pagina più larga dello schermo sposterebbe di lato anche la vista del telefono
    scorriContenitori(primo);
    liberaDalleColonneFisse(primo);
    // gli elementi fissi (barra in alto, menu laterale) non si spostano scorrendo la pagina
    if (elementi.some(function (e) { return e.closest('.testa-fissa, .laterale'); })) return;
    var r = rettangoloDi(elementi);
    var v = vista();
    var alto = Math.max(v.y, altezzaTesta());
    var fondo = v.y + v.h;
    if (r.t >= alto + 8 && r.b <= fondo - 8) return;
    var disponibile = fondo - alto;
    var altezza = r.b - r.t;
    var cima = altezza + 32 < disponibile ? alto + (disponibile - altezza) / 2 : alto + 16;
    var y = Math.max(0, root.scrollY + r.t - cima);
    try { root.scrollTo({ top: y, behavior: rid() ? 'auto' : 'smooth' }); } catch (e) { root.scrollTo(0, y); }
    // finito lo scorrimento controllo che l'elemento si veda davvero
    var c = corsa, i = c ? c.i : -1;
    setTimeout(function () { if (corsa === c && c && c.i === i) avvicinaVista(elementi); }, rid() ? 0 : 480);
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
    var sonda = document.createElement('div');
    sonda.className = 'tour-sonda';
    sonda.style.left = Math.round(root.scrollX + v.x + 1) + 'px';
    sonda.style.top = Math.round(root.scrollY + r.t + Math.max(0, Math.min(r.b - r.t, v.h - 160)) / 2) + 'px';
    document.body.appendChild(sonda);
    try { sonda.scrollIntoView({ block: 'center', inline: 'nearest' }); } finally { sonda.remove(); }
  }

  /* Fa scorrere i riquadri che contengono l'elemento (menu laterale, tabelle, nota consumi) quel tanto che basta
     a mostrarlo; la pagina intera la fa scorrere portaInVista, solo in verticale. */
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
    el('#tour-titolo').textContent = p.titolo;
    el('#tour-testo').innerHTML = p.testo || '';
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
      ric.hidden = true;
      if (document.getElementById('modale').hidden) document.getElementById('velo').hidden = true;
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
      navigatoIl: 0,
      paginaAttesa: App.paginaCorrente,
      fuocoPrima: document.activeElement,
      dimensioni: [root.innerWidth, root.innerHeight]
    };
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
    var pag = paginaDelGiro(g);
    // il giro cambia pagina: se qui c'è qualcosa di scritto e non registrato, chiedo prima
    if (pag && pag !== App.paginaCorrente && modificheNonRegistrate()) {
      App.conferma('Giro guidato', 'Il giro apre un’altra pagina: quello che hai scritto qui e non hai ancora registrato andrebbe perso.', 'Continua lo stesso')
        .then(function (ok) { if (ok) inizia(g); });
      return true;
    }
    return inizia(g);
  };

  Tour.ferma = function () {
    var c = corsa;
    corsa = null;
    clearInterval(timerPosizione);
    timerPosizione = null;
    if (rafPosizione) { root.cancelAnimationFrame(rafPosizione); rafPosizione = 0; }
    root.removeEventListener('keydown', tasti, true);
    root.removeEventListener('resize', suRidimensiona);
    clearTimeout(timerRidimensiona);
    timerRidimensiona = null;
    if (c && c.menuAperto) document.getElementById('app').classList.remove('menu-aperto');
    if (c) clearTimeout(c.timerMuove);
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
      return { id: g.id, titolo: g.titolo, descrizione: g.descrizione, pagina: paginaDelGiro(g) || null, ico: g.ico };
    });
  };

  Tour.perPagina = function (pagina) {
    var g = GIRI.filter(function (x) { return x.perPagina === pagina; })[0];
    return g ? g.id : null;
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
      titolo: p.titolo,
      selettore: typeof p.el === 'string' ? p.el : (p.el ? '(funzione)' : null),
      facoltativo: !!p.facoltativo,
      conElemento: !!p.el,
      centrato: !!corsa.centrato,
      inAttesa: !!corsa.inAttesa,
      menuAperto: !!corsa.menuAperto,
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

  Tour.apriElenco = function () {
    if (!appPronta()) return;
    if (elencoAperto()) { chiudiElenco(); return; }
    var giri = Tour.elenco();
    var qui = Tour.perPagina(App.paginaCorrente);
    elenco = document.createElement('div');
    elenco.className = 'tour-elenco';
    elenco.setAttribute('role', 'dialog');
    elenco.setAttribute('aria-label', 'Giri guidati');
    elenco.innerHTML = '<span class="tour-freccia" aria-hidden="true"></span>' +
      '<div class="tour-elenco-testa"><b>🧭 Giri guidati</b><span>Scegli cosa vuoi vedere: ti accompagno passo per passo, senza registrare niente.</span></div>' +
      '<ul>' + giri.map(function (g) {
        return '<li><button type="button" data-giro="' + h(g.id) + '"' + (g.id === qui ? ' class="qui"' : '') + '>' +
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
    if (primo) { try { primo.focus({ preventScroll: true }); } catch (e) { primo.focus(); } }
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
