# Grok CLI Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Grok a full TabDesk runtime with launch, model, effort, instructions, resumable history, transcripts, and live titles.

**Architecture:** Extend the existing per-runtime tables and providers. Read Grok's documented local `summary.json` and `updates.jsonl` files with the same bounded, read-only rules used for other runtimes; do not add a dependency or a second session database.

**Tech Stack:** Electron, CommonJS, Node.js filesystem APIs, existing custom Electron test suite.

## Global Constraints

- Preserve the user's existing uncommitted Claude command change in `agents.js`.
- Use Grok 0.2.106's verified flags: `--permission-mode auto`, `--resume`, `--continue`, `--model`, and `--reasoning-effort`.
- Read Grok data only. Never change or delete files in Grok's session store.
- Accept only IDs matching the existing `SAFE_ID` rule.
- Inspect at most 40 Grok summaries, return at most 10 rows, and read at most 8 MiB of transcript data.
- Do not show a quota value for Grok.
- Add no dependency and no new framework.

---

### Task 1: Register Grok and expose its settings

**Files:**
- Modify: `agents.js`
- Modify: `model.js`
- Modify: `effort.js`
- Modify: `instructions.js`
- Modify: `i18n/en.json`
- Modify: `i18n/sv.json`
- Test: `test/main.js`

**Interfaces:**
- Consumes: the existing agent registry, model picker, effort picker, and instruction-file table.
- Produces: agent id `grok`; `model.grokModelsFromText(text)`; Grok model rows; Grok effort rows and flags; project/global Grok instruction paths.

- [ ] **Step 1: Add failing registry, model, effort, and instruction tests**

Add focused assertions to `test/main.js`:

```js
const grokModels = MD.grokModelsFromText([
  'Default model: grok-4.6',
  'Available models:',
  '  * grok-4.6 (default)',
  '  - grok-4.5',
  '  - bad;rm',
].join('\n'));
ok('grok-modeller parsas', grokModels.join(',') === 'grok-4.6,grok-4.5', grokModels.join(','));

ok('grok har egna effort-nivaer',
  EF.list('grok').map((r) => r.id).join(',') === 'default,none,minimal,low,medium,high,xhigh,max');
ok('grok effort blir CLI-flagga',
  EF.flagFor('grok', 'xhigh') === ' --reasoning-effort xhigh');
```

Create an executable fixture named `grok`, prepend its directory to `PATH`
before `agents.js` is loaded, then assert this exact public row:

```js
{
  id: 'grok',
  label: 'Grok',
  command: 'grok --permission-mode auto',
  takesModel: true,
  resumeArgs: '--resume {id}',
  continueArgs: '--continue',
}
```

Set `GROK_HOME` to the test profile before loading `instructions.js`, then
assert that Grok resolves project `AGENTS.md` and global `$GROK_HOME/AGENTS.md`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx electron test/main.js`

Expected: FAIL because Grok is not registered and the parser and effort rows do not exist.

- [ ] **Step 3: Implement the minimum settings support**

Add this registry row without changing the existing Claude row:

```js
{ id: 'grok', label: 'Grok', bin: 'grok', command: 'grok --permission-mode auto', takesModel: true, resumeArgs: '--resume {id}', continueArgs: '--continue', hint: 'agent.hint.grok' },
```

In `model.js`, add `GROK_HOME()` and `GROK_CONFIG()`, parse the top-level
`[models]` table's `default` value, and add a bounded `grok models` provider.
The parser accepts only bullet rows:

```js
function grokModelsFromText(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const match = /^\s*[*-]\s+([^\s(]+)/.exec(line);
    if (match && SAFE_ID.test(match[1]) && !out.includes(match[1])) out.push(match[1]);
  }
  return out;
}
```

Return `[DEFAULT_ROW, ...models]`, cache it with the existing five-minute TTL,
and export `grokModelsFromText` and `GROK_HOME` for tests and instructions.

In `effort.js`, add:

```js
grok: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
```

Read `[models].default_reasoning_effort` for Default and return
` --reasoning-effort ${id}` from `flagFor('grok', id)`.

In `instructions.js`, add:

```js
grok: { project: 'AGENTS.md', global: () => path.join(model.GROK_HOME(), 'AGENTS.md') },
```

Add `agent.hint.grok` to English and Swedish translations.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `npx electron test/main.js`

Expected: all assertions pass.

- [ ] **Step 5: Commit the completed settings slice**

```bash
git add -- agents.js model.js effort.js instructions.js i18n/en.json i18n/sv.json test/main.js
git diff --cached --check
git commit -m "feat: add Grok runtime settings"
```

---

### Task 2: Add bounded Grok history and transcripts

**Files:**
- Modify: `history.js`
- Modify: `transcript.js`
- Test: `test/main.js`

**Interfaces:**
- Consumes: Grok's documented session root and existing `spellingsOf(cwd)` and `SAFE_ID` rules.
- Produces: `history.grokSessions(cwd, root)`, `history.grokSessionDir(cwd, sessionId, root)`, and `transcript.readGrok(cwd, sessionId, root)`.

- [ ] **Step 1: Add a failing isolated Grok-store test**

Build a fixture under `STORE/grok/<encodeURIComponent(CWD)>/<uuid>/` with:

```js
const summary = {
  info: { id: sessionId, cwd: CWD },
  generated_title: 'Grok-arendet',
  session_summary: 'Reservtitel',
  created_at: '2026-08-01T10:00:00.000Z',
  updated_at: '2026-08-01T11:00:00.000Z',
};
```

Add sibling fixtures with a foreign `info.cwd`, an unsafe ID, and
`session_kind: 'subagent'`. Assert that only the valid top-level conversation
is returned with `agent === 'grok'`, its title, and parsed timestamps.

Write `updates.jsonl` with these update variants:

```js
const grokUpdate = (update) => JSON.stringify({
  method: 'session/update',
  params: { sessionId, update },
}) + '\n';

grokUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hej Grok' } });
grokUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hemlig tanke' } });
grokUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hej tillbaka' } });
grokUpdate({ sessionUpdate: 'tool_call', title: 'Bash' });
grokUpdate({ sessionUpdate: 'tool_call_update', rawOutput: { secret: 'rå output' } });
```

Assert that the transcript contains the user text, answer, and `[Bash]`, but
not the thought or raw output. Assert that a foreign cwd returns `null`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx electron test/main.js`

Expected: FAIL because `grokSessions` and `readGrok` do not exist.

- [ ] **Step 3: Implement the history provider**

Resolve direct group directories with `encodeURIComponent()` for every value
from `spellingsOf(cwd)`. For an encoded path longer than 255 bytes,
scan group `.cwd` markers and accept only exact cwd matches. Validate each
candidate again against `summary.info.cwd` and `summary.info.id`.

Sort summary files by mtime before opening them, inspect no more than 40, skip
`session_kind === 'subagent'`, and return no more than 10 rows. Prefer
`generated_title`, then `session_summary`; use `updated_at` and `created_at`
with filesystem timestamps as fallback. Add `grok` to `PROVIDERS`.

- [ ] **Step 4: Implement the transcript reader**

Use `grokSessionDir()` to enforce cwd ownership. Read only the last 8 MiB of
`updates.jsonl`. Join consecutive `user_message_chunk` and
`agent_message_chunk` text, skip `agent_thought_chunk`, emit `[title]` once for
`tool_call`, and ignore `tool_call_update` raw output. Add Grok as the final
provider tried by `transcript.read()`.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run: `npx electron test/main.js`

Expected: all assertions pass.

- [ ] **Step 6: Commit the completed history slice**

```bash
git add -- history.js transcript.js test/main.js
git diff --cached --check
git commit -m "feat: read Grok sessions and transcripts"
```

---

### Task 3: Complete renderer behavior and documentation

**Files:**
- Modify: `renderer/renderer.js`
- Modify: `README.md`
- Test: `test/main.js`

**Interfaces:**
- Consumes: Grok rows from the agent registry and history provider.
- Produces: live Grok titles, Grok-owned mouse input, hidden Grok quota meters, and current user documentation.

- [ ] **Step 1: Add failing renderer capability checks**

Read `renderer/renderer.js` in `test/main.js` and assert that its capability
sets include Grok for TUI mouse ownership, live titles, and hidden quota meters.
These are static configuration checks for three one-line renderer policies;
do not extract a new abstraction only for the test.

```js
const rendererSource = fsx.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const grokSet = (name) => new RegExp(
  `const ${name} = new Set\\(\\[[^\\]]*'grok'[^\\]]*\\]\\)`,
).test(rendererSource);
ok('grok ager TUI-musen', grokSet('SELECTS_ITSELF'));
ok('grok far levande sessionstitlar', grokSet('TITLED_AGENTS'));
ok('grok doljer kvotmatare utan data', grokSet('NO_QUOTA_AGENTS'));
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx electron test/main.js`

Expected: FAIL because the renderer policies do not include Grok.

- [ ] **Step 3: Add Grok to the existing renderer policies**

Add `grok` to `SELECTS_ITSELF` and `TITLED_AGENTS`. Replace the opencode-only
quota branch with `NO_QUOTA_AGENTS`, containing `opencode` and `grok`, used by both
`renderMeters()` and `refreshLimits()`, so Grok never displays Claude data or
misleading dashed quota bars.

- [ ] **Step 4: Update the README**

List Grok beside the other resumable stores, include `grok --resume`, state
that Grok models come from its CLI, and state that Grok effort uses
`--reasoning-effort` while quota meters stay hidden.

- [ ] **Step 5: Run the focused test and confirm GREEN**

Run: `npx electron test/main.js`

Expected: all assertions pass.

- [ ] **Step 6: Check for competing heavy jobs and run full verification**

Run: `pgrep -af 'esbuild|rollup|webpack|vite|gradle|jest|vitest|pest'`

If no competing heavy job is active, run: `npm test`

Expected: the build completes and the complete TabDesk suite passes.

- [ ] **Step 7: Commit the completed renderer and docs slice**

```bash
git add -- renderer/renderer.js README.md test/main.js
git diff --cached --check
git commit -m "feat: finish Grok CLI integration"
```

- [ ] **Step 8: Apply and verify the running app without driving it**

Use TabDesk's own Restart because main-process modules changed. Do not kill,
focus, click, type in, or reload the guard-managed window. After the user has
restarted it, compare edited file mtimes with `pgrep -af tabdesk` and the guard
log to confirm the running process is newer.
