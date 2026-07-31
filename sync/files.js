// Project files over SFTP, content-addressed.
//
//   files/<slug>/manifest.json          path -> {sha256,size,mtime,mode}
//   files/<slug>/blobs/<aa>/<sha256>    the content, once per distinct hash
//
// One blob per hash means an unchanged file is never re-uploaded, a rename is
// a manifest edit, and two projects holding the same file share storage. It
// also gives the receiving side a cheap question: which of these hashes do I
// already have on disk?
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

const FILES = 'files';

const remote = (cfg, ...parts) => path.posix.join(cfg.remotePath.replace(/\/+$/, ''), ...parts);
const blobPath = (cfg, slug, hash) => remote(cfg, FILES, slug, 'blobs', hash.slice(0, 2), hash);

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

async function withConnection(fn) {
  const missing = config.missingFields();
  if (missing.length) throw Object.assign(new Error('incomplete'), { code: 'incomplete', missing });
  const cfg = config.forConnect();
  const conn = await transport.connect(cfg);
  try {
    return await fn(await sftpOf(conn), cfg);
  } finally {
    try { conn.end(); } catch (_) { /* already gone */ }
  }
}

// Hashes already on the server for this project.
async function remoteHashes(sftp, cfg, slug) {
  const out = [];
  const root = remote(cfg, FILES, slug, 'blobs');
  const shards = await readdir(sftp, root);
  for (const shard of shards) {
    if (!shard.longname || !shard.longname.startsWith('d')) continue;
    // eslint-disable-next-line no-await-in-loop
    const inner = await readdir(sftp, `${root}/${shard.filename}`);
    for (const f of inner) out.push(f.filename);
  }
  return out;
}

async function readRemoteManifest(sftp, cfg, slug) {
  try {
    const raw = await getBuffer(sftp, remote(cfg, FILES, slug, 'manifest.json'));
    return JSON.parse(raw.toString('utf8'));
  } catch (_) {
    return null;   // nothing pushed yet is the normal first state
  }
}

// Upload one project. Only blobs the server lacks are sent; the manifest is
// written last so a reader never sees an index pointing at blobs that are
// still uploading.
async function push(slug, localRoot, options) {
  const local = manifest.build(localRoot, options || {});
  const { deviceId, deviceName } = config.identity();

  return withConnection(async (sftp, cfg) => {
    const base = remote(cfg, FILES, slug);
    await ensureDir(sftp, `${base}/blobs`);

    const have = await remoteHashes(sftp, cfg, slug);
    const need = manifest.missingBlobs(local, have);

    // Hash -> one local path holding it. Several files can share content;
    // uploading it once is the whole point of addressing by hash.
    const byHash = new Map();
    for (const [rel, meta] of Object.entries(local.files)) {
      if (!byHash.has(meta.sha256)) byHash.set(meta.sha256, rel);
    }

    let uploaded = 0;
    let uploadedBytes = 0;
    for (const hash of need) {
      const rel = byHash.get(hash);
      if (!rel) continue;
      const abs = path.join(localRoot, rel);
      let buf;
      try { buf = fs.readFileSync(abs); } catch (_) { continue; }
      // Re-hash what was actually read: the file may have changed between the
      // walk and here, and storing it under the old hash would corrupt the
      // store for every project that shares it.
      const actual = crypto.createHash('sha256').update(buf).digest('hex');
      if (actual !== hash) continue;
      // eslint-disable-next-line no-await-in-loop
      await ensureDir(sftp, path.posix.dirname(blobPath(cfg, slug, hash)));
      // eslint-disable-next-line no-await-in-loop
      await putBuffer(sftp, blobPath(cfg, slug, hash), buf);
      uploaded += 1;
      uploadedBytes += buf.length;
    }

    const before = await readRemoteManifest(sftp, cfg, slug);
    const doc = {
      slug,
      deviceId,
      deviceName,
      updatedAt: new Date().toISOString(),
      files: local.files,
      skipped: local.skipped,
    };
    await putBuffer(sftp, `${base}/manifest.json`, Buffer.from(JSON.stringify(doc, null, 2), 'utf8'));

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
  return withConnection(async (sftp, cfg) => {
    const entries = await readdir(sftp, remote(cfg, FILES));
    const out = [];
    for (const e of entries) {
      // eslint-disable-next-line no-await-in-loop
      const m = await readRemoteManifest(sftp, cfg, e.filename);
      if (!m) continue;
      out.push({
        slug: e.filename,
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
  return withConnection(async (sftp, cfg) => {
    const rm = await readRemoteManifest(sftp, cfg, slug);
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
  return withConnection(async (sftp, cfg) => {
    const rm = await readRemoteManifest(sftp, cfg, slug);
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
        // eslint-disable-next-line no-await-in-loop
        const buf = await getBuffer(sftp, blobPath(cfg, slug, meta.sha256));
        // Verify what arrived is what the manifest promised. Without this the
        // hash is a naming convention rather than an integrity check.
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

module.exports = { push, pull, plan, list };
