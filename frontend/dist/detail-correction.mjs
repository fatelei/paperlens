// Evidence comes only from the current document, never from a domain answer list.
export const isCode=text=>/\b(?:SELECT\s|CREATE\s+TABLE|INSERT\s+INTO|GROUP\s+BY|ORDER\s+BY)\b/i.test(text);
export function wordEvidence(texts){return new Set(texts.join('\n').match(/[A-Za-z]+(?:-[A-Za-z]+)*/g)?.map(w=>w.toLowerCase())||[])}
export function joinCandidates(text,words){
 if(isCode(text))return null;
 const candidate=text.replace(/\b([A-Za-z]{2,})-\s*([a-z]{2,})\b/g,(all,a,b)=>{
  const joined=(a+b).toLowerCase(),hyphen=(a+'-'+b).toLowerCase();
  return (words.has(joined)||words.has(joined+'s'))&&!words.has(hyphen+'s')?a+b:all;
 });
 return candidate===text?null:candidate;
}
export function detailRequired(r,words){return ['text','page'].includes(r.category)&&(isCode(r.text)||r.layoutLabel==='figure'||!!joinCandidates(r.text,words))}
// Extract visible glyph groups, including punctuation and isolated digits. Long
// plot rules are removed from the working mask only; OCR always uses original pixels.
export function detailBoxes(width,height,rgba,{figure=false}={}){
 if(width*height>4_000_000)throw Error('细节图像超过 400 万像素，请框选较小区域');
 const mask=new Uint8Array(width*height);
 for(let i=0;i<mask.length;i++)mask[i]=(rgba[i*4]+rgba[i*4+1]+rgba[i*4+2])/3<180?1:0;
 if(figure){
  const erased=new Uint8Array(mask.length);
  for(const axis of [0,1]){const len=axis?height:width,count=axis?width:height;
   for(let q=0;q<count;q++){let start=-1;for(let p=0;p<=len;p++){const k=axis?p*width+q:q*width+p;
    if(p<len&&mask[k]){if(start<0)start=p}else if(start>=0){if(p-start>Math.max(50,len*.18))for(let n=start;n<p;n++)erased[axis?n*width+q:q*width+n]=1;start=-1;}
   }}
  }
  for(let i=0;i<mask.length;i++)if(erased[i])mask[i]=0;
 }
 const components=[],stack=[];
 for(let k=0;k<mask.length;k++){
  if(!mask[k])continue;mask[k]=0;stack.push(k);let x1=width,y1=height,x2=0,y2=0,n=0;
  while(stack.length){const v=stack.pop(),x=v%width,y=Math.floor(v/width);x1=Math.min(x1,x);y1=Math.min(y1,y);x2=Math.max(x2,x+1);y2=Math.max(y2,y+1);n++;
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=width||yy>=height)continue;const t=yy*width+xx;if(mask[t]){mask[t]=0;stack.push(t)}}
  }
  if(n>=2&&(!figure||((x2-x1)<width*.2&&(y2-y1)<height*.22)))components.push({x1,y1,x2,y2});
 }
 if(!components.length)return [];
 const heights=components.map(c=>c.y2-c.y1).filter(h=>h>=5).sort((a,b)=>a-b),typical=heights[Math.floor(heights.length/2)]||10;
 if(components.length>12000)throw Error('图像噪点过多，保留待复核');
 const rows=[];
 // Tall glyphs establish baselines first; dots/underscores then join their row.
 for(const c of components.sort((a,b)=>(b.y2-b.y1)-(a.y2-a.y1))){
  let row=rows.find(r=>Math.min(r.y2,c.y2)-Math.max(r.y1,c.y1)>0&&Math.abs((r.y1+r.y2-c.y1-c.y2)/2)<typical*.8);
  if(!row){row={y1:c.y1,y2:c.y2,items:[]};rows.push(row)}row.items.push(c);row.y1=Math.min(row.y1,c.y1);row.y2=Math.max(row.y2,c.y2);
 }
 const boxes=[];
 for(const row of rows.sort((a,b)=>a.y1-b.y1)){
  let group=[];const flush=()=>{if(!group.length)return;const b=[Math.min(...group.map(c=>c.x1)),Math.min(...group.map(c=>c.y1)),Math.max(...group.map(c=>c.x2)),Math.max(...group.map(c=>c.y2))];if(b[3]-b[1]>=typical*.45)boxes.push([Math.max(0,b[0]-2),Math.max(0,b[1]-2),Math.min(width,b[2]+2),Math.min(height,b[3]+2)]);group=[]};
  for(const c of row.items.sort((a,b)=>a.x1-b.x1)){if(figure&&group.length&&c.x1-group.at(-1).x2>typical*2.8)flush();group.push(c)}flush();
 }
 // Large noisy figures are left for review instead of unbounded inference.
 return boxes.length<=80?boxes:[];
}
export function detailVersion(words,threshold){let hash=2166136261;for(const c of [...words].sort().join('|'))hash=Math.imul(hash^c.charCodeAt(0),16777619);return `1:${threshold}:${hash>>>0}`}
// Only transfer independently verified letter-to-letter SQL identifier separators.
// Digits, operators, quotes and the remaining source characters must match exactly.
export function patchVerifiedDetails(source,parts,threshold=.9){
 let text=source;
 for(const part of parts){
  if(part.verdict!=='scored'||!Number.isFinite(part.score)||part.score<threshold||part.score>1)continue;
  const candidate=part.text.trim();if(candidate.length<12)continue;
  let pattern='';
  for(let i=0;i<candidate.length;i++){
   const ch=candidate[i];
   if((ch==='.'||ch==='_')&&/[A-Za-z]/.test(candidate[i-1]||'')&&/[A-Za-z]/.test(candidate[i+1]||'')){pattern+='[._\\s]*';continue;}
   pattern+=/\s/.test(ch)?'\\s+':ch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  }
  const matches=[...text.matchAll(new RegExp(pattern,'g'))];if(matches.length===1)text=text.slice(0,matches[0].index)+candidate+text.slice(matches[0].index+matches[0][0].length);
 }
 return text;
}
