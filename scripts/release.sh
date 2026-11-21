#!/usr/bin/env bash
# The one way to ship a release:   npm run release [patch|minor|major]   (default: patch)
#   1. checks: on main, clean tree, in sync with origin, typecheck passes
#   2. bumps package.json, commits "Release X.Y.Z", tags vX.Y.Z, pushes → GitHub Actions
#      (.github/workflows/release.yml) builds + tests the Linux and Windows packages and uploads them
#   3. creates the draft GitHub Release; it is published once Linux, Windows and Mac files are all on
#      it (scripts/release-upload.sh), so the in-app updaters never see a half-uploaded release
#   4. Mac release files, here: public build, notarized → dmg + update zip (scripts/release-mac.sh)
#   5. installs this Mac's own build (with the non-commercial library) in /Applications
# Flags: --no-mac      release without Mac files (the draft won't wait for them)
#        --no-install  skip step 5
#        --dry         run the checks only, change nothing
set -euo pipefail
cd "$(dirname "$0")/.."

BUMP=patch; MAC=1; INSTALL=1; DRY=0
for a in "$@"; do
  case "$a" in
    patch|minor|major) BUMP=$a ;;
    --no-mac) MAC=0 ;;
    --no-install) INSTALL=0 ;;
    --dry) DRY=1 ;;
    *) echo "usage: npm run release [patch|minor|major] [--no-mac] [--no-install] [--dry]"; exit 2 ;;
  esac
done
[ "$(uname)" = Darwin ] || { MAC=0; INSTALL=0; }

[ "$(git branch --show-current)" = main ] || { echo "✗ not on main"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "✗ working tree not clean — commit or stash first"; git status --short; exit 1; }
git fetch -q origin
[ -z "$(git rev-list HEAD..origin/main)" ] || { echo "✗ origin/main has commits you don't have — pull first"; exit 1; }
[ -z "$(git rev-list origin/main..HEAD)" ] || git push -q origin main   # unpushed commits ride along
npm run -s typecheck
if [ "$MAC" = 1 ]; then  # fail before tagging, not after: the Mac step needs both
  security find-identity -v -p codesigning | grep -q "Developer ID Application" || { echo "✗ no Developer ID certificate in the keychain (or use --no-mac)"; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "✗ gh is not logged in (gh auth login), needed to upload the Mac files"; exit 1; }
fi
echo "✓ checks passed"
[ "$DRY" = 1 ] && exit 0

npm version "$BUMP" -m "Release %s"     # bumps, commits, tags vX.Y.Z
git push --follow-tags
V=$(node -p "require('./package.json').version")
echo "✓ pushed v$V — Linux + Windows build/test: https://github.com/LucaM185/manimui/actions"
# the draft exists before CI's upload (≥ 1 h from now), so the two never race to create it
if [ "$MAC" = 1 ]; then scripts/release-upload.sh "v$V" --create "linux windows mac"
else scripts/release-upload.sh "v$V" --create "linux windows"; fi

MAC_OK=1
if [ "$MAC" = 1 ]; then
  scripts/release-mac.sh || {
    MAC_OK=0
    echo "✗ Mac release files failed — v$V stays a draft (Linux/Windows still upload). Fix it, then: npm run release:mac"
    echo "  (or publish without Mac: scripts/release-upload.sh v$V --publish)"
  }
fi
if [ "$INSTALL" = 1 ]; then
  packaging/mac/build.sh --install
  echo "✓ Mac app v$V installed in /Applications"
fi
[ "$MAC_OK" = 1 ]
