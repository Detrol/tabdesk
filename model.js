// Which model Claude Code runs with — chosen per project.
//
// A model is picked for the project in front of you and remembered with it, so
// an expensive model on one project can't quietly eat the usage budget of every
// other one. The choice is stored in TabDesk's own settings and turned into a
// `--model` flag when that project's terminal starts.
//
// "Default" means: pass no flag and let Claude Code use its own default from
// ~/.claude/settings.json. We read that file to show what it resolves to, but
// never write it — a per-project pick must not become everyone's default.

const os = require('os');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Aliases, not pinned model ids: each alias tracks the latest model in its
// family, so this list doesn't go stale on the next release. The "[1m]" suffix
// asks for the 1M-token context variant of the same model.
const MODELS = [
  { id: 'default',    label: 'Default',   hint: 'model.hint.default' },
  { id: 'opus',       label: 'Opus',      hint: 'model.hint.opus' },
  { id: 'opus[1m]',   label: 'Opus 1M',   hint: 'model.hint.opus1m' },
  { id: 'sonnet',     label: 'Sonnet',    hint: 'model.hint.sonnet' },
  { id: 'sonnet[1m]', label: 'Sonnet 1M', hint: 'model.hint.sonnet1m' },
  { id: 'haiku',      label: 'Haiku',     hint: 'model.hint.haiku' },
  { id: 'fable',      label: 'Fable',     hint: 'model.hint.fable' },
];

// Ids end up inside a shell command line, so keep them to the shape a model
// alias actually has. Anything else is refused rather than escaped.
const SAFE_ID = /^[A-Za-z0-9._[\]-]+$/;

function list() { return MODELS; }

// What "Default" means right now: Claude Code's own configured model.
function globalDefault() {
  try {
    const data = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
    return typeof data.model === 'string' && data.model ? data.model : 'default';
  } catch (_) {
    return 'default';   // missing or unparsable — Claude Code decides
  }
}

function getFor(projectPath) {
  if (!projectPath) return 'default';
  const map = settings.get('projectModels') || {};
  const id = map[projectPath];
  return typeof id === 'string' && SAFE_ID.test(id) ? id : 'default';
}

function setFor(projectPath, id) {
  if (!projectPath) return { ok: false, error: 'no project' };
  if (id !== 'default' && !SAFE_ID.test(String(id))) return { ok: false, error: 'bad model id' };
  const map = { ...(settings.get('projectModels') || {}) };
  // Store 'default' as "no entry" so the project keeps following Claude Code's
  // default even if that changes later.
  if (id === 'default') delete map[projectPath];
  else map[projectPath] = id;
  settings.set('projectModels', map);
  return { ok: true, model: getFor(projectPath) };
}

// All overrides at once, for the renderer's initial project list.
function allFor() { return { ...(settings.get('projectModels') || {}) }; }

// The flag to append to a project's start command. Single-quoted: aliases like
// opus[1m] are a glob pattern to bash otherwise.
function flagFor(id) {
  return !id || id === 'default' || !SAFE_ID.test(id) ? '' : ` --model '${id}'`;
}

// ~/.claude/settings.json is not ours, but what it says changes what "Default"
// means, so watch it. Poll rather than fs.watch: an atomic replace swaps the
// inode out from under a watcher.
let lastSeen = null;
function watchGlobal(onChange) {
  lastSeen = globalDefault();
  fs.watchFile(CLAUDE_SETTINGS, { interval: 4000 }, () => {
    const now = globalDefault();
    if (now === lastSeen) return;
    lastSeen = now;
    onChange(now);
  });
  return () => fs.unwatchFile(CLAUDE_SETTINGS);
}

module.exports = { list, globalDefault, getFor, setFor, allFor, flagFor, watchGlobal };
