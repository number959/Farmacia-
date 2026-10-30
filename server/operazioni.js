/*
 * Operazioni sul magazzino, con controllo dei permessi e registro attività.
 * Ogni operazione che scrive è una transazione con una nuova revisione (Database.scrivi).
 */
'use strict';

var Calcoli = require('../js/calcoli.js');
var DemoFarmacia = require('../js/demo.js');
var A = require('./accessi.js');
var errore = A.errore;
var nuovoId = A.nuovoId;

var TIPI = ['carico', 'consumo', 'trasferimento', 'perdita', 'rettifica'];
var USCITE = ['consumo', 'perdita', 'trasferimento'];
var PERMESSO_TIPO = { carico: 'carico', consumo: 'consumo', trasferimento: 'trasferimento', perdita: 'perdita', rettifica: 'rettifica' };
var CATEGORIE = ['FARMACI', 'PRESIDI'];

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
    if (dest.id === reparto.id) throw errore(400, 'Il reparto di partenza e quello di arrivo sono uguali.');
    out.repartoDestId = dest.id;
  }
  if (m.tipo === 'carico' && m.prezzo !== undefined && m.prezzo !== null && m.prezzo !== '') {
    out.prezzo = numero(m.prezzo, 'prezzo', { min: 0 });
  }
  out.articolo = articolo;
  return out;
};

Operazioni.prototype.inserisciMovimento = function (ctx, rev, m) {
  var id = nuovoId('m');
  // millisecondi sempre crescenti: a parità di data i movimenti restano nell'ordine di registrazione
  var creato = m.creato || Math.max(Date.now(), this.ultimoCreato + 1);
  if (!m.creato) this.ultimoCreato = creato;
  this.db().prepare(
    'INSERT INTO movimenti (id, tipo, data, articolo_id, reparto_id, reparto_dest_id, quantita, lotto, scadenza, fornitore, documento, causale, note, prezzo, operatore, utente_id, creato, rev) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, m.tipo, m.data, m.articoloId, m.repartoId, m.repartoDestId || null, m.quantita, m.lotto || '', m.scadenza || '',
    m.fornitore || '', m.documento || '', m.causale || '', m.note || '', m.prezzo === null || m.prezzo === undefined ? null : m.prezzo,
    m.operatore !== undefined ? m.operatore : (ctx.utente ? ctx.utente.nome : ''), m.utenteId !== undefined ? m.utenteId : (ctx.utente ? ctx.utente.id : null),
    creato, rev);
  return id;
};

/* Ripartisce un'uscita sui lotti (FEFO) guardando i movimenti già nel database, anche quelli di questa transazione. */
Operazioni.prototype.ripartisci = function (m) {
  var stato = { articoli: [], movimenti: this.database.movimentiArticolo(m.articoloId) };
  return Calcoli.allocaUscita(stato, m.articoloId, m.repartoId, m.data, m.quantita, m.lotto);
};

Operazioni.prototype.registraMovimenti = function (ctx, lista) {
  if (!Array.isArray(lista) || !lista.length) throw errore(400, 'Nessun movimento da registrare.');
  if (lista.length > 2000) throw errore(400, 'Troppi movimenti in una volta sola.');
  var self = this;
  var normalizzati = lista.map(function (m) { return self.normalizzaMovimento(ctx, m); });
  var r = this.database.scrivi(function (rev) {
    var creati = [];
    normalizzati.forEach(function (m) {
      if (USCITE.indexOf(m.tipo) >= 0) {
        self.ripartisci(m).forEach(function (p) {
          creati.push(self.inserisciMovimento(ctx, rev, Object.assign({}, m, { quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza })));
        });
      } else {
        creati.push(self.inserisciMovimento(ctx, rev, m));
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
  var self = this;
  var precedenti = 0;
  var r = this.database.scrivi(function (rev) {
    var esistenti = self.db().prepare("SELECT id, quantita FROM movimenti WHERE tipo = 'consumo' AND articolo_id = ? AND reparto_id = ? AND data = ? AND annullato_il IS NULL")
      .all(m.articoloId, m.repartoId, m.data);
    esistenti.forEach(function (e) { precedenti += e.quantita; });
    var adesso = new Date().toISOString();
    esistenti.forEach(function (e) {
      self.db().prepare('UPDATE movimenti SET annullato_il = ?, annullato_da = ?, annullato_motivo = ?, rev = ? WHERE id = ?')
        .run(adesso, ctx.utente.nome, 'Corretto dal registro mensile', rev, e.id);
    });
    if (quantita > 0) {
      var nuovo = Object.assign({}, m, { quantita: quantita, note: 'Dal registro mensile' });
      self.ripartisci(nuovo).forEach(function (p) {
        self.inserisciMovimento(ctx, rev, Object.assign({}, nuovo, { quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza }));
      });
    }
  });
  this.accessi.evento(ctx, 'registro.consumo-giorno', { articolo: m.articolo.nome, reparto: m.repartoId, data: m.data, prima: precedenti, dopo: quantita });
  this.dopoScrittura(r);
  return { rev: r.rev };
};

/* ---------- articoli ---------- */

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
    note: testo(dati.note, 1000, 'note'), attivo: dati.attivo !== false
  };
}

Operazioni.prototype.creaArticolo = function (ctx, dati) {
  this.richiedi(ctx, 'articoli');
  var a = validaArticolo(dati);
  if (this.database.articoloPerNome(a.nome)) throw errore(409, 'Esiste già un articolo con questo nome.');
  var self = this;
  var id = nuovoId('a');
  var r = this.database.scrivi(function (rev) {
    self.db().prepare('INSERT INTO articoli (id, nome, categoria, unita, principio, confezione, codice, prezzo, scorta_minima, note, attivo, versione, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, a.nome, a.categoria, a.unita, a.principio, a.confezione, a.codice, a.prezzo, a.scortaMinima, a.note, a.attivo ? 1 : 0, rev);
  });
  this.accessi.evento(ctx, 'articoli.crea', { articolo: a.nome, categoria: a.categoria });
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
  var self = this;
  var r = this.database.scrivi(function (rev) {
    self.db().prepare('UPDATE articoli SET nome = ?, categoria = ?, unita = ?, principio = ?, confezione = ?, codice = ?, prezzo = ?, scorta_minima = ?, note = ?, attivo = ?, versione = versione + 1, rev = ? WHERE id = ?')
      .run(a.nome, a.categoria, a.unita, a.principio, a.confezione, a.codice, a.prezzo, a.scortaMinima, a.note, a.attivo ? 1 : 0, rev, prima.id);
  });
  var cambi = {};
  Object.keys(a).forEach(function (k) { if (a[k] !== prima[k]) cambi[k] = { prima: prima[k], dopo: a[k] }; });
  this.accessi.evento(ctx, 'articoli.modifica', { articolo: prima.nome, cambi: cambi });
  this.dopoScrittura(r);
  return { rev: r.rev, articolo: this.database.articolo(prima.id) };
};

Operazioni.prototype.eliminaArticolo = function (ctx, id) {
  this.richiedi(ctx, 'articoli');
  var a = this.database.articolo(String(id));
  if (!a) throw errore(404, 'Articolo non trovato.');
  if (this.db().prepare('SELECT 1 FROM movimenti WHERE articolo_id = ? LIMIT 1').get(a.id)) {
    throw errore(409, 'L’articolo ha dei movimenti: non si può eliminare. Togli la spunta “Articolo attivo” per nasconderlo.');
  }
  var self = this;
  var r = this.database.scrivi(function (rev) {
    self.db().prepare('DELETE FROM articoli WHERE id = ?').run(a.id);
    self.db().prepare('INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)').run('articoli', a.id, rev);
  });
  this.accessi.evento(ctx, 'articoli.elimina', { articolo: a.nome });
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
    var a = validaArticolo({ nome: x.nome, categoria: x.categoria, prezzo: x.prezzo, scortaMinima: x.scortaMinima, unita: x.unita });
    a.giacenza = numero(x.giacenza, 'giacenza', { facoltativo: true });
    return a;
  });
  var self = this;
  var nuovi = 0;
  var carichi = 0;
  var r = this.database.scrivi(function (rev) {
    validi.forEach(function (a) {
      var esiste = self.database.articoloPerNome(a.nome);
      var id = esiste ? esiste.id : nuovoId('a');
      if (!esiste) {
        self.db().prepare('INSERT INTO articoli (id, nome, categoria, unita, prezzo, scorta_minima, attivo, versione, rev) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)')
          .run(id, a.nome, a.categoria, a.unita, a.prezzo, a.scortaMinima, rev);
        nuovi++;
      }
      if (conGiacenza && a.giacenza > 0) {
        self.inserisciMovimento(ctx, rev, { tipo: 'carico', data: dati.data, articoloId: id, repartoId: reparto.id, quantita: a.giacenza, note: 'Giacenza iniziale importata' + (origine ? ' da ' + origine : '') });
        carichi++;
      }
    });
  });
  this.accessi.evento(ctx, 'articoli.importa', { origine: origine, righe: validi.length, nuovi: nuovi, carichi: carichi, reparto: reparto ? reparto.id : undefined });
  this.dopoScrittura(r);
  return { rev: r.rev, nuovi: nuovi, carichi: carichi };
};

/* ---------- impostazioni e reparti ---------- */

Operazioni.prototype.salvaImpostazioni = function (ctx, dati) {
  this.richiedi(ctx, 'impostazioni');
  dati = dati || {};
  var prima = this.database.impostazioni();
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
    var logo = String(dati.logo || '');
    if (logo && !/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw errore(400, 'Il logo deve essere un’immagine PNG, JPEG, GIF, WebP o SVG.');
    if (logo.length > 600000) throw errore(400, 'Il logo è troppo grande: usa un’immagine sotto i 400 KB.');
    nuove.logo = logo;
  }
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
  var nomi = {};
  var centraleVisto = false;
  var norm = lista.map(function (r, i) {
    var nome = testo(r && r.nome, 80, 'nome del reparto');
    if (!nome) throw errore(400, 'Ogni reparto deve avere un nome.');
    var k = nome.toLowerCase();
    if (nomi[k]) throw errore(400, 'Due reparti hanno lo stesso nome: ' + nome + '.');
    nomi[k] = true;
    var id = r.id ? String(r.id) : null;
    if (id && !esistenti[id]) throw errore(400, 'Reparto non trovato: aggiorna la pagina.');
    var centrale = !!r.centrale && !centraleVisto;
    if (centrale) centraleVisto = true;
    return { id: id || nuovoId('r'), nome: nome, centrale: centrale, attivo: r.attivo !== false, ordine: i, nuovo: !id };
  });
  if (!norm.some(function (r) { return r.attivo; })) throw errore(400, 'Deve restare almeno un reparto attivo.');
  var self = this;
  var r = this.database.scrivi(function (rev) {
    norm.forEach(function (x) {
      if (x.nuovo) {
        self.db().prepare('INSERT INTO reparti (id, nome, centrale, attivo, ordine, rev) VALUES (?, ?, ?, ?, ?, ?)').run(x.id, x.nome, x.centrale ? 1 : 0, x.attivo ? 1 : 0, x.ordine, rev);
      } else {
        self.db().prepare('UPDATE reparti SET nome = ?, centrale = ?, attivo = ?, ordine = ?, rev = ? WHERE id = ?').run(x.nome, x.centrale ? 1 : 0, x.attivo ? 1 : 0, x.ordine, rev, x.id);
      }
    });
  });
  this.accessi.evento(ctx, 'reparti.modifica', { reparti: norm.map(function (x) { return { id: x.id, nome: x.nome, centrale: x.centrale, attivo: x.attivo, nuovo: x.nuovo }; }) });
  this.dopoScrittura(r);
  return { rev: r.rev, reparti: this.database.reparti() };
};

Operazioni.prototype.eliminaReparto = function (ctx, id) {
  this.richiedi(ctx, 'impostazioni');
  var rep = this.database.reparto(String(id));
  if (!rep) throw errore(404, 'Reparto non trovato.');
  if (this.db().prepare('SELECT 1 FROM movimenti WHERE reparto_id = ? OR reparto_dest_id = ? LIMIT 1').get(rep.id, rep.id)) {
    throw errore(409, 'Il reparto ha dei movimenti: non si può eliminare. Togli la spunta “Attivo” per nasconderlo.');
  }
  if (this.database.reparti().length <= 1) throw errore(400, 'Deve restare almeno un reparto.');
  var self = this;
  var r = this.database.scrivi(function (rev) {
    self.db().prepare('DELETE FROM reparti WHERE id = ?').run(rep.id);
    self.db().prepare('INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)').run('reparti', rep.id, rev);
  });
  this.togliRepartoDagliUtenti(rep.id);
  this.accessi.evento(ctx, 'reparti.elimina', { reparto: rep.nome });
  this.dopoScrittura(r);
  return { rev: r.rev };
};

Operazioni.prototype.togliRepartoDagliUtenti = function (repartoId) {
  var acc = this.database.accessi;
  acc.prepare('SELECT id, reparti FROM utenti').all().forEach(function (u) {
    var l = [];
    try { l = JSON.parse(u.reparti); } catch (e) { l = []; }
    if (l.indexOf(repartoId) >= 0) acc.prepare('UPDATE utenti SET reparti = ? WHERE id = ?').run(JSON.stringify(l.filter(function (x) { return x !== repartoId; })), u.id);
  });
};

/* ---------- archivio vuoto: dati di prova e importazione dalla versione per un solo PC ---------- */

Operazioni.prototype.archivioVuoto = function () {
  var c = this.database.contaMagazzino();
  return c.articoli === 0 && c.movimenti === 0;
};

Operazioni.prototype.caricaDemo = function (ctx) {
  this.richiedi(ctx, 'impostazioni');
  if (!this.archivioVuoto()) throw errore(409, 'I dati di prova si possono caricare solo in un archivio vuoto.');
  var reparti = this.database.reparti().filter(function (r) { return r.attivo; });
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
  var r = this.database.scrivi(function (rev) {
    // reparti: quelli dell'archivio prendono il posto dei predefiniti
    var vecchi = self.database.reparti();
    dati.reparti.forEach(function (rp, i) {
      var id = testo(rp.id, 80, 'id reparto') || nuovoId('r');
      var nome = testo(rp.nome, 80, 'nome del reparto') || ('Reparto ' + (i + 1));
      repartiIds[id] = true;
      self.db().prepare('INSERT INTO reparti (id, nome, centrale, attivo, ordine, rev) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, centrale = excluded.centrale, attivo = excluded.attivo, ordine = excluded.ordine, rev = excluded.rev')
        .run(id, nome, rp.centrale ? 1 : 0, rp.attivo === false ? 0 : 1, i, rev);
    });
    if (!Object.keys(repartiIds).length) throw errore(400, 'L’archivio non contiene reparti.');
    vecchi.forEach(function (v) {
      if (repartiIds[v.id]) return;
      self.db().prepare('DELETE FROM reparti WHERE id = ?').run(v.id);
      self.db().prepare('INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)').run('reparti', v.id, rev);
      self.togliRepartoDagliUtenti(v.id);
    });
    dati.articoli.forEach(function (a) {
      var v;
      try { v = validaArticolo(a); } catch (e) { scartati++; return; }
      var base = v.nome;
      var n = 2;
      while (nomiUsati[v.nome.toLowerCase()]) v.nome = base + ' (' + (n++) + ')';
      nomiUsati[v.nome.toLowerCase()] = true;
      var id = testo(a.id, 80, 'id articolo') || nuovoId('a');
      mappaArticoli[a.id] = id;
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
    var imp = dati.impostazioni || {};
    var st = self.db().prepare('INSERT INTO impostazioni (chiave, valore, rev) VALUES (?, ?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore, rev = excluded.rev');
    ['struttura', 'sottotitolo', 'societa', 'citta', 'giorniAvvisoScadenza', 'codiceModulo'].forEach(function (k) {
      if (imp[k] !== undefined && imp[k] !== null && String(imp[k]).length <= 200) st.run(k, JSON.stringify(imp[k]), rev);
    });
    if (typeof imp.logo === 'string' && imp.logo.length < 600000 && /^data:image\//.test(imp.logo)) st.run('logo', JSON.stringify(imp.logo), rev);
  });
  var conta = this.database.contaMagazzino();
  this.accessi.evento(ctx, 'archivio.importa-versione-singola', { articoli: conta.articoli, movimenti: conta.movimenti, scartati: scartati });
  this.dopoScrittura(r);
  return { rev: r.rev, articoli: conta.articoli, movimenti: conta.movimenti, scartati: scartati };
};

module.exports = { Operazioni: Operazioni, dataValida: dataValida };
