#!/bin/bash
# Build MathStudio for Windows x64 → release/MathStudio-Setup.exe (+ .blockmap) + release/latest.yml
# (update info; all three are uploaded to the GitHub Release by CI).
# Runs ON Windows, in Git Bash: GitHub's windows-latest runner (.github/workflows/release.yml).
# Needs Node 20 (npm ci done), uv, curl, 7z. Bundles a standalone Python 3.12 with the engine's
# packages (same pins as Linux: packaging/linux/constraints.txt), a static ffmpeg, the search model
# and Mesa's software OpenGL (only used when the PC has no OpenGL 3.3 driver).
# LaTeX is not bundled: Tex/Equation mobjects need MiKTeX (the app says so if it's missing).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
STAGE="$ROOT/build-res-win"
PYV=3.12
# Mesa for Windows (pal1000/mesa-dist-win, MIT): pinned + checksummed
MESA_VER=26.2.4
MESA_SHA256=351fc8c8b695878ffb3eaa044b3ead08672a48b1a045e3c3e3975811df0f6695

echo "▸ staging Python"
rm -rf "$STAGE" && mkdir -p "$STAGE"
uv python install "$PYV" --install-dir "$STAGE/.uvpy" >/dev/null
cp -a "$(ls -d "$STAGE"/.uvpy/cpython-"$PYV".*-windows-x86_64-none | head -1)" "$STAGE/python"
rm -rf "$STAGE/.uvpy"
PY="$STAGE/python/python.exe"
rm -f "$STAGE"/python/Lib/EXTERNALLY-MANAGED
"$PY" --version
UV_LINK_MODE=copy uv pip install --quiet --python "$PY" --break-system-packages --no-build \
  -r packaging/linux/requirements.txt -c packaging/linux/constraints.txt

echo "▸ MSVC runtime (app-local)"
# python.exe ships vcruntime140*.dll; some wheels also want msvcp140 / concrt140. A clean Windows
# without the VC++ redistributable has none of them, so carry them next to python.exe (allowed:
# app-local deployment of the VC++ runtime).
for f in msvcp140.dll msvcp140_1.dll msvcp140_2.dll msvcp140_atomic_wait.dll msvcp140_codecvt_ids.dll concrt140.dll vcomp140.dll vcruntime140.dll vcruntime140_1.dll; do
  [ -f "$STAGE/python/$f" ] || [ ! -f "/c/Windows/System32/$f" ] || cp "/c/Windows/System32/$f" "$STAGE/python/"
done

echo "▸ ffmpeg"
uv pip install --quiet --python "$PY" --target "$STAGE/ffm" imageio-ffmpeg==0.6.0
cp "$STAGE"/ffm/imageio_ffmpeg/binaries/ffmpeg-win*.exe "$STAGE/python/ffmpeg.exe"
rm -rf "$STAGE/ffm"
"$STAGE/python/ffmpeg.exe" -version | head -1

echo "▸ Mesa $MESA_VER (software OpenGL fallback)"
mkdir -p "$STAGE/.mesa" "$STAGE/mesa"
curl -sSfL -o "$STAGE/.mesa/mesa.7z" "https://github.com/pal1000/mesa-dist-win/releases/download/$MESA_VER/mesa3d-$MESA_VER-release-msvc.7z"
echo "$MESA_SHA256  $STAGE/.mesa/mesa.7z" | sha256sum -c -
7z e -y -bso0 "$STAGE/.mesa/mesa.7z" -o"$STAGE/mesa" x64/opengl32.dll x64/libgallium_wgl.dll
rm -rf "$STAGE/.mesa"
ls -l "$STAGE/mesa"

echo "▸ search model"
HF_HUB_DISABLE_TELEMETRY=1 "$PY" -c "from huggingface_hub import snapshot_download as d; \
d('BAAI/bge-small-en-v1.5', allow_patterns=['onnx/model.onnx','tokenizer.json','config.json'], local_dir=r'$(cygpath -w "$STAGE/models/bge-small-en-v1.5")')" >/dev/null
rm -rf "$STAGE/models/bge-small-en-v1.5/.cache"

echo "▸ engine"
# the non-commercial library content is gitignored, so a CI checkout never has it; excluded anyway
tar -cf - --exclude=.venv --exclude=tests --exclude=data --exclude=videos --exclude=imported_frames \
  --exclude=__pycache__ --exclude='*.pyc' --exclude=.DS_Store \
  --exclude=mathstudio_library/non-commercial --exclude=mathstudio_library/manim-assets/manimgl/3b1b-videos \
  --exclude=mathstudio_imports_nc.json engine | tar -xf - -C "$STAGE"

echo "▸ trimming + precompiling"
rm -rf "$STAGE"/python/Lib/{test,idlelib,ensurepip} "$STAGE/python/include" "$STAGE/python/libs"
find "$STAGE/python" -name '__pycache__' -prune -exec rm -rf {} +
find "$STAGE/python" -name '*.pyc' -delete
# the app runs Python with PYTHONDONTWRITEBYTECODE (the install dir may be read-only)
"$PY" -m compileall -q -j0 --invalidation-mode unchecked-hash "$STAGE/python/Lib" "$STAGE/engine" >/dev/null || true
"$PY" -c "import sys; sys.path.insert(0, r'$(cygpath -w "$STAGE/engine")'); import manimlib, manimpango, moderngl, onnxruntime, tokenizers, numpy, scipy, PIL, code_knobs, search; print('  imports ok')"

# Windows' classic 260-character path limit: the install prefix
# (C:\Users\<name>\AppData\Local\Programs\MathStudio\resources\) takes ~70-90 of them
LONGEST=$(cd "$STAGE" && find . -type f | awk '{ print length($0) - 2 }' | sort -rn | head -1)
echo "  longest path inside resources: $LONGEST chars"
if [ "$LONGEST" -gt 165 ]; then
  (cd "$STAGE" && find . -type f | awk 'length($0) > 167' | head -10)
  echo "✗ paths too long for a default Windows install (MAX_PATH)"; exit 1
fi
echo "  $(find "$STAGE" -type f | wc -l) files, $(du -sh "$STAGE" | cut -f1)"

echo "▸ UI + installer"
npx vite build >/dev/null
rm -rf release/win-unpacked release/MathStudio-Setup.exe*
npx electron-builder --config packaging/windows/electron-builder.yml --win nsis --x64 --publish never "$@"
ls -l release/MathStudio-Setup.exe release/MathStudio-Setup.exe.blockmap release/latest.yml
cat release/latest.yml
