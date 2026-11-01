/*
 * Versione 3.0 – parte C: verifica in due passaggi (2FA) nell'interfaccia (docs/NOVITA-3.0.md, "2FA").
 *
 *   App.Sicurezza.apriAccount()               finestra "Sicurezza dell'account" (ogni utente: attiva/disattiva,
 *                                             nuovi codici di recupero, cambia telefono, dimentica i computer)
 *   App.Sicurezza.procedura(cont, opz)        attivazione guidata in 3 passi: app, codice QR + verifica, codici di recupero
 *                                             (usata anche dalla schermata di accesso, js/accesso.js, quando è obbligatoria)
 *   App.Sicurezza.mostraCodici(cont, codici, opz)  codici di recupero da salvare (scarica .txt, stampa, copia)
 *   App.Sicurezza.qrSvg(testo, etichetta)     codice QR come SVG (vendor/qrcode.js, globale qrcode)
 *   App.Sicurezza.avvisoRecupero(rimasti)     dopo un accesso con un codice di recupero
 *   App.pagine.sicurezza                      pagina dell'amministratore: criterio, utenti, azzeramento
 *
 * Le regole vere (chi può fare cosa, codici, blocchi) sono sul server: server/accessi.js e server/sicurezza.js.
 */
(function (root) {
  'use strict';

  var App = root.App;
  var h = App.h;
  function Api() { return root.Api; } // api.js si carica dopo app.js ma prima di questo file; così vale anche nelle prove

  var Sic = {};

  // app di autenticazione da consigliare (tutte gratuite)
  var APP_AUTENTICAZIONE = [
    ['Google Authenticator', 'Android e iPhone'],
    ['Microsoft Authenticator', 'Android e iPhone'],
    ['FreeOTP', 'Android e iPhone, libera'],
    ['Aegis', 'Android, libera, con copia dei codici']
  ];

  // criteri dell'amministratore (impostazione richiedi2fa)
  var CRITERI = [
    { id: 'nessuno', titolo: 'Facoltativa per tutti', testo: 'Ognuno decide se attivarla dalla finestra «Sicurezza dell’account» (menu con il proprio nome).' },
    { id: 'amministratori', titolo: 'Obbligatoria per gli amministratori', testo: 'Chi gestisce utenti, impostazioni e copie di sicurezza deve usarla.' },
    { id: 'farmacisti', titolo: 'Obbligatoria per amministratori e farmacisti', testo: 'Anche chi lavora nella farmacia centrale (carichi, DDT, ordini).' },
    { id: 'tutti', titolo: 'Obbligatoria per tutti', testo: 'Ogni utente, compresi i responsabili di magazzino e la direzione.' }
  ];
  var RUOLI_PER_CRITERIO = {
    nessuno: [],
    amministratori: ['amministratore'],
    farmacisti: ['amministratore', 'farmacista'],
    tutti: ['amministratore', 'farmacista', 'reparto', 'consultazione']
  };

  function nomeProdotto() {
    var imp = App.S && App.S.impostazioni;
    var st = root.Accesso && root.Accesso.stato;
    return (imp && imp.nomeProdotto) || (st && st.nomeProdotto) || 'Gestionale Farmacia';
  }

  function messaggio(e) { return e && e.message ? e.message : String(e); }

  function soloCifre(v) { return String(v || '').replace(/\D/g, '').slice(0, 6); }

  function fmtData(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('it-IT');
  }

  function fmtOra(d) { return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }); }

  function animaComparsa(cont, sel) {
    if (root.Motion && cont) root.Motion.entra(cont.querySelectorAll(sel));
  }

  /* Passo nuovo: i passi in alto tornano in vista (sul telefono si era scesi a scrivere il codice). */
  function mostraInizio(cont) {
    var el = cont.querySelector('.sic-passi') || cont.querySelector('.sic-passo h3');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  /* Copia negli appunti (anche senza HTTPS, dove navigator.clipboard non c'è). */
  function copia(testo) {
    if (root.navigator && navigator.clipboard && root.isSecureContext) return navigator.clipboard.writeText(testo);
    return new Promise(function (ok, ko) {
      var t = document.createElement('textarea');
      t.value = testo;
      t.setAttribute('readonly', '');
      t.className = 'sic-appunti';
      document.body.appendChild(t);
      t.select();
      var fatto = false;
      try { fatto = document.execCommand('copy'); } catch (e) { fatto = false; }
      t.remove();
      if (fatto) ok(); else ko(new Error('Il browser non permette di copiare: seleziona il testo e premi Ctrl+C.'));
    });
  }

  /* ---------- codice QR ---------- */

  /*
   * QR disegnato come SVG (niente immagini né script in linea): un rettangolo per ogni tratto scuro di una riga.
   * Bordo bianco di 4 moduli, come vuole lo standard; i colori (nero su bianco anche col tema scuro) sono nel CSS.
   */
  Sic.qrSvg = function (testo, etichetta) {
    if (typeof root.qrcode !== 'function') return '';
    var q;
    try {
      q = root.qrcode(0, 'M');
      q.addData(String(testo));
      q.make();
    } catch (e) { return ''; }
    var n = q.getModuleCount();
    var bordo = 4;
    var d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (!q.isDark(r, c)) continue;
        var inizio = c;
        while (c + 1 < n && q.isDark(r, c + 1)) c++;
        var lungo = c - inizio + 1;
        d += 'M' + (inizio + bordo) + ' ' + (r + bordo) + 'h' + lungo + 'v1h-' + lungo + 'z';
      }
    }
    var lato = n + 2 * bordo;
    return '<svg class="sic-qr-svg" viewBox="0 0 ' + lato + ' ' + lato + '" role="img" aria-label="' + h(etichetta || 'Codice QR') + '" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">' +
      '<rect class="sic-qr-fondo" width="' + lato + '" height="' + lato + '"/><path class="sic-qr-moduli" d="' + d + '"/></svg>';
  };

  /* ---------- codici di recupero: testo da scaricare e pagina da stampare ---------- */

  function testoCodici(codici, utente) {
    var r = '\r\n';
    return nomeProdotto() + ' – codici di recupero della verifica in due passaggi' + r +
      'Utente: ' + (utente ? utente.username + (utente.nome ? ' (' + utente.nome + ')' : '') : '') + r +
      'Creati il: ' + new Date().toLocaleString('it-IT') + r + r +
      'Servono per entrare se non hai il telefono (perso, rotto o cambiato):' + r +
      'scrivi uno di questi codici al posto delle 6 cifre dell’app.' + r +
      'Ogni codice vale UNA VOLTA SOLA. Conservali in un posto sicuro, lontano dal computer.' + r + r +
      codici.map(function (c, i) { return (i < 9 ? ' ' : '') + (i + 1) + '.  ' + c; }).join(r) + r;
  }

  function scaricaCodici(codici, utente) {
    var nome = 'codici-recupero-' + String(utente && utente.username || 'utente').replace(/[^a-z0-9._-]/gi, '') + '.txt';
    App.scarica(new Blob([testoCodici(codici, utente)], { type: 'text/plain;charset=utf-8' }), nome);
  }

  /* Stampa solo i codici (anche dalla schermata di accesso, che la stampa normale nasconde). */
  function stampaCodici(codici, utente) {
    var vecchio = document.getElementById('sic-stampa');
    if (vecchio) vecchio.remove();
    var el = document.createElement('div');
    el.id = 'sic-stampa';
    el.className = 'sic-stampa';
    el.innerHTML = '<h1>' + h(nomeProdotto()) + '</h1>' +
      '<h2>Codici di recupero della verifica in due passaggi</h2>' +
      '<p>Utente: <b>' + h(utente ? utente.username : '') + '</b>' + (utente && utente.nome ? ' (' + h(utente.nome) + ')' : '') +
      ' · creati il ' + h(new Date().toLocaleString('it-IT')) + '</p>' +
      '<ol>' + codici.map(function (c) { return '<li>' + h(c) + '</li>'; }).join('') + '</ol>' +
      '<p>Servono per entrare se non hai il telefono: scrivi un codice al posto delle 6 cifre dell’app. ' +
      '<b>Ogni codice vale una volta sola.</b> Conserva questo foglio in un posto chiuso.</p>';
    document.body.appendChild(el);
    document.body.classList.add('stampa-codici');
    function fine() {
      root.removeEventListener('afterprint', fine);
      document.body.classList.remove('stampa-codici');
      el.remove();
    }
    root.addEventListener('afterprint', fine);
    setTimeout(function () { try { root.print(); } catch (e) { fine(); } }, 60);
  }

  /*
   * Codici di recupero da salvare. opz: { utente, intestazione (html sopra, per esempio i passi), etichettaFine, alTermine() }.
   * Il pulsante per continuare si sblocca solo con la spunta "Li ho salvati".
   */
  Sic.mostraCodici = function (cont, codici, opz) {
    opz = opz || {};
    var utente = opz.utente || App.utente;
    cont.innerHTML = '<div class="sic-procedura">' + (opz.intestazione || '') + '<div class="sic-passo">' +
      '<h3 tabindex="-1">Salva i codici di recupero</h3>' +
      '<p>Se perdi o cambi il telefono, entri con uno di questi codici al posto del codice dell’app. ' +
      '<b>Ogni codice vale una volta sola.</b> Salvali adesso: dopo non si vedono più (si possono solo creare codici nuovi).</p>' +
      '<ol class="sic-codici" aria-label="Codici di recupero">' + codici.map(function (c) { return '<li><span class="mono">' + h(c) + '</span></li>'; }).join('') + '</ol>' +
      '<div class="sic-azioni-codici">' +
      '<button class="btn" type="button" id="sic-scarica">⬇ Scarica (.txt)</button>' +
      '<button class="btn" type="button" id="sic-stampa-codici">🖨 Stampa</button>' +
      '<button class="btn" type="button" id="sic-copia">Copia</button></div>' +
      '<p class="piccolo tenue">Tienili lontano dal computer: stampati in un cassetto chiuso, oppure in un gestore di password. Non mandarli per e-mail.</p>' +
      '<label class="spunta sic-salvati"><input type="checkbox" id="sic-salvati"> Li ho salvati in un posto sicuro</label>' +
      '<div class="sic-azioni"><button class="btn primario" type="button" id="sic-fine" disabled>' + h(opz.etichettaFine || 'Continua') + '</button></div>' +
      '</div></div>';
    var fine = cont.querySelector('#sic-fine');
    var spunta = cont.querySelector('#sic-salvati');
    spunta.addEventListener('change', function () { fine.disabled = !spunta.checked; });
    cont.querySelector('#sic-scarica').addEventListener('click', function () { scaricaCodici(codici, utente); });
    cont.querySelector('#sic-stampa-codici').addEventListener('click', function () { stampaCodici(codici, utente); });
    cont.querySelector('#sic-copia').addEventListener('click', function () {
      var b = this;
      copia(testoCodici(codici, utente)).then(function () { App.avviso('Codici copiati: incollali in un posto sicuro.', 'ok'); b.focus(); },
        function (e) { App.avviso(messaggio(e), 'errore'); });
    });
    fine.addEventListener('click', function () { if (spunta.checked && opz.alTermine) opz.alTermine(); });
    animaComparsa(cont, '.sic-passo > *');
    mostraInizio(cont);
    var t = cont.querySelector('.sic-passo h3');
    if (t) t.focus({ preventScroll: true });
  };

  /* ---------- attivazione guidata ---------- */

  var PASSI = ['Prepara il telefono', 'Collega l’app', 'Salva i codici'];

  function intestazionePassi(n) {
    return '<ol class="sic-passi" aria-label="Passi dell’attivazione">' + PASSI.map(function (t, i) {
      var classe = i < n ? 'fatto' : (i === n ? 'attuale' : '');
      return '<li class="' + classe + '"' + (i === n ? ' aria-current="step"' : '') + '>' +
        '<span class="sic-passi-n" aria-hidden="true">' + (i < n ? '✓' : i + 1) + '</span><span class="sic-passi-t">' + h(t) + '</span></li>';
    }).join('') + '</ol>';
  }

  /* Avviso se l'ora del server e quella di questo computer sono diverse: i codici funzionano solo con l'ora giusta. */
  function avvisoOra(oraServer) {
    var s = Date.parse(oraServer || '');
    if (!isFinite(s)) return '';
    var diff = Math.round((Date.now() - s) / 1000);
    if (Math.abs(diff) < 90) return '';
    var minuti = Math.max(1, Math.round(Math.abs(diff) / 60));
    return '<div class="banda attenzione sic-ora"><p><b>Attenzione all’ora.</b> Sul server sono le ' + h(fmtOra(new Date(s))) +
      ', su questo computer le ' + h(fmtOra(new Date())) + ' (' + minuti + (minuti === 1 ? ' minuto' : ' minuti') + ' di differenza). ' +
      'I codici funzionano solo se l’ora del server e quella del telefono sono giuste: avvisa chi gestisce il server.</p></div>';
  }

  /*
   * Attivazione in tre passi dentro "cont".
   * opz: {
   *   utente,                 utente collegato (per nome del file dei codici)
   *   obbligatoria: bool,     richiesta dall'amministratore (testo diverso, niente "Annulla")
   *   cambio: bool,           la 2FA è già attiva: si configura un telefono nuovo. Il primo passo chiede la password
   *                           (il server la vuole per cambiare telefono: con una sessione rubata non si cambia)
   *   senza401: bool,         schermata di accesso: un 401 non apre la schermata di "sessione scaduta"
   *   alTermine(utente),      attivata e codici salvati (utente aggiornato dal server)
   *   alAnnulla(),            (facoltativo) pulsante Annulla
   *   alScadere(err)          (facoltativo) sessione non più valida
   * }
   */
  Sic.procedura = function (cont, opz) {
    opz = opz || {};
    var dati = null;
    var utente = opz.utente || App.utente;
    var opzApi = opz.senza401 ? { senza401: true } : undefined;
    // cambio di telefono: diventa vero anche se il server dice che la verifica è già attiva (per esempio da un'altra scheda)
    var cambio = !!opz.cambio;
    var password = ''; // solo per il cambio: si manda una volta con /api/2fa/inizia e si dimentica subito

    function annulla() {
      return opz.alAnnulla ? '<button class="btn" type="button" data-sic-annulla>Annulla</button>' : '';
    }

    function disegna(html, n) {
      cont.innerHTML = '<div class="sic-procedura">' + intestazionePassi(n) + '<div class="sic-passo">' + html + '</div></div>';
      var b = cont.querySelector('[data-sic-annulla]');
      if (b) b.addEventListener('click', function () { opz.alAnnulla(); });
      animaComparsa(cont, '.sic-passo > *');
      mostraInizio(cont);
    }

    function errore(e) {
      if (e && e.stato === 401 && opz.alScadere) { opz.alScadere(e); return true; }
      return false;
    }

    /* Primo passo. testoErrore: per il cambio di telefono, password sbagliata o chiave da richiedere. */
    function passo1(testoErrore) {
      var testo =
        '<h3 tabindex="-1">' + (cambio ? 'Prepara il telefono nuovo' : 'Prepara il telefono') + '</h3>' +
        '<p>Con la verifica in due passaggi, oltre alla password serve un <b>codice di 6 cifre</b> che il tuo telefono crea ogni 30 secondi. ' +
        'Se qualcuno scopre la tua password, senza il telefono non può entrare.</p>' +
        '<p>Installa sul telefono una di queste app gratuite (dal Play Store o dall’App Store):</p>' +
        '<ul class="sic-app">' + APP_AUTENTICAZIONE.map(function (a) { return '<li><b>' + h(a[0]) + '</b> <span class="tenue">· ' + h(a[1]) + '</span></li>'; }).join('') + '</ul>' +
        '<p class="piccolo tenue">Ne usi già una (per la posta o la banca)? Va bene quella: tiene più codici insieme. ' +
        'L’ora del telefono deve essere impostata in automatico, e anche quella del server deve essere giusta.</p>';
      if (!cambio) {
        disegna(testo + '<div class="sic-azioni">' + annulla() + '<button class="btn primario" type="button" id="sic-avanti">Ho l’app: continua</button></div>', 0);
        cont.querySelector('#sic-avanti').addEventListener('click', passo2);
        cont.querySelector('#sic-avanti').focus({ preventScroll: true });
        return;
      }
      // cambio di telefono: prima la password, come per disattivare la verifica o creare codici nuovi
      disegna(testo +
        '<form class="sic-form-password" id="sic-form-cambio" novalidate>' +
        '<p>Per sicurezza scrivi la tua password: così nessuno, trovando il programma aperto, può collegare il suo telefono al tuo utente. ' +
        'Il telefono di adesso vale finché non confermi quello nuovo.</p>' +
        '<input type="text" autocomplete="username" value="' + h(utente && utente.username || '') + '" hidden>' +
        '<label class="campo"><span>La tua password</span><input type="password" id="sic-pw-cambio" autocomplete="current-password"></label>' +
        '<p class="sic-errore" role="alert"' + (testoErrore ? '' : ' hidden') + '>' + h(testoErrore || '') + '</p>' +
        '<div class="sic-azioni">' + annulla() + '<button class="btn primario" type="submit" id="sic-avanti">Ho l’app: continua</button></div>' +
        '</form>', 0);
      var campoPw = cont.querySelector('#sic-pw-cambio');
      cont.querySelector('#sic-form-cambio').addEventListener('submit', function (e) {
        e.preventDefault();
        if (!campoPw.value) {
          var err = cont.querySelector('#sic-form-cambio .sic-errore');
          err.textContent = 'Scrivi la tua password.';
          err.hidden = false;
          campoPw.focus();
          return;
        }
        password = campoPw.value;
        passo2();
      });
      campoPw.focus({ preventScroll: true });
    }

    function passo2(avviso) {
      disegna('<h3 tabindex="-1">Collega l’app</h3><p class="tenue" role="status">Preparo la chiave…</p>', 1);
      var corpo = cambio ? { password: password } : {};
      password = '';
      Api().richiesta('POST', '/api/2fa/inizia', corpo, opzApi).then(function (r) {
        dati = r;
        disegnaCollega(typeof avviso === 'string' ? avviso : '');
      }, function (e) {
        if (errore(e)) return;
        // password sbagliata, oppure la verifica è già attiva (un'altra scheda l'ha appena attivata): serve la password
        if (e.stato === 400 && (cambio || (e.dati && e.dati.servePassword))) { cambio = true; passo1(messaggio(e)); return; }
        disegna('<h3 tabindex="-1">Collega l’app</h3><div class="banda pericolo"><p>' + h(messaggio(e)) + '</p></div>' +
          '<div class="sic-azioni">' + annulla() + '<button class="btn primario" type="button" id="sic-riprova">Riprova</button></div>', 1);
        cont.querySelector('#sic-riprova').addEventListener('click', function () { if (cambio) passo1(); else passo2(); });
      });
    }

    function disegnaCollega(testoErrore) {
      var qr = Sic.qrSvg(dati.uri, 'Codice QR da inquadrare con l’app di autenticazione');
      disegna(
        '<h3 tabindex="-1">Collega l’app</h3>' +
        '<div class="sic-collega">' +
        '<div class="sic-qr-box"><div class="sic-qr">' + (qr || '<p class="piccolo">Codice QR non disponibile: scrivi la chiave a mano.</p>') + '</div>' +
        // sul telefono il QR del proprio schermo non si può inquadrare: il collegamento otpauth:// apre direttamente l'app
        '<a class="btn piccolo sic-solo-telefono" href="' + h(dati.uri) + '">Sei sul telefono? Aggiungi all’app</a></div>' +
        '<div class="sic-collega-testo">' +
        '<ol class="sic-istruzioni">' +
        '<li>Nell’app tocca <b>+</b> (Aggiungi) e scegli <b>Scansiona un codice QR</b>.</li>' +
        '<li>Inquadra il codice QR di questa pagina.</li>' +
        '<li>Nell’app compare <b>' + h(dati.emittente) + '</b> con un codice di 6 cifre: scrivilo qui sotto.</li></ol>' +
        '<details class="sic-chiave"' + (qr ? '' : ' open') + '><summary>Non riesci a inquadrarlo? Scrivi la chiave a mano</summary>' +
        '<p>Nell’app scegli <b>Inserisci una chiave</b> (o «Inserisci manualmente») e scrivi:</p>' +
        '<dl class="sic-dati-chiave"><dt>Nome dell’account</dt><dd>' + h(dati.emittente) + ' (' + h(dati.utente) + ')</dd>' +
        '<dt>Chiave</dt><dd><span class="mono sic-chiave-testo" id="sic-chiave-testo">' + h(dati.chiave) + '</span></dd>' +
        '<dt>Tipo</dt><dd>basata sul tempo, 6 cifre, ogni 30 secondi</dd></dl>' +
        '<button class="btn piccolo" type="button" id="sic-copia-chiave">Copia la chiave</button></details>' +
        '</div></div>' +
        avvisoOra(dati.oraServer) +
        '<form class="sic-form-codice" id="sic-form-codice" novalidate>' +
        '<label class="campo"><span>Codice di 6 cifre mostrato dall’app</span>' +
        '<input id="sic-codice" class="sic-codice" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="9" spellcheck="false" autocapitalize="off" aria-describedby="sic-codice-aiuto"></label>' +
        '<p class="piccolo tenue" id="sic-codice-aiuto">Il codice cambia ogni 30 secondi: se sta per scadere aspetta quello nuovo.</p>' +
        '<p class="sic-errore" role="alert"' + (testoErrore ? '' : ' hidden') + '>' + h(testoErrore || '') + '</p>' +
        '<div class="sic-azioni">' + annulla() + '<button class="btn primario" type="submit" id="sic-verifica">Verifica e attiva</button></div>' +
        '</form>', 1);
      var inp = cont.querySelector('#sic-codice');
      var form = cont.querySelector('#sic-form-codice');
      var inviando = false;
      cont.querySelector('#sic-copia-chiave').addEventListener('click', function () {
        var b = this;
        copia(dati.segretoBase32).then(function () { App.avviso('Chiave copiata', 'ok'); b.focus(); }, function (e) { App.avviso(messaggio(e), 'errore'); });
      });
      inp.addEventListener('input', function () {
        var c = soloCifre(inp.value);
        if (inp.value !== c && /^[\d\s-]*$/.test(inp.value)) inp.value = c;
        if (c.length === 6 && !inviando) invia();
      });
      form.addEventListener('submit', function (e) { e.preventDefault(); invia(); });
      function mostraErrore(t) {
        var el = cont.querySelector('.sic-errore');
        el.textContent = t;
        el.hidden = !t;
      }
      function invia() {
        var codice = soloCifre(inp.value);
        if (codice.length !== 6) { mostraErrore('Scrivi le 6 cifre che mostra l’app.'); inp.focus(); return; }
        mostraErrore('');
        inviando = true;
        var b = cont.querySelector('#sic-verifica');
        b.disabled = true;
        Api().richiesta('POST', '/api/2fa/conferma', { codice: codice }, opzApi).then(function (r) {
          utente = r.utente || utente;
          Sic.mostraCodici(cont, r.codiciRecupero || [], {
            utente: utente,
            intestazione: intestazionePassi(2),
            etichettaFine: opz.etichettaFine || 'Fatto: continua',
            alTermine: function () { if (opz.alTermine) opz.alTermine(utente); }
          });
        }, function (e) {
          inviando = false;
          if (errore(e)) return;
          if (e.dati && e.dati.ricomincia) {
            // chiave scaduta o annullata: una nuova (per il cambio di telefono si riscrive la password)
            if (e.dati.servePassword) cambio = true;
            if (cambio) passo1(messaggio(e)); else passo2(messaggio(e));
            return;
          }
          b.disabled = false;
          mostraErrore(messaggio(e));
          inp.value = '';
          inp.focus();
        });
      }
      inp.focus({ preventScroll: true });
    }

    // il cambio di telefono parte sempre dal primo passo: la password si chiede lì
    if (opz.dalPasso === 2 && !cambio) passo2(); else passo1();
  };

  /* ---------- finestra "Sicurezza dell'account" ---------- */

  Sic.apriAccount = function () {
    if (!App.utente) return;
    App.apriModale({
      titolo: 'Sicurezza dell’account',
      corpo: '<div class="sic-account" id="sic-account"><p class="tenue" role="status">Carico…</p></div>',
      piede: '<button class="btn" type="button" data-chiudi>Chiudi</button>',
      dopo: function (m) {
        m.classList.add('sic-modale');
        caricaAccount(m.querySelector('#sic-account'));
      }
    });
  };

  function caricaAccount(box) {
    Api().richiesta('GET', '/api/2fa').then(function (st) {
      if (box.isConnected) disegnaAccount(box, st);
    }, function (e) {
      if (box.isConnected) box.innerHTML = '<div class="banda pericolo"><p>Non riesco a leggere lo stato della sicurezza: ' + h(messaggio(e)) + '</p></div>';
    });
  }

  // utente aggiornato dal server (per esempio 2FA attivata): menu e permessi restano quelli
  function aggiornaUtente(u) {
    if (u && App.utente && u.id === App.utente.id) {
      App.utente.dueFattori = u.dueFattori;
      App.utente.dueFattoriObbligatoria = u.dueFattoriObbligatoria;
      App.utente.dueFattoriDaAttivare = u.dueFattoriDaAttivare;
    }
  }

  function riga(titolo, testo, azione) {
    return '<div class="sic-riga"><div class="sic-riga-testo"><h4>' + h(titolo) + '</h4><p>' + testo + '</p></div>' +
      (azione ? '<div class="sic-riga-azione">' + azione + '</div>' : '') + '</div>';
  }

  function disegnaAccount(box, st) {
    var u = App.utente || {};
    var stato = '<section class="sic-stato ' + (st.attiva ? 'attiva' : 'spenta') + '" aria-label="Stato della verifica in due passaggi">' +
      '<div class="sic-stato-icona" aria-hidden="true">' + (st.attiva ? '🔒' : '🔓') + '</div>' +
      '<div><h3>Verifica in due passaggi: ' + (st.attiva ? 'attiva' : 'non attiva') + '</h3>' +
      '<p>' + (st.attiva
        ? 'Attivata il ' + h(fmtData(st.attivataIl)) + '. Per entrare servono la password e il codice dell’app sul tuo telefono.'
        : 'Adesso per entrare basta la password. Con la verifica in due passaggi serve anche un codice dal tuo telefono: se qualcuno scopre la tua password, senza il telefono non entra.') + '</p>' +
      (st.obbligatoria ? '<p><span class="etichetta info">Richiesta dall’amministratore per il tuo ruolo</span></p>' : '') +
      '</div></section>';
    var corpo;
    if (!st.attiva) {
      corpo = '<div class="sic-azioni sinistra"><button class="btn primario" type="button" id="sic-attiva">Attiva la verifica in due passaggi</button></div>';
    } else {
      var pochi = st.codiciRimasti <= 3;
      corpo = '<div class="sic-righe">' +
        riga('Codici di recupero', 'Te ne restano <b>' + st.codiciRimasti + '</b> di 10.' +
          (pochi ? ' <span class="etichetta attenzione">pochi: creane di nuovi</span>' : ' Servono se non hai il telefono.'),
          '<button class="btn piccolo" type="button" id="sic-nuovi-codici">Nuovi codici</button>') +
        riga('Computer attendibili', st.dispositivi
          ? 'Su <b>' + st.dispositivi + '</b> computer non chiedo il codice per ' + st.giorniDispositivo + ' giorni (hai scelto «Ricorda questo computer»).'
          : 'Nessun computer ricordato: il codice si chiede a ogni accesso.',
          st.dispositivi ? '<button class="btn piccolo" type="button" id="sic-dimentica">Dimentica i computer</button>' : '') +
        riga('Telefono', 'Hai cambiato telefono o reinstallato l’app? Collega di nuovo l’app (serve la tua password): il telefono vecchio smette di valere.',
          '<button class="btn piccolo" type="button" id="sic-cambia">Cambia telefono</button>') +
        (st.obbligatoria ? '' : riga('Disattiva', 'Torni a entrare con la sola password.',
          '<button class="btn piccolo pericolo" type="button" id="sic-disattiva">Disattiva</button>')) +
        '</div>';
    }
    box.innerHTML = stato + '<div id="sic-account-corpo">' + corpo + '</div>';
    var area = box.querySelector('#sic-account-corpo');

    function ricarica() { caricaAccount(box); }
    // durante una procedura lo stato in alto si nasconde (la finestra resta corta); torna con ricarica()
    function nascondiStato() { var el = box.querySelector('.sic-stato'); if (el) el.hidden = true; }
    function procedura(cambio) {
      nascondiStato();
      Sic.procedura(area, {
        utente: u,
        cambio: cambio,
        obbligatoria: st.obbligatoria,
        alAnnulla: ricarica,
        etichettaFine: 'Fatto',
        alTermine: function (nuovo) {
          aggiornaUtente(nuovo);
          App.avviso(cambio ? 'Telefono nuovo collegato' : 'Verifica in due passaggi attiva', 'ok');
          ricarica();
        }
      });
    }
    var b = box.querySelector('#sic-attiva');
    if (b) b.addEventListener('click', function () { procedura(false); });
    b = box.querySelector('#sic-cambia');
    if (b) b.addEventListener('click', function () { procedura(true); });
    b = box.querySelector('#sic-nuovi-codici');
    if (b) b.addEventListener('click', function () { nascondiStato(); chiediPassword(area, u, false, ricarica); });
    b = box.querySelector('#sic-disattiva');
    if (b) b.addEventListener('click', function () { nascondiStato(); chiediPassword(area, u, true, ricarica); });
    b = box.querySelector('#sic-dimentica');
    if (b) b.addEventListener('click', function () { nascondiStato(); confermaDimentica(area, st.dispositivi, ricarica); });
    animaComparsa(box, '.sic-stato, .sic-riga');
  }

  /* Nuovi codici (solo password) o disattivazione (password e codice), dentro la finestra. */
  function chiediPassword(area, u, disattiva, ricarica) {
    area.innerHTML = '<form class="sic-conferma" id="sic-form-pw" novalidate>' +
      '<h3 tabindex="-1">' + (disattiva ? 'Disattiva la verifica in due passaggi' : 'Nuovi codici di recupero') + '</h3>' +
      '<p>' + (disattiva ? 'Per sicurezza scrivi la tua password e il codice dell’app (oppure un codice di recupero).'
        : 'I codici di recupero di prima smettono di valere. Per sicurezza scrivi la tua password.') + '</p>' +
      '<input type="text" autocomplete="username" value="' + h(u.username || '') + '" hidden>' +
      '<label class="campo"><span>Password</span><input type="password" id="sic-pw" autocomplete="current-password"></label>' +
      (disattiva ? '<label class="campo"><span>Codice dell’app o di recupero</span><input id="sic-codice-dis" inputmode="text" autocomplete="one-time-code" spellcheck="false" autocapitalize="off"></label>' : '') +
      '<p class="sic-errore" role="alert" hidden></p>' +
      '<div class="sic-azioni"><button class="btn" type="button" id="sic-annulla-pw">Annulla</button>' +
      '<button class="btn ' + (disattiva ? 'pericolo pieno' : 'primario') + '" type="submit" id="sic-conferma-pw">' + (disattiva ? 'Disattiva' : 'Crea i codici nuovi') + '</button></div></form>';
    var form = area.querySelector('#sic-form-pw');
    area.querySelector('#sic-annulla-pw').addEventListener('click', ricarica);
    area.querySelector('#sic-pw').focus();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = area.querySelector('.sic-errore');
      var pw = area.querySelector('#sic-pw').value;
      var codice = disattiva ? area.querySelector('#sic-codice-dis').value.trim() : '';
      if (!pw) { err.textContent = 'Scrivi la tua password.'; err.hidden = false; return; }
      if (disattiva && !codice) { err.textContent = 'Scrivi il codice dell’app.'; err.hidden = false; return; }
      err.hidden = true;
      var b = area.querySelector('#sic-conferma-pw');
      b.disabled = true;
      var richiesta = disattiva
        ? Api().richiesta('POST', '/api/2fa/disattiva', { password: pw, codice: /[a-z]/i.test(codice) ? codice : soloCifre(codice) })
        : Api().richiesta('POST', '/api/2fa/codici', { password: pw });
      richiesta.then(function (r) {
        if (disattiva) {
          aggiornaUtente(r.utente);
          App.avviso('Verifica in due passaggi disattivata', 'ok');
          ricarica();
          return;
        }
        Sic.mostraCodici(area, r.codiciRecupero || [], { utente: u, etichettaFine: 'Fatto', alTermine: ricarica });
      }, function (e2) {
        b.disabled = false;
        err.textContent = messaggio(e2);
        err.hidden = false;
      });
    });
  }

  function confermaDimentica(area, n, ricarica) {
    area.innerHTML = '<div class="sic-conferma"><h3 tabindex="-1">Dimentica i computer attendibili</h3>' +
      '<p>Su ' + (n === 1 ? 'quel computer' : 'quei ' + n + ' computer') + ' al prossimo accesso servirà di nuovo il codice dell’app. ' +
      'Fallo se hai usato «Ricorda questo computer» su un computer che usano anche altri, o che non c’è più.</p>' +
      '<div class="sic-azioni"><button class="btn" type="button" id="sic-annulla-dim">Annulla</button>' +
      '<button class="btn primario" type="button" id="sic-ok-dim">Dimentica i computer</button></div></div>';
    area.querySelector('#sic-annulla-dim').addEventListener('click', ricarica);
    var b = area.querySelector('#sic-ok-dim');
    b.focus();
    b.addEventListener('click', function () {
      b.disabled = true;
      Api().richiesta('DELETE', '/api/2fa/dispositivi').then(function () {
        App.avviso('Computer dimenticati', 'ok');
        ricarica();
      }, function (e) {
        b.disabled = false;
        App.avviso(messaggio(e), 'errore');
      });
    });
  }

  /* Dopo un accesso con un codice di recupero: quanti ne restano e come crearne di nuovi. */
  Sic.avvisoRecupero = function (rimasti) {
    var pochi = rimasti <= 3;
    App.apriModale({
      titolo: 'Sei entrato con un codice di recupero',
      corpo: '<p>Quel codice adesso non vale più. Te ne restano <b>' + Number(rimasti) + '</b>.</p>' +
        (pochi ? '<div class="banda attenzione"><p>Sono pochi: crea dei codici nuovi e salvali.</p></div>' : '') +
        '<p>Hai perso o cambiato il telefono? Apri «Sicurezza dell’account» e scegli <b>Cambia telefono</b> per collegare l’app sul telefono nuovo.</p>',
      piede: '<button class="btn" type="button" data-chiudi>Più tardi</button>' +
        '<button class="btn primario" type="button" id="sic-apri-account">Apri Sicurezza dell’account</button>',
      dopo: function (m) {
        m.querySelector('#sic-apri-account').addEventListener('click', function () { Sic.apriAccount(); });
      }
    });
  };

  /* ======================= PAGINA SICUREZZA (amministratore) ======================= */

  function scheda(titolo, corpo, extraTesta, stretto, id) {
    return '<section class="scheda"' + (id ? ' id="' + id + '"' : '') + '><div class="scheda-testa"><h2>' + titolo + '</h2>' + (extraTesta || '') + '</div>' +
      '<div class="scheda-corpo' + (stretto ? ' stretto' : '') + '">' + corpo + '</div></section>';
  }

  App.pagine.sicurezza = function (cont) {
    var stato = null;      // risposta di GET /api/sicurezza
    var scelto = null;     // criterio scelto nella pagina (non ancora salvato)

    cont.innerHTML =
      '<div class="sic-pagina">' +
      '<div class="banda info sic-spiega"><p><b>Verifica in due passaggi.</b> Oltre alla password serve un codice di 6 cifre che il telefono ' +
      'dell’utente crea ogni 30 secondi (Google Authenticator, Microsoft Authenticator, FreeOTP…). Chi scopre una password, senza il telefono non entra.</p>' +
      '<button class="btn" type="button" id="sic-mio">🔐 La mia sicurezza</button></div>' +
      '<div id="sic-ora" hidden></div>' +
      scheda('Chi deve usarla', '<p class="tenue" role="status">Carico…</p>', '', false, 'sic-criterio') +
      scheda('Utenti', '<p class="vuoto">Carico gli utenti…</p>', '', true, 'sic-utenti') +
      '</div>';
    cont.querySelector('#sic-mio').addEventListener('click', Sic.apriAccount);

    function quantiDaAttivare(criterio) {
      var ruoli = RUOLI_PER_CRITERIO[criterio] || [];
      return (stato ? stato.utenti : []).filter(function (u) { return u.attivo && !u.dueFattori && ruoli.indexOf(u.ruolo) >= 0; });
    }

    function disegnaCriterio() {
      var box = cont.querySelector('#sic-criterio .scheda-corpo');
      var criterio = scelto || stato.richiedi2fa;
      var mancano = quantiDaAttivare(criterio);
      var cambiato = criterio !== stato.richiedi2fa;
      box.innerHTML = '<fieldset class="sic-criteri"><legend class="sic-sr">Chi deve usare la verifica in due passaggi</legend>' +
        CRITERI.map(function (c) {
          return '<label class="sic-criterio' + (c.id === criterio ? ' scelto' : '') + '"><input type="radio" name="sic-criterio" value="' + c.id + '"' +
            (c.id === criterio ? ' checked' : '') + '><span><b>' + h(c.titolo) + '</b>' +
            (c.id === stato.richiedi2fa ? ' <span class="etichetta ok">in uso</span>' : '') +
            '<small>' + h(c.testo) + '</small></span></label>';
        }).join('') + '</fieldset>' +
        '<p class="sic-riepilogo" role="status">' + (criterio === 'nessuno'
          ? 'Nessuno è obbligato: la verifica resta una scelta di ognuno.'
          : (mancano.length
            ? '<b>' + mancano.length + '</b> ' + (mancano.length === 1 ? 'utente deve' : 'utenti devono') + ' ancora attivarla: ' + h(mancano.map(function (u) { return u.nome; }).join(', ')) +
              '. Al prossimo accesso (o subito, se sono collegati) il programma li guida passo per passo; finché non la attivano non possono lavorare.'
            : 'Tutti gli utenti interessati l’hanno già attivata.')) + '</p>' +
        '<p class="sic-errore" role="alert" hidden></p>' +
        '<div class="sic-azioni sinistra"><button class="btn primario" type="button" id="sic-salva-criterio"' + (cambiato ? '' : ' disabled') + '>Salva il criterio</button>' +
        (cambiato ? '<button class="btn fantasma" type="button" id="sic-annulla-criterio">Annulla</button>' : '') + '</div>';
      box.querySelectorAll('input[name="sic-criterio"]').forEach(function (r) {
        r.addEventListener('change', function () {
          scelto = r.value;
          disegnaCriterio();
          var nuovo = box.querySelector('input[name="sic-criterio"][value="' + r.value + '"]');
          if (nuovo) nuovo.focus();
        });
      });
      var annulla = box.querySelector('#sic-annulla-criterio');
      if (annulla) annulla.addEventListener('click', function () { scelto = null; disegnaCriterio(); });
      box.querySelector('#sic-salva-criterio').addEventListener('click', salvaCriterio);
    }

    function salvaCriterio() {
      var box = cont.querySelector('#sic-criterio .scheda-corpo');
      var b = box.querySelector('#sic-salva-criterio');
      var err = box.querySelector('.sic-errore');
      var criterio = scelto;
      if (!criterio) return;
      b.disabled = true;
      Api().richiesta('PUT', '/api/sicurezza', { richiedi2fa: criterio }).then(function (r) {
        stato = r;
        scelto = null;
        if (App.S && App.S.impostazioni) App.S.impostazioni.richiedi2fa = r.richiedi2fa;
        App.avviso('Criterio salvato' + (r.daAttivare ? ': ' + r.daAttivare + (r.daAttivare === 1 ? ' utente deve' : ' utenti devono') + ' attivare la verifica' : ''), 'ok');
        if (cont.isConnected) disegna();
      }, function (e) {
        b.disabled = false;
        err.innerHTML = h(messaggio(e)) + (e.dati && e.dati.attivaPrima ? ' <button class="btn piccolo" type="button" id="sic-attiva-prima">Attivala adesso</button>' : '');
        err.hidden = false;
        var a = err.querySelector('#sic-attiva-prima');
        if (a) a.addEventListener('click', Sic.apriAccount);
      });
    }

    function etichettaStato(u) {
      if (u.bloccato) return '<span class="etichetta pericolo">bloccato 15 minuti</span>';
      if (u.dueFattori) return '<span class="etichetta ok">attiva</span>' + (u.attivataIl ? ' <span class="tenue piccolo">dal ' + h(fmtData(u.attivataIl)) + '</span>' : '');
      if (u.daAttivare) return '<span class="etichetta attenzione">da attivare</span>';
      return '<span class="etichetta">non attiva</span>';
    }

    function disegnaUtenti() {
      var box = cont.querySelector('#sic-utenti .scheda-corpo');
      var lista = stato.utenti.filter(function (u) { return u.attivo; });
      var disattivati = stato.utenti.length - lista.length;
      var conDue = lista.filter(function (u) { return u.dueFattori; }).length;
      cont.querySelector('#sic-utenti .scheda-testa').innerHTML = '<h2>Utenti</h2><span class="nota">' + conDue + ' su ' + lista.length + ' con la verifica attiva' +
        (disattivati ? ' · ' + disattivati + ' disattivati non mostrati' : '') + '</span>';
      box.innerHTML = lista.length ? '<div class="tabella-contenitore"><table class="tabella sic-tabella"><thead><tr>' +
        '<th>Utente</th><th>Ruolo</th><th>Verifica in due passaggi</th><th class="n">Codici di recupero</th><th class="n">Computer ricordati</th><th>Ultimo accesso</th><th><span class="sic-sr">Azioni</span></th>' +
        '</tr></thead><tbody>' + lista.map(function (u) {
          var io = App.utente && u.id === App.utente.id;
          return '<tr>' +
            '<td data-et="Utente"><b>' + h(u.nome) + '</b> <span class="mono tenue">' + h(u.username) + '</span>' + (io ? ' <span class="etichetta info">sei tu</span>' : '') + '</td>' +
            '<td data-et="Ruolo">' + h(App.nomeRuolo(u.ruolo)) + (u.obbligatoria ? ' <span class="etichetta" title="Il criterio la richiede per questo ruolo">obbligatoria</span>' : '') + '</td>' +
            '<td data-et="Verifica">' + etichettaStato(u) + '</td>' +
            '<td data-et="Codici di recupero" class="n">' + (u.dueFattori ? (u.codiciRimasti <= 3 ? '<span class="etichetta attenzione">' + u.codiciRimasti + ' di 10</span>' : u.codiciRimasti + ' di 10') : '<span class="tenue">—</span>') + '</td>' +
            '<td data-et="Computer ricordati" class="n">' + (u.dispositivi || '<span class="tenue">0</span>') + '</td>' +
            '<td data-et="Ultimo accesso" class="piccolo">' + (u.ultimoAccesso ? h(App.fmtDataOra(u.ultimoAccesso)) : '<span class="tenue">mai</span>') + '</td>' +
            '<td class="azioni">' + (u.dueFattori || u.dispositivi || u.bloccato
              ? '<button class="btn piccolo pericolo" type="button" data-azzera="' + h(u.id) + '">Azzera</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<div class="vuoto"><b>Nessun utente</b></div>';
      box.querySelectorAll('[data-azzera]').forEach(function (b) {
        b.addEventListener('click', function () {
          var u = stato.utenti.filter(function (x) { return x.id === b.getAttribute('data-azzera'); })[0];
          if (u) azzera(u);
        });
      });
      animaComparsa(box, 'tbody tr');
    }

    function azzera(u) {
      var io = App.utente && u.id === App.utente.id;
      App.conferma('Azzera la verifica di ' + u.nome,
        'Usalo quando <b>' + h(u.nome) + '</b> ha perso il telefono e i codici di recupero. Il collegamento con la sua app, i codici di recupero e i computer ricordati si cancellano' +
        (io ? '' : ' e le sue sessioni aperte si chiudono') + '. Al prossimo accesso entra con la sola password' +
        (u.obbligatoria ? ' e il programma gli chiede subito di attivarla di nuovo.' : '; potrà riattivarla quando vuole.'),
        'Azzera', true).then(function (ok) {
        if (!ok) return;
        Api().richiesta('POST', '/api/utenti/' + encodeURIComponent(u.id) + '/2fa/azzera').then(function (r) {
          if (io) aggiornaUtente(r.utente);
          App.avviso('Verifica in due passaggi di ' + u.nome + ' azzerata', 'ok');
          carica();
        }, function (e) { App.avviso(messaggio(e), 'errore'); });
      });
    }

    function disegnaOra() {
      var el = cont.querySelector('#sic-ora');
      var s = Date.parse(stato.oraServer || '');
      var diff = isFinite(s) ? Math.round((Date.now() - s) / 1000) : 0;
      el.innerHTML = Math.abs(diff) >= 90 ? avvisoOra(stato.oraServer) : '';
      el.hidden = !el.innerHTML;
    }

    function disegna() {
      if (!cont.isConnected || !stato) return;
      disegnaOra();
      disegnaCriterio();
      disegnaUtenti();
    }

    function carica() {
      return Api().richiesta('GET', '/api/sicurezza').then(function (r) {
        stato = r;
        disegna();
      }, function (e) {
        if (!cont.isConnected) return;
        cont.querySelector('#sic-criterio .scheda-corpo').innerHTML = '<div class="banda pericolo"><p>Non riesco a leggere lo stato della sicurezza: ' + h(messaggio(e)) + '</p></div>';
        cont.querySelector('#sic-utenti .scheda-corpo').innerHTML = '';
      });
    }

    // ridisegno "leggero" (dopo un nuovo accesso o un aggiornamento): rilegge dal server, la scelta non salvata resta
    App.rinfresca = carica;
    carica();
  };

  App.Sicurezza = Sic;
})(window);
