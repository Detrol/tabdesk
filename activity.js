// What tmux knows about sessions this window has not opened.
//
// A tab whose terminal was never created has no pty, and a pty is the only
// thing that reports output — so after a restart, when every restored session
// is in exactly that state, the rail's dots have nothing to go on and sit
// still while the agents work. tmux does know, and answers three questions in
// one listing:
//
//   #{window_activity}      when the window last wrote something
//   #{pane_current_path}    where the shell inside actually is (an agent that
//                           cd'd into a worktree leaves tab.cwd on the project
//                           root — the status bar needs the live path)
//   #{pane_title}           the title the program inside set, which is where a
//                           runtime says out loud that it needs you
//
// The window's activity stamp and not the session's: `#{session_activity}`
// only moves while a client is attached, which is precisely the case this
// exists to cover. Measured on tmux 3.4 — a detached session running a shell
// kept session_activity frozen while window_activity followed every line.
//
// Fields are tab-separated so paths and titles can hold spaces. The listing is
// per pane, and a session can hold several, so the newest one speaks for the
// session. Stamps are whole seconds, which is why a poll-driven tab needs a
// wider silence window than a pty-driven one (see POLL_IDLE_MS in the renderer).
const ARGS = [
  'list-panes', '-a', '-F',
  '#{session_name}\t#{window_activity}\t#{pane_current_path}\t#{pane_title}',
];

// Slower than the eye needs, fast enough that "it went quiet" arrives while
// you still care. Each poll is one short-lived tmux process.
const POLL_MS = 2000;

// Only TabDesk's own sessions: anything else on the machine's tmux server
// belongs to somebody else and is none of the rail's business.
/**
 * @param {string} stdout
 * @returns {Record<string, {at: number, title: string, cwd: string}>}
 */
function parse(stdout) {
  /** @type {Record<string, {at: number, title: string, cwd: string}>} */
  const out = {};
  for (const line of String(stdout || '').split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const name = parts[0];
    if (!name.startsWith('td-')) continue;
    const at = Number(parts[1]);
    if (!Number.isFinite(at)) continue;
    const cwd = parts[2] || '';
    const title = parts.length > 3 ? parts.slice(3).join('\t').trim() : '';
    const prev = out[name];
    if (!prev || at > prev.at) out[name] = { at, title, cwd };
    else {
      if (!prev.title && title) prev.title = title;
      if (!prev.cwd && cwd) prev.cwd = cwd;
    }
  }
  return out;
}

module.exports = { parse, ARGS, POLL_MS };
