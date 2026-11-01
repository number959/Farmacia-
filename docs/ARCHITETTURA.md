# Architettura di NefroCenter Pharmacy 3.0

NefroCenter Pharmacy (nome tecnico **Gestionale Farmacia**) gira come **server** su una macchina della clinica: un solo
eseguibile `GestionaleFarmacia.exe` (Node.js 22 compilato come *single executable application*) che

- tiene i dati in due database SQLite (`dati/farmacia.db` magazzino, `dati/accessi.db` utenti e attività; modulo
  integrato `node:sqlite`);
- serve l'interfaccia web (`index.html`, `css/`, `js/`, `vendor/`, `fonts/`, `brand/`, `guide/` incorporati nell'exe);
- espone un'API JSON sotto `/api/`;
- avvisa i browser collegati quando i dati cambiano (Server-Sent Events);
- scrive un **giornale delle modifiche**, fa **copie verificate** e **cura** da solo un file danneggiato.

Le postazioni aprono `http://<server>:<porta>/` con Edge o Chrome. Nessun dato resta nei browser (solo preferenze come il
tema, in `localStorage`).

Un solo processo Node: le richieste sono servite una alla volta e ogni scrittura è una transazione SQLite
(`BEGIN IMMEDIATE … COMMIT`, `Database.scrivi(fn(rev))`). Due utenti che registrano nello stesso momento non si
sovrascrivono mai: la seconda richiesta vede già il risultato della prima (giacenze, lotti, stati di richieste e DDT).

Il contratto fra le parti della 3.0 (forme dei dati, permessi, rotte, decisioni prese) è in
[`docs/NOVITA-3.0.md`](NOVITA-3.0.md); questo documento descrive il programma com'è.

### Perché il nome tecnico resta "Gestionale Farmacia"

Il nome mostrato è un'impostazione (`nomeProdotto`, predefinito "NefroCenter Pharmacy"). Restano invece quelli della 2.x:
`GestionaleFarmacia.exe`, l'attività pianificata e la regola del firewall "Gestionale Farmacia", la cartella
`C:\GestionaleFarmacia\dati`, i file `farmacia.db` e `accessi.db`, il cookie `gf_sessione`, le chiavi `gf-*` di
`localStorage`, gli id dei reparti (`r-farmacia`, `r-degenza`…) e dei ruoli (`amministratore`, `farmacista`, `reparto`,
`consultazione`). Così un'installazione 2.x si aggiorna sostituendo solo l'exe.

## Avvio e configurazione

```
GestionaleFarmacia.exe [--porta 8080] [--host <indirizzo>] [--dati <cartella>] [--servizio]
GestionaleFarmacia.exe --reimposta-password <utente>      accesso d'emergenza (anche col servizio acceso), poi esce
GestionaleFarmacia.exe --aiuto
```

- `--dati`: cartella dei dati; predefinita `<cartella dell'exe>\dati`. Variabile d'ambiente alternativa
  `GESTIONALE_FARMACIA_DATI`. Senza `--host` ascolta su IPv4 e IPv6 (solo IPv4 se IPv6 è spento).
- `--servizio` (lo usa l'attività pianificata): dopo un errore d'avvio non aspetta Invio.
- File facoltativo `<dati>/configurazione.json` (anche con BOM o in UTF-16, come lo salva il Blocco note):

```json
{
  "porta": 8080,
  "host": "0.0.0.0",
  "https": { "cert": "cert.pem", "key": "key.pem" },
  "secondaCartella": "E:\\CopieFarmacia"
}
```

  `https` può essere anche `{ "pfx": "certificato.pfx", "passphrase": "…" }`. Percorsi relativi = dalla cartella dati.
  `secondaCartella` (3.0): copia delle copie verificate e del giornale su un altro disco; scritta qui, la pagina Sistema non
  la può cambiare (409). Le chiavi sconosciute (per esempio `nota`) si ignorano. Gli argomenti vincono sul file.
- `--reimposta-password <utente>`: nuova password provvisoria, riattiva l'utente e **azzera la sua 2FA** (segreto, codici di
  recupero, computer ricordati); registro attività `utenti.password-emergenza`. Salta controlli e cura (il database può
  essere aperto dal servizio).

### Cartella dati

```
dati/
  farmacia.db (+ -wal, -shm)   magazzino, schema 3
  accessi.db  (+ -wal, -shm)   utenti, sessioni, 2FA, dispositivi, registro attività; schema 2
  chiave-2fa.key               chiave AES-256 dei segreti TOTP: 32 byte casuali in base64 (0600; su Windows la proteggono i
                               permessi della cartella, vedi installazione/LEGGIMI.txt)
  configurazione.json          facoltativo
  salute.json                  stato della pagina Sistema: storia di controlli e cure, crescita, ultima prova di
                               ripristino, seconda cartella scelta dalla pagina (scritto in modo atomico)
  backup/                      farmacia_AAAA-MM-GG_HHMMSS_<auto|manuale|prima-del-ripristino>.db, accessi_….db,
                               ognuna con la scheda di verifica <nome>.json; accessi_….chiave-2fa.key accanto alle copie
                               di accessi.db
  giornale/                    AAAA-MM-GG.jsonl, una riga per revisione (fsync)
  danneggiati/                 file messi da parte da una cura, con la data (c'è solo se una cura è servita)
  log/                         server-AAAA-MM.log, errori-avvio.log
```

### Sequenza d'avvio e arresto (`server/main.js`)

1. argomenti e `configurazione.json`;
2. `Salute.curaAllAvvio()`: `PRAGMA quick_check` di `farmacia.db` e `accessi.db`; un file danneggiato, troncato o sparito
   (se ci sono copie) va in `danneggiati/` e si cura (vedi [Base dati che si cura da sola](#base-dati-che-si-cura-da-sola));
3. apertura del database e aggiornamento automatico dello schema (`creaSchemaDati`, `creaSchemaAccessi`);
4. giornale (`Giornale.collega()` su `database.dopoScrittura`), copie (`Backup`), `salute.collega()`: riapplicazione dal
   giornale delle scritture perse in uno spegnimento improvviso (o linea nuova "con perdite"), confronto con il registro
   attività, copia dopo un'eventuale cura;
5. server HTTP o HTTPS in ascolto, poi `salute.avviato()`: checkpoint completo del WAL nel file e voce `avvio` durevole
   nel giornale; ogni 5 minuti copie orarie, verifica di una copia vecchia, giornale nuovo nella seconda cartella,
   campione della crescita, controllo completo notturno (fra le 2 e le 6, o subito se manca da più di 3 giorni).

All'arresto ordinato (`SIGINT`, `SIGTERM`, `SIGBREAK`): copia finale se c'è stato lavoro, checkpoint completo e voce
`chiusura` durevole nel giornale, chiusura del giornale, delle notifiche e del database. Prima dell'avvio completo un errore va in `log/errori-avvio.log`; dopo, un errore imprevisto si
registra e il server resta acceso.

## Ruoli e permessi

| Ruolo (id) | Etichetta | Può |
|---|---|---|
| `amministratore` | Amministratore | tutto, compresi utenti, struttura, sicurezza, sistema, copie, impostazioni |
| `farmacista` | Farmacista (farmacia centrale) | carichi, evasione delle richieste, DDT, consumi, perdite, inventario, articoli, assortimenti, previsioni, ordini, registro attività; annulla qualsiasi movimento |
| `reparto` | Responsabile di magazzino | nei magazzini di `utente.reparti`: consumi, perdite, correzioni della Nota consumi, richieste, DDT di reso, ricezione dei DDT, ubicazioni; annulla i propri consumi e perdite; consulta il resto |
| `consultazione` | Direzione (sola lettura) | vede tutto (anche previsioni e distribuzione), stampa ed esporta; nessuna scrittura |

Il server calcola i permessi (`server/accessi.js` `permessi(utente)`) e li manda al client; il client li usa solo per
nascondere pulsanti e pagine, il controllo vero è sempre sul server (spesso due volte: prima e dopo aver letto il corpo).

```js
permessi = {
  utenti, impostazioni, backup,            // amministratore
  attivita, articoli, carico,              // farmacista e amministratore
  trasferimento, rettifica, annullaTutti,  // farmacista e amministratore
  consumo, perdita, registro,              // + responsabile di magazzino (solo i suoi magazzini)
  // versione 3.0
  richieste,      // creare, modificare, inviare, annullare richieste dei magazzini scrivibili
  evadiRichieste, // prendere in carico, approvare, rifiutare, chiudere, preparare il DDT di una richiesta
  ddt,            // preparare, modificare, spedire, annullare DDT DA un magazzino scrivibile
  riceviDdt,      // ricevere DDT IN un magazzino scrivibile
  struttura,      // magazzini e armadi (amministratore)
  assortimento,   // assortimento e scorte (farmacista, amministratore)
  ubicazioni,     // posizione degli articoli negli armadi dei magazzini scrivibili
  previsioni,     // pagine Previsioni e Distribuzione (tutti)
  ordini,         // proposta d'ordine ed esportazione (farmacista, amministratore)
  sistema,        // pagina Sistema (amministratore)
  sicurezza,      // criterio 2FA e azzeramento 2FA altrui (amministratore)
  reparti: null | [id]   // null = tutti i magazzini; altrimenti i soli magazzini in cui può scrivere
}
```

## Sicurezza

- Password con `scrypt` (sale casuale per utente), minimo 8 caratteri; quelle date dall'amministratore vanno cambiate al
  primo accesso (`cambioPassword`).
- 5 password sbagliate bloccano per 15 minuti la coppia (utente, computer), non l'utente: da un altro computer, e sempre dal
  server stesso (`127.0.0.1`/`::1`), l'utente vero entra. 100 errori dallo stesso computer bloccano quel computer.
  Risposta 429, uguale per utenti esistenti e inesistenti.
- 5 password attuali sbagliate in `POST /api/password` (o nelle rotte 2FA che chiedono la password) chiudono la sessione.
- **Verifica in due passaggi (TOTP, RFC 6238)**: SHA-1, 6 cifre, passo 30 s, finestra ±1 passo; segreto di 20 byte cifrato
  AES-256-GCM con `dati/chiave-2fa.key` (creata al primo uso, mai sostituita se rovinata: errore chiaro); un codice dello
  stesso passo non vale due volte (`totp_ultimo_passo`); 5 codici sbagliati bloccano l'utente per 15 minuti; 10 codici di
  recupero monouso salvati come SHA-256 con l'id dell'utente (valgono anche senza la chiave).
- **Dal server stesso** (`127.0.0.1`/`::1`, l'accesso d'emergenza) nessun blocco, ma la sfida si annulla dopo 10 codici
  sbagliati (401 `sfidaScaduta`: si riscrive la password; evento `accesso.2fa.sfida-annullata`); dopo 20 codici
  sbagliati in 15 minuti per lo stesso utente, una sfida nuova solo ogni 30 s (429 `attesaSecondi`). Da qualsiasi
  computer al massimo 3 sfide valide insieme per (utente, computer): la più vecchia decade. Una conferma riuscita di un
  telefono nuovo azzera questi contatori (che stanno solo in memoria).
- **Cambio di telefono** (2FA già attiva): `POST /api/2fa/inizia` chiede la password, come disattivare la 2FA o creare
  codici nuovi (5 password sbagliate chiudono la sessione, evento `accesso.2fa.cambio-telefono-fallito`). La chiave nuova
  vale solo per la sessione che l'ha chiesta e decade dopo 10 codici sbagliati (`accesso.2fa.chiave-annullata`). La
  prima attivazione non chiede di nuovo la password.
  "Ricorda questo computer": cookie `gf_dispositivo` 30 giorni, `HttpOnly; SameSite=Strict; Path=/api/login`, fino a 5
  utenti per browser, sul server solo l'hash (tabella `dispositivi`).
- Criterio `richiedi2fa` (`nessuno` | `amministratori` | `farmacisti` = amministratori e farmacisti | `tutti`): chi deve
  avere la 2FA e non l'ha attivata riceve **401 `{ attiva2fa: true }`** su tutto tranne `GET /api/2fa`,
  `/api/2fa/inizia`, `/api/2fa/conferma`, `/api/password`, `/api/stato` e il logout; vale anche per le sessioni già aperte
  (le loro notifiche si chiudono e il browser passa all'attivazione guidata).
- Accesso d'emergenza sul server: `--reimposta-password <utente>` (vedi sopra).
- Il client manda `X-Utente: <id>` (e `?utente=<id>` alle notifiche): se nello stesso browser un'altra scheda è entrata
  con un altro utente, il server risponde 401 invece di registrare a nome dell'altro.
- Corpo massimo: 16 KB per accesso, 2FA all'accesso e primo amministratore; 2 MB per le altre richieste; 50 MB per
  l'importazione dell'archivio (il permesso si controlla prima di leggere il corpo). Al massimo 500 movimenti e 300 righe
  di richiesta o DDT per richiesta.
- Sessione: cookie `gf_sessione` `HttpOnly; SameSite=Strict; Path=/` (`Secure` con HTTPS); sul server solo l'hash del token.
  Scade dopo 8 ore di inattività e comunque dopo 14 ore.
- Ogni richiesta che modifica (`POST`, `PUT`, `DELETE`) deve avere l'intestazione `X-Richiesta: 1` (protezione CSRF).
- Intestazioni: `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';
  script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self';
  frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. **Niente script in linea**
  nell'HTML e nessun gestore `on…=`: tutti gli eventi si collegano da `js/`.
- Primo avvio: finché non esiste nessun utente, il primo amministratore si crea **solo dal server stesso** (richiesta da
  127.0.0.1 / ::1 e intestazione `Host` uguale a `localhost`, `127.0.0.1` o `[::1]`, contro il DNS rebinding).
- Registro attività (tabella `eventi` di `accessi.db`): accessi (`accesso.entrata` con `dueFattori: 'codice' | 'codice di
  recupero' | 'computer attendibile'`), accessi falliti, `accesso.2fa.*`, uscite e ogni scrittura (`movimenti.*`,
  `articoli.*`, `richieste.*`, `ddt.*`, `magazzini.*`, `armadi.*`, `assortimento.modifica`, `ubicazioni.modifica`,
  `utenti.*`, `sistema.*`…), con utente, ora, indirizzo IP e dettagli. `sistema.cura`, `sistema.controllo` e
  `sistema.linea-nuova` li scrive l'utente "sistema".

## Base dati

### `farmacia.db`, schema 3 (`PRAGMA user_version`)

| Tabella | Colonne (oltre a `rev`, la revisione dell'ultima modifica, usata per la sincronizzazione) |
|---|---|
| `impostazioni` | `chiave`, `valore` (JSON) |
| `meta` | `chiave`, `valore`: `rev`, `rev_base` (linea della storia), `sessione` (avvio che ha aperto il file: solo informativo, la cura non lo usa più), `prog_ric_AAAA`, `prog_ddt_AAAA` (portati avanti da ripristini e cure: un numero già usato non si riassegna) |
| `reparti` (magazzini) | `id`, `nome`, `centrale`, `attivo`, `ordine`; **3.0:** `tipo` (`centrale` \| `periferico` \| `transito`), `piano`, `livello` (−1, 0, 1…), `colore` (`''` o `#rrggbb`), `descrizione` |
| `articoli` | `id`, `nome`, `categoria`, `unita`, `principio`, `confezione`, `codice`, `prezzo`, `scorta_minima`, `note`, `attivo`, `versione`, `barcode` (JSON), `pezzi_confezione`; **3.0:** `attributi` (JSON: `frigo`, `stupefacente`, `alto-rischio`, `lasa`, `urgenza`), `lead_time` (giorni di consegna, NULL = impostazione generale), `fornitore` (fornitore abituale) |
| `movimenti` | `id`, `tipo`, `data`, `articolo_id`, `reparto_id`, `reparto_dest_id`, `quantita`, `lotto`, `scadenza`, `fornitore`, `documento`, `causale`, `note`, `prezzo`, `operatore`, `utente_id`, `creato`, annullo; **3.0:** `ddt_id` |
| `armadi` | `id`, `reparto_id`, `nome`, `tipo` (`armadio` \| `frigorifero` \| `cassettiera` \| `carrello` \| `cassaforte`), `ripiani` (1–12), `colonne` (1–20), `ordine`, `colore`, `note`, `attivo` |
| `assortimento` | `id`, `reparto_id`, `articolo_id` (UNIQUE con il magazzino), `scorta_min`, `punto_riordino`, `scorta_max`, `armadio_id`, `ripiano`, `posizione`, `note`, `attivo` |
| `richieste` | `id`, `numero` (`RIC-AAAA-NNNN`), `anno`, `progressivo`, `reparto_id` (chi chiede), `fornitore_id` (a chi), `stato`, `urgente`, `note`, `creata_da(_nome)`, `creata_il`, `inviata_il`, `presa_da(_nome)`, `presa_il`, `chiusa_il`, `chiusa_da(_nome)`, `motivo` |
| `richieste_righe` | `id`, `richiesta_id`, `articolo_id`, `quantita`, `approvata`, `nota`, `ordine` |
| `ddt` | `id`, `numero` (`DDT-AAAA-NNNN`), `anno`, `progressivo`, `origine_id`, `destinazione_id`, `richiesta_id`, `stato`, `causale`, `colli`, `note`, `preparato_da(_nome)`, `preparato_il`, `trasportatore_id`, `trasportatore_nome`, `partito_il`, `ricevuto_da(_nome)`, `ricevuto_il`, `note_ricezione`, `annullato_il`, `annullato_da`, `motivo_annullo` |
| `ddt_righe` | `id`, `ddt_id`, `articolo_id`, `richiesta_riga_id`, `lotto` (sempre esplicito), `scadenza`, `quantita`, `ricevuta`, `esito` (`''` \| `rientro` \| `perdita`), `nota`, `ordine` |
| `cancellati` | `tabella` (chiave di `App.S`, es. `richiesteRighe`), `id`, `rev` |

Le date-ora sono ISO 8601, le date semplici `AAAA-MM-GG`, le scadenze `AAAA-MM`. I numeri di richieste e DDT sono
progressivi per anno, assegnati dentro la transazione; il numero del DDT è anche il testo del suo codice a barre e del QR.

**Magazzino di sistema "In transito"**: `id = 'r-transito'`, `tipo = 'transito'`, `ordine = 9999`. Esiste sempre, non si
modifica né si elimina (400), non ha armadi né assortimento e non compare negli elenchi (`App.repartiAttivi()` lo esclude);
la sua giacenza è la merce in viaggio. `App.magazzinoTransito()` lo restituisce.

**Aggiornamento automatico** (`aggiornaSchemaDati` in `server/db.js`, all'apertura, anche delle copie che si ripristinano):
1 → 2 codici a barre e pezzi per confezione; 2 → 3 colonne nuove, `tipo` dai vecchi `centrale`, piano e livello dei reparti
predefiniti, magazzino "In transito", tabelle nuove e indici. Una transazione per passo: o tutto o niente.

### `accessi.db`, schema 2

`utenti` (con, dalla 3.0, `totp_segreto` cifrato, `totp_attivo`, `totp_attivato_il`, `totp_ultimo_passo`,
`codici_recupero` (hash), `tentativi_2fa`), `sessioni`, `dispositivi` (computer attendibili), `eventi` (registro attività).

## Formato dei dati (come li vede il client, in `App.S`)

```js
impostazioni = { nomeProdotto, sigla, struttura, sottotitolo, societa, citta, logo /* '' | 'nessuno' | data URL */,
                 coloreAccento /* '' | '#rrggbb' */, tema /* 'automatico'|'chiaro'|'scuro' */, giorniAvvisoScadenza,
                 codiceModulo, leadTimeGiorni, periodoRevisioneGiorni, livelloServizio, storicoGiorni, richiedi2fa }
reparto      = { id, nome, centrale: bool, tipo, piano, livello, colore, descrizione, attivo: bool, ordine }
articolo     = { id, nome, categoria: 'FARMACI'|'PRESIDI', unita, principio, confezione, codice, prezzo, scortaMinima, note,
                 attivo: bool, versione, barcode: [chiavi], pezziConfezione, attributi: [], leadTime: n|null, fornitore }
movimento    = { id, tipo, data, articoloId, repartoId, repartoDestId, quantita, lotto, scadenza: 'AAAA-MM'|'', fornitore,
                 documento, causale, note, prezzo, operatore, utenteId, creato /* ms */, ddtId: id|null,
                 annullato: null | { il /* ISO */, da /* nome */, motivo } }
armadio      = { id, repartoId, nome, tipo, ripiani, colonne, ordine, colore, note, attivo }
assortimento = { id, repartoId, articoloId, scortaMin, puntoRiordino, scortaMax, armadioId, ripiano, posizione, note, attivo }
richiesta    = { id, numero, anno, progressivo, repartoId, fornitoreId, stato, urgente, note, creataDa, creataDaNome, creataIl,
                 inviataIl, presaDa, presaDaNome, presaIl, chiusaIl, chiusaDa, chiusaDaNome, motivo }
richiestaRiga= { id, richiestaId, articoloId, quantita, approvata, nota, ordine }
ddt          = { id, numero, anno, progressivo, origineId, destinazioneId, richiestaId, stato, causale, colli, note,
                 preparatoDa, preparatoDaNome, preparatoIl, trasportatoreId, trasportatoreNome, partitoIl,
                 ricevutoDa, ricevutoDaNome, ricevutoIl, noteRicezione, annullatoIl, annullatoDa, motivoAnnullo }
ddtRiga      = { id, ddtId, articoloId, richiestaRigaId, lotto, scadenza, quantita, ricevuta, esito, nota, ordine }
utente       = { id, username, nome, ruolo, reparti: [id], attivo, cambioPassword, ultimoAccesso,
                 dueFattori: bool, dueFattoriObbligatoria: bool, dueFattoriDaAttivare: bool }
```

`js/calcoli.js` (condiviso con il server) calcola giacenze per magazzino e lotto, ripartizione FEFO, Nota consumi,
avanzamento delle richieste (`Calcoli.avanzamentoRichiesta`: approvato, spedito, in preparazione, residuo per riga) e
disponibilità libera dei lotti (giacenza meno quanto è già in DDT in preparazione). Regole da sapere:

- **Rientri** (DDT annullato in viaggio, differenza "rientra" alla ricezione: `trasferimento` da "In transito" al
  magazzino d'origine, con `ddtId`): non sono un carico. Nella Nota consumi tolgono l'uscita del giorno della partenza se
  è nello stesso mese (un DDT partito e annullato nel mese sparisce dal modulo), altrimenti quella del giorno del rientro
  (la casella può risultare negativa). `Calcoli.partenzeDdt(stato, repartoId)` e `Calcoli.rientroAllOrigine(m, repartoId,
  partenze)` li riconoscono; le usano anche le previsioni e "Proponi dai consumi". Ogni riga della Nota ha `trasferiti`
  (la parte delle caselle dei consumi che non è un consumo registrato).
- **Residuo della richiesta**: la quantità rientrata alla ricezione non conta come spedita e torna nel residuo (si può
  rispedire); la perdita in viaggio resta spedita.
- **Uscite con data passata** (`Calcoli.lottiDisponibili`): da ogni lotto al massimo il minimo fra la giacenza a quella
  data e quella di oggi, così un consumo registrato in ritardo non prende un lotto già uscito dopo.
- **Lotti scaduti** (`Calcoli.scaduto`, `allocaUscita`): la scelta automatica di consumi e trasferimenti li salta finché
  ci sono altri lotti (se restano solo quelli li usa, invece di lasciare un debito "senza lotto"); le perdite
  (`ancheScaduti`) li prendono in ordine di scadenza come gli altri. Un lotto scelto a mano vale anche se scaduto.

## API

Tutte le risposte sono JSON. Errori: stato HTTP 4xx/5xx con `{ "errore": "messaggio in italiano" }` (a volte con campi in
più, indicati sotto). 401 = non autenticato (il client mostra l'accesso), 403 = non permesso, 404, 409 = conflitto (dati
cambiati da un altro utente, stato che non lo permette), 423 = utente bloccato, 429 = troppi tentativi, 400 = dati non validi.
Ogni scrittura risponde con la nuova revisione `rev`, va nel registro attività e avvisa i browser.

### Accesso e verifica in due passaggi

| Metodo e percorso | Corpo | Risposta |
|---|---|---|
| `GET /api/stato` (pubblica) | | `{ inizializzato, daServer, nomeProdotto, sigla, struttura, sottotitolo, logo, coloreAccento, tema, versione, utente\|null, permessi\|null }` |
| `POST /api/setup` (nessun utente, solo dal server) | `{ username, nome, password }` | come `/api/stato`, con la sessione aperta |
| `POST /api/login` | `{ username, password }` | `{ utente, permessi }` + cookie; **oppure** `{ dueFattori: true, sfida }` senza sessione se l'utente ha la 2FA e il computer non è attendibile |
| `POST /api/login/2fa` | `{ sfida, codice \| codiceRecupero, ricorda }` | `{ utente, permessi, codiciRimasti? }` + cookie (e `gf_dispositivo` con `ricorda`). 400 codice sbagliato (`tentativiRimasti`) o già usato (`codiceUsato`), 401 sfida scaduta (`sfidaScaduta`: 5 minuti, stesso IP, una volta sola, al massimo 10 codici sbagliati), 429 blocco (dalla rete) o attesa (`attesaSecondi`, dal server stesso) |
| `POST /api/logout` | | `{ ok: true }` |
| `POST /api/password` | `{ attuale, nuova }` | `{ ok: true, utente }`; chiude le altre sessioni |
| `GET /api/2fa` | | `{ attiva, attivataIl, obbligatoria, daAttivare, criterio, codiciRimasti, dispositivi, giorniDispositivo, oraServer }` |
| `POST /api/2fa/inizia` | `{ password? }` (obbligatoria se la 2FA è già attiva: cambio di telefono) | `{ segretoBase32, chiave, uri /* otpauth:// */, emittente /* nomeProdotto */, utente, cambio, oraServer }`; la chiave resta in memoria un'ora finché non si conferma (un "Cambia telefono" non spegne quella attiva) e vale solo per questa sessione. Cambio di telefono senza password: 400 `servePassword` (non conta come errore); password sbagliata: 400, alla quinta 401 e sessione chiusa |
| `POST /api/2fa/conferma` | `{ codice }` | `{ codiciRecupero: [10], utente }`; chiude le altre sessioni dell'utente; 409 `ricomincia` se la chiave è scaduta, se è stata chiesta da un'altra sessione o dopo 10 codici sbagliati (anche `servePassword` se la 2FA è stata attivata dopo aver chiesto la chiave senza password) |
| `POST /api/2fa/disattiva` | `{ password, codice }` | `{ utente }`; 409 se il criterio la richiede |
| `POST /api/2fa/codici` | `{ password }` | `{ codiciRecupero }` (i vecchi non valgono più) |
| `DELETE /api/2fa/dispositivi` | | `{ ok, tolti }` e toglie il cookie |
| `GET /api/sicurezza` (permesso `sicurezza`) | | `{ richiedi2fa, criteri, utenti: [{ id, username, nome, ruolo, attivo, dueFattori, attivataIl, obbligatoria, daAttivare, codiciRimasti, dispositivi, ultimoAccesso, bloccato }], oraServer }` |
| `PUT /api/sicurezza` (permesso `sicurezza`) | `{ richiedi2fa }` | come GET più `{ rev, daAttivare }`; 400 criterio non valido; 409 `attivaPrima` se il criterio riguarda anche l'amministratore che lo cambia e lui non ha la 2FA |
| `POST /api/utenti/:id/2fa/azzera` (permesso `sicurezza`) | | `{ utente }`; toglie segreto, codici e computer, chiude le sue sessioni |

### Dati e aggiornamenti

| Metodo e percorso | Note |
|---|---|
| `GET /api/dati?da=<rev>&storia=<s>` | Ciò che è cambiato dopo la revisione `da` (0 = tutto): `{ rev, storia, completo, impostazioni?, reparti, articoli, movimenti, armadi, assortimento, richieste, richiesteRighe, ddt, ddtRighe, cancellati: [{ tabella, id }] }` (`tabella` = chiave di `App.S`). Ogni riga modificata ricompare intera. Con `completo: true` (prima richiesta, `storia` diversa: nuovo avvio, ripristino, cura) il client sostituisce il suo stato invece di unirlo (`Api.TABELLE` in `js/api.js`). |
| `GET /api/eventi` | Server-Sent Events: `event: rev` con `data: {"rev": N}` a ogni modifica; `event: permessi` quando l'amministratore cambia ruolo o magazzini di quell'utente (anche eliminando un magazzino) o dopo un ripristino; commento `: ping` ogni 25 s. Le schede nascoste chiudono le notifiche e controllano ogni 20 s. |

### Movimenti e anagrafica (come nella 2.x, con i DDT)

| Metodo e percorso | Corpo | Note |
|---|---|---|
| `POST /api/movimenti` | `{ movimenti: [ { tipo, data, articoloId, repartoId, repartoDestId?, quantita, lotto?, scadenza?, fornitore?, documento?, causale?, note?, prezzo?, teorica? } ] }` | Tutti nella stessa transazione (massimo 500). `consumo`, `perdita`, `trasferimento` si ripartiscono sui lotti (FEFO, prima il `lotto` indicato; 409 se non c'è più, anche alla data indicata). La scelta automatica salta i lotti scaduti tranne per le perdite; con una data passata si prende da ogni lotto al massimo il minimo fra la giacenza a quella data e quella di oggi. `rettifica` ha la quantità con segno e `teorica` (409 se la giacenza è cambiata). Un `carico` con `prezzo` aggiorna il prezzo dell'articolo. "In transito" non si usa qui (400). `{ rev, movimenti }` |
| `POST /api/movimenti/:id/annulla` | `{ motivo }` | `{ rev }`; 409 per i movimenti con `ddtId` (si annulla il DDT) |
| `POST /api/consumo-giorno` | `{ articoloId, repartoId, data, quantita, prima }` | Correzione dalla Nota consumi; 409 se `prima` non è più il consumo registrato. `{ rev }` |
| `POST /api/articoli`, `PUT /api/articoli/:id`, `DELETE /api/articoli/:id` | articolo (`versione` in PUT); 3.0: `attributi` (fra `frigo`, `stupefacente`, `alto-rischio`, `lasa`, `urgenza`, senza doppioni), `leadTime` (giorni interi 0–365, `null` = impostazione generale), `fornitore` (fino a 200 caratteri) | 409 nome doppio o `versione` superata; 400 caratteristica o giorni non validi. Chi non manda i campi nuovi (client vecchi, importazioni) non li cancella. DELETE: 409 se l'articolo ha movimenti, se compare in richieste o DDT, o se è nell'assortimento attivo di un magazzino (con il nome del magazzino); le righe di assortimento non attive si cancellano con lui |
| `POST /api/articoli/importa` | `{ articoli: [...], repartoId, data, conGiacenza, origine }` | `{ rev, nuovi, carichi, saltati }` |
| `POST /api/articoli/:id/barcode` | `{ chiave }` | permesso `articoli`; `{ rev, articolo }` (vedi [Codici a barre](#codici-a-barre)) |

### Logistica: richieste e DDT (`server/logistica.js`)

Permessi: `RICHIESTE` = `richieste` e magazzino che chiede scrivibile; `EVADI` = `evadiRichieste` e magazzino a cui si
chiede scrivibile; `DDT` = `ddt` e magazzino di partenza scrivibile; `RICEVI` = `riceviDdt` e magazzino di arrivo
scrivibile. Le richieste rispondono `{ rev, richiesta, righe }`, i DDT `{ rev, ddt, righe }`.

| Metodo e percorso | Corpo | Note |
|---|---|---|
| `POST /api/richieste` | `{ repartoId, fornitoreId?, urgente, note, invia, righe: [{ articoloId, quantita, nota? }] }` | `fornitoreId` predefinito = farmacia centrale; stato `bozza`, o `inviata` con `invia: true`. Lo stesso articolo due volte diventa una riga. Almeno una riga; articoli attivi |
| `PUT /api/richieste/:id` | `{ righe?, note?, urgente? }` (righe con `id` per tenerle) | solo `bozza` o `inviata` (409 se la farmacia l'ha già presa in carico) |
| `POST /api/richieste/:id/invia` | | `bozza` → `inviata` |
| `POST /api/richieste/:id/annulla` | `{ motivo? }` | da `bozza` o `inviata` → `annullata` |
| `POST /api/richieste/:id/prendi` | | `inviata` → `in_lavorazione`; `approvata` = `quantita` per le righe senza approvazione; 409 se presa da un altro |
| `POST /api/richieste/:id/approva` | `{ righe: [{ id, approvata, prima? }] }` | prende in carico se serve; 409 se si approva meno di quanto è già in DDT o spedito; può portare a `evasa`. `prima` è l'approvata che la pagina mostrava (`null` = non ancora approvata): se nel frattempo un altro l'ha cambiata, 409 «Nel frattempo X ha cambiato la quantità approvata di …» e la pagina si ricarica. Senza `prima` nessun controllo (client vecchi) |
| `POST /api/richieste/:id/rifiuta` | `{ motivo }` (obbligatorio) | → `rifiutata`; 409 se ha già DDT non annullati (si chiude con residuo) |
| `POST /api/richieste/:id/chiudi` | `{ motivo? }` | → `chiusa` (con residuo); 409 se un suo DDT è ancora in preparazione |
| `POST /api/richieste/:id/ddt` | `{ righe?: [{ rigaId, quantita }], causale?, colli?, note? }` | DDT `in_preparazione` dal residuo approvato (o dalle quantità indicate, 0 = non in questo DDT), ripartito sui lotti liberi FEFO **non scaduti**. Se la merce non basta prepara quello che c'è: risposta con in più `mancanti: [{ articoloId, articolo, richiesta, preparata, scaduti? }]` e `richiesta`; 409 se non c'è niente da preparare (con «C'è merce solo in lotti scaduti…» se è così) |
| `POST /api/ddt` | `{ origineId, destinazioneId, causale?, colli? (1–999), note?, righe: [{ articoloId, quantita, lotto?, nota? }] }` | DDT senza richiesta (pagina Trasferimenti, resi). 409 con l'elenco se la merce libera non basta («altri N sono in lotti scaduti…» quando è così). La scelta automatica non spedisce mai lotti scaduti; un lotto scaduto scelto a mano nella riga sì (per un reso) |
| `PUT /api/ddt/:id` | `{ righe?, causale?, colli?, note? }` | solo `in_preparazione`; le righe collegate a una richiesta non superano il residuo approvato |
| `POST /api/ddt/:id/spedisci` | `{ trasportatoreId \| trasportatoreNome, colli? }` | `in_preparazione` → `in_transito`: ricontrolla le giacenze per lotto (409 se nel frattempo non bastano) e scrive per ogni riga un `trasferimento` origine → `r-transito` (`ddtId`, `documento` = numero); la richiesta collegata può diventare `evasa` |
| `POST /api/ddt/:id/ricevi` | `{ righe?: [{ id, ricevuta, esito: 'rientro'\|'perdita', nota? }], note? }` | `in_transito` → `ricevuto` o `ricevuto_con_differenze`. Righe non indicate = ricevute per intero. Ricevuto: `trasferimento` `r-transito` → destinazione; differenza: `trasferimento` `r-transito` → origine (`rientro`) o `perdita` su `r-transito` con causale "Differenza alla ricezione DDT …". 400 se si riceve più del partito o manca l'esito di una differenza. Se il DDT nasce da una richiesta ne aggiorna lo stato: con merce rientrata un'`evasa` torna `in_lavorazione` (il rientrato torna nel residuo); il passaggio va nel registro attività (`richiesta` nei dettagli di `ddt.ricevi`) |
| `POST /api/ddt/:id/annulla` | `{ motivo? }` | da `in_preparazione` (niente da fare) o `in_transito` (tutto rientra all'origine) → `annullato`; 409 se già ricevuto (si fa un DDT di reso) |
| `GET /api/trasportatori` | | permesso `ddt`: `{ utenti: [{ id, nome }] }` (utenti attivi; solo nome e id, non il ruolo) |

**Stati.** Richiesta: `bozza` → `inviata` → `in_lavorazione` → `evasa` | `chiusa` | `rifiutata`; `annullata` (da bozza o
inviata). La quantità spedita di una riga è la somma delle righe dei DDT collegati non annullati e partiti; quando tutto
l'approvato è partito la richiesta diventa `evasa` (torna `in_lavorazione` se un DDT in viaggio si annulla o se alla
ricezione una parte rientra all'origine: il rientrato non conta come spedito).
DDT: `in_preparazione` → `in_transito` → `ricevuto` | `ricevuto_con_differenze`; `annullato`.
Nella Nota consumi e nell'Excel il magazzino d'origine vede l'uscita alla data di partenza e il destinatario l'entrata alla
data di ricezione, come trasferimenti dal/verso il magazzino vero (non "In transito"). La merce che rientra all'origine
non è un carico: toglie l'uscita (vedi le regole di `js/calcoli.js` sopra).

### Struttura: magazzini, armadi, assortimento, ubicazioni (`server/struttura.js`)

| Metodo e percorso | Corpo | Note |
|---|---|---|
| `POST /api/magazzini` (permesso `struttura`) | `{ nome, tipo: 'centrale'\|'periferico', piano, livello, colore, descrizione, attivo, ordine }` | `{ rev, magazzino }`; nome già usato 409; senza piano lo ricava dal livello |
| `PUT /api/magazzini/:id` | stessi campi (quelli assenti restano) | `{ rev, magazzino }`. Un solo centrale: sceglierne un altro rende periferico il vecchio; la centrale non si toglie né si disattiva (400); non si disattiva un magazzino con DDT da spedire o in viaggio o richieste aperte (409) |
| `DELETE /api/magazzini/:id` | | `{ rev }`; solo se mai usato (movimenti, richieste, DDT), altrimenti 409 con l'invito a togliere «Attivo». Armadi e assortimento si cancellano con lui; gli utenti assegnati lo perdono. "In transito": 400 |
| `POST /api/armadi`, `PUT /api/armadi/:id`, `DELETE /api/armadi/:id` (permesso `struttura`) | `{ repartoId, nome, tipo, ripiani 1–12, colonne 1–20, ordine, colore, note, attivo }` | `{ rev, armadio, liberati }`: se l'armadio diventa più piccolo o si elimina, le caselle fuori misura tornano libere. 409 se si sposta in un altro magazzino con articoli dentro |
| `PUT /api/assortimento` (permesso `assortimento`) | `{ repartoId, righe: [{ articoloId, scortaMin, puntoRiordino, scortaMax, note, attivo }] }` | `{ rev, nuove, modificate, tolte }`; minima ≤ riordino ≤ massima; `attivo: false` toglie conservando le soglie e libera la casella; articoli non attivi 400 |
| `PUT /api/ubicazioni` (permesso `ubicazioni`, magazzino scrivibile) | `{ repartoId, righe: [{ articoloId, armadioId\|null, ripiano, posizione }] }` | `{ rev, spostate, aggiunte }`; una casella = un articolo (409 se occupata), scambi in una sola richiesta permessi; un articolo fuori assortimento entra con scorte a 0 |

"Sotto scorta" in tutto il programma = scorta minima dell'assortimento del magazzino; nella farmacia centrale, se
l'assortimento non ha soglie per l'articolo, la scorta minima dell'anagrafica (`App.scortaMinima`, `App.sottoScorta`).

### Sistema: salute della base dati e copie (`server/salute.js`, permesso `sistema`)

| Metodo e percorso | Corpo | Risposta |
|---|---|---|
| `GET /api/sistema` | | `{ versione, avvio, adesso, cartella, file: { farmacia: { dimensione, wal }, accessi }, revisione, base, conteggi, controllo: { ultimo, ultimoCompleto, prossimoNotturno }, controlli[], cure[], copie[{ nome, prefisso, tipo, data, dimensione, verificata, rev, base, conteggi, seconda }], copieRiassunto, giornale: { cartella, file, dimensione, dal, ultimaRevisione, ultimaScrittura, errore }, disco: { libero, totale }, secondaCartella: { percorso, origine, raggiungibile, ultimaSincronizzazione, errore }, secondaDaConfigurazione, provaRipristino, crescita[], stato: 'ok'\|'attenzione'\|'problema', motivi: [{ livello, testo }] }` |
| `POST /api/sistema/controlla` | | `{ controllo, sistema }` (controllo completo adesso) |
| `POST /api/sistema/copia` | | `{ copie, sistema }` (copia verificata di magazzino e utenti). Con la seconda cartella risponde quando le copie sono arrivate anche lì, al massimo dopo 20 s (poi `sistema.secondaCartella` dice se si sta ancora aggiornando) |
| `POST /api/sistema/prova-ripristino` | | `{ prova: { esito: 'ok'\|'differenze', copia, riapplicate, revRicostruita, revAttuale, tabelle: [{ tabella, attuale, ricostruita, uguale }], messaggi, avvisi }, sistema }`; 409 senza copie verificate |
| `PUT /api/sistema/seconda-cartella` | `{ percorso }` (`''` = nessuna) | `{ seconda, sistema }`; 400 percorso non valido o dentro la cartella dati; 409 se è in `configurazione.json` |

`stato` è il semaforo della pagina: `ok` verde "Tutto in ordine", `attenzione` giallo "Da guardare", `problema` rosso
"Serve attenzione"; `motivi` dice perché, in italiano semplice.

### Amministrazione

| Metodo e percorso | Permesso | Note |
|---|---|---|
| `PUT /api/impostazioni` | `impostazioni` | campi di `impostazioni` (marchio, tema, previsioni…); `richiedi2fa` si cambia con `PUT /api/sicurezza` |
| `PUT /api/reparti`, `DELETE /api/reparti/:id` | `impostazioni` | interfaccia della 2.x, ancora accettata (la 3.0 usa `/api/magazzini`) con le **regole della 3.0** sullo stato finale di tutti i magazzini, anche quelli fuori elenco: una sola farmacia centrale (indicarne un'altra declassa quella di prima a periferica), mai tolta né disattivata (400); non si disattiva un magazzino con DDT da spedire o in viaggio o richieste aperte (409, stesso messaggio di `/api/magazzini`); nomi doppi controllati anche contro i magazzini fuori elenco; "In transito" resta com'è. DELETE: la farmacia centrale e "In transito" 400; 409 con movimenti, richieste, DDT, armadi o assortimento |
| `GET /api/utenti` | `utenti` | `{ utenti: [] }` |
| `POST /api/utenti` | `utenti` | `{ username, nome, ruolo, reparti, password }` (cambio password al primo accesso) |
| `PUT /api/utenti/:id` | `utenti` | `{ nome, ruolo, reparti, attivo }`; disattivare chiude le sue sessioni; resta sempre un amministratore attivo; un cambio può far scattare l'obbligo della 2FA |
| `POST /api/utenti/:id/password` | `utenti` | `{ nuova }`: password provvisoria, sblocca l'utente |
| `GET /api/attivita?dal=&al=&utente=&azione=&limite=` | `attivita` | `{ eventi: [{ id, quando, username, azione, dettagli, ip }] }`; `azione` è un inizio di codice (es. `ddt.`) |
| `GET /api/backup` | `backup` | `{ backup: [{ nome, dimensione, data, verificata, rev, base }] }` (solo le copie del magazzino) |
| `POST /api/backup` | `backup` | copia verificata adesso |
| `GET /api/backup/:nome` | `backup` | scarica il file `.db` |
| `POST /api/backup/:nome/ripristina` | `backup` | prima salva lo stato attuale ("prima del ripristino"), poi ripristina; la revisione riparte sopra il giornale (`rev_base`), riga `ripristino` nel giornale, copia verificata subito |
| `POST /api/importa-archivio` | `impostazioni` | archivio `.json` della versione monoutente; solo con l'archivio vuoto |
| `POST /api/demo` | `impostazioni` | dati di prova; solo con l'archivio vuoto |

## Base dati che si cura da sola

- **Giornale** (`server/giornale.js`), la fonte di verità: dopo ogni `Database.scrivi`
  (`database.dopoScrittura(fn({ rev }))`) una riga `{ rev, base, storia, quando, evento, cambiamenti }` in
  `giornale/AAAA-MM-GG.jsonl`, con `fsync`. `cambiamenti` ha la forma di `/api/dati` ma solo con le righe di quella
  revisione (lette per `rev = R`) e le tabelle toccate, cancellazioni e impostazioni comprese. `evento` è l'ultimo numero
  del registro attività in quel momento (l'evento della scrittura viene subito dopo): serve a confrontare giornale e
  registro. Righe di segnalazione senza cambiamenti `{ tipo: 'ripristino' | 'nuova-linea' | 'avvio' | 'chiusura' }`,
  con `durevole: true` quando sono scritte dopo un checkpoint completo (`Database.fissaSulDisco`): a quella revisione il
  magazzino era tutto nel file principale. Una riga rimasta a metà da uno spegnimento si chiude prima di scrivere la
  successiva. `catena()` dà le righe da riapplicare senza buchi e della stessa linea (`base`). Si conserva fino alla copia
  più vecchia conservata, con 2 giorni di margine.
- **Copie** (`server/backup.js`): `VACUUM INTO`, poi la copia si riapre in sola lettura, `integrity_check`, tabelle attese,
  conteggi e revisione; esito nella scheda `<copia>.json`. Automatiche orarie (solo se è cambiato qualcosa, comunque una al
  giorno), finale alla chiusura, dopo ogni cura e ripristino. Conservazione a scaglioni delle automatiche (`daConservare`):
  tutte nelle ultime 24 ore, giornaliere 14, settimanali ISO 8, mensili 12; sempre l'ultima verificata; manuali e "prima
  del ripristino" le ultime 30. Le copie della 2.x si verificano una ogni 5 minuti. Le copie di `accessi.db` nella cartella
  dati portano con sé `chiave-2fa.key`.
- **Seconda cartella**: sincronizzazione in sottofondo (limite 60 s) delle copie verificate che mancano, delle schede e del
  giornale, mai della chiave; scaglioni anche lì, ma le cancellazioni della cartella dati non si copiano. Una richiesta
  che arriva durante un giro ne mette in coda un altro (uno solo), e chi aspetta (`POST /api/sistema/copia`, al massimo
  20 s) aspetta anche quello. Il giornale nuovo ci va anche fra una copia e l'altra: nel giro dei 5 minuti, se il
  giornale è andato avanti dall'ultima sincronizzazione (se il disco del server si rompe, mancano al massimo 5 minuti di
  lavoro). Non raggiungibile = avviso (giallo), non errore.
- **Cura** (`server/salute.js`): all'avvio, prima di aprire il database, `quick_check`; un file danneggiato va in
  `danneggiati/` e si preparano fino a tre ricostruzioni, tenendo quella che arriva più avanti (a parità copia + giornale):
  1) recupero dal file stesso (`VACUUM INTO`) + giornale; 2) copia valida più recente (cartella dati, poi seconda cartella)
  + giornale; 3) archivio vuoto + tutto il giornale. La riapplicazione usa le conversioni inverse oggetto → riga
  (`rigaDaOggetto`) con `INSERT OR REPLACE` e i vincoli sospesi. Poi `integrity_check`, evento `sistema.cura`, log e copia.
  `farmacia.db` sparito o vuoto non è un'installazione nuova se ci sono copie **o il giornale** (anche solo nella seconda
  cartella): si ricostruisce (senza copie: archivio vuoto + tutto il giornale). `accessi.db`: recupero dal file,
  altrimenti ultima copia valida, altrimenti archivio nuovo (si ricrea l'amministratore). `metodo` della cura: `recupero`,
  `copia`, `giornale`, `vuoto`, `nuovo` (accessi), `coda`, `linea-nuova`; `esito`: `curato`, `curato-con-perdite`,
  `ricreato`.
- **Spegnimento improvviso** (`recuperaCoda`, in `salute.collega()`): il file è integro ma più indietro del giornale
  sulla stessa linea. La coda si cerca **sempre** nel giornale, non nel WAL (che può essere sparito, vuoto dopo il
  checkpoint o con la testata rovinata), e le voci mancanti si riapplicano senza buchi (cura `metodo: 'coda'`), **a meno
  che** il giornale abbia una segnalazione durevole (`avvio`, `chiusura`, `ripristino`, `nuova-linea`) più avanti della
  revisione del file: allora il file è stato rimesso a mano da una copia vecchia (o il disco ha perso dati già al sicuro)
  e non si riporta avanti. `meta.sessione` non conta più.
- **Linea nuova "con perdite"** (`allineaLinea`): se il magazzino resta più indietro del giornale e la coda non si può
  riapplicare, riparte da una revisione nuova sopra l'ultima del giornale (i browser ricaricano tutto) con una cura
  `metodo: 'linea-nuova'`, `esito: 'curato-con-perdite'`, semaforo rosso: `perse` (quante modifiche del giornale il file
  non ha) e `riassunto` ("2 articoli, 2 DDT…"). Evento `sistema.linea-nuova`.
- **Numeri di richieste e DDT**: `Backup.ripristina` porta con sé i contatori `prog_ric_AAAA`/`prog_ddt_AAAA` (il più alto
  fra `meta` e il numero più alto nel file); la linea nuova li alza al numero più alto trovato nelle voci del giornale
  che il file non ha. Un numero già usato (e magari stampato su un DDT partito) non si riassegna.
- **Confronto con il registro attività** (`verificaRegistro`): dopo una cura o una coda riapplicata si contano le
  scritture del magazzino nel registro attività dopo l'ultima voce del giornale (saltando l'evento di quella voce); se ce
  ne sono, nessuna cura le può recuperare: la cura diventa `curato-con-perdite` (`scrittureSenzaGiornale`) e le elenca.
  Si confronta anche l'ultima revisione vista dal programma acceso (`salute.json`, `ultimaVista`, ogni 5 minuti e
  all'arresto). Il riassunto "Controllo della base dati all'avvio" si scrive dopo questo confronto. La cura a programma
  acceso si rifiuta se il registro ha scritture che il giornale non ha, e chiede di riavviare.
- **A programma acceso**: controllo completo notturno con `integrity_check`, `PRAGMA optimize`, `wal_checkpoint(TRUNCATE)`;
  un magazzino danneggiato si sostituisce subito solo se copia + giornale arrivano all'ultima revisione, altrimenti il
  semaforo è rosso con "riavvia il servizio".
- **Prova di ripristino**: ricostruisce in una cartella temporanea dentro la cartella dati e confronta tabella per tabella
  righe, somma delle revisioni, quantità o prezzi, impronta delle coppie id+rev.

## Previsioni (`js/previsioni.js`, solo nel browser)

Modulo UMD condiviso fra le pagine e le prove (`tests/previsioni.test.js`); nessuna rotta del server.

- `serie(stato, articoloId, reparti, opz)`: consumi giornalieri (consumo + perdita, esclusi gli annullati; i trasferimenti
  non sono consumo) con i giorni a zero. La storia finisce ieri, la previsione comincia oggi. `reparti`: `null` = tutta la
  struttura, un id o un elenco.
- `MODELLI`, `stima(valori, opz)`: media mobile, livellamento esponenziale semplice, Holt smorzato, Holt-Winters additivo
  settimanale (con tendenza smorzata, se ≥ 4 settimane), Croston-SBA (domanda intermittente). Scelta per retro-verifica
  sulle ultime 4 settimane: errore = MAE giornaliero + MAE delle somme di 7 giorni; a parità entro il 2% vince il più
  semplice; poi il modello si riadatta a tutta la storia. Fascia al 90% dai residui, più larga con l'orizzonte.
- **Giorni anomali** (`limitaAnomali`): un giorno isolato (i giorni accanto sono normali) sopra la soglia
  `max(m + 5·s, 3·m)` (m = mediana dei giorni con consumo, s = il più grande fra 1,4826 × MAD e min(√m, m)) si conta
  come la soglia per i modelli e per σ; al massimo l'1% dei giorni con consumo (almeno 1), servono almeno 5 giorni con
  consumo. Più
  giorni alti di fila sono un cambio vero e non si toccano. La serie vera resta per grafico, medie, tendenza, XYZ e totali;
  `stima().anomali` dice quali giorni sono stati limitati (nota «Un giorno insolito…» nel dettaglio).
- **σ robusta** (`sigmaRobusta`): i residui oltre `max(4 · scarto tipico, 2 · il residuo dopo l'1% più grande)` contano
  come il limite: si limitano solo pochi residui staccati dagli altri (le "scatole grandi ogni tanto" restano coperte).
  `stima(…, { anomali: false })` fa i conti come prima (nessun limite, σ semplice).
- `analizza(stato, opz)`: per ogni articolo dell'ambito consumo medio giornaliero/settimanale/mensile, tendenza, copertura
  (giorni), data di esaurimento, scorta di sicurezza `z · σ · √LT`, punto di riordino `domanda(LT) + SS`, quantità da
  ordinare `domanda(LT + R) + SS − disponibile` arrotondata alle confezioni (`pezziConfezione`), ABC (80/15/5 sul valore)
  e XYZ (variabilità dei consumi settimanali). LT = `articolo.leadTime` o `leadTimeGiorni`; R = `periodoRevisioneGiorni`;
  z dal `livelloServizio`. Fornitore = `articolo.fornitore` o quello dell'ultimo carico.
- **Disponibile** = giacenza + in viaggio + `giaChiesto`. Il "già chiesto" (magazzini periferici) è residuo + in
  preparazione delle richieste aperte (bozza, inviata, in lavorazione) dei magazzini dell'ambito a un fornitore fuori
  dall'ambito, con `Calcoli.avanzamentoRichiesta`: gli stessi numeri della proposta della pagina Richieste ("📝 N già
  chiesti", colonna "Già chiesto" nell'Excel). Per tutta la struttura vale 0.
- `consumoGiornaliero`, `consumoMedio` (per "Proponi le quantità" delle richieste e "Proponi dai consumi"
  dell'assortimento), `distribuzione(stato, opz)` (pagina Distribuzione: dato, consumato, perso, reso, in viaggio per
  magazzino e mese). Per la farmacia centrale `consumoMedio` conta anche quello che dà agli altri magazzini (alla
  partenza) meno i **rientri** all'origine (DDT annullato in viaggio, differenza "rientra"), tolti nel giorno della
  partenza: un DDT annullato non conta. "Proponi dai consumi" (`js/pagine-struttura.js`) usa `consumoMedio`; senza il
  modulo delle previsioni fa lo stesso conto da sola (`StrutturaMagazzini.consumiMediDaMovimenti`, con
  `Calcoli.partenzeDdt` e `Calcoli.rientroAllOrigine`).
- La proposta d'ordine è sempre su tutta la struttura (giacenze ovunque + in viaggio); `js/excel-ordini.js` la esporta, un
  foglio per fornitore. I calcoli si ricordano finché `Api.rev` non cambia.

## Interfaccia

- JavaScript puro, ES5 nel browser, nessun modulo né framework; `index.html` carica tutti i file in ordine. Ogni pagina è
  `App.pagine.<id>(contenitore, parametri)`; i file della 3.0 (`js/pagine-*.js`, `js/sicurezza.js`, `js/guide.js`)
  assegnano le loro pagine dopo `js/pagine.js`. `App.MENU` elenca voci, icone, tasti rapidi, permessi e contatori
  (`App.registraContatore`).
- **Tema e aspetto** (`js/app.js`, `css/app.css`): colori NefroCenter come variabili CSS (`--primario`, `--superficie`,
  `--linea`, `--accento`, `--grafico-1…8`, `--durata`, `--curva`…), ridefinite per il tema scuro sotto
  `html[data-tema="scuro"]`. Il tema scelto dall'utente sta in `localStorage` `gf-tema` (`chiaro` | `scuro` |
  `automatico`); senza scelta vale l'impostazione `tema`; `automatico` segue `prefers-color-scheme`. `coloreAccento`
  ridefinisce `--accento`, `--accento-pieno`, `--accento-chiaro`. Al cambio di tema `Grafici.ritema()` ridisegna i grafici.
- **Marchio**: logo `''` = `brand/marchio.png` nel menu (`App.MARCHIO`) e `brand/logo.png` nella schermata di accesso;
  `'nessuno'` = nessun logo; altrimenti il data URL caricato (sotto i 400 KB). `App.htmlMarchio` disegna il marchio del
  menu (anche nell'anteprima di Configura). Titolo della finestra: `pagina · nomeProdotto · struttura`.
- **Grafici** solo attraverso `js/grafici.js` (`Grafici.crea(el, opzioni)`: ridimensionamento, tema e distruzione al cambio
  pagina automatici) su ECharts; **animazioni** solo attraverso `js/motion.js` (`Motion.entra`, `Motion.conta`,
  `Motion.evidenzia`, `Motion.ridotto()`) su anime.js. Con `prefers-reduced-motion` niente animazioni, solo cambi di stato.
- Caratteri locali in `fonts/` (Manrope, Inter, JetBrains Mono, OFL); i nuovi CSS usano solo variabili.

## Codici a barre

### Articoli
`articolo.barcode`: chiavi normalizzate (`aic:012345676`, `gtin:08012345678907`, `cod:INTERNO77`; al massimo 50); una
chiave appartiene a **un solo articolo** (unicità controllata nella transazione con `json_each(articoli.barcode)`).
`articolo.pezziConfezione`: unità in una confezione letta (> 0, predefinito 1). `POST /api/articoli/:id/barcode`
`{ chiave }` aggiunge un codice letto: idempotente se è già suo, 409 se è di un altro articolo, 400 se non valido.

### Analisi dei codici (`js/barcode.js`, condiviso con il server)
`Barcode.analizza(testo)` → `{ grezzo, tipo: 'gs1'|'aic'|'ean'|'altro', chiavi, gtin, aic, lotto, scadenza: 'AAAA-MM'|'', seriale }`.

- Toglie il prefisso AIM (`]d2`, `]C1`, `]E0`, `]Q3`, `]e0`…) e un GS iniziale (FNC1).
- **GS1** (Data Matrix dei farmaci, UDI, GS1-128): AI `01` GTIN, `17` scadenza AAMMGG (giorno `00` = fine mese), `10` lotto,
  `21` seriale; gli altri AI noti si leggono e si ignorano. Con il separatore GS (`\x1D`, `<GS>`/`{GS}`), con le parentesi,
  o senza separatori quando i campi variabili sono in fondo. Chiave `gtin:`; con l'AI `716` (AIC) anche `aic:`.
- **AIC (Code 32)**: `A` + 9 cifre, 9 cifre, o le 6 lettere/cifre in base 32 di un lettore impostato su Code 39; cifra di
  controllo obbligatoria. Chiave `aic:`.
- **EAN-13, EAN-8, UPC-A, GTIN-14** con cifra di controllo valida → `gtin:` + 14 cifre.
- Tutto il resto: `tipo: 'altro'`, chiave `cod:` + testo maiuscolo (massimo 60). Un numero di DDT letto
  (`DDT-AAAA-NNNN`, codice Code 128 o QR stampato sul DDT) nella pagina DDT e consegne apre il DDT.

`Barcode.descrivi(chiave)` dà il testo da mostrare (`AIC 012345676`, `EAN 8012345678907`, `INTERNO77`).

### Lettore (`js/scanner.js`, `window.Scanner`)
- **Lettori USB/Bluetooth** (emulazione tastiera): un ascoltatore `keydown` sulla finestra (fase di cattura) riconosce le
  raffiche (almeno 4 caratteri, nessun intervallo oltre 60 ms, media ≤ 35 ms, chiuse da Invio o Tab entro 150 ms). Nei
  campi di testo il campo torna al valore di prima della raffica; fuori dai campi i tasti si trattengono finché non si
  capisce se è una lettura. Campi password, `repeat` e composizione (IME) non si considerano mai. Per le prove automatiche:
  `keyboard.type(testo)` senza `delay` seguito da Invio è una lettura; per scrivere come una persona `fill()` o `delay` ≥ 60 ms.
- **Barra di lettura**: `Scanner.barra({ pagina, predefinito })` → `.barra-scanner` con `#scanner-campo`, `#scanner-modo`
  (`unita` | `confezione`, ricordato in `localStorage` `gf-scanner-modo:<pagina>`), `#scanner-fotocamera` (solo con
  `BarcodeDetector` in un contesto sicuro: HTTPS). Pagine con la barra: Carico, Consumi, Perdite, Inventario, nuova
  richiesta, Trasferimenti, modifica e ricezione del DDT.
- **Instradamento** (`Scanner.elabora`): finestra che sta leggendo (`Scanner.cattura`), ricerca rapida, finestra aperta da
  una lettura, poi `App.gestoreScansione(info, articolo, passo)` della pagina (Armadi: dove si trova; DDT e consegne: apre il
  DDT), altrimenti la scheda dell'articolo; codice sconosciuto → finestra "Codice non riconosciuto".
- **Fotocamera** (`Scanner.apriFotocamera`): `data_matrix`, `ean_13`, `ean_8`, `code_39`, `code_128`, `upc_a`, `qr_code`;
  "Lettura continua"; si spegne alla chiusura, con Esc, al cambio di pagina e con la scheda nascosta.

## Guidami, guide scritte e videoguide

- `js/tour.js` (`window.Tour`): giri guidati sulla pagina, uno o più per pagina (`perPagina`), con i selettori veri delle
  pagine; il pulsante `#guidami` avvia il giro della pagina aperta. Il giro non scrive dati e non preme pulsanti, chiede
  conferma prima di cambiare pagina con righe non registrate, si chiude da solo al cambio pagina o alla scadenza della
  sessione. `Tour.elenco()` dà i giri permessi all'utente. `strumenti/prova-tour.js` li percorre tutti per ogni ruolo, su
  computer e telefono, e controlla che non parta nessuna scrittura.
- `js/guide.js` (`window.Guide`): sostituisce la pagina Guida. `Guide.ELENCO` ha 26 guide, ognuna con
  `{ id, ico, titolo, descrizione, gruppo, permesso, perChi, giro, pagina, dove, aChi, quando, passi, dopo, errori,
  approfondimenti }`; nei testi `«…»` è il nome esatto di un pulsante, campo o pagina (in grassetto nella guida scritta).
  `Guide.GRUPPI` sono gli argomenti del filtro. La pagina ha ricerca in tutto il testo, filtro per argomento e "Solo quelle
  che mi servono" (`localStorage` `gf-guide-solo-mie`), le schede e, sotto, le "Istruzioni generali" prese dalla pagina
  Guida di `js/pagine.js`. `Guide.apriScritta(id)` apre la guida completa con "🧭 Guidami sulla pagina" (i giri permessi) e
  "Apri <pagina>"; `Guide.apriVideo(id)` il video con i passi cliccabili. `App.vai('guida', { guida: id, scritta? })` apre
  una guida.
- I video stanno in `guide/<id>.mp4|jpg|vtt` (incorporati nell'exe, serviti anche a intervalli Range). `Guide.controlla(g)`
  chiede il video con `HEAD`: finché non c'è (404) la scheda mostra "Videoguida in preparazione" e porta alla guida scritta.
  Se le didascalie del `.vtt` non sono esattamente i `passi` di adesso (video girato per una versione precedente) il video
  resta guardabile ma è segnato "versione precedente", con un avviso nella sua finestra, e la guida scritta resta il
  pulsante principale; rigenerato il video con i passi nuovi, l'avviso sparisce da solo.
  `strumenti/genera-videoguide.js` rigenera i video con il server vero e Playwright (1280×720, didascalie = `passi`,
  puntatore finto), ffmpeg (H.264, `+faststart`, al massimo 2 MB), copertina e sottotitoli; una guida senza scenario resta
  senza video. Quando una pagina cambia aspetto si rigenera la sua guida con `--solo <id>`.

## Anteprima

`strumenti/genera-anteprima.js` crea `dist/anteprima/`: l'interfaccia vera con `anteprima/server-finto.js`, che risponde a
`fetch('api/…')` ed `EventSource('api/eventi')` dentro il browser con le stesse regole del server (permessi, ripartizione sui
lotti, richieste, DDT, struttura, 2FA, Sistema simulato), e `anteprima/banda.js` (utenti di prova `admin`, `farma`,
`reparto`, `reparto2`, `direzione`, `sicura` con password `prova`; codice 2FA del momento; collega che registra; codici a
barre di prova). Dati di prova ricchi da `js/demo.js` (151 giorni di consumi). Nomi dimostrativi ("Clinica Demo"), nessun
logo: le cartelle `brand/` e `guide/` non entrano. `pagina-artifact.html` è la stessa pagina senza `<html>`/`<head>`/`<body>`,
per pubblicarla come Artifact. Non fa parte del programma installato.

## Compilazione dell'exe

`npm run exe` (`strumenti/compila-exe.js`): unisce il server con esbuild, impacchetta server e interfaccia (con `fonts/`,
`brand/`, `guide/`) in un blob SEA, lo inietta in `node.exe` per Windows x64 (stessa versione di Node usata per prepararlo,
scaricata da nodejs.org e controllata con SHA-256), imposta icona e informazioni di versione e produce
`dist/GestionaleFarmacia/` con l'exe, gli script e il LEGGIMI di `installazione/` (a capo CRLF) e le licenze
(`LICENZA-*.txt`), più lo zip da consegnare. Con `--linux` produce anche `dist/gestionale-farmacia-linux` per le prove
automatiche (`GF_ESEGUIBILE=… node --test tests/server.test.js`).

## File e responsabilità

| File | Cosa fa |
|---|---|
| `server/main.js` | avvio, argomenti, configurazione, HTTPS, sequenza di controllo e cura, arresto |
| `server/http.js` | instradamento, sessioni e cookie, CSRF, intestazioni, file statici (anche Range), SSE, rotte di base; chiama `rotte(server)` dei moduli |
| `server/accessi.js` | utenti, password, permessi, sessioni, 2FA (TOTP, codici di recupero, dispositivi), blocchi, registro attività |
| `server/sicurezza.js` | rotte `/api/2fa*`, `/api/sicurezza`, azzeramento |
| `server/operazioni.js` | movimenti e ripartizione sui lotti, articoli, impostazioni, importazioni, dati di prova |
| `server/logistica.js` | richieste e DDT, spedizione, ricezione, annulli |
| `server/struttura.js` | magazzini, armadi, assortimento, ubicazioni |
| `server/db.js` | apertura dei database, schemi e aggiornamenti, conversioni riga ↔ oggetto, `cambiamenti`, `scrivi`, `dopoScrittura` |
| `server/giornale.js` | giornale delle modifiche |
| `server/backup.js` | copie, verifica, scaglioni, seconda cartella, ripristino |
| `server/salute.js` | controlli, cura, prova di ripristino, stato della pagina Sistema, pianificazione |
| `js/app.js` | guscio: accesso, menu, tasti rapidi, ricerca, tema, marchio, permessi, contatori, finestre |
| `js/api.js` | chiamate al server, sincronizzazione di `App.S`, notifiche |
| `js/accesso.js`, `js/sicurezza.js` | schermata di accesso (con 2FA e attivazione guidata), finestra "Sicurezza dell'account", pagina Sicurezza |
| `js/pagine.js` | pagine della 2.x adattate (carico, consumi, perdite, giacenze, scadenze, movimenti, inventario, Nota consumi, articoli, Guida scritta) |
| `js/pagine-cruscotto.js` | Oggi |
| `js/pagine-logistica.js` | Richieste, DDT e consegne, Trasferimenti, stampa del DDT |
| `js/pagine-struttura.js`, `js/armadio-vista.js` | Struttura, Armadi, Magazzini e assortimento; disegno degli armadi |
| `js/pagine-analisi.js`, `js/previsioni.js`, `js/excel-ordini.js` | Previsioni, Distribuzione, proposta d'ordine |
| `js/pagine-sistema.js` | Sistema |
| `js/pagine-configura.js`, `js/amministrazione.js` | Configura (marchio, previsioni, copie, struttura), Utenti, Attività |
| `js/calcoli.js`, `js/barcode.js`, `js/totp.js` | calcoli, codici a barre e TOTP condivisi fra browser e server |
| `js/scanner.js`, `js/codice128.js` | lettore e fotocamera; codice a barre del DDT |
| `js/grafici.js`, `js/motion.js` | grafici e animazioni |
| `js/tour.js`, `js/guide.js` | Guidami, pagina Guida |
| `js/excel.js`, `js/modello.js` | modulo Excel della Nota consumi |
| `css/*.css` | `app.css` (variabili e tema), uno per area: `cruscotto`, `logistica`, `struttura`, `analisi`, `sistema`, `sicurezza`, `guide`, `tour`, `scanner`, `caratteri` |
| `anteprima/`, `js/demo.js` | anteprima nel browser e dati di prova |
| `strumenti/` | compilazione, anteprima, videoguide, prove nel browser (`prova-interfaccia.js`, `prova-tour.js`) |
| `tests/` | prove `node --test`: calcoli, Excel, codici a barre, TOTP, previsioni, server, logistica, struttura, sicurezza, salute |
