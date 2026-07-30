// SFTP transport.
//
// ssh2 directly rather than a promise wrapper: the one thing this has to get
// right is host key verification, and that is a low-level callback. Everything
// else here is a handful of calls it is not worth a dependency to smooth over.
//
// Two entry points, and the difference between them matters:
//
//   probe()   connects far enough to read the server's host key and hangs up
//             BEFORE authenticating. Nothing secret is sent. This is what backs
//             "is this the right server?" on a first connection.
//   test()    connects with the pinned key enforced, authenticates, and checks
//             the remote directory is actually usable.
//
// Splitting them is what keeps the trust decision honest: the user is shown a
// fingerprint that was obtained without handing anything over, and only after
// they accept it does a credential go anywhere near the wire.

const { Client } = require('ssh2');
const crypto = require('crypto');
const fs = require('fs');

const TIMEOUT = 15000;

function fingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

// ssh2 reports failures as bare Error objects whose messages are aimed at
// developers. Map the ones a user can act on to codes the UI can translate,
// and keep the original text for the rest.
function classify(err) {
  const m = String((err && err.message) || err || '');
  if (/All configured authentication methods failed/i.test(m)) return 'auth';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return 'dns';
  if (/ECONNREFUSED/i.test(m)) return 'refused';
  if (/ETIMEDOUT|timed out|Timed out/i.test(m)) return 'timeout';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(m)) return 'unreachable';
  if (/host-key-mismatch/.test(m)) return 'host-key-mismatch';
  if (/Cannot parse privateKey|Unsupported key format|bad passphrase|Encrypted private key/i.test(m)) return 'key';
  return 'other';
}

function readKey(cfg) {
  if (cfg.authMethod !== 'key') return null;
  try {
    return fs.readFileSync(cfg.keyPath);
  } catch (err) {
    const e = new Error(`keyfile: ${err.code || err.message}`);
    e.code = 'keyfile';
    throw e;
  }
}

function baseOptions(cfg) {
  const opts = {
    host: cfg.host,
    port: cfg.port || 22,
    username: cfg.user,
    readyTimeout: TIMEOUT,
    // Do not let ssh2 fall back to trying an agent or other identities: the
    // point is to prove that what is configured here works, not that some
    // ambient credential happens to.
    agent: undefined,
    tryKeyboard: false,
  };
  if (cfg.authMethod === 'key') {
    opts.privateKey = readKey(cfg);
    if (cfg.secret) opts.passphrase = cfg.secret;
  } else {
    opts.password = cfg.secret;
  }
  return opts;
}

// Read the host key without authenticating. Resolves { algo, sha256 }.
function probe(cfg) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let seen = null;
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; try { conn.end(); } catch (_) {} fn(arg); } };

    conn.on('error', (err) => done(reject, Object.assign(err, { code: classify(err) })));
    // Reaching 'ready' would mean authenticating, which is exactly what this
    // must not do — hostVerifier has already given us what we came for.
    conn.on('ready', () => done(resolve, seen));

    conn.connect({
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.user || 'tabdesk',
      readyTimeout: TIMEOUT,
      // No credential of any kind. Authentication will fail; we hang up in
      // hostVerifier long before it gets that far.
      hostVerifier: (key, cb) => {
        seen = { algo: 'ssh', sha256: fingerprint(key) };
        done(resolve, seen);
        cb(false);   // refuse: we have what we needed and nothing was sent
      },
    });

    setTimeout(() => done(reject, Object.assign(new Error('timed out'), { code: 'timeout' })), TIMEOUT + 1000);
  });
}

// Connect with the pin enforced. Resolves an open Client.
function connect(cfg) {
  return new Promise((resolve, reject) => {
    if (!cfg.hostKey || !cfg.hostKey.sha256) {
      reject(Object.assign(new Error('no pinned host key'), { code: 'not-pinned' }));
      return;
    }
    let opts;
    try { opts = baseOptions(cfg); } catch (err) { reject(err); return; }

    const conn = new Client();
    let settled = false;
    conn.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(Object.assign(err, { code: err.code === 'host-key-mismatch' ? err.code : classify(err) }));
    });
    conn.on('ready', () => { if (!settled) { settled = true; resolve(conn); } });

    // connect() throws SYNCHRONOUSLY when it cannot parse the private key —
    // a wrong passphrase is the common way to get there. Uncaught, that escapes
    // the executor and rejects with a bare Error carrying no code, which the UI
    // then looks up as a translation key that does not exist.
    try {
      conn.connect({
        ...opts,
        hostVerifier: (key, cb) => {
          const got = fingerprint(key);
          if (got === cfg.hostKey.sha256) { cb(true); return; }
          // Fail closed and say what changed. A server whose key moved is
          // either rebuilt or impersonated, and the client cannot tell which —
          // so it refuses and leaves the decision to a human.
          conn.emit('error', Object.assign(
            new Error(`host-key-mismatch expected ${cfg.hostKey.sha256} got ${got}`),
            { code: 'host-key-mismatch', expected: cfg.hostKey.sha256, got },
          ));
          cb(false);
        },
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(Object.assign(err, { code: classify(err) }));
      }
    }
  });
}

function sftpOf(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

// Full check: authenticate, confirm the remote directory exists, is a
// directory, and can actually be written to. "Connected" is not the useful
// answer — "your sync will work" is, and those differ whenever the path is
// wrong or read-only, which is most of the time somebody is debugging this.
async function test(cfg) {
  const conn = await connect(cfg);
  try {
    const sftp = await sftpOf(conn);
    const dir = cfg.remotePath;

    const stat = await new Promise((resolve, reject) => {
      sftp.stat(dir, (err, st) => (err ? reject(Object.assign(err, { code: 'no-path' })) : resolve(st)));
    });
    if (!stat.isDirectory()) {
      throw Object.assign(new Error('remote path is not a directory'), { code: 'not-a-dir' });
    }

    const probeFile = `${dir.replace(/\/+$/, '')}/.tabdesk-write-test`;
    await new Promise((resolve, reject) => {
      const ws = sftp.createWriteStream(probeFile);
      ws.on('error', (err) => reject(Object.assign(err, { code: 'not-writable' })));
      ws.on('close', resolve);
      ws.end('tabdesk\n');
    });
    await new Promise((resolve) => sftp.unlink(probeFile, () => resolve()));

    const entries = await new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)));
    });

    return { ok: true, path: dir, entries: entries.length, writable: true };
  } finally {
    try { conn.end(); } catch (_) { /* already gone */ }
  }
}

module.exports = { probe, connect, test, fingerprint };
