const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-root-transition-'));
const FIRST = path.join(PROFILE, 'first');
const SECOND = path.join(PROFILE, 'second');
fs.mkdirSync(FIRST);
fs.mkdirSync(SECOND);
app.disableHardwareAcceleration();
app.setPath('userData', path.join(PROFILE, 'profile'));

let failures = 0;
function ok(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

app.whenReady().then(() => {
  const settings = require('../settings');
  const projectsRoot = require('../projects-root');
  console.log('== projects root transaction ==');

  projectsRoot.setRoot(FIRST);
  const originalWrite = fs.writeFileSync;
  const originalWarn = console.warn;
  const warnings = [];
  let persistError = null;
  try {
    fs.writeFileSync = () => { throw new Error('expected projects root persistence failure'); };
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    projectsRoot.setRoot(SECOND);
  } catch (error) {
    persistError = error;
  } finally {
    fs.writeFileSync = originalWrite;
    console.warn = originalWarn;
  }
  ok('setRoot reports a typed persistence failure',
    persistError && persistError.code === 'persist-failed', persistError && persistError.code);
  ok('failed persistence retains the prior resolved root', projectsRoot.resolve() === FIRST,
    projectsRoot.resolve());
  ok('failed persistence restores the prior settings cache', settings.get('projectsDir') === FIRST,
    settings.get('projectsDir'));
  ok('persistence and cache-restore failures remain observable', warnings.length === 2,
    String(warnings.length));

  const transaction = typeof projectsRoot.prepareRoot === 'function'
    ? projectsRoot.prepareRoot(SECOND)
    : null;
  ok('a root transition can be prepared without changing live state',
    transaction && projectsRoot.resolve() === FIRST);
  if (transaction) {
    transaction.commit();
    ok('commit publishes the prepared root', projectsRoot.resolve() === SECOND);
    transaction.rollback();
    ok('rollback restores the exact prior root and setting',
      projectsRoot.resolve() === FIRST && settings.get('projectsDir') === FIRST);
  }

  const stale = projectsRoot.prepareRoot(SECOND);
  fs.rmSync(SECOND, { recursive: true });
  let staleError = null;
  try { stale.commit(); } catch (error) { staleError = error; }
  ok('commit revalidates a prepared directory that disappeared',
    staleError && staleError.code === 'invalid-root' && projectsRoot.resolve() === FIRST,
    staleError && staleError.code);

  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* gone */ }
  app.exit(failures ? 1 : 0);
});
