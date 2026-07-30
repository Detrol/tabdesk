// Moving the portable bundle over SFTP.
//
// The payload is exactly what ⇄ Sync already writes to a file — same bytes,
// same format, same validation on the way in. Nothing here understands what a
// memory file is; it moves an opaque blob and lets portable.js decide what it
// means. That is deliberate: the review step before anything is written is the
// safety property, and duplicating the format here would be a second place for
// it to drift.
//
// Remote layout, all under the configured folder:
//
//   devices/<id>.json      who pushed, what they call themselves, when
//   bundle/<id>.tabdesk    that device's most recent export
//
// One bundle per device, overwritten each push. This is not a backup system —
// it is the newest state of each machine, and the receiving side diffs it.

const path = require('path');
const portable = require('../portable');
const config = require('./config');
const transport = require('./transport-sftp');

const DEVICES = 'devices';
const BUNDLES = 'bundle';

const remote = (cfg, ...parts) => path.posix.join(cfg.remotePath.replace(/\/+$/, ''), ...parts);

function sftpOf(conn) {
  return new Promise((resolve, reject) => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
}

// mkdir -p. SFTP has no recursive create, and a server that already has the
// directory answers with a failure we have to treat as success.
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
      sftp.mkdir(cur, (err) => {
        // Racing another client to the same directory is fine; anything else
        // is not, and will surface on the write that follows anyway.
        if (err && err.code !== 4) reject(err); else resolve();
      });
    });
  }
}

function putFile(sftp, dest, buf) {
  // Write beside, then rename. A reader polling this path sees either the old
  // bundle or the new one, never a half-uploaded file — which matters most on
  // the laptop, where the link can drop mid-push.
  const tmp = `${dest}.part`;
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(tmp);
    ws.on('error', reject);
    ws.on('close', () => {
      sftp.unlink(dest, () => {
        sftp.rename(tmp, dest, (err) => (err ? reject(err) : resolve()));
      });
    });
    ws.end(buf);
  });
}

function getFile(sftp, src) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const rs = sftp.createReadStream(src);
    // SFTP reports a missing file as status 2, which would otherwise reach the
    // UI as the string "2" and get looked up as a translation key.
    rs.on('error', (err) => reject(Object.assign(err, {
      code: err && err.code === 2 ? 'no-bundle' : (err && err.code) || 'read',
    })));
    rs.on('data', (c) => chunks.push(c));
    rs.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function readdir(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      // An empty remote is the normal state before the first push, not an error.
      if (err) { resolve([]); return; }
      resolve(list);
    });
  });
}

async function withConnection(fn) {
  const cfg = config.forConnect();
  const missing = config.missingFields();
  if (missing.length) throw Object.assign(new Error('incomplete'), { code: 'incomplete', missing });
  const conn = await transport.connect(cfg);
  try {
    const sftp = await sftpOf(conn);
    return await fn(sftp, cfg);
  } finally {
    try { conn.end(); } catch (_) { /* already gone */ }
  }
}

// Export this machine's setup and put it on the server.
async function push(slugs) {
  const { deviceId, deviceName } = config.identity();
  const bundle = portable.buildBundle({ slugs: Array.isArray(slugs) ? slugs : null });
  const blob = portable.packBundle(bundle);

  return withConnection(async (sftp, cfg) => {
    await ensureDir(sftp, remote(cfg, BUNDLES));
    await ensureDir(sftp, remote(cfg, DEVICES));
    await putFile(sftp, remote(cfg, BUNDLES, `${deviceId}.tabdesk`), blob);
    // The device record is written after the bundle, so a listing never
    // advertises a bundle that is not there yet.
    await putFile(sftp, remote(cfg, DEVICES, `${deviceId}.json`), Buffer.from(JSON.stringify({
      deviceId,
      deviceName,
      updatedAt: new Date().toISOString(),
      projects: bundle.projects.length,
      memoryFiles: bundle.projects.reduce((n, p) => n + p.memory.length, 0),
      bytes: blob.length,
    }, null, 2), 'utf8'));

    return {
      ok: true,
      deviceId,
      deviceName,
      bytes: blob.length,
      projects: bundle.projects.length,
      memoryFiles: bundle.projects.reduce((n, p) => n + p.memory.length, 0),
    };
  });
}

// Everything on the server that is not us.
async function peers() {
  const { deviceId } = config.identity();
  return withConnection(async (sftp, cfg) => {
    const list = await readdir(sftp, remote(cfg, DEVICES));
    const out = [];
    for (const entry of list) {
      if (!entry.filename.endsWith('.json')) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const raw = await getFile(sftp, remote(cfg, DEVICES, entry.filename));
        const rec = JSON.parse(raw.toString('utf8'));
        if (!rec.deviceId || rec.deviceId === deviceId) continue;
        out.push(rec);
      } catch (_) {
        // A device record we cannot read says nothing about the others.
      }
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { ok: true, peers: out, self: deviceId };
  });
}

// Fetch one peer's bundle. Returns the parsed bundle; the caller decides what
// to do with it, and portable.plan() is what tells the user.
async function pull(deviceId) {
  if (!deviceId || /[/\\]/.test(deviceId)) {
    throw Object.assign(new Error('bad device id'), { code: 'bad-device' });
  }
  return withConnection(async (sftp, cfg) => {
    const raw = await getFile(sftp, remote(cfg, BUNDLES, `${deviceId}.tabdesk`));
    // Same validation as a bundle picked off disk — a server is not a reason
    // to trust the bytes it served.
    return portable.parseBundle(raw);
  });
}

module.exports = { push, peers, pull };
