// Plan limits as Factory's own /api/billing/limits reports them.
//
// Same approach as usage-limits.js for Claude: borrow the access token the
// Droid CLI already keeps under ~/.factory/auth.v2.keyring (AES-256-GCM
// encrypted, key from the OS keyring via keytar) and read the account's usage
// windows straight from the endpoint the CLI uses.
//
// Two consequences worth knowing:
//   * the endpoint is not a documented public API. It can change shape without
//     warning, which is why every field is looked up defensively below and why
//     a failure degrades to "no data" instead of blanking the bar.
//   * the token is read, never written, never logged, and only ever sent to
//     api.factory.ai — the same place the CLI sends it. Unlike kimi-limits,
//     which rotates and writes back refreshed tokens, this module only reads.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// keytar.node is ABI 137 (Node 24); Electron 31 is ABI 115. The native addon
// cannot be require()'d from Electron's main process, so a child node process
// is spawned to call keytar and hand the key back over stdout.
const NODE_BIN = process.env.TABDESK_NODE_BIN || '/usr/bin/node';
const KEYTAR_NODE = () => process.env.TABDESK_KEYTAR_NODE
  || path.join(os.homedir(), '.factory', 'bin', 'keytar.node');
const KEYRING_FILE = () => process.env.TABDESK_KEYRING_FILE
  || path.join(os.homedir(), '.factory', 'auth.v2.keyring');
const KEYTAR_SERVICE = 'Factory CLI';
const KEYTAR_ACCOUNT = 'auth-encryption-key';
const API_BASE = () => (process.env.FACTORY_API_BASE_URL || 'https://api.factory.ai').replace(/\/+$/, '');
const KEYTAR_TIMEOUT_MS = 10000;

const TTL_MS = 60000;
// A blip shouldn't wipe the meters. Keep serving the last good read (flagged
// stale) for a while before giving up and letting the caller fall back.
const STALE_MS = 15 * 60000;
// Refresh the token a minute before the JWT says it expires.
const SKEW_S = 60;

let cache = null;       // { at, data }
let lastGood = null;    // { at, data }
let inFlight = null;
let tokenCache = null;  // { token, exp }

// ---- Token acquisition (child process keytar + AES-256-GCM) ----

// Spawn a system node process to load keytar.node (ABI mismatch workaround)
// and read the encryption key from the OS keyring. Returns the base64 key
// string or null on any failure (node missing, keytar load error, keyring
// locked). Never rejects.
function keytarKey() {
  return new Promise((resolve) => {
    let child;
    try {
      const script = [
        'const keytar = require(' + JSON.stringify(KEYTAR_NODE()) + ');',
        'Promise.resolve(keytar.getPassword('
          + JSON.stringify(KEYTAR_SERVICE) + ', ' + JSON.stringify(KEYTAR_ACCOUNT) + '))',
        '  .then((key) => { process.stdout.write(key || ""); process.exit(0); })',
        '  .catch(() => process.exit(1));',
      ].join('\n');
      child = spawn(NODE_BIN, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) {
      resolve(null);
      return;
    }

    let stdout = '';
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code !== 0 || !stdout) { done(null); return; }
      done(stdout.trim());
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      done(null);
    }, KEYTAR_TIMEOUT_MS);
  });
}

// Decrypt ~/.factory/auth.v2.keyring with the keytar key. The file is three
// colon-separated base64 parts: IV, authTag, ciphertext. The key from keytar is
// base64-encoded (44 chars → 32 bytes) and must be decoded before AES-256-GCM.
// Returns the decrypted JSON object or null on any failure. Never throws.
function decryptKeyring(keyB64) {
  let keyBuf;
  try { keyBuf = Buffer.from(keyB64, 'base64'); }
  catch (_) { return null; }
  if (!keyBuf || keyBuf.length !== 32) return null;

  let raw;
  try { raw = fs.readFileSync(KEYRING_FILE(), 'utf8'); }
  catch (_) { return null; }

  const parts = raw.trim().split(':');
  if (parts.length < 3) return null;
  const [ivB64, authTagB64, ...rest] = parts;
  const cipherB64 = rest.join(':');
  if (!ivB64 || !authTagB64 || !cipherB64) return null;

  let iv, authTag, ciphertext;
  try {
    iv = Buffer.from(ivB64, 'base64');
    authTag = Buffer.from(authTagB64, 'base64');
    ciphertext = Buffer.from(cipherB64, 'base64');
  } catch (_) { return null; }
  if (!iv.length || !authTag.length || !ciphertext.length) return null;

  let json;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    json = JSON.parse(plain.toString('utf8'));
  } catch (_) { return null; }

  if (!json || typeof json !== 'object') return null;
  return json;
}

// Decode the `exp` claim from a JWT without verifying the signature. Returns
// the expiry as Unix seconds, or null if the payload can't be parsed.
function decodeJwtExp(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    const exp = payload && payload.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch (_) { return null; }
}

// Acquire the access token: cache it with a JWT-expiry check, re-decrypt only
// when expired. Returns the token string or null on any failure. Never throws.
async function accessToken() {
  const nowS = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp && tokenCache.exp > nowS + SKEW_S) {
    return tokenCache.token;
  }

  const key = await keytarKey();
  if (!key) { tokenCache = null; return null; }

  const creds = decryptKeyring(key);
  if (!creds) { tokenCache = null; return null; }

  const token = typeof creds.access_token === 'string' ? creds.access_token : null;
  if (!token) { tokenCache = null; return null; }

  const exp = decodeJwtExp(token);
  tokenCache = { token, exp: exp || (nowS + 900) };
  return token;
}

// ---- Response normalisation ----
// The payload carries usage windows under limits.standard. The 5-hour window
// is the session meter; the weekly window is the week meter. Windows the plan
// doesn't meter are simply absent, like a Claude account without a scoped limit.

function toReset(raw, now) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

// Map a single API window object onto the shared meter shape. A reset time
// that has already passed means the percentage predates the current window —
// it describes usage that no longer counts, so the window is dropped.
function mapWindow(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const pct = raw.usedPercent;
  if (typeof pct !== 'number' || !isFinite(pct)) return null;

  let resetsAt = toReset(raw.windowEnd, now);
  if (resetsAt === null && typeof raw.secondsRemaining === 'number' && Number.isFinite(raw.secondsRemaining)) {
    resetsAt = now + raw.secondsRemaining * 1000;
  }
  // An expired reset means the percentage is stale for the current window.
  if (resetsAt !== null && resetsAt < now) return null;

  return {
    pct: Math.max(0, Math.min(100, pct)),
    resetsAt,
    severity: null,
    label: null,
  };
}

// Map the full API response onto { session?, week? }. Exported so the response
// shape can be checked against a captured payload without going near the
// network or the credential file.
function normalize(body, now) {
  if (!body || typeof body !== 'object') return null;
  const standard = body.limits && body.limits.standard;
  if (!standard || typeof standard !== 'object') return null;

  const windows = {};
  const session = mapWindow(standard.fiveHour, now);
  if (session) windows.session = session;
  const week = mapWindow(standard.weekly, now);
  if (week) windows.week = week;

  return Object.keys(windows).length ? windows : null;
}

async function request(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_BASE()}/api/billing/limits`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
    if (!res.ok) return { ok: false, reason: `http:${res.status}` };
    const body = await res.json();
    const windows = normalize(body, Date.now());
    if (!windows) return { ok: false, reason: 'shape' };
    return { ok: true, ...windows };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Returns { ok: true, session?, week?, stale? } or { ok: false, reason }.
// Never throws: the bar is a readout, not a workflow.
async function getLimits() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const token = await accessToken();
    const result = token ? await request(token) : { ok: false, reason: 'keyring-locked' };

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

module.exports = { getLimits, normalize, mapWindow, decodeJwtExp };
