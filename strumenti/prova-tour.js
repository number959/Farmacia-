/*
 * Prova della guida sullo schermo ("Guidami", js/tour.js) sul server vero, con Playwright e Chromium.
 *
 *   node strumenti/prova-tour.js [--foto <cartella>] [--solo amministratore,reparto] [--schermi desktop,telefono] [--exe <eseguibile>]
 *                                [--senza-vuoto]
 *
 * Avvia un server di prova (porta libera, dati in una cartella temporanea), crea l'amministratore, carica i dati di prova
 * e crea un utente per ogni ruolo. Poi, con l'API, prepara quello che serve ai giri della 3.0: armadi con le ubicazioni
 * e assortimenti con le scorte (farmacia e Degenza), richieste in ogni stato (bozza, inviata, in lavorazione con DDT da
 * spedire, con DDT in viaggio, evasa con un DDT ricevuto con differenze), un DDT di reso da spedire dalla Degenza,
 * due consumi di stamattina (amministratore e responsabile di magazzino: c'è sempre un movimento da poter annullare),
 * un utente con la verifica in due passaggi attiva e una copia di sicurezza verificata; lo storico dei consumi per le
 * previsioni è quello dei dati di prova (circa cinque mesi). Per ogni ruolo, a 1440×900 e a 390×800 (telefono):
 * - l'invito al primo accesso (Sì / Non ora / Non chiedere più, ricordato nel browser per utente);
 * - l'elenco dei giri segue i permessi; il pulsante 🧭 Guidami avvia il giro della pagina o apre l'elenco; su ogni
 *   pagina permessa (computer) Guidami avvia il giro di quella pagina, anche sulle viste (modulo di una richiesta);
 * - percorre TUTTI i giri passo per passo: ogni elemento evidenziato esiste, è visibile e non è coperto
 *   (sul telefono i passi sul menu aprono il menu), il riquadro luminoso è sull'elemento, il fumetto sta nello schermo
 *   e non copre l'elemento; tastiera (frecce, Invio, Esc), pulsanti Indietro / Avanti / Fine; finita il giro, menu
 *   dell'utente, finestre e modalità Disponi aperti dal giro sono di nuovo chiusi;
 * - Indietro e Avanti in fretta mentre la pagina scorre ancora (amministratore, computer, con le animazioni): l'elemento
 *   del passo finisce comunque in vista;
 * - con righe scritte e non registrate un giro che cambia pagina chiede prima; il giro della pagina non le tocca;
 *   una finestra con dati scritti non si chiude (Guidami raggiunto con Tab);
 * - casi limite (amministratore): il fuoco torna su Guidami anche partendo dall'elenco; finestra ristretta durante il
 *   passo sul menu e rotazione del telefono (l'elemento resta evidenziato); sessione scaduta con il giro o l'elenco
 *   aperti (si chiudono e non rubano il fuoco al campo password); sul telefono l'invito non copre il menu aperto;
 * - nessun giro scrive dati (nessuna richiesta POST/PUT/DELETE, revisione dei dati invariata), niente errori JS o CSP;
 * - archivio vuoto (secondo server, installazione nuova; si salta con --senza-vuoto o con --solo senza l'amministratore):
 *   tutti i giri dell'amministratore arrivano a "Fine" e ogni passo obbligatorio trova il suo elemento.
 * I passi facoltativi saltati (per esempio la barra del lettore se non c'è ancora) sono elencati, non sono errori.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');
const Calcoli = require('../js/calcoli.js');
const Totp = require('../js/totp.js');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const FOTO = arg('--foto');
const ESEGUIBILE = arg('--exe');
const SOLO = arg('--solo') ? arg('--solo').split(',') : null;
const SOLO_SCHERMI = arg('--schermi') ? arg('--schermi').split(',') : null;
const SENZA_VUOTO = process.argv.includes('--senza-vuoto');
const PW = 'Password-123';
const PROVVISORIA = 'Provvisoria1';

const RUOLI = [
  { ruolo: 'amministratore', username: 'admin', nome: 'Anna Amministratrice' },
  { ruolo: 'farmacista', username: 'farma', nome: 'Maria Farmacista', reparti: [] },
  { ruolo: 'reparto', username: 'deg', nome: 'Luca Infermiere', reparti: ['r-degenza'] },
  { ruolo: 'consultazione', username: 'dir', nome: 'Direzione Sanitaria', reparti: [] }
].filter((r) => !SOLO || SOLO.includes(r.ruolo));

const SCHERMI = [
  { nome: 'desktop', opz: { viewport: { width: 1440, height: 900 } } },
  { nome: 'telefono', opz: { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } }
].filter((s) => !SOLO_SCHERMI || SOLO_SCHERMI.includes(s.nome));

let esito = 0;
let contaOk = 0;
function ok(cond, testo) {
  if (cond) { contaOk++; if (process.env.GF_DETTAGLI) console.log('OK      ' + testo); }
  else { console.log('ERRORE  ' + testo); esito = 1; }
  return cond;
}
function nota(testo) { console.log('        ' + testo); }

function portaLibera() {
  return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

async function attendi(cond, ms) {
  const fine = Date.now() + (ms || 8000);
  while (Date.now() < fine) {
    const v = await cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

/* ---------- piccolo client dell'API dal processo di prova (con il suo cookie) ---------- */
function clienteApi(base) {
  let cookie = '';
  return async function (metodo, percorso, corpo) {
    const r = await fetch(base + percorso.replace(/^\//, ''), {
      method: metodo,
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Richiesta': '1' }, cookie ? { Cookie: cookie } : {}),
      body: corpo === undefined ? undefined : JSON.stringify(corpo)
    });
    const c = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    c.forEach((x) => { const m = /^(gf_sessione=[^;]*)/.exec(x); if (m) cookie = m[1]; });
    const testo = await r.text();
    let dati = null;
    try { dati = JSON.parse(testo); } catch (e) { dati = testo; }
    if (!r.ok) throw new Error(metodo + ' ' + percorso + ' → ' + r.status + ' ' + (dati && dati.errore || testo));
    return dati;
  };
}

/*
 * Dati della 3.0 per i giri (con l'API, come farebbero gli utenti): armadi e ubicazioni, assortimenti con le scorte,
 * richieste e DDT in ogni stato, un utente con la verifica in due passaggi, una copia verificata.
 * Restituisce un piccolo riassunto (per il resoconto della prova).
 */
async function preparaDati(admin, base, clienti) {
  const FARMACIA = 'r-farmacia', DEGENZA = 'r-degenza';
  const stato = await admin('GET', '/api/dati?da=0');
  const giac = Calcoli.tutteLeGiacenze(stato);
  const g = (art, rep) => giac[art + '|' + rep] || 0;
  const attivi = stato.articoli.filter((a) => a.attivo !== false);
  // articoli con abbastanza merce in un magazzino (dal più presente), per richieste e DDT che vanno a buon fine
  const conMerce = (rep, min) => attivi.filter((a) => g(a.id, rep) >= min).sort((x, y) => g(y.id, rep) - g(x.id, rep));

  /* --- armadi --- */
  const armadio = async (repartoId, nome, tipo, ripiani, colonne) => (await admin('POST', '/api/armadi', { repartoId, nome, tipo, ripiani, colonne })).armadio;
  const armF = await armadio(FARMACIA, 'Armadio farmaci', 'armadio', 4, 6);
  await armadio(FARMACIA, 'Frigorifero', 'frigorifero', 3, 4);
  await armadio(FARMACIA, 'Cassaforte stupefacenti', 'cassaforte', 2, 3);
  const armD = await armadio(DEGENZA, 'Armadio di reparto', 'armadio', 4, 5);
  await armadio(DEGENZA, 'Carrello delle urgenze', 'carrello', 3, 4);

  /* --- assortimento con le scorte: qualcuno sotto scorta, qualcuno da riordinare, gli altri in ordine --- */
  const assortimento = async (rep, quanti) => {
    const scelti = attivi.filter((a) => g(a.id, rep) > 0).slice(0, quanti);
    const righe = scelti.map((a, i) => {
      const q = Math.max(4, Math.round(g(a.id, rep)));
      const min = i % 4 === 0 ? q + 5 : Math.max(1, Math.round(q * 0.3));   // uno su quattro sotto scorta
      const riordino = i % 4 === 1 ? q + 2 : Math.max(min, Math.round(q * 0.6)); // uno su quattro da riordinare
      return { articoloId: a.id, scortaMin: min, puntoRiordino: Math.max(min, riordino), scortaMax: Math.max(riordino, min, q) * 2 };
    });
    await admin('PUT', '/api/assortimento', { repartoId: rep, righe });
    return scelti;
  };
  const assF = await assortimento(FARMACIA, 16);
  const assD = await assortimento(DEGENZA, 12);

  /* --- ubicazioni: quasi tutti al loro posto, gli ultimi tre ancora da disporre --- */
  const ubica = async (rep, arm, articoli) => {
    const righe = articoli.slice(0, Math.max(0, articoli.length - 3)).map((a, i) => ({
      articoloId: a.id, armadioId: arm.id, ripiano: Math.floor(i / arm.colonne) + 1, posizione: (i % arm.colonne) + 1
    })).filter((x) => x.ripiano <= arm.ripiani);
    await admin('PUT', '/api/ubicazioni', { repartoId: rep, righe });
  };
  await ubica(FARMACIA, armF, assF);
  await ubica(DEGENZA, armD, assD);

  /* --- richieste e DDT (dalla Degenza alla farmacia centrale) --- */
  const merceF = conMerce(FARMACIA, 30);
  if (merceF.length < 12) throw new Error('dati di prova: poca merce in farmacia per le richieste (' + merceF.length + ' articoli)');
  const righe = (da, n, q) => merceF.slice(da, da + n).map((a, i) => ({ articoloId: a.id, quantita: q + i }));
  const richiesta = (corpo) => admin('POST', '/api/richieste', Object.assign({ repartoId: DEGENZA, fornitoreId: FARMACIA }, corpo));
  await richiesta({ righe: righe(0, 2, 3), note: 'Da completare prima dell’invio', invia: false });                 // bozza
  await richiesta({ righe: righe(2, 3, 4), urgente: true, note: 'Nuovi ingressi in reparto', invia: true });     // inviata, urgente
  const daSpedire = await richiesta({ righe: righe(5, 2, 2), invia: true });
  await admin('POST', '/api/richieste/' + daSpedire.richiesta.id + '/ddt', {});                                     // DDT da spedire
  const inViaggio = await richiesta({ righe: righe(7, 2, 2), invia: true });
  const ddtViaggio = await admin('POST', '/api/richieste/' + inViaggio.richiesta.id + '/ddt', {});
  await admin('POST', '/api/ddt/' + ddtViaggio.ddt.id + '/spedisci', { trasportatoreNome: 'Giuseppe Esposito', colli: 2 }); // in viaggio
  const evasa = await richiesta({ righe: righe(9, 3, 2), invia: true });
  const ddtRic = await admin('POST', '/api/richieste/' + evasa.richiesta.id + '/ddt', {});
  await admin('POST', '/api/ddt/' + ddtRic.ddt.id + '/spedisci', { trasportatoreNome: 'Giuseppe Esposito' });
  await admin('POST', '/api/ddt/' + ddtRic.ddt.id + '/ricevi', {                                                      // ricevuto con differenze
    righe: ddtRic.righe.map((r, i) => ({ id: r.id, ricevuta: i === 0 ? Math.max(0, r.quantita - 1) : r.quantita, esito: i === 0 ? 'rientro' : '', nota: i === 0 ? 'Una confezione rotta' : '' })),
    note: 'Consegnata alle 15:20'
  });
  // un reso dalla Degenza alla farmacia, preparato e da spedire (il responsabile di magazzino vede «Da preparare»)
  const merceD = conMerce(DEGENZA, 4);
  if (merceD.length) {
    await admin('POST', '/api/ddt', { origineId: DEGENZA, destinazioneId: FARMACIA, causale: 'Reso alla farmacia', colli: 1,
      righe: [{ articoloId: merceD[0].id, quantita: 2 }] });
  }

  /* --- consumi di stamattina in Degenza, uno dell'amministratore e uno del responsabile di magazzino: nella pagina
         Movimenti (dal primo del mese a oggi) ognuno ha un movimento da poter annullare, anche il primo del mese --- */
  const d = new Date();
  const oggi = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const consumo = (cliente, articoloId) => cliente('POST', '/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi, articoloId, repartoId: DEGENZA, quantita: 1, note: 'Prova dei giri' }] });
  const perConsumi = conMerce(DEGENZA, 6).slice(1, 3);
  if (perConsumi[0]) await consumo(admin, perConsumi[0].id);
  if (perConsumi[1] && clienti.deg) await consumo(clienti.deg, perConsumi[1].id);

  /* --- un utente con la verifica in due passaggi attiva (la pagina Sicurezza mostra «Azzera») --- */
  await admin('POST', '/api/utenti', { username: 'tecnico', nome: 'Paolo Tecnico', ruolo: 'farmacista', reparti: [], password: PROVVISORIA });
  const t = clienteApi(base);
  await t('POST', '/api/login', { username: 'tecnico', password: PROVVISORIA });
  await t('POST', '/api/password', { attuale: PROVVISORIA, nuova: PW });
  const inizio = await t('POST', '/api/2fa/inizia', {});
  await t('POST', '/api/2fa/conferma', { codice: Totp.totp(inizio.segretoBase32, Date.now()) });

  /* --- una copia di sicurezza verificata (pagina Sistema) --- */
  await admin('POST', '/api/sistema/copia', {});
  return { assF: assF.length, assD: assD.length, articoliConMerce: merceF.length };
}

/* ---------- controlli dentro la pagina ---------- */

// Fotografia del passo mostrato: elemento evidenziato, riquadro luminoso, fumetto, menu.
function leggiPasso() {
  const s = window.Tour.stato();
  if (!s.attivo) return { s };
  // la parte di pagina che si vede davvero (sul telefono può essere più piccola della finestra dei position: fixed)
  const vv = window.visualViewport;
  const X0 = vv ? vv.offsetLeft : 0, Y0 = vv ? vv.offsetTop : 0;
  const W = vv ? vv.width : document.documentElement.clientWidth;
  const H = vv ? vv.height : window.innerHeight;
  const bersagli = window.Tour.bersagli();
  const app = document.getElementById('app');
  const testa = document.querySelector('.testa-fissa').getBoundingClientRect().bottom;
  const tour = document.querySelector('.tour');
  // rettangoli misurati dalla parte visibile
  const r2o = (r) => ({ l: r.left - X0, t: r.top - Y0, r: r.right - X0, b: r.bottom - Y0, w: r.width, h: r.height });
  let unione = null;
  bersagli.forEach((e) => {
    const b = r2o(e.getBoundingClientRect());
    if (!unione) unione = { l: b.l, t: b.t, r: b.r, b: b.b };
    else { unione.l = Math.min(unione.l, b.l); unione.t = Math.min(unione.t, b.t); unione.r = Math.max(unione.r, b.r); unione.b = Math.max(unione.b, b.b); }
  });
  // l'elemento è davvero visibile? rendo un attimo il giro "trasparente ai clic" (visibility: hidden, che non fa
  // ripartire le animazioni come display: none) e guardo cosa c'è al centro della parte visibile dell'elemento
  // (nello stesso compito JavaScript: lo schermo non si ridisegna, niente sfarfallio)
  const prove = [];
  tour.style.visibility = 'hidden';
  try {
    bersagli.forEach((e) => {
      const b = e.getBoundingClientRect();
      const fisso = !!e.closest('.testa-fissa, .laterale, #modale');
      const l = Math.max(b.left, X0), r = Math.min(b.right, X0 + W);
      const t = Math.max(b.top, Y0, fisso ? Y0 : testa), bb = Math.min(b.bottom, Y0 + H);
      if (r - l < 2 || bb - t < 2) { prove.push({ visibile: false, motivo: 'fuori dallo schermo o sotto la barra' }); return; }
      const x = (l + r) / 2, y = (t + bb) / 2;
      const colpito = document.elementFromPoint(x, y);
      const giusto = !!colpito && (e === colpito || e.contains(colpito) || colpito.contains(e) || (colpito.tagName === 'LABEL' && colpito.control === e));
      prove.push({ visibile: giusto, motivo: giusto ? '' : 'coperto da ' + (colpito ? colpito.tagName.toLowerCase() + (colpito.id ? '#' + colpito.id : '') + (colpito.className && typeof colpito.className === 'string' ? '.' + colpito.className.split(' ').join('.') : '') : 'niente') });
    });
  } finally { tour.style.visibility = ''; }
  const fum = document.querySelector('.tour-fumetto');
  // il pulsante Avanti si può davvero premere (niente sopra di lui)
  const av = fum.querySelector('[data-tour="avanti"]').getBoundingClientRect();
  const sopraAv = document.elementFromPoint(av.left + av.width / 2, av.top + av.height / 2);
  return {
    avantiPremibile: !!sopraAv && !!sopraAv.closest('[data-tour="avanti"]'),
    s,
    W, H,
    n: bersagli.length,
    connessi: bersagli.every((e) => e.isConnected),
    prove,
    nelMenu: bersagli.some((e) => !!e.closest('#laterale')),
    menuAperto: app.classList.contains('menu-aperto'),
    unione,
    luce: r2o(document.querySelector('.tour-luce').getBoundingClientRect()),
    luceVuota: document.querySelector('.tour-luce').classList.contains('vuota'),
    fumetto: r2o(fum.getBoundingClientRect()),
    lato: fum.getAttribute('data-lato'),
    conta: document.querySelector('.tour-conta').textContent,
    titolo: document.getElementById('tour-titolo').textContent,
    fuocoNelFumetto: fum.contains(document.activeElement),
    // il fumetto ha finito di comparire (animazione d'entrata) ed è del tutto opaco
    opaco: getComputedStyle(fum).opacity === '1' && getComputedStyle(tour).opacity === '1' && fum.getAnimations().length === 0,
    larghezzaPagina: document.documentElement.scrollWidth,
    // anche la vista del telefono (visual viewport) non deve spostarsi di lato
    scrollX: window.scrollX + (window.visualViewport ? Math.round(window.visualViewport.offsetLeft) : 0)
  };
}

/*
 * Archivio vuoto (installazione nuova, nessun dato di prova): per l'amministratore, che vede tutti i giri, ogni giro
 * parte e arriva a "Fine"; i passi obbligatori trovano il loro elemento (quelli su dati che possono mancare sono
 * facoltativi e si saltano); niente scritture e niente errori. Un server a parte, con una cartella dati vuota.
 */
async function provaArchivioVuoto(browser, errori) {
  const porta = await portaLibera();
  const dati = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-tour-vuoto-'));
  const proc = ESEGUIBILE
    ? spawn(ESEGUIBILE, ['--porta', String(porta), '--dati', dati], { stdio: 'ignore' })
    : spawn(process.execPath, [path.join(__dirname, '..', 'server', 'main.js'), '--porta', String(porta), '--dati', dati], { stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + porta + '/';
  try {
    if (!ok(!!(await attendi(async () => { try { return (await fetch(base + 'api/stato')).ok; } catch (e) { return false; } }, 20000)), 'archivio vuoto: il secondo server di prova risponde')) return;
    await clienteApi(base)('POST', '/api/setup', { username: 'admin', nome: 'Anna Amministratrice', password: PW });
    for (const schermo of SCHERMI) {
      const chi = 'archivio vuoto · ' + schermo.nome;
      const t0 = Date.now();
      const ctx = await browser.newContext(Object.assign({ locale: 'it-IT', reducedMotion: 'reduce' }, schermo.opz));
      const p = await ctx.newPage();
      p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errori.push(chi + ': ' + m.text()); });
      p.on('pageerror', (e) => errori.push(chi + ' (eccezione): ' + e.message));
      const scritture = [];
      let inGiro = false;
      p.on('request', (r) => { if (inGiro && r.method() !== 'GET' && r.method() !== 'HEAD') scritture.push(r.method() + ' ' + r.url()); });
      await p.goto(base);
      await p.waitForSelector('#acc-form');
      await p.fill('#acc-user', 'admin');
      await p.fill('#acc-pw', PW);
      await p.click('#acc-invia');
      await p.waitForSelector('#app:not([hidden])', { timeout: 15000 });
      await p.waitForSelector('.tour-invito', { timeout: 5000 }).catch(() => null);
      await p.evaluate(() => { const b = document.querySelector('.tour-invito [data-invito="mai"]'); if (b) b.click(); });
      ok(await p.evaluate(() => App.archivioVuoto()), chi + ': l’archivio è davvero vuoto');
      const giri = await p.evaluate(() => Tour.elenco().map((g) => g.id));
      const senza = [];
      inGiro = true;
      for (const id of giri) {
        await p.evaluate(() => { location.hash = '#guida'; });
        await attendi(async () => (await p.evaluate(() => App.paginaCorrente)) === 'guida', 3000);
        if (!ok((await p.evaluate((x) => Tour.avvia(x), id)) === true, chi + ': giro "' + id + '" avviato')) continue;
        let ultimo = null;
        for (let k = 0; k < 60; k++) {
          const s = await attendi(() => p.evaluate(() => { const x = Tour.stato(); return x.attivo && !x.inAttesa ? x : null; }), 9000);
          if (!ok(!!s, chi + ' · ' + id + ': passo pronto entro il tempo')) break;
          if (s.conElemento && s.centrato) senza.push(id + ' ' + s.indice + '/' + s.totale + ' "' + s.titolo + '" (' + s.selettore + ')');
          ultimo = s;
          if (s.indice === s.totale) break;
          await p.evaluate(() => document.querySelector('.tour-fumetto [data-tour="avanti"]').click());
          await attendi(() => p.evaluate((i) => { const x = Tour.stato(); return !x.attivo || x.inAttesa || x.indice !== i; }, s.indice), 4000);
        }
        if (!ultimo) { await p.evaluate(() => Tour.ferma()); continue; }
        ok(ultimo.indice === ultimo.totale && /Fine/.test(await p.textContent('.tour-fumetto [data-tour="avanti"]')), chi + ' · ' + id + ': arriva all’ultimo passo, con "Fine"');
        await p.evaluate(() => document.querySelector('.tour-fumetto [data-tour="avanti"]').click());
        await attendi(async () => !(await p.evaluate(() => Tour.stato().attivo)), 3000);
        ok(await p.evaluate(() => !Tour.stato().attivo && document.getElementById('modale').hidden), chi + ' · ' + id + ': "Fine" chiude il giro, niente resta aperto');
      }
      inGiro = false;
      ok(senza.length === 0, chi + ': ogni passo obbligatorio trova il suo elemento' + (senza.length ? ':\n  ' + senza.join('\n  ') : ''));
      ok(scritture.length === 0, chi + ': i giri non hanno fatto nessuna scrittura' + (scritture.length ? ' (' + scritture.join(', ') + ')' : ''));
      nota(chi + ': ' + giri.length + ' giri in ' + Math.round((Date.now() - t0) / 1000) + ' s');
      await ctx.close();
    }
  } finally {
    const uscito = new Promise((fatto) => { if (proc.exitCode !== null) fatto(); else { proc.once('exit', fatto); setTimeout(fatto, 10000); } });
    proc.kill('SIGTERM');
    await uscito;
    try { fs.rmSync(dati, { recursive: true, force: true }); } catch (e) { nota('cartella temporanea non tolta: ' + dati); }
  }
}

(async () => {
  const porta = await portaLibera();
  const dati = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-tour-'));
  const proc = ESEGUIBILE
    ? spawn(ESEGUIBILE, ['--porta', String(porta), '--dati', dati], { stdio: 'ignore' })
    : spawn(process.execPath, [path.join(__dirname, '..', 'server', 'main.js'), '--porta', String(porta), '--dati', dati], { stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + porta + '/';
  const pronto = await attendi(async () => { try { return (await fetch(base + 'api/stato')).ok; } catch (e) { return false; } }, 20000);
  if (!pronto) { console.log('ERRORE  il server di prova non risponde'); proc.kill('SIGTERM'); process.exit(1); }
  if (FOTO) fs.mkdirSync(FOTO, { recursive: true });

  const browser = await chromium.launch();
  const errori = [];
  const inizio = Date.now();
  const saltatiTotali = {};
  const pagineLarghe = new Set();

  try {
    /* ---------- dati e utenti di prova ---------- */
    const admin = clienteApi(base);
    await admin('POST', '/api/setup', { username: 'admin', nome: 'Anna Amministratrice', password: PW });
    await admin('POST', '/api/demo', {});
    const clienti = {};
    for (const u of RUOLI.filter((x) => x.ruolo !== 'amministratore')) {
      await admin('POST', '/api/utenti', { username: u.username, nome: u.nome, ruolo: u.ruolo, reparti: u.reparti, password: PROVVISORIA });
      const c = clienteApi(base);
      await c('POST', '/api/login', { username: u.username, password: PROVVISORIA });
      await c('POST', '/api/password', { attuale: PROVVISORIA, nuova: PW });
      clienti[u.username] = c;
    }
    const preparati = await preparaDati(admin, base, clienti);
    const revDati = async () => (await admin('GET', '/api/dati?da=0')).rev;
    const rev0 = await revDati();
    ok(true, 'server di prova con dati di prova, un utente per ruolo, armadi, assortimenti (' + preparati.assF + ' + ' + preparati.assD +
      ' articoli), richieste e DDT in ogni stato, verifica in due passaggi e una copia');

    for (const schermo of SCHERMI) {
      for (const u of RUOLI) {
        const chi = schermo.nome + ' · ' + u.ruolo;
        const t0 = Date.now();
        // movimento ridotto (niente scorrimenti morbidi) tranne per l'amministratore sul desktop, che prova anche le animazioni
        const animato = schermo.nome === 'desktop' && u.ruolo === 'amministratore';
        const ctx = await browser.newContext(Object.assign({ locale: 'it-IT', reducedMotion: animato ? 'no-preference' : 'reduce' }, schermo.opz));
        const p = await ctx.newPage();
        p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errori.push(chi + ': ' + m.text()); });
        p.on('pageerror', (e) => errori.push(chi + ' (eccezione): ' + e.message));
        let inGiro = false;
        const scritture = [];
        p.on('request', (r) => { if (inGiro && r.method() !== 'GET' && r.method() !== 'HEAD') scritture.push(r.method() + ' ' + r.url()); });
        // sul telefono un tocco vero; se la vista del telefono è spostata (pagina più larga dello schermo) Playwright
        // sbaglia le coordinate del tocco: allora premo il pulsante dal DOM (che si possa premere lo controlla leggiPasso)
        const tocca = async (sel) => {
          if (schermo.nome !== 'telefono') return p.click(sel);
          const spostata = await p.evaluate(() => !!window.visualViewport && (window.visualViewport.offsetTop > 0 || window.visualViewport.offsetLeft > 0));
          return spostata ? p.locator(sel).evaluate((b) => b.click()) : p.tap(sel);
        };
        const foto = async (nome) => { if (FOTO) await p.screenshot({ path: path.join(FOTO, (schermo.nome + '-' + u.ruolo + '-' + nome).replace(/[^a-z0-9._-]+/gi, '_') + '.png') }); };
        const stato = () => p.evaluate(() => window.Tour.stato());

        /* --- accesso --- */
        await p.goto(base);
        await p.waitForSelector('#acc-form');
        await p.fill('#acc-user', u.username);
        await p.fill('#acc-pw', PW);
        await p.click('#acc-invia');
        await p.waitForSelector('#app:not([hidden])', { timeout: 15000 });
        const idUtente = await p.evaluate(() => App.utente.id);
        const chiave = 'gf-giro-invito:' + idUtente;

        /* --- invito al primo accesso --- */
        const invito = await p.waitForSelector('.tour-invito', { timeout: 5000 }).catch(() => null);
        ok(!!invito, chi + ': invito "Vuoi un giro guidato di un minuto?" al primo accesso');
        if (invito) {
          await p.waitForTimeout(400);
          await foto('00-invito');
          const pos = await p.evaluate(() => {
            const r = document.querySelector('.tour-invito').getBoundingClientRect();
            const g = document.querySelector('#guidami').getBoundingClientRect();
            const sopra = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            return { dentro: r.left >= 0 && r.right <= document.documentElement.clientWidth && r.bottom <= innerHeight, copreBarra: sopra(r, document.querySelector('.barra').getBoundingClientRect()) || sopra(r, g), testo: document.querySelector('.tour-invito').textContent };
          });
          ok(pos.dentro && !pos.copreBarra, chi + ': l’invito sta nello schermo e non copre la barra in alto');
          ok(/Sì/.test(pos.testo) && /Non ora/.test(pos.testo) && /Non chiedere più/.test(pos.testo), chi + ': l’invito ha Sì / Non ora / Non chiedere più');
          if (schermo.nome === 'telefono') {
            // il menu laterale aperto passa sopra l'invito: nessuna voce resta coperta
            await p.tap('#apri-menu');
            await p.waitForTimeout(400);
            const coperte = await p.evaluate(() => Array.from(document.querySelectorAll('#menu a')).filter((a) => {
              const b = a.getBoundingClientRect();
              const e = document.elementFromPoint(b.left + Math.min(40, b.width / 2), b.top + b.height / 2);
              return !!e && !!e.closest('.tour-invito');
            }).map((a) => a.getAttribute('data-pagina')));
            ok(coperte.length === 0, chi + ': l’invito non copre le voci del menu aperto' + (coperte.length ? ' (' + coperte.join(', ') + ')' : ''));
            await p.evaluate(() => document.getElementById('app').classList.remove('menu-aperto'));
            await p.waitForTimeout(300);
          }
          if (schermo.nome === 'desktop' && u.ruolo === 'amministratore') {
            await p.click('.tour-invito [data-invito="mai"]');
            await p.waitForTimeout(300);
            ok(await p.evaluate((k) => localStorage.getItem(k), chiave) === 'mai', chi + ': "Non chiedere più" ricordato nel browser per questo utente');
            await p.reload();
            await p.waitForSelector('#app:not([hidden])', { timeout: 15000 });
            await p.waitForTimeout(2200);
            ok(await p.locator('.tour-invito').count() === 0, chi + ': dopo "Non chiedere più" l’invito non torna');
          } else if (schermo.nome === 'desktop' && u.ruolo === 'farmacista') {
            await p.click('.tour-invito [data-invito="si"]');
            const s = await attendi(async () => { const x = await stato(); return x.attivo && !x.inAttesa ? x : null; }, 6000);
            ok(s && s.giro === 'benvenuto', chi + ': "Sì" avvia il giro di benvenuto');
            await p.keyboard.press('Escape');
            ok(!(await stato()).attivo, chi + ': Esc chiude il giro');
            ok(await p.evaluate((k) => localStorage.getItem(k), chiave) === 'fatto', chi + ': dopo il giro l’invito non si ripropone');
          } else if (schermo.nome === 'desktop' && u.ruolo === 'reparto') {
            await p.evaluate(() => { location.hash = '#giacenze'; });
            await p.waitForTimeout(400);
            ok(await p.locator('.tour-invito').count() === 0, chi + ': cambiando pagina l’invito si toglie da solo (come "Non ora")');
            ok(/^dopo:/.test(await p.evaluate((k) => localStorage.getItem(k) || '', chiave)), chi + ': l’invito ignorato si ripropone un altro giorno');
          } else {
            await tocca('.tour-invito [data-invito="dopo"]');
            await p.waitForTimeout(300);
            ok(/^dopo:/.test(await p.evaluate((k) => localStorage.getItem(k) || '', chiave)), chi + ': "Non ora" ricordato (si richiede un altro giorno)');
          }
        }

        /* --- giri permessi --- */
        const permessi = await p.evaluate(() => ({
          elenco: Tour.elenco(),
          pagine: App.vociPermesse().map((v) => v.id),
          tutte: App.MENU.filter((v) => v.id).map((v) => v.id),
          perPagina: App.MENU.filter((v) => v.id).map((v) => [v.id, Tour.perPagina(v.id)])
        }));
        const ids = permessi.elenco.map((g) => g.id);
        ok(permessi.elenco.every((g) => !g.pagina || permessi.pagine.includes(g.pagina)), chi + ': ogni giro dell’elenco è su una pagina permessa (' + ids.join(', ') + ')');
        const attesi = permessi.perPagina.filter((x) => x[1] && permessi.pagine.includes(x[0])).map((x) => x[1]);
        ok(attesi.every((id) => ids.includes(id)), chi + ': ci sono i giri di tutte le pagine permesse');
        const vietati = permessi.perPagina.filter((x) => x[1] && !permessi.pagine.includes(x[0])).map((x) => x[1]);
        for (const id of vietati) {
          ok(!ids.includes(id), chi + ': il giro "' + id + '" (pagina non permessa) non compare');
          ok((await p.evaluate((x) => Tour.avvia(x), id)) === false, chi + ': Tour.avvia("' + id + '") rifiutato');
        }
        ok(ids.includes('benvenuto') && ids.includes('scanner') === permessi.pagine.some((x) => ['carico', 'consumi', 'trasferimenti', 'perdite', 'inventario'].includes(x)),
          chi + ': benvenuto sempre, lettore di codici a barre solo a chi registra');

        /* --- pulsante Guidami: pagina senza giro → elenco; pagina con giro → il suo giro --- */
        await p.evaluate(() => { location.hash = '#guida'; });
        await p.waitForTimeout(300);
        await tocca('#guidami');
        const elenco = await p.waitForSelector('.tour-elenco', { timeout: 3000 }).catch(() => null);
        ok(!!elenco, chi + ': Guidami sulla pagina Guida apre l’elenco dei giri');
        if (elenco) {
          const voci = await p.$$eval('.tour-elenco button[data-giro]', (b) => b.map((x) => x.getAttribute('data-giro')));
          ok(voci.join() === ids.join(), chi + ': l’elenco mostra i giri permessi');
          const box = await p.evaluate(() => { const r = document.querySelector('.tour-elenco').getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth && r.bottom <= innerHeight + 1; });
          ok(box, chi + ': l’elenco sta nello schermo');
          await foto('00-elenco');
          if (schermo.nome === 'desktop') {
            await p.keyboard.press('ArrowDown');
            await p.keyboard.press('Escape');
          } else {
            // un tocco in basso, fuori dall'elenco (in proporzione allo schermo)
            await p.touchscreen.tap(Math.round(schermo.opz.viewport.width / 2), Math.round(schermo.opz.viewport.height * 0.8));
          }
          await p.waitForTimeout(150);
          ok(await p.locator('.tour-elenco').count() === 0, chi + ': l’elenco si chiude (' + (schermo.nome === 'desktop' ? 'Esc' : 'tocco fuori') + ')');
        }
        await p.evaluate(() => { location.hash = '#giacenze'; });
        await p.waitForSelector('#g-rep');
        await tocca('#guidami');
        const sg = await attendi(async () => { const x = await stato(); return x.attivo && !x.inAttesa ? x : null; }, 5000);
        ok(sg && sg.giro === 'giacenze' && sg.indice === 1, chi + ': Guidami sulla pagina Giacenze avvia il suo giro');
        // con il giro aperto i tasti rapidi non cambiano pagina e i clic sulla pagina non arrivano
        await p.keyboard.press('m');
        await p.waitForTimeout(150);
        ok((await p.evaluate(() => App.paginaCorrente)) === 'giacenze', chi + ': con il giro aperto i tasti rapidi non cambiano pagina');
        await p.mouse.click(5, 5);
        ok((await stato()).attivo, chi + ': un clic sulla parte scura non chiude il giro');
        // la pagina cambiata da fuori (tasto Indietro del browser): il giro si chiude
        await p.evaluate(() => { location.hash = '#movimenti'; });
        await attendi(async () => !(await stato()).attivo, 2000);
        ok(!(await stato()).attivo, chi + ': cambiando pagina da fuori il giro si chiude');
        await p.waitForTimeout(250);
        ok(await p.locator('.tour').count() === 0, chi + ': chiuso il giro non resta niente sullo schermo');

        /* --- Guidami su ogni pagina permessa (computer): parte il giro di quella pagina --- */
        if (schermo.nome === 'desktop') {
          const conGiro = permessi.perPagina.filter((x) => x[1] && permessi.pagine.includes(x[0]));
          const sbagliati = [];
          for (const [pagina] of conGiro) {
            await p.evaluate((x) => { location.hash = '#' + x; }, pagina);
            await attendi(async () => (await p.evaluate(() => App.paginaCorrente)) === pagina, 3000);
            await p.waitForTimeout(150);
            const atteso = await p.evaluate((x) => Tour.perPagina(x), pagina);
            await p.click('#guidami');
            const s = await attendi(async () => { const x = await stato(); return x.attivo ? x : null; }, 3000);
            if (!s || s.giro !== atteso) sbagliati.push(pagina + ' → ' + (s ? s.giro : 'niente'));
            await p.keyboard.press('Escape');
            await attendi(async () => !(await stato()).attivo, 2000);
          }
          ok(sbagliati.length === 0, chi + ': Guidami avvia il giro di ogni pagina (' + conGiro.length + ' pagine)' + (sbagliati.length ? ': ' + sbagliati.join(', ') : ''));
          // Richieste: chi evade vede il giro "Evadere"; sul modulo di una richiesta nuova, "Chiedere merce"
          if (permessi.pagine.includes('richieste')) {
            const giroDi = async (parametri) => {
              await p.evaluate((x) => App.vai('richieste', x), parametri);
              await p.waitForTimeout(400);
              await p.click('#guidami');
              const s = await attendi(async () => { const x = await stato(); return x.attivo && !x.inAttesa ? x : null; }, 5000);
              await p.keyboard.press('Escape');
              await attendi(async () => !(await stato()).attivo, 2000);
              return s ? s.giro : null;
            };
            const evade = await p.evaluate(() => App.puo('evadiRichieste'));
            ok((await giroDi({})) === (evade ? 'richieste-evadi' : 'richieste'), chi + ': Guidami sull’elenco delle richieste: giro "' + (evade ? 'Evadere le richieste' : 'Chiedere merce') + '"');
            ok((await giroDi({ nuova: true })) === 'richieste', chi + ': Guidami sul modulo di una richiesta nuova: giro "Chiedere merce alla farmacia"');
            await p.evaluate(() => App.vai('richieste', {}));
          }
        }

        /* --- tastiera nel fumetto e "Altri giri" sull'ultimo passo --- */
        if (schermo.nome === 'desktop') {
          await p.evaluate(() => { location.hash = '#giacenze'; });
          await p.waitForSelector('#g-rep');
          await p.evaluate(() => Tour.avvia('giacenze'));
          await attendi(async () => { const x = await stato(); return x.attivo && !x.inAttesa ? x : null; }, 5000);
          await p.keyboard.press('ArrowRight');
          await attendi(async () => { const x = await stato(); return !x.inAttesa && x.indice === 2 ? x : null; }, 5000);
          // il fuoco gira solo tra i pulsanti del fumetto: Maiusc+Tab da Avanti va su Indietro, Invio lo preme
          await p.keyboard.press('Shift+Tab');
          const suIndietro = await p.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-tour'));
          ok(suIndietro === 'indietro', chi + ': Maiusc+Tab porta il fuoco su Indietro (' + suIndietro + ')');
          await p.keyboard.press('Enter');
          ok(!!(await attendi(async () => { const x = await stato(); return !x.inAttesa && x.indice === 1 ? x : null; }, 5000)), chi + ': Invio su Indietro torna al passo prima');
          await p.keyboard.press('Tab');
          await p.keyboard.press('Tab');
          ok(await p.evaluate(() => !!document.activeElement.closest('.tour-fumetto')), chi + ': con Tab il fuoco resta nel fumetto');
          for (let i = 0; i < 10; i++) {
            const x = await stato();
            if (x.indice === x.totale) break;
            await p.keyboard.press('ArrowRight');
            await attendi(async () => { const y = await stato(); return !y.inAttesa && y.indice > x.indice ? y : null; }, 5000);
          }
          await p.click('.tour-fumetto [data-tour="altri"]');
          ok(!!(await p.waitForSelector('.tour-elenco', { timeout: 3000 }).catch(() => null)) && !(await stato()).attivo, chi + ': "Altri giri" sull’ultimo passo chiude il giro e apre l’elenco');
          await p.keyboard.press('Escape');
          await p.waitForTimeout(250);
        }

        /* --- il giro non fa perdere quello che si sta scrivendo --- */
        if (schermo.nome === 'desktop' && permessi.pagine.includes('carico')) {
          await p.evaluate(() => { location.hash = '#carico'; });
          await p.waitForSelector('#righe tr .r-art');
          await p.fill('#righe tr:first-child .r-art', 'KETOROLAC 30 mg/ml f');
          await p.fill('#righe tr:first-child .r-q', '7');
          // il giro di benvenuto cambierebbe pagina: prima chiede
          await p.evaluate(() => Tour.avvia('benvenuto'));
          const domanda = await p.waitForSelector('#modale:not([hidden]) #conferma-si', { timeout: 3000 }).catch(() => null);
          ok(!!domanda, chi + ': con righe scritte e non registrate, un giro che cambia pagina chiede prima');
          if (domanda) await p.click('#modale [data-chiudi]:not(.fantasma)');
          await p.waitForTimeout(200);
          ok(!(await stato()).attivo && (await p.evaluate(() => App.paginaCorrente)) === 'carico', chi + ': rispondendo Annulla il giro non parte e la pagina resta');
          // il giro della pagina stessa non la ridisegna: le righe scritte restano
          await p.click('#guidami');
          await attendi(async () => { const x = await stato(); return x.attivo && !x.inAttesa ? x : null; }, 5000);
          for (let i = 0; i < 20 && (await stato()).attivo; i++) {
            await p.keyboard.press('ArrowRight');
            await attendi(async () => { const x = await stato(); return !x.attivo || !x.inAttesa ? x : null; }, 5000);
          }
          const rimasti = await p.evaluate(() => [document.querySelector('#righe tr:first-child .r-art').value, document.querySelector('#righe tr:first-child .r-q').value]);
          ok(rimasti[0] === 'KETOROLAC 30 mg/ml f' && rimasti[1] === '7', chi + ': dopo il giro del Carico le righe scritte sono ancora lì');
          ok((await p.evaluate(() => document.activeElement && document.activeElement.id)) === 'guidami', chi + ': chiuso il giro il fuoco torna al pulsante Guidami');
        }

        /* --- la causale proposta dalla pagina Trasferimenti non è "qualcosa di scritto": il giro parte senza domande --- */
        if (schermo.nome === 'desktop' && permessi.pagine.includes('trasferimenti')) {
          await p.evaluate(() => { location.hash = '#trasferimenti'; });
          await p.waitForSelector('#t-causale');
          await p.waitForTimeout(200);
          await p.evaluate(() => Tour.avvia('benvenuto'));
          const s = await attendi(async () => { const x = await stato(); return x.attivo && !x.inAttesa ? x : null; }, 5000);
          const domanda = await p.evaluate(() => !document.getElementById('modale').hidden);
          ok(!!s && s.giro === 'benvenuto' && !domanda, chi + ': dalla pagina Trasferimenti appena aperta il giro parte senza chiedere (la causale proposta non è un dato scritto)');
          await p.keyboard.press('Escape');
          await attendi(async () => !(await stato()).attivo, 2000);
        }

        /* --- casi limite (solo amministratore): fuoco, finestre aperte, ridimensionamento, rotazione, sessione scaduta --- */
        if (u.ruolo === 'amministratore') {
          const pronto = () => attendi(async () => { const x = await stato(); return x.attivo && !x.inAttesa ? x : null; }, 6000);
          const fuoco = () => p.evaluate(() => { const a = document.activeElement; return a ? (a.id ? '#' + a.id : a.tagName.toLowerCase()) : null; });
          if (schermo.nome === 'desktop') {
            // giro avviato dall'elenco (che poi sparisce): chiuso il giro il fuoco torna su Guidami, non sulla pagina vuota
            await p.evaluate(() => { location.hash = '#guida'; });
            await p.waitForTimeout(300);
            await p.click('#guidami');
            await p.waitForSelector('.tour-elenco');
            await p.keyboard.press('Enter');
            await pronto();
            await p.keyboard.press('Escape');
            await p.waitForTimeout(250);
            ok((await fuoco()) === '#guidami', chi + ': giro avviato dall’elenco e chiuso con Esc: il fuoco torna su Guidami');

            // una finestra con dati scritti non si chiude se si arriva a Guidami con Tab e si preme Invio
            await p.evaluate(() => { location.hash = '#articoli'; });
            await p.waitForSelector('#a-nuovo');
            await p.click('#a-nuovo');
            const campoArt = p.locator('#modale:not([hidden]) .modale-corpo input:not([type=checkbox])').first();
            await campoArt.fill('ARTICOLO SCRITTO A MANO');
            for (let i = 0; i < 80 && (await fuoco()) !== '#guidami'; i++) await p.keyboard.press('Tab');
            if ((await fuoco()) !== '#guidami') await p.evaluate(() => document.getElementById('guidami').focus());
            await p.keyboard.press('Enter');
            await p.waitForTimeout(400);
            const finestra = await p.evaluate(() => !document.getElementById('modale').hidden);
            ok(finestra && (await campoArt.inputValue()) === 'ARTICOLO SCRITTO A MANO' && !(await stato()).attivo,
              chi + ': finestra con dati scritti: Guidami non la chiude e non avvia il giro');
            await p.evaluate(() => App.chiudiModale());

            // finestra ristretta (menu laterale nascosto) durante il passo sul menu, e di nuovo larga
            await p.evaluate(() => { location.hash = '#oggi'; });
            await p.waitForSelector('#contenuto .indicatori');
            await p.evaluate(() => Tour.avvia('benvenuto'));
            await pronto();
            await p.keyboard.press('ArrowRight');
            await attendi(async () => { const x = await stato(); return !x.inAttesa && x.indice === 2 ? x : null; }, 5000);
            const evidenziato = () => p.evaluate(() => !Tour.stato().centrato && !document.querySelector('.tour-luce').classList.contains('vuota'));
            await p.setViewportSize({ width: 700, height: 900 });
            ok(!!(await attendi(async () => (await stato()).menuAperto && (await evidenziato()), 3000)), chi + ': finestra ristretta durante il passo sul menu: il menu si apre e resta evidenziato');
            await p.setViewportSize(schermo.opz.viewport);
            ok(!!(await attendi(async () => !(await p.evaluate(() => document.getElementById('app').classList.contains('menu-aperto'))) && (await evidenziato()), 3000)),
              chi + ': finestra di nuovo larga: il menu torna normale e resta evidenziato');
            await p.keyboard.press('Escape');
            await p.waitForTimeout(250);

            // sessione scaduta con il giro aperto: il giro si chiude e il fuoco resta nel campo della password
            const scade = async () => {
              await ctx.clearCookies();
              await p.evaluate(() => Api.sincronizza({ remota: true }).catch(() => {}));
              await p.waitForSelector('#accesso:not([hidden]) #acc-pw', { timeout: 8000 });
              await p.waitForTimeout(500);
            };
            const rientra = async () => {
              await p.fill('#acc-pw', PW);
              await p.keyboard.press('Enter');
              await p.waitForSelector('#accesso', { state: 'hidden', timeout: 10000 });
              await attendi(() => p.evaluate(() => !!(App.S && App.utente)), 5000);
            };
            await p.evaluate(() => { location.hash = '#giacenze'; });
            await p.waitForSelector('#g-rep');
            await p.click('#guidami');
            await pronto();
            await scade();
            ok(!(await stato()).attivo && (await p.locator('.tour').count()) === 0, chi + ': sessione scaduta: il giro si chiude');
            ok((await fuoco()) === '#acc-pw', chi + ': sessione scaduta: il fuoco resta nel campo password (' + (await fuoco()) + ')');
            ok((await p.evaluate(() => Tour.avvia('giacenze'))) === false, chi + ': sessione scaduta: nessun giro sopra la schermata di accesso');
            await rientra();
            // e con l'elenco dei giri aperto (che starebbe sopra la schermata di accesso)
            await p.evaluate(() => { location.hash = '#guida'; });
            await p.waitForTimeout(300);
            await p.click('#guidami');
            await p.waitForSelector('.tour-elenco');
            await scade();
            ok((await p.locator('.tour-elenco').count()) === 0, chi + ': sessione scaduta: l’elenco dei giri si chiude');
            await rientra();

            // Indietro e Avanti in fretta mentre la pagina scorre ancora (difetto della 3.0, segnalato dalla parte B):
            // l'ultimo passo di Distribuzione è in alto, il penultimo in fondo alla pagina
            await p.evaluate(() => { location.hash = '#distribuzione'; });
            await p.waitForSelector('#ds-periodo');
            await p.evaluate(() => Tour.avvia('distribuzione'));
            for (let i = 0; i < 20; i++) {
              const s = await pronto();
              if (!s || s.indice === s.totale) break;
              await p.evaluate(() => document.querySelector('.tour-fumetto [data-tour="avanti"]').click());
              await attendi(async () => { const x = await stato(); return x.inAttesa || x.indice !== s.indice ? x : null; }, 3000);
            }
            await pronto();
            await p.waitForTimeout(1200);
            const inVistaOra = () => p.evaluate(() => {
              const b = Tour.bersagli()[0];
              if (!b) return false;
              const r = b.getBoundingClientRect();
              const testa = document.querySelector('.testa-fissa').getBoundingClientRect().bottom;
              return r.top >= testa - 1 && r.bottom <= innerHeight + 1;
            });
            const ultimoSel = (await stato()).selettore;
            const altezza = await p.evaluate(() => document.documentElement.scrollHeight - innerHeight);
            for (const ritardo of [0, 40, 80, 120]) {
              // ← e, appena il passo di prima è pronto (più un piccolo ritardo), → : dentro la pagina, mentre lo
              // scorrimento morbido verso il passo di prima è appena cominciato (senza la correzione, a 40 ms il
              // giro credeva l'elemento già in vista e la pagina finiva in fondo)
              await p.evaluate((ms) => new Promise((fatto) => {
                const tasto = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
                const prima = Tour.stato().indice;
                tasto('ArrowLeft');
                (function guarda() {
                  const s = Tour.stato();
                  if (s.indice !== prima && !s.inAttesa) { setTimeout(() => { tasto('ArrowRight'); fatto(); }, ms); return; }
                  requestAnimationFrame(guarda);
                })();
              }), ritardo);
              await attendi(async () => { const x = await stato(); return !x.inAttesa && x.selettore === ultimoSel ? x : null; }, 3000);
              await p.waitForTimeout(1500);
              ok(await inVistaOra(), chi + ': Indietro e subito Avanti (' + ritardo + ' ms) mentre la pagina scorre: l’elemento del passo è in vista (' + ultimoSel + ', pagina più alta di ' + altezza + ' px)');
            }
            await p.keyboard.press('Escape');
            await p.waitForTimeout(250);

            // Previsioni: il giro apre da solo le schede (fabbisogno, ABC-XYZ, proposta d'ordine) e il dettaglio di un
            // articolo; alla fine (e anche uscendo a metà) torna la scheda che l'utente aveva scelto, senza finestre aperte
            const sceltaPv = () => p.evaluate(() => {
              const b = document.querySelector('#pv-schede [role="tab"][aria-selected="true"]');
              return b ? b.getAttribute('data-scheda') : null;
            });
            await p.evaluate(() => { location.hash = '#previsioni'; });
            await p.waitForSelector('#pv-tab-abc');
            await attendi(() => p.evaluate(() => { const a = document.getElementById('pv-attesa'); return !!a && a.hidden; }), 15000);
            await p.click('#pv-tab-abc');
            await attendi(async () => (await sceltaPv()) === 'abc', 3000);
            await p.evaluate(() => Tour.avvia('previsioni'));
            const vistePv = {};
            for (let i = 0; i < 30; i++) {
              const s = await pronto();
              if (!s) break;
              vistePv[s.titolo] = await p.evaluate(() => ({
                scheda: (document.querySelector('#pv-schede [role="tab"][aria-selected="true"]') || { getAttribute: () => null }).getAttribute('data-scheda'),
                dettaglio: !!document.querySelector('#modale:not([hidden]) #pvd-grafico canvas')
              }));
              if (s.indice === s.totale) break;
              await p.evaluate(() => document.querySelector('.tour-fumetto [data-tour="avanti"]').click());
              await attendi(async () => { const x = await stato(); return x.inAttesa || x.indice !== s.indice ? x : null; }, 3000);
            }
            const vistaPv = (t) => vistePv[t] || {};
            ok(vistaPv('Fabbisogno per articolo').scheda === 'fabbisogno' && !vistaPv('Fabbisogno per articolo').dettaglio, chi + ': Previsioni: il giro apre la scheda del fabbisogno');
            ok(vistaPv('Consumi e previsione dell’articolo').dettaglio && vistaPv('Giorni della settimana e metodi').dettaglio, chi + ': Previsioni: il giro apre il dettaglio di un articolo, con il grafico');
            ok(vistaPv('Excel').scheda === 'fabbisogno' && !vistaPv('Excel').dettaglio, chi + ': Previsioni: poi richiude il dettaglio');
            ok(vistaPv('Classi ABC-XYZ').scheda === 'abc' && vistaPv('Proposta d’ordine').scheda === 'ordine' && vistaPv('Excel e stampa').scheda === 'ordine',
              chi + ': Previsioni: il giro apre le schede ABC-XYZ e Proposta d’ordine');
            await p.evaluate(() => document.querySelector('.tour-fumetto [data-tour="avanti"]').click());
            await attendi(async () => !(await stato()).attivo, 3000);
            await p.waitForTimeout(300);
            ok((await sceltaPv()) === 'abc' && (await p.evaluate(() => document.getElementById('modale').hidden)),
              chi + ': Previsioni: finito il giro torna la scheda scelta prima (ABC-XYZ), nessuna finestra aperta');
            // uscendo con Esc dal dettaglio dell'articolo
            await p.evaluate(() => Tour.avvia('previsioni'));
            for (let i = 0; i < 30; i++) {
              const s = await pronto();
              if (!s || s.titolo === 'Consumi e previsione dell’articolo' || s.indice === s.totale) break;
              await p.evaluate(() => document.querySelector('.tour-fumetto [data-tour="avanti"]').click());
              await attendi(async () => { const x = await stato(); return x.inAttesa || x.indice !== s.indice ? x : null; }, 3000);
            }
            ok((await stato()).titolo === 'Consumi e previsione dell’articolo', chi + ': Previsioni: arrivato al dettaglio dell’articolo');
            await p.keyboard.press('Escape');
            await attendi(async () => !(await stato()).attivo, 3000);
            await p.waitForTimeout(300);
            ok((await sceltaPv()) === 'abc' && (await p.evaluate(() => document.getElementById('modale').hidden)),
              chi + ': Previsioni: Esc sul dettaglio chiude la finestra e rimette la scheda ABC-XYZ');
            await p.click('#pv-tab-fabbisogno');
            await attendi(async () => (await sceltaPv()) === 'fabbisogno', 3000);
          } else {
            // telefono ruotato durante un passo in fondo alla pagina: l'elemento torna in vista ed evidenziato
            await p.evaluate(() => { location.hash = '#carico'; });
            await p.waitForSelector('#registra');
            await p.evaluate(() => Tour.avvia('carico'));
            for (let i = 0; i < 15; i++) {
              const s = await pronto();
              if (!s || s.selettore === '#registra') break;
              await p.evaluate(() => document.querySelector('.tour-fumetto [data-tour="avanti"]').click());
              await attendi(async () => { const x = await stato(); return x.inAttesa || x.indice !== s.indice ? x : null; }, 3000);
            }
            const inVista = () => attendi(() => p.evaluate(() => {
              const s = Tour.stato(), b = Tour.bersagli()[0], vv = window.visualViewport;
              if (!s.attivo || s.inAttesa || s.centrato || !b || document.querySelector('.tour-luce').classList.contains('vuota')) return null;
              const r = b.getBoundingClientRect();
              return r.top >= vv.offsetTop && r.bottom <= vv.offsetTop + vv.height;
            }), 4000);
            ok((await stato()).selettore === '#registra' && !!(await inVista()), chi + ': passo "Registra il carico" in vista');
            await p.setViewportSize({ width: 800, height: 390 });
            await p.waitForTimeout(100);
            ok(!!(await inVista()), chi + ': telefono ruotato (800×390): l’elemento del passo torna in vista, evidenziato');
            await p.setViewportSize(schermo.opz.viewport);
            await p.waitForTimeout(100);
            ok(!!(await inVista()), chi + ': telefono di nuovo verticale: l’elemento del passo resta in vista, evidenziato');
            await p.evaluate(() => Tour.ferma());
            await p.waitForTimeout(250);
          }
        }

        /* --- tutti i giri, passo per passo --- */
        const revPrima = await revDati();
        inGiro = true;
        for (const g of permessi.elenco) {
          // si parte dalla pagina Guida: il giro deve aprire da solo le sue pagine
          await p.evaluate(() => { location.hash = '#guida'; });
          await attendi(async () => (await p.evaluate(() => App.paginaCorrente)) === 'guida', 3000);
          const avviato = await p.evaluate((id) => Tour.avvia(id), g.id);
          if (!ok(avviato === true, chi + ': giro "' + g.id + '" avviato')) continue;
          const visti = [];
          let ultimo = null;
          let tornatoIndietro = false;
          for (let giri = 0; giri < 60; giri++) {
            // aspetto che il passo sia pronto e che riquadro e fumetto siano fermi (fine dello scorrimento)
            let prima = null;
            const pr = await attendi(async () => {
              const x = await p.evaluate(leggiPasso);
              if (!x.s.attivo || x.s.inAttesa || !x.opaco) return null;
              const fermo = prima && JSON.stringify([prima.luce, prima.fumetto]) === JSON.stringify([x.luce, x.fumetto]);
              prima = x;
              return fermo ? x : null;
            }, 9000);
            if (!ok(!!pr, chi + ' · ' + g.id + ': passo pronto entro il tempo')) break;
            const s = pr.s;
            const dove = chi + ' · ' + g.id + ' · ' + s.indice + '/' + s.totale + ' "' + s.titolo + '"';
            visti.push(s.indice);
            ok(pr.conta === 'Passo ' + s.indice + ' di ' + s.totale, dove + ': "Passo N di M" giusto');
            if (g.id === 'benvenuto' && s.indice === 1) {
              const nome = await p.evaluate(() => App.S.impostazioni.nomeProdotto || 'NefroCenter Pharmacy');
              ok(pr.titolo === 'Benvenuto in ' + nome, dove + ': il benvenuto usa il nome del programma (' + pr.titolo + ')');
            }
            ok(pr.fuocoNelFumetto, dove + ': il fuoco è nel fumetto (i tasti non finiscono nella pagina)');
            ok(pr.avantiPremibile, dove + ': il pulsante Avanti si può premere');
            if (s.conElemento) {
              ok(!s.centrato && pr.n > 0 && pr.connessi, dove + ': l’elemento evidenziato esiste (' + s.selettore + ')');
              ok(pr.prove.length > 0 && pr.prove.some((x) => x.visibile), dove + ': l’elemento è visibile e non coperto' + (pr.prove.some((x) => x.visibile) ? '' : ' (' + pr.prove.map((x) => x.motivo).join('; ') + ')'));
              if (pr.unione) {
                const vis = { l: Math.max(pr.unione.l, 0), t: Math.max(pr.unione.t, 0), r: Math.min(pr.unione.r, pr.W), b: Math.min(pr.unione.b, pr.H) };
                const tolleranza = 12;
                const sulBersaglio = !pr.luceVuota && pr.luce.l <= vis.l + tolleranza && pr.luce.t <= vis.t + tolleranza && pr.luce.r >= vis.r - tolleranza && pr.luce.b >= vis.b - tolleranza &&
                  pr.luce.l >= vis.l - tolleranza && pr.luce.t >= vis.t - tolleranza && pr.luce.r <= vis.r + tolleranza && pr.luce.b <= vis.b + tolleranza;
                ok(sulBersaglio, dove + ': il riquadro luminoso è sull’elemento');
                // il fumetto non copre il centro dell'elemento (se l'elemento non è grande quasi come lo schermo)
                const area = (vis.r - vis.l) * (vis.b - vis.t);
                if (area < pr.W * pr.H * 0.4) {
                  const cx = (vis.l + vis.r) / 2, cy = (vis.t + vis.b) / 2;
                  const copre = cx > pr.fumetto.l && cx < pr.fumetto.r && cy > pr.fumetto.t && cy < pr.fumetto.b;
                  ok(!copre, dove + ': il fumetto non copre l’elemento (lato ' + pr.lato + ')');
                }
              }
              if (schermo.nome === 'telefono') ok(pr.menuAperto === pr.nelMenu, dove + ': menu laterale ' + (pr.nelMenu ? 'aperto per il passo sul menu' : 'chiuso'));
            } else {
              ok(s.centrato && pr.lato === 'centro', dove + ': passo senza elemento, fumetto al centro');
            }
            ok(pr.fumetto.l >= 0 && pr.fumetto.t >= 0 && pr.fumetto.r <= pr.W + 0.5 && pr.fumetto.b <= pr.H + 0.5, dove + ': il fumetto sta tutto nello schermo');
            ok(pr.scrollX === 0, dove + ': il giro non fa scorrere la pagina di lato');
            // pagina più larga dello schermo per conto suo (non dipende dal giro): la segnalo a parte
            if (pr.larghezzaPagina > pr.W + 1) pagineLarghe.add(schermo.nome + ' · ' + s.pagina + ' (' + pr.larghezzaPagina + ' px su ' + pr.W + ')');
            if (FOTO && (u.ruolo === 'amministratore' || u.ruolo === 'reparto')) await foto(g.id + '-' + String(s.indice).padStart(2, '0'));
            ultimo = s;
            if (s.indice === s.totale) break;
            // avanti in modi diversi: freccia, Invio, pulsante; una volta indietro e di nuovo avanti
            if (!tornatoIndietro && s.indice === 2) {
              tornatoIndietro = true;
              await p.keyboard.press('ArrowLeft');
              const ind = await attendi(async () => { const x = await stato(); return !x.inAttesa && x.indice === 1 ? x : null; }, 5000);
              ok(!!ind, chi + ' · ' + g.id + ': ← torna al passo precedente');
              await p.keyboard.press('ArrowRight');
              await attendi(async () => { const x = await stato(); return !x.inAttesa && x.indice >= 2 ? x : null; }, 6000);
              continue;
            }
            const modo = s.indice % 3;
            if (schermo.nome === 'telefono') await tocca('.tour-fumetto [data-tour="avanti"]');
            else if (modo === 0) await p.keyboard.press('ArrowRight');
            else if (modo === 1) await p.keyboard.press('Enter');
            else await p.click('.tour-fumetto [data-tour="avanti"]');
            await attendi(async () => { const x = await stato(); return !x.attivo || x.inAttesa || x.indice !== s.indice ? x : null; }, 4000);
          }
          if (ultimo) {
            ok(ultimo.indice === ultimo.totale, chi + ' · ' + g.id + ': arrivato all’ultimo passo (' + ultimo.totale + ' passi)');
            if (ultimo.saltati.length) {
              saltatiTotali[g.id] = saltatiTotali[g.id] || new Set();
              ultimo.saltati.forEach((x) => saltatiTotali[g.id].add(x));
            }
            const testoFine = await p.textContent('.tour-fumetto [data-tour="avanti"]');
            ok(/Fine/.test(testoFine), chi + ' · ' + g.id + ': sull’ultimo passo il pulsante è "Fine"');
            await tocca('.tour-fumetto [data-tour="avanti"]');
            await attendi(async () => !(await stato()).attivo, 3000);
            ok(!(await stato()).attivo, chi + ' · ' + g.id + ': "Fine" chiude il giro');
            await p.waitForTimeout(220);
            const pulito = await p.evaluate(() => !document.querySelector('.tour') && !document.getElementById('app').classList.contains('menu-aperto'));
            ok(pulito, chi + ' · ' + g.id + ': dopo la fine niente riquadro né menu aperto');
            // quello che il giro ha aperto per un passo (menu dell'utente, finestra, modalità Disponi) è di nuovo chiuso
            const aperto = await p.evaluate(() => [
              !document.getElementById('utente-tendina').hidden ? 'menu dell’utente' : '',
              !document.getElementById('modale').hidden ? 'finestra' : '',
              document.querySelector('#ar-disponi[aria-pressed="true"]') ? 'modalità Disponi' : ''
            ].filter(Boolean));
            ok(aperto.length === 0, chi + ' · ' + g.id + ': dopo la fine niente resta aperto' + (aperto.length ? ' (' + aperto.join(', ') + ')' : ''));
          }
        }
        inGiro = false;
        ok(scritture.length === 0, chi + ': i giri non hanno fatto nessuna scrittura' + (scritture.length ? ' (' + scritture.join(', ') + ')' : ''));
        ok((await revDati()) === revPrima, chi + ': la revisione dei dati sul server non è cambiata');
        nota(chi + ': ' + permessi.elenco.length + ' giri in ' + Math.round((Date.now() - t0) / 1000) + ' s');
        await ctx.close();
      }
    }
    ok((await revDati()) === rev0, 'nessun giro ha cambiato i dati del magazzino');
    if (!SENZA_VUOTO && (!SOLO || SOLO.includes('amministratore'))) await provaArchivioVuoto(browser, errori);
    ok(errori.length === 0, 'nessun errore JavaScript o di sicurezza (CSP) nei browser' + (errori.length ? ':\n  ' + errori.join('\n  ') : ''));
  } catch (e) {
    ok(false, 'eccezione: ' + (e && e.stack || e));
  } finally {
    await browser.close();
    // il server, chiudendosi, fa ancora una copia di sicurezza nella cartella dati: la tolgo quando è uscito davvero
    const uscito = new Promise((fatto) => { if (proc.exitCode !== null) fatto(); else { proc.once('exit', fatto); setTimeout(fatto, 10000); } });
    proc.kill('SIGTERM');
    await uscito;
    try { fs.rmSync(dati, { recursive: true, force: true }); } catch (e) { nota('cartella temporanea non tolta: ' + dati); }
  }
  if (pagineLarghe.size) {
    console.log('\nPagine più larghe dello schermo anche senza il giro (da sistemare nella pagina, non nel giro):');
    pagineLarghe.forEach((x) => console.log('  ' + x));
  }
  const saltati = Object.keys(saltatiTotali);
  if (saltati.length) {
    console.log('\nPassi facoltativi saltati perché l’elemento non c’era (non sono errori):');
    saltati.forEach((g) => console.log('  ' + g + ': ' + Array.from(saltatiTotali[g]).join(', ')));
  }
  console.log('\n' + contaOk + ' controlli riusciti in ' + Math.round((Date.now() - inizio) / 1000) + ' s');
  console.log(esito ? 'ALCUNE PROVE NON SONO RIUSCITE' : 'TUTTE LE PROVE SONO RIUSCITE');
  process.exit(esito);
})();
