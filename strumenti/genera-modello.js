// Rigenera js/modello.js dal modulo Excel originale (modelli/).
// Il modulo e' incorporato nel codice perche' l'app funziona anche aperta come file (file://),
// dove il browser non permette di leggere altri file della cartella.
const fs = require('fs');
const path = require('path');
const sorgente = path.join(__dirname, '..', 'modelli', 'Carico_Scarico_FARMACIA_POSILLIPO.xlsx');
const b64 = fs.readFileSync(sorgente).toString('base64');
const out = '// File generato da strumenti/genera-modello.js: non modificare a mano.\n' +
  '// Modulo "Nota consumi medicinali e materiali medicazione" della Clinica Posillipo.\n' +
  'window.MODELLO_NOTA_CONSUMI = \'' + b64 + '\';\n';
fs.writeFileSync(path.join(__dirname, '..', 'js', 'modello.js'), out);
console.log('js/modello.js:', out.length, 'caratteri');
