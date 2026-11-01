/*
 * Schermate di accesso a tutta pagina: primo amministratore, accesso con nome utente e password,
 * secondo passo della verifica in due passaggi (codice dell'app o codice di recupero, "ricorda questo computer"),
 * attivazione obbligatoria della verifica (criterio dell'amministratore), cambio obbligatorio della password provvisoria,
 * server non raggiungibile.
 * Nome del prodotto, struttura e logo arrivano da /api/stato (pubblico). Versione 3.0: parte C (docs/NOVITA-3.0.md).
 */
(function (root) {
  'use strict';

  var App = root.App;
  var Api = root.Api;
  var h = App.h;

  var MARCHIO = 'brand/logo.png'; // logo incorporato (impostazione logo = '')

  var Accesso = {
    stato: null // ultima risposta di /api/stato
  };

  var timerRiprova = null;

  function schermo() { return document.getElementById('accesso'); }

  Accesso.visibile = function () {
    var s = schermo();
    return !!s && !s.hidden;
  };

  // elemento della pagina (o della finestra aperta) che aveva il fuoco quando è comparsa la schermata di accesso
  var fuocoPrima = null;

  Accesso.nascondi = function () {
    clearTimeout(timerRiprova);
    var s = schermo();
    s.hidden = true;
    s.innerHTML = '';
    if (App.aggiornaInerte) App.aggiornaInerte();
    // dopo il nuovo accesso (sessione scaduta) il fuoco torna dov'era, se quell'elemento c'è ancora
    var f = fuocoPrima;
    fuocoPrima = null;
    var a = document.activeElement;
    if (f && f.isConnected && (!a || a === document.body)) {
      try { f.focus({ preventScroll: true }); } catch (e) { /* elemento non più attivabile */ }
    }
  };

  /* Marchio della schermata: logo ('' = incorporato, 'nessuno' = niente, altrimenti l'immagine caricata), nome del prodotto e struttura. */
  function testata() {
    var st = Accesso.stato || {};
    // con i dati caricati (sessione scaduta) valgono le impostazioni attuali, altrimenti quelle di /api/stato
    var imp = (App.S && App.S.impostazioni) || null;
    var fonte = imp || st;
    var prodotto = fonte.nomeProdotto || st.nomeProdotto || 'Gestionale Farmacia';
    var struttura = fonte.struttura || st.struttura || '';
    var sottotitolo = imp ? (imp.sottotitolo || '') : (st.sottotitolo || '');
    var logo = imp ? imp.logo : st.logo;
    var src = logo === 'nessuno' ? '' : (logo || MARCHIO);
    return '<header class="accesso-testata">' +
      // il nome è scritto qui sotto: il logo è solo decorativo per chi usa il lettore dello schermo
      (src ? '<div class="accesso-logo"><img src="' + h(src) + '" alt="" data-logo></div>' : '') +
      '<div class="accesso-nome-prodotto">' + h(prodotto) + '</div>' +
      (struttura || sottotitolo ? '<div class="accesso-struttura">' + h(struttura) + (struttura && sottotitolo ? ' · ' : '') +
        (sottotitolo ? '<span>' + h(sottotitolo) + '</span>' : '') + '</div>' : '') +
      '</header>';
  }

  /*
   * Disegna la scheda centrale con il marchio. opz.larga: scheda più larga (attivazione guidata con il codice QR).
   */
  function mostra(titolo, corpo, opz) {
    opz = opz || {};
    var st = Accesso.stato || {};
    var s = schermo();
    s.innerHTML =
      '<div class="accesso-scheda' + (opz.larga ? ' accesso-larga' : '') + '" role="main">' +
      testata() +
      (titolo ? '<h2 id="accesso-titolo">' + h(titolo) + '</h2>' : '') +
      '<div class="accesso-corpo">' + corpo + '</div>' +
      (st.versione ? '<p class="accesso-versione">Versione ' + h(st.versione) + '</p>' : '') +
      '</div>';
    // un logo che non si carica (file mancante, immagine rovinata) sparisce invece di mostrare l'icona rotta
    var img = s.querySelector('img[data-logo]');
    if (img) {
      var togli = function () { var box = img.closest('.accesso-logo'); if (box) box.remove(); };
      img.addEventListener('error', togli);
      if (img.complete && !img.naturalWidth) togli();
    }
    if (s.hidden) {
      var a = document.activeElement;
      var dove = a && a !== document.body ? a.closest('#app, #modale') : null;
      fuocoPrima = dove ? a : null;
    }
    // la fotocamera del lettore non resta accesa sotto la schermata di accesso (sessione scaduta)
    if (root.Scanner && root.Scanner.fotocameraAperta && root.Scanner.fotocameraAperta()) root.Scanner.chiudiFotocamera();
    s.hidden = false;
    if (App.aggiornaInerte) App.aggiornaInerte();
    // fuoco subito (non dopo un ritardo: chi scrive in fretta non deve finire nel campo sbagliato)
    var primo = s.querySelector('input:not([hidden]):not([readonly]):not([type=checkbox])');
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
      // tema e colore predefiniti per la schermata di accesso (li applica chi disegna l'aspetto, js/app.js)
      try { document.dispatchEvent(new CustomEvent('gf-stato', { detail: Accesso.stato })); } catch (e) { /* browser vecchio */ }
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
    mostra('', '<p class="accesso-attesa" role="status">' + h(testo) + '</p>');
  }

  function serverNonRaggiungibile(e) {
    var s = mostra('Server non raggiungibile',
      '<div class="banda pericolo"><p>' + h(e && e.stato ? e.message : 'Il programma non riesce a collegarsi al server.') + '</p></div>' +
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
      '<p>Benvenuto. Questo è il primo avvio: crea l’utente <b>amministratore</b>, che potrà poi creare gli utenti per la farmacia, i magazzini e la direzione.</p>' +
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
   * Il server risponde 401 anche quando la sessione è ancora valida ma l'amministratore ha reso obbligatoria la verifica
   * in due passaggi: in quel caso non serve la password, si passa subito all'attivazione guidata.
   */
  Accesso.mostraAccesso = function (opz) {
    opz = opz || {};
    if (opz.scaduta && App.utente) {
      var io = App.utente;
      attesa('Controllo la sessione…');
      Api.richiesta('GET', '/api/stato', undefined, { senza401: true, senzaRitentativi: true }).then(function (st) {
        if (st && st.utente && st.utente.id === io.id && st.utente.dueFattoriDaAttivare && !st.utente.cambioPassword) {
          attivazioneObbligatoria(st.utente, st.permessi);
        } else {
          disegnaAccesso(opz);
        }
      }, function () { disegnaAccesso(opz); });
      return;
    }
    disegnaAccesso(opz);
  };

  function disegnaAccesso(opz) {
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
        // password giusta, ma serve anche il codice dell'app (la sessione non è ancora aperta)
        if (r.dueFattori) { secondoPasso(username, r.sfida); return; }
        entra(r.utente, r.permessi);
      }, function (err) {
        b.disabled = false;
        var p = s.querySelector('#acc-pw');
        p.value = '';
        p.focus();
        erroreNelModulo(s, err.stato === 423 ? '🔒 ' + err.message : err.message);
      });
    });
  }

  /* ---------- verifica in due passaggi: secondo passo dell'accesso ---------- */

  function soloCifre(v) { return String(v || '').replace(/\D/g, ''); }

  function secondoPasso(username, sfida) {
    var st = Accesso.stato || {};
    var prodotto = (App.S && App.S.impostazioni && App.S.impostazioni.nomeProdotto) || st.nomeProdotto || 'Gestionale Farmacia';
    var s = mostra('Verifica in due passaggi',
      '<p id="acc-2fa-spiega">Apri l’app di autenticazione sul telefono (Google Authenticator, Microsoft Authenticator…) e scrivi il codice di 6 cifre di <b>' +
      h(prodotto) + '</b> per l’utente <b>' + h(username) + '</b>.</p>' +
      '<form id="acc-form-2fa" class="accesso-modulo" novalidate>' +
      '<div id="acc-blocco-codice"><label class="campo"><span>Codice dell’app</span>' +
      '<input id="acc-codice" class="accesso-codice" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="9" spellcheck="false" autocapitalize="off" aria-describedby="acc-codice-aiuto">' +
      '</label><p class="piccolo tenue" id="acc-codice-aiuto">Il codice cambia ogni 30 secondi. Puoi anche incollarlo.</p></div>' +
      '<div id="acc-blocco-recupero" hidden><label class="campo"><span>Codice di recupero</span>' +
      '<input id="acc-recupero" class="accesso-recupero" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="xxxxx-xxxxx" aria-describedby="acc-recupero-aiuto">' +
      '</label><p class="piccolo tenue" id="acc-recupero-aiuto">Uno dei 10 codici che hai salvato quando hai attivato la verifica. Ogni codice vale una volta sola.</p></div>' +
      '<label class="spunta accesso-ricorda"><input type="checkbox" id="acc-ricorda"> Ricorda questo computer per 30 giorni</label>' +
      '<p class="piccolo tenue accesso-ricorda-nota">Solo sul tuo computer, non su quelli che usano anche altri: qui non ti chiederò il codice.</p>' +
      '<p class="accesso-errore" role="alert" hidden></p>' +
      '<button class="btn primario" type="submit" id="acc-verifica">Verifica ed entra</button>' +
      '</form>' +
      '<div class="accesso-azioni accesso-azioni-2fa">' +
      '<button class="btn fantasma piccolo" type="button" id="acc-usa-recupero" aria-controls="acc-blocco-recupero acc-blocco-codice">Usa un codice di recupero</button>' +
      '<button class="btn fantasma piccolo" type="button" id="acc-indietro">Torna indietro</button></div>' +
      '<details class="accesso-aiuto"><summary>Non hai il telefono?</summary>' +
      '<p>Scegli «Usa un codice di recupero» e scrivi uno dei codici che hai salvato. Se non li hai più, chiedi all’amministratore di azzerare la verifica in due passaggi del tuo utente: poi entrerai con la sola password.</p></details>');
    var form = s.querySelector('#acc-form-2fa');
    var codice = s.querySelector('#acc-codice');
    var recupero = s.querySelector('#acc-recupero');
    var bloccoCodice = s.querySelector('#acc-blocco-codice');
    var bloccoRecupero = s.querySelector('#acc-blocco-recupero');
    var scambia = s.querySelector('#acc-usa-recupero');
    var inviando = false;
    var modoRecupero = false;

    var spiega = s.querySelector('#acc-2fa-spiega');
    var spiegaCodice = spiega.innerHTML;
    function modo(recuperoSi, valore) {
      modoRecupero = recuperoSi;
      spiega.innerHTML = recuperoSi
        ? 'Scrivi uno dei <b>codici di recupero</b> che hai salvato quando hai attivato la verifica (utente <b>' + h(username) + '</b>). Dopo, quel codice non vale più.'
        : spiegaCodice;
      bloccoCodice.hidden = recuperoSi;
      bloccoRecupero.hidden = !recuperoSi;
      scambia.textContent = recuperoSi ? 'Usa il codice dell’app' : 'Usa un codice di recupero';
      erroreNelModulo(s, '');
      var campoAttivo = recuperoSi ? recupero : codice;
      if (valore !== undefined) campoAttivo.value = valore;
      campoAttivo.focus();
    }
    scambia.addEventListener('click', function () { modo(!modoRecupero); });
    s.querySelector('#acc-indietro').addEventListener('click', function () { disegnaAccesso({ username: username }); });

    // si scrive (o si incolla) il codice: con 6 cifre parte da solo; "123 456" o "123-456" vanno bene
    codice.addEventListener('input', function () {
      var v = codice.value;
      if (/[a-z]/i.test(v) && v.replace(/[^a-z0-9]/gi, '').length >= 8) { modo(true, v.trim()); return; } // era un codice di recupero
      var c = soloCifre(v).slice(0, 6);
      if (v !== c && /^[\d\s-]*$/.test(v)) codice.value = c;
      if (c.length === 6 && !inviando) invia();
    });
    codice.addEventListener('paste', function (e) {
      var testo = e.clipboardData ? e.clipboardData.getData('text') : '';
      if (!testo) return;
      e.preventDefault();
      if (/[a-z]/i.test(testo)) { modo(true, testo.trim()); return; }
      codice.value = soloCifre(testo).slice(0, 6);
      if (codice.value.length === 6 && !inviando) invia();
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); invia(); });

    function invia() {
      var corpo = { sfida: sfida, ricorda: s.querySelector('#acc-ricorda').checked };
      if (modoRecupero) {
        var r = recupero.value.trim();
        if (r.replace(/[^a-z0-9]/gi, '').length < 10) { erroreNelModulo(s, 'Scrivi il codice di recupero (10 lettere e numeri, per esempio abcde-23456).'); recupero.focus(); return; }
        corpo.codiceRecupero = r;
      } else {
        var c = soloCifre(codice.value);
        if (c.length !== 6) { erroreNelModulo(s, 'Scrivi le 6 cifre che mostra l’app.'); codice.focus(); return; }
        corpo.codice = c;
      }
      erroreNelModulo(s, '');
      inviando = true;
      var b = s.querySelector('#acc-verifica');
      b.disabled = true;
      Api.richiesta('POST', '/api/login/2fa', corpo, { senza401: true }).then(function (r) {
        entra(r.utente, r.permessi, { codiciRimasti: r.codiciRimasti });
      }, function (err) {
        inviando = false;
        b.disabled = false;
        // verifica scaduta (più di 5 minuti) o troppi codici sbagliati: si ricomincia dalla password
        if (err.stato === 401 || err.stato === 429) { disegnaAccesso({ username: username, errore: err.message }); return; }
        erroreNelModulo(s, err.message);
        var campoAttivo = modoRecupero ? recupero : codice;
        campoAttivo.value = '';
        campoAttivo.focus();
      });
    }
  }

  /* ---------- attivazione obbligatoria (criterio dell'amministratore) ---------- */

  function attivazioneObbligatoria(utente, permessi) {
    var s = mostra('Attiva la verifica in due passaggi',
      '<div class="banda info"><p>Ciao <b>' + h(utente.nome || utente.username) + '</b>. L’amministratore ha chiesto la <b>verifica in due passaggi</b> per il tuo ruolo: ' +
      'oltre alla password servirà un codice dal tuo telefono. Ci vogliono un paio di minuti.</p></div>' +
      '<div id="acc-attivazione"></div>' +
      '<div class="accesso-azioni"><button class="btn fantasma piccolo" type="button" id="acc-esci">Esci</button></div>', { larga: true });
    s.querySelector('#acc-esci').addEventListener('click', esci);
    var cont = s.querySelector('#acc-attivazione');
    if (!App.Sicurezza || !App.Sicurezza.procedura) {
      cont.innerHTML = '<div class="banda pericolo"><p>Questa pagina non riesce a mostrare l’attivazione: ricaricala (F5).</p></div>';
      return;
    }
    App.Sicurezza.procedura(cont, {
      utente: utente,
      obbligatoria: true,
      senza401: true,
      etichettaFine: 'Fatto: entra nel programma',
      alTermine: function (nuovo) {
        entra(Object.assign({}, utente, nuovo || {}, { dueFattori: true, dueFattoriDaAttivare: false }), permessi);
      },
      alScadere: function (err) {
        App.utente = null;
        App.permessi = null;
        disegnaAccesso({ username: utente.username, errore: err && err.message });
      }
    });
  }

  function esci() {
    // sotto c'era il programma (sessione diventata limitata mentre si lavorava): App.esci toglie anche i dati dalla pagina
    if (App.S && App.esci) { App.esci(); return; }
    Api.richiesta('POST', '/api/logout', {}, { senza401: true }).catch(function () {}).then(function () {
      App.utente = null;
      App.permessi = null;
      disegnaAccesso({});
    });
  }

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
    s.querySelector('#acc-esci').addEventListener('click', esci);
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
      Api.richiesta('POST', '/api/password', { attuale: attuale, nuova: pw }, { senza401: true }).then(function (r) {
        // il server rimanda l'utente aggiornato (per esempio: ora deve attivare la verifica in due passaggi)
        var nuovo = Object.assign({}, utente, (r && r.utente) || {}, { cambioPassword: false });
        entra(nuovo, permessi);
      }, function (err) {
        b.disabled = false;
        if (err.stato === 401) { disegnaAccesso({ username: utente.username }); return; }
        erroreNelModulo(s, err.message);
      });
    });
  }

  /* ---------- ingresso nel programma ---------- */
  function entra(utente, permessi, opz) {
    opz = opz || {};
    if (!utente) { Accesso.mostraAccesso(); return; }
    if (utente.cambioPassword) { cambioPassword(utente, permessi); return; }
    if (utente.dueFattoriDaAttivare) { attivazioneObbligatoria(utente, permessi); return; }
    var primoIngresso = !App.pronta || !App.S;
    if (primoIngresso) attesa('Carico i dati…');
    App.entra(utente, permessi).then(function () {
      // entrato con un codice di recupero: quanti ne restano
      if (opz.codiciRimasti !== undefined && App.Sicurezza && App.Sicurezza.avvisoRecupero) App.Sicurezza.avvisoRecupero(opz.codiciRimasti);
    }, function (e) {
      if (e && e.stato === 401) {
        // l'accesso è riuscito ma la sessione non vale già più (cookie bloccati dal browser, utente disattivato…):
        // qui la schermata di accesso non torna da sola, la rimetto io
        disegnaAccesso({ username: utente.username, errore: 'Non riesco a mantenere la sessione aperta: accedi di nuovo. Se si ripete, controlla che il browser accetti i cookie per questo indirizzo.' });
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
