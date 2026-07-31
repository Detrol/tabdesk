// What a project looks like right now, as a flat map of path -> content hash.
//
// The hash is the whole trick. Two manifests diff without reading a byte of
// content, an unchanged file is never uploaded twice, and a rename costs one
// line rather than a re-upload. It also means the receiving side can ask "what
// do I not have?" before anything moves.
//
// What is deliberately NOT here: anything that decides whether a file may be
// executed. Modes are recorded so a diff can notice them, but the receiving
// side ignores them — see files.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Directories that are either rebuildable, enormous, or another tool's job.
// .venv and node_modules are on this list twice over: they are the two places
// a project keeps executables it did not write, and app-runner/preview-runner
// will happily run what it finds in them.
const DEFAULT_IGNORES = [
  '.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__',
  'dist', 'build', 'out', 'target', '.cache', '.next', '.nuxt',
  '.DS_Store', '.idea', '.vscode', 'coverage', '.pytest_cache',

  // Not size, not noise — these two are read as instructions rather than data.
  //
  // A tab starts `claude --permission-mode auto` (agents.js) with the project
  // as its working directory. CLAUDE.md is loaded into that agent's context
  // automatically, and .claude/settings.json can define hooks, which are
  // commands the agent runs on its own. Either arriving over file sync would
  // reach the agent without passing the trust dialog, because the dialog
  // guards Run and Preview — not opening a tab.
  //
  // CLAUDE.md is not lost by this: it already travels in the portable bundle,
  // which shows every file as new/changed/unchanged before writing anything.
  // The split is deliberate — code moves by file sync, instructions move by
  // the reviewed path.
  'CLAUDE.md', '.claude',
];

// 50 MB. Past this it is not a source file, and the sync is not a backup tool.
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function hashFile(abs) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(abs));
  return h.digest('hex');
}

// A deliberately small subset of .gitignore: literal names, directory names,
// and a leading-slash anchor. Globs are not supported, and a pattern that
// looks like one is skipped rather than half-honoured — a half-applied ignore
// rule is worse than an absent one, because it looks like it worked.
function readGitignore(root) {
  const out = [];
  try {
    for (const raw of fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      if (/[*?[\]]/.test(line)) continue;
      out.push(line.replace(/^\//, '').replace(/\/$/, ''));
    }
  } catch (_) { /* no .gitignore is the common case */ }
  return out;
}

function makeMatcher(ignores) {
  const names = new Set(ignores);
  return (rel) => {
    const parts = rel.split('/');
    // Any path component matching an ignore name takes the whole subtree.
    for (let i = 0; i < parts.length; i += 1) {
      if (names.has(parts[i])) return true;
      if (names.has(parts.slice(0, i + 1).join('/'))) return true;
    }
    return false;
  };
}

// Walk a project. Returns files plus everything deliberately left out, because
// "synced" has to mean what it looks like it means: a cap or an ignore rule
// that silently drops a file is the difference between a working sync and one
// you only discover is incomplete when you need the file.
function build(root, options) {
  const opts = options || {};
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const ignores = [...DEFAULT_IGNORES, ...(opts.ignores || []),
    ...(opts.useGitignore === false ? [] : readGitignore(root))];
  const ignored = makeMatcher(ignores);

  const files = {};
  const skipped = [];
  let bytes = 0;

  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored(rel)) continue;
      const abs = path.join(dir, entry.name);

      // Symlinks are recorded as skipped rather than followed: following them
      // can walk out of the project entirely, and recreating them on the other
      // machine is a different feature with different questions.
      if (entry.isSymbolicLink()) { skipped.push({ path: rel, why: 'symlink' }); continue; }
      if (entry.isDirectory()) { walk(abs, rel); continue; }
      if (!entry.isFile()) { skipped.push({ path: rel, why: 'not-a-file' }); continue; }

      let st;
      try { st = fs.statSync(abs); } catch (_) { skipped.push({ path: rel, why: 'unreadable' }); continue; }
      if (st.size > maxBytes) { skipped.push({ path: rel, why: 'too-big', size: st.size }); continue; }

      try {
        files[rel] = {
          sha256: hashFile(abs),
          size: st.size,
          mtime: st.mtimeMs,
          mode: st.mode & 0o777,
        };
        bytes += st.size;
      } catch (_) {
        skipped.push({ path: rel, why: 'unreadable' });
      }
    }
  };

  walk(root, '');
  return { files, skipped, bytes, count: Object.keys(files).length };
}

// What would have to change to turn `from` into `to`. Deletions are explicit
// rather than "absent means gone": a manifest that failed to upload half its
// entries would otherwise read as a request to delete them.
function diff(from, to) {
  const added = [];
  const changed = [];
  const removed = [];
  const fromFiles = (from && from.files) || {};
  const toFiles = (to && to.files) || {};

  for (const [rel, meta] of Object.entries(toFiles)) {
    const before = fromFiles[rel];
    if (!before) added.push(rel);
    else if (before.sha256 !== meta.sha256) changed.push(rel);
  }
  for (const rel of Object.keys(fromFiles)) {
    if (!toFiles[rel]) removed.push(rel);
  }
  return { added, changed, removed };
}

// The blobs the other side needs that it cannot already have.
function missingBlobs(local, remoteHashes) {
  const have = new Set(remoteHashes || []);
  const want = new Set();
  for (const meta of Object.values((local && local.files) || {})) {
    if (!have.has(meta.sha256)) want.add(meta.sha256);
  }
  return [...want];
}

module.exports = { build, diff, missingBlobs, DEFAULT_IGNORES, DEFAULT_MAX_BYTES };
