// Last-used timestamps for project rows, plus the sort the rail and picker share.
//
// A row's rank is the later of "opened in TabDesk" and the directory mtime, so
// a project you just used and one whose files just changed both surface first.
// The projects-folder row stays the fixed home at the top either way.

function sanitize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [projectPath, at] of Object.entries(raw)) {
    if (typeof projectPath !== 'string' || !projectPath) continue;
    const n = Number(at);
    if (!Number.isFinite(n)) continue;
    out[projectPath] = n;
  }
  return out;
}

function mark(map, projectPath, at) {
  const current = sanitize(map);
  if (typeof projectPath !== 'string' || !projectPath) return current;
  if (!Number.isFinite(at)) return current;
  current[projectPath] = at;
  return current;
}

function score(row, map) {
  const used = (map && Number(map[row.path])) || 0;
  const mtime = Number(row.mtime) || 0;
  return used > mtime ? used : mtime;
}

function order(rows, map) {
  if (!Array.isArray(rows)) return [];
  const recents = sanitize(map);
  const roots = [];
  const rest = [];
  for (const row of rows) {
    if (row && row.root) roots.push(row);
    else rest.push(row);
  }
  rest.sort((a, b) => {
    const diff = score(b, recents) - score(a, recents);
    if (diff) return diff;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  return roots.concat(rest);
}

module.exports = { sanitize, mark, order };
