# 0.5.17 download acceleration

Jev installation now downloads large range-capable files with four concurrent requests (8 MiB each). Only a contiguous prefix is appended to the existing `.part` file. A source without range support retains the sequential path, and the complete file must still pass its pinned SHA-256 check.

Progress includes downloaded/total size, average transfer speed and estimated remaining minutes for the current file. Actual acceleration depends on the network and server limits.

- Local HTTP tests passed: resume from a non-aligned prefix, ignored ranges, wrong Content-Range, and a failed middle range followed by successful resume.
- Complete Go race suite passed.
- Small live ModelScope probe: 8 MiB took 15.54 seconds with one request and 10.69 seconds with four; the alternate official source was not faster.
- The user's existing 800 MiB partial model was retained when switching to the new app.
