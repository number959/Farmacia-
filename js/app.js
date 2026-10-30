/*
 * Gestionale Farmacia · Clinica Posillipo — nucleo dell'applicazione:
 * stato, salvataggio, menu, tasti rapidi, ricerca, finestre e avvisi.
 * Le pagine stanno in pagine.js e si registrano in App.pagine.
 */
(function (root) {
  'use strict';

  var C = root.Calcoli;
  var Archivio = root.Archivio;

  var App = {
    S: null,
    pagine: {},
    paginaCorrente: 'oggi',
    parametri: {},
    _giacenze: null
  };

  /* ---------- menu: stessa impostazione del Gestionale Agende, un tasto per pagina ---------- */
  App.MENU = [
    { gruppo: 'Lavoro di ogni giorno' },
    { id: 'oggi', voce: 'Oggi', ico: '🏠', tasto: 'O' },
    { id: 'carico', voce: 'Carico', ico: '📥', tasto: 'C' },
    { id: 'consumi', voce: 'Consumi del giorno', ico: '💊', tasto: 'S' },
    { id: 'trasferimenti', voce: 'Trasferimenti', ico: '🔁', tasto: 'T' },
    { id: 'perdite', voce: 'Perdite e scaduti', ico: '🗑️', tasto: 'P' },
    { gruppo: 'Magazzino' },
    { id: 'giacenze', voce: 'Giacenze', ico: '📦', tasto: 'G' },
    { id: 'scadenze', voce: 'Scadenze', ico: '⏳', tasto: 'Z', conta: 'scadenze' },
    { id: 'movimenti', voce: 'Movimenti', ico: '🧾', tasto: 'M' },
    { id: 'inventario', voce: 'Inventario', ico: '✅', tasto: 'I' },
    { gruppo: 'Registri' },
    { id: 'registro', voce: 'Nota consumi mensile', ico: '📅', tasto: 'R' },
    { gruppo: 'Archivio' },
    { id: 'articoli', voce: 'Articoli', ico: '🏷️', tasto: 'A' },
    { id: 'configura', voce: 'Configura', ico: '⚙️', tasto: 'F' },
    { id: 'guida', voce: 'Guida', ico: '❓', tasto: 'H' }
  ];

  /* ---------- utilità ---------- */
  App.h = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var h = App.h;

  App.id = function (prefisso) {
    return (prefisso || 'x') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  };

  App.oggi = Archivio.oggi;

  App.fmtData = function (d) {
    if (!d) return '';
    var p = d.split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : d;
  };

  App.fmtScadenza = function (s) {
    if (!s) return '—';
    var p = s.split('-');
    return p[1] + '/' + p[0];
  };

  App.fmtNum = function (n) {
    if (n === null || n === undefined || n === '') return '';
    var v = Math.round(Number(n) * 1000) / 1000;
    return v.toLocaleString('it-IT', { maximumFractionDigits: 3 });
  };

  App.fmtEuro = function (n) {
    return (Number(n) || 0).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
  };

  App.dataLunga = function (d) {
    var p = d.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };

  App.numero = function (v) {
    var n = parseFloat(String(v === undefined || v === null ? '' : v).replace(',', '.'));
    return isFinite(n) ? n : 0;
  };

  App.TIPI = {
    carico: 'Carico',
    consumo: 'Consumo',
    trasferimento: 'Trasferimento',
    perdita: 'Perdita',
    rettifica: 'Rettifica inventario'
  };

  App.CAUSALI_PERDITA = ['Scaduto', 'Rotto o danneggiato', 'Smarrito', 'Reso al fornitore', 'Altro'];

  /* ---------- dati ---------- */
  App.articolo = function (id) { return App.S.articoli.filter(function (a) { return a.id === id; })[0]; };
  App.reparto = function (id) { return App.S.reparti.filter(function (r) { return r.id === id; })[0]; };
  App.nomeArticolo = function (id) { var a = App.articolo(id); return a ? a.nome : '(articolo eliminato)'; };
  App.nomeReparto = function (id) { var r = App.reparto(id); return r ? r.nome : '—'; };

  App.repartiAttivi = function () {
    return App.S.reparti.filter(function (r) { return r.attivo !== false; });
  };

  App.repartoCentrale = function () {
    var c = App.S.reparti.filter(function (r) { return r.centrale && r.attivo !== false; })[0];
    return c || App.repartiAttivi()[0];
  };

  App.articoliAttivi = function (categoria) {
    return App.S.articoli
      .filter(function (a) { return a.attivo !== false && (!categoria || a.categoria === categoria); })
      .sort(function (x, y) { return x.nome.localeCompare(y.nome, 'it'); });
  };

  App.articoloPerNome = function (nome) {
    var n = String(nome || '').trim().toLowerCase();
    return App.S.articoli.filter(function (a) { return a.nome.toLowerCase() === n; })[0];
  };

  App.giacenze = function () {
    if (!App._giacenze) App._giacenze = C.tutteLeGiacenze(App.S);
    return App._giacenze;
  };

  App.giacenza = function (articoloId, repartoId) {
    return App.giacenze()[articoloId + '|' + repartoId] || 0;
  };

  App.giacenzaTotale = function (articoloId) {
    var g = App.giacenze();
    return App.S.reparti.reduce(function (s, r) { return s + (g[articoloId + '|' + r.id] || 0); }, 0);
  };

  App.sottoScorta = function (a) {
    if (!a.scortaMinima) return false;
    var c = App.repartoCentrale();
    return App.giacenza(a.id, c.id) < a.scortaMinima;
  };

  /* Lotti con giacenza in tutti i reparti, con i giorni alla scadenza. */
  App.lottiInGiacenza = function () {
    var g = App.giacenze();
    var oggi = App.oggi();
    var out = [];
    App.S.articoli.forEach(function (a) {
      App.S.reparti.forEach(function (r) {
        if (!g[a.id + '|' + r.id]) return;
        C.lotti(App.S, a.id, r.id).forEach(function (l) {
          if (l.quantita <= 0) return;
          out.push({ articolo: a, reparto: r, lotto: l.lotto, scadenza: l.scadenza, quantita: l.quantita, giorni: C.giorniAllaScadenza(l.scadenza, oggi) });
        });
      });
    });
    return out;
  };

  App.statoScadenza = function (giorni) {
    if (giorni === null) return { classe: '', testo: 'senza scadenza' };
    if (giorni < 0) return { classe: 'pericolo', testo: 'scaduto' };
    if (giorni <= 30) return { classe: 'pericolo', testo: 'entro 30 giorni' };
    if (giorni <= (App.S.impostazioni.giorniAvvisoScadenza || 90)) return { classe: 'attenzione', testo: 'entro ' + (App.S.impostazioni.giorniAvvisoScadenza || 90) + ' giorni' };
    return { classe: 'ok', testo: 'valido' };
  };

  App.contaScadenze = function () {
    var soglia = App.S.impostazioni.giorniAvvisoScadenza || 90;
    return App.lottiInGiacenza().filter(function (l) { return l.giorni !== null && l.giorni <= soglia; }).length;
  };

  /* ---------- registrazione dei movimenti ---------- */
  App.aggiungiMovimenti = function (lista) {
    var ora = Date.now();
    lista.forEach(function (m, i) {
      m.id = m.id || App.id('m');
      m.creato = ora + i;
      m.operatore = App.S.impostazioni.operatore || '';
      m.quantita = Number(m.quantita);
      App.S.movimenti.push(m);
    });
    return App.salva();
  };

  /*
   * Uscita (consumo, perdita, trasferimento): ripartita sui lotti del reparto,
   * prima quelli che scadono prima. Restituisce i movimenti da registrare.
   */
  App.preparaUscita = function (tipo, dati) {
    var parti = C.allocaUscita(App.S, dati.articoloId, dati.repartoId, dati.data, dati.quantita, dati.lotto);
    return parti.map(function (p) {
      return Object.assign({}, dati, { tipo: tipo, quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza });
    });
  };

  App.annullaMovimento = function (id, motivo) {
    var m = App.S.movimenti.filter(function (x) { return x.id === id; })[0];
    if (!m || m.annullato) return Promise.resolve();
    m.annullato = { il: new Date().toISOString(), da: App.S.impostazioni.operatore || '', motivo: motivo || '' };
    return App.salva();
  };

  /* Imposta il consumo totale di un giorno (registro mensile): annulla i consumi del giorno e registra il nuovo valore. */
  App.impostaConsumoGiorno = function (articoloId, repartoId, data, quantita) {
    var esistenti = App.S.movimenti.filter(function (m) {
      return !m.annullato && m.tipo === 'consumo' && m.articoloId === articoloId && m.repartoId === repartoId && m.data === data;
    });
    var ora = new Date().toISOString();
    esistenti.forEach(function (m) {
      m.annullato = { il: ora, da: App.S.impostazioni.operatore || '', motivo: 'Corretto dal registro mensile' };
    });
    App._giacenze = null;
    var nuovi = quantita > 0
      ? App.preparaUscita('consumo', { articoloId: articoloId, repartoId: repartoId, data: data, quantita: quantita, note: 'Dal registro mensile' })
      : [];
    if (nuovi.length) return App.aggiungiMovimenti(nuovi);
    return App.salva();
  };

  /* ---------- salvataggio ---------- */
  var codaSalvataggio = Promise.resolve();
  App.salva = function () {
    App._giacenze = null;
    var indicatore = document.getElementById('salvataggio');
    indicatore.className = 'salvataggio';
    indicatore.textContent = 'Salvataggio…';
    codaSalvataggio = codaSalvataggio.then(function () { return Archivio.salva(App.S); }).then(function () {
      indicatore.textContent = '✓ Salvato';
      App.aggiornaLaterale();
    }, function (e) {
      console.error(e);
      indicatore.className = 'salvataggio errore';
      indicatore.textContent = 'Non salvato!';
      App.avviso('Salvataggio non riuscito: ' + (e && e.message ? e.message : e), 'errore');
    });
    return codaSalvataggio;
  };

  /* ---------- file ---------- */
  App.scarica = function (blob, nome) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  };

  App.scegliFileDaLeggere = function (accetta) {
    return new Promise(function (ok) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = accetta || '';
      inp.onchange = function () { ok(inp.files && inp.files[0]); };
      inp.click();
    });
  };

  /* ---------- avvisi e finestre ---------- */
  App.avviso = function (testo, tipo) {
    var box = document.getElementById('avvisi');
    var d = document.createElement('div');
    d.className = 'avviso ' + (tipo || '');
    d.textContent = testo;
    box.appendChild(d);
    setTimeout(function () { d.remove(); }, tipo === 'errore' ? 7000 : 3500);
  };

  var chiusuraModale = null;
  App.apriModale = function (opz) {
    var m = document.getElementById('modale');
    m.className = 'modale' + (opz.largo ? ' largo' : '');
    m.innerHTML =
      '<div class="modale-testa"><h2 id="modale-titolo">' + h(opz.titolo) + '</h2>' +
      '<button class="btn fantasma" type="button" data-chiudi aria-label="Chiudi">✕</button></div>' +
      '<div class="modale-corpo">' + opz.corpo + '</div>' +
      '<div class="modale-piede">' + (opz.piede || '<button class="btn" type="button" data-chiudi>Chiudi</button>') + '</div>';
    m.hidden = false;
    document.getElementById('velo').hidden = false;
    chiusuraModale = opz.allaChiusura || null;
    m.querySelectorAll('[data-chiudi]').forEach(function (b) { b.addEventListener('click', App.chiudiModale); });
    var primo = m.querySelector('.modale-corpo input:not([type=checkbox]), .modale-corpo select, .modale-corpo textarea');
    setTimeout(function () { (primo || m.querySelector('.modale-piede .btn.primario') || m.querySelector('[data-chiudi]')).focus(); }, 30);
    if (opz.dopo) opz.dopo(m);
    return m;
  };

  App.chiudiModale = function () {
    var m = document.getElementById('modale');
    if (m.hidden) return;
    m.hidden = true;
    m.innerHTML = '';
    document.getElementById('velo').hidden = true;
    var f = chiusuraModale;
    chiusuraModale = null;
    if (f) f();
  };

  App.conferma = function (titolo, testo, etichetta, pericolo) {
    return new Promise(function (ok) {
      var risposta = false;
      App.apriModale({
        titolo: titolo,
        corpo: '<p>' + testo + '</p>',
        piede: '<button class="btn" type="button" data-chiudi>Annulla</button>' +
          '<button class="btn ' + (pericolo ? 'pericolo pieno' : 'primario') + '" type="button" id="conferma-si">' + h(etichetta || 'Conferma') + '</button>',
        allaChiusura: function () { ok(risposta); },
        dopo: function (m) {
          m.querySelector('#conferma-si').addEventListener('click', function () { risposta = true; App.chiudiModale(); });
          setTimeout(function () { m.querySelector('#conferma-si').focus(); }, 40);
        }
      });
    });
  };

  App.chiedi = function (titolo, testo, predefinito, etichetta) {
    return new Promise(function (ok) {
      var risposta = null;
      App.apriModale({
        titolo: titolo,
        corpo: '<label class="campo"><span>' + h(testo) + '</span><input id="chiedi-testo" value="' + h(predefinito || '') + '"></label>',
        piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="chiedi-ok">' + h(etichetta || 'OK') + '</button>',
        allaChiusura: function () { ok(risposta); },
        dopo: function (m) {
          var inp = m.querySelector('#chiedi-testo');
          function vai() { risposta = inp.value.trim(); App.chiudiModale(); }
          m.querySelector('#chiedi-ok').addEventListener('click', vai);
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') vai(); });
        }
      });
    });
  };

  /* ---------- navigazione ---------- */
  App.vai = function (pagina, parametri) {
    App.parametri = parametri || {};
    if (location.hash !== '#' + pagina) {
      App._parametriInAttesa = App.parametri;
      location.hash = pagina;
    } else {
      App.mostra(pagina);
    }
  };

  App.mostra = function (pagina) {
    if (!App.pagine[pagina]) pagina = 'oggi';
    App.paginaCorrente = pagina;
    var voce = App.MENU.filter(function (v) { return v.id === pagina; })[0];
    document.getElementById('titolo-pagina').textContent = voce ? voce.voce : '';
    document.title = (voce ? voce.voce + ' · ' : '') + 'Gestionale Farmacia · ' + App.S.impostazioni.struttura;
    document.querySelectorAll('#menu a').forEach(function (a) {
      a.classList.toggle('attivo', a.getAttribute('data-pagina') === pagina);
    });
    document.getElementById('app').classList.remove('menu-aperto');
    var cont = document.getElementById('contenuto');
    cont.innerHTML = '';
    App.pagine[pagina](cont, App.parametri || {});
    App.parametri = {};
    window.scrollTo(0, 0);
  };

  App.ridisegna = function () { App.mostra(App.paginaCorrente); };

  App.disegnaMenu = function () {
    var conte = { scadenze: App.contaScadenze() };
    document.getElementById('menu').innerHTML = App.MENU.map(function (v) {
      if (v.gruppo) return '<div class="menu-gruppo">' + h(v.gruppo) + '</div>';
      var c = v.conta && conte[v.conta] ? '<span class="conta" title="Lotti in scadenza o scaduti">' + conte[v.conta] + '</span>' : '';
      return '<a href="#' + v.id + '" data-pagina="' + v.id + '"' + (v.id === App.paginaCorrente ? ' class="attivo"' : '') + '>' +
        '<span class="ico" aria-hidden="true">' + v.ico + '</span><span class="voce">' + h(v.voce) + '</span>' + c +
        '<kbd title="Tasto rapido">' + v.tasto + '</kbd></a>';
    }).join('');
  };

  App.disegnaMarchio = function () {
    var imp = App.S.impostazioni;
    var logo = imp.logo
      ? '<img src="' + h(imp.logo) + '" alt="">'
      : '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="M13 6h6v7h7v6h-7v7h-6v-7H6v-6h7z" fill="#fff"/></svg>';
    document.getElementById('marchio').innerHTML =
      '<div class="logo">' + logo + '</div>' +
      '<div><div class="nome">' + h(imp.struttura) + '</div><div class="sotto">' + h(imp.sottotitolo) + '</div></div>' +
      '<div class="prodotto">Gestionale Farmacia · carico e scarico</div>';
    document.getElementById('operatore').innerHTML = imp.operatore ? 'Operatore: <b>' + h(imp.operatore) + '</b>' : '<a href="#configura">Imposta operatore</a>';
  };

  App.aggiornaLaterale = function () {
    App.disegnaMenu();
    var S = App.S;
    var attivi = S.movimenti.filter(function (m) { return !m.annullato; }).length;
    Archivio.statoFile().then(function (f) {
      var file = f.attivo
        ? (f.permesso ? 'Copia su file: <b>' + h(f.nome) + '</b>' : 'Copia su file in pausa: <a href="#configura">riattiva</a>')
        : 'Copia su file: non attiva';
      document.getElementById('stato-archivio').innerHTML =
        '<div><b>' + S.articoli.length + '</b> articoli · <b>' + attivi + '</b> movimenti</div>' +
        '<div>' + file + '</div>';
    });
  };

  /* ---------- ricerca rapida (Ctrl+K o /) ---------- */
  var sceltaRicerca = 0;
  var risultatiRicerca = [];

  App.apriRicerca = function () {
    var r = document.getElementById('ricerca');
    r.hidden = false;
    document.getElementById('velo').hidden = false;
    var inp = document.getElementById('ricerca-testo');
    inp.value = '';
    cercaRapida('');
    inp.focus();
  };

  function chiudiRicerca() {
    document.getElementById('ricerca').hidden = true;
    if (document.getElementById('modale').hidden) document.getElementById('velo').hidden = true;
  }

  function cercaRapida(testo) {
    var t = testo.trim().toLowerCase();
    var art = App.S.articoli.filter(function (a) {
      return !t || a.nome.toLowerCase().indexOf(t) >= 0 || (a.principio || '').toLowerCase().indexOf(t) >= 0 || (a.codice || '').toLowerCase().indexOf(t) >= 0;
    }).sort(function (x, y) {
      var px = x.nome.toLowerCase().indexOf(t) === 0 ? 0 : 1;
      var py = y.nome.toLowerCase().indexOf(t) === 0 ? 0 : 1;
      return px - py || x.nome.localeCompare(y.nome, 'it');
    }).slice(0, 12).map(function (a) {
      return { tipo: 'articolo', id: a.id, testo: a.nome, nota: a.categoria + ' · giacenza ' + App.fmtNum(App.giacenzaTotale(a.id)) + (a.unita ? ' ' + a.unita : '') };
    });
    var pagine = App.MENU.filter(function (v) { return v.id && t && v.voce.toLowerCase().indexOf(t) >= 0; }).map(function (v) {
      return { tipo: 'pagina', id: v.id, testo: 'Vai a: ' + v.voce, nota: 'tasto ' + v.tasto };
    });
    risultatiRicerca = pagine.concat(art);
    sceltaRicerca = 0;
    var ul = document.getElementById('ricerca-risultati');
    if (!risultatiRicerca.length) {
      ul.innerHTML = '<li class="tenue">Nessun risultato' + (t ? ' per “' + h(testo) + '”' : '') + '</li>';
      return;
    }
    ul.innerHTML = risultatiRicerca.map(function (r, i) {
      return '<li data-i="' + i + '"' + (i === 0 ? ' class="scelto"' : '') + '><span>' + (r.tipo === 'pagina' ? '↪' : '💊') + '</span>' +
        '<span class="chi">' + h(r.testo) + '</span><span class="tenue">' + h(r.nota) + '</span></li>';
    }).join('');
  }

  function apriRisultato(i) {
    var r = risultatiRicerca[i];
    if (!r) return;
    chiudiRicerca();
    if (r.tipo === 'pagina') App.vai(r.id);
    else App.schedaArticolo(r.id);
  }

  function evidenzia() {
    document.querySelectorAll('#ricerca-risultati li[data-i]').forEach(function (li) {
      li.classList.toggle('scelto', Number(li.getAttribute('data-i')) === sceltaRicerca);
      if (Number(li.getAttribute('data-i')) === sceltaRicerca) li.scrollIntoView({ block: 'nearest' });
    });
  }

  /* ---------- tasti rapidi ---------- */
  function inCampo(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  function tasti(e) {
    var ricercaAperta = !document.getElementById('ricerca').hidden;
    var modaleAperto = !document.getElementById('modale').hidden;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      App.apriRicerca();
      return;
    }
    if (e.key === 'Escape') {
      if (ricercaAperta) chiudiRicerca();
      else if (modaleAperto) App.chiudiModale();
      return;
    }
    if (ricercaAperta) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sceltaRicerca = Math.min(sceltaRicerca + 1, risultatiRicerca.length - 1); evidenzia(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sceltaRicerca = Math.max(sceltaRicerca - 1, 0); evidenzia(); }
      else if (e.key === 'Enter') { e.preventDefault(); apriRisultato(sceltaRicerca); }
      return;
    }
    if (modaleAperto || inCampo(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); App.apriRicerca(); return; }
    var voce = App.MENU.filter(function (v) { return v.tasto && v.tasto.toLowerCase() === e.key.toLowerCase(); })[0];
    if (voce) { e.preventDefault(); App.vai(voce.id); }
  }

  /* ---------- avvio ---------- */
  App.avvia = function () {
    document.getElementById('data-oggi').textContent = App.dataLunga(App.oggi());
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    Promise.all([Archivio.carica(), Archivio.leggiManiglia()]).then(function (r) {
      App.S = r[0];
      App.disegnaMarchio();
      App.aggiornaLaterale();
      var pagina = (location.hash || '#oggi').slice(1);
      App.mostra(pagina);
      window.addEventListener('hashchange', function () {
        App.parametri = App._parametriInAttesa || {};
        App._parametriInAttesa = null;
        App.mostra(location.hash.slice(1));
      });
      document.addEventListener('keydown', tasti);
      document.getElementById('apri-ricerca').addEventListener('click', App.apriRicerca);
      document.getElementById('apri-menu').addEventListener('click', function () {
        document.getElementById('app').classList.toggle('menu-aperto');
      });
      document.getElementById('velo').addEventListener('click', function () {
        if (!document.getElementById('ricerca').hidden) chiudiRicerca();
        else App.chiudiModale();
      });
      var inp = document.getElementById('ricerca-testo');
      inp.addEventListener('input', function () { cercaRapida(inp.value); });
      document.getElementById('ricerca-risultati').addEventListener('click', function (e) {
        var li = e.target.closest('li[data-i]');
        if (li) apriRisultato(Number(li.getAttribute('data-i')));
      });
      document.getElementById('salvataggio').textContent = '✓ Salvato';
    }).catch(function (e) {
      console.error(e);
      document.getElementById('contenuto').innerHTML =
        '<div class="banda pericolo"><p><b>Non riesco ad aprire l’archivio.</b> ' + h(e && e.message ? e.message : e) +
        '. Apri il programma con Microsoft Edge o Google Chrome, non in una finestra anonima.</p></div>';
    });
  };

  root.App = App;
})(this);
