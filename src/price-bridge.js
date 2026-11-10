'use strict';
// Outbound worker bridge. The Mac collector calls Render. Render does not call the Mac.
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SUPPLIERS } = require('./price-search-policy');
const { validateRequest, validateResult, validateClaim, validateClaimResponse, validateResultPost, validateResultAck, adaptCollectorResult } = require('./price-contract');

const SUPPLIER_IDS = new Set(SUPPLIERS.map(supplier => supplier.id));
const MAX_QUEUE = 40;
const MAX_CLAIM_BYTES = 8192;
const MAX_RESULT_BYTES = 200000;
const MAX_REQUEST_BYTES = 32000;
const LEASE_MS = 180000;
const JOB_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const CLEAN_AFTER_MS = 60 * 60 * 1000;

function defaultFile() {
  return path.join(process.cwd(), 'data', 'tps-pricing-queue.json');
}

function tokenOk(presented, expected) {
  const right = Buffer.from(String(expected || ''));
  const given = Buffer.from(String(presented || ''));
  if (!right.length || given.length !== right.length) {
    if (right.length) timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(given, right);
}

function bearer(header) {
  const match = /^Bearer ([!-~]{8,200})$/.exec(String(header || '').trim());
  return match ? match[1] : '';
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function createBridge({ file = defaultFile(), now = Date.now, enabled = false, token = '' } = {}) {
  const jobs = new Map();
  let ready = false;

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const body = JSON.stringify({ jobs: [...jobs.values()] });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
    } catch (error) {
      console.error('price bridge', error && error.code === 'EACCES' ? 'persist_denied' : 'persist_failed');
    }
  }

  function recover() {
    if (ready) return;
    ready = true;
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')).jobs || []; } catch { saved = []; }
    const time = now();
    for (const job of saved) {
      if (!job || typeof job.id !== 'string') continue;
      if (job.status === 'leased' || job.status === 'running') {
        job.status = 'queued';
        job.leaseId = null;
        job.workerId = null;
        job.leaseExpiresAt = null;
      }
      if (job.expiresAt <= time && job.status !== 'complete') job.status = 'expired';
      jobs.set(job.id, job);
    }
    persist();
  }

  function sweep(time = now()) {
    recover();
    for (const job of jobs.values()) {
      if ((job.status === 'leased' || job.status === 'running') && job.leaseExpiresAt <= time) {
        job.leaseId = null;
        job.workerId = null;
        job.leaseExpiresAt = null;
        job.status = job.attempts >= MAX_ATTEMPTS || job.expiresAt <= time ? 'expired' : 'queued';
      } else if (job.status !== 'complete' && job.expiresAt <= time) job.status = 'expired';
      if (job.expiresAt + CLEAN_AFTER_MS <= time) jobs.delete(job.id);
    }
  }

  function enqueue(request, enrichment) {
    sweep();
    if (!enabled) return { ok: false, error: 'disabled' };
    const copy = request && typeof request === 'object' ? { ...request } : null;
    if (!copy) return { ok: false, error: 'invalid' };
    delete copy.fileContent;
    if (!validateRequest(copy).ok) return { ok: false, error: 'invalid_request' };
    if (Buffer.byteLength(JSON.stringify(copy)) > MAX_REQUEST_BYTES) return { ok: false, error: 'too_large' };
    const active = [...jobs.values()].filter(job => job.status === 'queued' || job.status === 'leased').length;
    if (active >= MAX_QUEUE) return { ok: false, error: 'full' };
    const time = now();
    const job = {
      id: `job_${randomUUID().replace(/-/g, '')}`,
      status: 'queued',
      request: copy,
      createdAt: time,
      expiresAt: time + JOB_TTL_MS,
      attempts: 0,
      leaseId: null,
      workerId: null,
      leaseExpiresAt: null,
      result: null,
      resultHash: null,
      enrichment: enrichment || null,
    };
    jobs.set(job.id, job);
    persist();
    return { ok: true, id: job.id };
  }

  function claim({ workerId, capabilities }) {
    sweep();
    if (!validateClaim({ workerId, capabilities }).ok) return { error: 'invalid_capabilities' };
    const wanted = new Set(capabilities);
    const time = now();
    const held = [...jobs.values()].find(job => job.status === 'leased' && job.workerId === workerId && job.leaseExpiresAt > time);
    if (held) return { job: { id: held.id, leaseId: held.leaseId, request: held.request } };
    const next = [...jobs.values()]
      .filter(job => job.status === 'queued' && (job.request.suppliers || []).some(id => wanted.has(id)))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return { job: null };
    next.status = 'leased';
    next.workerId = workerId;
    next.leaseId = randomUUID();
    next.leaseExpiresAt = time + LEASE_MS;
    next.attempts += 1;
    persist();
    const response = { job: { id: next.id, leaseId: next.leaseId, request: next.request } };
    if (!validateClaimResponse(response).ok) {
      next.status = 'queued';
      next.workerId = null;
      next.leaseId = null;
      next.leaseExpiresAt = null;
      next.attempts -= 1;
      persist();
      return { job: null };
    }
    return response;
  }

  function postResult(id, body) {
    recover();
    const time = now();
    const pending = jobs.get(id);
    if (pending && pending.status === 'leased' && body?.workerId === pending.workerId && body?.leaseId === pending.leaseId && !(pending.leaseExpiresAt > time)) {
      pending.leaseId = null;
      pending.workerId = null;
      pending.leaseExpiresAt = null;
      pending.status = pending.attempts >= MAX_ATTEMPTS || pending.expiresAt <= time ? 'expired' : 'queued';
      persist();
      return { status: 409, body: { accepted: false, error: 'wrong_lease' } };
    }
    sweep(time);
    const job = jobs.get(id);
    if (!job) return { status: 404, body: { accepted: false, error: 'not_found' } };
    if (!body || body.workerId !== job.workerId) return { status: 409, body: { accepted: false, error: 'foreign_job' } };
    if (job.status === 'complete' && body.leaseId === job.leaseId) {
      if (digest(body.result) === job.resultHash) return { status: 200, body: { accepted: true } };
      return { status: 409, body: { accepted: false, error: 'conflict' } };
    }
    if (job.status !== 'leased' || body.leaseId !== job.leaseId || !(job.leaseExpiresAt > now())) {
      return { status: 409, body: { accepted: false, error: 'wrong_lease' } };
    }
    const adapted = adaptCollectorResult(body.result);
    const checked = validateResult(adapted.schema);
    if (!checked.ok || checked.endpointRejected) return { status: 400, body: { accepted: false, error: 'invalid_result' } };
    job.status = 'complete';
    job.result = adapted.normalized;
    job.resultHash = digest(body.result);
    job.leaseExpiresAt = now() + JOB_TTL_MS;
    persist();
    return { status: 200, body: { accepted: true } };
  }

  function get(id) {
    sweep();
    const job = jobs.get(id);
    if (!job) return { status: 'missing' };
    return { status: job.status, result: job.status === 'complete' ? job.result : null };
  }

  function cancel(id) {
    sweep();
    const job = jobs.get(id);
    if (!job || job.status === 'complete' || job.status === 'leased') return;
    job.status = 'expired';
    persist();
  }

  return { enqueue, claim, postResult, get, cancel, sweep };
}

function bridgeConfig(env = process.env) {
  const enabled = env.PRICE_SEARCH_ENABLED === '1';
  const token = String(env.TPS_PRICE_BRIDGE_TOKEN || '');
  return { enabled, configured: enabled && token.length >= 8, token: enabled ? token : '', file: env.TPS_PRICING_QUEUE_PATH || defaultFile() };
}

let singleton = null;
function getPriceBridge(env = process.env) {
  if (!singleton) {
    const cfg = bridgeConfig(env);
    singleton = createBridge({ file: cfg.file, enabled: cfg.enabled, token: cfg.token });
  }
  return singleton;
}
function resetPriceBridge() { singleton = null; }

async function readRaw(req, limit) {
  let raw = req.rawBody?.toString() || '';
  if (!raw) {
    for await (const chunk of req) {
      raw += chunk.toString();
      if (Buffer.byteLength(raw) > limit) return { error: 413 };
    }
  }
  if (Buffer.byteLength(raw) > limit) return { error: 413 };
  return { raw };
}

function registerPriceBridge(receiver, options = {}) {
  const env = options.env || process.env;
  const cfg = { ...bridgeConfig(env), ...options.config };
  const bridge = options.bridge || getPriceBridge(env);
  const enabled = options.enabled ?? cfg.enabled;
  const token = options.token ?? cfg.token;

  async function handle(req, res, kind) {
    try {
      if (!enabled) return res.status(404).json({ error: 'not_found' });
      if (!token || token.length < 8) return res.status(503).json({ error: 'not_configured' });
      const limit = kind === 'result' ? MAX_RESULT_BYTES : MAX_CLAIM_BYTES;
      const read = await readRaw(req, limit);
      if (read.error) return res.status(413).json({ error: 'too_large' });
      if (!tokenOk(bearer(req.headers.authorization || req.headers.Authorization), token)) return res.status(401).json({ error: 'unauthorized' });
      let body;
      try { body = JSON.parse(read.raw || '{}'); } catch { return res.status(400).json({ error: 'invalid_json' }); }
      if (kind === 'claim') {
        const out = bridge.claim({ workerId: body.workerId, capabilities: body.capabilities });
        if (out.error) return res.status(400).json({ error: out.error });
        return res.json(out.job ? { job: out.job } : { job: null });
      }
      const id = req.params?.id || String(req.url || '').match(/\/jobs\/([A-Za-z0-9_-]{8,80})\/result/)?.[1];
      if (!id) return res.status(404).json({ accepted: false, error: 'not_found' });
      if (!validateResultPost(body).ok) return res.status(400).json({ accepted: false, error: 'invalid_result' });
      const out = bridge.postResult(id, body);
      if (out.status === 200 && !validateResultAck(out.body).ok) return res.status(500).json({ error: 'bridge_failed' });
      return res.status(out.status).json(out.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'bridge_failed' });
    }
  }

  receiver.router.post('/internal/tps-pricing/claim', (req, res) => handle(req, res, 'claim'));
  receiver.router.post('/internal/tps-pricing/jobs/:id/result', (req, res) => handle(req, res, 'result'));
  receiver.router.get('/internal/tps-pricing/health', (_req, res) => {
    if (!enabled) return res.status(404).json({ error: 'not_found' });
    return res.json({ enabled: true, bridgeConfigured: Boolean(token && token.length >= 8) });
  });
  return bridge;
}

module.exports = { createBridge, registerPriceBridge, getPriceBridge, resetPriceBridge, bridgeConfig, tokenOk };
