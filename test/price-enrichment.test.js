const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');
const { mapEnrichment, validateRequest } = require('../src/price-contract');
const { normalizeIdentify } = require('../src/price-search-client');
const { presentResult } = require('../src/price-search');

const enrichmentSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/contracts/tps-price-v1-latenode-enrichment.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(enrichmentSchema);
const validateEnrichment = ajv.compile(enrichmentSchema);

const backflow = {
  contractVersion: 'tps-price-v1',
  role: 'identification_enrichment',
  requestId: 'test-backflow-generic-1',
  status: 'completed_enrichment',
  ok: true,
  completed: true,
  label: 'TEST_INPUT',
  isTest: true,
  matchPriority: 'default',
  enrichment: {
    category: 'backflow_preventer',
    identity: { manufacturer: null, brand: 'Watts', model: null, partNumber: null, itemNumber: null, sizeOrType: '1 inch reduced pressure zone (RPZ)', modelEvidence: null },
    targetSpecs: { fuel: null, capacityGal: null, inputBtu: null, recoveryGph: null, recoveryRiseF: null, venting: null, emissions: null, commercialClass: null, heightIn: null, diameterIn: null, connectionSizeIn: 1, rawText: '1 inch Watts reduced pressure zone (RPZ) backflow preventer' },
    matchStatus: 'type_brand_size',
    candidates: [],
    confidence: 0.45,
    provenance: ['TEST_INPUT'],
    unknowns: ['model', 'capacityGal', 'inputBtu', 'fuel', 'venting', 'emissions'],
    unreadable: false,
    reasoningSummary: 'Brand/size/type from description only; no explicit model in input.',
    postValidationNotes: ['generic_description_cannot_be_exact_model'],
    reasonsAreNotFacts: true,
  },
  candidates: [],
  supplierRouting: { isHeater: false, suppliersToQuery: ['hirsch', 'reece_us', 'homedepot', 'lowes', 'supplyhouse', 'masterbuildermercantile', 'winsupply'] },
  approvals: { edgarApprovalRequired: true, installerConfirmRequired: true, autoPurchase: false },
  uiHints: { priceStockImageSupplierOnly: true },
  missingPieces: [{ id: 'vision_photo_path', status: 'not_verified', detail: 'Vision/photo identify not claimed passed.' }],
};

const backflowRequest = {
  requestId: 'test-backflow-generic-1',
  queryType: 'description',
  description: '1 inch Watts reduced pressure zone (RPZ) backflow preventer',
  categoryHint: 'backflow_preventer',
  matchPriority: 'default',
  modelHint: null,
  partNumber: null,
  identifiedSpecs: { fuel: null, inputBtu: null, recoveryTemperatureRise: null, recoveryGph: null, ventType: null, ventMaterial: null, emissions: null, gallons: null, dimensions: { connectionSizeIn: '1' } },
  candidateHints: [],
  suppliers: ['hirsch', 'reece_us', 'homedepot', 'lowes', 'supplyhouse', 'masterbuildermercantile', 'winsupply'],
  uiSource: 'tps_assistant_app_home',
  mode: 'plan',
};

const heaterEnrichment = {
  enrichment: {
    category: 'water_heater',
    identity: { manufacturer: 'American', brand: 'American', model: 'BCG370T1205NOX108', partNumber: null, itemNumber: null, sizeOrType: null, modelEvidence: 'input_explicit' },
    targetSpecs: { fuel: 'Natural Gas', capacityGal: 70, inputBtu: 120000, recoveryGph: null, recoveryRiseF: null, venting: 'Atmospheric 5 inch', emissions: 'Low NOx', commercialClass: 'commercial', heightIn: null, diameterIn: null, connectionSizeIn: null, rawText: 'Commercial NG ~120000 BTU, ~70-71 gal rated class, atmospheric metal ~5 inch vent, Low NOx' },
    matchStatus: 'exact',
    candidates: [
      { brand: 'A.O. Smith', model: 'BTR-75 120/125', matchKind: 'candidate_hypothesis', oemProven: false, unverifiedHypothesis: true, specs: { fuel: 'Natural Gas', inputBtu: '120000', emissions: 'Low NOx', ventType: 'Atmospheric', gallons: ['75'] } },
      { brand: 'Rheem', model: 'RG275S12N', matchKind: 'candidate_hypothesis', oemProven: false, unverifiedHypothesis: true, specs: { fuel: 'Natural Gas', inputBtu: '120000', emissions: 'Low NOx', ventType: 'Atmospheric', gallons: ['75'] } },
      { brand: 'State', model: 'GHE75-120', matchKind: 'candidate_hypothesis', oemProven: false, unverifiedHypothesis: true, specs: { fuel: 'Natural Gas', inputBtu: '120000', emissions: 'Low NOx', ventType: 'Atmospheric', gallons: ['75'] } },
    ],
    confidence: null,
    unknowns: ['recoveryGph', 'recoveryRiseF', 'ventMaterial'],
    reasonsAreNotFacts: true,
  },
  supplierRouting: { isHeater: true, suppliersToQuery: ['hirsch', 'reece_us', 'homedepot', 'lowes', 'winsupply'] },
};

const heaterHints = [
  { model: 'BTR-75 120/125', specs: { fuel: 'Natural Gas', inputBtu: '120000', emissions: 'Low NOx', ventType: 'Atmospheric', gallons: ['75'] } },
  { model: 'RG275S12N', specs: { fuel: 'Natural Gas', inputBtu: '120000', emissions: 'Low NOx', ventType: 'Atmospheric', gallons: ['75'] } },
  { model: 'GHE75-120', specs: { fuel: 'Natural Gas', inputBtu: '120000', emissions: 'Low NOx', ventType: 'Atmospheric', gallons: ['75'] } },
];

test('generic backflow enrichment matches the mapped example and keeps nulls', () => {
  assert.equal(validateEnrichment(backflow), true, JSON.stringify(validateEnrichment.errors));
  const mapped = mapEnrichment(backflow);
  assert.deepEqual(mapped.identifiedSpecs, backflowRequest.identifiedSpecs);
  assert.deepEqual(mapped.candidateHints, []);
  assert.deepEqual(mapped.suppliers, backflowRequest.suppliers);
  assert.equal(mapped.enrichment.identity.model, null);
  assert.equal(mapped.enrichment.targetSpecs.fuel, null);
  const request = { ...backflowRequest };
  assert.equal(validateRequest(request).ok, true, JSON.stringify(validateRequest(request).errors));
  const normalized = normalizeIdentify(backflow);
  assert.equal(normalized.enrichment.reasonsAreNotFacts, true);
  assert.equal(JSON.stringify(normalized.candidateHints).includes('price'), false);
  assert.equal(JSON.stringify(normalized).includes('imageUrl'), false);
});

test('explicit heater hints drop hypothesis flags and do not prove a candidate', () => {
  const mapped = mapEnrichment(heaterEnrichment);
  assert.deepEqual(mapped.identifiedSpecs, { fuel: 'Natural Gas', inputBtu: '120000', recoveryTemperatureRise: null, recoveryGph: null, ventType: 'Atmospheric 5 inch', ventMaterial: null, emissions: 'Low NOx', gallons: ['70'], dimensions: null });
  assert.deepEqual(mapped.candidateHints, heaterHints);
  assert.equal(JSON.stringify(mapped.candidateHints).includes('oemProven'), false);
  assert.equal(JSON.stringify(mapped.candidateHints).includes('candidate_hypothesis'), false);
  const request = { requestId: 'test-heater-explicit-1', queryType: 'model_text', modelHint: 'American BCG370T1205NOX108', description: 'Commercial NG ~120000 BTU, ~70-71 gal rated class, atmospheric metal ~5 inch vent, Low NOx', categoryHint: 'water_heater', matchPriority: 'default', identifiedSpecs: mapped.identifiedSpecs, candidateHints: mapped.candidateHints, suppliers: mapped.suppliers, uiSource: 'tps_assistant_app_home', mode: 'plan' };
  assert.equal(validateRequest(request).ok, true, JSON.stringify(validateRequest(request).errors));
  const view = JSON.stringify(presentResult({ description: request.description, modelHint: request.modelHint, categoryHint: 'water_heater', enrichment: mapped.enrichment }, { candidates: [{ supplierId: 'hirsch', model: 'BTR-75 120/125', matchClass: 'exact', filterPass: true, evidenceKind: 'candidate_hint', comparison: heaterHints[0].specs }], priceRows: [], collector: { linked: false, liveRun: false, evidenceKind: 'not_collected', httpEndpoint: null, bridge: 'outbound_mac_worker' }, supplierErrors: [] }));
  assert.match(view, /Unverified hypothesis: BTR-75 120\/125/);
  assert.match(view, /Not OEM-proven/);
  assert.doesNotMatch(view, /oemProven|Exact match/);
  assert.match(view, /recoveryGph: unknown/);
});
