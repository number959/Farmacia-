/*
 * ANTEPRIMA: riquadro fisso che spiega che è una prova, con gli utenti di prova,
 * un "collega" che registra un consumo (per vedere gli aggiornamenti in tempo reale)
 * e alcuni codici a barre di prova per il lettore.
 */
(function () {
  'use strict';
  var A = window.Anteprima;
  if (!A) return;

  function h(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var box = document.createElement('div');
  box.className = 'anteprima-banda';
  box.innerHTML =
    '<button type="button" class="anteprima-testa" aria-expanded="false">🧪 <b>Anteprima</b> · utenti e prove <span class="anteprima-freccia">▾</span></button>' +
    '<div class="anteprima-corpo" hidden>' +
    '<p>Questa è una prova del Gestionale Farmacia: funziona tutto, ma i dati restano in questa pagina e spariscono ricaricandola.</p>' +
    '<p><b>Entra con</b> uno di questi utenti, password <code>' + h(A.PASSWORD) + '</code>:</p>' +
    '<ul class="anteprima-utenti">' + A.UTENTI.map(function (u) {
      return '<li><button type="button" data-utente="' + h(u.username) + '"><code>' + h(u.username) + '</code></button> ' + h(u.nome) + ' · <i>' + h(u.ruolo) + '</i></li>';
    }).join('') + '</ul>' +
    '<p><button type="button" class="anteprima-collega">👥 Un collega registra un consumo</button></p>' +
    '<p class="anteprima-nota">Guarda come cambiano da soli Oggi, Giacenze e la Nota consumi.</p>' +
    '<p><b>Prova il lettore di codici a barre</b> (apri Carico, Consumi o un\'altra pagina e tocca un codice):</p>' +
    '<ul class="anteprima-codici">' + A.codiciDiProva.map(function (c, i) {
      return '<li><button type="button" data-codice="' + i + '">▮▌▮ ' + h(c.descrizione) + '</button></li>';
    }).join('') + '</ul>' +
    '<p class="anteprima-nota">Nel programma installato puoi usare un lettore USB o Bluetooth, oppure la fotocamera di telefono e tablet. Un codice sconosciuto si associa a un articolo e da lì in poi viene riconosciuto.</p>' +
    '</div>';
  document.body.appendChild(box);

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
          if (App.avviso) App.avviso('Download non riuscito in questa anteprima' + (e && e.code ? ' (' + e.code + ')' : '') + '.', 'errore');
        });
      });
    };
    // nella pagina pubblicata la stampa non si apre: lo dico invece di non fare niente
    var dentroUnaCornice = false;
    try { dentroUnaCornice = window.self !== window.top; } catch (e) { dentroUnaCornice = true; }
    if (window.claude || dentroUnaCornice) {
      window.print = function () {
        if (App.avviso) App.avviso('Nell’anteprima la stampa non è disponibile: nel programma installato il pulsante apre la stampa del browser.', 'ok');
      };
    }
  }

  var testa = box.querySelector('.anteprima-testa');
  var corpo = box.querySelector('.anteprima-corpo');
  function apri(si) {
    corpo.hidden = !si;
    testa.setAttribute('aria-expanded', si ? 'true' : 'false');
    box.classList.toggle('aperta', si);
  }
  testa.addEventListener('click', function () { apri(corpo.hidden); });
  // all'inizio aperta, così si vedono subito gli utenti di prova; sul telefono chiusa, per non coprire il modulo di accesso
  apri(!window.matchMedia || window.matchMedia('(min-width: 700px)').matches);

  box.addEventListener('click', function (e) {
    var u = e.target.closest('[data-utente]');
    if (u) {
      var campoUtente = document.getElementById('acc-user');
      var campoPw = document.getElementById('acc-pw');
      if (campoUtente && campoPw) {
        campoUtente.value = u.getAttribute('data-utente');
        campoPw.value = A.PASSWORD;
        var invia = document.getElementById('acc-invia');
        if (invia) invia.click();
        apri(false);
      } else if (window.App && App.avviso) {
        App.avviso('Per cambiare utente: menu in alto a destra → Esci, poi scegli l’utente qui.', 'ok');
      }
      return;
    }
    if (e.target.closest('.anteprima-collega')) {
      if (!window.App || !App.utente) { if (window.App && App.avviso) App.avviso('Prima entra con un utente.'); return; }
      var nome = A.collega();
      if (window.App && App.avviso) App.avviso(nome ? 'Luca Infermiere (Degenza) ha registrato 1 ' + nome : 'Niente da consumare in Degenza', 'ok');
      return;
    }
    var c = e.target.closest('[data-codice]');
    if (c) {
      if (!window.App || !App.utente) { if (window.App && App.avviso) App.avviso('Prima entra con un utente.'); return; }
      var codice = A.codiciDiProva[Number(c.getAttribute('data-codice'))].codice;
      if (window.Scanner && typeof window.Scanner.elabora === 'function') window.Scanner.elabora(codice, 'lettore');
      else if (window.App && App.avviso) App.avviso('Il lettore non è disponibile in questa versione.', 'errore');
    }
  });
})();
