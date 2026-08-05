// Which model a tab's agent runs with — chosen per project, per agent.
//
// Every agent CLI TabDesk starts takes a `--model` flag, but they don't share a
// vocabulary: Claude Code wants a family alias, opencode wants provider/model,
// Codex and Gemini want their own ids. So the picker asks the agent what it
// offers, and the pick is stored against the pair (project, agent) — a model
// chosen for a Codex tab must never end up on the Claude tab beside it.
//
// Where the choices come from, per agent:
//   claude    the alias list below (TabDesk's own, and stable across releases)
//   opencode  `opencode models`, which the CLI answers from its own providers
//   codex     the models this machine has actually run, read out of the recent
//             rollouts (plus the config default). Codex has no list command
//             and bakes its /model choices into the binary — but every session
//             stamps its model into the rollout, so the set maintains itself:
//             try a model once in Codex and it appears here. A model never
//             used on this machine is the one thing this cannot offer.
//   others    nothing to list — the CLI is the only place that knows, so the
//             picker shows what that agent is configured with and says to use
//             its own /model command. (Gemini stays here: its CLI cannot even
//             authenticate on this tier any more, so a model list is moot.)
// "Default" always means: pass no flag, let the agent use its own setting. We
// read those settings to show what that resolves to, and never write them.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const settings = require('./settings');

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');
const GEMINI_SETTINGS = path.join(os.homedir(), '.gemini', 'settings.json');
const OPENCODE_CONFIG = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
const KIMI_HOME = () => {
  const env = process.env.KIMI_CODE_HOME;
  if (env && typeof env === 'string' && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.kimi-code');
};
const KIMI_CONFIG = () => path.join(KIMI_HOME(), 'config.toml');

// Aliases, not pinned model ids: each alias tracks the latest model in its
// family, so this list doesn't go stale on the next release. The "[1m]" suffix
// asks for the 1M-token context variant of the same model.
const CLAUDE_MODELS = [
  { id: 'default',    label: 'Default',   hint: 'model.hint.default' },
  { id: 'opus',       label: 'Opus',      hint: 'model.hint.opus' },
  { id: 'opus[1m]',   label: 'Opus 1M',   hint: 'model.hint.opus1m' },
  { id: 'sonnet',     label: 'Sonnet',    hint: 'model.hint.sonnet' },
  { id: 'sonnet[1m]', label: 'Sonnet 1M', hint: 'model.hint.sonnet1m' },
  { id: 'haiku',      label: 'Haiku',     hint: 'model.hint.haiku' },
  { id: 'fable',      label: 'Fable',     hint: 'model.hint.fable' },
];

const DEFAULT_ROW = { id: 'default', label: 'Default', hint: 'model.hint.default' };

// Ids end up inside a shell command line, so keep them to the shape a model id
// actually has — including the provider/model slash opencode uses. Anything
// else is refused rather than escaped.
const SAFE_ID = /^[A-Za-z0-9._/[\]-]+$/;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// What "Default" resolves to for an agent, read from that agent's own config.
// Never written — a per-project pick must not become everyone's default.
function globalDefault(agent = 'claude') {
  if (agent === 'claude') {
    const data = readJson(CLAUDE_SETTINGS);
    return data && typeof data.model === 'string' && data.model ? data.model : 'default';
  }
  if (agent === 'codex') {
    try {
      // The top-level `model = "..."`, not one inside a [profile] table.
      const head = fs.readFileSync(CODEX_CONFIG, 'utf8').split(/^\s*\[/m)[0];
      const m = head.match(/^\s*model\s*=\s*"([^"]+)"/m);
      return m ? m[1] : 'default';
    } catch (_) { return 'default'; }
  }
  if (agent === 'gemini') {
    const data = readJson(GEMINI_SETTINGS);
    const name = data && data.model && data.model.name;
    return typeof name === 'string' && name ? name : 'default';
  }
  if (agent === 'opencode') {
    const data = readJson(OPENCODE_CONFIG);
    const name = data && data.model;
    return typeof name === 'string' && SAFE_ID.test(name) ? name : 'default';
  }
  if (agent === 'kimi') {
    try {
      // Top-level default_model = "…", not inside a [table].
      const head = fs.readFileSync(KIMI_CONFIG(), 'utf8').split(/^\s*\[/m)[0];
      const m = head.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
      return m && SAFE_ID.test(m[1]) ? m[1] : 'default';
    } catch (_) { return 'default'; }
  }
  return 'default';
}

// `opencode models` prints one provider/model per line. Cached: the picker
// opens often and the CLI takes a moment.
const LIST_TTL_MS = 5 * 60 * 1000;
const listCache = new Map();   // agent -> { at, models }

// ---- Codex: models this machine has run ----
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_DAY_DIRS = 14;
// Dozens of sessions land per day here, so a small cap would only ever see
// today — the point is to reach models used earlier in the window too.
const CODEX_MAX_FILES = 80;
// The first turn_context carries the model, but it sits AFTER the
// session_meta line whose embedded instructions run to ~100 KB — no fixed
// head or tail hits it reliably. Chunk forward and stop at the first match.
const CODEX_SCAN_CAP = 512 * 1024;

// Every distinct "model":"..." in the text. Exported for tests.
function codexModelsFromText(text) {
  const out = new Set();
  const re = /"model":"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    if (SAFE_ID.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

function codexRolloutFiles() {
  const dirs = [];
  let years;
  try { years = fs.readdirSync(CODEX_SESSIONS).filter((d) => /^\d{4}$/.test(d)).sort().reverse(); }
  catch (_) { return []; }
  for (const y of years) {
    let months;
    try { months = fs.readdirSync(path.join(CODEX_SESSIONS, y)).filter((d) => /^\d{2}$/.test(d)).sort().reverse(); }
    catch (_) { continue; }
    for (const mo of months) {
      let days;
      try { days = fs.readdirSync(path.join(CODEX_SESSIONS, y, mo)).filter((d) => /^\d{2}$/.test(d)).sort().reverse(); }
      catch (_) { continue; }
      for (const d of days) {
        dirs.push(path.join(CODEX_SESSIONS, y, mo, d));
        if (dirs.length >= CODEX_DAY_DIRS) break;
      }
      if (dirs.length >= CODEX_DAY_DIRS) break;
    }
    if (dirs.length >= CODEX_DAY_DIRS) break;
  }
  const files = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (n.startsWith('rollout-') && n.endsWith('.jsonl')) files.push(path.join(dir, n));
    }
  }
  return files.slice(0, CODEX_MAX_FILES);
}

function modelsFromRollout(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(32 * 1024);
    let pos = 0;
    let carry = '';
    while (pos < CODEX_SCAN_CAP) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const text = carry + buf.toString('utf8', 0, n);
      const ids = codexModelsFromText(text);
      if (ids.length) return ids;
      carry = text.slice(-64);   // a match split across the chunk boundary
      pos += n;
    }
    return [];
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* closed */ }
  }
}

function listFromCodexRollouts() {
  const hit = listCache.get('codex');
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return Promise.resolve(hit.models);
  const seen = new Set();
  const configured = globalDefault('codex');
  if (configured !== 'default') seen.add(configured);
  for (const file of codexRolloutFiles()) {
    for (const id of modelsFromRollout(file)) seen.add(id);
  }
  const models = [...seen].sort().map((id) => ({ id, label: id, hint: null }));
  listCache.set('codex', { at: Date.now(), models });
  return Promise.resolve(models);
}

function listFromCommand(agent, bin, args) {
  const hit = listCache.get(agent);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return Promise.resolve(hit.models);
  return new Promise((resolve) => {
    let done = false;
    const finish = (models) => {
      if (done) return;
      done = true;
      listCache.set(agent, { at: Date.now(), models });
      resolve(models);
    };
    try {
      const child = execFile(bin, args, { timeout: 8000 }, (err, stdout) => {
        if (err || !stdout) return finish([]);
        const models = String(stdout).split('\n')
          .map((l) => l.trim())
          .filter((l) => l && SAFE_ID.test(l))
          .map((id) => ({ id, label: id, hint: null }));
        finish(models);
      });
      child.on('error', () => finish([]));
    } catch (_) { finish([]); }
  });
}

// The rows the picker shows for an agent. Always starts with Default; an agent
// with nothing else to offer gets that row alone, and the renderer shows the
// picker as read-only rather than empty.
// kimi provider list --json → { providers, models: { "alias": { displayName, … } } }
function listFromKimi() {
  const key = 'kimi';
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return Promise.resolve(hit.models);

  return new Promise((resolve) => {
    const finish = (models) => {
      listCache.set(key, { at: Date.now(), models });
      resolve(models);
    };
    try {
      const child = execFile('kimi', ['provider', 'list', '--json'], {
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      }, (err, stdout) => {
        if (err || !stdout) return finish(listFromKimiConfig());
        let data;
        try { data = JSON.parse(String(stdout)); } catch (_) { return finish(listFromKimiConfig()); }
        const map = data && data.models && typeof data.models === 'object' ? data.models : null;
        if (!map) return finish(listFromKimiConfig());
        const models = [];
        for (const [id, meta] of Object.entries(map)) {
          if (!SAFE_ID.test(id)) continue;
          const label = meta && typeof meta.displayName === 'string' && meta.displayName
            ? meta.displayName
            : id;
          models.push({ id, label, hint: null });
        }
        finish(models.length ? models : listFromKimiConfig());
      });
      child.on('error', () => finish(listFromKimiConfig()));
    } catch (_) { finish(listFromKimiConfig()); }
  });
}

// Fallback when the CLI is unavailable: parse [models."…"] keys from config.toml.
function listFromKimiConfig() {
  try {
    const text = fs.readFileSync(KIMI_CONFIG(), 'utf8');
    const models = [];
    const re = /^\[models\."([^"]+)"\]/gm;
    let m;
    while ((m = re.exec(text))) {
      if (SAFE_ID.test(m[1])) models.push({ id: m[1], label: m[1], hint: null });
    }
    return models;
  } catch (_) {
    return [];
  }
}

function list(agent = 'claude') {
  if (agent === 'claude') return Promise.resolve(CLAUDE_MODELS);
  if (agent === 'opencode') {
    return listFromCommand('opencode', 'opencode', ['models'])
      .then((models) => [DEFAULT_ROW, ...models]);
  }
  if (agent === 'codex') {
    return listFromCodexRollouts().then((models) => [DEFAULT_ROW, ...models]);
  }
  if (agent === 'kimi') {
    return listFromKimi().then((models) => [DEFAULT_ROW, ...models]);
  }
  return Promise.resolve([DEFAULT_ROW]);
}

// Stored per (project, agent). Entries written before agents had their own
// models are Claude's, and are read under that name.
function keyFor(projectPath, agent) {
  return `${agent || 'claude'}|${projectPath}`;
}

function storedModels() {
  const map = { ...(settings.get('projectModels') || {}) };
  let moved = false;
  for (const k of Object.keys(map)) {
    if (k.includes('|')) continue;
    map[`claude|${k}`] = map[k];
    delete map[k];
    moved = true;
  }
  if (moved) settings.set('projectModels', map);
  return map;
}

function getFor(projectPath, agent = 'claude') {
  if (!projectPath) return 'default';
  const id = storedModels()[keyFor(projectPath, agent)];
  return typeof id === 'string' && SAFE_ID.test(id) ? id : 'default';
}

function setFor(projectPath, agent, id) {
  if (!projectPath) return { ok: false, error: 'no project' };
  if (id !== 'default' && !SAFE_ID.test(String(id))) return { ok: false, error: 'bad model id' };
  const map = storedModels();
  // Store 'default' as "no entry" so the project keeps following the agent's
  // own default even if that changes later.
  if (id === 'default') delete map[keyFor(projectPath, agent)];
  else map[keyFor(projectPath, agent)] = id;
  settings.set('projectModels', map);
  return { ok: true, model: getFor(projectPath, agent) };
}

// The flag to append to a tab's start command. Single-quoted: ids like
// opus[1m] are a glob pattern to bash otherwise.
function flagFor(id) {
  return !id || id === 'default' || !SAFE_ID.test(id) ? '' : ` --model '${id}'`;
}

// ~/.claude/settings.json is not ours, but what it says changes what "Default"
// means, so watch it. Poll rather than fs.watch: an atomic replace swaps the
// inode out from under a watcher.
let lastSeen = null;
function watchGlobal(onChange) {
  lastSeen = globalDefault('claude');
  fs.watchFile(CLAUDE_SETTINGS, { interval: 4000 }, () => {
    const now = globalDefault('claude');
    if (now === lastSeen) return;
    lastSeen = now;
    onChange(now);
  });
  return () => fs.unwatchFile(CLAUDE_SETTINGS);
}

// Every stored pick, keyed "<agent>|<path>" — for a renderer that needs to
// re-read them all at once after an import rewrote them.
function allFor() { return { ...storedModels() }; }

module.exports = { list, globalDefault, getFor, setFor, allFor, flagFor, keyFor, watchGlobal, codexModelsFromText, KIMI_HOME };
