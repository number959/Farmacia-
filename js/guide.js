/*
 * Guide e videoguide del Gestionale Farmacia.
 *
 * window.Guide
 *   ELENCO   [{ id, titolo, descrizione, ico, permesso, perChi?, giro, video, copertina, sottotitoli, passi }]
 *            permesso: null (per tutti) | 'carico' | ['carico', 'consumo', …] (ne basta uno); giro: id del giro di js/tour.js
 *            (o null). I passi sono anche le didascalie del video: strumenti/genera-videoguide.js gira uno scenario con un
 *            passo per ognuno e scrive i tempi nei sottotitoli guide/<id>.vtt.
 *   serve(g)          true se la guida riguarda le pagine che l'utente collegato può usare
 *   controlla(g)      Promise → { video: bool, passi: [{ inizio, fine, testo }], durata: secondi | null } (con memoria)
 *   apriVideo(id)     finestra con il video, i passi a fianco (cliccabili) e il pulsante Guidami
 *
 * Sostituisce la pagina Guida di js/pagine.js (questo file si carica dopo): sopra le schede delle guide, sotto le
 * istruzioni scritte della pagina di prima, a sezioni che si aprono. In Node (module.exports) dà solo l'elenco,
 * per lo strumento che genera i video.
 */
(function (root) {
  'use strict';

  function guida(id, ico, titolo, descrizione, permesso, giro, passi, perChi) {
    return {
      id: id,
      ico: ico,
      titolo: titolo,
      descrizione: descrizione,
      permesso: permesso,
      perChi: perChi || '',
      giro: giro,
      video: 'guide/' + id + '.mp4',
      copertina: 'guide/' + id + '.jpg',
      sottotitoli: 'guide/' + id + '.vtt',
      passi: passi
    };
  }

  var REGISTRA = ['carico', 'consumo', 'trasferimento', 'perdita', 'rettifica'];

  var ELENCO = [
    guida('primo-accesso', '👋', 'Primo accesso e panoramica',
      'Come entrare, il menu, la pagina Oggi, la ricerca rapida e dove trovare aiuto.', null, 'benvenuto', [
        'Apri il programma con Edge o Chrome, scrivi il tuo nome utente e la password e premi Entra.',
        'Al primo accesso ti propongo un giro guidato di un minuto: puoi farlo subito o più tardi.',
        'A sinistra c’è il menu, con le sole pagine che il tuo ruolo può usare. La lettera a destra è il tasto rapido.',
        'La pagina Oggi ti dice cosa controllare: articoli sotto scorta, lotti scaduti e lotti in scadenza.',
        'Ctrl K apre la ricerca rapida: scrivi il nome di un articolo o di una pagina e premi Invio.',
        'Dal tuo nome, in alto a destra, cambi la password ed esci.',
        'Il pulsante Guidami ti mostra sullo schermo, passo per passo, cosa fare nella pagina aperta.',
        'Nella Guida trovi questi video e le istruzioni scritte.'
      ]),
    guida('carico', '📥', 'Carico della merce',
      'Registrare la merce arrivata dal fornitore, con lotto, scadenza e documento di trasporto.', 'carico', 'carico', [
        'Apri Carico dal menu (tasto C). In alto ci sono la data e il reparto che riceve, di solito la Farmacia.',
        'Scrivi il fornitore e il numero del DDT o della fattura.',
        'Nella riga scrivi le prime lettere dell’articolo e sceglilo dall’elenco: sotto compare la giacenza del reparto.',
        'Scrivi la quantità arrivata, poi lotto e scadenza come sono stampati sulla confezione.',
        'Il prezzo arriva dall’anagrafica. Con Invio passi alla riga sotto per l’articolo successivo.',
        'Controlla e premi Registra carico: la giacenza sale subito, per tutti gli utenti.',
        'Il carico compare tra gli ultimi carichi. Se hai sbagliato, da qui lo annulli scrivendo il motivo.'
      ]),
    guida('lettore', '📷', 'Lettore di codici a barre',
      'Caricare e scaricare leggendo le confezioni con il lettore USB o Bluetooth, o con la fotocamera.', REGISTRA, 'scanner', [
        'Nelle pagine dove registri, in alto c’è la barra di lettura: Carico, Consumi, Trasferimenti, Perdite e Inventario.',
        'Scegli quanto vale ogni lettura: una unità o una confezione intera, con i pezzi scritti nell’articolo.',
        'Leggi la confezione con il lettore: la riga si compila da sola, con il lotto e la scadenza del codice.',
        'Leggi un’altra confezione dello stesso lotto: la quantità aumenta.',
        'Il lettore funziona anche con il cursore in un altro campo: il codice letto non finisce nel campo.',
        'Codice mai visto? Scegli l’articolo giusto, o creane uno nuovo: da quel momento il codice è riconosciuto.',
        'Senza lettore scrivi il codice nel campo di lettura e premi Invio.',
        'Controlla le righe e premi Registra carico. Sul telefono o sul tablet puoi leggere anche con la fotocamera.'
      ]),
    guida('consumi', '💊', 'Consumi del giorno',
      'Il foglio dei consumi di un reparto: scrivi le quantità usate nella giornata e registra.', 'consumo', 'consumi', [
        'Apri Consumi del giorno (tasto S). Scegli la data e il reparto: vedi solo i reparti in cui puoi registrare.',
        'Per trovare prima gli articoli scegli la categoria o cerca per nome.',
        'Nell’ultima colonna scrivi le quantità usate. Invio passa alla riga sotto.',
        'Le righe compilate diventano verdi. Accanto vedi la giacenza del reparto e quanto è già registrato.',
        'Premi Registra consumi: la giacenza scende e i consumi finiscono nella nota consumi del mese.',
        'Sotto ci sono i consumi già registrati nel giorno. Hai sbagliato? Annulla il tuo consumo scrivendo il motivo.'
      ]),
    guida('trasferimenti', '🔁', 'Trasferimenti ai reparti',
      'Dalla Farmacia ai reparti, o tra due reparti, con il lotto che si sposta.', 'trasferimento', 'trasferimenti', [
        'Apri Trasferimenti (tasto T). Da: il reparto che consegna, di solito la Farmacia. A: il reparto che riceve.',
        'Nelle note scrivi il numero della richiesta o chi ritira.',
        'Scegli l’articolo e scrivi la quantità: sotto vedi quanto ce n’è nel reparto che consegna.',
        'Il lotto è automatico, quello che scade prima. Se serve un lotto preciso, sceglilo dall’elenco.',
        'Premi Registra trasferimento: per la Farmacia è uno scarico, per il reparto un carico.',
        'Il trasferimento compare in fondo alla pagina, con il lotto spostato e il reparto di arrivo.'
      ]),
    guida('perdite', '🗑️', 'Perdite, scaduti e resi',
      'Togliere dal magazzino le confezioni scadute, rotte, smarrite o rese al fornitore.', 'perdita', 'perdite', [
        'Le confezioni scadute le trovi in Scadenze (tasto Z): scegli Solo scaduti.',
        'Accanto al lotto scaduto premi Togli dal magazzino.',
        'Si apre Perdite e scaduti con articolo, lotto, quantità e causale Scaduto già compilati.',
        'Per un altro motivo scegli la causale: rotto, smarrito, reso al fornitore. Se serve aggiungi una nota.',
        'Premi Registra perdita: nella nota consumi del mese finisce nella colonna Perdite.',
        'La perdita compare tra le ultime perdite e il lotto scaduto non è più in giacenza.'
      ]),
    guida('giacenze-scadenze', '📦', 'Giacenze e scadenze',
      'Quanto c’è in ogni reparto, cosa è sotto scorta e quali lotti stanno per scadere.', null, 'giacenze', [
        'Giacenze (tasto G) mostra quanto c’è in ogni reparto, il totale e il valore del magazzino.',
        'Filtra per reparto o per categoria, oppure cerca per nome o principio attivo.',
        'Spunta Solo sotto scorta per vedere cosa riordinare.',
        'Tocca una riga per aprire la scheda dell’articolo: giacenze per reparto, lotti e ultimi movimenti.',
        'Scadenze (tasto Z) elenca i lotti in giacenza, dal primo che scade. Il colore dice quanto manca.',
        'Scegli l’intervallo e il reparto. Stampa ed Excel stampano o esportano l’elenco che vedi.'
      ]),
    guida('movimenti', '🧾', 'Movimenti e annullo',
      'Trovare un movimento registrato e annullarlo con il motivo, senza cancellarlo.', null, 'movimenti', [
        'Movimenti (tasto M) elenca tutto ciò che è stato registrato: carichi, consumi, trasferimenti, perdite e rettifiche.',
        'Scegli il periodo, il tipo e il reparto, oppure cerca per articolo, lotto o fornitore.',
        'Un movimento sbagliato non si cancella: premi Annulla accanto al movimento.',
        'Scrivi il motivo e conferma.',
        'Il movimento resta nell’elenco, barrato e con il motivo, ma non conta più. Poi registra quello giusto.',
        'Excel esporta l’elenco che vedi. Chi lavora in un reparto può annullare solo i propri consumi e perdite.'
      ]),
    guida('inventario', '✅', 'Inventario',
      'Contare il magazzino e registrare le differenze come rettifiche.', 'rettifica', 'inventario', [
        'Apri Inventario (tasto I). Scegli la data, il reparto e, se vuoi, la categoria.',
        'Con Stampa foglio di conta hai l’elenco da compilare a mano davanti agli scaffali.',
        'Scrivi le quantità contate: la differenza con la giacenza del programma compare subito.',
        'Le righe lasciate vuote non cambiano. Puoi contare anche con il lettore di codici a barre.',
        'Premi Registra differenze e conferma: ogni differenza diventa una rettifica.',
        'Le rettifiche si vedono in Movimenti e nella nota consumi: in più tra i carichi, in meno tra le perdite.'
      ]),
    guida('nota-consumi', '📅', 'Nota consumi mensile ed Excel',
      'Il modulo del mese di ogni reparto: controllare, correggere un giorno, stampare o esportare in Excel.', null, 'registro', [
        'Apri Nota consumi mensile (tasto R). Scegli il reparto, il mese e il modulo: Farmaci o Presidi.',
        'È il modulo di sempre: residui, carichi, consumi giorno per giorno, perdite, residui e importi.',
        'Per correggere un consumo clicca la casella del giorno, scrivi il numero e premi Invio.',
        'Il numero sostituisce i consumi di quel giorno e i totali della riga si aggiornano subito.',
        'Esporta nel modulo Excel crea il file originale della clinica, già compilato.',
        'Oppure premi Stampa: esce il modulo pronto per le firme.'
      ]),
    guida('articoli', '🏷️', 'Articoli e importazione',
      'L’anagrafica di farmaci e presidi: cercare, creare un articolo, codici a barre, importazione da Excel.', 'articoli', 'articoli', [
        'Articoli (tasto A) è l’anagrafica: cerca per nome, principio attivo o codice.',
        'Tocca un articolo per aprire la sua scheda: giacenze, lotti e ultimi movimenti.',
        'Per un articolo nuovo premi Nuovo articolo e scrivi la denominazione come sul modulo.',
        'Poi categoria, unità di misura, principio attivo e confezione.',
        'Pezzi per confezione e codici a barre servono al lettore; prezzo e scorta minima al controllo del magazzino.',
        'Premi Salva: l’articolo si può caricare e scaricare subito.',
        'Importa da Excel legge un elenco o i vecchi moduli Nota consumi compilati, senza doppioni.'
      ]),
    guida('utenti', '👥', 'Utenti e ruoli',
      'Creare gli utenti, scegliere ruolo e reparti, dare una password provvisoria.', 'utenti', 'utenti', [
        'Utenti (tasto U) è solo per l’amministratore. In alto c’è cosa può fare ogni ruolo.',
        'Premi Nuovo utente e scrivi il nome per entrare e il nome e cognome.',
        'Scegli il ruolo. Per il ruolo Reparto spunta i reparti in cui la persona registra.',
        'Genera una password provvisoria e comunicala: al primo accesso la persona ne sceglie una sua.',
        'Premi Crea utente: compare nell’elenco con la password provvisoria.',
        'Password dimenticata o utente bloccato? Nuova password. Con Modifica cambi ruolo e reparti o disattivi l’utente.'
      ], 'Amministratore'),
    guida('copie', '💾', 'Copie di sicurezza',
      'Le copie automatiche di ogni giorno, la copia a mano, scaricare e ripristinare una copia.', 'backup', 'configura', [
        'Le copie di sicurezza sono in Configura (tasto F), solo per l’amministratore.',
        'Il server fa da solo una copia al giorno e tiene le ultime 30.',
        'Prima di un lavoro importante premi Crea una copia adesso.',
        'Scarica salva il file della copia: ogni tanto conservane una anche fuori dal server.',
        'Ripristina riporta i dati a quel momento, per tutti. Prima il server salva lo stato attuale.',
        'Per conferma bisogna scrivere RIPRISTINA. Qui annulliamo. Utenti e password non cambiano.'
      ], 'Amministratore'),
    guida('password', '🔑', 'Accesso e cambio password',
      'Il primo accesso con la password provvisoria, il cambio password, l’uscita e cosa fare se resti bloccato.', null, null, [
        'Entra con il nome utente e la password provvisoria che ti ha dato l’amministratore.',
        'Al primo accesso scegli una password tua, di almeno 8 caratteri, e scrivila due volte.',
        'Per cambiarla in seguito tocca il tuo nome in alto a destra e scegli Cambia password.',
        'Scrivi la password attuale e quella nuova. Le altre sessioni aperte con il tuo utente si chiudono.',
        'Su un computer condiviso esci sempre a fine turno: tocca il tuo nome e poi Esci.',
        'Dopo 5 tentativi sbagliati l’accesso si blocca per 15 minuti: chiedi all’amministratore una password provvisoria.'
      ])
  ];

  var Guide = { ELENCO: ELENCO };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Guide;
    return;
  }
  root.Guide = Guide;

  var App = root.App;
  if (!App) return;
  var h = App.h;

  /* ======================= permessi e giri ======================= */

  Guide.trova = function (id) { return ELENCO.filter(function (g) { return g.id === id; })[0] || null; };

  Guide.serve = function (g) {
    if (!g.permesso) return true;
    var lista = typeof g.permesso === 'string' ? [g.permesso] : g.permesso;
    return lista.some(function (p) { return App.puo(p); });
  };

  // il pulsante Guidami c'è se js/tour.js è caricato e il giro è tra quelli permessi all'utente
  function giroDisponibile(g) {
    var T = root.Tour;
    if (!g.giro || !T || typeof T.avvia !== 'function') return false;
    if (typeof T.elenco !== 'function') return true;
    try {
      return T.elenco().some(function (x) { return x.id === g.giro; });
    } catch (e) { return false; }
  }

  function avviaGiro(g) {
    if (!giroDisponibile(g)) return;
    App.chiudiModale();
    root.Tour.avvia(g.giro);
  }

  /* ======================= video e sottotitoli ======================= */

  // "00:01:02.500" o "01:02.500" → secondi
  function secondi(t) {
    var p = String(t).trim().replace(',', '.').split(':').map(Number);
    var s = 0;
    for (var i = 0; i < p.length; i++) s = s * 60 + (p[i] || 0);
    return s;
  }

  function leggiVtt(testo) {
    var righe = String(testo || '').replace(/\r/g, '').split('\n');
    var passi = [];
    for (var i = 0; i < righe.length; i++) {
      var m = /^\s*([\d:.,]+)\s+-->\s+([\d:.,]+)/.exec(righe[i]);
      if (!m) continue;
      var parole = [];
      for (var j = i + 1; j < righe.length && righe[j].trim(); j++) parole.push(righe[j].trim());
      i = j;
      passi.push({ inizio: secondi(m[1]), fine: secondi(m[2]), testo: parole.join(' ').replace(/<[^>]*>/g, '') });
    }
    return passi;
  }

  function durata(s) {
    var n = Math.max(0, Math.round(s || 0));
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  }

  // il file c'è? HEAD; se il server non lo capisce (405, 501…) provo a chiedere il primo byte
  function esiste(url) {
    return fetch(url, { method: 'HEAD', cache: 'no-cache' }).then(function (r) {
      if (r.ok) return true;
      if (r.status === 404 || r.status === 410) return false;
      return fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-cache' }).then(function (x) { return x.ok; });
    }).catch(function () { return false; });
  }

  var stato = {}; // id → Promise del controllo (una volta per sessione della pagina)

  Guide.controlla = function (g) {
    if (!stato[g.id]) {
      stato[g.id] = esiste(g.video).then(function (c) {
        if (!c) return { video: false, passi: [], durata: null };
        return fetch(g.sottotitoli, { cache: 'no-cache' }).then(function (r) {
          return r.ok ? r.text() : '';
        }).catch(function () { return ''; }).then(function (vtt) {
          var passi = leggiVtt(vtt);
          return { video: true, passi: passi, durata: passi.length ? passi[passi.length - 1].fine : null };
        });
      });
      // dopo un errore (per esempio la rete) si riprova la volta dopo
      stato[g.id].catch(function () { delete stato[g.id]; });
    }
    return stato[g.id];
  };

  /* Finestra con il video: i passi stanno a fianco (sotto sul telefono), quello in corso è evidenziato, un clic ci salta. */
  Guide.apriVideo = function (id) {
    var g = Guide.trova(id);
    if (!g) return;
    Guide.controlla(g).then(function (st) {
      if (!st.video) { App.avviso('Il video di questa guida non è ancora disponibile.', 'errore'); return; }
      var conTempi = st.passi.length > 0;
      var passi = conTempi ? st.passi : g.passi.map(function (t) { return { inizio: null, fine: null, testo: t }; });
      var giro = giroDisponibile(g);
      var video = null;
      App.apriModale({
        titolo: g.ico + ' ' + g.titolo,
        largo: true,
        corpo: '<div class="guide-lettore">' +
          '<div class="guide-video"><video controls playsinline preload="auto" poster="' + h(g.copertina) + '" src="' + h(g.video) + '">' +
          '<track kind="subtitles" srclang="it" label="Italiano" src="' + h(g.sottotitoli) + '">' +
          'Il browser non riesce a mostrare il video.</video></div>' +
          '<div class="guide-lettore-passi"><h3>Passi</h3><ol class="guide-passi-video">' +
          passi.map(function (p, i) {
            return '<li><button type="button" data-passo="' + i + '"' + (conTempi ? '' : ' disabled') + '>' +
              '<span class="guide-tempo">' + (conTempi ? durata(p.inizio) : String(i + 1)) + '</span><span>' + h(p.testo) + '</span></button></li>';
          }).join('') + '</ol></div></div>',
        piede: (giro ? '<button class="btn" type="button" id="guide-giro-video" title="Ti mostro sullo schermo dove sono le cose">🧭 Guidami sulla pagina</button>' : '') +
          '<span class="spazio"></span><button class="btn primario" type="button" data-chiudi>Chiudi</button>',
        allaChiusura: function () { if (video) { try { video.pause(); } catch (e) { /* già chiuso */ } } },
        dopo: function (m) {
          m.classList.add('guide-modale');
          video = m.querySelector('video');
          var voci = m.querySelectorAll('.guide-passi-video li');
          var lista = m.querySelector('.guide-passi-video');
          var attivo = -1;
          function aggiorna() {
            if (!conTempi) return;
            var t = video.currentTime;
            var i = -1;
            passi.forEach(function (p, k) { if (t >= p.inizio - 0.05) i = k; });
            if (i === attivo) return;
            attivo = i;
            Array.prototype.forEach.call(voci, function (li, k) { li.classList.toggle('attivo', k === i); });
            // la lista scorre da sola solo quando ha una sua barra (a fianco del video)
            if (i >= 0 && lista.scrollHeight > lista.clientHeight + 4) {
              var li = voci[i];
              if (li.offsetTop < lista.scrollTop || li.offsetTop + li.offsetHeight > lista.scrollTop + lista.clientHeight) {
                lista.scrollTop = Math.max(0, li.offsetTop - lista.clientHeight / 3);
              }
            }
          }
          video.addEventListener('timeupdate', aggiorna);
          video.addEventListener('seeked', aggiorna);
          video.addEventListener('error', function () {
            var box = m.querySelector('.guide-video');
            if (box) box.insertAdjacentHTML('beforeend', '<p class="guide-errore-video">Non riesco a caricare il video. Riprova più tardi.</p>');
          });
          lista.addEventListener('click', function (e) {
            var b = e.target.closest('[data-passo]');
            if (!b || !conTempi) return;
            video.currentTime = passi[Number(b.getAttribute('data-passo'))].inizio + 0.01;
            var p = video.play();
            if (p && p.catch) p.catch(function () { /* il browser non lo fa partire da solo: c'è il tasto play */ });
          });
          var bg = m.querySelector('#guide-giro-video');
          if (bg) bg.addEventListener('click', function () { avviaGiro(g); });
          // si apre con un clic: il video parte subito
          var p = video.play();
          if (p && p.catch) p.catch(function () { /* niente: resta il tasto play */ });
          video.focus();
        }
      });
    });
  };

  /* ======================= istruzioni scritte (dalla pagina Guida di js/pagine.js) ======================= */

  var guidaScritta = App.pagine.guida;

  // le sezioni <h3> della pagina di prima, ognuna con il suo contenuto
  function sezioniScritte() {
    var out = { intro: '', sezioni: [] };
    if (typeof guidaScritta !== 'function') return out;
    var tmp = document.createElement('div');
    try { guidaScritta(tmp, {}); } catch (e) { return out; }
    var box = tmp.querySelector('.guida') || tmp;
    var corrente = null;
    Array.prototype.slice.call(box.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && n.tagName === 'H3') {
        corrente = { titolo: n.textContent, html: '' };
        out.sezioni.push(corrente);
        return;
      }
      var html = n.nodeType === 1 ? n.outerHTML : n.nodeType === 3 ? h(n.textContent) : '';
      if (corrente) corrente.html += html; else out.intro += html;
    });
    return out;
  }

  /* ======================= pagina Guida ======================= */

  var CHIAVE_FILTRO = 'gf-guide-solo-mie';

  function leggiFiltro() {
    try { return root.localStorage.getItem(CHIAVE_FILTRO) !== 'no'; } catch (e) { return true; }
  }

  function salvaFiltro(si) {
    try { root.localStorage.setItem(CHIAVE_FILTRO, si ? 'si' : 'no'); } catch (e) { /* memoria del browser non disponibile */ }
  }

  function normalizza(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ');
  }

  function schedaGuida(g, serve) {
    var giro = serve && giroDisponibile(g);
    return '<article class="guide-scheda" data-guida="' + h(g.id) + '">' +
      '<div class="guide-copertina" data-copertina="' + h(g.id) + '">' +
      '<span class="guide-ico" aria-hidden="true">' + g.ico + '</span>' +
      '<span class="guide-play" aria-hidden="true" hidden>▶</span>' +
      '<span class="guide-durata" hidden></span></div>' +
      '<div class="guide-corpo">' +
      '<h3>' + h(g.titolo) + '</h3>' +
      '<p class="guide-descr">' + h(g.descrizione) + '</p>' +
      '<p class="guide-meta">' +
      (g.perChi ? '<span class="etichetta info">' + h(g.perChi) + '</span>' : '') +
      (!serve ? '<span class="etichetta">non è nel tuo ruolo</span>' : '') +
      '<span class="guide-solo-testo tenue" hidden>Video non ancora disponibile: segui i passi scritti.</span></p>' +
      '<div class="guide-azioni">' +
      '<button class="btn primario" type="button" data-video="' + h(g.id) + '" hidden>▶ Guarda il video</button>' +
      (giro ? '<button class="btn" type="button" data-giro="' + h(g.id) + '" title="Ti mostro sullo schermo, passo per passo, dove sono le cose">🧭 Guidami</button>' : '') +
      '</div>' +
      '<details class="guide-passi"><summary>I passi scritti</summary><ol>' +
      g.passi.map(function (p) { return '<li>' + h(p) + '</li>'; }).join('') + '</ol></details>' +
      '</div></article>';
  }

  // copertina, durata e pulsante del video, appena si sa se il video c'è
  function completaScheda(art, g) {
    Guide.controlla(g).then(function (st) {
      if (!art.isConnected) return;
      var cop = art.querySelector('.guide-copertina');
      if (!st.video) {
        art.querySelector('.guide-solo-testo').hidden = false;
        return;
      }
      art.classList.add('con-video');
      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('load', function () { cop.classList.add('con-immagine'); });
      img.addEventListener('error', function () { img.remove(); });
      img.src = g.copertina;
      cop.insertBefore(img, cop.firstChild);
      cop.querySelector('.guide-play').hidden = false;
      var d = cop.querySelector('.guide-durata');
      if (st.durata) { d.textContent = durata(st.durata); d.hidden = false; }
      var b = art.querySelector('[data-video]');
      b.hidden = false;
      if (st.durata) b.setAttribute('aria-label', 'Guarda il video: ' + g.titolo + ' (durata ' + durata(st.durata) + ')');
    });
  }

  App.pagine.guida = function (cont, par) {
    par = par || {};
    var scritte = sezioniScritte();
    var mie = leggiFiltro();
    var conGiro = !!(root.Tour && typeof root.Tour.avvia === 'function');

    cont.innerHTML =
      '<div class="strumenti guide-strumenti">' +
      '<label class="campo guide-cerca"><span>Cerca nelle guide</span><input id="guide-cerca" type="search" autocomplete="off" placeholder="Per esempio: lotto, scadenza, password…"></label>' +
      '<label class="spunta"><input type="checkbox" id="guide-mie"' + (mie ? ' checked' : '') + '> Solo quelle che mi servono</label>' +
      '<span class="spazio"></span>' +
      (conGiro ? '<button class="btn" type="button" id="guide-benvenuto" title="Il giro di un minuto del programma">🧭 Giro del programma</button>' : '') +
      '</div>' +
      '<section class="scheda guide-elenco"><div class="scheda-testa"><h2>Guide e videoguide</h2><span class="nota" id="guide-conta"></span></div>' +
      '<div class="scheda-corpo"><p class="guide-intro">Un video breve per ogni operazione, con i passi scritti accanto. ' +
      (conGiro ? 'Con <b>🧭 Guidami</b> te lo mostro direttamente sulla pagina, un passo alla volta. ' : '') + '</p>' +
      '<div class="guide-griglia" id="guide-griglia"></div>' +
      '<div class="vuoto" id="guide-nessuna" hidden></div></div></section>' +
      (scritte.sezioni.length || scritte.intro
        ? '<section class="scheda guide-scritte"><div class="scheda-testa"><h2>Istruzioni scritte</h2><span class="nota">Tocca un argomento per aprirlo</span></div>' +
          '<div class="scheda-corpo">' + (scritte.intro ? '<div class="guida guide-scritte-intro">' + scritte.intro + '</div>' : '') +
          scritte.sezioni.map(function (s, i) {
            return '<details class="guide-sezione" data-sezione="' + i + '"><summary>' + h(s.titolo) + '</summary><div class="guida">' + s.html + '</div></details>';
          }).join('') + '</div></section>'
        : '');

    var griglia = cont.querySelector('#guide-griglia');
    var cerca = cont.querySelector('#guide-cerca');
    var filtro = cont.querySelector('#guide-mie');

    function disegna() {
      var t = normalizza(cerca.value.trim());
      var solo = filtro.checked;
      var lista = ELENCO.filter(function (g) {
        if (solo && !Guide.serve(g)) return false;
        if (!t) return true;
        return normalizza(g.titolo + ' ' + g.descrizione + ' ' + g.passi.join(' ')).indexOf(t) >= 0;
      });
      griglia.innerHTML = lista.map(function (g) { return schedaGuida(g, Guide.serve(g)); }).join('');
      griglia.querySelectorAll('.guide-scheda').forEach(function (art) { completaScheda(art, Guide.trova(art.getAttribute('data-guida'))); });
      var nessuna = cont.querySelector('#guide-nessuna');
      nessuna.hidden = lista.length > 0;
      nessuna.innerHTML = lista.length ? '' : '<b>Nessuna guida' + (t ? ' per “' + h(cerca.value.trim()) + '”' : '') + '</b>' +
        (solo ? 'Togli la spunta “Solo quelle che mi servono” per cercare in tutte.' : 'Prova con un’altra parola.');
      cont.querySelector('#guide-conta').textContent = lista.length + (lista.length === 1 ? ' guida' : ' guide');

      // istruzioni scritte: con una ricerca restano (aperte) solo le sezioni che contengono la parola
      cont.querySelectorAll('.guide-sezione').forEach(function (d) {
        if (!t) {
          d.hidden = false;
          if (d.getAttribute('data-da-ricerca')) { d.open = false; d.removeAttribute('data-da-ricerca'); }
          return;
        }
        var trovata = normalizza(d.textContent).indexOf(t) >= 0;
        d.hidden = !trovata;
        if (trovata && !d.open) { d.open = true; d.setAttribute('data-da-ricerca', '1'); }
      });
    }

    cerca.addEventListener('input', disegna);
    filtro.addEventListener('change', function () { salvaFiltro(filtro.checked); disegna(); });
    var benvenuto = cont.querySelector('#guide-benvenuto');
    if (benvenuto) benvenuto.addEventListener('click', function () { root.Tour.avvia('benvenuto'); });

    griglia.addEventListener('click', function (e) {
      var v = e.target.closest('[data-video]');
      if (v) { Guide.apriVideo(v.getAttribute('data-video')); return; }
      var c = e.target.closest('.con-video [data-copertina]');
      if (c) { Guide.apriVideo(c.getAttribute('data-copertina')); return; }
      var gb = e.target.closest('[data-giro]');
      if (gb) avviaGiro(Guide.trova(gb.getAttribute('data-giro')));
    });

    disegna();

    // App.vai('guida', { guida: 'carico' }): apre il video di quella guida (o porta in vista la scheda)
    var richiesta = par.guida && Guide.trova(par.guida);
    if (richiesta) {
      Guide.controlla(richiesta).then(function (st) {
        if (!document.body.contains(cont)) return;
        if (st.video) { Guide.apriVideo(richiesta.id); return; }
        var art = griglia.querySelector('[data-guida="' + richiesta.id + '"]');
        if (art) { art.scrollIntoView({ block: 'center' }); art.classList.add('guide-evidenziata'); }
      });
    }
  };
})(this);
