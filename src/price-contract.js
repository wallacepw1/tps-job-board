'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'contracts', 'collector-tps-price-v1.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('uri', {
  type: 'string',
  validate: value => {
    try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; }
    catch { return false; }
  },
});

ajv.addSchema(schema);
const validate = {
  request: ajv.compile({ $ref: 'tps-price-v1#/$defs/request' }),
  result: ajv.compile({ $ref: 'tps-price-v1#/$defs/result' }),
  claim: ajv.compile({ $ref: 'tps-price-v1#/$defs/claimRequest' }),
  claimResponse: ajv.compile({ $ref: 'tps-price-v1#/$defs/claimResponse' }),
  resultPost: ajv.compile({ $ref: 'tps-price-v1#/$defs/resultPost' }),
  resultAck: ajv.compile({ $ref: 'tps-price-v1#/$defs/resultAck' }),
};

function report(check, value) {
  return { ok: check(value) === true, errors: check.errors || [] };
}

const SPEC_KEYS = ['fuel', 'inputBtu', 'recoveryTemperatureRise', 'recoveryGph', 'ventType', 'ventMaterial', 'emissions', 'gallons', 'dimensions'];

function pickSpecs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const specs = {};
  for (const key of SPEC_KEYS) if (value[key] !== undefined) specs[key] = value[key];
  return Object.keys(specs).length ? specs : null;
}

function pickHint(value) {
  if (!value || typeof value !== 'object') return null;
  const hint = {};
  for (const key of ['supplierId', 'model', 'partNumber', 'productUrl', 'image']) if (value[key] !== undefined) hint[key] = value[key];
  const specs = pickSpecs(value.specs || value.comparison || value.identifiedSpecs);
  if (specs) hint.specs = specs;
  return Object.keys(hint).length ? hint : null;
}

function textOrNull(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function mapSpecs(target = {}) {
  const dimensions = {};
  if (target.connectionSizeIn != null) dimensions.connectionSizeIn = textOrNull(target.connectionSizeIn);
  if (target.heightIn != null) dimensions.heightIn = textOrNull(target.heightIn);
  if (target.diameterIn != null) dimensions.diameterIn = textOrNull(target.diameterIn);
  const gallons = target.capacityGal == null ? (Array.isArray(target.gallons) ? target.gallons.map(textOrNull) : target.gallons ?? null) : [textOrNull(target.capacityGal)];
  return {
    fuel: target.fuel ?? null,
    inputBtu: textOrNull(target.inputBtu),
    recoveryTemperatureRise: textOrNull(target.recoveryRiseF ?? target.recoveryTemperatureRise),
    recoveryGph: textOrNull(target.recoveryGph),
    ventType: target.venting ?? target.ventType ?? null,
    ventMaterial: target.ventMaterial ?? null,
    emissions: target.emissions ?? null,
    gallons,
    dimensions: Object.keys(dimensions).length ? dimensions : null,
  };
}

function mapHintSpecs(specs) {
  if (!specs || typeof specs !== 'object') return null;
  const out = {};
  for (const key of ['fuel', 'inputBtu', 'recoveryTemperatureRise', 'recoveryGph', 'ventType', 'ventMaterial', 'emissions']) {
    if (specs[key] !== undefined) out[key] = textOrNull(specs[key]);
  }
  if (specs.venting !== undefined && out.ventType === undefined) out.ventType = textOrNull(specs.venting);
  if (specs.gallons !== undefined) out.gallons = specs.gallons == null ? null : (Array.isArray(specs.gallons) ? specs.gallons.map(textOrNull) : [textOrNull(specs.gallons)]);
  if (specs.capacityGal !== undefined && out.gallons === undefined) out.gallons = specs.capacityGal == null ? null : [textOrNull(specs.capacityGal)];
  return Object.keys(out).length ? out : null;
}

function mapHints(candidates) {
  return (Array.isArray(candidates) ? candidates : []).slice(0, 20).map(item => {
    if (!item || typeof item !== 'object' || item.model == null) return null;
    const hint = { model: item.model };
    const specs = mapHintSpecs(item.specs);
    if (specs) hint.specs = specs;
    return hint;
  }).filter(Boolean);
}

function mapEnrichment(envelope) {
  const enrichment = envelope?.enrichment || envelope?.identify || null;
  if (!enrichment || typeof enrichment !== 'object') return { ok: false, error: 'missing_enrichment' };
  const heater = envelope?.supplierRouting?.isHeater === true || enrichment.category === 'water_heater';
  const routed = Array.isArray(envelope?.supplierRouting?.suppliersToQuery) ? envelope.supplierRouting.suppliersToQuery : null;
  return {
    ok: true,
    enrichment,
    identifiedSpecs: mapSpecs(enrichment.targetSpecs || {}),
    candidateHints: mapHints(enrichment.candidates || envelope.candidates),
    categoryHint: enrichment.category ?? null,
    suppliers: routed ? routed.filter(id => !heater || !['supplyhouse', 'masterbuildermercantile'].includes(id)) : null,
    hypotheses: mapHints(enrichment.candidates || []).map(hint => hint.model),
  };
}

function enrichmentFrom(body) {
  if (body?.status === 'accepted' && body?.completed === false) return { incomplete: true };
  if (body?.status === 'completed_enrichment' || body?.enrichment) return mapEnrichment(body);
  const source = body?.request && typeof body.request === 'object' ? body.request : body || {};
  const identifiedSpecs = pickSpecs(source.identifiedSpecs || source.targetSpecs);
  const candidateHints = mapHints(source.candidateHints || source.candidates || []);
  return { ok: true, enrichment: null, identifiedSpecs, candidateHints, categoryHint: null, suppliers: null, hypotheses: [] };
}

function validateRequest(value) { return report(validate.request, value); }
function validateResult(value) { return { ...report(validate.result, value), endpointRejected: value?.collector?.httpEndpoint != null }; }
function validateClaim(value) { return report(validate.claim, value); }
function validateClaimResponse(value) { return report(validate.claimResponse, value); }
function validateResultPost(value) { return report(validate.resultPost, value); }
function validateResultAck(value) { return report(validate.resultAck, value); }

module.exports = {
  schema, enrichmentFrom, mapEnrichment, mapSpecs, mapHints, validateRequest, validateResult, validateClaim, validateClaimResponse, validateResultPost, validateResultAck,
};
