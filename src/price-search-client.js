'use strict';
// Identify client for tps-price-v1. The supplier collector is not called here.
// A loopback or localhost URL is refused so this server never targets the Mac.

const CONTRACT_VERSION = 'tps-price-v1';

function loopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0' || host.startsWith('127.')) return true;
  return false;
}

function priceSearchConfig(env = process.env) {
  const enabled = env.PRICE_SEARCH_ENABLED === '1';
  const url = String(env.PRICE_SEARCH_IDENTIFY_URL || '').trim();
  const token = String(env.PRICE_SEARCH_IDENTIFY_TOKEN || '').trim();
  const bridgeToken = String(env.TPS_PRICE_BRIDGE_TOKEN || '');
  let identifyConfigured = false;
  let rejectedLoopback = false;
  if (url && token.length >= 8) {
    try {
      const parsed = new URL(url);
      rejectedLoopback = loopbackHost(parsed.hostname);
      identifyConfigured = enabled && parsed.protocol === 'https:' && !parsed.username && !parsed.password && !rejectedLoopback;
    } catch { identifyConfigured = false; }
  }
  return {
    enabled,
    identifyConfigured,
    rejectedLoopback,
    bridgeConfigured: enabled && bridgeToken.length >= 8,
    url: identifyConfigured ? url : '',
    token: identifyConfigured ? token : '',
  };
}

function publicStatus(env = process.env, tokenPresent = Boolean(process.env.TPS_ASSISTANT_BOT_TOKEN)) {
  const cfg = priceSearchConfig(env);
  return { enabled: cfg.enabled, identifyConfigured: cfg.identifyConfigured, bridgeConfigured: cfg.bridgeConfigured, assistantToken: Boolean(tokenPresent) };
}

function buildRequest(input, env = process.env) {
  const { supplierIdsFor, effectiveCategory, categoryHintFor, WINSUPPLY_COMPANY } = require('./price-search-policy');
  const category = effectiveCategory(input);
  const request = {
    requestId: input.requestId,
    queryType: input.queryType,
    categoryHint: categoryHintFor(input),
    qty: input.qty,
    matchPriority: input.matchPriority === 'strict_size' ? 'strict_size' : 'default',
    suppliers: supplierIdsFor(category),
    companyContext: { winsupply: WINSUPPLY_COMPANY },
    uiSource: 'tps_assistant_app_home',
    mode: env.TPS_PRICE_COLLECT_MODE === 'execute' ? 'execute' : 'plan',
  };
  if (input.modelHint) request.modelHint = input.modelHint;
  if (input.partNumber) request.partNumber = input.partNumber;
  if (input.description) request.description = input.description;
  if (input.photoRef) request.photoRef = input.photoRef;
  if (input.fileName) request.fileName = input.fileName;
  if (input.location) request.location = typeof input.location === 'object' ? input.location : { text: input.location };
  if (input.identifiedSpecs) request.identifiedSpecs = input.identifiedSpecs;
  if (Array.isArray(input.candidateHints)) request.candidateHints = input.candidateHints.slice(0, 20);
  return request;
}

function normalizeIdentify(body) {
  const { enrichmentFrom } = require('./price-contract');
  const error = body?.error && typeof body.error === 'object' ? {
    code: String(body.error.code || 'identify_failed').slice(0, 80),
    message: String(body.error.message || 'Identification could not be completed.').slice(0, 300),
    retryable: body.error.retryable !== false,
  } : null;
  if (body?.status === 'unsupported_photo' || error?.code === 'unsupported_photo') {
    return { status: 'error', error: { code: 'unsupported_photo', message: error?.message || 'This photo could not be identified.', retryable: false } };
  }
  if (body?.status === 'pending' || body?.status === 'accepted' || body?.jobId || body?.poll) {
    return { status: 'error', error: { code: 'identify_incomplete', message: 'Identification did not finish, so no supplier search was queued.', retryable: true } };
  }
  if (error || body?.status === 'error' || body?.ok === false) return { status: 'error', error: error || { code: 'identify_failed', message: 'Identification could not be completed.', retryable: true } };
  const mapped = enrichmentFrom(body);
  if (!mapped.ok) return { status: 'error', error: { code: 'identify_failed', message: 'Identification could not be queued.', retryable: true } };
  return { status: 'complete', identifiedSpecs: mapped.identifiedSpecs, candidateHints: mapped.candidateHints, categoryHint: mapped.categoryHint, enrichment: mapped.enrichment };
}

function createPriceClient({ env = process.env, fetch: fetcher = global.fetch } = {}) {
  const cfg = priceSearchConfig(env);
  return {
    config: { enabled: cfg.enabled, identifyConfigured: cfg.identifyConfigured, bridgeConfigured: cfg.bridgeConfigured },
    async identify(request, photo) {
      if (!cfg.enabled) return { status: 'disabled' };
      if (!cfg.identifyConfigured) return { status: 'unconfigured', error: { code: 'identify_not_configured', message: 'Model and photo identification is not connected.', retryable: false } };
      const body = { ...request };
      if (photo?.fileContent) body.fileContent = photo.fileContent;
      const res = await fetcher(cfg.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      const text = await res.text();
      if (!res.ok) return { status: 'error', error: { code: res.status === 401 || res.status === 403 ? 'auth_refused' : `http_${res.status}`, message: 'Identification could not be completed.', retryable: res.status >= 500 || res.status === 429 } };
      try { return normalizeIdentify(text ? JSON.parse(text) : {}); }
      catch { return { status: 'error', error: { code: 'invalid_json', message: 'Identification returned an unreadable result.', retryable: true } }; }
    },
  };
}

module.exports = { CONTRACT_VERSION, priceSearchConfig, publicStatus, buildRequest, createPriceClient, normalizeIdentify, loopbackHost };
