// Genera strumenti/icona.ico (icona dell'exe) disegnando il simbolo con Chromium (Playwright).
// Serve solo quando si cambia il simbolo: l'icona generata è nel repository.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0e5a6e"/>' +
  '<path d="M13 6h6v7h7v6h-7v7h-6v-7H6v-6h7z" fill="#fff"/><rect x="0.5" y="0.5" width="31" height="31" rx="6.5" fill="none" stroke="#b08d57" stroke-width="1"/></svg>';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const immagini = [];
  for (const lato of [16, 24, 32, 48, 64, 128, 256]) {
    await page.setViewportSize({ width: lato, height: lato });
    await page.setContent('<html><body style="margin:0;background:transparent">' + SVG.replace('<svg ', '<svg width="' + lato + '" height="' + lato + '" ') + '</body></html>');
    immagini.push({ lato, png: await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: lato, height: lato } }) });
  }
  await browser.close();
  // formato ICO con immagini PNG (Windows Vista e successivi)
  const testa = Buffer.alloc(6);
  testa.writeUInt16LE(0, 0); testa.writeUInt16LE(1, 2); testa.writeUInt16LE(immagini.length, 4);
  const voci = [];
  let posizione = 6 + 16 * immagini.length;
  for (const im of immagini) {
    const v = Buffer.alloc(16);
    v.writeUInt8(im.lato >= 256 ? 0 : im.lato, 0); v.writeUInt8(im.lato >= 256 ? 0 : im.lato, 1);
    v.writeUInt8(0, 2); v.writeUInt8(0, 3); v.writeUInt16LE(1, 4); v.writeUInt16LE(32, 6);
    v.writeUInt32LE(im.png.length, 8); v.writeUInt32LE(posizione, 12);
    posizione += im.png.length;
    voci.push(v);
  }
  const ico = Buffer.concat([testa, ...voci, ...immagini.map((i) => i.png)]);
  fs.writeFileSync(path.join(__dirname, 'icona.ico'), ico);
  console.log('strumenti/icona.ico:', ico.length, 'byte');
})();
