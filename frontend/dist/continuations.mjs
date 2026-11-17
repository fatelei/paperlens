import {regionKey,effectiveResult} from './correction.mjs';
import {isCode} from './detail-correction.mjs';
const manual=r=>r.manualEdited||r.reviewed||r.reviewReopened||(r.originalText&&r.originalText!==r.text);
const textOf=r=>effectiveResult(r).text;
const scoreOK=(v,t)=>Number.isFinite(v)&&v>=t&&v<=1;
export function continuationCandidate(doc,fromPage,left,toPage,right,words){
 const p=doc.pages[fromPage],q=doc.pages[toPage];
 if(!p||!q||manual(left)||manual(right)||!left.auto||!right.auto||left.category!=='text'||right.category!=='text'||/figure|table|caption|title/.test((left.layoutLabel||'')+(right.layoutLabel||'')))return null;
 const a=textOf(left),b=textOf(right);if(isCode(a)||isCode(b))return null;
 const tail=a.match(/([A-Za-z]{2,})-\s*$/),head=b.match(/^([a-z]{2,})\s+/);if(!tail||!head)return null;
 const word=tail[1]+head[1],hyphen=tail[1]+'-'+head[1];if(words.has(hyphen.toLowerCase()))return null;
 // Only true column/page boundaries, not arbitrary nearby paragraph pairs.
 if(left.bbox[3]<p.height*.75||right.bbox[1]>q.height*.25)return null;
 if(toPage===fromPage){if(left.bbox[0]>=p.width*.5||right.bbox[0]<=p.width*.5)return null;}
 else if(toPage!==fromPage+1||right.bbox[0]>=q.width*.5)return null;
 return {fromPage,toPage,leftId:left.id,rightId:right.id,leftKey:regionKey(left),rightKey:regionKey(right),beforeLeft:a,beforeRight:b,afterLeft:a.slice(0,tail.index)+word,afterRight:b.slice(head[0].length),word,hyphen,lexicalEvidence:words.has(word.toLowerCase())};
}
export function acceptedContinuation(doc,a,threshold=.9){
 const left=doc.pages[a.fromPage]?.regions.find(r=>r.id===a.leftId),right=doc.pages[a.toPage]?.regions.find(r=>r.id===a.rightId);
 const extra=a.extra;const extraOK=a.lexicalEvidence!==false||!!(extra&&extra.verdict==='scored'&&extra.alternativeVerdict==='scored'&&scoreOK(extra.score,threshold)&&scoreOK(extra.alternativeScore,0)&&extra.score>=extra.alternativeScore+.05&&extra.expected?.trim()&&extra.reread?.replace(/\s+/g,' ').trim()===extra.expected.replace(/\s+/g,' ').trim());
 return !!(extraOK&&a.accepted&&left&&right&&!manual(left)&&!manual(right)&&regionKey(left)===a.leftKey&&regionKey(right)===a.rightKey&&textOf(left)===a.beforeLeft&&textOf(right)===a.beforeRight&&a.verdict==='scored'&&a.alternativeVerdict==='scored'&&scoreOK(a.score,threshold)&&scoreOK(a.alternativeScore,0)&&a.score>=a.alternativeScore+.05&&typeof a.expected==='string'&&a.expected.trim()&&a.reread?.replace(/\s+/g,' ').trim()===a.expected.replace(/\s+/g,' ').trim());
}
export function applyContinuations(doc,pages,threshold=.9){
 const result=pages.map(p=>({...p,parts:p.parts?.map(x=>({...x})),changes:[...(p.changes||[])]})),used=new Set();
 for(const a of doc.continuationAudits||[]){if(!acceptedContinuation(doc,a,threshold))continue;
  const p=result[a.fromPage],q=result[a.toPage],l=p?.parts?.find(x=>x.regionId===a.leftId),r=q?.parts?.find(x=>x.regionId===a.rightId);
  if(!l||!r||l.text!==a.beforeLeft||r.text!==a.beforeRight||used.has(a.leftId)||used.has(a.rightId))continue;
  for(const [page,part,before,after] of [[p,l,a.beforeLeft,a.afterLeft],[q,r,a.beforeRight,a.afterRight]]){part.text=after;part.sourceScore=part.score;part.score=null;part.source="local-continuation";part.continuation={score:a.score,word:a.word,fromPage:a.fromPage+1,toPage:a.toPage+1};page.changes.push({regionId:part.regionId,bbox:part.bbox,before,after,kind:'replace',basis:'跨栏/跨页断词：两端原图复读及 Jev 对比核验',score:a.score});page.text=page.parts.map(x=>x.text).join('\n\n');}
  used.add(a.leftId);used.add(a.rightId);
 }return result;
}

export const checkedRequest=(request,cancelled)=>async(...args)=>{if(cancelled())throw Error("已取消");const result=await request(...args);if(cancelled())throw Error("已取消");return result;};
