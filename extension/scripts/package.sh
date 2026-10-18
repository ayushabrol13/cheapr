#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/cheapr-<version>.zip with only shipped files.
#   BACKEND_URL=https://api.example.com scripts/package.sh   # release build (required for real users)
#   scripts/package.sh                                        # dev build, talks to http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -R manifest.json background.js offscreen.html offscreen.js _locales icons lib content popup welcome "$stage/"

if [[ -n "${BACKEND_URL:-}" ]]; then
  [[ "$BACKEND_URL" =~ ^https://[a-z0-9.-]+(:[0-9]+)?(/.*)?$ ]] || { echo "BACKEND_URL must be https://…" >&2; exit 1; }
  origin=$(node -p "new URL(process.argv[1]).origin" "$BACKEND_URL")
  # The default server and its host permission must change together, or the service worker's fetch is blocked.
  node -e '
    const fs = require("fs"), [dir, url, origin] = process.argv.slice(1);
    const cfg = dir + "/lib/config.js";
    fs.writeFileSync(cfg, fs.readFileSync(cfg, "utf8").replace(/BACKEND: "[^"]*"/, `BACKEND: ${JSON.stringify(url.replace(/\/+$/, ""))}`));
    const m = JSON.parse(fs.readFileSync(dir + "/manifest.json", "utf8"));
    m.host_permissions = [...new Set([...m.host_permissions.filter((h) => !/localhost|127\.0\.0\.1/.test(h)), origin + "/*"])];
    fs.writeFileSync(dir + "/manifest.json", JSON.stringify(m, null, 2) + "\n");
  ' "$stage" "$BACKEND_URL" "$origin"
  suffix=""
else
  echo "note: no BACKEND_URL; building a development package that talks to localhost" >&2
  suffix="-dev"
fi

mkdir -p dist
out="$PWD/dist/cheapr-${version}${suffix}.zip"
rm -f "$out"
(cd "$stage" && zip -qr "$out" . -x '*.DS_Store')
# Guard: the store rejects remote code; fail if any shipped file loads scripts from the network or evals strings.
if unzip -p "$out" '*.html' '*.js' | grep -nE '<script[^>]+src="https?://|\beval\(|new Function\(' ; then
  echo "remote code or eval found in package" >&2; exit 1
fi
echo "$out ($(du -h "$out" | cut -f1))"
