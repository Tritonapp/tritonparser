/**
 * Парсеры HTML Kleinanzeigen (два серверных шаблона: классический .aditem и новый flex-шаблон).
 * Извлекаем только публичные данные: заголовок, цена, фото, город, дата, теги, детали, описание.
 */
'use strict';

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(s) {
  return decode(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
}

/** "1.200 € VB" -> { price: 1200, negotiable: true } */
function parsePrice(raw) {
  const s = decode(raw);
  if (!s || /kostenlos|zu verschenken/i.test(s)) return { price: 0, negotiable: false, raw: s || null };
  const m = s.match(/([\d][\d.,]*)\s*€/);
  if (!m) return { price: null, negotiable: /VB/i.test(s), raw: s || null };
  let num = m[1].replace(/\./g, '').replace(/,/g, '.');
  num = parseFloat(num);
  if (Number.isNaN(num)) num = null;
  return { price: num, negotiable: /VB/i.test(s), raw: s };
}

/** "Heute, 16:43" | "Gestern" | "11.08.2026" -> ISO date (без времени) */
function parseKaDate(s, now = new Date()) {
  const t = decode(s);
  const d = new Date(now);
  if (/^heute/i.test(t)) {
    return d.toISOString().slice(0, 10);
  }
  if (/^gestern/i.test(t)) {
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  const m = t.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const ago = t.match(/vor\s+(\d+)\s+(tag|stunde|min)/i);
  if (ago) {
    const n = parseInt(ago[1], 10);
    if (/tag/i.test(ago[2])) d.setDate(d.getDate() - n);
    else if (/stunde/i.test(ago[2])) d.setHours(d.getHours() - n);
    else d.setMinutes(d.getMinutes() - n);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function imgToSize(u, rule) {
  if (!u) return null;
  return u.replace(/rule=\$?_?\d+\.?\w*(\.AUTO)?/i, 'rule=$_' + rule + '.AUTO');
}

/** Разбить HTML выдачи на блоки <article> с data-adid */
function splitArticles(html) {
  const out = [];
  const re = /<article\b[^>]*\bdata-adid="(\d+)"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = m.index;
    const end = html.indexOf('</article>', start);
    const block = html.slice(start, end > 0 ? end : start + 12000);
    const hrefM = block.match(/data-href="([^"]+)"/);
    out.push({ id: m[1], href: hrefM ? hrefM[1] : null, block });
  }
  return out;
}

/** Парсинг страницы поиска -> массив объявлений */
function parseSearch(html) {
  const arts = splitArticles(html);
  const listings = [];
  for (const a of arts) {
    const b = a.block;
    // ld+json с заголовком/описанием/картинкой есть в обоих шаблонах
    let ldTitle = null, ldDesc = null, ldImg = null;
    const ld = b.match(/<script type="application\/ld\+json">\s*({[\s\S]*?})\s*<\/script>/);
    if (ld) {
      try {
        const j = JSON.parse(ld[1]);
        ldTitle = j.title || null;
        ldDesc = j.description || null;
        ldImg = j.contentUrl || null;
      } catch (_) { /* ignore */ }
    }

    // заголовок
    let title = ldTitle;
    if (!title) {
      const t = b.match(/class="ellipsis"[^>]*>([^<]+)</) || b.match(/<h[23][^>]*>\s*<a[^>]*>([^<]+)<\/a>/);
      title = t ? decode(t[1]) : 'Без названия';
    }

    // цена: сначала точные классы, потом первый "€" в блоке
    let priceRaw = null, oldPriceRaw = null;
    let pm = b.match(/price-shipping--price">\s*([^<]+)</) ||
             b.match(/font-strong text-secondary">\s*([^<]+)</) ||
             b.match(/([\d.,]+\s*€\s*(?:VB)?)\s*<\/p>/);
    if (pm) priceRaw = pm[1];
    const om = b.match(/--old-price">\s*([^<]+)</) || b.match(/line-through">([^<]+)</);
    if (om) oldPriceRaw = om[1];
    if (!priceRaw) {
      const first = b.match(/(\d[\d.,]*)\s*€/);
      if (first) priceRaw = first[0];
    }

    // город
    let location = null;
    const loc1 = b.match(/aditem-main--top--left">\s*(?:<i[^>]*>\s*<\/i>\s*)?([^<]+)</);
    if (loc1) location = decode(loc1[1]);
    if (!location) {
      const loc2 = b.match(/locationOutline[\s\S]{0,600}?<span>([^<]+)<\/span>/);
      if (loc2) location = decode(loc2[1]);
    }
    if (!location) {
      const alt = b.match(/alt="[^"]*?\s([^-]+-[^-"]+?)\s+Vorschau"/);
      if (alt) location = decode(alt[1]);
    }

    // дата
    let dateTxt = null;
    const dm = b.match(/(Heute|Gestern|\d{2}\.\d{2}\.\d{4})\s*,?\s*(?:\d{1,2}:\d{2})?/i);
    if (dm) dateTxt = dm[0].trim();

    // фото
    let image = ldImg;
    if (!image) {
      const im = b.match(/src="(https:\/\/img\.kleinanzeigen\.de\/[^"]+)"/);
      if (im) image = im[1];
    }
    if (image) image = imgToSize(image, 35);

    // число фото
    let imgCount = 0;
    const gc = b.match(/galleryimage--counter">\s*(\d+)/);
    if (gc) imgCount = parseInt(gc[1], 10);
    else if (image) imgCount = 1;

    // теги
    const tags = [];
    if (/Direkt kaufen/i.test(b)) tags.push('direkt');
    if (/Versand möglich|versand/i.test(b)) tags.push('versand');
    if (/Verkäufergarantie/i.test(b)) tags.push('garantie');
    const isTop = /badge-topad|is-topad/.test(b);

    const pr = parsePrice(priceRaw);
    const opr = oldPriceRaw ? parsePrice(oldPriceRaw) : { price: null };

    listings.push({
      id: a.id,
      href: a.href,
      title,
      description: ldDesc ? decode(ldDesc) : null,
      price: pr.price,
      negotiable: pr.negotiable,
      priceRaw: pr.raw,
      oldPrice: opr.price || null,
      location,
      dateTxt,
      date: parseKaDate(dateTxt || ''),
      image,
      imgCount,
      tags,
      isTop,
    });
  }
  return listings;
}

/** Парсинг страницы объявления */
function parseDetail(html) {
  const grab = (re) => {
    const m = html.match(re);
    return m ? decode(m[1]) : null;
  };
  const title = grab(/id="viewad-title"[^>]*>([^<]+)</);
  const priceRaw = grab(/id="viewad-price"[^>]*>([^<]+)</);
  const pr = parsePrice(priceRaw);

  let date = null;
  const ex = html.match(/id="viewad-extra-info"[\s\S]{0,400}?<span>([^<]+)<\/span>/);
  if (ex) date = parseKaDate(decode(ex[1]));

  let description = null;
  const dm = html.match(/id="viewad-description-text"[^>]*>([\s\S]*?)<\/div>/);
  if (dm) description = stripTags(dm[1]);

  const details = [];
  const dr = /class="addetailslist--detail">\s*([^<]+)<span[^>]*>\s*([^<]*)</g;
  let m;
  while ((m = dr.exec(html)) !== null) {
    const label = decode(m[1]);
    const value = decode(m[2]);
    if (label && value) details.push({ label, value });
  }

  const images = [];
  const ir = /(?:src|data-imgsrc)="(https:\/\/img\.kleinanzeigen\.de\/api\/v1\/prod-ads\/images\/[^"]+)"/g;
  while ((m = ir.exec(html)) !== null) {
    const u = imgToSize(m[1], 35);
    if (!images.includes(u)) images.push(u);
  }

  const seller = {};
  const badge = html.match(/user-profile-vip-badge">([^<]+)</);
  if (badge) seller.initials = decode(badge[1]);
  const stype = html.match(/>(Privater Nutzer|Gewerblicher Nutzer|Gewerblicher Händler)</);
  if (stype) seller.type = decode(stype[1]);
  const activeSince = html.match(/Aktiv seit\s*(\d{1,2}\.\d{2}\.\d{4})/);
  if (activeSince) seller.activeSince = activeSince[1];
  const sname = html.match(/id="viewad-contact"[\s\S]{0,600}?class="[^"]*text-body-regular-strong[^"]*"[^>]*>([^<]{2,40})</);
  if (sname) seller.name = decode(sname[1]);
  seller.badges = [];
  if (/userbadges-profile-friendliness/.test(html)) seller.badges.push('freundlich');
  if (/superuser/.test(html)) seller.badges.push('top-nutzer');
  if (/user-profile-vip/.test(html)) seller.badges.push('vip');

  // категория из breadcrumbs: Kleinanzeigen > Elektronik > Handy & Telefon
  let category = null, subcategory = null;
  const bi = html.indexOf('class="breadcrump"');
  if (bi > 0) {
    const crumbs = [];
    const cr = /itemprop="name">([^<]+)</g;
    let cm;
    const seg = html.slice(bi, bi + 1600);
    while ((cm = cr.exec(seg)) !== null) crumbs.push(decode(cm[1]));
    const cats = crumbs.filter(c => c && !/^Kleinanzeigen\s*$/i.test(c) && !/^Kleinanzeigen\s+\w/i.test(c));
    if (cats.length) { category = cats[0]; subcategory = cats[1] || null; }
  }

  const sold = /Verkauft|data-soldlabel/.test(html) && /statusquot--sold|is-sold|badge--sold/.test(html);

  return {
    title, price: pr.price, priceRaw: pr.raw, negotiable: pr.negotiable,
    date, description, details, images, seller, sold, category, subcategory,
  };
}

/** Сколько всего результатов нашёл Kleinanzeigen ("16.411 Ergebnisse") */
function parseTotal(html) {
  const m = html.match(/([\d.,]+)\s*Ergebnisse/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/[.,]/g, ''), 10);
  return isNaN(n) ? null : n;
}

module.exports = { parseSearch, parseDetail, parsePrice, parseKaDate, decode, parseTotal };
