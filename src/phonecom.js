'use strict';
// Shared Phone.com API v4 client. One place for the token, the account lookup and rate limits,
// so the phone settings tool now and the texting tools later use the same connection.
// This version only reads: write methods are added with the calendar switching, behind their own check.
const BASE = 'https://api.phone.com/v4';

class PhoneComError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function createPhoneCom({ token = process.env.PHONECOM_API_TOKEN, fetch: fetcher = global.fetch, base = BASE, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 15000 } = {}) {
  let voipId = process.env.PHONECOM_ACCOUNT_ID || null;

  async function request(path, query = {}) {
    if (!token) throw new PhoneComError('Phone.com is not connected yet (PHONECOM_API_TOKEN is not set on Render).', 0);
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const res = await fetcher(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      // Phone.com allows 30 calls per endpoint every 30s; wait once when it says so.
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(Number(res.headers?.get?.('retry-after')) || 5, 20);
        await sleep(wait * 1000);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403 ? 'the token was refused' : `HTTP ${res.status}`;
        throw new PhoneComError(`Phone.com ${path.replace(/\/accounts\/\d+/, '')}: ${hint}`, res.status);
      }
      try { return text ? JSON.parse(text) : {}; } catch { throw new PhoneComError(`Phone.com ${path}: unreadable response`, res.status); }
    }
  }

  async function accountId() {
    if (voipId) return voipId;
    const out = await request('/accounts', { limit: 1 });
    const id = out.items?.[0]?.id;
    if (!id) throw new PhoneComError('Phone.com returned no account for this token.', 0);
    voipId = String(id);
    return voipId;
  }

  // Lists every item of an account resource, 500 at a time (the API maximum).
  async function list(resource, query = {}) {
    const id = await accountId();
    const items = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      const page = await request(`/accounts/${id}/${resource}`, { limit: 500, offset, ...query });
      items.push(...(page.items || []));
      if (!page.items?.length || items.length >= Number(page.total || 0)) break;
    }
    return items;
  }

  async function get(resource, itemId, query = {}) {
    const id = await accountId();
    return request(`/accounts/${id}/${resource}/${encodeURIComponent(itemId)}`, query);
  }

  return { ready: !!token, accountId, list, get, request };
}

module.exports = { createPhoneCom, PhoneComError, BASE };
