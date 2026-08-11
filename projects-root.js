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

function rootError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Validate without publishing so main can first obtain the dirty renderer's
// leave decision. Commit and rollback keep this module's memo and the settings
// cache on the same root while main arms and starts that exact approved reload;
// settings.set's existing semantics for every other caller stay intact.
function prepareRoot(dir) {
  const resolved = path.resolve(String(dir || ''));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`not a directory: ${resolved}`);
  const previousRoot = resolve();
  const previousSetting = settings.get('projectsDir');
  let committed = false;

  return {
    commit() {
      if (committed) return resolved;
      try {
        if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
      } catch (_) {
        throw rootError('invalid-root', `not a directory: ${resolved}`);
      }
      if (!settings.set('projectsDir', resolved)) {
        // settings.set updates its in-memory cache before attempting disk I/O.
        // A second call restores that cache even if the same disk error remains.
        settings.set('projectsDir', previousSetting);
        memo = previousRoot;
        throw rootError('persist-failed', 'could not persist projects root');
      }
      memo = resolved;
      committed = true;
      return resolved;
    },
    rollback() {
      if (!committed) return previousRoot;
      const persisted = settings.set('projectsDir', previousSetting);
      memo = previousRoot;
      committed = false;
      if (!persisted) throw rootError('rollback-failed', 'could not restore projects root');
      return previousRoot;
    },
  };
}

// Throws on anything that is not an existing directory — the caller turns
// that into a message. path.resolve also strips the trailing-slash spelling
// that would silently break slugFor's prefix match.
function setRoot(dir) {
  const transition = prepareRoot(dir);
  return transition.commit();
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

module.exports = { resolve, configured, prepareRoot, setRoot, logicalizeCwd };
