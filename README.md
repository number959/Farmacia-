# Gestionale Farmacia · Clinica Posillipo (Longevity Institute)

Programma per il **carico e scarico di farmaci e presidi** della Clinica Posillipo. Sostituisce i fogli Excel
`Carico_Scarico_FARMACIA_POSILLIPO.xlsx` e `Carico_Scarico_PRESIDI_POSILLIPO.xlsx`: ogni movimento si registra una volta
sola e a fine mese la **Nota consumi medicinali e materiali di medicazione** di ogni reparto è già compilata, nello stesso
modulo di sempre.

**Versione 2: server multiutente.** Un solo eseguibile, `GestionaleFarmacia.exe`, gira sul server virtuale della clinica;
le postazioni lo usano dal browser (Edge o Chrome) all'indirizzo del server, senza installare niente. Ogni persona entra
con il proprio utente, i ruoli decidono cosa può fare, più persone lavorano insieme e vedono subito le modifiche degli altri.

L'impostazione è quella del Gestionale Agende: menu a sinistra con un tasto rapido per ogni pagina, pagina **Oggi** con
quello che c'è da fare, ricerca rapida (Ctrl K), stampe ed Excel, copie di sicurezza automatiche, dati che restano in clinica.

## Installazione sul server

Istruzioni complete in [`installazione/LEGGIMI.txt`](installazione/LEGGIMI.txt) (lo stesso file è nello zip da consegnare).

1. Copia la cartella `GestionaleFarmacia` (dallo zip) in `C:\GestionaleFarmacia` sul server Windows.
2. Tasto destro su **`Installa servizio.bat`** → *Esegui come amministratore*: il programma parte a ogni accensione del server
   (attività pianificata come SYSTEM, riavvio automatico se si ferma) e la porta 8080 si apre nel firewall.
3. Sul server apri `http://localhost:8080/` e crea l'**amministratore** (si può fare solo dal server).
4. Dalle postazioni: `http://<indirizzo del server>:8080/`.

## Ruoli

| Ruolo | Può |
|---|---|
| Amministratore | tutto: utenti, impostazioni, reparti, copie di sicurezza, registro attività |
| Farmacista | carichi, trasferimenti, consumi, perdite, inventario, anagrafica articoli, correzioni del registro mensile, annullo di qualsiasi movimento |
| Reparto | consumi e perdite **solo dei propri reparti**; consulta tutto il resto |
| Consultazione | solo lettura, stampe ed Excel (per esempio la direzione sanitaria) |

Sicurezza: password cifrate con scrypt e da cambiare al primo accesso, blocco dopo 5 tentativi sbagliati, sessioni che
scadono dopo 8 ore di inattività, protezione CSRF, registro attività di accessi e operazioni, HTTPS facoltativo.

## Pagine

| Pagina | Tasto | A cosa serve |
|---|---|---|
| Oggi | O | Riepilogo: articoli sotto scorta, lotti scaduti o in scadenza, movimenti del giorno |
| Carico | C | Merce arrivata dal fornitore, con lotto, scadenza, fornitore e DDT |
| Consumi del giorno | S | Foglio dei consumi di un reparto in una data |
| Trasferimenti | T | Dalla Farmacia ai reparti (o tra reparti), con il lotto che si sposta |
| Perdite e scaduti | P | Scaduti, rotti, smarriti, resi al fornitore |
| Giacenze | G | Giacenze per reparto, valore del magazzino, sotto scorta |
| Scadenze | Z | Lotti in giacenza ordinati per scadenza |
| Movimenti | M | Elenco completo con filtri, annullo con motivo, Excel |
| Inventario | I | Foglio di conta: le differenze diventano rettifiche |
| Nota consumi mensile | R | Il modulo del mese per reparto e categoria, modificabile giorno per giorno, da stampare o esportare nel modulo Excel originale |
| Articoli | A | Anagrafica, importazione da Excel |
| Utenti | U | Utenti e ruoli (amministratore) |
| Attività | V | Registro di accessi e operazioni |
| Configura | F | Struttura, reparti, copie di sicurezza |
| Guida | H | Istruzioni |

## Nota consumi e modulo Excel

Colonne calcolate come nel modulo: residui mesi precedenti (2), carichi (3), totale carico (4 = 2+3), consumi giornalieri
1-31 (per la Farmacia comprendono i trasferimenti ai reparti), totale consumo (6), perdite (7), totale scarico (8 = 6+7),
controllo scadenze (9), residui (10 = 4−8), prezzo unitario e importo. **Esporta nel modulo Excel** compila il file originale
della clinica (`modelli/`) con le stesse celle e impaginazione; oltre 48 articoli aggiunge altri fogli identici.

Consumi, perdite e trasferimenti scalano per primo il lotto che scade prima (la ripartizione la fa il server, dentro la
stessa transazione, così due utenti non possono prelevare lo stesso lotto). I movimenti non si cancellano: si annullano
con un motivo e restano visibili.

## Come è fatto

```
server/main.js           avvio, argomenti (--porta, --dati, --host), log, HTTPS facoltativo
server/http.js           API JSON, file dell'interfaccia, notifiche in tempo reale (Server-Sent Events), sicurezza
server/accessi.js        utenti, password (scrypt), sessioni, ruoli e permessi, registro attività
server/operazioni.js     movimenti (con ripartizione sui lotti), articoli, reparti, impostazioni, importazioni
server/backup.js         copie automatiche giornaliere, copie manuali, ripristino
server/db.js             database SQLite (node:sqlite): farmacia.db (magazzino) e accessi.db (utenti e attività)
index.html, css/, js/    interfaccia (servita dal server); js/calcoli.js è condiviso con il server
installazione/           script per l'avvio automatico su Windows e LEGGIMI.txt
strumenti/compila-exe.js compilazione dell'exe
docs/ARCHITETTURA.md     architettura, ruoli e contratto dell'API
```

Dati nella cartella `dati` accanto al programma: `farmacia.db`, `accessi.db`, `backup/` (copie giornaliere, ultime 30),
`log/`.

## Sviluppo

Serve Node.js 22.13 o successivo.

```
npm ci
npm start               # server su http://localhost:8080 (dati in ./dati)
npm test                # prove: calcoli, modulo Excel, API del server
npm run exe             # dist/GestionaleFarmacia/GestionaleFarmacia.exe e lo zip da consegnare
npm run exe:linux       # eseguibile Linux con lo stesso contenuto, per le prove
GF_ESEGUIBILE=dist/gestionale-farmacia-linux node --test tests/server.test.js   # prove sull'eseguibile compilato
```

L'exe è Node.js 22 in versione *single executable application*: il server (unito con esbuild) e i file dell'interfaccia
sono incorporati come risorse in `node.exe` per Windows x64, scaricato da nodejs.org e controllato con SHA-256; icona e
informazioni di versione sono della Clinica. Non è firmato digitalmente: al primo avvio Windows può chiedere conferma.
Il workflow `.github/workflows/exe-windows.yml` lo compila e lo prova su Windows a ogni modifica e lo rende scaricabile.

Se cambia il modulo in `modelli/`, rigenerare `js/modello.js` con `npm run modello`.
