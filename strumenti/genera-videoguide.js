/*
 * Genera le VIDEOGUIDE della pagina Guida (cartella guide/): per ogni guida di js/guide.js (Guide.ELENCO, 26 guide)
 *   - avvia il server vero con una cartella dati temporanea, crea l'amministratore, carica i dati di prova
 *     (POST /api/demo) e con l'API, come farebbero gli utenti, prepara una struttura "vissuta": magazzini su tre piani,
 *     armadi con frigorifero e cassaforte, assortimenti con le scorte, richieste e DDT in ogni stato, consumi di oggi,
 *     utenti di tutti i ruoli (uno con la verifica in due passaggi), una copia verificata;
 *   - MARCHIO NEUTRO: i video finiscono anche nell'anteprima pubblica, quindi durante la registrazione il programma si
 *     chiama «Pharmacy», la struttura «Clinica Demo» («Ospedale di prova»), senza logo (PUT /api/impostazioni), e il
 *     marchio incorporato (brand/) non si carica (al suo posto il programma mostra il simbolo neutro). Durante la
 *     registrazione la pagina controlla ogni 400 ms che sullo schermo non entri il nome di una struttura reale (VIETATI):
 *     se succede, la guida non riesce;
 *   - registra con Playwright (recordVideo, 1280×720) uno scenario dimostrativo sul percorso vero della pagina: una
 *     didascalia grande in basso per ogni passo della guida (proprio i testi di Guide.ELENCO[].passi), un puntatore che
 *     va sull'elemento prima di ogni clic, un anello sull'elemento di cui si parla, ritmo calmo (40–90 s per guida);
 *   - con ffmpeg crea guide/<id>.mp4 (H.264, yuv420p, +faststart, CRF ~30, al massimo 2 MB se si può), la copertina
 *     guide/<id>.jpg e i sottotitoli guide/<id>.vtt con i tempi dei passi. La pagina Guida confronta i testi del .vtt con
 *     i passi scritti (js/guide.js, videoAggiornato): se coincidono il video è "aggiornato", altrimenti "versione
 *     precedente". Cambiato il testo di un passo, si rigenera quel video.
 *
 *   node strumenti/genera-videoguide.js [--solo id1,id2] [--ffmpeg /percorso/ffmpeg] [--tieni] [--lavoro <cartella>]
 *
 * --solo rigenera solo alcune guide; --tieni lascia la cartella di lavoro (video grezzi, dati, log del server);
 * --lavoro sceglie dove mettere la cartella di lavoro (predefinita: la cartella temporanea del sistema).
 * Gli scenari usano i selettori veri delle pagine: se una pagina cambia, si rigenera il suo video. Una guida il cui
 * scenario non riesce resta con il video di prima (e lo strumento esce con errore). Il video del primo accesso mostra
 * la pagina Guida con le schede dei video: rifatti altri video, conviene rigenerare anche quello (per ultimo).
 * Richiesto come modulo (require) non registra niente: esporta preparaServer e le costanti, per le prove.
 */
'use strict';

// le date di oggi uguali per lo strumento, il server di prova e il browser (che registra con l'ora italiana)
if (!process.env.TZ) process.env.TZ = 'Europe/Rome';

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
const Totp = require('../js/totp.js');
const Demo = require('../js/demo.js');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const SOLO = (arg('--solo') || '').split(',').map((s) => s.trim()).filter(Boolean);
const FFMPEG = arg('--ffmpeg') || (fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg');
const TIENI = process.argv.includes('--tieni');
const LAVORO = arg('--lavoro');

const LARGO = 1280;
const ALTO = 720;
const MAX_BYTE = 2 * 1024 * 1024;
const DURATA_MIN = 40;
const DURATA_MAX = 90;
const PW = 'Farmacia-Prova-24';

/* Marchio neutro durante le registrazioni (docs/NOVITA-3.0.md, "Anteprima pubblicata"). */
const NEUTRO = {
  nomeProdotto: 'Pharmacy', sigla: 'Pharmacy', struttura: 'Clinica Demo', sottotitolo: 'Ospedale di prova',
  societa: 'Società Demo S.r.l.', citta: 'Città Demo', codiceModulo: 'MOD-DEMO 1.0', logo: 'nessuno', coloreAccento: '', tema: 'automatico'
};
// nomi veri che non devono mai comparire nei video (gli stessi controllati dall'anteprima)
const VIETATI = /nefro\s*center|posillipo|longevity|me\.mi\.\s*srl|sanseverino/i;

/* Utenti delle registrazioni. Chi ha "provvisoria" non ha ancora scelto la sua password (primo accesso). */
const UTENTI = {
  admin: { username: 'g.rossi', nome: 'Giovanni Rossi', ruolo: 'amministratore' },
  farmacista: { username: 'm.esposito', nome: 'Maria Esposito', ruolo: 'farmacista', reparti: [] },
  reparto: { username: 'l.bianchi', nome: 'Luca Bianchi', ruolo: 'reparto', reparti: ['r-degenza'] },
  sala: { username: 'g.conti', nome: 'Giulia Conti', ruolo: 'reparto', reparti: ['r-sala'] },
  direzione: { username: 'd.ferri', nome: 'Dora Ferri', ruolo: 'consultazione', reparti: [] },
  // secondo amministratore, con la verifica in due passaggi già attiva (cambia il criterio per le registrazioni)
  tecnico: { username: 'p.villa', nome: 'Paolo Villa', ruolo: 'amministratore', dueFattori: true },
  nuovo: { username: 'f.romano', nome: 'Francesca Romano', ruolo: 'reparto', reparti: ['r-ambulatori'], provvisoria: 'Provvisoria-24' },
  esordiente: { username: 's.marino', nome: 'Sara Marino', ruolo: 'farmacista', reparti: [], provvisoria: 'Benvenuta-2026' }
};
const PORTATORE = 'Antonio De Luca'; // chi porta la merce: non è un utente del programma

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

function data(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function oggi() { return data(new Date()); }
function giorniFa(n) { const d = new Date(); d.setDate(d.getDate() - n); return data(d); }
function meseTra(n) { const d = new Date(); d.setMonth(d.getMonth() + n, 1); return data(d).slice(0, 7); }

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

/* Codice TOTP dell'app per una chiave (anche con gli spazi della chiave mostrata): se il codice sta per cambiare
   (meno di 5 secondi), aspetta il successivo, così non scade mentre lo si scrive. */
async function codiceApp(chiave) {
  const resto = 30000 - (Date.now() % 30000);
  if (resto < 5000) await pausa(resto + 300);
  return Totp.totp(String(chiave).replace(/\s+/g, '').toUpperCase(), Date.now());
}

/* ======================= regia dentro la pagina (didascalie, puntatore, titolo) ======================= */

// Si installa in ogni pagina registrata (addInitScript): elementi sopra tutto, che non intercettano i clic.
function installaRegia() {
  if (window.__regia) return;
  const CSS = `
    #regia-strato { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; font-family: Inter, "Segoe UI", system-ui, Arial, sans-serif; }
    #regia-didascalia { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); width: min(1100px, calc(100vw - 56px));
      display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: center; padding: 14px 24px 15px 16px; border-radius: 14px;
      background: rgba(18, 36, 74, .96); color: #fff; box-shadow: 0 14px 36px rgba(8, 18, 40, .38); border-left: 5px solid #E10717;
      opacity: 0; transition: opacity .25s ease; }
    #regia-didascalia.alto { bottom: auto; top: 76px; }
    #regia-didascalia.visibile { opacity: 1; }
    #regia-didascalia .n { align-self: start; margin-top: 3px; min-width: 54px; text-align: center; font: 700 15px/1 Inter, system-ui, sans-serif;
      background: #E10717; color: #fff; border-radius: 999px; padding: 7px 10px; letter-spacing: .02em; }
    #regia-didascalia .t { font-size: 23px; line-height: 1.38; font-weight: 600; text-wrap: pretty; }
    #regia-puntatore { position: absolute; left: 0; top: 0; width: 34px; height: 34px; opacity: 0; transition: opacity .25s;
      transform: translate(640px, 400px); filter: drop-shadow(0 3px 5px rgba(0, 0, 0, .45)); }
    #regia-puntatore.visibile { opacity: 1; }
    .regia-onda { position: absolute; width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%; border: 3px solid #f0b429;
      background: rgba(240, 180, 41, .28); animation: regia-onda .6s ease-out forwards; }
    @keyframes regia-onda { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
    #regia-anello { position: absolute; border: 3px solid #f0b429; border-radius: 10px; opacity: 0; transition: opacity .3s;
      box-shadow: 0 0 0 4px rgba(240, 180, 41, .28), 0 0 22px rgba(240, 180, 41, .55); }
    #regia-anello.visibile { opacity: 1; animation: regia-pulsa 1.4s ease-in-out infinite; }
    @keyframes regia-pulsa { 50% { box-shadow: 0 0 0 7px rgba(240, 180, 41, .18), 0 0 26px rgba(240, 180, 41, .65); } }
    #regia-intro { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 14px; text-align: center;
      background: radial-gradient(circle at 50% 40%, rgba(28, 65, 132, .93), rgba(18, 36, 74, .97)); color: #fff; opacity: 0; transition: opacity .4s ease; }
    #regia-intro.visibile { opacity: 1; }
    #regia-intro.subito { transition: none; }
    #regia-intro .ico { font-size: 88px; line-height: 1.1; }
    #regia-intro .tit { font-size: 48px; font-weight: 700; line-height: 1.15; max-width: 1040px; letter-spacing: -.01em; }
    #regia-intro .sotto { font-size: 19px; color: #ffb3b8; letter-spacing: .1em; text-transform: uppercase; font-weight: 600; }
    #regia-intro .riga { width: 64px; height: 4px; border-radius: 2px; background: #E10717; }
    #regia-tasto, #regia-lettore { position: absolute; left: 50%; bottom: 150px; transform: translateX(-50%) translateY(6px); opacity: 0;
      transition: opacity .2s, transform .2s; display: flex; gap: 12px; align-items: center; padding: 12px 20px; border-radius: 12px;
      background: rgba(18, 36, 74, .96); color: #fff; font-size: 22px; font-weight: 700; box-shadow: 0 10px 28px rgba(0, 0, 0, .3); }
    #regia-tasto.visibile, #regia-lettore.visibile { opacity: 1; transform: translateX(-50%); }
    #regia-tasto kbd { font: 700 22px/1 "JetBrains Mono", "DejaVu Sans Mono", Consolas, monospace; background: #fff; color: #12244A; border-radius: 7px; padding: 7px 12px;
      box-shadow: 0 3px 0 #9fb0cc; }
    #regia-lettore .codice { font: 600 16px "JetBrains Mono", "DejaVu Sans Mono", Consolas, monospace; color: #b9e3c6; }
    #regia-lettore .bip { background: #1F7A46; border-radius: 999px; padding: 3px 10px; font-size: 15px; }
    #regia-barra { position: absolute; left: 0; right: 0; top: 0; height: 58px; display: flex; align-items: center; gap: 14px; padding: 0 18px;
      background: #dfe3ea; border-bottom: 1px solid #b9c1ce; box-shadow: 0 6px 18px rgba(0, 0, 0, .18); opacity: 0; transition: opacity .3s; color: #1d2330; }
    #regia-barra.visibile { opacity: 1; }
    #regia-barra .tondi { display: flex; gap: 8px; } #regia-barra .tondi i { width: 13px; height: 13px; border-radius: 50%; background: #c8ced8; display: block; }
    #regia-barra .frecce { font-size: 20px; color: #6b7383; letter-spacing: 10px; }
    #regia-barra .campo { flex: 1; height: 38px; border-radius: 19px; background: #fff; display: flex; align-items: center; gap: 10px; padding: 0 16px;
      font: 500 18px Inter, system-ui, sans-serif; border: 2px solid transparent; }
    #regia-barra .campo.fuoco { border-color: #1C4184; }
    #regia-barra .lucchetto { color: #6b7383; font-size: 16px; }
    #regia-barra .cursore { display: inline-block; width: 2px; height: 22px; background: #1C4184; margin-left: -8px; animation: regia-cursore 1s steps(1) infinite; }
    @keyframes regia-cursore { 50% { opacity: 0; } }
    #regia-barra .stella { font-size: 24px; color: #6b7383; transition: color .3s, transform .3s; }
    #regia-barra .stella.piena { color: #E8A317; transform: scale(1.25); }
    #regia-barra .preferito { position: absolute; right: 16px; top: 64px; background: #fff; color: #1d2330; border-radius: 10px; padding: 12px 16px;
      font: 600 16px Inter, system-ui, sans-serif; box-shadow: 0 10px 26px rgba(0, 0, 0, .25); opacity: 0; transition: opacity .3s; }
    #regia-barra .preferito.visibile { opacity: 1; }
    #regia-telefono { position: absolute; right: 36px; top: 96px; width: 250px; height: 470px; border-radius: 38px; background: #111827;
      padding: 14px; box-shadow: 0 18px 40px rgba(0, 0, 0, .45); opacity: 0; transform: translateX(30px); transition: opacity .35s, transform .35s; }
    #regia-telefono.visibile { opacity: 1; transform: none; }
    #regia-telefono .schermo { height: 100%; border-radius: 26px; background: #f4f6fb; overflow: hidden; display: flex; flex-direction: column;
      font-family: Inter, system-ui, sans-serif; color: #12244A; }
    #regia-telefono .barra-app { background: #1C4184; color: #fff; padding: 22px 16px 12px; font: 700 16px Inter, system-ui, sans-serif; }
    #regia-telefono .voce { margin: 10px 12px 0; background: #fff; border-radius: 12px; padding: 12px 14px; box-shadow: 0 1px 3px rgba(0, 0, 0, .12); font-size: 14px; }
    #regia-telefono .voce b { display: block; font-size: 15px; }
    #regia-telefono .codice { font: 700 34px "JetBrains Mono", monospace; letter-spacing: 2px; color: #1C4184; margin-top: 4px; }
    #regia-telefono .mirino { margin: 18px auto 0; width: 180px; height: 180px; border-radius: 14px; background: #263244; position: relative; }
    #regia-telefono .mirino::before { content: ""; position: absolute; inset: 16px; border: 3px solid #f0b429; border-radius: 10px; }
    #regia-telefono .mirino::after { content: ""; position: absolute; left: 20px; right: 20px; top: 50%; height: 2px; background: #E10717; animation: regia-scansione 1.6s ease-in-out infinite alternate; }
    @keyframes regia-scansione { from { transform: translateY(-60px); } to { transform: translateY(60px); } }
    #regia-telefono .nota-tel { text-align: center; padding: 14px 16px; font-size: 14px; color: #5B687C; }
    #regia-telefono .tempo { height: 4px; background: #E7EEF8; border-radius: 2px; margin-top: 8px; overflow: hidden; }
    #regia-telefono .tempo i { display: block; height: 100%; background: #1C4184; }
    /* durante le registrazioni avvisi e invito stanno sopra la didascalia */
    .avvisi { bottom: 138px !important; }
    .tour-invito { bottom: 138px !important; }
  `;
  let strato = null;
  const el = {};
  const pos = { x: 640, y: 420 };
  function monta() {
    if (strato && strato.isConnected) return;
    const st = document.createElement('style');
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
    strato = document.createElement('div');
    strato.id = 'regia-strato';
    strato.innerHTML = '<div id="regia-anello"></div><div id="regia-barra"></div><div id="regia-intro"></div>' +
      '<div id="regia-didascalia"><span class="n"></span><span class="t"></span></div>' +
      '<div id="regia-tasto"></div><div id="regia-lettore"></div><div id="regia-telefono"><div class="schermo"></div></div>' +
      '<svg id="regia-puntatore" viewBox="0 0 32 32"><path d="M5 2 L5 27 L11.5 21 L16 30.5 L20.5 28.5 L16.2 19.3 L25 19 Z" fill="#fff" stroke="#12244A" stroke-width="2.2" stroke-linejoin="round"/></svg>';
    // fuori da <body>: le regole di stampa (body > * nascosti) e i cambi di pagina non lo toccano
    document.documentElement.appendChild(strato);
    ['anello', 'barra', 'intro', 'didascalia', 'tasto', 'lettore', 'telefono', 'puntatore'].forEach((k) => { el[k] = strato.querySelector('#regia-' + k); });
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
      setTimeout(() => o.remove(), 750);
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
    intro(ico, titolo, sotto, subito) {
      monta();
      el.intro.innerHTML = '<div class="ico"></div><div class="tit"></div><div class="riga"></div><div class="sotto"></div>';
      el.intro.querySelector('.ico').textContent = ico;
      el.intro.querySelector('.tit').textContent = titolo;
      el.intro.querySelector('.sotto').textContent = sotto;
      el.intro.classList.toggle('subito', !!subito);
      el.intro.classList.add('visibile');
    },
    fineIntro() { if (el.intro) { el.intro.classList.remove('subito'); el.intro.classList.remove('visibile'); } },
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
    },
    // barra degli indirizzi finta (il video registra solo la pagina, non il browser)
    barra(url, scritto) {
      monta();
      el.barra.innerHTML = '<span class="tondi"><i></i><i></i><i></i></span><span class="frecce">← → ⟳</span>' +
        '<span class="campo"><span class="lucchetto">ⓘ</span><span class="url"></span><span class="cursore"></span></span>' +
        '<span class="stella">☆</span><span class="preferito">★ Aggiunto ai preferiti</span>';
      el.barra.querySelector('.url').textContent = scritto ? url : '';
      el.barra.classList.add('visibile');
    },
    barraScrivi(testo) {
      const c = el.barra.querySelector('.campo');
      c.classList.add('fuoco');
      el.barra.querySelector('.url').textContent = testo;
    },
    barraFine() { el.barra.querySelector('.campo').classList.remove('fuoco'); const k = el.barra.querySelector('.cursore'); if (k) k.remove(); },
    barraStella() { el.barra.querySelector('.stella').classList.add('piena'); el.barra.querySelector('.stella').textContent = '★'; el.barra.querySelector('.preferito').classList.add('visibile'); },
    barraVia() { if (el.barra) el.barra.classList.remove('visibile'); },
    // il telefono con l'app di autenticazione (il video registra solo lo schermo del computer)
    telefono(stato, d) {
      monta();
      const sc = el.telefono.querySelector('.schermo');
      const testo = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      if (stato === 'app') {
        sc.innerHTML = '<div class="barra-app">App di autenticazione</div>' + ['Google Authenticator', 'Microsoft Authenticator', 'FreeOTP'].map((n) => '<div class="voce"><b>' + n + '</b>gratuita</div>').join('') +
          '<div class="nota-tel">Installane una sola</div>';
      } else if (stato === 'scansiona') {
        sc.innerHTML = '<div class="barra-app">Scansiona un codice QR</div><div class="mirino"></div><div class="nota-tel">Inquadra il codice QR sullo schermo del computer</div>';
      } else if (stato === 'codice') {
        const resto = 30 - Math.floor(Date.now() / 1000) % 30;
        sc.innerHTML = '<div class="barra-app">Authenticator</div><div class="voce"><b>' + testo(d.emittente) + '</b>' + testo(d.utente) +
          '<div class="codice">' + testo(d.codice.slice(0, 3) + ' ' + d.codice.slice(3)) + '</div><div class="tempo"><i style="width:' + Math.round(resto / 30 * 100) + '%"></i></div></div>' +
          '<div class="nota-tel">Il codice cambia ogni 30 secondi</div>';
      }
      el.telefono.classList.toggle('visibile', !!stato);
    },
    stella() { const r = el.barra.querySelector('.stella').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
  };
  // testo con il nome di una struttura reale (window.__vietati, dalla regia in Node) entrato nello schermo
  R.marchio = [];
  R.controllaVista = function () {
    const re = window.__vietati;
    if (!re || !document.body || !re.test(document.body.textContent)) return;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (!re.test(n.nodeValue)) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      const dentro = Array.prototype.some.call(r.getClientRects(), (q) => q.width > 0 && q.bottom > 0 && q.right > 0 && q.top < innerHeight && q.left < innerWidth);
      if (dentro) { R.marchio.push(n.nodeValue.trim().slice(0, 80)); return; }
    }
  };
  setInterval(R.controllaVista, 400);
  window.__regia = R;
  // cartello mostrato già al caricamento (cambio di utente: la pagina si ricarica sotto il cartello)
  try {
    const c = sessionStorage.getItem('__regia-cartello');
    if (c) { const x = JSON.parse(c); R.intro(x[0], x[1], x[2], true); }
  } catch (e) { /* niente memoria */ }
  // gli avvisi d'errore del programma non devono comparire nei video: li segno
  new MutationObserver((lista) => {
    lista.forEach((m) => m.addedNodes.forEach((n) => {
      if (n.nodeType === 1 && n.classList.contains('avviso') && n.classList.contains('errore')) R.errori.push(n.textContent);
    }));
  }).observe(document, { childList: true, subtree: true });
}

/* Regia lato Node: passi, puntatore, clic, scrittura lenta, tempi per i sottotitoli. */
class Regia {
  constructor(page, guida, srv) {
    this.page = page;
    this.g = guida;
    this.srv = srv;
    this.n = 0;
    this.tempi = [];
    this.inizio = 0;
    this.permessi = []; // errori d'avviso attesi (scenario che mostra un messaggio d'errore voluto)
    // tempo minimo di lettura di ogni passo: 55 ms a carattere (circa 160 parole al minuto), fra 4,2 e 9,5 secondi;
    // se la guida è lunga si accorcia un po', così il video resta entro i 90 secondi
    const base = guida.passi.map((t) => Math.min(9500, Math.max(4200, 1500 + t.length * 55)));
    const somma = base.reduce((a, b) => a + b, 0);
    const fattore = Math.min(1, (DURATA_MAX - 13) * 1000 / (somma + 3500));
    this.minimi = base.map((m) => Math.max(3600, Math.round(m * fattore)));
  }

  async intro(png) {
    const p = this.page;
    await p.evaluate(() => window.__regia.prepara());
    this.inizio = Date.now();
    await p.evaluate(([ico, tit]) => window.__regia.intro(ico, tit, 'Videoguida · Pharmacy'), [this.g.ico, this.g.titolo]);
    await pausa(700);
    await p.screenshot({ path: png });
    await pausa(1700);
    await p.evaluate(() => window.__regia.fineIntro());
    await pausa(450);
  }

  /* Un passo della guida: didascalia, azioni, poi resta fermo quanto serve per leggere. */
  async passo(azione, opz) {
    opz = opz || {};
    const i = this.n++;
    const testo = this.g.passi[i];
    if (testo === undefined) throw new Error('lo scenario ha più passi della guida (' + this.g.passi.length + ')');
    const t0 = Date.now();
    this.didascalia = [testo, i + 1, this.g.passi.length, !!opz.alto];
    await this.page.evaluate(([t, n, tot, alto]) => window.__regia.didascalia(t, n, tot, alto), this.didascalia);
    await pausa(opz.attesa !== undefined ? opz.attesa : 1000);
    if (azione) await azione();
    const minimo = this.minimi[i] + (opz.piu || 0);
    const trascorso = Date.now() - t0;
    if (trascorso < minimo) await pausa(minimo - trascorso);
    await this.controllaMarchio();
    await this.page.evaluate(() => window.__regia.togliAnello());
    this.tempi.push({ inizio: (t0 - this.inizio) / 1000, fine: (Date.now() - this.inizio) / 1000, testo: testo });
  }

  // nessun nome di una struttura reale e nessun marchio incorporato sullo schermo
  // (la pagina controlla anche da sola, ogni 400 ms, il testo che entra nello schermo: vedi installaRegia)
  async controllaMarchio() {
    const x = await this.page.evaluate(() => {
      window.__regia.controllaVista();
      const visibile = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
      return {
        visti: window.__regia.marchio.slice(),
        loghi: Array.prototype.filter.call(document.querySelectorAll('img'), (i) => /brand\//.test(i.getAttribute('src') || '') && i.naturalWidth > 0 && visibile(i)).length
      };
    });
    if (x.visti.length) throw new Error('passo ' + this.n + ': sullo schermo compare «' + x.visti[0] + '» (marchio non neutro)');
    if (x.loghi) throw new Error('passo ' + this.n + ': sullo schermo c’è il marchio incorporato (brand/)');
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
    if (b.y < 70 || b.y + Math.min(b.height, 200) > ALTO - 150 || b.x < 0 || b.x + b.width > LARGO) {
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
    await this.muovi(x, y);
    return l;
  }

  async muovi(x, y) {
    const da = await this.page.evaluate(() => window.__regia.dove());
    const ms = Math.round(Math.min(1000, Math.max(450, Math.hypot(x - da.x, y - da.y) * 1.1)));
    await this.page.evaluate(([a, c, d]) => window.__regia.muovi(a, c, d), [x, y, ms]);
    await pausa(ms + 150);
  }

  async clic(sel, opz) {
    opz = opz || {};
    const l = await this.punta(sel, opz);
    await this.page.evaluate(() => window.__regia.premi());
    await pausa(200);
    await l.click(opz.forza ? { force: true } : undefined);
    await pausa(opz.dopo !== undefined ? opz.dopo : 800);
    return l;
  }

  async scrivi(sel, testo, opz) {
    opz = opz || {};
    const l = await this.clic(sel, { dopo: 250 });
    if (opz.svuota) { await l.fill(''); await pausa(150); }
    await l.pressSequentially(testo, { delay: opz.ritmo || 80 });
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
    // Esc chiude finestre e menu: l'anello su un loro elemento resterebbe a mezz'aria
    if (combinazione === 'Escape') await this.togliAnello();
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
    // nei video la finestra è larga: il menu a sinistra c'è sempre
    await this.clic('#menu a[data-pagina="' + pagina + '"]', { dopo: 300 });
    await attendi(() => this.page.evaluate((p) => window.App && App.paginaCorrente === p, pagina), 5000);
    await pausa(900);
  }

  async avviso(testo) {
    const ok = await attendi(() => this.page.evaluate((t) => Array.prototype.some.call(document.querySelectorAll('#avvisi .avviso'), (a) => a.textContent.indexOf(t) >= 0), testo), 8000);
    if (!ok) throw new Error('passo ' + this.n + ': non è comparso l’avviso «' + testo + '»');
  }

  // aspetta che una finestra (modale) sia aperta e abbia finito di comparire
  async finestra(sel) {
    await this.el('#modale:not([hidden]) ' + (sel || '.modale-corpo'), 8000);
    await pausa(450);
  }

  /* Cambio di utente a metà video (per esempio: il reparto chiede, poi la farmacia evade): un cartello copre la
     pagina mentre il browser passa alla sessione dell'altro utente e si riapre sulla pagina indicata. */
  async cambiaUtente(chi, pagina, titolo, sotto) {
    const p = this.page;
    const cartello = ['👤', titolo, sotto];
    await p.evaluate((c) => { sessionStorage.setItem('__regia-cartello', JSON.stringify(c)); window.__regia.intro(c[0], c[1], c[2]); }, cartello);
    await pausa(1300);
    const ctx = p.context();
    await ctx.clearCookies();
    await ctx.addCookies((await this.srv.contesti[chi].storageState()).cookies);
    // stesso indirizzo con un altro #: il browser non ricaricherebbe la pagina, quindi si ricarica a mano
    await p.goto(this.srv.base + '#' + pagina);
    await p.reload();
    await p.waitForSelector('#app:not([hidden]) #contenuto > *', { timeout: 15000 });
    await attendi(() => p.evaluate((x) => window.App && App.paginaCorrente === x, pagina), 5000);
    // la pagina nuova ha la regia nuova: si rimette la didascalia del passo in corso
    await p.evaluate((d) => { window.__regia.didascalia(d[0], d[1], d[2], d[3]); }, this.didascalia);
    await pausa(1300);
    await p.evaluate(() => { sessionStorage.removeItem('__regia-cartello'); window.__regia.fineIntro(); });
    await pausa(500);
  }

  /* Barra degli indirizzi finta: scrive l'indirizzo, "Invio", poi la stella dei preferiti. */
  async barraIndirizzo(url) {
    const p = this.page;
    await p.evaluate(() => window.__regia.barra('', false));
    await pausa(500);
    for (let i = 1; i <= url.length; i++) {
      await p.evaluate((t) => window.__regia.barraScrivi(t), url.slice(0, i));
      await pausa(60);
    }
    await pausa(300);
    await this.page.evaluate((t) => window.__regia.tasto(t), 'Invio');
    await p.evaluate(() => window.__regia.barraFine());
    await pausa(900);
    const s = await p.evaluate(() => window.__regia.stella());
    await this.muovi(Math.round(s.x) - 6, Math.round(s.y) - 4);
    await p.evaluate(() => window.__regia.premi());
    await pausa(250);
    await p.evaluate(() => window.__regia.barraStella());
    await pausa(1300);
  }

  async togliBarra() { await this.page.evaluate(() => window.__regia.barraVia()); await pausa(350); }

  /* Trascinamento con il mouse (il puntatore finto segue quello vero): da un elemento a un altro. */
  async trascina(da, a, opz) {
    opz = opz || {};
    const p = this.page;
    const l1 = await this.el(da);
    const b1 = await this.inVista(l1);
    const x1 = Math.round(b1.x + b1.width * (opz.fx1 !== undefined ? opz.fx1 : 0.5)), y1 = Math.round(b1.y + b1.height / 2);
    await this.muovi(x1, y1);
    await p.mouse.move(x1, y1);
    await p.evaluate(() => window.__regia.premi());
    await p.mouse.down();
    await pausa(250);
    const l2 = await this.el(a);
    const b2 = await l2.boundingBox();
    const x2 = Math.round(b2.x + b2.width / 2), y2 = Math.round(b2.y + b2.height / 2);
    const passi = 24;
    for (let i = 1; i <= passi; i++) {
      const t = i / passi;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = Math.round(x1 + (x2 - x1) * e), y = Math.round(y1 + (y2 - y1) * e);
      await p.mouse.move(x, y);
      await p.evaluate(([u, v]) => window.__regia.muovi(u, v, 40), [x, y]);
      await pausa(40);
    }
    await pausa(300);
    await p.mouse.up();
    await pausa(opz.dopo !== undefined ? opz.dopo : 900);
  }

  /* Anteprima di stampa: il pulsante vero aprirebbe la finestra di stampa del sistema (che il video non vede);
     qui si prepara la stessa pagina da stampare e la si mostra con lo stile di stampa per qualche secondo. */
  async anteprimaStampa(sel, prepara, arg, ms) {
    await this.punta(sel);
    await this.page.evaluate(() => window.__regia.premi());
    await pausa(300);
    await this.page.evaluate(prepara, arg);
    const y = await this.page.evaluate(() => { const v = window.scrollY; window.scrollTo(0, 0); return v; });
    await this.page.emulateMedia({ media: 'print' });
    await pausa(ms || 4000);
    await this.page.emulateMedia({ media: 'screen' });
    await this.page.evaluate((v) => { if (window.__togliStampa) window.__togliStampa(); window.__togliStampa = null; window.scrollTo(0, v); }, y);
    await pausa(400);
  }
}

/* ======================= scenari (un blocco per passo, nello stesso ordine di Guide.ELENCO[].passi) ======================= */
/*
 * Ogni scenario: { utente, daAccesso?, conInvito?, pagina?, memoria?, prepara(srv)?, gira(R, srv), dopo(srv)? }
 *   utente      chi registra (chiave di UTENTI); la sessione è già aperta, tranne con daAccesso (schermata di accesso)
 *   prepara     dati che servono solo a questa guida (con l'API, prima di registrare); può lasciare cose in this
 *   dopo        rimette a posto quello che la registrazione ha cambiato (criterio 2FA, marchio…), anche se non è riuscita
 */
const SCENARI = {};

// articolo dei dati di prova per nome
async function articoloDi(srv, nome) {
  const a = (await srv.dati()).articoli.find((x) => x.nome === nome);
  if (!a) throw new Error('articolo dei dati di prova non trovato: ' + nome);
  return a;
}

/* ---------- lavoro di ogni giorno: carico, lettore, consumi ---------- */

SCENARI.carico = {
  utente: 'farmacista', memoria: { 'gf-scanner-modo:carico': 'confezione' },
  async prepara(srv) {
    // la cefazolina ha il suo codice GS1 (il lettore compila la riga con lotto e scadenza)
    const a = await articoloDi(srv, 'CEFAZOLINA 1 g fl');
    await srv.chiama('admin', 'PUT', 'api/articoli/' + a.id, Object.assign({}, a, { barcode: Barcode.analizza(GS1_CEFAZOLINA).chiavi }));
  },
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('carico');
      await R.punta('#t-data');
      await pausa(400);
      await R.anello('#t-rep', { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.scrivi('#t-forn', 'Deposito Alfa (prova)', { ritmo: 60 });
      await R.scrivi('#t-doc', 'DDT 1458');
    });
    await R.passo(async () => {
      const art = await R.scrivi('#righe tr:nth-child(1) .r-art', 'KETOR', { ritmo: 140, dopo: 600 });
      await art.fill('KETOROLAC 30 mg/ml f');
      await art.dispatchEvent('input');
      await pausa(500);
      await R.anello('#righe tr:nth-child(1) .info-riga');
    });
    await R.passo(async () => {
      await R.scrivi('#righe tr:nth-child(1) .r-q', '100');
      await R.scrivi('#righe tr:nth-child(1) .r-lotto', 'K24117');
      const sc = await R.clic('#righe tr:nth-child(1) .r-scad', { dopo: 200 });
      await sc.fill(meseTra(22));
      await pausa(600);
    });
    await R.passo(async () => {
      await p.evaluate(() => document.activeElement && document.activeElement.blur());
      await R.anello('.barra-scanner', { dopo: 900 });
      await R.togliAnello();
      await R.leggi(GS1_CEFAZOLINA);
      await p.waitForFunction(() => Array.prototype.some.call(document.querySelectorAll('#righe .r-art'), (i) => i.value === 'CEFAZOLINA 1 g fl'), null, { timeout: 4000 });
      await R.anello('#righe tr:nth-child(2)', { dopo: 1200 });
      await R.togliAnello();
      await R.anello('#righe tr:nth-child(2) .r-prezzo', { dopo: 900 });
    });
    await R.passo(async () => {
      await R.clic('#riga-piu', { dopo: 400 });
      const art = await R.scrivi('#righe tr:nth-child(3) .r-art', 'SIRIN', { ritmo: 140, dopo: 400 });
      await art.fill('SIRINGHE 10 ml');
      await art.dispatchEvent('input');
      await R.scrivi('#righe tr:nth-child(3) .r-q', '300');
      await R.scrivi('#righe tr:nth-child(3) .r-lotto', 'S8891');
      await R.punta('#righe tr:nth-child(3) [data-togli]');
    });
    await R.passo(async () => {
      await R.anello('#righe', { dopo: 1000 });
      await R.togliAnello();
      await R.clic('#registra', { dopo: 300 });
      await R.avviso('Carico registrato');
      await pausa(600);
    });
    await R.passo(async () => {
      await R.anello('#recenti .tabella tbody tr:nth-child(1)', { dopo: 1500 });
      await R.punta('#recenti [data-annulla]');
    });
  }
};

SCENARI.lettore = {
  utente: 'farmacista', pagina: 'carico', memoria: { 'gf-scanner-modo:carico': 'unita' }, fotocamera: true,
  async prepara(srv) {
    const a = await articoloDi(srv, 'CEFAZOLINA 1 g fl');
    const info = Barcode.analizza(GS1_CEFAZOLINA);
    if (info.tipo !== 'gs1' || info.lotto !== 'C24A07' || info.scadenza !== '2028-05') throw new Error('codice GS1 di prova non valido: ' + JSON.stringify(info));
    await srv.chiama('admin', 'PUT', 'api/articoli/' + a.id, Object.assign({}, a, { barcode: info.chiavi, pezziConfezione: 10 }));
    // le siringhe restano senza codice: è il "codice mai visto"
    const s = await articoloDi(srv, 'SIRINGHE 10 ml');
    if ((s.barcode || []).length) await srv.chiama('admin', 'PUT', 'api/articoli/' + s.id, Object.assign({}, s, { barcode: [] }));
    if (Barcode.analizza(EAN_SIRINGHE).tipo !== 'ean') throw new Error('EAN di prova non valido');
  },
  async gira(R) {
    const p = R.page;
    if (!(await p.locator('.barra-scanner #scanner-campo').count())) throw new Error('la barra di lettura (.barra-scanner) non c’è');
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
      if (await p.locator('#scanner-fotocamera').count()) await R.anello('#scanner-fotocamera', { dopo: 1500 });
      await R.togliAnello();
      await R.clic('#registra', { dopo: 300 });
      await R.avviso('Carico registrato');
    });
  }
};

SCENARI.consumi = {
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
      await R.punta('#c-cerca');
    });
    await R.passo(async () => {
      await R.anello('#c-foglio', { dopo: 900 });
      await R.togliAnello();
      await R.anello(p.locator('label.spunta:has(#c-tutti)'), { dopo: 1200 });
    });
    // tre righe di fila con abbastanza giacenza (così non compare la domanda sulla giacenza insufficiente)
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
};

/* ---------- perdite, giacenze e scadenze, movimenti, inventario, nota consumi ---------- */

SCENARI.perdite = {
  utente: 'farmacista',
  async prepara(srv) {
    // un lotto scaduto il mese scorso, ben riconoscibile
    const a = await articoloDi(srv, 'DESAMETASONE 4 mg/1 ml f');
    await srv.chiama('farmacista', 'POST', 'api/movimenti', { movimenti: [{ tipo: 'carico', data: giorniFa(70), articoloId: a.id, repartoId: 'r-farmacia', quantita: 6, lotto: 'D2309A', scadenza: meseTra(-1), fornitore: 'Deposito Alfa (prova)', documento: 'DDT 77' }] });
  },
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('scadenze');
      await R.scegli('#z-entro', '-1');
    });
    await R.passo(async () => {
      await R.anello('#z-tab tbody tr:has([data-perdita*="|D2309A|"])', { dopo: 1300 });
      await R.togliAnello();
      await R.clic('[data-perdita*="|D2309A|"]', { dopo: 300 });
      await p.waitForSelector('#righe .r-lotto-scelta', { timeout: 5000 });
      await pausa(600);
    });
    await R.passo(async () => {
      await R.anello('#righe tr:nth-child(1)', { dopo: 1500 });
      await R.togliAnello();
      await R.anello('#righe tr:nth-child(1) .r-causale', { dopo: 900 });
    });
    await R.passo(async () => {
      await R.punta('#t-data');
      await pausa(400);
      await R.punta('#t-rep');
      await pausa(400);
      await R.clic('#riga-piu', { dopo: 400 });
      const art = await R.scrivi('#righe tr:nth-child(2) .r-art', 'KETOR', { ritmo: 140, dopo: 400 });
      await art.fill('KETOROLAC 30 mg/ml f');
      await art.dispatchEvent('input');
      await R.scrivi('#righe tr:nth-child(2) .r-q', '1');
      const sel = await R.punta('#righe tr:nth-child(2) .r-lotto-scelta');
      if ((await sel.locator('option').count()) > 1) { await p.evaluate(() => window.__regia.premi()); await sel.selectOption({ index: 1 }); }
      await pausa(600);
    });
    await R.passo(async () => {
      await R.scegli('#righe tr:nth-child(2) .r-causale', 'Rotto o danneggiato', { dopo: 500 });
      await R.scrivi('#righe tr:nth-child(2) .r-note', 'Fiala caduta durante la preparazione', { ritmo: 50 });
    });
    await R.passo(async () => {
      await R.clic('#registra', { dopo: 300 });
      await R.avviso('Perdita registrata');
      await pausa(500);
      await R.anello('#recenti .tabella tbody tr:nth-child(1)', { dopo: 1200 });
    });
  }
};

SCENARI['giacenze-scadenze'] = {
  utente: 'farmacista',
  async gira(R) {
    const p = R.page;
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
      await c.dispatchEvent('input');
      await R.scegli('#g-rep', '', { dopo: 600 });
    });
    await R.passo(async () => {
      await R.anello(p.locator('#g-tab .tabella thead th', { hasText: 'In viaggio' }), { dopo: 1300 });
      await R.togliAnello();
      const viaggio = p.locator('#g-tab tbody .etichetta.info', { hasText: '🚚' });
      if (await viaggio.count()) await R.anello(viaggio.first(), { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.clic('#g-sotto', { dopo: 900 });
      await R.anello('#g-tab .etichetta.pericolo');
    });
    await R.passo(async () => {
      await R.clic('#g-tab tbody tr:nth-child(1) td:nth-child(1)', { dopo: 2600, fx: 0.3 });
      await R.tasti('Escape', 'Esc');
    });
    await R.passo(async () => {
      await R.menu('scadenze');
      await R.anello('#z-tab .tabella tbody tr:nth-child(1)', { dopo: 1200 });
    });
    await R.passo(async () => {
      await R.anello('#z-tab .etichetta', { dopo: 1000 });
      await R.togliAnello();
      if (await p.locator('#z-tab [data-perdita]').count()) await R.punta('#z-tab [data-perdita]');
    });
    await R.passo(async () => {
      await R.scegli('#z-entro', '180');
      await R.punta('#z-stampa');
      await pausa(500);
      await R.punta('#z-excel');
    });
  }
};

SCENARI.movimenti = {
  utente: 'farmacista',
  async prepara(srv) {
    const a = await articoloDi(srv, 'KETOROLAC 30 mg/ml f');
    const r = await srv.chiama('farmacista', 'POST', 'api/movimenti', { movimenti: [{ tipo: 'carico', data: oggi(), articoloId: a.id, repartoId: 'r-farmacia', quantita: 400, lotto: 'K5521', scadenza: meseTra(24), fornitore: 'Deposito Alfa (prova)', documento: 'DDT 2231' }] });
    this.idSbagliato = r.movimenti[0].id;
    const d = await srv.dati();
    this.numeroDdt = (d.ddt.filter((x) => x.stato === 'ricevuto_con_differenze' || x.stato === 'ricevuto')[0] || {}).numero || 'DDT-';
  },
  async gira(R) {
    const p = R.page;
    const id = this.idSbagliato;
    await R.passo(async () => {
      await R.menu('movimenti');
      await R.anello('#v-tab .tabella thead', { dopo: 1200 });
      await R.togliAnello();
      await R.anello(p.locator('#v-tab .tabella thead th', { hasText: 'Operatore' }), { dopo: 900 });
    });
    await R.passo(async () => {
      await R.punta('#v-dal');
      await pausa(400);
      await R.punta('#v-al');
      await pausa(300);
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
      await R.scegli('#v-tipo', '', { dopo: 400 });
      const c = await R.scrivi('#v-cerca', this.numeroDdt, { ritmo: 70, svuota: true, dopo: 900 });
      await c.dispatchEvent('input');
      await R.anello('#v-tab tbody tr:nth-child(1)', { dopo: 1300 });
    });
    await R.passo(async () => {
      await R.clic('#v-ann', { dopo: 700 });
      await R.punta('#v-excel');
      await R.anello('#v-excel');
    });
  }
};

SCENARI.inventario = {
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
      await R.anello('#i-tab tbody tr:nth-child(3)', { dopo: 1300 });
      await R.togliAnello();
      await R.anello('.barra-scanner', { dopo: 900 });
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
};

SCENARI['nota-consumi'] = {
  utente: 'reparto',
  async gira(R) {
    const p = R.page;
    // il mese scorso, completo: si corregge il consumo del giorno 20
    const giorno = 20;
    await R.passo(async () => {
      await R.menu('registro');
      await R.punta('#r-rep');
      await pausa(400);
      const mese = await R.clic('#r-mese', { dopo: 200 });
      await mese.fill(meseTra(-1));
      await mese.dispatchEvent('change');
      await pausa(700);
      await R.scegli('#r-cat', 'FARMACI');
    });
    await R.passo(async () => {
      await R.anello('#r-tab .registro thead', { dopo: 1300 });
      await R.togliAnello();
      await p.evaluate(() => document.querySelector('.registro-contenitore').scrollTo({ left: 5000, behavior: 'smooth' }));
      await pausa(1800);
      await p.evaluate(() => document.querySelector('.registro-contenitore').scrollTo({ left: 0, behavior: 'smooth' }));
      await pausa(1000);
    });
    await R.passo(async () => {
      await R.anello(p.locator('label.spunta:has(#r-tutti)'), { dopo: 1400 });
    });
    const cella = (n) => '#r-tab tbody tr:nth-child(' + n + ') input[data-giorno="' + giorno + '"]';
    await R.passo(async () => {
      await p.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }), cella(1));
      await pausa(900);
      const prima = Number((await p.inputValue(cella(1))).replace(',', '.')) || 0;
      await R.clic(cella(1), { dopo: 300 });
      await p.keyboard.press('Control+a');
      await p.keyboard.type(String(prima + 2), { delay: 150 });
      await pausa(500);
      await R.tasti('Enter', 'Invio');
      await pausa(600);
      // la casella corretta (le colonne dei totali sono fuori dalla parte scorsa del modulo)
      await R.anello(cella(1), { dopo: 900 });
    });
    await R.passo(async () => {
      await R.punta(cella(2));
      await p.keyboard.press('Control+a');
      await p.keyboard.type('9', { delay: 150 });
      await pausa(600);
      await R.tasti('Escape', 'Esc');
      await R.anello(cella(2), { dopo: 900 });
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
};

/* ---------- richieste, DDT e consegne, ricezione, trasferimenti ---------- */

// numero (RIC-… o DDT-…) mostrato nella pagina
async function numeroInPagina(p, prefisso) {
  const t = await p.evaluate(() => document.getElementById('contenuto').innerText);
  const m = new RegExp(prefisso + '-\\d{4}-\\d{4}').exec(t);
  if (!m) throw new Error('non trovo il numero ' + prefisso + ' nella pagina');
  return m[0];
}

SCENARI.richieste = {
  utente: 'reparto',
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('richieste');
      await R.clic('#ric-nuova', { dopo: 900 });
      await R.anello('#rn-rep', { dopo: 900 });
      await R.togliAnello();
      await R.anello('#rn-forn', { dopo: 700 });
    });
    await R.passo(async () => {
      await R.anello(p.locator('label.spunta:has(#rn-urgente)'), { dopo: 1300 });
    });
    await R.passo(async () => {
      await R.clic('#rn-proponi', { dopo: 600 });
      await R.avviso('Proposte');
      await R.anello('#righe tr:nth-child(1)', { dopo: 1000 });
    });
    await R.passo(async () => {
      // via le righe che la farmacia non può dare (merce libera insufficiente), poi una quantità corretta a mano
      const scarse = await p.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#righe tr'), (tr, i) => {
        const m = /ne ha liberi ([\d.,]+)/.exec(tr.querySelector('.info-riga').textContent);
        const q = Number((tr.querySelector('.r-q').value || '0').replace(',', '.'));
        return m && Number(m[1].replace(/\./g, '').replace(',', '.')) < q ? i + 1 : 0;
      }).filter(Boolean));
      for (const n of scarse.reverse()) {
        await R.anello('#righe tr:nth-child(' + n + ') .info-riga', { dopo: 800 });
        await R.togliAnello();
        await R.clic('#righe tr:nth-child(' + n + ') [data-togli]', { dopo: 600 });
      }
      const q = await R.scrivi('#righe tr:nth-child(1) .r-q', '', { dopo: 100 });
      const prima = Number((await q.inputValue()).replace(',', '.')) || 10;
      await q.fill('');
      await q.pressSequentially(String(Math.ceil(prima / 10) * 10), { delay: 120 });
      await pausa(400);
      await R.anello('#righe tr:nth-child(1) .info-riga', { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.scrivi('#rn-note', 'Rifornimento di metà settimana', { ritmo: 55 });
      await R.clic('#rn-invia', { dopo: 300 });
      await R.avviso('inviata');
      await pausa(900);
    }, { alto: false });
    this.numero = await numeroInPagina(p, 'RIC');
    await R.passo(async () => {
      await R.cambiaUtente('farmacista', 'richieste', 'Intanto, in farmacia centrale', 'Maria Esposito · Farmacista');
      if (await p.locator('#ric-evadere').count()) await R.clic('#ric-evadere', { dopo: 700 });
      await R.clic(p.locator('#ric-pannello .log-voce', { hasText: this.numero }).first(), { dopo: 1000 });
      await R.clic('#ric-prendi', { dopo: 300 });
      await R.avviso('Hai preso in carico');
    });
    await R.passo(async () => {
      await R.anello(p.locator('thead th', { hasText: 'Approvata' }), { dopo: 800 });
      await R.togliAnello();
      const campo = p.locator('.ric-appr').first();
      const v = Number((await campo.inputValue()).replace(',', '.')) || 10;
      await R.scrivi(campo, String(v + 2), { svuota: true, ritmo: 150 });
      await R.anello(p.locator('thead th', { hasText: 'Libera' }), { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.clic('#ric-prepara', { dopo: 500 });
      if (await p.locator('#conferma-si').count()) await R.clic('#conferma-si', { dopo: 300 });
      await R.avviso('Preparato il DDT');
      await pausa(800);
      await R.anello('.log-intestazione', { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.clic(p.locator('[data-richiesta]').first(), { dopo: 1200 });
      if (await p.locator('#ric-chiudi').count()) await R.anello('#ric-chiudi', { dopo: 1400 });
      await R.togliAnello();
      await R.clic('#ric-indietro', { dopo: 700 });
      if (await p.locator('#ric-evadere').count()) await R.clic('#ric-evadere', { dopo: 600 });
      await R.clic(p.locator('#ric-pannello .log-voce').first(), { dopo: 1000 });
      if (await p.locator('#ric-rifiuta').count()) await R.anello('#ric-rifiuta', { dopo: 1200 });
    });
  }
};

SCENARI['ddt-consegne'] = {
  utente: 'farmacista',
  async gira(R, srv) {
    const p = R.page;
    const id = srv.ddtDaSpedire;
    await R.passo(async () => {
      await R.menu('consegne');
      await R.anello('.log-schede', { dopo: 900 });
      await R.togliAnello();
      for (const t of ['#ddt-viaggio', '#ddt-ricevere', '#ddt-archivio']) { await R.punta(t); await pausa(350); }
      await R.clic('#ddt-preparare', { dopo: 600 });
    });
    await R.passo(async () => {
      await R.clic('#ddt-pannello [data-apri="' + id + '"]', { dopo: 1200 });
      await R.anello('.log-intestazione', { dopo: 1500 });
    });
    await R.passo(async () => {
      await R.clic('#ddt-modifica', { dopo: 900 });
      await R.scrivi('#md-colli', '2', { svuota: true });
      await R.anello('#righe', { dopo: 900 });
      await R.togliAnello();
      await R.clic('#md-salva', { dopo: 400 });
      await R.avviso('salvato');
      await pausa(500);
    });
    await R.passo(async () => {
      await R.anteprimaStampa('#ddt-stampa', (x) => { window.__togliStampa = App.preparaStampaDdt(x); }, id, 4200);
    });
    await R.passo(async () => {
      await R.clic('#ddt-spedisci', { dopo: 900 });
      await R.finestra('#sp-chi');
      await attendi(() => p.evaluate(() => document.querySelectorAll('#sp-chi option').length > 2), 5000);
      await R.scegli('#sp-chi', 'altro', { dopo: 600 });
      await R.scrivi('#sp-altro', PORTATORE, { ritmo: 70 });
    }, { alto: true });
    await R.passo(async () => {
      await R.anello('#sp-colli', { dopo: 1000 });
      await R.togliAnello();
      await R.clic('#sp-ok', { dopo: 300 });
      await R.avviso('partito con');
    }, { alto: true });
    await R.passo(async () => {
      await pausa(500);
      await R.anello('.log-intestazione', { dopo: 1200 });
      await R.togliAnello();
      await R.anello('.log-scheda-cron, .log-cron', { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.punta('#ddt-annulla');
      await R.anello('#ddt-annulla', { dopo: 1400 });
    });
  }
};

SCENARI.ricezione = {
  utente: 'reparto',
  async prepara(srv) {
    // un DDT dalla farmacia alla Degenza, partito stamattina; il pantoprazolo ha il suo codice a barre (conta con il lettore)
    const d = await srv.dati();
    const nomi = ['PANTOPRAZOLO 40 mg fl ev', 'ONDANSETRON 4 mg/2 ml f', 'GARZE STERILI 10x10 cm'];
    const art = nomi.map((n) => d.articoli.find((a) => a.nome === n));
    const pan = art[0];
    this.ean = '801234500010' + cifraEan('801234500010');
    await srv.chiama('admin', 'PUT', 'api/articoli/' + pan.id, Object.assign({}, pan, { barcode: Barcode.analizza(this.ean).chiavi }));
    const r = await srv.chiama('reparto', 'POST', 'api/richieste', { repartoId: 'r-degenza', fornitoreId: 'r-farmacia', invia: true, note: 'Terapie della settimana',
      righe: art.map((a, i) => ({ articoloId: a.id, quantita: [10, 12, 20][i] })) });
    const dd = await srv.chiama('farmacista', 'POST', 'api/richieste/' + r.richiesta.id + '/ddt', {});
    await srv.chiama('farmacista', 'POST', 'api/ddt/' + dd.ddt.id + '/spedisci', { trasportatoreNome: PORTATORE, colli: 2 });
    this.numero = dd.ddt.numero;
  },
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('consegne');
      await R.clic('#ddt-ricevere', { dopo: 900 });
      await R.anello('#ddt-pannello', { dopo: 1000 });
      await R.togliAnello();
      await p.evaluate(() => document.activeElement && document.activeElement.blur());
      await R.leggi(this.numero);
      await p.waitForSelector('#ddt-ricevi', { timeout: 6000 });
      await pausa(600);
    });
    await R.passo(async () => {
      await R.anello('.log-intestazione', { dopo: 1600 });
      await R.togliAnello();
      await R.clic('#ddt-ricevi', { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.anello('.log-tab-ricezione', { dopo: 1200 });
      await R.togliAnello();
      await R.scrivi('.log-tab-ricezione tbody tr:nth-child(2) .rc-ricevuta', '10', { svuota: true, ritmo: 150 });
      await R.anello('.log-tab-ricezione tbody tr:nth-child(2)', { dopo: 900 });
    });
    await R.passo(async () => {
      await p.evaluate(() => document.activeElement && document.activeElement.blur());
      await R.leggi(this.ean);
      await R.anello('#rc-banda', { dopo: 1300 });
      await R.togliAnello();
      await R.clic('#rc-torna', { dopo: 800 });
    });
    await R.passo(async () => {
      await R.scrivi('.log-tab-ricezione tbody tr:nth-child(2) .rc-ricevuta', '10', { svuota: true, ritmo: 150, dopo: 500 });
      await R.scegli('.log-tab-ricezione tbody tr:nth-child(2) .rc-esito', 'perdita', { dopo: 500 });
      await R.scrivi('.log-tab-ricezione tbody tr:nth-child(2) .rc-nota', 'Due fiale rotte nel trasporto', { ritmo: 50 });
    });
    await R.passo(async () => {
      await R.scrivi('#rc-note', 'Scatola schiacciata, consegnata alle 11:40', { ritmo: 50 });
    });
    await R.passo(async () => {
      await R.clic('#rc-conferma', { dopo: 800 });
      await R.clic('#conferma-si', { dopo: 300 });
      await R.avviso('registrata');
      await pausa(600);
      await R.anello('.log-intestazione', { dopo: 1000 });
    });
  }
};

SCENARI.trasferimenti = {
  utente: 'reparto',
  async gira(R) {
    const p = R.page;
    // un articolo della Degenza con almeno due lotti validi (non scaduti): se ne rende uno scelto a mano
    const scelta = await p.evaluate(() => {
      const rep = 'r-degenza';
      const validi = (x) => Calcoli.lotti(App.S, x.id, rep).filter((l) => l.quantita > 0 && l.lotto && !Calcoli.scaduto(l.scadenza, App.oggi()));
      const ok = App.articoliAttivi('FARMACI').filter((x) => validi(x).some((l) => l.quantita >= 4));
      const due = ok.filter((x) => validi(x).length >= 2);
      const a = due[0] || ok[0];
      return { nome: a.nome, lotto: validi(a).filter((l) => l.quantita >= 4)[0].lotto };
    });
    const nome = scelta.nome;
    await R.passo(async () => {
      await R.menu('trasferimenti');
      await R.anello('#t-da', { dopo: 1000 });
      await R.togliAnello();
      await R.scegli('#t-a', 'r-farmacia');
    });
    await R.passo(async () => {
      await R.anello('#t-causale', { dopo: 1400 });
      await R.togliAnello();
      await R.anello('#t-colli', { dopo: 800 });
    });
    await R.passo(async () => {
      const art = await R.scrivi('#righe tr:nth-child(1) .r-art', nome.slice(0, 5), { ritmo: 140, dopo: 400 });
      await art.fill(nome);
      await art.dispatchEvent('input');
      await pausa(400);
      await R.scrivi('#righe tr:nth-child(1) .r-q', '4');
      await R.anello('#righe tr:nth-child(1) .info-riga');
    });
    await R.passo(async () => {
      await R.scegli('#righe tr:nth-child(1) .r-lotto-scelta', scelta.lotto, { dopo: 600 });
      await R.anello('#righe tr:nth-child(1) .r-lotto-scelta');
    });
    await R.passo(async () => {
      await R.scrivi('#t-note', 'Terapia sospesa: paziente dimesso', { ritmo: 55 });
    });
    await R.passo(async () => {
      await R.clic('#registra', { dopo: 300 });
      await R.avviso('Preparato il DDT');
      await pausa(700);
      await R.anello('.log-intestazione', { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.menu('trasferimenti');
      await R.anello('#recenti .log-voce', { dopo: 1100 });
      await R.togliAnello();
      await R.clic('#recenti .log-voce', { dopo: 1100 });
      await R.punta('#ddt-stampa');
      await pausa(500);
      await R.anello('#ddt-spedisci', { dopo: 900 });
    });
  }
};

/* ---------- struttura, armadi, magazzini e assortimento ---------- */

SCENARI.struttura = {
  utente: 'admin',
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('struttura');
      await R.anello('.st-sommario', { dopo: 1300 });
      await R.togliAnello();
      await R.punta('.st-sommario .indicatore:nth-child(3)');
      await pausa(500);
      await R.punta('.st-sommario .indicatore:nth-child(4)');
    });
    await R.passo(async () => {
      await R.anello('.st-tetto', { dopo: 900 });
      await R.togliAnello();
      await R.anello('.st-stanza.st-centrale', { dopo: 1300 });
    });
    await R.passo(async () => {
      const deg = '.st-stanza[data-rep="r-degenza"]';
      await R.anello(deg, { dopo: 1000 });
      await R.togliAnello();
      await R.punta(deg + ' .st-indicatori', { fx: 0.2 });
      await pausa(600);
      await R.punta(deg + ' .st-piede', { fx: 0.2 });
    });
    await R.passo(async () => {
      await R.clic('.st-stanza[data-rep="r-degenza"]', { dopo: 600, fx: 0.4 });
      await attendi(() => p.evaluate(() => App.paginaCorrente === 'armadi'), 5000);
      await pausa(1200);
      await R.anello('#ar-armadi', { dopo: 1400 });
      await R.togliAnello();
      await R.menu('struttura');
    });
    await R.passo(async () => {
      await R.anello('.st-pozzo', { dopo: 1600 });
      await R.togliAnello();
      await R.anello('.st-viaggio', { dopo: 1400 });
    });
    await R.passo(async () => {
      await R.punta('.st-viaggio [data-ddt]');
      await pausa(800);
      await R.anello('#st-gestisci', { dopo: 1400 });
    });
  }
};

SCENARI.armadi = {
  utente: 'reparto',
  async gira(R, srv) {
    const p = R.page;
    const id = (nome) => p.evaluate((n) => (App.articoloPerNome(n) || {}).id, nome);
    await R.passo(async () => {
      await R.menu('armadi');
      await R.anello('#ar-magazzino', { dopo: 1000 });
      await R.togliAnello();
      await R.anello('#ar-armadi', { dopo: 1400 });
    });
    const enox = await id('ENOXAPARINA 4000 UI siringa');
    await R.passo(async () => {
      await R.scrivi('#ar-cerca', 'enoxaparina', { ritmo: 120, dopo: 300 });
      await R.tasti('Enter', 'Invio');
      await pausa(800);
      await R.anello('#ar-vista .av-scatola[data-articolo="' + enox + '"]', { dopo: 1400 });
    });
    await R.passo(async () => {
      await R.anello('#ar-vista .av-griglia', { dopo: 1300 });
      await R.togliAnello();
      await R.anello('#ar-legenda', { dopo: 1400 });
    });
    await R.passo(async () => {
      await R.clic('#ar-legenda [data-stato="riordino"]', { dopo: 2000 });
      await R.clic('#ar-legenda [data-stato="riordino"]', { dopo: 600 });
    });
    await R.passo(async () => {
      await R.clic('#ar-vista .av-scatola[data-articolo="' + enox + '"]', { dopo: 900 });
      await R.anello('#ar-lato', { dopo: 1600 });
    });
    // un articolo ancora da disporre (non da frigorifero)
    const voce = await p.evaluate((ids) => {
      const frigo = (a) => (a.attributi || []).indexOf('frigo') >= 0;
      return ids.map((x) => App.articolo(x)).filter((a) => a && !frigo(a)).map((a) => a.id)[0];
    }, srv.daDisporre);
    await R.passo(async () => {
      await R.clic('#ar-disponi', { dopo: 1200 });
      await R.clic('#ar-armadi .ar-chip-armadio', { dopo: 900 });
      await R.trascina('#ar-voci .ar-voce[data-art="' + voce + '"] .ar-maniglia', '#ar-vista .av-cella.av-libera', { dopo: 1200 });
    });
    await R.passo(async () => {
      const libere = await p.locator('#ar-vista .av-cella.av-libera').count();
      await R.trascina('#ar-vista .av-scatola[data-articolo="' + voce + '"]', p.locator('#ar-vista .av-cella.av-libera').nth(Math.min(2, libere - 1)), { dopo: 1000 });
      await R.punta('#ar-voci [data-prendi]');
    });
    await R.passo(async () => {
      await R.clic('#ar-armadi .ar-chip-frigorifero', { dopo: 1000 });
      await R.clic('#ar-auto', { dopo: 900 });
      await R.clic('#conferma-si', { dopo: 1800 });
      await R.anello('#ar-vista .av-griglia', { dopo: 1000 });
      await R.togliAnello();
      await R.punta('#ar-svuota');
    });
    await R.passo(async () => {
      await R.clic('#ar-disponi', { dopo: 1000 });
      await R.anello('#ar-armadi', { dopo: 1000 });
    });
  }
};

SCENARI['magazzini-assortimento'] = {
  utente: 'admin',
  async gira(R) {
    const p = R.page;
    const voce = (nome) => p.locator('#mg-lista .mg-voce', { hasText: nome }).first();
    await R.passo(async () => {
      await R.menu('magazzini');
      await R.anello('#mg-lista', { dopo: 900 });
      await R.togliAnello();
      await R.clic(voce('Degenza'), { dopo: 900 });
    });
    await R.passo(async () => {
      await R.clic('#mg-nuovo', { dopo: 700 });
      await R.finestra('#mg-nome');
      await R.scrivi('#modale #mg-nome', 'Day Hospital', { ritmo: 60, dopo: 200 });
      await R.punta('#modale input[name="mg-tipo"][value="periferico"]');
      // il piano si scrive da solo dal livello (2 → «2° piano»)
      await R.scrivi('#modale #mg-livello', '2', { svuota: true, dopo: 200 });
      await R.clic('#modale input[name="mg-colore"] >> nth=4', { dopo: 300, forza: true });
      await R.scrivi('#modale #mg-descrizione', 'Terapie in giornata', { ritmo: 40, dopo: 200 });
      await R.clic('#mg-crea', { dopo: 300 });
      await R.avviso('creato');
      await pausa(700);
    });
    await R.passo(async () => {
      await R.clic('#mg-tab-armadi', { dopo: 700 });
      await R.clic('#mg-arm-nuovo', { dopo: 700 });
      await R.finestra('#arm-nome');
      await R.scrivi('#modale #arm-nome', 'Armadio terapie', { ritmo: 55, dopo: 200 });
      await R.anello('#modale input[name="arm-tipo"][value="armadio"] >> xpath=../..', { dopo: 700 });
      await R.togliAnello();
      await R.scrivi('#modale #arm-colonne', '5', { svuota: true, dopo: 200 });
      await R.clic('#arm-salva', { dopo: 300 });
      await R.avviso('Armadio');
      await pausa(600);
    });
    await R.passo(async () => {
      await R.clic('#mg-tab-assortimento', { dopo: 800 });
      const c = await R.scrivi('#as-nuovo', 'PARACE', { ritmo: 110, dopo: 200 });
      await c.fill('PARACETAMOLO 1000 mg/100 ml fl ev');
      await R.clic('#as-agg', { dopo: 600 });
      await R.anello('#as-usati', { dopo: 800 });
    });
    await R.passo(async () => {
      const riga = '#as-tab tbody tr:nth-child(1)';
      await R.scrivi(riga + ' .as-min', '4', { svuota: true });
      await R.scrivi(riga + ' .as-rio', '8', { svuota: true });
      await R.scrivi(riga + ' .as-max', '20', { svuota: true });
      await R.anello(riga, { dopo: 900 });
    });
    await R.passo(async () => {
      await R.clic('#as-salva', { dopo: 400 });
      await R.avviso('salvat');
      await R.clic(voce('Degenza'), { dopo: 900 });
      await R.clic('#mg-tab-assortimento', { dopo: 700 });
      await R.clic('#as-proponi', { dopo: 700 });
      await R.finestra();
      const tutti = p.locator('#modale input[type="radio"]').nth(1);
      if (await tutti.count()) await R.clic(tutti, { dopo: 400, forza: true });
      await R.clic('#as-proponi-ok', { dopo: 700 });
      await R.anello('#as-tab tbody tr:nth-child(1)', { dopo: 700 });
    });
    await R.passo(async () => {
      await R.clic(p.locator('label.spunta:has(#as-solo)'), { dopo: 900 });
      await R.clic('#as-salva', { dopo: 400 });
      await R.avviso('salvat');
      await pausa(500);
    });
    await R.passo(async () => {
      await R.clic('#mg-tab-dati', { dopo: 800 });
      await R.anello(p.locator('label.spunta:has(#mg-attivo)'), { dopo: 1500 });
    });
  }
};

/* ---------- previsioni, distribuzione, articoli ---------- */

// i segmenti (radio) delle pagine di analisi si toccano sull'etichetta
const segmento = (p, nome, valore) => p.locator('input[name="' + nome + '"][value="' + valore + '"]').locator('xpath=..');

SCENARI['previsioni-ordini'] = {
  utente: 'farmacista',
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('previsioni');
      await pausa(800);
      await R.anello('#pv-rep', { dopo: 1000 });
      await R.togliAnello();
      await R.punta('#pv-cat');
      await pausa(400);
      await R.punta('#pv-cerca');
    });
    await R.passo(async () => {
      await R.clic(segmento(p, 'pv-orizzonte', '7'), { dopo: 900 });
      await R.clic(segmento(p, 'pv-orizzonte', '30'), { dopo: 700 });
      await R.clic(segmento(p, 'pv-vista', 'giorno'), { dopo: 900 });
      await R.clic(segmento(p, 'pv-vista', 'settimana'), { dopo: 500 });
    });
    await R.passo(async () => {
      await R.anello('#pv-ind', { dopo: 1800 });
    });
    await R.passo(async () => {
      await R.anello('#pv-grafico', { dopo: 1500 });
      const b = await p.locator('#pv-grafico').boundingBox();
      if (b) {
        const x = Math.round(b.x + b.width * 0.82), y = Math.round(b.y + b.height * 0.45);
        await R.muovi(x, y);
        await p.mouse.move(x, y);
        await pausa(1500);
      }
    });
    await R.passo(async () => {
      await R.clic('#pv-tab-fabbisogno', { dopo: 800 });
      await R.anello('#pv-tabella thead', { dopo: 1500 });
    });
    await R.passo(async () => {
      await R.clic('#pv-tabella .an-art-btn', { dopo: 1200 });
      await R.finestra();
      await R.anello('#pvd-grafico', { dopo: 1500 });
      await R.togliAnello();
      await p.evaluate(() => { const m = document.querySelector('#modale .modale-corpo'); if (m) m.scrollTo({ top: 600, behavior: 'smooth' }); });
      await pausa(1400);
      await R.tasti('Escape', 'Esc');
    });
    await R.passo(async () => {
      await R.clic('#pv-tab-abc', { dopo: 1000 });
      await R.anello('#pv-pannello .an-abc-griglia', { dopo: 1000 });
      await R.togliAnello();
      const cella = p.locator('#pv-pannello .an-abc-griglia button, #pv-pannello .an-abc-griglia [data-classe]').first();
      if (await cella.count()) await R.clic(cella, { dopo: 1200 });
    });
    await R.passo(async () => {
      await R.clic('#pv-tab-ordine', { dopo: 1000 });
      if (await p.locator('#pv-a-struttura').count()) await R.clic('#pv-a-struttura', { dopo: 1000 });
      await R.anello('#pv-proposta .an-conf', { dopo: 600 });
      const c = p.locator('#pv-proposta .an-conf').first();
      const v = Number(await c.inputValue()) || 1;
      await R.scrivi(c, String(v + 1), { svuota: true, ritmo: 150, dopo: 600 });
      await p.keyboard.press('Tab');
    });
    await R.passo(async () => {
      await R.punta('#pv-ordine-excel');
      await pausa(500);
      await R.punta('#pv-ordine-stampa');
      await pausa(500);
      await R.anello('#pv-ordine-ripristina', { dopo: 1000 });
    });
  }
};

SCENARI.distribuzione = {
  utente: 'direzione',
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('distribuzione');
      await pausa(600);
      await R.scegli('#ds-periodo', '3', { dopo: 1200 });
    });
    await R.passo(async () => {
      await R.scegli('#ds-cat', 'FARMACI', { dopo: 800 });
      await R.clic(segmento(p, 'ds-misura', 'valore'), { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.anello('#ds-ind', { dopo: 1800 });
    });
    await R.passo(async () => {
      await R.anello('#ds-sankey', { dopo: 1000 });
      await R.togliAnello();
      const b = await p.locator('#ds-sankey').boundingBox();
      if (b) {
        const x = Math.round(b.x + b.width * 0.5), y = Math.round(b.y + b.height * 0.3);
        await R.muovi(x, y);
        await p.mouse.move(x, y);
        await pausa(1800);
      }
    });
    await R.passo(async () => {
      await R.anello('#ds-mesi', { dopo: 1800 });
    });
    await R.passo(async () => {
      await R.anello('#ds-dove', { dopo: 1000 });
      const v = await p.evaluate(() => { const o = document.querySelectorAll('#ds-art option'); return o.length > 1 ? o[1].value : ''; });
      if (v) await R.scegli('#ds-art', v, { dopo: 1400 });
    });
    await R.passo(async () => {
      await R.anello('#ds-tabella-box', { dopo: 1300 });
      await R.togliAnello();
      const camion = p.locator('#ds-tabella-box', { hasText: '🚚' });
      if (await camion.count()) await R.anello(p.locator('#ds-tabella-box td', { hasText: '🚚' }).first(), { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.punta('#ds-excel');
      await R.anello('#ds-excel', { dopo: 1200 });
    });
  }
};

SCENARI.articoli = {
  utente: 'farmacista',
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('articoli');
      await R.scrivi('#a-cerca', 'paraceta', { ritmo: 140, dopo: 900 });
      await R.punta('#a-cat');
    });
    await R.passo(async () => {
      await R.clic('#a-tab tbody tr:nth-child(1) td:nth-child(1)', { dopo: 2600, fx: 0.3 });
      await R.tasti('Escape', 'Esc');
      await p.fill('#a-cerca', '');
      await p.dispatchEvent('#a-cerca', 'input');
    });
    await R.passo(async () => {
      await R.clic('#a-nuovo', { dopo: 700 });
      await R.finestra('#fa-nome');
      await R.scrivi('#fa-nome', 'IBUPROFENE 400 mg cpr', { ritmo: 55 });
    });
    await R.passo(async () => {
      await R.scegli('#fa-cat', 'FARMACI', { dopo: 300 });
      await R.scrivi('#fa-unita', 'cpr', { ritmo: 80, dopo: 200 });
      await R.scrivi('#fa-principio', 'Ibuprofene', { ritmo: 50, dopo: 200 });
      await R.scrivi('#fa-confezione', 'conf. da 30 cpr', { ritmo: 40, dopo: 200 });
      await R.scrivi('#fa-codice', '012745093', { ritmo: 50, dopo: 200 });
    });
    await R.passo(async () => {
      await R.scrivi('#fa-pezzi', '30', { svuota: true });
      await R.anello('#fa-codice-letto', { dopo: 800 });
      await R.togliAnello();
      await R.scrivi('#fa-prezzo', '0,12');
      await R.scrivi('#fa-scorta', '60');
    });
    await R.passo(async () => {
      await R.scrivi('#fa-fornitore', 'Deposito Alfa (prova)', { ritmo: 55 });
    });
    await R.passo(async () => {
      await R.scrivi('#fa-leadtime', '5', { dopo: 300 });
      await R.anello('#fa-leadtime', { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.anello('.attributi-articolo', { dopo: 900 });
      await R.togliAnello();
      await R.clic('[data-attributo="lasa"]', { dopo: 700 });
    });
    await R.passo(async () => {
      await R.clic('#fa-salva', { dopo: 300 });
      await R.avviso('Articolo creato');
      await pausa(500);
    });
    await R.passo(async () => {
      await R.anello(p.locator('label.spunta:has(#a-non)'), { dopo: 1300 });
      await R.togliAnello();
      if (await p.locator('#a-tab [data-modifica]').count()) {
        await R.clic('#a-tab [data-modifica]', { dopo: 900 });
        await R.finestra('#fa-attivo');
        await R.anello(p.locator('#modale label.spunta:has(#fa-attivo)'), { dopo: 1400 });
        await R.tasti('Escape', 'Esc');
      }
    });
    await R.passo(async () => {
      await R.punta('#a-importa');
      await R.anello('#a-importa', { dopo: 800 });
      await R.togliAnello();
      await R.anello('#a-excel', { dopo: 800 });
    });
  }
};

/* ---------- accesso, password, verifica in due passaggi, marchio e tema ---------- */

// attivazione della verifica in due passaggi dentro la procedura (js/sicurezza.js): dal passo del codice QR in poi
async function collegaApp(R, utente) {
  const p = R.page;
  // la chiave scritta sta in una sezione chiusa («Non riesci a inquadrarlo?»): c'è, anche se non si vede
  await p.waitForSelector('#sic-chiave-testo', { state: 'attached', timeout: 10000 });
  const chiave = await p.evaluate(() => document.getElementById('sic-chiave-testo').textContent);
  return { chiave, codice: async () => codiceApp(chiave), utente };
}

SCENARI['primo-accesso'] = {
  utente: 'esordiente', daAccesso: true, conInvito: true,
  async prepara(srv) {
    // il criterio chiede la verifica in due passaggi ai farmacisti (lo cambia l'amministratore che ce l'ha già)
    await srv.chiama('tecnico', 'PUT', 'api/sicurezza', { richiedi2fa: 'farmacisti' });
  },
  async dopo(srv) {
    await srv.chiama('tecnico', 'PUT', 'api/sicurezza', { richiedi2fa: 'nessuno' });
    await srv.chiama('tecnico', 'POST', 'api/utenti/' + srv.ids.esordiente + '/2fa/azzera', {}).catch(() => {});
  },
  async gira(R) {
    const p = R.page;
    const u = UTENTI.esordiente;
    const nuova = 'Mia-Password-2026';
    await R.passo(async () => {
      await R.barraIndirizzo('http://server-farmacia:8080/');
    }, { piu: 300 });
    await R.passo(async () => {
      await R.togliBarra();
      await R.anello('.accesso-scheda', { dopo: 700 });
      await R.togliAnello();
      await R.scrivi('#acc-user', u.username, { ritmo: 75 });
      await R.scrivi('#acc-pw', u.provvisoria, { ritmo: 50 });
      await R.clic('#acc-invia', { dopo: 300 });
      await p.waitForSelector('#acc-attuale', { timeout: 10000 });
      await pausa(300);
    });
    await R.passo(async () => {
      await R.scrivi('#acc-attuale', u.provvisoria, { ritmo: 40, dopo: 250 });
      await R.scrivi('#acc-pw', nuova, { ritmo: 38, dopo: 250 });
      await R.scrivi('#acc-pw2', nuova, { ritmo: 38, dopo: 250 });
      await R.clic('#acc-invia', { dopo: 300 });
      await p.waitForSelector('#acc-attivazione #sic-avanti', { timeout: 10000 });
      await pausa(400);
    });
    await R.passo(async () => {
      await R.anello('.accesso-scheda .banda.info', { dopo: 600 });
      await R.togliAnello();
      await R.clic('#sic-avanti', { dopo: 700 });
      const app = await collegaApp(R, u.username);
      await R.anello('.sic-qr', { dopo: 600 });
      await R.togliAnello();
      const codice = await app.codice();
      await p.evaluate((d) => window.__regia.telefono('codice', d), { emittente: 'Pharmacy', utente: u.username, codice });
      await pausa(500);
      await R.scrivi('#sic-codice', codice, { ritmo: 90, dopo: 700 });
      await p.evaluate(() => window.__regia.telefono(null));
      await R.el('#sic-salvati', 10000);
      await R.clic(p.locator('label:has(#sic-salvati)'), { dopo: 400 });
      await R.clic('#sic-fine', { dopo: 300 });
      await p.waitForSelector('#app:not([hidden])', { timeout: 10000 });
    }, { alto: true });
    await R.passo(async () => {
      const invito = await attendi(async () => (await p.locator('.tour-invito').count()) > 0, 5000);
      if (!invito) throw new Error('l’invito al giro guidato non è comparso');
      await R.anello('.tour-invito', { dopo: 1800 });
      await R.togliAnello();
      await R.punta('.tour-invito [data-invito="si"]');
      await pausa(500);
      await R.clic('.tour-invito [data-invito="dopo"]');
    });
    await R.passo(async () => {
      await R.anello('#menu', { dopo: 900 });
      await R.togliAnello();
      await R.punta('#menu a[data-pagina="carico"] kbd');
      await pausa(600);
      const conta = p.locator('#menu a .conta, #menu a .numero, #menu a .contatore').first();
      if (await conta.count()) await R.anello(conta, { dopo: 900 });
    });
    await R.passo(async () => {
      await R.anello('#contenuto .indicatori', { dopo: 1200 });
      await R.togliAnello();
      if (await p.locator('#cr-fare').count()) await R.anello('#cr-fare', { dopo: 1100 });
    });
    await R.passo(async () => {
      await R.tasti('Control+k', 'Ctrl + K');
      await p.keyboard.type('keto', { delay: 160 });
      await pausa(1600);
      await R.tasti('Escape', 'Esc');
    });
    await R.passo(async () => {
      await R.clic('#utente-btn', { dopo: 900 });
      await R.anello('#utente-tendina', { dopo: 1600 });
      await R.togliAnello();
      await p.keyboard.press('Escape');
    });
    await R.passo(async () => {
      await R.anello('#guidami', { dopo: 900 });
      await R.togliAnello();
      await R.menu('guida');
      await R.anello('#guide-griglia', { dopo: 800 });
    });
  }
};

SCENARI.password = {
  utente: 'nuovo', daAccesso: true,
  async gira(R) {
    const p = R.page;
    const u = UTENTI.nuovo;
    const prima = 'Ambulatori-2026!';
    const dopo = 'Ambulatori-2026?';
    await R.passo(async () => {
      await R.scrivi('#acc-user', u.username, { ritmo: 100 });
      await R.scrivi('#acc-pw', u.provvisoria, { ritmo: 80 });
      await R.clic('#acc-invia', { dopo: 300 });
      await p.waitForSelector('#acc-attuale', { timeout: 8000 });
    });
    await R.passo(async () => {
      await R.scrivi('#acc-attuale', u.provvisoria, { ritmo: 60 });
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
      await R.scrivi('#acc-user', u.username, { ritmo: 90 });
      await R.scrivi('#acc-pw', 'Ambulatori-2025', { ritmo: 70 });
      await R.clic('#acc-invia', { dopo: 1200 });
      await R.anello('.accesso-errore', { dopo: 1200 });
      await R.togliAnello();
      await R.anello('.accesso-scheda', { dopo: 600 });
    });
  }
};

SCENARI['sicurezza-2fa'] = {
  utente: 'admin',
  async dopo(srv) {
    // tutto come prima: criterio "nessuno", verifica dell'amministratore azzerata, sessione nuova per l'API
    await srv.chiama('tecnico', 'PUT', 'api/sicurezza', { richiedi2fa: 'nessuno' });
    await srv.chiama('tecnico', 'POST', 'api/utenti/' + srv.ids.admin + '/2fa/azzera', {}).catch(() => {});
    await srv.accedi('admin');
  },
  async gira(R) {
    const p = R.page;
    const u = UTENTI.admin;
    let chiave = '';
    await R.passo(async () => {
      await p.evaluate(() => window.__regia.telefono('app'));
      await pausa(3200);
    });
    await R.passo(async () => {
      await R.clic('#utente-btn', { dopo: 800 });
      await R.clic('#utente-sicurezza', { dopo: 900 });
      await R.finestra('#sic-account');
      await p.evaluate(() => window.__regia.telefono(null));
      await R.clic('#sic-attiva', { dopo: 900 });
    });
    await R.passo(async () => {
      await R.anello('#sic-avanti', { dopo: 900 });
      await R.togliAnello();
      await R.clic('#sic-avanti', { dopo: 900 });
    }, { alto: true });
    await R.passo(async () => {
      await p.waitForSelector('#sic-chiave-testo', { state: 'attached', timeout: 10000 });
      chiave = await p.evaluate(() => document.getElementById('sic-chiave-testo').textContent);
      await p.evaluate(() => window.__regia.telefono('scansiona'));
      await R.anello('.sic-qr', { dopo: 2600 });
    }, { alto: true });
    await R.passo(async () => {
      const codice = await codiceApp(chiave);
      this.passoAttivazione = Math.floor(Date.now() / 30000);
      await p.evaluate((d) => window.__regia.telefono('codice', d), { emittente: 'Pharmacy', utente: u.username, codice });
      await pausa(1200);
      await R.scrivi('#sic-codice', codice, { ritmo: 160, dopo: 900 });
      await R.el('#sic-salvati', 10000);
      await p.evaluate(() => window.__regia.telefono(null));
    }, { alto: true });
    await R.passo(async () => {
      await R.anello('.sic-codici', { dopo: 1200 });
      await R.togliAnello();
      await R.clic('#sic-scarica', { dopo: 800 });
      await R.punta('#sic-stampa-codici');
    }, { alto: true });
    await R.passo(async () => {
      await R.clic(p.locator('label:has(#sic-salvati)'), { dopo: 500 });
      await R.clic('#sic-fine', { dopo: 1000 });
      if (await p.locator('#modale:not([hidden])').count()) await p.keyboard.press('Escape');
      await pausa(500);
    }, { alto: true });
    await R.passo(async () => {
      await R.clic('#utente-btn', { dopo: 700 });
      await R.clic('#utente-esci', { dopo: 300 });
      await p.waitForSelector('#acc-form', { timeout: 8000 });
      await R.scrivi('#acc-user', u.username, { ritmo: 60, dopo: 200 });
      await R.scrivi('#acc-pw', PW, { ritmo: 35, dopo: 200 });
      await R.clic('#acc-invia', { dopo: 300 });
      await p.waitForSelector('#acc-codice', { timeout: 8000 });
      // ogni codice vale una volta: se siamo ancora nei 30 secondi dell'attivazione, l'app mostra già quello dopo
      // (il server accetta anche il codice dei 30 secondi vicini)
      const passo = Math.max(Math.floor(Date.now() / 30000), this.passoAttivazione + 1);
      this.codice = Totp.totp(chiave.replace(/\s+/g, '').toUpperCase(), passo * 30000 + 1000);
      await p.evaluate((d) => window.__regia.telefono('codice', d), { emittente: 'Pharmacy', utente: u.username, codice: this.codice });
      await pausa(900);
      // con la sesta cifra il programma entra da solo: l'ultima si scrive dopo aver spuntato «Ricorda questo computer»
      await R.scrivi('#acc-codice', this.codice.slice(0, 5), { ritmo: 160, dopo: 500 });
      await R.punta('#acc-verifica');
    });
    await R.passo(async () => {
      await R.clic(p.locator('label:has(#acc-ricorda)'), { dopo: 900 });
      await R.clic('#acc-codice', { dopo: 200 });
      await p.keyboard.press('End');
      await p.keyboard.type(this.codice.slice(5), { delay: 150 });
      await p.evaluate(() => window.__regia.telefono(null));
      await p.waitForSelector('#app:not([hidden])', { timeout: 10000 });
      await pausa(600);
    });
    await R.passo(async () => {
      await R.menu('sicurezza');
      await R.el('.sic-criteri', 8000);
      await R.anello('.sic-criteri', { dopo: 900 });
      await R.togliAnello();
      await R.clic('.sic-criteri input[value="amministratori"]', { dopo: 600, forza: true });
      await R.clic('#sic-salva-criterio', { dopo: 300 });
      if (await p.locator('#conferma-si').count()) await R.clic('#conferma-si', { dopo: 300 });
      await R.avviso('Criterio salvato');
    });
  }
};

SCENARI.personalizza = {
  utente: 'admin',
  async dopo(srv) { await srv.marchioNeutro(); },
  async gira(R, srv) {
    const p = R.page;
    await R.passo(async () => {
      await R.clic('#utente-btn', { dopo: 900 });
      await R.anello('#utente-tendina .utente-tema', { dopo: 800 });
      await R.togliAnello();
      await R.clic('[data-scegli-tema="scuro"]', { dopo: 900 });
    });
    await R.passo(async () => {
      if (await p.locator('#utente-tendina:not([hidden])').count()) await p.keyboard.press('Escape');
      await pausa(1500);
      await R.clic('#utente-btn', { dopo: 700 });
      await R.clic('[data-scegli-tema="automatico"]', { dopo: 700 });
      if (await p.locator('#utente-tendina:not([hidden])').count()) await p.keyboard.press('Escape');
    });
    await R.passo(async () => {
      await R.menu('configura');
      await R.anello(p.locator('section.scheda:has(#k-prodotto)'), { dopo: 1200 });
    });
    await R.passo(async () => {
      await R.scrivi('#k-prodotto', 'Farmacia Ospedaliera', { svuota: true, ritmo: 60 });
      await R.scrivi('#k-sigla', 'Farmacia', { svuota: true, ritmo: 70 });
      await R.scrivi('#k-struttura', 'Clinica Demo', { svuota: true, ritmo: 60 });
      await R.scrivi('#k-sotto', 'Ospedale di prova · Farmacia interna', { svuota: true, ritmo: 45 });
    });
    await R.passo(async () => {
      await R.anello(p.locator('.cf-logo').first().locator('xpath=..'), { dopo: 900 });
      await R.togliAnello();
      // un logo dimostrativo (un simbolo generico, nessun marchio vero)
      const logo = path.join(srv.lavoro, 'logo-prova.svg');
      fs.writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f8a8a"/><path d="M26 14h12v12h12v12H38v12H26V38H14V26h12z" fill="#fff"/></svg>');
      await R.punta('#k-logo');
      await p.evaluate(() => window.__regia.premi());
      const scelta = p.waitForEvent('filechooser', { timeout: 5000 });
      await p.locator('#k-logo').click();
      await (await scelta).setFiles(logo);
      await pausa(1000);
      await R.anello('#k-logo-caricato', { dopo: 900 });
    });
    await R.passo(async () => {
      await R.clic(p.locator('label.spunta:has(#k-accento-predefinito)'), { dopo: 600 });
      await R.punta('#k-accento');
      await p.evaluate(() => { const c = document.getElementById('k-accento'); c.value = '#0f8a8a'; c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true })); });
      await pausa(800);
      await R.scegli('#k-tema', 'chiaro', { dopo: 700 });
    });
    await R.passo(async () => {
      await R.anello('#k-anteprima', { dopo: 1600 });
      await R.togliAnello();
      await R.clic('#k-salva', { dopo: 300 });
      await R.avviso('salvat');
      await pausa(800);
      await R.anello('#marchio', { dopo: 1000 });
    });
  }
};

/* ---------- utenti, registro attività, sistema, copie di sicurezza ---------- */

SCENARI.utenti = {
  utente: 'admin',
  async gira(R) {
    const p = R.page;
    const riga = '#u-tab tbody tr:has-text("a.russo")';
    await R.passo(async () => {
      await R.menu('utenti');
      await R.anello('#contenuto .banda.info', { dopo: 1600 });
    });
    await R.passo(async () => {
      await R.clic('#u-nuovo', { dopo: 700 });
      await R.finestra('#u-username');
      await R.scrivi('#u-username', 'a.russo', { ritmo: 110 });
      await R.scrivi('#u-nome', 'Anna Russo', { ritmo: 90 });
    });
    await R.passo(async () => {
      await R.anello('#u-ruolo', { dopo: 700 });
      await R.scegli('#u-ruolo', 'reparto', { dopo: 700 });
    });
    await R.passo(async () => {
      await R.clic('.u-rep[value="r-sala"]', { dopo: 700 });
      await R.anello('#u-reparti', { dopo: 800 });
    });
    await R.passo(async () => {
      await R.clic('[data-genera="u-password"]', { dopo: 600 });
      await R.anello('#u-password', { dopo: 900 });
      await R.togliAnello();
      await R.clic('#u-salva', { dopo: 300 });
      await R.avviso('creato');
      await p.waitForSelector(riga, { timeout: 5000 });
      await R.anello(riga, { dopo: 900 });
    }, { alto: true });
    await R.passo(async () => {
      await R.clic(riga + ' [data-password]', { dopo: 800 });
      await R.finestra('#u-password');
      await R.anello('#modale #u-salva', { dopo: 1200 });
      await R.tasti('Escape', 'Esc');
    });
    await R.passo(async () => {
      await R.clic(riga + ' [data-modifica]', { dopo: 800 });
      await R.finestra('#u-ruolo');
      await R.anello(p.locator('#modale label.spunta:has(#u-attivo)'), { dopo: 1400 });
      await R.tasti('Escape', 'Esc');
    });
    await R.passo(async () => {
      await R.menu('sicurezza');
      await R.el('#sic-utenti [data-azzera]', 8000);
      await R.anello(p.locator('#sic-utenti tr:has([data-azzera])').first(), { dopo: 900 });
      await R.togliAnello();
      await R.punta('#sic-utenti [data-azzera]');
    });
  }
};

SCENARI.attivita = {
  utente: 'admin',
  async prepara(srv) {
    // due tentativi di accesso sbagliati di stamattina (le righe in rosso)
    const c = await srv.browser.newContext();
    for (let i = 0; i < 2; i++) await chiamaApi(c.request, srv.base, 'POST', 'api/login', { username: UTENTI.reparto.username, password: 'password-sbagliata' }).catch(() => {});
    await c.close();
  },
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('attivita');
      await R.el('#t-tab tbody tr', 8000);
      await R.anello('#t-tab', { dopo: 1500 });
    });
    await R.passo(async () => {
      await R.punta('#t-dal');
      await pausa(400);
      const dal = await R.clic('#t-dal', { dopo: 200 });
      await dal.fill(giorniFa(1));
      await dal.dispatchEvent('change');
      await pausa(700);
      await R.punta('#t-al');
    });
    await R.passo(async () => {
      await R.scrivi('#t-utente', UTENTI.reparto.username, { ritmo: 110, dopo: 1200 });
    });
    await R.passo(async () => {
      await R.scegli('#t-azione', 'richieste', { dopo: 1300 });
      await R.scegli('#t-azione', 'accesso', { dopo: 900 });
    });
    await R.passo(async () => {
      await R.anello('#t-tab thead', { dopo: 1100 });
      await R.togliAnello();
      await R.anello('#t-tab tbody tr:nth-child(1)', { dopo: 1200 });
    });
    await R.passo(async () => {
      await R.anello(p.locator('#t-tab td', { hasText: 'Accesso non riuscito' }).first().locator('xpath=..'), { dopo: 1600 });
    });
    await R.passo(async () => {
      await R.punta('#t-excel');
      await pausa(500);
      await R.anello('#t-aggiorna', { dopo: 1000 });
    });
  }
};

SCENARI.sistema = {
  utente: 'admin',
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('sistema');
      await R.el('#sis-semaforo', 8000);
      await R.anello('#sis-stato', { dopo: 1500 });
    });
    await R.passo(async () => {
      await R.clic('#sis-controlla', { dopo: 300 });
      await attendi(() => p.evaluate(() => (document.getElementById('sis-esito').textContent || '').trim().length > 0), 15000);
      await pausa(600);
      await R.anello('#sis-esito', { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.clic('#sis-copia', { dopo: 300 });
      await attendi(() => p.evaluate(() => /copia/i.test(document.getElementById('sis-esito').textContent || '')), 25000);
      await pausa(600);
      await R.anello('#sis-esito', { dopo: 1000 });
    });
    await R.passo(async () => {
      await R.clic('#sis-prova', { dopo: 300 });
      await attendi(() => p.evaluate(() => /cura|differenz/i.test(document.getElementById('sis-esito').textContent || '')), 25000);
      await pausa(500);
    });
    await R.passo(async () => {
      await R.anello('#sis-esito', { dopo: 1300 });
      await R.togliAnello();
      if (await p.locator('.sis-prova-testa').count()) await R.anello('.sis-prova-testa', { dopo: 1200 });
    });
    await R.passo(async () => {
      for (const s of ['#sis-numeri', '#sis-grafico', '#sis-copie', '#sis-cronologia']) {
        if (!(await p.locator(s).count())) continue;
        await R.anello(s, { dopo: 1100 });
        await R.togliAnello();
      }
    });
    await R.passo(async () => {
      // il server di solito è un PC Windows: il percorso dell'esempio della guida (non si salva: il disco qui non c'è)
      await R.scrivi('#sis-seconda-percorso', 'E:\\CopieFarmacia', { ritmo: 70, dopo: 500 });
      await R.punta('#sis-seconda-salva');
      await R.anello('#sis-seconda-salva', { dopo: 1000 });
    });
  }
};

SCENARI.copie = {
  utente: 'admin',
  async gira(R) {
    const p = R.page;
    await R.passo(async () => {
      await R.menu('configura');
      await R.anello('section.scheda:has(#k-backup)', { dopo: 1300 });
    });
    await R.passo(async () => {
      await p.waitForSelector('#k-backup .tabella', { timeout: 8000 });
      await R.anello('#k-backup .tabella', { dopo: 1200 });
      await R.togliAnello();
      const verificata = p.locator('#k-backup .tabella td', { hasText: 'verificata' }).first();
      if (await verificata.count()) await R.anello(verificata, { dopo: 1000 });
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
      await R.finestra('#forte-parola');
      await R.anello('#modale .modale-corpo', { dopo: 1000 });
    }, { alto: true });
    await R.passo(async () => {
      await R.scrivi('#forte-parola', 'RIPRISTINA', { ritmo: 120, dopo: 600 });
      await R.anello('#modale .modale-piede .btn.pericolo, #modale .modale-piede .btn.primario', { dopo: 1300 });
      await R.togliAnello();
      await R.clic('#modale .modale-piede [data-chiudi]', { dopo: 600 });
    }, { alto: true });
    await R.passo(async () => {
      await R.menu('sistema');
      await R.el('#sis-copie', 8000);
      await R.anello('#sis-copie', { dopo: 1200 });
      await R.togliAnello();
      await R.anello('#sis-seconda-modulo', { dopo: 1000 });
    });
  }
};

/* ======================= server, utenti e dati di prova ======================= */

async function chiamaApi(req, base, metodo, url, corpo) {
  const r = await req.fetch(/^https?:/.test(url) ? url : base + url, { method: metodo, data: corpo, headers: { 'X-Richiesta': '1' } });
  const testo = await r.text();
  let j = null;
  try { j = JSON.parse(testo); } catch (e) { /* non JSON */ }
  if (!r.ok()) throw new Error(metodo + ' ' + url + ': ' + r.status() + ' ' + ((j && j.errore) || testo.slice(0, 200)));
  return j;
}

/* Il server di prova visto dagli scenari: un contesto (sessione) per ogni utente. */
class ServerProva {
  constructor(browser, base) {
    this.browser = browser;
    this.base = base;
    this.contesti = {};
    this.ids = {};
    this.segreti = {};
  }
  chiama(chi, metodo, url, corpo) {
    if (!this.contesti[chi]) throw new Error('utente senza sessione: ' + chi);
    return chiamaApi(this.contesti[chi].request, this.base, metodo, url, corpo);
  }
  dati() { return this.chiama('admin', 'GET', 'api/dati?da=0'); }
  // nuova sessione per un utente (con il codice dell'app se ha la verifica in due passaggi)
  async accedi(chi, password) {
    const u = UTENTI[chi];
    if (this.contesti[chi]) await this.contesti[chi].close().catch(() => {});
    const c = await this.browser.newContext();
    const r = await chiamaApi(c.request, this.base, 'POST', 'api/login', { username: u.username, password: password || PW });
    if (r && (r.serve2fa || r.sfida || r.dueFattori)) {
      await chiamaApi(c.request, this.base, 'POST', 'api/login/2fa', { codice: await codiceApp(this.segreti[chi]) });
    }
    this.contesti[chi] = c;
    return c;
  }
  async marchioNeutro() {
    const imp = (await this.dati()).impostazioni;
    if (Object.keys(NEUTRO).some((k) => imp[k] !== NEUTRO[k])) await this.chiama('admin', 'PUT', 'api/impostazioni', Object.assign({}, imp, NEUTRO));
  }
}

async function preparaServer(browser, base) {
  const srv = new ServerProva(browser, base);
  // amministratore (dal server stesso), marchio neutro, dati di prova
  const ctxAdmin = await browser.newContext();
  const st = await chiamaApi(ctxAdmin.request, base, 'POST', 'api/setup', { username: UTENTI.admin.username, nome: UTENTI.admin.nome, password: PW });
  srv.contesti.admin = ctxAdmin;
  srv.ids.admin = st.utente.id;
  await srv.marchioNeutro();
  await srv.chiama('admin', 'POST', 'api/demo', {});
  // gli altri utenti: chi non ha una password provvisoria da mostrare ha già scelto la sua
  for (const k of Object.keys(UTENTI)) {
    if (k === 'admin') continue;
    const u = UTENTI[k];
    const provvisoria = u.provvisoria || 'Provvisoria-1';
    const r = await srv.chiama('admin', 'POST', 'api/utenti', { username: u.username, nome: u.nome, ruolo: u.ruolo, reparti: u.reparti || [], password: provvisoria });
    srv.ids[k] = r.utente.id;
    if (u.provvisoria) continue;
    const c = await browser.newContext();
    await chiamaApi(c.request, base, 'POST', 'api/login', { username: u.username, password: provvisoria });
    await chiamaApi(c.request, base, 'POST', 'api/password', { attuale: provvisoria, nuova: PW });
    srv.contesti[k] = c;
    if (u.dueFattori) {
      const ini = await srv.chiama(k, 'POST', 'api/2fa/inizia', {});
      srv.segreti[k] = ini.segretoBase32;
      await srv.chiama(k, 'POST', 'api/2fa/conferma', { codice: await codiceApp(ini.segretoBase32) });
    }
  }
  await costruisciMondo(srv);
  return srv;
}

/*
 * Una struttura "vissuta", fatta con l'API come la farebbero gli utenti:
 * - articoli completi (confezione, pezzi per confezione, frigorifero, stupefacenti, fornitore abituale, giorni di consegna);
 * - un magazzino in più al 2° piano (Medicina);
 * - armadi in ogni magazzino (in farmacia e in Degenza anche frigorifero e cassaforte) con gli articoli al loro posto
 *   (in Degenza qualcuno ancora da disporre);
 * - assortimenti con le scorte calcolate dai consumi (qualche articolo sotto scorta e qualcuno da riordinare);
 * - richieste e DDT in ogni stato, consumi di stamattina, una copia di sicurezza verificata.
 */
async function costruisciMondo(srv) {
  const A = (m, u, c) => srv.chiama('admin', m, u, c);
  const FARMACIA = 'r-farmacia', DEGENZA = 'r-degenza', SALA = 'r-sala', AMBULATORI = 'r-ambulatori';

  /* --- articoli completi --- */
  let dati = await srv.dati();
  const demo = Demo.crea(Calcoli, { centrale: FARMACIA, reparti: [DEGENZA, SALA, AMBULATORI], oggi: new Date() });
  for (const a of dati.articoli) {
    const d = demo.articoli.find((x) => x.id === a.id);
    if (!d) continue;
    await A('PUT', 'api/articoli/' + a.id, Object.assign({}, a, {
      confezione: d.confezione || '', pezziConfezione: d.pezziConfezione || 1, attributi: d.attributi || [], leadTime: d.leadTime, fornitore: d.fornitore || ''
    }));
  }

  /* --- un magazzino al 2° piano --- */
  const med = (await A('POST', 'api/magazzini', { nome: 'Medicina', tipo: 'periferico', livello: 2, piano: '2° piano', descrizione: 'Medicina generale, 24 posti letto' })).magazzino;
  srv.medicina = med.id;

  /* --- richieste e DDT: le operazioni che servono anche più avanti --- */
  const ric = (chi, rep, righe, opz) => srv.chiama(chi, 'POST', 'api/richieste', Object.assign({ repartoId: rep, fornitoreId: FARMACIA, righe, invia: true }, opz || {}));
  const righe = (lista, q) => lista.map((a, i) => ({ articoloId: a.id, quantita: q + 2 * i }));
  const F = (m, u, c) => srv.chiama('farmacista', m, u, c);
  const spedisci = (ddtId, colli) => F('POST', 'api/ddt/' + ddtId + '/spedisci', { trasportatoreNome: PORTATORE, colli: colli || 1 });
  const ricevi = async (chi, d, diff) => srv.chiama(chi, 'POST', 'api/ddt/' + d.ddt.id + '/ricevi', {
    righe: d.righe.map((r, i) => ({ id: r.id, ricevuta: diff && i === 0 ? Math.max(0, r.quantita - 1) : r.quantita, esito: diff && i === 0 ? 'rientro' : '', nota: diff && i === 0 ? 'Una confezione schiacciata, rimandata in farmacia' : '' })),
    note: diff ? 'Scatola aperta, consegnata alle 15:20' : ''
  });

  /* --- consumo medio degli ultimi 28 giorni (uscite: consumi, perdite e trasferimenti in uscita) --- */
  dati = await srv.dati();
  let giac = Calcoli.tutteLeGiacenze(dati);
  const g = (art, rep) => giac[art + '|' + rep] || 0;
  const da28 = giorniFa(28);
  const uscite = {};
  dati.movimenti.forEach((m) => {
    if (m.annullato || m.data < da28) return;
    if (m.tipo === 'consumo' || m.tipo === 'perdita' || m.tipo === 'trasferimento') uscite[m.articoloId + '|' + m.repartoId] = (uscite[m.articoloId + '|' + m.repartoId] || 0) + Math.abs(m.quantita);
  });
  const media = (art, rep) => (uscite[art + '|' + rep] || 0) / 28;
  const articoli = dati.articoli.filter((a) => a.attivo !== false);
  const attr = (a, x) => (a.attributi || []).indexOf(x) >= 0;

  /* --- il rifornimento settimanale della Degenza, arrivato ieri: copre circa 10 giorni di quasi tutti gli articoli
         (ricevuto con una differenza). Così «Proponi le quantità» propone solo quello che serve davvero. --- */
  const perDegenza = articoli.filter((a) => g(a.id, DEGENZA) > 0 || media(a.id, DEGENZA) > 0);
  const daMandare = perDegenza.filter((a, i) => i % 5 !== 3 && g(a.id, FARMACIA) > 20)
    .map((a) => ({ articoloId: a.id, quantita: Math.ceil(Math.max(0, media(a.id, DEGENZA) * 10 + 2 - g(a.id, DEGENZA))) }))
    .filter((x) => x.quantita > 0 && x.quantita <= g(x.articoloId, FARMACIA) / 3);
  if (daMandare.length) {
    const r1 = await ric('reparto', DEGENZA, daMandare, { note: 'Rifornimento settimanale' });
    const d1 = await F('POST', 'api/richieste/' + r1.richiesta.id + '/ddt', {});
    await spedisci(d1.ddt.id, 3);
    await ricevi('reparto', d1, true);
    dati = await srv.dati();
    giac = Calcoli.tutteLeGiacenze(dati);
  }

  /* --- assortimento: scorte da circa 3, 7 e 14 giorni di consumo; qualcuno sotto scorta, qualcuno da riordinare --- */
  const assortimento = async (rep, scelti) => {
    const righe = scelti.map((a, i) => {
      const m = Math.max(0.3, media(a.id, rep));
      const q = g(a.id, rep);
      let min = Math.max(1, Math.ceil(m * 3)), rio = Math.max(min + 1, Math.ceil(m * 7)), max = Math.max(rio + 2, Math.ceil(m * 14));
      if (i % 7 === 2 && q > 0) { min = Math.ceil(q + 3); rio = Math.max(rio, min + 4); max = Math.max(max, rio * 2); }      // sotto scorta
      else if (i % 7 === 5) { rio = Math.ceil(q + 2); min = Math.min(min, Math.max(0, Math.floor(q * 0.6))); max = Math.max(max, rio * 2); } // da riordinare
      else {
        // in ordine: soglie sotto la giacenza di oggi (i rifornimenti arrivano una volta alla settimana)
        if (q <= rio) { rio = Math.max(1, Math.floor(q * 0.8)); min = Math.min(min, Math.max(0, Math.floor(rio * 0.5))); }
        if (q > max) max = Math.ceil(q * 1.2);
      }
      return { articoloId: a.id, scortaMin: Math.max(0, min), puntoRiordino: Math.max(min, rio), scortaMax: Math.max(rio, max) };
    });
    await A('PUT', 'api/assortimento', { repartoId: rep, righe });
    return scelti;
  };
  const conMerce = (rep) => articoli.filter((a) => g(a.id, rep) > 0);
  const assF = await assortimento(FARMACIA, conMerce(FARMACIA));
  const assD = await assortimento(DEGENZA, conMerce(DEGENZA));
  const assS = await assortimento(SALA, conMerce(SALA));
  const assA = await assortimento(AMBULATORI, conMerce(AMBULATORI));

  /* --- armadi e posti: frigorifero e cassaforte per gli articoli con quelle caratteristiche --- */
  const armadio = async (repartoId, nome, tipo, ripiani, colonne) => (await A('POST', 'api/armadi', { repartoId, nome, tipo, ripiani, colonne })).armadio;
  const disponi = async (rep, posti, articoliRep, lasciaFuori) => {
    const righe = [];
    const pieni = {};
    const metti = (a, arm) => {
      if (!arm) return false;
      pieni[arm.id] = pieni[arm.id] || 0;
      const n = pieni[arm.id]++;
      if (n >= arm.ripiani * arm.colonne) return false;
      righe.push({ articoloId: a.id, armadioId: arm.id, ripiano: Math.floor(n / arm.colonne) + 1, posizione: (n % arm.colonne) + 1 });
      return true;
    };
    articoliRep.forEach((a) => {
      if ((lasciaFuori || []).indexOf(a.id) >= 0) return;
      if (attr(a, 'stupefacente') && metti(a, posti.cassaforte)) return;
      if (attr(a, 'frigo') && metti(a, posti.frigo)) return;
      if (a.categoria === 'PRESIDI' && metti(a, posti.presidi || posti.farmaci)) return;
      metti(a, posti.farmaci) || metti(a, posti.presidi);
    });
    await A('PUT', 'api/ubicazioni', { repartoId: rep, righe });
  };
  await disponi(FARMACIA, {
    farmaci: await armadio(FARMACIA, 'Armadio A · farmaci', 'armadio', 4, 6),
    presidi: await armadio(FARMACIA, 'Armadio B · presidi', 'armadio', 4, 5),
    frigo: await armadio(FARMACIA, 'Frigorifero', 'frigorifero', 3, 4),
    cassaforte: await armadio(FARMACIA, 'Cassaforte stupefacenti', 'cassaforte', 2, 3)
  }, assF);
  // Degenza: qualche articolo ancora da disporre (anche quelli da frigorifero: la disposizione automatica li mette lì)
  const daDisporre = assD.filter((a) => attr(a, 'frigo')).map((a) => a.id)
    .concat(assD.filter((a) => !attr(a, 'frigo') && !attr(a, 'stupefacente')).slice(-3).map((a) => a.id));
  await disponi(DEGENZA, {
    farmaci: await armadio(DEGENZA, 'Armadio di reparto', 'armadio', 4, 5),
    presidi: await armadio(DEGENZA, 'Carrello della terapia', 'carrello', 3, 4),
    frigo: await armadio(DEGENZA, 'Frigorifero', 'frigorifero', 2, 3),
    cassaforte: await armadio(DEGENZA, 'Cassaforte', 'cassaforte', 2, 2)
  }, assD, daDisporre);
  srv.daDisporre = daDisporre;
  await disponi(SALA, {
    farmaci: await armadio(SALA, 'Armadio farmaci', 'armadio', 4, 5),
    presidi: await armadio(SALA, 'Carrello di sala', 'carrello', 3, 4),
    cassaforte: await armadio(SALA, 'Cassaforte', 'cassaforte', 2, 3)
  }, assS);
  await disponi(AMBULATORI, { farmaci: await armadio(AMBULATORI, 'Armadio ambulatori', 'armadio', 3, 6) }, assA);

  /* --- richieste e DDT in ogni stato --- */
  const libera = (a, q) => g(a.id, FARMACIA) >= q * 3;
  const scegli = (lista, n, q) => lista.filter((a) => libera(a, q)).slice(0, n);
  // Degenza: una urgente da evadere e una bozza (quella evasa è il rifornimento settimanale)
  await ric('reparto', DEGENZA, righe(scegli(assD.slice(3), 3, 4), 4), { urgente: true, note: 'Nuovi ingressi in reparto: servono entro le 14' });
  await ric('reparto', DEGENZA, righe(scegli(assD.slice(6), 2, 2), 2), { invia: false, note: 'Da completare dopo il giro letti' });
  // Sala operatoria: una da evadere e una con il DDT pronto da spedire
  await ric('sala', SALA, righe(scegli(assS, 3, 5), 5), { note: 'Sedute di domani' });
  const r5 = await ric('sala', SALA, righe(scegli(assS.slice(3), 2, 4), 4));
  srv.ddtDaSpedire = (await F('POST', 'api/richieste/' + r5.richiesta.id + '/ddt', {})).ddt.id;
  // Ambulatori: DDT in viaggio
  const r6 = await ric('admin', AMBULATORI, righe(scegli(assA, 2, 4), 4));
  const d6 = await F('POST', 'api/richieste/' + r6.richiesta.id + '/ddt', {});
  await spedisci(d6.ddt.id, 1);
  // Medicina (2° piano): un rifornimento ricevuto e uno in viaggio
  const perMed = scegli(assF.filter((a) => !attr(a, 'stupefacente')), 6, 10);
  const dm1 = await F('POST', 'api/ddt', { origineId: FARMACIA, destinazioneId: med.id, causale: 'Rifornimento reparto', colli: 2, righe: righe(perMed.slice(0, 4), 10), note: 'Primo rifornimento del magazzino' });
  await spedisci(dm1.ddt.id, 2);
  await ricevi('admin', dm1, false);
  await A('PUT', 'api/assortimento', { repartoId: med.id, righe: perMed.map((a, i) => ({ articoloId: a.id, scortaMin: i === 4 ? 12 : 3, puntoRiordino: i === 4 ? 16 : 6, scortaMax: 24 })) });
  await disponi(med.id, { farmaci: await armadio(med.id, 'Armadio di reparto', 'armadio', 3, 5) }, perMed);
  const dm2 = await F('POST', 'api/ddt', { origineId: FARMACIA, destinazioneId: med.id, causale: 'Rifornimento reparto', colli: 1, righe: righe(perMed.slice(4), 6) });
  await spedisci(dm2.ddt.id, 1);
  // un reso dalla Degenza alla farmacia, preparato e non ancora partito
  const resoArt = assD.filter((a) => g(a.id, DEGENZA) >= 6)[0];
  if (resoArt) await srv.chiama('reparto', 'POST', 'api/ddt', { origineId: DEGENZA, destinazioneId: FARMACIA, causale: 'Reso alla farmacia', colli: 1, righe: [{ articoloId: resoArt.id, quantita: 2 }], note: 'Terapia sospesa' });

  /* --- consumi di stamattina --- */
  const consumi = (chi, rep, lista) => srv.chiama(chi, 'POST', 'api/movimenti', { movimenti: lista.map((a, i) => ({ tipo: 'consumo', data: oggi(), articoloId: a.id, repartoId: rep, quantita: 1 + (i % 3) })) });
  await consumi('reparto', DEGENZA, assD.filter((a) => g(a.id, DEGENZA) >= 8).slice(0, 4));
  await consumi('sala', SALA, assS.filter((a) => g(a.id, SALA) >= 8).slice(0, 3));

  /* --- una copia di sicurezza verificata --- */
  await A('POST', 'api/sistema/copia', {});
}

/* ======================= una guida ======================= */

async function registra(browser, srv, g, scenario, lavoro) {
  const dir = path.join(lavoro, g.id);
  fs.mkdirSync(dir, { recursive: true });
  await srv.marchioNeutro();
  if (scenario.prepara) await scenario.prepara.call(scenario, srv);

  const u = UTENTI[scenario.utente];
  const ctx = await browser.newContext({
    viewport: { width: LARGO, height: ALTO },
    recordVideo: { dir: dir, size: { width: LARGO, height: ALTO } },
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    colorScheme: 'light',
    acceptDownloads: true,
    storageState: scenario.daAccesso ? undefined : await srv.contesti[scenario.utente].storageState()
  });
  const errori = [];
  let page = null;
  try {
    // marchio neutro: il marchio incorporato (brand/) non si carica, al suo posto il programma mostra il simbolo neutro
    await ctx.route(/\/brand\//, (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: '' }));
    await ctx.addInitScript((re) => { window.__vietati = new RegExp(re, 'i'); }, VIETATI.source);
    await ctx.addInitScript(installaRegia);
    // il pulsante «Fotocamera» compare solo dove c'è il lettore di codici del browser (telefono, tablet): qui lo si simula
    if (scenario.fotocamera) await ctx.addInitScript(() => {
      if (!window.BarcodeDetector) window.BarcodeDetector = class { static getSupportedFormats() { return Promise.resolve(['ean_13', 'data_matrix', 'qr_code']); } detect() { return Promise.resolve([]); } };
    });
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

    page = await ctx.newPage();
    const creata = Date.now();
    page.on('pageerror', (e) => errori.push('eccezione: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errori.push('console: ' + m.text()); });
    await page.goto(srv.base + '#' + (scenario.pagina || 'oggi'));
    if (scenario.daAccesso) await page.waitForSelector('#acc-form', { timeout: 15000 });
    else await page.waitForSelector('#app:not([hidden]) #contenuto > *', { timeout: 15000 });
    await pausa(1000);
    if (!scenario.daAccesso && u) await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });

    const R = new Regia(page, g, srv);
    const png = path.join(dir, 'copertina.png');
    await R.intro(png);
    await scenario.gira.call(scenario, R, srv);
    await R.fine();
    const avvisi = await page.evaluate(() => window.__regia.errori.slice());
    avvisi.filter((t) => !R.permessi.some((x) => t.indexOf(x) >= 0)).forEach((t) => errori.push('avviso d’errore nella pagina: ' + t));
    const offset = (R.inizio - creata) / 1000;
    const video = page.video();
    await ctx.close();
    const grezzo = await video.path();
    if (errori.length) throw new Error(errori.join(' | '));
    return { grezzo, png, offset, durata: R.durata, tempi: R.tempi };
  } catch (e) {
    // com'era la pagina quando lo scenario si è fermato (nella cartella di lavoro, con --tieni)
    if (page) await page.screenshot({ path: path.join(dir, 'errore.png') }).catch(() => {});
    await ctx.close().catch(() => {});
    if (errori.length && e.message.indexOf(errori[0]) < 0) e.message += ' (' + errori.join(' | ') + ')';
    throw e;
  } finally {
    if (scenario.dopo) await scenario.dopo.call(scenario, srv).catch((e) => console.log('    (dopo: ' + e.message + ')'));
  }
}

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

async function avviaServer(lavoro) {
  const datiDir = path.join(lavoro, 'dati');
  const porta = await portaLibera();
  const log = fs.openSync(path.join(lavoro, 'server.log'), 'a');
  const proc = spawn(process.execPath, [path.join(RADICE, 'server', 'main.js'), '--porta', String(porta), '--host', '127.0.0.1', '--dati', datiDir, '--servizio'], { stdio: ['ignore', log, log] });
  const base = 'http://127.0.0.1:' + porta + '/';
  const pronto = await attendi(async () => { try { return (await fetch(base + 'api/stato')).ok; } catch (e) { return false; } }, 20000);
  if (!pronto) { proc.kill(); throw new Error('il server non è partito (log in ' + lavoro + ')'); }
  return { proc, base, datiDir };
}

async function principale() {
  try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); } catch (e) {
    console.error('Serve ffmpeg (opzione --ffmpeg <percorso>).');
    process.exit(1);
  }
  const elenco = Guide.ELENCO.filter((g) => !SOLO.length || SOLO.indexOf(g.id) >= 0);
  const sconosciute = SOLO.filter((id) => !Guide.ELENCO.some((g) => g.id === id));
  if (sconosciute.length) { console.error('Guide sconosciute: ' + sconosciute.join(', ')); process.exit(1); }

  if (LAVORO) fs.mkdirSync(LAVORO, { recursive: true });
  const lavoro = fs.mkdtempSync(path.join(LAVORO || os.tmpdir(), 'gf-videoguide-'));
  let esito = 0;
  let browser = null;
  let server = null;
  try {
    server = await avviaServer(lavoro);
    // date e mesi nei campi del browser all'italiana (31/10/2026, "settembre 2027"): serve la lingua del processo
    browser = await chromium.launch({ args: ['--lang=it-IT'], env: Object.assign({}, process.env, { LANG: 'it_IT.UTF-8', LANGUAGE: 'it' }) });
    const srv = await preparaServer(browser, server.base);
    srv.lavoro = lavoro;
    console.log('Server di prova su ' + server.base + ', dati in ' + server.datiDir);
    const righe = [];
    for (const g of elenco) {
      const scenario = SCENARI[g.id];
      if (!scenario) { righe.push([g.id, 'SENZA SCENARIO', '']); esito = 1; continue; }
      process.stdout.write('· ' + g.id + ' … ');
      try {
        const reg = await registra(browser, srv, g, scenario, lavoro);
        const c = converti(g, reg, lavoro);
        const durata = Math.round(reg.durata);
        const nota = (durata < DURATA_MIN || durata > DURATA_MAX ? ' (fuori dai ' + DURATA_MIN + '–' + DURATA_MAX + ' s)' : '') + (c.dim > MAX_BYTE ? ' (oltre 2 MB)' : '');
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
    righe.forEach((r) => console.log('  ' + r[0].padEnd(24) + r[1].padEnd(16) + r[2]));
  } catch (e) {
    console.error('Errore: ' + (e && e.stack || e));
    esito = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.proc.kill();
    if (!TIENI) { await pausa(400); fs.rmSync(lavoro, { recursive: true, force: true }); } else console.log('Cartella di lavoro: ' + lavoro);
  }
  process.exit(esito);
}

if (require.main === module) principale();
else module.exports = { preparaServer, avviaServer, UTENTI, NEUTRO, VIETATI, PW, SCENARI, installaRegia, Regia, codiceApp };
