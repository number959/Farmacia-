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
l'entrata alla data di ricezione, come trasferimenti dal/verso il magazzino vero (non "In transito"). La merce che
**rientra** all'origine (DDT annullato in viaggio, differenza "rientra") non è un carico: toglie l'uscita (vedi
"Decisioni prese", Logistica). Nel residuo della richiesta la quantità rientrata torna da spedire.
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
'tutti'); dispositivo attendibile per 30 giorni (facoltativo); blocco dopo 5 codici sbagliati come per la password (dal
server stesso nessun blocco, ma limiti propri: vedi "Decisioni prese"); codice già usato non vale una seconda volta;
cambio di telefono solo con la password. Modulo condiviso `js/totp.js` (UMD, SHA-1/HMAC in JS puro, usato anche
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

## Decisioni prese durante lo sviluppo (registrate nell'integrazione)

Scelte delle parti che precisano o cambiano un poco il contratto qui sopra. Valgono queste.

### Previsioni (parte D)
- **Scelta del modello**: vince il modello con l'errore più basso nella retro-verifica sulle ultime 4 settimane, dove
  l'errore è il **MAE giornaliero più il MAE delle somme di 7 giorni** (non il solo MAE giornaliero: con quello, sui
  farmaci usati a giorni alterni vincevano previsioni troppo basse). A parità entro il 2% vince il modello più semplice;
  poi il modello si riadatta a tutta la storia. `Previsioni.stima(…, { criterio: 'giornaliero' })` torna al solo MAE
  giornaliero.
- **XYZ** (variabilità) si calcola sui consumi **settimanali**, non giornalieri (sui giorni quasi tutti gli articoli
  sarebbero Z). ABC: 80/15/5 sul valore.
- Fascia di incertezza al **90%**, dagli errori del modello, più larga all'aumentare dell'orizzonte. Holt-Winters usa una
  tendenza smorzata (su 90 giorni non esplode).
- La farmacia centrale scelta da sola mostra solo i suoi consumi diretti; la proposta d'ordine è sempre su tutta la
  struttura (avviso nella pagina). Per i magazzini periferici le etichette dicono "Da chiedere alla farmacia".
- Previsioni e Distribuzione **non** sono in `App.PAGINE_CONSULTAZIONE` (si ridisegnerebbero mentre si scrivono le
  confezioni della proposta): quando altri scrivono compare la banda "Aggiorna". Calcolo solo nel browser, nessuna rotta.
- Per le altre parti: `Previsioni.consumoGiornaliero(stato, articoloId, repartoId)` e
  `Previsioni.consumoMedio(stato, articoloId, repartoId, giorni)` (per la centrale conta anche quello che dà agli altri,
  alla partenza, **meno i rientri** all'origine — DDT annullato in viaggio, differenza "rientra" — tolti nel giorno della
  partenza: un DDT annullato non conta; l'arrivo a destinazione e la perdita in viaggio restano uscite, come nella Nota
  consumi).
- **Giorni anomali.** Un giorno isolato (i giorni accanto sono normali) sopra `max(m + 5·s, 3·m)` — m = mediana dei
  giorni con consumo, s = il più grande fra 1,4826 × MAD e min(√m, m) — si conta come la soglia per i modelli e per
  σ. Al massimo l'1% dei giorni con consumo (almeno 1); servono almeno 5 giorni con consumo. Due o più giorni alti di
  fila sono un cambio vero e non si toccano. Grafico, medie, tendenza, XYZ e totali restano sul dato vero; il dettaglio dell'articolo
  lo spiega («Un giorno insolito: il …, contati come …»).
- **σ robusta.** Nella scorta di sicurezza i residui oltre `max(4 · scarto tipico, 2 · il residuo dopo l'1% più grande)`
  contano come il limite: si limitano solo pochi residui staccati dagli altri, così le "scatole grandi ogni tanto"
  restano coperte (la proposta del revisore, ±4σ sempre, le scopriva). `Previsioni.stima(…, { anomali: false })` torna
  ai conti di prima.
- **"Già chiesto" dei magazzini periferici.** Disponibile = giacenza + in viaggio + già chiesto, dove il già chiesto è
  residuo + in preparazione delle richieste aperte (bozza, inviata, in lavorazione) dei magazzini dell'ambito a un
  fornitore fuori dall'ambito (`Calcoli.avanzamentoRichiesta`, gli stessi numeri della proposta della pagina Richieste).
  "Da chiedere" si calcola su questo disponibile; per tutta la struttura il già chiesto è 0. Conta anche le bozze, come
  la pagina Richieste. I DDT in preparazione che non nascono da una richiesta non sono nel già chiesto (da decidere
  insieme alla pagina Richieste).

### Aspetto (parte F)
- **Titolo della finestra**: `pagina · nomeProdotto · struttura` (per esempio "Giacenze · NefroCenter Pharmacy · Clinica
  Posillipo"): il nome della pagina davanti, come nella 2.x, distingue le schede aperte; sulla schermata di accesso
  `nomeProdotto · struttura`.
- Marchio del menu: logo `''` = `brand/marchio.png` (`App.MARCHIO`), nome del prodotto come titolo, struttura e
  sottotitolo sotto (`App.htmlMarchio`, usato anche dall'anteprima di Configura). La schermata di accesso usa il logo
  largo `brand/logo.png`. Un logo che non si carica lascia il posto a un simbolo neutro.
- Variabili in più: `--primario-pieno`, `--pericolo-pieno`, `--ok-pieno`, `--accento-pieno` (sfondi sotto un testo
  bianco: nel tema scuro `--primario`, `--pericolo` e `--accento` sono colori da testo, chiari).
- Al cambio di tema `Grafici.ritema()` ridisegna tutti i grafici aperti: le opzioni-funzione si richiamano, nelle
  opzioni-oggetto i colori letti dalle variabili CSS del tema di prima diventano quelli del tema nuovo.

### Struttura (parte B)
- `DELETE /api/magazzini/:id`: solo per un magazzino **mai usato** (nessun movimento, richiesta o DDT), altrimenti 409
  con l'invito a togliere «Attivo». I suoi armadi e il suo assortimento si cancellano con lui (l'interfaccia chiede una
  conferma esplicita); gli utenti a cui era assegnato lo perdono. "In transito" risponde 400 (non si modifica né si
  elimina, non ha armadi né assortimento).
- Un magazzino non si disattiva con DDT da spedire o in viaggio o con richieste aperte (409). La farmacia centrale non
  si toglie né si disattiva (400); sceglierne un'altra rende periferica la vecchia.
- "Sotto scorta" in tutto il programma (cruscotto, Giacenze, scheda dell'articolo): scorta minima dell'assortimento del
  magazzino; nella farmacia centrale, se l'assortimento non ha soglie per l'articolo, la scorta minima dell'anagrafica
  (`App.scortaMinima`, `App.sottoScorta`). Gli articoli non attivi non contano.
- **`PUT /api/reparti` e `DELETE /api/reparti/:id` della 2.x** valgono ancora, con le regole della 3.0 applicate allo
  stato finale di **tutti** i magazzini (anche quelli che non sono nell'elenco mandato): una sola farmacia centrale
  (indicarne un'altra declassa quella di prima a periferica), mai tolta né disattivata (400); un magazzino con DDT da
  spedire o in viaggio o richieste aperte non si disattiva (409, stesso messaggio di `/api/magazzini`, stessi controlli
  `controllaDisattivazione` e `declassaCentrale` di server/struttura.js); nomi doppi controllati anche contro i magazzini
  fuori elenco; "In transito" resta com'è. `DELETE`: la farmacia centrale 400; 409 con movimenti, richieste, DDT, armadi
  o assortimento. Un archivio che già non ha una centrale si accetta se resta così.
- **"Proponi dai consumi"** usa `Previsioni.consumoMedio` (quindi per la centrale senza i rientri); senza il modulo delle
  previsioni fa lo stesso conto da sola (`StrutturaMagazzini.consumiMediDaMovimenti`, con `Calcoli.partenzeDdt` e
  `Calcoli.rientroAllOrigine`).

### Logistica e articoli (parte A, correzioni dalle revisioni)
- **Rientri nella Nota consumi** (`Calcoli.registroMensile`): la merce che rientra all'origine non è un carico. Toglie
  l'uscita del giorno della partenza se la partenza è nello stesso mese (un DDT partito e annullato nel mese sparisce dal
  modulo), altrimenti quella del giorno del rientro (la casella può risultare negativa: lo spiega il testo sulla casella).
  La casella del registro corregge solo il consumo (le uscite al netto dei rientri). `Calcoli.partenzeDdt` e
  `Calcoli.rientroAllOrigine` riconoscono partenze e rientri per tutte le pagine.
- **Rientri nel residuo della richiesta** (`Calcoli.avanzamentoRichiesta`): la quantità rientrata alla ricezione non
  conta come spedita e torna nel residuo, come per un DDT annullato; la perdita in viaggio resta spedita. La ricezione
  aggiorna lo stato della richiesta (un'`evasa` con merce rientrata torna `in_lavorazione`; `richiesta` nei dettagli di
  `ddt.ricevi`), e la pagina di ricezione lo dice.
- **Due farmacisti sulla stessa richiesta**: `POST /api/richieste/:id/approva` accetta per riga `prima`, l'approvata che
  la pagina mostrava (`null` = non ancora approvata). Se nel frattempo è cambiata: 409 «Nel frattempo X ha cambiato la
  quantità approvata di …» e la pagina si ricarica. Senza `prima` nessun controllo (client vecchi); la pagina della 3.0 lo
  manda sempre.
- **Lotti scaduti fuori dalla scelta automatica.** Consumi e trasferimenti saltano i lotti scaduti alla data del
  movimento finché ce ne sono altri (se restano solo quelli li usano, invece di un debito "senza lotto"); le perdite li
  prendono come prima. I DDT non spediscono mai da soli un lotto scaduto: il 409 e l'elenco dei mancanti lo spiegano
  («altri N sono in lotti scaduti…», `mancanti[].scaduti`, «C'è merce solo in lotti scaduti…»); per un reso il lotto
  scaduto si sceglie a mano nella riga. Nelle tendine dei lotti gli scaduti sono segnati «SCADUTO».
- **Uscite con data passata**: da ogni lotto al massimo il minimo fra la giacenza a quella data e quella di oggi
  (`Calcoli.lottiDisponibili`), anche per il lotto scelto a mano (altrimenti 409).
- **`DELETE /api/articoli/:id`**: 409 se l'articolo ha movimenti, se compare in richieste o DDT, o se è nell'assortimento
  attivo di un magazzino (il messaggio nomina il magazzino); le righe di assortimento non attive si cancellano con
  l'articolo (e la cancellazione arriva ai browser). Lo stesso controllo c'è nel modulo dell'articolo.
- **Campi nuovi dell'articolo** (creazione, modifica, importazione): `attributi` fra i cinque previsti, senza doppioni
  (nel modulo: «Da frigorifero 2–8 °C», «Stupefacente (cassaforte)», «Alto rischio», «LASA (nome o aspetto simile)»,
  «Urgenze»); `leadTime` giorni interi da 0 a 365, vuoto/`null` = impostazione generale (nel modulo «Giorni di
  consegna», con il valore generale come suggerimento); `fornitore` fino a 200 caratteri («Fornitore abituale»). Chi non
  li manda (client vecchi, importazioni) non li cancella. La scheda dell'articolo e il pannello degli Armadi mostrano le
  caratteristiche; l'Excel degli articoli ha tre colonne in più (Fornitore abituale, Giorni di consegna, Caratteristiche).
  La disposizione automatica degli armadi mette nel frigorifero solo gli articoli `frigo` e nella cassaforte solo gli
  `stupefacente`.

### Base dati che si cura da sola (parte E, correzioni dalle revisioni)
- **Il giornale è la fonte di verità.** Ogni voce porta `evento` (l'ultimo numero del registro attività). All'avvio,
  all'arresto ordinato, dopo un ripristino e dopo una linea nuova il WAL si riversa nel file (checkpoint completo) e il
  giornale lo segna con una voce `avvio`, `chiusura`, `ripristino` o `nuova-linea` con `durevole: true`.
- **Coda persa** (spegnimento improvviso, WAL sparito, vuoto o rovinato): si cerca sempre nel giornale e si riapplica
  (cura `metodo: 'coda'`), a meno che il giornale abbia una voce durevole più avanti della revisione del file: allora il
  file è stato rimesso a mano da una copia vecchia e non si riporta avanti. `meta.sessione` non decide più.
- **Linea nuova "con perdite"**: se il magazzino resta più indietro del giornale, riparte da una revisione nuova con una
  cura `metodo: 'linea-nuova'`, `esito: 'curato-con-perdite'`, semaforo rosso, `perse` e `riassunto` ("2 articoli, 2 DDT…").
- **File sparito o vuoto con il solo giornale** (anche solo nella seconda cartella): non è un'installazione nuova, si
  ricostruisce da archivio vuoto + tutto il giornale.
- **Numeri di richieste e DDT**: ripristino e linea nuova portano avanti i contatori `prog_*` (il più alto fra `meta`, il
  file e le voci del giornale): un numero già usato non si riassegna.
- **Registro attività**: dopo una cura si contano le scritture del magazzino registrate dopo l'ultima voce del giornale;
  se ci sono, la cura è "con perdite" (`scrittureSenzaGiornale`) e le elenca. Si confronta anche l'ultima revisione vista
  dal programma acceso (`salute.json`, `ultimaVista`).
- **Seconda cartella**: il giornale nuovo ci va anche fra una copia e l'altra, nel giro dei 5 minuti se è cambiato; una
  richiesta durante un giro ne mette in coda un altro; `POST /api/sistema/copia` risponde quando le copie sono arrivate
  anche lì, al massimo dopo 20 s (la pagina Sistema dice «Copiate anche nella seconda cartella», oppure che non è
  raggiungibile o si sta ancora aggiornando). `accessi.db` si sostituisce in modo atomico (copia accanto e rinomina).

### Verifica in due passaggi (parti C ed E)
- La chiave che cifra i segreti TOTP è `<dati>/chiave-2fa.key` (0600). Le copie di `accessi.db` **nella cartella dati**
  portano con sé la chiave (`backup/accessi_….chiave-2fa.key`, 0600, tolta insieme alla copia): chi rimette la cartella
  dati da una copia non perde la 2FA. La chiave **non** va nella seconda cartella (disco esterno o di rete): lì ci sono
  solo copie, schede e giornale. Senza la chiave valgono comunque i codici di recupero (salvati come hash) e l'azzeramento.
- `--reimposta-password <utente>` azzera sempre anche la 2FA dell'utente (con codici di recupero e computer ricordati) e
  lo dice nel messaggio; se il criterio la richiede, al prossimo accesso il programma guida a riattivarla.
- Chi deve avere la 2FA e non l'ha attivata riceve **401** `{ attiva2fa: true }` su tutto tranne `GET /api/2fa`,
  `/api/2fa/inizia`, `/api/2fa/conferma`, `/api/password`, `/api/stato` e il logout (così il browser torna all'accesso,
  che guida all'attivazione).
- **Cambio di telefono con la password.** Con la 2FA già attiva, `POST /api/2fa/inizia` chiede `{ password }` (come
  disattivarla o creare codici nuovi): senza password 400 `{ servePassword }` (non conta come errore), password sbagliata
  400 che conta (alla quinta la sessione si chiude, 401; evento `accesso.2fa.cambio-telefono-fallito`). La chiave nuova
  vale solo per la sessione che l'ha chiesta: `POST /api/2fa/conferma` da un'altra sessione risponde 409 `{ ricomincia }`;
  dopo 10 codici sbagliati per la stessa chiave anche (evento `accesso.2fa.chiave-annullata`). Se la chiave è stata chiesta
  senza password e nel frattempo la 2FA è diventata attiva: 409 `{ ricomincia, servePassword }`. La **prima attivazione**
  (anche quella obbligatoria per il criterio) non chiede di nuovo la password: chi la deve attivare l'ha appena scritta.
  Nella finestra «Telefono nuovo» il primo passo è la password; il codice QR compare solo dopo la password giusta.
- **Codici dal server stesso.** Dal server (`127.0.0.1`/`::1`, l'accesso d'emergenza) non c'è mai il blocco di 15
  minuti, ma: la sfida si annulla dopo 10 codici sbagliati (401 `{ sfidaScaduta }`, si riscrive la password; evento
  `accesso.2fa.sfida-annullata`); dopo 20 codici sbagliati in 15 minuti per lo stesso utente, una sfida nuova solo ogni
  30 s (429 `{ attesaSecondi }`). Da qualsiasi computer al massimo 3 sfide valide insieme per (utente, computer). Una
  conferma riuscita di un telefono nuovo azzera questi contatori (servono dopo `--reimposta-password`, che gira in un
  altro processo); stanno solo in memoria, come gli altri contatori dei tentativi.

### Rotte in più rispetto al contratto
- Parte A: `GET /api/trasportatori` (permesso `ddt`) → `{ utenti: [{ id, nome }] }`, utenti attivi da scegliere
  come trasportatore (solo id e nome: il ruolo non serve e non si mostra); `POST /api/ddt/:id/spedisci` accetta
  `trasportatoreId` oppure `trasportatoreNome`.
- Parte B: `POST|PUT|DELETE /api/magazzini(/:id)`, `POST|PUT|DELETE /api/armadi(/:id)`, `PUT /api/assortimento`,
  `PUT /api/ubicazioni`.
- Parte C: `POST /api/login/2fa`, `GET /api/2fa`, `POST /api/2fa/inizia|conferma|disattiva|codici`,
  `DELETE /api/2fa/dispositivi`, `GET|PUT /api/sicurezza`, `POST /api/utenti/:id/2fa/azzera`. L'oggetto utente ha in più
  `dueFattori`, `dueFattoriObbligatoria`, `dueFattoriDaAttivare`.
- Parte E: `GET /api/sistema`, `POST /api/sistema/controlla|copia|prova-ripristino`, `PUT /api/sistema/seconda-cartella`;
  `GET /api/backup` dà anche `verificata`, `rev`, `base` (solo le copie del magazzino, come nella 2.x).

### Registro attività
Azioni nuove: `richieste.*`, `ddt.*`, `magazzini.*`, `armadi.*`, `assortimento.modifica`, `ubicazioni.modifica`,
`accesso.2fa.*` (anche `accesso.2fa.cambio-telefono-fallito`, `accesso.2fa.chiave-annullata`,
`accesso.2fa.sfida-annullata`), `utenti.password-emergenza`, `sistema.*` (`sistema.cura`, `sistema.controllo`,
`sistema.linea-nuova` li scrive l'utente "sistema"). Ogni azione ha il suo nome in italiano nella pagina Attività
(`NOMI_AZIONI` in js/amministrazione.js): un'azione nuova del server va aggiunta lì. Il filtro della pagina Attività le raggruppa (Sicurezza e accessi, Logistica, Struttura,
Sistema…): ogni voce è un inizio di codice, come prima.

### Pulizia
`P.oggi`, `P.trasferimenti` e `P.configura` di js/pagine.js sono stati tolti (sostituiti da pagine-cruscotto.js,
pagine-logistica.js e pagine-configura.js). `P.guida` resta: js/guide.js ne mostra le sezioni come "Istruzioni scritte".
`App.PAGINE_CONSULTAZIONE` comprende anche `sistema`.

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
