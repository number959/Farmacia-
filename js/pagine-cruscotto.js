/*
 * Pagina "Oggi": cruscotto per ruolo (sostituisce P.oggi di js/pagine.js).
 *   - saluto, magazzino da guardare (tutta la struttura o uno solo), azioni rapide (.azioni-rapide, giro "benvenuto");
 *   - indicatori (.indicatori, giro "benvenuto" e videoguida: il 2° è "sotto scorta", il 3° "lotti scaduti") con
 *     i numeri che scorrono: valore del magazzino, sotto scorta rispetto all'assortimento, lotti scaduti e in scadenza
 *     a 30/90 giorni, richieste, DDT, consumi di oggi;
 *   - grafici (Apache ECharts attraverso js/grafici.js): consumi degli ultimi 30 giorni, articoli più usati,
 *     movimenti per tipo;
 *   - "Cosa fare adesso": i lavori in sospeso con il collegamento alla pagina giusta;
 *   - "Da controllare" e "Movimenti di oggi".
 * Si aggiorna sul posto quando altri utenti registrano (App.rinfresca): i numeri scorrono dal valore di prima,
 * i grafici passano ai dati nuovi con una transizione, il fuoco resta dov'era.
 * Versione 3.0 – parte F (docs/NOVITA-3.0.md).
 */
(function (root) {
  'use strict';
  var App = root.App;
  var C = root.Calcoli;
  var h = App.h;

  var GIORNI = 30;                       // finestra dei grafici
  var SETTIMANA = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];

  // scelte che restano finché l'utente non cambia: magazzino guardato e misura del grafico dei consumi
  var scelte = { utente: null, vista: '', metrica: 'unita' };
  // ultimi numeri mostrati (i numeri scorrono da qui al valore nuovo) e dati del disegno attuale
  var ultimi = {};
  var dati = null;

  function S(nome) { return (App.S && App.S[nome]) || []; }
  function grafici() { return root.Grafici && root.echarts ? root.Grafici : null; }
  function ridotto() { return !root.Motion || root.Motion.ridotto(); }

  /* ---------- date ---------- */

  function aData(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function giorniIndietro(n) {
    var p = App.oggi().split('-').map(Number);
    var out = [];
    for (var i = n - 1; i >= 0; i--) out.push(aData(new Date(p[0], p[1] - 1, p[2] - i)));
    return out;
  }
  function giornoDellaSettimana(s) {
    var p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).getDay();
  }
  function giorniFa(s) {
    if (!s) return null;
    var p = s.split('-').map(Number);
    var q = App.oggi().split('-').map(Number);
    return Math.round((new Date(q[0], q[1] - 1, q[2]) - new Date(p[0], p[1] - 1, p[2])) / 86400000);
  }

  /* ---------- numeri ---------- */

  function euro(v, decimali) {
    return (Number(v) || 0).toLocaleString('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: decimali || 0, maximumFractionDigits: decimali || 0 });
  }
  function intero(v) { return Math.round(Number(v) || 0).toLocaleString('it-IT'); }
  function compatto(v) {
    var n = Number(v) || 0;
    if (Math.abs(n) >= 1000000) return (n / 1000000).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' mln';
    if (Math.abs(n) >= 10000) return (n / 1000).toLocaleString('it-IT', { maximumFractionDigits: 0 }) + 'k';
    if (Math.abs(n) >= 1000) return (n / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + 'k';
    return App.fmtNum(Math.round(n * 10) / 10);
  }
  function plurale(n, uno, tanti) { return n === 1 ? uno : tanti; }

  /* ---------- magazzini guardati ---------- */

  // magazzini che l'utente vede nel cruscotto: i suoi (responsabile di magazzino) o tutti
  function magazziniVisibili() {
    var r = App.permessi && App.permessi.reparti;
    return App.repartiAttivi().filter(function (x) { return !r || r.indexOf(x.id) >= 0; });
  }

  function vistaValida() {
    if (scelte.utente !== (App.utente && App.utente.id)) { scelte.utente = App.utente && App.utente.id; scelte.vista = ''; ultimi = {}; }
    if (scelte.vista && !magazziniVisibili().some(function (r) { return r.id === scelte.vista; })) scelte.vista = '';
    return scelte.vista;
  }

  /* ---------- calcoli ---------- */

  function calcola() {
    var vista = vistaValida();
    var visibili = magazziniVisibili();
    var ids = vista ? [vista] : visibili.map(function (r) { return r.id; });
    var inVista = {};
    ids.forEach(function (id) { inVista[id] = true; });
    var tutti = !vista && !(App.permessi && App.permessi.reparti);
    var oggi = App.oggi();
    var transito = App.magazzinoTransito();
    var idTransito = transito ? transito.id : 'r-transito';
    var soglia = Number(App.S.impostazioni.giorniAvvisoScadenza) || 90;

    var articoli = {};
    App.S.articoli.forEach(function (a) { articoli[a.id] = a; });
    function prezzo(id) { var a = articoli[id]; return a ? Number(a.prezzo) || 0 : 0; }

    var d = {
      vista: vista, ids: ids, tutti: tutti, oggi: oggi, soglia: soglia,
      valore: 0, valoreViaggio: 0, articoliInGiacenza: 0, perMagazzino: {},
      sotto: [], riordino: [], scaduti: [], entro30: [], entroSoglia: [], valoreScaduti: 0,
      ric: { evadere: 0, urgenti: 0, bozze: 0, attesa: 0, aperte: 0 },
      ddt: { preparare: 0, ricevere: 0, viaggio: 0 },
      oggiUnita: 0, oggiRighe: 0, oggiValore: 0, ieriUnita: 0,
      giorni: giorniIndietro(GIORNI), serieUnita: [], serieValore: [],
      top: [], tipi: {}, totaleTipi: 0, ultimoInventario: null, movimentiOggi: []
    };

    // giacenze: valore del magazzino e lotti (solo i magazzini guardati; la merce in viaggio a parte)
    var g = App.giacenze();
    var lottiDi = App.lottiPerCoppia ? App.lottiPerCoppia() : null;
    var conGiacenza = {};
    Object.keys(g).forEach(function (k) {
      var q = g[k];
      if (!(q > 0)) return;
      var i = k.indexOf('|');
      var art = k.slice(0, i), rep = k.slice(i + 1);
      if (rep === idTransito || !inVista[rep]) return;
      var v = q * prezzo(art);
      d.valore += v;
      d.perMagazzino[rep] = (d.perMagazzino[rep] || 0) + v;
      conGiacenza[art] = true;
      var a = articoli[art];
      if (!a) return;
      (lottiDi ? lottiDi[k] || [] : C.lotti(App.S, art, rep)).forEach(function (l) {
        if (!(l.quantita > 0) || !l.scadenza) return;
        var giorni = C.giorniAllaScadenza(l.scadenza, oggi);
        if (giorni === null || giorni > soglia) return;
        var voce = { articolo: a, repartoId: rep, lotto: l.lotto, scadenza: l.scadenza, quantita: l.quantita, giorni: giorni };
        if (giorni < 0) { d.scaduti.push(voce); d.valoreScaduti += l.quantita * prezzo(art); }
        else if (giorni <= 30) d.entro30.push(voce);
        else d.entroSoglia.push(voce);
      });
    });
    d.articoliInGiacenza = Object.keys(conGiacenza).length;
    var viaggio = C.merceInViaggio ? C.merceInViaggio(App.S) : {};
    Object.keys(viaggio).forEach(function (k) {
      var i = k.indexOf('|');
      if (tutti || inVista[k.slice(i + 1)]) d.valoreViaggio += viaggio[k] * prezzo(k.slice(0, i));
    });

    // scorte: soglie dell'assortimento di ogni magazzino; nella farmacia centrale anche la scorta minima dell'anagrafica
    var coperti = {};
    S('assortimento').forEach(function (r) {
      if (r.attivo === false || !inVista[r.repartoId]) return;
      var a = articoli[r.articoloId];
      if (!a || a.attivo === false) return;
      var min = Number(r.scortaMin) || 0;
      var rio = Number(r.puntoRiordino) || 0;
      if (min > 0 || rio > 0) coperti[r.articoloId + '|' + r.repartoId] = true;
      var q = App.giacenza(r.articoloId, r.repartoId);
      if (min > 0 && q < min) d.sotto.push({ articolo: a, repartoId: r.repartoId, giacenza: q, soglia: min });
      else if (rio > 0 && q <= rio) d.riordino.push({ articolo: a, repartoId: r.repartoId, giacenza: q, soglia: rio });
    });
    var centrale = App.repartoCentrale();
    if (centrale && inVista[centrale.id]) {
      App.S.articoli.forEach(function (a) {
        if (a.attivo === false || !a.scortaMinima || coperti[a.id + '|' + centrale.id]) return;
        var q = App.giacenza(a.id, centrale.id);
        if (q < a.scortaMinima) d.sotto.push({ articolo: a, repartoId: centrale.id, giacenza: q, soglia: a.scortaMinima });
      });
    }
    d.sotto.sort(function (x, y) { return (x.giacenza / (x.soglia || 1)) - (y.giacenza / (y.soglia || 1)); });

    // richieste
    var evadi = App.puo('evadiRichieste');
    var chiede = App.puo('richieste');
    S('richieste').forEach(function (r) {
      var mia = inVista[r.repartoId] || inVista[r.fornitoreId] || (!vista && tutti);
      if (!mia) return;
      var aperta = r.stato === 'inviata' || r.stato === 'in_lavorazione';
      if (aperta) d.ric.aperte++;
      if (evadi && aperta && App.repartoPermesso(r.fornitoreId)) { d.ric.evadere++; if (r.urgente) d.ric.urgenti++; }
      if (chiede && r.stato === 'bozza' && App.repartoPermesso(r.repartoId)) d.ric.bozze++;
      if (chiede && aperta && App.repartoPermesso(r.repartoId) && !(evadi && App.repartoPermesso(r.fornitoreId))) d.ric.attesa++;
    });

    // DDT: da spedire dai miei magazzini, in arrivo nei miei, in viaggio
    var miei = (App.permessi && App.permessi.reparti) ? App.permessi.reparti : (centrale ? [centrale.id] : []);
    S('ddt').forEach(function (x) {
      var mio = inVista[x.origineId] || inVista[x.destinazioneId] || (!vista && tutti);
      if (!mio) return;
      if (x.stato === 'in_transito') d.ddt.viaggio++;
      if (x.stato === 'in_preparazione' && App.puo('ddt') && App.repartoPermesso(x.origineId) && (!vista || x.origineId === vista)) d.ddt.preparare++;
      if (x.stato === 'in_transito' && App.puo('riceviDdt') && (vista ? x.destinazioneId === vista && App.repartoPermesso(vista) : miei.indexOf(x.destinazioneId) >= 0)) d.ddt.ricevere++;
    });

    // movimenti: una sola passata per consumi, articoli più usati, tipi, inventario e movimenti di oggi
    var primo = d.giorni[0];
    var ieri = d.giorni[d.giorni.length - 2];
    var indice = {};
    d.giorni.forEach(function (x, i) { indice[x] = i; d.serieUnita.push(0); d.serieValore.push(0); });
    var perArticolo = {};
    App.S.movimenti.forEach(function (m) {
      if (m.annullato) return;
      var qui = inVista[m.repartoId] || (m.repartoDestId && inVista[m.repartoDestId]);
      if (!qui) return;
      if (m.tipo === 'rettifica' && inVista[m.repartoId] && (!d.ultimoInventario || m.data > d.ultimoInventario)) d.ultimoInventario = m.data;
      if (m.data === oggi) d.movimentiOggi.push(m);
      if (m.data < primo || m.data > oggi) return;
      d.tipi[m.tipo] = (d.tipi[m.tipo] || 0) + 1;
      d.totaleTipi++;
      if (m.tipo !== 'consumo' || !inVista[m.repartoId]) return;
      var q = Number(m.quantita) || 0;
      var v = q * (m.prezzo ? Number(m.prezzo) : prezzo(m.articoloId));
      var i = indice[m.data];
      if (i !== undefined) { d.serieUnita[i] += q; d.serieValore[i] += v; }
      var pa = perArticolo[m.articoloId] || (perArticolo[m.articoloId] = { id: m.articoloId, unita: 0, valore: 0, volte: 0 });
      pa.unita += q; pa.valore += v; pa.volte++;
      if (m.data === oggi) { d.oggiUnita += q; d.oggiRighe++; d.oggiValore += v; }
      if (m.data === ieri) d.ieriUnita += q;
    });
    d.serieUnita = d.serieUnita.map(function (x) { return Math.round(x * 1000) / 1000; });
    d.serieValore = d.serieValore.map(function (x) { return Math.round(x * 100) / 100; });
    d.top = Object.keys(perArticolo).map(function (k) { return perArticolo[k]; })
      .sort(function (x, y) { return y.unita - x.unita; }).slice(0, 8)
      .map(function (x) { var a = articoli[x.id]; x.nome = a ? a.nome : '(articolo eliminato)'; x.unitaMisura = a ? a.unita || '' : ''; return x; });
    d.movimentiOggi.sort(function (x, y) { return (y.creato || 0) - (x.creato || 0); });
    return d;
  }

  /* ---------- pezzi di pagina ---------- */

  function saluto() {
    var ora = new Date().getHours();
    var u = App.utente || {};
    var nome = String(u.nome || u.username || '').trim().split(/\s+/)[0];
    return (ora < 5 ? 'Buonasera' : ora < 13 ? 'Buongiorno' : ora < 18 ? 'Buon pomeriggio' : 'Buonasera') + (nome ? ', ' + nome : '');
  }

  function descrizioneVista(d) {
    if (d.vista) return App.nomeReparto(d.vista);
    if (d.tutti) return 'tutta la struttura';
    var v = magazziniVisibili();
    return v.length === 1 ? v[0].nome : 'i tuoi magazzini (' + v.length + ')';
  }

  function ora() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function htmlTesta(d) {
    var visibili = magazziniVisibili();
    var u = App.utente || {};
    var scelta = visibili.length > 1
      ? '<label class="campo cr-vista"><span>Magazzino</span><select id="cr-vista">' +
        '<option value="">' + (App.permessi && App.permessi.reparti ? 'Tutti i miei magazzini' : 'Tutta la struttura') + '</option>' +
        visibili.map(function (r) { return '<option value="' + h(r.id) + '"' + (r.id === d.vista ? ' selected' : '') + '>' + h(r.nome) + '</option>'; }).join('') +
        '</select></label>'
      : '';
    return '<section class="cr-testa" aria-label="Riepilogo">' +
      '<div class="cr-saluto"><h2 id="cr-saluto">' + h(saluto()) + '</h2>' +
      '<p><span>' + h(App.nomeRuolo(u.ruolo)) + '</span> · <span id="cr-dove">' + h(descrizioneVista(d)) + '</span>' +
      ' · <span class="cr-vivo" id="cr-ora" title="Si aggiorna da solo quando qualcuno registra">aggiornato alle ' + ora() + '</span></p></div>' +
      scelta + '</section>';
  }

  function htmlAzioniRapide() {
    var ordine = App.puo('evadiRichieste')
      ? [['carico', '📥 Nuovo carico'], ['richieste', '📝 Richieste da evadere'], ['consegne', '🚚 DDT e consegne'], ['trasferimenti', '🔁 Trasferisci con un DDT'], ['consumi', '💊 Registra i consumi'], ['registro', '📅 Nota consumi del mese']]
      : [['consumi', '💊 Registra i consumi'], ['richieste', '📝 Richiedi alla farmacia'], ['consegne', '🚚 Ricevi un DDT'], ['perdite', '🗑️ Perdite e scaduti'], ['registro', '📅 Nota consumi del mese']];
    var voci = ordine.filter(function (v) { return App.paginaPermessa(v[0]); }).slice(0, 5);
    if (!voci.length) return '';
    var tasti = {};
    App.MENU.forEach(function (v) { if (v.id) tasti[v.id] = v.tasto; });
    return '<div class="azioni-rapide cr-azioni">' + voci.map(function (v, i) {
      return '<a class="btn' + (i === 0 ? ' primario' : '') + '" href="#' + v[0] + '">' + h(v[1]) + '<kbd>' + h(tasti[v[0]] || '') + '</kbd></a>';
    }).join('') + '</div>';
  }

  /* Un indicatore: { id, titolo, valore, formato, nota (html), classe, pagina, attr, ico, largo, extra (html) } */
  function htmlIndicatore(x) {
    var link = x.pagina && App.paginaPermessa(x.pagina);
    var tag = link ? 'a' : 'div';
    return '<' + tag + ' class="indicatore cr-ind' + (x.classe ? ' ' + x.classe : '') + (x.largo ? ' cr-largo' : '') + '" id="cr-i-' + x.id + '"' +
      (link ? ' href="#' + x.pagina + '"' : '') + (x.attr || '') + '>' +
      '<span class="cr-ico" aria-hidden="true">' + x.ico + '</span>' +
      '<span class="titolo">' + h(x.titolo) + '</span>' +
      '<span class="valore" data-valore="' + x.valore + '">' + x.formato(ultimi[x.id] !== undefined && !ridotto() ? ultimi[x.id] : x.valore) + '</span>' +
      '<span class="piccolo tenue cr-nota">' + (x.nota || '') + '</span>' + (x.extra || '') + '</' + tag + '>';
  }

  function indicatori(d) {
    var lista = [];
    var nomiMag = App.S.reparti;
    // 1. valore del magazzino, con la ripartizione fra i magazzini
    var quote = Object.keys(d.perMagazzino).map(function (k) { return { id: k, v: d.perMagazzino[k] }; })
      .filter(function (x) { return x.v > 0; }).sort(function (a, b) { return b.v - a.v; });
    var colori = ['var(--grafico-1)', 'var(--grafico-5)', 'var(--grafico-7)', 'var(--grafico-6)', 'var(--grafico-4)', 'var(--grafico-8)'];
    var mostrate = quote.slice(0, 5);
    var resto = quote.slice(5).reduce(function (s, x) { return s + x.v; }, 0);
    if (resto > 0) mostrate.push({ id: '', v: resto });
    var barra = quote.length > 1
      ? '<span class="cr-quota" aria-hidden="true">' + mostrate.map(function (x, i) {
        return '<span style="flex-grow:' + (x.v / d.valore * 1000).toFixed(0) + ';background:' + colori[i % colori.length] + '"></span>';
      }).join('') + '</span><span class="cr-legenda">' + mostrate.map(function (x, i) {
        var nome = x.id ? (nomiMag.filter(function (r) { return r.id === x.id; })[0] || {}).nome || x.id : 'altri';
        return '<span><i style="background:' + colori[i % colori.length] + '"></i>' + h(nome) + ' <b>' + Math.round(x.v / d.valore * 100) + '%</b></span>';
      }).join('') + '</span>'
      : '';
    lista.push({
      id: 'valore', titolo: 'Valore del magazzino', valore: Math.round(d.valore), formato: function (v) { return euro(v); },
      nota: intero(d.articoliInGiacenza) + ' ' + plurale(d.articoliInGiacenza, 'articolo', 'articoli') + ' in giacenza' +
        (d.valoreViaggio > 0 ? ' · ' + euro(d.valoreViaggio) + ' in viaggio' : '') + ' · ai prezzi dell’anagrafica',
      pagina: 'giacenze', ico: '€', largo: true, extra: barra
    });
    // 2. sotto scorta (stesso posto e stesso comportamento della 2.x: apre Giacenze con "Solo sotto scorta")
    lista.push({
      id: 'sotto', titolo: 'Sotto scorta minima', valore: d.sotto.length, formato: intero, classe: d.sotto.length ? 'pericolo' : 'ok',
      nota: d.riordino.length ? d.riordino.length + ' ' + plurale(d.riordino.length, 'altro al punto di riordino', 'altri al punto di riordino') : 'rispetto all’assortimento dei magazzini',
      pagina: 'giacenze', attr: ' data-sotto', ico: '📉'
    });
    // 3. lotti scaduti
    lista.push({
      id: 'scaduti', titolo: 'Lotti scaduti in giacenza', valore: d.scaduti.length, formato: intero, classe: d.scaduti.length ? 'pericolo' : 'ok',
      nota: d.scaduti.length ? 'da togliere: ' + euro(d.valoreScaduti) : 'nessun lotto da togliere',
      pagina: 'scadenze', ico: '⛔'
    });
    // 4. in scadenza: 30 giorni e soglia delle impostazioni (90)
    var n30 = d.entro30.length, nS = d.entroSoglia.length;
    lista.push({
      id: 'scadenza', titolo: 'In scadenza entro 30 giorni', valore: n30, formato: intero, classe: n30 ? 'attenzione' : 'ok',
      nota: nS + ' ' + plurale(nS, 'altro', 'altri') + ' entro ' + d.soglia + ' giorni',
      pagina: 'scadenze', ico: '⏳',
      extra: (n30 + nS) ? '<span class="cr-quota" aria-hidden="true"><span style="flex-grow:' + n30 + ';background:var(--attenzione)"></span>' +
        '<span style="flex-grow:' + nS + ';background:color-mix(in srgb, var(--attenzione) 35%, var(--linea))"></span></span>' : ''
    });
    // 5. richieste
    var ric;
    if (App.puo('evadiRichieste')) {
      ric = { titolo: 'Richieste da evadere', valore: d.ric.evadere, nota: d.ric.urgenti ? '<b class="cr-urgente">' + d.ric.urgenti + ' ' + plurale(d.ric.urgenti, 'urgente', 'urgenti') + '</b>' : 'dai magazzini periferici', classe: d.ric.urgenti ? 'pericolo' : d.ric.evadere ? 'attenzione' : '' };
    } else if (App.puo('richieste')) {
      ric = { titolo: 'Richieste in attesa', valore: d.ric.attesa, nota: d.ric.bozze ? d.ric.bozze + ' ' + plurale(d.ric.bozze, 'bozza da inviare', 'bozze da inviare') : 'inviate alla farmacia centrale', classe: d.ric.bozze ? 'attenzione' : '' };
    } else {
      ric = { titolo: 'Richieste aperte', valore: d.ric.aperte, nota: 'inviate e non ancora evase', classe: '' };
    }
    lista.push({ id: 'richieste', titolo: ric.titolo, valore: ric.valore, formato: intero, classe: ric.classe, nota: ric.nota, pagina: 'richieste', ico: '📝' });
    // 6. DDT
    var ddtNota = [];
    if (d.ddt.ricevere) ddtNota.push('<b>' + d.ddt.ricevere + ' da ricevere</b>');
    if (d.ddt.preparare) ddtNota.push(d.ddt.preparare + ' in preparazione');
    lista.push({
      id: 'ddt', titolo: 'DDT in viaggio', valore: d.ddt.viaggio, formato: intero, classe: d.ddt.ricevere ? 'attenzione' : '',
      nota: ddtNota.join(' · ') || 'merce partita e non ancora arrivata', pagina: 'consegne', ico: '🚚'
    });
    // 7. consumi di oggi, con l'andamento delle ultime due settimane
    var diff = d.oggiUnita - d.ieriUnita;
    lista.push({
      id: 'consumi', titolo: 'Consumi di oggi', valore: Math.round(d.oggiUnita * 10) / 10, formato: function (v) { return App.fmtNum(Math.round(v * 10) / 10); },
      nota: d.oggiRighe + ' ' + plurale(d.oggiRighe, 'registrazione', 'registrazioni') + ' · ieri ' + App.fmtNum(d.ieriUnita) +
        (d.ieriUnita || d.oggiUnita ? ' <span class="cr-delta ' + (diff > 0 ? 'su' : diff < 0 ? 'giu' : '') + '">' + (diff > 0 ? '▲' : diff < 0 ? '▼' : '=') + '</span>' : ''),
      pagina: App.paginaPermessa('consumi') ? 'consumi' : 'movimenti', ico: '💊',
      extra: '<span class="cr-spark" id="cr-spark-consumi"></span>'
    });
    return lista;
  }

  /* "Cosa fare adesso": [{ p (priorità 1-3), ico, titolo, dettaglio, pagina, par }] */
  function daFare(d) {
    var out = [];
    function voce(p, ico, titolo, dettaglio, pagina, par) {
      if (!App.paginaPermessa(pagina)) return;
      out.push({ p: p, ico: ico, titolo: titolo, dettaglio: dettaglio, pagina: pagina, par: par || null });
    }
    if (d.ric.evadere) {
      voce(d.ric.urgenti ? 3 : 2, '📝', d.ric.evadere + ' ' + plurale(d.ric.evadere, 'richiesta da evadere', 'richieste da evadere'),
        d.ric.urgenti ? d.ric.urgenti + ' ' + plurale(d.ric.urgenti, 'è urgente', 'sono urgenti') + ': preparale per prime' : 'Approva le quantità e prepara il DDT', 'richieste');
    }
    if (d.ddt.ricevere) voce(3, '🚚', d.ddt.ricevere + ' DDT ' + plurale(d.ddt.ricevere, 'in arrivo', 'in arrivo') + ' da ricevere', 'Controlla la merce e conferma la ricezione', 'consegne');
    if (d.ddt.preparare) voce(2, '📦', d.ddt.preparare + ' DDT in preparazione', 'Completa le righe e spediscili con il trasportatore', 'consegne');
    if (d.ric.bozze) voce(2, '✉️', d.ric.bozze + ' ' + plurale(d.ric.bozze, 'richiesta in bozza', 'richieste in bozza'), 'Inviala alla farmacia centrale', 'richieste');
    if (d.scaduti.length) voce(3, '⛔', d.scaduti.length + ' ' + plurale(d.scaduti.length, 'lotto scaduto', 'lotti scaduti') + ' da togliere', 'Toglili dagli armadi e registra la perdita', 'scadenze');
    if (d.entro30.length) voce(2, '⏳', d.entro30.length + ' ' + plurale(d.entro30.length, 'lotto scade', 'lotti scadono') + ' entro 30 giorni', 'Usali per primi o chiedi un reso', 'scadenze');
    if (d.sotto.length) {
      if (App.puo('richieste') && !App.puo('evadiRichieste')) voce(2, '📉', d.sotto.length + ' ' + plurale(d.sotto.length, 'articolo sotto scorta', 'articoli sotto scorta'), 'Prepara una richiesta alla farmacia centrale', 'richieste', { nuova: true });
      else voce(2, '📉', d.sotto.length + ' ' + plurale(d.sotto.length, 'articolo sotto scorta', 'articoli sotto scorta'), App.puo('ordini') ? 'Guarda la proposta d’ordine in Previsioni' : 'Guarda le giacenze', App.puo('ordini') && App.paginaPermessa('previsioni') ? 'previsioni' : 'giacenze', App.puo('ordini') ? null : { soloSotto: true });
    }
    if (d.riordino.length && App.paginaPermessa('magazzini')) voce(1, '🔁', d.riordino.length + ' ' + plurale(d.riordino.length, 'articolo al punto di riordino', 'articoli al punto di riordino'), 'Controlla le scorte dell’assortimento', 'magazzini');
    if (App.puo('rettifica')) {
      var fa = giorniFa(d.ultimoInventario);
      if (fa === null) voce(1, '✅', 'Nessun inventario registrato', 'Conta la merce sugli scaffali e correggi le giacenze', 'inventario');
      else if (fa > 30) voce(1, '✅', 'Ultimo inventario ' + fa + ' giorni fa', 'Un controllo al mese tiene giuste le giacenze', 'inventario');
    }
    if (App.puo('consumo') && !d.oggiRighe && new Date().getHours() >= 12 && App.repartiScrivibili().length) {
      voce(1, '💊', 'Nessun consumo registrato oggi', 'Registra i consumi della giornata', 'consumi');
    }
    return out.sort(function (a, b) { return b.p - a.p; }).slice(0, 7);
  }

  function htmlDaFare(d) {
    var voci = daFare(d);
    if (!voci.length) {
      return '<div class="cr-tutto-ok"><span class="cr-spunta" aria-hidden="true">✓</span><b>Tutto in ordine</b>' +
        '<span class="tenue piccolo">Nessun lavoro in sospeso per ' + h(descrizioneVista(d)) + '.</span></div>';
    }
    return '<ul class="cr-fare-elenco">' + voci.map(function (v, i) {
      return '<li><a class="cr-azione p' + v.p + '" href="#' + v.pagina + '" data-vai="' + v.pagina + '" data-chiave="fare-' + i + '"' +
        (v.par ? ' data-par="' + h(JSON.stringify(v.par)) + '"' : '') + '>' +
        '<span class="cr-a-ico" aria-hidden="true">' + v.ico + '</span>' +
        '<span class="cr-a-testo"><b>' + h(v.titolo) + '</b><small>' + h(v.dettaglio) + '</small></span>' +
        '<span class="cr-vai" aria-hidden="true">→</span></a></li>';
    }).join('') + '</ul>';
  }

  function htmlDaControllare(d) {
    var urgenti = d.scaduti.concat(d.entro30).sort(function (a, b) { return a.giorni - b.giorni; }).slice(0, 8);
    if (!d.sotto.length && !urgenti.length) {
      return '<div class="vuoto"><b>Tutto in ordine</b>Nessun articolo sotto scorta e nessun lotto scaduto o in scadenza entro 30 giorni.</div>';
    }
    return '<ul class="elenco-semplice">' +
      d.sotto.slice(0, 8).map(function (x) {
        return '<li><span class="etichetta pericolo">sotto scorta</span><span class="chi"><a href="#" data-scheda="' + h(x.articolo.id) + '">' + h(x.articolo.nome) + '</a>' +
          ' <span class="tenue">· ' + h(App.nomeReparto(x.repartoId)) + '</span></span>' +
          '<span class="tenue cr-num">' + App.fmtNum(x.giacenza) + ' su ' + App.fmtNum(x.soglia) + '</span></li>';
      }).join('') +
      urgenti.map(function (l) {
        var st = App.statoScadenza(l.giorni);
        return '<li><span class="etichetta ' + st.classe + '">' + (l.giorni < 0 ? 'scaduto' : 'scade ' + App.fmtScadenza(l.scadenza)) + '</span>' +
          '<span class="chi"><a href="#" data-scheda="' + h(l.articolo.id) + '">' + h(l.articolo.nome) + '</a> <span class="tenue">· ' + h(App.nomeReparto(l.repartoId)) +
          (l.lotto ? ' · lotto <span class="mono">' + h(l.lotto) + '</span>' : '') + '</span></span>' +
          '<span class="tenue cr-num">' + App.fmtNum(l.quantita) + '</span></li>';
      }).join('') + '</ul>';
  }

  function nomeControparte(m) {
    var c = C.controparteDdt ? C.controparteDdt(App.S, m) : null;
    if (c && c.controparteId) return App.nomeReparto(c.controparteId);
    return App.nomeReparto(m.repartoDestId);
  }

  function htmlMovimentiOggi(d) {
    var lista = d.movimentiOggi;
    if (!lista.length) return '<div class="vuoto"><b>Nessun movimento oggi</b>I consumi si registrano da “Consumi del giorno”.</div>';
    return '<ul class="elenco-semplice">' + lista.slice(0, 12).map(function (m) {
      var a = App.articolo(m.articoloId) || {};
      var dove = h(App.nomeReparto(m.repartoId));
      if (m.tipo === 'trasferimento') {
        var c = C.controparteDdt ? C.controparteDdt(App.S, m) : null;
        // DDT: si mostra il magazzino vero al posto di "In transito"
        if (c && c.ddt) {
          var partenza = m.repartoId === c.ddt.origineId;
          dove = partenza ? h(App.nomeReparto(m.repartoId)) + ' → ' + h(nomeControparte(m)) : h(nomeControparte(m)) + ' → ' + h(App.nomeReparto(m.repartoDestId));
          dove += ' <span class="mono">' + h(c.ddt.numero) + '</span>';
        } else dove += ' → ' + h(App.nomeReparto(m.repartoDestId));
      }
      return '<li><span class="cr-tipo tipo-' + m.tipo + '">' + h(App.TIPI[m.tipo] || m.tipo) + '</span>' +
        '<span class="chi"><a href="#" data-scheda="' + h(m.articoloId) + '">' + h(a.nome || '') + '</a> <span class="tenue">· ' + dove + '</span></span>' +
        '<span class="cr-num"><b>' + App.fmtNum(m.quantita) + '</b> <span class="tenue">' + h(a.unita || '') + '</span></span></li>';
    }).join('') + '</ul>' + (lista.length > 12 ? '<p class="piccolo tenue cr-altri">e altri ' + (lista.length - 12) + ': <a href="#movimenti">vedi tutti i movimenti</a></p>' : '');
  }

  function riepilogoOggi(d) {
    var perTipo = {};
    d.movimentiOggi.forEach(function (m) { perTipo[m.tipo] = (perTipo[m.tipo] || 0) + 1; });
    return Object.keys(perTipo).map(function (t) { return (App.TIPI[t] || t) + ': ' + perTipo[t]; }).join(' · ');
  }

  /* ---------- grafici ---------- */

  function etichettaGiorno(s) {
    var p = s.split('-');
    return Number(p[2]) + '/' + Number(p[1]);
  }

  function mediaMobile(serie, n) {
    return serie.map(function (v, i) {
      var da = Math.max(0, i - n + 1);
      var parte = serie.slice(da, i + 1);
      return Math.round(parte.reduce(function (s, x) { return s + x; }, 0) / parte.length * 10) / 10;
    });
  }

  function stretto() { return (root.innerWidth || 1024) < 640; }

  function opzioniConsumi() {
    var G = root.Grafici;
    var d = dati;
    var col = G.colori();
    var valore = scelte.metrica === 'valore';
    var serie = valore ? d.serieValore : d.serieUnita;
    var media = mediaMobile(serie, 7);
    var fmt = valore ? function (v) { return euro(v, 2); } : function (v) { return App.fmtNum(v); };
    return {
      grid: { left: stretto() ? 38 : 50, right: 10, top: 28, bottom: 26 },
      legend: { top: 0, right: 0, data: [valore ? 'Valore dei consumi' : 'Unità consumate', 'Media di 7 giorni'] },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: function (p) {
          var i = p[0] ? p[0].dataIndex : 0;
          var giorno = d.giorni[i];
          return '<b>' + h(SETTIMANA[giornoDellaSettimana(giorno)] + ' ' + App.fmtData(giorno)) + '</b><br>' +
            h(valore ? 'Valore' : 'Unità') + ': <b>' + h(fmt(serie[i])) + '</b><br>' +
            '<span style="color:' + G.css('--tenue', '#5B687C') + '">Media di 7 giorni: ' + h(fmt(media[i])) + '</span>';
        }
      },
      xAxis: {
        type: 'category', data: d.giorni.map(etichettaGiorno),
        axisLabel: { interval: stretto() ? 6 : 2, hideOverlap: true }
      },
      yAxis: { type: 'value', splitNumber: 4, axisLabel: { formatter: function (v) { return valore ? compatto(v) + ' €' : compatto(v); } } },
      series: [
        {
          name: valore ? 'Valore dei consumi' : 'Unità consumate', type: 'bar', barMaxWidth: 16,
          data: serie.map(function (v, i) {
            var festivo = [0, 6].indexOf(giornoDellaSettimana(d.giorni[i])) >= 0;
            var oggi = i === serie.length - 1;
            return { value: v, itemStyle: { color: col[0], opacity: oggi ? 1 : festivo ? 0.45 : 0.78 } };
          }),
          emphasis: { itemStyle: { opacity: 1 } }
        },
        {
          name: 'Media di 7 giorni', type: 'line', data: media, smooth: 0.35, showSymbol: false, symbol: 'circle',
          lineStyle: { width: 2, color: col[1] }, itemStyle: { color: col[1] }, z: 3
        }
      ]
    };
  }

  function opzioniTop() {
    var G = root.Grafici;
    var d = dati;
    var col = G.colori();
    var nomi = d.top.map(function (x) { return x.nome; });
    return {
      grid: { left: 6, right: 56, top: 4, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'item',
        formatter: function (p) {
          var x = d.top[p.dataIndex];
          if (!x) return '';
          return '<b>' + h(x.nome) + '</b><br>' + h(App.fmtNum(x.unita)) + ' ' + h(x.unitaMisura || 'unità') + ' in ' + x.volte + ' ' + plurale(x.volte, 'registrazione', 'registrazioni') +
            (x.valore ? '<br>' + h(euro(x.valore, 2)) : '') + '<br><span style="color:' + G.css('--tenue', '#5B687C') + '">Clic per aprire la scheda</span>';
        }
      },
      xAxis: { type: 'value', show: false },
      yAxis: {
        type: 'category', inverse: true, data: nomi, axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { width: stretto() ? 120 : 210, overflow: 'truncate', color: G.css('--testo', '#12244A'), fontSize: 12 }
      },
      series: [{
        type: 'bar', barWidth: 12, cursor: 'pointer',
        showBackground: true, backgroundStyle: { color: G.css('--superficie-3', '#EEF2F8'), borderRadius: 3 },
        itemStyle: { borderRadius: [0, 3, 3, 0], color: col[0] },
        label: { show: true, position: 'right', color: G.css('--tenue', '#5B687C'), fontFamily: G.css('--mono', 'monospace'), fontSize: 11, formatter: function (p) { return App.fmtNum(p.value); } },
        data: d.top.map(function (x, i) { return { value: Math.round(x.unita * 10) / 10, itemStyle: { opacity: 1 - i * 0.07 } }; })
      }]
    };
  }

  var TIPI_COLORE = { consumo: 0, carico: 2, trasferimento: 5, perdita: 1, rettifica: 3 };
  var TIPI_ORDINE = ['consumo', 'carico', 'trasferimento', 'perdita', 'rettifica'];

  function opzioniTipi() {
    var G = root.Grafici;
    var d = dati;
    var col = G.colori();
    var dati2 = TIPI_ORDINE.filter(function (t) { return d.tipi[t]; }).map(function (t) {
      return { name: App.TIPI[t] || t, value: d.tipi[t], itemStyle: { color: col[TIPI_COLORE[t]] } };
    });
    var s = stretto();
    return {
      title: {
        text: intero(d.totaleTipi), subtext: 'movimenti', left: s ? '49%' : '34%', top: s ? '34%' : '39%', textAlign: 'center',
        textStyle: { fontSize: 20, fontWeight: 800, color: G.css('--testo', '#12244A'), fontFamily: G.css('--carattere-titoli', 'sans-serif') },
        subtextStyle: { fontSize: 11, color: G.css('--tenue', '#5B687C') }, itemGap: 2
      },
      tooltip: { trigger: 'item', formatter: function (p) { return h(p.name) + ': <b>' + intero(p.value) + '</b> (' + Math.round(p.percent) + '%)'; } },
      legend: s
        ? { bottom: 0, left: 'center', itemGap: 10 }
        : { orient: 'vertical', right: 4, top: 'middle', itemGap: 10, formatter: function (n) { var x = dati2.filter(function (y) { return y.name === n; })[0]; return n + '  ' + (x ? intero(x.value) : ''); } },
      series: [{
        type: 'pie', radius: ['56%', '80%'], center: s ? ['50%', '42%'] : ['35%', '50%'], avoidLabelOverlap: true, cursor: 'pointer',
        label: { show: false }, labelLine: { show: false },
        emphasis: { scale: true, scaleSize: 5 },
        data: dati2
      }]
    };
  }

  function sintesiConsumi(d) {
    var tot = d.serieUnita.reduce(function (s, x) { return s + x; }, 0);
    var totV = d.serieValore.reduce(function (s, x) { return s + x; }, 0);
    var max = 0, iMax = 0;
    d.serieUnita.forEach(function (v, i) { if (v > max) { max = v; iMax = i; } });
    return 'Ultimi ' + GIORNI + ' giorni: ' + App.fmtNum(Math.round(tot)) + ' unità (' + euro(totV) + '), in media ' +
      App.fmtNum(Math.round(tot / GIORNI * 10) / 10) + ' al giorno' + (max ? '; il giorno con più consumi è stato ' + App.fmtData(d.giorni[iMax]) + ' (' + App.fmtNum(max) + ')' : '') + '.';
  }

  function sintesiTop(d) {
    if (!d.top.length) return 'Nessun consumo negli ultimi ' + GIORNI + ' giorni.';
    return 'I più usati negli ultimi ' + GIORNI + ' giorni: ' + d.top.slice(0, 5).map(function (x) { return x.nome + ' (' + App.fmtNum(x.unita) + ')'; }).join(', ') + '.';
  }

  function sintesiTipi(d) {
    if (!d.totaleTipi) return 'Nessun movimento negli ultimi ' + GIORNI + ' giorni.';
    return 'Movimenti degli ultimi ' + GIORNI + ' giorni: ' + TIPI_ORDINE.filter(function (t) { return d.tipi[t]; }).map(function (t) { return (App.TIPI[t] || t) + ' ' + d.tipi[t]; }).join(', ') + '.';
  }

  function disegnaGrafici(cont, nuovi) {
    var G = grafici();
    var d = dati;
    var caselle = [
      { id: 'cr-g-consumi', opz: opzioniConsumi, vuoto: !d.serieUnita.some(Boolean), testo: 'Nessun consumo negli ultimi ' + GIORNI + ' giorni.', sintesi: sintesiConsumi(d) },
      { id: 'cr-g-top', opz: opzioniTop, vuoto: !d.top.length, testo: 'Qui compaiono gli articoli consumati di più.', sintesi: sintesiTop(d),
        eventi: { click: function (p) { var x = dati.top[p.dataIndex]; if (x) App.schedaArticolo(x.id); } } },
      { id: 'cr-g-tipi', opz: opzioniTipi, vuoto: !d.totaleTipi, testo: 'Nessun movimento negli ultimi ' + GIORNI + ' giorni.', sintesi: sintesiTipi(d),
        eventi: { click: function () { App.vai('movimenti'); } } }
    ];
    caselle.forEach(function (c) {
      var box = cont.querySelector('#' + c.id);
      if (!box) return;
      var sint = cont.querySelector('#' + c.id + '-sintesi');
      if (sint) sint.textContent = c.sintesi;
      box.setAttribute('aria-label', c.sintesi);
      var tela = box.querySelector('.cr-tela');
      if (c.vuoto || !G) {
        if (tela && G) G.libera(box);
        box.innerHTML = '<p class="cr-grafico-vuoto">' + h(c.vuoto ? c.testo : c.sintesi) + '</p>';
        return;
      }
      if (tela && !nuovi && G.aggiorna(tela)) return;
      box.innerHTML = '<div class="cr-tela"></div>';
      G.crea(box.firstChild, c.opz, c.eventi);
    });
    var spark = cont.querySelector('#cr-spark-consumi');
    if (spark && root.Grafici) {
      root.Grafici.scintilla(spark, d.serieUnita.slice(-14), { colore: 'var(--primario)', etichetta: 'Consumi degli ultimi 14 giorni' });
    }
  }

  /* ---------- pagina ---------- */

  function htmlScheda(id, classe, titolo, corpo, testa) {
    return '<section class="scheda ' + classe + '" id="' + id + '"><div class="scheda-testa"><h2>' + titolo + '</h2>' + (testa || '') + '</div>' +
      '<div class="scheda-corpo stretto">' + corpo + '</div></section>';
  }

  function htmlGrafico(id, alto) {
    return '<div class="cr-grafico' + (alto ? ' alto' : '') + '" id="' + id + '" role="img"><div class="cr-tela"></div></div>' +
      '<p class="cr-sintesi" id="' + id + '-sintesi"></p>';
  }

  function htmlBenvenuto() {
    if (App.S.articoli.length) return '';
    var nome = App.S.impostazioni.nomeProdotto || 'NefroCenter Pharmacy';
    var admin = App.eAmministratore() && App.archivioVuoto();
    return App.puo('articoli')
      ? '<div class="banda info"><p><b>Benvenuto in ' + h(nome) + '.</b> Per cominciare importa gli articoli da Excel (anche dai vecchi moduli “Nota consumi” compilati) ' +
        'o inseriscili uno per uno, controlla i magazzini e registra le giacenze iniziali con un carico.' +
        (admin ? ' Per provare il programma puoi caricare i dati di prova; se usavate la versione per un solo PC, da Configura puoi importarne l’archivio.' : '') + '</p>' +
        '<a class="btn primario" href="#articoli">Vai agli articoli</a>' +
        (admin ? '<button class="btn" type="button" id="oggi-demo">Carica dati di prova</button>' : '') + '</div>'
      : '<div class="banda info"><p><b>Benvenuto in ' + h(nome) + '.</b> L’archivio è ancora vuoto: gli articoli e le giacenze iniziali li inserisce la farmacia. Appena ci sono, li trovi qui.</p></div>';
  }

  function segmenti() {
    return '<div class="cr-segmenti" role="group" aria-label="Misura dei consumi">' +
      '<button type="button" data-metrica="unita" aria-pressed="' + (scelte.metrica !== 'valore') + '">Unità</button>' +
      '<button type="button" data-metrica="valore" aria-pressed="' + (scelte.metrica === 'valore') + '">Valore €</button></div>';
  }

  // contatori: i numeri scorrono dall'ultimo valore mostrato al nuovo
  function animaNumeri(cont, lista) {
    lista.forEach(function (x) {
      var el = cont.querySelector('#cr-i-' + x.id + ' .valore');
      if (!el) return;
      var da = ultimi[x.id] === undefined ? 0 : ultimi[x.id];
      if (root.Motion) root.Motion.conta(el, da, x.valore, { formato: x.formato, durata: ultimi[x.id] === undefined ? 1100 : 700 });
      else el.textContent = x.formato(x.valore);
      if (ultimi[x.id] !== undefined && ultimi[x.id] !== x.valore && root.Motion) root.Motion.evidenzia(el.parentNode.querySelector('.cr-ico'));
      ultimi[x.id] = x.valore;
    });
  }

  // il fuoco resta sullo stesso elemento quando una parte si ridisegna (aggiornamento arrivato da altri utenti)
  function chiaveFuoco(cont) {
    var a = document.activeElement;
    if (!a || !cont.contains(a)) return null;
    if (a.id) return '#' + a.id;
    if (a.getAttribute('data-chiave')) return '[data-chiave="' + a.getAttribute('data-chiave') + '"]';
    return null;
  }
  function rimettiFuoco(cont, chiave) {
    if (!chiave) return;
    var el = cont.querySelector(chiave);
    if (el && document.activeElement !== el) { try { el.focus({ preventScroll: true }); } catch (e) { /* non attivabile */ } }
  }

  function aggiornaParti(cont, nuovi) {
    var fuoco = chiaveFuoco(cont);
    var lista = indicatori(dati);
    cont.querySelector('#cr-indicatori').innerHTML = lista.map(htmlIndicatore).join('');
    animaNumeri(cont, lista);
    cont.querySelector('#cr-fare .scheda-corpo').innerHTML = htmlDaFare(dati);
    cont.querySelector('#cr-controllare .scheda-corpo').innerHTML = htmlDaControllare(dati);
    cont.querySelector('#cr-oggi .scheda-corpo').innerHTML = htmlMovimentiOggi(dati);
    var nota = cont.querySelector('#cr-oggi .scheda-testa .nota');
    if (nota) nota.textContent = riepilogoOggi(dati);
    var dove = cont.querySelector('#cr-dove');
    if (dove) dove.textContent = descrizioneVista(dati);
    var o = cont.querySelector('#cr-ora');
    if (o) o.textContent = 'aggiornato alle ' + ora();
    var s = cont.querySelector('#cr-saluto');
    if (s) s.textContent = saluto();
    disegnaGrafici(cont, nuovi);
    rimettiFuoco(cont, fuoco);
  }

  App.pagine.oggi = function (cont) {
    dati = calcola();
    var d = dati;
    cont.innerHTML = htmlBenvenuto() + htmlTesta(d) + htmlAzioniRapide() +
      '<div class="indicatori cr-indicatori" id="cr-indicatori" aria-label="Indicatori"></div>' +
      '<div class="cr-griglia">' +
      htmlScheda('cr-andamento', 'cr-consumi', 'Consumi degli ultimi ' + GIORNI + ' giorni', htmlGrafico('cr-g-consumi', true), segmenti()) +
      htmlScheda('cr-fare', 'cr-fare', 'Cosa fare adesso', '') +
      htmlScheda('cr-piu-usati', 'cr-top', 'Articoli più usati', htmlGrafico('cr-g-top'), '<span class="nota">ultimi ' + GIORNI + ' giorni · clic per la scheda</span>') +
      htmlScheda('cr-tipi', 'cr-tipi', 'Movimenti per tipo', htmlGrafico('cr-g-tipi'), '<span class="nota">ultimi ' + GIORNI + ' giorni</span>') +
      '</div>' +
      '<div class="griglia-2">' +
      htmlScheda('cr-controllare', 'cr-controllare', 'Da controllare', '') +
      htmlScheda('cr-oggi', 'cr-movimenti-oggi', 'Movimenti di oggi', '', '<span class="nota"></span>') +
      '</div>';

    aggiornaParti(cont, true);
    if (root.Motion && !ridotto()) {
      root.Motion.entra(cont.querySelectorAll('.cr-ind'), { ritardo: 45, distanza: 10 });
      root.Motion.entra(cont.querySelectorAll('.cr-griglia > .scheda, .griglia-2 > .scheda'), { ritardo: 70, distanza: 14, durata: 500 });
    }

    cont.addEventListener('click', function (e) {
      var s = e.target.closest('[data-scheda]');
      if (s) { e.preventDefault(); App.schedaArticolo(s.getAttribute('data-scheda')); return; }
      if (e.target.closest('[data-sotto]')) { e.preventDefault(); App.vai('giacenze', { soloSotto: true }); return; }
      var v = e.target.closest('[data-vai]');
      if (v && v.getAttribute('data-par')) {
        e.preventDefault();
        var par = {};
        try { par = JSON.parse(v.getAttribute('data-par')) || {}; } catch (x) { par = {}; }
        App.vai(v.getAttribute('data-vai'), par);
        return;
      }
      var b = e.target.closest('[data-metrica]');
      if (b) {
        scelte.metrica = b.getAttribute('data-metrica');
        cont.querySelectorAll('[data-metrica]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        var tela = cont.querySelector('#cr-g-consumi .cr-tela');
        if (tela && root.Grafici) root.Grafici.aggiorna(tela);
      }
    });
    var sel = cont.querySelector('#cr-vista');
    if (sel) {
      sel.addEventListener('change', function () {
        scelte.vista = sel.value;
        dati = calcola();
        aggiornaParti(cont, false);
      });
    }
    var demo = cont.querySelector('#oggi-demo');
    if (demo) demo.addEventListener('click', function () { App.caricaDemo(); });

    // aggiornamento sul posto quando cambiano i dati (altri utenti, finestre aperte da qui)
    App.rinfresca = function () {
      if (!document.body.contains(cont) || !App.S) return;
      dati = calcola();
      aggiornaParti(cont, false);
    };
  };
})(window);
