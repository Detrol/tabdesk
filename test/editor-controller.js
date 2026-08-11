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
  } catch (error) {
    failures += 1;
    console.error(error && error.stack ? error.stack : error);
  } finally {
    cleanup(window);
    app.exit(failures ? 1 : 0);
  }
});
