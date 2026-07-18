const { Terminal } = window;          // xterm global
const { FitAddon } = window.FitAddon; // fit addon global

const tabList = document.getElementById('tab-list');
const panels = document.getElementById('panels');
const emptyState = document.getElementById('empty-state');

// Default terminal backend: in-app xterm.js (reliable, renders in the DOM,
// screenshottable). Flip to true to embed a native xfce4-terminal per panel
// (X11 reparenting — fragile under HiDPI/multi-instance, kept as an option).
const EMBED_XFCE = false;

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

// Clear any busy/done flags on a tab (called when the user looks at it).
function clearTabFlag(t) {
  clearTimeout(t.idleTimer);
  t.busy = false;
  t.tabEl.classList.remove('busy', 'done');
}

// Called on every chunk of pty output. Marks background tabs busy while output
// flows, then green ("done") once they fall silent.
function markActivity(id) {
  const t = tabs.get(id);
  if (!t || t.tabEl.classList.contains('dead')) return;

  if (isWatched(id)) { clearTabFlag(t); return; }

  t.busy = true;
  t.tabEl.classList.add('busy');
  t.tabEl.classList.remove('done');
  clearTimeout(t.idleTimer);
  t.idleTimer = setTimeout(() => {
    if (!t.busy) return;
    t.busy = false;
    t.tabEl.classList.remove('busy');
    if (!isWatched(id)) t.tabEl.classList.add('done');
  }, IDLE_MS);
}

function setActive(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (!t.materialized) materialize(t);

  // Opening a tab means you're now watching it — drop the "done" flag.
  clearTabFlag(t);

  // Move id to the front of the visible set, trimmed to gridSize.
  const i = visible.indexOf(id);
  if (i !== -1) visible.splice(i, 1);
  visible.push(id);
  while (visible.length > gridSize) visible.shift();

  activeId = id;
  applyLayout();
  for (const vid of visible) fitSoon(vid);
  requestAnimationFrame(() => { if (t.term) t.term.focus(); });
  scheduleSync();
}

// ---- Embedded xfce4-terminal placement ----
// Native terminal windows don't flow with the DOM, so we push each visible
// panel's on-screen rectangle to main and let it move/size the X window to
// match. Hidden panels get unmapped.
let syncQueued = false;
function scheduleSync() {
  if (!EMBED_XFCE || syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => { syncQueued = false; syncXfce(); });
}
function syncXfce() {
  const dpr = window.devicePixelRatio || 1;
  for (const [tid, tt] of tabs) {
    if (!tt.xfce || !tt.panelEl) continue;
    if (!tt.panelEl.classList.contains('shown')) { window.api.hideXfceTerminal(tid); continue; }
    const el = tt.panelEl.querySelector('.term') || tt.panelEl;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    window.api.placeXfceTerminal(tid, { x: r.x * dpr, y: r.y * dpr, w: r.width * dpr, h: r.height * dpr });
  }
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

// Build only the tab row in the rail. The terminal/pty is created lazily.
function buildTab({ name, cwd, startCmd }) {
  const id = `t${++seq}`;
  const tabEl = document.createElement('li');
  tabEl.className = 'tab';
  tabEl.title = cwd || name;
  tabEl.innerHTML = `
    <span class="dot"></span>
    <span class="label"></span>
    <button class="close" title="Close">×</button>`;
  tabEl.querySelector('.label').textContent = name;
  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) return;
    setActive(id);
  });
  tabEl.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(id);
  });
  tabList.appendChild(tabEl);

  tabs.set(id, { id, name, cwd, startCmd, tabEl, materialized: false });
  return id;
}

// Create the actual xterm instance + backing pty for a tab on first use.
function materialize(t) {
  const id = t.id;

  const panelEl = document.createElement('div');
  panelEl.className = 'panel';
  const termEl = document.createElement('div');
  termEl.className = 'term';
  panelEl.appendChild(termEl);

  // Per-panel close button (appears on hover) so you can close a pane directly.
  const panelClose = document.createElement('button');
  panelClose.className = 'panel-close';
  panelClose.title = 'Close this panel';
  panelClose.textContent = '×';
  panelClose.addEventListener('mousedown', (e) => e.stopPropagation());
  panelClose.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  panelEl.appendChild(panelClose);

  panels.appendChild(panelEl);

  // Embedded xfce4-terminal: the panel is just a placeholder rectangle; the
  // real terminal is a native window main reparents on top of it.
  if (EMBED_XFCE) {
    termEl.classList.add('xfce');
    termEl.innerHTML = '<span class="term-loading">▶ xfce4-terminal…</span>';
    const ro = new ResizeObserver(() => scheduleSync());
    ro.observe(panelEl);
    panelEl.addEventListener('mousedown', () => {
      if (activeId !== id) { activeId = id; applyLayout(); }
    });
    window.api.createXfceTerminal(id, t.cwd, t.startCmd);
    Object.assign(t, {
      materialized: true, xfce: true, panelEl,
      cleanup: () => ro.disconnect(),
    });
    scheduleSync();
    return;
  }

  const term = new Terminal({
    fontFamily: 'Menlo, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: {
      background: '#03060fdd',
      foreground: '#eaf4ff',
      cursor: '#34e2ff',
      cursorAccent: '#03060f',
      selectionBackground: 'rgba(43,140,255,.35)',
      black: '#0a1024', brightBlack: '#3a5a8c',
      blue: '#2b8cff', brightBlue: '#64b5ff',
      cyan: '#34e2ff', brightCyan: '#a9e6ff',
      white: '#eaf4ff', brightWhite: '#ffffff',
      green: '#4ffbdf', brightGreen: '#8affe8',
      red: '#ff5c8a', magenta: '#9a7bff', yellow: '#ffd36e',
    },
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

  window.api.createTerminal(id, term.cols, term.rows, t.cwd, t.startCmd);
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
    term.write('\r\n\x1b[31m[process exited]\x1b[0m\r\n');
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
    if (t.xfce) {
      window.api.killXfceTerminal(id);
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
  if (visible.length === 0 && tabs.size === 0) emptyState.classList.remove('hidden');
}

// Ad-hoc terminal in home dir via the "+" button.
let adHoc = 0;
document.getElementById('add-terminal').addEventListener('click', () => {
  const id = buildTab({ name: `Terminal ${++adHoc}`, cwd: null });
  setActive(id);
});

document.getElementById('fullscreen-btn').addEventListener('click', () => window.api.toggleFullscreen());
window.addEventListener('resize', () => { for (const vid of visible) fitTerm(vid); scheduleSync(); });

// Grid button: cycle 1 → 6 → 1 panels shown at once.
const gridBtn = document.getElementById('grid-btn');
function updateGridBtn() { gridBtn.textContent = `▦ Grid ${gridSize}`; }
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
  if (!t || !t.panelEl) { toast('No active terminal to capture'); return; }
  if (t.xfce) { toast('Embedded xfce4-terminal is not visible in the in-app screenshot'); return; }
  const el = t.panelEl.querySelector('.term') || t.panelEl;
  const r = el.getBoundingClientRect();
  const res = await window.api.captureTerminal(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    t.name,
  );
  toast(res && res.ok ? `📷 Saved: ${res.path.split('/').pop()}` : 'Could not save screenshot');
});

// ---- Interactive project preview (fixed right dock) ----
// Runs the active project — static HTML or a live app (Python, Rust, Node, Go…)
// — in the webview, streaming its startup logs into the code panel until it
// binds a port, then swapping to element-inspection on hover.
const preview = document.getElementById('preview');
const previewView = document.getElementById('preview-view');
const previewTitle = document.getElementById('preview-title');
const previewCrumb = document.getElementById('preview-crumb');
const previewHtml = document.getElementById('preview-html');
const previewEmpty = document.getElementById('preview-empty');

let previewMode = 'idle';   // idle | starting | live
let previewLog = '';        // accumulated process output while starting

function setEmptyMessage(html) {
  previewEmpty.innerHTML = html;
  previewEmpty.classList.remove('hidden');
  previewView.classList.add('dim');
}
function showWebview() {
  previewEmpty.classList.add('hidden');
  previewView.classList.remove('dim');
}

// Element inspector messages from the running page. Only meaningful once live.
previewView.addEventListener('ipc-message', (e) => {
  if (e.channel !== 'inspect' || previewMode !== 'live') return;
  const d = e.args[0] || {};
  if (d.resume) { previewCrumb.textContent = 'Hover over the preview to see its code…'; return; }
  previewCrumb.textContent = (d.pinned ? '📌 ' : '') + (d.path || '');
  previewHtml.textContent = d.html || '';
});

async function openPreview() {
  const t = tabs.get(activeId);
  if (!t || !t.cwd) { toast('Open a project first'); return; }
  preview.classList.remove('collapsed');

  // The webview's inspector preload path comes from main (sandboxed preload
  // can't build it). Set it once before the first navigation.
  if (!previewView.getAttribute('preload')) {
    const purl = await window.api.getPreviewPreloadUrl();
    if (purl) previewView.setAttribute('preload', purl);
  }

  previewMode = 'starting';
  previewLog = '';
  previewTitle.textContent = `👁 ${t.name}`;
  previewCrumb.textContent = 'Starting…';
  previewHtml.textContent = '';
  previewView.src = 'about:blank';
  setEmptyMessage(`<p class="spin">◐</p><p>Starting <strong>${t.name}</strong>…</p><p class="hint">See the log below.</p>`);
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
    showWebview();
    previewHtml.textContent = '';
    previewCrumb.textContent = d.kind === 'static'
      ? 'Hover over the preview to see its code…'
      : `🟢 ${d.label} · ${d.url}`;
    previewView.src = d.url;
  } else if (d.type === 'error') {
    previewMode = 'idle';
    previewCrumb.textContent = '⚠ ' + d.message;
    setEmptyMessage(`<p>⚠</p><p>${d.message}</p><p class="hint">Details in the log below.</p>`);
    if (previewLog) previewHtml.textContent = previewLog;
    toast(d.message);
  }
});

document.getElementById('preview-btn').addEventListener('click', openPreview);
document.getElementById('preview-collapse').addEventListener('click', () => {
  preview.classList.toggle('collapsed');
  // Content width changed -> reposition embedded terminals after reflow.
  requestAnimationFrame(scheduleSync);
});
document.getElementById('preview-reload').addEventListener('click', () => {
  if (previewMode === 'live') { try { previewView.reload(); } catch (_) { /* not loaded */ } }
  else openPreview();
});

// Populate the rail with all projects, most-recently-used first.
window.api.listProjects().then((projects) => {
  for (const p of projects) buildTab({ name: p.name, cwd: p.path, startCmd: 'claude --permission-mode auto' });
});

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

async function refreshUsage() {
  const u = await window.api.getUsageStats();
  if (!u) return;
  setMeter('m-daily', pct(u.today.tokens, u.peakDay), fmtTokens(u.today.tokens));
  setMeter('m-weekly', pct(u.week.tokens, u.peakWeek), fmtTokens(u.week.tokens));
  setStat('m-total', `${fmtTokens(u.total.tokens)} · ${fmtCost(u.total.cost)}`);
  setStat('m-msgs', String(u.today.msgs));
  document.getElementById('m-total').title =
    `${u.total.tokens.toLocaleString()} tokens over ${u.total.days} days · estimated cost`;
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

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  document.getElementById('m-clock').textContent =
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;

  // Daily resets at next local midnight.
  const nextMidnight = new Date(d);
  nextMidnight.setHours(24, 0, 0, 0);
  // Weekly resets at the start of next Monday (ISO week).
  const nextMonday = new Date(d);
  nextMonday.setHours(24, 0, 0, 0);
  const daysToMon = (8 - (d.getDay() || 7)); // Sun=0 -> 7
  nextMonday.setDate(nextMonday.getDate() + (daysToMon - 1));

  document.querySelector('#m-daily .m-reset').textContent =
    `(reset ${fmtCountdown(nextMidnight - d)})`;
  document.querySelector('#m-weekly .m-reset').textContent =
    `(reset ${fmtCountdown(nextMonday - d)})`;
}

refreshUsage();
refreshSystem();
tickClock();
setInterval(refreshSystem, 2000);
setInterval(tickClock, 1000);
setInterval(refreshUsage, 300000); // re-scan usage every 5 min
