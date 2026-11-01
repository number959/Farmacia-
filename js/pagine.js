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

  // lista: reparti da mostrare (predefiniti: tutti gli attivi)
  function opzioniReparti(scelto, conTutti, lista) {
    var s = conTutti ? '<option value="">Tutti i reparti</option>' : '';
    return s + (lista || App.repartiAttivi()).map(function (r) {
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
  App.datalistArticoli = function () { if (document.getElementById('dl-articoli')) datalistArticoli(); };

  /* Reparto predefinito tra quelli di una lista: quello ricordato se c'è ancora, altrimenti il primo non centrale. */
  function repartoTra(lista, ricordato, preferisciCentrale) {
    if (ricordato && lista.some(function (r) { return r.id === ricordato; })) return ricordato;
    var c = lista.filter(function (r) { return r.centrale; })[0];
    var altro = lista.filter(function (r) { return !r.centrale; })[0];
    var scelto = preferisciCentrale ? (c || altro) : (altro || c);
    return scelto ? scelto.id : '';
  }

  function messaggioErrore(e) {
    return e && e.message ? e.message : String(e);
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

  function senzaReparti() {
    return scheda('Nessun reparto', vuoto('Il tuo utente non ha reparti in cui registrare', 'Chiedi all’amministratore di assegnarti i reparti.'), '', true);
  }

  function valore(cont, sel) { var el = cont.querySelector(sel); return el ? el.value : ''; }

  /* ---------- lettore di codici a barre (js/barcode.js, js/scanner.js) ---------- */

  // barra di lettura in cima alle pagine dove si registra; predefinito: quanto vale una lettura ('unita' | 'confezione')
  function barraLettore(predefinito) {
    return root.Scanner ? root.Scanner.barra({ pagina: App.paginaCorrente, predefinito: predefinito }) : '';
  }
  function collegaLettore(cont) { if (root.Scanner) root.Scanner.collega(cont); }
  function evidenziaLettura(el) { if (root.Scanner) root.Scanner.evidenzia(el); }
  function suonoLettura(tipo) { if (root.Scanner) root.Scanner.suono(tipo); }

  function descriviCodici(lista) {
    return (lista || []).map(function (k) { return root.Barcode ? root.Barcode.descrivi(k) : k; });
  }

  /* Caratteristiche dell'articolo (docs/NOVITA-3.0.md, articoli.attributi): servono a Disposizione automatica degli armadi. */
  var ATTRIBUTI_ARTICOLO = [
    { id: 'frigo', testo: 'Da frigorifero 2–8 °C', breve: 'Frigorifero' },
    { id: 'stupefacente', testo: 'Stupefacente (cassaforte)', breve: 'Stupefacente' },
    { id: 'alto-rischio', testo: 'Alto rischio', breve: 'Alto rischio' },
    { id: 'lasa', testo: 'LASA (nome o aspetto simile)', breve: 'LASA' },
    { id: 'urgenza', testo: 'Urgenze', breve: 'Urgenze' }
  ];
  App.ATTRIBUTI_ARTICOLO = ATTRIBUTI_ARTICOLO;

  function descriviAttributi(lista) {
    return ATTRIBUTI_ARTICOLO.filter(function (x) { return (lista || []).indexOf(x.id) >= 0; }).map(function (x) { return x.breve; });
  }

  /* Giorni di consegna generali (Configura), usati per gli articoli che non hanno i propri. */
  function leadTimeGenerale() {
    var v = App.S.impostazioni ? App.S.impostazioni.leadTimeGiorni : undefined;
    return v === undefined || v === null || v === '' || !isFinite(Number(v)) ? 7 : Number(v);
  }

  /* Un filtro della pagina (categoria, ricerca) nasconde l'articolo appena letto: lo tolgo. */
  function mostraArticoloNeiFiltri(cont, selCategoria, selCerca, a) {
    var cat = cont.querySelector(selCategoria);
    if (cat && cat.value && cat.value !== a.categoria) cat.value = '';
    var cerca = cont.querySelector(selCerca);
    var t = cerca ? cerca.value.trim().toLowerCase() : '';
    if (t && a.nome.toLowerCase().indexOf(t) < 0) cerca.value = '';
  }

  /* ---------- versione 3.0: DDT interni e merce in viaggio ---------- */

  // il magazzino di sistema "In transito" si mostra come merce in viaggio
  function nomeMagazzino(r) { return r ? (r.tipo === 'transito' ? 'In viaggio (DDT)' : r.nome) : '—'; }
  function nomeMagazzinoId(id) { return nomeMagazzino(App.reparto(id)); }

  /*
   * Movimento nato da un DDT: il magazzino vero che cambia giacenza (non "In transito") e cosa è successo.
   * null se il movimento non viene da un DDT.
   */
  function vistaDdt(m) {
    var x = m && m.ddtId && C.controparteDdt ? C.controparteDdt(App.S, m) : null;
    if (!x) return null;
    var d = x.ddt;
    var daViaggio = (App.reparto(m.repartoId) || {}).tipo === 'transito';
    if (m.tipo === 'perdita') return { ddt: d, repartoId: m.repartoId, arrivo: '', testo: 'perso in viaggio verso ' + App.nomeReparto(d.destinazioneId) };
    if (!daViaggio) return { ddt: d, repartoId: m.repartoId, arrivo: d.destinazioneId, testo: 'partito verso ' + App.nomeReparto(d.destinazioneId) };
    if (m.repartoDestId === d.destinazioneId) return { ddt: d, repartoId: m.repartoDestId, arrivo: '', testo: 'arrivato da ' + App.nomeReparto(d.origineId) };
    return { ddt: d, repartoId: m.repartoDestId, arrivo: '', testo: 'rientrato, non arrivato a ' + App.nomeReparto(d.destinazioneId) };
  }

  // i movimenti dei DDT non si annullano da qui: si annulla il DDT
  function puoAnnullare(m) { return !m.ddtId && App.puoAnnullare(m); }

  function riferimento(m) {
    var parti = [];
    var v = vistaDdt(m);
    if (v) {
      parti.push(v.testo);
      if (/^Annullo DDT/.test(m.causale || '')) parti.push('DDT annullato');
      else if (m.causale && m.causale !== v.ddt.causale && !/^Differenza alla ricezione/.test(m.causale)) parti.push(m.causale);
      // le note scritte dal programma ("Verso …", "Da …", "Rientro: …") dicono già quello che c'è nel testo
      var nota = /^(Verso|Da) /.test(m.note || '') ? '' : String(m.note || '').replace(/^(Rientro|Perdita in viaggio):? ?/, '');
      if (nota) parti.push(nota);
      if (m.annullato) parti.push('ANNULLATO' + (m.annullato.motivo ? ': ' + m.annullato.motivo : ''));
      return parti.join(' · ');
    }
    if (m.tipo === 'trasferimento') parti.push('→ ' + nomeMagazzinoId(m.repartoDestId));
    if (m.fornitore) parti.push(m.fornitore);
    if (m.documento) parti.push('doc. ' + m.documento);
    if (m.causale) parti.push(m.causale);
    if (m.note) parti.push(m.note);
    if (m.annullato) parti.push('ANNULLATO' + (m.annullato.motivo ? ': ' + m.annullato.motivo : ''));
    return parti.join(' · ');
  }

  // conAnnulla: colonna con il pulsante "Annulla" (solo sui movimenti che l'utente può annullare)
  function tabellaMovimenti(lista, conAnnulla) {
    if (!lista.length) return vuoto('Nessun movimento', '');
    if (conAnnulla && !lista.some(puoAnnullare)) conAnnulla = false;
    // movimenti-schede: sul telefono ogni movimento è una scheda (css/app.css)
    return '<div class="tabella-contenitore"><table class="tabella movimenti-schede"><thead><tr>' +
      '<th>Data</th><th>Tipo</th><th>Articolo</th><th class="n">Quantità</th><th>Lotto</th><th>Scad.</th><th>Reparto</th><th>Riferimento</th><th>Operatore</th>' +
      (conAnnulla ? '<th></th>' : '') + '</tr></thead><tbody>' +
      lista.map(function (m) {
        var a = App.articolo(m.articoloId);
        var v = vistaDdt(m);
        return '<tr class="' + (m.annullato ? 'annullato' : '') + '">' +
          '<td>' + App.fmtData(m.data) + '</td>' +
          '<td class="tipo-' + m.tipo + '">' + h(App.TIPI[m.tipo] || m.tipo) + '</td>' +
          '<td><a href="#" data-scheda="' + h(m.articoloId) + '">' + h(App.nomeArticolo(m.articoloId)) + '</a></td>' +
          '<td class="n" data-etichetta="Quantità">' + App.fmtNum(m.quantita) + (a && a.unita ? ' <span class="tenue">' + h(a.unita) + '</span>' : '') + '</td>' +
          '<td class="mono" data-etichetta="Lotto">' + h(m.lotto || '') + '</td>' +
          '<td data-etichetta="Scadenza">' + (m.scadenza ? App.fmtScadenza(m.scadenza) : '') + '</td>' +
          '<td data-etichetta="Magazzino">' + h(nomeMagazzinoId(v ? v.repartoId : m.repartoId)) + '</td>' +
          '<td class="piccolo">' + (v ? '<a href="#" class="mono" data-ddt="' + h(v.ddt.id) + '" title="Apri il DDT">' + h(v.ddt.numero) + '</a> · ' : '') + h(riferimento(m)) + '</td>' +
          '<td class="piccolo tenue">' + h(m.operatore || '') + '</td>' +
          (conAnnulla ? '<td class="azioni">' + (puoAnnullare(m) ? '<button class="btn piccolo pericolo" type="button" data-annulla="' + h(m.id) + '">Annulla</button>' : '') + '</td>' : '') +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  // Collega i pulsanti "Annulla" e i link alle schede articolo di una tabella di movimenti.
  function collegaMovimenti(cont, dopo) {
    cont.addEventListener('click', function (e) {
      var s = e.target.closest('[data-scheda]');
      if (s) { e.preventDefault(); App.schedaArticolo(s.getAttribute('data-scheda')); return; }
      var dd = e.target.closest('[data-ddt]');
      if (dd) { e.preventDefault(); apriDdt(dd.getAttribute('data-ddt')); return; }
      var b = e.target.closest('[data-annulla]');
      if (!b) return;
      var id = b.getAttribute('data-annulla');
      var m = App.S.movimenti.filter(function (x) { return x.id === id; })[0];
      if (!m) return;
      App.chiedi('Annulla movimento', 'Perché annulli “' + (App.TIPI[m.tipo] || m.tipo) + ' di ' + App.fmtNum(m.quantita) + ' · ' + App.nomeArticolo(m.articoloId) + '”? Il movimento resta nell’elenco, barrato.', '', 'Annulla movimento')
        .then(function (motivo) {
          if (motivo === null) return;
          App.annullaMovimento(id, motivo || 'Annullato').then(function () {
            App.avviso('Movimento annullato');
            if (dopo) dopo(); else App.ridisegna();
          }, function (e) {
            App.avviso('Movimento non annullato: ' + messaggioErrore(e), 'errore');
            // già annullato o non più presente: ricarico i dati
            if (e.stato === 409 || e.stato === 404) root.Api.sincronizza().then(function () { if (dopo) dopo(); else App.ridisegna(); }, function () {});
          });
        });
    });
  }

  /* Apre il DDT nella pagina DDT e consegne (dalla scheda di un articolo la finestra si chiude prima). */
  function apriDdt(id) {
    App.chiudiModale();
    if (App.paginaPermessa('consegne')) App.vai('consegne', { id: id });
    else {
      var d = (App.S.ddt || []).filter(function (x) { return x.id === id; })[0];
      App.avviso(d ? 'DDT ' + d.numero + ': ' + App.nomeReparto(d.origineId) + ' → ' + App.nomeReparto(d.destinazioneId) : 'DDT non trovato', d ? 'ok' : 'errore');
    }
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
      return '<tr><td><b>' + h(nomeMagazzino(r)) + '</b></td><td class="n"><b>' + App.fmtNum(g[a.id + '|' + r.id]) + '</b></td><td>' +
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
      a.barcode && a.barcode.length ? 'Codici a barre: <b class="mono">' + descriviCodici(a.barcode).map(h).join(', ') + '</b>' : '',
      a.unita ? 'Unità: <b>' + h(a.unita) + '</b>' : '',
      a.pezziConfezione && a.pezziConfezione !== 1 ? 'Pezzi per confezione: <b>' + App.fmtNum(a.pezziConfezione) + '</b>' : '',
      'Prezzo unitario: <b>' + App.fmtEuro(a.prezzo) + '</b>',
      a.scortaMinima ? 'Scorta minima (' + h(App.repartoCentrale().nome) + '): <b>' + App.fmtNum(a.scortaMinima) + '</b>' : '',
      a.fornitore ? 'Fornitore abituale: <b>' + h(a.fornitore) + '</b>' : '',
      a.leadTime !== null && a.leadTime !== undefined ? 'Giorni di consegna: <b>' + App.fmtNum(a.leadTime) + '</b>' : ''
    ].filter(Boolean).join(' · ');
    var attributi = descriviAttributi(a.attributi);
    App.apriModale({
      titolo: a.nome,
      largo: true,
      corpo: '<p>' + etichettaCategoria(a.categoria) + (a.attivo === false ? ' <span class="etichetta">non attivo</span>' : '') +
        (App.sottoScorta(a) ? ' <span class="etichetta pericolo">sotto scorta</span>' : '') +
        attributi.map(function (t) { return ' <span class="etichetta attributo-articolo">' + h(t) + '</span>'; }).join('') + '</p>' +
        '<p class="piccolo">' + info + '</p>' + (a.note ? '<p class="piccolo tenue">' + h(a.note) + '</p>' : '') +
        '<h3>Giacenze e lotti</h3>' +
        (righe ? '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Reparto</th><th class="n">Giacenza</th><th>Lotti</th></tr></thead><tbody>' + righe + '</tbody></table></div>'
          : '<p class="tenue">Nessuna giacenza in nessun reparto.</p>') +
        '<h3>Ultimi movimenti</h3>' + tabellaMovimenti(movs, false),
      piede: (App.puo('articoli') ? '<button class="btn" type="button" id="sa-modifica">Modifica articolo</button>' : '') + '<span class="spazio"></span>' +
        (App.puo('carico') ? '<button class="btn" type="button" data-va="carico">📥 Carico</button>' : '') +
        (App.puo('ddt') && App.repartiScrivibili().length ? '<button class="btn" type="button" data-va="trasferimenti">🔁 Trasferisci</button>' : '') +
        (App.puo('perdita') && App.repartiScrivibili().length ? '<button class="btn" type="button" data-va="perdite">🗑️ Perdita</button>' : '') +
        '<button class="btn primario" type="button" data-chiudi>Chiudi</button>',
      dopo: function (m) {
        var mod = m.querySelector('#sa-modifica');
        if (mod) mod.addEventListener('click', function () { App.chiudiModale(); App.formArticolo(a.id); });
        m.querySelectorAll('[data-va]').forEach(function (b) {
          b.addEventListener('click', function () { App.chiudiModale(); App.vai(b.getAttribute('data-va'), { articoloId: a.id }); });
        });
        m.querySelectorAll('[data-scheda]').forEach(function (l) {
          l.addEventListener('click', function (e) { e.preventDefault(); });
        });
        m.querySelectorAll('[data-ddt]').forEach(function (l) {
          l.addEventListener('click', function (e) { e.preventDefault(); apriDdt(l.getAttribute('data-ddt')); });
        });
      }
    });
  };

  /* ======================= anagrafica articolo ======================= */

  /*
   * Modulo dell'articolo (nuovo o da modificare). dopo(id): chiamata dopo il salvataggio.
   * iniziali: valori proposti per un articolo nuovo (per esempio { barcode: [chiave], codice } dal codice non riconosciuto).
   */
  App.formArticolo = function (id, dopo, iniziali) {
    if (!App.puo('articoli')) return;
    var a = id ? App.articolo(id) : Object.assign({ categoria: 'FARMACI', attivo: true }, iniziali || {});
    if (!a) { App.avviso('L’articolo non c’è più: forse l’ha eliminato un altro utente.', 'errore'); return; }
    var unita = ['cpr', 'cps', 'fl', 'f', 'bustine', 'ml', 'flacone', 'tubo', 'conf', 'pz', 'paia', 'rotolo', 'sacca'];
    var B = root.Barcode;
    var codici = (a.barcode || []).slice();
    var boxCodici = null;
    var fotocamera = !!(root.Scanner && root.Scanner.fotocameraDisponibile());
    var AIUTO_CODICE = 'Leggi il codice con il lettore, oppure scrivilo e premi Invio';
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
        '<label class="campo" title="Quante unità (cpr, fl, pz…) ci sono in una confezione: con il lettore su “1 confezione” ogni lettura vale tanto così">' +
        '<span>Pezzi per confezione</span><input id="fa-pezzi" inputmode="decimal" value="' + h(App.fmtCampo(a.pezziConfezione || 1)) + '"></label>' +
        '<div class="campo largo campo-codici"><span>Codici a barre</span><div class="codici-articolo" id="fa-codici"></div>' +
        '<div class="campo-riga riga-codici"><input id="fa-codice-letto" autocomplete="off" spellcheck="false" placeholder="' + AIUTO_CODICE + '" aria-label="Nuovo codice a barre">' +
        '<button class="btn" type="button" id="fa-leggi">Aggiungi leggendo</button>' +
        (fotocamera ? '<button class="btn" type="button" id="fa-foto" title="Leggi con la fotocamera" aria-label="Leggi con la fotocamera">📷</button>' : '') + '</div>' +
        '<small class="tenue">Con questa finestra aperta ogni codice letto con il lettore si aggiunge all’articolo. Un codice appartiene a un solo articolo. ' +
        '“Pezzi per confezione”: quante unità ci sono in una confezione; con il lettore su “1 confezione” ogni lettura vale tanto così.</small></div>' +
        '<label class="campo"><span>Prezzo unitario €</span><input id="fa-prezzo" inputmode="decimal" value="' + (a.prezzo ? String(a.prezzo).replace('.', ',') : '') + '"></label>' +
        '<label class="campo"><span>Scorta minima in ' + h(App.repartoCentrale().nome) + '</span><input id="fa-scorta" inputmode="decimal" value="' + (a.scortaMinima || '') + '"></label>' +
        '<label class="campo"><span>Fornitore abituale</span><input id="fa-fornitore" list="dl-fornitori-articolo" value="' + h(a.fornitore || '') + '" placeholder="Es. il grossista da cui si ordina"></label>' +
        datalistFornitori().replace('id="dl-fornitori"', 'id="dl-fornitori-articolo"') +
        '<label class="campo" title="Giorni che il fornitore impiega a consegnare questo articolo: servono alle previsioni e alla proposta d’ordine. Vuoto = i giorni scritti in Configura">' +
        '<span>Giorni di consegna</span><input id="fa-leadtime" inputmode="numeric" value="' + (a.leadTime !== null && a.leadTime !== undefined ? h(App.fmtCampo(a.leadTime)) : '') + '" placeholder="vuoto = ' + App.fmtNum(leadTimeGenerale()) + ' (generale)"></label>' +
        '<fieldset class="campo largo attributi-articolo"><legend>Caratteristiche</legend><div class="attributi-scelte">' +
        ATTRIBUTI_ARTICOLO.map(function (x) {
          return '<label class="spunta"><input type="checkbox" data-attributo="' + h(x.id) + '"' + ((a.attributi || []).indexOf(x.id) >= 0 ? ' checked' : '') + '> ' + h(x.testo) + '</label>';
        }).join('') + '</div><small class="tenue">Servono alla disposizione automatica degli armadi (frigorifero, cassaforte) e a riconoscere gli articoli da trattare con attenzione.</small></fieldset>' +
        '<label class="campo largo"><span>Note</span><textarea id="fa-note">' + h(a.note || '') + '</textarea></label>' +
        '<label class="spunta"><input type="checkbox" id="fa-attivo"' + (a.attivo !== false ? ' checked' : '') + '> Articolo attivo (si può caricare e scaricare)</label>' +
        '</div>',
      piede: (id ? '<button class="btn pericolo" type="button" id="fa-elimina">Elimina</button><span class="spazio"></span>' : '') +
        '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="fa-salva">Salva</button>',
      allaChiusura: function () { if (root.Scanner && boxCodici) root.Scanner.rilascia(boxCodici); },
      dopo: function (m) {
        // ---- codici a barre: elenco (si toglie con ×), lettura con il lettore, a mano o con la fotocamera ----
        boxCodici = m.querySelector('#fa-codici');
        var campoCodice = m.querySelector('#fa-codice-letto');
        function disegnaCodici(nuovo) {
          boxCodici.innerHTML = codici.length ? codici.map(function (k, i) {
            var d = h(B.descrivi(k));
            return '<span class="codice-chip' + (k === nuovo ? ' nuovo' : '') + '"><span class="mono">' + d + '</span>' +
              '<button type="button" data-togli-codice="' + i + '" title="Togli il codice" aria-label="Togli il codice ' + d + '">×</button></span>';
          }).join('') : '<span class="tenue piccolo">Nessun codice: aggiungine uno per riconoscere l’articolo con il lettore.</span>';
        }
        // true se il codice è stato aggiunto (o c'era già)
        function aggiungiCodice(info) {
          var k = info && info.chiavi && info.chiavi[0];
          if (!k) { suonoLettura('errore'); App.avviso('Il codice letto non identifica un prodotto: leggi il codice a barre della confezione.', 'errore'); return false; }
          if (codici.indexOf(k) >= 0) { App.avviso('Il codice ' + B.descrivi(k) + ' è già nell’elenco.'); return true; }
          var altro = App.S.articoli.filter(function (x) { return x.id !== id && (x.barcode || []).indexOf(k) >= 0; })[0];
          if (altro) { suonoLettura('errore'); App.avviso('Il codice ' + B.descrivi(k) + ' è già associato all’articolo «' + altro.nome + '».', 'errore'); return false; }
          codici.push(k);
          var cod = m.querySelector('#fa-codice');
          if (info.aic && !cod.value.trim()) cod.value = info.aic;
          disegnaCodici(k);
          suonoLettura('ok');
          campoCodice.classList.remove('scanner-in-attesa');
          campoCodice.placeholder = AIUTO_CODICE;
          return true;
        }
        disegnaCodici();
        boxCodici.addEventListener('click', function (e) {
          var b = e.target.closest('[data-togli-codice]');
          if (!b) return;
          codici.splice(Number(b.getAttribute('data-togli-codice')), 1);
          disegnaCodici();
        });
        campoCodice.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          var t = campoCodice.value.trim();
          campoCodice.value = '';
          if (t) aggiungiCodice(B.analizza(t));
        });
        m.querySelector('#fa-leggi').addEventListener('click', function () {
          campoCodice.classList.add('scanner-in-attesa');
          campoCodice.placeholder = 'Leggi ora il codice con il lettore…';
          campoCodice.focus();
        });
        var bFoto = m.querySelector('#fa-foto');
        if (bFoto) bFoto.addEventListener('click', function () {
          root.Scanner.apriFotocamera({ alLeggere: function (t) { aggiungiCodice(B.analizza(t)); } });
        });
        // con il modulo aperto le letture del lettore (in qualsiasi campo) vanno nell'elenco dei codici
        if (root.Scanner) root.Scanner.cattura(aggiungiCodice, boxCodici);

        m.querySelector('#fa-salva').addEventListener('click', function () {
          var nome = valore(m, '#fa-nome').trim();
          if (!nome) { App.avviso('Scrivi la denominazione.', 'errore'); return; }
          var doppio = App.articoloPerNome(nome);
          if (doppio && doppio.id !== id) { App.avviso('Esiste già un articolo con questo nome.', 'errore'); return; }
          // codice scritto nel campo ma non ancora aggiunto con Invio
          var scritto = campoCodice.value.trim();
          if (scritto) {
            campoCodice.value = '';
            if (!aggiungiCodice(B.analizza(scritto))) return;
          }
          var testoPezzi = valore(m, '#fa-pezzi').trim();
          var pezzi = testoPezzi ? App.numero(testoPezzi) : 1;
          if (!(pezzi > 0)) { App.avviso('Pezzi per confezione: scrivi un numero maggiore di zero.', 'errore'); return; }
          var testoLt = valore(m, '#fa-leadtime').trim();
          var leadTime = testoLt ? App.numero(testoLt) : null;
          if (testoLt && !(leadTime >= 0 && leadTime <= 365)) { App.avviso('Giorni di consegna: scrivi un numero da 0 a 365, oppure lascia vuoto per usare quelli generali.', 'errore'); return; }
          var attributi = Array.prototype.filter.call(m.querySelectorAll('[data-attributo]'), function (c) { return c.checked; })
            .map(function (c) { return c.getAttribute('data-attributo'); });
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
            attivo: m.querySelector('#fa-attivo').checked,
            barcode: codici.slice(),
            pezziConfezione: pezzi,
            attributi: attributi,
            fornitore: valore(m, '#fa-fornitore').trim(),
            leadTime: leadTime === null ? null : Math.round(leadTime)
          };
          var bottone = this;
          bottone.disabled = true;
          // in modifica mando la versione letta all'apertura: se un altro l'ha cambiata nel frattempo il server risponde 409
          var richiesta = id
            ? root.Api.scrivi('PUT', '/api/articoli/' + encodeURIComponent(id), Object.assign({ versione: a.versione }, dati))
            : root.Api.scrivi('POST', '/api/articoli', dati);
          richiesta.then(function (r) {
            App.chiudiModale();
            App.avviso(id ? 'Articolo aggiornato' : 'Articolo creato', 'ok');
            datalistArticoli();
            var nuovoId = id || (r && r.articolo && r.articolo.id);
            if (dopo && nuovoId && App.articolo(nuovoId)) dopo(nuovoId); else App.aggiornaVista();
          }, function (e) {
            bottone.disabled = false;
            if (id && e.stato === 409) {
              // 409: o un altro utente ha cambiato l'articolo (versione diversa), o il nome è già di un altro articolo
              root.Api.sincronizza().then(function () {
                var ora = App.articolo(id);
                if (ora && ora.versione === a.versione) {
                  // l'articolo non è cambiato: è il nome doppio. Il modulo resta aperto con quello che ha scritto l'utente
                  App.avviso(messaggioErrore(e), 'errore');
                  return;
                }
                App.chiudiModale();
                App.avviso('Un altro utente ha modificato l’articolo: ricarico i dati', 'errore');
                App.aggiornaVista();
                if (ora) App.formArticolo(id, dopo); // riapro con i dati aggiornati
                else App.avviso('L’articolo non c’è più: l’ha eliminato un altro utente.', 'errore');
              }, function () { App.avviso(messaggioErrore(e), 'errore'); });
              return;
            }
            App.avviso(messaggioErrore(e), 'errore');
          });
        });
        var el = m.querySelector('#fa-elimina');
        if (el) el.addEventListener('click', function () {
          var usato = App.S.movimenti.some(function (x) { return x.articoloId === id; });
          if (usato) {
            App.avviso('L’articolo ha dei movimenti: non si può eliminare. Togli la spunta “Articolo attivo” per nasconderlo.', 'errore');
            return;
          }
          var inDocumenti = (App.S.richiesteRighe || []).some(function (x) { return x.articoloId === id; }) ||
            (App.S.ddtRighe || []).some(function (x) { return x.articoloId === id; });
          if (inDocumenti) {
            App.avviso('L’articolo compare in richieste o DDT: non si può eliminare. Togli la spunta “Articolo attivo” per nasconderlo.', 'errore');
            return;
          }
          var scorte = (App.S.assortimento || []).filter(function (x) { return x.articoloId === id && x.attivo !== false; });
          if (scorte.length) {
            App.avviso('L’articolo è nell’assortimento di ' + scorte.map(function (x) { return App.nomeReparto(x.repartoId); }).join(', ') +
              ': toglilo prima da Magazzini e assortimento, oppure togli la spunta “Articolo attivo” per nasconderlo.', 'errore');
            return;
          }
          App.conferma('Elimina articolo', 'Elimino “' + h(a.nome) + '” dall’anagrafica?', 'Elimina', true).then(function (ok) {
            if (!ok) return;
            root.Api.scrivi('DELETE', '/api/articoli/' + encodeURIComponent(id)).then(function () {
              App.avviso('Articolo eliminato');
              datalistArticoli();
              App.aggiornaVista();
            }, function (e) { App.avviso(messaggioErrore(e), 'errore'); });
          });
        });
      }
    });
  };

  /* ======================= moduli a righe: carico e perdite ======================= */

  /*
   * cfg: { tipo, titolo, testata(html), colonne: ['lotto'|'scadenza'|'prezzo'|'lotto-scelta'|'causale'|'note'],
   *        repartoOrigine(cont), leggiTestata(cont), recenti(filtro),
   *        lettore: 'unita'|'confezione' (barra del lettore di codici a barre e quanto vale una lettura) }
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

    cont.innerHTML = (cfg.lettore ? barraLettore(cfg.lettore) : '') + scheda(cfg.titolo,
      '<div class="modulo">' + cfg.testata + '</div>' +
      '<div class="tabella-contenitore" style="margin-top:16px"><table class="righe"><thead><tr>' + intest + '</tr></thead><tbody id="righe"></tbody></table></div>' +
      '<div class="strumenti" style="margin-top:12px"><button class="btn" type="button" id="riga-piu">+ Aggiungi riga</button>' +
      (App.puo('articoli') ? '<button class="btn" type="button" id="nuovo-art">Nuovo articolo</button>' : '') + '<span class="spazio"></span>' +
      '<button class="btn primario" type="button" id="registra">' + h(cfg.pulsante) + '</button></div>',
      '<span class="nota">' + h(cfg.nota || '') + '</span>') +
      '<div id="recenti"></div>' + (cfg.extra || '');

    var tbody = cont.querySelector('#righe');

    function opzioniLotti(articoloId) {
      var rep = cfg.repartoOrigine(cont);
      if (!articoloId || !rep) return '<option value="">automatico</option>';
      var l = C.lotti(App.S, articoloId, rep).filter(function (x) { return x.quantita > 0 && x.lotto; });
      var oggi = App.oggi();
      // la scelta automatica di consumi e trasferimenti salta i lotti scaduti (si tolgono con una perdita "Scaduto")
      return '<option value="">automatico (scade prima)</option>' + l.map(function (x) {
        return '<option value="' + h(x.lotto) + '">' + h(x.lotto) + ' · ' + App.fmtNum(x.quantita) + (x.scadenza ? ' · ' + App.fmtScadenza(x.scadenza) : '') +
          (C.scaduto(x.scadenza, oggi) ? ' · SCADUTO' : '') + '</option>';
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
      // prezzo proposto dall'anagrafica: se l'articolo della riga cambia, cambia anche il prezzo
      // (a meno che l'utente non l'abbia scritto a mano)
      var pr = tr.querySelector('.r-prezzo');
      if (pr && pr.getAttribute('data-per') !== a.id) {
        var proposto = pr.getAttribute('data-proposto');
        if (!pr.value || pr.value === proposto) {
          pr.value = a.prezzo ? App.fmtCampo(a.prezzo) : '';
          pr.setAttribute('data-proposto', pr.value);
        }
        pr.setAttribute('data-per', a.id);
      }
    }

    function nuovaRiga(articoloId) {
      var a = articoloId ? App.articolo(articoloId) : null;
      var tr = document.createElement('tr');
      // data-etichetta: sul telefono la riga diventa una scheda e il titolo della colonna va sopra la casella (css/app.css)
      tr.innerHTML = '<td data-etichetta="Articolo"><input class="r-art" list="dl-articoli" placeholder="Scrivi le prime lettere…" aria-label="Articolo" value="' + h(a ? a.nome : '') + '"><div class="info-riga"></div></td>' +
        '<td data-etichetta="Quantità"><input class="q r-q" inputmode="decimal" placeholder="0" aria-label="Quantità"></td>' +
        (col.indexOf('lotto') >= 0 ? '<td data-etichetta="Lotto"><input class="r-lotto" placeholder="Lotto" aria-label="Lotto"></td>' : '') +
        (col.indexOf('scadenza') >= 0 ? '<td data-etichetta="Scadenza"><input class="r-scad" type="month" aria-label="Scadenza"></td>' : '') +
        (col.indexOf('prezzo') >= 0 ? '<td data-etichetta="Prezzo unit. €"><input class="r-prezzo" inputmode="decimal" style="width:100px" aria-label="Prezzo unitario in euro"></td>' : '') +
        (col.indexOf('lotto-scelta') >= 0 ? '<td data-etichetta="Lotto"><select class="r-lotto-scelta" aria-label="Lotto">' + opzioniLotti(articoloId) + '</select></td>' : '') +
        (col.indexOf('causale') >= 0 ? '<td data-etichetta="Causale"><select class="r-causale" aria-label="Causale">' + App.CAUSALI_PERDITA.map(function (c) { return '<option>' + h(c) + '</option>'; }).join('') + '</select></td>' : '') +
        (col.indexOf('note') >= 0 ? '<td data-etichetta="Note"><input class="r-note" aria-label="Note"></td>' : '') +
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
    var nuovoArt = cont.querySelector('#nuovo-art');
    if (nuovoArt) nuovoArt.addEventListener('click', function () {
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

    /*
     * Lettore di codici a barre: aggiunge una riga con l'articolo (quantità = una lettura), con lotto e scadenza
     * del codice GS1; se c'è già una riga con lo stesso articolo e lo stesso lotto ne aumenta la quantità.
     * Trasferimenti e perdite: se il lotto del codice è disponibile nel reparto di partenza lo sceglie nella riga.
     */
    function rigaVuota() {
      return Array.prototype.filter.call(tbody.querySelectorAll('tr'), function (tr) {
        return !tr.querySelector('.r-art').value.trim() && !tr.querySelector('.r-q').value.trim();
      })[0] || null;
    }
    if (cfg.lettore) {
      collegaLettore(cont);
      App.gestoreScansione = function (info, a, passo) {
        // durante la registrazione la pagina si ridisegna: una lettura fatta adesso andrebbe persa
        if (cont.querySelector('#registra').disabled) { App.avviso('Sto registrando: aspetta un attimo e leggi di nuovo il codice.', 'errore'); return false; }
        var conLotto = col.indexOf('lotto') >= 0;
        var conScelta = col.indexOf('lotto-scelta') >= 0;
        var lottoCodice = info.lotto || '';
        var lottoScelto = '';
        var nota = '';
        if (conScelta && lottoCodice) {
          var rep = cfg.repartoOrigine(cont);
          var disponibile = C.lotti(App.S, a.id, rep).some(function (x) { return x.quantita > 0 && x.lotto === lottoCodice; });
          if (disponibile) lottoScelto = lottoCodice;
          else nota = ' · il lotto ' + lottoCodice + ' non è in ' + App.nomeReparto(rep) + ': uso quello che scade prima';
        }
        var tr = Array.prototype.filter.call(tbody.querySelectorAll('tr'), function (r) {
          var x = App.articoloPerNome(r.querySelector('.r-art').value);
          if (!x || x.id !== a.id) return false;
          if (conLotto) return r.querySelector('.r-lotto').value.trim() === lottoCodice;
          if (conScelta) return r.querySelector('.r-lotto-scelta').value === lottoScelto;
          return true;
        })[0];
        if (!tr) {
          tr = rigaVuota() || nuovaRiga();
          tr.querySelector('.r-art').value = a.nome;
          aggiornaInfo(tr);
          if (conLotto) tr.querySelector('.r-lotto').value = lottoCodice;
          if (conScelta) tr.querySelector('.r-lotto-scelta').value = lottoScelto;
          // resta sempre una riga vuota in fondo per scrivere a mano
          if (!rigaVuota()) nuovaRiga();
        }
        var scad = tr.querySelector('.r-scad');
        if (scad && info.scadenza && !scad.value) scad.value = info.scadenza;
        var q = tr.querySelector('.r-q');
        q.value = App.fmtCampo(C.r3(App.numero(q.value) + passo));
        evidenziaLettura(tr);
        return 'Letto: ' + a.nome + ' (+' + App.fmtNum(passo) + ')' + (conLotto && lottoCodice ? ' · lotto ' + lottoCodice : '') +
          (lottoScelto ? ' · lotto ' + lottoScelto : '') + nota;
      };
    }

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
      var bottone = this;
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
        bottone.disabled = true;
        App.aggiungiMovimenti(movimenti).then(function () {
          App.avviso(cfg.fatto(lette.righe.length), 'ok');
          // modulo pulito per la registrazione dopo (se nel frattempo l'utente non è passato a un'altra pagina)
          if (document.body.contains(cont)) App.mostra(App.paginaCorrente);
        }, function (e) {
          // il modulo resta com'è: si può correggere e riprovare
          bottone.disabled = false;
          App.avviso('Non registrato: ' + messaggioErrore(e), 'errore');
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
      lettore: 'confezione',
      repartoOrigine: function (c) { return valore(c, '#t-rep'); },
      leggiTestata: function (c) {
        var t = { data: valore(c, '#t-data'), repartoId: valore(c, '#t-rep'), fornitore: valore(c, '#t-forn').trim(), documento: valore(c, '#t-doc').trim() };
        if (!t.data) t.errore = 'Indica la data del carico.';
        return t;
      },
      prepara: function (t, righe) {
        // un carico con prezzo aggiorna il prezzo dell'articolo: lo fa il server
        return righe.map(function (r) {
          return { tipo: 'carico', data: t.data, articoloId: r.articolo.id, repartoId: t.repartoId, quantita: r.quantita, lotto: r.lotto || '', scadenza: r.scadenza || '', fornitore: t.fornitore, documento: t.documento, prezzo: r.prezzo || undefined };
        });
      },
      fatto: function (n) { return 'Carico registrato (' + n + (n === 1 ? ' articolo)' : ' articoli)'); },
      titoloRecenti: 'Ultimi carichi',
      recenti: function (m) { return m.tipo === 'carico'; }
    }, par);
  };

  /* ======================= PERDITE ======================= */

  P.perdite = function (cont, par) {
    // solo i reparti in cui l'utente può registrare
    var lista = App.repartiScrivibili();
    if (!lista.length) { cont.innerHTML = senzaReparti(); return; }
    if (par.repartoId && !lista.some(function (r) { return r.id === par.repartoId; })) {
      // arrivo da Scadenze per un reparto non attivo o non mio: non passo in silenzio a un altro reparto
      App.avviso('Non puoi registrare perdite in ' + App.nomeReparto(par.repartoId) + ' (reparto non attivo o non tuo).', 'errore');
      par = {};
    }
    var rep = repartoTra(lista, par.repartoId, true);
    moduloRighe(cont, {
      titolo: 'Perdite, scaduti e resi',
      nota: 'Nel registro mensile finiscono nella colonna “Perdite”.',
      pulsante: 'Registra perdita',
      testata:
        '<label class="campo"><span>Data</span><input type="date" id="t-data" value="' + App.oggi() + '"></label>' +
        '<label class="campo"><span>Reparto</span><select id="t-rep" class="cambia-origine">' + opzioniReparti(rep, false, lista) + '</select></label>',
      colonne: ['lotto-scelta', 'causale', 'note'],
      lettore: 'unita',
      controllaGiacenza: true,
      repartoOrigine: function (c) { return valore(c, '#t-rep'); },
      leggiTestata: function (c) {
        var t = { data: valore(c, '#t-data'), repartoId: valore(c, '#t-rep') };
        if (!t.data) t.errore = 'Indica la data.';
        return t;
      },
      prepara: function (t, righe) {
        return righe.map(function (r) {
          return { tipo: 'perdita', data: t.data, articoloId: r.articolo.id, repartoId: t.repartoId, quantita: r.quantita, lotto: r.lottoScelto || undefined, causale: r.causale, note: r.note };
        });
      },
      fatto: function () { return 'Perdita registrata'; },
      titoloRecenti: 'Ultime perdite',
      recenti: function (m) { return m.tipo === 'perdita'; }
    }, par);
    // arrivo dalla pagina Scadenze: lotto scaduto già scelto
    if (par.lotto && par.articoloId && rep === par.repartoId) {
      var tr = cont.querySelector('#righe tr');
      var sel = tr.querySelector('.r-lotto-scelta');
      sel.value = par.lotto;
      tr.querySelector('.r-q').value = App.fmtCampo(par.quantita || '');
      tr.querySelector('.r-causale').value = 'Scaduto';
    }
  };

  /* ======================= CONSUMI DEL GIORNO ======================= */

  var memoriaConsumi = {};
  // quantità scritte e non ancora registrate ('reparto|data|articolo' -> testo): restano anche se la tabella
  // si ridisegna (filtri, ricerca, annulli, "Aggiorna" dopo i movimenti di altri utenti)
  var scrittiConsumi = {};
  var contatiInventario = {};

  /* Dopo l'uscita o con un altro utente le scelte di prima (date, filtri, quantità scritte) si dimenticano. */
  App.dimenticaScelte = function () {
    memoriaConsumi = {};
    memoriaRegistro = {};
    scrittiConsumi = {};
    contatiInventario = {};
    if (App.dimenticaAttivita) App.dimenticaAttivita();
  };

  P.consumi = function (cont, par) {
    // solo i reparti in cui l'utente può registrare
    var reparti = App.repartiScrivibili();
    if (!reparti.length) { cont.innerHTML = senzaReparti(); return; }
    // magazzino chiesto da un'altra pagina (per esempio "Consumi" dal pannello degli Armadi), altrimenti quello ricordato
    var rep = repartoTra(reparti, (par && par.repartoId) || memoriaConsumi.rep, false);
    // la data scelta vale per la giornata in cui è stata scelta: il giorno dopo si riparte da oggi
    var data = memoriaConsumi.data && memoriaConsumi.sceltaIl === App.oggi() ? memoriaConsumi.data : App.oggi();
    var cat = memoriaConsumi.cat || '';
    var tutti = !!memoriaConsumi.tutti;

    cont.innerHTML = barraLettore('unita') +
      '<div class="strumenti">' +
      '<label class="campo"><span>Data</span><input type="date" id="c-data" value="' + data + '"></label>' +
      '<label class="campo"><span>Reparto</span><select id="c-rep">' + opzioniReparti(rep, false, reparti) + '</select></label>' +
      '<label class="campo"><span>Categoria</span><select id="c-cat">' + opzioniCategoria(cat, true) + '</select></label>' +
      '<label class="campo"><span>Cerca</span><input id="c-cerca" type="search" placeholder="Filtra per nome…"></label>' +
      '<label class="spunta"><input type="checkbox" id="c-tutti"' + (tutti ? ' checked' : '') + '> Mostra anche gli articoli senza giacenza</label>' +
      '<span class="spazio"></span>' +
      '<button class="btn primario" type="button" id="c-registra">Registra consumi</button>' +
      '</div><div id="c-foglio"></div><div id="c-fatti"></div>';

    function stato() {
      memoriaConsumi = { rep: valore(cont, '#c-rep'), data: valore(cont, '#c-data'), cat: valore(cont, '#c-cat'), tutti: cont.querySelector('#c-tutti').checked, sceltaIl: App.oggi() };
      return memoriaConsumi;
    }
    function chiave(st, art) { return st.rep + '|' + st.data + '|' + art; }

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
        return st.tutti || App.giacenza(a.id, st.rep) > 0 || gia[a.id] || scrittiConsumi[chiave(st, a.id)];
      });
      var corpo;
      if (!lista.length) {
        corpo = vuoto(App.S.articoli.length ? 'Nessun articolo con giacenza in questo reparto' : 'Nessun articolo in anagrafica',
          App.S.articoli.length ? 'Spunta “Mostra anche gli articoli senza giacenza” oppure registra un carico o un trasferimento verso il reparto.' : 'Aggiungi gli articoli dalla pagina Articoli.');
      } else {
        // a-schede: sul telefono ogni articolo è una scheda (nome sopra, numeri e casella sotto: css/app.css)
        corpo = '<div class="tabella-contenitore"><table class="tabella a-schede"><thead><tr><th>Articolo</th><th>Categoria</th><th class="n">Giacenza</th><th class="n">Già registrati</th><th class="n">Consumo da registrare</th></tr></thead><tbody>' +
          lista.map(function (a) {
            return '<tr><td><a href="#" data-scheda="' + h(a.id) + '">' + h(a.nome) + '</a>' + (a.confezione ? ' <span class="tenue piccolo">' + h(a.confezione) + '</span>' : '') + '</td>' +
              '<td>' + etichettaCategoria(a.categoria) + '</td>' +
              '<td class="n" data-etichetta="Giacenza">' + App.fmtNum(App.giacenza(a.id, st.rep)) + (a.unita ? ' <span class="tenue">' + h(a.unita) + '</span>' : '') + '</td>' +
              '<td class="n" data-etichetta="Già registrati">' + (gia[a.id] ? App.fmtNum(gia[a.id]) : '<span class="tenue">—</span>') + '</td>' +
              '<td class="n" data-etichetta="Consumo"><input class="q" inputmode="decimal" data-art="' + h(a.id) + '" placeholder="0" value="' + h(scrittiConsumi[chiave(st, a.id)] || '') + '" aria-label="Consumo di ' + h(a.nome) + '"></td></tr>';
          }).join('') + '</tbody></table></div>';
      }
      cont.querySelector('#c-foglio').innerHTML = scheda('Consumi di ' + h(App.nomeReparto(st.rep)) + ' · ' + App.dataLunga(st.data), corpo,
        '<span class="nota">Scrivi le quantità usate, poi “Registra consumi”. Invio passa alla riga sotto.</span>', true);
      var fatti = movimentiRecenti(function (m) { return m.tipo === 'consumo' && m.repartoId === st.rep && m.data === st.data; }, 200);
      cont.querySelector('#c-fatti').innerHTML = scheda('Consumi già registrati in questo giorno', tabellaMovimenti(fatti, true), '', true);
      cont.querySelectorAll('#c-foglio input.q').forEach(function (inp) { inp.closest('tr').classList.toggle('compilata', App.numero(inp.value) > 0); });
    }

    cont.querySelectorAll('#c-data, #c-rep, #c-cat, #c-tutti').forEach(function (el) { el.addEventListener('change', disegna); });
    cont.querySelector('#c-cerca').addEventListener('input', disegna);
    cont.addEventListener('input', function (e) {
      if (!e.target.classList.contains('q')) return;
      e.target.closest('tr').classList.toggle('compilata', App.numero(e.target.value) > 0);
      var k = chiave(stato(), e.target.getAttribute('data-art'));
      if (e.target.value.trim()) scrittiConsumi[k] = e.target.value; else delete scrittiConsumi[k];
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
      var bottone = this;
      var st = stato();
      var righe = [];
      // anche le quantità scritte in righe ora nascoste dal filtro
      Object.keys(scrittiConsumi).forEach(function (k) {
        var p = k.split('|');
        if (p[0] !== st.rep || p[1] !== st.data) return;
        var q = App.numero(scrittiConsumi[k]);
        if (q > 0 && App.articolo(p[2])) righe.push({ articoloId: p[2], quantita: q });
      });
      if (!righe.length) { App.avviso('Non hai scritto nessuna quantità.', 'errore'); return; }
      var scoperti = righe.filter(function (r) { return r.quantita > App.giacenza(r.articoloId, st.rep); });
      var procedi = scoperti.length
        ? App.conferma('Giacenza insufficiente', 'In ' + h(App.nomeReparto(st.rep)) + ' non c’è abbastanza giacenza per: <b>' +
          scoperti.map(function (r) { return h(App.nomeArticolo(r.articoloId)); }).join(', ') + '</b>. Registro lo stesso?', 'Registra lo stesso')
        : Promise.resolve(true);
      procedi.then(function (ok) {
        if (!ok) return;
        // una riga per articolo: la ripartizione sui lotti la fa il server
        var movimenti = righe.map(function (r) {
          return { tipo: 'consumo', data: st.data, articoloId: r.articoloId, repartoId: st.rep, quantita: r.quantita };
        });
        // quello che si manda: una quantità riscritta durante la registrazione resta da registrare
        var inviati = {};
        righe.forEach(function (r) { var k = chiave(st, r.articoloId); inviati[k] = scrittiConsumi[k]; });
        bottone.disabled = true;
        App.aggiungiMovimenti(movimenti).then(function () {
          bottone.disabled = false;
          Object.keys(inviati).forEach(function (k) { if (scrittiConsumi[k] === inviati[k]) delete scrittiConsumi[k]; });
          App.avviso('Consumi registrati: ' + righe.length + (righe.length === 1 ? ' articolo' : ' articoli'), 'ok');
          disegna();
        }, function (e) {
          // le quantità scritte restano: si può riprovare
          bottone.disabled = false;
          App.avviso('Consumi non registrati: ' + messaggioErrore(e), 'errore');
        });
      });
    });

    // movimenti di altri utenti: giacenze e "già registrati" si aggiornano, le quantità scritte e il cursore restano
    App.rinfresca = function () {
      if (!document.body.contains(cont)) return;
      var a = document.activeElement;
      var fuoco = a && cont.contains(a) && a.matches('input.q[data-art]') ? a.getAttribute('data-art') : null;
      disegna();
      if (fuoco) { var i = cont.querySelector('input.q[data-art="' + fuoco + '"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
    };

    // lettore di codici a barre: la quantità scritta dell'articolo aumenta di una lettura (la riga compare anche
    // se l'articolo non ha giacenza nel reparto), poi la riga si evidenzia e si porta in vista
    collegaLettore(cont);
    var rinfrescaConsumi = App.rinfresca;
    App.gestoreScansione = function (info, a, passo) {
      if (cont.querySelector('#c-registra').disabled) { App.avviso('Sto registrando: aspetta un attimo e leggi di nuovo il codice.', 'errore'); return false; }
      mostraArticoloNeiFiltri(cont, '#c-cat', '#c-cerca', a);
      var k = chiave(stato(), a.id);
      scrittiConsumi[k] = App.fmtCampo(C.r3(App.numero(scrittiConsumi[k] || '') + passo));
      rinfrescaConsumi();
      var inp = cont.querySelector('input.q[data-art="' + a.id + '"]');
      if (inp) evidenziaLettura(inp.closest('tr'));
      return 'Letto: ' + a.nome + ' (+' + App.fmtNum(passo) + ') · da registrare: ' + App.fmtNum(App.numero(scrittiConsumi[k])) + (a.unita ? ' ' + a.unita : '');
    };
    disegna();
    var primo = cont.querySelector('input.q');
    if (primo) primo.focus();
  };

  /* ======================= GIACENZE ======================= */

  P.giacenze = function (cont, par) {
    par = par || {};
    // magazzino chiesto da un'altra pagina; dal cruscotto ("Sotto scorta") chi ha un solo magazzino vede il suo
    var mieiRep = App.permessi && App.permessi.reparti;
    var repIniziale = par.repartoId && App.reparto(par.repartoId) ? par.repartoId
      : (par.soloSotto && mieiRep && mieiRep.length === 1 && App.reparto(mieiRep[0]) ? mieiRep[0] : '');
    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Reparto</span><select id="g-rep">' + opzioniReparti(repIniziale, true) + '</select></label>' +
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
      if (rep && !App.reparto(rep)) rep = ''; // reparto eliminato nel frattempo da un altro utente
      var cat = valore(cont, '#g-cat');
      var testo = valore(cont, '#g-cerca').trim().toLowerCase();
      var sotto = cont.querySelector('#g-sotto').checked;
      var zero = cont.querySelector('#g-zero').checked;
      var reparti = rep ? [App.reparto(rep)] : App.repartiAttivi();
      var oggi = App.oggi();
      // merce partita con un DDT e non ancora ricevuta: verso il magazzino scelto, o verso tutti
      var perArrivo = C.merceInViaggio ? C.merceInViaggio(App.S) : {};
      var viaggio = {};
      Object.keys(perArrivo).forEach(function (k) {
        var p = k.split('|');
        if (rep && p[1] !== rep) return;
        viaggio[p[0]] = C.r3((viaggio[p[0]] || 0) + perArrivo[k]);
      });
      var conViaggio = Object.keys(perArrivo).length > 0;
      // sotto scorta con le soglie del cruscotto: assortimento di ogni magazzino, anagrafica nella farmacia centrale
      var sottoIn = {};
      App.S.articoli.forEach(function (a) {
        var l = App.magazziniSottoScorta(a, rep || null);
        if (l.length) sottoIn[a.id] = l;
      });
      var centrale = App.repartoCentrale();
      var repSoglia = rep || (centrale && centrale.id);
      var lottiDi = App.lottiPerCoppia();
      var lista = App.S.articoli.filter(function (a) {
        if (cat && a.categoria !== cat) return false;
        if (testo && (a.nome + ' ' + (a.principio || '') + ' ' + (a.codice || '')).toLowerCase().indexOf(testo) < 0) return false;
        if (sotto && !sottoIn[a.id]) return false;
        var tot = reparti.reduce(function (s, r) { return s + App.giacenza(a.id, r.id); }, 0);
        if (!zero && !tot && !sotto && !viaggio[a.id]) return false;
        return true;
      }).sort(function (x, y) { return x.nome.localeCompare(y.nome, 'it'); });

      dati.colonne = [{ titolo: 'Articolo', larghezza: 42 }, { titolo: 'Categoria', larghezza: 11 }]
        .concat(reparti.map(function (r) { return { titolo: r.nome, larghezza: 13 }; }))
        .concat(conViaggio ? [{ titolo: rep ? 'In viaggio verso ' + App.nomeReparto(rep) : 'In viaggio (DDT)', larghezza: 14 }] : [])
        .concat(rep ? [{ titolo: 'Prossima scadenza', larghezza: 16 }] : [{ titolo: 'Totale', larghezza: 11 }])
        .concat([{ titolo: rep ? 'Scorta minima' : 'Scorta minima (farmacia centrale)', larghezza: 13 }, { titolo: 'Valore €', larghezza: 12 }]);
      dati.righe = [];
      var valoreTot = 0;

      var corpo = lista.map(function (a) {
        var valori = reparti.map(function (r) { return App.giacenza(a.id, r.id); });
        var tot = valori.reduce(function (s, x) { return s + x; }, 0);
        var val = Math.round(tot * (a.prezzo || 0) * 100) / 100;
        valoreTot += val;
        var prossima = '';
        if (rep) {
          // lotti di tutte le coppie in una passata sola (App.lottiPerCoppia), invece di rileggere i movimenti per ogni riga
          var l = (lottiDi[a.id + '|' + rep] || []).filter(function (x) { return x.quantita > 0 && x.scadenza; });
          prossima = l.length ? l[0].scadenza : '';
        }
        var inViaggio = viaggio[a.id] || 0;
        var minima = repSoglia ? App.scortaMinima(a, repSoglia) : 0;
        var dove = sottoIn[a.id] || [];
        dati.righe.push([a.nome, a.categoria].concat(valori).concat(conViaggio ? [inViaggio] : []).concat(rep ? [prossima ? App.fmtScadenza(prossima) : ''] : [tot]).concat([minima || '', val]));
        var stScad = prossima ? App.statoScadenza(C.giorniAllaScadenza(prossima, oggi)) : null;
        return '<tr class="cliccabile" data-scheda="' + h(a.id) + '"><td>' + h(a.nome) + (a.attivo === false ? ' <span class="etichetta">non attivo</span>' : '') + '</td>' +
          '<td>' + etichettaCategoria(a.categoria) + '</td>' +
          valori.map(function (v, i) {
            var r = reparti[i];
            var basso = dove.indexOf(r) >= 0;
            return '<td class="n' + (v < 0 ? ' neg' : '') + (basso ? ' sotto-scorta' : '') + '"' +
              (basso ? ' title="Sotto la scorta minima di ' + h(r.nome) + ' (' + h(App.fmtNum(App.scortaMinima(a, r.id))) + ')"' : '') + '>' +
              (v ? App.fmtNum(v) : '<span class="tenue">0</span>') + (basso ? '<span class="nascosto"> sotto scorta</span>' : '') + '</td>';
          }).join('') +
          (conViaggio ? '<td class="n">' + (inViaggio ? '<span class="etichetta info" title="Partito con un DDT e non ancora ricevuto">🚚 ' + App.fmtNum(inViaggio) + '</span>' : '<span class="tenue">—</span>') + '</td>' : '') +
          (rep ? '<td>' + (prossima ? App.fmtScadenza(prossima) + ' <span class="etichetta ' + stScad.classe + '">' + stScad.testo + '</span>' : '<span class="tenue">—</span>') + '</td>'
            : '<td class="n"><b>' + App.fmtNum(tot) + '</b></td>') +
          '<td class="n">' + (minima ? App.fmtNum(minima) : '<span class="tenue">—</span>') +
            (dove.length ? ' <span class="etichetta pericolo" title="Sotto la scorta minima in: ' + h(dove.map(function (r) { return r.nome; }).join(', ')) + '">sotto</span>' : '') + '</td>' +
          '<td class="n">' + App.fmtEuro(val) + '</td></tr>';
      }).join('');

      var testa = '<tr><th>Articolo</th><th>Categoria</th>' + reparti.map(function (r) { return '<th class="n">' + h(r.nome) + '</th>'; }).join('') +
        (conViaggio ? '<th class="n" title="Merce partita con un DDT e non ancora ricevuta">In viaggio</th>' : '') +
        (rep ? '<th>Prossima scadenza</th>' : '<th class="n">Totale</th>') +
        '<th class="n" title="' + (rep ? 'Scorta minima dell’assortimento di questo magazzino' : 'Scorta minima della farmacia centrale; «sotto» conta tutti i magazzini (assortimento)') + '">Scorta min.</th><th class="n">Valore</th></tr>';
      cont.querySelector('#g-tab').innerHTML = scheda('Giacenze al ' + App.fmtData(oggi) + (rep ? ' · ' + h(App.nomeReparto(rep)) : ''),
        lista.length ? '<div class="tabella-contenitore"><table class="tabella"><thead>' + testa + '</thead><tbody>' + corpo + '</tbody>' +
          '<tfoot><tr><td colspan="' + (reparti.length + 4 + (conViaggio ? 1 : 0)) + '">Valore complessivo (prezzo unitario × giacenza, esclusa la merce in viaggio)</td><td class="n">' + App.fmtEuro(valoreTot) + '</td></tr></tfoot></table></div>'
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
    App.rinfresca = disegna; // dati cambiati da altri utenti: ridisegno la tabella con gli stessi filtri
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
        return [l.scadenza ? App.fmtScadenza(l.scadenza) : '', l.articolo.nome, l.lotto, nomeMagazzino(l.reparto), l.quantita, App.statoScadenza(l.giorni).testo];
      });
      cont.querySelector('#z-tab').innerHTML = scheda('Lotti in giacenza per scadenza',
        lista.length ? '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Scadenza</th><th>Stato</th><th>Articolo</th><th>Lotto</th><th>Reparto</th><th class="n">Quantità</th><th></th></tr></thead><tbody>' +
          lista.map(function (l) {
            var st = App.statoScadenza(l.giorni);
            return '<tr><td><b>' + (l.scadenza ? App.fmtScadenza(l.scadenza) : '—') + '</b></td>' +
              '<td><span class="etichetta ' + st.classe + '">' + st.testo + (l.giorni !== null && l.giorni >= 0 ? ' · ' + l.giorni + ' gg' : '') + '</span></td>' +
              '<td><a href="#" data-scheda="' + h(l.articolo.id) + '">' + h(l.articolo.nome) + '</a></td>' +
              '<td class="mono">' + h(l.lotto || '—') + '</td><td>' + h(nomeMagazzino(l.reparto)) + '</td>' +
              '<td class="n">' + App.fmtNum(l.quantita) + '</td>' +
              '<td class="azioni">' + (l.giorni !== null && l.giorni < 0 && App.puo('perdita') && App.repartiScrivibili().some(function (r) { return r.id === l.reparto.id; }) ? '<button class="btn piccolo pericolo" type="button" data-perdita="' + h(l.articolo.id) + '|' + h(l.reparto.id) + '|' + h(l.lotto) + '|' + l.quantita + '">Togli dal magazzino</button>' : '') + '</td></tr>';
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
    App.rinfresca = disegna;
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
      var col = ['Data', 'Tipo', 'Articolo', 'Categoria', 'Quantità', 'Unità', 'Lotto', 'Scadenza', 'Reparto', 'Reparto di arrivo', 'Fornitore', 'Documento', 'DDT', 'Causale', 'Note', 'Operatore', 'Annullato']
        .map(function (t, i) { return { titolo: t, larghezza: [11, 14, 40, 10, 10, 8, 14, 10, 16, 16, 20, 14, 30, 16, 24, 14, 30][i] }; });
      var righe = filtrati.slice().reverse().map(function (m) {
        var a = App.articolo(m.articoloId) || {};
        // i movimenti dei DDT si leggono come trasferimenti dal/verso il magazzino vero, non "In transito"
        var v = vistaDdt(m);
        var reparto = v ? v.repartoId : m.repartoId;
        var arrivo = v ? v.arrivo : m.repartoDestId;
        return [App.fmtData(m.data), App.TIPI[m.tipo], a.nome || '', a.categoria || '', m.quantita, a.unita || '', m.lotto || '', m.scadenza ? App.fmtScadenza(m.scadenza) : '',
          nomeMagazzinoId(reparto), arrivo ? nomeMagazzinoId(arrivo) : '', m.fornitore || '', m.documento || '', v ? v.ddt.numero + ' · ' + v.testo : '', m.causale || '', m.note || '', m.operatore || '',
          m.annullato ? 'Sì' + (m.annullato.motivo ? ': ' + m.annullato.motivo : '') : ''];
      });
      root.ExcelFarmacia.esportaElenco('Movimenti', col, righe).then(function (b) { App.scarica(b, 'Movimenti_' + valore(cont, '#v-dal') + '_' + valore(cont, '#v-al') + '.xlsx'); });
    });
    App.rinfresca = disegna;
    disegna();
  };

  /* ======================= INVENTARIO ======================= */

  P.inventario = function (cont) {
    cont.innerHTML = barraLettore('unita') +
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
      var chiave = function (a) { return rep + '|' + data + '|' + a; };
      cont.querySelector('#i-tab').innerHTML = scheda('Conta di ' + h(App.nomeReparto(rep)) + ' al ' + App.fmtData(data),
        lista.length ? '<div class="tabella-contenitore"><table class="tabella a-schede"><thead><tr><th>Articolo</th><th>Categoria</th><th class="n">Giacenza nel programma</th><th class="n">Quantità contata</th><th class="n">Differenza</th></tr></thead><tbody>' +
          lista.map(function (a) {
            var g = C.giacenza(App.S, a.id, rep, data);
            var contato = contatiInventario[chiave(a.id)] || '';
            return '<tr><td>' + h(a.nome) + '</td><td>' + etichettaCategoria(a.categoria) + '</td><td class="n" data-etichetta="Nel programma">' + App.fmtNum(g) + (a.unita ? ' <span class="tenue">' + h(a.unita) + '</span>' : '') + '</td>' +
              '<td class="n" data-etichetta="Contata"><input class="q" inputmode="decimal" data-art="' + h(a.id) + '" data-teorica="' + g + '" placeholder="—" value="' + h(contato) + '" aria-label="Quantità contata di ' + h(a.nome) + '"></td><td class="n diff" data-etichetta="Differenza">' + differenza(contato, g) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
          : vuoto('Nessun articolo', ''),
        '<span class="nota">Scrivi solo le quantità contate: le righe vuote non cambiano. Se altri registrano movimenti mentre conti, la giacenza si aggiorna e le quantità scritte restano.</span>', true);
    }

    function differenza(testo, teorica) {
      if (String(testo).trim() === '') return '';
      var d = C.r3(App.numero(testo) - teorica);
      return d ? '<span class="etichetta ' + (d < 0 ? 'pericolo' : 'info') + '">' + (d > 0 ? '+' : '') + App.fmtNum(d) + '</span>' : '<span class="etichetta ok">uguale</span>';
    }
    // con altri utenti al lavoro la giacenza teorica si aggiorna, le quantità contate restano
    App.rinfresca = function () {
      if (!document.body.contains(cont)) return;
      var a = document.activeElement;
      var fuoco = a && cont.contains(a) && a.matches('input.q[data-art]') ? a.getAttribute('data-art') : null;
      disegna();
      if (fuoco) { var i = cont.querySelector('input.q[data-art="' + fuoco + '"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
    };
    // lettore di codici a barre: ogni lettura aumenta la quantità contata dell'articolo
    collegaLettore(cont);
    var rinfrescaInventario = App.rinfresca;
    App.gestoreScansione = function (info, a, passo) {
      if (cont.querySelector('#i-registra').disabled) { App.avviso('Sto registrando: aspetta un attimo e leggi di nuovo il codice.', 'errore'); return false; }
      mostraArticoloNeiFiltri(cont, '#i-cat', '#i-cerca', a);
      var k = valore(cont, '#i-rep') + '|' + valore(cont, '#i-data') + '|' + a.id;
      contatiInventario[k] = App.fmtCampo(C.r3(App.numero(contatiInventario[k] || '') + passo));
      rinfrescaInventario();
      var inp = cont.querySelector('input.q[data-art="' + a.id + '"]');
      if (inp) evidenziaLettura(inp.closest('tr'));
      return 'Letto: ' + a.nome + ' (+' + App.fmtNum(passo) + ') · contati: ' + App.fmtNum(App.numero(contatiInventario[k])) + (a.unita ? ' ' + a.unita : '');
    };
    cont.querySelectorAll('select, input[type=date]').forEach(function (el) { el.addEventListener('change', disegna); });
    cont.querySelector('#i-cerca').addEventListener('input', disegna);
    cont.addEventListener('input', function (e) {
      if (!e.target.classList.contains('q')) return;
      var td = e.target.closest('tr').querySelector('.diff');
      var k = valore(cont, '#i-rep') + '|' + valore(cont, '#i-data') + '|' + e.target.getAttribute('data-art');
      if (e.target.value.trim()) contatiInventario[k] = e.target.value; else delete contatiInventario[k];
      td.innerHTML = differenza(e.target.value, Number(e.target.getAttribute('data-teorica')));
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
      var bottone = this;
      var rep = valore(cont, '#i-rep'), data = valore(cont, '#i-data');
      var mov = [];
      var registrate = [];
      Object.keys(contatiInventario).forEach(function (k) {
        var p = k.split('|');
        if (p[0] !== rep || p[1] !== data || !App.articolo(p[2])) return;
        // la differenza si calcola adesso, sulla giacenza attuale; il server controlla che non sia cambiata
        var teorica = C.giacenza(App.S, p[2], rep, data);
        var d = C.r3(App.numero(contatiInventario[k]) - teorica);
        registrate.push([k, contatiInventario[k]]);
        if (d) mov.push({ tipo: 'rettifica', data: data, articoloId: p[2], repartoId: rep, quantita: d, teorica: teorica, note: 'Inventario del ' + App.fmtData(data) });
      });
      if (!mov.length) { App.avviso('Nessuna differenza da registrare.'); return; }
      App.conferma('Registra inventario', 'Registro ' + mov.length + (mov.length === 1 ? ' rettifica' : ' rettifiche') + ' in ' + h(App.nomeReparto(rep)) + ' alla data ' + App.fmtData(data) + '?', 'Registra').then(function (ok) {
        if (!ok) return;
        bottone.disabled = true;
        App.aggiungiMovimenti(mov).then(function () {
          bottone.disabled = false;
          // una quantità cambiata durante la registrazione resta da registrare
          registrate.forEach(function (x) { if (contatiInventario[x[0]] === x[1]) delete contatiInventario[x[0]]; });
          App.avviso('Inventario registrato', 'ok');
          disegna();
        }, function (e) {
          bottone.disabled = false;
          App.avviso('Inventario non registrato: ' + messaggioErrore(e), 'errore');
          // giacenza cambiata nel frattempo: aggiorno i dati, le quantità contate restano
          if (e && e.stato === 409) root.Api.sincronizza().then(disegna, disegna);
        });
      });
    });
    disegna();
  };

  /* ======================= NOTA CONSUMI MENSILE ======================= */

  var memoriaRegistro = {};

  P.registro = function (cont) {
    var oggi = App.oggi();
    // chi corregge solo i propri reparti vede solo quelli; gli altri vedono tutti i reparti (in sola lettura se non possono correggere)
    var scrivibili = App.repartiScrivibili();
    var reparti = App.puo('registro') && App.permessi.reparti && scrivibili.length ? scrivibili : App.repartiAttivi();
    var rep = repartoTra(reparti, memoriaRegistro.rep, false);
    var mese = memoriaRegistro.mese || oggi.slice(0, 7);
    var cat = memoriaRegistro.cat || 'FARMACI';
    var imp = App.S.impostazioni;

    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Reparto</span><select id="r-rep">' + opzioniReparti(rep, false, reparti) + '</select></label>' +
      '<label class="campo"><span>Mese</span><input type="month" id="r-mese" value="' + mese + '"></label>' +
      '<label class="campo"><span>Modulo</span><select id="r-cat">' + opzioniCategoria(cat) + '</select></label>' +
      '<label class="spunta"><input type="checkbox" id="r-tutti"' + (memoriaRegistro.tutti ? ' checked' : '') + '> Includi gli articoli senza movimenti</label>' +
      '<span class="spazio"></span>' +
      '<button class="btn" type="button" id="r-stampa">Stampa</button>' +
      '<button class="btn primario" type="button" id="r-excel">Esporta nel modulo Excel</button>' +
      '</div><div id="r-tab"></div>';

    var registro = null;
    var trasferimentiUscita = {};
    var inRidisegno = false; // Chrome manda un focusout quando toglie la casella col fuoco: non è un salvataggio

    function opz() {
      var m = valore(cont, '#r-mese').split('-').map(Number);
      memoriaRegistro = { rep: valore(cont, '#r-rep'), mese: valore(cont, '#r-mese'), cat: valore(cont, '#r-cat'), tutti: cont.querySelector('#r-tutti').checked };
      return { repartoId: memoriaRegistro.rep, anno: m[0], mese: m[1], categoria: memoriaRegistro.cat, includiTutti: memoriaRegistro.tutti };
    }

    function disegna(fuoco) {
      if (!valore(cont, '#r-mese')) return;
      var o = opz();
      // le caselle dei giorni si correggono solo con il permesso e nei reparti dell'utente
      var modificabile = App.puo('registro') && App.repartoPermesso(o.repartoId);
      registro = C.registroMensile(App.S, o);
      // parte delle caselle che non è un consumo: trasferimenti e DDT partiti, meno la merce rientrata (Calcoli.registroMensile)
      trasferimentiUscita = {};
      registro.righe.forEach(function (r) {
        (r.trasferiti || []).forEach(function (q, i) { if (q) trasferimentiUscita[r.articoloId + '|' + (i + 1)] = q; });
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
            var titolo = !tr ? '' : tr > 0 ? 'Comprende ' + App.fmtNum(tr) + ' trasferiti ad altri reparti (anche con i DDT), al netto della merce rientrata'
              : 'Comprende ' + App.fmtNum(-tr) + ' rientrati da DDT partiti il mese prima (annullati in viaggio o differenze alla ricezione)';
            return '<td class="g' + (festivo(i + 1) ? ' festivo' : '') + '"' + (titolo ? ' title="' + h(titolo) + '"' : '') + '>' +
              (modificabile ? '<input data-giorno="' + (i + 1) + '" value="' + App.fmtCampo(q) + '" inputmode="decimal" aria-label="Giorno ' + (i + 1) + '">' : '<span class="sola">' + fmt(q) + '</span>') + '</td>';
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
      inRidisegno = true;
      try {
        cont.querySelector('#r-tab').innerHTML = scheda(
          'Nota consumi · ' + h(o.categoria === 'FARMACI' ? 'Farmaci' : 'Presidi') + ' · ' + h(App.nomeReparto(o.repartoId)) + ' · ' + h(nomeMese),
          stampaTesta + (registro.righe.length
            ? '<div class="registro-contenitore"><table class="registro"><thead>' + testa + '</thead><tbody>' + corpo + '</tbody><tfoot>' + piede + '</tfoot></table></div>'
            : vuoto('Nessun movimento in questo mese', 'Spunta “Includi gli articoli senza movimenti” per avere il modulo con tutti gli articoli.')) + stampaPiede,
          '<span class="nota no-stampa">' + (modificabile
            ? 'I consumi si possono scrivere anche qui, giorno per giorno: il valore della casella sostituisce i consumi di quel giorno.'
            : 'Sola lettura: puoi stampare il modulo o esportarlo in Excel.') + '</span>', true);
      } finally { inRidisegno = false; }
      var nuovo = cont.querySelector('.registro-contenitore');
      if (nuovo && pos) { nuovo.scrollLeft = pos[0]; nuovo.scrollTop = pos[1]; }
      if (fuoco) {
        var inp = cont.querySelector('tr[data-art="' + fuoco.art + '"] input[data-giorno="' + fuoco.giorno + '"]');
        if (inp) {
          inp.focus();
          // se nel frattempo l'utente aveva già scritto in quella casella, il valore resta
          if (fuoco.cambiato) { inp.value = fuoco.valore; inp.setSelectionRange(inp.value.length, inp.value.length); } else inp.select();
        }
      }
    }

    // casella del registro su cui sta lavorando l'utente (per ridare il fuoco dopo il ridisegno)
    function cellaAttiva() {
      var a = document.activeElement;
      if (!a || !cont.contains(a) || !a.matches('td.g input')) return null;
      return { art: a.closest('tr').getAttribute('data-art'), giorno: Number(a.getAttribute('data-giorno')), valore: a.value, cambiato: a.value !== a.defaultValue };
    }

    function salvaCella(inp, prossimo) {
      var tr = inp.closest('tr');
      var art = tr.getAttribute('data-art');
      var giorno = Number(inp.getAttribute('data-giorno'));
      var riga = registro.righe.filter(function (r) { return r.articoloId === art; })[0];
      if (!riga) return; // casella di una tabella già ridisegnata
      var vecchio = riga.consumi[giorno - 1];
      var nuovo = App.numero(inp.value);
      // casella non toccata (per esempio solo attraversata con Tab): niente da salvare
      if (inp.value === inp.defaultValue || nuovo === vecchio) { if (prossimo) spostaFuoco(art, prossimo); return; }
      var trasf = trasferimentiUscita[art + '|' + giorno] || 0;
      if (nuovo < trasf) {
        App.avviso(trasf > 0
          ? 'In questo giorno ci sono ' + App.fmtNum(trasf) + ' trasferiti ad altri reparti: il valore non può essere più basso. Correggi il trasferimento da Movimenti (o annulla il DDT da DDT e consegne).'
          : 'In questo giorno sono rientrati ' + App.fmtNum(-trasf) + ' da DDT del mese prima: il valore non può essere più basso di ' + App.fmtNum(trasf) + '.', 'errore');
        inp.value = App.fmtCampo(vecchio);
        inp.removeAttribute('data-gestito');
        return;
      }
      var o = opz();
      var data = o.anno + '-' + String(o.mese).padStart(2, '0') + '-' + String(giorno).padStart(2, '0');
      // il fuoco passa subito alla casella dopo; il ridisegno arriva quando il server ha registrato
      if (prossimo) spostaFuoco(art, prossimo);
      // nella casella ci sono consumi + trasferimenti in uscita: al server mando solo i consumi
      var r3 = root.Calcoli.r3;
      salvataggio = App.impostaConsumoGiorno(art, o.repartoId, data, r3(nuovo - trasf), r3(vecchio - trasf)).then(function () {
        dopoSalvataggio();
      }, function (e) {
        App.avviso('Correzione non registrata: ' + messaggioErrore(e), 'errore');
        dopoSalvataggio();
      });
    }

    // ultimo salvataggio di una casella: stampa ed Excel lo aspettano
    var salvataggio = Promise.resolve();

    // ridisegno con i dati del server; se intanto il registro è stato riaperto (pulsante "Aggiorna"), ridisegno quello nuovo
    function dopoSalvataggio() {
      if (document.body.contains(cont)) disegna(cellaAttiva());
      else if (App.paginaCorrente === 'registro' && App.rinfresca) App.rinfresca();
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
      var qui = { art: inp.closest('tr').getAttribute('data-art'), giorno: Number(inp.getAttribute('data-giorno')) };
      var dove = p || qui;
      // il fuoco si sposta: il focusout che segue non deve salvare una seconda volta
      if (dove.art !== qui.art || dove.giorno !== qui.giorno) inp.setAttribute('data-gestito', '1');
      salvaCella(inp, dove);
    });
    tab.addEventListener('focusout', function (e) {
      var inp = e.target;
      if (inRidisegno || !inp.matches || !inp.matches('td.g input')) return;
      if (inp.getAttribute('data-gestito')) { inp.removeAttribute('data-gestito'); return; }
      salvaCella(inp, null);
    });
    tab.addEventListener('focusin', function (e) { if (e.target.matches('td.g input')) e.target.select(); });
    tab.addEventListener('click', function (e) {
      var s = e.target.closest('[data-scheda]');
      if (s) { e.preventDefault(); App.schedaArticolo(s.getAttribute('data-scheda')); }
    });

    cont.querySelectorAll('#r-rep, #r-mese, #r-cat, #r-tutti').forEach(function (el) { el.addEventListener('change', function () { disegna(); }); });
    // prima di stampare o esportare: salvo la casella in modifica e aspetto che il server l'abbia registrata
    function completaSalvataggi() {
      var a = document.activeElement;
      if (a && cont.contains(a) && a.matches('td.g input')) a.blur();
      return salvataggio.then(function () { if (document.body.contains(cont)) disegna(); });
    }
    cont.querySelector('#r-stampa').addEventListener('click', function () { completaSalvataggi().then(function () { window.print(); }); });
    cont.querySelector('#r-excel').addEventListener('click', function () {
      var b = this;
      b.disabled = true;
      completaSalvataggi().then(function () {
        var o = opz();
        if (!registro.righe.length) { App.avviso('Non ci sono righe da esportare.', 'errore'); b.disabled = false; return; }
        return root.ExcelFarmacia.esportaNotaConsumi(registro, {
          impostazioni: App.S.impostazioni, reparto: App.nomeReparto(o.repartoId), anno: o.anno, mese: o.mese, categoria: o.categoria
        }).then(function (blob) {
          var nome = 'Carico_Scarico_' + (o.categoria === 'FARMACI' ? 'FARMACIA' : 'PRESIDI') + '_' + App.nomeReparto(o.repartoId).replace(/[^A-Za-z0-9]+/g, '_') + '_' + o.anno + '-' + String(o.mese).padStart(2, '0') + '.xlsx';
          App.scarica(blob, nome);
          App.avviso('Modulo Excel creato: ' + nome, 'ok');
        });
      }).catch(function (e) {
        console.error(e);
        App.avviso('Esportazione non riuscita: ' + e.message, 'errore');
      }).then(function () { b.disabled = false; });
    });
    // aggiornamenti da altri utenti: si ridisegna solo se nessuna casella è in modifica (lo controlla App)
    App.rinfresca = function () { disegna(cellaAttiva()); };
    disegna();
  };

  /* ======================= ARTICOLI ======================= */

  P.articoli = function (cont) {
    var puoModificare = App.puo('articoli');
    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Cerca</span><input id="a-cerca" type="search" placeholder="Nome, principio attivo, codice…"></label>' +
      '<label class="campo"><span>Categoria</span><select id="a-cat">' + opzioniCategoria('', true) + '</select></label>' +
      '<label class="spunta"><input type="checkbox" id="a-non"> Mostra non attivi</label>' +
      '<span class="spazio"></span>' +
      (puoModificare ? '<button class="btn" type="button" id="a-importa">Importa da Excel</button>' : '') +
      '<button class="btn" type="button" id="a-excel">Esporta Excel</button>' +
      (puoModificare ? '<button class="btn primario" type="button" id="a-nuovo">+ Nuovo articolo</button>' : '') +
      '</div><div id="a-tab"></div>';

    function disegna() {
      var testo = valore(cont, '#a-cerca').trim().toLowerCase();
      var cat = valore(cont, '#a-cat');
      var non = cont.querySelector('#a-non').checked;
      var lista = App.S.articoli.filter(function (a) {
        if (cat && a.categoria !== cat) return false;
        if (!non && a.attivo === false) return false;
        return !testo || (a.nome + ' ' + (a.principio || '') + ' ' + (a.codice || '') + ' ' + descriviCodici(a.barcode).join(' ')).toLowerCase().indexOf(testo) >= 0;
      }).sort(function (x, y) { return x.nome.localeCompare(y.nome, 'it'); });
      cont.querySelector('#a-tab').innerHTML = scheda('Anagrafica articoli',
        lista.length ? '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Denominazione</th><th>Categoria</th><th>Principio attivo</th><th>Confezione</th><th>Unità</th><th class="n">Prezzo</th><th class="n">Scorta min.</th><th class="n">Giacenza totale</th><th></th></tr></thead><tbody>' +
          lista.map(function (a) {
            return '<tr class="cliccabile" data-scheda="' + h(a.id) + '"><td><b>' + h(a.nome) + '</b>' + (a.attivo === false ? ' <span class="etichetta">non attivo</span>' : '') + '</td>' +
              '<td>' + etichettaCategoria(a.categoria) + '</td><td>' + h(a.principio || '') + '</td><td>' + h(a.confezione || '') + '</td><td>' + h(a.unita || '') + '</td>' +
              '<td class="n">' + (a.prezzo ? App.fmtEuro(a.prezzo) : '') + '</td><td class="n">' + (a.scortaMinima ? App.fmtNum(a.scortaMinima) : '') + '</td>' +
              '<td class="n">' + App.fmtNum(App.giacenzaTotale(a.id)) + '</td>' +
              '<td class="azioni">' + (puoModificare ? '<button class="btn piccolo" type="button" data-modifica="' + h(a.id) + '">Modifica</button>' : '') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
          : vuoto(App.S.articoli.length ? 'Nessun articolo con questi filtri' : 'L’anagrafica è vuota', App.S.articoli.length ? '' : (puoModificare
            ? 'Aggiungi gli articoli uno per uno o importali da un file Excel (anche dai vecchi moduli “Nota consumi” compilati).'
            : 'Gli articoli li inserisce la farmacia.')),
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
    if (puoModificare) {
      cont.querySelector('#a-nuovo').addEventListener('click', function () { App.formArticolo(null); });
      cont.querySelector('#a-importa').addEventListener('click', importaDaExcel);
    }
    cont.querySelector('#a-excel').addEventListener('click', function () {
      var col = ['Denominazione', 'Categoria', 'Principio attivo', 'Confezione', 'Codice', 'Unità', 'Prezzo', 'Scorta minima', 'Giacenza totale', 'Attivo', 'Note', 'Pezzi per confezione', 'Codici a barre',
        'Fornitore abituale', 'Giorni di consegna', 'Caratteristiche']
        .map(function (t, i) { return { titolo: t, larghezza: [42, 11, 22, 20, 14, 8, 10, 13, 15, 8, 30, 12, 34, 24, 12, 30][i] }; });
      var righe = App.S.articoli.slice().sort(function (x, y) { return x.nome.localeCompare(y.nome, 'it'); }).map(function (a) {
        return [a.nome, a.categoria, a.principio || '', a.confezione || '', a.codice || '', a.unita || '', a.prezzo || 0, a.scortaMinima || 0, App.giacenzaTotale(a.id), a.attivo === false ? 'No' : 'Sì', a.note || '',
          a.pezziConfezione || 1, descriviCodici(a.barcode).join(', '),
          a.fornitore || '', a.leadTime !== null && a.leadTime !== undefined ? a.leadTime : '', descriviAttributi(a.attributi).join(', ')];
      });
      root.ExcelFarmacia.esportaElenco('Articoli', col, righe).then(function (b) { App.scarica(b, 'Articoli_' + App.oggi() + '.xlsx'); });
    });
    App.rinfresca = disegna;
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
              // gli articoli già presenti non si spuntano: per loro conta la giacenza registrata nel programma
              return '<tr><td><input type="checkbox" data-i="' + i + '"' + (esiste ? '' : ' checked') + '></td><td>' + h(t.nome) + '</td>' +
                '<td>' + (esiste ? etichettaCategoria(esiste.categoria) : '<select data-cat="' + i + '">' + opzioniCategoria(t.categoria) + '</select>') + '</td>' +
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
              var bottone = this;
              var rep = valore(m, '#imp-rep'), data = valore(m, '#imp-data'), conGiac = m.querySelector('#imp-giac').checked;
              var articoli = [];
              m.querySelectorAll('input[data-i]').forEach(function (c) {
                if (!c.checked) return;
                var i = Number(c.getAttribute('data-i'));
                var t = lista[i];
                var esiste = App.articoloPerNome(t.nome);
                articoli.push({ nome: t.nome, categoria: esiste ? esiste.categoria : valore(m, 'select[data-cat="' + i + '"]'), prezzo: t.prezzo || 0, scortaMinima: t.scortaMinima || 0, unita: t.unita || '', giacenza: t.giacenza || 0 });
              });
              if (!articoli.length) { App.avviso('Spunta almeno un articolo da importare.', 'errore'); return; }
              if (conGiac && !data) { App.avviso('Indica la data della giacenza iniziale.', 'errore'); return; }
              bottone.disabled = true;
              // il server crea gli articoli nuovi (per nome) e, se richiesto, un carico per le giacenze
              root.Api.scrivi('POST', '/api/articoli/importa', { articoli: articoli, repartoId: rep, data: data, conGiacenza: conGiac, origine: file.name }).then(function (r) {
                var conta = function (x) { return Array.isArray(x) ? x.length : Number(x) || 0; };
                var nuovi = conta(r.nuovi), carichi = conta(r.carichi), saltati = conta(r.saltati);
                App.chiudiModale();
                App.avviso('Importati ' + nuovi + (nuovi === 1 ? ' articolo nuovo' : ' articoli nuovi') + (carichi ? ' e ' + carichi + ' giacenze iniziali' : '') +
                  (saltati ? '. ' + saltati + ' articoli avevano già movimenti nel reparto: la loro giacenza non è stata cambiata (usa Inventario).' : ''), 'ok');
                App.ridisegna();
              }, function (e) {
                bottone.disabled = false;
                App.avviso('Importazione non riuscita: ' + messaggioErrore(e), 'errore');
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

  /* ======================= DATI DI PROVA (la pagina Configura è in js/pagine-configura.js) ======================= */

  // Scrittura che cambia tutto l'archivio (dati di prova, importazione, ripristino): poi ricarico tutto dal server.
  function scriviERicarica(metodo, percorso, corpo) {
    return root.Api.richiesta(metodo, percorso, corpo).then(function (r) {
      return root.Api.sincronizza({ completa: true }).then(function () { return r; });
    });
  }

  /* Dati di prova: solo con l'archivio vuoto e solo per l'amministratore (lo controlla anche il server). */
  App.caricaDemo = function () {
    if (!App.archivioVuoto()) { App.avviso('I dati di prova si caricano solo con l’archivio vuoto.', 'errore'); return; }
    App.conferma('Dati di prova', 'Carico i dati di prova? Sono inventati e servono per imparare a usare il programma: li vedranno <b>tutti gli utenti</b>.', 'Carica dati di prova').then(function (ok) {
      if (!ok) return;
      scriviERicarica('POST', '/api/demo', {}).then(function () {
        App.avviso('Dati di prova caricati: ' + App.S.articoli.length + ' articoli e ' + App.S.movimenti.length + ' movimenti', 'ok');
        App.vai('oggi');
      }, function (e) { App.avviso('Dati di prova non caricati: ' + messaggioErrore(e), 'errore'); });
    });
  };

  /* ======================= GUIDA ======================= */

  /*
   * Istruzioni scritte. La pagina Guida vera è in js/guide.js, che mostra queste sezioni (una per <h3>) sotto le
   * videoguide, come "Istruzioni scritte".
   */
  P.guida = function (cont) {
    var indirizzo = location.origin + '/';
    var locale = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    var ruoli = App.utente ? App.nomeRuolo(App.utente.ruolo) : '';
    var prodotto = (App.S && App.S.impostazioni && App.S.impostazioni.nomeProdotto) || 'il programma';
    cont.innerHTML = scheda('Come si usa ' + h(prodotto), '<div class="guida">' +
      '<p>Il programma sostituisce i fogli Excel <i>Carico_Scarico_FARMACIA</i> e <i>Carico_Scarico_PRESIDI</i>: ogni movimento si registra una volta sola e a fine mese la <b>Nota consumi</b> di ogni magazzino è già pronta, nello stesso modulo di sempre. ' +
      'La <b>farmacia centrale</b> riceve la merce dai fornitori e rifornisce i <b>magazzini di piano</b> con richieste e DDT.</p>' +
      '<h3>Il giro di ogni giorno</h3><ol>' +
      '<li><b>Carico</b> (tasto C): quando arriva la merce dal fornitore nella farmacia centrale. Indica lotto e scadenza: servono al controllo scadenze.</li>' +
      '<li><b>Richieste</b> (Q): il magazzino di piano chiede alla farmacia centrale quello che gli serve; la farmacia la prende in carico e approva le quantità.</li>' +
      '<li><b>DDT e consegne</b> (D): la farmacia prepara il DDT (documento di trasporto) con i lotti, lo spedisce indicando chi lo porta e il magazzino lo <b>riceve</b> controllando le quantità. Finché non è ricevuta la merce è “in viaggio”.</li>' +
      '<li><b>Trasferimenti</b> (T): un DDT fra due magazzini senza richiesta, per esempio un reso alla farmacia.</li>' +
      '<li><b>Consumi del giorno</b> (S): scegli magazzino e data, scrivi le quantità usate e premi <i>Registra consumi</i>. Invio passa alla riga sotto.</li>' +
      '<li><b>Perdite e scaduti</b> (P): confezioni scadute, rotte, smarrite o rese.</li></ol>' +
      '<h3>A fine mese</h3><ol>' +
      '<li>Apri <b>Nota consumi mensile</b> (R), scegli magazzino, mese e modulo (Farmaci o Presidi).</li>' +
      '<li>Controlla i numeri: le caselle dei giorni si possono correggere direttamente, come sul foglio (se il tuo utente può farlo).</li>' +
      '<li><b>Esporta nel modulo Excel</b>: crea il file con il modulo originale compilato (oltre 48 articoli aggiunge altri fogli identici). Oppure <b>Stampa</b>.</li></ol>' +
      '<h3>Come si calcolano le colonne</h3><ul>' +
      '<li><b>Residui mesi prec.</b> (2): giacenza del magazzino all’ultimo giorno del mese prima.</li>' +
      '<li><b>Carichi</b> (3): carichi dai fornitori, merce ricevuta con i DDT (alla data di ricezione) e rettifiche d’inventario in aumento.</li>' +
      '<li><b>Consumi giornalieri</b>: consumi del giorno; per la farmacia centrale comprendono anche la merce mandata agli altri magazzini (alla data di partenza del DDT).</li>' +
      '<li><b>Perdite</b> (7): perdite, scaduti e rettifiche d’inventario in diminuzione.</li>' +
      '<li><b>Controllo scadenze</b> (9): la scadenza più vicina tra i lotti rimasti a fine mese.</li>' +
      '<li><b>Residui</b> (10) = totale carico − totale scarico: è la giacenza a fine mese e diventa il residuo del mese dopo.</li></ul>' +
      '<h3>Lotti e scadenze</h3>' +
      '<p>Consumi, perdite e DDT scalano per primo il lotto che scade prima. Se serve un lotto preciso, sceglilo nella riga. La pagina <b>Scadenze</b> (Z) mostra i lotti in scadenza e quelli scaduti, con il pulsante per toglierli dal magazzino.</p>' +
      '<h3>Inventario</h3><p>Da <b>Inventario</b> (I) stampi il foglio di conta, scrivi le quantità contate e il programma registra le differenze come rettifiche.</p>' +
      '<h3>Correggere un errore</h3><p>Un movimento non si cancella: si <b>annulla</b> (da Movimenti, o dagli elenchi sotto ogni modulo) scrivendo il motivo. Resta visibile, barrato, e non conta più nei calcoli. ' +
      'Chi lavora in un magazzino di piano può annullare solo i consumi e le perdite registrati da lui. I movimenti nati da un DDT non si annullano da soli: si annulla il DDT da <b>DDT e consegne</b>.</p>' +
      '<h3>Utenti e ruoli</h3>' +
      '<p>Ognuno entra con il <b>suo nome utente e la sua password</b>: ogni movimento porta il nome di chi l’ha registrato e il <b>registro attività</b> conserva accessi e modifiche. ' +
      (ruoli ? 'Il tuo ruolo è <b>' + h(ruoli) + '</b>: nel menu vedi solo le pagine che puoi usare.' : '') + '</p><ul>' +
      '<li><b>' + h(App.RUOLI.amministratore) + '</b>: tutto, compresi utenti, struttura e magazzini, sicurezza e copie di sicurezza.</li>' +
      '<li><b>' + h(App.RUOLI.farmacista) + '</b>: carichi, richieste da evadere, DDT, consumi, perdite, inventario, articoli, assortimenti, previsioni e proposta d’ordine; può annullare qualsiasi movimento e vedere il registro attività.</li>' +
      '<li><b>' + h(App.RUOLI.reparto) + '</b>: nei magazzini che gli sono assegnati registra consumi e perdite, chiede la merce alla farmacia, riceve i DDT e mette gli articoli negli armadi; il resto lo consulta.</li>' +
      '<li><b>' + h(App.RUOLI.consultazione) + '</b>: vede tutto, stampa ed esporta in Excel, non modifica niente.</li></ul>' +
      '<p>Password e <b>verifica in due passaggi</b> (il codice dell’app sul telefono) si gestiscono dal proprio nome in alto a destra → <i>Cambia password</i> e <i>Sicurezza dell’account</i>. ' +
      'Chi dimentica la password, o sbaglia 5 volte e resta bloccato per 15 minuti, chiede all’amministratore una nuova password provvisoria, da cambiare al primo accesso. Esci sempre con <i>Esci</i> se il PC è condiviso; dopo 8 ore senza usarlo il programma chiede di nuovo la password.</p>' +
      '<h3>Come collegarsi</h3>' +
      '<p>Il programma gira sul <b>server della clinica</b>: dagli altri PC si apre con Edge o Chrome all’indirizzo del server, non serve installare niente.</p>' +
      '<p>Indirizzo di questa pagina: <b class="mono">' + h(indirizzo) + '</b>' +
      (locale ? ' — è l’indirizzo del server visto da sé stesso: dagli altri PC usa il nome o l’indirizzo IP del server con la stessa porta, per esempio <span class="mono">http://nome-del-server' + (location.port ? ':' + h(location.port) : '') + '/</span>.' : ' — salvalo tra i preferiti del browser.') + '</p>' +
      '<p>Più persone possono lavorare insieme: quello che registra uno lo vedono subito gli altri. In alto a destra “● In linea” vuol dire che il collegamento c’è; se compare “⚠ Server non raggiungibile” non registrare niente finché il collegamento non torna (il programma riprova da solo).</p>' +
      '<h3>Tasti rapidi</h3><ul>' +
      App.vociPermesse().filter(function (v) { return v.tasto; }).map(function (v) { return '<li><kbd>' + v.tasto + '</kbd> ' + h(v.voce) + '</li>'; }).join('') +
      '<li><kbd>Ctrl K</kbd> o <kbd>/</kbd> ricerca rapida di un articolo · <kbd>Esc</kbd> chiude le finestre</li></ul>' +
      '<h3>Dove stanno i dati</h3><p>Tutti i dati stanno <b>sul server</b>, in un unico archivio condiviso: nei PC non resta niente, e non importa quale browser o PC si usa. ' +
      'Il server copia magazzino e utenti <b>ogni ora</b> (se c’è stato lavoro) e verifica ogni copia; tiene le copie delle ultime 24 ore, poi una al giorno per 14 giorni, una alla settimana per 8 settimane e una al mese per un anno. ' +
      'Ogni modifica finisce anche nel <b>giornale delle modifiche</b>: se il file dell’archivio si rovina, il programma lo ricostruisce da solo dall’ultima copia buona più il giornale. ' +
      'L’amministratore vede lo stato nella pagina <b>Sistema</b> e da <b>Configura</b> può scaricare o ripristinare una copia.</p>' +
      '</div>');
  };
})(this);
