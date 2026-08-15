// The instruction file each agent CLI reads — read and edited here.
//
// Every runtime TabDesk can start has its own convention for "the file that
// tells the agent how to behave": Claude Code reads CLAUDE.md, Codex and most
// others read AGENTS.md, Gemini reads GEMINI.md. Each exists at two levels:
// in the project (that project's rules) and in the agent's config directory
// (rules for every project). This module knows those names and locations, and
// is the only place that does — the renderer asks for (agent, scope, project)
// and main resolves the path itself, so no path ever travels in from a
// window.
//
// The table is deliberately explicit rather than derived: a runtime whose
// convention we have not confirmed gets no entry, and adding one is a
// one-line change here, not a hunt through the codebase.

const fs = require('fs');
const os = require('os');
const path = require('path');
const agents = require('./agents');
const model = require('./model');
const projectsRoot = require('./projects-root');

// `project` is the file's name inside a project directory; `global` is the
// full path of the user-wide one (a function, because KIMI_HOME() honours an
// env override that can differ between runs). null means the runtime has no
// file at that level.
const FILES = {
  claude:   { project: 'CLAUDE.md', global: () => path.join(os.homedir(), '.claude', 'CLAUDE.md') },
  codex:    { project: 'AGENTS.md', global: () => path.join(os.homedir(), '.codex', 'AGENTS.md') },
  gemini:   { project: 'GEMINI.md', global: () => path.join(os.homedir(), '.gemini', 'GEMINI.md') },
  opencode: { project: 'AGENTS.md', global: () => path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md') },
  kimi:     { project: 'AGENTS.md', global: () => path.join(model.KIMI_HOME(), 'AGENTS.md') },
  grok:     { project: 'AGENTS.md', global: () => path.join(model.GROK_HOME(), 'AGENTS.md') },
  // Aider has no user-wide instruction file worth editing — its conventions
  // file is something you opt into per project.
  aider:    { project: 'AGENTS.md', global: null },
  cursor:   { project: 'AGENTS.md', global: () => path.join(os.homedir(), '.cursor', 'AGENTS.md') },
};

// A project path the renderer may name is the projects folder itself or one
// of its direct subfolders — the same set projects:list offers. Anything else
// is refused rather than normalised.
function validProject(projectPath) {
  const root = projectsRoot.resolve();
  if (!root || typeof projectPath !== 'string' || !projectPath) return false;
  const resolved = path.resolve(projectPath);
  if (resolved === root) return true;
  return path.dirname(resolved) === root;
}

function fileFor(agentId, scope, projectPath) {
  const spec = FILES[agentId];
  if (!spec) return null;
  if (scope === 'global') return spec.global ? spec.global() : null;
  if (scope === 'project' && spec.project && validProject(projectPath)) {
    return path.join(path.resolve(projectPath), spec.project);
  }
  return null;
}

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };

// What the settings window lists: the installed runtimes that have an
// instruction file at all, and for each level the file's path, name and
// whether it exists yet. Only installed runtimes — editing instructions for a
// CLI that is not on PATH would write files nothing reads.
function list(projectPath) {
  if (!validProject(projectPath)) return [];
  return agents.list()
    .filter((a) => FILES[a.id])
    .map((a) => {
      const spec = FILES[a.id];
      const projectFile = spec.project
        ? { name: spec.project, path: path.join(path.resolve(projectPath), spec.project) }
        : null;
      const globalPath = spec.global ? spec.global() : null;
      return {
        id: a.id,
        label: a.label,
        projectFile: projectFile && { ...projectFile, exists: exists(projectFile.path) },
        globalFile: globalPath && { name: path.basename(globalPath), path: globalPath, exists: exists(globalPath) },
      };
    });
}

function read(agentId, scope, projectPath) {
  const file = fileFor(agentId, scope, projectPath);
  if (!file) return { ok: false, error: 'no such file' };
  try {
    return { ok: true, path: file, content: fs.readFileSync(file, 'utf8'), exists: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, path: file, content: '', exists: false };
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function write(agentId, scope, projectPath, content) {
  const file = fileFor(agentId, scope, projectPath);
  if (!file) return { ok: false, error: 'no such file' };
  if (typeof content !== 'string') return { ok: false, error: 'no content' };
  try {
    // The agent's config directory may not exist yet (a global file for a CLI
    // that was never configured) — create it rather than fail on that.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { list, read, write, FILES };
