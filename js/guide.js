/*
 * Guide scritte e videoguide (NefroCenter Pharmacy, versione 3.0).
 *
 * window.Guide
 *   GRUPPI   [{ id, testo }]  argomenti della pagina Guida, nell'ordine in cui si mostrano
 *   ELENCO   [{ id, ico, titolo, descrizione, gruppo, permesso, perChi, giro, pagina, dove?,
 *              aChi, quando, passi, dopo, errori, approfondimenti, video, copertina, sottotitoli }]
 *            permesso: null (per tutti) | 'carico' | ['carico', 'consumo', …] (ne basta uno)
 *            giro:     id del giro di js/tour.js, o elenco di id in ordine di preferenza (si usa il primo permesso
 *                      all'utente; nella guida scritta c'è un pulsante per ognuno), o null
 *            pagina:   id della pagina del menu (o elenco) a cui porta "Apri la pagina"; dove?: testo in più sul dove
 *            passi:    i passi numerati. Sono anche le didascalie del video: strumenti/genera-videoguide.js gira uno
 *                      scenario con un passo per ognuno e scrive i tempi nei sottotitoli guide/<id>.vtt
 *            aChi, quando: testo; dopo: testo o elenco di testi; errori: [[problema, soluzione]];
 *            approfondimenti: [{ titolo, testo?, punti? }]
 *            Nei testi «…» è il nome di un pulsante, di un campo o di una pagina: nella guida scritta diventa grassetto
 *            (nelle didascalie dei video si possono lasciare le virgolette o toglierle).
 *   serve(g)          true se la guida riguarda le pagine che l'utente collegato può usare
 *   controlla(g)      Promise → { video: bool, aggiornato: bool, passi: [{ inizio, fine, testo }], durata: secondi | null }
 *                     (con memoria). aggiornato = le didascalie del video (.vtt) sono proprio i passi di adesso: un video
 *                     girato per una versione precedente (passi cambiati) resta guardabile, ma la guida scritta passa
 *                     davanti e il video dice che è della versione precedente. Rigenerato il video, l'avviso sparisce.
 *   apriVideo(id)     finestra con il video, i passi a fianco (cliccabili), Guidami e la guida scritta
 *   apriScritta(id)   finestra con la guida scritta completa, Guidami sulla pagina e il collegamento alla pagina
 *
 * Sostituisce la pagina Guida di js/pagine.js (questo file si carica dopo): in alto ricerca e filtri, poi le schede
 * delle guide divise per argomento, sotto le istruzioni scritte della pagina di prima, a sezioni che si aprono.
 * Finché il video di una guida non c'è (404) la scheda porta alla guida scritta. In Node (module.exports) dà solo
 * l'elenco, per lo strumento che genera i video.
 */
(function (root) {
  'use strict';

  var GRUPPI = [
    { id: 'inizio', testo: 'Per cominciare' },
    { id: 'giorno', testo: 'Lavoro di ogni giorno' },
    { id: 'magazzino', testo: 'Magazzino e armadi' },
    { id: 'analisi', testo: 'Analisi e registri' },
    { id: 'amministrazione', testo: 'Archivio e amministrazione' }
  ];

  function guida(d) {
    return {
      id: d.id,
      ico: d.ico,
      titolo: d.titolo,
      descrizione: d.descrizione,
      gruppo: d.gruppo,
      permesso: d.permesso || null,
      perChi: d.perChi || '',
      giro: d.giro || null,
      pagina: d.pagina || null,
      dove: d.dove || '',
      aChi: d.aChi || '',
      quando: d.quando || '',
      passi: d.passi,
      dopo: d.dopo || '',
      errori: d.errori || [],
      approfondimenti: d.approfondimenti || [],
      video: 'guide/' + d.id + '.mp4',
      copertina: 'guide/' + d.id + '.jpg',
      sottotitoli: 'guide/' + d.id + '.vtt'
    };
  }

  // pagine dove si registra con il lettore di codici a barre
  var REGISTRA = ['carico', 'consumo', 'perdita', 'rettifica', 'richieste', 'ddt', 'riceviDdt'];

  var ELENCO = [
    /* ======================= per cominciare ======================= */
    guida({
      id: 'primo-accesso', ico: '👋', gruppo: 'inizio', permesso: null, giro: 'benvenuto', pagina: 'oggi', perChi: 'Tutti',
      titolo: 'Primo accesso e panoramica',
      descrizione: 'Entrare la prima volta, scegliere la password, la verifica con il telefono se è richiesta, il menu, la pagina Oggi e dove trovare aiuto.',
      aChi: 'A tutti: responsabili dei magazzini di piano e infermieri, farmacisti della farmacia centrale, amministratori e direzione. Ognuno entra con il suo nome utente, così ogni registrazione porta il nome di chi l’ha fatta.',
      quando: 'Il primo giorno, appena l’amministratore ti ha dato il nome utente e la password provvisoria. Poi ogni volta che vuoi ripassare dove sono le cose.',
      passi: [
        'Apri Edge o Chrome all’indirizzo del server che ti ha dato l’amministratore (per esempio http://server-farmacia:8080/) e salvalo nei preferiti.',
        'Nella schermata «Accedi» scrivi «Nome utente» e «Password» (quella provvisoria) e premi «Entra».',
        'Compare «Scegli la tua password»: scrivi la «Password provvisoria», poi la «Nuova password» di almeno 8 caratteri in tutti e due i campi e premi «Salva e continua».',
        'Se per il tuo ruolo è richiesta la verifica in due passaggi compare «Attiva la verifica in due passaggi»: prepara il telefono, inquadra il codice QR e salva i codici di recupero.',
        'Il programma ti propone un giro guidato di un minuto: premi «Sì, fammi vedere», oppure «Non ora» per farlo un’altra volta.',
        'A sinistra c’è il menu con le sole pagine del tuo ruolo, divise per argomento. La lettera a destra è il tasto rapido, il numero rosso dice quante cose ti aspettano.',
        'La pagina «Oggi» mostra i numeri del giorno (sotto scorta, scaduti, in scadenza, richieste e DDT) e «Cosa fare adesso»: tocca una voce per andare alla pagina giusta.',
        'Premi Ctrl K (oppure /) per la ricerca rapida: scrivi il nome di un articolo o di una pagina e premi Invio.',
        'Il pulsante con le tue iniziali, in alto a destra, apre il tuo menu: «Cambia password», «Sicurezza dell’account», il tema dello schermo ed «Esci».',
        'In ogni pagina «🧭 Guidami» ti mostra sullo schermo cosa fare; nella pagina «Guida» trovi queste guide scritte e i video.'
      ],
      dopo: [
        'Da quel momento entri con il tuo nome utente e la tua password (e il codice del telefono, se hai la verifica in due passaggi).',
        'Quello che registri lo vedono subito gli altri utenti collegati, su tutti i computer.',
        'Dopo 8 ore senza usare il programma compare «Sessione scaduta»: rientra con la password, quello che stavi scrivendo resta nella pagina.'
      ],
      errori: [
        ['“Nome utente o password non giusti”', 'Controlla le maiuscole e il tasto Bloc Maiusc. La password provvisoria va scritta esattamente come te l’ha data l’amministratore.'],
        ['“Troppi tentativi sbagliati… riprova tra 15 minuti”', 'Dopo 5 password sbagliate quel computer resta bloccato per 15 minuti. Aspetta, oppure chiedi all’amministratore una nuova password provvisoria.'],
        ['“Questo utente è disattivato”', 'L’amministratore ha tolto la spunta «Utente attivo»: chiedigli di riattivarti.'],
        ['La pagina non si apre o resta bianca', 'Controlla l’indirizzo (http:// oppure https://, il nome del server e la porta). Se compare «Server non raggiungibile» il server è spento o la rete non c’è: avvisa chi gestisce il server.'],
        ['Nel menu manca una pagina che ti serve', 'Il menu mostra solo le pagine del tuo ruolo e dei tuoi magazzini. Chiedi all’amministratore di controllare ruolo e magazzini del tuo utente.']
      ]
    }),
    guida({
      id: 'password', ico: '🔑', gruppo: 'inizio', permesso: null, giro: null, pagina: null, perChi: 'Tutti',
      dove: 'Il tuo menu: il pulsante con le tue iniziali, in alto a destra.',
      titolo: 'Accesso e cambio password',
      descrizione: 'La password provvisoria, il cambio password, l’uscita a fine turno e cosa fare se resti bloccato.',
      aChi: 'A tutti gli utenti.',
      quando: 'Al primo accesso, quando vuoi cambiare password, a fine turno su un computer condiviso e quando non riesci a entrare.',
      passi: [
        'Entra con il nome utente e la password provvisoria che ti ha dato l’amministratore e premi «Entra».',
        'Al primo accesso scegli una password tua, di almeno 8 caratteri, diversa da quella provvisoria: scrivila in «Nuova password» e in «Ripeti la nuova password», poi «Salva e continua».',
        'Per cambiarla in seguito tocca il pulsante con le tue iniziali in alto a destra e scegli «🔑 Cambia password».',
        'Scrivi la password attuale e quella nuova due volte e conferma: le altre sessioni aperte con il tuo utente si chiudono.',
        'Su un computer che usano anche altri esci sempre a fine turno: tocca le tue iniziali e poi «🚪 Esci».',
        'Se sbagli la password 5 volte, l’accesso da quel computer si blocca per 15 minuti: aspetta, oppure chiedi all’amministratore una nuova password provvisoria.'
      ],
      dopo: 'La password nuova vale subito su tutti i computer. L’amministratore non la vede mai: se la dimentichi te ne dà una provvisoria nuova, da cambiare al primo accesso.',
      errori: [
        ['“La password attuale non è giusta”', 'Riscrivila con calma. Dopo 5 errori la sessione si chiude per sicurezza: rientra con nome utente e password.'],
        ['“La nuova password deve essere diversa da quella attuale”', 'Scegline una mai usata, di almeno 8 caratteri. Una frase corta è facile da ricordare e difficile da indovinare.'],
        ['Password dimenticata', 'Chiedi all’amministratore «Nuova password» dalla pagina Utenti. Se l’amministratore stesso l’ha dimenticata c’è l’accesso d’emergenza sul server (vedi LEGGIMI: --reimposta-password).'],
        ['Hai la verifica in due passaggi e hai perso il telefono', 'Entra con un codice di recupero («Usa un codice di recupero»). Se non hai nemmeno quelli, l’amministratore azzera la verifica dalla pagina Sicurezza.']
      ]
    }),
    guida({
      id: 'sicurezza-2fa', ico: '🔐', gruppo: 'inizio', permesso: null, giro: ['account', 'sicurezza'], pagina: 'sicurezza', perChi: 'Tutti',
      dove: 'Il tuo menu (iniziali in alto a destra) → «Sicurezza dell’account». L’amministratore ha anche la pagina «Sicurezza».',
      titolo: 'Verifica in due passaggi (2FA)',
      descrizione: 'Il codice di 6 cifre del telefono oltre alla password: attivarla, le app da usare, i codici di recupero, il telefono perso o cambiato.',
      aChi: 'A tutti gli utenti, per proteggere il proprio accesso. È obbligatoria per chi l’amministratore ha indicato nel criterio (per esempio amministratori e farmacisti). All’amministratore serve anche per decidere chi deve usarla e per azzerarla a chi perde il telefono.',
      quando: 'Quando decidi di proteggere il tuo utente, quando il programma ti chiede di attivarla, quando cambi telefono, quando restano pochi codici di recupero o se perdi il telefono.',
      passi: [
        'Installa sul telefono un’app di autenticazione gratuita: Google Authenticator, Microsoft Authenticator o FreeOTP (su Android va bene anche Aegis).',
        'Nel programma tocca le tue iniziali in alto a destra e scegli «🔐 Sicurezza dell’account», poi «Attiva la verifica in due passaggi».',
        'Passo «Prepara il telefono»: quando hai l’app premi «Ho l’app: continua».',
        'Passo «Collega l’app»: nell’app tocca + e «Scansiona un codice QR», poi inquadra il codice QR sullo schermo.',
        'Nell’app compare il nome del programma con un codice di 6 cifre: scrivilo in «Codice di 6 cifre mostrato dall’app». Con 6 cifre parte da solo (oppure premi «Verifica e attiva»).',
        'Passo «Salva i codici»: compaiono 10 codici di recupero. Premi «⬇ Scarica (.txt)» o «🖨 Stampa» e conservali lontano dal computer.',
        'Spunta «Li ho salvati in un posto sicuro» e premi «Continua»: la verifica è attiva.',
        'Dal prossimo accesso, dopo la password, scrivi in «Codice dell’app» le 6 cifre che l’app mostra in quel momento e premi «Verifica ed entra».',
        'Sul tuo computer di sempre puoi spuntare «Ricorda questo computer per 30 giorni»: lì per un mese il codice non viene chiesto.',
        'Amministratore: nella pagina «Sicurezza» scegli chi deve usarla (facoltativa, amministratori, amministratori e farmacisti, tutti) e premi «Salva il criterio».'
      ],
      dopo: [
        'Per entrare servono password e telefono: chi scopre la tua password, senza il telefono non entra.',
        'Se il criterio la chiede al tuo ruolo, nella finestra «Sicurezza dell’account» non c’è «Disattiva».',
        'Chi deve averla e non l’ha attivata, al prossimo accesso (o subito, se è collegato) viene guidato passo per passo: finché non la attiva non può lavorare.',
        'Ogni attivazione, accesso con codice di recupero e azzeramento finisce nel registro attività.'
      ],
      errori: [
        ['“Il codice non è giusto”', 'Controlla di leggere nell’app il codice di questo programma (non quello della posta o della banca) e scrivilo prima che cambi. L’ora del telefono deve essere impostata in automatico.'],
        ['“Questo codice è già stato usato”', 'Ogni codice vale una volta sola: aspetta che l’app mostri quello nuovo (cambia ogni 30 secondi).'],
        ['Avviso “Attenzione all’ora” durante l’attivazione', 'L’ora del server e quella del computer sono diverse di oltre 90 secondi: i codici non tornano. Avvisa chi gestisce il server, che deve tenere l’ora sincronizzata (NTP).'],
        ['Non riesci a inquadrare il codice QR', 'Apri «Non riesci a inquadrarlo? Scrivi la chiave a mano»: nell’app scegli «Inserisci una chiave» e copia la chiave, tipo «basata sul tempo». Se sei già sul telefono usa «Sei sul telefono? Aggiungi all’app».'],
        ['“La chiave mostrata non vale più”', 'È passata più di un’ora o il server è stato riavviato: ricomincia, il programma mostra un codice QR nuovo.'],
        ['“Troppi codici sbagliati: per sicurezza quella chiave non vale più”', 'Dopo 10 codici sbagliati il codice QR mostrato non vale più. Togli dall’app il collegamento appena aggiunto e ricomincia: compare un codice QR nuovo.'],
        ['“Questa chiave è stata chiesta da un’altra finestra o da un altro computer”', 'Hai aperto «Cambia telefono» (o l’attivazione) anche in un’altra scheda: ricomincia da questa finestra, il programma mostra un codice QR nuovo.'],
        ['«Cambia telefono» chiede la password', 'È una protezione: chi trova il programma aperto non può collegare il suo telefono al tuo utente. Scrivi la password con cui entri; dopo 5 password sbagliate la sessione si chiude e bisogna rientrare.'],
        ['Hai perso il telefono', 'All’accesso premi «Usa un codice di recupero» e scrivi uno dei 10 codici salvati (ognuno vale una volta). Poi, dentro, «Cambia telefono» (ti chiede la password) per collegare quello nuovo.'],
        ['Hai perso telefono e codici di recupero', 'Chiedi all’amministratore di premere «Azzera» accanto al tuo nome nella pagina Sicurezza: entri con la sola password e, se il criterio la chiede, la riattivi subito.'],
        ['“La chiave del server è cambiata”', 'La cartella dati è stata rimessa senza il file chiave-2fa.key. L’amministratore azzera la verifica dell’utente, che poi la riattiva; nel frattempo valgono i codici di recupero.']
      ],
      approfondimenti: [
        { titolo: 'Le app da usare', punti: [
          '«Google Authenticator» (Android e iPhone): la più diffusa; può trasferire i codici su un telefono nuovo.',
          '«Microsoft Authenticator» (Android e iPhone): va bene anche se la usi già per la posta della clinica.',
          '«FreeOTP» (Android e iPhone): libera e senza account.',
          'Aegis (solo Android): libera, con la copia di sicurezza dei codici.',
          'Ne usi già una per la banca o la posta? Va bene quella: un’app tiene molti codici insieme, ognuno con il suo nome.'
        ] },
        { titolo: 'I codici di recupero', punti: [
          'Sono 10, si vedono una volta sola (al momento dell’attivazione) e ognuno vale una volta.',
          'Servono quando il telefono non c’è: all’accesso premi «Usa un codice di recupero» e scrivilo al posto delle 6 cifre.',
          'Tienili stampati in un cassetto chiuso o in un gestore di password; non mandarli per e-mail e non lasciarli accanto al computer.',
          'Quando ne restano pochi, in «Sicurezza dell’account» premi «Nuovi codici» (serve la password): quelli vecchi smettono di valere.'
        ] },
        { titolo: 'Se cambi o perdi il telefono', punti: [
          'Telefono nuovo, quello vecchio in mano: «Sicurezza dell’account» → «Cambia telefono» (ti chiede la password) e inquadra il codice QR nuovo con l’app del telefono nuovo.',
          'Telefono perso o rotto: entra con un codice di recupero, poi «Cambia telefono» (ti chiede la password). Se qualcuno può usare il tuo telefono, cambia anche la password.',
          'Senza telefono e senza codici: l’amministratore usa «Azzera» nella pagina Sicurezza. L’accesso d’emergenza dal server (--reimposta-password) azzera anche la verifica.',
          '«Dimentica i computer» toglie il «Ricorda questo computer» da tutti i computer: utile se ne hai usato uno che non è più tuo.'
        ] }
      ]
    }),
    guida({
      id: 'personalizza', ico: '🎨', gruppo: 'inizio', permesso: null, giro: 'configura', pagina: 'configura', perChi: 'Tutti · Amministratore',
      dove: 'Tema: il tuo menu (iniziali in alto a destra) → «Tema dello schermo». Marchio e nome: «Configura» → «Marchio e nome del programma».',
      titolo: 'Marchio, nome del programma, colore e tema',
      descrizione: 'Scegliere il tema chiaro o scuro per te; per l’amministratore: nome del programma, logo, colore d’accento e tema predefinito.',
      aChi: 'Il tema dello schermo lo sceglie ognuno per sé. Nome del programma, struttura, logo, colore d’accento e tema predefinito li cambia l’amministratore, per tutti.',
      quando: 'Quando lo schermo è troppo chiaro o troppo scuro per l’ambiente (per esempio il turno di notte), o quando la struttura cambia nome, logo o colori.',
      passi: [
        'Per il tuo tema tocca le tue iniziali in alto a destra: in «Tema dello schermo» scegli «☀️ Chiaro», «🌙 Scuro» o «🖥️ Automatico» (segue le impostazioni del computer).',
        'La scelta vale subito, in tutte le schede di quel browser, e il programma la ricorda su quel computer.',
        'Amministratore: apri «Configura» (tasto F) e trova la scheda «Marchio e nome del programma».',
        'Scrivi «Nome del programma», «Sigla (nei menu stretti e nelle stampe)», «Nome della struttura» e «Sottotitolo».',
        'In «Logo» scegli «Marchio della struttura», «Nessun logo» oppure «Carica un’immagine…» (PNG, JPEG, WebP o SVG sotto i 400 KB) e poi «Immagine caricata».',
        'Per un altro colore d’accento togli la spunta «Rosso del marchio» e scegli il colore; in «Tema predefinito» scegli il tema di chi non ne ha scelto uno.',
        'Guarda «Anteprima del menu» a destra: cambia mentre scrivi. Poi premi «Salva».'
      ],
      dopo: [
        'Nome, logo e colore compaiono subito nel menu, nella schermata di accesso, nel titolo della finestra e nelle stampe, per tutti gli utenti.',
        'Il tema predefinito vale per chi non ha ancora scelto il suo; chi l’ha scelto tiene il suo.',
        'Il nome del file del programma sul server resta GestionaleFarmacia.exe: cambia solo il nome che si vede.'
      ],
      errori: [
        ['“Immagine troppo grande: usa un file sotto i 400 KB”', 'Riduci l’immagine (per esempio a 400 × 400 pixel) o salvala in PNG o WebP, poi caricala di nuovo.'],
        ['“Scrivi il nome del programma”', 'Il nome non può restare vuoto: scrivi quello che deve comparire nel menu.'],
        ['Il logo non si vede e compare un simbolo neutro', 'L’immagine non si carica: scegli «Marchio della struttura» o carica di nuovo il file.'],
        ['Il tema non cambia su un altro computer', 'Il tema scelto dal tuo menu vale per il browser in cui l’hai scelto: sceglilo anche sull’altro computer.'],
        ['Le scritte colorate si leggono male', 'Con un colore d’accento troppo chiaro il contrasto è basso: rimetti la spunta «Rosso del marchio» o scegli un colore più scuro.']
      ]
    }),

    /* ======================= lavoro di ogni giorno ======================= */
    guida({
      id: 'carico', ico: '📥', gruppo: 'giorno', permesso: 'carico', giro: 'carico', pagina: 'carico', perChi: 'Farmacia centrale',
      titolo: 'Carico della merce',
      descrizione: 'Registrare la merce arrivata dal fornitore nella farmacia centrale, con lotto, scadenza e documento di trasporto.',
      aChi: 'Ai farmacisti della farmacia centrale e all’amministratore.',
      quando: 'Ogni volta che arriva merce da un fornitore esterno. La merce che arriva da un altro magazzino della struttura invece entra con la ricezione del DDT, non con il carico.',
      passi: [
        'Apri «Carico» dal menu (tasto C). In alto ci sono «Data» e «Reparto che riceve»: di solito la farmacia centrale.',
        'Scrivi il «Fornitore» e il numero in «Documento (DDT / fattura n.)».',
        'Nella riga scrivi le prime lettere dell’articolo e sceglilo dall’elenco: sotto compare la giacenza attuale.',
        'Scrivi la quantità arrivata (in unità: compresse, fiale, pezzi), poi lotto e scadenza come sono stampati sulla confezione.',
        'Con il lettore di codici a barre la riga si compila da sola, con lotto e scadenza del Data Matrix. Il prezzo arriva dall’anagrafica.',
        'Con «+ Aggiungi riga» (o Invio) passi all’articolo successivo; la ✕ toglie una riga.',
        'Controlla le righe e premi «Registra carico»: la giacenza sale subito, per tutti.',
        'Il carico compare tra gli ultimi carichi. Se hai sbagliato premi «Annulla» sulla riga e scrivi il motivo.'
      ],
      dopo: 'La merce è disponibile nella farmacia centrale: si può mandare ai magazzini di piano con le richieste e i DDT. Il carico entra nella Nota consumi del mese (colonna Carichi) e, se hai scritto il prezzo, aggiorna il prezzo dell’articolo.',
      errori: [
        ['L’articolo non c’è nell’elenco', 'Premi «Nuovo articolo» (serve il permesso sugli articoli) e crealo senza perdere le righe già scritte.'],
        ['Hai sbagliato quantità o lotto dopo aver registrato', 'In fondo alla pagina (o in Movimenti) premi «Annulla» sul carico, scrivi il motivo e registralo di nuovo giusto.'],
        ['Il lettore scrive il codice in un campo invece di compilare la riga', 'Leggi con calma una confezione alla volta. Se il codice non è riconosciuto compare «Codice non riconosciuto»: associalo all’articolo giusto.'],
        ['Scadenza senza giorno', 'La scadenza è mese e anno, come sulla confezione: va bene così.']
      ]
    }),
    guida({
      id: 'lettore', ico: '📷', gruppo: 'giorno', permesso: REGISTRA, giro: 'scanner', pagina: null, perChi: 'Chi registra',
      dove: 'La barra di lettura in cima alle pagine Carico, Consumi del giorno, Trasferimenti, Perdite e scaduti, Inventario, nuova richiesta, DDT e ricezione.',
      titolo: 'Lettore di codici a barre',
      descrizione: 'Caricare, scaricare, chiedere e ricevere merce leggendo le confezioni con il lettore USB o Bluetooth, o con la fotocamera.',
      aChi: 'A chi registra movimenti: farmacia centrale e magazzini di piano.',
      quando: 'Ogni volta che hai le confezioni in mano: carico, consumi, perdite, inventario, richieste, preparazione e ricezione dei DDT.',
      passi: [
        'In cima alle pagine dove registri c’è la barra di lettura: Carico, Consumi, Trasferimenti, Perdite, Inventario, nuova richiesta, DDT e ricezione.',
        'Scegli quanto vale ogni lettura: una unità oppure una confezione intera (i pezzi per confezione sono scritti nell’articolo). La scelta si ricorda per ogni pagina.',
        'Leggi la confezione con il lettore: la riga si compila da sola, con lotto e scadenza se il codice li contiene (Data Matrix).',
        'Leggi un’altra confezione dello stesso articolo: la quantità aumenta.',
        'Il lettore funziona anche con il cursore in un altro campo: il codice letto non finisce nel campo.',
        'Codice mai visto? Compare «Codice non riconosciuto»: scegli l’articolo giusto o creane uno nuovo. Da quel momento il codice è riconosciuto da tutti.',
        'Senza lettore scrivi il codice nel campo di lettura e premi Invio.',
        'Sul telefono o sul tablet premi «📷 Fotocamera» e inquadra il codice; con «Lettura continua» leggi molte confezioni di seguito.'
      ],
      dopo: 'Le righe lette sono normali righe del modulo: controllale e registra con il pulsante della pagina. In Oggi, Giacenze e Scadenze una lettura apre la scheda dell’articolo; in Armadi mostra dove si trova; in DDT e consegne il codice o il QR stampato sul DDT apre il DDT.',
      errori: [
        ['Il lettore non fa niente', 'Controlla che sia collegato e che “scriva come una tastiera” (prova a leggere dentro il Blocco note). Il programma riconosce le letture veloci che finiscono con Invio.'],
        ['Il pulsante «Fotocamera» non c’è', 'La fotocamera funziona solo con Chrome o Edge e con l’indirizzo in https://: chiedi a chi gestisce il server di attivare HTTPS (vedi LEGGIMI).'],
        ['La quantità è 10 volte quella giusta', 'Stai leggendo «per confezione» con i pezzi per confezione dell’articolo: scegli «unità» nella barra, o correggi i pezzi per confezione nell’articolo.'],
        ['Il codice risulta di un altro articolo', 'Un codice appartiene a un solo articolo. Chi gestisce gli articoli lo toglie da quello sbagliato (pagina Articoli) e lo associa a quello giusto.']
      ]
    }),
    guida({
      id: 'consumi', ico: '💊', gruppo: 'giorno', permesso: 'consumo', giro: 'consumi', pagina: 'consumi', perChi: 'Magazzini di piano',
      titolo: 'Consumi del giorno',
      descrizione: 'Il foglio dei consumi di un magazzino: scrivi le quantità usate nella giornata e registra.',
      aChi: 'Ai responsabili dei magazzini di piano (per i loro magazzini) e alla farmacia centrale.',
      quando: 'Ogni giorno, o a fine turno, per scaricare quello che è stato usato per i pazienti.',
      passi: [
        'Apri «Consumi del giorno» (tasto S). Scegli «Data» e «Reparto»: vedi solo i magazzini in cui puoi registrare.',
        'Per trovare prima gli articoli scegli «Categoria» (farmaci o presidi) o scrivi parte del nome in «Cerca».',
        'Vedi gli articoli presenti nel magazzino; se quello che cerchi non c’è spunta «Mostra anche gli articoli senza giacenza».',
        'Nell’ultima colonna scrivi le quantità usate, in unità. Invio passa alla riga sotto; le righe compilate diventano verdi.',
        'Accanto vedi la giacenza del magazzino e quanto è già registrato in quel giorno.',
        'Premi «Registra consumi»: si registrano tutte le righe compilate. Se la giacenza non basta, il programma te lo chiede prima.',
        'Sotto ci sono i consumi già registrati nel giorno. Hai sbagliato? Premi «Annulla» sul tuo consumo e scrivi il motivo.'
      ],
      dopo: 'La giacenza del magazzino scende subito. I consumi finiscono nella Nota consumi del mese (giorno per giorno), nelle previsioni del fabbisogno e in «Proponi le quantità» delle richieste.',
      errori: [
        ['Il magazzino che cerchi non è nell’elenco', 'Il tuo utente non è assegnato a quel magazzino: chiedi all’amministratore di aggiungerlo in Utenti.'],
        ['La giacenza non basta', 'Forse la merce non è ancora stata ricevuta: controlla «DDT e consegne» → «Da ricevere» e registra la ricezione prima dei consumi.'],
        ['Hai registrato due volte', 'Annulla uno dei due consumi (pulsante «Annulla», con il motivo). Dalla Nota consumi mensile puoi anche correggere il numero del giorno.'],
        ['Non vedi «Annulla» su un consumo', 'Chi lavora in un magazzino di piano annulla solo i consumi registrati da lui; gli altri li annulla la farmacia.']
      ]
    }),
    guida({
      id: 'richieste', ico: '📝', gruppo: 'giorno', permesso: ['richieste', 'evadiRichieste'], giro: ['richieste-evadi', 'richieste'], pagina: 'richieste', perChi: 'Magazzini e farmacia',
      titolo: 'Richieste alla farmacia centrale',
      descrizione: 'Il magazzino di piano chiede la merce; la farmacia centrale la prende in carico, approva le quantità e prepara il DDT.',
      aChi: 'Ai responsabili dei magazzini di piano, che chiedono, e ai farmacisti della farmacia centrale, che evadono le richieste.',
      quando: 'Quando nel magazzino di piano un articolo è al punto di riordino o serve qualcosa per un paziente. La farmacia le evade appena arrivano (il numero rosso nel menu dice quante sono).',
      passi: [
        'Apri «Richieste» (tasto Q) e premi «+ Nuova richiesta». «Magazzino che chiede» è il tuo, «Chiedi a» è già la farmacia centrale.',
        'Spunta «Urgente» solo se serve subito: la farmacia la vede in cima, in rosso.',
        'Premi «✨ Proponi le quantità»: per gli articoli dell’assortimento arrivati al punto di riordino il programma propone quanto serve per tornare alla scorta massima.',
        'Aggiungi o correggi le righe: articolo e quantità (anche leggendo le confezioni con il lettore). Sotto la riga vedi giacenza, scorta e merce libera in farmacia.',
        'Scrivi se serve le «Note per la farmacia (facoltative)», poi premi «📨 Invia la richiesta» (oppure «Salva come bozza» per finirla dopo).',
        'Farmacia: apri la scheda «Da evadere» e tocca la richiesta; premi «✋ Prendi in carico» così il magazzino sa che te ne occupi.',
        'Controlla la colonna «Approvata»: puoi approvare di meno, o di più per arrivare alla confezione intera. «Libera» dice quanto hai senza la merce già in altri DDT.',
        'Premi «📦 Prepara DDT»: il programma prepara il documento di trasporto con quello che resta da spedire, scegliendo i lotti che scadono prima.',
        'Se non si può evadere premi «Rifiuta» e scrivi il motivo; dopo un DDT parziale «Chiudi con residuo» chiude la richiesta senza spedire il resto.'
      ],
      dopo: [
        'La richiesta inviata è in «In attesa» per il magazzino e in «Da evadere» per la farmacia, che riceve subito un avviso.',
        'Dopo «Prepara DDT» il DDT è in «DDT e consegne» → «Da preparare»: lì si sceglie chi porta la merce e si spedisce (guida «DDT e consegne»).',
        'Quando tutta la quantità approvata è partita la richiesta diventa «evasa» e va in «Archivio». La cronologia conserva chi ha chiesto, chi ha preso in carico, chi ha preparato, chi ha portato e chi ha ricevuto.'
      ],
      errori: [
        ['“Per … non è ancora impostato l’assortimento”', '«Proponi le quantità» lavora sull’assortimento del magazzino (scorte minima, di riordino e massima): chiedi alla farmacia di impostarlo in «Magazzini e assortimento», o scrivi le righe a mano.'],
        ['“Niente da chiedere”', 'Tutti gli articoli dell’assortimento sono sopra il punto di riordino: aggiungi a mano solo quello che serve davvero.'],
        ['Non riesci più a modificare la richiesta', 'Quando la farmacia l’ha presa in carico non si cambia più: se serve altro fai una nuova richiesta, oppure chiama la farmacia.'],
        ['“Merce non sufficiente” quando prepari il DDT', 'In farmacia non c’è abbastanza merce libera: il DDT parte con quello che c’è, il resto lo spedisci con un altro DDT dopo il prossimo carico, oppure chiudi con residuo.'],
        ['“Non puoi approvarne di meno”', 'Una parte è già in un DDT o già partita: puoi approvare al massimo fino a quella quantità in giù, non meno.']
      ]
    }),
    guida({
      id: 'ddt-consegne', ico: '🚚', gruppo: 'giorno', permesso: 'ddt', giro: 'consegne', pagina: ['consegne', 'trasferimenti'], perChi: 'Farmacia e magazzini',
      titolo: 'DDT e consegne',
      descrizione: 'Il documento di trasporto interno: controllare le righe, stamparlo con codice a barre e QR, scegliere chi lo porta e spedirlo.',
      aChi: 'Ai farmacisti della farmacia centrale, che spediscono la merce ai magazzini di piano, e ai responsabili di magazzino quando rendono merce alla farmacia.',
      quando: 'Dopo «Prepara DDT» di una richiesta, o dopo «Prepara il DDT» della pagina Trasferimenti, quando la merce è pronta per partire.',
      passi: [
        'Apri «DDT e consegne» (tasto D). Le schede: «Da preparare» (pronti, non partiti), «In viaggio», «Da ricevere» e «Archivio».',
        'Tocca un DDT in «Da preparare». In alto: numero (per esempio DDT-2026-0007), da quale magazzino a quale, causale, colli e richiesta collegata.',
        'Finché non parte puoi premere «✏️ Modifica righe» per cambiare righe, lotti, causale e colli, poi «Salva il DDT». Le giacenze non sono ancora cambiate.',
        'Premi «🖨️ Stampa»: esce il DDT su un foglio A4 con codice a barre e QR del numero, articoli con lotto e scadenza e gli spazi per le firme. Mettilo con la merce.',
        'Premi «🚚 Spedisci». In «Trasportatore» scegli il collega che porta la merce, oppure «Un’altra persona (scrivi il nome)…» e scrivi nome e cognome.',
        'Controlla i «Colli» e premi «🚚 Spedisci adesso».',
        'Il DDT passa in «In viaggio»: la merce esce dal magazzino di partenza e il magazzino che la riceve vede l’avviso e il numero nel menu.',
        'Se il DDT non deve partire premi «Annulla DDT» e scrivi il motivo; se è già in viaggio «Annulla (la merce rientra)» la riporta nel magazzino di partenza.'
      ],
      dopo: [
        'Mentre è in viaggio la merce non è di nessuno dei due magazzini: in Giacenze compare nella colonna «In viaggio».',
        'Chi riceve registra la ricezione (guida «Ricezione di un DDT»); a quel punto la merce entra nel suo magazzino e il DDT va in «Archivio».',
        'Ogni DDT conserva chi l’ha preparato, chi l’ha portato, chi l’ha ricevuto e quando. I suoi movimenti non si annullano dalla pagina Movimenti: si annulla il DDT.'
      ],
      errori: [
        ['“Indica chi trasporta la merce”', 'Scegli un collega dall’elenco «Trasportatore», oppure scegli «Un’altra persona (scrivi il nome)…» e scrivi nome e cognome.'],
        ['“Nel frattempo la giacenza … è cambiata e non basta più”', 'Qualcuno ha scaricato la stessa merce: apri «✏️ Modifica righe», correggi le quantità o i lotti e spedisci di nuovo.'],
        ['“Il magazzino di arrivo … non è più attivo”', 'Il magazzino è stato disattivato: annulla il DDT e preparane uno per il magazzino giusto.'],
        ['“Il DDT … è già stato ricevuto: non si annulla”', 'Per restituire merce già ricevuta prepara un DDT di reso dalla pagina «Trasferimenti».'],
        ['Il QR stampato non si legge', 'Stampa di nuovo con una stampante laser o a qualità più alta; in alternativa scrivi il numero del DDT nel campo di lettura e premi Invio.']
      ]
    }),
    guida({
      id: 'ricezione', ico: '📬', gruppo: 'giorno', permesso: 'riceviDdt', giro: 'consegne', pagina: 'consegne', perChi: 'Magazzini di piano',
      titolo: 'Ricezione di un DDT',
      descrizione: 'Quando arriva la merce: aprire il DDT (anche leggendo il QR), contare le confezioni, segnare le differenze e confermare.',
      aChi: 'A chi riceve la merce: i responsabili dei magazzini di piano e, per i resi, la farmacia centrale.',
      quando: 'Appena la merce arriva al piano, con il DDT stampato in mano. Finché non registri la ricezione la merce risulta “in viaggio” e non si può consumare dal tuo magazzino.',
      passi: [
        'Apri «DDT e consegne» (tasto D) e la scheda «Da ricevere», oppure leggi con il lettore il codice a barre o il QR stampato sul DDT: si apre da solo.',
        'Controlla mittente, numero e trasportatore, poi premi «📥 Registra la ricezione».',
        'Per ogni articolo e lotto la colonna «Ricevuta» è già uguale a «Partita»: controlla le confezioni e correggi solo quello che manca.',
        'Puoi anche contare con il lettore: leggi le confezioni una per una, la quantità ricevuta diventa quella letta. «Torna alle quantità del DDT» rimette i numeri di partenza.',
        'Se manca qualcosa scegli in «Se manca qualcosa»: «Rientra in …» (non è mai partita) oppure «Persa in viaggio (rotta, smarrita)». Accanto puoi scrivere una nota.',
        'In «Note sulla consegna (facoltative)» scrivi per esempio “scatola aperta, consegnata alle 15:20”.',
        'Premi «✅ Conferma la ricezione». Se ci sono differenze il programma te lo chiede ancora una volta.'
      ],
      dopo: [
        'La merce ricevuta entra subito nel tuo magazzino e conta nella Nota consumi alla data di ricezione.',
        'La parte che “rientra” torna nel magazzino che l’ha spedita; quella “persa in viaggio” si registra come perdita.',
        'Il DDT va in «Archivio» come «ricevuto» o «ricevuto con differenze» e chi l’ha spedito lo vede subito; la richiesta collegata si aggiorna.'
      ],
      errori: [
        ['Il DDT non è in «Da ricevere»', 'Forse non è ancora stato spedito (è in «Da preparare» della farmacia) oppure è per un altro magazzino. Chiama la farmacia.'],
        ['“Il DDT … non riguarda i tuoi magazzini”', 'Il tuo utente non è assegnato al magazzino di arrivo: chiedi all’amministratore di aggiungerlo, o fai registrare la ricezione a un collega.'],
        ['“Di … mancano N: indica se rientrano … o se sono una perdita in viaggio”', 'Su quella riga hai scritto meno del partito: scegli cosa fare della differenza in «Se manca qualcosa».'],
        ['“Non puoi riceverne di più”', 'Non si riceve più di quanto è partito. Se è arrivato di più, chiama la farmacia: è un errore di preparazione.'],
        ['Hai confermato per sbaglio con una quantità sbagliata', 'La ricezione non si annulla: per la merce in più prepara un DDT di reso dalla pagina «Trasferimenti»; per quella in meno chiedi alla farmacia una nuova spedizione.']
      ]
    }),
    guida({
      id: 'trasferimenti', ico: '🔁', gruppo: 'giorno', permesso: 'ddt', giro: 'trasferimenti', pagina: 'trasferimenti', perChi: 'Farmacia e magazzini',
      titolo: 'Trasferimenti con un DDT',
      descrizione: 'Spostare merce fra due magazzini senza una richiesta, anche un reso alla farmacia: si prepara un DDT.',
      aChi: 'Alla farmacia centrale (rifornimenti senza richiesta) e ai responsabili di magazzino (resi alla farmacia, scambi fra piani).',
      quando: 'Quando la merce deve spostarsi ma non c’è una richiesta: un reso di farmaci non usati, uno scambio fra due piani, un rifornimento urgente deciso dalla farmacia.',
      passi: [
        'Apri «Trasferimenti» (tasto T). In «Da» scegli il magazzino che spedisce, in «A» quello che riceve.',
        'La «Causale» si scrive da sola (Rifornimento reparto, Reso alla farmacia, Trasferimento interno): cambiala se serve. In «Colli» scrivi quante scatole partono.',
        'Nelle righe scegli l’articolo e scrivi la quantità: sotto vedi quanto ce n’è nel magazzino di partenza e quanto è libero.',
        'Il lotto resta «automatico (scade prima)»; scegline uno solo se spedisci proprio quello.',
        'In «Note (chi ritira, per quale paziente o richiesta…)» scrivi quello che serve per ritrovarlo.',
        'Premi «📦 Prepara il DDT»: il DDT nasce “da spedire” e le giacenze non cambiano ancora.',
        'Apri il DDT dagli «ultimi DDT preparati qui» o da «DDT e consegne», stampalo e spediscilo scegliendo chi porta la merce.'
      ],
      dopo: 'Alla spedizione la merce esce dal magazzino di partenza ed è “in viaggio”; quando il magazzino di arrivo registra la ricezione entra nella sua giacenza. Nella Nota consumi il magazzino di partenza vede l’uscita alla data di partenza, quello di arrivo l’entrata alla data di ricezione.',
      errori: [
        ['“Il magazzino di partenza e quello di arrivo sono uguali”', 'Scegli in «A» un magazzino diverso da quello in «Da».'],
        ['“In … non c’è abbastanza merce libera”', 'Una parte è già in altri DDT in preparazione o non c’è: riduci la quantità o spedisci prima gli altri DDT.'],
        ['Non trovi la pagina «Trasferimenti»', 'Serve il permesso sui DDT (farmacia, amministratore o responsabile di magazzino). La direzione non la vede.'],
        ['Hai preparato il DDT sbagliato', 'Finché non è partito aprilo in «DDT e consegne» e premi «Annulla DDT»: le giacenze non sono cambiate.']
      ]
    }),
    guida({
      id: 'perdite', ico: '🗑️', gruppo: 'giorno', permesso: 'perdita', giro: 'perdite', pagina: ['perdite', 'scadenze'], perChi: 'Farmacia e magazzini',
      titolo: 'Perdite, scaduti e resi',
      descrizione: 'Togliere dal magazzino le confezioni scadute, rotte, smarrite o rese al fornitore.',
      aChi: 'Ai responsabili dei magazzini di piano (per i loro magazzini) e alla farmacia centrale.',
      quando: 'Quando trovi lotti scaduti, una confezione si rompe o si perde, o la farmacia rende merce a un fornitore esterno. I resi alla farmacia centrale invece si fanno con un DDT (pagina Trasferimenti).',
      passi: [
        'Le confezioni scadute le trovi in «Scadenze» (tasto Z): in «Mostra» scegli «Solo scaduti».',
        'Accanto al lotto scaduto premi «Togli dal magazzino».',
        'Si apre «Perdite e scaduti» con articolo, lotto, quantità e causale «Scaduto» già compilati.',
        'Per un altro motivo apri «Perdite e scaduti» (tasto P), scegli «Data» e «Reparto», l’articolo, la quantità e il lotto.',
        'Scegli la causale: Scaduto, Rotto o danneggiato, Smarrito, Reso al fornitore, Altro. Se serve aggiungi una nota.',
        'Premi «Registra perdita».'
      ],
      dopo: 'La giacenza scende e il lotto scaduto non compare più in Scadenze. Nella Nota consumi del mese la perdita finisce nella colonna Perdite; le perdite contano anche nelle previsioni del fabbisogno.',
      errori: [
        ['Il lotto scaduto non è nell’elenco dei lotti', 'Forse è in un altro magazzino: controlla «Reparto». Oppure è già stato tolto: guarda in Movimenti.'],
        ['Hai tolto il lotto sbagliato', 'In fondo alla pagina o in Movimenti premi «Annulla» sulla perdita, scrivi il motivo e registra quella giusta.'],
        ['Vuoi rendere merce alla farmacia centrale', 'Non è una perdita: usa «Trasferimenti» con «A» = farmacia centrale (causale Reso alla farmacia).']
      ]
    }),

    /* ======================= magazzino e armadi ======================= */
    guida({
      id: 'struttura', ico: '🏥', gruppo: 'magazzino', permesso: null, giro: 'struttura', pagina: 'struttura', perChi: 'Tutti',
      titolo: 'Struttura: la mappa dei piani',
      descrizione: 'L’edificio piano per piano con i magazzini, i loro avvisi e i DDT in viaggio da un piano all’altro.',
      aChi: 'A tutti: alla farmacia per vedere in un colpo d’occhio dove servono rifornimenti, ai magazzini di piano per sapere cosa sta arrivando, alla direzione per una visione d’insieme.',
      quando: 'All’inizio del turno, o quando vuoi sapere quale piano ha articoli sotto scorta o in scadenza e quali consegne sono in corso.',
      passi: [
        'Apri «Struttura» (tasto K). In alto il riepilogo: magazzini e piani, articoli sotto scorta in tutta la struttura, DDT in viaggio.',
        'Sotto c’è lo spaccato dell’edificio: ogni piano con i suoi magazzini, dal più basso al più alto. La farmacia centrale ha la croce ✚.',
        'Ogni magazzino mostra il nome, gli articoli sotto scorta e in scadenza, quanti armadi e quanti articoli ha.',
        'Tocca un magazzino per aprire i suoi armadi nella pagina «Armadi».',
        'I DDT in viaggio sono punti che vanno dal magazzino che spedisce a quello che riceve, passando dal vano scale. Nell’elenco accanto vedi chi li sta portando.',
        'Premi «Apri» accanto a un DDT in viaggio per vederlo. L’amministratore trova «Gestisci magazzini» per aggiungere o cambiare i magazzini.'
      ],
      dopo: 'La mappa si aggiorna da sola quando qualcuno registra. Se sul tuo computer è impostato “riduci il movimento”, i punti dei DDT restano fermi e lo stato si legge dalle scritte.',
      errori: [
        ['Un magazzino non compare sulla mappa', 'È disattivato o non ha ancora il piano giusto: l’amministratore lo controlla in «Magazzini e assortimento» (campi «Piano» e «Livello»).'],
        ['Due magazzini sono sul piano sbagliato', 'Il «Livello» decide l’altezza del piano sulla mappa (−1 seminterrato, 0 piano terra, 1, 2…): va corretto nei dati del magazzino.'],
        ['Non vedi i responsabili dei magazzini', 'I nomi dei responsabili li vede solo l’amministratore.']
      ]
    }),
    guida({
      id: 'armadi', ico: '🗄️', gruppo: 'magazzino', permesso: null, giro: 'armadi', pagina: 'armadi', perChi: 'Tutti',
      titolo: 'Armadi: dove si trova ogni cosa',
      descrizione: 'Trovare un farmaco negli armadi (anche con il lettore), leggere lo stato delle scatole, disporre gli articoli trascinandoli.',
      aChi: 'A chi lavora nei magazzini: trova subito dove è un farmaco. I responsabili di magazzino e la farmacia sistemano anche gli articoli negli armadi («Disponi»).',
      quando: 'Quando cerchi un farmaco, quando sistemi un armadio nuovo o riorganizzi il magazzino, e per controllare a colpo d’occhio cosa è da riordinare o in scadenza.',
      passi: [
        'Apri «Armadi» (tasto B) e scegli il «Magazzino»: sotto compaiono i suoi armadi, frigorifero, cassettiere, carrelli e cassaforte.',
        'In «Dove si trova?» scrivi il nome di un farmaco, o leggi la confezione con il lettore: si apre l’armadio giusto e la sua scatola lampeggia.',
        'Ogni scatola è un articolo al suo posto (ripiano e posto). Colore e segno dicono lo stato: regolare, ↻ da riordinare, ! sotto la scorta minima, ∅ esaurito, ⏳ lotti in scadenza, ⚠ lotti scaduti.',
        'L’altezza della scatola dice quanta merce c’è rispetto alla scorta massima. Tocca uno stato nella legenda per far risaltare solo quelle scatole.',
        'Tocca una scatola: nel pannello a destra vedi giacenza, scorte, lotti e scadenze, con i pulsanti «💊 Consumi», «🗑️ Perdite», «📝 Nuova richiesta» e «🏷️ Scheda articolo».',
        'Per sistemare gli articoli premi «✋ Disponi» e trascina un articolo dall’elenco in una casella (con il mouse, o con il dito sulla maniglia ⠿).',
        'Trascina una scatola su un’altra casella per spostarla, oppure sull’elenco per toglierla. Da tastiera: «Metti», poi le frecce e Invio.',
        '«✨ Disposizione automatica» sistema da sola gli articoli senza posto, per categoria e nome: nel frigorifero mette solo gli articoli con la spunta «Da frigorifero 2–8 °C», nella cassaforte solo quelli con «Stupefacente (cassaforte)». «Svuota» toglie tutto dall’armadio.',
        'Ogni spostamento si salva subito. Quando hai finito premi «✓ Fine disposizione».'
      ],
      dopo: [
        'Le posizioni le vedono subito tutti, anche nella scheda dell’articolo e nella ricerca «Dove si trova?».',
        'Le spunte «Da frigorifero 2–8 °C» e «Stupefacente (cassaforte)» si mettono nel modulo dell’articolo (pagina «Articoli» → «Modifica», riquadro «Caratteristiche»): la farmacia le mette una volta e valgono in tutti i magazzini.',
        'Se il magazzino non ha un frigorifero o una cassaforte, quegli articoli vanno negli armadi normali come gli altri. Nel pannello della scatola, alla voce «Attenzione», compaiono le caratteristiche dell’articolo (Frigorifero, Stupefacente, Alto rischio, LASA, Urgenze).'
      ],
      errori: [
        ['Il pulsante «Disponi» non c’è', 'Puoi disporre solo negli armadi dei tuoi magazzini (responsabile di magazzino) o con il ruolo di farmacia. La direzione vede soltanto.'],
        ['“Nessun armadio” nel magazzino', 'Gli armadi li crea l’amministratore in «Magazzini e assortimento» → scheda «Armadi» → «+ Nuovo armadio».'],
        ['La casella è occupata', 'In ogni casella c’è un solo articolo: sposta prima quello che c’è, oppure trascina sulla casella e lo scambio avviene in un colpo solo.'],
        ['Un articolo non è nell’elenco da disporre', 'Non è nell’assortimento del magazzino: usa «Metti nell’armadio» per un articolo fuori assortimento, oppure chiedi alla farmacia di aggiungerlo.'],
        ['La disposizione automatica non mette un farmaco nel frigorifero (o nella cassaforte)', 'L’articolo non ha la spunta «Da frigorifero 2–8 °C» (o «Stupefacente (cassaforte)»): chiedi alla farmacia di metterla in «Articoli» → «Modifica». Intanto spostalo a mano con «Disponi».']
      ]
    }),
    guida({
      id: 'giacenze-scadenze', ico: '📦', gruppo: 'magazzino', permesso: null, giro: ['giacenze', 'scadenze'], pagina: ['giacenze', 'scadenze'], perChi: 'Tutti',
      titolo: 'Giacenze e scadenze',
      descrizione: 'Quanto c’è in ogni magazzino e in viaggio, cosa è sotto scorta e quali lotti stanno per scadere.',
      aChi: 'A tutti: chi lavora nei magazzini, la farmacia e la direzione.',
      quando: 'Per sapere quanto c’è di un articolo, per preparare un riordino, per il controllo mensile delle scadenze.',
      passi: [
        '«Giacenze» (tasto G) mostra quanto c’è in ogni magazzino, il totale e il valore della merce.',
        'In «Reparto» scegli «Tutti» (un magazzino per colonna) o un magazzino solo; filtra per «Categoria» o cerca per nome, principio attivo o codice.',
        'La colonna «In viaggio» è la merce partita con un DDT e non ancora ricevuta: non è di nessun magazzino finché non arriva.',
        'Spunta «Solo sotto scorta» per vedere cosa riordinare: conta la scorta minima dell’assortimento di ogni magazzino.',
        'Tocca una riga per aprire la scheda dell’articolo: giacenze per magazzino, lotti, posizione negli armadi e ultimi movimenti.',
        '«Scadenze» (tasto Z) elenca i lotti in giacenza dal primo che scade. In «Mostra» scegli Solo scaduti, entro 30 o 60 giorni, entro il preavviso o tutti.',
        'Le etichette rosse sono lotti scaduti o che scadono entro 30 giorni, le arancioni entro il preavviso. «Togli dal magazzino» registra la perdita di un lotto scaduto.',
        '«Stampa» ed «Excel» stampano o esportano esattamente l’elenco che vedi, con gli stessi filtri.'
      ],
      dopo: 'Le pagine si aggiornano da sole quando altri registrano. Gli articoli sotto scorta compaiono anche in Oggi, in Struttura e negli Armadi.',
      errori: [
        ['Un articolo risulta sotto scorta ma non dovrebbe', 'Le scorte si impostano nell’assortimento di ogni magazzino («Magazzini e assortimento»); per la farmacia centrale vale anche la scorta minima dell’anagrafica.'],
        ['La giacenza non torna con quella sullo scaffale', 'Controlla «In viaggio» e i DDT da ricevere, poi i movimenti dell’articolo. Se la differenza resta, fai l’inventario.'],
        ['Un lotto scaduto è “In viaggio (DDT)”', 'È partito con un DDT non ancora ricevuto: chi lo riceve può segnarlo come perso, oppure toglierlo dopo la ricezione.']
      ]
    }),
    guida({
      id: 'movimenti', ico: '🧾', gruppo: 'magazzino', permesso: null, giro: 'movimenti', pagina: 'movimenti', perChi: 'Tutti',
      titolo: 'Movimenti e annullo',
      descrizione: 'Trovare un movimento registrato e annullarlo con il motivo, senza cancellarlo. I movimenti dei DDT si annullano dal DDT.',
      aChi: 'A tutti per consultare; chi registra annulla i propri consumi e perdite, la farmacia qualsiasi movimento.',
      quando: 'Quando cerchi chi ha registrato qualcosa e quando, o quando un movimento è sbagliato.',
      passi: [
        'Apri «Movimenti» (tasto M): carichi, consumi, trasferimenti, perdite e rettifiche, con l’operatore che li ha registrati.',
        'Scegli il periodo in «Dal» e «Al», poi «Tipo» e «Reparto», oppure cerca per articolo, lotto, fornitore o documento (anche il numero di un DDT).',
        'Un movimento sbagliato non si cancella: premi «Annulla» sulla sua riga.',
        'Scrivi il motivo e conferma.',
        'Il movimento resta nell’elenco, barrato, con chi l’ha annullato e perché, ma non conta più. Poi registra quello giusto.',
        'I movimenti nati da un DDT non hanno «Annulla»: si annulla il DDT da «DDT e consegne».',
        '«Excel» esporta l’elenco che vedi, con tutte le colonne. Togli la spunta «Mostra annullati» per nasconderli.'
      ],
      dopo: 'Giacenze, Nota consumi e previsioni si ricalcolano subito senza il movimento annullato. L’annullo resta nel registro attività.',
      errori: [
        ['Non vedi «Annulla» su un movimento', 'Chi lavora in un magazzino di piano annulla solo i consumi e le perdite registrati da lui; per gli altri chiedi alla farmacia.'],
        ['Il movimento è di un DDT', 'Si annulla il DDT (se non è ancora ricevuto). Dopo la ricezione si fa un DDT di reso dalla pagina Trasferimenti.'],
        ['Non trovi un movimento', 'Allarga il periodo (Dal / Al) e controlla che «Tipo» e «Reparto» siano su tutti.']
      ]
    }),
    guida({
      id: 'inventario', ico: '✅', gruppo: 'magazzino', permesso: 'rettifica', giro: 'inventario', pagina: 'inventario', perChi: 'Farmacia centrale',
      titolo: 'Inventario',
      descrizione: 'Contare il magazzino e registrare le differenze come rettifiche.',
      aChi: 'Alla farmacia centrale e all’amministratore, anche per i magazzini di piano.',
      quando: 'Alla conta periodica (mensile o annuale), o quando una giacenza non torna con lo scaffale.',
      passi: [
        'Apri «Inventario» (tasto I). Scegli «Data dell’inventario», il «Reparto» da contare e, se vuoi, la categoria.',
        'Con «Stampa foglio di conta» hai l’elenco da compilare a mano davanti agli scaffali.',
        'Scrivi le quantità contate: la differenza con la giacenza del programma compare subito accanto.',
        'Le righe lasciate vuote non cambiano. Puoi contare anche con il lettore: ogni lettura aggiunge alla quantità contata.',
        'Premi «Registra differenze» e conferma: ogni differenza diventa una rettifica d’inventario.',
        'Le rettifiche si vedono in Movimenti e nella Nota consumi: quelle in più tra i carichi, quelle in meno tra le perdite.'
      ],
      dopo: 'La giacenza del programma diventa uguale a quella contata. Le rettifiche si possono annullare da Movimenti, come gli altri movimenti.',
      errori: [
        ['“Nel frattempo la giacenza è cambiata”', 'Qualcuno ha registrato mentre contavi: il programma non registra per non sbagliare. Ricarica la pagina e controlla le righe cambiate.'],
        ['Prima di contare ci sono DDT da ricevere', 'Registra prima la ricezione dei DDT arrivati, altrimenti la merce sullo scaffale risulta “in più”.']
      ]
    }),

    /* ======================= analisi e registri ======================= */
    guida({
      id: 'previsioni-ordini', ico: '📈', gruppo: 'analisi', permesso: 'previsioni', giro: 'previsioni', pagina: 'previsioni', perChi: 'Farmacia · Magazzini · Direzione',
      dove: 'Le impostazioni (giorni di consegna, livello di servizio…) sono in «Configura» → «Previsioni e ordini».',
      titolo: 'Previsioni, fabbisogno e proposta d’ordine',
      descrizione: 'Quanto si consumerà nei prossimi giorni, per quanto basta la merce, il punto di riordino e quanto ordinare ai fornitori.',
      aChi: 'Alla farmacia centrale per preparare gli ordini ai fornitori; ai responsabili di magazzino per sapere cosa chiedere alla farmacia; alla direzione per seguire i consumi.',
      quando: 'Prima di ogni ordine ai fornitori (per esempio ogni settimana) e quando vuoi capire se un articolo sta finendo.',
      passi: [
        'Apri «Previsioni e fabbisogno» (tasto E). In «Magazzino» scegli tutta la struttura, la farmacia centrale o un magazzino di piano; poi «Categoria» o «Cerca».',
        'Scegli quanto lontano guardare: 7, 30 o 90 giorni. «Vista» raggruppa il grafico per giorno, settimana o mese.',
        'Gli indicatori dicono il consumo previsto e il suo valore, gli articoli al punto di riordino, quelli che finiranno prima della consegna e quanto c’è da ordinare.',
        'Nel grafico la linea piena sono i consumi veri, quella tratteggiata la previsione; la fascia chiara è dove cadrà il consumo 9 volte su 10.',
        'Nella scheda «Fabbisogno per articolo» trovi per ogni articolo consumo medio, tendenza, giorni di copertura, data di esaurimento, scorta di sicurezza e punto di riordino.',
        'Tocca il nome di un articolo: si apre il dettaglio con il suo grafico, i consumi per giorno della settimana e il confronto dei metodi di previsione.',
        '«Classi ABC-XYZ» mostra quali articoli pesano di più sulla spesa e quali hanno consumi regolari; tocca una casella della matrice per filtrare la tabella.',
        'Farmacia: apri «Proposta d’ordine». È divisa per fornitore; nella colonna «Confezioni» correggi quello che vuoi ordinare.',
        'Premi «Excel» (un foglio per fornitore, da mandare così com’è) o «Stampa». «Ripristina la proposta» toglie le tue correzioni.'
      ],
      dopo: [
        'Il programma non manda ordini da solo: la proposta è un aiuto. Quando la merce arriva si registra con il Carico.',
        'Le confezioni corrette restano ricordate finché non esci dal programma.',
        'Nei magazzini di piano le colonne dicono «Da chiedere alla farmacia»: si usa poi «Proponi le quantità» nella nuova richiesta.'
      ],
      errori: [
        ['Un articolo ha “affidabilità bassa”', 'Ha pochi giorni di storia o consumi molto irregolari: la previsione è solo indicativa, controlla a occhio.'],
        ['La proposta chiede di passare a tutta la struttura', 'La proposta d’ordine si calcola sempre su tutta la struttura (consumi di tutti i magazzini, giacenze ovunque e merce in viaggio): premi «Passa a tutta la struttura».'],
        ['Un articolo che si ordina non compare', 'Senza consumi negli ultimi mesi non c’è niente da prevedere: spunta «Anche senza consumi» per vederlo comunque.'],
        ['La proposta conta merce già ordinata e non arrivata', 'Il programma non conosce gli ordini già mandati ai fornitori: correggi a mano le confezioni di quegli articoli.'],
        ['Un articolo è sotto «Senza fornitore abituale»', 'Scrivi il «Fornitore abituale» nel modulo dell’articolo («Articoli» → «Modifica»). Se il campo è vuoto il fornitore si prende dall’ultimo carico dell’articolo: quando registri un carico scrivi sempre il «Fornitore».'],
        ['I giorni di consegna non sono giusti', 'Per un solo articolo scrivili in «Giorni di consegna» nel modulo dell’articolo («Articoli» → «Modifica»). Per tutti gli altri l’amministratore li cambia in «Configura» → «Previsioni e ordini» («Giorni di consegna del fornitore»).']
      ],
      approfondimenti: [
        { titolo: 'Come prevede: i metodi in parole semplici', punti: [
          '«Media mobile»: la media dei consumi delle ultime 4 settimane. Va bene per i consumi stabili.',
          '«Livellamento esponenziale»: una media che dà più peso agli ultimi giorni, così segue i cambiamenti lenti.',
          '«Holt smorzato»: capisce se il consumo sta salendo o scendendo e prolunga la tendenza, ma la frena col passare dei giorni per non esagerare.',
          '«Holt-Winters»: in più tiene conto del ritmo della settimana (per esempio meno consumi la domenica). Serve almeno un mese di dati.',
          '«Croston»: per gli articoli usati ogni tanto, con molti giorni a zero: stima ogni quanti giorni servono e in che quantità.',
          'Come sceglie: fa finta di essere 4 settimane fa, prevede le 4 settimane dopo e controlla quale metodo ha sbagliato meno rispetto ai consumi veri. Vince il più preciso; a parità, il più semplice.'
        ] },
        { titolo: 'Copertura, punto di riordino e scorta di sicurezza', punti: [
          '«Copertura»: per quanti giorni basta la giacenza con il consumo previsto. «Esaurimento»: il giorno in cui finirebbe.',
          '«Scorta di sicurezza»: un cuscinetto per i giorni in cui si consuma più del previsto mentre si aspetta la consegna. Più è alto il «Livello di servizio» (per esempio 95%: niente esaurimenti 19 volte su 20), più è grande.',
          '«Punto di riordino» = consumo previsto nei giorni di consegna + scorta di sicurezza. Quando la merce disponibile scende lì, è ora di ordinare.',
          '«Da ordinare» = consumo previsto per i giorni di consegna e fino al prossimo ordine + scorta di sicurezza − merce disponibile (giacenze di tutta la struttura e merce in viaggio), arrotondato a confezioni intere.',
          'Esempio: 20 compresse al giorno, consegna in 7 giorni, ordine ogni 7 giorni, scorta di sicurezza 40, disponibili 150. Punto di riordino = 20 × 7 + 40 = 180. Da ordinare = 20 × 14 + 40 − 150 = 170 compresse: con scatole da 30 la proposta è 6 confezioni.'
        ] },
        { titolo: 'Classi ABC-XYZ', punti: [
          'A, B, C: quanto pesa l’articolo sulla spesa dei consumi. Gli A sono pochi articoli che fanno l’80% della spesa, i C molti articoli che ne fanno poca.',
          'X, Y, Z: quanto è regolare il consumo settimana per settimana. X costante, Y variabile, Z a sbalzi.',
          'Gli AX si seguono da vicino e si ordinano spesso; i CZ si tengono al minimo.'
        ] },
        { titolo: 'Le impostazioni (amministratore, in Configura)', punti: [
          '«Giorni di consegna del fornitore» (7): quanto passa dall’ordine all’arrivo. Vale per gli articoli che non hanno i propri «Giorni di consegna» nel modulo dell’articolo.',
          '«Ogni quanti giorni si ordina» (7): il periodo fino al prossimo ordine.',
          '«Livello di servizio» (95%): quanto si vuole evitare l’esaurimento.',
          '«Storico da usare» (180 giorni): quanti giorni di consumi guardare.'
        ] }
      ]
    }),
    guida({
      id: 'distribuzione', ico: '🧭', gruppo: 'analisi', permesso: 'previsioni', giro: 'distribuzione', pagina: 'distribuzione', perChi: 'Farmacia · Direzione',
      titolo: 'Distribuzione ai magazzini',
      descrizione: 'Quanto la farmacia centrale ha dato a ogni magazzino, cosa ne è stato (consumato, perso, reso) e dove si trova la merce adesso.',
      aChi: 'Alla farmacia centrale e alla direzione, per controllare la distribuzione; ai responsabili di magazzino per i propri magazzini.',
      quando: 'A fine mese o trimestre, per un controllo dei consumi di reparto, o quando un magazzino chiede molto più del solito.',
      passi: [
        'Apri «Distribuzione» (tasto N). In «Periodo» scegli Mese corrente, Ultimi 3, 6 o 12 mesi, oppure «Intervallo…» con le date «Dal» e «Al».',
        'Filtra per «Categoria» o cerca un articolo; scegli se vedere i numeri in pezzi o in euro.',
        'Gli indicatori dicono quanto la farmacia ha dato ai magazzini, quanto è stato consumato e perso, i resi e la merce in viaggio.',
        '«Dalla farmacia centrale ai magazzini»: più è spesso il flusso, più merce è andata a quel magazzino; a destra cosa ne è stato. Passa sopra un flusso (o toccalo) per i numeri.',
        '«Dato ogni mese» mostra quanto ha ricevuto ogni magazzino, mese per mese.',
        '«Dove si trova la merce adesso» mostra la giacenza di oggi magazzino per magazzino, compresa quella in viaggio; scegli un articolo per vederlo da solo.',
        'In «Articolo per magazzino» trovi per ogni articolo «Dato», «Cons.» (consumi e perdite) e «Giac.» di ogni magazzino; il camioncino 🚚 indica merce in viaggio.',
        '«Excel» esporta tre fogli: per magazzino, dato mese per mese, articolo per magazzino.'
      ],
      dopo: '“Dato” conta i DDT ricevuti alla data di ricezione (e i trasferimenti della versione 2.x). La merce che rientra all’origine non conta come data.',
      errori: [
        ['I numeri del mese non tornano con la Nota consumi', 'La Nota consumi conta i giorni di partenza e di ricezione dei DDT nel mese; la distribuzione conta il dato alla ricezione. DDT ancora in viaggio a fine mese spiegano la differenza.'],
        ['Un magazzino non compare', 'Non ha ricevuto niente nel periodo scelto: allarga il periodo.']
      ]
    }),
    guida({
      id: 'nota-consumi', ico: '📅', gruppo: 'analisi', permesso: null, giro: 'registro', pagina: 'registro', perChi: 'Tutti',
      titolo: 'Nota consumi mensile ed Excel',
      descrizione: 'Il modulo del mese di ogni magazzino: controllare, correggere un giorno, stampare o esportare nel modulo Excel della clinica.',
      aChi: 'Ai responsabili dei magazzini di piano e alla farmacia (che possono correggere i consumi) e alla direzione (che consulta, stampa ed esporta).',
      quando: 'A fine mese, per consegnare il modulo firmato, o durante il mese per controllare i consumi.',
      passi: [
        'Apri «Nota consumi mensile» (tasto R). Scegli «Reparto», «Mese» e «Modulo»: Farmaci o Presidi.',
        'È il modulo di sempre: residui, carichi, consumi giorno per giorno, perdite, residui finali e importi, calcolati dai movimenti.',
        'Spunta «Includi gli articoli senza movimenti» per avere nel modulo anche quelli fermi.',
        'Per correggere un consumo clicca la casella del giorno, scrivi il numero e premi Invio: sostituisce i consumi di quel giorno.',
        'Invio o ↓ salva e scende, Tab o → va al giorno dopo, Esc annulla quello che hai scritto.',
        '«Esporta nel modulo Excel» crea il file originale della clinica, già compilato (oltre 48 articoli aggiunge altri fogli identici).',
        'Oppure premi «Stampa»: esce il modulo in A4 orizzontale, pronto per le firme.'
      ],
      dopo: 'Le correzioni diventano movimenti di consumo (o annullano quelli del giorno) e si vedono subito in Giacenze e Movimenti. La merce arrivata con un DDT conta nei carichi il giorno della ricezione; per la farmacia centrale la merce mandata agli altri magazzini conta tra i consumi il giorno di partenza.',
      errori: [
        ['Le caselle non si possono modificare', 'Il tuo utente può solo consultare questo modulo (per esempio la direzione, o un magazzino che non è tuo).'],
        ['“Un altro utente ha registrato nel frattempo”', 'Il consumo del giorno è cambiato mentre scrivevi: il programma non sovrascrive. Ricontrolla la casella e scrivi di nuovo il numero giusto.'],
        ['Il residuo iniziale è sbagliato', 'È la giacenza all’ultimo giorno del mese prima: controlla i movimenti di quel mese o fai un inventario.']
      ]
    }),

    /* ======================= archivio e amministrazione ======================= */
    guida({
      id: 'articoli', ico: '🏷️', gruppo: 'amministrazione', permesso: 'articoli', giro: 'articoli', pagina: 'articoli', perChi: 'Farmacia centrale',
      titolo: 'Articoli e importazione',
      descrizione: 'L’anagrafica di farmaci e presidi: cercare, creare un articolo, codici a barre, fornitore e giorni di consegna, frigorifero e stupefacenti, importazione da Excel.',
      aChi: 'Alla farmacia centrale e all’amministratore, che gestiscono l’anagrafica. Gli altri la consultano.',
      quando: 'Quando arriva un prodotto nuovo, cambia un prezzo o una confezione, o all’inizio per importare l’elenco da Excel.',
      passi: [
        '«Articoli» (tasto A) è l’anagrafica: cerca per nome, principio attivo o codice; filtra per categoria.',
        'Tocca un articolo per aprire la sua scheda: giacenze e lotti di ogni magazzino, posizione negli armadi e ultimi movimenti.',
        'Per un articolo nuovo premi «+ Nuovo articolo» e scrivi la «Denominazione *» come sul modulo.',
        'Poi «Categoria», «Unità di misura», «Principio attivo», «Confezione / formato» e «Codice (AIC / minsan / interno)».',
        '«Pezzi per confezione» e «Codici a barre» servono al lettore; «Prezzo unitario €» e la scorta minima della farmacia centrale al controllo del magazzino.',
        '«Fornitore abituale»: la ditta da cui si ordina (il campo propone i fornitori già scritti nei carichi). Nella proposta d’ordine l’articolo finisce sotto questo fornitore.',
        '«Giorni di consegna»: quanti giorni passano dall’ordine all’arrivo per questo articolo. Lascia vuoto per usare quelli generali di «Configura» (il campo vuoto li mostra in grigio, per esempio «vuoto = 7 (generale)»).',
        'Nel riquadro «Caratteristiche» spunta quelle giuste: «Da frigorifero 2–8 °C», «Stupefacente (cassaforte)», «Alto rischio», «LASA (nome o aspetto simile)», «Urgenze».',
        'Premi «Salva»: l’articolo si può caricare e scaricare subito.',
        'Un articolo con movimenti non si elimina: togli la spunta «Articolo attivo» per nasconderlo. «Mostra non attivi» lo fa rivedere.',
        '«Importa da Excel» legge un elenco o i vecchi moduli Nota consumi compilati, senza doppioni. «Esporta Excel» salva l’anagrafica.'
      ],
      dopo: [
        'L’articolo compare in tutte le pagine. Per i magazzini di piano va aggiunto anche all’assortimento (scorte e posto negli armadi) in «Magazzini e assortimento».',
        'Le caratteristiche compaiono come etichette nella scheda dell’articolo e nel pannello degli Armadi. «Da frigorifero 2–8 °C» e «Stupefacente (cassaforte)» decidono anche dove la «Disposizione automatica» degli armadi mette l’articolo: nel frigorifero e nella cassaforte del magazzino.',
        'Fornitore abituale e giorni di consegna servono alle previsioni: punto di riordino, scorta di sicurezza e proposta d’ordine usano i giorni di consegna dell’articolo, se ci sono. «Esporta Excel» li salva in tre colonne (con le caratteristiche).'
      ],
      errori: [
        ['“Esiste già un articolo con questo nome”', 'Cerca l’articolo esistente: forse è non attivo (spunta «Mostra non attivi»).'],
        ['Il codice a barre è di un altro articolo', 'Un codice appartiene a un solo articolo: toglilo dall’altro articolo e aggiungilo a questo.'],
        ['Non vedi «+ Nuovo articolo»', 'L’anagrafica la modificano la farmacia centrale e l’amministratore.'],
        ['“Giorni di consegna: scrivi un numero da 0 a 365…”', 'Scrivi un numero di giorni da 0 a 365, oppure lascia vuoto il campo per usare i giorni generali di «Configura».'],
        ['“L’articolo compare in richieste o DDT” oppure “è nell’assortimento di …”', 'Un articolo già usato in richieste, DDT o nell’assortimento di un magazzino non si elimina: togli la spunta «Articolo attivo» per nasconderlo (oppure toglilo prima dall’assortimento).']
      ]
    }),
    guida({
      id: 'magazzini-assortimento', ico: '🏬', gruppo: 'amministrazione', permesso: ['struttura', 'assortimento'], giro: 'magazzini', pagina: 'magazzini', perChi: 'Amministratore · Farmacia',
      titolo: 'Magazzini, armadi e assortimento',
      descrizione: 'Creare i magazzini di piano, i loro armadi, e l’assortimento con scorta minima, punto di riordino e scorta massima.',
      aChi: 'All’amministratore, che crea magazzini e armadi; alla farmacia centrale, che decide l’assortimento e le scorte di ogni magazzino.',
      quando: 'All’inizio, quando si apre un nuovo magazzino o arriva un armadio nuovo, e periodicamente per aggiornare le scorte ai consumi.',
      passi: [
        'Apri «Magazzini e assortimento» (tasto W). A sinistra i magazzini per piano; il numero rosso dice gli articoli sotto scorta. Tocca un magazzino per aprirlo.',
        'Amministratore: «+ Nuovo magazzino» → «Nome *», «Tipo» (✚ Farmacia centrale o Magazzino di piano), «Piano», «Livello», «Colore sulla mappa», «Descrizione» → «Crea magazzino».',
        'Scheda «Armadi»: «+ Nuovo armadio», scegli il tipo (armadio, frigorifero, cassettiera, carrello, cassaforte), «Ripiani (1–12)» e «Posti per ripiano (1–20)», poi «Crea armadio».',
        'Scheda «Assortimento»: scrivi il nome in «Aggiungi un articolo all’assortimento» e premi «Aggiungi», oppure «+ Quelli usati negli ultimi 90 giorni».',
        'Per ogni articolo scrivi «Scorta minima», «Punto di riordino» e «Scorta massima» (minima ≤ riordino ≤ massima).',
        'Oppure premi «📈 Proponi dai consumi»: propone circa 3 giorni di consumo come minima, 7 come riordino e 14 come massima. Controlla e correggi.',
        'Premi «Salva assortimento». «Annulla le modifiche» toglie quello che non hai salvato; «Solo da controllare» mostra solo gli articoli da guardare.',
        'Un magazzino già usato non si elimina: nella scheda «Dati» togli la spunta «Magazzino attivo».'
      ],
      dopo: [
        'Le scorte decidono gli avvisi «sotto scorta» (Oggi, Giacenze, Struttura, Armadi) e le quantità di «Proponi le quantità» nelle richieste.',
        'I responsabili di magazzino vedono subito il nuovo assortimento e possono disporre gli articoli negli armadi.',
        'Scegliere un’altra farmacia centrale rende magazzino di piano quella di prima: la farmacia centrale è una sola.'
      ],
      errori: [
        ['“Non si può disattivare”', 'Il magazzino ha DDT da spedire o in viaggio, o richieste aperte: chiudili prima.'],
        ['“Il magazzino ha dei movimenti: non si può eliminare”', 'Togli la spunta «Magazzino attivo»: resta nello storico ma sparisce dagli elenchi.'],
        ['Errore sulle soglie', 'La scorta minima non può superare il punto di riordino, e il riordino non può superare la scorta massima.'],
        ['“Un articolo non attivo non entra nell’assortimento”', 'Riattiva l’articolo nella pagina Articoli, oppure scegline un altro.'],
        ['Un armadio non si rimpicciolisce come vuoi', 'Se togli ripiani o posti, gli articoli che stavano lì tornano senza posto: rimettili con «Disponi» nella pagina Armadi.']
      ]
    }),
    guida({
      id: 'utenti', ico: '👥', gruppo: 'amministrazione', permesso: 'utenti', giro: 'utenti', pagina: 'utenti', perChi: 'Amministratore',
      titolo: 'Utenti, ruoli e magazzini',
      descrizione: 'Creare gli utenti, scegliere il ruolo e i magazzini di ognuno, dare una password provvisoria, disattivare.',
      aChi: 'All’amministratore.',
      quando: 'Quando arriva una persona nuova, cambia reparto o ruolo, dimentica la password o lascia la clinica.',
      passi: [
        'Apri «Utenti» (tasto U). In alto c’è cosa può fare ogni ruolo.',
        'Premi «+ Nuovo utente» e scrivi «Nome utente (per entrare) *» (per esempio m.rossi) e «Nome e cognome *».',
        'Scegli il «Ruolo»: Amministratore, Farmacista (farmacia centrale), Responsabile di magazzino, Direzione (sola lettura).',
        'Per il responsabile di magazzino spunta i «Magazzini di cui è responsabile»: lavorerà solo su quelli.',
        'Premi «Genera» per una password provvisoria facile da dettare, comunicala di persona, poi premi «Crea utente».',
        'Password dimenticata o utente bloccato? «Nuova password» sulla sua riga, poi «Imposta password».',
        'Con «Modifica» cambi ruolo e magazzini; togli la spunta «Utente attivo» per bloccare l’accesso senza perdere i suoi movimenti.',
        'Chi ha perso il telefono della verifica in due passaggi lo sblocchi dalla pagina «Sicurezza» con «Azzera».'
      ],
      dopo: 'La persona entra con la password provvisoria e ne sceglie una sua al primo accesso. Un cambio di ruolo o di magazzini vale subito, anche se è collegata: il suo menu si aggiorna da solo. Tutto finisce nel registro attività.',
      errori: [
        ['“Esiste già un utente con questo nome”', 'Scegli un altro nome utente; se è la stessa persona, riattiva l’utente esistente con «Mostra anche gli utenti disattivati».'],
        ['“Un utente di reparto deve avere almeno un reparto”', 'Per il responsabile di magazzino spunta almeno un magazzino.'],
        ['“Deve restare almeno un amministratore attivo”', 'Prima di cambiare ruolo o disattivare l’ultimo amministratore, nominane un altro.'],
        ['L’utente è bloccato dopo 5 tentativi', 'Dagli una nuova password provvisoria: lo sblocca subito.']
      ],
      approfondimenti: [
        { titolo: 'I ruoli', punti: [
          '«Amministratore»: tutto, compresi utenti, struttura e magazzini, sicurezza, sistema e copie di sicurezza.',
          '«Farmacista (farmacia centrale)»: carichi, richieste da evadere, DDT, consumi, perdite, inventario, articoli, assortimenti, previsioni e proposta d’ordine; annulla qualsiasi movimento.',
          '«Responsabile di magazzino»: nei suoi magazzini registra consumi e perdite, chiede merce alla farmacia, riceve i DDT, fa i resi e dispone gli articoli negli armadi; il resto lo consulta.',
          '«Direzione (sola lettura)»: vede tutto, stampa ed esporta in Excel, non modifica niente.'
        ] }
      ]
    }),
    guida({
      id: 'attivita', ico: '📜', gruppo: 'amministrazione', permesso: 'attivita', giro: 'attivita', pagina: 'attivita', perChi: 'Amministratore · Farmacia',
      titolo: 'Registro attività',
      descrizione: 'Chi ha fatto cosa e quando: accessi, verifica in due passaggi, movimenti, richieste, DDT, struttura e cure della base dati.',
      aChi: 'All’amministratore e alla farmacia centrale, per controllare accessi e operazioni o ricostruire cosa è successo.',
      quando: 'Quando un dato non torna e vuoi sapere chi l’ha cambiato, dopo un accesso sospetto (tentativi sbagliati, utente bloccato), o per un controllo periodico richiesto dalla direzione.',
      passi: [
        'Apri «Attività» (tasto V). All’inizio vedi l’ultima settimana, dal più recente.',
        'Scegli il periodo in «Dal» e «Al»: l’elenco si aggiorna da solo.',
        'In «Utente» scrivi il nome utente (per esempio m.rossi) per vedere solo quello che ha fatto lui.',
        'In «Azione» scegli un argomento: Accessi e uscite, Verifica in due passaggi, Movimenti, Richieste, DDT e consegne, Magazzini, Assortimento e scorte, Base dati e copie (Sistema)…',
        'Ogni riga dice «Quando», «Utente», «Azione», «Dettagli» (per esempio articolo, quantità, numero del DDT) e «Indirizzo IP» del computer.',
        'Le azioni scritte in rosso sono accessi non riusciti o blocchi: se sono tante per lo stesso utente, parlane con lui ed eventualmente dagli una nuova password.',
        '«Excel» salva l’elenco che vedi, con gli stessi filtri. «Aggiorna» lo rilegge dal server.'
      ],
      dopo: [
        'Il registro non si modifica e non si cancella da qui: è la traccia di tutto quello che succede nel programma.',
        'Le operazioni fatte dal programma da solo (controlli notturni, cure della base dati) compaiono con l’utente «sistema».',
        'Le date scelte valgono per la giornata: il giorno dopo la pagina riparte dall’ultima settimana.'
      ],
      errori: [
        ['“Nessuna attività”', 'Nel periodo o con quei filtri non c’è niente: allarga le date, svuota «Utente» e scegli «Tutte» in «Azione».'],
        ['Accanto al numero degli eventi c’è “i più recenti: restringi le date”', 'La pagina mostra al massimo 2000 eventi: scegli un periodo più corto o un’azione sola.'],
        ['Non trovi la pagina «Attività»', 'La vedono solo l’amministratore e la farmacia centrale.'],
        ['Un movimento risulta fatto da un collega che dice di non averlo fatto', 'Controlla l’«Indirizzo IP» e l’ora: se qualcuno usa l’utente di un altro, cambiate la password e attivate la verifica in due passaggi. Ricorda a tutti di uscire a fine turno.']
      ]
    }),
    guida({
      id: 'sistema', ico: '🩺', gruppo: 'amministrazione', permesso: 'sistema', giro: 'sistema', pagina: 'sistema', perChi: 'Amministratore',
      titolo: 'Sistema: base dati e copie',
      descrizione: 'Il semaforo della base dati, controllo e copia a mano, prova di ripristino, seconda cartella delle copie, e cosa fare se è rosso.',
      aChi: 'All’amministratore (e a chi gestisce il server).',
      quando: 'Una volta alla settimana per un’occhiata al semaforo; subito se è giallo o rosso; prima di un cambiamento importante (aggiornamento, spostamento del server).',
      passi: [
        'Apri «Sistema» (tasto X). In alto il semaforo: «Tutto in ordine» (verde), «Da guardare» (giallo) o «Serve attenzione» (rosso), con i motivi scritti sotto.',
        '«Controlla adesso» fa il controllo completo di magazzino e utenti; si può fare anche mentre gli altri lavorano.',
        '«Copia adesso» fa subito una copia di magazzino e utenti e la verifica (la riapre e la controlla). Usala prima di un cambiamento importante.',
        '«Prova di ripristino» ricostruisce i dati dall’ultima copia più il giornale delle modifiche, per finta, e li confronta con quelli veri.',
        'Se la prova dice “La cura funzionerebbe”, in caso di guasto i dati tornerebbero tutti.',
        'Sotto ci sono i numeri (dimensione, copie, spazio libero), la crescita nel tempo, l’elenco delle copie con la verifica e la cronologia di controlli e cure.',
        'In «Seconda cartella delle copie» scrivi il «Percorso completo della cartella» di un disco esterno o di rete (per esempio E:\\CopieFarmacia) e premi «Salva e prova».'
      ],
      dopo: [
        'Il programma controlla la base dati a ogni avvio e ogni notte, scrive ogni modifica anche nel giornale e fa una copia verificata ogni ora se c’è stato lavoro.',
        'Se un file si rovina, all’avvio lo mette da parte (cartella danneggiati) e lo ricostruisce dall’ultima copia buona più il giornale, senza perdere niente.',
        'La seconda cartella riceve una copia delle copie e del giornale: protegge anche dal guasto del disco del server.'
      ],
      errori: [
        ['Semaforo rosso: “Il magazzino (farmacia.db) è danneggiato: riavvia il servizio”', 'Avvisa i colleghi di fermarsi. Sul server, come amministratore: «Ferma servizio.bat» e poi «Avvia servizio.bat» (o riavvia il server). All’avvio il programma cura il file da solo; poi guarda «Controlli e cure».'],
        ['Rosso: “Non c’è nessuna copia verificata del magazzino”', 'Premi «Copia adesso». Se la copia non riesce leggi il messaggio: di solito è lo spazio sul disco.'],
        ['Rosso: “Il disco della cartella dati è quasi pieno”', 'Libera spazio sul disco del server (non nella cartella dati!) o spostala su un disco più grande. Senza spazio non si fanno né copie né giornale.'],
        ['Rosso: “Il giornale delle modifiche non si scrive”', 'Disco pieno o permessi della cartella dati cambiati: libera spazio, controlla che il servizio possa scrivere in dati\\giornale e chiama l’assistenza.'],
        ['Rosso: “il programma ha curato … controlla le registrazioni più recenti”', 'Una cura ha perso le ultime registrazioni: controlla in Movimenti e in DDT e consegne le ultime ore e registra di nuovo quello che manca. Dopo un giorno diventa giallo.'],
        ['Giallo: “La seconda cartella delle copie non è raggiungibile”', 'Il disco esterno è scollegato o la cartella di rete non risponde: ricollegalo. Le copie restano comunque nella cartella dati.'],
        ['Giallo: “L’ultima copia verificata ha più di un giorno” o “Il controllo completo non si fa da più di tre giorni”', 'Il server è rimasto spento o il programma fermo: premi «Copia adesso» e «Controlla adesso».'],
        ['Giallo: “L’ultima prova di ripristino ha trovato differenze”', 'Premi di nuovo «Prova di ripristino». Se le differenze restano, fai «Copia adesso» e chiama l’assistenza con il testo dell’esito.']
      ],
      approfondimenti: [
        { titolo: 'Che cosa vuol dire il semaforo', punti: [
          'Verde, «Tutto in ordine»: i dati sono integri, le copie sono recenti e verificate. Non c’è niente da fare.',
          'Giallo, «Da guardare»: niente di grave, il programma funziona. Leggi i punti e sistemali con calma (per esempio un disco esterno scollegato).',
          'Rosso, «Serve attenzione»: leggi i punti e fai subito quello che dicono. Se non è chiaro cosa fare, chiama l’assistenza prima di continuare a lavorare.'
        ] },
        { titolo: 'Come si protegge da sola la base dati', punti: [
          'Controlli: a ogni avvio un controllo rapido, ogni notte uno completo con il riordino dei file.',
          'Giornale delle modifiche: ogni registrazione è scritta subito anche in un quaderno a parte (cartella giornale), che resta sul disco anche se manca la corrente.',
          'Copie verificate: ogni ora, se qualcuno ha lavorato; si tengono tutte quelle delle ultime 24 ore, poi una al giorno per 14 giorni, una alla settimana per 8 settimane, una al mese per un anno.',
          'Cura: un file rovinato si mette da parte e si ricostruisce dall’ultima copia buona più il giornale.'
        ] }
      ]
    }),
    guida({
      id: 'copie', ico: '💾', gruppo: 'amministrazione', permesso: 'backup', giro: 'configura', pagina: ['configura', 'sistema'], perChi: 'Amministratore',
      dove: '«Configura» → «Copie di sicurezza del server». Stato e seconda cartella: pagina «Sistema».',
      titolo: 'Copie di sicurezza',
      descrizione: 'Le copie orarie verificate, la copia a mano, scaricare una copia e ripristinarla.',
      aChi: 'All’amministratore.',
      quando: 'Prima di un lavoro importante (importazione, inventario generale, aggiornamento), per conservare una copia fuori dal server, o per tornare indietro dopo un errore grave.',
      passi: [
        'Apri «Configura» (tasto F) e trova la scheda «Copie di sicurezza del server».',
        'Il server copia magazzino e utenti ogni ora (se c’è stato lavoro) e verifica ogni copia: nell’elenco «✓ verificata» vuol dire riaperta e controllata.',
        'Prima di un lavoro importante premi «Crea una copia adesso».',
        '«Scarica» salva il file della copia del magazzino sul tuo computer: ogni tanto conservane una anche fuori dal server.',
        '«Ripristina» riporta i dati del magazzino a quel momento, per tutti. Prima il server salva una copia dello stato attuale.',
        'Per confermare scrivi RIPRISTINA e premi «Ripristina la copia». Utenti e password non cambiano.',
        'Stato delle copie, prova di ripristino e seconda cartella sono nella pagina «Sistema».'
      ],
      dopo: 'Dopo un ripristino tutti i browser ricaricano i dati da soli; le registrazioni fatte dopo l’ora della copia non ci sono più (restano nella copia “prima del ripristino”, che si può ripristinare a sua volta). Il server fa subito una copia verificata dello stato ripristinato.',
      errori: [
        ['Una copia è “✕ non riuscita”', 'Non usarla. Premi «Crea una copia adesso» e guarda il semaforo in «Sistema»: spesso è lo spazio sul disco.'],
        ['“Si possono ripristinare solo le copie del magazzino”', 'Le copie di accessi.db (utenti) non si ripristinano da qui: se il file degli utenti si rovina, il programma lo cura da solo all’avvio.'],
        ['Hai ripristinato la copia sbagliata', 'Nell’elenco c’è la copia “prima di un ripristino” appena fatta: ripristina quella per tornare a prima.']
      ]
    })
  ];

  var Guide = { ELENCO: ELENCO, GRUPPI: GRUPPI };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Guide;
    return;
  }
  root.Guide = Guide;

  var App = root.App;
  if (!App) return;
  var h = App.h;

  /* ======================= permessi, pagine e giri ======================= */

  Guide.trova = function (id) { return ELENCO.filter(function (g) { return g.id === id; })[0] || null; };

  Guide.serve = function (g) {
    if (!g.permesso) return true;
    var lista = typeof g.permesso === 'string' ? [g.permesso] : g.permesso;
    return lista.some(function (p) { return App.puo(p); });
  };

  function lista(x) { return !x ? [] : typeof x === 'string' ? [x] : x.slice(); }

  // giri della guida permessi all'utente: [{ id, titolo, pagina }] nell'ordine della guida
  function giriPermessi(g) {
    var T = root.Tour;
    var ids = lista(g.giro);
    if (!ids.length || !T || typeof T.avvia !== 'function') return [];
    if (typeof T.elenco !== 'function') return ids.map(function (id) { return { id: id, titolo: g.titolo, pagina: null }; });
    var elenco;
    try { elenco = T.elenco(); } catch (e) { return []; }
    return ids.map(function (id) { return elenco.filter(function (x) { return x.id === id; })[0]; }).filter(Boolean);
  }

  function giroDisponibile(g) { return giriPermessi(g).length > 0; }

  function avviaGiro(id) {
    if (!id || !root.Tour) return;
    App.chiudiModale();
    root.Tour.avvia(id);
  }

  // pagine del menu della guida che l'utente può aprire: [{ id, voce, ico, tasto }]
  function paginePermesse(g) {
    return lista(g.pagina).map(function (id) {
      var v = (App.MENU || []).filter(function (x) { return x.id === id; })[0];
      return v && App.paginaPermessa(id) ? v : null;
    }).filter(Boolean);
  }

  /* ======================= testo ======================= */

  // «Nome» → nome in grassetto (pulsanti, campi, pagine); il resto è testo semplice
  function ricco(t) {
    return h(t).replace(/«([^«»]+)»/g, '<b>$1</b>');
  }

  function testoCompleto(g) {
    var parti = [g.titolo, g.descrizione, g.perChi, g.aChi, g.quando, g.dove].concat(g.passi, lista(g.dopo));
    g.errori.forEach(function (e) { parti.push(e[0], e[1]); });
    g.approfondimenti.forEach(function (a) { parti.push(a.titolo, a.testo || ''); parti = parti.concat(a.punti || []); });
    return parti.join(' ');
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

  // il file c'è? HEAD; se il server non lo capisce (405, 501…) provo a chiedere il primo byte.
  // Solo 404/410 vogliono dire "non c'è": la rete che cade o un errore del server rifiutano la promessa.
  function esiste(url) {
    return fetch(url, { method: 'HEAD', cache: 'no-cache' }).then(function (r) {
      if (r.ok) return true;
      if (r.status === 404 || r.status === 410) return false;
      return fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-cache' }).then(function (x) {
        if (x.ok) return true;
        if (x.status === 404 || x.status === 410) return false;
        throw new Error('HTTP ' + x.status);
      });
    });
  }

  // il video è stato girato con i passi di adesso? (genera-videoguide.js scrive nel .vtt proprio il testo dei passi)
  function pulito(t) { return String(t || '').replace(/[«»]/g, '').replace(/\s+/g, ' ').trim(); }
  function videoAggiornato(g, passiVideo) {
    if (passiVideo.length !== g.passi.length) return false;
    return g.passi.every(function (p, i) { return pulito(p) === pulito(passiVideo[i].testo); });
  }

  var AVVISO_VECCHIO = 'Questo video è della versione precedente del programma: alcune schermate e alcuni passi sono cambiati. ' +
    'Segui la guida scritta, che è aggiornata.';

  var stato = {}; // id → Promise del controllo (una volta per sessione della pagina)

  Guide.controlla = function (g) {
    if (!stato[g.id]) {
      var prova = esiste(g.video).then(function (c) {
        if (!c) return { video: false, aggiornato: false, passi: [], durata: null };
        return fetch(g.sottotitoli, { cache: 'no-cache' }).then(function (r) {
          return r.ok ? r.text() : '';
        }).catch(function () { return ''; }).then(function (vtt) {
          var passi = leggiVtt(vtt);
          return { video: true, aggiornato: videoAggiornato(g, passi), passi: passi, durata: passi.length ? passi[passi.length - 1].fine : null };
        });
      });
      stato[g.id] = prova;
      // dopo un errore (per esempio la rete) non lo ricordo: si riprova la volta dopo
      prova.catch(function () { if (stato[g.id] === prova) delete stato[g.id]; });
    }
    return stato[g.id].catch(function () { return { video: false, aggiornato: false, passi: [], durata: null }; });
  };

  // ferma il video e libera il lettore (memoria e collegamento): il solo pause() lascia tutto il video in memoria
  var videoAperto = null;
  function liberaVideo(v) {
    if (!v) return;
    if (videoAperto === v) videoAperto = null;
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch (e) { /* già liberato */ }
  }

  /* Finestra con il video: i passi stanno a fianco (sotto sul telefono), quello in corso è evidenziato, un clic ci salta. */
  Guide.apriVideo = function (id) {
    var g = Guide.trova(id);
    if (!g) return;
    Guide.controlla(g).then(function (st) {
      if (!st.video) { Guide.apriScritta(id); return; }
      var conTempi = st.passi.length > 0;
      var passi = conTempi ? st.passi : g.passi.map(function (t) { return { inizio: null, fine: null, testo: t }; });
      var giri = giriPermessi(g);
      var video = null;
      App.apriModale({
        titolo: g.ico + ' ' + g.titolo,
        largo: true,
        corpo: (st.aggiornato ? '' : '<div class="banda attenzione guide-video-vecchio" role="note" style="margin-bottom:12px"><p>' + h(AVVISO_VECCHIO) + '</p></div>') +
          '<div class="guide-lettore">' +
          '<div class="guide-video"><video controls playsinline preload="auto" poster="' + h(g.copertina) + '" src="' + h(g.video) + '">' +
          '<track kind="subtitles" srclang="it" label="Italiano" src="' + h(g.sottotitoli) + '">' +
          'Il browser non riesce a mostrare il video.</video></div>' +
          '<div class="guide-lettore-passi"><h3>Passi</h3><ol class="guide-passi-video">' +
          passi.map(function (p, i) {
            return '<li><button type="button" data-passo="' + i + '"' + (conTempi ? '' : ' disabled') + '>' +
              '<span class="guide-tempo">' + (conTempi ? durata(p.inizio) : String(i + 1)) + '</span><span>' + h(String(p.testo).replace(/[«»]/g, '')) + '</span></button></li>';
          }).join('') + '</ol></div></div>',
        piede: '<button class="btn" type="button" id="guide-scritta-video">📖 Guida scritta</button>' +
          (giri.length ? '<button class="btn" type="button" id="guide-giro-video" title="Ti mostro sullo schermo dove sono le cose">🧭 Guidami sulla pagina</button>' : '') +
          '<span class="spazio"></span><button class="btn primario" type="button" data-chiudi>Chiudi</button>',
        allaChiusura: function () { liberaVideo(video); },
        dopo: function (m) {
          m.classList.add('guide-modale');
          // un'altra finestra del video aperta sopra questa (doppio avvio) non è passata da chiudiModale
          liberaVideo(videoAperto);
          video = videoAperto = m.querySelector('video');
          var box = m.querySelector('.guide-video');
          var corpo = m.querySelector('.modale-corpo');
          var voci = m.querySelectorAll('.guide-passi-video li');
          var elencoPassi = m.querySelector('.guide-passi-video');
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
            if (i >= 0 && elencoPassi.scrollHeight > elencoPassi.clientHeight + 4) {
              var li = voci[i];
              if (li.offsetTop < elencoPassi.scrollTop || li.offsetTop + li.offsetHeight > elencoPassi.scrollTop + elencoPassi.clientHeight) {
                elencoPassi.scrollTop = Math.max(0, li.offsetTop - elencoPassi.clientHeight / 3);
              }
            }
          }
          video.addEventListener('timeupdate', aggiorna);
          video.addEventListener('seeked', aggiorna);
          video.addEventListener('error', function () {
            // solo nella sua finestra (non in quella aperta dopo) e una volta sola
            if (!box.isConnected || box.querySelector('.guide-errore-video')) return;
            box.insertAdjacentHTML('beforeend', '<p class="guide-errore-video">Non riesco a caricare il video. Riprova più tardi, o leggi la guida scritta.</p>');
          });
          elencoPassi.addEventListener('click', function (e) {
            var b = e.target.closest('[data-passo]');
            if (!b || !conTempi) return;
            // sul telefono i passi sono sotto il video: se la finestra è scorsa, riporto in vista il video
            var rv = box.getBoundingClientRect();
            var rc = corpo.getBoundingClientRect();
            if (rv.top < rc.top || rv.bottom > rc.bottom) corpo.scrollTop += rv.top - rc.top - 12;
            video.currentTime = passi[Number(b.getAttribute('data-passo'))].inizio + 0.01;
            var p = video.play();
            if (p && p.catch) p.catch(function () { /* il browser non lo fa partire da solo: c'è il tasto play */ });
          });
          var bg = m.querySelector('#guide-giro-video');
          if (bg) bg.addEventListener('click', function () { avviaGiro(giri[0].id); });
          m.querySelector('#guide-scritta-video').addEventListener('click', function () {
            App.chiudiModale();
            Guide.apriScritta(g.id);
          });
          // si apre con un clic: il video parte subito
          var p = video.play();
          if (p && p.catch) p.catch(function () { /* niente: resta il tasto play */ });
          video.focus();
        }
      });
    });
  };

  /* ======================= guida scritta (finestra) ======================= */

  function htmlScritta(g) {
    var pagine = paginePermesse(g);
    var dove = pagine.map(function (v) {
      return '<b>' + h(v.ico + ' ' + v.voce) + '</b>' + (v.tasto ? ' (tasto <kbd>' + h(v.tasto) + '</kbd>)' : '');
    }).join(' · ');
    var dopo = lista(g.dopo);
    var html = '<div class="guida guide-scritta">' +
      '<p class="guide-descr">' + ricco(g.descrizione) + '</p>' +
      (dove || g.dove ? '<p class="piccolo tenue guide-dove">' + (dove ? 'Nel menu: ' + dove + (g.dove ? '. ' : '') : '') + (g.dove ? ricco(g.dove) : '') + '</p>' : '') +
      (g.aChi ? '<h3>A chi serve</h3><p>' + ricco(g.aChi) + '</p>' : '') +
      (g.quando ? '<h3>Quando si usa</h3><p>' + ricco(g.quando) + '</p>' : '') +
      '<h3>Passo per passo</h3><ol class="guide-scritta-passi">' + g.passi.map(function (p) { return '<li>' + ricco(p) + '</li>'; }).join('') + '</ol>' +
      (dopo.length ? '<h3>Cosa succede dopo</h3>' + (dopo.length === 1 ? '<p>' + ricco(dopo[0]) + '</p>'
        : '<ul>' + dopo.map(function (t) { return '<li>' + ricco(t) + '</li>'; }).join('') + '</ul>') : '') +
      (g.errori.length ? '<h3>Se qualcosa non va</h3><ul class="guide-errori">' + g.errori.map(function (e) {
        return '<li><b>' + ricco(e[0]) + '</b><br>' + ricco(e[1]) + '</li>';
      }).join('') + '</ul>' : '') +
      g.approfondimenti.map(function (a) {
        return '<h3>' + h(a.titolo) + '</h3>' + (a.testo ? '<p>' + ricco(a.testo) + '</p>' : '') +
          (a.punti && a.punti.length ? '<ul>' + a.punti.map(function (t) { return '<li>' + ricco(t) + '</li>'; }).join('') + '</ul>' : '');
      }).join('') +
      '</div>';
    return html;
  }

  Guide.apriScritta = function (id) {
    var g = Guide.trova(id);
    if (!g) return;
    var giri = Guide.serve(g) ? giriPermessi(g) : [];
    var pagine = paginePermesse(g);
    var piede = '<button class="btn" type="button" id="guide-scritta-video" hidden>▶ Guarda il video</button>' +
      giri.map(function (x, i) {
        return '<button class="btn" type="button" data-giro-scritta="' + i + '" title="Ti mostro sullo schermo, passo per passo, dove sono le cose">🧭 ' +
          (giri.length > 1 ? 'Guidami: ' + h(x.titolo) : 'Guidami sulla pagina') + '</button>';
      }).join('') +
      // senza giro (o per le altre pagine della guida) un collegamento semplice alla pagina
      pagine.filter(function (v) { return !giri.some(function (x) { return x.pagina === v.id; }); }).map(function (v) {
        return '<button class="btn" type="button" data-vai="' + h(v.id) + '">Apri ' + h(v.voce) + '</button>';
      }).join('') +
      '<span class="spazio"></span><button class="btn primario" type="button" data-chiudi>Chiudi</button>';
    App.apriModale({
      titolo: g.ico + ' ' + g.titolo,
      largo: true,
      corpo: htmlScritta(g),
      piede: piede,
      dopo: function (m) {
        m.classList.add('guide-modale-scritta');
        m.setAttribute('data-guida', g.id);
        m.querySelectorAll('[data-giro-scritta]').forEach(function (b) {
          b.addEventListener('click', function () { avviaGiro(giri[Number(b.getAttribute('data-giro-scritta'))].id); });
        });
        m.querySelectorAll('[data-vai]').forEach(function (b) {
          b.addEventListener('click', function () { App.chiudiModale(); App.vai(b.getAttribute('data-vai')); });
        });
        var bv = m.querySelector('#guide-scritta-video');
        bv.addEventListener('click', function () { App.chiudiModale(); Guide.apriVideo(g.id); });
        Guide.controlla(g).then(function (st) {
          if (!st.video || !bv.isConnected) return;
          bv.hidden = false;
          if (!st.aggiornato) bv.textContent = '▶ Video (versione precedente)';
        });
      }
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
  var argomentoScelto = ''; // si ricorda finché la pagina del programma resta aperta

  function leggiFiltro() {
    try { return root.localStorage.getItem(CHIAVE_FILTRO) !== 'no'; } catch (e) { return true; }
  }

  function salvaFiltro(si) {
    try { root.localStorage.setItem(CHIAVE_FILTRO, si ? 'si' : 'no'); } catch (e) { /* memoria del browser non disponibile */ }
  }

  function normalizza(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ').replace(/[«»“”]/g, '');
  }

  var STILE_GRUPPO = 'grid-column:1/-1;margin:6px 0 -4px;padding-bottom:6px;border-bottom:1px solid var(--linea);' +
    'font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--tenue)';

  function schedaGuida(g, serve) {
    var giro = serve && giroDisponibile(g);
    return '<article class="guide-scheda" data-guida="' + h(g.id) + '">' +
      '<div class="guide-copertina" data-copertina="' + h(g.id) + '" style="cursor:pointer">' +
      '<span class="guide-ico" aria-hidden="true">' + g.ico + '</span>' +
      '<span class="guide-play" aria-hidden="true" hidden>▶</span>' +
      '<span class="guide-durata" hidden></span></div>' +
      '<div class="guide-corpo">' +
      '<h3>' + h(g.titolo) + '</h3>' +
      '<p class="guide-descr">' + h(g.descrizione) + '</p>' +
      '<p class="guide-meta">' +
      (g.perChi ? '<span class="etichetta info">' + h(g.perChi) + '</span>' : '') +
      (!serve ? '<span class="etichetta">non è nel tuo ruolo</span>' : '') +
      '<span class="guide-solo-testo tenue" hidden>Videoguida in preparazione: la guida scritta è completa.</span></p>' +
      '<div class="guide-azioni">' +
      '<button class="btn primario" type="button" data-video="' + h(g.id) + '" hidden>▶ Guarda il video</button>' +
      '<button class="btn primario" type="button" data-leggi="' + h(g.id) + '">📖 Leggi la guida</button>' +
      (giro ? '<button class="btn" type="button" data-giro="' + h(g.id) + '" title="Ti mostro sullo schermo, passo per passo, dove sono le cose">🧭 Guidami</button>' : '') +
      '</div>' +
      '<details class="guide-passi"><summary>I passi in breve</summary><ol>' +
      g.passi.map(function (p) { return '<li>' + ricco(p) + '</li>'; }).join('') + '</ol></details>' +
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
      if (st.durata) b.setAttribute('aria-label', 'Guarda il video: ' + g.titolo + ' (durata ' + durata(st.durata) + ')' + (st.aggiornato ? '' : ', versione precedente'));
      if (!st.aggiornato) {
        // video della versione precedente: la guida scritta resta il pulsante principale
        art.classList.add('video-vecchio');
        b.classList.remove('primario');
        var leggi = art.querySelector('[data-leggi]');
        leggi.parentNode.insertBefore(leggi, b); // prima la guida scritta, poi il video
        b.textContent = '▶ Video (versione precedente)';
        var n = art.querySelector('.guide-solo-testo');
        n.textContent = 'Il video è della versione precedente: la guida scritta è aggiornata.';
        n.hidden = false;
        return;
      }
      // con il video aggiornato, la guida scritta diventa il pulsante secondario
      art.querySelector('[data-leggi]').classList.remove('primario');
    });
  }

  App.pagine.guida = function (cont, par) {
    par = par || {};
    var scritte = sezioniScritte();
    var mie = leggiFiltro();
    var conGiro = !!(root.Tour && typeof root.Tour.avvia === 'function');
    if (argomentoScelto && !GRUPPI.some(function (x) { return x.id === argomentoScelto; })) argomentoScelto = '';

    cont.innerHTML =
      '<div class="strumenti guide-strumenti">' +
      '<label class="campo guide-cerca"><span>Cerca nelle guide</span><input id="guide-cerca" type="search" autocomplete="off" placeholder="Per esempio: DDT, lotto, telefono, scorta…"></label>' +
      '<label class="campo"><span>Argomento</span><select id="guide-argomento"><option value="">Tutti gli argomenti</option>' +
      GRUPPI.map(function (x) { return '<option value="' + h(x.id) + '"' + (x.id === argomentoScelto ? ' selected' : '') + '>' + h(x.testo) + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="spunta"><input type="checkbox" id="guide-mie"' + (mie ? ' checked' : '') + '> Solo quelle che mi servono</label>' +
      '<span class="spazio"></span>' +
      (conGiro ? '<button class="btn" type="button" id="guide-benvenuto" title="Il giro di un minuto del programma">🧭 Giro del programma</button>' : '') +
      '</div>' +
      '<section class="scheda guide-elenco"><div class="scheda-testa"><h2>Guide e videoguide</h2><span class="nota" id="guide-conta" aria-live="polite"></span></div>' +
      '<div class="scheda-corpo"><p class="guide-intro">Per ogni operazione c’è una <b>guida scritta</b> passo per passo: a chi serve, quando si usa, ' +
      'i pulsanti da premere, cosa succede dopo e cosa fare se qualcosa non va. Dove c’è, il <b>video</b> mostra le stesse cose. ' +
      (conGiro ? 'Con <b>🧭 Guidami</b> te lo mostro direttamente sulla pagina, un passo alla volta, senza registrare niente.' : '') + '</p>' +
      '<div class="guide-griglia" id="guide-griglia"></div>' +
      '<div class="vuoto" id="guide-nessuna" hidden></div></div></section>' +
      (scritte.sezioni.length || scritte.intro
        ? '<section class="scheda guide-scritte"><div class="scheda-testa"><h2>Istruzioni generali</h2><span class="nota">Tocca un argomento per aprirlo</span></div>' +
          '<div class="scheda-corpo">' + (scritte.intro ? '<div class="guida guide-scritte-intro">' + scritte.intro + '</div>' : '') +
          scritte.sezioni.map(function (s, i) {
            return '<details class="guide-sezione" data-sezione="' + i + '"><summary>' + h(s.titolo) + '</summary><div class="guida">' + s.html + '</div></details>';
          }).join('') + '</div></section>'
        : '');

    var griglia = cont.querySelector('#guide-griglia');
    var cerca = cont.querySelector('#guide-cerca');
    var filtro = cont.querySelector('#guide-mie');
    var argomento = cont.querySelector('#guide-argomento');
    var testi = {};
    ELENCO.forEach(function (g) { testi[g.id] = normalizza(testoCompleto(g)); });

    function disegna() {
      var t = normalizza(cerca.value.trim());
      var solo = filtro.checked;
      var arg = argomento.value;
      var trovate = ELENCO.filter(function (g) {
        if (solo && !Guide.serve(g)) return false;
        if (arg && g.gruppo !== arg) return false;
        if (!t) return true;
        // tutte le parole cercate, in qualsiasi punto della guida
        return t.split(/\s+/).every(function (p) { return testi[g.id].indexOf(p) >= 0; });
      });
      griglia.innerHTML = GRUPPI.map(function (gr) {
        var qui = trovate.filter(function (g) { return g.gruppo === gr.id; });
        if (!qui.length) return '';
        return '<h3 class="guide-gruppo" style="' + STILE_GRUPPO + '">' + h(gr.testo) + '</h3>' +
          qui.map(function (g) { return schedaGuida(g, Guide.serve(g)); }).join('');
      }).join('');
      griglia.querySelectorAll('.guide-scheda').forEach(function (art) { completaScheda(art, Guide.trova(art.getAttribute('data-guida'))); });
      var nessuna = cont.querySelector('#guide-nessuna');
      nessuna.hidden = trovate.length > 0;
      nessuna.innerHTML = trovate.length ? '' : '<b>Nessuna guida' + (t ? ' per “' + h(cerca.value.trim()) + '”' : '') + '</b>' +
        (solo || arg ? 'Togli la spunta “Solo quelle che mi servono” o scegli “Tutti gli argomenti” per cercare in tutte.' : 'Prova con un’altra parola.');
      cont.querySelector('#guide-conta').textContent = trovate.length + (trovate.length === 1 ? ' guida' : ' guide');

      // istruzioni generali: con una ricerca restano (aperte) solo le sezioni che contengono la parola
      cont.querySelectorAll('.guide-sezione').forEach(function (d) {
        if (!t) {
          d.hidden = false;
          if (d.getAttribute('data-da-ricerca')) { d.open = false; d.removeAttribute('data-da-ricerca'); }
          return;
        }
        var testo = normalizza(d.textContent);
        var trovata = t.split(/\s+/).every(function (p) { return testo.indexOf(p) >= 0; });
        d.hidden = !trovata;
        if (trovata && !d.open) { d.open = true; d.setAttribute('data-da-ricerca', '1'); }
      });
    }

    cerca.addEventListener('input', disegna);
    filtro.addEventListener('change', function () { salvaFiltro(filtro.checked); disegna(); });
    argomento.addEventListener('change', function () { argomentoScelto = argomento.value; disegna(); });
    var benvenuto = cont.querySelector('#guide-benvenuto');
    if (benvenuto) benvenuto.addEventListener('click', function () { root.Tour.avvia('benvenuto'); });

    griglia.addEventListener('click', function (e) {
      var v = e.target.closest('[data-video]');
      if (v) { Guide.apriVideo(v.getAttribute('data-video')); return; }
      var l = e.target.closest('[data-leggi]');
      if (l) { Guide.apriScritta(l.getAttribute('data-leggi')); return; }
      var c = e.target.closest('[data-copertina]');
      if (c) {
        var art = c.closest('.guide-scheda');
        if (art && art.classList.contains('con-video')) Guide.apriVideo(c.getAttribute('data-copertina'));
        else Guide.apriScritta(c.getAttribute('data-copertina'));
        return;
      }
      var gb = e.target.closest('[data-giro]');
      if (gb) {
        var g = Guide.trova(gb.getAttribute('data-giro'));
        var giri = g ? giriPermessi(g) : [];
        if (giri.length) avviaGiro(giri[0].id);
      }
    });

    disegna();

    // App.vai('guida', { guida: 'carico' }): apre il video di quella guida, oppure la guida scritta
    var richiesta = par.guida && Guide.trova(par.guida);
    if (richiesta) {
      var art = griglia.querySelector('[data-guida="' + richiesta.id + '"]');
      if (art) { art.scrollIntoView({ block: 'center' }); art.classList.add('guide-evidenziata'); }
      Guide.controlla(richiesta).then(function (st) {
        if (!document.body.contains(cont)) return;
        if (st.video && st.aggiornato && !par.scritta) Guide.apriVideo(richiesta.id);
        else Guide.apriScritta(richiesta.id);
      });
    }
  };
})(this);
