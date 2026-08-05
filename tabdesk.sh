#!/bin/sh
# Launch TabDesk on the local X display. The projects folder is the app's own
# setting (chosen at first run, changeable in Settings); TABDESK_PROJECTS_DIR
# in the environment overrides it for a single run without persisting.
export DISPLAY="${DISPLAY:-:0}"
# new-session refuses inside an existing tmux client, and the ptys inherit our
# environment — launching from a tmux'd SSH session must not poison them.
unset TMUX

# GUI sessions only source .profile, not .bashrc — agent CLIs installed under
# ~/.local/bin, ~/.opencode/bin, ~/.npm-global/bin etc. would otherwise be
# invisible to agents.js onPath checks (and never offered in the rail).
HOME="${HOME:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)}"
HOME="${HOME:-/home/$(id -un)}"
for dir in \
  "$HOME/.opencode/bin" \
  "$HOME/.local/bin" \
  "$HOME/.npm-global/bin" \
  "$HOME/.codex/bin" \
  "$HOME/.grok/bin" \
  "$HOME/.kimi-code/bin" \
  "$HOME/bin"
do
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) [ -d "$dir" ] && PATH="$dir:$PATH" ;;
  esac
done
export PATH

cd "$(dirname "$0")" || exit 1
exec ./node_modules/.bin/electron . "$@"
