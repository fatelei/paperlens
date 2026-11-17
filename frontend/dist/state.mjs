import {effectiveResult} from './correction.mjs';
export function invalidate(region) {
 region.reviewReopened = false; region.score = null; region.verdict = 'unverified'; region.detail = ''; region.reviewed = false;
 region.revision = (region.revision || 0) + 1;
}
export function changeText(region, text) {
 if (region.text === text) return false;
 region.text = text; region.manualEdited = true; invalidate(region); return true;
}
export function scoreLabel(region, threshold) {
 if (region.reviewReopened && !region.reviewed) return {label:'已撤销复核 · 待复核',kind:'warning'};
 if (region.reviewed) return {label:'已人工复核',kind:'good'};
 if (region.verdict === 'scored' && Number.isFinite(region.score) && region.score >= 0 && region.score <= 1)
  return {label:`${region.score.toFixed(3)} · ${region.score < threshold ? '建议复核' : '较高一致性'}`,kind:region.score < threshold ? 'warning':'good'};
 if (region.verdict && region.verdict !== 'unverified') return {label:'核验未完成',kind:'error'};
 return {label:'未核验',kind:''};
}
export function exportDocument(doc, format) {
 const pages = doc.pages.map((page,index)=>({page:index+1,width:page.width,height:page.height,regions:page.regions.map(r=>({id:r.id,auto:!!r.auto,aggregate:!!r.aggregate,type:r.category,bbox:r.bbox,text:r.text,originalText:r.originalText||'',previousText:r.previousText||'',layoutLabel:r.layoutLabel||'',score:r.verdict==='scored'?r.score:null,verdict:r.verdict||'unverified',reviewed:!!r.reviewed,reviewReopened:!!r.reviewReopened,manualEdited:!!r.manualEdited,model:r.model||'',verificationModel:r.verificationModel||'',error:r.error||'',detail:r.detail||'',detailAudit:r.detailAudit||null}))}));
 if(format==='json')return JSON.stringify({schema:'paperlens/1',name:doc.name,exportedAt:new Date().toISOString(),pages},null,2);
 // Whole-page OCR is the canonical transcription. Crops are additional review
 // candidates, not automatic replacements without text alignment.
 return doc.pages.map((p,i)=>{
  const full=p.regions[0]?.text||'';
  const crops=p.regions.slice(1).filter(r=>!r.auto&&r.text.trim());
  const parts=[];
  if(doc.pages.length>1)parts.push(format==='md'?`## 第 ${i+1} 页`:`—— 第 ${i+1} 页 ——`);
  if(full)parts.push(full);
  for(let j=0;j<crops.length;j++)parts.push(`${format==='md'?'### ':''}区域摘录 ${j+1}（独立内容，未自动替换全文）\n${crops[j].text}`);
  return parts.join('\n\n');
 }).join('\n\n');
}
export function normalizedBox(start,end,width,height){
 const x=Math.max(0,Math.min(width,Math.min(start.x,end.x))),y=Math.max(0,Math.min(height,Math.min(start.y,end.y)));
 const right=Math.max(0,Math.min(width,Math.max(start.x,end.x))),bottom=Math.max(0,Math.min(height,Math.max(start.y,end.y)));
 return [Math.round(x),Math.round(y),Math.round(right),Math.round(bottom)];
}

export function migrateLocalScores(docs){for(const doc of docs)for(const page of doc.pages)for(const r of page.regions){if(r.verdict==='scored'&&r.verificationModel!=='MiniCPM-OCR-Jev-Q8_0'){r.score=null;r.verdict='unverified';r.detail='旧版核验结果已失效，请使用本地独立模型重新核验。'}}return docs}

export function needsReview(r,threshold=.9){
 if(r.aggregate||r.reviewed)return false;if(r.reviewReopened)return true;r=effectiveResult(r);if(r.error)return true;if(!r.text?.trim())return !!r.auto;
 return r.verdict!=='scored'||!Number.isFinite(r.score)||r.score<0||r.score>1||r.score<threshold;
}
export function reviewIssues(doc,threshold=.9){
 const issues=[];doc?.pages.forEach((p,page)=>p.regions.forEach((r,region)=>{if(needsReview(r,threshold))issues.push({page,region})}));return issues;
}

export function mergeSegments(page){
 const full=page.regions[0];if(!full.aggregate)return;
 full.text=page.regions.filter(r=>r.auto).map((r,i)=>r.text.trim()||`[第 ${i+1} 区尚未识别完成]`).join('\n\n');
 full.originalText=full.text;full.score=null;full.verdict='unverified';
}
