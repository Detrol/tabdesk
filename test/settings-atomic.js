const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-settings-atomic-'));
app.disableHardwareAcceleration();
app.setPath('userData', PROFILE);

let failed = false;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failed = true;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

app.on('ready', () => {
  const settings = require(path.join(ROOT, 'settings'));
  const { createSessionRegistry } = require(path.join(ROOT, 'session-ownership'));
  const TabOrder = require(path.join(ROOT, 'renderer/tab-order'));
  const initial = [
    { session: 'td-codex-one', cwd: '/one', name: 'One', marker: 'first' },
    { session: 'td-claude-two', cwd: '/two', name: 'Two', marker: 'second' },
  ];
  const sessions = createSessionRegistry({
    read: () => settings.get('openTabs'),
    write: (records) => settings.set('openTabs', records),
    upsert: TabOrder.upsertRecord,
  });
  check('seed settings file', sessions.replace(initial) === true);
  const target = path.join(PROFILE, 'settings.json');
  const priorBytes = fs.readFileSync(target);
  check('settings target uses private mode', (fs.statSync(target).mode & 0o777) === 0o600);
  const originalWriteFileSync = fs.writeFileSync;
  const originalWarn = console.warn;
  const warnings = [];

  let result;
  try {
    fs.writeFileSync = (destination) => {
      originalWriteFileSync(destination, Buffer.from('partial'));
      throw new Error('expected partial settings write failure');
    };
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    result = sessions.remember({
      session: 'td-codex-one', name: 'Changed', projectPath: '/verified',
    });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    console.warn = originalWarn;
  }

  check('registry reports failed durable commit', result === false);
  check('cache rolls back exactly', JSON.stringify(settings.get('openTabs')) === JSON.stringify(initial));
  const diskBytes = fs.readFileSync(target);
  check('target bytes remain exactly prior', diskBytes.equals(priorBytes), diskBytes.toString('utf8'));
  let parsed = null;
  try { parsed = JSON.parse(diskBytes.toString('utf8')); } catch (_) { /* reported below */ }
  check('target remains valid prior JSON', JSON.stringify(parsed?.openTabs) === JSON.stringify(initial));
  check('commit and rollback both failed through the injected writer', warnings.length === 2,
    warnings.join(' | '));
  const ownedTemps = fs.readdirSync(PROFILE).filter((name) => name.includes('.tabdesk-'));
  check('no owned temporary file remains', ownedTemps.length === 0, ownedTemps.join(', '));

  const originalOpenSync = fs.openSync;
  let collisionPath = null;
  let collisionResult;
  try {
    fs.openSync = (candidate) => {
      collisionPath = String(candidate);
      const collisionDescriptor = originalOpenSync(collisionPath, 'wx', 0o600);
      try {
        originalWriteFileSync(collisionDescriptor, Buffer.from('foreign-collision'));
      } finally {
        fs.closeSync(collisionDescriptor);
      }
      throw Object.assign(new Error('expected exclusive collision'), { code: 'EEXIST' });
    };
    console.warn = () => {};
    collisionResult = settings.set('theme', 'dark');
  } finally {
    fs.openSync = originalOpenSync;
    console.warn = originalWarn;
  }
  check('exclusive temp collision reports failure', collisionResult === false);
  check('exclusive temp collision is never deleted as owned',
    collisionPath && fs.readFileSync(collisionPath, 'utf8') === 'foreign-collision');
  check('exclusive collision leaves target bytes prior', fs.readFileSync(target).equals(priorBytes));
  try { if (collisionPath) fs.unlinkSync(collisionPath); } catch (_) { /* test cleanup */ }

  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  app.exit(failed ? 1 : 0);
});
