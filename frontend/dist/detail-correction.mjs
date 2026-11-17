// Evidence comes only from the current document, never from a domain answer list.
export const isCode=text=>/^\s*(?:SELECT\s|CREATE\s+TABLE|INSERT\s+INTO|GROUP\s+BY|ORDER\s+BY)\b/im.test(text);
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
 for(let i=0;i<mask.length;i++){const rgb=[rgba[i*4],rgba[i*4+1],rgba[i*4+2]];mask[i]=rgb.reduce((a,b)=>a+b,0)/3<180&&(!figure||Math.max(...rgb)-Math.min(...rgb)<40)?1:0;}
 {
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
  if(n>=2&&(x2-x1)<width*.8&&(y2-y1)<Math.max(40,height*.22))components.push({x1,y1,x2,y2});
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
  for(const c of row.items.sort((a,b)=>a.x1-b.x1)){if(figure&&group.length&&c.x1-group.at(-1).x2>(row.y1>height*.78?Math.max(typical*2.8,width*.1):typical*2.8))flush();group.push(c)}flush();
 }
 // Large noisy figures are left for review instead of unbounded inference.
 return boxes.length<=80?boxes:[];
}
export function detailVersion(words,threshold){let hash=2166136261;for(const c of [...words].sort().join('|'))hash=Math.imul(hash^c.charCodeAt(0),16777619);return `4:${threshold}:${hash>>>0}`}
// Only transfer independently verified letter-to-letter SQL identifier separators.
// Digits, operators, quotes and the remaining source characters must match exactly.
// SQL literals and comments are protected: whitespace inside strings is data.
export function sqlSurface(text){
 const mask=new Uint8Array(text.length);let plain='',protectedText='';
 if(/\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$|\/\*/.test(text))return {mask,signature:null};
 const flush=()=>{protectedText+=plain.replace(/\s+/g,' ');plain='';};
 for(let i=0;i<text.length;){
  if(text[i]==='#'||text.slice(i,i+2)==='--'){flush();let j=text.indexOf('\n',i);if(j<0)j=text.length;else j++;mask.fill(1,i,j);protectedText+='⟦'+JSON.stringify(text.slice(i,j).replace(/[ \t]+/g,' '))+'⟧';i=j;continue;}
  if(/["'`]/.test(text[i])){flush();const quote=text[i];let j=i+1,closed=false;for(;j<text.length;j++){if(text[j]==='\\'){j++;continue;}if(text[j]===quote){if(text[j+1]===quote){j++;continue;}j++;closed=true;break;}}if(!closed)return {mask,signature:null};mask.fill(1,i,j);protectedText+='⟦'+JSON.stringify(text.slice(i,j))+'⟧';i=j;continue;}
  plain+=text[i++];
 }flush();return {mask,signature:protectedText.trim()};
}
export function sameCode(a,b){const x=sqlSurface(a).signature,y=sqlSurface(b).signature;return x!==null&&y!==null&&x===y;}
export function patchVerifiedDetails(source,parts,threshold=.9){
 let text=source;
 if(sqlSurface(source).signature===null)return source;
 for(const part of parts){
  if(part.verdict!=='scored'||!Number.isFinite(part.score)||part.score<threshold||part.score>1)continue;
  const candidate=(part.tokenEvidence?.text||part.text).trim();if(candidate.length<(part.tokenEvidence?3:12))continue;
  const protectedCandidate=sqlSurface(candidate);if(protectedCandidate.signature===null)continue;
  const pieces=[];
  for(let i=0;i<candidate.length;i++){
   if(/\s/.test(candidate[i])&&!protectedCandidate.mask[i]){while(i+1<candidate.length&&/\s/.test(candidate[i+1])&&!protectedCandidate.mask[i+1])i++;pieces.push({separator:false,pattern:'\\s+'});continue;}
   const ch=candidate[i],separator=!protectedCandidate.mask[i]&&(ch==='.'||ch==='_')&&/[A-Za-z]/.test(candidate[i-1]||'')&&/[A-Za-z]/.test(candidate[i+1]||'');
   pieces.push({separator,ch,pattern:separator?'[._\\s]*':ch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')});
  }
  const pattern=pieces.map(p=>'('+p.pattern+')').join(''),matches=[...text.matchAll(new RegExp('(?<![A-Za-z0-9_])'+pattern+'(?![A-Za-z0-9_])','g'))];
  if(matches.length!==1)continue;
  const m=matches[0];if(sqlSurface(text).mask[m.index])continue;
  const replacement=pieces.map((p,i)=>p.separator?p.ch:m[i+1]).join('');
  text=text.slice(0,m.index)+replacement+text.slice(m.index+m[0].length);
 }
 return text;
}

export function supportedJoin(candidate,parts){
 if(!candidate)return false;
 const normalize=t=>t.replace(/\s+/g,' ').trim();
 const reread=parts.map(p=>p.text).join('\n').replace(/([A-Za-z])-\n([a-z])/g,'$1$2');
 return normalize(reread)===normalize(candidate);
}

export function joinReread(parts,words){return parts.map(p=>p.text).join('\n').replace(/([A-Za-z]+)-\n([a-z]+)/g,(_,a,b)=>words.has((a+b).toLowerCase())||words.has((a+b+'s').toLowerCase())?a+b:a+'-'+b).replace(/\n/g,' ')}
export function sqlPunctuationCandidates(text,source){
 const aliases=new Set([...source.matchAll(/\b([A-Za-z][\w]*)\.[A-Za-z_][\w]*/g)].map(m=>m[1]));
 let result=text;if(!/^\s*(SELECT|GROUP BY|ORDER BY)\b/i.test(text))return [];
 for(const alias of aliases){result=result.replace(new RegExp('\\b'+alias+'\\s+([A-Za-z_][\\w]*)(?=,|;|\\s*(?:FROM|DESC|ASC|$))','g'),(all,field)=>/^(FROM|ASC|DESC)$/i.test(field)?all:alias+'.'+field)}
 return result===text?[]:[result];
}
export function patchVerifiedScales(source,parts,threshold=.9){
 const numeric=t=>/^\s*\d+(?:[,.]\d+)*(?:\s+\d+(?:[,.]\d+)*){3,}\s*$/.test(t);
 const lines=source.split('\n'),uniqueParts=parts.filter((p,i)=>p.bbox&&parts.findIndex(q=>JSON.stringify(q.bbox)===JSON.stringify(p.bbox))===i),candidates=uniqueParts.filter(p=>p.verdict==='scored'&&p.score>=threshold&&p.score<=1&&numeric(p.text)).map(p=>p.text.trim().split(/\s+/));
 const replacements=new Map();
 for(const line of lines){if(!numeric(line))continue;const original=line.trim().split(/\s+/);const supporting=candidates.filter(a=>!lines.some(l=>l.trim().split(/\s+/).join(' ')===a.join(' '))&&a.length===original.length+1&&(a.slice(1).join(' ')===original.join(' ')||a.slice(0,-1).join(' ')===original.join(' ')));const occurrences=lines.filter(l=>l.trim().split(/\s+/).join(' ')===original.join(' ')).length;
  if(supporting.length===occurrences&&supporting.every(a=>a.join(' ')===supporting[0].join(' ')))replacements.set(line,supporting[0].join(' '));
 }
 return lines.map(l=>replacements.get(l)||l).join('\n');
}

// Only a physical line-ending hyphen may be joined. Every reread line must
// independently pass, and the resulting text must differ only by such joins.
export function verifiedLineJoin(source,parts,words,threshold=.9){
 if(isCode(source)||parts.length<2||parts.some(p=>p.verdict!=='scored'||!Number.isFinite(p.score)||p.score<threshold||p.score>1))return null;
 let result=source,changed=false;
 for(let i=0;i<parts.length-1;i++){
  const a=parts[i],b=parts[i+1],left=a.text.match(/([A-Za-z]{2,})-$/),right=b.text.match(/^([a-z]{2,})/);
  if(!left||!right||!a.bbox||!b.bbox)continue;
  const ah=a.bbox[3]-a.bbox[1],bh=b.bbox[3]-b.bbox[1],gap=b.bbox[1]-a.bbox[3];
  const overlap=Math.min(a.bbox[2],b.bbox[2])-Math.max(a.bbox[0],b.bbox[0]);
  if(gap<0||gap>Math.max(ah,bh)*1.5||overlap<Math.min(a.bbox[2]-a.bbox[0],b.bbox[2]-b.bbox[0])*.5)continue;
  const word=left[1]+right[1];if(!words.has(word.toLowerCase())&&!words.has(word.toLowerCase()+'s'))continue;
  const pattern=new RegExp('\\b'+left[1]+'-\\s*'+right[1]+'\\b','g'),matches=[...result.matchAll(pattern)];
  if(matches.length!==1)continue;
  result=result.replace(pattern,word);changed=true;
 }
 const norm=t=>t.replace(/\s+/g,' ').trim();
 return changed&&norm(result)===norm(joinReread(parts,words))?result:null;
}

// Split widely spaced numeric ticks using original ink columns, never inferred
// arithmetic. Each detected group is reread independently before any transfer.
export function numericTickBoxes(width,height,rgba){
 if(width*height>100000||height<3)return [];
 const rowInk=Array.from({length:height},(_,y)=>{let n=0;for(let x=0;x<width;x++){const k=(y*width+x)*4;if((rgba[k]+rgba[k+1]+rgba[k+2])/3<180)n++;}return n;});
 const peak=Math.max(...rowInk),active=rowInk.map((n,y)=>n>=Math.max(3,peak*.25)?y:-1).filter(y=>y>=0);if(!active.length)return [];
 const top=active[0],bottom=active.at(-1)+1;
 const spans=[];let start=-1,last=-1;
 for(let x=0;x<width;x++){
  let ink=false;for(let y=top;y<bottom;y++){const k=(y*width+x)*4;if((rgba[k]+rgba[k+1]+rgba[k+2])/3<180){ink=true;break}}
  if(ink){if(start<0)start=x;else if(x-last>Math.max(4,height*.8)){spans.push([start,last+1]);start=x}last=x;}
 }
 if(start>=0)spans.push([start,last+1]);
 return spans.length>=4&&spans.length<=20?spans.map(([a,b])=>[Math.max(0,a-1),top,Math.min(width,b+1),bottom]):[];
}
export function verifiedNumericRow(candidate,parts,threshold=.9){
 const expected=candidate.trim().split(/\s+/);
 if(expected.length<4||expected.length!==parts.length||parts.some((p,i)=>p.verdict!=='scored'||!Number.isFinite(p.score)||p.score<threshold||p.score>1||!/^\d+(?:[,.]\d+)*$/.test(p.text.trim())||p.text.trim()!==expected[i]))return null;
 return parts.map(p=>p.text.trim()).join(' ');
}

export function numericEvidenceResult(part,evidence,threshold=.9){
 const passed=!!verifiedNumericRow(part.text,evidence,threshold);
 return {...part,tickEvidence:evidence,rowScore:part.rowScore??part.score,tickConflict:!passed,score:passed?Math.min(...evidence.map(p=>p.score)):null,verdict:passed?'scored':'unverified',imageTransform:'independent-numeric-ticks'};
}
