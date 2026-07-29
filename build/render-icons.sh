#!/usr/bin/env bash
# Rasterise the two SVG sources into the PNGs the package actually ships.
#
# electron-builder only installs what it is handed: pointing `linux.icon` at a
# single large PNG puts one file in hicolor/<that size>/, and if that size is
# not one of the directories hicolor's index.theme declares, GTK's icon lookup
# never finds it and the menu entry comes up blank. So the app icon is rendered
# into build/icons/ at the standard sizes and `linux.icon` points at the
# directory.
#
# The tray icon is a separate glyph (build/tray.svg) at 22px plus an @2x for
# HiDPI panels, which Electron picks up from the filename.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

command -v rsvg-convert >/dev/null || {
  echo "need rsvg-convert (apt install librsvg2-bin)" >&2
  exit 1
}

mkdir -p icons
for size in 16 24 32 48 64 128 256 512; do
  rsvg-convert -w "$size" -h "$size" icon.svg -o "icons/${size}x${size}.png"
done

# Kept because main.js hands this path to BrowserWindow for the window icon.
rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png

rsvg-convert -w 22 -h 22 tray.svg -o tray.png
rsvg-convert -w 44 -h 44 tray.svg -o tray@2x.png

echo "wrote icons/ (8 sizes), icon.png, tray.png, tray@2x.png"
