const { app, BrowserWindow, ipcMain, nativeTheme, shell, dialog,
        desktopCapturer, screen } = require('electron');
const { Worker } = require('worker_threads');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const previewRunner = require('./preview-runner');
const appRunner = require('./app-runner');
const termEmbed = require('./term-embed');
const theme = require('./theme');
const i18n = require('./i18n');
const settings = require('./settings');
const model = require('./model');
const agents = require('./agents');
const portable = require('./portable');
const updater = require('./updater');
const usageLimits = require('./usage-limits');
const tray = require('./tray');

// Demo/testing hooks, unset in normal use. TABDESK_PROJECTS_DIR points the rail
// at a scratch set of projects (screenshots, trying layout changes against a
// known set) without touching the real one; TABDESK_START_CMD gives those tabs
// a command other than a live Claude session.
const PROJECTS_DIR = process.env.TABDESK_PROJECTS_DIR || path.join(os.homedir(), 'claude-projects');
const DEMO_START_CMD = process.env.TABDESK_START_CMD || null;

// Aggregate Claude Code usage off the main thread.
function scanUsage() {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(path.join(__dirname, 'usage-worker.js'), {
        workerData: { dir: path.join(os.homedir(), '.claude', 'projects') },
      });
    } catch (_) { return resolve(null); }
    worker.once('message', (msg) => { resolve(msg); worker.terminate(); });
    worker.once('error', () => resolve(null));
  });
}

// Live CPU% via idle/total deltas between calls.
let prevCpu = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idleD = 0, totalD = 0;
  for (let i = 0; i < now.length; i++) {
    const a = prevCpu[i].times, b = now[i].times;
    idleD += b.idle - a.idle;
    totalD += (b.user + b.nice + b.sys + b.idle + b.irq) -
              (a.user + a.nice + a.sys + a.idle + a.irq);
  }
  prevCpu = now;
  return totalD > 0 ? Math.round(100 * (1 - idleD / totalD)) : 0;
}

// Track one pty per terminal id.
const terminals = new Map();

// Currently resolved theme + language, shared with the renderer over IPC.
let activeTheme = null;
let activeI18n = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    // Launch windowed, NOT fullscreen (per requirement).
    fullscreen: false,
    backgroundColor: (activeTheme && activeTheme.tokens.bg) || '#1e1e2e',
    title: 'TabDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // for the interactive project preview
    },
  });

  // Hide the default menu bar for a cleaner look; F11 still toggles fullscreen below.
  win.setMenuBarVisibility(false);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // F11 toggles fullscreen.
  //
  // Ctrl/Cmd+R and F5 are swallowed. The default menu is hidden, not gone, so
  // its Reload accelerator is still live — and a reload is not a refresh in this
  // app: the page comes back empty, every tab is gone, and the terminals behind
  // them are orphaned (see did-start-navigation below). preventDefault() here also
  // cancels the menu shortcut, which is what makes it catchable at all.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
      return;
    }
    const key = String(input.key).toLowerCase();
    if (key === 'f5' || ((input.control || input.meta) && key === 'r')) event.preventDefault();
  });

  // A reload can still arrive by a route the keys don't cover (devtools, a
  // renderer crash), and it leaves main holding every embed the old page made:
  // those xterms stay mapped over the new page, which knows nothing about them
  // and will never place or hide them again. Worse, tab ids restart at t1, so
  // the new page's first tabs collide with the survivors — create() sees the id
  // already registered, spawns nothing, and the tab drives the previous page's
  // terminal, showing another project's session. Nothing can hand those windows
  // back to a page that has forgotten them, so they go with it.
  //
  // The signal has to be a MAIN-FRAME navigation. `did-start-loading` is the tab
  // spinner, and Chromium counts the preview <webview>'s load as this window's
  // loading too — hooking it killed every terminal the moment Preview was
  // pressed, sessions and all, while the page went on believing its tabs were
  // live, so selecting one showed a blank panel with nothing left to recreate.
  // The guest's navigation arrives here with isMainFrame false; only the page
  // itself being replaced is true.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) termEmbed.killAll();
  });

  return win;
}

// ---- "New tab" project picker ---------------------------------------------
//
// A real top-level window, not an in-page overlay: the embedded terminals are
// native X windows stacked above the page, so any DOM modal would be covered by
// whichever terminal happens to be open behind it.
//
// The window resolves exactly once — with the choice, or with null if it is
// closed — and the pending resolver is keyed by its webContents so two pickers
// can never hand each other's answer back.
const pickerPending = new Map();

function openProjectPicker(parent) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent,
      modal: true,
      width: 620,
      height: 620,
      minWidth: 460,
      minHeight: 420,
      show: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      backgroundColor: (activeTheme && activeTheme.tokens.bg) || '#1e1e2e',
      title: 'TabDesk',
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'new-project.html'));
    win.once('ready-to-show', () => win.show());

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      pickerPending.delete(win.webContents.id);
      resolve(value);
    };
    pickerPending.set(win.webContents.id, (value) => {
      finish(value);
      if (!win.isDestroyed()) win.close();
    });
    // Closing the window with no choice made counts as a cancel.
    win.on('closed', () => finish(null));
  });
}

// A project name becomes a directory under PROJECTS_DIR, so it may not carry a
// path of its own — the created directory has to stay inside PROJECTS_DIR.
function createProject(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return { ok: false, error: 'empty' };
  if (name === '.' || name === '..' || /[/\\\0]/.test(name)) return { ok: false, error: 'invalid' };

  const full = path.join(PROJECTS_DIR, name);
  if (path.dirname(path.resolve(full)) !== path.resolve(PROJECTS_DIR)) {
    return { ok: false, error: 'invalid' };
  }
  if (fs.existsSync(full)) return { ok: false, error: 'exists' };
  try {
    fs.mkdirSync(full, { recursive: true });
    return { ok: true, name, path: full };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ---- Projects the user closed ---------------------------------------------
//
// The rail is built from the project directories on disk, so closing a tab with
// the × only emptied it until the next start — the directory was still there and
// the tab came back. The choice is remembered here instead, as a list of paths
// the rail skips. It is not a hide-forever: the picker still lists them, and
// opening one is what clears the mark, so nothing needs a separate "unhide".
function closedProjects() {
  const list = settings.get('closedProjects');
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

function setProjectClosed(dir, closed) {
  if (typeof dir !== 'string' || !dir) return;
  const set = new Set(closedProjects());
  // Only what the rail rebuilds is worth remembering: a folder opened from
  // elsewhere ("Other folder…") is never listed at start, so closing its tab
  // has nothing to suppress and would just leave a dead entry behind.
  if (closed) {
    if (path.dirname(path.resolve(dir)) !== path.resolve(PROJECTS_DIR)) return;
    set.add(dir);
  } else {
    set.delete(dir);
  }
  settings.set('closedProjects', [...set]);
}

// ---- Export / import of the portable "light layer" ------------------------
//
// Its own top-level window, for the same reason the picker is one: the
// embedded terminals are native X windows stacked above the page, so an
// in-page modal would sit behind whichever one is open.
//
// The bundle being imported never crosses to the renderer — main holds it
// while the window shows the diff, and drops it when the window closes. The
// renderer only ever sees an inventory and a plan.
let portableWin = null;
const pendingBundles = new Map();

function openPortableWindow(parent) {
  if (portableWin && !portableWin.isDestroyed()) { portableWin.focus(); return portableWin; }

  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 760,
    height: 700,
    minWidth: 560,
    minHeight: 460,
    show: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: (activeTheme && activeTheme.tokens.bg) || '#1e1e2e',
    title: 'TabDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'portable-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'portable.html'));
  win.once('ready-to-show', () => win.show());
  // Read the id now: webContents is gone by the time 'closed' fires.
  const contentsId = win.webContents.id;
  win.on('closed', () => {
    pendingBundles.delete(contentsId);
    if (portableWin === win) portableWin = null;
  });

  portableWin = win;
  return win;
}

// ---- Settings --------------------------------------------------------------
//
// Theme and language have had handlers in main and methods on the preload since
// the beginning, but nothing in the renderer ever called them — they could only
// follow the desktop. This window is where they finally get a surface, and
// where the sync configuration lands in the next phase.
//
// Not modal, unlike the picker: it should be possible to leave settings open and
// watch a theme land on the tabs behind it.
let settingsWin = null;

function openSettingsWindow(parent) {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return settingsWin; }

  const win = new BrowserWindow({
    parent,
    modal: false,
    width: 620,
    height: 560,
    minWidth: 520,
    minHeight: 420,
    show: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: (activeTheme && activeTheme.tokens.bg) || '#1e1e2e',
    title: 'TabDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (settingsWin === win) settingsWin = null; });

  settingsWin = win;
  return win;
}

// ---- Updates ---------------------------------------------------------------
//
// A background check asks the CDN's apt index what's published and tells the
// renderer, which raises a chip in the system bar. Everything privileged lives
// in updater.js; this is the window and the plumbing around it.
let updateWin = null;
let updateState = null;     // last check result, or null before the first one
let updateBusy = false;     // an install is in flight

function openUpdateWindow(parent) {
  if (updateWin && !updateWin.isDestroyed()) { updateWin.focus(); return updateWin; }

  const win = new BrowserWindow({
    parent,
    modal: false,   // unlike the picker: an update can download while you work
    width: 560,
    // Snug for the resting state; the progress bar, status line and dpkg output
    // all appear inside this, pushing the pinned footer down as they arrive.
    height: 360,
    minWidth: 460,
    minHeight: 320,
    show: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: (activeTheme && activeTheme.tokens.bg) || '#1e1e2e',
    title: 'TabDesk',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'update-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'update.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (updateWin === win) updateWin = null; });

  updateWin = win;
  return win;
}

// Ask apt what's published, remember it, and let the main window know.
async function checkForUpdate(win, options) {
  try {
    updateState = await updater.check(options);
  } catch (err) {
    console.warn('[update] check failed:', String(err.message || err));
    return { ok: false, error: String(err.message || err) };
  }
  if (win && !win.isDestroyed()) win.webContents.send('update:available', updateState);
  return { ok: true, state: updateState };
}

// ---- Theme + language plumbing --------------------------------------------

// Re-resolve the active theme and push it to the renderer. Called on startup,
// when the user picks a theme, and whenever the desktop's theme changes.
// Every window, not just the one that asked. The picker, the sync window and the
// update window all subscribe to these in their preloads, but only the main
// window was ever sent them, so they sat in whatever colours they opened in. It
// shows worst in settings: you pick a theme *in that window* and everything
// except the window you are looking at repaints.
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.send(channel, payload);
  }
}

async function applyTheme(win) {
  activeTheme = await theme.resolve(settings.get('theme'));
  termEmbed.setTheme(activeTheme.terminal);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.setBackgroundColor(activeTheme.tokens.bg);
  }
  broadcast('theme:changed', activeTheme);
  return activeTheme;
}

function applyLanguage(win) {
  activeI18n = i18n.resolve(settings.get('language'));
  broadcast('i18n:changed', activeI18n);
  return activeI18n;
}

// Watch the desktop for theme changes. nativeTheme covers the light/dark
// preference; gsettings monitor catches a full GTK theme swap (new colours
// without a light/dark flip), which nativeTheme never reports.
function watchDesktopTheme(win) {
  const refresh = () => {
    theme.invalidate();
    if (settings.get('theme') === 'system') applyTheme(win);
  };
  nativeTheme.on('updated', refresh);

  const schemas = ['org.cinnamon.desktop.interface', 'org.gnome.desktop.interface'];
  const monitors = schemas.map((schema) => {
    try {
      const p = spawn('gsettings', ['monitor', schema], { stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.on('data', (buf) => {
        if (/gtk-theme|color-scheme|accent-color/.test(String(buf))) refresh();
      });
      p.on('error', () => { /* gsettings missing; nativeTheme still works */ });
      return p;
    } catch (_) {
      return null;
    }
  });
  app.on('will-quit', () => monitors.forEach((p) => p && p.kill()));
}

// ---- Screenshots -----------------------------------------------------------
//
// Capture path for embedded native terminals.
//
// capturePage() renders the window's OWN Chromium surface, and an embedded
// terminal is a separate X11 window stacked above that surface (see
// term-embed.js) — it is simply not in that picture, so a capturePage() shot of
// a native pane comes back as the empty panel underneath. desktopCapturer sees
// what the compositor sees, terminals included.
//
// The source has to be the SCREEN, not our own window. desktopCapturer will
// hand out a window source too, and from another process that one does contain
// the terminals — but asked for the window it lives in, Chromium answers with
// its own compositor surface, which has the same blind spot capturePage() has.
// The screen is a genuine X11 grab, so the terminals are in it.
//
// The cost of going through the screen is that it captures what is actually on
// display: anything covering the panel is captured instead of the panel. The
// app is normally on top when this runs (the user just clicked a button in it),
// and moveTop() makes that hold in the cases where it isn't.
//
// `rect` is in CSS pixels relative to the window's content area — the units
// getBoundingClientRect() hands the renderer.
async function captureEmbedRegion(win, rect) {
  win.moveTop();
  await new Promise((resolve) => setTimeout(resolve, 150));   // let it repaint

  const content = win.getContentBounds();          // screen coords, DIP
  const display = screen.getDisplayMatching(content);
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const shot = (sources.find((s) => String(s.display_id) === String(display.id))
                || sources[0] || {}).thumbnail;
  if (!shot || shot.isEmpty()) return null;
  return cropRegion(shot, {
    ...rect,
    x: content.x + rect.x - display.bounds.x,
    y: content.y + rect.y - display.bounds.y,
  }, display.size.width, display.size.height);
}

// Cut `rect` — DIP, relative to a `w`x`h` DIP area — out of a capture of that
// area. Ask for a size, get a size: the capture backend may hand back something
// other than the thumbnailSize we requested, so the DIP -> captured pixel
// factor comes from the image we actually got, not from the display's scale.
function cropRegion(image, rect, w, h) {
  const size = image.getSize();
  const kx = size.width / w;
  const ky = size.height / h;
  const clamp = (v, max) => Math.max(0, Math.min(Math.round(v), max));
  const x = clamp(rect.x * kx, size.width - 1);
  const y = clamp(rect.y * ky, size.height - 1);
  return image.crop({
    x,
    y,
    width: Math.max(1, clamp(rect.width * kx, size.width - x)),
    height: Math.max(1, clamp(rect.height * ky, size.height - y)),
  });
}

app.whenReady().then(async () => {
  // Resolve before the first window so it opens in the right colours.
  activeTheme = await theme.resolve(settings.get('theme'));
  activeI18n = i18n.resolve(settings.get('language'));
  termEmbed.setTheme(activeTheme.terminal);

  const win = createWindow();
  watchDesktopTheme(win);
  tray.init(win, activeI18n.strings);

  // Sync boot payload: the renderer needs theme + strings before first paint,
  // otherwise the UI flashes untranslated in the wrong colours.
  ipcMain.on('app:boot', (event) => {
    event.returnValue = {
      theme: activeTheme,
      i18n: activeI18n,
      settings: settings.all(),
      model: { list: model.list(), global: model.globalDefault(), byProject: model.allFor() },
      agents: { list: agents.list(), byProject: agents.allFor(), fallback: agents.DEFAULT_ID },
      demoStartCmd: DEMO_START_CMD,
    };
  });

  // ---- Claude model, per project ----
  ipcMain.handle('model:list', () => model.list());
  ipcMain.handle('model:global', () => model.globalDefault());
  ipcMain.handle('model:get', (event, projectPath) => model.getFor(projectPath));
  ipcMain.handle('model:set', (event, { path: projectPath, id }) => model.setFor(projectPath, id));

  // ---- Which CLI a project starts (Claude Code, another agent, plain shell) ----
  // The list is re-read rather than cached in the renderer: an agent installed
  // while TabDesk runs should turn up the next time the menu opens.
  ipcMain.handle('agents:list', () => agents.list());
  ipcMain.handle('agents:get', (event, projectPath) => agents.getFor(projectPath));
  ipcMain.handle('agents:set', (event, { path: projectPath, id }) => agents.setFor(projectPath, id));

  // What "Default" resolves to can change under us (an editor, `claude config`).
  const unwatchModel = model.watchGlobal((id) => {
    if (!win.isDestroyed()) win.webContents.send('model:global-changed', id);
  });
  app.on('will-quit', unwatchModel);

  ipcMain.handle('theme:list', () => theme.list());
  ipcMain.handle('theme:set', async (event, id) => {
    settings.set('theme', id);
    return applyTheme(win);
  });

  ipcMain.handle('i18n:list', () => i18n.list());
  ipcMain.handle('language:set', (event, code) => {
    settings.set('language', code);
    const next = applyLanguage(win);
    tray.setStrings(next.strings);
    return next;
  });

  // ---- Tray ----
  // The renderer owns the tab list; this is the mirror it pushes on every
  // add / close / rename / switch. The tray menu is rebuilt from it.
  ipcMain.on('tray:tabs', (event, payload) => tray.setTabs(payload));

  // Embedded native terminal windows (xterm) reparent into this window (X11).
  win.once('ready-to-show', () => termEmbed.init(win));
  termEmbed.init(win);
  termEmbed.setReadyNotifier((id) => {
    if (!win.isDestroyed()) win.webContents.send('embed:ready', { id });
  });
  // Drives the rail's busy/done dots for embedded terminals, the way pty data
  // does for the xterm.js backend.
  termEmbed.setActivityNotifier((id) => {
    if (!win.isDestroyed()) win.webContents.send('embed:activity', { id });
  });

  // ---- Embedded native terminal lifecycle ----
  ipcMain.on('embed:create', (event, { id, cwd, startCmd }) => termEmbed.create(id, { cwd, startCmd }));
  ipcMain.on('embed:place', (event, { id, rect }) => termEmbed.place(id, rect));
  ipcMain.on('embed:hide', (event, { id }) => termEmbed.hide(id));
  ipcMain.on('embed:focus', (event, { id }) => termEmbed.focus(id));
  ipcMain.on('embed:kill', (event, { id }) => termEmbed.kill(id));

  // ---- Terminal lifecycle over IPC ----

  // List project directories under PROJECTS_DIR, most-recently-modified first.
  // `closed` carries the user's × on that tab: the rail leaves those out, the
  // picker still offers them (see closedProjects below).
  ipcMain.handle('projects:list', () => {
    try {
      const closed = new Set(closedProjects());
      return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const full = path.join(PROJECTS_DIR, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch (_) { /* skip */ }
          return { name: e.name, path: full, mtime, model: model.getFor(full), closed: closed.has(full) };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch (_) {
      return [];
    }
  });

  // Closing a tab is a decision about the rail, so it has to outlive the
  // session; opening the project again takes it back.
  ipcMain.on('projects:closed', (event, { path: dir, closed }) => setProjectClosed(dir, closed));

  // ---- New tab: pick an existing project, or create one ----
  ipcMain.handle('projects:pick', () => openProjectPicker(win));

  ipcMain.on('picker:done', (event, choice) => {
    const done = pickerPending.get(event.sender.id);
    if (done) done(choice || null);
  });

  ipcMain.handle('projects:create', (event, name) => createProject(name));

  // Escape hatch for a project that doesn't live under ~/claude-projects.
  ipcMain.handle('projects:browse', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(owner, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: fs.existsSync(PROJECTS_DIR) ? PROJECTS_DIR : os.homedir(),
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = res.filePaths[0];
    return { name: path.basename(dir), path: dir, model: model.getFor(dir) };
  });

  // ---- Portable state: export / import ----
  ipcMain.handle('portable:open', () => { openPortableWindow(win); return true; });
  ipcMain.on('portable:close', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner && !owner.isDestroyed()) owner.close();
  });

  ipcMain.handle('portable:scan', () => {
    try { return { ok: true, scan: portable.scan() }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('portable:export', async (event, slugs) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showSaveDialog(owner, {
      defaultPath: path.join(app.getPath('documents') || os.homedir(), portable.suggestedName()),
      filters: [{ name: 'TabDesk bundle', extensions: ['tabdesk'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const bundle = portable.buildBundle({ slugs: Array.isArray(slugs) ? slugs : null });
      const written = portable.writeBundle(res.filePath, bundle);
      return {
        ok: true,
        path: written.path,
        bytes: written.bytes,
        projects: bundle.projects.length,
        memoryFiles: bundle.projects.reduce((n, p) => n + p.memory.length, 0),
      };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  // Parse a bundle and hand back its diff. The bundle itself stays here.
  ipcMain.handle('portable:open-bundle', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(owner, {
      properties: ['openFile'],
      filters: [
        { name: 'TabDesk bundle', extensions: ['tabdesk'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    try {
      const bundle = portable.readBundle(res.filePaths[0]);
      pendingBundles.set(event.sender.id, bundle);
      return { ok: true, file: res.filePaths[0], plan: portable.plan(bundle) };
    } catch (err) {
      pendingBundles.delete(event.sender.id);
      return { ok: false, error: String(err.message || err) };
    }
  });

  // Re-diff the bundle that's already open — the plan goes stale the moment an
  // import writes anything.
  ipcMain.handle('portable:replan', (event) => {
    const bundle = pendingBundles.get(event.sender.id);
    if (!bundle) return { ok: false, error: 'no bundle open' };
    try { return { ok: true, plan: portable.plan(bundle) }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  ipcMain.handle('portable:apply', (event, options) => {
    const bundle = pendingBundles.get(event.sender.id);
    if (!bundle) return { ok: false, error: 'no bundle open' };
    let result;
    try { result = portable.apply(bundle, options || {}); }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
    if (!result.ok) return result;

    // An import can change theme, language and model choices out from under the
    // main window — re-push all three rather than leave it showing stale state.
    if (result.prefsChanged.includes('theme')) applyTheme(win);
    if (result.prefsChanged.includes('language')) applyLanguage(win);
    if (result.modelsWritten && !win.isDestroyed()) {
      win.webContents.send('portable:imported', { models: model.allFor() });
    }
    return result;
  });

  // ---- Settings ----
  ipcMain.handle('settings:open', () => { openSettingsWindow(win); return true; });
  ipcMain.on('settings:close', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner && !owner.isDestroyed()) owner.close();
  });

  // ---- Updates ----
  ipcMain.handle('update:open', () => { openUpdateWindow(win); return true; });
  ipcMain.on('update:close', (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner && !owner.isDestroyed()) owner.close();
  });

  ipcMain.handle('update:state', () => (updateState ? { ok: true, state: updateState } : null));
  // `refresh` is only ever true for an explicit "check again": it runs
  // `apt-get update` under pkexec, and the background timer must not prompt.
  ipcMain.handle('update:check', (event, options) => checkForUpdate(win, options));

  ipcMain.handle('update:run', async (event) => {
    if (!updateState || !updateState.available) return { ok: false, error: 'nothing to install' };
    if (updateBusy) return { ok: false, error: 'an update is already running' };
    updateBusy = true;
    const sender = event.sender;
    const send = (payload) => { if (!sender.isDestroyed()) sender.send('update:progress', payload); };
    try {
      // apt does the fetching, the signature check and the install in one step,
      // so there is no download phase of our own to report progress for.
      send({ step: 'install' });
      const res = await updater.install();
      if (res.ok) {
        // The installed version moved; re-read it so the chip settles.
        await checkForUpdate(win);
        return { ok: true, version: updateState ? updateState.installed : null };
      }
      return { ok: false, ...res };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    } finally {
      updateBusy = false;
    }
  });

  // Fallback when the polkit prompt is unavailable or dismissed: hand the
  // command to a real TabDesk terminal and let the user type their password.
  ipcMain.handle('update:terminal', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('update:open-terminal', { command: updater.installCommand() });
      win.focus();
    }
    return { ok: true };
  });

  ipcMain.handle('update:restart', () => {
    app.relaunch();
    app.quit();
    return true;
  });

  // First check once the window has settled, then on a slow timer.
  const firstCheck = setTimeout(() => checkForUpdate(win), 8000);
  const recheck = setInterval(() => checkForUpdate(win), updater.CHECK_INTERVAL_MS);
  app.on('will-quit', () => { clearTimeout(firstCheck); clearInterval(recheck); });

  ipcMain.handle('usage:stats', () => scanUsage());

  // Plan limits (what /usage shows). Separate from usage:stats: that one is a
  // local scan of the transcripts, this one is the account's real quota.
  ipcMain.handle('usage:limits', () => usageLimits.getLimits());

  ipcMain.handle('system:stats', () => ({
    cpu: cpuPercent(),
    memUsed: os.totalmem() - os.freemem(),
    memTotal: os.totalmem(),
    uptime: os.uptime(),
  }));

  // Capture a region of the window (the focused terminal) to a PNG file.
  // An in-app xterm.js pane is DOM, so the window's own surface has it; a
  // native embedded pane needs the compositor (see captureEmbedRegion).
  ipcMain.handle('screenshot:capture', async (event, { rect, name, embed }) => {
    try {
      const image = embed
        ? await captureEmbedRegion(win, rect)
        : await win.webContents.capturePage({
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      if (!image || image.isEmpty()) return { ok: false, error: 'empty capture' };
      const pics = path.join(os.homedir(), 'Pictures');
      const dir = fs.existsSync(pics) ? pics : os.homedir();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safe = String(name || 'terminal').replace(/[^a-z0-9._-]/gi, '_');
      const file = path.join(dir, `tabdesk-${safe}-${stamp}.png`);
      fs.writeFileSync(file, image.toPNG());
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('preview:preload-url', () =>
    'file://' + path.join(__dirname, 'preview-preload.js'));

  // Launch a live preview for a project (static HTML or a running app) and
  // stream its lifecycle events back to the renderer.
  ipcMain.handle('preview:start', (event, projectPath) => {
    previewRunner.start(projectPath, (type, payload) => {
      if (!win.isDestroyed()) win.webContents.send('preview:event', { type, ...payload });
    });
    return true;
  });

  // Tear down the currently running preview process (if any).
  ipcMain.handle('preview:stop', () => { previewRunner.stop(); return true; });

  // ---- Run the project natively (its own window / dev server) ----
  ipcMain.handle('app:run', (event, projectPath) => {
    const plan = appRunner.start(projectPath, (type, payload) => {
      if (!win.isDestroyed()) win.webContents.send('app:event', { type, ...payload });
    });
    return plan ? { ok: true, label: plan.label } : { ok: false };
  });
  ipcMain.handle('app:stop', (event, projectPath) => appRunner.stop(projectPath));
  ipcMain.handle('app:running', (event, projectPath) => appRunner.isRunning(projectPath));

  // Hand a URL to the desktop's default browser. Only http(s)/file, so a
  // crafted preview URL can't reach a `mailto:`-style handler.
  ipcMain.handle('site:open-external', (event, url) => {
    if (!/^(https?|file):\/\//i.test(String(url || ''))) return false;
    shell.openExternal(url);
    return true;
  });

  ipcMain.on('term:create', (event, { id, cols, rows, cwd, startCmd }) => {
    if (terminals.has(id)) return;
    const shell = os.platform() === 'win32'
      ? 'powershell.exe'
      : (process.env.SHELL || '/bin/bash');

    const startDir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const term = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: startDir,
      env: process.env,
    });

    // Optionally auto-run a command (e.g. launch Claude Code in the project).
    if (startCmd) {
      setTimeout(() => { try { term.write(startCmd + '\r'); } catch (_) {} }, 350);
    }

    term.onData((data) => {
      if (!win.isDestroyed()) win.webContents.send(`term:data:${id}`, data);
    });
    term.onExit(() => {
      terminals.delete(id);
      if (!win.isDestroyed()) win.webContents.send(`term:exit:${id}`);
    });

    terminals.set(id, term);
  });

  ipcMain.on('term:input', (event, { id, data }) => {
    const term = terminals.get(id);
    if (term) term.write(data);
  });

  ipcMain.on('term:resize', (event, { id, cols, rows }) => {
    const term = terminals.get(id);
    if (term && cols > 0 && rows > 0) {
      try { term.resize(cols, rows); } catch (_) { /* ignore transient resize errors */ }
    }
  });

  ipcMain.on('term:kill', (event, { id }) => {
    const term = terminals.get(id);
    if (term) {
      term.kill();
      terminals.delete(id);
    }
  });

  ipcMain.on('window:toggle-fullscreen', () => {
    win.setFullScreen(!win.isFullScreen());
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const term of terminals.values()) term.kill();
  terminals.clear();
  termEmbed.killAll();
  previewRunner.stop();
  appRunner.stopAll();
  if (process.platform !== 'darwin') app.quit();
});
