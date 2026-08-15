// A conversation as plain text, read from the agent's own store.
//
// Why this exists: fullscreen TUI renderers keep their scrollback to
// themselves. Neither the terminal nor tmux ever sees more than the screen in
// front of you (capture-pane on a live pane returns exactly the pane height),
// so there is nowhere else to get the earlier part of a conversation from.
//
// Claude Code keeps one .jsonl per session under ~/.claude/projects.
// opencode keeps messages and parts in ~/.local/share/opencode/opencode.db.
// Both are read-only here; the output is for reading and copying, not for
// round-tripping. Thinking/reasoning is left out — it dwarfs the answer and
// is not what anyone means to copy.

const fs = require('fs');
const path = require('path');
const os = require('os');
const history = require('./history');
const opencodeStore = require('./opencode-store');
const kimiStore = require('./kimi-store');

const MAX_BYTES = 8 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool_use') parts.push(`[${block.name || 'tool'}]`);
    else if (block.type === 'tool_result') {
      const c = block.content;
      const body = typeof c === 'string' ? c : textOf(c);
      if (body) parts.push(body);
    }
  }
  return parts.join('\n');
}

function rootsOf(root) {
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    return { claude: root.claude, opencode: root.opencode, kimi: root.kimi, grok: root.grok };
  }
  return {
    claude: typeof root === 'string' ? root : undefined,
    opencode: undefined,
    kimi: undefined,
    grok: undefined,
  };
}

// The transcript file for one Claude session id, under either spelling of the
// project (a symlinked project is keyed physically — see history.spellingsOf).
function fileFor(cwd, sessionId, root) {
  if (!SAFE_ID.test(String(sessionId || ''))) return null;
  const { claude } = rootsOf(root);
  const base = claude || path.join(os.homedir(), '.claude', 'projects');
  for (const spelling of history.spellingsOf(cwd)) {
    const file = path.join(base, history.claudeDirFor(spelling), `${sessionId}.jsonl`);
    try { if (fs.statSync(file).isFile()) return file; } catch (_) { /* try the other */ }
  }
  return null;
}

function readClaude(cwd, sessionId, root) {
  const file = fileFor(cwd, sessionId, root);
  if (!file) return null;
  let raw;
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, MAX_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      raw = buf.toString('utf8');
    } finally { try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  } catch (_) {
    return null;
  }

  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const body = textOf(rec.message && rec.message.content).trim();
    if (!body) continue;
    if (rec.type === 'user' && /^<(local-command|command-name|system-reminder)/.test(body)) continue;
    out.push(rec.type === 'user' ? `\n› ${body}\n` : body);
  }
  return out.length ? out.join('\n') : null;
}

// opencode stores one row per message and one per part. Text parts are the
// readable turns; tools are named rather than dumped (same rule as Claude).
async function readOpencode(cwd, sessionId, dbFile) {
  if (!SAFE_ID.test(String(sessionId || ''))) return null;
  const id = opencodeStore.sqlString(sessionId);
  const spellings = history.spellingsOf(cwd);
  if (!spellings.length) return null;

  const meta = await opencodeStore.query(
    `SELECT directory FROM session WHERE id = ${id} LIMIT 1`,
    dbFile,
  );
  if (!meta || !meta.length) return null;
  const directory = meta[0].directory;
  if (directory && !spellings.includes(directory)) return null;

  const rows = await opencodeStore.query(
    'SELECT m.data AS message, p.data AS part '
    + 'FROM message m '
    + 'JOIN part p ON p.message_id = m.id '
    + `WHERE m.session_id = ${id} `
    + 'ORDER BY m.time_created ASC, p.time_created ASC, p.id ASC',
    dbFile,
  );
  if (!rows || !rows.length) return null;

  const out = [];
  let lastUserKey = null;
  for (const row of rows) {
    let message;
    let part;
    try {
      message = typeof row.message === 'string' ? JSON.parse(row.message) : row.message;
      part = typeof row.part === 'string' ? JSON.parse(row.part) : row.part;
    } catch (_) { continue; }
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'tool') {
      const name = part.tool || part.name || 'tool';
      out.push(`[${name}]`);
      continue;
    }
    if (part.type !== 'text' || typeof part.text !== 'string') continue;
    const body = part.text.trim();
    if (!body) continue;

    const role = message && message.role === 'user' ? 'user' : 'assistant';
    if (role === 'user') {
      // One user turn can have several text parts; only label the first.
      const key = `${message && message.id}|user`;
      if (key !== lastUserKey) {
        out.push(`\n› ${body}\n`);
        lastUserKey = key;
      } else {
        out.push(body);
      }
    } else {
      out.push(body);
    }
  }
  return out.length ? out.join('\n') : null;
}

// Kimi Code: agents/main/wire.jsonl event stream (docs: sessions). Schema is
// not published — shapes pinned against live 0.28.x wires and fixtures.
// user → turn.prompt; assistant text → content.part text; tools → tool.call;
// thinking is skipped (same rule as Claude/opencode).
function readKimi(cwd, sessionId, root) {
  if (!SAFE_ID.test(String(sessionId || ''))) return null;
  const spellings = new Set(history.spellingsOf(cwd));
  if (!spellings.size) return null;
  const { kimi } = rootsOf(root);
  const home = kimiStore.home(kimi || undefined);
  const rows = kimiStore.readIndex(kimi || undefined);
  const hit = rows.find((r) => r.sessionId === sessionId && spellings.has(r.workDir));
  if (!hit) return null;
  const sessionDir = path.isAbsolute(hit.sessionDir)
    ? hit.sessionDir
    : path.join(home, hit.sessionDir);
  const wire = kimiStore.wirePath(sessionDir);
  if (!wire) return null;
  let raw;
  try {
    const st = fs.statSync(wire);
    const fd = fs.openSync(wire, 'r');
    try {
      const len = Math.min(st.size, MAX_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      raw = buf.toString('utf8');
    } finally { try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  } catch (_) {
    return null;
  }

  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec || typeof rec !== 'object') continue;

    if (rec.type === 'turn.prompt' && Array.isArray(rec.input)) {
      const parts = [];
      for (const block of rec.input) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
      const body = parts.join('\n').trim();
      if (body) out.push(`\n› ${body}\n`);
      continue;
    }

    if (rec.type === 'context.append_loop_event' && rec.event && typeof rec.event === 'object') {
      const ev = rec.event;
      if (ev.type === 'tool.call') {
        const name = ev.name || ev.toolName || 'tool';
        out.push(`[${name}]`);
        continue;
      }
      if (ev.type === 'content.part' && ev.part && typeof ev.part === 'object') {
        const part = ev.part;
        if (part.type === 'text' && typeof part.text === 'string') {
          const body = part.text.trim();
          if (body) out.push(body);
        }
        // part.type === 'think' skipped
      }
    }
  }
  return out.length ? out.join('\n') : null;
}

// Grok: the documented ACP update stream. Text arrives in chunks; consecutive
// chunks of the same role are joined before display. Thoughts and tool output
// stay out, matching the other transcript readers.
function readGrok(cwd, sessionId, root) {
  const dir = history.grokSessionDir(cwd, sessionId, root);
  if (!dir) return null;
  const file = path.join(dir, 'updates.jsonl');
  let raw;
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(st.size, MAX_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      raw = buf.toString('utf8');
    } finally { try { fs.closeSync(fd); } catch (_) { /* closed */ } }
  } catch (_) {
    return null;
  }

  const out = [];
  let role = null;
  let pending = '';
  const flush = () => {
    const body = pending.trim();
    if (body) out.push(role === 'user' ? `\n› ${body}\n` : body);
    role = null;
    pending = '';
  };
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    const update = rec?.params?.update;
    if (!update || typeof update !== 'object') continue;
    if (update.sessionUpdate === 'user_message_chunk'
      || update.sessionUpdate === 'agent_message_chunk') {
      const nextRole = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
      const text = update.content?.text;
      if (typeof text !== 'string') continue;
      if (role && role !== nextRole) flush();
      role = nextRole;
      pending += text;
      continue;
    }
    if (update.sessionUpdate === 'tool_call') {
      flush();
      const name = String(update.title || update.kind || 'tool').replace(/\s+/g, ' ').trim();
      out.push(`[${name || 'tool'}]`);
    }
  }
  flush();
  return out.length ? out.join('\n') : null;
}

// Returns the conversation as text, or null when there is no transcript to
// read. Never throws — this feeds a viewer, not a workflow.
//
// `root` is either a Claude projects directory (string, legacy) or
// `{ claude?, opencode?, kimi? }` for tests that inject fixture stores.
async function read(cwd, sessionId, root) {
  const claude = readClaude(cwd, sessionId, root);
  if (claude) return claude;
  const { opencode, kimi, grok } = rootsOf(root);
  try {
    const oc = await readOpencode(cwd, sessionId, opencode);
    if (oc) return oc;
  } catch (_) { /* try kimi */ }
  try {
    const k = readKimi(cwd, sessionId, root && typeof root === 'object' ? root : { kimi });
    if (k) return k;
  } catch (_) { /* try grok */ }
  try { return readGrok(cwd, sessionId, grok); } catch (_) { return null; }
}

module.exports = { read, fileFor, textOf, readOpencode, readKimi, readGrok };
