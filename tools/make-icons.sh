#!/usr/bin/env bash
# Regenerates the extension icons + popup logo from assets/logo-master.png
# (a transparent-background crop of plague_logo.png). Requires ImageMagick 6/7.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="assets/logo-master.png"
BG="#111418"          # icon plate colour (matches --pd-bg-elev in styles.css)
RING="#c1121f"        # crimson ring accent

# Popup header logo (transparent, 256px tall)
convert "$SRC" -resize x256 -depth 8 -strip assets/logo.png

make_icon () {
  local size="$1" out="$2"
  local radius=$(( size * 22 / 100 ))
  local inner=$(( size * 84 / 100 ))
  convert -size "${size}x${size}" xc:none \
    -fill "$BG" -draw "roundrectangle 0,0 $((size-1)),$((size-1)) ${radius},${radius}" \
    \( "$SRC" -resize "${inner}x${inner}" \) -gravity center -geometry +0+$(( size / 40 )) -composite \
    -depth 8 -strip "$out"
}

for s in 16 32 48 128; do make_icon "$s" "icons/icon${s}.png"; done
# Edge Add-ons / Chrome Web Store listing logo (300x300, ring accent)
convert -size 300x300 xc:none \
  -fill "$BG" -draw "roundrectangle 0,0 299,299 66,66" \
  -stroke "$RING" -strokewidth 6 -fill none -draw "roundrectangle 3,3 296,296 64,64" \
  \( "$SRC" -resize 236x236 \) -gravity center -geometry +0+6 -composite \
  -depth 8 -strip store/listing-logo-300.png
echo "icons regenerated"
