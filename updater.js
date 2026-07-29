// Update checking and installing, through apt.
//
// TabDesk ships from a signed apt repo on cdn.thern.io (see deploy/README.md).
// That repo is private — HTTP Basic auth — and apt already holds the password,
// root-only in /etc/apt/auth.conf.d/tabdesk.conf. So this app deliberately does
// NOT fetch from the CDN itself: doing that would mean keeping a second copy of
// the repo password somewhere the app can read, i.e. in the user's home,
// readable by anything running as them.
//
// Instead it reads what apt already knows and hands the install to apt:
//
//   * the published version comes out of apt's own package list, which is
//     world-readable and needs neither credentials nor root;
//   * the install is `apt-get install --only-upgrade`, run through pkexec.
//
// The integrity guarantee is therefore apt's signed Release chain, which is
// stronger than a checksum this process compares against an index it fetched
// over the same connection.

const { app } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');

const PACKAGE_NAME = 'tabdesk';

// Apt names its list files after the source URL with separators flattened.
const APT_LIST_DIR = '/var/lib/apt/lists';
const APT_LIST = `${APT_LIST_DIR}/cdn.thern.io_tabdesk_dists_stable_main_binary-amd64_Packages`;

// Re-check every six hours; a desktop app can sit open for days.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// ---- version handling ------------------------------------------------------

// Versions here are plain semver (electron-builder derives them from
// package.json), so a numeric three-part compare is enough. Anything unparsable
// sorts as 0 rather than throwing — a weird version must not break the check.
function parseVersion(v) {
  return String(v || '').split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewer(candidate, baseline) {
  const a = parseVersion(candidate);
  const b = parseVersion(baseline);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

// What is actually installed on this machine — which is what "update my local
// installation" means, and is not always what's running: a dev checkout started
// with `npm start` reports package.json's version, not the .deb's.
function installedVersion() {
  return new Promise((resolve) => {
    execFile('dpkg-query', ['-W', '-f=${Version}', PACKAGE_NAME], { timeout: 5000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

// ---- apt's package list ----------------------------------------------------

// Stanzas separated by a blank line; continuation lines start with a space.
function parsePackages(text) {
  const out = [];
  for (const stanza of String(text).split(/\n\s*\n/)) {
    const fields = {};
    for (const line of stanza.split('\n')) {
      const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
      if (m) fields[m[1].toLowerCase()] = m[2].trim();
    }
    if (fields.package) out.push(fields);
  }
  return out;
}

// The newest tabdesk apt knows about, plus when it last refreshed that list.
// Returns null when the repo isn't configured on this machine at all.
function published() {
  let text;
  try {
    text = fs.readFileSync(APT_LIST, 'utf8');
  } catch (_) {
    return null;
  }
  const entries = parsePackages(text).filter((e) => e.package === PACKAGE_NAME && e.version);
  if (!entries.length) return null;
  entries.sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1));

  // Deliberately the directory, not the list file: apt preserves the server's
  // Last-Modified on each list, so the file's mtime is when the CDN published
  // it, not when this machine last looked. The directory changes as apt writes
  // lists into it, which is the number that says how stale "up to date" is.
  let refreshed = null;
  try { refreshed = fs.statSync(APT_LIST_DIR).mtimeMs; } catch (_) { /* leave null */ }

  return {
    version: entries[0].version,
    size: parseInt(entries[0].size, 10) || 0,
    refreshed,
  };
}

// `apt-get update` needs root. Only ever called for an explicit "check again",
// never from the background timer — a password prompt every six hours would be
// its own kind of bug.
function aptRefresh() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('pkexec', ['apt-get', 'update'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) {
      return resolve({ ok: false, reason: 'no-pkexec' });
    }
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('error', () => resolve({ ok: false, reason: 'no-pkexec' }));
    child.on('close', (code) => resolve(
      code === 0 ? { ok: true } : { ok: false, reason: 'refresh-failed', code, output: out.slice(-2000) }));
  });
}

// What apt has, and whether it beats what's installed here.
async function check(options) {
  const opts = options || {};
  if (opts.refresh) await aptRefresh();   // best effort: a stale list still answers

  const running = app.getVersion();
  const installed = await installedVersion();
  // Compare against the installed .deb when there is one: that's what an update
  // would replace. Fall back to the running version when TabDesk isn't a
  // package on this machine at all.
  const baseline = installed || running;
  const latest = published();

  if (!latest) {
    return {
      running, installed, baseline, packaged: app.isPackaged,
      configured: false, available: false, latest: null,
      size: 0, checkedAt: null,
    };
  }

  return {
    running,
    installed,
    baseline,
    packaged: app.isPackaged,
    configured: true,
    latest: latest.version,
    available: isNewer(latest.version, baseline),
    size: latest.size,
    // When apt last refreshed its lists — the number that says how much to
    // trust "you're up to date".
    checkedAt: latest.refreshed ? new Date(latest.refreshed).toISOString() : null,
  };
}

// ---- install ---------------------------------------------------------------

// The command a user would run themselves — also the terminal fallback when
// pkexec isn't there or the polkit prompt is dismissed.
const installCommand = () => `sudo apt-get install --only-upgrade ${PACKAGE_NAME}`;

// pkexec raises a graphical password prompt and runs apt as root. Exit 126 is
// "not authorised / dismissed" and 127 is "pkexec itself failed" — both mean
// fall back to a terminal rather than report a broken update.
function install() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('pkexec', ['apt-get', 'install', '-y', '--only-upgrade', PACKAGE_NAME],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) {
      return resolve({ ok: false, reason: 'no-pkexec', command: installCommand() });
    }

    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('error', () => resolve({ ok: false, reason: 'no-pkexec', command: installCommand() }));
    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true, output: out.slice(-4000) });
      const reason = (code === 126 || code === 127) ? 'not-authorised' : 'apt-failed';
      resolve({ ok: false, reason, code, output: out.slice(-4000), command: installCommand() });
    });
  });
}

module.exports = {
  CHECK_INTERVAL_MS,
  check, install, installCommand, aptRefresh,
  // exported for tests
  parsePackages, isNewer, published,
};
