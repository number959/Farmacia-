# Versione 3.0 – contratto fra le parti in sviluppo

Questo documento è il riferimento comune per chi sviluppa la 3.0. Chi tocca un file non suo, o cambia qualcosa
qui descritto (tabelle, forme dei dati, indirizzi delle API, nomi dei permessi, nomi delle pagine), si ferma e lo segnala
nel proprio rapporto invece di farlo.

## Obiettivo

Il gestionale diventa **NefroCenter Pharmacy** (nome configurabile, impostazione `nomeProdotto`):
- **farmacia centrale** e **magazzini periferici** (uno per piano o reparto), personalizzabili dall'amministratore, ognuno con
  il proprio **assortimento** (prontuario di reparto con scorte minima, punto di riordino, massima) e i propri **armadi**;
- **richieste** dal magazzino periferico alla farmacia centrale e **DDT interni** (documento di trasporto) con tracciamento
  completo: chi ha chiesto, chi ha approvato, chi ha preparato, **chi ha trasportato**, chi ha ricevuto e quando;
- la farmacia centrale vede **quanto ha dato** a ogni magazzino periferico e cosa c'è sparso in tutta la struttura;
- **previsioni statistiche** del fabbisogno (giornaliero, settimanale, mensile) e **proposta d'ordine** per la centrale;
- **vista grafica degli armadi** e **mappa della struttura** per piani, con animazioni (motion design);
- **autenticazione a due fattori** (TOTP, come Google/Microsoft Authenticator) oltre alla password;
- **base dati che si cura da sola** (controlli di integrità, giornale delle modifiche, ripristino automatico) e copie di
  sicurezza verificate;
- stile del sito NefroCenter, più tecnico; guide scritte, giri di Guidami e videoguide per tutto.

Nomi tecnici che **non cambiano** (per aggiornare le installazioni 2.x senza sorprese): `GestionaleFarmacia.exe`, nome del
servizio, cartella dati, file `farmacia.db` e `accessi.db`, id dei reparti esistenti (`r-farmacia`, `r-degenza`…), id dei
ruoli (`amministratore`, `farmacista`, `reparto`, `consultazione`). Cambiano solo le etichette mostrate.

## Ruoli (etichette nuove, id invariati)

| id | etichetta | cosa fa |
|---|---|---|
| `amministratore` | Amministratore | tutto, compresi struttura, utenti, sicurezza, sistema |
| `farmacista` | Farmacista (farmacia centrale) | carichi, evasione richieste, DDT, assortimenti, previsioni, ordini |
| `reparto` | Responsabile di magazzino | lavora sui magazzini assegnati (`utente.reparti`): consumi, perdite, richieste, ricezione DDT, ubicazioni |
| `consultazione` | Direzione (sola lettura) | vede tutto, non scrive |

## Permessi (server/accessi.js `permessi(utente)`, già impostati dalle fondamenta)

Esistenti invariati: `utenti, impostazioni, backup, attivita, articoli, carico, trasferimento, rettifica, consumo, perdita,
registro, annullaTutti, reparti` (`reparti`: null = tutti, oppure elenco degli id scrivibili).

Nuovi:
- `richieste`: creare/modificare/inviare/annullare richieste dei magazzini scrivibili (farmacista, amministratore, reparto)
- `evadiRichieste`: prendere in carico, approvare quantità, rifiutare, chiudere con residuo (farmacista, amministratore)
- `ddt`: preparare e spedire DDT **da** un magazzino scrivibile (farmacista, amministratore, reparto per i resi)
- `riceviDdt`: ricevere DDT **in** un magazzino scrivibile (farmacista, amministratore, reparto)
- `struttura`: magazzini, piani, armadi (amministratore)
- `assortimento`: assortimento e scorte dei magazzini (farmacista, amministratore)
- `ubicazioni`: posizione degli articoli negli armadi dei magazzini scrivibili (farmacista, amministratore, reparto)
- `previsioni`: pagina previsioni e distribuzione (tutti tranne nessuno: il reparto vede solo i suoi magazzini)
- `ordini`: proposta d'ordine ed esportazione (farmacista, amministratore)
- `sistema`: stato della base dati, giornale, copie (amministratore)
- `sicurezza`: criteri 2FA e azzeramento 2FA altrui (amministratore)

Per il ruolo `consultazione` tutti i permessi di scrittura sono falsi; `previsioni` è vero.

## Base dati: schema 3 di `farmacia.db` (scritto dalle fondamenta in server/db.js)

### Colonne nuove
- `reparti`: `tipo` ('centrale'|'periferico'|'transito'), `piano` (testo, es. "1° piano"), `livello` (intero: −1 seminterrato,
  0 piano terra, 1, 2…; serve a disegnare l'edificio), `colore` ('' o '#rrggbb'), `descrizione`.
  La colonna `centrale` resta e vale 1 solo per `tipo='centrale'`.
- `articoli`: `attributi` (JSON, array di: 'frigo', 'stupefacente', 'alto-rischio', 'lasa', 'urgenza'),
  `lead_time` (giorni di consegna del fornitore, NULL = impostazione generale), `fornitore` (fornitore abituale).
- `movimenti`: `ddt_id` (DDT che ha generato il movimento, oppure NULL).

### Magazzino di sistema "In transito"
`id = 'r-transito'`, `tipo = 'transito'`, `nome = 'In transito'`, `attivo = 1`, `ordine = 9999`. Esiste sempre, non si
modifica né si elimina, **non compare** negli elenchi dei magazzini (`App.repartiAttivi()` lo esclude) ma la sua giacenza è
"la merce in viaggio". `App.magazzinoTransito()` lo restituisce.

### Tabelle nuove (tutte con `rev` per la sincronizzazione)
```
armadi        (id, reparto_id, nome, tipo, ripiani, colonne, ordine, colore, note, attivo, rev)
              tipo: 'armadio'|'frigorifero'|'cassettiera'|'carrello'|'cassaforte'
assortimento  (id, reparto_id, articolo_id, scorta_min, punto_riordino, scorta_max,
               armadio_id, ripiano, posizione, note, attivo, rev)       UNIQUE(reparto_id, articolo_id)
richieste     (id, numero UNIQUE, anno, progressivo, reparto_id, fornitore_id, stato, urgente, note,
               creata_da, creata_da_nome, creata_il, inviata_il, presa_da, presa_da_nome, presa_il,
               chiusa_il, chiusa_da, chiusa_da_nome, motivo, rev)
richieste_righe (id, richiesta_id, articolo_id, quantita, approvata, nota, ordine, rev)
ddt           (id, numero UNIQUE, anno, progressivo, origine_id, destinazione_id, richiesta_id, stato, causale,
               colli, note, preparato_da, preparato_da_nome, preparato_il, trasportatore_id, trasportatore_nome,
               partito_il, ricevuto_da, ricevuto_da_nome, ricevuto_il, note_ricezione,
               annullato_il, annullato_da, motivo_annullo, rev)
ddt_righe     (id, ddt_id, articolo_id, richiesta_riga_id, lotto, scadenza, quantita, ricevuta, esito, nota, ordine, rev)
```
Le date-ora sono ISO 8601 (`new Date().toISOString()`); le date semplici 'AAAA-MM-GG'.
Numeri: `RIC-AAAA-NNNN` e `DDT-AAAA-NNNN` (progressivo per anno, contatori in `meta`: `prog_ric_AAAA`, `prog_ddt_AAAA`,
assegnati dentro la transazione). Il numero del DDT è anche il testo del suo codice a barre/QR.

### Sincronizzazione
`/api/dati` (db.cambiamenti) restituisce, oltre a `reparti, articoli, movimenti`, anche
`armadi, assortimento, richieste, richiesteRighe, ddt, ddtRighe` (righe con `rev > da`). Nelle cancellazioni
(`cancellati[].tabella`) si usa la **chiave di App.S** (es. 'richiesteRighe'). Il client (js/api.js) unisce tutte le
tabelle dell'elenco `Api.TABELLE`. Forme in App.S (camelCase):
```
armadio:       {id, repartoId, nome, tipo, ripiani, colonne, ordine, colore, note, attivo}
assortimento:  {id, repartoId, articoloId, scortaMin, puntoRiordino, scortaMax, armadioId, ripiano, posizione, note, attivo}
richiesta:     {id, numero, anno, progressivo, repartoId, fornitoreId, stato, urgente, note, creataDa, creataDaNome, creataIl,
                inviataIl, presaDa, presaDaNome, presaIl, chiusaIl, chiusaDa, chiusaDaNome, motivo}
richiestaRiga: {id, richiestaId, articoloId, quantita, approvata, nota, ordine}
ddt:           {id, numero, anno, progressivo, origineId, destinazioneId, richiestaId, stato, causale, colli, note,
                preparatoDa, preparatoDaNome, preparatoIl, trasportatoreId, trasportatoreNome, partitoIl,
                ricevutoDa, ricevutoDaNome, ricevutoIl, noteRicezione, annullatoIl, annullatoDa, motivoAnnullo}
ddtRiga:       {id, ddtId, articoloId, richiestaRigaId, lotto, scadenza, quantita, ricevuta, esito, nota, ordine}
reparto:       {id, nome, centrale, tipo, piano, livello, colore, descrizione, attivo, ordine}
articolo:      … come prima + attributi[], leadTime (numero|null), fornitore
movimento:     … come prima + ddtId (o null)
```

## Flusso richiesta → DDT → ricezione (parte A)

Stati della **richiesta**: `bozza` → `inviata` → `in_lavorazione` → `evasa` | `chiusa` (chiusa con residuo) | `rifiutata`;
`annullata` (dal richiedente, solo da bozza o inviata). La quantità spedita di una riga si calcola dalle righe dei DDT
collegati non annullati (`in_transito` o ricevuti). Quando tutte le righe approvate sono spedite la richiesta diventa `evasa`.

Stati del **DDT**: `in_preparazione` (righe modificabili, giacenze ferme) → `in_transito` (partito: per ogni riga un movimento
`trasferimento` origine → `r-transito` con `ddt_id`, `documento = numero`) → `ricevuto` | `ricevuto_con_differenze`
(alla ricezione: movimento `trasferimento` `r-transito` → destinazione per la quantità ricevuta; la differenza
**rientra** all'origine oppure è una **perdita in transito** — `perdita` su `r-transito` con causale "Differenza alla
ricezione DDT …"); `annullato` (da in_preparazione: niente da fare; da in_transito: rientro di tutto all'origine).
Le righe dei DDT hanno sempre il lotto esplicito: alla preparazione il server ripartisce per lotti (FEFO, come oggi) e salva
una riga per lotto. Un DDT può nascere da una richiesta (righe collegate con `richiesta_riga_id`) o da solo (pagina
Trasferimenti, resi). I movimenti con `ddt_id` non si annullano dalla pagina Movimenti: si annulla il DDT.
Nella Nota consumi mensile e nell'Excel il magazzino d'origine vede l'uscita alla data di partenza, il destinatario
l'entrata alla data di ricezione, come trasferimenti dal/verso il magazzino vero (non "In transito").
Ogni passaggio scrive nel registro attività (`richieste.*`, `ddt.*`) e notifica i browser (SSE come oggi).

## Previsioni (parte D, solo nel browser, modulo condiviso `js/previsioni.js`)
Serie giornaliere dei consumi (consumo + perdita) per articolo × magazzino e per tutta la struttura. Modelli: media mobile,
livellamento esponenziale semplice, Holt smorzato, Holt-Winters additivo con stagionalità settimanale (se ≥ 4 settimane di
dati), Croston-SBA per le domande intermittenti; scelta automatica per errore di retro-verifica (MAE sulle ultime 4
settimane), intervallo di previsione dai residui. Indicatori: consumo medio giornaliero/settimanale/mensile, tendenza,
giorni di copertura, data stimata di esaurimento, scorta di sicurezza z·σ·√LT, punto di riordino, quantità da ordinare
arrotondata alle confezioni. Impostazioni: `leadTimeGiorni` (7), `periodoRevisioneGiorni` (7), `livelloServizio` (0.95),
`storicoGiorni` (180). Classificazione ABC (valore) × XYZ (variabilità).

## 2FA (parte C)
TOTP RFC 6238 (SHA-1, 6 cifre, 30 s, finestra ±1), segreto base32 di 20 byte cifrato nel database accessi con una chiave
nella cartella dati; QR per l'attivazione (vendor/qrcode.js), 10 codici di recupero monouso (salvati come hash);
criteri dell'amministratore (impostazione `richiedi2fa`: 'nessuno' | 'amministratori' | 'farmacisti' (= admin+farmacisti) |
'tutti'); dispositivo attendibile per 30 giorni (facoltativo); blocco dopo 5 codici sbagliati come per la password;
codice già usato non vale una seconda volta. Modulo condiviso `js/totp.js` (UMD, SHA-1/HMAC in JS puro, usato anche
dall'anteprima).

## Base dati che si cura da sola (parte E)
Controllo rapido (`PRAGMA quick_check`) all'avvio e completo (`integrity_check`) ogni notte; **giornale delle modifiche**
(dopo ogni scrittura, le righe cambiate in quella revisione, in file JSONL giornalieri nella cartella dati, con fsync);
in caso di danno: ricostruzione dalla copia valida più recente + **riapplicazione del giornale** fino all'ultima revisione;
copie automatiche verificate (aperte e controllate), conservazione a scaglioni (orarie 24 h, giornaliere 14, settimanali 8,
mensili 12), seconda cartella facoltativa (disco esterno o cartella di rete), copia anche di `accessi.db`.
Pagina **Sistema** per l'amministratore. Le fondamenta offrono `database.dopoScrittura(fn)`: `fn({ rev })` dopo ogni
commit di `database.scrivi`.

## Interfaccia

### Stile (parte F)
Colori NefroCenter: blu `#1C4184`, blu scuro `#1F3A70`, blu notte `#14294F`, inchiostro `#12244A`, tinta `#E7EEF8`,
carta `#F8FAFD`, linea `#E3E9F4`, tenue `#5B687C`, rosso del marchio `#E10717`. Caratteri locali (cartella `fonts/`,
licenza OFL): **Manrope** per titoli, **Inter** per il testo, **JetBrains Mono** per codici, numeri di documento e lotti.
"Più tecnico": tabelle dense, numeri tabulari, griglie sottili, etichette in maiuscoletto, tema chiaro e scuro.
Le variabili CSS esistenti (`--primario`, `--superficie`, `--linea`, `--ok`, `--attenzione`, `--pericolo`…) restano e
cambiano valore; i nuovi file CSS usano **solo** variabili. Variabili nuove: `--carattere-titoli`, `--accento` (rosso),
`--blu-notte`, `--grafico-1` … `--grafico-8`, `--durata` (240ms), `--curva` (cubic-bezier(.2,.8,.2,1)).
Movimento: rispettare sempre `prefers-reduced-motion` (niente animazioni, solo cambi di stato).

### Librerie (cartella vendor/, caricate da index.html, licenze in vendor/LICENZE/)
- **Apache ECharts 6.1.0** (`vendor/echarts.min.js`, Apache-2.0): grafici. Si usa solo attraverso `js/grafici.js`.
- **anime.js 4.5.0** (`vendor/anime.umd.min.js`, MIT, globale `anime`): animazioni. Si usa attraverso `js/motion.js`.
- **qrcode-generator 2.0.4** (`vendor/qrcode.js`, MIT, globale `qrcode`): QR del 2FA e dei DDT.
- **ExcelJS** come prima.

### API comuni nel browser (create dalle fondamenta, rifinite da F)
- `Grafici.crea(elemento, opzioniECharts)` → istanza; ridimensionamento, tema chiaro/scuro e distruzione al cambio pagina
  automatici. `Grafici.colori()` → tavolozza corrente. `Grafici.tema()` → 'chiaro'|'scuro'.
- `Motion.entra(elementi, opz)` (comparsa a cascata), `Motion.conta(el, da, a, opz)` (numeri che scorrono),
  `Motion.evidenzia(el)` (impulso), `Motion.ridotto()` → true se l'utente preferisce meno movimento. Senza anime.js o con
  movimento ridotto, le funzioni applicano subito lo stato finale.
- `App.registraContatore(nome, fn)`: numero mostrato nel menu per le voci con `conta: nome` (fn() → numero).
- `App.repartiAttivi()` esclude il magazzino "In transito"; `App.magazzinoTransito()`; `App.magazziniPeriferici()`;
  `App.repartoCentrale()` come prima.

### Menu e pagine (id → file → parte)
| id | voce | file | parte |
|---|---|---|---|
| `oggi` | Oggi (cruscotto) | js/pagine-cruscotto.js (sostituisce P.oggi) | F |
| `richieste` | Richieste | js/pagine-logistica.js | A |
| `consegne` | DDT e consegne | js/pagine-logistica.js | A |
| `trasferimenti` | Trasferimenti (crea un DDT) | js/pagine-logistica.js (sostituisce P.trasferimenti) | A |
| `struttura` | Struttura (mappa dei piani) | js/pagine-struttura.js | B |
| `armadi` | Armadi (vista grafica) | js/pagine-struttura.js + js/armadio-vista.js | B |
| `magazzini` | Magazzini e assortimento | js/pagine-struttura.js | B |
| `configura` | Configura (+ marchio e nome del prodotto) | js/pagine-configura.js (sostituisce P.configura) | B |
| `previsioni` | Previsioni e fabbisogno | js/pagine-analisi.js | D |
| `distribuzione` | Distribuzione alle periferiche | js/pagine-analisi.js | D |
| `sistema` | Sistema (base dati e copie) | js/pagine-sistema.js | E |
| `sicurezza` | Sicurezza (2FA) | js/sicurezza.js | C |

Le pagine esistenti restano dove sono. Un file che "sostituisce" una pagina assegna `App.pagine.<id>` dopo pagine.js
(come js/guide.js con la Guida); il vecchio codice in pagine.js si toglie solo nella pulizia finale.

### Impostazioni nuove (tabella impostazioni, valori predefiniti in db.js)
`nomeProdotto` ('NefroCenter Pharmacy'), `sigla` ('NC Pharmacy'), `struttura` ('Clinica Posillipo'),
`sottotitolo` ('Longevity Institute · Gruppo NefroCenter'), `logo` ('' = marchio incorporato `brand/logo.png`;
'nessuno' = nessun logo; altrimenti data URL caricato dall'amministratore), `coloreAccento` ('' = rosso del marchio),
`tema` ('automatico'|'chiaro'|'scuro', predefinito per chi non ha scelto), `leadTimeGiorni` 7,
`periodoRevisioneGiorni` 7, `livelloServizio` 0.95, `storicoGiorni` 180, `richiedi2fa` 'nessuno'.

### Anteprima pubblicata (Artifact)
Non deve usare il marchio né il nome di una struttura reale: l'anteprima usa nomi dimostrativi ("Clinica Demo",
prodotto "Pharmacy · anteprima") e nessun logo; la cartella `brand/` non entra nell'anteprima.

## File: chi li modifica

| parte | file propri |
|---|---|
| A logistica | server/logistica.js, server/operazioni.js, js/pagine-logistica.js, js/codice128.js, css/logistica.css, js/calcoli.js, js/pagine.js (solo per adattare le pagine esistenti al magazzino in transito e ai DDT), tests/logistica.test.js, tests/calcoli.test.js, tests/server.test.js |
| B struttura | server/struttura.js, js/pagine-struttura.js, js/armadio-vista.js, js/pagine-configura.js, js/amministrazione.js, css/struttura.css, tests/struttura.test.js |
| C sicurezza | js/totp.js, server/accessi.js, server/http.js, js/accesso.js, js/sicurezza.js, css/sicurezza.css, tests/totp.test.js, tests/sicurezza.test.js |
| D analisi | js/previsioni.js, js/pagine-analisi.js, js/excel-ordini.js, css/analisi.css, tests/previsioni.test.js |
| E affidabilità | server/salute.js, server/giornale.js, server/backup.js, server/main.js, server/db.js (solo giornale e cura, non lo schema), js/pagine-sistema.js, css/sistema.css, tests/salute.test.js |
| F aspetto | css/app.css, css/caratteri.css, css/cruscotto.css, js/app.js, js/grafici.js, js/motion.js, js/pagine-cruscotto.js, index.html |
| dopo | anteprima/*, strumenti/genera-anteprima.js, js/tour.js, js/guide.js, strumenti/genera-videoguide.js, strumenti/prova-*.js, README.md, installazione/*, docs/ARCHITETTURA.md |

Ogni parte registra le proprie rotte nel proprio modulo server: `module.exports.rotte = function (server) { … }`
(chiamato da http.js; `server.rotta(metodo, percorso, opz, gestore)`, `server.database`, `server.accessi`,
`server.notifica(rev)`, `server.backup`). Le prove usano porte libere e cartelle temporanee; nessun server resta acceso.
