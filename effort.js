// How hard a tab's agent thinks — chosen per project, per agent.
//
// Two of the CLIs expose a reasoning-effort setting, and neither spells it the
// same way:
//   claude  `--effort <level>`, low … max
//   codex   `-c model_reasoning_effort=<level>`, minimal … ultra (the config
//           override; the value parses as TOML, and a bare word that isn't
//           valid TOML is taken as the literal string, which is what we want)
// The rest have no such setting, and the picker stays hidden for them rather
// than pretending. Levels are each CLI's own vocabulary and never cross.
//
// "Default" means: pass no flag, let the agent use its own setting. Those are
// read (~/.claude/settings.json, ~/.codex/config.toml) to show what that
// resolves to, and never written.

const os = require('os');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');

const DEFAULT_ROW = { id: 'default', label: 'Default' };

// Ordered weakest to strongest, as each CLI names them. Claude's list ends
// with one that isn't a rung on the same ladder: `ultracode` is xhigh plus
// standing workflow orchestration, and it is accepted by --effort like any
// level (verified against the CLI, which reports the mode active for it and
// inactive for a plain xhigh). Its own /effort spells the set the same way.
const LEVELS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'],
};

// Shown beside a level that needs saying what it is. Keys into i18n.
const HINTS = {
  claude: { ultracode: 'bar.effort.hint.ultracode' },
};

const SAFE_LEVEL = /^[a-z]+$/;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// What "Default" resolves to for an agent, from that agent's own config.
function globalDefault(agent = 'claude') {
  if (agent === 'claude') {
    const data = readJson(CLAUDE_SETTINGS);
    const lvl = data && data.effortLevel;
    return typeof lvl === 'string' && SAFE_LEVEL.test(lvl) ? lvl : 'default';
  }
  if (agent === 'codex') {
    try {
      // The top-level key, not one inside a [profile] table.
      const head = fs.readFileSync(CODEX_CONFIG, 'utf8').split(/^\s*\[/m)[0];
      const m = head.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
      return m && SAFE_LEVEL.test(m[1]) ? m[1] : 'default';
    } catch (_) { return 'default'; }
  }
  return 'default';
}

// The rows the picker shows. An agent with no effort setting gets nothing, and
// the renderer hides the control rather than showing a dead one.
function list(agent = 'claude') {
  const levels = LEVELS[agent];
  if (!levels) return [];
  const hints = HINTS[agent] || {};
  return [DEFAULT_ROW, ...levels.map((id) => ({ id, label: id, hint: hints[id] || null }))];
}

function supports(agent) { return Boolean(LEVELS[agent]); }

function keyFor(projectPath, agent) {
  return `${agent || 'claude'}|${projectPath}`;
}

function stored() {
  const v = settings.get('projectEfforts');
  return v && typeof v === 'object' ? { ...v } : {};
}

function getFor(projectPath, agent = 'claude') {
  if (!projectPath || !supports(agent)) return 'default';
  const id = stored()[keyFor(projectPath, agent)];
  return typeof id === 'string' && LEVELS[agent].includes(id) ? id : 'default';
}

function setFor(projectPath, agent, id) {
  if (!projectPath) return { ok: false, error: 'no project' };
  if (!supports(agent)) return { ok: false, error: 'agent has no effort setting' };
  if (id !== 'default' && !LEVELS[agent].includes(String(id))) {
    return { ok: false, error: 'bad effort level' };
  }
  const map = stored();
  // Stored as "no entry" so the project keeps following the agent's own
  // setting even if that changes later.
  if (id === 'default') delete map[keyFor(projectPath, agent)];
  else map[keyFor(projectPath, agent)] = id;
  settings.set('projectEfforts', map);
  return { ok: true, effort: getFor(projectPath, agent) };
}

// The flag to append to a tab's start command, in that agent's own syntax.
function flagFor(agent, id) {
  if (!id || id === 'default' || !supports(agent) || !LEVELS[agent].includes(id)) return '';
  if (agent === 'claude') return ` --effort ${id}`;
  return ` -c model_reasoning_effort=${id}`;
}

function allFor() { return stored(); }

module.exports = { list, supports, globalDefault, getFor, setFor, allFor, flagFor, keyFor, LEVELS };
