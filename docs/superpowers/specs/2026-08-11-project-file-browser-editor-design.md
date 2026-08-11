# Project File Browser and Editor

## Status

Approved design. This document is the source for the implementation plan; it does not authorize integration or push.

## Goal

Let a user browse the selected TabDesk project's directories and edit existing text files without leaving the project workspace. The feature must work for the configured project root, verified worktrees, symlinked projects, and ad hoc projects that main has admitted through TabDesk's existing project picker.

The first version is intentionally a focused editor, not an IDE or file manager. It provides one open file, syntax highlighting, line numbers, in-file search and replace, manual saving, safe external-change handling, and no file creation or deletion.

## Product decisions

- `Filer` is a fixed project view in the session strip beside `Översikt`.
- The view uses a two-column layout: a lazy directory tree and one CodeMirror editor.
- A root selector offers the project root and worktrees that main currently verifies as belonging to that project.
- Existing text files can be read and edited. Create, rename, move, and delete are out of scope.
- Saving is manual through the Save action or `Ctrl+S`.
- A dirty file is never discarded or overwritten without an explicit decision.
- Filesystem changes appear automatically while the file view is active.
- Git-ignored entries are hidden by default and can be shown with `Visa ignorerade`. `.git` is never shown or accessible.
- Editor state is in memory for the current TabDesk run only.

CodeMirror 6 is chosen over Monaco. CodeMirror already exposes modular search, completion, lint, language, and dynamic-configuration extensions, so it leaves room for later editor features without paying Monaco's worker and packaging cost now. Monaco would not make the application a full VS Code environment: browser Monaco does not run ordinary VS Code extensions. The filesystem and document-state design below also remains independent of the editor implementation, keeping a later editor replacement local.

## Interaction

### Project view

Each project strip contains `Översikt`, `Filer`, its session tabs, and the existing add-session control. `Översikt` and `Filer` are mutually exclusive special panels. Selecting either clears the focused session but keeps pinned terminal panels visible in the grid, matching the current overview behavior.

The file view keeps these values per rail project for the current renderer lifetime:

- selected root;
- expanded directories;
- ignored-entry visibility;
- last successfully opened file.

The first visit defaults to the project root. If a remembered worktree has disappeared, the view falls back to the project root and explains that the previous root is no longer available.

Switching project, root, special panel, or file passes through the dirty guard. A clean document moves immediately. A dirty or conflicted document requires the user to keep editing or explicitly discard local changes.

### Root selector and file tree

The root selector lists the main project first, followed by current worktrees in stable name order. An ad hoc project admitted through the native folder picker is eligible for the same file view; it receives only the roots that main can independently verify.

Directories load when expanded rather than through an eager recursive scan. Entries are sorted with directories first and then by display name. Dotfiles are ordinary entries. Symlinks have a distinct indicator. A symlink whose target remains within the selected root can be browsed or opened; an external or broken target is visible but disabled with an explanation.

`Visa ignorerade` reloads the tree with ignored entries included. Turning it off does not discard an already open ignored file. The file remains open until the user navigates away, while its header indicates that it is currently hidden by the tree filter.

### Editor

The editor header shows the selected root, the file's relative path, dirty or conflict state, and the Save action. Only one file is open at a time.

CodeMirror provides:

- syntax highlighting selected from the filename, with plain text as the fallback;
- line numbers and standard selection, undo, and redo behavior;
- `Ctrl+F` search and replace;
- `Ctrl+S` save;
- a theme derived from TabDesk's active theme;
- runtime language reconfiguration when another file opens.

Language detection uses CodeMirror's maintained language-data catalog, filename matching, and lazy language initialization. Failure to initialize language support does not prevent editing; the document falls back to plain text.

### Saving and external changes

Reading a file returns its content and an opaque revision. The first local edit changes the document from `clean` to `dirty`. A successful save returns a new revision and restores `clean`.

The selected root is watched while its file panel is active:

- If an open clean file changes, it is re-read automatically. The previous selection is clamped to the new document length and scrolled back into view.
- If an open dirty file changes, the document enters `conflict`. Save is blocked.
- If a clean open file is deleted, the editor keeps the last content in a non-editable deleted state so it does not disappear without explanation.
- If a dirty open file is deleted, it enters conflict and preserves the local content.

A changed-file conflict offers:

1. `Ladda om från disk`, which discards the local buffer after confirmation;
2. `Skriv över med min version`, which is available only while the target still exists;
3. `Kopiera mina ändringar`, which copies the local buffer without changing disk state.

A deleted file cannot be recreated through conflict resolution because file creation is outside this version's scope.

## Architecture and data flow

### Main-owned project authorization

Renderer possession of a path is not authority to read it. Main maintains the set of project roots it has admitted for the current application state. That set includes configured rail projects, the configured projects-folder row, symlinked project rows, native-dialog ad hoc selections, and project rows restored from main-owned session state.

The renderer may identify one of those projects when opening `Filer`. Main validates it against the admitted set and returns opaque root IDs for the project and its verified worktrees. Subsequent directory and file requests carry the admitted project identity, a root ID, and a relative path. They never carry a renderer-selected absolute target path.

Removing a project or worktree invalidates its root IDs. Every operation revalidates the selected root rather than relying on an earlier successful check.

### `project-files` module

A new main-process `project-files` module is the filesystem seam. Its small interface supports these operations:

1. list the allowed roots for an admitted project;
2. list one relative directory with or without ignored entries;
3. read one eligible relative file and return document metadata plus a revision;
4. write one existing relative file when its expected revision still matches;
5. activate or release change watching for one selected root.

The module owns authorization, path normalization, real-path containment, worktree verification, ignore decisions, text validation, revisions, atomic replacement, and watcher event normalization. Renderer and IPC code do not reproduce those rules.

Directory entries returned to the renderer contain display name, relative path, entry kind, and presentation flags such as hidden, ignored, symlink, or unavailable. Read results contain content, language hint, format metadata, and revision. Raw absolute target paths and raw system errors are not returned.

### Preload and IPC

Preload exposes semantic file methods and a normalized change subscription. It remains a narrow bridge: no Node filesystem or path capability reaches the renderer.

Main IPC handlers delegate immediately to the `project-files` module and return structured results. Change events include only project identity, root ID, relative path, and normalized event kind. Subscriptions are released on root change, file-panel deactivation, renderer reload, or window destruction.

### Renderer modules

The renderer gains two focused modules:

- a file-view module that owns the root selector, lazy tree, toolbar, dirty guard, watcher subscription, conflict banner, and per-project in-memory state;
- a CodeMirror module that owns editor construction, document replacement, filename-based language loading, TabDesk theming, change notifications, selection restoration, and keyboard commands.

The file-view module deals in document text and revision state. CodeMirror-specific state stays local to the editor module. No speculative generic editor adapter is introduced; locality is sufficient until a second editor implementation exists.

The main renderer coordinates the special-panel selection with the existing overview, session focus, pinned panels, and native-terminal layout. When `Filer` is active it participates in the panel grid like `Översikt`, so native terminal windows continue to be placed only over visible terminal panels.

### CodeMirror build

CodeMirror 6 uses browser modules and therefore needs a local bundle in TabDesk's current classic-script renderer. Esbuild compiles the file-view entry, editor module, and maintained language-data catalog into one self-contained browser asset. The build runs during dependency installation, tests, and distribution packaging, and the same script is available directly during development.

The generated asset is loaded from the application package. The feature does not use a CDN, enable Node integration, create runtime language chunks, or relax the renderer's content security policy. Packaging verification must prove that the generated asset is present in the distributable application.

## Filesystem invariants

### Path and symlink containment

Relative paths reject absolute forms, empty path components where invalid, `.` or `..` traversal, NUL bytes, and platform separators that would change interpretation. The module resolves the admitted logical root and its real root, then resolves every requested entry.

An entry is eligible only when its real target is the root itself or a descendant of the selected real root. A symlink may therefore point elsewhere inside the selected root, but never outside it. Reads and writes use the verified real target so editing an internal symlink does not replace the symlink itself.

`.git` and every descendant are denied before listing, reading, writing, or watching, even when a different spelling or symlink would reach them.

### Eligible files and text format

Only existing regular files no larger than 5 MiB are editable. Directories, devices, sockets, binary data, invalid UTF-8, oversized files, and unreadable files return typed non-destructive errors. A save whose encoded UTF-8 output would exceed 5 MiB is rejected before a temporary file is created.

UTF-8 with or without BOM is supported. The read result records BOM and dominant line-ending style. Saving preserves BOM, line endings, file mode, and whether the document ended with a line break. An unknown filename remains editable as plain text.

### Ignore behavior

For Git worktrees, ignore checks use Git's own ignore rules through a batched, non-shell invocation. This preserves nested `.gitignore`, repository excludes, negation, and tracked-file behavior rather than reusing the sync manifest's deliberately partial parser. On a non-Git project there are no Git-ignored entries; lazy loading still prevents an eager traversal of dependency trees. `.git` remains denied in every case.

Ignore status is a presentation filter, not an authorization rule. Turning on `Visa ignorerade` does not weaken path, file-type, size, or symlink checks.

### Revisions and atomic writes

A revision is derived from the exact bytes read and is opaque to the renderer. Before saving, main re-resolves and revalidates the target, verifies that it still exists, and compares its current revision with `expectedRevision`.

On a match, main writes a same-directory temporary file, preserves the original mode, flushes it, rechecks the target revision, and atomically replaces the target. Temporary filenames are never returned to the renderer and are excluded from watcher events. Any mismatch before replacement returns `conflict` without touching the target.

An explicit overwrite action repeats all authorization and eligibility checks but accepts the target's current revision as the replacement base. It never bypasses containment, `.git`, regular-file, encoding, or existence checks.

### Watching

The existing Chokidar dependency backs one watcher for the active file root. It does not follow external symlink targets. Raw events are debounced and normalized into added, changed, removed, and tree-invalidated notifications.

The renderer treats watcher events as hints and re-reads through the normal module interface before changing editor state. A watcher event alone never authorizes or supplies file content.

## Failure behavior

The module returns stable error codes with safe display context:

- `project-unavailable` or `root-unavailable`;
- `invalid-path` or `outside-root`;
- `git-metadata-denied`;
- `not-file`, `not-text`, or `too-large`;
- `permission-denied` or `unreadable`;
- `deleted`;
- `conflict`;
- `write-failed` or `watch-failed`.

The renderer maps these codes to localized messages and never renders raw paths or stack traces. A tree-listing failure stays local to that directory and offers retry. A watcher failure leaves reopening and saving available while displaying that live updates are unavailable.

## Accessibility and localization

All user-facing strings are added to both shipped locales. The tree is keyboard navigable: arrows move and expand or collapse, Enter opens, and focus remains visible. Toolbar controls have accessible labels and expose pressed or expanded state where applicable.

Dirty, conflict, ignored, symlink, and unavailable states are conveyed by text or accessible labels in addition to color. Save and conflict actions remain reachable without a pointer. CodeMirror receives the active TabDesk theme without reducing focus contrast.

## Verification

### Module tests

Use temporary project fixtures to cover the `project-files` interface:

- configured root, direct project, symlinked project, admitted ad hoc project, valid worktree, and rejected arbitrary project;
- lazy directory listing, directory-first sorting, dotfiles, Git ignore filtering and the ignored toggle;
- absolute paths, traversal, alternate separators, NUL input, `.git`, internal symlinks, external symlinks, broken links, and symlink retargeting;
- regular UTF-8, UTF-8 BOM, CRLF, trailing newline, unknown extension, invalid UTF-8, binary content, oversized content, permission failure, and deleted entries;
- successful write, mode and format preservation, expected-revision mismatch, race before replacement, explicit overwrite, and prohibition on recreating a deleted file;
- normalized watcher events, event coalescing, temporary-file suppression, root switching, and watcher cleanup.

### Renderer-state tests

Keep document-state transitions independently testable:

- unopened to clean;
- clean to dirty and successful save back to clean;
- clean external change and automatic reload;
- dirty external change to conflict;
- changed-file conflict resolution through reload or overwrite;
- deleted-file conflict without recreation;
- navigation guard across file, root, special-panel, and project changes;
- stale asynchronous reads or language loads not replacing the newly selected file.

### Isolated UI verification

Drive only a separate TabDesk instance with its own user-data directory, fixture projects root, tmux socket directory, and debugging port. Verify:

1. `Filer` participates in the project strip and grid without disturbing pinned terminals.
2. Project and worktree roots list correctly and switching roots rebuilds the tree.
3. Lazy expansion, ignored visibility, keyboard navigation, and unsupported-file presentation work.
4. A file opens with the correct relative path, language highlighting, line numbers, search, and theme.
5. `Ctrl+S`, dirty guards, clean auto-reload, and conflict actions match the specified state flow.
6. Renderer reload applies renderer-only changes without driving the guard-managed user window.

The project's full `npm test` command must build the CodeMirror asset and pass from the task worktree. Distribution verification must also prove the bundle is packaged. No completion claim may rely only on manual interaction.

## Acceptance criteria

1. Every main-admitted rail project can open a `Filer` panel without granting arbitrary filesystem access.
2. The selector contains only the project root and worktrees main verifies for that project.
3. A user can lazily browse eligible entries, reveal ignored entries, open one supported text file, edit it, search it, and save with `Ctrl+S`.
4. No request can read or write `.git`, an external symlink target, an arbitrary absolute path, a binary or oversized file, or a newly created target.
5. External changes update clean documents and put dirty documents into a non-destructive conflict state.
6. Pinned terminals, Overview, project selection, native terminal placement, preview, and existing session behavior continue to work.
7. Automated module and renderer-state coverage passes, the isolated UI flow is verified, and the packaged application contains its editor assets.

## Out of scope

- Creating, renaming, moving, or deleting files or directories.
- Multiple open editor tabs or persisted editor state.
- Project-wide search or replace.
- Git status, diff, staging, commit, or other source-control UI.
- Autocomplete, diagnostics, formatting, language servers, or VS Code extensions.
- Editing binary data, invalid UTF-8, files larger than 5 MiB, `.git`, or external symlink targets.
- Changing the preview dock, terminal backend, project synchronization, or instruction-file editor.
