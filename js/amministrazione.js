/*
 * Pagine di amministrazione: Utenti (solo amministratore) e Attività (registro attività,
 * amministratore e farmacista). I dati arrivano direttamente dall'API, non da App.S.
 */
(function (root) {
  'use strict';

  var App = root.App;
  var Api = root.Api;
  var h = App.h;
  var P = App.pagine;

  function scheda(titolo, corpo, extraTesta, stretto) {
    return '<section class="scheda"><div class="scheda-testa"><h2>' + titolo + '</h2>' + (extraTesta || '') + '</div>' +
      '<div class="scheda-corpo' + (stretto ? ' stretto' : '') + '">' + corpo + '</div></section>';
  }

  function vuoto(titolo, testo) {
    return '<div class="vuoto"><b>' + h(titolo) + '</b>' + (testo || '') + '</div>';
  }

  function valore(cont, sel) { var el = cont.querySelector(sel); return el ? el.value : ''; }

  function messaggioErrore(e) { return e && e.message ? e.message : String(e); }

  /* ======================= UTENTI ======================= */

  var DESCRIZIONE_RUOLI = {
    amministratore: 'tutto, compresi utenti, struttura, reparti e copie di sicurezza',
    farmacista: 'carichi, trasferimenti, consumi, perdite, inventario, articoli, correzioni del registro; annulla qualsiasi movimento; vede il registro attività',
    reparto: 'solo nei suoi reparti: consumi, perdite e correzioni dei consumi nel registro; annulla i propri consumi e perdite; consulta il resto',
    consultazione: 'solo lettura, stampe ed Excel (per esempio la direzione sanitaria)'
  };

  // password provvisoria facile da dettare: niente lettere che si confondono (l, I, O, 0)
  function generaPassword() {
    var lettere = 'abcdefghjkmnpqrstuvwxyz';
    var cifre = '23456789';
    var casuale = function (n) {
      if (root.crypto && root.crypto.getRandomValues) {
        var a = new Uint32Array(1);
        root.crypto.getRandomValues(a);
        return a[0] % n;
      }
      return Math.floor(Math.random() * n);
    };
    var s = '';
    for (var i = 0; i < 6; i++) s += lettere.charAt(casuale(lettere.length));
    for (i = 0; i < 4; i++) s += cifre.charAt(casuale(cifre.length));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function opzioniRuolo(scelto) {
    return Object.keys(App.RUOLI).map(function (r) {
      return '<option value="' + r + '"' + (r === scelto ? ' selected' : '') + '>' + h(App.RUOLI[r]) + '</option>';
    }).join('');
  }

  function spunteReparti(scelti) {
    var lista = App.S.reparti.filter(function (r) { return r.attivo !== false || scelti.indexOf(r.id) >= 0; });
    return '<div class="spunte-reparti">' + lista.map(function (r) {
      return '<label class="spunta"><input type="checkbox" class="u-rep" value="' + h(r.id) + '"' + (scelti.indexOf(r.id) >= 0 ? ' checked' : '') + '> ' +
        h(r.nome) + (r.attivo === false ? ' <span class="etichetta">non attivo</span>' : '') + '</label>';
    }).join('') + '</div>';
  }

  function campoPassword(id, etichetta) {
    return '<div class="campo"><span>' + h(etichetta) + '</span><div class="campo-riga">' +
      '<input id="' + id + '" autocomplete="off" spellcheck="false" class="mono">' +
      '<button class="btn piccolo" type="button" data-genera="' + id + '">Genera</button></div>' +
      '<small class="tenue">Almeno 8 caratteri. Comunicala all’utente: al primo accesso dovrà sceglierne una sua.</small></div>';
  }

  function collegaGenera(m) {
    m.querySelectorAll('[data-genera]').forEach(function (b) {
      b.addEventListener('click', function () {
        var inp = m.querySelector('#' + b.getAttribute('data-genera'));
        inp.value = generaPassword();
        inp.focus();
        inp.select();
      });
    });
  }

  // mostra le spunte dei reparti solo per il ruolo "reparto"
  function collegaRuolo(m) {
    var sel = m.querySelector('#u-ruolo');
    var box = m.querySelector('#u-reparti');
    function aggiorna() { box.hidden = sel.value !== 'reparto'; }
    sel.addEventListener('change', aggiorna);
    aggiorna();
  }

  function repartiScelti(m) {
    return Array.prototype.filter.call(m.querySelectorAll('.u-rep'), function (c) { return c.checked; }).map(function (c) { return c.value; });
  }

  P.utenti = function (cont) {
    cont.innerHTML =
      '<div class="banda info"><div><b>Ruoli</b><ul class="elenco-ruoli">' + Object.keys(App.RUOLI).map(function (r) {
        return '<li><b>' + h(App.RUOLI[r]) + '</b>: ' + h(DESCRIZIONE_RUOLI[r]) + '.</li>';
      }).join('') + '</ul></div></div>' +
      '<div class="strumenti"><label class="spunta"><input type="checkbox" id="u-anche"> Mostra anche gli utenti disattivati</label>' +
      '<span class="spazio"></span><button class="btn primario" type="button" id="u-nuovo">+ Nuovo utente</button></div>' +
      '<div id="u-tab">' + scheda('Utenti', '<p class="vuoto">Carico gli utenti…</p>', '', true) + '</div>';

    var utenti = [];

    function nomiReparti(u) {
      if (u.ruolo !== 'reparto') return '<span class="tenue">tutti</span>';
      var n = (u.reparti || []).map(App.nomeReparto);
      return n.length ? h(n.join(', ')) : '<span class="etichetta pericolo">nessuno</span>';
    }

    function disegna() {
      var anche = cont.querySelector('#u-anche').checked;
      var lista = utenti.filter(function (u) { return anche || u.attivo !== false; });
      cont.querySelector('#u-tab').innerHTML = scheda('Utenti',
        lista.length ? '<div class="tabella-contenitore"><table class="tabella"><thead><tr><th>Utente</th><th>Nome</th><th>Ruolo</th><th>Reparti</th><th>Stato</th><th>Ultimo accesso</th><th></th></tr></thead><tbody>' +
          lista.map(function (u) {
            var stato = u.attivo === false ? '<span class="etichetta">disattivato</span>'
              : u.bloccato ? '<span class="etichetta pericolo">bloccato</span>'
              : u.cambioPassword ? '<span class="etichetta attenzione">password provvisoria</span>'
              : '<span class="etichetta ok">attivo</span>';
            return '<tr' + (u.attivo === false ? ' class="annullato"' : '') + '><td class="mono">' + h(u.username) + (App.utente && u.id === App.utente.id ? ' <span class="etichetta info">sei tu</span>' : '') + '</td>' +
              '<td><b>' + h(u.nome) + '</b></td><td>' + h(App.nomeRuolo(u.ruolo)) + '</td><td class="piccolo">' + nomiReparti(u) + '</td>' +
              '<td>' + stato + '</td><td class="piccolo">' + (u.ultimoAccesso ? h(App.fmtDataOra(u.ultimoAccesso)) : '<span class="tenue">mai</span>') + '</td>' +
              '<td class="azioni"><button class="btn piccolo" type="button" data-modifica="' + h(u.id) + '">Modifica</button> ' +
              '<button class="btn piccolo" type="button" data-password="' + h(u.id) + '">Nuova password</button></td></tr>';
          }).join('') + '</tbody></table></div>'
          : vuoto('Nessun utente', ''),
        '<span class="nota">' + lista.length + ' utenti</span>', true);
    }

    function carica() {
      return Api.richiesta('GET', '/api/utenti').then(function (r) {
        utenti = (r && r.utenti) || [];
        if (document.body.contains(cont)) disegna();
      }, function (e) {
        if (!document.body.contains(cont)) return;
        cont.querySelector('#u-tab').innerHTML = scheda('Utenti', '<div class="banda pericolo" style="margin:14px"><p>Non riesco a leggere gli utenti: ' + h(messaggioErrore(e)) + '</p></div>', '', true);
      });
    }

    // dopo una modifica al proprio utente ricarico i permessi (per esempio cambio di ruolo)
    function dopoModifica(u) {
      if (!App.utente || u.id !== App.utente.id) return carica();
      return Api.richiesta('GET', '/api/stato').then(function (st) {
        if (st && st.utente) {
          App.utente = st.utente;
          App.permessi = st.permessi || {};
          App.aggiornaUtente();
        }
        if (App.paginaCorrente === 'utenti') return carica();
      }, function () { return carica(); });
    }

    function nuovoUtente() {
      App.apriModale({
        titolo: 'Nuovo utente',
        corpo: '<div class="modulo">' +
          '<label class="campo"><span>Nome utente (per entrare) *</span><input id="u-username" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="es. m.rossi"></label>' +
          '<label class="campo"><span>Nome e cognome *</span><input id="u-nome" autocomplete="off"></label>' +
          '<label class="campo"><span>Ruolo</span><select id="u-ruolo">' + opzioniRuolo('reparto') + '</select></label>' +
          campoPassword('u-password', 'Password provvisoria *') +
          '<div class="campo largo" id="u-reparti"><span>Reparti in cui registra</span>' + spunteReparti([]) + '</div>' +
          '</div><p class="piccolo tenue">Nome utente: da 3 a 40 caratteri, lettere minuscole, numeri, punto, trattino.</p>',
        piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="u-salva">Crea utente</button>',
        dopo: function (m) {
          collegaGenera(m);
          collegaRuolo(m);
          m.querySelector('#u-salva').addEventListener('click', function () {
            var b = this;
            var dati = {
              username: valore(m, '#u-username').trim().toLowerCase(),
              nome: valore(m, '#u-nome').trim(),
              ruolo: valore(m, '#u-ruolo'),
              reparti: [],
              password: valore(m, '#u-password')
            };
            if (dati.ruolo === 'reparto') dati.reparti = repartiScelti(m);
            if (!dati.username) { App.avviso('Scrivi il nome utente.', 'errore'); return; }
            if (!dati.nome) { App.avviso('Scrivi nome e cognome.', 'errore'); return; }
            if (dati.password.length < 8) { App.avviso('La password provvisoria deve avere almeno 8 caratteri.', 'errore'); return; }
            if (dati.ruolo === 'reparto' && !dati.reparti.length) { App.avviso('Scegli almeno un reparto.', 'errore'); return; }
            b.disabled = true;
            Api.richiesta('POST', '/api/utenti', dati).then(function () {
              App.chiudiModale();
              App.avviso('Utente “' + dati.username + '” creato. Password provvisoria: ' + dati.password, 'ok');
              carica();
            }, function (e) {
              b.disabled = false;
              App.avviso(messaggioErrore(e), 'errore');
            });
          });
        }
      });
    }

    function modificaUtente(u) {
      App.apriModale({
        titolo: 'Modifica utente ' + u.username,
        corpo: '<div class="modulo">' +
          '<label class="campo"><span>Nome utente</span><input value="' + h(u.username) + '" readonly class="mono"></label>' +
          '<label class="campo"><span>Nome e cognome *</span><input id="u-nome" value="' + h(u.nome) + '" autocomplete="off"></label>' +
          '<label class="campo"><span>Ruolo</span><select id="u-ruolo">' + opzioniRuolo(u.ruolo) + '</select></label>' +
          '<div class="campo largo" id="u-reparti"><span>Reparti in cui registra</span>' + spunteReparti(u.reparti || []) + '</div>' +
          '<label class="spunta largo"><input type="checkbox" id="u-attivo"' + (u.attivo !== false ? ' checked' : '') + '> Utente attivo (può entrare nel programma)</label>' +
          '</div><p class="piccolo tenue">Disattivare un utente chiude subito le sue sessioni aperte; i movimenti che ha registrato restano con il suo nome.</p>',
        piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="u-salva">Salva</button>',
        dopo: function (m) {
          collegaRuolo(m);
          m.querySelector('#u-salva').addEventListener('click', function () {
            var b = this;
            var dati = {
              nome: valore(m, '#u-nome').trim(),
              ruolo: valore(m, '#u-ruolo'),
              reparti: [],
              attivo: m.querySelector('#u-attivo').checked
            };
            if (dati.ruolo === 'reparto') dati.reparti = repartiScelti(m);
            if (!dati.nome) { App.avviso('Scrivi nome e cognome.', 'errore'); return; }
            if (dati.ruolo === 'reparto' && !dati.reparti.length) { App.avviso('Scegli almeno un reparto.', 'errore'); return; }
            var procedi = Promise.resolve(true);
            if (App.utente && u.id === App.utente.id && (dati.ruolo !== 'amministratore' || !dati.attivo)) {
              procedi = App.conferma('Modifichi il tuo utente', 'Stai togliendo a te stesso il ruolo di amministratore' + (dati.attivo ? '' : ' (e disattivi il tuo utente)') + ': dopo non potrai più gestire gli utenti. Procedo?', 'Procedi', true);
            }
            procedi.then(function (ok) {
              if (!ok) return;
              b.disabled = true;
              Api.richiesta('PUT', '/api/utenti/' + encodeURIComponent(u.id), dati).then(function () {
                App.chiudiModale();
                App.avviso('Utente aggiornato', 'ok');
                dopoModifica(u);
              }, function (e) {
                b.disabled = false;
                App.avviso(messaggioErrore(e), 'errore');
              });
            });
          });
        }
      });
    }

    function nuovaPassword(u) {
      App.apriModale({
        titolo: 'Nuova password per ' + u.username,
        corpo: '<p>Dai a <b>' + h(u.nome) + '</b> una nuova password <b>provvisoria</b>: dovrà cambiarla al primo accesso. Se l’utente era bloccato per troppi tentativi, viene sbloccato; le sue sessioni aperte si chiudono.</p>' +
          '<div class="modulo">' + campoPassword('u-password', 'Password provvisoria') + '</div>',
        piede: '<button class="btn" type="button" data-chiudi>Annulla</button><button class="btn primario" type="button" id="u-salva">Imposta password</button>',
        dopo: function (m) {
          collegaGenera(m);
          m.querySelector('#u-salva').addEventListener('click', function () {
            var b = this;
            var nuova = valore(m, '#u-password');
            if (nuova.length < 8) { App.avviso('La password deve avere almeno 8 caratteri.', 'errore'); return; }
            b.disabled = true;
            Api.richiesta('POST', '/api/utenti/' + encodeURIComponent(u.id) + '/password', { nuova: nuova }).then(function () {
              App.chiudiModale();
              App.avviso('Password provvisoria di “' + u.username + '”: ' + nuova + ' (da cambiare al primo accesso)', 'ok');
              carica();
            }, function (e) {
              b.disabled = false;
              App.avviso(messaggioErrore(e), 'errore');
            });
          });
        }
      });
    }

    App.rinfresca = carica;
    cont.querySelector('#u-nuovo').addEventListener('click', nuovoUtente);
    cont.querySelector('#u-anche').addEventListener('change', disegna);
    cont.addEventListener('click', function (e) {
      var b = e.target.closest('[data-modifica], [data-password]');
      if (!b) return;
      var id = b.getAttribute('data-modifica') || b.getAttribute('data-password');
      var u = utenti.filter(function (x) { return x.id === id; })[0];
      if (!u) return;
      if (b.hasAttribute('data-modifica')) modificaUtente(u); else nuovaPassword(u);
    });
    carica();
  };

  /* ======================= ATTIVITÀ (registro attività) ======================= */

  // gruppi di azioni del registro (il server filtra per inizio del codice)
  var GRUPPI_AZIONI = [
    { codice: 'accesso', testo: 'Accessi e uscite' },
    { codice: 'movimenti', testo: 'Movimenti' },
    { codice: 'registro', testo: 'Correzioni del registro mensile' },
    { codice: 'articoli', testo: 'Articoli' },
    { codice: 'utenti', testo: 'Utenti' },
    { codice: 'impostazioni', testo: 'Impostazioni' },
    { codice: 'reparti', testo: 'Reparti' },
    { codice: 'backup', testo: 'Copie di sicurezza' },
    { codice: 'archivio', testo: 'Archivio' }
  ];

  var NOMI_AZIONI = {
    'accesso.entrata': 'Accesso',
    'accesso.uscita': 'Uscita',
    'accesso.fallito': 'Accesso non riuscito',
    'accesso.bloccato-ip': 'Accesso bloccato (troppi tentativi)',
    'accesso.cambio-password': 'Cambio password',
    'movimenti.registra': 'Registrazione movimenti',
    'movimenti.annulla': 'Annullo movimento',
    'registro.consumo-giorno': 'Correzione nel registro mensile',
    'articoli.crea': 'Nuovo articolo',
    'articoli.modifica': 'Modifica articolo',
    'articoli.elimina': 'Eliminazione articolo',
    'articoli.importa': 'Importazione articoli',
    'articoli.barcode': 'Codice a barre associato',
    'impostazioni.modifica': 'Modifica impostazioni',
    'reparti.modifica': 'Modifica reparti',
    'reparti.elimina': 'Eliminazione reparto',
    'utenti.crea': 'Nuovo utente',
    'utenti.primo-amministratore': 'Primo amministratore',
    'utenti.modifica': 'Modifica utente',
    'utenti.nuova-password': 'Nuova password provvisoria',
    'backup.crea': 'Copia di sicurezza creata',
    'backup.scarica': 'Copia di sicurezza scaricata',
    'backup.ripristina': 'Copia di sicurezza ripristinata',
    'archivio.dati-di-prova': 'Dati di prova',
    'archivio.importa-versione-singola': 'Importazione archivio (versione per un solo PC)'
  };

  function nomeAzione(a) {
    if (NOMI_AZIONI[a]) return NOMI_AZIONI[a];
    var t = String(a || '').replace(/[._-]+/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  var ETICHETTE = {
    tipo: 'tipo', data: 'data', articolo: 'articolo', articoloId: 'articolo', reparto: 'reparto', repartoId: 'reparto',
    verso: 'verso', repartoDestId: 'verso', quantita: 'quantità', lotto: 'lotto', scadenza: 'scadenza', motivo: 'motivo',
    utente: 'utente', nome: 'nome', ruolo: 'ruolo', reparti: 'reparti', attivo: 'attivo', categoria: 'categoria',
    origine: 'da', righe: 'righe', nuovi: 'nuovi', carichi: 'carichi', registratoDa: 'registrato da', prima: 'prima',
    dopo: 'dopo', cambi: 'cambi', articoli: 'articoli', movimenti: 'movimenti', scartati: 'scartati', copia: 'copia',
    copiaDiSicurezza: 'copia dello stato precedente', sicurezza: 'copia di sicurezza', prezzo: 'prezzo', scortaMinima: 'scorta minima', testo: ''
  };

  // valore leggibile: id di reparti e articoli diventano nomi, tipi e ruoli in italiano
  function descriviValore(chiave, v, profondita) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'boolean') return v ? 'sì' : 'no';
    if ((chiave === 'reparto' || chiave === 'repartoId' || chiave === 'verso' || chiave === 'repartoDestId') && typeof v === 'string') {
      var r = App.S && App.reparto(v);
      return r ? r.nome : v;
    }
    if (chiave === 'articoloId' && typeof v === 'string') return App.S ? App.nomeArticolo(v) : v;
    if (chiave === 'reparti' && Array.isArray(v)) {
      if (!v.length) return 'nessuno';
      return v.map(function (x) {
        // elenco di codici (utenti) oppure di reparti salvati da Configura ({ id, nome, centrale, attivo, nuovo })
        if (x && typeof x === 'object') {
          return (x.nome || x.id) + (x.nuovo ? ' (nuovo)' : '') + (x.centrale ? ' (centrale)' : '') + (x.attivo === false ? ' (non attivo)' : '');
        }
        var r = App.S && App.reparto(x);
        return r ? r.nome : x;
      }).join(', ');
    }
    if (chiave === 'tipo' && App.TIPI[v]) return App.TIPI[v];
    if (chiave === 'ruolo' && App.RUOLI[v]) return App.RUOLI[v];
    if (chiave === 'data' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return App.fmtData(v);
    if (chiave === 'scadenza' && typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)) return App.fmtScadenza(v);
    if (typeof v === 'number') return App.fmtNum(v);
    if (Array.isArray(v)) {
      if (!v.length) return 'nessuno';
      var max = 5;
      var parti = v.slice(0, max).map(function (x) { return descriviDettagli(x, profondita + 1); });
      return parti.join('; ') + (v.length > max ? '; e altri ' + (v.length - max) : '');
    }
    if (typeof v === 'object') return '(' + descriviDettagli(v, profondita + 1) + ')';
    return String(v);
  }

  function descriviDettagli(d, profondita) {
    profondita = profondita || 0;
    if (d === null || d === undefined || d === '') return '';
    if (typeof d === 'string') {
      try { return descriviDettagli(JSON.parse(d), profondita); } catch (e) { return d; }
    }
    if (typeof d !== 'object') return String(d);
    if (Array.isArray(d)) return descriviValore('', d, profondita);
    if (profondita > 3) return JSON.stringify(d);
    // un movimento: "Consumo 3 PARACETAMOLO · Degenza · 12/10/2026"
    if (d.tipo && App.TIPI[d.tipo] && d.quantita !== undefined) {
      var art = d.articolo || (d.articoloId ? descriviValore('articoloId', d.articoloId) : '');
      var rep = descriviValore('reparto', d.reparto || d.repartoId);
      var verso = d.verso || d.repartoDestId;
      return App.TIPI[d.tipo] + ' ' + App.fmtNum(d.quantita) + ' ' + art + ' · ' + rep + (verso ? ' → ' + descriviValore('verso', verso) : '') +
        (d.data ? ' · ' + App.fmtData(d.data) : '') + (d.lotto ? ' · lotto ' + d.lotto : '') + (d.motivo ? ' · motivo: ' + d.motivo : '') +
        (d.registratoDa ? ' · registrato da ' + d.registratoDa : '');
    }
    return Object.keys(d).filter(function (k) {
      if (d[k] === undefined) return false;
      // i reparti contano solo per il ruolo "reparto"
      if (k === 'reparti' && d.ruolo && d.ruolo !== 'reparto') return false;
      return true;
    }).map(function (k) {
      var etichetta = ETICHETTE[k] !== undefined ? ETICHETTE[k] : k;
      var v = descriviValore(k, d[k], profondita);
      return etichetta ? etichetta + ': ' + v : v;
    }).join(' · ');
  }

  var memoriaAttivita = {};
  App.dimenticaAttivita = function () { memoriaAttivita = {}; };

  P.attivita = function (cont) {
    var oggi = App.oggi();
    var settimanaFa = (function () {
      var d = new Date();
      d.setDate(d.getDate() - 7);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    // le date scelte valgono per la giornata: il giorno dopo si riparte dall'ultima settimana
    if (memoriaAttivita.sceltaIl !== oggi) memoriaAttivita = {};
    var m0 = memoriaAttivita;
    cont.innerHTML =
      '<div class="strumenti">' +
      '<label class="campo"><span>Dal</span><input type="date" id="t-dal" value="' + h(m0.dal || settimanaFa) + '"></label>' +
      '<label class="campo"><span>Al</span><input type="date" id="t-al" value="' + h(m0.al || oggi) + '"></label>' +
      '<label class="campo"><span>Utente</span><input id="t-utente" list="dl-utenti-attivita" placeholder="Tutti" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + h(m0.utente || '') + '"></label>' +
      '<datalist id="dl-utenti-attivita"></datalist>' +
      '<label class="campo"><span>Azione</span><select id="t-azione"><option value="">Tutte</option>' +
      GRUPPI_AZIONI.map(function (g) { return '<option value="' + g.codice + '"' + (m0.azione === g.codice ? ' selected' : '') + '>' + h(g.testo) + '</option>'; }).join('') +
      '</select></label>' +
      '<span class="spazio"></span><button class="btn" type="button" id="t-aggiorna">Aggiorna</button><button class="btn" type="button" id="t-excel">Excel</button>' +
      '</div><div id="t-tab">' + scheda('Registro attività', '<p class="vuoto">Carico…</p>', '', true) + '</div>';

    var LIMITE = 2000;
    var eventi = [];
    var utentiVisti = {};
    var richiestaN = 0;

    function filtri() {
      memoriaAttivita = { dal: valore(cont, '#t-dal'), al: valore(cont, '#t-al'), utente: valore(cont, '#t-utente').trim(), azione: valore(cont, '#t-azione'), sceltaIl: App.oggi() };
      return memoriaAttivita;
    }

    function disegna() {
      var f = memoriaAttivita;
      cont.querySelector('#t-tab').innerHTML = scheda('Registro attività' + (f.dal || f.al ? ' · ' + (f.dal ? 'dal ' + App.fmtData(f.dal) : '') + (f.al ? ' al ' + App.fmtData(f.al) : '') : ''),
        eventi.length ? '<div class="tabella-contenitore"><table class="tabella attivita"><thead><tr><th>Quando</th><th>Utente</th><th>Azione</th><th>Dettagli</th><th>Indirizzo IP</th></tr></thead><tbody>' +
          eventi.map(function (e) {
            var pericolo = /fallito|bloccato/.test(e.azione);
            return '<tr><td class="piccolo" style="white-space:nowrap">' + h(App.fmtDataOra(e.quando)) + '</td><td class="mono">' + h(e.username || '—') + '</td>' +
              '<td' + (pericolo ? ' style="color:var(--pericolo);font-weight:600"' : '') + '>' + h(nomeAzione(e.azione)) + '</td>' +
              '<td class="piccolo dettagli">' + h(descriviDettagli(e.dettagli)) + '</td><td class="mono tenue">' + h(e.ip || '') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
          : vuoto('Nessuna attività', 'Cambia le date o i filtri.'),
        '<span class="nota">' + eventi.length + ' eventi' + (eventi.length >= LIMITE ? ' (i più recenti: restringi le date)' : '') + '</span>', true);
    }

    function carica() {
      var f = filtri();
      var q = ['limite=' + LIMITE];
      // dal e al come giorni (AAAA-MM-GG): il server li legge nell'ora locale e comprende tutto il giorno "al"
      if (f.dal) q.push('dal=' + encodeURIComponent(f.dal));
      if (f.al) q.push('al=' + encodeURIComponent(f.al));
      if (f.utente) q.push('utente=' + encodeURIComponent(f.utente));
      if (f.azione) q.push('azione=' + encodeURIComponent(f.azione));
      var n = ++richiestaN;
      return Api.richiesta('GET', '/api/attivita?' + q.join('&')).then(function (r) {
        if (n !== richiestaN || !document.body.contains(cont)) return; // è arrivata una richiesta più nuova
        eventi = (r && r.eventi) || [];
        eventi.forEach(function (e) { if (e.username) utentiVisti[e.username] = true; });
        var dl = cont.querySelector('#dl-utenti-attivita');
        if (dl) dl.innerHTML = Object.keys(utentiVisti).sort().map(function (u) { return '<option value="' + h(u) + '">'; }).join('');
        disegna();
      }, function (e) {
        if (n !== richiestaN || !document.body.contains(cont)) return;
        cont.querySelector('#t-tab').innerHTML = scheda('Registro attività', '<div class="banda pericolo" style="margin:14px"><p>Non riesco a leggere il registro attività: ' + h(messaggioErrore(e)) + '</p></div>', '', true);
      });
    }

    var attesa = null;
    cont.querySelectorAll('#t-dal, #t-al, #t-azione').forEach(function (el) { el.addEventListener('change', carica); });
    cont.querySelector('#t-utente').addEventListener('input', function () {
      clearTimeout(attesa);
      attesa = setTimeout(carica, 400);
    });
    cont.querySelector('#t-aggiorna').addEventListener('click', carica);
    cont.querySelector('#t-excel').addEventListener('click', function () {
      if (!eventi.length) { App.avviso('Non ci sono eventi da esportare.', 'errore'); return; }
      var col = [{ titolo: 'Quando', larghezza: 18 }, { titolo: 'Utente', larghezza: 16 }, { titolo: 'Azione', larghezza: 30 },
        { titolo: 'Dettagli', larghezza: 90 }, { titolo: 'Indirizzo IP', larghezza: 16 }];
      var righe = eventi.map(function (e) {
        return [App.fmtDataOra(e.quando), e.username || '', nomeAzione(e.azione), descriviDettagli(e.dettagli), e.ip || ''];
      });
      var f = memoriaAttivita;
      root.ExcelFarmacia.esportaElenco('Attività', col, righe).then(function (b) {
        App.scarica(b, 'Registro_attivita_' + (f.dal || '') + '_' + (f.al || '') + '.xlsx');
      });
    });
    // ogni modifica dei dati scrive nel registro: quando altri utenti lavorano, ricarico con gli stessi filtri
    App.rinfresca = carica;
    carica();
  };
})(this);
