import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = require('electron');
const STEP_TIMEOUT = 10_000;
const WORKTREE_FILE = 'src/worktree-only.js';
const WORKTREE_CONTENT = 'export const worktreeIdentity = "ui-worktree-only";\n';

function ok(label) {
  console.log(`  ok   ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertDirectTmpFixture(fixture) {
  assert.equal(path.dirname(fixture), '/tmp');
  assert.match(path.basename(fixture), /^tabdesk-files-ui-[^/]+$/);
}

function assertDeletedConflict(snapshot, expectedContent) {
  assert.equal(snapshot.content, expectedContent);
  assert.deepEqual(snapshot.buttons, [{ label: snapshot.copyLabel, disabled: false }]);
  assert(!snapshot.buttons.some(({ label }) => label === snapshot.overwriteLabel));
}

function assertWorktreeIdentity(snapshot) {
  assert.equal(snapshot.rootDisabled, false);
  assert.equal(snapshot.path, 'src/worktree-only.js');
  assert.equal(snapshot.content, 'export const worktreeIdentity = "ui-worktree-only";');
}

function mutationRed(label, runMutation) {
  assert.throws(runMutation, assert.AssertionError);
  ok(`mutation RED: ${label}`);
}

mutationRed('a generic src snapshot cannot prove a worktree switch', () => {
  assertWorktreeIdentity({
    rootDisabled: false,
    path: 'src/note.js',
    content: 'export const shared = true;',
  });
});
mutationRed('blank deleted-conflict content is rejected', () => {
  assertDeletedConflict({
    content: '',
    buttons: [{ label: 'Copy', disabled: false }],
    copyLabel: 'Copy',
    overwriteLabel: 'Overwrite',
  }, 'const localDeleted = true;');
});
mutationRed('an Overwrite-only deleted conflict is rejected', () => {
  assertDeletedConflict({
    content: 'const localDeleted = true;',
    buttons: [{ label: 'Overwrite', disabled: false }],
    copyLabel: 'Copy',
    overwriteLabel: 'Overwrite',
  }, 'const localDeleted = true;');
});
mutationRed('a fixture outside direct /tmp is rejected', () => {
  assertDirectTmpFixture('/var/tmp/tabdesk-files-ui-mutant');
});

function run(file, args, cwd) {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  return address.port;
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();

  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(String(data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    for (const listener of listeners.get(msg.method) || []) listener(msg.params || {});
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  return {
    ready,
    send(method, params = {}) {
      const id = ++seq;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, STEP_TIMEOUT);
        pending.set(id, { resolve, reject, timer });
      });
    },
    on(method, listener) {
      const current = listeners.get(method) || new Set();
      current.add(listener);
      listeners.set(method, current);
      return () => current.delete(listener);
    },
    close() {
      socket.close();
    },
  };
}

async function pageTarget(port) {
  const deadline = Date.now() + STEP_TIMEOUT;
  const endpoint = `http://127.0.0.1:${port}/json`;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(750) });
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((candidate) => (
          candidate.type === 'page'
          && typeof candidate.url === 'string'
          && candidate.url.endsWith('/renderer/index.html')
        ));
        if (target?.webSocketDebuggerUrl) return target;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`isolated renderer target did not appear at ${endpoint}: ${lastError || 'timeout'}`);
}

function childExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeout);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

async function main() {
  const fixture = await mkdtemp('/tmp/tabdesk-files-ui-');
  assertDirectTmpFixture(fixture);
  const profile = path.join(fixture, 'profile');
  const tmux = path.join(fixture, 'tmux');
  const projects = path.join(fixture, 'projects');
  const project = path.join(projects, 'project');
  const note = path.join(project, 'src', 'note.js');
  const worktree = path.join(project, '.worktrees', 'ui-worktree');
  let child;
  let cdp;
  let shutdown = false;
  let childLog = '';

  async function closeChild() {
    if (shutdown || !child) return;
    shutdown = true;
    if (cdp && child.exitCode === null && child.signalCode === null) {
      try { await cdp.send('Page.close'); } catch { /* closing tears down CDP */ }
    }
    if (await childExit(child, 5_000)) return;
    console.log(`  ok   isolated child ${child.pid} required SIGTERM fallback`);
    child.kill('SIGTERM');
    if (!await childExit(child, 5_000)) {
      throw new Error(`isolated Electron child ${child.pid} did not exit after SIGTERM`);
    }
  }

  try {
    await Promise.all([
      mkdir(profile, { recursive: true }),
      mkdir(tmux, { recursive: true }),
      mkdir(path.dirname(note), { recursive: true }),
    ]);
    await writeFile(note, 'export function greeting(name) {\n  return `hello ${name}`;\n}\n');
    await writeFile(path.join(project, '.gitignore'), 'ignored.log\n');
    await writeFile(path.join(project, '.dotfile'), 'visible dotfile\n');
    run('git', ['init', '-b', 'main'], project);
    run('git', ['config', 'user.name', 'TabDesk UI Test'], project);
    run('git', ['config', 'user.email', 'tabdesk-ui@example.invalid'], project);
    run('git', ['add', 'src/note.js', '.gitignore', '.dotfile'], project);
    run('git', ['commit', '-m', 'fixture'], project);
    run('git', ['worktree', 'add', '-b', 'ui-worktree', worktree], project);
    await writeFile(path.join(worktree, WORKTREE_FILE), WORKTREE_CONTENT);
    run('git', ['add', WORKTREE_FILE], worktree);
    run('git', ['commit', '-m', 'worktree identity'], worktree);
    await assert.rejects(
      readFile(path.join(project, WORKTREE_FILE), 'utf8'),
      (error) => error?.code === 'ENOENT',
    );
    await mkdir(path.join(project, '.worktrees', 'fake-directory'));
    await writeFile(path.join(project, 'ignored.log'), 'ignored fixture\n');
    ok('created one isolated Git fixture with a unique committed worktree file');

    const port = await freePort();
    child = spawn(electron, [
      '.',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
    ], {
      cwd: repo,
      env: {
        ...process.env,
        TABDESK_PROJECTS_DIR: projects,
        TMUX_TMPDIR: tmux,
        TABDESK_START_CMD: 'exec bash --noprofile --norc',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => { childLog = (childLog + data).slice(-32_768); });
    child.stderr.on('data', (data) => { childLog = (childLog + data).slice(-32_768); });
    child.once('error', (error) => { childLog += `\nspawn error: ${error.message}`; });
    console.log(`  ok   spawned isolated Electron child PID ${child.pid} on dedicated port ${port}`);

    const target = await pageTarget(port);
    assert(target.url.endsWith('/renderer/index.html'));
    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    ok('connected only to the isolated renderer target');

    let expectedDialog = null;
    const offDialog = cdp.on('Page.javascriptDialogOpening', async (event) => {
      const expectation = expectedDialog;
      expectedDialog = null;
      if (!expectation) return;
      try {
        assert.equal(event.type, 'confirm');
        await cdp.send('Page.handleJavaScriptDialog', { accept: expectation.accept });
        expectation.resolve(event.message);
      } catch (error) {
        expectation.reject(error);
      }
    });

    async function evaluate(expression) {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description
          || result.exceptionDetails.text || 'Runtime.evaluate failed');
      }
      return result.result?.value;
    }

    async function waitFor(expression, label) {
      const deadline = Date.now() + STEP_TIMEOUT;
      let lastError;
      while (Date.now() < deadline) {
        try {
          const value = await evaluate(expression);
          if (value) return value;
        } catch (error) {
          lastError = error;
        }
        await delay(100);
      }
      throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
    }

    async function click(expression, label) {
      const clicked = await evaluate(`(() => { const el = ${expression}; if (!el) return false; el.click(); return true; })()`);
      assert(clicked, `missing click target: ${label}`);
    }

    async function key(key, code, modifiers = 0) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, modifiers });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
    }

    async function confirmAction(action, accept, label) {
      assert.equal(expectedDialog, null, 'only one dialog may be pending');
      const dialog = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (expectedDialog) expectedDialog = null;
          reject(new Error(`timed out waiting for ${label} dialog`));
        }, STEP_TIMEOUT);
        expectedDialog = {
          accept,
          resolve(message) { clearTimeout(timer); resolve(message); },
          reject(error) { clearTimeout(timer); reject(error); },
        };
      });
      const actionResult = action();
      const [message] = await Promise.all([dialog, actionResult]);
      assert(message, `${label} dialog has a message`);
    }

    const projectLiteral = JSON.stringify(project);
    await waitFor(`document.querySelector('.tab.project[title=' + ${JSON.stringify(JSON.stringify(project))} + ']') !== null`, 'fixture project rail row');
    await click(`document.querySelectorAll('.tab.project') && [...document.querySelectorAll('.tab.project')].find((el) => el.title === ${projectLiteral})`, 'fixture project');
    await waitFor("document.querySelector('.overview.shown h2')?.textContent === 'project'", 'project Overview');
    ok('fixture project rail row opens Overview');

    await waitFor("[...document.querySelectorAll('.ov-chip')].some((el) => el.textContent.includes('Terminal'))", 'Terminal chip');
    await click("[...document.querySelectorAll('.ov-chip')].find((el) => el.textContent.includes('Terminal'))", 'Terminal chip');
    await waitFor("[...document.querySelectorAll('.stab:not(.ov):not(.files):not(.add)')].some((el) => el.querySelector('.label')?.textContent.includes('Terminal'))", 'Terminal session tab');
    await click("[...document.querySelectorAll('.stab:not(.ov):not(.files):not(.add)')].find((el) => el.querySelector('.label')?.textContent.includes('Terminal')).querySelector('.pin')", 'Terminal pin');
    await click("document.querySelector('.stab.files')", 'Files tab');
    await waitFor("document.querySelector('.files-panel.shown') && [...document.querySelectorAll('#panels > .panel.shown')].some((el) => !el.classList.contains('files-panel') && !el.classList.contains('overview'))", 'Terminal and Files side by side');
    ok('pinned Terminal remains shown beside Files');

    const roots = await waitFor(`(() => { const select = document.querySelector('.files-root'); if (!select || select.options.length < 2) return false; return [...select.options].map((option) => option.textContent); })()`, 'project and worktree roots');
    assert.deepEqual(roots, ['project', 'ui-worktree']);
    assert(!roots.includes('fake-directory'));
    ok('root selector contains only project and verified ui-worktree');

    const srcSelector = "[...document.querySelectorAll('.files-tree [role=treeitem]')].find((el) => el.dataset.path === 'src')";
    await waitFor(`(() => { const item = ${srcSelector}; return item && item.getAttribute('aria-expanded') === 'false' && item.querySelector(':scope > [role=group]')?.dataset.loaded !== 'true'; })()`, 'lazy src directory');
    await click(srcSelector, 'src directory');
    await waitFor("[...document.querySelectorAll('.files-tree [role=treeitem]')].some((el) => el.dataset.path === 'src/note.js')", 'src/note.js tree item');
    await click("[...document.querySelectorAll('.files-tree [role=treeitem]')].find((el) => el.dataset.path === 'src/note.js')", 'src/note.js');
    await waitFor("document.querySelector('.files-path')?.textContent === 'src/note.js' && document.querySelector('.cm-lineNumbers') && document.querySelectorAll('.cm-line span').length > 0", 'opened highlighted note');
    ok('src loads lazily and note opens with safe path, line numbers, and highlights');

    await evaluate(`(() => { const item = ${srcSelector}; item.focus(); return document.activeElement === item && item.tabIndex === 0; })()`);
    const focusedBefore = await evaluate("document.activeElement?.dataset?.path || ''");
    await key('ArrowDown', 'ArrowDown');
    const focusedAfter = await waitFor(`(() => { const path = document.activeElement?.dataset?.path; return path && path !== ${JSON.stringify(focusedBefore)} ? path : false; })()`, 'roving tree focus movement');
    assert.notEqual(focusedAfter, focusedBefore);
    ok('tree arrow navigation moves the roving treeitem focus');

    assert.equal(await evaluate("[...document.querySelectorAll('.files-tree [role=treeitem]')].some((el) => el.dataset.path === 'ignored.log')"), false);
    await click("document.querySelector('.files-ignored')", 'show ignored toggle');
    await waitFor("(() => { const item = [...document.querySelectorAll('.files-tree [role=treeitem]')].find((el) => el.dataset.path === 'ignored.log'); const marker = item?.querySelector('.files-ignored-marker'); return marker && marker.textContent.trim().length > 0 && item.textContent.includes(marker.textContent); })()", 'ignored entry marker');
    ok('ignored content is hidden by default and shown with a text marker');

    await evaluate("(() => { const el = document.querySelector('.cm-content'); el.focus(); return document.activeElement === el; })()");
    const savedText = '\nconst localSave = true;';
    await cdp.send('Input.insertText', { text: savedText });
    await waitFor("!document.querySelector('.files-save')?.disabled && document.querySelector('.cm-content')?.textContent.includes('localSave')", 'dirty editor');
    await key('s', 'KeyS', 2);
    const savedDisk = await (async () => {
      const deadline = Date.now() + STEP_TIMEOUT;
      while (Date.now() < deadline) {
        const content = await readFile(note, 'utf8');
        if (content.includes('localSave')) return content;
        await delay(100);
      }
      throw new Error('Ctrl+S did not update src/note.js on disk');
    })();
    assert(savedDisk.includes(savedText));
    await waitFor("document.querySelector('.files-save')?.disabled", 'clean state after Ctrl+S');
    ok('editing marks dirty and Ctrl+S updates the fixture file');

    await evaluate("document.querySelector('.cm-content').focus()");
    await key('f', 'KeyF', 2);
    await waitFor("document.querySelector('.cm-search') || document.querySelector('.cm-panels .cm-textfield')", 'CodeMirror search panel');
    ok('Ctrl+F opens CodeMirror search and replace');
    await key('Escape', 'Escape');

    await evaluate("document.querySelector('.cm-content').focus()");
    await key('End', 'End', 2);
    const cleanDisk = 'const diskClean = 1;\n';
    await writeFile(note, cleanDisk);
    await waitFor("document.querySelector('.cm-content')?.textContent.includes('diskClean') && document.querySelector('.files-save')?.disabled", 'clean external autoreload');
    const selectionValid = await evaluate("(() => { const content = document.querySelector('.cm-content'); const selection = getSelection(); return !!content && !!selection?.anchorNode && content.contains(selection.anchorNode) && selection.anchorOffset <= selection.anchorNode.textContent.length; })()");
    assert(selectionValid);
    ok('clean external edit auto-reloads and keeps a valid selection');

    await evaluate("document.querySelector('.cm-content').focus()");
    await cdp.send('Input.insertText', { text: '\nconst localConflict = true;' });
    await waitFor("!document.querySelector('.files-save')?.disabled", 'dirty state before external conflict');
    const conflictDisk = 'const diskConflict = 2;\n';
    await writeFile(note, conflictDisk);
    await waitFor("!document.querySelector('.files-conflict')?.classList.contains('hidden') && document.querySelector('.files-save')?.disabled", 'dirty external conflict');
    const localConflict = await evaluate("document.querySelector('.cm-content').textContent");
    await key('s', 'KeyS', 2);
    await delay(300);
    assert.equal(await readFile(note, 'utf8'), conflictDisk);
    assert.equal(await evaluate("document.querySelector('.cm-content').textContent"), localConflict);
    ok('dirty external edit shows conflict and blocks ordinary Save');

    await click("document.querySelector('.files-conflict button:last-of-type')", 'Copy conflict action');
    assert.equal(await evaluate("document.querySelector('.cm-content').textContent"), localConflict);
    assert.equal(await readFile(note, 'utf8'), conflictDisk);
    assert.equal(await evaluate("document.querySelector('.files-conflict').classList.contains('hidden')"), false);
    ok('Copy preserves the local conflict and disk content');

    await confirmAction(
      () => click("document.querySelector('.files-conflict button:first-of-type')", 'Reload conflict action'),
      true,
      'Reload',
    );
    await waitFor("document.querySelector('.cm-content')?.textContent.includes('diskConflict') && document.querySelector('.files-conflict')?.classList.contains('hidden')", 'reload conflict from disk');
    assert.equal(await evaluate("document.querySelector('.cm-content').textContent"), conflictDisk.trim());
    ok('Reload uses the real confirmation dialog and restores disk content');

    await evaluate("document.querySelector('.cm-content').focus()");
    await cdp.send('Input.insertText', { text: '\nconst localDeleted = true;' });
    await waitFor("!document.querySelector('.files-save')?.disabled", 'dirty state before deletion');
    const localDeleted = await evaluate("document.querySelector('.cm-content').textContent");
    await unlink(note);
    const deletedConflict = await waitFor("(() => { const panel = document.querySelector('.files-conflict'); if (!panel || panel.classList.contains('hidden')) return false; return { content: document.querySelector('.cm-content')?.textContent || '', buttons: [...panel.querySelectorAll('button')].map((button) => ({ label: button.textContent, disabled: button.disabled })), copyLabel: window.t('files.copy'), overwriteLabel: window.t('files.overwrite') }; })()", 'deleted conflict controls');
    assertDeletedConflict(deletedConflict, localDeleted);
    ok('deleted dirty conflict preserves local text and offers no Overwrite');

    const rootControl = await evaluate("(() => { const select = document.querySelector('.files-root'); return select ? { exists: true, disabled: select.disabled, selected: select.selectedOptions[0]?.textContent } : { exists: false }; })()");
    assert.deepEqual(rootControl, { exists: true, disabled: false, selected: 'project' });
    assert.equal(await evaluate("(() => { const select = document.querySelector('.files-root'); select.focus(); return document.activeElement === select; })()"), true);
    await confirmAction(() => key('ArrowDown', 'ArrowDown'), true, 'root switch discard');
    await waitFor("document.querySelector('.files-root')?.selectedOptions[0]?.textContent === 'ui-worktree' && [...document.querySelectorAll('.files-tree [role=treeitem]')].some((el) => el.dataset.path === 'src') && !document.querySelector('.files-path')?.textContent.includes('note.js')", 'worktree tree rebuild');
    await click(srcSelector, 'worktree src directory');
    await waitFor(`[...document.querySelectorAll('.files-tree [role=treeitem]')].some((el) => el.dataset.path === ${JSON.stringify(WORKTREE_FILE)})`, 'worktree-only tree item');
    await click(`[...document.querySelectorAll('.files-tree [role=treeitem]')].find((el) => el.dataset.path === ${JSON.stringify(WORKTREE_FILE)})`, 'worktree-only file');
    const worktreeSnapshot = await waitFor(`(() => { const path = document.querySelector('.files-path')?.textContent; const content = document.querySelector('.cm-content')?.textContent; return path === ${JSON.stringify(WORKTREE_FILE)} && content === 'export const worktreeIdentity = "ui-worktree-only";' ? { rootDisabled: document.querySelector('.files-root').disabled, path, content } : false; })()`, 'worktree-only document');
    assertWorktreeIdentity(worktreeSnapshot);
    ok('verified worktree switch opens its unique committed file');

    const colors = await evaluate("(() => { const probe = document.createElement('span'); const faintProbe = document.createElement('span'); probe.style.cssText = 'position:fixed;visibility:hidden;color:var(--text);background:var(--surface);border-left:1px solid var(--line)'; faintProbe.style.cssText = 'position:fixed;visibility:hidden;color:var(--faint)'; document.body.append(probe, faintProbe); const expected = getComputedStyle(probe); const editor = getComputedStyle(document.querySelector('.cm-editor')); const gutters = getComputedStyle(document.querySelector('.cm-gutters')); const value = { editorColor: editor.color, text: expected.color, editorBackground: editor.backgroundColor, surface: expected.backgroundColor, gutterColor: gutters.color, faint: getComputedStyle(faintProbe).color, gutterBorder: gutters.borderRightColor, line: expected.borderLeftColor }; probe.remove(); faintProbe.remove(); return value; })()");
    assert.equal(colors.editorColor, colors.text);
    assert.equal(colors.editorBackground, colors.surface);
    assert.equal(colors.gutterBorder, colors.line);
    assert.equal(colors.gutterColor, colors.faint);
    ok('computed CodeMirror colors match active TabDesk CSS tokens');

    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    assert(Buffer.from(screenshot.data || '', 'base64').length > 100);
    ok('captured a non-empty screenshot from the isolated target');

    offDialog();
    await closeChild();
    ok(`closed exact isolated child PID ${child.pid}`);
  } catch (error) {
    if (childLog.trim()) error.message += `\n--- isolated Electron output ---\n${childLog.trim()}`;
    throw error;
  } finally {
    try { await closeChild(); } finally {
      try { cdp?.close(); } catch { /* already closed */ }
      await rm(fixture, { recursive: true, force: true });
      console.log(`  ok   removed exact fixture ${fixture}`);
    }
  }
}

await main();
