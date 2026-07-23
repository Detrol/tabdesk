// Launch a project the way its author intended (main process).
//
// This is the counterpart to preview-runner.js. The preview runner hunts for a
// port so the app can be framed inside our webview, and it deliberately skips
// desktop apps (Electron/Tauri) because they can't be shown as a web page.
// Here we do the opposite: run the project's own start command as a real
// process and let it put whatever it wants on screen — its own window for a
// desktop app, a dev server for anything else.
//
// One process per project directory; starting an already-running project is a
// no-op, so the button can toggle it.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const running = new Map(); // projectPath -> { proc, name, label }

function exists(p) { try { return fs.existsSync(p); } catch (_) { return false; } }
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; } }

// Work out how to start whatever lives in `dir`. Unlike the preview runner's
// detect(), an Electron/Tauri script is the *preferred* match here.
function detect(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (exists(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(read(pkgPath)); } catch (_) { /* malformed; fall through */ }
    const scripts = pkg.scripts || {};
    const script = ['start', 'dev', 'electron', 'app', 'serve']
      .find((s) => scripts[s]);
    if (script) return { label: `npm run ${script}`, cmd: 'npm', args: ['run', script] };
  }

  // A `run` target in a Makefile is an explicit statement of intent — trust it
  // over the language defaults below.
  const mk = ['Makefile', 'makefile', 'GNUmakefile'].find((f) => exists(path.join(dir, f)));
  if (mk && /^run:/m.test(read(path.join(dir, mk)))) {
    return { label: 'make run', cmd: 'make', args: ['run'] };
  }

  for (const sh of ['run.sh', 'start.sh']) {
    const full = path.join(dir, sh);
    if (exists(full)) return { label: `./${sh}`, cmd: 'bash', args: [full] };
  }

  if (exists(path.join(dir, 'Cargo.toml'))) {
    return { label: 'cargo run', cmd: 'cargo', args: ['run'] };
  }
  if (exists(path.join(dir, 'go.mod'))) {
    return { label: 'go run .', cmd: 'go', args: ['run', '.'] };
  }
  if (exists(path.join(dir, 'manage.py'))) {
    return { label: 'python manage.py runserver', cmd: pythonBin(dir), args: ['manage.py', 'runserver'] };
  }
  const py = ['main.py', 'app.py', 'run.py', 'server.py'].find((f) => exists(path.join(dir, f)));
  if (py) return { label: `python ${py}`, cmd: pythonBin(dir), args: [py] };

  return null;
}

// Prefer a project-local virtualenv interpreter if one exists.
function pythonBin(dir) {
  for (const rel of ['.venv/bin/python', 'venv/bin/python', 'env/bin/python']) {
    if (exists(path.join(dir, rel))) return path.join(dir, rel);
  }
  return 'python3';
}

// Kill the whole process group so `npm`/`cargo` wrappers take their children
// (the actual app window) down with them.
function killProc(proc) {
  if (!proc || proc.killed) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch (_) {
    try { proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
  }
  setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) { /* gone */ } }, 2000);
}

// Start `projectPath`. `send(type, payload)` streams 'started' | 'log' |
// 'exit' | 'error' back to the renderer. Returns the plan, or null if we
// couldn't work out how to run the project.
function start(projectPath, send) {
  const name = path.basename(projectPath);
  if (running.has(projectPath)) {
    const cur = running.get(projectPath);
    send('started', { path: projectPath, name, label: cur.label, already: true });
    return { label: cur.label };
  }

  const plan = detect(projectPath);
  if (!plan) {
    // A plain HTML site has no app to start — say so, rather than leaving the
    // user to guess why nothing happened. The other menu item is what they want.
    const isSite = ['index.html', 'public/index.html', 'dist/index.html',
      'site/index.html', 'build/index.html', 'www/index.html']
      .some((f) => exists(path.join(projectPath, f)));
    send('error', {
      path: projectPath, name,
      code: isSite ? 'site-only' : 'nothing-to-run',
      message: `Found nothing to run in ${name}`,
    });
    return null;
  }

  let proc;
  try {
    proc = spawn(plan.cmd, plan.args, {
      cwd: projectPath,
      env: { ...process.env, FORCE_COLOR: '0', PYTHONUNBUFFERED: '1' },
      detached: true, // own process group -> clean kill of children
    });
  } catch (err) {
    send('error', { path: projectPath, name, code: 'spawn-failed', message: `Could not start ${plan.cmd}: ${String(err)}` });
    return null;
  }

  const rec = { proc, name, label: plan.label };
  running.set(projectPath, rec);
  send('started', { path: projectPath, name, label: plan.label });

  // The app owns its own window; its output is only interesting when it dies
  // early, so we keep a short tail rather than streaming everything.
  let tail = '';
  const onOutput = (buf) => {
    tail = (tail + buf.toString()).slice(-4000);
    send('log', { path: projectPath, name, line: buf.toString() });
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);

  proc.on('error', (err) => {
    running.delete(projectPath);
    send('error', { path: projectPath, name, code: 'process-error', message: `Process error: ${String(err)}` });
  });
  proc.on('exit', (code) => {
    running.delete(projectPath);
    send('exit', { path: projectPath, name, label: plan.label, code, tail });
  });

  return plan;
}

function stop(projectPath) {
  const rec = running.get(projectPath);
  if (!rec) return false;
  running.delete(projectPath);
  killProc(rec.proc);
  return true;
}

function stopAll() {
  for (const p of [...running.keys()]) stop(p);
}

function isRunning(projectPath) { return running.has(projectPath); }

module.exports = { start, stop, stopAll, isRunning, detect };
