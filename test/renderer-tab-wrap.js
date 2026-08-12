const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-tab-wrap-'));
const FIXTURE = path.join(PROFILE, 'renderer.html');

app.disableHardwareAcceleration();
app.setPath('userData', PROFILE);

async function geometry(window) {
  return window.webContents.executeJavaScript(`(() => {
    const strip = document.querySelector('#strip');
    const panels = document.querySelector('#panels');
    const tabs = [...strip.querySelectorAll('.stab')];
    const stripRect = strip.getBoundingClientRect();
    return {
      rows: new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top))).size,
      stripHeight: stripRect.height,
      stripBottom: stripRect.bottom,
      panelTop: panels.getBoundingClientRect().top,
      scrollWidth: strip.scrollWidth,
      clientWidth: strip.clientWidth,
    };
  })()`);
}

app.whenReady().then(async () => {
  let window;
  let exitCode = 0;
  try {
    const stylesheet = pathToFileURL(path.join(ROOT, 'renderer/styles.css')).href;
    const tabs = Array.from({ length: 10 }, (_, index) => (
      `<button class="stab"><span class="label">Session ${index + 1} with a long name</span></button>`
    )).join('');
    fs.writeFileSync(FIXTURE, `<!doctype html>
      <link rel="stylesheet" href="${stylesheet}">
      <div id="root"><div id="app"><main id="content">
        <div id="strip">${tabs}</div><div id="panels"></div>
      </main></div></div>`);

    window = new BrowserWindow({ show: false, width: 640, height: 420 });
    await window.loadFile(FIXTURE);
    await window.webContents.executeJavaScript('document.fonts.ready');

    const wrapped = await geometry(window);
    assert(wrapped.rows > 1, JSON.stringify(wrapped));
    assert(wrapped.scrollWidth <= wrapped.clientWidth + 1, JSON.stringify(wrapped));
    assert(Math.abs(wrapped.panelTop - wrapped.stripBottom) <= 1, JSON.stringify(wrapped));

    await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const tabs = [...document.querySelectorAll('#strip .stab')];
      tabs.slice(2).forEach((tab) => tab.remove());
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`);
    const single = await geometry(window);
    assert.equal(single.rows, 1, JSON.stringify(single));
    assert.equal(single.stripHeight, 38, JSON.stringify(single));
    assert(Math.abs(single.panelTop - single.stripBottom) <= 1, JSON.stringify(single));
    console.log('  ok   session strip wraps and drives panel geometry');
  } catch (error) {
    exitCode = 1;
    console.error(error && error.stack ? error.stack : error);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    fs.rmSync(PROFILE, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
