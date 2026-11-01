/*
 * Prepara l'ANTEPRIMA del programma (dist/anteprima/): la stessa interfaccia con un server simulato dentro il browser
 * (anteprima/server-finto.js), dati e utenti di prova. Si apre come pagina web statica, per esempio pubblicata come
 * Artifact o aperta con un server web qualsiasi. Non serve per il programma vero.
 *   node strumenti/genera-anteprima.js
 * Crea anche dist/anteprima/pagina-artifact.html: la stessa pagina senza doctype, <html>, <head> e <body> (la pagina
 * pubblicata come Artifact viene avvolta da sola); gli altri file si pubblicano accanto con gli stessi percorsi.
 *
 * Marchio neutro (docs/NOVITA-3.0.md, "Anteprima pubblicata"): l'anteprima pubblica non usa il marchio né il nome di
 * una struttura reale. Quindi:
 *   - la cartella brand/ non si copia; le videoguide nemmeno (sono registrate sul programma installato, con il marchio);
 *   - nei file copiati i nomi della struttura rimasti nei commenti e nei valori di riserva diventano nomi dimostrativi;
 *   - il modulo Excel della Nota consumi (js/modello.js) si ripulisce: intestazione, società, città, codice del modulo,
 *     autore e percorso originale diventano dimostrativi;
 *   - alla fine si controllano tutti i file: se un nome vero è rimasto, lo strumento si ferma con un errore.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const RADICE = path.join(__dirname, '..');
const OUT = path.join(RADICE, 'dist', 'anteprima');

// nomi veri che non devono comparire nell'anteprima (anche nei commenti dei file copiati)
const VIETATI = /nefro\s*center|posillipo|longevity|me\.mi\.\s*srl|sanseverino/i;
// sostituzioni nei file di testo copiati: dal più lungo al più corto
const NEUTRI = [
  [/NefroCenter Pharmacy/g, 'Pharmacy'],
  [/Longevity Institute · Gruppo NefroCenter/g, 'Ospedale di prova'],
  [/Gruppo NefroCenter/gi, 'gruppo dimostrativo'],
  [/NefroCenter/gi, 'dimostrativo'],
  [/CLINICA POSILLIPO/g, 'CLINICA DEMO'],
  [/Clinica Posillipo/gi, 'Clinica Demo'],
  [/Posillipo/gi, 'Demo'],
  [/Longevity Institute/gi, 'Ospedale di prova'],
  [/Longevity/gi, 'Demo'],
  [/ME\.MI\. SRL/gi, 'Società Demo S.r.l.']
];
// testi del modulo Excel (xl/sharedStrings.xml, docProps, workbook.xml)
const MODELLO_NEUTRO = [
  [/<t>CLINICA POSILLIPO<\/t>/g, '<t>CLINICA DEMO</t>'],
  [/<t>ME\.MI\. SRL<\/t>/g, '<t>SOCIETÀ DEMO S.R.L.</t>'],
  [/<t>NAPOLI<\/t>/g, '<t>CITTÀ DEMO</t>'],
  [/<t>PRQ 1501\.4EV\.1<\/t>/g, '<t>MOD-DEMO 1.0</t>'],
  [/<dc:creator>[^<]*<\/dc:creator>/g, '<dc:creator>Anteprima</dc:creator>'],
  [/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/g, '<cp:lastModifiedBy>Anteprima</cp:lastModifiedBy>'],
  [/<Company>[^<]*<\/Company>/g, '<Company></Company>'],
  [/<x15ac:absPath [^>]*\/>/g, ''],
  [/<mc:AlternateContent[^>]*>\s*<mc:Choice Requires="x15">\s*<\/mc:Choice>\s*<\/mc:AlternateContent>/g, '']
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let html = fs.readFileSync(path.join(RADICE, 'index.html'), 'utf8');
// se index.html cambia forma, le sostituzioni qui sotto non devono fallire in silenzio (l'anteprima cercherebbe un server vero)
function sostituisci(cerca, metti) {
  if (html.indexOf(cerca) < 0) throw new Error('In index.html non trovo: ' + cerca);
  html = html.replace(cerca, metti);
}
const file = new Set();
html.replace(/(?:src|href)="((?:css|js|vendor)\/[^"]+)"/g, (_, rel) => { file.add(rel); return _; });
['js/demo.js', 'anteprima/server-finto.js', 'anteprima/banda.js', 'anteprima/anteprima.css'].forEach((f) => file.add(f));
// il server simulato si carica subito dopo i calcoli e i dati di prova, prima di tutto ciò che parla con il server
sostituisci('<script src="js/calcoli.js"></script>', '<script src="js/calcoli.js"></script>\n  <script src="js/demo.js"></script>\n  <script src="anteprima/server-finto.js"></script>');
sostituisci('<script src="js/avvio.js"></script>', '<script src="js/avvio.js"></script>\n  <script src="anteprima/banda.js"></script>');
sostituisci('<link rel="stylesheet" href="css/app.css">', '<link rel="stylesheet" href="css/app.css">\n  <link rel="stylesheet" href="anteprima/anteprima.css">');
html = html.replace(/<title>[^<]*<\/title>/, '<title>Pharmacy · anteprima</title>');
html = neutro(html);
fs.writeFileSync(path.join(OUT, 'index.html'), html);

function neutro(testo) {
  NEUTRI.forEach((x) => { testo = testo.replace(x[0], x[1]); });
  return testo;
}

/* ---------- modulo Excel della Nota consumi, ripulito ---------- */

// Legge un file .xlsx (zip) e lo riscrive con i testi cambiati da fn(nome, testo). Solo zip semplici, come quelli di Excel.
function riscriviZip(buf, fn) {
  let fine = buf.length - 22;
  while (fine >= 0 && buf.readUInt32LE(fine) !== 0x06054b50) fine--;
  if (fine < 0) throw new Error('modulo Excel non valido');
  const quante = buf.readUInt16LE(fine + 10);
  let p = buf.readUInt32LE(fine + 16);
  const voci = [];
  for (let i = 0; i < quante; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('modulo Excel non valido (indice)');
    const metodo = buf.readUInt16LE(p + 10);
    const ora = buf.readUInt16LE(p + 12);
    const data = buf.readUInt16LE(p + 14);
    const compresso = buf.readUInt32LE(p + 20);
    const lNome = buf.readUInt16LE(p + 28);
    const lExtra = buf.readUInt16LE(p + 30);
    const lCommento = buf.readUInt16LE(p + 32);
    const locale = buf.readUInt32LE(p + 42);
    const nome = buf.toString('utf8', p + 46, p + 46 + lNome);
    const inizio = locale + 30 + buf.readUInt16LE(locale + 26) + buf.readUInt16LE(locale + 28);
    const grezzo = buf.subarray(inizio, inizio + compresso);
    let contenuto = metodo === 8 ? zlib.inflateRawSync(grezzo) : Buffer.from(grezzo);
    if (/\.(xml|rels)$/.test(nome)) contenuto = Buffer.from(fn(nome, contenuto.toString('utf8')), 'utf8');
    voci.push({ nome, ora, data, contenuto });
    p += 46 + lNome + lExtra + lCommento;
  }
  const parti = [];
  const indice = [];
  let posizione = 0;
  voci.forEach((v) => {
    const nome = Buffer.from(v.nome, 'utf8');
    const dati = zlib.deflateRawSync(v.contenuto, { level: 9 });
    const crc = zlib.crc32(v.contenuto) >>> 0;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x0800, 6); l.writeUInt16LE(8, 8);
    l.writeUInt16LE(v.ora, 10); l.writeUInt16LE(v.data, 12); l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(dati.length, 18); l.writeUInt32LE(v.contenuto.length, 22); l.writeUInt16LE(nome.length, 26); l.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(v.ora, 12); c.writeUInt16LE(v.data, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(dati.length, 20);
    c.writeUInt32LE(v.contenuto.length, 24); c.writeUInt16LE(nome.length, 28); c.writeUInt32LE(posizione, 42);
    parti.push(l, nome, dati);
    indice.push(c, nome);
    posizione += 30 + nome.length + dati.length;
  });
  const cd = Buffer.concat(indice);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(voci.length, 8); e.writeUInt16LE(voci.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(posizione, 16);
  return Buffer.concat(parti.concat([cd, e]));
}

function modelloNeutro(testoJs) {
  const m = /window\.MODELLO_NOTA_CONSUMI = '([A-Za-z0-9+/=]+)';/.exec(testoJs);
  if (!m) throw new Error('js/modello.js ha cambiato forma: non trovo MODELLO_NOTA_CONSUMI');
  const xlsx = riscriviZip(Buffer.from(m[1], 'base64'), (nome, t) => {
    MODELLO_NEUTRO.forEach((x) => { t = t.replace(x[0], x[1]); });
    if (VIETATI.test(t)) throw new Error('Nel modulo Excel (' + nome + ') resta un nome vero: ' + VIETATI.exec(t)[0]);
    return t;
  });
  return '// Modulo "Nota consumi medicinali e materiali medicazione" con i dati di una struttura dimostrativa (anteprima).\n' +
    'window.MODELLO_NOTA_CONSUMI = \'' + xlsx.toString('base64') + '\';\n';
}

/* ---------- copia dei file ---------- */

for (const rel of file) {
  const da = path.join(RADICE, rel);
  const a = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(a), { recursive: true });
  if (rel === 'js/modello.js') fs.writeFileSync(a, modelloNeutro(fs.readFileSync(da, 'utf8')));
  else if (/^(js|css|anteprima)\//.test(rel)) fs.writeFileSync(a, neutro(fs.readFileSync(da, 'utf8')));
  else fs.copyFileSync(da, a);
}
// caratteri sì; marchio della struttura e videoguide no (l'anteprima pubblicata non usa il marchio di una struttura reale)
const caratteri = path.join(RADICE, 'fonts');
if (fs.existsSync(caratteri)) {
  fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
  fs.readdirSync(caratteri).filter((n) => /\.woff2$/.test(n)).forEach((n) => fs.copyFileSync(path.join(caratteri, n), path.join(OUT, 'fonts', n)));
}

// versione "frammento" per la pubblicazione come Artifact: titolo, fogli di stile e contenuto del body
const testa = /<head>([\s\S]*?)<\/head>/.exec(html)[1];
const corpo = /<body>([\s\S]*?)<\/body>/.exec(html)[1];
const stili = testa.match(/<link rel="stylesheet"[^>]*>/g).join('\n');
fs.writeFileSync(path.join(OUT, 'pagina-artifact.html'), '<title>Pharmacy · anteprima</title>\n' + stili + '\n' + corpo.trim() + '\n');

/* ---------- controllo finale: nessun nome vero, nessun marchio ---------- */
const trovati = [];
(function scorri(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) { scorri(f); return; }
    if (!/\.(html|js|css|json|vtt|txt|svg)$/.test(d.name)) return;
    const t = fs.readFileSync(f, 'utf8');
    // le librerie esterne (vendor/) non hanno nomi della struttura: si controllano lo stesso, ma con la parola intera
    const m = VIETATI.exec(t);
    if (m) trovati.push(path.relative(OUT, f) + ': «' + m[0] + '»');
  });
})(OUT);
if (fs.existsSync(path.join(OUT, 'brand')) || fs.existsSync(path.join(OUT, 'guide'))) trovati.push('cartella brand/ o guide/ copiata');
if (trovati.length) {
  fs.rmSync(OUT, { recursive: true, force: true });
  throw new Error('L’anteprima conterrebbe nomi o marchi veri:\n  ' + trovati.join('\n  '));
}

let n = 0;
(function conta(dir) { fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => { if (d.isDirectory()) conta(path.join(dir, d.name)); else n++; }); })(OUT);
console.log('Anteprima in ' + path.relative(RADICE, OUT) + ' (' + n + ' file, marchio neutro controllato)');
// senza la funzione "downloads" i file Excel nella pagina pubblicata non si scaricano (i download diretti sono bloccati)
console.log('Per pubblicarla come Artifact: pagina-artifact.html, gli altri file accanto con gli stessi percorsi, capabilities { downloads: true }.');
