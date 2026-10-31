/*
 * Prova della guida sullo schermo ("Guidami", js/tour.js) sul server vero, con Playwright e Chromium.
 *
 *   node strumenti/prova-tour.js [--foto <cartella>] [--solo amministratore,reparto] [--schermi desktop,telefono] [--exe <eseguibile>]
 *
 * Avvia un server di prova (porta libera, dati in una cartella temporanea), crea l'amministratore, carica i dati di prova
 * e crea un utente per ogni ruolo. Per ogni ruolo, a 1440×900 e a 390×800 (telefono):
 * - l'invito al primo accesso (Sì / Non ora / Non chiedere più, ricordato nel browser per utente);
 * - l'elenco dei giri segue i permessi; il pulsante 🧭 Guidami avvia il giro della pagina o apre l'elenco;
 * - percorre TUTTI i giri passo per passo: ogni elemento evidenziato esiste, è visibile e non è coperto
 *   (sul telefono i passi sul menu aprono il menu), il riquadro luminoso è sull'elemento, il fumetto sta nello schermo
 *   e non copre l'elemento; tastiera (frecce, Invio, Esc), pulsanti Indietro / Avanti / Fine;
 * - con righe scritte e non registrate un giro che cambia pagina chiede prima; il giro della pagina non le tocca;
 * - nessun giro scrive dati (nessuna richiesta POST/PUT/DELETE, revisione dei dati invariata), niente errori JS o CSP.
 * I passi facoltativi saltati (per esempio la barra del lettore se non c'è ancora) sono elencati, non sono errori.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const FOTO = arg('--foto');
const ESEGUIBILE = arg('--exe');
const SOLO = arg('--solo') ? arg('--solo').split(',') : null;
const SOLO_SCHERMI = arg('--schermi') ? arg('--schermi').split(',') : null;
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
      const fisso = !!e.closest('.testa-fissa, .laterale');
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
    for (const u of RUOLI.filter((x) => x.ruolo !== 'amministratore')) {
      await admin('POST', '/api/utenti', { username: u.username, nome: u.nome, ruolo: u.ruolo, reparti: u.reparti, password: PROVVISORIA });
      const c = clienteApi(base);
      await c('POST', '/api/login', { username: u.username, password: PROVVISORIA });
      await c('POST', '/api/password', { attuale: PROVVISORIA, nuova: PW });
    }
    const revDati = async () => (await admin('GET', '/api/dati?da=0')).rev;
    const rev0 = await revDati();
    ok(true, 'server di prova con dati di prova e un utente per ruolo');

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
            await p.touchscreen.tap(195, 640);
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
    ok(errori.length === 0, 'nessun errore JavaScript o di sicurezza (CSP) nei browser' + (errori.length ? ':\n  ' + errori.join('\n  ') : ''));
  } catch (e) {
    ok(false, 'eccezione: ' + (e && e.stack || e));
  } finally {
    await browser.close();
    proc.kill('SIGTERM');
    try { fs.rmSync(dati, { recursive: true, force: true }); } catch (e) { /* niente */ }
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
