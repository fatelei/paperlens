#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p build/bin/PaperLens.app/Contents/MacOS build/bin/PaperLens.app/Contents/Resources
CGO_ENABLED=1 go build -trimpath -tags desktop,production -ldflags='-s -w' -o build/bin/PaperLens.app/Contents/MacOS/PaperLens .
cp packaging/Info.plist build/bin/PaperLens.app/Contents/Info.plist
if [ -f packaging/PaperLens.icns ]; then cp packaging/PaperLens.icns build/bin/PaperLens.app/Contents/Resources/; fi
xattr -dr com.apple.FinderInfo build/bin/PaperLens.app 2>/dev/null || true
codesign --force --deep --sign - build/bin/PaperLens.app
echo 'Built build/bin/PaperLens.app (ad-hoc signed, not notarized)'
