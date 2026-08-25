/* Triton Parser — фронтенд: живая лента, прогрессивная загрузка, премиум-UI */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const POPULAR = ['iphone 15', 'laptop', 'e-bike', 'sofa', 'ps5', 'fahrrad', 'kopfhörer'];
  const SEEN_KEY = 'tp:seen';
  const FEED_KEY = 'tp:lastFeed';
  const POLL_MS = 75 * 1000;          // автоопрос ленты
  const SEEN_TTL = 3 * 24 * 3600e3;   // помним лоты 3 дня

  const state = {
    mode: null, gen: 0, nextPage: 2, listings: [],
    autoTimer: null, autoRefresh: true,
    lastFetchAt: null, initialLoadDone: false,
  };

  const fmt = {
    price(v) { return v == null ? '—' : v.toLocaleString('ru-RU') + ' €'; },
    date(d) {
      if (!d) return '';
      try { return new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); }
      catch (_) { return d; }
    },
    time(ts) { return ts ? new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—'; },
    timeSec(ts) { return ts ? new Date(ts).toLocaleTimeString('ru-RU') : '—'; },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function imgProxy(u) { return u ? '/api/img?u=' + encodeURIComponent(u) : null; }

  // ---------- память о виденных лотах ----------
  function loadSeen() {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY) || 'null') || null; } catch (_) { return null; }
  }
  function saveSeen(map) {
    try {
      const cut = Date.now() - SEEN_TTL;
      for (const k of Object.keys(map)) if (map[k] < cut) delete map[k];
      localStorage.setItem(SEEN_KEY, JSON.stringify(map));
    } catch (_) {}
  }
  function cacheFeed(j) {
    try { localStorage.setItem(FEED_KEY, JSON.stringify({ ts: Date.now(), j })); } catch (_) {}
  }
  function cachedFeed() {
    try { const s = localStorage.getItem(FEED_KEY); return s ? JSON.parse(s) : null; } catch (_) { return null; }
  }

  // ---------- баннеры / режим / тост ----------
  function setMode(mode, reason, notice) {
    state.mode = mode;
    const pill = $('modePill');
    pill.className = 'mode-pill ' + mode;
    pill.textContent = mode === 'live' ? 'Live · Kleinanzeigen' : mode === 'cached' ? 'Кэш · нет доступа' : 'Демо-режим';
    const b = $('banner');
    if (notice) { b.hidden = false; b.className = 'banner info'; b.textContent = notice; return; }
    if (mode === 'live') { b.hidden = true; }
    else if (mode === 'cached') {
      b.hidden = false; b.className = 'banner';
      b.textContent = 'Kleinanzeigen временно не отвечает — показан последний успешный срез. Попробуйте «↻ Свежий срез» через минуту.';
    } else {
      b.hidden = false; b.className = 'banner demo-banner';
      b.innerHTML = '<b>ДЕМО-РЕЖИМ:</b> ' + (reason
        ? 'Kleinanzeigen не отвечает с этого сервера (' + esc(reason) + '), поэтому ниже сгенерированные примеры. Интерфейс полностью рабочий.'
        : 'ниже сгенерированные примеры, а не реальные объявления. Интерфейс полностью рабочий.');
    }
  }

  function showToast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(showToast._h);
    showToast._h = setTimeout(() => t.classList.remove('show'), 5000);
  }

  function freshKey(l) {
    if (l.postedAt) return new Date(l.postedAt).toISOString();
    const t = (l.dateTxt || '').match(/(\d{1,2}):(\d{2})/);
    return (l.date || '0000-00-00') + ' ' + (t ? String(t[1]).padStart(2, '0') + t[2] : '');
  }

  // просмотры (оценка) — с фолбэком на старый кэш ленты, где поля views ещё не было
  const viewsOf = (l) => (l.views != null ? l.views : (l.interest || 0));
  const vpmTxt = (v) => (v == null ? '—' : String(Math.round(v * 10) / 10).replace('.', ','));
  function ageTxt(m) {
    if (m == null) return '—';
    if (m < 60) return m + ' мин';
    if (m < 1440) return Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин';
    return Math.floor(m / 1440) + ' д ' + Math.floor((m % 1440) / 60) + ' ч';
  }

  // ---------- параметры запроса ----------
  function buildParams({ page, depth, force, demo }) {
    const p = new URLSearchParams({
      q: $('q').value.trim() || 'angebote',
      page: String(page), depth: String(depth),
      force: force ? '1' : '0',
    });
    if ($('min').value) p.set('min', $('min').value);
    if ($('max').value) p.set('max', $('max').value);
    if ($('todayOnly').checked) p.set('today', '1');
    if ($('noShops') && !$('noShops').checked) p.set('all', '1');
    const catSel = $('cat');
    if (catSel && catSel.value && catSel.value !== '0') p.set('cat', catSel.value);
    if (demo) p.set('mode', 'demo');
    return p;
  }

  // ---------- скелетоны ----------
  function renderSkeleton(n) {
    let s = '';
    for (let i = 0; i < n; i++) {
      s += '<div class="skel"><div class="skel-media"></div><div class="skel-body"><div class="skel-line w80"></div><div class="skel-line w60"></div><div class="skel-line w40"></div></div></div>';
    }
    return s;
  }

  // ---------- главный поиск ----------
  async function loadSearch({ force = false, demo = false, fromAuto = false } = {}) {
    const my = ++state.gen;
    const grid = $('feedGrid');
    const q = ($('q').value.trim() || 'angebote');

    if (!fromAuto && !force && !demo) {
      const cached = cachedFeed();
      if (cached && Date.now() - cached.ts < 20 * 60e3) {
        state.listings = cached.j.listings || [];
        state.mode = cached.j.mode;
        setMode(cached.j.mode, null, 'Показан последний срез (' + fmt.time(cached.ts) + ') — обновляем…');
        renderFeed({ silent: true });
      } else {
        grid.innerHTML = renderSkeleton(8);
        $('feedEmpty').hidden = true;
      }
    } else if (fromAuto) {
      // тихое обновление — скелетоны не показываем, лента остаётся на месте
    } else {
      grid.innerHTML = renderSkeleton(8);
      $('feedEmpty').hidden = true;
    }

    try {
      const r = await fetch('/api/search?' + buildParams({ page: 1, depth: 1, force, demo }));
      if (my !== state.gen) return;
      const j = await r.json();
      const fresh = j.listings || [];

      // мгновенный первый срез; если до этого показали кэш (в нём лотов больше) — не даём ленте "сжаться"
      if (!fromAuto && state.listings.length > fresh.length && state.mode !== 'demo') {
        const freshIds = new Set(fresh.map(l => l.id));
        const keepOld = state.listings.filter(l => !freshIds.has(l.id)).slice(0, 200);
        state.listings = fresh.concat(keepOld);
      } else {
        state.listings = fresh;
      }
      if (demo) setMode('demo', null, j.notice || null);
      else setMode(j.mode, j.fallbackReason, j.notice);
      state.lastFetchAt = Date.now();
      $('lastSnap').textContent = fmt.time(state.lastFetchAt);
      renderFeed({ silent: !state.initialLoadDone, fromAuto });
      cacheFeed({ ...j, listings: state.listings });
      state.initialLoadDone = true;
      updateStats(j, q);
      loadTrending();
      state.nextPage = 2;
      updateMoreBtn(fresh.length >= 10 && j.hasMore !== false);
      // фоновая догрузка глубины ленты (страницы 2-3) — лента сама вырастает до ~80 лотов
      if (!demo && state.mode !== 'demo') setTimeout(() => deepen(my), 150);
    } catch (e) {
      if (!grid.children.length || grid.querySelector('.skel')) {
        grid.innerHTML = '';
        $('feedEmpty').hidden = false;
        $('feedEmpty').textContent = 'Ошибка загрузки: ' + e.message;
      }
    }
  }

  async function deepen(my) {
    try {
      const r = await fetch('/api/search?' + buildParams({ page: 2, depth: 2 }));
      if (my !== state.gen) return;
      const j = await r.json();
      appendListings(j, { silent: true });
      state.nextPage = 4;
      updateMoreBtn((j.listings || []).length >= 10);
    } catch (_) { /* тихо */ }
  }

  function appendListings(j, { silent = false } = {}) {
    const fresh = j.listings || [];
    const seen = new Set(state.listings.map(l => l.id));
    const add = fresh.filter(l => !seen.has(l.id));
    state.listings = state.listings.concat(add).slice(0, 260);
    renderFeed({ silent: true });
    if (!silent && add.length) showToast('🆕 +' + add.length + ' объявлений');
    updateMoreBtn(fresh.length >= 10);
  }

  function updateMoreBtn(canMore) {
    $('pager').hidden = !canMore || state.mode === 'demo' || state.listings.length >= 260;
    $('moreBtn').textContent = 'Показать ещё ↓ (уже ' + state.listings.length + ')';
  }

  function updateStats(j, q) {
    const eff = j.query && j.query.effective;
    const today = $('todayOnly').checked;
    const noShops = j.query && j.query.noShops;
    const catName = j.query && j.query.catName;
    const baseLabel = (q === 'angebote')
      ? (today ? '🆕 свежие объявления · за сегодня' : 'все объявления Kleinanzeigen')
      : 'запрос: «' + (eff || q) + '»' + (eff && eff !== q ? ' (по вашему «' + q + '»)' : '');
    $('feedQuery').textContent = baseLabel
      + (catName ? ' · ' + catName : '')
      + (noShops ? ' · только частные лица' : ' · включая магазины');
    const st = [];
    if (j.newToday) st.push('новых сегодня: ' + j.newToday);
    if (j.droppedTop) st.push('скрыто TOP: ' + j.droppedTop);
    if (j.total) st.push('всего на Kleinanzeigen: ' + j.total.toLocaleString('ru-RU'));
    st.push('<span class="dot-live"><i></i> обновлено ' + fmt.timeSec(Date.now()) + '</span>');
    $('feedStats').innerHTML = st.join(' · ');
    loadStatus();
  }

  // ---------- сортировка и отрисовка ----------
  function sortListings(list) {
    const s = $('sort').value;
    const by = {
      new: (a, b) => freshKey(b).localeCompare(freshKey(a)),
      hot: (a, b) => ((b.isHot ? 1 : 0) - (a.isHot ? 1 : 0)) || ((b.vpm || 0) - (a.vpm || 0)) || ((b.hot || 0) - (a.hot || 0)),
      cheap: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
      expensive: (a, b) => (b.price ?? -1) - (a.price ?? -1),
      drop: (a, b) => (b.priceDrop || 0) - (a.priceDrop || 0),
    }[s] || (() => 0);
    return list.slice().sort(by);
  }

  function renderFeed({ silent = false, fromAuto = false } = {}) {
    const grid = $('feedGrid');
    let list = sortListings(state.listings);
    if ($('hotOnly').checked) list = list.filter(l => l.isHot === true || (l.isHot == null && (l.hot || 0) >= 25));

    const seenMap = loadSeen() || {};
    const hadBaseline = Object.keys(seenMap).length > 0;
    let newCount = 0;
    const marked = list.map(l => {
      const isNew = hadBaseline && !seenMap[l.id] && !l._demo;
      if (isNew) newCount++;
      return Object.assign({}, l, { _isNew: isNew });
    });

    $('feedCount').textContent = list.length ? '· ' + list.length : '';
    grid.innerHTML = marked.length ? marked.map(cardHTML).join('') : '';

    const empty = $('feedEmpty');
    empty.hidden = marked.length > 0;
    if (!marked.length) {
      empty.innerHTML = state.mode === 'demo'
        ? 'Пусто. Измените запрос.'
        : ($('hotOnly').checked
          ? 'Под правило «горячих» (возраст 20 минут – 4 часа и ≥ 0,5 просмотра в минуту) сейчас ничего не попало.<br><span class="muted">снимите галочку «только „горячие“» или подождите — лента обновляется автоматически</span>'
          : ($('todayOnly').checked
          ? 'Сегодня по этому запросу ещё ничего не разместили.<br><span class="muted">снимите галочку «только размещённые сегодня» — увидите все объявления</span>'
          : 'Ничего не нашлось. Попробуйте запрос латиницей (немецкий/английский):<div class="chips">' + POPULAR.slice(0, 6).map(chipHTML).join('') + '</div>'));
      empty.querySelectorAll('.chip').forEach(el => {
        el.addEventListener('click', () => { $('q').value = el.dataset.q; state.page = 1; loadSearch(); });
      });
    }
    grid.querySelectorAll('.card').forEach(el => {
      el.addEventListener('click', () => openAd(el.dataset.id, el.dataset.href));
    });

    const updated = Object.assign({}, seenMap);
    for (const l of list) updated[l.id] = Date.now();
    saveSeen(updated);

    if (!silent && !fromAuto && newCount > 0) showToast('🆕 Появилось новых объявлений: ' + newCount);
    if (fromAuto && newCount > 0) showToast('🆕 +' + newCount + ' новых объявлений');
  }

  function chipHTML(q) { return '<button class="chip" data-q="' + esc(q) + '">' + esc(q) + '</button>'; }

  function cardHTML(l) {
    const img = imgProxy(l.image);
    const badges = [];
    if (l._isNew) badges.push('<span class="badge new">Новое</span>');
    if (state.mode === 'demo') badges.push('<span class="badge drop">Демо</span>');
    if (l.isHot) badges.push('<span class="badge hot" title="возраст 20 мин–4 ч и ≥ 0,5 просмотра/мин">🔥 ' + vpmTxt(l.vpm) + '/мин</span>');
    if (l.isTop) badges.push('<span class="badge top">Top</span>');
    if (l.priceDrop) badges.push('<span class="badge drop">−' + l.priceDropPct + '%</span>');
    const tags = (l.tags || []).map(t => '<span class="tag">' + esc({ direkt: 'Direkt kaufen', versand: 'Versand', garantie: 'Garantie' }[t] || t) + '</span>').join('');
    const priceTxt = fmt.price(l.price) + (l.negotiable ? ' VB' : '');
    return (
      '<article class="card' + (l._isNew ? ' card-new' : '') + '" data-id="' + esc(l.id) + '" data-href="' + esc(l.href || '') + '">' +
      '<div class="c-media" style="' + (img ? 'background-image:url(' + img + ')' : '') + '">' +
        (!img ? '<span class="no-photo">Нет фото</span>' : '') +
        '<div class="c-badges">' + badges.join('') + '</div>' +
        (l.imgCount > 1 ? '<span class="c-count">📷 ' + l.imgCount + '</span>' : '') +
      '</div>' +
      '<div class="c-body">' +
        '<div class="c-title">' + esc(l.title) + '</div>' +
        '<div class="c-meta"><span>' + esc(l.category || 'Kleinanzeigen') + '</span><span class="c-sep">·</span><b>' + priceTxt + '</b>' +
          (l.oldPrice ? ' <s class="c-old">' + fmt.price(l.oldPrice) + '</s>' : '') + '</div>' +
        '<div class="c-growth"><span class="g-plus">≈ ' + viewsOf(l) + '</span><span class="g-lbl">просмотров · оценка</span></div>' +
        '<div class="c-foot"><span class="c-loc">' + (l.location ? '📍 ' + esc(l.location) : '') + '</span><span>' + esc(l.dateTxt || fmt.date(l.date) || '') + '</span></div>' +
        (tags ? '<div class="c-tags">' + tags + '</div>' : '') +
      '</div></article>'
    );
  }

  // ---------- тренды ----------
  async function loadTrending() {
    try {
      const r = await fetch('/api/trending?limit=12');
      const j = await r.json();
      const items = j.items || [];
      $('trendStrip').innerHTML = items.length ? items.map(t => (
        '<div class="trend-card" data-id="' + esc(t.id) + '" data-href="' + esc(t.href || '') + '">' +
          '<div class="t-score">≈ ' + viewsOf(t) + '<small>просм.</small></div>' +
          '<div class="t-name"><b>' + esc(t.title) + '</b><span>' + esc(t.category || 'KL') + ' · ' + fmt.price(t.price) + (t.location ? ' · ' + esc(t.location) : '') + '</span></div>' +
          (t.priceDrop ? '<div class="t-up">−' + t.priceDropPct + '%</div>' : '') +
        '</div>'
      )).join('') : '<div class="empty">Пока мало истории: сделайте пару срезов — и здесь появятся лоты с динамикой.</div>';
      document.querySelectorAll('.trend-card').forEach(el => {
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
  function findLocal(id) { return state.listings.find(l => String(l.id) === String(id)) || null; }

  async function openAd(id, href) {
    if (!id) return;
    const back = $('modalBack');
    back.hidden = false;
    document.body.style.overflow = 'hidden';
    $('mOpen').href = href ? 'https://www.kleinanzeigen.de' + href : '#';

    const local = findLocal(id);
    if (local) {
      renderAd({
        title: local.title,
        price: local.price, priceRaw: local.priceRaw, negotiable: local.negotiable,
        oldPrice: local.oldPrice, date: local.date, image: local.image, category: local.category,
        description: '…', details: [], images: local.image ? [local.image] : [],
        seller: {}, href: local.href, id, interest: local.interest,
        views: local.views, vpm: local.vpm, isHot: local.isHot, ageMin: local.ageMin, postedAt: local.postedAt,
        viewsSeries: local.views != null ? [{ t: Date.now(), v: local.views }]
          : (local.interest != null ? [{ t: Date.now(), v: local.interest }] : []),
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
    if (mode === 'demo') badges.push('<span class="badge drop">Демо</span>');
    if (ad.isHot) badges.push('<span class="badge hot" title="возраст 20 мин–4 ч и ≥ 0,5 просмотра/мин">🔥 ' + vpmTxt(ad.vpm) + '/мин</span>');
    if (ad.sold) badges.push('<span class="badge top">Продано</span>');
    $('mBadges').innerHTML = badges.join('');

    const meta = [];
    if (ad.views != null) meta.push(['Просмотры', '≈ ' + ad.views + ' (оценка)']);
    else if (ad.interest != null) meta.push(['Просмотры', '≈ ' + ad.interest + ' (оценка)']);
    if (ad.vpm != null) meta.push(['Скорость', vpmTxt(ad.vpm) + ' просм./мин (оценка)']);
    if (ad.ageMin != null) meta.push(['Возраст', ageTxt(ad.ageMin)]);
    if (ad.isHot) meta.push(['Горячий', 'да — 20 мин–4 ч и ≥ 0,5 просм./мин']);
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
    drawViews(ad.viewsSeries || ad.interestSeries || []);
    $('mOpen').href = ad.href ? 'https://www.kleinanzeigen.de' + ad.href : '#';
  }

  function drawChart(prices) {
    const svg = $('mChart');
    const note = $('mChartNote');
    if (!prices || prices.length < 2) {
      svg.innerHTML = '<line x1="0" y1="60" x2="320" y2="60" stroke="rgba(255,255,255,.09)" stroke-dasharray="4 6"/><text x="160" y="52" fill="#6b6355" font-size="11" text-anchor="middle">нужно ≥2 срезов — обновите ленту позже</text>';
      note.textContent = 'График строится по срезам нашего сервера.';
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
    const circles = pts.map(p => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" fill="#d6b27c"/>').join('');
    svg.innerHTML =
      '<polygon points="' + area + '" fill="rgba(214,178,124,.10)"/>' +
      '<polyline points="' + line + '" fill="none" stroke="#d6b27c" stroke-width="2"/>' + circles;
    const first = pts[0][2], last = pts[pts.length - 1][2];
    const drop = last.price < first.price ? '−' + Math.round((1 - last.price / first.price) * 100) + '%' : (last.price > first.price ? '+' + Math.round((last.price / first.price - 1) * 100) + '%' : 'без изменений');
    note.textContent = new Date(first.t).toLocaleDateString('ru-RU') + ' → ' + new Date(last.t).toLocaleDateString('ru-RU') + ' · ' + drop;
  }

  function drawViews(series) {
    const svg = $('mIChart');
    const note = $('mIChartNote');
    if (!series || series.length < 2) {
      svg.innerHTML = '<line x1="0" y1="80" x2="320" y2="80" stroke="rgba(255,255,255,.09)" stroke-dasharray="4 6"/><text x="160" y="72" fill="#6b6355" font-size="11" text-anchor="middle">нужно ≥2 срезов</text>';
      note.textContent = 'Просмотры — оценка: скорость (просм./мин) × возраст лота. Точные просмотры Kleinanzeigen не публикует.';
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
    const circles = pts.map(p => '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3" fill="#8fd6a8"/>').join('');
    svg.innerHTML =
      '<polygon points="' + area + '" fill="rgba(143,214,168,.09)"/>' +
      '<polyline points="' + line + '" fill="none" stroke="#8fd6a8" stroke-width="2"/>' + circles;
    note.textContent = 'с ' + new Date(series[0].t).toLocaleDateString('ru-RU') + ': ≈' + series[0].v + ' → ≈' + series[series.length - 1].v + ' просмотров';
  }

  function closeAd() {
    $('modalBack').hidden = true;
    document.body.style.overflow = '';
  }

  // ---------- события ----------
  $('searchForm').addEventListener('submit', e => { e.preventDefault(); loadSearch(); });
  $('btnRefresh').addEventListener('click', () => loadSearch({ force: true }));
  $('btnDemo').addEventListener('click', () => { loadSearch({ demo: true }); });
  $('btnStart').addEventListener('click', () => { document.getElementById('feed').scrollIntoView({ behavior: 'smooth' }); });
  $('sort').addEventListener('change', () => renderFeed({ silent: true }));
  $('hotOnly').addEventListener('change', () => renderFeed({ silent: true }));
  $('todayOnly').addEventListener('change', () => loadSearch());
  $('noShops').addEventListener('change', () => loadSearch());
  $('cat').addEventListener('change', () => loadSearch());
  $('moreBtn').addEventListener('click', () => {
    const my = state.gen;
    $('moreBtn').textContent = 'Загружаем ещё…';
    fetch('/api/search?' + buildParams({ page: state.nextPage, depth: 3 }))
      .then(r => r.json())
      .then(j => {
        if (my !== state.gen) return;
        appendListings(j);
        state.nextPage += 3;
      })
      .catch(() => { $('moreBtn').textContent = 'Показать ещё ↓'; });
  });
  $('modalX').addEventListener('click', closeAd);
  $('modalBack').addEventListener('click', e => { if (e.target === $('modalBack')) closeAd(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAd(); });

  $('autoRefresh').addEventListener('change', () => {
    state.autoRefresh = $('autoRefresh').checked;
    scheduleAuto();
  });

  (function renderChips() {
    const row = $('chipsRow');
    if (!row) return;
    row.innerHTML = POPULAR.map(chipHTML).join('');
    row.querySelectorAll('.chip').forEach(el => {
      el.addEventListener('click', () => { $('q').value = el.dataset.q; loadSearch(); });
    });
  })();

  function scheduleAuto() {
    if (state.autoTimer) clearInterval(state.autoTimer);
    if (!state.autoRefresh) return;
    state.autoTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && state.mode !== 'demo') {
        loadSearch({ fromAuto: true });
      }
    }, POLL_MS);
  }

  let lastVisibleRefresh = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastVisibleRefresh > 60000) {
      lastVisibleRefresh = Date.now();
      if (state.mode !== 'demo') loadSearch({ fromAuto: true });
    }
  });

  // ---------- старт ----------
  loadSearch();
  scheduleAuto();
  loadTrending();
})();
