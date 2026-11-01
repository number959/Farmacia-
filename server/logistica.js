/*
 * Versione 3.0 – parte A: richieste, DDT interni, consegne e ricezioni.
 * Contratto: docs/NOVITA-3.0.md (sezione "Flusso richiesta → DDT → ricezione").
 *
 * Richiesta:  bozza → inviata → in_lavorazione → evasa | chiusa (con residuo) | rifiutata;  annullata (da bozza o inviata)
 * DDT:        in_preparazione → in_transito → ricevuto | ricevuto_con_differenze;  annullato
 *
 * Alla partenza ogni riga del DDT diventa un trasferimento origine → "In transito" (r-transito); alla ricezione un
 * trasferimento "In transito" → destinazione per la quantità ricevuta; la differenza rientra all'origine oppure è una
 * perdita in viaggio (perdita su r-transito). Tutti i movimenti hanno ddt_id e documento = numero del DDT.
 * Ogni scrittura è una transazione (Database.scrivi), va nel registro attività (richieste.*, ddt.*) e avvisa i browser.
 * Le rotte si registrano in rotte(server), chiamata da server/http.js.
 */
'use strict';

var Calcoli = require('../js/calcoli.js');
var A = require('./accessi.js');
var D = require('./db.js');
var O = require('./operazioni.js');

var errore = A.errore;
var nuovoId = A.nuovoId;
var testo = O.testo;
var numero = O.numero;
var r3 = Calcoli.r3;
var ID_TRANSITO = D.ID_TRANSITO;

var MAX_RIGHE = 300;
var ESITI = ['rientro', 'perdita'];
var NOME_STATO_RICHIESTA = {
  bozza: 'una bozza', inviata: 'inviata', in_lavorazione: 'in lavorazione', evasa: 'evasa', chiusa: 'chiusa',
  rifiutata: 'rifiutata', annullata: 'annullata'
};
var NOME_STATO_DDT = {
  in_preparazione: 'in preparazione', in_transito: 'già partito', ricevuto: 'già ricevuto',
  ricevuto_con_differenze: 'già ricevuto', annullato: 'annullato'
};

/* Numero scritto all'italiana nei messaggi (12,5). */
function fmt(n) { return String(r3(n)).replace('.', ','); }

function due(n) { return String(n).padStart(2, '0'); }

/* ---------- validazione ---------- */

function validaColli(v, predefinito) {
  if (v === undefined || v === null || v === '') return predefinito;
  var n = numero(v, 'colli');
  if (n !== Math.floor(n) || n < 1 || n > 999) throw errore(400, 'I colli devono essere un numero intero da 1 a 999.');
  return n;
}

function Logistica(server) {
  this.server = server;
  this.database = server.database;
  this.accessi = server.accessi;
  this.operazioni = server.operazioni || new O.Operazioni(server.database, server.accessi, function () {});
}

Logistica.prototype.db = function () { return this.database.dati; };

/* Ora attuale: un metodo a parte, così le prove possono simulare il cambio d'anno. */
Logistica.prototype.adesso = function () { return new Date(); };

Logistica.prototype.oggi = function () {
  var d = this.adesso();
  return d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate());
};

Logistica.prototype.dopoScrittura = function (r) {
  if (this.server && typeof this.server.notifica === 'function') this.server.notifica(r.rev);
  return r;
};

Logistica.prototype.richiedi = function (ctx, permesso) {
  if (!ctx.permessi || !ctx.permessi[permesso]) throw errore(403, 'Il tuo utente non può fare questa operazione.');
};

/* Magazzino vero (non "In transito"), oppure 400. */
Logistica.prototype.magazzino = function (id, ruolo, soloAttivo) {
  var r = this.database.reparto(String(id || ''));
  if (!r || r.tipo === 'transito') throw errore(400, ruolo + ' non valido: aggiorna la pagina.');
  if (soloAttivo && !r.attivo) throw errore(400, 'Il magazzino ' + r.nome + ' non è attivo.');
  return r;
};

Logistica.prototype.scrivibile = function (ctx, reparto, cosa) {
  if (!A.puoScrivereReparto(ctx.permessi, reparto.id)) throw errore(403, 'Non puoi ' + cosa + ' per il magazzino ' + reparto.nome + '.');
};

Logistica.prototype.centrale = function () {
  var attivi = this.database.reparti().filter(function (r) { return r.attivo && r.tipo !== 'transito'; });
  return attivi.filter(function (r) { return r.tipo === 'centrale' || r.centrale; })[0] || null;
};

Logistica.prototype.chi = function (ctx) {
  return { id: ctx.utente ? ctx.utente.id : null, nome: ctx.utente ? ctx.utente.nome : '' };
};

/*
 * Numero del documento: RIC-AAAA-NNNN o DDT-AAAA-NNNN, progressivo per anno. Il contatore sta in meta
 * (prog_ric_AAAA, prog_ddt_AAAA) e si assegna dentro la transazione; per sicurezza non scende mai sotto il
 * progressivo più alto già usato (per esempio dopo il ripristino di una copia vecchia).
 */
Logistica.prototype.prossimoNumero = function (tipo) {
  var anno = this.adesso().getFullYear();
  var tabella = tipo === 'ric' ? 'richieste' : 'ddt';
  var chiave = 'prog_' + tipo + '_' + anno;
  var massimo = this.db().prepare('SELECT MAX(progressivo) m FROM ' + tabella + ' WHERE anno = ?').get(anno).m || 0;
  var n = Math.max(Number(this.database.meta(chiave)) || 0, massimo) + 1;
  this.database.impostaMeta(chiave, n);
  return { anno: anno, progressivo: n, numero: (tipo === 'ric' ? 'RIC' : 'DDT') + '-' + anno + '-' + String(n).padStart(4, '0') };
};

/* ---------- lettura ---------- */

Logistica.prototype.richiesta = function (id) {
  var r = this.db().prepare('SELECT * FROM richieste WHERE id = ?').get(String(id));
  return r ? D.richiestaDaRiga(r) : null;
};

Logistica.prototype.righeRichiesta = function (id) {
  return this.db().prepare('SELECT * FROM richieste_righe WHERE richiesta_id = ? ORDER BY ordine').all(String(id)).map(D.richiestaRigaDaRiga);
};

Logistica.prototype.ddt = function (id) {
  var r = this.db().prepare('SELECT * FROM ddt WHERE id = ?').get(String(id));
  return r ? D.ddtDaRiga(r) : null;
};

Logistica.prototype.righeDdt = function (id) {
  return this.db().prepare('SELECT * FROM ddt_righe WHERE ddt_id = ? ORDER BY ordine').all(String(id)).map(D.ddtRigaDaRiga);
};

/* Le tabelle che servono a Calcoli.avanzamentoRichiesta per una richiesta. */
Logistica.prototype.statoRichiesta = function (id) {
  var ddt = this.db().prepare('SELECT * FROM ddt WHERE richiesta_id = ?').all(String(id)).map(D.ddtDaRiga);
  var righe = ddt.length
    ? this.db().prepare('SELECT r.* FROM ddt_righe r JOIN ddt d ON d.id = r.ddt_id WHERE d.richiesta_id = ?').all(String(id)).map(D.ddtRigaDaRiga)
    : [];
  return { richiesteRighe: this.righeRichiesta(id), ddt: ddt, ddtRighe: righe };
};

Logistica.prototype.avanzamento = function (id) {
  return Calcoli.avanzamentoRichiesta(this.statoRichiesta(id), id);
};

Logistica.prototype.rispostaRichiesta = function (rev, id) {
  return { rev: rev, richiesta: this.richiesta(id), righe: this.righeRichiesta(id) };
};

Logistica.prototype.rispostaDdt = function (rev, id) {
  return { rev: rev, ddt: this.ddt(id), righe: this.righeDdt(id) };
};

/* ======================= richieste ======================= */

/*
 * Righe di una richiesta: [{ id?, articoloId, quantita, nota }]. Lo stesso articolo scritto due volte diventa una riga sola.
 * Un articolo non attivo si può tenere in una riga già salvata, non aggiungere.
 */
Logistica.prototype.validaRigheRichiesta = function (lista) {
  if (lista === undefined || lista === null) return null;
  if (!Array.isArray(lista)) throw errore(400, 'Righe della richiesta non valide.');
  if (lista.length > MAX_RIGHE) throw errore(400, 'Troppe righe in una richiesta (massimo ' + MAX_RIGHE + ').');
  var self = this;
  var perArticolo = {};
  var out = [];
  lista.forEach(function (x, i) {
    if (!x || typeof x !== 'object') throw errore(400, 'Riga ' + (i + 1) + ' non valida.');
    var a = self.database.articolo(String(x.articoloId || ''));
    if (!a) throw errore(400, 'Riga ' + (i + 1) + ': articolo non trovato, aggiorna la pagina.');
    var q = numero(x.quantita, 'quantità');
    if (!(q > 0)) throw errore(400, 'Riga ' + (i + 1) + ' (' + a.nome + '): la quantità deve essere maggiore di zero.');
    var nota = testo(x.nota, 200, 'nota');
    var gia = perArticolo[a.id];
    if (gia) {
      gia.quantita = r3(gia.quantita + q);
      if (nota) gia.nota = (gia.nota ? gia.nota + ' · ' : '') + nota;
      if (gia.nota.length > 200) gia.nota = gia.nota.slice(0, 200);
      return;
    }
    if (!a.attivo && !x.id) throw errore(400, 'L’articolo ' + a.nome + ' non è attivo: non si può chiedere.');
    perArticolo[a.id] = { id: x.id ? String(x.id) : null, articoloId: a.id, articolo: a, quantita: q, nota: nota };
    out.push(perArticolo[a.id]);
  });
  return out;
};

/* Sostituisce le righe della richiesta: tiene gli id delle righe che restano, toglie le altre. */
Logistica.prototype.scriviRigheRichiesta = function (rev, richiestaId, righe) {
  var db = this.db();
  var vecchie = db.prepare('SELECT id FROM richieste_righe WHERE richiesta_id = ?').all(richiestaId).map(function (x) { return x.id; });
  var tenute = {};
  righe.forEach(function (x, i) {
    if (x.id && vecchie.indexOf(x.id) >= 0 && !tenute[x.id]) {
      tenute[x.id] = true;
      db.prepare('UPDATE richieste_righe SET articolo_id = ?, quantita = ?, nota = ?, ordine = ?, rev = ? WHERE id = ?')
        .run(x.articoloId, x.quantita, x.nota, i, rev, x.id);
    } else {
      db.prepare('INSERT INTO richieste_righe (id, richiesta_id, articolo_id, quantita, approvata, nota, ordine, rev) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
        .run(nuovoId('rr'), richiestaId, x.articoloId, x.quantita, x.nota, i, rev);
    }
  });
  vecchie.filter(function (id) { return !tenute[id]; }).forEach(function (id) {
    db.prepare('DELETE FROM richieste_righe WHERE id = ?').run(id);
    db.prepare('INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)').run('richiesteRighe', id, rev);
  });
};

Logistica.prototype.creaRichiesta = function (ctx, dati) {
  this.richiedi(ctx, 'richieste');
  dati = dati || {};
  var reparto = this.magazzino(dati.repartoId, 'Magazzino che chiede', true);
  this.scrivibile(ctx, reparto, 'fare richieste');
  var fornitore = dati.fornitoreId ? this.magazzino(dati.fornitoreId, 'Magazzino a cui chiedere', true) : this.centrale();
  if (!fornitore) throw errore(400, 'Non c’è una farmacia centrale attiva: chiedi all’amministratore di indicarla.');
  if (fornitore.id === reparto.id) throw errore(400, 'Un magazzino non può fare una richiesta a se stesso.');
  var righe = this.validaRigheRichiesta(dati.righe) || [];
  if (!righe.length) throw errore(400, 'Aggiungi almeno un articolo alla richiesta.');
  var note = testo(dati.note, 500, 'note');
  var urgente = !!dati.urgente;
  var invia = !!dati.invia;
  var self = this;
  var chi = this.chi(ctx);
  var id = nuovoId('ric');
  var numeroAssegnato = '';
  var r = this.database.scrivi(function (rev) {
    var n = self.prossimoNumero('ric');
    numeroAssegnato = n.numero;
    var ora = self.adesso().toISOString();
    self.db().prepare('INSERT INTO richieste (id, numero, anno, progressivo, reparto_id, fornitore_id, stato, urgente, note, creata_da, creata_da_nome, creata_il, inviata_il, rev) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, n.numero, n.anno, n.progressivo, reparto.id, fornitore.id, invia ? 'inviata' : 'bozza', urgente ? 1 : 0, note, chi.id, chi.nome, ora, invia ? ora : null, rev);
    self.scriviRigheRichiesta(rev, id, righe);
  });
  this.accessi.evento(ctx, 'richieste.crea', {
    numero: numeroAssegnato, reparto: reparto.nome, fornitore: fornitore.nome, urgente: urgente || undefined, inviata: invia,
    righe: righe.map(function (x) { return { articolo: x.articolo.nome, quantita: x.quantita }; })
  });
  this.dopoScrittura(r);
  return this.rispostaRichiesta(r.rev, id);
};

/* Richiesta da modificare dal richiedente: esiste, è di un suo magazzino. */
Logistica.prototype.richiestaDelRichiedente = function (ctx, id, cosa) {
  this.richiedi(ctx, 'richieste');
  var r = this.richiesta(id);
  if (!r) throw errore(404, 'Richiesta non trovata: forse è stata eliminata, aggiorna la pagina.');
  var reparto = this.database.reparto(r.repartoId) || { id: r.repartoId, nome: r.repartoId };
  this.scrivibile(ctx, reparto, cosa);
  return r;
};

function erroreStatoRichiesta(r, azione) {
  if (r.stato === 'in_lavorazione') {
    return errore(409, 'La farmacia ha già preso in carico la richiesta ' + r.numero + ': non si può più ' + azione + '. Se serve altro, fai una nuova richiesta.');
  }
  return errore(409, 'La richiesta ' + r.numero + ' è ' + (NOME_STATO_RICHIESTA[r.stato] || r.stato) + ': non si può più ' + azione + '.');
}

Logistica.prototype.modificaRichiesta = function (ctx, id, dati) {
  dati = dati || {};
  var prima = this.richiestaDelRichiedente(ctx, id, 'modificare le richieste');
  var righe = this.validaRigheRichiesta(dati.righe);
  if (righe && !righe.length) throw errore(400, 'Una richiesta deve avere almeno un articolo: per toglierla usa “Annulla richiesta”.');
  var note = dati.note === undefined ? null : testo(dati.note, 500, 'note');
  var urgente = dati.urgente === undefined ? null : !!dati.urgente;
  var self = this;
  var r = this.database.scrivi(function (rev) {
    var ora = self.richiesta(prima.id);
    if (ora.stato !== 'bozza' && ora.stato !== 'inviata') throw erroreStatoRichiesta(ora, 'modificare');
    if (righe) self.scriviRigheRichiesta(rev, ora.id, righe);
    self.db().prepare('UPDATE richieste SET note = ?, urgente = ?, rev = ? WHERE id = ?')
      .run(note === null ? ora.note : note, (urgente === null ? ora.urgente : urgente) ? 1 : 0, rev, ora.id);
  });
  this.accessi.evento(ctx, 'richieste.modifica', {
    numero: prima.numero, righe: righe ? righe.map(function (x) { return { articolo: x.articolo.nome, quantita: x.quantita }; }) : undefined,
    urgente: urgente === null ? undefined : urgente
  });
  this.dopoScrittura(r);
  return this.rispostaRichiesta(r.rev, prima.id);
};

Logistica.prototype.inviaRichiesta = function (ctx, id) {
  var prima = this.richiestaDelRichiedente(ctx, id, 'inviare le richieste');
  var self = this;
  var r = this.database.scrivi(function (rev) {
    var ora = self.richiesta(prima.id);
    if (ora.stato === 'inviata') throw errore(409, 'La richiesta ' + ora.numero + ' è già stata inviata.');
    if (ora.stato !== 'bozza') throw erroreStatoRichiesta(ora, 'inviare');
    if (!self.righeRichiesta(ora.id).length) throw errore(400, 'Aggiungi almeno un articolo prima di inviare la richiesta.');
    self.db().prepare("UPDATE richieste SET stato = 'inviata', inviata_il = ?, rev = ? WHERE id = ?").run(self.adesso().toISOString(), rev, ora.id);
  });
  this.accessi.evento(ctx, 'richieste.invia', { numero: prima.numero });
  this.dopoScrittura(r);
  return this.rispostaRichiesta(r.rev, prima.id);
};

Logistica.prototype.annullaRichiesta = function (ctx, id, motivo) {
  var prima = this.richiestaDelRichiedente(ctx, id, 'annullare le richieste');
  motivo = testo(motivo, 300, 'motivo') || 'Annullata da chi l’ha fatta';
  var self = this;
  var chi = this.chi(ctx);
  var r = this.database.scrivi(function (rev) {
    var ora = self.richiesta(prima.id);
    if (ora.stato !== 'bozza' && ora.stato !== 'inviata') throw erroreStatoRichiesta(ora, 'annullare');
    self.db().prepare("UPDATE richieste SET stato = 'annullata', chiusa_il = ?, chiusa_da = ?, chiusa_da_nome = ?, motivo = ?, rev = ? WHERE id = ?")
      .run(self.adesso().toISOString(), chi.id, chi.nome, motivo, rev, ora.id);
  });
  this.accessi.evento(ctx, 'richieste.annulla', { numero: prima.numero, motivo: motivo });
  this.dopoScrittura(r);
  return this.rispostaRichiesta(r.rev, prima.id);
};

/* Richiesta da evadere: esiste e chi evade può scrivere nel magazzino a cui è stata chiesta. */
Logistica.prototype.richiestaDaEvadere = function (ctx, id) {
  this.richiedi(ctx, 'evadiRichieste');
  var r = this.richiesta(id);
  if (!r) throw errore(404, 'Richiesta non trovata: forse è stata eliminata, aggiorna la pagina.');
  if (r.stato === 'bozza') throw errore(409, 'La richiesta ' + r.numero + ' non è ancora stata inviata.');
  var fornitore = this.database.reparto(r.fornitoreId) || { id: r.fornitoreId, nome: r.fornitoreId };
  this.scrivibile(ctx, fornitore, 'evadere le richieste');
  return r;
};

/* Dentro una transazione: la richiesta inviata passa in lavorazione; le quantità da approvare partono da quelle chieste. */
Logistica.prototype.prendi = function (ctx, rev, r) {
  if (r.stato !== 'inviata') return false;
  var chi = this.chi(ctx);
  this.db().prepare("UPDATE richieste SET stato = 'in_lavorazione', presa_da = ?, presa_da_nome = ?, presa_il = ?, rev = ? WHERE id = ?")
    .run(chi.id, chi.nome, this.adesso().toISOString(), rev, r.id);
  this.db().prepare('UPDATE richieste_righe SET approvata = quantita, rev = ? WHERE richiesta_id = ? AND approvata IS NULL').run(rev, r.id);
  r.stato = 'in_lavorazione';
  return true;
};

function controllaInLavorazione(r, azione) {
  if (r.stato !== 'inviata' && r.stato !== 'in_lavorazione') {
    throw errore(409, 'La richiesta ' + r.numero + ' è ' + (NOME_STATO_RICHIESTA[r.stato] || r.stato) + ': non si può più ' + azione + '.');
  }
}

Logistica.prototype.prendiRichiesta = function (ctx, id) {
  var prima = this.richiestaDaEvadere(ctx, id);
  // già presa in carico da me: niente da scrivere
  if (prima.stato === 'in_lavorazione' && prima.presaDa === ctx.utente.id) return this.rispostaRichiesta(this.database.rev(), prima.id);
  var self = this;
  var presa = false;
  var r = this.database.scrivi(function (rev) {
    var ora = self.richiesta(prima.id);
    if (ora.stato === 'in_lavorazione') {
      if (ora.presaDa && ora.presaDa !== ctx.utente.id) {
        throw errore(409, 'La richiesta ' + ora.numero + ' è già stata presa in carico da ' + (ora.presaDaNome || 'un altro utente') + '.');
      }
      return;
    }
    controllaInLavorazione(ora, 'prendere in carico');
    presa = self.prendi(ctx, rev, ora);
  });
  if (presa) {
    this.accessi.evento(ctx, 'richieste.prendi', { numero: prima.numero });
    this.dopoScrittura(r);
  }
  return this.rispostaRichiesta(r.rev, prima.id);
};

/*
 * Stato della richiesta dopo una spedizione, un annullo o un'approvazione: evasa quando tutto l'approvato è partito;
 * torna in lavorazione se un DDT annullato lascia di nuovo qualcosa da spedire.
 */
Logistica.prototype.aggiornaStatoRichiesta = function (ctx, rev, richiestaId) {
  var r = this.richiesta(richiestaId);
  if (!r) return null;
  var av = this.avanzamento(richiestaId);
  var tutto = av.length > 0 && av.every(function (x) { return r3(x.base - x.spedita) <= 0; });
  var qualcosa = av.some(function (x) { return x.spedita > 0; });
  var chi = this.chi(ctx);
  if ((r.stato === 'inviata' || r.stato === 'in_lavorazione') && tutto && qualcosa) {
    this.db().prepare("UPDATE richieste SET stato = 'evasa', chiusa_il = ?, chiusa_da = ?, chiusa_da_nome = ?, rev = ? WHERE id = ?")
      .run(this.adesso().toISOString(), chi.id, chi.nome, rev, r.id);
    return 'evasa';
  }
  if (r.stato === 'evasa' && !tutto) {
    this.db().prepare("UPDATE richieste SET stato = 'in_lavorazione', chiusa_il = NULL, chiusa_da = NULL, chiusa_da_nome = '', rev = ? WHERE id = ?").run(rev, r.id);
    return 'in_lavorazione';
  }
  return null;
};

Logistica.prototype.approvaRichiesta = function (ctx, id, dati) {
  var prima = this.richiestaDaEvadere(ctx, id);
  var lista = dati && dati.righe;
  if (!Array.isArray(lista) || !lista.length) throw errore(400, 'Indica le quantità approvate.');
  if (lista.length > MAX_RIGHE) throw errore(400, 'Troppe righe (massimo ' + MAX_RIGHE + ').');
  var valori = lista.map(function (x, i) {
    if (!x || typeof x !== 'object' || !x.id) throw errore(400, 'Riga ' + (i + 1) + ' non valida.');
    var v = { id: String(x.id), approvata: numero(x.approvata, 'quantità approvata', { min: 0 }) };
    // l'approvata che il client mostrava (null = non ancora approvata): se nel frattempo è cambiata, 409
    if (Object.prototype.hasOwnProperty.call(x, 'prima')) {
      v.controlla = true;
      v.prima = x.prima === null || x.prima === '' ? null : numero(x.prima, 'quantità approvata di prima', { min: 0 });
    }
    return v;
  });
  var self = this;
  var cambi = [];
  var nuovoStato = null;
  var r = this.database.scrivi(function (rev) {
    var ora = self.richiesta(prima.id);
    controllaInLavorazione(ora, 'approvare');
    var viste = {};
    self.righeRichiesta(ora.id).forEach(function (x) { viste[x.id] = x; });
    valori.forEach(function (v) {
      var x = viste[v.id];
      if (!v.controlla || !x) return;
      var adesso = x.approvata === null || x.approvata === undefined ? null : r3(x.approvata);
      if (adesso !== v.prima) {
        var art = self.database.articolo(x.articoloId);
        var chi = ora.presaDa && ora.presaDa !== ctx.utente.id ? (ora.presaDaNome || 'un altro utente') : 'un altro utente';
        throw errore(409, 'Nel frattempo ' + chi + ' ha cambiato la quantità approvata di ' + (art ? art.nome : 'un articolo') +
          ' (ora ' + (adesso === null ? 'non approvata' : fmt(adesso)) + '): ho ricaricato la richiesta, controlla e salva di nuovo.');
      }
    });
    self.prendi(ctx, rev, ora);
    var perRiga = {};
    self.avanzamento(ora.id).forEach(function (x) { perRiga[x.rigaId] = x; });
    valori.forEach(function (v) {
      var x = perRiga[v.id];
      if (!x) throw errore(400, 'Riga della richiesta non trovata: aggiorna la pagina.');
      var gia = r3(x.spedita + x.inPreparazione);
      var art = self.database.articolo(x.articoloId);
      if (v.approvata < gia) {
        throw errore(409, 'Di ' + (art ? art.nome : 'un articolo') + ' sono già state preparate o spedite ' + fmt(gia) + ': non puoi approvarne di meno.');
      }
      if (v.approvata !== x.approvata) cambi.push({ articolo: art ? art.nome : x.articoloId, richiesta: x.quantita, approvata: v.approvata });
      self.db().prepare('UPDATE richieste_righe SET approvata = ?, rev = ? WHERE id = ?').run(v.approvata, rev, v.id);
    });
    self.db().prepare('UPDATE richieste SET rev = ? WHERE id = ?').run(rev, ora.id);
    nuovoStato = self.aggiornaStatoRichiesta(ctx, rev, ora.id);
  });
  this.accessi.evento(ctx, 'richieste.approva', { numero: prima.numero, cambi: cambi, stato: nuovoStato || undefined });
  this.dopoScrittura(r);
  return this.rispostaRichiesta(r.rev, prima.id);
};

Logistica.prototype.rifiutaRichiesta = function (ctx, id, motivo) {
  var prima = this.richiestaDaEvadere(ctx, id);
  motivo = testo(motivo, 300, 'motivo');
  if (!motivo) throw errore(400, 'Scrivi il motivo del rifiuto: lo legge chi ha fatto la richiesta.');
  var self = this;
  var chi = this.chi(ctx);
  var r = this.database.scrivi(function (rev) {
    var ora = self.richiesta(prima.id);
    controllaInLavorazione(ora, 'rifiutare');
    if (self.db().prepare("SELECT 1 FROM ddt WHERE richiesta_id = ? AND stato <> 'annullato' LIMIT 1").get(ora.id)) {
      throw errore(409, 'Per la richiesta ' + ora.numero + ' ci sono già dei DDT: chiudila con il residuo invece di rifiutarla (prima annulla i DDT ancora in preparazione).');
    }
    var adesso = self.adesso().toISOString();
    self.db().prepare("UPDATE richieste SET stato = 'rifiutata', presa_da = COALESCE(presa_da, ?), presa_da_nome = CASE WHEN presa_il IS NULL THEN ? ELSE presa_da_nome END, " +
      'presa_il = COALESCE(presa_il, ?), chiusa_il = ?, chiusa_da = ?, chiusa_da_nome = ?, motivo = ?, rev = ? WHERE id = ?')
      .run(chi.id, chi.nome, adesso, adesso, chi.id, chi.nome, motivo, rev, ora.id);
  });
  this.accessi.evento(ctx, 'richieste.rifiuta', { numero: prima.numero, motivo: motivo });
  this.dopoScrittura(r);
  return this.rispostaRichiesta(r.rev, prima.id);
};

Logistica.prototype.chiudiRichiesta = function (ctx, id, motivo) {
  var prima = this.richiestaDaEvadere(ctx, id);
  motivo = testo(motivo, 300, 'motivo') || 'Chiusa con residuo';
  var self = this;
  var chi = this.chi(ctx);
  var r = this.database.scrivi(function (rev) {
    var ora = self.richiesta(prima.id);
    controllaInLavorazione(ora, 'chiudere');
    var inPrep = self.db().prepare("SELECT numero FROM ddt WHERE richiesta_id = ? AND stato = 'in_preparazione' LIMIT 1").get(ora.id);
    if (inPrep) throw errore(409, 'Il DDT ' + inPrep.numero + ' di questa richiesta è ancora in preparazione: spediscilo o annullalo prima di chiudere la richiesta.');
    self.prendi(ctx, rev, ora);
    self.db().prepare("UPDATE richieste SET stato = 'chiusa', chiusa_il = ?, chiusa_da = ?, chiusa_da_nome = ?, motivo = ?, rev = ? WHERE id = ?")
      .run(self.adesso().toISOString(), chi.id, chi.nome, motivo, rev, ora.id);
  });
  var residuo = this.avanzamento(prima.id).filter(function (x) { return x.residuo > 0; }).length;
  this.accessi.evento(ctx, 'richieste.chiudi', { numero: prima.numero, motivo: motivo, righeConResiduo: residuo });
  this.dopoScrittura(r);
  return this.rispostaRichiesta(r.rev, prima.id);
};

/* ======================= DDT: preparazione e lotti ======================= */

/* Contesto per ripartire le righe sui lotti dentro una transazione. tranne: DDT da non contare fra i "già impegnati". */
Logistica.prototype.nuovaRipartizione = function (origineId, tranneDdtId) {
  return { origineId: origineId, tranne: tranneDdtId || '', cache: {}, presi: {} };
};

/*
 * Lotti liberi di un articolo nel magazzino di partenza, in ordine di scadenza (FEFO): la giacenza dei lotti
 * meno quanto è già messo in altri DDT in preparazione dallo stesso magazzino e quanto è già stato preso in questa operazione.
 * scaduto: true per i lotti già scaduti oggi (la scelta automatica non li spedisce).
 */
Logistica.prototype.lottiLiberi = function (rip, articoloId) {
  var stato = this.operazioni.statoArticolo(articoloId, rip.cache);
  var impegnati = {};
  var oggi = this.oggi();
  this.db().prepare("SELECT r.lotto, SUM(r.quantita) q FROM ddt_righe r JOIN ddt d ON d.id = r.ddt_id " +
    "WHERE d.stato = 'in_preparazione' AND d.origine_id = ? AND r.articolo_id = ? AND d.id <> ? GROUP BY r.lotto")
    .all(rip.origineId, articoloId, rip.tranne).forEach(function (x) { impegnati[x.lotto] = x.q; });
  return Calcoli.lotti(stato, articoloId, rip.origineId).map(function (l) {
    return {
      lotto: l.lotto, scadenza: l.scadenza, scaduto: Calcoli.scaduto(l.scadenza, oggi),
      quantita: r3(l.quantita - (impegnati[l.lotto] || 0) - (rip.presi[articoloId + '|' + l.lotto] || 0))
    };
  }).filter(function (l) { return l.quantita > 0; });
};

/*
 * Ripartisce una quantità sui lotti liberi: prima il lotto scelto (409 se non è disponibile; si può scegliere anche
 * un lotto scaduto, per esempio per un reso), poi chi scade prima, saltando i lotti già scaduti (si tolgono con una
 * perdita "Scaduto"). Restituisce { parti: [{ lotto, scadenza, quantita }], mancante, scaduti } (scaduti = merce
 * libera nei lotti scaduti non presa).
 */
Logistica.prototype.ripartisci = function (rip, articolo, quantita, lottoScelto, nomeOrigine) {
  var liberi = this.lottiLiberi(rip, articolo.id);
  var q = r3(quantita);
  var parti = [];
  function prendi(l) {
    var p = Math.min(q, l.quantita);
    if (p <= 0) return;
    var gia = parti.filter(function (x) { return x.lotto === l.lotto; })[0];
    if (gia) gia.quantita = r3(gia.quantita + p); else parti.push({ lotto: l.lotto, scadenza: l.scadenza, quantita: p });
    l.quantita = r3(l.quantita - p);
    q = r3(q - p);
  }
  if (lottoScelto) {
    var scelto = liberi.filter(function (l) { return l.lotto === lottoScelto; })[0];
    if (!scelto) {
      throw errore(409, 'Il lotto ' + lottoScelto + ' di ' + articolo.nome + ' non è disponibile in ' + nomeOrigine +
        ' (forse è già in un altro DDT o l’ha appena usato un altro utente): aggiorna e scegli un altro lotto.');
    }
    prendi(scelto);
  }
  for (var i = 0; i < liberi.length && q > 0; i++) if (!liberi[i].scaduto) prendi(liberi[i]);
  parti.forEach(function (p) {
    var k = articolo.id + '|' + p.lotto;
    rip.presi[k] = r3((rip.presi[k] || 0) + p.quantita);
  });
  var scaduti = r3(liberi.reduce(function (t, l) { return t + (l.scaduto ? l.quantita : 0); }, 0));
  return { parti: parti, mancante: q, scaduti: scaduti };
};

/* Spiegazione da aggiungere ai messaggi di merce mancante quando una parte è in lotti scaduti. */
function notaScaduti(scaduti) {
  return scaduti > 0 ? ' (altri ' + fmt(scaduti) + ' sono in lotti scaduti: non si spediscono da soli; toglili con una perdita «Scaduto» o, per un reso, scegli il lotto nella riga)' : '';
}

/* Righe del DDT (una per articolo e lotto; le parti uguali si sommano). */
Logistica.prototype.scriviRigheDdt = function (rev, ddtId, righe) {
  var db = this.db();
  var vecchie = db.prepare('SELECT id FROM ddt_righe WHERE ddt_id = ?').all(ddtId).map(function (x) { return x.id; });
  vecchie.forEach(function (id) {
    db.prepare('DELETE FROM ddt_righe WHERE id = ?').run(id);
    db.prepare('INSERT OR REPLACE INTO cancellati (tabella, id, rev) VALUES (?, ?, ?)').run('ddtRighe', id, rev);
  });
  var unite = [];
  var indice = {};
  righe.forEach(function (x) {
    var k = x.articoloId + '|' + (x.lotto || '') + '|' + (x.richiestaRigaId || '');
    if (indice[k] !== undefined) { unite[indice[k]].quantita = r3(unite[indice[k]].quantita + x.quantita); return; }
    indice[k] = unite.length;
    unite.push(Object.assign({}, x));
  });
  unite.forEach(function (x, i) {
    db.prepare('INSERT INTO ddt_righe (id, ddt_id, articolo_id, richiesta_riga_id, lotto, scadenza, quantita, ricevuta, esito, nota, ordine, rev) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '', ?, ?, ?)")
      .run(nuovoId('dr'), ddtId, x.articoloId, x.richiestaRigaId || null, x.lotto || '', x.scadenza || '', x.quantita, x.nota || '', i, rev);
  });
  return unite.length;
};

Logistica.prototype.inserisciDdt = function (ctx, rev, t, righe) {
  var n = this.prossimoNumero('ddt');
  var id = nuovoId('ddt');
  var chi = this.chi(ctx);
  this.db().prepare('INSERT INTO ddt (id, numero, anno, progressivo, origine_id, destinazione_id, richiesta_id, stato, causale, colli, note, ' +
    "preparato_da, preparato_da_nome, preparato_il, rev) VALUES (?, ?, ?, ?, ?, ?, ?, 'in_preparazione', ?, ?, ?, ?, ?, ?, ?)")
    .run(id, n.numero, n.anno, n.progressivo, t.origineId, t.destinazioneId, t.richiestaId || null, t.causale, t.colli, t.note,
      chi.id, chi.nome, this.adesso().toISOString(), rev);
  this.scriviRigheDdt(rev, id, righe);
  return { id: id, numero: n.numero };
};

/* Righe scritte a mano (nuovo DDT, modifica): [{ articoloId, quantita, lotto?, richiestaRigaId?, nota? }] */
Logistica.prototype.validaRigheDdt = function (lista) {
  if (!Array.isArray(lista) || !lista.length) throw errore(400, 'Aggiungi almeno un articolo al DDT.');
  if (lista.length > MAX_RIGHE) throw errore(400, 'Troppe righe in un DDT (massimo ' + MAX_RIGHE + ').');
  var self = this;
  return lista.map(function (x, i) {
    if (!x || typeof x !== 'object') throw errore(400, 'Riga ' + (i + 1) + ' non valida.');
    var a = self.database.articolo(String(x.articoloId || ''));
    if (!a) throw errore(400, 'Riga ' + (i + 1) + ': articolo non trovato, aggiorna la pagina.');
    var q = numero(x.quantita, 'quantità');
    if (!(q > 0)) throw errore(400, 'Riga ' + (i + 1) + ' (' + a.nome + '): la quantità deve essere maggiore di zero.');
    return {
      articolo: a, quantita: q, lotto: testo(x.lotto, 60, 'lotto'), nota: testo(x.nota, 200, 'nota'),
      richiestaRigaId: x.richiestaRigaId ? String(x.richiestaRigaId) : null
    };
  });
};

/*
 * Ripartisce sui lotti le righe scritte a mano. Merce libera insufficiente: 409 con l'elenco di cosa manca
 * (le quantità già messe in altri DDT in preparazione non si contano).
 */
Logistica.prototype.righeDaMano = function (rip, righe, origine) {
  var self = this;
  var out = [];
  var scoperti = [];
  righe.forEach(function (x) {
    var res = self.ripartisci(rip, x.articolo, x.quantita, x.lotto, origine.nome);
    res.parti.forEach(function (p) {
      out.push({ articoloId: x.articolo.id, richiestaRigaId: x.richiestaRigaId, lotto: p.lotto, scadenza: p.scadenza, quantita: p.quantita, nota: x.nota });
    });
    if (res.mancante > 0) scoperti.push(x.articolo.nome + ' (liberi ' + fmt(x.quantita - res.mancante) + ' su ' + fmt(x.quantita) + ')' + notaScaduti(res.scaduti));
  });
  if (scoperti.length) {
    throw errore(409, 'In ' + origine.nome + ' non c’è abbastanza merce per: ' + scoperti.join(', ') +
      '. Non si conta la merce già messa in altri DDT in preparazione. Correggi le quantità e riprova.');
  }
  return out;
};

Logistica.prototype.creaDdt = function (ctx, dati) {
  this.richiedi(ctx, 'ddt');
  dati = dati || {};
  var origine = this.magazzino(dati.origineId, 'Magazzino di partenza', true);
  this.scrivibile(ctx, origine, 'preparare DDT');
  var dest = this.magazzino(dati.destinazioneId, 'Magazzino di arrivo', true);
  if (dest.id === origine.id) throw errore(400, 'Il magazzino di partenza e quello di arrivo sono uguali.');
  var causale = testo(dati.causale, 100, 'causale') || 'Trasferimento interno';
  var colli = validaColli(dati.colli, 1);
  var note = testo(dati.note, 500, 'note');
  var righe = this.validaRigheDdt(dati.righe);
  righe.forEach(function (x) {
    if (!x.articolo.attivo) throw errore(400, 'L’articolo ' + x.articolo.nome + ' non è attivo.');
    x.richiestaRigaId = null; // un DDT scritto a mano non evade richieste
  });
  var self = this;
  var creato = null;
  var r = this.database.scrivi(function (rev) {
    var parti = self.righeDaMano(self.nuovaRipartizione(origine.id), righe, origine);
    creato = self.inserisciDdt(ctx, rev, { origineId: origine.id, destinazioneId: dest.id, causale: causale, colli: colli, note: note }, parti);
  });
  this.accessi.evento(ctx, 'ddt.crea', {
    numero: creato.numero, da: origine.nome, a: dest.nome, causale: causale,
    righe: righe.map(function (x) { return { articolo: x.articolo.nome, quantita: x.quantita, lotto: x.lotto || undefined }; })
  });
  this.dopoScrittura(r);
  return this.rispostaDdt(r.rev, creato.id);
};

/*
 * DDT dal residuo approvato di una richiesta. righe facoltative: [{ rigaId, quantita }] (0 = non in questo DDT).
 * Se la giacenza libera non basta prepara quanto c'è e lo dice in "mancanti".
 */
Logistica.prototype.preparaDdtRichiesta = function (ctx, id, dati) {
  var prima = this.richiestaDaEvadere(ctx, id);
  this.richiedi(ctx, 'ddt');
  dati = dati || {};
  var origine = this.magazzino(prima.fornitoreId, 'Magazzino di partenza', true);
  this.scrivibile(ctx, origine, 'preparare DDT');
  var dest = this.magazzino(prima.repartoId, 'Magazzino di arrivo');
  var scelte = null;
  if (dati.righe !== undefined && dati.righe !== null) {
    if (!Array.isArray(dati.righe)) throw errore(400, 'Righe non valide.');
    scelte = {};
    dati.righe.forEach(function (x) {
      if (!x || !x.rigaId) throw errore(400, 'Riga non valida: aggiorna la pagina.');
      scelte[String(x.rigaId)] = numero(x.quantita, 'quantità', { min: 0 });
    });
  }
  var causale = testo(dati.causale, 100, 'causale') || ('Rifornimento su richiesta ' + prima.numero);
  var colli = validaColli(dati.colli, 1);
  var note = testo(dati.note, 500, 'note');
  var self = this;
  var mancanti = [];
  var creato = null;
  var r = this.database.scrivi(function (rev) {
    mancanti = [];
    var ora = self.richiesta(prima.id);
    controllaInLavorazione(ora, 'evadere');
    self.prendi(ctx, rev, ora);
    var av = self.avanzamento(ora.id);
    if (scelte) {
      Object.keys(scelte).forEach(function (k) {
        if (!av.some(function (x) { return x.rigaId === k; })) throw errore(400, 'Riga della richiesta non trovata: aggiorna la pagina.');
      });
    }
    var rip = self.nuovaRipartizione(origine.id);
    var parti = [];
    av.forEach(function (x) {
      var art = self.database.articolo(x.articoloId);
      var q = scelte ? (scelte[x.rigaId] || 0) : x.residuo;
      if (scelte && q > x.residuo) {
        throw errore(400, 'Di ' + art.nome + ' puoi preparare al massimo ' + fmt(x.residuo) + ' (quello che resta dell’approvato).');
      }
      if (!(q > 0)) return;
      var res = self.ripartisci(rip, art, q, '', origine.nome);
      res.parti.forEach(function (p) {
        parti.push({ articoloId: art.id, richiestaRigaId: x.rigaId, lotto: p.lotto, scadenza: p.scadenza, quantita: p.quantita, nota: x.nota });
      });
      if (res.mancante > 0) {
        var m = { articoloId: art.id, articolo: art.nome, richiesta: q, preparata: r3(q - res.mancante) };
        if (res.scaduti > 0) m.scaduti = res.scaduti;
        mancanti.push(m);
      }
    });
    if (!parti.length) {
      if (!av.some(function (x) { return x.residuo > 0; })) throw errore(409, 'Per la richiesta ' + ora.numero + ' non resta niente da preparare: l’approvato è già in DDT o spedito.');
      var inScaduti = r3(mancanti.reduce(function (t, x) { return t + (x.scaduti || 0); }, 0));
      throw errore(409, 'In ' + origine.nome + ' non c’è merce libera per gli articoli da preparare: il DDT non è stato creato.' +
        (inScaduti > 0 ? ' C’è merce solo in lotti scaduti: toglili con una perdita «Scaduto».' : ''));
    }
    creato = self.inserisciDdt(ctx, rev, { origineId: origine.id, destinazioneId: dest.id, richiestaId: ora.id, causale: causale, colli: colli, note: note }, parti);
  });
  this.accessi.evento(ctx, 'ddt.crea', { numero: creato.numero, richiesta: prima.numero, da: origine.nome, a: dest.nome, mancanti: mancanti.length ? mancanti : undefined });
  this.dopoScrittura(r);
  var out = this.rispostaDdt(r.rev, creato.id);
  out.mancanti = mancanti;
  out.richiesta = this.richiesta(prima.id);
  return out;
};

/* DDT su cui lavora chi l'ha preparato: esiste e il magazzino di partenza è suo. */
Logistica.prototype.ddtDellOrigine = function (ctx, id, cosa) {
  this.richiedi(ctx, 'ddt');
  var d = this.ddt(id);
  if (!d) throw errore(404, 'DDT non trovato: aggiorna la pagina.');
  var origine = this.database.reparto(d.origineId) || { id: d.origineId, nome: d.origineId };
  this.scrivibile(ctx, origine, cosa);
  return { ddt: d, origine: origine };
};

function erroreStatoDdt(d, azione) {
  return errore(409, 'Il DDT ' + d.numero + ' è ' + (NOME_STATO_DDT[d.stato] || d.stato) + ': non si può più ' + azione + '.');
}

Logistica.prototype.modificaDdt = function (ctx, id, dati) {
  dati = dati || {};
  var x = this.ddtDellOrigine(ctx, id, 'modificare i DDT');
  var prima = x.ddt;
  var origine = x.origine;
  var causale = dati.causale === undefined ? null : (testo(dati.causale, 100, 'causale') || 'Trasferimento interno');
  var colli = dati.colli === undefined ? null : validaColli(dati.colli, 1);
  var note = dati.note === undefined ? null : testo(dati.note, 500, 'note');
  var righe = dati.righe === undefined ? null : this.validaRigheDdt(dati.righe);
  var self = this;
  var r = this.database.scrivi(function (rev) {
    var ora = self.ddt(prima.id);
    if (ora.stato !== 'in_preparazione') throw erroreStatoDdt(ora, 'modificare');
    if (righe) {
      var limite = {};
      var articoloRiga = {};
      if (ora.richiestaId) {
        // una riga collegata alla richiesta non supera l'approvato meno quanto è già in altri DDT o spedito
        var attuali = {};
        self.righeDdt(ora.id).forEach(function (rr) {
          if (rr.richiestaRigaId) attuali[rr.richiestaRigaId] = r3((attuali[rr.richiestaRigaId] || 0) + rr.quantita);
        });
        self.avanzamento(ora.richiestaId).forEach(function (a) {
          limite[a.rigaId] = r3(a.base - a.spedita - (a.inPreparazione - (attuali[a.rigaId] || 0)));
          articoloRiga[a.rigaId] = a.articoloId;
        });
      }
      var somme = {};
      righe.forEach(function (rr) {
        if (!rr.richiestaRigaId) return;
        if (!ora.richiestaId || limite[rr.richiestaRigaId] === undefined || articoloRiga[rr.richiestaRigaId] !== rr.articolo.id) {
          throw errore(400, 'La riga di ' + rr.articolo.nome + ' non appartiene alla richiesta di questo DDT: aggiorna la pagina.');
        }
        somme[rr.richiestaRigaId] = r3((somme[rr.richiestaRigaId] || 0) + rr.quantita);
        if (somme[rr.richiestaRigaId] > limite[rr.richiestaRigaId]) {
          throw errore(400, 'Di ' + rr.articolo.nome + ' puoi mettere al massimo ' + fmt(Math.max(0, limite[rr.richiestaRigaId])) + ' (quello che resta dell’approvato).');
        }
      });
      righe.forEach(function (rr) {
        if (!rr.richiestaRigaId && !rr.articolo.attivo) throw errore(400, 'L’articolo ' + rr.articolo.nome + ' non è attivo.');
      });
      self.scriviRigheDdt(rev, ora.id, self.righeDaMano(self.nuovaRipartizione(origine.id, ora.id), righe, origine));
    }
    self.db().prepare('UPDATE ddt SET causale = ?, colli = ?, note = ?, rev = ? WHERE id = ?')
      .run(causale === null ? ora.causale : causale, colli === null ? ora.colli : colli, note === null ? ora.note : note, rev, ora.id);
  });
  this.accessi.evento(ctx, 'ddt.modifica', {
    numero: prima.numero, causale: causale === null ? undefined : causale, colli: colli === null ? undefined : colli,
    righe: righe ? righe.map(function (rr) { return { articolo: rr.articolo.nome, quantita: rr.quantita, lotto: rr.lotto || undefined }; }) : undefined
  });
  this.dopoScrittura(r);
  return this.rispostaDdt(r.rev, prima.id);
};

/* ======================= DDT: partenza, ricezione, annullo ======================= */

/* Movimento di un DDT (trasferimento o perdita), con data di oggi, documento = numero del DDT e ddt_id. */
Logistica.prototype.movimento = function (ctx, rev, d, m) {
  return this.operazioni.inserisciMovimento(ctx, rev, Object.assign({
    data: this.oggi(), documento: d.numero, causale: d.causale, note: '', fornitore: '', prezzo: null, ddtId: d.id
  }, m));
};

Logistica.prototype.spedisciDdt = function (ctx, id, dati) {
  dati = dati || {};
  var x = this.ddtDellOrigine(ctx, id, 'spedire i DDT');
  var prima = x.ddt;
  var origine = x.origine;
  var trasportatoreId = null;
  var trasportatore = '';
  if (dati.trasportatoreId) {
    var u = this.accessi.utente(String(dati.trasportatoreId));
    if (!u || !u.attivo) throw errore(400, 'La persona scelta per il trasporto non è tra gli utenti attivi: aggiorna la pagina.');
    trasportatoreId = u.id;
    trasportatore = u.nome;
  } else {
    trasportatore = testo(dati.trasportatoreNome, 100, 'trasportatore');
  }
  if (!trasportatore) throw errore(400, 'Indica chi trasporta la merce.');
  var colli = dati.colli === undefined ? null : validaColli(dati.colli, 1);
  var self = this;
  var nuovoStatoRichiesta = null;
  var r = this.database.scrivi(function (rev) {
    var d = self.ddt(prima.id);
    if (d.stato !== 'in_preparazione') throw erroreStatoDdt(d, 'spedire');
    var dest = self.database.reparto(d.destinazioneId);
    if (!dest || !dest.attivo) throw errore(409, 'Il magazzino di arrivo ' + (dest ? dest.nome : '') + ' non è più attivo: annulla il DDT.');
    var righe = self.righeDdt(d.id);
    if (!righe.length) throw errore(409, 'Il DDT ' + d.numero + ' non ha righe: aggiungi gli articoli o annullalo.');
    // giacenza ricontrollata adesso: nel frattempo altri possono aver consumato o spedito gli stessi lotti
    var cache = {};
    var perLotto = {};
    righe.forEach(function (rr) {
      var k = rr.articoloId + '|' + rr.lotto;
      if (!perLotto[k]) perLotto[k] = { articoloId: rr.articoloId, lotto: rr.lotto, quantita: 0 };
      perLotto[k].quantita = r3(perLotto[k].quantita + rr.quantita);
    });
    var scoperti = [];
    Object.keys(perLotto).forEach(function (k) {
      var p = perLotto[k];
      var stato = self.operazioni.statoArticolo(p.articoloId, cache);
      var disp = Calcoli.disponibilitaLotto(stato, p.articoloId, d.origineId, null, p.lotto);
      if (disp < p.quantita) {
        var art = self.database.articolo(p.articoloId);
        scoperti.push((art ? art.nome : p.articoloId) + (p.lotto ? ' lotto ' + p.lotto : ' senza lotto') + ': ' + fmt(disp) + ' invece di ' + fmt(p.quantita));
      }
    });
    if (scoperti.length) {
      throw errore(409, 'Nel frattempo la giacenza in ' + origine.nome + ' è cambiata e non basta più per: ' + scoperti.join('; ') +
        '. Correggi le righe del DDT e riprova.');
    }
    righe.forEach(function (rr) {
      self.movimento(ctx, rev, d, {
        tipo: 'trasferimento', articoloId: rr.articoloId, repartoId: d.origineId, repartoDestId: ID_TRANSITO,
        quantita: rr.quantita, lotto: rr.lotto, scadenza: rr.scadenza, note: 'Verso ' + dest.nome
      });
    });
    self.db().prepare("UPDATE ddt SET stato = 'in_transito', trasportatore_id = ?, trasportatore_nome = ?, partito_il = ?, colli = ?, rev = ? WHERE id = ?")
      .run(trasportatoreId, trasportatore, self.adesso().toISOString(), colli === null ? d.colli : colli, rev, d.id);
    if (d.richiestaId) nuovoStatoRichiesta = self.aggiornaStatoRichiesta(ctx, rev, d.richiestaId);
  });
  this.accessi.evento(ctx, 'ddt.spedisci', { numero: prima.numero, trasportatore: trasportatore, colli: colli === null ? prima.colli : colli, richiesta: nuovoStatoRichiesta ? nuovoStatoRichiesta : undefined });
  this.dopoScrittura(r);
  return this.rispostaDdt(r.rev, prima.id);
};

/*
 * Ricezione: righe [{ id, ricevuta, esito: 'rientro'|'perdita', nota }]. Le righe non indicate si ricevono per intero.
 * La quantità ricevuta entra nel magazzino di arrivo; la differenza rientra all'origine o è una perdita in viaggio.
 * Quello che rientra torna nel residuo della richiesta collegata (che da evasa torna in lavorazione), così la farmacia
 * può rispedirlo; la perdita in viaggio resta spedita.
 */
Logistica.prototype.riceviDdt = function (ctx, id, dati) {
  this.richiedi(ctx, 'riceviDdt');
  dati = dati || {};
  var prima = this.ddt(id);
  if (!prima) throw errore(404, 'DDT non trovato: aggiorna la pagina.');
  var dest = this.database.reparto(prima.destinazioneId) || { id: prima.destinazioneId, nome: prima.destinazioneId };
  this.scrivibile(ctx, dest, 'ricevere i DDT');
  var indicate = {};
  if (dati.righe !== undefined && dati.righe !== null) {
    if (!Array.isArray(dati.righe)) throw errore(400, 'Righe della ricezione non valide.');
    dati.righe.forEach(function (x) {
      if (!x || !x.id) throw errore(400, 'Riga della ricezione non valida: aggiorna la pagina.');
      indicate[String(x.id)] = {
        ricevuta: numero(x.ricevuta, 'quantità ricevuta', { min: 0 }),
        esito: x.esito ? String(x.esito) : '',
        nota: testo(x.nota, 200, 'nota')
      };
    });
  }
  var noteRicezione = testo(dati.note, 500, 'note');
  var self = this;
  var chi = this.chi(ctx);
  var differenze = [];
  var nuovoStatoRichiesta = null;
  var r = this.database.scrivi(function (rev) {
    differenze = [];
    nuovoStatoRichiesta = null;
    var d = self.ddt(prima.id);
    if (d.stato === 'in_preparazione') throw errore(409, 'Il DDT ' + d.numero + ' non è ancora partito: si riceve dopo la spedizione.');
    if (d.stato !== 'in_transito') throw erroreStatoDdt(d, 'ricevere');
    var origine = self.database.reparto(d.origineId) || { nome: d.origineId };
    var righe = self.righeDdt(d.id);
    Object.keys(indicate).forEach(function (k) {
      if (!righe.some(function (rr) { return rr.id === k; })) throw errore(400, 'Riga del DDT non trovata: aggiorna la pagina.');
    });
    righe.forEach(function (rr) {
      var art = self.database.articolo(rr.articoloId);
      var nome = (art ? art.nome : rr.articoloId) + (rr.lotto ? ' (lotto ' + rr.lotto + ')' : '');
      var v = indicate[rr.id] || { ricevuta: rr.quantita, esito: '', nota: '' };
      if (v.ricevuta > rr.quantita) throw errore(400, 'Di ' + nome + ' sono partite ' + fmt(rr.quantita) + ': non puoi riceverne di più.');
      var diff = r3(rr.quantita - v.ricevuta);
      if (diff > 0 && ESITI.indexOf(v.esito) < 0) {
        throw errore(400, 'Di ' + nome + ' mancano ' + fmt(diff) + ': indica se rientrano in ' + origine.nome + ' o se sono una perdita in viaggio.');
      }
      if (v.ricevuta > 0) {
        self.movimento(ctx, rev, d, {
          tipo: 'trasferimento', articoloId: rr.articoloId, repartoId: ID_TRANSITO, repartoDestId: d.destinazioneId,
          quantita: v.ricevuta, lotto: rr.lotto, scadenza: rr.scadenza, note: 'Da ' + origine.nome
        });
      }
      if (diff > 0) {
        var causale = 'Differenza alla ricezione DDT ' + d.numero;
        if (v.esito === 'rientro') {
          self.movimento(ctx, rev, d, {
            tipo: 'trasferimento', articoloId: rr.articoloId, repartoId: ID_TRANSITO, repartoDestId: d.origineId,
            quantita: diff, lotto: rr.lotto, scadenza: rr.scadenza, causale: causale, note: 'Rientro' + (v.nota ? ': ' + v.nota : '')
          });
        } else {
          self.movimento(ctx, rev, d, {
            tipo: 'perdita', articoloId: rr.articoloId, repartoId: ID_TRANSITO, repartoDestId: null,
            quantita: diff, lotto: rr.lotto, scadenza: rr.scadenza, causale: causale, note: 'Perdita in viaggio' + (v.nota ? ': ' + v.nota : '')
          });
        }
        differenze.push({ articolo: nome, partita: rr.quantita, ricevuta: v.ricevuta, esito: v.esito });
      }
      self.db().prepare('UPDATE ddt_righe SET ricevuta = ?, esito = ?, nota = ?, rev = ? WHERE id = ?')
        .run(v.ricevuta, diff > 0 ? v.esito : '', v.nota || rr.nota || '', rev, rr.id);
    });
    self.db().prepare('UPDATE ddt SET stato = ?, ricevuto_da = ?, ricevuto_da_nome = ?, ricevuto_il = ?, note_ricezione = ?, rev = ? WHERE id = ?')
      .run(differenze.length ? 'ricevuto_con_differenze' : 'ricevuto', chi.id, chi.nome, self.adesso().toISOString(), noteRicezione, rev, d.id);
    // la merce rientrata all'origine torna nel residuo della richiesta (come con l'annullo): evasa → in lavorazione
    if (d.richiestaId) nuovoStatoRichiesta = self.aggiornaStatoRichiesta(ctx, rev, d.richiestaId);
  });
  this.accessi.evento(ctx, 'ddt.ricevi', {
    numero: prima.numero, a: dest.nome, differenze: differenze.length ? differenze : undefined, richiesta: nuovoStatoRichiesta || undefined
  });
  this.dopoScrittura(r);
  return this.rispostaDdt(r.rev, prima.id);
};

/*
 * Annullo: da in preparazione non c'è niente da fare; da in viaggio tutta la merce rientra all'origine
 * (trasferimento "In transito" → origine con data di oggi). Un DDT ricevuto non si annulla: si fa un DDT di reso.
 */
Logistica.prototype.annullaDdt = function (ctx, id, motivo) {
  var x = this.ddtDellOrigine(ctx, id, 'annullare i DDT');
  var prima = x.ddt;
  motivo = testo(motivo, 300, 'motivo') || 'DDT annullato';
  var self = this;
  var chi = this.chi(ctx);
  var eraPartito = false;
  var nuovoStatoRichiesta = null;
  var r = this.database.scrivi(function (rev) {
    var d = self.ddt(prima.id);
    if (d.stato === 'ricevuto' || d.stato === 'ricevuto_con_differenze') {
      throw errore(409, 'Il DDT ' + d.numero + ' è già stato ricevuto: non si annulla. Per restituire la merce prepara un DDT di reso dalla pagina Trasferimenti.');
    }
    if (d.stato === 'annullato') throw errore(409, 'Il DDT ' + d.numero + ' è già annullato.');
    if (d.stato === 'in_transito') {
      eraPartito = true;
      self.righeDdt(d.id).forEach(function (rr) {
        self.movimento(ctx, rev, d, {
          tipo: 'trasferimento', articoloId: rr.articoloId, repartoId: ID_TRANSITO, repartoDestId: d.origineId,
          quantita: rr.quantita, lotto: rr.lotto, scadenza: rr.scadenza, causale: 'Annullo DDT ' + d.numero, note: motivo
        });
      });
    }
    self.db().prepare("UPDATE ddt SET stato = 'annullato', annullato_il = ?, annullato_da = ?, motivo_annullo = ?, rev = ? WHERE id = ?")
      .run(self.adesso().toISOString(), chi.nome, motivo, rev, d.id);
    if (d.richiestaId) nuovoStatoRichiesta = self.aggiornaStatoRichiesta(ctx, rev, d.richiestaId);
  });
  this.accessi.evento(ctx, 'ddt.annulla', { numero: prima.numero, motivo: motivo, rientro: eraPartito || undefined, richiesta: nuovoStatoRichiesta || undefined });
  this.dopoScrittura(r);
  return this.rispostaDdt(r.rev, prima.id);
};

/*
 * Persone che possono trasportare la merce: gli utenti attivi (per la scelta alla spedizione).
 * Solo id e nome: chi prepara i DDT non ha bisogno di sapere ruoli e permessi degli altri utenti.
 */
Logistica.prototype.trasportatori = function (ctx) {
  this.richiedi(ctx, 'ddt');
  return {
    utenti: this.accessi.elencoUtenti().filter(function (u) { return u.attivo; })
      .map(function (u) { return { id: u.id, nome: u.nome }; })
  };
};

/* ======================= rotte ======================= */

module.exports.rotte = function (server) {
  var L = new Logistica(server);
  server.logistica = L;
  var RICHIESTE = { permesso: 'richieste' };
  var EVADI = { permesso: 'evadiRichieste' };
  var DDT = { permesso: 'ddt' };
  var RICEVI = { permesso: 'riceviDdt' };

  server.rotta('POST', '/api/richieste', RICHIESTE, function (ctx) { return L.creaRichiesta(ctx, ctx.corpo); });
  server.rotta('PUT', '/api/richieste/:id', RICHIESTE, function (ctx) { return L.modificaRichiesta(ctx, ctx.par.id, ctx.corpo); });
  server.rotta('POST', '/api/richieste/:id/invia', RICHIESTE, function (ctx) { return L.inviaRichiesta(ctx, ctx.par.id); });
  server.rotta('POST', '/api/richieste/:id/annulla', RICHIESTE, function (ctx) { return L.annullaRichiesta(ctx, ctx.par.id, ctx.corpo.motivo); });
  server.rotta('POST', '/api/richieste/:id/prendi', EVADI, function (ctx) { return L.prendiRichiesta(ctx, ctx.par.id); });
  server.rotta('POST', '/api/richieste/:id/approva', EVADI, function (ctx) { return L.approvaRichiesta(ctx, ctx.par.id, ctx.corpo); });
  server.rotta('POST', '/api/richieste/:id/rifiuta', EVADI, function (ctx) { return L.rifiutaRichiesta(ctx, ctx.par.id, ctx.corpo.motivo); });
  server.rotta('POST', '/api/richieste/:id/chiudi', EVADI, function (ctx) { return L.chiudiRichiesta(ctx, ctx.par.id, ctx.corpo.motivo); });
  server.rotta('POST', '/api/richieste/:id/ddt', EVADI, function (ctx) { return L.preparaDdtRichiesta(ctx, ctx.par.id, ctx.corpo); });

  server.rotta('POST', '/api/ddt', DDT, function (ctx) { return L.creaDdt(ctx, ctx.corpo); });
  server.rotta('PUT', '/api/ddt/:id', DDT, function (ctx) { return L.modificaDdt(ctx, ctx.par.id, ctx.corpo); });
  server.rotta('POST', '/api/ddt/:id/spedisci', DDT, function (ctx) { return L.spedisciDdt(ctx, ctx.par.id, ctx.corpo); });
  server.rotta('POST', '/api/ddt/:id/ricevi', RICEVI, function (ctx) { return L.riceviDdt(ctx, ctx.par.id, ctx.corpo); });
  server.rotta('POST', '/api/ddt/:id/annulla', DDT, function (ctx) { return L.annullaDdt(ctx, ctx.par.id, ctx.corpo.motivo); });
  server.rotta('GET', '/api/trasportatori', DDT, function (ctx) { return L.trasportatori(ctx); });
};

module.exports.Logistica = Logistica;
