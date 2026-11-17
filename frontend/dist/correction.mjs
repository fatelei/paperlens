// Candidate text and its score are bound to the exact original region revision.
export const regionKey=r=>JSON.stringify([r.text,r.revision,r.category,r.bbox]);
export const validScore=x=>x?.verdict==='scored'&&Number.isFinite(x.score)&&x.score>=0&&x.score<=1;
export function acceptedCorrection(r){return r.correction?.key===regionKey(r)&&r.correction.accepted&&(!r.correction.parts||r.correction.strategyVersion===2)?r.correction:null}
export function effectiveResult(r){if(r.manualEdited||r.reviewed||(r.originalText&&r.text!==r.originalText))return r;const c=acceptedCorrection(r);const result=c?{...r,text:c.text,...(c.partial?{}:{score:c.score,verdict:'scored'})}:r;return detailPending(r)?{...result,score:null,verdict:'unverified'}:result}
export async function correctRegion(r,{recognize,verify,current=()=>true,cancelled=()=>false,threshold=.9,onAttempt=()=>{}}){
 const key=regionKey(r),fresh=()=>current()&&regionKey(r)===key&&!cancelled();
 if(acceptedCorrection(r)?.score>=threshold)return;
 if(r.manualEdited||r.reviewed||(r.originalText&&r.text!==r.originalText))return;
 if(validScore(r)&&r.score>=threshold)return;
 const record=r.correction?.key===key?{...r.correction,attempts:[...r.correction.attempts]}:{key,accepted:false,attempts:[],threshold};
 if(record.strategyVersion!==2&&record.attempts.length>=3){record.previousSplitAttempts=[...(record.previousSplitAttempts||[]),...record.attempts.slice(2)];record.attempts=record.attempts.slice(0,2);record.accepted=false;}record.strategyVersion=2;
 for(let attempt=record.attempts.length;attempt<3;attempt++){
  if(!fresh())return;
  onAttempt(attempt);
  try{
   const candidate=await recognize(attempt);if(!fresh())return;
   if(!candidate.text?.trim())throw Error('重识别没有返回文字');
   const score=await verify(candidate.text,candidate);if(!fresh())return;
   record.attempts.push({text:candidate.text,score:score.score,verdict:score.verdict,variant:attempt,parts:score.parts});
   if(validScore(score)&&score.score>=threshold&&(!validScore(r)||score.score>=r.score+.02)){
    Object.assign(record,{accepted:true,text:score.replacementText||candidate.text,partial:!!score.partial,score:score.score,model:candidate.model,verificationModel:'MiniCPM-OCR-Jev-Q8_0',parts:score.parts});break;
   }
  }catch(e){if(!fresh())return;record.attempts.push({variant:attempt,error:String(e?.message||e)})}
 }
 if(fresh())r.correction=record;
}
export function uncoveredRegions(existing,candidates){
 const area=b=>Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);const out=[];
 for(const r of candidates){const a=r.bbox;if(!a||area(a)<16)continue;
  const overlaps=[...existing,...out].some(p=>{const b=p.bbox;const intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));return intersection/Math.max(1,Math.min(area(a),area(b)))>.15});
  if(!overlaps)out.push(r);
 }return out;
}

export const detailPending=r=>r.detailAudit?.key===regionKey(r)&&(!r.detailAudit.accepted||r.detailAudit.partial);
export async function auditDetails(r,{refine,current=()=>true,cancelled=()=>false,version=1}){
 const key=regionKey(r),fresh=()=>current()&&!cancelled()&&regionKey(r)===key&&!r.manualEdited&&!r.reviewed;
 if(!fresh()||(r.originalText&&r.text!==r.originalText)||r.detailAudit?.key===key&&r.detailAudit.version===version&&!r.detailAudit.error)return;
 try{
  const result=await refine();if(!fresh())return;
  r.detailAudit={...result,key,version};
  if(result.accepted&&validScore(result)&&result.text?.trim())r.correction={key,strategyVersion:2,accepted:true,text:result.text,score:result.score,parts:result.parts,partial:!!result.partial,attempts:r.correction?.attempts||[],detail:true};
  else r.detailAudit.accepted=false;
 }catch(e){if(fresh())r.detailAudit={key,version,accepted:false,error:true,reason:String(e?.message||e)}}
}
