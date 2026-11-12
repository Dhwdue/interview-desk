#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Build the disk image on macOS.' >&2
  exit 1
fi
mkdir -p dist
output="$PWD/dist/Interview-Desk-macOS.dmg"
stage="$(mktemp -d)"
cleanup() {
  node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$stage"
}
trap cleanup EXIT
app="$stage/Interview Desk.app"
assets="$app/Contents/Resources"
mkdir -p "$app/Contents/MacOS" "$assets"/{data,docs,examples,lib,public,scripts}
cp server.mjs transcribe.py run.sh setup.sh README.md AGENTS.md LICENSE "$assets/"
cp lib/{coaching,config,feedback,sessions,setup,store}.mjs "$assets/lib/"
cp public/{app.js,index.html,styles.css} "$assets/public/"
cp examples/{job.json,sample-session.md} "$assets/examples/"
cp docs/architecture.md "$assets/docs/"
cp data/behavioral-bank.json data/starter-bank.json "$assets/data/"
cp scripts/setup.mjs "$assets/scripts/"
ln -s /Applications "$stage/Applications"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Interview Desk</string>
  <key>CFBundleDisplayName</key><string>Interview Desk</string>
  <key>CFBundleIdentifier</key><string>io.github.dhwdue.interview-desk</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict></plist>
PLIST
cat > "$app/Contents/MacOS/launch" <<'LAUNCH'
#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
assets="$(cd -- "$(dirname -- "$0")/../Resources" && pwd)"
log_dir="$HOME/Library/Logs/Interview Desk"
umask 077
mkdir -p "$log_dir"
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'; then
  osascript -e 'display alert "Interview Desk needs Node.js 22 or newer" message "Install Node.js from nodejs.org, then open Interview Desk again."'
  exit 1
fi
if ! node "$assets/server.mjs" --open >> "$log_dir/launcher.log" 2>&1; then
  osascript -e 'display alert "Interview Desk could not start" message "See Library/Logs/Interview Desk/launcher.log in your home folder."'
  exit 1
fi
LAUNCH
chmod +x "$app/Contents/MacOS/launch"
codesign --force --sign - "$app"
hdiutil create -quiet -volname 'Interview Desk' -srcfolder "$stage" -format UDZO -ov "$output"
echo "$output"
