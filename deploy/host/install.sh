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

# The repo signing key ('TabDesk APT repository', deploy/host/apt-repo-setup.sh).
# Clients pin it, so it does not change between releases — see deploy/README.md.
KEY_FPR="B40ED00954B3B56421F58C99B9D44CBC6F2BD93E"

[ "$(id -u)" = "0" ] || { echo "run as root (sudo bash)" >&2; exit 1; }

echo "==> fetching signing key"
tmpkey="$(mktemp)"
trap 'rm -f "$tmpkey"' EXIT
curl -fsSL "$BASE/tabdesk-archive-keyring.gpg" -o "$tmpkey"

echo "==> verifying signing key"
if command -v gpg >/dev/null 2>&1; then
    # `|| true` inside the substitution on purpose: gpg exits 2 on a file that
    # isn't a key, and under `set -e` that would kill the script here — right
    # before the one message that explains what went wrong.
    got="$(gpg --show-keys --with-colons "$tmpkey" 2>/dev/null | awk -F: '/^fpr:/{print $10; exit}' || true)"
else
    # No gnupg on this machine — fall back to checking that the file at least
    # starts with an OpenPGP public-key packet (0x98/0x99) rather than markup.
    got=""
    case "$(head -c1 "$tmpkey" | od -An -tx1 | tr -d ' ')" in
        98|99) got="$KEY_FPR" ;;
    esac
fi

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

echo "==> apt update + install"
apt-get update
apt-get install -y tabdesk

echo "==> done. Launch it from your menu or run: tabdesk"
