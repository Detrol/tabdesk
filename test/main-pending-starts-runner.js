const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabdesk-main-starts-'));
const electron = require('electron');
let child;

function cleanup() {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
}

try {
  child = spawn(electron, [path.join(__dirname, 'main-pending-starts.js')], {
    env: { ...process.env, TABDESK_PENDING_STARTS_SCRATCH: scratch },
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
  cleanup();
  process.exitCode = signal ? 1 : (code ?? 1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    try { child.kill(signal); } catch (_) {}
  });
}
