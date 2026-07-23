#!/usr/bin/env bash
# release.sh — cut a TabDesk release: bump the version, tag it, push. The push
# triggers .github/workflows/release.yml, which builds the .deb and attaches it
# to a GitHub Release; the CDN host then pulls it (its timer, or cdn-refresh.sh).
#
#   deploy/release.sh <version> [--refresh]
#     <version>   new semver, e.g. 0.1.1
#     --refresh   after pushing, run cdn-refresh.sh to publish to the CDN now
#
# Requires a clean working tree on the default branch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
VER="${1:?usage: deploy/release.sh <version> [--refresh]}"; VER="${VER#v}"
REFRESH=0; [ "${2:-}" = "--refresh" ] && REFRESH=1

case "$VER" in [0-9]*.[0-9]*.[0-9]*) ;; *) echo "not a semver: $VER" >&2; exit 2 ;; esac
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean — commit first" >&2; exit 1; }

echo "==> bumping package.json to $VER"
npm version "$VER" --no-git-tag-version --allow-same-version >/dev/null
git add package.json package-lock.json 2>/dev/null || git add package.json
git commit -q -m "Release v$VER" || echo "  (nothing to commit — version unchanged)"

echo "==> tagging v$VER and pushing"
git tag -f "v$VER"
git push origin HEAD
git push -f origin "v$VER"

echo "==> pushed. GitHub Actions is now building the .deb for v$VER."
if [ "$REFRESH" = 1 ]; then
    exec "$ROOT/deploy/cdn-refresh.sh" "$VER"
else
    echo "    publish to the CDN when the build finishes with:  deploy/cdn-refresh.sh $VER"
fi
