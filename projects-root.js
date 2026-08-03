// The projects folder, and path identity around it.
//
// Where the rail's projects live is the user's choice, made at first run and
// stored in settings — with two escapes: TABDESK_PROJECTS_DIR overrides for a
// single run (the demo/testing hook, never persisted), and the pre-settings
// default ~/claude-projects is adopted once if it exists, so machines from
// before this setting never see the first-run screen.
//
// Directories under the projects folder are known by their spelling there —
// including symlinks. The kernel resolves those the moment anything runs, so
// paths that come back from the outside world (tmux reports a session's
// physical path) need mapping back to the rail's spelling before they are
// used as identity.

const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('./settings');

let memo;   // undefined = not resolved yet; null = unconfigured

function resolve() {
  if (memo !== undefined) return memo;
  const env = process.env.TABDESK_PROJECTS_DIR;
  if (env) return (memo = path.resolve(env));
  const stored = settings.get('projectsDir');
  if (stored) return (memo = path.resolve(String(stored)));
  const legacy = path.join(os.homedir(), 'claude-projects');
  try {
    if (fs.statSync(legacy).isDirectory()) {
      settings.set('projectsDir', legacy);   // adopt once; explicit from here on
      return (memo = legacy);
    }
  } catch (_) { /* never existed */ }
  return (memo = null);
}

// True only when there is a root AND it is actually there — a chosen folder
// that has since been deleted should bring the first-run screen back, not an
// empty rail with advice about selecting projects that cannot exist.
function configured() {
  const root = resolve();
  try { return Boolean(root) && fs.statSync(root).isDirectory(); } catch (_) { return false; }
}

// Throws on anything that is not an existing directory — the caller turns
// that into a message. path.resolve also strips the trailing-slash spelling
// that would silently break slugFor's prefix match.
function setRoot(dir) {
  const resolved = path.resolve(String(dir || ''));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`not a directory: ${resolved}`);
  settings.set('projectsDir', resolved);
  memo = resolved;
  return resolved;
}

// Rewrite a physical path to the projects folder's spelling of it. `entries`
// is the folder's contents as [{ path, real }]; the most specific real wins,
// so a symlink that points inside another project's tree (a worktree, say)
// beats the project that contains it. A path no entry accounts for is
// returned untouched.
function logicalizeCwd(cwd, entries) {
  const ranked = (entries || [])
    .filter((e) => e && e.path && e.real && e.real !== e.path)
    .sort((a, b) => b.real.length - a.real.length);
  for (const e of ranked) {
    if (cwd === e.real) return e.path;
    if (cwd.startsWith(e.real + path.sep)) return e.path + cwd.slice(e.real.length);
  }
  return cwd;
}

module.exports = { resolve, configured, setRoot, logicalizeCwd };
