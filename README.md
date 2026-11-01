# NefroCenter Pharmacy 3.0 · Clinica Posillipo (gruppo NefroCenter)

Gestionale della **farmacia ospedaliera** della Clinica Posillipo: la **farmacia centrale** riceve la merce dai fornitori e
rifornisce i **magazzini periferici** di ogni piano con **richieste** e **DDT interni** (documenti di trasporto), tracciando
chi ha chiesto, chi ha approvato, chi ha preparato, chi ha portato e chi ha ricevuto. Ogni movimento si registra una volta
sola: giacenze, scadenze, previsioni del fabbisogno e la **Nota consumi mensile** di ogni magazzino (lo stesso modulo Excel di
sempre) sono sempre pronte.

Un solo programma gira sul **server** della clinica; le postazioni, i tablet e i telefoni lo usano dal browser (Edge o
Chrome) all'indirizzo del server, senza installare niente. Ognuno entra con il proprio utente, i ruoli decidono cosa può
fare, più persone lavorano insieme e vedono subito le modifiche degli altri.

> **Nome del programma e nome del file.** Il nome che si vede (menu, schermata di accesso, stampe, titolo della finestra) è
> **NefroCenter Pharmacy** e l'amministratore lo può cambiare da *Configura → Marchio e nome del programma*. Il file sul
> server resta **`GestionaleFarmacia.exe`**, come nella versione 2: con lo stesso nome restano validi il servizio di
> Windows ("Gestionale Farmacia"), la regola del firewall, la cartella `C:\GestionaleFarmacia`, la cartella `dati` con
> `farmacia.db` e `accessi.db`, gli script di installazione e le eccezioni dell'antivirus. Così chi aggiorna dalla 2.x
> sostituisce solo l'exe e non deve rifare niente.

## Novità della versione 3.0

| | Cosa c'è di nuovo |
|---|---|
| **Farmacia centrale e magazzini di piano** | Un magazzino per piano o reparto, con piano, colore, descrizione, **assortimento** (scorta minima, punto di riordino, scorta massima) e **armadi** propri. La farmacia centrale è una sola. |
| **Richieste → DDT → ricezione** | Il magazzino di piano chiede, la farmacia approva le quantità e prepara il DDT con i lotti (scade prima, esce prima), lo stampa con codice a barre e QR, sceglie chi lo porta e lo spedisce; il piano riceve contando le confezioni e segna le differenze. Mentre viaggia la merce è **"In viaggio"**. |
| **Struttura e armadi** | Mappa dell'edificio piano per piano con avvisi e DDT in viaggio; **vista grafica degli armadi** con lo stato di ogni scatola, ricerca "dove si trova" anche con il lettore, disposizione degli articoli trascinandoli. |
| **Previsioni e proposta d'ordine** | Consumo previsto a 7, 30 e 90 giorni con cinque metodi statistici scelti da soli, giorni di copertura, scorta di sicurezza, punto di riordino, classi ABC-XYZ e proposta d'ordine per fornitore in Excel. **Distribuzione**: quanto la farmacia ha dato a ogni magazzino e dove si trova la merce. |
| **Verifica in due passaggi (2FA)** | Il codice di 6 cifre dell'app del telefono (Google Authenticator, Microsoft Authenticator, FreeOTP…) oltre alla password, con 10 codici di recupero; l'amministratore decide per chi è obbligatoria. |
| **Base dati che si cura da sola** | Controlli all'avvio e ogni notte, **giornale delle modifiche**, ricostruzione automatica di un file rovinato, **copie orarie verificate** conservate a scaglioni, seconda cartella delle copie (disco esterno o di rete), pagina **Sistema** con il semaforo. |
| **Nuovo aspetto** | Stile NefroCenter, più tecnico; tema **chiaro o scuro** per ogni utente; nome, logo e colore d'accento personalizzabili; cruscotto **Oggi** con "Cosa fare adesso"; animazioni discrete (spente con "riduci il movimento"). |
| **Guide per tutto** | 26 guide scritte dettagliate (a chi serve, quando, passi con i nomi dei pulsanti, cosa succede dopo, errori frequenti), giri **🧭 Guidami** su ogni pagina e videoguide. |

L'aggiornamento da una 2.x è automatico: al primo avvio la base dati passa allo schema 3 da sola, i reparti diventano
magazzini (quello con la spunta "centrale" diventa la farmacia centrale) e tutto lo storico resta (vedi LEGGIMI).

## Installazione sul server

Istruzioni complete in [`installazione/LEGGIMI.txt`](installazione/LEGGIMI.txt) (lo stesso file è nello zip da consegnare).

1. Copia la cartella `GestionaleFarmacia` (dallo zip) in `C:\GestionaleFarmacia` sul server Windows.
2. Tasto destro su **`Installa servizio.bat`** → *Esegui come amministratore*: il programma parte a ogni accensione del server
   (attività pianificata come SYSTEM, riavvio automatico se si ferma), la porta 8080 si apre nel firewall e la cartella
   diventa leggibile solo da amministratori e SYSTEM (dentro c'è la chiave che protegge la 2FA).
3. Sul server apri `http://localhost:8080/` e crea l'**amministratore** (si può fare solo dal server).
4. Dalle postazioni: `http://<indirizzo del server>:8080/`.

Per la 2FA l'ora del server deve essere giusta (sincronizzata con NTP); per la fotocamera dei telefoni serve HTTPS.

## Ruoli

I codici dei ruoli sono quelli della 2.x; cambiano solo le etichette.

| Ruolo (codice) | Cosa può fare |
|---|---|
| **Amministratore** (`amministratore`) | Tutto, compresi utenti, struttura (magazzini e armadi), sicurezza (criterio della 2FA, azzeramento), Sistema, copie di sicurezza, marchio e impostazioni. |
| **Farmacista – farmacia centrale** (`farmacista`) | Carichi dai fornitori, richieste da evadere, DDT, consumi, perdite, inventario, anagrafica articoli, assortimenti e scorte dei magazzini, previsioni e proposta d'ordine, registro attività; annulla qualsiasi movimento. |
| **Responsabile di magazzino** (`reparto`) | Nei magazzini assegnati: consumi, perdite, richieste alla farmacia, ricezione dei DDT, resi alla farmacia, posizione degli articoli negli armadi; annulla i propri consumi e perdite; consulta tutto il resto. |
| **Direzione – sola lettura** (`consultazione`) | Vede tutto (comprese previsioni e distribuzione), stampa ed esporta in Excel, non modifica niente. |

Sicurezza: password cifrate con scrypt e da cambiare al primo accesso, verifica in due passaggi (TOTP), blocco dopo 5
tentativi sbagliati, sessioni che scadono dopo 8 ore di inattività, protezione CSRF, intestazioni di sicurezza (CSP senza
script in linea), registro attività di accessi e operazioni, HTTPS facoltativo.

## Il flusso: richiesta → DDT → ricezione

| | Chi | Pagina | Cosa fa |
|---|---|---|---|
| 1 | Magazzino di piano | Richieste → *+ Nuova richiesta* | sceglie gli articoli (anche con *✨ Proponi le quantità*, dalle scorte dell'assortimento) e preme *📨 Invia la richiesta* |
| 2 | Farmacia centrale | Richieste → *Da evadere* | *✋ Prendi in carico*, approva le quantità, *📦 Prepara DDT*: il programma sceglie i lotti (scade prima, esce prima) |
| 3 | Farmacia centrale | DDT e consegne → *Da preparare* | *🖨️ Stampa* il DDT con codice a barre e QR, *🚚 Spedisci* indicando chi trasporta e i colli: la merce è "In viaggio" |
| 4 | Magazzino di piano | DDT e consegne → *Da ricevere* | apre il DDT (anche leggendo il QR), *📥 Registra la ricezione*, conta le confezioni, *✅ Conferma la ricezione* |

- **Stati della richiesta:** bozza → inviata → in lavorazione → evasa, oppure chiusa con residuo, oppure rifiutata (con il
  motivo); chi l'ha fatta può annullarla finché la farmacia non l'ha presa in carico. Numeri `RIC-AAAA-NNNN`.
- **Stati del DDT:** in preparazione (righe modificabili, giacenze ferme) → in viaggio (la merce esce dal magazzino di
  partenza) → ricevuto, oppure ricevuto con differenze; annullato (prima della partenza non cambia niente, in viaggio la
  merce rientra). Numeri `DDT-AAAA-NNNN`, stampati anche come codice a barre e QR: leggerli apre il DDT.
- **Alla ricezione** la quantità ricevuta entra nel magazzino; quella che manca **rientra** nel magazzino di partenza oppure
  è una **perdita in viaggio**. Una ricezione non si annulla: per restituire merce si fa un DDT di reso (pagina Trasferimenti).
- **Trasferimenti** crea un DDT senza richiesta (resi alla farmacia, scambi fra piani, rifornimenti decisi dalla farmacia).
- I movimenti nati da un DDT non si annullano da Movimenti: si annulla il DDT. Nella Nota consumi il magazzino di partenza
  vede l'uscita alla data di partenza, quello di arrivo l'entrata alla data di ricezione.

## Struttura, magazzini e armadi

- **Magazzini e assortimento** (amministratore e farmacia): magazzini con tipo (farmacia centrale o magazzino di piano),
  piano, livello sulla mappa (−1 seminterrato, 0 piano terra, 1, 2…), colore e descrizione; armadi (armadio, frigorifero,
  cassettiera, carrello, cassaforte) con ripiani e posti; assortimento con scorta minima ≤ punto di riordino ≤ scorta
  massima, anche proposto dai consumi degli ultimi 90 giorni. Un magazzino già usato non si elimina: si disattiva.
- **Struttura**: lo spaccato dell'edificio, piano per piano, con gli articoli sotto scorta e in scadenza di ogni magazzino
  e i DDT in viaggio fra i piani.
- **Armadi**: ogni articolo al suo posto (ripiano e posto) con il suo stato (regolare, da riordinare, sotto scorta,
  esaurito, in scadenza, scaduto); "Dove si trova?" anche leggendo la confezione; **Disponi** per trascinare gli articoli
  (anche da tastiera) o con la disposizione automatica (per categoria e nome): nel frigorifero vanno solo gli articoli
  con la spunta *Da frigorifero 2–8 °C*, nella cassaforte solo quelli con *Stupefacente (cassaforte)*.
- **Caratteristiche dell'articolo** (pagina Articoli → *Modifica*, riquadro *Caratteristiche*): *Da frigorifero 2–8 °C*,
  *Stupefacente (cassaforte)*, *Alto rischio*, *LASA (nome o aspetto simile)*, *Urgenze*. Compaiono come etichette nella
  scheda dell'articolo e negli Armadi; le prime due decidono dove la disposizione automatica mette l'articolo. Nello
  stesso modulo *Fornitore abituale* e *Giorni di consegna* (vuoto = quelli generali di Configura) servono alle
  previsioni e alla proposta d'ordine.
- **"In transito"** è un magazzino di sistema invisibile negli elenchi: la sua giacenza è la merce in viaggio, mostrata
  nella colonna "In viaggio" delle Giacenze.

## Previsioni del fabbisogno e proposta d'ordine

Tutto si calcola nel browser dai consumi registrati (consumi + perdite), per articolo e magazzino o per tutta la struttura.

- **Metodi**: media mobile, livellamento esponenziale, Holt smorzato (tendenza che si frena), Holt-Winters (ritmo della
  settimana, con almeno 4 settimane di dati), Croston-SBA (articoli usati ogni tanto). Il programma prova ogni metodo sulle
  ultime 4 settimane come se non le conoscesse e tiene quello che sbaglia meno; a parità, il più semplice.
- **Indicatori**: consumo medio giornaliero, settimanale e mensile, tendenza, **giorni di copertura**, data stimata di
  esaurimento, fascia di incertezza al 90%.
- **Un giorno strano non pesa**: un consumo isolato molto sopra il solito (per esempio "500" scritto al posto di "5")
  si conta come la soglia nella previsione e nella scorta di sicurezza; grafico e medie mostrano il dato vero e il
  dettaglio dell'articolo lo segnala.
- **Scorta di sicurezza** = z · σ · √(giorni di consegna), con z dal livello di servizio (95% → 1,65).
  **Punto di riordino** = consumo previsto nei giorni di consegna + scorta di sicurezza.
  **Da ordinare** = consumo previsto per consegna e periodo fino al prossimo ordine + scorta di sicurezza − merce disponibile
  (giacenze di tutta la struttura e merce in viaggio), arrotondato a confezioni intere. Per un magazzino di piano
  "Da chiedere alla farmacia" toglie anche quello che ha già chiesto con richieste aperte ("📝 N già chiesti").
- I giorni di consegna sono quelli dell'articolo (*Giorni di consegna* nel suo modulo) o, se mancano, quelli generali.
- **Proposta d'ordine** divisa per fornitore (il *Fornitore abituale* dell'articolo, altrimenti quello dell'ultimo
  carico), correggibile, in Excel (un foglio per fornitore) o stampata. Il programma non manda ordini: è un aiuto per la
  farmacia.
- Per la farmacia centrale i consumi comprendono quello che dà agli altri magazzini, ma non la merce che torna indietro
  (DDT annullati in viaggio, differenze rientrate alla ricezione).
- **Classi ABC-XYZ**: A, B, C per peso sulla spesa (80/15/5%), X, Y, Z per regolarità dei consumi settimanali.
- Impostazioni in *Configura → Previsioni e ordini*: giorni di consegna del fornitore (7), ogni quanti giorni si ordina
  (7), livello di servizio (95%), storico da usare (180 giorni).

## Verifica in due passaggi (2FA)

- Standard TOTP (RFC 6238: codici di 6 cifre che cambiano ogni 30 secondi), compatibile con **Google Authenticator**,
  **Microsoft Authenticator**, **FreeOTP**, Aegis e le altre app di autenticazione. Si attiva dal proprio menu →
  *Sicurezza dell'account*: si inquadra il codice QR, si scrive il codice dell'app, si salvano i **10 codici di recupero**
  (monouso, conservati solo come impronta).
- "Ricorda questo computer per 30 giorni" (facoltativo); 5 codici sbagliati bloccano per 15 minuti; un codice già usato non
  vale una seconda volta. Dal server stesso (accesso d'emergenza) non c'è blocco, ma dopo 10 codici sbagliati si riscrive
  la password e, dopo 20 in un quarto d'ora, si aspettano 30 secondi prima di poterla riscrivere.
- **Cambia telefono** (telefono nuovo o app reinstallata) chiede la tua password prima di mostrare il codice QR nuovo:
  chi trova il programma aperto non può collegare il suo telefono al tuo utente. Il telefono vecchio vale finché non
  confermi quello nuovo; dopo 10 codici sbagliati il codice QR mostrato non vale più e si ricomincia.
- L'amministratore, dalla pagina **Sicurezza**, sceglie per chi è obbligatoria (nessuno, amministratori, amministratori e
  farmacisti, tutti) e la **azzera** a chi ha perso telefono e codici. Chi deve averla viene guidato ad attivarla al primo
  accesso.
- Il segreto di ogni utente è cifrato (AES-256-GCM) con la chiave `dati\chiave-2fa.key`, che viaggia con le copie di
  `accessi.db` nella cartella dati ma non nella seconda cartella. L'accesso d'emergenza `--reimposta-password` azzera anche
  la 2FA dell'utente.

## Base dati che si cura da sola e copie di sicurezza

- **Controlli**: rapido (`quick_check`) a ogni avvio, completo (`integrity_check`) ogni notte fra le 2 e le 6, con
  ottimizzazione.
- **Giornale delle modifiche**: dopo ogni scrittura le righe cambiate vanno in `dati\giornale\AAAA-MM-GG.jsonl`, forzate
  sul disco.
- **Cura**: un file rovinato si sposta in `dati\danneggiati\` e si ricostruisce dalla copia buona più recente più il
  giornale (o dal recupero del file stesso, se arriva più avanti); dopo uno spegnimento improvviso (anche con il file
  `-wal` sparito o rovinato) si riapplicano dal giornale le ultime scritture. Se `farmacia.db` sparisce ma resta il
  giornale, si ricostruisce da lì. Un `farmacia.db` rimesso a mano da una copia vecchia non si riporta avanti: il
  programma riparte da lì, segnala in rosso quante modifiche mancano e cosa sono, e non riusa i numeri di richieste e
  DDT già dati. Ogni cura si confronta con il registro attività, così "nessun dato perso" è vero.
- **Copie verificate**: ogni ora, se c'è stato lavoro, di `farmacia.db` e `accessi.db`; ogni copia si riapre e si
  controlla. Si tengono tutte quelle delle ultime 24 ore, poi una al giorno per 14 giorni, una alla settimana per 8
  settimane, una al mese per 12 mesi; le copie fatte a mano e quelle "prima del ripristino" le ultime 30.
- **Seconda cartella** facoltativa (disco esterno o di rete) per le copie verificate e il giornale; il giornale nuovo ci
  arriva ogni 5 minuti. *Copia adesso* aspetta che le copie arrivino anche lì (al massimo 20 secondi).
- **Pagina Sistema** (amministratore): semaforo verde/giallo/rosso con i motivi, controllo e copia a mano, **prova di
  ripristino** (ricostruisce per finta e confronta), elenco delle copie, crescita della base dati, cronologia delle cure.

## Pagine

| Pagina | Tasto | A cosa serve |
|---|---|---|
| Oggi | O | Cruscotto: sotto scorta, scaduti, in scadenza, richieste e DDT da gestire, "Cosa fare adesso" |
| Carico | C | Merce arrivata dal fornitore nella farmacia centrale, con lotto, scadenza, fornitore e documento |
| Consumi del giorno | S | Foglio dei consumi di un magazzino in una data |
| Richieste | Q | Richieste dei magazzini di piano alla farmacia centrale; per la farmacia, quelle da evadere |
| DDT e consegne | D | DDT da preparare, in viaggio, da ricevere e archivio; stampa, spedizione e ricezione |
| Trasferimenti | T | Un DDT fra due magazzini senza richiesta (resi, scambi) |
| Perdite e scaduti | P | Scaduti, rotti, smarriti, resi al fornitore |
| Struttura | K | Mappa dei piani con i magazzini e i DDT in viaggio |
| Armadi | B | Vista grafica degli armadi, "dove si trova", disposizione degli articoli |
| Giacenze | G | Giacenze per magazzino e in viaggio, valore, sotto scorta |
| Scadenze | Z | Lotti in giacenza ordinati per scadenza |
| Movimenti | M | Elenco completo con filtri, annullo con motivo, Excel |
| Inventario | I | Foglio di conta: le differenze diventano rettifiche |
| Previsioni e fabbisogno | E | Previsioni, copertura, punto di riordino, classi ABC-XYZ, proposta d'ordine |
| Distribuzione | N | Quanto la farmacia ha dato a ogni magazzino e dove si trova la merce |
| Nota consumi mensile | R | Il modulo del mese per magazzino e categoria, modificabile giorno per giorno, da stampare o esportare nel modulo Excel originale |
| Articoli | A | Anagrafica, codici a barre, fornitore abituale e giorni di consegna, caratteristiche (frigorifero, stupefacenti, alto rischio, LASA, urgenze), importazione da Excel |
| Magazzini e assortimento | W | Magazzini, armadi, assortimento e scorte |
| Utenti | U | Utenti, ruoli e magazzini (amministratore) |
| Sicurezza | Y | Criterio della 2FA, stato degli utenti, azzeramento (amministratore) |
| Attività | V | Registro di accessi e operazioni |
| Sistema | X | Salute della base dati, copie, prova di ripristino, seconda cartella (amministratore) |
| Configura | F | Marchio e nome, previsioni e ordini, copie di sicurezza, struttura |
| Guida | H | Guide scritte, videoguide e giri Guidami |

## Lettore di codici a barre

Funziona con i lettori **USB o Bluetooth** che si comportano da tastiera (tutti quelli comuni): non serve configurare niente.
Il programma riconosce la lettura anche se il cursore è in un altro campo e non la confonde con chi scrive a mano. Su
telefono e tablet c'è anche il pulsante **📷 Fotocamera** (Chrome o Edge, con l'indirizzo in **HTTPS**: vedi LEGGIMI).

Codici riconosciuti: **Data Matrix GS1** delle confezioni dei farmaci e dei dispositivi medici (GTIN, lotto, scadenza e, se
c'è, l'AIC), **Code 32 / AIC** dei farmaci italiani, **EAN-13 / EAN-8 / UPC**, il codice a barre e il QR dei **DDT** e
qualsiasi altro codice interno.

| Pagina | Cosa fa una lettura |
|---|---|
| Carico | aggiunge la riga dell'articolo; lotto e scadenza arrivano dal Data Matrix (per confezione o per unità) |
| Consumi del giorno, Inventario | aggiunge al consumo o alla quantità contata |
| Perdite, nuova richiesta, Trasferimenti, modifica del DDT | aggiunge la riga (e il lotto letto, se è disponibile) |
| Ricezione di un DDT | conta le confezioni ricevute, riga per riga |
| DDT e consegne | il codice o il QR stampato sul DDT apre il DDT |
| Armadi | mostra dove si trova l'articolo |
| Altre pagine | apre la scheda dell'articolo |

Un codice mai visto si associa una volta all'articolo giusto (o a un articolo nuovo) da chi può modificare l'anagrafica; da
lì in poi viene riconosciuto da tutte le postazioni.

## Guide, Guidami e videoguide

- **Guida** (tasto H): per ogni operazione una **guida scritta** completa — a chi serve, quando si usa, i passi con i nomi
  esatti di pulsanti e campi, cosa succede dopo, gli errori frequenti e come risolverli — con ricerca, filtro per argomento
  e "solo quelle che mi servono". Dove c'è, il **video** mostra gli stessi passi con i sottotitoli; finché il video non c'è
  la scheda apre la guida scritta, e un video girato per la versione precedente è segnalato come tale. Guide: primo accesso, password, verifica in due passaggi, marchio e tema, carico,
  lettore, consumi, richieste, DDT e consegne, ricezione, trasferimenti, perdite, struttura, armadi, giacenze e scadenze,
  movimenti, inventario, previsioni e ordini, distribuzione, nota consumi, articoli, magazzini e assortimento, utenti,
  registro attività, sistema, copie di sicurezza.
- **🧭 Guidami** (in alto, su ogni pagina, e "Guidami sulla pagina" in ogni guida): evidenzia sullo schermo, uno alla volta,
  gli elementi della pagina e spiega cosa fare. Non registra niente e non preme pulsanti al posto tuo. Al primo accesso di
  ogni utente propone un giro di un minuto.

## Aspetto: marchio, nome, colore e tema

- Ogni utente sceglie dal proprio menu il tema **Chiaro**, **Scuro** o **Automatico** (come il computer).
- L'amministratore, in *Configura → Marchio e nome del programma*, sceglie nome del programma, sigla, nome della struttura,
  sottotitolo, logo (marchio della struttura, nessuno o un'immagine caricata, sotto i 400 KB), colore d'accento e tema
  predefinito. Il titolo della finestra è "pagina · nome del programma · struttura".
- Caratteri locali (nessun collegamento a internet): Manrope per i titoli, Inter per il testo, JetBrains Mono per codici,
  lotti e numeri dei documenti.

## Anteprima

`npm run anteprima` prepara `dist/anteprima/`: la stessa interfaccia con un server simulato dentro il browser, dati di prova
(151 giorni di consumi, richieste e DDT in ogni stato) e gli utenti `admin`, `farma`, `reparto`, `reparto2`, `direzione` e
`sicura` (farmacista con la 2FA attiva: il codice del momento compare nella banda), tutti con password `prova`. Un "collega"
registra consumi per vedere gli aggiornamenti in tempo reale e ci sono codici a barre di prova da "leggere" con un clic.
L'anteprima usa nomi dimostrativi ("Clinica Demo") e nessun logo; i dati spariscono ricaricando la pagina.

## Nota consumi e modulo Excel

Colonne calcolate come nel modulo: residui mesi precedenti (2), carichi (3: carichi dai fornitori, merce ricevuta con i DDT
alla data di ricezione, rettifiche in aumento), totale carico (4 = 2+3), consumi giornalieri 1-31 (per la farmacia centrale
comprendono la merce mandata agli altri magazzini, alla data di partenza del DDT; la merce che torna indietro con un DDT
annullato o una differenza "rientra" non è un carico ma toglie quell'uscita), totale consumo (6), perdite (7), totale
scarico (8 = 6+7), controllo scadenze (9), residui (10 = 4−8), prezzo unitario e importo. **Esporta nel modulo Excel**
compila il file originale della clinica (`modelli/`) con le stesse celle e impaginazione; oltre 48 articoli aggiunge altri
fogli identici.

Consumi, perdite e DDT scalano per primo il lotto che scade prima (la ripartizione la fa il server, dentro la stessa
transazione, così due utenti non possono prelevare lo stesso lotto). I lotti già scaduti non si usano da soli per consumi
e DDT (si tolgono con una perdita "Scaduto"; nelle tendine sono segnati SCADUTO); per un reso il lotto scaduto si sceglie
a mano. I movimenti non si cancellano: si annullano con un
motivo e restano visibili.

## Librerie e caratteri open source

Tutto è incorporato nel programma (nessun collegamento a internet); le licenze sono in `vendor/LICENZE/` e nello zip da
consegnare (`LICENZA-*.txt` accanto all'exe).

| Componente | Uso | Licenza |
|---|---|---|
| [Node.js](https://nodejs.org/) 22 (con SQLite integrato, `node:sqlite`) | il server e l'exe | MIT (SQLite: pubblico dominio) |
| [ExcelJS](https://github.com/exceljs/exceljs) 4.4 | Excel: modulo Nota consumi, esportazioni, importazione | MIT |
| [Apache ECharts](https://echarts.apache.org/) 6.1.0 | grafici (previsioni, distribuzione, Oggi, Sistema) | Apache-2.0 |
| [anime.js](https://animejs.com/) 4.5.0 | animazioni (armadi, mappa, cruscotto) | MIT |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 | QR della 2FA e dei DDT | MIT |
| [Manrope](https://github.com/davelab6/manrope), [Inter](https://rsms.me/inter/), [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | caratteri | SIL Open Font License 1.1 |

Per compilare (non incorporati): [esbuild](https://esbuild.github.io/) (MIT), [postject](https://github.com/nodejs/postject)
(MIT), [resedit](https://github.com/jet2jet/resedit-js) (MIT); per le prove e le videoguide
[Playwright](https://playwright.dev/) (Apache-2.0) e ffmpeg.

## Come è fatto

```
server/main.js           avvio, argomenti (--porta, --dati, --host, --reimposta-password), configurazione.json, HTTPS
server/http.js           API JSON, file dell'interfaccia, notifiche in tempo reale (Server-Sent Events), sicurezza
server/accessi.js        utenti, password (scrypt), 2FA (TOTP), sessioni, ruoli e permessi, registro attività
server/operazioni.js     movimenti (ripartizione sui lotti), articoli, impostazioni, importazioni
server/logistica.js      richieste, DDT, spedizione, ricezione (parte A)
server/struttura.js      magazzini, armadi, assortimento, ubicazioni (parte B)
server/sicurezza.js      rotte della verifica in due passaggi e del criterio (parte C)
server/giornale.js       giornale delle modifiche (parte E)
server/backup.js         copie orarie verificate, scaglioni, seconda cartella, ripristino (parte E)
server/salute.js         controlli, cura dei file danneggiati, prova di ripristino, pagina Sistema (parte E)
server/db.js             SQLite: farmacia.db (magazzino, schema 3) e accessi.db (utenti e attività, schema 2)
index.html, css/, js/    interfaccia (servita dal server); js/calcoli.js, js/barcode.js, js/totp.js condivisi col server
js/pagine-*.js           pagine della 3.0: cruscotto, logistica, struttura, analisi, sistema, configura
js/previsioni.js         modelli di previsione e indicatori (solo nel browser)
js/tour.js, js/guide.js  Guidami e pagina Guida (guide/: video, copertine, sottotitoli)
vendor/, fonts/, brand/  librerie, caratteri e marchio della struttura
installazione/           script per l'avvio automatico su Windows, LEGGIMI.txt, esempio di configurazione
anteprima/               server simulato nel browser per l'anteprima
strumenti/               compilazione dell'exe, anteprima, videoguide, prove nel browser
docs/ARCHITETTURA.md     architettura, base dati, API, sicurezza
docs/NOVITA-3.0.md       contratto fra le parti della 3.0 e decisioni prese
```

Dati nella cartella `dati` accanto al programma: `farmacia.db`, `accessi.db`, `chiave-2fa.key`, `salute.json`, `backup/`,
`giornale/`, `danneggiati/` (solo se una cura è servita), `log/`, e il facoltativo `configurazione.json`.

## Sviluppo

Serve Node.js 22.13 o successivo.

```
npm ci
npm start               # server su http://localhost:8080 (dati in ./dati)
npm test                # prove: calcoli, Excel, codici a barre, TOTP, previsioni, API, logistica, struttura, sicurezza, cura
npm run exe             # dist/GestionaleFarmacia/GestionaleFarmacia.exe e lo zip da consegnare
npm run exe:linux       # eseguibile Linux con lo stesso contenuto, per le prove
GF_ESEGUIBILE=dist/gestionale-farmacia-linux node --test tests/server.test.js   # prove sull'eseguibile compilato
node strumenti/prova-interfaccia.js   # prova nel browser con più utenti insieme
node strumenti/prova-tour.js          # tutti i giri di Guidami (--solo <ruoli>, --schermi desktop|telefono)
node strumenti/genera-videoguide.js   # rigenera le videoguide (serve ffmpeg; --solo carico,lettore per alcune)
npm run anteprima                     # dist/anteprima/
```

L'exe è Node.js 22 in versione *single executable application*: il server (unito con esbuild) e i file dell'interfaccia
sono incorporati come risorse in `node.exe` per Windows x64, scaricato da nodejs.org e controllato con SHA-256; icona e
informazioni di versione sono della Clinica. Non è firmato digitalmente: al primo avvio Windows può chiedere conferma.
Il workflow `.github/workflows/exe-windows.yml` lo compila e lo prova su Windows a ogni modifica e lo rende scaricabile.

Se cambia il modulo in `modelli/`, rigenerare `js/modello.js` con `npm run modello`.
