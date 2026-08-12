const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { isolatedTmuxEnvironment } = require('./tmux-test-environment');

test('an inherited tmux client cannot escape the isolated test socket', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-tmux-env-'));
  const inheritedSocket = path.join(scratch, 'inherited.sock');
  const isolatedRoot = path.join(scratch, 'isolated');
  const isolatedSocket = path.join(isolatedRoot, `tmux-${process.getuid()}`, 'default');

  try {
    fs.mkdirSync(isolatedRoot);
    execFileSync('tmux', ['-S', inheritedSocket, 'new-session', '-d', '-s', 'sentinel'], {
      stdio: 'ignore',
    });
    const inheritedPid = execFileSync(
      'tmux', ['-S', inheritedSocket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' },
    ).trim();

    const env = isolatedTmuxEnvironment({
      ...process.env,
      TMUX: `${inheritedSocket},${inheritedPid},0`,
      TMUX_PANE: '%0',
      TMUX_TMPDIR: '/tmp/not-the-test-root',
    }, isolatedRoot);

    assert.equal(env.TMUX, undefined);
    assert.equal(env.TMUX_PANE, undefined);
    assert.equal(env.TMUX_TMPDIR, isolatedRoot);

    execFileSync('tmux', ['new-session', '-d', '-s', 'isolated'], {
      env,
      stdio: 'ignore',
    });
    const reachedSocket = execFileSync('tmux', ['display-message', '-p', '#{socket_path}'], {
      encoding: 'utf8',
      env,
    }).trim();
    assert.equal(reachedSocket, isolatedSocket);
    execFileSync('tmux', ['-S', inheritedSocket, 'has-session', '-t', '=sentinel'], {
      stdio: 'ignore',
    });
  } finally {
    try { execFileSync('tmux', ['-S', isolatedSocket, 'kill-server'], { stdio: 'ignore' }); } catch (_) {}
    try { execFileSync('tmux', ['-S', inheritedSocket, 'kill-server'], { stdio: 'ignore' }); } catch (_) {}
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
