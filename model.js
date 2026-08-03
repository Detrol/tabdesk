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
//   others    nothing to list — the CLI is the only place that knows, so the
//             picker shows what that agent is configured with and says to use
//             its own /model command.
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
  return 'default';
}

// `opencode models` prints one provider/model per line. Cached: the picker
// opens often and the CLI takes a moment.
const LIST_TTL_MS = 5 * 60 * 1000;
const listCache = new Map();   // agent -> { at, models }

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
function list(agent = 'claude') {
  if (agent === 'claude') return Promise.resolve(CLAUDE_MODELS);
  if (agent === 'opencode') {
    return listFromCommand('opencode', 'opencode', ['models'])
      .then((models) => [DEFAULT_ROW, ...models]);
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

module.exports = { list, globalDefault, getFor, setFor, allFor, flagFor, keyFor, watchGlobal };
