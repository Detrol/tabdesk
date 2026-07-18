// Embed real xfce4-terminal windows inside the app's panels (X11 only).
//
// xfce4-terminal 1.1.3 (GTK3) dropped the old --embed/GtkPlug socket, so true
// XEMBED is impossible. Instead we launch each terminal as its own top-level
// window with a unique, frozen title, find its X window via xdotool, reparent
// it under the Electron window, and move/size it to match the panel rectangle.
//
// Caveats (inherent to native reparenting, not bugs):
//   * The terminal is a native X window composited ABOVE the Chromium content,
//     so it covers whatever DOM sits in that rectangle.
//   * Electron's in-app capturePage() screenshot cannot see it.
//   * It must be repositioned whenever the panel moves or resizes.

const { spawn, execFile } = require('child_process');

let parentXid = null;
const embeds = new Map(); // id -> { proc, win, placed, dead }

// Grab the Electron window's X11 window id (little-endian XID on Linux).
function init(win) {
  try {
    parentXid = win.getNativeWindowHandle().readUInt32LE(0);
  } catch (_) {
    parentXid = null;
  }
}

function xdo(args) {
  return new Promise((resolve) => {
    execFile('xdotool', args, { timeout: 4000 }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim()));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll for the window carrying our unique title until it maps (or we give up).
async function findWindow(title, rec, tries = 50) {
  for (let i = 0; i < tries && !rec.dead; i++) {
    const out = await xdo(['search', '--name', title]);
    if (out) {
      const id = out.split('\n')[0].trim();
      if (id) return id;
    }
    await wait(100);
  }
  return null;
}

async function create(id, { cwd, startCmd }) {
  if (embeds.has(id)) return;
  if (!parentXid) { console.warn('[xfce-embed] no parent XID (not X11?); cannot embed'); return; }

  const title = `tabdesk-${id}`;
  const shell = process.env.SHELL || '/bin/bash';
  // Run the project command, then drop into an interactive shell so the pane
  // stays usable after (e.g.) Claude Code exits.
  const inner = startCmd ? `${startCmd}; exec ${shell} -i` : `exec ${shell} -i`;

  const args = [
    '--disable-server', // each window is its own process -> findable by title
    '--hide-menubar', '--hide-toolbar', '--hide-scrollbar', '--hide-borders',
    `--initial-title=${title}`, '--dynamic-title-mode=none', // freeze WM_NAME
  ];
  if (cwd) args.push(`--working-directory=${cwd}`);
  args.push('-x', shell, '-lc', inner);

  const rec = { proc: null, win: null, placed: null, dead: false };
  embeds.set(id, rec);

  rec.proc = spawn('xfce4-terminal', args, { detached: true, stdio: 'ignore' });
  rec.proc.on('exit', () => { rec.dead = true; });

  const win = await findWindow(title, rec);
  if (!win || rec.dead || !embeds.has(id)) return;
  rec.win = win;

  await xdo(['windowreparent', win, String(parentXid)]);
  if (rec.placed) await apply(rec, rec.placed);
  else await xdo(['windowmap', win]);
}

async function apply(rec, rect) {
  const x = Math.round(rect.x), y = Math.round(rect.y);
  const w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
  await xdo(['windowmove', '--sync', rec.win, String(x), String(y)]);
  await xdo(['windowsize', '--sync', rec.win, String(w), String(h)]);
  await xdo(['windowmap', rec.win]);
}

async function place(id, rect) {
  const rec = embeds.get(id);
  if (!rec) return;
  rec.placed = rect;      // remembered so create() can apply once the win exists
  if (rec.win) await apply(rec, rect);
}

async function hide(id) {
  const rec = embeds.get(id);
  if (rec && rec.win) await xdo(['windowunmap', rec.win]);
}

function kill(id) {
  const rec = embeds.get(id);
  if (!rec) return;
  embeds.delete(id);
  if (rec.proc && !rec.proc.killed) {
    try { process.kill(-rec.proc.pid, 'SIGTERM'); }
    catch (_) { try { rec.proc.kill(); } catch (_) { /* gone */ } }
  }
}

function killAll() {
  for (const id of [...embeds.keys()]) kill(id);
}

module.exports = { init, create, place, hide, kill, killAll };
