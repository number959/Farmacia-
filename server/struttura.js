/*
 * Versione 3.0 – parte B: magazzini (farmacia centrale e periferici, per piano), armadi, assortimento e ubicazioni.
 * Contratto: docs/NOVITA-3.0.md. Le rotte si registrano in rotte(server), chiamata da server/http.js.
 *
 *   POST   /api/magazzini        { nome, tipo: 'centrale'|'periferico', piano, livello, colore, descrizione, attivo, ordine }
 *   PUT    /api/magazzini/:id    stessi campi (quelli che mancano restano come sono)       → { rev, magazzino }
 *   DELETE /api/magazzini/:id    solo se mai usato (movimenti, richieste, DDT)             → { rev }
 *   POST   /api/armadi           { repartoId, nome, tipo, ripiani 1–12, colonne 1–20, ordine, colore, note, attivo }
 *   PUT    /api/armadi/:id       stessi campi (quelli che mancano restano come sono)       → { rev, armadio, liberati }
 *   DELETE /api/armadi/:id       le caselle tornano libere                                 → { rev, liberati }
 *   PUT    /api/assortimento     { repartoId, righe: [{ articoloId, scortaMin, puntoRiordino, scortaMax, note, attivo }] }
 *                                → { rev, nuove, modificate, tolte }
 *   PUT    /api/ubicazioni       { repartoId, righe: [{ articoloId, armadioId|null, ripiano, posizione }] }
 *                                → { rev, spostate, aggiunte }
 *
 * Caselle degli armadi: ripiano 1 = il ripiano più in alto, posizione 1 = la prima a sinistra. Una casella = un articolo.
 * Un articolo tolto dall'assortimento (attivo: false) resta nella tabella (soglie conservate) ma lascia libera la sua casella.
 */
'use strict';

var A = require('./accessi.js');
var D = require('./db.js');

var errore = A.errore;
var nuovoId = A.nuovoId;
var ID_TRANSITO = D.ID_TRANSITO;

var TIPI_MAGAZZINO = ['centrale', 'periferico'];
var TIPI_ARMADIO = ['armadio', 'frigorifero', 'cassettiera', 'carrello', 'cassaforte'];
var MAX_RIGHE = 3000;          // righe per richiesta di assortimento o ubicazioni
var MAX_DETTAGLI_EVENTO = 20;  // righe descritte nel registro attività

/* ---------- validazione ---------- */

function testo(v, max, campo) {
  var t = v === undefined || v === null ? '' : String(v).trim();
  if (t.length > max) throw errore(400, 'Il campo ' + campo + ' è troppo lungo (massimo ' + max + ' caratteri).');
  return t;
}

function numero(v, campo) {
  if (v === undefined || v === null || v === '') return 0;
  var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  if (!isFinite(n)) throw errore(400, 'Il campo ' + campo + ' non è un numero.');
  if (n < 0) throw errore(400, 'Il campo ' + campo + ' non può essere negativo.');
  if (n > 1e9) throw errore(400, 'Il campo ' + campo + ' è troppo grande.');
  return Math.round(n * 1000) / 1000;
}

function intero(v, campo, min, max, predefinito) {
  if (v === undefined || v === null || v === '') {
    if (predefinito !== undefined) return predefinito;
    throw errore(400, 'Manca il campo ' + campo + '.');
  }
  var n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!isFinite(n) || Math.floor(n) !== n) throw errore(400, 'Il campo ' + campo + ' deve essere un numero intero.');
  if (n < min || n > max) throw errore(400, 'Il campo ' + campo + ' va da ' + min + ' a ' + max + '.');
  return n;
}

function colore(v) {
  var c = String(v === undefined || v === null ? '' : v).trim();
  if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) throw errore(400, 'Il colore deve essere nella forma #RRGGBB.');
  return c.toLowerCase();
}

function siNo(v, predefinito) {
  if (v === undefined || v === null) return predefinito;
  return v === true || v === 1 || v === '1' || v === 'true';
}

/* Nome del piano quando l'amministratore non lo scrive: dal livello. */
function pianoDaLivello(livello) {
  if (livello === 0) return 'Piano terra';
  if (livello === -1) return 'Seminterrato';
  if (livello < 0) return 'Piano ' + livello;
  return livello + '° piano';
}

/* Prima riga con la soglia più alta sotto una più bassa (min ≤ riordino ≤ max, solo per i valori indicati, cioè > 0). */
function controllaSoglie(nome, min, riordino, max) {
  if (min > 0 && riordino > 0 && min > riordino) {
    throw errore(400, nome + ': la scorta minima (' + min + ') non può superare il punto di riordino (' + riordino + ').');
  }
  if (riordino > 0 && max > 0 && riordino > max) {
    throw errore(400, nome + ': il punto di riordino (' + riordino + ') non può superare la scorta massima (' + max + ').');
  }
  if (min > 0 && max > 0 && min > max) {
    throw errore(400, nome + ': la scorta minima (' + min + ') non può superare la scorta massima (' + max + ').');
  }
}

/* ---------- operazioni ---------- */

function Struttura(server) {
  this.server = server;
  this.database = server.database;
  this.accessi = server.accessi;
}

// la connessione può cambiare dopo il ripristino di una copia: si chiede ogni volta
Struttura.prototype.db = function () { return this.database.dati; };

Struttura.prototype.richiedi = function (ctx, permesso) {
  if (!ctx.permessi || !ctx.permessi[permesso]) throw errore(403, 'Il tuo utente non può fare questa operazione.');
};

Struttura.prototype.fine = function (ctx, azione, dettagli, r) {
  this.accessi.evento(ctx, azione, dettagli);
  this.server.notifica(r.rev);
};

/* Magazzino vero (non "In transito") esistente, altrimenti errore. */
Struttura.prototype.magazzino = function (id, perScrivere) {
  var rep = this.database.reparto(String(id || ''));
  if (!rep) throw errore(perScrivere ? 400 : 404, perScrivere ? 'Magazzino non trovato: aggiorna la pagina.' : 'Magazzino non trovato.');
  if (rep.id === ID_TRANSITO || rep.tipo === 'transito') {
    throw errore(400, 'Il magazzino «In transito» è di sistema: non si modifica, non si elimina e non ha armadi né assortimento.');
  }
  return rep;
};

Struttura.prototype.armadio = function (id) {
  var r = this.db().prepare('SELECT * FROM armadi WHERE id = ?').get(String(id || ''));
  return r ? D.armadioDaRiga(r) : null;
};

Struttura.prototype.nomeArmadio = function (id) {
  var a = this.armadio(id);
  return a ? a.nome : '';
};

/* ======================= magazzini ======================= */

Struttura.prototype.validaMagazzino = function (dati, prima) {
  dati = dati && typeof dati === 'object' ? dati : {};
  var base = prima || { nome: '', tipo: 'periferico', piano: '', livello: 0, colore: '', descrizione: '', attivo: true, ordine: null };
  function dato(k) { return dati[k] === undefined ? base[k] : dati[k]; }
  var v = {};
  v.nome = testo(dato('nome'), 80, 'nome');
  if (!v.nome) throw errore(400, 'Scrivi il nome del magazzino.');
  v.tipo = String(dato('tipo') || 'periferico');
  if (TIPI_MAGAZZINO.indexOf(v.tipo) < 0) throw errore(400, 'Il tipo del magazzino deve essere «centrale» (farmacia centrale) o «periferico».');
  v.livello = intero(dato('livello'), 'livello', -5, 60, 0);
  v.piano = testo(dato('piano'), 40, 'piano') || pianoDaLivello(v.livello);
  v.colore = colore(dato('colore'));
  v.descrizione = testo(dato('descrizione'), 300, 'descrizione');
  v.attivo = siNo(dato('attivo'), true);
  v.ordine = dati.ordine === undefined || dati.ordine === null || dati.ordine === '' ? base.ordine : intero(dati.ordine, 'ordine', 0, 9998);
  if (v.tipo === 'centrale' && !v.attivo) {
    throw errore(400, 'La farmacia centrale non si può disattivare: prima scegli un altro magazzino come farmacia centrale.');
  }
  return v;
};

Struttura.prototype.controllaNomeMagazzino = function (nome, tranneId) {
  var r = this.db().prepare('SELECT id FROM reparti WHERE nome = ? COLLATE NOCASE AND id <> ?').get(nome, String(tranneId || ''));
  if (r) throw errore(409, 'Esiste già un magazzino che si chiama «' + nome + '».');
};

/* Un solo magazzino centrale: quello vecchio diventa periferico. */
Struttura.prototype.declassaCentrale = function (rev, tranneId) {
  this.db().prepare("UPDATE reparti SET tipo = 'periferico', centrale = 0, rev = ? WHERE (tipo = 'centrale' OR centrale = 1) AND id <> ? AND id <> ?")
    .run(rev, String(tranneId || ''), ID_TRANSITO);
};

Struttura.prototype.creaMagazzino = function (ctx, dati) {
  this.richiedi(ctx, 'struttura');
  var v = this.validaMagazzino(dati, null);
  this.controllaNomeMagazzino(v.nome, null);
  if (v.ordine === null || v.ordine === undefined) {
    var max = this.db().prepare('SELECT MAX(ordine) m FROM reparti WHERE id <> ?').get(ID_TRANSITO).m;
    v.ordine = Math.min(9998, (max === null || max === undefined ? -1 : max) + 1);
  }
  var prima = this.centrale();
  var id = nuovoId('r');
  var self = this;
  var r = this.database.scrivi(function (rev) {
    if (v.tipo === 'centrale') self.declassaCentrale(rev, id);
    self.db().prepare('INSERT INTO reparti (id, nome, centrale, attivo, ordine, rev, tipo, piano, livello, colore, descrizione) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, v.nome, v.tipo === 'centrale' ? 1 : 0, v.attivo ? 1 : 0, v.ordine, rev, v.tipo, v.piano, v.livello, v.colore, v.descrizione);
    // un magazzino ricreato con un codice già cancellato non deve sparire dai browser
    self.db().prepare('DELETE FROM cancellati WHERE tabella = ? AND id = ?').run('reparti', id);
  });
  var det = { magazzino: v.nome, tipo: v.tipo, piano: v.piano, livello: v.livello, attivo: v.attivo };
  if (v.tipo === 'centrale' && prima) det.exCentrale = prima.nome;
  this.fine(ctx, 'magazzini.crea', det, r);
  return { rev: r.rev, magazzino: this.database.reparto(id) };
};

Struttura.prototype.centrale = function () {
  var r = this.db().prepare("SELECT * FROM reparti WHERE (tipo = 'centrale' OR centrale = 1) AND id <> ? ORDER BY ordine LIMIT 1").get(ID_TRANSITO);
  return r ? D.repartoDaRiga(r) : null;
};

Struttura.prototype.modificaMagazzino = function (ctx, id, dati) {
  this.richiedi(ctx, 'struttura');
  var prima = this.magazzino(id);
  var v = this.validaMagazzino(dati, prima);
  this.controllaNomeMagazzino(v.nome, prima.id);
  var eraCentrale = prima.tipo === 'centrale' || prima.centrale;
  if (eraCentrale && v.tipo !== 'centrale') {
    throw errore(400, 'Ci vuole sempre una farmacia centrale: per cambiarla, apri il magazzino che deve diventarlo e scegli «Farmacia centrale».');
  }
  var exCentrale = v.tipo === 'centrale' && !eraCentrale ? this.centrale() : null;
  var self = this;
  var r = this.database.scrivi(function (rev) {
    if (v.tipo === 'centrale' && !eraCentrale) self.declassaCentrale(rev, prima.id);
    self.db().prepare('UPDATE reparti SET nome = ?, centrale = ?, attivo = ?, ordine = ?, tipo = ?, piano = ?, livello = ?, colore = ?, descrizione = ?, rev = ? WHERE id = ?')
      .run(v.nome, v.tipo === 'centrale' ? 1 : 0, v.attivo ? 1 : 0, v.ordine, v.tipo, v.piano, v.livello, v.colore, v.descrizione, rev, prima.id);
  });
  var cambi = {};
  ['nome', 'tipo', 'piano', 'livello', 'colore', 'descrizione', 'attivo', 'ordine'].forEach(function (k) {
    if (prima[k] !== v[k]) cambi[k] = { prima: prima[k], dopo: v[k] };
  });
  var det = { magazzino: v.nome, cambi: cambi };
  if (exCentrale) det.exCentrale = exCentrale.nome;
  this.fine(ctx, 'magazzini.modifica', det, r);
  return { rev: r.rev, magazzino: this.database.reparto(prima.id) };
};

Struttura.prototype.eliminaMagazzino = function (ctx, id) {
  this.richiedi(ctx, 'struttura');
  var rep = this.magazzino(id);
  if (rep.tipo === 'centrale' || rep.centrale) {
    throw errore(400, 'La farmacia centrale non si elimina: prima scegli un altro magazzino come farmacia centrale.');
  }
  var db = this.db();
  var usato = db.prepare('SELECT 1 FROM movimenti WHERE reparto_id = ? OR reparto_dest_id = ? LIMIT 1').get(rep.id, rep.id) ||
    db.prepare('SELECT 1 FROM richieste WHERE reparto_id = ? OR fornitore_id = ? LIMIT 1').get(rep.id, rep.id) ||
    db.prepare('SELECT 1 FROM ddt WHERE origine_id = ? OR destinazione_id = ? LIMIT 1').get(rep.id, rep.id);
  if (usato) {
    throw errore(409, 'Il magazzino «' + rep.nome + '» è già stato usato (movimenti, richieste o DDT): non si può eliminare. Togli la spunta «Attivo» per nasconderlo.');
  }
  var armadi = db.prepare('SELECT id FROM armadi WHERE reparto_id = ?').all(rep.id).map(function (x) { return x.id; });
  var righe = db.prepare('SELECT id FROM assortimento WHERE reparto_id = ?').all(rep.id).map(function (x) { return x.id; });
  var self = this;
  var r = this.database.scrivi(function (rev) {
    var canc = self.db().prepare('INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)');
    // per sicurezza: nessuna riga di un altro magazzino resta legata a questi armadi
    armadi.forEach(function (a) {
      self.db().prepare('UPDATE assortimento SET armadio_id = NULL, ripiano = NULL, posizione = NULL, rev = ? WHERE armadio_id = ? AND reparto_id <> ?').run(rev, a, rep.id);
    });
    self.db().prepare('DELETE FROM assortimento WHERE reparto_id = ?').run(rep.id);
    righe.forEach(function (x) { canc.run('assortimento', x, rev); });
    self.db().prepare('DELETE FROM armadi WHERE reparto_id = ?').run(rep.id);
    armadi.forEach(function (x) { canc.run('armadi', x, rev); });
    self.db().prepare('DELETE FROM reparti WHERE id = ?').run(rep.id);
    canc.run('reparti', rep.id, rev);
  });
  // gli utenti di magazzino legati a questo magazzino lo perdono (accessi.db è fuori dalla transazione)
  var toccati = [];
  if (this.server.operazioni && this.server.operazioni.togliRepartoDagliUtenti) {
    toccati = this.server.operazioni.togliRepartoDagliUtenti([rep.id]);
    if (this.server.notificaPermessi) this.server.notificaPermessi(toccati);
  }
  this.fine(ctx, 'magazzini.elimina', { magazzino: rep.nome, armadi: armadi.length, assortimento: righe.length, utentiAggiornati: toccati.length }, r);
  return { rev: r.rev };
};

/* ======================= armadi ======================= */

Struttura.prototype.validaArmadio = function (dati, prima) {
  dati = dati && typeof dati === 'object' ? dati : {};
  var base = prima || { repartoId: '', nome: '', tipo: 'armadio', ripiani: 4, colonne: 6, ordine: null, colore: '', note: '', attivo: true };
  function dato(k) { return dati[k] === undefined ? base[k] : dati[k]; }
  var v = {};
  if (!dato('repartoId')) throw errore(400, 'Scegli il magazzino dell’armadio.');
  v.repartoId = this.magazzino(dato('repartoId'), true).id;
  v.nome = testo(dato('nome'), 60, 'nome');
  if (!v.nome) throw errore(400, 'Scrivi il nome dell’armadio.');
  v.tipo = String(dato('tipo') || 'armadio');
  if (TIPI_ARMADIO.indexOf(v.tipo) < 0) throw errore(400, 'Tipo di armadio non valido: armadio, frigorifero, cassettiera, carrello o cassaforte.');
  v.ripiani = intero(dato('ripiani'), 'ripiani', 1, 12, 4);
  v.colonne = intero(dato('colonne'), 'posti per ripiano', 1, 20, 6);
  v.ordine = dati.ordine === undefined || dati.ordine === null || dati.ordine === '' ? base.ordine : intero(dati.ordine, 'ordine', 0, 9999);
  v.colore = colore(dato('colore'));
  v.note = testo(dato('note'), 300, 'note');
  v.attivo = siNo(dato('attivo'), true);
  return v;
};

Struttura.prototype.controllaNomeArmadio = function (repartoId, nome, tranneId) {
  var r = this.db().prepare('SELECT id FROM armadi WHERE reparto_id = ? AND nome = ? COLLATE NOCASE AND id <> ?').get(repartoId, nome, String(tranneId || ''));
  if (r) throw errore(409, 'In questo magazzino c’è già un armadio che si chiama «' + nome + '».');
};

Struttura.prototype.creaArmadio = function (ctx, dati) {
  this.richiedi(ctx, 'struttura');
  var v = this.validaArmadio(dati, null);
  this.controllaNomeArmadio(v.repartoId, v.nome, null);
  if (v.ordine === null || v.ordine === undefined) {
    var max = this.db().prepare('SELECT MAX(ordine) m FROM armadi WHERE reparto_id = ?').get(v.repartoId).m;
    v.ordine = Math.min(9999, (max === null || max === undefined ? -1 : max) + 1);
  }
  var id = nuovoId('arm');
  var self = this;
  var r = this.database.scrivi(function (rev) {
    self.db().prepare('INSERT INTO armadi (id, reparto_id, nome, tipo, ripiani, colonne, ordine, colore, note, attivo, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, v.repartoId, v.nome, v.tipo, v.ripiani, v.colonne, v.ordine, v.colore, v.note, v.attivo ? 1 : 0, rev);
    self.db().prepare('DELETE FROM cancellati WHERE tabella = ? AND id = ?').run('armadi', id);
  });
  this.fine(ctx, 'armadi.crea', { armadio: v.nome, magazzino: this.database.reparto(v.repartoId).nome, tipo: v.tipo, ripiani: v.ripiani, colonne: v.colonne }, r);
  return { rev: r.rev, armadio: this.armadio(id) };
};

Struttura.prototype.modificaArmadio = function (ctx, id, dati) {
  this.richiedi(ctx, 'struttura');
  var prima = this.armadio(id);
  if (!prima) throw errore(404, 'Armadio non trovato.');
  var v = this.validaArmadio(dati, prima);
  this.controllaNomeArmadio(v.repartoId, v.nome, prima.id);
  var db = this.db();
  var occupate = db.prepare('SELECT COUNT(*) n FROM assortimento WHERE armadio_id = ?').get(prima.id).n;
  if (v.repartoId !== prima.repartoId && occupate) {
    throw errore(409, 'Nell’armadio «' + prima.nome + '» ci sono ' + occupate + ' articoli: svuotalo prima di spostarlo in un altro magazzino.');
  }
  // con meno ripiani o posti le caselle che non ci sono più tornano libere
  var fuori = db.prepare('SELECT id FROM assortimento WHERE armadio_id = ? AND (ripiano > ? OR posizione > ? OR ripiano IS NULL OR posizione IS NULL)')
    .all(prima.id, v.ripiani, v.colonne).map(function (x) { return x.id; });
  var self = this;
  var r = this.database.scrivi(function (rev) {
    self.db().prepare('UPDATE armadi SET reparto_id = ?, nome = ?, tipo = ?, ripiani = ?, colonne = ?, ordine = ?, colore = ?, note = ?, attivo = ?, rev = ? WHERE id = ?')
      .run(v.repartoId, v.nome, v.tipo, v.ripiani, v.colonne, v.ordine, v.colore, v.note, v.attivo ? 1 : 0, rev, prima.id);
    var libera = self.db().prepare('UPDATE assortimento SET armadio_id = NULL, ripiano = NULL, posizione = NULL, rev = ? WHERE id = ?');
    fuori.forEach(function (x) { libera.run(rev, x); });
  });
  var cambi = {};
  ['nome', 'tipo', 'ripiani', 'colonne', 'ordine', 'colore', 'note', 'attivo'].forEach(function (k) {
    if (prima[k] !== v[k]) cambi[k] = { prima: prima[k], dopo: v[k] };
  });
  if (v.repartoId !== prima.repartoId) cambi.magazzino = { prima: this.database.reparto(prima.repartoId).nome, dopo: this.database.reparto(v.repartoId).nome };
  this.fine(ctx, 'armadi.modifica', { armadio: v.nome, cambi: cambi, liberati: fuori.length }, r);
  return { rev: r.rev, armadio: this.armadio(prima.id), liberati: fuori.length };
};

Struttura.prototype.eliminaArmadio = function (ctx, id) {
  this.richiedi(ctx, 'struttura');
  var a = this.armadio(id);
  if (!a) throw errore(404, 'Armadio non trovato.');
  var liberati = this.db().prepare('SELECT COUNT(*) n FROM assortimento WHERE armadio_id = ?').get(a.id).n;
  var self = this;
  var r = this.database.scrivi(function (rev) {
    self.db().prepare('UPDATE assortimento SET armadio_id = NULL, ripiano = NULL, posizione = NULL, rev = ? WHERE armadio_id = ?').run(rev, a.id);
    self.db().prepare('DELETE FROM armadi WHERE id = ?').run(a.id);
    self.db().prepare('INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)').run('armadi', a.id, rev);
  });
  var rep = this.database.reparto(a.repartoId);
  this.fine(ctx, 'armadi.elimina', { armadio: a.nome, magazzino: rep ? rep.nome : a.repartoId, liberati: liberati }, r);
  return { rev: r.rev, liberati: liberati };
};

/* ======================= assortimento e ubicazioni ======================= */

/* Magazzino della richiesta, se l'utente può lavorarci. */
Struttura.prototype.magazzinoScrivibile = function (ctx, repartoId, cosa) {
  if (!repartoId) throw errore(400, 'Scegli il magazzino.');
  var rep = this.magazzino(repartoId, true);
  if (!A.puoScrivereReparto(ctx.permessi, rep.id)) throw errore(403, 'Puoi cambiare ' + cosa + ' solo dei magazzini a cui sei assegnato.');
  return rep;
};

Struttura.prototype.righeRichiesta = function (dati) {
  var righe = dati && Array.isArray(dati.righe) ? dati.righe : null;
  if (!righe || !righe.length) throw errore(400, 'Nessuna riga da salvare.');
  if (righe.length > MAX_RIGHE) throw errore(400, 'Troppe righe in una volta (massimo ' + MAX_RIGHE + ').');
  var viste = {};
  righe.forEach(function (x) {
    if (!x || typeof x !== 'object' || !x.articoloId) throw errore(400, 'Ogni riga deve indicare l’articolo.');
    var k = String(x.articoloId);
    if (viste[k]) throw errore(400, 'Lo stesso articolo compare due volte nella richiesta.');
    viste[k] = true;
  });
  return righe;
};

Struttura.prototype.nomiArticoli = function () {
  var nomi = {};
  this.db().prepare('SELECT id, nome FROM articoli').all().forEach(function (a) { nomi[a.id] = a.nome; });
  return nomi;
};

Struttura.prototype.righeAssortimento = function (repartoId) {
  var mappa = {};
  this.db().prepare('SELECT * FROM assortimento WHERE reparto_id = ?').all(repartoId).forEach(function (r) { mappa[r.articolo_id] = r; });
  return mappa;
};

Struttura.prototype.salvaAssortimento = function (ctx, dati) {
  this.richiedi(ctx, 'assortimento');
  var rep = this.magazzinoScrivibile(ctx, dati && dati.repartoId, 'l’assortimento');
  var righe = this.righeRichiesta(dati);
  var nomi = this.nomiArticoli();
  var esistenti = this.righeAssortimento(rep.id);
  var nuove = [];
  var modifiche = [];
  righe.forEach(function (x) {
    var artId = String(x.articoloId);
    if (!nomi[artId]) throw errore(400, 'Articolo non trovato: aggiorna la pagina.');
    var e = esistenti[artId];
    var nome = nomi[artId];
    var v = {
      articoloId: artId,
      scortaMin: x.scortaMin === undefined ? (e ? e.scorta_min : 0) : numero(x.scortaMin, 'scorta minima di ' + nome),
      puntoRiordino: x.puntoRiordino === undefined ? (e ? e.punto_riordino : 0) : numero(x.puntoRiordino, 'punto di riordino di ' + nome),
      scortaMax: x.scortaMax === undefined ? (e ? e.scorta_max : 0) : numero(x.scortaMax, 'scorta massima di ' + nome),
      note: x.note === undefined ? (e ? e.note : '') : testo(x.note, 300, 'note di ' + nome),
      attivo: siNo(x.attivo, e ? !!e.attivo : true)
    };
    controllaSoglie(nome, v.scortaMin, v.puntoRiordino, v.scortaMax);
    if (!e) {
      // un articolo che si toglie e non c'era: niente da fare
      if (v.attivo) nuove.push(v);
      return;
    }
    if (e.scorta_min !== v.scortaMin || e.punto_riordino !== v.puntoRiordino || e.scorta_max !== v.scortaMax ||
      e.note !== v.note || !!e.attivo !== v.attivo) {
      v.id = e.id;
      v.tolta = !!e.attivo && !v.attivo;
      modifiche.push(v);
    }
  });
  if (!nuove.length && !modifiche.length) return { rev: this.database.rev(), nuove: 0, modificate: 0, tolte: 0 };
  var self = this;
  var r = this.database.scrivi(function (rev) {
    var ins = self.db().prepare('INSERT INTO assortimento (id, reparto_id, articolo_id, scorta_min, punto_riordino, scorta_max, note, attivo, rev) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)');
    nuove.forEach(function (v) {
      var id = nuovoId('as');
      ins.run(id, rep.id, v.articoloId, v.scortaMin, v.puntoRiordino, v.scortaMax, v.note, rev);
    });
    var upd = self.db().prepare('UPDATE assortimento SET scorta_min = ?, punto_riordino = ?, scorta_max = ?, note = ?, attivo = ?, rev = ? WHERE id = ?');
    // tolto dall'assortimento: la casella nell'armadio torna libera
    var libera = self.db().prepare('UPDATE assortimento SET armadio_id = NULL, ripiano = NULL, posizione = NULL WHERE id = ?');
    modifiche.forEach(function (v) {
      upd.run(v.scortaMin, v.puntoRiordino, v.scortaMax, v.note, v.attivo ? 1 : 0, rev, v.id);
      if (!v.attivo) libera.run(v.id);
    });
  });
  var tolte = modifiche.filter(function (v) { return v.tolta; });
  var descrivi = function (v) { return { articolo: nomi[v.articoloId], min: v.scortaMin, riordino: v.puntoRiordino, max: v.scortaMax, attivo: v.attivo }; };
  this.fine(ctx, 'assortimento.modifica', {
    magazzino: rep.nome, nuove: nuove.length, modificate: modifiche.length - tolte.length, tolte: tolte.length,
    righe: nuove.concat(modifiche).slice(0, MAX_DETTAGLI_EVENTO).map(descrivi)
  }, r);
  return { rev: r.rev, nuove: nuove.length, modificate: modifiche.length - tolte.length, tolte: tolte.length };
};

Struttura.prototype.salvaUbicazioni = function (ctx, dati) {
  this.richiedi(ctx, 'ubicazioni');
  var rep = this.magazzinoScrivibile(ctx, dati && dati.repartoId, 'la posizione degli articoli negli armadi');
  var righe = this.righeRichiesta(dati);
  var nomi = this.nomiArticoli();
  var esistenti = this.righeAssortimento(rep.id);
  var armadi = {};
  this.db().prepare('SELECT * FROM armadi WHERE reparto_id = ?').all(rep.id).forEach(function (a) { armadi[a.id] = D.armadioDaRiga(a); });

  // posizione finale di ogni articolo del magazzino dopo le modifiche: una casella = un articolo
  var finale = {};
  Object.keys(esistenti).forEach(function (artId) {
    var e = esistenti[artId];
    if (e.armadio_id && e.attivo) finale[artId] = { armadioId: e.armadio_id, ripiano: e.ripiano, posizione: e.posizione };
  });
  var cambi = righe.map(function (x) {
    var artId = String(x.articoloId);
    if (!nomi[artId]) throw errore(400, 'Articolo non trovato: aggiorna la pagina.');
    var dove = null;
    if (x.armadioId) {
      var arm = armadi[String(x.armadioId)];
      if (!arm) throw errore(400, 'Armadio non trovato in ' + rep.nome + ': aggiorna la pagina.');
      if (!arm.attivo) throw errore(400, 'L’armadio «' + arm.nome + '» non è attivo.');
      dove = {
        armadioId: arm.id,
        ripiano: intero(x.ripiano, 'ripiano', 1, arm.ripiani),
        posizione: intero(x.posizione, 'posto sul ripiano', 1, arm.colonne)
      };
    }
    if (dove) finale[artId] = dove; else delete finale[artId];
    return { articoloId: artId, dove: dove };
  });
  // prima gli articoli che restano dove sono, poi quelli spostati: chi trova la casella occupata è uno spostato
  var spostati = cambi.map(function (c) { return c.articoloId; });
  var ordine = Object.keys(finale).filter(function (k) { return spostati.indexOf(k) < 0; })
    .concat(spostati.filter(function (k) { return finale[k]; }));
  var caselle = {};
  ordine.forEach(function (artId) {
    var f = finale[artId];
    var k = f.armadioId + '|' + f.ripiano + '|' + f.posizione;
    if (caselle[k]) {
      throw errore(409, 'Il posto ' + f.posizione + ' del ripiano ' + f.ripiano + ' di «' + armadi[f.armadioId].nome + '» è già occupato da ' +
        nomi[caselle[k]] + ': ' + nomi[artId] + ' non ci può andare.');
    }
    caselle[k] = artId;
  });

  // solo le righe che cambiano davvero
  var daScrivere = cambi.filter(function (c) {
    var e = esistenti[c.articoloId];
    if (!e) return !!c.dove;
    if (!c.dove) return !!e.armadio_id;
    return !e.attivo || e.armadio_id !== c.dove.armadioId || e.ripiano !== c.dove.ripiano || e.posizione !== c.dove.posizione;
  });
  if (!daScrivere.length) return { rev: this.database.rev(), spostate: 0, aggiunte: 0 };
  var aggiunte = 0;
  var self = this;
  var r = this.database.scrivi(function (rev) {
    var upd = self.db().prepare('UPDATE assortimento SET armadio_id = ?, ripiano = ?, posizione = ?, attivo = CASE WHEN ? THEN 1 ELSE attivo END, rev = ? WHERE id = ?');
    // un articolo che non è nell'assortimento del magazzino ci entra con le scorte a zero
    var ins = self.db().prepare('INSERT INTO assortimento (id, reparto_id, articolo_id, scorta_min, punto_riordino, scorta_max, armadio_id, ripiano, posizione, attivo, rev) VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?, 1, ?)');
    daScrivere.forEach(function (c) {
      var e = esistenti[c.articoloId];
      var d = c.dove || { armadioId: null, ripiano: null, posizione: null };
      if (e) upd.run(d.armadioId, d.ripiano, d.posizione, c.dove ? 1 : 0, rev, e.id);
      else { ins.run(nuovoId('as'), rep.id, c.articoloId, d.armadioId, d.ripiano, d.posizione, rev); aggiunte++; }
    });
  });
  this.fine(ctx, 'ubicazioni.modifica', {
    magazzino: rep.nome, righe: daScrivere.length, aggiunte: aggiunte,
    posti: daScrivere.slice(0, MAX_DETTAGLI_EVENTO).map(function (c) {
      return c.dove
        ? { articolo: nomi[c.articoloId], armadio: armadi[c.dove.armadioId].nome, ripiano: c.dove.ripiano, posto: c.dove.posizione }
        : { articolo: nomi[c.articoloId], armadio: '(tolto dall’armadio)' };
    })
  }, r);
  return { rev: r.rev, spostate: daScrivere.length - aggiunte, aggiunte: aggiunte };
};

/* ======================= rotte ======================= */

module.exports.rotte = function (server) {
  var s = new Struttura(server);
  // il permesso nelle opzioni si controlla prima di leggere il corpo (e di nuovo dopo, in http.js)
  var STRUTTURA = { permesso: 'struttura' };
  server.rotta('POST', '/api/magazzini', STRUTTURA, function (ctx) { return s.creaMagazzino(ctx, ctx.corpo); });
  server.rotta('PUT', '/api/magazzini/:id', STRUTTURA, function (ctx) { return s.modificaMagazzino(ctx, ctx.par.id, ctx.corpo); });
  server.rotta('DELETE', '/api/magazzini/:id', STRUTTURA, function (ctx) { return s.eliminaMagazzino(ctx, ctx.par.id); });
  server.rotta('POST', '/api/armadi', STRUTTURA, function (ctx) { return s.creaArmadio(ctx, ctx.corpo); });
  server.rotta('PUT', '/api/armadi/:id', STRUTTURA, function (ctx) { return s.modificaArmadio(ctx, ctx.par.id, ctx.corpo); });
  server.rotta('DELETE', '/api/armadi/:id', STRUTTURA, function (ctx) { return s.eliminaArmadio(ctx, ctx.par.id); });
  server.rotta('PUT', '/api/assortimento', { permesso: 'assortimento' }, function (ctx) { return s.salvaAssortimento(ctx, ctx.corpo); });
  server.rotta('PUT', '/api/ubicazioni', { permesso: 'ubicazioni' }, function (ctx) { return s.salvaUbicazioni(ctx, ctx.corpo); });
};

module.exports.Struttura = Struttura;
module.exports.TIPI_ARMADIO = TIPI_ARMADIO;
module.exports.TIPI_MAGAZZINO = TIPI_MAGAZZINO;
