# Project File Browser and Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user open `Filer` for any main-admitted TabDesk project, lazily browse its project/worktree roots, edit one eligible UTF-8 file in CodeMirror, and save without exposing arbitrary filesystem access or losing local changes.

**Architecture:** A main-process `project-files` module owns admission, opaque root identities, Git worktree verification, path/symlink containment, Git-ignore decisions, document revisions, atomic writes, and watcher normalization. Preload exposes only semantic operations. A bundled renderer file-view module owns the tree and conflict flow, while a separate CodeMirror module owns editor mechanics; a small pure state reducer keeps document transitions testable without Electron or a DOM.

**Tech Stack:** Electron 31 / Chromium 126, Node.js CommonJS in main, classic browser JavaScript in the existing renderer, CodeMirror 6, esbuild, Chokidar 3, Git `check-ignore`, Node's built-in test runner plus the existing Electron `npm test` harness.

## Global Constraints

- Implement only the approved design in `docs/superpowers/specs/2026-08-11-project-file-browser-editor-design.md`.
- `Filer` is a project-strip special view beside `Översikt`; it is not an overlay, dock, file manager, or IDE.
- Read and edit existing UTF-8 text files only. Do not add create, rename, move, delete, project search, Git UI, autocomplete, diagnostics, formatting, or multiple editor tabs.
- Renderer possession of a project path is not authorization. Every filesystem request uses a main-issued opaque project ID, opaque root ID, and validated POSIX-style relative path.
- Never return an absolute target path or raw system error to the renderer. `.git` and aliases/symlinks that resolve into it remain inaccessible.
- Symlinks are usable only when their current real target stays inside the currently selected real root. Revalidate on every operation and immediately before replacement.
- Files are at most 5 MiB. Preserve UTF-8 BOM, dominant line endings, trailing-newline behavior, and mode. A save must compare an opaque exact-byte revision and atomically replace only an existing file.
- Git-ignored entries are hidden by default through Git's own batched `check-ignore`; do not reuse `sync/manifest.js`'s intentionally partial matcher.
- Dirty/conflicted content is never silently discarded. Root, file, project, and special-view navigation all pass through the same explicit discard guard.
- The generated editor bundle is local, single-file, and CSP-compatible. Do not add a CDN, runtime chunks, Node integration, worker URLs, or a CSP exception.
- Keep `renderer/renderer.js` as coordinator only. Filesystem rules stay in `project-files`; CodeMirror details stay in `renderer/files/editor.js`.
- Use explicit path staging. Do not stage the primary checkout's unrelated `graphify-out/` or `.superpowers/` artifacts.
- Do not drive, reload, restart, click, or type in the guard-managed TabDesk window. UI verification uses only an isolated test instance.
- Do not push. A push remains a separate integration event requiring immediate explicit approval.

---

### Task 1: Admit projects and issue verified opaque roots

**Files:**
- Create: `project-files/index.js`
- Create: `test/project-files.test.js`

**Interfaces:**
- Produces: `createProjectFiles(options?) -> ProjectFiles`
- Produces: `ProjectFiles.admitProject(projectPath, source) -> { ok, projectId } | { ok: false, error }`
- Produces: `ProjectFiles.replaceAdmissions(source, projectPaths) -> void`
- Produces: `ProjectFiles.admitSelection(selectedPath, source) -> Promise<{ ok, projectPath, selectedPath } | ErrorResult>`
- Produces: `ProjectFiles.openProject(projectPath) -> Promise<{ ok, projectId, roots } | ErrorResult>`
- Produces: `ProjectFiles.describeWorktrees(projectPath) -> Promise<Array<{ name, path }>>` for main-process callers only.
- Root descriptors crossing IPC are exactly `{ id, kind: 'project' | 'worktree', label }`; they contain no absolute path.

- [ ] **Step 1: Write the red admission and root tests**

Create `test/project-files.test.js` with Node's built-in test runner. Start with a reusable temporary fixture and these concrete cases:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createProjectFiles } = require('../project-files');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-files-'));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  return { base, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('only an admitted project can be opened', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const files = createProjectFiles();
  assert.equal((await files.openProject(fx.project)).error, 'project-unavailable');
  assert.equal(files.admitProject(fx.project, 'configured').ok, true);
  const opened = await files.openProject(fx.project);
  assert.equal(opened.ok, true);
  assert.match(opened.projectId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(opened.roots.map(({ kind, label }) => ({ kind, label })), [
    { kind: 'project', label: 'project' },
  ]);
  assert.equal(Object.hasOwn(opened.roots[0], 'path'), false);
});

test('replaceAdmissions revokes paths no longer owned by that source', async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const files = createProjectFiles();
  files.replaceAdmissions('configured', [fx.project]);
  assert.equal((await files.openProject(fx.project)).ok, true);
  files.replaceAdmissions('configured', []);
  assert.equal((await files.openProject(fx.project)).error, 'project-unavailable');
});
```

Add a real Git fixture: initialize and commit the project, ignore `.worktrees/`, create `.worktrees/topic` with `git worktree add`, and assert it is offered after the project root. Also create a plain directory under `.worktrees/fake` and assert it is excluded. Add a symlinked admitted project and assert that its logical spelling is accepted while an unadmitted real-path spelling is rejected.

- [ ] **Step 2: Confirm the missing module is red**

Run:

```bash
node --test test/project-files.test.js
```

Expected: non-zero exit because `../project-files` does not exist.

- [ ] **Step 3: Create the admission registry**

Implement `project-files/index.js` as a factory, not a singleton, so tests can inject I/O later. Keep logical spelling and real identity separately:

```js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const SOURCES = new Set(['configured', 'picker', 'restored']);

function safeDirectory(io, dir) {
  if (typeof dir !== 'string' || !dir) return null;
  const logical = path.resolve(dir);
  try {
    if (!io.statSync(logical).isDirectory()) return null;
    return { logical, real: io.realpathSync(logical) };
  } catch (_) {
    return null;
  }
}

function createProjectFiles(options = {}) {
  const io = options.fs || fs;
  const run = options.execFile || childProcess.execFile;
  const byPath = new Map();
  const byId = new Map();

  function admitProject(projectPath, source) {
    if (!SOURCES.has(source)) return { ok: false, error: 'project-unavailable' };
    const dir = safeDirectory(io, projectPath);
    if (!dir) return { ok: false, error: 'project-unavailable' };
    let project = byPath.get(dir.logical);
    if (!project || project.real !== dir.real) {
      if (project) byId.delete(project.id);
      project = {
        id: crypto.randomUUID(), logical: dir.logical, real: dir.real,
        sources: new Set(), rootsByKey: new Map(), rootsById: new Map(),
      };
      byPath.set(dir.logical, project);
      byId.set(project.id, project);
    }
    project.sources.add(source);
    return { ok: true, projectId: project.id };
  }

  function replaceAdmissions(source, paths) {
    if (!SOURCES.has(source)) return;
    for (const project of byPath.values()) project.sources.delete(source);
    for (const projectPath of paths || []) admitProject(projectPath, source);
    for (const [logical, project] of byPath) {
      if (project.sources.size) continue;
      byPath.delete(logical);
      byId.delete(project.id);
    }
  }

  return { admitProject, replaceAdmissions };
}

module.exports = { createProjectFiles };
```

Use the injected `io` consistently in the finished module; the snippet only fixes the state shape.

- [ ] **Step 4: Verify actual Git worktree membership**

Add a promise wrapper around non-shell `execFile` and resolve Git identity with:

```bash
git -C projectPath rev-parse --path-format=absolute --git-common-dir
```

Realpath the returned common directory. A convention-folder candidate is a worktree only when its common Git directory equals the admitted project's common Git directory. Discover direct, non-dot children under `.worktrees/` and `.claude/worktrees/`, de-duplicate by real path, and sort by label. Never treat convention-folder placement alone as authority.

`admitSelection(selectedPath, source)` must return the owning project only when the selected worktree passes that same common-directory comparison. Otherwise admit exactly the selected directory; do not broaden a native-dialog selection to a parent merely because its spelling contains `/.worktrees/`.

- [ ] **Step 5: Preserve root IDs while identities stay valid**

When `openProject()` refreshes roots, key each internal root by `${logical}\0${real}`. Reuse its UUID while both spellings remain identical, remove IDs for vanished/repointed roots, and return only the safe descriptor:

```js
function publicRoot(root) {
  return { id: root.id, kind: root.kind, label: root.label };
}
```

Re-realpath the admitted project's logical spelling before every root refresh. If it no longer equals the admitted real path, revoke it and return `project-unavailable`.

- [ ] **Step 6: Run the root tests green and commit**

Run:

```bash
node --test test/project-files.test.js
git diff --check
```

Expected: every admission/root test passes; `git diff --check` prints nothing.

Commit only these paths:

```bash
git add project-files/index.js test/project-files.test.js
git commit -m "feat: authorize project file roots"
```

### Task 2: List lazy directories with containment and Git-ignore semantics

**Files:**
- Modify: `project-files/index.js`
- Modify: `test/project-files.test.js`

**Interfaces:**
- Produces: `ProjectFiles.list({ projectId, rootId, directory, showIgnored }) -> Promise<ListResult>`
- `ListResult.entries[]` is `{ name, path, kind, hidden, ignored, symlink, unavailable }`.
- Relative paths use `/` regardless of host path separator. Root listing alone may use `directory: ''`.

- [ ] **Step 1: Add failing path, symlink, sorting, and ignore tests**

Extend the fixture and assert all of the following before implementation:

```js
const opened = await files.openProject(fx.project);
const ids = { projectId: opened.projectId, rootId: opened.roots[0].id };

assert.equal((await files.list({ ...ids, directory: '../outside' })).error, 'invalid-path');
assert.equal((await files.list({ ...ids, directory: '/etc' })).error, 'invalid-path');
assert.equal((await files.list({ ...ids, directory: 'a\\b' })).error, 'invalid-path');
assert.equal((await files.list({ ...ids, directory: 'a\0b' })).error, 'invalid-path');
assert.equal((await files.list({ ...ids, directory: '.git' })).error, 'git-metadata-denied');
```

Create directories, ordinary files, dotfiles, an internal file symlink, an internal directory symlink, an external symlink, a broken symlink, and a symlink into `.git`. Assert:

- directories sort before files, then by `localeCompare` display name;
- dotfiles appear but `.git` and a symlink into `.git` do not;
- internal links report `symlink: true` and remain usable;
- external/broken links remain visible with `unavailable: 'outside-root'` or `'unreadable'` and cannot be traversed;
- changing an internal symlink to an external target between two calls is caught by the second call.

Initialize Git with nested ignore rules and a negation. Track one file that a later ignore rule matches. Assert ignored untracked entries are omitted by default, appear with `ignored: true` when `showIgnored: true`, and the tracked match stays visible.

- [ ] **Step 2: Confirm listing is red**

Run:

```bash
node --test test/project-files.test.js
```

Expected: failures because `files.list` is not implemented.

- [ ] **Step 3: Implement one canonical relative-path parser**

Add a single parser used by list, read, write, and watch code. Do not duplicate validation in IPC:

```js
function relativeParts(value, { root = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\')) return null;
  if ((!root && !value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  if (value && (value.endsWith('/') || value.includes('//'))) return null;
  const parts = value ? value.split('/') : [];
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts;
}
```

Before touching an entry, validate the root ID still belongs to the project ID, re-realpath the root, and for a worktree re-check its Git common-directory relationship. Resolve the logical candidate, then require its real target to be the real root itself or a descendant using `path.relative()` rather than a string prefix.

Reject any logical or real relative component named `.git`. A direct `.git` child or an alias resolving into Git metadata is omitted from a parent listing and returns `git-metadata-denied` when directly requested.

- [ ] **Step 4: Implement safe entry inspection**

Use `lstat` to preserve symlink presentation and `realpath` + `stat` to classify the current target. Return safe flags only; do not include `logicalRoot`, `realRoot`, resolved target, errno, or stack.

For a broken/external link, return a disabled entry rather than dropping it. For sockets, devices, and other non-file/non-directory types, return `kind: 'other'` with `unavailable: 'not-file'`.

- [ ] **Step 5: Batch Git ignore checks without a shell**

For each directory listing, send all candidate relative paths in one NUL-delimited buffer:

```bash
git -C selectedRootPath check-ignore --stdin -z
```

Do not pass `--no-index`: tracked files that match a later ignore pattern must remain visible. Exit code 1 means “no matches.” A non-Git selected root has no Git-ignored entries. Parse NUL-delimited output into a `Set`, annotate all entries, then filter only when `showIgnored` is false. Directory lazy loading remains the defense against eager dependency-tree traversal.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
node --test test/project-files.test.js
git diff --check
```

Expected: path, sorting, symlink, `.git`, and ignore cases all pass.

```bash
git add project-files/index.js test/project-files.test.js
git commit -m "feat: list safe project directories"
```

### Task 3: Read and atomically write versioned UTF-8 documents

**Files:**
- Create: `project-files/document.js`
- Modify: `project-files/index.js`
- Modify: `test/project-files.test.js`

**Interfaces:**
- Produces: `ProjectFiles.read({ projectId, rootId, path }) -> Promise<ReadResult>`
- Produces: `ProjectFiles.write({ projectId, rootId, path, content, expectedRevision, overwrite }) -> Promise<WriteResult>`
- `ReadResult` is `{ ok, path, content, revision, ignored, language, format: { bom, lineEnding, trailingNewline } }`.
- `WriteResult` is `{ ok, revision }` or a stable typed error. `overwrite: true` still requires an existing eligible target.
- Internal: `readDocument(target)` and `writeDocument(target, request, options?)` use the already-contained real target.

- [ ] **Step 1: Add failing document-format and eligibility tests**

Test ordinary UTF-8, unknown extension, BOM, LF, CRLF, CR-only, mixed endings with a clear dominant style, with/without final newline, invalid UTF-8, embedded NUL, a directory, a FIFO or other non-regular entry where supported, an unreadable file, an over-5-MiB file, and deletion between list and read.

Use exact expectations such as:

```js
assert.deepEqual((await files.read({ ...ids, path: 'crlf.txt' })).format, {
  bom: false,
  lineEnding: '\r\n',
  trailingNewline: true,
});
assert.equal((await files.read({ ...ids, path: 'bad.bin' })).error, 'not-text');
assert.equal((await files.read({ ...ids, path: 'large.txt' })).error, 'too-large');
```

The content returned to CodeMirror is normalized to `\n`; format metadata records how to serialize it back.

- [ ] **Step 2: Add failing revision and atomic-write tests**

Cover:

- successful edit while retaining mode, BOM, CRLF, and the original final-newline convention;
- stale `expectedRevision` returning `conflict` without touching the file;
- `overwrite: true` accepting the current revision but still rejecting a missing file;
- output larger than 5 MiB rejected before temp creation;
- a test-injected change after temp flush but before final revision check returning `conflict` and cleaning the temp;
- internal symlink writes changing its in-root target without replacing the symlink;
- retargeting that symlink outside the root immediately before write returning `outside-root`.

- [ ] **Step 3: Confirm document operations are red**

Run:

```bash
node --test test/project-files.test.js
```

Expected: failures because `read` and `write` are not implemented.

- [ ] **Step 4: Implement strict reads and exact-byte revisions**

In `project-files/document.js`, use `TextDecoder` with fatal UTF-8 decoding and reject NUL-bearing decoded text. Hash the exact original bytes:

```js
const MAX_BYTES = 5 * 1024 * 1024;

function revision(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decode(bytes) {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch (_) { return { ok: false, error: 'not-text' }; }
  if (raw.includes('\0')) return { ok: false, error: 'not-text' };
  const counts = [
    ['\r\n', (raw.match(/\r\n/g) || []).length],
    ['\n', (raw.match(/(?<!\r)\n/g) || []).length],
    ['\r', (raw.match(/\r(?!\n)/g) || []).length],
  ];
  const lineEnding = counts.sort((a, b) => b[1] - a[1])[0][1]
    ? counts[0][0]
    : '\n';
  return {
    ok: true,
    content: raw.replace(/\r\n?/g, '\n'),
    format: { bom, lineEnding, trailingNewline: /(?:\r\n|\r|\n)$/.test(raw) },
  };
}
```

Read no more than `MAX_BYTES + 1`, require a regular file, and map access errors to `permission-denied`, deletion to `deleted`, and other safe failures to `unreadable`.

- [ ] **Step 5: Implement same-directory atomic replacement**

Serialize normalized editor text with the recorded line-ending style and BOM. Natural editor content retains whether a final line break is present; tests edit inside the document to prove the existing convention survives unchanged.

The write order is mandatory:

1. re-resolve containment and require the target to exist and be a regular file;
2. read exact current bytes and compare their revision unless `overwrite` selected the current revision as the base;
3. encode and size-check before creating a temp file;
4. create a randomized same-directory temp with `wx` and the source mode;
5. write all bytes, `fsync`, and close;
6. run the injectable `beforeReplace` test hook;
7. re-read and compare the target revision again;
8. rename temp over the verified real target;
9. return the revision of the exact bytes written;
10. unlink only that exact temp path on every failure.

Use an internal temp spelling containing `.tabdesk-` so the watcher can suppress it later. Never recreate a deleted target, even for overwrite.

- [ ] **Step 6: Delegate only contained real targets from the public module**

`project-files/index.js` must resolve/revalidate first and pass the resulting contained real target into `document.js`. `write()` accepts only string content, a hex revision, and boolean overwrite. It computes `ignored` through the same Git helper used by listing and returns a filename-derived language hint without making language support a filesystem concern.

- [ ] **Step 7: Run document tests and commit**

```bash
node --test test/project-files.test.js
git diff --check
git status --short
```

Expected: all document and prior tests pass; no `.tabdesk-*.tmp` fixture file survives.

```bash
git add project-files/document.js project-files/index.js test/project-files.test.js
git commit -m "feat: save versioned project files"
```

### Task 4: Normalize and clean up one active root watcher

**Files:**
- Create: `project-files/watch.js`
- Modify: `project-files/index.js`
- Modify: `test/project-files.test.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `ProjectFiles.watch(ownerId, { projectId, rootId }, emit) -> Promise<{ ok } | ErrorResult>`
- Produces: `ProjectFiles.unwatch(ownerId) -> void`
- Produces: `ProjectFiles.close() -> void`
- Emits: `{ projectId, rootId, path, kind }`, where kind is `added`, `changed`, `removed`, or `tree-invalidated`.

- [ ] **Step 1: Add deterministic failing watcher tests**

Inject a fake `watchFactory` backed by `EventEmitter` rather than sleeping on real filesystem timing. Assert:

- `add`, `change`, and `unlink` coalesce per relative path within the debounce window;
- `addDir` and `unlinkDir` become `tree-invalidated`;
- `.git/**`, paths outside the root, and `.tabdesk-` temporary files never emit;
- starting a second root for the same `ownerId` closes the first watcher;
- two concurrent watch requests resolving out of order leave only the newest requested root active;
- `unwatch(ownerId)` and `close()` close watchers and cancel pending timers;
- emitted events contain no absolute path;
- root deletion or Chokidar error reports `watch-failed` through the safe result/event path.

Use an injected scheduler or a 0-ms debounce in tests so the suite remains deterministic.

- [ ] **Step 2: Confirm watcher behavior is red**

```bash
node --test test/project-files.test.js
```

Expected: failures because watcher methods do not exist.

- [ ] **Step 3: Implement the watcher adapter**

Create `project-files/watch.js` around the existing Chokidar dependency:

```js
const chokidar = require('chokidar');

function createRootWatcher(root, emit, options = {}) {
  const watchFactory = options.watchFactory || chokidar.watch;
  const watcher = watchFactory(root.logical, {
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    ignored: (absolute) => blockedWatchPath(root, absolute),
  });
  // Map raw events, debounce by normalized relative path, and expose close().
}
```

`blockedWatchPath` must use path containment plus component checks; it must not rely on a substring such as `includes('.git')`. `followSymlinks: false` prevents Chokidar from traversing external targets, but each emitted hint is still normalized and revalidated before crossing IPC.

- [ ] **Step 4: Own watcher lifecycle in `project-files/index.js`**

Keep exactly one watcher per renderer owner ID. Give each owner a monotonically increasing request token: `watch()` revalidates the selected root, then installs it only if its token is still current; a stale candidate closes itself. `unwatch()` increments that token before closing the active watcher, so an older in-flight request cannot resurrect itself. Cleanup is idempotent. A watcher event is only a hint; it never contains file content or grants a later read.

- [ ] **Step 5: Add Node tests to the project verifier**

Change `package.json` now, before CodeMirror is introduced:

```json
"test": "node --test test/project-files.test.js && electron test/main.js"
```

First check for competing heavy jobs, then run the project's verifier:

```bash
pgrep -af 'esbuild|rollup|webpack|vite|gradle|jest|vitest|pest' || true
npm test
git diff --check
```

Expected: Node watcher/filesystem tests and the existing Electron assertions exit 0 with no `FAIL` lines.

- [ ] **Step 6: Commit the complete main-process seam**

```bash
git add project-files/watch.js project-files/index.js test/project-files.test.js package.json
git commit -m "feat: watch active project roots"
```

### Task 5: Wire main-owned admissions through IPC and preload

**Files:**
- Modify: `main.js`
- Modify: `preload.js`
- Modify: `project-files/index.js`
- Modify: `test/project-files.test.js`

**Interfaces:**
- Produces: `window.api.openProjectFiles(projectPath)`
- Produces: `window.api.listProjectFiles(args)`
- Produces: `window.api.readProjectFile(args)`
- Produces: `window.api.writeProjectFile(args)`
- Produces: `window.api.watchProjectFiles(args)` / `window.api.unwatchProjectFiles()`
- Produces: `window.api.onProjectFilesChanged(callback) -> unsubscribe`
- IPC channels are `project-files:open|list|read|write|watch|unwatch` and `project-files:changed`.

- [ ] **Step 1: Add lifecycle regression tests at the module seam**

Before main wiring, add tests proving that an already-issued project/root ID stops working after its admission is revoked, a project symlink is rejected after retargeting, and a worktree root ID is rejected after the checkout is removed or belongs to another repository. Every operation—not just `openProject()`—must return `project-unavailable` or `root-unavailable` after invalidation.

- [ ] **Step 2: Instantiate one project-files service in main**

Require the factory with the other local modules and create one process-lifetime service:

```js
const { createProjectFiles } = require('./project-files');
const projectFiles = createProjectFiles();
```

The renderer never imports this module. Main-only admission methods must not be exposed through preload.

- [ ] **Step 3: Make configured project listing the configured admission source**

Convert `ipcMain.handle('projects:list', ...)` to an async handler. Build the root/child rows first, then:

```js
projectFiles.replaceAdmissions('configured', rows.map((row) => row.path));
await Promise.all(rows.map(async (row) => {
  const worktrees = await projectFiles.describeWorktrees(row.path);
  row.worktrees = worktrees.map((worktree) => ({
    ...worktree,
    model: model.getFor(worktree.path, agents.getFor(worktree.path)),
  }));
}));
```

Remove the old `worktreesIn()` convention-only implementation. The existing picker and strip keep receiving absolute worktree paths because they are trusted main-renderer UI; the new file IPC still returns only opaque root descriptors.

When `applyRoot()` changes the projects folder, clear the old `configured` source before reload. The next `projects:list` repopulates it.

- [ ] **Step 4: Admit create, browse, and restored choices at their source**

- After `projects:create` succeeds, call `admitProject(result.path, 'picker')` before returning it.
- In `projects:browse`, pass the exact native-dialog selection through `await projectFiles.admitSelection(dir, 'picker')`. Return `projectPath` in addition to the selected session `path`.
- In `tabs:restore`, pass every surviving main-owned record through `admitSelection(record.cwd, 'restored')`, replace the entire `restored` source from the verified owners, and return each record's verified `projectPath`.
- In renderer startup and new-project selection later, use main's `projectPath` when present; retain `ownerOf()` only for records from older main processes during reload compatibility.

Do not admit paths merely because the renderer asked for `Filer`.

- [ ] **Step 5: Register narrow IPC handlers**

Add handlers together, immediately delegating to the service:

```js
  ipcMain.handle('project-files:open', (_event, projectPath) =>
    projectFiles.openProject(projectPath));
  ipcMain.handle('project-files:list', (_event, args) => projectFiles.list(args));
  ipcMain.handle('project-files:read', (_event, args) => projectFiles.read(args));
  ipcMain.handle('project-files:write', (_event, args) => projectFiles.write(args));
  ipcMain.handle('project-files:watch', (event, args) =>
    projectFiles.watch(event.sender.id, args, (change) => {
      if (!event.sender.isDestroyed()) event.sender.send('project-files:changed', change);
    }));
  ipcMain.handle('project-files:unwatch', (event) => {
    projectFiles.unwatch(event.sender.id);
    return { ok: true };
  });
```

Release the sender's watcher in the existing main-frame `did-start-navigation` cleanup and on `webContents` destruction. Call `projectFiles.close()` from `will-quit`. Cleanup is idempotent.

- [ ] **Step 6: Expose semantic preload methods only**

Add this block to `preload.js`; do not expose `fs`, `path`, absolute-root lookup, a generic invoke function, or raw channel names:

```js
  openProjectFiles: (projectPath) => ipcRenderer.invoke('project-files:open', projectPath),
  listProjectFiles: (args) => ipcRenderer.invoke('project-files:list', args),
  readProjectFile: (args) => ipcRenderer.invoke('project-files:read', args),
  writeProjectFile: (args) => ipcRenderer.invoke('project-files:write', args),
  watchProjectFiles: (args) => ipcRenderer.invoke('project-files:watch', args),
  unwatchProjectFiles: () => ipcRenderer.invoke('project-files:unwatch'),
  onProjectFilesChanged: (cb) => {
    const listener = (_event, change) => cb(change);
    ipcRenderer.on('project-files:changed', listener);
    return () => ipcRenderer.removeListener('project-files:changed', listener);
  },
```

- [ ] **Step 7: Verify main/preload syntax and the full suite**

```bash
node --check main.js
node --check preload.js
pgrep -af 'esbuild|rollup|webpack|vite|gradle|jest|vitest|pest' || true
npm test
git diff --check
```

Expected: syntax checks and both test layers exit 0, with no Electron `FAIL` line.

- [ ] **Step 8: Commit the application boundary**

```bash
git add main.js preload.js project-files/index.js test/project-files.test.js
git commit -m "feat: expose admitted project files"
```

### Task 6: Bundle CodeMirror and implement the pure document state/editor

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `renderer/file-state.js`
- Create: `renderer/files/editor.js`
- Create: `renderer/files-entry.js`
- Generate, do not commit: `renderer/files.bundle.js`
- Create: `test/file-state.test.js`

**Interfaces:**
- Produces: `FileState.initial()`, `FileState.reduce(state, event)`, `FileState.needsDiscard(state)`, and `FileState.createRequestGate()`.
- Produces: `createEditor({ parent, onChange, onSave, theme, label }) -> EditorController`.
- `EditorController` exposes `setDocument`, `getDocument`, `setReadOnly`, `setLanguage`, `setTheme`, `getSelection`, `focus`, and `destroy`.
- Produces one classic-script global bundle: `window.TabDeskFiles`.

- [ ] **Step 1: Write the red state-transition tests**

Create `test/file-state.test.js` and cover every approved transition:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const State = require('../renderer/file-state');

const loading = State.reduce(State.initial(), {
  type: 'open-start', request: 1, path: 'src/app.js',
});
const opened = State.reduce(loading, {
  type: 'open-success', request: 1, path: 'src/app.js',
  content: 'one\n', revision: 'a', ignored: false,
});

test('clean edit becomes dirty and successful save becomes clean', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'two\n' });
  assert.equal(dirty.status, 'dirty');
  assert.equal(State.needsDiscard(dirty), true);
  const saved = State.reduce(dirty, { type: 'save-success', revision: 'b' });
  assert.equal(saved.status, 'clean');
  assert.equal(saved.revision, 'b');
});

test('dirty external change becomes a conflict', () => {
  const dirty = State.reduce(opened, { type: 'edit', content: 'local\n' });
  const conflict = State.reduce(dirty, { type: 'disk-changed', exists: true });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.content, 'local\n');
  assert.equal(conflict.exists, true);
});
```

Also test clean external snapshot auto-reload, clean deletion becoming read-only `deleted`, dirty deletion retaining local text as conflict with `exists: false`, reload/overwrite success, discard, save blocked outside dirty state, stale open-success ignored by request ID, and two request-gate tokens allowing only the newest read/language result.

- [ ] **Step 2: Confirm the state module is red**

```bash
node --test test/file-state.test.js
```

Expected: non-zero exit because `renderer/file-state.js` is missing.

- [ ] **Step 3: Implement the pure UMD/CommonJS reducer**

Follow the existing `renderer/tab-order.js` exposure pattern so Node tests and the bundle share exactly one implementation. Use explicit statuses only:

```js
const STATUSES = new Set(['unopened', 'loading', 'clean', 'dirty', 'conflict', 'deleted', 'error']);

function initial() {
  return {
    status: 'unopened', request: 0, path: null, content: '', diskContent: '',
    revision: null, exists: false, ignored: false, error: null,
  };
}

function needsDiscard(state) {
  return state.status === 'dirty' || state.status === 'conflict';
}

function createRequestGate() {
  let current = 0;
  return {
    next() { current += 1; return current; },
    isCurrent(token) { return token === current; },
    invalidate() { current += 1; },
  };
}
```

`open-success` and `open-failure` must match the current request. `disk-snapshot` replaces only a clean document; dirty/conflicted state retains local content and becomes/remains conflict. `discard` resets the live document while the file-view module separately retains the last successful relative path.

- [ ] **Step 4: Install pinned-compatible CodeMirror/esbuild dependencies without running postinstall yet**

Run the package-manager commands from the task worktree:

```bash
npm install --ignore-scripts @codemirror/commands@^6.10.4 @codemirror/language@^6.12.4 @codemirror/language-data@^6.5.2 @codemirror/search@^6.7.1 @codemirror/state@^6.7.1 @codemirror/view@^6.43.8 @lezer/highlight@^1.2.3
npm install --ignore-scripts --save-dev @electron/asar@^3.4.1 esbuild@^0.28.2
```

These versions are current as of plan authoring and support the pinned Node/Electron baseline. Let npm update `package-lock.json`; do not hand-edit resolved integrity records.

- [ ] **Step 5: Add deterministic bundle scripts**

Update `package.json` scripts to this shape, retaining the existing targets:

```json
"build:editor": "esbuild renderer/files-entry.js --bundle --format=iife --global-name=TabDeskFiles --platform=browser --target=chrome126 --minify --legal-comments=none --outfile=renderer/files.bundle.js",
"postinstall": "electron-rebuild -f -w node-pty && npm run build:editor",
"test": "npm run build:editor && node --test test/project-files.test.js test/file-state.test.js && electron test/main.js",
"dist": "npm run build:editor && electron-builder --linux deb tar.gz"
```

Add only `renderer/files.bundle.js` to `.gitignore`. Source modules and lockfile remain tracked. The build has no `splitting` option, so language lazy-load functions compile into the same IIFE asset rather than runtime chunks.

- [ ] **Step 6: Implement the CodeMirror controller**

In `renderer/files/editor.js`, configure extensions individually rather than importing `basicSetup`:

```js
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, dropCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import {
  LanguageDescription, bracketMatching, defaultHighlightStyle,
  indentOnInput, syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
```

Use three `Compartment`s for language, theme, and editability. Add `Mod-s` ahead of other keymaps with `preventDefault: true` and invoke `onSave`; `search()` plus `searchKeymap` supplies search/replace and `Mod-f`. Include line numbers, history/undo, selection drawing, active-line visibility, indentation, and bracket matching.

`setDocument(content, selection)` dispatches one whole-document change while suppressing the outward edit callback and clamps selection to the new length. `setLanguage(filename)` obtains a request token, calls `LanguageDescription.matchFilename(languages, filename)`, awaits `.load()`, and reconfigures only if its token is still current. Missing/failing language support reconfigures to plain text without blocking editing.

Build `EditorView.theme` from `theme.tokens` (`surface`, `text`, `faint`, `line`, `accent`, `accent-2`, `tint`, `danger`) and use `syntaxHighlighting(defaultHighlightStyle, { fallback: true })`. Theme changes reconfigure the compartment; no stylesheet URL or worker is created.

- [ ] **Step 7: Create the bundle entry and prove one asset builds**

Start `renderer/files-entry.js` as:

```js
export { createEditor } from './files/editor.js';
```

Run:

```bash
npm run build:editor
test -s renderer/files.bundle.js
find renderer -maxdepth 1 -type f -name 'files.bundle*' -printf '%f\n'
node --test test/file-state.test.js
```

Expected: exactly `files.bundle.js` is printed; state tests pass.

- [ ] **Step 8: Run the complete verifier and commit sources, not generated output**

```bash
pgrep -af 'esbuild|rollup|webpack|vite|gradle|jest|vitest|pest' || true
npm test
git diff --check
git status --short
```

Expected: the bundle rebuilds, Node tests pass, Electron tests have no `FAIL`, and `renderer/files.bundle.js` is absent from status because it is ignored.

```bash
git add .gitignore package.json package-lock.json renderer/file-state.js renderer/files/editor.js renderer/files-entry.js test/file-state.test.js
git commit -m "feat: bundle project file editor"
```

### Task 7: Build the lazy file tree and conflict-aware file view

**Files:**
- Create: `renderer/files/view.js`
- Modify: `renderer/files-entry.js`
- Modify: `test/file-state.test.js`

**Interfaces:**
- Produces: `createFileView({ api, t, confirmDiscard, confirmReload, copyText, toast, theme }) -> FileViewController`.
- `FileViewController` exposes `element`, `activate(projectPath)`, `deactivate()`, `canLeave()`, `hasUnsavedChanges()`, `onTheme(theme)`, `onLanguage()`, and `destroy()`.
- Consumes only the semantic preload methods from Task 5 and the `createEditor`/`FileState` modules from Task 6.

- [ ] **Step 1: Extend state tests for navigation and conflict actions**

Add assertions that:

- canceling a dirty guard leaves state and selection unchanged;
- explicit discard clears the live local buffer before navigation;
- changed-file reload applies a newer disk snapshot only after confirmation;
- overwrite is unavailable when `exists` is false;
- copy does not change state;
- stale read results after file/root/project switches are ignored;
- a clean ignored file can remain open when `showIgnored` changes to false.

Keep these as reducer/controller-decision tests; do not mock CodeMirror internals.

- [ ] **Step 2: Create the file-view DOM without integrating it into the grid yet**

`createFileView()` constructs one `.panel.files-panel` with this semantic structure:

```html
<section class="panel files-panel" aria-label="Project files">
  <header class="files-toolbar">
    <label><span class="files-root-label"></span><select class="files-root"></select></label>
    <button class="files-ignored" type="button" aria-pressed="false"></button>
  </header>
  <div class="files-body">
    <nav class="files-tree" role="tree"></nav>
    <section class="files-document">
      <header class="files-document-head">
        <span class="files-path"></span><span class="files-status" role="status"></span>
        <button class="files-save" type="button"></button>
      </header>
      <div class="files-conflict hidden" role="alert"></div>
      <div class="files-editor"></div>
    </section>
  </div>
</section>
```

Create nodes with DOM APIs and `textContent`, not interpolated filenames. Set translated labels on construction and again from `onLanguage()`.

- [ ] **Step 3: Keep per-project in-memory navigation state**

Use a `Map` keyed by the existing rail project spelling. Each value is:

```js
{
  projectId: null,
  roots: [],
  selectedRootId: null,
  showIgnored: false,
  expandedByRoot: new Map(),
  lastFile: null,
}
```

`activate(projectPath)` increments a request gate, calls `openProjectFiles`, selects the remembered root if it still exists, otherwise falls back to the first project root and announces `files.rootGone`. It then starts exactly one watcher and lazy-loads only directory `''`. `deactivate()` invalidates reads/language requests and awaits/best-effort calls `unwatchProjectFiles`, but keeps the map for this renderer lifetime. Serialize watch/unwatch IPC on one controller promise chain so rapid project/root changes cannot let a late unwatch cancel the newest watch.

For a root-selector change, run the dirty guard before committing `selectedRootId`. If the user cancels after the native `<select>` change event, immediately restore the control's previous value. Turning `Visa ignorerade` off rebuilds only the tree; an already open ignored file and its editor buffer stay open with the ignored status text visible.

- [ ] **Step 4: Implement lazy, accessible tree rendering**

Each tree item carries safe data only:

```js
item.dataset.path = entry.path;
item.setAttribute('role', 'treeitem');
if (entry.kind === 'directory') item.setAttribute('aria-expanded', 'false');
else item.removeAttribute('aria-expanded');
item.setAttribute('aria-disabled', entry.unavailable ? 'true' : 'false');
```

Expanding a directory calls `listProjectFiles({ projectId, rootId, directory: entry.path, showIgnored })` once, renders its returned children in a `role="group"`, and records the path in the selected root's expanded set. A listing failure stays under that directory with a Retry button.

Keyboard rules are explicit:

- Up/Down focus previous/next visible treeitem;
- Right expands a collapsed directory or moves to its first child;
- Left collapses an expanded directory or focuses its parent;
- Enter toggles a directory or opens an eligible file;
- Home/End focus the first/last visible item.

Maintain one roving `tabindex="0"`; all other treeitems are `-1`. Unavailable entries remain focusable for their explanation but cannot invoke read.

- [ ] **Step 5: Open one file with stale-response protection**

Before a file/root switch, call the same `canLeave()` guard. On acceptance, dispatch `open-start`, get a new token, call `readProjectFile`, and dispatch success/failure only while project/root/path and token still match. On success:

```js
editor.setDocument(result.content, { anchor: 0, head: 0 });
editor.setReadOnly(false);
editor.setLanguage(result.path);
```

Store `lastFile = { rootId, path }` only after a successful read. Map typed errors to localized messages and never render `result.message`, a stack, or an absolute path.

- [ ] **Step 6: Wire edits, save, and conflict actions**

- Editor changes dispatch `edit` and repaint dirty state.
- Save calls `writeProjectFile` only in `dirty`; `conflict` and `deleted` block it.
- A successful save dispatches `save-success` with the returned revision.
- A save returning `conflict` enters conflict without changing local content; `deleted` enters a non-recreatable deleted conflict; any other typed write error leaves the document dirty and shows its localized message.
- `Ctrl+S` uses the same save function as the toolbar button.
- `Ladda om från disk` confirms, re-reads, and replaces local state.
- `Skriv över med min version` calls write with `overwrite: true` only when the target still exists.
- `Kopiera mina ändringar` calls injected `copyText(state.content)` and leaves state unchanged.
- A clean deletion leaves the last content visible and sets CodeMirror read-only.
- A dirty deletion keeps CodeMirror editable in conflict but offers no overwrite/recreate action.

`canLeave()` is synchronous from the renderer coordinator's perspective: if state is clean it returns true; otherwise it calls `confirmDiscard`, returns false on cancel, and dispatches `discard` on acceptance.

- [ ] **Step 7: Treat watcher messages as hints**

Subscribe once through `onProjectFilesChanged`. Ignore events for inactive/stale project/root IDs. On a relevant tree event, invalidate only loaded affected directories and reload them; do not eagerly walk collapsed branches.

Every file watcher event is only a hint. Re-read the currently open relative path through `readProjectFile` before changing document state and compare the returned exact-byte revision with the state's revision. This deliberately handles an open file reached through an internal symlink: Chokidar may report the target's ordinary in-root spelling rather than the alias spelling. Ignore the hint when the open file's revision is unchanged.

For a changed open file after that re-read:

- clean document plus new revision: dispatch `disk-snapshot`, clamping/restoring editor selection;
- dirty document plus new revision: dispatch `disk-changed` but do not put returned disk content into the editor buffer;
- clean document plus a `deleted` read result: dispatch `disk-deleted` and make the editor read-only;
- dirty document plus a `deleted` read result: dispatch `disk-deleted` and retain editable local content as conflict.

Display `watch-failed` non-modally while leaving manual reopen/save available.

- [ ] **Step 8: Export the complete file view and build**

Update `renderer/files-entry.js`:

```js
export { createFileView } from './files/view.js';
export { createEditor } from './files/editor.js';
```

Run:

```bash
npm run build:editor
node --test test/file-state.test.js
git diff --check
```

Expected: the single bundle builds and all document-state/navigation tests pass.

- [ ] **Step 9: Commit the file-view controller**

```bash
git add renderer/files/view.js renderer/files-entry.js test/file-state.test.js
git commit -m "feat: browse and edit project files"
```

### Task 8: Integrate `Filer` into the project strip and panel grid

**Files:**
- Modify: `renderer/index.html`
- Modify: `renderer/renderer.js`
- Modify: `renderer/styles.css`
- Modify: `i18n/en.json`
- Modify: `i18n/sv.json`
- Modify: `package.json`
- Modify: `test/file-state.test.js`

**Interfaces:**
- Produces: `showFiles(projectPath)` as the renderer coordinator's second special view.
- Consumes: `window.TabDeskFiles.createFileView(...)` from the generated bundle.
- Preserves: current Overview behavior, pinned terminals, strip sessions, preview state, tray selection, native-terminal placement, and grid limit.

- [ ] **Step 1: Add red locale/build-contract checks**

Extend `test/file-state.test.js` to parse `i18n/en.json`, `i18n/sv.json`, and `package.json`. Assert every key beginning `files.` plus `strip.files` exists in both locales, the sets are identical, and `build.files` includes `project-files/**`.

Run:

```bash
node --test test/file-state.test.js
```

Expected: failures because the strings/build allowlist are not present.

- [ ] **Step 2: Load the generated asset under the existing CSP**

In `renderer/index.html`, load the local IIFE after `tab-order.js` and before `renderer.js`:

```html
  <script src="tab-order.js"></script>
  <script src="files.bundle.js"></script>
  <script src="renderer.js"></script>
```

Do not change the CSP. Add `project-files/**` to `package.json`'s `build.files`; `renderer/**` already includes both editor sources and the generated bundle at package time.

- [ ] **Step 3: Instantiate the file view beside Overview**

Immediately after the current Overview panel setup in `renderer/renderer.js`, create the controller and append its element to `#panels`:

```js
const fileView = window.TabDeskFiles.createFileView({
  api: window.api,
  t: (key, vars) => window.t(key, vars),
  confirmDiscard: (path) => window.confirm(window.t('files.discard', { path })),
  confirmReload: (path) => window.confirm(window.t('files.reloadConfirm', { path })),
  copyText: (text) => window.api.copySelection(text),
  toast,
  theme: window.ui.theme,
});
panels.appendChild(fileView.element);
let filesCwd = null;
let stripFiles = null;
```

The view constructor must not issue filesystem calls; `activate()` owns that lifecycle.

- [ ] **Step 4: Centralize leaving the file special view**

Add one coordinator guard:

```js
function leaveFiles() {
  if (!filesCwd) return true;
  if (!fileView.canLeave()) return false;
  filesCwd = null;
  fileView.deactivate().catch(() => {});
  return true;
}
```

Use it before these navigation paths:

- `setActive(id)` from a strip tab or tray;
- `selectProject(cwd)` when it will open a session/Overview or change project;
- `showOverview(cwd)`;
- `newSession(...)` before allocating/reserving a session;
- ad hoc picker choices that change the project.

Return `false`/`null` when the user cancels so callers do not continue. Where `setActive` calls `selectProject(..., { open: false })`, pass an internal `skipFileGuard` option after the first successful guard to avoid prompting twice.

A click on a terminal panel already visible beside `Filer` changes terminal focus only; it does not navigate away, so it leaves `filesCwd` and its watcher intact. Keep those direct panel-focus paths, but route their repeated `activeId`/layout logic through one helper so all three paths behave identically.

If such a focused terminal is closed while Overview or Files is still shown, keep that special panel active and clear only `activeId`; do not fall through to a sibling session and accidentally navigate away from a dirty file.

- [ ] **Step 5: Add `showFiles()` and make special panels mutually exclusive**

Implement:

```js
function showFiles(cwd) {
  if (!projects.has(cwd)) return false;
  if (filesCwd && filesCwd !== cwd && !leaveFiles()) return false;
  overviewCwd = null;
  activeCwd = cwd;
  activeId = null;
  filesCwd = cwd;
  renderStrip();
  applyLayout();
  syncTray();
  fileView.activate(cwd).catch(() => {});
  return true;
}
```

`showOverview()` clears/deactivates `filesCwd`; `setActive()` does the same after the guard. Selecting `Filer` clears `overviewCwd`. Do not clear pinned sessions.

Add a `beforeunload` listener that prevents navigation when `fileView.hasUnsavedChanges()` is true, giving Chromium/Electron its standard close/reload confirmation. It protects unexpected renderer replacement without inventing a second save protocol.

- [ ] **Step 6: Render the Files strip tab in the fixed position**

In `renderStrip()`, create Files immediately after Overview and before session tabs:

```js
const files = document.createElement('button');
files.className = 'stab files';
files.textContent = `▤ ${t('strip.files')}`;
files.title = t('strip.files.title', { project: p.name });
files.addEventListener('click', () => showFiles(p.path));
strip.appendChild(files);
stripFiles = files;
if (filesCwd === p.path) files.classList.add('focused');
```

Reset `stripFiles` when rebuilding. Overview, Files, sessions, and `+` remain in that exact order.

When restoring tabs or consuming a picker choice, use `record.projectPath` / `choice.projectPath` returned by main when available. This makes the renderer follow main's verified worktree ownership rather than granting authority through its own `ownerOf()` spelling heuristic.

- [ ] **Step 7: Include Files in grid layout without disturbing native terminals**

Change `applyLayout()` to count at most one special panel:

```js
const specialCwd = filesCwd || overviewCwd;
const n = ids.length + (specialCwd ? 1 : 0);
```

Toggle `.shown`/`.focused` for `fileView.element` just as Overview is toggled, and keep terminal panel loops based only on `shownIds()`. `scheduleSync()` therefore continues hiding every native terminal whose own terminal panel is not shown; it never places one over the file panel.

Update empty-state checks such as `if (!tabs.size && !overviewCwd)` to include `!filesCwd`. Keep the current maximum of six terminal panels; a special panel is additional in the same way Overview already is.

- [ ] **Step 8: Add localized UI and stable error mapping**

Add matching English and Swedish strings for at least this exact key set:

```text
strip.files
strip.files.title
files.panel
files.root
files.showIgnored
files.tree
files.save
files.saved
files.noFile
files.loading
files.dirty
files.conflict
files.deleted
files.ignored
files.watchFailed
files.reload
files.reloadConfirm
files.overwrite
files.copy
files.copied
files.discard
files.rootGone
files.retry
files.unavailable.outside-root
files.unavailable.unreadable
files.unavailable.not-file
files.error.project-unavailable
files.error.root-unavailable
files.error.invalid-path
files.error.git-metadata-denied
files.error.not-file
files.error.not-text
files.error.too-large
files.error.permission-denied
files.error.unreadable
files.error.deleted
files.error.conflict
files.error.write-failed
files.error.watch-failed
```

The file view maps error codes through `files.error.${code}` and falls back to `files.error.unreadable`; it never displays a raw `error.message`.

- [ ] **Step 9: Style the two-column panel and accessible states**

Add focused rules to `renderer/styles.css` near Overview, using existing tokens:

```css
.panel.files-panel {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: var(--shadow-panel);
}
.panel.files-panel.shown { display: grid; grid-template-rows: auto minmax(0, 1fr); }
.files-toolbar { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--line-soft); }
.files-body { min-height: 0; display: grid; grid-template-columns: minmax(190px, 28%) minmax(0, 1fr); }
.files-tree { min-width: 0; overflow: auto; border-right: 1px solid var(--line-soft); padding: 8px; }
.files-document { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
.files-editor, .files-editor .cm-editor, .files-editor .cm-scroller { min-height: 0; height: 100%; }
```

Add visible `:focus-visible`, `[aria-selected="true"]`, `[aria-disabled="true"]`, dirty/conflict/deleted text/icon, symlink marker, and conflict-action rules. Color may reinforce state but must not be its only indicator. Do not style global buttons or refactor unrelated CSS.

- [ ] **Step 10: Re-apply dynamic language and theme**

In the existing `window.ui.onChange` handler:

```js
if (kind === 'language') fileView.onLanguage();
if (kind === 'theme') fileView.onTheme(payload);
```

Rebuilding the strip refreshes the Files label/title. The editor compartment changes in place; do not recreate the editor or lose dirty content.

- [ ] **Step 11: Run automated integration checks**

```bash
npm run build:editor
node --check renderer/renderer.js
node --test test/file-state.test.js
pgrep -af 'esbuild|rollup|webpack|vite|gradle|jest|vitest|pest' || true
npm test
git diff --check
```

Expected: locale/build-contract tests pass, renderer syntax is valid, the bundle builds, and the complete project suite exits 0 without `FAIL`.

- [ ] **Step 12: Commit the rendered feature**

```bash
git add renderer/index.html renderer/renderer.js renderer/styles.css i18n/en.json i18n/sv.json package.json test/file-state.test.js
git commit -m "feat: add project files panel"
```

### Task 9: Automate isolated UI flow, verify packaging, and perform final review

**Files:**
- Create: `test/ui-project-files.mjs`
- Modify: `package.json`
- Modify only if verification exposes a defect: files from Tasks 1–8.

**Interfaces:**
- Produces: `npm run test:ui:files`, which launches and drives only a separate TabDesk instance.
- Consumes: `TABDESK_PROJECTS_DIR`, `TABDESK_START_CMD`, isolated `--user-data-dir`, isolated `TMUX_TMPDIR`, and a dedicated remote-debugging port.

- [ ] **Step 1: Add the isolated UI script and command**

Add:

```json
"test:ui:files": "npm run build:editor && node test/ui-project-files.mjs"
```

`test/ui-project-files.mjs` must:

1. create one exact `mkdtemp` fixture under `/tmp`;
2. create its own `profile/`, `tmux/`, and `projects/project/` directories;
3. initialize a Git repository, commit `src/note.js`, `.gitignore`, and a dotfile, then create one real `.worktrees/ui-worktree` with `git worktree add`;
4. choose a free localhost port;
5. spawn the Electron binary resolved from the installed `electron` package with JavaScript arguments `--user-data-dir=${profile}` and `--remote-debugging-port=${port}`;
6. set `TABDESK_PROJECTS_DIR=projects`, `TMUX_TMPDIR=tmux`, and `TABDESK_START_CMD=exec bash --noprofile --norc` in the child environment, where `projects` and `tmux` are the exact absolute fixture paths;
7. connect to that test window's Chrome DevTools Protocol target;
8. close through CDP and wait for the exact child PID; if that isolated child alone misses a bounded shutdown deadline, send `SIGTERM` to that exact PID, wait again, and report the fallback;
9. clean only the exact fixture directory in `finally`.

Use Node 24's built-in `fetch` and `WebSocket`; do not add Playwright/Puppeteer. A minimal request multiplexer is:

```js
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(String(data));
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    send(method, params = {}) {
      const id = ++seq;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => socket.close(),
  };
}
```

Poll only the dedicated `http://127.0.0.1:${port}/json` endpoint. Select the page whose URL ends in `/renderer/index.html`; never enumerate or connect to another debugging port/window.

- [ ] **Step 2: Drive concrete UI acceptance checks**

Use `Runtime.evaluate` with `awaitPromise: true`, `Input.dispatchKeyEvent`, and `Input.insertText`. Implement a bounded `waitFor(expression, label)` that fails after 10 seconds. The script must assert:

- the fixture project rail row appears and clicking it shows Overview;
- starting the always-available `Terminal` chip, pinning that session, then selecting `.stab.files` leaves both the terminal panel and `.files-panel` shown;
- the root selector contains project plus `ui-worktree` and no fake convention directory;
- expanding `src` is lazy and opening `src/note.js` shows its safe relative path, CodeMirror line numbers, and highlighted spans;
- tree arrow navigation changes the roving focused treeitem;
- ignored content is absent, then appears with an ignored text/accessible marker after the toggle;
- inserting text marks dirty and `Ctrl+S` updates the fixture file on disk;
- `Ctrl+F` opens CodeMirror's search/replace panel;
- an external disk edit while clean auto-reloads and keeps a valid selection;
- an external disk edit while dirty shows conflict and blocks ordinary Save;
- Copy leaves conflict/local text unchanged, Reload restores disk content after its dialog, and deleted conflict never offers Overwrite;
- switching to the verified worktree rebuilds the tree;
- computed CodeMirror colors match active TabDesk CSS tokens;
- `Page.captureScreenshot` succeeds for this test target only (assert non-empty bytes; no persistent screenshot is required).

Handle confirmation dialogs through `Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog`; do not globally stub `window.confirm`, because the real dirty guard is part of this flow.

- [ ] **Step 3: Run the UI test alone and inspect only its child**

First ensure there is no competing heavy job:

```bash
pgrep -af 'esbuild|rollup|webpack|vite|gradle|jest|vitest|pest' || true
npm run test:ui:files
```

Expected: the script prints each named assertion, exits 0, closes its isolated Electron child, removes its fixture, and never activates or reloads the guard-managed main window.

- [ ] **Step 4: Commit the repeatable UI verifier**

```bash
git add test/ui-project-files.mjs package.json
git commit -m "test: cover project file editor UI"
```

- [ ] **Step 5: Perform the required read-only scope-and-simplicity pass**

Invoke the `scope-review` skill against the approved spec and the complete branch diff. The expected implementation file set is:

```text
.gitignore
package.json
package-lock.json
main.js
preload.js
project-files/index.js
project-files/document.js
project-files/watch.js
renderer/file-state.js
renderer/files-entry.js
renderer/files/editor.js
renderer/files/view.js
renderer/index.html
renderer/renderer.js
renderer/styles.css
i18n/en.json
i18n/sv.json
test/project-files.test.js
test/file-state.test.js
test/ui-project-files.mjs
```

Remove speculative adapters, file-manager actions, persistence, broad refactors, and duplicated path/editor rules. Keep the approved spec and this plan as their earlier documentation commits. If the pass changes code, rerun the affected focused test and commit the narrow correction explicitly.

- [ ] **Step 6: Run fresh definition-of-done verification**

Invoke `verify-done` and `superpowers:verification-before-completion`. Check for competing builds, then run from the task worktree:

```bash
pgrep -af 'esbuild|rollup|webpack|vite|gradle|jest|vitest|pest' || true
npm test
npm run test:ui:files
git diff --check
git status --short --branch
```

Expected: `npm test` rebuilds the one bundle and both test layers pass; the isolated UI flow passes; `git diff --check` is silent; the branch is clean except for ignored `renderer/files.bundle.js`.

- [ ] **Step 7: Verify the generated asset is actually packaged**

Use one task-scoped temporary output, run one package build at a time, and inspect the asar with the already-installed `@electron/asar` dependency:

```bash
TABDESK_PACK_DIR=$(mktemp -d /tmp/tabdesk-files-pack-XXXXXX)
npm run build:editor
./node_modules/.bin/electron-builder --linux dir --x64 --config.directories.output="$TABDESK_PACK_DIR"
TABDESK_ASAR="$TABDESK_PACK_DIR/linux-unpacked/resources/app.asar" node - <<'NODE'
const asar = require('@electron/asar');
const archive = process.env.TABDESK_ASAR;
const files = asar.listPackage(archive);
for (const required of ['/renderer/files.bundle.js', '/project-files/index.js', '/project-files/document.js', '/project-files/watch.js']) {
  if (!files.includes(required)) throw new Error(`missing packaged file: ${required}`);
  console.log(`  ok   packaged ${required}`);
}
NODE
test -n "$TABDESK_PACK_DIR" && test "$TABDESK_PACK_DIR" != "/tmp" && rm -rf -- "$TABDESK_PACK_DIR"
```

If the worktree's local `node_modules/.bin/electron-builder` is absent, resolve the binary with `npm exec -- electron-builder` from the worktree; do not point the packager at the primary checkout. The cleanup target is the exact `mktemp` directory under `/tmp`, never `/tmp` itself.

- [ ] **Step 8: Hand off the finished branch without pushing or touching the user window**

Use `superpowers:requesting-code-review` for the completed implementation, address only verified findings through `superpowers:receiving-code-review`, rerun affected verification, then use `superpowers:finishing-a-development-branch` to present integration choices.

Do not push, fast-forward the primary `main`, or restart the guard-managed app without the user's separate explicit integration/restart decision. Main/preload changes eventually require TabDesk's own Restart control; killing the process is never the apply mechanism.
