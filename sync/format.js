// What version of the layout a remote is in, and refusing to guess.
//
// `tabdesk.json` is the one file on the server that stays in plaintext, and it
// holds nothing but a version number. That is deliberate: a client meeting a
// directory it does not understand has to be able to say so before it has the
// right key, and "I could not decrypt anything" is a terrible way to learn
// that you are talking to a newer TabDesk.
//
// Version 1 is the plaintext layout that shipped through phase 5 — slugs and
// content hashes as filenames, JSON in the clear. Version 2 is encrypted.

const path = require('path');

const VERSION = 2;
const MARKER = 'tabdesk.json';

const at = (cfg, ...parts) => path.posix.join(cfg.remotePath.replace(/\/+$/, ''), ...parts);

function readdir(sftp, dir) {
  return new Promise((resolve) => sftp.readdir(dir, (err, list) => resolve(err ? [] : list)));
}

function readFile(sftp, src) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const rs = sftp.createReadStream(src);
    rs.on('error', reject);
    rs.on('data', (c) => chunks.push(c));
    rs.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Three answers, and they lead to different places:
//   { version: 2 }            usable
//   { version: 1, legacy }    plaintext data from before — offer to migrate
//   { version: 0, empty }     nothing there yet — a first push will claim it
//   { version: n > 2 }        a newer TabDesk wrote this; stop
async function detect(sftp, cfg) {
  try {
    const raw = await readFile(sftp, at(cfg, MARKER));
    const doc = JSON.parse(raw.toString('utf8'));
    const v = Number(doc.format);
    if (!Number.isFinite(v)) return { version: 1, legacy: true, reason: 'unreadable-marker' };
    return { version: v, newer: v > VERSION, created: doc.created };
  } catch (_) {
    // No marker. Either nothing has ever been pushed, or this is a v1 remote
    // from before the marker existed — and those are told apart by whether it
    // has any data at all.
    const [files, devices, bundles] = await Promise.all([
      readdir(sftp, at(cfg, 'files')),
      readdir(sftp, at(cfg, 'devices')),
      readdir(sftp, at(cfg, 'bundle')),
    ]);
    const has = files.length || devices.length || bundles.length;
    if (!has) return { version: 0, empty: true };
    return {
      version: 1,
      legacy: true,
      projects: files.length,
      devices: devices.length,
      bundles: bundles.length,
    };
  }
}

function claim(sftp, cfg) {
  const doc = Buffer.from(JSON.stringify({ format: VERSION, created: new Date().toISOString() }, null, 2), 'utf8');
  const dest = at(cfg, MARKER);
  const tmp = `${dest}.part`;
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(tmp);
    ws.on('error', reject);
    ws.on('close', () => sftp.unlink(dest, () => {
      sftp.rename(tmp, dest, (err) => (err ? reject(err) : resolve()));
    }));
    ws.end(doc);
  });
}

// The gate every operation goes through. Reading or writing a v1 remote with
// v2 code would produce a directory that is half in the clear, which is worse
// than either — so it refuses, and the caller offers a migration instead.
async function require2(sftp, cfg) {
  const state = await detect(sftp, cfg);
  if (state.version === VERSION) return state;
  if (state.version === 0) { await claim(sftp, cfg); return { version: VERSION, claimed: true }; }
  if (state.legacy) throw Object.assign(new Error('remote holds unencrypted data'), { code: 'legacy', state });
  throw Object.assign(new Error(`remote is format ${state.version}`), { code: 'newer-format', state });
}

module.exports = { detect, claim, require2, VERSION, MARKER };
