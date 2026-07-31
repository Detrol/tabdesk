// Sync configuration: the remote it talks to, and the secret it talks with.
//
// Everything non-secret lives in settings.json under `sync`. The password or
// key passphrase does not: it goes through Electron's safeStorage, which on
// Linux encrypts against the desktop keyring (libsecret — already a .deb
// dependency), and only the resulting base64 blob is written to disk. A
// settings.json that leaks is then a hostname and a username, not a login.
//
// The pinned host key is stored the same way an SSH client stores known_hosts,
// and for the same reason: the whole point of pinning is that a server which
// starts presenting a different key is refused rather than trusted afresh.

const { safeStorage } = require('electron');
const crypto = require('crypto');
const os = require('os');
const settings = require('../settings');

const KEY = 'sync';

// Neutral by design: no host, no path, nothing pointing anywhere in particular.
// This ships to other people, and a default remote would be both useless to
// them and a standing invitation to leak ours.
const DEFAULTS = {
  host: '',
  port: 22,
  user: '',
  remotePath: '',
  authMethod: 'key',        // 'key' | 'password'
  keyPath: '',              // absolute path to a private key, never its content
  secret: null,             // safeStorage blob: key passphrase or password
  hostKey: null,            // { algo, sha256 } once accepted
  deviceId: '',             // stable per install, minted on first use
  deviceName: '',           // what the other machine calls this one
  // Project file sync. `pushProjects` is a list of absolute project paths this
  // machine sends; everything else is only ever pulled on request.
  pushProjects: [],
  // Slugs this machine receives automatically. Kept separate from
  // pushProjects on purpose: the laptop pushes and the desktop pulls, and a
  // single "sync this" list would make a project both at once — which is the
  // two-way case, and that is phase six.
  pullProjects: [],
  extraIgnores: [],
  maxBytes: 0,              // 0 = the manifest module's default
  useGitignore: true,
};

function all() {
  return { ...DEFAULTS, ...(settings.get(KEY) || {}) };
}

// A random id rather than the hostname: two machines can share a hostname, and
// renaming one must not orphan the bundle it already pushed. The name is what
// humans read; the id is what the remote layout is keyed on.
function identity() {
  const c = all();
  if (c.deviceId && c.deviceName) return { deviceId: c.deviceId, deviceName: c.deviceName };
  const next = {
    ...c,
    deviceId: c.deviceId || crypto.randomUUID(),
    deviceName: c.deviceName || os.hostname() || 'tabdesk',
  };
  settings.set(KEY, next);
  return { deviceId: next.deviceId, deviceName: next.deviceName };
}

// What the renderer is allowed to see. The secret never crosses the bridge in
// either direction as plaintext-at-rest: it goes in on save and is only ever
// reported back as a boolean.
function forRenderer() {
  const c = all();
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    remotePath: c.remotePath,
    authMethod: c.authMethod,
    keyPath: c.keyPath,
    hasSecret: Boolean(c.secret),
    hostKey: c.hostKey,
    deviceId: c.deviceId,
    deviceName: c.deviceName,
    pushProjects: c.pushProjects || [],
    pullProjects: c.pullProjects || [],
    extraIgnores: c.extraIgnores || [],
    maxBytes: c.maxBytes || 0,
    useGitignore: c.useGitignore !== false,
    secretAvailable: isSecretAvailable(),
  };
}

// safeStorage needs a working keyring. Without one it silently degrades to a
// cipher anybody can reverse, so we refuse to use it rather than pretend.
function isSecretAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}

function encryptSecret(plain) {
  if (!plain) return null;
  if (!isSecretAvailable()) throw new Error('no-keyring');
  return safeStorage.encryptString(String(plain)).toString('base64');
}

function decryptSecret(blob) {
  if (!blob) return '';
  if (!isSecretAvailable()) throw Object.assign(new Error('no-keyring'), { code: 'no-keyring' });
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch (_) {
    // The keyring changed under us — a reinstall, a different desktop session,
    // a profile copied between machines. Returning '' here would hand ssh2 an
    // empty passphrase and surface as "Encrypted private OpenSSH key detected,
    // but no passphrase given", which sends the user looking at their key file
    // instead of at the one thing that is actually wrong.
    throw Object.assign(new Error('stored secret could not be decrypted'), { code: 'secret-lost' });
  }
}

// Save the parts the user edited. `secret` is three-state on purpose:
//   undefined -> leave whatever is stored alone (the field was not touched)
//   ''        -> clear it
//   'x'       -> replace it
// A form that always sent the field would otherwise wipe the stored secret
// every time somebody corrected a typo in the hostname.
function save(patch) {
  const current = all();
  const next = { ...current };

  for (const k of ['host', 'user', 'remotePath', 'keyPath', 'deviceName']) {
    if (patch[k] !== undefined) next[k] = String(patch[k]).trim();
  }
  if (Array.isArray(patch.pushProjects)) next.pushProjects = patch.pushProjects.map(String);
  if (Array.isArray(patch.pullProjects)) next.pullProjects = patch.pullProjects.map(String);
  if (Array.isArray(patch.extraIgnores)) {
    next.extraIgnores = patch.extraIgnores.map((s2) => String(s2).trim()).filter(Boolean);
  }
  if (patch.maxBytes !== undefined) {
    const n = Number.parseInt(patch.maxBytes, 10);
    next.maxBytes = Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (patch.useGitignore !== undefined) next.useGitignore = Boolean(patch.useGitignore);
  if (patch.port !== undefined) {
    const p = Number.parseInt(patch.port, 10);
    next.port = Number.isFinite(p) && p > 0 && p < 65536 ? p : 22;
  }
  if (patch.authMethod !== undefined) {
    next.authMethod = patch.authMethod === 'password' ? 'password' : 'key';
  }
  if (patch.secret !== undefined) {
    next.secret = patch.secret === '' ? null : encryptSecret(patch.secret);
  }

  // Changing which machine we talk to invalidates the key we pinned for the
  // old one. Keeping it would either refuse the new host forever or, worse,
  // let a stale pin stand in for one that was never actually checked.
  if (next.host !== current.host || next.port !== current.port) next.hostKey = null;

  settings.set(KEY, next);
  return forRenderer();
}

function pinHostKey(hostKey) {
  settings.set(KEY, { ...all(), hostKey: hostKey || null });
  return forRenderer();
}

// What the transport needs, secret decrypted, never handed to a renderer.
function forConnect() {
  const c = all();
  return { ...c, secret: decryptSecret(c.secret) };
}

// Enough to attempt a connection at all.
function missingFields() {
  const c = all();
  const missing = [];
  if (!c.host) missing.push('host');
  if (!c.user) missing.push('user');
  if (!c.remotePath) missing.push('remotePath');
  if (c.authMethod === 'key' && !c.keyPath) missing.push('keyPath');
  if (c.authMethod === 'password' && !c.secret) missing.push('secret');
  return missing;
}

// What manifest.build() needs, from what the user configured.
function fileOptions() {
  const c = all();
  return {
    ignores: c.extraIgnores || [],
    maxBytes: c.maxBytes || 0,
    useGitignore: c.useGitignore !== false,
  };
}

module.exports = {
  all, forRenderer, forConnect, save, pinHostKey, missingFields,
  isSecretAvailable, identity, fileOptions, DEFAULTS,
};
