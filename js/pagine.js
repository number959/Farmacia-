/*
 * Pagine del Gestionale Farmacia. Ogni pagina riceve il contenitore e i parametri
 * (per esempio { articoloId } quando arriva dalla scheda di un articolo).
 */
(function (root) {
  'use strict';

  var App = root.App;
  var C = root.Calcoli;
  var h = App.h;
  var P = App.pagine;

  /* ======================= componenti comuni ======================= */

  function opzioniReparti(scelto, conTutti) {
    var s = conTutti ? '<option value="">Tutti i reparti</option>' : '';
    return s + App.repartiAttivi().map(function (r) {
      return '<option value="' + h(r.id) + '"' + (r.id === scelto ? ' selected' : '') + '>' + h(r.nome) + (r.centrale ? ' (centrale)' : '') + '</option>';
    }).join('');
  }

  function opzioniCategoria(scelta, conTutte) {
    var s = conTutte ? '<option value="">Farmaci e presidi</option>' : '';
    return s + ['FARMACI', 'PRESIDI'].map(function (c) {
      return '<option value="' + c + '"' + (c === scelta ? ' selected' : '') + '>' + (c === 'FARMACI' ? 'Farmaci' : 'Presidi') + '</option>';
    }).join('');
  }

  function etichettaCategoria(c) {
    return '<span class="etichetta ' + (c === 'PRESIDI' ? 'presidi' : 'farmaci') + '">' + (c === 'PRESIDI' ? 'Presidio' : 'Farmaco') + '</span>';
  }

  function datalistArticoli() {
    var dl = document.getElementById('dl-articoli');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'dl-articoli';
      document.body.appendChild(dl);
    }
    dl.innerHTML = App.articoliAttivi().map(function (a) {
      return '<option value="' + h(a.nome) + '">' + h(a.categoria === 'PRESIDI' ? 'Presidio' : 'Farmaco') + (a.confezione ? ' · ' + h(a.confezione) : '') + '</option>';
    }).join('');
  }

  function datalistFornitori() {
    var visti = {};
    App.S.movimenti.forEach(function (m) { if (m.fornitore) visti[m.fornitore] = true; });
    return '<datalist id="dl-fornitori">' + Object.keys(visti).sort().map(function (f) { return '<option value="' + h(f) + '">'; }).join('') + '</datalist>';
  }

  function scheda(titolo, corpo, extraTesta, stretto) {
    return '<section class="scheda"><div class="scheda-testa"><h2>' + titolo + '</h2>' + (extraTesta || '') + '</div>' +
      '<div class="scheda-corpo' + (stretto ? ' stretto' : '') + '">' + corpo + '</div></section>';
  }

  function vuoto(titolo, testo) {
    return '<div class="vuoto"><b>' + h(titolo) + '</b>' + (testo || '') + '</div>';
  }

  function valore(cont, sel) { var el = cont.querySelector(sel); return el ? el.value : ''; }

  function riferimento(m) {
    var parti = [];
    if (m.tipo === 'trasferimento') parti.push('→ ' + App.nomeReparto(m.repartoDestId));
    if (m.fornitore) parti.push(m.fornitore);
    if (m.documento) parti.push('doc. ' + m.documento);
    if (m.causale) parti.push(m.causale);
    if (m.note) parti.push(m.note);
    if (m.annullato) parti.push('ANNULLATO' + (m.annullato.motivo ? ': ' + m.annullato.motivo : ''));
    return parti.join(' · ');
  }

  function tabellaMovimenti(lista, conAnnulla) {
    if (!lista.length) return vuoto('Nessun movimento', '');
    return '<div class="tabella-contenitore"><table class="tabella"><thead><tr>' +
      '<th>Data</th><th>Tipo</th><th>Articolo</th><th class="n">Quantità</th><th>Lotto</th><th>Scad.</th><th>Reparto</th><th>Riferimento</th><th>Operatore</th>' +
      (conAnnulla ? '<th></th>' : '') + '</tr></thead><tbody>' +
      lista.map(function (m) {
        var a = App.articolo(m.articoloId);
        return '<tr class="' + (m.annullato ? 'annullato' : '') + '">' +
          '<td>' + App.fmtData(m.data) + '</td>' +
          '<td class="tipo-' + m.tipo + '">' + h(App.TIPI[m.tipo] || m.tipo) + '</td>' +
          '<td><a href="#" data-scheda="' + h(m.articoloId) + '">' + h(App.nomeArticolo(m.articoloId)) + '</a></td>' +
          '<td class="n">' + App.fmtNum(m.quantita) + (a && a.unita ? ' <span class="tenue">' + h(a.unita) + '</span>' : '') + '</td>' +
          '<td class="mono">' + h(m.lotto || '') + '</td>' +
          '<td>' + (m.scadenza ? App.fmtScadenza(m.scadenza) : '') + '</td>' +
          '<td>' + h(App.nomeReparto(m.repartoId)) + '</td>' +
          '<td class="piccolo">' + h(riferimento(m)) + '</td>' +
          '<td class="piccolo tenue">' + h(m.operatore || '') + '</td>' +
          (conAnnulla ? '<td class="azioni">' + (m.annullato ? '' : '<button class="btn piccolo pericolo" type="button" data-annulla="' + h(m.id) + '">Annulla</button>') + '</td>' : '') +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  // Collega i pulsanti "Annulla" e i link alle schede articolo di una tabella di movimenti.
  function collegaMovimenti(cont, dopo) {
    cont.addEventListener('click', function (e) {
      var s = e.target.closest('[data-scheda]');
      if (s) { e.preventDefault(); App.schedaArticolo(s.getAttribute('data-scheda')); return; }
      var b = e.target.closest('[data-annulla]');
      if (!b) return;
      var id = b.getAttribute('data-annulla');
      var m = App.S.movimenti.filter(function (x) { return x.id === id; })[0];
      App.chiedi('Annulla movimento', 'Perché annulli “' + (App.TIPI[m.tipo] || m.tipo) + ' di ' + App.fmtNum(m.quantita) + ' · ' + App.nomeArticolo(m.articoloId) + '”? Il movimento resta nell’elenco, barrato.', '', 'Annulla movimento')
        .then(function (motivo) {
          if (motivo === null) return;
          App.annullaMovimento(id, motivo || 'Annullato').then(function () {
            App.avviso('Movimento annullato');
            if (dopo) dopo(); else App.ridisegna();
          });
        });
    });
  }

  function movimentiRecenti(filtro, quanti) {
    return App.S.movimenti.filter(filtro).sort(function (a, b) {
      return (b.creato || 0) - (a.creato || 0);
    }).slice(0, quanti || 30);
  }

  /* ======================= scheda articolo ======================= */

  App.schedaArticolo = function (id) {
    var a = App.articolo(id);
    if (!a) return;
    var g = App.giacenze();
    var oggi = App.oggi();
    var righe = App.S.reparti.filter(function (r) { return g[a.id + '|' + r.id]; }).map(function (r) {
      var lotti = C.lotti(App.S, a.id, r.id).filter(function (l) { return l.quantita !== 0; });
      return '<tr><td><b>' + h(r.nome) + '</b></td><td class="n"><b>' + App.fmtNum(g[a.id + '|' + r.id]) + '</b></td><td>' +
        lotti.map(function (l) {
          var st = App.statoScadenza(C.giorniAllaScadenza(l.scadenza, oggi));
          return '<div class="piccolo">' + (l.lotto ? 'Lotto <span class="mono">' + h(l.lotto) + '</span>' : 'Senza lotto') + ' · ' + App.fmtNum(l.quantita) +
            (l.scadenza ? ' · scade ' + App.fmtScadenza(l.scadenza) + ' <span class="etichetta ' + st.classe + '">' + st.testo + '</span>' : '') + '</div>';
        }).join('') + '</td></tr>';
    }).join('');
    var movs = movimentiRecenti(function (m) { return m.articoloId === a.id; }, 15);
    var info = [
      a.principio ? 'Principio attivo: <b>' + h(a.principio) + '</b>' : '',
      a.confezione ? 'Confezione: <b>' + h(a.confezione) + '</b>' : '',
      a.codice ? 'Codice: <b class="mono">' + h(a.codice) + '</b>' : '',
      a.unita ? 'Unità: <b>' + h(a.unita) + '</b>' : '',
      'Prezzo unitario: <b>' + App.fmtEuro(a.prezzo) + '</b>',
      a.scortaMinima ? 'Scorta minima (' + h(App.repartoCentrale().nome) + '): <b>' + App.fmtNum(a.scortaMinima) + '</b>' : ''
    ].filter(Boolean).join(' · ');
    App.apriModale({
      titolo: a.nome,
      largo: true,
      corpo: '<p>' + etichettaCategoria(a.categoria) + (a.attivo === false ? ' <span class="etichetta">non attivo</span>' : '') +
        (App.sottoScorta(a) ? ' <span class="etichetta pericolo">sotto scorta</span>' : '') + '</p>' +
        '<p class="piccolo">' + info + '</p>' + (a.note ? '<p class="piccolo tenue">' + h(a.note) + '</p>' : '') +
        '<h3>Giacenze e lotti</h3>' +
        (righe ? '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Reparto</th><th class="n">Giacenza</th><th>Lotti</th></tr></thead><tbody>' + righe + '</tbody></table></div>'
          : '<p class="tenue">Nessuna giacenza in nessun reparto.</p>') +
        '<h3>Ultimi movimenti</h3>' + tabellaMovimenti(movs, false),
      piede: '<button class="btn" type="button" id="sa-modifica">Modifica articolo</button><span class="spazio"></span>' +
        '<button class="btn" type="button" data-va="carico">📥 Carico</button>' +
        '<button class="btn" type="button" data-va="trasferimenti">🔁 Trasferisci</button>' +
        '<button class="btn" type="button" data-va="perdite">🗑️ Perdita</button>' +
        '<button class="btn primario" type="button" data-chiudi>Chiudi</button>',
      dopo: function (m) {
        m.querySelector('#sa-modifica').addEventListener('click', function () { App.chiudiModale(); App.formArticolo(a.id); });
        m.querySelectorAll('[data-va]').forEach(function (b) {
          b.addEventListener('click', function () { App.chiudiModale(); App.vai(b.getAttribute('data-va'), { articoloId: a.id }); });
        });
        m.querySelectorAll('[data-scheda]').forEach(function (l) {
          l.addEventListener('click', function (e) { e.preventDefault(); });
        });
      }
    });
  };

  /* ======================= anagrafica articolo ======================= */

  App.formArticolo = function (id, dopo) {
    var a = id ? App.articolo(id) : { categoria: 'FARMACI', attivo: true };
    var unita = ['cpr', 'cps', 'fl', 'f', 'bustine', 'ml', 'flacone', 'tubo', 'conf', 'pz', 'paia', 'rotolo', 'sacca'];
    App.apriModale({
      titolo: id ? 'Modifica articolo' : 'Nuovo articolo',
      corpo: '<div class="modulo">' +
        '<label class="campo largo"><span>Denominazione *</span><input id="fa-nome" value="' + h(a.nome || '') + '" placeholder="Es. PARACETAMOLO 1000 mg/100 ml flaconcino"></label>' +
        '<label class="campo"><span>Categoria</span><select id="fa-cat">' + opzioniCategoria(a.categoria) + '</select></label>' +
        '<label class="campo"><span>Unità di misura</span><input id="fa-unita" list="dl-unita" value="' + h(a.unita || '') + '" placeholder="cpr, fl, pz…"></label>' +
        '<datalist id="dl-unita">' + unita.map(function (u) { return '<option value="' + u + '">'; }).join('') + '</datalist>' +
        '<label class="campo"><span>Principio attivo</span><input id="fa-principio" value="' + h(a.principio || '') + '"></label>' +
        '<label class="campo"><span>Confezione / formato</span><input id="fa-confezione" value="' + h(a.confezione || '') + '" placeholder="Es. 10 fl da 100 ml"></label>' +
        '<label class="campo"><span>Codice (AIC / minsan / interno)</span><input id="fa-codice" value="' + h(a.codice || '') + '"></label>' +
        '<label class="campo"><span>Prezzo unitario €</span><input id="fa-prezzo" inputmode="decimal" value="' + (a.prezzo ? String(a.prezzo).replace('.', ',') : '') + '"></label>' +
        '<label class="campo"><span>Scorta minima in ' + h(App.repartoCentrale().nome) + '</span><input id="fa-scorta" inputmode="decimal" value="' + (a.scortaMinima || '') + '"></label>' +
        '<label class="campo largo"><span>Note</span><textarea id="fa-note">' + h(a.note || '') + '</textarea></label>' +
        '<label class="spunta"><input type="checkbox" id="fa-attivo"' + (a.attivo !== false ? ' checked' : '') + '> Articolo attivo (si può caricare e scaricare)</label>' +
        '</div>',
      piede: (id ? '<button class="btn pericolo" type="button" id="fa-elimina">Elimina</button><span class="spazio"></span>' : '') +
        '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="fa-salva">Salva</button>',
      dopo: function (m) {
        m.querySelector('#fa-salva').addEventListener('click', function () {
          var nome = valore(m, '#fa-nome').trim();
          if (!nome) { App.avviso('Scrivi la denominazione.', 'errore'); return; }
          var doppio = App.articoloPerNome(nome);
          if (doppio && doppio.id !== id) { App.avviso('Esiste già un articolo con questo nome.', 'errore'); return; }
          var dati = {
            nome: nome,
            categoria: valore(m, '#fa-cat'),
            unita: valore(m, '#fa-unita').trim(),
            principio: valore(m, '#fa-principio').trim(),
            confezione: valore(m, '#fa-confezione').trim(),
            codice: valore(m, '#fa-codice').trim(),
            prezzo: App.numero(valore(m, '#fa-prezzo')),
            scortaMinima: App.numero(valore(m, '#fa-scorta')),
            note: valore(m, '#fa-note').trim(),
            attivo: m.querySelector('#fa-attivo').checked
          };
          var nuovoId = id;
          if (id) Object.assign(App.articolo(id), dati);
          else { nuovoId = App.id('a'); App.S.articoli.push(Object.assign({ id: nuovoId }, dati)); }
          App.salva().then(function () {
            App.chiudiModale();
            App.avviso(id ? 'Articolo aggiornato' : 'Articolo creato', 'ok');
            datalistArticoli();
            if (dopo) dopo(nuovoId); else App.ridisegna();
          });
        });
        var el = m.querySelector('#fa-elimina');
        if (el) el.addEventListener('click', function () {
          var usato = App.S.movimenti.some(function (x) { return x.articoloId === id; });
          if (usato) {
            App.avviso('L’articolo ha dei movimenti: non si può eliminare. Togli la spunta “Articolo attivo” per nasconderlo.', 'errore');
            return;
          }
          App.conferma('Elimina articolo', 'Elimino “' + h(a.nome) + '” dall’anagrafica?', 'Elimina', true).then(function (ok) {
            if (!ok) return;
            App.S.articoli = App.S.articoli.filter(function (x) { return x.id !== id; });
            App.salva().then(function () { App.avviso('Articolo eliminato'); App.ridisegna(); });
          });
        });
      }
    });
  };

  /* ======================= OGGI ======================= */

  P.oggi = function (cont) {
    var S = App.S;
    var oggi = App.oggi();
    var attivi = App.articoliAttivi();
    var sotto = attivi.filter(App.sottoScorta);
    var lotti = App.lottiInGiacenza();
    var soglia = S.impostazioni.giorniAvvisoScadenza || 90;
    var scaduti = lotti.filter(function (l) { return l.giorni !== null && l.giorni < 0; });
    var inScadenza = lotti.filter(function (l) { return l.giorni !== null && l.giorni >= 0 && l.giorni <= soglia; });
    var diOggi = movimentiRecenti(function (m) { return m.data === oggi && !m.annullato; }, 200);

    var html = '';
    if (!S.articoli.length) {
      html += '<div class="banda info"><p><b>Benvenuto nel Gestionale Farmacia.</b> Per cominciare inserisci gli articoli (o importali da Excel), ' +
        'controlla i reparti in Configura e registra le giacenze iniziali con un carico. Per provare il programma puoi caricare i dati di prova.</p>' +
        '<a class="btn primario" href="#articoli">Vai agli articoli</a><button class="btn" type="button" id="oggi-demo">Carica dati di prova</button></div>';
    }
    var giorniCopia = S.ultimaEsportazione ? Math.round((Date.now() - new Date(S.ultimaEsportazione).getTime()) / 86400000) : null;
    if (S.articoli.length && (giorniCopia === null || giorniCopia >= 7)) {
      html += '<div class="banda attenzione"><p>' + (giorniCopia === null ? 'Non hai ancora salvato una copia dell’archivio fuori dal programma.' : 'L’ultima copia dell’archivio su file è di ' + giorniCopia + ' giorni fa.') +
        ' Salvane una su una chiavetta o in una cartella di rete: se il browser venisse ripulito, i dati si recuperano da lì.</p>' +
        '<button class="btn primario" type="button" id="oggi-copia">Salva una copia adesso</button></div>';
    }

    html += '<div class="azioni-rapide">' +
      '<a class="btn primario" href="#consumi">💊 Registra i consumi<kbd>S</kbd></a>' +
      '<a class="btn" href="#carico">📥 Nuovo carico<kbd>C</kbd></a>' +
      '<a class="btn" href="#trasferimenti">🔁 Trasferisci a un reparto<kbd>T</kbd></a>' +
      '<a class="btn" href="#registro">📅 Nota consumi del mese<kbd>R</kbd></a>' +
      '</div>';

    html += '<div class="indicatori">' +
      '<a class="indicatore" href="#articoli"><span class="titolo">Articoli attivi</span><span class="valore">' + attivi.length + '</span><span class="piccolo tenue">' +
      attivi.filter(function (a) { return a.categoria === 'FARMACI'; }).length + ' farmaci · ' + attivi.filter(function (a) { return a.categoria === 'PRESIDI'; }).length + ' presidi</span></a>' +
      '<a class="indicatore ' + (sotto.length ? 'pericolo' : 'ok') + '" href="#giacenze" data-sotto><span class="titolo">Sotto scorta minima</span><span class="valore">' + sotto.length + '</span><span class="piccolo tenue">nel reparto ' + h(App.repartoCentrale() ? App.repartoCentrale().nome : '') + '</span></a>' +
      '<a class="indicatore ' + (scaduti.length ? 'pericolo' : 'ok') + '" href="#scadenze"><span class="titolo">Lotti scaduti ancora in giacenza</span><span class="valore">' + scaduti.length + '</span><span class="piccolo tenue">da togliere e registrare come perdita</span></a>' +
      '<a class="indicatore ' + (inScadenza.length ? 'attenzione' : 'ok') + '" href="#scadenze"><span class="titolo">Lotti in scadenza</span><span class="valore">' + inScadenza.length + '</span><span class="piccolo tenue">entro ' + soglia + ' giorni</span></a>' +
      '</div>';

    var urgenti = scaduti.concat(inScadenza).sort(function (a, b) { return a.giorni - b.giorni; }).slice(0, 8);
    var colSx = scheda('Da controllare',
      (sotto.length || urgenti.length) ? '<ul class="elenco-semplice">' +
        sotto.slice(0, 8).map(function (a) {
          return '<li><span class="etichetta pericolo">sotto scorta</span><span class="chi"><a href="#" data-scheda="' + h(a.id) + '">' + h(a.nome) + '</a></span>' +
            '<span class="tenue">' + App.fmtNum(App.giacenza(a.id, App.repartoCentrale().id)) + ' su ' + App.fmtNum(a.scortaMinima) + '</span></li>';
        }).join('') +
        urgenti.map(function (l) {
          var st = App.statoScadenza(l.giorni);
          return '<li><span class="etichetta ' + st.classe + '">' + (l.giorni < 0 ? 'scaduto' : 'scade ' + App.fmtScadenza(l.scadenza)) + '</span>' +
            '<span class="chi"><a href="#" data-scheda="' + h(l.articolo.id) + '">' + h(l.articolo.nome) + '</a> <span class="tenue">· ' + h(l.reparto.nome) + (l.lotto ? ' · lotto ' + h(l.lotto) : '') + '</span></span>' +
            '<span class="tenue">' + App.fmtNum(l.quantita) + '</span></li>';
        }).join('') + '</ul>'
        : vuoto('Tutto in ordine', 'Nessun articolo sotto scorta e nessun lotto in scadenza.'), '', true);

    var perTipo = {};
    diOggi.forEach(function (m) { perTipo[m.tipo] = (perTipo[m.tipo] || 0) + 1; });
    var riepilogo = Object.keys(perTipo).map(function (t) { return App.TIPI[t] + ': ' + perTipo[t]; }).join(' · ');
    var elencoOggi = '<ul class="elenco-semplice">' + diOggi.slice(0, 12).map(function (m) {
      var a = App.articolo(m.articoloId) || {};
      return '<li><span class="tipo-' + m.tipo + '" style="min-width:96px">' + h(App.TIPI[m.tipo]) + '</span>' +
        '<span class="chi"><a href="#" data-scheda="' + h(m.articoloId) + '">' + h(a.nome || '') + '</a> <span class="tenue">· ' + h(App.nomeReparto(m.repartoId)) +
        (m.tipo === 'trasferimento' ? ' → ' + h(App.nomeReparto(m.repartoDestId)) : '') + '</span></span>' +
        '<span><b>' + App.fmtNum(m.quantita) + '</b> <span class="tenue">' + h(a.unita || '') + '</span></span></li>';
    }).join('') + '</ul>' + (diOggi.length > 12 ? '<p class="piccolo tenue" style="padding:8px 18px">e altri ' + (diOggi.length - 12) + ': <a href="#movimenti">vedi tutti i movimenti</a></p>' : '');
    var colDx = scheda('Movimenti di oggi', diOggi.length ? elencoOggi : vuoto('Nessun movimento oggi', 'I consumi si registrano da “Consumi del giorno”.'),
      riepilogo ? '<span class="nota">' + h(riepilogo) + '</span>' : '', true);

    html += '<div class="griglia-2">' + colSx + colDx + '</div>';
    cont.innerHTML = html;

    cont.addEventListener('click', function (e) {
      var s = e.target.closest('[data-scheda]');
      if (s) { e.preventDefault(); App.schedaArticolo(s.getAttribute('data-scheda')); }
      if (e.target.closest('[data-sotto]')) { e.preventDefault(); App.vai('giacenze', { soloSotto: true }); }
    });
    var demo = cont.querySelector('#oggi-demo');
    if (demo) demo.addEventListener('click', function () { App.caricaDemo(); });
    var copia = cont.querySelector('#oggi-copia');
    if (copia) copia.addEventListener('click', function () { App.esportaArchivio(); });
  };

  /* ======================= moduli a righe: carico, trasferimenti, perdite ======================= */

  /*
   * cfg: { tipo, titolo, testata(html), colonne: ['lotto'|'scadenza'|'prezzo'|'lotto-scelta'|'causale'|'note'],
   *        repartoOrigine(cont), leggiTestata(cont), recenti(filtro) }
   */
  function moduloRighe(cont, cfg, parametri) {
    datalistArticoli();
    var col = cfg.colonne;
    var intest = '<th style="min-width:260px">Articolo</th><th>Quantità</th>' +
      (col.indexOf('lotto') >= 0 ? '<th>Lotto</th>' : '') +
      (col.indexOf('scadenza') >= 0 ? '<th>Scadenza</th>' : '') +
      (col.indexOf('prezzo') >= 0 ? '<th>Prezzo unit. €</th>' : '') +
      (col.indexOf('lotto-scelta') >= 0 ? '<th>Lotto</th>' : '') +
      (col.indexOf('causale') >= 0 ? '<th>Causale</th>' : '') +
      (col.indexOf('note') >= 0 ? '<th>Note</th>' : '') + '<th></th>';

    cont.innerHTML = scheda(cfg.titolo,
      '<div class="modulo">' + cfg.testata + '</div>' +
      '<div class="tabella-contenitore" style="margin-top:16px"><table class="righe"><thead><tr>' + intest + '</tr></thead><tbody id="righe"></tbody></table></div>' +
      '<div class="strumenti" style="margin-top:12px"><button class="btn" type="button" id="riga-piu">+ Aggiungi riga</button>' +
      '<button class="btn" type="button" id="nuovo-art">Nuovo articolo</button><span class="spazio"></span>' +
      '<button class="btn primario" type="button" id="registra">' + h(cfg.pulsante) + '</button></div>',
      '<span class="nota">' + h(cfg.nota || '') + '</span>') +
      '<div id="recenti"></div>' + (cfg.extra || '');

    var tbody = cont.querySelector('#righe');

    function opzioniLotti(articoloId) {
      var rep = cfg.repartoOrigine(cont);
      if (!articoloId || !rep) return '<option value="">automatico</option>';
      var l = C.lotti(App.S, articoloId, rep).filter(function (x) { return x.quantita > 0 && x.lotto; });
      return '<option value="">automatico (scade prima)</option>' + l.map(function (x) {
        return '<option value="' + h(x.lotto) + '">' + h(x.lotto) + ' · ' + App.fmtNum(x.quantita) + (x.scadenza ? ' · ' + App.fmtScadenza(x.scadenza) : '') + '</option>';
      }).join('');
    }

    function aggiornaInfo(tr) {
      var a = App.articoloPerNome(tr.querySelector('.r-art').value);
      var info = tr.querySelector('.info-riga');
      var rep = cfg.repartoOrigine(cont);
      if (!tr.querySelector('.r-art').value.trim()) { info.textContent = ''; return; }
      if (!a) { info.innerHTML = '<span style="color:var(--pericolo)">Articolo non in anagrafica</span>'; return; }
      info.textContent = (a.categoria === 'PRESIDI' ? 'Presidio' : 'Farmaco') + (rep ? ' · in ' + App.nomeReparto(rep) + ': ' + App.fmtNum(App.giacenza(a.id, rep)) + (a.unita ? ' ' + a.unita : '') : '');
      var sel = tr.querySelector('.r-lotto-scelta');
      if (sel && sel.getAttribute('data-per') !== a.id) { sel.innerHTML = opzioniLotti(a.id); sel.setAttribute('data-per', a.id); }
      var pr = tr.querySelector('.r-prezzo');
      if (pr && !pr.value && a.prezzo) pr.value = String(a.prezzo).replace('.', ',');
    }

    function nuovaRiga(articoloId) {
      var a = articoloId ? App.articolo(articoloId) : null;
      var tr = document.createElement('tr');
      tr.innerHTML = '<td><input class="r-art" list="dl-articoli" placeholder="Scrivi le prime lettere…" value="' + h(a ? a.nome : '') + '"><div class="info-riga"></div></td>' +
        '<td><input class="q r-q" inputmode="decimal" placeholder="0"></td>' +
        (col.indexOf('lotto') >= 0 ? '<td><input class="r-lotto" placeholder="Lotto"></td>' : '') +
        (col.indexOf('scadenza') >= 0 ? '<td><input class="r-scad" type="month"></td>' : '') +
        (col.indexOf('prezzo') >= 0 ? '<td><input class="r-prezzo" inputmode="decimal" style="width:100px"></td>' : '') +
        (col.indexOf('lotto-scelta') >= 0 ? '<td><select class="r-lotto-scelta">' + opzioniLotti(articoloId) + '</select></td>' : '') +
        (col.indexOf('causale') >= 0 ? '<td><select class="r-causale">' + App.CAUSALI_PERDITA.map(function (c) { return '<option>' + h(c) + '</option>'; }).join('') + '</select></td>' : '') +
        (col.indexOf('note') >= 0 ? '<td><input class="r-note"></td>' : '') +
        '<td><button class="btn fantasma piccolo" type="button" data-togli title="Togli la riga">✕</button></td>';
      tbody.appendChild(tr);
      if (a) aggiornaInfo(tr);
      return tr;
    }

    tbody.addEventListener('input', function (e) {
      if (e.target.classList.contains('r-art')) aggiornaInfo(e.target.closest('tr'));
    });
    tbody.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        var tr = e.target.closest('tr');
        if (!tr.nextElementSibling) nuovaRiga().querySelector('.r-art').focus();
        else tr.nextElementSibling.querySelector('.r-art').focus();
      }
    });
    tbody.addEventListener('click', function (e) {
      var b = e.target.closest('[data-togli]');
      if (!b) return;
      b.closest('tr').remove();
      if (!tbody.children.length) nuovaRiga();
    });
    cont.querySelector('#riga-piu').addEventListener('click', function () { nuovaRiga().querySelector('.r-art').focus(); });
    cont.querySelector('#nuovo-art').addEventListener('click', function () {
      App.formArticolo(null, function (id) {
        var vuota = Array.prototype.filter.call(tbody.querySelectorAll('.r-art'), function (i) { return !i.value.trim(); })[0];
        var tr = vuota ? vuota.closest('tr') : nuovaRiga();
        tr.querySelector('.r-art').value = App.articolo(id).nome;
        aggiornaInfo(tr);
        tr.querySelector('.r-q').focus();
      });
    });
    cont.querySelectorAll('.cambia-origine').forEach(function (el) {
      el.addEventListener('change', function () {
        tbody.querySelectorAll('tr').forEach(function (tr) {
          var sel = tr.querySelector('.r-lotto-scelta');
          if (sel) sel.removeAttribute('data-per');
          aggiornaInfo(tr);
        });
      });
    });

    if (parametri.articoloId) nuovaRiga(parametri.articoloId);
    nuovaRiga();
    if (parametri.articoloId) tbody.querySelector('.r-q').focus();

    function leggiRighe() {
      var righe = [];
      var errori = [];
      tbody.querySelectorAll('tr').forEach(function (tr, i) {
        var nome = tr.querySelector('.r-art').value.trim();
        var q = App.numero(tr.querySelector('.r-q').value);
        if (!nome && !q) return;
        var a = App.articoloPerNome(nome);
        if (!a) { errori.push('Riga ' + (i + 1) + ': “' + nome + '” non è in anagrafica (usa “Nuovo articolo”).'); return; }
        if (q <= 0) { errori.push('Riga ' + (i + 1) + ': manca la quantità.'); return; }
        var r = { articolo: a, quantita: q };
        var el;
        if ((el = tr.querySelector('.r-lotto'))) r.lotto = el.value.trim();
        if ((el = tr.querySelector('.r-scad'))) r.scadenza = el.value;
        if ((el = tr.querySelector('.r-prezzo'))) r.prezzo = el.value.trim() ? App.numero(el.value) : null;
        if ((el = tr.querySelector('.r-lotto-scelta'))) r.lottoScelto = el.value;
        if ((el = tr.querySelector('.r-causale'))) r.causale = el.value;
        if ((el = tr.querySelector('.r-note'))) r.note = el.value.trim();
        righe.push(r);
      });
      return { righe: righe, errori: errori };
    }

    cont.querySelector('#registra').addEventListener('click', function () {
      var testata = cfg.leggiTestata(cont);
      if (testata.errore) { App.avviso(testata.errore, 'errore'); return; }
      var lette = leggiRighe();
      if (lette.errori.length) { App.avviso(lette.errori[0], 'errore'); return; }
      if (!lette.righe.length) { App.avviso('Compila almeno una riga.', 'errore'); return; }
      var movimenti = cfg.prepara(testata, lette.righe);
      var scoperti = cfg.controllaGiacenza ? lette.righe.filter(function (r) {
        return r.quantita > App.giacenza(r.articolo.id, testata.repartoId);
      }) : [];
      var procedi = scoperti.length
        ? App.conferma('Giacenza insufficiente', 'In ' + h(App.nomeReparto(testata.repartoId)) + ' non c’è abbastanza giacenza per: <b>' +
          scoperti.map(function (r) { return h(r.articolo.nome); }).join(', ') + '</b>. Registro lo stesso? La giacenza diventerà negativa finché non registri il carico mancante.', 'Registra lo stesso')
        : Promise.resolve(true);
      procedi.then(function (ok) {
        if (!ok) return;
        App.aggiungiMovimenti(movimenti).then(function () {
          App.avviso(cfg.fatto(lette.righe.length), 'ok');
          App.mostra(App.paginaCorrente);
        });
      });
    });

    function disegnaRecenti() {
      var lista = movimentiRecenti(cfg.recenti, 25);
      cont.querySelector('#recenti').innerHTML = scheda(cfg.titoloRecenti, tabellaMovimenti(lista, true), '', true);
    }
    disegnaRecenti();
    collegaMovimenti(cont.querySelector('#recenti'), function () { disegnaRecenti(); });
  }

  /* ======================= CARICO ======================= */

  P.carico = function (cont, par) {
    var centrale = App.repartoCentrale();
    moduloRighe(cont, {
      titolo: 'Nuovo carico',
      nota: 'Merce arrivata dal fornitore. Lotto e scadenza servono per il controllo scadenze.',
      pulsante: 'Registra carico',
      testata:
        '<label class="campo"><span>Data</span><input type="date" id="t-data" value="' + App.oggi() + '"></label>' +
        '<label class="campo"><span>Reparto che riceve</span><select id="t-rep" class="cambia-origine">' + opzioniReparti(centrale && centrale.id) + '</select></label>' +
        '<label class="campo"><span>Fornitore</span><input id="t-forn" list="dl-fornitori" placeholder="Es. grossista, deposito…">' + datalistFornitori() + '</label>' +
        '<label class="campo"><span>Documento (DDT / fattura n.)</span><input id="t-doc"></label>',
      colonne: ['lotto', 'scadenza', 'prezzo'],
      repartoOrigine: function (c) { return valore(c, '#t-rep'); },
      leggiTestata: function (c) {
        var t = { data: valore(c, '#t-data'), repartoId: valore(c, '#t-rep'), fornitore: valore(c, '#t-forn').trim(), documento: valore(c, '#t-doc').trim() };
        if (!t.data) t.errore = 'Indica la data del carico.';
        return t;
      },
      prepara: function (t, righe) {
        return righe.map(function (r) {
          if (r.prezzo !== null && r.prezzo !== undefined && r.prezzo !== r.articolo.prezzo) r.articolo.prezzo = r.prezzo;
          return { tipo: 'carico', data: t.data, articoloId: r.articolo.id, repartoId: t.repartoId, quantita: r.quantita, lotto: r.lotto || '', scadenza: r.scadenza || '', fornitore: t.fornitore, documento: t.documento, prezzo: r.prezzo || undefined };
        });
      },
      fatto: function (n) { return 'Carico registrato (' + n + (n === 1 ? ' articolo)' : ' articoli)'); },
      titoloRecenti: 'Ultimi carichi',
      recenti: function (m) { return m.tipo === 'carico'; }
    }, par);
  };

  /* ======================= TRASFERIMENTI ======================= */

  P.trasferimenti = function (cont, par) {
    var centrale = App.repartoCentrale();
    var altri = App.repartiAttivi().filter(function (r) { return r.id !== (centrale && centrale.id); });
    moduloRighe(cont, {
      titolo: 'Trasferimento tra reparti',
      nota: 'Per esempio dalla Farmacia ai reparti: per la Farmacia è uno scarico, per il reparto un carico.',
      pulsante: 'Registra trasferimento',
      testata:
        '<label class="campo"><span>Data</span><input type="date" id="t-data" value="' + App.oggi() + '"></label>' +
        '<label class="campo"><span>Da</span><select id="t-da" class="cambia-origine">' + opzioniReparti(centrale && centrale.id) + '</select></label>' +
        '<label class="campo"><span>A</span><select id="t-a">' + opzioniReparti(altri[0] && altri[0].id) + '</select></label>' +
        '<label class="campo"><span>Note (richiesta n., chi ritira…)</span><input id="t-note"></label>',
      colonne: ['lotto-scelta'],
      controllaGiacenza: true,
      repartoOrigine: function (c) { return valore(c, '#t-da'); },
      leggiTestata: function (c) {
        var t = { data: valore(c, '#t-data'), repartoId: valore(c, '#t-da'), repartoDestId: valore(c, '#t-a'), note: valore(c, '#t-note').trim() };
        if (!t.data) t.errore = 'Indica la data.';
        else if (t.repartoId === t.repartoDestId) t.errore = 'Il reparto di partenza e quello di arrivo sono uguali.';
        return t;
      },
      prepara: function (t, righe) {
        var out = [];
        righe.forEach(function (r) {
          out = out.concat(App.preparaUscita('trasferimento', { data: t.data, articoloId: r.articolo.id, repartoId: t.repartoId, repartoDestId: t.repartoDestId, quantita: r.quantita, lotto: r.lottoScelto, note: t.note }));
        });
        return out;
      },
      fatto: function (n) { return 'Trasferimento registrato (' + n + (n === 1 ? ' articolo)' : ' articoli)'); },
      titoloRecenti: 'Ultimi trasferimenti',
      recenti: function (m) { return m.tipo === 'trasferimento'; }
    }, par);
  };

  /* ======================= PERDITE ======================= */

  P.perdite = function (cont, par) {
    var rep = par.repartoId || (App.repartoCentrale() && App.repartoCentrale().id);
    moduloRighe(cont, {
      titolo: 'Perdite, scaduti e resi',
      nota: 'Nel registro mensile finiscono nella colonna “Perdite”.',
      pulsante: 'Registra perdita',
      testata:
        '<label class="campo"><span>Data</span><input type="date" id="t-data" value="' + App.oggi() + '"></label>' +
        '<label class="campo"><span>Reparto</span><select id="t-rep" class="cambia-origine">' + opzioniReparti(rep) + '</select></label>',
      colonne: ['lotto-scelta', 'causale', 'note'],
      controllaGiacenza: true,
      repartoOrigine: function (c) { return valore(c, '#t-rep'); },
      leggiTestata: function (c) {
        var t = { data: valore(c, '#t-data'), repartoId: valore(c, '#t-rep') };
        if (!t.data) t.errore = 'Indica la data.';
        return t;
      },
      prepara: function (t, righe) {
        var out = [];
        righe.forEach(function (r) {
          out = out.concat(App.preparaUscita('perdita', { data: t.data, articoloId: r.articolo.id, repartoId: t.repartoId, quantita: r.quantita, lotto: r.lottoScelto, causale: r.causale, note: r.note }));
        });
        return out;
      },
      fatto: function () { return 'Perdita registrata'; },
      titoloRecenti: 'Ultime perdite',
      recenti: function (m) { return m.tipo === 'perdita'; }
    }, par);
    // arrivo dalla pagina Scadenze: lotto scaduto già scelto
    if (par.lotto && par.articoloId) {
      var tr = cont.querySelector('#righe tr');
      var sel = tr.querySelector('.r-lotto-scelta');
      sel.value = par.lotto;
      tr.querySelector('.r-q').value = App.fmtNum(par.quantita || '');
      tr.querySelector('.r-causale').value = 'Scaduto';
    }
  };

  /* ======================= CONSUMI DEL GIORNO ======================= */

  var memoriaConsumi = {};

  P.consumi = function (cont, par) {
    var rep = memoriaConsumi.rep || (App.repartiAttivi().filter(function (r) { return !r.centrale; })[0] || App.repartoCentrale()).id;
    var data = memoriaConsumi.data || App.oggi();
    var cat = memoriaConsumi.cat || '';
    var tutti = !!memoriaConsumi.tutti;

    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Data</span><input type="date" id="c-data" value="' + data + '"></label>' +
      '<label class="campo"><span>Reparto</span><select id="c-rep">' + opzioniReparti(rep) + '</select></label>' +
      '<label class="campo"><span>Categoria</span><select id="c-cat">' + opzioniCategoria(cat, true) + '</select></label>' +
      '<label class="campo"><span>Cerca</span><input id="c-cerca" type="search" placeholder="Filtra per nome…"></label>' +
      '<label class="spunta"><input type="checkbox" id="c-tutti"' + (tutti ? ' checked' : '') + '> Mostra anche gli articoli senza giacenza</label>' +
      '<span class="spazio"></span>' +
      '<button class="btn primario" type="button" id="c-registra">Registra consumi</button>' +
      '</div><div id="c-foglio"></div><div id="c-fatti"></div>';

    function stato() {
      memoriaConsumi = { rep: valore(cont, '#c-rep'), data: valore(cont, '#c-data'), cat: valore(cont, '#c-cat'), tutti: cont.querySelector('#c-tutti').checked };
      return memoriaConsumi;
    }

    function consumatiNelGiorno(st) {
      var per = {};
      App.S.movimenti.forEach(function (m) {
        if (!m.annullato && m.tipo === 'consumo' && m.repartoId === st.rep && m.data === st.data) per[m.articoloId] = (per[m.articoloId] || 0) + m.quantita;
      });
      return per;
    }

    function disegna() {
      var st = stato();
      var gia = consumatiNelGiorno(st);
      var testo = valore(cont, '#c-cerca').trim().toLowerCase();
      var lista = App.articoliAttivi(st.cat).filter(function (a) {
        if (testo && a.nome.toLowerCase().indexOf(testo) < 0) return false;
        return st.tutti || App.giacenza(a.id, st.rep) > 0 || gia[a.id];
      });
      var corpo;
      if (!lista.length) {
        corpo = vuoto(App.S.articoli.length ? 'Nessun articolo con giacenza in questo reparto' : 'Nessun articolo in anagrafica',
          App.S.articoli.length ? 'Spunta “Mostra anche gli articoli senza giacenza” oppure registra un carico o un trasferimento verso il reparto.' : 'Aggiungi gli articoli dalla pagina Articoli.');
      } else {
        corpo = '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Articolo</th><th>Categoria</th><th class="n">Giacenza</th><th class="n">Già registrati</th><th class="n">Consumo da registrare</th></tr></thead><tbody>' +
          lista.map(function (a) {
            return '<tr><td><a href="#" data-scheda="' + h(a.id) + '">' + h(a.nome) + '</a>' + (a.confezione ? ' <span class="tenue piccolo">' + h(a.confezione) + '</span>' : '') + '</td>' +
              '<td>' + etichettaCategoria(a.categoria) + '</td>' +
              '<td class="n">' + App.fmtNum(App.giacenza(a.id, st.rep)) + (a.unita ? ' <span class="tenue">' + h(a.unita) + '</span>' : '') + '</td>' +
              '<td class="n">' + (gia[a.id] ? App.fmtNum(gia[a.id]) : '<span class="tenue">—</span>') + '</td>' +
              '<td class="n"><input class="q" inputmode="decimal" data-art="' + h(a.id) + '" placeholder="0" aria-label="Consumo di ' + h(a.nome) + '"></td></tr>';
          }).join('') + '</tbody></table></div>';
      }
      cont.querySelector('#c-foglio').innerHTML = scheda('Consumi di ' + h(App.nomeReparto(st.rep)) + ' · ' + App.dataLunga(st.data), corpo,
        '<span class="nota">Scrivi le quantità usate, poi “Registra consumi”. Invio passa alla riga sotto.</span>', true);
      var fatti = movimentiRecenti(function (m) { return m.tipo === 'consumo' && m.repartoId === st.rep && m.data === st.data; }, 200);
      cont.querySelector('#c-fatti').innerHTML = scheda('Consumi già registrati in questo giorno', tabellaMovimenti(fatti, true), '', true);
    }

    cont.querySelectorAll('#c-data, #c-rep, #c-cat, #c-tutti').forEach(function (el) { el.addEventListener('change', disegna); });
    cont.querySelector('#c-cerca').addEventListener('input', disegna);
    cont.addEventListener('input', function (e) {
      if (e.target.classList.contains('q')) e.target.closest('tr').classList.toggle('compilata', App.numero(e.target.value) > 0);
    });
    cont.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('q')) {
        e.preventDefault();
        var tutti = Array.prototype.slice.call(cont.querySelectorAll('input.q'));
        var i = tutti.indexOf(e.target);
        if (tutti[i + 1]) tutti[i + 1].focus(); else cont.querySelector('#c-registra').focus();
      }
    });
    cont.addEventListener('click', function (e) {
      var s = e.target.closest('[data-scheda]');
      if (s) { e.preventDefault(); App.schedaArticolo(s.getAttribute('data-scheda')); }
    });
    collegaMovimenti(cont.querySelector('#c-fatti'), disegna);

    cont.querySelector('#c-registra').addEventListener('click', function () {
      var st = stato();
      var righe = [];
      cont.querySelectorAll('input.q[data-art]').forEach(function (inp) {
        var q = App.numero(inp.value);
        if (q > 0) righe.push({ articoloId: inp.getAttribute('data-art'), quantita: q });
      });
      if (!righe.length) { App.avviso('Non hai scritto nessuna quantità.', 'errore'); return; }
      var scoperti = righe.filter(function (r) { return r.quantita > App.giacenza(r.articoloId, st.rep); });
      var procedi = scoperti.length
        ? App.conferma('Giacenza insufficiente', 'In ' + h(App.nomeReparto(st.rep)) + ' non c’è abbastanza giacenza per: <b>' +
          scoperti.map(function (r) { return h(App.nomeArticolo(r.articoloId)); }).join(', ') + '</b>. Registro lo stesso?', 'Registra lo stesso')
        : Promise.resolve(true);
      procedi.then(function (ok) {
        if (!ok) return;
        var movimenti = [];
        righe.forEach(function (r) {
          movimenti = movimenti.concat(App.preparaUscita('consumo', { data: st.data, articoloId: r.articoloId, repartoId: st.rep, quantita: r.quantita }));
        });
        App.aggiungiMovimenti(movimenti).then(function () {
          App.avviso('Consumi registrati: ' + righe.length + (righe.length === 1 ? ' articolo' : ' articoli'), 'ok');
          disegna();
        });
      });
    });

    disegna();
    var primo = cont.querySelector('input.q');
    if (primo) primo.focus();
  };

  /* ======================= GIACENZE ======================= */

  P.giacenze = function (cont, par) {
    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Reparto</span><select id="g-rep">' + opzioniReparti('', true) + '</select></label>' +
      '<label class="campo"><span>Categoria</span><select id="g-cat">' + opzioniCategoria('', true) + '</select></label>' +
      '<label class="campo"><span>Cerca</span><input id="g-cerca" type="search" placeholder="Nome, principio attivo…"></label>' +
      '<label class="spunta"><input type="checkbox" id="g-sotto"' + (par.soloSotto ? ' checked' : '') + '> Solo sotto scorta</label>' +
      '<label class="spunta"><input type="checkbox" id="g-zero"> Anche a zero</label>' +
      '<span class="spazio"></span>' +
      '<button class="btn" type="button" id="g-stampa">Stampa</button><button class="btn" type="button" id="g-excel">Excel</button>' +
      '</div><div id="g-tab"></div>';

    var dati = { colonne: [], righe: [] };

    function disegna() {
      var rep = valore(cont, '#g-rep');
      var cat = valore(cont, '#g-cat');
      var testo = valore(cont, '#g-cerca').trim().toLowerCase();
      var sotto = cont.querySelector('#g-sotto').checked;
      var zero = cont.querySelector('#g-zero').checked;
      var reparti = rep ? [App.reparto(rep)] : App.repartiAttivi();
      var oggi = App.oggi();
      var lista = App.S.articoli.filter(function (a) {
        if (cat && a.categoria !== cat) return false;
        if (testo && (a.nome + ' ' + (a.principio || '') + ' ' + (a.codice || '')).toLowerCase().indexOf(testo) < 0) return false;
        if (sotto && !App.sottoScorta(a)) return false;
        var tot = reparti.reduce(function (s, r) { return s + App.giacenza(a.id, r.id); }, 0);
        if (!zero && !tot && !sotto) return false;
        return true;
      }).sort(function (x, y) { return x.nome.localeCompare(y.nome, 'it'); });

      dati.colonne = [{ titolo: 'Articolo', larghezza: 42 }, { titolo: 'Categoria', larghezza: 11 }]
        .concat(reparti.map(function (r) { return { titolo: r.nome, larghezza: 13 }; }))
        .concat(rep ? [{ titolo: 'Prossima scadenza', larghezza: 16 }] : [{ titolo: 'Totale', larghezza: 11 }])
        .concat([{ titolo: 'Scorta minima', larghezza: 13 }, { titolo: 'Valore €', larghezza: 12 }]);
      dati.righe = [];
      var valoreTot = 0;

      var corpo = lista.map(function (a) {
        var valori = reparti.map(function (r) { return App.giacenza(a.id, r.id); });
        var tot = valori.reduce(function (s, x) { return s + x; }, 0);
        var val = Math.round(tot * (a.prezzo || 0) * 100) / 100;
        valoreTot += val;
        var prossima = '';
        if (rep) {
          var l = C.lotti(App.S, a.id, rep).filter(function (x) { return x.quantita > 0 && x.scadenza; });
          prossima = l.length ? l[0].scadenza : '';
        }
        dati.righe.push([a.nome, a.categoria].concat(valori).concat(rep ? [prossima ? App.fmtScadenza(prossima) : ''] : [tot]).concat([a.scortaMinima || '', val]));
        var stScad = prossima ? App.statoScadenza(C.giorniAllaScadenza(prossima, oggi)) : null;
        return '<tr class="cliccabile" data-scheda="' + h(a.id) + '"><td>' + h(a.nome) + (a.attivo === false ? ' <span class="etichetta">non attivo</span>' : '') + '</td>' +
          '<td>' + etichettaCategoria(a.categoria) + '</td>' +
          valori.map(function (v) { return '<td class="n' + (v < 0 ? ' neg' : '') + '">' + (v ? App.fmtNum(v) : '<span class="tenue">0</span>') + '</td>'; }).join('') +
          (rep ? '<td>' + (prossima ? App.fmtScadenza(prossima) + ' <span class="etichetta ' + stScad.classe + '">' + stScad.testo + '</span>' : '<span class="tenue">—</span>') + '</td>'
            : '<td class="n"><b>' + App.fmtNum(tot) + '</b></td>') +
          '<td class="n">' + (a.scortaMinima ? App.fmtNum(a.scortaMinima) + (App.sottoScorta(a) ? ' <span class="etichetta pericolo">sotto</span>' : '') : '<span class="tenue">—</span>') + '</td>' +
          '<td class="n">' + App.fmtEuro(val) + '</td></tr>';
      }).join('');

      var testa = '<tr><th>Articolo</th><th>Categoria</th>' + reparti.map(function (r) { return '<th class="n">' + h(r.nome) + '</th>'; }).join('') +
        (rep ? '<th>Prossima scadenza</th>' : '<th class="n">Totale</th>') + '<th class="n">Scorta min.</th><th class="n">Valore</th></tr>';
      cont.querySelector('#g-tab').innerHTML = scheda('Giacenze al ' + App.fmtData(oggi) + (rep ? ' · ' + h(App.nomeReparto(rep)) : ''),
        lista.length ? '<div class="tabella-contenitore"><table class="tabella"><thead>' + testa + '</thead><tbody>' + corpo + '</tbody>' +
          '<tfoot><tr><td colspan="' + (reparti.length + 4) + '">Valore complessivo (prezzo unitario × giacenza)</td><td class="n">' + App.fmtEuro(valoreTot) + '</td></tr></tfoot></table></div>'
          : vuoto('Nessun articolo da mostrare', 'Cambia i filtri o spunta “Anche a zero”.'),
        '<span class="nota">' + lista.length + ' articoli</span>', true);
    }

    cont.querySelectorAll('select, input[type=checkbox]').forEach(function (el) { el.addEventListener('change', disegna); });
    cont.querySelector('#g-cerca').addEventListener('input', disegna);
    cont.addEventListener('click', function (e) {
      var r = e.target.closest('[data-scheda]');
      if (r) App.schedaArticolo(r.getAttribute('data-scheda'));
    });
    cont.querySelector('#g-stampa').addEventListener('click', function () { window.print(); });
    cont.querySelector('#g-excel').addEventListener('click', function () {
      root.ExcelFarmacia.esportaElenco('Giacenze', dati.colonne, dati.righe).then(function (b) { App.scarica(b, 'Giacenze_' + App.oggi() + '.xlsx'); });
    });
    disegna();
  };

  /* ======================= SCADENZE ======================= */

  P.scadenze = function (cont) {
    var soglia = App.S.impostazioni.giorniAvvisoScadenza || 90;
    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Mostra</span><select id="z-entro">' +
      '<option value="-1">Solo scaduti</option><option value="30">Scaduti ed entro 30 giorni</option><option value="60">Entro 60 giorni</option>' +
      '<option value="' + soglia + '" selected>Entro ' + soglia + ' giorni</option><option value="180">Entro 180 giorni</option><option value="99999">Tutti i lotti</option></select></label>' +
      '<label class="campo"><span>Reparto</span><select id="z-rep">' + opzioniReparti('', true) + '</select></label>' +
      '<label class="campo"><span>Categoria</span><select id="z-cat">' + opzioniCategoria('', true) + '</select></label>' +
      '<span class="spazio"></span><button class="btn" type="button" id="z-stampa">Stampa</button><button class="btn" type="button" id="z-excel">Excel</button>' +
      '</div><div id="z-tab"></div>';

    var righeExcel = [];
    function disegna() {
      var entro = Number(valore(cont, '#z-entro'));
      var rep = valore(cont, '#z-rep');
      var cat = valore(cont, '#z-cat');
      var lista = App.lottiInGiacenza().filter(function (l) {
        if (rep && l.reparto.id !== rep) return false;
        if (cat && l.articolo.categoria !== cat) return false;
        if (entro >= 99999) return true;
        return l.giorni !== null && (entro < 0 ? l.giorni < 0 : l.giorni <= entro);
      }).sort(function (a, b) {
        if (a.giorni === null) return 1;
        if (b.giorni === null) return -1;
        return a.giorni - b.giorni || a.articolo.nome.localeCompare(b.articolo.nome, 'it');
      });
      righeExcel = lista.map(function (l) {
        return [l.scadenza ? App.fmtScadenza(l.scadenza) : '', l.articolo.nome, l.lotto, l.reparto.nome, l.quantita, App.statoScadenza(l.giorni).testo];
      });
      cont.querySelector('#z-tab').innerHTML = scheda('Lotti in giacenza per scadenza',
        lista.length ? '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Scadenza</th><th>Stato</th><th>Articolo</th><th>Lotto</th><th>Reparto</th><th class="n">Quantità</th><th></th></tr></thead><tbody>' +
          lista.map(function (l) {
            var st = App.statoScadenza(l.giorni);
            return '<tr><td><b>' + (l.scadenza ? App.fmtScadenza(l.scadenza) : '—') + '</b></td>' +
              '<td><span class="etichetta ' + st.classe + '">' + st.testo + (l.giorni !== null && l.giorni >= 0 ? ' · ' + l.giorni + ' gg' : '') + '</span></td>' +
              '<td><a href="#" data-scheda="' + h(l.articolo.id) + '">' + h(l.articolo.nome) + '</a></td>' +
              '<td class="mono">' + h(l.lotto || '—') + '</td><td>' + h(l.reparto.nome) + '</td>' +
              '<td class="n">' + App.fmtNum(l.quantita) + '</td>' +
              '<td class="azioni">' + (l.giorni !== null && l.giorni < 0 ? '<button class="btn piccolo pericolo" type="button" data-perdita="' + h(l.articolo.id) + '|' + h(l.reparto.id) + '|' + h(l.lotto) + '|' + l.quantita + '">Togli dal magazzino</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
          : vuoto('Nessun lotto in questo intervallo', 'I lotti compaiono qui quando nel carico indichi lotto e scadenza.'),
        '<span class="nota">' + lista.length + ' lotti</span>', true);
    }

    cont.querySelectorAll('select').forEach(function (el) { el.addEventListener('change', disegna); });
    cont.addEventListener('click', function (e) {
      var s = e.target.closest('[data-scheda]');
      if (s) { e.preventDefault(); App.schedaArticolo(s.getAttribute('data-scheda')); return; }
      var p = e.target.closest('[data-perdita]');
      if (p) {
        var v = p.getAttribute('data-perdita').split('|');
        App.vai('perdite', { articoloId: v[0], repartoId: v[1], lotto: v[2], quantita: Number(v[3]) });
      }
    });
    cont.querySelector('#z-stampa').addEventListener('click', function () { window.print(); });
    cont.querySelector('#z-excel').addEventListener('click', function () {
      root.ExcelFarmacia.esportaElenco('Scadenze', [{ titolo: 'Scadenza', larghezza: 11 }, { titolo: 'Articolo', larghezza: 42 }, { titolo: 'Lotto', larghezza: 16 },
        { titolo: 'Reparto', larghezza: 18 }, { titolo: 'Quantità', larghezza: 10 }, { titolo: 'Stato', larghezza: 18 }], righeExcel)
        .then(function (b) { App.scarica(b, 'Scadenze_' + App.oggi() + '.xlsx'); });
    });
    disegna();
  };

  /* ======================= MOVIMENTI ======================= */

  P.movimenti = function (cont) {
    var oggi = App.oggi();
    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Dal</span><input type="date" id="v-dal" value="' + oggi.slice(0, 8) + '01"></label>' +
      '<label class="campo"><span>Al</span><input type="date" id="v-al" value="' + oggi + '"></label>' +
      '<label class="campo"><span>Tipo</span><select id="v-tipo"><option value="">Tutti</option>' +
      Object.keys(App.TIPI).map(function (t) { return '<option value="' + t + '">' + App.TIPI[t] + '</option>'; }).join('') + '</select></label>' +
      '<label class="campo"><span>Reparto</span><select id="v-rep">' + opzioniReparti('', true) + '</select></label>' +
      '<label class="campo"><span>Articolo</span><input id="v-cerca" type="search" placeholder="Nome, lotto, fornitore…"></label>' +
      '<label class="spunta"><input type="checkbox" id="v-ann" checked> Mostra annullati</label>' +
      '<span class="spazio"></span><button class="btn" type="button" id="v-excel">Excel</button>' +
      '</div><div id="v-tab"></div>';

    var filtrati = [];
    function disegna() {
      var dal = valore(cont, '#v-dal'), al = valore(cont, '#v-al'), tipo = valore(cont, '#v-tipo'), rep = valore(cont, '#v-rep');
      var testo = valore(cont, '#v-cerca').trim().toLowerCase();
      var ann = cont.querySelector('#v-ann').checked;
      filtrati = App.S.movimenti.filter(function (m) {
        if (dal && m.data < dal) return false;
        if (al && m.data > al) return false;
        if (tipo && m.tipo !== tipo) return false;
        if (rep && m.repartoId !== rep && m.repartoDestId !== rep) return false;
        if (!ann && m.annullato) return false;
        if (testo) {
          var t = (App.nomeArticolo(m.articoloId) + ' ' + (m.lotto || '') + ' ' + (m.fornitore || '') + ' ' + (m.documento || '') + ' ' + (m.note || '')).toLowerCase();
          if (t.indexOf(testo) < 0) return false;
        }
        return true;
      }).sort(function (a, b) { return a.data < b.data ? 1 : a.data > b.data ? -1 : (b.creato || 0) - (a.creato || 0); });
      var mostrati = filtrati.slice(0, 500);
      cont.querySelector('#v-tab').innerHTML = scheda('Movimenti', tabellaMovimenti(mostrati, true),
        '<span class="nota">' + filtrati.length + ' movimenti' + (filtrati.length > 500 ? ' (ne mostro 500: restringi le date o usa Excel)' : '') + '</span>', true);
    }
    cont.querySelectorAll('select, input[type=date], input[type=checkbox]').forEach(function (el) { el.addEventListener('change', disegna); });
    cont.querySelector('#v-cerca').addEventListener('input', disegna);
    collegaMovimenti(cont.querySelector('#v-tab'), disegna);
    cont.querySelector('#v-excel').addEventListener('click', function () {
      var col = ['Data', 'Tipo', 'Articolo', 'Categoria', 'Quantità', 'Unità', 'Lotto', 'Scadenza', 'Reparto', 'Reparto di arrivo', 'Fornitore', 'Documento', 'Causale', 'Note', 'Operatore', 'Annullato']
        .map(function (t, i) { return { titolo: t, larghezza: [11, 14, 40, 10, 10, 8, 14, 10, 16, 16, 20, 14, 16, 24, 14, 30][i] }; });
      var righe = filtrati.slice().reverse().map(function (m) {
        var a = App.articolo(m.articoloId) || {};
        return [App.fmtData(m.data), App.TIPI[m.tipo], a.nome || '', a.categoria || '', m.quantita, a.unita || '', m.lotto || '', m.scadenza ? App.fmtScadenza(m.scadenza) : '',
          App.nomeReparto(m.repartoId), m.repartoDestId ? App.nomeReparto(m.repartoDestId) : '', m.fornitore || '', m.documento || '', m.causale || '', m.note || '', m.operatore || '',
          m.annullato ? 'Sì' + (m.annullato.motivo ? ': ' + m.annullato.motivo : '') : ''];
      });
      root.ExcelFarmacia.esportaElenco('Movimenti', col, righe).then(function (b) { App.scarica(b, 'Movimenti_' + valore(cont, '#v-dal') + '_' + valore(cont, '#v-al') + '.xlsx'); });
    });
    disegna();
  };

  /* ======================= INVENTARIO ======================= */

  P.inventario = function (cont) {
    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Data dell’inventario</span><input type="date" id="i-data" value="' + App.oggi() + '"></label>' +
      '<label class="campo"><span>Reparto</span><select id="i-rep">' + opzioniReparti(App.repartoCentrale() && App.repartoCentrale().id) + '</select></label>' +
      '<label class="campo"><span>Categoria</span><select id="i-cat">' + opzioniCategoria('', true) + '</select></label>' +
      '<label class="campo"><span>Cerca</span><input id="i-cerca" type="search"></label>' +
      '<span class="spazio"></span><button class="btn" type="button" id="i-stampa">Stampa foglio di conta</button>' +
      '<button class="btn primario" type="button" id="i-registra">Registra differenze</button>' +
      '</div><div id="i-tab"></div>';

    function disegna() {
      var rep = valore(cont, '#i-rep'), cat = valore(cont, '#i-cat'), data = valore(cont, '#i-data');
      var testo = valore(cont, '#i-cerca').trim().toLowerCase();
      var lista = App.articoliAttivi(cat).filter(function (a) { return !testo || a.nome.toLowerCase().indexOf(testo) >= 0; });
      cont.querySelector('#i-tab').innerHTML = scheda('Conta di ' + h(App.nomeReparto(rep)) + ' al ' + App.fmtData(data),
        lista.length ? '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Articolo</th><th>Categoria</th><th class="n">Giacenza nel programma</th><th class="n">Quantità contata</th><th class="n">Differenza</th></tr></thead><tbody>' +
          lista.map(function (a) {
            var g = C.giacenza(App.S, a.id, rep, data);
            return '<tr><td>' + h(a.nome) + '</td><td>' + etichettaCategoria(a.categoria) + '</td><td class="n">' + App.fmtNum(g) + (a.unita ? ' <span class="tenue">' + h(a.unita) + '</span>' : '') + '</td>' +
              '<td class="n"><input class="q" inputmode="decimal" data-art="' + h(a.id) + '" data-teorica="' + g + '" placeholder="—"></td><td class="n diff"></td></tr>';
          }).join('') + '</tbody></table></div>'
          : vuoto('Nessun articolo', ''),
        '<span class="nota">Scrivi solo le quantità contate: le righe vuote non cambiano.</span>', true);
    }
    cont.querySelectorAll('select, input[type=date]').forEach(function (el) { el.addEventListener('change', disegna); });
    cont.querySelector('#i-cerca').addEventListener('input', disegna);
    cont.addEventListener('input', function (e) {
      if (!e.target.classList.contains('q')) return;
      var td = e.target.closest('tr').querySelector('.diff');
      if (e.target.value.trim() === '') { td.textContent = ''; return; }
      var d = App.numero(e.target.value) - Number(e.target.getAttribute('data-teorica'));
      td.innerHTML = d ? '<span class="etichetta ' + (d < 0 ? 'pericolo' : 'info') + '">' + (d > 0 ? '+' : '') + App.fmtNum(d) + '</span>' : '<span class="etichetta ok">uguale</span>';
    });
    cont.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList.contains('q')) {
        e.preventDefault();
        var tutti = Array.prototype.slice.call(cont.querySelectorAll('input.q'));
        var i = tutti.indexOf(e.target);
        if (tutti[i + 1]) tutti[i + 1].focus();
      }
    });
    cont.querySelector('#i-stampa').addEventListener('click', function () { window.print(); });
    cont.querySelector('#i-registra').addEventListener('click', function () {
      var rep = valore(cont, '#i-rep'), data = valore(cont, '#i-data');
      var mov = [];
      cont.querySelectorAll('input.q[data-art]').forEach(function (inp) {
        if (inp.value.trim() === '') return;
        var d = Math.round((App.numero(inp.value) - Number(inp.getAttribute('data-teorica'))) * 1000) / 1000;
        if (d) mov.push({ tipo: 'rettifica', data: data, articoloId: inp.getAttribute('data-art'), repartoId: rep, quantita: d, note: 'Inventario del ' + App.fmtData(data) });
      });
      if (!mov.length) { App.avviso('Nessuna differenza da registrare.'); return; }
      App.conferma('Registra inventario', 'Registro ' + mov.length + (mov.length === 1 ? ' rettifica' : ' rettifiche') + ' in ' + h(App.nomeReparto(rep)) + ' alla data ' + App.fmtData(data) + '?', 'Registra').then(function (ok) {
        if (!ok) return;
        App.aggiungiMovimenti(mov).then(function () { App.avviso('Inventario registrato', 'ok'); disegna(); });
      });
    });
    disegna();
  };

  /* ======================= NOTA CONSUMI MENSILE ======================= */

  var memoriaRegistro = {};

  P.registro = function (cont) {
    var oggi = App.oggi();
    var rep = memoriaRegistro.rep || (App.repartiAttivi().filter(function (r) { return !r.centrale; })[0] || App.repartoCentrale()).id;
    var mese = memoriaRegistro.mese || oggi.slice(0, 7);
    var cat = memoriaRegistro.cat || 'FARMACI';
    var imp = App.S.impostazioni;

    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Reparto</span><select id="r-rep">' + opzioniReparti(rep) + '</select></label>' +
      '<label class="campo"><span>Mese</span><input type="month" id="r-mese" value="' + mese + '"></label>' +
      '<label class="campo"><span>Modulo</span><select id="r-cat">' + opzioniCategoria(cat) + '</select></label>' +
      '<label class="spunta"><input type="checkbox" id="r-tutti"' + (memoriaRegistro.tutti ? ' checked' : '') + '> Includi gli articoli senza movimenti</label>' +
      '<span class="spazio"></span>' +
      '<button class="btn" type="button" id="r-stampa">Stampa</button>' +
      '<button class="btn primario" type="button" id="r-excel">Esporta nel modulo Excel</button>' +
      '</div><div id="r-tab"></div>';

    var registro = null;
    var trasferimentiUscita = {};

    function opz() {
      var m = valore(cont, '#r-mese').split('-').map(Number);
      memoriaRegistro = { rep: valore(cont, '#r-rep'), mese: valore(cont, '#r-mese'), cat: valore(cont, '#r-cat'), tutti: cont.querySelector('#r-tutti').checked };
      return { repartoId: memoriaRegistro.rep, anno: m[0], mese: m[1], categoria: memoriaRegistro.cat, includiTutti: memoriaRegistro.tutti };
    }

    function disegna(fuoco) {
      if (!valore(cont, '#r-mese')) return;
      var o = opz();
      registro = C.registroMensile(App.S, o);
      trasferimentiUscita = {};
      App.S.movimenti.forEach(function (m) {
        if (!m.annullato && m.tipo === 'trasferimento' && m.repartoId === o.repartoId && m.data >= registro.inizio && m.data <= registro.fine) {
          var k = m.articoloId + '|' + Number(m.data.slice(8, 10));
          trasferimentiUscita[k] = (trasferimentiUscita[k] || 0) + m.quantita;
        }
      });
      var nomeMese = root.ExcelFarmacia.MESI[o.mese - 1] + ' ' + o.anno;
      var giorni = [];
      for (var g = 1; g <= registro.giorni; g++) giorni.push(g);
      var festivo = function (g) { return new Date(o.anno, o.mese - 1, g).getDay() === 0; };
      var fmt = function (n) { return n ? App.fmtNum(n) : ''; };

      var testa =
        '<tr><th class="den" rowspan="3">Denominazione</th><th rowspan="2">Residui<br>mesi prec.</th><th rowspan="2">Carichi</th><th rowspan="2">Totale<br>carico</th>' +
        '<th colspan="' + registro.giorni + '">C O N S U M I &nbsp; G I O R N A L I E R I</th>' +
        '<th rowspan="2">Totale<br>consumo</th><th rowspan="2">Perdite</th><th rowspan="2">Totale<br>scarico</th><th rowspan="2">Controllo<br>scadenze</th><th rowspan="2">Residui</th>' +
        '<th rowspan="2">Prezzo<br>unitario</th><th rowspan="2">Importo<br>scarico</th></tr>' +
        '<tr>' + giorni.map(function (g) { return '<th' + (festivo(g) ? ' class="festivo"' : '') + '>' + g + '</th>'; }).join('') + '</tr>' +
        '<tr><th>2</th><th>3</th><th>4 = 2+3</th>' + giorni.map(function () { return '<th></th>'; }).join('') + '<th>6</th><th>7</th><th>8 = 6+7</th><th>9</th><th>10 = 4−8</th><th>11</th><th>8×11</th></tr>';

      var corpo = registro.righe.map(function (r) {
        return '<tr data-art="' + h(r.articoloId) + '"><td class="den" title="' + h(r.denominazione) + '"><a href="#" data-scheda="' + h(r.articoloId) + '">' + h(r.denominazione) + '</a></td>' +
          '<td>' + fmt(r.residuiPrec) + '</td><td>' + fmt(r.carichi) + '</td><td class="tot">' + fmt(r.totaleCarico) + '</td>' +
          r.consumi.map(function (q, i) {
            var tr = trasferimentiUscita[r.articoloId + '|' + (i + 1)];
            return '<td class="g' + (festivo(i + 1) ? ' festivo' : '') + '"' + (tr ? ' title="Comprende ' + App.fmtNum(tr) + ' trasferiti ad altri reparti"' : '') + '>' +
              '<input data-giorno="' + (i + 1) + '" value="' + fmt(q) + '" inputmode="decimal" aria-label="Giorno ' + (i + 1) + '"></td>';
          }).join('') +
          '<td class="tot">' + fmt(r.totaleConsumo) + '</td><td>' + fmt(r.perdite) + '</td><td class="tot">' + fmt(r.totaleScarico) + '</td>' +
          '<td>' + (r.scadenza ? C.scadenzaBreve(r.scadenza) : '') + '</td><td class="tot' + (r.residui < 0 ? ' neg' : '') + '">' + App.fmtNum(r.residui) + '</td>' +
          '<td>' + (r.prezzo ? App.fmtEuro(r.prezzo) : '') + '</td><td>' + (r.importoScarico ? App.fmtEuro(r.importoScarico) : '') + '</td></tr>';
      }).join('');

      var piede = '<tr><td class="den">Totale importo scarico</td><td colspan="' + (registro.giorni + 9) + '"></td><td>' + App.fmtEuro(registro.totali.importoScarico) + '</td></tr>';

      var stampaTesta = '<div class="stampa-testa"><div>' + h(imp.struttura).toUpperCase() + '<br><b>' + h(imp.societa) + '</b><br>' + h(imp.citta) + '</div>' +
        '<div class="tit">NOTA CONSUMI MEDICINALI E MATERIALI MEDICAZIONE DELLA CASA DI CURA<br><span style="font-weight:400">Reparto <b>' + h(App.nomeReparto(o.repartoId)) + '</b> · Mese di <b>' + h(nomeMese) + '</b></span></div>' +
        '<div class="cat"><b>' + h(o.categoria) + '</b><br><span class="piccolo">' + h(imp.codiceModulo || '') + '</span></div></div>';
      var stampaPiede = '<div class="stampa-piede"><span>V° IL DIRIGENTE FARMACIA ______________________</span><span>IL DIRETTORE SANITARIO ______________________</span></div>' +
        '<div class="stampa-piede"><span>N.B. - I totali a fine mese dovranno concordare con le quantità che risulta caricata dallo scarico della farmacia</span></div>';

      var scroll = cont.querySelector('.registro-contenitore');
      var pos = scroll ? [scroll.scrollLeft, scroll.scrollTop] : null;
      cont.querySelector('#r-tab').innerHTML = scheda(
        'Nota consumi · ' + h(o.categoria === 'FARMACI' ? 'Farmaci' : 'Presidi') + ' · ' + h(App.nomeReparto(o.repartoId)) + ' · ' + h(nomeMese),
        stampaTesta + (registro.righe.length
          ? '<div class="registro-contenitore"><table class="registro"><thead>' + testa + '</thead><tbody>' + corpo + '</tbody><tfoot>' + piede + '</tfoot></table></div>'
          : vuoto('Nessun movimento in questo mese', 'Spunta “Includi gli articoli senza movimenti” per avere il modulo con tutti gli articoli.')) + stampaPiede,
        '<span class="nota no-stampa">I consumi si possono scrivere anche qui, giorno per giorno: il valore della casella sostituisce i consumi di quel giorno.</span>', true);
      var nuovo = cont.querySelector('.registro-contenitore');
      if (nuovo && pos) { nuovo.scrollLeft = pos[0]; nuovo.scrollTop = pos[1]; }
      if (fuoco) {
        var inp = cont.querySelector('tr[data-art="' + fuoco.art + '"] input[data-giorno="' + fuoco.giorno + '"]');
        if (inp) { inp.focus(); inp.select(); }
      }
    }

    function salvaCella(inp, prossimo) {
      var tr = inp.closest('tr');
      var art = tr.getAttribute('data-art');
      var giorno = Number(inp.getAttribute('data-giorno'));
      var riga = registro.righe.filter(function (r) { return r.articoloId === art; })[0];
      var vecchio = riga.consumi[giorno - 1];
      var nuovo = App.numero(inp.value);
      if (nuovo === vecchio) { if (prossimo) spostaFuoco(art, prossimo); return; }
      var trasf = trasferimentiUscita[art + '|' + giorno] || 0;
      if (nuovo < trasf) {
        App.avviso('In questo giorno ci sono ' + App.fmtNum(trasf) + ' trasferiti ad altri reparti: il valore non può essere più basso. Correggi il trasferimento da Movimenti.', 'errore');
        inp.value = vecchio ? App.fmtNum(vecchio) : '';
        return;
      }
      var o = opz();
      var data = o.anno + '-' + String(o.mese).padStart(2, '0') + '-' + String(giorno).padStart(2, '0');
      App.impostaConsumoGiorno(art, o.repartoId, data, nuovo - trasf).then(function () {
        disegna(prossimo ? { art: prossimo.art, giorno: prossimo.giorno } : null);
      });
    }

    function spostaFuoco(art, p) {
      var inp = cont.querySelector('tr[data-art="' + p.art + '"] input[data-giorno="' + p.giorno + '"]');
      if (inp) { inp.focus(); inp.select(); }
    }

    function vicino(inp, dRiga, dGiorno) {
      var tr = inp.closest('tr');
      var giorno = Number(inp.getAttribute('data-giorno')) + dGiorno;
      var riga = tr;
      if (dRiga > 0) riga = tr.nextElementSibling;
      if (dRiga < 0) riga = tr.previousElementSibling;
      if (!riga || giorno < 1 || giorno > registro.giorni) return null;
      return { art: riga.getAttribute('data-art'), giorno: giorno };
    }

    var tab = cont.querySelector('#r-tab');
    tab.addEventListener('keydown', function (e) {
      var inp = e.target;
      if (!inp.matches('td.g input')) return;
      var p = null;
      if (e.key === 'Enter' || e.key === 'ArrowDown') p = vicino(inp, 1, 0);
      else if (e.key === 'ArrowUp') p = vicino(inp, -1, 0);
      else if (e.key === 'Tab') p = vicino(inp, 0, e.shiftKey ? -1 : 1);
      else if (e.key === 'ArrowRight' && inp.selectionStart === inp.value.length) p = vicino(inp, 0, 1);
      else if (e.key === 'ArrowLeft' && inp.selectionStart === 0) p = vicino(inp, 0, -1);
      else if (e.key === 'Escape') { disegna(); return; }
      else return;
      e.preventDefault();
      inp.setAttribute('data-gestito', '1');
      salvaCella(inp, p || { art: inp.closest('tr').getAttribute('data-art'), giorno: Number(inp.getAttribute('data-giorno')) });
    });
    tab.addEventListener('focusout', function (e) {
      var inp = e.target;
      if (!inp.matches || !inp.matches('td.g input')) return;
      if (inp.getAttribute('data-gestito')) { inp.removeAttribute('data-gestito'); return; }
      salvaCella(inp, null);
    });
    tab.addEventListener('focusin', function (e) { if (e.target.matches('td.g input')) e.target.select(); });
    tab.addEventListener('click', function (e) {
      var s = e.target.closest('[data-scheda]');
      if (s) { e.preventDefault(); App.schedaArticolo(s.getAttribute('data-scheda')); }
    });

    cont.querySelectorAll('#r-rep, #r-mese, #r-cat, #r-tutti').forEach(function (el) { el.addEventListener('change', function () { disegna(); }); });
    cont.querySelector('#r-stampa').addEventListener('click', function () { window.print(); });
    cont.querySelector('#r-excel').addEventListener('click', function () {
      var o = opz();
      if (!registro.righe.length) { App.avviso('Non ci sono righe da esportare.', 'errore'); return; }
      var b = this;
      b.disabled = true;
      root.ExcelFarmacia.esportaNotaConsumi(registro, {
        impostazioni: App.S.impostazioni, reparto: App.nomeReparto(o.repartoId), anno: o.anno, mese: o.mese, categoria: o.categoria
      }).then(function (blob) {
        var nome = 'Carico_Scarico_' + (o.categoria === 'FARMACI' ? 'FARMACIA' : 'PRESIDI') + '_' + App.nomeReparto(o.repartoId).replace(/[^A-Za-z0-9]+/g, '_') + '_' + o.anno + '-' + String(o.mese).padStart(2, '0') + '.xlsx';
        App.scarica(blob, nome);
        App.avviso('Modulo Excel creato: ' + nome, 'ok');
      }).catch(function (e) {
        console.error(e);
        App.avviso('Esportazione non riuscita: ' + e.message, 'errore');
      }).then(function () { b.disabled = false; });
    });
    disegna();
  };

  /* ======================= ARTICOLI ======================= */

  P.articoli = function (cont) {
    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Cerca</span><input id="a-cerca" type="search" placeholder="Nome, principio attivo, codice…"></label>' +
      '<label class="campo"><span>Categoria</span><select id="a-cat">' + opzioniCategoria('', true) + '</select></label>' +
      '<label class="spunta"><input type="checkbox" id="a-non"> Mostra non attivi</label>' +
      '<span class="spazio"></span>' +
      '<button class="btn" type="button" id="a-importa">Importa da Excel</button>' +
      '<button class="btn" type="button" id="a-excel">Esporta Excel</button>' +
      '<button class="btn primario" type="button" id="a-nuovo">+ Nuovo articolo</button>' +
      '</div><div id="a-tab"></div>';

    function disegna() {
      var testo = valore(cont, '#a-cerca').trim().toLowerCase();
      var cat = valore(cont, '#a-cat');
      var non = cont.querySelector('#a-non').checked;
      var lista = App.S.articoli.filter(function (a) {
        if (cat && a.categoria !== cat) return false;
        if (!non && a.attivo === false) return false;
        return !testo || (a.nome + ' ' + (a.principio || '') + ' ' + (a.codice || '')).toLowerCase().indexOf(testo) >= 0;
      }).sort(function (x, y) { return x.nome.localeCompare(y.nome, 'it'); });
      cont.querySelector('#a-tab').innerHTML = scheda('Anagrafica articoli',
        lista.length ? '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Denominazione</th><th>Categoria</th><th>Principio attivo</th><th>Confezione</th><th>Unità</th><th class="n">Prezzo</th><th class="n">Scorta min.</th><th class="n">Giacenza totale</th><th></th></tr></thead><tbody>' +
          lista.map(function (a) {
            return '<tr class="cliccabile" data-scheda="' + h(a.id) + '"><td><b>' + h(a.nome) + '</b>' + (a.attivo === false ? ' <span class="etichetta">non attivo</span>' : '') + '</td>' +
              '<td>' + etichettaCategoria(a.categoria) + '</td><td>' + h(a.principio || '') + '</td><td>' + h(a.confezione || '') + '</td><td>' + h(a.unita || '') + '</td>' +
              '<td class="n">' + (a.prezzo ? App.fmtEuro(a.prezzo) : '') + '</td><td class="n">' + (a.scortaMinima ? App.fmtNum(a.scortaMinima) : '') + '</td>' +
              '<td class="n">' + App.fmtNum(App.giacenzaTotale(a.id)) + '</td>' +
              '<td class="azioni"><button class="btn piccolo" type="button" data-modifica="' + h(a.id) + '">Modifica</button></td></tr>';
          }).join('') + '</tbody></table></div>'
          : vuoto(App.S.articoli.length ? 'Nessun articolo con questi filtri' : 'L’anagrafica è vuota', App.S.articoli.length ? '' : 'Aggiungi gli articoli uno per uno o importali da un file Excel (anche dai vecchi moduli “Nota consumi” compilati).'),
        '<span class="nota">' + lista.length + ' articoli</span>', true);
    }

    cont.querySelector('#a-cerca').addEventListener('input', disegna);
    cont.querySelectorAll('select, input[type=checkbox]').forEach(function (el) { el.addEventListener('change', disegna); });
    cont.addEventListener('click', function (e) {
      var m = e.target.closest('[data-modifica]');
      if (m) { e.stopPropagation(); App.formArticolo(m.getAttribute('data-modifica')); return; }
      var r = e.target.closest('[data-scheda]');
      if (r) App.schedaArticolo(r.getAttribute('data-scheda'));
    });
    cont.querySelector('#a-nuovo').addEventListener('click', function () { App.formArticolo(null); });
    cont.querySelector('#a-importa').addEventListener('click', importaDaExcel);
    cont.querySelector('#a-excel').addEventListener('click', function () {
      var col = ['Denominazione', 'Categoria', 'Principio attivo', 'Confezione', 'Codice', 'Unità', 'Prezzo', 'Scorta minima', 'Giacenza totale', 'Attivo', 'Note']
        .map(function (t, i) { return { titolo: t, larghezza: [42, 11, 22, 20, 14, 8, 10, 13, 15, 8, 30][i] }; });
      var righe = App.S.articoli.slice().sort(function (x, y) { return x.nome.localeCompare(y.nome, 'it'); }).map(function (a) {
        return [a.nome, a.categoria, a.principio || '', a.confezione || '', a.codice || '', a.unita || '', a.prezzo || 0, a.scortaMinima || 0, App.giacenzaTotale(a.id), a.attivo === false ? 'No' : 'Sì', a.note || ''];
      });
      root.ExcelFarmacia.esportaElenco('Articoli', col, righe).then(function (b) { App.scarica(b, 'Articoli_' + App.oggi() + '.xlsx'); });
    });
    disegna();
  };

  function importaDaExcel() {
    App.scegliFileDaLeggere('.xlsx').then(function (file) {
      if (!file) return;
      return file.arrayBuffer().then(function (buf) { return root.ExcelFarmacia.importaArticoli(buf, 'FARMACI'); }).then(function (trovati) {
        if (!trovati.length) {
          App.avviso('Nel file non ho trovato articoli. Serve un modulo “Nota consumi” compilato o un elenco con una colonna “Denominazione”.', 'errore');
          return;
        }
        // raggruppo per nome (lo stesso articolo può comparire in più fogli)
        var perNome = {};
        trovati.forEach(function (t) {
          var k = t.nome.toLowerCase();
          if (!perNome[k]) perNome[k] = t; else perNome[k].giacenza += t.giacenza;
        });
        var lista = Object.keys(perNome).map(function (k) { return perNome[k]; });
        App.apriModale({
          titolo: 'Importa articoli da ' + file.name,
          largo: true,
          corpo: '<p>Ho trovato <b>' + lista.length + '</b> articoli. Quelli già in anagrafica (stesso nome) non vengono duplicati.</p>' +
            '<div class="modulo"><label class="campo"><span>Giacenza iniziale da caricare in</span><select id="imp-rep">' + opzioniReparti(App.repartoCentrale().id) + '</select></label>' +
            '<label class="campo"><span>Data della giacenza iniziale</span><input type="date" id="imp-data" value="' + App.oggi() + '"></label>' +
            '<label class="spunta"><input type="checkbox" id="imp-giac" checked> Registra le quantità come giacenza iniziale</label></div>' +
            '<div class="tabella-contenitore" style="max-height:45vh"><table class="tabella"><thead><tr><th><input type="checkbox" id="imp-tutti" checked aria-label="Tutti"></th><th>Denominazione</th><th>Categoria</th><th class="n">Quantità</th><th class="n">Prezzo</th><th></th></tr></thead><tbody>' +
            lista.map(function (t, i) {
              var esiste = App.articoloPerNome(t.nome);
              return '<tr><td><input type="checkbox" data-i="' + i + '" checked></td><td>' + h(t.nome) + '</td>' +
                '<td><select data-cat="' + i + '">' + opzioniCategoria(t.categoria) + '</select></td>' +
                '<td class="n">' + App.fmtNum(t.giacenza) + '</td><td class="n">' + (t.prezzo ? App.fmtEuro(t.prezzo) : '') + '</td>' +
                '<td>' + (esiste ? '<span class="etichetta info">già presente</span>' : '<span class="etichetta ok">nuovo</span>') + '</td></tr>';
            }).join('') + '</tbody></table></div>',
          piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="imp-ok">Importa</button>',
          dopo: function (m) {
            m.querySelector('#imp-tutti').addEventListener('change', function () {
              var v = this.checked;
              m.querySelectorAll('input[data-i]').forEach(function (c) { c.checked = v; });
            });
            m.querySelector('#imp-ok').addEventListener('click', function () {
              var rep = valore(m, '#imp-rep'), data = valore(m, '#imp-data'), conGiac = m.querySelector('#imp-giac').checked;
              var nuovi = 0, movimenti = [];
              m.querySelectorAll('input[data-i]').forEach(function (c) {
                if (!c.checked) return;
                var i = Number(c.getAttribute('data-i'));
                var t = lista[i];
                var cat = valore(m, 'select[data-cat="' + i + '"]');
                var a = App.articoloPerNome(t.nome);
                if (!a) {
                  a = { id: App.id('a'), nome: t.nome, categoria: cat, prezzo: t.prezzo || 0, scortaMinima: t.scortaMinima || 0, unita: t.unita || '', attivo: true };
                  App.S.articoli.push(a);
                  nuovi++;
                }
                if (conGiac && t.giacenza > 0) movimenti.push({ tipo: 'carico', data: data, articoloId: a.id, repartoId: rep, quantita: t.giacenza, lotto: '', scadenza: '', note: 'Giacenza iniziale importata da ' + file.name });
              });
              App.aggiungiMovimenti(movimenti).then(function () {
                App.chiudiModale();
                App.avviso('Importati ' + nuovi + ' articoli nuovi' + (movimenti.length ? ' e ' + movimenti.length + ' giacenze iniziali' : ''), 'ok');
                App.ridisegna();
              });
            });
          }
        });
      });
    }).catch(function (e) {
      console.error(e);
      App.avviso('Non riesco a leggere il file: ' + e.message, 'errore');
    });
  }

  /* ======================= CONFIGURA ======================= */

  App.esportaArchivio = function () {
    App.S.ultimaEsportazione = new Date().toISOString();
    var blob = new Blob([JSON.stringify(App.S, null, 1)], { type: 'application/json' });
    App.scarica(blob, 'archivio-farmacia-posillipo_' + App.oggi() + '.json');
    App.salva().then(function () { if (App.paginaCorrente === 'oggi' || App.paginaCorrente === 'configura') App.ridisegna(); });
  };

  function ripristina(dati, descrizione) {
    return App.conferma('Ripristina archivio', 'Sostituisco tutti i dati attuali con ' + h(descrizione) + '? ' +
      'Prima salvo automaticamente una copia dei dati attuali sul tuo PC.', 'Ripristina', true).then(function (ok) {
      if (!ok) return;
      var copia = new Blob([JSON.stringify(App.S, null, 1)], { type: 'application/json' });
      App.scarica(copia, 'archivio-farmacia-prima-del-ripristino_' + App.oggi() + '.json');
      App.S = Archivio.valida(JSON.parse(JSON.stringify(dati)));
      return App.salva().then(function () {
        App.disegnaMarchio();
        App.avviso('Archivio ripristinato', 'ok');
        App.ridisegna();
      });
    });
  }

  P.configura = function (cont) {
    var imp = App.S.impostazioni;
    var supportaFile = root.Archivio.fileSupportato();
    cont.innerHTML =
      '<div class="griglia-2">' +
      scheda('Struttura e operatore',
        '<div class="modulo">' +
        '<label class="campo"><span>Nome della struttura</span><input id="k-struttura" value="' + h(imp.struttura) + '"></label>' +
        '<label class="campo"><span>Sottotitolo</span><input id="k-sotto" value="' + h(imp.sottotitolo) + '"></label>' +
        '<label class="campo"><span>Società (sul modulo)</span><input id="k-societa" value="' + h(imp.societa) + '"></label>' +
        '<label class="campo"><span>Città (sul modulo)</span><input id="k-citta" value="' + h(imp.citta) + '"></label>' +
        '<label class="campo"><span>Codice del modulo</span><input id="k-codice" value="' + h(imp.codiceModulo) + '"></label>' +
        '<label class="campo"><span>Avviso scadenze (giorni prima)</span><input id="k-giorni" inputmode="numeric" value="' + h(imp.giorniAvvisoScadenza) + '"></label>' +
        '<label class="campo largo"><span>Operatore di questa postazione (compare nei movimenti)</span><input id="k-operatore" value="' + h(imp.operatore) + '" placeholder="Nome e cognome"></label>' +
        '<div class="campo largo"><span>Logo</span><div class="strumenti">' + (imp.logo ? '<img src="' + h(imp.logo) + '" alt="" style="height:42px;border:1px solid var(--linea);border-radius:6px">' : '<span class="tenue piccolo">Nessun logo: uso il simbolo predefinito.</span>') +
        '<button class="btn piccolo" type="button" id="k-logo">Scegli immagine…</button>' + (imp.logo ? '<button class="btn piccolo" type="button" id="k-logo-via">Togli</button>' : '') + '</div></div>' +
        '</div><div class="strumenti" style="margin-top:14px"><span class="spazio"></span><button class="btn primario" type="button" id="k-salva">Salva</button></div>') +
      scheda('Reparti',
        '<p class="piccolo tenue" style="margin-bottom:10px">Il reparto <b>centrale</b> è la Farmacia: riceve i carichi dai fornitori e su di lui si controlla la scorta minima.</p>' +
        '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Reparto</th><th>Centrale</th><th>Attivo</th><th></th></tr></thead><tbody>' +
        App.S.reparti.map(function (r) {
          return '<tr><td><input class="cella-input" data-rep-nome="' + h(r.id) + '" value="' + h(r.nome) + '"></td>' +
            '<td><input type="radio" name="centrale" data-rep-centrale="' + h(r.id) + '"' + (r.centrale ? ' checked' : '') + '></td>' +
            '<td><input type="checkbox" data-rep-attivo="' + h(r.id) + '"' + (r.attivo !== false ? ' checked' : '') + '></td>' +
            '<td class="azioni"><button class="btn piccolo pericolo" type="button" data-rep-elimina="' + h(r.id) + '">Elimina</button></td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="strumenti" style="margin-top:12px"><input class="cella-input" id="k-nuovo-rep" placeholder="Nuovo reparto"><button class="btn" type="button" id="k-agg-rep">Aggiungi</button><span class="spazio"></span><button class="btn primario" type="button" id="k-salva-rep">Salva reparti</button></div>') +
      '</div>' +
      scheda('Archivio e copie di sicurezza',
        '<div class="guida">' +
        '<p>I dati stanno <b>su questo PC</b>, dentro il browser (Edge o Chrome). Il programma salva da solo a ogni modifica e tiene una copia automatica al giorno degli ultimi 30 giorni.</p>' +
        (supportaFile
          ? '<div class="banda info"><p><b>Copia su file sempre aggiornata.</b> Scegli un file (per esempio su una cartella di rete o una chiavetta): il programma lo riscrive a ogni modifica. Dopo ogni riavvio del browser va riattivata con un clic.</p>' +
            '<span id="k-file-stato" class="piccolo"></span><button class="btn" type="button" id="k-file-scegli">Scegli il file…</button><button class="btn" type="button" id="k-file-riattiva" hidden>Riattiva</button><button class="btn" type="button" id="k-file-togli" hidden>Disattiva</button></div>'
          : '<div class="banda attenzione"><p>Questo browser non permette la copia automatica su file: usa Microsoft Edge o Google Chrome, oppure salva le copie a mano.</p></div>') +
        '<div class="strumenti"><button class="btn primario" type="button" id="k-esporta">Salva una copia (.json)</button>' +
        '<button class="btn" type="button" id="k-ripristina">Ripristina da una copia…</button>' +
        '<span class="spazio"></span><span class="piccolo tenue">' + (App.S.ultimaEsportazione ? 'Ultima copia salvata: ' + new Date(App.S.ultimaEsportazione).toLocaleString('it-IT') : 'Nessuna copia salvata finora') + '</span></div>' +
        '<h3>Copie automatiche</h3><div id="k-copie" class="piccolo tenue">Carico…</div>' +
        '<h3>Prove e azzeramento</h3>' +
        '<div class="strumenti"><button class="btn" type="button" id="k-demo">Carica dati di prova</button>' +
        '<button class="btn pericolo" type="button" id="k-azzera">Cancella tutti i dati</button></div>' +
        '<p class="piccolo tenue">I dati di prova sono inventati e servono per imparare a usare il programma: sostituiscono l’archivio attuale.</p>' +
        '</div>');

    // struttura
    cont.querySelector('#k-salva').addEventListener('click', function () {
      imp.struttura = valore(cont, '#k-struttura').trim() || 'Clinica Posillipo';
      imp.sottotitolo = valore(cont, '#k-sotto').trim();
      imp.societa = valore(cont, '#k-societa').trim();
      imp.citta = valore(cont, '#k-citta').trim();
      imp.codiceModulo = valore(cont, '#k-codice').trim();
      imp.giorniAvvisoScadenza = Math.max(1, Math.round(App.numero(valore(cont, '#k-giorni'))) || 90);
      imp.operatore = valore(cont, '#k-operatore').trim();
      App.salva().then(function () { App.disegnaMarchio(); App.avviso('Impostazioni salvate', 'ok'); });
    });
    cont.querySelector('#k-logo').addEventListener('click', function () {
      App.scegliFileDaLeggere('image/*').then(function (f) {
        if (!f) return;
        if (f.size > 400000) { App.avviso('Immagine troppo grande: usa un file sotto i 400 KB.', 'errore'); return; }
        var r = new FileReader();
        r.onload = function () { imp.logo = r.result; App.salva().then(function () { App.disegnaMarchio(); App.ridisegna(); }); };
        r.readAsDataURL(f);
      });
    });
    var via = cont.querySelector('#k-logo-via');
    if (via) via.addEventListener('click', function () { imp.logo = ''; App.salva().then(function () { App.disegnaMarchio(); App.ridisegna(); }); });

    // reparti
    cont.querySelector('#k-agg-rep').addEventListener('click', function () {
      var nome = valore(cont, '#k-nuovo-rep').trim();
      if (!nome) return;
      App.S.reparti.push({ id: App.id('r'), nome: nome, attivo: true });
      App.salva().then(App.ridisegna);
    });
    cont.querySelector('#k-salva-rep').addEventListener('click', function () {
      App.S.reparti.forEach(function (r) {
        var n = cont.querySelector('[data-rep-nome="' + r.id + '"]');
        if (n && n.value.trim()) r.nome = n.value.trim();
        r.centrale = cont.querySelector('[data-rep-centrale="' + r.id + '"]').checked;
        r.attivo = cont.querySelector('[data-rep-attivo="' + r.id + '"]').checked;
      });
      App.salva().then(function () { App.avviso('Reparti salvati', 'ok'); App.ridisegna(); });
    });
    cont.querySelectorAll('[data-rep-elimina]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-rep-elimina');
        if (App.S.movimenti.some(function (m) { return m.repartoId === id || m.repartoDestId === id; })) {
          App.avviso('Il reparto ha dei movimenti: non si può eliminare. Togli la spunta “Attivo” per nasconderlo.', 'errore');
          return;
        }
        App.S.reparti = App.S.reparti.filter(function (r) { return r.id !== id; });
        App.salva().then(App.ridisegna);
      });
    });

    // copia su file
    function statoFile() {
      var el = cont.querySelector('#k-file-stato');
      if (!el) return;
      root.Archivio.statoFile().then(function (f) {
        el.innerHTML = f.attivo ? (f.permesso ? '✓ Attiva su <b>' + h(f.nome) + '</b>' : '⏸ In pausa su <b>' + h(f.nome) + '</b>') : 'Non attiva';
        cont.querySelector('#k-file-riattiva').hidden = !f.attivo || f.permesso;
        cont.querySelector('#k-file-togli').hidden = !f.attivo;
      });
    }
    if (supportaFile) {
      cont.querySelector('#k-file-scegli').addEventListener('click', function () {
        root.Archivio.scegliFile().then(function () { return App.salva(); }).then(function () { App.avviso('Copia su file attiva', 'ok'); statoFile(); })
          .catch(function (e) { if (e && e.name !== 'AbortError') App.avviso('Non riesco a usare quel file: ' + e.message, 'errore'); });
      });
      cont.querySelector('#k-file-riattiva').addEventListener('click', function () {
        root.Archivio.riattivaFile().then(function (ok) {
          if (ok) return App.salva().then(function () { App.avviso('Copia su file riattivata', 'ok'); statoFile(); });
          App.avviso('Permesso non concesso.', 'errore');
        });
      });
      cont.querySelector('#k-file-togli').addEventListener('click', function () {
        root.Archivio.togliFile().then(function () { App.aggiornaLaterale(); statoFile(); });
      });
      statoFile();
    }

    cont.querySelector('#k-esporta').addEventListener('click', App.esportaArchivio);
    cont.querySelector('#k-ripristina').addEventListener('click', function () {
      App.scegliFileDaLeggere('.json,application/json').then(function (f) {
        if (!f) return;
        return f.text().then(function (t) {
          var dati = root.Archivio.valida(JSON.parse(t));
          return ripristina(dati, 'il file “' + f.name + '” (' + dati.articoli.length + ' articoli, ' + dati.movimenti.length + ' movimenti)');
        });
      }).catch(function (e) { App.avviso('File non valido: ' + e.message, 'errore'); });
    });

    root.Archivio.elencoCopie().then(function (copie) {
      var el = cont.querySelector('#k-copie');
      if (!copie.length) { el.textContent = 'Ancora nessuna copia: la prima si crea con la prima modifica di oggi.'; return; }
      el.innerHTML = '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Giorno</th><th>Ora</th><th class="n">Articoli</th><th class="n">Movimenti</th><th></th></tr></thead><tbody>' +
        copie.map(function (c, i) {
          return '<tr><td>' + App.fmtData(c.giorno) + '</td><td>' + new Date(c.ora).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) + '</td>' +
            '<td class="n">' + c.dati.articoli.length + '</td><td class="n">' + c.dati.movimenti.length + '</td>' +
            '<td class="azioni"><button class="btn piccolo" type="button" data-copia="' + i + '">Ripristina</button></td></tr>';
        }).join('') + '</tbody></table></div><p style="margin-top:6px">Ogni copia è lo stato dell’archivio all’inizio di quel giorno, prima della prima modifica.</p>';
      el.querySelectorAll('[data-copia]').forEach(function (b) {
        b.addEventListener('click', function () {
          var c = copie[Number(b.getAttribute('data-copia'))];
          ripristina(c.dati, 'la copia automatica del ' + App.fmtData(c.giorno));
        });
      });
    });

    cont.querySelector('#k-demo').addEventListener('click', function () { App.caricaDemo(); });
    cont.querySelector('#k-azzera').addEventListener('click', function () {
      App.conferma('Cancella tutti i dati', 'Cancello articoli, movimenti e impostazioni di questo PC? Prima scarico una copia dei dati attuali. L’operazione non si può annullare dal programma.', 'Cancella tutto', true).then(function (ok) {
        if (!ok) return;
        App.scarica(new Blob([JSON.stringify(App.S, null, 1)], { type: 'application/json' }), 'archivio-farmacia-prima-della-cancellazione_' + App.oggi() + '.json');
        App.S = root.Archivio.statoVuoto();
        App.salva().then(function () { App.disegnaMarchio(); App.vai('oggi'); App.avviso('Archivio azzerato'); });
      });
    });
  };

  /* ======================= GUIDA ======================= */

  P.guida = function (cont) {
    cont.innerHTML = scheda('Come si usa il Gestionale Farmacia', '<div class="guida">' +
      '<p>Il programma sostituisce i fogli Excel <i>Carico_Scarico_FARMACIA</i> e <i>Carico_Scarico_PRESIDI</i>: ogni movimento si registra una volta sola e a fine mese la <b>Nota consumi</b> di ogni reparto è già pronta, nello stesso modulo di sempre.</p>' +
      '<h3>Il giro di ogni giorno</h3><ol>' +
      '<li><b>Carico</b> (tasto C): quando arriva la merce dal fornitore. Indica lotto e scadenza: servono al controllo scadenze.</li>' +
      '<li><b>Trasferimenti</b> (T): quando la Farmacia consegna ai reparti. Per la Farmacia è uno scarico, per il reparto un carico.</li>' +
      '<li><b>Consumi del giorno</b> (S): scegli reparto e data, scrivi le quantità usate e premi <i>Registra consumi</i>. Invio passa alla riga sotto.</li>' +
      '<li><b>Perdite e scaduti</b> (P): confezioni scadute, rotte, smarrite o rese.</li></ol>' +
      '<h3>A fine mese</h3><ol>' +
      '<li>Apri <b>Nota consumi mensile</b> (R), scegli reparto, mese e modulo (Farmaci o Presidi).</li>' +
      '<li>Controlla i numeri: le caselle dei giorni si possono correggere direttamente, come sul foglio.</li>' +
      '<li><b>Esporta nel modulo Excel</b>: crea il file con il modulo originale compilato (oltre 48 articoli aggiunge altri fogli identici). Oppure <b>Stampa</b>.</li></ol>' +
      '<h3>Come si calcolano le colonne</h3><ul>' +
      '<li><b>Residui mesi prec.</b> (2): giacenza del reparto all’ultimo giorno del mese prima.</li>' +
      '<li><b>Carichi</b> (3): carichi dai fornitori, trasferimenti ricevuti e rettifiche d’inventario in aumento.</li>' +
      '<li><b>Consumi giornalieri</b>: consumi del giorno; per la Farmacia comprendono anche i trasferimenti ai reparti.</li>' +
      '<li><b>Perdite</b> (7): perdite, scaduti e rettifiche d’inventario in diminuzione.</li>' +
      '<li><b>Controllo scadenze</b> (9): la scadenza più vicina tra i lotti rimasti a fine mese.</li>' +
      '<li><b>Residui</b> (10) = totale carico − totale scarico: è la giacenza a fine mese e diventa il residuo del mese dopo.</li></ul>' +
      '<h3>Lotti e scadenze</h3>' +
      '<p>Consumi, perdite e trasferimenti scalano per primo il lotto che scade prima. Se serve un lotto preciso, sceglilo nella riga. La pagina <b>Scadenze</b> (Z) mostra i lotti in scadenza e quelli scaduti, con il pulsante per toglierli dal magazzino.</p>' +
      '<h3>Inventario</h3><p>Da <b>Inventario</b> (I) stampi il foglio di conta, scrivi le quantità contate e il programma registra le differenze come rettifiche.</p>' +
      '<h3>Correggere un errore</h3><p>Un movimento non si cancella: si <b>annulla</b> (da Movimenti, o dagli elenchi sotto ogni modulo) scrivendo il motivo. Resta visibile, barrato, e non conta più nei calcoli.</p>' +
      '<h3>Tasti rapidi</h3><ul>' +
      App.MENU.filter(function (v) { return v.tasto; }).map(function (v) { return '<li><kbd>' + v.tasto + '</kbd> ' + h(v.voce) + '</li>'; }).join('') +
      '<li><kbd>Ctrl K</kbd> o <kbd>/</kbd> ricerca rapida di un articolo · <kbd>Esc</kbd> chiude le finestre</li></ul>' +
      '<h3>Dove stanno i dati</h3><p>Su questo PC, nel browser. Il programma tiene da solo una copia al giorno degli ultimi 30 giorni; in <b>Configura</b> puoi attivare la copia su file sempre aggiornata e salvare copie su chiavetta. Usa sempre lo stesso browser (Edge o Chrome) e non una finestra anonima.</p>' +
      '</div>');
  };
})(this);
