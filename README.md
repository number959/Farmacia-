# Gestionale Farmacia · Clinica Posillipo (Longevity Institute)

Programma per il **carico e scarico di farmaci e presidi** della Clinica Posillipo. Sostituisce i fogli Excel
`Carico_Scarico_FARMACIA_POSILLIPO.xlsx` e `Carico_Scarico_PRESIDI_POSILLIPO.xlsx`: ogni movimento si registra una volta
sola e a fine mese la **Nota consumi medicinali e materiali di medicazione** di ogni reparto è già compilata, nello stesso
modulo di sempre.

L'impostazione è quella del Gestionale Agende: menu a sinistra con un tasto rapido per ogni pagina, pagina **Oggi** con
quello che c'è da fare, ricerca rapida (Ctrl K), stampe ed Excel, copie di sicurezza automatiche, dati che restano in clinica.

## Avvio

Non serve installare niente.

1. Copia la cartella sul PC (per esempio in `Documenti\Gestionale Farmacia`).
2. Fai doppio clic su **`Apri Gestionale Farmacia.bat`**: si apre in una finestra sua di Microsoft Edge.
   In alternativa apri `index.html` con Edge o Chrome.
3. Al primo avvio: in **Configura** scrivi il nome dell'operatore e controlla i reparti; poi inserisci gli articoli
   (o importali da Excel) e registra le giacenze iniziali.

Per provarlo subito: **Configura → Carica dati di prova** (dati inventati, sostituiscono l'archivio).

## Pagine

| Pagina | Tasto | A cosa serve |
|---|---|---|
| Oggi | O | Riepilogo: articoli sotto scorta, lotti scaduti o in scadenza, movimenti del giorno |
| Carico | C | Merce arrivata dal fornitore, con lotto, scadenza, fornitore e DDT |
| Consumi del giorno | S | Foglio dei consumi di un reparto in una data: si scrivono le quantità e si registra |
| Trasferimenti | T | Dalla Farmacia ai reparti (o tra reparti), con il lotto che si sposta |
| Perdite e scaduti | P | Scaduti, rotti, smarriti, resi al fornitore |
| Giacenze | G | Giacenze per reparto, valore del magazzino, sotto scorta |
| Scadenze | Z | Lotti in giacenza ordinati per scadenza; i lotti scaduti si tolgono con un clic |
| Movimenti | M | Elenco completo con filtri, annullo con motivo, esportazione Excel |
| Inventario | I | Foglio di conta: le differenze diventano rettifiche |
| Nota consumi mensile | R | Il modulo del mese per reparto e categoria (Farmaci o Presidi), modificabile giorno per giorno, da stampare o esportare |
| Articoli | A | Anagrafica, importazione da Excel |
| Configura | F | Struttura, operatore, reparti, copie di sicurezza |
| Guida | H | Istruzioni |

## Nota consumi e modulo Excel

La pagina **Nota consumi mensile** calcola le colonne del modulo:

- **Residui mesi prec.** (2): giacenza del reparto alla fine del mese precedente
- **Carichi** (3): carichi, trasferimenti ricevuti, rettifiche d'inventario in aumento
- **Totale carico** (4 = 2+3)
- **Consumi giornalieri** 1-31 (per la Farmacia comprendono i trasferimenti ai reparti)
- **Totale consumo** (6), **Perdite** (7, comprese le rettifiche in diminuzione), **Totale scarico** (8 = 6+7)
- **Controllo scadenze** (9): la scadenza più vicina tra i lotti rimasti
- **Residui** (10 = 4−8), **Prezzo unitario** e importo dello scarico

**Esporta nel modulo Excel** compila il file originale della clinica (in `modelli/`), con le stesse celle, bordi e
impaginazione; oltre 48 articoli aggiunge altri fogli identici. La seconda pagina del modulo originale aveva le intestazioni
di una versione precedente (“Importo scarico”, “6-10”): nell'esportazione sono allineate a quelle della prima pagina.

## Lotti e scadenze

Consumi, perdite e trasferimenti scalano per primo il lotto che scade prima; se serve, nella riga si sceglie un lotto preciso.
I movimenti non si cancellano: si **annullano** con un motivo e restano visibili, barrati.

## Dove stanno i dati

- Nel browser di quel PC (IndexedDB), salvati a ogni modifica. Usare sempre lo stesso browser e non una finestra anonima.
- Una **copia automatica al giorno**, ultime 30, ripristinabile da Configura.
- **Copia su file sempre aggiornata** (Edge e Chrome): si sceglie un file, per esempio su una cartella di rete; dopo ogni
  riavvio del browser si riattiva con un clic.
- **Salva una copia (.json)** e **Ripristina** per le copie su chiavetta. La pagina Oggi ricorda di farla ogni 7 giorni.

## Struttura del codice

```
index.html                 pagina dell'applicazione
css/app.css                stile
js/calcoli.js              giacenze, lotti, scadenze, nota consumi (funzioni pure, provate con i test)
js/archivio.js             archivio IndexedDB, copie automatiche, copia su file
js/excel.js                esportazione nel modulo originale, elenchi Excel, importazione articoli
js/modello.js              modulo Excel incorporato (generato da strumenti/genera-modello.js)
js/app.js                  nucleo: menu, tasti rapidi, ricerca, finestre, salvataggio
js/pagine.js               le pagine
js/demo.js                 dati di prova
vendor/exceljs.min.js      ExcelJS 4.4.0 (licenza MIT, vendor/exceljs.LICENSE)
modelli/                   moduli Excel originali FARMACIA e PRESIDI
tests/                     prove automatiche
```

Prove automatiche (Node 18 o successivo):

```
npm test
```

Se cambia il modulo in `modelli/`, rigenerare `js/modello.js` con `npm run modello`.
