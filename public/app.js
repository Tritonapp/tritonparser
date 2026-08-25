/* KL Ads — фронтенд: лента, фильтры, тренды, модалка лота, график цены */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    mode: null,          // 'live' | 'demo' | 'cached'
    page: 1,
    listings: [],
    query: { q: 'iphone 15', min: '', max: '' },
    autoTimer: null,
    autoRefresh: true,
    lastFetchAt: null,
  };

  const fmt = {
    price(v) {
      if (v == null) return '—';
      return v.toLocaleString('ru-RU') + ' €';
    },
    date(d) {
      if (!d) return '';
      try { return new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); }
      catch (_) { return d; }
    },
    time(ts) {
      if (!ts) return '—';
      return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function imgProxy(u) { return u ? '/api/img?u=' + encodeURIComponent(u) : null; }

  // ---------- режим ----------
  function setMode(mode, reason) {
    state.mode = mode;
    const pill = $('modePill');
    pill.className = 'mode-pill ' + mode;
    pill.textContent = mode === 'live' ? 'LIVE · kleinanzeigen.de' : mode === 'cached' ? 'КЭШ (нет доступа)' : 'ДЕМО-режим';
    const b = $('banner');
    if (mode === 'live') {
      b.hidden = true;
    } else if (mode === 'cached') {
      b.hidden = false; b.className = 'banner';
      b.textContent = 'Kleinanzeigen временно не отвечает — показан последний успешный срез. Попробуйте «Свежий срез» через минуту.';
    } else {
      b.hidden = false; b.className = 'banner';
      b.textContent = reason
        ? 'Kleinanzeigen недоступен с этого сервера (' + esc(reason) + '). Показаны демо-данные: весь интерфейс работает как на живых данных.'
        : 'Демо-режим: показаны сгенерированные данные, интерфейс полностью функционален.';
    }
  }

  // ---------- поиск ----------
  async function loadSearch({ force = false, demo = false } = {}) {
    const grid = $('feedGrid');
    grid.innerHTML = '<div class="empty">Загружаем данные…</div>';
    $('feedEmpty').hidden = true;
    const q = $('q').value.trim() || 'angebote';
    state.query = { q, min: $('min').value, max: $('max').value };

    const p = new URLSearchParams({ q, page: String(state.page), force: force ? '1' : '0' });
    if ($('min').value) p.set('min', $('min').value);
    if ($('max').value) p.set('max', $('max').value);
    if (demo) p.set('mode', 'demo');

    try {
      const r = await fetch('/api/search?' + p);
      const j = await r.json();
      state.listings = j.listings || [];
      state.page = (j.query && j.query.page) || state.page;
      if (demo) setMode('demo', null);
      else setMode(j.mode, j.fallbackReason);
      state.lastFetchAt = Date.now();
      $('lastSnap').textContent = fmt.time(state.lastFetchAt);
      $('feedQuery').textContent = 'запрос: «' + q + '»' + (j.mode !== 'live' ? ' · ' + (j.mode === 'demo' ? 'демо' : 'кэш') : '');
      renderFeed();
      loadStatus();
      loadTrending();
    } catch (e) {
      grid.innerHTML = '';
      $('feedEmpty').hidden = false;
      $('feedEmpty').textContent = 'Ошибка загрузки: ' + e.message;
    }
  }

  function sortListings(list) {
    const s = $('sort').value;
    const by = {
      hot: (a, b) => (b.hot || 0) - (a.hot || 0),
      new: (a, b) => (b.date || '').localeCompare(a.date || ''),
      cheap: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
      expensive: (a, b) => (b.price ?? -1) - (a.price ?? -1),
      drop: (a, b) => (b.priceDrop || 0) - (a.priceDrop || 0),
    }[s] || (() => 0);
    return list.slice().sort(by);
  }

  function renderFeed() {
    const grid = $('feedGrid');
    let list = sortListings(state.listings);
    if ($('hotOnly').checked) list = list.filter(l => (l.hot || 0) >= 25);
    $('feedCount').textContent = list.length ? '· ' + list.length + ' лотов' : '';
    $('pageInfo').textContent = 'стр. ' + state.page;
    $('pager').hidden = state.mode === 'demo';
    $('prevPage').disabled = state.page <= 1;
    grid.innerHTML = list.map(cardHTML).join('');
    $('feedEmpty').hidden = list.length > 0;
    grid.querySelectorAll('.card').forEach(el => {
      el.addEventListener('click', () => openAd(el.dataset.id, el.dataset.href));
    });
  }

  function cardHTML(l) {
    const img = imgProxy(l.image);
    const badges = [];
    if ((l.hot || 0) >= 60) badges.push('<span class="badge hot">🔥 ' + l.hot + '</span>');
    else if ((l.hot || 0) >= 25) badges.push('<span class="badge hot">🔥 ' + l.hot + '</span>');
    if (l.isTop) badges.push('<span class="badge top">TOP</span>');
    if (l.date && Date.now() - new Date(l.date + 'T12:00:00').getTime() < 36 * 3600e3) badges.push('<span class="badge new">NEW</span>');
    if (l.priceDrop) badges.push('<span class="badge drop">−' + l.priceDropPct + '%</span>');
    const tags = (l.tags || []).map(t => '<span class="tag">' + esc({ direkt: 'Direkt kaufen', versand: 'Versand', garantie: 'Garantie' }[t] || t) + '</span>').join('');
    return (
      '<article class="card" data-id="' + esc(l.id) + '" data-href="' + esc(l.href || '') + '">' +
      '<div class="c-media" style="' + (img ? 'background-image:url(' + img + ')' : '') + '">' +
        (!img ? '<span class="no-photo">Нет фото</span>' : '') +
        '<div class="c-badges">' + badges.join('') + '</div>' +
        (l.imgCount > 1 ? '<span class="c-count">📷 ' + l.imgCount + '</span>' : '') +
      '</div>' +
      '<div class="c-body">' +
        '<div class="c-title">' + esc(l.title) + '</div>' +
        '<div class="c-price-row"><span class="c-price">' + fmt.price(l.price) + '</span>' +
          (l.negotiable ? '<span class="c-vb">VB</span>' : '') +
          (l.oldPrice ? '<s class="c-old">' + fmt.price(l.oldPrice) + '</s>' : '') +
        '</div>' +
        '<div class="c-foot"><span class="c-loc">📍 ' + esc(l.location || '—') + '</span><span>' + esc(l.dateTxt || fmt.date(l.date) || '') + '</span></div>' +
        (tags ? '<div class="c-tags">' + tags + '</div>' : '') +
      '</div></article>'
    );
  }

  // ---------- тренды / hero ----------
  async function loadTrending() {
    try {
      const r = await fetch('/api/trending?limit=12');
      const j = await r.json();
      const items = j.items || [];
      $('trendStrip').innerHTML = items.length ? items.map(t => (
        '<div class="trend-card" data-id="' + esc(t.id) + '" data-href="' + esc(t.href || '') + '">' +
          '<div class="t-score">' + (t.hot || 0) + '<small>SCORE</small></div>' +
          '<div class="t-name"><b>' + esc(t.title) + '</b><span>' + fmt.price(t.price) + (t.location ? ' · ' + esc(t.location) : '') + '</span></div>' +
          (t.priceDrop ? '<div class="t-up">−' + t.priceDropPct + '%</div>' : '') +
        '</div>'
      )).join('') : '<div class="empty">Пока мало истории: сделайте пару срезов — и здесь появятся лоты с динамикой.</div>';
      document.querySelectorAll('.trend-card').forEach(el => {
        el.addEventListener('click', () => openAd(el.dataset.id, el.dataset.href));
      });

      const hero = items.slice(0, 5);
      $('heroList').innerHTML = hero.length ? hero.map(t => (
        '<li data-id="' + esc(t.id) + '" data-href="' + esc(t.href || '') + '">' +
          '<div class="hc-thumb">' + (t.image ? '<img src="' + imgProxy(t.image) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:7px">' : '📷') + '</div>' +
          '<div class="hc-name"><b>' + esc(t.title) + '</b><span>' + fmt.price(t.price) + (t.location ? ' · ' + esc(t.location) : '') + '</span></div>' +
          '<div class="hc-hot">+' + (t.hot || 0) + '</div>' +
        '</li>'
      )).join('') : '<li class="hc-empty">история набирается…</li>';
      document.querySelectorAll('#heroList li[data-id]').forEach(el => {
        el.addEventListener('click', () => openAd(el.dataset.id, el.dataset.href));
      });
    } catch (_) { /* тихо */ }
  }

  async function loadStatus() {
    try {
      const r = await fetch('/api/status');
      const j = await r.json();
      $('trackedCount').textContent = 'Отслеживается объявлений: ' + (j.store ? j.store.adsTracked : '—');
    } catch (_) { /* тихо */ }
  }

  // ---------- модалка ----------
  async function openAd(id, href) {
    if (!id) return;
    const back = $('modalBack');
    back.hidden = false;
    document.body.style.overflow = 'hidden';
    $('mTitle').textContent = 'Загрузка…';
    $('mPrice').textContent = '—'; $('mOld').hidden = true; $('mDrop').hidden = true;
    $('mMeta').innerHTML = ''; $('mDesc').textContent = '…';
    $('mDetails').innerHTML = ''; $('mSeller').innerHTML = '';
    $('mBadges').innerHTML = ''; $('mChart').innerHTML = '';
    $('mChartNote').textContent = '';
    $('mImg').style.backgroundImage = '';
    $('mImg').innerHTML = '<span class="no-photo">Нет фото</span>';
    $('mOpen').href = href ? 'https://www.kleinanzeigen.de' + href : '#';

    const p = new URLSearchParams({ href: href || '' });
    if (state.mode === 'demo') p.set('mode', 'demo');
    try {
      const r = await fetch('/api/ad/' + encodeURIComponent(id) + '?' + p);
      const j = await r.json();
      renderAd(j.ad || {}, j.mode);
    } catch (e) {
      $('mTitle').textContent = 'Не удалось загрузить объявление';
    }
  }

  function renderAd(ad, mode) {
    $('mTitle').textContent = ad.title || '—';
    $('mPrice').textContent = ad.priceRaw || fmt.price(ad.price);
    if (ad.oldPrice || (ad.tracked && ad.tracked.prices && ad.tracked.prices.length > 1)) {
      const hist = (ad.tracked && ad.tracked.prices) || [];
      const p0 = hist.length ? hist[0].price : ad.oldPrice;
      const p1 = ad.price;
      if (p0 && p1 != null && p1 < p0) {
        $('mOld').hidden = false; $('mOld').textContent = fmt.price(p0);
        $('mDrop').hidden = false;
        $('mDrop').textContent = '−' + Math.round((1 - p1 / p0) * 100) + '% за время наблюдения';
      }
    }
    const badges = [];
    if (mode === 'demo') badges.push('<span class="badge drop">ДЕМО</span>');
    if (ad.sold) badges.push('<span class="badge top">ПРОДАНО</span>');
    $('mBadges').innerHTML = badges.join('');

    const meta = [];
    if (ad.date) meta.push(['Дата', fmt.date(ad.date)]);
    if (ad.category) meta.push(['Категория', ad.category]);
    if (ad.negotiable) meta.push(['Торг', 'возможен (VB)']);
    if (ad.id) meta.push(['ID', ad.id]);
    $('mMeta').innerHTML = meta.map(([k, v]) => '<li><b>' + esc(k) + ':</b> ' + esc(v) + '</li>').join('');

    const img = imgProxy(ad.images && ad.images[0] ? ad.images[0] : ad.image);
    if (img) { $('mImg').style.backgroundImage = 'url(' + img + ')'; $('mImg').innerHTML = ''; }

    $('mDesc').textContent = ad.description || 'Описание недоступно.';
    $('mDetails').innerHTML = (ad.details || []).map(d => '<span><b>' + esc(d.label) + ':</b> ' + esc(d.value) + '</span>').join('');

    const s = ad.seller || {};
    const sBits = [];
    if (s.name) sBits.push('Продавец: <b>' + esc(s.name) + '</b>');
    if (s.initials) sBits.push('профиль: ' + esc(s.initials));
    if (s.memberSince) sBits.push('на Kleinanzeigen с ' + esc(s.memberSince));
    if (s.badges && s.badges.length) sBits.push('значки: ' + s.badges.join(', '));
    $('mSeller').innerHTML = sBits.length ? sBits.join(' · ') : 'Информация о продавце доступна на странице объявления.';

    drawChart(ad.tracked && ad.tracked.prices ? ad.tracked.prices : []);
    $('mOpen').href = ad.href ? 'https://www.kleinanzeigen.de' + ad.href : '#';
  }

  function drawChart(prices) {
    const svg = $('mChart');
    const note = $('mChartNote');
    if (!prices || prices.length < 2) {
      svg.innerHTML = '<line x1="0" y1="60" x2="320" y2="60" stroke="#22304d" stroke-dasharray="4 6"/><text x="160" y="52" fill="#64779c" font-size="11" text-anchor="middle">нужно ≥2 срезов — обновите ленту позже</text>';
      note.textContent = 'График строится по срезам нашего сервера: чем чаще смотрите выдачу, тем плотнее история.';
      return;
    }
    const W = 320, H = 120, pad = 10;
    const vals = prices.map(p => p.price);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = (max - min) || 1;
    const pts = prices.map((p, i) => {
      const x = pad + (W - 2 * pad) * (i / (prices.length - 1));
      const y = H - pad - (H - 2 * pad) * ((p.price - min) / span);
      return [x, y, p];
    });
    const line = pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const area = line + ` ${W - pad},${H - pad} ${pad},${H - pad}`;
    const circles = pts.map(p => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" fill="#38bdf8"/>').join('');
    svg.innerHTML =
      '<polygon points="' + area + '" fill="rgba(56,189,248,.12)"/>' +
      '<polyline points="' + line + '" fill="none" stroke="#38bdf8" stroke-width="2"/>' + circles;
    const first = pts[0][2], last = pts[pts.length - 1][2];
    const d0 = new Date(first.t), d1 = new Date(last.t);
    const drop = last.price < first.price ? '−' + Math.round((1 - last.price / first.price) * 100) + '%' : (last.price > first.price ? '+' + Math.round((last.price / first.price - 1) * 100) + '%' : 'без изменений');
    note.textContent = d0.toLocaleDateString('ru-RU') + ' → ' + d1.toLocaleDateString('ru-RU') + ' · ' + drop;
  }

  function closeAd() {
    $('modalBack').hidden = true;
    document.body.style.overflow = '';
  }

  // ---------- события ----------
  $('searchForm').addEventListener('submit', e => { e.preventDefault(); state.page = 1; loadSearch(); });
  $('btnRefresh').addEventListener('click', () => loadSearch({ force: true }));
  $('btnDemo').addEventListener('click', () => { loadSearch({ demo: true }); });
  $('btnStart').addEventListener('click', () => { document.getElementById('feed').scrollIntoView({ behavior: 'smooth' }); });
  $('sort').addEventListener('change', renderFeed);
  $('hotOnly').addEventListener('change', renderFeed);
  $('prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadSearch(); } });
  $('nextPage').addEventListener('click', () => { state.page++; loadSearch(); });
  $('modalX').addEventListener('click', closeAd);
  $('modalBack').addEventListener('click', e => { if (e.target === $('modalBack')) closeAd(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAd(); });

  $('autoRefresh').addEventListener('change', () => {
    state.autoRefresh = $('autoRefresh').checked;
    scheduleAuto();
  });

  function scheduleAuto() {
    if (state.autoTimer) clearInterval(state.autoTimer);
    if (!state.autoRefresh) return;
    // каждые 3 минуты снимаем срез — так накапливается история цен
    state.autoTimer = setInterval(() => {
      if (state.mode !== 'demo') loadSearch({ force: true });
    }, 3 * 60 * 1000);
  }

  // ---------- старт ----------
  loadSearch();
  scheduleAuto();
  loadTrending();
})();
