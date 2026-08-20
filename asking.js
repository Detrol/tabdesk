// Is this session waiting for an answer, or has it merely gone quiet?
//
// Silence cannot tell those apart: a runtime that finished its turn and one
// that has put a question on the screen both stop writing. What separates them
// is what the screen holds — and every runtime here asks the same way, with a
// numbered list whose current choice carries a caret.
//
// Captured from the real TUIs rather than guessed (Claude Code 2.1.221 in plan
// mode, Codex 0.146.0):
//
//   What one-line note should I add to note.txt?
//   ❯ 1. You decide — brief, useful note
//     2. I'll specify it
//     3. Type something.
//   Enter to select · ↑/↓ to navigate · Esc to cancel
//
// The screen is read in main and only the verdict crosses to the renderer: the
// pane holds the conversation, and none of it needs to travel to colour a dot.

// Most questions are not menus at all. Measured, same probe: asked to plan a
// change and ask first, Claude answered in prose and went back to its prompt —
//
//   ● note.txt doesn't exist yet. What line should I add to it?
//   ✻ Brewed for 11s
//   ❯
//
// — which is a question by every measure except the one a menu detector uses.
// Both runtimes mark their own messages with a bullet (Claude ●, Codex •), so
// the last bullet and the wrapped lines under it are the last thing that was
// said. Ending it in a question mark is asking.
const BULLET = /^[ \t]{0,4}[●•][ \t]+\S/;
const WRAP = /^[ \t]{2,}\S/;

// A numbered option, and the same with the selection caret in front. Only the
// caret forms are TUI chrome — an agent writing "1. do this" in prose has no
// caret, which is what keeps a numbered answer from reading as a question.
const OPTION = /^[ \t]{0,6}[❯›»▸]?[ \t]*\d+\.[ \t]+\S/;
const MARKED = /^[ \t]{0,6}[❯›»▸][ \t]*\d+\.[ \t]+\S/;

// The footer a list draws under itself, and the wordings the approval boxes
// use. Fallbacks: either one alone is enough, so a runtime that restyles its
// options still registers.
const HINT = /Enter to select[\s\S]{0,60}?to cancel/;
const WORDED = /\bDo you want to (proceed|continue|allow|use)\b|\bAllow Codex to run\b|\bReady to code\?/;

// The runtime's last message, bullet and wrapped lines together. Anything not
// indented under the bullet is something else: the turn's own summary line, the
// input box, the status bar.
function lastMessage(lines) {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BULLET.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return '';
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length && WRAP.test(lines[i]); i++) block.push(lines[i]);
  return block.join(' ').trim();
}

// Codex says it outright: while it waits for an approval it sets the terminal
// title to "[ ! ] Action Required | <project>", alternating with "[ . ]" to
// make it blink. That is a runtime telling us, not us inferring, so it beats
// every rule below — and it has to, because the blinking itself is output, and
// read as output it would leave a blocked session looking permanently busy.
//
// Claude has no equivalent. Measured on 2.1.221: no bell (tmux's bell flag
// stayed clear), no OSC 9 or OSC 777 notification, and its title carries "✳"
// both when it asks and when it merely finishes — so for Claude the screen is
// still the only witness.
const TITLE_ASKING = /^\[\s*[!.]\s*\]\s*Action Required\b/;

function fromTitle(title) {
  return TITLE_ASKING.test(String(title || '').trim());
}

function isAsking(screen) {
  const text = String(screen || '');
  if (!text) return false;
  const lines = text.split('\n');

  let options = 0;
  let marked = false;
  for (const line of lines) {
    if (!OPTION.test(line)) continue;
    options++;
    if (MARKED.test(line)) marked = true;
  }
  if (marked && options >= 2) return true;
  if (HINT.test(text) || WORDED.test(text)) return true;
  return lastMessage(lines).endsWith('?');
}

const askingApi = { isAsking, fromTitle };
if (typeof module !== 'undefined') module.exports = askingApi;
if (typeof window !== 'undefined') window.TabDeskAsking = askingApi;
