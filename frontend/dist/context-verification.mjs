import {isCode,patchVerifiedDetails,sameCode} from './detail-correction.mjs';
// Formatting used for verification only; copied/exported text stays unchanged.
export function verificationCandidate(text,code=false){
 if(code){const fence='`'.repeat(Math.max(3,...(text.match(/`+/g)||[]).map(x=>x.length+1)));return fence+'text\n'+text+'\n'+fence;}
 return text.replace(/^([ \t]*)([-+*])(?=\s)/gm,'$1\\$2');
}
export const sameText=(a,b)=>a.replace(/\s+/g,' ').trim()===b.replace(/\s+/g,' ').trim();
export function lineContexts(parts){
 if(parts.length<2)return [];
 for(let i=1;i<parts.length;i++){const a=parts[i-1].bbox,b=parts[i].bbox;if(!a||!b)return [];const h=Math.max(a[3]-a[1],b[3]-b[1]);if(b[1]<a[1]||b[1]-a[3]>h*1.5||Math.min(a[2],b[2])-Math.max(a[0],b[0])<Math.min(a[2]-a[0],b[2]-b[0])*.5)return [];}
 const groups=[];for(let i=0;i<parts.length;){let n=parts.length-i===3?3:Math.min(2,parts.length-i);if(i+n<parts.length&&/[A-Za-z]-$/.test(parts[i+n-1].text)&&/^[a-z]/.test(parts[i+n].text))n++;const lines=parts.slice(i,i+n);groups.push({start:i,end:i+n,lines,bbox:[Math.min(...lines.map(p=>p.bbox[0])),lines[0].bbox[1],Math.max(...lines.map(p=>p.bbox[2])),lines.at(-1).bbox[3]]});i+=n;}return groups;
}
export function contextPasses(groups,partCount,threshold=.9){let next=0;for(const g of groups){if(g.start!==next||g.end<=g.start||!g.matches||g.verdict!=='scored'||!Number.isFinite(g.score)||g.score<threshold||g.score>1)return false;next=g.end;}return groups.length>0&&next===partCount;}

export const textAuditAllowed=r=>['text','page'].includes(r.category);

export function verifiedCodeText(source,parts,threshold=.9){
 if(!isCode(source)||!parts.length||parts.some(p=>p.tokenEvidence||p.verdict!=='scored'||!Number.isFinite(p.score)||p.score<threshold||p.score>1))return null;
 const candidate=parts.map(p=>p.text).join('\n'),safe=patchVerifiedDetails(source,parts,threshold);
 return sameCode(candidate,safe)?safe:null;
}
