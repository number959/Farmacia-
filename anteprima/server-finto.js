/*
 * ANTEPRIMA del programma: un server simulato dentro il browser (versione 3.0).
 * Risponde alle stesse richieste del server vero, con le stesse regole, gli stessi stati, le stesse numerazioni e gli
 * stessi messaggi (server/operazioni.js, server/logistica.js, server/struttura.js, server/accessi.js, server/sicurezza.js,
 * server/http.js), tenendo i dati in memoria: magazzini, armadi, assortimenti, richieste, DDT, utenti di prova, verifica
 * in due passaggi vera (js/totp.js), registro attività, copie. Lo stato della base dati (/api/sistema) è un esempio.
 * Si carica subito dopo js/calcoli.js e js/demo.js e intercetta fetch('api/…') ed EventSource('api/eventi').
 * Marchio neutro: nessun nome di una struttura reale (docs/NOVITA-3.0.md, "Anteprima pubblicata").
 * Non è usato dal programma vero: serve solo per provarlo senza installare niente.
 */
(function (root) {
  'use strict';

  var C = root.Calcoli;
  function T() { return root.Totp; } // js/totp.js si carica dopo questo file
  function B() { return root.Barcode; } // anche js/barcode.js

  var PASSWORD = 'prova';
  var VERSIONE = '3.0 · anteprima';
  var ID_TRANSITO = 'r-transito';
  var NOME_TRANSITO = 'In transito';
  var AVVIO = new Date().toISOString();

  /* ======================= stato in memoria ======================= */

  // revisione di partenza verosimile: cinque mesi di lavoro (le righe dei dati di prova contano come già lette)
  var rev = 4817;
  var REV_INIZIALE = rev; // per "scritte in questa sessione" (pagina Sistema)
  var revBase = 0;
  var storia = Math.random().toString(16).slice(2);
  var revRiga = {};          // 'tabella|id' -> revisione dell'ultima modifica
  var cancellati = [];       // { tabella, id, rev }
  var meta = {};             // contatori dei numeri: prog_ric_AAAA, prog_ddt_AAAA
  var eventi = [];
  var nEventi = 0;
  var sessione = null;       // utente collegato in questa pagina (record interno)
  var ascoltatori = [];
  var seq = 0;
  var ultimoCreato = 0;

  function due(n) { return String(n).padStart(2, '0'); }
  function oggi(piu) {
    var d = new Date();
    d.setDate(d.getDate() + (piu || 0));
    return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate());
  }
  function copia(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  // id come quelli del server vero (prefisso + 12 caratteri base64url), più un contatore: mai due uguali
  var ALFABETO_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function nuovoId(prefisso) {
    var b = new Uint8Array(9);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(b);
    else for (var j = 0; j < 9; j++) b[j] = Math.floor(Math.random() * 256);
    var s = '';
    for (var i = 0; i < 9; i++) s += ALFABETO_ID.charAt(b[i] & 63);
    return prefisso + '-' + s + (++seq).toString(36);
  }

  // marchio neutro: l'anteprima pubblica non usa il nome né il marchio di una struttura reale
  var IMPOSTAZIONI_PREDEFINITE = {
    nomeProdotto: 'Pharmacy · anteprima',
    sigla: 'Pharmacy',
    struttura: 'Clinica Demo',
    sottotitolo: 'Ospedale di prova',
    societa: 'Società Demo S.r.l.',
    citta: 'Città Demo',
    logo: 'nessuno',
    giorniAvvisoScadenza: 90,
    codiceModulo: 'MOD-DEMO 1.0',
    coloreAccento: '',
    tema: 'automatico',
    leadTimeGiorni: 7,
    periodoRevisioneGiorni: 7,
    livelloServizio: 0.95,
    storicoGiorni: 180,
    richiedi2fa: 'nessuno'
  };

  var S = {
    impostazioni: copia(IMPOSTAZIONI_PREDEFINITE),
    reparti: [
      { id: 'r-farmacia', nome: 'Farmacia centrale', centrale: true, attivo: true, ordine: 0, tipo: 'centrale', piano: 'Piano terra', livello: 0, colore: '#1c4184', descrizione: 'Riceve dai fornitori, rifornisce i reparti e prepara i DDT' },
      { id: 'r-degenza', nome: 'Degenza 1° piano', centrale: false, attivo: true, ordine: 1, tipo: 'periferico', piano: '1° piano', livello: 1, colore: '#0f8b8d', descrizione: 'Medicina interna, 20 posti letto' },
      { id: 'r-degenza2', nome: 'Degenza 2° piano', centrale: false, attivo: true, ordine: 2, tipo: 'periferico', piano: '2° piano', livello: 2, colore: '#7a4fa3', descrizione: 'Chirurgia e ortopedia, 16 posti letto' },
      { id: 'r-sala', nome: 'Sala operatoria', centrale: false, attivo: true, ordine: 3, tipo: 'periferico', piano: '1° piano', livello: 1, colore: '#d9822b', descrizione: 'Due sale, interventi dal lunedì al venerdì' },
      { id: 'r-ambulatori', nome: 'Ambulatori', centrale: false, attivo: true, ordine: 4, tipo: 'periferico', piano: 'Piano terra', livello: 0, colore: '#2e8b57', descrizione: 'Medicazioni e piccola chirurgia, chiusi la domenica' },
      { id: ID_TRANSITO, nome: NOME_TRANSITO, centrale: false, attivo: true, ordine: 9999, tipo: 'transito', piano: '', livello: 0, colore: '', descrizione: 'Merce partita con un DDT e non ancora ricevuta' }
    ],
    articoli: [], movimenti: [], armadi: [], assortimento: [], richieste: [], richiesteRighe: [], ddt: [], ddtRighe: []
  };
  var TABELLE = ['reparti', 'articoli', 'movimenti', 'armadi', 'assortimento', 'richieste', 'richiesteRighe', 'ddt', 'ddtRighe'];

  /* ---------- utenti di prova (password "prova"; un utente ha già la verifica in due passaggi) ---------- */

  // chiave dell'app dell'utente "sicura": la banda dell'anteprima mostra il codice del momento
  var SEGRETO_DIMOSTRATIVO = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  var RECUPERO_DIMOSTRATIVO = ['k7m2p-q9x4a', 'h3t8w-z2c6r', 'b5n9d-x4k7m', 'p2r6v-w8h3t', 'c9x4z-m2k7q', 'd6w3h-r8n2p', 'f4q8x-t3m9k', 'g7z2c-v5r8w', 'j3k9m-p6x2d', 'n8v4r-h2z7c'];
  var RUOLI = { amministratore: 'Amministratore', farmacista: 'Farmacista (farmacia centrale)', reparto: 'Responsabile di magazzino', consultazione: 'Direzione (sola lettura)' };
  function utenteDiProva(id, username, nome, ruolo, reparti) {
    return { id: id, username: username, nome: nome, ruolo: ruolo, reparti: reparti || [], attivo: true, cambioPassword: false, ultimoAccesso: null,
      password: null, totpSegreto: null, totpAttivo: false, totpAttivatoIl: null, totpUltimoPasso: 0, codiciRecupero: [], tentativi2fa: 0, bloccatoFino: 0 };
  }
  var UTENTI = [
    utenteDiProva('u-admin', 'admin', 'Giovanni Amministratore', 'amministratore'),
    utenteDiProva('u-farma', 'farma', 'Maria Farmacista', 'farmacista'),
    utenteDiProva('u-reparto', 'reparto', 'Luca Infermiere', 'reparto', ['r-degenza']),
    utenteDiProva('u-reparto2', 'reparto2', 'Sara Infermiera', 'reparto', ['r-degenza2']),
    utenteDiProva('u-direzione', 'direzione', 'Direzione Sanitaria', 'consultazione'),
    utenteDiProva('u-sicura', 'sicura', 'Chiara Verdi', 'farmacista')
  ];
  (function () {
    var u = UTENTI[5];
    u.totpSegreto = SEGRETO_DIMOSTRATIVO;
    u.totpAttivo = true;
    var d = new Date();
    d.setDate(d.getDate() - 21);
    u.totpAttivatoIl = d.toISOString();
  })();

  /* ---------- dati di prova (js/demo.js): cinque mesi di lavoro della struttura ---------- */

  (function caricaDatiDiProva() {
    var nomi = {};
    S.reparti.forEach(function (r) { nomi[r.id] = r.nome; });
    var demo = root.DemoFarmacia.creaCompleta(C, {
      centrale: 'r-farmacia', reparti: ['r-degenza', 'r-degenza2', 'r-sala', 'r-ambulatori'], oggi: new Date(), conOggi: true, transito: ID_TRANSITO, nomi: nomi,
      persone: {
        farmacista: { id: 'u-farma', nome: 'Maria Farmacista' }, trasportatore: 'Paolo Russo (magazzino)',
        magazzini: {
          'r-degenza': { id: 'u-reparto', nome: 'Luca Infermiere' }, 'r-degenza2': { id: 'u-reparto2', nome: 'Sara Infermiera' },
          'r-sala': { id: null, nome: 'Inf. Paola Neri' }, 'r-ambulatori': { id: null, nome: 'Inf. Marco Gallo' }
        }
      }
    });
    // qualche codice a barre di prova, per provare il lettore (vedi la banda dell'anteprima)
    var codici = { 'demo-f0': ['aic:012745093'], 'demo-f3': ['gtin:08001234567897'], 'demo-p1': ['gtin:04015630982912'] };
    S.articoli = demo.articoli.map(function (a) {
      return { id: a.id, nome: a.nome, categoria: a.categoria, unita: a.unita || '', principio: a.principio || '', confezione: a.confezione || '', codice: '',
        prezzo: a.prezzo || 0, scortaMinima: a.scortaMinima || 0, note: '', attivo: true, versione: 1, barcode: codici[a.id] || [],
        pezziConfezione: a.pezziConfezione > 0 ? a.pezziConfezione : 1, attributi: (a.attributi || []).slice(), leadTime: a.leadTime === undefined ? null : a.leadTime,
        fornitore: a.fornitore || '' };
    });
    S.movimenti = demo.movimenti.map(function (m) {
      return { id: m.id, tipo: m.tipo, data: m.data, articoloId: m.articoloId, repartoId: m.repartoId, repartoDestId: m.repartoDestId || undefined,
        quantita: m.quantita, lotto: m.lotto || '', scadenza: m.scadenza || '', fornitore: m.fornitore || '', documento: m.documento || '',
        causale: m.causale || '', note: m.note || '', prezzo: m.prezzo === undefined || m.prezzo === null ? undefined : m.prezzo,
        operatore: m.operatore || 'Dati di prova', utenteId: m.utenteId || undefined, creato: m.creato, annullato: null, ddtId: m.ddtId || null };
    });
    ['armadi', 'assortimento', 'richieste', 'richiesteRighe', 'ddt', 'ddtRighe'].forEach(function (t) { S[t] = demo[t]; });
    // i contatori dei numeri ripartono da quelli dei dati di prova
    S.richieste.forEach(function (r) { var k = 'prog_ric_' + r.anno; meta[k] = Math.max(meta[k] || 0, r.progressivo); });
    S.ddt.forEach(function (d) { var k = 'prog_ddt_' + d.anno; meta[k] = Math.max(meta[k] || 0, d.progressivo); });
    S.movimenti.forEach(function (m) { if (m.creato > ultimoCreato) ultimoCreato = m.creato; });
    var ieri = new Date(Date.now() - 86400000);
    UTENTI.forEach(function (u, i) { u.ultimoAccesso = new Date(ieri.getTime() + i * 1800000).toISOString(); });
    registroDiProva(nomi);
  })();

  /*
   * Registro attività dei dati di prova: gli ultimi 10 giorni di richieste e DDT (stesse azioni e stessi dettagli del
   * server vero), gli accessi di ogni mattina, i consumi della sera e l'attivazione della verifica in due passaggi.
   * Solo per le persone che hanno un utente nell'anteprima.
   */
  function registroDiProva(nomi) {
    var dal = new Date(Date.now() - 10 * 86400000).toISOString();
    var lista = [];
    var ip = { 'u-admin': '10.0.0.21', 'u-farma': '10.0.0.34', 'u-reparto': '10.0.1.12', 'u-reparto2': '10.0.2.15', 'u-direzione': '10.0.0.8', 'u-sicura': '10.0.0.35' };
    function chiE(id) { return UTENTI.filter(function (u) { return u.id === id; })[0] || null; }
    function chiNome(nome) { return UTENTI.filter(function (u) { return u.nome === nome; })[0] || null; }
    function ev(u, quando, azione, dettagli) {
      if (!u || !quando || quando < dal) return;
      lista.push({ quando: quando, username: u.username, azione: azione, dettagli: dettagli, ip: ip[u.id] || '10.0.0.40' });
    }
    function nomeArt(id) { var a = articolo(id); return a ? a.nome : id; }
    S.richieste.forEach(function (r) {
      var righe = S.richiesteRighe.filter(function (x) { return x.richiestaId === r.id; });
      var chi = chiE(r.creataDa);
      ev(chi, r.creataIl, 'richieste.crea', { numero: r.numero, reparto: nomi[r.repartoId], fornitore: nomi[r.fornitoreId], urgente: r.urgente || undefined, inviata: false,
        righe: righe.map(function (x) { return { articolo: nomeArt(x.articoloId), quantita: x.quantita }; }) });
      ev(chi, r.inviataIl, 'richieste.invia', { numero: r.numero });
      if (r.presaIl && r.stato !== 'rifiutata') ev(chiE(r.presaDa), r.presaIl, 'richieste.prendi', { numero: r.numero });
      if (r.stato === 'rifiutata') ev(chiE(r.chiusaDa), r.chiusaIl, 'richieste.rifiuta', { numero: r.numero, motivo: r.motivo });
      if (r.stato === 'annullata') ev(chiE(r.chiusaDa), r.chiusaIl, 'richieste.annulla', { numero: r.numero, motivo: r.motivo });
      if (r.stato === 'chiusa') ev(chiE(r.chiusaDa), r.chiusaIl, 'richieste.chiudi', { numero: r.numero, motivo: r.motivo, righeConResiduo: 1 });
    });
    S.ddt.forEach(function (d) {
      var righe = S.ddtRighe.filter(function (x) { return x.ddtId === d.id; });
      var ric = d.richiestaId ? richiesta(d.richiestaId) : null;
      var prep = chiE(d.preparatoDa);
      if (ric) ev(prep, d.preparatoIl, 'ddt.crea', { numero: d.numero, richiesta: ric.numero, da: nomi[d.origineId], a: nomi[d.destinazioneId] });
      else ev(prep, d.preparatoIl, 'ddt.crea', { numero: d.numero, da: nomi[d.origineId], a: nomi[d.destinazioneId], causale: d.causale,
        righe: righe.map(function (x) { return { articolo: nomeArt(x.articoloId), quantita: x.quantita, lotto: x.lotto || undefined }; }) });
      ev(prep, d.partitoIl, 'ddt.spedisci', { numero: d.numero, trasportatore: d.trasportatoreNome, colli: d.colli, richiesta: ric && ric.stato === 'evasa' ? 'evasa' : undefined });
      var diff = righe.filter(function (x) { return x.ricevuta !== null && x.ricevuta < x.quantita; });
      ev(chiE(d.ricevutoDa), d.ricevutoIl, 'ddt.ricevi', { numero: d.numero, a: nomi[d.destinazioneId],
        differenze: diff.length ? diff.map(function (x) { return { articolo: nomeArt(x.articoloId), partita: x.quantita, ricevuta: x.ricevuta, esito: x.esito }; }) : undefined });
      if (d.stato === 'annullato') ev(chiNome(d.annullatoDa), d.annullatoIl, 'ddt.annulla', { numero: d.numero, motivo: d.motivoAnnullo });
    });
    // consumi registrati la sera (un evento per magazzino e giorno, come "Registra" della pagina Consumi)
    var sera = {};
    S.movimenti.forEach(function (m) {
      if (m.tipo !== 'consumo' || !m.utenteId) return;
      var t = new Date(m.creato).toISOString();
      if (t < dal) return;
      var k = m.repartoId + '|' + m.data;
      (sera[k] = sera[k] || { u: chiE(m.utenteId), t: t, righe: [] }).righe.push({ tipo: 'consumo', data: m.data, articolo: nomeArt(m.articoloId), reparto: m.repartoId, quantita: m.quantita });
    });
    Object.keys(sera).forEach(function (k) { ev(sera[k].u, sera[k].t, 'movimenti.registra', { movimenti: sera[k].righe }); });
    // accessi del mattino (chi lavora quel giorno) e verifica in due passaggi di Chiara Verdi
    for (var g = 10; g >= 1; g--) {
      var giorno = new Date(Date.now() - g * 86400000);
      var festivo = giorno.getDay() === 0;
      UTENTI.forEach(function (u, i) {
        if (festivo && u.ruolo !== 'reparto') return;
        if (u.ruolo === 'consultazione' && g % 3) return;
        var t = new Date(giorno.getFullYear(), giorno.getMonth(), giorno.getDate(), 7, 20 + i * 7).toISOString();
        ev(u, t, 'accesso.entrata', u.totpAttivo ? { dueFattori: g % 4 ? 'computer attendibile' : 'codice' } : {});
      });
    }
    var sicura = utente('u-sicura');
    if (sicura && sicura.totpAttivatoIl) {
      dal = '';
      ev(sicura, sicura.totpAttivatoIl, 'accesso.2fa.attivata', { codiciRecupero: 10 });
      ev(sicura, new Date(Date.parse(sicura.totpAttivatoIl) + 60000).toISOString(), 'accesso.2fa.ricorda-computer', { giorni: 30 });
    }
    lista.sort(function (a, b) { return a.quando < b.quando ? -1 : a.quando > b.quando ? 1 : 0; });
    lista.forEach(function (e) { e.id = ++nEventi; eventi.unshift(e); });
  }

  /* ======================= scritture "in transazione" ======================= */

  /*
   * Come Database.scrivi: una revisione nuova, tutto o niente. Le modifiche passano da ins/agg/canc, che ricordano come
   * tornare indietro: se fn lancia un errore lo stato torna com'era (come il ROLLBACK del server vero).
   */
  var annulli = null;
  function scrivi(fn) {
    var prima = rev;
    rev++;
    annulli = [];
    var r;
    try {
      r = fn(rev);
    } catch (e) {
      for (var i = annulli.length - 1; i >= 0; i--) annulli[i]();
      annulli = null;
      rev = prima;
      throw e;
    }
    annulli = null;
    var nuova = rev;
    ascoltatori.slice().forEach(function (a) { a._evento('rev', { rev: nuova }); });
    return { rev: nuova, risultato: r };
  }
  function ricorda(fn) { if (annulli) annulli.push(fn); }
  function tocca(tabella, id, r) {
    var k = tabella + '|' + id;
    var vecchia = revRiga[k];
    revRiga[k] = r;
    ricorda(function () { if (vecchia === undefined) delete revRiga[k]; else revRiga[k] = vecchia; });
  }
  function ins(tabella, x, r) {
    S[tabella].push(x);
    ricorda(function () { S[tabella] = S[tabella].filter(function (y) { return y !== x; }); });
    // una riga ricreata con un codice già cancellato non deve sparire dai browser
    var giaCancellata = cancellati.filter(function (c) { return c.tabella === tabella && c.id === x.id; })[0];
    if (giaCancellata) {
      cancellati = cancellati.filter(function (c) { return c !== giaCancellata; });
      ricorda(function () { cancellati.push(giaCancellata); });
    }
    tocca(tabella, x.id, r);
    return x;
  }
  function agg(tabella, x, campi, r) {
    var vecchi = {};
    Object.keys(campi).forEach(function (k) { vecchi[k] = x[k]; });
    Object.assign(x, campi);
    ricorda(function () { Object.assign(x, vecchi); });
    if (r !== null) tocca(tabella, x.id, r);
    return x;
  }
  function canc(tabella, x, r) {
    var i = S[tabella].indexOf(x);
    if (i < 0) return;
    S[tabella].splice(i, 1);
    var voce = { tabella: tabella, id: x.id, rev: r };
    cancellati = cancellati.filter(function (c) { return !(c.tabella === tabella && c.id === x.id); });
    cancellati.push(voce);
    ricorda(function () { S[tabella].splice(Math.min(i, S[tabella].length), 0, x); cancellati = cancellati.filter(function (c) { return c !== voce; }); });
  }
  function impostaMeta(k, v) {
    var vecchio = meta[k];
    meta[k] = v;
    ricorda(function () { if (vecchio === undefined) delete meta[k]; else meta[k] = vecchio; });
  }

  /* ======================= utilità ======================= */

  // errore con stato HTTP; "dati" (facoltativo) va nella risposta accanto a "errore", come nel server vero
  function Errore(stato, messaggio, dati) { this.stato = stato; this.message = messaggio; this.dati = dati || null; }
  function errore(stato, messaggio, dati) { return new Errore(stato, messaggio, dati); }
  function richiedi(ctx, permesso) { if (!ctx.permessi || !ctx.permessi[permesso]) throw errore(403, 'Il tuo utente non può fare questa operazione.'); }

  function testo(v, max, campo) {
    var t = v === undefined || v === null ? '' : String(v).trim();
    if (t.length > max) throw errore(400, 'Il campo ' + campo + ' è troppo lungo (massimo ' + max + ' caratteri).');
    return t;
  }
  function numero(v, campo, opz) {
    var n = typeof v === 'number' ? v : parseFloat(String(v === undefined || v === null ? '' : v).replace(',', '.'));
    if (!isFinite(n)) {
      if (opz && opz.facoltativo) return opz.predefinito === undefined ? 0 : opz.predefinito;
      throw errore(400, 'Il campo ' + campo + ' non è un numero.');
    }
    if (opz && opz.min !== undefined && n < opz.min) throw errore(400, 'Il campo ' + campo + ' non può essere minore di ' + opz.min + '.');
    if (Math.abs(n) > 1e9) throw errore(400, 'Il campo ' + campo + ' è troppo grande.');
    return Math.round(n * 1000) / 1000;
  }
  function dataValida(d) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    var p = d.split('-').map(Number);
    var x = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return x.getUTCFullYear() === p[0] && x.getUTCMonth() === p[1] - 1 && x.getUTCDate() === p[2] && p[0] >= 2000;
  }
  function controllaData(d) {
    if (!dataValida(d)) throw errore(400, 'Data non valida.');
    if (d > oggi(1)) throw errore(400, 'Non si possono registrare movimenti con una data futura (' + d + ').');
  }
  function scadenzaValida(s) {
    if (!s) return '';
    if (typeof s !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw errore(400, 'Scadenza non valida: usa mese e anno.');
    return s;
  }
  function mancante(v) { return v === undefined || v === null || v === ''; }
  function r3(x) { return C.r3(x); }
  function fmt(n) { return String(r3(n)).replace('.', ','); }

  function articolo(id) { return S.articoli.filter(function (a) { return a.id === id; })[0] || null; }
  function reparto(id) { return S.reparti.filter(function (r) { return r.id === id; })[0] || null; }
  function repartiOrdinati() {
    return S.reparti.slice().sort(function (a, b) { return a.ordine !== b.ordine ? a.ordine - b.ordine : (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0); });
  }
  function movimentiArticolo(id) { return C.ordinaMovimenti(S.movimenti.filter(function (m) { return m.articoloId === id; })); }
  function statoArticolo(id) { return { articoli: [], movimenti: S.movimenti.filter(function (m) { return m.articoloId === id; }) }; }

  /* ---------- registro attività (come Accessi.evento) ---------- */
  function evento(ctx, azione, dettagli) {
    var u = ctx && ctx.utente;
    var det = dettagli || {};
    var t = JSON.stringify(det);
    if (t.length > 4000) det = { troncato: true, testo: t.slice(0, 4000) };
    eventi.unshift({ id: ++nEventi, quando: new Date().toISOString(), username: u ? u.username : String((ctx && ctx.username) || '').slice(0, 40),
      azione: azione, dettagli: JSON.parse(JSON.stringify(det)), ip: 'anteprima' });
    if (eventi.length > 3000) eventi.length = 3000;
  }

  /* ======================= permessi (come server/accessi.js) ======================= */

  function permessi(utente) {
    if (!utente) return null;
    var r = utente.ruolo;
    var admin = r === 'amministratore';
    var farm = admin || r === 'farmacista';
    var rep = r === 'reparto';
    return {
      utenti: admin, impostazioni: admin, backup: admin, attivita: farm, articoli: farm, carico: farm, trasferimento: farm,
      rettifica: farm, consumo: farm || rep, perdita: farm || rep, registro: farm || rep, annullaTutti: farm,
      richieste: farm || rep, evadiRichieste: farm, ddt: farm || rep, riceviDdt: farm || rep, struttura: admin,
      assortimento: farm, ubicazioni: farm || rep, previsioni: true, ordini: farm, sistema: admin, sicurezza: admin,
      reparti: rep ? (utente.reparti || []).slice() : null
    };
  }
  function puoScrivereReparto(perm, repartoId) { return perm.reparti === null || perm.reparti.indexOf(repartoId) >= 0; }

  var CRITERI_2FA = ['nessuno', 'amministratori', 'farmacisti', 'tutti'];
  function criterio2fa() { var c = S.impostazioni.richiedi2fa; return CRITERI_2FA.indexOf(c) >= 0 ? c : 'nessuno'; }
  function obbligo2fa(ruolo, criterio) {
    if (criterio === 'tutti') return true;
    if (criterio === 'farmacisti') return ruolo === 'amministratore' || ruolo === 'farmacista';
    if (criterio === 'amministratori') return ruolo === 'amministratore';
    return false;
  }
  // utente come lo vede il client (utenteDaRiga del server vero)
  function vistaUtente(u) {
    if (!u) return null;
    var obbl = obbligo2fa(u.ruolo, criterio2fa());
    return {
      id: u.id, username: u.username, nome: u.nome, ruolo: u.ruolo, reparti: u.reparti.slice(), attivo: !!u.attivo, cambioPassword: !!u.cambioPassword,
      ultimoAccesso: u.ultimoAccesso || null, bloccato: (u.bloccatoFino || 0) > Date.now(),
      dueFattori: !!u.totpAttivo, dueFattoriObbligatoria: obbl, dueFattoriDaAttivare: obbl && !u.totpAttivo
    };
  }
  function utentiPerNome() {
    return UTENTI.slice().sort(function (a, b) { var x = a.nome.toLowerCase(); var y = b.nome.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; });
  }
  function utente(id) { return UTENTI.filter(function (u) { return u.id === id; })[0] || null; }

  /* ======================= forme dei dati (come le conversioni di server/db.js) ======================= */

  function vistaMovimento(m) {
    return { id: m.id, tipo: m.tipo, data: m.data, articoloId: m.articoloId, repartoId: m.repartoId, repartoDestId: m.repartoDestId || undefined,
      quantita: m.quantita, lotto: m.lotto, scadenza: m.scadenza, fornitore: m.fornitore, documento: m.documento, causale: m.causale, note: m.note,
      prezzo: m.prezzo === null || m.prezzo === undefined ? undefined : m.prezzo, operatore: m.operatore, utenteId: m.utenteId || undefined,
      creato: m.creato, annullato: m.annullato ? copia(m.annullato) : null, ddtId: m.ddtId || null };
  }
  function vista(tabella, x) { return tabella === 'movimenti' ? vistaMovimento(x) : copia(x); }
  function ordina(lista, chiavi) {
    return lista.slice().sort(function (a, b) {
      for (var i = 0; i < chiavi.length; i++) {
        var x = a[chiavi[i]];
        var y = b[chiavi[i]];
        if (x === y) continue;
        if (x === null || x === undefined) return -1;
        if (y === null || y === undefined) return 1;
        return x < y ? -1 : 1;
      }
      return 0;
    });
  }
  var ORDINE_SYNC = {
    reparti: ['ordine', 'nome'], articoli: [], movimenti: ['data', 'creato'], armadi: ['repartoId', 'ordine', 'nome'], assortimento: [],
    richieste: ['anno', 'progressivo'], richiesteRighe: ['richiestaId', 'ordine'], ddt: ['anno', 'progressivo'], ddtRighe: ['ddtId', 'ordine']
  };

  /* ======================= movimenti (server/operazioni.js) ======================= */

  var TIPI = ['carico', 'consumo', 'trasferimento', 'perdita', 'rettifica'];
  var USCITE = ['consumo', 'perdita', 'trasferimento'];
  var PERMESSO_TIPO = { carico: 'carico', consumo: 'consumo', trasferimento: 'trasferimento', perdita: 'perdita', rettifica: 'rettifica' };

  function normalizzaMovimento(ctx, m) {
    if (!m || typeof m !== 'object') throw errore(400, 'Movimento non valido.');
    if (TIPI.indexOf(m.tipo) < 0) throw errore(400, 'Tipo di movimento non valido.');
    richiedi(ctx, PERMESSO_TIPO[m.tipo]);
    controllaData(m.data);
    var a = articolo(String(m.articoloId || ''));
    if (!a) throw errore(400, 'Articolo non trovato: aggiorna la pagina.');
    var r = reparto(String(m.repartoId || ''));
    if (!r) throw errore(400, 'Reparto non trovato: aggiorna la pagina.');
    if (r.tipo === 'transito') throw errore(400, 'La merce «' + NOME_TRANSITO + '» si sposta solo con i DDT (pagina DDT e consegne).');
    if (!r.attivo) throw errore(400, 'Il reparto ' + r.nome + ' non è attivo.');
    if (!puoScrivereReparto(ctx.permessi, r.id)) throw errore(403, 'Non puoi registrare movimenti per il reparto ' + r.nome + '.');
    var out = {
      tipo: m.tipo, data: m.data, articoloId: a.id, repartoId: r.id, repartoDestId: null,
      lotto: testo(m.lotto, 60, 'lotto'), scadenza: scadenzaValida(m.scadenza || ''),
      fornitore: testo(m.fornitore, 200, 'fornitore'), documento: testo(m.documento, 100, 'documento'),
      causale: testo(m.causale, 100, 'causale'), note: testo(m.note, 500, 'note'), prezzo: null
    };
    out.quantita = numero(m.quantita, 'quantità');
    if (m.tipo === 'rettifica') {
      if (!out.quantita) throw errore(400, 'Una rettifica deve avere una quantità diversa da zero.');
    } else if (!(out.quantita > 0)) throw errore(400, 'La quantità deve essere maggiore di zero (' + a.nome + ').');
    if (m.tipo === 'trasferimento') {
      var d = reparto(String(m.repartoDestId || ''));
      if (!d || !d.attivo) throw errore(400, 'Reparto di arrivo non valido.');
      if (d.tipo === 'transito') throw errore(400, 'La merce «' + NOME_TRANSITO + '» si sposta solo con i DDT (pagina DDT e consegne).');
      if (d.id === r.id) throw errore(400, 'Il reparto di partenza e quello di arrivo sono uguali.');
      out.repartoDestId = d.id;
    }
    if (m.tipo === 'carico' && m.prezzo !== undefined && m.prezzo !== null && m.prezzo !== '') out.prezzo = numero(m.prezzo, 'prezzo', { min: 0 });
    if (m.tipo === 'rettifica' && m.teorica !== undefined && m.teorica !== null && m.teorica !== '') out.teorica = numero(m.teorica, 'giacenza teorica');
    out.articolo = a;
    out.reparto = r;
    return out;
  }

  function inserisciMovimento(ctx, r, m) {
    var creato = m.creato || Math.max(Date.now(), ultimoCreato + 1);
    if (!m.creato) ultimoCreato = creato;
    var nuovo = {
      id: nuovoId('m'), tipo: m.tipo, data: m.data, articoloId: m.articoloId, repartoId: m.repartoId, repartoDestId: m.repartoDestId || undefined,
      quantita: m.quantita, lotto: m.lotto || '', scadenza: m.scadenza || '', fornitore: m.fornitore || '', documento: m.documento || '',
      causale: m.causale || '', note: m.note || '', prezzo: m.prezzo === null || m.prezzo === undefined ? undefined : m.prezzo,
      operatore: m.operatore !== undefined ? m.operatore : (ctx.utente ? ctx.utente.nome : ''),
      utenteId: m.utenteId !== undefined ? (m.utenteId || undefined) : (ctx.utente ? ctx.utente.id : undefined),
      creato: creato, annullato: null, ddtId: m.ddtId || null
    };
    ins('movimenti', nuovo, r);
    return nuovo;
  }

  function ripartisciUscita(m) {
    var stato = statoArticolo(m.articoloId);
    if (m.lotto && C.disponibilitaLotto(stato, m.articoloId, m.repartoId, m.data, m.lotto) <= 0) {
      throw errore(409, 'Il lotto ' + m.lotto + ' di ' + m.articolo.nome + ' non è più disponibile in ' + m.reparto.nome +
        ' alla data indicata (forse l’ha appena usato un altro utente): aggiorna e scegli di nuovo il lotto.');
    }
    return C.allocaUscita(stato, m.articoloId, m.repartoId, m.data, m.quantita, m.lotto);
  }

  function registraMovimenti(ctx, lista) {
    if (!Array.isArray(lista) || !lista.length) throw errore(400, 'Nessun movimento da registrare.');
    if (lista.length > 500) throw errore(400, 'Troppi movimenti in una volta sola (massimo 500).');
    var norm = lista.map(function (m) { return normalizzaMovimento(ctx, m); });
    var w = scrivi(function (r) {
      var cambiati = [];
      norm.forEach(function (m) {
        if (m.tipo === 'rettifica' && m.teorica !== undefined) {
          var attuale = C.giacenza(statoArticolo(m.articoloId), m.articoloId, m.repartoId, m.data);
          if (r3(attuale) !== r3(m.teorica)) cambiati.push(m.articolo.nome + ' (ora ' + r3(attuale) + ')');
        }
      });
      if (cambiati.length) {
        throw errore(409, 'Mentre contavi, altri movimenti hanno cambiato la giacenza di: ' + cambiati.join(', ') +
          '. Ho aggiornato le giacenze: controlla le differenze e registra di nuovo.');
      }
      var creati = [];
      norm.forEach(function (m) {
        if (USCITE.indexOf(m.tipo) >= 0) {
          ripartisciUscita(m).forEach(function (p) {
            creati.push(inserisciMovimento(ctx, r, Object.assign({}, m, { quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza })));
          });
        } else creati.push(inserisciMovimento(ctx, r, m));
        if (m.tipo === 'carico' && m.prezzo !== null && m.prezzo !== m.articolo.prezzo) {
          agg('articoli', m.articolo, { prezzo: m.prezzo, versione: m.articolo.versione + 1 }, r);
        }
      });
      return creati;
    });
    evento(ctx, 'movimenti.registra', {
      movimenti: norm.map(function (m) {
        return { tipo: m.tipo, data: m.data, articolo: m.articolo.nome, reparto: m.repartoId, verso: m.repartoDestId || undefined, quantita: m.quantita, lotto: m.lotto || undefined };
      })
    });
    return { rev: w.rev, movimenti: w.risultato.map(vistaMovimento) };
  }

  function annullaMovimento(ctx, id, motivo) {
    var m = S.movimenti.filter(function (x) { return x.id === String(id); })[0];
    if (!m) throw errore(404, 'Movimento non trovato.');
    if (m.annullato) throw errore(409, 'Il movimento è già stato annullato.');
    if (m.ddtId) {
      var d = S.ddt.filter(function (x) { return x.id === m.ddtId; })[0];
      var num = d ? d.numero : '';
      if (d && d.stato === 'in_transito') {
        throw errore(409, 'Questo movimento fa parte del DDT ' + num + ': per annullarlo annulla il DDT dalla pagina DDT e consegne (la merce rientra nel magazzino di partenza).');
      }
      throw errore(409, 'Questo movimento fa parte del DDT ' + num + ', già ' + (d && d.stato === 'annullato' ? 'annullato' : 'ricevuto') +
        ': non si annulla da qui. Per restituire la merce prepara un DDT di reso dalla pagina Trasferimenti.');
    }
    var proprio = (m.tipo === 'consumo' || m.tipo === 'perdita') && m.utenteId === ctx.utente.id && ctx.permessi[m.tipo] && puoScrivereReparto(ctx.permessi, m.repartoId);
    if (!ctx.permessi.annullaTutti && !proprio) throw errore(403, 'Puoi annullare solo i consumi e le perdite che hai registrato tu nei tuoi reparti.');
    motivo = testo(motivo, 300, 'motivo') || 'Annullato';
    var w = scrivi(function (r) { agg('movimenti', m, { annullato: { il: new Date().toISOString(), da: ctx.utente.nome, motivo: motivo } }, r); });
    var a = articolo(m.articoloId);
    evento(ctx, 'movimenti.annulla', { tipo: m.tipo, data: m.data, articolo: a ? a.nome : m.articoloId, quantita: m.quantita, reparto: m.repartoId, motivo: motivo, registratoDa: m.operatore });
    return { rev: w.rev };
  }

  function consumoGiorno(ctx, dati) {
    richiedi(ctx, 'registro');
    var m = normalizzaMovimento(ctx, { tipo: 'consumo', data: dati && dati.data, articoloId: dati && dati.articoloId, repartoId: dati && dati.repartoId, quantita: 1 });
    var quantita = numero(dati.quantita, 'quantità', { min: 0 });
    var prima = mancante(dati.prima) ? null : numero(dati.prima, 'valore precedente', { min: 0 });
    var precedenti = 0;
    var w = scrivi(function (r) {
      var esistenti = S.movimenti.filter(function (x) { return x.tipo === 'consumo' && x.articoloId === m.articoloId && x.repartoId === m.repartoId && x.data === m.data && !x.annullato; });
      esistenti.forEach(function (e) { precedenti = r3(precedenti + e.quantita); });
      if (prima !== null && prima !== precedenti) {
        throw errore(409, 'Nel frattempo un altro utente ha registrato consumi di ' + m.articolo.nome + ' per quel giorno (ora ' +
          precedenti + '): ho aggiornato il registro, controlla e correggi di nuovo se serve.');
      }
      var adesso = new Date().toISOString();
      esistenti.forEach(function (e) { agg('movimenti', e, { annullato: { il: adesso, da: ctx.utente.nome, motivo: 'Corretto dal registro mensile' } }, r); });
      if (quantita > 0) {
        var nuovo = Object.assign({}, m, { quantita: quantita, note: 'Dal registro mensile' });
        ripartisciUscita(nuovo).forEach(function (p) {
          inserisciMovimento(ctx, r, Object.assign({}, nuovo, { quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza }));
        });
      }
    });
    evento(ctx, 'registro.consumo-giorno', { articolo: m.articolo.nome, reparto: m.repartoId, data: m.data, prima: precedenti, dopo: quantita });
    return { rev: w.rev };
  }

  /* ======================= articoli ======================= */

  var CATEGORIE = ['FARMACI', 'PRESIDI'];
  var MAX_CODICI = 50;
  function validaCodici(lista) {
    if (lista === undefined || lista === null) return undefined;
    if (!Array.isArray(lista)) throw errore(400, 'Codici a barre non validi.');
    var out = [];
    lista.forEach(function (k) {
      var n = B().normalizzaChiave(k);
      if (!n) throw errore(400, 'Codice a barre non valido: ' + String(k).slice(0, 80) + '.');
      if (out.indexOf(n) < 0) out.push(n);
    });
    if (out.length > MAX_CODICI) throw errore(400, 'Troppi codici a barre per un articolo (massimo ' + MAX_CODICI + ').');
    return out;
  }
  function validaPezzi(v) {
    if (mancante(v)) return undefined;
    var n = numero(v, 'pezzi per confezione');
    if (!(n > 0)) throw errore(400, 'I pezzi per confezione devono essere più di zero.');
    if (n > 100000) throw errore(400, 'I pezzi per confezione sono troppi (massimo 100000).');
    return n;
  }
  function validaArticolo(d) {
    if (!d || typeof d !== 'object') throw errore(400, 'Articolo non valido.');
    var nome = testo(d.nome, 200, 'denominazione');
    if (!nome) throw errore(400, 'Scrivi la denominazione.');
    if (CATEGORIE.indexOf(d.categoria) < 0) throw errore(400, 'Categoria non valida.');
    return {
      nome: nome, categoria: d.categoria,
      unita: testo(d.unita, 30, 'unità'), principio: testo(d.principio, 200, 'principio attivo'),
      confezione: testo(d.confezione, 200, 'confezione'), codice: testo(d.codice, 60, 'codice'),
      prezzo: numero(d.prezzo, 'prezzo', { min: 0, facoltativo: true }),
      scortaMinima: numero(d.scortaMinima, 'scorta minima', { min: 0, facoltativo: true }),
      note: testo(d.note, 1000, 'note'), attivo: d.attivo !== false,
      barcode: validaCodici(d.barcode), pezziConfezione: validaPezzi(d.pezziConfezione)
    };
  }
  function articoloPerNome(nome) {
    var n = String(nome).trim().toLowerCase();
    return S.articoli.filter(function (a) { return a.nome.toLowerCase() === n; })[0] || null;
  }
  function controllaCodici(codici, tranne) {
    (codici || []).forEach(function (k) {
      var altro = S.articoli.filter(function (a) { return a.id !== tranne && (a.barcode || []).indexOf(k) >= 0; })[0];
      if (altro) throw errore(409, 'Il codice ' + B().descrivi(k) + ' è già associato all’articolo «' + altro.nome + '».');
    });
  }
  function nuovoArticolo(v, id) {
    return { id: id, nome: v.nome, categoria: v.categoria, unita: v.unita || '', principio: v.principio || '', confezione: v.confezione || '', codice: v.codice || '',
      prezzo: v.prezzo || 0, scortaMinima: v.scortaMinima || 0, note: v.note || '', attivo: v.attivo !== false, versione: 1,
      barcode: v.barcode || [], pezziConfezione: v.pezziConfezione || 1, attributi: [], leadTime: null, fornitore: '' };
  }

  function creaArticolo(ctx, dati) {
    richiedi(ctx, 'articoli');
    var a = validaArticolo(dati);
    if (articoloPerNome(a.nome)) throw errore(409, 'Esiste già un articolo con questo nome.');
    if (a.barcode === undefined) a.barcode = [];
    if (a.pezziConfezione === undefined) a.pezziConfezione = 1;
    var id = nuovoId('a');
    var w = scrivi(function (r) {
      controllaCodici(a.barcode, id);
      ins('articoli', nuovoArticolo(a, id), r);
    });
    evento(ctx, 'articoli.crea', { articolo: a.nome, categoria: a.categoria, barcode: a.barcode.length ? a.barcode : undefined });
    return { rev: w.rev, articolo: copia(articolo(id)) };
  }

  function modificaArticolo(ctx, id, dati) {
    richiedi(ctx, 'articoli');
    var prima = articolo(String(id));
    if (!prima) throw errore(404, 'Articolo non trovato.');
    if (Number(dati && dati.versione) !== prima.versione) throw errore(409, 'Un altro utente ha modificato questo articolo nel frattempo: ricarico i dati, controlla e riprova.');
    var a = validaArticolo(dati);
    var doppio = articoloPerNome(a.nome);
    if (doppio && doppio.id !== prima.id) throw errore(409, 'Esiste già un articolo con questo nome.');
    if (a.barcode === undefined) a.barcode = prima.barcode.slice();
    if (a.pezziConfezione === undefined) a.pezziConfezione = prima.pezziConfezione;
    var vecchio = copia(prima);
    var w = scrivi(function (r) {
      controllaCodici(a.barcode, prima.id);
      agg('articoli', prima, { nome: a.nome, categoria: a.categoria, unita: a.unita, principio: a.principio, confezione: a.confezione, codice: a.codice,
        prezzo: a.prezzo, scortaMinima: a.scortaMinima, note: a.note, attivo: a.attivo, barcode: a.barcode, pezziConfezione: a.pezziConfezione, versione: prima.versione + 1 }, r);
    });
    var cambi = {};
    Object.keys(a).forEach(function (k) { if (JSON.stringify(a[k]) !== JSON.stringify(vecchio[k])) cambi[k] = { prima: vecchio[k], dopo: a[k] }; });
    evento(ctx, 'articoli.modifica', { articolo: vecchio.nome, cambi: cambi });
    return { rev: w.rev, articolo: copia(prima) };
  }

  function associaCodice(ctx, id, chiave) {
    richiedi(ctx, 'articoli');
    var a = articolo(String(id));
    if (!a) throw errore(404, 'Articolo non trovato.');
    var k = B().normalizzaChiave(chiave);
    if (!k) throw errore(400, 'Codice a barre non valido.');
    if (a.barcode.indexOf(k) >= 0) return { rev: rev, articolo: copia(a) };
    if (a.barcode.length >= MAX_CODICI) throw errore(400, 'Troppi codici a barre per un articolo (massimo ' + MAX_CODICI + ').');
    var w = scrivi(function (r) {
      controllaCodici([k], a.id);
      agg('articoli', a, { barcode: a.barcode.concat([k]), versione: a.versione + 1 }, r);
    });
    evento(ctx, 'articoli.barcode', { articolo: a.nome, chiave: k });
    return { rev: w.rev, articolo: copia(a) };
  }

  function eliminaArticolo(ctx, id) {
    richiedi(ctx, 'articoli');
    var a = articolo(String(id));
    if (!a) throw errore(404, 'Articolo non trovato.');
    if (S.movimenti.some(function (m) { return m.articoloId === a.id; })) {
      throw errore(409, 'L’articolo ha dei movimenti: non si può eliminare. Togli la spunta “Articolo attivo” per nasconderlo.');
    }
    var w = scrivi(function (r) { canc('articoli', a, r); });
    evento(ctx, 'articoli.elimina', { articolo: a.nome });
    return { rev: w.rev };
  }

  function importaArticoli(ctx, dati) {
    richiedi(ctx, 'articoli');
    var lista = dati && Array.isArray(dati.articoli) ? dati.articoli : [];
    if (!lista.length) throw errore(400, 'Nessun articolo da importare.');
    if (lista.length > 5000) throw errore(400, 'Troppi articoli in un solo file (massimo 5000).');
    var conGiacenza = !!dati.conGiacenza;
    var rep = null;
    if (conGiacenza) {
      richiedi(ctx, 'carico');
      controllaData(dati.data);
      rep = reparto(String(dati.repartoId || ''));
      if (!rep || !rep.attivo) throw errore(400, 'Reparto per la giacenza iniziale non valido.');
    }
    var origine = testo(dati.origine, 200, 'origine');
    var validi = lista.map(function (x) {
      var a = validaArticolo({ nome: x.nome, categoria: x.categoria, prezzo: x.prezzo, scortaMinima: x.scortaMinima, unita: x.unita });
      a.giacenza = numero(x.giacenza, 'giacenza', { facoltativo: true });
      return a;
    });
    var nuovi = 0;
    var carichi = 0;
    var saltati = 0;
    var w = scrivi(function (r) {
      validi.forEach(function (a) {
        var esiste = articoloPerNome(a.nome);
        var id = esiste ? esiste.id : nuovoId('a');
        if (!esiste) {
          ins('articoli', nuovoArticolo({ nome: a.nome, categoria: a.categoria, unita: a.unita, prezzo: a.prezzo, scortaMinima: a.scortaMinima }, id), r);
          nuovi++;
        }
        if (conGiacenza && a.giacenza > 0) {
          var gia = esiste && S.movimenti.some(function (m) { return m.articoloId === id && (m.repartoId === rep.id || m.repartoDestId === rep.id) && !m.annullato; });
          if (gia) { saltati++; return; }
          inserisciMovimento(ctx, r, { tipo: 'carico', data: dati.data, articoloId: id, repartoId: rep.id, quantita: a.giacenza, note: 'Giacenza iniziale importata' + (origine ? ' da ' + origine : '') });
          carichi++;
        }
      });
    });
    evento(ctx, 'articoli.importa', { origine: origine, righe: validi.length, nuovi: nuovi, carichi: carichi, saltati: saltati, reparto: rep ? rep.id : undefined });
    return { rev: w.rev, nuovi: nuovi, carichi: carichi, saltati: saltati };
  }

  /* ======================= impostazioni e reparti ======================= */

  function validaImpostazioni(dati) {
    dati = dati || {};
    var nuove = {
      struttura: testo(dati.struttura, 100, 'struttura') || IMPOSTAZIONI_PREDEFINITE.struttura,
      sottotitolo: testo(dati.sottotitolo, 100, 'sottotitolo'),
      societa: testo(dati.societa, 100, 'società'),
      citta: testo(dati.citta, 100, 'città'),
      codiceModulo: testo(dati.codiceModulo, 60, 'codice del modulo'),
      giorniAvvisoScadenza: Math.round(numero(dati.giorniAvvisoScadenza, 'giorni di avviso', { min: 1, facoltativo: true, predefinito: 90 })) || 90
    };
    if (nuove.giorniAvvisoScadenza > 3650) nuove.giorniAvvisoScadenza = 3650;
    if (dati.logo !== undefined) {
      var logo = String(dati.logo || '');
      if (logo && logo !== 'nessuno' && !/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw errore(400, 'Il logo deve essere un’immagine PNG, JPEG, GIF, WebP o SVG.');
      if (logo.length > 600000) throw errore(400, 'Il logo è troppo grande: usa un’immagine sotto i 400 KB.');
      nuove.logo = logo;
    }
    if (dati.nomeProdotto !== undefined) nuove.nomeProdotto = testo(dati.nomeProdotto, 60, 'nome del prodotto') || IMPOSTAZIONI_PREDEFINITE.nomeProdotto;
    if (dati.sigla !== undefined) nuove.sigla = testo(dati.sigla, 20, 'sigla');
    if (dati.coloreAccento !== undefined) {
      var col = String(dati.coloreAccento || '').trim();
      if (col && !/^#[0-9a-fA-F]{6}$/.test(col)) throw errore(400, 'Il colore deve essere nella forma #RRGGBB.');
      nuove.coloreAccento = col;
    }
    if (dati.tema !== undefined) {
      if (['automatico', 'chiaro', 'scuro'].indexOf(dati.tema) < 0) throw errore(400, 'Tema non valido.');
      nuove.tema = dati.tema;
    }
    if (dati.leadTimeGiorni !== undefined) nuove.leadTimeGiorni = Math.min(365, Math.max(0, numero(dati.leadTimeGiorni, 'giorni di consegna', { min: 0 })));
    if (dati.periodoRevisioneGiorni !== undefined) nuove.periodoRevisioneGiorni = Math.min(365, Math.max(1, numero(dati.periodoRevisioneGiorni, 'periodo di revisione', { min: 1 })));
    if (dati.livelloServizio !== undefined) {
      var ls = numero(dati.livelloServizio, 'livello di servizio', { min: 0.5 });
      if (ls >= 1) throw errore(400, 'Il livello di servizio va da 0,50 a 0,999.');
      nuove.livelloServizio = ls;
    }
    if (dati.storicoGiorni !== undefined) nuove.storicoGiorni = Math.round(Math.min(1095, Math.max(28, numero(dati.storicoGiorni, 'giorni di storico', { min: 28 }))));
    return nuove;
  }

  function cambiaImpostazioni(nuove, r) {
    var vecchie = copia(S.impostazioni);
    var cambiate = false;
    Object.keys(nuove).forEach(function (k) {
      if (JSON.stringify(vecchie[k]) !== JSON.stringify(nuove[k])) { S.impostazioni[k] = copia(nuove[k]); cambiate = true; }
    });
    ricorda(function () { S.impostazioni = vecchie; });
    if (cambiate) tocca('impostazioni', 'tutte', r);
  }

  function salvaImpostazioni(ctx, dati) {
    richiedi(ctx, 'impostazioni');
    var prima = copia(S.impostazioni);
    var nuove = validaImpostazioni(dati);
    var w = scrivi(function (r) { cambiaImpostazioni(nuove, r); });
    var cambi = {};
    Object.keys(nuove).forEach(function (k) { if (prima[k] !== nuove[k]) cambi[k] = k === 'logo' ? '(immagine)' : { prima: prima[k], dopo: nuove[k] }; });
    evento(ctx, 'impostazioni.modifica', cambi);
    return { rev: w.rev, impostazioni: copia(S.impostazioni) };
  }

  function togliRepartoDagliUtenti(ids) {
    var toccati = [];
    UTENTI.forEach(function (u) {
      var resta = u.reparti.filter(function (x) { return ids.indexOf(x) < 0; });
      if (resta.length !== u.reparti.length) { u.reparti = resta; toccati.push(u.id); }
    });
    return toccati;
  }

  function salvaReparti(ctx, dati) {
    richiedi(ctx, 'impostazioni');
    var lista = dati && Array.isArray(dati.reparti) ? dati.reparti : null;
    if (!lista || !lista.length) throw errore(400, 'Elenco dei reparti vuoto.');
    if (lista.length > 200) throw errore(400, 'Troppi reparti.');
    var esistenti = {};
    S.reparti.forEach(function (r) { esistenti[r.id] = r; });
    lista = lista.filter(function (r) { return !(r && r.id && esistenti[String(r.id)] && esistenti[String(r.id)].tipo === 'transito'); });
    if (!lista.length) throw errore(400, 'Elenco dei reparti vuoto.');
    var nomi = {};
    nomi[NOME_TRANSITO.toLowerCase()] = 'riservato';
    var centraleVisto = false;
    var norm = lista.map(function (r, i) {
      var nome = testo(r && r.nome, 80, 'nome del reparto');
      if (!nome) throw errore(400, 'Ogni reparto deve avere un nome.');
      var k = nome.toLowerCase();
      if (nomi[k] === 'riservato') throw errore(400, 'Il nome «' + NOME_TRANSITO + '» è riservato alla merce in viaggio con i DDT: scegli un altro nome.');
      if (nomi[k]) throw errore(400, 'Due reparti hanno lo stesso nome: ' + nome + '.');
      nomi[k] = true;
      var id = r.id ? String(r.id) : null;
      if (id && !esistenti[id]) throw errore(400, 'Reparto non trovato: aggiorna la pagina.');
      var centrale = !!r.centrale && !centraleVisto;
      if (centrale) centraleVisto = true;
      return { id: id || nuovoId('r'), nome: nome, centrale: centrale, attivo: r.attivo !== false, ordine: i, nuovo: !id };
    });
    if (!norm.some(function (r) { return r.attivo; })) throw errore(400, 'Deve restare almeno un reparto attivo.');
    var w = scrivi(function (r) {
      norm.forEach(function (x) {
        var tipo = x.centrale ? 'centrale' : 'periferico';
        if (x.nuovo) ins('reparti', { id: x.id, nome: x.nome, centrale: x.centrale, attivo: x.attivo, ordine: x.ordine, tipo: tipo, piano: '', livello: 0, colore: '', descrizione: '' }, r);
        else agg('reparti', esistenti[x.id], { nome: x.nome, centrale: x.centrale, attivo: x.attivo, ordine: x.ordine, tipo: tipo }, r);
      });
    });
    evento(ctx, 'reparti.modifica', { reparti: norm.map(function (x) { return { id: x.id, nome: x.nome, centrale: x.centrale, attivo: x.attivo, nuovo: x.nuovo }; }) });
    return { rev: w.rev, reparti: repartiOrdinati().map(copia) };
  }

  function eliminaReparto(ctx, id) {
    richiedi(ctx, 'impostazioni');
    var rep = reparto(String(id));
    if (!rep) throw errore(404, 'Reparto non trovato.');
    if (rep.tipo === 'transito') throw errore(400, 'Il magazzino «' + NOME_TRANSITO + '» è del programma (la merce in viaggio con i DDT): non si può eliminare.');
    if (S.movimenti.some(function (m) { return m.repartoId === rep.id || m.repartoDestId === rep.id; })) {
      throw errore(409, 'Il reparto ha dei movimenti: non si può eliminare. Togli la spunta “Attivo” per nasconderlo.');
    }
    if (S.richieste.some(function (x) { return x.repartoId === rep.id || x.fornitoreId === rep.id; }) || S.ddt.some(function (x) { return x.origineId === rep.id || x.destinazioneId === rep.id; })) {
      throw errore(409, 'Il reparto compare in richieste o DDT: non si può eliminare. Togli la spunta “Attivo” per nasconderlo.');
    }
    if (S.armadi.some(function (x) { return x.repartoId === rep.id; }) || S.assortimento.some(function (x) { return x.repartoId === rep.id; })) {
      throw errore(409, 'Il reparto ha armadi o un assortimento: toglili prima da Magazzini e assortimento, oppure togli la spunta “Attivo” per nasconderlo.');
    }
    if (S.reparti.filter(function (r) { return r.tipo !== 'transito'; }).length <= 1) throw errore(400, 'Deve restare almeno un reparto.');
    var w = scrivi(function (r) { canc('reparti', rep, r); });
    var toccati = togliRepartoDagliUtenti([rep.id]);
    evento(ctx, 'reparti.elimina', { reparto: rep.nome });
    return { rev: w.rev, utentiAggiornati: toccati };
  }

  /* ======================= richieste e DDT (server/logistica.js) ======================= */

  var MAX_RIGHE = 300;
  var ESITI = ['rientro', 'perdita'];
  var NOME_STATO_RICHIESTA = { bozza: 'una bozza', inviata: 'inviata', in_lavorazione: 'in lavorazione', evasa: 'evasa', chiusa: 'chiusa', rifiutata: 'rifiutata', annullata: 'annullata' };
  var NOME_STATO_DDT = { in_preparazione: 'in preparazione', in_transito: 'già partito', ricevuto: 'già ricevuto', ricevuto_con_differenze: 'già ricevuto', annullato: 'annullato' };

  function validaColli(v, predefinito) {
    if (v === undefined || v === null || v === '') return predefinito;
    var n = numero(v, 'colli');
    if (n !== Math.floor(n) || n < 1 || n > 999) throw errore(400, 'I colli devono essere un numero intero da 1 a 999.');
    return n;
  }
  function magazzinoLog(id, ruolo, soloAttivo) {
    var r = reparto(String(id || ''));
    if (!r || r.tipo === 'transito') throw errore(400, ruolo + ' non valido: aggiorna la pagina.');
    if (soloAttivo && !r.attivo) throw errore(400, 'Il magazzino ' + r.nome + ' non è attivo.');
    return r;
  }
  function scrivibile(ctx, rep, cosa) {
    if (!puoScrivereReparto(ctx.permessi, rep.id)) throw errore(403, 'Non puoi ' + cosa + ' per il magazzino ' + rep.nome + '.');
  }
  function centrale() {
    return repartiOrdinati().filter(function (r) { return r.attivo && r.tipo !== 'transito' && (r.tipo === 'centrale' || r.centrale); })[0] || null;
  }
  function chi(ctx) { return { id: ctx.utente ? ctx.utente.id : null, nome: ctx.utente ? ctx.utente.nome : '' }; }
  function prossimoNumero(tipo) {
    var anno = new Date().getFullYear();
    var tabella = tipo === 'ric' ? S.richieste : S.ddt;
    var chiave = 'prog_' + tipo + '_' + anno;
    var massimo = tabella.filter(function (x) { return x.anno === anno; }).reduce(function (m, x) { return Math.max(m, x.progressivo); }, 0);
    var n = Math.max(Number(meta[chiave]) || 0, massimo) + 1;
    impostaMeta(chiave, n);
    return { anno: anno, progressivo: n, numero: (tipo === 'ric' ? 'RIC' : 'DDT') + '-' + anno + '-' + String(n).padStart(4, '0') };
  }
  function richiesta(id) { return S.richieste.filter(function (r) { return r.id === String(id); })[0] || null; }
  function righeRichiesta(id) { return ordina(S.richiesteRighe.filter(function (r) { return r.richiestaId === String(id); }), ['ordine']); }
  function ddtDi(id) { return S.ddt.filter(function (d) { return d.id === String(id); })[0] || null; }
  function righeDdt(id) { return ordina(S.ddtRighe.filter(function (r) { return r.ddtId === String(id); }), ['ordine']); }
  function avanzamento(id) {
    var ddt = S.ddt.filter(function (d) { return d.richiestaId === String(id); });
    var ids = ddt.map(function (d) { return d.id; });
    return C.avanzamentoRichiesta({ richiesteRighe: righeRichiesta(id), ddt: ddt, ddtRighe: S.ddtRighe.filter(function (r) { return ids.indexOf(r.ddtId) >= 0; }) }, String(id));
  }
  function rispostaRichiesta(r, id) { return { rev: r, richiesta: copia(richiesta(id)), righe: righeRichiesta(id).map(copia) }; }
  function rispostaDdt(r, id) { return { rev: r, ddt: copia(ddtDi(id)), righe: righeDdt(id).map(copia) }; }

  function validaRigheRichiesta(lista) {
    if (lista === undefined || lista === null) return null;
    if (!Array.isArray(lista)) throw errore(400, 'Righe della richiesta non valide.');
    if (lista.length > MAX_RIGHE) throw errore(400, 'Troppe righe in una richiesta (massimo ' + MAX_RIGHE + ').');
    var perArticolo = {};
    var out = [];
    lista.forEach(function (x, i) {
      if (!x || typeof x !== 'object') throw errore(400, 'Riga ' + (i + 1) + ' non valida.');
      var a = articolo(String(x.articoloId || ''));
      if (!a) throw errore(400, 'Riga ' + (i + 1) + ': articolo non trovato, aggiorna la pagina.');
      var q = numero(x.quantita, 'quantità');
      if (!(q > 0)) throw errore(400, 'Riga ' + (i + 1) + ' (' + a.nome + '): la quantità deve essere maggiore di zero.');
      var nota = testo(x.nota, 200, 'nota');
      var gia = perArticolo[a.id];
      if (gia) {
        gia.quantita = r3(gia.quantita + q);
        if (nota) gia.nota = (gia.nota ? gia.nota + ' · ' : '') + nota;
        if (gia.nota.length > 200) gia.nota = gia.nota.slice(0, 200);
        return;
      }
      if (!a.attivo && !x.id) throw errore(400, 'L’articolo ' + a.nome + ' non è attivo: non si può chiedere.');
      perArticolo[a.id] = { id: x.id ? String(x.id) : null, articoloId: a.id, articolo: a, quantita: q, nota: nota };
      out.push(perArticolo[a.id]);
    });
    return out;
  }
  function scriviRigheRichiesta(r, richiestaId, righe) {
    var vecchie = S.richiesteRighe.filter(function (x) { return x.richiestaId === richiestaId; });
    var tenute = {};
    righe.forEach(function (x, i) {
      var v = x.id ? vecchie.filter(function (y) { return y.id === x.id; })[0] : null;
      if (v && !tenute[x.id]) {
        tenute[x.id] = true;
        agg('richiesteRighe', v, { articoloId: x.articoloId, quantita: x.quantita, nota: x.nota, ordine: i }, r);
      } else {
        ins('richiesteRighe', { id: nuovoId('rr'), richiestaId: richiestaId, articoloId: x.articoloId, quantita: x.quantita, approvata: null, nota: x.nota, ordine: i }, r);
      }
    });
    vecchie.filter(function (v) { return !tenute[v.id]; }).forEach(function (v) { canc('richiesteRighe', v, r); });
  }

  function creaRichiesta(ctx, dati) {
    richiedi(ctx, 'richieste');
    dati = dati || {};
    var rep = magazzinoLog(dati.repartoId, 'Magazzino che chiede', true);
    scrivibile(ctx, rep, 'fare richieste');
    var fornitore = dati.fornitoreId ? magazzinoLog(dati.fornitoreId, 'Magazzino a cui chiedere', true) : centrale();
    if (!fornitore) throw errore(400, 'Non c’è una farmacia centrale attiva: chiedi all’amministratore di indicarla.');
    if (fornitore.id === rep.id) throw errore(400, 'Un magazzino non può fare una richiesta a se stesso.');
    var righe = validaRigheRichiesta(dati.righe) || [];
    if (!righe.length) throw errore(400, 'Aggiungi almeno un articolo alla richiesta.');
    var note = testo(dati.note, 500, 'note');
    var urgente = !!dati.urgente;
    var invia = !!dati.invia;
    var c = chi(ctx);
    var id = nuovoId('ric');
    var numeroAssegnato = '';
    var w = scrivi(function (r) {
      var n = prossimoNumero('ric');
      numeroAssegnato = n.numero;
      var ora = new Date().toISOString();
      ins('richieste', { id: id, numero: n.numero, anno: n.anno, progressivo: n.progressivo, repartoId: rep.id, fornitoreId: fornitore.id, stato: invia ? 'inviata' : 'bozza',
        urgente: urgente, note: note, creataDa: c.id, creataDaNome: c.nome, creataIl: ora, inviataIl: invia ? ora : null, presaDa: null, presaDaNome: '', presaIl: null,
        chiusaIl: null, chiusaDa: null, chiusaDaNome: '', motivo: '' }, r);
      scriviRigheRichiesta(r, id, righe);
    });
    evento(ctx, 'richieste.crea', {
      numero: numeroAssegnato, reparto: rep.nome, fornitore: fornitore.nome, urgente: urgente || undefined, inviata: invia,
      righe: righe.map(function (x) { return { articolo: x.articolo.nome, quantita: x.quantita }; })
    });
    return rispostaRichiesta(w.rev, id);
  }

  function richiestaDelRichiedente(ctx, id, cosa) {
    richiedi(ctx, 'richieste');
    var r = richiesta(id);
    if (!r) throw errore(404, 'Richiesta non trovata: forse è stata eliminata, aggiorna la pagina.');
    scrivibile(ctx, reparto(r.repartoId) || { id: r.repartoId, nome: r.repartoId }, cosa);
    return r;
  }
  function erroreStatoRichiesta(r, azione) {
    if (r.stato === 'in_lavorazione') {
      return errore(409, 'La farmacia ha già preso in carico la richiesta ' + r.numero + ': non si può più ' + azione + '. Se serve altro, fai una nuova richiesta.');
    }
    return errore(409, 'La richiesta ' + r.numero + ' è ' + (NOME_STATO_RICHIESTA[r.stato] || r.stato) + ': non si può più ' + azione + '.');
  }

  function modificaRichiesta(ctx, id, dati) {
    dati = dati || {};
    var prima = richiestaDelRichiedente(ctx, id, 'modificare le richieste');
    var righe = validaRigheRichiesta(dati.righe);
    if (righe && !righe.length) throw errore(400, 'Una richiesta deve avere almeno un articolo: per toglierla usa “Annulla richiesta”.');
    var note = dati.note === undefined ? null : testo(dati.note, 500, 'note');
    var urgente = dati.urgente === undefined ? null : !!dati.urgente;
    var w = scrivi(function (r) {
      var ora = richiesta(prima.id);
      if (ora.stato !== 'bozza' && ora.stato !== 'inviata') throw erroreStatoRichiesta(ora, 'modificare');
      if (righe) scriviRigheRichiesta(r, ora.id, righe);
      agg('richieste', ora, { note: note === null ? ora.note : note, urgente: urgente === null ? ora.urgente : urgente }, r);
    });
    evento(ctx, 'richieste.modifica', {
      numero: prima.numero, righe: righe ? righe.map(function (x) { return { articolo: x.articolo.nome, quantita: x.quantita }; }) : undefined,
      urgente: urgente === null ? undefined : urgente
    });
    return rispostaRichiesta(w.rev, prima.id);
  }

  function inviaRichiesta(ctx, id) {
    var prima = richiestaDelRichiedente(ctx, id, 'inviare le richieste');
    var w = scrivi(function (r) {
      var ora = richiesta(prima.id);
      if (ora.stato === 'inviata') throw errore(409, 'La richiesta ' + ora.numero + ' è già stata inviata.');
      if (ora.stato !== 'bozza') throw erroreStatoRichiesta(ora, 'inviare');
      if (!righeRichiesta(ora.id).length) throw errore(400, 'Aggiungi almeno un articolo prima di inviare la richiesta.');
      agg('richieste', ora, { stato: 'inviata', inviataIl: new Date().toISOString() }, r);
    });
    evento(ctx, 'richieste.invia', { numero: prima.numero });
    return rispostaRichiesta(w.rev, prima.id);
  }

  function annullaRichiesta(ctx, id, motivo) {
    var prima = richiestaDelRichiedente(ctx, id, 'annullare le richieste');
    motivo = testo(motivo, 300, 'motivo') || 'Annullata da chi l’ha fatta';
    var c = chi(ctx);
    var w = scrivi(function (r) {
      var ora = richiesta(prima.id);
      if (ora.stato !== 'bozza' && ora.stato !== 'inviata') throw erroreStatoRichiesta(ora, 'annullare');
      agg('richieste', ora, { stato: 'annullata', chiusaIl: new Date().toISOString(), chiusaDa: c.id, chiusaDaNome: c.nome, motivo: motivo }, r);
    });
    evento(ctx, 'richieste.annulla', { numero: prima.numero, motivo: motivo });
    return rispostaRichiesta(w.rev, prima.id);
  }

  function richiestaDaEvadere(ctx, id) {
    richiedi(ctx, 'evadiRichieste');
    var r = richiesta(id);
    if (!r) throw errore(404, 'Richiesta non trovata: forse è stata eliminata, aggiorna la pagina.');
    if (r.stato === 'bozza') throw errore(409, 'La richiesta ' + r.numero + ' non è ancora stata inviata.');
    scrivibile(ctx, reparto(r.fornitoreId) || { id: r.fornitoreId, nome: r.fornitoreId }, 'evadere le richieste');
    return r;
  }
  // dentro una scrittura: la richiesta inviata passa in lavorazione; le quantità da approvare partono da quelle chieste
  function prendi(ctx, r, ric) {
    if (ric.stato !== 'inviata') return false;
    var c = chi(ctx);
    agg('richieste', ric, { stato: 'in_lavorazione', presaDa: c.id, presaDaNome: c.nome, presaIl: new Date().toISOString() }, r);
    S.richiesteRighe.filter(function (x) { return x.richiestaId === ric.id && (x.approvata === null || x.approvata === undefined); })
      .forEach(function (x) { agg('richiesteRighe', x, { approvata: x.quantita }, r); });
    return true;
  }
  function controllaInLavorazione(r, azione) {
    if (r.stato !== 'inviata' && r.stato !== 'in_lavorazione') {
      throw errore(409, 'La richiesta ' + r.numero + ' è ' + (NOME_STATO_RICHIESTA[r.stato] || r.stato) + ': non si può più ' + azione + '.');
    }
  }

  function prendiRichiesta(ctx, id) {
    var prima = richiestaDaEvadere(ctx, id);
    if (prima.stato === 'in_lavorazione' && prima.presaDa === ctx.utente.id) return rispostaRichiesta(rev, prima.id);
    var presa = false;
    var w = scrivi(function (r) {
      var ora = richiesta(prima.id);
      if (ora.stato === 'in_lavorazione') {
        if (ora.presaDa && ora.presaDa !== ctx.utente.id) {
          throw errore(409, 'La richiesta ' + ora.numero + ' è già stata presa in carico da ' + (ora.presaDaNome || 'un altro utente') + '.');
        }
        return;
      }
      controllaInLavorazione(ora, 'prendere in carico');
      presa = prendi(ctx, r, ora);
    });
    if (presa) evento(ctx, 'richieste.prendi', { numero: prima.numero });
    return rispostaRichiesta(w.rev, prima.id);
  }

  function aggiornaStatoRichiesta(ctx, r, richiestaId) {
    var ric = richiesta(richiestaId);
    if (!ric) return null;
    var av = avanzamento(richiestaId);
    var tutto = av.length > 0 && av.every(function (x) { return r3(x.base - x.spedita) <= 0; });
    var qualcosa = av.some(function (x) { return x.spedita > 0; });
    var c = chi(ctx);
    if ((ric.stato === 'inviata' || ric.stato === 'in_lavorazione') && tutto && qualcosa) {
      agg('richieste', ric, { stato: 'evasa', chiusaIl: new Date().toISOString(), chiusaDa: c.id, chiusaDaNome: c.nome }, r);
      return 'evasa';
    }
    if (ric.stato === 'evasa' && !tutto) {
      agg('richieste', ric, { stato: 'in_lavorazione', chiusaIl: null, chiusaDa: null, chiusaDaNome: '' }, r);
      return 'in_lavorazione';
    }
    return null;
  }

  function approvaRichiesta(ctx, id, dati) {
    var prima = richiestaDaEvadere(ctx, id);
    var lista = dati && dati.righe;
    if (!Array.isArray(lista) || !lista.length) throw errore(400, 'Indica le quantità approvate.');
    if (lista.length > MAX_RIGHE) throw errore(400, 'Troppe righe (massimo ' + MAX_RIGHE + ').');
    var valori = lista.map(function (x, i) {
      if (!x || typeof x !== 'object' || !x.id) throw errore(400, 'Riga ' + (i + 1) + ' non valida.');
      return { id: String(x.id), approvata: numero(x.approvata, 'quantità approvata', { min: 0 }) };
    });
    var cambi = [];
    var nuovoStato = null;
    var w = scrivi(function (r) {
      var ora = richiesta(prima.id);
      controllaInLavorazione(ora, 'approvare');
      prendi(ctx, r, ora);
      var perRiga = {};
      avanzamento(ora.id).forEach(function (x) { perRiga[x.rigaId] = x; });
      valori.forEach(function (v) {
        var x = perRiga[v.id];
        if (!x) throw errore(400, 'Riga della richiesta non trovata: aggiorna la pagina.');
        var gia = r3(x.spedita + x.inPreparazione);
        var art = articolo(x.articoloId);
        if (v.approvata < gia) throw errore(409, 'Di ' + (art ? art.nome : 'un articolo') + ' sono già state preparate o spedite ' + fmt(gia) + ': non puoi approvarne di meno.');
        if (v.approvata !== x.approvata) cambi.push({ articolo: art ? art.nome : x.articoloId, richiesta: x.quantita, approvata: v.approvata });
        agg('richiesteRighe', S.richiesteRighe.filter(function (y) { return y.id === v.id; })[0], { approvata: v.approvata }, r);
      });
      agg('richieste', ora, {}, r);
      nuovoStato = aggiornaStatoRichiesta(ctx, r, ora.id);
    });
    evento(ctx, 'richieste.approva', { numero: prima.numero, cambi: cambi, stato: nuovoStato || undefined });
    return rispostaRichiesta(w.rev, prima.id);
  }

  function rifiutaRichiesta(ctx, id, motivo) {
    var prima = richiestaDaEvadere(ctx, id);
    motivo = testo(motivo, 300, 'motivo');
    if (!motivo) throw errore(400, 'Scrivi il motivo del rifiuto: lo legge chi ha fatto la richiesta.');
    var c = chi(ctx);
    var w = scrivi(function (r) {
      var ora = richiesta(prima.id);
      controllaInLavorazione(ora, 'rifiutare');
      if (S.ddt.some(function (d) { return d.richiestaId === ora.id && d.stato !== 'annullato'; })) {
        throw errore(409, 'Per la richiesta ' + ora.numero + ' ci sono già dei DDT: chiudila con il residuo invece di rifiutarla (prima annulla i DDT ancora in preparazione).');
      }
      var adesso = new Date().toISOString();
      agg('richieste', ora, {
        stato: 'rifiutata', presaDa: ora.presaDa === null || ora.presaDa === undefined ? c.id : ora.presaDa,
        presaDaNome: ora.presaIl ? ora.presaDaNome : c.nome, presaIl: ora.presaIl || adesso,
        chiusaIl: adesso, chiusaDa: c.id, chiusaDaNome: c.nome, motivo: motivo
      }, r);
    });
    evento(ctx, 'richieste.rifiuta', { numero: prima.numero, motivo: motivo });
    return rispostaRichiesta(w.rev, prima.id);
  }

  function chiudiRichiesta(ctx, id, motivo) {
    var prima = richiestaDaEvadere(ctx, id);
    motivo = testo(motivo, 300, 'motivo') || 'Chiusa con residuo';
    var c = chi(ctx);
    var w = scrivi(function (r) {
      var ora = richiesta(prima.id);
      controllaInLavorazione(ora, 'chiudere');
      var inPrep = ordina(S.ddt, ['anno', 'progressivo']).filter(function (d) { return d.richiestaId === ora.id && d.stato === 'in_preparazione'; })[0];
      if (inPrep) throw errore(409, 'Il DDT ' + inPrep.numero + ' di questa richiesta è ancora in preparazione: spediscilo o annullalo prima di chiudere la richiesta.');
      prendi(ctx, r, ora);
      agg('richieste', ora, { stato: 'chiusa', chiusaIl: new Date().toISOString(), chiusaDa: c.id, chiusaDaNome: c.nome, motivo: motivo }, r);
    });
    var residuo = avanzamento(prima.id).filter(function (x) { return x.residuo > 0; }).length;
    evento(ctx, 'richieste.chiudi', { numero: prima.numero, motivo: motivo, righeConResiduo: residuo });
    return rispostaRichiesta(w.rev, prima.id);
  }

  /* ---------- DDT: preparazione e lotti ---------- */

  function nuovaRipartizione(origineId, tranneDdtId) { return { origineId: origineId, tranne: tranneDdtId || '', presi: {} }; }
  // lotti liberi (FEFO): giacenza dei lotti meno quanto è già in altri DDT in preparazione dallo stesso magazzino
  function lottiLiberi(rip, articoloId) {
    var impegnati = {};
    var inPrep = {};
    S.ddt.forEach(function (d) { if (d.stato === 'in_preparazione' && d.origineId === rip.origineId && d.id !== rip.tranne) inPrep[d.id] = true; });
    S.ddtRighe.forEach(function (x) { if (inPrep[x.ddtId] && x.articoloId === articoloId) impegnati[x.lotto] = r3((impegnati[x.lotto] || 0) + x.quantita); });
    return C.lotti(statoArticolo(articoloId), articoloId, rip.origineId).map(function (l) {
      return { lotto: l.lotto, scadenza: l.scadenza, quantita: r3(l.quantita - (impegnati[l.lotto] || 0) - (rip.presi[articoloId + '|' + l.lotto] || 0)) };
    }).filter(function (l) { return l.quantita > 0; });
  }
  function ripartisciDdt(rip, art, quantita, lottoScelto, nomeOrigine) {
    var liberi = lottiLiberi(rip, art.id);
    var q = r3(quantita);
    var parti = [];
    function prendiL(l) {
      var p = Math.min(q, l.quantita);
      if (p <= 0) return;
      var gia = parti.filter(function (x) { return x.lotto === l.lotto; })[0];
      if (gia) gia.quantita = r3(gia.quantita + p); else parti.push({ lotto: l.lotto, scadenza: l.scadenza, quantita: p });
      l.quantita = r3(l.quantita - p);
      q = r3(q - p);
    }
    if (lottoScelto) {
      var scelto = liberi.filter(function (l) { return l.lotto === lottoScelto; })[0];
      if (!scelto) {
        throw errore(409, 'Il lotto ' + lottoScelto + ' di ' + art.nome + ' non è disponibile in ' + nomeOrigine +
          ' (forse è già in un altro DDT o l’ha appena usato un altro utente): aggiorna e scegli un altro lotto.');
      }
      prendiL(scelto);
    }
    for (var i = 0; i < liberi.length && q > 0; i++) prendiL(liberi[i]);
    parti.forEach(function (p) { var k = art.id + '|' + p.lotto; rip.presi[k] = r3((rip.presi[k] || 0) + p.quantita); });
    return { parti: parti, mancante: q };
  }
  function scriviRigheDdt(r, ddtId, righe) {
    S.ddtRighe.filter(function (x) { return x.ddtId === ddtId; }).forEach(function (x) { canc('ddtRighe', x, r); });
    var unite = [];
    var indice = {};
    righe.forEach(function (x) {
      var k = x.articoloId + '|' + (x.lotto || '') + '|' + (x.richiestaRigaId || '');
      if (indice[k] !== undefined) { unite[indice[k]].quantita = r3(unite[indice[k]].quantita + x.quantita); return; }
      indice[k] = unite.length;
      unite.push(Object.assign({}, x));
    });
    unite.forEach(function (x, i) {
      ins('ddtRighe', { id: nuovoId('dr'), ddtId: ddtId, articoloId: x.articoloId, richiestaRigaId: x.richiestaRigaId || null, lotto: x.lotto || '', scadenza: x.scadenza || '',
        quantita: x.quantita, ricevuta: null, esito: '', nota: x.nota || '', ordine: i }, r);
    });
    return unite.length;
  }
  function inserisciDdt(ctx, r, t, righe) {
    var n = prossimoNumero('ddt');
    var id = nuovoId('ddt');
    var c = chi(ctx);
    ins('ddt', { id: id, numero: n.numero, anno: n.anno, progressivo: n.progressivo, origineId: t.origineId, destinazioneId: t.destinazioneId, richiestaId: t.richiestaId || null,
      stato: 'in_preparazione', causale: t.causale, colli: t.colli, note: t.note, preparatoDa: c.id, preparatoDaNome: c.nome, preparatoIl: new Date().toISOString(),
      trasportatoreId: null, trasportatoreNome: '', partitoIl: null, ricevutoDa: null, ricevutoDaNome: '', ricevutoIl: null, noteRicezione: '',
      annullatoIl: null, annullatoDa: null, motivoAnnullo: '' }, r);
    scriviRigheDdt(r, id, righe);
    return { id: id, numero: n.numero };
  }
  function validaRigheDdt(lista) {
    if (!Array.isArray(lista) || !lista.length) throw errore(400, 'Aggiungi almeno un articolo al DDT.');
    if (lista.length > MAX_RIGHE) throw errore(400, 'Troppe righe in un DDT (massimo ' + MAX_RIGHE + ').');
    return lista.map(function (x, i) {
      if (!x || typeof x !== 'object') throw errore(400, 'Riga ' + (i + 1) + ' non valida.');
      var a = articolo(String(x.articoloId || ''));
      if (!a) throw errore(400, 'Riga ' + (i + 1) + ': articolo non trovato, aggiorna la pagina.');
      var q = numero(x.quantita, 'quantità');
      if (!(q > 0)) throw errore(400, 'Riga ' + (i + 1) + ' (' + a.nome + '): la quantità deve essere maggiore di zero.');
      return { articolo: a, quantita: q, lotto: testo(x.lotto, 60, 'lotto'), nota: testo(x.nota, 200, 'nota'), richiestaRigaId: x.richiestaRigaId ? String(x.richiestaRigaId) : null };
    });
  }
  function righeDaMano(rip, righe, origine) {
    var out = [];
    var scoperti = [];
    righe.forEach(function (x) {
      var res = ripartisciDdt(rip, x.articolo, x.quantita, x.lotto, origine.nome);
      res.parti.forEach(function (p) {
        out.push({ articoloId: x.articolo.id, richiestaRigaId: x.richiestaRigaId, lotto: p.lotto, scadenza: p.scadenza, quantita: p.quantita, nota: x.nota });
      });
      if (res.mancante > 0) scoperti.push(x.articolo.nome + ' (liberi ' + fmt(x.quantita - res.mancante) + ' su ' + fmt(x.quantita) + ')');
    });
    if (scoperti.length) {
      throw errore(409, 'In ' + origine.nome + ' non c’è abbastanza merce per: ' + scoperti.join(', ') +
        '. Non si conta la merce già messa in altri DDT in preparazione. Correggi le quantità e riprova.');
    }
    return out;
  }

  function creaDdt(ctx, dati) {
    richiedi(ctx, 'ddt');
    dati = dati || {};
    var origine = magazzinoLog(dati.origineId, 'Magazzino di partenza', true);
    scrivibile(ctx, origine, 'preparare DDT');
    var dest = magazzinoLog(dati.destinazioneId, 'Magazzino di arrivo', true);
    if (dest.id === origine.id) throw errore(400, 'Il magazzino di partenza e quello di arrivo sono uguali.');
    var causale = testo(dati.causale, 100, 'causale') || 'Trasferimento interno';
    var colli = validaColli(dati.colli, 1);
    var note = testo(dati.note, 500, 'note');
    var righe = validaRigheDdt(dati.righe);
    righe.forEach(function (x) {
      if (!x.articolo.attivo) throw errore(400, 'L’articolo ' + x.articolo.nome + ' non è attivo.');
      x.richiestaRigaId = null;
    });
    var creato = null;
    var w = scrivi(function (r) {
      var parti = righeDaMano(nuovaRipartizione(origine.id), righe, origine);
      creato = inserisciDdt(ctx, r, { origineId: origine.id, destinazioneId: dest.id, causale: causale, colli: colli, note: note }, parti);
    });
    evento(ctx, 'ddt.crea', {
      numero: creato.numero, da: origine.nome, a: dest.nome, causale: causale,
      righe: righe.map(function (x) { return { articolo: x.articolo.nome, quantita: x.quantita, lotto: x.lotto || undefined }; })
    });
    return rispostaDdt(w.rev, creato.id);
  }

  function preparaDdtRichiesta(ctx, id, dati) {
    var prima = richiestaDaEvadere(ctx, id);
    richiedi(ctx, 'ddt');
    dati = dati || {};
    var origine = magazzinoLog(prima.fornitoreId, 'Magazzino di partenza', true);
    scrivibile(ctx, origine, 'preparare DDT');
    var dest = magazzinoLog(prima.repartoId, 'Magazzino di arrivo');
    var scelte = null;
    if (dati.righe !== undefined && dati.righe !== null) {
      if (!Array.isArray(dati.righe)) throw errore(400, 'Righe non valide.');
      scelte = {};
      dati.righe.forEach(function (x) {
        if (!x || !x.rigaId) throw errore(400, 'Riga non valida: aggiorna la pagina.');
        scelte[String(x.rigaId)] = numero(x.quantita, 'quantità', { min: 0 });
      });
    }
    var causale = testo(dati.causale, 100, 'causale') || ('Rifornimento su richiesta ' + prima.numero);
    var colli = validaColli(dati.colli, 1);
    var note = testo(dati.note, 500, 'note');
    var mancanti = [];
    var creato = null;
    var w = scrivi(function (r) {
      mancanti = [];
      var ora = richiesta(prima.id);
      controllaInLavorazione(ora, 'evadere');
      prendi(ctx, r, ora);
      var av = avanzamento(ora.id);
      if (scelte) {
        Object.keys(scelte).forEach(function (k) {
          if (!av.some(function (x) { return x.rigaId === k; })) throw errore(400, 'Riga della richiesta non trovata: aggiorna la pagina.');
        });
      }
      var rip = nuovaRipartizione(origine.id);
      var parti = [];
      av.forEach(function (x) {
        var art = articolo(x.articoloId);
        var q = scelte ? (scelte[x.rigaId] || 0) : x.residuo;
        if (scelte && q > x.residuo) throw errore(400, 'Di ' + art.nome + ' puoi preparare al massimo ' + fmt(x.residuo) + ' (quello che resta dell’approvato).');
        if (!(q > 0)) return;
        var res = ripartisciDdt(rip, art, q, '', origine.nome);
        res.parti.forEach(function (p) {
          parti.push({ articoloId: art.id, richiestaRigaId: x.rigaId, lotto: p.lotto, scadenza: p.scadenza, quantita: p.quantita, nota: x.nota });
        });
        if (res.mancante > 0) mancanti.push({ articoloId: art.id, articolo: art.nome, richiesta: q, preparata: r3(q - res.mancante) });
      });
      if (!parti.length) {
        if (!av.some(function (x) { return x.residuo > 0; })) throw errore(409, 'Per la richiesta ' + ora.numero + ' non resta niente da preparare: l’approvato è già in DDT o spedito.');
        throw errore(409, 'In ' + origine.nome + ' non c’è merce libera per gli articoli da preparare: il DDT non è stato creato.');
      }
      creato = inserisciDdt(ctx, r, { origineId: origine.id, destinazioneId: dest.id, richiestaId: ora.id, causale: causale, colli: colli, note: note }, parti);
    });
    evento(ctx, 'ddt.crea', { numero: creato.numero, richiesta: prima.numero, da: origine.nome, a: dest.nome, mancanti: mancanti.length ? mancanti : undefined });
    var out = rispostaDdt(w.rev, creato.id);
    out.mancanti = mancanti;
    out.richiesta = copia(richiesta(prima.id));
    return out;
  }

  function ddtDellOrigine(ctx, id, cosa) {
    richiedi(ctx, 'ddt');
    var d = ddtDi(id);
    if (!d) throw errore(404, 'DDT non trovato: aggiorna la pagina.');
    var origine = reparto(d.origineId) || { id: d.origineId, nome: d.origineId };
    scrivibile(ctx, origine, cosa);
    return { ddt: d, origine: origine };
  }
  function erroreStatoDdt(d, azione) {
    return errore(409, 'Il DDT ' + d.numero + ' è ' + (NOME_STATO_DDT[d.stato] || d.stato) + ': non si può più ' + azione + '.');
  }

  function modificaDdt(ctx, id, dati) {
    dati = dati || {};
    var x = ddtDellOrigine(ctx, id, 'modificare i DDT');
    var prima = x.ddt;
    var origine = x.origine;
    var causale = dati.causale === undefined ? null : (testo(dati.causale, 100, 'causale') || 'Trasferimento interno');
    var colli = dati.colli === undefined ? null : validaColli(dati.colli, 1);
    var note = dati.note === undefined ? null : testo(dati.note, 500, 'note');
    var righe = dati.righe === undefined ? null : validaRigheDdt(dati.righe);
    var w = scrivi(function (r) {
      var ora = ddtDi(prima.id);
      if (ora.stato !== 'in_preparazione') throw erroreStatoDdt(ora, 'modificare');
      if (righe) {
        var limite = {};
        var articoloRiga = {};
        if (ora.richiestaId) {
          var attuali = {};
          righeDdt(ora.id).forEach(function (rr) {
            if (rr.richiestaRigaId) attuali[rr.richiestaRigaId] = r3((attuali[rr.richiestaRigaId] || 0) + rr.quantita);
          });
          avanzamento(ora.richiestaId).forEach(function (a) {
            limite[a.rigaId] = r3(a.base - a.spedita - (a.inPreparazione - (attuali[a.rigaId] || 0)));
            articoloRiga[a.rigaId] = a.articoloId;
          });
        }
        var somme = {};
        righe.forEach(function (rr) {
          if (!rr.richiestaRigaId) return;
          if (!ora.richiestaId || limite[rr.richiestaRigaId] === undefined || articoloRiga[rr.richiestaRigaId] !== rr.articolo.id) {
            throw errore(400, 'La riga di ' + rr.articolo.nome + ' non appartiene alla richiesta di questo DDT: aggiorna la pagina.');
          }
          somme[rr.richiestaRigaId] = r3((somme[rr.richiestaRigaId] || 0) + rr.quantita);
          if (somme[rr.richiestaRigaId] > limite[rr.richiestaRigaId]) {
            throw errore(400, 'Di ' + rr.articolo.nome + ' puoi mettere al massimo ' + fmt(Math.max(0, limite[rr.richiestaRigaId])) + ' (quello che resta dell’approvato).');
          }
        });
        righe.forEach(function (rr) {
          if (!rr.richiestaRigaId && !rr.articolo.attivo) throw errore(400, 'L’articolo ' + rr.articolo.nome + ' non è attivo.');
        });
        scriviRigheDdt(r, ora.id, righeDaMano(nuovaRipartizione(origine.id, ora.id), righe, origine));
      }
      agg('ddt', ora, { causale: causale === null ? ora.causale : causale, colli: colli === null ? ora.colli : colli, note: note === null ? ora.note : note }, r);
    });
    evento(ctx, 'ddt.modifica', {
      numero: prima.numero, causale: causale === null ? undefined : causale, colli: colli === null ? undefined : colli,
      righe: righe ? righe.map(function (rr) { return { articolo: rr.articolo.nome, quantita: rr.quantita, lotto: rr.lotto || undefined }; }) : undefined
    });
    return rispostaDdt(w.rev, prima.id);
  }

  function movimentoDdt(ctx, r, d, m) {
    return inserisciMovimento(ctx, r, Object.assign({ data: oggi(), documento: d.numero, causale: d.causale, note: '', fornitore: '', prezzo: null, ddtId: d.id }, m));
  }

  function spedisciDdt(ctx, id, dati) {
    dati = dati || {};
    var x = ddtDellOrigine(ctx, id, 'spedire i DDT');
    var prima = x.ddt;
    var origine = x.origine;
    var trasportatoreId = null;
    var trasportatore = '';
    if (dati.trasportatoreId) {
      var u = utente(String(dati.trasportatoreId));
      if (!u || !u.attivo) throw errore(400, 'La persona scelta per il trasporto non è tra gli utenti attivi: aggiorna la pagina.');
      trasportatoreId = u.id;
      trasportatore = u.nome;
    } else trasportatore = testo(dati.trasportatoreNome, 100, 'trasportatore');
    if (!trasportatore) throw errore(400, 'Indica chi trasporta la merce.');
    var colli = dati.colli === undefined ? null : validaColli(dati.colli, 1);
    var nuovoStatoRichiesta = null;
    var w = scrivi(function (r) {
      var d = ddtDi(prima.id);
      if (d.stato !== 'in_preparazione') throw erroreStatoDdt(d, 'spedire');
      var dest = reparto(d.destinazioneId);
      if (!dest || !dest.attivo) throw errore(409, 'Il magazzino di arrivo ' + (dest ? dest.nome : '') + ' non è più attivo: annulla il DDT.');
      var righe = righeDdt(d.id);
      if (!righe.length) throw errore(409, 'Il DDT ' + d.numero + ' non ha righe: aggiungi gli articoli o annullalo.');
      var perLotto = {};
      righe.forEach(function (rr) {
        var k = rr.articoloId + '|' + rr.lotto;
        if (!perLotto[k]) perLotto[k] = { articoloId: rr.articoloId, lotto: rr.lotto, quantita: 0 };
        perLotto[k].quantita = r3(perLotto[k].quantita + rr.quantita);
      });
      var scoperti = [];
      Object.keys(perLotto).forEach(function (k) {
        var p = perLotto[k];
        var disp = C.disponibilitaLotto(statoArticolo(p.articoloId), p.articoloId, d.origineId, null, p.lotto);
        if (disp < p.quantita) {
          var art = articolo(p.articoloId);
          scoperti.push((art ? art.nome : p.articoloId) + (p.lotto ? ' lotto ' + p.lotto : ' senza lotto') + ': ' + fmt(disp) + ' invece di ' + fmt(p.quantita));
        }
      });
      if (scoperti.length) {
        throw errore(409, 'Nel frattempo la giacenza in ' + origine.nome + ' è cambiata e non basta più per: ' + scoperti.join('; ') + '. Correggi le righe del DDT e riprova.');
      }
      righe.forEach(function (rr) {
        movimentoDdt(ctx, r, d, { tipo: 'trasferimento', articoloId: rr.articoloId, repartoId: d.origineId, repartoDestId: ID_TRANSITO, quantita: rr.quantita, lotto: rr.lotto, scadenza: rr.scadenza, note: 'Verso ' + dest.nome });
      });
      agg('ddt', d, { stato: 'in_transito', trasportatoreId: trasportatoreId, trasportatoreNome: trasportatore, partitoIl: new Date().toISOString(), colli: colli === null ? d.colli : colli }, r);
      if (d.richiestaId) nuovoStatoRichiesta = aggiornaStatoRichiesta(ctx, r, d.richiestaId);
    });
    evento(ctx, 'ddt.spedisci', { numero: prima.numero, trasportatore: trasportatore, colli: colli === null ? prima.colli : colli, richiesta: nuovoStatoRichiesta ? nuovoStatoRichiesta : undefined });
    return rispostaDdt(w.rev, prima.id);
  }

  function riceviDdt(ctx, id, dati) {
    richiedi(ctx, 'riceviDdt');
    dati = dati || {};
    var prima = ddtDi(id);
    if (!prima) throw errore(404, 'DDT non trovato: aggiorna la pagina.');
    var dest = reparto(prima.destinazioneId) || { id: prima.destinazioneId, nome: prima.destinazioneId };
    scrivibile(ctx, dest, 'ricevere i DDT');
    var indicate = {};
    if (dati.righe !== undefined && dati.righe !== null) {
      if (!Array.isArray(dati.righe)) throw errore(400, 'Righe della ricezione non valide.');
      dati.righe.forEach(function (x) {
        if (!x || !x.id) throw errore(400, 'Riga della ricezione non valida: aggiorna la pagina.');
        indicate[String(x.id)] = { ricevuta: numero(x.ricevuta, 'quantità ricevuta', { min: 0 }), esito: x.esito ? String(x.esito) : '', nota: testo(x.nota, 200, 'nota') };
      });
    }
    var noteRicezione = testo(dati.note, 500, 'note');
    var c = chi(ctx);
    var differenze = [];
    var w = scrivi(function (r) {
      differenze = [];
      var d = ddtDi(prima.id);
      if (d.stato === 'in_preparazione') throw errore(409, 'Il DDT ' + d.numero + ' non è ancora partito: si riceve dopo la spedizione.');
      if (d.stato !== 'in_transito') throw erroreStatoDdt(d, 'ricevere');
      var origine = reparto(d.origineId) || { nome: d.origineId };
      var righe = righeDdt(d.id);
      Object.keys(indicate).forEach(function (k) {
        if (!righe.some(function (rr) { return rr.id === k; })) throw errore(400, 'Riga del DDT non trovata: aggiorna la pagina.');
      });
      righe.forEach(function (rr) {
        var art = articolo(rr.articoloId);
        var nome = (art ? art.nome : rr.articoloId) + (rr.lotto ? ' (lotto ' + rr.lotto + ')' : '');
        var v = indicate[rr.id] || { ricevuta: rr.quantita, esito: '', nota: '' };
        if (v.ricevuta > rr.quantita) throw errore(400, 'Di ' + nome + ' sono partite ' + fmt(rr.quantita) + ': non puoi riceverne di più.');
        var diff = r3(rr.quantita - v.ricevuta);
        if (diff > 0 && ESITI.indexOf(v.esito) < 0) {
          throw errore(400, 'Di ' + nome + ' mancano ' + fmt(diff) + ': indica se rientrano in ' + origine.nome + ' o se sono una perdita in viaggio.');
        }
        if (v.ricevuta > 0) {
          movimentoDdt(ctx, r, d, { tipo: 'trasferimento', articoloId: rr.articoloId, repartoId: ID_TRANSITO, repartoDestId: d.destinazioneId, quantita: v.ricevuta, lotto: rr.lotto, scadenza: rr.scadenza, note: 'Da ' + origine.nome });
        }
        if (diff > 0) {
          var causale = 'Differenza alla ricezione DDT ' + d.numero;
          if (v.esito === 'rientro') {
            movimentoDdt(ctx, r, d, { tipo: 'trasferimento', articoloId: rr.articoloId, repartoId: ID_TRANSITO, repartoDestId: d.origineId, quantita: diff, lotto: rr.lotto, scadenza: rr.scadenza,
              causale: causale, note: 'Rientro' + (v.nota ? ': ' + v.nota : '') });
          } else {
            movimentoDdt(ctx, r, d, { tipo: 'perdita', articoloId: rr.articoloId, repartoId: ID_TRANSITO, repartoDestId: null, quantita: diff, lotto: rr.lotto, scadenza: rr.scadenza,
              causale: causale, note: 'Perdita in viaggio' + (v.nota ? ': ' + v.nota : '') });
          }
          differenze.push({ articolo: nome, partita: rr.quantita, ricevuta: v.ricevuta, esito: v.esito });
        }
        agg('ddtRighe', rr, { ricevuta: v.ricevuta, esito: diff > 0 ? v.esito : '', nota: v.nota || rr.nota || '' }, r);
      });
      agg('ddt', d, { stato: differenze.length ? 'ricevuto_con_differenze' : 'ricevuto', ricevutoDa: c.id, ricevutoDaNome: c.nome, ricevutoIl: new Date().toISOString(), noteRicezione: noteRicezione }, r);
    });
    evento(ctx, 'ddt.ricevi', { numero: prima.numero, a: dest.nome, differenze: differenze.length ? differenze : undefined });
    return rispostaDdt(w.rev, prima.id);
  }

  function annullaDdt(ctx, id, motivo) {
    var x = ddtDellOrigine(ctx, id, 'annullare i DDT');
    var prima = x.ddt;
    motivo = testo(motivo, 300, 'motivo') || 'DDT annullato';
    var c = chi(ctx);
    var eraPartito = false;
    var nuovoStatoRichiesta = null;
    var w = scrivi(function (r) {
      var d = ddtDi(prima.id);
      if (d.stato === 'ricevuto' || d.stato === 'ricevuto_con_differenze') {
        throw errore(409, 'Il DDT ' + d.numero + ' è già stato ricevuto: non si annulla. Per restituire la merce prepara un DDT di reso dalla pagina Trasferimenti.');
      }
      if (d.stato === 'annullato') throw errore(409, 'Il DDT ' + d.numero + ' è già annullato.');
      if (d.stato === 'in_transito') {
        eraPartito = true;
        righeDdt(d.id).forEach(function (rr) {
          movimentoDdt(ctx, r, d, { tipo: 'trasferimento', articoloId: rr.articoloId, repartoId: ID_TRANSITO, repartoDestId: d.origineId, quantita: rr.quantita, lotto: rr.lotto, scadenza: rr.scadenza,
            causale: 'Annullo DDT ' + d.numero, note: motivo });
        });
      }
      agg('ddt', d, { stato: 'annullato', annullatoIl: new Date().toISOString(), annullatoDa: c.nome, motivoAnnullo: motivo }, r);
      if (d.richiestaId) nuovoStatoRichiesta = aggiornaStatoRichiesta(ctx, r, d.richiestaId);
    });
    evento(ctx, 'ddt.annulla', { numero: prima.numero, motivo: motivo, rientro: eraPartito || undefined, richiesta: nuovoStatoRichiesta || undefined });
    return rispostaDdt(w.rev, prima.id);
  }

  function trasportatori(ctx) {
    richiedi(ctx, 'ddt');
    return { utenti: utentiPerNome().filter(function (u) { return u.attivo; }).map(function (u) { return { id: u.id, nome: u.nome, ruolo: u.ruolo }; }) };
  }

  /* ======================= magazzini, armadi, assortimento (server/struttura.js) ======================= */

  var TIPI_MAGAZZINO = ['centrale', 'periferico'];
  var TIPI_ARMADIO = ['armadio', 'frigorifero', 'cassettiera', 'carrello', 'cassaforte'];
  var MAX_RIGHE_STRUTTURA = 3000;
  var MAX_DETTAGLI_EVENTO = 20;

  function numeroS(v, campo) {
    if (v === undefined || v === null || v === '') return 0;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    if (!isFinite(n)) throw errore(400, 'Il campo ' + campo + ' non è un numero.');
    if (n < 0) throw errore(400, 'Il campo ' + campo + ' non può essere negativo.');
    if (n > 1e9) throw errore(400, 'Il campo ' + campo + ' è troppo grande.');
    return Math.round(n * 1000) / 1000;
  }
  function intero(v, campo, min, max, predefinito) {
    if (v === undefined || v === null || v === '') {
      if (predefinito !== undefined) return predefinito;
      throw errore(400, 'Manca il campo ' + campo + '.');
    }
    var n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!isFinite(n) || Math.floor(n) !== n) throw errore(400, 'Il campo ' + campo + ' deve essere un numero intero.');
    if (n < min || n > max) throw errore(400, 'Il campo ' + campo + ' va da ' + min + ' a ' + max + '.');
    return n;
  }
  function coloreS(v) {
    var c = String(v === undefined || v === null ? '' : v).trim();
    if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) throw errore(400, 'Il colore deve essere nella forma #RRGGBB.');
    return c.toLowerCase();
  }
  function siNo(v, predefinito) {
    if (v === undefined || v === null) return predefinito;
    return v === true || v === 1 || v === '1' || v === 'true';
  }
  function pianoDaLivello(livello) {
    if (livello === 0) return 'Piano terra';
    if (livello === -1) return 'Seminterrato';
    if (livello < 0) return 'Piano ' + livello;
    return livello + '° piano';
  }
  function controllaSoglie(nome, min, riordino, max) {
    if (min > 0 && riordino > 0 && min > riordino) throw errore(400, nome + ': la scorta minima (' + min + ') non può superare il punto di riordino (' + riordino + ').');
    if (riordino > 0 && max > 0 && riordino > max) throw errore(400, nome + ': il punto di riordino (' + riordino + ') non può superare la scorta massima (' + max + ').');
    if (min > 0 && max > 0 && min > max) throw errore(400, nome + ': la scorta minima (' + min + ') non può superare la scorta massima (' + max + ').');
  }
  function magazzinoS(id, perScrivere) {
    var rep = reparto(String(id || ''));
    if (!rep) throw errore(perScrivere ? 400 : 404, perScrivere ? 'Magazzino non trovato: aggiorna la pagina.' : 'Magazzino non trovato.');
    if (rep.id === ID_TRANSITO || rep.tipo === 'transito') {
      throw errore(400, 'Il magazzino «In transito» è di sistema: non si modifica, non si elimina e non ha armadi né assortimento.');
    }
    return rep;
  }
  function armadio(id) { return S.armadi.filter(function (a) { return a.id === String(id || ''); })[0] || null; }

  function validaMagazzino(dati, prima) {
    dati = dati && typeof dati === 'object' ? dati : {};
    var base = prima || { nome: '', tipo: 'periferico', piano: '', livello: 0, colore: '', descrizione: '', attivo: true, ordine: null };
    function dato(k) { return dati[k] === undefined ? base[k] : dati[k]; }
    var v = {};
    v.nome = testo(dato('nome'), 80, 'nome');
    if (!v.nome) throw errore(400, 'Scrivi il nome del magazzino.');
    v.tipo = String(dato('tipo') || 'periferico');
    if (TIPI_MAGAZZINO.indexOf(v.tipo) < 0) throw errore(400, 'Il tipo del magazzino deve essere «centrale» (farmacia centrale) o «periferico».');
    v.livello = intero(dato('livello'), 'livello', -5, 60, 0);
    v.piano = testo(dato('piano'), 40, 'piano') || pianoDaLivello(v.livello);
    v.colore = coloreS(dato('colore'));
    v.descrizione = testo(dato('descrizione'), 300, 'descrizione');
    v.attivo = siNo(dato('attivo'), true);
    v.ordine = dati.ordine === undefined || dati.ordine === null || dati.ordine === '' ? base.ordine : intero(dati.ordine, 'ordine', 0, 9998);
    if (v.tipo === 'centrale' && !v.attivo) throw errore(400, 'La farmacia centrale non si può disattivare: prima scegli un altro magazzino come farmacia centrale.');
    return v;
  }
  function controllaNomeMagazzino(nome, tranneId) {
    var n = nome.toLowerCase();
    if (S.reparti.some(function (r) { return r.nome.toLowerCase() === n && r.id !== String(tranneId || ''); })) throw errore(409, 'Esiste già un magazzino che si chiama «' + nome + '».');
  }
  function declassaCentrale(r, tranneId) {
    S.reparti.forEach(function (x) {
      if ((x.tipo === 'centrale' || x.centrale) && x.id !== String(tranneId || '') && x.id !== ID_TRANSITO) agg('reparti', x, { tipo: 'periferico', centrale: false }, r);
    });
  }
  function centraleS() {
    return repartiOrdinati().filter(function (r) { return (r.tipo === 'centrale' || r.centrale) && r.id !== ID_TRANSITO; })[0] || null;
  }

  function creaMagazzino(ctx, dati) {
    richiedi(ctx, 'struttura');
    var v = validaMagazzino(dati, null);
    controllaNomeMagazzino(v.nome, null);
    if (v.ordine === null || v.ordine === undefined) {
      var max = S.reparti.filter(function (r) { return r.id !== ID_TRANSITO; }).reduce(function (m, r) { return m === null || r.ordine > m ? r.ordine : m; }, null);
      v.ordine = Math.min(9998, (max === null ? -1 : max) + 1);
    }
    var prima = centraleS();
    var id = nuovoId('r');
    var w = scrivi(function (r) {
      if (v.tipo === 'centrale') declassaCentrale(r, id);
      ins('reparti', { id: id, nome: v.nome, centrale: v.tipo === 'centrale', attivo: v.attivo, ordine: v.ordine, tipo: v.tipo, piano: v.piano, livello: v.livello, colore: v.colore, descrizione: v.descrizione }, r);
    });
    var det = { magazzino: v.nome, tipo: v.tipo, piano: v.piano, livello: v.livello, attivo: v.attivo };
    if (v.tipo === 'centrale' && prima) det.exCentrale = prima.nome;
    evento(ctx, 'magazzini.crea', det);
    return { rev: w.rev, magazzino: copia(reparto(id)) };
  }

  function controllaDisattivazione(rep) {
    var ddt = S.ddt.filter(function (d) { return (d.origineId === rep.id || d.destinazioneId === rep.id) && (d.stato === 'in_preparazione' || d.stato === 'in_transito'); }).length;
    var ric = S.richieste.filter(function (x) { return (x.repartoId === rep.id || x.fornitoreId === rep.id) && (x.stato === 'inviata' || x.stato === 'in_lavorazione'); }).length;
    if (!ddt && !ric) return;
    var cosa = [];
    if (ddt) cosa.push(ddt === 1 ? '1 DDT da spedire o in viaggio' : ddt + ' DDT da spedire o in viaggio');
    if (ric) cosa.push(ric === 1 ? '1 richiesta aperta' : ric + ' richieste aperte');
    throw errore(409, '«' + rep.nome + '» ha ancora ' + cosa.join(' e ') + ': prima ricevi o annulla i DDT e chiudi le richieste, poi disattiva il magazzino.');
  }

  function modificaMagazzino(ctx, id, dati) {
    richiedi(ctx, 'struttura');
    var prima = copia(magazzinoS(id));
    var v = validaMagazzino(dati, prima);
    controllaNomeMagazzino(v.nome, prima.id);
    var eraCentrale = prima.tipo === 'centrale' || prima.centrale;
    if (eraCentrale && v.tipo !== 'centrale') throw errore(400, 'Ci vuole sempre una farmacia centrale: per cambiarla, apri il magazzino che deve diventarlo e scegli «Farmacia centrale».');
    if (prima.attivo && !v.attivo) controllaDisattivazione(prima);
    var exCentrale = v.tipo === 'centrale' && !eraCentrale ? centraleS() : null;
    var w = scrivi(function (r) {
      if (v.tipo === 'centrale' && !eraCentrale) declassaCentrale(r, prima.id);
      agg('reparti', reparto(prima.id), { nome: v.nome, centrale: v.tipo === 'centrale', attivo: v.attivo, ordine: v.ordine, tipo: v.tipo, piano: v.piano, livello: v.livello, colore: v.colore, descrizione: v.descrizione }, r);
    });
    var cambi = {};
    ['nome', 'tipo', 'piano', 'livello', 'colore', 'descrizione', 'attivo', 'ordine'].forEach(function (k) { if (prima[k] !== v[k]) cambi[k] = { prima: prima[k], dopo: v[k] }; });
    var det = { magazzino: v.nome, cambi: cambi };
    if (exCentrale) det.exCentrale = exCentrale.nome;
    evento(ctx, 'magazzini.modifica', det);
    return { rev: w.rev, magazzino: copia(reparto(prima.id)) };
  }

  function eliminaMagazzino(ctx, id) {
    richiedi(ctx, 'struttura');
    var rep = magazzinoS(id);
    if (rep.tipo === 'centrale' || rep.centrale) throw errore(400, 'La farmacia centrale non si elimina: prima scegli un altro magazzino come farmacia centrale.');
    var usato = S.movimenti.some(function (m) { return m.repartoId === rep.id || m.repartoDestId === rep.id; }) ||
      S.richieste.some(function (x) { return x.repartoId === rep.id || x.fornitoreId === rep.id; }) ||
      S.ddt.some(function (x) { return x.origineId === rep.id || x.destinazioneId === rep.id; });
    if (usato) throw errore(409, 'Il magazzino «' + rep.nome + '» è già stato usato (movimenti, richieste o DDT): non si può eliminare. Togli la spunta «Attivo» per nasconderlo.');
    var armadi = S.armadi.filter(function (a) { return a.repartoId === rep.id; });
    var righe = S.assortimento.filter(function (a) { return a.repartoId === rep.id; });
    var w = scrivi(function (r) {
      var ids = armadi.map(function (a) { return a.id; });
      S.assortimento.filter(function (x) { return ids.indexOf(x.armadioId) >= 0 && x.repartoId !== rep.id; })
        .forEach(function (x) { agg('assortimento', x, { armadioId: null, ripiano: null, posizione: null }, r); });
      righe.forEach(function (x) { canc('assortimento', x, r); });
      armadi.forEach(function (x) { canc('armadi', x, r); });
      canc('reparti', rep, r);
    });
    var toccati = togliRepartoDagliUtenti([rep.id]);
    evento(ctx, 'magazzini.elimina', { magazzino: rep.nome, armadi: armadi.length, assortimento: righe.length, utentiAggiornati: toccati.length });
    return { rev: w.rev };
  }

  function validaArmadio(dati, prima) {
    dati = dati && typeof dati === 'object' ? dati : {};
    var base = prima || { repartoId: '', nome: '', tipo: 'armadio', ripiani: 4, colonne: 6, ordine: null, colore: '', note: '', attivo: true };
    function dato(k) { return dati[k] === undefined ? base[k] : dati[k]; }
    var v = {};
    if (!dato('repartoId')) throw errore(400, 'Scegli il magazzino dell’armadio.');
    v.repartoId = magazzinoS(dato('repartoId'), true).id;
    v.nome = testo(dato('nome'), 60, 'nome');
    if (!v.nome) throw errore(400, 'Scrivi il nome dell’armadio.');
    v.tipo = String(dato('tipo') || 'armadio');
    if (TIPI_ARMADIO.indexOf(v.tipo) < 0) throw errore(400, 'Tipo di armadio non valido: armadio, frigorifero, cassettiera, carrello o cassaforte.');
    v.ripiani = intero(dato('ripiani'), 'ripiani', 1, 12, 4);
    v.colonne = intero(dato('colonne'), 'posti per ripiano', 1, 20, 6);
    v.ordine = dati.ordine === undefined || dati.ordine === null || dati.ordine === '' ? base.ordine : intero(dati.ordine, 'ordine', 0, 9999);
    v.colore = coloreS(dato('colore'));
    v.note = testo(dato('note'), 300, 'note');
    v.attivo = siNo(dato('attivo'), true);
    return v;
  }
  function controllaNomeArmadio(repartoId, nome, tranneId) {
    var n = nome.toLowerCase();
    if (S.armadi.some(function (a) { return a.repartoId === repartoId && a.nome.toLowerCase() === n && a.id !== String(tranneId || ''); })) {
      throw errore(409, 'In questo magazzino c’è già un armadio che si chiama «' + nome + '».');
    }
  }

  function creaArmadio(ctx, dati) {
    richiedi(ctx, 'struttura');
    var v = validaArmadio(dati, null);
    controllaNomeArmadio(v.repartoId, v.nome, null);
    if (v.ordine === null || v.ordine === undefined) {
      var max = S.armadi.filter(function (a) { return a.repartoId === v.repartoId; }).reduce(function (m, a) { return m === null || a.ordine > m ? a.ordine : m; }, null);
      v.ordine = Math.min(9999, (max === null ? -1 : max) + 1);
    }
    var id = nuovoId('arm');
    var w = scrivi(function (r) {
      ins('armadi', { id: id, repartoId: v.repartoId, nome: v.nome, tipo: v.tipo, ripiani: v.ripiani, colonne: v.colonne, ordine: v.ordine, colore: v.colore, note: v.note, attivo: v.attivo }, r);
    });
    evento(ctx, 'armadi.crea', { armadio: v.nome, magazzino: reparto(v.repartoId).nome, tipo: v.tipo, ripiani: v.ripiani, colonne: v.colonne });
    return { rev: w.rev, armadio: copia(armadio(id)) };
  }

  function modificaArmadio(ctx, id, dati) {
    richiedi(ctx, 'struttura');
    var a = armadio(id);
    if (!a) throw errore(404, 'Armadio non trovato.');
    var prima = copia(a);
    var v = validaArmadio(dati, prima);
    controllaNomeArmadio(v.repartoId, v.nome, prima.id);
    var occupate = S.assortimento.filter(function (x) { return x.armadioId === prima.id; }).length;
    if (v.repartoId !== prima.repartoId && occupate) throw errore(409, 'Nell’armadio «' + prima.nome + '» ci sono ' + occupate + ' articoli: svuotalo prima di spostarlo in un altro magazzino.');
    var fuori = S.assortimento.filter(function (x) {
      return x.armadioId === prima.id && (x.ripiano > v.ripiani || x.posizione > v.colonne || x.ripiano === null || x.posizione === null || x.ripiano === undefined || x.posizione === undefined);
    });
    var w = scrivi(function (r) {
      agg('armadi', a, { repartoId: v.repartoId, nome: v.nome, tipo: v.tipo, ripiani: v.ripiani, colonne: v.colonne, ordine: v.ordine, colore: v.colore, note: v.note, attivo: v.attivo }, r);
      fuori.forEach(function (x) { agg('assortimento', x, { armadioId: null, ripiano: null, posizione: null }, r); });
    });
    var cambi = {};
    ['nome', 'tipo', 'ripiani', 'colonne', 'ordine', 'colore', 'note', 'attivo'].forEach(function (k) { if (prima[k] !== v[k]) cambi[k] = { prima: prima[k], dopo: v[k] }; });
    if (v.repartoId !== prima.repartoId) cambi.magazzino = { prima: reparto(prima.repartoId).nome, dopo: reparto(v.repartoId).nome };
    evento(ctx, 'armadi.modifica', { armadio: v.nome, cambi: cambi, liberati: fuori.length });
    return { rev: w.rev, armadio: copia(a), liberati: fuori.length };
  }

  function eliminaArmadio(ctx, id) {
    richiedi(ctx, 'struttura');
    var a = armadio(id);
    if (!a) throw errore(404, 'Armadio non trovato.');
    var dentro = S.assortimento.filter(function (x) { return x.armadioId === a.id; });
    var w = scrivi(function (r) {
      dentro.forEach(function (x) { agg('assortimento', x, { armadioId: null, ripiano: null, posizione: null }, r); });
      canc('armadi', a, r);
    });
    var rep = reparto(a.repartoId);
    evento(ctx, 'armadi.elimina', { armadio: a.nome, magazzino: rep ? rep.nome : a.repartoId, liberati: dentro.length });
    return { rev: w.rev, liberati: dentro.length };
  }

  function magazzinoScrivibile(ctx, repartoId, cosa) {
    if (!repartoId) throw errore(400, 'Scegli il magazzino.');
    var rep = magazzinoS(repartoId, true);
    if (!puoScrivereReparto(ctx.permessi, rep.id)) throw errore(403, 'Puoi cambiare ' + cosa + ' solo dei magazzini a cui sei assegnato.');
    return rep;
  }
  function righeStruttura(dati) {
    var righe = dati && Array.isArray(dati.righe) ? dati.righe : null;
    if (!righe || !righe.length) throw errore(400, 'Nessuna riga da salvare.');
    if (righe.length > MAX_RIGHE_STRUTTURA) throw errore(400, 'Troppe righe in una volta (massimo ' + MAX_RIGHE_STRUTTURA + ').');
    var viste = {};
    righe.forEach(function (x) {
      if (!x || typeof x !== 'object' || !x.articoloId) throw errore(400, 'Ogni riga deve indicare l’articolo.');
      var k = String(x.articoloId);
      if (viste[k]) throw errore(400, 'Lo stesso articolo compare due volte nella richiesta.');
      viste[k] = true;
    });
    return righe;
  }
  function nomiArticoli() { var n = {}; S.articoli.forEach(function (a) { n[a.id] = a.nome; }); return n; }
  function articoliNonAttivi() { var s = {}; S.articoli.forEach(function (a) { if (!a.attivo) s[a.id] = true; }); return s; }
  function righeAssortimento(repartoId) { var m = {}; S.assortimento.forEach(function (x) { if (x.repartoId === repartoId) m[x.articoloId] = x; }); return m; }

  function salvaAssortimento(ctx, dati) {
    richiedi(ctx, 'assortimento');
    var rep = magazzinoScrivibile(ctx, dati && dati.repartoId, 'l’assortimento');
    var righe = righeStruttura(dati);
    var nomi = nomiArticoli();
    var spenti = articoliNonAttivi();
    var esistenti = righeAssortimento(rep.id);
    var nuove = [];
    var modifiche = [];
    righe.forEach(function (x) {
      var artId = String(x.articoloId);
      if (!nomi[artId]) throw errore(400, 'Articolo non trovato: aggiorna la pagina.');
      var e = esistenti[artId];
      var nome = nomi[artId];
      var v = {
        articoloId: artId,
        scortaMin: x.scortaMin === undefined ? (e ? e.scortaMin : 0) : numeroS(x.scortaMin, 'scorta minima di ' + nome),
        puntoRiordino: x.puntoRiordino === undefined ? (e ? e.puntoRiordino : 0) : numeroS(x.puntoRiordino, 'punto di riordino di ' + nome),
        scortaMax: x.scortaMax === undefined ? (e ? e.scortaMax : 0) : numeroS(x.scortaMax, 'scorta massima di ' + nome),
        note: x.note === undefined ? (e ? e.note : '') : testo(x.note, 300, 'note di ' + nome),
        attivo: siNo(x.attivo, e ? !!e.attivo : true)
      };
      controllaSoglie(nome, v.scortaMin, v.puntoRiordino, v.scortaMax);
      if (spenti[artId] && v.attivo && (!e || !e.attivo)) throw errore(400, nome + ' non è attivo: riattivalo dalla pagina Articoli prima di metterlo nell’assortimento.');
      if (!e) { if (v.attivo) nuove.push(v); return; }
      if (e.scortaMin !== v.scortaMin || e.puntoRiordino !== v.puntoRiordino || e.scortaMax !== v.scortaMax || e.note !== v.note || !!e.attivo !== v.attivo) {
        v.riga = e;
        v.tolta = !!e.attivo && !v.attivo;
        modifiche.push(v);
      }
    });
    if (!nuove.length && !modifiche.length) return { rev: rev, nuove: 0, modificate: 0, tolte: 0 };
    var w = scrivi(function (r) {
      nuove.forEach(function (v) {
        ins('assortimento', { id: nuovoId('as'), repartoId: rep.id, articoloId: v.articoloId, scortaMin: v.scortaMin, puntoRiordino: v.puntoRiordino, scortaMax: v.scortaMax,
          armadioId: null, ripiano: null, posizione: null, note: v.note, attivo: true }, r);
      });
      modifiche.forEach(function (v) {
        var campi = { scortaMin: v.scortaMin, puntoRiordino: v.puntoRiordino, scortaMax: v.scortaMax, note: v.note, attivo: v.attivo };
        if (!v.attivo) { campi.armadioId = null; campi.ripiano = null; campi.posizione = null; }
        agg('assortimento', v.riga, campi, r);
      });
    });
    var tolte = modifiche.filter(function (v) { return v.tolta; });
    var descrivi = function (v) { return { articolo: nomi[v.articoloId], min: v.scortaMin, riordino: v.puntoRiordino, max: v.scortaMax, attivo: v.attivo }; };
    evento(ctx, 'assortimento.modifica', {
      magazzino: rep.nome, nuove: nuove.length, modificate: modifiche.length - tolte.length, tolte: tolte.length,
      righe: nuove.concat(modifiche).slice(0, MAX_DETTAGLI_EVENTO).map(descrivi)
    });
    return { rev: w.rev, nuove: nuove.length, modificate: modifiche.length - tolte.length, tolte: tolte.length };
  }

  function salvaUbicazioni(ctx, dati) {
    richiedi(ctx, 'ubicazioni');
    var rep = magazzinoScrivibile(ctx, dati && dati.repartoId, 'la posizione degli articoli negli armadi');
    var righe = righeStruttura(dati);
    var nomi = nomiArticoli();
    var spenti = articoliNonAttivi();
    var esistenti = righeAssortimento(rep.id);
    var armadi = {};
    S.armadi.forEach(function (a) { if (a.repartoId === rep.id) armadi[a.id] = a; });
    var finale = {};
    Object.keys(esistenti).forEach(function (artId) {
      var e = esistenti[artId];
      if (e.armadioId && e.attivo) finale[artId] = { armadioId: e.armadioId, ripiano: e.ripiano, posizione: e.posizione };
    });
    var cambi = righe.map(function (x) {
      var artId = String(x.articoloId);
      if (!nomi[artId]) throw errore(400, 'Articolo non trovato: aggiorna la pagina.');
      var dove = null;
      if (x.armadioId) {
        var arm = armadi[String(x.armadioId)];
        if (!arm) throw errore(400, 'Armadio non trovato in ' + rep.nome + ': aggiorna la pagina.');
        if (!arm.attivo) throw errore(400, 'L’armadio «' + arm.nome + '» non è attivo.');
        var e = esistenti[artId];
        if (spenti[artId] && (!e || !e.attivo)) throw errore(400, nomi[artId] + ' non è attivo: riattivalo dalla pagina Articoli prima di metterlo in un armadio.');
        dove = { armadioId: arm.id, ripiano: intero(x.ripiano, 'ripiano', 1, arm.ripiani), posizione: intero(x.posizione, 'posto sul ripiano', 1, arm.colonne) };
      }
      if (dove) finale[artId] = dove; else delete finale[artId];
      return { articoloId: artId, dove: dove };
    });
    var spostati = cambi.map(function (c) { return c.articoloId; });
    var ordine = Object.keys(finale).filter(function (k) { return spostati.indexOf(k) < 0; }).concat(spostati.filter(function (k) { return finale[k]; }));
    var caselle = {};
    ordine.forEach(function (artId) {
      var f = finale[artId];
      var k = f.armadioId + '|' + f.ripiano + '|' + f.posizione;
      if (caselle[k]) {
        throw errore(409, 'Il posto ' + f.posizione + ' del ripiano ' + f.ripiano + ' di «' + armadi[f.armadioId].nome + '» è già occupato da ' +
          nomi[caselle[k]] + ': ' + nomi[artId] + ' non ci può andare.');
      }
      caselle[k] = artId;
    });
    var daScrivere = cambi.filter(function (c) {
      var e = esistenti[c.articoloId];
      if (!e) return !!c.dove;
      if (!c.dove) return !!e.armadioId;
      return !e.attivo || e.armadioId !== c.dove.armadioId || e.ripiano !== c.dove.ripiano || e.posizione !== c.dove.posizione;
    });
    if (!daScrivere.length) return { rev: rev, spostate: 0, aggiunte: 0 };
    var aggiunte = 0;
    var w = scrivi(function (r) {
      daScrivere.forEach(function (c) {
        var e = esistenti[c.articoloId];
        var d = c.dove || { armadioId: null, ripiano: null, posizione: null };
        if (e) {
          var campi = { armadioId: d.armadioId, ripiano: d.ripiano, posizione: d.posizione };
          if (c.dove) campi.attivo = true;
          agg('assortimento', e, campi, r);
        } else {
          ins('assortimento', { id: nuovoId('as'), repartoId: rep.id, articoloId: c.articoloId, scortaMin: 0, puntoRiordino: 0, scortaMax: 0, armadioId: d.armadioId,
            ripiano: d.ripiano, posizione: d.posizione, note: '', attivo: true }, r);
          aggiunte++;
        }
      });
    });
    evento(ctx, 'ubicazioni.modifica', {
      magazzino: rep.nome, righe: daScrivere.length, aggiunte: aggiunte,
      posti: daScrivere.slice(0, MAX_DETTAGLI_EVENTO).map(function (c) {
        return c.dove ? { articolo: nomi[c.articoloId], armadio: armadi[c.dove.armadioId].nome, ripiano: c.dove.ripiano, posto: c.dove.posizione }
          : { articolo: nomi[c.articoloId], armadio: '(tolto dall’armadio)' };
      })
    });
    return { rev: w.rev, spostate: daScrivere.length - aggiunte, aggiunte: aggiunte };
  }

  /* ======================= accesso, password, utenti (server/accessi.js) ======================= */

  var TENTATIVI_MAX = 5;
  var BLOCCO_MS = 15 * 60 * 1000;
  var SFIDA_MS = 5 * 60 * 1000;
  var DISPOSITIVO_MS = 30 * 24 * 60 * 60 * 1000;
  var ATTIVAZIONE_MS = 60 * 60 * 1000;
  var CODICI_RECUPERO = 10;
  var ALFABETO_RECUPERO = '23456789abcdefghjkmnpqrstuvwxyz';
  var fallitiPerCoppia = {};   // username -> [istanti] (nell'anteprima c'è un solo "computer")
  var erroriSessione = 0;      // password attuali sbagliate nella sessione aperta
  var sfide = {};              // sfida -> { utenteId, scade }
  var attivazioni = {};        // id utente -> { segreto (base32), scade }
  var ultimoErrore2fa = {};
  var dispositivi = [];        // { token, utenteId, scade }: "Ricorda questo computer"
  var dispositiviBrowser = []; // i token che questo browser ha (il cookie gf_dispositivo del programma vero)

  function passwordGiusta(u, pw) { return pw === PASSWORD || (!!u.password && pw === u.password); }
  function controllaPassword(password) {
    if (typeof password !== 'string' || password.length < 8) throw errore(400, 'La password deve avere almeno 8 caratteri.');
    if (password.length > 200) throw errore(400, 'La password è troppo lunga.');
  }
  function recenti(lista, adesso) { return (lista || []).filter(function (t) { return adesso - t < BLOCCO_MS; }); }
  // i codici di recupero dell'utente "sicura" (uno è scritto nella banda): l'impronta si calcola quando js/totp.js è caricato
  var recuperoPronto = false;
  function preparaRecupero() {
    if (recuperoPronto || !T()) return;
    recuperoPronto = true;
    var u = UTENTI.filter(function (x) { return x.username === 'sicura'; })[0];
    if (u && u.totpSegreto === SEGRETO_DIMOSTRATIVO) u.codiciRecupero = RECUPERO_DIMOSTRATIVO.map(function (c) { return hashRecupero(u.id, c); });
  }
  function token() {
    var b = T().segretoCasuale(24);
    return T().base32Codifica(b).toLowerCase();
  }

  function apriSessione(u, dettagli) {
    sessione = u;
    erroriSessione = 0;
    u.ultimoAccesso = new Date().toISOString();
    var ctx = contesto();
    evento(ctx, 'accesso.entrata', dettagli || {});
    return { utente: vistaUtente(u), permessi: permessi(u) };
  }

  function login(dati) {
    var username = String(dati.username || '').trim().toLowerCase();
    var password = String(dati.password || '');
    var adesso = Date.now();
    var valido = /^[a-z0-9._-]{3,40}$/.test(username) && password.length <= 200;
    function fallito(motivo, conNome) {
      if (valido) (fallitiPerCoppia[username] = recenti(fallitiPerCoppia[username], adesso)).push(adesso);
      evento({ username: conNome ? username : '' }, 'accesso.fallito', conNome ? { utente: username, motivo: motivo } : { motivo: motivo });
      if (valido && fallitiPerCoppia[username].length >= TENTATIVI_MAX) {
        throw errore(429, 'Troppi tentativi sbagliati: per questo utente da questo computer riprova tra 15 minuti, oppure chiedi all’amministratore una nuova password.');
      }
      throw errore(401, 'Nome utente o password non giusti. Nell’anteprima la password è «' + PASSWORD + '».');
    }
    if (valido && recenti(fallitiPerCoppia[username], adesso).length >= TENTATIVI_MAX) {
      throw errore(429, 'Troppi tentativi sbagliati: per questo utente da questo computer riprova tra 15 minuti, oppure chiedi all’amministratore una nuova password.');
    }
    var u = valido ? UTENTI.filter(function (x) { return x.username === username; })[0] : null;
    if (!u) return fallito('utente inesistente', false);
    if (!passwordGiusta(u, password)) return fallito('password sbagliata', true);
    if (!u.attivo) {
      evento({ username: username }, 'accesso.fallito', { utente: username, motivo: 'utente disattivato' });
      throw errore(403, 'Questo utente è disattivato. Rivolgiti all’amministratore.');
    }
    delete fallitiPerCoppia[username];
    if (u.totpAttivo) {
      var attendibile = dispositivi.some(function (d) { return d.utenteId === u.id && d.scade > adesso && dispositiviBrowser.indexOf(d.token) >= 0; });
      if (attendibile) return apriSessione(u, { dueFattori: 'computer attendibile' });
      if ((u.bloccatoFino || 0) > adesso) throw errore(429, messaggioBlocco2fa(u.bloccatoFino, adesso));
      var s = token();
      sfide[s] = { utenteId: u.id, scade: adesso + SFIDA_MS };
      return { dueFattori: true, sfida: s };
    }
    return apriSessione(u, {});
  }

  function messaggioBlocco2fa(fino, adesso) {
    var minuti = Math.max(1, Math.ceil((fino - adesso) / 60000));
    return 'Troppi codici sbagliati: la verifica in due passaggi di questo utente è bloccata per ' + minuti +
      (minuti === 1 ? ' minuto' : ' minuti') + '. Riprova dopo, oppure chiedi aiuto all’amministratore.';
  }
  function hashRecupero(utenteId, codice) {
    var pulito = String(codice || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return T().esadecimale(T().sha1('recupero:' + utenteId + ':' + pulito));
  }
  function nuoviCodiciRecupero(utenteId) {
    var chiari = [];
    while (chiari.length < CODICI_RECUPERO) {
      var b = T().segretoCasuale(10);
      var s = '';
      for (var i = 0; i < 10; i++) s += ALFABETO_RECUPERO.charAt(b[i] % ALFABETO_RECUPERO.length);
      var c = s.slice(0, 5) + '-' + s.slice(5);
      if (chiari.indexOf(c) < 0) chiari.push(c);
    }
    return { chiari: chiari, hash: chiari.map(function (c) { return hashRecupero(utenteId, c); }) };
  }
  function controllaSecondoFattore(u, dati, adesso) {
    preparaRecupero();
    var codice = String(dati.codice === undefined || dati.codice === null ? '' : dati.codice).slice(0, 100);
    var recupero = dati.codiceRecupero !== undefined && dati.codiceRecupero !== null && dati.codiceRecupero !== ''
      ? String(dati.codiceRecupero).slice(0, 100) : (/[a-z]/i.test(codice) ? codice : null);
    if (recupero !== null) {
      var i = u.codiciRecupero.indexOf(hashRecupero(u.id, recupero));
      if (i < 0) return { ok: false, tipo: 'recupero', motivo: 'sbagliato' };
      var resto = u.codiciRecupero.slice();
      resto.splice(i, 1);
      return { ok: true, tipo: 'recupero', codici: resto };
    }
    var passo = T().verifica(u.totpSegreto, codice, adesso, { finestra: 1, ultimoPasso: u.totpUltimoPasso || 0 });
    if (passo >= 0) return { ok: true, tipo: 'codice', passo: passo };
    if (T().verifica(u.totpSegreto, codice, adesso, { finestra: 1 }) >= 0) return { ok: false, tipo: 'codice', motivo: 'gia-usato' };
    return { ok: false, tipo: 'codice', motivo: 'sbagliato' };
  }

  function loginDueFattori(dati) {
    dati = dati || {};
    var adesso = Date.now();
    Object.keys(sfide).forEach(function (k) { if (sfide[k].scade <= adesso) delete sfide[k]; });
    var chiave = String(dati.sfida || '').slice(0, 200);
    var sfida = sfide[chiave];
    var scaduta = errore(401, 'La verifica è scaduta: scrivi di nuovo nome utente e password.', { sfidaScaduta: true });
    if (!sfida) throw scaduta;
    var u = utente(sfida.utenteId);
    if (!u || !u.attivo || !u.totpAttivo) { delete sfide[chiave]; throw scaduta; }
    var conNome = { username: u.username };
    if ((u.bloccatoFino || 0) > adesso) { delete sfide[chiave]; throw errore(429, messaggioBlocco2fa(u.bloccatoFino, adesso)); }
    var esito = controllaSecondoFattore(u, dati.codiceRecupero ? { codiceRecupero: dati.codiceRecupero } : { codice: dati.codice }, adesso);
    if (!esito.ok) {
      if (esito.motivo === 'gia-usato') {
        evento(conNome, 'accesso.2fa.codice-riusato', { utente: u.username });
        throw errore(400, 'Questo codice è già stato usato. Aspetta che l’app mostri il codice nuovo (cambia ogni 30 secondi) e scrivi quello.', { codiceUsato: true });
      }
      var ultimo = ultimoErrore2fa[u.id];
      var n = (ultimo && adesso - ultimo < BLOCCO_MS ? u.tentativi2fa : 0) + 1;
      ultimoErrore2fa[u.id] = adesso;
      if (n >= TENTATIVI_MAX) {
        u.tentativi2fa = 0;
        u.bloccatoFino = adesso + BLOCCO_MS;
        delete ultimoErrore2fa[u.id];
        delete sfide[chiave];
        evento(conNome, 'accesso.2fa.bloccato', { utente: u.username, tentativi: n });
        throw errore(429, messaggioBlocco2fa(adesso + BLOCCO_MS, adesso));
      }
      u.tentativi2fa = n;
      evento(conNome, 'accesso.2fa.fallito', { utente: u.username, tipo: esito.tipo, tentativo: n });
      var rimasti = TENTATIVI_MAX - n;
      throw errore(400, esito.tipo === 'recupero'
        ? 'Questo codice di recupero non è giusto o è già stato usato. Tentativi rimasti: ' + rimasti + '.'
        : 'Il codice non è giusto. Controlla di leggere il codice di questo programma nell’app e che l’ora del telefono sia giusta. Tentativi rimasti: ' + rimasti + '.', { tentativiRimasti: rimasti });
    }
    delete sfide[chiave];
    delete ultimoErrore2fa[u.id];
    if (esito.tipo === 'codice') { u.totpUltimoPasso = esito.passo; u.tentativi2fa = 0; } else { u.codiciRecupero = esito.codici; u.tentativi2fa = 0; }
    var ricordato = false;
    if (dati.ricorda) {
      var t = token();
      dispositivi.push({ token: t, utenteId: u.id, scade: adesso + DISPOSITIVO_MS });
      dispositiviBrowser = [t].concat(dispositiviBrowser).slice(0, 5);
      ricordato = true;
    }
    if (esito.tipo === 'recupero') evento(conNome, 'accesso.2fa.recupero', { utente: u.username, codiciRimasti: esito.codici.length });
    if (ricordato) evento(conNome, 'accesso.2fa.ricorda-computer', { utente: u.username, giorni: DISPOSITIVO_MS / 86400000 });
    var out = apriSessione(u, { dueFattori: esito.tipo === 'codice' ? 'codice' : 'codice di recupero' });
    if (esito.tipo === 'recupero') out.codiciRimasti = esito.codici.length;
    return out;
  }

  function cambiaPassword(ctx, attuale, nuova) {
    var u = ctx.utente;
    if (!passwordGiusta(u, String(attuale || '').slice(0, 200))) {
      erroriSessione++;
      evento(ctx, 'accesso.cambio-password-fallito', { tentativo: erroriSessione });
      if (erroriSessione >= TENTATIVI_MAX) {
        erroriSessione = 0;
        sessione = null;
        throw errore(401, 'Troppe password attuali sbagliate: per sicurezza la sessione è stata chiusa. Accedi di nuovo.');
      }
      throw errore(400, 'La password attuale non è giusta. Nell’anteprima è «' + PASSWORD + '».');
    }
    erroriSessione = 0;
    if (String(nuova) === String(attuale)) throw errore(400, 'La nuova password deve essere diversa da quella attuale.');
    controllaPassword(nuova);
    u.password = String(nuova);
    u.cambioPassword = false;
    evento(ctx, 'accesso.cambio-password', {});
    return { ok: true, utente: vistaUtente(u), nota: 'Nell’anteprima vale la nuova password e anche «' + PASSWORD + '».' };
  }

  function validaUtente(dati, nuovo) {
    var out = {};
    if (nuovo) {
      var username = String(dati.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw errore(400, 'Il nome utente deve avere da 3 a 40 caratteri: lettere, numeri, punto, trattino.');
      out.username = username;
    }
    var nome = String(dati.nome || '').trim();
    if (!nome || nome.length > 100) throw errore(400, 'Scrivi nome e cognome.');
    out.nome = nome;
    if (!RUOLI[dati.ruolo]) throw errore(400, 'Ruolo non valido.');
    out.ruolo = dati.ruolo;
    var lista = Array.isArray(dati.reparti) ? dati.reparti.map(String) : [];
    var esistenti = repartiOrdinati().map(function (r) { return r.id; });
    lista = lista.filter(function (id, i) { return esistenti.indexOf(id) >= 0 && lista.indexOf(id) === i; });
    if (out.ruolo === 'reparto' && !lista.length) throw errore(400, 'Un utente di reparto deve avere almeno un reparto.');
    out.reparti = out.ruolo === 'reparto' ? lista : [];
    return out;
  }
  function creaUtente(ctx, dati) {
    var v = validaUtente(dati, true);
    controllaPassword(dati.password);
    if (UTENTI.some(function (u) { return u.username === v.username; })) throw errore(409, 'Esiste già un utente con questo nome.');
    var u = utenteDiProva(nuovoId('u'), v.username, v.nome, v.ruolo, v.reparti);
    u.password = String(dati.password);
    u.cambioPassword = true;
    UTENTI.push(u);
    evento(ctx, 'utenti.crea', { utente: v.username, nome: v.nome, ruolo: v.ruolo, reparti: v.reparti });
    return { utente: vistaUtente(u) };
  }
  function modificaUtente(ctx, id, dati) {
    var u = utente(String(id));
    if (!u) throw errore(404, 'Utente non trovato.');
    var prima = vistaUtente(u);
    var v = validaUtente(dati, false);
    var attivo = dati.attivo === undefined ? prima.attivo : !!dati.attivo;
    var restaAdmin = v.ruolo === 'amministratore' && attivo;
    var altriAdmin = UTENTI.filter(function (x) { return x.ruolo === 'amministratore' && x.attivo && x.id !== u.id; }).length;
    if (prima.ruolo === 'amministratore' && prima.attivo && !restaAdmin && altriAdmin === 0) throw errore(400, 'Deve restare almeno un amministratore attivo.');
    u.nome = v.nome;
    u.ruolo = v.ruolo;
    u.reparti = v.reparti;
    u.attivo = attivo;
    evento(ctx, 'utenti.modifica', { utente: prima.username, prima: { nome: prima.nome, ruolo: prima.ruolo, reparti: prima.reparti, attivo: prima.attivo }, dopo: { nome: v.nome, ruolo: v.ruolo, reparti: v.reparti, attivo: attivo } });
    if (!attivo && sessione === u) setTimeout(chiudiNotifiche, 0);
    return { utente: vistaUtente(u) };
  }
  function reimpostaPassword(ctx, id, nuova) {
    var u = utente(String(id));
    if (!u) throw errore(404, 'Utente non trovato.');
    controllaPassword(nuova);
    u.password = String(nuova);
    u.cambioPassword = true;
    u.tentativi2fa = 0;
    u.bloccatoFino = 0;
    delete ultimoErrore2fa[u.id];
    delete fallitiPerCoppia[u.username];
    evento(ctx, 'utenti.nuova-password', { utente: u.username });
    return { ok: true, nota: 'Nell’anteprima entra con la password nuova oppure con «' + PASSWORD + '».' };
  }
  function eventiFiltrati(q) {
    function giorno(t, dopo) {
      if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return t || '';
      var d = new Date(t + 'T00:00:00');
      if (dopo) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
    var dal = giorno(q.get('dal'), false);
    var al = giorno(q.get('al'), true);
    var chi2 = String(q.get('utente') || '').toLowerCase();
    var azione = String(q.get('azione') || '');
    var limite = Math.min(Math.max(Math.floor(Number(q.get('limite'))) || 500, 1), 5000);
    return eventi.filter(function (e) {
      return (!dal || e.quando >= dal) && (!al || e.quando < al) && (!chi2 || String(e.username).toLowerCase() === chi2) && (!azione || e.azione.indexOf(azione) === 0);
    }).slice(0, limite).map(copia);
  }

  /* ---------- verifica in due passaggi (server/sicurezza.js) ---------- */

  var NOMI_CRITERI = { nessuno: 'nessuno (facoltativa per tutti)', amministratori: 'amministratori', farmacisti: 'amministratori e farmacisti', tutti: 'tutti gli utenti' };
  function emittente() {
    var imp = S.impostazioni;
    return String(imp.nomeProdotto || imp.sigla || 'Gestionale Farmacia').trim().slice(0, 60) || 'Gestionale Farmacia';
  }
  function contaDispositivi(utenteId) { var adesso = Date.now(); return dispositivi.filter(function (d) { return d.utenteId === utenteId && d.scade > adesso; }).length; }
  function stato2fa(u) {
    preparaRecupero();
    var v = vistaUtente(u);
    return {
      attiva: v.dueFattori, attivataIl: u.totpAttivatoIl || null, obbligatoria: v.dueFattoriObbligatoria, daAttivare: v.dueFattoriDaAttivare,
      criterio: criterio2fa(), codiciRimasti: v.dueFattori ? u.codiciRecupero.length : 0, dispositivi: contaDispositivi(u.id),
      giorniDispositivo: DISPOSITIVO_MS / 86400000, oraServer: new Date().toISOString()
    };
  }
  function inizia2fa(ctx) {
    var u = ctx.utente;
    var base32 = T().base32Codifica(T().segretoCasuale(20));
    attivazioni[u.id] = { segreto: base32, scade: Date.now() + ATTIVAZIONE_MS };
    var em = emittente();
    return { segretoBase32: base32, chiave: T().formattaChiave(base32), uri: T().uriOtpauth({ emittente: em, utente: u.username, segretoBase32: base32 }),
      emittente: em, utente: u.username, cambio: !!u.totpAttivo, oraServer: new Date().toISOString() };
  }
  function conferma2fa(ctx, codice) {
    var u = ctx.utente;
    var adesso = Date.now();
    var att = attivazioni[u.id];
    if (att && att.scade <= adesso) { delete attivazioni[u.id]; att = null; }
    if (!att) throw errore(409, 'La chiave mostrata non vale più (è passata più di un’ora o il server è stato riavviato). Ricomincia: il programma ne mostrerà una nuova.', { ricomincia: true });
    var passo = T().verifica(att.segreto, codice, adesso, { finestra: 1 });
    if (passo < 0) {
      throw errore(400, /^\s*\d{3}\s*-?\s*\d{3}\s*$/.test(String(codice || ''))
        ? 'Il codice non è giusto. Controlla di aver inquadrato il codice QR qui sopra (o scritto bene la chiave) e che l’ora del telefono sia impostata in automatico.'
        : 'Scrivi le 6 cifre che mostra l’app.');
    }
    var codici = nuoviCodiciRecupero(u.id);
    var giaAttiva = !!u.totpAttivo;
    u.totpSegreto = att.segreto;
    u.totpAttivo = true;
    u.totpAttivatoIl = new Date(adesso).toISOString();
    u.totpUltimoPasso = passo;
    u.codiciRecupero = codici.hash;
    u.tentativi2fa = 0;
    delete attivazioni[u.id];
    evento(ctx, giaAttiva ? 'accesso.2fa.riconfigurata' : 'accesso.2fa.attivata', { codiciRecupero: CODICI_RECUPERO });
    return { codiciRecupero: codici.chiari, utente: vistaUtente(u) };
  }
  function erroreSessione(ctx, azione, messaggio) {
    erroriSessione++;
    evento(ctx, azione + '-fallito', { tentativo: erroriSessione });
    if (erroriSessione >= TENTATIVI_MAX) {
      erroriSessione = 0;
      sessione = null;
      throw errore(401, 'Troppi errori: per sicurezza la sessione è stata chiusa. Accedi di nuovo.');
    }
    throw errore(400, messaggio);
  }
  function azzera(u) {
    u.totpSegreto = null;
    u.totpAttivo = false;
    u.totpAttivatoIl = null;
    u.totpUltimoPasso = 0;
    u.codiciRecupero = [];
    u.tentativi2fa = 0;
    u.bloccatoFino = 0;
    var prima = dispositivi.length;
    dispositivi = dispositivi.filter(function (d) { return d.utenteId !== u.id; });
    delete attivazioni[u.id];
    delete ultimoErrore2fa[u.id];
    Object.keys(sfide).forEach(function (k) { if (sfide[k].utenteId === u.id) delete sfide[k]; });
    return prima - dispositivi.length;
  }
  function disattiva2fa(ctx, password, codice) {
    var u = ctx.utente;
    if (!u.totpAttivo) throw errore(409, 'La verifica in due passaggi non è attiva.');
    if (obbligo2fa(u.ruolo, criterio2fa())) throw errore(409, 'L’amministratore richiede la verifica in due passaggi per il tuo ruolo: non si può disattivare. Se hai cambiato telefono usa «Cambia telefono».');
    if (!passwordGiusta(u, String(password || '').slice(0, 200))) erroreSessione(ctx, 'accesso.2fa.disattiva', 'La password non è giusta.');
    var esito = controllaSecondoFattore(u, { codice: codice }, Date.now());
    if (!esito.ok) erroreSessione(ctx, 'accesso.2fa.disattiva', esito.motivo === 'gia-usato' ? 'Questo codice è già stato usato: aspetta il codice nuovo nell’app.' : 'Il codice non è giusto.');
    erroriSessione = 0;
    azzera(u);
    evento(ctx, 'accesso.2fa.disattivata', {});
    return { utente: vistaUtente(u) };
  }
  function nuoviCodici2fa(ctx, password) {
    var u = ctx.utente;
    if (!u.totpAttivo) throw errore(409, 'Prima attiva la verifica in due passaggi.');
    if (!passwordGiusta(u, String(password || '').slice(0, 200))) erroreSessione(ctx, 'accesso.2fa.nuovi-codici', 'La password non è giusta.');
    erroriSessione = 0;
    var codici = nuoviCodiciRecupero(u.id);
    u.codiciRecupero = codici.hash;
    evento(ctx, 'accesso.2fa.nuovi-codici', { codiciRecupero: CODICI_RECUPERO });
    return { codiciRecupero: codici.chiari };
  }
  function dimenticaDispositivi(ctx) {
    var u = ctx.utente;
    var adesso = Date.now();
    var n = dispositivi.filter(function (d) { return d.utenteId === u.id && d.scade > adesso; }).length;
    var tolti = dispositivi.filter(function (d) { return d.utenteId === u.id; }).map(function (d) { return d.token; });
    dispositivi = dispositivi.filter(function (d) { return d.utenteId !== u.id; });
    dispositiviBrowser = dispositiviBrowser.filter(function (t) { return tolti.indexOf(t) < 0; });
    // come il server vero: il cookie di questo browser si toglie del tutto
    dispositiviBrowser = [];
    evento(ctx, 'accesso.2fa.dimentica-computer', { computer: n });
    return { ok: true, tolti: n };
  }
  function statoSicurezza() {
    preparaRecupero();
    var criterio = criterio2fa();
    return {
      richiedi2fa: criterio, criteri: CRITERI_2FA.slice(),
      utenti: utentiPerNome().map(function (u) {
        var v = vistaUtente(u);
        return { id: v.id, username: v.username, nome: v.nome, ruolo: v.ruolo, attivo: v.attivo, dueFattori: v.dueFattori, attivataIl: u.totpAttivatoIl || null,
          obbligatoria: v.dueFattoriObbligatoria, daAttivare: v.dueFattoriDaAttivare, codiciRimasti: v.dueFattori ? u.codiciRecupero.length : 0,
          dispositivi: contaDispositivi(u.id), ultimoAccesso: v.ultimoAccesso, bloccato: v.bloccato };
      }),
      oraServer: new Date().toISOString()
    };
  }
  function utentiDaAttivare(criterio) {
    return UTENTI.filter(function (u) { return u.attivo && !u.totpAttivo && obbligo2fa(u.ruolo, criterio); }).map(function (u) { return u.id; });
  }
  function salvaCriterio(ctx, nuovo) {
    if (CRITERI_2FA.indexOf(nuovo) < 0) throw errore(400, 'Criterio non valido: scegli fra ' + CRITERI_2FA.join(', ') + '.');
    var prima = criterio2fa();
    if (obbligo2fa(ctx.utente.ruolo, nuovo) && !ctx.utente.totpAttivo) {
      throw errore(409, 'Prima attiva la verifica in due passaggi per il tuo utente (pulsante «La mia sicurezza»): il criterio scelto la richiede anche a te.', { attivaPrima: true });
    }
    var r = null;
    if (nuovo !== prima) r = scrivi(function (x) { cambiaImpostazioni({ richiedi2fa: nuovo }, x); }).rev;
    var daAttivare = utentiDaAttivare(nuovo);
    evento(ctx, 'accesso.2fa.criterio', { prima: NOMI_CRITERI[prima], dopo: NOMI_CRITERI[nuovo], daAttivare: daAttivare.length });
    var out = statoSicurezza();
    out.rev = r;
    out.daAttivare = daAttivare.length;
    return out;
  }
  function azzera2fa(ctx, id) {
    var u = utente(String(id));
    if (!u) throw errore(404, 'Utente non trovato.');
    var aveva = !!u.totpAttivo;
    var computer = azzera(u);
    evento(ctx, 'accesso.2fa.azzerata', { utente: u.username, eraAttiva: aveva, computer: computer });
    return { utente: vistaUtente(u) };
  }

  /* ======================= copie di sicurezza e stato della base dati ======================= */

  // le copie dell'anteprima restano in questa pagina: lo stato del magazzino in un testo JSON
  function istantanea() {
    var dati = {};
    TABELLE.forEach(function (t) { dati[t] = S[t]; });
    dati.impostazioni = S.impostazioni;
    dati.meta = meta;
    return JSON.stringify(dati);
  }
  function marcaTempo(d) {
    return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate()) + '_' + due(d.getHours()) + due(d.getMinutes()) + due(d.getSeconds());
  }
  var copie = []; // { nome, prefisso, tipo, data, dimensione, verificata, verificataIl, errore, rev, base, firma, conteggi, seconda, dati }
  // righe per tabella di SQLite, come la scheda di verifica di una copia del programma vero (server/backup.js)
  var TABELLE_SQL = { armadi: 'armadi', articoli: 'articoli', assortimento: 'assortimento', ddt: 'ddt', ddtRighe: 'ddt_righe', movimenti: 'movimenti',
    reparti: 'reparti', richieste: 'richieste', richiesteRighe: 'richieste_righe' };
  function conteggiDi(dati) {
    var d = dati ? JSON.parse(dati) : S;
    var c = {};
    TABELLE.forEach(function (t) { c[TABELLE_SQL[t]] = (d[t] || []).length; });
    c.cancellati = dati ? 0 : cancellati.length;
    c.impostazioni = Object.keys(d.impostazioni || {}).length;
    c.meta = Object.keys(dati ? d.meta || {} : meta).length + 3;
    var o = {};
    Object.keys(c).sort().forEach(function (k) { o[k] = c[k]; });
    return o;
  }
  function conteggiAccessi() {
    return { dispositivi: dispositivi.length, eventi: eventi.length, sessioni: sessione ? 1 : 0, utenti: UTENTI.length };
  }
  function dimensioneStimata() { return Math.round(S.movimenti.length * 230 + S.articoli.length * 400 + S.ddtRighe.length * 120 + S.richiesteRighe.length * 90 + 180000); }
  function dimensioneAccessi() { return 98304 + eventi.length * 160 + UTENTI.length * 600; }
  function nuovaCopia(prefisso, tipo, d, dati, opz) {
    opz = opz || {};
    d = new Date(Math.floor(d.getTime() / 1000) * 1000); // la data viene dal nome del file: al secondo
    var c = {
      nome: prefisso + '_' + marcaTempo(d) + '_' + tipo + '.db', prefisso: prefisso, tipo: tipo, data: d.toISOString(),
      dimensione: opz.dimensione || (prefisso === 'farmacia' ? dimensioneStimata() : dimensioneAccessi()), verificata: true,
      verificataIl: new Date(d.getTime() + 900).toISOString(), errore: null, rev: prefisso === 'farmacia' ? (opz.rev || rev) : null, base: prefisso === 'farmacia' ? revBase : null,
      firma: prefisso === 'accessi' ? nEventi + ':' + UTENTI.length : null,
      conteggi: prefisso === 'farmacia' ? (opz.conteggi || conteggiDi(dati)) : conteggiAccessi(), seconda: false, dati: dati || null
    };
    copie.unshift(c);
    // come perRecenza di server/backup.js: dalla più recente; nello stesso secondo prima la revisione più alta
    copie.sort(function (a, b) {
      var ta = Date.parse(a.data);
      var tb = Date.parse(b.data);
      return tb - ta || (b.rev || 0) - (a.rev || 0) || (a.nome < b.nome ? 1 : -1);
    });
    return c;
  }
  // copie automatiche a scaglioni (come le farebbe il programma installato): tutte rifanno i dati di quando si è aperta la pagina
  var datiIniziali = null;
  (function copieIniziali() {
    datiIniziali = istantanea();
    var adesso = new Date();
    var dim = dimensioneStimata();
    var momenti = [];
    var h;
    for (h = 1; h <= 6; h++) momenti.push(new Date(adesso.getTime() - h * 3600000 - 7 * 60000));
    for (h = 1; h <= 13; h++) { var g = new Date(adesso); g.setDate(g.getDate() - h); g.setHours(23, 50, 12, 0); momenti.push(g); }
    for (h = 2; h <= 7; h++) { var s = new Date(adesso); s.setDate(s.getDate() - h * 7); s.setHours(23, 50, 12, 0); momenti.push(s); }
    for (h = 2; h <= 4; h++) { var m = new Date(adesso.getFullYear(), adesso.getMonth() - h + 1, 1, 0, 5, 3); if (m < adesso) momenti.push(m); }
    momenti.forEach(function (d, i) {
      var quota = Math.max(0.35, 1 - (adesso - d) / (160 * 86400000));
      nuovaCopia('farmacia', 'auto', d, null, { dimensione: Math.round(dim * quota), rev: Math.max(1, Math.round(rev * quota)), conteggi: null });
      nuovaCopia('accessi', 'auto', d, null);
      void i;
    });
  })();
  function elencoCopie() {
    return copie.map(function (c) {
      return { nome: c.nome, prefisso: c.prefisso, tipo: c.tipo, data: c.data, dimensione: c.dimensione, verificata: c.verificata, verificataIl: c.verificataIl,
        errore: c.errore, rev: c.rev, base: c.base, firma: c.firma, conteggi: c.conteggi, seconda: c.seconda };
    });
  }
  function ripristina(ctx, nome) {
    var x = copie.filter(function (c) { return c.nome === nome && c.prefisso === 'farmacia'; })[0];
    if (!x) throw errore(404, 'Copia non trovata.');
    var sicurezza = nuovaCopia('farmacia', 'prima-del-ripristino', new Date(), istantanea());
    var dati = JSON.parse(x.dati || datiIniziali);
    TABELLE.forEach(function (t) { S[t] = dati[t]; });
    S.impostazioni = dati.impostazioni;
    meta = dati.meta || {};
    rev++;
    revBase = rev;
    revRiga = {};
    cancellati = [];
    storia = Math.random().toString(16).slice(2);
    var esistenti = S.reparti.map(function (r) { return r.id; });
    var mancanti = [];
    UTENTI.forEach(function (u) { u.reparti.forEach(function (id) { if (esistenti.indexOf(id) < 0 && mancanti.indexOf(id) < 0) mancanti.push(id); }); });
    var toccati = mancanti.length ? togliRepartoDagliUtenti(mancanti) : [];
    evento(ctx, 'backup.ripristina', { copia: nome, copiaDiSicurezza: sicurezza.nome, utentiAggiornati: toccati.length });
    var r = rev;
    ascoltatori.slice().forEach(function (a) { a._evento('rev', { rev: r }); });
    return { rev: r, sicurezza: sicurezza.nome };
  }

  // stato della base dati (GET /api/sistema): un esempio verosimile, con i numeri veri dell'anteprima
  var statoSalute = (function () {
    var adesso = Date.now();
    var controlli = [];
    for (var i = 13; i >= 1; i--) {
      var notte = new Date(adesso - i * 86400000);
      notte.setHours(3, 12, 40, 0);
      controlli.push({ quando: notte.toISOString(), tipo: 'notte', esito: 'ok', durataMs: 420 + (i * 37) % 160, file: { farmacia: { esito: 'ok', messaggi: ['ok'], durataMs: 380, chiaviEsterne: 0 }, accessi: { esito: 'ok', messaggi: ['ok'], durataMs: 21, chiaviEsterne: 0 } } });
    }
    controlli.push({ quando: AVVIO, tipo: 'avvio', esito: 'ok', durataMs: 96, file: { farmacia: { esito: 'ok', messaggi: ['ok'], durataMs: 80, chiaviEsterne: 0 }, accessi: { esito: 'ok', messaggi: ['ok'], durataMs: 9, chiaviEsterne: 0 } } });
    var quandoCura = new Date(adesso - 24 * 86400000);
    quandoCura.setHours(7, 2, 11, 0);
    var cure = [{ quando: quandoCura.toISOString(), file: 'farmacia.db', motivo: 'database disk image is malformed', metodo: 'copia', esito: 'curato', copia: 'farmacia_' + marcaTempo(new Date(quandoCura.getTime() - 5 * 3600000)) + '_auto.db',
      revCopia: 1, riapplicate: 37, revFinale: 38, perse: 0, spostatoIn: 'danneggiati', messaggi: [], durataMs: 1840,
      messaggio: 'Dopo un’interruzione di corrente il magazzino (farmacia.db) era danneggiato: ripreso dalla copia delle 02:00 e riapplicate 37 modifiche dal giornale. Nessun dato perso.' }];
    var crescita = [];
    var dim = dimensioneStimata();
    for (var g = 150; g >= 0; g -= 1) {
      var d = new Date(adesso - g * 86400000);
      var q = 1 - g / 160;
      crescita.push({ giorno: d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate()), dimensione: Math.round(dim * q), accessi: dimensioneAccessi(), movimenti: Math.round(S.movimenti.length * q), rev: Math.max(1, Math.round(rev * q)) });
    }
    return { controlli: controlli, cure: cure, crescita: crescita, provaRipristino: null, seconda: { percorso: '', origine: '', raggiungibile: null, ultimaSincronizzazione: null, errore: null, inCorso: false } };
  })();

  function prossimoNotturno() {
    var d = new Date();
    if (d.getHours() >= 2) d.setDate(d.getDate() + 1);
    d.setHours(2, 0, 0, 0);
    return d.toISOString();
  }
  function statoSistema() {
    var adesso = Date.now();
    var conteggi = {};
    TABELLE.forEach(function (t) { conteggi[t] = S[t].length; });
    conteggi.utenti = UTENTI.length;
    conteggi.eventi = eventi.length;
    var controlli = statoSalute.controlli.slice(-20).reverse();
    var ultimoCompleto = statoSalute.controlli.filter(function (c) { return c.tipo !== 'avvio'; }).slice(-1)[0] || null;
    var lista = elencoCopie();
    var mag = lista.filter(function (c) { return c.prefisso === 'farmacia'; });
    var ultimaVer = mag.filter(function (c) { return c.verificata === true; })[0] || null;
    var giornoOggi = oggi();
    var cr = statoSalute.crescita.slice();
    cr[cr.length - 1] = { giorno: giornoOggi, dimensione: dimensioneStimata(), accessi: dimensioneAccessi(), movimenti: S.movimenti.length, rev: rev };
    var st = {
      versione: VERSIONE, avvio: AVVIO, adesso: new Date(adesso).toISOString(), cartella: 'C:\\Programmi\\Pharmacy\\dati (anteprima)',
      file: { farmacia: { dimensione: dimensioneStimata(), wal: 32768 + (rev % 40) * 4096 }, accessi: { dimensione: dimensioneAccessi(), wal: 8192 } },
      revisione: rev, base: revBase, conteggi: conteggi,
      controllo: { ultimo: controlli[0] || null, ultimoCompleto: ultimoCompleto, prossimoNotturno: prossimoNotturno() },
      controlli: controlli, cure: statoSalute.cure.slice().reverse(), copie: lista,
      copieRiassunto: {
        totale: lista.length, verificate: lista.filter(function (c) { return c.verificata === true; }).length, nonRiuscite: lista.filter(function (c) { return c.verificata === false; }).length,
        daVerificare: lista.filter(function (c) { return c.verificata === null; }).length, dimensione: lista.reduce(function (s, c) { return s + c.dimensione; }, 0),
        ultimaVerificata: ultimaVer ? { nome: ultimaVer.nome, data: ultimaVer.data, rev: ultimaVer.rev } : null,
        oreDallUltima: ultimaVer ? Math.round((adesso - new Date(ultimaVer.data).getTime()) / 36e5 * 10) / 10 : null
      },
      giornale: { cartella: 'C:\\Programmi\\Pharmacy\\dati (anteprima)\\giornale', file: 14, dimensione: 2400000 + rev * 900, dal: statoSalute.crescita[136].giorno,
        ultimaRevisione: rev, ultimaScrittura: new Date(adesso - 45000).toISOString(), errore: null, scritteSessione: rev - REV_INIZIALE },
      disco: { libero: 187.4 * 1024 * 1024 * 1024, totale: 256 * 1024 * 1024 * 1024 },
      secondaCartella: copia(statoSalute.seconda), secondaDaConfigurazione: false, provaRipristino: copia(statoSalute.provaRipristino),
      crescita: cr.slice(-120), erroreCopie: null, problema: null
    };
    // semaforo, con le regole di server/salute.js (valutaSemaforo)
    var motivi = [];
    if (!st.copieRiassunto.ultimaVerificata) motivi.push({ livello: 'problema', testo: 'Non c’è nessuna copia verificata del magazzino.' });
    else if (st.copieRiassunto.oreDallUltima > 26) motivi.push({ livello: 'attenzione', testo: 'L’ultima copia verificata ha più di un giorno.' });
    var sc = st.secondaCartella;
    if (sc && sc.percorso && sc.raggiungibile === false) motivi.push({ livello: 'attenzione', testo: 'La seconda cartella delle copie non è raggiungibile.' });
    st.stato = motivi.some(function (x) { return x.livello === 'problema'; }) ? 'problema' : motivi.length ? 'attenzione' : 'ok';
    st.motivi = motivi;
    return st;
  }
  function nellAnteprima(testoAvviso) {
    setTimeout(function () { if (root.App && root.App.avviso) root.App.avviso(testoAvviso, 'ok'); }, 900);
  }
  function controllaSistema(ctx) {
    var c = { quando: new Date().toISOString(), tipo: 'manuale', esito: 'ok', durataMs: 380 + Math.round(Math.random() * 120),
      file: { farmacia: { esito: 'ok', messaggi: ['ok'], durataMs: 360, chiaviEsterne: 0 }, accessi: { esito: 'ok', messaggi: ['ok'], durataMs: 18, chiaviEsterne: 0 } } };
    statoSalute.controlli.push(c);
    evento(ctx, 'sistema.controlla', { esito: c.esito, durataMs: c.durataMs });
    nellAnteprima('Nell’anteprima il controllo è simulato: nel programma installato controlla davvero i file farmacia.db e accessi.db.');
    return { controllo: c, sistema: statoSistema() };
  }
  function copiaSistema(ctx) {
    var d = new Date();
    var a = nuovaCopia('farmacia', 'manuale', d, istantanea());
    var b = nuovaCopia('accessi', 'manuale', d, null);
    var nomi = [a.nome, b.nome];
    var nuove = elencoCopie().filter(function (c) { return nomi.indexOf(c.nome) >= 0; });
    evento(ctx, 'sistema.copia', { copie: nomi, verificate: true });
    nellAnteprima('Nell’anteprima la copia resta dentro la pagina: nel programma installato è un file .db verificato nella cartella dati (e, se c’è, nella seconda cartella).');
    return { copie: nuove, sistema: statoSistema() };
  }
  function provaRipristino(ctx) {
    var base = elencoCopie().filter(function (c) { return c.prefisso === 'farmacia' && c.verificata === true; })[0];
    if (!base) throw errore(409, 'Non c’è ancora nessuna copia verificata del magazzino da cui partire: fai prima una copia (“Copia adesso”).');
    // stessi riassunti del programma vero (server/salute.js riassuntoTabella): righe, somma delle revisioni, somma delle
    // quantità o dei prezzi, impronta delle coppie id+revisione; qui ricostruita e attuale coincidono
    var tabelle = TABELLE.map(function (t) {
      var a = riassuntoTabella(t);
      return { tabella: t, attuale: a, ricostruita: copia(a), uguale: true };
    });
    var imp = { righe: Object.keys(S.impostazioni).length, sommaRev: null, somma: null, campoSomma: null, impronta: impronta(JSON.stringify(S.impostazioni)) };
    tabelle.push({ tabella: 'impostazioni', attuale: imp, ricostruita: copia(imp), uguale: true });
    var p = { quando: new Date().toISOString(), esito: 'ok', copia: base.nome, copiaData: base.data, revCopia: base.rev, riapplicate: Math.max(0, rev - (base.rev || rev)),
      revRicostruita: rev, revAttuale: rev, tabelle: tabelle, messaggi: [], durataMs: 1200 + Math.round(Math.random() * 600) };
    statoSalute.provaRipristino = p;
    evento(ctx, 'sistema.prova-ripristino', { esito: p.esito, copia: p.copia, riapplicate: p.riapplicate, durataMs: p.durataMs });
    nellAnteprima('Nell’anteprima la prova è simulata: nel programma installato ricostruisce davvero i dati da una copia e dal giornale, in una cartella a parte.');
    return { prova: p, sistema: statoSistema() };
  }
  // impronta corta (16 cifre esadecimali) di un testo: due FNV-1a a 32 bit con semi diversi
  function impronta(testo) {
    var a = 0x811c9dc5;
    var b = 0x01000193 ^ 0x5bd1e995;
    for (var i = 0; i < testo.length; i++) {
      var c = testo.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x01000193) >>> 0;
    }
    return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8);
  }
  function riassuntoTabella(t) {
    var righe = S[t];
    var campo = t === 'movimenti' || t === 'richiesteRighe' || t === 'ddtRighe' ? 'quantita' : t === 'articoli' ? 'prezzo' : null;
    var sommaRev = 0;
    var somma = 0;
    var ids = righe.map(function (x) {
      var r = revRiga[t + '|' + x.id] || 1;
      sommaRev += r;
      if (campo) somma += Number(x[campo]) || 0;
      return x.id + ':' + r;
    }).sort();
    return { righe: righe.length, sommaRev: sommaRev, somma: campo ? Math.round(somma * 1e6) / 1e6 : null, campoSomma: campo, impronta: impronta(ids.join(';')) };
  }
  function secondaCartella(ctx, percorso) {
    percorso = String(percorso === undefined || percorso === null ? '' : percorso).trim();
    var assoluto = /^[A-Za-z]:[\\/]/.test(percorso) || /^\\\\[^\\]+\\[^\\]+/.test(percorso) || /^\//.test(percorso);
    if (percorso && (percorso.length > 400 || /[\0\r\n]/.test(percorso) || !assoluto)) {
      throw errore(400, 'Scrivi il percorso completo della cartella, per esempio E:\\CopieFarmacia oppure \\\\server\\condivisa\\Farmacia.');
    }
    if (percorso && /^c:[\\/]programmi[\\/]pharmacy[\\/]dati/i.test(percorso)) throw errore(400, 'La seconda cartella deve stare fuori dalla cartella dati (meglio su un altro disco o in rete).');
    statoSalute.seconda = percorso
      ? { percorso: percorso, origine: 'pagina', raggiungibile: false, ultimaSincronizzazione: null, errore: 'nell’anteprima non c’è un disco vero: nel programma installato copie e giornale vanno anche lì', inCorso: false }
      : { percorso: '', origine: '', raggiungibile: null, ultimaSincronizzazione: null, errore: null, inCorso: false };
    evento(ctx, 'sistema.seconda-cartella', { percorso: percorso });
    return { seconda: copia(statoSalute.seconda), sistema: statoSistema() };
  }

  /* ======================= rotte ======================= */

  var rotte = [];
  function rotta(metodo, schema, opz, fn) {
    var nomi = [];
    var re = new RegExp('^' + schema.replace(/:([a-zA-Z]+)/g, function (_, n) { nomi.push(n); return '([^/]+)'; }) + '$');
    rotte.push({ metodo: metodo, re: re, nomi: nomi, opz: opz, fn: fn });
  }
  var PUBBLICA = { pubblica: true };
  var LIBERA = { anchePasswordDaCambiare: true, anche2faDaAttivare: true };
  var DA_ATTIVARE = { anche2faDaAttivare: true };
  function P(permesso) { return { permesso: permesso }; }

  function statoPubblico() {
    var imp = S.impostazioni;
    return {
      inizializzato: true, daServer: false, nomeProdotto: imp.nomeProdotto, sigla: imp.sigla, struttura: imp.struttura, sottotitolo: imp.sottotitolo,
      logo: imp.logo, coloreAccento: imp.coloreAccento, tema: imp.tema, versione: VERSIONE, utente: vistaUtente(sessione), permessi: permessi(sessione)
    };
  }

  rotta('GET', '/api/stato', PUBBLICA, function () { return statoPubblico(); });
  rotta('POST', '/api/setup', PUBBLICA, function () { throw errore(409, 'Il primo amministratore esiste già.'); });
  rotta('POST', '/api/login', PUBBLICA, function (ctx) { return login(ctx.corpo); });
  rotta('POST', '/api/login/2fa', PUBBLICA, function (ctx) { return loginDueFattori(ctx.corpo); });
  rotta('POST', '/api/logout', PUBBLICA, function (ctx) {
    if (ctx.utente) evento(ctx, 'accesso.uscita', {});
    sessione = null;
    setTimeout(chiudiNotifiche, 0);
    return { ok: true };
  });
  rotta('POST', '/api/password', LIBERA, function (ctx) { return cambiaPassword(ctx, ctx.corpo.attuale, ctx.corpo.nuova); });

  rotta('GET', '/api/dati', {}, function (ctx) {
    var da = Number(ctx.query.get('da')) || 0;
    var st = ctx.query.get('storia');
    var completo = da <= 0 || da < revBase || da > rev || (st !== null && st !== undefined && st !== storia);
    var out = { rev: rev, storia: storia, completo: completo };
    TABELLE.forEach(function (t) {
      var righe = completo ? S[t] : S[t].filter(function (x) { return (revRiga[t + '|' + x.id] || 0) > da; });
      out[t] = ordina(righe, ORDINE_SYNC[t]).map(function (x) { return vista(t, x); });
    });
    out.cancellati = completo ? [] : cancellati.filter(function (c) { return c.rev > da; }).map(function (c) { return { tabella: c.tabella, id: c.id }; });
    if (completo || (revRiga['impostazioni|tutte'] || 0) > da) out.impostazioni = copia(S.impostazioni);
    return out;
  });

  rotta('POST', '/api/movimenti', {}, function (ctx) { return registraMovimenti(ctx, ctx.corpo.movimenti); });
  rotta('POST', '/api/movimenti/:id/annulla', {}, function (ctx) { return annullaMovimento(ctx, ctx.par.id, ctx.corpo.motivo); });
  rotta('POST', '/api/consumo-giorno', {}, function (ctx) { return consumoGiorno(ctx, ctx.corpo); });

  rotta('POST', '/api/articoli', {}, function (ctx) { return creaArticolo(ctx, ctx.corpo); });
  rotta('POST', '/api/articoli/importa', {}, function (ctx) { return importaArticoli(ctx, ctx.corpo); });
  rotta('PUT', '/api/articoli/:id', {}, function (ctx) { return modificaArticolo(ctx, ctx.par.id, ctx.corpo); });
  rotta('POST', '/api/articoli/:id/barcode', P('articoli'), function (ctx) { return associaCodice(ctx, ctx.par.id, ctx.corpo.chiave); });
  rotta('DELETE', '/api/articoli/:id', {}, function (ctx) { return eliminaArticolo(ctx, ctx.par.id); });

  rotta('PUT', '/api/impostazioni', {}, function (ctx) { return salvaImpostazioni(ctx, ctx.corpo); });
  rotta('PUT', '/api/reparti', {}, function (ctx) { return salvaReparti(ctx, ctx.corpo); });
  rotta('DELETE', '/api/reparti/:id', P('impostazioni'), function (ctx) { var r = eliminaReparto(ctx, ctx.par.id); return { rev: r.rev }; });

  rotta('GET', '/api/utenti', P('utenti'), function (ctx) { richiedi(ctx, 'utenti'); return { utenti: utentiPerNome().map(vistaUtente) }; });
  rotta('POST', '/api/utenti', P('utenti'), function (ctx) { richiedi(ctx, 'utenti'); return creaUtente(ctx, ctx.corpo); });
  rotta('PUT', '/api/utenti/:id', P('utenti'), function (ctx) { richiedi(ctx, 'utenti'); return modificaUtente(ctx, ctx.par.id, ctx.corpo); });
  rotta('POST', '/api/utenti/:id/password', P('utenti'), function (ctx) { richiedi(ctx, 'utenti'); return reimpostaPassword(ctx, ctx.par.id, ctx.corpo.nuova); });
  rotta('GET', '/api/attivita', P('attivita'), function (ctx) { richiedi(ctx, 'attivita'); return { eventi: eventiFiltrati(ctx.query) }; });

  rotta('GET', '/api/backup', P('backup'), function (ctx) {
    richiedi(ctx, 'backup');
    return { backup: elencoCopie().filter(function (c) { return c.prefisso === 'farmacia'; }), cartella: 'C:\\Programmi\\Pharmacy\\dati (anteprima)\\backup' };
  });
  rotta('POST', '/api/backup', P('backup'), function (ctx) {
    richiedi(ctx, 'backup');
    var c = nuovaCopia('farmacia', 'manuale', new Date(), istantanea());
    evento(ctx, 'backup.crea', { copia: c.nome });
    return { nome: c.nome, backup: elencoCopie().filter(function (x) { return x.prefisso === 'farmacia'; }) };
  });
  rotta('GET', '/api/backup/:nome', P('backup'), function () {
    throw errore(409, 'Nell’anteprima le copie di sicurezza restano dentro la pagina e non si scaricano: nel programma installato “Scarica” salva il file .db della copia.');
  });
  rotta('POST', '/api/backup/:nome/ripristina', P('backup'), function (ctx) { richiedi(ctx, 'backup'); return ripristina(ctx, ctx.par.nome); });
  rotta('POST', '/api/importa-archivio', P('impostazioni'), function (ctx) {
    richiedi(ctx, 'impostazioni');
    throw errore(409, 'L’archivio della versione per un solo PC si può importare solo in un archivio vuoto.');
  });
  rotta('POST', '/api/demo', {}, function (ctx) {
    richiedi(ctx, 'impostazioni');
    throw errore(409, 'I dati di prova si possono caricare solo in un archivio vuoto.');
  });

  // richieste, DDT, consegne (server/logistica.js)
  var RICHIESTE = P('richieste');
  var EVADI = P('evadiRichieste');
  var DDT = P('ddt');
  rotta('POST', '/api/richieste', RICHIESTE, function (ctx) { return creaRichiesta(ctx, ctx.corpo); });
  rotta('PUT', '/api/richieste/:id', RICHIESTE, function (ctx) { return modificaRichiesta(ctx, ctx.par.id, ctx.corpo); });
  rotta('POST', '/api/richieste/:id/invia', RICHIESTE, function (ctx) { return inviaRichiesta(ctx, ctx.par.id); });
  rotta('POST', '/api/richieste/:id/annulla', RICHIESTE, function (ctx) { return annullaRichiesta(ctx, ctx.par.id, ctx.corpo.motivo); });
  rotta('POST', '/api/richieste/:id/prendi', EVADI, function (ctx) { return prendiRichiesta(ctx, ctx.par.id); });
  rotta('POST', '/api/richieste/:id/approva', EVADI, function (ctx) { return approvaRichiesta(ctx, ctx.par.id, ctx.corpo); });
  rotta('POST', '/api/richieste/:id/rifiuta', EVADI, function (ctx) { return rifiutaRichiesta(ctx, ctx.par.id, ctx.corpo.motivo); });
  rotta('POST', '/api/richieste/:id/chiudi', EVADI, function (ctx) { return chiudiRichiesta(ctx, ctx.par.id, ctx.corpo.motivo); });
  rotta('POST', '/api/richieste/:id/ddt', EVADI, function (ctx) { return preparaDdtRichiesta(ctx, ctx.par.id, ctx.corpo); });
  rotta('POST', '/api/ddt', DDT, function (ctx) { return creaDdt(ctx, ctx.corpo); });
  rotta('PUT', '/api/ddt/:id', DDT, function (ctx) { return modificaDdt(ctx, ctx.par.id, ctx.corpo); });
  rotta('POST', '/api/ddt/:id/spedisci', DDT, function (ctx) { return spedisciDdt(ctx, ctx.par.id, ctx.corpo); });
  rotta('POST', '/api/ddt/:id/ricevi', P('riceviDdt'), function (ctx) { return riceviDdt(ctx, ctx.par.id, ctx.corpo); });
  rotta('POST', '/api/ddt/:id/annulla', DDT, function (ctx) { return annullaDdt(ctx, ctx.par.id, ctx.corpo.motivo); });
  rotta('GET', '/api/trasportatori', DDT, function (ctx) { return trasportatori(ctx); });

  // magazzini, armadi, assortimento (server/struttura.js)
  var STRUTTURA = P('struttura');
  rotta('POST', '/api/magazzini', STRUTTURA, function (ctx) { return creaMagazzino(ctx, ctx.corpo); });
  rotta('PUT', '/api/magazzini/:id', STRUTTURA, function (ctx) { return modificaMagazzino(ctx, ctx.par.id, ctx.corpo); });
  rotta('DELETE', '/api/magazzini/:id', STRUTTURA, function (ctx) { return eliminaMagazzino(ctx, ctx.par.id); });
  rotta('POST', '/api/armadi', STRUTTURA, function (ctx) { return creaArmadio(ctx, ctx.corpo); });
  rotta('PUT', '/api/armadi/:id', STRUTTURA, function (ctx) { return modificaArmadio(ctx, ctx.par.id, ctx.corpo); });
  rotta('DELETE', '/api/armadi/:id', STRUTTURA, function (ctx) { return eliminaArmadio(ctx, ctx.par.id); });
  rotta('PUT', '/api/assortimento', P('assortimento'), function (ctx) { return salvaAssortimento(ctx, ctx.corpo); });
  rotta('PUT', '/api/ubicazioni', P('ubicazioni'), function (ctx) { return salvaUbicazioni(ctx, ctx.corpo); });

  // verifica in due passaggi (server/sicurezza.js)
  var ADMIN = P('sicurezza');
  rotta('GET', '/api/2fa', DA_ATTIVARE, function (ctx) { return stato2fa(ctx.utente); });
  rotta('POST', '/api/2fa/inizia', DA_ATTIVARE, function (ctx) { return inizia2fa(ctx); });
  rotta('POST', '/api/2fa/conferma', DA_ATTIVARE, function (ctx) { return conferma2fa(ctx, ctx.corpo.codice); });
  rotta('POST', '/api/2fa/disattiva', {}, function (ctx) { return disattiva2fa(ctx, ctx.corpo.password, ctx.corpo.codice); });
  rotta('POST', '/api/2fa/codici', {}, function (ctx) { return nuoviCodici2fa(ctx, ctx.corpo.password); });
  rotta('DELETE', '/api/2fa/dispositivi', {}, function (ctx) { return dimenticaDispositivi(ctx); });
  rotta('GET', '/api/sicurezza', ADMIN, function (ctx) { richiedi(ctx, 'sicurezza'); return statoSicurezza(); });
  rotta('PUT', '/api/sicurezza', ADMIN, function (ctx) { richiedi(ctx, 'sicurezza'); return salvaCriterio(ctx, ctx.corpo.richiedi2fa); });
  rotta('POST', '/api/utenti/:id/2fa/azzera', ADMIN, function (ctx) { richiedi(ctx, 'sicurezza'); return azzera2fa(ctx, ctx.par.id); });

  // stato della base dati (server/salute.js): nell'anteprima è un esempio
  var SISTEMA = P('sistema');
  rotta('GET', '/api/sistema', SISTEMA, function (ctx) { richiedi(ctx, 'sistema'); return statoSistema(); });
  rotta('POST', '/api/sistema/controlla', SISTEMA, function (ctx) { richiedi(ctx, 'sistema'); return controllaSistema(ctx); });
  rotta('POST', '/api/sistema/copia', SISTEMA, function (ctx) { richiedi(ctx, 'sistema'); return copiaSistema(ctx); });
  rotta('POST', '/api/sistema/prova-ripristino', SISTEMA, function (ctx) { richiedi(ctx, 'sistema'); return provaRipristino(ctx); });
  rotta('PUT', '/api/sistema/seconda-cartella', SISTEMA, function (ctx) { richiedi(ctx, 'sistema'); return secondaCartella(ctx, ctx.corpo.percorso); });

  /* ======================= smistamento (come Server.gestisciApi) ======================= */

  var ERRORE_2FA_DA_ATTIVARE = 'Prima di continuare attiva la verifica in due passaggi: l’amministratore la richiede per il tuo ruolo.';
  function contesto() { return { utente: sessione, permessi: permessi(sessione), username: sessione ? sessione.username : '' }; }

  function gestisci(metodo, percorso, query, corpo, intestazioni) {
    var trovata = null;
    var par = {};
    var noto = false;
    for (var i = 0; i < rotte.length && !trovata; i++) {
      var m = rotte[i].re.exec(percorso);
      if (!m) continue;
      noto = true;
      if (rotte[i].metodo !== metodo) continue;
      trovata = rotte[i];
      try {
        rotte[i].nomi.forEach(function (n, k) { par[n] = decodeURIComponent(m[k + 1]); });
      } catch (e) { return { stato: 400, json: { errore: 'Indirizzo non valido.' } }; }
    }
    if (!trovata) return { stato: noto ? 405 : 404, json: { errore: noto ? 'Metodo non permesso.' : 'Indirizzo non trovato.' } };
    if (metodo !== 'GET' && metodo !== 'HEAD' && intestazioni['x-richiesta'] !== '1') return { stato: 403, json: { errore: 'Richiesta non permessa.' } };
    var opz = trovata.opz;
    if (!opz.pubblica) {
      if (!sessione || !sessione.attivo) return { stato: 401, json: { errore: 'Sessione scaduta: accedi di nuovo.' } };
      if (intestazioni['x-utente'] && intestazioni['x-utente'] !== sessione.id) return { stato: 401, json: { errore: 'In questo browser è entrato un altro utente: accedi di nuovo.', altroUtente: true } };
      if (sessione.cambioPassword && !opz.anchePasswordDaCambiare) return { stato: 403, json: { errore: 'Prima di continuare cambia la password.' } };
      if (vistaUtente(sessione).dueFattoriDaAttivare && !opz.anche2faDaAttivare) return { stato: 401, json: { errore: ERRORE_2FA_DA_ATTIVARE, attiva2fa: true } };
      if (opz.permesso && !permessi(sessione)[opz.permesso]) return { stato: 403, json: { errore: 'Il tuo utente non può fare questa operazione.' } };
    }
    var ctx = contesto();
    ctx.corpo = corpo && typeof corpo === 'object' ? corpo : {};
    ctx.query = query;
    ctx.par = par;
    try {
      return { stato: 200, json: trovata.fn(ctx) };
    } catch (e) {
      if (e instanceof Errore) return { stato: e.stato, json: Object.assign({}, e.dati || {}, { errore: e.message }) };
      if (root.console) console.error(e);
      return { stato: 500, json: { errore: 'Errore interno dell’anteprima: ' + (e && e.message) } };
    }
  }

  /* ======================= fetch ed EventSource ======================= */

  // solo gli indirizzi "api/…" relativi alla pagina (js/api.js li scrive così): la pagina pubblicata può stare in una
  // cartella il cui percorso contiene già "/api/", e i suoi file (caratteri, librerie) non devono finire qui
  function percorsoApi(indirizzo) {
    var url = new URL(String(indirizzo), location.href);
    var base = location.pathname.replace(/[^/]*$/, '');
    if (url.origin !== location.origin || url.pathname.indexOf(base + 'api/') !== 0) return null;
    return { percorso: '/' + url.pathname.slice(base.length), query: url.searchParams };
  }
  function leggiIntestazioni(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { out[String(k).toLowerCase()] = String(v); });
    else if (Array.isArray(h)) h.forEach(function (x) { out[String(x[0]).toLowerCase()] = String(x[1]); });
    else Object.keys(h).forEach(function (k) { out[k.toLowerCase()] = String(h[k]); });
    return out;
  }

  // videoguide: quelle registrate mostrano il programma installato (con il marchio della struttura) e nell'anteprima non ci
  // sono. Rispondo subito "non c'è" (404), qualunque cosa risponderebbe il sito che ospita la pagina: la Guida mostra i passi scritti
  function videoguida(indirizzo) {
    var url = new URL(String(indirizzo), location.href);
    var base = location.pathname.replace(/[^/]*$/, '');
    return url.origin === location.origin && url.pathname.indexOf(base + 'guide/') === 0;
  }

  var fetchVero = root.fetch.bind(root);
  root.fetch = function (input, init) {
    var indirizzo = input && typeof input === 'object' && 'url' in input ? input.url : String(input);
    if (videoguida(indirizzo)) return Promise.resolve(new Response('', { status: 404 }));
    var api = percorsoApi(indirizzo);
    if (!api) return fetchVero(input, init);
    var metodo = ((init && init.method) || 'GET').toUpperCase();
    var corpo = null;
    if (init && init.body) {
      try { corpo = JSON.parse(init.body); } catch (e) {
        return Promise.resolve(new Response(JSON.stringify({ errore: 'Richiesta non valida (JSON).' }), { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
      }
    }
    var esito = gestisci(metodo, api.percorso, api.query, corpo, leggiIntestazioni(init && init.headers));
    // piccola attesa, come in rete (le prove automatiche possono accorciarla)
    return new Promise(function (ok) {
      setTimeout(function () {
        ok(new Response(JSON.stringify(esito.json), { status: esito.stato, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
      }, typeof root.ATTESA_ANTEPRIMA_MS === 'number' ? root.ATTESA_ANTEPRIMA_MS : 60);
    });
  };

  function SorgenteFinta(indirizzo) {
    this.url = indirizzo;
    this.readyState = 0;
    this._asc = {};
    var self = this;
    ascoltatori.push(this);
    setTimeout(function () {
      if (self.readyState === 2) return;
      // come il server vero: senza sessione (o con la verifica in due passaggi da attivare) le notifiche non si aprono
      if (!sessione || vistaUtente(sessione).dueFattoriDaAttivare) { self.readyState = 2; self._evento('error', null, true); self.close(); return; }
      self.readyState = 1;
      self._evento('open', null);
      self._evento('rev', { rev: rev });
    }, 50);
  }
  SorgenteFinta.prototype.addEventListener = function (tipo, fn) { (this._asc[tipo] = this._asc[tipo] || []).push(fn); };
  SorgenteFinta.prototype.removeEventListener = function (tipo, fn) { this._asc[tipo] = (this._asc[tipo] || []).filter(function (f) { return f !== fn; }); };
  SorgenteFinta.prototype.close = function () {
    this.readyState = 2;
    var self = this;
    ascoltatori = ascoltatori.filter(function (a) { return a !== self; });
  };
  SorgenteFinta.prototype._evento = function (tipo, dati, ancheChiusa) {
    if (this.readyState === 2 && !ancheChiusa) return;
    var e = { type: tipo, data: dati === null ? '' : JSON.stringify(dati) };
    (this._asc[tipo] || []).forEach(function (fn) { try { fn(e); } catch (x) { if (root.console) console.error(x); } });
  };
  SorgenteFinta.CONNECTING = 0;
  SorgenteFinta.OPEN = 1;
  SorgenteFinta.CLOSED = 2;
  function chiudiNotifiche() {
    ascoltatori.slice().forEach(function (a) { a.readyState = 2; a._evento('error', null, true); a.close(); });
  }
  var EventSourceVero = root.EventSource;
  root.EventSource = function (indirizzo, opz) {
    var api = percorsoApi(indirizzo);
    if (api && api.percorso === '/api/eventi') return new SorgenteFinta(indirizzo);
    return new EventSourceVero(indirizzo, opz);
  };

  /* ======================= prima dell'avvio ======================= */

  // js/accesso.js disegna "Collegamento al server…" prima di avere lo stato pubblico: con il logo incorporato chiederebbe
  // brand/logo.png, che nell'anteprima non c'è (marchio neutro). Appena esiste window.Accesso gli do lo stato dell'anteprima
  // (nome dimostrativo, nessun logo); /api/stato lo sostituisce subito dopo.
  (function () {
    var valore;
    try {
      Object.defineProperty(root, 'Accesso', {
        configurable: true, enumerable: true,
        get: function () { return valore; },
        set: function (v) {
          valore = v;
          if (v && typeof v === 'object' && !v.stato) v.stato = { nomeProdotto: S.impostazioni.nomeProdotto, struttura: S.impostazioni.struttura, sottotitolo: S.impostazioni.sottotitolo, logo: S.impostazioni.logo, versione: VERSIONE };
        }
      });
    } catch (e) { /* proprietà non ridefinibile: resta il comportamento normale */ }
  })();

  /* ======================= per la banda dell'anteprima ======================= */

  // nella pagina pubblicata la fotocamera non è permessa: niente pulsante "Fotocamera" (nel programma vero c'è)
  try { root.BarcodeDetector = undefined; } catch (e) { /* proprietà non scrivibile: resta com'è */ }

  // codice dell'app di autenticazione in questo momento (e quanti secondi mancano al prossimo)
  // usato: il codice di questo momento è già servito per entrare (non vale una seconda volta: si aspetta il prossimo)
  function codiceDi(segreto, ultimoPasso) {
    if (!segreto || !T()) return null;
    var adesso = Date.now();
    return { codice: T().totp(segreto, adesso), restano: 30 - Math.floor(adesso / 1000) % 30, usato: !!ultimoPasso && T().passo(adesso) <= ultimoPasso };
  }

  root.Anteprima = {
    PASSWORD: PASSWORD,
    RECUPERO: RECUPERO_DIMOSTRATIVO[0],
    UTENTI: UTENTI.map(function (u) {
      return { username: u.username, nome: u.nome, ruolo: u.ruolo, etichetta: RUOLI[u.ruolo], magazzini: u.reparti.map(function (id) { return (reparto(id) || {}).nome || id; }), dueFattori: u.totpAttivo };
    }),
    // codice del momento per l'utente indicato (2FA attiva) e, per chi è collegato, quello della chiave appena mostrata nel QR
    codice: function (username) {
      var u = UTENTI.filter(function (x) { return x.username === username; })[0];
      return u && u.totpAttivo ? codiceDi(u.totpSegreto, u.totpUltimoPasso) : null;
    },
    codiceAttivazione: function () {
      if (!sessione) return null;
      var att = attivazioni[sessione.id];
      if (att && att.scade > Date.now()) return codiceDi(att.segreto);
      return null;
    },
    codiceMio: function () { return sessione && sessione.totpAttivo ? codiceDi(sessione.totpSegreto, sessione.totpUltimoPasso) : null; },
    // codice per il secondo passo dell'accesso in corso (l'utente dell'ultima sfida ancora valida)
    codiceAccesso: function () {
      var adesso = Date.now();
      var ultima = null;
      Object.keys(sfide).forEach(function (k) { if (sfide[k].scade > adesso && (!ultima || sfide[k].scade > ultima.scade)) ultima = sfide[k]; });
      var u = ultima ? utente(ultima.utenteId) : null;
      return u && u.totpAttivo ? codiceDi(u.totpSegreto, u.totpUltimoPasso) : null;
    },
    collegato: function () { return sessione ? { username: sessione.username, nome: sessione.nome } : null; },
    // un collega della Degenza 1° piano registra un consumo (per vedere gli aggiornamenti in tempo reale)
    collega: function () {
      var luca = utente('u-reparto');
      var conGiacenza = S.articoli.filter(function (a) { return C.giacenza(statoArticolo(a.id), a.id, 'r-degenza') >= 1; });
      if (!conGiacenza.length || !luca) return null;
      var a = conGiacenza[Math.floor(Math.random() * conGiacenza.length)];
      var prima = sessione;
      sessione = luca;
      try {
        registraMovimenti(contesto(), [{ tipo: 'consumo', data: oggi(), articoloId: a.id, repartoId: 'r-degenza', quantita: 1 }]);
      } finally { sessione = prima; }
      return a.nome;
    },
    codiciDiProva: [
      { codice: 'A012745093', descrizione: 'Code 32 (AIC) di ' + ((articolo('demo-f0') || {}).nome || '') },
      { codice: '\u001d0108001234567897172812311025A01X', descrizione: 'Data Matrix (GTIN, scadenza, lotto) di ' + ((articolo('demo-f3') || {}).nome || '') },
      { codice: '4015630982912', descrizione: 'EAN-13 di ' + ((articolo('demo-p1') || {}).nome || '') }
    ]
  };
})(this);
