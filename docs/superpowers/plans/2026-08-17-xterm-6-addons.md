# Xterm 6 and Official Addons Implementation Plan

**Goal:** Upgrade the in-app terminal and add the requested official xterm addons without weakening Electron isolation or clipboard safety.

1. Add one isolated Electron test that creates a real TabDesk terminal and checks web links, secure OSC 52 writes, Unicode 11, image limits, WebGL fallback, ligatures, and progress state.
2. Run the test against the current code and confirm that it fails because the addon integration is absent.
3. Replace `xterm` and `xterm-addon-fit` with the current stable `@xterm/*` packages plus a bundled Fira Code font.
4. Load and configure the addons in `materialize()`. Remove the private selection override and keep only public copy/paste APIs.
5. Run the focused Electron test, the read-only scope review, and the full `npm test` gate.
6. Commit only the task-owned files. Do not push, integrate, reload, or restart TabDesk.
