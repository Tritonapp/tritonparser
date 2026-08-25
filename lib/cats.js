/**
 * Определение категории Kleinanzeigen по заголовку объявления.
 * В выдаче поиска категории нет (только на страницах лотов),
 * поэтому для карточек ленты используем словарь ключевых слов.
 */
'use strict';

const RULES = [
  ['Audio & Hifi', /\b(kopfh[öo]rer|lautsprecher|verst[äa]rker|sonos|bose|jbl|marantz|technics|wh-1000|hifi|airpods|boxen|turntable|plattenspieler)\b/i],
  ['Elektronik', /\b(iphone|ipad|macbook|imac|samsung|galaxy|smartphone|handy|laptop|notebook|thinkpad|playstation|ps\d|xbox|nintendo|switch|monitor|fernseher|tv\b|kamera|drone|drohne|grafikkarte|rtx|gtx|mainboard|pc\b|computer|airtag|watch|uawei|pixel)\b/i],
  ['Fahrräder', /\b(fahrrad|e-bike|ebike|cube|canyon|ghost|rose|bmx|mtb|rennrad|pedelec|trekkingbike|mountainbike|v[ée]lo)\b/i],
  ['Möbel', /\b(sofa|couch|tisch|stuhl|schrank|regal|bett|matratze|sessel|kommode|sideboard|pax|kleiderschrank|esstisch|schreibtisch|ohrensessel|wohnwand)\b/i],
  ['Haushalt', /\b(waschmaschine|k[üu]hlschrank|geschirrsp[üu]ler|sp[üu]lmaschine|thermomix|dyson|nespresso|mixer|staubsauger|herd|backofen|wasserkocher|kaffeemaschine|mikrowelle|trockner)\b/i],
  ['Sport', /\b(fitness|hantel|laufband|snowboard|ski\b|skier|kayak|paddel|boxhandschuhe|lahm?aways?|joggen|sport|yoga|ruderger[äa]t)\b/i],
  ['Kleidung', /\b(jacke|schuhe|sneaker|nike|adidas|anzug|hose|kleid|puma|winterstiefel|lederjacke|hoodie|pullover)\b/i],
  ['Kinder & Baby', /\b(kinderwagen|hochstuhl|laufrad|lego|spielzeug|babybett|puky|la SIERRA|kleinkind|baby)\b/i],
  ['Garten', /\b(rasenm[äa]her|gartentisch|grill|hochdruckreiniger|schlauch|plantschbeet|gartenzwerg|sauna|pool)\b/i],
  ['Auto & Motorrad', /\b(reifen|winterreifen|sommerreifen|dachbox|kindersitz|autoradio|anh[äa]nger|motorrad|helikopter|ölbrenner|winterpakete?)\b/i],
  ['Immobilien', /\b(wohnung|haus|miet|appartement|ferienhaus|wg\b|zimmer)\b/i],
  ['Dienstleistungen', /\b(reparatur|service|anfertigung|beschriftung|reinigung|umzug|handwerk|schlussel|schl[üu]sseldienst)\b/i],
];

function categorize(title, q) {
  const t = String(title || '');
  for (const [cat, re] of RULES) {
    if (re.test(t)) return cat;
  }
  if (/^angebote$/i.test(String(q || '').trim())) return 'Kleinanzeigen';
  const w = String(q || '').trim().split(/\s+/)[0] || '';
  if (w && w.length > 2) {
    const s = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    return s + ' (поиск)';
  }
  return 'Diverses';
}

module.exports = { categorize };
