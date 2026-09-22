#!/usr/bin/env bash
# Builds a store-ready zip (Edge Add-ons / Chrome Web Store) containing only
# the files the extension needs at runtime.
#
#   ./tools/package.sh            -> dist/plague-doctor-controller-mapper-<version>.zip
#
# Windows (PowerShell) equivalent:
#   Compress-Archive -Path manifest.json,background.js,content.js,bridge.js,popup.html,popup.js,styles.css,lib,icons,assets\logo.png -DestinationPath dist\pdcm.zip
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./manifest.json').version")"
OUT_DIR="dist"
OUT="${OUT_DIR}/plague-doctor-controller-mapper-${VERSION}.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT"

zip -r -X "$OUT" \
  manifest.json \
  background.js \
  content.js \
  bridge.js \
  popup.html \
  popup.js \
  styles.css \
  lib/shared.js \
  lib/license.js \
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png \
  assets/logo.png

echo "Packaged ${OUT} ($(du -h "$OUT" | cut -f1))"
