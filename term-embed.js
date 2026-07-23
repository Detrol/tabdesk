// Embed real native terminal windows inside the app's panels (X11 only).
//
// We launch xterm with its `-into <xid>` flag: xterm reparents itself into the
// given X window at startup and — crucially — relayouts and repaints correctly
// when we move/resize it with xdotool. GTK3 terminals (xfce4-terminal, gnome-
// terminal) do NOT: after an external windowsize they keep painting only their
// original allocation, leaving the rest of the panel transparent/garbled. That
// (plus xfce4-terminal 1.1.3 dropping GtkSocket/XEMBED) is why we use xterm.
//
// Each panel gets its own xterm process with a real PTY. We freeze the window
// title so we can find the X window, then position it to match the panel's
// on-screen rectangle pushed from the renderer.
//
// Caveats (inherent to native embedding, not bugs):
//   * The terminal is a native X window stacked ABOVE the Chromium content,
//     so it covers whatever DOM sits in that rectangle.
//   * Electron's in-app capturePage() screenshot cannot see it.
//   * It must be repositioned whenever the panel moves or resizes.

const { spawn, execFile } = require('child_process');

let parentXid = null;
// id -> { proc, win, applied, pending, busy, mapped, dead }
const embeds = new Map();

// Colours for newly spawned terminals, pushed from the active theme. xterm
// reads them only at launch, so a theme switch reaches existing panes on their
// next open, not live.
let colors = { background: '#03060f', foreground: '#eaf4ff', cursor: '#34e2ff' };
function setTheme(term) {
  if (term) colors = { ...colors, ...term };
}

// xterm's -bg/-fg/-cr only take opaque colours; tokens may carry alpha.
function solid(c, fallback) {
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(c || '').trim());
  return m ? m[0] : fallback;
}

// Told when a terminal is first on screen, so the renderer can drop the "▶
// terminal…" placeholder it draws underneath.
let notifyReady = null;
function setReadyNotifier(fn) { notifyReady = fn; }

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
  if (!parentXid) { console.warn('[term-embed] no parent XID (not X11?); cannot embed'); return; }

  const title = `tabdesk-${id}`;
  const shell = process.env.SHELL || '/bin/bash';
  // Run the project command, then drop into an interactive shell so the pane
  // stays usable after (e.g.) Claude Code exits.
  const inner = startCmd ? `${startCmd}; exec ${shell} -i` : `exec ${shell} -i`;

  const args = [
    '-into', String(parentXid),   // reparent into the Electron window at launch
    '-T', title,                  // set the initial title so we can find it…
    '-xrm', 'XTerm*allowTitleOps: false', // …and freeze it (apps can't rename)
    '-b', '0', '-bw', '0',        // no inner padding, no window border
    '+sb',                        // no scrollbar
    '-bg', solid(colors.background, '#03060f'),
    '-fg', solid(colors.foreground, '#eaf4ff'),
    '-cr', solid(colors.cursor, '#34e2ff'),
    '-fa', 'DejaVu Sans Mono', '-fs', '11',
    '-e', shell, '-lc', inner,
  ];

  const rec = { proc: null, win: null, applied: null, pending: null, busy: false, mapped: false, dead: false };
  embeds.set(id, rec);

  rec.proc = spawn('xterm', args, {
    detached: true,               // own process group -> killable as a unit
    stdio: 'ignore',
    cwd: cwd || undefined,        // the shell inherits the terminal's cwd
  });
  rec.proc.on('exit', () => { rec.dead = true; });

  const win = await findWindow(title, rec);
  if (!win || rec.dead || !embeds.has(id)) return;
  rec.win = win;

  // `-into` already made it a child of parentXid; just size/place it.
  if (rec.pending) await drain(rec);
  else { await xdo(['windowmap', win]); rec.mapped = true; }
  if (notifyReady) notifyReady(id);
}

// Move + resize in ONE xdotool invocation: two processes per frame would race
// each other, and a resize drag pushes a new rect every frame. Without --sync
// (we serialise ourselves in drain(), so we don't need X round-trips) the call
// stays cheap enough to keep up with the drag.
async function apply(rec, rect) {
  const args = ['windowmove', rec.win, String(rect.x), String(rect.y),
                'windowsize', rec.win, String(rect.w), String(rect.h)];
  if (!rec.mapped) args.push('windowmap', rec.win);
  await xdo(args);
  rec.mapped = true;
  rec.applied = rect;
}

// Serialise placement per embed and keep only the newest rect: overlapping
// xdotool processes finish out of order, so a stale rect could win the race and
// strand the terminal off-panel (which looks like it vanished — you see the DOM
// placeholder underneath instead).
async function drain(rec) {
  if (rec.busy) return;
  rec.busy = true;
  try {
    while (rec.pending && rec.win && !rec.dead) {
      const rect = rec.pending;
      rec.pending = null;
      const a = rec.applied;
      if (a && a.x === rect.x && a.y === rect.y && a.w === rect.w && a.h === rect.h && rec.mapped) continue;
      await apply(rec, rect);
    }
  } finally {
    rec.busy = false;
  }
}

function place(id, rect) {
  const rec = embeds.get(id);
  if (!rec) return;
  const norm = {
    x: Math.round(rect.x), y: Math.round(rect.y),
    w: Math.max(1, Math.round(rect.w)), h: Math.max(1, Math.round(rect.h)),
  };
  // latest-wins: drain() collapses a burst of resize frames into one move.
  rec.pending = norm;
  if (rec.win) drain(rec);
}

async function hide(id) {
  const rec = embeds.get(id);
  // The renderer re-hides every hidden panel on each sync; without the `mapped`
  // guard a resize drag would spawn an xdotool unmap per frame per hidden tab.
  if (rec && rec.win && rec.mapped) {
    rec.pending = null;
    rec.mapped = false;
    rec.applied = null;   // force a full move+size on the next show
    await xdo(['windowunmap', rec.win]);
  }
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

module.exports = { init, create, place, hide, kill, killAll, setTheme, setReadyNotifier };
