#!/usr/bin/env bash
# Publish site/ to tabdesk.thern.io over FTP.
#
# Credentials live in deploy/.ftp.env — gitignored, chmod 600, never committed.
# Nothing here is destructive by default: files are uploaded and overwritten,
# but anything already on the server that no longer exists locally is left
# alone. Pass --delete when you actually want the remote to mirror the local
# tree, and --dry-run first if you want to see what that would remove.
#
#   deploy/site-publish.sh              # upload
#   deploy/site-publish.sh --dry-run    # show what would happen, change nothing
#   deploy/site-publish.sh --delete     # also remove remote files that are gone here
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
env_file="$here/.ftp.env"
local_dir="$root/site"

[ -f "$env_file" ] || { echo "Saknar $env_file (FTP-uppgifterna)." >&2; exit 1; }
[ -d "$local_dir" ] || { echo "Saknar $local_dir." >&2; exit 1; }

# shellcheck source=/dev/null
. "$env_file"
: "${FTP_HOST:?}" "${FTP_USER:?}" "${FTP_PASS:?}"
FTP_DIR="${FTP_DIR:-/}"

# Reglerna läses i ordning och första träffen avgör: .htaccess ska med (den
# håller besöksdatabasen oåtkomlig utifrån), databasen ska varken laddas upp
# eller städas bort av --delete, och övriga dotfiler ska inte upp alls. Sista
# regeln är en avsiktlig fångst-alla — när första regeln är en include blir
# lftp:s implicita default "exkludera resten", och utan den åker inget upp.
mirror_flags="--verbose --parallel=3 --include-glob .htaccess --exclude-glob visitors.sqlite* --exclude-glob .* --include ."
for arg in "$@"; do
  case "$arg" in
    --dry-run) mirror_flags="$mirror_flags --dry-run" ;;
    --delete)  mirror_flags="$mirror_flags --delete" ;;
    *) echo "Okänd flagga: $arg" >&2; exit 2 ;;
  esac
done

echo "→ $local_dir  ⇒  ftp://$FTP_USER@$FTP_HOST$FTP_DIR"

# ftp:ssl-allow keeps the login off the wire in clear text where the server
# offers FTPS; the certificate on shared hosting rarely matches the hostname,
# hence verify-certificate off. Plain FTP is the fallback, not the intent.
lftp -u "$FTP_USER","$FTP_PASS" "$FTP_HOST" <<LFTP
set ftp:ssl-allow true
set ftp:ssl-protect-data true
set ssl:verify-certificate no
set net:max-retries 2
set net:timeout 20
mirror --reverse $mirror_flags "$local_dir" "$FTP_DIR"
bye
LFTP

echo "Klart. Kontrollera https://tabdesk.thern.io/"
