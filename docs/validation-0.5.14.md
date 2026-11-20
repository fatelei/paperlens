# 0.5.14 setup guide validation

- Go tests, including race detection: passed.
- Frontend unit tests: 74 passed.
- Browser interaction suites: workspace, scanned correction, review, settings, workflow, and onboarding passed with a mocked native bridge.
- Installer retry tests: existing macOS dylib symlinks and redirected-directory rejection passed.
- Layout regression tests: passed.
- Native macOS arm64: the actual app detected Python/Node, reused checksum-verified Jev weights, downloaded the engine archive, installed dependencies, and passed Chromium/layout and OCR/Jev connection checks. This test reused existing weights; it was not a fresh download of every model file.
- Both macOS arm64 and Windows x64 builds succeeded locally. Windows installer compiled; native Windows runtime verification remains pending.

The guide is also tested for missing dependencies, official installer links, failed downloads, retry without duplicate completed stages, repeated connection checks, background/reopen, shared cancellation during service startup, and missing model files after cleanup.

After native validation, only the app-owned `models`, `ocr-engine`, and `local-jev` directories were removed for a first-run trial. Settings were verified unchanged by hash; document storage was not modified.

No OCR correction rules or verification thresholds were changed in this release.
