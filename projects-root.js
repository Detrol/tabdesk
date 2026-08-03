// The projects folder, and path identity around it.
//
// Directories under the projects folder are known by their spelling there —
// including symlinks. The kernel resolves those the moment anything runs, so
// paths that come back from the outside world (tmux reports a session's
// physical path) need mapping back to the rail's spelling before they are
// used as identity.

const path = require('path');

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

module.exports = { logicalizeCwd };
