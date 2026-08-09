# Reorder Project Session Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag session tabs left or right within one project and restore that order after reload or restart.

**Architecture:** A small browser/CommonJS module owns the pure ordering rules so the renderer and main process use the same semantics. The renderer keeps explicit tab-ID order and sends the project's ordered tmux session IDs through preload IPC; main stores that order in the existing `openTabs` array without introducing a settings migration.

**Tech Stack:** Electron 31, classic browser JavaScript, CommonJS in the main process and test runner, native HTML Drag and Drop, existing `npm test` Electron harness.

## Global Constraints

- Only session tabs move; Overview and `+` remain fixed.
- Reordering stays within one project and survives renderer reloads and TabDesk restarts.
- Active, pinned, running, waiting, and dead state must not change when a tab moves.
- Existing `openTabs` settings require no migration; their current array order is authoritative.
- Newly discovered orphan tmux sessions append after persisted records in stable session-name order.
- Do not add a third-party sortable dependency or drag animation.
- Do not kill TabDesk. Main-process changes are applied only through TabDesk's own Restart control.

---

### Task 1: Persist an explicit tab order

**Files:**
- Create: `renderer/tab-order.js`
- Modify: `renderer/index.html:244-247`
- Modify: `main.js:1-30,118-126,916-944,966-977`
- Modify: `preload.js:124-131`
- Modify: `test/main.js:43-55`

**Interfaces:**
- Produces: `TabOrder.move(ids, movingId, targetId, after) -> string[] | null`
- Produces: `TabOrder.reorderRecords(records, orderedIds) -> object[] | null`
- Produces: `TabOrder.upsertRecord(records, record) -> object[] | null`
- Produces: `window.api.reorderTabs(sessionIds) -> Promise<boolean>`
- Consumes: the existing `settings.get('openTabs')` / `settings.set('openTabs', records)` store.

- [ ] **Step 1: Write failing ordering tests**

Add this block near the start of the existing `app.on('ready', async () => { ... })` body in `test/main.js`:

```js
  const TabOrder = require(path.join(ROOT, 'renderer/tab-order'));
  console.log('== flikordning ==');
  ok('flyttar fore malet',
    JSON.stringify(TabOrder.move(['a', 'b', 'c'], 'c', 'a', false)) === JSON.stringify(['c', 'a', 'b']));
  ok('flyttar efter malet',
    JSON.stringify(TabOrder.move(['a', 'b', 'c'], 'a', 'b', true)) === JSON.stringify(['b', 'a', 'c']));
  ok('samma plats ar no-op', TabOrder.move(['a', 'b', 'c'], 'a', 'b', false) === null);
  ok('okand flik avvisas', TabOrder.move(['a', 'b'], 'x', 'a', false) === null);

  const records = [
    { session: 'a1', cwd: '/a', name: 'A1', agentSession: 'conv-a1' },
    { session: 'b1', cwd: '/b', name: 'B1' },
    { session: 'a2', cwd: '/a', name: 'A2' },
  ];
  const reordered = TabOrder.reorderRecords(records, ['a2', 'a1']);
  ok('ordnar bara projektets poster',
    reordered.map((r) => r.session).join(',') === 'a2,b1,a1',
    reordered.map((r) => r.session).join(','));
  ok('dubbletter avvisas', TabOrder.reorderRecords(records, ['a1', 'a1']) === null);
  ok('okand session avvisas', TabOrder.reorderRecords(records, ['a1', 'x']) === null);

  const updated = TabOrder.upsertRecord(records, { session: 'a1', name: 'Nytt namn' });
  ok('uppdatering behaller plats', updated[0].session === 'a1' && updated[1].session === 'b1');
  ok('uppdatering behaller metadata', updated[0].agentSession === 'conv-a1');
  ok('ny post laggs sist', TabOrder.upsertRecord(records, { session: 'c1' })[3].session === 'c1');
```

- [ ] **Step 2: Run the suite and confirm the red state**

Run:

```bash
npm test
```

Expected: FAIL because `renderer/tab-order.js` cannot be required.

- [ ] **Step 3: Implement the pure ordering module**

Create `renderer/tab-order.js` with a browser/CommonJS wrapper and these rules:

```js
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TabOrder = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function validIds(ids) {
    return Array.isArray(ids)
      && ids.every((id) => typeof id === 'string' && id)
      && new Set(ids).size === ids.length;
  }

  function move(ids, movingId, targetId, after) {
    if (!validIds(ids) || movingId === targetId
      || !ids.includes(movingId) || !ids.includes(targetId)) return null;
    const next = ids.filter((id) => id !== movingId);
    const target = next.indexOf(targetId);
    next.splice(target + (after ? 1 : 0), 0, movingId);
    return next.every((id, i) => id === ids[i]) ? null : next;
  }

  function reorderRecords(records, orderedIds) {
    if (!Array.isArray(records) || !validIds(orderedIds)) return null;
    const bySession = new Map(records.map((record) => [record && record.session, record]));
    if (orderedIds.some((id) => !bySession.has(id))) return null;
    let nextOrdered = 0;
    const ordered = new Set(orderedIds);
    return records.map((record) => ordered.has(record.session)
      ? bySession.get(orderedIds[nextOrdered++])
      : record);
  }

  function upsertRecord(records, record) {
    if (!Array.isArray(records) || !record || typeof record.session !== 'string' || !record.session) return null;
    const next = records.slice();
    const index = next.findIndex((item) => item && item.session === record.session);
    if (index < 0) next.push({ ...record });
    else next[index] = { ...next[index], ...record };
    return next;
  }

  return { move, reorderRecords, upsertRecord };
});
```

Load it before `renderer.js` in `renderer/index.html`:

```html
  <script src="tab-order.js"></script>
  <script src="renderer.js"></script>
```

- [ ] **Step 4: Run the suite and confirm the pure seam is green**

Run:

```bash
npm test
```

Expected: the new `== flikordning ==` assertions print `ok` and the process exits 0.

- [ ] **Step 5: Wire persistence through main and preload**

Require the shared module near the other local modules in `main.js`:

```js
const tabOrder = require('./renderer/tab-order');
```

Replace `rememberTab()` with position-preserving upsert behavior:

```js
function rememberTab(rec) {
  const next = tabOrder.upsertRecord(openTabs(), rec);
  if (next) settings.set('openTabs', next);
}
```

Register this handler beside the other `tabs:*` handlers:

```js
  ipcMain.handle('tabs:reorder', (event, sessions) => {
    const next = tabOrder.reorderRecords(openTabs(), sessions);
    if (!next) return false;
    try {
      settings.set('openTabs', next);
      return true;
    } catch (_) {
      return false;
    }
  });
```

Change restore's `done()` helper so persisted records retain array order and only orphans are sorted:

```js
    const done = (keep, orphans) => resolve([
      ...keep,
      ...orphans.sort((a, b) => a.session.localeCompare(b.session)),
    ].map((r) => ({ ...r, primary: primary(r) })));
```

Expose the handler in `preload.js`:

```js
  reorderTabs: (sessions) => ipcRenderer.invoke('tabs:reorder', sessions),
```

- [ ] **Step 6: Verify persistence wiring**

Run:

```bash
npm test
git diff --check
```

Expected: `npm test` exits 0 and `git diff --check` prints nothing.

- [ ] **Step 7: Commit the persistent ordering seam**

```bash
git add renderer/tab-order.js renderer/index.html main.js preload.js test/main.js
git commit -m "feat: persist project tab order"
```

### Task 2: Add native drag-and-drop to the session strip

**Files:**
- Modify: `renderer/tab-order.js`
- Modify: `renderer/renderer.js:25-48,68-82,755-803,1053-1074,1274-1304`
- Modify: `renderer/styles.css:482-551`
- Modify: `test/main.js` in the `== flikordning ==` block.

**Interfaces:**
- Consumes: `TabOrder.move(ids, movingId, targetId, after)` from Task 1.
- Produces: `TabOrder.afterMidpoint(pointerX, left, width) -> boolean | null`.
- Consumes: `window.api.reorderTabs(sessionIds) -> Promise<boolean>` from Task 1.

- [ ] **Step 1: Add failing drop-position tests**

Append to the `== flikordning ==` block:

```js
  ok('vanster halva placerar fore', TabOrder.afterMidpoint(109, 100, 20) === false);
  ok('hoger halva placerar efter', TabOrder.afterMidpoint(111, 100, 20) === true);
  ok('ogiltig bredd avvisas', TabOrder.afterMidpoint(100, 100, 0) === null);
```

- [ ] **Step 2: Run the suite and confirm the red state**

Run:

```bash
npm test
```

Expected: FAIL because `TabOrder.afterMidpoint` is not defined.

- [ ] **Step 3: Implement drop-side calculation**

Add this function to `renderer/tab-order.js` and export it:

```js
  function afterMidpoint(pointerX, left, width) {
    if (![pointerX, left, width].every(Number.isFinite) || width <= 0) return null;
    return pointerX >= left + width / 2;
  }

  return { move, reorderRecords, upsertRecord, afterMidpoint };
```

- [ ] **Step 4: Run the focused public-seam tests**

Run:

```bash
npm test
```

Expected: all `== flikordning ==` assertions print `ok` and the process exits 0.

- [ ] **Step 5: Make renderer ordering explicit**

Add `const tabOrder = [];` beside `tabs`, append every new ID in `buildTab()`, and remove an ID in `closeTab()`:

```js
const tabs = new Map();      // id -> session record
const tabOrder = [];         // ids in user-selected order

function sessionsOf(cwd) {
  return tabOrder.map((id) => tabs.get(id)).filter((t) => t && t.projectCwd === cwd);
}
```

After `tabs.set(id, rec)`:

```js
  tabOrder.push(id);
```

After `tabs.delete(id)`:

```js
  const orderIndex = tabOrder.indexOf(id);
  if (orderIndex >= 0) tabOrder.splice(orderIndex, 1);
```

Build the tray snapshot from `tabOrder.map((id) => tabs.get(id)).filter(Boolean)` so its session order matches the strip.

- [ ] **Step 6: Add the project-scoped reorder operation**

Add renderer helpers immediately before `buildTab()`:

```js
let draggedTabId = null;

function clearTabDrop() {
  for (const el of strip.querySelectorAll('.drop-before, .drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

function reorderProjectTab(movingId, targetId, after) {
  const moving = tabs.get(movingId);
  const target = tabs.get(targetId);
  if (!moving || !target || moving.projectCwd !== target.projectCwd) return false;
  const mine = sessionsOf(moving.projectCwd).map((tab) => tab.id);
  const reordered = window.TabOrder.move(mine, movingId, targetId, after);
  if (!reordered) return false;

  const mineSet = new Set(mine);
  let next = 0;
  for (let i = 0; i < tabOrder.length; i++) {
    if (mineSet.has(tabOrder[i])) tabOrder[i] = reordered[next++];
  }
  if (activeCwd === moving.projectCwd) renderStrip();
  syncTray();

  const sessions = sessionsOf(moving.projectCwd).map((tab) => tab.session);
  if (sessions.length === reordered.length && sessions.every(Boolean)) {
    window.api.reorderTabs(sessions).catch(() => {});
  }
  return true;
}
```

- [ ] **Step 7: Wire native drag events on each session tab**

In `buildTab()`, make only real session tab elements draggable and add these listeners. The existing Overview and `+` elements are recreated by `renderStrip()` and never receive this wiring.

```js
  tabEl.draggable = true;
  tabEl.addEventListener('dragstart', (e) => {
    draggedTabId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-tabdesk-tab', id);
    tabEl.classList.add('dragging');
  });
  tabEl.addEventListener('dragover', (e) => {
    if (!draggedTabId || draggedTabId === id) return;
    const moving = tabs.get(draggedTabId);
    const target = tabs.get(id);
    if (!moving || !target || moving.projectCwd !== target.projectCwd) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearTabDrop();
    const rect = tabEl.getBoundingClientRect();
    const after = window.TabOrder.afterMidpoint(e.clientX, rect.left, rect.width);
    if (after !== null) tabEl.classList.add(after ? 'drop-after' : 'drop-before');
  });
  tabEl.addEventListener('drop', (e) => {
    if (!draggedTabId) return;
    e.preventDefault();
    const rect = tabEl.getBoundingClientRect();
    const after = window.TabOrder.afterMidpoint(e.clientX, rect.left, rect.width);
    if (after !== null) reorderProjectTab(draggedTabId, id, after);
    clearTabDrop();
  });
  tabEl.addEventListener('dragend', () => {
    tabEl.classList.remove('dragging');
    draggedTabId = null;
    clearTabDrop();
  });
```

During implementation, verify that starting a drag on the pin or close button does not trigger tab dragging. If Chromium promotes the parent `.stab` to the drag source, set `tabEl.draggable` from a `pointerdown` guard and restore it on `pointerup`; do not add a separate drag handle unless this concrete conflict occurs.

- [ ] **Step 8: Add insertion and drag styling**

Add after the `.stab.focused` rule in `renderer/styles.css`:

```css
.stab.dragging { opacity: .55; }
.stab.drop-before { box-shadow: inset 2px 0 var(--accent-2); }
.stab.drop-after { box-shadow: inset -2px 0 var(--accent-2); }
```

Keep the focused border and state-dot rules unchanged.

- [ ] **Step 9: Run final automated verification**

First confirm no competing heavy test/build process, then run the project suite alone:

```bash
pgrep -af 'esbuild|rollup|webpack|vite|gradle|jest|vitest|pest' || true
npm test
git diff --check
```

Expected: `npm test` exits 0; `git diff --check` prints nothing. Electron GPU initialization warnings are non-fatal only when the suite still exits 0.

- [ ] **Step 10: Perform the read-only scope pass**

Review the task diff against the approved design. Remove no files and make no unrelated refactors. The expected file set is:

```text
renderer/tab-order.js
renderer/index.html
renderer/renderer.js
renderer/styles.css
main.js
preload.js
test/main.js
```

The two design/plan documents are workflow artifacts and remain separate commits.

- [ ] **Step 11: Commit the renderer interaction**

```bash
git add renderer/tab-order.js renderer/renderer.js renderer/styles.css test/main.js
git commit -m "feat: reorder project session tabs"
```

- [ ] **Step 12: Apply and verify without killing TabDesk**

After integration approval and FF-push, fast-forward the root `main` mirror. Because `main.js` and `preload.js` changed, use only TabDesk's update-window Restart control (`update:restart` calls `app.relaunch()` then quit). Confirm the relaunched main process start time is newer than `main.js` and `preload.js`:

```bash
pgrep -af tabdesk
stat -c '%y %n' main.js preload.js renderer/renderer.js
TABDESK_MAIN_PID=$(pgrep -o -f 'node ./node_modules/.bin/electron \\.')
test -n "$TABDESK_MAIN_PID"
ps -o lstart= -p "$TABDESK_MAIN_PID"
```

Then drag one session before and after a sibling in the same project, confirm Overview and `+` stay fixed, reload the renderer, and confirm the order remains. Restart once more through the app and confirm the same order is restored. Do not kill the process; tmux sessions must survive throughout.
