# Xterm 6 and Official Addons

## Goal

Upgrade the in-app terminal to xterm.js 6 and replace its private clipboard hook with supported APIs. Add plain web links, OSC 52 clipboard writes, inline images, WebGL rendering, programming ligatures, terminal progress, and Unicode 11 width data.

## Behavior

- Clicking an HTTP or HTTPS URL opens it through TabDesk's existing validated external-link IPC.
- OSC 52 can write sanitized text to the system clipboard, but cannot read it.
- Normal terminal copy and paste use `Ctrl+Shift+C` and `Ctrl+Shift+V`; right-click still pastes.
- SIXEL and iTerm images render with conservative per-terminal size and storage limits.
- WebGL is preferred and falls back to the DOM renderer after context loss or initialization failure.
- Fira Code supplies visible programming ligatures.
- OSC 9;4 progress is shown as a thin bar on the session tab and is cleared when progress finishes.
- Unicode 11 is activated for stable character-width handling.

## Implementation

Use the official `@xterm/*` browser bundles and keep the renderer sandbox unchanged. Configure the addons beside the existing `FitAddon` setup in `materialize()`. Use a custom clipboard provider that routes writes through `window.api.copySelection`, rejects reads with an empty response, caps encoded data at 100 KiB, and removes unsafe control characters.

Keep Output unchanged. Its full transcript/tmux source is more complete than xterm's current screen, so Serialize does not improve it.

## Verification

Add one Electron renderer test for the TabDesk-owned behavior and run it red then green. Run the existing full `npm test` gate in isolation. Do not drive or restart the guard-managed TabDesk window.

## Out of scope

- Changing the Output overlay.
- Clipboard reads requested by terminal programs.
- A user settings screen for addon options.
- Integrating, pushing, or restarting the live app.
