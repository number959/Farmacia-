/*
 * Dati di prova, inventati, per imparare a usare il programma (POST /api/demo del server e anteprima).
 * Funzioni pure, senza interfaccia, sempre gli stessi dati per lo stesso giorno (generatore con seme fisso).
 *
 *   DemoFarmacia.crea(C, opz) → { articoli, movimenti }
 *     opz: { centrale: id della farmacia centrale, reparti: [id dei magazzini periferici], oggi: Date,
 *            giorni: quanti giorni di storia (predefinito 150), conOggi: anche qualche consumo di stamattina }
 *     Circa cinque mesi di carichi dai fornitori, rifornimenti settimanali ai magazzini, consumi giornalieri con il ritmo
 *     della settimana (la sala operatoria e gli ambulatori si fermano nel fine settimana) e qualche tendenza (articoli che
 *     si usano sempre di più o sempre di meno), lotti con scadenze diverse (qualcuno già scaduto o in scadenza),
 *     qualche perdita e una rettifica d'inventario. I rifornimenti sono trasferimenti diretti, come nella versione 2.x:
 *     così vanno bene anche per l'archivio della versione per un solo PC.
 *
 *   DemoFarmacia.creaCompleta(C, opz) → { articoli, movimenti, armadi, assortimento, richieste, richiesteRighe, ddt, ddtRighe }
 *     Come crea, ma nel mondo della versione 3.0 (anteprima): i rifornimenti passano da richieste e DDT interni con il
 *     magazzino "In transito", e in più armadi con le ubicazioni, assortimenti con le soglie e il lavoro in corso di oggi
 *     (richieste in bozza, inviate e in lavorazione, DDT in preparazione e in viaggio, uno ricevuto con differenze).
 *     opz in più: { transito: id del magazzino "In transito" (predefinito 'r-transito'),
 *                   persone: { farmacista: { id, nome }, trasportatore: nome, magazzini: { idMagazzino: { id, nome } } } }
 */
(function (root) {
  'use strict';

  /*
   * Anagrafica: [nome, unità, prezzo, principio attivo, pezzi per confezione, attributi, giorni di consegna, fornitore].
   * I primi 15 farmaci e i primi 10 presidi sono quelli della versione 2.x (stessi id demo-f0… e demo-p0…).
   */
  var ALFA = 'Deposito Alfa (prova)';
  var BETA = 'Distribuzione Beta (prova)';
  var GAMMA = 'Presidi Gamma (prova)';
  var FARMACI = [
    ['PARACETAMOLO 1000 mg/100 ml fl ev', 'fl', 1.2, 'Paracetamolo', 10, [], null, ALFA],
    ['KETOROLAC 30 mg/ml f', 'f', 0.45, 'Ketorolac', 10, [], null, ALFA],
    ['TRAMADOLO 100 mg/2 ml f', 'f', 0.6, 'Tramadolo', 5, [], null, ALFA],
    ['CEFAZOLINA 1 g fl', 'fl', 1.9, 'Cefazolina', 10, [], null, BETA],
    ['AMOXICILLINA/AC. CLAVULANICO 1 g cpr', 'cpr', 0.35, 'Amoxicillina + ac. clavulanico', 12, [], null, ALFA],
    ['ENOXAPARINA 4000 UI siringa', 'sir', 3.1, 'Enoxaparina', 10, ['alto-rischio'], null, BETA],
    ['PANTOPRAZOLO 40 mg fl ev', 'fl', 2.2, 'Pantoprazolo', 10, [], null, ALFA],
    ['ONDANSETRON 4 mg/2 ml f', 'f', 0.9, 'Ondansetron', 10, [], null, ALFA],
    ['DESAMETASONE 4 mg/1 ml f', 'f', 0.5, 'Desametasone', 10, [], null, ALFA],
    ['SODIO CLORURO 0,9% 500 ml sacca', 'sacca', 0.95, 'Sodio cloruro', 20, [], 3, BETA],
    ['RINGER LATTATO 500 ml sacca', 'sacca', 1.1, 'Ringer lattato', 20, [], 3, BETA],
    ['LIDOCAINA 2% 10 ml f', 'f', 0.7, 'Lidocaina', 10, [], null, ALFA],
    ['PROPOFOL 1% 20 ml f', 'f', 2.8, 'Propofol', 5, [], null, BETA],
    ['METOCLOPRAMIDE 10 mg/2 ml f', 'f', 0.3, 'Metoclopramide', 10, ['lasa'], null, ALFA],
    ['FUROSEMIDE 20 mg/2 ml f', 'f', 0.4, 'Furosemide', 10, [], null, ALFA],
    ['INSULINA UMANA RAPIDA 100 UI/ml fl', 'fl', 9.8, 'Insulina umana', 1, ['frigo', 'alto-rischio'], null, BETA],
    ['MORFINA CLORIDRATO 10 mg/1 ml f', 'f', 1.6, 'Morfina', 5, ['stupefacente', 'alto-rischio'], 10, BETA],
    ['FENTANIL 0,1 mg/2 ml f', 'f', 1.1, 'Fentanil', 5, ['stupefacente', 'alto-rischio'], 10, BETA],
    ['MIDAZOLAM 5 mg/1 ml f', 'f', 0.8, 'Midazolam', 5, ['stupefacente', 'lasa'], 10, BETA],
    ['ROCURONIO 50 mg/5 ml f', 'f', 4.2, 'Rocuronio', 10, ['frigo', 'alto-rischio'], 14, BETA],
    ['POTASSIO CLORURO 2 mEq/ml 10 ml f', 'f', 0.55, 'Potassio cloruro', 10, ['alto-rischio', 'lasa'], null, ALFA],
    ['ADRENALINA 1 mg/1 ml f', 'f', 0.95, 'Adrenalina', 10, ['urgenza'], null, ALFA],
    ['EPOETINA ALFA 4000 UI siringa', 'sir', 28.5, 'Epoetina alfa', 6, ['frigo'], 14, BETA]
  ];
  var PRESIDI = [
    ['GARZE STERILI 10x10 cm', 'conf', 0.25, '', 50, [], null, GAMMA],
    ['SIRINGHE 10 ml', 'pz', 0.08, '', 100, [], null, GAMMA],
    ['SIRINGHE 5 ml', 'pz', 0.07, '', 100, [], null, GAMMA],
    ['AGO CANNULA 20G', 'pz', 0.9, '', 50, [], null, GAMMA],
    ['AGO CANNULA 18G', 'pz', 0.9, '', 50, [], null, GAMMA],
    ['DEFLUSSORE PER INFUSIONE', 'pz', 0.55, '', 25, [], null, GAMMA],
    ['GUANTI IN NITRILE TG M', 'conf', 6.5, '', 10, [], 5, GAMMA],
    ['CEROTTO IN TNT 5 m x 2,5 cm', 'rotolo', 1.3, '', 12, [], null, GAMMA],
    ['MEDICAZIONE ADESIVA STERILE 10x8 cm', 'pz', 0.35, '', 50, [], null, GAMMA],
    ['CATETERE VESCICALE FOLEY CH14', 'pz', 2.4, '', 10, [], null, GAMMA],
    ['MASCHERINA CHIRURGICA TIPO IIR', 'pz', 0.09, '', 50, [], null, GAMMA],
    ['SACCA RACCOLTA URINE 2 L', 'pz', 0.6, '', 30, [], null, GAMMA],
    ['SET MEDICAZIONE STERILE', 'pz', 1.8, '', 20, [], null, GAMMA]
  ];

  /*
   * Consumo medio al giorno di ogni magazzino (indici: f = farmaci, p = presidi), ritmo della settimana
   * (domenica, lunedì … sabato) e tendenze (fattore alla fine del periodo rispetto all'inizio).
   */
  var PROFILI = {
    degenza: {
      settimana: [0.8, 1.1, 1.05, 1, 1, 1, 0.85],
      f: { 0: 6, 1: 3, 2: 1.5, 3: 2, 4: 5, 5: 7, 6: 4, 7: 1.5, 8: 1, 9: 9, 10: 3, 13: 1.2, 14: 2.5, 15: 0.35, 16: 0.8, 20: 0.6, 21: 0.05, 22: 0.15 },
      p: { 0: 8, 1: 14, 2: 10, 3: 3, 4: 0.8, 5: 6, 6: 1.2, 7: 0.5, 8: 5, 9: 0.4, 10: 20, 11: 1, 12: 1 },
      tendenze: { f5: 1.45, f4: 0.7, f9: 1.2, p10: 0.65 }
    },
    degenza2: {
      settimana: [0.85, 1.05, 1.05, 1, 1, 1, 0.9],
      f: { 0: 4, 1: 2, 2: 1, 3: 1.2, 4: 2, 5: 5, 6: 3.5, 7: 1, 8: 0.8, 9: 7, 10: 2, 13: 1, 14: 4, 15: 0.5, 16: 0.5, 20: 1.2, 21: 0.04, 22: 0.6 },
      p: { 0: 6, 1: 10, 2: 8, 3: 2.5, 4: 0.5, 5: 5, 6: 1, 7: 0.4, 8: 4, 9: 0.6, 10: 16, 11: 1.4, 12: 0.8 },
      tendenze: { f22: 1.6, f14: 1.25, f4: 0.8 }
    },
    sala: {
      settimana: [0.05, 1.25, 1.2, 1.2, 1.2, 1.1, 0.25],
      f: { 0: 3, 1: 3, 3: 5, 7: 4, 8: 3, 9: 6, 10: 8, 11: 5, 12: 6, 16: 0.6, 17: 4, 18: 3, 19: 2, 21: 0.15 },
      p: { 0: 25, 1: 20, 2: 18, 3: 3, 4: 4, 5: 6, 6: 3, 9: 1.5, 10: 30, 12: 4 },
      tendenze: { f12: 1.2, f17: 1.15, f19: 0.85 }
    },
    ambulatori: {
      settimana: [0, 1.2, 1.2, 1.2, 1.2, 1.1, 0.4],
      f: { 0: 0.5, 1: 1.5, 8: 0.8, 11: 2, 21: 0.03 },
      p: { 0: 10, 1: 3, 2: 8, 6: 0.8, 7: 0.6, 8: 8, 10: 15, 12: 2 },
      tendenze: { p8: 1.3, f11: 1.15 }
    }
  };

  // articoli il cui ultimo ordine al fornitore è in ritardo: in farmacia centrale restano sotto scorta
  var IN_RITARDO = ['demo-f3', 'demo-f17', 'demo-p6'];
  // primo lotto con una scadenza vicina (mesi da oggi; negativo = già scaduto): restano nella pagina Scadenze
  var PRIMO_LOTTO = { 'demo-f21': -1, 'demo-f19': 1, 'demo-f15': 2, 'demo-p9': 1, 'demo-f22': 3 };

  /* ---------- utilità ---------- */

  // generatore pseudo-casuale con seme fisso: i dati di prova sono sempre gli stessi
  function casuale(seme) {
    return function () {
      seme = (seme * 1664525 + 1013904223) % 4294967296;
      return seme / 4294967296;
    };
  }
  function normale(rnd) {
    var u = 1 - rnd();
    var v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // consumi di un giorno: numeri interi con la media indicata (Poisson)
  function poisson(rnd, media) {
    if (!(media > 0)) return 0;
    if (media > 30) return Math.max(0, Math.round(media + Math.sqrt(media) * normale(rnd)));
    var limite = Math.exp(-media);
    var k = 0;
    var p = 1;
    do { k++; p *= rnd(); } while (p > limite);
    return k - 1;
  }
  function r3(x) { var v = Math.round((Number(x) || 0) * 1000) / 1000; return v === 0 ? 0 : v; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function data(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function mese(d, piu) { var x = new Date(d.getFullYear(), d.getMonth() + piu, 1); return x.getFullYear() + '-' + pad(x.getMonth() + 1); }
  function arrotonda(n, passo) { return Math.max(passo, Math.ceil(n / passo) * passo); }
  function profiloDi(id) {
    var s = String(id).toLowerCase();
    if (/sala|operator|chirurg/.test(s)) return 'sala';
    if (/ambul/.test(s)) return 'ambulatori';
    if (/2|secondo/.test(s)) return 'degenza2';
    return 'degenza';
  }

  function anagrafica() {
    var out = [];
    FARMACI.forEach(function (f, i) {
      out.push({ id: 'demo-f' + i, nome: f[0], categoria: 'FARMACI', unita: f[1], prezzo: f[2], principio: f[3], pezziConfezione: f[4], attributi: f[5].slice(), leadTime: f[6], fornitore: f[7], attivo: true });
    });
    PRESIDI.forEach(function (p, i) {
      out.push({ id: 'demo-p' + i, nome: p[0], categoria: 'PRESIDI', unita: p[1], prezzo: p[2], principio: '', pezziConfezione: p[4], attributi: p[5].slice(), leadTime: p[6], fornitore: p[7], attivo: true });
    });
    out.forEach(function (a) {
      a.confezione = a.pezziConfezione > 1 ? 'conf. da ' + a.pezziConfezione + ' ' + a.unita : '';
    });
    return out;
  }

  /*
   * Il motore: simula giorno per giorno carichi, rifornimenti, consumi e (con logistica) richieste e DDT.
   * Tiene i lotti di ogni magazzino come farebbe Calcoli.lotti (prima chi scade prima), così i lotti scritti nei
   * trasferimenti e nei DDT sono sempre disponibili.
   */
  function simula(opz, logistica) {
    var rnd = casuale(959);
    var oggi = opz.oggi ? new Date(opz.oggi.getTime()) : new Date();
    var adesso = oggi.getTime();
    var oggiInizio = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate());
    var giorni = Math.max(30, Math.min(400, Math.floor(opz.giorni || 150)));
    var inizio = new Date(oggiInizio.getFullYear(), oggiInizio.getMonth(), oggiInizio.getDate() - giorni);
    var far = opz.centrale;
    var periferici = opz.reparti.slice();
    var transito = opz.transito || 'r-transito';
    var persone = opz.persone || {};
    var farmacista = persone.farmacista || { id: null, nome: 'Farmacista di turno' };
    var trasportatore = persone.trasportatore || 'Addetto al magazzino';
    var chiDi = function (rep) {
      if (rep === opz.centrale) return farmacista;
      return (persone.magazzini || {})[rep] || { id: null, nome: 'Infermiere di turno' };
    };

    var articoli = anagrafica();
    var perId = {};
    articoli.forEach(function (a) { perId[a.id] = a; });
    var movimenti = [];
    var out = { articoli: articoli, movimenti: movimenti, richieste: [], richiesteRighe: [], ddt: [], ddtRighe: [] };

    /* consumo medio al giorno di ogni coppia magazzino|articolo, con il ritmo e la tendenza */
    var domanda = {};
    var profili = {};
    periferici.forEach(function (rep) {
      var pr = PROFILI[profiloDi(rep)];
      profili[rep] = pr;
      ['f', 'p'].forEach(function (cat) {
        Object.keys(pr[cat]).forEach(function (i) {
          var id = 'demo-' + cat + i;
          if (!perId[id]) return;
          domanda[rep + '|' + id] = { media: pr[cat][i], tendenza: pr.tendenze[cat + i] || 1 };
        });
      });
    });
    function mediaDel(rep, artId, giorno) {
      var d = domanda[rep + '|' + artId];
      if (!d) return 0;
      var avanzamento = giorno / giorni;
      return d.media * (1 + (d.tendenza - 1) * avanzamento);
    }
    // consumo totale della struttura al giorno (per le scorte e gli ordini della farmacia centrale)
    var totale = {};
    articoli.forEach(function (a) {
      totale[a.id] = periferici.reduce(function (s, rep) { var d = domanda[rep + '|' + a.id]; return s + (d ? d.media * (1 + d.tendenza) / 2 : 0); }, 0);
      a.scortaMinima = totale[a.id] > 0 ? arrotonda(totale[a.id] * 7, totale[a.id] * 7 > 50 ? 10 : 5) : 5;
    });

    /* ---------- lotti e movimenti ---------- */
    var lotti = {}; // 'magazzino|articolo' -> [{ lotto, scadenza, q }]
    var seq = 0;
    function lista(rep, art) { var k = rep + '|' + art; if (!lotti[k]) lotti[k] = []; return lotti[k]; }
    function giac(rep, art) { return r3(lista(rep, art).reduce(function (s, l) { return s + l.q; }, 0)); }
    function confronta(a, b) {
      if (!a.scadenza && !b.scadenza) return 0;
      if (!a.scadenza) return 1;
      if (!b.scadenza) return -1;
      return a.scadenza < b.scadenza ? -1 : a.scadenza > b.scadenza ? 1 : 0;
    }
    function entra(rep, art, lotto, scadenza, q) {
      var l = lista(rep, art).filter(function (x) { return x.lotto === lotto; })[0];
      if (!l) { l = { lotto: lotto, scadenza: scadenza, q: 0 }; lista(rep, art).push(l); }
      l.q = r3(l.q + q);
    }
    // uscita: prima il lotto indicato, poi chi scade prima (come Calcoli.allocaUscita)
    function esce(rep, art, q, lottoScelto) {
      var parti = [];
      var resto = r3(q);
      function prendi(l) {
        var p = Math.min(resto, l.q);
        if (p <= 0) return;
        l.q = r3(l.q - p);
        resto = r3(resto - p);
        var gia = parti.filter(function (x) { return x.lotto === l.lotto; })[0];
        if (gia) gia.quantita = r3(gia.quantita + p); else parti.push({ lotto: l.lotto, scadenza: l.scadenza, quantita: p });
      }
      var tutti = lista(rep, art);
      if (lottoScelto) tutti.filter(function (l) { return l.lotto === lottoScelto; }).forEach(prendi);
      tutti.filter(function (l) { return l.q > 0; }).sort(confronta).forEach(function (l) { if (resto > 0) prendi(l); });
      lotti[rep + '|' + art] = tutti.filter(function (l) { return l.q > 0; });
      return parti;
    }
    // istante di un evento: il giorno indicato all'ora indicata, mai dopo adesso
    function istante(giorno, ora, minuti) {
      var t = new Date(giorno.getFullYear(), giorno.getMonth(), giorno.getDate(), ora, minuti || 0).getTime();
      return Math.min(t, adesso - 60000);
    }
    function mov(m, t) {
      m.id = 'demo-m' + (++seq);
      // millisecondi diversi per ogni movimento: nello stesso minuto restano nell'ordine in cui sono stati registrati
      m.creato = t + (seq % 1000);
      ['lotto', 'scadenza', 'fornitore', 'documento', 'causale', 'note'].forEach(function (k) { if (m[k] === undefined) m[k] = ''; });
      movimenti.push(m);
      return m;
    }
    function iso(t) { return new Date(t).toISOString(); }

    /* ---------- carichi dai fornitori ---------- */
    var ordini = []; // { art, arrivo (indice del giorno), quantita }
    var numeroDdtFornitore = 4100;
    var numeroLotto = 1;
    function caricaDaFornitore(giorno, idx, art, q, scadenza) {
      var a = perId[art];
      var lotto = (a.categoria === 'FARMACI' ? 'F' : 'P') + String(giorno.getFullYear()).slice(2) + String.fromCharCode(65 + (numeroLotto % 26)) + String(1000 + numeroLotto).slice(-3);
      numeroLotto += 1;
      q = arrotonda(q, a.pezziConfezione || 1);
      mov({ tipo: 'carico', data: data(giorno), articoloId: art, repartoId: far, quantita: q, lotto: lotto, scadenza: scadenza, fornitore: a.fornitore,
        documento: 'DDT ' + (++numeroDdtFornitore), prezzo: a.prezzo, operatore: farmacista.nome, utenteId: farmacista.id || undefined }, istante(giorno, 8, 10));
      entra(far, art, lotto, scadenza, q);
    }

    /* ---------- richieste e DDT (solo con logistica) ---------- */
    var progressivi = {};
    function prossimo(tipo, t) {
      var anno = new Date(t).getFullYear();
      var k = tipo + anno;
      progressivi[k] = (progressivi[k] || 0) + 1;
      return { anno: anno, progressivo: progressivi[k], numero: (tipo === 'ric' ? 'RIC-' : 'DDT-') + anno + '-' + String(progressivi[k]).padStart(4, '0') };
    }
    var nRic = 0;
    var nRiga = 0;
    var nDdt = 0;
    var nDdtRiga = 0;
    function nuovaRichiesta(rep, righe, t, urgente, note) {
      var n = prossimo('ric', t);
      var chi = chiDi(rep);
      var r = { id: 'demo-ric-' + (++nRic), numero: n.numero, anno: n.anno, progressivo: n.progressivo, repartoId: rep, fornitoreId: far, stato: 'bozza',
        urgente: !!urgente, note: note || '', creataDa: chi.id, creataDaNome: chi.nome, creataIl: iso(t), inviataIl: null, presaDa: null, presaDaNome: '',
        presaIl: null, chiusaIl: null, chiusaDa: null, chiusaDaNome: '', motivo: '' };
      out.richieste.push(r);
      r._righe = righe.map(function (x, i) {
        var riga = { id: 'demo-rr-' + (++nRiga), richiestaId: r.id, articoloId: x.art, quantita: x.q, approvata: null, nota: x.nota || '', ordine: i };
        out.richiesteRighe.push(riga);
        return riga;
      });
      return r;
    }
    function invia(r, t) { r.stato = 'inviata'; r.inviataIl = iso(t); }
    function prendi(r, t) {
      r.stato = 'in_lavorazione';
      r.presaDa = farmacista.id;
      r.presaDaNome = farmacista.nome;
      r.presaIl = iso(t);
      r._righe.forEach(function (x) { if (x.approvata === null) x.approvata = x.quantita; });
    }
    function chiudi(r, stato, t, motivo, chi) {
      chi = chi || farmacista;
      r.stato = stato;
      r.chiusaIl = iso(t);
      r.chiusaDa = chi.id;
      r.chiusaDaNome = chi.nome;
      if (motivo) r.motivo = motivo;
    }
    // DDT dalla farmacia centrale (o da un magazzino qualsiasi): righe [{ art, q, rigaId? }], ripartite sui lotti
    function nuovoDdt(origine, dest, righe, t, richiesta, causale, chiPrepara) {
      var n = prossimo('ddt', t);
      chiPrepara = chiPrepara || farmacista;
      var d = { id: 'demo-ddt-' + (++nDdt), numero: n.numero, anno: n.anno, progressivo: n.progressivo, origineId: origine, destinazioneId: dest,
        richiestaId: richiesta ? richiesta.id : null, stato: 'in_preparazione', causale: causale || (richiesta ? 'Rifornimento su richiesta ' + richiesta.numero : 'Trasferimento interno'),
        colli: 1, note: '', preparatoDa: chiPrepara.id, preparatoDaNome: chiPrepara.nome, preparatoIl: iso(t), trasportatoreId: null, trasportatoreNome: '',
        partitoIl: null, ricevutoDa: null, ricevutoDaNome: '', ricevutoIl: null, noteRicezione: '', annullatoIl: null, annullatoDa: null, motivoAnnullo: '' };
      d._righe = [];
      // lotti presi (senza ancora muovere la merce): come i "lotti liberi" del server
      var impegnati = {};
      righe.forEach(function (x) {
        var resto = x.q;
        lista(origine, x.art).slice().sort(confronta).forEach(function (l) {
          var k = x.art + '|' + l.lotto;
          var libero = r3(l.q - (impegnati[k] || 0));
          var p = Math.min(resto, libero);
          if (p <= 0) return;
          impegnati[k] = r3((impegnati[k] || 0) + p);
          resto = r3(resto - p);
          var riga = { id: 'demo-dr-' + (++nDdtRiga), ddtId: d.id, articoloId: x.art, richiestaRigaId: x.rigaId || null, lotto: l.lotto, scadenza: l.scadenza,
            quantita: p, ricevuta: null, esito: '', nota: '', ordine: d._righe.length };
          d._righe.push(riga);
          out.ddtRighe.push(riga);
        });
      });
      d.colli = Math.max(1, Math.min(12, Math.ceil(d._righe.length / 6)));
      out.ddt.push(d);
      return d;
    }
    function spedisci(d, t, giorno) {
      var dest = d.destinazioneId;
      d._righe.forEach(function (x) {
        esce(d.origineId, x.articoloId, x.quantita, x.lotto);
        entra(transito, x.articoloId, x.lotto, x.scadenza, x.quantita);
        mov({ tipo: 'trasferimento', data: data(giorno), articoloId: x.articoloId, repartoId: d.origineId, repartoDestId: transito, quantita: x.quantita,
          lotto: x.lotto, scadenza: x.scadenza, documento: d.numero, causale: d.causale, note: 'Verso ' + (opz.nomi ? opz.nomi[dest] || dest : dest),
          operatore: farmacista.nome, utenteId: farmacista.id || undefined, ddtId: d.id }, t);
      });
      d.stato = 'in_transito';
      d.trasportatoreNome = trasportatore;
      d.partitoIl = iso(t);
    }
    // ricezione; differenze: { indice della riga: { ricevuta, esito: 'rientro'|'perdita', nota } }
    function ricevi(d, t, giorno, differenze, noteRicezione) {
      var chi = chiDi(d.destinazioneId);
      var origineNome = opz.nomi ? opz.nomi[d.origineId] || d.origineId : d.origineId;
      var conDifferenze = false;
      d._righe.forEach(function (x, i) {
        var v = (differenze || {})[i] || { ricevuta: x.quantita, esito: '', nota: '' };
        var diff = r3(x.quantita - v.ricevuta);
        esce(transito, x.articoloId, x.quantita, x.lotto);
        if (v.ricevuta > 0) {
          entra(d.destinazioneId, x.articoloId, x.lotto, x.scadenza, v.ricevuta);
          mov({ tipo: 'trasferimento', data: data(giorno), articoloId: x.articoloId, repartoId: transito, repartoDestId: d.destinazioneId, quantita: v.ricevuta,
            lotto: x.lotto, scadenza: x.scadenza, documento: d.numero, causale: d.causale, note: 'Da ' + origineNome, operatore: chi.nome, utenteId: chi.id || undefined, ddtId: d.id }, t);
        }
        if (diff > 0) {
          conDifferenze = true;
          var causale = 'Differenza alla ricezione DDT ' + d.numero;
          if (v.esito === 'rientro') {
            entra(d.origineId, x.articoloId, x.lotto, x.scadenza, diff);
            mov({ tipo: 'trasferimento', data: data(giorno), articoloId: x.articoloId, repartoId: transito, repartoDestId: d.origineId, quantita: diff,
              lotto: x.lotto, scadenza: x.scadenza, documento: d.numero, causale: causale, note: 'Rientro' + (v.nota ? ': ' + v.nota : ''), operatore: chi.nome, utenteId: chi.id || undefined, ddtId: d.id }, t);
          } else {
            mov({ tipo: 'perdita', data: data(giorno), articoloId: x.articoloId, repartoId: transito, quantita: diff,
              lotto: x.lotto, scadenza: x.scadenza, documento: d.numero, causale: causale, note: 'Perdita in viaggio' + (v.nota ? ': ' + v.nota : ''), operatore: chi.nome, utenteId: chi.id || undefined, ddtId: d.id }, t);
          }
        }
        x.ricevuta = v.ricevuta;
        x.esito = diff > 0 ? v.esito : '';
        x.nota = v.nota || x.nota || '';
      });
      d.stato = conDifferenze ? 'ricevuto_con_differenze' : 'ricevuto';
      d.ricevutoDa = chi.id;
      d.ricevutoDaNome = chi.nome;
      d.ricevutoIl = iso(t);
      d.noteRicezione = noteRicezione || '';
    }
    // la richiesta è evasa quando tutto l'approvato è partito
    function aggiornaRichiesta(r, t) {
      var spedita = {};
      out.ddt.forEach(function (d) {
        if (d.richiestaId !== r.id || ['in_transito', 'ricevuto', 'ricevuto_con_differenze'].indexOf(d.stato) < 0) return;
        d._righe.forEach(function (x) { if (x.richiestaRigaId) spedita[x.richiestaRigaId] = r3((spedita[x.richiestaRigaId] || 0) + x.quantita); });
      });
      var tutto = r._righe.every(function (x) { return r3((x.approvata === null ? x.quantita : x.approvata) - (spedita[x.id] || 0)) <= 0; });
      if (tutto && (r.stato === 'inviata' || r.stato === 'in_lavorazione')) chiudi(r, 'evasa', t);
    }

    /* ---------- rifornimento di un magazzino periferico ---------- */
    // quanto chiedere: fino a circa 10 giorni del consumo recente (scorta massima del magazzino)
    function fabbisogno(rep, giornoIdx) {
      var righe = [];
      Object.keys(domanda).forEach(function (k) {
        if (k.indexOf(rep + '|') !== 0) return;
        var art = k.slice(rep.length + 1);
        var a = perId[art];
        var media = mediaDel(rep, art, giornoIdx);
        var massima = Math.max(2, Math.ceil(media * 10));
        var riordino = Math.max(1, Math.ceil(media * 6));
        var g = giac(rep, art);
        if (g > riordino) return;
        var q = arrotonda(massima - g, a.pezziConfezione >= 10 && media * 10 > a.pezziConfezione ? a.pezziConfezione : 1);
        if (q > 0) righe.push({ art: art, q: q });
      });
      return righe;
    }
    // senza logistica: trasferimento diretto (2.x); con logistica: richiesta + DDT, spedito e ricevuto
    function rifornisci(rep, giorno, idx, opzR) {
      opzR = opzR || {};
      var righe = fabbisogno(rep, idx);
      if (!righe.length) return null;
      if (!logistica) {
        righe.forEach(function (x) {
          var q = Math.min(x.q, giac(far, x.art));
          if (q <= 0) return;
          var t = istante(giorno, 9, 30);
          esce(far, x.art, q).forEach(function (p) {
            mov({ tipo: 'trasferimento', data: data(giorno), articoloId: x.art, repartoId: far, repartoDestId: rep, quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza,
              note: 'Rifornimento settimanale', operatore: farmacista.nome, utenteId: farmacista.id || undefined }, t);
            entra(rep, x.art, p.lotto, p.scadenza, p.quantita);
          });
        });
        return null;
      }
      // la richiesta parte il giorno prima (la sera), la farmacia la prende al mattino
      var ieri = new Date(giorno.getFullYear(), giorno.getMonth(), giorno.getDate() - 1);
      var tCrea = opzR.tCrea || istante(ieri, 17, 40);
      var r = nuovaRichiesta(rep, righe, tCrea, opzR.urgente, opzR.note);
      if (opzR.soloBozza) return { richiesta: r };
      invia(r, opzR.tInvia || istante(ieri, 17, 45));
      if (opzR.soloInviata) return { richiesta: r };
      prendi(r, istante(giorno, 8, 20));
      // la farmacia approva quanto ha: se manca merce approva di meno (e la richiesta si chiude con il residuo)
      var manca = false;
      r._righe.forEach(function (x) {
        var g = giac(far, x.articoloId);
        if (g < x.quantita) { x.approvata = Math.max(0, Math.floor(g)); manca = true; }
      });
      var daMandare = r._righe.filter(function (x) { return x.approvata > 0; }).map(function (x) { return { art: x.articoloId, q: x.approvata, rigaId: x.id }; });
      if (!daMandare.length) { chiudi(r, 'chiusa', istante(giorno, 8, 40), 'Merce non disponibile in farmacia: ordinata al fornitore'); return { richiesta: r }; }
      var d = nuovoDdt(far, rep, daMandare, istante(giorno, 8, 50), r);
      if (opzR.soloPreparato) return { richiesta: r, ddt: d };
      spedisci(d, istante(giorno, 9, 40), giorno);
      aggiornaRichiesta(r, istante(giorno, 9, 41));
      if (manca && r.stato !== 'evasa') chiudi(r, 'chiusa', istante(giorno, 9, 42), 'Chiusa con il residuo: merce in ordine dal fornitore');
      if (opzR.soloSpedito) return { richiesta: r, ddt: d };
      var tRicevi = istante(giorno, 10 + (idx % 3), 15);
      ricevi(d, tRicevi, giorno, opzR.differenze, opzR.noteRicezione);
      return { richiesta: r, ddt: d };
    }

    /* ---------- consumi di un giorno ---------- */
    function consumi(rep, giorno, idx, finoAOra) {
      var pr = profili[rep];
      var fattore = pr.settimana[giorno.getDay()];
      var chi = chiDi(rep);
      Object.keys(domanda).forEach(function (k) {
        if (k.indexOf(rep + '|') !== 0) return;
        var art = k.slice(rep.length + 1);
        var media = mediaDel(rep, art, idx) * fattore * (finoAOra === undefined ? 1 : finoAOra);
        var q = Math.min(poisson(rnd, media), Math.floor(giac(rep, art)));
        if (q <= 0) return;
        esce(rep, art, q);
        mov({ tipo: 'consumo', data: data(giorno), articoloId: art, repartoId: rep, quantita: q, operatore: chi.nome, utenteId: chi.id || undefined },
          istante(giorno, finoAOra === undefined ? 19 : 8, finoAOra === undefined ? 30 : 30));
      });
    }

    /* ---------- la storia, giorno per giorno ---------- */
    var giornoRifornimento = {}; // ogni magazzino ha il suo giorno della settimana
    periferici.forEach(function (rep, i) { giornoRifornimento[rep] = [1, 2, 4, 3, 5][i % 5]; });
    var ritardoDa = giorni - 28;
    // magazzini del lavoro di oggi (anteprima): Degenza 1° piano, Degenza 2° piano, Sala operatoria, Ambulatori
    var pr0 = periferici[0];
    var pr1 = periferici[1] || pr0;
    var prSala = periferici.filter(function (r) { return profiloDi(r) === 'sala'; })[0] || periferici[2] || pr0;
    var prAmb = periferici.filter(function (r) { return profiloDi(r) === 'ambulatori'; })[0] || periferici[3] || pr1;

    for (var idx = 0; idx <= giorni; idx++) {
      var giorno = new Date(inizio.getFullYear(), inizio.getMonth(), inizio.getDate() + idx);
      var eOggi = idx === giorni;
      // 1. arrivi dai fornitori (e la scorta iniziale il primo giorno)
      if (idx === 0) {
        articoli.forEach(function (a, i) {
          var q = Math.max(a.scortaMinima * 6, 20);
          var primo = PRIMO_LOTTO[a.id];
          var scad1 = primo !== undefined ? mese(oggi, primo) : mese(oggi, 4 + (i % 9));
          caricaDaFornitore(giorno, idx, a.id, Math.ceil(q * (primo !== undefined ? 0.25 : 0.5)), scad1);
          caricaDaFornitore(giorno, idx, a.id, Math.ceil(q * (primo !== undefined ? 0.75 : 0.5)), mese(oggi, 10 + (i % 14)));
        });
      }
      // offerte del fornitore con scadenza breve (restano nella pagina Scadenze): una scaduta, due in scadenza
      if (idx === giorni - 45) caricaDaFornitore(giorno, idx, 'demo-f21', 12, mese(oggi, -1));
      if (idx === giorni - 14) caricaDaFornitore(giorno, idx, 'demo-f8', 160, mese(oggi, 2));
      if (idx === giorni - 9) caricaDaFornitore(giorno, idx, 'demo-p12', 240, mese(oggi, 1));
      ordini = ordini.filter(function (o) {
        if (o.arrivo !== idx) return true;
        caricaDaFornitore(giorno, idx, o.art, o.quantita, mese(giorno, o.breve ? 5 : 12 + (o.n % 18)));
        return false;
      });
      if (eOggi && !logistica && !opz.conOggi) break;
      // 2. rifornimenti dei magazzini periferici (il primo giorno tutti, poi una volta alla settimana)
      periferici.forEach(function (rep) {
        if (eOggi) return; // il lavoro di oggi si prepara a parte (vedi sotto)
        if (idx === 0 || giorno.getDay() === giornoRifornimento[rep]) rifornisci(rep, giorno, idx);
      });
      if (eOggi) break;
      // 3. consumi del giorno (registrati la sera)
      periferici.forEach(function (rep) { consumi(rep, giorno, idx); });
      // 4. ordini ai fornitori della farmacia centrale: sotto il punto di riordino si ordina un mese di consumi
      articoli.forEach(function (a, i) {
        var t = totale[a.id] || 0.2;
        var inArrivo = ordini.filter(function (o) { return o.art === a.id; }).reduce(function (s, o) { return s + o.quantita; }, 0);
        var lt = a.leadTime || 7;
        if (giac(far, a.id) + inArrivo > t * (lt + 10)) return;
        var arrivo = idx + lt;
        if (IN_RITARDO.indexOf(a.id) >= 0 && arrivo >= ritardoDa) arrivo = giorni + 30; // il fornitore è in ritardo
        ordini.push({ art: a.id, arrivo: arrivo, quantita: Math.ceil(t * 30) + 10, breve: i % 11 === 3, n: i + idx });
      });
      // 5. qualche imprevisto
      if (logistica) recenti(giorno, idx);
      if (idx === Math.floor(giorni * 0.4)) {
        var rotte = esce(far, 'demo-f3', 2);
        rotte.forEach(function (p) {
          mov({ tipo: 'perdita', data: data(giorno), articoloId: 'demo-f3', repartoId: far, quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza,
            causale: 'Rotto o danneggiato', note: 'Flaconi caduti durante lo scarico', operatore: farmacista.nome, utenteId: farmacista.id || undefined }, istante(giorno, 11, 5));
        });
      }
      if (idx === Math.floor(giorni * 0.55) && periferici[0]) {
        var rep0 = periferici[0];
        var scad = esce(rep0, 'demo-f15', 1);
        scad.forEach(function (p) {
          mov({ tipo: 'perdita', data: data(giorno), articoloId: 'demo-f15', repartoId: rep0, quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza,
            causale: 'Scaduto', note: 'Flacone aperto da più di 28 giorni', operatore: chiDi(rep0).nome, utenteId: chiDi(rep0).id || undefined }, istante(giorno, 12, 0));
        });
      }
      if (idx === Math.floor(giorni * 0.7)) {
        var repSala = periferici.filter(function (r) { return profiloDi(r) === 'sala'; })[0] || periferici[periferici.length - 1];
        if (repSala && giac(repSala, 'demo-p6') >= 2) {
          var conta = esce(repSala, 'demo-p6', 2);
          conta.forEach(function (p) {
            mov({ tipo: 'rettifica', data: data(giorno), articoloId: 'demo-p6', repartoId: repSala, quantita: -p.quantita, lotto: p.lotto, scadenza: p.scadenza,
              causale: 'Inventario', note: 'Conta di fine mese', operatore: farmacista.nome, utenteId: farmacista.id || undefined }, istante(giorno, 16, 0));
          });
        }
      }
    }

    // richieste rifiutate o annullate, un reso per scadenza e un DDT annullato negli ultimi giorni (anteprima)
    function recenti(giorno, idx) {
      if (idx === giorni - 9) {
        var rif = nuovaRichiesta(prAmb, [{ art: 'demo-f12', q: 10, nota: 'Per sedazione in ambulatorio' }], istante(giorno, 10, 0), false, '');
        invia(rif, istante(giorno, 10, 1));
        rif.presaDa = farmacista.id;
        rif.presaDaNome = farmacista.nome;
        rif.presaIl = iso(istante(giorno, 10, 30));
        chiudi(rif, 'rifiutata', istante(giorno, 10, 31), 'Il propofol si usa solo in sala operatoria: chiedi all’anestesista');
      }
      if (idx === giorni - 4) {
        var ann = nuovaRichiesta(pr0, [{ art: 'demo-p9', q: 10 }], istante(giorno, 15, 0), false, '');
        chiudi(ann, 'annullata', istante(giorno, 15, 20), 'Fatta per sbaglio: i cateteri li ha portati il magazzino', chiDi(pr0));
      }
      if (idx === giorni - 1) {
        // un DDT preparato due volte per sbaglio, annullato prima di partire
        var annullato = nuovoDdt(far, prAmb, [{ art: 'demo-p8', q: 20 }], istante(giorno, 9, 0), null, 'Trasferimento interno');
        annullato.stato = 'annullato';
        annullato.annullatoIl = iso(istante(giorno, 9, 5));
        annullato.annullatoDa = farmacista.nome;
        annullato.motivoAnnullo = 'Preparato due volte per sbaglio';
        // reso per scadenza: le fiale scadute del carrello delle urgenze tornano in farmacia (da eliminare)
        var artReso = giac(pr1, 'demo-f21') >= 1 ? 'demo-f21' : null;
        if (artReso) {
          var dReso = nuovoDdt(pr1, far, [{ art: artReso, q: Math.min(2, Math.floor(giac(pr1, artReso))) }], istante(giorno, 11, 0), null, 'Reso per scadenza', chiDi(pr1));
          spedisci(dReso, istante(giorno, 11, 20), giorno);
          ricevi(dReso, istante(giorno, 12, 5), giorno, null, 'Da eliminare: lotto scaduto');
        }
      }
    }

    var oggiG = oggiInizio;
    /* ---------- consumi di stamattina (anteprima) ---------- */
    if (opz.conOggi) {
      var ore = (adesso - oggiInizio.getTime()) / 3600000;
      var parte = Math.max(0, Math.min(1, (ore - 7) / 12));
      if (parte > 0.05) periferici.forEach(function (rep) { consumi(rep, oggiG, giorni, Math.max(0.2, parte)); });
    }
    if (!logistica) return out;

    /* ---------- il lavoro in corso di oggi (anteprima) ---------- */
    var ieriG = new Date(oggiG.getFullYear(), oggiG.getMonth(), oggiG.getDate() - 1);
    function righeDi(rep, quante) {
      var r = fabbisogno(rep, giorni);
      if (r.length < 3) {
        // poco da chiedere: qualche articolo dell'assortimento lo stesso
        Object.keys(domanda).filter(function (k) { return k.indexOf(rep + '|') === 0; }).slice(0, 4).forEach(function (k) {
          var art = k.slice(rep.length + 1);
          if (!r.some(function (x) { return x.art === art; })) r.push({ art: art, q: Math.max(2, Math.ceil(mediaDel(rep, art, giorni) * 5)) });
        });
      }
      return r.slice(0, quante);
    }
    // Ambulatori e Degenza 1° piano: richiesta di ieri sera, DDT partito stamattina e ancora in viaggio
    rifornisciOggi(prAmb, righeDi(prAmb, 6), [7, 50]);
    rifornisciOggi(pr0, righeDi(pr0, 5), [8, 35]);
    // Sala operatoria: richiesta presa in carico, approvata un po' meno, DDT in preparazione con una parte
    var sala = nuovaRichiesta(prSala, [{ art: 'demo-f12', q: 30 }, { art: 'demo-f17', q: 20 }, { art: 'demo-f19', q: 10 }, { art: 'demo-p0', q: 200 }, { art: 'demo-p10', q: 300 }],
      istante(ieriG, 18, 10), false, 'Seduta operatoria di domani: 6 interventi');
    invia(sala, istante(ieriG, 18, 12));
    prendi(sala, istante(oggiG, 8, 5));
    sala._righe.forEach(function (x) {
      if (x.articoloId === 'demo-p10') x.approvata = 200;
      var g = Math.floor(giac(far, x.articoloId));
      if (x.approvata > g) x.approvata = g;
    });
    var parteSala = sala._righe.filter(function (x) { return x.approvata > 0 && x.articoloId !== 'demo-f17'; }).map(function (x) { return { art: x.articoloId, q: x.approvata, rigaId: x.id }; });
    if (parteSala.length) nuovoDdt(far, prSala, parteSala, istante(oggiG, 8, 25), sala);
    // Degenza 1° piano: e in più una richiesta urgente inviata stamattina
    var urgente = nuovaRichiesta(pr0, [{ art: 'demo-f5', q: 20, nota: 'Nuovo ingresso: terapia per 5 pazienti' }, { art: 'demo-f0', q: 30 }, { art: 'demo-p5', q: 25 }, { art: 'demo-f15', q: 2, nota: 'Una confezione in frigo è aperta da 28 giorni' }],
      istante(oggiG, 7, 35), true, 'Servono entro mezzogiorno, grazie');
    invia(urgente, istante(oggiG, 7, 40));
    // Degenza 2° piano: una richiesta ancora in bozza (la sta scrivendo il responsabile)
    var bozza = nuovaRichiesta(pr1, righeDi(pr1, 4).map(function (x) { return { art: x.art, q: x.q }; }), istante(oggiG, 7, 55), false, '');
    bozza.note = 'Da completare dopo il giro letto';
    // ultimo DDT della Degenza 2° piano ricevuto con una differenza: due pezzi rientrano in farmacia
    var ultimo2 = out.ddt.filter(function (d) { return d.destinazioneId === pr1 && d.stato === 'ricevuto'; }).slice(-1)[0];
    if (ultimo2 && ultimo2._righe.length) segnaDifferenza(ultimo2);

    // richiesta di ieri sera, presa stamattina, DDT partito all'ora indicata e non ancora arrivato
    function rifornisciOggi(rep, righe, ora) {
      var r = nuovaRichiesta(rep, righe, istante(ieriG, 17, 30), false, '');
      invia(r, istante(ieriG, 17, 32));
      prendi(r, istante(oggiG, ora[0], ora[1] - 30));
      r._righe.forEach(function (x) { var q = Math.floor(giac(far, x.articoloId)); if (x.approvata > q) x.approvata = q; });
      var daMandare = r._righe.filter(function (x) { return x.approvata > 0; }).map(function (x) { return { art: x.articoloId, q: x.approvata, rigaId: x.id }; });
      if (!daMandare.length) return { richiesta: r };
      var d = nuovoDdt(far, rep, daMandare, istante(oggiG, ora[0], ora[1] - 20), r);
      spedisci(d, istante(oggiG, ora[0], ora[1]), oggiG);
      aggiornaRichiesta(r, istante(oggiG, ora[0], ora[1]));
      return { richiesta: r, ddt: d };
    }
    // a posteriori: una riga dell'ultimo DDT ricevuto ha 2 pezzi in meno, che sono rientrati in farmacia
    function segnaDifferenza(d) {
      var i = 0;
      var x = d._righe[i];
      if (!x || x.quantita < 4) return;
      var diff = 2;
      // il movimento di arrivo diventa più piccolo e se ne aggiunge uno di rientro all'origine
      var arrivo = movimenti.filter(function (m) { return m.ddtId === d.id && m.repartoId === transito && m.repartoDestId === d.destinazioneId && m.articoloId === x.articoloId && m.lotto === x.lotto; })[0];
      if (!arrivo) return;
      arrivo.quantita = r3(arrivo.quantita - diff);
      var g = lista(d.destinazioneId, x.articoloId).filter(function (l) { return l.lotto === x.lotto; })[0];
      if (!g || g.q < diff) { arrivo.quantita = r3(arrivo.quantita + diff); return; }
      g.q = r3(g.q - diff);
      entra(d.origineId, x.articoloId, x.lotto, x.scadenza, diff);
      var rientro = { id: 'demo-m' + (++seq), tipo: 'trasferimento', data: arrivo.data, articoloId: x.articoloId, repartoId: transito, repartoDestId: d.origineId, quantita: diff,
        lotto: x.lotto, scadenza: x.scadenza, fornitore: '', documento: d.numero, causale: 'Differenza alla ricezione DDT ' + d.numero, note: 'Rientro: confezione schiacciata, rimandata in farmacia',
        operatore: arrivo.operatore, utenteId: arrivo.utenteId, creato: arrivo.creato + 1, ddtId: d.id };
      movimenti.push(rientro);
      x.ricevuta = r3(x.quantita - diff);
      x.esito = 'rientro';
      x.nota = 'Confezione schiacciata';
      d.stato = 'ricevuto_con_differenze';
    }

    return out;
  }

  /* ---------- crea: articoli e movimenti (server vero, archivio della versione per un solo PC) ---------- */
  function crea(C, opz) {
    var s = simula(opz || {}, false);
    return {
      articoli: s.articoli.map(function (a) {
        return { id: a.id, nome: a.nome, categoria: a.categoria, unita: a.unita, prezzo: a.prezzo, scortaMinima: a.scortaMinima, principio: a.principio, attivo: true };
      }),
      movimenti: s.movimenti
    };
  }

  /* ---------- armadi, assortimento e ubicazioni ---------- */
  var ARMADI = {
    centrale: [
      ['Armadio farmaci A', 'armadio', 5, 6, ''],
      ['Scaffale presidi', 'armadio', 4, 6, ''],
      ['Frigorifero farmaci', 'frigorifero', 3, 4, ''],
      ['Cassaforte stupefacenti', 'cassaforte', 2, 4, 'Chiave al farmacista di turno']
    ],
    degenza: [
      ['Carrello della terapia', 'carrello', 4, 6, 'Giro delle 8, 14 e 20'],
      ['Armadio presidi', 'armadio', 4, 5, ''],
      ['Frigorifero', 'frigorifero', 2, 3, ''],
      ['Cassaforte', 'cassaforte', 1, 3, 'Registro di carico e scarico accanto']
    ],
    degenza2: [
      ['Carrello della terapia', 'carrello', 4, 6, ''],
      ['Armadio presidi', 'armadio', 4, 5, ''],
      ['Frigorifero', 'frigorifero', 2, 3, ''],
      ['Cassaforte', 'cassaforte', 1, 3, '']
    ],
    sala: [
      ['Carrello di anestesia', 'carrello', 4, 5, 'Controllo a inizio seduta'],
      ['Armadio sala 1', 'armadio', 4, 6, ''],
      ['Frigorifero anestesia', 'frigorifero', 2, 3, ''],
      ['Cassaforte stupefacenti', 'cassaforte', 1, 4, '']
    ],
    ambulatori: [
      ['Cassettiera medicazioni', 'cassettiera', 6, 2, ''],
      ['Armadio farmaci', 'armadio', 3, 4, '']
    ]
  };

  function struttura(s, opz) {
    var armadi = [];
    var assortimento = [];
    var perId = {};
    s.articoli.forEach(function (a) { perId[a.id] = a; });
    // consumo medio degli ultimi 60 giorni di ogni coppia magazzino|articolo (per le soglie)
    var oggi = opz.oggi || new Date();
    var dal = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() - 60);
    var dalT = data(dal);
    var uso = {};
    var dato = {};
    s.movimenti.forEach(function (m) {
      if (m.data < dalT) return;
      if (m.tipo === 'consumo' || m.tipo === 'perdita') uso[m.repartoId + '|' + m.articoloId] = (uso[m.repartoId + '|' + m.articoloId] || 0) + m.quantita;
      if (m.tipo === 'trasferimento' && m.repartoId === opz.centrale) dato[m.articoloId] = (dato[m.articoloId] || 0) + m.quantita;
    });
    var nA = 0;
    var nAs = 0;
    function magazzino(rep, profilo, centrale) {
      var lista = ARMADI[profilo] || ARMADI.degenza;
      var miei = lista.map(function (x, i) {
        var a = { id: 'demo-arm-' + (++nA), repartoId: rep, nome: x[0], tipo: x[1], ripiani: x[2], colonne: x[3], ordine: i, colore: '', note: x[4], attivo: true };
        armadi.push(a);
        a._posti = [];
        return a;
      });
      function scegli(art) {
        var attr = art.attributi || [];
        var tipo = attr.indexOf('frigo') >= 0 ? 'frigorifero' : attr.indexOf('stupefacente') >= 0 ? 'cassaforte' : null;
        var candidati = tipo ? miei.filter(function (a) { return a.tipo === tipo; }) : miei.filter(function (a) { return a.tipo !== 'frigorifero' && a.tipo !== 'cassaforte'; });
        if (!tipo && candidati.length > 1) {
          // farmaci nel carrello o nel primo armadio, presidi nell'altro
          var presidi = art.categoria === 'PRESIDI';
          candidati = candidati.slice().sort(function (a, b) {
            var pa = /presid|medicaz|scaffale/i.test(a.nome) || a.tipo === 'cassettiera' ? 1 : 0;
            var pb = /presid|medicaz|scaffale/i.test(b.nome) || b.tipo === 'cassettiera' ? 1 : 0;
            return presidi ? pb - pa : pa - pb;
          });
        }
        for (var i = 0; i < candidati.length; i++) {
          var a = candidati[i];
          var n = a._posti.length;
          if (n < a.ripiani * a.colonne) {
            a._posti.push(art.id);
            return { armadioId: a.id, ripiano: Math.floor(n / a.colonne) + 1, posizione: (n % a.colonne) + 1 };
          }
        }
        return null;
      }
      var articoli = s.articoli.filter(function (a) {
        if (centrale) return true;
        return (uso[rep + '|' + a.id] || 0) > 0;
      }).sort(function (a, b) { return a.nome.localeCompare(b.nome, 'it'); });
      articoli.forEach(function (art, i) {
        var giorno = centrale ? (dato[art.id] || 0) / 60 : (uso[rep + '|' + art.id] || 0) / 60;
        var min = centrale ? art.scortaMinima : Math.max(1, Math.ceil(giorno * 2));
        var riordino = centrale ? Math.ceil(art.scortaMinima * 1.6) : Math.max(min, Math.ceil(giorno * 5));
        var max = centrale ? Math.ceil(art.scortaMinima * 4.5) : Math.max(riordino + 1, Math.ceil(giorno * 10));
        // qualche articolo resta da sistemare negli armadi (per provare "Disponi")
        var dove = i % 9 === 7 ? null : scegli(art);
        assortimento.push({
          id: 'demo-as-' + (++nAs), repartoId: rep, articoloId: art.id, scortaMin: min, puntoRiordino: riordino, scortaMax: max,
          armadioId: dove ? dove.armadioId : null, ripiano: dove ? dove.ripiano : null, posizione: dove ? dove.posizione : null,
          note: (art.attributi || []).indexOf('frigo') >= 0 ? 'Conservare tra 2 e 8 °C' : '', attivo: true
        });
      });
    }
    magazzino(opz.centrale, 'centrale', true);
    opz.reparti.forEach(function (rep) { magazzino(rep, profiloDi(rep), false); });
    armadi.forEach(function (a) { delete a._posti; });
    return { armadi: armadi, assortimento: assortimento };
  }

  /* ---------- creaCompleta: il mondo della versione 3.0, per l'anteprima ---------- */
  function creaCompleta(C, opz) {
    opz = opz || {};
    var s = simula(opz, true);
    var st = struttura(s, opz);
    function pulisci(x) { var o = {}; Object.keys(x).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = x[k]; }); return o; }
    return {
      articoli: s.articoli,
      movimenti: s.movimenti,
      armadi: st.armadi,
      assortimento: st.assortimento,
      richieste: s.richieste.map(pulisci),
      richiesteRighe: s.richiesteRighe,
      ddt: s.ddt.map(pulisci),
      ddtRighe: s.ddtRighe
    };
  }

  var api = { crea: crea, creaCompleta: creaCompleta };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DemoFarmacia = api;
})(this);
