// A push notification channel over plain SSH.
//
// SFTP cannot tell a client that something changed; it can only be asked. So
// the client asks once, on the server, in a loop that stays open: one exec
// channel running a shell loop that prints a line whenever a manifest's mtime
// moves. Latency is the sleep interval rather than the poll interval, and the
// server still has nothing installed on it — bash and coreutils are the whole
// dependency.
//
// This is an optimisation, never the mechanism. The channel dies with the
// laptop's wifi, an idle timeout, or a server reboot, and the poller behind it
// carries on regardless. Nothing here is allowed to be the only thing watching.

const transport = require('./transport-sftp');
const config = require('./config');

// One line per changed manifest: "<slugalias> <mtime>". The directory name is
// an alias, so the channel never learns a project name either. The first pass reports
// everything it can see, which the caller treats as current state rather than
// as news — it has its own record of what it last pulled.
//
// Written for bash specifically (associative array), and invoked as bash
// rather than trusting the login shell to be one.
const REMOTE_LOOP = (dir, interval) => `bash -c '
cd "${dir}/files" 2>/dev/null || { echo "__nofiles__"; exit 0; }
declare -A seen
while :; do
  for d in */; do
    s="\${d%/}"
    [ -f "$s/manifest" ] || continue
    m=$(stat -c %Y "$s/manifest" 2>/dev/null) || continue
    if [ "\${seen[$s]}" != "$m" ]; then seen[$s]="$m"; echo "$s $m"; fi
  done
  sleep ${interval}
done'`;

const INTERVAL_S = 1;

let conn = null;
let stream = null;
let stopped = true;
let onChange = () => {};
let onState = () => {};
let retry = null;
let backoff = 5000;

function cleanup() {
  try { stream && stream.close(); } catch (_) { /* already gone */ }
  try { conn && conn.end(); } catch (_) { /* already gone */ }
  stream = null;
  conn = null;
}

async function open() {
  if (stopped) return;
  const missing = config.missingFields();
  if (missing.length) { onState({ live: false, reason: 'incomplete' }); return; }

  try {
    const cfg = config.forConnect();
    conn = await transport.connect(cfg);
    stream = await new Promise((resolve, reject) => {
      conn.exec(REMOTE_LOOP(cfg.remotePath.replace(/\/+$/, ''), INTERVAL_S), (err, s) => {
        if (err) reject(err); else resolve(s);
      });
    });

    onState({ live: true });
    backoff = 5000;   // a channel that opened resets the retry delay

    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        // The server has no files/ directory yet: nothing to watch, but the
        // connection is fine. Report it rather than looking like a failure.
        if (t === '__nofiles__') { onState({ live: true, empty: true }); continue; }
        const [slug, mtime] = t.split(/\s+/);
        if (slug && mtime) onChange(slug, Number(mtime));
      }
    });
    // stderr is the remote shell complaining; it is diagnostic, not an event.
    stream.stderr.on('data', () => {});

    const ended = () => {
      cleanup();
      if (stopped) return;
      onState({ live: false, reason: 'closed' });
      // Backing off matters: a server that refuses the exec would otherwise be
      // reconnected to once a second forever, which looks exactly like an
      // attack from its side.
      retry = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 300000);
    };
    stream.on('close', ended);
    stream.on('error', ended);
    conn.on('error', ended);
  } catch (err) {
    cleanup();
    if (stopped) return;
    onState({ live: false, reason: err.code || 'error' });
    retry = setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 300000);
  }
}

function start(handlers) {
  stop();
  stopped = false;
  onChange = (handlers && handlers.onChange) || (() => {});
  onState = (handlers && handlers.onState) || (() => {});
  backoff = 5000;
  open();
}

function stop() {
  stopped = true;
  clearTimeout(retry);
  retry = null;
  cleanup();
}

const isLive = () => Boolean(stream);

module.exports = { start, stop, isLive, INTERVAL_S };
