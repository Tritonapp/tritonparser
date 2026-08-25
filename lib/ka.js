/**
 * Kleinanzeigen fetcher.
 * - публичные страницы поиска/объявлений (без логина)
 * - cookie-сессия + заголовки браузера (анти-бот защита отдаёт 403 на "голые" запросы)
 * - глобальный pacing: минимум MIN_INTERVAL_MS между запросами, без параллелизма
 * - TTL-кэш ответов, чтобы не дёргать сайт чаще необходимого
 */
'use strict';

const MIN_INTERVAL_MS = parseInt(process.env.KA_MIN_INTERVAL_MS || '4000', 10);
const UA = (process.env.KA_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
const BASE = 'https://www.kleinanzeigen.de';
const CACHE_TTL_MS = parseInt(process.env.KA_CACHE_TTL_MS || String(2 * 60 * 1000), 10);

let cookieStr = '';
let lastRequestAt = 0;
let chain = Promise.resolve();          // сериализация запросов
const cache = new Map();                // url -> {html, ts}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function absorbCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (!raw.length) return;
  for (const line of raw) {
    const pair = line.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    const parts = cookieStr.split('; ').filter(Boolean);
    const filtered = parts.filter(p => !p.startsWith(name + '='));
    filtered.push(name + '=' + val);
    cookieStr = filtered.join('; ');
  }
  if (cookieStr.length > 3000) cookieStr = cookieStr.slice(0, 3000);
}

async function rawGet(url, { referer } = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7,ru;q=0.5',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };
  if (cookieStr) headers['Cookie'] = cookieStr;
  if (referer) headers['Referer'] = referer;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  absorbCookies(res);
  const html = await res.text();
  return { status: res.status, html, finalUrl: res.url };
}

/** Похоже ли содержимое на бот-блокировку, а не на реальную выдачу */
function looksBlocked(html) {
  return /Just a moment|cf-chl|challenge-platform|Attention Required/i.test(html || '');
}

/**
 * Единая точка входа: кэш -> очередь с pacing -> повтор при 403 (1 раз, с паузой).
 * Возвращает { status, html } либо бросает ошибку.
 */
async function get(url, { referer, ttlMs = CACHE_TTL_MS, force = false } = {}) {
  const hit = cache.get(url);
  const fresh = hit && (Date.now() - hit.ts < ttlMs);
  if (!force && fresh) return { status: 200, html: hit.html, cached: true };

  const task = (async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);

    // холодный старт: сначала получаем куки с главной
    if (!cookieStr) await ensureSession();

    let attempt = 0;
    // до 3 попыток; при 403 сбрасываем сессию, прогреваем и пробуем снова
    while (true) {
      attempt++;
      lastRequestAt = Date.now();
      let out;
      try {
        out = await rawGet(url, { referer });
      } catch (e) {
        if (attempt >= 3) throw new Error('network: ' + e.message);
        await sleep(6000 + Math.random() * 4000);
        continue;
      }
      if (out.status === 200 && out.html && out.html.length > 5000 && !looksBlocked(out.html)) {
        cache.set(url, { html: out.html, ts: Date.now() });
        return { status: 200, html: out.html, cached: false };
      }
      if (out.status === 403 || out.status === 429 || looksBlocked(out.html)) {
        if (attempt >= 3) {
          const err = new Error('blocked:' + out.status);
          err.blocked = true;
          throw err;
        }
        cookieStr = '';                       // сессия протухла — пересобираем
        await sleep(8000 + Math.random() * 5000);
        await ensureSession();
        continue;
      }
      if (out.status === 404) {
        const err = new Error('not-found');
        err.notFound = true;
        throw err;
      }
      if (attempt >= 3) throw new Error('http:' + out.status);
      await sleep(4000);
    }
  })();

  chain = chain.then(() => task, () => task);
  return task;
}

/** URL поиска. Сегменты: preis:100:800, erstellt:heute (только размещённые сегодня) */
function searchUrl({ q, minPrice, maxPrice, page = 1, onlyToday = false }) {
  const slug = encodeURIComponent(String(q || '').trim().toLowerCase().replace(/\s+/g, '-')).replace(/%2B/g, '+');
  const segs = [];
  if (onlyToday) segs.push('erstellt:heute');
  if (minPrice > 0 || maxPrice > 0) {
    const lo = minPrice > 0 ? String(minPrice) : '';
    const hi = maxPrice > 0 ? String(maxPrice) : '';
    segs.push('preis:' + lo + ':' + hi);
  }
  segs.push(slug || 'angebote');
  let url = BASE + '/s-' + segs.join('/') + '/k0';
  if (page && page > 1) url += 'seite:' + page;
  return url;
}

/** Прогрев сессии: главная страница ставит куки, без них поиск чаще ловит 403 */
async function ensureSession() {
  if (cookieStr) return;
  try {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const res = await rawGet(BASE + '/', {});
    if (res.status === 200) { /* куки уже впитаны в absorbCookies */ }
  } catch (_) { /* не критично */ }
}

function adUrl(href) {
  if (/^https?:/.test(href)) return href;
  return BASE + href;
}

function stats() {
  return { cookies: !!cookieStr, cachedUrls: cache.size, minIntervalMs: MIN_INTERVAL_MS };
}

module.exports = { get, searchUrl, adUrl, stats, looksBlocked, BASE };
