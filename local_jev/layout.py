"""Local layout detection. Receives PNG base64 on stdin, emits JSON only."""
import base64, io, json, sys
from contextlib import redirect_stdout
from PIL import Image

def ordered(items):
    if len(items)<2:return items
    # Recursive whitespace cuts: full-width headings first, then independent columns.
    for axis in (0,1):
        spans=sorted((r['bbox'][axis],r['bbox'][axis+2]) for r in items)
        end=spans[0][1];gaps=[]
        for start,stop in spans[1:]:
            if start-end>8:gaps.append((start-end,(start+end)/2))
            end=max(end,stop)
        if gaps:
            _,cut=max(gaps) if axis==0 else gaps[0]
            left=[r for r in items if r['bbox'][axis+2]<=cut]
            right=[r for r in items if r not in left]
            if left and right:return ordered(left)+ordered(right)
    return sorted(items,key=lambda r:(r['bbox'][1],r['bbox'][0]))

def disjoint(a,existing):
    area=max(1,(a[2]-a[0])*(a[3]-a[1]))
    for r in existing:
        b=r['bbox'];intersection=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
        if intersection/max(1,min(area,(b[2]-b[0])*(b[3]-b[1])))>.15:return False
    return True

def detect(image):
    from rapid_layout import RapidLayout
    engine=RapidLayout(model_type='doclayout_docstructbench',conf_thresh=.25)
    res=engine(image)
    w,h=image.size;regions=[]
    for box,label,score in zip(res.boxes,res.class_names,res.scores):
        x1,y1,x2,y2=map(float,box)
        box=[max(0,int(x1)-3),max(0,int(y1)-3),min(w,int(x2)+4),min(h,int(y2)+4)]
        if box[2]<=box[0] or box[3]<=box[1]:continue
        category='table' if label=='table' else 'formula' if label=='isolate_formula' else 'text'
        regions.append({'bbox':box,'category':category,'label':str(label),'confidence':float(score)})
    # Remove near-identical detections, never silently discard small text or page numbers.
    kept=[]
    for r in sorted(regions,key=lambda r:-r['confidence']):
        a=r['bbox'];area=(a[2]-a[0])*(a[3]-a[1])
        if any(max(0,min(a[2],b['bbox'][2])-max(a[0],b['bbox'][0]))*max(0,min(a[3],b['bbox'][3])-max(a[1],b['bbox'][1]))/max(area,(b['bbox'][2]-b['bbox'][0])*(b['bbox'][3]-b['bbox'][1]))>.9 for b in kept):continue
        kept.append(r)
    # A second pass at larger relative scale finds small paragraphs missed by the
    # whole-page detector. Only spatially disjoint boxes are admitted; cropped
    # fragments crossing tile edges are rejected to avoid partial duplicates.
    recovered=[]
    for ox,oy,x2,y2 in [(0,0,int(w*.58),int(h*.58)),(int(w*.42),0,w,int(h*.58)),(0,int(h*.42),int(w*.58),h),(int(w*.42),int(h*.42),w,h)]:
        tile=engine(image.crop((ox,oy,x2,y2)))
        for box,label,score in zip(tile.boxes,tile.class_names,tile.scores):
            if float(score)<.4:continue
            a,b,c,d=map(float,box)
            if (ox and a<5) or (oy and b<5) or (x2<w and c>x2-ox-5) or (y2<h and d>y2-oy-5):continue
            bbox=[max(0,int(a)+ox-3),max(0,int(b)+oy-3),min(w,int(c)+ox+4),min(h,int(d)+oy+4)]
            if not disjoint(bbox,kept+recovered):continue
            category='table' if label=='table' else 'formula' if label=='isolate_formula' else 'text'
            recovered.append({'bbox':bbox,'category':category,'label':str(label),'confidence':float(score),'recovered':True})
    kept+=recovered
    if not kept:raise ValueError('未检测到版面区域，请检查图片清晰度')
    if len(kept)>120:raise ValueError('页面区域超过 120 个，请拆分页面')
    return {'regions':ordered(kept),'model':'DocLayout-YOLO-docstructbench','width':w,'height':h,'coverageChecked':True}

if __name__=='__main__':
    raw=sys.stdin.read(32*1024*1024+1)
    if len(raw)>32*1024*1024:raise ValueError('image too large')
    image=Image.open(io.BytesIO(base64.b64decode(raw))).convert('RGB')
    with redirect_stdout(sys.stderr):result=detect(image)
    print(json.dumps(result))
