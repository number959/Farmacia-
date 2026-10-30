/*
 * Collegamento con il server del Gestionale Farmacia.
 * - Api.richiesta(metodo, percorso, corpo): chiamata JSON all'API (/api/...)
 * - Api.scrivi(...): come richiesta, poi risincronizza i dati
 * - Api.sincronizza(): scarica i cambiamenti dopo l'ultima revisione e li unisce in App.S
 * - aggiornamenti dagli altri utenti: Server-Sent Events (/api/eventi), con il polling come riserva
 * - indicatore di collegamento nella barra in alto
 */
(function (root) {
  'use strict';

  var App = root.App;

  var POLLING_MS = 20000;   // controllo ogni 20 secondi quando gli eventi non arrivano
  var ATTESA_SINC_MS = 400; // raccoglie più eventi ravvicinati in una sola sincronizzazione

  var Api = {
    rev: 0,                  // ultima revisione dei dati ricevuta dal server
    scrittureInCorso: 0,
    nonRaggiungibile: false
  };

  /* Percorso relativo alla pagina: funziona anche se il programma è servito sotto una sottocartella. */
  function url(percorso) { return String(percorso).replace(/^\//, ''); }
  Api.url = url;

  function erroreApi(messaggio, stato, dati) {
    var e = new Error(messaggio);
    e.stato = stato;
    e.dati = dati || null;
    return e;
  }

  function attendi(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

  function messaggioStato(stato) {
    switch (stato) {
      case 400: return 'Dati non validi.';
      case 401: return 'Sessione scaduta: accedi di nuovo.';
      case 403: return 'Il tuo utente non può fare questa operazione.';
      case 404: return 'Non trovato.';
      case 409: return 'I dati sono stati modificati da un altro utente.';
      case 413: return 'I dati inviati sono troppo grandi.';
      case 423: return 'Utente bloccato.';
      case 429: return 'Troppi tentativi: riprova tra qualche minuto.';
      default: return stato >= 500 ? 'Errore del server (' + stato + '). Riprova; se si ripete avvisa l’amministratore.' : 'Richiesta non riuscita (' + stato + ').';
    }
  }

  /* ---------- indicatore di collegamento ---------- */
  function aggiornaIndicatore() {
    var el = document.getElementById('collegamento');
    if (!el) return;
    if (Api.nonRaggiungibile) {
      el.className = 'collegamento errore';
      el.textContent = '⚠ Server non raggiungibile';
      el.title = 'Il programma riprova da solo a collegarsi. Finché il server non risponde non si può registrare niente.';
    } else if (Api.scrittureInCorso > 0) {
      el.className = 'collegamento';
      el.textContent = 'Salvataggio…';
      el.title = '';
    } else {
      el.className = 'collegamento ok';
      el.textContent = '● In linea';
      el.title = 'Collegato al server: i dati sono sempre quelli aggiornati.';
    }
  }
  Api.aggiornaIndicatore = aggiornaIndicatore;

  function segnaNonRaggiungibile() {
    if (!Api.nonRaggiungibile) {
      Api.nonRaggiungibile = true;
      aggiornaIndicatore();
    }
    // se c'è una sessione, continuo a provare finché il server torna
    if (App.utente) avviaPolling();
  }

  function segnaRaggiungibile() {
    if (!Api.nonRaggiungibile) return;
    Api.nonRaggiungibile = false;
    aggiornaIndicatore();
    if (App.utente) {
      // mentre ero scollegato altri possono aver registrato: risincronizzo e riapro gli eventi
      Api.sincronizzaPresto();
      if (!sorgente) apriSorgente();
    }
  }

  function cambiaScritture(d) {
    Api.scrittureInCorso = Math.max(0, Api.scrittureInCorso + d);
    aggiornaIndicatore();
  }

  /*
   * Chiamata all'API. Risolve con il JSON della risposta; in caso di errore rifiuta con
   * un Error che ha .stato (stato HTTP, 0 se il server non risponde) e .message (il campo "errore" del server).
   * opz.senza401: un 401 non apre la schermata di accesso (accesso, cambio password, uscita).
   * Le letture (GET) che non arrivano al server si ritentano da sole; le scritture no,
   * per non registrare due volte la stessa cosa.
   */
  Api.richiesta = function (metodo, percorso, corpo, opz) {
    metodo = String(metodo || 'GET').toUpperCase();
    opz = opz || {};
    var scrittura = metodo !== 'GET' && metodo !== 'HEAD';
    var init = { method: metodo, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (scrittura) init.headers['X-Richiesta'] = '1';
    if (corpo !== undefined || metodo === 'POST' || metodo === 'PUT') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(corpo === undefined ? {} : corpo);
    }
    var tentativi = 0;

    function prova() {
      return fetch(url(percorso), init).then(function (r) {
        return r.text().then(function (testo) { return { r: r, testo: testo }; });
      }).then(function (x) {
        segnaRaggiungibile();
        var dati = null;
        if (x.testo) { try { dati = JSON.parse(x.testo); } catch (e) { dati = null; } }
        if (x.r.ok) return dati || {};
        var messaggio = (dati && dati.errore) || messaggioStato(x.r.status);
        if (x.r.status === 401 && !opz.senza401) Api.sessioneScaduta();
        if (x.r.status === 403 && !opz.senza401) aggiornaPermessi();
        throw erroreApi(messaggio, x.r.status, dati);
      }, function () {
        // il server non ha risposto (spento, rete interrotta…)
        segnaNonRaggiungibile();
        if (!scrittura && !opz.senzaRitentativi && tentativi < 3) {
          tentativi++;
          return attendi(1000 * Math.pow(2, tentativi - 1)).then(prova);
        }
        throw erroreApi(scrittura
          ? 'Server non raggiungibile: l’operazione potrebbe non essere stata registrata. Quando torna il collegamento controlla prima di ripeterla.'
          : 'Server non raggiungibile. Il programma riprova da solo.', 0);
      });
    }

    if (scrittura) cambiaScritture(+1);
    var p = prova();
    if (scrittura) p = p.then(function (d) { cambiaScritture(-1); return d; }, function (e) { cambiaScritture(-1); throw e; });
    return p;
  };

  /*
   * 403: forse nel frattempo l'amministratore ha cambiato ruolo o reparti di questo utente.
   * Rileggo i permessi da /api/stato e, se sono cambiati, aggiorno menu e barra (il controllo vero resta sul server).
   */
  var permessiInLettura = false;
  function aggiornaPermessi() {
    if (!App.utente || permessiInLettura) return;
    permessiInLettura = true;
    Api.richiesta('GET', '/api/stato', undefined, { senza401: true, senzaRitentativi: true }).then(function (st) {
      permessiInLettura = false;
      if (!st || !st.utente || !App.utente || st.utente.id !== App.utente.id) return;
      var prima = JSON.stringify([App.utente.ruolo, App.permessi]);
      App.utente = st.utente;
      App.permessi = st.permessi || {};
      if (JSON.stringify([App.utente.ruolo, App.permessi]) !== prima && App.aggiornaUtente) App.aggiornaUtente();
    }, function () { permessiInLettura = false; });
  }

  /* Scrittura seguita dalla sincronizzazione dei dati: risolve con la risposta del server. */
  Api.scrivi = function (metodo, percorso, corpo) {
    return Api.richiesta(metodo, percorso, corpo).then(function (risposta) {
      return Api.sincronizza().then(function () {
        App.nascondiBanda();
        return risposta;
      }, function () { return risposta; }); // la scrittura è riuscita anche se la sincronizzazione no
    });
  };

  /* ---------- sincronizzazione ---------- */

  function statoVuoto() {
    return { impostazioni: {}, reparti: [], articoli: [], movimenti: [] };
  }

  /*
   * Unisce in App.S la risposta di /api/dati. Con 'completo' sostituisce tutto, altrimenti
   * sostituisce le righe per id, aggiunge le nuove e toglie le cancellate.
   * Restituisce cosa è cambiato.
   */
  function unisci(d, completo) {
    if (!App.S || completo) {
      // stato nuovo; le impostazioni restano quelle di prima se il server non le manda
      var nuovo = statoVuoto();
      if (App.S && App.S.impostazioni) nuovo.impostazioni = App.S.impostazioni;
      App.S = nuovo;
    }
    var S = App.S;
    var cambi = { impostazioni: false, reparti: 0, articoli: 0, movimenti: 0, cancellati: 0, completo: !!completo, qualcosa: false };
    if (d.impostazioni) { S.impostazioni = Object.assign({}, d.impostazioni); cambi.impostazioni = true; }
    ['reparti', 'articoli', 'movimenti'].forEach(function (t) {
      var righe = Array.isArray(d[t]) ? d[t] : [];
      if (completo) {
        S[t] = righe.slice();
        cambi[t] = righe.length || 1; // dopo un caricamento completo considero tutto cambiato
        return;
      }
      if (!righe.length) return;
      var indice = {};
      S[t].forEach(function (x, i) { indice[x.id] = i; });
      righe.forEach(function (x) {
        if (indice[x.id] !== undefined) S[t][indice[x.id]] = x;
        else { indice[x.id] = S[t].length; S[t].push(x); }
      });
      cambi[t] = righe.length;
    });
    (Array.isArray(d.cancellati) ? d.cancellati : []).forEach(function (c) {
      var t = c && c.tabella;
      if (!t || !Array.isArray(S[t])) return;
      var prima = S[t].length;
      S[t] = S[t].filter(function (x) { return x.id !== c.id; });
      if (S[t].length !== prima) cambi.cancellati++;
    });
    cambi.qualcosa = !!(cambi.impostazioni || cambi.reparti || cambi.articoli || cambi.movimenti || cambi.cancellati);
    return cambi;
  }

  function eseguiSincronizzazione(opz) {
    var da = opz.completa || !App.S ? 0 : Api.rev;
    return Api.richiesta('GET', '/api/dati?da=' + encodeURIComponent(da)).then(function (d) {
      d = d || {};
      var rev = Number(d.rev);
      if (da > 0 && !d.completo && isFinite(rev) && rev < Api.rev) {
        // il server è tornato indietro (per esempio dopo il ripristino di una copia): ricarico tutto
        return eseguiSincronizzazione({ completa: true, remota: opz.remota });
      }
      var cambi = unisci(d, da === 0 || !!d.completo);
      if (isFinite(rev)) Api.rev = rev;
      App._giacenze = null;
      if (App.dopoSincronizzazione) App.dopoSincronizzazione(cambi, opz);
      return cambi;
    });
  }

  var codaSinc = Promise.resolve();

  /*
   * Scarica dal server i cambiamenti dopo la revisione locale (la prima volta tutto) e li unisce in App.S.
   * opz.completa: ricarica tutto; opz.remota: i cambiamenti vengono da altri utenti (la pagina decide se ridisegnarsi).
   * Le sincronizzazioni sono in fila: mai due insieme.
   */
  Api.sincronizza = function (opz) {
    opz = opz || {};
    var p = codaSinc.then(function () { return eseguiSincronizzazione(opz); });
    codaSinc = p.catch(function () {});
    return p;
  };

  var timerSinc = null;
  Api.sincronizzaPresto = function () {
    clearTimeout(timerSinc);
    timerSinc = setTimeout(function () {
      timerSinc = null;
      if (!App.utente) return;
      // aspetto che finiscano le mie scritture: dopo di loro risincronizzo comunque
      if (Api.scrittureInCorso > 0) { Api.sincronizzaPresto(); return; }
      Api.sincronizza({ remota: true }).catch(function () {});
    }, ATTESA_SINC_MS);
  };

  /* ---------- aggiornamenti dal server (Server-Sent Events, polling di riserva) ---------- */
  var sorgente = null;
  var timerPolling = null;

  function apriSorgente() {
    if (sorgente || !App.utente) return;
    if (root.Accesso && root.Accesso.visibile()) return; // si riapre dopo l'accesso
    if (typeof root.EventSource !== 'function') { avviaPolling(); return; }
    var s;
    try { s = new root.EventSource(url('/api/eventi')); } catch (e) { avviaPolling(); return; }
    sorgente = s;
    s.addEventListener('open', function () {
      if (sorgente !== s) return;
      fermaPolling();
      segnaRaggiungibile();
      // dopo una riconnessione posso aver perso qualche evento
      Api.sincronizzaPresto();
    });
    s.addEventListener('rev', function (e) {
      if (sorgente !== s) return;
      var d = null;
      try { d = JSON.parse(e.data); } catch (x) { d = null; }
      var rev = d ? Number(d.rev) : NaN;
      // rev più alta: dati nuovi; rev più bassa: il server è stato ripristinato da una copia
      if (!isFinite(rev) || rev !== Api.rev) Api.sincronizzaPresto();
    });
    s.addEventListener('error', function () {
      if (sorgente !== s) return;
      // il browser ritenta da solo; intanto controllo ogni 20 secondi
      avviaPolling();
      // e subito una volta: se il server è spento l'indicatore lo dice adesso, non tra 20 secondi
      // (solo se non lo so già, per non accodare una sincronizzazione a ogni tentativo del browser)
      if (!Api.nonRaggiungibile) Api.sincronizzaPresto();
      if (s.readyState === 2) { // CLOSED: non ritenta più (per esempio sessione scaduta)
        s.close();
        sorgente = null;
      }
    });
  }

  function avviaPolling() {
    if (timerPolling) return;
    if (root.Accesso && root.Accesso.visibile()) return; // si riprende dopo l'accesso
    timerPolling = setInterval(function () {
      if (!App.utente) { fermaPolling(); return; }
      Api.sincronizza({ remota: true }).then(function () {
        if (!sorgente) apriSorgente(); // il server risponde: riprovo con gli eventi
      }, function () {});
    }, POLLING_MS);
  }

  function fermaPolling() {
    if (timerPolling) clearInterval(timerPolling);
    timerPolling = null;
  }

  Api.avviaAggiornamenti = function () {
    Api.fermaAggiornamenti();
    aggiornaIndicatore();
    apriSorgente();
  };

  Api.fermaAggiornamenti = function () {
    if (sorgente) { sorgente.close(); sorgente = null; }
    fermaPolling();
    clearTimeout(timerSinc);
    timerSinc = null;
  };

  /* La sessione non è più valida (401): fermo gli aggiornamenti e chiedo di nuovo l'accesso. */
  Api.sessioneScaduta = function () {
    if (!App.utente || (root.Accesso && root.Accesso.visibile())) return;
    Api.fermaAggiornamenti();
    if (root.Accesso) root.Accesso.mostraAccesso({ scaduta: true, username: App.utente.username });
  };

  root.Api = Api;
})(this);
