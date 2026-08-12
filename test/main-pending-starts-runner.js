const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isolatedTmuxEnvironment } = require('./tmux-test-environment');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-main-starts-'));
const electron = require('electron');
const inheritedSocket = path.join(scratch, 'inherited-tmux.sock');
const proofRoot = path.join(scratch, 'proof-tmux');
const proofSocket = path.join(proofRoot, `tmux-${process.getuid()}`, 'default');
let child;

function cleanup() {
  try { execFileSync('tmux', ['-S', proofSocket, 'kill-server'], { stdio: 'ignore' }); } catch (_) {}
  try { execFileSync('tmux', ['-S', inheritedSocket, 'kill-server'], { stdio: 'ignore' }); } catch (_) {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
}

function inheritedServerAlive() {
  try {
    execFileSync('tmux', ['-S', inheritedSocket, 'has-session', '-t', '=sentinel'], {
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

try {
  execFileSync('tmux', ['-S', inheritedSocket, 'new-session', '-d', '-s', 'sentinel'], {
    stdio: 'ignore',
  });
  const inheritedPid = execFileSync(
    'tmux', ['-S', inheritedSocket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' },
  ).trim();
  fs.mkdirSync(proofRoot);
  const inheritedEnv = {
    ...process.env,
    TMUX: `${inheritedSocket},${inheritedPid},0`,
    TMUX_PANE: '%0',
  };
  const childEnv = isolatedTmuxEnvironment(inheritedEnv, path.join(scratch, 'tmux'));
  const proofEnv = { ...childEnv, TMUX_TMPDIR: proofRoot };
  execFileSync('tmux', ['new-session', '-d', '-s', 'proof'], {
    env: proofEnv,
    stdio: 'ignore',
  });
  const reachedSocket = execFileSync('tmux', ['display-message', '-p', '#{socket_path}'], {
    encoding: 'utf8',
    env: proofEnv,
  }).trim();
  if (reachedSocket !== proofSocket) {
    throw new Error(`tmux isolation regression: expected ${proofSocket}, reached ${reachedSocket}`);
  }
  execFileSync('tmux', ['-S', proofSocket, 'kill-server'], { stdio: 'ignore' });

  child = spawn(electron, [path.join(__dirname, 'main-pending-starts.js')], {
    env: { ...childEnv, TABDESK_PENDING_STARTS_SCRATCH: scratch },
    stdio: 'inherit',
  });
} catch (error) {
  cleanup();
  throw error;
}

child.once('error', (error) => {
  console.error(error && error.stack ? error.stack : error);
  cleanup();
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  const isolated = inheritedServerAlive();
  if (!isolated) console.error('tmux isolation regression: child terminated the inherited server');
  cleanup();
  process.exitCode = signal || !isolated ? 1 : (code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    try { child.kill(signal); } catch (_) {}
  });
}
