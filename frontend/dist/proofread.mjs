import {applyContinuations} from './continuations.mjs';
import {acceptedCorrection,effectiveResult,validScore} from './correction.mjs';
// PDF-backed proofreading is separate from OCR. Scores always belong to raw OCR.
export function proofSignature(page){return JSON.stringify(page.regions.map(r=>[r.id,r.text,r.revision,r.category,r.reviewed,r.bbox,r.score,r.verdict,r.correction,r.error,r.manualEdited,r.reviewReopened,r.detailAudit]).concat([page.scanAudit,page.correctionThreshold]))}
const rectArea=b=>Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
function overlap(a,b){return Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]))}
export function readingOrder(items,gap=12){
 if(items.length<2)return items;
 for(const axis of [0,1]){
  const spans=items.map(r=>[r.bbox[axis],r.bbox[axis+2]]).sort((a,b)=>a[0]-b[0]);let end=spans[0][1];const gaps=[];
  for(const [start,stop] of spans.slice(1)){if(start-end>gap)gaps.push([start-end,(start+end)/2]);end=Math.max(end,stop)}
  if(gaps.length){const cut=(axis===0?gaps.sort((a,b)=>b[0]-a[0]):gaps)[0][1];const first=items.filter(r=>r.bbox[axis+2]<=cut),last=items.filter(r=>r.bbox[axis+2]>cut);if(first.length&&last.length)return [...readingOrder(first,gap),...readingOrder(last,gap)]}
 }
 return [...items].sort((a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0]);
}
function textLines(items){
 const sorted=[...items].sort((a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0]),lines=[];
 for(const item of sorted){const h=item.bbox[3]-item.bbox[1];let line=lines.find(l=>Math.abs(l.y-item.bbox[1])<Math.max(2,Math.min(h,l.h)*.4));if(!line){line={y:item.bbox[1],h,items:[]};lines.push(line)}line.items.push(item)}
 return lines.sort((a,b)=>a.y-b.y).map(l=>l.items.sort((a,b)=>a.bbox[0]-b.bbox[0]).map((r,i,arr)=>{if(!i)return r.text;const prev=arr[i-1],gap=r.bbox[0]-prev.bbox[2];const space=gap>Math.max(1,(r.bbox[3]-r.bbox[1])*.12)&&!/[\s]$/.test(prev.text)&&!/^\s/.test(r.text);return(space?' ':'')+r.text}).join('').trim()).filter(Boolean);
}
function referenceText(items,label){
 // Preserve lines in code, diagrams and tables; normal prose rejoins wrapped words.
 const lines=textLines(items);const code=lines.some(l=>/^\s*(#|SELECT |CREATE |WHERE |GROUP BY|ORDER BY|INSERT INTO)/.test(l));
 const multiline=code||/figure|table|formula/.test(label||'')||lines.some(l=>/^[•●–−]/.test(l));
 return (multiline?lines.join('\n'):lines.join('\n').replace(/([A-Za-z])-\n([a-z])/g,'$1$2').replace(/\n/g,' ')).normalize('NFKC').trim();
}
const comparable=s=>s.normalize('NFKC').replace(/\s+/g,' ').trim();
export function proofreadPage(page){
 const signature=proofSignature(page),source=page.reference;
 const unavailable=reason=>page.proof={status:'unavailable',reason,signature,text:'',changes:[],source:'none'};
 if(!source&&page.scanAudit)return scanProof(page,signature);
 if(!source)return unavailable('旧文档没有保存 PDF 文字层，请重新导入同一份 PDF 补充。');
 if(source.status!=='ready')return scanProof(page,signature);
 const regions=page.regions.filter((r,i)=>r.auto||(i===0&&!r.aggregate));
 if(!regions.length||regions.some(r=>!r.text.trim()||r.error))return unavailable('识别尚未完成，请先完成所有区域。');
 const assignments=regions.map(()=>[]),extras=[];
 for(const item of source.items){
  let best=-1,ratio=0;
  regions.forEach((r,i)=>{const value=overlap(item.bbox,r.bbox)/Math.max(1,rectArea(item.bbox));if(value>ratio){ratio=value;best=i}});
  if(best>=0&&ratio>.45)assignments[best].push(item);else extras.push(item);
 }
 const changes=[],parts=[];let unresolved=0;
 regions.forEach((r,i)=>{
  const reference=referenceText(assignments[i],r.layoutLabel||r.category),edited=!!r.manualEdited||!!r.reviewed||(!!r.originalText&&r.text!==r.originalText);
  // An explicit user edit takes priority over automatic proofreading.
  const corrected=edited?r.text:reference||r.text;
  if((!reference||r.reviewReopened)&&!r.reviewed){unresolved++;}
  if(edited&&r.originalText!==undefined&&comparable(corrected)!==comparable(r.originalText))changes.push({regionId:r.id,bbox:r.bbox,before:r.originalText,after:corrected,kind:'replace',basis:r.reviewed?'人工修改并确认':'人工修改（尚未复核）'});
  else if(comparable(corrected)!==comparable(r.text))changes.push({regionId:r.id,bbox:r.bbox,before:r.text,after:corrected,kind:'replace',basis:'PDF 文字层'});
  parts.push({bbox:r.bbox,text:corrected,source:edited?'manual':reference?'pdf':'ocr',regionId:r.id,humanReviewed:!!r.reviewed});
 });
 // Keep text outside detector boxes: headers, captions, small labels, missed paragraphs.
 const lines=[];
 for(const item of extras){let line=lines.find(l=>Math.abs(l.bbox[1]-item.bbox[1])<Math.max(3,(item.bbox[3]-item.bbox[1])*.4));if(!line){line={bbox:[...item.bbox],items:[]};lines.push(line)}line.items.push(item);line.bbox=[Math.min(line.bbox[0],item.bbox[0]),Math.min(line.bbox[1],item.bbox[1]),Math.max(line.bbox[2],item.bbox[2]),Math.max(line.bbox[3],item.bbox[3])]}
 for(const line of lines){const text=referenceText(line.items,'figure');if(text){parts.push({bbox:line.bbox,text,source:'pdf'});changes.push({bbox:line.bbox,before:'',after:text,kind:'insert',basis:'PDF 文字层：分区外的内容'})}}
 // Page numbers must not split the whitespace between two columns.
 const footer=parts.filter(p=>p.bbox[1]>page.height*.94&&/^\d+$/.test(p.text));const body=parts.filter(p=>!footer.includes(p));
 const ordered=[...readingOrder(body,Math.max(8,page.width*.006)),...footer];
 return page.proof={status:unresolved?'partial':'ready',reason:unresolved?`${unresolved} 个区域没有对应 PDF 文字，保留原 OCR 待复核。`:'依据 PDF 文字层自动校对，未覆盖原始 OCR 或沿用其评分。',source:'pdf-text-layer',signature,text:ordered.map(p=>p.text).join('\n\n'),changes,unresolved,parts:ordered};
}
export function currentProof(page){if(!page.proof||(page.proof.source==='local-retry'&&page.proof.strategyVersion!==2)||page.proof.signature!==proofSignature(page))return proofreadPage(page);return page.proof}
export function documentProof(doc){return applyContinuations(doc,doc.pages.map((p,i)=>({page:i+1,...currentProof(p)})),Math.max(.9,...doc.pages.map(p=>p.correctionThreshold??.9)));}
export function exportProof(doc,format){
 const pages=documentProof(doc);
 if(pages.some(p=>p.status==='unavailable'))throw new Error('部分页面无法自动校对。请补充原 PDF 或完成识别；也可切换为原始 OCR 导出。');
 if(format==='json')return JSON.stringify({schema:'paperlens-proof/1',name:doc.name,pages,continuationAudits:doc.continuationAudits||[]},null,2);
 return pages.map(p=>`${format==='md'?'## ':'—— '}第 ${p.page} 页${format==='md'?'':' ——'}\n${p.status==='partial'?'[部分区域未自动校对，保留 OCR]\n':''}\n${p.text}`).join('\n\n');
}
export async function extractReference(pdfPage,viewport,pdfjs){
 try{
  const [content,ops]=await Promise.all([pdfPage.getTextContent(),pdfPage.getOperatorList()]);
  const hidden=ops.fnArray.some((op,i)=>op===pdfjs.OPS.setTextRenderingMode&&[3,7].includes(ops.argsArray[i][0]));
  if(hidden)return {status:'unavailable',reason:'检测到隐藏文字层（可能是扫描 OCR 层），不自动据此改字。',items:[]};
  const items=content.items.filter(r=>r.str?.trim()).map(item=>{
   const t=pdfjs.Util.transform(viewport.transform,item.transform),h=Math.hypot(t[2],t[3]),w=Math.abs(item.width*viewport.scale),angle=Math.atan2(t[1],t[0]);
   const ux=Math.cos(angle),uy=Math.sin(angle),vx=Math.sin(angle),vy=-Math.cos(angle);
   const pts=[[t[4],t[5]],[t[4]+w*ux,t[5]+w*uy],[t[4]+h*vx,t[5]+h*vy],[t[4]+w*ux+h*vx,t[5]+w*uy+h*vy]];
   return {text:item.str.normalize('NFKC'),bbox:[Math.min(...pts.map(p=>p[0])),Math.min(...pts.map(p=>p[1])),Math.max(...pts.map(p=>p[0])),Math.max(...pts.map(p=>p[1]))]};
  });
  const all=items.map(r=>r.text).join('');if(all.length<5||/[\uFFFD\u0000]/.test(all))return {status:'unavailable',reason:'文字层为空或含乱码，保留 OCR 待复核。',items:[]};
  return {status:'ready',items};
 }catch{return {status:'unavailable',reason:'读取 PDF 文字层失败，保留 OCR 待复核。',items:[]}}
}

function scanProof(page,signature){
 const regions=page.regions.filter((r,i)=>r.auto||(i===0&&!r.aggregate)),threshold=page.correctionThreshold??.9;
 if(!page.scanAudit||regions.some(r=>!r.text.trim()||r.error))return page.proof={status:'unavailable',reason:'请运行自动校对：重新识别低分段落并检查漏分区。',signature,text:'',changes:[],source:'local-retry'};
 let unresolved=0;const changes=[],parts=[];
 for(const r of regions){const manual=!!r.manualEdited||!!r.reviewed||(!!r.originalText&&r.text!==r.originalText),c=manual?null:acceptedCorrection(r),result=effectiveResult(r);if(!r.reviewed&&(r.reviewReopened||!validScore(result)||result.score<threshold))unresolved++;
  if(manual&&r.originalText!==undefined&&r.text!==r.originalText)changes.push({regionId:r.id,bbox:r.bbox,before:r.originalText,after:r.text,kind:'replace',basis:r.reviewed?'人工修改并确认':'人工修改（尚未复核）'});
  if(c&&c.text!==r.text)changes.push({regionId:r.id,bbox:r.bbox,before:r.text,after:c.text,kind:'replace',basis:c.partial?(c.detail?'小块核验支持的标点修正（其余内容仍待复核）':'独立核验通过的末尾遗漏片段（原区域仍待复核）'):'重识别 + 本地 Jev 再核验',score:c.score});
  if(r.recovered)changes.push({regionId:r.id,bbox:r.bbox,before:'',after:result.text,kind:'insert',basis:'分块版面检测补回',score:result.score});
  parts.push({bbox:r.bbox,text:result.text,regionId:r.id,source:manual?'manual':c?'local-retry':'ocr',humanReviewed:!!r.reviewed,score:validScore(result)?result.score:null});
 }
 const ordered=readingOrder(parts,Math.max(8,page.width*.006));const incomplete=page.scanAudit.status!=='complete';
 return page.proof={signature,strategyVersion:2,status:unresolved||incomplete?'partial':'ready',source:'local-retry',changes,parts:ordered,unresolved,text:ordered.map(p=>p.text).join('\n\n'),reason:`本地重识别与 Jev 再核验；${unresolved} 个区域仍待复核。${incomplete?'漏分区检查未完成。':''}模型评分不保证逐字正确或完全无遗漏。`};
}
