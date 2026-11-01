/*
 * Versione 3.0 – parte C: verifica in due passaggi (2FA, codici TOTP), codici di recupero, computer attendibili,
 * criterio dell'amministratore. Contratto: docs/NOVITA-3.0.md ("2FA").
 *
 * La logica (cifratura dei segreti, codici, sfide, blocchi) sta in server/accessi.js; qui ci sono le rotte, registrate
 * da server/http.js con rotte(server). L'accesso in due passi (POST /api/login, POST /api/login/2fa) è in http.js.
 *
 * Il proprio account (ogni utente):
 *   GET    /api/2fa                → { attiva, attivataIl, obbligatoria, daAttivare, criterio, codiciRimasti, dispositivi,
 *                                      giorniDispositivo, oraServer }
 *   POST   /api/2fa/inizia         → { segretoBase32, chiave, uri, emittente, utente, cambio, oraServer }
 *   POST   /api/2fa/conferma       { codice } → { codiciRecupero: [10], utente }
 *   POST   /api/2fa/disattiva      { password, codice } → { utente }        (409 se il criterio la richiede)
 *   POST   /api/2fa/codici         { password } → { codiciRecupero: [10] }
 *   DELETE /api/2fa/dispositivi    → { ok, tolti }                          (dimentica i computer attendibili)
 * Amministratore (permesso 'sicurezza'):
 *   GET    /api/sicurezza          → { richiedi2fa, criteri, utenti: [...], oraServer }
 *   PUT    /api/sicurezza          { richiedi2fa } → come GET + { rev, daAttivare }
 *   POST   /api/utenti/:id/2fa/azzera → { utente }
 * Tutto finisce nel registro attività (azioni accesso.2fa.*).
 */
'use strict';

var A = require('./accessi.js');
var errore = A.errore;

var LIMITE = 16 * 1024; // corpi piccoli: codici e password

// etichette dei criteri per il registro attività e i messaggi
var NOMI_CRITERI = {
  nessuno: 'nessuno (facoltativa per tutti)',
  amministratori: 'amministratori',
  farmacisti: 'amministratori e farmacisti',
  tutti: 'tutti gli utenti'
};

module.exports.rotte = function (server) {
  var acc = server.accessi;
  var db = server.database;

  // chi deve ancora attivare la 2FA può usare solo queste (oltre a stato, uscita e cambio password)
  var DA_ATTIVARE = { anche2faDaAttivare: true, limite: LIMITE };
  var MIO = { limite: LIMITE };
  var ADMIN = { permesso: 'sicurezza', limite: LIMITE };

  function richiediAdmin(ctx) {
    if (!ctx.permessi || !ctx.permessi.sicurezza) throw errore(403, 'Il tuo utente non può fare questa operazione.');
  }

  // nome con cui il programma compare nell'app del telefono (Google Authenticator, Microsoft Authenticator…)
  function emittente() {
    var imp = db.impostazioni();
    return String(imp.nomeProdotto || imp.sigla || 'Gestionale Farmacia').trim().slice(0, 60) || 'Gestionale Farmacia';
  }

  /* ---------- il proprio account ---------- */

  server.rotta('GET', '/api/2fa', DA_ATTIVARE, function (ctx) {
    return acc.stato2fa(ctx.utente.id);
  });

  server.rotta('POST', '/api/2fa/inizia', DA_ATTIVARE, function (ctx) {
    return acc.inizia2fa(ctx, emittente());
  });

  // le altre sessioni dell'utente si chiudono (le loro notifiche se ne accorgono al controllo successivo)
  server.rotta('POST', '/api/2fa/conferma', DA_ATTIVARE, function (ctx) {
    return acc.conferma2fa(ctx, ctx.corpo.codice);
  });

  server.rotta('POST', '/api/2fa/disattiva', MIO, function (ctx) {
    return acc.disattiva2fa(ctx, ctx.corpo.password, ctx.corpo.codice);
  });

  server.rotta('POST', '/api/2fa/codici', MIO, function (ctx) {
    return acc.nuoviCodici2fa(ctx, ctx.corpo.password);
  });

  server.rotta('DELETE', '/api/2fa/dispositivi', MIO, function (ctx) {
    var r = acc.dimenticaDispositivi(ctx);
    // anche il cookie di questo browser (gli altri browser hanno un token che non vale più)
    ctx.res.setHeader('Set-Cookie', server.cookieDispositivo([]));
    return r;
  });

  /* ---------- amministratore ---------- */

  server.rotta('GET', '/api/sicurezza', ADMIN, function (ctx) {
    richiediAdmin(ctx);
    return acc.statoSicurezza();
  });

  server.rotta('PUT', '/api/sicurezza', ADMIN, function (ctx) {
    richiediAdmin(ctx);
    var nuovo = ctx.corpo.richiedi2fa;
    if (A.CRITERI_2FA.indexOf(nuovo) < 0) throw errore(400, 'Criterio non valido: scegli fra ' + A.CRITERI_2FA.join(', ') + '.');
    var prima = acc.criterio2fa();
    // chi cambia il criterio non deve chiudersi fuori da solo: se lo riguarda, deve avere già la 2FA attiva
    if (A.obbligo2fa(ctx.utente.ruolo, nuovo) && !ctx.utente.dueFattori) {
      throw errore(409, 'Prima attiva la verifica in due passaggi per il tuo utente (pulsante «La mia sicurezza»): il criterio scelto la richiede anche a te.', { attivaPrima: true });
    }
    var rev = null;
    if (nuovo !== prima) {
      // nella tabella impostazioni del magazzino, con una revisione nuova: i browser la ricevono con i dati
      var r = db.scrivi(function (nuovaRev) {
        db.dati.prepare('INSERT INTO impostazioni (chiave, valore, rev) VALUES (?, ?, ?) ON CONFLICT(chiave) DO UPDATE SET valore = excluded.valore, rev = excluded.rev')
          .run('richiedi2fa', JSON.stringify(nuovo), nuovaRev);
      });
      rev = r.rev;
    }
    var daAttivare = acc.utentiDaAttivare(nuovo);
    acc.evento(ctx, 'accesso.2fa.criterio', { prima: NOMI_CRITERI[prima], dopo: NOMI_CRITERI[nuovo], daAttivare: daAttivare.length });
    if (rev !== null) server.notifica(rev);
    // chi è collegato e ora deve attivarla: le notifiche si chiudono, il browser se ne accorge e guida all'attivazione
    server.chiudiSseUtenti(daAttivare);
    var out = acc.statoSicurezza();
    out.rev = rev;
    out.daAttivare = daAttivare.length;
    return out;
  });

  server.rotta('POST', '/api/utenti/:id/2fa/azzera', ADMIN, function (ctx) {
    richiediAdmin(ctx);
    var r = acc.azzera2fa(ctx, ctx.par.id);
    // le sue sessioni sono state chiuse (tranne quella di chi azzera, se è la sua): anche le notifiche
    if (r.utente.id !== ctx.utente.id) server.chiudiSseUtenti([r.utente.id]);
    return r;
  });
};
