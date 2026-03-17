'use strict';

const WEAPONS = [
  'Pisau Dapur', 'Racun Arsenik', 'Tali Rami', 'Pistol Tua', 'Palu Besi',
  'Kapak Kayu', 'Pedang Pendek', 'Busur Panah', 'Tombak Bambu', 'Jarum Beracun',
  'Batu Besar', 'Golok Berkarat', 'Tinju Besi', 'Cambuk Kulit', 'Panah Api'
];

const TRACES = [
  'Sidik Jari', 'Jejak Kaki', 'Helai Rambut', 'Bercak Darah', 'Kain Robek',
  'Wewangian Parfum', 'Jam Tangan Pecah', 'Surat Lusuh', 'Cincin Perak', 'Foto Tua',
  'Tanah Merah', 'Bekas Gigitan', 'Kancing Baju', 'Tali Sepatu', 'Abu Rokok'
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getShuffledPools() {
  return {
    weaponPool: shuffle(WEAPONS),
    tracePool: shuffle(TRACES)
  };
}

module.exports = { WEAPONS, TRACES, getShuffledPools };
