<p align="center">
  <img src="build/icon.png" width="120" alt="TabDesk icon" />
</p>

<h1 align="center">TabDesk</h1>

<p align="center">
  A minimal Electron desktop shell for driving <a href="https://claude.com/claude-code">Claude Code</a>
  across many projects — a left tab rail of terminals, a grid view, and a live project preview.
</p>

---

## Fork notes

A heavily modified fork of [TabDesk](https://github.com/TheJonaz/tabdesk) by
Jonaz Thern. Updates are release-driven: the built-in updater follows this
repository's `v*` tags (release = `npm version minor && git push --follow-tags
origin main`), never individual pushes.

The rail on the left holds **projects**; the strip above the terminals holds
the **sessions** of whichever project is selected. Every session runs inside a
named tmux session (`td-<agent>-<project-path>`), so work survives TabDesk
quitting, crashing, or the X session restarting — the sessions come back at the
next start and reattach, scrollback and all. The × on a session tab ends it for
real (that click is the "I'm done" signal), and quitting the agent inside it
ends it too. No tmux command is ever required.

- **Every project's first tab is its overview** — what it is running now, what
  it can start, and the conversations it has had before. That last list is read
  from Claude Code's, Codex's, opencode's, Kimi Code's and Grok's own session stores, so
  picking one resumes it (`claude --resume`, `codex resume`, `opencode --session`,
  `kimi --session`, `grok --resume`) in a session of its own. Sessions the SDK started — code
  reviews, subagents — are left out; they are jobs, not conversations.
- **The projects folder itself is the rail's home row** (`⌂`, pinned on top) —
  work that spans projects runs in the root, and its sessions and earlier
  conversations live there like any project's.
- **A project can run as many sessions as you like** — the strip's `+` opens
  another under any installed CLI, or in one of the project's worktrees.
  Numbering is per runtime (`Codex ·2`), and a worktree session hangs under the
  project it branches from rather than taking a rail row of its own.
- **The grid is composed, not cycled** — ▦ beside a project or a session keeps
  that panel on screen while you work elsewhere, and the panel's × takes it out
  again without ending anything.
- **Each session owns its agent.** Opening a Codex session doesn't turn the
  project into a Codex project — the project's pick is only the seed the next
  session is born with, and sessions already open keep what they are running.
- **The model bar follows the session's agent.** Claude Code gets the alias
  list, opencode and Kimi Code are asked for their providers, Grok is asked for
  its models, and a CLI that
  can only be configured from inside itself shows what it is set to, read-only.
  Picks are stored per project *and* agent, so they never cross. Kimi effort
  uses `KIMI_MODEL_THINKING_EFFORT` (no CLI flag); plan meters follow the same
  `/usages` endpoint as Kimi's own `/usage`. Grok effort uses
  `--reasoning-effort`; its quota meters stay hidden because no quota source is available.
- **Finished sessions show how long they have waited**, and a project row
  carries the longest wait of the sessions under it, so a rail of green dots
  can be worked oldest-first.
- Only one TabDesk runs at a time; `extras/tabdesk-autostart.desktop` starts
  `extras/tabdesk-guard.sh`, which brings it back after a crash.
  `extras/tabdesk.desktop` is the applications-menu entry (copy it to
  `~/.local/share/applications/`) — launching while one runs just focuses it.

Other deltas: in-app xterm.js terminals (no xterm/xdotool needed), Claude
sessions start with `--dangerously-skip-permissions`, symlinked projects show
in the rail and dot-dirs don't, Laravel previews run `php artisan serve`, and
the usage scan caches per file (`userData/usage-cache.json`). Launch with
`./tabdesk.sh`; `node scripts/seed-closed.js`
once pre-hid the non-project directories, which stay out of the rail.

## Features

- **Project rail** — every directory under your projects folder becomes a row, most-recently-modified first; selecting one shows its sessions in the strip above the terminals.
- **Grid view** — ▦ pins up to six panels on screen at once to watch several agents work side by side.
- **Activity flags** — background sessions pulse while their terminal streams output and turn green when they fall quiet ("your turn"); a project row shows the state of the sessions under it.
- **Live preview dock** — runs the active project (static HTML, Node, Python/Flask/FastAPI/Django, Rust, Go, …), finds the port it binds, and renders it in a webview. Hover any element to reveal its source.
- **Follows your desktop** — colours are derived from the live GTK theme (light/dark, accent, borders) and the UI speaks your system language. Both update live when you change them in system settings.
- **Themes** — ships the classics as presets, each in its official variants: Dracula (+ Alucard), Nord, Solarized, Gruvbox and Atom One in dark & light, Catppuccin in all four flavours, Tokyo Night as Night/Storm/Day, Monokai, plus the original neon look. The theme menu groups a family's variants together. Drop more JSON files in `themes/` to add your own.
- **Screenshot** — capture the focused terminal panel to a PNG in `~/Pictures`.
- **System bar** — live Claude Code token usage (daily / weekly / total with cost estimate), plus CPU, RAM, and a clock.
- **Fullscreen** — `F11` or the toolbar button.

## Requirements

- **Linux** (X11). Native terminal embedding uses `xterm` and `xdotool`; GTK colour probing uses `python3-gi` (all pulled in by the `.deb`).
- **Node.js** 18+ and a C toolchain (`node-pty` is compiled on install).

## Getting started

```bash
npm install      # also rebuilds node-pty against Electron
npm start
```

### Development container

The repository includes a VS Code Dev Container with Node.js 22, the
TypeScript and ESLint extensions, Electron's Linux runtime libraries, tmux,
and the native terminal dependencies. Open the repository in VS Code and
choose **Reopen in Container**, then run:

```bash
npm run lint
npm run typecheck
npm start
```

On Linux, the container forwards the host X11 display for Electron. The
container expects the host user's `DISPLAY` and `.Xauthority` to be available.

### Install as a desktop app

```bash
npm run dist                        # builds dist/tabdesk_<version>_amd64.deb
sudo apt install ./dist/tabdesk_0.1.0_amd64.deb
```

TabDesk then appears in the application menu under Development and launches
standalone from `/opt/TabDesk`.

## Configuration

The projects folder — the folder whose subfolders are your projects — is
chosen on first run and stored as `projectsDir` in `settings.json`; change it
any time under Settings → General (the window reloads, running sessions
survive in tmux). `TABDESK_PROJECTS_DIR` in the environment overrides it for
a single run without persisting anything. Machines that used the old
`~/claude-projects` default keep working — it is adopted into the setting on
first start.

### Theme and language

Both default to `system` and are stored in `~/.config/TabDesk/settings.json`:

```json
{ "theme": "system", "language": "system" }
```

- **`theme`** — `system` derives the palette from the running GTK theme (probed
  through `python3-gi`, falling back to a neutral light/dark pair) or the `id` of
  any preset in `themes/`, e.g. `neon`, `dracula`, `nord`, `solarized-dark`.
- **`language`** — `system` follows `LANGUAGE`/`LANG`, or a code with a file in
  `i18n/` (`en`, `sv`).

A theme file carries a small `palette` (the engine derives the rest), plus
optional `tokens` / `terminal` overrides — see `themes/neon.json`.

### Native terminal embedding

Terminals are embedded `xterm` windows reparented into the panels via X11
(`term-embed.js`), which is why `xterm` and `xdotool` are runtime dependencies.
Set `EMBED_NATIVE = false` in `renderer/renderer.js` to use in-app xterm.js
instead (screenshottable, but no native window).

## Project layout

| File | Role |
| --- | --- |
| `main.js` | Electron main process — window, IPC, terminal (pty) lifecycle |
| `preload.js` | Sandboxed bridge exposing `window.api` to the renderer |
| `renderer/` | UI (`index.html`, `renderer.js`, `styles.css`, `ui.js` theme/i18n layer) |
| `preview-runner.js` | Detects and launches a project for the live preview |
| `preview-preload.js` | Element inspector injected into the preview webview |
| `usage-worker.js` | Off-thread scan of `~/.claude/projects` for token usage |
| `history.js` | Earlier conversations, read from the agents' own session stores |
| `term-embed.js` | Native `xterm` embedding via X11 reparenting |
| `theme.js` | Theme engine — GTK probe, token derivation, presets |
| `themes/` | Theme presets (`neon.json`) |
| `i18n.js`, `i18n/` | Translations and locale detection |
| `settings.js` | Persisted preferences in `userData/settings.json` |
| `build/` | App icon (`icon.svg` source, `icon.png` used at runtime) |

## License

[MIT](LICENSE) © Andreas Thun · based on [TabDesk](https://github.com/TheJonaz/tabdesk) © Jonaz Thern
