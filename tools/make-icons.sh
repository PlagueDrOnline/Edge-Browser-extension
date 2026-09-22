#!/usr/bin/env bash
# Regenerates the extension icons + popup logo assets from assets/logo-master.png
# (a transparent-background crop of plague_logo.png). Requires ImageMagick 6/7.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="assets/logo-master.png"
BG="#111418"          # icon plate colour (matches --pd-bg-elev in styles.css)
RING="#c1121f"        # crimson ring accent

# Transparent mark used for the popup watermarks (256px tall)
convert "$SRC" -resize x256 -depth 8 -strip assets/logo-mark.png

# Popup header badge: the same circular crop styles.css applies to the remote
# logo (BRAND.logoUrl), pre-rendered from the original artwork so the bundled
# fallback and the hosted image look identical. Keep these numbers in sync with
# --logo-focus-x / --logo-focus-y / --logo-zoom in styles.css:
#   1024px source, 480px window centred on (394, 540)  →  zoom 1024/480, focus 38.5% / 52.7%
ORIGINAL="plague_logo.png"
convert "$ORIGINAL" -crop 480x480+154+300 +repage -resize 208x208 \
  \( -size 208x208 xc:black -fill white -draw "circle 104,104 104,1" \) \
  -alpha off -compose CopyOpacity -composite -compose Over -depth 8 -strip assets/logo.png

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
