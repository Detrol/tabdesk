// The receiving side, running by itself.
//
// Two things drive it, and the difference matters: a poll every POLL_MS that
// works whatever happens, and a live channel that makes it react in about a
// second when it happens to be up. The poll is not a fallback that switches
// on when live fails — it runs the whole time. A channel that dies quietly,
// which is what channels do on a laptop, must not be able to stop the sync
// without anyone noticing.
//
// Deliberately not symmetric with the push side: pushing is driven by local
// file events and pulling by a remote index, so this is a separate loop rather
// than the same one pointed backwards.

const path = require('path');
const files = require('./files');
const config = require('./config');
const trust = require('./trust');
const live = require('./live');

const POLL_MS = 15000;

let timer = null;
let running = false;
let stopped = true;
let notify = () => {};
let rootFor = (slug) => slug;

// slug -> the manifest updatedAt we last pulled. Pulling is keyed on this
// rather than on file mtimes: the manifest is the thing that changes as a
// unit, and a blob that arrives before its index is not yet news.
const lastSeen = new Map();
const wanted = new Set();
const inFlight = new Set();

async function pullOne(slug) {
  if (inFlight.has(slug)) return;
  inFlight.add(slug);
  const root = rootFor(slug);
  notify({ type: 'pull-start', slug });
  try {
    const res = await files.pull(slug, root, config.fileOptions());
    if (res.written > 0) {
      // Receiving revokes trust — the gate in main asks again before the agent
      // or a runner touches this directory. Doing it here rather than in the
      // IPC handler means an automatic pull is covered exactly like a manual
      // one; there is no path that writes files without this running.
      res.trust = trust.markReceived(root);
    }
    lastSeen.set(slug, res.source && res.source.updatedAt);
    notify({ type: 'pull-done', slug, ...res });
  } catch (err) {
    notify({ type: 'pull-error', slug, code: err.code || 'other', detail: String(err.message || err) });
  } finally {
    inFlight.delete(slug);
  }
}

// One sweep: ask what the server has, pull anything wanted whose manifest moved.
async function sweep() {
  if (running || stopped || !wanted.size) return;
  running = true;
  try {
    const res = await files.list();
    for (const p of res.projects || []) {
      if (!wanted.has(p.slug)) continue;
      // Our own push coming back at us is not an update to take.
      if (p.mine) continue;
      if (lastSeen.get(p.slug) === p.updatedAt) continue;
      // eslint-disable-next-line no-await-in-loop
      await pullOne(p.slug);
    }
    notify({ type: 'poll-ok', at: new Date().toISOString(), live: live.isLive() });
  } catch (err) {
    notify({ type: 'poll-error', code: err.code || 'other', detail: String(err.message || err) });
  } finally {
    running = false;
  }
}

function schedule() {
  clearTimeout(timer);
  if (stopped) return;
  timer = setTimeout(async () => { await sweep(); schedule(); }, POLL_MS);
}

function start(slugs, resolveRoot, onEvent) {
  stop();
  stopped = false;
  notify = typeof onEvent === 'function' ? onEvent : () => {};
  rootFor = typeof resolveRoot === 'function' ? resolveRoot : ((s) => s);
  wanted.clear();
  for (const s of slugs || []) wanted.add(s);
  if (!wanted.size) return { ok: true, watching: [] };

  live.start({
    onChange: () => {
      // The channel says *some* manifest moved. Since phase 6b that name is an
      // alias, which this side cannot match against a slug without deriving it
      // — and there is no reason to. The line was never data, only a nudge:
      // sweep and let list() say what actually changed.
      sweep();
    },
    onState: (s) => notify({ type: 'live-state', ...s }),
  });

  sweep();
  schedule();
  return { ok: true, watching: [...wanted] };
}

function stop() {
  stopped = true;
  clearTimeout(timer);
  timer = null;
  wanted.clear();
  live.stop();
  return { ok: true };
}

const state = () => ({
  watching: [...wanted],
  live: live.isLive(),
  pollMs: POLL_MS,
  lastSeen: Object.fromEntries(lastSeen),
});

module.exports = { start, stop, state, sweep, POLL_MS };
