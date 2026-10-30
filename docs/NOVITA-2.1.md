# Versione 2.1: lettore di codici a barre, guida sullo schermo, guide e videoguide

Questo documento è il contratto fra le tre parti sviluppate in parallelo. Ogni parte modifica **solo** i file che le sono
assegnati; per il resto legge. `index.html` (già pronto: carica i file nuovi e ha il pulsante `#guidami` nella barra),
`js/app.js`, `js/api.js`, `js/accesso.js`, `js/amministrazione.js` non si toccano.

Regole comuni: interfaccia in italiano semplice; JS in stile ES5 come il resto (var, function, niente moduli né build);
niente script in linea né attributi `on*=` (CSP `script-src 'self'`); nomi e commenti in italiano; la grafica segue
`css/app.css` (variabili `--primario`, `--superficie`, `.btn`, `.scheda`, `.campo`, …). Prima di modificare un file leggilo per intero.
Server di prova: `node server/main.js --porta <libera> --dati <cartella in /tmp>`; primo amministratore con `POST /api/setup`
(da localhost), dati di prova con `POST /api/demo`. Prove: `npm test`; prova multiutente: `node strumenti/prova-interfaccia.js`.
Playwright: `require('playwright')`, `chromium.launch()` senza opzioni.

## 1. Lettore di codici a barre

**File:** `js/barcode.js`, `js/scanner.js`, `css/scanner.css`, `js/pagine.js` (solo per integrare il lettore nelle pagine e i
campi nuovi dell'articolo; non toccare `P.guida`), `server/db.js`, `server/operazioni.js`, `server/http.js` (solo la rotta nuova),
`tests/barcode.test.js` (nuovo), `tests/server.test.js` (solo prove nuove aggiunte in fondo), `docs/ARCHITETTURA.md` (sezione nuova in fondo).

### Lettori
- **Lettori USB o Bluetooth** (emulazione tastiera): scrivono il codice molto in fretta (meno di ~35 ms tra un tasto e l'altro)
  e finiscono con Invio (a volte Tab). Vanno riconosciuti **ovunque**, anche se il cursore è in un altro campo: i caratteri
  della lettura non devono restare nel campo (si ripristina il valore che aveva prima della raffica) e l'Invio non deve
  inviare moduli. Una persona che scrive a mano non deve mai essere scambiata per un lettore.
- **Campo di lettura** nelle pagine dove si registra: si clicca, si legge il codice (o lo si scrive a mano e Invio).
- **Fotocamera** (telefono o tablet): pulsante visibile solo se c'è `window.BarcodeDetector` e la pagina è in un contesto
  sicuro (HTTPS o localhost). Finestra con l'anteprima della fotocamera posteriore, formati `data_matrix`, `ean_13`, `ean_8`,
  `code_39`, `code_128`, `upc_a`, `qr_code`; alla prima lettura valida si chiude (oppure modalità "lettura continua" per caricare
  molte confezioni). Spegnere sempre la fotocamera alla chiusura.
- Segnale: breve "bip" (WebAudio) se riconosciuto, suono diverso se sconosciuto; avviso "Letto: NOME (+10)".

### Codici (js/barcode.js, UMD come js/calcoli.js: `module.exports` in Node, `window.Barcode` nel browser)
`Barcode.analizza(testo)` restituisce `{ grezzo, tipo: 'gs1'|'aic'|'ean'|'altro', chiavi: [...], gtin, aic, lotto, scadenza, seriale }`:
- prefissi AIM da togliere (`]d2`, `]C1`, `]E0`, `]Q3`, `]e0`…);
- **GS1** (Data Matrix dei farmaci e UDI dei dispositivi medici, GS1-128): AI `01` GTIN-14, `17` scadenza AAMMGG (giorno `00` =
  fine mese) → `scadenza: 'AAAA-MM'`, `10` lotto (lunghezza variabile, finisce al carattere GS `\x1D` o a fine testo), `21` seriale,
  `11` data di produzione (ignorata). Accettare sia il separatore GS sia la forma con parentesi `(01)…(17)…(10)…`, e anche la
  forma senza separatori quando i campi variabili sono in fondo;
- **Code 32 / AIC** (farmaci italiani): `A` + 9 cifre, oppure le 6 lettere/cifre in base 32 lette come Code 39 grezzo
  (alfabeto `0123456789BCDFGHJKLMNPQRSTUVWXYZ`) da riconvertire in 9 cifre; controllare la cifra di controllo (posizioni dispari
  sommate; posizioni pari raddoppiate con somma delle cifre; totale mod 10);
- **EAN-13 / EAN-8 / UPC-A**: cifre con cifra di controllo valida → `gtin` a 14 cifre;
- tutto il resto: `tipo: 'altro'`.
Chiavi normalizzate (sono queste che si salvano sull'articolo): `'aic:' + 9 cifre`, `'gtin:' + 14 cifre`, `'cod:' + testo maiuscolo
senza spazi` (massimo 60 caratteri). Un codice GS1 dà la chiave `gtin:`; un AIC la chiave `aic:`.

### Articoli e server
- Nuovi campi dell'articolo: `barcode: [chiavi]` (array, anche vuoto) e `pezziConfezione` (numero > 0, predefinito 1:
  quante unità — cpr, fl, pz… — ci sono in una confezione letta).
- Database: `PRAGMA user_version` 2, `ALTER TABLE articoli ADD COLUMN barcode TEXT NOT NULL DEFAULT '[]'` e
  `ADD COLUMN pezzi_confezione REAL NOT NULL DEFAULT 1`; i database esistenti vanno aggiornati all'apertura.
- `POST/PUT /api/articoli` accettano `barcode` e `pezziConfezione`; una chiave appartiene a un solo articolo (409 con il nome
  dell'articolo che l'ha già).
- `POST /api/articoli/:id/barcode` `{ chiave }` → `{ rev, articolo }`: associa un codice letto a un articolo (permesso
  `articoli`; idempotente se è già suo; 409 se è di un altro; 400 se la chiave non è valida). Registro attività `articoli.barcode`.
- L'importazione dell'archivio della versione per un solo PC e i dati di prova continuano a funzionare (barcode vuoto).

### Comportamento nelle pagine (js/scanner.js + js/pagine.js)
`js/scanner.js` espone `window.Scanner`:
- `Scanner.barra(opz)` → HTML della barra di lettura da mettere in cima alla pagina: contenitore `.barra-scanner`, campo
  `#scanner-campo`, scelta della quantità per lettura `#scanner-modo` (`unita` = 1 unità, `confezione` = `pezziConfezione`),
  pulsante `#scanner-fotocamera` (solo se disponibile), testo d'aiuto breve. `Scanner.collega(cont)` collega gli eventi.
- Ogni pagina che usa le letture imposta `App.gestoreScansione = function (info, articolo, passo) {…}` quando si disegna
  (`App.mostra` lo azzera a ogni cambio pagina). `info` è il risultato di `Barcode.analizza`, `articolo` quello trovato
  (per chiave), `passo` la quantità per lettura secondo `#scanner-modo`.
- Senza gestore (per esempio in Oggi, Giacenze, Scadenze): la lettura apre la scheda dell'articolo.
- **Codice sconosciuto**: finestra "Codice non riconosciuto" con il codice, e se presenti lotto e scadenza; chi ha il
  permesso `articoli` sceglie l'articolo (ricerca per nome) oppure crea un articolo nuovo con il codice già messo; poi la
  lettura riparte come se fosse stata riconosciuta. Chi non ha il permesso vede solo il messaggio.
- **Carico**: aggiunge una riga con l'articolo, quantità = passo, lotto e scadenza dal codice GS1; se c'è già una riga con lo
  stesso articolo e lo stesso lotto, aumenta la quantità. Predefinito `confezione`.
- **Consumi del giorno**: aumenta di `passo` la quantità scritta dell'articolo (la riga compare anche se l'articolo non ha
  giacenza nel reparto), la evidenzia e la porta in vista. Predefinito `unita`.
- **Trasferimenti** e **Perdite**: come il carico; se il codice ha un lotto disponibile nel reparto di partenza lo sceglie nella riga.
  Predefinito `unita`.
- **Inventario**: aumenta di `passo` la quantità contata. Predefinito `unita`.
- **Articoli** (modulo dell'articolo): campo "Codici a barre" con l'elenco (si toglie con ×) e "Aggiungi leggendo" (si legge
  il codice con il campo attivo); campo "Pezzi per confezione". La scheda dell'articolo mostra i codici.
- La barra di lettura compare solo a chi può registrare in quella pagina.
- La scelta di `#scanner-modo` si ricorda per pagina (localStorage, con try/catch).

### Prove
`tests/barcode.test.js` per l'analisi dei codici (GS1 con GS e con parentesi, scadenza con giorno 00, Code 32 in entrambe le forme,
EAN-13 con cifra di controllo sbagliata → 'altro', prefissi AIM); in `tests/server.test.js` prove della rotta e dell'unicità.
Prova nel browser con Playwright simulando il lettore: `page.keyboard.type(codice, { delay: 5 })` poi `Enter`, anche con il
cursore dentro un altro campo.

## 2. Guida sullo schermo ("Guidami")

**File:** `js/tour.js`, `css/tour.css`, `strumenti/prova-tour.js` (nuovo).

- `window.Tour` con `Tour.avvia(id)`, `Tour.ferma()`, `Tour.elenco()` → `[{ id, titolo, descrizione, pagina }]` dei giri
  permessi all'utente, `Tour.perPagina(pagina)` → id del giro della pagina.
- Il pulsante `#guidami` nella barra (già in `index.html`) avvia il giro della pagina aperta; se la pagina non ne ha uno, apre
  un piccolo elenco dei giri disponibili.
- Un giro è una sequenza di passi `{ pagina?, el: 'selettore CSS', titolo, testo, posizione?: 'sopra'|'sotto'|'destra'|'sinistra',
  facoltativo?: true, prima?: function () {} }`. Il passo evidenzia l'elemento (riquadro luminoso, resto della pagina scurito),
  lo porta in vista e mostra un fumetto con titolo, testo, "Passo N di M", pulsanti Indietro / Avanti / Esci (tastiera: frecce,
  Invio, Esc). Se il passo ha `pagina`, il giro apre quella pagina (`App.vai`) e aspetta che l'elemento compaia (al massimo ~3 s);
  se non compare e il passo è `facoltativo`, lo salta; altrimenti mostra il fumetto al centro.
- I passi su pagine non permesse all'utente si saltano; i giri non permessi non compaiono.
- Sul telefono (menu laterale nascosto) i passi sul menu aprono il menu; il fumetto si adatta allo schermo.
- Giri da scrivere (con i selettori veri, leggendo `js/pagine.js`, `js/amministrazione.js`, `js/app.js`, `index.html`):
  `benvenuto` (menu, Oggi e indicatori, ricerca Ctrl K, menu utente, collegamento, pulsante Guidami, Guida), `carico`, `consumi`,
  `trasferimenti`, `perdite`, `giacenze`, `scadenze`, `movimenti`, `inventario`, `registro` (filtri, celle modificabili,
  frecce/Invio, stampa, Excel), `articoli`, `scanner` (barra di lettura `.barra-scanner`, `#scanner-campo`, `#scanner-modo`,
  `#scanner-fotocamera`: passi `facoltativo` perché la barra la scrive l'altra parte), `utenti`, `attivita`, `configura`.
  Testi brevi, concreti, in italiano semplice, dando del tu.
- Primo accesso di ogni utente su quel browser: un invito discreto "Vuoi un giro guidato di un minuto?" (Sì / Non ora / Non
  chiedere più), ricordato in localStorage per utente (con try/catch).
- Il giro non deve rompere niente: niente scritture, niente click automatici su pulsanti che registrano.

## 3. Guide e videoguide

**File:** `js/guide.js`, `css/guide.css`, `strumenti/genera-videoguide.js` (nuovo), cartella `guide/` (video, copertine, sottotitoli).

- `js/guide.js` definisce `window.Guide.ELENCO` = `[{ id, titolo, descrizione, permesso?: 'carico'|…|null, giro: id del giro,
  video: 'guide/<id>.mp4', copertina: 'guide/<id>.jpg', sottotitoli: 'guide/<id>.vtt', passi: ['…', …] }]` e **sostituisce**
  la pagina Guida: `App.pagine.guida = function (cont) {…}` (il file è caricato dopo `js/pagine.js`).
- Guide (almeno): primo accesso e panoramica, carico, lettore di codici a barre, consumi del giorno, trasferimenti, perdite e
  scaduti, giacenze e scadenze, movimenti e annullo, inventario, nota consumi mensile ed Excel, articoli e importazione, utenti
  e ruoli (amministratore), copie di sicurezza (amministratore), cambio password e accesso.
- Pagina Guida: schede delle guide (copertina, titolo, descrizione, durata), filtro "solo quelle che mi servono" secondo i
  permessi, ricerca; ogni scheda ha "▶ Guarda il video" (finestra con `<video controls>` e sottotitoli `<track>` in italiano,
  passi a fianco o sotto), "🧭 Guidami" (`Tour.avvia(giro)`, se `window.Tour` esiste) e i passi scritti. Se il video non c'è
  (risposta 404) il pulsante non compare. Sotto: le sezioni testuali di oggi (come si calcolano le colonne del registro, lotti e
  scadenze, correggere un errore, ruoli, dove stanno i dati, come collegarsi, tasti rapidi) prese dalla `P.guida` di `js/pagine.js`.
- `strumenti/genera-videoguide.js`: avvia il server con una cartella dati temporanea, crea l'amministratore e gli utenti, carica i
  dati di prova, e per ogni guida registra con Playwright (`recordVideo`, 1280×720) uno scenario dimostrativo: didascalia grande
  in basso con il testo del passo, un puntatore finto che si sposta sull'elemento prima di ogni clic, ritmo lento e leggibile
  (30–75 s per video). Poi converte in MP4 con ffmpeg (H.264, `yuv420p`, `+faststart`, CRF ~30, ≤ 2 MB per video se possibile),
  crea la copertina JPG e i sottotitoli WebVTT con i tempi dei passi. Opzione `--solo id1,id2` per rigenerare alcune guide.
  Gli scenari usano i selettori veri delle pagine; quello del lettore usa gli id della sezione 1 e simula il lettore digitando
  il codice in fretta (vedi sopra) — se la barra di lettura non esiste ancora, lo scenario va scritto comunque e si rigenera dopo.
- Il server serve già `guide/<nome>.(mp4|webm|vtt|jpg|png)` (anche a intervalli, per spostarsi nel video) e `npm run exe` li
  incorpora nell'exe.
