/*
 * Compila il server con l'interfaccia in un solo eseguibile (Node.js "single executable application").
 *
 *   npm run exe            -> dist/GestionaleFarmacia/GestionaleFarmacia.exe (Windows x64) e lo zip da consegnare
 *   npm run exe -- --linux -> anche dist/gestionale-farmacia-linux, per le prove automatiche
 *
 * Passi: esbuild unisce server/ e js/ in un file; i file dell'interfaccia diventano "asset" incorporati;
 * node prepara il blob SEA; il blob entra come risorsa in node.exe per Windows della stessa versione di Node
 * (scaricato da nodejs.org e controllato con SHA-256), insieme a icona e informazioni di versione.
 * Per Linux (solo prove) il blob si inietta con postject.
 * Si può eseguire da Linux, macOS o Windows.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const RADICE = path.join(__dirname, '..');
const BUILD = path.join(RADICE, 'build');
const DIST = path.join(RADICE, 'dist');
const CACHE = path.join(BUILD, 'cache');
const VERSIONE_NODE = process.version; // il blob va iniettato nella stessa versione di Node che lo prepara
const FUSIBILE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const pacchetto = require(path.join(RADICE, 'package.json'));
const VERSIONE = pacchetto.version;
const CONLINUX = process.argv.includes('--linux');
const SOLOLINUX = process.argv.includes('--solo-linux');

function scarica(url) {
  return new Promise((ok, ko) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return ok(scarica(new URL(res.headers.location, url).toString()));
      if (res.statusCode !== 200) return ko(new Error('Download non riuscito ' + url + ': HTTP ' + res.statusCode));
      const pezzi = [];
      res.on('data', (c) => pezzi.push(c));
      res.on('end', () => ok(Buffer.concat(pezzi)));
      res.on('error', ko);
    }).on('error', ko);
  });
}

async function nodeWindows() {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, 'node-' + VERSIONE_NODE + '-win-x64.exe');
  const somme = (await scarica('https://nodejs.org/dist/' + VERSIONE_NODE + '/SHASUMS256.txt')).toString();
  const riga = somme.split('\n').find((r) => r.trim().endsWith(' win-x64/node.exe'));
  if (!riga) throw new Error('SHA-256 di win-x64/node.exe non trovato per ' + VERSIONE_NODE);
  const atteso = riga.split(/\s+/)[0];
  let dati = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (!dati || crypto.createHash('sha256').update(dati).digest('hex') !== atteso) {
    console.log('Scarico node.exe ' + VERSIONE_NODE + ' per Windows…');
    dati = await scarica('https://nodejs.org/dist/' + VERSIONE_NODE + '/win-x64/node.exe');
    const sha = crypto.createHash('sha256').update(dati).digest('hex');
    if (sha !== atteso) throw new Error('node.exe scaricato non corrisponde allo SHA-256 ufficiale');
    fs.writeFileSync(file, dati);
  }
  return dati;
}

/* File dell'interfaccia: quelli che index.html carica, più index.html. */
function fileInterfaccia() {
  const html = fs.readFileSync(path.join(RADICE, 'index.html'), 'utf8');
  const elenco = ['index.html'];
  const re = /(?:src|href)="([^"#?]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const rel = m[1].replace(/^\.\//, '');
    if (/^(https?:|data:|\/\/)/.test(rel)) continue;
    if (!/^(css|js|vendor)\/[A-Za-z0-9._-]+\.(js|css)$/.test(rel)) throw new Error('index.html carica un file fuori da css/, js/, vendor/: ' + rel);
    if (!fs.existsSync(path.join(RADICE, rel))) throw new Error('index.html carica un file che non esiste: ' + rel);
    if (elenco.indexOf(rel) < 0) elenco.push(rel);
  }
  return elenco;
}

function preparaBlob() {
  fs.rmSync(BUILD + '/sea', { recursive: true, force: true });
  fs.mkdirSync(BUILD + '/sea', { recursive: true });
  console.log('Unisco il server (esbuild)…');
  require('esbuild').buildSync({
    entryPoints: [path.join(RADICE, 'server', 'main.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: path.join(BUILD, 'sea', 'server.js'),
    external: ['node:sqlite', 'node:sea'],
    logLevel: 'warning'
  });
  const assets = {};
  fileInterfaccia().forEach((rel) => { assets[rel] = path.join(RADICE, rel); });
  console.log('Interfaccia incorporata: ' + Object.keys(assets).join(', '));
  const conf = {
    main: path.join(BUILD, 'sea', 'server.js'),
    output: path.join(BUILD, 'sea', 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false, // il blob deve funzionare anche su un sistema diverso da quello che lo prepara
    assets
  };
  const fileConf = path.join(BUILD, 'sea', 'sea-config.json');
  fs.writeFileSync(fileConf, JSON.stringify(conf, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', fileConf], { stdio: 'inherit' });
  return fs.readFileSync(conf.output);
}

/*
 * Exe per Windows in un solo passaggio con resedit (senza ricostruire le sezioni del programma):
 * - il blob SEA diventa la risorsa RCDATA "NODE_SEA_BLOB" (lingua neutra), come la scrive postject;
 * - icona e informazioni di versione della Clinica;
 * - la firma digitale di node.exe si toglie (non sarebbe più valida);
 * - il "fusibile" SEA nel programma passa da :0 a :1, così node.exe all'avvio esegue il blob.
 */
function creaExeWindows(dati, blob) {
  const ResEdit = require('resedit');
  const exe = ResEdit.NtExecutable.from(dati, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  if (res.entries.some((e) => e.type === 10 && e.id === 'NODE_SEA_BLOB')) throw new Error('node.exe contiene già un blob SEA');
  res.entries.push({ type: 10, id: 'NODE_SEA_BLOB', lang: 0, codepage: 0, bin: blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) });
  const icona = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icona.ico')));
  const gruppi = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const idIcona = gruppi.length ? gruppi[0].id : 1;
  const linguaIcona = gruppi.length ? gruppi[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, idIcona, linguaIcona, icona.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const parti = VERSIONE.split('.').map(Number).concat([0, 0, 0]).slice(0, 4);
  vi.setFileVersion(parti[0], parti[1], parti[2], parti[3], 1033);
  vi.setProductVersion(parti[0], parti[1], parti[2], parti[3], 1033);
  const lingue = vi.getAllLanguagesForStringValues();
  const valori = {
    CompanyName: 'Clinica Posillipo - ME.MI. SRL',
    FileDescription: 'Gestionale Farmacia - carico e scarico farmaci e presidi',
    ProductName: 'Gestionale Farmacia',
    InternalName: 'GestionaleFarmacia',
    OriginalFilename: 'GestionaleFarmacia.exe',
    LegalCopyright: 'Clinica Posillipo. Contiene Node.js (licenza MIT) ed ExcelJS (licenza MIT).',
    FileVersion: VERSIONE,
    ProductVersion: VERSIONE
  };
  (lingue.length ? lingue : [{ lang: 1033, codepage: 1200 }]).forEach((l) => vi.setStringValues(l, valori));
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  const out = Buffer.from(exe.generate());
  const spento = Buffer.from(FUSIBILE + ':0');
  const pos = out.indexOf(spento);
  if (pos < 0 || out.indexOf(spento, pos + 1) >= 0) throw new Error('Fusibile SEA non trovato (o trovato più volte) in node.exe');
  out.write('1', pos + spento.length - 1, 'latin1');
  return out;
}

async function inietta(fileExe, blob) {
  const { inject } = require('postject');
  await inject(fileExe, 'NODE_SEA_BLOB', blob, { sentinelFuse: FUSIBILE, overwrite: true });
}

/* File di installazione: i testi vanno con gli a capo di Windows (CRLF), anche se compilati da Linux. */
function copiaSupporto(cartella) {
  const sup = path.join(RADICE, 'installazione');
  const copiaTesto = (da, a) => fs.writeFileSync(a, fs.readFileSync(da, 'utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
  fs.readdirSync(sup).forEach((n) => {
    const da = path.join(sup, n);
    if (/\.(txt|bat|ps1|json)$/i.test(n)) copiaTesto(da, path.join(cartella, n)); else fs.copyFileSync(da, path.join(cartella, n));
  });
  copiaTesto(path.join(RADICE, 'vendor', 'exceljs.LICENSE'), path.join(cartella, 'LICENZA-ExcelJS.txt'));
}

function zip(cartella, fileZip) {
  // zip senza dipendenze: metodo "deflate" con zlib, formato ZIP classico
  const zlib = require('zlib');
  const voci = [];
  const centrale = [];
  let offset = 0;
  const crcTabella = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTabella[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const base = path.basename(cartella);
  const ora = new Date();
  const dosTime = (ora.getHours() << 11) | (ora.getMinutes() << 5) | (ora.getSeconds() >> 1);
  const dosDate = ((ora.getFullYear() - 1980) << 9) | ((ora.getMonth() + 1) << 5) | ora.getDate();
  fs.readdirSync(cartella).sort().forEach((n) => {
    const dati = fs.readFileSync(path.join(cartella, n));
    const compressi = zlib.deflateRawSync(dati, { level: 9 });
    const nome = Buffer.from(base + '/' + n, 'utf8');
    const crc = crc32(dati);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt16LE(dosTime, 10); loc.writeUInt16LE(dosDate, 12); loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(compressi.length, 18); loc.writeUInt32LE(dati.length, 22); loc.writeUInt16LE(nome.length, 26); loc.writeUInt16LE(0, 28);
    voci.push(loc, nome, compressi);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressi.length, 20); cen.writeUInt32LE(dati.length, 24); cen.writeUInt16LE(nome.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrale.push(cen, nome);
    offset += loc.length + nome.length + compressi.length;
  });
  const dimCentrale = centrale.reduce((s, b) => s + b.length, 0);
  const fine = Buffer.alloc(22);
  fine.writeUInt32LE(0x06054b50, 0); fine.writeUInt16LE(centrale.length / 2, 8); fine.writeUInt16LE(centrale.length / 2, 10);
  fine.writeUInt32LE(dimCentrale, 12); fine.writeUInt32LE(offset, 16);
  fs.writeFileSync(fileZip, Buffer.concat(voci.concat(centrale, [fine])));
}

(async () => {
  const blob = preparaBlob();
  fs.mkdirSync(DIST, { recursive: true });

  if (CONLINUX || SOLOLINUX) {
    const fileLinux = path.join(DIST, 'gestionale-farmacia-linux');
    fs.copyFileSync(process.execPath, fileLinux);
    await inietta(fileLinux, blob);
    fs.chmodSync(fileLinux, 0o755);
    console.log('Creato ' + path.relative(RADICE, fileLinux));
  }
  if (SOLOLINUX) return;

  const cartella = path.join(DIST, 'GestionaleFarmacia');
  fs.rmSync(cartella, { recursive: true, force: true });
  fs.mkdirSync(cartella, { recursive: true });
  const fileExe = path.join(cartella, 'GestionaleFarmacia.exe');
  fs.writeFileSync(fileExe, creaExeWindows(await nodeWindows(), blob));
  copiaSupporto(cartella);
  const fileZip = path.join(DIST, 'GestionaleFarmacia-' + VERSIONE + '-win-x64.zip');
  zip(cartella, fileZip);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(fileExe)).digest('hex');
  console.log('Creato ' + path.relative(RADICE, fileExe) + ' (' + Math.round(fs.statSync(fileExe).size / 1048576) + ' MB, SHA-256 ' + sha + ')');
  console.log('Creato ' + path.relative(RADICE, fileZip) + ' (' + Math.round(fs.statSync(fileZip).size / 1048576) + ' MB)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
