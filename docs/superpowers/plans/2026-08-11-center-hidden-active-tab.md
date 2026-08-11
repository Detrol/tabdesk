# Center Hidden Active Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring a clipped active session tab toward the horizontal center while leaving an already visible tab and the strip's scroll position unchanged.

**Architecture:** Keep the behavior at the existing `setActive()` integration point. Compare the active tab and strip rectangles after layout, then use native `scrollIntoView()` only when the tab is clipped; no shared module or persisted state is warranted for this one-caller DOM policy.

**Tech Stack:** Electron 31, classic browser JavaScript, native DOM geometry and scrolling APIs, existing Electron `npm test` harness, Chrome DevTools Protocol for isolated renderer verification.

## Global Constraints

- A fully visible active session tab does not change the strip's scroll position.
- An active session tab that is clipped on either side is brought as close to the horizontal center as the strip's scroll bounds allow.
- Scrolling is immediate and unanimated.
- Overview and `+` controls retain their current order and behavior.
- Do not add a dependency, persisted scroll state, animation, or additional layout spacer.
- Drive only a separate TabDesk instance with an isolated projects directory, tmux socket directory, browser profile, and debug port; never drive the guard-managed main window.

---

### Task 1: Center a clipped active tab

**Files:**
- Modify: `renderer/renderer.js:431-453`
- Temporary verification artifact: `/srv/dev/.tabdesk-center-test-XXXXXX/repro-center.mjs` (delete after verification; never commit)

**Interfaces:**
- Consumes: `HTMLElement.getBoundingClientRect()` for `t.tabEl` and `strip`.
- Consumes: `HTMLElement.scrollIntoView({ block: 'nearest', inline: 'center' })`.
- Produces: no new public interface; `setActive(id)` retains its existing signature.

- [ ] **Step 1: Record the red renderer behavior in an isolated instance**

Start TabDesk from this worktree with a temporary projects root containing `project-a` and `project-b`, its own `TMUX_TMPDIR`, its own `--user-data-dir`, and a dedicated `--remote-debugging-port`. Create enough sessions in `project-a` to overflow the strip and fewer sessions in `project-b` so its strip clamps horizontal scroll. Never activate or reload the guard-managed main window.

Use a temporary DevTools-protocol probe that selects the last session in `project-a`, switches to `project-b`, switches back, and evaluates this exact alignment condition:

```js
const strip = document.querySelector('#strip');
const active = strip.querySelector('.stab.focused');
const stripRect = strip.getBoundingClientRect();
const tabRect = active.getBoundingClientRect();
const maxScroll = strip.scrollWidth - strip.clientWidth;
const expectedScroll = Math.max(0, Math.min(
  maxScroll,
  strip.scrollLeft
    + (tabRect.left + tabRect.width / 2)
    - (stripRect.left + stripRect.width / 2),
));
const centeredWithinBounds = Math.abs(strip.scrollLeft - expectedScroll) <= 1;
```

Also set a non-zero `strip.scrollLeft`, activate a fully visible session tab, and assert that `scrollLeft` remains exactly equal.

Expected before implementation: the project-switch assertion exits non-zero because `inline: 'nearest'` stops as soon as the active tab reaches the viewport edge. Record the active label, `scrollLeft`, `expectedScroll`, and both rectangles.

- [ ] **Step 2: Replace edge reveal with guarded center reveal**

Replace the current unconditional reveal immediately after `applyLayout()` in `setActive()` with:

```js
  // The strip is shared between projects. A shorter project can clamp its
  // horizontal scroll, so bring a clipped restored tab toward the center.
  const tabRect = t.tabEl.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  const tabVisible = tabRect.left >= stripRect.left && tabRect.right <= stripRect.right;
  if (!tabVisible) t.tabEl.scrollIntoView({ block: 'nearest', inline: 'center' });
```

Do not add CSS, smooth scrolling, a helper module, or per-project scroll state.

- [ ] **Step 3: Re-run the isolated renderer probe and confirm green behavior**

Reload only the isolated test instance and run the same probe.

Expected:

```text
clipped_active_centered_within_bounds=true
visible_active_scroll_unchanged=true
correct_terminal_focused=true
```

Run the project-switch assertion at least twice to rule out a one-frame layout race. Remove the exact temporary test root and stop only its isolated Electron/tmux processes when finished.

- [ ] **Step 4: Run the repository verification gates**

Check for competing heavy jobs, then run one full suite:

```bash
pgrep -af 'esbuild|rollup|webpack|vite|gradle|jest|vitest|pest'
node --check renderer/renderer.js
npm test
git diff --check
```

Expected: no competing heavy build, `node --check` exits 0, `npm test` exits 0 with no `FAIL` lines, and `git diff --check` prints nothing.

- [ ] **Step 5: Scope-review and commit the implementation**

Confirm that only the approved geometry guard changed and that no debug instrumentation or temporary artifact remains. Stage the source explicitly:

```bash
git add renderer/renderer.js
git commit -m "fix: center hidden active tab"
```
