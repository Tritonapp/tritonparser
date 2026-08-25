/**
 * KL Ads — аналитика объявлений Kleinanzeigen.
 * Сервер: статика + API (поиск, детали, тренды) + прокси картинок.
 * Данные берутся только из публичных страниц kleinanzeigen.de, без логина.
 */
'use strict';

const express = require('express');
const compression = require('compression');
const path = require('path');
const ka = require('./lib/ka');
const { parseSearch, parseDetail, parseTotal } = require('./lib/parse');
const store = require('./lib/store');
const demo = require('./lib/demo');
const cats = require('./lib/cats');

// категории Kleinanzeigen (ID подтверждены из навигации сайта)
const KA_CATEGORIES = {
  161: 'Elektronik', 173: 'Handy & Telefon', 172: 'Audio & Hifi', 175: 'TV & Video',
  278: 'Notebooks', 285: 'Tablets', 279: 'Konsolen', 176: 'Haushaltsgeräte',
  80: 'Haus & Garten', 17: 'Familie, Kind & Baby', 130: 'Haustiere', 153: 'Mode & Beauty',
  210: 'Auto, Rad & Boot', 73: 'Musik, Film & Bücher', 185: 'Freizeit & Hobby',
  231: 'Tickets', 235: 'Unterricht & Kurse', 272: 'Zu verschenken',
  297: 'Dienstleistungen', 400: 'Nachbarschaftshilfe', 102: 'Jobs', 195: 'Immobilien',
};

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Kleinanzeigen — немецкий сайт: русские слова он не ищет.
// Переводим популярные запросы, остальное честно сообщаем пользователю.
const RU_DE = {
  'айфон': 'iphone', 'айфона': 'iphone', 'айфоне': 'iphone', 'iphone': 'iphone',
  'телефон': 'handy', 'телефона': 'handy', 'смартфон': 'smartphone', 'самсунг': 'samsung',
  'ксяоми': 'xiaomi', 'сяоми': 'xiaomi', 'хуавей': 'huawei',
  'ноутбук': 'laptop', 'ноутбука': 'laptop', 'лэптоп': 'laptop', 'макбук': 'macbook',
  'компьютер': 'computer', 'монитор': 'monitor', 'клавиатура': 'tastatur',
  'мышь': 'maus', 'наушники': 'kopfhörer', 'колонка': 'lautsprecher',
  'телевизор': 'fernseher', 'камера': 'kamera', 'фотоаппарат': 'kamera',
  'плейстейшн': 'playstation', 'приставка': 'konsole', 'xbox': 'xbox',
  'диван': 'sofa', 'дивана': 'sofa', 'софа': 'sofa', 'кресло': 'sessel',
  'стол': 'tisch', 'стул': 'stuhl', 'шкаф': 'schrank', 'кровать': 'bett',
  'матрас': 'matratze', 'велосипед': 'fahrrad', 'велик': 'fahrrad', 'байк': 'bike',
  'самокат': 'scooter', 'машина': 'auto', 'авто': 'auto', 'шины': 'reifen',
  'часы': 'uhr', 'пылесос': 'staubsauger', 'холодильник': 'kühlschrank',
  'стиралка': 'waschmaschine', 'стиральная': 'waschmaschine',
  'микроволновка': 'mikrowelle', 'кофемашина': 'kaffeemaschine',
  'чайник': 'wasserkocher', 'гриль': 'grill', 'газонокосилка': 'rasenmäher',
  'куртка': 'jacke', 'пуховик': 'daunenjacke', 'ботинки': 'stiefel',
  'кроссовки': 'sneakers', 'сноуборд': 'snowboard', 'лыжи': 'ski',
  'палатка': 'zelt', 'гантель': 'hantel', 'гантели': 'hanteln',
  'коляска': 'kinderwagen', 'кроватка': 'babybett', 'игрушки': 'spielzeug',
  'лего': 'lego', 'инструмент': 'werkzeug', 'дрель': 'bohrmaschine',
  'пила': 'säge', 'квартира': 'wohnung', 'дом': 'haus',
  'продам': '', 'куплю': '', 'срочно': '',
};

/** Приводим запрос к виду, который понимает Kleinanzeigen */
function normalizeQuery(qRaw) {
  const orig = String(qRaw || '').trim();
  if (!orig) return { q: 'angebote', note: null };
  const hasCyr = /[а-яё]/i.test(orig);
  if (!hasCyr) return { q: orig, note: null };
  const out = [];
  for (const w of orig.toLowerCase().split(/[\s,]+/)) {
    if (!w) continue;
    if (/^[a-z0-9äöüß+.-]+$/i.test(w)) { out.push(w); continue; }   // латиница/цифры — оставляем
    const tr = RU_DE[w];
    if (tr) out.push(tr);                                            // переводим по словарю
    // непереводимые русские слова отбрасываем — KA по ним всё равно не ищет
  }
  if (out.length) {
    const q = out.join(' ');
    return { q, note: `Kleinanzeigen не ищет по-русски, поэтому «${orig}» искали как «${q}»` };
  }
  return { q: null, note: 'Kleinanzeigen — немецкий сайт и по-русски не ищет. Введите запрос латиницей: например, iphone, sofa, fahrrad, laptop.' };
}

app.use(compression());                       // gzip: JSON ленты в ~5 раз меньше
app.use(express.json({ limit: '64kb' }));

// --- утилиты -----------------------------------------------------------

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

const lastGood = new Map();   // queryKey -> { listings, ts } (stale-кэш на случай блокировки)
let lastLiveError = null;
let liveOkAt = null;

function queryKey(q, minPrice, maxPrice, page) {
  return [String(q || '').toLowerCase().trim(), minPrice || 0, maxPrice || 0, page || 1].join('|');
}

async function fetchSearch({ q, minPrice, maxPrice, page, force, onlyToday, privateOnly, category, depth = 1 }) {
  const key = queryKey(q, minPrice, maxPrice, page) + (onlyToday ? '|today' : '') + (privateOnly ? '|priv' : '') + (category ? '|c' + category : '') + '|d' + depth;
  const catName = KA_CATEGORIES[category] || null;
  const pages = [];
  let firstPageError = null;

  // забираем depth страниц подряд и склеиваем их в одну большую ленту
  for (let p = page; p < page + depth; p++) {
    const url = ka.searchUrl({ q, minPrice, maxPrice, page: p, onlyToday, privateOnly, category });
    try {
      const { html } = await ka.get(url, { referer: ka.BASE + '/', force });
      if (ka.looksBlocked(html)) throw Object.assign(new Error('blocked:challenge'), { blocked: true });
      const listings = parseSearch(html);
      if (!listings.length) break;               // дальше страниц нет
      pages.push({ listings, total: parseTotal(html) });
    } catch (e) {
      if (p === page) firstPageError = e;        // упала первая страница — ошибка запроса
      break;                                     // глубже не идём
    }
  }

  if (!firstPageError && pages.length) {
    const merged = [];
    const seenIds = new Set();
    let total = null;
    for (const pg of pages) {
      total = total || pg.total;
      for (const l of pg.listings) {
        if (seenIds.has(l.id)) continue;         // дубли между страницами
        seenIds.add(l.id);
        merged.push(Object.assign({}, l, { category: catName || cats.categorize(l.title, q) }));
      }
    }
    // системный фильтр: выкидываем лоты с платной плашкой TOP
    let droppedTop = 0;
    let listings = merged;
    if (privateOnly) {
      const before = listings.length;
      listings = listings.filter(l => !l.isTop);
      droppedTop = before - listings.length;
    }
    if (!listings.length) {
      return { mode: 'live', listings: [], url: ka.searchUrl({ q, minPrice, maxPrice, page, onlyToday, privateOnly, category }), empty: true, total };
    }
    lastGood.set(key, { listings, ts: Date.now() });
    if (lastGood.size > 200) {
      const oldest = [...lastGood.entries()].sort((a, b) => a[1].ts - b[1].ts)[0][0];
      lastGood.delete(oldest);
    }
    liveOkAt = Date.now();
    lastLiveError = null;
    const snapAt = store.recordSnapshot(key, listings);
    const decorated = store.decorate(listings, snapAt);
    store.rememberRecent(decorated);
    return {
      mode: 'live', listings: decorated, url: ka.searchUrl({ q, minPrice, maxPrice, page, onlyToday, privateOnly, category }),
      total, snapshotAt: snapAt, droppedTop,
      pagesFetched: pages.length,
      hasMore: pages[pages.length - 1].listings.length >= 10,
    };
  }

  // первая страница не далась — fallback
  const e = firstPageError || new Error('empty');
  const url = ka.searchUrl({ q, minPrice, maxPrice, page, onlyToday, privateOnly, category });
  lastLiveError = e.message + ' @ ' + new Date().toISOString();
  const stale = lastGood.get(key);
  if (stale) {
    return { mode: 'cached', listings: store.decorate(stale.listings, stale.ts), url };
  }
  if (e.blocked || /network|blocked|http:/.test(e.message)) {
    const d = demo.demoSearch({ q, minPrice, maxPrice, page }, force);
    return { mode: 'demo', listings: d.listings, url, fallbackReason: e.message };
  }
  return { mode: 'live', listings: [], url, empty: true };
}

// --- API ----------------------------------------------------------------

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || 'angebote').slice(0, 80).replace(/[^\p{L}\p{N}\s+-]/gu, '');
  const minPrice = clampInt(req.query.min, 0, 999999, 0);
  const maxPrice = clampInt(req.query.max, 0, 999999, 0);
  const page = clampInt(req.query.page, 1, 10, 1);
  const force = req.query.force === '1';
  const wantDemo = req.query.mode === 'demo';

  if (wantDemo) {
    const d = demo.demoSearch({ q, minPrice, maxPrice, page }, force);
    const noShops = req.query.all !== '1';
    const listings = noShops ? d.listings.filter(l => !l.isTop) : d.listings;
    return res.json({
      mode: 'demo',
      notice: 'Демо-режим: показаны сгенерированные данные, а не реальные объявления.',
      query: { q, minPrice, maxPrice, page, noShops },
      listings,
    });
  }

  const norm = normalizeQuery(q);
  if (!norm.q) {
    return res.json({ mode: 'live', query: { q, minPrice, maxPrice, page }, notice: norm.note, count: 0, listings: [] });
  }

  const onlyToday = req.query.today === '1';
  const noShops = req.query.all !== '1';   // системный фильтр: без магазинов и TOP (по умолчанию ВКЛ)
  const cat = clampInt(req.query.cat, 0, 999, 0);
  const category = KA_CATEGORIES[cat] ? cat : 0;
  const depth = clampInt(req.query.depth, 1, 5, 3);
  const out = await fetchSearch({ q: norm.q, minPrice, maxPrice, page, force, onlyToday, privateOnly: noShops, category, depth });
  const notice = norm.note
    || (out.empty && !onlyToday ? 'По этому запросу на Kleinanzeigen ничего не нашлось. Попробуйте иначе: iphone, sofa, fahrrad, laptop, e-bike…' : null);
  const todayIso = new Date().toISOString().slice(0, 10);
  const newToday = out.listings.filter(l => l.date === todayIso).length;
  res.json({
    mode: out.mode,
    fallbackReason: out.fallbackReason || null,
    notice,
    query: { q, effective: norm.q, minPrice, maxPrice, page, onlyToday, noShops, cat: category, catName: KA_CATEGORIES[category] || null },
    url: out.url,
    total: out.total || null,
    droppedTop: out.droppedTop || 0,
    newToday,
    snapshotAt: out.snapshotAt || Date.now(),
    count: out.listings.length,
    pagesFetched: out.pagesFetched || 1,
    hasMore: out.hasMore !== false,
    depth,
    listings: out.listings,
  });
});

app.get('/api/ad/:id', async (req, res) => {
  const id = String(req.params.id || '').replace(/\D/g, '').slice(0, 12);
  const href = String(req.query.href || '').replace(/[^\/a-z0-9-:.\s]/gi, '');
  const wantDemo = req.query.mode === 'demo';
  if (!id || !href) return res.status(400).json({ error: 'id и href обязательны' });

  const hist = store.historyFor(id);
  if (wantDemo) {
    return res.json({ mode: 'demo', ad: demo.demoDetail(id), history: null });
  }
  try {
    const url = ka.adUrl(href);
    const { html } = await ka.get(url, { referer: ka.BASE + '/', ttlMs: 10 * 60e3 });
    const ad = parseDetail(html);
    ad.id = id;
    ad.href = href;
    const recMeta = store.recent(200).find(l => String(l.id) === String(id));
    // просмотры (оценка), возраст и «горячесть» по правилу 20 мин–4 ч и >= 0.5 просм./мин
    const postedAt = (recMeta && recMeta.postedAt) || (hist && hist.postedAt) || ad.postedAt || null;
    const vm = store.viewsMetaFor(id, postedAt, Date.now());
    Object.assign(ad, vm);           // postedAt, ageMin, vpm, views, isHot
    if (hist) {
      ad.tracked = hist;
      const ts = hist.prices.map(p => p.t).concat([Date.now()]);
      ad.viewsSeries = ts.map(t => ({
        t,
        v: postedAt
          ? Math.max(1, Math.round((vm.vpm || 0) * Math.max(0, (t - postedAt) / 60000)))
          : vm.views,
      }));
    } else {
      ad.viewsSeries = vm.views != null ? [{ t: Date.now(), v: vm.views }] : [];
    }
    return res.json({ mode: 'live', ad });
  } catch (e) {
    if (hist) {
      return res.json({
        mode: 'cached',
        ad: {
          id, href, title: hist.title, image: hist.image,
          price: hist.prices.length ? hist.prices[hist.prices.length - 1].price : null,
          tracked: hist, _partial: true,
        },
        fallbackReason: e.message,
      });
    }
    const rec = store.recent(200).find(l => String(l.id) === String(id));
    if (rec) {
      return res.json({
        mode: 'cached',
        ad: {
          id, href: rec.href, title: rec.title, image: rec.image,
          price: rec.price, priceRaw: rec.priceRaw, negotiable: rec.negotiable,
          oldPrice: rec.oldPrice, date: rec.date, category: rec.category,
          interest: rec.interest,
          views: rec.views, vpm: rec.vpm, ageMin: rec.ageMin, isHot: rec.isHot, postedAt: rec.postedAt,
          interestSeries: [{ t: Date.now(), v: rec.interest || 0 }],
          viewsSeries: rec.views != null ? [{ t: Date.now(), v: rec.views }] : [],
          _partial: true,
        },
        fallbackReason: e.message,
      });
    }
    return res.json({ mode: 'demo', ad: demo.demoDetail(id), fallbackReason: e.message });
  }
});

app.get('/api/trending', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 40, 12);
  let items = store.trending(limit);
  if (items.length < limit) {
    // холодный старт: истории ещё нет — показываем самые горячие из последнего среза
    const seen = new Set(items.map(i => i.id));
    for (const r of store.recent(limit)) {
      if (!seen.has(r.id)) { items.push(r); seen.add(r.id); }
    }
    items = items.slice(0, limit);
  }
  res.json({ mode: 'live', items, lastSnapshotAt: liveOkAt });
});

app.get('/api/status', (req, res) => {
  res.json({
    live: {
      okAt: liveOkAt,
      lastError: lastLiveError,
    },
    ka: ka.stats(),
    store: store.stats(),
  });
});

// Прокси картинок: относительный URL => работает и в превью, и на хостинге
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (!/^https:\/\/img\.kleinanzeigen\.de\//.test(u)) {
    return res.status(400).end();
  }
  try {
    const r = await fetch(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36',
        'Referer': ka.BASE + '/',
        'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
      },
    });
    if (!r.ok) return res.status(502).end();
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    const buf = Buffer.from(await r.arrayBuffer());
    return res.send(buf);
  } catch (_) {
    return res.status(502).end();
  }
});

// --- статика ------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '30d',                              // ассеты версионированы (?v=N) — кэшируем надолго
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- прогрев данных (бережно: пара запросов раз в 20 минут) ---
const WARM_JOBS = [
  { q: 'angebote', onlyToday: true, privateOnly: true },
  { q: 'iphone', onlyToday: false, privateOnly: true },
];
let warmBusy = false;
async function warm() {
  if (warmBusy) return;
  warmBusy = true;
  try {
    for (const job of WARM_JOBS) {
      await fetchSearch({ q: job.q, minPrice: 0, maxPrice: 0, page: 1, force: false, onlyToday: job.onlyToday, privateOnly: job.privateOnly });
    }
  } catch (_) { /* тихо */ }
  warmBusy = false;
}
setTimeout(warm, 12000);
setInterval(warm, 20 * 60 * 1000);

// --- не даём бесплатному инстансу засыпать (пинг своего публичного URL раз в 10 мин) ---
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '';
if (PUBLIC_URL) {
  setInterval(async () => {
    try {
      await fetch(PUBLIC_URL + '/api/status', { signal: AbortSignal.timeout(20000) });
      console.log('[keep-awake] ping ok', new Date().toISOString());
    } catch (_) { /* тихо */ }
  }, 10 * 60 * 1000);
}

app.listen(PORT, HOST, () => {
  console.log(`KL Ads listening on http://${HOST}:${PORT}`);
});
