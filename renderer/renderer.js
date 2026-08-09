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
const tabOrder = [];         // ids in user-selected order

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

// The sessions belonging to a project, in the user-selected order. A
// worktree session belongs to the project it branches from, not to a rail row
// of its own.
function sessionsOf(cwd) {
  return tabOrder.map((id) => tabs.get(id)).filter((t) => t && t.projectCwd === cwd);
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
      tabs: tabOrder.map((id) => tabs.get(id)).filter(Boolean).map((t) => ({
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
  renderWaitEl(t.tabEl.querySelector('.wait'), t.askingAt || t.doneAt);
}

// A project row stands for several sessions at once, so colour and motion
// answer two different questions. The colour is the most actionable thing among
// them; the pulse means one of them is producing output right now. Kept apart
// deliberately: a project can hold a finished session and a running one at the
// same time, and a single class could only ever say one of those.
const ROW_STATES = ['asking', 'done', 'dead', 'busy', 'open', 'idle'];

function projectState(mine) {
  if (mine.some((t) => t.askingAt)) return 'asking'; // blocked on your answer
  if (mine.some((t) => t.doneAt)) return 'done';     // finished, wants you
  if (mine.some((t) => t.dead)) return 'dead';       // something ended
  if (mine.some((t) => t.busy)) return 'busy';
  return mine.length ? 'open' : 'idle';
}

// The row's tooltip carries what the single dot cannot: how many of the
// project's sessions are in each state, above its path.
function rowTitle(p, mine) {
  if (!mine.length) return p.path;
  const parts = [window.t('rail.sessions', { n: mine.length })];
  const asking = mine.filter((x) => x.askingAt).length;
  const waiting = mine.filter((x) => x.doneAt && !x.askingAt).length;
  const working = mine.filter((x) => x.busy).length;
  if (asking) parts.push(window.t('rail.state.asking', { n: asking }));
  if (waiting) parts.push(window.t('rail.state.waiting', { n: waiting }));
  if (working) parts.push(window.t('rail.state.working', { n: working }));
  return `${parts.join(' · ')}\n${p.path}`;
}

// The wait badge counts from whichever session has been waiting longest, which
// is the one a rotation is deciding about.
function renderProject(cwd) {
  const p = projects.get(cwd);
  if (!p) return;
  const mine = sessionsOf(cwd);
  const el = p.el;
  const state = projectState(mine);
  for (const s of ROW_STATES) el.classList.toggle(s, s === state);
  el.classList.toggle('working', mine.some((t) => t.busy));
  const waits = mine.map((t) => t.askingAt || t.doneAt).filter(Boolean);
  renderWaitEl(el.querySelector('.wait'), waits.length ? Math.min(...waits) : 0);
  const count = el.querySelector('.count');
  count.textContent = mine.length ? String(mine.length) : '';
  const title = rowTitle(p, mine);
  el.title = title;
  count.title = title;
  // The project's own overview lists these same sessions, so it is stale the
  // moment this changes.
  renderLiveRows(cwd);
}

// Clear any busy/done/asking flags on a session (called when the user looks at
// it). Looking at a question is not answering it, but the flag exists to get
// you here — once you are, the screen itself is the notice.
function clearTabFlag(t) {
  clearTimeout(t.idleTimer);
  t.flagSeq = (t.flagSeq || 0) + 1;
  const wasBusy = t.busy;
  t.busy = false;
  t.doneAt = 0;
  t.askingAt = 0;
  t.tabEl.classList.remove('busy', 'done', 'asking');
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

// Called on every chunk of pty output (xterm.js backend), whenever the
// embedded terminal writes, and for tabs with no terminal of their own when
// tmux reports that their session wrote something. Marks background tabs busy
// while output flows, then green ("done") once they fall silent.
//
// `idleMs` is how long silence has to last to count as finished: a stream tells
// us the moment it stops, a poll only knows what it saw last time, so the two
// need different windows (see POLL_IDLE_MS).
function markActivity(id, idleMs = IDLE_MS) {
  const t = tabs.get(id);
  if (!t || t.dead) return;

  // Output while it streams only ever changes a tab's colour. The move comes
  // later, when it stops — see hoistOnDone().
  if (isWatched(id)) { clearTabFlag(t); return; }

  // A session waiting for an answer goes on writing: Codex animates its prompt
  // the whole time it stands there. Output is therefore no evidence that the
  // question is gone — only the screen can say that (recheckAsking), or you
  // opening the tab, which the line above already covers.
  if (t.askingAt) return;

  const wasBusy = t.busy;
  t.flagSeq = (t.flagSeq || 0) + 1;
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
      checkAsking(t, t.doneAt);
    }
    renderProject(t.projectCwd);
    syncTray();
  }, idleMs);
}

// Quiet, but is it finished or is it waiting for an answer? Only the screen
// says, and reading it costs a tmux capture — so it is asked once, when a
// session falls silent, and never while output is still flowing. A question is
// put on screen by writing it, so one that arrives later arrives with output,
// which brings us back through here.
//
// It resolves after the dot has already gone green. That is the honest order:
// green is what silence alone can tell us, amber is the upgrade when the screen
// turns out to hold a question.
//
// `at` is when the question went up — the moment of silence for a session we
// watched fall quiet, and the session's own last-write stamp for one that was
// already asking before this window opened.
function checkAsking(t, at) {
  if (!t.session || !window.api.sessionAsking) return;
  t.flagSeq = (t.flagSeq || 0) + 1;
  const seq = t.flagSeq;
  window.api.sessionAsking(t.session).then((yes) => {
    // Anything that happened while we were reading wins: new output, the user
    // opening the tab, the session ending.
    if (!yes || t.flagSeq !== seq) return;
    markAsking(t, at);
  }).catch(() => { /* no answer is the same as "just quiet" */ });
}

// Still waiting, or did that get answered somewhere else? Only the screen can
// say, since the session's own writing carries on either way.
function recheckAsking(t) {
  if (!t.session || !window.api.sessionAsking) return;
  t.askedAt = Date.now();
  const seq = t.flagSeq;
  window.api.sessionAsking(t.session).then((yes) => {
    if (yes || t.flagSeq !== seq || !t.askingAt) return;
    t.askingAt = 0;
    t.tabEl.classList.remove('asking');
    renderWait(t);
    renderProject(t.projectCwd);
  }).catch(() => { /* leave it standing rather than guess */ });
}

// It is waiting for you. Lifted like a finished session, and for the same
// reason: this is the state the rail exists to bring to the top.
function markAsking(t, at) {
  if (t.askingAt || t.dead) return;
  t.askedAt = Date.now();
  clearTimeout(t.idleTimer);
  t.flagSeq = (t.flagSeq || 0) + 1;
  t.busy = false;
  t.doneAt = 0;
  t.askingAt = at || Date.now();
  t.tabEl.classList.remove('busy', 'done');
  t.tabEl.classList.add('asking');
  renderWait(t);
  hoistOnDone(t);
  renderProject(t.projectCwd);
  syncTray();
}

// A session ended. The pty backend learns this from its own exit; a session we
// never opened, from tmux no longer listing it.
//
// Every other flag goes with it: a session that has ended is not working, and
// it is not waiting for you either — "it finished and wants you" is an offer to
// go back to it, and there is nothing to go back to.
function markDead(t) {
  clearTimeout(t.idleTimer);
  t.flagSeq = (t.flagSeq || 0) + 1;
  t.dead = true;
  t.busy = false;
  t.doneAt = 0;
  t.askingAt = 0;
  t.tabEl.classList.add('dead');
  t.tabEl.classList.remove('busy', 'done', 'asking');
  renderWait(t);
  renderProject(t.projectCwd);
  syncTray();
}

// ---- Sessions we have not opened -------------------------------------------
//
// Main polls tmux for every session's last-activity stamp (activity.js). A
// stamp that moved is the same event as a chunk of pty output, and goes through
// the same state machine — which is what lets the rail speak for sessions this
// window has no terminal for, i.e. all of them right after a restart.
//
// The silence window has to be wider than the poll: with a 2 s interval and
// stamps counted in whole seconds, IDLE_MS would call a session finished
// between two samples of a session that never stopped.
const POLL_IDLE_MS = 5000;
// How often a session that is already waiting for an answer is read again, to
// see whether it still is. Slower than the poll because it costs a capture, and
// the answer rarely changes without you being the one who changed it.
const ASK_RECHECK_MS = 6000;
const activitySeen = new Map();   // session name -> the stamp we last compared
const activityMisses = new Map(); // session name -> consecutive polls without it
// Live shell cwd per tmux session (pane_current_path). tab.cwd is where the
// session was born; an agent that entered a worktree leaves that on the project
// root, so the place bar reads this map first.
const liveCwd = new Map();        // session name -> path

// Baselines are per session and not per map: tabs are built after the window
// loads, so a tab that appears mid-stream still gets its own first sighting
// rather than inheriting somebody else's.
function applyActivity(map) {
  const now = map || {};
  let placeDirty = false;
  for (const [session, rec] of Object.entries(now)) {
    if (!rec || !rec.cwd) continue;
    if (liveCwd.get(session) !== rec.cwd) {
      liveCwd.set(session, rec.cwd);
      placeDirty = true;
    }
  }
  for (const t of tabs.values()) {
    if (!t.session || t.dead || isWatched(t.id)) continue;
    const rec = now[t.session];

    // The runtime saying it needs you applies to every tab that has a session,
    // open or not. A tab with a terminal of its own is still one you may not be
    // looking at, and its pty cannot tell us this: Codex animates its prompt
    // while it waits, so that stream never falls silent for the screen to be
    // read. The title is the only thing that stands still and says so.
    if (rec && rec.asking) { markAsking(t, rec.at * 1000); continue; }

    // Already waiting for an answer. Movement alone does not disprove that —
    // see the animation above — so the screen, not the stamp, decides when it
    // stops being true. Throttled: it costs a capture.
    if (t.askingAt) {
      if (Date.now() - (t.askedAt || 0) >= ASK_RECHECK_MS) recheckAsking(t);
      continue;
    }

    // Everything below is for tabs with no terminal of their own; the rest have
    // their pty, which is the better witness.
    if (t.materialized) continue;
    const at = rec && rec.at;
    if (rec === undefined) {
      // Gone from tmux. Believed only after two polls in a row: one listing
      // that failed to arrive must not paint the rail red.
      const misses = (activityMisses.get(t.session) || 0) + 1;
      activityMisses.set(t.session, misses);
      if (misses >= 2) markDead(t);
      continue;
    }
    activityMisses.delete(t.session);
    const before = activitySeen.get(t.session);
    activitySeen.set(t.session, at);
    // A runtime saying so outright beats anything we could infer from silence.
    // It also has to come first: Codex blinks its "Action Required" title while
    // it waits, and that blinking is output — counted as work it would leave a
    // blocked session pulsing away as though it were busy.
    if (before === undefined) {
      // First sighting is a baseline, not news: hoisting every restored project
      // at startup would make the rail's order meaningless.
      //
      // A session already blocked on a question is the exception. It will never
      // write again — that is what being blocked means — so skipping it here
      // means never hearing about it at all. The stamp says when it last wrote,
      // which is when the question went up.
      checkAsking(t, at * 1000);
      continue;
    }
    if (at > before) markActivity(t.id, POLL_IDLE_MS);
  }
  if (placeDirty) renderPlace();
}

if (window.api.onSessionActivity) window.api.onSessionActivity(applyActivity);

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
  // The model, the effort and the agent belong to the session in focus, so
  // all three follow it. So does the place readout (project / worktree).
  renderPlace();
  renderModelBtn();
  renderEffortBtn();
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
  const agent = agentFor(t);
  const eFlag = effortFlag(agent, t.effort);
  // kimi has no --effort flag: docs set thinking via KIMI_MODEL_THINKING_EFFORT.
  if (eFlag && /^[A-Z][A-Z0-9_]*=/.test(eFlag)) {
    return `env ${eFlag} ${spec.command}${flag}`;
  }
  return spec.command + flag + eFlag;
}

// Agents whose TUI does its own mouse selection and copies what you selected
// by sending OSC 52. Their tabs keep the mouse; every other tab gets xterm's
// own selection forced on instead (see materialize). Claude Code's fullscreen
// renderer is the one that qualifies today — its classic renderer does not, so
// a tab is at worst back to selecting whatever tmux gives it.
const SELECTS_ITSELF = new Set(['claude']);

// Reasoning effort, in each CLI's own syntax. Mirrors effort.js in main; the
// level is checked against that agent's own list rather than escaped, so
// nothing but a known word ever reaches the command line.
const EFFORT_LEVELS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'],
  kimi: ['low', 'high', 'max'],
};
function effortSupported(agent) { return Boolean(EFFORT_LEVELS[agent]); }
function effortFlag(agent, level) {
  if (!level || level === 'default' || !effortSupported(agent)) return '';
  if (!EFFORT_LEVELS[agent].includes(level)) return '';
  if (agent === 'claude') return ` --effort ${level}`;
  if (agent === 'kimi') return `KIMI_MODEL_THINKING_EFFORT=${level}`;
  return ` -c model_reasoning_effort=${level}`;
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

let draggedTabId = null;
let draggedTabProject = null;
let draggedTabPreview = null;
const tabMoveAnimations = new WeakMap();

function projectTabPositions(projectCwd) {
  const positions = new Map();
  if (activeCwd !== projectCwd) return positions;
  for (const tab of sessionsOf(projectCwd)) {
    if (tab.tabEl && tab.tabEl.isConnected) {
      positions.set(tab.id, tab.tabEl.getBoundingClientRect().left);
    }
  }
  return positions;
}

function cancelProjectTabAnimations(projectCwd) {
  for (const tab of sessionsOf(projectCwd)) {
    const running = tabMoveAnimations.get(tab.tabEl);
    if (running) running.cancel();
    tabMoveAnimations.delete(tab.tabEl);
  }
}

function animateProjectTabOrder(projectCwd, before) {
  for (const tab of sessionsOf(projectCwd)) {
    if (tab.id === draggedTabId || !before.has(tab.id)) continue;
    const delta = before.get(tab.id) - tab.tabEl.getBoundingClientRect().left;
    if (Math.abs(delta) < 0.5) continue;
    const animation = tab.tabEl.animate([
      { transform: `translateX(${delta}px)` },
      { transform: 'translateX(0)' },
    ], {
      duration: 120,
      easing: 'cubic-bezier(.2,.8,.2,1)',
    });
    tabMoveAnimations.set(tab.tabEl, animation);
    animation.onfinish = () => {
      if (tabMoveAnimations.get(tab.tabEl) === animation) tabMoveAnimations.delete(tab.tabEl);
    };
  }
}

function syncProjectTabDom(projectCwd) {
  if (activeCwd !== projectCwd) return;
  const add = strip.querySelector('.stab.add');
  if (!add) return;
  for (const tab of sessionsOf(projectCwd)) strip.insertBefore(tab.tabEl, add);
}

function applyProjectTabOrder(projectCwd, orderedIds) {
  const mine = sessionsOf(projectCwd).map((tab) => tab.id);
  if (mine.length !== orderedIds.length
    || mine.some((id) => !orderedIds.includes(id))
    || mine.every((id, i) => id === orderedIds[i])) return false;

  const before = projectTabPositions(projectCwd);
  cancelProjectTabAnimations(projectCwd);

  const mineSet = new Set(mine);
  let next = 0;
  for (let i = 0; i < tabOrder.length; i++) {
    if (mineSet.has(tabOrder[i])) tabOrder[i] = orderedIds[next++];
  }
  if (activeCwd === projectCwd) {
    syncProjectTabDom(projectCwd);
    animateProjectTabOrder(projectCwd, before);
  }
  return true;
}

function persistProjectTabOrder(projectCwd) {
  syncTray();
  renderLiveRows(projectCwd);

  const sessions = window.TabOrder.persistentSessionIds(sessionsOf(projectCwd));
  if (sessions.length) {
    window.api.reorderTabs(sessions).catch(() => {});
  }
}

strip.addEventListener('dragover', (e) => {
  if (!draggedTabId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});

strip.addEventListener('drop', (e) => {
  if (!draggedTabPreview || !draggedTabProject) return;
  e.preventDefault();
  draggedTabPreview.commit();
  persistProjectTabOrder(draggedTabProject);
});

// Build a session's tab in the strip. The terminal/pty is created lazily, and
// the element only enters the DOM while its project is the one selected —
// renderStrip() hangs it there, so a session keeps its flags and its wait
// badge while you work in another project.
//
// `projectCwd` is the rail row this session belongs under: its own directory
// for a project session, the parent project for a worktree, the project you
// were in for a loose terminal.
function buildTab({ name, cwd, projectCwd, model, effort, agent, startCmd, resume }) {
  const id = `t${++seq}`;
  const tabEl = document.createElement('div');
  tabEl.className = 'stab';
  tabEl.title = cwd || name;
  tabEl.innerHTML = `
    <span class="dot"></span>
    <span class="label"></span>
    <span class="ask" aria-hidden="true">💬</span>
    <span class="wait"></span>
    <button class="pin" title="${t('rail.pin')}">▦</button>
    <button class="close" title="${t('tab.close')}">×</button>`;
  tabEl.querySelector('.label').textContent = name;
  tabEl.addEventListener('click', (e) => {
    if (e.target.closest('.close') || e.target.closest('.pin')) return;
    setActive(id);
  });
  // Middle-click closes the tab, the way browser tabs do. Same path as the ×,
  // so it carries the same weight: the session ends, it doesn't hide.
  tabEl.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    closeTab(id);
  });
  tabEl.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  tabEl.querySelector('.pin').addEventListener('click', (e) => {
    e.stopPropagation();
    pinSession(id);
  });
  tabEl.draggable = true;
  tabEl.addEventListener('dragstart', (e) => {
    const tab = tabs.get(id);
    if (!tab) { e.preventDefault(); return; }
    const preview = window.TabOrder.createDragPreview(
      sessionsOf(tab.projectCwd).map((session) => session.id), id);
    if (!preview) { e.preventDefault(); return; }
    draggedTabId = id;
    draggedTabProject = tab.projectCwd;
    draggedTabPreview = preview;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-tabdesk-tab', id);
    tabEl.classList.add('dragging');
  });
  tabEl.addEventListener('dragover', (e) => {
    if (!draggedTabPreview || draggedTabId === id) return;
    const moving = tabs.get(draggedTabId);
    const target = tabs.get(id);
    if (!moving || !target || moving.projectCwd !== target.projectCwd) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = tabEl.getBoundingClientRect();
    const after = window.TabOrder.afterMidpoint(e.clientX, rect.left, rect.width);
    if (after === null) return;
    const preview = draggedTabPreview.preview(id, after);
    if (preview) applyProjectTabOrder(moving.projectCwd, preview);
  });
  tabEl.addEventListener('dragend', () => {
    if (draggedTabPreview && draggedTabProject) {
      applyProjectTabOrder(draggedTabProject, draggedTabPreview.finish());
    }
    tabEl.classList.remove('dragging');
    draggedTabId = null;
    draggedTabProject = null;
    draggedTabPreview = null;
  });

  // The agent is pinned onto the tab at birth — from an explicit pick, else
  // from what this project was last opened with. Pinning it now, rather than
  // resolving it at start time, is what stops a later pick elsewhere from
  // changing what this tab was going to run.
  const rec = {
    id, name, cwd, projectCwd: projectCwd || cwd || activeCwd,
    model: model || 'default', effort: effort || 'default',
    startCmd, resume: resume || null,
    tabEl, materialized: false, agent: agent || undefined,
  };
  if (cwd) rec.agent = agentFor(rec);
  tabs.set(id, rec);
  tabOrder.push(id);
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

// A conversation's own name, dressed for the strip: shortened, and keeping
// the worktree marker — the branch itself is still in the tab's tooltip.
function titledName(title, cwd, projectCwd) {
  const one = String(title).replace(/\s+/g, ' ').trim();
  const short = one.length > 60 ? `${one.slice(0, 59)}…` : one;
  if (!short) return null;
  return projectCwd && cwd && cwd !== projectCwd ? `⑂ ${short}` : short;
}

// Renames follow the runtime's own store, so this runs repeatedly for a tab —
// everything showing the old name repaints, and the record keeps the new one
// so a restart restores the tab as what it was about, not what CLI it ran.
function renameTab(id, name) {
  const t = tabs.get(id);
  if (!t || !name || t.name === name) return;
  t.name = name;
  if (t.tabEl) {
    t.tabEl.querySelector('.label').textContent = name;
    t.tabEl.title = t.cwd ? `${name}\n${t.cwd}` : name;
  }
  if (t.session) window.api.renameTab(t.session, name, t.agentSession || null);
  if (overviewCwd === t.projectCwd) renderOverview(t.projectCwd);
  syncTray();
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
  t.runningEffort = t.effort;
  // Same for the agent: once this tab is running one, that is what it is,
  // whatever the project is set to open next.
  t.agent = agentFor(t);
  // When this tab's terminal started — what its conversation's store file is
  // matched against when no id is known yet (refreshTitles).
  t.bornAt = Date.now();

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

  // ---- Clipboard ----
  // Who gets the mouse depends on whether the program inside can do better
  // with it than we can.
  //
  // Claude Code's fullscreen renderer selects with the mouse itself, across
  // its own scrollback, and copies what you selected by sending OSC 52 — so
  // for those tabs the mouse belongs to it, and the only thing missing was a
  // terminal that listens for the answer. Verified against the running TUI: a
  // drag produces exactly one OSC 52 carrying the dragged line.
  //
  // Everything else — a shell, an agent that does not select — would hand the
  // drag to tmux instead, which selects into its own buffer and never reaches
  // the system clipboard. There we force xterm's own selection on, which is
  // what a terminal does while Shift is held, made unconditional. The cost is
  // that button presses stop reaching the program inside; the wheel is a
  // separate path and still scrolls tmux. Private API, so it is guarded: a
  // version bump drops it back to Shift-only rather than breaking.
  if (!SELECTS_ITSELF.has(t.agent)) {
    try { term._core._selectionService.shouldForceSelection = () => true; } catch (_) { /* Shift still works */ }
  }

  // OSC 52 is a program inside saying "put this on the clipboard". xterm.js
  // ships no handler, which is why Claude's own copies went nowhere.
  //
  // Anything that writes to a terminal can send it, including output nobody
  // here authored, so what arrives is sanitised: control characters are
  // stripped apart from tab and newline, which real multi-line copies need,
  // and the size is capped. Newlines stay deliberately — a selection is lines
  // — so a hostile sequence could still leave a runnable command on the
  // clipboard; pasting into a shell with bracketed paste on (bash's default)
  // inserts it as text rather than running it.
  const OSC52_MAX = 100 * 1024;
  term.parser.registerOscHandler(52, (data) => {
    // "<targets>;<base64>", where "?" asks to READ the clipboard — deliberately
    // never answered: handing the program inside the clipboard back is a leak.
    const semi = String(data).indexOf(';');
    if (semi < 0) return true;
    const payload = String(data).slice(semi + 1);
    if (!payload || payload === '?' || payload.length > OSC52_MAX) return true;
    try {
      const text = atob(payload).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
      if (text) window.api.copySelection(text);
    } catch (_) { /* not valid base64 — nothing to copy */ }
    return true;
  });

  // A selection copies itself (CLIPBOARD, and PRIMARY on X11), so
  // select-then-paste needs no chord in between; right-click pastes.
  // Ctrl+Shift+C/V remain as the conventional explicit pair, while plain
  // Ctrl+C/V stay with the program inside, which owns them (SIGINT, verbatim
  // insert).
  //
  // Copying rides on the mouseup, in the CAPTURE phase — before any of
  // xterm's own listeners. Under a mouse-tracking app (Claude's TUI) the
  // release of a forced drag is reported as input, input clears the
  // selection, and only then does xterm fire its public selection event —
  // which therefore always reads empty for exactly the drags that matter.
  // Mid-drag the model is live, so the capture handler still sees the text.
  const copyNow = () => {
    const sel = term.getSelection();
    if (sel) window.api.copySelection(sel);
  };
  termEl.addEventListener('mouseup', (e) => { if (e.button === 0) copyNow(); }, true);
  // Selections made without a drag (double-click word select, select-all)
  // still announce themselves here.
  const offSelect = term.onSelectionChange(copyNow);

  // The wheel is left to tmux, drag or no drag. Keeping it here to extend a
  // selection past the window was tried and is a dead end: under tmux this
  // terminal holds no scrollback of its own (viewport scrollHeight equals
  // clientHeight — tmux keeps the history and redraws the pane), so there is
  // nothing above to scroll to, and intercepting the wheel only takes away the
  // scrolling that does work. A selection still dies when the wheel reaches
  // tmux, because the report counts as input and input clears it — scroll
  // first, then select what is on screen.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
    // Ctrl+V pastes, with or without Shift — the key everyone reaches for,
    // and the other half of copying in the output window. It is taken from
    // the program inside, which knows it as quoted-insert (readline) and
    // visual block (vim); those still answer to Ctrl+Q and to typing the
    // sequence, and pasting is the far commoner want here.
    if (e.code === 'KeyV') {
      window.api.readClipboard().then((text) => { if (text) term.paste(text); });
      return false;
    }
    // Ctrl+C is NOT taken: it is the interrupt, and a terminal that cannot
    // interrupt is broken. Copying explicitly is Ctrl+Shift+C — though a
    // selection has already copied itself by then.
    if (e.shiftKey && e.code === 'KeyC') {
      const sel = term.getSelection();
      if (!sel) return true;        // nothing selected — the program's key
      window.api.copySelection(sel);
      return false;
    }
    return true;
  });
  // Right-click pastes, the classic X-terminal way. Captured on the ancestor
  // so the press never reaches xterm's mouse forwarding — otherwise tmux
  // (mouse on) pops its own menu over the pane.
  const rightPaste = (e) => {
    if (e.button !== 2) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'mousedown') {
      window.api.readClipboard().then((text) => { if (text) term.paste(text); });
    }
  };
  termEl.addEventListener('mousedown', rightPaste, true);
  termEl.addEventListener('mouseup', rightPaste, true);
  termEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); }, true);

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
    markDead(t);
    term.write(`\r\n\x1b[31m${window.t('panel.exited')}\x1b[0m\r\n`);
  });

  Object.assign(t, {
    materialized: true, term, fit, panelEl,
    cleanup: () => { offData(); offExit(); offSelect.dispose(); ro.disconnect(); },
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
  const orderIndex = tabOrder.indexOf(id);
  if (orderIndex >= 0) tabOrder.splice(orderIndex, 1);
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
// its checkout came from. TabDesk agents use `.worktrees/`; Claude Code also
// keeps checkouts under `.claude/worktrees/`.
const WT_MARKERS = ['/.worktrees/', '/.claude/worktrees/'];

function ownerOf(cwd) {
  const s = String(cwd || '');
  let cut = -1;
  for (const m of WT_MARKERS) {
    const i = s.indexOf(m);
    if (i > 0 && i > cut) cut = i;
  }
  return cut > 0 ? s.slice(0, cut) : s;
}

function worktreeFolder(cwd) {
  const s = String(cwd || '');
  for (const m of WT_MARKERS) {
    const i = s.indexOf(m);
    if (i > 0) {
      const rest = s.slice(i + m.length);
      const folder = rest.split('/').filter(Boolean)[0];
      return folder || null;
    }
  }
  return null;
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
  // than reusing whatever the project's default agent is set to. Effort is
  // stored the same way and asked for alongside it.
  const [model, effort] = await Promise.all([
    window.api.getModel(cwd, agent),
    window.api.getEffort(cwd, agent),
  ]);
  const id = buildTab({ name, cwd, projectCwd: owner, model, effort, agent, resume });
  const tab = tabs.get(id);
  if (alloc && alloc.session) tab.session = alloc.session;
  if (resume) {
    // Both runtimes carry on in the conversation they were given: Codex under
    // the same id, and Claude appending to the same transcript file (checked
    // against the file it reopened). Pinning it here is what lets the output
    // view read the conversation immediately rather than waiting for the
    // birth-match a fresh session needs.
    if (resume.id) tab.agentSession = resume.id;
    const titled = resume.title && titledName(resume.title, cwd, owner);
    if (titled) renameTab(id, titled);
  }
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
    <span class="ask" aria-hidden="true">💬</span>
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
  if (s.askingAt) return t('overview.state.asking', { time: waitLabel(s.askingAt) || '0m' });
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

const dotClass = (s) => 'dot'
  + (s.dead ? ' dead' : s.busy ? ' busy' : s.askingAt ? ' asking' : s.doneAt ? ' done' : '');

function liveRow(s) {
  const row = newEl('button', 'ov-row');
  row.dataset.id = s.id;
  const dot = newEl('span', dotClass(s));
  row.append(dot, newEl('span', 'ov-name', s.name), newEl('span', 'ov-state', sessionState(s)));
  if (s.model && s.model !== 'default') row.appendChild(newEl('span', 'ov-model', s.model));
  row.addEventListener('click', () => setActive(s.id));
  return row;
}

// The "running now" list is the one part of the overview that changes while you
// look at it, so renderProject calls this on every state change. Patched rather
// than rebuilt: this runs on every chunk of output, and replacing the buttons
// under the pointer would eat clicks.
function renderLiveRows(cwd) {
  if (overviewCwd !== cwd) return;
  const host = overviewEl.querySelector('.ov-sec.live');
  if (!host) return;
  const mine = sessionsOf(cwd);
  const rows = [...host.querySelectorAll('.ov-row')];
  if (rows.length !== mine.length || rows.some((el, i) => el.dataset.id !== mine[i].id)) {
    while (host.children.length > 1) host.lastElementChild.remove();   // keep the <h3>
    if (!mine.length) host.appendChild(newEl('p', 'ov-empty', t('overview.none')));
    for (const s of mine) host.appendChild(liveRow(s));
    return;
  }
  rows.forEach((el, i) => {
    const s = mine[i];
    const dot = el.querySelector('.dot');
    const cls = dotClass(s);
    if (dot.className !== cls) dot.className = cls;
    const state = el.querySelector('.ov-state');
    const text = sessionState(s);
    if (state.textContent !== text) state.textContent = text;
  });
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

  // What it is running now. Filled by renderLiveRows, which owns these rows
  // from here on.
  const live = section(t('overview.active'));
  live.classList.add('live');
  overviewEl.appendChild(live);
  renderLiveRows(cwd);

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
    row.addEventListener('click', () => newSession(cwd, r.agent, { resume: { id: r.id, title: r.title } }));
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

// ---- Session output: the history, as selectable text ----
// The terminal can only ever hand over the screen in front of you — tmux keeps
// the history and redraws the pane, so there is nothing above the top row to
// drag a selection into. This asks tmux for the lot and shows it as ordinary
// text, where selecting across pages is just what a browser does.
const historyEl = document.getElementById('history');
const historyBody = document.getElementById('history-body');
const historyTitle = document.getElementById('history-title');

function closeHistory() {
  historyEl.classList.add('hidden');
  historyBody.textContent = '';
}

async function openHistory() {
  const tab = tabs.get(activeId);
  if (!tab || !tab.materialized) { toast(window.t('toast.noTerminal')); return; }
  const res = await window.api.scrollback({ id: tab.id, cwd: tab.cwd, agentSession: tab.agentSession || null });
  if (!res || !res.ok) {
    // No tmux session behind this tab (a loose terminal): the terminal's own
    // buffer is then the whole truth, and it is already selectable there.
    toast(window.t(res && res.reason === 'no-session' ? 'toast.historyNoSession' : 'toast.historyFailed'));
    return;
  }
  historyTitle.textContent = fullName(tab) + (res.source === 'transcript' ? ' · ' + t('history.fromTranscript') : '');
  historyBody.textContent = res.text || '';
  historyEl.classList.remove('hidden');
  // Land at the end, where the newest output is, like the terminal itself.
  historyBody.scrollTop = historyBody.scrollHeight;
}

// Selecting copies, the same bargain the terminal makes — so the answer to
// "select this and paste it there" is the same gesture in both places.
// This window is a document, not a terminal, so it behaves like one: select,
// Ctrl+C, and the selection clears itself the way a copy that has landed
// should — with a line saying it did. Nothing is copied behind your back here;
// the terminal auto-copies because a selection there has no other way out.
function copyHistorySelection() {
  const sel = window.getSelection();
  const text = sel ? sel.toString() : '';
  if (!text) return false;
  window.api.copySelection(text);
  sel.removeAllRanges();
  toast(window.t('toast.copied', { n: text.split('\n').length }));
  return true;
}

document.getElementById('history-btn').addEventListener('click', openHistory);
document.getElementById('history-close').addEventListener('click', closeHistory);
// The dimmed surround is not part of the window: clicking it closes, the way
// a dialog does. Clicks inside land on the box and stop there.
historyEl.addEventListener('mousedown', (e) => { if (e.target === historyEl) closeHistory(); });
document.getElementById('history-copy').addEventListener('click', () => {
  const text = historyBody.textContent;
  if (text) window.api.copySelection(text);
  toast(window.t('toast.historyCopied'));
});
document.addEventListener('keydown', (e) => {
  if (historyEl.classList.contains('hidden')) return;
  if (e.key === 'Escape') { closeHistory(); return; }
  if (!e.ctrlKey || e.altKey || e.metaKey) return;
  // Plain Ctrl+C is free here in a way it never is in a terminal, where it
  // belongs to the program inside as its interrupt.
  if (e.code === 'KeyC' && !e.shiftKey) {
    if (copyHistorySelection()) e.preventDefault();
    return;
  }
  // Everything, without dragging through it.
  if (e.code === 'KeyA' && !e.shiftKey) {
    const range = document.createRange();
    range.selectNodeContents(historyBody);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    e.preventDefault();
  }
});

// ---- Instruction files: CLAUDE.md, AGENTS.md & friends, edited in place ----
//
// Same overlay pattern as the output viewer above. Three picks — project,
// runtime, and which of the runtime's two files (the project's own, or the
// user-wide one) — and a textarea. Main resolves and validates the path; this
// window only ever deals in (project, agent, scope).
const instrEl = document.getElementById('instr');
const instrTitle = document.getElementById('instr-title');
const instrProject = document.getElementById('instr-project');
const instrAgent = document.getElementById('instr-agent');
const instrScope = document.getElementById('instr-scope');
const instrBody = document.getElementById('instr-body');
const instrStatus = document.getElementById('instr-status');

let instrAgents = [];   // instructions:list for the picked project
let instrClean = '';    // content as last read or saved — the dirty check
let instrSel = { project: null, agent: null, scope: null };   // last valid picks

function instrFill(sel, items, selected, toOption) {
  sel.textContent = '';
  for (const item of items) {
    const opt = document.createElement('option');
    const { value, label } = toOption(item);
    opt.value = value;
    opt.textContent = label;
    opt.selected = value === selected;
    sel.appendChild(opt);
  }
}

const instrCurrent = () => instrAgents.find((a) => a.id === instrAgent.value);

function instrFillScopes() {
  const a = instrCurrent();
  const opts = [];
  if (a && a.projectFile) {
    opts.push({ value: 'project', label: window.t('instructions.scope.project', { name: a.projectFile.name }) });
  }
  if (a && a.globalFile) {
    opts.push({ value: 'global', label: window.t('instructions.scope.global', { name: a.globalFile.path }) });
  }
  instrFill(instrScope, opts, instrScope.value, (o) => o);
}

async function instrRead() {
  const a = instrCurrent();
  instrBody.value = '';
  instrClean = '';
  instrTitle.textContent = '';
  instrStatus.textContent = '';
  if (!a) return;
  const res = await window.api.instructionsRead({
    agent: a.id, scope: instrScope.value, projectPath: instrProject.value,
  });
  if (!res.ok) {
    instrStatus.textContent = window.t('instructions.error', { error: res.error || '' });
    return;
  }
  instrBody.value = res.content;
  instrClean = res.content;
  instrTitle.textContent = res.path;
  // A file that is not there yet is not an error — saving creates it.
  if (!res.exists) instrStatus.textContent = window.t('instructions.missing');
}

async function instrLoadAgents() {
  instrAgents = (await window.api.instructionsList(instrProject.value)) || [];
  instrFill(instrAgent, instrAgents, instrAgent.value, (a) => ({ value: a.id, label: a.label }));
  instrFillScopes();
  await instrRead();
  instrSel = { project: instrProject.value, agent: instrAgent.value, scope: instrScope.value };
}

// Switching any pick — or closing — reloads the file, which would silently
// discard typed edits. Ask first; a "keep editing" answer restores the picks.
function instrGuard() {
  if (instrBody.value === instrClean || window.confirm(window.t('instructions.dirty'))) return true;
  instrProject.value = instrSel.project;
  instrAgent.value = instrSel.agent;
  instrScope.value = instrSel.scope;
  return false;
}

async function openInstructions() {
  const tab = tabs.get(activeId);
  const rows = [...projects.values()];
  if (!rows.length) return;
  if (!historyEl.classList.contains('hidden')) closeHistory();
  // Default to what is on screen: the active tab's project, and the runtime
  // its session actually runs — the file that opens is the one that session
  // reads. Both stay changeable afterwards.
  instrFill(instrProject, rows, (tab && tab.cwd) || null, (p) => ({ value: p.path, label: p.name }));
  instrAgents = (await window.api.instructionsList(instrProject.value)) || [];
  if (!instrAgents.length) { toast(window.t('instructions.none')); return; }
  instrFill(instrAgent, instrAgents, tab ? agentFor(tab) : null, (a) => ({ value: a.id, label: a.label }));
  instrScope.value = 'project';
  instrFillScopes();
  await instrRead();
  instrSel = { project: instrProject.value, agent: instrAgent.value, scope: instrScope.value };
  instrEl.classList.remove('hidden');
  instrBody.focus();
}

function closeInstructions() {
  if (!instrGuard()) return;
  instrEl.classList.add('hidden');
  instrBody.value = '';
}

document.getElementById('instr-btn').addEventListener('click', openInstructions);
document.getElementById('instr-close').addEventListener('click', closeInstructions);
instrEl.addEventListener('mousedown', (e) => { if (e.target === instrEl) closeInstructions(); });

instrProject.addEventListener('change', async () => { if (instrGuard()) await instrLoadAgents(); });
instrAgent.addEventListener('change', async () => {
  if (!instrGuard()) return;
  instrFillScopes();
  await instrRead();
  instrSel = { project: instrProject.value, agent: instrAgent.value, scope: instrScope.value };
});
instrScope.addEventListener('change', async () => {
  if (!instrGuard()) return;
  await instrRead();
  instrSel = { project: instrProject.value, agent: instrAgent.value, scope: instrScope.value };
});

document.getElementById('instr-save').addEventListener('click', async () => {
  const res = await window.api.instructionsWrite({
    agent: instrAgent.value, scope: instrScope.value,
    projectPath: instrProject.value, content: instrBody.value,
  });
  if (!res.ok) {
    instrStatus.textContent = window.t('instructions.error', { error: res.error || '' });
    return;
  }
  instrClean = instrBody.value;
  instrStatus.textContent = '';
  toast(window.t('instructions.saved'));
});

document.addEventListener('keydown', (e) => {
  if (instrEl.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeInstructions();
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
    if (rec.agentSession) tabs.get(id).agentSession = rec.agentSession;
  }
  // Now that the restored tabs exist, ask tmux about them directly rather than
  // waiting for a push — pushes only carry changes, and a session sitting on a
  // question has nothing left to change.
  if (window.api.activityNow) window.api.activityNow().then(applyActivity).catch(() => {});
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

// ---- Place readout (bottom system bar) ----
// Project of the session in focus, plus its git branch (from .git/HEAD via
// main). Prefers the live pane path from tmux when the agent has moved into a
// worktree — tab.cwd alone stays on the project root where the session began.
// Async IPC: a late reply after a tab switch is dropped.
const placeStat = document.getElementById('m-place');
const placeVal = document.getElementById('place-val');
let placeSeq = 0;

function placeCwd(tab) {
  if (tab && tab.session && liveCwd.has(tab.session)) return liveCwd.get(tab.session);
  if (tab && tab.cwd) return tab.cwd;
  return activeCwd || null;
}

async function renderPlace() {
  const seq = ++placeSeq;
  const tab = tabs.get(activeId);
  const cwd = placeCwd(tab);
  const owner = cwd ? ownerOf(cwd) : (activeCwd || null);
  if (!owner) {
    placeStat.classList.add('hidden');
    placeVal.textContent = '–';
    placeStat.title = '';
    return;
  }
  const p = projects.get(owner) || (activeCwd ? projects.get(activeCwd) : null)
    || [...projects.values()].find((x) => x.path === owner || ownerOf(x.path) === owner) || null;
  const name = (p && p.name) || owner.split('/').pop();
  const pathShown = cwd || (p && p.path) || owner;
  const wtFolder = worktreeFolder(cwd);
  const isWt = !!wtFolder;
  let branch = null;
  if (cwd && window.api.gitBranch) {
    try { branch = await window.api.gitBranch(cwd); } catch (_) { branch = null; }
  }
  if (seq !== placeSeq) return;
  // Worktree: prefer git branch (folder often ≠ branch); folder is fallback.
  // Main checkout: just the branch name.
  const label = isWt ? (branch || wtFolder) : branch;
  let text = name;
  if (label && isWt) text = `${name} · ⑂ ${label}`;
  else if (label) text = `${name} · ${label}`;
  placeVal.textContent = text;
  placeStat.title = isWt && label
    ? t('bar.place.titleWorktree', { project: name, branch: label, path: pathShown })
    : label
      ? t('bar.place.titleBranch', { project: name, branch: label, path: pathShown })
      : t('bar.place.title', { project: name, path: pathShown });
  placeStat.classList.remove('hidden');
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
    // The "Default" row spells out what following the agent means today.
    hint.textContent = m.id === 'default'
      ? t('model.hint.default', { agent: agentLabel(activeAgent() || 'claude'), model: barLabel('default') })
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

// ---- Effort picker ----
// The model picker's twin: same shape, same storage rules (per project, per
// agent), the same "a live terminal keeps what it launched with". It hides
// itself for agents that have no reasoning-effort setting at all rather than
// showing a control that can't do anything.
const effortBtn = document.getElementById('effort-btn');
const effortMenu = document.getElementById('effort-menu');
const effortStat = document.getElementById('m-effort');
let effortList = [];
let effortListAgent = null;
let globalEffort = 'default';

async function loadEfforts(agent) {
  if (effortListAgent === agent) return;
  const res = await window.api.listEfforts(agent);
  if (!res || !Array.isArray(res.list)) return;
  effortList = res.list;
  globalEffort = res.global || 'default';
  effortListAgent = agent;
}

function activeEffort() {
  const tab = tabs.get(activeId);
  return (tab && tab.effort) || 'default';
}

function effortBarLabel(id) {
  if (id !== 'default') return id;
  return globalEffort === 'default' ? t('bar.effort.auto') : globalEffort;
}

function renderEffortBtn() {
  const tab = tabs.get(activeId);
  const agent = activeAgent();
  const show = Boolean(agent) && effortSupported(agent);
  effortStat.classList.toggle('hidden', !show);
  if (!show) return;
  if (effortListAgent !== agent) {
    loadEfforts(agent).then(() => { if (activeAgent() === agent) renderEffortBtn(); });
  }
  const id = activeEffort();
  const pending = !!(tab && tab.materialized && tab.runningEffort !== tab.effort);
  effortBtn.textContent = effortBarLabel(id) + (pending ? ' •' : '');
  effortBtn.classList.toggle('picked', id !== 'default' && !pending);
  effortBtn.classList.toggle('pending', pending);
  effortBtn.title = pending
    ? t('bar.effort.pending', { effort: effortBarLabel(tab.runningEffort) })
    : t('bar.effort.title', { agent: agentLabel(agent) });
}

function renderEffortMenu() {
  const id = activeEffort();
  effortMenu.innerHTML = '';
  for (const e of effortList) {
    const item = document.createElement('button');
    item.className = 'menu-item' + (e.id === id ? ' current' : '');
    item.setAttribute('role', 'menuitem');
    item.dataset.effort = e.id;
    const label = document.createElement('span');
    label.className = 'mi-label';
    label.textContent = (e.id === id ? '✓ ' : '') + e.label;
    const hint = document.createElement('span');
    hint.className = 'mi-hint';
    hint.textContent = e.id === 'default'
      ? t('bar.effort.follows', { agent: agentLabel(activeAgent() || 'claude'), effort: effortBarLabel('default') })
      : (e.hint ? t(e.hint) : '');
    item.append(label, hint);
    effortMenu.appendChild(item);
  }
}

function closeEffortMenu() {
  effortMenu.classList.add('hidden');
  effortBtn.setAttribute('aria-expanded', 'false');
}

effortBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  const open = effortMenu.classList.contains('hidden');
  if (open) {
    const agent = activeAgent();
    if (agent) { effortListAgent = null; await loadEfforts(agent); }
    renderEffortMenu();
  }
  effortMenu.classList.toggle('hidden', !open);
  effortBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', closeEffortMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEffortMenu(); });

effortMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.menu-item');
  if (!item) return;
  e.stopPropagation();
  closeEffortMenu();
  const tab = tabs.get(activeId);
  if (!tab || !tab.cwd) return;
  const id = item.dataset.effort;
  if (id === tab.effort) return;

  const agent = agentFor(tab);
  const res = await window.api.setEffort(tab.cwd, agent, id);
  if (!res || !res.ok) {
    toast(window.t('toast.effortFailed', { error: (res && res.error) || '' }));
    return;
  }
  for (const other of tabs.values()) {
    if (other.cwd === tab.cwd && agentFor(other) === agent) other.effort = res.effort;
  }
  renderEffortBtn();
  const label = effortBarLabel(tab.effort);
  toast(tab.materialized
    ? window.t('toast.effortLater', { project: tab.name, effort: label })
    : window.t('toast.effortSet', { project: tab.name, effort: label }));
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

renderPlace();
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

// The three meters follow the focused session's runtime. Mixing one runtime's
// numbers into another's chrome is the failure mode to avoid: a Codex tab must
// never show Claude's plan bars, and an opencode tab must never fall back to
// Claude transcript totals just because they happen to be in memory.
//
//   claude   plan windows from the account API, else local transcript estimate
//   codex    plan windows from the latest rollout
//   kimi     plan windows from the managed /usages endpoint (same as CLI /usage)
//   opencode no plan API and no honest per-model quota — meters stay hidden
//   other    dashed "no data" under that runtime's name
const PLAN_METERS = [['m-session', 'session'], ['m-week', 'week'], ['m-scoped', 'scoped']];
let usage = null;          // last local Claude scan — Claude meters only
let limits = { ok: false }; // last plan-limit read (claude/codex/kimi)
let metersAgent = 'claude'; // the runtime the bar currently describes

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

function clearMeterReset(sel) {
  const node = document.querySelector(`#${sel} .m-reset`);
  if (node) node.textContent = '';
}

function renderPlanMeters() {
  for (const [sel, key] of PLAN_METERS) {
    const el = document.getElementById(sel);
    const win = limits[key];
    // Not every plan meters every window (Opus in particular) — a window the
    // account doesn't have is hidden, not shown at zero.
    el.classList.toggle('hidden', !win);
    if (!win) { clearMeterReset(sel); continue; }
    if (win.label) setMeterLabelRaw(sel, win.label);
    else setMeterLabel(sel, `bar.${key}`);
    setMeter(sel, win.pct, Math.round(win.pct) + '%', meterHot(win));
    el.title = metersAgent === 'codex'
      ? t(limits.stale ? 'bar.codexTitleStale' : 'bar.codexTitle')
      : metersAgent === 'kimi'
        ? t(limits.stale ? 'bar.kimiTitleStale' : 'bar.kimiTitle')
        : t(limits.stale ? 'bar.planTitleStale' : 'bar.planTitle');
  }
}

// Claude-only fallback when the plan API is unreachable: local transcript
// tokens for today and this week. Must not run for any other runtime.
function renderLocalMeters() {
  document.getElementById('m-scoped').classList.add('hidden');
  clearMeterReset('m-scoped');
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

// opencode has no plan-quota API and no honest per-model limit we can show
// next to Claude/Codex. Hide the plan meters rather than invent local spend
// bars that look like the same thing.
function hidePlanMeters() {
  for (const [sel] of PLAN_METERS) {
    const el = document.getElementById(sel);
    el.classList.add('hidden');
    clearMeterReset(sel);
    el.title = '';
  }
}

// A runtime whose usage exists nowhere we can read: two dashed meters under
// their usual labels, saying whose plan it is we can't see. Falling back to
// the Claude transcripts here would dress one runtime in another's numbers.
function renderNoDataMeters() {
  document.getElementById('m-scoped').classList.add('hidden');
  clearMeterReset('m-scoped');
  for (const sel of ['m-session', 'm-week']) {
    const el = document.getElementById(sel);
    el.classList.remove('hidden');
    setMeterLabel(sel, sel === 'm-session' ? 'bar.session' : 'bar.week');
    setMeter(sel, 0, '–');
    clearMeterReset(sel);
    el.title = t('bar.noQuota', { agent: agentLabelOf(metersAgent) });
  }
}

function renderMeters() {
  if (metersAgent === 'opencode') hidePlanMeters();
  else if (limits.ok) renderPlanMeters();
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
  metersAgent = agent;

  if (agent === 'opencode') {
    // Drop any previous plan payload so a later paint cannot reuse it.
    limits = { ok: false, reason: 'unsupported' };
    renderMeters();
    return;
  }

  const result = (await window.api.getUsageLimits(agent)) || { ok: false, reason: 'network' };
  if (focusedAgent() !== agent) return;
  metersAgent = agent;
  limits = result;
  renderMeters();
}

// The transcript scan walks every .jsonl under ~/.claude/projects — worth doing
// rarely. It feeds Claude's local-fallback meters only; skip repaint while
// another runtime owns the bar.
async function refreshUsage() {
  const u = await window.api.getUsageStats();
  if (!u) return;
  usage = u;
  if (metersAgent === 'claude') renderMeters();
}

async function refreshSystem() {
  const s = await window.api.getSystemStats();
  if (!s) return;
  setMeter('m-cpu', s.cpu, s.cpu + '%', s.cpu >= 85);
  const memPct = (s.memUsed / s.memTotal) * 100;
  setMeter('m-ram', memPct, fmtBytes(s.memUsed), memPct >= 90);
  // Branch can change inside the terminal without a tab switch — cheap HEAD read.
  renderPlace();
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
// timestamps. Local Claude only has a day boundary (midnight) on the first
// meter — the week is a rolling window with nothing to count down to.
// Other runtimes and hidden meters stay blank so a previous plan's reset time
// cannot linger after a focus switch.
function tickResets() {
  const now = Date.now();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  const localDay = metersAgent === 'claude' && !limits.ok;

  for (const [sel, key] of PLAN_METERS) {
    const node = document.querySelector(`#${sel} .m-reset`);
    if (!node) continue;
    let at = null;
    if (limits.ok) {
      at = limits[key] && limits[key].resetsAt;
    } else if (localDay && sel === 'm-session') {
      at = midnight.getTime();
    }
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
    if (!t.doneAt && !t.askingAt) continue;
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
    renderPlace();
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
    if (!instrEl.classList.contains('hidden')) instrFillScopes();
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

// ---- Session names from the runtimes' own stores ----
// A tab is born under its agent's label; the conversation inside soon has a
// name of its own — Claude rewrites a summary every turn, Codex files the
// opening message as the thread's title. The Earlier list already reads those
// stores (sessions:previous, cached a minute in main); this loop matches the
// rows to the live tabs and lifts the names onto them.
//
// Matching: a resumed Codex tab knows its conversation id up front; Claude
// forks a fresh id on resume, and a brand-new session's id exists only on
// disk. Both are matched by birth — the store file born right after the tab
// started is that tab's conversation, and with two fresh tabs on one project
// the oldest tab claims the earliest birth. Once matched the id sticks and is
// persisted on the record, so later rounds (and restarts) just follow renames.
const TITLED_AGENTS = new Set(['claude', 'codex']);

async function refreshTitles() {
  const eligible = [...tabs.values()].filter((t) =>
    t.session && t.cwd && !t.startCmd && t.materialized && TITLED_AGENTS.has(agentFor(t)));
  const byCwd = new Map();
  for (const t of eligible) {
    if (!byCwd.has(t.cwd)) byCwd.set(t.cwd, []);
    byCwd.get(t.cwd).push(t);
  }
  for (const [cwd, group] of byCwd) {
    let rows;
    try { rows = await window.api.previousSessions(cwd); } catch (_) { continue; }
    if (!Array.isArray(rows) || !rows.length) continue;
    const claimed = new Set([...tabs.values()].map((x) => x.agentSession).filter(Boolean));
    for (const tab of group.slice().sort((a, b) => (a.bornAt || 0) - (b.bornAt || 0))) {
      let row = tab.agentSession ? rows.find((r) => r.id === tab.agentSession) : null;
      if (!row && !tab.agentSession && tab.bornAt) {
        row = rows
          .filter((r) => r.agent === agentFor(tab) && !claimed.has(r.id)
            && r.born && r.born >= tab.bornAt - 5000)
          .sort((a, b) => a.born - b.born)[0] || null;
        if (row) {
          tab.agentSession = row.id;
          claimed.add(row.id);
          // Persist the match now: the title can arrive after a restart.
          if (tab.session) window.api.renameTab(tab.session, tab.name, row.id);
        }
      }
      if (row && row.title) renameTab(tab.id, titledName(row.title, tab.cwd, tab.projectCwd));
    }
  }
}
setInterval(refreshTitles, 45000);
setTimeout(refreshTitles, 8000);   // a resumed strip shouldn't wait a minute
setInterval(refreshUsage, 300000);  // re-scan transcripts every 5 min
