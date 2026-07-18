// Universal project preview runner (main process).
//
// Given a project directory, detect what kind of app it is (static HTML, Node,
// Python/Flask/FastAPI/Django, Rust, Go, …), launch it, and figure out the URL
// it's serving on. Static sites load straight from file://; everything else is
// a real process whose stdout/stderr we stream to the renderer while we hunt for
// the port it bound. Only one preview runs at a time.

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

let current = null; // { proc, done, poll, timeout }

function exists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } }

// Grab a free TCP port so frameworks that honour $PORT land somewhere we know.
function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(3000 + Math.floor(Math.random() * 4000)));
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Prefer a project-local virtualenv interpreter if one exists.
function pythonBin(dir) {
  for (const rel of ['.venv/bin/python', 'venv/bin/python', 'env/bin/python']) {
    if (exists(path.join(dir, rel))) return path.join(dir, rel);
  }
  return 'python3';
}

// Static entry points, in priority order — same list the old preview:entry used.
const STATIC_CANDIDATES = [
  'index.html', 'public/index.html', 'site/index.html', 'client/index.html',
  'static/index.html', 'dist/index.html', 'build/index.html', 'www/index.html',
  'app/index.html', 'docs/index.html', 'src/index.html', 'renderer/index.html',
];

// Work out how to run whatever lives in `dir`. Runnable apps win over a bare
// index.html, so a Flask app that also ships a template still gets launched.
function detect(dir, port) {
  const P = String(port);
  const env = { PORT: P, BROWSER: 'none', FORCE_COLOR: '0', PYTHONUNBUFFERED: '1' };

  // ---- Node (any package.json with a dev-ish script) ----
  const pkgPath = path.join(dir, 'package.json');
  if (exists(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(read(pkgPath)); } catch (_) { /* malformed; skip */ }
    const scripts = pkg.scripts || {};
    // A script that launches a native desktop app (Electron/Tauri/Neutralino)
    // can't be shown as a web page — running it would just open another window.
    // Skip those and fall through to a static preview instead.
    const isDesktop = (s) => /\b(electron|electron-forge|tauri|nativefier|neutralino)\b/i.test(s || '');
    const script = ['dev', 'start', 'serve', 'preview']
      .find((s) => scripts[s] && !isDesktop(scripts[s]));
    if (script) {
      return { kind: 'node', label: `npm run ${script}`, cmd: 'npm', args: ['run', script], env };
    }
  }

  // ---- Django ----
  if (exists(path.join(dir, 'manage.py'))) {
    return {
      kind: 'django', label: `python manage.py runserver ${P}`,
      cmd: pythonBin(dir), args: ['manage.py', 'runserver', P], env,
    };
  }

  // ---- Python web / script ----
  const pyEntry = ['app.py', 'main.py', 'server.py', 'wsgi.py', 'run.py']
    .find((f) => exists(path.join(dir, f)));
  if (pyEntry) {
    const src = read(path.join(dir, pyEntry));
    const mod = pyEntry.replace(/\.py$/, '');
    if (/fastapi|uvicorn/i.test(src)) {
      return {
        kind: 'fastapi', label: `uvicorn ${mod}:app --port ${P}`,
        cmd: pythonBin(dir), args: ['-m', 'uvicorn', `${mod}:app`, '--port', P], env,
      };
    }
    // Flask / http.server / plain script: run it and read the port from its logs.
    return { kind: 'python', label: `python ${pyEntry}`, cmd: pythonBin(dir), args: [pyEntry], env };
  }

  // ---- Rust ----
  if (exists(path.join(dir, 'Cargo.toml'))) {
    return { kind: 'rust', label: 'cargo run', cmd: 'cargo', args: ['run'], env };
  }

  // ---- Go ----
  if (exists(path.join(dir, 'go.mod'))) {
    return { kind: 'go', label: 'go run .', cmd: 'go', args: ['run', '.'], env };
  }

  // ---- Static HTML (no process) ----
  for (const rel of STATIC_CANDIDATES) {
    const full = path.join(dir, rel);
    if (exists(full)) return { kind: 'static', label: rel, staticFile: full };
  }

  return null;
}

// Try to open a TCP connection to a port; call ok() if something's listening.
function probe(port, ok) {
  const sock = net.connect(port, '127.0.0.1');
  sock.setTimeout(500);
  const bail = () => sock.destroy();
  sock.once('connect', () => { sock.destroy(); ok(); });
  sock.once('error', bail);
  sock.once('timeout', bail);
}

// Kill the whole process group so `npm`/`cargo` wrappers take their children down.
function killProc(proc) {
  if (!proc || proc.killed) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch (_) {
    try { proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
  }
  setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) { /* gone */ } }, 1500);
}

function stop() {
  const s = current;
  current = null;
  if (!s) return;
  clearInterval(s.poll);
  clearTimeout(s.timeout);
  killProc(s.proc);
}

// Launch a preview for `projectPath`. `send(type, payload)` streams events
// ('log' | 'ready' | 'error') back to the renderer.
async function start(projectPath, send) {
  stop();

  const name = path.basename(projectPath);
  const port = await getFreePort();
  const plan = detect(projectPath, port);
  if (!plan) {
    send('error', { name, message: `Found nothing to preview in ${name}` });
    return;
  }

  if (plan.kind === 'static') {
    send('ready', { name, kind: 'static', label: plan.label, url: 'file://' + plan.staticFile });
    return;
  }

  send('log', { name, kind: plan.kind, label: plan.label, line: `▶ ${plan.label}   (port ${port})\n\n` });

  let proc;
  try {
    proc = spawn(plan.cmd, plan.args, {
      cwd: projectPath,
      env: { ...process.env, ...plan.env },
      detached: true, // own process group -> clean kill of children
    });
  } catch (err) {
    send('error', { name, message: `Could not start ${plan.cmd}: ${String(err)}` });
    return;
  }

  const state = { proc, done: false, poll: null, timeout: null };
  current = state;

  const candidates = new Set([port]);

  const finish = (url) => {
    if (state.done) return;
    state.done = true;
    clearInterval(state.poll);
    clearTimeout(state.timeout);
    send('ready', { name, kind: plan.kind, label: plan.label, url });
  };

  const onOutput = (buf) => {
    const text = buf.toString();
    send('log', { line: text });
    // A full URL in the output is the strongest signal — use it verbatim.
    const url = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/i);
    if (url) { finish(url[0].replace(/0\.0\.0\.0|127\.0\.0\.1/, 'localhost')); return; }
    // Otherwise collect any port-looking numbers to probe (":3000", "port 8080").
    let m;
    const re = /(?::|\bport\s+)(\d{2,5})\b/gi;
    while ((m = re.exec(text))) {
      const p = Number(m[1]);
      if (p >= 1024 && p <= 65535) candidates.add(p);
    }
  };

  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);
  proc.on('error', (err) => {
    if (!state.done) send('error', { name, message: `Process error: ${String(err)}` });
  });
  proc.on('exit', (code) => {
    if (!state.done) send('error', { name, message: `Process exited (code ${code}) before a URL was found. See the log.` });
    if (current === state) current = null;
  });

  // Poll every candidate port until one answers, then load it.
  state.poll = setInterval(() => {
    for (const p of candidates) probe(p, () => finish(`http://localhost:${p}`));
  }, 400);

  state.timeout = setTimeout(() => {
    if (!state.done) send('error', { name, message: 'Timeout: the app did not bind a port within 45s. See the log.' });
  }, 45000);
}

module.exports = { start, stop };
