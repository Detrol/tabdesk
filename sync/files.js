// Project files over SFTP, content-addressed and encrypted.
//
//   files/<slugalias>/manifest              sealed: path -> {sha256,size,mode}
//   files/<slugalias>/blobs/<aa>/<alias>    sealed content, once per hash
//
// One blob per hash means an unchanged file is never re-uploaded, a rename is
// a manifest edit, and two projects holding the same file share storage.
//
// Nothing in a path is a name or a hash. The directory is HMAC(k_slug, slug)
// and the blob is HMAC(k_name, sha256), so a server cannot read a project name
// off a listing, and cannot check whether a file it already holds a copy of is
// one of yours by computing its hash and looking. The real slug travels inside
// the sealed manifest, which is where list() gets it back from.
//
// The receiving side writes 0644 regardless of what the manifest says. That is
// not tidiness — Run and Preview execute what a project directory defines
// (npm scripts, run.sh, .venv/bin/python), so a synced executable bit would
// turn a compromised server into code execution on the machine that pulled.
// See trust.js for the other half of that.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const transport = require('./transport-sftp');
const manifest = require('./manifest');
const tcrypto = require('./crypto');
const keys = require('./keys');
const remoteFormat = require('./format');

const FILES = 'files';

const remote = (cfg, ...parts) => path.posix.join(cfg.remotePath.replace(/\/+$/, ''), ...parts);

// Everything below addresses by alias, never by slug or content hash. The
// directory a project lives in and the name a blob is filed under are both
// HMACs the group key computes; a server holding a copy of a file cannot work
// out where it would be stored, and cannot read a project name off a listing.
const blobPath = (cfg, alias, blobAlias) =>
  remote(cfg, FILES, alias, 'blobs', blobAlias.slice(0, 2), blobAlias);

function sftpOf(conn) {
  return new Promise((resolve, reject) => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
}

async function ensureDir(sftp, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = dir.startsWith('/') ? '' : '.';
  for (const part of parts) {
    cur = `${cur}/${part}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await new Promise((resolve) => sftp.stat(cur, (err) => resolve(!err)));
    if (exists) continue;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve, reject) => {
      sftp.mkdir(cur, (err) => { if (err && err.code !== 4) reject(err); else resolve(); });
    });
  }
}

function putBuffer(sftp, dest, buf) {
  const tmp = `${dest}.part`;
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(tmp);
    ws.on('error', reject);
    ws.on('close', () => sftp.unlink(dest, () => {
      sftp.rename(tmp, dest, (err) => (err ? reject(err) : resolve()));
    }));
    ws.end(buf);
  });
}

function getBuffer(sftp, src) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const rs = sftp.createReadStream(src);
    rs.on('error', (err) => reject(Object.assign(err, {
      code: err && err.code === 2 ? 'missing' : (err && err.code) || 'read',
    })));
    rs.on('data', (c) => chunks.push(c));
    rs.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function readdir(sftp, dir) {
  return new Promise((resolve) => sftp.readdir(dir, (err, list) => resolve(err ? [] : list)));
}

// Every operation goes through here, so every operation gets the same three
// preconditions: the remote is configured, this device has the group key, and
// the layout on the other end is one this code writes. Skipping the last would
// let a v2 push land beside v1 plaintext and leave a directory that is half
// readable — worse than either.
async function withConnection(fn) {
  const missing = config.missingFields();
  if (missing.length) throw Object.assign(new Error('incomplete'), { code: 'incomplete', missing });
  if (!keys.has()) throw Object.assign(new Error('no group key'), { code: 'no-key' });
  const k = keys.derived();
  const cfg = config.forConnect();
  const conn = await transport.connect(cfg);
  try {
    const sftp = await sftpOf(conn);
    await remoteFormat.require2(sftp, cfg);
    return await fn(sftp, cfg, k);
  } finally {
    try { conn.end(); } catch (_) { /* already gone */ }
  }
}

// Blob aliases already on the server for this project. Aliases, not hashes:
// that is all the server ever knew.
async function remoteAliases(sftp, cfg, alias) {
  const out = [];
  const root = remote(cfg, FILES, alias, 'blobs');
  const shards = await readdir(sftp, root);
  for (const shard of shards) {
    if (!shard.longname || !shard.longname.startsWith('d')) continue;
    // eslint-disable-next-line no-await-in-loop
    const inner = await readdir(sftp, `${root}/${shard.filename}`);
    for (const f of inner) out.push(f.filename);
  }
  return out;
}

async function readRemoteManifest(sftp, cfg, alias, k) {
  let raw;
  try {
    raw = await getBuffer(sftp, remote(cfg, FILES, alias, 'manifest'));
  } catch (_) {
    return null;   // nothing pushed yet is the normal first state
  }
  // A manifest that will not open is not "no manifest". It means the wrong key
  // or an altered file, and silently treating it as absent would make the next
  // push overwrite whatever is really there.
  const plain = tcrypto.open(k.meta, raw, `manifest|${alias}`);
  return JSON.parse(plain.toString('utf8'));
}

// Upload one project. Only blobs the server lacks are sent; the manifest is
// written last so a reader never sees an index pointing at blobs that are
// still uploading.
async function push(slug, localRoot, options) {
  const local = manifest.build(localRoot, options || {});
  const { deviceId, deviceName } = config.identity();

  return withConnection(async (sftp, cfg, k) => {
    const alias = tcrypto.slugAlias(k.slug, slug);
    const base = remote(cfg, FILES, alias);
    await ensureDir(sftp, `${base}/blobs`);

    // What the server already holds, in the only terms it knows.
    const have = new Set(await remoteAliases(sftp, cfg, alias));

    // Content hash -> one local path holding it. Several files can share
    // content; uploading it once is the whole point of addressing by hash.
    const byHash = new Map();
    for (const [rel, meta] of Object.entries(local.files)) {
      if (!byHash.has(meta.sha256)) byHash.set(meta.sha256, rel);
    }

    let uploaded = 0;
    let uploadedBytes = 0;
    for (const [hash, rel] of byHash) {
      const ba = tcrypto.blobAlias(k.name, hash);
      if (have.has(ba)) continue;
      const abs = path.join(localRoot, rel);
      let buf;
      try { buf = fs.readFileSync(abs); } catch (_) { continue; }
      // Re-hash what was actually read: the file may have changed between the
      // walk and here, and storing it under the old hash would corrupt the
      // store for every project that shares it.
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      if (actual !== hash) continue;
      const dest = blobPath(cfg, alias, ba);
      // AAD is the address. The same bytes sealed for another project or
      // another name will not open here, so a server cannot move a file
      // between projects and have it read as belonging.
      const sealed = tcrypto.seal(k.blob, buf, dest);
      // eslint-disable-next-line no-await-in-loop
      await ensureDir(sftp, path.posix.dirname(dest));
      // eslint-disable-next-line no-await-in-loop
      await putBuffer(sftp, dest, sealed);
      uploaded += 1;
      uploadedBytes += sealed.length;
    }

    const before = await readRemoteManifest(sftp, cfg, alias, k);
    const doc = {
      // The real slug lives in here, not in the path: list() needs it back and
      // the server must not have it.
      slug,
      deviceId,
      deviceName,
      updatedAt: new Date().toISOString(),
      files: local.files,
      skipped: local.skipped,
    };
    await putBuffer(sftp, `${base}/manifest`,
      tcrypto.seal(k.meta, Buffer.from(JSON.stringify(doc), 'utf8'), `manifest|${alias}`));

    const d = manifest.diff(before, doc);
    return {
      ok: true,
      slug,
      count: local.count,
      bytes: local.bytes,
      uploaded,
      uploadedBytes,
      skipped: local.skipped,
      added: d.added.length,
      changed: d.changed.length,
      removed: d.removed.length,
    };
  });
}

// Projects on the server, with who pushed them and when.
async function list() {
  const { deviceId } = config.identity();
  return withConnection(async (sftp, cfg, k) => {
    const entries = await readdir(sftp, remote(cfg, FILES));
    const out = [];
    for (const e of entries) {
      let m;
      try {
        // eslint-disable-next-line no-await-in-loop
        m = await readRemoteManifest(sftp, cfg, e.filename, k);
      } catch (_) {
        // A directory whose manifest will not open belongs to a different key
        // — another TabDesk sharing the folder, or one from before a rekey.
        // Listing it as broken would be wrong; it is simply not ours.
        continue;
      }
      if (!m) continue;
      out.push({
        // Recovered from inside the manifest. The directory name is an alias.
        slug: m.slug || e.filename,
        alias: e.filename,
        deviceId: m.deviceId,
        deviceName: m.deviceName,
        updatedAt: m.updatedAt,
        count: Object.keys(m.files || {}).length,
        bytes: Object.values(m.files || {}).reduce((n, f) => n + (f.size || 0), 0),
        skipped: (m.skipped || []).length,
        mine: m.deviceId === deviceId,
      });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { ok: true, projects: out };
  });
}

// What pulling would do to a local directory, without doing any of it.
async function plan(slug, localRoot, options) {
  return withConnection(async (sftp, cfg, k) => {
    const rm = await readRemoteManifest(sftp, cfg, tcrypto.slugAlias(k.slug, slug), k);
    if (!rm) throw Object.assign(new Error('no manifest'), { code: 'no-manifest' });
    const local = fs.existsSync(localRoot)
      ? manifest.build(localRoot, options || {})
      : { files: {}, skipped: [], bytes: 0, count: 0 };
    const d = manifest.diff(local, rm);
    return {
      ok: true,
      slug,
      source: { deviceName: rm.deviceName, updatedAt: rm.updatedAt },
      added: d.added,
      changed: d.changed,
      // Reported, never acted on. Deleting local files because a remote
      // manifest lacks them is a different decision than "bring me what is
      // new", and it is not one a first pull should make on its own.
      removedRemotely: d.removed,
      skipped: rm.skipped || [],
      localExists: fs.existsSync(localRoot),
    };
  });
}

// Fetch and write. Only added/changed files are touched; nothing is deleted.
async function pull(slug, localRoot, options) {
  const opts = options || {};
  return withConnection(async (sftp, cfg, k) => {
    const alias = tcrypto.slugAlias(k.slug, slug);
    const rm = await readRemoteManifest(sftp, cfg, alias, k);
    if (!rm) throw Object.assign(new Error('no manifest'), { code: 'no-manifest' });

    const local = fs.existsSync(localRoot)
      ? manifest.build(localRoot, opts)
      : { files: {}, skipped: [], bytes: 0, count: 0 };
    const d = manifest.diff(local, rm);
    const wanted = [...d.added, ...d.changed];

    fs.mkdirSync(localRoot, { recursive: true });
    let written = 0;
    let writtenBytes = 0;
    const failed = [];

    for (const rel of wanted) {
      const meta = rm.files[rel];
      // The manifest is attacker-controlled input the moment the server is.
      // A path that escapes the project root is refused outright.
      const abs = path.resolve(localRoot, rel);
      if (abs !== localRoot && !abs.startsWith(localRoot + path.sep)) {
        failed.push({ path: rel, why: 'escapes-root' });
        continue;
      }
      try {
        const src = blobPath(cfg, alias, tcrypto.blobAlias(k.name, meta.sha256));
        // eslint-disable-next-line no-await-in-loop
        const sealed = await getBuffer(sftp, src);
        // Opening is itself an integrity check — wrong key, wrong address or
        // altered bytes all fail here. The hash comparison below is the second
        // one, against what the manifest said the plaintext should be.
        const buf = tcrypto.open(k.blob, sealed, src);
        const actual = crypto.createHash('sha256').update(buf).digest('hex');
        if (actual !== meta.sha256) { failed.push({ path: rel, why: 'hash-mismatch' }); continue; }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // 0644 always. See the header: the executable bit does not travel.
        fs.writeFileSync(abs, buf, { mode: 0o644 });
        written += 1;
        writtenBytes += buf.length;
      } catch (err) {
        failed.push({ path: rel, why: err.code || 'error' });
      }
    }

    return {
      ok: true,
      slug,
      written,
      writtenBytes,
      failed,
      skippedRemotely: rm.skipped || [],
      source: { deviceName: rm.deviceName, updatedAt: rm.updatedAt },
    };
  });
}

// What the remote looks like, without needing the group key to find out.
// Answers the question the UI has to ask before offering anything: is there
// plaintext from before out there, and how much.
async function remoteState() {
  const missing = config.missingFields();
  if (missing.length) throw Object.assign(new Error('incomplete'), { code: 'incomplete', missing });
  const cfg = config.forConnect();
  const conn = await transport.connect(cfg);
  try {
    const sftp = await sftpOf(conn);
    return { ok: true, ...(await remoteFormat.detect(sftp, cfg)) };
  } finally {
    try { conn.end(); } catch (_) { /* already gone */ }
  }
}

// Replace a plaintext remote with an encrypted one.
//
// The old data is never rewritten in place — it is replaced by a fresh upload
// from the machine that still has the originals, and only then removed. That
// is slower and far easier to reason about: at no point is there a directory
// holding half-converted data, and a failure part-way leaves the old layout
// intact and still readable by an older client.
//
// `projects` is [{ slug, root }] — the caller knows which local directories
// correspond to what, and this module deliberately does not guess.
async function migrate(projects, options) {
  const cfg = config.forConnect();
  if (!keys.has()) throw Object.assign(new Error('no group key'), { code: 'no-key' });

  const before = await remoteState();
  if (before.version === remoteFormat.VERSION) return { ok: true, alreadyDone: true };
  if (!before.legacy && before.version !== 0) {
    throw Object.assign(new Error('not a legacy remote'), { code: 'not-legacy', state: before });
  }

  // Claim the new format first. A push that lands before the marker exists
  // would be refused by require2() for being format 0 and then claim it
  // itself, which works — but doing it up front means a crash half-way leaves
  // a remote that says what it is.
  const conn = await transport.connect(cfg);
  try {
    const sftp = await sftpOf(conn);
    await remoteFormat.claim(sftp, cfg);
  } finally {
    try { conn.end(); } catch (_) { /* already gone */ }
  }

  const done = [];
  const failed = [];
  for (const p of projects || []) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await push(p.slug, p.root, options || config.fileOptions());
      done.push({ slug: p.slug, count: res.count, uploaded: res.uploaded });
    } catch (err) {
      failed.push({ slug: p.slug, code: err.code || 'other', detail: String(err.message || err) });
    }
  }

  return { ok: failed.length === 0, migrated: done, failed, wasVersion: before.version };
}

// Remove the plaintext left over from format 1. Separate from migrate() and
// never automatic: deleting the only copy of something is not a step to bundle
// into an operation the user thought was an upload.
async function dropLegacy() {
  const cfg = config.forConnect();
  const conn = await transport.connect(cfg);
  try {
    const sftp = await sftpOf(conn);
    const removed = [];
    // Only the v1 shapes: manifest.json beside a plaintext-named directory.
    for (const dir of await readdir(sftp, remote(cfg, FILES))) {
      const mj = remote(cfg, FILES, dir.filename, 'manifest.json');
      // eslint-disable-next-line no-await-in-loop
      const isLegacy = await new Promise((resolve) => sftp.stat(mj, (err) => resolve(!err)));
      if (!isLegacy) continue;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => sftp.unlink(mj, () => resolve()));
      removed.push(dir.filename);
    }
    for (const d of await readdir(sftp, remote(cfg, 'devices'))) {
      if (!d.filename.endsWith('.json')) continue;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => sftp.unlink(remote(cfg, 'devices', d.filename), () => resolve()));
      removed.push(`devices/${d.filename}`);
    }
    for (const b of await readdir(sftp, remote(cfg, 'bundle'))) {
      if (!b.filename.endsWith('.tabdesk')) continue;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => sftp.unlink(remote(cfg, 'bundle', b.filename), () => resolve()));
      removed.push(`bundle/${b.filename}`);
    }
    return { ok: true, removed };
  } finally {
    try { conn.end(); } catch (_) { /* already gone */ }
  }
}

module.exports = { push, pull, plan, list, remoteState, migrate, dropLegacy };
