/**
 * Демо-режим: реалистичный генератор объявлений (стабильный по seed от запроса),
 * если Kleinanzeigen недоступен (блокировка IP хостинга и т.п.).
 */
'use strict';

const store = require('./store');   // viewsMetaFor: единое правило «горячих»

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const CATS = [
  'Elektronik', 'Fahrräder', 'Audio & Hifi', 'Möbel', 'Haushalt', 'Sport',
  'Kleidung', 'Auto & Motorrad', 'Kinder & Baby', 'Garten',
];

const CITIES = [
  '10115 Berlin', '20095 Hamburg', '80331 München', '50667 Köln', '60311 Frankfurt',
  '70173 Stuttgart', '04109 Leipzig', '45127 Essen', '30159 Hannover', '79098 Freiburg',
];

const TITLES = {
  Elektronik: ['iPhone {v} {s}GB', 'Samsung Galaxy S{v}', 'MacBook Air M{v}', 'iPad Pro {s}"', 'PlayStation 5 + Spiele', 'Nintendo Switch OLED', 'Dell Monitor 27" 144Hz', 'Logitech MX Master {v}'],
  'Fahrräder': ['Cube Reaction Hybrid', 'Canyon Endurace CF', 'BMX Kink Carve', 'E-Bike Hercules', 'Ghost Square Cross', 'Rose Pro SL'],
  'Audio & Hifi': ['Sony WH-1000XM{v}', 'Bose QuietComfort', 'JBL Charge {v}', 'Marantz Verstärker', 'Technics SL-1200', 'Sonos One'],
  Möbel: ['IKEA Pax Schrank', 'Sofa 3-Sitzer', 'Esstisch Eiche', 'Schreibtisch höhenverstellbar', 'Regal 5 Böden'],
  Haushalt: ['Kühl-Gefrier-Kombi Bosch', 'Waschmaschine 8kg', 'Thermomix TM6', 'Dyson V{v}', 'Nespresso Maschine'],
  Sport: ['Fitnessstudio Bank + Hanteln', 'Laufband ProForm', 'Snowboard Burton', 'Zelt 4 Personen', 'Kajak 2er'],
  Kleidung: ['Winterjacke Nordface M', 'Nike Air Max {v}', 'Business Anzug 52', 'Lederjacke'],
  'Auto & Motorrad': ['Winterreifen 205/55 R16', 'Dachbox Thule', 'Kindersitz 9-36kg', 'Autoradio Android'],
  'Kinder & Baby': ['Kinderwagen Bugaboo', 'Hochstool Stokke', 'Laufrad Puky', 'Lego Star Wars Set'],
  Garten: ['Rasenmäher Bosch', 'Hochdruckreiniger Kärcher', 'Schrankschrank Garten', 'Grill Weber Q'],
};

const NOW = () => Date.now();
let demoClock = null;
function clock() { return demoClock || NOW(); }

function priceFor(cat, rnd) {
  const base = {
    Elektronik: 650, Fahrräder: 900, 'Audio & Hifi': 300, Möbel: 180, Haushalt: 400,
    Sport: 220, Kleidung: 90, 'Auto & Motorrad': 260, 'Kinder & Baby': 120, Garten: 210,
  }[cat] || 250;
  const f = 0.35 + rnd() * 1.9;
  return Math.round(base * f / 5) * 5;
}

/** Стабильная по запросу демо-выдача + «дельта» между вызовами */
const demoCache = new Map();

function demoSearch({ q = 'angebote', minPrice, maxPrice, page = 1 }, force = false) {
  const key = `${q}|${minPrice || ''}|${maxPrice || ''}|${page}`;
  const hit = demoCache.get(key);
  if (hit && !force && clock() - hit.ts < 10 * 60e3) {
    // лёгкая мутация: часть объявлений получает снижение цены — так видна динамика
    return mutate(hit);
  }
  const rnd = mulberry32(hash(key) ^ Math.floor(clock() / (20 * 60e3)));
  const n = 24;
  const listings = [];
  for (let i = 0; i < n; i++) {
    const cat = CATS[Math.floor(rnd() * CATS.length)];
    const pool = TITLES[cat];
    const tpl = pool[Math.floor(rnd() * pool.length)]
      .replace('{v}', String([3, 4, 5, 6, 10, 11, 12][Math.floor(rnd() * 7)]))
      .replace('{s}', String([64, 128, 256, 512][Math.floor(rnd() * 4)]));
    let price = priceFor(cat, rnd);
    if (minPrice > 0 && price < minPrice) price = minPrice + Math.round(rnd() * 50);
    if (maxPrice > 0 && price > maxPrice) price = maxPrice - Math.round(rnd() * 30);
    const id = String(3400000000 + Math.floor(rnd() * 80000000));
    const createdAgoMin = Math.floor(rnd() * 72 * 60);   // 0..72 ч, минутная точность
    const postedAt = clock() - createdAgoMin * 60000;
    const d = new Date(postedAt);
    const hasOld = rnd() < 0.3;
    const hotVal = Math.min(100, (hasOld ? 45 : 0)
      + (createdAgoMin < 240 ? 25 : createdAgoMin < 1440 ? 12 : 0)
      + Math.floor(rnd() * 10));
    listings.push(Object.assign({
      id,
      href: '/s-anzeige/' + tpl.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '/' + id + '-173-1000',
      title: tpl,
      description: 'Sehr gepflegter Zustand, wenig benutzt. Nur Abholung oder Versand möglich.',
      price,
      negotiable: rnd() < 0.5,
      priceRaw: price + ' €' + (rnd() < 0.5 ? ' VB' : ''),
      oldPrice: hasOld ? Math.round(price * (1.1 + rnd() * 0.25)) : null,
      location: CITIES[Math.floor(rnd() * CITIES.length)],
      dateTxt: createdAgoMin < 24 * 60
        ? 'Heute, ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0')
        : createdAgoMin < 48 * 60 ? 'Gestern' : d.toISOString().slice(0, 10).split('-').reverse().join('.'),
      date: d.toISOString().slice(0, 10),
      hot: hotVal,
      image: null,
      imgCount: 1 + Math.floor(rnd() * 10),
      tags: [rnd() < 0.6 ? 'versand' : 'direkt'],
      isTop: rnd() < 0.15,
      _demo: true,
    }, store.viewsMetaFor(id, postedAt, clock())));
  }
  const entry = { ts: clock(), listings: listings.map(l => Object.assign({}, l, { _oldPrice: l.oldPrice })) };
  demoCache.set(key, entry);
  return { mode: 'demo', listings: entry.listings.map(l => Object.assign({}, l)) };
}

function mutate(entry) {
  const rnd = mulberry32(hash(String(entry.ts)) ^ Math.floor(clock() / 60e3));
  for (const l of entry.listings) {
    if (rnd() < 0.06 && l.price > 20) {
      l.oldPrice = l.oldPrice || l.price;
      l.price = Math.max(10, Math.round(l.price * (0.88 + rnd() * 0.06) / 5) * 5);
    }
  }
  return { mode: 'demo', listings: entry.listings.map(l => Object.assign({}, l)) };
}

function demoDetail(id) {
  const rnd = mulberry32(hash(id));
  const cat = CATS[Math.floor(rnd() * CATS.length)];
  const pool = TITLES[cat];
  const title = pool[Math.floor(rnd() * pool.length)].replace('{v}', '14').replace('{s}', '256');
  const price = priceFor(cat, rnd);
  const postedAt = clock() - (15 + Math.floor(rnd() * 300)) * 60000; // 15 мин .. ~5 ч
  return Object.assign({
    title, price, priceRaw: price + ' € VB', negotiable: true,
    date: new Date(postedAt).toISOString().slice(0, 10),
    description: 'Verkaufe ' + title + '.\n\nZustand: sehr gut, kaum Gebrauchsspuren.\nAbholung bevorzugt, Versand gegen Aufpreis möglich.\nBei Fragen einfach schreiben!',
    details: [{ label: 'Zustand', value: 'Sehr gut' }],
    images: [],
    seller: { initials: 'KA', badges: ['freundlich'] },
    sold: false,
    category: cat,
    _demo: true,
  }, store.viewsMetaFor(id, postedAt, clock()));
}

module.exports = { demoSearch, demoDetail };
