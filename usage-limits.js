// Plan limits as Claude Code's own /usage reports them.
//
// The numbers behind /usage are not on disk anywhere — the CLI asks the API for
// them at render time. So we do the same: borrow the OAuth access token Claude
// Code already stored in ~/.claude/.credentials.json and read the account's
// usage windows straight from the endpoint.
//
// Two consequences worth knowing:
//   * the endpoint is not a documented public API. It can change shape without
//     warning, which is why every field is looked up defensively below and why
//     a failure degrades to the local token estimate instead of blanking the
//     bar (see renderer refreshUsage).
//   * the token is read, never written, never logged, and only ever sent to
//     api.anthropic.com — the same place the CLI sends it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');
const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const BETA = 'oauth-2025-04-20';

// The endpoint is rate-limited like any other; the bar refreshes far more often
// than the numbers move, so serve a cached answer in between.
const TTL_MS = 60000;
// A blip shouldn't wipe the meters. Keep serving the last good read (flagged
// stale) for a while before giving up and letting the caller fall back.
const STALE_MS = 15 * 60000;

let cache = null;      // { at, data }
let lastGood = null;   // { at, data }
let inFlight = null;

function readToken() {
  // An explicitly exported token wins — that's how you'd point TabDesk at a
  // different account than the one the CLI is logged into.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;

  let creds;
  try { creds = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8')); } catch (_) { return null; }

  // Known shape first, then a defensive walk — the file has been reorganised
  // between CLI versions before.
  const known = creds.claudeAiOauth && creds.claudeAiOauth.accessToken;
  if (typeof known === 'string' && known) return known;

  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && v && /access/i.test(k) && /token/i.test(k)) return v;
      const hit = walk(v);
      if (hit) return hit;
    }
    return null;
  };
  return walk(creds);
}

// ---- Response normalisation ----
// The payload carries the same windows twice: a `limits` array keyed by `kind`,
// and older top-level objects (five_hour, seven_day, seven_day_opus…). Prefer
// the array — it names its windows, carries a severity, and says which model a
// scoped limit applies to. The top-level objects are the fallback for an older
// account/server that doesn't send it.
//
// Windows the account doesn't have come back as null (most of them do), so a
// missing window is normal and means "don't show a meter", not "error".
const KIND_MAP = {
  session: 'session',
  weekly_all: 'week',
  weekly_scoped: 'scoped',
};

function toPct(raw) {
  // Both `percent` and `utilization` are on a 0–100 scale (verified against a
  // live response) — do not "helpfully" rescale small values.
  if (typeof raw !== 'number' || !isFinite(raw)) return null;
  return Math.max(0, Math.min(100, raw));
}

function toReset(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000; // epoch ms or s
  const ms = Date.parse(raw);
  return isFinite(ms) ? ms : null;
}

// A scoped weekly limit belongs to one model; the meter borrows its name rather
// than hard-coding whichever model happened to be capped when this was written.
function scopeLabel(entry) {
  const model = entry && entry.scope && entry.scope.model;
  const name = model && (model.display_name || model.id);
  return typeof name === 'string' && name ? name : null;
}

function fromLimitsArray(list) {
  const windows = {};
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const key = KIND_MAP[entry.kind];
    if (!key || windows[key]) continue;
    const pct = toPct(entry.percent);
    if (pct === null) continue;
    windows[key] = {
      pct,
      resetsAt: toReset(entry.resets_at),
      severity: typeof entry.severity === 'string' ? entry.severity : null,
      label: key === 'scoped' ? scopeLabel(entry) : null,
    };
  }
  return windows;
}

const LEGACY = [
  ['session', 'five_hour', null],
  ['week', 'seven_day', null],
  ['scoped', 'seven_day_opus', 'Opus'],
  ['scoped', 'seven_day_sonnet', 'Sonnet'],
];

function fromLegacyFields(body) {
  const windows = {};
  for (const [key, field, label] of LEGACY) {
    if (windows[key]) continue;
    const entry = body[field];
    if (!entry || typeof entry !== 'object') continue;
    const pct = toPct(entry.utilization);
    if (pct === null) continue;
    windows[key] = { pct, resetsAt: toReset(entry.resets_at), severity: null, label };
  }
  return windows;
}

function normalize(body) {
  if (!body || typeof body !== 'object') return null;
  const windows = Array.isArray(body.limits) && body.limits.length
    ? fromLimitsArray(body.limits)
    : fromLegacyFields(body);
  return Object.keys(windows).length ? windows : null;
}

async function request(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': BETA,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
    if (!res.ok) return { ok: false, reason: `http:${res.status}` };
    const body = await res.json();
    const windows = normalize(body);
    if (!windows) return { ok: false, reason: 'shape', keys: Object.keys(body || {}) };
    return { ok: true, ...windows };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Returns { ok: true, session?, week?, opus?, stale? } or { ok: false, reason }.
// Never throws: the bar is a readout, not a workflow.
async function getLimits() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const token = readToken();
    const result = token ? await request(token) : { ok: false, reason: 'no-token' };

    if (result.ok) {
      lastGood = { at: Date.now(), data: result };
      cache = lastGood;
      return result;
    }
    // Ride out a transient failure on the last good read.
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

// normalize is exported so the response shape can be checked against a captured
// payload without going near the network or the credential file.
module.exports = { getLimits, normalize };
