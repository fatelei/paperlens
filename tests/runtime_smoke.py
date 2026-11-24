"""Opt-in integration check with PaperLens-managed Python and Node."""
import sys
import shutil
from pathlib import Path
work=Path(sys.argv[1]);work.mkdir(parents=True,exist_ok=True)
source=Path(__file__).resolve().parents[1]/'local_jev/service'
# Match the installed SDK layout, outside the frontend package's ESM scope.
service=work/'service'
shutil.copytree(source,service,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__'))
sys.path.insert(0,str(service))
from PIL import Image,ImageDraw
from rapid_layout import RapidLayout
from rm_render import Candidate,render_candidates
original=work/'original.png'
image=Image.new('RGB',(600,160),'white')
ImageDraw.Draw(image).text((20,30),'PaperLens runtime check: SQL x = 1',fill='black')
image.save(original)
layout=RapidLayout(model_type='doclayout_docstructbench');layout(image)
results=render_candidates([
 Candidate('text',str(original),'PaperLens runtime check: SQL x = 1','text'),
 Candidate('formula',str(original),r'x^2 + 1','formula')
],work_dir=work/'render',browser_concurrency=1)
for result in results:
 assert result.ok and Path(result.render_image_path).is_file(),result
 assert not result.katex_errors,result
print('PASS: private runtime layout inference, Node precheck, Chromium text and formula rendering')
