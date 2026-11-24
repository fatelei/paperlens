# App-managed runtime, 0.5.15

Desktop users install PaperLens and click one setup button without installing Python, Node.js, pip, or changing PATH. Go downloads pinned standalone CPython and official Node archives into app data, verifies SHA256, extracts into temporary directories, checks executables and publishes completed components. Retry reuses completed archives; partial extraction never counts as installed.

Existing documents, models and system installations are preserved. The official Jev SDK, renderer and layout algorithms remain unchanged. When a virtual environment uses a different base interpreter, the installer rebuilds only that virtual environment. Readiness checks require the manifest to point at app-owned interpreter files. Child processes ignore user Python configuration and use the standalone interpreter's CA bundle for installation.

The guide shows automatic runtime preparation, progress and cancel/retry. There are no external runtime installer links. Test empty-PATH installation, failed/cancelled download recovery, valid old-environment migration, Chromium text/formula rendering and layout inference. CI runs the same runtime/render check on macOS and Windows. Model scoring accuracy is outside this change.
