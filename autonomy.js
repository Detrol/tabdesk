// How much a Droid tab is allowed to act on its own — chosen per project.
//
// Only Droid has this setting. Its CLI spells it `--auto <level>` with
// low/medium/high, and the picker stays hidden for every other runtime rather
// than pretending they understand the flag.
//
// Unlike the effort bar, "Default" here is not "pass no flag". Droid's base
// command carries no `--auto`, so Default resolves the level from Factory's
// own config (~/.factory/settings.json → sessionDefaultSettings.autonomyLevel)
// and always injects it. `off` or a missing value falls back to `medium`.
//
// The levels are matched against this fixed list rather than escaped, so
// nothing but a known word ever reaches the command line.

const os = require('os');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');

const FACTORY_SETTINGS = path.join(os.homedir(), '.factory', 'settings.json');

const DEFAULT_ROW = { id: 'default', label: 'Default' };

const LEVELS = {
  droid: ['low', 'medium', 'high'],
};

// What "off"/missing falls back to — the level Default injects when Factory's
// own config has no usable autonomy level.
const FALLBACK = 'medium';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function supports(agent) { return Boolean(LEVELS[agent]); }

// What "Default" resolves to, read from Factory's own config. `off` (Droid's
// way of saying "ask every time") and anything unrecognised become `medium`.
function globalDefault(agent = 'droid') {
  if (!supports(agent)) return FALLBACK;
  const data = readJson(FACTORY_SETTINGS);
  const lvl = data && data.sessionDefaultSettings && data.sessionDefaultSettings.autonomyLevel;
  return typeof lvl === 'string' && LEVELS[agent].includes(lvl) ? lvl : FALLBACK;
}

// The rows the picker shows. A runtime with no autonomy setting gets nothing,
// and the renderer hides the control rather than showing a dead one.
function list(agent = 'droid') {
  const levels = LEVELS[agent];
  if (!levels) return [];
  return [DEFAULT_ROW, ...levels.map((id) => ({ id, label: id, hint: null }))];
}

function keyFor(projectPath, agent) {
  return `${agent || 'droid'}|${projectPath}`;
}

function stored() {
  const v = settings.get('projectAutonomies');
  return v && typeof v === 'object' ? { ...v } : {};
}

function getFor(projectPath, agent = 'droid') {
  if (!projectPath || !supports(agent)) return 'default';
  const id = stored()[keyFor(projectPath, agent)];
  return typeof id === 'string' && LEVELS[agent].includes(id) ? id : 'default';
}

function setFor(projectPath, agent, id) {
  if (!projectPath) return { ok: false, error: 'no project' };
  if (!supports(agent)) return { ok: false, error: 'agent has no autonomy setting' };
  if (id !== 'default' && !LEVELS[agent].includes(String(id))) {
    return { ok: false, error: 'bad autonomy level' };
  }
  const map = stored();
  // Stored as "no entry" so the project keeps following the global default
  // even if that changes later.
  if (id === 'default') delete map[keyFor(projectPath, agent)];
  else map[keyFor(projectPath, agent)] = id;
  settings.set('projectAutonomies', map);
  return { ok: true, autonomy: getFor(projectPath, agent) };
}

// How the level is applied on the start command. Droid always carries one:
// Default resolves from Factory's config, an explicit level is passed as-is.
// Unknown agents get nothing (the picker never shows for them anyway).
function flagFor(agent, id) {
  if (!supports(agent)) return '';
  if (agent === 'droid') {
    const level = id && id !== 'default' && LEVELS.droid.includes(id) ? id : globalDefault('droid');
    return ` --auto ${level}`;
  }
  return '';
}

// Autonomy is always a CLI suffix, never an env assignment — unlike some
// effort levels. Kept for symmetry with effort.js so startCmdFor can treat
// both the same way.
function isEnvFlag() { return false; }

function allFor() { return stored(); }

module.exports = {
  list, supports, globalDefault, getFor, setFor, allFor, flagFor, isEnvFlag, keyFor, LEVELS,
};
