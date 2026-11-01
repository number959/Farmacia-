/*
 * Operazioni sul magazzino, con controllo dei permessi e registro attività.
 * Ogni operazione che scrive è una transazione con una nuova revisione (Database.scrivi).
 */
'use strict';

var Calcoli = require('../js/calcoli.js');
var Barcode = require('../js/barcode.js');
var DemoFarmacia = require('../js/demo.js');
var A = require('./accessi.js');
// regole dei magazzini della 3.0 (una sola farmacia centrale, disattivazione): le usa anche PUT /api/reparti della 2.x
var Struttura = require('./struttura.js').Struttura;
var errore = A.errore;
var nuovoId = A.nuovoId;
// magazzino di sistema per la merce in viaggio (DDT partiti e non ancora ricevuti): si muove solo con i DDT
var ID_TRANSITO = require('./db.js').ID_TRANSITO;
var NOME_TRANSITO = 'In transito';

var TIPI = ['carico', 'consumo', 'trasferimento', 'perdita', 'rettifica'];
var USCITE = ['consumo', 'perdita', 'trasferimento'];
var PERMESSO_TIPO = { carico: 'carico', consumo: 'consumo', trasferimento: 'trasferimento', perdita: 'perdita', rettifica: 'rettifica' };
var CATEGORIE = ['FARMACI', 'PRESIDI'];
var MAX_CODICI = 50; // codici a barre per articolo

/* ---------- validazione ---------- */

function testo(v, max, campo) {
  var t = v === undefined || v === null ? '' : String(v).trim();
  if (t.length > max) throw errore(400, 'Il campo ' + campo + ' è troppo lungo (massimo ' + max + ' caratteri).');
  return t;
}

function numero(v, campo, opz) {
  var n = typeof v === 'number' ? v : parseFloat(String(v === undefined || v === null ? '' : v).replace(',', '.'));
  if (!isFinite(n)) {
    if (opz && opz.facoltativo) return opz.predefinito === undefined ? 0 : opz.predefinito;
    throw errore(400, 'Il campo ' + campo + ' non è un numero.');
  }
  if (opz && opz.min !== undefined && n < opz.min) throw errore(400, 'Il campo ' + campo + ' non può essere minore di ' + opz.min + '.');
  if (Math.abs(n) > 1e9) throw errore(400, 'Il campo ' + campo + ' è troppo grande.');
  return Math.round(n * 1000) / 1000;
}

function dataValida(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  var p = d.split('-').map(Number);
  var x = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return x.getUTCFullYear() === p[0] && x.getUTCMonth() === p[1] - 1 && x.getUTCDate() === p[2] && p[0] >= 2000;
}

function oggiLocale(piuGiorni) {
  var d = new Date();
  d.setDate(d.getDate() + (piuGiorni || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function controllaData(d) {
  if (!dataValida(d)) throw errore(400, 'Data non valida.');
  if (d > oggiLocale(1)) throw errore(400, 'Non si possono registrare movimenti con una data futura (' + d + ').');
}

function scadenzaValida(s) {
  if (!s) return '';
  if (typeof s !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw errore(400, 'Scadenza non valida: usa mese e anno.');
  return s;
}

function Operazioni(database, accessi, notifica) {
  this.database = database;
  this.accessi = accessi;
  this.notifica = notifica || function () {};
  this.ultimoCreato = 0;
}

Operazioni.prototype.db = function () { return this.database.dati; };

Operazioni.prototype.richiedi = function (ctx, permesso) {
  if (!ctx.permessi || !ctx.permessi[permesso]) throw errore(403, 'Il tuo utente non può fare questa operazione.');
};

Operazioni.prototype.dopoScrittura = function (r) {
  this.notifica(r.rev);
  return r;
};

/* ---------- movimenti ---------- */

Operazioni.prototype.normalizzaMovimento = function (ctx, m) {
  if (!m || typeof m !== 'object') throw errore(400, 'Movimento non valido.');
  if (TIPI.indexOf(m.tipo) < 0) throw errore(400, 'Tipo di movimento non valido.');
  this.richiedi(ctx, PERMESSO_TIPO[m.tipo]);
  controllaData(m.data);
  var articolo = this.database.articolo(String(m.articoloId || ''));
  if (!articolo) throw errore(400, 'Articolo non trovato: aggiorna la pagina.');
  var reparto = this.database.reparto(String(m.repartoId || ''));
  if (!reparto) throw errore(400, 'Reparto non trovato: aggiorna la pagina.');
  if (reparto.tipo === 'transito') throw errore(400, 'La merce «' + NOME_TRANSITO + '» si sposta solo con i DDT (pagina DDT e consegne).');
  if (!reparto.attivo) throw errore(400, 'Il reparto ' + reparto.nome + ' non è attivo.');
  if (!A.puoScrivereReparto(ctx.permessi, reparto.id)) throw errore(403, 'Non puoi registrare movimenti per il reparto ' + reparto.nome + '.');
  var out = {
    tipo: m.tipo, data: m.data, articoloId: articolo.id, repartoId: reparto.id, repartoDestId: null,
    lotto: testo(m.lotto, 60, 'lotto'), scadenza: scadenzaValida(m.scadenza || ''),
    fornitore: testo(m.fornitore, 200, 'fornitore'), documento: testo(m.documento, 100, 'documento'),
    causale: testo(m.causale, 100, 'causale'), note: testo(m.note, 500, 'note'), prezzo: null
  };
  if (m.tipo === 'rettifica') {
    out.quantita = numero(m.quantita, 'quantità');
    if (!out.quantita) throw errore(400, 'Una rettifica deve avere una quantità diversa da zero.');
  } else {
    out.quantita = numero(m.quantita, 'quantità');
    if (!(out.quantita > 0)) throw errore(400, 'La quantità deve essere maggiore di zero (' + articolo.nome + ').');
  }
  if (m.tipo === 'trasferimento') {
    var dest = this.database.reparto(String(m.repartoDestId || ''));
    if (!dest || !dest.attivo) throw errore(400, 'Reparto di arrivo non valido.');
    if (dest.tipo === 'transito') throw errore(400, 'La merce «' + NOME_TRANSITO + '» si sposta solo con i DDT (pagina DDT e consegne).');
    if (dest.id === reparto.id) throw errore(400, 'Il reparto di partenza e quello di arrivo sono uguali.');
    out.repartoDestId = dest.id;
  }
  if (m.tipo === 'carico' && m.prezzo !== undefined && m.prezzo !== null && m.prezzo !== '') {
    out.prezzo = numero(m.prezzo, 'prezzo', { min: 0 });
  }
  // inventario: la giacenza che il client vedeva quando ha calcolato la differenza
  if (m.tipo === 'rettifica' && m.teorica !== undefined && m.teorica !== null && m.teorica !== '') {
    out.teorica = numero(m.teorica, 'giacenza teorica');
  }
  out.articolo = articolo;
  out.reparto = reparto;
  return out;
};

Operazioni.prototype.inserisciMovimento = function (ctx, rev, m, cache) {
  var id = nuovoId('m');
  // millisecondi sempre crescenti: a parità di data i movimenti restano nell'ordine di registrazione
  var creato = m.creato || Math.max(Date.now(), this.ultimoCreato + 1);
  if (!m.creato) this.ultimoCreato = creato;
  this.db().prepare(
    'INSERT INTO movimenti (id, tipo, data, articolo_id, reparto_id, reparto_dest_id, quantita, lotto, scadenza, fornitore, documento, causale, note, prezzo, operatore, utente_id, creato, rev, ddt_id) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, m.tipo, m.data, m.articoloId, m.repartoId, m.repartoDestId || null, m.quantita, m.lotto || '', m.scadenza || '',
    m.fornitore || '', m.documento || '', m.causale || '', m.note || '', m.prezzo === null || m.prezzo === undefined ? null : m.prezzo,
    m.operatore !== undefined ? m.operatore : (ctx.utente ? ctx.utente.nome : ''), m.utenteId !== undefined ? m.utenteId : (ctx.utente ? ctx.utente.id : null),
    creato, rev, m.ddtId || null);
  if (cache && cache[m.articoloId]) {
    cache[m.articoloId].push({ id: id, tipo: m.tipo, data: m.data, articoloId: m.articoloId, repartoId: m.repartoId,
      repartoDestId: m.repartoDestId || undefined, quantita: m.quantita, lotto: m.lotto || '', scadenza: m.scadenza || '', creato: creato, annullato: null,
      ddtId: m.ddtId || null });
  }
  return id;
};

/*
 * Movimenti di un articolo per i calcoli dentro una transazione: letti una volta sola dal database
 * e poi aggiornati a ogni inserimento (cache), così anche centinaia di righe restano veloci.
 */
Operazioni.prototype.statoArticolo = function (articoloId, cache) {
  if (!cache[articoloId]) cache[articoloId] = this.database.movimentiArticolo(articoloId);
  return { articoli: [], movimenti: cache[articoloId] };
};

/*
 * Ripartisce un'uscita sui lotti (FEFO), compresi i movimenti già inseriti in questa transazione.
 * Un'uscita con data passata non prende i lotti che dopo quella data sono già usciti (Calcoli.lottiDisponibili);
 * la scelta automatica salta i lotti già scaduti finché ce ne sono altri, tranne per le perdite (che li tolgono).
 */
Operazioni.prototype.ripartisci = function (m, cache) {
  var stato = this.statoArticolo(m.articoloId, cache);
  if (m.lotto && Calcoli.disponibilitaLotto(stato, m.articoloId, m.repartoId, m.data, m.lotto) <= 0) {
    throw errore(409, 'Il lotto ' + m.lotto + ' di ' + m.articolo.nome + ' non è più disponibile in ' + m.reparto.nome +
      ' alla data indicata (forse l’ha appena usato un altro utente, o è già uscito dopo quella data): aggiorna e scegli di nuovo il lotto.');
  }
  return Calcoli.allocaUscita(stato, m.articoloId, m.repartoId, m.data, m.quantita, m.lotto, { ancheScaduti: m.tipo === 'perdita' });
};

Operazioni.prototype.registraMovimenti = function (ctx, lista) {
  if (!Array.isArray(lista) || !lista.length) throw errore(400, 'Nessun movimento da registrare.');
  if (lista.length > 500) throw errore(400, 'Troppi movimenti in una volta sola (massimo 500).');
  var self = this;
  var normalizzati = lista.map(function (m) { return self.normalizzaMovimento(ctx, m); });
  var r = this.database.scrivi(function (rev) {
    var creati = [];
    var cache = {};
    var cambiati = [];
    normalizzati.forEach(function (m) {
      if (m.tipo === 'rettifica' && m.teorica !== undefined) {
        var attuale = Calcoli.giacenza(self.statoArticolo(m.articoloId, cache), m.articoloId, m.repartoId, m.data);
        if (Calcoli.r3(attuale) !== Calcoli.r3(m.teorica)) cambiati.push(m.articolo.nome + ' (ora ' + Calcoli.r3(attuale) + ')');
      }
    });
    if (cambiati.length) {
      var e = errore(409, 'Mentre contavi, altri movimenti hanno cambiato la giacenza di: ' + cambiati.join(', ') +
        '. Ho aggiornato le giacenze: controlla le differenze e registra di nuovo.');
      throw e;
    }
    normalizzati.forEach(function (m) {
      self.statoArticolo(m.articoloId, cache);
      if (USCITE.indexOf(m.tipo) >= 0) {
        self.ripartisci(m, cache).forEach(function (p) {
          creati.push(self.inserisciMovimento(ctx, rev, Object.assign({}, m, { quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza }), cache));
        });
      } else {
        creati.push(self.inserisciMovimento(ctx, rev, m, cache));
      }
      if (m.tipo === 'carico' && m.prezzo !== null && m.prezzo !== m.articolo.prezzo) {
        self.db().prepare('UPDATE articoli SET prezzo = ?, versione = versione + 1, rev = ? WHERE id = ?').run(m.prezzo, rev, m.articoloId);
        m.articolo.prezzo = m.prezzo;
      }
    });
    return creati.map(function (id) { return self.database.movimento(id); });
  });
  this.accessi.evento(ctx, 'movimenti.registra', {
    movimenti: normalizzati.map(function (m) {
      return { tipo: m.tipo, data: m.data, articolo: m.articolo.nome, reparto: m.repartoId, verso: m.repartoDestId || undefined, quantita: m.quantita, lotto: m.lotto || undefined };
    })
  });
  this.dopoScrittura(r);
  return { rev: r.rev, movimenti: r.risultato };
};

Operazioni.prototype.annullaMovimento = function (ctx, id, motivo) {
  var m = this.database.movimento(String(id));
  if (!m) throw errore(404, 'Movimento non trovato.');
  if (m.annullato) throw errore(409, 'Il movimento è già stato annullato.');
  if (m.ddtId) {
    // i movimenti dei DDT (partenza, arrivo, differenze) si annullano tutti insieme annullando il DDT
    var d = this.db().prepare('SELECT numero, stato FROM ddt WHERE id = ?').get(m.ddtId);
    var numero = d ? d.numero : '';
    if (d && d.stato === 'in_transito') {
      throw errore(409, 'Questo movimento fa parte del DDT ' + numero + ': per annullarlo annulla il DDT dalla pagina DDT e consegne (la merce rientra nel magazzino di partenza).');
    }
    throw errore(409, 'Questo movimento fa parte del DDT ' + numero + ', già ' + (d && d.stato === 'annullato' ? 'annullato' : 'ricevuto') +
      ': non si annulla da qui. Per restituire la merce prepara un DDT di reso dalla pagina Trasferimenti.');
  }
  var proprio = (m.tipo === 'consumo' || m.tipo === 'perdita') && m.utenteId === ctx.utente.id &&
    ctx.permessi[m.tipo] && A.puoScrivereReparto(ctx.permessi, m.repartoId);
  if (!ctx.permessi.annullaTutti && !proprio) throw errore(403, 'Puoi annullare solo i consumi e le perdite che hai registrato tu nei tuoi reparti.');
  motivo = testo(motivo, 300, 'motivo') || 'Annullato';
  var self = this;
  var r = this.database.scrivi(function (rev) {
    self.db().prepare('UPDATE movimenti SET annullato_il = ?, annullato_da = ?, annullato_motivo = ?, rev = ? WHERE id = ? AND annullato_il IS NULL')
      .run(new Date().toISOString(), ctx.utente.nome, motivo, rev, m.id);
  });
  var art = this.database.articolo(m.articoloId);
  this.accessi.evento(ctx, 'movimenti.annulla', { tipo: m.tipo, data: m.data, articolo: art ? art.nome : m.articoloId, quantita: m.quantita, reparto: m.repartoId, motivo: motivo, registratoDa: m.operatore });
  this.dopoScrittura(r);
  return { rev: r.rev };
};

/* Correzione dal registro mensile: il consumo del giorno diventa `quantita`. */
Operazioni.prototype.consumoGiorno = function (ctx, dati) {
  this.richiedi(ctx, 'registro');
  var m = this.normalizzaMovimento(ctx, { tipo: 'consumo', data: dati && dati.data, articoloId: dati && dati.articoloId, repartoId: dati && dati.repartoId, quantita: 1 });
  var quantita = numero(dati.quantita, 'quantità', { min: 0 });
  // il valore che il client vedeva: se nel frattempo altri hanno registrato consumi per quel giorno, non li cancello
  var prima = dati.prima === undefined || dati.prima === null || dati.prima === '' ? null : numero(dati.prima, 'valore precedente', { min: 0 });
  var self = this;
  var precedenti = 0;
  var r = this.database.scrivi(function (rev) {
    var esistenti = self.db().prepare("SELECT id, quantita FROM movimenti WHERE tipo = 'consumo' AND articolo_id = ? AND reparto_id = ? AND data = ? AND annullato_il IS NULL")
      .all(m.articoloId, m.repartoId, m.data);
    esistenti.forEach(function (e) { precedenti = Calcoli.r3(precedenti + e.quantita); });
    if (prima !== null && prima !== precedenti) {
      throw errore(409, 'Nel frattempo un altro utente ha registrato consumi di ' + m.articolo.nome + ' per quel giorno (ora ' +
        precedenti + '): ho aggiornato il registro, controlla e correggi di nuovo se serve.');
    }
    var adesso = new Date().toISOString();
    esistenti.forEach(function (e) {
      self.db().prepare('UPDATE movimenti SET annullato_il = ?, annullato_da = ?, annullato_motivo = ?, rev = ? WHERE id = ?')
        .run(adesso, ctx.utente.nome, 'Corretto dal registro mensile', rev, e.id);
    });
    if (quantita > 0) {
      var nuovo = Object.assign({}, m, { quantita: quantita, note: 'Dal registro mensile' });
      self.ripartisci(nuovo, {}).forEach(function (p) {
        self.inserisciMovimento(ctx, rev, Object.assign({}, nuovo, { quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza }));
      });
    }
  });
  this.accessi.evento(ctx, 'registro.consumo-giorno', { articolo: m.articolo.nome, reparto: m.repartoId, data: m.data, prima: precedenti, dopo: quantita });
  this.dopoScrittura(r);
  return { rev: r.rev };
};

/* ---------- articoli ---------- */

function mancante(v) { return v === undefined || v === null || v === ''; }

/* Codici a barre dell'articolo: chiavi normalizzate (js/barcode.js), senza doppioni. undefined = non indicati. */
function validaCodici(lista) {
  if (lista === undefined || lista === null) return undefined;
  if (!Array.isArray(lista)) throw errore(400, 'Codici a barre non validi.');
  var out = [];
  lista.forEach(function (k) {
    var n = Barcode.normalizzaChiave(k);
    if (!n) throw errore(400, 'Codice a barre non valido: ' + String(k).slice(0, 80) + '.');
    if (out.indexOf(n) < 0) out.push(n);
  });
  if (out.length > MAX_CODICI) throw errore(400, 'Troppi codici a barre per un articolo (massimo ' + MAX_CODICI + ').');
  return out;
}

/* Pezzi (unità) in una confezione letta con il lettore: numero maggiore di zero. undefined = non indicati. */
function validaPezzi(v) {
  if (mancante(v)) return undefined;
  var n = numero(v, 'pezzi per confezione');
  if (!(n > 0)) throw errore(400, 'I pezzi per confezione devono essere più di zero.');
  if (n > 100000) throw errore(400, 'I pezzi per confezione sono troppi (massimo 100000).');
  return n;
}

/* Caratteristiche dell'articolo (docs/NOVITA-3.0.md): servono alla disposizione negli armadi e alle previsioni. */
var ATTRIBUTI = ['frigo', 'stupefacente', 'alto-rischio', 'lasa', 'urgenza'];

/* Attributi dell'articolo: sottoinsieme di ATTRIBUTI, nell'ordine dell'elenco. undefined = non indicati. */
function validaAttributi(lista) {
  if (lista === undefined) return undefined;
  if (lista === null || lista === '') return [];
  if (!Array.isArray(lista)) throw errore(400, 'Caratteristiche dell’articolo non valide.');
  lista.forEach(function (x) {
    if (ATTRIBUTI.indexOf(x) < 0) throw errore(400, 'Caratteristica dell’articolo non valida: ' + String(x).slice(0, 40) + '.');
  });
  return ATTRIBUTI.filter(function (x) { return lista.indexOf(x) >= 0; });
}

/* Giorni di consegna del fornitore per l'articolo: 0–365, vuoto (null) = l'impostazione generale. undefined = non indicati. */
function validaLeadTime(v) {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === 'string' && !v.trim())) return null;
  var n = numero(v, 'giorni di consegna');
  if (n < 0 || n > 365) throw errore(400, 'I giorni di consegna vanno da 0 a 365 (lascia vuoto per usare quelli generali).');
  return Math.round(n); // giorni interi, come li usano le previsioni
}

function validaArticolo(dati) {
  if (!dati || typeof dati !== 'object') throw errore(400, 'Articolo non valido.');
  var nome = testo(dati.nome, 200, 'denominazione');
  if (!nome) throw errore(400, 'Scrivi la denominazione.');
  var categoria = CATEGORIE.indexOf(dati.categoria) >= 0 ? dati.categoria : null;
  if (!categoria) throw errore(400, 'Categoria non valida.');
  return {
    nome: nome, categoria: categoria,
    unita: testo(dati.unita, 30, 'unità'), principio: testo(dati.principio, 200, 'principio attivo'),
    confezione: testo(dati.confezione, 200, 'confezione'), codice: testo(dati.codice, 60, 'codice'),
    prezzo: numero(dati.prezzo, 'prezzo', { min: 0, facoltativo: true }),
    scortaMinima: numero(dati.scortaMinima, 'scorta minima', { min: 0, facoltativo: true }),
    note: testo(dati.note, 1000, 'note'), attivo: dati.attivo !== false,
    barcode: validaCodici(dati.barcode),
    pezziConfezione: validaPezzi(dati.pezziConfezione),
    attributi: validaAttributi(dati.attributi),
    leadTime: validaLeadTime(dati.leadTime),
    fornitore: dati.fornitore === undefined ? undefined : testo(dati.fornitore, 200, 'fornitore abituale')
  };
}

/* Valori predefiniti (articolo nuovo) o di prima (modifica) per i campi che il client non ha mandato. */
function completaArticolo(a, prima) {
  if (a.barcode === undefined) a.barcode = prima ? prima.barcode : [];
  if (a.pezziConfezione === undefined) a.pezziConfezione = prima ? prima.pezziConfezione : 1;
  if (a.attributi === undefined) a.attributi = prima ? prima.attributi : [];
  if (a.leadTime === undefined) a.leadTime = prima ? prima.leadTime : null;
  if (a.fornitore === undefined) a.fornitore = prima ? prima.fornitore : '';
  return a;
}

/* Un codice a barre appartiene a un solo articolo: 409 con il nome dell'articolo che l'ha già. */
Operazioni.prototype.controllaCodici = function (codici, articoloId) {
  var self = this;
  (codici || []).forEach(function (k) {
    var altro = self.database.articoloConCodice(k, articoloId);
    if (altro) throw errore(409, 'Il codice ' + Barcode.descrivi(k) + ' è già associato all’articolo «' + altro.nome + '».');
  });
};

Operazioni.prototype.creaArticolo = function (ctx, dati) {
  this.richiedi(ctx, 'articoli');
  var a = completaArticolo(validaArticolo(dati), null);
  if (this.database.articoloPerNome(a.nome)) throw errore(409, 'Esiste già un articolo con questo nome.');
  var self = this;
  var id = nuovoId('a');
  var r = this.database.scrivi(function (rev) {
    self.controllaCodici(a.barcode, id);
    self.db().prepare('INSERT INTO articoli (id, nome, categoria, unita, principio, confezione, codice, prezzo, scorta_minima, note, attivo, barcode, pezzi_confezione, attributi, lead_time, fornitore, versione, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, a.nome, a.categoria, a.unita, a.principio, a.confezione, a.codice, a.prezzo, a.scortaMinima, a.note, a.attivo ? 1 : 0, JSON.stringify(a.barcode), a.pezziConfezione,
        JSON.stringify(a.attributi), a.leadTime, a.fornitore, rev);
  });
  this.accessi.evento(ctx, 'articoli.crea', {
    articolo: a.nome, categoria: a.categoria, barcode: a.barcode.length ? a.barcode : undefined,
    attributi: a.attributi.length ? a.attributi : undefined, leadTime: a.leadTime === null ? undefined : a.leadTime, fornitore: a.fornitore || undefined
  });
  this.dopoScrittura(r);
  return { rev: r.rev, articolo: this.database.articolo(id) };
};

Operazioni.prototype.modificaArticolo = function (ctx, id, dati) {
  this.richiedi(ctx, 'articoli');
  var prima = this.database.articolo(String(id));
  if (!prima) throw errore(404, 'Articolo non trovato.');
  if (Number(dati && dati.versione) !== prima.versione) {
    throw errore(409, 'Un altro utente ha modificato questo articolo nel frattempo: ricarico i dati, controlla e riprova.');
  }
  var a = validaArticolo(dati);
  var doppio = this.database.articoloPerNome(a.nome);
  if (doppio && doppio.id !== prima.id) throw errore(409, 'Esiste già un articolo con questo nome.');
  // chi non manda codici a barre, pezzi per confezione, caratteristiche, giorni di consegna o fornitore
  // (client vecchi, importazioni) non li cancella
  completaArticolo(a, prima);
  var self = this;
  var r = this.database.scrivi(function (rev) {
    self.controllaCodici(a.barcode, prima.id);
    self.db().prepare('UPDATE articoli SET nome = ?, categoria = ?, unita = ?, principio = ?, confezione = ?, codice = ?, prezzo = ?, scorta_minima = ?, note = ?, attivo = ?, barcode = ?, pezzi_confezione = ?, ' +
      'attributi = ?, lead_time = ?, fornitore = ?, versione = versione + 1, rev = ? WHERE id = ?')
      .run(a.nome, a.categoria, a.unita, a.principio, a.confezione, a.codice, a.prezzo, a.scortaMinima, a.note, a.attivo ? 1 : 0, JSON.stringify(a.barcode), a.pezziConfezione,
        JSON.stringify(a.attributi), a.leadTime, a.fornitore, rev, prima.id);
  });
  var cambi = {};
  Object.keys(a).forEach(function (k) { if (JSON.stringify(a[k]) !== JSON.stringify(prima[k])) cambi[k] = { prima: prima[k], dopo: a[k] }; });
  this.accessi.evento(ctx, 'articoli.modifica', { articolo: prima.nome, cambi: cambi });
  this.dopoScrittura(r);
  return { rev: r.rev, articolo: this.database.articolo(prima.id) };
};

/*
 * Associa un codice letto a un articolo (dalla finestra "Codice non riconosciuto").
 * Idempotente se il codice è già dell'articolo; 409 se è di un altro articolo; 400 se la chiave non è valida.
 */
Operazioni.prototype.associaCodice = function (ctx, id, chiave) {
  this.richiedi(ctx, 'articoli');
  var a = this.database.articolo(String(id));
  if (!a) throw errore(404, 'Articolo non trovato.');
  var k = Barcode.normalizzaChiave(chiave);
  if (!k) throw errore(400, 'Codice a barre non valido.');
  if (a.barcode.indexOf(k) >= 0) return { rev: this.database.rev(), articolo: a };
  if (a.barcode.length >= MAX_CODICI) throw errore(400, 'Troppi codici a barre per un articolo (massimo ' + MAX_CODICI + ').');
  var self = this;
  var r = this.database.scrivi(function (rev) {
    self.controllaCodici([k], a.id);
    self.db().prepare('UPDATE articoli SET barcode = ?, versione = versione + 1, rev = ? WHERE id = ?').run(JSON.stringify(a.barcode.concat([k])), rev, a.id);
  });
  this.accessi.evento(ctx, 'articoli.barcode', { articolo: a.nome, chiave: k });
  this.dopoScrittura(r);
  return { rev: r.rev, articolo: this.database.articolo(a.id) };
};

Operazioni.prototype.eliminaArticolo = function (ctx, id) {
  this.richiedi(ctx, 'articoli');
  var a = this.database.articolo(String(id));
  if (!a) throw errore(404, 'Articolo non trovato.');
  var db = this.db();
  if (db.prepare('SELECT 1 FROM movimenti WHERE articolo_id = ? LIMIT 1').get(a.id)) {
    throw errore(409, 'L’articolo ha dei movimenti: non si può eliminare. Togli la spunta “Articolo attivo” per nasconderlo.');
  }
  if (db.prepare('SELECT 1 FROM richieste_righe WHERE articolo_id = ? LIMIT 1').get(a.id) ||
    db.prepare('SELECT 1 FROM ddt_righe WHERE articolo_id = ? LIMIT 1').get(a.id)) {
    throw errore(409, 'L’articolo compare in richieste o DDT: non si può eliminare. Togli la spunta “Articolo attivo” per nasconderlo.');
  }
  // l'assortimento è solo configurazione: le righe già tolte (non attive) si cancellano con l'articolo,
  // quelle attive no (l'articolo è ancora previsto in quei magazzini)
  var nelleScorte = db.prepare('SELECT s.reparto_id, r.nome FROM assortimento s LEFT JOIN reparti r ON r.id = s.reparto_id WHERE s.articolo_id = ? AND s.attivo = 1 ORDER BY r.ordine')
    .all(a.id).map(function (x) { return x.nome || x.reparto_id; });
  if (nelleScorte.length) {
    throw errore(409, 'L’articolo è nell’assortimento di ' + nelleScorte.join(', ') + ': toglilo prima da Magazzini e assortimento, ' +
      'oppure togli la spunta “Articolo attivo” per nasconderlo.');
  }
  var righe = db.prepare('SELECT id FROM assortimento WHERE articolo_id = ?').all(a.id).map(function (x) { return x.id; });
  var self = this;
  var r = this.database.scrivi(function (rev) {
    var canc = self.db().prepare('INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)');
    righe.forEach(function (id) {
      self.db().prepare('DELETE FROM assortimento WHERE id = ?').run(id);
      canc.run('assortimento', id, rev);
    });
    self.db().prepare('DELETE FROM articoli WHERE id = ?').run(a.id);
    canc.run('articoli', a.id, rev);
  });
  this.accessi.evento(ctx, 'articoli.elimina', { articolo: a.nome, assortimento: righe.length || undefined });
  this.dopoScrittura(r);
  return { rev: r.rev };
};

Operazioni.prototype.importaArticoli = function (ctx, dati) {
  this.richiedi(ctx, 'articoli');
  var lista = dati && Array.isArray(dati.articoli) ? dati.articoli : [];
  if (!lista.length) throw errore(400, 'Nessun articolo da importare.');
  if (lista.length > 5000) throw errore(400, 'Troppi articoli in un solo file (massimo 5000).');
  var conGiacenza = !!dati.conGiacenza;
  var reparto = null;
  if (conGiacenza) {
    this.richiedi(ctx, 'carico');
    controllaData(dati.data);
    reparto = this.database.reparto(String(dati.repartoId || ''));
    if (!reparto || !reparto.attivo) throw errore(400, 'Reparto per la giacenza iniziale non valido.');
  }
  var origine = testo(dati.origine, 200, 'origine');
  var validi = lista.map(function (x) {
    if (!x || typeof x !== 'object') throw errore(400, 'Articolo non valido.');
    var a = completaArticolo(validaArticolo({
      nome: x.nome, categoria: x.categoria, prezzo: x.prezzo, scortaMinima: x.scortaMinima, unita: x.unita,
      attributi: x.attributi, leadTime: x.leadTime, fornitore: x.fornitore
    }), null);
    a.giacenza = numero(x.giacenza, 'giacenza', { facoltativo: true });
    return a;
  });
  var self = this;
  var nuovi = 0;
  var carichi = 0;
  var saltati = 0;
  var r = this.database.scrivi(function (rev) {
    validi.forEach(function (a) {
      var esiste = self.database.articoloPerNome(a.nome);
      var id = esiste ? esiste.id : nuovoId('a');
      if (!esiste) {
        self.db().prepare('INSERT INTO articoli (id, nome, categoria, unita, prezzo, scorta_minima, attributi, lead_time, fornitore, attivo, versione, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)')
          .run(id, a.nome, a.categoria, a.unita, a.prezzo, a.scortaMinima, JSON.stringify(a.attributi), a.leadTime, a.fornitore, rev);
        nuovi++;
      }
      if (conGiacenza && a.giacenza > 0) {
        // la giacenza iniziale vale solo per chi non ha ancora movimenti in quel reparto: reimportare
        // lo stesso file (o il modulo del mese dopo) non deve raddoppiare le giacenze
        var giaMovimentato = esiste && self.db().prepare('SELECT 1 FROM movimenti WHERE articolo_id = ? AND (reparto_id = ? OR reparto_dest_id = ?) AND annullato_il IS NULL LIMIT 1')
          .get(id, reparto.id, reparto.id);
        if (giaMovimentato) { saltati++; return; }
        self.inserisciMovimento(ctx, rev, { tipo: 'carico', data: dati.data, articoloId: id, repartoId: reparto.id, quantita: a.giacenza, note: 'Giacenza iniziale importata' + (origine ? ' da ' + origine : '') });
        carichi++;
      }
    });
  });
  this.accessi.evento(ctx, 'articoli.importa', { origine: origine, righe: validi.length, nuovi: nuovi, carichi: carichi, saltati: saltati, reparto: reparto ? reparto.id : undefined });
  this.dopoScrittura(r);
  return { rev: r.rev, nuovi: nuovi, carichi: carichi, saltati: saltati };
};

/* ---------- impostazioni e reparti ---------- */

/* Impostazioni valide (usata sia da Configura sia dall'importazione dell'archivio). */
function validaImpostazioni(dati) {
  dati = dati || {};
  var nuove = {
    struttura: testo(dati.struttura, 100, 'struttura') || 'Clinica Posillipo',
    sottotitolo: testo(dati.sottotitolo, 100, 'sottotitolo'),
    societa: testo(dati.societa, 100, 'società'),
    citta: testo(dati.citta, 100, 'città'),
    codiceModulo: testo(dati.codiceModulo, 60, 'codice del modulo'),
    giorniAvvisoScadenza: Math.round(numero(dati.giorniAvvisoScadenza, 'giorni di avviso', { min: 1, facoltativo: true, predefinito: 90 })) || 90
  };
  if (nuove.giorniAvvisoScadenza > 3650) nuove.giorniAvvisoScadenza = 3650;
  if (dati.logo !== undefined) {
    // '' = marchio incorporato (brand/), 'nessuno' = nessun logo, altrimenti un'immagine caricata dall'amministratore
    var logo = String(dati.logo || '');
    if (logo && logo !== 'nessuno' && !/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw errore(400, 'Il logo deve essere un’immagine PNG, JPEG, GIF, WebP o SVG.');
    if (logo.length > 600000) throw errore(400, 'Il logo è troppo grande: usa un’immagine sotto i 400 KB.');
    nuove.logo = logo;
  }
  // versione 3.0: si cambiano solo se arrivano (docs/NOVITA-3.0.md, "Impostazioni nuove")
  if (dati.nomeProdotto !== undefined) nuove.nomeProdotto = testo(dati.nomeProdotto, 60, 'nome del prodotto') || 'NefroCenter Pharmacy';
  if (dati.sigla !== undefined) nuove.sigla = testo(dati.sigla, 20, 'sigla');
  if (dati.coloreAccento !== undefined) {
    var col = String(dati.coloreAccento || '').trim();
    if (col && !/^#[0-9a-fA-F]{6}$/.test(col)) throw errore(400, 'Il colore deve essere nella forma #RRGGBB.');
    nuove.coloreAccento = col;
  }
  if (dati.tema !== undefined) {
    if (['automatico', 'chiaro', 'scuro'].indexOf(dati.tema) < 0) throw errore(400, 'Tema non valido.');
    nuove.tema = dati.tema;
  }
  if (dati.leadTimeGiorni !== undefined) nuove.leadTimeGiorni = Math.min(365, Math.max(0, numero(dati.leadTimeGiorni, 'giorni di consegna', { min: 0 })));
  if (dati.periodoRevisioneGiorni !== undefined) nuove.periodoRevisioneGiorni = Math.min(365, Math.max(1, numero(dati.periodoRevisioneGiorni, 'periodo di revisione', { min: 1 })));
  if (dati.livelloServizio !== undefined) {
    var ls = numero(dati.livelloServizio, 'livello di servizio', { min: 0.5 });
    if (ls >= 1) throw errore(400, 'Il livello di servizio va da 0,50 a 0,999.');
    nuove.livelloServizio = ls;
  }
  if (dati.storicoGiorni !== undefined) nuove.storicoGiorni = Math.round(Math.min(1095, Math.max(28, numero(dati.storicoGiorni, 'giorni di storico', { min: 28 }))));
  return nuove;
}

Operazioni.prototype.salvaImpostazioni = function (ctx, dati) {
  this.richiedi(ctx, 'impostazioni');
  var prima = this.database.impostazioni();
  var nuove = validaImpostazioni(dati);
  var self = this;
  var r = this.database.scrivi(function (rev) {
    var st = self.db().prepare('INSERT INTO impostazioni (chiave, valore, rev) VALUES (?, ?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore, rev = excluded.rev');
    Object.keys(nuove).forEach(function (k) {
      if (JSON.stringify(prima[k]) !== JSON.stringify(nuove[k])) st.run(k, JSON.stringify(nuove[k]), rev);
    });
  });
  var cambi = {};
  Object.keys(nuove).forEach(function (k) { if (prima[k] !== nuove[k]) cambi[k] = k === 'logo' ? '(immagine)' : { prima: prima[k], dopo: nuove[k] }; });
  this.accessi.evento(ctx, 'impostazioni.modifica', cambi);
  this.dopoScrittura(r);
  return { rev: r.rev, impostazioni: this.database.impostazioni() };
};

Operazioni.prototype.salvaReparti = function (ctx, dati) {
  this.richiedi(ctx, 'impostazioni');
  var lista = dati && Array.isArray(dati.reparti) ? dati.reparti : null;
  if (!lista || !lista.length) throw errore(400, 'Elenco dei reparti vuoto.');
  if (lista.length > 200) throw errore(400, 'Troppi reparti.');
  var esistenti = {};
  this.database.reparti().forEach(function (r) { esistenti[r.id] = r; });
  // il magazzino "In transito" è del programma: se arriva nell'elenco resta com'è
  lista = lista.filter(function (r) { return !(r && r.id && esistenti[String(r.id)] && esistenti[String(r.id)].tipo === 'transito'); });
  if (!lista.length) throw errore(400, 'Elenco dei reparti vuoto.');
  var nomi = {};
  nomi[NOME_TRANSITO.toLowerCase()] = 'riservato';
  // i nomi dei magazzini che non sono nell'elenco restano: niente doppioni nemmeno con loro
  var inElenco = {};
  lista.forEach(function (r) { if (r && r.id) inElenco[String(r.id)] = true; });
  Object.keys(esistenti).forEach(function (id) {
    if (!inElenco[id] && esistenti[id].tipo !== 'transito') nomi[esistenti[id].nome.toLowerCase()] = true;
  });
  var centraleVisto = false;
  var norm = lista.map(function (r, i) {
    var nome = testo(r && r.nome, 80, 'nome del reparto');
    if (!nome) throw errore(400, 'Ogni reparto deve avere un nome.');
    var k = nome.toLowerCase();
    if (nomi[k] === 'riservato') throw errore(400, 'Il nome «' + NOME_TRANSITO + '» è riservato alla merce in viaggio con i DDT: scegli un altro nome.');
    if (nomi[k]) throw errore(400, 'Due reparti hanno lo stesso nome: ' + nome + '.');
    nomi[k] = true;
    var id = r.id ? String(r.id) : null;
    if (id && !esistenti[id]) throw errore(400, 'Reparto non trovato: aggiorna la pagina.');
    var centrale = !!r.centrale && !centraleVisto;
    if (centrale) centraleVisto = true;
    return { id: id || nuovoId('r'), nome: nome, centrale: centrale, attivo: r.attivo !== false, ordine: i, nuovo: !id };
  });
  /*
   * Interfaccia della 2.x: valgono le stesse regole dei magazzini della 3.0 (server/struttura.js). Lo stato finale
   * comprende anche i magazzini che non sono nell'elenco (restano come sono): una sola farmacia centrale, sempre
   * attiva (sceglierne un'altra declassa quella di prima a periferico), e un magazzino non si disattiva con DDT da
   * spedire o in viaggio o richieste aperte.
   */
  var finale = {};
  var centraliPrima = 0;
  Object.keys(esistenti).forEach(function (id) {
    var e = esistenti[id];
    if (e.tipo === 'transito') return;
    var c = e.tipo === 'centrale' || !!e.centrale;
    if (c) centraliPrima++;
    finale[id] = { nome: e.nome, centrale: c, attivo: !!e.attivo };
  });
  var nuovoCentrale = norm.filter(function (x) { return x.centrale; })[0] || null;
  norm.forEach(function (x) { finale[x.id] = { nome: x.nome, centrale: x.centrale, attivo: x.attivo }; });
  if (nuovoCentrale) Object.keys(finale).forEach(function (id) { if (id !== nuovoCentrale.id) finale[id].centrale = false; });
  var centrali = Object.keys(finale).filter(function (id) { return finale[id].centrale; });
  if (centrali.length > 1) throw errore(400, 'Ci può essere una sola farmacia centrale: indica quale.');
  if (!centrali.length && centraliPrima) {
    throw errore(400, 'Ci vuole sempre una farmacia centrale: per cambiarla, apri il magazzino che deve diventarlo e scegli «Farmacia centrale».');
  }
  if (centrali.length && !finale[centrali[0]].attivo) {
    throw errore(400, 'La farmacia centrale non si può disattivare: prima scegli un altro magazzino come farmacia centrale.');
  }
  if (!Object.keys(finale).some(function (id) { return finale[id].attivo; })) throw errore(400, 'Deve restare almeno un reparto attivo.');
  var regole = new Struttura({ database: this.database, accessi: this.accessi });
  norm.forEach(function (x) {
    if (!x.nuovo && esistenti[x.id].attivo && !x.attivo) regole.controllaDisattivazione(esistenti[x.id]);
  });
  var exCentrale = null;
  if (nuovoCentrale) {
    Object.keys(esistenti).forEach(function (id) {
      var e = esistenti[id];
      if (id !== nuovoCentrale.id && e.tipo !== 'transito' && (e.tipo === 'centrale' || e.centrale)) exCentrale = e.nome;
    });
  }
  var self = this;
  var r = this.database.scrivi(function (rev) {
    if (nuovoCentrale) regole.declassaCentrale(rev, nuovoCentrale.id);
    norm.forEach(function (x) {
      // tipo e centrale sempre coerenti: 'centrale' solo per il reparto centrale, gli altri 'periferico'
      var tipo = x.centrale ? 'centrale' : 'periferico';
      if (x.nuovo) {
        self.db().prepare('INSERT INTO reparti (id, nome, centrale, attivo, ordine, rev, tipo) VALUES (?, ?, ?, ?, ?, ?, ?)').run(x.id, x.nome, x.centrale ? 1 : 0, x.attivo ? 1 : 0, x.ordine, rev, tipo);
      } else {
        self.db().prepare('UPDATE reparti SET nome = ?, centrale = ?, attivo = ?, ordine = ?, tipo = ?, rev = ? WHERE id = ?').run(x.nome, x.centrale ? 1 : 0, x.attivo ? 1 : 0, x.ordine, tipo, rev, x.id);
      }
    });
  });
  this.accessi.evento(ctx, 'reparti.modifica', {
    reparti: norm.map(function (x) { return { id: x.id, nome: x.nome, centrale: x.centrale, attivo: x.attivo, nuovo: x.nuovo }; }),
    exCentrale: exCentrale || undefined
  });
  this.dopoScrittura(r);
  return { rev: r.rev, reparti: this.database.reparti() };
};

Operazioni.prototype.eliminaReparto = function (ctx, id) {
  this.richiedi(ctx, 'impostazioni');
  var rep = this.database.reparto(String(id));
  if (!rep) throw errore(404, 'Reparto non trovato.');
  if (rep.tipo === 'transito') throw errore(400, 'Il magazzino «' + NOME_TRANSITO + '» è del programma (la merce in viaggio con i DDT): non si può eliminare.');
  if (rep.tipo === 'centrale' || rep.centrale) {
    throw errore(400, 'La farmacia centrale non si elimina: prima scegli un altro magazzino come farmacia centrale.');
  }
  if (this.db().prepare('SELECT 1 FROM movimenti WHERE reparto_id = ? OR reparto_dest_id = ? LIMIT 1').get(rep.id, rep.id)) {
    throw errore(409, 'Il reparto ha dei movimenti: non si può eliminare. Togli la spunta “Attivo” per nasconderlo.');
  }
  if (this.db().prepare('SELECT 1 FROM richieste WHERE reparto_id = ? OR fornitore_id = ? LIMIT 1').get(rep.id, rep.id) ||
    this.db().prepare('SELECT 1 FROM ddt WHERE origine_id = ? OR destinazione_id = ? LIMIT 1').get(rep.id, rep.id)) {
    throw errore(409, 'Il reparto compare in richieste o DDT: non si può eliminare. Togli la spunta “Attivo” per nasconderlo.');
  }
  if (this.db().prepare('SELECT 1 FROM armadi WHERE reparto_id = ? LIMIT 1').get(rep.id) ||
    this.db().prepare('SELECT 1 FROM assortimento WHERE reparto_id = ? LIMIT 1').get(rep.id)) {
    throw errore(409, 'Il reparto ha armadi o un assortimento: toglili prima da Magazzini e assortimento, oppure togli la spunta “Attivo” per nasconderlo.');
  }
  if (this.database.reparti().filter(function (r) { return r.tipo !== 'transito'; }).length <= 1) throw errore(400, 'Deve restare almeno un reparto.');
  var self = this;
  var r = this.database.scrivi(function (rev) {
    self.db().prepare('DELETE FROM reparti WHERE id = ?').run(rep.id);
    self.db().prepare('INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)').run('reparti', rep.id, rev);
  });
  var toccati = this.togliRepartoDagliUtenti([rep.id]);
  this.accessi.evento(ctx, 'reparti.elimina', { reparto: rep.nome });
  this.dopoScrittura(r);
  return { rev: r.rev, utentiAggiornati: toccati };
};

/* Toglie i reparti indicati dagli utenti di reparto (accessi.db). Restituisce gli id degli utenti cambiati. */
Operazioni.prototype.togliRepartoDagliUtenti = function (repartiIds) {
  var acc = this.database.accessi;
  var toccati = [];
  acc.prepare('SELECT id, reparti FROM utenti').all().forEach(function (u) {
    var l = [];
    try { l = JSON.parse(u.reparti); } catch (e) { l = []; }
    var resta = l.filter(function (x) { return repartiIds.indexOf(x) < 0; });
    if (resta.length !== l.length) {
      acc.prepare('UPDATE utenti SET reparti = ? WHERE id = ?').run(JSON.stringify(resta), u.id);
      toccati.push(u.id);
    }
  });
  return toccati;
};

/* Dopo un ripristino: gli utenti di reparto tengono solo i reparti che esistono nel magazzino. */
Operazioni.prototype.allineaRepartiUtenti = function (esistenti) {
  var mancanti = {};
  this.database.accessi.prepare('SELECT reparti FROM utenti').all().forEach(function (u) {
    var l = [];
    try { l = JSON.parse(u.reparti); } catch (e) { l = []; }
    l.forEach(function (id) { if (esistenti.indexOf(id) < 0) mancanti[id] = true; });
  });
  return Object.keys(mancanti).length ? this.togliRepartoDagliUtenti(Object.keys(mancanti)) : [];
};

/* ---------- archivio vuoto: dati di prova e importazione dalla versione per un solo PC ---------- */

Operazioni.prototype.archivioVuoto = function () {
  var c = this.database.contaMagazzino();
  return c.articoli === 0 && c.movimenti === 0;
};

Operazioni.prototype.caricaDemo = function (ctx) {
  this.richiedi(ctx, 'impostazioni');
  if (!this.archivioVuoto()) throw errore(409, 'I dati di prova si possono caricare solo in un archivio vuoto.');
  var reparti = this.database.reparti().filter(function (r) { return r.attivo && r.tipo !== 'transito'; });
  var centrale = reparti.filter(function (r) { return r.centrale; })[0] || reparti[0];
  var altri = reparti.filter(function (r) { return r.id !== centrale.id; });
  if (!altri.length) throw errore(400, 'Servono almeno due reparti attivi per i dati di prova.');
  var demo = DemoFarmacia.crea(Calcoli, { centrale: centrale.id, reparti: altri.slice(0, 3).map(function (r) { return r.id; }), oggi: new Date() });
  var self = this;
  var r = this.database.scrivi(function (rev) {
    demo.articoli.forEach(function (a) {
      self.db().prepare('INSERT INTO articoli (id, nome, categoria, unita, principio, prezzo, scorta_minima, attivo, versione, rev) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)')
        .run(a.id, a.nome, a.categoria, a.unita || '', a.principio || '', a.prezzo || 0, a.scortaMinima || 0, rev);
    });
    demo.movimenti.forEach(function (m) {
      self.inserisciMovimento(ctx, rev, Object.assign({}, m, { operatore: 'Dati di prova', utenteId: null }));
    });
  });
  this.accessi.evento(ctx, 'archivio.dati-di-prova', { articoli: demo.articoli.length, movimenti: demo.movimenti.length });
  this.dopoScrittura(r);
  return { rev: r.rev, articoli: demo.articoli.length, movimenti: demo.movimenti.length };
};

Operazioni.prototype.importaArchivio = function (ctx, dati) {
  this.richiedi(ctx, 'impostazioni');
  if (!this.archivioVuoto()) throw errore(409, 'L’archivio della versione per un solo PC si può importare solo in un archivio vuoto.');
  if (!dati || !Array.isArray(dati.articoli) || !Array.isArray(dati.movimenti) || !Array.isArray(dati.reparti)) {
    throw errore(400, 'Il file non è un archivio del Gestionale Farmacia.');
  }
  var self = this;
  var scartati = 0;
  var nomiUsati = {};
  var mappaArticoli = {};
  var repartiIds = {};
  var tolti = [];
  // prima si controlla tutto, poi si scrive: un archivio sbagliato non deve lasciare modifiche a metà
  var reparti = dati.reparti.map(function (rp, i) {
    if (!rp || typeof rp !== 'object') throw errore(400, 'L’archivio contiene un reparto non valido.');
    var id = String(rp.id || '').trim();
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id) || id === ID_TRANSITO) id = nuovoId('r');
    if (repartiIds[id]) throw errore(400, 'L’archivio contiene due reparti con lo stesso codice.');
    repartiIds[id] = true;
    return { id: id, nome: testo(rp.nome, 80, 'nome del reparto') || ('Reparto ' + (i + 1)), centrale: !!rp.centrale, attivo: rp.attivo !== false, ordine: i };
  });
  if (!reparti.length) throw errore(400, 'L’archivio non contiene reparti.');
  var idsUsati = {};
  var articoli = [];
  dati.articoli.forEach(function (a) {
    var v;
    // la versione per un solo PC non ha codici a barre né pezzi per confezione: si ignorano (gli articoli nascono senza)
    try { v = validaArticolo(Object.assign({}, a, { barcode: undefined, pezziConfezione: undefined, attributi: undefined, leadTime: undefined, fornitore: undefined })); } catch (e) { scartati++; return; }
    var base = v.nome;
    var n = 2;
    while (nomiUsati[v.nome.toLowerCase()]) v.nome = base + ' (' + (n++) + ')';
    nomiUsati[v.nome.toLowerCase()] = true;
    var id = String(a.id || '').trim();
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(id) || idsUsati[id]) id = nuovoId('a');
    idsUsati[id] = true;
    mappaArticoli[a.id] = id;
    v.id = id;
    articoli.push(v);
  });
  var imp = null;
  try { imp = validaImpostazioni(Object.assign({}, dati.impostazioni || {}, { logo: (dati.impostazioni || {}).logo || '' })); } catch (e) {
    // logo non valido: si importano le altre impostazioni e si lascia quello attuale
    try { var senzaLogo = Object.assign({}, dati.impostazioni || {}); delete senzaLogo.logo; imp = validaImpostazioni(senzaLogo); } catch (e2) { imp = null; }
  }
  var r = this.database.scrivi(function (rev) {
    // reparti: quelli dell'archivio prendono il posto dei predefiniti
    var vecchi = self.database.reparti();
    reparti.forEach(function (x) {
      self.db().prepare('INSERT INTO reparti (id, nome, centrale, attivo, ordine, rev, tipo) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, centrale = excluded.centrale, attivo = excluded.attivo, ordine = excluded.ordine, rev = excluded.rev, tipo = excluded.tipo')
        .run(x.id, x.nome, x.centrale ? 1 : 0, x.attivo ? 1 : 0, x.ordine, rev, x.centrale ? 'centrale' : 'periferico');
      // un reparto ricreato con un codice già cancellato non deve sparire dai browser
      self.db().prepare('DELETE FROM cancellati WHERE tabella = ? AND id = ?').run('reparti', x.id);
    });
    vecchi.forEach(function (v) {
      // il magazzino "In transito" resta sempre
      if (repartiIds[v.id] || v.tipo === 'transito') return;
      self.db().prepare('DELETE FROM reparti WHERE id = ?').run(v.id);
      self.db().prepare('INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)').run('reparti', v.id, rev);
      tolti.push(v.id);
    });
    articoli.forEach(function (v) {
      var id = v.id;
      self.db().prepare('DELETE FROM cancellati WHERE tabella = ? AND id = ?').run('articoli', id);
      self.db().prepare('INSERT INTO articoli (id, nome, categoria, unita, principio, confezione, codice, prezzo, scorta_minima, note, attivo, versione, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
        .run(id, v.nome, v.categoria, v.unita, v.principio, v.confezione, v.codice, v.prezzo, v.scortaMinima, v.note, v.attivo ? 1 : 0, rev);
    });
    dati.movimenti.forEach(function (m) {
      if (!m || TIPI.indexOf(m.tipo) < 0 || !dataValida(m.data) || !mappaArticoli[m.articoloId] || !repartiIds[m.repartoId] ||
        (m.tipo === 'trasferimento' && !repartiIds[m.repartoDestId]) || !isFinite(Number(m.quantita))) { scartati++; return; }
      var id = self.inserisciMovimento(ctx, rev, {
        tipo: m.tipo, data: m.data, articoloId: mappaArticoli[m.articoloId], repartoId: m.repartoId,
        repartoDestId: m.tipo === 'trasferimento' ? m.repartoDestId : null, quantita: Number(m.quantita),
        lotto: String(m.lotto || '').slice(0, 60), scadenza: /^\d{4}-\d{2}$/.test(m.scadenza || '') ? m.scadenza : '',
        fornitore: String(m.fornitore || '').slice(0, 200), documento: String(m.documento || '').slice(0, 100),
        causale: String(m.causale || '').slice(0, 100), note: String(m.note || '').slice(0, 500),
        prezzo: isFinite(Number(m.prezzo)) && m.prezzo !== null && m.prezzo !== undefined ? Number(m.prezzo) : null,
        operatore: String(m.operatore || '').slice(0, 100), utenteId: null, creato: Number(m.creato) || Date.now()
      });
      if (m.annullato) {
        self.db().prepare('UPDATE movimenti SET annullato_il = ?, annullato_da = ?, annullato_motivo = ? WHERE id = ?')
          .run(String(m.annullato.il || new Date().toISOString()), String(m.annullato.da || ''), String(m.annullato.motivo || ''), id);
      }
    });
    if (imp) {
      var st = self.db().prepare('INSERT INTO impostazioni (chiave, valore, rev) VALUES (?, ?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore, rev = excluded.rev');
      Object.keys(imp).forEach(function (k) {
        if (k === 'logo' && !imp.logo) return; // senza logo nell'archivio resta quello attuale
        st.run(k, JSON.stringify(imp[k]), rev);
      });
    }
  });
  // gli utenti di reparto si aggiornano solo a importazione riuscita (accessi.db è fuori dalla transazione)
  if (tolti.length) this.togliRepartoDagliUtenti(tolti);
  var conta = this.database.contaMagazzino();
  this.accessi.evento(ctx, 'archivio.importa-versione-singola', { articoli: conta.articoli, movimenti: conta.movimenti, scartati: scartati });
  this.dopoScrittura(r);
  return { rev: r.rev, articoli: conta.articoli, movimenti: conta.movimenti, scartati: scartati };
};

module.exports = {
  Operazioni: Operazioni, dataValida: dataValida,
  // usate anche da server/logistica.js (richieste e DDT)
  testo: testo, numero: numero, oggiLocale: oggiLocale, ID_TRANSITO: ID_TRANSITO, NOME_TRANSITO: NOME_TRANSITO
};
