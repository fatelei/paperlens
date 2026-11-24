# 0.5.15 validation — 2026-11-24

- Go regression suite with race detection: passed, including runtime ownership, cached install repair, cancellation, failed executable checks, and complete/corrupt `.part` recovery after HTTP 416.
- Frontend unit tests: 74 passed.
- Onboarding and settings browser interaction suites: passed with an explicitly mocked native bridge.
- Python installer tests: four passed, including migration from a valid system-based virtual environment to the app-managed interpreter while preserving model files.
- Real macOS arm64 runtime test: passed with an empty system PATH and deliberately invalid user Python configuration. The test installs pinned private Python and Node, creates a virtual environment, installs the actual SDK dependencies and Chromium, executes the layout model, and renders both text and a formula through the official Node precheck and Chromium renderer.
- The rendering test copies the SDK to an isolated directory, matching its installed location and avoiding the frontend repository's ESM package scope.
- CI exposed a macOS temporary-directory alias issue during archive extraction. Canonical-root comparison fixes it without accepting escaping links; both regression cases and a fresh real runtime installation through `/tmp` passed.
- Local macOS app and Windows x64 installer builds: passed. The macOS app was reopened at its original path; all nine documents remained present. The new guide and its actual screenshot were verified.

GitHub CI runs the same real private-runtime/rendering test on macOS and Windows before building artifacts. See the corresponding workflow run for remote results. This test does not download the full OCR/Jev weights or rerun the seven-page recognition benchmark. OCR correction rules and score thresholds did not change.

The desktop app is left at the installation guide for the user's trial. System Python/Node installations, settings, documents and manual edits are preserved.
