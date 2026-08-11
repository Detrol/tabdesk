const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-editor-test-'));

app.disableHardwareAcceleration();
app.setPath('userData', PROFILE);

let failures = 0;
function ok(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function cleanup(window) {
  if (window && !window.isDestroyed()) window.destroy();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* gone */ }
}

app.on('ready', async () => {
  let window;
  try {
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await window.loadURL('data:text/html,<main id="test-root"></main>');

    const bundle = fs.readFileSync(path.join(ROOT, 'renderer', 'files.bundle.js'), 'utf8');
    await window.webContents.executeJavaScript(`${bundle}\n;void 0;`);
    const result = await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
      const makeHost = () => {
        const host = document.createElement('div');
        host.style.height = '240px';
        document.querySelector('#test-root').append(host);
        return host;
      };
      const press = (host, key, ctrlKey = true) => {
        const event = new KeyboardEvent('keydown', {
          key, ctrlKey, bubbles: true, cancelable: true,
        });
        host.querySelector('.cm-content').dispatchEvent(event);
        return event.defaultPrevented;
      };
      const lineHTML = (host) => (host.querySelector('.cm-line') || {}).innerHTML || '';
      const create = (options = {}) => {
        const host = makeHost();
        const editor = TabDeskFiles.createEditor({ parent: host, ...options });
        return { host, editor };
      };
      const fileEntry = (name) => ({
        name, path: name, kind: 'file', hidden: false, ignored: false,
        symlink: false,
      });
      const treeItem = (view, path) => [...view.element.querySelectorAll('[role="treeitem"]')]
        .find((item) => item.dataset.path === path);
      const deferred = () => {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        return { promise, resolve };
      };
      const selectRoot = (view, rootId) => {
        const select = view.element.querySelector('.files-root');
        select.value = rootId;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const replaceFileText = async (view, text) => {
        const content = view.element.querySelector('.cm-content');
        content.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(content);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('insertText', false, text);
        await wait(20);
      };
      const makeFilesApi = ({ roots = [{ id: 'root-a', kind: 'project', label: 'Project' }],
        entries = [], read } = {}) => {
        let listener = () => {};
        return {
          openProjectFiles: async () => ({ ok: true, projectId: 'project-a', roots }),
          listProjectFiles: async () => ({ ok: true, entries }),
          readProjectFile: read,
          writeProjectFile: async () => ({ ok: false, error: 'write-failed' }),
          watchProjectFiles: async () => ({ ok: true }),
          unwatchProjectFiles: async () => ({ ok: true }),
          onProjectFilesChanged(callback) {
            listener = callback;
            return () => { listener = () => {}; };
          },
          emit(change) { listener(change); },
        };
      };

      const changes = [];
      let saves = 0;
      const primary = create({
        onChange: (content) => changes.push(content),
        onSave: () => { saves += 1; },
        label: 'Project file editor test',
      });
      primary.editor.setDocument('abc', { anchor: 99, head: -4 });
      const clamped = primary.editor.getSelection();
      const suppressed = changes.length === 0;
      const savePrevented = press(primary.host, 's');
      await wait();
      const saveCalled = saves === 1;

      primary.editor.setReadOnly(true);
      const readOnly = primary.host.querySelector('.cm-content').contentEditable === 'false';
      primary.editor.setDocument('locked', { anchor: 99, head: 99 });
      const readOnlyAfterDocument = primary.host.querySelector('.cm-content').contentEditable === 'false';
      primary.editor.setReadOnly(false);
      const writableAgain = primary.host.querySelector('.cm-content').contentEditable === 'true';

      primary.editor.setTheme({
        dark: true,
        tokens: { surface: '#010203' },
      });
      primary.editor.setDocument('themed', { anchor: 0, head: 0 });
      const themeAfterDocument = getComputedStyle(
        primary.host.querySelector('.cm-editor'),
      ).backgroundColor === 'rgb(1, 2, 3)';

      primary.editor.setDocument('A', { anchor: 1, head: 1 });
      primary.editor.setDocument('B', { anchor: 1, head: 1 });
      const changesBeforeUndo = changes.length;
      press(primary.host, 'z');
      await wait();
      const undoDocument = primary.editor.getDocument();
      const undoChanges = changes.length - changesBeforeUndo;

      const sample = 'body { color: red; }';
      const cssReference = create();
      cssReference.editor.setDocument(sample, { anchor: 0, head: 0 });
      await cssReference.editor.setLanguage('reference.css');
      await wait(20);
      const expectedCss = lineHTML(cssReference.host);
      cssReference.editor.destroy();

      const jsReference = create();
      jsReference.editor.setDocument(sample, { anchor: 0, head: 0 });
      await jsReference.editor.setLanguage('reference.js');
      await wait(20);
      const expectedJs = lineHTML(jsReference.host);
      jsReference.editor.destroy();

      let matcherCalls = 0;
      const languageMatcher = (filename, defaultMatch) => {
        matcherCalls += 1;
        if (filename === 'unknown.none') return null;
        if (filename === 'rejected.bad') {
          return { load: () => Promise.reject(new Error('expected loader failure')) };
        }
        const mapped = filename.endsWith('.js') ? 'reference.js' : 'reference.css';
        const description = defaultMatch(mapped);
        const delay = filename.startsWith('slow') ? 80 : 0;
        return {
          load: () => new Promise((resolve, reject) => {
            setTimeout(() => description.load().then(resolve, reject), delay);
          }),
        };
      };

      const raced = create({ languageMatcher });
      raced.editor.setDocument(sample, { anchor: 0, head: 0 });
      const slow = raced.editor.setLanguage('slow.js');
      const fast = raced.editor.setLanguage('fast.css');
      await Promise.all([slow, fast]);
      await wait(20);
      const racedHTML = lineHTML(raced.host);
      raced.editor.setDocument(sample, { anchor: 0, head: 0 });
      await wait(20);
      const languageAfterDocument = lineHTML(raced.host);

      await raced.editor.setLanguage('unknown.none');
      await wait();
      const unknownPlain = !raced.host.querySelector('.cm-line span');
      await raced.editor.setLanguage('fast.js');
      await wait(20);
      await raced.editor.setLanguage('rejected.bad');
      await wait();
      const rejectedPlain = !raced.host.querySelector('.cm-line span');

      let pendingSettled = false;
      const pending = raced.editor.setLanguage('slow.js').then(() => { pendingSettled = true; });
      raced.editor.destroy();
      raced.editor.destroy();
      await pending;
      const destroyed = !raced.host.querySelector('.cm-editor');

      primary.editor.destroy();
      primary.editor.destroy();

      const staleApi = makeFilesApi({
        entries: [fileEntry('A.txt'), fileEntry('B.bin')],
        read: async ({ path }) => path === 'A.txt'
          ? { ok: true, path, content: 'alpha', revision: 'a'.repeat(64), ignored: false }
          : { ok: false, error: 'not-text' },
      });
      const staleView = TabDeskFiles.createFileView({ api: staleApi, t: (key) => key });
      document.querySelector('#test-root').append(staleView.element);
      await staleView.activate('/project-a');
      treeItem(staleView, 'A.txt').click();
      await wait(10);
      treeItem(staleView, 'B.bin').click();
      await wait(10);
      const failedOpenBlank = staleView.element.querySelector('.cm-content').textContent === '';
      const failedOpenReadOnly = staleView.element.querySelector('.cm-content').contentEditable === 'false';
      const failedOpenSafe = staleView.element.querySelector('.files-path').textContent === 'B.bin'
        && staleView.element.querySelector('.files-status').textContent === 'files.error.not-text';
      await staleView.destroy();

      const delayedB = deferred();
      const rootReads = [];
      let bLists = 0;
      const rootRaceApi = makeFilesApi({
        roots: [
          { id: 'root-b', kind: 'project', label: 'B' },
          { id: 'root-c', kind: 'worktree', label: 'C' },
        ],
        read: async (request) => {
          rootReads.push(request);
          return {
            ok: true, path: request.path, content: request.rootId,
            revision: (request.rootId === 'root-b' ? 'b' : 'c').repeat(64), ignored: false,
          };
        },
      });
      rootRaceApi.listProjectFiles = async ({ rootId }) => {
        if (rootId === 'root-b' && ++bLists === 2) return delayedB.promise;
        return { ok: true, entries: rootId === 'root-b' ? [fileEntry('B.txt')] : [] };
      };
      const rootRaceView = TabDeskFiles.createFileView({ api: rootRaceApi, t: (key) => key });
      document.querySelector('#test-root').append(rootRaceView.element);
      await rootRaceView.activate('/root-race');
      treeItem(rootRaceView, 'B.txt').click();
      await wait(10);
      selectRoot(rootRaceView, 'root-c');
      await wait(10);
      selectRoot(rootRaceView, 'root-b');
      await wait();
      selectRoot(rootRaceView, 'root-c');
      await wait(10);
      delayedB.resolve({ ok: true, entries: [fileEntry('B.txt')] });
      await wait(20);
      const rootRaceSafe = !rootReads.some(({ rootId, path }) => (
        rootId === 'root-c' && path === 'B.txt'
      ));
      await rootRaceView.destroy();

      const reloadGate = deferred();
      let conflictRead = 'initial';
      let concurrentWrites = 0;
      const concurrentApi = makeFilesApi({
        entries: [fileEntry('conflict.txt')],
        read: async ({ path }) => {
          if (conflictRead === 'reload') return reloadGate.promise;
          if (conflictRead === 'external') {
            return {
              ok: true, path, content: 'external', revision: 'e'.repeat(64), ignored: false,
            };
          }
          return { ok: true, path, content: 'disk', revision: 'd'.repeat(64), ignored: false };
        },
      });
      concurrentApi.writeProjectFile = async () => {
        concurrentWrites += 1;
        return { ok: true, revision: 'w'.repeat(64) };
      };
      const concurrentView = TabDeskFiles.createFileView({
        api: concurrentApi,
        t: (key) => key,
        confirmReload: () => true,
      });
      document.querySelector('#test-root').append(concurrentView.element);
      await concurrentView.activate('/concurrent');
      treeItem(concurrentView, 'conflict.txt').click();
      await wait(10);
      await replaceFileText(concurrentView, 'local');
      const becameDirty = !concurrentView.element.querySelector('.files-save').disabled;
      conflictRead = 'external';
      concurrentApi.emit({
        projectId: 'project-a', rootId: 'root-a', path: 'conflict.txt', kind: 'changed',
      });
      await wait(20);
      conflictRead = 'reload';
      const reloadButton = [...concurrentView.element.querySelectorAll('.files-conflict button')]
        .find((button) => button.textContent === 'files.reload');
      reloadButton.click();
      const pendingButtonsDisabled = [...concurrentView.element.querySelectorAll('.files-conflict button')]
        .every((button) => button.disabled)
        && concurrentView.element.querySelector('.files-save').disabled;
      const overwriteButton = [...concurrentView.element.querySelectorAll('.files-conflict button')]
        .find((button) => button.textContent === 'files.overwrite');
      overwriteButton.click();
      await wait();
      const concurrentActionIgnored = concurrentWrites === 0;
      reloadGate.resolve({
        ok: true, path: 'conflict.txt', content: 'external',
        revision: 'e'.repeat(64), ignored: false,
      });
      await wait(20);
      await concurrentView.destroy();

      const saveGate = deferred();
      let saveReadCount = 0;
      const saveApi = makeFilesApi({
        entries: [fileEntry('save.txt')],
        read: async ({ path }) => {
          saveReadCount += 1;
          return saveReadCount === 1
            ? { ok: true, path, content: 'disk', revision: 'd'.repeat(64), ignored: false }
            : { ok: true, path, content: 'local', revision: '1'.repeat(64), ignored: false };
        },
      });
      saveApi.writeProjectFile = () => saveGate.promise;
      const saveView = TabDeskFiles.createFileView({ api: saveApi, t: (key) => key });
      document.querySelector('#test-root').append(saveView.element);
      await saveView.activate('/save-hint');
      treeItem(saveView, 'save.txt').click();
      await wait(10);
      await replaceFileText(saveView, 'local');
      saveView.element.querySelector('.files-save').click();
      saveApi.emit({
        projectId: 'project-a', rootId: 'root-a', path: 'save.txt', kind: 'changed',
      });
      await wait(20);
      const pendingHintAbsorbed = saveReadCount === 1
        && saveView.element.querySelector('.files-status').textContent === 'files.dirty';
      saveGate.resolve({ ok: true, revision: '1'.repeat(64) });
      await wait(20);
      const ownSaveReconciledClean = saveView.element.querySelector('.files-status').textContent
        === 'files.saved'
        && saveView.element.querySelector('.cm-content').textContent === 'local'
        && !saveView.hasUnsavedChanges();
      await saveView.destroy();

      let mismatchReads = 0;
      const mismatchApi = makeFilesApi({
        entries: [fileEntry('mismatch.txt')],
        read: async ({ path }) => {
          mismatchReads += 1;
          return mismatchReads === 1
            ? { ok: true, path, content: 'disk', revision: 'd'.repeat(64), ignored: false }
            : { ok: true, path, content: 'external-r2', revision: '2'.repeat(64), ignored: false };
        },
      });
      mismatchApi.writeProjectFile = async () => ({ ok: true, revision: '1'.repeat(64) });
      const mismatchView = TabDeskFiles.createFileView({ api: mismatchApi, t: (key) => key });
      document.querySelector('#test-root').append(mismatchView.element);
      await mismatchView.activate('/save-mismatch');
      treeItem(mismatchView, 'mismatch.txt').click();
      await wait(10);
      await replaceFileText(mismatchView, 'local-r1');
      mismatchView.element.querySelector('.files-save').click();
      await wait(20);
      const postWriteMismatchConflicts = mismatchView.element.querySelector('.files-status').textContent
        === 'files.conflict'
        && mismatchView.element.querySelector('.cm-content').textContent === 'local-r1'
        && mismatchView.hasUnsavedChanges();
      await mismatchView.destroy();

      let deletionReads = 0;
      const deletionApi = makeFilesApi({
        entries: [fileEntry('deleted-after-save.txt')],
        read: async ({ path }) => {
          deletionReads += 1;
          return deletionReads === 1
            ? { ok: true, path, content: 'disk', revision: 'd'.repeat(64), ignored: false }
            : { ok: false, error: 'deleted' };
        },
      });
      deletionApi.writeProjectFile = async () => ({ ok: true, revision: '1'.repeat(64) });
      const deletionView = TabDeskFiles.createFileView({ api: deletionApi, t: (key) => key });
      document.querySelector('#test-root').append(deletionView.element);
      await deletionView.activate('/save-deletion');
      treeItem(deletionView, 'deleted-after-save.txt').click();
      await wait(10);
      await replaceFileText(deletionView, 'local-deleted');
      deletionView.element.querySelector('.files-save').click();
      await wait(20);
      const postWriteDeletionConflicts = deletionView.element.querySelector('.files-status').textContent
        === 'files.conflict'
        && deletionView.element.querySelector('.cm-content').textContent === 'local-deleted'
        && ![...deletionView.element.querySelectorAll('.files-conflict button')]
          .some((button) => button.textContent === 'files.overwrite');
      await deletionView.destroy();

      let locale = 'en';
      const localeT = (key) => locale + ':' + key;
      const localeErrorApi = makeFilesApi({
        entries: [fileEntry('binary.dat')],
        read: async () => ({ ok: false, error: 'not-text' }),
      });
      const localeErrorView = TabDeskFiles.createFileView({ api: localeErrorApi, t: localeT });
      document.querySelector('#test-root').append(localeErrorView.element);
      await localeErrorView.activate('/locale-error');
      treeItem(localeErrorView, 'binary.dat').click();
      await wait(10);
      const errorBeforeLanguage = localeErrorView.element.querySelector('.files-status').textContent;
      locale = 'sv';
      localeErrorView.onLanguage();
      await wait(10);
      const typedErrorRetranslated = errorBeforeLanguage === 'en:files.error.not-text'
        && localeErrorView.element.querySelector('.files-status').textContent
          === 'sv:files.error.not-text';
      await localeErrorView.destroy();

      locale = 'en';
      let rootOpenCount = 0;
      const rootGoneApi = makeFilesApi();
      rootGoneApi.openProjectFiles = async () => {
        rootOpenCount += 1;
        return {
          ok: true,
          projectId: 'project-a',
          roots: rootOpenCount === 1
            ? [
              { id: 'root-a', kind: 'project', label: 'A' },
              { id: 'root-gone', kind: 'worktree', label: 'Gone' },
            ]
            : [{ id: 'root-a', kind: 'project', label: 'A' }],
        };
      };
      rootGoneApi.listProjectFiles = async () => ({ ok: true, entries: [] });
      const rootGoneView = TabDeskFiles.createFileView({ api: rootGoneApi, t: localeT });
      document.querySelector('#test-root').append(rootGoneView.element);
      await rootGoneView.activate('/root-gone');
      selectRoot(rootGoneView, 'root-gone');
      await wait(10);
      await rootGoneView.deactivate();
      await rootGoneView.activate('/root-gone');
      const rootGoneBeforeLanguage = rootGoneView.element.querySelector('.files-status').textContent;
      locale = 'sv';
      rootGoneView.onLanguage();
      await wait(10);
      const rootGoneRetranslated = rootGoneBeforeLanguage === 'en:files.rootGone'
        && rootGoneView.element.querySelector('.files-status').textContent === 'sv:files.rootGone';
      await rootGoneView.destroy();

      const navigationWrite = deferred();
      const navigationReads = [];
      const navigationApi = makeFilesApi({
        entries: [fileEntry('nav-a.txt'), fileEntry('nav-b.txt')],
        read: async ({ path }) => {
          navigationReads.push(path);
          return {
            ok: true, path, content: path === 'nav-a.txt' ? 'A' : 'B',
            revision: (path === 'nav-a.txt' ? 'a' : 'b').repeat(64), ignored: false,
          };
        },
      });
      navigationApi.writeProjectFile = () => navigationWrite.promise;
      const navigationView = TabDeskFiles.createFileView({
        api: navigationApi, t: (key) => key, confirmDiscard: () => true,
      });
      document.querySelector('#test-root').append(navigationView.element);
      await navigationView.activate('/operation-navigation');
      treeItem(navigationView, 'nav-a.txt').click();
      await wait(10);
      await replaceFileText(navigationView, 'local-a');
      navigationView.element.querySelector('.files-save').click();
      treeItem(navigationView, 'nav-b.txt').click();
      await wait(20);
      navigationWrite.resolve({ ok: true, revision: '1'.repeat(64) });
      await wait(20);
      const navigationInvalidatesPending = navigationView.element.querySelector('.files-path').textContent
        === 'nav-b.txt'
        && navigationView.element.querySelector('.cm-content').textContent === 'B'
        && navigationReads.join(',') === 'nav-a.txt,nav-b.txt';
      await navigationView.destroy();

      const destroyWrite = deferred();
      let destroyReads = 0;
      const destroyApi = makeFilesApi({
        entries: [fileEntry('destroy.txt')],
        read: async ({ path }) => {
          destroyReads += 1;
          return { ok: true, path, content: 'disk', revision: 'd'.repeat(64), ignored: false };
        },
      });
      destroyApi.writeProjectFile = () => destroyWrite.promise;
      const destroyView = TabDeskFiles.createFileView({ api: destroyApi, t: (key) => key });
      document.querySelector('#test-root').append(destroyView.element);
      await destroyView.activate('/operation-destroy');
      treeItem(destroyView, 'destroy.txt').click();
      await wait(10);
      await replaceFileText(destroyView, 'local');
      destroyView.element.querySelector('.files-save').click();
      await destroyView.destroy();
      destroyWrite.resolve({ ok: true, revision: '1'.repeat(64) });
      await wait(20);
      const destroyInvalidatesPending = destroyReads === 1
        && !destroyView.element.querySelector('.cm-editor');

      let retryRead = 'initial';
      const retryApi = makeFilesApi({
        entries: [fileEntry('retry.txt')],
        read: async ({ path }) => {
          if (retryRead === 'failed') return { ok: false, error: 'unreadable' };
          if (retryRead === 'external') {
            return { ok: true, path, content: 'external', revision: 'e'.repeat(64), ignored: false };
          }
          return { ok: true, path, content: 'disk', revision: 'd'.repeat(64), ignored: false };
        },
      });
      const retryView = TabDeskFiles.createFileView({
        api: retryApi, t: (key) => key, confirmReload: () => true,
      });
      document.querySelector('#test-root').append(retryView.element);
      await retryView.activate('/operation-retry');
      treeItem(retryView, 'retry.txt').click();
      await wait(10);
      await replaceFileText(retryView, 'local');
      retryRead = 'external';
      retryApi.emit({
        projectId: 'project-a', rootId: 'root-a', path: 'retry.txt', kind: 'changed',
      });
      await wait(20);
      retryRead = 'failed';
      [...retryView.element.querySelectorAll('.files-conflict button')]
        .find((button) => button.textContent === 'files.reload').click();
      await wait(20);
      const buttonsReenabledAfterFailure = retryView.element.querySelector('.files-status').textContent
        === 'files.error.unreadable'
        && [...retryView.element.querySelectorAll('.files-conflict button')]
          .every((button) => !button.disabled);
      await retryView.destroy();

      const overwriteWrite = deferred();
      const overwriteRead = deferred();
      let overwritePhase = 'initial';
      let overwritePostReads = 0;
      const overwriteApi = makeFilesApi({
        entries: [fileEntry('overwrite.txt')],
        read: async ({ path }) => {
          if (overwritePhase === 'post') {
            overwritePostReads += 1;
            return overwriteRead.promise;
          }
          if (overwritePhase === 'external') {
            return { ok: true, path, content: 'external', revision: 'e'.repeat(64), ignored: false };
          }
          return { ok: true, path, content: 'disk', revision: 'd'.repeat(64), ignored: false };
        },
      });
      overwriteApi.writeProjectFile = () => overwriteWrite.promise;
      const overwriteView = TabDeskFiles.createFileView({ api: overwriteApi, t: (key) => key });
      document.querySelector('#test-root').append(overwriteView.element);
      await overwriteView.activate('/operation-overwrite');
      treeItem(overwriteView, 'overwrite.txt').click();
      await wait(10);
      await replaceFileText(overwriteView, 'local-overwrite');
      overwritePhase = 'external';
      overwriteApi.emit({
        projectId: 'project-a', rootId: 'root-a', path: 'overwrite.txt', kind: 'changed',
      });
      await wait(20);
      overwritePhase = 'post';
      [...overwriteView.element.querySelectorAll('.files-conflict button')]
        .find((button) => button.textContent === 'files.overwrite').click();
      overwriteWrite.resolve({ ok: true, revision: '1'.repeat(64) });
      await wait();
      const overwriteWaitsForReread = overwritePostReads === 1
        && [...overwriteView.element.querySelectorAll('.files-conflict button')]
          .every((button) => button.disabled);
      overwriteRead.resolve({
        ok: true, path: 'overwrite.txt', content: 'local-overwrite',
        revision: '1'.repeat(64), ignored: false,
      });
      await wait(20);
      const overwriteExactRereadClean = overwriteView.element.querySelector('.files-status').textContent
        === 'files.saved'
        && overwriteView.element.querySelector('.cm-content').textContent === 'local-overwrite'
        && !overwriteView.hasUnsavedChanges();
      await overwriteView.destroy();

      return {
        suppressed,
        clamped,
        savePrevented,
        saveCalled,
        readOnly,
        readOnlyAfterDocument,
        writableAgain,
        themeAfterDocument,
        undoDocument,
        undoChanges,
        matcherCalls,
        expectedCss,
        expectedJs,
        racedHTML,
        languageAfterDocument,
        unknownPlain,
        rejectedPlain,
        pendingSettled,
        destroyed,
        failedOpenBlank,
        failedOpenReadOnly,
        failedOpenSafe,
        rootRaceSafe,
        becameDirty,
        pendingButtonsDisabled,
        concurrentActionIgnored,
        pendingHintAbsorbed,
        ownSaveReconciledClean,
        postWriteMismatchConflicts,
        postWriteDeletionConflicts,
        typedErrorRetranslated,
        rootGoneRetranslated,
        navigationInvalidatesPending,
        destroyInvalidatesPending,
        buttonsReenabledAfterFailure,
        overwriteWaitsForReread,
        overwriteExactRereadClean,
      };
    })()`);

    console.log('== project file editor controller ==');
    ok('setDocument suppresses outward onChange', result.suppressed);
    ok('setDocument clamps both selection endpoints',
      result.clamped.anchor === 3 && result.clamped.head === 0,
      JSON.stringify(result.clamped));
    ok('Mod-s invokes onSave', result.saveCalled);
    ok('Mod-s prevents the browser default', result.savePrevented);
    ok('read-only disables content editability', result.readOnly);
    ok('new document preserves read-only editability', result.readOnlyAfterDocument);
    ok('writable mode restores content editability', result.writableAgain);
    ok('new document preserves the current theme', result.themeAfterDocument);
    ok('undo cannot restore a previous document', result.undoDocument === 'B', result.undoDocument);
    ok('cross-document undo emits no onChange', result.undoChanges === 0, String(result.undoChanges));
    ok('language test seam controls the real controller matcher', result.matcherCalls >= 5,
      String(result.matcherCalls));
    ok('out-of-order language loads keep the latest real reconfigure result',
      result.expectedCss !== result.expectedJs && result.racedHTML === result.expectedCss,
      JSON.stringify({ css: result.expectedCss, js: result.expectedJs, raced: result.racedHTML }));
    ok('new document preserves the current language extension',
      result.languageAfterDocument === result.expectedCss,
      JSON.stringify({ expected: result.expectedCss, actual: result.languageAfterDocument }));
    ok('unknown language reconfigures to plain text', result.unknownPlain);
    ok('rejected language loader reconfigures to plain text', result.rejectedPlain);
    ok('destroy invalidates and settles a pending language load', result.pendingSettled && result.destroyed);
    ok('failed file open clears the stale editor buffer', result.failedOpenBlank);
    ok('failed file open leaves the editor read-only', result.failedOpenReadOnly);
    ok('failed file open shows only the requested relative path and typed message', result.failedOpenSafe);
    ok('stale root-switch continuation cannot open the prior root lastFile', result.rootRaceSafe);
    ok('real editor input drives the file view dirty state', result.becameDirty);
    ok('pending reload disables every competing document action', result.pendingButtonsDisabled);
    ok('overwrite is ignored while reload is pending', result.concurrentActionIgnored);
    ok('matching watcher hint is absorbed while its save is pending', result.pendingHintAbsorbed);
    ok('successful save becomes clean only after exact R1 reread', result.ownSaveReconciledClean);
    ok('post-write R2 keeps local content in conflict', result.postWriteMismatchConflicts);
    ok('post-write deletion keeps local content without overwrite', result.postWriteDeletionConflicts);
    ok('active typed error retranslates on language change', result.typedErrorRetranslated);
    ok('active root-gone notice retranslates on language change', result.rootGoneRetranslated);
    ok('file navigation invalidates a pending save and its post-read', result.navigationInvalidatesPending);
    ok('destroy invalidates a pending save and its post-read', result.destroyInvalidatesPending);
    ok('document action buttons re-enable after reload failure', result.buttonsReenabledAfterFailure);
    ok('overwrite remains pending until its exact semantic reread', result.overwriteWaitsForReread);
    ok('overwrite becomes clean only after matching revision and content', result.overwriteExactRereadClean);
  } catch (error) {
    failures += 1;
    console.error(error && error.stack ? error.stack : error);
  } finally {
    cleanup(window);
    app.exit(failures ? 1 : 0);
  }
});
