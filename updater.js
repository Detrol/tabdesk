// Update checking and installing, through git release tags.
//
// The fork ships as a git clone and a release is a `v*` tag on the fork's
// repository. An update exists only when a published tag is not yet part of
// this checkout's history — pushes between releases never raise the chip.
// Applying one is a fast-forward merge to the tag, plus `npm install` when the
// dependency files moved with it. No root, no package manager.

const { app } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// The clone this process runs from — updating anything else would be updating
// someone else's checkout.
const ROOT = __dirname;

// Re-check every six hours; a desktop app can sit open for days.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Resolves to stdout on success and null on any failure. Callers that need
// only the verdict (merge-base, merge) test for null; a lost network or a
// missing git answers "no update" rather than throwing.
function git(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('git', ['-C', ROOT, ...args], { timeout }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

// ---- version handling ------------------------------------------------------

// Tags are `v` + plain semver; a numeric three-part compare is enough.
// Anything unparsable sorts as 0 rather than throwing.
function parseVersion(v) {
  return String(v || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
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

// A worktree's .git is a file, a clone's is a directory; either means git can
// answer here. A packaged build (asar) has neither and cannot self-update.
function isRepo() {
  try { fs.statSync(path.join(ROOT, '.git')); return true; } catch (_) { return false; }
}

// ---- check -----------------------------------------------------------------

async function latestTag() {
  const tags = await git(['tag', '-l', 'v*', '--sort=-v:refname']);
  return tags ? tags.split('\n')[0].trim() : null;
}

async function check() {
  const running = app.getVersion();
  const base = {
    running, installed: null, baseline: running, packaged: app.isPackaged,
    configured: false, available: false, latest: null, size: 0, checkedAt: null,
  };
  if (!isRepo()) return base;

  await git(['fetch', '--quiet', '--tags', 'origin'], 20000);   // best effort: stale tags still answer
  const tag = await latestTag();
  if (!tag) return { ...base, configured: true, checkedAt: new Date().toISOString() };

  // History, not version numbers, decides availability: the dev checkout sits
  // past the tag with the same version and must read as up to date, and a
  // release only counts once its tag is actually fetchable here.
  const reached = (await git(['merge-base', '--is-ancestor', tag, 'HEAD'])) !== null;
  const dirty = Boolean(await git(['status', '--porcelain']));
  const log = reached ? '' : await git(['log', '--format=%h %s', '-10', `HEAD..${tag}`]);

  return {
    ...base,
    configured: true,
    latest: tag.replace(/^v/, ''),
    tag,
    available: !reached,
    dirty,
    commits: log ? log.split('\n') : [],
    checkedAt: new Date().toISOString(),
  };
}

// ---- install ---------------------------------------------------------------

// What a user would run themselves — also the terminal fallback when the
// fast-forward is blocked by local work.
const installCommand = () => `git -C ${ROOT} pull --ff-only && cd ${ROOT} && npm install`;

function npmInstall() {
  return new Promise((resolve) => {
    execFile('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}\n${stderr}`.trim().slice(-4000) }));
  });
}

async function install() {
  if (!isRepo()) return { ok: false, reason: 'local-changes', command: installCommand() };
  await git(['fetch', '--quiet', '--tags', 'origin'], 20000);
  const tag = await latestTag();
  if (!tag) return { ok: false, reason: 'local-changes', command: installCommand() };

  // Refuse rather than entangle: uncommitted files or commits of your own are
  // yours to reconcile in a terminal, not something to merge over silently.
  if (await git(['status', '--porcelain'])) {
    return { ok: false, reason: 'local-changes', command: installCommand() };
  }
  const before = await git(['rev-parse', 'HEAD']);
  const merged = await git(['merge', '--ff-only', tag], 60000);
  if (merged === null) return { ok: false, reason: 'local-changes', command: installCommand() };

  // node-pty is rebuilt by postinstall, so this can take minutes — but only
  // when the release actually moved the dependency files.
  const changed = (await git(['diff', '--name-only', before, 'HEAD'])) || '';
  if (/^package(-lock)?\.json$/m.test(changed)) {
    const npm = await npmInstall();
    if (!npm.ok) return { ok: false, reason: 'npm-failed', output: npm.output, command: installCommand() };
  }
  return { ok: true, version: tag.replace(/^v/, '') };
}

module.exports = {
  CHECK_INTERVAL_MS,
  check, install, installCommand,
  // exported for tests
  isNewer, parseVersion,
};
