// Whether a project directory may have code run out of it.
//
// The security review on 2026-07-30 established what Run and Preview actually
// do: read the project's own package.json and run `npm run dev`, or execute
// `bash <project>/run.sh`, `make run`, `cargo run` — and pythonBin() picks
// `<project>/.venv/bin/python`, a binary the project itself supplies. On a
// directory you wrote yourself that is an IDE's normal bargain.
//
// Sync changes who wrote it. Once files arrive from a server, "press Run" is
// "execute what the server sent". A compromised sync account, or a host key
// accepted without looking, becomes code execution on the machine that pulled
// — with no step in between that a person would recognise as a decision.
//
// So: a project that has ever received files over sync is untrusted until the
// user says otherwise, and receiving again revokes it. Trust is recorded
// against the path, and it is not a preference — nothing writes it except an
// explicit answer to the prompt.

const settings = require('../settings');

const KEY = 'syncTrust';

// { [projectPath]: { lastPull, trustedAt? } }
//
// Trust is the presence of `trustedAt`, not a comparison against `lastPull`.
// The first version compared the two timestamps, which is wrong twice over:
// ISO strings collide at millisecond resolution — a pull and a grant in the
// same tick read as still-trusted — and a clock that steps backwards would
// silently re-trust a delivery nobody looked at. Receiving new code simply
// removes the grant, so there is no ordering to get wrong.
function all() {
  return settings.get(KEY) || {};
}

function stateOf(projectPath) {
  const rec = all()[projectPath];
  if (!rec) return { received: false, trusted: true };        // never synced: normal project
  return {
    received: true,
    trusted: Boolean(rec.trustedAt),
    trustedAt: rec.trustedAt || null,
    lastPull: rec.lastPull || null,
  };
}

// Called after files land on disk. Receiving code from elsewhere revokes any
// standing trust: it was granted for what was there before, not for this.
function markReceived(projectPath) {
  const map = all();
  const prev = map[projectPath] || {};
  const { trustedAt, ...rest } = prev;
  map[projectPath] = { ...rest, lastPull: new Date().toISOString() };
  settings.set(KEY, map);
  return stateOf(projectPath);
}

function grant(projectPath) {
  const map = all();
  const prev = map[projectPath] || { lastPull: new Date().toISOString() };
  map[projectPath] = { ...prev, trustedAt: new Date().toISOString() };
  settings.set(KEY, map);
  return stateOf(projectPath);
}

function revoke(projectPath) {
  const map = all();
  if (!map[projectPath]) return stateOf(projectPath);
  const { trustedAt, ...rest } = map[projectPath];
  map[projectPath] = rest;
  settings.set(KEY, map);
  return stateOf(projectPath);
}

// The gate Run and Preview ask before spawning anything.
function mayRun(projectPath) {
  return stateOf(projectPath).trusted;
}

module.exports = { stateOf, markReceived, grant, revoke, mayRun, all };
