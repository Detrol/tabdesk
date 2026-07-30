#!/usr/bin/env bash
# install.sh — adds the signed TabDesk apt repo and installs tabdesk.
# Published at https://cdn.thern.io/tabdesk/install.sh; this file is the source
# of truth, copy it to the host with:
#
#   scp deploy/host/install.sh cdn:/srv/cdn/tabdesk/install.sh
#
# Usage on the target machine:
#   curl -fsSL https://cdn.thern.io/tabdesk/install.sh | sudo bash
#
# The repo is public, so no credentials are involved. TABDESK_CDN_AUTH is still
# honoured for the case where the CDN is put back behind HTTP Basic auth: set it
# to user:password and the script authenticates its own fetches and leaves an
# apt credentials file behind. It is never passed on a command line — see the
# curl --config below — because argv is world-readable through ps and this runs
# as root.
#
# The keyring is verified before it is written. That matters because the step
# people get wrong is fetching the key through something that is not the CDN:
# mail clients rewrite links (Gmail turns the URL into www.google.com/url?q=…),
# and that wrapper answers 200 with an HTML interstitial. curl -f is happy with
# it, so the HTML lands in /usr/share/keyrings/tabdesk.gpg and the failure only
# surfaces later, as a keyring parse error out of apt that names neither the
# real cause nor this script. Checking the fingerprint here turns that into one
# clear message at the point where it went wrong.
set -euo pipefail

BASE="https://cdn.thern.io/tabdesk"
KEYRING="/usr/share/keyrings/tabdesk.gpg"
LIST="/etc/apt/sources.list.d/tabdesk.list"
AUTHFILE="/etc/apt/auth.conf.d/tabdesk.conf"

# The repo signing key ('TabDesk APT repository', deploy/host/apt-repo-setup.sh).
# Clients pin it, so it does not change between releases — see deploy/README.md.
KEY_FPR="B40ED00954B3B56421F58C99B9D44CBC6F2BD93E"

[ "$(id -u)" = "0" ] || { echo "run as root (sudo bash)" >&2; exit 1; }

AUTH="${TABDESK_CDN_AUTH:-}"
if [ -n "$AUTH" ]; then
    case "$AUTH" in
        *:*) ;;
        *) echo "TABDESK_CDN_AUTH must look like user:password" >&2; exit 2 ;;
    esac
    CDN_USER="${AUTH%%:*}"
    CDN_PASS="${AUTH#*:}"
fi

echo "==> fetching signing key"
tmpkey="$(mktemp)"
tmpcfg="$(mktemp)"
chmod 600 "$tmpcfg"
trap 'rm -f "$tmpkey" "$tmpcfg"' EXIT
# An empty config file is a valid curl config, so the unauthenticated path takes
# exactly the same code path as the authenticated one.
[ -n "$AUTH" ] && printf 'user = "%s"\n' "$AUTH" > "$tmpcfg"
curl -fsSL --config "$tmpcfg" "$BASE/tabdesk-archive-keyring.gpg" -o "$tmpkey"

# gpg is a hard requirement, not a nice-to-have. The previous fallback — accept
# the file if its first byte is an OpenPGP packet header (0x98/0x99) and then
# set `got` to the expected fingerprint — made the comparison below pass for ANY
# valid key. The pin was inert on exactly the machines it was meant to protect:
# a fresh container or minimal server, which is where gnupg is missing. There is
# no partial check worth having here, so install it or stop.
if ! command -v gpg >/dev/null 2>&1; then
    echo "==> installing gnupg (needed to verify the signing key)"
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y --no-install-recommends gnupg >/dev/null 2>&1 || true
fi
if ! command -v gpg >/dev/null 2>&1; then
    cat >&2 <<'MSG'
error: gnupg is required to verify the TabDesk signing key, and installing it
       failed. Nothing was written.

       Install it and re-run:  apt-get install -y gnupg
MSG
    exit 1
fi

echo "==> verifying signing key"
# `|| true` inside the substitution on purpose: gpg exits 2 on a file that
# isn't a key, and under `set -e` that would kill the script here — right
# before the one message that explains what went wrong.
got="$(gpg --show-keys --with-colons "$tmpkey" 2>/dev/null | awk -F: '/^fpr:/{print $10; exit}' || true)"

if [ "$got" != "$KEY_FPR" ]; then
    cat >&2 <<MSG
error: $BASE/tabdesk-archive-keyring.gpg did not return the TabDesk signing key.
       expected fingerprint: $KEY_FPR
       got:                  ${got:-not an OpenPGP key at all}

       Usually this means the URL was fetched through a link wrapper or proxy
       (a mail client rewriting the link, or a captive portal) rather than from
       cdn.thern.io directly. Nothing was written; retype the URL and re-run.
MSG
    exit 1
fi

install -m644 "$tmpkey" "$KEYRING"

echo "==> writing apt source"
echo "deb [signed-by=$KEYRING] $BASE stable main" > "$LIST"

if [ -n "$AUTH" ]; then
    echo "==> writing apt credentials"
    # 0600 and root-owned: this is the repo password, and apt reads it as root.
    mkdir -p "$(dirname "$AUTHFILE")"
    touch "$AUTHFILE"
    chmod 600 "$AUTHFILE"
    cat > "$AUTHFILE" <<CRED
machine cdn.thern.io/tabdesk
login $CDN_USER
password $CDN_PASS
CRED
elif [ -f "$AUTHFILE" ]; then
    # Left over from when the repo was private. The password it holds no longer
    # opens anything, so keeping it is pure liability — drop it.
    echo "==> removing stale apt credentials from the private-repo days"
    rm -f "$AUTHFILE"
fi

echo "==> apt update + install"
apt-get update
apt-get install -y tabdesk

echo "==> done. Launch it from your menu or run: tabdesk"
