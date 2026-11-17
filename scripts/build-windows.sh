#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p build/windows
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -tags desktop,production -ldflags='-s -w -H windowsgui' -o build/windows/PaperLens.exe .
if command -v makensis >/dev/null 2>&1; then makensis packaging/windows.nsi; fi
echo 'Built build/windows/PaperLens.exe'
