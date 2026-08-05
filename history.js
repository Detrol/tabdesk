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
// tool preamble, so the first real turn is the one Codex records as a
// user_message event.
function codexTitle(text) {
  const m = /"user_message"[^\n]{0,120}?"message":"((?:[^"\\]|\\.)*)"/.exec(text);
  return m ? clip(unquote(m[1])) : null;
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

async function codexSessions(cwd, root) {
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

// ---- what the overview asks for ------------------------------------------

const PROVIDERS = {
  claude: claudeSessions,
  codex: codexSessions,
  opencode: opencodeSessions,
  kimi: kimiSessions,
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
  opencodeSessions,
  kimiSessions,
};
