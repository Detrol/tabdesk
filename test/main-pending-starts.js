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

// Keep the real child-process implementation, but record exact tmux teardown
// requests. The isolated TMUX_TMPDIR means even the forwarded calls cannot
// touch a user's server.
const realExecFile = childProcess.execFile;
const tmuxKills = [];
childProcess.execFile = function recordedExecFile(file, args, ...rest) {
  if (file === 'tmux' && Array.isArray(args) && args[0] === 'kill-session') {
    tmuxKills.push(String(args[2] || '').replace(/^=/, ''));
  }
  return Reflect.apply(realExecFile, childProcess, [file, args, ...rest]);
};

// An async ipcMain listener's rejected promise is otherwise invisible to the
// emitter. Retain it as test evidence so pre-fix start failures become an
// assertion failure instead of terminating the harness.
const unhandledRejections = [];
process.on('unhandledRejection', (error) => { unhandledRejections.push(error); });

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
let nextEmbedFailure = null;
let nextEmbedStartGate = null;
const fakeEmbed = {
  init() {},
  setTheme() {},
  setReadyNotifier() {},
  setActivityNotifier() {},
  async create(id, options) {
    embedAttempts.push({ id, options });
    if (embeds.has(id)) return;
    const record = { id, options, kills: 0 };
    embeds.set(id, record);
    embedStarts.push(record);
    if (nextEmbedFailure) {
      const error = nextEmbedFailure;
      nextEmbedFailure = null;
      throw error;
    }
    if (nextEmbedStartGate) {
      const gate = nextEmbedStartGate;
      nextEmbedStartGate = null;
      await gate.promise;
    }
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

const ptyAttempts = [];
const ptyStarts = [];
let nextPtyFailure = null;
const ptyPath = require.resolve('node-pty');
const ptyModule = require(ptyPath);
require.cache[ptyPath].exports = {
  ...ptyModule,
  spawn(file, args, options) {
    ptyAttempts.push({ file, args, options });
    if (nextPtyFailure) {
      const error = nextPtyFailure;
      nextPtyFailure = null;
      throw error;
    }
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

// Most cases need wrapStartCmd's persistent-session branch. The plain-PTY
// regressions toggle this at runtime while retaining a real durable
// reservation from tabs:allocate.
const agentsPath = require.resolve(path.join(ROOT, 'agents'));
const agentsModule = require(agentsPath);
let tmuxAvailable = true;
require.cache[agentsPath].exports = {
  ...agentsModule,
  onPath(bin) { return bin === 'tmux' ? tmuxAvailable : agentsModule.onPath(bin); },
};

// Observe real registry transitions without replacing the registry or its
// durable writer. Each entry records a successful present -> absent change.
const settingsPath = require.resolve(path.join(ROOT, 'settings'));
const settingsModule = require(settingsPath);
const setSetting = settingsModule.set;
const durableRemovals = [];
settingsModule.set = (key, value) => {
  const before = key === 'openTabs' && Array.isArray(settingsModule.get(key))
    ? settingsModule.get(key).map((row) => row.session)
    : [];
  const result = setSetting(key, value);
  if (key === 'openTabs' && result === true) {
    const after = new Set(Array.isArray(value) ? value.map((row) => row.session) : []);
    for (const session of before) {
      if (!after.has(session)) durableRemovals.push(session);
    }
  }
  return result;
};

require(path.join(ROOT, 'main'));

let holdRendererDeclines = false;
let sendToRenderer = null;
const heldRendererDeclines = [];

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
  const value = settingsModule.get('openTabs');
  return Array.isArray(value) ? value : [];
}

function hasRecord(session) {
  return records().some((row) => row.session === session);
}

function removalCount(session) {
  return durableRemovals.filter((removed) => removed === session).length;
}

function tmuxKillCount(session) {
  return tmuxKills.filter((killed) => killed === session).length;
}

async function reserveSession(sender, label) {
  const previous = delayOwnership;
  delayOwnership = false;
  try {
    const allocation = await sender.executeJavaScript(
      `window.api.allocateSession(${JSON.stringify(PROJECT_PATHS[0])}, "codex", ${JSON.stringify(label)}, false)`);
    if (!allocation?.session || !hasRecord(allocation.session)) {
      throw new Error(`failed to reserve ${label}`);
    }
    return allocation.session;
  } finally {
    delayOwnership = previous;
  }
}

async function declinedPayloads(sender) {
  return sender.executeJavaScript('[...window.__tabdeskPendingStartDeclines]');
}

async function declinedIds(sender) {
  return (await declinedPayloads(sender)).map(({ id }) => id);
}

async function waitForStartOutcome(sender, id, unhandledBefore) {
  return waitFor(async () => {
    const declined = await declinedIds(sender);
    return declined.includes(id) || unhandledRejections.length > unhandledBefore;
  }, `${id} start outcome`);
}

function holdDeclines() {
  holdRendererDeclines = true;
}

async function waitForHeldDecline(id) {
  return waitFor(() => heldRendererDeclines.find((entry) => entry.payload?.id === id),
    `${id} held decline`);
}

function deliverHeldDecline(entry) {
  const index = heldRendererDeclines.indexOf(entry);
  if (index >= 0) heldRendererDeclines.splice(index, 1);
  holdRendererDeclines = false;
  sendToRenderer(entry.channel, entry.payload);
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

function startLiveTmux(session) {
  childProcess.execFileSync('tmux', ['new-session', '-d', '-s', session], {
    env: process.env,
    stdio: 'ignore',
  });
}

function hasLiveTmux(session) {
  try {
    childProcess.execFileSync('tmux', ['has-session', '-t', '=' + session], {
      env: process.env,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function killTestTmuxServer() {
  try {
    childProcess.execFileSync('tmux', ['kill-server'], { env: process.env, stdio: 'ignore' });
  } catch (_) { /* no isolated server */ }
}

function backendSnapshot(backend) {
  return backend === 'term'
    ? { attempts: ptyAttempts.length, starts: ptyStarts.length }
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

async function closeReservedPending(sender, backend, boundary) {
  const id = `${backend}-reserved-${boundary}`;
  const session = await reserveSession(sender, `${backend} reserved ${boundary}`);
  const removalBefore = removalCount(session);
  const tmuxBefore = tmuxKillCount(session);
  const backendBefore = backendSnapshot(backend);
  const gate = await begin(sender, backend, id, session);

  if (boundary === 'post-owner') {
    gate.release();
    await gate.returned;
    kill(sender, backend, id);
    await settle();
  } else {
    kill(sender, backend, id);
    await release(gate);
  }
  // A repeated close is harmless: the reservation and any tmux session are
  // released by ownership of the exact pending generation, once.
  kill(sender, backend, id);
  await settle();

  const delta = backendDelta(backend, backendBefore);
  check(`${backend}:close releases a reserved ${boundary} start exactly once`,
    !hasRecord(session)
      && removalCount(session) - removalBefore === 1
      && tmuxKillCount(session) - tmuxBefore === 1
      && delta.attempts === 0 && delta.starts === 0,
    JSON.stringify({
      record: hasRecord(session),
      removals: removalCount(session) - removalBefore,
      tmuxKills: tmuxKillCount(session) - tmuxBefore,
      delta,
    }));

  // RED cleanup only; the fixed path has already made this a no-op.
  releaseSessions(sender, session);
}

async function preserveReservedPending(sender, backend, cancel, label) {
  const id = `${backend}-reserved-${label}`;
  const session = await reserveSession(sender, `${backend} reserved ${label}`);
  const removalBefore = removalCount(session);
  const tmuxBefore = tmuxKillCount(session);
  const backendBefore = backendSnapshot(backend);
  const gate = await begin(sender, backend, id, session);
  cancel(id);
  await release(gate);
  const delta = backendDelta(backend, backendBefore);

  check(`${backend}:${label} preserves its reserved session for restore`,
    hasRecord(session)
      && removalCount(session) === removalBefore
      && tmuxKillCount(session) === tmuxBefore
      && delta.attempts === 0 && delta.starts === 0,
    JSON.stringify({
      record: hasRecord(session),
      removals: removalCount(session) - removalBefore,
      tmuxKills: tmuxKillCount(session) - tmuxBefore,
      delta,
    }));
  releaseSessions(sender, session);
  await settle();
}

async function replaceReservedPending(sender, backend) {
  const id = `${backend}-reserved-replacement`;
  const oldSession = await reserveSession(sender, `${backend} replaced old`);
  const newSession = await reserveSession(sender, `${backend} replaced new`);
  const oldRemovalBefore = removalCount(oldSession);
  const newRemovalBefore = removalCount(newSession);
  const oldTmuxBefore = tmuxKillCount(oldSession);
  const newTmuxBefore = tmuxKillCount(newSession);
  const backendBefore = backendSnapshot(backend);

  const oldGate = await begin(sender, backend, id, oldSession);
  const newGate = await begin(sender, backend, id, newSession);
  await release(oldGate);
  await release(newGate);
  kill(sender, backend, id);
  kill(sender, backend, id);
  await settle();

  const delta = backendDelta(backend, backendBefore);
  check(`${backend}:same-id replacement releases only the old reservation`,
    !hasRecord(oldSession) && !hasRecord(newSession)
      && removalCount(oldSession) - oldRemovalBefore === 1
      && removalCount(newSession) - newRemovalBefore === 1
      && tmuxKillCount(oldSession) - oldTmuxBefore === 1
      && tmuxKillCount(newSession) - newTmuxBefore === 1
      && delta.attempts === 1 && delta.starts === 1,
    JSON.stringify({
      records: records().filter((row) => row.session === oldSession || row.session === newSession),
      oldRemovals: removalCount(oldSession) - oldRemovalBefore,
      newRemovals: removalCount(newSession) - newRemovalBefore,
      oldTmuxKills: tmuxKillCount(oldSession) - oldTmuxBefore,
      newTmuxKills: tmuxKillCount(newSession) - newTmuxBefore,
      delta,
    }));
  releaseSessions(sender, oldSession, newSession);
}

async function chainEmbedReplacementDuringStart(sender) {
  const id = 'embed-chained-resource-replacement';
  const oldSession = await reserveSession(sender, 'embed chained old');
  const middleSession = await reserveSession(sender, 'embed chained middle');
  const newSession = await reserveSession(sender, 'embed chained new');
  const sessions = [oldSession, middleSession, newSession];
  const removalBefore = new Map(sessions.map((session) => [session, removalCount(session)]));
  const tmuxBefore = new Map(sessions.map((session) => [session, tmuxKillCount(session)]));
  const backendBefore = backendSnapshot('embed');
  const ownerBefore = ownershipGates.length;
  const startGate = deferred();
  nextEmbedStartGate = startGate;

  const oldOwner = await begin(sender, 'embed', id, oldSession);
  oldOwner.release();
  await oldOwner.returned;
  await waitFor(() => embedAttempts.length === backendBefore.attempts + 1,
    'first chained embed resource start');
  await settle();

  ipcMain.emit('embed:create', eventFor(sender), payloadFor('embed', id, middleSession));
  ipcMain.emit('embed:create', eventFor(sender), payloadFor('embed', id, newSession));
  await settle();

  // A third generation must inherit the first generation's unresolved start
  // through the middle token. Otherwise it reaches ownership and can register
  // a new embed under the same id while the first create is still unwinding.
  const prematureOwner = ownershipGates[ownerBefore + 1] || null;
  if (prematureOwner) {
    prematureOwner.release();
    await prematureOwner.returned;
    await settle();
  }
  const serialized = !prematureOwner
    && embedAttempts.length === backendBefore.attempts + 1;

  startGate.resolve();
  let newOwner = prematureOwner;
  if (!newOwner) {
    newOwner = await waitFor(() => ownershipGates[ownerBefore + 1],
      'final chained embed ownership');
    await release(newOwner);
  } else {
    await settle();
  }
  kill(sender, 'embed', id);
  kill(sender, 'embed', id);
  await settle();

  const delta = backendDelta('embed', backendBefore);
  const started = embedStarts.slice(backendBefore.starts);
  check('embed:chained same-id replacements serialize the predecessor resource start',
    serialized
      && sessions.every((session) => !hasRecord(session))
      && sessions.every((session) => removalCount(session) - removalBefore.get(session) === 1)
      && sessions.every((session) => tmuxKillCount(session) - tmuxBefore.get(session) === 1)
      && delta.attempts === 2 && delta.starts === 2
      && started.length === 2 && started.every((record) => record.kills === 1),
    JSON.stringify({
      serialized,
      records: records().filter((row) => sessions.includes(row.session)),
      removals: sessions.map((session) => removalCount(session) - removalBefore.get(session)),
      tmuxKills: sessions.map((session) => tmuxKillCount(session) - tmuxBefore.get(session)),
      delta,
      embedKills: started.map((record) => record.kills),
    }));
  releaseSessions(sender, ...sessions);
}

function failNextResourceStart(backend, label) {
  const error = new Error(`${backend} injected ${label}`);
  if (backend === 'term') nextPtyFailure = error;
  else nextEmbedFailure = error;
}

function failedResourceClean(backend, id, before) {
  const delta = backendDelta(backend, before);
  if (backend === 'term') return delta.attempts === 1 && delta.starts === 0;
  const failed = embedStarts.slice(before.starts);
  return delta.attempts === 1 && delta.starts === 1
    && !embeds.has(id) && failed.length === 1 && failed[0].kills === 1;
}

async function failedReservedStart(sender, backend, closeBeforeDecline) {
  const boundary = closeBeforeDecline ? 'before' : 'after';
  const id = `${backend}-failed-${boundary}-decline`;
  const session = await reserveSession(sender, `${backend} failed ${boundary} decline`);
  const removalBefore = removalCount(session);
  const tmuxBefore = tmuxKillCount(session);
  const backendBefore = backendSnapshot(backend);
  const unhandledBefore = unhandledRejections.length;
  failNextResourceStart(backend, `failure ${boundary} decline`);
  holdDeclines();

  const gate = await begin(sender, backend, id, session);
  await release(gate);
  const held = await waitForHeldDecline(id);
  await settle();
  const competingSession = closeBeforeDecline
    ? null
    : await reserveSession(sender, 'after failed start');
  if (closeBeforeDecline) kill(sender, backend, id);
  deliverHeldDecline(held);
  await waitForStartOutcome(sender, id, unhandledBefore);
  if (!closeBeforeDecline) releaseSessions(sender, session);
  await settle();

  const payloads = await declinedPayloads(sender);
  check(`${backend}:${closeBeforeDecline ? 'backend close before' : 'renderer release after'} decline consumes failed ownership once`,
    (!competingSession || competingSession !== session)
      && (closeBeforeDecline
        || payloads.some((payload) => payload.id === id && payload.session === session))
      && !hasRecord(session)
      && removalCount(session) - removalBefore === 1
      && tmuxKillCount(session) - tmuxBefore === 1
      && unhandledRejections.length === unhandledBefore
      && failedResourceClean(backend, id, backendBefore),
    JSON.stringify({
      record: hasRecord(session),
      allocation: competingSession,
      removals: removalCount(session) - removalBefore,
      tmuxKills: tmuxKillCount(session) - tmuxBefore,
      delta: backendDelta(backend, backendBefore),
    }));

  kill(sender, backend, id);
  if (competingSession) releaseSessions(sender, competingSession);
  await settle();
}

async function failedStartsWithLiveTmux(sender) {
  const cases = [];
  for (const backend of ['term', 'embed']) {
    const id = `${backend}-failed-live-tmux`;
    const session = await reserveSession(sender, `${backend} failed live tmux`);
    cases.push({
      backend, id, session,
      removalBefore: removalCount(session),
      tmuxBefore: tmuxKillCount(session),
      backendBefore: backendSnapshot(backend),
    });
  }
  for (const item of cases) startLiveTmux(item.session);
  holdDeclines();
  failNextResourceStart('term', 'live tmux failure');
  failNextResourceStart('embed', 'live tmux failure');
  const gates = [];
  for (const item of cases) {
    gates.push(await begin(sender, item.backend, item.id, item.session));
  }
  for (const gate of gates) await release(gate);
  const declines = [];
  for (const item of cases) declines.push(await waitForHeldDecline(item.id));
  for (const item of cases) kill(sender, item.backend, item.id);
  await Promise.all(cases.map((item) => waitFor(
    () => !hasLiveTmux(item.session), `${item.backend} existing tmux teardown`).catch(() => false)));
  for (const decline of declines) deliverHeldDecline(decline);
  await settle();

  for (const item of cases) {
    check(`${item.backend}:failed close tears down an existing tmux session once`,
      !hasRecord(item.session)
        && removalCount(item.session) - item.removalBefore === 1
        && tmuxKillCount(item.session) - item.tmuxBefore === 1
        && !hasLiveTmux(item.session)
        && failedResourceClean(item.backend, item.id, item.backendBefore),
      JSON.stringify({
        record: hasRecord(item.session),
        removals: removalCount(item.session) - item.removalBefore,
        tmuxKills: tmuxKillCount(item.session) - item.tmuxBefore,
        live: hasLiveTmux(item.session),
        delta: backendDelta(item.backend, item.backendBefore),
      }));
  }
}

async function retryFailedStart(sender, backend) {
  const id = `${backend}-failed-retry`;
  const session = await reserveSession(sender, `${backend} failed retry`);
  const removalBefore = removalCount(session);
  const tmuxBefore = tmuxKillCount(session);
  const backendBefore = backendSnapshot(backend);
  const unhandledBefore = unhandledRejections.length;
  failNextResourceStart(backend, 'failure before retry');

  const failedGate = await begin(sender, backend, id, session);
  await release(failedGate);
  await waitForStartOutcome(sender, id, unhandledBefore);
  const retainedBeforeRetry = hasRecord(session)
    && removalCount(session) === removalBefore
    && tmuxKillCount(session) === tmuxBefore;

  const retryGate = await begin(sender, backend, id, session);
  await release(retryGate);
  await settle();
  const retainedThroughRetry = hasRecord(session)
    && removalCount(session) === removalBefore
    && tmuxKillCount(session) === tmuxBefore;
  kill(sender, backend, id);
  await settle();

  const delta = backendDelta(backend, backendBefore);
  check(`${backend}:retry takes failed ownership without releasing its session`,
    retainedBeforeRetry && retainedThroughRetry
      && !hasRecord(session)
      && removalCount(session) - removalBefore === 1
      && tmuxKillCount(session) - tmuxBefore === 1
      && delta.attempts === 2 && delta.starts === (backend === 'term' ? 1 : 2),
    JSON.stringify({
      retainedBeforeRetry,
      retainedThroughRetry,
      record: hasRecord(session),
      removals: removalCount(session) - removalBefore,
      tmuxKills: tmuxKillCount(session) - tmuxBefore,
      delta,
    }));
  releaseSessions(sender, session);
}

async function generatedSessionDecline(sender, backend) {
  const id = `${backend}-generated-decline`;
  const backendBefore = backendSnapshot(backend);
  const unhandledBefore = unhandledRejections.length;
  failNextResourceStart(backend, 'generated session failure');
  holdDeclines();
  const gate = await begin(sender, backend, id, null);
  await release(gate);
  const held = await waitForHeldDecline(id);
  const session = held.payload?.session;
  const valid = typeof session === 'string' && /^td-[A-Za-z0-9_-]+$/.test(session);
  const retained = valid && hasRecord(session);
  deliverHeldDecline(held);
  await waitForStartOutcome(sender, id, unhandledBefore);
  if (valid) releaseSessions(sender, session);
  await settle();

  check(`${backend}:decline returns its main-generated durable session`,
    valid && retained && !hasRecord(session)
      && failedResourceClean(backend, id, backendBefore),
    JSON.stringify({ payload: held.payload, retained, record: valid && hasRecord(session) }));
  kill(sender, backend, id);
}

async function closePlainPending(sender) {
  const id = 'term-plain-pending';
  const session = await reserveSession(sender, 'plain pending');
  const removalBefore = removalCount(session);
  const tmuxBefore = tmuxKillCount(session);
  const backendBefore = backendSnapshot('term');
  tmuxAvailable = false;
  const gate = await begin(sender, 'term', id, session);
  kill(sender, 'term', id);
  await release(gate);
  await settle();
  tmuxAvailable = true;

  check('term:pending plain PTY close releases only its durable reservation',
    !hasRecord(session)
      && removalCount(session) - removalBefore === 1
      && tmuxKillCount(session) === tmuxBefore
      && backendDelta('term', backendBefore).attempts === 0,
    JSON.stringify({
      record: hasRecord(session),
      removals: removalCount(session) - removalBefore,
      tmuxKills: tmuxKillCount(session) - tmuxBefore,
      delta: backendDelta('term', backendBefore),
    }));
  releaseSessions(sender, session);
}

async function closePlainStarted(sender, naturalExit) {
  const label = naturalExit ? 'exit' : 'close';
  const id = `term-plain-${label}`;
  const session = await reserveSession(sender, `plain ${label}`);
  const removalBefore = removalCount(session);
  const tmuxBefore = tmuxKillCount(session);
  const backendBefore = backendSnapshot('term');
  tmuxAvailable = false;
  const gate = await begin(sender, 'term', id, session);
  await release(gate);
  const started = ptyStarts.at(-1);
  const scrollback = await sender.executeJavaScript(
    `window.api.scrollback({ id: ${JSON.stringify(id)} })`);
  if (naturalExit) started.exit();
  else kill(sender, 'term', id);
  await settle();
  tmuxAvailable = true;

  check(`term:successful plain PTY ${label} releases reservation without tmux ownership`,
    !hasRecord(session)
      && removalCount(session) - removalBefore === 1
      && tmuxKillCount(session) === tmuxBefore
      && scrollback?.ok === false && scrollback?.reason === 'no-session'
      && backendDelta('term', backendBefore).starts === 1
      && (naturalExit || started.kills === 1),
    JSON.stringify({
      record: hasRecord(session),
      removals: removalCount(session) - removalBefore,
      tmuxKills: tmuxKillCount(session) - tmuxBefore,
      scrollback,
      kills: started.kills,
      delta: backendDelta('term', backendBefore),
    }));
  releaseSessions(sender, session);
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
  await win.webContents.executeJavaScript(`
    window.__tabdeskPendingStartDeclines = [];
    window.api.onTerminalDeclined((payload) => window.__tabdeskPendingStartDeclines.push(payload));
    true;
  `);
  sendToRenderer = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, payload) => {
    if (channel === 'term:declined' && holdRendererDeclines) {
      heldRendererDeclines.push({ channel, payload });
      return;
    }
    sendToRenderer(channel, payload);
  };

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
    await closeReservedPending(sender, backend, 'pre-owner');
    await closeReservedPending(sender, backend, 'post-owner');
    await replaceReservedPending(sender, backend);
    await failedReservedStart(sender, backend, true);
    await failedReservedStart(sender, backend, false);
    await retryFailedStart(sender, backend);
    await generatedSessionDecline(sender, backend);
    await canceledStart(sender, backend, (id) => kill(sender, backend, id), 'kill');
    await reusedId(sender, backend, (id) => kill(sender, backend, id), 'kill');
  }
  await closePlainPending(sender);
  await closePlainStarted(sender, false);
  await closePlainStarted(sender, true);
  await chainEmbedReplacementDuringStart(sender);

  const navigate = () => sender.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
  });
  for (const backend of ['term', 'embed']) {
    await preserveReservedPending(sender, backend, navigate, 'main-frame-navigation');
    await canceledStart(sender, backend, navigate, 'main-frame-navigation');
    await reusedId(sender, backend, navigate, 'main-frame-navigation');
  }

  const termBefore = backendSnapshot('term');
  const embedBefore = backendSnapshot('embed');
  const termSession = await reserveSession(sender, 'term destroyed');
  const embedSession = await reserveSession(sender, 'embed destroyed');
  const termRemovalBefore = removalCount(termSession);
  const embedRemovalBefore = removalCount(embedSession);
  const termTmuxBefore = tmuxKillCount(termSession);
  const embedTmuxBefore = tmuxKillCount(embedSession);
  const termGate = await begin(sender, 'term', 'term-destroyed', termSession);
  const embedGate = await begin(sender, 'embed', 'embed-destroyed', embedSession);
  sender.emit('destroyed');
  await release(termGate);
  await release(embedGate);
  const termDelta = backendDelta('term', termBefore);
  const embedDelta = backendDelta('embed', embedBefore);
  check('renderer destruction cancels pending resources but preserves reservations',
    termDelta.attempts === 0 && embedDelta.attempts === 0
      && hasRecord(termSession) && hasRecord(embedSession)
      && removalCount(termSession) === termRemovalBefore
      && removalCount(embedSession) === embedRemovalBefore
      && tmuxKillCount(termSession) === termTmuxBefore
      && tmuxKillCount(embedSession) === embedTmuxBefore,
    JSON.stringify({
      termDelta,
      embedDelta,
      records: records().map((row) => row.session),
      termRemovals: removalCount(termSession) - termRemovalBefore,
      embedRemovals: removalCount(embedSession) - embedRemovalBefore,
      termTmuxKills: tmuxKillCount(termSession) - termTmuxBefore,
      embedTmuxKills: tmuxKillCount(embedSession) - embedTmuxBefore,
    }));
  kill(sender, 'term', 'term-destroyed');
  kill(sender, 'embed', 'embed-destroyed');
  releaseSessions(sender, termSession, embedSession);

  await failedStartsWithLiveTmux(sender);

  check('navigation cleanup kills embeds at most once per started resource',
    embedStarts.every((record) => record.kills <= 1),
    JSON.stringify({ embedKillAllCalls, kills: embedStarts.map((record) => record.kills) }));

  console.log(`main pending/list regressions: ${passed}/${passed + failed} passing`);
  killTestTmuxServer();
  projectFiles.close();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(failed ? 1 : 0);
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  killTestTmuxServer();
  try { projectFiles?.close(); } catch (_) {}
  try { for (const window of BrowserWindow.getAllWindows()) window.destroy(); } catch (_) {}
  app.exit(1);
});
