#!/bin/bash
# Install release/ManimUI-Setup.exe silently (per user) and drive the installed app — on Windows,
# in Git Bash (GitHub's windows-latest runner). Screenshots → release/test-out/.
# The runners have no GPU (only Windows' OpenGL 1.1), so this also proves the automatic fallback
# to the bundled Mesa software renderer.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="$PWD/release/test-out"; mkdir -p "$OUT"
export MS_OUT="$OUT" PYTHONUNBUFFERED=1 PYTHONFAULTHANDLER=1
fail=0; failed=()

echo "== silent install"
T0=$SECONDS
CODE=$(powershell -NoProfile -Command "\$p = Start-Process -Wait -PassThru -FilePath '$(cygpath -w "$PWD/release/ManimUI-Setup.exe")' -ArgumentList '/S'; \$p.ExitCode" | tr -d '\r')
echo "   installer exit code $CODE after $((SECONDS - T0)) s"
INSTALL="$(cygpath -u "$LOCALAPPDATA")/Programs/ManimUI"
APP="$INSTALL/ManimUI.exe"
# (the installer may hand over to a child process: give the files a moment to appear)
for i in $(seq 1 60); do [ -f "$APP" ] && break; sleep 5; done
if [ ! -f "$APP" ]; then
  echo "✗ $APP missing after install"
  ls -la "$(cygpath -u "$LOCALAPPDATA")/Programs" 2>&1
  powershell -NoProfile -Command "Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall, HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { \$_.DisplayName -like '*ManimUI*' } | Format-List DisplayName, InstallLocation, UninstallString"
  find /c/Users/runneradmin/AppData "/c/Program Files" -maxdepth 4 -iname 'ManimUI*' 2>/dev/null
  exit 1
fi
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
