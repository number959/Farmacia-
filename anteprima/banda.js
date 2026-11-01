/*
 * ANTEPRIMA: riquadro con gli utenti di prova, il codice della verifica in due passaggi che cambia ogni 30 secondi,
 * un "collega" che registra un consumo (per vedere gli aggiornamenti in tempo reale) e alcuni codici a barre di prova.
 *
 * Non copre mai i pulsanti del programma:
 *   - sulla schermata di accesso galleggia in basso a sinistra (la schermata ha spazio in fondo per scorrere sopra);
 *   - dopo l'accesso entra nel menu laterale, sotto il marchio, come una voce in più (sul telefono è nel menu a scomparsa);
 *   - il codice della verifica in due passaggi compare sotto il campo in cui va scritto (accesso, attivazione,
 *     disattivazione), con il pulsante «Scrivi il codice».
 */
(function () {
  'use strict';
  var A = window.Anteprima;
  if (!A) return;
  // la pagina pubblicata come Artifact viene avvolta in un <html> senza lingua: la lingua serve ai lettori di schermo
  if (!document.documentElement.lang) document.documentElement.lang = 'it';

  function h(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cifre(c) { return c ? c.codice.slice(0, 3) + ' ' + c.codice.slice(3) : '— — —'; }
  function avviso(t, tipo) { if (window.App && App.avviso) App.avviso(t, tipo || 'ok'); }

  var box = document.createElement('section');
  box.className = 'anteprima-banda';
  box.setAttribute('aria-label', 'Anteprima: utenti di prova');
  box.innerHTML =
    '<button type="button" class="anteprima-testa" aria-expanded="false" aria-controls="anteprima-corpo">' +
    '<span aria-hidden="true">🧪</span> <b>Anteprima</b> <span class="anteprima-sotto">utenti e prove</span> <span class="anteprima-freccia" aria-hidden="true">▾</span></button>' +
    '<div class="anteprima-corpo" id="anteprima-corpo" hidden>' +
    '<p>È una prova con dati inventati di una clinica dimostrativa: funziona tutto, ma quello che fai resta in questa pagina e si perde ricaricandola.</p>' +
    '<p><b>Entra con</b> uno di questi utenti, password <code>' + h(A.PASSWORD) + '</code>:</p>' +
    '<ul class="anteprima-utenti">' + A.UTENTI.map(function (u) {
      return '<li><button type="button" data-utente="' + h(u.username) + '"><code>' + h(u.username) + '</code> ' + h(u.nome) + '</button>' +
        '<span class="anteprima-ruolo">' + h(u.etichetta) + (u.magazzini.length ? ' · ' + h(u.magazzini.join(', ')) : '') + '</span>' +
        (u.dueFattori ? '<span class="anteprima-otp" data-otp="' + h(u.username) + '">🔐 Codice dell’app adesso: <b class="anteprima-cifre">— — —</b> <span class="anteprima-restano"></span></span>' : '') +
        '</li>';
    }).join('') + '</ul>' +
    '<p class="anteprima-nota"><b>Verifica in due passaggi:</b> dopo la password il programma chiede il codice di 6 cifre dell’app del telefono, che cambia ogni 30 secondi. Qui il codice compare sotto il campo, con il pulsante «Scrivi il codice». Codice di recupero di prova: <code>' + h(A.RECUPERO) + '</code>.</p>' +
    '<p class="anteprima-mio" hidden></p>' +
    '<p class="anteprima-nota"><b>Da provare:</b> con <code>farma</code> prendi la richiesta urgente della Degenza 1° piano e prepara il DDT; con <code>reparto</code> ricevi il DDT in viaggio; poi Armadi, Previsioni e, da <code>admin</code>, Struttura, Sistema e Sicurezza.</p>' +
    '<p><button type="button" class="anteprima-collega">👥 Un collega registra un consumo</button></p>' +
    '<p class="anteprima-nota">Guarda come cambiano da soli Oggi, Giacenze e la Nota consumi.</p>' +
    '<details class="anteprima-lettore"><summary>Prova il lettore di codici a barre</summary>' +
    '<p class="anteprima-nota">Apri Carico, Consumi o un’altra pagina e tocca un codice:</p>' +
    '<ul class="anteprima-codici">' + A.codiciDiProva.map(function (c, i) {
      return '<li><button type="button" data-codice="' + i + '">▮▌▮ ' + h(c.descrizione) + '</button></li>';
    }).join('') + '</ul>' +
    '<p class="anteprima-nota">Nel programma installato si usa un lettore USB o Bluetooth, oppure la fotocamera di telefono e tablet.</p></details>' +
    '</div>';

  var testa = box.querySelector('.anteprima-testa');
  var corpo = box.querySelector('.anteprima-corpo');
  function aperta() { return !corpo.hidden; }
  function apri(si) {
    corpo.hidden = !si;
    testa.setAttribute('aria-expanded', si ? 'true' : 'false');
    box.classList.toggle('aperta', si);
    if (si) aggiornaCodici();
  }
  testa.addEventListener('click', function () { apri(corpo.hidden); });

  /* ---------- dove sta: sopra la schermata di accesso, oppure nel menu laterale ---------- */

  var accesso = document.getElementById('accesso');
  function accessoVisibile() { return !!accesso && !accesso.hidden; }
  // aperto all'inizio solo se accanto al modulo di accesso (largo circa 440 px, al centro) c'è posto per il riquadro
  function largo() { return !window.matchMedia || window.matchMedia('(min-width: 1240px)').matches; }
  var modo = null;
  function posiziona() {
    var nuovo = accessoVisibile() || !document.getElementById('marchio') ? 'accesso' : 'menu';
    if (nuovo === modo && box.isConnected) return;
    modo = nuovo;
    if (modo === 'accesso') {
      (accesso && accesso.parentNode ? accesso.parentNode : document.body).appendChild(box);
      box.classList.add('fluttuante');
      box.classList.remove('nel-menu');
      apri(largo());
    } else {
      document.getElementById('marchio').insertAdjacentElement('afterend', box);
      box.classList.remove('fluttuante');
      box.classList.add('nel-menu');
      apri(false);
    }
    nonInerte();
  }

  // con la schermata di accesso davanti il programma rende "inerte" tutto il resto della pagina (App.aggiornaInerte):
  // il riquadro deve restare usabile, è da qui che si sceglie l'utente di prova
  function nonInerte() {
    if (modo !== 'accesso') return;
    if (box.inert) box.inert = false;
    if (box.hasAttribute('inert')) box.removeAttribute('inert');
    if (box.hasAttribute('data-inerte-accesso')) box.removeAttribute('data-inerte-accesso');
  }
  if (window.MutationObserver) {
    new MutationObserver(nonInerte).observe(box, { attributes: true, attributeFilter: ['inert', 'data-inerte-accesso'] });
    if (accesso) new MutationObserver(posiziona).observe(accesso, { attributes: true, attributeFilter: ['hidden'] });
    // sullo schermo stretto, sopra la schermata di accesso, il riquadro aperto si chiude quando compare una finestra
    var modale = document.getElementById('modale');
    if (modale) new MutationObserver(function () { if (!modale.hidden && modo === 'accesso' && aperta() && !largo()) apri(false); }).observe(modale, { attributes: true, attributeFilter: ['hidden'] });
  }

  /* ---------- codici della verifica in due passaggi ---------- */

  // sotto i campi del codice: il codice che l'app mostrerebbe adesso, con il pulsante per scriverlo
  var CAMPI_CODICE = [
    { id: 'acc-codice', codice: function () { return A.codiceAccesso(); } },
    { id: 'sic-codice', codice: function () { return A.codiceAttivazione(); } },
    { id: 'sic-codice-dis', codice: function () { return A.codiceMio(); } }
  ];
  function aiutiCodice() {
    CAMPI_CODICE.forEach(function (c) {
      var inp = document.getElementById(c.id);
      if (!inp) return;
      var codice = c.codice();
      var dopo = inp.closest('label') || inp;
      var aiuto = dopo.nextElementSibling && dopo.nextElementSibling.classList.contains('anteprima-aiuto-codice') ? dopo.nextElementSibling : null;
      if (!codice) { if (aiuto) aiuto.remove(); return; }
      if (!aiuto) {
        aiuto = document.createElement('p');
        aiuto.className = 'anteprima-aiuto-codice';
        aiuto.setAttribute('data-per', c.id);
        aiuto.innerHTML = '<span><span aria-hidden="true">🧪</span> Codice dell’app: <b class="anteprima-cifre"></b> <span class="anteprima-restano"></span></span>' +
          '<button type="button" class="btn piccolo">Scrivi il codice</button>';
        aiuto.querySelector('button').addEventListener('click', function () {
          var x = c.codice();
          if (!x || x.usato) return;
          inp.value = x.codice;
          inp.focus();
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        });
        dopo.insertAdjacentElement('afterend', aiuto);
      }
      aiuto.querySelector('.anteprima-cifre').textContent = cifre(codice);
      aiuto.querySelector('button').disabled = !!codice.usato;
      aiuto.querySelector('.anteprima-restano').textContent = codice.usato ? '(già usato: il prossimo tra ' + codice.restano + ' s)' : '(cambia tra ' + codice.restano + ' s)';
    });
  }
  function aggiornaCodici() {
    aiutiCodice();
    if (!aperta()) return;
    Array.prototype.forEach.call(box.querySelectorAll('[data-otp]'), function (el) {
      var c = A.codice(el.getAttribute('data-otp'));
      el.querySelector('.anteprima-cifre').textContent = cifre(c);
      el.querySelector('.anteprima-restano').textContent = c ? '(cambia tra ' + c.restano + ' s)' : '';
    });
    var mio = box.querySelector('.anteprima-mio');
    var chi = A.collegato();
    var c2 = A.codiceMio() || A.codiceAttivazione();
    mio.hidden = !(chi && c2 && chi.username !== 'sicura');
    if (!mio.hidden) mio.innerHTML = '🔐 Il codice dell’app di <b>' + h(chi.nome) + '</b> adesso: <b class="anteprima-cifre">' + h(cifre(c2)) + '</b> (cambia tra ' + c2.restano + ' s)';
  }
  setInterval(function () { if (!document.hidden) aggiornaCodici(); }, 1000);
  posiziona();
  if (window.MutationObserver) {
    var attesa = null;
    var guarda = function () {
      if (attesa) return;
      attesa = setTimeout(function () { attesa = null; aiutiCodice(); }, 30);
    };
    ['accesso', 'modale'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) new MutationObserver(guarda).observe(el, { childList: true, subtree: true });
    });
  }

  /* ---------- marchio neutro ---------- */

  // l'anteprima non ha la cartella brand/: come "marchio incorporato" usa un simbolo neutro (menu, anteprima in Configura)
  if (window.App) {
    App.MARCHIO = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="16" fill="#1C4184"/>' +
      '<path d="M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z" fill="#fff"/></svg>');
  }

  /* ---------- download, stampa e copie nella pagina pubblicata ---------- */

  // nella pagina pubblicata i download diretti sono bloccati: i file Excel passano dalla funzione "downloads"
  // (la chiedo al momento del primo download: window.claude può arrivare dopo il caricamento della pagina)
  var download = null;
  function funzioneDownload() {
    if (download) return download;
    if (!window.claude || typeof window.claude.use !== 'function') return Promise.resolve(null);
    download = window.claude.use('downloads').catch(function () { return null; });
    return download;
  }
  if (window.App) {
    var scaricaNormale = App.scarica;
    App.scarica = function (blob, nome) {
      funzioneDownload().then(function (d) {
        if (!d) return scaricaNormale(blob, nome);
        return d.save({ filename: nome, data: blob }).catch(function (e) {
          if (e && e.code === 'declined') return;
          avviso('Download non riuscito in questa anteprima' + (e && e.code ? ' (' + e.code + ')' : '') + '.', 'errore');
        });
      });
    };
    // nella pagina pubblicata la stampa non si apre: lo dico invece di non fare niente
    var dentroUnaCornice = false;
    try { dentroUnaCornice = window.self !== window.top; } catch (e) { dentroUnaCornice = true; }
    if (window.claude || dentroUnaCornice) {
      window.print = function () {
        avviso('Nell’anteprima la stampa non è disponibile: nel programma installato il pulsante apre la stampa del browser.');
      };
    }
  }

  // le copie di sicurezza dell'anteprima stanno solo nella pagina: "Scarica" non ha un file da dare (nel programma vero sì)
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || !/(^|\/)api\/backup\//.test(a.getAttribute('href'))) return;
    e.preventDefault();
    avviso('Nell’anteprima le copie di sicurezza restano dentro la pagina e non si scaricano: nel programma installato “Scarica” salva il file .db della copia.');
  }, true);

  /* ---------- clic nel riquadro ---------- */

  box.addEventListener('click', function (e) {
    var u = e.target.closest('[data-utente]');
    if (u) {
      var nome = u.getAttribute('data-utente');
      var campoUtente = document.getElementById('acc-user');
      var campoPw = document.getElementById('acc-pw');
      if (accessoVisibile() && campoUtente && campoPw) {
        campoUtente.value = nome;
        campoPw.value = A.PASSWORD;
        var invia = document.getElementById('acc-invia');
        if (invia) invia.click();
        if (!largo()) apri(false);
      } else if (accessoVisibile()) {
        avviso('Per cambiare utente torna al primo passo dell’accesso («Torna indietro»), poi scegli l’utente qui.');
      } else {
        avviso('Per cambiare utente: menu con il tuo nome in alto a destra → Esci, poi scegli l’utente qui.');
      }
      return;
    }
    if (e.target.closest('.anteprima-collega')) {
      if (!window.App || !App.utente) { avviso('Prima entra con un utente.', 'errore'); return; }
      var art = A.collega();
      avviso(art ? 'Luca Infermiere (Degenza 1° piano) ha registrato 1 ' + art : 'Niente da consumare nella Degenza 1° piano');
      return;
    }
    var c = e.target.closest('[data-codice]');
    if (c) {
      if (!window.App || !App.utente) { avviso('Prima entra con un utente.', 'errore'); return; }
      var codice = A.codiciDiProva[Number(c.getAttribute('data-codice'))].codice;
      if (window.Scanner && typeof window.Scanner.elabora === 'function') window.Scanner.elabora(codice, 'lettore');
      else avviso('Il lettore non è disponibile in questa versione.', 'errore');
    }
  });
})();
