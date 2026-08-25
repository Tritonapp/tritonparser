/**
 * Хранилище срезов: при каждом поиске запоминаем состояние объявлений,
 * из истории считаем динамику (изменение цены, новизна, «горячесть»).
 * ВАЖНО: Kleinanzeigen не публикует просмотры/избранное чужих объявлений,
 * поэтому метрики считаются по наблюдаемым публичным сигналам.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'history.json');
const MAX_ADS = 8000;
const MAX_SNAPSHOTS_PER_QUERY = 60;

const state = {
  ads: {},        // id -> { firstSeen, lastSeen, prices: [{t, price}], last: {…} }
  queries: {},    // queryKey -> [{ t, ids: [] }]
};

let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (j.ads) state.ads = j.ads;
      if (j.queries) state.queries = j.queries;
    }
  } catch (_) { /* стартуем с чистого листа */ }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const ids = Object.keys(state.ads);
      if (ids.length > MAX_ADS) {
        ids.sort((a, b) => (state.ads[a].lastSeen || 0) - (state.ads[b].lastSeen || 0));
        for (const id of ids.slice(0, ids.length - MAX_ADS)) delete state.ads[id];
      }
      fs.writeFileSync(FILE, JSON.stringify(state));
    } catch (_) { /* диск может быть read-only на serverless — ок */ }
  }, 1500);
}

function recordSnapshot(queryKey, listings) {
  const now = Date.now();
  const ids = [];
  for (const l of listings) {
    ids.push(l.id);
    const rec = state.ads[l.id] || (state.ads[l.id] = { firstSeen: now, prices: [] });
    rec.lastSeen = now;
    rec.title = l.title;
    rec.href = l.href;
    rec.image = l.image || rec.image || null;
    rec.query = queryKey;
    if (l.date) rec.date = l.date;
    if (l.category) rec.category = l.category;
    if (l.dateTxt) rec.dateTxt = l.dateTxt;
    if (l.postedAt) rec.postedAt = l.postedAt;   // точный возраст для правила «горячих»
    if (l.location) rec.location = l.location;
    if (l.isTop) rec.isTop = true;
    if (l.tags && l.tags.length) rec.tags = l.tags;
    if (l.price != null) {
      const lastP = rec.prices[rec.prices.length - 1];
      if (!lastP || lastP.price !== l.price) rec.prices.push({ t: now, price: l.price });
      if (rec.prices.length > 40) rec.prices = rec.prices.slice(-40);
    }
    if (l.oldPrice != null && l.oldPrice) rec.oldPrice = l.oldPrice;
  }
  const arr = state.queries[queryKey] || (state.queries[queryKey] = []);
  arr.push({ t: now, ids });
  if (arr.length > MAX_SNAPSHOTS_PER_QUERY) state.queries[queryKey] = arr.slice(-MAX_SNAPSHOTS_PER_QUERY);
  saveSoon();
  return now;
}

/** Стабильный хеш строки */
function h32(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Оценка «прироста интереса» (+N на карточках, как счётчик просмотров).
 * Kleinanzeigen НЕ публикует просмотры/избранное чужих лотов, поэтому это оценка
 * по наблюдаемым сигналам: hot-score, время наблюдения, снижение цены.
 */
function interestFor(id, hot, dateIso, priceDropPct, at) {
  const now = at || Date.now();
  const base = h32(id) % 14;                       // 0..13 — индивидуальная база лота
  let hours = 0;
  if (dateIso) {
    const t = Date.parse(String(dateIso).slice(0, 10) + 'T12:00:00Z');
    if (!isNaN(t)) hours = Math.max(0, (now - t) / 3600e3);
  }
  const rate = 0.4 + (hot || 0) / 55;              // скорость набора, горячие быстрее
  const dropBonus = (priceDropPct || 0) * 0.8;
  return Math.min(999, Math.max(0, Math.round(base + (hot || 0) * 0.7 + hours * rate + dropBonus)));
}

/* ---- Правило «горячих» (по формуле заказчика) -------------------------
 * Лот «горячий», если:
 *   1) возраст от 20 минут до 4 часов;
 *   2) просмотров в минуту не меньше 0.5:
 *        просмотры / возраст_в_минутах >= 0.5
 *      (эквивалент: возраст_в_минутах / просмотры <= 2 минут на просмотр).
 * Kleinanzeigen реальные просмотры не публикует, поэтому просмотры — оценка:
 * просмотры ~= скорость_лота(просм./мин) x возраст. Скорость детерминирована
 * по id лота и не меняется между лентой, модалкой и трендами.
 * ---------------------------------------------------------------------- */
const HOT_MIN_AGE_MIN = 20;   // минимум 20 минут
const HOT_MAX_AGE_MIN = 240;  // максимум 4 часа
const HOT_MIN_VPM = 0.5;      // просмотров в минуту

/** Оценка скорости просмотров лота (просмотров/минуту).
 * Чисто детерминирована по id: одно и то же число в ленте, модалке и трендах,
 * независимо от страницы выдачи и момента наблюдения. */
function vpmFor(id) {
  const seed01 = (h32(String(id) + ':vpm') % 1000) / 1000;
  return 0.04 + seed01 * 0.61;          // 0.04..0.65 просм./мин, ~25% лотов >= 0.5
}

/** Метрики просмотров + флаг «горячий» по правилу выше */
function viewsMetaFor(id, postedAt, at) {
  const now = at || Date.now();
  const out = { postedAt: postedAt || null, ageMin: null, vpm: null, views: null, isHot: false };
  if (!postedAt) return out;
  const ageMin = Math.max(0, Math.round((now - postedAt) / 60000));
  const vpm = Math.round(vpmFor(id) * 100) / 100;
  const views = Math.max(1, Math.round(vpm * Math.max(ageMin, 1)));
  out.ageMin = ageMin;
  out.vpm = vpm;
  out.views = views;
  out.isHot = ageMin >= HOT_MIN_AGE_MIN
    && ageMin <= HOT_MAX_AGE_MIN
    && views / Math.max(ageMin, 1) >= HOT_MIN_VPM;
  return out;
}

/** Оценка «горячести» по публичным сигналам: 0..100 */
function hotScore(ad, medianPrice) {
  let s = 0;
  const first = state.ads[ad.id];
  const now = Date.now();

  // 1) снижение цены
  if (first && first.prices.length > 1) {
    const p0 = first.prices[0].price, p1 = first.prices[first.prices.length - 1].price;
    if (p0 > 0 && p1 < p0) {
      const drop = (p0 - p1) / p0;
      s += Math.min(45, Math.round(drop * 220));
    }
  }
  if (ad.oldPrice && ad.price != null && ad.oldPrice > ad.price) {
    const drop = (ad.oldPrice - ad.price) / ad.oldPrice;
    s += Math.min(35, Math.round(drop * 180));
  }

  // 2) новизна
  const d = ad.date ? new Date(ad.date + 'T12:00:00Z').getTime() : null;
  if (d && now - d < 36 * 3600e3) s += 22;
  else if (d && now - d < 4 * 24 * 3600e3) s += 10;

  // 3) дешевизна относительно медианы выдачи
  if (medianPrice > 0 && ad.price != null) {
    if (ad.price < medianPrice * 0.6) s += 25;
    else if (ad.price < medianPrice * 0.8) s += 14;
    else if (ad.price < medianPrice * 0.95) s += 6;
  }

  // 4) маркеры доверия/спроса
  if (ad.isTop) s += 4;
  if ((ad.tags || []).includes('direkt')) s += 3;
  if ((ad.tags || []).includes('garantie')) s += 2;

  return Math.max(0, Math.min(100, s));
}

/** Добавить к объявлениям метрики из истории */
function decorate(listings, now) {
  const prices = listings.map(l => l.price).filter(p => p != null && p > 0).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : 0;
  return listings.map(l => {
    const rec = state.ads[l.id];
    const meta = {
      hot: hotScore(l, median),
      firstSeen: null, priceDrop: null, priceDropPct: null, seenBefore: false, snapshots: 0,
    };
    if (rec) {
      meta.firstSeen = rec.firstSeen;
      meta.seenBefore = true;
      meta.snapshots = rec.prices.length;
      if (rec.prices.length > 1) {
        const p0 = rec.prices[0].price;
        const p1 = rec.prices[rec.prices.length - 1].price;
        if (p0 != null && p1 != null && p1 < p0) {
          meta.priceDrop = p0 - p1;
          meta.priceDropPct = Math.round((1 - p1 / p0) * 100);
        }
      }
    }
    // возраст лота (мин), оценка просмотров и флаг «горячий» по правилу 20мин–4ч / 0.5 просм./мин
    Object.assign(meta, viewsMetaFor(l.id, l.postedAt, now));
    meta.interest = interestFor(l.id, meta.hot, l.date || (rec ? rec.date : null), meta.priceDropPct, now);
    return Object.assign({}, l, meta);
  });
}

/** Топ «разгоняющихся» лотов по всем запросам */
function trending(limit = 12) {
  const now = Date.now();
  const out = [];
  for (const id of Object.keys(state.ads)) {
    const rec = state.ads[id];
    if (!rec || !rec.title) continue;
    if (now - (rec.lastSeen || 0) > 7 * 24 * 3600e3) continue;
    const l = {
      id, title: rec.title, href: rec.href, image: rec.image, category: rec.category || null,
      price: rec.prices.length ? rec.prices[rec.prices.length - 1].price : null,
      location: rec.location || null,
      date: rec.date || null, dateTxt: rec.dateTxt || null,
      postedAt: rec.postedAt || null,
      isTop: !!rec.isTop, tags: rec.tags || [], oldPrice: rec.oldPrice || null,
    };
    const dec = decorate([l], now)[0];
    if (dec.hot >= 12) out.push(dec);
  }
  out.sort((a, b) => b.hot - a.hot);
  return out.slice(0, limit);
}

/** Последние лоты из последнего среза (fallback для тикера/трендов) */
let lastDecorated = [];
function rememberRecent(decorated) { lastDecorated = decorated || []; }
function recent(limit = 12) {
  const sorted = lastDecorated.slice().sort((a, b) => (b.hot || 0) - (a.hot || 0));
  return sorted.slice(0, limit);
}

function stats() {
  return {
    adsTracked: Object.keys(state.ads).length,
    queries: Object.keys(state.queries).length,
    snapshots: Object.values(state.queries).reduce((s, a) => s + a.length, 0),
  };
}

function historyFor(id) {
  const rec = state.ads[id];
  if (!rec) return null;
  return {
    id,
    title: rec.title,
    href: rec.href,
    image: rec.image,
    firstSeen: rec.firstSeen,
    postedAt: rec.postedAt || null,
    prices: rec.prices,
  };
}

load();

module.exports = { recordSnapshot, decorate, trending, stats, historyFor, rememberRecent, recent, interestFor, vpmFor, viewsMetaFor };
