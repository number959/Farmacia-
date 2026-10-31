/*
 * Genera le VIDEOGUIDE della pagina Guida (cartella guide/): per ogni guida di js/guide.js
 *   - avvia il server vero con una cartella dati temporanea, crea l'amministratore e gli utenti, carica i dati di prova;
 *   - registra con Playwright (recordVideo, 1280×720) uno scenario dimostrativo: una didascalia grande in basso per ogni
 *     passo della guida (gli stessi testi di Guide.ELENCO[].passi), un puntatore finto che va sull'elemento prima di ogni
 *     clic, ritmo lento e leggibile;
 *   - con ffmpeg crea guide/<id>.mp4 (H.264, yuv420p, +faststart, al massimo 2 MB se si può), la copertina guide/<id>.jpg
 *     e i sottotitoli guide/<id>.vtt con i tempi dei passi (la pagina Guida li usa anche per i passi cliccabili).
 *
 *   node strumenti/genera-videoguide.js [--solo id1,id2] [--ffmpeg /percorso/ffmpeg] [--tieni]
 *
 * --solo rigenera solo alcune guide; --tieni lascia la cartella di lavoro (video grezzi, dati, log del server).
 * Gli scenari usano i selettori veri delle pagine: se una pagina cambia, si rigenera il suo video.
 * Una guida il cui scenario non riesce (per esempio una pagina che non c'è ancora) resta senza video nuovo.
 */
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const RADICE = path.join(__dirname, '..');
const USCITA = path.join(RADICE, 'guide');
const Guide = require('../js/guide.js');
const Barcode = require('../js/barcode.js');
const Calcoli = require('../js/calcoli.js');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const SOLO = (arg('--solo') || '').split(',').map((s) => s.trim()).filter(Boolean);
const FFMPEG = arg('--ffmpeg') || (fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg');
const TIENI = process.argv.includes('--tieni');

const LARGO = 1280;
const ALTO = 720;
const MAX_BYTE = 2 * 1024 * 1024;
const PW = 'Farmacia-Posillipo-24';

/* Utenti delle registrazioni. "nuovo" ha ancora la password provvisoria (la guida del primo accesso con cambio password). */
const UTENTI = {
  admin: { username: 'admin', nome: 'Giovanni Rossi', ruolo: 'amministratore' },
  farmacista: { username: 'm.esposito', nome: 'Maria Esposito', ruolo: 'farmacista', reparti: [] },
  reparto: { username: 'l.bianchi', nome: 'Luca Bianchi', ruolo: 'reparto', reparti: ['r-degenza'] },
  nuovo: { username: 'f.romano', nome: 'Francesca Romano', ruolo: 'reparto', reparti: ['r-ambulatori'], provvisoria: 'Provvisoria-24' }
};

/* ======================= codici a barre di prova ======================= */

function cifraEan(dodici) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(dodici[i]) * (i % 2 ? 3 : 1);
  return String((10 - (s % 10)) % 10);
}
const EAN_CEFAZOLINA = '801234567890' + cifraEan('801234567890');
const EAN_SIRINGHE = '805123400017' + cifraEan('805123400017');
// Data Matrix GS1 senza separatori (il lotto, variabile, è in fondo): GTIN, scadenza 31/05/2028, lotto
const GS1_CEFAZOLINA = '010' + EAN_CEFAZOLINA + '17280531' + '10C24A07';

/* ======================= utilità ======================= */

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

function portaLibera() {
  return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

async function attendi(cond, ms) {
  const fine = Date.now() + (ms || 8000);
  while (Date.now() < fine) {
    try { if (await cond()) return true; } catch (e) { /* riprovo */ }
    await pausa(150);
  }
  return false;
}

function oggi(piuMesi) {
  const d = new Date();
  if (piuMesi) d.setMonth(d.getMonth() + piuMesi, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function tempoVtt(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor(ms / 60000) % 60;
  const ss = Math.floor(ms / 1000) % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '.' + String(ms % 1000).padStart(3, '0');
}

function ffmpeg(argomenti) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y'].concat(argomenti), { stdio: ['ignore', 'ignore', 'pipe'] });
}

/* ======================= regia dentro la pagina (didascalie, puntatore, titolo) ======================= */

// Si installa in ogni pagina registrata (addInitScript): elementi sopra tutto, che non intercettano i clic.
function installaRegia() {
  if (window.__regia) return;
  const CSS = `
    #regia-strato { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif; }
    #regia-didascalia { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); width: min(1080px, calc(100vw - 56px));
      display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: center; padding: 14px 24px 15px 16px; border-radius: 14px;
      background: rgba(15, 46, 56, .95); color: #fff; box-shadow: 0 12px 34px rgba(0, 0, 0, .35); opacity: 0; transition: opacity .25s ease; }
    #regia-didascalia.alto { bottom: auto; top: 78px; }
    #regia-didascalia.visibile { opacity: 1; }
    #regia-didascalia .n { align-self: start; margin-top: 3px; min-width: 50px; text-align: center; font: 700 15px/1 inherit; font-family: inherit;
      background: #b08d57; color: #fff; border-radius: 999px; padding: 7px 10px; letter-spacing: .02em; }
    #regia-didascalia .t { font-size: 24px; line-height: 1.36; font-weight: 600; text-wrap: pretty; }
    #regia-puntatore { position: absolute; left: 0; top: 0; width: 30px; height: 30px; opacity: 0; transition: opacity .25s;
      transform: translate(640px, 400px); filter: drop-shadow(0 3px 4px rgba(0, 0, 0, .4)); }
    #regia-puntatore.visibile { opacity: 1; }
    .regia-onda { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid #f0b429;
      background: rgba(240, 180, 41, .25); animation: regia-onda .55s ease-out forwards; }
    @keyframes regia-onda { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
    #regia-anello { position: absolute; border: 3px solid #f0b429; border-radius: 10px; opacity: 0; transition: opacity .3s;
      box-shadow: 0 0 0 4px rgba(240, 180, 41, .28), 0 0 22px rgba(240, 180, 41, .55); }
    #regia-anello.visibile { opacity: 1; animation: regia-pulsa 1.4s ease-in-out infinite; }
    @keyframes regia-pulsa { 50% { box-shadow: 0 0 0 7px rgba(240, 180, 41, .18), 0 0 26px rgba(240, 180, 41, .65); } }
    #regia-intro { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 14px; text-align: center;
      background: rgba(15, 46, 56, .9); color: #fff; opacity: 0; transition: opacity .4s ease; }
    #regia-intro.visibile { opacity: 1; }
    #regia-intro .ico { font-size: 92px; line-height: 1.1; }
    #regia-intro .tit { font-size: 50px; font-weight: 700; line-height: 1.15; max-width: 1000px; }
    #regia-intro .sotto { font-size: 20px; color: #e0c48f; letter-spacing: .08em; text-transform: uppercase; }
    #regia-tasto, #regia-lettore { position: absolute; left: 50%; bottom: 150px; transform: translateX(-50%) translateY(6px); opacity: 0;
      transition: opacity .2s, transform .2s; display: flex; gap: 12px; align-items: center; padding: 12px 20px; border-radius: 12px;
      background: rgba(15, 46, 56, .95); color: #fff; font-size: 22px; font-weight: 700; box-shadow: 0 10px 28px rgba(0, 0, 0, .3); }
    #regia-tasto.visibile, #regia-lettore.visibile { opacity: 1; transform: translateX(-50%); }
    #regia-tasto kbd { font: 700 22px/1 "DejaVu Sans Mono", Consolas, monospace; background: #fff; color: #0f2e38; border-radius: 7px; padding: 7px 12px;
      box-shadow: 0 3px 0 #9fb3bb; }
    #regia-lettore .codice { font: 600 16px "DejaVu Sans Mono", Consolas, monospace; color: #b9e3c6; }
    #regia-lettore .bip { background: #1f7a46; border-radius: 999px; padding: 3px 10px; font-size: 15px; }
    /* durante le registrazioni avvisi e invito stanno sopra la didascalia */
    .avvisi { bottom: 132px !important; }
    .tour-invito { bottom: 132px !important; }
  `;
  let strato = null;
  const el = {};
  const pos = { x: 640, y: 420 };
  function monta() {
    if (strato && strato.isConnected) return;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    strato = document.createElement('div');
    strato.id = 'regia-strato';
    strato.innerHTML = '<div id="regia-anello"></div><div id="regia-intro"></div>' +
      '<div id="regia-didascalia"><span class="n"></span><span class="t"></span></div>' +
      '<div id="regia-tasto"></div><div id="regia-lettore"></div>' +
      '<svg id="regia-puntatore" viewBox="0 0 32 32"><path d="M5 2 L5 27 L11.5 21 L16 30.5 L20.5 28.5 L16.2 19.3 L25 19 Z" fill="#fff" stroke="#0f2e38" stroke-width="2" stroke-linejoin="round"/></svg>';
    document.body.appendChild(strato);
    ['anello', 'intro', 'didascalia', 'tasto', 'lettore', 'puntatore'].forEach((k) => { el[k] = document.getElementById('regia-' + k); });
    el.puntatore.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
  }
  const R = {
    errori: [],
    prepara() { monta(); },
    didascalia(testo, n, tot, alto) {
      monta();
      el.didascalia.classList.remove('visibile');
      setTimeout(() => {
        el.didascalia.querySelector('.n').textContent = n + ' / ' + tot;
        el.didascalia.querySelector('.t').textContent = testo;
        el.didascalia.classList.toggle('alto', !!alto);
        el.didascalia.classList.add('visibile');
      }, 180);
    },
    posizione(alto) { monta(); el.didascalia.classList.toggle('alto', !!alto); },
    altaOra() { return !!(el.didascalia && el.didascalia.classList.contains('alto')); },
    nascondiDidascalia() { if (el.didascalia) el.didascalia.classList.remove('visibile'); },
    muovi(x, y, ms) {
      monta();
      el.puntatore.classList.add('visibile');
      el.puntatore.style.transition = 'opacity .25s, transform ' + ms + 'ms cubic-bezier(.45, .05, .25, 1)';
      el.puntatore.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      pos.x = x; pos.y = y;
    },
    dove() { return { x: pos.x, y: pos.y }; },
    premi() {
      monta();
      const o = document.createElement('div');
      o.className = 'regia-onda';
      o.style.left = (pos.x + 5) + 'px';
      o.style.top = (pos.y + 3) + 'px';
      strato.insertBefore(o, el.puntatore);
      setTimeout(() => o.remove(), 700);
    },
    anello(r) {
      monta();
      const m = 6;
      const x = Math.max(4, r.x - m), y = Math.max(4, r.y - m);
      const x2 = Math.min(innerWidth - 4, r.x + r.width + m), y2 = Math.min(innerHeight - 4, r.y + r.height + m);
      Object.assign(el.anello.style, { left: x + 'px', top: y + 'px', width: Math.max(10, x2 - x) + 'px', height: Math.max(10, y2 - y) + 'px' });
      el.anello.classList.add('visibile');
    },
    togliAnello() { if (el.anello) el.anello.classList.remove('visibile'); },
    intro(ico, titolo, sotto) {
      monta();
      el.intro.innerHTML = '<div class="ico"></div><div class="tit"></div><div class="sotto"></div>';
      el.intro.querySelector('.ico').textContent = ico;
      el.intro.querySelector('.tit').textContent = titolo;
      el.intro.querySelector('.sotto').textContent = sotto;
      el.intro.classList.add('visibile');
    },
    fineIntro() { if (el.intro) el.intro.classList.remove('visibile'); },
    tasto(testo) {
      monta();
      el.tasto.innerHTML = testo.split('+').map((t) => '<kbd>' + t.trim() + '</kbd>').join('<span>+</span>');
      el.tasto.classList.add('visibile');
      clearTimeout(R._tt);
      R._tt = setTimeout(() => el.tasto.classList.remove('visibile'), 1500);
    },
    lettore(codice) {
      monta();
      el.lettore.innerHTML = '<span>▮▯▮▮▯▮ Lettore</span><span class="codice"></span><span class="bip">bip!</span>';
      el.lettore.querySelector('.codice').textContent = codice.length > 30 ? codice.slice(0, 28) + '…' : codice;
      el.lettore.classList.add('visibile');
      clearTimeout(R._tl);
      R._tl = setTimeout(() => el.lettore.classList.remove('visibile'), 1700);
    }
  };
  window.__regia = R;
  // gli avvisi d'errore del programma non devono comparire nei video: li segno
  new MutationObserver((lista) => {
    lista.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.nodeType === 1 && n.classList.contains('avviso') && n.classList.contains('errore')) R.errori.push(n.textContent);
    }));
  }).observe(document, { childList: true, subtree: true });
}

/* Regia lato Node: passi, puntatore, clic, scrittura lenta, tempi per i sottotitoli. */
class Regia {
  constructor(page, guida) {
    this.page = page;
    this.g = guida;
    this.n = 0;
    this.tempi = [];
    this.inizio = 0;
  }

  async intro(png) {
    const p = this.page;
    await p.evaluate(() => window.__regia.prepara());
    this.inizio = Date.now();
    await p.evaluate(([ico, tit]) => window.__regia.intro(ico, tit, 'Videoguida · Gestionale Farmacia'), [this.g.ico, this.g.titolo]);
    await pausa(650);
    await p.screenshot({ path: png });
    await pausa(1900);
    await p.evaluate(() => window.__regia.fineIntro());
    await pausa(500);
  }

  /* Un passo della guida: didascalia, azioni, poi resta fermo quanto serve per leggere. */
  async passo(azione, opz) {
    opz = opz || {};
    const i = this.n++;
    const testo = this.g.passi[i];
    if (testo === undefined) throw new Error('lo scenario ha più passi della guida (' + this.g.passi.length + ')');
    const t0 = Date.now();
    await this.page.evaluate(([t, n, tot, alto]) => window.__regia.didascalia(t, n, tot, alto), [testo, i + 1, this.g.passi.length, !!opz.alto]);
    await pausa(1100);
    if (azione) await azione();
    const minimo = Math.min(10000, Math.max(4500, 1800 + testo.length * 62));
    const trascorso = Date.now() - t0;
    if (trascorso < minimo) await pausa(minimo - trascorso);
    await this.page.evaluate(() => window.__regia.togliAnello());
    this.tempi.push({ inizio: (t0 - this.inizio) / 1000, fine: (Date.now() - this.inizio) / 1000, testo: testo });
  }

  async fine() {
    if (this.n !== this.g.passi.length) throw new Error('lo scenario ha ' + this.n + ' passi, la guida ' + this.g.passi.length);
    await this.page.evaluate(() => { window.__regia.nascondiDidascalia(); window.__regia.togliAnello(); });
    await pausa(900);
    this.durata = (Date.now() - this.inizio) / 1000;
    if (this.tempi.length) this.tempi[this.tempi.length - 1].fine = this.durata;
  }

  loc(sel) { return typeof sel === 'string' ? this.page.locator(sel).first() : sel; }

  async el(sel, ms) {
    const l = this.loc(sel);
    try {
      await l.waitFor({ state: 'visible', timeout: ms || 8000 });
    } catch (e) {
      throw new Error('passo ' + this.n + ': non trovo ' + (typeof sel === 'string' ? sel : String(sel)));
    }
    return l;
  }

  /* Porta l'elemento nella zona libera dello schermo (sotto la barra in alto, sopra la didascalia). */
  async inVista(l) {
    let b = await l.boundingBox();
    if (!b) return null;
    if (b.y < 74 || b.y + b.height > ALTO - 150 || b.x < 0 || b.x + b.width > LARGO) {
      await l.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }));
      await pausa(750);
      b = await l.boundingBox();
    }
    return b;
  }

  // la didascalia va in alto se l'elemento resta sotto (per esempio i pulsanti in fondo a una finestra)
  // (conta la parte alta dell'elemento: di un elemento grande basta vedere l'inizio)
  async evitaDidascalia(b) {
    const alta = await this.page.evaluate(() => window.__regia.altaOra());
    const sotto = b.y + Math.min(b.height, 110) > ALTO - 150;
    if (!alta && sotto) await this.page.evaluate(() => window.__regia.posizione(true));
    else if (alta && !sotto && b.y < 230) await this.page.evaluate(() => window.__regia.posizione(false));
  }

  async punta(sel, opz) {
    opz = opz || {};
    const l = await this.el(sel);
    const b = await this.inVista(l);
    if (!b) return l;
    await this.evitaDidascalia(b);
    const fx = opz.fx !== undefined ? opz.fx : (b.width > 260 ? 0.25 : 0.5);
    const fy = opz.fy !== undefined ? opz.fy : 0.5;
    const x = Math.round(b.x + b.width * fx), y = Math.round(b.y + b.height * fy);
    const da = await this.page.evaluate(() => window.__regia.dove());
    const ms = Math.round(Math.min(1050, Math.max(480, Math.hypot(x - da.x, y - da.y) * 1.15)));
    await this.page.evaluate(([a, c, d]) => window.__regia.muovi(a, c, d), [x, y, ms]);
    await pausa(ms + 150);
    return l;
  }

  async clic(sel, opz) {
    opz = opz || {};
    const l = await this.punta(sel, opz);
    await this.page.evaluate(() => window.__regia.premi());
    await pausa(200);
    await l.click();
    await pausa(opz.dopo !== undefined ? opz.dopo : 800);
    return l;
  }

  async scrivi(sel, testo, opz) {
    opz = opz || {};
    const l = await this.clic(sel, { dopo: 250 });
    if (opz.svuota) { await l.fill(''); await pausa(150); }
    await l.pressSequentially(testo, { delay: opz.ritmo || 85 });
    await pausa(opz.dopo !== undefined ? opz.dopo : 450);
    return l;
  }

  // scelta da un elenco a discesa (l'elenco del browser non compare nel video: si vede il valore che cambia)
  async scegli(sel, valore, opz) {
    const l = await this.punta(sel);
    await this.page.evaluate(() => window.__regia.premi());
    await pausa(250);
    await l.selectOption(valore);
    await pausa((opz && opz.dopo) || 900);
    return l;
  }

  async anello(sel, opz) {
    opz = opz || {};
    const l = await this.el(sel);
    const b = await this.inVista(l);
    if (!b) return;
    await this.evitaDidascalia(b);
    await this.page.evaluate((r) => window.__regia.anello(r), b);
    await pausa(opz.dopo !== undefined ? opz.dopo : 1200);
  }

  async togliAnello() { await this.page.evaluate(() => window.__regia.togliAnello()); }

  async tasti(combinazione, etichetta) {
    await this.page.evaluate((t) => window.__regia.tasto(t), etichetta);
    await pausa(550);
    await this.page.keyboard.press(combinazione);
    await pausa(900);
  }

  /* Lettore di codici a barre: raffica di tasti velocissima chiusa da Invio (come un lettore USB in emulazione tastiera). */
  async leggi(codice) {
    await this.page.evaluate((c) => window.__regia.lettore(c), codice);
    await pausa(450);
    await this.page.keyboard.type(codice, { delay: 4 });
    await this.page.keyboard.press('Enter');
    await pausa(1300);
  }

  async menu(pagina) {
    // sul telefono il menu è nascosto; nei video la finestra è larga, il menu c'è sempre
    await this.clic('#menu a[data-pagina="' + pagina + '"]', { dopo: 300 });
    await attendi(() => this.page.evaluate((p) => window.App && App.paginaCorrente === p, pagina), 5000);
    await pausa(900);
  }

  async avviso(testo) {
    const ok = await attendi(() => this.page.evaluate((t) => Array.prototype.some.call(document.querySelectorAll('#avvisi .avviso'), (a) => a.textContent.indexOf(t) >= 0), testo), 6000);
    if (!ok) throw new Error('non è comparso l’avviso «' + testo + '»');
  }
}

/* ======================= scenari (un blocco per passo, nello stesso ordine di Guide.ELENCO[].passi) ======================= */

const SCENARI = {
  'primo-accesso': {
    utente: 'farmacista', daAccesso: true, conInvito: true,
    async gira(R) {
      const p = R.page;
      await R.passo(async () => {
        await R.scrivi('#acc-user', UTENTI.farmacista.username);
        await R.scrivi('#acc-pw', PW, { ritmo: 70 });
        await R.clic('#acc-invia', { dopo: 300 });
        await p.waitForSelector('#app:not([hidden])', { timeout: 15000 });
      });
      await R.passo(async () => {
        const invito = await attendi(async () => (await p.locator('.tour-invito').count()) > 0, 4000);
        if (invito) {
          await R.anello('.tour-invito', { dopo: 2600 });
          await R.togliAnello();
          await R.clic('.tour-invito [data-invito="dopo"]');
        } else {
          await R.anello('#guidami', { dopo: 2000 });
        }
      });
      await R.passo(async () => {
        await R.anello('#menu', { dopo: 900 });
        await R.punta('#menu a[data-pagina="carico"]', { fx: 0.3 });
        await pausa(500);
        await R.punta('#menu a[data-pagina="consumi"]', { fx: 0.3 });
        await pausa(500);
        await R.punta('#menu a[data-pagina="consumi"] kbd');
      });
      await R.passo(async () => {
        await R.anello('.indicatori', { dopo: 1000 });
        await R.punta('.indicatori .indicatore:nth-child(2)');
        await pausa(700);
        await R.punta('.indicatori .indicatore:nth-child(3)');
      });
      await R.passo(async () => {
        await R.tasti('Control+k', 'Ctrl + K');
        await p.keyboard.type('keto', { delay: 160 });
        await pausa(1800);
        await R.tasti('Escape', 'Esc');
      });
      await R.passo(async () => {
        await R.clic('#utente-btn', { dopo: 1800 });
        await R.anello('#utente-tendina', { dopo: 1400 });
        await R.togliAnello();
        await p.keyboard.press('Escape');
      });
      await R.passo(async () => {
        await R.punta('#guidami');
        await R.anello('#guidami');
      });
      await R.passo(async () => {
        await R.menu('guida');
        await R.anello('#guide-griglia', { dopo: 800 });
      });
    }
  },

  carico: {
    utente: 'farmacista',
    async gira(R) {
      const p = R.page;
      await R.passo(async () => {
        await R.menu('carico');
        await R.anello('#contenuto .scheda .modulo');
      });
      await R.passo(async () => {
        await R.scrivi('#t-forn', 'Deposito farmaceutico (prova)', { ritmo: 60 });
        await R.scrivi('#t-doc', 'DDT 1458');
      });
      await R.passo(async () => {
        const art = await R.scrivi('#righe tr:nth-child(1) .r-art', 'CEFAZ', { ritmo: 140, dopo: 600 });
        await art.fill('CEFAZOLINA 1 g fl');
        await pausa(500);
        await R.anello('#righe tr:nth-child(1) .info-riga');
      });
      await R.passo(async () => {
        await R.scrivi('#righe tr:nth-child(1) .r-q', '40');
        await R.scrivi('#righe tr:nth-child(1) .r-lotto', 'C24117');
        const sc = await R.clic('#righe tr:nth-child(1) .r-scad', { dopo: 200 });
        await sc.fill('2027-09');
        await pausa(500);
      });
      await R.passo(async () => {
        await R.anello('#righe tr:nth-child(1) .r-prezzo', { dopo: 1300 });
        await R.togliAnello();
        await R.clic('#righe tr:nth-child(1) .r-lotto', { dopo: 200 });
        await R.tasti('Enter', 'Invio');
        const art = await R.scrivi('#righe tr:nth-child(2) .r-art', 'SIRIN', { ritmo: 140, dopo: 400 });
        await art.fill('SIRINGHE 10 ml');
        await R.scrivi('#righe tr:nth-child(2) .r-q', '300');
        await R.scrivi('#righe tr:nth-child(2) .r-lotto', 'S8891');
      });
      await R.passo(async () => {
        await R.clic('#registra', { dopo: 300 });
        await R.avviso('Carico registrato');
        await pausa(600);
      });
      await R.passo(async () => {
        await R.anello('#recenti .tabella tbody tr:nth-child(1)', { dopo: 1500 });
        await R.punta('#recenti [data-annulla]');
      });
    }
  },

  lettore: {
    utente: 'farmacista', pagina: 'carico', memoria: { 'gf-scanner-modo:carico': 'unita' },
    async prepara(api, dati) {
      const a = dati.articoli.find((x) => x.nome === 'CEFAZOLINA 1 g fl');
      const s = dati.articoli.find((x) => x.nome === 'SIRINGHE 10 ml');
      if (!a || !s) throw new Error('articoli dei dati di prova non trovati');
      const info = Barcode.analizza(GS1_CEFAZOLINA);
      if (info.tipo !== 'gs1' || info.lotto !== 'C24A07' || info.scadenza !== '2028-05') throw new Error('codice GS1 di prova non valido: ' + JSON.stringify(info));
      await chiama(api, 'PUT', 'api/articoli/' + a.id, Object.assign({}, a, { barcode: info.chiavi, pezziConfezione: 10, confezione: '10 fl' }));
      // le siringhe restano senza codice: è il "codice mai visto"
      if (Barcode.analizza(EAN_SIRINGHE).tipo !== 'ean') throw new Error('EAN di prova non valido');
    },
    async gira(R) {
      const p = R.page;
      if (!(await p.locator('.barra-scanner #scanner-campo').count())) throw new Error('la barra di lettura (.barra-scanner) non c’è ancora');
      const riga = (nome) => p.waitForFunction((n) => Array.prototype.some.call(document.querySelectorAll('#righe .r-art'), (i) => i.value === n), nome, { timeout: 4000 });
      const quantita = (nome) => p.evaluate((n) => {
        const i = Array.prototype.filter.call(document.querySelectorAll('#righe .r-art'), (x) => x.value === n)[0];
        return i ? i.closest('tr').querySelector('.r-q').value : '';
      }, nome);
      const rigaDi = async (nome) => {
        const n = await p.evaluate((x) => Array.prototype.findIndex.call(document.querySelectorAll('#righe tr'), (tr) => tr.querySelector('.r-art').value === x), nome);
        return '#righe tr:nth-child(' + (n + 1) + ')';
      };
      await R.passo(async () => {
        await R.anello('.barra-scanner', { dopo: 1500 });
      });
      await R.passo(async () => {
        await R.scegli('#scanner-modo', 'confezione');
        await R.anello('#scanner-modo');
      });
      await R.passo(async () => {
        await p.evaluate(() => document.activeElement && document.activeElement.blur());
        await R.leggi(GS1_CEFAZOLINA);
        await riga('CEFAZOLINA 1 g fl');
        await R.anello(await rigaDi('CEFAZOLINA 1 g fl'), { dopo: 1500 });
      });
      await R.passo(async () => {
        await R.leggi(GS1_CEFAZOLINA);
        if ((await quantita('CEFAZOLINA 1 g fl')) !== '20') throw new Error('la seconda lettura non ha aumentato la quantità');
        await R.anello((await rigaDi('CEFAZOLINA 1 g fl')) + ' .r-q', { dopo: 1500 });
      });
      await R.passo(async () => {
        await R.scrivi('#t-forn', 'Deposito', { ritmo: 110 });
        await R.leggi(GS1_CEFAZOLINA);
        if ((await p.inputValue('#t-forn')) !== 'Deposito') throw new Error('il codice letto è finito nel campo Fornitore');
        await R.anello('#t-forn', { dopo: 1100 });
        await R.togliAnello();
        await R.anello((await rigaDi('CEFAZOLINA 1 g fl')) + ' .r-q', { dopo: 1100 });
      });
      await R.passo(async () => {
        await p.evaluate(() => document.activeElement && document.activeElement.blur());
        await R.leggi(EAN_SIRINGHE);
        await p.waitForSelector('#sc-cerca', { timeout: 4000 });
        await pausa(900);
        await R.scrivi('#sc-cerca', 'siringhe 10', { ritmo: 120, dopo: 700 });
        await R.clic(p.locator('#sc-scelte .scanner-scelta', { hasText: 'SIRINGHE 10 ml' }).first(), { dopo: 300 });
        await riga('SIRINGHE 10 ml');
        await pausa(900);
        await R.anello(await rigaDi('SIRINGHE 10 ml'), { dopo: 1000 });
      }, { alto: true });
      await R.passo(async () => {
        await R.scrivi('#scanner-campo', EAN_SIRINGHE, { ritmo: 95, dopo: 300 });
        await R.tasti('Enter', 'Invio');
        await R.anello((await rigaDi('SIRINGHE 10 ml')) + ' .r-q', { dopo: 1000 });
      });
      await R.passo(async () => {
        if (await p.locator('#scanner-fotocamera').count()) await R.punta('#scanner-fotocamera');
        await R.clic('#registra', { dopo: 300 });
        await R.avviso('Carico registrato');
      });
    }
  },

  consumi: {
    utente: 'reparto',
    async gira(R) {
      const p = R.page;
      await R.passo(async () => {
        await R.menu('consumi');
        await R.punta('#c-data');
        await pausa(500);
        await R.anello('#c-rep');
      });
      await R.passo(async () => {
        await R.scegli('#c-cat', 'FARMACI');
      });
      // tre righe di fila con abbastanza giacenza (così non compare l'avviso di giacenza insufficiente)
      const ids = await p.evaluate(() => {
        const rep = document.getElementById('c-rep').value;
        const campi = Array.prototype.slice.call(document.querySelectorAll('#c-foglio input.q[data-art]'));
        for (let i = 0; i + 2 < campi.length; i++) {
          const tre = campi.slice(i, i + 3).map((c) => c.getAttribute('data-art'));
          if (tre.every((id) => App.giacenza(id, rep) >= 4)) return tre;
        }
        return campi.slice(0, 3).map((c) => c.getAttribute('data-art'));
      });
      const campo = (id) => '#c-foglio input.q[data-art="' + id + '"]';
      await R.passo(async () => {
        await R.scrivi(campo(ids[0]), '2');
        await R.tasti('Enter', 'Invio');
        await p.keyboard.type('1', { delay: 120 });
        await pausa(400);
        await R.tasti('Enter', 'Invio');
        await p.keyboard.type('3', { delay: 120 });
        await pausa(400);
      });
      const rigaPrima = '#c-foglio tbody tr:has(input.q[data-art="' + ids[0] + '"])';
      await R.passo(async () => {
        await R.anello(rigaPrima, { dopo: 1400 });
        await R.punta(rigaPrima + ' td:nth-child(3)');
        await pausa(600);
        await R.punta(rigaPrima + ' td:nth-child(4)');
      });
      await R.passo(async () => {
        await R.clic('#c-registra', { dopo: 300 });
        await R.avviso('Consumi registrati');
      });
      await R.passo(async () => {
        await R.anello('#c-fatti .tabella tbody tr:nth-child(1)', { dopo: 1400 });
        await R.punta('#c-fatti [data-annulla]');
      });
    }
  },

  trasferimenti: {
    utente: 'farmacista',
    async gira(R) {
      const p = R.page;
      await R.passo(async () => {
        await R.menu('trasferimenti');
        await R.anello('#t-da', { dopo: 1000 });
        await R.togliAnello();
        await R.scegli('#t-a', 'r-sala');
      });
      await R.passo(async () => {
        await R.scrivi('#t-note', 'Richiesta n. 87, ritira l’infermiera Russo', { ritmo: 55 });
      });
      const nome = await p.evaluate(() => {
        const far = document.getElementById('t-da').value;
        const a = App.articoliAttivi('FARMACI').filter((x) => App.giacenza(x.id, far) >= 40 && Calcoli.lotti(App.S, x.id, far).filter((l) => l.quantita > 0 && l.lotto).length >= 2)[0] ||
          App.articoliAttivi('FARMACI').filter((x) => App.giacenza(x.id, far) >= 20)[0];
        return a.nome;
      });
      await R.passo(async () => {
        const art = await R.scrivi('#righe tr:nth-child(1) .r-art', nome.slice(0, 5), { ritmo: 140, dopo: 400 });
        await art.fill(nome);
        await pausa(400);
        await R.scrivi('#righe tr:nth-child(1) .r-q', '10');
        await R.anello('#righe tr:nth-child(1) .info-riga');
      });
      await R.passo(async () => {
        const sel = await R.punta('#righe tr:nth-child(1) .r-lotto-scelta');
        await pausa(400);
        const n = await sel.locator('option').count();
        if (n > 1) { await R.page.evaluate(() => window.__regia.premi()); await sel.selectOption({ index: 1 }); }
        await R.anello('#righe tr:nth-child(1) .r-lotto-scelta');
      });
      await R.passo(async () => {
        await R.clic('#registra', { dopo: 300 });
        await R.avviso('Trasferimento registrato');
      });
      await R.passo(async () => {
        await R.anello('#recenti .tabella tbody tr:nth-child(1)', { dopo: 1500 });
        await R.punta('#recenti .tabella tbody tr:nth-child(1) td:nth-child(5)');
      });
    }
  },

  perdite: {
    utente: 'farmacista',
    async prepara(api, dati) {
      const a = dati.articoli.find((x) => x.nome === 'DESAMETASONE 4 mg/1 ml f');
      await chiama(api, 'POST', 'api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(-3).slice(0, 8) + '05', articoloId: a.id, repartoId: 'r-farmacia', quantita: 6, lotto: 'D2309A', scadenza: oggi(-1).slice(0, 7), fornitore: 'Deposito farmaceutico (prova)', documento: 'DDT 77' }] });
    },
    async gira(R) {
      await R.passo(async () => {
        await R.menu('scadenze');
        await R.scegli('#z-entro', '-1');
      });
      await R.passo(async () => {
        await R.anello('#z-tab tbody tr:has([data-perdita*="|D2309A|"])', { dopo: 1300 });
        await R.togliAnello();
        await R.clic('[data-perdita*="|D2309A|"]', { dopo: 300 });
        await R.page.waitForSelector('#righe .r-lotto-scelta', { timeout: 5000 });
        await pausa(600);
      });
      await R.passo(async () => {
        await R.anello('#righe tr:nth-child(1)', { dopo: 1500 });
      });
      await R.passo(async () => {
        await R.anello('#righe tr:nth-child(1) .r-causale', { dopo: 1300 });
        await R.togliAnello();
        await R.scrivi('#righe tr:nth-child(1) .r-note', 'Trovate al controllo mensile', { ritmo: 60 });
      });
      await R.passo(async () => {
        await R.clic('#registra', { dopo: 300 });
        await R.avviso('Perdita registrata');
      });
      await R.passo(async () => {
        await R.anello('#recenti .tabella tbody tr:nth-child(1)', { dopo: 1500 });
      });
    }
  },

  'giacenze-scadenze': {
    utente: 'farmacista',
    // nei dati di prova nessun articolo è sotto scorta: due articoli con la scorta minima un po' sopra la giacenza
    async prepara(api, dati) {
      const g = Calcoli.tutteLeGiacenze(dati);
      for (const nome of ['ENOXAPARINA 4000 UI siringa', 'GUANTI IN NITRILE TG M']) {
        const a = dati.articoli.find((x) => x.nome === nome);
        const q = g[a.id + '|r-farmacia'] || 0;
        await chiama(api, 'PUT', 'api/articoli/' + a.id, Object.assign({}, a, { scortaMinima: Math.ceil(q * 1.25 + 5) }));
      }
    },
    async gira(R) {
      await R.passo(async () => {
        await R.menu('giacenze');
        await R.anello('#g-tab .tabella thead', { dopo: 1300 });
        await R.togliAnello();
        await R.anello('#g-tab .tabella tfoot');
      });
      await R.passo(async () => {
        await R.scegli('#g-rep', 'r-degenza');
        const c = await R.scrivi('#g-cerca', 'cef', { ritmo: 160, dopo: 1500 });
        await c.fill('');
        await R.scegli('#g-rep', '', { dopo: 600 });
      });
      await R.passo(async () => {
        await R.clic('#g-sotto', { dopo: 900 });
        await R.anello('#g-tab .etichetta.pericolo');
      });
      await R.passo(async () => {
        await R.clic('#g-tab tbody tr:nth-child(1) td:nth-child(1)', { dopo: 2400, fx: 0.3 });
        await R.tasti('Escape', 'Esc');
      });
      await R.passo(async () => {
        await R.menu('scadenze');
        await R.anello('#z-tab .tabella tbody tr:nth-child(1)', { dopo: 1200 });
      });
      await R.passo(async () => {
        await R.scegli('#z-entro', '180');
        await R.punta('#z-stampa');
        await pausa(500);
        await R.punta('#z-excel');
      });
    }
  },

  movimenti: {
    utente: 'farmacista',
    async prepara(api, dati, ctx) {
      const a = dati.articoli.find((x) => x.nome === 'KETOROLAC 30 mg/ml f');
      const r = await chiama(ctx.farmacista, 'POST', 'api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(), articoloId: a.id, repartoId: 'r-farmacia', quantita: 400, lotto: 'K5521', scadenza: '2027-11', fornitore: 'Deposito farmaceutico (prova)', documento: 'DDT 2231' }] });
      this.idSbagliato = r.movimenti[0].id;
    },
    async gira(R) {
      const id = this.idSbagliato;
      await R.passo(async () => {
        await R.menu('movimenti');
        await R.anello('#v-tab .tabella thead');
      });
      await R.passo(async () => {
        await R.scegli('#v-tipo', 'carico');
        await R.scrivi('#v-cerca', 'keto', { ritmo: 150, dopo: 800 });
      });
      await R.passo(async () => {
        await R.anello('#v-tab tbody tr:has([data-annulla="' + id + '"])', { dopo: 1200 });
        await R.togliAnello();
        await R.clic('[data-annulla="' + id + '"]', { dopo: 600 });
      });
      await R.passo(async () => {
        await R.scrivi('#chiedi-testo', 'Quantità sbagliata: erano 40', { ritmo: 60 });
        await R.clic('#chiedi-ok', { dopo: 300 });
        await R.avviso('Movimento annullato');
      });
      await R.passo(async () => {
        await R.anello('#v-tab tbody tr.annullato', { dopo: 1500 });
      });
      await R.passo(async () => {
        await R.punta('#v-excel');
        await R.anello('#v-excel');
      });
    }
  },

  inventario: {
    utente: 'farmacista',
    async gira(R) {
      const p = R.page;
      await R.passo(async () => {
        await R.menu('inventario');
        await R.punta('#i-data');
        await pausa(400);
        await R.punta('#i-rep');
        await pausa(300);
        await R.scegli('#i-cat', 'PRESIDI');
      });
      await R.passo(async () => {
        await R.punta('#i-stampa');
        await R.anello('#i-stampa');
      });
      const teoriche = await p.$$eval('#i-tab input.q[data-teorica]', (l) => l.slice(0, 2).map((i) => Number(i.getAttribute('data-teorica'))));
      await R.passo(async () => {
        const v1 = teoriche[0] >= 2 ? teoriche[0] - 2 : teoriche[0] + 3;
        await R.scrivi('#i-tab tbody tr:nth-child(1) input.q', String(v1));
        await R.anello('#i-tab tbody tr:nth-child(1) .diff', { dopo: 900 });
        await R.togliAnello();
        await R.scrivi('#i-tab tbody tr:nth-child(2) input.q', String(teoriche[1]));
        await R.anello('#i-tab tbody tr:nth-child(2) .diff', { dopo: 900 });
      });
      await R.passo(async () => {
        await R.anello('#i-tab tbody tr:nth-child(3)', { dopo: 1500 });
      });
      await R.passo(async () => {
        await R.clic('#i-registra', { dopo: 900 });
        await R.clic('#conferma-si', { dopo: 300 });
        await R.avviso('Inventario registrato');
      });
      await R.passo(async () => {
        await R.menu('movimenti');
        await R.scegli('#v-tipo', 'rettifica');
        await R.anello('#v-tab tbody tr:nth-child(1)');
      });
    }
  },

  'nota-consumi': {
    utente: 'farmacista',
    async gira(R) {
      const p = R.page;
      const giorno = new Date().getDate();
      await R.passo(async () => {
        await R.menu('registro');
        await R.scegli('#r-rep', 'r-degenza');
        await R.scegli('#r-cat', 'FARMACI');
      });
      await R.passo(async () => {
        await R.anello('#r-tab .registro thead', { dopo: 1300 });
        await R.togliAnello();
        await p.evaluate(() => document.querySelector('.registro-contenitore').scrollTo({ left: 5000, behavior: 'smooth' }));
        await pausa(1800);
        await p.evaluate(() => document.querySelector('.registro-contenitore').scrollTo({ left: 0, behavior: 'smooth' }));
        await pausa(1200);
      });
      const cella = '#r-tab tbody tr:nth-child(1) input[data-giorno="' + giorno + '"]';
      await R.passo(async () => {
        await p.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }), cella);
        await pausa(900);
        const prima = Number((await p.inputValue(cella)).replace(',', '.')) || 0;
        await R.clic(cella, { dopo: 300 });
        await p.keyboard.type(String(prima + 2), { delay: 150 });
        await pausa(500);
        await R.tasti('Enter', 'Invio');
      });
      await R.passo(async () => {
        await pausa(600);
        await R.anello('#r-tab tbody tr:nth-child(1) td.tot', { dopo: 1000 });
        await R.togliAnello();
        await p.evaluate(() => document.querySelector('.registro-contenitore').scrollTo({ left: 5000, behavior: 'smooth' }));
        await pausa(1300);
        await R.anello('#r-tab tbody tr:nth-child(1) td.tot >> nth=2', { dopo: 1000 });
      });
      await R.passo(async () => {
        await R.clic('#r-excel', { dopo: 300 });
        await R.avviso('Modulo Excel creato');
      });
      await R.passo(async () => {
        await R.punta('#r-stampa');
        await R.anello('#r-stampa');
      });
    }
  },

  articoli: {
    utente: 'farmacista',
    async gira(R) {
      const p = R.page;
      await R.passo(async () => {
        await R.menu('articoli');
        await R.scrivi('#a-cerca', 'paraceta', { ritmo: 140, dopo: 1000 });
      });
      await R.passo(async () => {
        await R.clic('#a-tab tbody tr:nth-child(1) td:nth-child(1)', { dopo: 2600, fx: 0.3 });
        await R.tasti('Escape', 'Esc');
        await p.fill('#a-cerca', '');
      });
      await R.passo(async () => {
        await R.clic('#a-nuovo', { dopo: 700 });
        await R.scrivi('#fa-nome', 'IBUPROFENE 400 mg cpr', { ritmo: 70 });
      });
      await R.passo(async () => {
        await R.scegli('#fa-cat', 'FARMACI', { dopo: 400 });
        await R.scrivi('#fa-unita', 'cpr', { ritmo: 110 });
        await R.scrivi('#fa-principio', 'Ibuprofene', { ritmo: 70 });
        await R.scrivi('#fa-confezione', '30 cpr', { ritmo: 90 });
      });
      await R.passo(async () => {
        await R.scrivi('#fa-pezzi', '30', { svuota: true });
        await R.anello('#fa-codici', { dopo: 900 });
        await R.togliAnello();
        await R.scrivi('#fa-prezzo', '0,12');
        await R.scrivi('#fa-scorta', '60');
      });
      await R.passo(async () => {
        await R.clic('#fa-salva', { dopo: 300 });
        await R.avviso('Articolo creato');
      });
      await R.passo(async () => {
        await R.punta('#a-importa');
        await R.anello('#a-importa');
      });
    }
  },

  utenti: {
    utente: 'admin',
    async gira(R) {
      const p = R.page;
      await R.passo(async () => {
        await R.menu('utenti');
        await R.anello('#contenuto .banda.info', { dopo: 1500 });
      });
      await R.passo(async () => {
        await R.clic('#u-nuovo', { dopo: 700 });
        await R.scrivi('#u-username', 'a.russo', { ritmo: 110 });
        await R.scrivi('#u-nome', 'Anna Russo', { ritmo: 90 });
      });
      await R.passo(async () => {
        await R.scegli('#u-ruolo', 'reparto', { dopo: 500 });
        await R.clic('.u-rep[value="r-sala"]', { dopo: 700 });
      });
      await R.passo(async () => {
        await R.clic('[data-genera="u-password"]', { dopo: 600 });
        await R.anello('#u-password');
      });
      await R.passo(async () => {
        await R.clic('#u-salva', { dopo: 300 });
        await R.avviso('creato');
        await p.waitForSelector('#u-tab td:has-text("a.russo")', { timeout: 5000 });
        await R.anello('#u-tab tbody tr:has-text("a.russo")', { dopo: 1200 });
      }, { alto: true });
      await R.passo(async () => {
        await R.punta('#u-tab tbody tr:has-text("a.russo") [data-password]');
        await pausa(900);
        await R.punta('#u-tab tbody tr:has-text("a.russo") [data-modifica]');
      });
    }
  },

  copie: {
    utente: 'admin',
    async prepara(api) {
      await chiama(api, 'POST', 'api/backup', {});
    },
    async gira(R) {
      await R.passo(async () => {
        await R.menu('configura');
        await R.anello('section.scheda:has(#k-backup)', { dopo: 1300 });
      });
      await R.passo(async () => {
        await R.page.waitForSelector('#k-backup .tabella', { timeout: 6000 });
        await R.anello('#k-backup .tabella', { dopo: 1500 });
      });
      await R.passo(async () => {
        await R.clic('#k-backup-crea', { dopo: 300 });
        await R.avviso('Copia creata');
        await pausa(800);
        await R.anello('#k-backup .tabella tbody tr:nth-child(1)');
      });
      await R.passo(async () => {
        await R.punta('#k-backup tbody tr:nth-child(1) a.btn[download]');
        await R.anello('#k-backup tbody tr:nth-child(1) a.btn[download]');
      });
      await R.passo(async () => {
        await R.clic('#k-backup tbody tr:nth-child(1) [data-ripristina]', { dopo: 900 });
      });
      await R.passo(async () => {
        await R.anello('#forte-parola', { dopo: 3200 });
        await R.togliAnello();
        await R.clic('#modale .modale-piede [data-chiudi]');
      }, { alto: true });
    }
  },

  password: {
    utente: 'nuovo', daAccesso: true,
    async gira(R) {
      const p = R.page;
      const prima = PW + '!';
      const dopo = PW + '?';
      await R.passo(async () => {
        await R.scrivi('#acc-user', UTENTI.nuovo.username, { ritmo: 100 });
        await R.scrivi('#acc-pw', UTENTI.nuovo.provvisoria, { ritmo: 80 });
        await R.clic('#acc-invia', { dopo: 300 });
        await p.waitForSelector('#acc-attuale', { timeout: 8000 });
      });
      await R.passo(async () => {
        await R.scrivi('#acc-attuale', UTENTI.nuovo.provvisoria, { ritmo: 60 });
        await R.scrivi('#acc-pw', prima, { ritmo: 55 });
        await R.scrivi('#acc-pw2', prima, { ritmo: 55 });
        await R.clic('#acc-invia', { dopo: 300 });
        await p.waitForSelector('#app:not([hidden])', { timeout: 10000 });
      });
      await R.passo(async () => {
        await pausa(500);
        await R.clic('#utente-btn', { dopo: 900 });
        await R.clic('#utente-password', { dopo: 700 });
      });
      await R.passo(async () => {
        await R.scrivi('#cp-attuale', prima, { ritmo: 55 });
        await R.scrivi('#cp-nuova', dopo, { ritmo: 55 });
        await R.scrivi('#cp-ripeti', dopo, { ritmo: 55 });
        await R.clic('#cp-salva', { dopo: 300 });
        await R.avviso('Password cambiata');
      });
      await R.passo(async () => {
        await R.clic('#utente-btn', { dopo: 900 });
        await R.clic('#utente-esci', { dopo: 300 });
        await p.waitForSelector('#acc-form', { timeout: 8000 });
      });
      await R.passo(async () => {
        await R.anello('.accesso-scheda', { dopo: 1500 });
      });
    }
  }
};

/* ======================= server, utenti e dati di prova ======================= */

async function chiama(api, metodo, url, corpo) {
  const r = await api.fetch(url, { method: metodo, data: corpo, headers: { 'X-Richiesta': '1' } });
  const testo = await r.text();
  let j = null;
  try { j = JSON.parse(testo); } catch (e) { /* non JSON */ }
  if (!r.ok()) throw new Error(metodo + ' ' + url + ': ' + r.status() + ' ' + ((j && j.errore) || testo.slice(0, 200)));
  return j;
}

async function preparaServer(browser, base) {
  // amministratore (dal server stesso), dati di prova, utenti con la password già scelta
  const ctxAdmin = await browser.newContext();
  const admin = ctxAdmin.request;
  await chiama(admin, 'POST', base + 'api/setup', { username: UTENTI.admin.username, nome: UTENTI.admin.nome, password: PW });
  await chiama(admin, 'POST', base + 'api/demo', {});
  const ids = {};
  const stato = await chiama(admin, 'GET', base + 'api/stato');
  ids.admin = stato.utente.id;
  const contesti = { admin: ctxAdmin };
  for (const k of ['farmacista', 'reparto', 'nuovo']) {
    const u = UTENTI[k];
    const provvisoria = u.provvisoria || 'Provvisoria-1';
    const r = await chiama(admin, 'POST', base + 'api/utenti', { username: u.username, nome: u.nome, ruolo: u.ruolo, reparti: u.reparti, password: provvisoria });
    ids[k] = r.utente.id;
    if (u.provvisoria) continue;
    const c = await browser.newContext();
    await chiama(c.request, 'POST', base + 'api/login', { username: u.username, password: provvisoria });
    await chiama(c.request, 'POST', base + 'api/password', { attuale: provvisoria, nuova: PW });
    await chiama(c.request, 'POST', base + 'api/login', { username: u.username, password: PW });
    contesti[k] = c;
  }
  return { ids, contesti };
}

async function datiCorrenti(api, base) {
  return chiama(api, 'GET', base + 'api/dati?da=0');
}

/* ======================= una guida ======================= */

async function registra(browser, base, g, scenario, srv, lavoro) {
  const dir = path.join(lavoro, g.id);
  fs.mkdirSync(dir, { recursive: true });
  const api = srv.contesti.admin.request;
  const dati = await datiCorrenti(api, base);
  if (scenario.prepara) {
    const ctxApi = {};
    Object.keys(srv.contesti).forEach((k) => { ctxApi[k] = srv.contesti[k].request; });
    await scenario.prepara.call(scenario, apiBase(api, base), dati, mappa(ctxApi, (r) => apiBase(r, base)));
  }

  const ctx = await browser.newContext({
    viewport: { width: LARGO, height: ALTO },
    recordVideo: { dir: dir, size: { width: LARGO, height: ALTO } },
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    bypassCSP: true,
    acceptDownloads: true
  });
  const errori = [];
  try {
    await ctx.addInitScript(installaRegia);
    // niente invito al giro guidato (tranne nella guida del primo accesso) e scelte del lettore come all'inizio
    const memoria = Object.assign({}, scenario.memoria || {});
    if (!scenario.conInvito) Object.keys(srv.ids).forEach((k) => { memoria['gf-giro-invito:' + srv.ids[k]] = 'mai'; });
    await ctx.addInitScript((m) => {
      try {
        if (location.protocol.indexOf('http') !== 0 || sessionStorage.getItem('__regia-memoria')) return;
        Object.keys(m).forEach((k) => localStorage.setItem(k, m[k]));
        sessionStorage.setItem('__regia-memoria', '1');
      } catch (e) { /* pagina senza memoria (about:blank) */ }
    }, memoria);
    const u = UTENTI[scenario.utente];
    if (!scenario.daAccesso) await chiama(ctx.request, 'POST', base + 'api/login', { username: u.username, password: PW });

    const page = await ctx.newPage();
    const creata = Date.now();
    page.on('pageerror', (e) => errori.push('eccezione: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errori.push('console: ' + m.text()); });
    await page.goto(base + '#' + (scenario.pagina || 'oggi'));
    if (scenario.daAccesso) await page.waitForSelector('#acc-form', { timeout: 15000 });
    else await page.waitForSelector('#app:not([hidden]) #contenuto > *', { timeout: 15000 });
    await pausa(900);

    const R = new Regia(page, g);
    const png = path.join(dir, 'copertina.png');
    await R.intro(png);
    await scenario.gira.call(scenario, R);
    await R.fine();
    const avvisi = await page.evaluate(() => window.__regia.errori.slice());
    avvisi.forEach((t) => errori.push('avviso d’errore nella pagina: ' + t));
    const offset = (R.inizio - creata) / 1000;
    const video = page.video();
    await ctx.close();
    const grezzo = await video.path();
    if (errori.length) throw new Error(errori.join(' | '));
    return { grezzo, png, offset, durata: R.durata, tempi: R.tempi };
  } catch (e) {
    await ctx.close().catch(() => {});
    if (errori.length && e.message.indexOf(errori[0]) < 0) e.message += ' (' + errori.join(' | ') + ')';
    throw e;
  }
}

function apiBase(req, base) {
  return { fetch: (url, o) => req.fetch(/^https?:/.test(url) ? url : base + url, o) };
}

function mappa(o, f) { const x = {}; Object.keys(o).forEach((k) => { x[k] = f(o[k]); }); return x; }

/* Video grezzo (WebM di Playwright) → MP4 H.264 al massimo di 2 MB, copertina JPG, sottotitoli WebVTT. */
function converti(g, reg, lavoro) {
  const tmp = path.join(lavoro, g.id, g.id + '.mp4');
  let crf = 30;
  let dim = 0;
  for (;;) {
    ffmpeg(['-ss', reg.offset.toFixed(3), '-i', reg.grezzo, '-t', reg.durata.toFixed(3),
      '-vf', 'fps=25,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-tune', 'stillimage', '-crf', String(crf),
      '-x264-params', 'keyint=250:min-keyint=25', '-movflags', '+faststart', '-an', tmp]);
    dim = fs.statSync(tmp).size;
    if (dim <= MAX_BYTE || crf >= 38) break;
    crf += 2;
  }
  const jpg = path.join(lavoro, g.id, g.id + '.jpg');
  ffmpeg(['-i', reg.png, '-vf', 'scale=640:360:flags=lanczos', '-q:v', '4', jpg]);
  const vtt = 'WEBVTT\n\n' + reg.tempi.map((t, i) => (i + 1) + '\n' + tempoVtt(t.inizio) + ' --> ' + tempoVtt(t.fine) + '\n' + t.testo + '\n').join('\n');
  fs.mkdirSync(USCITA, { recursive: true });
  fs.copyFileSync(tmp, path.join(USCITA, g.id + '.mp4'));
  fs.copyFileSync(jpg, path.join(USCITA, g.id + '.jpg'));
  fs.writeFileSync(path.join(USCITA, g.id + '.vtt'), vtt);
  return { crf, dim };
}

/* ======================= avvio ======================= */

(async () => {
  try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); } catch (e) {
    console.error('Serve ffmpeg (opzione --ffmpeg <percorso>).');
    process.exit(1);
  }
  const elenco = Guide.ELENCO.filter((g) => !SOLO.length || SOLO.indexOf(g.id) >= 0);
  const sconosciute = SOLO.filter((id) => !Guide.ELENCO.some((g) => g.id === id));
  if (sconosciute.length) { console.error('Guide sconosciute: ' + sconosciute.join(', ')); process.exit(1); }

  const lavoro = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-videoguide-'));
  const datiDir = path.join(lavoro, 'dati');
  const porta = await portaLibera();
  const log = fs.openSync(path.join(lavoro, 'server.log'), 'a');
  const proc = spawn(process.execPath, [path.join(RADICE, 'server', 'main.js'), '--porta', String(porta), '--dati', datiDir], { stdio: ['ignore', log, log] });
  const base = 'http://127.0.0.1:' + porta + '/';
  let esito = 0;
  let browser = null;
  try {
    const pronto = await attendi(async () => { try { return (await fetch(base + 'api/stato')).ok; } catch (e) { return false; } }, 20000);
    if (!pronto) throw new Error('il server non è partito (log in ' + lavoro + ')');
    // date e mesi nei campi del browser all'italiana (31/10/2026, "settembre 2027"): serve la lingua del processo
    browser = await chromium.launch({ args: ['--lang=it-IT'], env: Object.assign({}, process.env, { LANG: 'it_IT.UTF-8', LANGUAGE: 'it' }) });
    const srv = await preparaServer(browser, base);
    console.log('Server di prova su ' + base + ', dati in ' + datiDir);
    const righe = [];
    for (const g of elenco) {
      const scenario = SCENARI[g.id];
      if (!scenario) { righe.push([g.id, 'SENZA SCENARIO', '']); esito = 1; continue; }
      process.stdout.write('· ' + g.id + ' … ');
      try {
        const reg = await registra(browser, base, g, scenario, srv, lavoro);
        const c = converti(g, reg, lavoro);
        const durata = Math.round(reg.durata);
        const nota = (durata < 30 || durata > 75 ? ' (fuori dai 30–75 s)' : '') + (c.dim > MAX_BYTE ? ' (oltre 2 MB)' : '');
        console.log('fatto: ' + durata + ' s, ' + Math.round(c.dim / 1024) + ' KB, CRF ' + c.crf + nota);
        righe.push([g.id, 'ok', durata + ' s · ' + Math.round(c.dim / 1024) + ' KB' + nota]);
      } catch (e) {
        console.log('NON RIUSCITA');
        console.log('    ' + e.message.split('\n')[0]);
        righe.push([g.id, 'non riuscita', e.message.split('\n')[0]]);
        esito = 1;
      }
    }
    console.log('\nRiepilogo');
    righe.forEach((r) => console.log('  ' + r[0].padEnd(20) + r[1].padEnd(16) + r[2]));
  } catch (e) {
    console.error('Errore: ' + (e && e.stack || e));
    esito = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    proc.kill();
    if (!TIENI) { await pausa(400); fs.rmSync(lavoro, { recursive: true, force: true }); } else console.log('Cartella di lavoro: ' + lavoro);
  }
  process.exit(esito);
})();
