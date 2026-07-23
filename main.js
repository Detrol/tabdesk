const { app, BrowserWindow, ipcMain, nativeTheme, shell, dialog } = require('electron');
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

const PROJECTS_DIR = path.join(os.homedir(), 'claude-projects');

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
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
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

// ---- Theme + language plumbing --------------------------------------------

// Re-resolve the active theme and push it to the renderer. Called on startup,
// when the user picks a theme, and whenever the desktop's theme changes.
async function applyTheme(win) {
  activeTheme = await theme.resolve(settings.get('theme'));
  termEmbed.setTheme(activeTheme.terminal);
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(activeTheme.tokens.bg);
    win.webContents.send('theme:changed', activeTheme);
  }
  return activeTheme;
}

function applyLanguage(win) {
  activeI18n = i18n.resolve(settings.get('language'));
  if (win && !win.isDestroyed()) win.webContents.send('i18n:changed', activeI18n);
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

app.whenReady().then(async () => {
  // Resolve before the first window so it opens in the right colours.
  activeTheme = await theme.resolve(settings.get('theme'));
  activeI18n = i18n.resolve(settings.get('language'));
  termEmbed.setTheme(activeTheme.terminal);

  const win = createWindow();
  watchDesktopTheme(win);

  // Sync boot payload: the renderer needs theme + strings before first paint,
  // otherwise the UI flashes untranslated in the wrong colours.
  ipcMain.on('app:boot', (event) => {
    event.returnValue = {
      theme: activeTheme,
      i18n: activeI18n,
      settings: settings.all(),
      model: { list: model.list(), global: model.globalDefault(), byProject: model.allFor() },
    };
  });

  // ---- Claude model, per project ----
  ipcMain.handle('model:list', () => model.list());
  ipcMain.handle('model:global', () => model.globalDefault());
  ipcMain.handle('model:get', (event, projectPath) => model.getFor(projectPath));
  ipcMain.handle('model:set', (event, { path: projectPath, id }) => model.setFor(projectPath, id));

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
    return applyLanguage(win);
  });

  // Embedded native terminal windows (xterm) reparent into this window (X11).
  win.once('ready-to-show', () => termEmbed.init(win));
  termEmbed.init(win);
  termEmbed.setReadyNotifier((id) => {
    if (!win.isDestroyed()) win.webContents.send('embed:ready', { id });
  });

  // ---- Embedded native terminal lifecycle ----
  ipcMain.on('embed:create', (event, { id, cwd, startCmd }) => termEmbed.create(id, { cwd, startCmd }));
  ipcMain.on('embed:place', (event, { id, rect }) => termEmbed.place(id, rect));
  ipcMain.on('embed:hide', (event, { id }) => termEmbed.hide(id));
  ipcMain.on('embed:kill', (event, { id }) => termEmbed.kill(id));

  // ---- Terminal lifecycle over IPC ----

  // List project directories under PROJECTS_DIR, most-recently-modified first.
  ipcMain.handle('projects:list', () => {
    try {
      return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const full = path.join(PROJECTS_DIR, e.name);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch (_) { /* skip */ }
          return { name: e.name, path: full, mtime, model: model.getFor(full) };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch (_) {
      return [];
    }
  });

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

  ipcMain.handle('usage:stats', () => scanUsage());

  ipcMain.handle('system:stats', () => ({
    cpu: cpuPercent(),
    memUsed: os.totalmem() - os.freemem(),
    memTotal: os.totalmem(),
    uptime: os.uptime(),
  }));

  // Capture a region of the window (the focused terminal) to a PNG file.
  ipcMain.handle('screenshot:capture', async (event, { rect, name }) => {
    try {
      const image = await win.webContents.capturePage({
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
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
