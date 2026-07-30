const { Terminal } = window;          // xterm global
const { FitAddon } = window.FitAddon; // fit addon global

const tabList = document.getElementById('tab-list');
const panels = document.getElementById('panels');
const emptyState = document.getElementById('empty-state');

// Terminal backend. true: embed a real native terminal (xterm) per panel as an
// X11 window reparented over the panel. false: in-app xterm.js (renders in the
// DOM). Native embedding is X11-only, and being a window of its own rather than
// DOM is what the screenshot button has to work around.
const EMBED_NATIVE = true;

let seq = 0;
let activeId = null;
let gridSize = 1;        // how many panels to show at once (1–6)
const visible = [];      // materialized ids currently shown, oldest→newest
const tabs = new Map();  // id -> tab record

// How long a background tab must stay silent before we call its command "done".
// Claude's spinner streams output while it works; a static TUI (finished, or
// waiting for input) stops emitting, so a quiet gap means "your turn".
const IDLE_MS = 1500;

// A tab is "watched" while it's visible in the grid — no need to flag it.
function isWatched(id) { return visible.includes(id); }

// ---- System tray mirror ----------------------------------------------------
// The tray menu in the main process is a mirror of the rail. Push a snapshot on
// every change that the menu shows: which tabs exist, their names, which is
// active, and whether they're busy.
//
// Coalesced through rAF because markActivity() fires on every chunk of pty
// output — sending an IPC message per chunk would flood main for no benefit,
// since the menu only rerenders when the user opens it.
let trayQueued = false;
function syncTray() {
  if (trayQueued || !window.api || !window.api.syncTray) return;
  trayQueued = true;
  requestAnimationFrame(() => {
    trayQueued = false;
    window.api.syncTray({
      activeId,
      tabs: [...tabs.values()].map((t) => ({
        id: t.id,
        name: t.name,
        cwd: t.cwd || null,
        busy: !!t.busy,
      })),
    });
  });
}

// Clear any busy/done flags on a tab (called when the user looks at it).
function clearTabFlag(t) {
  clearTimeout(t.idleTimer);
  const wasBusy = t.busy;
  t.busy = false;
  t.tabEl.classList.remove('busy', 'done');
  if (wasBusy) syncTray();
}

// The top of the rail means one thing: this one finished and wants you.
//
// A tab moves on exactly one event — the moment its dot turns green, i.e. a
// command that was running has gone quiet and nobody was watching. Nothing else
// reorders the rail: not output while it streams, not opening a tab, not
// switching back to one.
//
// Hoisting on output instead turns the rail into a leaderboard that two working
// projects trade places in several times a second; hoisting on click shuffles
// the rail under the cursor you are clicking with. Both make position noise.
// Tying it to "done" makes position mean something, and it can only fire for
// background tabs (a watched tab never goes green), so the rail is guaranteed
// to hold still while you are looking at it.
function hoistOnDone(t) {
  if (tabList.firstElementChild !== t.tabEl) tabList.prepend(t.tabEl);
}

// Called on every chunk of pty output (xterm.js backend) or whenever the
// embedded terminal writes. Marks background tabs busy while output flows, then
// green ("done") once they fall silent.
function markActivity(id) {
  const t = tabs.get(id);
  if (!t || t.tabEl.classList.contains('dead')) return;

  // Output while it streams only ever changes a tab's colour. The move comes
  // later, when it stops — see hoistOnDone().
  if (isWatched(id)) { clearTabFlag(t); return; }

  const wasBusy = t.busy;
  t.busy = true;
  t.tabEl.classList.add('busy');
  t.tabEl.classList.remove('done');
  if (!wasBusy) syncTray();
  clearTimeout(t.idleTimer);
  t.idleTimer = setTimeout(() => {
    if (!t.busy) return;
    t.busy = false;
    t.tabEl.classList.remove('busy');
    // Green dot and top of the rail are the same event, deliberately: the
    // position is what makes the colour findable in a rail too long to scan.
    if (!isWatched(id)) {
      t.tabEl.classList.add('done');
      hoistOnDone(t);
    }
    syncTray();
  }, IDLE_MS);
}

function setActive(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (!t.materialized) materialize(t);

  // Opening a tab means you're now watching it — drop the "done" flag. It keeps
  // whatever place in the rail it earned; clearing the flag is not a demotion.
  clearTabFlag(t);

  // Move id to the front of the visible set, trimmed to gridSize.
  const i = visible.indexOf(id);
  if (i !== -1) visible.splice(i, 1);
  visible.push(id);
  while (visible.length > gridSize) visible.shift();

  activeId = id;
  applyLayout();
  for (const vid of visible) fitSoon(vid);
  scheduleSync();
  // Selecting a tab puts the cursor in that terminal, so you can start typing
  // without clicking the panel first. The in-app terminal takes focus in the
  // DOM; a native one is its own X11 window and has to be told (see
  // term-embed focus(), which waits for the window when it isn't up yet).
  requestAnimationFrame(() => {
    if (t.embed) window.api.focusEmbedTerminal(id);
    else if (t.term) t.term.focus();
  });
  syncTray();
}

// ---- Embedded native terminal placement ----
// Native terminal windows don't flow with the DOM, so we push each visible
// panel's on-screen rectangle to main and let it move/size the X window to
// match. Hidden panels get unmapped. Rects are in device pixels (CSS × dpr) so
// they line up with the parent Electron window's X11 backing-store coordinates.
let syncQueued = false;
function scheduleSync() {
  if (!EMBED_NATIVE || syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => { syncQueued = false; syncEmbeds(); });
}
function syncEmbeds() {
  const dpr = window.devicePixelRatio || 1;
  for (const [tid, tt] of tabs) {
    if (!tt.embed || !tt.panelEl) continue;
    if (!tt.panelEl.classList.contains('shown')) { window.api.hideEmbedTerminal(tid); continue; }
    const el = tt.panelEl.querySelector('.term') || tt.panelEl;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    window.api.placeEmbedTerminal(tid, { x: r.x * dpr, y: r.y * dpr, w: r.width * dpr, h: r.height * dpr });
  }
}

// Once the native window is up it covers the panel, so the "▶ terminal…"
// placeholder underneath is only ever visible again while the X window lags a
// resize — which reads as flicker. Drop it as soon as the terminal is placed.
if (EMBED_NATIVE) {
  window.api.onEmbedReady((id) => {
    const t = tabs.get(id);
    const ph = t && t.panelEl && t.panelEl.querySelector('.term-loading');
    if (ph) ph.remove();
  });
  // Main polls each embedded terminal's bytes-written counter and reports the
  // moves; from here on it's the same path pty output takes.
  window.api.onEmbedActivity((id) => markActivity(id));
}

// Lay out the visible panels in a grid and highlight the focused one.
function applyLayout() {
  const ids = visible.slice(-gridSize);
  const n = ids.length;
  emptyState.classList.toggle('hidden', n > 0);

  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  panels.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  panels.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  for (const [tid, tt] of tabs) {
    const shown = ids.includes(tid);
    tt.tabEl.classList.toggle('active', shown);
    tt.tabEl.classList.toggle('focused', tid === activeId);
    if (tt.panelEl) {
      tt.panelEl.classList.toggle('shown', shown);
      tt.panelEl.classList.toggle('focused', tid === activeId && n > 1);
    }
  }
  // The model and the agent belong to the focused project, so both follow it.
  renderModelBtn();
  renderAgentBtn();
  scheduleSync();
}

function fitTerm(id) {
  const t = tabs.get(id);
  if (!t || !t.fit || !t.panelEl) return;
  // Skip while the panel is hidden or unsized — fit() would compute garbage.
  if (t.panelEl.clientWidth === 0 || t.panelEl.clientHeight === 0) return;
  try {
    t.fit.fit();
    window.api.resizeTerminal(id, t.term.cols, t.term.rows);
  } catch (_) { /* renderer not ready yet; a later fitSoon will catch it */ }
}

// xterm can't measure its cell size until it has painted a frame, so a single
// fit right after open() is a no-op. Retry across a few frames/timeouts.
function fitSoon(id) {
  requestAnimationFrame(() => {
    fitTerm(id);
    setTimeout(() => fitTerm(id), 80);
    setTimeout(() => fitTerm(id), 250);
  });
}

// ---- Which CLI a project starts ----
// Declared up here rather than with the menu that edits it: startCmdFor() runs
// as soon as the first tab materialises, which is before the rail's own wiring
// further down has been reached.
const bootAgents = (window.api.boot && window.api.boot.agents) || {};
let agentList = bootAgents.list || [];            // installed only
let agentByProject = bootAgents.byProject || {};  // cwd -> agent id
const agentFallback = bootAgents.fallback || 'claude';
// The button lives in the rail's footer and its wiring is further down, but
// applyLayout() repaints it and can run before that point is reached.
const agentBtn = document.getElementById('agent-btn');
const agentMenu = document.getElementById('agent-menu');

// The command a project tab starts with. Built at materialize time, not at
// tab-build time, so a model picked while the tab sits unopened still counts.
// Ad-hoc tabs (no project) get a plain shell.
// Ids are validated in main (model.js) before they are ever stored; the quotes
// are what keep an alias like opus[1m] from being read as a glob by bash.
function startCmdFor(t) {
  // A tab opened to run one specific thing (the update installer) carries its
  // own command and isn't an agent session.
  if (t.startCmd) return t.startCmd;
  if (!t.cwd) return null;
  // Demo hook (TABDESK_START_CMD): a screenshot or layout run that shouldn't
  // open real agent sessions in every panel.
  const demo = (window.api.boot || {}).demoStartCmd;
  if (demo) return demo;
  const spec = agentList.find((a) => a.id === agentFor(t));
  // No command is the plain-shell choice, not a failure.
  if (!spec || !spec.command) return null;
  // Only Claude Code takes TabDesk's model flag; see agents.js.
  const flag = spec.takesModel && t.model && t.model !== 'default'
    ? ` --model '${t.model}'` : '';
  return spec.command + flag;
}

// Which CLI this project starts. Mirrors agents.getFor() in main, including
// its fallback: an agent that has since been uninstalled must not leave a tab
// starting a command that no longer exists.
function agentFor(t) {
  if (!t.cwd) return 'shell';
  const has = (id) => agentList.some((a) => a.id === id);
  const stored = t.agent || agentByProject[t.cwd];
  if (stored && has(stored)) return stored;
  if (has(agentFallback)) return agentFallback;
  const first = agentList.find((a) => a.id !== 'shell');
  return first ? first.id : 'shell';
}

// Build only the tab row in the rail. The terminal/pty is created lazily.
//
// `atTop` is for tabs the user just created by hand — those go straight to the
// top so a new project isn't born at the bottom of a rail that no longer
// reshuffles to bring it up. It is placement, not a hoist: the boot loop that
// lists every known project leaves it off and keeps the order it was given.
function buildTab({ name, cwd, model, startCmd, atTop }) {
  const id = `t${++seq}`;
  const tabEl = document.createElement('li');
  tabEl.className = 'tab';
  tabEl.title = cwd || name;
  tabEl.innerHTML = `
    <span class="dot"></span>
    <span class="label"></span>
    <button class="close" title="${t('tab.close')}">×</button>`;
  tabEl.querySelector('.label').textContent = name;
  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) return;
    setActive(id);
  });
  tabEl.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  if (atTop) tabList.prepend(tabEl);
  else tabList.appendChild(tabEl);

  tabs.set(id, { id, name, cwd, model: model || 'default', startCmd, tabEl, materialized: false });
  syncTray();
  return id;
}

// Create the actual xterm instance + backing pty for a tab on first use.
function materialize(t) {
  const id = t.id;
  // The model this terminal is actually launching with — a later pick can't
  // reach the running process, so the bar compares against this.
  t.runningModel = t.model;

  const panelEl = document.createElement('div');
  panelEl.className = 'panel';
  const termEl = document.createElement('div');
  termEl.className = 'term';
  panelEl.appendChild(termEl);

  // Per-panel close button (appears on hover) so you can close a pane directly.
  const panelClose = document.createElement('button');
  panelClose.className = 'panel-close';
  panelClose.title = window.t('panel.close');
  panelClose.textContent = '×';
  panelClose.addEventListener('mousedown', (e) => e.stopPropagation());
  panelClose.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  panelEl.appendChild(panelClose);

  panels.appendChild(panelEl);

  // Embedded native terminal: the panel is just a placeholder rectangle; the
  // real terminal is a native window main reparents on top of it.
  if (EMBED_NATIVE) {
    termEl.classList.add('embed');
    termEl.innerHTML = `<span class="term-loading">${window.t('panel.loading')}</span>`;
    const ro = new ResizeObserver(() => scheduleSync());
    ro.observe(panelEl);
    panelEl.addEventListener('mousedown', () => {
      if (activeId !== id) { activeId = id; applyLayout(); }
    });
    window.api.createEmbedTerminal(id, t.cwd, startCmdFor(t));
    Object.assign(t, {
      materialized: true, embed: true, panelEl,
      cleanup: () => ro.disconnect(),
    });
    scheduleSync();
    return;
  }

  const term = new Terminal({
    fontFamily: 'Menlo, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: (window.ui.theme && window.ui.theme.terminal) || {},
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termEl);

  const ro = new ResizeObserver(() => fitTerm(id));
  ro.observe(panelEl);

  // Clicking a panel makes it the focused one (screenshot / keyboard target).
  panelEl.addEventListener('mousedown', () => {
    if (activeId !== id) { activeId = id; applyLayout(); }
  });

  window.api.createTerminal(id, term.cols, term.rows, t.cwd, startCmdFor(t));
  term.onData((data) => window.api.sendInput(id, data));
  let firstData = true;
  const offData = window.api.onData(id, (data) => {
    term.write(data);
    markActivity(id);
    // Once the shell/TUI first emits, the terminal has rendered — refit so a
    // full-screen app (Claude Code) gets resized to fill the panel.
    if (firstData) { firstData = false; fitSoon(id); }
  });
  const offExit = window.api.onExit(id, () => {
    t.tabEl.classList.add('dead');
    term.write(`\r\n\x1b[31m${window.t('panel.exited')}\x1b[0m\r\n`);
  });

  Object.assign(t, {
    materialized: true, term, fit, panelEl,
    cleanup: () => { offData(); offExit(); ro.disconnect(); },
  });
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  // The rail is rebuilt from the projects on disk at every start, so closing a
  // project tab has to be written down or it is back tomorrow. Reopening it
  // from the picker clears the mark.
  if (t.cwd) window.api.setProjectClosed(t.cwd, true);
  if (t.materialized) {
    if (t.embed) {
      window.api.killEmbedTerminal(id);
      t.cleanup();
    } else {
      window.api.killTerminal(id);
      t.cleanup();
      t.term.dispose();
    }
    t.panelEl.remove();
  }
  t.tabEl.remove();
  tabs.delete(id);

  const vi = visible.indexOf(id);
  if (vi !== -1) visible.splice(vi, 1);

  if (activeId === id) {
    activeId = visible[visible.length - 1] || null;
    if (!activeId) {
      const fallback = [...tabs.values()].find((x) => x.materialized);
      if (fallback) { setActive(fallback.id); return; }
    }
  }
  applyLayout();
  syncTray();
  if (visible.length === 0 && tabs.size === 0) emptyState.classList.remove('hidden');
}

// "+" opens the project picker: a new tab belongs to a project by default, so
// the choice is made up front rather than left as a shell in the home dir.
// A plain terminal is still one click away, inside the picker.
let adHoc = 0;
const addBtn = document.getElementById('add-terminal');
addBtn.addEventListener('click', async () => {
  addBtn.disabled = true;   // the picker is modal; don't stack a second one
  let choice = null;
  try {
    choice = await window.api.pickProject();
  } finally {
    addBtn.disabled = false;
  }
  if (!choice) return;

  if (choice.kind === 'shell') {
    setActive(buildTab({ name: `Terminal ${++adHoc}`, cwd: null, atTop: true }));
    return;
  }

  // A project already in the rail gets focused rather than opened twice.
  const existing = [...tabs.values()].find((x) => x.cwd === choice.path);
  if (existing) { setActive(existing.id); return; }

  // Opening it is the undo for having closed it: it belongs in the rail again
  // at the next start.
  window.api.setProjectClosed(choice.path, false);
  setActive(buildTab({ name: choice.name, cwd: choice.path, model: choice.model, atTop: true }));
});

document.getElementById('fullscreen-btn').addEventListener('click', () => window.api.toggleFullscreen());
document.getElementById('portable-btn').addEventListener('click', () => window.api.openPortable());
document.getElementById('settings-btn').addEventListener('click', () => window.api.openSettings());

// ---- Update chip ----
// Hidden until the background check finds something newer than the installed
// .deb; the window it opens does the downloading and installing.
const updateBtn = document.getElementById('update-btn');
updateBtn.addEventListener('click', () => window.api.openUpdate());

window.api.onUpdateAvailable((state) => {
  const show = Boolean(state && state.available);
  updateBtn.classList.toggle('hidden', !show);
  if (show) {
    document.getElementById('update-ver').textContent = state.latest;
    updateBtn.title = window.t('update.chip.title', {
      from: state.installed || state.running, to: state.latest,
    });
  }
});

// The update window couldn't get a polkit prompt, so the install command comes
// back here to run in a real terminal where a password can be typed.
window.api.onUpdateTerminal(({ command }) => {
  setActive(buildTab({ name: window.t('update.tabName'), cwd: null, startCmd: command, atTop: true }));
});
window.addEventListener('resize', () => { for (const vid of visible) fitTerm(vid); scheduleSync(); });

// Grid button: cycle 1 → 6 → 1 panels shown at once.
const gridBtn = document.getElementById('grid-btn');
function updateGridBtn() { gridBtn.textContent = t('rail.grid', { n: gridSize }); }
gridBtn.addEventListener('click', () => {
  gridSize = gridSize >= 6 ? 1 : gridSize + 1;
  updateGridBtn();
  // Re-show the most recent up to gridSize; trim if shrinking.
  while (visible.length > gridSize) visible.shift();
  applyLayout();
  for (const vid of visible) fitSoon(vid);
});
updateGridBtn();

// Toast helper for transient confirmations.
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

// Screenshot button: capture the focused terminal panel to a PNG.
document.getElementById('shot-btn').addEventListener('click', async () => {
  const t = tabs.get(activeId);
  if (!t || !t.panelEl) { toast(window.t('toast.noTerminal')); return; }
  const el = t.panelEl.querySelector('.term') || t.panelEl;
  const r = el.getBoundingClientRect();
  const res = await window.api.captureTerminal(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    t.name,
    !!t.embed,
  );
  toast(res && res.ok
    ? window.t('toast.saved', { file: res.path.split('/').pop() })
    : window.t('toast.shotFailed'));
});

// ---- Interactive project preview (fixed right dock) ----
// Runs the active project — static HTML or a live app (Python, Rust, Node, Go…)
// — in the webview, streaming its startup logs into the code panel until it
// binds a port, then swapping to element-inspection on hover.
const preview = document.getElementById('preview');
const previewStage = document.getElementById('preview-stage');
const previewTitle = document.getElementById('preview-title');
const previewCrumb = document.getElementById('preview-crumb');
const previewHtml = document.getElementById('preview-html');
const previewEmpty = document.getElementById('preview-empty');

let previewMode = 'idle';   // idle | starting | live
let previewLog = '';        // accumulated process output while starting
let previewUrl = '';        // URL of the live preview, for "open in browser"
let previewCwd = '';        // project the preview belongs to
let openInBrowserOnReady = false; // the run menu asked for the browser, not the dock

// The <webview> is created on demand rather than declared in index.html.
// Electron reads `preload` when the element attaches to the document and
// ignores the attribute afterwards, and the inspector's preload path only
// arrives from main asynchronously — so the element has to be built with the
// attribute already on it. Declared in markup it attaches preload-less, and
// the code panel stays empty however long you hover.
let previewView = null;

async function ensureWebview() {
  if (previewView) return previewView;

  const view = document.createElement('webview');
  view.id = 'preview-view';
  const purl = await window.api.getPreviewPreloadUrl();
  if (purl) view.setAttribute('preload', purl);
  view.setAttribute('src', 'about:blank');

  // Element inspector messages from the running page. Only meaningful once live.
  view.addEventListener('ipc-message', (e) => {
    if (e.channel !== 'inspect' || previewMode !== 'live') return;
    const d = e.args[0] || {};
    if (d.resume) { previewCrumb.textContent = t('preview.hover'); return; }
    previewCrumb.textContent = (d.pinned ? '📌 ' : '') + (d.path || '');
    previewHtml.textContent = d.html || '';
  });

  // Ahead of #preview-empty so the status overlay keeps covering it.
  previewStage.prepend(view);
  previewView = view;
  return view;
}

function setEmptyMessage(html) {
  previewEmpty.innerHTML = html;
  previewEmpty.classList.remove('hidden');
  if (previewView) previewView.classList.add('dim');
}
function showWebview() {
  previewEmpty.classList.add('hidden');
  if (previewView) previewView.classList.remove('dim');
}

// `external: true` means the caller only wants the URL (to hand to the desktop
// browser), so we start the process without unfolding the dock over the panels.
async function openPreview({ external = false } = {}) {
  const t = tabs.get(activeId);
  if (!t || !t.cwd) { toast(window.t('toast.openProject')); return; }
  if (!external) preview.classList.remove('collapsed');

  const view = await ensureWebview();

  previewMode = 'starting';
  previewLog = '';
  previewUrl = '';
  previewCwd = t.cwd;
  previewTitle.textContent = `👁 ${t.name}`;
  previewCrumb.textContent = window.t('preview.starting');
  previewHtml.textContent = '';
  view.src = 'about:blank';
  setEmptyMessage(`<p class="spin">◐</p><p>${window.t('preview.startingName', { name: t.name })}</p>`
    + `<p class="hint">${window.t('preview.seeLog')}</p>`);
  await window.api.startPreview(t.cwd);
}

// Lifecycle events from the preview runner in main.
window.api.onPreviewEvent((d) => {
  if (d.type === 'log') {
    if (d.name) previewTitle.textContent = `👁 ${d.name}`;
    if (d.label) previewCrumb.textContent = `▶ ${d.label}…`;
    previewLog += d.line;
    if (previewLog.length > 24000) previewLog = previewLog.slice(-24000);
    if (previewMode === 'starting') {
      previewHtml.textContent = previewLog;
      previewHtml.scrollTop = previewHtml.scrollHeight;
    }
  } else if (d.type === 'ready') {
    previewMode = 'live';
    previewUrl = d.url;
    showWebview();
    previewHtml.textContent = '';
    previewCrumb.textContent = d.kind === 'static'
      ? t('preview.hover')
      : `🟢 ${d.label} · ${d.url}`;
    // Hand it to the browser instead of the webview when that's what was asked
    // for — loading it here too would just hit the dev server twice.
    if (openInBrowserOnReady) {
      openInBrowserOnReady = false;
      window.api.openExternal(d.url);
      toast(window.t('toast.siteOpened', { url: d.url }));
    } else if (previewView) {
      previewView.src = d.url;
    }
  } else if (d.type === 'error') {
    previewMode = 'idle';
    openInBrowserOnReady = false;
    previewCrumb.textContent = '⚠ ' + d.message;
    setEmptyMessage(`<p>⚠</p><p>${d.message}</p><p class="hint">${t('preview.details')}</p>`);
    if (previewLog) previewHtml.textContent = previewLog;
    toast(d.message);
  }
});

document.getElementById('preview-btn').addEventListener('click', () => openPreview());

// ---- Run menu ----
// Two things you may want from the project in front of you, and they are not
// the same thing: run it as the app it actually is (its own window, Electron
// and Tauri included — the preview dock can't host those), or just look at the
// site it serves, in a real browser.
const runBtn = document.getElementById('run-btn');
const runMenu = document.getElementById('run-menu');
const runningApps = new Set();  // project paths currently running

function activeProject() {
  const t = tabs.get(activeId);
  if (!t || !t.cwd) { toast(window.t('toast.openProject')); return null; }
  return t;
}

// The first menu item doubles as the stop switch once the app is up.
function syncRunUI() {
  const t = tabs.get(activeId);
  const on = !!(t && t.cwd && runningApps.has(t.cwd));
  runBtn.classList.toggle('running', on);
  runMenu.querySelector('[data-run="app"] .mi-label').textContent =
    window.t(on ? 'run.stopApp' : 'run.startApp');
  runMenu.querySelector('[data-run="app"] .mi-hint').textContent =
    window.t(on ? 'run.stopApp.hint' : 'run.startApp.hint');
}

function closeRunMenu() {
  runMenu.classList.add('hidden');
  runBtn.setAttribute('aria-expanded', 'false');
}

runBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = runMenu.classList.contains('hidden');
  if (open) syncRunUI();
  runMenu.classList.toggle('hidden', !open);
  runBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', closeRunMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRunMenu(); });

runMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item');
  if (!item) return;
  closeRunMenu();
  if (item.dataset.run === 'app') toggleApp();
  else openSiteInBrowser();
});

// ---- Agent menu ----
// Picks what the active project's terminal starts: any agent CLI found on PATH,
// or a plain shell. The choice belongs to the project, so a tab that is already
// running keeps the CLI it was opened with and takes the new one next time.
// (agentBtn / agentMenu are resolved with the rest of the agent state above.)

function agentLabel(id) {
  const spec = agentList.find((a) => a.id === id);
  return spec ? spec.label : id;
}

function renderAgentBtn() {
  const t = tabs.get(activeId);
  const project = t && t.cwd;
  agentBtn.textContent = project
    ? `🤖 ${agentLabel(agentFor(t))} ▾`
    : `🤖 ${window.t('rail.agent')} ▾`;
  agentBtn.disabled = !project;
  agentBtn.title = project
    ? window.t('rail.agent.title.project', { project: t.name })
    : window.t('rail.agent.title');
}

function renderAgentMenu() {
  const t = tabs.get(activeId);
  const current = t && t.cwd ? agentFor(t) : null;
  agentMenu.innerHTML = '';
  for (const a of agentList) {
    const item = document.createElement('button');
    item.className = 'menu-item' + (a.id === current ? ' current' : '');
    item.setAttribute('role', 'menuitem');
    item.dataset.agent = a.id;
    const label = document.createElement('span');
    label.className = 'mi-label';
    label.textContent = (a.id === current ? '✓ ' : '') + a.label;
    const hint = document.createElement('span');
    hint.className = 'mi-hint';
    hint.textContent = a.hint ? window.t(a.hint) : (a.command || '');
    item.append(label, hint);
    agentMenu.appendChild(item);
  }
}

function closeAgentMenu() {
  agentMenu.classList.add('hidden');
  agentBtn.setAttribute('aria-expanded', 'false');
}

agentBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const open = agentMenu.classList.contains('hidden');
  if (open) {
    // Re-read on open: an agent installed since boot should be selectable
    // without restarting TabDesk.
    const fresh = await window.api.listAgents();
    if (fresh && fresh.length) agentList = fresh;
    renderAgentMenu();
    renderAgentBtn();
  }
  agentMenu.classList.toggle('hidden', !open);
  agentBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', closeAgentMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAgentMenu(); });

agentMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.menu-item');
  if (!item) return;
  e.stopPropagation();
  closeAgentMenu();
  const t = tabs.get(activeId);
  if (!t || !t.cwd) return;
  const id = item.dataset.agent;
  if (id === agentFor(t)) return;

  const res = await window.api.setAgent(t.cwd, id);
  if (!res || !res.ok) {
    toast(window.t('toast.agentFailed', { error: (res && res.error) || '' }));
    return;
  }
  t.agent = res.agent;
  agentByProject[t.cwd] = res.agent;
  renderAgentBtn();
  // A running terminal was started by the old CLI and can't be swapped under it.
  toast(window.t(t.materialized ? 'toast.agentLater' : 'toast.agentSet',
    { project: t.name, agent: agentLabel(res.agent) }));
});

// A plain terminal, no project and no agent — the same thing the picker's
// "Terminal" row opens, one click closer.
document.getElementById('term-btn').addEventListener('click', () => {
  setActive(buildTab({ name: `Terminal ${++adHoc}`, cwd: null, atTop: true }));
});

renderAgentBtn();

async function toggleApp() {
  const t = activeProject();
  if (!t) return;
  if (runningApps.has(t.cwd)) {
    await window.api.stopApp(t.cwd);
    runningApps.delete(t.cwd);
    syncRunUI();
    toast(window.t('toast.appStopped', { name: t.name }));
    return;
  }
  // Failures come back as an 'app' event below, so nothing to report here.
  await window.api.runApp(t.cwd);
}

async function openSiteInBrowser() {
  const t = activeProject();
  if (!t) return;
  // A preview already serving this project has the URL; anything else needs
  // the runner started first (its logs still land in the dock).
  if (previewMode === 'live' && previewUrl && previewCwd === t.cwd) {
    window.api.openExternal(previewUrl);
    toast(window.t('toast.siteOpened', { url: previewUrl }));
    return;
  }
  openInBrowserOnReady = true;
  toast(window.t('toast.siteStarting', { name: t.name }));
  await openPreview({ external: true });
}

window.api.onAppEvent((d) => {
  if (d.type === 'started') {
    runningApps.add(d.path);
    if (!d.already) toast(window.t('toast.appStarted', { label: d.label }));
  } else if (d.type === 'exit') {
    runningApps.delete(d.path);
    if (d.code) toast(window.t('toast.appExited', { name: d.name, code: d.code }));
  } else if (d.type === 'error') {
    runningApps.delete(d.path);
    if (d.code === 'site-only') toast(window.t('toast.runUseSite', { name: d.name }));
    else if (d.code === 'nothing-to-run') toast(window.t('toast.runNothing', { name: d.name }));
    else toast(d.message);
  }
  syncRunUI();
});
window.ui.onChange(syncRunUI);   // labels are baked into JS, so re-render them
document.getElementById('preview-collapse').addEventListener('click', () => {
  preview.classList.toggle('collapsed');
  // Content width changed -> reposition embedded terminals after reflow.
  requestAnimationFrame(scheduleSync);
});
document.getElementById('preview-reload').addEventListener('click', () => {
  if (previewMode === 'live') { try { previewView.reload(); } catch (_) { /* not loaded */ } }
  else openPreview();
});

// Populate the rail with all projects, most-recently-used first. A project
// whose tab was closed with the × stays out until it is picked again.
window.api.listProjects().then((projects) => {
  for (const p of projects) {
    if (p.closed) continue;
    buildTab({ name: p.name, cwd: p.path, model: p.model });
  }
});

// ---- Model picker (bottom system bar) ----
// The model belongs to the project, not to the app: the bar always shows the
// active tab's model, and switching tabs switches what it shows. That keeps an
// expensive model on one project from eating every other project's usage.
// The pick becomes a --model flag when that project's terminal starts, so a
// session already running keeps its own until you /model inside it.
const modelBtn = document.getElementById('model-btn');
const modelMenu = document.getElementById('model-menu');
const bootModel = (window.api.boot && window.api.boot.model) || {};
let modelList = bootModel.list || [];
let globalModel = bootModel.global || 'default';

// Unknown ids (someone pinned a full model name by hand) show as-is rather
// than falling back to something that isn't what's actually configured.
function modelEntry(id) {
  return modelList.find((m) => m.id === id) || { id, label: id, hint: null };
}

// The model of the tab in focus — that's what the picker acts on.
function activeModel() {
  const t = tabs.get(activeId);
  return (t && t.model) || 'default';
}

// 'default' has no label of its own worth showing in a 12px bar; show what it
// actually resolves to, marked as inherited.
function barLabel(id) {
  if (id !== 'default') return modelEntry(id).label;
  return globalModel === 'default' ? t('bar.model.auto') : modelEntry(globalModel).label;
}

function renderModelBtn() {
  const tab = tabs.get(activeId);
  const id = activeModel();
  // A terminal keeps the model it launched with. Say so in the bar rather than
  // only in a toast: while a terminal is open it covers the toast area (native
  // X window on top of the page), so that message can go unseen.
  const pending = !!(tab && tab.materialized && tab.runningModel !== tab.model);
  modelBtn.textContent = barLabel(id) + (pending ? ' •' : '');
  modelBtn.classList.toggle('inherited', id === 'default' && !pending);
  modelBtn.classList.toggle('pending', pending);
  // Only project tabs auto-start Claude; an ad-hoc shell has nothing to flag.
  modelBtn.disabled = !tab || !tab.cwd;
  modelBtn.title = !tab || !tab.cwd
    ? t('bar.model.none')
    : (pending
      ? t('bar.model.pending', { model: barLabel(tab.runningModel) })
      : t('bar.model.title', { project: tab.name }));
}

function renderModelMenu() {
  const id = activeModel();
  modelMenu.innerHTML = '';
  for (const m of modelList) {
    const item = document.createElement('button');
    item.className = 'menu-item' + (m.id === id ? ' current' : '');
    item.setAttribute('role', 'menuitem');
    item.dataset.model = m.id;
    const label = document.createElement('span');
    label.className = 'mi-label';
    label.textContent = (m.id === id ? '✓ ' : '') + m.label;
    const hint = document.createElement('span');
    hint.className = 'mi-hint';
    // The "Default" row spells out what following Claude Code means today.
    hint.textContent = m.id === 'default'
      ? t('model.hint.default', { model: barLabel('default') })
      : (m.hint ? t(m.hint) : m.id);
    item.append(label, hint);
    modelMenu.appendChild(item);
  }
}

function closeModelMenu() {
  modelMenu.classList.add('hidden');
  modelBtn.setAttribute('aria-expanded', 'false');
}

modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = modelMenu.classList.contains('hidden');
  if (open) renderModelMenu();
  modelMenu.classList.toggle('hidden', !open);
  modelBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', closeModelMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelMenu(); });

modelMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.menu-item');
  if (!item) return;
  e.stopPropagation();
  closeModelMenu();
  const tab = tabs.get(activeId);
  if (!tab || !tab.cwd) return;
  const id = item.dataset.model;
  if (id === tab.model) return;

  const res = await window.api.setModel(tab.cwd, id);
  if (!res || !res.ok) {
    toast(window.t('toast.modelFailed', { error: (res && res.error) || '' }));
    return;
  }
  tab.model = res.model;
  renderModelBtn();

  const label = barLabel(tab.model);
  // A live terminal was launched with the old flag and can't be re-flagged.
  toast(tab.materialized
    ? window.t('toast.modelLater', { project: tab.name, model: label })
    : window.t('toast.modelSet', { project: tab.name, model: label }));
});

// What "Default" resolves to can change under us (an editor, claude config).
window.api.onGlobalModelChanged((id) => {
  globalModel = id;
  renderModelBtn();
  if (!modelMenu.classList.contains('hidden')) renderModelMenu();
});

// An import can rewrite the per-project model map wholesale. Re-read it for
// every open tab rather than trust what each one cached at open time.
window.api.onPortableImported(({ models }) => {
  for (const tab of tabs.values()) {
    if (!tab.cwd) continue;
    tab.model = (models && models[tab.cwd]) || 'default';
  }
  renderModelBtn();
  if (!modelMenu.classList.contains('hidden')) renderModelMenu();
});

renderModelBtn();

// The boot payload is synchronous and can miss if main wasn't listening yet;
// re-read over IPC so the bar is right either way.
if (!modelList.length) {
  Promise.all([window.api.listModels(), window.api.getGlobalModel()]).then(([list, id]) => {
    modelList = list || [];
    globalModel = id || globalModel;
    renderModelBtn();
  });
}

// ---- Bottom system bar ----
function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n | 0);
}
function fmtCost(c) { return '≈$' + (c >= 100 ? c.toFixed(0) : c.toFixed(2)); }
function fmtBytes(b) { return (b / 1073741824).toFixed(1) + 'G'; }
function pct(v, max) { return max > 0 ? Math.min(100, (v / max) * 100) : 0; }

function setMeter(sel, fillPct, valText, hot) {
  const el = document.getElementById(sel);
  const fill = el.querySelector('.m-fill');
  fill.style.width = fillPct.toFixed(1) + '%';
  fill.classList.toggle('hot', !!hot);
  el.querySelector('.m-val').textContent = valText;
}
function setStat(sel, valText) {
  document.getElementById(sel).querySelector('.m-val').textContent = valText;
}

function setMeterLabel(sel, key) {
  const el = document.getElementById(sel).querySelector('.m-label');
  el.dataset.i18n = key;          // keeps it in the declarative re-translate sweep
  el.textContent = t(key);
}

// A label that comes from the API (a model name) isn't translatable, and must
// not be re-stamped by the language sweep — so it drops the data-i18n hook.
function setMeterLabelRaw(sel, text) {
  const el = document.getElementById(sel).querySelector('.m-label');
  delete el.dataset.i18n;
  el.textContent = text;
}

// The three meters read the plan's own quota when we can reach it, and the
// local transcript estimate when we can't. Both states are legible on their
// own; what's not acceptable is a bar that silently shows one while looking
// like the other, so the labels and titles change with the mode.
const PLAN_METERS = [['m-session', 'session'], ['m-week', 'week'], ['m-scoped', 'scoped']];
let usage = null;          // last local scan
let limits = { ok: false }; // last plan-limit read

// The API grades each window itself; trust that when it's there and fall back
// to a threshold of our own when it isn't.
const HOT_SEVERITIES = ['warning', 'critical', 'exhausted'];
function meterHot(win) {
  if (win.severity) return HOT_SEVERITIES.includes(win.severity);
  return win.pct >= 80;
}

// t() echoes unknown keys back, so an HTTP status can't be interpolated into
// one — anything outside the known set goes through a generic string.
const REASONS = ['no-token', 'auth', 'network', 'timeout', 'shape'];
function reasonText(r) {
  return REASONS.includes(r) ? t(`bar.reason.${r}`) : t('bar.reason.other', { code: r || '?' });
}

function renderPlanMeters() {
  for (const [sel, key] of PLAN_METERS) {
    const el = document.getElementById(sel);
    const win = limits[key];
    // Not every plan meters every window (Opus in particular) — a window the
    // account doesn't have is hidden, not shown at zero.
    el.classList.toggle('hidden', !win);
    if (!win) continue;
    if (win.label) setMeterLabelRaw(sel, win.label);
    else setMeterLabel(sel, `bar.${key}`);
    setMeter(sel, win.pct, Math.round(win.pct) + '%', meterHot(win));
    el.title = t(limits.stale ? 'bar.planTitleStale' : 'bar.planTitle');
  }
}

// Fallback: no plan quota, so the two meters revert to what the transcripts can
// tell us — tokens spent today and this week, scaled against your own busiest
// day/week on record. Same numbers the bar showed before, honestly labelled.
function renderLocalMeters() {
  document.getElementById('m-scoped').classList.add('hidden');
  const pairs = [
    ['m-session', 'bar.daily', usage && usage.today, usage && usage.peakDay],
    ['m-week', 'bar.weekly', usage && usage.week, usage && usage.peakWeek],
  ];
  for (const [sel, key, bucket, peak] of pairs) {
    const el = document.getElementById(sel);
    el.classList.remove('hidden');
    setMeterLabel(sel, key);
    if (!bucket) { setMeter(sel, 0, '–'); continue; }
    setMeter(sel, pct(bucket.tokens, peak), fmtTokens(bucket.tokens));
    el.title = t('bar.localTitle', { reason: reasonText(limits.reason) });
  }
}

function renderMeters() {
  if (limits.ok) renderPlanMeters();
  else renderLocalMeters();
  tickResets();
}

// The plan windows are the live number, so they refresh on their own (cheap)
// timer. Main caches them for a minute, so polling faster than that only costs
// an IPC round trip.
async function refreshLimits() {
  limits = (await window.api.getUsageLimits()) || { ok: false, reason: 'network' };
  renderMeters();
}

// The transcript scan walks every .jsonl under ~/.claude/projects — worth doing
// rarely. It feeds Total/Msgs, and the meters too whenever the plan quota is
// out of reach.
async function refreshUsage() {
  const u = await window.api.getUsageStats();
  if (!u) return;
  usage = u;
  renderMeters();
  setStat('m-total', `${fmtTokens(u.total.tokens)} · ${fmtCost(u.total.cost)}`);
  setStat('m-msgs', String(u.today.msgs));
  document.getElementById('m-total').title =
    t('bar.totalTitle', { tokens: u.total.tokens.toLocaleString(), days: u.total.days });
}

async function refreshSystem() {
  const s = await window.api.getSystemStats();
  if (!s) return;
  setMeter('m-cpu', s.cpu, s.cpu + '%', s.cpu >= 85);
  const memPct = (s.memUsed / s.memTotal) * 100;
  setMeter('m-ram', memPct, fmtBytes(s.memUsed), memPct >= 90);
}

function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

// Countdown under each meter. In plan mode these are the account's real reset
// timestamps. In local mode only the daily bucket has a boundary to count down
// to — the local week is a rolling 7-day window that never resets — so the week
// meter shows no countdown rather than a made-up one.
function tickResets() {
  const now = Date.now();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);

  for (const [sel, key] of PLAN_METERS) {
    const node = document.querySelector(`#${sel} .m-reset`);
    if (!node) continue;
    const at = limits.ok
      ? (limits[key] && limits[key].resetsAt)
      : (sel === 'm-session' ? midnight.getTime() : null);
    node.textContent = at ? t('bar.reset', { time: fmtCountdown(at - now) }) : '';
  }
}

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  document.getElementById('m-clock').textContent =
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  tickResets();
}

// Strings and colours baked into JS (button labels, live xterm palettes) don't
// come along with the declarative data-i18n sweep — re-apply them by hand when
// the desktop's theme or language changes under us.
window.ui.onChange((kind, payload) => {
  if (kind === 'language') {
    updateGridBtn();
    renderModelBtn();
    if (!modelMenu.classList.contains('hidden')) renderModelMenu();
    for (const t of tabs.values()) {
      t.tabEl.querySelector('.close').title = window.t('tab.close');
      if (t.panelEl) {
        const pc = t.panelEl.querySelector('.panel-close');
        if (pc) pc.title = window.t('panel.close');
      }
    }
  } else if (kind === 'theme' && payload.terminal) {
    for (const t of tabs.values()) {
      if (t.term) t.term.options.theme = payload.terminal;
    }
  }
});

// Picking a tab from the tray menu goes through the same setActive() as a click
// in the rail — the tray is a remote control, not a second code path.
// Guarded so a preload that predates the tray can't take the renderer down.
if (window.api.onTraySelect) {
  window.api.onTraySelect((id) => { if (tabs.has(id)) setActive(id); });
}

refreshLimits();
refreshUsage();
refreshSystem();
tickClock();
syncTray();   // seed the menu with the empty state before the first tab opens
setInterval(refreshSystem, 2000);
setInterval(tickClock, 1000);
setInterval(refreshLimits, 60000);  // plan quota: the number that actually moves
setInterval(refreshUsage, 300000);  // re-scan transcripts every 5 min
