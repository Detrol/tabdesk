const { Terminal } = window;          // xterm global
const { FitAddon } = window.FitAddon; // fit addon global

const railList = document.getElementById('tab-list');
const strip = document.getElementById('strip');
const panels = document.getElementById('panels');
const emptyState = document.getElementById('empty-state');

// Terminal backend. true: embed a real native terminal (xterm) per panel as an
// X11 window reparented over the panel. false: in-app xterm.js (renders in the
// DOM). Native embedding is X11-only, and being a window of its own rather than
// DOM is what the screenshot button has to work around.
// Off on this fork: the pty path needs no xterm/xdotool on the host, screenshots
// capture the DOM directly, and killing a tab reaches only the tmux client in
// the pty — the session (see wrapStartCmd in main.js) lives on either way.
const EMBED_NATIVE = false;

let seq = 0;

// Two levels, the way a project actually works: the rail picks a project, the
// strip above the terminals picks one of that project's sessions. `activeCwd`
// is the project in front of you and is set as soon as one is chosen;
// `activeId` is the session in front of you, and is null while the project's
// overview is showing instead.
let activeId = null;
let activeCwd = null;
const projects = new Map();  // project path -> row record
const tabs = new Map();      // id -> session record

// Panels held on screen by the ▦ button, whatever the rail points at now. The
// session in focus is shown beside them, so pinning nothing still shows one.
const pinned = new Set();
const MAX_PANELS = 6;

// How long a background tab must stay silent before we call its command "done".
// Claude's spinner streams output while it works; a static TUI (finished, or
// waiting for input) stops emitting, so a quiet gap means "your turn".
const IDLE_MS = 1500;

// A session is "watched" while it has a panel on screen — no need to flag it.
function isWatched(id) { return pinned.has(id) || id === activeId; }

// The sessions belonging to a project, in the order they were opened. A
// worktree session belongs to the project it branches from, not to a rail row
// of its own.
function sessionsOf(cwd) {
  return [...tabs.values()].filter((t) => t.projectCwd === cwd);
}

// The project's own first tab: what it has running and what it has run before.
// It is a panel rather than a screen of its own so that it can share the grid
// with the sessions you pinned — reading the summary shouldn't hide the work.
const overviewEl = document.createElement('div');
overviewEl.className = 'panel overview';
panels.appendChild(overviewEl);
let overviewCwd = null;      // the project the overview is showing, if any
let stripOverview = null;    // its tab in the strip, while one is rendered

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
        name: fullName(t),
        cwd: t.cwd || null,
        busy: !!t.busy,
      })),
    });
  });
}

// How long a finished tab has been waiting, as the badge shows it. Minutes
// until an hour, then hours and minutes — a rotation is decided on "which has
// waited longest", not on seconds.
function waitLabel(since) {
  const mins = Math.floor((Date.now() - since) / 60000);
  if (mins < 1) return '';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
}

function renderWaitEl(el, since) {
  if (!el) return;
  const text = since ? waitLabel(since) : '';
  if (el.textContent === text) return;   // one DOM write a minute, not one a second
  el.textContent = text;
  el.title = text ? window.t('tab.waiting', { time: text }) : '';
}

function renderWait(t) {
  renderWaitEl(t.tabEl.querySelector('.wait'), t.doneAt);
}

// A project row says what its sessions are doing, since they are only listed
// once the project is selected. The worst state wins — a dead session is worth
// knowing about even while another one works — and the wait badge counts from
// whichever session has been waiting longest, which is the one the rotation is
// deciding about.
function renderProject(cwd) {
  const p = projects.get(cwd);
  if (!p) return;
  const mine = sessionsOf(cwd);
  const el = p.el;
  el.classList.toggle('dead', mine.some((t) => t.dead));
  el.classList.toggle('done', mine.some((t) => t.doneAt));
  el.classList.toggle('busy', mine.some((t) => t.busy));
  el.classList.toggle('idle', mine.length === 0);
  const waits = mine.map((t) => t.doneAt).filter(Boolean);
  renderWaitEl(el.querySelector('.wait'), waits.length ? Math.min(...waits) : 0);
  const count = el.querySelector('.count');
  count.textContent = mine.length ? String(mine.length) : '';
  count.title = mine.length ? window.t('rail.sessions', { n: mine.length }) : '';
}

// Clear any busy/done flags on a session (called when the user looks at it).
function clearTabFlag(t) {
  clearTimeout(t.idleTimer);
  const wasBusy = t.busy;
  t.busy = false;
  t.doneAt = 0;
  t.tabEl.classList.remove('busy', 'done');
  renderWait(t);
  renderProject(t.projectCwd);
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
// It is the project row that moves, not the session tab: the strip is a fixed
// list you read left to right, and reordering it would shuffle tabs under the
// cursor. The rail is the long list that needs the finished work brought up.
function hoistOnDone(t) {
  const p = projects.get(t.projectCwd);
  if (!p) return;
  // The projects-folder row is the rail's fixed home and keeps the top spot;
  // finished projects surface right under it.
  const first = railList.firstElementChild;
  if (first === p.el) return;
  if (first && first.classList.contains('root') && !p.el.classList.contains('root')) {
    first.after(p.el);
  } else {
    railList.prepend(p.el);
  }
}

// Called on every chunk of pty output (xterm.js backend) or whenever the
// embedded terminal writes. Marks background tabs busy while output flows, then
// green ("done") once they fall silent.
function markActivity(id) {
  const t = tabs.get(id);
  if (!t || t.dead) return;

  // Output while it streams only ever changes a tab's colour. The move comes
  // later, when it stops — see hoistOnDone().
  if (isWatched(id)) { clearTabFlag(t); return; }

  const wasBusy = t.busy;
  t.busy = true;
  t.doneAt = 0;
  t.tabEl.classList.add('busy');
  t.tabEl.classList.remove('done');
  renderWait(t);
  renderProject(t.projectCwd);
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
      t.doneAt = Date.now();
      hoistOnDone(t);
    }
    renderProject(t.projectCwd);
    syncTray();
  }, IDLE_MS);
}

// What the panel area holds: everything pinned to the grid, plus the session
// in focus. Pinning nothing therefore still shows the one you are working in.
function shownIds() {
  const ids = [...pinned].filter((id) => tabs.has(id)).slice(0, MAX_PANELS);
  if (activeId && tabs.has(activeId) && !ids.includes(activeId)) ids.push(activeId);
  return ids;
}

function setActive(id) {
  const t = tabs.get(id);
  if (!t) return;
  // A session names its own project: reaching one from the tray, or from a
  // strip the rail has not caught up with, has to move the rail too.
  if (activeCwd !== t.projectCwd) selectProject(t.projectCwd, { open: false });
  overviewCwd = null;
  if (!t.materialized) materialize(t);

  // Opening a tab means you're now watching it — drop the "done" flag. It keeps
  // whatever place in the rail it earned; clearing the flag is not a demotion.
  clearTabFlag(t);

  activeId = id;
  const p = projects.get(t.projectCwd);
  if (p) p.lastId = id;                  // where this project reopens next time
  applyLayout();
  for (const vid of shownIds()) fitSoon(vid);
  scheduleSync();
  // The dock is fixed and does not belong to any one tab, so switching projects
  // is the moment it can start lying about which one it holds.
  syncPreviewToActive();
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

// ---- Dropping files onto a pane ----
//
// The path lands at the prompt, quoted, with NO newline. A drop hands you an
// argument to look at; it must never run anything. Filenames are attacker-
// controlled in a way people forget — a repo can ship one called `; rm -rf ~`
// — so the quoting matters even though you are the one pressing Enter.
//
// On the native backend this looks like it cannot work at all, since the
// terminal is an X window stacked above the page. It works because xterm sets
// no XdndAware property: a drag source that finds no drop target under the
// pointer walks up to the nearest ancestor that has one, which is the Electron
// window. Chromium then hit-tests the DOM at those coordinates and finds this
// panel. What we genuinely cannot do is highlight the drop target — anything
// the page paints there is behind the terminal.
function shellQuote(p) {
  return `'${String(p).replace(/'/g, "'\\''")}'`;
}

const dragHasFiles = (dt) => !!dt && Array.from(dt.types || []).includes('Files');

function wireDrop(panelEl, id, deliver) {
  // Without a dragover that preventDefaults, no drop event fires at all — and
  // Chromium's default action takes over instead: it navigates the window to
  // the dropped file. The app is then gone, replaced by a file listing, with
  // no way back short of a restart.
  panelEl.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  panelEl.addEventListener('drop', async (e) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.pathForFile(f))
      .filter(Boolean);
    if (!paths.length) return;

    // Drop on a pane you weren't in: that pane is what you meant.
    if (activeId !== id) { activeId = id; applyLayout(); }

    // Trailing space, so a second drop appends another argument rather than
    // gluing itself to the first.
    const ok = await deliver(paths.map(shellQuote).join(' ') + ' ');
    if (!ok) toast(window.t('toast.dropFailed'));
  });
}

// Everywhere that is not a pane, a dropped file would navigate the window and
// take the app down with it. Nothing outside a pane accepts drops, so the whole
// document refuses them.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    if (dragHasFiles(e.dataTransfer)) e.preventDefault();
  });
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
// Main declined to start a terminal for an untrusted synced project. Undo the
// materialization so the panel is not left blank and pressing the tab again
// asks once more, rather than the tab looking permanently broken.
window.api.onTerminalDeclined(({ id }) => {
  const t = tabs.get(id);
  if (!t) return;
  if (t.cleanup) { try { t.cleanup(); } catch (_) { /* already gone */ } }
  if (t.panelEl) t.panelEl.remove();
  Object.assign(t, { materialized: false, embed: false, panelEl: null, term: null, cleanup: null });
  pinned.delete(id);
  if (activeId === id) activeId = null;
  applyLayout();
  toast(window.t('trust.declined'));
});

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

// Lay out the panels on screen in a grid and highlight the focused one. The
// overview is a panel like any other, so a project's summary can sit beside the
// sessions you pinned rather than replacing them.
function applyLayout() {
  const ids = shownIds();
  const n = ids.length + (overviewCwd ? 1 : 0);
  emptyState.classList.toggle('hidden', n > 0);

  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));
  panels.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  panels.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  overviewEl.classList.toggle('shown', !!overviewCwd);
  overviewEl.classList.toggle('focused', !!overviewCwd && n > 1);

  for (const [tid, tt] of tabs) {
    const shown = ids.includes(tid);
    tt.tabEl.classList.toggle('active', shown);
    tt.tabEl.classList.toggle('focused', tid === activeId);
    tt.tabEl.classList.toggle('pinned', pinned.has(tid));
    if (tt.panelEl) {
      tt.panelEl.classList.toggle('shown', shown);
      tt.panelEl.classList.toggle('focused', tid === activeId && n > 1);
      tt.panelEl.classList.toggle('pinned', pinned.has(tid));
    }
  }
  for (const [cwd, p] of projects) {
    p.el.classList.toggle('selected', cwd === activeCwd);
    p.el.classList.toggle('pinned', sessionsOf(cwd).some((t) => pinned.has(t.id)));
  }
  if (stripOverview) stripOverview.classList.toggle('focused', !!overviewCwd);
  // The model and the agent belong to the session in focus, so both follow it.
  renderModelBtn();
  renderAgentBtn();
  syncGridBtn();
  scheduleSync();
  // So do the usage meters — focusing a Codex tab swaps the bar to Codex's
  // windows. Cached in main, so a focus change costs an IPC round trip.
  if (focusedAgent() !== metersAgent) refreshLimits();
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
// Copied, not aliased: contextBridge hands the boot payload over deep-frozen,
// and this map is written to whenever an agent is picked. Assigning to the
// frozen original fails silently (this is a classic script, so no strict mode
// to throw), leaving every later reader on the boot-time answer.
let agentByProject = { ...(bootAgents.byProject || {}) };  // cwd -> agent id
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

  // Picking an earlier conversation up again. No model flag goes with it: the
  // conversation already has one, and overriding it here would silently change
  // what the user is resuming.
  if (t.resume) {
    const args = t.resume.id
      ? (spec.resumeArgs && SAFE_ID.test(t.resume.id)
        ? spec.resumeArgs.replace('{id}', t.resume.id) : null)
      : spec.continueArgs;
    if (args) return `${spec.command} ${args}`;
  }

  const flag = spec.takesModel && t.model && t.model !== 'default'
    ? ` --model '${t.model}'` : '';
  return spec.command + flag;
}

// Ids come from history.js, which only emits ones that cannot be read as a
// flag or a quote. Checked again here because this is where one becomes part
// of a command line.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Which CLI a tab starts. The tab owns the answer — two tabs on one project
// can run different agents, so the project's stored pick is only the seed a
// new tab is born with (agentSeed below). Mirrors agents.getFor() in main,
// including its fallback: an agent that has since been uninstalled must not
// leave a tab starting a command that no longer exists.
function agentFor(t) {
  if (!t.cwd) return 'shell';
  const has = (id) => agentList.some((a) => a.id === id);
  const stored = t.agent || agentByProject[t.cwd];
  if (stored && has(stored)) return stored;
  if (has(agentFallback)) return agentFallback;
  const first = agentList.find((a) => a.id !== 'shell');
  return first ? first.id : 'shell';
}

// The agent id sent along to main for the tmux wrap — null for every tab that
// must NOT get a session: ad-hoc terminals (no cwd), the update installer and
// demo runs (their own startCmd). Its absence is the whole guard.
function tmuxAgentFor(t) {
  return (!t.startCmd && t.cwd) ? agentFor(t) : null;
}

// Build a session's tab in the strip. The terminal/pty is created lazily, and
// the element only enters the DOM while its project is the one selected —
// renderStrip() hangs it there, so a session keeps its flags and its wait
// badge while you work in another project.
//
// `projectCwd` is the rail row this session belongs under: its own directory
// for a project session, the parent project for a worktree, the project you
// were in for a loose terminal.
function buildTab({ name, cwd, projectCwd, model, agent, startCmd, resume }) {
  const id = `t${++seq}`;
  const tabEl = document.createElement('div');
  tabEl.className = 'stab';
  tabEl.title = cwd || name;
  tabEl.innerHTML = `
    <span class="dot"></span>
    <span class="label"></span>
    <span class="wait"></span>
    <button class="pin" title="${t('rail.pin')}">▦</button>
    <button class="close" title="${t('tab.close')}">×</button>`;
  tabEl.querySelector('.label').textContent = name;
  tabEl.addEventListener('click', (e) => {
    if (e.target.closest('.close') || e.target.closest('.pin')) return;
    setActive(id);
  });
  tabEl.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  tabEl.querySelector('.pin').addEventListener('click', (e) => {
    e.stopPropagation();
    pinSession(id);
  });

  // The agent is pinned onto the tab at birth — from an explicit pick, else
  // from what this project was last opened with. Pinning it now, rather than
  // resolving it at start time, is what stops a later pick elsewhere from
  // changing what this tab was going to run.
  const rec = {
    id, name, cwd, projectCwd: projectCwd || cwd || activeCwd,
    model: model || 'default', startCmd, resume: resume || null,
    tabEl, materialized: false, agent: agent || undefined,
  };
  if (cwd) rec.agent = agentFor(rec);
  tabs.set(id, rec);
  if (rec.projectCwd === activeCwd) renderStrip();
  renderProject(rec.projectCwd);
  syncTray();
  return id;
}

// A session's name in the strip says which CLI it runs (the rail already said
// which project), and a worktree session says which branch directory instead —
// that is what distinguishes it from the project's own sessions.
function sessionLabel(cwd, agent, projectCwd) {
  if (projectCwd && cwd && cwd !== projectCwd) return `⑂ ${cwd.split('/').pop()}`;
  return agentLabel(agent);
}

// For anywhere outside the strip — the tray, a screenshot filename, a toast —
// where the project name isn't already on screen next to it.
function fullName(t) {
  const p = projects.get(t.projectCwd);
  return p ? `${p.name} · ${t.name}` : t.name;
}

// Create the actual xterm instance + backing pty for a tab on first use.
function materialize(t) {
  const id = t.id;
  // The model this terminal is actually launching with — a later pick can't
  // reach the running process, so the bar compares against this.
  t.runningModel = t.model;
  // Same for the agent: once this tab is running one, that is what it is,
  // whatever the project is set to open next.
  t.agent = agentFor(t);

  const panelEl = document.createElement('div');
  panelEl.className = 'panel';
  const termEl = document.createElement('div');
  termEl.className = 'term';
  panelEl.appendChild(termEl);

  // Per-panel button, on the panes you pinned: it takes the pane out of the
  // grid and leaves the session running. Ending a session is the strip's ×,
  // where the tab you are ending is the thing you are clicking.
  const panelClose = document.createElement('button');
  panelClose.className = 'panel-close';
  panelClose.title = window.t('panel.unpin');
  panelClose.textContent = '×';
  panelClose.addEventListener('mousedown', (e) => e.stopPropagation());
  panelClose.addEventListener('click', (e) => { e.stopPropagation(); pinSession(id); });
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
    wireDrop(panelEl, id, (text) => window.api.insertIntoEmbed(id, text));
    window.api.createEmbedTerminal(id, t.cwd, startCmdFor(t), tmuxAgentFor(t), t.session || null, t.name);
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

  // In-app backend: the pty is ours, so the path goes straight down it.
  wireDrop(panelEl, id, (text) => { window.api.sendInput(id, text); return true; });

  window.api.createTerminal(id, term.cols, term.rows, t.cwd, startCmdFor(t), tmuxAgentFor(t), t.session || null, t.name);
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
    t.dead = true;
    t.tabEl.classList.add('dead');
    renderProject(t.projectCwd);
    if (overviewCwd === t.projectCwd) renderOverview(t.projectCwd);
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
  } else if (t.session) {
    // Never started, but it owns a session (restored, or reserved for a
    // duplicate) — main is the only one that can let it go.
    window.api.releaseSession(t.session);
  }
  t.tabEl.remove();
  tabs.delete(id);
  pinned.delete(id);
  const owner = t.projectCwd;
  const p = projects.get(owner);
  if (p && p.lastId === id) p.lastId = null;
  renderProject(owner);
  if (activeCwd === owner) renderStrip();

  // Closing the session you were in lands on a sibling if the project has one,
  // and on the project's own overview if it doesn't — never on some other
  // project's terminal, which is not where you were.
  if (activeId === id) {
    activeId = null;
    const left = sessionsOf(owner);
    if (left.length) { setActive(left[left.length - 1].id); return; }
    if (p) { showOverview(owner); return; }
  }
  applyLayout();
  syncTray();
  if (!tabs.size && !overviewCwd) emptyState.classList.remove('hidden');
}

// ---- Starting a session ----------------------------------------------------

// A worktree is a branch of a project, not a project: it belongs under the row
// its checkout came from, by the one-directory-per-branch convention.
function ownerOf(cwd) {
  const i = String(cwd).indexOf('/.worktrees/');
  return i > 0 ? cwd.slice(0, i) : cwd;
}

// Open another session in a project. The session name is reserved by main so
// two quick clicks can't pick the same one, and numbering is per agent: the
// first Codex session beside a Claude one is nobody's second session, so it
// stays unnumbered — unless a session that hasn't started yet is already
// promised that plain name, which only main can tell once it knows the slug.
async function newSession(cwd, agentId, { projectCwd, resume } = {}) {
  const owner = projectCwd || ownerOf(cwd);
  const agent = agentFor({ cwd, agent: agentId });
  const siblings = sessionsOf(owner).filter((x) => x.cwd === cwd);
  const basePromised = siblings.some(
    (x) => !x.session && !x.materialized && agentFor(x) === agent);
  const base = sessionLabel(cwd, agent, owner);
  const alloc = await window.api.allocateSession(cwd, agent, base, basePromised);

  let name = base;
  if (alloc && alloc.session && alloc.suffix) name = `${base} ·${alloc.suffix}`;

  // Models don't cross between agents, so ask for this agent's pick rather
  // than reusing whatever the project's default agent is set to.
  const model = await window.api.getModel(cwd, agent);
  const id = buildTab({ name, cwd, projectCwd: owner, model, agent, resume });
  if (alloc && alloc.session) tabs.get(id).session = alloc.session;
  setActive(id);
  return id;
}

// "+" in the rail is for a project the rail doesn't already carry: one outside
// the projects folder, a new one, or a plain terminal.
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
    // A loose terminal is the shell of the project you are in, not a project
    // of its own — it opens in that project's strip and is gone when closed.
    setActive(buildTab({ name: `Terminal ${++adHoc}`, cwd: null, projectCwd: activeCwd }));
    return;
  }

  // "Starts with" from the picker: an explicit override, stored against the
  // project exactly like the rail's agent menu stores it. Left untouched there,
  // it comes back undefined and the project keeps what it had.
  if (choice.agent) {
    const res = await window.api.setAgent(choice.path, choice.agent);
    if (res && res.ok) agentByProject[choice.path] = res.agent;
  }

  // Picking it is the undo for a project an earlier version hid: it belongs in
  // the rail again at the next start.
  window.api.setProjectClosed(choice.path, false);

  const owner = ownerOf(choice.path);
  if (!projects.has(owner)) {
    buildProject({ name: owner.split('/').pop(), path: owner, worktrees: [] }, { atTop: true });
  }
  selectProject(owner, { open: false });

  // A named runtime, or a worktree, is an ask to start something; a project on
  // its own is an ask to look at it.
  if (choice.agent || choice.path !== owner) {
    await newSession(choice.path, choice.agent, { projectCwd: owner });
  } else {
    selectProject(owner);
  }
});

// ---- The rail: projects ----------------------------------------------------

function buildProject(p, { atTop } = {}) {
  const el = document.createElement('li');
  el.className = 'tab project' + (p.root ? ' root' : '');
  el.title = p.path;
  el.innerHTML = `
    <span class="dot"></span>
    <span class="label"></span>
    <span class="wait"></span>
    <span class="count"></span>
    <button class="pin" title="${t('rail.pin')}">▦</button>`;
  el.querySelector('.label').textContent = p.name;
  el.addEventListener('click', (e) => {
    if (e.target.closest('.pin')) return;
    selectProject(p.path);
  });
  el.querySelector('.pin').addEventListener('click', (e) => {
    e.stopPropagation();
    pinProject(p.path);
  });
  if (atTop) railList.prepend(el);
  else railList.appendChild(el);

  const rec = {
    name: p.name, path: p.path, worktrees: p.worktrees || [], el, lastId: null,
  };
  projects.set(p.path, rec);
  renderProject(p.path);
  return rec;
}

// Clicking a project shows what it has. Something running is what you meant to
// get back to — the session you were last in — and nothing running means the
// overview, which is where one is started or an earlier one picked up.
function selectProject(cwd, { open = true } = {}) {
  if (!projects.has(cwd)) return;
  activeCwd = cwd;
  renderStrip();
  if (!open) { applyLayout(); return; }
  const p = projects.get(cwd);
  const mine = sessionsOf(cwd);
  const last = p.lastId && tabs.has(p.lastId)
    ? p.lastId
    : (mine.length ? mine[mine.length - 1].id : null);
  if (last) setActive(last);
  else showOverview(cwd);
}

function showOverview(cwd) {
  if (!projects.has(cwd)) return;
  activeCwd = cwd;
  overviewCwd = cwd;
  activeId = null;
  renderStrip();
  renderOverview(cwd);
  applyLayout();
  syncTray();
}

// ---- The strip: the selected project's sessions -----------------------------

function renderStrip() {
  const p = projects.get(activeCwd);
  const mine = sessionsOf(activeCwd);
  strip.textContent = '';
  stripOverview = null;
  strip.classList.toggle('hidden', !p && !mine.length);

  if (p) {
    const ov = document.createElement('button');
    ov.className = 'stab ov';
    ov.textContent = `▣ ${t('strip.overview')}`;
    ov.title = t('strip.overview.title', { project: p.name });
    ov.addEventListener('click', () => showOverview(p.path));
    strip.appendChild(ov);
    stripOverview = ov;
    if (overviewCwd === p.path) ov.classList.add('focused');
  }

  for (const s of mine) strip.appendChild(s.tabEl);

  if (p) {
    const add = document.createElement('button');
    add.className = 'stab add';
    add.textContent = '+';
    add.title = t('strip.new');
    add.addEventListener('click', (e) => { e.stopPropagation(); openStripMenu(add, p); });
    strip.appendChild(add);
  }
}

// "+" in the strip: another session in this project — under a runtime of your
// choosing, or in one of its worktrees.
const stripMenu = document.getElementById('strip-menu');

function closeStripMenu() { stripMenu.classList.add('hidden'); }

function openStripMenu(anchor, p) {
  stripMenu.textContent = '';
  const add = (label, hint, run) => {
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.setAttribute('role', 'menuitem');
    const l = document.createElement('span');
    l.className = 'mi-label';
    l.textContent = label;
    const h = document.createElement('span');
    h.className = 'mi-hint';
    h.textContent = hint;
    item.append(l, h);
    item.addEventListener('click', (e) => { e.stopPropagation(); closeStripMenu(); run(); });
    stripMenu.appendChild(item);
  };

  for (const a of agentList) {
    add(a.label, a.hint ? t(a.hint) : (a.command || ''), () => newSession(p.path, a.id));
  }
  for (const w of p.worktrees) {
    add(`⑂ ${w.name.split('/').pop()}`, t('strip.worktree'),
      () => newSession(w.path, null, { projectCwd: p.path }));
  }

  const r = anchor.getBoundingClientRect();
  stripMenu.style.left = `${Math.round(r.left)}px`;
  stripMenu.style.top = `${Math.round(r.bottom + 4)}px`;
  stripMenu.classList.remove('hidden');
}
document.addEventListener('click', closeStripMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeStripMenu(); });

// ---- The grid: panels you asked to keep on screen ---------------------------

function pinSession(id) {
  const s = tabs.get(id);
  if (!s) return;
  if (pinned.has(id)) { pinned.delete(id); applyLayout(); return; }
  if (pinned.size >= MAX_PANELS) { toast(t('toast.gridFull', { n: MAX_PANELS })); return; }
  if (!s.materialized) materialize(s);
  pinned.add(id);
  applyLayout();
  fitSoon(id);
}

// ▦ on a project row means the project: the session it would open if you
// clicked it, started for the occasion if it has none.
async function pinProject(cwd) {
  const mine = sessionsOf(cwd);
  const already = mine.find((s) => pinned.has(s.id));
  if (already) { pinned.delete(already.id); applyLayout(); return; }
  const p = projects.get(cwd);
  const target = p && p.lastId && tabs.has(p.lastId)
    ? p.lastId
    : (mine.length ? mine[mine.length - 1].id : null);
  if (target) { pinSession(target); return; }
  const id = await newSession(cwd, null);
  if (id) pinSession(id);
}

// ---- The overview: a project's first tab ------------------------------------

function whenLabel(at) {
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return t('overview.now');
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 20) return `${Math.floor(mins / 60)}h`;
  return new Date(at).toLocaleString(undefined,
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// A session TabDesk hasn't opened a terminal for is not therefore idle: if it
// carries a tmux session it is running, this window just isn't looking at it —
// which is exactly the state every restored session starts in.
function sessionState(s) {
  if (s.dead) return t('overview.state.dead');
  if (s.busy) return t('overview.state.busy');
  if (s.doneAt) return t('overview.state.waiting', { time: waitLabel(s.doneAt) || '0m' });
  if (!s.materialized) return t(s.session ? 'overview.state.detached' : 'overview.state.idle');
  return t('overview.state.open');
}

const newEl = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

function section(title) {
  const sec = newEl('div', 'ov-sec');
  sec.appendChild(newEl('h3', null, title));
  return sec;
}

// Rebuilt rather than patched: it is a summary of state that several other
// things already own, and re-deriving it is cheaper than keeping a second copy
// of that state in sync.
let overviewSeq = 0;
async function renderOverview(cwd) {
  const p = projects.get(cwd);
  if (!p) return;
  const seq = ++overviewSeq;
  overviewEl.textContent = '';

  const head = newEl('div', 'ov-head');
  head.append(newEl('h2', null, p.name), newEl('span', 'ov-path', p.path));
  overviewEl.appendChild(head);

  // What it is running now.
  const live = section(t('overview.active'));
  const mine = sessionsOf(cwd);
  if (!mine.length) live.appendChild(newEl('p', 'ov-empty', t('overview.none')));
  for (const s of mine) {
    const row = newEl('button', 'ov-row');
    const dot = newEl('span', 'dot');
    if (s.dead) dot.classList.add('dead');
    else if (s.busy) dot.classList.add('busy');
    else if (s.doneAt) dot.classList.add('done');
    row.append(dot, newEl('span', 'ov-name', s.name), newEl('span', 'ov-state', sessionState(s)));
    if (s.model && s.model !== 'default') row.appendChild(newEl('span', 'ov-model', s.model));
    row.addEventListener('click', () => setActive(s.id));
    live.appendChild(row);
  }
  overviewEl.appendChild(live);

  // How to start another one. A runtime that can be told "the latest" offers
  // that beside it — it is the one resume that needs no list at all.
  const start = section(t('overview.start'));
  const chips = newEl('div', 'ov-chips');
  for (const a of agentList) {
    const chip = newEl('button', 'ov-chip', `${a.id === 'shell' ? '⌨' : '🤖'} ${a.label}`);
    chip.title = a.hint ? t(a.hint) : (a.command || '');
    chip.addEventListener('click', () => newSession(cwd, a.id));
    chips.appendChild(chip);
    if (!a.continueArgs) continue;
    const last = newEl('button', 'ov-chip thin', '↺');
    last.title = t('overview.continue.title', { agent: a.label });
    last.addEventListener('click', () => newSession(cwd, a.id, { resume: {} }));
    chips.appendChild(last);
  }
  for (const w of p.worktrees) {
    const chip = newEl('button', 'ov-chip wt', `⑂ ${w.name.split('/').pop()}`);
    chip.title = w.path;
    chip.addEventListener('click', () => newSession(w.path, null, { projectCwd: cwd }));
    chips.appendChild(chip);
  }
  start.appendChild(chips);
  overviewEl.appendChild(start);

  // And what it ran before. This is the agents' own memory, so it lists the
  // conversations they can genuinely pick up again — nothing TabDesk invented.
  const past = section(t('overview.previous'));
  const loading = newEl('p', 'ov-empty', t('overview.loading'));
  past.appendChild(loading);
  overviewEl.appendChild(past);

  let rows = [];
  try { rows = await window.api.previousSessions(cwd); } catch (_) { rows = []; }
  if (seq !== overviewSeq || overviewCwd !== cwd) return;   // moved on while reading
  loading.remove();
  if (!rows.length) {
    past.appendChild(newEl('p', 'ov-empty', t('overview.noHistory')));
    return;
  }
  let group = null;
  for (const r of rows.slice().sort((a, b) => (a.agent === b.agent ? b.at - a.at : a.agent.localeCompare(b.agent)))) {
    if (group !== r.agent) {
      group = r.agent;
      past.appendChild(newEl('h4', 'ov-group', agentLabel(r.agent)));
    }
    const row = newEl('button', 'ov-row past');
    row.append(
      newEl('span', 'ov-name', r.title || t('overview.untitled')),
      newEl('span', 'ov-when', whenLabel(r.at)),
    );
    row.title = t('overview.resume', { id: r.id });
    row.addEventListener('click', () => newSession(cwd, r.agent, { resume: { id: r.id } }));
    past.appendChild(row);
  }
}

document.getElementById('fullscreen-btn').addEventListener('click', () => window.api.toggleFullscreen());
document.getElementById('settings-btn').addEventListener('click', () => window.api.openSettings());

// ---- Update chip ----
// Hidden until the background check finds a release tag this checkout hasn't
// reached; the window it opens does the fast-forwarding.
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

// The update window's fast-forward was blocked by local work, so the command
// comes back here to run in a real terminal where it can be looked at.
window.api.onUpdateTerminal(({ command }) => {
  setActive(buildTab({
    name: window.t('update.tabName'), cwd: null, projectCwd: activeCwd, startCmd: command,
  }));
});
window.addEventListener('resize', () => { for (const vid of shownIds()) fitTerm(vid); scheduleSync(); });

// The grid is composed, not cycled: ▦ beside a project or a session adds that
// panel, and this button says how many are held and empties the grid again.
const gridBtn = document.getElementById('grid-btn');
function syncGridBtn() {
  gridBtn.textContent = t('rail.grid', { n: pinned.size });
  gridBtn.disabled = pinned.size === 0;
  gridBtn.title = t(pinned.size ? 'rail.grid.clear' : 'rail.grid.title');
}
gridBtn.addEventListener('click', () => {
  if (!pinned.size) return;
  pinned.clear();
  applyLayout();
  for (const vid of shownIds()) fitSoon(vid);
});
syncGridBtn();

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
    fullName(t),
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
let previewName = '';       // that project's display name, for the stale notice
let previewStale = false;   // dock holds a project other than the active tab's
let previewIsStatic = false; // current preview is a file:// page, so no process to lose
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

// Nodes, never HTML.
//
// Everything the dock shows carries something we do not author: a project name
// is a directory basename, and a directory can be called anything at all —
// including markup — while a failing command writes its own text into the error.
// Both used to reach innerHTML here, and this window has `window.api` on it,
// including sendInput(), which types straight into a terminal. An `onerror=`
// in a folder name was a command prompt.
//
// The same reasoning the drag-drop path already spells out for shellQuote():
// filenames are attacker-controlled in a way people forget.
function setEmptyNodes(...nodes) {
  previewEmpty.replaceChildren(...nodes);
  previewEmpty.classList.remove('hidden');
  if (previewView) previewView.classList.add('dim');
}

// A plain line. `text` is always inserted as text, never parsed.
function line(text, cls) {
  const p = document.createElement('p');
  if (cls) p.className = cls;
  p.textContent = String(text == null ? '' : text);
  return p;
}

// A line built from an i18n string carrying a single {name}. The emphasis is
// part of the message and belongs in the markup; the name is data and goes in
// as a text node, which is why the source strings no longer carry <strong>
// around the placeholder themselves.
function namedLine(key, name, cls) {
  const p = document.createElement('p');
  if (cls) p.className = cls;
  const [before, after = ''] = String(window.t(key)).split('{name}');
  const em = document.createElement('strong');
  em.textContent = String(name == null ? '' : name);
  p.append(before, em, after);
  return p;
}

// What "starting <project>" looks like, from the two places that show it.
function startingNodes(name) {
  return [
    line('◐', 'spin'),
    namedLine('preview.startingName', name),
    line(window.t('preview.seeLog'), 'hint'),
  ];
}
function showWebview() {
  previewEmpty.classList.add('hidden');
  if (previewView) previewView.classList.remove('dim');
}

// ---- Keeping the dock honest across a tab switch ----
//
// The dock is fixed: it outlives the tab that opened it. Switch projects and it
// goes on showing the old one under a title that still names it, which reads as
// "this is your project" rather than "this is the last one you asked for".
//
// What it costs to fix decides how it is fixed. A static project is a file://
// URL and no process at all, so it is swapped in silently — that is the case
// where "it just follows the tab" is free. Anything else is a dev server worth
// seconds of startup and holding state nobody asked us to throw away, so it is
// never restarted behind your back: the dock says what it is showing and offers
// the swap.
//
// Names go in through textContent, never innerHTML. They are directory names,
// and a directory can be called anything at all.
// Nodes rather than a wrapper element: #preview-empty styles its first <p> as
// the big icon, the way the ⚠ and ◐ messages use it, and a wrapper would move
// :first-child onto the first line of text instead.
function staleNotice(activeT, info) {
  const nodes = [
    line('👁'),
    line(window.t('preview.stale', { running: previewName || previewCwd })),
    line(info
      ? window.t('preview.staleActive', { active: activeT.name })
      : window.t('preview.staleNothing', { active: activeT.name }), 'hint'),
  ];

  if (info) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preview-swap';
    btn.dataset.previewSwap = '1';
    btn.textContent = window.t('preview.staleSwap', { active: activeT.name });
    nodes.push(btn);
  }
  return nodes;
}

function showPreviewStale(activeT, info) {
  previewStale = true;
  setEmptyNodes(...staleNotice(activeT, info));
}

// Back on the tab the dock belongs to: put back whatever the current mode was
// already showing. 'starting' owns the overlay, so it has to be redrawn rather
// than merely uncovered.
function clearPreviewStale() {
  if (!previewStale) return;
  previewStale = false;
  if (previewMode === 'live') {
    showWebview();
  } else if (previewMode === 'starting') {
    setEmptyNodes(...startingNodes(previewName));
  }
}

// Rapid switching means several of these can be in flight at once — the kind
// lookup is IPC. Only the newest may touch the DOM, or a slow answer for a tab
// you already left lands on top of the right one.
let previewSyncSeq = 0;
async function syncPreviewToActive() {
  const seq = ++previewSyncSeq;
  if (previewMode === 'idle') return;      // nothing running, nothing to be stale about
  const t = focusCwd();
  if (!t || t.cwd === previewCwd) { clearPreviewStale(); return; }

  const info = await window.api.previewKind(t.cwd);
  if (seq !== previewSyncSeq) return;      // a later switch already decided

  // Silent only when the swap genuinely costs nothing: the project we are
  // moving to needs no process, AND the one we are leaving has none to lose.
  // start() stops whatever is running before it does anything else, so without
  // that second half, stepping onto a tab with an index.html would quietly kill
  // the dev server you left running two tabs ago — the expensive, invisible
  // thing this whole branch exists to avoid.
  if (info && info.kind === 'static' && previewMode === 'live' && previewIsStatic) {
    openPreview();
    return;
  }
  showPreviewStale(t, info);
}

previewEmpty.addEventListener('click', (e) => {
  if (e.target.closest('[data-preview-swap]')) openPreview();
});

// `external: true` means the caller only wants the URL (to hand to the desktop
// browser), so we start the process without unfolding the dock over the panels.
async function openPreview({ external = false } = {}) {
  const t = focusCwd();
  if (!t) { toast(window.t('toast.openProject')); return; }
  if (!external) preview.classList.remove('collapsed');

  const view = await ensureWebview();

  previewMode = 'starting';
  previewLog = '';
  previewUrl = '';
  previewCwd = t.cwd;
  previewName = t.name;
  // Whatever the dock was showing, it is now this project's — by definition not
  // stale, and the notice must not survive into the new run's overlay.
  previewStale = false;
  // Unknown until 'ready' says which it is; assume a process, so a switch made
  // while this is still starting asks rather than kills.
  previewIsStatic = false;
  previewTitle.textContent = `👁 ${t.name}`;
  previewCrumb.textContent = window.t('preview.starting');
  previewHtml.textContent = '';
  view.src = 'about:blank';
  setEmptyNodes(...startingNodes(t.name));
  await window.api.startPreview(t.cwd);
}

// Lifecycle events from the preview runner in main.
window.api.onPreviewEvent((d) => {
  if (d.type === 'log') {
    if (d.name) { previewTitle.textContent = `👁 ${d.name}`; previewName = d.name; }
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
    // Whether a swap away from this costs anything. A static preview is a
    // file:// page with nothing behind it; everything else holds a process.
    previewIsStatic = d.kind === 'static';
    // Becoming ready while you are on another tab must not uncover the dock:
    // the "showing another project" notice is still the truth until you go back.
    if (!previewStale) showWebview();
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
    // The dock now holds a failure, not a project — there is nothing left for
    // the stale notice to be about, and leaving the flag set would suppress the
    // next showWebview().
    previewStale = false;
    previewCrumb.textContent = '⚠ ' + d.message;
    // d.message carries the project's directory name and whatever a failing
    // command printed — neither is ours to trust.
    setEmptyNodes(line('⚠'), line(d.message), line(t('preview.details'), 'hint'));
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

// What "run it" and the preview dock act on: the session in front of you when
// there is one — a worktree session is its own checkout, with its own code to
// run — and otherwise the project the rail has selected.
function focusCwd() {
  const s = tabs.get(activeId);
  if (s && s.cwd) return { cwd: s.cwd, name: s.name };
  const p = projects.get(activeCwd);
  return p ? { cwd: p.path, name: p.name } : null;
}

function activeProject() {
  const t = focusCwd();
  if (!t) { toast(window.t('toast.openProject')); return null; }
  return t;
}

// The first menu item doubles as the stop switch once the app is up.
function syncRunUI() {
  const t = focusCwd();
  const on = !!(t && runningApps.has(t.cwd));
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
  // This tab only. Storing it against the project as well is what makes the
  // next tab on it start the same way, without dragging the tabs that are
  // already open along.
  t.agent = res.agent;
  agentByProject[t.cwd] = res.agent;
  renderAgentBtn();
  // A running terminal was started by the old CLI and can't be swapped under it.
  toast(window.t(t.materialized ? 'toast.agentLater' : 'toast.agentSet',
    { project: t.name, agent: agentLabel(res.agent) }));
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

// ---- Bugs & Feedback -------------------------------------------------------
document.getElementById('feedback-btn').addEventListener('click', () => {
  window.api.openExternal('https://github.com/Detrol/tabdesk/issues');
});

// Fill the rail with the projects on disk, most recently touched first, and
// then take back the sessions that outlived the last run — each one hung under
// the project it belongs to, a worktree session under the project it branches
// from. A session whose project isn't in the rail (a folder elsewhere) brings
// its own row with it, or there would be nowhere to click to reach it.
//
// Nothing is started here: the strip shows what was running, and a click is
// what reattaches to it.
// No projects folder chosen yet (or the chosen one is gone): everything the
// rail would show derives from it, so the only meaningful screen is the one
// that asks for it. Sessions in tmux wait safely — restore runs after the
// choice, when there are rows to hang them under.
const bootRoot = (window.api.boot && window.api.boot.projectsRoot) || { configured: true };
if (!bootRoot.configured) {
  document.getElementById('first-run').classList.remove('hidden');
  emptyState.classList.add('hidden');
  const frError = document.getElementById('fr-error');
  document.getElementById('fr-choose').addEventListener('click', async () => {
    const res = await window.api.chooseProjectsRoot();
    // Success reloads the whole window from main; only failure comes back.
    if (res && !res.ok && !res.canceled) {
      frError.textContent = res.error || '';
      frError.classList.remove('hidden');
    }
  });
} else {
window.api.listProjects().then((list) => {
  for (const p of list) {
    if (p.closed) continue;
    buildProject(p);
  }
  return window.api.restoreTabs();
}).then((records) => {
  for (const rec of records || []) {
    const owner = ownerOf(rec.cwd);
    if (!projects.has(owner)) {
      buildProject({ name: owner.split('/').pop(), path: owner, worktrees: [] });
    }
    const agent = rec.agent || undefined;
    const name = rec.name || sessionLabel(rec.cwd, agentFor({ cwd: rec.cwd, agent }), owner);
    const id = buildTab({ name, cwd: rec.cwd, projectCwd: owner, agent });
    tabs.get(id).session = rec.session;
  }
  // Land on something rather than an empty window: the overview of the project
  // with sessions waiting for you, else of the first one in the rail. The
  // overview and not a terminal — attaching to an agent is a click you make,
  // not something a restart does for you.
  if (!activeCwd) {
    const first = [...projects.keys()].find((cwd) => sessionsOf(cwd).length)
      || [...projects.keys()][0];
    if (first) showOverview(first);
  }
}).catch(() => { /* a rail without restored sessions still works */ });
}

// ---- Model picker (bottom system bar) ----
// The model belongs to the tab's project and its agent, not to the app: the bar
// always shows the active tab's model, and switching tabs switches what it
// shows. That keeps an expensive model on one project from eating every other
// project's usage, and keeps a Codex pick off the Claude tab beside it.
// The pick becomes a --model flag when that tab's terminal starts, so a session
// already running keeps its own until you /model inside it.
//
// What can be picked comes from the agent: Claude Code has TabDesk's alias
// list, opencode is asked for its providers, and a CLI that can only be
// configured from inside itself shows what it is set to, read-only.
const modelBtn = document.getElementById('model-btn');
const modelMenu = document.getElementById('model-menu');
const bootModel = (window.api.boot && window.api.boot.model) || {};
let modelList = [{ id: 'default', label: 'Default', hint: 'model.hint.default' }];
let modelListAgent = null;                       // which agent modelList is for
let globalModel = bootModel.global || 'default'; // what Default means for it

// Load the rows for an agent, if they aren't already the ones in hand.
async function loadModels(agent) {
  if (modelListAgent === agent) return;
  const res = await window.api.listModels(agent);
  if (!res || !Array.isArray(res.list) || !res.list.length) return;
  modelList = res.list;
  globalModel = res.global || 'default';
  modelListAgent = agent;
}

// The agent whose models the bar is currently about.
function activeAgent() {
  const t = tabs.get(activeId);
  return t && t.cwd ? agentFor(t) : null;
}

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
  // Follow the active tab: its agent decides what the bar can say and offer.
  const want = activeAgent();
  if (want && modelListAgent !== want) {
    loadModels(want).then(() => { if (activeAgent() === want) renderModelBtn(); });
  }
  // A terminal keeps the model it launched with. Say so in the bar rather than
  // only in a toast: while a terminal is open it covers the toast area (native
  // X window on top of the page), so that message can go unseen.
  const pending = !!(tab && tab.materialized && tab.runningModel !== tab.model);
  modelBtn.textContent = barLabel(id) + (pending ? ' •' : '');
  modelBtn.classList.toggle('inherited', id === 'default' && !pending);
  modelBtn.classList.toggle('pending', pending);
  // An ad-hoc shell has nothing to flag; an agent with nothing to offer but
  // its own default is shown, not offered — the bar still says what it runs.
  const agent = activeAgent();
  const pickable = modelListAgent === agent && modelList.length > 1;
  modelBtn.disabled = !agent || !pickable;
  modelBtn.title = !agent
    ? t('bar.model.none')
    : (pending
      ? t('bar.model.pending', { model: barLabel(tab.runningModel) })
      : (pickable
        ? t('bar.model.title', { project: tab.name })
        : t('bar.model.agentOnly', { agent: agentLabel(agent) })));
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

modelBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const open = modelMenu.classList.contains('hidden');
  // Re-read on open: opencode's list comes from the CLI and a provider added
  // since boot should be pickable without restarting TabDesk.
  if (open) {
    const agent = activeAgent();
    if (agent) { modelListAgent = null; await loadModels(agent); }
    renderModelMenu();
  }
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

  const agent = agentFor(tab);
  const res = await window.api.setModel(tab.cwd, agent, id);
  if (!res || !res.ok) {
    toast(window.t('toast.modelFailed', { error: (res && res.error) || '' }));
    return;
  }
  // Stored against the project *and* the agent, so the tabs that follow are
  // the ones running the same CLI on the same project — not a Codex tab
  // inheriting a Claude alias.
  for (const other of tabs.values()) {
    if (other.cwd === tab.cwd && agentFor(other) === agent) other.model = res.model;
  }
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
    tab.model = (models && models[`${agentFor(tab)}|${tab.cwd}`]) || 'default';
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
function fmtBytes(b) { return (b / 1073741824).toFixed(1) + 'G'; }
function pct(v, max) { return max > 0 ? Math.min(100, (v / max) * 100) : 0; }

function setMeter(sel, fillPct, valText, hot) {
  const el = document.getElementById(sel);
  const fill = el.querySelector('.m-fill');
  fill.style.width = fillPct.toFixed(1) + '%';
  fill.classList.toggle('hot', !!hot);
  el.querySelector('.m-val').textContent = valText;
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
//
// Which plan is a question of which runtime the focused session runs: a Codex
// tab's meters are Codex's windows, not Claude's. Runtimes that publish no
// usage anywhere readable (Gemini, opencode…) get an explicit dash — wrong
// numbers with the right label are worse than none.
const PLAN_METERS = [['m-session', 'session'], ['m-week', 'week'], ['m-scoped', 'scoped']];
let usage = null;          // last local scan
let limits = { ok: false }; // last plan-limit read
let metersAgent = 'claude'; // the runtime `limits` describes

// The runtime whose plan the meters should read: the focused session's agent.
// Ad-hoc terminals, the overview and the empty state have no runtime of their
// own, so they keep the Claude default the bar has always shown.
function focusedAgent() {
  const t = activeId && tabs.get(activeId);
  if (!t || !tmuxAgentFor(t)) return 'claude';
  const agent = agentFor(t);
  return agent === 'shell' ? 'claude' : agent;
}

function agentLabelOf(id) {
  const a = agentList.find((x) => x.id === id);
  return (a && a.label) || id;
}

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
    el.title = metersAgent === 'codex'
      ? t(limits.stale ? 'bar.codexTitleStale' : 'bar.codexTitle')
      : t(limits.stale ? 'bar.planTitleStale' : 'bar.planTitle');
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

// A runtime whose usage exists nowhere we can read: two dashed meters under
// their usual labels, saying whose plan it is we can't see. Falling back to
// the Claude transcripts here would dress one runtime in another's numbers.
function renderNoDataMeters() {
  document.getElementById('m-scoped').classList.add('hidden');
  for (const sel of ['m-session', 'm-week']) {
    const el = document.getElementById(sel);
    el.classList.remove('hidden');
    setMeterLabel(sel, sel === 'm-session' ? 'bar.session' : 'bar.week');
    setMeter(sel, 0, '–');
    el.title = t('bar.noQuota', { agent: agentLabelOf(metersAgent) });
  }
}

function renderMeters() {
  if (limits.ok) renderPlanMeters();
  else if (metersAgent === 'claude') renderLocalMeters();
  else renderNoDataMeters();
  tickResets();
}

// The plan windows are the live number, so they refresh on their own (cheap)
// timer. Main caches them for a minute, so polling faster than that only costs
// an IPC round trip. The answer follows the focused session's runtime, and a
// stale response for a tab you've already left must not repaint the bar — the
// focus check after the await drops it.
async function refreshLimits() {
  const agent = focusedAgent();
  const result = (await window.api.getUsageLimits(agent)) || { ok: false, reason: 'network' };
  if (focusedAgent() !== agent) return;
  metersAgent = agent;
  limits = result;
  renderMeters();
}

// The transcript scan walks every .jsonl under ~/.claude/projects — worth doing
// rarely. The totals it produces are read in Settings → Statistics now; what is
// still needed down here is the meters, which fall back to this scan whenever
// the plan quota is out of reach.
async function refreshUsage() {
  const u = await window.api.getUsageStats();
  if (!u) return;
  usage = u;
  renderMeters();
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
      // The midnight countdown belongs to the local-estimate fallback's daily
      // bucket; a runtime shown as "no data" has nothing counting down.
      : (metersAgent === 'claude' && sel === 'm-session' ? midnight.getTime() : null);
    node.textContent = at ? t('bar.reset', { time: fmtCountdown(at - now) }) : '';
  }
}

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  document.getElementById('m-clock').textContent =
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  tickResets();
  // Only the rows that are counting need redrawing, and renderWaitEl writes to
  // the DOM once a minute rather than once a second.
  const waiting = new Set();
  for (const t of tabs.values()) {
    if (!t.doneAt) continue;
    renderWait(t);
    waiting.add(t.projectCwd);
  }
  for (const cwd of waiting) renderProject(cwd);
}

// Strings and colours baked into JS (button labels, live xterm palettes) don't
// come along with the declarative data-i18n sweep — re-apply them by hand when
// the desktop's theme or language changes under us.
window.ui.onChange((kind, payload) => {
  if (kind === 'language') {
    syncGridBtn();
    renderModelBtn();
    if (!modelMenu.classList.contains('hidden')) renderModelMenu();
    for (const t of tabs.values()) {
      t.tabEl.querySelector('.close').title = window.t('tab.close');
      t.tabEl.querySelector('.pin').title = window.t('rail.pin');
      if (t.panelEl) {
        const pc = t.panelEl.querySelector('.panel-close');
        if (pc) pc.title = window.t('panel.unpin');
      }
    }
    for (const cwd of projects.keys()) {
      projects.get(cwd).el.querySelector('.pin').title = window.t('rail.pin');
      renderProject(cwd);
    }
    renderStrip();
    if (overviewCwd) renderOverview(overviewCwd);
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
