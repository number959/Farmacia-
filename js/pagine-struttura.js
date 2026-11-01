/*
 * Versione 3.0 – parte B (docs/NOVITA-3.0.md): pagine Struttura (spaccato dell'edificio con i piani, i magazzini e i DDT
 * in viaggio), Armadi (vista grafica, "dove si trova", lettore di codici a barre, modalità Disponi) e
 * Magazzini e assortimento (dati del magazzino, armadi, assortimento con scorte minima, di riordino e massima).
 * I dati arrivano da App.S (armadi, assortimento, richieste, ddt); le scritture vanno a server/struttura.js.
 */
(function (root) {
  'use strict';

  var App = root.App;
  var C = root.Calcoli;
  var h = App.h;
  var P = App.pagine;

  // Struttura e Armadi sono pagine di consultazione: si ridisegnano da sole quando altri utenti cambiano i dati
  ['struttura', 'armadi'].forEach(function (p) {
    if (App.PAGINE_CONSULTAZIONE && App.PAGINE_CONSULTAZIONE.indexOf(p) < 0) App.PAGINE_CONSULTAZIONE.push(p);
  });

  // colori proposti per magazzini e armadi ('' = colore automatico)
  var COLORI = ['#1c4184', '#4f79c4', '#0f8a8a', '#2e8b57', '#d98e04', '#c2410c', '#e10717', '#7a4fb5', '#64748b'];
  var GIORNI_CONSUMO = 90; // "Proponi dai consumi": media degli ultimi 90 giorni
  var PROPOSTA = { min: 3, riordino: 7, max: 14 }; // giorni di consumo medio

  /* ======================= componenti comuni ======================= */

  function Api() { return root.Api; }
  function V() { return root.ArmadioVista; }

  function scheda(titolo, corpo, extraTesta, stretto, classe) {
    return '<section class="scheda' + (classe ? ' ' + classe : '') + '"><div class="scheda-testa"><h2>' + titolo + '</h2>' + (extraTesta || '') + '</div>' +
      '<div class="scheda-corpo' + (stretto ? ' stretto' : '') + '">' + corpo + '</div></section>';
  }

  function vuoto(titolo, testo) {
    return '<div class="vuoto"><b>' + h(titolo) + '</b>' + (testo || '') + '</div>';
  }

  function messaggioErrore(e) { return e && e.message ? e.message : String(e); }

  // singolare con 1: "1 articolo", "3 articoli"
  function quanti(n, uno, tanti) { return n + ' ' + (Number(n) === 1 ? uno : tanti); }

  function cssId(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return root.CSS && root.CSS.escape ? root.CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  }

  function ridotto() { return !!(root.Motion && root.Motion.ridotto && root.Motion.ridotto()); }
  function animeSe() { return !ridotto() && root.anime && root.anime.animate ? root.anime : null; }

  function pianoDaLivello(l) {
    l = Number(l) || 0;
    if (l === 0) return 'Piano terra';
    if (l === -1) return 'Seminterrato';
    if (l < 0) return 'Piano ' + l;
    return l + '° piano';
  }

  function nomePiano(rep) { return rep.piano || pianoDaLivello(rep.livello); }

  function eCentrale(rep) { return !!rep && (rep.tipo === 'centrale' || rep.centrale === true); }

  function armadiDi(repId, ancheSpenti) {
    return (App.S.armadi || []).filter(function (a) { return a.repartoId === repId && (ancheSpenti || a.attivo !== false); })
      .sort(function (x, y) { return (Number(x.ordine) || 0) - (Number(y.ordine) || 0) || x.nome.localeCompare(y.nome, 'it'); });
  }

  function armadio(id) { return (App.S.armadi || []).filter(function (a) { return a.id === id; })[0] || null; }

  function assortimentoDi(repId, ancheTolti) {
    return (App.S.assortimento || []).filter(function (r) { return r.repartoId === repId && (ancheTolti || r.attivo !== false); });
  }

  function rigaAss(repId, artId) {
    return (App.S.assortimento || []).filter(function (r) { return r.repartoId === repId && r.articoloId === artId; })[0] || null;
  }

  function haSoglie(r) { return !!r && (Number(r.scortaMin) > 0 || Number(r.puntoRiordino) > 0 || Number(r.scortaMax) > 0); }

  /* ---------- giacenze, lotti e stato di un articolo in un magazzino ---------- */

  // indice dei movimenti per articolo: i lotti si calcolano sui soli movimenti di quell'articolo
  var indice = { g: null, perArticolo: {}, lotti: {} };
  function aggiornaIndice() {
    var g = App.giacenze();
    if (indice.g === g) return;
    indice = { g: g, perArticolo: {}, lotti: {} };
    App.S.movimenti.forEach(function (m) {
      (indice.perArticolo[m.articoloId] = indice.perArticolo[m.articoloId] || []).push(m);
    });
  }

  function lottiDi(artId, repId) {
    aggiornaIndice();
    var k = artId + '|' + repId;
    if (indice.lotti[k]) return indice.lotti[k];
    var oggi = App.oggi();
    var l = C.lotti({ movimenti: indice.perArticolo[artId] || [] }, artId, repId)
      .filter(function (x) { return x.quantita > 0; })
      .map(function (x) { return { lotto: x.lotto, scadenza: x.scadenza, quantita: x.quantita, giorni: C.giorniAllaScadenza(x.scadenza, oggi) }; });
    indice.lotti[k] = l;
    return l;
  }

  function giorniAvviso() { return Number(App.S.impostazioni.giorniAvvisoScadenza) || 90; }

  /*
   * Stato di un articolo in un magazzino, dalle giacenze e dalle soglie dell'assortimento:
   * esaurito > lotti scaduti > sotto la scorta minima > da riordinare > lotti in scadenza > regolare.
   * riempimento: giacenza rispetto alla scorta massima (o, senza massima, al punto di riordino × 1,5 o alla minima × 3).
   */
  function statoArticolo(artId, repId, riga) {
    if (riga === undefined) riga = rigaAss(repId, artId);
    var giac = App.giacenza(artId, repId);
    var lotti = giac > 0 ? lottiDi(artId, repId) : [];
    var avviso = giorniAvviso();
    var scaduti = 0;
    var vicini = 0;
    lotti.forEach(function (l) {
      if (l.giorni === null || l.giorni === undefined) return;
      if (l.giorni < 0) scaduti++;
      else if (l.giorni <= avviso) vicini++;
    });
    var min = riga ? Number(riga.scortaMin) || 0 : 0;
    var rio = riga ? Number(riga.puntoRiordino) || 0 : 0;
    var max = riga ? Number(riga.scortaMax) || 0 : 0;
    var sotto = min > 0 && giac < min;
    var daRiordinare = !sotto && rio > 0 && giac <= rio;
    var stato = giac <= 0 ? 'esaurito' : scaduti ? 'scaduto' : sotto ? 'sotto-minimo' : daRiordinare ? 'riordino' : vicini ? 'in-scadenza' : 'ok';
    var rif = max || (rio ? rio * 1.5 : 0) || (min ? min * 3 : 0);
    var pieno = giac <= 0 ? 0 : rif ? Math.min(1, giac / rif) : 0.6;
    return {
      giacenza: giac, stato: stato, lotti: lotti, riempimento: pieno, soglie: { min: min, riordino: rio, max: max },
      scaduti: scaduti, vicini: vicini, sotto: sotto || (giac <= 0 && haSoglie(riga)), daRiordinare: daRiordinare
    };
  }

  // per le altre pagine (cruscotto, previsioni): stesso calcolo dello stato
  root.StrutturaMagazzini = { stato: statoArticolo, armadi: armadiDi, assortimento: assortimentoDi, nomePiano: nomePiano, pianoDaLivello: pianoDaLivello };

  /* Indicatori di un magazzino per la mappa e l'elenco. */
  function indicatori(rep) {
    var righe = assortimentoDi(rep.id);
    var sotto = 0;
    var riordino = 0;
    righe.forEach(function (r) {
      if (!haSoglie(r)) return;
      var s = statoArticolo(r.articoloId, rep.id, r);
      if (s.sotto) sotto++;
      else if (s.daRiordinare) riordino++;
    });
    var avviso = giorniAvviso();
    var scadenza = 0;
    var g = App.giacenze();
    Object.keys(g).forEach(function (k) {
      var i = k.lastIndexOf('|');
      if (k.slice(i + 1) !== rep.id || !(g[k] > 0)) return;
      lottiDi(k.slice(0, i), rep.id).forEach(function (l) { if (l.giorni !== null && l.giorni !== undefined && l.giorni <= avviso) scadenza++; });
    });
    var centrale = eCentrale(rep);
    var aperte = ['inviata', 'in_lavorazione'];
    var richieste = (App.S.richieste || []).filter(function (q) {
      return (centrale ? q.fornitoreId === rep.id : q.repartoId === rep.id) && aperte.indexOf(q.stato) >= 0;
    }).length;
    var ddt = App.S.ddt || [];
    return {
      sotto: sotto, riordino: riordino, scadenza: scadenza, richieste: richieste,
      inArrivo: ddt.filter(function (d) { return d.destinazioneId === rep.id && d.stato === 'in_transito'; }).length,
      inPreparazione: ddt.filter(function (d) { return d.origineId === rep.id && d.stato === 'in_preparazione'; }).length,
      articoli: righe.length, armadi: armadiDi(rep.id).length
    };
  }

  /* ---------- magazzino predefinito ---------- */

  function magazzinoTra(lista, ricordato) {
    if (ricordato && lista.some(function (r) { return r.id === ricordato; })) return ricordato;
    // chi lavora in un magazzino periferico parte dal suo
    var miei = lista.filter(function (r) { return App.permessi && App.permessi.reparti && App.repartoPermesso(r.id); });
    if (miei.length) return miei[0].id;
    var c = lista.filter(eCentrale)[0];
    return (c || lista[0]).id;
  }

  function opzioniMagazzini(lista, scelto) {
    // in ordine di piano, dall'alto
    return lista.slice().sort(function (a, b) { return (Number(b.livello) || 0) - (Number(a.livello) || 0) || (a.ordine - b.ordine); }).map(function (r) {
      return '<option value="' + h(r.id) + '"' + (r.id === scelto ? ' selected' : '') + '>' + h(r.nome) + ' · ' + h(nomePiano(r)) + (eCentrale(r) ? ' (centrale)' : '') + '</option>';
    }).join('');
  }

  /* ======================= STRUTTURA (spaccato dell'edificio) ======================= */

  var IND = [
    { k: 'sotto', ico: '⚠', classe: 'pericolo', testo: 'sotto scorta', titolo: 'Articoli dell’assortimento sotto la scorta minima' },
    { k: 'scadenza', ico: '⏳', classe: 'attenzione', testo: 'lotti in scadenza', titolo: 'Lotti scaduti o in scadenza' },
    { k: 'richieste', ico: '📝', classe: 'info', testo: 'richieste aperte', testoCentrale: 'richieste da evadere', titolo: 'Richieste inviate o in lavorazione' },
    { k: 'inArrivo', ico: '🚚', classe: 'info', testo: 'DDT in arrivo', kCentrale: 'inPreparazione', testoCentrale: 'DDT da spedire', titolo: 'Documenti di trasporto' }
  ];

  function htmlStanza(rep, ind, opz) {
    opz = opz || {};
    var centrale = eCentrale(rep);
    ind = ind || indicatori(rep);
    var stile = rep.colore ? ' style="--st-colore:' + h(rep.colore) + '"' : '';
    var voci = IND.map(function (d) {
      var k = centrale && d.kCentrale ? d.kCentrale : d.k;
      var n = ind[k] || 0;
      var t = centrale && d.testoCentrale ? d.testoCentrale : d.testo;
      return '<span class="st-ind' + (n ? ' ' + d.classe : ' st-zero') + '" title="' + h(d.titolo) + '"><span aria-hidden="true">' + d.ico + '</span><b>' + n + '</b> ' + h(t) + '</span>';
    }).join('');
    var tag = opz.anteprima ? 'div' : 'button';
    return '<' + tag + (opz.anteprima ? ' aria-hidden="true"' : ' type="button"') + ' class="st-stanza' + (centrale ? ' st-centrale' : '') + (rep.attivo === false ? ' st-spenta' : '') + '" data-rep="' + h(rep.id) + '"' + stile + '>' +
      '<span class="st-stanza-testa"><span class="st-tipo">' + (centrale ? '✚ Farmacia centrale' : 'Magazzino di piano') + '</span><b class="st-nome">' + h(rep.nome) + '</b></span>' +
      (rep.descrizione ? '<span class="st-desc">' + h(rep.descrizione) + '</span>' : '') +
      '<span class="st-indicatori">' + voci + '</span>' +
      '<span class="st-piede"><span>🗄️ ' + quanti(ind.armadi, 'armadio', 'armadi') + ' · ' + quanti(ind.articoli, 'articolo', 'articoli') + '</span>' +
      '<span class="st-responsabili" data-resp="' + h(rep.id) + '"></span></span>' +
      (opz.anteprima ? '' : '<span class="st-vai">Armadi →</span>') +
      '</' + tag + '>';
  }

  function htmlEdificio(magazzini, ind) {
    var piani = {};
    magazzini.forEach(function (r) {
      var l = Number(r.livello) || 0;
      (piani[l] = piani[l] || []).push(r);
    });
    var livelli = Object.keys(piani).map(Number).sort(function (a, b) { return b - a; });
    var imp = App.S.impostazioni;
    return '<div class="st-edificio">' +
      '<div class="st-tetto" aria-hidden="true"><span class="st-insegna">' + h(imp.nomeProdotto || 'Pharmacy') + '</span><span class="st-insegna-sotto">' + h(imp.struttura || '') + '</span></div>' +
      '<div class="st-corpo" id="st-corpo">' +
      livelli.map(function (l) {
        var stanze = piani[l].sort(function (a, b) { return (eCentrale(b) ? 1 : 0) - (eCentrale(a) ? 1 : 0) || (a.ordine - b.ordine) || a.nome.localeCompare(b.nome, 'it'); });
        // nome del piano: quello scritto più spesso nei suoi magazzini
        var conta = {};
        stanze.forEach(function (r) { var n = nomePiano(r); conta[n] = (conta[n] || 0) + 1; });
        var nome = Object.keys(conta).sort(function (a, b) { return conta[b] - conta[a]; })[0];
        return '<div class="st-piano" data-livello="' + l + '">' +
          '<div class="st-piano-nome"><b>' + h(nome) + '</b><span>livello ' + l + '</span></div>' +
          '<div class="st-pozzo" aria-hidden="true"></div>' +
          '<div class="st-stanze">' + stanze.map(function (r) { return htmlStanza(r, ind[r.id]); }).join('') + '</div></div>';
      }).join('') +
      '<svg class="st-percorsi" id="st-percorsi" aria-hidden="true" focusable="false"></svg>' +
      '</div><div class="st-terreno" aria-hidden="true"></div></div>';
  }

  /* ---------- DDT in viaggio: punti che si muovono fra i piani ---------- */

  var animazioniStruttura = [];
  function fermaAnimazioni() {
    animazioniStruttura.forEach(function (a) { try { a.pause(); } catch (e) { /* già ferma */ } });
    animazioniStruttura = [];
  }

  var NS = 'http://www.w3.org/2000/svg';
  function svgEl(nome, attr) {
    var el = document.createElementNS(NS, nome);
    Object.keys(attr || {}).forEach(function (k) { el.setAttribute(k, attr[k]); });
    return el;
  }

  /*
   * Posizione di un elemento dentro il corpo dell'edificio, dalla disposizione della pagina (offsetLeft/offsetTop):
   * non risente delle animazioni d'ingresso, che spostano gli elementi con le trasformazioni.
   */
  function rettangolo(el, corpo) {
    var x = 0;
    var y = 0;
    var e = el;
    while (e && e !== corpo) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
    return { left: x, top: y, width: el.offsetWidth, height: el.offsetHeight, right: x + el.offsetWidth, bottom: y + el.offsetHeight };
  }

  // punto di uscita di una stanza verso il vano scala: di lato se è la prima della fila, altrimenti dal corridoio sotto
  function uscita(stanza, corpo, xPozzo) {
    var r = rettangolo(stanza, corpo);
    var piano = stanza.closest('.st-piano');
    var fila = rettangolo(piano.querySelector('.st-stanze'), corpo);
    var corridoio = rettangolo(piano, corpo).bottom - 7;
    if (r.left - fila.left < 24) return [[r.left, r.top + r.height / 2], [xPozzo, r.top + r.height / 2]];
    var xc = r.left + r.width / 2;
    return [[xc, r.bottom], [xc, corridoio], [xPozzo, corridoio]];
  }

  function disegnaPercorsi(cont) {
    fermaAnimazioni();
    var corpo = cont.querySelector('#st-corpo');
    var svg = cont.querySelector('#st-percorsi');
    if (!corpo || !svg) return;
    var larg = corpo.clientWidth;
    var alt = corpo.clientHeight;
    svg.setAttribute('viewBox', '0 0 ' + larg + ' ' + alt);
    svg.setAttribute('width', larg);
    svg.setAttribute('height', alt);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var viaggio = (App.S.ddt || []).filter(function (d) { return d.stato === 'in_transito'; });
    if (!viaggio.length) return;
    var A = animeSe();
    viaggio.forEach(function (d, i) {
      var o = corpo.querySelector('.st-stanza[data-rep="' + cssId(d.origineId) + '"]');
      var de = corpo.querySelector('.st-stanza[data-rep="' + cssId(d.destinazioneId) + '"]');
      if (!o || !de) return; // uno dei due magazzini non è sulla mappa (non attivo)
      var pozzo = rettangolo(o.closest('.st-piano').querySelector('.st-pozzo'), corpo);
      var xPozzo = pozzo.left + pozzo.width / 2 + ((i % 3) - 1) * 4;
      var a = uscita(o, corpo, xPozzo);
      var b = uscita(de, corpo, xPozzo).reverse();
      var punti = a.concat(b);
      var dpath = punti.map(function (p, k) { return (k ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
      var traccia = svgEl('path', { d: dpath, class: 'st-traccia' });
      svg.appendChild(traccia);
      var g = svgEl('g', { class: 'st-viaggiatore' });
      var titolo = svgEl('title', {});
      titolo.textContent = d.numero + ': ' + App.nomeReparto(d.origineId) + ' → ' + App.nomeReparto(d.destinazioneId) +
        (d.trasportatoreNome ? ' · porta ' + d.trasportatoreNome : '') + (d.partitoIl ? ' · partito ' + App.fmtDataOra(d.partitoIl) : '');
      g.appendChild(titolo);
      g.appendChild(svgEl('circle', { r: 11, class: 'st-alone' }));
      g.appendChild(svgEl('circle', { r: 6.5, class: 'st-punto' }));
      // un clic sul punto apre il DDT (da tastiera: il pulsante «Apri» nell'elenco «In viaggio adesso»)
      if (App.paginaPermessa('consegne')) g.addEventListener('click', function () { App.vai('consegne', { id: d.id }); });
      svg.appendChild(g);
      var lunghezza = traccia.getTotalLength();
      function metti(t) {
        var p = traccia.getPointAtLength(Math.max(0, Math.min(1, t)) * lunghezza);
        g.setAttribute('transform', 'translate(' + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ')');
      }
      if (!A) { metti(0.55); return; }
      metti(0);
      var st = { t: 0 };
      var anim = A.animate(st, {
        t: { from: 0, to: 1 },
        duration: Math.max(2600, Math.min(7000, lunghezza * 8)),
        delay: i * 650,
        loop: true,
        loopDelay: 900,
        ease: 'inOutSine',
        onUpdate: function () {
          if (!svg.isConnected) { try { anim.pause(); } catch (e) { /* già ferma */ } return; }
          metti(st.t);
        },
        onLoop: function () {
          // all'arrivo la stanza di destinazione "riceve"
          if (!de.isConnected) return;
          de.classList.remove('st-arrivo');
          void de.offsetWidth;
          de.classList.add('st-arrivo');
        }
      });
      animazioniStruttura.push(anim);
    });
  }

  /* ---------- responsabili (solo per chi gestisce gli utenti) ---------- */

  var cacheUtenti = { quando: 0, utenti: null };
  function caricaResponsabili(cont) {
    if (!App.puo('utenti')) return;
    function usa(utenti) {
      Array.prototype.forEach.call(cont.querySelectorAll('.st-responsabili[data-resp]'), function (el) {
        var id = el.getAttribute('data-resp');
        var rep = App.reparto(id);
        var nomi = utenti.filter(function (u) {
          if (u.attivo === false) return false;
          if (eCentrale(rep)) return u.ruolo === 'farmacista';
          return u.ruolo === 'reparto' && (u.reparti || []).indexOf(id) >= 0;
        }).map(function (u) { return u.nome || u.username; });
        el.textContent = nomi.length ? '👤 ' + nomi.slice(0, 3).join(', ') + (nomi.length > 3 ? ' e altri ' + (nomi.length - 3) : '') : '';
        el.title = nomi.length ? (eCentrale(rep) ? 'Farmacisti: ' : 'Responsabili: ') + nomi.join(', ') : '';
      });
    }
    if (cacheUtenti.utenti && Date.now() - cacheUtenti.quando < 60000) { usa(cacheUtenti.utenti); return; }
    Api().richiesta('GET', '/api/utenti').then(function (r) {
      cacheUtenti = { quando: Date.now(), utenti: (r && r.utenti) || [] };
      if (cont.isConnected) usa(cacheUtenti.utenti);
    }, function () { /* senza responsabili la mappa funziona lo stesso */ });
  }

  P.struttura = function (cont) {
    var osservatore = null;

    function disegna(prima) {
      var magazzini = App.repartiAttivi();
      if (osservatore) { osservatore.disconnect(); osservatore = null; }
      if (!magazzini.length) {
        cont.innerHTML = scheda('Struttura', vuoto('Nessun magazzino attivo', App.puo('struttura') ? 'Crea i magazzini dalla pagina <a href="#magazzini">Magazzini e assortimento</a>.' : 'L’amministratore crea i magazzini dalla pagina Magazzini e assortimento.'));
        return;
      }
      var ind = {};
      var tot = { sotto: 0, scadenza: 0 };
      magazzini.forEach(function (r) { ind[r.id] = indicatori(r); tot.sotto += ind[r.id].sotto; tot.scadenza += ind[r.id].scadenza; });
      var livelli = {};
      magazzini.forEach(function (r) { livelli[Number(r.livello) || 0] = true; });
      var viaggio = (App.S.ddt || []).filter(function (d) { return d.stato === 'in_transito'; });
      var vediConsegne = App.paginaPermessa('consegne');

      cont.innerHTML =
        '<div class="indicatori st-sommario">' +
        '<div class="indicatore"><span class="titolo">Magazzini attivi</span><span class="valore" data-conta="' + magazzini.length + '">' + magazzini.length + '</span></div>' +
        '<div class="indicatore"><span class="titolo">Piani</span><span class="valore" data-conta="' + Object.keys(livelli).length + '">' + Object.keys(livelli).length + '</span></div>' +
        '<div class="indicatore' + (tot.sotto ? ' pericolo' : ' ok') + '"><span class="titolo">Articoli sotto scorta</span><span class="valore" data-conta="' + tot.sotto + '">' + tot.sotto + '</span></div>' +
        '<' + (vediConsegne ? 'a href="#consegne"' : 'div') + ' class="indicatore' + (viaggio.length ? ' attenzione' : '') + '"><span class="titolo">DDT in viaggio</span><span class="valore" data-conta="' + viaggio.length + '">' + viaggio.length + '</span></' + (vediConsegne ? 'a' : 'div') + '>' +
        '</div>' +
        scheda('Spaccato dell’edificio', htmlEdificio(magazzini, ind) +
          '<div class="st-legenda" aria-hidden="true"><span><i class="st-l-centrale"></i>Farmacia centrale</span><span><i class="st-l-periferico"></i>Magazzino di piano</span>' +
          '<span><i class="st-l-ddt"></i>DDT in viaggio (passa dal vano scale)</span></div>',
        '<span class="nota">Tocca un magazzino per vedere i suoi armadi</span>' + (App.puo('struttura') ? '<a class="btn piccolo" href="#magazzini" id="st-gestisci">Gestisci magazzini</a>' : ''),
        false, 'st-scheda') +
        scheda('In viaggio adesso', viaggio.length
          ? '<ul class="elenco-semplice st-viaggio">' + viaggio.map(function (d) {
            return '<li><span aria-hidden="true">🚚</span><span class="chi"><b class="mono">' + h(d.numero) + '</b> · ' + h(App.nomeReparto(d.origineId)) + ' → ' + h(App.nomeReparto(d.destinazioneId)) +
              (d.trasportatoreNome ? ' · porta <b>' + h(d.trasportatoreNome) + '</b>' : '') + '</span>' +
              '<span class="tenue">' + (d.partitoIl ? 'partito ' + h(App.fmtDataOra(d.partitoIl)) : '') + '</span>' +
              (vediConsegne ? '<button class="btn piccolo" type="button" data-ddt="' + h(d.id) + '">Apri</button>' : '') + '</li>';
          }).join('') + '</ul>'
          : vuoto('Nessun DDT in viaggio', 'Quando un DDT parte dalla farmacia, qui e sulla mappa si vede il suo percorso fino al magazzino che lo riceve.'),
        '<span class="nota">' + quanti(viaggio.length, 'documento di trasporto', 'documenti di trasporto') + '</span>', true);

      cont.querySelectorAll('.st-stanza[data-rep]').forEach(function (b) {
        b.addEventListener('click', function () { App.vai('armadi', { repartoId: b.getAttribute('data-rep') }); });
      });
      cont.querySelectorAll('[data-ddt]').forEach(function (b) {
        b.addEventListener('click', function () { App.vai('consegne', { id: b.getAttribute('data-ddt') }); });
      });
      caricaResponsabili(cont);
      if (prima) {
        Array.prototype.forEach.call(cont.querySelectorAll('[data-conta]'), function (el) {
          if (root.Motion) root.Motion.conta(el, 0, Number(el.getAttribute('data-conta')));
        });
        if (root.Motion) {
          // l'edificio "cresce" dal piano più basso
          root.Motion.entra(Array.prototype.slice.call(cont.querySelectorAll('.st-piano')).reverse(), { ritardo: 90, distanza: 18 });
          root.Motion.entra(cont.querySelectorAll('.st-stanza'), { ritardo: 40, distanza: 8 });
        }
      }
      // i percorsi dipendono dalla posizione delle stanze: si ridisegnano quando cambia la larghezza
      var corpo = cont.querySelector('#st-corpo');
      disegnaPercorsi(cont);
      if (root.ResizeObserver && corpo) {
        var attesa = null;
        var larghezza = corpo.getBoundingClientRect().width;
        osservatore = new root.ResizeObserver(function () {
          if (!corpo.isConnected) { osservatore.disconnect(); return; }
          var w = corpo.getBoundingClientRect().width;
          if (Math.abs(w - larghezza) < 2) return;
          larghezza = w;
          clearTimeout(attesa);
          attesa = setTimeout(function () { if (corpo.isConnected) disegnaPercorsi(cont); }, 150);
        });
        osservatore.observe(corpo);
      }
    }

    App.rinfresca = function () { disegna(false); };
    disegna(true);
  };

  /* ======================= ARMADI (vista grafica) ======================= */

  var memArmadi = { rep: null, arm: null, disponi: false, filtro: '' };

  function puoDisporre(repId) { return App.puo('ubicazioni') && App.repartoPermesso(repId); }

  function caselleDi(repId, arm) {
    return assortimentoDi(repId).filter(function (r) { return r.armadioId === arm.id && r.ripiano && r.posizione; }).map(function (r) {
      var a = App.articolo(r.articoloId);
      if (!a) return null;
      var s = statoArticolo(a.id, repId, r);
      return {
        articolo: a, giacenza: s.giacenza, stato: s.stato, lotti: s.lotti, riempimento: s.riempimento, soglie: s.soglie,
        ripiano: r.ripiano, posizione: r.posizione
      };
    }).filter(Boolean);
  }

  function testoPosto(r) {
    var a = r && r.armadioId ? armadio(r.armadioId) : null;
    return a ? a.nome + ' · ripiano ' + r.ripiano + ', posto ' + r.posizione : 'senza posto negli armadi';
  }

  // posto in breve per le tabelle: "Armadio farmaci · 2/5" (ripiano/posto), con il testo intero nel titolo
  function htmlPostoBreve(r) {
    var a = r && r.armadioId ? armadio(r.armadioId) : null;
    if (!a) return '<span class="tenue">—</span>';
    return '<span title="' + h(testoPosto(r)) + '">' + h(a.nome) + ' · <span class="mono">' + r.ripiano + '/' + r.posizione + '</span></span>';
  }

  // barra della giacenza rispetto a scorta minima, punto di riordino e scorta massima
  function htmlMisura(s, unita) {
    var so = s.soglie;
    var scala = Math.max(so.max || 0, s.giacenza, (so.riordino || 0) * 1.5, (so.min || 0) * 2, 1);
    function pc(v) { return Math.max(0, Math.min(100, v / scala * 100)).toFixed(1) + '%'; }
    var segni = [];
    if (so.min) segni.push('<i class="ar-segno-min" style="left:' + pc(so.min) + '" title="Scorta minima ' + h(App.fmtNum(so.min)) + '"></i>');
    if (so.riordino) segni.push('<i class="ar-segno-rio" style="left:' + pc(so.riordino) + '" title="Punto di riordino ' + h(App.fmtNum(so.riordino)) + '"></i>');
    if (so.max) segni.push('<i class="ar-segno-max" style="left:' + pc(so.max) + '" title="Scorta massima ' + h(App.fmtNum(so.max)) + '"></i>');
    return '<div class="ar-misura av-s-' + h(s.stato) + '" role="img" aria-label="Giacenza ' + h(App.fmtNum(s.giacenza)) + ' ' + h(unita || '') +
      (so.min ? ', scorta minima ' + h(App.fmtNum(so.min)) : '') + (so.riordino ? ', riordino ' + h(App.fmtNum(so.riordino)) : '') + (so.max ? ', massima ' + h(App.fmtNum(so.max)) : '') + '">' +
      '<span class="ar-misura-pieno" style="width:' + pc(s.giacenza) + '"></span>' + segni.join('') + '</div>' +
      '<div class="ar-misura-leggenda piccolo tenue">' +
      (so.min ? '<span><i class="ar-segno-min"></i>min ' + h(App.fmtNum(so.min)) + '</span>' : '') +
      (so.riordino ? '<span><i class="ar-segno-rio"></i>riordino ' + h(App.fmtNum(so.riordino)) + '</span>' : '') +
      (so.max ? '<span><i class="ar-segno-max"></i>max ' + h(App.fmtNum(so.max)) + '</span>' : '') +
      (!so.min && !so.riordino && !so.max ? '<span>Scorte non indicate nell’assortimento</span>' : '') + '</div>';
  }

  P.armadi = function (cont, par) {
    par = par || {};
    V().annullaPresa(); // un articolo "preso" da tastiera in una visita precedente non resta in mano
    var magazzini = App.repartiAttivi();
    if (!magazzini.length) {
      cont.innerHTML = scheda('Armadi', vuoto('Nessun magazzino attivo', ''));
      return;
    }
    var richiesto = par.repartoId && magazzini.some(function (r) { return r.id === par.repartoId; }) ? par.repartoId : null;
    var st = {
      rep: magazzinoTra(magazzini, richiesto || memArmadi.rep),
      arm: null,
      sel: par.articoloId || null,
      disponi: false,
      filtroStato: '',
      vista: null
    };
    if (par.armadioId) st.arm = par.armadioId;
    else if (memArmadi.rep === st.rep) st.arm = memArmadi.arm;
    st.disponi = puoDisporre(st.rep) && !!(par.disponi || (memArmadi.disponi && memArmadi.rep === st.rep));
    var occupato = false;

    function ricorda() { memArmadi.rep = st.rep; memArmadi.arm = st.arm; memArmadi.disponi = st.disponi; }

    function armadiVisibili() { return armadiDi(st.rep); }

    function armadioCorrente() {
      var lista = armadiVisibili();
      var a = lista.filter(function (x) { return x.id === st.arm; })[0] || lista[0] || null;
      st.arm = a ? a.id : null;
      return a;
    }

    // l'articolo scelto (dalla scheda o dalla ricerca) sta in un armadio di questo magazzino: apro quello
    if (st.sel) {
      var rs = rigaAss(st.rep, st.sel);
      if (rs && rs.armadioId && armadio(rs.armadioId) && armadio(rs.armadioId).attivo !== false) st.arm = rs.armadioId;
    }

    cont.innerHTML =
      '<div class="strumenti ar-strumenti">' +
      '<label class="campo"><span>Magazzino</span><select id="ar-magazzino">' + opzioniMagazzini(magazzini, st.rep) + '</select></label>' +
      '<label class="campo ar-cerca"><span>Dove si trova?</span><input id="ar-cerca" type="search" list="ar-dl" autocomplete="off" placeholder="Nome del farmaco, o leggi il codice a barre"></label>' +
      '<datalist id="ar-dl"></datalist>' +
      '<span class="spazio"></span>' +
      '<button class="btn" type="button" id="ar-disponi" aria-pressed="false" hidden>✋ Disponi</button>' +
      '</div>' +
      '<div class="ar-armadi" id="ar-armadi" role="group" aria-label="Armadi del magazzino"></div>' +
      '<div class="ar-corpo">' +
      '<section class="scheda ar-scheda-vista"><div class="scheda-testa"><h2 id="ar-titolo">Armadio</h2><span class="nota" id="ar-nota"></span>' +
      '<span class="ar-strumenti-disponi" id="ar-strumenti-disponi" hidden>' +
      '<button class="btn piccolo" type="button" id="ar-auto">✨ Disposizione automatica</button>' +
      '<button class="btn piccolo pericolo" type="button" id="ar-svuota">Svuota</button></span></div>' +
      '<div class="scheda-corpo"><div id="ar-vista" class="ar-vista"></div><div class="ar-legenda" id="ar-legenda"></div></div></section>' +
      '<aside class="ar-lato" id="ar-lato"></aside>' +
      '</div>';

    var selMag = cont.querySelector('#ar-magazzino');
    var cerca = cont.querySelector('#ar-cerca');
    var bDisponi = cont.querySelector('#ar-disponi');

    function aggiornaDatalist() {
      var visti = {};
      var opzioni = assortimentoDi(st.rep).map(function (r) { visti[r.articoloId] = true; return App.articolo(r.articoloId); }).filter(Boolean);
      // anche gli articoli con giacenza nel magazzino ma fuori dall'assortimento
      var g = App.giacenze();
      App.S.articoli.forEach(function (a) { if (!visti[a.id] && g[a.id + '|' + st.rep] > 0) opzioni.push(a); });
      opzioni.sort(function (x, y) { return x.nome.localeCompare(y.nome, 'it'); });
      cont.querySelector('#ar-dl').innerHTML = opzioni.map(function (a) { return '<option value="' + h(a.nome) + '">'; }).join('');
    }

    function disegnaArmadi() {
      var lista = armadiVisibili();
      var box = cont.querySelector('#ar-armadi');
      if (!lista.length) { box.innerHTML = ''; return; }
      box.innerHTML = lista.map(function (a) {
        var caselle = caselleDi(st.rep, a);
        var conta = { ok: 0, att: 0, per: 0 };
        caselle.forEach(function (c) {
          if (c.stato === 'ok') conta.ok++;
          else if (c.stato === 'riordino' || c.stato === 'in-scadenza') conta.att++;
          else conta.per++;
        });
        var t = V().TIPI[a.tipo] || V().TIPI.armadio;
        var problemi = conta.per ? conta.per + ' da controllare' : conta.att ? conta.att + ' da riordinare o in scadenza' : caselle.length ? 'tutto in ordine' : 'vuoto';
        return '<button type="button" class="ar-chip ar-chip-' + h(a.tipo) + (a.id === st.arm ? ' scelto' : '') + '" data-arm="' + h(a.id) + '" aria-pressed="' + (a.id === st.arm) + '"' +
          (a.colore ? ' style="--ar-tinta:' + h(a.colore) + '"' : '') + '>' +
          '<span class="ar-chip-ico" aria-hidden="true">' + t.ico + '</span>' +
          '<span class="ar-chip-testo"><b>' + h(a.nome) + '</b><small>' + quanti(caselle.length, 'articolo', 'articoli') + ' · ' + h(problemi) + '</small></span>' +
          '<span class="ar-chip-barra" aria-hidden="true">' +
          (conta.ok ? '<i class="ok" style="flex:' + conta.ok + '"></i>' : '') + (conta.att ? '<i class="att" style="flex:' + conta.att + '"></i>' : '') +
          (conta.per ? '<i class="per" style="flex:' + conta.per + '"></i>' : '') + (caselle.length ? '' : '<i class="vuota" style="flex:1"></i>') + '</span>' +
          '</button>';
      }).join('');
    }

    function disegnaLegenda(caselle) {
      var conta = {};
      caselle.forEach(function (c) { conta[c.stato] = (conta[c.stato] || 0) + 1; });
      var S = V().STATI;
      cont.querySelector('#ar-legenda').innerHTML = Object.keys(S).map(function (k) {
        var n = conta[k] || 0;
        return '<button type="button" class="ar-leg av-s-' + k + (st.filtroStato === k ? ' scelto' : '') + '" data-stato="' + k + '" aria-pressed="' + (st.filtroStato === k) + '"' + (n ? '' : ' disabled') + '>' +
          '<i aria-hidden="true">' + (V().SEGNI[k] || '') + '</i>' + h(S[k]) + ' <b>' + n + '</b></button>';
      }).join('') + '<span class="ar-leg-nota piccolo tenue">Altezza della scatola: giacenza rispetto alla scorta massima.</span>';
    }

    function disegnaVista(ingresso) {
      var a = armadioCorrente();
      var box = cont.querySelector('#ar-vista');
      var titolo = cont.querySelector('#ar-titolo');
      var nota = cont.querySelector('#ar-nota');
      cont.querySelector('#ar-strumenti-disponi').hidden = !(st.disponi && a);
      if (!a) {
        st.vista = null;
        box._avVista = null;
        titolo.textContent = 'Nessun armadio';
        nota.textContent = '';
        box.innerHTML = vuoto('In questo magazzino non ci sono ancora armadi',
          App.puo('struttura') ? '<p><button class="btn primario" type="button" id="ar-crea">Crea il primo armadio</button></p>' : 'L’amministratore li crea dalla pagina Magazzini e assortimento.');
        var crea = box.querySelector('#ar-crea');
        if (crea) crea.addEventListener('click', function () { App.vai('magazzini', { repartoId: st.rep, scheda: 'armadi' }); });
        cont.querySelector('#ar-legenda').innerHTML = '';
        return;
      }
      var t = V().TIPI[a.tipo] || V().TIPI.armadio;
      titolo.textContent = t.ico + ' ' + a.nome;
      nota.textContent = t.nome + ' · ' + quanti(a.ripiani, 'ripiano', 'ripiani') + ' × ' + quanti(a.colonne, 'posto', 'posti') + (a.note ? ' · ' + a.note : '');
      var caselle = caselleDi(st.rep, a);
      st.vista = V().disegna(box, {
        armadio: a,
        caselle: caselle,
        modifica: st.disponi,
        selezionato: st.sel,
        ingresso: !!ingresso,
        suCasella: function (c) { st.sel = c.articolo.id; V().seleziona(st.vista, c.articolo.id); disegnaLato(); },
        suVuota: function () { if (!st.disponi && st.sel) { st.sel = null; V().seleziona(st.vista, null); disegnaLato(); } },
        suSposta: sposta,
        suTogli: function (artId) { togli(artId); }
      });
      if (st.filtroStato) st.vista.el.setAttribute('data-filtro', st.filtroStato);
      disegnaLegenda(caselle);
    }

    /* ---------- pannello laterale ---------- */

    function htmlDettaglio(a) {
      var riga = rigaAss(st.rep, a.id);
      var s = statoArticolo(a.id, st.rep, riga);
      var lotti = s.lotti;
      var link = [];
      link.push('<button class="btn piccolo" type="button" data-azione="scheda">🏷️ Scheda articolo</button>');
      if (App.paginaPermessa('consumi') && App.repartoPermesso(st.rep)) link.push('<button class="btn piccolo" type="button" data-azione="consumi">💊 Consumi</button>');
      if (App.paginaPermessa('perdite') && App.repartoPermesso(st.rep)) link.push('<button class="btn piccolo" type="button" data-azione="perdite">🗑️ Perdite</button>');
      if (App.paginaPermessa('richieste') && App.puo('richieste') && App.repartoPermesso(st.rep) && !eCentrale(App.reparto(st.rep))) {
        link.push('<button class="btn piccolo" type="button" data-azione="richiesta">📝 Nuova richiesta</button>');
      }
      return scheda(h(a.nome),
        '<div class="ar-dett">' +
        '<p class="ar-dett-stato"><span class="etichetta av-s-' + h(s.stato) + '">' + h((V().SEGNI[s.stato] || '●') + ' ' + V().STATI[s.stato]) + '</span>' +
        (riga ? '' : ' <span class="etichetta">fuori assortimento</span>') + '</p>' +
        '<p class="ar-dett-giac"><b>' + h(App.fmtNum(s.giacenza)) + '</b> ' + h(a.unita || '') + ' <span class="tenue">in ' + h(App.nomeReparto(st.rep)) + '</span></p>' +
        htmlMisura(s, a.unita) +
        '<dl class="ar-dl"><dt>Posto</dt><dd>' + h(testoPosto(riga)) + '</dd>' +
        '<dt>Categoria</dt><dd>' + (a.categoria === 'PRESIDI' ? 'Presidio' : 'Farmaco') + (a.principio ? ' · ' + h(a.principio) : '') + '</dd>' +
        ((a.attributi || []).length ? '<dt>Attenzione</dt><dd>' + (a.attributi || []).map(function (x) { return '<span class="etichetta info">' + h(x) + '</span>'; }).join(' ') + '</dd>' : '') +
        '</dl>' +
        '<h3 class="ar-sotto">Lotti e scadenze</h3>' +
        (lotti.length ? '<div class="tabella-contenitore"><table class="tabella ar-lotti"><thead><tr><th>Lotto</th><th>Scadenza</th><th class="n">Quantità</th></tr></thead><tbody>' +
          lotti.map(function (l) {
            var sc = App.statoScadenza(l.giorni);
            return '<tr><td class="mono">' + h(l.lotto || 'senza lotto') + '</td><td><span class="etichetta ' + sc.classe + '">' + h(App.fmtScadenza(l.scadenza)) + '</span></td><td class="n">' + h(App.fmtNum(l.quantita)) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
          : '<p class="piccolo tenue">Nessun lotto in giacenza.</p>') +
        '<div class="ar-azioni">' + link.join('') + '</div>' +
        '</div>', '<button class="btn fantasma piccolo" type="button" data-azione="chiudi" aria-label="Chiudi il dettaglio">✕</button>', false, 'ar-dettaglio');
    }

    function htmlRiepilogo() {
      var a = armadioCorrente();
      var tutti = assortimentoDi(st.rep);
      var senza = tutti.filter(function (r) { return !r.armadioId; });
      var problemi = tutti.map(function (r) {
        var s = statoArticolo(r.articoloId, st.rep, r);
        return { r: r, s: s };
      }).filter(function (x) { return x.s.stato !== 'ok' && haSoglie(x.r); })
        .sort(function (x, y) { return ['esaurito', 'scaduto', 'sotto-minimo', 'riordino', 'in-scadenza'].indexOf(x.s.stato) - ['esaurito', 'scaduto', 'sotto-minimo', 'riordino', 'in-scadenza'].indexOf(y.s.stato); });
      return scheda('Da tenere d’occhio',
        (problemi.length ? '<ul class="elenco-semplice ar-problemi">' + problemi.slice(0, 12).map(function (x) {
          var art = App.articolo(x.r.articoloId);
          return '<li><span class="ar-pallino av-s-' + h(x.s.stato) + '" aria-hidden="true">' + (V().SEGNI[x.s.stato] || '') + '</span>' +
            '<button type="button" class="ar-link chi" data-trova="' + h(x.r.articoloId) + '">' + h(art ? art.nome : '') + '</button>' +
            '<span class="tenue">' + h(V().STATI[x.s.stato]) + ' · ' + h(App.fmtNum(x.s.giacenza)) + '</span></li>';
        }).join('') + '</ul>' + (problemi.length > 12 ? '<p class="piccolo tenue ar-pad">e altri ' + (problemi.length - 12) + '</p>' : '')
          : vuoto('Tutto in ordine', 'Nessun articolo dell’assortimento è sotto scorta, da riordinare o in scadenza.')) +
        (senza.length ? '<p class="piccolo ar-pad">📦 <b>' + senza.length + '</b> ' + (senza.length === 1 ? 'articolo dell’assortimento non ha ancora un posto negli armadi' : 'articoli dell’assortimento non hanno ancora un posto negli armadi') +
          (puoDisporre(st.rep) && a ? ': usa <b>Disponi</b> per ' + (senza.length === 1 ? 'sistemarlo.' : 'sistemarli.') : '.') + '</p>' : ''),
        '<span class="nota">' + h(App.nomeReparto(st.rep)) + '</span>', true, 'ar-riepilogo');
    }

    function voceDisponi(r, classe) {
      var a = App.articolo(r.articoloId);
      if (!a) return '';
      var s = statoArticolo(a.id, st.rep, r);
      return '<li class="ar-voce av-s-' + h(s.stato) + (classe ? ' ' + classe : '') + '" data-art="' + h(a.id) + '">' +
        '<span class="ar-maniglia" aria-hidden="true" title="Trascina">⠿</span>' +
        '<span class="ar-voce-nome"><b>' + h(a.nome) + '</b><small>' + h(r.armadioId ? testoPosto(r) : (V().SEGNI[s.stato] || '') + ' ' + V().STATI[s.stato] + ' · ' + App.fmtNum(s.giacenza)) + '</small></span>' +
        '<button class="btn piccolo" type="button" data-prendi="' + h(a.id) + '" aria-label="' + (r.armadioId ? 'Sposta ' : 'Metti ') + h(a.nome) + ' nell’armadio">' +
        (r.armadioId ? 'Sposta' : 'Metti') + '</button></li>';
    }

    function aggiornaVoci() {
      var box = cont.querySelector('#ar-voci');
      if (!box) return;
      var a = armadioCorrente();
      var t = String(memArmadi.filtro || '').trim().toLowerCase();
      var righe = assortimentoDi(st.rep).filter(function (r) {
        var art = App.articolo(r.articoloId);
        return art && (!t || art.nome.toLowerCase().indexOf(t) >= 0);
      }).sort(function (x, y) {
        var ax = App.articolo(x.articoloId);
        var ay = App.articolo(y.articoloId);
        return (ax.categoria === ay.categoria ? 0 : ax.categoria === 'FARMACI' ? -1 : 1) || ax.nome.localeCompare(ay.nome, 'it');
      });
      var senza = righe.filter(function (r) { return !r.armadioId; });
      var qui = righe.filter(function (r) { return a && r.armadioId === a.id; });
      var altrove = righe.filter(function (r) { return r.armadioId && (!a || r.armadioId !== a.id); });
      function gruppo(titolo, lista, classe) {
        return '<h3 class="ar-gruppo">' + h(titolo) + ' <span class="etichetta">' + lista.length + '</span></h3>' +
          (lista.length ? '<ul class="ar-voci">' + lista.map(function (r) { return voceDisponi(r, classe); }).join('') + '</ul>' : '<p class="piccolo tenue ar-pad">Nessuno.</p>');
      }
      box.innerHTML = gruppo('Da sistemare', senza, '') + gruppo('In questo armadio', qui, 'ar-qui') + (altrove.length ? gruppo('In altri armadi', altrove, 'ar-altrove') : '');
    }

    function disegnaLato() {
      var lato = cont.querySelector('#ar-lato');
      if (st.disponi && armadioCorrente()) {
        if (!lato.querySelector('#ar-voci')) {
          var tutti = App.articoliAttivi();
          lato.innerHTML = '<section class="scheda ar-disponi" data-av-togli>' +
            '<div class="scheda-testa"><h2>Assortimento da disporre</h2><span class="nota">' + h(App.nomeReparto(st.rep)) + '</span></div>' +
            '<div class="scheda-corpo">' +
            '<p class="piccolo tenue">Trascina un articolo in una casella dell’armadio (con il mouse o con il dito sulla maniglia ⠿). Trascinalo qui per toglierlo dall’armadio. ' +
            'Da tastiera: <b>Metti</b>, poi frecce e Invio.</p>' +
            '<div class="strumenti"><label class="campo ar-filtro"><span>Cerca nell’elenco</span><input id="ar-filtro" type="search" autocomplete="off" value="' + h(memArmadi.filtro || '') + '"></label></div>' +
            '<div id="ar-voci" class="ar-voci-box"></div>' +
            '<div class="strumenti ar-altro"><label class="campo"><span>Un articolo che non è nell’assortimento</span>' +
            '<input id="ar-altro-art" list="ar-dl-tutti" autocomplete="off" placeholder="Nome dell’articolo"></label>' +
            '<datalist id="ar-dl-tutti">' + tutti.map(function (x) { return '<option value="' + h(x.nome) + '">'; }).join('') + '</datalist>' +
            '<button class="btn" type="button" id="ar-altro-prendi">Metti nell’armadio</button></div>' +
            '</div></section>';
          var filtro = lato.querySelector('#ar-filtro');
          filtro.addEventListener('input', function () { memArmadi.filtro = filtro.value; aggiornaVoci(); });
          lato.querySelector('#ar-altro-prendi').addEventListener('click', function () {
            var a = App.articoloPerNome(lato.querySelector('#ar-altro-art').value);
            if (!a) { App.avviso('Scegli un articolo dall’elenco.', 'errore'); return; }
            prendi(a);
          });
          st.latoArt = undefined;
        }
        aggiornaVoci();
        return;
      }
      var art = st.sel ? App.articolo(st.sel) : null;
      lato.innerHTML = art ? htmlDettaglio(art) : htmlRiepilogo();
      // il pannello "entra" solo quando cambia l'articolo mostrato
      if (root.Motion && st.latoArt !== st.sel) root.Motion.entra(lato.querySelector('.scheda'), { distanza: 8 });
      st.latoArt = st.sel;
    }

    /* ---------- disposizione ---------- */

    function prendi(a) {
      var r = rigaAss(st.rep, a.id);
      // se l'articolo ha già un posto lo "prendo" da lì: posandolo su una casella occupata i due si scambiano
      var da = r && r.armadioId ? { armadioId: r.armadioId, ripiano: r.ripiano, posizione: r.posizione } : null;
      if (!V().prendi(a.id, a.nome, cont, da)) App.avviso('Prima scegli un armadio.', 'errore');
    }

    function salvaPosti(righe, messaggio) {
      if (occupato) { App.avviso('Sto salvando lo spostamento di prima: un attimo.', 'errore'); return Promise.resolve(false); }
      occupato = true;
      return Api().scrivi('PUT', '/api/ubicazioni', { repartoId: st.rep, righe: righe }).then(function () {
        occupato = false;
        if (!cont.isConnected) return true;
        disegnaArmadi();
        disegnaVista(false);
        aggiornaVoci();
        if (messaggio) App.avviso(messaggio, 'ok');
        return true;
      }, function (e) {
        occupato = false;
        App.avviso('Posto non salvato: ' + messaggioErrore(e), 'errore');
        if (cont.isConnected) disegnaVista(false);
        return false;
      });
    }

    function sposta(m) {
      var a = App.articolo(m.articoloId);
      var righe = [{ articoloId: m.articoloId, armadioId: m.armadioId, ripiano: m.ripiano, posizione: m.posizione }];
      var testo = (a ? a.nome : '') + ' → ripiano ' + m.ripiano + ', posto ' + m.posizione;
      if (m.occupante) {
        var o = App.articolo(m.occupante);
        // scambio: chi occupava la casella va dove era l'articolo spostato (o torna "da sistemare")
        righe.push(m.da ? { articoloId: m.occupante, armadioId: m.da.armadioId, ripiano: m.da.ripiano, posizione: m.da.posizione } : { articoloId: m.occupante, armadioId: null });
        testo += m.da ? ' (scambiato con ' + (o ? o.nome : '') + ')' : ' · ' + (o ? o.nome : '') + ' torna da sistemare';
      }
      salvaPosti(righe, testo).then(function (ok) {
        if (ok && st.vista && m.articoloId) {
          st.sel = m.articoloId;
          V().seleziona(st.vista, m.articoloId);
        }
      });
    }

    function togli(artId) {
      var a = App.articolo(artId);
      salvaPosti([{ articoloId: artId, armadioId: null }], (a ? a.nome : 'Articolo') + ' tolto dall’armadio: è fra quelli da sistemare');
    }

    // le confezioni da frigorifero vanno nel frigorifero, gli stupefacenti nella cassaforte (se il magazzino li ha)
    function adattoA(a, art, conFrigo, conCassaforte) {
      var attr = art.attributi || [];
      if (a.tipo === 'frigorifero') return attr.indexOf('frigo') >= 0;
      if (a.tipo === 'cassaforte') return attr.indexOf('stupefacente') >= 0;
      if (conFrigo && attr.indexOf('frigo') >= 0) return false;
      if (conCassaforte && attr.indexOf('stupefacente') >= 0) return false;
      return true;
    }

    function disposizioneAutomatica() {
      var a = armadioCorrente();
      if (!a) return;
      var armadi = armadiVisibili();
      var conFrigo = armadi.some(function (x) { return x.tipo === 'frigorifero'; });
      var conCassaforte = armadi.some(function (x) { return x.tipo === 'cassaforte'; });
      var candidati = assortimentoDi(st.rep).filter(function (r) {
        var art = App.articolo(r.articoloId);
        if (!art) return false;
        if (r.armadioId === a.id) return true; // quelli già qui si riordinano
        return !r.armadioId && adattoA(a, art, conFrigo, conCassaforte);
      }).map(function (r) { return App.articolo(r.articoloId); });
      if (!candidati.length) { App.avviso('Non ci sono articoli da sistemare in questo armadio.', 'errore'); return; }
      candidati.sort(function (x, y) {
        return (x.categoria === y.categoria ? 0 : x.categoria === 'FARMACI' ? -1 : 1) || x.nome.localeCompare(y.nome, 'it');
      });
      var posti = a.ripiani * a.colonne;
      var fuori = Math.max(0, candidati.length - posti);
      App.conferma('Disposizione automatica',
        'Sistemo <b>' + Math.min(posti, candidati.length) + '</b> ' + (Math.min(posti, candidati.length) === 1 ? 'articolo' : 'articoli') + ' in «' + h(a.nome) + '» in ordine di categoria (prima i farmaci) e di nome, ripiano dopo ripiano.' +
        (fuori ? '<br><b>' + fuori + '</b> ' + (fuori === 1 ? 'articolo non ci sta e resta da sistemare.' : 'articoli non ci stanno e restano da sistemare.') : '') +
        '<br>Gli articoli già negli altri armadi restano dove sono.', 'Disponi').then(function (ok) {
        if (!ok) return;
        var righe = candidati.map(function (art, i) {
          if (i >= posti) return { articoloId: art.id, armadioId: null };
          return { articoloId: art.id, armadioId: a.id, ripiano: Math.floor(i / a.colonne) + 1, posizione: (i % a.colonne) + 1 };
        });
        // prima libero le caselle (una casella = un articolo), poi metto tutti al loro posto nuovo: una sola richiesta
        var disposti = Math.min(posti, candidati.length);
        salvaPosti(righe, (disposti === 1 ? 'Disposto ' : 'Disposti ') + quanti(disposti, 'articolo', 'articoli') + ' in ' + a.nome + (fuori ? '; ' + fuori + (fuori === 1 ? ' resta da sistemare' : ' restano da sistemare') : ''));
      });
    }

    function svuota() {
      var a = armadioCorrente();
      if (!a) return;
      var dentro = assortimentoDi(st.rep).filter(function (r) { return r.armadioId === a.id; });
      if (!dentro.length) { App.avviso('L’armadio è già vuoto.', 'errore'); return; }
      App.conferma('Svuota l’armadio', (dentro.length === 1 ? 'Tolgo l’unico articolo da «' + h(a.nome) + '»? Resta' : 'Tolgo i <b>' + dentro.length + '</b> articoli da «' + h(a.nome) + '»? Restano') + ' nell’assortimento del magazzino, fra quelli da sistemare. Le giacenze non cambiano.', 'Svuota', true).then(function (ok) {
        if (!ok) return;
        salvaPosti(dentro.map(function (r) { return { articoloId: r.articoloId, armadioId: null }; }), a.nome + ' svuotato');
      });
    }

    /* ---------- dove si trova (ricerca e lettore di codici a barre) ---------- */

    function trova(artId, appenaAperto) {
      var a = App.articolo(artId);
      if (!a) return { errore: 'Articolo non trovato.' };
      var riga = rigaAss(st.rep, artId);
      var arm = riga && riga.armadioId && riga.attivo !== false ? armadio(riga.armadioId) : null;
      if (arm && arm.attivo !== false) {
        var cambia = st.arm !== arm.id;
        st.sel = artId;
        if (cambia) { st.arm = arm.id; ricorda(); disegnaArmadi(); disegnaVista(true); }
        else V().seleziona(st.vista, artId);
        disegnaLato();
        // con le ante che si aprono, l'impulso arriva quando la scatola è al suo posto
        setTimeout(function () { if (st.vista) V().evidenzia(st.vista, artId); }, (cambia || appenaAperto) && !ridotto() ? 1000 : 30);
        return { ok: 'Trovato: ' + a.nome + ' · ' + arm.nome + ', ripiano ' + riga.ripiano + ', posto ' + riga.posizione };
      }
      if (st.disponi && armadioCorrente()) {
        prendi(a);
        return { ok: a.nome + ': tocca la casella dove metterlo (oppure frecce e Invio).' };
      }
      st.sel = artId;
      disegnaLato();
      var altrove = (App.S.assortimento || []).filter(function (r) {
        return r.articoloId === artId && r.armadioId && r.repartoId !== st.rep && r.attivo !== false;
      }).map(function (r) { return App.nomeReparto(r.repartoId) + ' (' + testoPosto(r) + ')'; });
      return { errore: a.nome + ' non ha un posto negli armadi di ' + App.nomeReparto(st.rep) + (altrove.length ? '. Si trova in: ' + altrove.join('; ') : '') + '.' };
    }

    function cercaDaCampo() {
      var t = cerca.value.trim();
      if (!t) return;
      var a = App.articoloPerNome(t);
      if (!a) {
        var tl = t.toLowerCase();
        var possibili = assortimentoDi(st.rep).map(function (r) { return App.articolo(r.articoloId); })
          .filter(function (x) { return x && x.nome.toLowerCase().indexOf(tl) >= 0; });
        if (!possibili.length) possibili = App.articoliAttivi().filter(function (x) { return x.nome.toLowerCase().indexOf(tl) >= 0; });
        a = possibili[0];
      }
      if (!a) { App.avviso('Nessun articolo con «' + t + '» nel nome.', 'errore'); return; }
      var esito = trova(a.id);
      App.avviso(esito.ok || esito.errore, esito.ok ? 'ok' : 'errore');
    }

    App.gestoreScansione = function (info, a) {
      var esito = trova(a.id);
      if (esito.ok) return esito.ok;
      App.avviso(esito.errore, 'errore');
      return false;
    };

    /* ---------- eventi ---------- */

    function aggiornaDisponi() {
      var puo = puoDisporre(st.rep);
      bDisponi.hidden = !puo;
      if (!puo) st.disponi = false;
      bDisponi.setAttribute('aria-pressed', st.disponi ? 'true' : 'false');
      bDisponi.classList.toggle('primario', st.disponi);
      bDisponi.textContent = st.disponi ? '✓ Fine disposizione' : '✋ Disponi';
      cont.classList.toggle('ar-in-disponi', st.disponi);
    }

    selMag.addEventListener('change', function () {
      st.rep = selMag.value;
      st.arm = null;
      st.sel = null;
      st.filtroStato = '';
      V().annullaPresa();
      aggiornaDisponi();
      ricorda();
      aggiornaDatalist();
      disegnaArmadi();
      disegnaVista(true);
      cont.querySelector('#ar-lato').innerHTML = '';
      disegnaLato();
    });
    cont.querySelector('#ar-armadi').addEventListener('click', function (e) {
      var b = e.target.closest('[data-arm]');
      if (!b || b.getAttribute('data-arm') === st.arm) return;
      st.arm = b.getAttribute('data-arm');
      st.filtroStato = '';
      V().annullaPresa();
      ricorda();
      disegnaArmadi();
      disegnaVista(true);
      disegnaLato();
      var nuovo = cont.querySelector('#ar-armadi [data-arm="' + cssId(st.arm) + '"]');
      if (nuovo) nuovo.focus();
    });
    cont.querySelector('#ar-legenda').addEventListener('click', function (e) {
      var b = e.target.closest('[data-stato]');
      if (!b || !st.vista) return;
      var k = b.getAttribute('data-stato');
      st.filtroStato = st.filtroStato === k ? '' : k;
      if (st.filtroStato) st.vista.el.setAttribute('data-filtro', st.filtroStato);
      else st.vista.el.removeAttribute('data-filtro');
      Array.prototype.forEach.call(cont.querySelectorAll('#ar-legenda [data-stato]'), function (x) {
        var on = x.getAttribute('data-stato') === st.filtroStato;
        x.classList.toggle('scelto', on);
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (st.filtroStato && root.Motion) root.Motion.evidenzia(st.vista.el.querySelectorAll('.av-scatola.av-s-' + st.filtroStato));
    });
    bDisponi.addEventListener('click', function () {
      st.disponi = !st.disponi;
      V().annullaPresa();
      aggiornaDisponi();
      ricorda();
      cont.querySelector('#ar-lato').innerHTML = '';
      disegnaVista(false);
      disegnaLato();
    });
    cont.querySelector('#ar-auto').addEventListener('click', disposizioneAutomatica);
    cont.querySelector('#ar-svuota').addEventListener('click', svuota);
    // Invio e scelta dall'elenco: una ricerca sola per testo scritto. L'evento change arriva anche quando il campo
    // perde il fuoco: se il testo è quello già cercato non ripeto la ricerca (Invio invece la ripete sempre).
    var giaCercato = null;
    cerca.addEventListener('input', function (e) {
      giaCercato = null;
      // scelta di un nome dall'elenco a discesa: cerco subito, senza aspettare Invio
      if (e.inputType === 'insertReplacementText' && App.articoloPerNome(cerca.value)) {
        giaCercato = cerca.value.trim();
        cercaDaCampo();
      }
    });
    cerca.addEventListener('change', function () {
      var t = cerca.value.trim();
      if (!t || t === giaCercato) return;
      giaCercato = t;
      cercaDaCampo();
    });
    cerca.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      giaCercato = cerca.value.trim();
      cercaDaCampo();
    });
    var lato = cont.querySelector('#ar-lato');
    // modalità Disponi: trascinamento dall'elenco, "Metti" da tastiera, rilascio sull'elenco = togli dall'armadio
    lato.addEventListener('av-rilascio', function (e) {
      var d = e.detail || {};
      if (st.disponi && d.da && d.articoloId) togli(d.articoloId);
    });
    lato.addEventListener('pointerdown', function (e) {
      var li = e.target.closest('.ar-voce');
      if (!st.disponi || !li || e.target.closest('button')) return;
      // con il dito si trascina dalla maniglia: il resto della riga fa scorrere l'elenco
      if (e.pointerType !== 'mouse' && !e.target.closest('.ar-maniglia')) return;
      var art = App.articolo(li.getAttribute('data-art'));
      if (!art) return;
      if (e.pointerType === 'mouse') e.preventDefault(); // niente selezione del testo
      var r = rigaAss(st.rep, art.id);
      V().trascina(e, {
        articoloId: art.id, testo: art.nome, stato: statoArticolo(art.id, st.rep, r).stato,
        da: r && r.armadioId ? { armadioId: r.armadioId, ripiano: r.ripiano, posizione: r.posizione } : null
      });
    });
    lato.addEventListener('click', function (e) {
      var bp = e.target.closest('[data-prendi]');
      if (bp) {
        var ap = App.articolo(bp.getAttribute('data-prendi'));
        if (ap) prendi(ap);
        return;
      }
      var b = e.target.closest('[data-azione], [data-trova]');
      if (!b) return;
      if (b.hasAttribute('data-trova')) {
        var esito = trova(b.getAttribute('data-trova'));
        if (esito.errore) App.avviso(esito.errore, 'errore');
        return;
      }
      var az = b.getAttribute('data-azione');
      var p = { repartoId: st.rep, articoloId: st.sel };
      if (az === 'chiudi') { st.sel = null; if (st.vista) V().seleziona(st.vista, null); disegnaLato(); }
      else if (az === 'scheda') App.schedaArticolo(st.sel);
      else if (az === 'consumi') App.vai('consumi', p);
      else if (az === 'perdite') App.vai('perdite', p);
      else if (az === 'richiesta') App.vai('richieste', { repartoId: st.rep, articoloId: st.sel, nuova: true });
    });

    // aggiornamenti di altri utenti: ridisegno vista e pannello, i campi della barra restano come sono
    App.rinfresca = function () {
      if (!App.S.reparti.some(function (r) { return r.id === st.rep && r.attivo !== false; })) { App.ridisegna(); return; }
      aggiornaDisponi();
      aggiornaDatalist();
      disegnaArmadi();
      disegnaVista(false);
      disegnaLato();
    };

    aggiornaDisponi();
    ricorda();
    aggiornaDatalist();
    disegnaArmadi();
    disegnaVista(true);
    disegnaLato();
    if (st.sel && par.articoloId) {
      var e0 = trova(st.sel, true);
      if (e0.errore) App.avviso(e0.errore, 'errore');
    }
  };

  /* ======================= MAGAZZINI E ASSORTIMENTO ======================= */

  var memMagazzini = { rep: null, scheda: null, anche: false };
  // modifiche all'assortimento non ancora salvate, per magazzino: { repId: { articoloId: { scortaMin, puntoRiordino, scortaMax, attivo } } }
  var bozzeAssortimento = {};

  function swatches(nome, scelto, conAuto) {
    var lista = (conAuto ? [''] : []).concat(COLORI);
    if (scelto && lista.indexOf(scelto) < 0) lista.push(scelto);
    return '<div class="mg-colori" role="radiogroup" aria-label="Colore">' + lista.map(function (c, i) {
      return '<label class="mg-colore' + (c ? '' : ' mg-colore-auto') + '"' + (c ? ' style="--mg-c:' + h(c) + '"' : '') + ' title="' + (c ? h(c) : 'Automatico') + '">' +
        '<input type="radio" name="' + h(nome) + '" value="' + h(c) + '"' + (c === (scelto || '') ? ' checked' : '') + ' aria-label="' + (c ? 'Colore ' + h(c) : 'Colore automatico') + '"' + (i === 0 ? '' : '') + '>' +
        '<span aria-hidden="true">' + (c ? '' : 'A') + '</span></label>';
    }).join('') +
      '<label class="mg-colore mg-colore-altro" title="Un altro colore"><input type="color" data-colore-altro="' + h(nome) + '" value="' + h(scelto || '#1c4184') + '" aria-label="Scegli un altro colore"></label>' +
      '</div>';
  }

  function coloreScelto(box, nome) {
    var r = box.querySelector('input[name="' + nome + '"]:checked');
    return r ? r.value : '';
  }

  function collegaColori(box) {
    Array.prototype.forEach.call(box.querySelectorAll('[data-colore-altro]'), function (inp) {
      inp.addEventListener('input', function () {
        var nome = inp.getAttribute('data-colore-altro');
        var gruppo = inp.closest('.mg-colori');
        var esiste = gruppo.querySelector('input[name="' + nome + '"][value="' + inp.value.toLowerCase() + '"]');
        if (!esiste) {
          var l = document.createElement('label');
          l.className = 'mg-colore';
          l.style.setProperty('--mg-c', inp.value);
          l.title = inp.value;
          l.innerHTML = '<input type="radio" name="' + h(nome) + '" value="' + h(inp.value.toLowerCase()) + '" aria-label="Colore ' + h(inp.value) + '"><span aria-hidden="true"></span>';
          gruppo.insertBefore(l, inp.closest('label'));
          esiste = l.querySelector('input');
        }
        esiste.checked = true;
        esiste.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  function modulo(m, puo) {
    var dis = puo ? '' : ' disabled';
    var piani = {};
    App.S.reparti.forEach(function (r) { if (r.tipo !== 'transito' && r.piano) piani[r.piano] = true; });
    return '<div class="modulo mg-modulo">' +
      '<label class="campo"><span>Nome *</span><input id="mg-nome" value="' + h(m.nome || '') + '" maxlength="80" autocomplete="off"' + dis + '></label>' +
      '<div class="campo"><span>Tipo</span><div class="mg-tipi" role="radiogroup" aria-label="Tipo di magazzino">' +
      '<label class="spunta"><input type="radio" name="mg-tipo" value="centrale"' + (eCentrale(m) ? ' checked' : '') + dis + '> ✚ Farmacia centrale</label>' +
      '<label class="spunta"><input type="radio" name="mg-tipo" value="periferico"' + (!eCentrale(m) ? ' checked' : '') + dis + '> Magazzino di piano</label></div></div>' +
      '<label class="campo"><span>Piano</span><input id="mg-piano" list="mg-dl-piani" value="' + h(m.piano || '') + '" maxlength="40" placeholder="' + h(pianoDaLivello(m.livello || 0)) + '"' + dis + '></label>' +
      '<datalist id="mg-dl-piani">' + Object.keys(piani).sort().map(function (p) { return '<option value="' + h(p) + '">'; }).join('') + '</datalist>' +
      '<label class="campo"><span>Livello (−1 seminterrato, 0 piano terra…)</span><input id="mg-livello" type="number" min="-5" max="60" step="1" value="' + h(m.livello || 0) + '"' + dis + '></label>' +
      '<div class="campo largo"><span>Colore sulla mappa</span>' + swatches('mg-colore', m.colore || '', true) + '</div>' +
      '<label class="campo largo"><span>Descrizione</span><textarea id="mg-descrizione" maxlength="300" rows="2"' + dis + '>' + h(m.descrizione || '') + '</textarea></label>' +
      (m.id ? '<label class="campo"><span>Ordine (nel piano)</span><input id="mg-ordine" type="number" min="0" max="9998" step="1" value="' + h(m.ordine || 0) + '"' + dis + '></label>' +
        '<label class="spunta mg-attivo"><input type="checkbox" id="mg-attivo"' + (m.attivo !== false ? ' checked' : '') + dis + '> Magazzino attivo</label>' : '') +
      '</div>';
  }

  function leggiModulo(box) {
    function v(sel) { var el = box.querySelector(sel); return el ? el.value : ''; }
    var tipo = box.querySelector('input[name="mg-tipo"]:checked');
    var d = {
      nome: v('#mg-nome').trim(),
      tipo: tipo ? tipo.value : 'periferico',
      piano: v('#mg-piano').trim(),
      livello: Math.round(Number(v('#mg-livello')) || 0),
      colore: coloreScelto(box, 'mg-colore'),
      descrizione: v('#mg-descrizione').trim()
    };
    if (box.querySelector('#mg-ordine')) d.ordine = Math.max(0, Math.round(Number(v('#mg-ordine')) || 0));
    if (box.querySelector('#mg-attivo')) d.attivo = box.querySelector('#mg-attivo').checked;
    return d;
  }

  function moduloArmadio(a) {
    var tipi = V().TIPI;
    return '<div class="mg-arm-modulo"><div class="modulo">' +
      '<label class="campo"><span>Nome *</span><input id="arm-nome" value="' + h(a.nome || '') + '" maxlength="60" autocomplete="off"></label>' +
      '<div class="campo largo"><span>Tipo</span><div class="mg-arm-tipi" role="radiogroup" aria-label="Tipo di armadio">' + Object.keys(tipi).map(function (k) {
        return '<label class="mg-arm-tipo"><input type="radio" name="arm-tipo" value="' + k + '"' + ((a.tipo || 'armadio') === k ? ' checked' : '') + '>' +
          '<span><i aria-hidden="true">' + tipi[k].ico + '</i>' + h(tipi[k].nome) + '</span></label>';
      }).join('') + '</div></div>' +
      '<label class="campo"><span>Ripiani (1–12)</span><input id="arm-ripiani" type="number" min="1" max="12" step="1" value="' + h(a.ripiani || 4) + '"></label>' +
      '<label class="campo"><span>Posti per ripiano (1–20)</span><input id="arm-colonne" type="number" min="1" max="20" step="1" value="' + h(a.colonne || 6) + '"></label>' +
      '<div class="campo largo"><span>Colore</span>' + swatches('arm-colore', a.colore || '', true) + '</div>' +
      '<label class="campo largo"><span>Note</span><input id="arm-note" value="' + h(a.note || '') + '" maxlength="300" placeholder="es. chiave nel cassetto della guardiola"></label>' +
      (a.id ? '<label class="campo"><span>Ordine</span><input id="arm-ordine" type="number" min="0" max="9999" step="1" value="' + h(a.ordine || 0) + '"></label>' +
        '<label class="spunta mg-attivo"><input type="checkbox" id="arm-attivo"' + (a.attivo !== false ? ' checked' : '') + '> Armadio attivo</label>' : '') +
      '</div><div class="mg-arm-anteprima"><span class="piccolo tenue">Anteprima</span><div id="arm-anteprima"></div></div></div>';
  }

  function leggiArmadio(m) {
    function v(sel) { var el = m.querySelector(sel); return el ? el.value : ''; }
    var tipo = m.querySelector('input[name="arm-tipo"]:checked');
    var d = {
      nome: v('#arm-nome').trim(),
      tipo: tipo ? tipo.value : 'armadio',
      ripiani: Math.round(Number(v('#arm-ripiani')) || 0),
      colonne: Math.round(Number(v('#arm-colonne')) || 0),
      colore: coloreScelto(m, 'arm-colore'),
      note: v('#arm-note').trim()
    };
    if (m.querySelector('#arm-ordine')) d.ordine = Math.max(0, Math.round(Number(v('#arm-ordine')) || 0));
    if (m.querySelector('#arm-attivo')) d.attivo = m.querySelector('#arm-attivo').checked;
    return d;
  }

  /* Consumo medio giornaliero degli ultimi 90 giorni in un magazzino: { articoloId: media }. */
  function consumiMedi(repId, articoli) {
    var Pv = root.Previsioni;
    var out = {};
    // il modulo delle previsioni (parte D) ha la sua media: la uso se c'è
    if (Pv && typeof Pv.consumoMedio === 'function') {
      try {
        articoli.forEach(function (id) {
          var v = Pv.consumoMedio(App.S, id, repId, GIORNI_CONSUMO);
          if (typeof v === 'object' && v !== null) v = v.giornaliero;
          if (isFinite(Number(v))) out[id] = Number(v);
        });
        if (Object.keys(out).length === articoli.length) return out;
      } catch (e) { out = {}; }
    }
    var oggi = new Date();
    var inizio = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() - GIORNI_CONSUMO + 1);
    var dal = inizio.getFullYear() + '-' + String(inizio.getMonth() + 1).padStart(2, '0') + '-' + String(inizio.getDate()).padStart(2, '0');
    var centrale = eCentrale(App.reparto(repId));
    var primo = null;
    var somme = {};
    App.S.movimenti.forEach(function (m) {
      if (m.annullato || m.repartoId !== repId) return;
      if (!primo || m.data < primo) primo = m.data;
      if (m.data < dal) return;
      // uscite che consumano la scorta: consumi e perdite; per la farmacia centrale anche quello che dà agli altri magazzini
      if (m.tipo === 'consumo' || m.tipo === 'perdita' || (centrale && m.tipo === 'trasferimento')) {
        somme[m.articoloId] = (somme[m.articoloId] || 0) + (Number(m.quantita) || 0);
      }
    });
    // con meno di 90 giorni di storia si divide per i giorni che ci sono
    var giorni = GIORNI_CONSUMO;
    if (primo && primo > dal) {
      var p = primo.split('-').map(Number);
      giorni = Math.max(7, Math.round((oggi - new Date(p[0], p[1] - 1, p[2])) / 86400000) + 1);
    }
    articoli.forEach(function (id) { out[id] = (somme[id] || 0) / giorni; });
    return out;
  }

  P.magazzini = function (cont, par) {
    par = par || {};
    var puoStruttura = App.puo('struttura');
    var puoAss = App.puo('assortimento');
    var tutti = function () {
      return App.S.reparti.filter(function (r) { return r.tipo !== 'transito' && (memMagazzini.anche || r.attivo !== false || r.id === memMagazzini.rep); });
    };
    if (!App.S.reparti.some(function (r) { return r.tipo !== 'transito'; })) {
      cont.innerHTML = scheda('Magazzini', vuoto('Nessun magazzino', ''));
      return;
    }
    var lista0 = tutti();
    memMagazzini.rep = par.repartoId && App.reparto(par.repartoId) ? par.repartoId : magazzinoTra(lista0.length ? lista0 : App.repartiAttivi(), memMagazzini.rep);
    var schedaScelta = par.scheda || memMagazzini.scheda || (puoStruttura ? 'dati' : 'assortimento');
    if (!puoStruttura && schedaScelta === 'dati') schedaScelta = 'assortimento';
    memMagazzini.scheda = schedaScelta;

    cont.innerHTML = '<div class="mg-pagina">' +
      '<aside class="scheda mg-elenco"><div class="scheda-testa"><h2>Magazzini</h2>' +
      (puoStruttura ? '<button class="btn primario piccolo" type="button" id="mg-nuovo">+ Nuovo magazzino</button>' : '') + '</div>' +
      '<div id="mg-lista" class="mg-lista"></div>' +
      '<div class="mg-elenco-piede"><label class="spunta"><input type="checkbox" id="mg-anche"' + (memMagazzini.anche ? ' checked' : '') + '> Mostra anche i non attivi</label></div>' +
      '</aside>' +
      '<section class="mg-dettaglio" id="mg-dettaglio"></section>' +
      '</div>';

    function disegnaLista() {
      var lista = tutti();
      var piani = {};
      lista.forEach(function (r) { var l = Number(r.livello) || 0; (piani[l] = piani[l] || []).push(r); });
      var livelli = Object.keys(piani).map(Number).sort(function (a, b) { return b - a; });
      cont.querySelector('#mg-lista').innerHTML = livelli.map(function (l) {
        return '<div class="mg-gruppo"><h3 class="mg-piano">' + h(nomePiano(piani[l][0])) + '</h3><ul>' +
          piani[l].sort(function (a, b) { return (eCentrale(b) ? 1 : 0) - (eCentrale(a) ? 1 : 0) || a.ordine - b.ordine; }).map(function (r) {
            var ind = indicatori(r);
            return '<li><button type="button" class="mg-voce' + (r.id === memMagazzini.rep ? ' scelto' : '') + (r.attivo === false ? ' spento' : '') + '" data-rep="' + h(r.id) + '" aria-pressed="' + (r.id === memMagazzini.rep) + '"' +
              (r.colore ? ' style="--st-colore:' + h(r.colore) + '"' : '') + '>' +
              '<span class="mg-pallino' + (eCentrale(r) ? ' centrale' : '') + '" aria-hidden="true"></span>' +
              '<span class="mg-voce-testo"><b>' + h(r.nome) + '</b><small>' + (eCentrale(r) ? 'Farmacia centrale · ' : '') + quanti(ind.articoli, 'articolo', 'articoli') + ' · ' + quanti(ind.armadi, 'armadio', 'armadi') +
              (r.attivo === false ? ' · non attivo' : '') + '</small></span>' +
              (ind.sotto ? '<span class="etichetta pericolo" title="Articoli sotto scorta">' + ind.sotto + '</span>' : '') +
              '</button></li>';
          }).join('') + '</ul></div>';
      }).join('');
    }

    function disegnaDettaglio() {
      var rep = App.reparto(memMagazzini.rep);
      var box = cont.querySelector('#mg-dettaglio');
      if (!rep || rep.tipo === 'transito') { box.innerHTML = scheda('Magazzino', vuoto('Scegli un magazzino dall’elenco', '')); return; }
      var schede = [];
      schede.push({ id: 'dati', testo: 'Dati', lungo: ' del magazzino' });
      schede.push({ id: 'armadi', testo: 'Armadi', lungo: '' });
      schede.push({ id: 'assortimento', testo: 'Assortimento', lungo: ' e scorte' });
      box.innerHTML =
        '<div class="mg-testa"' + (rep.colore ? ' style="--st-colore:' + h(rep.colore) + '"' : '') + '>' +
        '<div><span class="st-tipo">' + (eCentrale(rep) ? '✚ Farmacia centrale' : 'Magazzino di piano') + ' · ' + h(nomePiano(rep)) + '</span><h2 id="mg-titolo">' + h(rep.nome) + '</h2></div>' +
        '<a class="btn piccolo" href="#armadi" id="mg-apri-armadi">🗄️ Vedi gli armadi</a></div>' +
        '<div class="mg-schede" role="tablist" aria-label="Sezioni del magazzino">' + schede.map(function (s) {
          return '<button type="button" role="tab" id="mg-tab-' + s.id + '" data-scheda="' + s.id + '" aria-controls="mg-pannello" aria-selected="' + (s.id === memMagazzini.scheda) + '" tabindex="' + (s.id === memMagazzini.scheda ? '0' : '-1') + '">' + h(s.testo) + (s.lungo ? '<span class="mg-lungo">' + h(s.lungo) + '</span>' : '') + '</button>';
        }).join('') + '</div>' +
        '<div id="mg-pannello" role="tabpanel" aria-labelledby="mg-tab-' + memMagazzini.scheda + '" class="mg-pannello"></div>';
      box.querySelector('#mg-apri-armadi').addEventListener('click', function (e) { e.preventDefault(); App.vai('armadi', { repartoId: rep.id }); });
      var tabs = box.querySelector('.mg-schede');
      tabs.addEventListener('click', function (e) {
        var b = e.target.closest('[data-scheda]');
        if (b) scegliScheda(b.getAttribute('data-scheda'), true);
      });
      tabs.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        var ids = schede.map(function (s) { return s.id; });
        var i = ids.indexOf(memMagazzini.scheda) + (e.key === 'ArrowRight' ? 1 : -1);
        scegliScheda(ids[(i + ids.length) % ids.length], true);
        e.preventDefault();
      });
      disegnaPannello(rep);
    }

    function scegliScheda(id, conFuoco) {
      if (id === memMagazzini.scheda) return;
      if (memMagazzini.scheda === 'assortimento' && Object.keys(bozzeAssortimento[memMagazzini.rep] || {}).length) {
        // le modifiche non salvate restano da parte: si ritrovano tornando sulla scheda
        App.avviso('Le modifiche all’assortimento non sono ancora salvate: le ritrovi nella scheda Assortimento.', 'errore');
      }
      memMagazzini.scheda = id;
      var box = cont.querySelector('#mg-dettaglio');
      Array.prototype.forEach.call(box.querySelectorAll('[data-scheda]'), function (b) {
        var on = b.getAttribute('data-scheda') === id;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.setAttribute('tabindex', on ? '0' : '-1');
        if (on && conFuoco) b.focus();
      });
      box.querySelector('#mg-pannello').setAttribute('aria-labelledby', 'mg-tab-' + id);
      disegnaPannello(App.reparto(memMagazzini.rep));
    }

    function disegnaPannello(rep) {
      // pannello nuovo a ogni disegno: gli ascoltatori del pannello di prima se ne vanno con lui
      var vecchio = cont.querySelector('#mg-pannello');
      var p = vecchio.cloneNode(false);
      vecchio.parentNode.replaceChild(p, vecchio);
      if (memMagazzini.scheda === 'armadi') pannelloArmadi(p, rep);
      else if (memMagazzini.scheda === 'assortimento') pannelloAssortimento(p, rep);
      else pannelloDati(p, rep);
      if (root.Motion) root.Motion.entra(p.children, { ritardo: 30, distanza: 6 });
    }

    /* ---------- dati del magazzino ---------- */

    function pannelloDati(p, rep) {
      p.innerHTML = '<div class="mg-dati">' +
        scheda('Dati del magazzino', modulo(rep, puoStruttura) +
          (puoStruttura ? '<div class="strumenti mg-azioni">' +
            (!eCentrale(rep) ? '<button class="btn pericolo" type="button" id="mg-elimina">Elimina</button>' : '') +
            '<span class="spazio"></span><button class="btn primario" type="button" id="mg-salva">Salva</button></div>'
            : '<p class="piccolo tenue">Solo l’amministratore cambia i dati dei magazzini.</p>')) +
        '<div class="mg-anteprima"><span class="piccolo tenue">Come appare sulla mappa</span><div id="mg-stanza"></div>' +
        '<p class="piccolo tenue">La farmacia centrale è una sola: scegliendone un’altra, quella di prima diventa un magazzino di piano. Un magazzino già usato non si elimina: togli la spunta «Magazzino attivo».</p></div>' +
        '</div>';
      var indRep = indicatori(rep);
      function anteprima() {
        var d = leggiModulo(p);
        var finto = Object.assign({}, rep, d, { centrale: d.tipo === 'centrale' });
        if (!finto.nome) finto.nome = 'Nuovo magazzino';
        p.querySelector('#mg-stanza').innerHTML = htmlStanza(finto, indRep, { anteprima: true });
      }
      anteprima();
      collegaColori(p);
      p.addEventListener('input', anteprima);
      p.addEventListener('change', anteprima);
      if (!puoStruttura) {
        Array.prototype.forEach.call(p.querySelectorAll('.mg-colori input'), function (i) { i.disabled = true; });
        return;
      }
      p.querySelector('#mg-salva').addEventListener('click', function () {
        var d = leggiModulo(p);
        if (!d.nome) { App.avviso('Scrivi il nome del magazzino.', 'errore'); return; }
        var procedi = Promise.resolve(true);
        var vecchia = App.repartoCentrale();
        if (d.tipo === 'centrale' && !eCentrale(rep) && vecchia && vecchia.id !== rep.id) {
          procedi = App.conferma('Nuova farmacia centrale', '«' + h(rep.nome) + '» diventa la farmacia centrale e «' + h(vecchia.nome) + '» diventa un magazzino di piano. Procedo?', 'Procedi');
        } else if (d.attivo === false && rep.attivo !== false) {
          var giac = Object.keys(App.giacenze()).some(function (k) { return k.slice(k.lastIndexOf('|') + 1) === rep.id && App.giacenze()[k] > 0; });
          if (giac) procedi = App.conferma('Disattiva il magazzino', 'In «' + h(rep.nome) + '» ci sono ancora articoli in giacenza. Disattivato, non compare più negli elenchi. Procedo?', 'Disattiva', true);
        }
        procedi.then(function (ok) {
          if (!ok) return;
          var b = p.querySelector('#mg-salva');
          b.disabled = true;
          Api().scrivi('PUT', '/api/magazzini/' + encodeURIComponent(rep.id), d).then(function () {
            App.avviso('Magazzino salvato', 'ok');
            if (cont.isConnected) { disegnaLista(); disegnaDettaglio(); }
          }, function (e) {
            b.disabled = false;
            App.avviso('Magazzino non salvato: ' + messaggioErrore(e), 'errore');
          });
        });
      });
      var el = p.querySelector('#mg-elimina');
      if (el) el.addEventListener('click', function () {
        if (App.S.movimenti.some(function (m) { return m.repartoId === rep.id || m.repartoDestId === rep.id; })) {
          App.avviso('Il magazzino ha dei movimenti: non si può eliminare. Togli la spunta «Magazzino attivo» per nasconderlo.', 'errore');
          return;
        }
        var arm = armadiDi(rep.id, true).length;
        var ass = assortimentoDi(rep.id, true).length;
        App.conferma('Elimina magazzino', 'Elimino «' + h(rep.nome) + '»' + (arm || ass ? ' con ' + quanti(arm, 'armadio', 'armadi') + ' e ' + quanti(ass, 'riga', 'righe') + ' di assortimento' : '') + '? Gli utenti assegnati lo perdono.', 'Elimina', true).then(function (ok) {
          if (!ok) return;
          Api().scrivi('DELETE', '/api/magazzini/' + encodeURIComponent(rep.id)).then(function () {
            App.avviso('Magazzino eliminato', 'ok');
            memMagazzini.rep = null;
            if (cont.isConnected) App.ridisegna();
          }, function (e) { App.avviso('Magazzino non eliminato: ' + messaggioErrore(e), 'errore'); });
        });
      });
    }

    function nuovoMagazzino() {
      App.apriModale({
        titolo: 'Nuovo magazzino',
        largo: true,
        corpo: modulo({ tipo: 'periferico', livello: 1 }, true) +
          '<p class="piccolo tenue">Dopo averlo creato aggiungi i suoi armadi e il suo assortimento (gli articoli che tiene, con le scorte).</p>',
        piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="mg-crea">Crea magazzino</button>',
        dopo: function (m) {
          collegaColori(m);
          m.querySelector('#mg-crea').addEventListener('click', function () {
            var b = this;
            var d = leggiModulo(m);
            if (!d.nome) { App.avviso('Scrivi il nome del magazzino.', 'errore'); return; }
            b.disabled = true;
            Api().scrivi('POST', '/api/magazzini', d).then(function (r) {
              App.chiudiModale();
              App.avviso('Magazzino «' + d.nome + '» creato', 'ok');
              memMagazzini.rep = r && r.magazzino ? r.magazzino.id : memMagazzini.rep;
              memMagazzini.scheda = 'armadi';
              if (cont.isConnected) App.ridisegna();
            }, function (e) {
              b.disabled = false;
              App.avviso('Magazzino non creato: ' + messaggioErrore(e), 'errore');
            });
          });
        }
      });
    }

    /* ---------- armadi ---------- */

    function pannelloArmadi(p, rep) {
      var lista = armadiDi(rep.id, true);
      p.innerHTML = '<div class="strumenti"><span class="piccolo tenue">' + quanti(lista.length, 'armadio', 'armadi') + ' in ' + h(rep.nome) + '</span><span class="spazio"></span>' +
        (puoStruttura ? '<button class="btn primario" type="button" id="mg-arm-nuovo">+ Nuovo armadio</button>' : '') + '</div>' +
        (lista.length ? '<div class="mg-armadi">' + lista.map(function (a) {
          var dentro = assortimentoDi(rep.id).filter(function (r) { return r.armadioId === a.id; }).length;
          var t = V().TIPI[a.tipo] || V().TIPI.armadio;
          return '<article class="mg-armadio' + (a.attivo === false ? ' spento' : '') + '" data-arm="' + h(a.id) + '">' +
            '<div class="mg-armadio-vista" data-anteprima="' + h(a.id) + '"></div>' +
            '<div class="mg-armadio-testo"><b>' + h(a.nome) + '</b><small>' + t.ico + ' ' + h(t.nome) + ' · ' + a.ripiani + ' × ' + a.colonne + (a.ripiani * a.colonne === 1 ? ' posto · ' : ' posti · ') + quanti(dentro, 'articolo', 'articoli') +
            (a.attivo === false ? ' · non attivo' : '') + '</small>' + (a.note ? '<small class="tenue">' + h(a.note) + '</small>' : '') + '</div>' +
            '<div class="mg-armadio-azioni"><button class="btn piccolo" type="button" data-apri="' + h(a.id) + '">Apri</button>' +
            (puoStruttura ? '<button class="btn piccolo" type="button" data-modifica="' + h(a.id) + '">Modifica</button>' +
              '<button class="btn piccolo pericolo" type="button" data-elimina="' + h(a.id) + '">Elimina</button>' : '') + '</div></article>';
        }).join('') + '</div>'
          : vuoto('Nessun armadio', puoStruttura ? 'Crea gli armadi, il frigorifero, le cassettiere e i carrelli di questo magazzino: poi potrai disporre gli articoli nelle caselle.' : 'L’amministratore crea gli armadi di questo magazzino.'));
      Array.prototype.forEach.call(p.querySelectorAll('[data-anteprima]'), function (el) {
        var a = armadio(el.getAttribute('data-anteprima'));
        if (a) V().disegna(el, { armadio: a, caselle: caselleDi(rep.id, a), anteprima: true, ingresso: false });
      });
      var nuovo = p.querySelector('#mg-arm-nuovo');
      if (nuovo) nuovo.addEventListener('click', function () { finestraArmadio(rep, null); });
      p.addEventListener('click', function (e) {
        var b = e.target.closest('[data-apri], [data-modifica], [data-elimina]');
        if (!b) return;
        if (b.hasAttribute('data-apri')) App.vai('armadi', { repartoId: rep.id, armadioId: b.getAttribute('data-apri') });
        else if (b.hasAttribute('data-modifica')) finestraArmadio(rep, armadio(b.getAttribute('data-modifica')));
        else eliminaArmadio(armadio(b.getAttribute('data-elimina')));
      });
    }

    function finestraArmadio(rep, a) {
      var dati = a || { repartoId: rep.id, tipo: 'armadio', ripiani: 4, colonne: 6 };
      App.apriModale({
        titolo: a ? 'Modifica armadio' : 'Nuovo armadio in ' + rep.nome,
        largo: true,
        corpo: moduloArmadio(dati),
        piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="arm-salva">' + (a ? 'Salva' : 'Crea armadio') + '</button>',
        dopo: function (m) {
          collegaColori(m);
          function anteprima() {
            var d = leggiArmadio(m);
            var finto = Object.assign({}, dati, d, {
              id: 'anteprima', nome: d.nome || 'Nuovo armadio',
              ripiani: Math.max(1, Math.min(12, d.ripiani || 1)), colonne: Math.max(1, Math.min(20, d.colonne || 1))
            });
            V().disegna(m.querySelector('#arm-anteprima'), { armadio: finto, caselle: a ? caselleDi(rep.id, a) : [], anteprima: true, ingresso: false });
          }
          anteprima();
          m.querySelector('.mg-arm-modulo').addEventListener('input', anteprima);
          m.querySelector('.mg-arm-modulo').addEventListener('change', anteprima);
          m.querySelector('#arm-salva').addEventListener('click', function () {
            var b = this;
            var d = leggiArmadio(m);
            if (!d.nome) { App.avviso('Scrivi il nome dell’armadio.', 'errore'); return; }
            if (!(d.ripiani >= 1 && d.ripiani <= 12)) { App.avviso('I ripiani vanno da 1 a 12.', 'errore'); return; }
            if (!(d.colonne >= 1 && d.colonne <= 20)) { App.avviso('I posti per ripiano vanno da 1 a 20.', 'errore'); return; }
            var procedi = Promise.resolve(true);
            if (a) {
              var fuori = assortimentoDi(rep.id).filter(function (r) { return r.armadioId === a.id && (r.ripiano > d.ripiani || r.posizione > d.colonne); }).length;
              if (fuori) procedi = App.conferma('Armadio più piccolo', 'Con meno ripiani o posti, <b>' + fuori + '</b> ' + (fuori === 1 ? 'articolo resta senza casella e torna' : 'articoli restano senza casella e tornano') + ' fra quelli da sistemare. Procedo?', 'Procedi');
            }
            procedi.then(function (ok) {
              if (!ok) return;
              b.disabled = true;
              d.repartoId = rep.id;
              Api().scrivi(a ? 'PUT' : 'POST', a ? '/api/armadi/' + encodeURIComponent(a.id) : '/api/armadi', d).then(function () {
                App.chiudiModale();
                App.avviso(a ? 'Armadio salvato' : 'Armadio «' + d.nome + '» creato', 'ok');
                if (cont.isConnected) { disegnaLista(); disegnaPannello(App.reparto(rep.id)); }
              }, function (e) {
                b.disabled = false;
                App.avviso('Armadio non salvato: ' + messaggioErrore(e), 'errore');
              });
            });
          });
        }
      });
    }

    function eliminaArmadio(a) {
      if (!a) return;
      var dentro = assortimentoDi(a.repartoId).filter(function (r) { return r.armadioId === a.id; }).length;
      App.conferma('Elimina armadio', 'Elimino «' + h(a.nome) + '»?' + (dentro ? (dentro === 1 ? ' Il suo unico articolo resta nell’assortimento e torna' : ' I suoi <b>' + dentro + '</b> articoli restano nell’assortimento e tornano') + ' fra quelli da sistemare.' : '') + ' Le giacenze non cambiano.', 'Elimina', true).then(function (ok) {
        if (!ok) return;
        Api().scrivi('DELETE', '/api/armadi/' + encodeURIComponent(a.id)).then(function () {
          App.avviso('Armadio eliminato', 'ok');
          if (cont.isConnected) { disegnaLista(); disegnaPannello(App.reparto(a.repartoId)); }
        }, function (e) { App.avviso('Armadio non eliminato: ' + messaggioErrore(e), 'errore'); });
      });
    }

    /* ---------- assortimento ---------- */

    var filtroAss = { testo: '', cat: '', solo: false };

    function pannelloAssortimento(p, rep) {
      var bozza = bozzeAssortimento[rep.id] = bozzeAssortimento[rep.id] || {};
      p.innerHTML =
        '<div class="strumenti as-strumenti">' +
        '<label class="campo"><span>Cerca</span><input id="as-cerca" type="search" autocomplete="off" value="' + h(filtroAss.testo) + '" placeholder="Nome dell’articolo"></label>' +
        '<label class="campo"><span>Categoria</span><select id="as-cat"><option value="">Farmaci e presidi</option>' +
        '<option value="FARMACI"' + (filtroAss.cat === 'FARMACI' ? ' selected' : '') + '>Farmaci</option><option value="PRESIDI"' + (filtroAss.cat === 'PRESIDI' ? ' selected' : '') + '>Presidi</option></select></label>' +
        '<label class="spunta"><input type="checkbox" id="as-solo"' + (filtroAss.solo ? ' checked' : '') + '> Solo da controllare</label>' +
        '<span class="spazio"></span>' +
        (puoAss ? '<button class="btn" type="button" id="as-proponi" title="Scorta minima ≈ 3 giorni, riordino ≈ 7, massima ≈ 14 giorni di consumo medio degli ultimi 90 giorni">📈 Proponi dai consumi</button>' : '') +
        '</div>' +
        (puoAss ? '<div class="strumenti as-aggiungi">' +
          '<label class="campo"><span>Aggiungi un articolo all’assortimento</span><input id="as-nuovo" list="as-dl" autocomplete="off" placeholder="Nome dell’articolo"></label>' +
          '<datalist id="as-dl"></datalist>' +
          '<button class="btn" type="button" id="as-agg">Aggiungi</button>' +
          '<button class="btn" type="button" id="as-usati" title="Gli articoli consumati, persi o ricevuti in questo magazzino negli ultimi 90 giorni">+ Quelli usati negli ultimi 90 giorni</button>' +
          '</div>' : '') +
        '<div id="as-tab"></div>' +
        (puoAss ? '<div class="as-salva-barra" id="as-barra"><span id="as-stato" class="piccolo"></span><span class="spazio"></span>' +
          '<button class="btn" type="button" id="as-annulla">Annulla le modifiche</button><button class="btn primario" type="button" id="as-salva">Salva assortimento</button></div>'
          : '<p class="piccolo tenue">Le scorte dell’assortimento le stabiliscono la farmacia e l’amministratore.</p>');

      // riga dell'assortimento come è salvata, oppure una riga nuova (articolo aggiunto qui e non ancora salvato)
      function rigaBase(id) { return rigaAss(rep.id, id) || { articoloId: id, scortaMin: 0, puntoRiordino: 0, scortaMax: 0, nuovo: true, attivo: false }; }

      // in elenco: le righe attive salvate più quelle aggiunte o rimesse nella bozza
      function righeCorrenti() {
        var out = {};
        assortimentoDi(rep.id).forEach(function (r) { out[r.articoloId] = r; });
        Object.keys(bozza).forEach(function (id) { if (!out[id] && bozza[id].attivo === true) out[id] = rigaBase(id); });
        return Object.keys(out).map(function (id) { return out[id]; });
      }

      // valori da mostrare: quelli della bozza, altrimenti quelli salvati
      function valori(r) {
        var b = bozza[r.articoloId] || {};
        return {
          scortaMin: b.scortaMin !== undefined ? b.scortaMin : Number(r.scortaMin) || 0,
          puntoRiordino: b.puntoRiordino !== undefined ? b.puntoRiordino : Number(r.puntoRiordino) || 0,
          scortaMax: b.scortaMax !== undefined ? b.scortaMax : Number(r.scortaMax) || 0,
          attivo: b.attivo !== undefined ? b.attivo : r.attivo !== false
        };
      }

      function erroreSoglie(v) {
        if (v.scortaMin > 0 && v.puntoRiordino > 0 && v.scortaMin > v.puntoRiordino) return 'La scorta minima supera il punto di riordino.';
        if (v.puntoRiordino > 0 && v.scortaMax > 0 && v.puntoRiordino > v.scortaMax) return 'Il punto di riordino supera la scorta massima.';
        if (v.scortaMin > 0 && v.scortaMax > 0 && v.scortaMin > v.scortaMax) return 'La scorta minima supera la scorta massima.';
        return '';
      }

      // modifica della bozza; se tutto torna come è salvato, la riga non è più da salvare
      function cambiaBozza(id, campi) {
        var r = rigaAss(rep.id, id);
        var b = Object.assign({}, bozza[id] || {}, campi);
        var uguale = r && r.attivo !== false && b.attivo !== false &&
          (b.scortaMin === undefined || b.scortaMin === r.scortaMin) &&
          (b.puntoRiordino === undefined || b.puntoRiordino === r.puntoRiordino) &&
          (b.scortaMax === undefined || b.scortaMax === r.scortaMax);
        if (uguale) delete bozza[id];
        else bozza[id] = b;
      }

      var medie = null;
      function media(id) {
        if (!medie) medie = consumiMedi(rep.id, righeCorrenti().map(function (r) { return r.articoloId; }));
        if (medie[id] === undefined) Object.assign(medie, consumiMedi(rep.id, [id]));
        return medie[id] || 0;
      }

      function campo(classe, salvato, etichetta, art) {
        // value = valore salvato; quello modificato si mette dopo: così il giro guidato capisce che c'è qualcosa da salvare
        return '<input class="cella-input as-num ' + classe + '" inputmode="decimal" autocomplete="off" value="' + h(salvato === '' ? '' : App.fmtCampo(salvato)) + '"' +
          ' aria-label="' + h(etichetta + ' di ' + art) + '"' + (puoAss ? '' : ' readonly') + '>';
      }

      function htmlStato(s) {
        return '<span class="etichetta av-s-' + h(s.stato) + '">' + h((V().SEGNI[s.stato] || '●') + ' ' + V().STATI[s.stato]) + '</span>';
      }

      function htmlRiga(r, a) {
        var salvato = r.nuovo || r.attivo === false ? { scortaMin: '', puntoRiordino: '', scortaMax: '' } : r;
        // stato e avvisi sotto il nome: la tabella resta stretta abbastanza da stare accanto all'elenco dei magazzini
        return '<tr data-art="' + h(a.id) + '">' +
          '<td class="as-nome"><b>' + h(a.nome) + '</b><div class="as-sotto"><span class="as-stato"></span><span class="as-segni"></span></div>' +
          '<div class="as-msg" hidden></div></td>' +
          '<td class="n as-giac"></td><td class="n as-consumo"><span class="as-media"></span><small class="as-copertura"></small></td>' +
          '<td class="n">' + campo('as-min', salvato.scortaMin, 'Scorta minima', a.nome) + '</td>' +
          '<td class="n">' + campo('as-rio', salvato.puntoRiordino, 'Punto di riordino', a.nome) + '</td>' +
          '<td class="n">' + campo('as-max', salvato.scortaMax, 'Scorta massima', a.nome) + '</td>' +
          '<td class="piccolo as-posto">' + (r.attivo !== false ? htmlPostoBreve(r) : '<span class="tenue">—</span>') + '</td>' +
          (puoAss ? '<td class="azioni"><button class="btn piccolo" type="button" data-togli="' + h(a.id) + '"></button></td>' : '') +
          '</tr>';
      }

      // parti della riga che dipendono dai valori scritti: si aggiornano senza ridisegnare la tabella (il fuoco resta dov'è)
      function aggiornaRiga(tr, scriviCampi) {
        var id = tr.getAttribute('data-art');
        var r = rigaBase(id);
        var a = App.articolo(id);
        var v = valori(r);
        var s = statoArticolo(id, rep.id, Object.assign({}, r, v));
        var m = media(id);
        var err = v.attivo ? erroreSoglie(v) : '';
        var nuovo = r.nuovo || r.attivo === false;
        tr.classList.toggle('as-modificata', !!bozza[id]);
        tr.classList.toggle('as-tolta', !v.attivo);
        tr.classList.toggle('as-errore', !!err);
        tr.querySelector('.as-segni').innerHTML = (nuovo && v.attivo ? '<span class="etichetta info">' + (r.nuovo ? 'nuovo' : 'rimesso') + '</span>' : '') +
          (!v.attivo ? '<span class="etichetta">da togliere</span>' : '');
        var msg = tr.querySelector('.as-msg');
        msg.textContent = err;
        msg.hidden = !err;
        tr.querySelector('.as-giac').innerHTML = h(App.fmtNum(s.giacenza)) + ' <span class="tenue">' + h(a ? a.unita || '' : '') + '</span>';
        tr.querySelector('.as-media').innerHTML = m > 0 ? h(App.fmtNum(Math.round(m * 100) / 100)) : '<span class="tenue">—</span>';
        var giorni = m > 0 ? Math.floor(s.giacenza / m) : null;
        tr.querySelector('.as-copertura').textContent = giorni === null ? '' : giorni === 1 ? 'copre 1 giorno' : 'copre ' + giorni + ' giorni';
        tr.querySelector('.as-stato').innerHTML = htmlStato(s);
        var b = tr.querySelector('[data-togli]');
        if (b) { b.textContent = v.attivo ? 'Togli' : 'Rimetti'; b.classList.toggle('pericolo', v.attivo); }
        if (scriviCampi) {
          var ins = tr.querySelectorAll('input.as-num');
          ins[0].value = App.fmtCampo(v.scortaMin);
          ins[1].value = App.fmtCampo(v.puntoRiordino);
          ins[2].value = App.fmtCampo(v.scortaMax);
        }
      }

      function disegnaTabella() {
        var t = filtroAss.testo.trim().toLowerCase();
        var righe = righeCorrenti().map(function (r) {
          var a = App.articolo(r.articoloId);
          return a ? { r: r, a: a } : null;
        }).filter(function (x) {
          if (!x) return false;
          if (t && x.a.nome.toLowerCase().indexOf(t) < 0) return false;
          if (filtroAss.cat && x.a.categoria !== filtroAss.cat) return false;
          if (filtroAss.solo && !bozza[x.a.id]) {
            var s = statoArticolo(x.a.id, rep.id, Object.assign({}, x.r, valori(x.r)));
            if (s.stato === 'ok') return false;
          }
          return true;
        }).sort(function (x, y) {
          return (x.a.categoria === y.a.categoria ? 0 : x.a.categoria === 'FARMACI' ? -1 : 1) || x.a.nome.localeCompare(y.a.nome, 'it');
        });
        var tab = p.querySelector('#as-tab');
        if (!righe.length) {
          tab.innerHTML = scheda('Assortimento di ' + h(rep.nome), vuoto(righeCorrenti().length ? 'Nessun articolo con questi filtri' : 'Assortimento vuoto',
            puoAss ? 'Aggiungi gli articoli che questo magazzino tiene, uno alla volta o con «Quelli usati negli ultimi 90 giorni».' : ''), '', true);
          aggiornaStato();
          return;
        }
        tab.innerHTML = scheda('Assortimento di ' + h(rep.nome),
          '<div class="tabella-contenitore as-contenitore"><table class="tabella as-tabella"><thead><tr>' +
          '<th>Articolo e stato</th><th class="n">Giacenza</th>' +
          '<th class="n" title="Consumo medio al giorno negli ultimi 90 giorni (consumi e perdite; per la farmacia centrale anche quello che manda agli altri magazzini) e giorni coperti dalla giacenza">Consumo al giorno</th>' +
          '<th class="n">Scorta minima</th><th class="n">Punto di riordino</th><th class="n">Scorta massima</th><th>Posto</th>' + (puoAss ? '<th><span class="st-sr">Azioni</span></th>' : '') +
          '</tr></thead><tbody>' + righe.map(function (x) { return htmlRiga(x.r, x.a); }).join('') + '</tbody></table></div>',
          '<span class="nota">' + quanti(righe.length, 'articolo', 'articoli') + '</span>', true);
        Array.prototype.forEach.call(tab.querySelectorAll('tr[data-art]'), function (tr) {
          aggiornaRiga(tr, !!bozza[tr.getAttribute('data-art')]);
        });
        aggiornaStato();
      }

      function aggiornaStato() {
        var s = p.querySelector('#as-stato');
        if (!s) return;
        var n = Object.keys(bozza).length;
        var errori = Object.keys(bozza).filter(function (id) { var v = valori(rigaBase(id)); return v.attivo && erroreSoglie(v); }).length;
        s.innerHTML = n ? '<b>' + n + '</b> ' + (n === 1 ? 'articolo modificato' : 'articoli modificati') + ', da salvare' + (errori ? ' · <span class="as-msg">' + errori + ' da correggere</span>' : '')
          : '<span class="tenue">Nessuna modifica da salvare</span>';
        p.querySelector('#as-salva').disabled = !n;
        p.querySelector('#as-annulla').disabled = !n;
        p.querySelector('#as-barra').classList.toggle('attiva', !!n);
        var dl = p.querySelector('#as-dl');
        if (dl) {
          var dentro = {};
          righeCorrenti().forEach(function (r) { dentro[r.articoloId] = true; });
          dl.innerHTML = App.articoliAttivi().filter(function (a) { return !dentro[a.id]; }).map(function (a) { return '<option value="' + h(a.nome) + '">'; }).join('');
        }
      }

      // aggiunge (o rimette) articoli all'assortimento nella bozza; restituisce quanti erano davvero fuori
      function aggiungi(ids) {
        var n = 0;
        ids.forEach(function (id) {
          var r = rigaAss(rep.id, id);
          var v = valori(rigaBase(id));
          if (v.attivo && (r || bozza[id])) return; // già dentro
          if (r && r.attivo !== false) cambiaBozza(id, { attivo: true }); // era segnato da togliere
          else bozza[id] = Object.assign({}, bozza[id] || {}, { attivo: true }); // nuovo, o tolto in passato
          n++;
        });
        medie = null;
        disegnaTabella();
        return n;
      }

      p.querySelector('#as-cerca').addEventListener('input', function () { filtroAss.testo = this.value; disegnaTabella(); });
      p.querySelector('#as-cat').addEventListener('change', function () { filtroAss.cat = this.value; disegnaTabella(); });
      p.querySelector('#as-solo').addEventListener('change', function () { filtroAss.solo = this.checked; disegnaTabella(); });

      if (puoAss) {
        var tab = p.querySelector('#as-tab');
        tab.addEventListener('change', function (e) {
          var i = e.target.closest('input.as-num');
          if (!i) return;
          var tr = i.closest('tr');
          var nomeCampo = i.classList.contains('as-min') ? 'scortaMin' : i.classList.contains('as-rio') ? 'puntoRiordino' : 'scortaMax';
          var c = {};
          c[nomeCampo] = Math.max(0, App.numero(i.value));
          cambiaBozza(tr.getAttribute('data-art'), c);
          aggiornaRiga(tr, false);
          aggiornaStato();
        });
        tab.addEventListener('keydown', function (e) {
          var i = e.target.closest('input.as-num');
          if (!i || e.key !== 'Enter') return;
          // Invio: conferma la casella e scende alla riga sotto, come nei consumi
          e.preventDefault();
          var tr = i.closest('tr');
          var col = Array.prototype.indexOf.call(tr.querySelectorAll('input.as-num'), i);
          i.dispatchEvent(new Event('change', { bubbles: true }));
          var sotto = tr.nextElementSibling;
          var dest = sotto ? sotto.querySelectorAll('input.as-num')[col] : null;
          if (dest) { dest.focus(); dest.select(); }
        });
        tab.addEventListener('click', function (e) {
          var b = e.target.closest('[data-togli]');
          if (!b) return;
          var id = b.getAttribute('data-togli');
          var r = rigaAss(rep.id, id);
          var tr = b.closest('tr');
          if (!r || r.attivo === false) {
            // articolo aggiunto qui e non ancora salvato: sparisce dall'elenco
            delete bozza[id];
            tr.remove();
          } else {
            cambiaBozza(id, { attivo: !valori(r).attivo });
            aggiornaRiga(tr, true);
          }
          aggiornaStato();
        });
        p.querySelector('#as-agg').addEventListener('click', function () {
          var inp = p.querySelector('#as-nuovo');
          var a = App.articoloPerNome(inp.value);
          if (!a) { App.avviso('Scegli un articolo dall’elenco.', 'errore'); return; }
          if (!aggiungi([a.id])) { App.avviso(a.nome + ' è già nell’assortimento.', 'errore'); return; }
          inp.value = '';
          App.avviso(a.nome + ' aggiunto: scrivi le scorte e salva', 'ok');
          var tr = p.querySelector('tr[data-art="' + cssId(a.id) + '"]');
          if (tr) { tr.scrollIntoView({ block: 'nearest' }); if (root.Motion) root.Motion.evidenzia(tr); }
        });
        p.querySelector('#as-nuovo').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); p.querySelector('#as-agg').click(); } });
        p.querySelector('#as-usati').addEventListener('click', function () {
          var d = new Date();
          d.setDate(d.getDate() - GIORNI_CONSUMO);
          var dal = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          var usati = {};
          App.S.movimenti.forEach(function (m) {
            if (m.annullato || m.data < dal) return;
            if (m.repartoId === rep.id || m.repartoDestId === rep.id) usati[m.articoloId] = true;
          });
          var ids = Object.keys(usati).filter(function (id) { var a = App.articolo(id); return a && a.attivo !== false; });
          var n = aggiungi(ids);
          App.avviso(n ? quanti(n, 'articolo aggiunto', 'articoli aggiunti') + ': controlla le scorte (anche con «Proponi dai consumi») e salva' : 'Nessun articolo nuovo da aggiungere.', n ? 'ok' : 'errore');
        });
        p.querySelector('#as-proponi').addEventListener('click', proponi);
        p.querySelector('#as-annulla').addEventListener('click', function () {
          App.conferma('Annulla le modifiche', 'Torno alle scorte salvate? Le modifiche scritte qui si perdono.', 'Annulla le modifiche', true).then(function (ok) {
            if (!ok) return;
            bozzeAssortimento[rep.id] = bozza = {};
            disegnaTabella();
          });
        });
        p.querySelector('#as-salva').addEventListener('click', salva);
      }

      function proponi() {
        var righe = righeCorrenti().filter(function (r) { return valori(r).attivo; });
        if (!righe.length) { App.avviso('L’assortimento è vuoto: prima aggiungi gli articoli.', 'errore'); return; }
        var ids = righe.map(function (r) { return r.articoloId; });
        medie = consumiMedi(rep.id, ids);
        var conConsumi = ids.filter(function (id) { return medie[id] > 0; });
        if (!conConsumi.length) { App.avviso('Negli ultimi 90 giorni questo magazzino non ha consumi registrati: non posso proporre le scorte.', 'errore'); return; }
        App.apriModale({
          titolo: 'Proponi le scorte dai consumi',
          corpo: '<p>Per ogni articolo con consumi negli ultimi 90 giorni in <b>' + h(rep.nome) + '</b> propongo:</p>' +
            '<ul class="as-regole"><li><b>scorta minima</b> ≈ ' + PROPOSTA.min + ' giorni di consumo medio</li><li><b>punto di riordino</b> ≈ ' + PROPOSTA.riordino + ' giorni</li>' +
            '<li><b>scorta massima</b> ≈ ' + PROPOSTA.max + ' giorni</li></ul>' +
            '<p class="piccolo tenue">' + quanti(conConsumi.length, 'articolo', 'articoli') + ' su ' + ids.length + (conConsumi.length === 1 ? ' ha' : ' hanno') + ' consumi. Le proposte entrano nella tabella: controllale e poi premi «Salva assortimento».</p>' +
            '<div class="modulo"><label class="spunta largo"><input type="radio" name="as-quali" value="vuote" checked> Solo gli articoli senza scorte indicate</label>' +
            '<label class="spunta largo"><input type="radio" name="as-quali" value="tutte"> Tutti gli articoli con consumi (sostituisce le scorte attuali)</label></div>',
          piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="as-proponi-ok">Proponi</button>',
          dopo: function (m) {
            m.querySelector('#as-proponi-ok').addEventListener('click', function () {
              var tutte = m.querySelector('input[name="as-quali"]:checked').value === 'tutte';
              var n = 0;
              righe.forEach(function (r) {
                var med = medie[r.articoloId];
                if (!(med > 0)) return;
                var v = valori(r);
                if (!tutte && (v.scortaMin > 0 || v.puntoRiordino > 0 || v.scortaMax > 0)) return;
                cambiaBozza(r.articoloId, {
                  scortaMin: Math.ceil(med * PROPOSTA.min),
                  puntoRiordino: Math.ceil(med * PROPOSTA.riordino),
                  scortaMax: Math.ceil(med * PROPOSTA.max)
                });
                n++;
              });
              App.chiudiModale();
              disegnaTabella();
              App.avviso(n ? 'Proposta inserita per ' + quanti(n, 'articolo', 'articoli') + ': controlla e premi «Salva assortimento»' : 'Nessun articolo da proporre (hanno già le scorte).', n ? 'ok' : 'errore');
              if (n && root.Motion) root.Motion.evidenzia(p.querySelectorAll('tr.as-modificata input.as-num'));
            });
          }
        });
      }

      function salva() {
        var ids = Object.keys(bozza);
        if (!ids.length) return;
        var errori = [];
        var righe = ids.map(function (id) {
          var v = valori(rigaBase(id));
          var e = v.attivo ? erroreSoglie(v) : '';
          var a = App.articolo(id);
          if (e) errori.push((a ? a.nome : id) + ': ' + e);
          return { articoloId: id, scortaMin: v.scortaMin, puntoRiordino: v.puntoRiordino, scortaMax: v.scortaMax, attivo: v.attivo };
        });
        if (errori.length) { App.avviso(errori[0] + (errori.length > 1 ? ' (e altri ' + (errori.length - 1) + ')' : ''), 'errore'); return; }
        var b = p.querySelector('#as-salva');
        b.disabled = true;
        Api().scrivi('PUT', '/api/assortimento', { repartoId: rep.id, righe: righe }).then(function (r) {
          bozzeAssortimento[rep.id] = bozza = {};
          var parti = [];
          if (r.nuove) parti.push(r.nuove + ' aggiunti');
          if (r.modificate) parti.push(r.modificate + ' modificati');
          if (r.tolte) parti.push(r.tolte + ' tolti');
          App.avviso('Assortimento salvato' + (parti.length ? ': ' + parti.join(', ') : ''), 'ok');
          if (cont.isConnected) { disegnaLista(); medie = null; disegnaTabella(); }
        }, function (e) {
          b.disabled = false;
          App.avviso('Assortimento non salvato: ' + messaggioErrore(e), 'errore');
        });
      }

      disegnaTabella();
    }

    /* ---------- eventi della pagina ---------- */

    cont.querySelector('#mg-lista').addEventListener('click', function (e) {
      var b = e.target.closest('[data-rep]');
      if (!b) return;
      memMagazzini.rep = b.getAttribute('data-rep');
      Array.prototype.forEach.call(cont.querySelectorAll('#mg-lista [data-rep]'), function (x) {
        var on = x.getAttribute('data-rep') === memMagazzini.rep;
        x.classList.toggle('scelto', on);
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      disegnaDettaglio();
      // sul telefono il dettaglio è sotto l'elenco
      if (root.matchMedia && root.matchMedia('(max-width: 900px)').matches) {
        cont.querySelector('#mg-dettaglio').scrollIntoView({ block: 'start', behavior: ridotto() ? 'auto' : 'smooth' });
      }
    });
    cont.querySelector('#mg-anche').addEventListener('change', function () { memMagazzini.anche = this.checked; disegnaLista(); });
    var bn = cont.querySelector('#mg-nuovo');
    if (bn) bn.addEventListener('click', nuovoMagazzino);

    disegnaLista();
    disegnaDettaglio();
  };
})(window);
