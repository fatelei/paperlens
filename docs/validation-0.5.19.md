# 0.5.19 installation progress

The guide separates overall phases (environment, download/install, startup checks, ready) from the current task. Downloads show a per-file percentage; unknown-duration work and completed-file transitions use an indeterminate bar. Only successful startup and rendering checks mark the installation ready. Cancellation/failure stops the animation, and a fresh environment check clears stale completion state.

- Onboarding browser tests passed, including file percentage, completed-file transition, verification, subsequent file reset, cancellation and overall completion.
- Frontend unit tests: 74 passed.
- Go race regression suite passed.
- OCR download events now report the current file fraction instead of an aggregate fraction; engine extraction emits an explicit task message.
