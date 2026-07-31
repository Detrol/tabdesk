// Watch the projects that are set to push, and send them when they settle.
//
// Debounced hard on purpose. A save is one event; a branch switch, an npm
// install or a build is thousands, and pushing on each would spend the whole
// session uploading. Waiting for quiet costs a couple of seconds of latency
// and turns a storm into one manifest write.
//
// A push already running is never overlapped for the same project: the second
// change sets a flag and the push repeats when the first finishes. Two
// concurrent pushes would race on manifest.json, and the loser would publish
// an index older than the blobs beside it.

const chokidar = require('chokidar');
const files = require('./files');
const manifest = require('./manifest');

const QUIET_MS = 2000;
const watchers = new Map();   // slug -> { watcher, timer, busy, again, root }

let notify = () => {};

function setNotifier(fn) { notify = typeof fn === 'function' ? fn : () => {}; }

async function runPush(slug) {
  const rec = watchers.get(slug);
  if (!rec) return;
  if (rec.busy) { rec.again = true; return; }
  rec.busy = true;
  notify({ type: 'push-start', slug });
  try {
    const res = await files.push(slug, rec.root, rec.options);
    notify({ type: 'push-done', slug, ...res });
  } catch (err) {
    notify({ type: 'push-error', slug, code: err.code || 'other', detail: String(err.message || err) });
  } finally {
    rec.busy = false;
    if (rec.again) { rec.again = false; schedule(slug); }
  }
}

function schedule(slug) {
  const rec = watchers.get(slug);
  if (!rec) return;
  clearTimeout(rec.timer);
  rec.timer = setTimeout(() => runPush(slug), QUIET_MS);
}

function start(slug, root, options) {
  stop(slug);
  const rec = { watcher: null, timer: null, busy: false, again: false, root, options: options || {} };
  watchers.set(slug, rec);

  rec.watcher = chokidar.watch(root, {
    ignoreInitial: true,
    // Same list the manifest uses, so the watcher never wakes for a file the
    // push would drop anyway — .git alone would otherwise fire on every commit.
    ignored: (p) => {
      const rel = p.slice(root.length).replace(/^[/\\]/, '');
      if (!rel) return false;
      return rel.split(/[/\\]/).some((part) => manifest.DEFAULT_IGNORES.includes(part));
    },
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });

  for (const ev of ['add', 'change', 'unlink', 'addDir', 'unlinkDir']) {
    rec.watcher.on(ev, () => schedule(slug));
  }
  rec.watcher.on('error', (err) => {
    notify({ type: 'watch-error', slug, detail: String(err.message || err) });
  });
  return true;
}

function stop(slug) {
  const rec = watchers.get(slug);
  if (!rec) return false;
  clearTimeout(rec.timer);
  try { rec.watcher && rec.watcher.close(); } catch (_) { /* already closed */ }
  watchers.delete(slug);
  return true;
}

function stopAll() {
  for (const slug of [...watchers.keys()]) stop(slug);
}

const watching = () => [...watchers.keys()];

module.exports = { start, stop, stopAll, watching, setNotifier, pushNow: runPush, QUIET_MS };
