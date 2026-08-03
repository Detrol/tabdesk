// Codex plan limits, read the only place they exist locally: the rollout files
// under ~/.codex/sessions. Codex has no /usage endpoint we can borrow a token
// for, but every response it streams carries a rate_limits snapshot which the
// CLI appends to the session's rollout .jsonl — so the freshest rollout's last
// snapshot is exactly what its own /status shows.
//
// Shape matches usage-limits.js on purpose ({ ok, session?, week?, stale? }),
// so the renderer's plan-meter path renders either source unchanged. The
// windows come as primary/secondary with a window_minutes each; the long one
// is the week, a short one (5h) the session. Windows the plan doesn't meter
// are simply absent, like a Claude account without a scoped limit.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS = () => path.join(os.homedir(), '.codex', 'sessions');

// Resuming a session appends to its original rollout file, which can live in a
// weeks-old day directory — so the newest *write* is what matters, and only
// walking today's directory would miss it. Walking everything is unbounded the
// other way. Thirty day-directories back covers any plausible live session.
const DAY_DIRS_BACK = 30;

const TTL_MS = 60000;
// A snapshot in a rollout nobody has written to for a while is still the best
// number we have, but say so — same stale flag the Claude reader raises.
const FRESH_MS = 15 * 60000;

// Day directories are sessions/YYYY/MM/DD. Collect the newest DAY_DIRS_BACK of
// them by name (names sort as dates), then pick the rollout with the newest
// mtime across that window.
function newestRollout(root) {
  const dirs = [];
  let years;
  try { years = fs.readdirSync(root).filter((d) => /^\d{4}$/.test(d)).sort().reverse(); }
  catch (_) { return null; }
  for (const y of years) {
    let months;
    try { months = fs.readdirSync(path.join(root, y)).filter((d) => /^\d{2}$/.test(d)).sort().reverse(); }
    catch (_) { continue; }
    for (const m of months) {
      let days;
      try { days = fs.readdirSync(path.join(root, y, m)).filter((d) => /^\d{2}$/.test(d)).sort().reverse(); }
      catch (_) { continue; }
      for (const d of days) {
        dirs.push(path.join(root, y, m, d));
        if (dirs.length >= DAY_DIRS_BACK) break;
      }
      if (dirs.length >= DAY_DIRS_BACK) break;
    }
    if (dirs.length >= DAY_DIRS_BACK) break;
  }

  let best = null;
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

// Balanced-brace scan from an opening '{'. The snapshots sit inside JSONL
// lines, so a plain JSON.parse needs to know where the object ends first.
// Quotes are tracked because a string value could contain braces.
function braceSlice(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const WEEK_MINUTES = 7 * 24 * 60;

function toWindow(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const pct = raw.used_percent;
  if (typeof pct !== 'number' || !isFinite(pct)) return null;
  const resetsAt = typeof raw.resets_at === 'number'
    ? (raw.resets_at > 1e12 ? raw.resets_at : raw.resets_at * 1000)
    : null;
  // A reset that has already passed means the percentage predates the current
  // window — it describes usage that no longer counts. Dropping it beats
  // showing a number known to be wrong.
  if (resetsAt !== null && resetsAt < now) return null;
  return {
    pct: Math.max(0, Math.min(100, pct)),
    resetsAt,
    severity: null,
    label: null,
    minutes: typeof raw.window_minutes === 'number' ? raw.window_minutes : null,
  };
}

// Parse the LAST rate_limits snapshot in the given text into the meter shape.
// Exported for tests; pure apart from the `now` injection.
function parseRateLimits(text, now) {
  const at = text.lastIndexOf('"rate_limits"');
  if (at === -1) return null;
  const open = text.indexOf('{', at);
  if (open === -1) return null;
  const json = braceSlice(text, open);
  if (!json) return null;
  let snap;
  try { snap = JSON.parse(json); } catch (_) { return null; }

  const windows = {};
  for (const raw of [snap.primary, snap.secondary]) {
    const win = toWindow(raw, now);
    if (!win) continue;
    const key = win.minutes !== null && win.minutes >= WEEK_MINUTES ? 'week' : 'session';
    delete win.minutes;
    if (!windows[key]) windows[key] = win;
  }
  return Object.keys(windows).length ? windows : null;
}

// The snapshot sits at the tail of the file; reading the whole rollout (they
// grow to many MB) for its last lines would be waste.
const TAIL_BYTES = 256 * 1024;

function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* already closed */ }
  }
}

let cache = null; // { at, data }

// Returns { ok: true, session?, week?, stale? } or { ok: false, reason }.
// Never throws — the bar is a readout, not a workflow.
async function getLimits() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;

  let data;
  const newest = newestRollout(SESSIONS());
  if (!newest) data = { ok: false, reason: 'no-data' };
  else {
    const tail = readTail(newest.file);
    const windows = tail && parseRateLimits(tail, now);
    data = windows
      ? { ok: true, ...windows, ...(now - newest.mtimeMs > FRESH_MS ? { stale: true } : {}) }
      : { ok: false, reason: 'no-data' };
  }
  cache = { at: now, data };
  return data;
}

module.exports = { getLimits, parseRateLimits, newestRollout };
