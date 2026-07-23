#!/usr/bin/env bash
# apt-repo-setup.sh — one-time init of the TabDesk reprepro apt repo on the CDN
# host (cdn.thern.io). Idempotent; safe to re-run.
#
# Creates a dedicated signing key ("TabDesk APT repository"), the reprepro base
# at $DEB_BASE, and exports the public key clients verify against. nginx already
# serves $CDN_WWW with autoindex, so $DEB_BASE/{dists,pool} become reachable at
# https://cdn.thern.io/tabdesk/ with no nginx change.
#
# TabDesk keeps its OWN base + key, separate from Moraine's /srv/cdn/deb, so it
# stays unlisted now and can be released independently later.
set -euo pipefail

CDN_WWW="${CDN_WWW:-/srv/cdn}"
DEB_BASE="${TABDESK_DEB_BASE:-$CDN_WWW/tabdesk}"
CODENAME="${TABDESK_CODENAME:-stable}"
GPG_NAME="${GPG_NAME:-TabDesk APT repository}"
GPG_EMAIL="${GPG_EMAIL:-info@thern.io}"

log(){ printf '==> %s\n' "$*"; }

command -v reprepro >/dev/null || { echo "reprepro missing" >&2; exit 1; }

# 1. Signing key (dedicated to TabDesk; created once).
if ! gpg --list-secret-keys "TabDesk APT repository" >/dev/null 2>&1; then
    log "creating signing key '$GPG_NAME'"
    batch="$(mktemp)"
    cat > "$batch" <<KEY
%no-protection
Key-Type: eddsa
Key-Curve: ed25519
Key-Usage: sign
Name-Real: $GPG_NAME
Name-Email: $GPG_EMAIL
Expire-Date: 0
%commit
KEY
    gpg --batch --generate-key "$batch"
    rm -f "$batch"
else
    log "signing key already present"
fi
KEYID="$(gpg --list-keys --with-colons "TabDesk APT repository" | awk -F: '/^pub:/{print $5; exit}')"
log "signing key id: $KEYID"

# 2. reprepro base.
mkdir -p "$DEB_BASE/conf"
cat > "$DEB_BASE/conf/distributions" <<DIST
Origin: TabDesk
Label: TabDesk
Suite: $CODENAME
Codename: $CODENAME
Architectures: amd64
Components: main
Description: TabDesk APT repository
SignWith: $KEYID
DIST

# 3. Public key clients pin. Both the dearmored keyring (apt) and armored (docs).
gpg --export "$KEYID"        > "$DEB_BASE/tabdesk-archive-keyring.gpg"
gpg --armor --export "$KEYID" > "$DEB_BASE/tabdesk-archive-keyring.asc"

log "reprepro base ready at $DEB_BASE"
log "install line:"
echo "  deb [signed-by=/usr/share/keyrings/tabdesk.gpg] https://cdn.thern.io/tabdesk $CODENAME main"
