// Earlier conversations, as the agents themselves remember them.
//
// TabDesk keeps no history of its own. Every CLI here already stores its
// sessions and can be told to pick one up again (`claude --resume <id>`,
// `codex resume <id>`), so the overview reads *their* stores rather than
// inventing a parallel one that would drift the moment a session is resumed
// from a terminal outside TabDesk.
//
// Everything below is read-only and bounded: these directories grow without
// limit (2 700 codex rollouts on the machine this was written for), and the
// overview is opened by a click, not by a background timer.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const opencodeStore = require('./opencode-store');
const kimiStore = require('./kimi-store');

const MAX_PER_AGENT = 10;       // rows worth showing before "older" is noise
const CACHE_MS = 60000;
const CLAUDE_MAX_FILES = 40;    // logs to open before giving up on finding ten
const CODEX_MAX_DAYS = 90;      // day directories to walk back through
const CODEX_MAX_FILES = 300;    // …and rollouts to open while doing it
const GROK_MAX_FILES = 40;      // summary.json files to inspect for ten rows
const META_BYTES = 16 * 1024;   // enough for codex's session_meta line
const MARK_BYTES = 64 * 1024;   // …and for the record claude marks a log with
// Both formats open with preamble — pasted diffs, project instructions, tool
// definitions — before anything a human said, so finding the first real turn
// means reading past it.
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

// ---- small readers -------------------------------------------------------
// Whole-file reads are out of the question: a single claude session log is
// routinely 300 KB, and the interesting records sit at one end or the other.

async function readAt(file, bytes, fromEnd) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const start = fromEnd ? Math.max(0, size - bytes) : 0;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

const readHead = (file, bytes) => readAt(file, bytes, false);
const readTail = (file, bytes) => readAt(file, bytes, true);

// These logs are JSON per line, but the lines are large and we only ever want
// one field out of them. Matching the field directly beats parsing megabytes of
// tool output to reach a title.
function unquote(raw) {
  try { return JSON.parse(`"${raw}"`); } catch (_) { return raw; }
}

function lastMatch(text, re) {
  let m = null;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last === null ? null : unquote(last);
}

function clip(s, n = 90) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// An id ends up spliced into the command a terminal starts with, so only ones
// that can't be anything but an id leave this module: no quotes, no spaces, and
// no leading dash for a CLI to read as a flag. Both agents name sessions with
// uuids; anything else in those directories is not ours to hand on.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function subdirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => e.name);
  } catch (_) {
    return [];
  }
}

// ---- Claude Code ---------------------------------------------------------
// One directory per working directory, named after the path with every
// character that isn't alphanumeric replaced by a dash, and one .jsonl per
// session named after its id — which is exactly what --resume takes.

function claudeDirFor(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// A project reached through a symlink has two spellings: the one the rail
// shows and the one the kernel handed the agent as its cwd. The agents key
// their stores on what they saw — the physical path — so every lookup here
// must accept either spelling of the same directory.
function spellingsOf(cwd) {
  const out = [String(cwd)];
  try {
    const real = fs.realpathSync(cwd);
    if (real && !out.includes(real)) out.push(real);
  } catch (_) { /* gone or unreadable — the literal spelling is all there is */ }
  return out;
}

// The title Claude Code gives a conversation, written again on every turn, so
// the last one in the file is the current one. Sessions too short to have been
// titled fall back to what was last typed into them.
function claudeTitle(text) {
  return lastMatch(text, /"aiTitle":"((?:[^"\\]|\\.)*)"/g)
    || lastMatch(text, /"lastPrompt":"((?:[^"\\]|\\.)*)"/g);
}

async function claudeSessions(cwd, root) {
  const spellings = spellingsOf(cwd);
  const base = root || path.join(os.homedir(), '.claude', 'projects');
  // Both spellings' directories are read and merged — logs can sit under
  // either, depending on which path the agent was started with over time.
  const dirs = [...new Set(spellings.map(claudeDirFor))].map((n) => path.join(base, n));

  const stats = [];
  for (const dir of dirs) {
    let names;
    try { names = await fsp.readdir(dir); } catch (_) { continue; }
    for (const name of names.filter((n) => n.endsWith('.jsonl') && SAFE_ID.test(n.slice(0, -6)))) {
      try {
        const st = await fsp.stat(path.join(dir, name));
        // born is when the session began (the file appears with it) — what a
        // live tab matches its own start time against, since mtime moves with
        // every turn and an old session picked up again looks brand new by it.
        stats.push({ dir, name, at: st.mtimeMs, born: st.birthtimeMs });
      } catch (_) { /* raced away */ }
    }
  }
  const newest = stats.sort((a, b) => b.at - a.at);

  const out = [];
  const seen = new Set();
  let opened = 0;
  for (const { dir, name, at, born } of newest) {
    if (out.length >= MAX_PER_AGENT || opened >= CLAUDE_MAX_FILES) break;
    const id = name.replace(/\.jsonl$/, '');
    if (seen.has(id)) continue;      // same session mirrored under both spellings
    seen.add(id);
    opened += 1;
    const file = path.join(dir, name);
    const head = await readHead(file, MARK_BYTES);

    // The directory name is derived, not read, so two different paths could in
    // principle sanitise to the same name. The file says which path it was
    // written for, and a resume that landed in another project's conversation
    // would be worse than an empty list.
    const owner = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
    if (owner && !spellings.includes(unquote(owner[1]))) continue;

    // A session the SDK started is a tool doing a job — a code review, a
    // subagent — not a conversation anybody means to pick up again. The
    // interactive ones say `cli`; a file too old or too odd to say keeps its
    // place rather than being guessed away.
    const entry = /"entrypoint":"([^"]*)"/.exec(head);
    if (entry && entry[1] !== 'cli') continue;

    // The title is rewritten on every turn, so the end of the log is where it
    // is cheapest to find — unless one enormous record fills that window, in
    // which case the first one written is still in the opening pages.
    const title = claudeTitle(await readTail(file, TAIL_BYTES))
      || claudeTitle(head)
      || claudeTitle(await readHead(file, HEAD_BYTES));
    out.push({
      agent: 'claude',
      id,
      title: title ? clip(title) : null,
      at,
      born,
    });
  }
  return out;
}

// ---- Codex ---------------------------------------------------------------
// Rollouts are filed by date, not by project, so finding a project's sessions
// means opening files until enough of them match. Only the first line (the
// session_meta record) is needed to decide, and the id is in the filename.

const CODEX_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function codexMeta(firstLine) {
  const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(firstLine);
  if (!cwd) return null;
  const originator = /"originator":"([^"]*)"/.exec(firstLine);
  return {
    cwd: unquote(cwd[1]),
    originator: originator ? originator[1] : null,
    // A thread another agent spawned is not a conversation anybody resumes by
    // hand; neither is a scripted `codex exec` run.
    skip: /"thread_source":"subagent"/.test(firstLine)
      || (originator ? originator[1] === 'codex_exec' : false),
  };
}

// What the user actually said first. The transcript opens with developer and
// tool preamble, so the first real turn comes after that context. Older Codex
// versions duplicate it as a user_message event; newer ones only keep the
// response_item.
function codexPrompt(value) {
  const prompt = typeof value === 'string' ? value.trim() : '';
  if (!prompt
    || prompt.startsWith('# AGENTS.md instructions for ')
    || prompt.startsWith('<environment_context>')) return null;
  return prompt;
}

function codexTitle(text) {
  for (const raw of text.split('\n')) {
    let record;
    try { record = JSON.parse(raw); } catch (_) { continue; }
    const payload = record && record.payload;
    if (record.type === 'event_msg' && payload?.type === 'user_message') {
      const prompt = codexPrompt(payload.message);
      if (prompt) return clip(prompt);
      continue;
    }
    if (record.type !== 'response_item'
      || !payload
      || payload.type !== 'message'
      || payload.role !== 'user'
      || !Array.isArray(payload.content)) continue;

    const prompt = payload.content
      .filter((item) => item && item.type === 'input_text' && typeof item.text === 'string')
      .map((item) => codexPrompt(item.text))
      .find(Boolean);
    if (prompt) return clip(prompt);
  }
  return null;
}

async function indexedCodexSessions(cwd, database) {
  try {
    if (!fs.existsSync(database)) return null;
  } catch (_) {
    return null;
  }
  const dirs = spellingsOf(cwd).map(opencodeStore.sqlString).join(', ');
  const rows = await opencodeStore.query(
    'SELECT id, title, first_user_message, created_at, updated_at, '
    + 'created_at_ms, updated_at_ms, recency_at_ms FROM threads '
    + `WHERE cwd IN (${dirs}) AND archived = 0 `
    + "AND source NOT IN ('exec', 'codex_exec', 'mcp') "
    + "AND source NOT LIKE '{\"subagent\"%' "
    + "AND COALESCE(thread_source, '') <> 'subagent' "
    + 'ORDER BY COALESCE(NULLIF(recency_at_ms, 0), NULLIF(updated_at_ms, 0), updated_at * 1000) DESC '
    + `LIMIT ${MAX_PER_AGENT}`,
    database);
  if (!rows) return null;

  const out = [];
  for (const row of rows) {
    const id = String(row.id || '');
    if (!SAFE_ID.test(id)) continue;
    const titleRaw = String(row.title || row.first_user_message || '').trim();
    const at = Number(row.recency_at_ms) || Number(row.updated_at_ms)
      || Number(row.updated_at) * 1000 || 0;
    const born = Number(row.created_at_ms) || Number(row.created_at) * 1000 || 0;
    out.push({ agent: 'codex', id, title: titleRaw ? clip(titleRaw) : null, at, born });
  }
  return out;
}

async function codexSessionTitles(ids, root) {
  const safe = [...new Set(Array.isArray(ids) ? ids : [])]
    .filter((id) => typeof id === 'string' && SAFE_ID.test(id))
    .slice(0, 64);
  const out = new Map();
  if (!safe.length) return out;
  const database = root || path.join(os.homedir(), '.codex', 'state_5.sqlite');
  try {
    if (!fs.existsSync(database)) return out;
  } catch (_) {
    return out;
  }
  const rows = await opencodeStore.query(
    'SELECT id, title, first_user_message FROM threads '
    + `WHERE id IN (${safe.map(opencodeStore.sqlString).join(', ')})`,
    database);
  for (const row of rows || []) {
    const id = String(row.id || '');
    const title = String(row.title || row.first_user_message || '').trim();
    if (SAFE_ID.test(id) && title) out.set(id, clip(title));
  }
  return out;
}

async function codexDays(root) {
  const out = [];
  for (const year of (await subdirs(root)).sort().reverse()) {
    for (const month of (await subdirs(path.join(root, year))).sort().reverse()) {
      const dir = path.join(root, year, month);
      for (const day of (await subdirs(dir)).sort().reverse()) {
        out.push(path.join(dir, day));
        if (out.length >= CODEX_MAX_DAYS) return out;
      }
    }
  }
  return out;
}

async function rolloutCodexSessions(cwd, root) {
  const spellings = spellingsOf(cwd);
  const base = root || path.join(os.homedir(), '.codex', 'sessions');
  const out = [];
  let opened = 0;

  for (const day of await codexDays(base)) {
    if (out.length >= MAX_PER_AGENT || opened >= CODEX_MAX_FILES) break;
    let names;
    try { names = await fsp.readdir(day); } catch (_) { continue; }
    // The filename carries the start time, so name order is time order.
    for (const name of names.filter((n) => CODEX_ID.test(n)).sort().reverse()) {
      if (out.length >= MAX_PER_AGENT || opened >= CODEX_MAX_FILES) break;
      opened += 1;
      const file = path.join(day, name);
      const head = await readHead(file, META_BYTES);
      const nl = head.indexOf('\n');
      const meta = codexMeta(nl > 0 ? head.slice(0, nl) : head);
      if (!meta || meta.skip || !spellings.includes(meta.cwd)) continue;

      const [body, st] = await Promise.all([
        readHead(file, HEAD_BYTES),
        fsp.stat(file).catch(() => null),
      ]);
      out.push({
        agent: 'codex',
        id: CODEX_ID.exec(name)[1],
        title: codexTitle(body),
        at: st ? st.mtimeMs : 0,
        born: st ? st.birthtimeMs : 0,
      });
    }
  }
  return out;
}

async function codexSessions(cwd, root) {
  const explicitDatabase = typeof root === 'string' && path.extname(root) === '.sqlite';
  const database = explicitDatabase
    ? root
    : (!root ? path.join(os.homedir(), '.codex', 'state_5.sqlite') : null);
  if (database) {
    const indexed = await indexedCodexSessions(cwd, database);
    if (indexed) return indexed;
    if (explicitDatabase) return [];
  }
  return rolloutCodexSessions(cwd, root);
}

// ---- opencode ------------------------------------------------------------
// Sessions live in one SQLite database, keyed by the project directory the
// CLI was started in. Subagents (parent_id set) are jobs, not conversations
// anybody resumes by hand — same cut Codex makes for thread_source=subagent.

async function opencodeSessions(cwd, root) {
  const spellings = spellingsOf(cwd);
  if (!spellings.length) return [];
  const dirs = spellings.map(opencodeStore.sqlString).join(', ');
  const sql = 'SELECT id, title, time_created, time_updated FROM session '
    + `WHERE directory IN (${dirs}) `
    + 'AND parent_id IS NULL '
    + 'AND time_archived IS NULL '
    + 'ORDER BY time_updated DESC '
    + `LIMIT ${MAX_PER_AGENT}`;
  const rows = await opencodeStore.query(sql, root || undefined);
  if (!rows) return [];

  const out = [];
  for (const row of rows) {
    const id = String(row.id || '');
    if (!SAFE_ID.test(id)) continue;
    const title = row.title != null && String(row.title).trim()
      ? clip(String(row.title))
      : null;
    const at = Number(row.time_updated) || 0;
    const born = Number(row.time_created) || 0;
    out.push({ agent: 'opencode', id, title, at, born });
  }
  return out;
}

// ---- Kimi Code -----------------------------------------------------------
// session_index.jsonl lists every session; state.json holds title and times.
// workDir is the project path the CLI was started in (docs: data-locations).

// Async like the other providers — previousSessions always .catch()s the result.
async function kimiSessions(cwd, root) {
  const spellings = new Set(spellingsOf(cwd));
  if (!spellings.size) return [];
  const rows = kimiStore.readIndex(root || undefined);
  const out = [];
  for (const row of rows) {
    if (!spellings.has(row.workDir)) continue;
    const id = row.sessionId;
    if (!SAFE_ID.test(id)) continue;
    // Fixture roots keep sessionDir relative under the test home; live index
    // stores absolute paths. Resolve against the home when not absolute.
    const home = kimiStore.home(root || undefined);
    const sessionDir = path.isAbsolute(row.sessionDir)
      ? row.sessionDir
      : path.join(home, row.sessionDir);
    const state = kimiStore.readState(sessionDir) || {};
    const titleRaw = state.title || state.lastPrompt || null;
    const title = titleRaw != null && String(titleRaw).trim()
      ? clip(String(titleRaw))
      : null;
    const at = Date.parse(state.updatedAt || '') || 0;
    const born = Date.parse(state.createdAt || '') || 0;
    out.push({ agent: 'kimi', id, title, at, born });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, MAX_PER_AGENT);
}

// ---- Grok ---------------------------------------------------------------
// One directory per cwd (URL-encoded), then one directory per session. The
// small summary.json is the index; updates.jsonl stays unopened until the user
// asks to read that conversation.

function grokRoot(root) {
  if (root) return root;
  const home = process.env.GROK_HOME && String(process.env.GROK_HOME).trim();
  return path.join(home ? path.resolve(home) : path.join(os.homedir(), '.grok'), 'sessions');
}

function grokGroupDirs(cwd, root) {
  const base = grokRoot(root);
  const spellings = spellingsOf(cwd);
  const out = [];
  let needsMarkerScan = false;
  for (const spelling of spellings) {
    const name = encodeURIComponent(spelling);
    needsMarkerScan ||= Buffer.byteLength(name) > 255;
    const dir = path.join(base, name);
    try { if (fs.statSync(dir).isDirectory()) out.push(dir); } catch (_) { /* absent */ }
  }
  if (!needsMarkerScan) return [...new Set(out)];

  // Overlong encoded names are replaced by a slug+hash. Grok records the real
  // cwd in a .cwd marker, so only this uncommon case needs a root scan.
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return [...new Set(out)]; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    if (out.includes(dir)) continue;
    try {
      const owner = fs.readFileSync(path.join(dir, '.cwd'), 'utf8').replace(/\r?\n$/, '');
      if (spellings.includes(owner)) out.push(dir);
    } catch (_) { /* not an overlong group */ }
  }
  return [...new Set(out)];
}

function grokSummary(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function grokSessionDir(cwd, sessionId, root) {
  if (!SAFE_ID.test(String(sessionId || ''))) return null;
  const spellings = spellingsOf(cwd);
  for (const group of grokGroupDirs(cwd, root)) {
    const dir = path.join(group, sessionId);
    const summary = grokSummary(path.join(dir, 'summary.json'));
    if (summary?.session_kind === 'subagent') continue;
    if (summary?.info?.id === sessionId && spellings.includes(summary.info.cwd)) return dir;
  }
  return null;
}

async function grokSessions(cwd, root) {
  const spellings = spellingsOf(cwd);
  const candidates = [];
  for (const group of grokGroupDirs(cwd, root)) {
    let entries;
    try { entries = await fsp.readdir(group, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const file = path.join(group, entry.name, 'summary.json');
      const st = await fsp.stat(file).catch(() => null);
      if (st?.isFile()) candidates.push({ id: entry.name, file, st });
    }
  }
  candidates.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

  const out = [];
  const seen = new Set();
  for (const { id, file, st } of candidates.slice(0, GROK_MAX_FILES)) {
    if (seen.has(id)) continue;
    let summary;
    try { summary = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { continue; }
    if (summary?.session_kind === 'subagent'
      || summary?.info?.id !== id
      || !spellings.includes(summary?.info?.cwd)) continue;
    seen.add(id);
    const titleRaw = summary.generated_title || summary.session_summary || null;
    out.push({
      agent: 'grok',
      id,
      title: titleRaw != null && String(titleRaw).trim() ? clip(titleRaw) : null,
      at: Date.parse(summary.updated_at || summary.last_active_at || '') || st.mtimeMs,
      born: Date.parse(summary.created_at || '') || st.birthtimeMs,
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_PER_AGENT);
}

// ---- Droid (Factory CLI) -------------------------------------------------
// One flat index (sessions-index.json) lists the user-visible sessions with
// their cwd, title and mtime; the per-session transcript lives under
// sessions/<slug>/<id>.jsonl, the slug being the cwd with each path character
// dashed exactly as Claude does it. The index does not carry whether a session
// was spawned by another (a subagent), so that one fact is read from the first
// line of the transcript — a session_start record whose callingSessionId names
// the parent when it has one.

function droidBase(root) {
  return root || path.join(os.homedir(), '.factory');
}

function droidIndexEntries(base) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(base, 'sessions-index.json'), 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch (_) {
    return [];
  }
}

async function droidIsSubagent(file) {
  const head = await readHead(file, MARK_BYTES);
  const nl = head.indexOf('\n');
  const firstLine = nl >= 0 ? head.slice(0, nl) : head;
  try {
    const start = JSON.parse(firstLine);
    return start != null && start.callingSessionId != null;
  } catch (_) {
    // No readable session_start (missing or truncated file) — treat it as a
    // top-level session rather than guessing it away; the index listed it.
    return false;
  }
}

async function droidSessions(cwd, root) {
  const base = droidBase(root);
  const spellings = new Set(spellingsOf(cwd));
  const candidates = droidIndexEntries(base)
    .filter((e) => e && spellings.has(e.cwd) && SAFE_ID.test(String(e.sessionId || '')))
    .sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));

  const out = [];
  for (const entry of candidates) {
    if (out.length >= MAX_PER_AGENT) break;
    const id = String(entry.sessionId);
    const file = path.join(base, 'sessions', claudeDirFor(entry.cwd), `${id}.jsonl`);
    if (await droidIsSubagent(file)) continue;
    const st = await fsp.stat(file).catch(() => null);
    const titleRaw = entry.title != null && String(entry.title).trim() ? String(entry.title) : null;
    out.push({
      agent: 'droid',
      id,
      title: titleRaw ? clip(titleRaw) : null,
      at: Number(entry.mtime) || (st ? st.mtimeMs : 0),
      born: st ? st.birthtimeMs : (Number(entry.mtime) || 0),
    });
  }
  return out;
}

// ---- what the overview asks for ------------------------------------------

const PROVIDERS = {
  claude: claudeSessions,
  codex: codexSessions,
  opencode: opencodeSessions,
  kimi: kimiSessions,
  grok: grokSessions,
  droid: droidSessions,
};

// Opening the overview should not re-walk the codex store for every repaint,
// and these lists change on the scale of conversations, not seconds.
const cache = new Map();

// `roots` overrides where an agent's store is looked for, which is how the
// tests read a store they built rather than the one on the machine.
async function previousSessions(cwd, agentIds, roots) {
  if (typeof cwd !== 'string' || !cwd) return [];
  const where = roots || {};
  const wanted = (Array.isArray(agentIds) ? agentIds : Object.keys(PROVIDERS))
    .filter((id) => PROVIDERS[id]);
  // Keyed on the resolved spelling so the same project asked for through its
  // symlink and through its target shares one cache entry.
  const spellings = spellingsOf(cwd);
  const key = `${spellings[spellings.length - 1]}|${wanted.join(',')}|${wanted.map((id) => where[id] || '').join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;

  const found = await Promise.all(wanted.map((id) => PROVIDERS[id](cwd, where[id]).catch(() => [])));
  const rows = found.flat().sort((a, b) => b.at - a.at);
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

module.exports = {
  previousSessions,
  // Exported for the tests, which drive the parsers directly rather than
  // depending on whatever conversations happen to be on the machine.
  claudeDirFor, spellingsOf, claudeTitle, claudeSessions, codexMeta, codexTitle, codexSessions,
  codexSessionTitles,
  opencodeSessions,
  kimiSessions,
  grokSessions,
  grokSessionDir,
  droidSessions,
};
