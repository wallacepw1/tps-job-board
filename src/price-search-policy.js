'use strict';
// Supplier and match rules for the TPS Assistant price search.
// Read only: nothing here places an order or records installer approval.

const SUPPLIERS = [
  { id: 'hirsch', name: 'Hirsch' },
  { id: 'reece_us', name: 'Reece US' },
  { id: 'homedepot', name: 'Home Depot' },
  { id: 'lowes', name: "Lowe's" },
  { id: 'supplyhouse', name: 'SupplyHouse' },
  { id: 'masterbuildermercantile', name: 'MBM' },
  { id: 'winsupply', name: 'WinSupply' },
];
const HEATER_EXCLUDED = ['supplyhouse', 'masterbuildermercantile'];
const ACCOUNT_PRICE_SUPPLIERS = ['winsupply', 'supplyhouse', 'masterbuildermercantile'];
const WINSUPPLY_COMPANY = 'WinSupply of South San Diego (National City)';
const BRAND_ORDER = [
  [/a\.?\s*o\.?\s*smith|\baos\b/i, 0],
  [/bradford/i, 1],
  [/rheem/i, 2],
];

function supplierIdsFor(category) {
  const excluded = category === 'heater' ? new Set(HEATER_EXCLUDED) : new Set();
  return SUPPLIERS.filter(s => !excluded.has(s.id)).map(s => s.id);
}

function supplierName(id) {
  const key = String(id || '').trim().toLowerCase().replace(/['’]/g, '');
  const aliases = {
    hirsch: 'hirsch',
    reece: 'reece_us',
    reeceus: 'reece_us',
    reece_us: 'reece_us',
    'home depot': 'homedepot',
    homedepot: 'homedepot',
    hd: 'homedepot',
    lowes: 'lowes',
    supplyhouse: 'supplyhouse',
    'supply house': 'supplyhouse',
    mbm: 'masterbuildermercantile',
    masterbuildermercantile: 'masterbuildermercantile',
    'master builder mercantile': 'masterbuildermercantile',
    winsupply: 'winsupply',
    'win supply': 'winsupply',
  };
  const canonical = aliases[key.replace(/\s+/g, ' ')] || aliases[key.replace(/\s+/g, '')] || null;
  return SUPPLIERS.find(s => s.id === canonical) || null;
}

function looksLikeHeater(text) {
  const t = String(text || '');
  if (/water\s*heater|\btankless\b|\bhot water tank\b|\bwater tank\b/i.test(t)) return true;
  return /\b(?:gal|gallon)s?\b/i.test(t) && /\b(?:btu|natural gas|propane|\blp\b|electric|heat pump|commercial)\b/i.test(t);
}

function effectiveCategory(input) {
  const hint = input.categoryHint || '';
  if (hint === 'heater' || hint === 'water_heater') return 'heater';
  if (hint === 'backflow' || hint === 'backflow_preventer') return 'backflow';
  const text = [input.modelHint, input.partNumber, input.description].filter(Boolean).join(' ');
  if (looksLikeHeater(text)) return 'heater';
  if (hint === 'general') return 'general';
  if (/\bbackflow\b|\brpz\b|\bpvb\b|\bdcva\b/i.test(text)) return 'backflow';
  return 'general';
}

function num(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function specsFromText(text) {
  const t = String(text || '');
  const gallons = /(\d{2,3}(?:\.\d)?)\s*-?\s*gal(?:lon)?s?\b/i.exec(t);
  const kw = /(\d{1,2}(?:\.\d)?)\s*kW\b/i.exec(t);
  const btu = /(\d{2,3}(?:,\d{3})+|\d{4,6})\s*BTU/i.exec(t);
  const k = /(\d{2,3})\s*k(?!\s*W|\s*w)\b/i.exec(t);
  let fuel = null;
  const electric = /\belectric\b/i.test(t) || Boolean(kw);
  const heatPump = /heat\s*pump/i.test(t);
  const lp = /\bpropane\b|\blp\b/i.test(t);
  const ng = /natural\s*gas|\bng\b/i.test(t) || (/\bgas\b/i.test(t) && !lp);
  const fuelHits = [electric && 'electric', heatPump && 'heat_pump', lp && 'lp', ng && 'natural_gas'].filter(Boolean);
  if (fuelHits.length === 1) fuel = fuelHits[0];
  const material = /\bpvc\b/i.test(t) && !/metal|not\s*pvc/i.test(t) ? 'pvc' : /metal|not\s*pvc/i.test(t) ? 'metal' : null;
  let vent = null;
  if (material === 'pvc') vent = 'pvc';
  else if (/power\s*vent/i.test(t)) vent = 'power';
  else if (/direct\s*vent/i.test(t)) vent = 'direct';
  else if (/atmospheric/i.test(t)) vent = 'atmospheric';
  let emissions = null;
  if (/ultra[-\s]*low[-\s]*nox/i.test(t)) emissions = 'ultra_low_nox';
  else if (/low[-\s]*nox/i.test(t)) emissions = 'low_nox';
  return {
    gallons: gallons ? num(gallons[1]) : null,
    btuh: btu ? num(btu[1]) : k ? num(k[1]) * 1000 : null,
    kw: kw ? num(kw[1]) : null,
    fuel,
    vent,
    material,
    commercial: /\bcommercial\b/i.test(t) ? true : /\bresidential\b/i.test(t) ? false : null,
    tankless: /\btankless\b/i.test(t) ? true : null,
    heatPump,
    emissions,
  };
}

function intentFrom(input) {
  const description = input.description || '';
  const parsed = specsFromText([input.modelHint, input.partNumber, description].filter(Boolean).join(' '));
  if (input.existingHeater === 'gal70' || input.existingHeater === 'gal80') {
    parsed.gallons = parsed.gallons || (input.existingHeater === 'gal70' ? 70 : 80);
    parsed.material = 'metal';
    if (parsed.vent === 'pvc') parsed.vent = null;
    parsed.ampleRoom = true;
  }
  return { ...parsed, category: effectiveCategory(input), priority: input.matchPriority === 'strict_size' ? 'strict_size' : 'default' };
}

function sameClass(a, b) {
  if (a == null || b == null) return null;
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  if ((low < 100000) !== (high < 100000)) return false;
  return (high - low) / high <= 0.1;
}

function candidateSpecs(item) {
  const text = [item.title, item.brand, item.model, item.partNumber, item.summary].filter(Boolean).join(' ');
  const parsed = specsFromText(text);
  const specs = item.specs || {};
  const pick = (key, alt) => (specs[key] != null ? specs[key] : alt);
  return {
    gallons: pick('gallons', parsed.gallons),
    btuh: pick('btuh', parsed.btuh),
    kw: pick('kw', parsed.kw),
    fuel: pick('fuel', parsed.fuel),
    vent: pick('vent', parsed.vent),
    material: pick('material', parsed.material),
    commercial: pick('commercial', parsed.commercial),
    tankless: pick('tankless', parsed.tankless),
    heatPump: pick('heatPump', parsed.heatPump),
    emissions: pick('emissions', parsed.emissions),
    recoveryGph: specs.recoveryGph ?? null,
    recoveryRiseF: specs.recoveryRiseF ?? null,
  };
}

function hardConflicts(intent, specs) {
  const reasons = [];
  if (intent.fuel && specs.fuel && intent.fuel !== specs.fuel) reasons.push(`Fuel differs (${labelFuel(specs.fuel)} vs ${labelFuel(intent.fuel)}).`);
  if (intent.fuel && intent.fuel !== 'electric' && intent.fuel !== 'heat_pump' && specs.kw && !specs.btuh) reasons.push('Electric kW is not a gas BTU match.');
  if (intent.fuel === 'natural_gas' && specs.heatPump) reasons.push('Heat pump is not a natural gas match.');
  if (intent.btuh && specs.btuh && sameClass(intent.btuh, specs.btuh) === false) reasons.push(`BTU class differs (${formatBtuh(specs.btuh)} vs ${formatBtuh(intent.btuh)}).`);
  if (intent.commercial === true && specs.commercial === false) reasons.push('Residential equipment is not a commercial match.');
  if (intent.commercial === false && specs.commercial === true) reasons.push('Commercial equipment is not a residential match.');
  if (intent.tankless === true && specs.tankless === false) reasons.push('A storage tank is not a tankless match.');
  if (intent.tankless === false && specs.tankless === true) reasons.push('Tankless is not a storage-tank match.');
  if (intent.vent && specs.vent && intent.vent !== specs.vent) reasons.push(`Vent or material differs (${specs.vent} vs ${intent.vent}).`);
  if (intent.material === 'metal' && (specs.material === 'pvc' || specs.vent === 'pvc')) reasons.push('PVC is not the requested metal vent.');
  if (intent.emissions && specs.emissions && intent.emissions !== specs.emissions) reasons.push('Emissions rating differs.');
  if (intent.gallons && specs.gallons && intent.gallons !== specs.gallons) reasons.push(`Capacity differs (${specs.gallons} gal vs ${intent.gallons} gal).`);
  return reasons;
}

function gallonOnly(intent, specs, conflicts) {
  if (conflicts.length) return false;
  const fuelOk = intent.fuel && specs.fuel && intent.fuel === specs.fuel;
  const btuOk = intent.btuh && specs.btuh && sameClass(intent.btuh, specs.btuh) === true;
  return Boolean(intent.gallons && specs.gallons && intent.gallons === specs.gallons && !fuelOk && !btuOk);
}

function classifyCandidate(intent, item) {
  const specs = candidateSpecs(item);
  const conflicts = hardConflicts(intent, specs);
  const modelEqual = Boolean(item.model && intent.modelKey && normModel(item.model) === intent.modelKey);
  if (item.filterPass === false || conflicts.length || gallonOnly(intent, specs, conflicts)) {
    const reasons = item.filterPass === false ? ['Rejected by the match filter.'] : conflicts;
    if (!reasons.length) reasons.push('Only the gallon size overlaps. Fuel and BTU class are not both a match.');
    return { kind: 'rejected', specs, reasons, tradeoffs: [] };
  }
  const missing = [];
  if (intent.category === 'heater' || specs.btuh || specs.fuel || specs.gallons) {
    if (!intent.fuel || !specs.fuel) missing.push('Fuel is unknown.');
    if (!intent.btuh || !specs.btuh) missing.push('BTU is unknown.');
    if (!intent.gallons || !specs.gallons) missing.push('Capacity is unknown.');
  }
  const tradeoffs = [];
  if (intent.btuh && specs.btuh && intent.btuh !== specs.btuh && sameClass(intent.btuh, specs.btuh)) tradeoffs.push(`BTU differs (${formatBtuh(specs.btuh)} vs ${formatBtuh(intent.btuh)}).`);
  if (modelEqual && missing.length === 0) return { kind: 'exact', specs, reasons: [], tradeoffs };
  if (missing.length === 0) return { kind: item.backendKind === 'exact' && tradeoffs.length === 0 ? 'exact' : 'equivalent', specs, reasons: [], tradeoffs };
  return { kind: 'verify', specs, reasons: missing, tradeoffs };
}

function labelFuel(fuel) {
  return { natural_gas: 'natural gas', lp: 'propane', electric: 'electric', heat_pump: 'heat pump' }[fuel] || fuel;
}
function formatBtuh(n) { return `${Math.round(n).toLocaleString('en-US')} BTU/hr`; }
function normModel(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function brandRank(item) {
  const text = `${item.brand || ''} ${item.title || ''}`;
  const hit = BRAND_ORDER.find(([re]) => re.test(text));
  return hit ? hit[1] : 9;
}

function imageEvidence(url, alt) {
  if (typeof url !== 'string' || !/^https:\/\/\S{1,2900}$/.test(url)) return null;
  return { url, alt: String(alt || 'Product photo from the supplier').slice(0, 2000) };
}

function categoryHintFor(input) {
  if (input.categoryHint === 'water_heater' || input.categoryHint === 'backflow_preventer') return input.categoryHint;
  const category = effectiveCategory(input);
  if (category === 'heater') return 'water_heater';
  if (category === 'backflow') return 'backflow_preventer';
  return input.categoryHint || null;
}

module.exports = {
  SUPPLIERS, HEATER_EXCLUDED, ACCOUNT_PRICE_SUPPLIERS, WINSUPPLY_COMPANY, supplierIdsFor, supplierName, effectiveCategory, categoryHintFor, intentFrom,
  classifyCandidate, brandRank, imageEvidence, normModel, formatBtuh, labelFuel, specsFromText,
};
