// The group key: its life, and the one string that can bring it back.
//
// Every device in one TabDesk holds the same 32 bytes. They are what makes the
// server unable to read anything, which is the same as saying they are the only
// thing that can. There is no copy anywhere else, and no way to ask for one.
//
// Stored through safeStorage, like the SSH secret — settings.json holds a
// base64 blob the desktop keyring can open and nothing else can.

const crypto = require('crypto');
const { safeStorage } = require('electron');
const settings = require('../settings');
const tcrypto = require('./crypto');

const KEY = 'sync';

// Crockford base32: no I, L, O or U, so a handwritten 1/l or 0/O cannot be
// read back wrong, and no accidental words. 32 bytes becomes 52 characters,
// plus 4 of checksum, shown in groups of four.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DECODE = new Map([...ALPHABET].map((c, i) => [c, i]));
// The letters Crockford says to fold into their lookalikes when reading.
for (const [from, to] of [['I', '1'], ['L', '1'], ['O', '0'], ['U', 'V']]) {
  DECODE.set(from, DECODE.get(to));
}

function b32encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function b32decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase()) {
    if (ch === '-' || ch === ' ') continue;
    const v = DECODE.get(ch);
    if (v === undefined) throw Object.assign(new Error(`bad character: ${ch}`), { code: 'charset' });
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// Four checksum characters over the key. Without them a single mistyped
// character produces 32 bytes that are simply the wrong key — and "the wrong
// key" and "the right key" are indistinguishable until data fails to open,
// which could be much later.
function checksum(keyBuf) {
  return b32encode(crypto.createHash('sha256').update(keyBuf).digest().subarray(0, 3)).slice(0, 4);
}

function group(str) {
  return (str.match(/.{1,4}/g) || []).join('-');
}

// TD-XXXX-XXXX-… — the prefix so a string found later is identifiable as this
// and not as some other secret.
function toRecovery(keyBuf) {
  return `TD-${group(b32encode(keyBuf) + checksum(keyBuf))}`;
}

function fromRecovery(str) {
  const cleaned = String(str || '').trim().replace(/^TD-?/i, '').replace(/[-\s]/g, '');
  if (!cleaned) throw Object.assign(new Error('empty recovery string'), { code: 'empty' });

  // Charset before length. Slicing off the checksum first meant a string of
  // nothing but invalid characters was reported as the wrong length, which
  // sends someone counting their groups instead of looking at what they typed.
  for (const ch of cleaned.toUpperCase()) {
    if (!DECODE.has(ch)) throw Object.assign(new Error(`bad character: ${ch}`), { code: 'charset' });
  }

  const body = cleaned.slice(0, -4);
  const given = cleaned.slice(-4).toUpperCase();
  const keyBuf = b32decode(body).subarray(0, tcrypto.KEY_LEN);
  if (keyBuf.length !== tcrypto.KEY_LEN) {
    throw Object.assign(new Error('recovery string is the wrong length'), { code: 'length' });
  }
  if (checksum(keyBuf) !== given) {
    throw Object.assign(new Error('recovery string does not check out — a character is wrong'), { code: 'checksum' });
  }
  return keyBuf;
}

// ---- storage ----

function available() {
  try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}

function stored() {
  return (settings.get(KEY) || {}).groupKey || null;
}

const has = () => Boolean(stored());

function store(keyBuf) {
  if (!available()) throw Object.assign(new Error('no keyring'), { code: 'no-keyring' });
  const cfg = settings.get(KEY) || {};
  settings.set(KEY, { ...cfg, groupKey: safeStorage.encryptString(keyBuf.toString('base64')).toString('base64') });
  cache = null;
  return true;
}

let cache = null;   // derived subkeys, so HKDF is not re-run per blob

function get() {
  const blob = stored();
  if (!blob) throw Object.assign(new Error('no group key on this device'), { code: 'no-key' });
  if (!available()) throw Object.assign(new Error('no keyring'), { code: 'no-keyring' });
  let b64;
  try {
    b64 = safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch (_) {
    // Same reasoning as the SSH secret: a keyring that changed under us must
    // say so, not hand back something that fails mysteriously further down.
    throw Object.assign(new Error('the stored group key could not be decrypted'), { code: 'key-lost' });
  }
  const keyBuf = Buffer.from(b64, 'base64');
  if (keyBuf.length !== tcrypto.KEY_LEN) {
    throw Object.assign(new Error('stored group key is malformed'), { code: 'malformed' });
  }
  return keyBuf;
}

// Subkeys, derived once. Callers do this per object otherwise, and HKDF per
// blob on a large project is real time spent for no reason.
function derived() {
  if (cache) return cache;
  cache = tcrypto.derive(get());
  return cache;
}

// First device in a new TabDesk. Returns the recovery string, which is the one
// moment it exists in a form a human can keep — the caller must show it.
function create() {
  if (has()) throw Object.assign(new Error('this device already belongs to a TabDesk'), { code: 'exists' });
  const keyBuf = tcrypto.newGroupKey();
  store(keyBuf);
  return { ok: true, recovery: toRecovery(keyBuf) };
}

// Joining an existing one, from a pairing invite or a recovery string.
function adopt(keyBuf) {
  if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== tcrypto.KEY_LEN) {
    throw Object.assign(new Error('not a group key'), { code: 'malformed' });
  }
  store(keyBuf);
  return { ok: true };
}

// Shown again from Settings while a device still has the key. Not a secret this
// module is trying to keep from its own user — the point of it is being written
// down somewhere safe.
function recovery() {
  return toRecovery(get());
}

// Leaving, or rekeying. The data on the server stays where it is; this only
// forgets how to read it, which is why the caller has to be sure.
function forget() {
  const cfg = settings.get(KEY) || {};
  const { groupKey, ...rest } = cfg;
  settings.set(KEY, rest);
  cache = null;
  return { ok: true };
}

// Fingerprint for the UI: enough to tell two devices they hold the same key
// without either showing it. Not used as a secret.
function fingerprint() {
  return crypto.createHash('sha256').update(get()).digest('hex').slice(0, 12);
}

module.exports = {
  create, adopt, get, derived, has, recovery, forget, fingerprint, available,
  toRecovery, fromRecovery,
};
