// Prove di js/totp.js: base32 (RFC 4648), SHA-1, HMAC-SHA1 (RFC 2202), HOTP (RFC 4226), TOTP (RFC 6238).
// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Totp = require('../js/totp.js');

const SEME = Buffer.from('12345678901234567890', 'ascii'); // il segreto dei vettori di RFC 4226 e RFC 6238 (SHA-1)

test('base32: vettori di RFC 4648 e andata e ritorno', () => {
  const vettori = [['', ''], ['f', 'MY======'], ['fo', 'MZXQ===='], ['foo', 'MZXW6==='], ['foob', 'MZXW6YQ='],
    ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI======']];
  for (const [chiaro, codificato] of vettori) {
    assert.equal(Totp.base32Codifica(Buffer.from(chiaro), true), codificato);
    assert.equal(Totp.base32Codifica(Buffer.from(chiaro)), codificato.replace(/=+$/, ''));
    assert.deepEqual(Totp.base32Decodifica(codificato), [...Buffer.from(chiaro)]);
  }
  // il seme di RFC 6238 in base32 (quello che si scriverebbe nell'app)
  assert.equal(Totp.base32Codifica(SEME), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  for (let n = 0; n < 50; n++) {
    const b = crypto.randomBytes(n);
    assert.deepEqual(Totp.base32Decodifica(Totp.base32Codifica(b)), [...b]);
  }
  // scritta a mano: minuscole, spazi, trattini
  assert.deepEqual(Totp.base32Decodifica('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq'), [...SEME]);
  assert.throws(() => Totp.base32Decodifica('ABC1'), /non valida/);
});

test('SHA-1: vettori noti e confronto con node:crypto', () => {
  assert.equal(Totp.esadecimale(Totp.sha1('')), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(Totp.esadecimale(Totp.sha1('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(Totp.esadecimale(Totp.sha1('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')), '84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  assert.equal(Totp.esadecimale(Totp.sha1('a'.repeat(1000))), crypto.createHash('sha1').update('a'.repeat(1000)).digest('hex'));
  // tutte le lunghezze intorno ai bordi dei blocchi da 64 byte
  for (let n = 0; n < 200; n++) {
    const b = crypto.randomBytes(n);
    assert.equal(Totp.esadecimale(Totp.sha1(b)), crypto.createHash('sha1').update(b).digest('hex'), 'lunghezza ' + n);
  }
  // testo con accenti: UTF-8
  assert.equal(Totp.esadecimale(Totp.sha1('perché è così')), crypto.createHash('sha1').update('perché è così', 'utf8').digest('hex'));
});

test('HMAC-SHA1: vettori di RFC 2202 e confronto con node:crypto', () => {
  const r2202 = [
    [Buffer.alloc(20, 0x0b), 'Hi There', 'b617318655057264e28bc0b6fb378c8ef146be00'],
    ['Jefe', 'what do ya want for nothing?', 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79'],
    [Buffer.alloc(20, 0xaa), Buffer.alloc(50, 0xdd), '125d7342b9ac11cd91a39af48aa17b4f63f175d3'],
    [Buffer.alloc(80, 0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First', 'aa4ae5e15272d00e95705637ce8a3b55ed402112']
  ];
  for (const [k, m, atteso] of r2202) assert.equal(Totp.esadecimale(Totp.hmacSha1(k, m)), atteso);
  for (let n = 0; n < 100; n++) {
    const k = crypto.randomBytes(n);
    const m = crypto.randomBytes(n * 3 % 130);
    assert.equal(Totp.esadecimale(Totp.hmacSha1(k, m)), crypto.createHmac('sha1', k).update(m).digest('hex'));
  }
});

test('HOTP: vettori di RFC 4226 (appendice D)', () => {
  const attesi = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  attesi.forEach((codice, contatore) => assert.equal(Totp.hotp(SEME, contatore), codice, 'contatore ' + contatore));
  // anche con il segreto in base32
  assert.equal(Totp.hotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082');
});

test('TOTP: vettori di RFC 6238 (appendice B, SHA-1, 8 cifre)', () => {
  const vettori = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'],
    [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [secondi, codice] of vettori) {
    assert.equal(Totp.totp(SEME, secondi * 1000, { cifre: 8, passo: 30 }), codice, 'T = ' + secondi);
  }
  // 6 cifre (quelle delle app): le ultime 6 del valore troncato
  assert.equal(Totp.totp(SEME, 59 * 1000), '287082');
  assert.equal(Totp.passo(59 * 1000), 1);
  assert.equal(Totp.passo(1111111109 * 1000), 37037036);
});

test('verifica: finestra ±1 passo, codice già usato, codici malformati', () => {
  const segreto = Totp.base32Codifica(crypto.randomBytes(20));
  const t = 1700000000000;
  const p = Totp.passo(t);
  const codice = Totp.totp(segreto, t);
  assert.equal(Totp.verifica(segreto, codice, t), p);
  assert.equal(Totp.verifica(segreto, codice.slice(0, 3) + ' ' + codice.slice(3), t), p, 'con lo spazio in mezzo');
  // il telefono è 30 secondi avanti o indietro: vale ancora
  assert.equal(Totp.verifica(segreto, Totp.totp(segreto, t - 30000), t), p - 1);
  assert.equal(Totp.verifica(segreto, Totp.totp(segreto, t + 30000), t), p + 1);
  // due passi lontano: non vale (salvo finestra più larga)
  const lontano = Totp.totp(segreto, t - 90000);
  if (lontano !== codice && lontano !== Totp.totp(segreto, t - 30000) && lontano !== Totp.totp(segreto, t + 30000)) {
    assert.equal(Totp.verifica(segreto, lontano, t), -1);
    assert.equal(Totp.verifica(segreto, lontano, t, { finestra: 3 }), p - 3);
  }
  // lo stesso codice non vale una seconda volta, e nemmeno quelli dei passi precedenti
  assert.equal(Totp.verifica(segreto, codice, t, { ultimoPasso: p }), -1);
  assert.equal(Totp.verifica(segreto, Totp.totp(segreto, t - 30000), t, { ultimoPasso: p }), -1);
  assert.equal(Totp.verifica(segreto, Totp.totp(segreto, t + 30000), t, { ultimoPasso: p }), p + 1);
  for (const x of ['', '12345', '1234567', 'abcdef', null, undefined, '12 34 5a']) assert.equal(Totp.verifica(segreto, x, t), -1, String(x));
  // codice sbagliato
  const sbagliato = String((Number(codice) + 1) % 1000000).padStart(6, '0');
  if (![Totp.totp(segreto, t - 30000), Totp.totp(segreto, t + 30000)].includes(sbagliato)) assert.equal(Totp.verifica(segreto, sbagliato, t), -1);
});

test('uriOtpauth e chiave da scrivere a mano', () => {
  const uri = Totp.uriOtpauth({ emittente: 'NefroCenter Pharmacy', utente: 'maria.rossi', segretoBase32: 'gezd gnbv gy3t qojq' });
  assert.equal(uri, 'otpauth://totp/NefroCenter%20Pharmacy:maria.rossi?secret=GEZDGNBVGY3TQOJQ&issuer=NefroCenter%20Pharmacy&algorithm=SHA1&digits=6&period=30');
  // i due punti separano emittente e utente: dentro i nomi non devono esserci
  assert.match(Totp.uriOtpauth({ emittente: 'A:B', utente: 'x', segretoBase32: 'AA' }), /^otpauth:\/\/totp\/A%20B:x\?/);
  assert.equal(Totp.formattaChiave('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ');
  const s = Totp.segretoCasuale();
  assert.equal(s.length, 20);
  assert.equal(Totp.base32Codifica(s).length, 32);
});
