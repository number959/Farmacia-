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
    var codici = { 'demo-f0': ['aic:012745093'], 'demo-f3': ['gtin:08001234567893'], 'demo-p1': ['gtin:04015630982912'] };
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
  function evento(azione, dettagli) {
    eventi.unshift({ id: eventi.length + 1, quando: new Date().toISOString(), username: sessione ? sessione.username : '', azione: azione, dettagli: dettagli || {}, ip: 'anteprima' });
  }
  function articolo(idA) { return S.articoli.filter(function (a) { return a.id === idA; })[0]; }
  function reparto(idR) { return S.reparti.filter(function (r) { return r.id === idR; })[0]; }
  function r3(x) { return C.r3(x); }

  /* ---------- movimenti ---------- */

  var PERM_TIPO = { carico: 'carico', consumo: 'consumo', trasferimento: 'trasferimento', perdita: 'perdita', rettifica: 'rettifica' };

  function normalizza(p, m) {
    if (!m || !PERM_TIPO[m.tipo]) no(400, 'Tipo di movimento non valido.');
    richiedi(p, PERM_TIPO[m.tipo]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.data || '')) no(400, 'Data non valida.');
    if (m.data > oggi(1)) no(400, 'Non si possono registrare movimenti con una data futura (' + m.data + ').');
    var a = articolo(m.articoloId);
    if (!a) no(400, 'Articolo non trovato: aggiorna la pagina.');
    var r = reparto(m.repartoId);
    if (!r) no(400, 'Reparto non trovato: aggiorna la pagina.');
    if (!r.attivo) no(400, 'Il reparto ' + r.nome + ' non è attivo.');
    if (!puoReparto(p, r.id)) no(403, 'Non puoi registrare movimenti per il reparto ' + r.nome + '.');
    var q = r3(Number(m.quantita));
    if (m.tipo === 'rettifica' ? !q : !(q > 0)) no(400, 'La quantità deve essere maggiore di zero (' + a.nome + ').');
    var out = { tipo: m.tipo, data: m.data, articoloId: a.id, repartoId: r.id, quantita: q, lotto: String(m.lotto || '').trim(),
      scadenza: m.scadenza || '', fornitore: m.fornitore || '', documento: m.documento || '', causale: m.causale || '', note: m.note || '' };
    if (m.tipo === 'trasferimento') {
      var d = reparto(m.repartoDestId);
      if (!d || !d.attivo || d.id === r.id) no(400, 'Reparto di arrivo non valido.');
      out.repartoDestId = d.id;
    }
    if (m.tipo === 'carico' && m.prezzo !== undefined && m.prezzo !== null && m.prezzo !== '') out.prezzo = Number(m.prezzo);
    if (m.tipo === 'rettifica' && m.teorica !== undefined && m.teorica !== null) out.teorica = r3(m.teorica);
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

  function ripartisci(m) {
    if (m.lotto && C.disponibilitaLotto(S, m.articoloId, m.repartoId, m.data, m.lotto) <= 0) {
      no(409, 'Il lotto ' + m.lotto + ' di ' + m._articolo.nome + ' non è più disponibile in ' + m._reparto.nome + ' alla data indicata: aggiorna e scegli di nuovo il lotto.');
    }
    return C.allocaUscita(S, m.articoloId, m.repartoId, m.data, m.quantita, m.lotto);
  }

  function registraMovimenti(p, lista) {
    if (!Array.isArray(lista) || !lista.length) no(400, 'Nessun movimento da registrare.');
    if (lista.length > 500) no(400, 'Troppi movimenti in una volta sola (massimo 500).');
    var norm = lista.map(function (m) { return normalizza(p, m); });
    var cambiati = norm.filter(function (m) { return m.tipo === 'rettifica' && m.teorica !== undefined && r3(C.giacenza(S, m.articoloId, m.repartoId, m.data)) !== m.teorica; });
    if (cambiati.length) no(409, 'Mentre contavi, altri movimenti hanno cambiato la giacenza di: ' + cambiati.map(function (m) { return m._articolo.nome; }).join(', ') + '. Ho aggiornato le giacenze: controlla e registra di nuovo.');
    // tutto o niente: controllo i lotti prima di scrivere
    var piano = norm.map(function (m) { return ['consumo', 'perdita', 'trasferimento'].indexOf(m.tipo) >= 0 ? ripartisci(m) : null; });
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
    evento('movimenti.registra', { movimenti: norm.map(function (m) { return { tipo: m.tipo, data: m.data, articolo: m._articolo.nome, reparto: m.repartoId, quantita: m.quantita }; }) });
    return { rev: rev, movimenti: creati };
  }

  /* ---------- articoli ---------- */

  function validaArticolo(d) {
    var nome = String((d && d.nome) || '').trim();
    if (!nome) no(400, 'Scrivi la denominazione.');
    if (['FARMACI', 'PRESIDI'].indexOf(d.categoria) < 0) no(400, 'Categoria non valida.');
    var pezzi = Number(d.pezziConfezione);
    return {
      nome: nome, categoria: d.categoria, unita: d.unita || '', principio: d.principio || '', confezione: d.confezione || '',
      codice: d.codice || '', prezzo: Number(d.prezzo) || 0, scortaMinima: Number(d.scortaMinima) || 0, note: d.note || '',
      attivo: d.attivo !== false, barcode: Array.isArray(d.barcode) ? d.barcode.filter(function (k) { return /^(aic|gtin|cod):/.test(k); }) : [],
      pezziConfezione: pezzi > 0 ? pezzi : 1
    };
  }
  function controllaNome(nome, tranne) {
    var doppio = S.articoli.filter(function (a) { return a.nome.toLowerCase() === nome.toLowerCase() && a.id !== tranne; })[0];
    if (doppio) no(409, 'Esiste già un articolo con questo nome.');
  }
  function controllaCodici(codici, tranne) {
    codici.forEach(function (k) {
      var altro = S.articoli.filter(function (a) { return a.id !== tranne && (a.barcode || []).indexOf(k) >= 0; })[0];
      if (altro) no(409, 'Il codice a barre è già associato a ' + altro.nome + '.');
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
      evento('accesso.fallito', u ? { utente: u.username } : {});
      no(401, 'Nome utente o password non giusti. Nell’anteprima la password è “' + PASSWORD + '”.');
    }
    if (!u.attivo) no(403, 'Questo utente è disattivato. Rivolgiti all’amministratore.');
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
    var proprio = (m.tipo === 'consumo' || m.tipo === 'perdita') && m.utenteId === sessione.id && puoReparto(p, m.repartoId);
    if (!p.annullaTutti && !proprio) no(403, 'Puoi annullare solo i consumi e le perdite che hai registrato tu nei tuoi reparti.');
    scrivi(function (r) {
      m.annullato = { il: new Date().toISOString(), da: sessione.nome, motivo: String(c.motivo || 'Annullato') };
      tocca('movimenti', m.id, r);
    });
    evento('movimenti.annulla', { tipo: m.tipo, articolo: (articolo(m.articoloId) || {}).nome, quantita: m.quantita, motivo: c.motivo });
    return { rev: rev };
  });
  rotta('POST', '/api/consumo-giorno', function (c, q, p) {
    richiedi(p, 'registro');
    var base = normalizza(p, { tipo: 'consumo', data: c.data, articoloId: c.articoloId, repartoId: c.repartoId, quantita: 1 });
    var esistenti = S.movimenti.filter(function (m) { return !m.annullato && m.tipo === 'consumo' && m.articoloId === base.articoloId && m.repartoId === base.repartoId && m.data === base.data; });
    var prima = esistenti.reduce(function (t, m) { return r3(t + m.quantita); }, 0);
    if (c.prima !== undefined && c.prima !== null && r3(c.prima) !== prima) {
      no(409, 'Nel frattempo un altro utente ha registrato consumi di ' + base._articolo.nome + ' per quel giorno (ora ' + prima + '): ho aggiornato il registro, controlla e correggi di nuovo se serve.');
    }
    var quantita = r3(c.quantita);
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
    controllaCodici(a.barcode);
    a.id = id('a');
    a.versione = 1;
    scrivi(function (r) { S.articoli.push(a); tocca('articoli', a.id, r); });
    evento('articoli.crea', { articolo: a.nome, categoria: a.categoria });
    return { rev: rev, articolo: copia(a) };
  });
  rotta('POST', '/api/articoli/importa', function (c, q, p) {
    richiedi(p, 'articoli');
    var lista = Array.isArray(c.articoli) ? c.articoli : [];
    if (!lista.length) no(400, 'Nessun articolo da importare.');
    var nuovi = 0, carichi = 0, saltati = 0;
    scrivi(function (r) {
      lista.forEach(function (x) {
        var v = validaArticolo({ nome: x.nome, categoria: x.categoria, prezzo: x.prezzo, scortaMinima: x.scortaMinima, unita: x.unita });
        var a = S.articoli.filter(function (y) { return y.nome.toLowerCase() === v.nome.toLowerCase(); })[0];
        var esisteva = !!a;
        if (!a) { a = Object.assign(v, { id: id('a'), versione: 1 }); S.articoli.push(a); tocca('articoli', a.id, r); nuovi++; }
        if (c.conGiacenza && Number(x.giacenza) > 0) {
          var mosso = esisteva && S.movimenti.some(function (m) { return !m.annullato && m.articoloId === a.id && (m.repartoId === c.repartoId || m.repartoDestId === c.repartoId); });
          if (mosso) { saltati++; return; }
          inserisci({ tipo: 'carico', data: c.data, articoloId: a.id, repartoId: c.repartoId, quantita: r3(x.giacenza), note: 'Giacenza iniziale importata' }, r);
          carichi++;
        }
      });
    });
    evento('articoli.importa', { righe: lista.length, nuovi: nuovi, carichi: carichi, saltati: saltati });
    return { rev: rev, nuovi: nuovi, carichi: carichi, saltati: saltati };
  });
  rotta('PUT', '/api/articoli/:id', function (c, q, p, par) {
    richiedi(p, 'articoli');
    var a = articolo(par.id);
    if (!a) no(404, 'Articolo non trovato.');
    if (Number(c.versione) !== a.versione) no(409, 'Un altro utente ha modificato questo articolo nel frattempo: ricarico i dati, controlla e riprova.');
    var v = validaArticolo(c);
    controllaNome(v.nome, a.id);
    controllaCodici(v.barcode, a.id);
    scrivi(function (r) { Object.assign(a, v); a.versione++; tocca('articoli', a.id, r); });
    evento('articoli.modifica', { articolo: a.nome });
    return { rev: rev, articolo: copia(a) };
  });
  rotta('POST', '/api/articoli/:id/barcode', function (c, q, p, par) {
    richiedi(p, 'articoli');
    var a = articolo(par.id);
    if (!a) no(404, 'Articolo non trovato.');
    var k = String(c.chiave || '');
    if (!/^(aic:\d{9}|gtin:\d{14}|cod:[A-Z0-9 ._\-/+]{1,60})$/.test(k)) no(400, 'Codice a barre non valido.');
    controllaCodici([k], a.id);
    if ((a.barcode || []).indexOf(k) < 0) {
      scrivi(function (r) { a.barcode = (a.barcode || []).concat([k]); a.versione++; tocca('articoli', a.id, r); });
      evento('articoli.barcode', { articolo: a.nome, codice: k });
    }
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
    scrivi(function (r) {
      ['struttura', 'sottotitolo', 'societa', 'citta', 'codiceModulo'].forEach(function (k) { if (c[k] !== undefined) S.impostazioni[k] = String(c[k]).trim(); });
      if (c.giorniAvvisoScadenza !== undefined) S.impostazioni.giorniAvvisoScadenza = Math.min(3650, Math.max(1, Math.round(Number(c.giorniAvvisoScadenza)) || 90));
      if (c.logo !== undefined) S.impostazioni.logo = String(c.logo || '');
      tocca('impostazioni', 'tutte', r);
    });
    evento('impostazioni.modifica', {});
    return { rev: rev, impostazioni: copia(S.impostazioni) };
  });
  rotta('PUT', '/api/reparti', function (c, q, p) {
    richiedi(p, 'impostazioni');
    var lista = Array.isArray(c.reparti) ? c.reparti : [];
    if (!lista.length) no(400, 'Elenco dei reparti vuoto.');
    var centrale = false;
    scrivi(function (r) {
      lista.forEach(function (x) {
        var nome = String(x.nome || '').trim();
        if (!nome) no(400, 'Ogni reparto deve avere un nome.');
        var rep = x.id ? reparto(x.id) : null;
        if (!rep) { rep = { id: id('r') }; S.reparti.push(rep); }
        rep.nome = nome;
        rep.centrale = !!x.centrale && !centrale;
        if (rep.centrale) centrale = true;
        rep.attivo = x.attivo !== false;
        tocca('reparti', rep.id, r);
      });
    });
    evento('reparti.modifica', { reparti: lista.map(function (x) { return { nome: x.nome, nuovo: !x.id }; }) });
    return { rev: rev, reparti: copia(S.reparti) };
  });
  rotta('DELETE', '/api/reparti/:id', function (c, q, p, par) {
    richiedi(p, 'impostazioni');
    var rep = reparto(par.id);
    if (!rep) no(404, 'Reparto non trovato.');
    if (S.movimenti.some(function (m) { return m.repartoId === rep.id || m.repartoDestId === rep.id; })) no(409, 'Il reparto ha dei movimenti: non si può eliminare. Togli la spunta “Attivo” per nasconderlo.');
    scrivi(function (r) { S.reparti = S.reparti.filter(function (x) { return x !== rep; }); cancellati.push({ tabella: 'reparti', id: rep.id, rev: r }); });
    return { rev: rev };
  });

  rotta('GET', '/api/utenti', function (c, q, p) { richiedi(p, 'utenti'); return { utenti: copia(UTENTI) }; });
  rotta('POST', '/api/utenti', function (c, q, p) {
    richiedi(p, 'utenti');
    var username = String(c.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) no(400, 'Il nome utente deve avere da 3 a 40 caratteri: lettere, numeri, punto, trattino.');
    if (UTENTI.some(function (u) { return u.username === username; })) no(409, 'Esiste già un utente con questo nome.');
    if (!RUOLI[c.ruolo]) no(400, 'Ruolo non valido.');
    if (c.ruolo === 'reparto' && !(c.reparti || []).length) no(400, 'Un utente di reparto deve avere almeno un reparto.');
    var u = { id: id('u'), username: username, nome: String(c.nome || username), ruolo: c.ruolo, reparti: c.ruolo === 'reparto' ? c.reparti : [], attivo: true, cambioPassword: true, ultimoAccesso: null, bloccato: false };
    UTENTI.push(u);
    evento('utenti.crea', { utente: username, ruolo: c.ruolo });
    return { utente: copia(u), nota: 'Nell’anteprima tutti gli utenti entrano con la password “' + PASSWORD + '”.' };
  });
  rotta('PUT', '/api/utenti/:id', function (c, q, p, par) {
    richiedi(p, 'utenti');
    var u = UTENTI.filter(function (x) { return x.id === par.id; })[0];
    if (!u) no(404, 'Utente non trovato.');
    if (!RUOLI[c.ruolo]) no(400, 'Ruolo non valido.');
    var adminAttivi = UTENTI.filter(function (x) { return x.ruolo === 'amministratore' && x.attivo && x.id !== u.id; }).length;
    if (u.ruolo === 'amministratore' && (c.ruolo !== 'amministratore' || c.attivo === false) && !adminAttivi) no(400, 'Deve restare almeno un amministratore attivo.');
    u.nome = String(c.nome || u.nome);
    u.ruolo = c.ruolo;
    u.reparti = c.ruolo === 'reparto' ? (c.reparti || []) : [];
    if (c.attivo !== undefined) u.attivo = !!c.attivo;
    evento('utenti.modifica', { utente: u.username, ruolo: u.ruolo });
    return { utente: copia(u) };
  });
  rotta('POST', '/api/utenti/:id/password', function (c, q, p) { richiedi(p, 'utenti'); return { ok: true, nota: 'Nell’anteprima la password resta “' + PASSWORD + '”.' }; });
  rotta('GET', '/api/attivita', function (c, q, p) { richiedi(p, 'attivita'); return { eventi: copia(eventi.slice(0, Number(q.get('limite')) || 500)) }; });

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

  var fetchVero = root.fetch.bind(root);
  root.fetch = function (input, init) {
    var indirizzo = typeof input === 'string' ? input : input.url;
    var url = new URL(indirizzo, location.href);
    var i = url.pathname.indexOf('/api/');
    if (url.origin !== location.origin || i < 0) return fetchVero(input, init);
    var percorso = url.pathname.slice(i);
    var metodo = ((init && init.method) || 'GET').toUpperCase();
    var corpo = null;
    try { corpo = init && init.body ? JSON.parse(init.body) : null; } catch (e) { corpo = null; }
    var esito = gestisci(metodo, percorso, url.searchParams, corpo);
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
    if (String(indirizzo).indexOf('api/eventi') >= 0) return new SorgenteFinta(indirizzo);
    return new EventSourceVero(indirizzo, opz);
  };

  /* ---------- un collega che lavora (per vedere gli aggiornamenti in tempo reale) ---------- */

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
      { codice: '\u001d0108001234567893172812311025A01X', descrizione: 'Data Matrix (GTIN, scadenza, lotto) di ' + ((articolo('demo-f3') || {}).nome || '') },
      { codice: '4015630982912', descrizione: 'EAN-13 di ' + ((articolo('demo-p1') || {}).nome || '') }
    ]
  };
})(this);
