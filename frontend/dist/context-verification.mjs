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

// Fixed evidence routing: passed rows stand on their own; only failed rows
// require their containing statement. Never average away a failing row.
export function completeTextEvidence(parts,contexts,threshold=.9){
 if(!parts.length||parts.some(p=>p.tokenEvidence||!p.text?.trim()||!Array.isArray(p.bbox)||p.bbox.length!==4||!p.bbox.every(Number.isFinite)))return null;
 if(!statementContexts(parts,true).length)return null;
 const passed=p=>p.verdict==='scored'&&Number.isFinite(p.score)&&p.score>=threshold&&p.score<=1;
 const evidence=[];
 for(let i=0;i<parts.length;i++){
  if(passed(parts[i])){evidence.push(parts[i].score);continue;}
  const groups=contexts.filter(g=>Number.isInteger(g.start)&&Number.isInteger(g.end)&&g.start>=0&&g.end<=parts.length&&g.start<=i&&g.end>i);
  if(groups.length!==1||!groups[0].matches||!passed(groups[0]))return null;
  evidence.push(groups[0].score);
 }
 return Math.min(...evidence);
}

// Check the original raster, before component filtering/removing rules. Even one
// unexplained dark pixel blocks automatic clearance (noise stays reviewable).
export function inkCoverage(width,height,rgba,boxes,{allowFrame=false}={}){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0||rgba.length!==width*height*4||!boxes.length)return {complete:false,uncovered:null};
 const mask=new Uint8Array(width*height);
 for(const b of boxes){if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[2]<=b[0]||b[3]<=b[1])return {complete:false,uncovered:null};for(let y=Math.max(0,Math.floor(b[1]));y<Math.min(height,Math.ceil(b[3]));y++)mask.fill(1,y*width+Math.max(0,Math.floor(b[0])),y*width+Math.min(width,Math.ceil(b[2])));}
 const dark=(x,y)=>(rgba[(y*width+x)*4]+rgba[(y*width+x)*4+1]+rgba[(y*width+x)*4+2])/3<180;
 let frame=null;
 if(allowFrame){
  const left=Math.floor(Math.min(...boxes.map(b=>b[0])))-4,right=Math.ceil(Math.max(...boxes.map(b=>b[2])))+4,top=Math.floor(Math.min(...boxes.map(b=>b[1])))-4,bottom=Math.ceil(Math.max(...boxes.map(b=>b[3])))+4;
  const xs=[],ys=[];
  for(let x=0;x<width;x++)if((x<left||x>right)&&Array.from({length:height},(_,y)=>dark(x,y)).filter(Boolean).length>=height*.95)xs.push(x);
  for(let y=0;y<height;y++)if((y<top||y>bottom)&&Array.from({length:width},(_,x)=>dark(x,y)).filter(Boolean).length>=width*.95)ys.push(y);
  const xl=xs.filter(x=>x<left),xr=xs.filter(x=>x>right),yt=ys.filter(y=>y<top),yb=ys.filter(y=>y>bottom);
  if([xl,xr,yt,yb].every(a=>a.length>0&&a.at(-1)-a[0]<=2)){
   const x1=xl[0],x2=xr.at(-1),y1=yt[0],y2=yb.at(-1);
   // Closed corners are mandatory: unrelated underlines and axes are not frames.
   if(Array.from({length:x2-x1+1},(_,i)=>x1+i).every(x=>dark(x,y1)&&dark(x,y2))&&Array.from({length:y2-y1+1},(_,i)=>y1+i).every(y=>dark(x1,y)&&dark(x2,y)))frame={x1,x2,y1,y2};
  }
 }
 let uncovered=0,ink=0,frameInk=0;for(let i=0;i<mask.length;i++)if((rgba[i*4]+rgba[i*4+1]+rgba[i*4+2])/3<180){ink++;if(!mask[i]){const x=i%width,y=Math.floor(i/width);if(frame&&x>=frame.x1-1&&x<=frame.x2+1&&y>=frame.y1-1&&y<=frame.y2+1&&(Math.abs(x-frame.x1)<=1||Math.abs(x-frame.x2)<=1||Math.abs(y-frame.y1)<=1||Math.abs(y-frame.y2)<=1))frameInk++;else uncovered++;}}
 return {complete:ink>frameInk&&uncovered===0,uncovered,ink,frameInk,frame};
}
