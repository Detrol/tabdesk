// Read-only access to opencode's SQLite session store.
//
// Sessions, transcripts and token totals all live in one database
// (~/.local/share/opencode/opencode.db). TabDesk never writes it — only the
// CLI does — and every query is bounded so a multi-hundred-MB store stays a
// SELECT, not a full-file load.
//
// Access prefers the system `sqlite3` CLI (fast, -readonly). When it is not
// installed, `opencode db --format json` is the fallback — available whenever
// the agent itself is, which is the only case TabDesk asks.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

function dbPath() {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg
    ? path.join(xdg, 'opencode')
    : path.join(os.homedir(), '.local', 'share', 'opencode');
  return path.join(base, 'opencode.db');
}

// Values end up inside a SQL string literal. Only used for paths and ids that
// already passed SAFE_ID / came from spellingsOf — never for free text from a
// UI field.
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function run(bin, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout: timeout || 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(stdout == null ? '' : String(stdout));
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function parseJsonRows(stdout) {
  if (stdout == null) return null;
  const text = String(stdout).trim();
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : null;
  } catch (_) {
    return null;
  }
}

// Returns an array of row objects, or null when the database cannot be read
// at all (missing file, no reader, parse failure). An empty result set is [].
async function query(sql, dbFile) {
  const file = dbFile || dbPath();
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
  } catch (_) {
    return null;
  }

  const viaSqlite = parseJsonRows(
    await run('sqlite3', ['-readonly', '-json', file, sql]),
  );
  if (viaSqlite) return viaSqlite;

  // opencode db always opens the live store — only useful when we are reading
  // the default path, not a test fixture.
  if (dbFile && path.resolve(dbFile) !== path.resolve(dbPath())) return null;
  return parseJsonRows(await run('opencode', ['db', '--format', 'json', sql], 15000));
}

module.exports = { dbPath, query, sqlString };
