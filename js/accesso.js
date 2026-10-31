/*
 * Schermate di accesso a tutta pagina: primo amministratore, accesso con nome utente e password,
 * cambio obbligatorio della password provvisoria, server non raggiungibile.
 * Nome e logo della struttura arrivano da /api/stato (pubblico).
 */
(function (root) {
  'use strict';

  var App = root.App;
  var Api = root.Api;
  var h = App.h;

  var Accesso = {
    stato: null // ultima risposta di /api/stato
  };

  var timerRiprova = null;

  function schermo() { return document.getElementById('accesso'); }

  Accesso.visibile = function () {
    var s = schermo();
    return !!s && !s.hidden;
  };

  Accesso.nascondi = function () {
    clearTimeout(timerRiprova);
    var s = schermo();
    s.hidden = true;
    s.innerHTML = '';
    if (App.aggiornaInerte) App.aggiornaInerte();
  };

  /* Disegna la scheda centrale con il marchio della struttura. */
  function mostra(titolo, corpo) {
    var st = Accesso.stato || {};
    // con i dati caricati (sessione scaduta) valgono le impostazioni attuali, altrimenti quelle di /api/stato
    var imp = (App.S && App.S.impostazioni) || null;
    var struttura = (imp && imp.struttura) || st.struttura || 'Clinica Posillipo';
    var sottotitolo = imp ? (imp.sottotitolo || '') : (st.sottotitolo || '');
    var logo = imp ? imp.logo : st.logo;
    var s = schermo();
    s.innerHTML =
      '<div class="accesso-scheda" role="main">' +
      '<div class="accesso-marchio"><div class="logo">' +
      (logo ? '<img src="' + h(logo) + '" alt="">'
        : '<svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><path d="M13 6h6v7h7v6h-7v7h-6v-7H6v-6h7z" fill="#fff"/></svg>') +
      '</div><div><div class="nome">' + h(struttura) + '</div><div class="sotto">' + h(sottotitolo) + '</div></div></div>' +
      '<div class="accesso-prodotto">Gestionale Farmacia · carico e scarico</div>' +
      (titolo ? '<h2>' + h(titolo) + '</h2>' : '') +
      '<div class="accesso-corpo">' + corpo + '</div>' +
      (st.versione ? '<p class="accesso-versione">Versione ' + h(st.versione) + '</p>' : '') +
      '</div>';
    s.hidden = false;
    if (App.aggiornaInerte) App.aggiornaInerte();
    // fuoco subito (non dopo un ritardo: chi scrive in fretta non deve finire nel campo sbagliato)
    var primo = s.querySelector('input:not([hidden]):not([readonly])');
    if (primo) primo.focus();
    return s;
  }

  function erroreNelModulo(s, testo) {
    var el = s.querySelector('.accesso-errore');
    el.textContent = testo;
    el.hidden = !testo;
  }

  function campo(id, etichetta, tipo, completa, valore) {
    return '<label class="campo"><span>' + h(etichetta) + '</span><input id="' + id + '" type="' + (tipo || 'text') + '"' +
      (completa ? ' autocomplete="' + completa + '"' : '') + (valore ? ' value="' + h(valore) + '"' : '') +
      ' autocapitalize="off" spellcheck="false"></label>';
  }

  /* ---------- avvio: GET /api/stato e schermata giusta ---------- */
  Accesso.avvia = function () {
    clearTimeout(timerRiprova);
    attesa('Collegamento al server…');
    Api.richiesta('GET', '/api/stato', undefined, { senza401: true, senzaRitentativi: true }).then(function (st) {
      Accesso.stato = st || {};
      if (!st.inizializzato) {
        if (st.daServer) primoAmministratore(); else nonInizializzato();
        return;
      }
      if (!st.utente) { Accesso.mostraAccesso(); return; }
      entra(st.utente, st.permessi);
    }, function (e) {
      serverNonRaggiungibile(e);
    });
  };

  function attesa(testo) {
    mostra('', '<p class="accesso-attesa">' + h(testo) + '</p>');
  }

  function serverNonRaggiungibile(e) {
    var s = mostra('Server non raggiungibile',
      '<div class="banda pericolo"><p>' + h(e && e.stato ? e.message : 'Il programma non riesce a collegarsi al server del Gestionale Farmacia.') + '</p></div>' +
      '<p>Controlla che il PC sia collegato alla rete della clinica e che il server sia acceso. Riprovo da solo tra pochi secondi.</p>' +
      '<p class="piccolo tenue">Indirizzo: ' + h(location.origin) + '</p>' +
      '<div class="accesso-azioni"><button class="btn primario" type="button" id="acc-riprova">Riprova adesso</button></div>');
    s.querySelector('#acc-riprova').addEventListener('click', Accesso.avvia);
    clearTimeout(timerRiprova);
    timerRiprova = setTimeout(Accesso.avvia, 10000);
  }

  /* ---------- primo avvio ---------- */
  function nonInizializzato() {
    var porta = location.port || (location.protocol === 'https:' ? '443' : '80');
    var indirizzo = location.protocol + '//localhost' + (location.port ? ':' + location.port : '') + '/';
    var s = mostra('Primo avvio',
      '<p>Il programma è installato ma non ha ancora nessun utente.</p>' +
      '<p>Il <b>primo amministratore</b> si crea aprendo il programma <b>sul server stesso</b>, con Edge o Chrome, all’indirizzo:</p>' +
      '<p class="accesso-indirizzo">' + h(indirizzo) + '</p>' +
      '<p class="piccolo tenue">(porta ' + h(porta) + '). Dopo, da questo PC si entra con il nome utente e la password che l’amministratore ti darà.</p>' +
      '<div class="accesso-azioni"><button class="btn" type="button" id="acc-riprova">Riprova</button></div>');
    s.querySelector('#acc-riprova').addEventListener('click', Accesso.avvia);
  }

  function primoAmministratore() {
    var s = mostra('Crea il primo amministratore',
      '<p>Benvenuto. Questo è il primo avvio: crea l’utente <b>amministratore</b>, che potrà poi creare gli utenti per farmacia, reparti e direzione.</p>' +
      '<form id="acc-form" class="accesso-modulo" novalidate>' +
      campo('acc-user', 'Nome utente (per entrare)', 'text', 'username') +
      campo('acc-nome', 'Nome e cognome', 'text', 'name') +
      campo('acc-pw', 'Password (almeno 8 caratteri)', 'password', 'new-password') +
      campo('acc-pw2', 'Ripeti la password', 'password', 'new-password') +
      '<p class="accesso-errore" role="alert" hidden></p>' +
      '<button class="btn primario" type="submit" id="acc-invia">Crea amministratore ed entra</button>' +
      '</form>');
    var form = s.querySelector('#acc-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var username = s.querySelector('#acc-user').value.trim();
      var nome = s.querySelector('#acc-nome').value.trim();
      var pw = s.querySelector('#acc-pw').value;
      var pw2 = s.querySelector('#acc-pw2').value;
      if (!username) return erroreNelModulo(s, 'Scrivi il nome utente.');
      if (!nome) return erroreNelModulo(s, 'Scrivi nome e cognome.');
      if (pw.length < 8) return erroreNelModulo(s, 'La password deve avere almeno 8 caratteri.');
      if (pw !== pw2) return erroreNelModulo(s, 'Le due password non sono uguali.');
      erroreNelModulo(s, '');
      var b = s.querySelector('#acc-invia');
      b.disabled = true;
      Api.richiesta('POST', '/api/setup', { username: username, nome: nome, password: pw }, { senza401: true }).then(function (st) {
        Accesso.stato = Object.assign({}, Accesso.stato, st);
        entra(st.utente, st.permessi);
      }, function (err) {
        b.disabled = false;
        erroreNelModulo(s, err.message);
      });
    });
  }

  /* ---------- accesso ---------- */

  /*
   * Modulo di accesso. opz.scaduta: la sessione è scaduta mentre si lavorava
   * (la pagina sotto resta com'è: dopo l'accesso si risincronizza e si continua).
   */
  Accesso.mostraAccesso = function (opz) {
    opz = opz || {};
    var s = mostra(opz.scaduta ? 'Sessione scaduta' : 'Accedi',
      (opz.scaduta ? '<p>Per sicurezza la sessione si chiude dopo un po’ di inattività. Accedi di nuovo per continuare: quello che stavi scrivendo resta nella pagina.</p>' : '') +
      '<form id="acc-form" class="accesso-modulo" novalidate>' +
      campo('acc-user', 'Nome utente', 'text', 'username', opz.username) +
      campo('acc-pw', 'Password', 'password', 'current-password') +
      '<p class="accesso-errore" role="alert" hidden></p>' +
      '<button class="btn primario" type="submit" id="acc-invia">Entra</button>' +
      '</form>' +
      '<p class="piccolo tenue accesso-nota">Password dimenticata o utente bloccato? Chiedi all’amministratore una nuova password provvisoria.</p>');
    if (opz.username) s.querySelector('#acc-pw').focus();
    if (opz.errore) erroreNelModulo(s, opz.errore);
    s.querySelector('#acc-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var username = s.querySelector('#acc-user').value.trim();
      var pw = s.querySelector('#acc-pw').value;
      if (!username || !pw) return erroreNelModulo(s, 'Scrivi nome utente e password.');
      erroreNelModulo(s, '');
      var b = s.querySelector('#acc-invia');
      b.disabled = true;
      Api.richiesta('POST', '/api/login', { username: username, password: pw }, { senza401: true }).then(function (r) {
        entra(r.utente, r.permessi);
      }, function (err) {
        b.disabled = false;
        var p = s.querySelector('#acc-pw');
        p.value = '';
        p.focus();
        erroreNelModulo(s, err.stato === 423 ? '🔒 ' + err.message : err.message);
      });
    });
  };

  /* ---------- cambio obbligatorio della password provvisoria ---------- */
  function cambioPassword(utente, permessi) {
    var s = mostra('Scegli la tua password',
      '<p>Ciao <b>' + h(utente.nome || utente.username) + '</b>. La password che hai ricevuto è <b>provvisoria</b>: prima di cominciare scegline una personale, di almeno 8 caratteri, che conosci solo tu.</p>' +
      '<form id="acc-form" class="accesso-modulo" novalidate>' +
      '<input type="text" autocomplete="username" value="' + h(utente.username) + '" hidden>' +
      campo('acc-attuale', 'Password provvisoria', 'password', 'current-password') +
      campo('acc-pw', 'Nuova password', 'password', 'new-password') +
      campo('acc-pw2', 'Ripeti la nuova password', 'password', 'new-password') +
      '<p class="accesso-errore" role="alert" hidden></p>' +
      '<button class="btn primario" type="submit" id="acc-invia">Salva e continua</button>' +
      '</form>' +
      '<div class="accesso-azioni"><button class="btn fantasma piccolo" type="button" id="acc-esci">Esci</button></div>');
    s.querySelector('#acc-esci').addEventListener('click', function () {
      Api.richiesta('POST', '/api/logout', {}, { senza401: true }).catch(function () {}).then(function () {
        App.utente = null;
        App.permessi = null;
        Accesso.mostraAccesso();
      });
    });
    s.querySelector('#acc-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var attuale = s.querySelector('#acc-attuale').value;
      var pw = s.querySelector('#acc-pw').value;
      var pw2 = s.querySelector('#acc-pw2').value;
      if (!attuale) return erroreNelModulo(s, 'Scrivi la password provvisoria che hai ricevuto.');
      if (pw.length < 8) return erroreNelModulo(s, 'La nuova password deve avere almeno 8 caratteri.');
      if (pw !== pw2) return erroreNelModulo(s, 'Le due password nuove non sono uguali.');
      if (pw === attuale) return erroreNelModulo(s, 'La nuova password deve essere diversa da quella provvisoria.');
      erroreNelModulo(s, '');
      var b = s.querySelector('#acc-invia');
      b.disabled = true;
      Api.richiesta('POST', '/api/password', { attuale: attuale, nuova: pw }, { senza401: true }).then(function () {
        utente.cambioPassword = false;
        entra(utente, permessi);
      }, function (err) {
        b.disabled = false;
        if (err.stato === 401) { Accesso.mostraAccesso({ username: utente.username }); return; }
        erroreNelModulo(s, err.message);
      });
    });
  }

  /* ---------- ingresso nel programma ---------- */
  function entra(utente, permessi) {
    if (!utente) { Accesso.mostraAccesso(); return; }
    if (utente.cambioPassword) { cambioPassword(utente, permessi); return; }
    var primoIngresso = !App.pronta || !App.S;
    if (primoIngresso) attesa('Carico i dati…');
    App.entra(utente, permessi).catch(function (e) {
      if (e && e.stato === 401) {
        // l'accesso è riuscito ma la sessione non vale già più (cookie bloccati dal browser, utente disattivato…):
        // qui la schermata di accesso non torna da sola, la rimetto io
        Accesso.mostraAccesso({ username: utente.username, errore: 'Non riesco a mantenere la sessione aperta: accedi di nuovo. Se si ripete, controlla che il browser accetti i cookie per questo indirizzo.' });
        return;
      }
      console.error(e);
      var s = mostra('Non riesco a caricare i dati',
        '<div class="banda pericolo"><p>' + h(e && e.message ? e.message : String(e)) + '</p></div>' +
        '<div class="accesso-azioni"><button class="btn primario" type="button" id="acc-riprova">Riprova</button></div>');
      s.querySelector('#acc-riprova').addEventListener('click', function () { entra(utente, permessi); });
    });
  }

  root.Accesso = Accesso;
})(this);
