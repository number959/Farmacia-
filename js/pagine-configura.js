/*
 * Versione 3.0 – parte B (docs/NOVITA-3.0.md): pagina Configura. Sostituisce P.configura di js/pagine.js con lo stesso
 * comportamento (struttura, copie di sicurezza, archivio vuoto) più:
 *  - "Marchio e nome del programma": nomeProdotto, sigla, struttura, sottotitolo, logo ('' = marchio incorporato
 *    brand/marchio.png nel menu e brand/logo.png nell'accesso, 'nessuno', oppure un'immagine caricata),
 *    coloreAccento ('' = rosso del marchio), tema predefinito; l'anteprima è il marchio del menu vero (App.htmlMarchio);
 *  - "Previsioni e ordini": leadTimeGiorni, periodoRevisioneGiorni, livelloServizio, storicoGiorni;
 *  - i reparti non si gestiscono più qui: c'è il collegamento alla pagina Magazzini e assortimento.
 * Ogni salvataggio manda a PUT /api/impostazioni tutti i campi (quelli non toccati con il valore attuale).
 */
(function (root) {
  'use strict';

  var App = root.App;
  var h = App.h;

  // simbolo incorporato come nel menu laterale (impostazione logo = ''); la schermata di accesso usa il logo largo
  function marchio() { return App.MARCHIO || 'brand/marchio.png'; }
  var ACCENTO_PREDEFINITO = '#e10717';
  var TIPI_COPIA = { auto: 'automatica', manuale: 'fatta a mano', 'prima-del-ripristino': 'prima di un ripristino' };
  var LIVELLI_SERVIZIO = [
    [0.9, '90% · scorte più basse, qualche esaurimento in più'],
    [0.95, '95% · consigliato'],
    [0.975, '97,5%'],
    [0.99, '99% · scorte più alte, quasi mai esauriti']
  ];
  var STORICI = [[90, '3 mesi'], [180, '6 mesi (consigliato)'], [365, '1 anno'], [730, '2 anni']];

  function Api() { return root.Api; }

  function scheda(titolo, corpo, extraTesta, stretto, classe) {
    return '<section class="scheda' + (classe ? ' ' + classe : '') + '"><div class="scheda-testa"><h2>' + titolo + '</h2>' + (extraTesta || '') + '</div>' +
      '<div class="scheda-corpo' + (stretto ? ' stretto' : '') + '">' + corpo + '</div></section>';
  }

  function valore(cont, sel) { var el = cont.querySelector(sel); return el ? el.value : ''; }

  function messaggioErrore(e) { return e && e.message ? e.message : String(e); }

  // Scrittura che cambia tutto l'archivio (dati di prova, importazione, ripristino): poi ricarico tutto dal server.
  function scriviERicarica(metodo, percorso, corpo) {
    return Api().richiesta(metodo, percorso, corpo).then(function (r) {
      return Api().sincronizza({ completa: true }).then(function () { return r; });
    });
  }

  /* Importa l'archivio .json salvato dalla versione per un solo PC (solo con l'archivio vuoto). */
  function importaArchivio() {
    App.scegliFileDaLeggere('.json,application/json').then(function (f) {
      if (!f) return;
      return f.text().then(function (testo) {
        var dati;
        try { dati = JSON.parse(testo); } catch (e) { throw new Error('il file non è un archivio .json valido.'); }
        if (!dati || !Array.isArray(dati.articoli) || !Array.isArray(dati.movimenti) || !Array.isArray(dati.reparti)) {
          throw new Error('il file non è un archivio del Gestionale Farmacia (versione per un solo PC).');
        }
        return App.conferma('Importa archivio', 'Importo l’archivio “' + h(f.name) + '” (' + dati.articoli.length + ' articoli, ' + dati.movimenti.length + ' movimenti, ' +
          dati.reparti.length + ' reparti)? Dopo l’importazione <b>tutti gli utenti</b> vedranno questi dati.', 'Importa').then(function (ok) {
          if (!ok) return;
          return scriviERicarica('POST', '/api/importa-archivio', dati).then(function () {
            App.avviso('Archivio importato: ' + App.S.articoli.length + ' articoli e ' + App.S.movimenti.length + ' movimenti', 'ok');
            App.ridisegna();
          });
        });
      });
    }).catch(function (e) { App.avviso('Archivio non importato: ' + messaggioErrore(e), 'errore'); });
  }

  /* Tutte le impostazioni da mandare al server: quelle attuali con le modifiche di una scheda. */
  function impostazioni(modifiche) {
    var i = App.S.impostazioni;
    return Object.assign({
      nomeProdotto: i.nomeProdotto || '', sigla: i.sigla || '', struttura: i.struttura, sottotitolo: i.sottotitolo,
      societa: i.societa, citta: i.citta, logo: i.logo || '', giorniAvvisoScadenza: i.giorniAvvisoScadenza, codiceModulo: i.codiceModulo,
      coloreAccento: i.coloreAccento || '', tema: i.tema || 'automatico',
      leadTimeGiorni: i.leadTimeGiorni, periodoRevisioneGiorni: i.periodoRevisioneGiorni,
      livelloServizio: i.livelloServizio, storicoGiorni: i.storicoGiorni
    }, modifiche);
  }

  function salvaImpostazioni(modifiche, messaggio, ridisegna, bottone) {
    if (bottone) bottone.disabled = true;
    return Api().scrivi('PUT', '/api/impostazioni', impostazioni(modifiche)).then(function () {
      App.disegnaMarchio();
      App.avviso(messaggio, 'ok');
      if (bottone) bottone.disabled = false;
      if (ridisegna) App.ridisegna();
      return true;
    }, function (e) {
      if (bottone) bottone.disabled = false;
      App.avviso('Impostazioni non salvate: ' + messaggioErrore(e), 'errore');
      return false;
    });
  }

  function opzioni(lista, scelto, formato) {
    var dentro = lista.some(function (x) { return Number(x[0]) === Number(scelto); });
    var tutte = dentro || scelto === undefined || scelto === null ? lista : lista.concat([[scelto, formato(scelto)]]);
    return tutte.map(function (x) {
      return '<option value="' + h(x[0]) + '"' + (Number(x[0]) === Number(scelto) ? ' selected' : '') + '>' + h(x[1]) + '</option>';
    }).join('');
  }

  function pianoDi(r) {
    if (r.piano) return r.piano;
    var l = Number(r.livello) || 0;
    return l === 0 ? 'Piano terra' : l === -1 ? 'Seminterrato' : l < 0 ? 'Piano ' + l : l + '° piano';
  }

  App.pagine.configura = function (cont) {
    var imp = App.S.impostazioni;
    var html = '';
    // logo scelto nella pagina: '' marchio incorporato, 'nessuno', oppure l'immagine caricata (data URL)
    var logoScelto = imp.logo || '';
    var immagine = /^data:/.test(imp.logo || '') ? imp.logo : '';

    if (App.puo('impostazioni')) {
      var accento = imp.coloreAccento || '';
      // i magazzini (ex reparti) hanno la loro pagina: qui, in cima, solo il riepilogo e il collegamento.
      // id="k-reparti" resta (giro guidato di Configura): ora è l'elenco dei magazzini attivi.
      var magazzini = App.repartiAttivi().slice().sort(function (a, b) { return (Number(b.livello) || 0) - (Number(a.livello) || 0) || a.ordine - b.ordine; });
      html += scheda('Magazzini e reparti',
        '<div class="cf-mag-riga"><div class="cf-mag-testo">' +
        '<p class="piccolo tenue">Farmacia centrale e magazzini di piano, con i loro armadi e il loro assortimento, si gestiscono dalla pagina <b>Magazzini e assortimento</b>. ' +
        'La farmacia centrale riceve i carichi dai fornitori e rifornisce i magazzini di piano.</p>' +
        '<ul class="cf-magazzini" id="k-reparti">' + magazzini.map(function (r) {
          var centrale = r.tipo === 'centrale' || r.centrale;
          return '<li' + (centrale ? ' class="centrale"' : '') + '><span class="mg-pallino' + (centrale ? ' centrale' : '') + '"' + (r.colore ? ' style="--st-colore:' + h(r.colore) + '"' : '') + ' aria-hidden="true"></span>' +
            '<b>' + h(r.nome) + '</b><span class="tenue">' + h(pianoDi(r)) + (centrale ? ' · farmacia centrale' : '') + '</span></li>';
        }).join('') + '</ul></div>' +
        '<a class="btn primario" href="#magazzini" id="k-vai-magazzini">🏬 Apri Magazzini e assortimento</a></div>',
        '<span class="nota">' + magazzini.length + ' magazzini attivi</span>');

      html += scheda('Marchio e nome del programma',
        '<div class="cf-marchio"><div class="modulo">' +
        '<label class="campo"><span>Nome del programma</span><input id="k-prodotto" maxlength="60" value="' + h(imp.nomeProdotto || '') + '" placeholder="NefroCenter Pharmacy"></label>' +
        '<label class="campo"><span>Sigla (nei menu stretti e nelle stampe)</span><input id="k-sigla" maxlength="20" value="' + h(imp.sigla || '') + '" placeholder="NC Pharmacy"></label>' +
        '<label class="campo"><span>Nome della struttura</span><input id="k-struttura" maxlength="100" value="' + h(imp.struttura) + '"></label>' +
        '<label class="campo"><span>Sottotitolo</span><input id="k-sotto" maxlength="100" value="' + h(imp.sottotitolo) + '"></label>' +
        '<div class="campo largo"><span>Logo</span><div class="cf-loghi" role="radiogroup" aria-label="Logo">' +
        '<label class="cf-logo"><input type="radio" name="k-logo-tipo" value="marchio"' + (logoScelto === '' ? ' checked' : '') + '>' +
        '<span><img src="' + h(marchio()) + '" alt="" class="cf-img-marchio">Marchio della struttura</span></label>' +
        '<label class="cf-logo"><input type="radio" name="k-logo-tipo" value="immagine"' + (immagine && logoScelto === immagine ? ' checked' : '') + (immagine ? '' : ' disabled') + '>' +
        '<span id="k-logo-caricato">' + (immagine ? '<img src="' + h(immagine) + '" alt="">' : '<i class="cf-niente" aria-hidden="true">🖼️</i>') + 'Immagine caricata</span></label>' +
        '<label class="cf-logo"><input type="radio" name="k-logo-tipo" value="nessuno"' + (logoScelto === 'nessuno' ? ' checked' : '') + '>' +
        '<span><i class="cf-niente" aria-hidden="true">✚</i>Nessun logo</span></label>' +
        '</div><div class="strumenti" style="margin-top:8px"><button class="btn piccolo" type="button" id="k-logo">Carica un’immagine…</button>' +
        '<button class="btn piccolo" type="button" id="k-logo-via"' + (immagine ? '' : ' hidden') + '>Togli l’immagine caricata</button>' +
        '<span class="piccolo tenue">PNG, JPEG, WebP o SVG sotto i 400 KB.</span></div></div>' +
        '<div class="campo"><span>Colore d’accento</span><div class="cf-colore">' +
        '<input type="color" id="k-accento" value="' + h(accento || ACCENTO_PREDEFINITO) + '" aria-label="Colore d’accento"' + (accento ? '' : ' disabled') + '>' +
        '<label class="spunta"><input type="checkbox" id="k-accento-predefinito"' + (accento ? '' : ' checked') + '> Rosso del marchio</label></div></div>' +
        '<label class="campo"><span>Tema predefinito</span><select id="k-tema">' +
        [['automatico', 'Automatico'], ['chiaro', 'Chiaro'], ['scuro', 'Scuro']].map(function (t) {
          return '<option value="' + t[0] + '"' + ((imp.tema || 'automatico') === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
        }).join('') + '</select></label>' +
        '</div>' +
        '<div class="cf-anteprima"><span class="piccolo tenue">Anteprima del menu</span><div class="cf-barra" id="k-anteprima"></div>' +
        '<p class="piccolo tenue">Il tema scelto qui vale per chi non ha ancora scelto il suo («Automatico» segue il computer). Nome e logo compaiono anche nella schermata di accesso.</p></div>' +
        '</div>' +
        '<div class="strumenti" style="margin-top:14px"><span class="spazio"></span><button class="btn primario" type="button" id="k-salva">Salva</button></div>');

      html += '<div class="griglia-2">' +
        scheda('Modulo stampato e scadenze',
          '<div class="modulo">' +
          '<label class="campo"><span>Società (sul modulo)</span><input id="k-societa" value="' + h(imp.societa) + '"></label>' +
          '<label class="campo"><span>Città (sul modulo)</span><input id="k-citta" value="' + h(imp.citta) + '"></label>' +
          '<label class="campo"><span>Codice del modulo</span><input id="k-codice" value="' + h(imp.codiceModulo) + '"></label>' +
          '<label class="campo"><span>Avviso scadenze (giorni prima)</span><input id="k-giorni" inputmode="numeric" value="' + h(imp.giorniAvvisoScadenza) + '"></label>' +
          '</div><p class="piccolo tenue" style="margin-top:10px">Società, città e codice compaiono sulla Nota consumi stampata e in Excel. Chi registra i movimenti è l’utente collegato.</p>' +
          '<div class="strumenti" style="margin-top:14px"><span class="spazio"></span><button class="btn primario" type="button" id="k-salva-modulo">Salva</button></div>') +
        scheda('Previsioni e ordini',
          '<div class="modulo">' +
          '<label class="campo"><span>Giorni di consegna del fornitore</span><input id="k-lead" type="number" min="0" max="365" step="1" value="' + h(imp.leadTimeGiorni) + '"></label>' +
          '<label class="campo"><span>Ogni quanti giorni si ordina</span><input id="k-revisione" type="number" min="1" max="365" step="1" value="' + h(imp.periodoRevisioneGiorni) + '"></label>' +
          '<label class="campo"><span>Livello di servizio</span><select id="k-servizio">' + opzioni(LIVELLI_SERVIZIO, imp.livelloServizio, function (v) { return App.fmtNum(v * 100) + '%'; }) + '</select></label>' +
          '<label class="campo"><span>Storico da usare</span><select id="k-storico">' + opzioni(STORICI, imp.storicoGiorni, function (v) { return v + ' giorni'; }) + '</select></label>' +
          '</div><p class="piccolo tenue" style="margin-top:10px">Servono alle <b>previsioni</b> e alla <b>proposta d’ordine</b>: la scorta di sicurezza copre i giorni di consegna; ' +
          'un livello di servizio più alto tiene più scorte e rende più rari gli esaurimenti. Ogni articolo può avere i suoi giorni di consegna nella scheda dell’articolo.</p>' +
          '<div class="strumenti" style="margin-top:14px"><span class="spazio"></span><button class="btn primario" type="button" id="k-salva-previsioni">Salva</button></div>') +
        '</div>';
    }
    if (App.puo('backup')) {
      html += scheda('Copie di sicurezza del server',
        '<div class="guida">' +
        '<p>I dati stanno <b>sul server</b>. Il server copia magazzino e utenti <b>ogni ora</b> (se c’è stato lavoro) e <b>verifica ogni copia</b>; ' +
        'tiene tutte le copie delle ultime 24 ore, poi una al giorno per 14 giorni, una alla settimana per 8 settimane, una al mese per un anno. ' +
        'Prima di ogni ripristino salva anche lo stato del momento, così si può sempre tornare indietro.</p>' +
        '<p class="piccolo tenue">' + (App.paginaPermessa('sistema') ? 'Stato della base dati, controlli e seconda cartella delle copie (un disco esterno o di rete) sono nella pagina <a href="#sistema">Sistema</a>. ' : '') +
        'Qui sotto ci sono le copie del magazzino, da scaricare o ripristinare. Il ripristino cambia i dati per <b>tutti</b> gli utenti.</p>' +
        '<div class="strumenti"><button class="btn primario" type="button" id="k-backup-crea">Crea una copia adesso</button><span class="spazio"></span>' +
        '<button class="btn" type="button" id="k-backup-aggiorna">Aggiorna l’elenco</button></div>' +
        '<div id="k-backup" class="piccolo tenue">Carico l’elenco…</div>' +
        '</div>');
    }
    if (App.eAmministratore() && App.archivioVuoto()) {
      html += scheda('Archivio vuoto: come cominciare',
        '<div class="guida">' +
        '<p>L’archivio non ha ancora articoli né movimenti. Se usavate la <b>versione per un solo PC</b>, importa l’archivio <span class="mono">.json</span> che salvavate da Configura (“Salva una copia”): articoli, reparti, impostazioni e movimenti passano sul server.</p>' +
        '<div class="strumenti"><button class="btn primario" type="button" id="k-importa-archivio">Importa l’archivio della versione per un solo PC (.json)</button>' +
        '<button class="btn" type="button" id="k-demo">Carica dati di prova</button></div>' +
        '<p class="piccolo tenue">Oppure importa gli articoli da Excel dalla pagina <a href="#articoli">Articoli</a>. I dati di prova sono inventati e servono per imparare: si possono caricare solo con l’archivio vuoto.</p>' +
        '</div>');
    }
    cont.innerHTML = html;

    /* ---------- marchio e nome ---------- */
    if (App.puo('impostazioni')) {
      var anteprima = cont.querySelector('#k-anteprima');
      var tipoLogo = function () { var r = cont.querySelector('input[name="k-logo-tipo"]:checked'); return r ? r.value : 'marchio'; };
      var logoDaSalvare = function () {
        var t = tipoLogo();
        return t === 'nessuno' ? 'nessuno' : t === 'immagine' && immagine ? immagine : '';
      };
      var accentoScelto = function () {
        return cont.querySelector('#k-accento-predefinito').checked ? '' : valore(cont, '#k-accento').toLowerCase();
      };
      // lo stesso marchio del menu laterale (App.htmlMarchio): logo, nome del prodotto come titolo, struttura e sottotitolo
      var disegnaAnteprima = function () {
        var acc = accentoScelto();
        // "Rosso del marchio" mentre è salvato un altro colore: l'anteprima mostra comunque il rosso
        var personale = document.documentElement.style.getPropertyValue('--accento');
        if (acc) anteprima.style.setProperty('--accento', acc);
        else if (personale) anteprima.style.setProperty('--accento', 'var(--rosso-marchio, ' + ACCENTO_PREDEFINITO + ')');
        else anteprima.style.removeProperty('--accento');
        var dati = {
          logo: logoDaSalvare(),
          nomeProdotto: valore(cont, '#k-prodotto').trim() || 'NefroCenter Pharmacy',
          struttura: valore(cont, '#k-struttura').trim() || 'Clinica Posillipo',
          sottotitolo: valore(cont, '#k-sotto').trim()
        };
        if (App.htmlMarchio) {
          anteprima.innerHTML = '<div class="marchio" aria-hidden="true">' + App.htmlMarchio(dati) + '</div>' +
            (valore(cont, '#k-sigla').trim() ? '<p class="cf-sigla">Sigla: <b>' + h(valore(cont, '#k-sigla').trim()) + '</b></p>' : '');
          // il marchio incorporato può mancare (per esempio nell'anteprima pubblicata): al suo posto il simbolo neutro
          App.collegaLogo(anteprima);
        }
      };
      var marchioImg = cont.querySelector('.cf-img-marchio');
      if (marchioImg) marchioImg.addEventListener('error', function () { marchioImg.replaceWith(Object.assign(document.createElement('i'), { className: 'cf-niente', textContent: '✚' })); });
      cont.querySelector('.cf-marchio').addEventListener('input', disegnaAnteprima);
      cont.querySelector('.cf-marchio').addEventListener('change', disegnaAnteprima);
      cont.querySelector('#k-accento-predefinito').addEventListener('change', function () {
        cont.querySelector('#k-accento').disabled = this.checked;
      });
      disegnaAnteprima();

      cont.querySelector('#k-logo').addEventListener('click', function () {
        App.scegliFileDaLeggere('image/png,image/jpeg,image/gif,image/webp,image/svg+xml').then(function (f) {
          if (!f) return;
          if (f.size > 400000) { App.avviso('Immagine troppo grande: usa un file sotto i 400 KB.', 'errore'); return; }
          var r = new FileReader();
          r.addEventListener('load', function () {
            immagine = String(r.result || '');
            var radio = cont.querySelector('input[name="k-logo-tipo"][value="immagine"]');
            radio.disabled = false;
            radio.checked = true;
            cont.querySelector('#k-logo-caricato').innerHTML = '<img src="' + h(immagine) + '" alt="">Immagine caricata';
            cont.querySelector('#k-logo-via').hidden = false;
            disegnaAnteprima();
            App.avviso('Immagine pronta: premi Salva per usarla.', 'ok');
          });
          r.readAsDataURL(f);
        });
      });
      cont.querySelector('#k-logo-via').addEventListener('click', function () {
        // senza immagine caricata si torna al marchio della struttura
        salvaImpostazioni({ logo: tipoLogo() === 'nessuno' ? 'nessuno' : '' }, 'Immagine tolta', true);
      });
      cont.querySelector('#k-salva').addEventListener('click', function () {
        var prodotto = valore(cont, '#k-prodotto').trim();
        if (!prodotto) { App.avviso('Scrivi il nome del programma.', 'errore'); return; }
        salvaImpostazioni({
          nomeProdotto: prodotto,
          sigla: valore(cont, '#k-sigla').trim(),
          struttura: valore(cont, '#k-struttura').trim() || 'Clinica Posillipo',
          sottotitolo: valore(cont, '#k-sotto').trim(),
          logo: logoDaSalvare(),
          coloreAccento: accentoScelto(),
          tema: valore(cont, '#k-tema') || 'automatico'
        }, 'Marchio e nome salvati', false, this);
      });
      cont.querySelector('#k-salva-modulo').addEventListener('click', function () {
        salvaImpostazioni({
          societa: valore(cont, '#k-societa').trim(),
          citta: valore(cont, '#k-citta').trim(),
          codiceModulo: valore(cont, '#k-codice').trim(),
          giorniAvvisoScadenza: Math.max(1, Math.round(App.numero(valore(cont, '#k-giorni'))) || 90)
        }, 'Impostazioni del modulo salvate', false, this);
      });
      cont.querySelector('#k-salva-previsioni').addEventListener('click', function () {
        var lead = Math.round(Number(valore(cont, '#k-lead')));
        var rev = Math.round(Number(valore(cont, '#k-revisione')));
        if (!(lead >= 0 && lead <= 365)) { App.avviso('I giorni di consegna vanno da 0 a 365.', 'errore'); return; }
        if (!(rev >= 1 && rev <= 365)) { App.avviso('I giorni fra un ordine e l’altro vanno da 1 a 365.', 'errore'); return; }
        salvaImpostazioni({
          leadTimeGiorni: lead,
          periodoRevisioneGiorni: rev,
          livelloServizio: Number(valore(cont, '#k-servizio')),
          storicoGiorni: Number(valore(cont, '#k-storico'))
        }, 'Impostazioni delle previsioni salvate', false, this);
      });
      cont.querySelector('#k-vai-magazzini').addEventListener('click', function (e) {
        e.preventDefault();
        App.vai('magazzini');
      });
    }

    /* ---------- copie di sicurezza del server ---------- */
    function elencoCopie() {
      var el = cont.querySelector('#k-backup');
      if (!el) return;
      Api().richiesta('GET', '/api/backup').then(function (r) {
        var copie = (r && r.backup) || [];
        if (!document.body.contains(el)) return;
        if (!copie.length) { el.textContent = 'Ancora nessuna copia: la prima automatica si crea entro un’ora, oppure creala adesso.'; return; }
        el.className = '';
        el.innerHTML = '<div class="tabella-contenitore" style="max-height:420px"><table class="tabella"><thead><tr><th>Data</th><th>Tipo</th><th>Verifica</th><th>File</th><th class="n">Dimensione</th><th></th></tr></thead><tbody>' +
          copie.map(function (c, i) {
            // verificata: true (riaperta e controllata), false (non riuscita), null (copia della 2.x non ancora controllata)
            var ver = c.verificata === true ? '<span class="etichetta ok">✓ verificata</span>'
              : c.verificata === false ? '<span class="etichetta pericolo" title="' + h(c.errore || '') + '">✕ non riuscita</span>'
                : '<span class="tenue">da controllare</span>';
            return '<tr><td>' + h(App.fmtDataOra(c.data)) + '</td><td>' + h(TIPI_COPIA[c.tipo] || c.tipo || '') + '</td><td>' + ver + '</td>' +
              '<td class="mono">' + h(c.nome) + '</td><td class="n">' + h(App.fmtDimensione(c.dimensione)) + '</td>' +
              '<td class="azioni"><a class="btn piccolo" href="' + h(Api().url('/api/backup/' + encodeURIComponent(c.nome))) + '" download="' + h(c.nome) + '">Scarica</a> ' +
              '<button class="btn piccolo pericolo" type="button" data-ripristina="' + i + '">Ripristina</button></td></tr>';
          }).join('') + '</tbody></table></div>';
        el.querySelectorAll('[data-ripristina]').forEach(function (b) {
          b.addEventListener('click', function () { ripristinaCopia(copie[Number(b.getAttribute('data-ripristina'))]); });
        });
      }, function (e) {
        el.className = 'piccolo';
        el.innerHTML = '<span style="color:var(--pericolo)">Non riesco a leggere l’elenco delle copie: ' + h(messaggioErrore(e)) + '</span>';
      });
    }
    function ripristinaCopia(c) {
      App.confermaForte('Ripristina una copia di sicurezza',
        'Sostituisco <b>tutti i dati del magazzino</b> con la copia del <b>' + h(App.fmtDataOra(c.data)) + '</b> (' + h(c.nome) + ').<br>' +
        '<b>Tutti gli utenti collegati</b> vedranno subito i dati della copia: quello che è stato registrato dopo quel momento sparisce. ' +
        'Utenti e password non cambiano. Prima del ripristino il server salva una copia dello stato attuale, che resta in questo elenco.',
        'RIPRISTINA', 'Ripristina la copia').then(function (ok) {
        if (!ok) return;
        scriviERicarica('POST', '/api/backup/' + encodeURIComponent(c.nome) + '/ripristina', {}).then(function () {
          App.disegnaMarchio();
          App.avviso('Copia ripristinata: ' + App.S.articoli.length + ' articoli e ' + App.S.movimenti.length + ' movimenti', 'ok');
          App.ridisegna();
        }, function (e) { App.avviso('Ripristino non riuscito: ' + messaggioErrore(e), 'errore'); });
      });
    }
    if (App.puo('backup')) {
      cont.querySelector('#k-backup-crea').addEventListener('click', function () {
        var b = this;
        b.disabled = true;
        Api().richiesta('POST', '/api/backup', {}).then(function (r) {
          App.avviso('Copia creata' + (r && r.nome ? ': ' + r.nome : ''), 'ok');
          elencoCopie();
        }, function (e) { App.avviso('Copia non creata: ' + messaggioErrore(e), 'errore'); }).then(function () { b.disabled = false; });
      });
      cont.querySelector('#k-backup-aggiorna').addEventListener('click', elencoCopie);
      elencoCopie();
    }

    /* ---------- archivio vuoto ---------- */
    var ia = cont.querySelector('#k-importa-archivio');
    if (ia) ia.addEventListener('click', importaArchivio);
    var demo = cont.querySelector('#k-demo');
    if (demo) demo.addEventListener('click', function () { if (App.caricaDemo) App.caricaDemo(); });
  };
})(window);
