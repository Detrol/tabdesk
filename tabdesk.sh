#!/bin/sh
# Launch TabDesk on the local X display. The projects folder is the app's own
# setting (chosen at first run, changeable in Settings); TABDESK_PROJECTS_DIR
# in the environment overrides it for a single run without persisting.
export DISPLAY="${DISPLAY:-:0}"
# new-session refuses inside an existing tmux client, and the ptys inherit our
# environment — launching from a tmux'd SSH session must not poison them.
unset TMUX
cd "$(dirname "$0")" || exit 1
exec ./node_modules/.bin/electron . "$@"
