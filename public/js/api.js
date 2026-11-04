// Browser client.
//   api()      -> PalmPay partner API (/api/v1), called with a bank or terminal key
//   simBank()  -> the simulated bank's own backend (/sim-bank), demo bank app only
//
// In production the bank app never holds a PalmPay key: it calls its own
// backend, which calls PalmPay. In demo mode /config hands out demo keys so
// the whole flow can run from one browser.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code || 'unknown';
    this.details = body?.error?.details;
  }
}

async function request(base, path, { method = 'GET', body, headers = {}, key } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = (path, opts) => request('/api/v1', path, opts);
export const simBank = (path, opts) => request('/sim-bank', path, opts);

let configPromise;
export const getConfig = () => (configPromise ||= api('/config'));

export async function bankKey(bankId) {
  const key = (await getConfig()).demoKeys?.[`bank:${bankId}`];
  if (!key) throw new Error('No partner key for this bank. Is DEMO_MODE on?');
  return key;
}

export async function terminalKey(merchantId) {
  const key = (await getConfig()).demoKeys?.[`terminal:${merchantId}`];
  if (!key) throw new Error('No terminal key for this shop. Is DEMO_MODE on?');
  return key;
}

/** Subscribe to live events. Returns an unsubscribe function. */
export function liveEvents(params, handlers, onStatus = () => {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  const es = new EventSource(`/api/v1/events${qs ? `?${qs}` : ''}`);
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  for (const [type, fn] of Object.entries(handlers)) {
    es.addEventListener(type, (msg) => fn(JSON.parse(msg.data)));
  }
  return () => es.close();
}

export const idempotencyKey = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

// Storage that never throws (private mode, blocked site data).
export const prefs = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(`palmpay.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`palmpay.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
  remove(key) {
    try { localStorage.removeItem(`palmpay.${key}`); } catch { /* ignore */ }
  },
};
