// Adding a device: one string, pasted.
//
// The invite carries everything the second machine needs — where the server is,
// which host key to pin, how to log in, and the group key — so that joining is
// two fields and not the seven that setting up the first device takes.
//
// It is a bearer secret. Whoever holds it before it expires has the same access
// the device it was made on has, and there is no way to make that untrue while
// still making it one thing to move. So it is short-lived by default, it says
// what it is wherever it is shown, and the SSH credential can be left out for
// the case where the other machine already has its own way in.
//
// base64url rather than base32: this is copied and pasted, not transcribed by
// hand, and an SSH private key inside base32 would make the string half again
// as long for no benefit. The recovery string in keys.js is the one people
// type, and that one is base32 for exactly that reason.

const zlib = require('zlib');
const fs = require('fs');
const config = require('./config');
const keys = require('./keys');

const PREFIX = 'TABDESK1-';
const VERSION = 1;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

// Build one from this device's configuration.
//
// `includeAuth: false` leaves out the SSH credential, for the case where the
// receiving machine can already reach the server on its own. Everything else
// still travels, including the group key — without that there is no point.
function create(options) {
  const opts = options || {};
  const cfg = config.forConnect();
  const missing = config.missingFields();
  if (missing.length) throw Object.assign(new Error('incomplete'), { code: 'incomplete', missing });
  if (!cfg.hostKey || !cfg.hostKey.sha256) {
    throw Object.assign(new Error('host key not pinned'), { code: 'not-pinned' });
  }
  if (!keys.has()) throw Object.assign(new Error('no group key'), { code: 'no-key' });

  const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl).toISOString();

  const payload = {
    v: VERSION,
    exp: expiresAt,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    path: cfg.remotePath,
    // Travels so the joining device pins the same key without being asked to
    // compare a fingerprint it has no way to judge. Pairing inherits the
    // protection from phase 2 rather than stepping around it.
    hostKey: cfg.hostKey,
    groupKey: keys.get().toString('base64'),
  };

  if (opts.includeAuth !== false) {
    if (cfg.authMethod === 'key') {
      // The key's bytes, not its path: ~/.ssh/id_ed25519 need not exist on the
      // other machine, and a path that resolves to nothing is exactly the kind
      // of failure that makes people give up on a feature.
      let material;
      try { material = fs.readFileSync(cfg.keyPath, 'utf8'); }
      catch (_) { throw Object.assign(new Error('key file unreadable'), { code: 'keyfile' }); }
      payload.auth = { method: 'key', material, passphrase: cfg.secret || '' };
    } else {
      payload.auth = { method: 'password', password: cfg.secret || '' };
    }
  }

  const body = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return { ok: true, invite: PREFIX + body.toString('base64url'), expiresAt, hasAuth: Boolean(payload.auth) };
}

function parse(str) {
  const raw = String(str || '').trim().replace(/\s+/g, '');
  if (!raw) throw Object.assign(new Error('empty'), { code: 'empty' });
  if (!raw.startsWith(PREFIX)) {
    throw Object.assign(new Error('not a TabDesk invite'), { code: 'not-invite' });
  }
  let payload;
  try {
    payload = JSON.parse(zlib.gunzipSync(Buffer.from(raw.slice(PREFIX.length), 'base64url')).toString('utf8'));
  } catch (_) {
    throw Object.assign(new Error('invite is damaged'), { code: 'damaged' });
  }
  if (payload.v !== VERSION) {
    throw Object.assign(new Error(`invite version ${payload.v}`), { code: 'version' });
  }
  // Expiry is checked here, on the receiving side, which is the only side that
  // matters — the device that made it cannot enforce anything.
  if (!payload.exp || Date.parse(payload.exp) < Date.now()) {
    throw Object.assign(new Error('invite has expired'), { code: 'expired', expiredAt: payload.exp });
  }
  if (!payload.host || !payload.user || !payload.path || !payload.groupKey) {
    throw Object.assign(new Error('invite is missing fields'), { code: 'malformed' });
  }
  return payload;
}

// What accepting would do, without doing it. The joining device may already
// belong to a TabDesk, and replacing its group key means losing access to
// whatever it had — that has to be said before, not after.
function preview(str) {
  const p = parse(str);
  return {
    ok: true,
    host: p.host,
    port: p.port,
    user: p.user,
    path: p.path,
    hostKeyFingerprint: p.hostKey && p.hostKey.sha256,
    hasAuth: Boolean(p.auth),
    authMethod: p.auth && p.auth.method,
    expiresAt: p.exp,
    replacesExistingKey: keys.has(),
  };
}

// Accept it. Writes the configuration, pins the host key, stores the group key,
// and — when the invite carried one — the private key, into userData rather
// than the user's ~/.ssh: it arrived over a wire and does not belong in the
// place their own identities live.
function accept(str, keyDir) {
  const p = parse(str);
  const patch = { host: p.host, port: p.port, user: p.user, remotePath: p.path };

  if (p.auth && p.auth.method === 'key') {
    const dest = `${keyDir.replace(/\/+$/, '')}/sync-identity`;
    fs.writeFileSync(dest, p.auth.material, { mode: 0o600 });
    patch.authMethod = 'key';
    patch.keyPath = dest;
    patch.secret = p.auth.passphrase || '';
  } else if (p.auth && p.auth.method === 'password') {
    patch.authMethod = 'password';
    patch.secret = p.auth.password || '';
  }

  config.save(patch);
  // save() clears a pin when the host changes, so this has to come after it.
  config.pinHostKey(p.hostKey);
  keys.adopt(Buffer.from(p.groupKey, 'base64'));
  // A joining device gets its own identity: two devices sharing an id would
  // overwrite each other's records and each think the other did not exist.
  config.identity();

  return { ok: true, host: p.host, path: p.path, fingerprint: keys.fingerprint() };
}

module.exports = { create, parse, preview, accept, PREFIX, DEFAULT_TTL_MS };
