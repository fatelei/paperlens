"""Install PaperLens local MiniCPM-OCR-Jev (Python 3.12+ and Node.js required).
Run from the delivered source: python3 local_jev/install.py
"""
import hashlib, json, os, platform, shutil, subprocess, sys, tarfile, tempfile, time, urllib.request, zipfile
from pathlib import Path
from range_download import download_ranges

if sys.version_info < (3,12): raise SystemExit('Python 3.12+ is required')
node=os.environ.get('PAPERLENS_NODE') or shutil.which('node')
if not node: raise SystemExit('Missing render runtime; use the PaperLens setup guide')
if os.environ.get('PAPERLENS_MANAGED_RUNTIME') == '1':
 from pip._vendor import certifi
 os.environ.setdefault('SSL_CERT_FILE', certifi.where())
 os.environ.setdefault('REQUESTS_CA_BUNDLE', certifi.where())
if sys.platform=='darwin': base=Path.home()/'Library/Application Support'
elif os.name=='nt': base=Path(os.environ['APPDATA'])
else: base=Path(os.environ.get('XDG_CONFIG_HOME',str(Path.home()/'.config')))
root=Path(os.environ.get('PAPERLENS_DATA_DIR', str(base/'PaperLens')))/'local-jev';root.mkdir(parents=True,exist_ok=True)
(root/'runtime.json').unlink(missing_ok=True)
def progress(message,percent=0):
 print('PAPERLENS_PROGRESS '+json.dumps({'message':message,'percent':percent},ensure_ascii=False),flush=True)
progress('正在检查核验模型文件…')
source=Path(__file__).resolve().parent/'service'
if not source.is_dir():raise SystemExit('The service directory must accompany install.py')

def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(8*1024*1024),b''):h.update(b)
 return h.hexdigest()

def download(url,path,sha):
 if path.exists() and digest(path)==sha: progress('已校验：'+path.name,1);return
 path.parent.mkdir(parents=True,exist_ok=True);part=path.with_name(path.name+'.part');
 if part.is_symlink():raise RuntimeError('Unsafe partial download path')
 offset=part.stat().st_size if part.exists() else 0
 # A completed temporary file can survive a previous interrupted rename.
 if offset and digest(part)==sha:os.replace(part,path);return
 if download_ranges(url,part,progress):
  progress('正在校验 '+path.name+'，下载已完成，安装尚未结束…')
  if digest(part)!=sha:
   part.unlink(missing_ok=True);raise RuntimeError('Checksum mismatch: '+path.name+'; retry to download again')
  os.replace(part,path);return
 req=urllib.request.Request(url,headers={'Range':f'bytes={offset}-'} if offset else {})
 progress('正在下载 '+path.name+'（支持断点续传）')
 with urllib.request.urlopen(req,timeout=180) as r:
  if r.status==206:
   if not r.headers.get('Content-Range','').startswith(f'bytes {offset}-'):raise RuntimeError('Wrong download range')
  elif r.status==200:offset=0
  else:raise RuntimeError('Download failed')
  total=int(r.headers.get('Content-Length','0'))+offset;received=offset;last=0
  with part.open('ab' if offset else 'wb') as f:
   while b:=r.read(4*1024*1024):
    f.write(b);received+=len(b)
    if time.monotonic()-last>=1:
     progress('下载 '+path.name+' · '+str(round(received/1048576))+' MB',received/total if total else 0);last=time.monotonic()
 progress('正在校验 '+path.name+'，下载已完成，安装尚未结束…')
 if digest(part)!=sha:
  part.unlink(missing_ok=True);raise RuntimeError('Checksum mismatch: '+path.name+'; retry to download again')
 os.replace(part,path)

def replace_engine(source, target):
 # An interrupted copy must be retryable, including macOS dylib symlinks.
 # Only this app-owned engine directory is replaced; model downloads stay intact.
 if target.is_symlink():raise RuntimeError('Unsafe engine directory')
 if target.exists():shutil.rmtree(target)
 shutil.copytree(source,target,symlinks=True)

models=[('MiniCPM-OCR-Jev-Q8_0.gguf','7e5227dd810ab20c56076750cb8eeb9bbe3ea52d1b84263975ba64566e30a746'),('mmproj-model-f16.gguf','cad9364b900f79a90c12e371aa07a7cb901966c9f673262379c31b051eeb313a')]
for name,sha in models:download('https://modelscope.cn/models/OpenBMB/MiniCPM-OCR-Jev-gguf/resolve/master/'+name,root/'models'/name,sha)
if sys.platform=='darwin' and platform.machine()=='arm64': archive='llama-b12435-bin-macos-arm64.tar.gz';sha='c62449b40acb484b0ada743906fc494f2f3941d5c3ed099c6eb2f6269d4f0b06'
elif os.name=='nt' and platform.machine().lower() in ('amd64','x86_64'):archive='llama-b12435-bin-win-cpu-x64.zip';sha='c186d52379d7b1c269667ff61c6a8677bcc4e1866c460d3fbbf236674fbc8203'
else:raise SystemExit('This installer currently supports macOS arm64 and Windows x64')
download('https://github.com/ggml-org/llama.cpp/releases/download/b12435/'+archive,root/archive,sha)
progress('正在安装核验推理引擎…')
with tempfile.TemporaryDirectory() as tmp:
 if archive.endswith('.zip'):
  with zipfile.ZipFile(root/archive) as z:
   for name in z.namelist():
    if Path(name).is_absolute() or '..' in Path(name).parts:raise RuntimeError('Unsafe archive path')
   z.extractall(tmp)
 else:
  with tarfile.open(root/archive) as t:t.extractall(tmp,filter='data')
 executable=next(Path(tmp).rglob('llama-server.exe' if os.name=='nt' else 'llama-server'))
 replace_engine(executable.parent,root/'engine')
shutil.copytree(source,root/'service',dirs_exist_ok=True)
def prepare_environment(base_python, directory, managed=False):
 if directory.is_symlink():raise RuntimeError('Unsafe environment directory')
 python=directory/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
 if managed and directory.exists():
  expected=os.path.realpath(base_python)
  try:
   probe=subprocess.run([str(python),'-I','-c','import os,sys; print(os.path.realpath(sys._base_executable))'],capture_output=True,text=True,timeout=20)
   same=probe.returncode==0 and os.path.normcase(probe.stdout.strip())==os.path.normcase(expected)
  except (OSError,subprocess.TimeoutExpired):same=False
  if not same:shutil.rmtree(directory)
 if not python.exists():subprocess.run([str(base_python),'-m','venv',str(directory)],check=True)
 if subprocess.run([str(python),'-m','pip','--version'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
  subprocess.run([str(python),'-m','ensurepip','--upgrade'],check=True)
 return python

progress('正在准备应用专用核验环境…')
python=prepare_environment(sys.executable,root/'venv',os.environ.get('PAPERLENS_MANAGED_RUNTIME')=='1')
progress('正在安装核验依赖，可能需要几分钟…')
subprocess.run([str(python),'-m','pip','install','-r',str(root/'service/requirements.txt'),'-r',str(root/'service/sdk/requirements-score.txt')],check=True)
progress('正在安装本地渲染浏览器…')
subprocess.run([str(python),'-m','playwright','install','chromium'],env={**os.environ,'PLAYWRIGHT_BROWSERS_PATH':str(root/'browsers')},check=True)
progress('正在安装版面分析组件…')
subprocess.run([str(python),'-m','pip','install','rapid-layout==1.2.1','onnxruntime>=1.20,<2'],check=True)
progress('正在下载并检查版面分析模型…')
subprocess.run([str(python),'-c',"from rapid_layout import RapidLayout; RapidLayout(model_type='doclayout_docstructbench')"],check=True)

progress('正在检查浏览器、渲染与版面环境…')
check = """
import json,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from rapid_layout import RapidLayout
from rapid_layout.model_handler import ModelProcessor
from rapid_layout.utils.typings import ModelType
import fastapi, uvicorn, httpx, PIL
root=Path(sys.argv[1])
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    browser.close()
    browser_path=p.chromium.executable_path
layout=RapidLayout(model_type='doclayout_docstructbench')
(root/'layout-ready.json').write_text(json.dumps({'browser':browser_path,'layout':str(ModelProcessor.get_model_path(ModelType('doclayout_docstructbench'))),'ready':True}))
"""
subprocess.run([str(python),'-c',check,str(root)],env={**os.environ,'PLAYWRIGHT_BROWSERS_PATH':str(root/'browsers')},check=True)
manifest={'version':'0.4.0','python':sys.executable,'node':node,'engine':'b12435','sdkCommit':'f5357c72e1605698fa857d74222c0414ca369ae3'}
(root/'runtime.json.tmp').write_text(json.dumps(manifest))
os.replace(root/'runtime.json.tmp',root/'runtime.json')
progress('核验、浏览器与版面分析安装检查通过',1)
