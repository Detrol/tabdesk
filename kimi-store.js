// Read-only access to Kimi Code's on-disk session store.
//
// Layout (official data-locations docs): everything under $KIMI_CODE_HOME
// (default ~/.kimi-code). Sessions are indexed in session_index.jsonl and
// live under sessions/<workDirKey>/<sessionId>/{state.json,agents/...}.
// TabDesk never writes here — only the CLI does.

const fs = require('fs');
const path = require('path');
const os = require('os');

function home(root) {
  if (root) return root;
  const env = process.env.KIMI_CODE_HOME;
  if (env && typeof env === 'string' && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.kimi-code');
}

function indexPath(root) {
  return path.join(home(root), 'session_index.jsonl');
}

// One JSON object per line: { sessionId, sessionDir, workDir }.
function readIndex(root) {
  const file = indexPath(root);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    if (!row || typeof row !== 'object') continue;
    const sessionId = typeof row.sessionId === 'string' ? row.sessionId : '';
    const sessionDir = typeof row.sessionDir === 'string' ? row.sessionDir : '';
    const workDir = typeof row.workDir === 'string' ? row.workDir : '';
    if (!sessionId || !sessionDir) continue;
    out.push({ sessionId, sessionDir, workDir });
  }
  return out;
}

function readState(sessionDir) {
  if (!sessionDir || typeof sessionDir !== 'string') return null;
  const file = path.join(sessionDir, 'state.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

function wirePath(sessionDir) {
  if (!sessionDir) return null;
  return path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

module.exports = { home, indexPath, readIndex, readState, wirePath };
