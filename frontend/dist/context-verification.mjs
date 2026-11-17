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

// Large prose already provides context; scaling it can distort verifier layout.
// Use one geometry-based policy, never choose an input by its returned score.
export const normalizeVerificationImage=(whole,code,height)=>code||(whole?height<100:height<40);

export function statementContexts(parts,code=false){
 const groups=[];let start=0;
 const emit=end=>{const lines=parts.slice(start,end);groups.push({start,end,lines,bbox:[Math.min(...lines.map(p=>p.bbox[0])),Math.min(...lines.map(p=>p.bbox[1])),Math.max(...lines.map(p=>p.bbox[2])),Math.max(...lines.map(p=>p.bbox[3]))]});start=end;};
 for(let i=0;i<parts.length;i++){
  const a=parts[i],b=parts[i+1];if(!a.bbox)return [];
  if(b){const h=Math.max(a.bbox[3]-a.bbox[1],b.bbox[3]-b.bbox[1]);if(b.bbox[1]<=a.bbox[1]||Math.abs(b.bbox[0]-a.bbox[0])>h*3)return [];}
  const gap=b?b.bbox[1]-a.bbox[3]:Infinity,h=a.bbox[3]-a.bbox[1];
  if(code){if(!b||gap>h*.8)emit(i+1);}
  else{const text=parts.slice(start,i+1).map(p=>p.text).join(' '),open=(text.match(/“/g)||[]).length>(text.match(/”/g)||[]).length;
   if(!b||gap>h*1.5||(i-start>=2&&!open&&!/[A-Za-z]-$/.test(a.text)))emit(i+1);
  }
 }return groups;
}
export function alignedCode(text,parts){
 if(!parts.length||!sameCode(text,parts.map(p=>p.text).join('\n')))return text;
 const widths=parts.filter(p=>p.text.trim().length>10).map(p=>(p.bbox[2]-p.bbox[0])/p.text.trim().length).sort((a,b)=>a-b);if(!widths.length)return text;
 const unit=widths[Math.floor(widths.length/2)],left=Math.min(...parts.map(p=>p.bbox[0]));if(!(unit>0))return text;
 const aligned=parts.map((p,i)=>{const gap=i?p.bbox[1]-parts[i-1].bbox[3]:0,blank=gap>(p.bbox[3]-p.bbox[1])*.8?'\n':'';return blank+' '.repeat(Math.min(16,Math.max(0,Math.round((p.bbox[0]-left)/unit))))+p.text.trim();}).join('\n');
 return sameCode(text,aligned)?aligned:text;
}
