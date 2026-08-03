// Which CLI a project's terminal starts — chosen per project.
//
// TabDesk used to hard-code `claude` for every project tab. A machine with
// several agent CLIs on it has no reason to prefer one everywhere: the project
// decides, and the choice is remembered with it, the same way the model is
// (see model.js — same storage, same "stored means overridden" rule).
//
// The command lines here are OURS, not the user's. Nothing from settings is
// ever spliced into a shell command: a stored value is only ever matched
// against these ids, and an id nobody recognises falls back to the default.
// That is what keeps the start command out of injection territory.

const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const model = require('./model');

// `bin` is what has to exist on PATH for the entry to be offered at all.
// `command` is what the terminal runs — the plain shell entry has none, which
// is what makes it a plain shell.
const AGENTS = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    command: 'claude --dangerously-skip-permissions',
    // `takesModel` is about the flag, not the vocabulary: these CLIs all accept
    // --model, but each names its models its own way, so the ids come from
    // model.js per agent and never cross between them.
    takesModel: true,
    // How this CLI is told to pick a conversation up again. `{id}` is one of
    // the ids history.js read out of the agent's own store; `continueArgs`
    // takes the newest one without naming it.
    resumeArgs: '--resume {id}',
    continueArgs: '--continue',
    hint: 'agent.hint.claude',
  },
  { id: 'codex',    label: 'Codex',        bin: 'codex',        command: 'codex',        takesModel: true, resumeArgs: 'resume {id}',  continueArgs: 'resume --last',   hint: 'agent.hint.codex' },
  { id: 'gemini',   label: 'Gemini CLI',   bin: 'gemini',       command: 'gemini',       takesModel: true, resumeArgs: '--resume {id}', continueArgs: '--resume latest', hint: 'agent.hint.gemini' },
  { id: 'opencode', label: 'opencode',     bin: 'opencode',     command: 'opencode',     takesModel: true, resumeArgs: '--session {id}', continueArgs: '--continue',     hint: 'agent.hint.opencode' },
  // Aider and Cursor Agent spell the flag differently enough that TabDesk
  // leaves their model choice to them.
  { id: 'aider',    label: 'Aider',        bin: 'aider',        command: 'aider',        hint: 'agent.hint.aider' },
  { id: 'cursor',   label: 'Cursor Agent', bin: 'cursor-agent', command: 'cursor-agent', hint: 'agent.hint.cursor' },
  // Always offered: a project tab that starts nothing but your shell.
  { id: 'shell',    label: 'Terminal',     bin: null,           command: null,           hint: 'agent.hint.shell' },
];

const DEFAULT_ID = 'claude';

// PATH lookup without spawning `which` per candidate — this runs on every menu
// open, and six subprocesses to answer "what is installed" is six too many.
function onPath(bin) {
  if (!bin) return true;                       // the shell entry needs nothing
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch (_) { /* next dir */ }
  }
  return false;
}

// Installing an agent while TabDesk runs should show up without a restart, but
// re-walking PATH on every keystroke-fast menu open is waste. A few seconds of
// staleness is the right trade.
const CACHE_MS = 5000;
let cache = null;
let cachedAt = 0;

function list() {
  const now = Date.now();
  if (cache && now - cachedAt < CACHE_MS) return cache;
  cache = AGENTS
    .filter((a) => onPath(a.bin))
    .map(({ id, label, hint, command, takesModel, resumeArgs, continueArgs }) =>
      ({
        id, label, hint, command: command || null, takesModel: !!takesModel,
        resumeArgs: resumeArgs || null, continueArgs: continueArgs || null,
      }));
  cachedAt = now;
  return cache;
}

// The id a project actually starts with. A stored agent that is no longer
// installed (uninstalled, or a PATH that differs from where it was set) must
// not leave the tab starting a command that isn't there — fall back instead.
function getFor(projectPath) {
  const installed = list();
  const has = (id) => installed.some((a) => a.id === id);
  const stored = projectPath ? (settings.get('projectAgents') || {})[projectPath] : null;
  if (typeof stored === 'string' && has(stored)) return stored;
  if (has(DEFAULT_ID)) return DEFAULT_ID;
  // Nothing stored and no Claude Code: the first agent that is installed, or a
  // plain shell, which is always there.
  const first = installed.find((a) => a.id !== 'shell');
  return first ? first.id : 'shell';
}

function setFor(projectPath, id) {
  if (!projectPath) return { ok: false, error: 'no project' };
  if (!AGENTS.some((a) => a.id === id)) return { ok: false, error: 'unknown agent' };
  const map = { ...(settings.get('projectAgents') || {}) };
  map[projectPath] = id;
  settings.set('projectAgents', map);
  return { ok: true, agent: getFor(projectPath) };
}

// All overrides at once, for the renderer's boot payload.
function allFor() { return { ...(settings.get('projectAgents') || {}) }; }

// The command line a project's terminal starts with, model flag included where
// the agent understands one. null means "just the shell".
function commandFor(agentId, modelId) {
  const spec = AGENTS.find((a) => a.id === agentId);
  if (!spec || !spec.command) return null;
  return spec.command + (spec.takesModel ? model.flagFor(modelId) : '');
}

module.exports = { list, getFor, setFor, allFor, commandFor, onPath, DEFAULT_ID };
