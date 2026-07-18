<p align="center">
  <img src="build/icon.png" width="120" alt="TabDesk icon" />
</p>

<h1 align="center">TabDesk</h1>

<p align="center">
  A minimal Electron desktop shell for driving <a href="https://claude.com/claude-code">Claude Code</a>
  across many projects — a left tab rail of terminals, a grid view, and a live project preview.
</p>

---

## Features

- **Project tab rail** — every directory under your projects folder becomes a tab, most-recently-modified first. Opening one spawns a terminal already running `claude --permission-mode auto` in that project.
- **Grid view** — cycle from 1 up to 6 panels visible at once (`▦ Grid`) to watch several agents work side by side.
- **Activity flags** — background tabs pulse while their terminal streams output and turn green when they fall quiet ("your turn").
- **Live preview dock** — runs the active project (static HTML, Node, Python/Flask/FastAPI/Django, Rust, Go, …), finds the port it binds, and renders it in a webview. Hover any element to reveal its source.
- **Screenshot** — capture the focused terminal panel to a PNG in `~/Pictures`.
- **System bar** — live Claude Code token usage (daily / weekly / total with cost estimate), plus CPU, RAM, and a clock.
- **Fullscreen** — `F11` or the toolbar button.

## Requirements

- **Linux** (X11). The optional native-terminal embedding uses `xdotool` and `xfce4-terminal`; the default in-app terminal (xterm.js) needs neither.
- **Node.js** 18+ and a C toolchain (`node-pty` is compiled on install).

## Getting started

```bash
npm install      # also rebuilds node-pty against Electron
npm start
```

## Configuration

The projects folder is currently hard-coded in `main.js`:

```js
const PROJECTS_DIR = '/home/jonaz/claude-projects';
```

Change this to point at wherever your projects live.

### Native terminal embedding (optional)

By default TabDesk renders terminals with xterm.js inside the window (reliable and
screenshottable). To embed real `xfce4-terminal` windows instead, set
`EMBED_XFCE = true` in `renderer/renderer.js`. This uses X11 reparenting and is
more fragile under HiDPI / multi-instance setups.

## Project layout

| File | Role |
| --- | --- |
| `main.js` | Electron main process — window, IPC, terminal (pty) lifecycle |
| `preload.js` | Sandboxed bridge exposing `window.api` to the renderer |
| `renderer/` | UI (`index.html`, `renderer.js`, `styles.css`) |
| `preview-runner.js` | Detects and launches a project for the live preview |
| `preview-preload.js` | Element inspector injected into the preview webview |
| `usage-worker.js` | Off-thread scan of `~/.claude/projects` for token usage |
| `xfce-embed.js` | Optional native `xfce4-terminal` embedding via X11 |
| `build/` | App icon (`icon.svg` source, `icon.png` used at runtime) |

## License

[MIT](LICENSE) © Jonaz Thern
