"""PaperLens local-only supervisor around OpenBMB's unmodified render+score SDK."""
import os, sys, json, time, signal, subprocess, urllib.request, secrets
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
TOKEN = os.environ.get('PAPERLENS_LOCAL_JEV_TOKEN', '')
if not TOKEN:
    raise SystemExit('Missing local session token')
# A manifest is created by the installer; no user credential is stored in it.
manifest = json.loads((ROOT / 'runtime.json').read_text())
node = Path(manifest['node'])
os.environ['PATH'] = str(node.parent) + os.pathsep + os.environ.get('PATH', '')
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(ROOT / 'browsers')
os.environ['JEV_BACKEND_CONFIG'] = str(ROOT / 'service/sdk/backends/llamacpp.yaml')
os.environ['JEV_BACKEND_URL'] = 'http://127.0.0.1:18519'
os.environ['RM_RENDER_BROWSERS'] = '1'
os.environ['RM_BROWSER_CONCURRENCY'] = '1'
os.environ['RM_MAX_ITEMS'] = '1'
os.environ['RM_WORK_ROOT'] = str(ROOT / 'work')
os.environ['RM_KEEP_WORK'] = '0'
os.environ['PYTHONPYCACHEPREFIX'] = str(ROOT / 'pycache')
(ROOT / 'work').mkdir(exist_ok=True)
engine = ROOT / 'engine' / ('llama-server.exe' if os.name == 'nt' else 'llama-server')
args = [str(engine), '-m', str(ROOT / 'models/MiniCPM-OCR-Jev-Q8_0.gguf'),
        '--mmproj', str(ROOT / 'models/mmproj-model-f16.gguf'), '-ngl',
        '0' if os.environ.get('PAPERLENS_JEV_CPU') == '1' else '99',
        '-c', '32768', '-np', '1', '--host', '127.0.0.1', '--port', '18519',
        '--alias', 'MiniCPM-OCR-Jev', '--api-key', TOKEN, '--no-webui', '--no-slots']
proc = subprocess.Popen(args, cwd=engine.parent)

def stop(*_):
    if proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=8)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
try:
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if proc.poll() is not None: raise RuntimeError('Jev engine exited before ready')
        try:
            with urllib.request.urlopen('http://127.0.0.1:18519/health', timeout=2) as r:
                if r.status == 200: break
        except Exception: time.sleep(1)
    else: raise RuntimeError('Jev engine load timeout')
    sys.path.insert(0, str(ROOT / 'service/sdk'))
    from jev_score.backends.llamacpp_backend import LlamaCppBackend
    original_init = LlamaCppBackend.__init__
    def authenticated_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self._client.headers['Authorization'] = 'Bearer ' + TOKEN
        # Local inference must not use environment HTTP proxies.
    LlamaCppBackend.__init__ = authenticated_init
    from playwright.async_api import Browser
    original_context = Browser.new_context
    async def offline_context(self, *args, **kwargs):
        kwargs['service_workers'] = 'block'
        ctx = await original_context(self, *args, **kwargs)
        async def offline(route):
            if route.request.url.startswith(('http:', 'https:')): await route.abort()
            else: await route.continue_()
        await ctx.route('**/*', offline)
        return ctx
    Browser.new_context = offline_context
    from app import app
    from fastapi.responses import JSONResponse
    @app.middleware('http')
    async def local_auth(request, call_next):
        if request.url.path != '/healthz' and not secrets.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + TOKEN):
            return JSONResponse({'detail': 'Local session authentication required'}, status_code=401)
        if request.method == 'POST' and int(request.headers.get('content-length','0')) > 32*1024*1024:
            return JSONResponse({'detail':'Request too large'}, status_code=413)
        return await call_next(request)
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=18520, access_log=False)
finally:
    if proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=8)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
