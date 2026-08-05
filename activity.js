// What tmux knows about sessions this window has not opened.
//
// A tab whose terminal was never created has no pty, and a pty is the only
// thing that reports output — so after a restart, when every restored session
// is in exactly that state, the rail's dots have nothing to go on and sit
// still while the agents work. tmux does know, and answers two questions in
// one listing:
//
//   #{window_activity}  when the window last wrote something
//   #{pane_title}       the title the program inside set, which is where a
//                       runtime says out loud that it needs you
//
// The window's activity stamp and not the session's: `#{session_activity}`
// only moves while a client is attached, which is precisely the case this
// exists to cover. Measured on tmux 3.4 — a detached session running a shell
// kept session_activity frozen while window_activity followed every line.
//
// The listing is per pane, and a session can hold several, so the newest one
// speaks for the session. Stamps are whole seconds, which is why a poll-driven
// tab needs a wider silence window than a pty-driven one (see POLL_IDLE_MS in
// the renderer).
const ARGS = ['list-panes', '-a', '-F', '#{session_name} #{window_activity} #{pane_title}'];

// Slower than the eye needs, fast enough that "it went quiet" arrives while
// you still care. Each poll is one short-lived tmux process.
const POLL_MS = 2000;

// Only TabDesk's own sessions: anything else on the machine's tmux server
// belongs to somebody else and is none of the rail's business.
//
// Session names cannot hold spaces and the stamp is digits, so the title is
// simply everything after the second space — titles do contain spaces, and
// Codex's carries a `|`.
function parse(stdout) {
  const out = {};
  for (const line of String(stdout || '').split('\n')) {
    const first = line.indexOf(' ');
    if (first < 1) continue;
    const name = line.slice(0, first);
    if (!name.startsWith('td-')) continue;
    const second = line.indexOf(' ', first + 1);
    const at = Number(line.slice(first + 1, second < 0 ? undefined : second));
    if (!Number.isFinite(at)) continue;
    const title = second < 0 ? '' : line.slice(second + 1).trim();
    const prev = out[name];
    if (!prev || at > prev.at) out[name] = { at, title };
    else if (!prev.title && title) prev.title = title;
  }
  return out;
}

module.exports = { parse, ARGS, POLL_MS };
