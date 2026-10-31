/*
 * Prepara l'ANTEPRIMA del programma (dist/anteprima/): la stessa interfaccia con un server simulato dentro il browser
 * (anteprima/server-finto.js), dati e utenti di prova. Si apre come pagina web statica, per esempio pubblicata come
 * Artifact o aperta con un server web qualsiasi. Non serve per il programma vero.
 *   node strumenti/genera-anteprima.js
 * Crea anche dist/anteprima/pagina-artifact.html: la stessa pagina senza doctype, <html>, <head> e <body> (la pagina
 * pubblicata come Artifact viene avvolta da sola); gli altri file si pubblicano accanto con gli stessi percorsi.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RADICE = path.join(__dirname, '..');
const OUT = path.join(RADICE, 'dist', 'anteprima');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let html = fs.readFileSync(path.join(RADICE, 'index.html'), 'utf8');
const file = new Set();
html.replace(/(?:src|href)="((?:css|js|vendor)\/[^"]+)"/g, (_, rel) => { file.add(rel); return _; });
['js/demo.js', 'anteprima/server-finto.js', 'anteprima/banda.js', 'anteprima/anteprima.css'].forEach((f) => file.add(f));
// il server simulato si carica subito dopo i calcoli, prima di tutto ciò che parla con il server
html = html.replace('<script src="js/calcoli.js"></script>', '<script src="js/calcoli.js"></script>\n  <script src="js/demo.js"></script>\n  <script src="anteprima/server-finto.js"></script>');
html = html.replace('<script src="js/avvio.js"></script>', '<script src="js/avvio.js"></script>\n  <script src="anteprima/banda.js"></script>');
html = html.replace('<link rel="stylesheet" href="css/app.css">', '<link rel="stylesheet" href="css/app.css">\n  <link rel="stylesheet" href="anteprima/anteprima.css">');
html = html.replace('<title>Gestionale Farmacia · Clinica Posillipo</title>', '<title>Gestionale Farmacia · Anteprima</title>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);
for (const rel of file) {
  fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
  fs.copyFileSync(path.join(RADICE, rel), path.join(OUT, rel));
}
const guide = path.join(RADICE, 'guide');
if (fs.existsSync(guide)) {
  fs.mkdirSync(path.join(OUT, 'guide'), { recursive: true });
  fs.readdirSync(guide).filter((n) => /\.(mp4|vtt|jpg|png)$/.test(n)).forEach((n) => fs.copyFileSync(path.join(guide, n), path.join(OUT, 'guide', n)));
}
// versione "frammento" per la pubblicazione come Artifact: titolo, fogli di stile e contenuto del body
const testa = /<head>([\s\S]*?)<\/head>/.exec(html)[1];
const corpo = /<body>([\s\S]*?)<\/body>/.exec(html)[1];
const stili = testa.match(/<link rel="stylesheet"[^>]*>/g).join('\n');
fs.writeFileSync(path.join(OUT, 'pagina-artifact.html'), '<title>Gestionale Farmacia Posillipo</title>\n' + stili + '\n' + corpo.trim() + '\n');
console.log('Anteprima in ' + path.relative(RADICE, OUT) + ' (' + (file.size + 1) + ' file più le videoguide)');
