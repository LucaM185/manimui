#!/usr/bin/env bash
# The Mac part of a release, on this Mac: build the public app, notarize + staple it, package the
# dmg + update zip, and add them to the GitHub Release of the version in package.json.
#   npm run release:mac      (npm run release runs it right after pushing the tag; run it again
#                             by hand to retry, e.g. after accepting an expired Apple agreement)
# Needs the Developer ID certificate in the keychain and a notarytool keychain profile
# (MS_NOTARY_PROFILE, default "feather" — `xcrun notarytool store-credentials <name>` makes one).
# Nothing secret leaves the keychain; the files go to GitHub with your own `gh` login.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname)" = Darwin ] || { echo "✗ run this on a Mac"; exit 1; }
V=$(node -p "require('./package.json').version"); TAG="v$V"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "✗ no tag $TAG here (npm run release makes it)"; exit 1; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$TAG^{commit}")" ] || { echo "✗ HEAD is not $TAG — git checkout $TAG first"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "✗ working tree not clean — the build packs it, so it must be exactly $TAG"; git status --short; exit 1; }
git ls-remote --exit-code --tags origin "$TAG" >/dev/null || { echo "✗ $TAG is not on GitHub yet: git push origin $TAG"; exit 1; }

packaging/mac/build.sh --release
[ ! -e release/mac/NOT-NOTARIZED ] || { echo "✗ release/mac is not notarized (MS_NOTARIZE=0): not uploading it"; exit 1; }
xcrun stapler validate -q release/mac/MathStudio-arm64.dmg || { echo "✗ the dmg has no notarization ticket"; exit 1; }
scripts/release-upload.sh "$TAG" release/mac/MathStudio-arm64.dmg release/mac/MathStudio-arm64-mac.zip \
  release/mac/MathStudio-arm64-mac.zip.blockmap release/mac/latest-mac.yml
