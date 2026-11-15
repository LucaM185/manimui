#!/bin/bash
# Build MathStudio.app for macOS (Apple Silicon) with a bundled standalone Python holding ManimGL & co
# (the same versions as engine/.venv), ffmpeg and the search model, signed with the Developer ID
# certificate in the keychain.
#   packaging/mac/build.sh             → release/mac-arm64/MathStudio.app
#   packaging/mac/build.sh --install   … and replace /Applications/MathStudio.app with it
#   packaging/mac/build.sh --release   public build, notarized + stapled → release/mac/:
#       MathStudio-arm64.dmg (download), MathStudio-arm64-mac.zip + .blockmap (in-app updates),
#       latest-mac.yml (update feed). Upload with scripts/release-mac.sh.
# LaTeX is not bundled: the app uses MacTeX from /Library/TeX/texbin if it is installed.
# The non-commercial library content (gitignored) is included only for this machine's own install;
# MS_PUBLIC=1 (implied by --release) leaves it out — required for anything that gets distributed.
# Builds with that content are marked (package.json mathstudioLocalBuild) so the in-app updater
# only points at the download page instead of replacing them with the public build.
# Notarization uses a notarytool keychain profile (MS_NOTARY_PROFILE, default "feather"; create one
# with `xcrun notarytool store-credentials <name>`): the Apple credentials stay in the keychain.
# MS_NOTARIZE=0 skips notarization (local tests only — release-mac.sh refuses such builds).
# MS_VERSION=x.y.z builds that version number instead of package.json's, MS_MAC_OUT=<dir> puts the
# release files there instead of release/mac (update tests: tests/mac_update.mjs).
set -euo pipefail
MODE="${1:-}"
case "$MODE" in ""|--install|--release) ;; *) echo "usage: build.sh [--install|--release]"; exit 2 ;; esac
[ "$MODE" = --release ] && export MS_PUBLIC=1
cd "$(dirname "$0")/../.."
ROOT="$PWD"
STAGE="$ROOT/build-res-mac"
UV="$(command -v uv || echo "$HOME/.local/bin/uv")"
[ -x engine/.venv/bin/python ] || { echo "engine/.venv missing — run ./setup.sh first"; exit 1; }

echo "▸ staging Python"
rm -rf "$STAGE" && mkdir -p "$STAGE"
PYV="$(engine/.venv/bin/python -c 'import platform; print(platform.python_version())')"
"$UV" python install "$PYV" --install-dir "$STAGE/.uvpy" >/dev/null
cp -a "$(ls -d "$STAGE"/.uvpy/cpython-"$PYV"-macos-aarch64-none)" "$STAGE/python"
rm -rf "$STAGE/.uvpy"
PY="$STAGE/python/bin/python3"
rm -f "$STAGE"/python/lib/python3.*/EXTERNALLY-MANAGED
"$UV" pip freeze --python engine/.venv/bin/python > "$STAGE/requirements.txt"
UV_LINK_MODE=copy "$UV" pip install --quiet --python "$PY" --break-system-packages --no-build -r "$STAGE/requirements.txt"
rm "$STAGE/requirements.txt"

echo "▸ ffmpeg"
"$UV" pip install --quiet --target "$STAGE/ffm" imageio-ffmpeg==0.6.0
cp "$STAGE"/ffm/imageio_ffmpeg/binaries/ffmpeg-macos* "$STAGE/python/bin/ffmpeg"
chmod +x "$STAGE/python/bin/ffmpeg" && rm -rf "$STAGE/ffm"
"$STAGE/python/bin/ffmpeg" -version | head -1

echo "▸ search model"
HF_HUB_DISABLE_TELEMETRY=1 "$PY" -c "from huggingface_hub import snapshot_download as d; \
d('BAAI/bge-small-en-v1.5', allow_patterns=['onnx/model.onnx','tokenizer.json','config.json'], local_dir='$STAGE/models/bge-small-en-v1.5')" >/dev/null
rm -rf "$STAGE/models/bge-small-en-v1.5/.cache"

echo "▸ engine"
EXCL=(--exclude .venv --exclude tests --exclude data --exclude videos --exclude imported_frames --exclude __pycache__ --exclude '*.pyc' --exclude .DS_Store)
if [ "${MS_PUBLIC:-}" = 1 ]; then
  EXCL+=(--exclude mathstudio_library/non-commercial --exclude mathstudio_library/manim-assets/manimgl/3b1b-videos --exclude mathstudio_imports_nc.json)
fi
rsync -a "${EXCL[@]}" engine/ "$STAGE/engine/"

echo "▸ trimming + precompiling"
# not needed at runtime; static archives / headers also trip up code signing
rm -rf "$STAGE"/python/lib/python3.*/{test,idlelib,ensurepip} "$STAGE"/python/lib/python3.*/config-* \
       "$STAGE/python/include" "$STAGE/python/share" "$STAGE"/python/lib/pkgconfig
find "$STAGE/python" -name '__pycache__' -prune -exec rm -rf {} +
find "$STAGE/python" -name '*.dSYM' -prune -exec rm -rf {} +
rm -rf "$STAGE"/python/lib/python3.*/site-packages/PyObjCTest
find "$STAGE/python" \( -name '*.a' -o -name '*.pyc' \) -delete
# the app runs Python with PYTHONDONTWRITEBYTECODE (never write into the signed bundle)
"$PY" -m compileall -q -j0 --invalidation-mode unchecked-hash "$STAGE"/python/lib "$STAGE/engine" >/dev/null || true
"$PY" -c "import sys; sys.path.insert(0, '$STAGE/engine'); import manimlib, manimpango, moderngl, onnxruntime, tokenizers, numpy, scipy, PIL, code_knobs, search; print('  imports ok')"

echo "▸ signing native code"
# electron-builder's signer treats every non-text file as code (tens of thousands of .pyc, fonts…)
# and timestamps each one: sign only the real Mach-O binaries here, in parallel, and let it skip
# the Python tree (signIgnore in electron-builder.yml). Same identity, hardened runtime and
# entitlements as the app, so the bundle stays notarizable.
IDENTITY="${MS_SIGN_ID:-$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ {print $2; exit}')}"
[ -n "$IDENTITY" ] || { echo "no 'Developer ID Application' certificate in the keychain (set MS_SIGN_ID)"; exit 1; }
ENT="$ROOT/packaging/mac/entitlements.plist"
find "$STAGE/python" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0 \
  | xargs -0 file --no-pad -N | grep -v '(for architecture' | awk -F': ' '/Mach-O/ {print $1}' > "$STAGE/macho.txt"
echo "  $(wc -l < "$STAGE/macho.txt" | tr -d ' ') binaries → $IDENTITY"
tr '\n' '\0' < "$STAGE/macho.txt" | xargs -0 -P 8 -n 16 \
  codesign --force --timestamp --options runtime --entitlements "$ENT" --sign "$IDENTITY" 2>&1 | grep -v ': replacing existing signature' || true
rm "$STAGE/macho.txt"
"$PY" -c "import numpy, scipy.linalg, cv2, onnxruntime, moderngl" && echo "  signed python ok"

echo "▸ UI + app"
npx vite build >/dev/null
rm -rf release/mac-arm64
EB_ARGS=()
[ "${MS_PUBLIC:-}" = 1 ] || EB_ARGS+=(-c.extraMetadata.mathstudioLocalBuild=true)
[ -n "${MS_VERSION:-}" ] && EB_ARGS+=("-c.extraMetadata.version=$MS_VERSION")
export CSC_NAME="${IDENTITY#Developer ID Application: }"
npx electron-builder --config packaging/mac/electron-builder.yml --mac dir --arm64 --publish never ${EB_ARGS[@]+"${EB_ARGS[@]}"}
APP="release/mac-arm64/MathStudio.app"
codesign --verify --deep --strict "$APP" && echo "  signature ok: $(codesign -dvv "$APP" 2>&1 | grep '^Authority=' | head -1)"
du -sh "$APP"

if [ "$MODE" = --release ]; then
  V="$(node -p "require('./package.json').version")"; V="${MS_VERSION:-$V}"
  # stapler can't write under ~/Desktop (TCC), where this repo may live: notarize, staple and
  # package in a temp folder, then copy the results back
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/mathstudio-release.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
  PROFILE="${MS_NOTARY_PROFILE:-feather}"
  notarize() {  # $1 = file to submit (.zip / .dmg)
    echo "  submitting $(basename "$1") ($(du -h "$1" | cut -f1)) to Apple's notary service…"
    local out id status
    out="$(xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait --timeout 2h --output-format json)" || {
      echo "$out"; echo "✗ notarytool failed (an expired Apple Developer agreement shows as HTTP 403: accept it at developer.apple.com/account)"; exit 1; }
    id="$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.id||"")' "$out")"
    status="$(node -e 'const j=JSON.parse(process.argv[1]);console.log(j.status||"")' "$out")"
    if [ "$status" != Accepted ]; then
      echo "✗ notarization $status ($id)"; xcrun notarytool log "$id" --keychain-profile "$PROFILE" 2>&1 | head -60; exit 1
    fi
    echo "  ✓ notarized ($id)"
  }
  staple() {  # stapling right after acceptance sometimes fails until the ticket propagates
    for attempt in 1 2 3 4 5; do
      xcrun stapler staple -q "$1" && xcrun stapler validate -q "$1" && return 0
      [ "$attempt" = 5 ] && { echo "✗ stapling $1 failed"; exit 1; }
      echo "  ⟳ ticket not ready, retrying in 30 s…"; sleep 30
    done
  }
  echo "▸ notarizing the app"
  ditto "$APP" "$WORK/MathStudio.app"
  if [ "${MS_NOTARIZE:-1}" = 0 ]; then
    echo "  (skipped: MS_NOTARIZE=0 — not for distribution)"
  else
    ditto -c -k --keepParent "$WORK/MathStudio.app" "$WORK/submit.zip"
    notarize "$WORK/submit.zip"; rm "$WORK/submit.zip"
    staple "$WORK/MathStudio.app"
    spctl -a -t exec -vv "$WORK/MathStudio.app" 2>&1 | sed 's/^/  /'
  fi
  echo "▸ dmg + zip"
  # --prepackaged: package the stapled app as is (electron-builder does not sign it again)
  npx electron-builder --config packaging/mac/electron-builder.yml --prepackaged "$WORK/MathStudio.app" \
    --mac dmg zip --arm64 --publish never -c.directories.output="$WORK/out" "-c.extraMetadata.version=$V" >/dev/null
  DMG="$WORK/out/MathStudio-arm64.dmg"
  if [ "${MS_NOTARIZE:-1}" != 0 ]; then
    echo "▸ notarizing the dmg"
    notarize "$DMG"
    staple "$DMG"
  fi
  # stapling changed the dmg: refresh its size + sha512 in latest-mac.yml (the zip is what updates use)
  node packaging/mac/finish-latest.cjs "$WORK/out/latest-mac.yml" "$WORK/out"
  OUTDIR="${MS_MAC_OUT:-release/mac}"
  rm -rf "$OUTDIR" && mkdir -p "$OUTDIR"
  cp "$DMG" "$WORK/out/MathStudio-arm64-mac.zip" "$WORK/out/MathStudio-arm64-mac.zip.blockmap" "$WORK/out/latest-mac.yml" "$OUTDIR/"
  [ "${MS_NOTARIZE:-1}" = 0 ] && touch "$OUTDIR/NOT-NOTARIZED"
  ls -lh "$OUTDIR"
fi

if [ "$MODE" = "--install" ]; then
  echo "▸ installing to /Applications"
  osascript -e 'tell application "MathStudio" to quit' >/dev/null 2>&1 || true
  rm -rf /Applications/MathStudio.app
  ditto "$APP" /Applications/MathStudio.app
  echo "✓ /Applications/MathStudio.app"
fi
