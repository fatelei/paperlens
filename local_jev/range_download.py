"""Bounded parallel HTTP ranges; persist only the contiguous verified prefix."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import re
import math
import time
import urllib.request


def download_ranges(url, part, progress, chunk_size=8 * 1024 * 1024):
    request = urllib.request.Request(url, headers={"Range": "bytes=0-0", "Accept-Encoding": "identity"})
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status == 200:
            return False  # Server does not support ranges: retain sequential fallback.
        match = re.fullmatch(r"bytes 0-0/(\d+)", response.headers.get("Content-Range", ""))
        if response.status != 206 or not match:
            raise RuntimeError("Invalid download range probe")
        if len(response.read(2)) != 1:
            raise RuntimeError("Invalid download range probe body")
        total = int(match[1])
    if total < chunk_size * 4:
        return False
    if part.is_symlink():
        raise RuntimeError("Unsafe partial download path")
    offset = part.stat().st_size if part.exists() else 0
    if offset > total:
        raise RuntimeError("Partial download exceeds remote file size")

    def fetch(start, end):
        expected = f"bytes {start}-{end}/{total}"
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"})
                with urllib.request.urlopen(req, timeout=60) as response:
                    if response.status != 206 or response.headers.get("Content-Range") != expected:
                        raise RuntimeError("Wrong download range; partial file retained")
                    data = response.read(end - start + 2)
                    if len(data) != end - start + 1:
                        raise OSError("Incomplete download range")
                    return data
            except (OSError, TimeoutError):
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)

    started = time.monotonic()
    received = offset
    spans = iter((start, min(start + chunk_size, total) - 1) for start in range(offset, total, chunk_size))
    pool = ThreadPoolExecutor(max_workers=4)
    pending = deque()
    def submit_next():
        span = next(spans, None)
        if span is not None:
            pending.append(pool.submit(fetch, *span))
    try:
        for _ in range(4):
            submit_next()
        with part.open("ab") as output:
            while pending:
                data = pending.popleft().result()
                output.write(data)
                output.flush()
                received += len(data)
                speed = (received - offset) / max(time.monotonic() - started, 0.001)
                minutes = (total - received) / max(speed, 1) / 60
                eta = "当前文件下载完成，接下来校验" if received == total else f"当前文件约剩 {max(1, math.ceil(minutes))} 分钟"
                progress(f"4 路下载 {part.name.removesuffix('.part')} · {received / 1048576:.0f}/{total / 1048576:.0f} MB · {speed / 1048576:.1f} MB/s · {eta}", received / total)
                submit_next()
    finally:
        for future in pending:
            future.cancel()
        pool.shutdown(wait=True, cancel_futures=True)
    return True
