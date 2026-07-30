// Portable state: export/import the "light layer" of a Claude Code setup.
//
// Three things are worth carrying from a laptop to a workstation, and none of
// them are the code:
//   * per-project memory  — ~/.claude/projects/<slug>/memory/**.md
//   * each project's CLAUDE.md
//   * TabDesk's own preferences and per-project model choices
//
// Deliberately NOT included: the session transcripts next to those memory
// directories (~/.claude/projects/<slug>/*.jsonl — hundreds of megabytes of
// past conversation) and the project files themselves. Git and rsync move
// those better than a client import ever will. What is left is text, measured
// in hundreds of kilobytes.
//
// The awkward part is that ~/.claude/projects names its directories after a
// slugified absolute path — /home/jonaz/claude-projects/thern.io becomes
// -home-jonaz-claude-projects-thern-io — and TabDesk's own projectModels map is
// keyed by absolute path. Both are meaningless on a machine with a different
// user or project root. So paths travel home-relative wherever they can, and
// are re-anchored to the importing machine's home on the way in.

const { app } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const settings = require('./settings');

const FORMAT = 'tabdesk-portable';
const VERSION = 1;

const claudeProjectsDir = () => path.join(os.homedir(), '.claude', 'projects');
const projectsRoot = () => path.join(os.homedir(), 'claude-projects');

// Claude Code's directory naming: every character that isn't alphanumeric
// becomes a dash. Lossy on purpose — "bokföring" lands as "bokf-ring" and there
// is no way back — which is why we always slug forwards from a real path and
// never try to parse a slug into one.
function slugify(absPath) {
  return String(absPath).replace(/[^A-Za-z0-9]/g, '-');
}

// A path expressed relative to home, or null when it lives outside it. Home
// itself is '.', not '' — Claude Code is routinely run there, and an empty
// string would read as "no relative path" everywhere downstream.
function homeRelative(abs, home) {
  const rel = path.relative(home || os.homedir(), abs);
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// ---- reading the local machine ---------------------------------------------

// Memory files under one project, flattened to `subdir/name.md` keys.
function readMemory(dir, prefix) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...readMemory(full, rel)); continue; }
    if (!entry.name.endsWith('.md')) continue;
    // One unreadable file shouldn't cost you the whole export.
    try { out.push({ name: rel, text: fs.readFileSync(full, 'utf8') }); } catch (_) { /* skip */ }
  }
  return out;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

// Where a project's memory lives, given the project's own path.
const memoryDirFor = (projectPath) =>
  path.join(claudeProjectsDir(), slugify(projectPath), 'memory');

// Every path that might own memory or a CLAUDE.md. Slugs can't be inverted, so
// this walks forwards from the directories we do know about; anything left over
// is handled as an orphan below.
function candidatePaths() {
  const home = os.homedir();
  const root = projectsRoot();
  // Home and the projects root are projects in their own right — Claude Code is
  // routinely run in both, and both accumulate memory.
  const set = new Set([home, root]);
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) set.add(path.join(root, entry.name));
    }
  } catch (_) { /* no ~/claude-projects on this machine */ }
  for (const key of Object.keys(settings.get('projectModels') || {})) {
    if (path.isAbsolute(key)) set.add(path.normalize(key));
  }
  return [...set];
}

// Collect everything exportable. `withText` decides whether file bodies come
// along — the inventory the UI shows only needs the counts.
function collect(withText) {
  const home = os.homedir();
  const models = settings.get('projectModels') || {};
  const projects = [];
  const claimed = new Set();

  for (const projectPath of candidatePaths()) {
    const slug = slugify(projectPath);
    const memDir = path.join(claudeProjectsDir(), slug, 'memory');
    const memory = readMemory(memDir, '');
    const claudeMd = readText(path.join(projectPath, 'CLAUDE.md'));
    const model = models[projectPath] || null;
    claimed.add(slug);
    if (!memory.length && claudeMd === null && !model) continue;

    const bytes = memory.reduce((n, f) => n + Buffer.byteLength(f.text), 0) +
                  (claudeMd ? Buffer.byteLength(claudeMd) : 0);
    projects.push({
      slug,
      path: projectPath,
      relHome: homeRelative(projectPath, home),
      name: path.basename(projectPath) || projectPath,
      model,
      memoryCount: memory.length,
      hasClaudeMd: claudeMd !== null,
      bytes,
      memory: withText ? memory : undefined,
      claudeMd: withText ? claudeMd : undefined,
    });
  }

  // Memory directories whose project path we couldn't reconstruct (a project
  // outside ~/claude-projects that TabDesk has never opened). Their slug still
  // starts with the slugified home, so it can be re-anchored textually on
  // import — losing them silently would be worse than carrying them blind.
  const orphans = [];
  const homeSlug = slugify(home);
  let slugDirs = [];
  try { slugDirs = fs.readdirSync(claudeProjectsDir(), { withFileTypes: true }); } catch (_) { /* none */ }
  for (const entry of slugDirs) {
    if (!entry.isDirectory() || claimed.has(entry.name)) continue;
    const memory = readMemory(path.join(claudeProjectsDir(), entry.name, 'memory'), '');
    if (!memory.length) continue;
    orphans.push({
      slug: entry.name,
      path: null,
      relHome: null,
      name: entry.name,
      model: null,
      // Only re-anchorable when it sits under this machine's home.
      anchored: entry.name.startsWith(homeSlug),
      memoryCount: memory.length,
      hasClaudeMd: false,
      bytes: memory.reduce((n, f) => n + Buffer.byteLength(f.text), 0),
      memory: withText ? memory : undefined,
      claudeMd: withText ? null : undefined,
    });
  }

  return { home, homeSlug, projects, orphans, models };
}

// What this machine has to offer, for the export side of the UI.
function scan() {
  const { home, projects, orphans, models } = collect(false);
  const all = [...projects, ...orphans];
  return {
    home,
    hostname: os.hostname(),
    projects: all,
    prefs: { theme: settings.get('theme'), language: settings.get('language') },
    totals: {
      projects: all.length,
      memoryFiles: all.reduce((n, p) => n + p.memoryCount, 0),
      claudeMd: all.filter((p) => p.hasClaudeMd).length,
      models: Object.keys(models).length,
      bytes: all.reduce((n, p) => n + p.bytes, 0),
    },
  };
}

// ---- the bundle ------------------------------------------------------------

// Model overrides travel keyed the same way projects do, so they survive a
// different home directory.
function portableModels(home, models) {
  const out = [];
  for (const [key, id] of Object.entries(models)) {
    out.push({ path: key, relHome: homeRelative(key, home), id });
  }
  return out;
}

function buildBundle(options) {
  const opts = options || {};
  const { home, projects, orphans, models } = collect(true);
  let include = [...projects, ...orphans];
  // An explicit slug list narrows the export; no list means everything.
  if (Array.isArray(opts.slugs)) {
    const wanted = new Set(opts.slugs);
    include = include.filter((p) => wanted.has(p.slug));
  }

  return {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    source: {
      home,
      hostname: os.hostname(),
      platform: process.platform,
      projectsRoot: projectsRoot(),
      app: (app && app.getVersion && app.getVersion()) || null,
    },
    prefs: { theme: settings.get('theme'), language: settings.get('language') },
    projectModels: portableModels(home, models),
    projects: include.map((p) => ({
      slug: p.slug,
      path: p.path,
      relHome: p.relHome,
      name: p.name,
      memory: p.memory || [],
      claudeMd: p.claudeMd === undefined ? null : p.claudeMd,
    })),
  };
}

// Gzipped JSON. Small enough to mail, and `gunzip -c x.tabdesk | jq` still
// reads it — nothing here should need TabDesk to inspect.
function writeBundle(file, bundle) {
  const json = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(json));
  return { ok: true, path: file, bytes: fs.statSync(file).size, plain: json.length };
}

// The same bytes writeBundle() would put on disk. Sync sends these straight
// over the wire rather than staging a temp file, but the format stays one
// thing: what lands on the server is byte-for-byte an exportable .tabdesk.
function packBundle(bundle) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'));
}

// Validation lives here, on the buffer, so every path into the app goes
// through it — a bundle pulled off a server is no more trusted than one
// picked from disk.
function parseBundle(raw) {
  // Accept a plain-JSON bundle too, so a hand-edited one still imports.
  const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  const text = (isGzip ? zlib.gunzipSync(raw) : raw).toString('utf8');
  const bundle = JSON.parse(text);
  if (!bundle || bundle.format !== FORMAT) throw new Error('not a TabDesk bundle');
  if (!(bundle.version <= VERSION)) throw new Error(`bundle version ${bundle.version} is newer than this TabDesk`);
  if (!Array.isArray(bundle.projects)) throw new Error('bundle has no projects');
  return bundle;
}

function readBundle(file) {
  return parseBundle(fs.readFileSync(file));
}

// ---- re-anchoring ----------------------------------------------------------

// Where a bundle entry should land on this machine. Home-relative entries are
// re-anchored to the local home; absolute ones outside home are taken as-is.
// Returns null when the entry can't be placed safely.
function localPathFor(entry, sourceHome) {
  const home = os.homedir();
  if (entry.relHome) {
    const rel = String(entry.relHome);
    if (path.isAbsolute(rel) || rel.includes('\0')) return null;
    const abs = path.resolve(home, rel);
    // resolve() collapses any ".." — make sure it didn't climb out of home.
    if (abs !== home && homeRelative(abs, home) === null) return null;
    return abs;
  }
  if (entry.path && path.isAbsolute(entry.path)) {
    const abs = path.normalize(entry.path);
    // A path that was under the source home but arrived without relHome would
    // point at a stranger's directory here. Refuse it rather than guess.
    if (sourceHome && (abs === sourceHome || abs.startsWith(sourceHome + path.sep))) return null;
    return abs;
  }
  return null;
}

// Slug for an entry with no recoverable path: swap the source home's slug
// prefix for this machine's.
function localSlugFor(entry, sourceHome) {
  const localPath = localPathFor(entry, sourceHome);
  if (localPath) return slugify(localPath);
  // A path that was supplied and then refused means a malformed or hostile
  // entry. The slug fallback exists for entries that never carried a path at
  // all — it isn't a second chance for one that failed the check.
  if (entry.relHome || entry.path) return null;

  const srcSlug = slugify(sourceHome || '');
  const slug = String(entry.slug || '');
  if (!srcSlug || !slug.startsWith(srcSlug)) return null;
  // Re-slug the tail: it comes from the bundle, and it may only ever name one
  // directory under ~/.claude/projects. Slugging leaves nothing — no separator,
  // no dot — that could climb out of it.
  return slugify(os.homedir()) + slugify(slug.slice(srcSlug.length));
}

// Memory entries name a file inside the memory directory. Anything that could
// climb out of it is dropped.
function safeMemoryName(name) {
  const raw = String(name || '');
  if (!raw.endsWith('.md') || raw.includes('\0') || path.isAbsolute(raw)) return null;
  const norm = path.normalize(raw);
  if (norm.split(/[/\\]/).some((part) => part === '..')) return null;
  return norm;
}

// Absolute paths baked into memory prose ("the key lives in /home/jonaz/...")
// don't survive a different home on their own.
function rewriteHome(text, sourceHome) {
  const home = os.homedir();
  if (!text || !sourceHome || sourceHome === home) return { text, hits: 0 };
  const parts = String(text).split(sourceHome);
  return { text: parts.join(home), hits: parts.length - 1 };
}

// ---- plan (the diff shown before anything is written) ----------------------

function plan(bundle) {
  const sourceHome = (bundle.source && bundle.source.home) || null;
  const home = os.homedir();
  const rewriting = Boolean(sourceHome && sourceHome !== home);
  const localModels = settings.get('projectModels') || {};
  const projects = [];
  let pathHits = 0;

  for (const entry of bundle.projects) {
    const localPath = localPathFor(entry, sourceHome);
    const slug = localSlugFor(entry, sourceHome);
    if (!slug) {
      // Carry the file count: a project we can't place is data the import
      // silently drops, and the summary has to be able to say how much.
      projects.push({
        name: entry.name || entry.slug, slug: entry.slug, skipped: 'unplaceable',
        fileCount: (entry.memory || []).length + (typeof entry.claudeMd === 'string' ? 1 : 0),
        memory: [], claudeMd: null,
      });
      continue;
    }
    const memDir = path.join(claudeProjectsDir(), slug, 'memory');
    const memory = [];
    for (const file of entry.memory || []) {
      const name = safeMemoryName(file.name);
      if (!name) continue;
      const incoming = rewriteHome(file.text, sourceHome);
      pathHits += incoming.hits;
      const existing = readText(path.join(memDir, name));
      memory.push({
        name,
        status: existing === null ? 'new' : (existing === incoming.text ? 'same' : 'changed'),
      });
    }

    let claudeMd = null;
    if (typeof entry.claudeMd === 'string') {
      const incoming = rewriteHome(entry.claudeMd, sourceHome);
      pathHits += incoming.hits;
      if (!localPath || !fs.existsSync(localPath)) {
        // We never create a project directory: that's the heavy layer's job.
        claudeMd = { status: 'no-project' };
      } else {
        const existing = readText(path.join(localPath, 'CLAUDE.md'));
        claudeMd = { status: existing === null ? 'new' : (existing === incoming.text ? 'same' : 'changed') };
      }
    }

    projects.push({
      name: entry.name || path.basename(localPath || slug),
      slug,
      slugChanged: slug !== entry.slug,
      path: localPath,
      pathExists: Boolean(localPath && fs.existsSync(localPath)),
      memory,
      claudeMd,
    });
  }

  const models = [];
  for (const item of bundle.projectModels || []) {
    const localPath = localPathFor(item, sourceHome);
    if (!localPath) { models.push({ name: item.path, skipped: 'unplaceable' }); continue; }
    const current = localModels[localPath];
    models.push({
      name: path.basename(localPath),
      path: localPath,
      id: item.id,
      status: current === undefined ? 'new' : (current === item.id ? 'same' : 'changed'),
    });
  }

  const prefs = [];
  for (const key of ['theme', 'language']) {
    const incoming = bundle.prefs && bundle.prefs[key];
    if (typeof incoming !== 'string') continue;
    const current = settings.get(key);
    prefs.push({ key, from: current, to: incoming, status: current === incoming ? 'same' : 'changed' });
  }

  const count = (kind) => projects.reduce(
    (n, p) => n + p.memory.filter((m) => m.status === kind).length +
      (p.claudeMd && p.claudeMd.status === kind ? 1 : 0), 0);

  return {
    source: bundle.source || {},
    createdAt: bundle.createdAt || null,
    rewriting,
    localHome: home,
    projects,
    models,
    prefs,
    totals: {
      new: count('new'),
      changed: count('changed'),
      same: count('same'),
      noProject: projects.filter((p) => p.claudeMd && p.claudeMd.status === 'no-project').length,
      // Projects and models are counted apart: the summary says "N files across
      // M projects", and a model override that can't be placed is not a project.
      unplaceable: projects.filter((p) => p.skipped).length,
      unplaceableModels: models.filter((m) => m.skipped).length,
      // How much data those unplaceable projects account for — new/changed/same
      // don't cover it, so without this the summary reads as full coverage.
      unplaceableFiles: projects.reduce((n, p) => n + (p.fileCount || 0), 0),
      modelsNew: models.filter((m) => m.status === 'new').length,
      modelsChanged: models.filter((m) => m.status === 'changed').length,
      prefsChanged: prefs.filter((p) => p.status === 'changed').length,
      pathRewrites: pathHits,
    },
  };
}

// ---- apply -----------------------------------------------------------------

// A snapshot of the current light layer, written before an import touches
// anything. Restoring is just importing this file back.
function backup() {
  const dir = path.join(app.getPath('userData'), 'portable-backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `before-import-${stamp}.tabdesk`);
  writeBundle(file, buildBundle({}));
  // Keep the last ten; these are small, but not worth hoarding forever.
  try {
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.tabdesk')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 10))) fs.unlinkSync(path.join(dir, f));
  } catch (_) { /* pruning is best effort */ }
  return file;
}

// options: { memory, claudeMd, models, prefs, overwrite }
// `overwrite` false means additive: new files land, existing different ones are
// left alone and reported as conflicts.
function apply(bundle, options) {
  const opts = {
    memory: true, claudeMd: true, models: true, prefs: true, overwrite: false,
    ...(options || {}),
  };
  const sourceHome = (bundle.source && bundle.source.home) || null;
  const result = {
    backup: null,
    written: [], skipped: [], failed: [],
    prefsChanged: [], modelsWritten: 0,
  };

  try { result.backup = backup(); } catch (err) {
    // No backup means no import — the whole point is that this is reversible.
    return { ok: false, error: `could not write a backup first: ${err.message || err}` };
  }

  for (const entry of bundle.projects) {
    const slug = localSlugFor(entry, sourceHome);
    if (!slug) { result.skipped.push({ what: entry.name || entry.slug, why: 'unplaceable' }); continue; }
    const localPath = localPathFor(entry, sourceHome);
    const memDir = path.join(claudeProjectsDir(), slug, 'memory');

    if (opts.memory) {
      for (const file of entry.memory || []) {
        const name = safeMemoryName(file.name);
        if (!name) { result.skipped.push({ what: String(file.name), why: 'unsafe-name' }); continue; }
        const target = path.join(memDir, name);
        const incoming = rewriteHome(file.text, sourceHome).text;
        const existing = readText(target);
        if (existing === incoming) continue;
        if (existing !== null && !opts.overwrite) {
          result.skipped.push({ what: `${slug}/${name}`, why: 'conflict' });
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, incoming);
          result.written.push({ what: `${slug}/${name}`, kind: 'memory' });
        } catch (err) {
          result.failed.push({ what: `${slug}/${name}`, error: String(err.message || err) });
        }
      }
    }

    if (opts.claudeMd && typeof entry.claudeMd === 'string') {
      if (!localPath || !fs.existsSync(localPath)) {
        result.skipped.push({ what: `${entry.name || slug}/CLAUDE.md`, why: 'no-project' });
      } else {
        const target = path.join(localPath, 'CLAUDE.md');
        const incoming = rewriteHome(entry.claudeMd, sourceHome).text;
        const existing = readText(target);
        if (existing !== incoming) {
          if (existing !== null && !opts.overwrite) {
            result.skipped.push({ what: `${entry.name || slug}/CLAUDE.md`, why: 'conflict' });
          } else {
            try {
              fs.writeFileSync(target, incoming);
              result.written.push({ what: `${entry.name || slug}/CLAUDE.md`, kind: 'claudeMd' });
            } catch (err) {
              result.failed.push({ what: `${entry.name || slug}/CLAUDE.md`, error: String(err.message || err) });
            }
          }
        }
      }
    }
  }

  if (opts.models) {
    // Merge rather than replace: a project this machine knows and the bundle
    // doesn't should keep its model.
    const map = { ...(settings.get('projectModels') || {}) };
    for (const item of bundle.projectModels || []) {
      const localPath = localPathFor(item, sourceHome);
      if (!localPath || typeof item.id !== 'string') continue;
      if (map[localPath] !== undefined && map[localPath] !== item.id && !opts.overwrite) {
        result.skipped.push({ what: path.basename(localPath), why: 'conflict-model' });
        continue;
      }
      if (map[localPath] === item.id) continue;
      map[localPath] = item.id;
      result.modelsWritten++;
    }
    if (result.modelsWritten) settings.set('projectModels', map);
  }

  if (opts.prefs && bundle.prefs) {
    for (const key of ['theme', 'language']) {
      const incoming = bundle.prefs[key];
      if (typeof incoming !== 'string' || settings.get(key) === incoming) continue;
      settings.set(key, incoming);
      result.prefsChanged.push(key);
    }
  }

  return { ok: true, ...result };
}

// Suggested filename for the save dialog.
function suggestedName() {
  const stamp = new Date().toISOString().slice(0, 10);
  const host = os.hostname().replace(/[^A-Za-z0-9._-]/g, '-');
  return `tabdesk-${host}-${stamp}.tabdesk`;
}

module.exports = {
  FORMAT, VERSION,
  slugify, scan, buildBundle, writeBundle, readBundle, packBundle, parseBundle,
  plan, apply, suggestedName,
  memoryDirFor,
};
