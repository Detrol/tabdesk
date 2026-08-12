# Wrap Session Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap overflowing session tabs onto unlimited rows while the terminal panel area begins immediately below the strip's actual height.

**Architecture:** Use the browser's native layout engine: `#content` becomes a two-row CSS grid, `#strip` is an auto-height wrapping flex row, and `#panels` fills the remaining row. Remove the activation-time horizontal reveal helper because wrapping eliminates the horizontal viewport it served.

**Tech Stack:** Electron 31, Chromium CSS Grid and Flexbox, classic browser JavaScript, Node assertions, existing Electron test harness.

## Global Constraints

- Tabs keep their current order, width, controls, and single-row appearance while they fit.
- Overflowing tabs continue on the next row from left to right, with no row limit.
- The session strip grows downward; the panel area starts immediately below it.
- Switching projects lets the strip shrink or grow to match that project's tabs.
- Overview, Files, and `+` remain part of the same wrapping strip.
- Dragging a session over a tab on another row keeps using the hovered tab as the reorder target.
- Do not add a maximum row count, vertical strip scrolling, JavaScript height calculation, animation, or a dependency.
- Drive only an isolated Electron instance; never activate, reload, or otherwise drive the guard-managed main window.

---

### Task 1: Make the session strip wrap and drive panel geometry

**Files:**
- Create: `test/renderer-tab-wrap.js`
- Modify: `renderer/styles.css:295-303,385-391,462-480`
- Modify: `renderer/renderer.js:463-473,508-509,530-536`
- Modify: `package.json:12`

**Interfaces:**
- Consumes: the existing `#content > #strip` and `#content > #panels` DOM structure.
- Produces: no JavaScript API; the observable contract is wrapped `.stab` geometry with `#panels` directly below `#strip`.

- [ ] **Step 1: Write the failing Chromium geometry test**

Create `test/renderer-tab-wrap.js`. It loads the real `renderer/styles.css` into a minimal Electron renderer, uses ten real `.stab` elements at a fixed viewport width, and asserts behavior rather than source text:

```js
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
```

This catches the realistic regression where `flex-wrap` is removed or the panel grid returns to a fixed offset.

- [ ] **Step 2: Run the focused test and verify RED**

Reuse the already installed dependency tree without modifying either lockfile:

```bash
ln -s ../../node_modules node_modules
./node_modules/.bin/electron test/renderer-tab-wrap.js
```

Expected: exit 1 at `assert(wrapped.rows > 1, ...)`, with a snapshot showing `rows: 1` and `scrollWidth > clientWidth`. If `node_modules` already exists in the worktree, do not replace it.

- [ ] **Step 3: Implement the minimum native layout**

In `renderer/styles.css`, make only these layout changes:

```css
#content {
  flex: 1 1 auto;
  min-width: 0;
  position: relative;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  /* existing background stays unchanged */
}

#panels {
  position: relative;
  grid-row: 2;
  min-height: 0;
  display: grid;
  /* existing gap and padding stay unchanged */
}

#strip {
  position: relative;
  grid-row: 1;
  min-height: 38px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 6px;
  /* existing border, background and z-index stay unchanged */
  overflow: hidden;
}
```

Delete the obsolete `#content:has(#strip:not(.hidden)) #panels { top: 38px; }` rule. In `renderer/renderer.js`, delete `revealClippedStripTab()` and its calls immediately after `applyLayout()` in `setActive()` and `focusVisibleTerminal()`; do not change either activation flow otherwise.

- [ ] **Step 4: Run the focused test and verify GREEN**

```bash
./node_modules/.bin/electron test/renderer-tab-wrap.js
```

Expected:

```text
  ok   session strip wraps and drives panel geometry
```

- [ ] **Step 5: Put the focused geometry test in the project gate**

Add `electron test/renderer-tab-wrap.js` to the existing `test` script immediately after `electron test/renderer-session-controller.js`. Run the focused test once through npm:

```bash
./node_modules/.bin/electron test/renderer-tab-wrap.js
```

Expected: the same single `ok` line and exit 0.

- [ ] **Step 6: Verify the real renderer in an isolated TabDesk instance**

Create one direct child under `/tmp` containing a projects root, user-data directory, and tmux directory. Start only the worktree's app with a dedicated free debug port and the isolated environment:

```bash
TASK_UI_ROOT=$(mktemp -d /tmp/tabdesk-tab-wrap-XXXXXX)
TASK_UI_PORT=$(node -e "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close()})")
mkdir -p "$TASK_UI_ROOT/projects/project-a" "$TASK_UI_ROOT/projects/project-b" "$TASK_UI_ROOT/tmux" "$TASK_UI_ROOT/profile"
TABDESK_PROJECTS_DIR="$TASK_UI_ROOT/projects" \
TMUX_TMPDIR="$TASK_UI_ROOT/tmux" \
./node_modules/.bin/electron . \
  --user-data-dir="$TASK_UI_ROOT/profile" \
  --remote-debugging-port="$TASK_UI_PORT"
```

Through that target's DevTools protocol only, select the fixture project and create enough sessions with the renderer's existing `buildTab()` path to produce at least three rows. Assert literal geometry outcomes:

```js
({
  rows: new Set([...document.querySelectorAll('#strip .stab')]
    .map((tab) => Math.round(tab.getBoundingClientRect().top))).size,
  noHorizontalOverflow: strip.scrollWidth <= strip.clientWidth + 1,
  panelsFollowStrip: Math.abs(
    panels.getBoundingClientRect().top - strip.getBoundingClientRect().bottom,
  ) <= 1,
})
```

Expected: `rows >= 3`, `noHorizontalOverflow: true`, and `panelsFollowStrip: true`. Activate a tab on the last row and assert it receives `.focused`. Native-drag one session over a target on another row and assert the target-relative DOM order changes. Switch to a second project with two tabs and assert one row, `strip.getBoundingClientRect().height === 38`, and matching panel/strip edges. Close the exact child PID, stop only the isolated tmux server, and remove only the exact directory stored in `TASK_UI_ROOT`.

- [ ] **Step 7: Run repository verification and inspect scope**

Check for competing heavy jobs, then run one full suite:

```bash
pgrep -af 'esbuild|rollup|webpack|vite|gradle|jest|vitest|pest'
node --check renderer/renderer.js
npm test
git diff --check
git status --short
```

Expected: no competing heavy build, syntax exit 0, the full test suite exits 0 with the new geometry test's `ok` line and no `FAIL` lines, `git diff --check` prints nothing, and only the four intended implementation files are changed. Run the read-only `scope-review` procedure before committing.

- [ ] **Step 8: Commit the verified implementation**

Remove only the worktree's task-created `node_modules` symlink, then stage explicit paths:

```bash
git add package.json renderer/styles.css renderer/renderer.js test/renderer-tab-wrap.js
git commit -m "feat: wrap overflowing session tabs"
```

Do not push or integrate; that requires separate explicit approval.
