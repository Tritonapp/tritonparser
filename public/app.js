/* KL Ads — фронтенд: лента, фильтры, тренды, модалка лота, график цены */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const POPULAR = ['iphone 15', 'laptop', 'e-bike', 'sofa', 'ps5', 'fahrrad', 'kopfhörer', '_waschmaschine'];
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

  // ---------- баннеры / режим ----------
  function setMode(mode, reason, notice) {
    state.mode = mode;
    const pill = $('modePill');
    pill.className = 'mode-pill ' + mode;
    pill.textContent = mode === 'live' ? 'LIVE · kleinanzeigen.de' : mode === 'cached' ? 'КЭШ (нет доступа)' : 'ДЕМО-режим';
    const b = $('banner');
    if (notice) {
      b.hidden = false; b.className = 'banner info';
      b.textContent = notice;
    } else if (mode === 'live') {
      b.hidden = true;
    } else if (mode === 'cached') {
      b.hidden = false; b.className = 'banner';
      b.textContent = 'Kleinanzeigen временно не отвечает — показан последний успешный срез. Попробуйте «↻ Свежий срез» через минуту.';
    } else {
      b.hidden = false; b.className = 'banner demo-banner';
      b.innerHTML = '<b>ДЕМО-РЕЖИМ:</b> ' + (reason
        ? 'Kleinanzeigen не отвечает с этого сервера (' + esc(reason) + '), поэтому ниже сгенерированные примеры, а не реальные объявления. Интерфейс полностью рабочий.'
        : 'ниже сгенерированные примеры, а не реальные объявления. Интерфейс полностью рабочий.');
    }
  }

  // ---------- поиск ----------
  function cacheFeed(j) {
    try { localStorage.setItem('klads:lastFeed', JSON.stringify({ ts: Date.now(), j })); } catch (_) {}
  }
  function cachedFeed() {
    try {
      const s = localStorage.getItem('klads:lastFeed');
      return s ? JSON.parse(s) : null;
    } catch (_) { return null; }
  }

  async function loadSearch({ force = false, demo = false } = {}) {
    const grid = $('feedGrid');
    const cached = cachedFeed();
    if (cached && Date.now() - cached.ts < 20 * 60e3 && !force && !demo) {
      // мгновенно показываем последний срез, свежий придёт следом
      state.listings = cached.j.listings || [];
      state.mode = cached.j.mode;
      setMode(cached.j.mode, null, 'Показан последний срез (' + fmt.time(cached.ts) + ') — обновляем…');
      renderFeed();
    } else {
      grid.innerHTML = '<div class="empty">Загружаем данные с Kleinanzeigen…<br><span class="muted">первый запрос может занять до 30 секунд</span></div>';
      $('feedEmpty').hidden = true;
    }
    const q = $('q').value.trim() || 'angebote';
    state.query = { q, min: $('min').value, max: $('max').value };

    const p = new URLSearchParams({ q, page: String(state.page), force: force ? '1' : '0' });
    if ($('min').value) p.set('min', $('min').value);
    if ($('max').value) p.set('max', $('max').value);
    if ($('todayOnly').checked) p.set('today', '1');
    if (demo) p.set('mode', 'demo');

    try {
      const r = await fetch('/api/search?' + p);
      const j = await r.json();
      state.listings = j.listings || [];
      state.page = (j.query && j.query.page) || state.page;
      if (demo) setMode('demo', null, j.notice || null);
      else setMode(j.mode, j.fallbackReason, j.notice);
      state.lastFetchAt = Date.now();
      $('lastSnap').textContent = fmt.time(state.lastFetchAt);
      const eff = j.query && j.query.effective;
      const today = $('todayOnly').checked;
      $('feedQuery').textContent = (q === 'angebote')
        ? (today ? '🆕 свежие объявления · за сегодня' : 'все объявления Kleinanzeigen')
        : 'запрос: «' + (eff || q) + '»' + (eff && eff !== q ? ' (по вашему «' + q + '»)' : '');
      const st = [];
      if (j.newToday) st.push('новых сегодня: ' + j.newToday);
      if (j.total) st.push('всего на Kleinanzeigen: ' + j.total.toLocaleString('ru-RU'));
      if (j.snapshotAt) st.push('срез: ' + fmt.time(j.snapshotAt));
      $('feedStats').textContent = st.join(' · ');
      renderFeed();
      cacheFeed(j);
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
    grid.innerHTML = list.length ? list.map(cardHTML).join('') : '';
    const empty = $('feedEmpty');
    empty.hidden = list.length > 0;
    if (!list.length) {
      empty.innerHTML = state.mode === 'demo'
        ? 'Пусто. Измените запрос.'
        : ($('todayOnly').checked
          ? 'Сегодня по этому запросу ещё ничего не разместили.<br><span class="muted">снимите галочку «только размещённые сегодня» — увидите все объявления</span>'
          : 'Ничего не нашлось. Попробуйте запрос латиницей (немецкий/английский):<div class="chips">' + POPULAR.slice(0, 6).map(chipHTML).join('') + '</div>');
      empty.querySelectorAll('.chip').forEach(el => {
        el.addEventListener('click', () => { $('q').value = el.dataset.q; state.page = 1; loadSearch(); });
      });
    }
    grid.querySelectorAll('.card').forEach(el => {
      el.addEventListener('click', () => openAd(el.dataset.id, el.dataset.href));
    });
  }

  function chipHTML(q) {
    return '<button class="chip" data-q="' + esc(q) + '">' + esc(q) + '</button>';
  }

  function cardHTML(l) {
    const img = imgProxy(l.image);
    const badges = [];
    if (state.mode === 'demo') badges.push('<span class="badge drop">ДЕМО</span>');
    if ((l.hot || 0) >= 25) badges.push('<span class="badge hot">🔥 ' + l.hot + '</span>');
    if (l.isTop) badges.push('<span class="badge top">TOP</span>');
    if (l.date && Date.now() - new Date(l.date + 'T12:00:00').getTime() < 36 * 3600e3) badges.push('<span class="badge new">NEW</span>');
    if (l.priceDrop) badges.push('<span class="badge drop">−' + l.priceDropPct + '%</span>');
    const tags = (l.tags || []).map(t => '<span class="tag">' + esc({ direkt: 'Direkt kaufen', versand: 'Versand', garantie: 'Garantie' }[t] || t) + '</span>').join('');
    const priceTxt = fmt.price(l.price) + (l.negotiable ? ' VB' : '');
    return (
      '<article class="card" data-id="' + esc(l.id) + '" data-href="' + esc(l.href || '') + '">' +
      '<div class="c-media" style="' + (img ? 'background-image:url(' + img + ')' : '') + '">' +
        (!img ? '<span class="no-photo">Нет фото</span>' : '') +
        '<div class="c-badges">' + badges.join('') + '</div>' +
        (l.imgCount > 1 ? '<span class="c-count">📷 ' + l.imgCount + '</span>' : '') +
      '</div>' +
      '<div class="c-body">' +
        '<div class="c-title">' + esc(l.title) + '</div>' +
        '<div class="c-meta"><span class="c-cat">' + esc(l.category || 'Kleinanzeigen') + '</span><span class="c-sep">·</span><b>' + priceTxt + '</b>' +
          (l.oldPrice ? ' <s class="c-old">' + fmt.price(l.oldPrice) + '</s>' : '') + '</div>' +
        '<div class="c-growth"><span class="g-plus">+' + (l.interest || 0) + '</span><span class="g-lbl">прирост</span></div>' +
        '<div class="c-foot"><span class="c-loc">' + (l.location ? '📍 ' + esc(l.location) : '') + '</span><span>' + esc(l.dateTxt || fmt.date(l.date) || '') + '</span></div>' +
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
          '<div class="t-score">+' + (t.interest || 0) + '<small>ПРИРОСТ</small></div>' +
          '<div class="t-name"><b>' + esc(t.title) + '</b><span>' + esc(t.category || 'KL') + ' · ' + fmt.price(t.price) + (t.location ? ' · ' + esc(t.location) : '') + '</span></div>' +
          (t.priceDrop ? '<div class="t-up">−' + t.priceDropPct + '%</div>' : '') +
        '</div>'
      )).join('') : '<div class="empty">Пока мало истории: сделайте пару срезов — и здесь появятся лоты с динамикой.</div>';
      document.querySelectorAll('.trend-card').forEach(el => {
        el.addEventListener('click', () => openAd(el.dataset.id, el.dataset.href));
      });

      const hero = items.slice(0, 5);
      $('heroList').innerHTML = hero.length ? hero.map(t => (
        '<li data-id="' + esc(t.id) + '" data-href="' + esc(t.href || '') + '">' +
          '<div class="hc-thumb">' + (t.image ? '<img src="' + imgProxy(t.image) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:7px">' : 'Нет фото') + '</div>' +
          '<div class="hc-name"><b>' + esc(t.title) + '</b><span>' + esc(t.category || 'KL') + ' · ' + fmt.price(t.price) + '</span></div>' +
          '<div class="hc-hot">+' + (t.interest || t.hot || 0) + '</div>' +
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
  function findLocal(id) {
    return state.listings.find(l => String(l.id) === String(id)) || null;
  }

  async function openAd(id, href) {
    if (!id) return;
    const back = $('modalBack');
    back.hidden = false;
    document.body.style.overflow = 'hidden';
    $('mOpen').href = href ? 'https://www.kleinanzeigen.de' + href : '#';

    // 1) мгновенно показываем то, что уже знаем из ленты
    const local = findLocal(id);
    if (local) {
      renderAd({
        title: local.title,
        price: local.price, priceRaw: local.priceRaw, negotiable: local.negotiable,
        oldPrice: local.oldPrice, date: local.date, image: local.image, category: local.category,
        description: '…', details: [], images: local.image ? [local.image] : [],
        seller: {}, href: local.href, id, interest: local.interest,
        interestSeries: local.interest != null ? [{ t: Date.now(), v: local.interest }] : [],
      }, state.mode);
    } else {
      $('mTitle').textContent = 'Загрузка…';
      $('mPrice').textContent = '—'; $('mOld').hidden = true; $('mDrop').hidden = true;
      $('mMeta').innerHTML = ''; $('mDesc').textContent = '…';
      $('mDetails').innerHTML = ''; $('mSeller').innerHTML = '';
      $('mBadges').innerHTML = ''; $('mChart').innerHTML = ''; $('mIChart').innerHTML = '';
      $('mImg').style.backgroundImage = '';
      $('mImg').innerHTML = '<span class="no-photo">Нет фото</span>';
    }

    // 2) догружаем полную карточку
    const p = new URLSearchParams({ href: href || '' });
    if (state.mode === 'demo') p.set('mode', 'demo');
    try {
      const r = await fetch('/api/ad/' + encodeURIComponent(id) + '?' + p);
      const j = await r.json();
      if (j.ad) renderAd(j.ad, j.mode);
      else if (!local) $('mTitle').textContent = 'Не удалось загрузить объявление';
    } catch (e) {
      if (!local) $('mTitle').textContent = 'Не удалось загрузить объявление';
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
    if (ad.interest != null) meta.push(['Просмотры', '~' + ad.interest + ' (оценка)']);
    if (ad.date) meta.push(['Дата', fmt.date(ad.date)]);
    if (ad.category) meta.push(['Категория', (ad.category || '') + (ad.subcategory ? ' › ' + ad.subcategory : '')]);
    if (ad.negotiable) meta.push(['Торг', 'возможен (VB)']);
    if (ad.id) meta.push(['ID', ad.id]);
    $('mMeta').innerHTML = meta.map(([k, v]) => '<li><b>' + esc(k) + ':</b> ' + esc(v) + '</li>').join('');

    const img = imgProxy(ad.images && ad.images[0] ? ad.images[0] : ad.image);
    if (img) { $('mImg').style.backgroundImage = 'url(' + img + ')'; $('mImg').innerHTML = ''; }

    if (ad.description && ad.description !== '…') $('mDesc').textContent = ad.description;
    $('mDetails').innerHTML = (ad.details || []).map(d => '<span><b>' + esc(d.label) + ':</b> ' + esc(d.value) + '</span>').join('');

    const s = ad.seller || {};
    const sBits = [];
    if (s.name) sBits.push('Продавец: <b>' + esc(s.name) + '</b>');
    else if (s.type) sBits.push('Продавец: <b>' + esc(s.type === 'Privater Nutzer' ? 'частное лицо' : s.type === 'Gewerblicher Nutzer' ? 'коммерческий' : s.type) + '</b>');
    if (s.initials) sBits.push('профиль: ' + esc(s.initials));
    if (s.activeSince) sBits.push('на Kleinanzeigen с ' + esc(s.activeSince));
    if (s.badges && s.badges.length) sBits.push('значки: ' + s.badges.join(', '));
    $('mSeller').innerHTML = sBits.length ? sBits.join(' · ') : 'Информация о продавце доступна на странице объявления.';

    drawChart(ad.tracked && ad.tracked.prices ? ad.tracked.prices : []);
    drawInterest(ad.interestSeries || []);
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

  function drawInterest(series) {
    const svg = $('mIChart');
    const note = $('mIChartNote');
    if (!series || series.length < 2) {
      svg.innerHTML = '<line x1="0" y1="80" x2="320" y2="80" stroke="#22304d" stroke-dasharray="4 6"/><text x="160" y="72" fill="#64779c" font-size="11" text-anchor="middle">нужно ≥2 срезов — обновите ленту позже</text>';
      note.textContent = 'Оценка интереса растёт по мере наблюдения за лотом. Просмотры/лайки Kleinanzeigen не публикует.';
      return;
    }
    const W = 320, H = 120, pad = 10;
    const vals = series.map(p => p.v);
    const min = Math.min(...vals) * 0.9, max = Math.max(...vals) * 1.05 || 1;
    const span = (max - min) || 1;
    const pts = series.map((p, i) => {
      const x = pad + (W - 2 * pad) * (i / (series.length - 1));
      const y = H - pad - (H - 2 * pad) * ((p.v - min) / span);
      return [x, y, p];
    });
    const line = pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const area = line + ` ${W - pad},${H - pad} ${pad},${H - pad}`;
    const circles = pts.map(p => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" fill="#4ade80"/>').join('');
    svg.innerHTML =
      '<polygon points="' + area + '" fill="rgba(74,222,128,.10)"/>' +
      '<polyline points="' + line + '" fill="none" stroke="#4ade80" stroke-width="2"/>' + circles;
    note.textContent = 'с ' + new Date(series[0].t).toLocaleDateString('ru-RU') + ': +' + series[0].v + ' → +' + series[series.length - 1].v;
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
  $('todayOnly').addEventListener('change', () => { state.page = 1; loadSearch(); });
  $('prevPage').addEventListener('click', () => { if (state.page > 1) { state.page--; loadSearch(); } });
  $('nextPage').addEventListener('click', () => { state.page++; loadSearch(); });
  $('modalX').addEventListener('click', closeAd);
  $('modalBack').addEventListener('click', e => { if (e.target === $('modalBack')) closeAd(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAd(); });

  $('autoRefresh').addEventListener('change', () => {
    state.autoRefresh = $('autoRefresh').checked;
    scheduleAuto();
  });

  // чипсы популярных запросов под строкой поиска
  (function renderChips() {
    const row = $('chipsRow');
    if (!row) return;
    row.innerHTML = POPULAR.filter(q => !q.startsWith('_')).map(chipHTML).join('');
    row.querySelectorAll('.chip').forEach(el => {
      el.addEventListener('click', () => { $('q').value = el.dataset.q; state.page = 1; loadSearch(); });
    });
  })();

  function scheduleAuto() {
    if (state.autoTimer) clearInterval(state.autoTimer);
    if (!state.autoRefresh) return;
    // каждые 3 минуты снимаем срез — так накапливается история цен
    state.autoTimer = setInterval(() => {
      if (state.mode !== 'demo') loadSearch({ force: true });
    }, 2 * 60 * 1000);
  }

  // вернулись на вкладку -> подтянуть свежий срез (не чаще раза в минуту)
  let lastVisibleRefresh = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastVisibleRefresh > 60000) {
      lastVisibleRefresh = Date.now();
      if (state.mode !== 'demo') loadSearch({ force: true });
    }
  });

  // ---------- старт ----------
  loadSearch();
  scheduleAuto();
  loadTrending();
})();
