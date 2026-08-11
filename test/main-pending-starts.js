// Main-process regressions for terminal starts that cross an asynchronous
// ownership check, and for the projects:list fan-out into project-files' Git
// runner. This is a separate Electron instance; it never touches the guarded
// TabDesk window or its profile/tmux socket.

const { app, BrowserWindow, ipcMain } = require('electron');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRATCH = process.env.TABDESK_PENDING_STARTS_SCRATCH;
if (!SCRATCH || !path.isAbsolute(SCRATCH)) {
  throw new Error('launch main-pending-starts.js through main-pending-starts-runner.js');
}
const PROFILE = path.join(SCRATCH, 'profile');
const PROJECTS = path.join(SCRATCH, 'projects');
const TMUX = path.join(SCRATCH, 'tmux');
const SOURCE = path.join(SCRATCH, 'source');
fs.mkdirSync(PROFILE);
fs.mkdirSync(PROJECTS);
fs.mkdirSync(TMUX);
fs.mkdirSync(SOURCE);

app.disableHardwareAcceleration();
app.setPath('userData', PROFILE);
app.commandLine.appendSwitch('remote-debugging-port', '0');
process.env.TABDESK_PROJECTS_DIR = PROJECTS;
process.env.TMUX_TMPDIR = TMUX;

function git(cwd, args) {
  childProcess.execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

// Twenty-one configured rows plus the projects root exceed the Git runner's
// four active and sixteen queued slots. Symlinks preserve the real worktree
// relationship while avoiding twenty-one copies of the same repository.
git(SOURCE, ['init', '--initial-branch=main']);
git(SOURCE, ['config', 'user.email', 'test@example.invalid']);
git(SOURCE, ['config', 'user.name', 'TabDesk test']);
fs.writeFileSync(path.join(SOURCE, '.gitignore'), '.worktrees/\n');
git(SOURCE, ['add', '.gitignore']);
git(SOURCE, ['commit', '-m', 'initial']);
const REAL_WORKTREE = path.join(SOURCE, '.worktrees', 'topic');
fs.mkdirSync(path.dirname(REAL_WORKTREE));
git(SOURCE, ['worktree', 'add', '-b', 'topic', REAL_WORKTREE]);
const PROJECT_PATHS = [];
for (let index = 1; index <= 21; index++) {
  const project = path.join(PROJECTS, `project-${String(index).padStart(2, '0')}`);
  fs.symlinkSync(SOURCE, project, 'dir');
  PROJECT_PATHS.push(project);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, label, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

// Keep project-files real. Only the owner result is held so the tested main
// handler genuinely crosses the same await as production.
const projectFilesPath = require.resolve(path.join(ROOT, 'project-files'));
const projectFilesModule = require(projectFilesPath);
let projectFiles;
let delayOwnership = false;
const ownershipGates = [];
require.cache[projectFilesPath].exports = {
  ...projectFilesModule,
  createProjectFiles(options) {
    projectFiles = projectFilesModule.createProjectFiles(options);
    const resolveOwner = projectFiles.resolveOwner;
    projectFiles.resolveOwner = async (cwd) => {
      if (!delayOwnership) return resolveOwner(cwd);
      const release = deferred();
      const returned = deferred();
      const gate = { cwd, release: release.resolve, returned: returned.promise };
      ownershipGates.push(gate);
      await release.promise;
      try {
        return await resolveOwner(cwd);
      } finally {
        returned.resolve();
      }
    };
    return projectFiles;
  },
};

// The lifecycle is the subject; native xterm/node-pty processes are external
// resources. These fakes preserve duplicate-id and exact-kill behavior while
// exposing whether main started or orphaned one.
const embeds = new Map();
const embedAttempts = [];
const embedStarts = [];
let embedKillAllCalls = 0;
const fakeEmbed = {
  init() {},
  setTheme() {},
  setReadyNotifier() {},
  setActivityNotifier() {},
  create(id, options) {
    embedAttempts.push({ id, options });
    if (embeds.has(id)) return;
    const record = { id, options, kills: 0 };
    embeds.set(id, record);
    embedStarts.push(record);
  },
  place() {},
  hide() {},
  focus() {},
  insert() { return false; },
  kill(id) {
    const record = embeds.get(id);
    if (!record) return;
    embeds.delete(id);
    record.kills += 1;
  },
  killAll() {
    embedKillAllCalls += 1;
    for (const id of [...embeds.keys()]) fakeEmbed.kill(id);
  },
};
const termEmbedPath = require.resolve(path.join(ROOT, 'term-embed'));
require(termEmbedPath);
require.cache[termEmbedPath].exports = fakeEmbed;

const ptyStarts = [];
const ptyPath = require.resolve('node-pty');
const ptyModule = require(ptyPath);
require.cache[ptyPath].exports = {
  ...ptyModule,
  spawn(file, args, options) {
    const record = {
      file, args, options, kills: 0, writes: [], exit: null,
      write(data) { record.writes.push(data); },
      resize() {},
      kill() { record.kills += 1; },
      onData() {},
      onExit(callback) { record.exit = callback; },
    };
    ptyStarts.push(record);
    return record;
  },
};

// wrapStartCmd must take the persistent-session branch even on a host where
// tmux is absent from the GUI PATH. No tmux client is actually launched.
const agentsPath = require.resolve(path.join(ROOT, 'agents'));
const agentsModule = require(agentsPath);
require.cache[agentsPath].exports = {
  ...agentsModule,
  onPath(bin) { return bin === 'tmux' || agentsModule.onPath(bin); },
};

require(path.join(ROOT, 'main'));

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function records() {
  const settings = require(path.join(ROOT, 'settings'));
  const value = settings.get('openTabs');
  return Array.isArray(value) ? value : [];
}

const eventFor = (sender) => ({ sender });
const payloadFor = (backend, id, session) => ({
  id,
  ...(backend === 'term' ? { cols: 80, rows: 24 } : {}),
  cwd: PROJECT_PATHS[0],
  startCmd: 'exec true',
  agent: 'codex',
  session,
  name: session,
});

async function begin(sender, backend, id, session) {
  const before = ownershipGates.length;
  ipcMain.emit(`${backend}:create`, eventFor(sender), payloadFor(backend, id, session));
  return waitFor(() => ownershipGates.length > before && ownershipGates[before],
    `${backend}:create owner verification`);
}

async function release(gate) {
  gate.release();
  await gate.returned;
  await settle();
}

function kill(sender, backend, id) {
  ipcMain.emit(`${backend}:kill`, eventFor(sender), { id });
}

function releaseSessions(sender, ...sessions) {
  for (const session of sessions) {
    ipcMain.emit('tabs:release', eventFor(sender), { session });
  }
}

function backendSnapshot(backend) {
  return backend === 'term'
    ? { attempts: ptyStarts.length, starts: ptyStarts.length }
    : { attempts: embedAttempts.length, starts: embedStarts.length };
}

function backendDelta(backend, before) {
  const now = backendSnapshot(backend);
  return { attempts: now.attempts - before.attempts, starts: now.starts - before.starts };
}

async function canceledStart(sender, backend, cancel, label) {
  const id = `${backend}-${label}`;
  const session = `td-codex-${backend}-${label}`;
  const before = backendSnapshot(backend);
  const gate = await begin(sender, backend, id, session);
  cancel(id);
  await release(gate);
  const delta = backendDelta(backend, before);
  check(`${backend}:create cannot survive ${label}`,
    delta.attempts === 0 && delta.starts === 0 && !records().some((row) => row.session === session),
    JSON.stringify({ delta, records: records().map((row) => row.session) }));
  kill(sender, backend, id);
  releaseSessions(sender, session);
}

async function reusedId(sender, backend, cancel, label) {
  const id = `${backend}-${label}-reuse`;
  const oldSession = `td-codex-${backend}-${label}-old`;
  const newSession = `td-codex-${backend}-${label}-new`;
  const before = backendSnapshot(backend);
  const oldGate = await begin(sender, backend, id, oldSession);
  // The owner has returned, but rememberCurrent/main have not resumed yet.
  // Cancellation in this exact microtask boundary must still make both the
  // registry write and the backend registration stale.
  oldGate.release();
  await oldGate.returned;
  cancel(id);
  const newGate = await begin(sender, backend, id, newSession);
  await release(newGate);
  await settle();
  kill(sender, backend, id);
  const delta = backendDelta(backend, before);
  const left = records().filter((row) => row.session === oldSession || row.session === newSession);
  check(`${backend}:create stale ${label} generation cannot overwrite reused id`,
    delta.attempts === 1 && delta.starts === 1 && left.length === 0,
    JSON.stringify({ delta, records: left.map((row) => row.session) }));
  releaseSessions(sender, oldSession, newSession);
}

async function run() {
  await app.whenReady();
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'main test window');
  await waitFor(() => ipcMain.listenerCount('term:create') && ipcMain.listenerCount('embed:create'),
    'terminal IPC handlers');
  await waitFor(async () => {
    try { return await win.webContents.executeJavaScript('typeof window.api?.listProjects === "function"'); }
    catch (_) { return false; }
  }, 'renderer preload API');

  console.log('== projects:list Git scheduling ==');
  const listings = await win.webContents.executeJavaScript(
    'Promise.all([window.api.listProjects(), window.api.listProjects()])');
  for (const [index, rows] of listings.entries()) {
    const projects = rows.filter((row) => !row.root);
    const complete = rows.length === 22 && projects.length === 21
      && projects.every((row) => row.worktrees.length === 1
        && row.worktrees[0].path === `${row.path}/.worktrees/topic`);
    check(`concurrent projects:list #${index + 1} returns every verified worktree`, complete,
      JSON.stringify(projects.map((row) => row.worktrees.length)));
  }

  delayOwnership = true;
  const sender = win.webContents;
  console.log('== pending terminal starts ==');
  for (const backend of ['term', 'embed']) {
    await canceledStart(sender, backend, (id) => kill(sender, backend, id), 'kill');
    await reusedId(sender, backend, (id) => kill(sender, backend, id), 'kill');
  }

  const navigate = () => sender.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
  });
  for (const backend of ['term', 'embed']) {
    await canceledStart(sender, backend, navigate, 'main-frame-navigation');
    await reusedId(sender, backend, navigate, 'main-frame-navigation');
  }

  const termBefore = backendSnapshot('term');
  const embedBefore = backendSnapshot('embed');
  const termSession = 'td-codex-term-destroyed';
  const embedSession = 'td-codex-embed-destroyed';
  const termGate = await begin(sender, 'term', 'term-destroyed', termSession);
  const embedGate = await begin(sender, 'embed', 'embed-destroyed', embedSession);
  sender.emit('destroyed');
  await release(termGate);
  await release(embedGate);
  const termDelta = backendDelta('term', termBefore);
  const embedDelta = backendDelta('embed', embedBefore);
  check('renderer destruction cancels every backend pending for that sender',
    termDelta.attempts === 0 && embedDelta.attempts === 0
      && !records().some((row) => row.session === termSession || row.session === embedSession),
    JSON.stringify({ termDelta, embedDelta, records: records().map((row) => row.session) }));
  kill(sender, 'term', 'term-destroyed');
  kill(sender, 'embed', 'embed-destroyed');
  releaseSessions(sender, termSession, embedSession);

  check('navigation cleanup kills embeds at most once per started resource',
    embedStarts.every((record) => record.kills <= 1),
    JSON.stringify({ embedKillAllCalls, kills: embedStarts.map((record) => record.kills) }));

  console.log(`main pending/list regressions: ${passed}/${passed + failed} passing`);
  projectFiles.close();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(failed ? 1 : 0);
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  try { projectFiles?.close(); } catch (_) {}
  try { for (const window of BrowserWindow.getAllWindows()) window.destroy(); } catch (_) {}
  app.exit(1);
});
