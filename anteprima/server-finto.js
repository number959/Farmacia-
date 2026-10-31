/*
 * ANTEPRIMA del Gestionale Farmacia: un server simulato dentro il browser.
 * Risponde alle stesse richieste del server vero (docs/ARCHITETTURA.md) tenendo i dati in memoria:
 * dati di prova, quattro utenti di prova, permessi, lotti, conflitti, registro attività, copie.
 * Si carica prima di js/api.js e intercetta fetch('api/…') ed EventSource('api/eventi').
 * Non è usato dal programma vero: serve solo per provarlo senza installare niente.
 */
(function (root) {
  'use strict';

  var C = root.Calcoli;
  var PASSWORD = 'prova';
  var VERSIONE = '2.1 · anteprima';

  /* ---------- stato in memoria ---------- */

  var rev = 1;
  var storia = Math.random().toString(16).slice(2);
  var revRiga = {};          // 'tabella|id' -> revisione dell'ultima modifica
  var cancellati = [];       // { tabella, id, rev }
  var eventi = [];
  var copie = [];
  var sessione = null;       // utente collegato in questa scheda
  var ascoltatori = [];
  var seq = 0;

  function id(prefisso) { return prefisso + '-' + Date.now().toString(36) + (++seq).toString(36); }
  function oggi(piu) {
    var d = new Date();
    d.setDate(d.getDate() + (piu || 0));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function copia(x) { return JSON.parse(JSON.stringify(x)); }

  var S = {
    impostazioni: { struttura: 'Clinica Posillipo', sottotitolo: 'Longevity Institute', societa: 'ME.MI. SRL', citta: 'NAPOLI', logo: '', giorniAvvisoScadenza: 90, codiceModulo: 'PRQ 1501.4EV.1' },
    reparti: [
      { id: 'r-farmacia', nome: 'Farmacia', centrale: true, attivo: true },
      { id: 'r-degenza', nome: 'Degenza', centrale: false, attivo: true },
      { id: 'r-sala', nome: 'Sala operatoria', centrale: false, attivo: true },
      { id: 'r-ambulatori', nome: 'Ambulatori', centrale: false, attivo: true }
    ],
    articoli: [],
    movimenti: []
  };

  var UTENTI = [
    { id: 'u-admin', username: 'admin', nome: 'Giovanni Amministratore', ruolo: 'amministratore', reparti: [], attivo: true, cambioPassword: false, ultimoAccesso: null, bloccato: false },
    { id: 'u-farma', username: 'farma', nome: 'Maria Farmacista', ruolo: 'farmacista', reparti: [], attivo: true, cambioPassword: false, ultimoAccesso: null, bloccato: false },
    { id: 'u-reparto', username: 'reparto', nome: 'Luca Infermiere', ruolo: 'reparto', reparti: ['r-degenza'], attivo: true, cambioPassword: false, ultimoAccesso: null, bloccato: false },
    { id: 'u-direzione', username: 'direzione', nome: 'Direzione Sanitaria', ruolo: 'consultazione', reparti: [], attivo: true, cambioPassword: false, ultimoAccesso: null, bloccato: false }
  ];
  var RUOLI = { amministratore: 1, farmacista: 1, reparto: 1, consultazione: 1 };

  (function caricaDatiDiProva() {
    var demo = root.DemoFarmacia.crea(C, { centrale: 'r-farmacia', reparti: ['r-degenza', 'r-sala', 'r-ambulatori'], oggi: new Date() });
    // qualche codice a barre di prova, per provare il lettore (vedi la banda dell'anteprima)
    var codici = { 'demo-f0': ['aic:012745093'], 'demo-f3': ['gtin:08001234567897'], 'demo-p1': ['gtin:04015630982912'] };
    S.articoli = demo.articoli.map(function (a) {
      return Object.assign({ unita: '', principio: '', confezione: '', codice: '', note: '', attivo: true, versione: 1, barcode: codici[a.id] || [], pezziConfezione: a.categoria === 'PRESIDI' ? 10 : 5 }, a);
    });
    S.movimenti = demo.movimenti.map(function (m) {
      return Object.assign({ lotto: '', scadenza: '', fornitore: '', documento: '', causale: '', note: '', annullato: null, operatore: 'Dati di prova' }, m);
    });
  })();

  /* ---------- permessi (come server/accessi.js) ---------- */

  function permessi(u) {
    if (!u) return null;
    var admin = u.ruolo === 'amministratore', farm = admin || u.ruolo === 'farmacista', rep = u.ruolo === 'reparto';
    return {
      utenti: admin, impostazioni: admin, backup: admin, attivita: farm, articoli: farm, carico: farm, trasferimento: farm,
      rettifica: farm, consumo: farm || rep, perdita: farm || rep, registro: farm || rep, annullaTutti: farm,
      reparti: rep ? u.reparti.slice() : null
    };
  }
  function puoReparto(p, rep) { return p.reparti === null || p.reparti.indexOf(rep) >= 0; }

  /* ---------- utilità di risposta ---------- */

  function Errore(stato, messaggio) { this.stato = stato; this.message = messaggio; }
  function no(stato, messaggio) { throw new Errore(stato, messaggio); }
  function richiedi(p, chi) { if (!p || !p[chi]) no(403, 'Il tuo utente non può fare questa operazione.'); }

  function scrivi(fn) {
    rev++;
    var r = fn(rev);
    ascoltatori.forEach(function (a) { a._evento('rev', { rev: rev }); });
    return r;
  }
  function tocca(tabella, idRiga, r) { revRiga[tabella + '|' + idRiga] = r; }
  // come il server vero: chi ha fatto l'operazione (anche un accesso fallito di un utente che esiste)
  function evento(azione, dettagli, username) {
    eventi.unshift({ id: eventi.length + 1, quando: new Date().toISOString(), username: username !== undefined ? username : (sessione ? sessione.username : ''), azione: azione, dettagli: dettagli || {}, ip: 'anteprima' });
  }
  function articolo(idA) { return S.articoli.filter(function (a) { return a.id === idA; })[0]; }
  function reparto(idR) { return S.reparti.filter(function (r) { return r.id === idR; })[0]; }
  function r3(x) { return C.r3(x); }
  // js/barcode.js si carica dopo questo file: lo cerco quando serve
  function B() { return root.Barcode; }

  /* ---------- controlli dei dati (gli stessi di server/operazioni.js, con gli stessi messaggi) ---------- */

  function testo(v, max, campo) {
    var t = v === undefined || v === null ? '' : String(v).trim();
    if (t.length > max) no(400, 'Il campo ' + campo + ' è troppo lungo (massimo ' + max + ' caratteri).');
    return t;
  }
  function numero(v, campo, opz) {
    var n = typeof v === 'number' ? v : parseFloat(String(v === undefined || v === null ? '' : v).replace(',', '.'));
    if (!isFinite(n)) {
      if (opz && opz.facoltativo) return opz.predefinito === undefined ? 0 : opz.predefinito;
      no(400, 'Il campo ' + campo + ' non è un numero.');
    }
    if (opz && opz.min !== undefined && n < opz.min) no(400, 'Il campo ' + campo + ' non può essere minore di ' + opz.min + '.');
    if (Math.abs(n) > 1e9) no(400, 'Il campo ' + campo + ' è troppo grande.');
    return Math.round(n * 1000) / 1000;
  }
  function dataValida(d) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    var p = d.split('-').map(Number);
    var x = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return x.getUTCFullYear() === p[0] && x.getUTCMonth() === p[1] - 1 && x.getUTCDate() === p[2] && p[0] >= 2000;
  }
  function controllaData(d) {
    if (!dataValida(d)) no(400, 'Data non valida.');
    if (d > oggi(1)) no(400, 'Non si possono registrare movimenti con una data futura (' + d + ').');
  }
  function scadenzaValida(s) {
    if (!s) return '';
    if (typeof s !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) no(400, 'Scadenza non valida: usa mese e anno.');
    return s;
  }

  /* ---------- movimenti ---------- */

  var PERM_TIPO = { carico: 'carico', consumo: 'consumo', trasferimento: 'trasferimento', perdita: 'perdita', rettifica: 'rettifica' };
  var USCITE = ['consumo', 'perdita', 'trasferimento'];

  function normalizza(p, m) {
    if (!m || typeof m !== 'object') no(400, 'Movimento non valido.');
    if (!PERM_TIPO[m.tipo]) no(400, 'Tipo di movimento non valido.');
    richiedi(p, PERM_TIPO[m.tipo]);
    controllaData(m.data);
    var a = articolo(String(m.articoloId || ''));
    if (!a) no(400, 'Articolo non trovato: aggiorna la pagina.');
    var r = reparto(String(m.repartoId || ''));
    if (!r) no(400, 'Reparto non trovato: aggiorna la pagina.');
    if (!r.attivo) no(400, 'Il reparto ' + r.nome + ' non è attivo.');
    if (!puoReparto(p, r.id)) no(403, 'Non puoi registrare movimenti per il reparto ' + r.nome + '.');
    var out = { tipo: m.tipo, data: m.data, articoloId: a.id, repartoId: r.id,
      lotto: testo(m.lotto, 60, 'lotto'), scadenza: scadenzaValida(m.scadenza || ''),
      fornitore: testo(m.fornitore, 200, 'fornitore'), documento: testo(m.documento, 100, 'documento'),
      causale: testo(m.causale, 100, 'causale'), note: testo(m.note, 500, 'note') };
    out.quantita = numero(m.quantita, 'quantità');
    if (m.tipo === 'rettifica') {
      if (!out.quantita) no(400, 'Una rettifica deve avere una quantità diversa da zero.');
    } else if (!(out.quantita > 0)) no(400, 'La quantità deve essere maggiore di zero (' + a.nome + ').');
    if (m.tipo === 'trasferimento') {
      var d = reparto(String(m.repartoDestId || ''));
      if (!d || !d.attivo) no(400, 'Reparto di arrivo non valido.');
      if (d.id === r.id) no(400, 'Il reparto di partenza e quello di arrivo sono uguali.');
      out.repartoDestId = d.id;
    }
    if (m.tipo === 'carico' && m.prezzo !== undefined && m.prezzo !== null && m.prezzo !== '') out.prezzo = numero(m.prezzo, 'prezzo', { min: 0 });
    if (m.tipo === 'rettifica' && m.teorica !== undefined && m.teorica !== null && m.teorica !== '') out.teorica = numero(m.teorica, 'giacenza teorica');
    out._articolo = a;
    out._reparto = r;
    return out;
  }

  function inserisci(m, r) {
    var nuovo = { id: id('m'), tipo: m.tipo, data: m.data, articoloId: m.articoloId, repartoId: m.repartoId, repartoDestId: m.repartoDestId,
      quantita: m.quantita, lotto: m.lotto || '', scadenza: m.scadenza || '', fornitore: m.fornitore || '', documento: m.documento || '',
      causale: m.causale || '', note: m.note || '', prezzo: m.prezzo, operatore: m.operatore || (sessione ? sessione.nome : ''),
      utenteId: m.utenteId !== undefined ? m.utenteId : (sessione ? sessione.id : undefined), creato: Date.now() + (++seq) / 1000, annullato: null };
    S.movimenti.push(nuovo);
    tocca('movimenti', nuovo.id, r);
    return nuovo;
  }

  // stato: S, oppure lo stato "di lavoro" di una richiesta con le righe già ripartite prima di questa
  function ripartisci(stato, m) {
    if (m.lotto && C.disponibilitaLotto(stato, m.articoloId, m.repartoId, m.data, m.lotto) <= 0) {
      no(409, 'Il lotto ' + m.lotto + ' di ' + m._articolo.nome + ' non è più disponibile in ' + m._reparto.nome +
        ' alla data indicata (forse l’ha appena usato un altro utente): aggiorna e scegli di nuovo il lotto.');
    }
    return C.allocaUscita(stato, m.articoloId, m.repartoId, m.data, m.quantita, m.lotto);
  }

  function registraMovimenti(p, lista) {
    if (!Array.isArray(lista) || !lista.length) no(400, 'Nessun movimento da registrare.');
    if (lista.length > 500) no(400, 'Troppi movimenti in una volta sola (massimo 500).');
    var norm = lista.map(function (m) { return normalizza(p, m); });
    var cambiati = [];
    norm.forEach(function (m) {
      if (m.tipo !== 'rettifica' || m.teorica === undefined) return;
      var attuale = r3(C.giacenza(S, m.articoloId, m.repartoId, m.data));
      if (attuale !== r3(m.teorica)) cambiati.push(m._articolo.nome + ' (ora ' + attuale + ')');
    });
    if (cambiati.length) no(409, 'Mentre contavi, altri movimenti hanno cambiato la giacenza di: ' + cambiati.join(', ') + '. Ho aggiornato le giacenze: controlla le differenze e registra di nuovo.');
    // tutto o niente: prima ripartisco tutte le righe su uno stato di lavoro (come la transazione del server vero:
    // ogni riga vede quelle prima di lei, anche due righe dello stesso articolo), poi scrivo
    var lavoro = { articoli: S.articoli, movimenti: S.movimenti.slice() };
    var ordine = Date.now() + 1e9;
    function provvisorio(m, parte) {
      lavoro.movimenti.push({ id: 'provvisorio', tipo: m.tipo, data: m.data, articoloId: m.articoloId, repartoId: m.repartoId, repartoDestId: m.repartoDestId,
        quantita: parte.quantita, lotto: parte.lotto || '', scadenza: parte.scadenza || '', creato: ++ordine, annullato: null });
    }
    var piano = norm.map(function (m) {
      if (USCITE.indexOf(m.tipo) < 0) { provvisorio(m, m); return null; }
      var parti = ripartisci(lavoro, m);
      parti.forEach(function (parte) { provvisorio(m, parte); });
      return parti;
    });
    var creati = scrivi(function (r) {
      var out = [];
      norm.forEach(function (m, i) {
        if (piano[i]) piano[i].forEach(function (parte) { out.push(inserisci(Object.assign({}, m, parte), r)); });
        else out.push(inserisci(m, r));
        if (m.tipo === 'carico' && m.prezzo !== undefined && m.prezzo !== m._articolo.prezzo) {
          m._articolo.prezzo = m.prezzo;
          m._articolo.versione++;
          tocca('articoli', m._articolo.id, r);
        }
      });
      return out;
    });
    evento('movimenti.registra', { movimenti: norm.map(function (m) {
      return { tipo: m.tipo, data: m.data, articolo: m._articolo.nome, reparto: m.repartoId, verso: m.repartoDestId || undefined, quantita: m.quantita, lotto: m.lotto || undefined };
    }) });
    return { rev: rev, movimenti: creati.map(copia) };
  }

  /* ---------- articoli ---------- */

  var MAX_CODICI = 50;
  function mancante(v) { return v === undefined || v === null || v === ''; }
  /* Codici a barre: chiavi normalizzate (js/barcode.js), senza doppioni. undefined = non indicati (in PUT restano come sono). */
  function validaCodici(lista) {
    if (lista === undefined || lista === null) return undefined;
    if (!Array.isArray(lista)) no(400, 'Codici a barre non validi.');
    var out = [];
    lista.forEach(function (k) {
      var n = B().normalizzaChiave(k);
      if (!n) no(400, 'Codice a barre non valido: ' + String(k).slice(0, 80) + '.');
      if (out.indexOf(n) < 0) out.push(n);
    });
    if (out.length > MAX_CODICI) no(400, 'Troppi codici a barre per un articolo (massimo ' + MAX_CODICI + ').');
    return out;
  }
  function validaPezzi(v) {
    if (mancante(v)) return undefined;
    var n = numero(v, 'pezzi per confezione');
    if (!(n > 0)) no(400, 'I pezzi per confezione devono essere più di zero.');
    if (n > 100000) no(400, 'I pezzi per confezione sono troppi (massimo 100000).');
    return n;
  }
  function validaArticolo(d) {
    if (!d || typeof d !== 'object') no(400, 'Articolo non valido.');
    var nome = testo(d.nome, 200, 'denominazione');
    if (!nome) no(400, 'Scrivi la denominazione.');
    if (['FARMACI', 'PRESIDI'].indexOf(d.categoria) < 0) no(400, 'Categoria non valida.');
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
  function controllaNome(nome, tranne) {
    var doppio = S.articoli.filter(function (a) { return a.nome.toLowerCase() === nome.toLowerCase() && a.id !== tranne; })[0];
    if (doppio) no(409, 'Esiste già un articolo con questo nome.');
  }
  function controllaCodici(codici, tranne) {
    (codici || []).forEach(function (k) {
      var altro = S.articoli.filter(function (a) { return a.id !== tranne && (a.barcode || []).indexOf(k) >= 0; })[0];
      if (altro) no(409, 'Il codice ' + B().descrivi(k) + ' è già associato all’articolo «' + altro.nome + '».');
    });
  }

  /* ---------- rotte ---------- */

  var rotte = [];
  function rotta(metodo, schema, fn) {
    var nomi = [];
    var re = new RegExp('^' + schema.replace(/:([a-zA-Z]+)/g, function (_, n) { nomi.push(n); return '([^/]+)'; }) + '$');
    rotte.push({ metodo: metodo, re: re, nomi: nomi, fn: fn });
  }
  function stato() {
    return { inizializzato: true, daServer: false, struttura: S.impostazioni.struttura, sottotitolo: S.impostazioni.sottotitolo, logo: S.impostazioni.logo,
      versione: VERSIONE, utente: sessione ? copia(sessione) : null, permessi: permessi(sessione) };
  }

  rotta('GET', '/api/stato', function () { return stato(); });
  rotta('POST', '/api/login', function (c) {
    var u = UTENTI.filter(function (x) { return x.username === String(c.username || '').trim().toLowerCase(); })[0];
    if (!u || String(c.password || '') !== PASSWORD) {
      evento('accesso.fallito', u ? { utente: u.username, motivo: 'password sbagliata' } : { motivo: 'utente inesistente' }, u ? u.username : '');
      no(401, 'Nome utente o password non giusti. Nell’anteprima la password è “' + PASSWORD + '”.');
    }
    if (!u.attivo) {
      evento('accesso.fallito', { utente: u.username, motivo: 'utente disattivato' }, u.username);
      no(403, 'Questo utente è disattivato. Rivolgiti all’amministratore.');
    }
    sessione = u;
    u.ultimoAccesso = new Date().toISOString();
    evento('accesso.entrata', {});
    return { utente: copia(u), permessi: permessi(u) };
  });
  rotta('POST', '/api/logout', function () { if (sessione) evento('accesso.uscita', {}); sessione = null; return { ok: true }; });
  rotta('POST', '/api/setup', function () { no(409, 'Il primo amministratore esiste già.'); });
  rotta('POST', '/api/password', function (c) {
    if (String(c.attuale || '') !== PASSWORD) no(400, 'La password attuale non è giusta (nell’anteprima è “' + PASSWORD + '”).');
    if (String(c.nuova || '').length < 8) no(400, 'La password deve avere almeno 8 caratteri.');
    // come sul server vero, dopo il cambio non la chiede più (anche se nell'anteprima la password resta quella)
    sessione.cambioPassword = false;
    evento('accesso.cambio-password', {});
    return { ok: true, utente: copia(sessione), nota: 'Nell’anteprima la password resta “' + PASSWORD + '”.' };
  });

  rotta('GET', '/api/dati', function (c, q) {
    var da = Number(q.get('da')) || 0;
    var completo = da <= 0 || da > rev || (q.get('storia') !== null && q.get('storia') !== storia);
    function filtro(tabella) {
      return S[tabella].filter(function (x) { return completo || (revRiga[tabella + '|' + x.id] || 0) > da; }).map(copia);
    }
    var out = { rev: rev, storia: storia, completo: completo, reparti: filtro('reparti'), articoli: filtro('articoli'), movimenti: filtro('movimenti'),
      cancellati: completo ? [] : cancellati.filter(function (x) { return x.rev > da; }).map(function (x) { return { tabella: x.tabella, id: x.id }; }) };
    if (completo || (revRiga['impostazioni|tutte'] || 0) > da) out.impostazioni = copia(S.impostazioni);
    return out;
  });

  rotta('POST', '/api/movimenti', function (c, q, p) { return registraMovimenti(p, c.movimenti); });
  rotta('POST', '/api/movimenti/:id/annulla', function (c, q, p, par) {
    var m = S.movimenti.filter(function (x) { return x.id === par.id; })[0];
    if (!m) no(404, 'Movimento non trovato.');
    if (m.annullato) no(409, 'Il movimento è già stato annullato.');
    var proprio = (m.tipo === 'consumo' || m.tipo === 'perdita') && m.utenteId === sessione.id && p[m.tipo] && puoReparto(p, m.repartoId);
    if (!p.annullaTutti && !proprio) no(403, 'Puoi annullare solo i consumi e le perdite che hai registrato tu nei tuoi reparti.');
    var motivo = testo(c.motivo, 300, 'motivo') || 'Annullato';
    scrivi(function (r) {
      m.annullato = { il: new Date().toISOString(), da: sessione.nome, motivo: motivo };
      tocca('movimenti', m.id, r);
    });
    evento('movimenti.annulla', { tipo: m.tipo, data: m.data, articolo: (articolo(m.articoloId) || {}).nome || m.articoloId, quantita: m.quantita, reparto: m.repartoId, motivo: motivo, registratoDa: m.operatore });
    return { rev: rev };
  });
  rotta('POST', '/api/consumo-giorno', function (c, q, p) {
    richiedi(p, 'registro');
    var base = normalizza(p, { tipo: 'consumo', data: c.data, articoloId: c.articoloId, repartoId: c.repartoId, quantita: 1 });
    var quantita = numero(c.quantita, 'quantità', { min: 0 });
    // il valore che il client vedeva: se nel frattempo altri hanno registrato consumi per quel giorno, non li cancello
    var primaClient = mancante(c.prima) ? null : numero(c.prima, 'valore precedente', { min: 0 });
    var esistenti = S.movimenti.filter(function (m) { return !m.annullato && m.tipo === 'consumo' && m.articoloId === base.articoloId && m.repartoId === base.repartoId && m.data === base.data; });
    var prima = esistenti.reduce(function (t, m) { return r3(t + m.quantita); }, 0);
    if (primaClient !== null && primaClient !== prima) {
      no(409, 'Nel frattempo un altro utente ha registrato consumi di ' + base._articolo.nome + ' per quel giorno (ora ' + prima + '): ho aggiornato il registro, controlla e correggi di nuovo se serve.');
    }
    scrivi(function (r) {
      esistenti.forEach(function (m) { m.annullato = { il: new Date().toISOString(), da: sessione.nome, motivo: 'Corretto dal registro mensile' }; tocca('movimenti', m.id, r); });
      if (quantita > 0) {
        var nuovo = Object.assign({}, base, { quantita: quantita, note: 'Dal registro mensile' });
        C.allocaUscita(S, nuovo.articoloId, nuovo.repartoId, nuovo.data, quantita, '').forEach(function (parte) { inserisci(Object.assign({}, nuovo, parte), r); });
      }
    });
    evento('registro.consumo-giorno', { articolo: base._articolo.nome, reparto: base.repartoId, data: base.data, prima: prima, dopo: quantita });
    return { rev: rev };
  });

  rotta('POST', '/api/articoli', function (c, q, p) {
    richiedi(p, 'articoli');
    var a = validaArticolo(c);
    controllaNome(a.nome);
    if (a.barcode === undefined) a.barcode = [];
    if (a.pezziConfezione === undefined) a.pezziConfezione = 1;
    controllaCodici(a.barcode);
    a.id = id('a');
    a.versione = 1;
    scrivi(function (r) { S.articoli.push(a); tocca('articoli', a.id, r); });
    evento('articoli.crea', { articolo: a.nome, categoria: a.categoria, barcode: a.barcode.length ? a.barcode : undefined });
    return { rev: rev, articolo: copia(a) };
  });
  rotta('POST', '/api/articoli/importa', function (c, q, p) {
    richiedi(p, 'articoli');
    var lista = Array.isArray(c.articoli) ? c.articoli : [];
    if (!lista.length) no(400, 'Nessun articolo da importare.');
    if (lista.length > 5000) no(400, 'Troppi articoli in un solo file (massimo 5000).');
    var conGiacenza = !!c.conGiacenza;
    var rep = null;
    if (conGiacenza) {
      richiedi(p, 'carico');
      controllaData(c.data);
      rep = reparto(String(c.repartoId || ''));
      if (!rep || !rep.attivo) no(400, 'Reparto per la giacenza iniziale non valido.');
    }
    var origine = testo(c.origine, 200, 'origine');
    // prima si controlla tutto, poi si scrive
    var validi = lista.map(function (x) {
      var v = validaArticolo({ nome: x.nome, categoria: x.categoria, prezzo: x.prezzo, scortaMinima: x.scortaMinima, unita: x.unita });
      v.giacenza = numero(x.giacenza, 'giacenza', { facoltativo: true });
      return v;
    });
    var nuovi = 0, carichi = 0, saltati = 0;
    scrivi(function (r) {
      validi.forEach(function (v) {
        var a = S.articoli.filter(function (y) { return y.nome.toLowerCase() === v.nome.toLowerCase(); })[0];
        var esisteva = !!a;
        var giacenza = v.giacenza;
        delete v.giacenza;
        if (!a) { a = Object.assign(v, { id: id('a'), versione: 1, barcode: [], pezziConfezione: 1 }); S.articoli.push(a); tocca('articoli', a.id, r); nuovi++; }
        if (conGiacenza && giacenza > 0) {
          var mosso = esisteva && S.movimenti.some(function (m) { return !m.annullato && m.articoloId === a.id && (m.repartoId === rep.id || m.repartoDestId === rep.id); });
          if (mosso) { saltati++; return; }
          inserisci({ tipo: 'carico', data: c.data, articoloId: a.id, repartoId: rep.id, quantita: giacenza, note: 'Giacenza iniziale importata' + (origine ? ' da ' + origine : '') }, r);
          carichi++;
        }
      });
    });
    evento('articoli.importa', { origine: origine, righe: validi.length, nuovi: nuovi, carichi: carichi, saltati: saltati, reparto: rep ? rep.id : undefined });
    return { rev: rev, nuovi: nuovi, carichi: carichi, saltati: saltati };
  });
  rotta('PUT', '/api/articoli/:id', function (c, q, p, par) {
    richiedi(p, 'articoli');
    var a = articolo(par.id);
    if (!a) no(404, 'Articolo non trovato.');
    if (Number(c.versione) !== a.versione) no(409, 'Un altro utente ha modificato questo articolo nel frattempo: ricarico i dati, controlla e riprova.');
    var v = validaArticolo(c);
    controllaNome(v.nome, a.id);
    // chi non manda codici a barre e pezzi per confezione non li cancella (come il server vero)
    if (v.barcode === undefined) v.barcode = (a.barcode || []).slice();
    if (v.pezziConfezione === undefined) v.pezziConfezione = a.pezziConfezione;
    controllaCodici(v.barcode, a.id);
    var cambi = {};
    Object.keys(v).forEach(function (k) { if (JSON.stringify(v[k]) !== JSON.stringify(a[k])) cambi[k] = { prima: a[k], dopo: v[k] }; });
    var nomePrima = a.nome;
    scrivi(function (r) { Object.assign(a, v); a.versione++; tocca('articoli', a.id, r); });
    evento('articoli.modifica', { articolo: nomePrima, cambi: cambi });
    return { rev: rev, articolo: copia(a) };
  });
  rotta('POST', '/api/articoli/:id/barcode', function (c, q, p, par) {
    richiedi(p, 'articoli');
    var a = articolo(par.id);
    if (!a) no(404, 'Articolo non trovato.');
    var k = B().normalizzaChiave(c.chiave);
    if (!k) no(400, 'Codice a barre non valido.');
    // idempotente: il codice è già suo, nessuna scrittura
    if ((a.barcode || []).indexOf(k) >= 0) return { rev: rev, articolo: copia(a) };
    if ((a.barcode || []).length >= MAX_CODICI) no(400, 'Troppi codici a barre per un articolo (massimo ' + MAX_CODICI + ').');
    controllaCodici([k], a.id);
    scrivi(function (r) { a.barcode = (a.barcode || []).concat([k]); a.versione++; tocca('articoli', a.id, r); });
    evento('articoli.barcode', { articolo: a.nome, chiave: k });
    return { rev: rev, articolo: copia(a) };
  });
  rotta('DELETE', '/api/articoli/:id', function (c, q, p, par) {
    richiedi(p, 'articoli');
    var a = articolo(par.id);
    if (!a) no(404, 'Articolo non trovato.');
    if (S.movimenti.some(function (m) { return m.articoloId === a.id; })) no(409, 'L’articolo ha dei movimenti: non si può eliminare. Togli la spunta “Articolo attivo” per nasconderlo.');
    scrivi(function (r) { S.articoli = S.articoli.filter(function (x) { return x !== a; }); cancellati.push({ tabella: 'articoli', id: a.id, rev: r }); });
    evento('articoli.elimina', { articolo: a.nome });
    return { rev: rev };
  });

  rotta('PUT', '/api/impostazioni', function (c, q, p) {
    richiedi(p, 'impostazioni');
    var prima = copia(S.impostazioni);
    var nuove = {};
    [['struttura', 100], ['sottotitolo', 100], ['societa', 100], ['citta', 100], ['codiceModulo', 60]].forEach(function (x) {
      if (c[x[0]] !== undefined) nuove[x[0]] = testo(c[x[0]], x[1], x[0]);
    });
    if (nuove.struttura === '') nuove.struttura = 'Clinica Posillipo';
    if (c.giorniAvvisoScadenza !== undefined) nuove.giorniAvvisoScadenza = Math.min(3650, Math.round(numero(c.giorniAvvisoScadenza, 'giorni di avviso', { min: 1, facoltativo: true, predefinito: 90 })) || 90);
    if (c.logo !== undefined) {
      var logo = String(c.logo || '');
      if (logo && !/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) no(400, 'Il logo deve essere un’immagine PNG, JPEG, GIF, WebP o SVG.');
      if (logo.length > 600000) no(400, 'Il logo è troppo grande: usa un’immagine sotto i 400 KB.');
      nuove.logo = logo;
    }
    scrivi(function (r) { Object.assign(S.impostazioni, nuove); tocca('impostazioni', 'tutte', r); });
    var cambi = {};
    Object.keys(nuove).forEach(function (k) { if (prima[k] !== nuove[k]) cambi[k] = k === 'logo' ? '(immagine)' : { prima: prima[k], dopo: nuove[k] }; });
    evento('impostazioni.modifica', cambi);
    return { rev: rev, impostazioni: copia(S.impostazioni) };
  });
  rotta('PUT', '/api/reparti', function (c, q, p) {
    richiedi(p, 'impostazioni');
    var lista = Array.isArray(c.reparti) ? c.reparti : [];
    if (!lista.length) no(400, 'Elenco dei reparti vuoto.');
    if (lista.length > 200) no(400, 'Troppi reparti.');
    // prima si controlla tutto (come il server vero), poi si scrive
    var nomi = {};
    var centraleVisto = false;
    var norm = lista.map(function (x) {
      var nome = testo(x && x.nome, 80, 'nome del reparto');
      if (!nome) no(400, 'Ogni reparto deve avere un nome.');
      if (nomi[nome.toLowerCase()]) no(400, 'Due reparti hanno lo stesso nome: ' + nome + '.');
      nomi[nome.toLowerCase()] = true;
      if (x.id && !reparto(String(x.id))) no(400, 'Reparto non trovato: aggiorna la pagina.');
      var centrale = !!x.centrale && !centraleVisto;
      if (centrale) centraleVisto = true;
      return { id: x.id ? String(x.id) : id('r'), nome: nome, centrale: centrale, attivo: x.attivo !== false, nuovo: !x.id };
    });
    if (!norm.some(function (x) { return x.attivo; })) no(400, 'Deve restare almeno un reparto attivo.');
    scrivi(function (r) {
      var ordinati = [];
      norm.forEach(function (x) {
        var rep = x.nuovo ? { id: x.id } : reparto(x.id);
        rep.nome = x.nome;
        rep.centrale = x.centrale;
        rep.attivo = x.attivo;
        ordinati.push(rep);
        tocca('reparti', rep.id, r);
      });
      // l'ordine è quello dell'elenco mandato (i reparti non elencati restano in fondo)
      S.reparti = ordinati.concat(S.reparti.filter(function (x) { return ordinati.indexOf(x) < 0; }));
    });
    evento('reparti.modifica', { reparti: norm.map(function (x) { return { id: x.id, nome: x.nome, centrale: x.centrale, attivo: x.attivo, nuovo: x.nuovo }; }) });
    return { rev: rev, reparti: copia(S.reparti) };
  });
  rotta('DELETE', '/api/reparti/:id', function (c, q, p, par) {
    richiedi(p, 'impostazioni');
    var rep = reparto(par.id);
    if (!rep) no(404, 'Reparto non trovato.');
    if (S.movimenti.some(function (m) { return m.repartoId === rep.id || m.repartoDestId === rep.id; })) no(409, 'Il reparto ha dei movimenti: non si può eliminare. Togli la spunta “Attivo” per nasconderlo.');
    if (S.reparti.length <= 1) no(400, 'Deve restare almeno un reparto.');
    scrivi(function (r) { S.reparti = S.reparti.filter(function (x) { return x !== rep; }); cancellati.push({ tabella: 'reparti', id: rep.id, rev: r }); });
    // gli utenti di reparto non restano legati a un reparto che non c'è più
    UTENTI.forEach(function (u) { u.reparti = u.reparti.filter(function (x) { return x !== rep.id; }); });
    evento('reparti.elimina', { reparto: rep.nome });
    return { rev: rev };
  });

  // come validaUtente di server/accessi.js
  function validaUtente(c, nuovo) {
    var out = {};
    if (nuovo) {
      out.username = String(c.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(out.username)) no(400, 'Il nome utente deve avere da 3 a 40 caratteri: lettere, numeri, punto, trattino.');
    }
    out.nome = String(c.nome || '').trim();
    if (!out.nome || out.nome.length > 100) no(400, 'Scrivi nome e cognome.');
    if (!RUOLI[c.ruolo]) no(400, 'Ruolo non valido.');
    out.ruolo = c.ruolo;
    var lista = Array.isArray(c.reparti) ? c.reparti.map(String) : [];
    lista = lista.filter(function (x, i) { return !!reparto(x) && lista.indexOf(x) === i; });
    if (out.ruolo === 'reparto' && !lista.length) no(400, 'Un utente di reparto deve avere almeno un reparto.');
    out.reparti = out.ruolo === 'reparto' ? lista : [];
    return out;
  }
  rotta('GET', '/api/utenti', function (c, q, p) {
    richiedi(p, 'utenti');
    return { utenti: copia(UTENTI).sort(function (a, b) { return a.nome.toLowerCase() < b.nome.toLowerCase() ? -1 : a.nome.toLowerCase() > b.nome.toLowerCase() ? 1 : 0; }) };
  });
  rotta('POST', '/api/utenti', function (c, q, p) {
    richiedi(p, 'utenti');
    var v = validaUtente(c, true);
    if (typeof c.password !== 'string' || c.password.length < 8) no(400, 'La password deve avere almeno 8 caratteri.');
    if (UTENTI.some(function (u) { return u.username === v.username; })) no(409, 'Esiste già un utente con questo nome.');
    var u = { id: id('u'), username: v.username, nome: v.nome, ruolo: v.ruolo, reparti: v.reparti, attivo: true, cambioPassword: true, ultimoAccesso: null, bloccato: false };
    UTENTI.push(u);
    evento('utenti.crea', { utente: v.username, nome: v.nome, ruolo: v.ruolo, reparti: v.reparti });
    return { utente: copia(u), nota: 'Nell’anteprima tutti gli utenti entrano con la password “' + PASSWORD + '”.' };
  });
  rotta('PUT', '/api/utenti/:id', function (c, q, p, par) {
    richiedi(p, 'utenti');
    var u = UTENTI.filter(function (x) { return x.id === par.id; })[0];
    if (!u) no(404, 'Utente non trovato.');
    var v = validaUtente(c, false);
    var attivo = c.attivo === undefined ? u.attivo : !!c.attivo;
    var adminAttivi = UTENTI.filter(function (x) { return x.ruolo === 'amministratore' && x.attivo && x.id !== u.id; }).length;
    if (u.ruolo === 'amministratore' && u.attivo && !(v.ruolo === 'amministratore' && attivo) && !adminAttivi) no(400, 'Deve restare almeno un amministratore attivo.');
    var prima = { nome: u.nome, ruolo: u.ruolo, reparti: u.reparti.slice(), attivo: u.attivo };
    u.nome = v.nome;
    u.ruolo = v.ruolo;
    u.reparti = v.reparti;
    u.attivo = attivo;
    evento('utenti.modifica', { utente: u.username, prima: prima, dopo: { nome: v.nome, ruolo: v.ruolo, reparti: v.reparti, attivo: attivo } });
    return { utente: copia(u) };
  });
  rotta('POST', '/api/utenti/:id/password', function (c, q, p, par) {
    richiedi(p, 'utenti');
    var u = UTENTI.filter(function (x) { return x.id === par.id; })[0];
    if (!u) no(404, 'Utente non trovato.');
    if (typeof c.nuova !== 'string' || c.nuova.length < 8) no(400, 'La password deve avere almeno 8 caratteri.');
    evento('utenti.nuova-password', { utente: u.username });
    return { ok: true, nota: 'Nell’anteprima la password resta “' + PASSWORD + '”.' };
  });
  // filtri come il server vero: dal e al sono giorni (AAAA-MM-GG, "al" compreso), utente esatto, azione per inizio
  rotta('GET', '/api/attivita', function (c, q, p) {
    richiedi(p, 'attivita');
    function giorno(t, dopo) {
      if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return t || '';
      var d = new Date(t + 'T00:00:00');
      if (dopo) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
    var dal = giorno(q.get('dal'), false), al = giorno(q.get('al'), true);
    var utente = String(q.get('utente') || '').toLowerCase(), azione = String(q.get('azione') || '');
    var limite = Math.min(Math.max(Math.floor(Number(q.get('limite'))) || 500, 1), 5000);
    return { eventi: copia(eventi.filter(function (e) {
      return (!dal || e.quando >= dal) && (!al || e.quando < al) && (!utente || String(e.username).toLowerCase() === utente) && (!azione || e.azione.indexOf(azione) === 0);
    }).slice(0, limite)) };
  });

  function nomeCopia(tipo) {
    var d = new Date();
    function due(n) { return String(n).padStart(2, '0'); }
    return 'farmacia_' + d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate()) + '_' + due(d.getHours()) + due(d.getMinutes()) + due(d.getSeconds()) + '_' + tipo + '.db';
  }
  function creaCopia(tipo) {
    var c = { nome: nomeCopia(tipo), data: new Date().toISOString(), tipo: tipo, dimensione: JSON.stringify(S).length, dati: copia(S) };
    copie.unshift(c);
    return c;
  }
  creaCopia('auto');
  rotta('GET', '/api/backup', function (c, q, p) {
    richiedi(p, 'backup');
    return { backup: copie.map(function (x) { return { nome: x.nome, data: x.data, tipo: x.tipo, dimensione: x.dimensione }; }), cartella: 'C:\\GestionaleFarmacia\\dati\\backup (anteprima)' };
  });
  rotta('POST', '/api/backup', function (c, q, p) {
    richiedi(p, 'backup');
    var x = creaCopia('manuale');
    evento('backup.crea', { copia: x.nome });
    return { nome: x.nome, backup: copie.map(function (y) { return { nome: y.nome, data: y.data, tipo: y.tipo, dimensione: y.dimensione }; }) };
  });
  rotta('POST', '/api/backup/:nome/ripristina', function (c, q, p, par) {
    richiedi(p, 'backup');
    var x = copie.filter(function (y) { return y.nome === par.nome; })[0];
    if (!x) no(404, 'Copia non trovata.');
    var sicurezza = creaCopia('prima-del-ripristino');
    S = copia(x.dati);
    storia = Math.random().toString(16).slice(2);
    scrivi(function () {});
    evento('backup.ripristina', { copia: x.nome, copiaDiSicurezza: sicurezza.nome });
    return { rev: rev, sicurezza: sicurezza.nome };
  });
  rotta('POST', '/api/demo', function () { no(409, 'I dati di prova si possono caricare solo in un archivio vuoto (l’anteprima li ha già).'); });
  rotta('POST', '/api/importa-archivio', function () { no(409, 'Nell’anteprima l’archivio non è vuoto: l’importazione si prova sul programma installato.'); });

  var ROTTE_PUBBLICHE = { '/api/stato': 1, '/api/login': 1, '/api/logout': 1, '/api/setup': 1 };

  function gestisci(metodo, percorso, query, corpo) {
    var par = {};
    var r = null;
    for (var i = 0; i < rotte.length && !r; i++) {
      var m = rotte[i].re.exec(percorso);
      if (m && rotte[i].metodo === metodo) {
        r = rotte[i];
        rotte[i].nomi.forEach(function (n, k) { par[n] = decodeURIComponent(m[k + 1]); });
      }
    }
    if (!r) return { stato: 404, json: { errore: 'Indirizzo non trovato.' } };
    if (!ROTTE_PUBBLICHE[percorso] && !sessione) return { stato: 401, json: { errore: 'Sessione scaduta: accedi di nuovo.' } };
    try {
      var risultato = r.fn(corpo || {}, query, permessi(sessione), par);
      return { stato: 200, json: risultato };
    } catch (e) {
      if (e instanceof Errore) return { stato: e.stato, json: { errore: e.message } };
      console.error(e);
      return { stato: 500, json: { errore: 'Errore interno dell’anteprima: ' + e.message } };
    }
  }

  /* ---------- fetch ed EventSource ---------- */

  // solo gli indirizzi "api/…" relativi alla pagina (js/api.js li scrive così): la pagina pubblicata può stare in una
  // cartella il cui percorso contiene già "/api/", e i suoi file (videoguide, copertine) non devono finire qui
  function percorsoApi(indirizzo) {
    var url = new URL(String(indirizzo), location.href);
    var base = location.pathname.replace(/[^/]*$/, '');
    if (url.origin !== location.origin || url.pathname.indexOf(base + 'api/') !== 0) return null;
    return { percorso: '/' + url.pathname.slice(base.length), query: url.searchParams };
  }

  var fetchVero = root.fetch.bind(root);
  root.fetch = function (input, init) {
    var indirizzo = input && typeof input === 'object' && 'url' in input ? input.url : String(input);
    var api = percorsoApi(indirizzo);
    if (!api) return fetchVero(input, init);
    var metodo = ((init && init.method) || 'GET').toUpperCase();
    var corpo = null;
    try { corpo = init && init.body ? JSON.parse(init.body) : null; } catch (e) { corpo = null; }
    var esito = gestisci(metodo, api.percorso, api.query, corpo);
    // piccola attesa, come in rete
    return new Promise(function (ok) {
      setTimeout(function () {
        ok(new Response(JSON.stringify(esito.json), { status: esito.stato, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
      }, 60);
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
  SorgenteFinta.prototype._evento = function (tipo, dati) {
    if (this.readyState === 2) return;
    var e = { type: tipo, data: dati === null ? '' : JSON.stringify(dati) };
    (this._asc[tipo] || []).forEach(function (fn) { try { fn(e); } catch (x) { console.error(x); } });
  };
  SorgenteFinta.CONNECTING = 0;
  SorgenteFinta.OPEN = 1;
  SorgenteFinta.CLOSED = 2;
  var EventSourceVero = root.EventSource;
  root.EventSource = function (indirizzo, opz) {
    var api = percorsoApi(indirizzo);
    if (api && api.percorso === '/api/eventi') return new SorgenteFinta(indirizzo);
    return new EventSourceVero(indirizzo, opz);
  };

  /* ---------- un collega che lavora (per vedere gli aggiornamenti in tempo reale) ---------- */

  // nella pagina pubblicata la fotocamera non è permessa: niente pulsante "Fotocamera" (nel programma vero c'è)
  try { root.BarcodeDetector = undefined; } catch (e) { /* proprietà non scrivibile: resta com'è */ }

  root.Anteprima = {
    PASSWORD: PASSWORD,
    UTENTI: UTENTI.map(function (u) { return { username: u.username, nome: u.nome, ruolo: u.ruolo }; }),
    collega: function () {
      var luca = UTENTI.filter(function (u) { return u.username === 'reparto'; })[0];
      var conGiacenza = S.articoli.filter(function (a) { return C.giacenza(S, a.id, 'r-degenza') >= 1; });
      if (!conGiacenza.length) return null;
      var a = conGiacenza[Math.floor(Math.random() * conGiacenza.length)];
      var prima = sessione;
      sessione = luca;
      try {
        registraMovimenti(permessi(luca), [{ tipo: 'consumo', data: oggi(), articoloId: a.id, repartoId: 'r-degenza', quantita: 1 }]);
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
