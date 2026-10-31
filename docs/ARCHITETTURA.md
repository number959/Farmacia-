# Architettura multiutente (versione server)

Il Gestionale Farmacia gira come **server** su una macchina (il server virtuale della clinica): un solo eseguibile
`GestionaleFarmacia.exe` (Node.js 22 compilato come *single executable application*) che

- tiene i dati in un database SQLite (`dati/farmacia.db`, modulo integrato `node:sqlite`);
- serve l'interfaccia web (i file di `index.html`, `css/`, `js/`, `vendor/` sono incorporati nell'exe);
- espone un'API JSON sotto `/api/`;
- avvisa i browser collegati quando i dati cambiano (Server-Sent Events).

Le postazioni aprono `http://<server>:<porta>/` con Edge o Chrome. Nessun dato resta nei browser.

Un solo processo Node: le richieste sono servite una alla volta e ogni scrittura è una transazione SQLite
(`BEGIN IMMEDIATE … COMMIT`). Due utenti che registrano nello stesso momento non si sovrascrivono mai: la seconda
richiesta vede già il risultato della prima (giacenze e lotti compresi).

## Avvio

```
GestionaleFarmacia.exe [--porta 8080] [--host 0.0.0.0] [--dati <cartella>]
```

- `--dati`: cartella dei dati; predefinita `<cartella dell'exe>\dati`. Variabile d'ambiente alternativa `GESTIONALE_FARMACIA_DATI`.
- File facoltativo `<dati>/configurazione.json`: `{ "porta": 8080, "host": "0.0.0.0", "https": { "cert": "cert.pem", "key": "key.pem" } }`
  oppure `"https": { "pfx": "certificato.pfx", "passphrase": "…" }` (percorsi relativi alla cartella dati). Con `https` il server usa HTTPS.
- Nella cartella dati: `farmacia.db`, `backup/` (copie automatiche giornaliere, ultime 30), `log/`.

## Ruoli

| Ruolo | Codice | Può |
|---|---|---|
| Amministratore | `amministratore` | tutto: utenti, impostazioni, reparti, backup, registro attività, più tutto quello del farmacista |
| Farmacista | `farmacista` | carichi, trasferimenti, consumi, perdite, inventario, anagrafica articoli e importazione, correzioni nel registro mensile, annullare qualsiasi movimento, registro attività in lettura |
| Reparto | `reparto` | solo nei **propri reparti**: consumi, perdite, correzioni dei consumi nel registro mensile; annullare i propri consumi e perdite; consultare tutto il resto |
| Consultazione | `consultazione` | solo lettura, stampe ed esportazioni Excel (per esempio la direzione sanitaria) |

Il server calcola i permessi e li manda al client (`permessi`); il client li usa solo per nascondere pulsanti e pagine,
il controllo vero è sempre sul server.

```js
permessi = {
  utenti: bool,          // gestione utenti
  impostazioni: bool,    // struttura e reparti
  backup: bool,
  attivita: bool,        // registro attività (audit)
  articoli: bool,        // anagrafica e importazione
  carico: bool,
  trasferimento: bool,
  rettifica: bool,       // inventario
  consumo: bool,
  perdita: bool,
  registro: bool,        // correzioni dei consumi nel registro mensile
  annullaTutti: bool,    // annullare qualsiasi movimento (altrimenti solo i propri consumi/perdite)
  reparti: null | [id]   // null = tutti i reparti; altrimenti i soli reparti in cui può scrivere
}
```

## Sicurezza

- Password con `scrypt` (sale casuale per utente), minimo 8 caratteri. Le password date dall'amministratore vanno cambiate al primo accesso.
- 5 tentativi sbagliati bloccano per 15 minuti la coppia (utente, computer), non l'utente: da un altro computer, e sempre dal
  server stesso (`127.0.0.1`/`::1`), l'utente vero entra. 100 errori dallo stesso computer bloccano quel computer.
  Risposta 429, uguale per utenti esistenti e inesistenti; i nomi utente inesistenti non si registrano.
- Accesso d'emergenza sul server: `GestionaleFarmacia.exe --reimposta-password <utente>` stampa una password provvisoria.
- 5 password attuali sbagliate in `POST /api/password` chiudono la sessione.
- Il client manda `X-Utente: <id>` (e `?utente=<id>` alle notifiche): se nello stesso browser un'altra scheda è entrata
  con un altro utente, il server risponde 401 invece di registrare a nome dell'altro.
- Corpo massimo: 16 KB per accesso e primo amministratore, 2 MB per le altre richieste, 50 MB per l'importazione dell'archivio
  (il permesso si controlla prima di leggere il corpo). Al massimo 500 movimenti per richiesta.
- Sessione: cookie `gf_sessione` `HttpOnly; SameSite=Strict; Path=/` (`Secure` con HTTPS); sul server si conserva solo l'hash del token.
  Scade dopo 8 ore di inattività e comunque dopo 14 ore.
- Ogni richiesta che modifica (`POST`, `PUT`, `DELETE`) deve avere l'intestazione `X-Richiesta: 1` (protezione CSRF).
- Intestazioni: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Niente script in linea nell'HTML.
- Primo avvio: finché non esiste nessun utente, il primo amministratore si crea **solo dal server stesso** (richiesta da 127.0.0.1 / ::1
  e intestazione `Host` uguale a `localhost`, `127.0.0.1` o `[::1]`, contro il DNS rebinding).
- Registro attività (tabella `eventi`): accessi, accessi falliti, uscite, ogni scrittura con utente, ora, indirizzo IP e dettagli.

## Formato dei dati (come li vede il client)

Gli oggetti hanno la stessa forma della versione monoutente, così `js/calcoli.js` funziona invariato.

```js
impostazioni = { struttura, sottotitolo, societa, citta, logo, giorniAvvisoScadenza, codiceModulo }
reparto     = { id, nome, centrale: bool, attivo: bool }
articolo    = { id, nome, categoria: 'FARMACI'|'PRESIDI', unita, principio, confezione, codice, prezzo, scortaMinima, note, attivo: bool, versione }
movimento   = { id, tipo, data: 'AAAA-MM-GG', articoloId, repartoId, repartoDestId, quantita, lotto, scadenza: 'AAAA-MM'|'',
                fornitore, documento, causale, note, prezzo, operatore /* nome di chi ha registrato */, utenteId, creato /* ms */,
                annullato: null | { il /* ISO */, da /* nome */, motivo } }
utente      = { id, username, nome, ruolo, reparti: [id], attivo: bool, cambioPassword: bool, ultimoAccesso }
```

## API

Tutte le risposte sono JSON. Errori: stato HTTP 4xx/5xx con `{ "errore": "messaggio in italiano" }`.
401 = non autenticato (il client mostra l'accesso), 403 = non permesso, 404, 409 = conflitto (dati cambiati da un altro utente),
423 = utente bloccato, 400 = dati non validi.

### Accesso
| Metodo e percorso | Corpo | Risposta |
|---|---|---|
| `GET /api/stato` (pubblico) | | `{ inizializzato, daServer /* richiesta locale */, struttura, sottotitolo, logo, versione, utente: utente|null, permessi|null }` |
| `POST /api/setup` (solo se nessun utente e richiesta locale) | `{ username, nome, password }` | come `/api/stato`, con sessione aperta |
| `POST /api/login` | `{ username, password }` | `{ utente, permessi }` + cookie |
| `POST /api/logout` | | `{ ok: true }` |
| `POST /api/password` | `{ attuale, nuova }` | `{ ok: true }` |

### Dati e aggiornamenti
| Metodo e percorso | Note |
|---|---|
| `GET /api/dati?da=<rev>` | Restituisce ciò che è cambiato dopo la revisione `da` (0 = tutto): `{ rev, completo, impostazioni, reparti: [], articoli: [], movimenti: [], cancellati: [{ tabella: 'articoli'|'reparti', id }] }`. Ogni riga modificata (anche un movimento annullato) ricompare intera. Con `completo: true` (prima richiesta, oppure dopo il ripristino di una copia) la risposta contiene **tutti** i dati e il client deve sostituire il suo stato invece di unirlo. `impostazioni` c'è solo se sono cambiate. La risposta contiene anche `storia`, che cambia a ogni avvio del server e a ogni ripristino: il client la rimanda (`&storia=`) e, se è diversa, riceve tutto. |
| `GET /api/eventi` | Server-Sent Events: `event: rev` con `data: {"rev": N}` a ogni modifica; `event: permessi` quando l'amministratore cambia ruolo o reparti di quell'utente; commento `: ping` ogni 25 s. Le schede nascoste chiudono le notifiche e controllano ogni 20 s (il browser tiene al massimo 6 collegamenti per server). |

### Movimenti
| Metodo e percorso | Corpo | Note |
|---|---|---|
| `POST /api/movimenti` | `{ movimenti: [ { tipo, data, articoloId, repartoId, repartoDestId?, quantita, lotto?, scadenza?, fornitore?, documento?, causale?, note?, prezzo?, teorica? } ] }` | Tutti nella stessa transazione (massimo 500). Per `consumo`, `perdita`, `trasferimento` il server ripartisce sui lotti (FEFO, prima `lotto` se indicato, mai oltre la sua disponibilità; 409 se il lotto scelto non c'è più). `rettifica` ha quantità con segno e `teorica` = giacenza su cui il client ha calcolato la differenza (409 se nel frattempo è cambiata). Un `carico` con `prezzo` aggiorna il prezzo dell'articolo. Risposta `{ rev, movimenti: [creati] }`. |
| `POST /api/movimenti/:id/annulla` | `{ motivo }` | `{ rev }` |
| `POST /api/consumo-giorno` | `{ articoloId, repartoId, data, quantita, prima }` | Correzione dal registro mensile: annulla i consumi di quel giorno e registra `quantita` (0 = nessun consumo). `prima` è il consumo che il client vedeva: se è diverso da quello registrato (un altro utente ha registrato nel frattempo) risponde 409 e non cambia niente. `{ rev }` |

### Anagrafica
| Metodo e percorso | Corpo | Note |
|---|---|---|
| `POST /api/articoli` | articolo senza `id` | `{ rev, articolo }`; 409 se il nome esiste già |
| `PUT /api/articoli/:id` | articolo con `versione` | 409 se `versione` non è quella attuale (modificato da un altro) |
| `DELETE /api/articoli/:id` | | solo se non ha movimenti |
| `POST /api/articoli/importa` | `{ articoli: [{ nome, categoria, prezzo, scortaMinima, unita, giacenza }], repartoId, data, conGiacenza, origine }` | crea gli articoli nuovi (per nome) e, se `conGiacenza`, un carico per le giacenze > 0, solo per gli articoli senza movimenti in quel reparto (reimportare non raddoppia). `{ rev, nuovi, carichi, saltati }` |

### Amministrazione
| Metodo e percorso | Ruolo | Note |
|---|---|---|
| `PUT /api/impostazioni` | amministratore | campi di `impostazioni` |
| `PUT /api/reparti` | amministratore | `{ reparti: [{ id?, nome, centrale, attivo }] }`: aggiorna quelli con `id`, crea quelli senza |
| `DELETE /api/reparti/:id` | amministratore | solo senza movimenti |
| `GET /api/utenti` | amministratore | `{ utenti: [] }` |
| `POST /api/utenti` | amministratore | `{ username, nome, ruolo, reparti, password }` (cambio password al primo accesso) |
| `PUT /api/utenti/:id` | amministratore | `{ nome, ruolo, reparti, attivo }`; disattivare chiude le sue sessioni; non si può togliere l'ultimo amministratore attivo |
| `POST /api/utenti/:id/password` | amministratore | `{ nuova }`: nuova password provvisoria, sblocca l'utente |
| `GET /api/attivita?dal=&al=&utente=&azione=&limite=` | amministratore, farmacista | `{ eventi: [{ id, quando, username, azione, dettagli, ip }] }` |
| `GET /api/backup` | amministratore | `{ backup: [{ nome, dimensione, data }] }` |
| `POST /api/backup` | amministratore | crea subito una copia |
| `GET /api/backup/:nome` | amministratore | scarica il file `.db` |
| `POST /api/backup/:nome/ripristina` | amministratore | prima salva una copia dello stato attuale, poi ripristina |
| `POST /api/importa-archivio` | amministratore | corpo = archivio `.json` della versione monoutente; solo se l'archivio è vuoto (nessun articolo e movimento) |
| `POST /api/demo` | amministratore | dati di prova; solo se l'archivio è vuoto |

## Compilazione dell'exe

`npm run exe` (vedi `strumenti/compila-exe.js`): impacchetta server e interfaccia in un blob SEA, lo inietta in `node.exe`
per Windows x64 (stessa versione di Node usata per prepararlo), imposta icona e informazioni di versione e produce
`dist/GestionaleFarmacia.exe`. Con `--linux` produce anche `dist/gestionale-farmacia-linux` per le prove automatiche.

## Codici a barre (versione 2.1)

### Articoli
L'articolo ha due campi in più:

```js
articolo = { …, barcode: ['aic:012345676', 'gtin:08012345678907', 'cod:INTERNO77'], pezziConfezione: 1 }
```

- `barcode`: chiavi normalizzate dei codici a barre (anche vuoto, al massimo 50). Una chiave appartiene a **un solo articolo**.
- `pezziConfezione`: quante unità (cpr, fl, pz…) ci sono in una confezione letta; numero > 0, predefinito 1.

Database: `PRAGMA user_version` 2 di `farmacia.db`, colonne `articoli.barcode TEXT NOT NULL DEFAULT '[]'` (array JSON)
e `articoli.pezzi_confezione REAL NOT NULL DEFAULT 1`. I database della versione 2.0 (e le copie di sicurezza vecchie che si
ripristinano) si aggiornano da soli all'apertura (`aggiornaSchemaDati` in `server/db.js`). L'unicità si controlla nella
transazione con `json_each(articoli.barcode)`.

| Metodo e percorso | Corpo | Note |
|---|---|---|
| `POST /api/articoli`, `PUT /api/articoli/:id` | anche `barcode`, `pezziConfezione` | le chiavi si normalizzano (`Barcode.normalizzaChiave`); chiave non valida 400; chiave di un altro articolo 409 con il nome di quell'articolo. In `PUT` i campi mancanti restano come sono (client vecchi, importazioni). |
| `POST /api/articoli/:id/barcode` | `{ chiave }` | permesso `articoli`. Aggiunge un codice letto all'articolo: `{ rev, articolo }`. Idempotente se il codice è già suo (nessuna scrittura), 409 se è di un altro articolo, 400 se la chiave non è valida, 404 se l'articolo non c'è. Registro attività `articoli.barcode`. |

Importazione da Excel, archivio della versione per un solo PC e dati di prova creano articoli con `barcode: []`.

### Analisi dei codici (`js/barcode.js`, condiviso con il server)
`Barcode.analizza(testo)` → `{ grezzo, tipo: 'gs1'|'aic'|'ean'|'altro', chiavi, gtin, aic, lotto, scadenza: 'AAAA-MM'|'', seriale }`.

- Toglie il prefisso AIM (`]d2`, `]C1`, `]E0`, `]Q3`, `]e0`…) e un GS iniziale (FNC1).
- **GS1** (Data Matrix dei farmaci, UDI, GS1-128): AI `01` GTIN, `17` scadenza AAMMGG (giorno `00` = fine mese, secolo con la
  regola GS1), `10` lotto, `21` seriale; `11` e gli altri AI noti si leggono e si ignorano. Forme accettate: con il separatore
  GS (`\x1D`, oppure `<GS>`/`{GS}` scritti come testo), con le parentesi `(01)…(17)…`, senza separatori quando i campi variabili
  sono in fondo (se un campo variabile finisce con `17`/`11` + data valida, la data si stacca). Chiave `gtin:` (nessuna chiave
  se manca il GTIN, per esempio un SSCC o un lotto da solo).
- **AIC (Code 32)**: `A` + 9 cifre, 9 cifre, oppure le 6 lettere/cifre in base 32 (`0123456789BCDFGHJKLMNPQRSTUVWXYZ`) di un
  lettore impostato su Code 39; cifra di controllo obbligatoria. Chiave `aic:` + 9 cifre.
- **EAN-13, EAN-8, UPC-A, GTIN-14** con cifra di controllo valida → `gtin:` + 14 cifre.
- Tutto il resto: `tipo: 'altro'`, chiave `cod:` + testo maiuscolo senza spazi né caratteri di controllo (massimo 60).

`Barcode.descrivi(chiave)` dà il testo da mostrare (`AIC 012345676`, `EAN 8012345678907`, `INTERNO77`).

### Interfaccia (`js/scanner.js`, `window.Scanner`)
- **Lettori USB/Bluetooth** (emulazione tastiera): un ascoltatore `keydown` sulla finestra (fase di cattura) riconosce le
  raffiche: almeno 4 caratteri, nessun intervallo oltre 60 ms, media ≤ 35 ms, chiuse da Invio o Tab entro 150 ms. Nei campi di
  testo i caratteri passano e, se era una lettura, il campo torna al valore e alla selezione di prima della raffica (con un
  evento `input`); fuori dai campi (pagina, pulsanti, elenchi a discesa) i tasti si trattengono finché non si capisce se è una
  lettura, poi si ripassano alla pagina (tasti rapidi) o si applicano all'elenco come la scelta per iniziali del browser.
  L'Invio di una lettura non arriva alla pagina. I campi password, gli eventi `repeat` e la composizione (IME) non si
  considerano mai. Il separatore GS arriva come `Ctrl+]` (solo dentro una raffica già iniziata).
  Conseguenza per le prove automatiche: con Playwright `keyboard.type(testo)` senza `delay` seguito da Invio è una lettura;
  per scrivere come una persona usare `fill()` o `delay` ≥ 60 ms.
- **Barra di lettura**: `Scanner.barra({ pagina, predefinito })` → `.barra-scanner` con `#scanner-campo` (scritto a mano + Invio),
  `#scanner-modo` (`unita` = 1, `confezione` = `pezziConfezione`; scelta ricordata per pagina in `localStorage`
  `gf-scanner-modo:<pagina>`), `#scanner-fotocamera` (solo con `window.BarcodeDetector` in un contesto sicuro), aiuto e ultima
  lettura (`.scanner-ultima`). `Scanner.collega(cont)` collega gli eventi. Pagine con la barra: Carico (predefinito
  `confezione`), Consumi, Trasferimenti, Perdite, Inventario (predefinito `unita`).
- **Instradamento** (`Scanner.elabora(testo, origine)`): 1) una finestra che sta leggendo (`Scanner.cattura(fn, el)`, attiva
  finché `el` è nella pagina: il modulo dell'articolo); 2) la ricerca rapida aperta si chiude; 3) con una finestra aperta da una
  lettura (classe `da-lettura`: scheda, codice sconosciuto) la nuova lettura la sostituisce, con un'altra finestra aperta compare
  "Chiudi prima la finestra aperta"; 4) articolo trovato → `App.gestoreScansione(info, articolo, passo)` della pagina (che può
  restituire `false` = non applicata, o il testo dell'avviso), altrimenti si apre la scheda dell'articolo; articolo non attivo
  → avviso; 5) codice sconosciuto → finestra "Codice non riconosciuto" (chi ha il permesso `articoli` sceglie l'articolo per
  nome, `POST /api/articoli/:id/barcode`, oppure crea un articolo nuovo con il codice già messo; poi la lettura riparte).
- **Fotocamera** (`Scanner.apriFotocamera({ alLeggere, continua })`): finestra propria sopra le altre (`.scanner-fotocamera`),
  fotocamera posteriore, formati `data_matrix`, `ean_13`, `ean_8`, `code_39`, `code_128`, `upc_a`, `qr_code` (quelli
  supportati); alla prima lettura si chiude, con "Lettura continua" resta aperta e lo stesso codice si conta di nuovo solo dopo
  che è uscito dall'inquadratura. La fotocamera si spegne alla chiusura, con Esc, al cambio di pagina e con la scheda nascosta.
- Segnali: `Scanner.suono('ok'|'sconosciuto'|'errore')` (WebAudio) e avviso "Letto: NOME (+10)".

## Guidami e videoguide (versione 2.1)

- `js/tour.js` (`window.Tour`): giri guidati sulla pagina. Ogni giro è un elenco di passi `{ pagina?, el, titolo, testo,
  posizione?, facoltativo?, se?, insieme?, risali?, riparo? }` con i selettori veri delle pagine; il pulsante `#guidami` avvia
  il giro della pagina aperta. Il giro non scrive dati e non preme pulsanti: blocca i clic sulla pagina finché è aperto, chiede
  conferma prima di cambiare pagina se ci sono righe non registrate, si chiude da solo al cambio pagina o alla scadenza della
  sessione. L'invito al primo accesso si ricorda nel browser (`gf-giro-invito:<id utente>`).
  `strumenti/prova-tour.js` percorre tutti i giri per ogni ruolo, su computer e telefono, e controlla che non parta nessuna scrittura.
- `js/guide.js` (`window.Guide`): sostituisce la pagina Guida. `Guide.ELENCO` elenca le guide (id, permesso, giro, passi);
  i passi sono anche le didascalie dei video. I file stanno in `guide/<id>.mp4|jpg|vtt`, serviti dal server anche a intervalli
  (Range) e incorporati nell'exe. Una guida senza video (404) mostra solo i passi scritti e Guidami.
- `strumenti/genera-videoguide.js` rigenera i video: avvia il server vero con dati di prova, registra ogni scenario con
  Playwright (1280×720, didascalie e puntatore finto), poi ffmpeg (H.264, `+faststart`, al massimo 2 MB) e scrive copertina e
  sottotitoli. Quando una pagina cambia aspetto si rigenera la sua guida con `--solo <id>`.

## Anteprima

`strumenti/genera-anteprima.js` crea `dist/anteprima/`: l'interfaccia vera con `anteprima/server-finto.js`, che risponde a
`fetch('api/…')` ed `EventSource('api/eventi')` dentro il browser (stesse regole di permessi e ripartizione sui lotti, tramite
`js/calcoli.js`), e `anteprima/banda.js` (utenti di prova, collega che registra, codici a barre di prova). `pagina-artifact.html`
è la stessa pagina senza `<html>`/`<head>`/`<body>`, per pubblicarla come Artifact; lì i download passano dalla funzione
`downloads` e la fotocamera è spenta. Non fa parte del programma installato.
