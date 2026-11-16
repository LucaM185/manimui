#!/bin/bash
# Double-click (or ./MathStudio.command) to launch MathStudio from this folder's sources — always the
# newest code, committed or not, whatever MathStudio.app is installed. The UI bundle is rebuilt
# when anything under it changed (edits, new or deleted files), npm packages are reinstalled when
# package-lock.json changed; the engine and the main process run straight from the sources.
#   ./MathStudio.command --install   also rebuild /Applications/MathStudio.app from these sources
#                                    (~3–4 min) and open that instead
cd "$(dirname "$0")"
unset ELECTRON_RUN_AS_NODE
[ -x engine/.venv/bin/python ] || ./setup.sh

if [ "${1:-}" = --install ]; then
  shift
  packaging/mac/build.sh --install || exit 1
  exec open /Applications/MathStudio.app --args "$@"
fi

if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Dependencies changed — npm install…"
  npm install --no-audit --no-fund || exit 1
fi

# path + size + mtime of every UI input: catches edits, new files and deletions alike
ui_stamp="$(find src index.html vite.config.ts package.json package-lock.json public -type f ! -name .DS_Store \
  -print0 2>/dev/null | sort -z | xargs -0 stat -f '%N %z %m' | shasum | cut -c1-16)"
if [ ! -f dist/index.html ] || [ "$(cat dist/.ui-stamp 2>/dev/null)" != "$ui_stamp" ]; then
  echo "Sources changed — rebuilding UI…"
  npx vite build || exit 1
  echo "$ui_stamp" > dist/.ui-stamp
fi
exec ./node_modules/.bin/electron . "$@"
