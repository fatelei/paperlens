# First-run setup wizard

User asks for a page-based installation guide and clearing local model files so they can try first-run setup. Deliver 0.5.14 with automatic missing-component detection, a sidebar/settings re-entry, dependency detection including macOS GUI PATH and Windows install paths, official Python/Node installer links, app-bundled Jev installer/SDK, progress, cancel/retry and final service/layout/browser checks. No terminal or source checkout needed for model installation. Python/Node system installation remains guided through official installers when absent.

Reuse OCR download/install methods. Run embedded Python installer in an owned process group, stream bounded progress and retain log in app data; cancellation kills child processes, incomplete installs never write success marker. Marker is written after all dependency/browser/layout checks, status additionally verifies files. Only platform-specific app data is modified. Network download checksums remain pinned; never shell-interpolate user values. Preserve manual edits, document database and threshold.

First-run opens when any required asset is missing. During installation close sends task to background, re-opening shows current state; cancel stops further stages and active service startup. All UI success messages require real file and service checks. Missing dependencies show official download buttons and retry.

Test mocked installation stages/failure/cancel/retry/status checks, real native existing-file installation and connection checks, then clean only PaperLens model/runtime install directories (preserve documents/settings), rebuild/open wizard and leave downloads pending for user. Windows compile tested; native Windows validation remains pending.
