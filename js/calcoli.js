/*
 * Calcoli del magazzino: giacenze, lotti, scadenze e registro mensile.
 * Funzioni pure sullo stato dell'archivio, senza accesso all'interfaccia:
 * le usa l'app nel browser e le provano i test con Node.
 *
 * Tipi di movimento:
 *   carico         entrata nel reparto (da fornitore)
 *   trasferimento  uscita da repartoId, entrata in repartoDestId
 *   consumo        uscita giornaliera del reparto
 *   perdita        uscita per scadenza, rottura o altro
 *   rettifica      correzione da inventario, quantita con segno
 */
(function (root) {
  'use strict';

  var SENZA_LOTTO = '';

  // Le quantità hanno al massimo 3 decimali: arrotondo ogni somma per evitare resti come 2,8e-17
  function r3(x) {
    var v = Math.round((Number(x) || 0) * 1000) / 1000;
    return v === 0 ? 0 : v; // niente -0
  }

  function attivi(stato) {
    return stato.movimenti.filter(function (m) { return !m.annullato; });
  }

  function ordinaMovimenti(lista) {
    return lista.slice().sort(function (a, b) {
      if (a.data !== b.data) return a.data < b.data ? -1 : 1;
      return (a.creato || 0) - (b.creato || 0);
    });
  }

  // Effetto del movimento sulla giacenza di (articolo, reparto): positivo entra, negativo esce.
  function effetto(m, repartoId) {
    var q = Number(m.quantita) || 0;
    switch (m.tipo) {
      case 'carico': return m.repartoId === repartoId ? q : 0;
      case 'consumo':
      case 'perdita': return m.repartoId === repartoId ? -q : 0;
      case 'rettifica': return m.repartoId === repartoId ? q : 0;
      case 'trasferimento':
        if (m.repartoId === repartoId) return -q;
        if (m.repartoDestId === repartoId) return q;
        return 0;
      default: return 0;
    }
  }

  function riguarda(m, repartoId) {
    return m.repartoId === repartoId || (m.tipo === 'trasferimento' && m.repartoDestId === repartoId);
  }

  function movimentiDi(stato, articoloId, repartoId, finoA) {
    return ordinaMovimenti(attivi(stato).filter(function (m) {
      return m.articoloId === articoloId && riguarda(m, repartoId) && (!finoA || m.data <= finoA);
    }));
  }

  /* Giacenza di un articolo in un reparto alla fine del giorno finoA (compreso). */
  function giacenza(stato, articoloId, repartoId, finoA) {
    return r3(movimentiDi(stato, articoloId, repartoId, finoA).reduce(function (s, m) {
      return s + effetto(m, repartoId);
    }, 0));
  }

  /* Tutte le giacenze: { 'articolo|reparto': quantita } (solo le coppie con movimenti). */
  function tutteLeGiacenze(stato, finoA) {
    var out = {};
    attivi(stato).forEach(function (m) {
      if (finoA && m.data > finoA) return;
      var reparti = [m.repartoId];
      if (m.tipo === 'trasferimento') reparti.push(m.repartoDestId);
      reparti.forEach(function (r) {
        var k = m.articoloId + '|' + r;
        out[k] = r3((out[k] || 0) + effetto(m, r));
      });
    });
    return out;
  }

  function confrontaScadenza(a, b) {
    // le scadenze vuote vanno in fondo
    if (!a.scadenza && !b.scadenza) return 0;
    if (!a.scadenza) return 1;
    if (!b.scadenza) return -1;
    return a.scadenza < b.scadenza ? -1 : a.scadenza > b.scadenza ? 1 : 0;
  }

  /*
   * Lotti presenti in un reparto: [{ lotto, scadenza, quantita }].
   * Le uscite con lotto indicato scalano quel lotto; il resto (o le uscite
   * senza lotto) scala prima il lotto che scade prima (FEFO).
   */
  function lotti(stato, articoloId, repartoId, finoA) {
    var mappa = {};
    var ordine = [];
    function lotto(nome, scadenza) {
      var k = nome || SENZA_LOTTO;
      if (!mappa[k]) { mappa[k] = { lotto: k, scadenza: scadenza || '', quantita: 0 }; ordine.push(k); }
      if (scadenza && !mappa[k].scadenza) mappa[k].scadenza = scadenza;
      return mappa[k];
    }
    function preleva(q, nome) {
      if (nome && mappa[nome]) {
        var l = mappa[nome];
        var presa = Math.min(q, Math.max(l.quantita, 0));
        l.quantita = r3(l.quantita - presa);
        q = r3(q - presa);
      }
      if (q <= 0) return;
      var candidati = ordine.map(function (k) { return mappa[k]; })
        .filter(function (l) { return l.quantita > 0; })
        .sort(confrontaScadenza);
      for (var i = 0; i < candidati.length && q > 0; i++) {
        var p = Math.min(q, candidati[i].quantita);
        candidati[i].quantita = r3(candidati[i].quantita - p);
        q = r3(q - p);
      }
      // uscita senza giacenza (registrata prima del carico): resta un debito sul "senza lotto"
      if (q > 0) { var d = lotto(SENZA_LOTTO, ''); d.quantita = r3(d.quantita - q); }
    }
    movimentiDi(stato, articoloId, repartoId, finoA).forEach(function (m) {
      var e = r3(effetto(m, repartoId));
      if (e > 0) {
        // un'entrata copre prima l'eventuale debito, così la somma dei lotti resta uguale alla giacenza
        var debito = mappa[SENZA_LOTTO];
        if (debito && debito.quantita < 0) {
          var copre = Math.min(e, -debito.quantita);
          debito.quantita = r3(debito.quantita + copre);
          e = r3(e - copre);
        }
        if (e > 0) { var l = lotto(m.lotto, m.scadenza); l.quantita = r3(l.quantita + e); }
      } else if (e < 0) preleva(-e, m.lotto);
    });
    return ordine.map(function (k) { return mappa[k]; })
      .filter(function (l) { return l.quantita !== 0; })
      .sort(confrontaScadenza);
  }

  /*
   * Ripartisce un'uscita sui lotti disponibili (FEFO) al momento del salvataggio:
   * restituisce [{ lotto, scadenza, quantita }]. Se un lotto è indicato lo usa per primo,
   * ma mai oltre la sua disponibilità (il resto va sugli altri lotti, poi su "senza lotto").
   */
  function allocaUscita(stato, articoloId, repartoId, data, quantita, lottoScelto) {
    var disponibili = lotti(stato, articoloId, repartoId, data).filter(function (l) { return l.quantita > 0; });
    var q = r3(quantita);
    var parti = [];
    if (lottoScelto) {
      var scelto = disponibili.filter(function (l) { return l.lotto === lottoScelto; })[0];
      if (scelto) {
        var presa = Math.min(q, scelto.quantita);
        parti.push({ lotto: scelto.lotto, scadenza: scelto.scadenza, quantita: presa });
        scelto.quantita = r3(scelto.quantita - presa);
        q = r3(q - presa);
      }
    }
    for (var i = 0; i < disponibili.length && q > 0; i++) {
      var l = disponibili[i];
      if (l.quantita <= 0) continue;
      var p = Math.min(q, l.quantita);
      var gia = parti.filter(function (x) { return x.lotto === l.lotto; })[0];
      if (gia) gia.quantita = r3(gia.quantita + p); else parti.push({ lotto: l.lotto, scadenza: l.scadenza, quantita: p });
      q = r3(q - p);
    }
    if (q > 0) parti.push({ lotto: '', scadenza: '', quantita: q });
    return parti.filter(function (x) { return x.quantita > 0; });
  }

  /* Disponibilità di un lotto in un reparto a una data (0 se non c'è). */
  function disponibilitaLotto(stato, articoloId, repartoId, data, nomeLotto) {
    var l = lotti(stato, articoloId, repartoId, data).filter(function (x) { return x.lotto === nomeLotto; })[0];
    return l && l.quantita > 0 ? l.quantita : 0;
  }

  function giorniNelMese(anno, mese) {
    return new Date(anno, mese, 0).getDate();
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function primoGiorno(anno, mese) { return anno + '-' + pad(mese) + '-01'; }
  function ultimoGiorno(anno, mese) { return anno + '-' + pad(mese) + '-' + pad(giorniNelMese(anno, mese)); }
  function giornoPrima(data) {
    var p = data.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] - 1));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  /* Scadenza 'AAAA-MM' come 'MM/AA' per il modulo cartaceo. */
  function scadenzaBreve(s) {
    if (!s) return '';
    var p = s.split('-');
    return p[1] + '/' + p[0].slice(2);
  }

  /* Ultimo giorno di validita' di una scadenza 'AAAA-MM' (il farmaco vale fino a fine mese). */
  function fineScadenza(s) {
    var p = s.split('-').map(Number);
    return ultimoGiorno(p[0], p[1]);
  }

  /* Giorni che mancano alla scadenza (negativi se scaduto). */
  function giorniAllaScadenza(s, oggi) {
    if (!s) return null;
    var f = fineScadenza(s).split('-').map(Number);
    var o = oggi.split('-').map(Number);
    return Math.round((Date.UTC(f[0], f[1] - 1, f[2]) - Date.UTC(o[0], o[1] - 1, o[2])) / 86400000);
  }

  /*
   * Righe della "Nota consumi medicinali e materiali di medicazione" di un reparto
   * per un mese e una categoria (FARMACI o PRESIDI), con le stesse colonne del modulo:
   * residui mesi prec. (2), carichi (3), totale carico (4), consumi giornalieri,
   * totale consumo (6), perdite (7), totale scarico (8), controllo scadenze (9),
   * residui (10), prezzo unitario (11) e importo scarico.
   */
  function registroMensile(stato, opz) {
    var repartoId = opz.repartoId;
    var inizio = primoGiorno(opz.anno, opz.mese);
    var fine = ultimoGiorno(opz.anno, opz.mese);
    var nGiorni = giorniNelMese(opz.anno, opz.mese);
    var prima = giornoPrima(inizio);

    var nelMese = attivi(stato).filter(function (m) {
      return m.data >= inizio && m.data <= fine && riguarda(m, repartoId);
    });

    var righe = stato.articoli
      .filter(function (a) { return a.categoria === opz.categoria; })
      .map(function (a) {
        var r = {
          articoloId: a.id,
          denominazione: a.nome,
          residuiPrec: giacenza(stato, a.id, repartoId, prima),
          carichi: 0,
          consumi: [],
          totaleConsumo: 0,
          perdite: 0,
          prezzo: Number(a.prezzo) || 0
        };
        for (var g = 0; g < nGiorni; g++) r.consumi.push(0);
        var movimentato = false;
        nelMese.forEach(function (m) {
          if (m.articoloId !== a.id) return;
          movimentato = true;
          var e = effetto(m, repartoId);
          var giorno = Number(m.data.slice(8, 10));
          if (m.tipo === 'consumo' || (m.tipo === 'trasferimento' && e < 0)) {
            r.consumi[giorno - 1] = r3(r.consumi[giorno - 1] - e);
          } else if (m.tipo === 'perdita') {
            r.perdite = r3(r.perdite - e);
          } else if (e > 0) {
            r.carichi = r3(r.carichi + e);          // carichi, trasferimenti ricevuti, rettifiche in aumento
          } else if (e < 0) {
            r.perdite = r3(r.perdite - e);          // rettifiche in diminuzione
          }
        });
        r.totaleCarico = r3(r.residuiPrec + r.carichi);
        r.totaleConsumo = r3(r.consumi.reduce(function (s, x) { return s + x; }, 0));
        r.totaleScarico = r3(r.totaleConsumo + r.perdite);
        r.residui = r3(r.totaleCarico - r.totaleScarico);
        r.importoScarico = Math.round(r.totaleScarico * r.prezzo * 100) / 100;
        var restanti = lotti(stato, a.id, repartoId, fine).filter(function (l) { return l.quantita > 0 && l.scadenza; });
        r.scadenza = restanti.length ? restanti[0].scadenza : '';
        r.attivo = a.attivo !== false;
        r.vuota = !movimentato && r.residuiPrec === 0;
        return r;
      })
      .filter(function (r) { return opz.includiTutti ? r.attivo || !r.vuota : !r.vuota; })
      .sort(function (x, y) { return x.denominazione.localeCompare(y.denominazione, 'it'); });

    var totali = righe.reduce(function (t, r) {
      t.importoScarico += r.importoScarico;
      return t;
    }, { importoScarico: 0 });
    totali.importoScarico = Math.round(totali.importoScarico * 100) / 100;

    return { righe: righe, giorni: nGiorni, inizio: inizio, fine: fine, totali: totali };
  }

  var api = {
    effetto: effetto,
    r3: r3,
    disponibilitaLotto: disponibilitaLotto,
    giacenza: giacenza,
    tutteLeGiacenze: tutteLeGiacenze,
    lotti: lotti,
    allocaUscita: allocaUscita,
    registroMensile: registroMensile,
    giorniNelMese: giorniNelMese,
    primoGiorno: primoGiorno,
    ultimoGiorno: ultimoGiorno,
    giornoPrima: giornoPrima,
    scadenzaBreve: scadenzaBreve,
    giorniAllaScadenza: giorniAllaScadenza,
    ordinaMovimenti: ordinaMovimenti
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calcoli = api;
})(this);
