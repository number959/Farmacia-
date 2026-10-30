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
- 5 tentativi sbagliati bloccano l'utente per 15 minuti.
- Sessione: cookie `gf_sessione` `HttpOnly; SameSite=Strict; Path=/` (`Secure` con HTTPS); sul server si conserva solo l'hash del token.
  Scade dopo 8 ore di inattività e comunque dopo 14 ore.
- Ogni richiesta che modifica (`POST`, `PUT`, `DELETE`) deve avere l'intestazione `X-Richiesta: 1` (protezione CSRF).
- Intestazioni: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Niente script in linea nell'HTML.
- Primo avvio: finché non esiste nessun utente, il primo amministratore si crea **solo dal server stesso** (richiesta da 127.0.0.1 / ::1).
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
| `GET /api/dati?da=<rev>` | Restituisce ciò che è cambiato dopo la revisione `da` (0 = tutto): `{ rev, completo, impostazioni, reparti: [], articoli: [], movimenti: [], cancellati: [{ tabella: 'articoli'|'reparti', id }] }`. Ogni riga modificata (anche un movimento annullato) ricompare intera. Con `completo: true` (prima richiesta, oppure dopo il ripristino di una copia) la risposta contiene **tutti** i dati e il client deve sostituire il suo stato invece di unirlo. `impostazioni` c'è solo se sono cambiate. |
| `GET /api/eventi` | Server-Sent Events: `event: rev` con `data: {"rev": N}` a ogni modifica; commento `: ping` ogni 25 s. |

### Movimenti
| Metodo e percorso | Corpo | Note |
|---|---|---|
| `POST /api/movimenti` | `{ movimenti: [ { tipo, data, articoloId, repartoId, repartoDestId?, quantita, lotto?, scadenza?, fornitore?, documento?, causale?, note?, prezzo? } ] }` | Tutti nella stessa transazione. Per `consumo`, `perdita`, `trasferimento` il server ripartisce sui lotti (FEFO, prima `lotto` se indicato) e può creare più righe. `rettifica` ha quantità con segno. Un `carico` con `prezzo` aggiorna il prezzo dell'articolo. Risposta `{ rev, movimenti: [creati] }`. |
| `POST /api/movimenti/:id/annulla` | `{ motivo }` | `{ rev }` |
| `POST /api/consumo-giorno` | `{ articoloId, repartoId, data, quantita }` | Correzione dal registro mensile: annulla i consumi di quel giorno e registra `quantita` (0 = nessun consumo). `{ rev }` |

### Anagrafica
| Metodo e percorso | Corpo | Note |
|---|---|---|
| `POST /api/articoli` | articolo senza `id` | `{ rev, articolo }`; 409 se il nome esiste già |
| `PUT /api/articoli/:id` | articolo con `versione` | 409 se `versione` non è quella attuale (modificato da un altro) |
| `DELETE /api/articoli/:id` | | solo se non ha movimenti |
| `POST /api/articoli/importa` | `{ articoli: [{ nome, categoria, prezzo, scortaMinima, unita, giacenza }], repartoId, data, conGiacenza, origine }` | crea gli articoli nuovi (per nome) e, se `conGiacenza`, un carico per le giacenze > 0. `{ rev, nuovi, carichi }` |

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
