# 0.5.16 validation — 2026-11-24

Fixed engine installation when an archive lists a symbolic link before the link it references. The official llama.cpp b11901 macOS archive contains this ordering for `libggml.dylib` and `libggml.0.dylib`.

- Regression reproduces the installation error before the fix and passes afterward.
- Missing targets, cyclic links, escaping chains, and aliased extraction roots remain covered.
- Full Go race suite passed.
- Downloaded the actual official arm64 archive, verified its pinned SHA-256, extracted it using the application code, and successfully ran `llama-server --version`.

No OCR correction rules, score thresholds, document data, or model weights were changed.
