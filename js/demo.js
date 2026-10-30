/*
 * Dati di prova, inventati, per imparare a usare il programma:
 * articoli tipici, tre mesi di carichi, trasferimenti, consumi e qualche perdita.
 */
(function (root) {
  'use strict';

  var App = root.App;
  var C = root.Calcoli;

  var FARMACI = [
    ['PARACETAMOLO 1000 mg/100 ml fl ev', 'fl', 1.2, 60, 'Paracetamolo'],
    ['KETOROLAC 30 mg/ml f', 'f', 0.45, 40, 'Ketorolac'],
    ['TRAMADOLO 100 mg/2 ml f', 'f', 0.6, 30, 'Tramadolo'],
    ['CEFAZOLINA 1 g fl', 'fl', 1.9, 40, 'Cefazolina'],
    ['AMOXICILLINA/AC. CLAVULANICO 1 g cpr', 'cpr', 0.35, 60, 'Amoxicillina + ac. clavulanico'],
    ['ENOXAPARINA 4000 UI siringa', 'sir', 3.1, 50, 'Enoxaparina'],
    ['PANTOPRAZOLO 40 mg fl ev', 'fl', 2.2, 30, 'Pantoprazolo'],
    ['ONDANSETRON 4 mg/2 ml f', 'f', 0.9, 30, 'Ondansetron'],
    ['DESAMETASONE 4 mg/1 ml f', 'f', 0.5, 30, 'Desametasone'],
    ['SODIO CLORURO 0,9% 500 ml sacca', 'sacca', 0.95, 80, 'Sodio cloruro'],
    ['RINGER LATTATO 500 ml sacca', 'sacca', 1.1, 60, 'Ringer lattato'],
    ['LIDOCAINA 2% 10 ml f', 'f', 0.7, 30, 'Lidocaina'],
    ['PROPOFOL 1% 20 ml f', 'f', 2.8, 20, 'Propofol'],
    ['METOCLOPRAMIDE 10 mg/2 ml f', 'f', 0.3, 20, 'Metoclopramide'],
    ['FUROSEMIDE 20 mg/2 ml f', 'f', 0.4, 20, 'Furosemide']
  ];
  var PRESIDI = [
    ['GARZE STERILI 10x10 cm', 'conf', 0.25, 200],
    ['SIRINGHE 10 ml', 'pz', 0.08, 300],
    ['SIRINGHE 5 ml', 'pz', 0.07, 300],
    ['AGO CANNULA 20G', 'pz', 0.9, 80],
    ['AGO CANNULA 18G', 'pz', 0.9, 60],
    ['DEFLUSSORE PER INFUSIONE', 'pz', 0.55, 100],
    ['GUANTI IN NITRILE TG M', 'conf', 6.5, 20],
    ['CEROTTO IN TNT 5 m x 2,5 cm', 'rotolo', 1.3, 30],
    ['MEDICAZIONE ADESIVA STERILE 10x8 cm', 'pz', 0.35, 150],
    ['CATETERE VESCICALE FOLEY CH14', 'pz', 2.4, 20]
  ];

  // generatore pseudo-casuale con seme fisso: i dati di prova sono sempre gli stessi
  function casuale(seme) {
    return function () {
      seme = (seme * 1664525 + 1013904223) % 4294967296;
      return seme / 4294967296;
    };
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function data(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function mese(d, piu) { var x = new Date(d.getFullYear(), d.getMonth() + piu, 1); return x.getFullYear() + '-' + pad(x.getMonth() + 1); }

  App.creaDatiDemo = function () {
    var rnd = casuale(959);
    var S = root.Archivio.statoVuoto();
    S.impostazioni.operatore = 'Prova';
    var far = S.reparti[0].id;
    var reparti = S.reparti.slice(1).map(function (r) { return r.id; });

    FARMACI.forEach(function (f, i) {
      S.articoli.push({ id: 'demo-f' + i, nome: f[0], categoria: 'FARMACI', unita: f[1], prezzo: f[2], scortaMinima: f[3], principio: f[4], attivo: true });
    });
    PRESIDI.forEach(function (p, i) {
      S.articoli.push({ id: 'demo-p' + i, nome: p[0], categoria: 'PRESIDI', unita: p[1], prezzo: p[2], scortaMinima: p[3], attivo: true });
    });

    var oggi = new Date();
    var inizio = new Date(oggi.getFullYear(), oggi.getMonth() - 2, 1);
    var seq = 0;
    function mov(m) {
      m.id = 'demo-m' + (++seq);
      m.creato = inizio.getTime() + seq;
      m.operatore = 'Prova';
      S.movimenti.push(m);
    }

    // carico iniziale e un riordino a metà periodo
    S.articoli.forEach(function (a, i) {
      var scorta = a.scortaMinima;
      var scad1 = i % 7 === 0 ? mese(oggi, -1) : i % 5 === 0 ? mese(oggi, 1) : mese(oggi, 8 + (i % 10));
      mov({ tipo: 'carico', data: data(inizio), articoloId: a.id, repartoId: far, quantita: scorta * 4, lotto: 'L' + (2400 + i * 7), scadenza: scad1, fornitore: 'Deposito farmaceutico (prova)', documento: 'DDT ' + (100 + i) });
      var meta = new Date(inizio.getFullYear(), inizio.getMonth() + 1, 12);
      mov({ tipo: 'carico', data: data(meta), articoloId: a.id, repartoId: far, quantita: scorta * 3, lotto: 'L' + (2600 + i * 11), scadenza: mese(oggi, 14 + (i % 8)), fornitore: 'Deposito farmaceutico (prova)', documento: 'DDT ' + (300 + i) });
      // ultimo riordino, non per tutti: qualche articolo resta sotto scorta
      if (i % 6 !== 0) {
        var recente = new Date(oggi.getFullYear(), oggi.getMonth(), Math.max(1, oggi.getDate() - 10));
        mov({ tipo: 'carico', data: data(recente), articoloId: a.id, repartoId: far, quantita: scorta * 2, lotto: 'L' + (2800 + i * 13), scadenza: mese(oggi, 18 + (i % 6)), fornitore: 'Deposito farmaceutico (prova)', documento: 'DDT ' + (500 + i) });
      }
    });

    var g = {};
    function giac(a, r) { return g[a + '|' + r] || 0; }
    S.movimenti.forEach(function (m) { g[m.articoloId + '|' + m.repartoId] = giac(m.articoloId, m.repartoId) + m.quantita; });

    for (var d = new Date(inizio); d <= oggi; d.setDate(d.getDate() + 1)) {
      var giorno = data(d);
      // il lunedì la Farmacia rifornisce i reparti
      if (d.getDay() === 1) {
        reparti.forEach(function (r, ri) {
          S.articoli.forEach(function (a, ai) {
            if ((ai + ri) % 3 === 2) return;
            var q = Math.max(1, Math.round(a.scortaMinima * (0.1 + rnd() * 0.1)));
            if (giac(a.id, far) < q) return;
            C.allocaUscita(S, a.id, far, giorno, q).forEach(function (p) {
              mov({ tipo: 'trasferimento', data: giorno, articoloId: a.id, repartoId: far, repartoDestId: r, quantita: p.quantita, lotto: p.lotto, scadenza: p.scadenza, note: 'Rifornimento settimanale' });
            });
            g[a.id + '|' + far] = giac(a.id, far) - q;
            g[a.id + '|' + r] = giac(a.id, r) + q;
          });
        });
      }
      // consumi giornalieri dei reparti (la domenica pochi)
      reparti.forEach(function (r) {
        S.articoli.forEach(function (a) {
          if (rnd() < (d.getDay() === 0 ? 0.85 : 0.55)) return;
          var q = Math.max(1, Math.round(rnd() * a.scortaMinima / 25));
          if (giac(a.id, r) < q) return;
          mov({ tipo: 'consumo', data: giorno, articoloId: a.id, repartoId: r, quantita: q, lotto: '', scadenza: '' });
          g[a.id + '|' + r] = giac(a.id, r) - q;
        });
      });
    }
    // qualche perdita
    var art = S.articoli[3];
    mov({ tipo: 'perdita', data: data(new Date(oggi.getFullYear(), oggi.getMonth() - 1, 20)), articoloId: art.id, repartoId: far, quantita: 2, lotto: '', scadenza: '', causale: 'Rotto o danneggiato', note: 'Flaconi caduti' });
    return S;
  };

  App.caricaDemo = function () {
    var vuoto = !App.S.articoli.length && !App.S.movimenti.length;
    var procedi = vuoto ? Promise.resolve(true)
      : App.conferma('Dati di prova', 'I dati di prova sostituiscono l’archivio attuale (' + App.S.articoli.length + ' articoli, ' + App.S.movimenti.length + ' movimenti). Prima scarico una copia dei dati attuali. Procedo?', 'Carica dati di prova', true);
    procedi.then(function (ok) {
      if (!ok) return;
      if (!vuoto) App.scarica(new Blob([JSON.stringify(App.S, null, 1)], { type: 'application/json' }), 'archivio-farmacia-prima-della-prova_' + App.oggi() + '.json');
      App.S = App.creaDatiDemo();
      App.salva().then(function () {
        App.disegnaMarchio();
        App.avviso('Dati di prova caricati: ' + App.S.articoli.length + ' articoli e ' + App.S.movimenti.length + ' movimenti', 'ok');
        App.vai('oggi');
      });
    });
  };
})(this);
