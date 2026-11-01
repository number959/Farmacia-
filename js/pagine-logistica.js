/*
 * Versione 3.0 – parte A (docs/NOVITA-3.0.md): richieste dei magazzini, DDT interni e consegne.
 *   Richieste (#richieste)          il magazzino periferico chiede, la farmacia centrale approva e prepara il DDT
 *   DDT e consegne (#consegne)      preparazione, spedizione con chi trasporta, ricezione riga per riga, stampa A4
 *   Trasferimenti (#trasferimenti)  un DDT tra due magazzini qualsiasi (anche i resi alla farmacia); sostituisce P.trasferimenti
 * Anche: contatori del menu, avvisi quando arriva una richiesta o un DDT, lettura del codice del DDT che apre il DDT.
 * Il controllo vero dei permessi lo fa sempre il server (server/logistica.js).
 */
(function (root) {
  'use strict';

  var App = root.App;
  var C = root.Calcoli;
  var h = App.h;
  var P = App.pagine;

  var STATI_RICHIESTA = {
    bozza: { testo: 'Da inviare', classe: '' },
    inviata: { testo: 'Inviata', classe: 'info' },
    in_lavorazione: { testo: 'In lavorazione', classe: 'attenzione' },
    evasa: { testo: 'Evasa', classe: 'ok' },
    chiusa: { testo: 'Chiusa con residuo', classe: '' },
    rifiutata: { testo: 'Rifiutata', classe: 'pericolo' },
    annullata: { testo: 'Annullata', classe: '' }
  };
  var STATI_DDT = {
    in_preparazione: { testo: 'In preparazione', classe: 'attenzione' },
    in_transito: { testo: 'In viaggio', classe: 'info' },
    ricevuto: { testo: 'Ricevuto', classe: 'ok' },
    ricevuto_con_differenze: { testo: 'Ricevuto con differenze', classe: 'pericolo' },
    annullato: { testo: 'Annullato', classe: '' }
  };
  var RICHIESTE_CHIUSE = ['evasa', 'chiusa', 'rifiutata', 'annullata'];
  var DDT_CHIUSI = ['ricevuto', 'ricevuto_con_differenze', 'annullato'];
  var CAUSALI = ['Trasferimento interno', 'Rifornimento reparto', 'Reso alla farmacia', 'Reso per scadenza', 'Prestito tra reparti'];
  var PAGINE_MIE = ['richieste', 'consegne'];
  var NUMERO_DDT = /^DDT-\d{4}-\d{4,}$/;

  // la pagina ha dati scritti e non ancora salvati: gli aggiornamenti degli altri non la ridisegnano
  var inModifica = false;
  var schedaRicordata = {};

  /* ======================= dati ======================= */

  function S(k) { return (App.S && Array.isArray(App.S[k])) ? App.S[k] : []; }
  function trova(k, id) { return S(k).filter(function (x) { return x.id === id; })[0] || null; }
  function perOrdine(a, b) { return (a.ordine || 0) - (b.ordine || 0); }
  function righeRichiesta(id) { return S('richiesteRighe').filter(function (r) { return r.richiestaId === id; }).sort(perOrdine); }
  function righeDdt(id) { return S('ddtRighe').filter(function (r) { return r.ddtId === id; }).sort(perOrdine); }
  function ddtDellaRichiesta(id) {
    return S('ddt').filter(function (d) { return d.richiestaId === id; }).sort(function (a, b) { return (a.anno - b.anno) || (a.progressivo - b.progressivo); });
  }
  function nomeMag(id) { var r = App.reparto(id); return r ? (r.tipo === 'transito' ? 'In viaggio' : r.nome) : '—'; }
  function pianoMag(id) { var r = App.reparto(id); return r && r.piano ? r.piano : ''; }
  function r3(x) { return C.r3(x); }
  function messaggio(e) { return e && e.message ? e.message : String(e); }
  function unita(articoloId) { var a = App.articolo(articoloId); return a && a.unita ? a.unita : ''; }
  function qta(q, articoloId) {
    var u = unita(articoloId);
    return App.fmtNum(q) + (u ? ' <span class="tenue">' + h(u) + '</span>' : '');
  }

  // magazzini in cui l'utente lavora per ricevere: i suoi, oppure (chi può tutto) la farmacia centrale
  function miei() {
    var r = App.permessi && App.permessi.reparti;
    if (r) return r.slice();
    var c = App.repartoCentrale();
    return c ? [c.id] : [];
  }
  function tuttiIMagazzini() { return !(App.permessi && App.permessi.reparti); }

  function puoEvadere(r) { return App.puo('evadiRichieste') && App.repartoPermesso(r.fornitoreId); }
  function puoChiedere(r) { return App.puo('richieste') && App.repartoPermesso(r.repartoId); }
  function puoSpedire(d) { return App.puo('ddt') && App.repartoPermesso(d.origineId); }
  function puoRicevere(d) { return App.puo('riceviDdt') && App.repartoPermesso(d.destinazioneId); }
  function daRicevere(d) { return d.stato === 'in_transito' && App.puo('riceviDdt') && miei().indexOf(d.destinazioneId) >= 0; }
  function richiestaVisibile(r) { return tuttiIMagazzini() || App.repartoPermesso(r.repartoId) || App.repartoPermesso(r.fornitoreId); }
  function ddtVisibile(d) { return tuttiIMagazzini() || App.repartoPermesso(d.origineId) || App.repartoPermesso(d.destinazioneId); }

  /* Merce impegnata nei DDT in preparazione di un magazzino: { 'articolo|lotto': quantita } (tranne un DDT). */
  function impegnati(origineId, tranneDdtId) {
    var ddt = {};
    S('ddt').forEach(function (d) { if (d.stato === 'in_preparazione' && d.origineId === origineId && d.id !== tranneDdtId) ddt[d.id] = true; });
    var out = {};
    S('ddtRighe').forEach(function (r) {
      if (!ddt[r.ddtId]) return;
      var k = r.articoloId + '|' + (r.lotto || '');
      out[k] = r3((out[k] || 0) + r.quantita);
      out[r.articoloId] = r3((out[r.articoloId] || 0) + r.quantita);
    });
    return out;
  }

  /* Merce libera di un articolo: giacenza meno quanto è già in DDT in preparazione. */
  function libera(articoloId, origineId, tranneDdtId) {
    return r3(App.giacenza(articoloId, origineId) - (impegnati(origineId, tranneDdtId)[articoloId] || 0));
  }

  /* Lotti liberi (FEFO) di un articolo in un magazzino. */
  function lottiLiberi(articoloId, origineId, tranneDdtId) {
    var imp = impegnati(origineId, tranneDdtId);
    return C.lotti(App.S, articoloId, origineId).map(function (l) {
      return { lotto: l.lotto, scadenza: l.scadenza, quantita: r3(l.quantita - (imp[articoloId + '|' + l.lotto] || 0)) };
    }).filter(function (l) { return l.quantita > 0; });
  }

  /* Codice da stampare: codice interno, altrimenti AIC o EAN dai codici a barre. */
  function codiceArticolo(a) {
    if (!a) return '';
    if (a.codice) return a.codice;
    var k = (a.barcode || []).filter(function (x) { return /^aic:/.test(x); })[0] || (a.barcode || [])[0];
    return k && root.Barcode ? root.Barcode.descrivi(k) : '';
  }

  function etichetta(stati, stato) {
    var s = stati[stato] || { testo: stato, classe: '' };
    return '<span class="etichetta ' + s.classe + '">' + h(s.testo) + '</span>';
  }

  function barra(percentuale, titolo) {
    var p = Math.max(0, Math.min(100, Math.round(percentuale || 0)));
    return '<span class="log-barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + p + '" aria-label="' + h(titolo || 'Spedito') + '">' +
      '<span class="log-barra-piena" style="width:' + p + '%"></span></span><span class="log-perc">' + p + '%</span>';
  }

  /* Scrittura sul server e risincronizzazione; un conflitto (409) o un "non trovato" ricaricano i dati prima dell'errore. */
  function scrivi(metodo, percorso, corpo) {
    return root.Api.scrivi(metodo, percorso, corpo).catch(function (e) {
      if (e && (e.stato === 409 || e.stato === 404)) return root.Api.sincronizza().then(function () { throw e; }, function () { throw e; });
      throw e;
    });
  }

  /* Pulsante occupato durante una scrittura. */
  function occupa(btn, promessa) {
    if (btn) btn.disabled = true;
    return promessa.then(function (x) { if (btn) btn.disabled = false; return x; }, function (e) { if (btn) btn.disabled = false; throw e; });
  }

  /* ======================= componenti ======================= */

  function scheda(titolo, corpo, extraTesta, stretto, classe) {
    return '<section class="scheda' + (classe ? ' ' + classe : '') + '"><div class="scheda-testa"><h2>' + titolo + '</h2>' + (extraTesta || '') + '</div>' +
      '<div class="scheda-corpo' + (stretto ? ' stretto' : '') + '">' + corpo + '</div></section>';
  }

  function vuoto(titolo, testo) { return '<div class="vuoto"><b>' + h(titolo) + '</b>' + (testo || '') + '</div>'; }

  /* Schede (tab) accessibili: frecce, Home e Fine si spostano fra le schede. */
  function htmlSchede(prefisso, nome, voci, attiva) {
    return '<div class="log-schede" role="tablist" aria-label="' + h(nome) + '">' + voci.map(function (v) {
      var sel = v.id === attiva;
      return '<button type="button" role="tab" id="' + prefisso + '-' + v.id + '" data-scheda="' + v.id + '" aria-selected="' + sel + '" aria-controls="' + prefisso + '-pannello" tabindex="' + (sel ? '0' : '-1') + '">' +
        h(v.testo) + (v.n ? ' <span class="log-conta" aria-label="' + v.n + ' elementi">' + v.n + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }

  function collegaSchede(cont, prefisso, alCambio) {
    var lista = cont.querySelector('.log-schede');
    if (!lista) return;
    function scegli(b, fuoco) {
      lista.querySelectorAll('[role=tab]').forEach(function (x) {
        var s = x === b;
        x.setAttribute('aria-selected', s ? 'true' : 'false');
        x.tabIndex = s ? 0 : -1;
      });
      var pannello = cont.querySelector('#' + prefisso + '-pannello');
      if (pannello) pannello.setAttribute('aria-labelledby', b.id);
      if (fuoco) b.focus();
      alCambio(b.getAttribute('data-scheda'));
    }
    lista.addEventListener('click', function (e) { var b = e.target.closest('[role=tab]'); if (b) scegli(b, false); });
    lista.addEventListener('keydown', function (e) {
      var tabs = Array.prototype.slice.call(lista.querySelectorAll('[role=tab]'));
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
      if (j === null) return;
      e.preventDefault();
      scegli(tabs[(j + tabs.length) % tabs.length], true);
    });
  }

  /*
   * Cronologia dei passaggi: [{ titolo, quando (ISO), chi, nota, stato: 'fatto'|'attesa'|'errore' }].
   * La linea si riempie fino all'ultimo passaggio fatto; i passaggi compaiono a cascata (Motion, rispetta "riduci movimento").
   */
  function htmlCronologia(passi) {
    return '<div class="log-cron"><span class="log-traccia" aria-hidden="true"><span class="log-traccia-piena"></span></span>' +
      '<ol class="log-cronologia" aria-label="Cronologia dei passaggi">' + passi.map(function (p) {
        var st = p.stato || 'fatto';
        return '<li class="log-passo ' + st + '">' +
          '<span class="log-punto" aria-hidden="true">' + (st === 'attesa' ? '' : st === 'errore' ? '!' : '✓') + '</span>' +
          '<div class="log-passo-testo"><span class="log-passo-titolo">' + h(p.titolo) + '</span>' +
          (st === 'attesa' ? '<span class="log-sr"> (da fare)</span>' : '') +
          (p.quando ? ' <time datetime="' + h(p.quando) + '">' + h(App.fmtDataOra(p.quando)) + '</time>' : '') +
          (p.chi ? '<div class="piccolo">' + h(p.chi) + '</div>' : '') +
          (p.nota ? '<div class="piccolo tenue">' + h(p.nota) + '</div>' : '') +
          '</div></li>';
      }).join('') + '</ol></div>';
  }

  function animaCronologia(cont) {
    var box = cont.querySelector('.log-cron');
    if (!box) return;
    var fatti = box.querySelectorAll('.log-passo:not(.attesa)');
    var ultimo = fatti[fatti.length - 1];
    var piena = box.querySelector('.log-traccia-piena');
    var altezza = ultimo ? ultimo.offsetTop + 12 : 0;
    var ridotto = root.Motion ? root.Motion.ridotto() : true;
    if (root.Motion) root.Motion.entra(box.querySelectorAll('.log-passo'), { ritardo: 70, distanza: 6 });
    if (ridotto) { piena.style.height = altezza + 'px'; return; }
    piena.style.height = '0px';
    requestAnimationFrame(function () { requestAnimationFrame(function () { piena.style.height = altezza + 'px'; }); });
  }

  function passiDdt(d, conRichiesta) {
    var passi = [];
    var titolo = conRichiesta ? 'DDT ' + d.numero + ' ' : '';
    passi.push({ titolo: titolo + (conRichiesta ? 'preparato' : 'Preparato'), quando: d.preparatoIl, chi: d.preparatoDaNome, nota: conRichiesta ? '' : nomeMag(d.origineId) + ' → ' + nomeMag(d.destinazioneId) });
    if (d.stato === 'annullato') {
      if (d.partitoIl) passi.push({ titolo: titolo + (conRichiesta ? 'partito' : 'Partito'), quando: d.partitoIl, chi: 'Trasportato da ' + d.trasportatoreNome });
      passi.push({ titolo: titolo + (conRichiesta ? 'annullato' : 'Annullato'), quando: d.annullatoIl, chi: d.annullatoDa, nota: d.motivoAnnullo + (d.partitoIl ? ' · la merce è rientrata in ' + nomeMag(d.origineId) : ''), stato: 'errore' });
      return passi;
    }
    if (d.partitoIl) passi.push({ titolo: titolo + (conRichiesta ? 'partito' : 'Partito'), quando: d.partitoIl, chi: 'Trasportato da ' + d.trasportatoreNome, nota: d.colli + (d.colli === 1 ? ' collo' : ' colli') });
    else passi.push({ titolo: 'Spedizione', stato: 'attesa', nota: 'Si indica chi trasporta la merce' });
    if (d.ricevutoIl) {
      passi.push({ titolo: titolo + (conRichiesta ? 'ricevuto' : 'Ricevuto') + (d.stato === 'ricevuto_con_differenze' ? ' con differenze' : ''), quando: d.ricevutoIl, chi: d.ricevutoDaNome,
        nota: d.noteRicezione || '', stato: d.stato === 'ricevuto_con_differenze' ? 'errore' : 'fatto' });
    } else if (!conRichiesta || d.partitoIl) {
      passi.push({ titolo: 'Ricezione in ' + nomeMag(d.destinazioneId), stato: 'attesa' });
    }
    return passi;
  }

  function passiRichiesta(r) {
    var passi = [{ titolo: 'Richiesta scritta', quando: r.creataIl, chi: r.creataDaNome, nota: nomeMag(r.repartoId) }];
    if (r.inviataIl) passi.push({ titolo: 'Inviata a ' + nomeMag(r.fornitoreId), quando: r.inviataIl });
    else if (r.stato === 'bozza') passi.push({ titolo: 'Invio a ' + nomeMag(r.fornitoreId), stato: 'attesa' });
    if (r.presaIl) passi.push({ titolo: 'Presa in carico', quando: r.presaIl, chi: r.presaDaNome });
    else if (r.stato === 'inviata') passi.push({ titolo: 'Presa in carico dalla farmacia', stato: 'attesa' });
    var ddt = ddtDellaRichiesta(r.id);
    ddt.forEach(function (d) { passi = passi.concat(passiDdt(d, true).filter(function (p) { return p.stato !== 'attesa'; })); });
    ddt.filter(function (d) { return d.stato === 'in_preparazione'; }).forEach(function (d) { passi.push({ titolo: 'Spedizione del DDT ' + d.numero, stato: 'attesa' }); });
    var inViaggio = ddt.filter(function (d) { return d.stato === 'in_transito'; });
    if (r.stato === 'in_lavorazione' && !ddt.some(function (d) { return d.stato === 'in_preparazione' || d.stato === 'in_transito'; })) {
      passi.push({ titolo: 'Preparazione del DDT', stato: 'attesa' });
    }
    inViaggio.forEach(function (d) { passi.push({ titolo: 'Ricezione del DDT ' + d.numero, stato: 'attesa' }); });
    var fine = { evasa: 'Richiesta evasa', chiusa: 'Chiusa con residuo', rifiutata: 'Rifiutata', annullata: 'Annullata' }[r.stato];
    if (fine) passi.push({ titolo: fine, quando: r.chiusaIl, chi: r.chiusaDaNome, nota: r.stato === 'evasa' ? 'Tutto l’approvato è partito' : r.motivo, stato: r.stato === 'evasa' || r.stato === 'chiusa' ? 'fatto' : 'errore' });
    // in ordine di tempo; i passaggi da fare restano in fondo
    var fatti = passi.filter(function (p) { return p.stato !== 'attesa'; }).sort(function (a, b) { return String(a.quando || '').localeCompare(String(b.quando || '')); });
    return fatti.concat(passi.filter(function (p) { return p.stato === 'attesa'; }));
  }

  /* ---------- editor delle righe (nuova richiesta, nuovo DDT, modifica del DDT) ---------- */

  function datalist(cont) {
    if (cont.querySelector('#dl-log-articoli')) return '';
    return '<datalist id="dl-log-articoli">' + App.articoliAttivi().map(function (a) {
      return '<option value="' + h(a.nome) + '">' + h(a.categoria === 'PRESIDI' ? 'Presidio' : 'Farmaco') + (a.confezione ? ' · ' + h(a.confezione) : '') + '</option>';
    }).join('') + '</datalist>';
  }

  /*
   * cfg: { tbody, lotto (scelta del lotto dal magazzino di partenza), nota, origine() -> id del magazzino di partenza,
   *        info(articolo, tr) -> html sotto l'articolo, tranneDdt (DDT da non contare fra i lotti impegnati) }
   */
  function editorRighe(cfg) {
    var tbody = cfg.tbody;

    function opzioniLotti(articoloId, scelto) {
      var orig = cfg.origine();
      var lotti = articoloId && orig ? lottiLiberi(articoloId, orig, cfg.tranneDdt).filter(function (l) { return l.lotto; }) : [];
      if (scelto && !lotti.some(function (l) { return l.lotto === scelto; })) lotti.unshift({ lotto: scelto, scadenza: '', quantita: 0 });
      return '<option value="">automatico (scade prima)</option>' + lotti.map(function (l) {
        return '<option value="' + h(l.lotto) + '"' + (l.lotto === scelto ? ' selected' : '') + '>' + h(l.lotto) +
          (l.quantita ? ' · liberi ' + App.fmtNum(l.quantita) : '') + (l.scadenza ? ' · ' + App.fmtScadenza(l.scadenza) : '') + '</option>';
      }).join('');
    }

    function articoloDi(tr) { return App.articoloPerNome(tr.querySelector('.r-art').value); }

    function aggiornaInfo(tr) {
      var testo = tr.querySelector('.r-art').value.trim();
      var info = tr.querySelector('.info-riga');
      var a = articoloDi(tr);
      if (!testo) info.innerHTML = '';
      else if (!a) info.innerHTML = '<span class="log-errore">Articolo non in anagrafica</span>';
      else info.innerHTML = cfg.info ? cfg.info(a, tr) : '';
      var sel = tr.querySelector('.r-lotto-scelta');
      if (sel && sel.getAttribute('data-per') !== (a ? a.id : '')) {
        sel.innerHTML = opzioniLotti(a ? a.id : '', '');
        sel.setAttribute('data-per', a ? a.id : '');
      }
    }

    function nuova(dati) {
      dati = dati || {};
      var a = dati.articoloId ? App.articolo(dati.articoloId) : null;
      var tr = document.createElement('tr');
      if (dati.richiestaRigaId) tr.setAttribute('data-riga-richiesta', dati.richiestaRigaId);
      if (dati.id) tr.setAttribute('data-id', dati.id);
      tr.innerHTML = '<td class="log-c-art"><input class="r-art" list="dl-log-articoli" aria-label="Articolo" placeholder="Scrivi le prime lettere…" autocomplete="off" value="' + h(a ? a.nome : '') + '"' +
        (dati.richiestaRigaId ? ' readonly title="Riga della richiesta: l’articolo non si cambia"' : '') + '><div class="info-riga"></div></td>' +
        '<td class="log-c-q"><input class="q r-q" inputmode="decimal" aria-label="Quantità" placeholder="0" value="' + h(dati.quantita ? App.fmtCampo(dati.quantita) : '') + '"></td>' +
        (cfg.lotto ? '<td class="log-c-lotto"><select class="r-lotto-scelta" aria-label="Lotto" data-per="' + h(a ? a.id : '') + '">' + opzioniLotti(a ? a.id : '', dati.lotto || '') + '</select></td>' : '') +
        (cfg.nota ? '<td class="log-c-nota"><input class="r-nota" aria-label="Nota" maxlength="200" placeholder="Nota (facoltativa)" value="' + h(dati.nota || '') + '"></td>' : '') +
        '<td class="log-c-togli"><button class="btn fantasma piccolo" type="button" data-togli aria-label="Togli la riga" title="Togli la riga">✕</button></td>';
      tbody.appendChild(tr);
      if (a) aggiornaInfo(tr);
      return tr;
    }

    function vuota() {
      return Array.prototype.filter.call(tbody.querySelectorAll('tr'), function (tr) {
        return !tr.querySelector('.r-art').value.trim() && !tr.querySelector('.r-q').value.trim();
      })[0] || null;
    }

    tbody.addEventListener('input', function (e) {
      inModifica = true;
      if (e.target.classList.contains('r-art')) aggiornaInfo(e.target.closest('tr'));
    });
    tbody.addEventListener('change', function () { inModifica = true; });
    tbody.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      var tr = e.target.closest('tr');
      var dopo = tr.nextElementSibling || nuova();
      dopo.querySelector('.r-art').focus();
    });
    tbody.addEventListener('click', function (e) {
      var b = e.target.closest('[data-togli]');
      if (!b) return;
      var tr = b.closest('tr');
      var prossima = tr.nextElementSibling || tr.previousElementSibling;
      tr.remove();
      inModifica = true;
      if (!tbody.children.length) prossima = nuova();
      if (prossima) prossima.querySelector('.r-art').focus();
    });

    /* Una lettura del codice a barre: aumenta la riga dello stesso articolo (e lotto) o ne aggiunge una. */
    function lettura(info, a, passo) {
      var lottoScelto = '';
      var nota = '';
      if (cfg.lotto && info.lotto) {
        if (lottiLiberi(a.id, cfg.origine(), cfg.tranneDdt).some(function (l) { return l.lotto === info.lotto; })) lottoScelto = info.lotto;
        else nota = ' · il lotto ' + info.lotto + ' non è libero in ' + nomeMag(cfg.origine()) + ': uso quello che scade prima';
      }
      var tr = Array.prototype.filter.call(tbody.querySelectorAll('tr'), function (x) {
        var y = articoloDi(x);
        if (!y || y.id !== a.id) return false;
        var sel = x.querySelector('.r-lotto-scelta');
        return !sel || sel.value === lottoScelto;
      })[0];
      if (!tr) {
        tr = vuota() || nuova();
        tr.querySelector('.r-art').value = a.nome;
        aggiornaInfo(tr);
        var sel = tr.querySelector('.r-lotto-scelta');
        if (sel) sel.value = lottoScelto;
        if (!vuota()) nuova();
      }
      var q = tr.querySelector('.r-q');
      q.value = App.fmtCampo(r3(App.numero(q.value) + passo));
      inModifica = true;
      if (root.Scanner) root.Scanner.evidenzia(tr);
      return 'Letto: ' + a.nome + ' (+' + App.fmtNum(passo) + ')' + (lottoScelto ? ' · lotto ' + lottoScelto : '') + nota;
    }

    /* Righe compilate: { righe: [{ articolo, quantita, lotto, nota, richiestaRigaId, id }], errori: [] } */
    function leggi() {
      var righe = [];
      var errori = [];
      tbody.querySelectorAll('tr').forEach(function (tr, i) {
        var nome = tr.querySelector('.r-art').value.trim();
        var q = App.numero(tr.querySelector('.r-q').value);
        if (!nome && !q) return;
        var a = App.articoloPerNome(nome);
        if (!a) { errori.push('Riga ' + (i + 1) + ': «' + nome + '» non è in anagrafica.'); return; }
        if (!(q > 0)) { errori.push('Riga ' + (i + 1) + ' (' + a.nome + '): manca la quantità.'); return; }
        var sel = tr.querySelector('.r-lotto-scelta');
        var nota = tr.querySelector('.r-nota');
        righe.push({
          articolo: a, quantita: q, lotto: sel ? sel.value : '', nota: nota ? nota.value.trim() : '',
          richiestaRigaId: tr.getAttribute('data-riga-richiesta') || null, id: tr.getAttribute('data-id') || null
        });
      });
      return { righe: righe, errori: errori };
    }

    function ricalcola() {
      tbody.querySelectorAll('tr').forEach(function (tr) {
        var sel = tr.querySelector('.r-lotto-scelta');
        if (sel) sel.removeAttribute('data-per');
        aggiornaInfo(tr);
      });
    }

    return { nuova: nuova, vuota: vuota, lettura: lettura, leggi: leggi, ricalcola: ricalcola, aggiornaInfo: aggiornaInfo };
  }

  function barraLettore(predefinito, aiuto) {
    return root.Scanner ? root.Scanner.barra({ pagina: App.paginaCorrente, predefinito: predefinito, aiuto: aiuto }) : '';
  }
  function collegaLettore(cont) { if (root.Scanner) root.Scanner.collega(cont); }

  /* ======================= consumo previsto e proposta delle quantità ======================= */

  /*
   * Consumo medio giornaliero di un articolo in un magazzino: dalle previsioni (js/previsioni.js) se ci sono,
   * altrimenti la media delle ultime 4 settimane di consumi e perdite. null se non si sa.
   */
  function consumoGiornaliero(articoloId, repartoId, cacheMedie) {
    var Pr = root.Previsioni;
    if (Pr) {
      try {
        var f = typeof Pr.consumoGiornaliero === 'function' ? Pr.consumoGiornaliero
          : typeof Pr.mediaGiornaliera === 'function' ? Pr.mediaGiornaliera : null;
        if (f) {
          var v = f(App.S, articoloId, repartoId);
          var n = Number(v && typeof v === 'object' ? (v.giornaliero || v.media || v.valore) : v);
          if (isFinite(n) && n > 0) return { valore: n, fonte: 'previsione' };
        }
      } catch (e) { /* previsioni non disponibili: si usa la media */ }
    }
    var m = cacheMedie[repartoId];
    if (!m) {
      m = cacheMedie[repartoId] = {};
      var d = new Date();
      d.setDate(d.getDate() - 28);
      var da = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      S('movimenti').forEach(function (x) {
        if (x.annullato || x.repartoId !== repartoId || x.data < da || (x.tipo !== 'consumo' && x.tipo !== 'perdita')) return;
        m[x.articoloId] = r3((m[x.articoloId] || 0) + x.quantita);
      });
    }
    return m[articoloId] ? { valore: m[articoloId] / 28, fonte: 'media' } : null;
  }

  /* Quanto è già stato chiesto e non ancora arrivato (richieste aperte del magazzino), tranne una richiesta. */
  function giaChiesto(repartoId, tranneId) {
    var out = {};
    S('richieste').forEach(function (r) {
      if (r.repartoId !== repartoId || r.id === tranneId || RICHIESTE_CHIUSE.indexOf(r.stato) >= 0) return;
      C.avanzamentoRichiesta(App.S, r.id).forEach(function (x) { out[x.articoloId] = r3((out[x.articoloId] || 0) + x.residuo + x.inPreparazione); });
    });
    return out;
  }

  /*
   * Proposta di richiesta per un magazzino, dall'assortimento: chi è al punto di riordino (o sotto la minima) si porta
   * alla scorta massima; se c'è il consumo previsto, si copre anche il periodo fino al prossimo rifornimento.
   * Contano giacenza, merce in viaggio e richieste ancora aperte.
   */
  function proposta(repartoId, tranneRichiesta) {
    var viaggio = C.merceInViaggio(App.S);
    var chiesto = giaChiesto(repartoId, tranneRichiesta);
    var giorni = Number(App.S.impostazioni && App.S.impostazioni.periodoRevisioneGiorni) || 7;
    var medie = {};
    var out = [];
    S('assortimento').forEach(function (x) {
      if (x.repartoId !== repartoId || x.attivo === false) return;
      var a = App.articolo(x.articoloId);
      if (!a || a.attivo === false) return;
      var disp = r3(App.giacenza(a.id, repartoId) + (viaggio[a.id + '|' + repartoId] || 0) + (chiesto[a.id] || 0));
      var soglia = x.puntoRiordino > 0 ? x.puntoRiordino : (x.scortaMin > 0 ? x.scortaMin : x.scortaMax);
      var obiettivo = x.scortaMax > 0 ? x.scortaMax : soglia;
      var q = 0;
      var motivo = '';
      if (soglia > 0 && disp <= soglia && obiettivo > disp) {
        q = obiettivo - disp;
        motivo = 'porta alla scorta massima (' + App.fmtNum(obiettivo) + ')';
      }
      var cons = consumoGiornaliero(a.id, repartoId, medie);
      if (cons && (q > 0 || disp < cons.valore * giorni)) {
        var copertura = cons.valore * giorni;
        if (copertura - disp > q) {
          q = copertura - disp;
          motivo = (cons.fonte === 'previsione' ? 'consumo previsto' : 'consumo medio') + ' per ' + giorni + ' giorni (' + App.fmtNum(Math.round(cons.valore * 10) / 10) + ' al giorno)';
        }
      }
      q = Math.ceil(r3(q));
      if (q > 0) out.push({ articolo: a, quantita: q, motivo: motivo });
    });
    return out.sort(function (x, y) { return x.articolo.nome.localeCompare(y.articolo.nome, 'it'); });
  }

  /* ======================= RICHIESTE ======================= */

  P.richieste = function (cont, par) {
    par = par || {};
    inModifica = false;
    if (par.nuova || par.modifica) { formRichiesta(cont, par.modifica || null, par); return; }
    if (par.id) { dettaglioRichiesta(cont, par.id); return; }
    elencoRichieste(cont);
  };

  function schedeRichieste() {
    var voci = [];
    if (App.puo('richieste')) {
      voci.push({ id: 'bozze', testo: 'Da inviare', filtro: function (r) { return r.stato === 'bozza' && App.repartoPermesso(r.repartoId); } });
    }
    if (App.puo('richieste') && !App.puo('evadiRichieste')) {
      voci.push({ id: 'attesa', testo: 'In attesa', filtro: function (r) { return (r.stato === 'inviata' || r.stato === 'in_lavorazione') && App.repartoPermesso(r.repartoId); } });
    }
    if (App.puo('evadiRichieste')) {
      voci.push({ id: 'evadere', testo: 'Da evadere', filtro: function (r) { return (r.stato === 'inviata' || r.stato === 'in_lavorazione') && App.repartoPermesso(r.fornitoreId); } });
    }
    voci.push({ id: 'archivio', testo: 'Archivio', filtro: function (r) { return RICHIESTE_CHIUSE.indexOf(r.stato) >= 0 && richiestaVisibile(r); } });
    voci.forEach(function (v) { v.n = v.id === 'archivio' ? 0 : S('richieste').filter(v.filtro).length; });
    return voci;
  }

  function ordinaRichieste(scheda, lista) {
    return lista.sort(function (a, b) {
      if (scheda === 'evadere') return (b.urgente ? 1 : 0) - (a.urgente ? 1 : 0) || String(a.inviataIl).localeCompare(String(b.inviataIl));
      if (scheda === 'archivio') return String(b.chiusaIl || b.creataIl).localeCompare(String(a.chiusaIl || a.creataIl));
      return String(b.inviataIl || b.creataIl).localeCompare(String(a.inviataIl || a.creataIl));
    });
  }

  function voceRichiesta(r) {
    var t = C.totaliRichiesta(App.S, r.id);
    var nomi = righeRichiesta(r.id).slice(0, 3).map(function (x) { return App.nomeArticolo(x.articoloId); });
    return '<li><button type="button" class="log-voce' + (r.urgente ? ' urgente' : '') + '" data-apri="' + h(r.id) + '">' +
      '<span class="log-voce-testa"><span class="log-numero">' + h(r.numero) + '</span>' + etichetta(STATI_RICHIESTA, r.stato) +
      (r.urgente ? '<span class="etichetta pericolo">Urgente</span>' : '') +
      '<span class="log-quando">' + h(App.fmtDataOra(r.inviataIl || r.creataIl)) + '</span></span>' +
      '<span class="log-percorso"><b>' + h(nomeMag(r.repartoId)) + '</b> <span aria-hidden="true">→</span><span class="log-sr"> chiede a </span> ' + h(nomeMag(r.fornitoreId)) + '</span>' +
      '<span class="log-voce-articoli tenue">' + h(nomi.join(' · ')) + (t.righe > 3 ? ' e altri ' + (t.righe - 3) : '') + '</span>' +
      '<span class="log-voce-piede"><span class="tenue">' + t.righe + (t.righe === 1 ? ' articolo' : ' articoli') + '</span>' +
      (r.stato === 'bozza' ? '' : barra(t.percentuale, 'Spedito')) + '</span>' +
      '</button></li>';
  }

  function elencoRichieste(cont) {
    var voci = schedeRichieste();
    var attiva = schedaRicordata.richieste;
    if (!voci.some(function (v) { return v.id === attiva; })) {
      var evadere = voci.filter(function (v) { return v.id === 'evadere'; })[0];
      var bozze = voci.filter(function (v) { return v.id === 'bozze'; })[0];
      attiva = evadere ? 'evadere' : (bozze && bozze.n ? 'bozze' : (voci.filter(function (v) { return v.id === 'attesa'; })[0] ? 'attesa' : voci[0].id));
    }
    var puoNuova = App.puo('richieste') && App.repartiScrivibili().length > 0;
    cont.innerHTML =
      '<div class="log-testa">' + htmlSchede('ric', 'Richieste', voci, attiva) +
      '<span class="spazio"></span>' +
      '<label class="campo log-cerca"><span>Cerca</span><input type="search" id="ric-cerca" placeholder="Numero, magazzino, articolo…" autocomplete="off"></label>' +
      (puoNuova ? '<button class="btn primario" type="button" id="ric-nuova">+ Nuova richiesta</button>' : '') +
      '</div>' +
      '<div id="ric-pannello" role="tabpanel" aria-labelledby="ric-' + attiva + '" tabindex="-1"></div>';

    function disegna() {
      var v = schedeRichieste().filter(function (x) { return x.id === attiva; })[0];
      if (!v) return;
      var testo = cont.querySelector('#ric-cerca').value.trim().toLowerCase();
      var lista = ordinaRichieste(attiva, S('richieste').filter(v.filtro).filter(function (r) {
        if (!testo) return true;
        var t = (r.numero + ' ' + nomeMag(r.repartoId) + ' ' + nomeMag(r.fornitoreId) + ' ' + r.note + ' ' +
          righeRichiesta(r.id).map(function (x) { return App.nomeArticolo(x.articoloId); }).join(' ')).toLowerCase();
        return t.indexOf(testo) >= 0;
      }));
      var mostrate = lista.slice(0, 200);
      var vuoti = {
        bozze: vuoto('Nessuna richiesta da inviare', puoNuova ? 'Con “+ Nuova richiesta” chiedi alla farmacia quello che serve al tuo magazzino.' : ''),
        attesa: vuoto('Nessuna richiesta in attesa', 'Qui vedi le richieste inviate finché la farmacia non le ha evase.'),
        evadere: vuoto('Nessuna richiesta da evadere', 'Quando un magazzino invia una richiesta compare qui e ricevi un avviso.'),
        archivio: vuoto('Archivio vuoto', 'Le richieste evase, chiuse, rifiutate o annullate.')
      };
      var pannello = cont.querySelector('#ric-pannello');
      pannello.innerHTML = mostrate.length
        ? '<ul class="log-elenco">' + mostrate.map(voceRichiesta).join('') + '</ul>' +
          (lista.length > mostrate.length ? '<p class="piccolo tenue log-nota-elenco">Ne mostro 200 su ' + lista.length + ': usa la ricerca.</p>' : '')
        : (testo ? vuoto('Nessuna richiesta trovata', 'Cambia la ricerca.') : vuoti[attiva]);
      if (root.Motion) root.Motion.entra(pannello.querySelectorAll('.log-voce'), { ritardo: 25, distanza: 6 });
    }

    collegaSchede(cont, 'ric', function (id) {
      attiva = id;
      schedaRicordata.richieste = id;
      disegna();
    });
    cont.querySelector('#ric-cerca').addEventListener('input', disegna);
    cont.addEventListener('click', function (e) {
      var b = e.target.closest('[data-apri]');
      if (b) App.vai('richieste', { id: b.getAttribute('data-apri') });
    });
    var nuova = cont.querySelector('#ric-nuova');
    if (nuova) nuova.addEventListener('click', function () { App.vai('richieste', { nuova: true }); });
    App.rinfresca = function () {
      if (!document.body.contains(cont)) return;
      // i numeri delle schede cambiano con i dati
      schedeRichieste().forEach(function (v) {
        var b = cont.querySelector('#ric-' + v.id);
        if (b) b.innerHTML = h(v.testo) + (v.n ? ' <span class="log-conta" aria-label="' + v.n + ' elementi">' + v.n + '</span>' : '');
      });
      disegna();
    };
    disegna();
  }

  /* ---------- dettaglio della richiesta ---------- */

  function dettaglioRichiesta(cont, id) {
    var r = trova('richieste', id);
    if (!r) {
      cont.innerHTML = '<div class="strumenti"><button class="btn" type="button" id="ric-indietro">← Tutte le richieste</button></div>' +
        scheda('Richiesta non trovata', vuoto('La richiesta non c’è più', 'Forse è stata eliminata: torna all’elenco.'), '', true);
      cont.querySelector('#ric-indietro').addEventListener('click', function () { App.vai('richieste'); });
      return;
    }
    var evade = puoEvadere(r);
    var chiede = puoChiedere(r);
    var aperta = r.stato === 'inviata' || r.stato === 'in_lavorazione';
    var approvabile = evade && aperta;
    var av = C.avanzamentoRichiesta(App.S, r.id);
    var t = C.totaliRichiesta(App.S, r.id);
    var ddt = ddtDellaRichiesta(r.id);
    var conDdt = ddt.some(function (d) { return d.stato !== 'annullato'; });
    var inPreparazione = ddt.filter(function (d) { return d.stato === 'in_preparazione'; });

    var azioni = [];
    if (chiede && (r.stato === 'bozza' || r.stato === 'inviata')) {
      azioni.push('<button class="btn" type="button" id="ric-modifica">✏️ Modifica</button>');
      if (r.stato === 'bozza') azioni.push('<button class="btn primario" type="button" id="ric-invia">📨 Invia a ' + h(nomeMag(r.fornitoreId)) + '</button>');
      azioni.push('<button class="btn pericolo" type="button" id="ric-annulla">Annulla richiesta</button>');
    }
    if (evade && r.stato === 'inviata') azioni.push('<button class="btn" type="button" id="ric-prendi">✋ Prendi in carico</button>');
    if (approvabile && App.puo('ddt')) azioni.push('<button class="btn primario" type="button" id="ric-prepara"' + (t.residuo > 0 ? '' : ' disabled') + '>📦 Prepara DDT</button>');
    if (approvabile) azioni.push('<button class="btn" type="button" id="ric-salva-appr" hidden>Salva le quantità approvate</button>');
    if (evade && r.stato === 'in_lavorazione' && conDdt) azioni.push('<button class="btn" type="button" id="ric-chiudi">Chiudi con residuo</button>');
    if (approvabile && !conDdt) azioni.push('<button class="btn pericolo" type="button" id="ric-rifiuta">Rifiuta</button>');

    var origine = r.fornitoreId;
    var righe = av.map(function (x) {
      var a = App.articolo(x.articoloId);
      var lib = libera(x.articoloId, origine);
      var corto = approvabile && x.residuo > 0 && lib < x.residuo;
      return '<tr data-riga="' + h(x.rigaId) + '">' +
        '<td><a href="#" data-scheda="' + h(x.articoloId) + '">' + h(a ? a.nome : '(articolo eliminato)') + '</a>' +
        (a && codiceArticolo(a) ? '<div class="piccolo tenue mono">' + h(codiceArticolo(a)) + '</div>' : '') +
        (x.nota ? '<div class="piccolo tenue">' + h(x.nota) + '</div>' : '') + '</td>' +
        '<td class="n">' + qta(x.quantita, x.articoloId) + '</td>' +
        '<td class="n">' + (approvabile
          ? '<input class="q ric-appr" inputmode="decimal" aria-label="Quantità approvata di ' + h(a ? a.nome : '') + '" data-riga="' + h(x.rigaId) + '" data-prima="' + h(App.fmtCampo(x.base)) + '" value="' + h(App.fmtCampo(x.base)) + '">'
          : (x.approvata === null ? '<span class="tenue">—</span>' : App.fmtNum(x.approvata))) + '</td>' +
        (evade ? '<td class="n' + (corto ? ' neg' : '') + '" title="Giacenza meno la merce già messa in DDT in preparazione">' + App.fmtNum(lib) + '</td>' : '') +
        '<td class="n">' + (x.inPreparazione ? App.fmtNum(x.inPreparazione) : '<span class="tenue">0</span>') + '</td>' +
        '<td class="n">' + (x.spedita ? App.fmtNum(x.spedita) : '<span class="tenue">0</span>') + '</td>' +
        '<td class="n"><b>' + (RICHIESTE_CHIUSE.indexOf(r.stato) >= 0 || r.stato === 'bozza' ? '<span class="tenue">—</span>' : App.fmtNum(x.residuo)) + '</b></td>' +
        '</tr>';
    }).join('');
    var testaRighe = '<tr><th>Articolo</th><th class="n">Chiesta</th><th class="n">Approvata</th>' +
      (evade ? '<th class="n">Libera in ' + h(nomeMag(origine)) + '</th>' : '') +
      '<th class="n">In DDT</th><th class="n">Partita</th><th class="n">Da preparare</th></tr>';

    var elencoDdt = ddt.length ? '<ul class="log-elenco compatto">' + ddt.map(function (d) {
      return '<li><button type="button" class="log-voce" data-ddt="' + h(d.id) + '"><span class="log-voce-testa"><span class="log-numero">' + h(d.numero) + '</span>' +
        etichetta(STATI_DDT, d.stato) + '<span class="log-quando">' + h(App.fmtDataOra(d.partitoIl || d.preparatoIl)) + '</span></span>' +
        '<span class="tenue piccolo">' + righeDdt(d.id).length + (righeDdt(d.id).length === 1 ? ' riga' : ' righe') + (d.trasportatoreNome ? ' · trasportato da ' + h(d.trasportatoreNome) : '') + '</span></button></li>';
    }).join('') + '</ul>' : vuoto('Nessun DDT', approvabile ? 'Con “Prepara DDT” la farmacia prepara la merce da spedire.' : '');

    cont.innerHTML =
      '<div class="strumenti log-azioni"><button class="btn" type="button" id="ric-indietro">← Tutte le richieste</button><span class="spazio"></span>' + azioni.join('') + '</div>' +
      '<section class="scheda log-intestazione">' +
      '<div class="log-doc"><span class="log-numero grande">' + h(r.numero) + '</span>' + etichetta(STATI_RICHIESTA, r.stato) +
      (r.urgente ? '<span class="etichetta pericolo">Urgente</span>' : '') + '</div>' +
      '<div class="log-percorso grande"><span><span class="log-ruolo">Chiede</span><b>' + h(nomeMag(r.repartoId)) + '</b>' + (pianoMag(r.repartoId) ? ' <span class="tenue">· ' + h(pianoMag(r.repartoId)) + '</span>' : '') + '</span>' +
      '<span class="log-freccia" aria-hidden="true">→</span>' +
      '<span><span class="log-ruolo">A</span><b>' + h(nomeMag(r.fornitoreId)) + '</b>' + (pianoMag(r.fornitoreId) ? ' <span class="tenue">· ' + h(pianoMag(r.fornitoreId)) + '</span>' : '') + '</span></div>' +
      (r.note ? '<p class="log-note">' + h(r.note) + '</p>' : '') +
      (r.motivo && (r.stato === 'rifiutata' || r.stato === 'chiusa' || r.stato === 'annullata') ? '<p class="banda ' + (r.stato === 'rifiutata' ? 'pericolo' : 'info') + '"><b>Motivo:</b> ' + h(r.motivo) + '</p>' : '') +
      (r.stato !== 'bozza' ? '<div class="log-avanzamento"><span class="tenue piccolo">Partito</span> ' + barra(t.percentuale, 'Merce partita') +
        '<span class="piccolo tenue">' + App.fmtNum(t.spedita) + ' su ' + App.fmtNum(t.base) + (t.inPreparazione ? ' · ' + App.fmtNum(t.inPreparazione) + ' in DDT da spedire' : '') + '</span></div>' : '') +
      '</section>' +
      (inPreparazione.length && evade ? '<div class="banda info"><p>Il DDT <b>' + h(inPreparazione[0].numero) + '</b> è pronto da spedire: aprilo per indicare chi trasporta la merce.</p>' +
        '<button class="btn primario" type="button" data-ddt="' + h(inPreparazione[0].id) + '">Apri il DDT</button></div>' : '') +
      '<div class="log-griglia">' +
      scheda('Articoli richiesti', '<div class="tabella-contenitore"><table class="tabella log-tabella"><thead>' + testaRighe + '</thead><tbody>' + righe + '</tbody></table></div>' +
        (approvabile ? '<p class="piccolo tenue log-nota-tabella">Puoi cambiare la quantità approvata (anche più di quella chiesta, per esempio per arrivare alla confezione intera). “Prepara DDT” prepara quello che resta, scegliendo i lotti che scadono prima.</p>' : ''),
      '<span class="nota">' + av.length + (av.length === 1 ? ' articolo' : ' articoli') + '</span>', true) +
      scheda('Cronologia', htmlCronologia(passiRichiesta(r)), '', false, 'log-scheda-cron') +
      '</div>' +
      scheda('DDT di questa richiesta', elencoDdt, '', true);

    animaCronologia(cont);
    var pr = cont.querySelector('.log-avanzamento .log-perc');
    if (pr && root.Motion) root.Motion.conta(pr, 0, t.percentuale, { formato: function (v) { return Math.round(v) + '%'; } });

    function approvazioniCambiate() {
      return Array.prototype.filter.call(cont.querySelectorAll('.ric-appr'), function (i) { return App.numero(i.value) !== App.numero(i.getAttribute('data-prima')); });
    }
    function leggiApprovazioni() {
      return Array.prototype.map.call(cont.querySelectorAll('.ric-appr'), function (i) { return { id: i.getAttribute('data-riga'), approvata: App.numero(i.value) }; });
    }
    var salvaAppr = cont.querySelector('#ric-salva-appr');
    var prepara = cont.querySelector('#ric-prepara');
    cont.addEventListener('input', function (e) {
      if (!e.target.classList.contains('ric-appr')) return;
      inModifica = approvazioniCambiate().length > 0;
      if (salvaAppr) salvaAppr.hidden = !inModifica;
      if (prepara) prepara.disabled = !(t.residuo > 0 || inModifica);
    });
    function salvaApprovazioni() {
      return scrivi('POST', '/api/richieste/' + encodeURIComponent(r.id) + '/approva', { righe: leggiApprovazioni() });
    }

    cont.addEventListener('click', function (e) {
      var s = e.target.closest('[data-scheda]');
      if (s) { e.preventDefault(); App.schedaArticolo(s.getAttribute('data-scheda')); return; }
      var dd = e.target.closest('[data-ddt]');
      if (dd) { App.vai('consegne', { id: dd.getAttribute('data-ddt') }); }
    });
    cont.querySelector('#ric-indietro').addEventListener('click', function () { App.vai('richieste'); });
    function ridisegna() { inModifica = false; if (document.body.contains(cont)) App.vai('richieste', { id: r.id }); }
    function errore(prefisso) { return function (e) { App.avviso(prefisso + messaggio(e), 'errore'); if (e && (e.stato === 409 || e.stato === 404)) ridisegna(); }; }
    var b;
    if ((b = cont.querySelector('#ric-modifica'))) b.addEventListener('click', function () { App.vai('richieste', { modifica: r.id }); });
    if ((b = cont.querySelector('#ric-invia'))) b.addEventListener('click', function () {
      var bt = this;
      occupa(bt, scrivi('POST', '/api/richieste/' + encodeURIComponent(r.id) + '/invia')).then(function () {
        App.avviso('Richiesta ' + r.numero + ' inviata a ' + nomeMag(r.fornitoreId), 'ok');
        ridisegna();
      }, errore('Richiesta non inviata: '));
    });
    if ((b = cont.querySelector('#ric-annulla'))) b.addEventListener('click', function () {
      App.chiedi('Annulla la richiesta', 'Perché annulli la richiesta ' + r.numero + '? Resta nell’archivio come annullata.', '', 'Annulla richiesta').then(function (motivo) {
        if (motivo === null) return;
        scrivi('POST', '/api/richieste/' + encodeURIComponent(r.id) + '/annulla', { motivo: motivo }).then(function () {
          App.avviso('Richiesta ' + r.numero + ' annullata', 'ok');
          ridisegna();
        }, errore('Richiesta non annullata: '));
      });
    });
    if ((b = cont.querySelector('#ric-prendi'))) b.addEventListener('click', function () {
      occupa(this, scrivi('POST', '/api/richieste/' + encodeURIComponent(r.id) + '/prendi')).then(function () {
        App.avviso('Hai preso in carico la richiesta ' + r.numero, 'ok');
        ridisegna();
      }, errore('Non presa in carico: '));
    });
    if (salvaAppr) salvaAppr.addEventListener('click', function () {
      occupa(this, salvaApprovazioni()).then(function () { App.avviso('Quantità approvate salvate', 'ok'); ridisegna(); }, errore('Quantità non salvate: '));
    });
    if ((b = cont.querySelector('#ric-prepara'))) b.addEventListener('click', function () {
      var bt = this;
      // prima le quantità approvate cambiate, poi il DDT con il residuo
      var cambiate = approvazioniCambiate().length > 0;
      var da = {};
      leggiApprovazioni().forEach(function (x) { da[x.id] = x.approvata; });
      var scoperti = av.filter(function (x) {
        var resto = cambiate ? r3((da[x.rigaId] !== undefined ? da[x.rigaId] : x.base) - x.spedita - x.inPreparazione) : x.residuo;
        return resto > 0 && libera(x.articoloId, origine) < resto;
      });
      var conferma = scoperti.length
        ? App.conferma('Merce non sufficiente', 'In ' + h(nomeMag(origine)) + ' non c’è abbastanza merce libera per: <b>' +
          scoperti.map(function (x) { return h(App.nomeArticolo(x.articoloId)); }).join(', ') + '</b>. Preparo il DDT con quello che c’è? Il resto rimane da preparare.', 'Prepara con quello che c’è')
        : Promise.resolve(true);
      conferma.then(function (ok) {
        if (!ok) return;
        var passo = cambiate ? salvaApprovazioni() : Promise.resolve();
        occupa(bt, passo.then(function () { return scrivi('POST', '/api/richieste/' + encodeURIComponent(r.id) + '/ddt', {}); })).then(function (res) {
          inModifica = false;
          var mancano = (res.mancanti || []).map(function (m) { return m.articolo + ' (' + App.fmtNum(m.preparata) + ' su ' + App.fmtNum(m.richiesta) + ')'; });
          App.avviso('Preparato il DDT ' + res.ddt.numero + (mancano.length ? '. Non bastava la merce per: ' + mancano.join(', ') : ''), mancano.length ? 'errore' : 'ok');
          App.vai('consegne', { id: res.ddt.id });
        }, errore('DDT non preparato: '));
      });
    });
    if ((b = cont.querySelector('#ric-chiudi'))) b.addEventListener('click', function () {
      App.chiedi('Chiudi con residuo', 'La richiesta ' + r.numero + ' si chiude così com’è: quello che non è partito non verrà più preparato. Motivo (facoltativo):', '', 'Chiudi la richiesta').then(function (motivo) {
        if (motivo === null) return;
        scrivi('POST', '/api/richieste/' + encodeURIComponent(r.id) + '/chiudi', { motivo: motivo }).then(function () {
          App.avviso('Richiesta ' + r.numero + ' chiusa', 'ok');
          ridisegna();
        }, errore('Richiesta non chiusa: '));
      });
    });
    if ((b = cont.querySelector('#ric-rifiuta'))) b.addEventListener('click', function () {
      App.chiedi('Rifiuta la richiesta', 'Perché rifiuti la richiesta ' + r.numero + '? Il motivo lo legge chi l’ha fatta.', '', 'Rifiuta').then(function (motivo) {
        if (motivo === null) return;
        if (!motivo) { App.avviso('Scrivi il motivo del rifiuto.', 'errore'); return; }
        scrivi('POST', '/api/richieste/' + encodeURIComponent(r.id) + '/rifiuta', { motivo: motivo }).then(function () {
          App.avviso('Richiesta ' + r.numero + ' rifiutata', 'ok');
          ridisegna();
        }, errore('Richiesta non rifiutata: '));
      });
    });
    App.rinfresca = function () { if (document.body.contains(cont) && !inModifica) dettaglioRichiesta(svuota(cont), r.id); };
  }

  /* Contenitore pulito per ridisegnare una vista (gli ascoltatori vecchi se ne vanno con il vecchio). */
  function svuota(cont) {
    var nuovo = cont.cloneNode(false);
    cont.parentNode.replaceChild(nuovo, cont);
    // la lettura del codice dei DDT resta legata alla pagina
    if (App.paginaCorrente === 'consegne' && root.Scanner) root.Scanner.cattura(letturaConsegne, nuovo);
    return nuovo;
  }

  /* ---------- nuova richiesta o modifica ---------- */

  function formRichiesta(cont, idModifica, par) {
    var esistente = idModifica ? trova('richieste', idModifica) : null;
    if (idModifica && (!esistente || (esistente.stato !== 'bozza' && esistente.stato !== 'inviata') || !puoChiedere(esistente))) {
      App.avviso('Questa richiesta non si può più modificare.', 'errore');
      dettaglioRichiesta(cont, idModifica);
      return;
    }
    var scrivibili = App.repartiScrivibili();
    if (!scrivibili.length) {
      cont.innerHTML = scheda('Nessun magazzino', vuoto('Il tuo utente non ha magazzini per cui fare richieste', 'Chiedi all’amministratore di assegnarti i magazzini.'), '', true);
      return;
    }
    var centrale = App.repartoCentrale();
    var rep = esistente ? esistente.repartoId
      : (par.repartoId && scrivibili.some(function (x) { return x.id === par.repartoId; }) ? par.repartoId
        : (scrivibili.filter(function (x) { return !(centrale && x.id === centrale.id); })[0] || scrivibili[0]).id);
    function opzioniFornitore(repId, scelto) {
      var lista = App.repartiAttivi().filter(function (x) { return x.id !== repId; });
      if (!scelto || !lista.some(function (x) { return x.id === scelto; })) scelto = centrale && centrale.id !== repId ? centrale.id : (lista[0] && lista[0].id);
      return lista.map(function (x) {
        return '<option value="' + h(x.id) + '"' + (x.id === scelto ? ' selected' : '') + '>' + h(x.nome) + (x.tipo === 'centrale' || x.centrale ? ' (farmacia centrale)' : '') + '</option>';
      }).join('');
    }
    var titolo = esistente ? 'Modifica la richiesta ' + h(esistente.numero) : 'Nuova richiesta';
    cont.innerHTML = barraLettore('unita', 'Leggi le confezioni con il lettore: ogni lettura aggiunge l’articolo alla richiesta.') +
      '<section class="scheda log-modulo"><div class="scheda-testa"><h2>' + titolo + '</h2>' +
      '<span class="nota">Scrivi gli articoli e le quantità che servono: la farmacia le approva e prepara il DDT.</span></div>' +
      '<div class="scheda-corpo">' + datalist(cont) +
      '<div class="modulo">' +
      '<label class="campo"><span>Magazzino che chiede</span><select id="rn-rep"' + (esistente ? ' disabled' : '') + '>' +
      scrivibili.map(function (x) { return '<option value="' + h(x.id) + '"' + (x.id === rep ? ' selected' : '') + '>' + h(x.nome) + (x.piano ? ' · ' + h(x.piano) : '') + '</option>'; }).join('') + '</select></label>' +
      '<label class="campo"><span>Chiedi a</span><select id="rn-forn"' + (esistente ? ' disabled' : '') + '>' + opzioniFornitore(rep, esistente ? esistente.fornitoreId : '') + '</select></label>' +
      '<label class="spunta log-urgente"><input type="checkbox" id="rn-urgente"' + (esistente && esistente.urgente ? ' checked' : '') + '> Urgente</label>' +
      '<label class="campo largo"><span>Note per la farmacia (facoltative)</span><textarea id="rn-note" maxlength="500" rows="2">' + h(esistente ? esistente.note : '') + '</textarea></label>' +
      '</div>' +
      '<div class="strumenti log-proponi"><button class="btn" type="button" id="rn-proponi">✨ Proponi le quantità</button>' +
      '<span class="piccolo tenue" id="rn-proponi-aiuto">Dall’assortimento del magazzino: porta alla scorta massima quello che è al punto di riordino' +
      ' e copre il consumo previsto (contano giacenza, merce in viaggio e richieste aperte).</span></div>' +
      '<div class="tabella-contenitore log-righe-box"><table class="righe log-righe"><thead><tr><th>Articolo</th><th>Quantità</th><th>Nota</th><th><span class="log-sr">Togli</span></th></tr></thead>' +
      '<tbody id="righe"></tbody></table></div>' +
      '<div class="strumenti log-righe-piede"><button class="btn" type="button" id="riga-piu">+ Aggiungi riga</button></div>' +
      '</div>' +
      '<div class="log-piede-modulo"><button class="btn" type="button" id="rn-annulla">Annulla</button><span class="spazio"></span>' +
      (!esistente || esistente.stato === 'bozza' ? '<button class="btn" type="button" id="rn-bozza">Salva come bozza</button>' : '') +
      '<button class="btn primario" type="button" id="rn-invia">' + (esistente && esistente.stato === 'inviata' ? 'Salva le modifiche' : '📨 Invia la richiesta') + '</button></div>' +
      '</section>';
    collegaLettore(cont);
    var selRep = cont.querySelector('#rn-rep');
    var selForn = cont.querySelector('#rn-forn');
    var viaggio = C.merceInViaggio(App.S);

    var ed = editorRighe({
      tbody: cont.querySelector('#righe'), nota: true,
      origine: function () { return selForn.value; },
      info: function (a) {
        var r = selRep.value;
        var ass = S('assortimento').filter(function (x) { return x.repartoId === r && x.articoloId === a.id; })[0];
        var parti = ['In ' + h(nomeMag(r)) + ': <b>' + App.fmtNum(App.giacenza(a.id, r)) + '</b>' + (a.unita ? ' ' + h(a.unita) : '')];
        if (viaggio[a.id + '|' + r]) parti.push('in viaggio ' + App.fmtNum(viaggio[a.id + '|' + r]));
        if (ass && (ass.scortaMin || ass.scortaMax)) parti.push('scorta ' + App.fmtNum(ass.scortaMin || 0) + '–' + App.fmtNum(ass.scortaMax || 0));
        if (!ass && S('assortimento').some(function (x) { return x.repartoId === r; })) parti.push('<span class="log-attenzione">non è nell’assortimento</span>');
        parti.push(h(nomeMag(selForn.value)) + ' ne ha liberi ' + App.fmtNum(libera(a.id, selForn.value)));
        return parti.join(' · ');
      }
    });
    if (esistente) righeRichiesta(esistente.id).forEach(function (x) { ed.nuova({ articoloId: x.articoloId, quantita: x.quantita, nota: x.nota, id: x.id }); });
    if (par.articoloId) ed.nuova({ articoloId: par.articoloId });
    ed.nuova();

    selRep.addEventListener('change', function () {
      selForn.innerHTML = opzioniFornitore(selRep.value, selForn.value);
      ed.ricalcola();
    });
    selForn.addEventListener('change', function () { ed.ricalcola(); });
    cont.querySelectorAll('#rn-urgente, #rn-note').forEach(function (el) { el.addEventListener('input', function () { inModifica = true; }); });
    cont.querySelector('#riga-piu').addEventListener('click', function () { ed.nuova().querySelector('.r-art').focus(); });

    cont.querySelector('#rn-proponi').addEventListener('click', function () {
      var r = selRep.value;
      if (!S('assortimento').some(function (x) { return x.repartoId === r && x.attivo !== false; })) {
        App.avviso('Per ' + nomeMag(r) + ' non è ancora impostato l’assortimento (scorte minima, di riordino e massima): chiedilo alla farmacia.', 'errore');
        return;
      }
      var lista = proposta(r, esistente ? esistente.id : null);
      if (!lista.length) { App.avviso('Niente da chiedere: in ' + nomeMag(r) + ' gli articoli dell’assortimento sono sopra il punto di riordino.', 'ok'); return; }
      var tbody = cont.querySelector('#righe');
      var aggiunte = 0;
      lista.forEach(function (p) {
        var tr = Array.prototype.filter.call(tbody.querySelectorAll('tr'), function (x) {
          var a = App.articoloPerNome(x.querySelector('.r-art').value);
          return a && a.id === p.articolo.id;
        })[0];
        if (tr) {
          var q = tr.querySelector('.r-q');
          if (App.numero(q.value) < p.quantita) q.value = App.fmtCampo(p.quantita);
        } else {
          tr = ed.vuota() || ed.nuova();
          tr.querySelector('.r-art').value = p.articolo.nome;
          tr.querySelector('.r-q').value = App.fmtCampo(p.quantita);
          ed.aggiornaInfo(tr);
          aggiunte++;
        }
        var info = tr.querySelector('.info-riga');
        if (info && p.motivo) info.innerHTML += ' · <span class="log-proposta">proposta: ' + h(p.motivo) + '</span>';
      });
      if (!ed.vuota()) ed.nuova();
      inModifica = true;
      App.avviso('Proposte ' + lista.length + ' righe (' + aggiunte + ' nuove): controlla le quantità prima di inviare.', 'ok');
    });

    App.gestoreScansione = function (info, a, passo) {
      if (cont.querySelector('#rn-invia').disabled) { App.avviso('Sto salvando: aspetta un attimo e leggi di nuovo il codice.', 'errore'); return false; }
      return ed.lettura(info, a, passo);
    };

    function salva(invia) {
      var lette = ed.leggi();
      if (lette.errori.length) { App.avviso(lette.errori[0], 'errore'); return; }
      if (!lette.righe.length) { App.avviso('Aggiungi almeno un articolo con la quantità.', 'errore'); return; }
      var righe = lette.righe.map(function (x) { return { id: x.id || undefined, articoloId: x.articolo.id, quantita: x.quantita, nota: x.nota }; });
      var dati = { urgente: cont.querySelector('#rn-urgente').checked, note: cont.querySelector('#rn-note').value.trim(), righe: righe };
      var p;
      if (esistente) {
        p = scrivi('PUT', '/api/richieste/' + encodeURIComponent(esistente.id), dati).then(function (res) {
          if (invia && res.richiesta.stato === 'bozza') return scrivi('POST', '/api/richieste/' + encodeURIComponent(esistente.id) + '/invia');
          return res;
        });
      } else {
        dati.repartoId = selRep.value;
        dati.fornitoreId = selForn.value;
        dati.invia = invia;
        p = scrivi('POST', '/api/richieste', dati);
      }
      var bottoni = cont.querySelectorAll('#rn-bozza, #rn-invia');
      bottoni.forEach(function (x) { x.disabled = true; });
      p.then(function (res) {
        inModifica = false;
        var rr = res.richiesta;
        App.avviso(rr.stato === 'bozza' ? 'Richiesta ' + rr.numero + ' salvata: la trovi in “Da inviare”.' : 'Richiesta ' + rr.numero + (esistente && esistente.stato === 'inviata' ? ' aggiornata' : ' inviata a ' + nomeMag(rr.fornitoreId)), 'ok');
        App.vai('richieste', { id: rr.id });
      }, function (e) {
        bottoni.forEach(function (x) { x.disabled = false; });
        App.avviso('Richiesta non salvata: ' + messaggio(e), 'errore');
      });
    }
    var bz = cont.querySelector('#rn-bozza');
    if (bz) bz.addEventListener('click', function () { salva(false); });
    cont.querySelector('#rn-invia').addEventListener('click', function () { salva(true); });
    cont.querySelector('#rn-annulla').addEventListener('click', function () {
      var torna = function () { inModifica = false; App.vai('richieste', esistente ? { id: esistente.id } : {}); };
      if (!inModifica) { torna(); return; }
      App.conferma('Lasci la richiesta?', 'Le modifiche scritte e non salvate si perdono.', 'Lascia senza salvare', true).then(function (ok) { if (ok) torna(); });
    });
    var primo = cont.querySelector('#righe .r-art');
    if (primo && !esistente) primo.focus();
  }

  /* ======================= DDT E CONSEGNE ======================= */

  P.consegne = function (cont, par) {
    par = par || {};
    inModifica = false;
    // il codice a barre (o il QR) di un DDT apre il DDT; gli altri codici seguono la strada di sempre
    if (root.Scanner) root.Scanner.cattura(letturaConsegne, cont);
    if (par.id && par.ricevi) { ricezioneDdt(cont, par.id); return; }
    if (par.id && par.modifica) { modificaDdt(cont, par.id); return; }
    if (par.id) { dettaglioDdt(cont, par.id); return; }
    elencoDdt(cont);
  };

  function apriDdtPerNumero(numero) {
    var trovato = S('ddt').filter(function (d) { return d.numero.toUpperCase() === numero; })[0];
    if (trovato && ddtVisibile(trovato)) {
      if (root.Scanner) root.Scanner.suono('ok');
      App.chiudiModale();
      App.vai('consegne', { id: trovato.id });
      App.avviso('Aperto il DDT ' + trovato.numero, 'ok');
      return true;
    }
    if (root.Scanner) root.Scanner.suono('errore');
    App.avviso(trovato ? 'Il DDT ' + numero + ' non riguarda i tuoi magazzini.' : 'Il DDT ' + numero + ' non c’è: controlla il numero o aggiorna la pagina.', 'errore');
    return false;
  }

  function letturaConsegne(info) {
    var testo = String(info.grezzo || '').trim().toUpperCase();
    var m = document.getElementById('modale');
    var finestra = m && !m.hidden && !m.classList.contains('da-lettura');
    if (NUMERO_DDT.test(testo) && !finestra) {
      if (inModifica) {
        App.conferma('Apri un altro DDT?', 'Stai lavorando su questo DDT e le modifiche non salvate si perdono.', 'Apri ' + testo, true).then(function (ok) {
          if (ok) { inModifica = false; apriDdtPerNumero(testo); }
        });
        return;
      }
      apriDdtPerNumero(testo);
      return;
    }
    // non è un DDT: la lettura va al lettore come sempre (conteggio della ricezione, scheda dell'articolo…)
    var cont = document.getElementById('contenuto');
    root.Scanner.rilascia();
    try { root.Scanner.elabora(info.grezzo, info.origine); } finally {
      if (App.paginaCorrente === 'consegne') root.Scanner.cattura(letturaConsegne, document.getElementById('contenuto') || cont);
    }
  }

  function schedeDdt() {
    var voci = [];
    if (App.puo('ddt')) voci.push({ id: 'preparare', testo: 'Da preparare', filtro: function (d) { return d.stato === 'in_preparazione' && App.repartoPermesso(d.origineId); } });
    voci.push({ id: 'viaggio', testo: 'In viaggio', filtro: function (d) { return d.stato === 'in_transito' && (tuttiIMagazzini() || App.repartoPermesso(d.origineId)); } });
    if (App.puo('riceviDdt')) voci.push({ id: 'ricevere', testo: 'Da ricevere', filtro: daRicevere });
    voci.push({ id: 'archivio', testo: 'Archivio', filtro: function (d) { return DDT_CHIUSI.indexOf(d.stato) >= 0 && ddtVisibile(d); } });
    voci.forEach(function (v) { v.n = v.id === 'archivio' ? 0 : S('ddt').filter(v.filtro).length; });
    return voci;
  }

  function voceDdt(d) {
    var righe = righeDdt(d.id);
    var quando = d.ricevutoIl ? 'Ricevuto ' + App.fmtDataOra(d.ricevutoIl) : d.partitoIl ? 'Partito ' + App.fmtDataOra(d.partitoIl) : 'Preparato ' + App.fmtDataOra(d.preparatoIl);
    return '<li><button type="button" class="log-voce" data-apri="' + h(d.id) + '">' +
      '<span class="log-voce-testa"><span class="log-numero">' + h(d.numero) + '</span>' + etichetta(STATI_DDT, d.stato) +
      '<span class="log-quando">' + h(quando) + '</span></span>' +
      '<span class="log-percorso"><b>' + h(nomeMag(d.origineId)) + '</b> <span aria-hidden="true">→</span><span class="log-sr"> verso </span> <b>' + h(nomeMag(d.destinazioneId)) + '</b>' +
      (pianoMag(d.destinazioneId) ? ' <span class="tenue">· ' + h(pianoMag(d.destinazioneId)) + '</span>' : '') + '</span>' +
      '<span class="log-voce-piede tenue"><span>' + righe.length + (righe.length === 1 ? ' riga' : ' righe') + ' · ' + d.colli + (d.colli === 1 ? ' collo' : ' colli') + '</span>' +
      (d.trasportatoreNome ? '<span>🚚 ' + h(d.trasportatoreNome) + '</span>' : '') + '<span>' + h(d.causale) + '</span></span>' +
      '</button></li>';
  }

  function elencoDdt(cont) {
    var voci = schedeDdt();
    var attiva = schedaRicordata.consegne;
    if (!voci.some(function (v) { return v.id === attiva; })) {
      var conta = {};
      voci.forEach(function (v) { conta[v.id] = v.n; });
      attiva = conta.ricevere ? 'ricevere' : conta.preparare ? 'preparare' : conta.viaggio ? 'viaggio' : (conta.preparare !== undefined ? 'preparare' : voci[0].id);
    }
    cont.innerHTML = barraLettore('unita', 'Leggi il codice a barre o il QR stampato sul DDT per aprirlo; puoi anche scrivere il numero (per esempio DDT-2026-0001) e premere Invio.') +
      '<div class="log-testa">' + htmlSchede('ddt', 'DDT e consegne', voci, attiva) +
      '<span class="spazio"></span>' +
      '<label class="campo log-cerca"><span>Cerca</span><input type="search" id="ddt-cerca" placeholder="Numero, magazzino, trasportatore…" autocomplete="off"></label>' +
      (App.puo('ddt') && App.repartiScrivibili().length ? '<button class="btn primario" type="button" id="ddt-nuovo">+ Nuovo DDT</button>' : '') +
      '</div>' +
      '<div id="ddt-pannello" role="tabpanel" aria-labelledby="ddt-' + attiva + '" tabindex="-1"></div>';
    collegaLettore(cont);
    function disegna() {
      var v = schedeDdt().filter(function (x) { return x.id === attiva; })[0];
      if (!v) return;
      var testo = cont.querySelector('#ddt-cerca').value.trim().toLowerCase();
      var lista = S('ddt').filter(v.filtro).filter(function (d) {
        if (!testo) return true;
        return (d.numero + ' ' + nomeMag(d.origineId) + ' ' + nomeMag(d.destinazioneId) + ' ' + d.trasportatoreNome + ' ' + d.causale).toLowerCase().indexOf(testo) >= 0;
      }).sort(function (a, b) {
        if (attiva === 'archivio') return String(b.ricevutoIl || b.annullatoIl || '').localeCompare(String(a.ricevutoIl || a.annullatoIl || ''));
        return String(a.partitoIl || a.preparatoIl).localeCompare(String(b.partitoIl || b.preparatoIl));
      });
      var mostrati = lista.slice(0, 200);
      var vuoti = {
        preparare: vuoto('Nessun DDT da preparare', 'I DDT nascono dalle richieste (“Prepara DDT”) o dalla pagina Trasferimenti.'),
        viaggio: vuoto('Nessun DDT in viaggio', 'Qui vedi la merce partita e non ancora ricevuta.'),
        ricevere: vuoto('Niente da ricevere', 'Quando un DDT parte verso i tuoi magazzini compare qui e ricevi un avviso.'),
        archivio: vuoto('Archivio vuoto', 'I DDT ricevuti o annullati.')
      };
      var pannello = cont.querySelector('#ddt-pannello');
      pannello.innerHTML = mostrati.length
        ? '<ul class="log-elenco">' + mostrati.map(voceDdt).join('') + '</ul>' +
          (lista.length > mostrati.length ? '<p class="piccolo tenue log-nota-elenco">Ne mostro 200 su ' + lista.length + ': usa la ricerca.</p>' : '')
        : (testo ? vuoto('Nessun DDT trovato', 'Cambia la ricerca.') : vuoti[attiva]);
      if (root.Motion) root.Motion.entra(pannello.querySelectorAll('.log-voce'), { ritardo: 25, distanza: 6 });
    }
    collegaSchede(cont, 'ddt', function (id) { attiva = id; schedaRicordata.consegne = id; disegna(); });
    cont.querySelector('#ddt-cerca').addEventListener('input', disegna);
    cont.addEventListener('click', function (e) {
      var b = e.target.closest('[data-apri]');
      if (b) App.vai('consegne', { id: b.getAttribute('data-apri') });
    });
    var nuovo = cont.querySelector('#ddt-nuovo');
    if (nuovo) nuovo.addEventListener('click', function () { App.vai('trasferimenti'); });
    App.rinfresca = function () {
      if (!document.body.contains(cont)) return;
      schedeDdt().forEach(function (v) {
        var b = cont.querySelector('#ddt-' + v.id);
        if (b) b.innerHTML = h(v.testo) + (v.n ? ' <span class="log-conta" aria-label="' + v.n + ' elementi">' + v.n + '</span>' : '');
      });
      disegna();
    };
    disegna();
  }

  /* ---------- dettaglio del DDT ---------- */

  function intestazioneDdt(d) {
    var ric = d.richiestaId ? trova('richieste', d.richiestaId) : null;
    return '<section class="scheda log-intestazione">' +
      '<div class="log-doc"><span class="log-numero grande">' + h(d.numero) + '</span>' + etichetta(STATI_DDT, d.stato) +
      '<span class="tenue piccolo">' + h(d.causale) + ' · ' + d.colli + (d.colli === 1 ? ' collo' : ' colli') + '</span></div>' +
      '<div class="log-percorso grande"><span><span class="log-ruolo">Da</span><b>' + h(nomeMag(d.origineId)) + '</b>' + (pianoMag(d.origineId) ? ' <span class="tenue">· ' + h(pianoMag(d.origineId)) + '</span>' : '') + '</span>' +
      '<span class="log-freccia" aria-hidden="true">→</span>' +
      '<span><span class="log-ruolo">A</span><b>' + h(nomeMag(d.destinazioneId)) + '</b>' + (pianoMag(d.destinazioneId) ? ' <span class="tenue">· ' + h(pianoMag(d.destinazioneId)) + '</span>' : '') + '</span></div>' +
      (ric ? '<p class="piccolo">Per la richiesta ' + (App.paginaPermessa('richieste') ? '<a href="#" data-richiesta="' + h(ric.id) + '" class="mono">' + h(ric.numero) + '</a>' : '<span class="mono">' + h(ric.numero) + '</span>') +
        (ric.urgente ? ' <span class="etichetta pericolo">Urgente</span>' : '') + '</p>' : '') +
      (d.note ? '<p class="log-note">' + h(d.note) + '</p>' : '') +
      (d.stato === 'annullato' ? '<p class="banda info"><b>Annullato:</b> ' + h(d.motivoAnnullo) + '</p>' : '') +
      '</section>';
  }

  function dettaglioDdt(cont, id) {
    var d = trova('ddt', id);
    if (!d) {
      cont.innerHTML = '<div class="strumenti"><button class="btn" type="button" id="ddt-indietro">← Tutti i DDT</button></div>' +
        scheda('DDT non trovato', vuoto('Il DDT non c’è più', 'Torna all’elenco.'), '', true);
      cont.querySelector('#ddt-indietro').addEventListener('click', function () { App.vai('consegne'); });
      return;
    }
    var righe = righeDdt(d.id);
    var ricevuto = DDT_CHIUSI.indexOf(d.stato) >= 0 && d.stato !== 'annullato';
    var azioni = [];
    if (d.stato === 'in_preparazione' && puoSpedire(d)) {
      azioni.push('<button class="btn" type="button" id="ddt-modifica">✏️ Modifica righe</button>');
      azioni.push('<button class="btn pericolo" type="button" id="ddt-annulla">Annulla DDT</button>');
      azioni.push('<button class="btn primario" type="button" id="ddt-spedisci">🚚 Spedisci</button>');
    }
    if (d.stato === 'in_transito') {
      if (puoSpedire(d)) azioni.push('<button class="btn pericolo" type="button" id="ddt-annulla">Annulla (la merce rientra)</button>');
      if (puoRicevere(d)) azioni.push('<button class="btn primario" type="button" id="ddt-ricevi">📥 Registra la ricezione</button>');
    }
    azioni.unshift('<button class="btn" type="button" id="ddt-stampa">🖨️ Stampa</button>');
    var corpo = righe.map(function (x, i) {
      var a = App.articolo(x.articoloId);
      var diff = ricevuto && x.ricevuta !== null && x.ricevuta < x.quantita;
      return '<tr' + (diff ? ' class="log-differenza"' : '') + '><td class="n tenue">' + (i + 1) + '</td>' +
        '<td><a href="#" data-scheda="' + h(x.articoloId) + '">' + h(a ? a.nome : '(articolo eliminato)') + '</a>' +
        (a && codiceArticolo(a) ? '<div class="piccolo tenue mono">' + h(codiceArticolo(a)) + '</div>' : '') + '</td>' +
        '<td class="mono">' + h(x.lotto || '—') + '</td><td>' + (x.scadenza ? App.fmtScadenza(x.scadenza) : '—') + '</td>' +
        '<td class="n"><b>' + qta(x.quantita, x.articoloId) + '</b></td>' +
        (ricevuto ? '<td class="n">' + (x.ricevuta === null ? '—' : App.fmtNum(x.ricevuta)) + '</td><td>' +
          (diff ? '<span class="etichetta ' + (x.esito === 'perdita' ? 'pericolo' : 'attenzione') + '">' + (x.esito === 'perdita' ? 'perse ' : 'rientrate ') + App.fmtNum(r3(x.quantita - x.ricevuta)) + '</span>' : '<span class="etichetta ok">ok</span>') +
          (x.nota ? '<div class="piccolo tenue">' + h(x.nota) + '</div>' : '') + '</td>' : '') +
        '</tr>';
    }).join('');
    var testa = '<tr><th class="n">#</th><th>Articolo</th><th>Lotto</th><th>Scad.</th><th class="n">Quantità</th>' + (ricevuto ? '<th class="n">Ricevuta</th><th>Esito</th>' : '') + '</tr>';
    cont.innerHTML = barraLettore('unita', 'Leggi il codice di un altro DDT per aprirlo.') +
      '<div class="strumenti log-azioni"><button class="btn" type="button" id="ddt-indietro">← Tutti i DDT</button><span class="spazio"></span>' + azioni.join('') + '</div>' +
      intestazioneDdt(d) +
      (daRicevere(d) && puoRicevere(d) ? '<div class="banda info"><p>La merce è in viaggio verso <b>' + h(nomeMag(d.destinazioneId)) + '</b>: quando arriva controlla le confezioni e registra la ricezione.</p></div>' : '') +
      '<div class="log-griglia">' +
      scheda('Merce', righe.length ? '<div class="tabella-contenitore"><table class="tabella log-tabella"><thead>' + testa + '</thead><tbody>' + corpo + '</tbody></table></div>' : vuoto('Nessuna riga', ''),
        '<span class="nota">' + righe.length + (righe.length === 1 ? ' riga' : ' righe') + '</span>', true) +
      scheda('Cronologia', htmlCronologia(passiDdt(d, false)), '', false, 'log-scheda-cron') +
      '</div>' +
      '<section class="scheda log-codici"><div class="scheda-corpo"><div class="log-codici-box">' + codiciDdt(d.numero, 1.6) + '</div>' +
      '<p class="piccolo tenue">Il codice a barre e il QR contengono il numero del DDT: leggerli con il lettore apre questo DDT.</p></div></section>';
    collegaLettore(cont);
    animaCronologia(cont);

    cont.addEventListener('click', function (e) {
      var s = e.target.closest('[data-scheda]');
      if (s) { e.preventDefault(); App.schedaArticolo(s.getAttribute('data-scheda')); return; }
      var rq = e.target.closest('[data-richiesta]');
      if (rq) { e.preventDefault(); App.vai('richieste', { id: rq.getAttribute('data-richiesta') }); }
    });
    cont.querySelector('#ddt-indietro').addEventListener('click', function () { App.vai('consegne'); });
    cont.querySelector('#ddt-stampa').addEventListener('click', function () { App.stampaDdt(d.id); });
    function ridisegna() { if (document.body.contains(cont)) App.vai('consegne', { id: d.id }); }
    var b;
    if ((b = cont.querySelector('#ddt-modifica'))) b.addEventListener('click', function () { App.vai('consegne', { id: d.id, modifica: true }); });
    if ((b = cont.querySelector('#ddt-ricevi'))) b.addEventListener('click', function () { App.vai('consegne', { id: d.id, ricevi: true }); });
    if ((b = cont.querySelector('#ddt-spedisci'))) b.addEventListener('click', function () { finestraSpedizione(d, ridisegna); });
    if ((b = cont.querySelector('#ddt-annulla'))) b.addEventListener('click', function () {
      var partito = d.stato === 'in_transito';
      App.chiedi('Annulla il DDT ' + d.numero, partito
        ? 'La merce è già partita: annullando il DDT rientra tutta in ' + nomeMag(d.origineId) + '. Perché lo annulli?'
        : 'Il DDT non è ancora partito: le giacenze non cambiano. Perché lo annulli?', '', 'Annulla DDT').then(function (motivo) {
        if (motivo === null) return;
        scrivi('POST', '/api/ddt/' + encodeURIComponent(d.id) + '/annulla', { motivo: motivo }).then(function () {
          App.avviso('DDT ' + d.numero + ' annullato' + (partito ? ': la merce è rientrata in ' + nomeMag(d.origineId) : ''), 'ok');
          ridisegna();
        }, function (e) { App.avviso('DDT non annullato: ' + messaggio(e), 'errore'); ridisegna(); });
      });
    });
    App.rinfresca = function () { if (document.body.contains(cont)) dettaglioDdt(svuota(cont), d.id); };
  }

  /* Code 128 e QR del numero del DDT (SVG). */
  function codiciDdt(numero, modulo) {
    var barre = '';
    var qr = '';
    try { if (root.Codice128) barre = root.Codice128.svg(numero, { altezza: 42, modulo: modulo || 1.4 }); } catch (e) { barre = ''; }
    try {
      if (typeof root.qrcode === 'function') {
        var q = root.qrcode(0, 'M');
        q.addData(numero);
        q.make();
        qr = q.createSvgTag({ cellSize: 3, margin: 2, scalable: true, title: 'QR del DDT ' + numero });
      }
    } catch (e) { qr = ''; }
    return '<span class="log-barre">' + barre + '</span><span class="log-qr">' + qr + '</span>';
  }

  /* ---------- spedizione: chi trasporta ---------- */

  function finestraSpedizione(d, dopo) {
    var utenti = [];
    var corpo = '<p>Chi porta la merce a <b>' + h(nomeMag(d.destinazioneId)) + '</b>' + (pianoMag(d.destinazioneId) ? ' (' + h(pianoMag(d.destinazioneId)) + ')' : '') + '?</p>' +
      '<label class="campo"><span>Trasportatore</span><select id="sp-chi"><option value="">Caricamento…</option></select></label>' +
      '<label class="campo" id="sp-altro-box" hidden><span>Nome e cognome di chi trasporta</span><input id="sp-altro" maxlength="100" autocomplete="off"></label>' +
      '<label class="campo"><span>Colli</span><input id="sp-colli" inputmode="numeric" value="' + h(d.colli || 1) + '"></label>' +
      '<p class="piccolo tenue">Alla partenza la merce esce da ' + h(nomeMag(d.origineId)) + ' e risulta “in viaggio” finché ' + h(nomeMag(d.destinazioneId)) +
      ' non registra la ricezione. Ora e trasportatore restano nella cronologia e sul DDT stampato.</p>';
    App.apriModale({
      titolo: 'Spedisci il DDT ' + d.numero,
      corpo: corpo,
      piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn" type="button" id="sp-stampa">🖨️ Stampa</button>' +
        '<button class="btn primario" type="button" id="sp-ok">🚚 Spedisci adesso</button>',
      dopo: function (m) {
        var sel = m.querySelector('#sp-chi');
        var altroBox = m.querySelector('#sp-altro-box');
        var altro = m.querySelector('#sp-altro');
        root.Api.richiesta('GET', '/api/trasportatori').then(function (r) {
          utenti = (r && r.utenti) || [];
          sel.innerHTML = '<option value="">— scegli —</option>' + utenti.map(function (u) {
            return '<option value="' + h(u.id) + '">' + h(u.nome) + ' · ' + h(App.nomeRuolo(u.ruolo)) + '</option>';
          }).join('') + '<option value="altro">Un’altra persona (scrivi il nome)…</option>';
        }, function () {
          sel.innerHTML = '<option value="altro">Un’altra persona (scrivi il nome)…</option>';
          altroBox.hidden = false;
        });
        sel.addEventListener('change', function () {
          altroBox.hidden = sel.value !== 'altro';
          if (!altroBox.hidden) altro.focus();
        });
        m.querySelector('#sp-stampa').addEventListener('click', function () { App.stampaDdt(d.id); });
        m.querySelector('#sp-ok').addEventListener('click', function () {
          var corpoRichiesta = { colli: Math.round(App.numero(m.querySelector('#sp-colli').value)) || 1 };
          if (sel.value === 'altro') corpoRichiesta.trasportatoreNome = altro.value.trim();
          else if (sel.value) corpoRichiesta.trasportatoreId = sel.value;
          if (!corpoRichiesta.trasportatoreNome && !corpoRichiesta.trasportatoreId) { App.avviso('Indica chi trasporta la merce.', 'errore'); (sel.value === 'altro' ? altro : sel).focus(); return; }
          occupa(this, scrivi('POST', '/api/ddt/' + encodeURIComponent(d.id) + '/spedisci', corpoRichiesta)).then(function (res) {
            App.chiudiModale();
            App.avviso('DDT ' + d.numero + ' partito con ' + res.ddt.trasportatoreNome, 'ok');
            if (dopo) dopo();
          }, function (e) { App.avviso('DDT non spedito: ' + messaggio(e), 'errore'); });
        });
      }
    });
  }

  /* ---------- modifica delle righe di un DDT in preparazione ---------- */

  function modificaDdt(cont, id) {
    var d = trova('ddt', id);
    if (!d || d.stato !== 'in_preparazione' || !puoSpedire(d)) {
      App.avviso('Questo DDT non si può più modificare.', 'errore');
      dettaglioDdt(cont, id);
      return;
    }
    cont.innerHTML = barraLettore('unita', 'Leggi le confezioni: ogni lettura aggiunge l’articolo al DDT.') +
      '<section class="scheda log-modulo"><div class="scheda-testa"><h2>Modifica il DDT ' + h(d.numero) + '</h2>' +
      '<span class="nota">' + h(nomeMag(d.origineId)) + ' → ' + h(nomeMag(d.destinazioneId)) + '</span></div>' +
      '<div class="scheda-corpo">' + datalist(cont) +
      '<div class="modulo">' +
      '<label class="campo"><span>Causale</span><input id="md-causale" maxlength="100" list="dl-log-causali" value="' + h(d.causale) + '"></label>' +
      '<label class="campo"><span>Colli</span><input id="md-colli" inputmode="numeric" value="' + h(d.colli) + '"></label>' +
      '<label class="campo largo"><span>Note</span><input id="md-note" maxlength="500" value="' + h(d.note) + '"></label>' +
      '</div><datalist id="dl-log-causali">' + CAUSALI.map(function (c) { return '<option value="' + h(c) + '">'; }).join('') + '</datalist>' +
      '<div class="tabella-contenitore log-righe-box"><table class="righe log-righe"><thead><tr><th>Articolo</th><th>Quantità</th><th>Lotto</th><th><span class="log-sr">Togli</span></th></tr></thead>' +
      '<tbody id="righe"></tbody></table></div>' +
      '<div class="strumenti log-righe-piede"><button class="btn" type="button" id="riga-piu">+ Aggiungi riga</button>' +
      '<span class="piccolo tenue">Le righe della richiesta non superano la quantità approvata. Lotto “automatico”: parte prima quello che scade prima.</span></div>' +
      '</div><div class="log-piede-modulo"><button class="btn" type="button" id="md-annulla">Annulla</button><span class="spazio"></span>' +
      '<button class="btn primario" type="button" id="md-salva">Salva il DDT</button></div></section>';
    collegaLettore(cont);
    var ed = editorRighe({
      tbody: cont.querySelector('#righe'), lotto: true, tranneDdt: d.id,
      origine: function () { return d.origineId; },
      info: function (a) {
        return 'In ' + h(nomeMag(d.origineId)) + ' liberi <b>' + App.fmtNum(libera(a.id, d.origineId, d.id)) + '</b>' + (a.unita ? ' ' + h(a.unita) : '');
      }
    });
    righeDdt(d.id).forEach(function (x) { ed.nuova({ articoloId: x.articoloId, quantita: x.quantita, lotto: x.lotto, richiestaRigaId: x.richiestaRigaId }); });
    ed.nuova();
    cont.querySelector('#riga-piu').addEventListener('click', function () { ed.nuova().querySelector('.r-art').focus(); });
    cont.querySelectorAll('#md-causale, #md-colli, #md-note').forEach(function (el) { el.addEventListener('input', function () { inModifica = true; }); });
    App.gestoreScansione = function (info, a, passo) { return ed.lettura(info, a, passo); };
    cont.querySelector('#md-annulla').addEventListener('click', function () { inModifica = false; App.vai('consegne', { id: d.id }); });
    cont.querySelector('#md-salva').addEventListener('click', function () {
      var lette = ed.leggi();
      if (lette.errori.length) { App.avviso(lette.errori[0], 'errore'); return; }
      if (!lette.righe.length) { App.avviso('Il DDT deve avere almeno una riga: per toglierlo usa “Annulla DDT”.', 'errore'); return; }
      var corpo = {
        causale: cont.querySelector('#md-causale').value.trim(), colli: Math.round(App.numero(cont.querySelector('#md-colli').value)) || 1,
        note: cont.querySelector('#md-note').value.trim(),
        righe: lette.righe.map(function (x) { return { articoloId: x.articolo.id, quantita: x.quantita, lotto: x.lotto || undefined, richiestaRigaId: x.richiestaRigaId || undefined }; })
      };
      occupa(this, scrivi('PUT', '/api/ddt/' + encodeURIComponent(d.id), corpo)).then(function () {
        inModifica = false;
        App.avviso('DDT ' + d.numero + ' salvato', 'ok');
        App.vai('consegne', { id: d.id });
      }, function (e) { App.avviso('DDT non salvato: ' + messaggio(e), 'errore'); });
    });
  }

  /* ---------- ricezione riga per riga ---------- */

  function ricezioneDdt(cont, id) {
    var d = trova('ddt', id);
    if (!d || d.stato !== 'in_transito' || !puoRicevere(d)) {
      App.avviso(d && d.stato !== 'in_transito' ? 'Il DDT ' + d.numero + ' non è in viaggio: non c’è niente da ricevere.' : 'Non puoi ricevere questo DDT.', 'errore');
      dettaglioDdt(cont, id);
      return;
    }
    var righe = righeDdt(d.id);
    var conteggio = false;
    cont.innerHTML = barraLettore('unita', 'Leggi le confezioni arrivate: ogni lettura spunta la riga dello stesso articolo (e lotto, dal Data Matrix).') +
      '<section class="scheda log-modulo log-ricezione"><div class="scheda-testa"><h2>Ricezione del DDT ' + h(d.numero) + '</h2>' +
      '<span class="nota">Da ' + h(nomeMag(d.origineId)) + ' · partito ' + h(App.fmtDataOra(d.partitoIl)) + ' con ' + h(d.trasportatoreNome) + '</span></div>' +
      '<div class="scheda-corpo">' +
      '<div class="banda info" id="rc-banda"><p>Controlla le confezioni: la quantità ricevuta è già quella partita. Se manca qualcosa correggila e indica se rientra in ' +
      h(nomeMag(d.origineId)) + ' o se è persa in viaggio. Con il lettore puoi contarle una per una.</p></div>' +
      '<div class="tabella-contenitore"><table class="tabella log-tabella log-tab-ricezione"><thead><tr><th>Articolo</th><th>Lotto</th><th class="n">Partita</th><th class="n">Ricevuta</th><th>Se manca qualcosa</th><th>Nota</th></tr></thead><tbody>' +
      righe.map(function (x) {
        var a = App.articolo(x.articoloId);
        var nome = a ? a.nome : '(articolo eliminato)';
        return '<tr data-riga="' + h(x.id) + '" data-art="' + h(x.articoloId) + '" data-lotto="' + h(x.lotto) + '" data-partita="' + x.quantita + '">' +
          '<td>' + h(nome) + (a && codiceArticolo(a) ? '<div class="piccolo tenue mono">' + h(codiceArticolo(a)) + '</div>' : '') + '<div class="rc-stato piccolo"></div></td>' +
          '<td class="mono" data-titolo="Lotto">' + h(x.lotto || '—') + (x.scadenza ? '<div class="piccolo tenue">' + App.fmtScadenza(x.scadenza) + '</div>' : '') + '</td>' +
          '<td class="n" data-titolo="Partita">' + qta(x.quantita, x.articoloId) + '</td>' +
          '<td class="n" data-titolo="Ricevuta"><input class="q rc-ricevuta" inputmode="decimal" aria-label="Quantità ricevuta di ' + h(nome) + '" value="' + h(App.fmtCampo(x.quantita) || '0') + '"></td>' +
          '<td data-titolo="Se manca qualcosa"><select class="rc-esito" aria-label="Cosa fare della differenza di ' + h(nome) + '" disabled><option value="">— nessuna differenza —</option>' +
          '<option value="rientro">Rientra in ' + h(nomeMag(d.origineId)) + '</option><option value="perdita">Persa in viaggio (rotta, smarrita)</option></select></td>' +
          '<td data-titolo="Nota"><input class="rc-nota" maxlength="200" aria-label="Nota per ' + h(nome) + '" placeholder="Facoltativa"></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<label class="campo log-note-ricezione"><span>Note sulla consegna (facoltative)</span><textarea id="rc-note" maxlength="500" rows="2" placeholder="Per esempio: scatola aperta, consegnata alle 15:20…"></textarea></label>' +
      '</div><div class="log-piede-modulo"><button class="btn" type="button" id="rc-annulla">Annulla</button><span class="spazio"></span>' +
      '<span class="piccolo tenue" id="rc-riepilogo" aria-live="polite"></span>' +
      '<button class="btn primario" type="button" id="rc-conferma">✅ Conferma la ricezione</button></div></section>';
    collegaLettore(cont);
    var tbody = cont.querySelector('.log-tab-ricezione tbody');

    function aggiornaRiga(tr) {
      var partita = Number(tr.getAttribute('data-partita'));
      var ric = App.numero(tr.querySelector('.rc-ricevuta').value);
      var sel = tr.querySelector('.rc-esito');
      var stato = tr.querySelector('.rc-stato');
      var diff = r3(partita - ric);
      sel.disabled = !(diff > 0);
      if (!(diff > 0)) sel.value = '';
      else if (!sel.value) sel.options[0].textContent = '— scegli —';
      if (!(diff > 0)) sel.options[0].textContent = '— nessuna differenza —';
      tr.classList.toggle('log-differenza', diff > 0);
      tr.classList.toggle('log-spuntata', diff === 0 && (conteggio || ric === partita));
      stato.innerHTML = ric > partita ? '<span class="log-errore">Più di quanto è partito</span>'
        : diff > 0 ? '<span class="log-attenzione">' + (conteggio ? 'contate ' + App.fmtNum(ric) + ' di ' + App.fmtNum(partita) : 'mancano ' + App.fmtNum(diff)) + '</span>'
          : '<span class="log-ok">✓ ' + (conteggio ? 'tutte contate' : 'arrivate tutte') + '</span>';
    }
    function riepilogo() {
      var diffs = 0;
      tbody.querySelectorAll('tr').forEach(function (tr) {
        aggiornaRiga(tr);
        if (tr.classList.contains('log-differenza')) diffs++;
      });
      cont.querySelector('#rc-riepilogo').textContent = diffs ? diffs + (diffs === 1 ? ' riga con differenze' : ' righe con differenze') : 'Tutto arrivato';
    }
    function avviaConteggio() {
      conteggio = true;
      tbody.querySelectorAll('.rc-ricevuta').forEach(function (i) { i.value = '0'; });
      cont.querySelector('#rc-banda').innerHTML = '<p><b>Stai contando con il lettore:</b> la quantità ricevuta è quella letta. Le confezioni che non leggi risultano mancanti.</p>' +
        '<button class="btn piccolo" type="button" id="rc-torna">Torna alle quantità del DDT</button>';
      cont.querySelector('#rc-torna').addEventListener('click', function () {
        conteggio = false;
        tbody.querySelectorAll('tr').forEach(function (tr) { tr.querySelector('.rc-ricevuta').value = App.fmtCampo(Number(tr.getAttribute('data-partita'))) || '0'; });
        cont.querySelector('#rc-banda').innerHTML = '<p>Quantità ricevute come nel DDT. Correggi solo le righe con differenze.</p>';
        riepilogo();
      });
    }
    tbody.addEventListener('input', function () { inModifica = true; riepilogo(); });
    tbody.addEventListener('change', function () { inModifica = true; });
    riepilogo();

    App.gestoreScansione = function (info, a, passo) {
      var trs = Array.prototype.filter.call(tbody.querySelectorAll('tr'), function (tr) { return tr.getAttribute('data-art') === a.id; });
      if (!trs.length) { App.avviso('«' + a.nome + '» non è in questo DDT.', 'errore'); return false; }
      if (!conteggio) avviaConteggio();
      var tr = (info.lotto && trs.filter(function (x) { return x.getAttribute('data-lotto') === info.lotto; })[0]) ||
        trs.filter(function (x) { return App.numero(x.querySelector('.rc-ricevuta').value) < Number(x.getAttribute('data-partita')); })[0] || trs[0];
      var inp = tr.querySelector('.rc-ricevuta');
      var partita = Number(tr.getAttribute('data-partita'));
      if (r3(App.numero(inp.value) + passo) > partita) {
        // non si riceve più di quanto è partito: la lettura non si conta
        if (root.Scanner) root.Scanner.evidenzia(tr);
        App.avviso('Di «' + a.nome + '» hai già contato tutte le ' + App.fmtNum(partita) + ' confezioni partite: questa lettura non la conto.', 'errore');
        return false;
      }
      inp.value = App.fmtCampo(r3(App.numero(inp.value) + passo)) || '0';
      inModifica = true;
      riepilogo();
      if (root.Scanner) root.Scanner.evidenzia(tr);
      var ora = App.numero(inp.value);
      return 'Contato: ' + a.nome + (tr.getAttribute('data-lotto') ? ' · lotto ' + tr.getAttribute('data-lotto') : '') + ' · ' + App.fmtNum(ora) + ' di ' + App.fmtNum(partita);
    };

    cont.querySelector('#rc-annulla').addEventListener('click', function () {
      var torna = function () { inModifica = false; App.vai('consegne', { id: d.id }); };
      if (!inModifica) { torna(); return; }
      App.conferma('Lasci la ricezione?', 'Le quantità scritte o contate si perdono.', 'Lascia senza registrare', true).then(function (ok) { if (ok) torna(); });
    });
    cont.querySelector('#rc-conferma').addEventListener('click', function () {
      var bt = this;
      var corpo = { note: cont.querySelector('#rc-note').value.trim(), righe: [] };
      var problemi = [];
      var differenze = 0;
      tbody.querySelectorAll('tr').forEach(function (tr) {
        var partita = Number(tr.getAttribute('data-partita'));
        var ric = App.numero(tr.querySelector('.rc-ricevuta').value);
        var esito = tr.querySelector('.rc-esito').value;
        var nome = tr.querySelector('td').firstChild.textContent;
        if (ric > partita) problemi.push(nome + ': più di quanto è partito');
        else if (ric < partita && !esito) problemi.push(nome + ': scegli se la differenza rientra o è persa');
        if (ric < partita) differenze++;
        corpo.righe.push({ id: tr.getAttribute('data-riga'), ricevuta: ric, esito: ric < partita ? esito : undefined, nota: tr.querySelector('.rc-nota').value.trim() });
      });
      if (problemi.length) { App.avviso(problemi[0], 'errore'); return; }
      var conferma = differenze
        ? App.conferma('Ricezione con differenze', 'Su ' + differenze + (differenze === 1 ? ' riga' : ' righe') + ' è arrivato meno di quanto è partito. Registro la ricezione così?', 'Registra la ricezione')
        : Promise.resolve(true);
      conferma.then(function (ok) {
        if (!ok) return;
        occupa(bt, scrivi('POST', '/api/ddt/' + encodeURIComponent(d.id) + '/ricevi', corpo)).then(function (res) {
          inModifica = false;
          App.avviso('Ricezione del DDT ' + d.numero + ' registrata' + (res.ddt.stato === 'ricevuto_con_differenze' ? ' (con differenze)' : ''), 'ok');
          App.vai('consegne', { id: d.id });
        }, function (e) { App.avviso('Ricezione non registrata: ' + messaggio(e), 'errore'); });
      });
    });
  }

  /* ======================= stampa del DDT (A4) ======================= */

  function htmlStampa(d) {
    var imp = (App.S && App.S.impostazioni) || {};
    var righe = righeDdt(d.id);
    var ricevuto = d.stato === 'ricevuto' || d.stato === 'ricevuto_con_differenze';
    var ric = d.richiestaId ? trova('richieste', d.richiestaId) : null;
    var logo = imp.logo === 'nessuno' ? '' : (imp.logo ? imp.logo : 'brand/logo.png');
    function magazzino(id) {
      var r = App.reparto(id) || {};
      return '<b>' + h(r.nome || '—') + '</b>' + (r.piano ? '<br>' + h(r.piano) : '') + (r.descrizione ? '<br><span class="log-st-tenue">' + h(r.descrizione) + '</span>' : '');
    }
    var data = d.partitoIl || d.preparatoIl;
    return '<div class="log-st-pagina">' +
      '<header class="log-st-testa">' +
      '<div class="log-st-struttura">' + (logo ? '<img class="log-st-logo" src="' + h(logo) + '" alt="">' : '') +
      '<div><b>' + h(imp.struttura || '') + '</b><br>' + h(imp.sottotitolo || '') + (imp.societa ? '<br>' + h(imp.societa) + (imp.citta ? ' · ' + h(imp.citta) : '') : '') + '</div></div>' +
      '<div class="log-st-codici">' + codiciDdt(d.numero, 1.2) + '</div>' +
      '</header>' +
      '<h1 class="log-st-titolo">Documento di trasporto interno <span>N. ' + h(d.numero) + '</span></h1>' +
      '<p class="log-st-sotto">Data ' + h(data ? new Date(data).toLocaleDateString('it-IT') : '') +
      (d.stato === 'annullato' ? ' · <b>ANNULLATO</b>' : d.stato === 'in_preparazione' ? ' · in preparazione (non ancora partito)' : '') + '</p>' +
      '<div class="log-st-parti">' +
      '<div><span class="log-st-et">Mittente</span>' + magazzino(d.origineId) + '</div>' +
      '<div><span class="log-st-et">Destinatario</span>' + magazzino(d.destinazioneId) + '</div>' +
      '<div><span class="log-st-et">Causale</span>' + h(d.causale) + (ric && d.causale.indexOf(ric.numero) < 0 ? '<br>Richiesta ' + h(ric.numero) : '') +
      '<br><span class="log-st-et in-riga">Colli</span> ' + h(d.colli) + '</div>' +
      '</div>' +
      '<table class="log-st-righe"><thead><tr><th>#</th><th>Codice / AIC</th><th>Descrizione</th><th>Lotto</th><th>Scadenza</th><th class="n">Quantità</th><th>Unità</th>' +
      (ricevuto ? '<th class="n">Ricevuta</th>' : '') + '</tr></thead><tbody>' +
      righe.map(function (x, i) {
        var a = App.articolo(x.articoloId);
        return '<tr><td>' + (i + 1) + '</td><td class="mono">' + h(codiceArticolo(a)) + '</td><td>' + h(a ? a.nome : '') + '</td>' +
          '<td class="mono">' + h(x.lotto || '—') + '</td><td>' + (x.scadenza ? h(App.fmtScadenza(x.scadenza)) : '—') + '</td>' +
          '<td class="n"><b>' + App.fmtNum(x.quantita) + '</b></td><td>' + h(a && a.unita ? a.unita : '') + '</td>' +
          (ricevuto ? '<td class="n">' + (x.ricevuta === null ? '' : App.fmtNum(x.ricevuta)) + '</td>' : '') + '</tr>';
      }).join('') + '</tbody></table>' +
      (d.note ? '<p class="log-st-note"><b>Note:</b> ' + h(d.note) + '</p>' : '') +
      '<div class="log-st-trasporto"><div><span class="log-st-et">Trasportato da</span>' + h(d.trasportatoreNome || '______________________') + '</div>' +
      '<div><span class="log-st-et">Partenza</span>' + (d.partitoIl ? h(App.fmtDataOra(d.partitoIl)) : '____/____/________ ore ____:____') + '</div>' +
      '<div><span class="log-st-et">Arrivo</span>' + (d.ricevutoIl ? h(App.fmtDataOra(d.ricevutoIl)) : '____/____/________ ore ____:____') + '</div></div>' +
      '<div class="log-st-firme">' +
      '<div><span class="log-st-et">Preparato da</span><span class="log-st-nome">' + h(d.preparatoDaNome || '') + '</span><span class="log-st-linea"></span><span class="log-st-tenue">firma</span></div>' +
      '<div><span class="log-st-et">Trasportato da</span><span class="log-st-nome">' + h(d.trasportatoreNome || '') + '</span><span class="log-st-linea"></span><span class="log-st-tenue">firma</span></div>' +
      '<div><span class="log-st-et">Ricevuto da</span><span class="log-st-nome">' + h(d.ricevutoDaNome || '') + '</span><span class="log-st-linea"></span><span class="log-st-tenue">firma</span></div>' +
      '</div>' +
      '<footer class="log-st-piede">' + h(imp.nomeProdotto || '') + ' · ' + h(imp.struttura || '') + ' · documento interno di movimentazione fra i magazzini della struttura · stampato il ' +
      h(new Date().toLocaleString('it-IT')) + '</footer>' +
      '</div>';
  }

  /* Prepara la pagina da stampare (senza aprire la stampa): restituisce la funzione che la toglie. */
  App.preparaStampaDdt = function (id) {
    var d = trova('ddt', id);
    if (!d) return function () {};
    var vecchio = document.getElementById('log-stampa');
    if (vecchio) vecchio.remove();
    var el = document.createElement('div');
    el.id = 'log-stampa';
    el.className = 'log-stampa';
    el.innerHTML = htmlStampa(d);
    var img = el.querySelector('.log-st-logo');
    if (img) img.addEventListener('error', function () { img.remove(); });
    document.body.appendChild(el);
    document.body.classList.add('stampa-ddt');
    return function () {
      document.body.classList.remove('stampa-ddt');
      el.remove();
    };
  };

  App.stampaDdt = function (id) {
    var togli = App.preparaStampaDdt(id);
    function fine() { root.removeEventListener('afterprint', fine); togli(); }
    root.addEventListener('afterprint', fine);
    setTimeout(function () {
      try { root.print(); } catch (e) { fine(); }
    }, 60);
  };

  /* ======================= TRASFERIMENTI: un DDT tra due magazzini ======================= */

  P.trasferimenti = function (cont, par) {
    par = par || {};
    inModifica = false;
    var origini = App.repartiScrivibili();
    if (!origini.length || !App.puo('ddt')) {
      cont.innerHTML = scheda('Nessun magazzino', vuoto('Il tuo utente non ha magazzini da cui spedire', 'Chiedi all’amministratore di assegnarti i magazzini.'), '', true);
      return;
    }
    var centrale = App.repartoCentrale();
    var da = par.repartoId && origini.some(function (x) { return x.id === par.repartoId; }) ? par.repartoId
      : (centrale && origini.some(function (x) { return x.id === centrale.id; }) ? centrale.id : origini[0].id);
    function opzioniDestinazione(origine, scelto) {
      var lista = App.repartiAttivi().filter(function (x) { return x.id !== origine; });
      if (!scelto || !lista.some(function (x) { return x.id === scelto; })) {
        var c = lista.filter(function (x) { return centrale && x.id === centrale.id; })[0];
        scelto = origine === (centrale && centrale.id) ? (lista[0] && lista[0].id) : (c ? c.id : lista[0] && lista[0].id);
      }
      return lista.map(function (x) {
        return '<option value="' + h(x.id) + '"' + (x.id === scelto ? ' selected' : '') + '>' + h(x.nome) + (x.piano ? ' · ' + h(x.piano) : '') + '</option>';
      }).join('');
    }
    function causaleProposta(origine, dest) {
      if (centrale && dest === centrale.id) return 'Reso alla farmacia';
      if (centrale && origine === centrale.id) return 'Rifornimento reparto';
      return 'Trasferimento interno';
    }
    cont.innerHTML = barraLettore('unita') +
      '<section class="scheda log-modulo"><div class="scheda-testa"><h2>Nuovo DDT tra magazzini</h2>' +
      '<span class="nota">Per spostare merce fra due magazzini, anche i resi alla farmacia. Il DDT si spedisce e si riceve da “DDT e consegne”.</span></div>' +
      '<div class="scheda-corpo">' + datalist(cont) +
      '<div class="modulo">' +
      '<label class="campo"><span>Da</span><select id="t-da">' + origini.map(function (x) {
        return '<option value="' + h(x.id) + '"' + (x.id === da ? ' selected' : '') + '>' + h(x.nome) + (x.piano ? ' · ' + h(x.piano) : '') + '</option>';
      }).join('') + '</select></label>' +
      '<label class="campo"><span>A</span><select id="t-a">' + opzioniDestinazione(da, par.destinazioneId) + '</select></label>' +
      '<label class="campo"><span>Causale</span><input id="t-causale" maxlength="100" list="dl-log-causali" autocomplete="off"></label>' +
      '<label class="campo"><span>Colli</span><input id="t-colli" inputmode="numeric" value="1"></label>' +
      '<label class="campo largo"><span>Note (chi ritira, per quale paziente o richiesta…)</span><input id="t-note" maxlength="500"></label>' +
      '</div><datalist id="dl-log-causali">' + CAUSALI.map(function (c) { return '<option value="' + h(c) + '">'; }).join('') + '</datalist>' +
      '<div class="tabella-contenitore log-righe-box"><table class="righe log-righe"><thead><tr><th>Articolo</th><th>Quantità</th><th>Lotto</th><th><span class="log-sr">Togli</span></th></tr></thead>' +
      '<tbody id="righe"></tbody></table></div>' +
      '<div class="strumenti log-righe-piede"><button class="btn" type="button" id="riga-piu">+ Aggiungi riga</button>' +
      '<span class="piccolo tenue">Lotto “automatico”: parte prima quello che scade prima. Non si conta la merce già messa in altri DDT in preparazione.</span></div>' +
      '</div><div class="log-piede-modulo"><span class="spazio"></span><button class="btn primario" type="button" id="registra">📦 Prepara il DDT</button></div></section>' +
      '<div id="recenti"></div>';
    collegaLettore(cont);
    var selDa = cont.querySelector('#t-da');
    var selA = cont.querySelector('#t-a');
    var causale = cont.querySelector('#t-causale');
    causale.value = causaleProposta(selDa.value, selA.value);
    var causaleToccata = false;
    causale.addEventListener('input', function () { causaleToccata = true; inModifica = true; });
    var ed = editorRighe({
      tbody: cont.querySelector('#righe'), lotto: true,
      origine: function () { return selDa.value; },
      info: function (a) {
        var g = App.giacenza(a.id, selDa.value);
        var l = libera(a.id, selDa.value);
        return (a.categoria === 'PRESIDI' ? 'Presidio' : 'Farmaco') + ' · in ' + h(nomeMag(selDa.value)) + ': <b>' + App.fmtNum(g) + '</b>' + (a.unita ? ' ' + h(a.unita) : '') +
          (l !== g ? ' · liberi ' + App.fmtNum(l) + ' (il resto è in altri DDT)' : '');
      }
    });
    if (par.articoloId) ed.nuova({ articoloId: par.articoloId });
    ed.nuova();
    if (par.articoloId) cont.querySelector('#righe .r-q').focus();
    selDa.addEventListener('change', function () {
      selA.innerHTML = opzioniDestinazione(selDa.value, selA.value);
      if (!causaleToccata) causale.value = causaleProposta(selDa.value, selA.value);
      ed.ricalcola();
    });
    selA.addEventListener('change', function () { if (!causaleToccata) causale.value = causaleProposta(selDa.value, selA.value); });
    cont.querySelectorAll('#t-colli, #t-note').forEach(function (el) { el.addEventListener('input', function () { inModifica = true; }); });
    cont.querySelector('#riga-piu').addEventListener('click', function () { ed.nuova().querySelector('.r-art').focus(); });
    App.gestoreScansione = function (info, a, passo) {
      if (cont.querySelector('#registra').disabled) { App.avviso('Sto preparando il DDT: aspetta un attimo e leggi di nuovo il codice.', 'errore'); return false; }
      return ed.lettura(info, a, passo);
    };
    cont.querySelector('#registra').addEventListener('click', function () {
      var bt = this;
      var lette = ed.leggi();
      if (lette.errori.length) { App.avviso(lette.errori[0], 'errore'); return; }
      if (!lette.righe.length) { App.avviso('Compila almeno una riga.', 'errore'); return; }
      if (selDa.value === selA.value) { App.avviso('Il magazzino di partenza e quello di arrivo sono uguali.', 'errore'); return; }
      // controllo della merce libera prima di chiamare il server (che ricontrolla comunque)
      var somme = {};
      lette.righe.forEach(function (x) { somme[x.articolo.id] = r3((somme[x.articolo.id] || 0) + x.quantita); });
      var scoperti = Object.keys(somme).filter(function (k) { return somme[k] > libera(k, selDa.value); });
      if (scoperti.length) {
        App.avviso('In ' + nomeMag(selDa.value) + ' non c’è abbastanza merce libera per: ' + scoperti.map(function (k) {
          return App.nomeArticolo(k) + ' (liberi ' + App.fmtNum(libera(k, selDa.value)) + ')';
        }).join(', ') + '.', 'errore');
        return;
      }
      var corpo = {
        origineId: selDa.value, destinazioneId: selA.value, causale: causale.value.trim(), colli: Math.round(App.numero(cont.querySelector('#t-colli').value)) || 1,
        note: cont.querySelector('#t-note').value.trim(),
        righe: lette.righe.map(function (x) { return { articoloId: x.articolo.id, quantita: x.quantita, lotto: x.lotto || undefined }; })
      };
      occupa(bt, scrivi('POST', '/api/ddt', corpo)).then(function (res) {
        inModifica = false;
        App.avviso('Preparato il DDT ' + res.ddt.numero + ': stampalo e spediscilo.', 'ok');
        App.vai('consegne', { id: res.ddt.id });
      }, function (e) { App.avviso('DDT non preparato: ' + messaggio(e), 'errore'); });
    });

    function disegnaRecenti() {
      var lista = S('ddt').filter(function (d) { return App.repartoPermesso(d.origineId) && !d.richiestaId; })
        .sort(function (a, b) { return String(b.preparatoIl).localeCompare(String(a.preparatoIl)); }).slice(0, 8);
      cont.querySelector('#recenti').innerHTML = scheda('Ultimi DDT preparati qui', lista.length ? '<ul class="log-elenco compatto">' + lista.map(voceDdt).join('') + '</ul>'
        : vuoto('Nessun DDT', 'I DDT preparati da questa pagina compaiono qui.'), '<a class="nota" href="#consegne">Tutti i DDT</a>', true);
    }
    disegnaRecenti();
    cont.querySelector('#recenti').addEventListener('click', function (e) {
      var b = e.target.closest('[data-apri]');
      if (b) App.vai('consegne', { id: b.getAttribute('data-apri') });
    });
  };

  /* ======================= contatori del menu e avvisi ======================= */

  App.registraContatore('richieste', function () {
    if (!App.S) return 0;
    if (App.puo('evadiRichieste')) {
      return S('richieste').filter(function (r) { return (r.stato === 'inviata' || r.stato === 'in_lavorazione') && App.repartoPermesso(r.fornitoreId); }).length;
    }
    if (App.puo('richieste')) return S('richieste').filter(function (r) { return r.stato === 'bozza' && App.repartoPermesso(r.repartoId); }).length;
    return 0;
  });

  App.registraContatore('consegne', function () {
    if (!App.S) return 0;
    return S('ddt').filter(function (d) { return (d.stato === 'in_preparazione' && puoSpedire(d)) || daRicevere(d); }).length;
  });

  // stato di richieste e DDT all'ultima sincronizzazione, per accorgersi di cosa è arrivato
  var visti = null;
  var utenteVisto = null;

  function fotografia() {
    var f = { richieste: {}, ddt: {} };
    S('richieste').forEach(function (r) { f.richieste[r.id] = r.stato; });
    S('ddt').forEach(function (d) { f.ddt[d.id] = d.stato; });
    return f;
  }

  function controllaNovita(cambi, opz) {
    if (!App.S || !App.utente) { visti = null; return; }
    var prima = utenteVisto === App.utente.id ? visti : null;
    visti = fotografia();
    utenteVisto = App.utente.id;
    if (!prima || !cambi || cambi.completo || !opz || !opz.remota) return;
    var avvisi = [];
    if (App.puo('evadiRichieste')) {
      S('richieste').forEach(function (r) {
        if (r.stato === 'inviata' && prima.richieste[r.id] !== 'inviata' && App.repartoPermesso(r.fornitoreId) && r.creataDa !== App.utente.id) {
          avvisi.push('📝 Nuova richiesta ' + r.numero + ' da ' + nomeMag(r.repartoId) + (r.urgente ? ' · URGENTE' : ''));
        }
      });
    }
    if (App.puo('riceviDdt')) {
      S('ddt').forEach(function (d) {
        if (d.stato === 'in_transito' && prima.ddt[d.id] !== 'in_transito' && daRicevere(d)) {
          avvisi.push('🚚 In arrivo il DDT ' + d.numero + ' da ' + nomeMag(d.origineId) + (d.trasportatoreNome ? ' (porta ' + d.trasportatoreNome + ')' : ''));
        }
      });
    }
    if (App.puo('richieste')) {
      S('richieste').forEach(function (r) {
        if (r.creataDa === App.utente.id && r.stato === 'rifiutata' && prima.richieste[r.id] && prima.richieste[r.id] !== 'rifiutata') {
          avvisi.push('La richiesta ' + r.numero + ' è stata rifiutata: ' + r.motivo);
        }
      });
    }
    avvisi.slice(0, 4).forEach(function (t) { App.avviso(t, 'ok'); });
    if (avvisi.length > 4) App.avviso('E altre ' + (avvisi.length - 4) + ' novità in Richieste e DDT.', 'ok');
  }

  // dopo ogni sincronizzazione: avvisi e, nelle pagine della logistica senza modifiche in corso, ridisegno
  var dopoOriginale = App.dopoSincronizzazione;
  App.dopoSincronizzazione = function (cambi, opz) {
    var esito = typeof dopoOriginale === 'function' ? dopoOriginale.apply(this, arguments) : undefined;
    try {
      controllaNovita(cambi, opz);
      var toccati = cambi && (cambi.richieste || cambi.richiesteRighe || cambi.ddt || cambi.ddtRighe || cambi.movimenti || cambi.cancellati || cambi.reparti);
      if (opz && opz.remota && toccati && App.pronta && PAGINE_MIE.indexOf(App.paginaCorrente) >= 0 && App.rinfresca && !inModifica) {
        var attivo = document.activeElement;
        var cont = document.getElementById('contenuto');
        if (!(attivo && cont && cont.contains(attivo) && App.inCampo && App.inCampo(attivo) && attivo.type !== 'search')) {
          App.rinfresca();
          App.nascondiBanda();
        }
      }
    } catch (e) {
      if (root.console) root.console.error(e);
    }
    return esito;
  };
})(window);
