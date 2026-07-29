#!/usr/bin/env bash
# cdn-pull.sh — pull the latest TabDesk release from GitHub and publish it into
# the local reprepro apt repo. Runs ON the CDN host (cdn.thern.io), driven by a
# systemd timer — the host reaches out to GitHub, so its firewall stays closed.
#
#   cdn-pull.sh [version] [--force] [--dry-run]
#     (no version)  resolve and publish the latest GitHub release
#     version       publish a specific version, e.g. 0.1.1
#     --force       republish even if the state file says it is already current
#     --dry-run     resolve + print the asset, download/publish nothing
#
# The TabDesk repo is PRIVATE for now, so this authenticates with a read-only
# token from $TABDESK_ENV (default /etc/tabdesk/pull.env: TABDESK_GH_TOKEN=…).
# Private-repo assets can't be fetched from browser_download_url — we use the
# asset API url with Accept: application/octet-stream. When the repo goes public
# the token simply becomes optional.
#
# Idempotent: records the last-published version in a state file and exits early
# when GitHub's latest already matches, so the timer can fire as often as it likes.
set -euo pipefail

REPO="${TABDESK_REPO:-TheJonaz/tabdesk}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEB_BASE="${TABDESK_DEB_BASE:-/srv/cdn/tabdesk}"      # reprepro base (nginx serves it)
CODENAME="${TABDESK_CODENAME:-stable}"
# NOT under $HOME. systemd gives a system service no HOME, and `set -u` turns
# the bare expansion into a fatal error — which is exactly what happened: every
# timer run died on this line while running it by hand kept working, so the repo
# stayed current and the breakage was invisible outside the journal. A host
# service's state belongs in /var/lib anyway, and this way the path doesn't
# depend on who or what invoked the script.
STATE="${TABDESK_CDN_STATE:-/var/lib/tabdesk-cdn/published}"
ENV_FILE="${TABDESK_ENV:-/etc/tabdesk/pull.env}"

log(){ printf '==> %s\n' "$*"; }
die(){ printf 'cdn-pull: %s\n' "$*" >&2; exit 1; }

# Token (if present) lets us read a private repo's release assets.
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
TOKEN="${TABDESK_GH_TOKEN:-${GITHUB_TOKEN:-}}"

FORCE=0; DRY=0; VERSION=""
for a in "$@"; do
    case "$a" in
        --force)   FORCE=1 ;;
        --dry-run) DRY=1 ;;
        -*) die "unknown option: $a" ;;
        *) [ -z "$VERSION" ] || die "unexpected argument: $a"; VERSION="$a" ;;
    esac
done

command -v curl >/dev/null || die "curl is required"
command -v reprepro >/dev/null || die "reprepro is required"

# GitHub API helper — adds the bearer token when we have one.
auth=(); [ -n "$TOKEN" ] && auth=(-H "Authorization: Bearer $TOKEN")
api(){ curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: tabdesk-cdn-pull" "${auth[@]}" "$@"; }

# Resolve the target release JSON (carries asset id + name + url).
if [ -n "$VERSION" ]; then
    VERSION="${VERSION#v}"
    json="$(api "https://api.github.com/repos/$REPO/releases/tags/v$VERSION")" || die "no release v$VERSION"
else
    json="$(api "https://api.github.com/repos/$REPO/releases/latest")" || die "could not reach GitHub (private repo without a valid token in $ENV_FILE?)"
    VERSION="$(printf '%s' "$json" | sed -n 's/.*"tag_name":[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$VERSION" ] || die "could not parse the latest release tag"
fi
log "target version: $VERSION"

# Find the .deb asset's API url (works for private repos) and its filename.
# Parse JSON with python3 so url/name stay paired within each asset object. The
# release JSON goes in via env (TABDESK_JSON), not stdin — a heredoc would eat
# stdin and python would read its own script instead of the JSON.
read -r deb_url deb_name < <(TABDESK_JSON="$json" python3 -c '
import os, json
data = json.loads(os.environ["TABDESK_JSON"])
for a in data.get("assets", []):
    if a.get("name", "").endswith("_amd64.deb"):
        print(a["url"], a["name"]); break
' 2>/dev/null || true)
[ -n "$deb_url" ] || die "no *_amd64.deb asset on release v$VERSION"

if [ "$DRY" = 1 ]; then
    log "dry run — would publish $deb_name from $deb_url"
    exit 0
fi

# Idempotency: skip if this version is already published.
if [ "$FORCE" != 1 ] && [ -f "$STATE" ] && [ "$(cat "$STATE" 2>/dev/null)" = "$VERSION" ]; then
    log "already published $VERSION — nothing to do (use --force to republish)"
    exit 0
fi

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
log "download $deb_name"
# Asset download needs the octet-stream Accept; token still applies for private.
curl -fL --retry 3 --max-time 600 \
    -H "Accept: application/octet-stream" -H "User-Agent: tabdesk-cdn-pull" "${auth[@]}" \
    -o "$STAGE/$deb_name" "$deb_url"

log "reprepro includedeb $CODENAME $deb_name"
# Idempotent re-runs: drop any existing build of this package first (deb repo is
# latest-only; the previous .deb is purged from the pool).
reprepro -b "$DEB_BASE" remove "$CODENAME" tabdesk >/dev/null 2>&1 || true
reprepro -b "$DEB_BASE" includedeb "$CODENAME" "$STAGE/$deb_name"

mkdir -p "$(dirname "$STATE")" 2>/dev/null || true
printf '%s\n' "$VERSION" > "$STATE" 2>/dev/null || log "warning: could not write state file $STATE"
log "done — published TabDesk $VERSION to $DEB_BASE"
