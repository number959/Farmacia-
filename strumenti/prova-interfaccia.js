/*
 * Prova dell'interfaccia con più utenti insieme, sul server vero (sorgenti o eseguibile compilato).
 * Richiede Playwright con Chromium:  node strumenti/prova-interfaccia.js [--exe <eseguibile>] [--foto <cartella>]
 * Tre browser separati: amministratore, farmacista e infermiere di reparto lavorano in contemporanea.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const ESEGUIBILE = arg('--exe');
const FOTO = arg('--foto');
const PW = 'Password-123';
let esito = 0;

function ok(cond, testo) {
  console.log((cond ? 'OK    ' : 'ERRORE') + '  ' + testo);
  if (!cond) esito = 1;
}

function portaLibera() {
  return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

async function attendi(cond, ms) {
  const fine = Date.now() + (ms || 8000);
  while (Date.now() < fine) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function oggi() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

(async () => {
  const porta = await portaLibera();
  const dati = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-interfaccia-'));
  const proc = ESEGUIBILE
    ? spawn(ESEGUIBILE, ['--porta', String(porta), '--dati', dati], { stdio: 'ignore' })
    : spawn(process.execPath, [path.join(__dirname, '..', 'server', 'main.js'), '--porta', String(porta), '--dati', dati], { stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + porta + '/';
  await attendi(async () => { try { return (await fetch(base + 'api/stato')).ok; } catch (e) { return false; } }, 20000);

  const browser = await chromium.launch();
  const errori = [];
  async function nuovaPagina(nome) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, locale: 'it-IT' });
    const p = await ctx.newPage();
    // "Failed to load resource" è il registro di Chrome per le risposte 4xx che la prova provoca apposta (403, 409, 401)
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errori.push(nome + ': ' + m.text()); });
    p.on('pageerror', (e) => errori.push(nome + ' (eccezione): ' + e.message));
    return p;
  }
  async function foto(p, nome) { if (FOTO) await p.screenshot({ path: path.join(FOTO, nome + '.png') }); }
  async function api(p, metodo, percorso, corpo) {
    return p.evaluate(([m, u, c]) => Api.richiesta(m, u, c).then((r) => ({ ok: true, r }), (e) => ({ ok: false, stato: e.stato, msg: e.message })), [metodo, percorso, corpo]);
  }
  async function entra(p, utente, password, nuova) {
    await p.goto(base);
    await p.waitForSelector('#acc-form');
    await p.fill('#acc-user', utente);
    await p.fill('#acc-pw', password);
    await p.click('#acc-invia');
    if (nuova) {
      await p.waitForSelector('#acc-attuale');
      await foto(p, '03-cambio-password');
      await p.fill('#acc-attuale', password);
      await p.fill('#acc-pw', nuova);
      await p.fill('#acc-pw2', nuova);
      await p.click('#acc-invia');
    }
    await p.waitForSelector('#app:not([hidden])', { timeout: 15000 });
    await p.waitForTimeout(400);
  }

  try {
    /* --- amministratore: primo avvio dal server --- */
    const A = await nuovaPagina('amministratore');
    await A.goto(base);
    await A.waitForSelector('#acc-form');
    await foto(A, '01-primo-avvio');
    await A.fill('#acc-user', 'admin');
    await A.fill('#acc-nome', 'Giovanni Amministratore');
    await A.fill('#acc-pw', PW);
    await A.fill('#acc-pw2', PW);
    await A.click('#acc-invia');
    await A.waitForSelector('#app:not([hidden])', { timeout: 15000 });
    ok(true, 'primo amministratore creato dall’interfaccia');
    const demo = await api(A, 'POST', '/api/demo');
    ok(demo.ok, 'dati di prova caricati');
    await A.evaluate(() => Api.sincronizza());
    const mk = async (username, nome, ruolo, reparti) => api(A, 'POST', '/api/utenti', { username, nome, ruolo, reparti, password: 'Provvisoria1' });
    ok((await mk('farma', 'Maria Farmacista', 'farmacista', [])).ok, 'utente farmacista creato');
    ok((await mk('deg', 'Luca Infermiere', 'reparto', ['r-degenza'])).ok, 'utente di reparto creato');
    ok((await mk('dir', 'Direzione Sanitaria', 'consultazione', [])).ok, 'utente in consultazione creato');
    await A.goto(base + '#utenti');
    await A.waitForTimeout(600);
    await foto(A, '02-utenti');
    ok(await A.locator('text=Maria Farmacista').count() > 0, 'pagina Utenti mostra i nuovi utenti');

    /* --- farmacista e reparto entrano (password provvisoria da cambiare) --- */
    const F = await nuovaPagina('farmacista');
    await entra(F, 'farma', 'Provvisoria1', PW);
    ok(true, 'farmacista: primo accesso e cambio password');
    const R = await nuovaPagina('reparto');
    await entra(R, 'deg', 'Provvisoria1', PW);
    ok(true, 'reparto: primo accesso e cambio password');
    const D = await nuovaPagina('consultazione');
    await entra(D, 'dir', 'Provvisoria1', PW);

    // il menu segue il ruolo
    const voci = async (p) => p.$$eval('#menu a[data-pagina]', (as) => as.map((a) => a.getAttribute('data-pagina')));
    const vR = await voci(R);
    ok(!vR.includes('carico') && !vR.includes('utenti') && vR.includes('consumi'), 'reparto: menu senza Carico e Utenti, con Consumi (' + vR.join(',') + ')');
    const vD = await voci(D);
    ok(!vD.includes('carico') && !vD.includes('consumi') && vD.includes('giacenze'), 'consultazione: solo pagine di lettura (' + vD.join(',') + ')');
    const vF = await voci(F);
    ok(vF.includes('carico') && !vF.includes('utenti') && !vF.includes('configura'), 'farmacista: Carico sì, Utenti e Configura no (' + vF.join(',') + ')');

    /* --- l'amministratore guarda le giacenze mentre la farmacista registra un carico --- */
    await A.goto(base + '#giacenze');
    await A.waitForTimeout(500);
    const movA0 = await A.evaluate(() => App.S.movimenti.length);

    await F.goto(base + '#carico');
    await F.waitForSelector('#righe tr .r-art');
    await F.fill('#righe tr:first-child .r-art', 'KETOROLAC 30 mg/ml f');
    await F.fill('#righe tr:first-child .r-q', '40');
    await F.fill('#righe tr:first-child .r-lotto', 'K-NUOVO');
    await F.fill('#righe tr:first-child .r-scad', '2028-05');
    await F.fill('#t-forn', 'Deposito di prova');
    await foto(F, '04-carico');
    await F.click('#registra');
    const arrivato = await attendi(async () => (await A.evaluate(() => App.S.movimenti.length)) > movA0, 10000);
    ok(arrivato, 'il carico della farmacista compare da solo nel browser dell’amministratore (tempo reale)');
    const operatore = await A.evaluate(() => (App.S.movimenti.find((m) => m.lotto === 'K-NUOVO') || {}).operatore);
    ok(operatore === 'Maria Farmacista', 'il movimento porta il nome di chi l’ha registrato (' + operatore + ')');

    /* --- il reparto registra i consumi del giorno --- */
    await R.goto(base + '#consumi');
    await R.waitForSelector('#c-rep');
    await R.selectOption('#c-cat', 'FARMACI');
    await R.waitForTimeout(300);
    const repartiR = await R.$$eval('#c-rep option', (o) => o.map((x) => x.value));
    ok(repartiR.length === 1 && repartiR[0] === 'r-degenza', 'reparto: può scegliere solo il proprio reparto (' + repartiR.join(',') + ')');
    const campi = R.locator('input.q[data-art]');
    const nCampi = await campi.count();
    ok(nCampi > 0, 'foglio consumi con gli articoli della Degenza (' + nCampi + ')');
    const artId = await campi.first().getAttribute('data-art');
    const giac0 = await R.evaluate((id) => App.giacenza(id, 'r-degenza'), artId);
    await campi.first().fill('2');
    await foto(R, '05-consumi');
    await R.click('#c-registra');
    const ok1 = await attendi(async () => (await R.evaluate((id) => App.giacenza(id, 'r-degenza'), artId)) === giac0 - 2, 8000);
    ok(ok1, 'reparto: consumo registrato, giacenza ' + giac0 + ' → ' + (giac0 - 2));
    const negato = await api(R, 'POST', '/api/movimenti', { movimenti: [{ tipo: 'consumo', data: oggi(), articoloId: artId, repartoId: 'r-sala', quantita: 1 }] });
    ok(!negato.ok && negato.stato === 403, 'reparto: il server rifiuta consumi in un altro reparto');

    /* --- registro mensile: correzione di una cella dal reparto, export Excel --- */
    await R.goto(base + '#registro');
    await R.waitForSelector('#r-rep');
    await R.selectOption('#r-cat', 'FARMACI');
    await R.waitForTimeout(500);
    const giorno = new Date().getDate();
    const cella = R.locator('tr[data-art="' + artId + '"] input[data-giorno="' + giorno + '"]');
    if (await cella.count()) {
      await cella.click();
      await cella.fill('5');
      await cella.press('Enter');
      const ok2 = await attendi(async () => (await R.evaluate((id) => App.giacenza(id, 'r-degenza'), artId)) === giac0 - 5, 8000);
      ok(ok2, 'registro mensile: la cella di oggi corretta a 5 aggiorna la giacenza');
    } else ok(false, 'registro mensile: cella del giorno non trovata');
    await foto(R, '06-registro');
    const [scaricato] = await Promise.all([R.waitForEvent('download', { timeout: 15000 }), R.click('#r-excel')]);
    ok(/\.xlsx$/.test(scaricato.suggestedFilename()), 'registro mensile: esportato nel modulo Excel (' + scaricato.suggestedFilename() + ')');

    /* --- consultazione: niente pulsanti di scrittura --- */
    await D.goto(base + '#movimenti');
    await D.waitForTimeout(600);
    ok(await D.locator('[data-annulla]').count() === 0, 'consultazione: nessun pulsante Annulla');
    await D.goto(base + '#registro');
    await D.waitForTimeout(600);
    const solaLettura = await D.$$eval('td.g input', (i) => i.length === 0 || i.every((x) => x.readOnly || x.disabled));
    ok(solaLettura, 'consultazione: celle del registro in sola lettura');

    /* --- conflitto: due utenti modificano lo stesso articolo --- */
    const art = await A.evaluate(() => App.S.articoli[0]);
    const m1 = await api(A, 'PUT', '/api/articoli/' + art.id, Object.assign({}, art, { scortaMinima: 77 }));
    const m2 = await api(F, 'PUT', '/api/articoli/' + art.id, Object.assign({}, art, { scortaMinima: 88 }));
    ok(m1.ok && !m2.ok && m2.stato === 409, 'modifiche contemporanee dello stesso articolo: la seconda riceve un conflitto');

    /* --- attività e copie di sicurezza --- */
    await A.goto(base + '#attivita');
    await A.waitForTimeout(800);
    await foto(A, '07-attivita');
    ok(await A.locator('text=Maria Farmacista').count() + await A.locator('text=farma').count() > 0, 'registro attività con le operazioni degli utenti');
    await A.goto(base + '#configura');
    await A.waitForTimeout(800);
    await foto(A, '08-configura');
    await A.goto(base + '#oggi');
    await A.waitForTimeout(600);
    await foto(A, '09-oggi');

    /* --- uscita e sessione --- */
    await F.click('#utente-btn');
    await F.click('#utente-esci');
    await F.waitForSelector('#acc-form', { timeout: 8000 });
    ok(true, 'uscita: torna alla schermata di accesso');
    const dopo = await F.evaluate(() => fetch('api/dati?da=0').then((r) => r.status));
    ok(dopo === 401, 'dopo l’uscita le API rispondono 401');

    ok(errori.length === 0, 'nessun errore JavaScript o di sicurezza (CSP) nei browser' + (errori.length ? ':\n  ' + errori.join('\n  ') : ''));
  } catch (e) {
    ok(false, 'eccezione: ' + (e && e.stack || e));
  } finally {
    await browser.close();
    proc.kill('SIGTERM');
  }
  console.log(esito ? '\nALCUNE PROVE NON SONO RIUSCITE' : '\nTUTTE LE PROVE SONO RIUSCITE');
  process.exit(esito);
})();
