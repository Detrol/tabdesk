#!/usr/bin/env bash
# cdn-refresh.sh — publish a release to the CDN NOW instead of waiting for the
# host's ≤10-min timer. Run after deploy/release.sh has pushed a tag.
#
#   deploy/cdn-refresh.sh <version> [--no-wait] [--dry-run]
#     <version>   the release just pushed, e.g. 0.1.1
#     --no-wait   don't wait for the GitHub build; trigger immediately
#     --dry-run   wait, then print the trigger command without running it
#
# The CDN (cdn.thern.io) is PULL-based and firewalled; the way in is the ssh
# alias `cdn`, which your own ~/.ssh/config defines. This waits for the release
# build to attach the .deb, then runs the host's pull service once.
#
# Idempotent: cdn-pull.sh records the last-published version and no-ops when
# already current, so re-running (or the timer also firing) is harmless.
set -euo pipefail

VER="${1:?usage: cdn-refresh.sh <version> [--no-wait] [--dry-run]}"; shift || true
VER="${VER#v}"; TAG="v$VER"
NOWAIT=0; DRY=0
for a in "$@"; do
    case "$a" in
        --no-wait) NOWAIT=1 ;;
        --dry-run) DRY=1 ;;
        *) printf 'cdn-refresh: unknown option: %s\n' "$a" >&2; exit 2 ;;
    esac
done

REPO="${TABDESK_REPO:-TheJonaz/tabdesk}"
SSH_CDN="${TABDESK_CDN_SSH:-cdn}"
WAIT_TRIES="${TABDESK_CDN_WAIT_TRIES:-40}"        # 40 × 30s = up to ~20 min
log(){ printf 'cdn-refresh: %s\n' "$*"; }

# 1. Wait for the release build to attach the .deb (best-effort).
if [ "$NOWAIT" = 0 ] && command -v gh >/dev/null 2>&1; then
    log "waiting for $TAG to build on GitHub (up to ~20 min; --no-wait to skip)…"
    ok=0
    for _ in $(seq 1 "$WAIT_TRIES"); do
        have="$(gh release view "$TAG" --repo "$REPO" --json assets \
                   -q '[.assets[].name]|join(" ")' 2>/dev/null || true)"
        case " $have " in *_amd64.deb*) ok=1; break ;; esac
        sleep 30
    done
    [ "$ok" = 1 ] && log "the .deb is attached to $TAG." \
                  || log "timed out waiting — triggering anyway (host pulls whatever is ready)."
else
    log "not waiting for the build."
fi

# 2. Trigger the host to pull + publish now.
TRIGGER='systemctl start tabdesk-cdn-pull.service'
if [ "$DRY" = 1 ]; then
    log "dry-run — would run:  ssh $SSH_CDN '$TRIGGER'"
    exit 0
fi
log "triggering a publish on '$SSH_CDN'…"
if ssh -o ConnectTimeout=25 "$SSH_CDN" "$TRIGGER"; then
    sleep 5
    # The repo is behind HTTP Basic auth. Read the password from apt's own
    # credentials file if this machine has the repo configured; otherwise the
    # check is skipped rather than reported as a failure — publishing already
    # succeeded at this point either way.
    got=""
    authfile=/etc/apt/auth.conf.d/tabdesk.conf
    cdn_auth="${TABDESK_CDN_AUTH:-}"
    if [ -z "$cdn_auth" ] && [ -r "$authfile" ]; then
        cdn_auth="$(awk '/^login/{u=$2} /^password/{p=$2} END{if (u && p) print u ":" p}' "$authfile")"
    fi
    if [ -n "$cdn_auth" ]; then
        cfg="$(mktemp)"; chmod 600 "$cfg"
        printf 'user = "%s"\n' "$cdn_auth" > "$cfg"
        got="$(curl -fsS -4 --max-time 15 --config "$cfg" \
                https://cdn.thern.io/tabdesk/dists/stable/main/binary-amd64/Packages 2>/dev/null \
                | awk -F': ' '/^Version:/{print $2; exit}')"
        rm -f "$cfg"
    fi
    if [ -n "$got" ]; then
        log "done — CDN now serves TabDesk $got (wanted $VER)."
    else
        log "done — published; could not read back the version (no CDN credentials here)."
    fi
else
    log "could not reach '$SSH_CDN' — the CDN will still update within ~10 min via its timer." >&2
    exit 1
fi
