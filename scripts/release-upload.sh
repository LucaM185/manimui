#!/usr/bin/env bash
# Add files to the GitHub Release of a tag, and publish it once every platform is there.
#   scripts/release-upload.sh vX.Y.Z [file…]              upload (creating the draft if needed)
#   scripts/release-upload.sh vX.Y.Z --create [platforms]  only create the draft (npm run release does
#                                                          this right after pushing the tag)
#   scripts/release-upload.sh vX.Y.Z --publish            publish now, whatever is missing
# Used by CI (Linux + Windows files, GH_TOKEN = the workflow token) and on the Mac by
# scripts/release-mac.sh (your own `gh` login). Uploads go to GitHub only — no other storage, no
# credentials beyond the gh token.
#
# The release stays a DRAFT until it has the update feed of every platform it expects
# (latest-linux.yml, latest.yml, latest-mac.yml): the in-app updater only ever sees a release whose
# files are all there. Expected platforms are written into the draft's notes as an HTML comment
# (invisible on GitHub, stripped in the app) by whoever creates it; default: linux windows mac.
set -euo pipefail
TAG="${1:?usage: release-upload.sh vX.Y.Z [file…] | --create [platforms] | --publish}"; shift
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "✗ not a release tag: $TAG"; exit 2; }
V="${TAG#v}"
MARK='manimui-platforms:'

exists() { gh release view "$TAG" --json tagName >/dev/null 2>&1; }
create() {  # $1 = platforms
  gh release create "$TAG" --draft --verify-tag --title "ManimUI $V" --generate-notes \
    --notes "<!-- $MARK $1 -->" >/dev/null
  echo "✓ draft release $TAG created (expects: $1)"
}
feed() { case "$1" in linux) echo latest-linux.yml ;; windows) echo latest.yml ;; mac) echo latest-mac.yml ;; *) echo "?" ;; esac; }
publish() {
  gh release edit "$TAG" --draft=false --latest >/dev/null
  echo "✓ published $TAG: $(gh release view "$TAG" --json url -q .url)"
}

if [ "${1:-}" = "--create" ]; then
  shift; exists && { echo "✓ release $TAG already exists"; exit 0; }
  create "${*:-linux windows mac}"; exit 0
fi
if [ "${1:-}" = "--publish" ]; then publish; exit 0; fi

exists || create "linux windows mac"
if [ $# -gt 0 ]; then
  for f in "$@"; do [ -f "$f" ] || { echo "✗ missing $f"; exit 1; }; done
  # --clobber: a re-run (retry after a failed notarization…) replaces what an earlier run uploaded
  gh release upload "$TAG" "$@" --clobber
  echo "✓ uploaded to $TAG: $(for f in "$@"; do basename "$f"; done | tr '\n' ' ')"
fi

INFO="$(gh release view "$TAG" --json isDraft,body,assets -q '[.isDraft, ((.body // "") | capture("'"$MARK"' (?<p>[a-z ]+) -->").p // "linux windows mac"), ([.assets[].name] | join(" "))] | @tsv')"
IFS=$'\t' read -r DRAFT WANT HAVE <<< "$INFO"
[ "$DRAFT" = true ] || { echo "✓ $TAG is already published"; exit 0; }
missing=()
for p in $WANT; do [[ " $HAVE " == *" $(feed "$p") "* ]] || missing+=("$p"); done
if [ ${#missing[@]} -eq 0 ]; then publish
else echo "… $TAG stays a draft until it has: ${missing[*]} (has: $HAVE)"; fi
