#!/bin/sh
# Launch TabDesk against /srv/dev on the local X display.
export TABDESK_PROJECTS_DIR=/srv/dev
export DISPLAY="${DISPLAY:-:0}"
# new-session refuses inside an existing tmux client, and the ptys inherit our
# environment — launching from a tmux'd SSH session must not poison them.
unset TMUX
cd "$(dirname "$0")" || exit 1
exec ./node_modules/.bin/electron . "$@"
