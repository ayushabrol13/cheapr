#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/cheapr-<version>.zip with only shipped files.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
mkdir -p dist
out="dist/cheapr-${version}.zip"
rm -f "$out"
zip -qr "$out" manifest.json background.js offscreen.html offscreen.js _locales icons lib content popup welcome \
  -x '*.DS_Store'
# Guard: the store rejects remote code; fail if any shipped file loads scripts from the network.
if unzip -p "$out" '*.html' '*.js' | grep -nE '<script[^>]+src="https?://|\beval\(|new Function\(' ; then
  echo "remote code or eval found in package" >&2; exit 1
fi
echo "$out ($(du -h "$out" | cut -f1))"
