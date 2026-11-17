"""Install PaperLens local MiniCPM-OCR-Jev (Python 3.12+ and Node.js required).
Run from the delivered source: python3 local_jev/install.py
"""
import hashlib, json, os, platform, shutil, subprocess, sys, tarfile, tempfile, urllib.request, zipfile
from pathlib import Path

if sys.version_info < (3,12): raise SystemExit('Python 3.12+ is required')
node=shutil.which('node')
if not node: raise SystemExit('Install Node.js from nodejs.org before continuing')
if sys.platform=='darwin': base=Path.home()/'Library/Application Support'
elif os.name=='nt': base=Path(os.environ['APPDATA'])
else: base=Path(os.environ.get('XDG_CONFIG_HOME',str(Path.home()/'.config')))
root=base/'PaperLens/local-jev';root.mkdir(parents=True,exist_ok=True)
source=Path(__file__).resolve().parent/'service'
if not source.is_dir():raise SystemExit('The service directory must accompany install.py')

def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(8*1024*1024),b''):h.update(b)
 return h.hexdigest()

def download(url,path,sha):
 if path.exists() and digest(path)==sha: print('Already verified:',path.name,flush=True);return
 path.parent.mkdir(parents=True,exist_ok=True);part=path.with_name(path.name+'.part');offset=part.stat().st_size if part.exists() else 0
 # A completed temporary file can survive a previous interrupted rename.
 if offset and digest(part)==sha:os.replace(part,path);return
 req=urllib.request.Request(url,headers={'Range':f'bytes={offset}-'} if offset else {})
 print('Downloading',path.name,flush=True)
 with urllib.request.urlopen(req,timeout=180) as r:
  if r.status==206:
   if not r.headers.get('Content-Range','').startswith(f'bytes {offset}-'):raise RuntimeError('Wrong download range')
  elif r.status==200:offset=0
  else:raise RuntimeError('Download failed')
  with part.open('ab' if offset else 'wb') as f:
   while b:=r.read(4*1024*1024):f.write(b)
 if digest(part)!=sha:raise RuntimeError('Checksum mismatch: '+path.name+'; remove the .part file and retry')
 os.replace(part,path)

models=[('MiniCPM-OCR-Jev-Q8_0.gguf','7e5227dd810ab20c56076750cb8eeb9bbe3ea52d1b84263975ba64566e30a746'),('mmproj-model-f16.gguf','cad9364b900f79a90c12e371aa07a7cb901966c9f673262379c31b051eeb313a')]
for name,sha in models:download('https://modelscope.cn/models/OpenBMB/MiniCPM-OCR-Jev-gguf/resolve/master/'+name,root/'models'/name,sha)
if sys.platform=='darwin' and platform.machine()=='arm64': archive='llama-b12435-bin-macos-arm64.tar.gz';sha='c62449b40acb484b0ada743906fc494f2f3941d5c3ed099c6eb2f6269d4f0b06'
elif os.name=='nt' and platform.machine().lower() in ('amd64','x86_64'):archive='llama-b12435-bin-win-cpu-x64.zip';sha='c186d52379d7b1c269667ff61c6a8677bcc4e1866c460d3fbbf236674fbc8203'
else:raise SystemExit('This installer currently supports macOS arm64 and Windows x64')
download('https://github.com/ggml-org/llama.cpp/releases/download/b12435/'+archive,root/archive,sha)
with tempfile.TemporaryDirectory() as tmp:
 if archive.endswith('.zip'):
  with zipfile.ZipFile(root/archive) as z:
   for name in z.namelist():
    if Path(name).is_absolute() or '..' in Path(name).parts:raise RuntimeError('Unsafe archive path')
   z.extractall(tmp)
 else:
  with tarfile.open(root/archive) as t:t.extractall(tmp,filter='data')
 executable=next(Path(tmp).rglob('llama-server.exe' if os.name=='nt' else 'llama-server'))
 shutil.copytree(executable.parent,root/'engine',symlinks=True,dirs_exist_ok=True)
shutil.copytree(source,root/'service',dirs_exist_ok=True)
subprocess.run([sys.executable,'-m','venv',str(root/'venv')],check=True)
python=root/'venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
subprocess.run([str(python),'-m','pip','install','-r',str(root/'service/requirements.txt'),'-r',str(root/'service/sdk/requirements-score.txt')],check=True)
subprocess.run([str(python),'-m','playwright','install','chromium'],env={**os.environ,'PLAYWRIGHT_BROWSERS_PATH':str(root/'browsers')},check=True)
(root/'runtime.json').write_text(json.dumps({'version':'0.2.0','node':node,'engine':'b12435','sdkCommit':'f5357c72e1605698fa857d74222c0414ca369ae3'}))
print('Installed. In PaperLens, select Start verification model. Runtime:',root)

subprocess.run([str(python),'-m','pip','install','rapid-layout==1.2.1','onnxruntime>=1.20,<2'],check=True)
subprocess.run([str(python),'-c',"from rapid_layout import RapidLayout; RapidLayout(model_type='doclayout_docstructbench')"],check=True)
