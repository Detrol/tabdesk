// The cryptography the sync format rests on.
//
// Deliberately small and boring: one AEAD, one KDF, one MAC, all from Node's
// own crypto. There is no algorithm agility here — a version byte in the
// header is the whole migration story, and choosing between ciphers at runtime
// is a way to end up negotiating down to the weakest one.
//
// Nothing in this file knows what a project or a blob is. It takes bytes and a
// context string and gives bytes back. What the context strings mean lives in
// files.js and bundle.js, where the format does.

const crypto = require('crypto');

// "TDE" + format version. Present so a client meeting a newer format says so
// instead of failing to decrypt and blaming the key.
const MAGIC = Buffer.from('TDE1', 'ascii');
const NONCE_LEN = 12;      // GCM's native size; anything else forces a rehash
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = MAGIC.length + NONCE_LEN;

// One subkey per purpose. Reusing the group key everywhere would mean a
// weakness in any one use — a nonce reuse, a bad AAD — reached all the others.
// The strings are versioned so a future format can rotate one purpose alone.
const INFO = {
  blob: 'tabdesk/blob/v1',
  meta: 'tabdesk/meta/v1',
  name: 'tabdesk/name/v1',
  slug: 'tabdesk/slug/v1',
};

function subkey(groupKey, purpose) {
  const info = INFO[purpose];
  if (!info) throw Object.assign(new Error(`unknown key purpose: ${purpose}`), { code: 'purpose' });
  if (!Buffer.isBuffer(groupKey) || groupKey.length !== KEY_LEN) {
    throw Object.assign(new Error('group key must be 32 bytes'), { code: 'malformed' });
  }
  // No salt: the group key is already uniformly random, which is the case HKDF
  // documents a zero salt for. A salt would have to be stored and agreed on,
  // and would buy nothing here.
  return Buffer.from(crypto.hkdfSync('sha256', groupKey, Buffer.alloc(0), Buffer.from(info, 'utf8'), KEY_LEN));
}

function derive(groupKey) {
  return {
    blob: subkey(groupKey, 'blob'),
    meta: subkey(groupKey, 'meta'),
    name: subkey(groupKey, 'name'),
    slug: subkey(groupKey, 'slug'),
  };
}

// seal(key, plaintext, aad) -> MAGIC | nonce | ciphertext | tag
//
// `aad` binds the result to where it is going to live. A blob sealed for one
// address will not open at another, so a server that shuffles files around
// produces failures rather than a plausible-looking wrong project.
function seal(key, plaintext, aad) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
    throw Object.assign(new Error('key must be 32 bytes'), { code: 'malformed' });
  }
  // Random 96-bit nonces. Safe here because a device would have to seal on the
  // order of 2^32 objects under one subkey before collisions became a concern,
  // and a rekey is cheap long before that. A counter would need durable state
  // that survives reinstalls, which is a worse failure mode.
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  if (aad !== undefined && aad !== null) cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([
    cipher.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)),
    cipher.final(),
  ]);
  return Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()]);
}

function open(key, sealed, aad) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
    throw Object.assign(new Error('key must be 32 bytes'), { code: 'malformed' });
  }
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  if (buf.length < HEADER_LEN + TAG_LEN) {
    throw Object.assign(new Error('sealed object is truncated'), { code: 'truncated' });
  }
  if (!buf.subarray(0, 3).equals(MAGIC.subarray(0, 3))) {
    throw Object.assign(new Error('not a TabDesk sealed object'), { code: 'not-sealed' });
  }
  if (buf[3] !== MAGIC[3]) {
    // Version mismatch is worth its own code: it means "upgrade", not
    // "your key is wrong", and those need different words in the UI.
    throw Object.assign(new Error(`sealed format v${String.fromCharCode(buf[3])} is not supported`), { code: 'version' });
  }

  const nonce = buf.subarray(MAGIC.length, HEADER_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const body = buf.subarray(HEADER_LEN, buf.length - TAG_LEN);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  if (aad !== undefined && aad !== null) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (_) {
    // GCM does not distinguish "wrong key" from "tampered" from "wrong AAD",
    // and pretending otherwise would be guessing.
    throw Object.assign(new Error('could not open: wrong key, wrong place, or altered'), { code: 'auth' });
  }
}

// Addresses. HMAC rather than the plain hash so the server cannot test whether
// a file it already has a copy of is one of yours — with sha256 as the name, it
// could simply compute the hash of a suspected file and look.
function blobAlias(nameKey, sha256hex) {
  return crypto.createHmac('sha256', nameKey).update(String(sha256hex), 'utf8').digest('hex');
}

// Truncated to 32 hex chars: it is a directory name, and 128 bits is far past
// what a collision would need. Full length just makes paths unreadable in a
// debug listing.
function slugAlias(slugKey, slug) {
  return crypto.createHmac('sha256', slugKey).update(String(slug), 'utf8').digest('hex').slice(0, 32);
}

const newGroupKey = () => crypto.randomBytes(KEY_LEN);

module.exports = {
  derive, subkey, seal, open, blobAlias, slugAlias, newGroupKey,
  KEY_LEN, MAGIC, INFO,
};
