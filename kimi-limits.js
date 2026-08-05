// Plan limits as Kimi Code's own /usage reports them.
//
// Same approach as usage-limits.js for Claude: borrow the OAuth token the CLI
// already keeps under ~/.kimi-code/credentials/ and hit the managed endpoint
// the CLI uses (packages/oauth managed-usage → GET …/usages). Not a public
// API — every field is read defensively.
//
// Access tokens last ~15 minutes, so expired tokens are refreshed via the
// same device-flow client id the CLI embeds, and the rotated pair is written
// back atomically so the CLI stays in sync.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = () => {
  const env = process.env.KIMI_CODE_HOME;
  if (env && typeof env === 'string' && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.kimi-code');
};
const CREDENTIALS = () => path.join(HOME(), 'credentials', 'kimi-code.json');
const BASE_URL = () => (process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '');
const OAUTH_HOST = () => (process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || 'https://auth.kimi.com').replace(/\/+$/, '');
// Public device-flow client id from the Kimi Code CLI binary (same host as login).
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

const TTL_MS = 60000;
const STALE_MS = 15 * 60000;
const SKEW_S = 60; // refresh a minute before expiry

let cache = null;
let lastGood = null;
let inFlight = null;

function toInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function toReset(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

function readCreds() {
  try {
    const data = JSON.parse(fs.readFileSync(CREDENTIALS(), 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

function writeCreds(next) {
  const file = CREDENTIALS();
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) { /* exists */ }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) { /* gone */ }
  }
}

async function refreshToken(refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const res = await fetch(`${OAUTH_HOST()}/api/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const access = data && data.access_token;
    if (typeof access !== 'string' || !access) return null;
    const expiresIn = Number(data.expires_in);
    const next = {
      access_token: access,
      refresh_token: typeof data.refresh_token === 'string' && data.refresh_token
        ? data.refresh_token
        : refreshToken,
      expires_in: Number.isFinite(expiresIn) ? expiresIn : 900,
      expires_at: Math.floor(Date.now() / 1000)
        + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900),
      scope: typeof data.scope === 'string' ? data.scope : 'kimi-code',
      token_type: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    };
    writeCreds(next);
    return next.access_token;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function accessToken() {
  if (process.env.KIMI_CODE_OAUTH_TOKEN) return process.env.KIMI_CODE_OAUTH_TOKEN;
  const creds = readCreds();
  if (!creds) return null;
  const access = typeof creds.access_token === 'string' ? creds.access_token : null;
  const refresh = typeof creds.refresh_token === 'string' ? creds.refresh_token : null;
  const exp = toInt(creds.expires_at);
  const now = Math.floor(Date.now() / 1000);
  if (access && exp !== null && exp > now + SKEW_S) return access;
  if (refresh) {
    const fresh = await refreshToken(refresh);
    if (fresh) return fresh;
  }
  return access || null;
}

// Map the managed payload onto { session?, week? } the renderer already draws.
// Weekly summary is `usage`; the rolling 5h window is the limits[] entry whose
// window is ~300 minutes (docs: 5-hour rate window).
function windowFromDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const limit = toInt(detail.limit);
  let used = toInt(detail.used);
  if (used === null) {
    const remaining = toInt(detail.remaining);
    if (remaining !== null && limit !== null) used = limit - remaining;
  }
  if (used === null || limit === null || limit <= 0) return null;
  const pct = Math.max(0, Math.min(100, (used / limit) * 100));
  return {
    pct,
    resetsAt: toReset(detail.resetTime || detail.reset_at || detail.resetAt),
    severity: null,
    label: null,
  };
}

function minutesOf(window) {
  if (!window || typeof window !== 'object') return null;
  const duration = toInt(window.duration);
  if (duration === null) return null;
  const unit = String(window.timeUnit || window.time_unit || '').toUpperCase();
  if (unit.includes('MINUTE')) return duration;
  if (unit.includes('HOUR')) return duration * 60;
  if (unit.includes('DAY')) return duration * 1440;
  if (unit.includes('SECOND')) return Math.round(duration / 60);
  return duration; // bare number: treat as minutes when around 300
}

function normalize(body) {
  if (!body || typeof body !== 'object') return null;
  const windows = {};

  const week = windowFromDetail(body.usage);
  if (week) windows.week = week;

  if (Array.isArray(body.limits)) {
    for (const item of body.limits) {
      if (!item || typeof item !== 'object') continue;
      const detail = item.detail && typeof item.detail === 'object' ? item.detail : item;
      const mins = minutesOf(item.window);
      // 5h rate window is 300 minutes (membership docs). Allow a small range.
      if (mins !== null && mins >= 240 && mins <= 360) {
        const session = windowFromDetail(detail);
        if (session && !windows.session) windows.session = session;
      }
    }
  }

  return Object.keys(windows).length ? windows : null;
}

async function request(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${BASE_URL()}/usages`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
    if (!res.ok) return { ok: false, reason: `http:${res.status}` };
    const body = await res.json();
    const windows = normalize(body);
    if (!windows) return { ok: false, reason: 'shape' };
    return { ok: true, ...windows };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

async function getLimits() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const token = await accessToken();
    const result = token ? await request(token) : { ok: false, reason: 'no-token' };

    if (result.ok) {
      lastGood = { at: Date.now(), data: result };
      cache = lastGood;
      return result;
    }
    if (lastGood && Date.now() - lastGood.at < STALE_MS && result.reason !== 'auth') {
      const stale = { ...lastGood.data, stale: true };
      cache = { at: Date.now(), data: stale };
      return stale;
    }
    cache = { at: Date.now(), data: result };
    return result;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

module.exports = { getLimits, normalize, windowFromDetail, minutesOf };
