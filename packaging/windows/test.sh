#!/bin/bash
# Install release/MathStudio-Setup.exe silently (per user) and drive the installed app — on Windows,
# in Git Bash (GitHub's windows-latest runner). Screenshots → release/test-out/.
# The runners have no GPU (only Windows' OpenGL 1.1), so this also proves the automatic fallback
# to the bundled Mesa software renderer.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="$PWD/release/test-out"; mkdir -p "$OUT"
export MS_OUT="$OUT" PYTHONUNBUFFERED=1 PYTHONFAULTHANDLER=1
fail=0; failed=()

echo "== silent install"
powershell -NoProfile -Command "Start-Process -Wait -FilePath 'release\\MathStudio-Setup.exe' -ArgumentList '/S'" || { echo "installer failed"; exit 1; }
INSTALL="$(cygpath -u "$LOCALAPPDATA")/Programs/MathStudio"
APP="$INSTALL/MathStudio.exe"
[ -f "$APP" ] || { echo "✗ $APP missing after install"; ls -la "$INSTALL" 2>&1 | head; exit 1; }
RES="$INSTALL/resources"
echo "   ✓ installed: $(du -sh "$INSTALL" | cut -f1) in $(cygpath -w "$INSTALL")"

echo "== engine tests with the bundled Python (Mesa software GL)"
ENG="$(mktemp -d)/eng"
cp -r "$RES/engine" "$ENG" && cp -r engine/tests "$ENG/tests"
( cd "$ENG" && PATH="$RES/mesa:$RES/python:$PATH" GLCONTEXT_WIN_LIBGL="$(cygpath -w "$RES/mesa/opengl32.dll")" GALLIUM_DRIVER=llvmpipe \
    PYTHONUTF8=1 "$RES/python/python.exe" -W ignore tests/test_engine.py --export ) || { fail=1; failed+=('engine tests'); }

# Electron tests get one retry, like on Linux (Chromium's startup now and then stalls in CI)
run_retry() { "$@" && return 0; echo "   ↻ failed once, retrying"; "$@"; }
echo "== smoke test (installed app; the engine must fall back to Mesa by itself)"
MS_TAG=win MS_APP="$(cygpath -w "$APP")" MS_EXPECT_SOFTWARE_GL=1 run_retry node tests/linux_smoke.mjs || { fail=1; failed+=('smoke test'); }
echo "== Settings tab test"
MS_APP="$(cygpath -w "$APP")" run_retry node tests/settings.mjs || { fail=1; failed+=('Settings test'); }

if [ $fail = 0 ]; then echo "WINDOWS TESTS PASS"; else
  echo "WINDOWS TESTS FAILED: ${failed[*]}"
  for f in "${failed[@]}"; do echo "::error title=Windows test failed::$f (search the log for its == section and ✗ lines)"; done
fi
exit $fail
