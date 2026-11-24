import {createOnboarding} from './onboarding.mjs';
import {continuationCandidate,acceptedContinuation,checkedRequest} from './continuations.mjs';
import {inkCoverage,completeTextEvidence,verificationCandidate,normalizeVerificationImage,statementContexts,alignedCode,sameText,lineContexts,contextPasses,textAuditAllowed,verifiedCodeText} from './context-verification.mjs';
import {wordEvidence,joinCandidates,detailBoxes,isCode,sameCode,detailRequired,detailVersion,patchVerifiedDetails,verifiedLineJoin,joinReread,sqlPunctuationCandidates,patchVerifiedScales,numericTickBoxes,numericEvidenceResult} from './detail-correction.mjs';
import {recordReview,lastReview,undoLastReview} from './review-history.mjs';
import {splitRaster} from './segments.mjs';
import {correctRegion,uncoveredRegions,acceptedCorrection,auditDetails,detailPending,regionKey} from './correction.mjs';
import {extractReference,currentProof as pageProof,documentProof,readingOrder,exportProof} from './proofread.mjs';
import {changeText,invalidate,scoreLabel,exportDocument,normalizedBox,migrateLocalScores,reviewIssues,needsReview,mergeSegments} from './state.mjs';
const $=id=>document.getElementById(id);
const state={docs:[],docId:null,page:0,region:0,settings:{threshold:.9},busy:false,importing:false,verifying:false,cancelled:false,cropping:false,zoom:1,db:null};
function currentProof(page){const doc=state.docs.find(d=>d.pages.includes(page));return doc?documentProof(doc)[doc.pages.indexOf(page)]:pageProof(page);}
const native=()=>window.go?.main?.App;
const call=(name,...args)=>{if(!native())return Promise.reject(new Error('请在 PaperLens 桌面应用中使用此功能'));return native()[name](...args)};
let toastTimer,saveTimer;
function notifyWork(message,tone='info'){state.ocrConnectionHint=false;const e=$('workflow-notice');e.hidden=false;e.dataset.tone=tone;$('workflow-message').textContent=message;}
function readableError(e){const text=String(e?.message||e);return /connection refused|Failed to fetch|ECONNREFUSED/i.test(text)?'本地模型服务未连接，请打开“模型与设置”启动对应模型，然后重试。':text}
function documentSummary(doc){
 const pages=doc?.pages||[],missing=pages.filter(p=>!p.regions.some(r=>!r.aggregate&&r.text?.trim())&&currentProof(p).status==='unavailable').length;
 const empty=pages.flatMap(p=>p.regions).filter(r=>r.auto&&!r.text?.trim()).length;
 const pageFailures=pages.filter(p=>p.processingError||p.scanAudit?.error).length;
 const failed=pageFailures+pages.flatMap(p=>p.regions).filter(r=>!r.aggregate&&(r.error||r.verdict==='request_error')).length;
 const pending=reviewIssues(doc,state.settings.threshold??.9).length;
 const hasText=pages.some(p=>p.regions.some(r=>!r.aggregate&&r.text?.trim())||($('output-version').value==='proof'&&currentProof(p).text?.trim()&&currentProof(p).status!=='unavailable'));
 return {missing,empty,failed,pending,hasText};
}
function finishDocument(doc,label){const q=documentSummary(doc);const text=`${doc.name} · ${label}：${q.missing} 页无结果，${q.empty} 段未识别，${q.failed} 处处理失败，${q.pending} 处待复核。`;
 notifyWork(text+(q.pending||q.missing||q.failed?'已完成的结果已保留，请处理待复核或继续识别未完成内容。':'可查看校对版并导出。'),q.pending||q.missing||q.failed?'warning':'success');return text;
}
function renderWorkflow(){const doc=activeDoc(),q=documentSummary(doc),busy=state.busy;
 const proofBlocked=doc&&$('output-version').value==='proof'&&doc.pages.some(p=>currentProof(p).status==='unavailable');
 const reason=!doc?'请先导入文档':busy?'任务处理中，请完成或取消后导出，避免导出不完整结果':!q.hasText?'尚无可导出的文字，请先识别或自动校对':proofBlocked?'部分页面尚无校对版，请完成识别和校对，或切换原始 OCR 导出当前文字':'';
 $('export').disabled=!!reason;$('export').title=reason;const copyReason=!doc?'请先导入文档':!q.hasText?'尚无可复制文字':proofBlocked?'校对版尚未完整，请切换原始 OCR 复制已有文字':'';$('all-copy').disabled=!!copyReason;$('all-copy').title=copyReason||(busy?'复制此刻已有文字，任务还在继续':'复制当前版本的完整文字');
 $('workflow-help').textContent=!doc?'导入 PDF 或图片 → 识别 → 查看待复核 → 导出':busy?'任务正在处理；核验和校对期间可以浏览文档。导出将在任务结束后恢复。':!q.hasText?'尚无文字结果：点击“识别全部页面”。自动校对也会先识别尚未处理的图片页。':`${q.missing} 页无结果 · ${q.empty} 段未识别 · ${q.pending} 处待复核。`+(proofBlocked?'部分页面尚无校对版，可切换“原始 OCR”导出已有文字。':'')+(q.missing||q.empty||q.pending?'导出会保留当前结果和未完成内容的提示，请留意遗漏。':'可导出当前选择的版本。');
 $('import').title=state.importing?'正在导入，请稍候':'导入 PDF、PNG、JPG 或 WebP（后台任务继续运行）';
 $('recognize-all').title=busy?'当前任务进行中':'继续识别尚未完成的页面和段落，保留已有文字及人工修改';
 $('recognize-all').textContent=busy?'任务处理中…':q.hasText&&(q.missing||q.empty||q.failed)?'继续识别未完成内容':'识别全部页面';
 $('auto-correct').disabled=busy;
 $('auto-correct').title=busy?'当前任务进行中':'检查遗漏区域并重识别低分段落；人工修改与人工确认的文字保留';
 $('attach-reference').disabled=state.importing||navigationLocked();
}
async function requireOCR(){const st=await checkEngine();if(!st.ready){notifyWork(st.running?'OCR 模型仍在加载，请等待就绪后再识别。':'OCR 未启动。请点击右侧“模型与设置”启动引擎后重试。','warning');state.ocrConnectionHint=true;return false}return true}

function toast(message){$('toast').textContent=String(message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500)}
function error(e){const message=readableError(e);toast(message);notifyWork(message,'error');$('status').textContent=message}
function activeDoc(){return state.docs.find(d=>d.id===state.docId)}
function activePage(){return activeDoc()?.pages[state.page]}
function activeRegion(){return activePage()?.regions[state.region]}
function id(){return crypto.randomUUID()}
function newRegion(width,height,category='page',bbox=[0,0,width,height]){return{id:id(),category,bbox,text:'',originalText:'',score:null,verdict:'unverified',reviewed:false,revision:0,error:''}}
async function loadDB(){
 return new Promise((resolve,reject)=>{const req=indexedDB.open('paperlens',1);req.onupgradeneeded=()=>req.result.createObjectStore('documents',{keyPath:'id'});req.onerror=()=>reject(req.error);req.onsuccess=()=>{state.db=req.result;const r=state.db.transaction('documents').objectStore('documents').getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error)}})
}
function persist(){
 if(!state.db)return;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{try{const tx=state.db.transaction('documents','readwrite');const store=tx.objectStore('documents');state.docs.forEach(d=>store.put(d));tx.onerror=()=>toast('本机存储失败，请及时导出文档');}catch(e){error(e)}},250)
}
function setBusy(busy,message='就绪'){
 state.busy=busy;if(settingsDraft)renderSettingsControls();document.body.classList.toggle('busy',busy);$('status').textContent=message;$('cancel').hidden=!busy;$('setup-cancel').hidden=!busy;
 ['sample','recognize','recognize-all','category','editor','verify','review','delete-region','crop'].forEach(x=>$(x).disabled=busy);
 if(!busy)render();else {renderReviewActions();renderWorkflow();}
}
async function runTask(fn,message){if(state.busy)return;state.cancelled=false;setBusy(true,message);notifyWork(message);let outcome='任务已结束，请查看结果';try{const result=await fn();if(typeof result==='string')outcome=result;if(state.cancelled){outcome='已取消，已完成的结果已保留';notifyWork(outcome,'warning')}}catch(e){outcome=readableError(e);error(e)}finally{setBusy(false,outcome);persist();renderLibrary()}}
function navigationLocked(){return state.busy&&!state.verifying&&!state.correcting}
function renderLibrary(){
 $('doc-count').textContent=state.docs.length;$('documents').replaceChildren();
 for(const doc of state.docs){const b=document.createElement('button');b.className='doc-item'+(doc.id===state.docId?' selected':'');b.innerHTML='<span class="file-icon">▤</span><span class="doc-info"><strong></strong><small></small></span>';b.querySelector('strong').textContent=doc.name;const done=doc.pages.filter(p=>p.regions.some(r=>!r.aggregate&&r.text?.trim())).length;b.querySelector('small').textContent=`${doc.pages.length} 页 · ${done?`${done} 页有结果`:'等待识别'}${reviewIssues(doc,state.settings.threshold??.9).length?' · 待复核 '+reviewIssues(doc,state.settings.threshold??.9).length:''}`;b.onclick=()=>{if(navigationLocked())return;state.docId=doc.id;state.page=0;state.region=0;state.zoom=1;render()};$('documents').append(b)}
}
function render(){
 const locked=navigationLocked();['import','dropzone'].forEach(id=>$(id).disabled=state.importing);$('sample').disabled=locked||state.importing;['crop','category','delete-region'].forEach(id=>$(id).disabled=locked);['recognize','recognize-all'].forEach(id=>$(id).disabled=state.busy);
 renderLibrary();const doc=activeDoc();$('empty').hidden=!!doc;$('workspace').hidden=!doc;$('all-copy').disabled=!doc;$('export').disabled=!doc;
 $('doc-title').textContent=doc?.name||'开始一份新文档';renderWorkflow();if(!doc)return;
 const page=activePage();$('pages-count').textContent=`${doc.pages.length} 页`;$('page-number').textContent=`${state.page+1} / ${doc.pages.length}`;$('page-prev').disabled=state.page===0||navigationLocked();$('page-next').disabled=state.page===doc.pages.length-1||navigationLocked();
 $('page-image').src=page.image;$('image-stage').style.width=`${state.zoom*100}%`;$('zoom-label').textContent=`${Math.round(state.zoom*100)}%`;
 const issues=reviewIssues(doc,state.settings.threshold??.9);$('task-summary').textContent=documentSummary(doc).hasText?`自动核验已开启 · ${issues.length} 处待复核`:'尚未识别 · 识别后自动核验';$('next-issue').disabled=navigationLocked()||!issues.length;
 renderResult();renderOverlays();renderProofStatus();
}
function renderResult(){
 const page=activePage(),region=activeRegion();if(!region)return;
 $('regions').replaceChildren();page.regions.forEach((r,i)=>{const b=document.createElement('button');b.textContent=(i===0?(r.aggregate?'全文':'整页'):(r.auto?`段落 ${i}`:`区域 ${i}`))+(r.auto&&!r.text.trim()?' · 未识别':needsReview(r,state.settings.threshold??.9)?' · 待复核':'');b.className=i===state.region?'selected':'';b.onclick=()=>selectReviewRegion(state.page,i,needsReview(r,state.settings.threshold??.9));$('regions').append(b)});
 const proofMode=$('output-version').value==='proof',proof=proofMode?currentProof(page):null;const shown=proofMode&&proof.status!=='unavailable'?(region.aggregate||region===page.regions[0]?proof.text:proof.parts?.find(p=>p.regionId===region.id)?.text??region.text):region.text;
 $('result-title').textContent=proofMode?'校对结果':'原始 OCR';$('editor-label').textContent=proofMode?'校对后的文字，只读':'识别文字，可直接编辑';$('editor').setAttribute('aria-label',proofMode?'校对后的文字，只读':'原始识别文字，可编辑');$('editor').value=shown;$('category').value=region.category;$('char-count').textContent=`${shown.length} 字符`;$('edit-state').textContent=proofMode?(proof.status==='unavailable'?'校对尚未完成 · 暂示原始 OCR':'校对版 · 切换原始 OCR 可编辑'):region.aggregate?'按阅读顺序合并 · 点击段落可编辑':region.reviewed?'已人工确认':region.originalText&&region.text!==region.originalText?'已修改 · 需重新核验':'可直接编辑';
 $('delete-region').hidden=proofMode||state.region===0;$('recognize').textContent=region.text?'重新识别':'开始识别';
 const continuation=proofMode?proof.parts?.find(p=>p.regionId===region.id)?.continuation:null;const corrected=proofMode?acceptedCorrection(region):null;const badge=continuation?{label:'断词局部核验通过',kind:needsReview(region,state.settings.threshold??.9)?'warning':'good'}:region.detailAudit?.key===regionKey(region)&&region.detailAudit.accepted&&region.detailAudit.evidenceMode==='complete-line-coverage'&&!region.manualEdited&&!region.reviewed?{label:'分行核验通过',kind:'good'}:detailPending(region)&&!region.manualEdited&&!region.reviewed?{label:'细节待复核',kind:'warning'}:corrected?{label:`${corrected.score.toFixed(3)} · ${corrected.partial?'部分细节已修正，仍待复核':corrected.parts?'分块最低分':'校对版已核验'}`,kind:corrected.partial?'warning':'good'}:region.aggregate?{label:'逐段核验',kind:''}:state.verifyingRegion===region&&state.verifyingRevision===region.revision?{label:'核验中…',kind:''}:scoreLabel(region,state.settings.threshold??.9);$('score-badge').textContent=badge.label;$('score-badge').className='badge '+badge.kind;
 $('score-detail').textContent=continuation?`跨栏/跨页合词 ${continuation.word} 已通过两端图像核验；只验证该断词，不沿用原段分数。原有待复核状态保留，任一端人工修改后取消拼接。`:region.detailAudit?.key===regionKey(region)&&region.detailAudit.accepted&&region.detailAudit.evidenceMode==='complete-line-coverage'&&!region.manualEdited&&!region.reviewed?region.detailAudit.reason:detailPending(region)&&!region.manualEdited&&!region.reviewed?(region.detailAudit.reason||'细节复读存在不一致，保留文字等待人工确认。'):corrected?(proofMode?'当前显示校对文字；点击「查看校对版」可查看修改前后对照。':'当前显示原始 OCR；切换校对版可查看修正文字。'):(region.aggregate?'全文按分区顺序合并；请选择段落查看独立评分。':'')||region.error||region.detail||(region.reviewed?'当前内容已由你标记为人工复核完成。':region.verdict==='scored'?'评分来自 Jev；请结合原图确认关键数字与文字。':region.category==='page'?'识别后自动核验。整页按文字一致性评分；表格、公式可框选后单独核验。':'核验在本机完成，图片与文字不会上传。');
 $('verify').disabled=proofMode||state.busy||region.aggregate||!region.text.trim();$('review').disabled=navigationLocked()||!region.text.trim();$('copy-current').disabled=!shown.trim()||(region.aggregate&&!page.regions.some(r=>!r.aggregate&&r.text.trim()));$('copy-current').title=shown.trim()?'复制当前显示的文字':'当前区域没有文字，请先识别';$('editor').disabled=navigationLocked();$('editor').readOnly=proofMode||navigationLocked()||!!region.aggregate;$('category').disabled=proofMode||navigationLocked()||!!region.aggregate;$('review').disabled=proofMode||navigationLocked()||!!region.aggregate||!region.text.trim();renderReviewActions();
}
function renderOverlays(){
 const page=activePage();if(!page)return;$('region-overlays').replaceChildren();page.regions.forEach((r,i)=>{if((r.auto&&!needsReview(r,state.settings.threshold??.9))||r.aggregate)return;if(i===0&&!needsReview(r,state.settings.threshold??.9))return;const [x1,y1,x2,y2]=r.bbox;const b=document.createElement('div');b.className='region-box'+(i===state.region?' active':'')+(needsReview(r,state.settings.threshold??.9)?' warning':'')+(i===0?' full-page':'');Object.assign(b.style,{left:`${x1/page.width*100}%`,top:`${y1/page.height*100}%`,width:`${(x2-x1)/page.width*100}%`,height:`${(y2-y1)/page.height*100}%`});const label=document.createElement('small');label.textContent=i===0?'整页需复核':`${i}${needsReview(r,state.settings.threshold??.9)?' · 待复核':''}`;b.append(label);b.onclick=()=>{if(state.cropping)return;selectReviewRegion(state.page,i,needsReview(r,state.settings.threshold??.9))};$('region-overlays').append(b)});
 $('region-overlays').style.display=state.cropping?'none':'';
}
function imageFromURL(src){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('图片无法读取'));img.src=src})}
function imageCanvas(image,maxSide=2400){const ratio=Math.min(1,maxSide/Math.max(image.width,image.height));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(image.width*ratio));c.height=Math.max(1,Math.round(image.height*ratio));const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(image,0,0,c.width,c.height);return c}
function pageFromCanvas(canvas){return{width:canvas.width,height:canvas.height,image:canvas.toDataURL('image/png'),reference:{status:'unavailable',reason:'图片没有可直接对照的 PDF 文字层，保留 OCR 待复核。',items:[]},regions:[newRegion(canvas.width,canvas.height)]}}
async function convertFile(file){
 if(file.mime==='application/pdf'){
  const pdfjs=await import('./vendor/pdf.mjs');pdfjs.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',import.meta.url).href;
  const bytes=Uint8Array.from(atob(file.data),c=>c.charCodeAt(0));const sourceDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
  const loading=pdfjs.getDocument({data:bytes,cMapUrl:new URL('./vendor/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/wasm/',import.meta.url).href,isEvalSupported:false});
  const pdf=await loading.promise;
  try{if(pdf.numPages>100)throw new Error('单份 PDF 最多 100 页，请先拆分文档');const pages=[];pages.sourceDigest=sourceDigest;for(let i=1;i<=pdf.numPages;i++){$('status').textContent=`正在导入 ${file.name} · 第 ${i}/${pdf.numPages} 页`;const page=await pdf.getPage(i),base=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(2,2400/Math.max(base.width,base.height))});const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvasContext:canvas.getContext('2d'),viewport,background:'#ffffff'}).promise;const converted=pageFromCanvas(canvas);converted.reference=await extractReference(page,viewport,pdfjs);pages.push(converted);page.cleanup()}return pages}finally{await pdf.destroy()}
 }
 const img=await imageFromURL(`data:${file.mime};base64,${file.data}`);return[pageFromCanvas(imageCanvas(img))];
}
async function identicalPages(oldPages,newPages){
 for(let i=0;i<oldPages.length;i++){
  const a=oldPages[i],b=newPages[i];if(a.width!==b.width||a.height!==b.height)return false;if(a.image===b.image)continue;
  const [ai,bi]=await Promise.all([imageFromURL(a.image),imageFromURL(b.image)]);const ac=imageCanvas(ai,10000),bc=imageCanvas(bi,10000),ap=ac.getContext('2d').getImageData(0,0,ac.width,ac.height).data,bp=bc.getContext('2d').getImageData(0,0,bc.width,bc.height).data;
  if(ap.length!==bp.length)return false;let changed=0;for(let k=0;k<ap.length;k++){if(Math.abs(ap[k]-bp[k])>2)return false;if(ap[k]!==bp[k])changed++}if(changed>ap.length*.0001)return false;
 }return true;
}
async function importFiles(files){
 if(!files?.length){notifyWork('已取消导入，文档库未改变。');return}let failures=[],added=0,reused=0;
 for(const file of files){try{const pages=await convertFile(file);let existing=state.docs.find(d=>d.sourceDigest&&d.sourceDigest===pages.sourceDigest);if(!existing)for(const d of state.docs.filter(d=>d.name===file.name&&d.pages.length===pages.length)){if(await identicalPages(d.pages,pages)){existing=d;break}}if(existing){existing.sourceDigest=pages.sourceDigest;existing.pages.forEach((p,i)=>{p.reference=pages[i].reference;delete p.proof;currentProof(p)});state.docId=existing.id;state.page=0;state.region=0;persist();render();reused++;continue}const doc={id:id(),name:file.name,sourceDigest:pages.sourceDigest,createdAt:Date.now(),pages};state.docs.push(doc);added++;state.docId=doc.id;state.page=0;state.region=0;state.zoom=1;persist();render()}catch(e){failures.push(`${file.name}：${e.message}`)}}
 notifyWork(`导入完成：新增 ${added} 份，已有 ${reused} 份（保留原结果），失败 ${failures.length} 份。`+(reused?'相同 PDF 已同步文字层；相同图片直接打开。':'')+(failures.length?'\n'+failures.join('\n'):'可点击“识别全部页面”开始处理。'),failures.length?'warning':'success');$('status').textContent=failures.length?'部分文件导入失败，请查看提示':'导入完成';
}
async function runImport(fn){if(state.importing)return;state.importing=true;notifyWork('正在选择或导入文档，请稍候…');render();try{await fn()}catch(e){error(e)}finally{state.importing=false;persist();render()}}
async function chooseDocuments(){if(state.importing)return;if(!native()){$('browser-files').click();return}await runImport(async()=>importFiles(await call('ChooseDocuments')))}
async function croppedData(page,region,variant=-1){const image=await imageFromURL(page.image);const [x1,y1,x2,y2]=region.bbox;const canvas=document.createElement('canvas');const scale=variant<0?1:Math.min(variant===0?1.5:2,2200/Math.max(x2-x1,y2-y1));canvas.width=Math.max(1,Math.round((x2-x1)*scale));canvas.height=Math.max(1,Math.round((y2-y1)*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);if(variant===1)ctx.filter='grayscale(1) contrast(1.2)';ctx.drawImage(image,x1,y1,x2-x1,y2-y1,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/png').split(',')[1]}
async function recognize(page,region){
 if(region===page.regions[0])return recognizePage(page);

 const owner=state.docs.find(d=>d.pages.includes(page));$('status').textContent=`正在识别 ${owner?.name||''} · 第 ${(owner?.pages.indexOf(page)??0)+1} 页 · 段落 ${page.regions.indexOf(region)}…`;
 const data=await croppedData(page,region);region.error='';invalidate(region);const revision=region.revision;
 try{const result=await call('Recognize',data,region.category);if(state.cancelled||region.revision!==revision)return;region.text=result.text;region.originalText=result.text;region.manualEdited=false;region.model=result.model;region.error=''}catch(e){if(region.revision===revision)region.error=String(e?.message||e);throw e}finally{mergeSegments(page);persist();renderResult()}
 if(!state.cancelled&&region.text.trim()){await verifyRegion(page,region);if(page.reference?.status!=='ready')await retryRegion(page,region);}
}

async function recognizePage(page){
 $('status').textContent='正在本机检测栏、段落、表格和公式…';
 const layout=await call('DetectLayout',page.image.split(',')[1]);if(state.cancelled)return;if(!layout.regions?.length)throw Error('未检测到可识别区域，原有结果已保留。请检查图片清晰度，或手动框选文字后识别。');
 const full=page.regions[0];if(full.text&&!full.aggregate)full.previousText=full.text;
 const segments=layout.regions.map(item=>({...newRegion(page.width,page.height,item.category,item.bbox),auto:true,layoutLabel:item.label,layoutConfidence:item.confidence,recovered:!!item.recovered}));
 page.regions=[full,...segments,...page.regions.slice(1).filter(r=>!r.auto)];full.aggregate=true;page.layoutModel=layout.model;page.scanAudit={status:layout.coverageChecked?'complete':'partial'};page.correctionThreshold=state.settings.threshold??.9;invalidate(full);if(activePage()===page)state.region=0;mergeSegments(page);persist();render();
 for(let i=0;i<segments.length;i++){
  if(state.cancelled)break;
  const r=segments[i];$('status').textContent=`正在识别段落 ${i+1}/${segments.length}（${r.layoutLabel}）…`;
  try{await recognize(page,r)}catch(e){r.error=String(e?.message||e)}
  mergeSegments(page);persist();render();
 }
 mergeSegments(page);persist();render();
}
async function confirmAction(title,body){$('confirm-title').textContent=title;$('confirm-body').textContent=body;$('confirm').showModal();return new Promise(resolve=>{const finish=value=>{$('confirm').close();resolve(value)};$('confirm-yes').onclick=()=>finish(true);$('confirm-no').onclick=()=>finish(false);$('confirm').oncancel=()=>resolve(false)})}
async function recognizeCurrent(){const r=activeRegion(),page=activePage(),doc=activeDoc();if(!r||state.busy)return;
 if(r.text&&!await confirmAction('重新识别当前内容？',r.aggregate?'将重新划分当前整页，并替换本页自动段落的文字、人工修改和复核状态。其他页面不变。':'新的识别结果将替换当前文字，并清除核验与人工复核状态。'))return;
 if(!await requireOCR())return;await runTask(async()=>{await recognize(page,r);return finishDocument(doc,'当前内容处理结束')},'正在本机识别，请稍候…')}
async function resumePage(page){
 delete page.processingError;
 if(!page.regions[0].aggregate)return recognizePage(page);
 for(const r of page.regions.filter(r=>r.auto)){if(state.cancelled)break;if(r.reviewed||r.manualEdited)continue;
  try{if(!r.text.trim()||r.error)await recognize(page,r);else if(r.verdict==='unverified'||r.verdict==='request_error')await verifyRegion(page,r)}catch(e){r.error=readableError(e)}
  mergeSegments(page);persist();render();
 }
}
async function recognizeAll(){
 const doc=activeDoc();if(!doc||state.busy)return;
 const pending=doc.pages.map((p,i)=>({p,i})).filter(({p})=>!p.regions[0].aggregate||p.regions.some(r=>r.auto&&!r.reviewed&&!r.manualEdited&&(!r.text.trim()||r.error||r.verdict==='unverified'||r.verdict==='request_error')));
 if(!pending.length){notifyWork('全部页面已有识别结果。低分内容可用“自动校对全文”处理，或点击“下一处待复核”人工检查。');return}
 if(!await requireOCR())return;
 await runTask(async()=>{let failed=0;for(const {p,i} of pending){if(state.cancelled)break;$('status').textContent=`正在处理 ${doc.name} · 第 ${i+1}/${doc.pages.length} 页`;try{await resumePage(p)}catch(e){if(state.cancelled)break;failed++;p.processingError=readableError(e)}}const text=finishDocument(doc,failed?`${failed} 页未完成`:'识别、核验与校对处理结束');return text},'开始批量识别…')
}
async function verifyRegion(page,r){
 const owner=state.docs.find(d=>d.pages.includes(page));const pageNumber=(owner?.pages.indexOf(page)??0)+1;
 state.verifying=true;state.verifyingRegion=r;invalidate(r);const revision=r.revision,text=r.text,category=r.category;state.verifyingRevision=revision;const current=()=>r.revision===revision&&page.regions.includes(r)&&state.docs.includes(owner);render();
 try{
  if(state.cancelled)return;
  if(category==='table'&&!/<table[\s>]/i.test(text))throw new Error('表格核验需要 HTML table，请按表格类型重新识别。');
  await ensureLocalJev();if(state.cancelled)return;
  $('status').textContent=`本地 Jev 正在核验 ${owner?.name||''} · 第 ${pageNumber} 页（可浏览、翻页、复制）…`;
  const result=await call('Verify',await croppedData(page,r),text,category==='page'?'text':category,'');
  if(state.cancelled||!current())return;
  r.reviewReopened=false;r.verificationModel='MiniCPM-OCR-Jev-Q8_0';r.score=result.score;r.verdict=result.verdict;
  r.detail=(r.category==='page'?'整页文字一致性评分，不能定位具体错字；混合版面建议框选表格、公式复核。 ':'')+result.detail;
 }catch(e){if(!state.cancelled&&current()){r.verdict='request_error';r.detail='识别文字已保留，核验未完成：'+String(e?.message||e)}}
 finally{if(state.cancelled&&current()){r.score=null;r.verdict='unverified';r.detail='核验已取消，识别文字已保留。'}state.verifying=false;state.verifyingRegion=null;persist();render()}
}
async function verify(){
 const r=activeRegion();if(!r||state.busy||!r.text.trim())return;
 const page=activePage();await runTask(async()=>{await verifyRegion(page,r);if(page.reference?.status!=='ready')await retryRegion(page,r);return finishDocument(state.docs.find(d=>d.pages.includes(page)),'核验结束')},'Jev 正在核验当前区域…')
}
async function copyText(text){if(!text.trim()){toast('还没有可复制的文字');return}if(native())await call('CopyText',text);else await navigator.clipboard.writeText(text);toast('已复制到剪贴板')}
async function exportActive(){const doc=activeDoc();if(!doc||$('export').disabled)return;const format=$('export-format').value,proof=$('output-version').value==='proof',content=proof?exportProof(doc,format):exportDocument(doc,format);$('export').disabled=true;const q=documentSummary(doc);
 try{if(native()){const path=await call('Export',proof?doc.name.replace(/\.[^.]+$/,'')+'-校对版':doc.name,format,content);if(!path){notifyWork('已取消导出，没有写入文件。');return}notifyWork(`已导出${proof?'校对版':'原始 OCR'}：${path}`+(q.pending||q.missing||q.empty?` · 仍有 ${q.pending} 处待复核、${q.missing} 页无结果、${q.empty} 段未识别。`:''),'success');toast('导出成功')}else{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));a.download=doc.name.replace(/\.[^.]+$/,'')+(proof?'-校对版':'')+'.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);notifyWork('已提交浏览器下载，请检查下载列表。')}}catch(e){error(e)}finally{renderWorkflow()}}
function toggleCrop(){state.cropping=!state.cropping;$('crop').classList.toggle('active',state.cropping);$('crop-hint').hidden=!state.cropping;$('image-stage').style.cursor=state.cropping?'crosshair':'';renderOverlays()}
let dragStart=null;
function point(e){const bounds=$('image-stage').getBoundingClientRect(),p=activePage();return{x:(e.clientX-bounds.left)/bounds.width*p.width,y:(e.clientY-bounds.top)/bounds.height*p.height}}
$('image-stage').addEventListener('pointerdown',e=>{if(!state.cropping||navigationLocked()||e.button!==0)return;e.preventDefault();dragStart=point(e);$('image-stage').setPointerCapture(e.pointerId);$('selection').hidden=false});
$('image-stage').addEventListener('pointermove',e=>{if(!dragStart)return;const p=activePage(),[x1,y1,x2,y2]=normalizedBox(dragStart,point(e),p.width,p.height);Object.assign($('selection').style,{left:`${x1/p.width*100}%`,top:`${y1/p.height*100}%`,width:`${(x2-x1)/p.width*100}%`,height:`${(y2-y1)/p.height*100}%`})});
$('image-stage').addEventListener('pointerup',e=>{if(!dragStart)return;const p=activePage(),bbox=normalizedBox(dragStart,point(e),p.width,p.height);dragStart=null;$('selection').hidden=true;if(bbox[2]-bbox[0]<15||bbox[3]-bbox[1]<15){toast('框选区域太小，请重试');return}p.regions.push(newRegion(p.width,p.height,'text',bbox));state.region=p.regions.length-1;toggleCrop();persist();render()});
$('image-stage').addEventListener('pointercancel',()=>{dragStart=null;$('selection').hidden=true});
function bind(id,fn){$(id).addEventListener('click',()=>Promise.resolve().then(fn).catch(error))}
bind('workflow-settings',openSettings);bind('workflow-dismiss',()=>{$('workflow-notice').hidden=true});bind('import',chooseDocuments);bind('dropzone',chooseDocuments);bind('recognize',recognizeCurrent);bind('recognize-all',recognizeAll);bind('verify',verify);bind('copy-current',()=>copyText($('editor').value));bind('all-copy',()=>copyText($('output-version').value==='proof'?exportProof(activeDoc(),'txt'):exportDocument(activeDoc(),'txt')));bind('export',exportActive);bind('crop',toggleCrop);
bind('cancel',async()=>{state.cancelled=true;if(native())await call('Cancel');$('status').textContent='正在取消…';notifyWork('正在取消，请等待当前请求结束；已完成结果会保留。','warning')});
bind('page-prev',()=>{if(navigationLocked())return;state.page=Math.max(0,state.page-1);state.region=0;render()});bind('page-next',()=>{if(navigationLocked())return;state.page=Math.min(activeDoc().pages.length-1,state.page+1);state.region=0;render()});
bind('zoom-in',()=>{state.zoom=Math.min(2.5,state.zoom+.25);render()});bind('zoom-out',()=>{state.zoom=Math.max(.5,state.zoom-.25);render()});
bind('next-issue',()=>{if(navigationLocked())return;const issues=reviewIssues(activeDoc(),state.settings.threshold??.9);const next=issues.find(x=>x.page>state.page||(x.page===state.page&&x.region>state.region))||issues[0];if(next)selectReviewRegion(next.page,next.region,true)});
bind('review',()=>{const r=activeRegion();if(!r||r.aggregate||$('review').disabled)return;r.reviewed=!r.reviewed;r.revision=(r.revision||0)+1;mergeSegments(activePage());currentProof(activePage());persist();
 if(r.reviewed){r.reviewReopened=false;recordReview(activeDoc(),state.page,r);persist();const issues=reviewIssues(activeDoc(),state.settings.threshold??.9),next=issues.find(x=>x.page>state.page||(x.page===state.page&&x.region>state.region))||issues[0];if(next){selectReviewRegion(next.page,next.region,true);toast('已保存人工复核，已跳到下一处待复核');notifyWork('已保存人工复核，文字已同步到校对版；已跳到下一处。点错可“撤销上一次复核”。','success')}else{render();toast('全部待复核已处理，修改后的文字已同步到校对版，可直接导出');notifyWork('全部待复核已处理，修改后的文字已同步到校对版。请检查是否仍有未识别页面，再导出。','success')}}else render();
});
bind('delete-region',async()=>{if(state.region===0)return;if(!await confirmAction('删除这个区域？','区域的识别文字和核验结果将被删除，原始页面不受影响。'))return;activePage().regions.splice(state.region,1);mergeSegments(activePage());state.region=0;persist();render()});
$('editor').addEventListener('input',()=>{if($('output-version').value==='proof')return;const r=activeRegion();if(!r)return;changeText(r,$('editor').value);r.error='';mergeSegments(activePage());$('char-count').textContent=`${r.text.length} 字符`;$('score-badge').textContent='未核验';$('score-badge').className='badge';$('edit-state').textContent='已修改 · 需重新核验';$('score-detail').textContent='内容已修改，原评分失效。请重新核验。';$('verify').disabled=state.busy||!r.text.trim();$('review').disabled=!r.text.trim();$('copy-current').disabled=!r.text;renderReviewActions();persist();renderOverlays();renderLibrary();renderProofStatus();renderWorkflow();$('task-summary').textContent=`自动核验已开启 · ${reviewIssues(activeDoc(),state.settings.threshold??.9).length} 处待复核`;$('next-issue').disabled=!reviewIssues(activeDoc(),state.settings.threshold??.9).length});
$('category').addEventListener('change',()=>{const r=activeRegion();r.category=$('category').value;invalidate(r);persist();render()});
const serviceState={engine:null,jev:null},serviceActions=new Map();
let settingsDraft=false,settingsSaving=false;
const engineFields=['model-dir','engine-path','ocr-url','ocr-model','cpu-only'];
function settingsDirty(){return settingsDraft&&JSON.stringify(formSettings())!==JSON.stringify(state.settings)}
function engineDirty(){const f=formSettings(),s=state.settings;return ['modelDir','enginePath','ocrURL','model','cpuOnly'].some(k=>(f[k]??false)!==(s[k]??false))}
function settingsFeedback(id,text,tone='info'){const e=$(id);e.textContent=text;e.dataset.tone=tone}
function renderSettingsControls(){
 const busy=serviceActions.size>0||settingsSaving;
 for(const kind of ['engine','jev']){
  const st=serviceState[kind],op=serviceActions.get(kind),active=!!(st?.running||st?.ready),local=kind==='jev';
  const reasons={start:op?'正在处理':active?'服务已运行，无需重复启动':state.busy?'当前文档任务进行中':local&&st&&!st.installed?'请先安装核验模型':'',stop:op&&op.action!=='start'?'正在处理':state.busy?'请先完成或取消文档任务':!active&&op?.action!=='start'?'服务尚未启动，无需停止':'',check:op?'正在自动更新状态':''};
  for(const action of ['start','stop','check']){const b=$(kind+'-'+action);b.disabled=!!reasons[action];b.title=reasons[action];b.setAttribute('aria-describedby',kind==='engine'?'ocr-status':'jev-status');}
  $(kind+'-start').textContent=op?.action==='start'?'正在加载…':active?'已启动':local?'启动核验模型':'启动引擎';
  $(kind+'-stop').textContent=op?.action==='stop'?'正在停止…':op?.action==='start'?'取消启动':local?'停止核验模型':'停止';
  $(kind+'-check').textContent=op?.action==='check'?'正在检查…':local?'检查状态':'检查连接';
 }
 for(const id of [...engineFields,'threshold','choose-engine','choose-model-dir','download-models','install-engine'])$(id).disabled=busy||state.busy;
 const blocked=state.busy||busy||!!(serviceState.engine?.running&&engineDirty());
 $('settings-save').disabled=blocked||!settingsDirty();$('settings-save').textContent=settingsSaving?'正在保存…':'保存设置';
 $('settings-save').title=blocked?'请先完成当前操作；修改运行中的 OCR 配置需先停止引擎':!settingsDirty()?'没有未保存的修改':'';
 const mode=$('cpu-only').checked?'仅 CPU（识别通常较慢）':'允许 GPU 加速';
 $('cpu-help').textContent=settingsDirty()&&engineDirty()?`未保存：${mode}。`+(serviceState.engine?.running?'请先点击“停止”，再保存设置并启动引擎。':'点击“保存设置”，或点击“启动引擎”保存并启动。'):`已保存：${mode}。更改运行中的 OCR 配置前需先停止引擎。`;
 $('settings-draft').textContent=settingsDirty()?'有未保存的修改 · 关闭窗口会保留草稿，不会自动生效。':(busy||state.busy)?'当前操作进行中，关闭设置窗口不会中断；完成后可修改配置。':'设置已保存。启动 OCR 会先保存当前配置；启动核验模型不修改 OCR 配置。';
}
async function openSettings(){
 if(!settingsDraft){if(native())state.settings=await call('GetSettings');const s=state.settings;$('model-dir').value=s.modelDir||'';$('engine-path').value=s.enginePath||'';$('ocr-url').value=s.ocrURL||'http://127.0.0.1:18499';$('ocr-model').value=s.model||'minicpm-ocr';$('threshold').value=s.threshold??.9;$('cpu-only').checked=!!s.cpuOnly;settingsDraft=true;}
 $('settings').showModal();renderSettingsControls();
 if(native())for(const kind of ['engine','jev'])if(!serviceActions.has(kind)){try{await (kind==='engine'?checkEngine:checkLocalJev)()}catch(e){settingsFeedback(kind==='engine'?'ocr-status':'jev-status','状态检查失败：'+(e.message||e),'error')}}
}
function formSettings(){return{...state.settings,modelDir:$('model-dir').value.trim(),enginePath:$('engine-path').value.trim(),ocrURL:$('ocr-url').value.trim(),model:$('ocr-model').value.trim(),jevURL:'http://127.0.0.1:18520/v1/rm/score',jevMode:'local',jevModel:'MiniCPM-OCR-Jev',threshold:Number($('threshold').value),cpuOnly:$('cpu-only').checked}}
async function saveSettings(){if(!$('settings-form').reportValidity())throw Error('请检查设置中的必填项和阈值范围');const s=formSettings();if(native())await call('SaveSettings',s);state.settings=s;render();renderSettingsControls()}
$('settings-form').addEventListener('submit',async e=>{e.preventDefault();if($('settings-save').disabled)return;settingsSaving=true;renderSettingsControls();try{await saveSettings();settingsFeedback('settings-status','设置已保存','success')}catch(e){settingsFeedback('settings-status','保存失败：'+(e?.message||String(e)),'error')}finally{settingsSaving=false;renderSettingsControls()}});
for(const id of [...engineFields,'threshold'])$(id).addEventListener('input',()=>{settingsFeedback('settings-status','');renderSettingsControls()});
bind('settings-open',openSettings);bind('settings-close',()=>{$('settings').close()});
bind('choose-engine',async()=>{const p=await call('ChooseEngine');if(p)$('engine-path').value=p;renderSettingsControls()});bind('choose-model-dir',async()=>{const p=await call('ChooseModelDirectory');if(p)$('model-dir').value=p;renderSettingsControls()});
async function checkEngine(){const s=await call('EngineStatus');serviceState.engine=s;if(s.ready&&state.ocrConnectionHint)notifyWork('OCR 已连接，可以返回文档开始识别。','success');$('connection').textContent=s.ready?'本地 OCR · 已连接':s.running?'本地 OCR · 模型加载中':'本地 OCR · 尚未连接';$('engine-dot').classList.toggle('offline',!s.ready);$('download-message').textContent=s.missing.length?`缺少 ${s.missing.length} 个模型文件 · ${s.platform}`:`模型文件齐全 · ${s.platform}`;settingsFeedback('ocr-status',s.ready?'OCR 已连接，可以识别文档。':s.running?'OCR 正在加载模型，请稍候；可点击停止。':'OCR 未启动。点击“启动引擎”后才能识别文档。',s.ready?'success':'info');if(settingsDraft)renderSettingsControls();return s}
async function serviceAction(kind,action){
 const previous=serviceActions.get(kind);if(previous&&!(action==='stop'&&previous.action==='start'))return;
 if(state.busy&&action!=='check')return;
 const local=kind==='jev',label=local?'核验模型':'OCR 引擎',status=local?'jev-status':'ocr-status',check=local?checkLocalJev:checkEngine;
 const operation={action};serviceActions.set(kind,operation);const current=()=>serviceActions.get(kind)===operation;
 renderSettingsControls();settingsFeedback(status,action==='start'?`正在启动${label}，加载可能需要几分钟；可取消启动。`:action==='stop'?`正在停止${label}…`:`正在检查${label}…`);
 try{
  if(action==='start'){
   if(!local)await saveSettings();if(!current())return;await call(local?'StartLocalJev':'StartEngine');if(!current())return;
   const began=Date.now(),deadline=began+180000;let result;
   do{await new Promise(r=>setTimeout(r,1000));if(!current())return;result=await check();if(!current())return;if(result.ready)break;if(!result.running)throw Error('进程已退出，请检查模型路径和引擎日志后重试');settingsFeedback(status,`正在加载${label} · 已等待 ${Math.round((Date.now()-began)/1000)} 秒。可取消启动，也可关闭窗口等待。`);}while(Date.now()<deadline);
   if(!result.ready){settingsFeedback(status,'模型仍在加载，尚未确认可用。可检查状态或停止后重试。','warning');return}
   settingsFeedback(status,`${label}启动成功，可以${local?'核验':'识别'}文档。`,'success');
  }else if(action==='stop'){
   await call(local?'StopLocalJev':'StopEngine');const result=await check();
   settingsFeedback(status,result.ready||result.running?'服务仍可访问，可能由其他实例启动；本应用无法停止该实例。':local?'核验模型已停止，释放其内存；下次核验时会自动启动。':'OCR 已停止，释放其内存。可以修改配置；再次识别前请启动引擎。',result.ready||result.running?'warning':'info');
  }else{await check();$(status).textContent='检查完成 · '+$(status).textContent;}
 }catch(e){if(current())settingsFeedback(status,`${label}${action==='start'?'启动':action==='stop'?'停止':'检查'}失败：${e?.message||String(e)}`,'error')}
 finally{if(current()){serviceActions.delete(kind);renderSettingsControls()}}
}
for(const kind of ['engine','jev'])for(const action of ['start','stop','check'])bind(kind+'-'+action,()=>serviceAction(kind,action));

async function setupTask(method,...args){
 if(state.busy||serviceActions.size)return;
 if(serviceState.engine?.running){settingsFeedback('settings-status','请先停止 OCR 引擎，再安装引擎或下载模型。','warning');return}
 const op={action:'setup'};serviceActions.set('engine',op);renderSettingsControls();
 try{await saveSettings();await runTask(async()=>{try{
  settingsFeedback('settings-status',method==='DownloadModels'?'正在下载模型，下方显示下载进度，可取消。':'正在安装引擎，可取消。');
  await call(method,...args);state.settings=await call('GetSettings');$('engine-path').value=state.settings.enginePath;$('cpu-only').checked=!!state.settings.cpuOnly;await checkEngine();settingsFeedback('settings-status','准备完成，请点击“启动引擎”。','success');
 }catch(e){settingsFeedback('settings-status',state.cancelled?'操作已取消，可重新开始。':'准备失败：'+(e.message||e),'error')}},'正在准备本地模型…')}
 catch(e){settingsFeedback('settings-status','准备失败：'+(e.message||e),'error')}
 finally{serviceActions.delete('engine');renderSettingsControls()}
}
bind('download-models',()=>setupTask('DownloadModels',$('download-source').value));bind('install-engine',()=>setupTask('InstallEngine'));
bind('clear-data',async()=>{if(state.busy)return;if(!await confirmAction('清空本机文档库？','所有导入文档与未导出的编辑结果都会被删除。模型文件和设置保留。'))return;clearTimeout(saveTimer);if(state.db)await new Promise((resolve,reject)=>{const tx=state.db.transaction('documents','readwrite');tx.objectStore('documents').clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});state.docs=[];state.docId=null;$('settings').close();render();toast('文档库已清空')});
bind('sample',async()=>{const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=1600;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1200,1600);ctx.fillStyle='#213d33';ctx.font='42px serif';ctx.fillText('PaperLens 文档识别测试',100,150);ctx.font='25px sans-serif';['这是一份内置样本文档，用于测试本地 OCR。','你可以识别整页，也可以框选下面的文字区域。','','项目名称：文档数字化工具','版本：0.5.18','日期：2026 年 11 月 16 日','','识别后可以编辑文字、复制内容或导出文件。','核验由本机 MiniCPM-OCR-Jev 独立模型完成。','','English recognition sample:','Make every document editable.','Total: 128.00 CNY'].forEach((line,i)=>ctx.fillText(line,100,270+i*65));const doc={id:id(),name:'内置测试文档.png',createdAt:Date.now(),pages:[pageFromCanvas(canvas)]};state.docs.push(doc);state.docId=doc.id;state.page=0;state.region=0;persist();render()});
$('browser-files').addEventListener('change',async e=>{const chosen=[...e.target.files];e.target.value='';await runImport(async()=>{const files=[];for(const f of chosen){if(f.size>80*1024*1024)throw new Error('单文件不能超过 80MB');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(f)});files.push({name:f.name,mime:f.type,data})}await importFiles(files)},'导入文档…')});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='o'){e.preventDefault();chooseDocuments().catch(error)}if(e.key==='Escape'&&state.cropping)toggleCrop()});
const onboarding=createOnboarding({call,isCancelled:()=>state.cancelled,available:()=>!!native()?.SetupStatus,busy:()=>state.busy||state.verifying||serviceActions.size>0,onBusy:b=>{state.cancelled=false;setBusy(b,b?'正在准备本地模型…':'就绪')},onDone:async()=>{state.settings=await call('GetSettings');settingsDraft=false;await checkEngine();await checkLocalJev();render()}});
async function init(){try{state.docs=migrateLocalScores(await loadDB());state.docs.sort((a,b)=>a.createdAt-b.createdAt);state.docId=state.docs.at(-1)?.id||null}catch(e){toast('无法恢复本机文档：'+e.message)}if(native()){state.settings=await call('GetSettings');window.runtime?.EventsOn('engine-progress',p=>{onboarding.progress(p);$('download-progress').value=p.percent;$('download-message').textContent=p.message;$('status').textContent=p.message;if(/退出/.test(p.message))checkEngine().catch(()=>{})});window.runtime?.OnFileDrop((x,y,paths)=>{runImport(async()=>importFiles(await call('ReadDocuments',paths)))},true);checkEngine().catch(()=>{})}render();await onboarding.auto()}
init().catch(error);

bind('setup-cancel',async()=>{state.cancelled=true;await call('Cancel');$('settings-status').textContent='正在取消…'});

async function checkLocalJev(){const s=await call('LocalJevStatus');serviceState.jev=s;settingsFeedback('jev-status',s.ready?'核验模型已连接，可以核验文档。':s.running?'正在加载核验模型，请稍候。':s.installed?'核验模型待机 · 已安装，下次核验时自动启动；也可手动启动。':'核验模型尚未安装，请打开“首次安装引导”。',s.ready?'success':'info');if(settingsDraft)renderSettingsControls();return s}
async function ensureLocalJev(){let s=await checkLocalJev();if(s.ready)return;if(!s.installed)throw new Error('本地核验尚未安装，请打开“首次安装引导”');await call('StartLocalJev');for(let i=0;i<180;i++){if(state.cancelled)throw new Error('已取消');$('status').textContent='正在加载本地核验模型…';await new Promise(r=>setTimeout(r,1000));s=await checkLocalJev();if(s.ready)return;if(!s.running)throw new Error('核验启动失败，请检查 local-jev/jev.log')}throw new Error('核验模型加载超时')}


function renderProofStatus(){
 const page=activePage();if(!page)return;const proof=currentProof(page);
 $('proof-status').textContent=proof.status==='unavailable'?proof.reason:`${proof.changes.length?'本页 '+proof.changes.length+' 处变化':'本页与原始 OCR 无变化'}${proof.status==='partial'?' · 部分区域待复核':''} · 原始 OCR 已保留`;
 const changed=activeDoc().pages.map((p,i)=>currentProof(p).changes?.length?i:-1).filter(i=>i>=0);$('next-change').disabled=!changed.length||navigationLocked();$('next-change').textContent=changed.length?`查看有修改的页面（${changed.length} 页）`:'暂无修改页';$('proof-open').disabled=proof.status==='unavailable';$('auto-correct').disabled=state.busy;$('all-copy').textContent=$('output-version').value==='proof'?'复制校对版':'复制原始全文';
}
bind('proof-open',()=>{const p=currentProof(activePage());$('proof-text').value=p.text;$('proof-summary').textContent=p.reason+(p.source==='pdf-text-layer'?' 修改依据：PDF 文字层；这不是 Jev 对校对版的新评分。':'');$('proof-changes').replaceChildren();for(const c of p.changes){const d=document.createElement('details'),title=document.createElement('summary'),before=document.createElement('pre'),after=document.createElement('pre');title.textContent=c.kind==='insert'?'补回分区外遗漏内容':c.basis||'修正区域';before.textContent='原 OCR：'+(c.before||'（无）');after.textContent='校对版：'+c.after;d.append(title,before,after);$('proof-changes').append(d)}$('proof-dialog').showModal()});
bind('proof-close',()=>$('proof-dialog').close());bind('proof-copy',()=>copyText(currentProof(activePage()).text));bind('attach-reference',chooseDocuments);$('output-version').addEventListener('change',()=>{renderResult();renderProofStatus();renderWorkflow()});
bind('next-change',()=>{const pages=activeDoc()?.pages||[];const changed=pages.map((p,i)=>currentProof(p).changes?.length?i:-1).filter(i=>i>=0);if(!changed.length)return;state.page=changed.find(i=>i>state.page)??changed[0];state.region=0;$('output-version').value='proof';render()});

async function retryRegion(page,r){
 const owner=state.docs.find(d=>d.pages.includes(page));state.correcting=true;render();
 try{await correctRegion(r,{threshold:state.settings.threshold??.9,current:()=>state.docs.includes(owner)&&page.regions.includes(r),cancelled:()=>state.cancelled,
  onAttempt:i=>{$('status').textContent=`自动校对：重识别低分段落，第 ${i+1}/3 轮…（可继续导入和浏览）`},
  recognize:async variant=>variant===2?recognizeSplit(page,r):call('Recognize',await croppedData(page,r,variant),r.category),
  verify:async(text,candidate)=>{await ensureLocalJev();if(state.cancelled)throw Error('已取消');const whole=await call('Verify',await croppedData(page,r),text,r.category==='page'?'text':r.category,'');if(whole.score>=(state.settings.threshold??.9)||!candidate.parts)return whole;const parts=[];for(const part of candidate.parts){if(state.cancelled)throw Error('已取消');const v=await call('Verify',await croppedData(page,part),part.text,'text','');parts.push({...part,...v});}const threshold=state.settings.threshold??.9;const allPass=parts.every(p=>p.verdict==='scored'&&Number.isFinite(p.score)&&p.score>=threshold&&p.score<=1);if(allPass)return {score:Math.min(...parts.map(p=>p.score)),verdict:'scored',parts};
   const originalWords=new Set((r.text.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]));const additions=parts.filter(p=>{const words=p.text.toLowerCase().match(/[\p{L}\p{N}]+/gu)||[],novel=words.filter(w=>!originalWords.has(w));return p.verdict==='scored'&&p.score>=threshold&&p.score<=1&&p.bbox[1]>=r.bbox[1]+(r.bbox[3]-r.bbox[1])*.65&&p.bbox[3]-p.bbox[1]<=(r.bbox[3]-r.bbox[1])*.35&&new Set(novel).size>=3&&novel.length/Math.max(1,words.length)>.4});
   if(additions.length)return {score:Math.min(...additions.map(p=>p.score)),verdict:'scored',parts:additions,partial:true,replacementText:r.text+'\n\n'+additions.map(p=>p.text).join('\n\n')};return whole;}
 });
 const words=wordEvidence(owner.pages.flatMap(p=>p.regions.filter(x=>!x.aggregate).map(x=>x.text)));
 if(textAuditAllowed(r)&&(detailRequired(r,words)||needsReview(r,state.settings.threshold??.9)))await auditDetails(r,{current:()=>state.docs.includes(owner)&&page.regions.includes(r),cancelled:()=>state.cancelled,version:detailVersion(words,state.settings.threshold??.9)+(r.layoutLabel==='figure'?':ticks2':'')+':context7',refine:()=>refineDetails(page,r,words)});
 }finally{state.correcting=false;persist();render()}
}
async function correctDocument(){
 const doc=activeDoc();if(!doc||state.busy)return;
 if(doc.pages.some(p=>p.reference?.status!=='ready'||!p.regions[0].aggregate||p.regions.some(r=>r.auto&&!r.text.trim()))&&!await requireOCR())return;
 await runTask(async()=>{let failed=0;
  for(const page of doc.pages){if(state.cancelled)break;delete page.processingError;
   if(page.reference?.status==='ready'){try{if(!page.regions[0].aggregate||page.regions.some(r=>r.auto&&!r.text.trim()))await resumePage(page);currentProof(page)}catch(e){failed++;page.processingError=readableError(e)}continue}
   if(!page.regions[0].aggregate){try{await recognizePage(page)}catch(e){failed++;page.processingError=readableError(e)}continue}
   page.correctionThreshold=state.settings.threshold??.9;page.scanAudit={status:'partial'};
   state.correcting=true;render();
   try{
    $('status').textContent='自动校对：分块检测遗漏段落…';
    const layout=await call('DetectLayout',page.image.split(',')[1]);if(state.cancelled)break;
    const missing=uncoveredRegions(page.regions.filter(r=>!r.aggregate),layout.regions);
    const added=missing.map(item=>({...newRegion(page.width,page.height,item.category,item.bbox),auto:true,recovered:true,layoutLabel:item.label}));
    page.regions.push(...added);page.scanAudit={status:layout.coverageChecked?'complete':'partial'};
    for(const r of page.regions.filter(r=>r.auto)){if(state.cancelled)break;if(r.reviewed||r.manualEdited)continue;if(!r.text.trim()||r.error)await recognize(page,r);else await retryRegion(page,r)}
   }catch(e){failed++;page.scanAudit={status:'partial',error:readableError(e)};page.processingError=readableError(e)}
   finally{state.correcting=false;mergeSegments(page);persist();render()}
  }
  if(!state.cancelled)await auditContinuations(doc);
  return finishDocument(doc,failed?`自动校对有 ${failed} 页未完成`:'自动校对处理结束');
 },'开始自动校对…');
}
bind('auto-correct',correctDocument);

async function recognizeSplit(page,r){
 if(r.category!=='text'&&r.category!=='page')throw Error('表格与公式保留完整结构，不自动拆分');
 const image=await imageFromURL('data:image/png;base64,'+await croppedData(page,r));const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
 const boxes=splitRaster(canvas.width,canvas.height,ctx.getImageData(0,0,canvas.width,canvas.height).data,2,false);
 if(boxes.length<2)throw Error('未找到安全分割空隙，保留原段落');
 const parts=[];for(const b of boxes){if(state.cancelled)throw Error('已取消');const part={bbox:[b[0]+r.bbox[0],b[1]+r.bbox[1],b[2]+r.bbox[0],b[3]+r.bbox[1]]};const result=await call('Recognize',await croppedData(page,part,0),'text');parts.push({...part,text:result.text})}
 return {text:parts.map(p=>p.text).join('\n\n'),model:'MiniCPM-OCR',parts};
}

function selectReviewRegion(pageIndex,regionIndex,editable=false){
 if(navigationLocked())return;state.page=pageIndex;state.region=regionIndex;
 if(editable)$('output-version').value='ocr';render();
 $('regions').querySelector('.selected')?.scrollIntoView({block:'nearest',inline:'nearest'});
 if(editable&&!$('editor').disabled&&!$('editor').readOnly)$('editor').focus({preventScroll:true});
}
function reviewTarget(){
 const page=activePage(),r=activeRegion();if(!page||!r)return null;
 if(!r.aggregate)return state.region;
 let index=page.regions.findIndex(x=>!x.aggregate&&needsReview(x,state.settings.threshold??.9));
 if(index<0)index=page.regions.findIndex(x=>!x.aggregate);return index<0?null:index;
}
function renderReviewActions(){
 const last=lastReview(activeDoc()),undoReason=navigationLocked()?'当前任务处理中，完成或取消后可撤销':!last?'当前文档没有可撤销的复核记录':'';
 $('undo-review').disabled=!!undoReason;$('undo-review').title=undoReason||`撤销第 ${last.pageIndex+1} 页的上一次复核，保留已修改文字`;$('undo-review-help').textContent=undoReason;
 const r=activeRegion();if(!r)return;
 const common=r.aggregate?'当前是全文预览，请选择具体段落。':!r.text.trim()?'当前段落没有文字，请先识别或输入文字。':$('output-version').value==='proof'?'校对版只读，请进入段落审核。':'';
 const verifyReason=state.busy?'有任务正在运行，完成或取消后可重新核验。':common;
 const reviewReason=navigationLocked()?'正在处理文档，完成或取消后可人工复核。':common;
 for(const [name,reason] of [['verify',verifyReason],['review',reviewReason]]){$(name).disabled=!!reason;$(name).title=reason;$(name).setAttribute('aria-describedby','review-help')}
 $('review').textContent=r.reviewed?'撤销人工复核':'标记人工复核';
 $('review-help').textContent=verifyReason||reviewReason?[verifyReason?'核验不可用：'+verifyReason:'',reviewReason?'人工复核不可用：'+reviewReason:''].filter(Boolean).join(' '):'对照左侧原图修改右侧文字，再核验；逐字确认无误后，可标记人工复核。';
 $('enter-review').hidden=!r.aggregate&&$('output-version').value==='ocr';$('enter-review').disabled=navigationLocked()||reviewTarget()===null;
 $('enter-review').title=navigationLocked()?'请先等待或取消当前任务':reviewTarget()===null?'尚无可审核段落，请先识别':'';
}
bind('enter-review',()=>{const target=reviewTarget();if(target!==null)selectReviewRegion(state.page,target,true)});

bind('undo-review',()=>{if(navigationLocked())return;const doc=activeDoc(),last=undoLastReview(doc);if(!last){toast('当前文档没有可撤销的复核记录');renderReviewActions();return;}currentProof(doc.pages[last.pageIndex]);persist();selectReviewRegion(last.pageIndex,last.regionIndex,true);toast('已撤销上一次复核，已返回原段落；修改后的文字保留');notifyWork('已撤销上一次复核，已返回原段落；修改后的文字保留，请重新确认。','warning');});

async function refineDetails(page,r,words){
 if(!textAuditAllowed(r))throw Error('表格和公式须保留结构核验，不进入文字细节校对');
 const threshold=state.settings.threshold??.9,joined=joinCandidates(r.text,words),code=isCode(r.text);
 await ensureLocalJev();
 const verifyText=async(text,part=r)=>{if(state.cancelled)throw Error('已取消');
  const renderedText=verificationCandidate(code?alignedCode(text,part===r?parts:part.lines||[]):text,code);
  const raw=await call('Verify',await croppedData(page,part),renderedText,'text','');
  // Fixed normalization matches the OCR input: original pixels, uniform scale,
  // white margin. No threshold search, sharpening, glyph removal or rewriting.
  if(normalizeVerificationImage(part===r,code,part.bbox[3]-part.bbox[1])){const normalized=await call('Verify',await detailImage(page,part),renderedText,'text','');return {...normalized,renderedText,rawScore:raw.score,rawVerdict:raw.verdict,imageTransform:'uniform-scale-white-margin'};}
  return {...raw,renderedText};
 };

 const image=await imageFromURL('data:image/png;base64,'+await croppedData(page,r)),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
 const figure=r.layoutLabel==='figure'&&!isCode(r.text);
 const boxes=detailBoxes(canvas.width,canvas.height,ctx.getImageData(0,0,canvas.width,canvas.height).data,{figure});
 if(!boxes.length)throw Error('未找到可靠的文字小块，保留原文待复核');
 const parts=[];
 const cached=r.detailAudit?.key===regionKey(r)&&(r.detailAudit.version===detailVersion(words,threshold)||r.detailAudit.version.startsWith(detailVersion(words,threshold)+':'))?r.detailAudit.parts:null;
 for(let i=0;i<boxes.length;i++){
  if(state.cancelled)throw Error('已取消');$('status').textContent=`自动校对：细节复读 ${i+1}/${boxes.length}（标点、断词与刻度）`;
  const b=boxes[i],part={bbox:[b[0]+r.bbox[0],b[1]+r.bbox[1],b[2]+r.bbox[0],b[3]+r.bbox[1]]};
  const prior=cached?.find(p=>JSON.stringify(p.bbox)===JSON.stringify(part.bbox)&&['uniform-scale-white-margin','independent-numeric-ticks'].includes(p.imageTransform));
  if(prior)parts.push({...prior});else{const result=await call('Recognize',await detailImage(page,part),'text');const score=await verifyText(result.text,part);parts.push({...part,text:result.text,...score});}
 }
 if(figure)for(const part of parts){
  if(!/^\s*\d+(?:[,.]\d+)*(?:\s+\d+(?:[,.]\d+)*){3,}\s*$/.test(part.text))continue;
  const im=await imageFromURL('data:image/png;base64,'+await croppedData(page,part)),c=document.createElement('canvas');c.width=im.width;c.height=im.height;const cx=c.getContext('2d');cx.drawImage(im,0,0);
  const ticks=numericTickBoxes(c.width,c.height,cx.getImageData(0,0,c.width,c.height).data);if(ticks.length!==part.text.trim().split(/\s+/).length){Object.assign(part,numericEvidenceResult(part,[],threshold));continue;}
  const evidence=[];
  for(let i=0;i<ticks.length;i++){
   if(state.cancelled)throw Error('已取消');$('status').textContent=`自动校对：逐个核验刻度 ${i+1}/${ticks.length}`;
   const b=ticks[i],tick={bbox:[b[0]+part.bbox[0],b[1]+part.bbox[1],b[2]+part.bbox[0],b[3]+part.bbox[1]]};
   const read=await call('Recognize',await detailImage(page,tick),'text'),v=await verifyText(read.text,tick);evidence.push({...tick,text:read.text,...v});
  }
  Object.assign(part,numericEvidenceResult(part,evidence,threshold));

 }
 if(joined&&joinReread(parts,words).replace(/\s+/g,' ').trim()===joined.replace(/\s+/g,' ').trim()){const score=await verifyText(joined);if(score.verdict==='scored'&&score.score>=threshold&&score.score<=1)return {...score,accepted:true,text:joined,reason:'断词候选经独立逐行复读及 Jev 核验'};}
 const text=isCode(r.text)||figure?parts.map(p=>p.text).join('\n'):joinReread(parts,words);const base=acceptedCorrection(r)?.text||r.text;
 // A small crop can lose context: no wholesale replacement when source words
 // disappear. Punctuation is checked separately by the image verifier.
 const tokens=t=>(t.toLowerCase().replace(/([a-z])-\s*([a-z])/g,'$1$2').match(/[\p{L}\p{N}]+/gu)||[]),remaining=tokens(text);let missing=0;
 for(const word of tokens(base)){const index=remaining.indexOf(word);if(index<0)missing++;else remaining.splice(index,1)}
 const coverage=1-missing/Math.max(1,tokens(base).length),whole=await verifyText(text);
 const contexts=[];
 if(!figure&&!parts.every(p=>p.verdict==='scored'&&p.score>=threshold&&p.score<=1))for(const group of statementContexts(parts,code)){
  if(state.cancelled)throw Error('已取消');$('status').textContent='自动校对：结合相邻文字行核验…';
  const reread=await call('Recognize',await detailImage(page,group),'text'),expected=code?group.lines.map(p=>p.text).join('\n'):joinReread(group.lines,words),matches=code?sameCode(reread.text,expected):sameText(reread.text,expected);
  const score=await verifyText(reread.text,group);contexts.push({...group,lines:undefined,text:reread.text,matches,...score});
 }
 const allPass=parts.every(p=>p.verdict==='scored'&&Number.isFinite(p.score)&&p.score>=threshold&&p.score<=1)||contextPasses(contexts,parts.length,threshold);
 const rasterCoverage=inkCoverage(canvas.width,canvas.height,ctx.getImageData(0,0,canvas.width,canvas.height).data,boxes,{allowFrame:code});
 const completeScore=rasterCoverage.complete&&!figure&&(code?sameCode(text,base):sameText(text,base))&&!/[A-Za-z]-\s*$/.test(base)?completeTextEvidence(parts,contexts,threshold):null;
 if(completeScore!==null)return {accepted:true,text:base,parts,contexts,coverage,whole,wholeScore:whole.score,score:completeScore,verdict:'scored',rasterCoverage,evidenceMode:'complete-line-coverage',reason:'文字与现有结果一致；逐行及必要语句核验完整覆盖，已解除排版导致的整段低分提示'};
 const accepted=coverage===1&&(!code||sameCode(text,base))&&allPass&&whole.verdict==='scored'&&whole.score>=threshold&&whole.score<=1;
 const physicalJoin=!figure&&!isCode(base)?verifiedLineJoin(base,parts,words,threshold):null;
 if(!accepted&&physicalJoin)return {accepted:true,partial:true,text:physicalJoin,parts,score:Math.min(...parts.map(p=>p.score)),verdict:'scored',wholeScore:whole.score,reason:'已按相邻文字行和文档词汇修正换行断词；逐行核验通过，整段仍待复核'};
 const patches=[];
 if(isCode(r.text))for(const part of parts){
  for(const candidate of sqlPunctuationCandidates(part.text,r.text)){const v=await verifyText(candidate,part);if(v.verdict==='scored'&&v.score>=threshold&&v.score<=1)patches.push({...part,text:candidate,...v});}
  for(const match of part.text.matchAll(/\b[A-Za-z]+_[A-Za-z_]+\b/g)){
   if(r.text.includes(match[0]))continue;
   const width=part.bbox[2]-part.bbox[0]-4,unit=width/part.text.length;
   const token={bbox:[Math.max(part.bbox[0],part.bbox[0]+2+match.index*unit-2),part.bbox[1],Math.min(part.bbox[2],part.bbox[0]+2+(match.index+match[0].length)*unit+2),part.bbox[3]]};
   const good=await verifyText(match[0],token),bad=await verifyText(match[0].replaceAll('_',''),token);
   if(good.verdict==='scored'&&good.score>=threshold&&good.score<=1&&bad.verdict==='scored'&&good.score>=bad.score+.05)patches.push({...part,score:good.score,verdict:'scored',tokenEvidence:{...token,text:match[0],score:good.score,alternativeScore:bad.score}});
  }
 }
 if(!accepted&&code){
  const rows=parts.map(p=>patches.find(q=>!q.tokenEvidence&&JSON.stringify(q.bbox)===JSON.stringify(p.bbox))||p);
  const repaired=verifiedCodeText(base,rows,threshold);
  if(repaired){const score=await verifyText(repaired);if(score.verdict==='scored'&&score.score>=threshold&&score.score<=1)return {accepted:true,text:repaired,parts:rows,contexts,score:Math.min(score.score,...rows.map(p=>p.score)),wholeScore:score.score,verdict:'scored',reason:'完整 SQL 逐行复读及整块核验通过；仅转移有证据的标识符标点'};}
 }
 if(!accepted&&figure){const patched=patchVerifiedScales(base,parts,threshold);if(patched!==base)return {accepted:true,partial:true,text:patched,parts:[...parts,...patches],score:Math.min(...[...parts,...patches].filter(p=>p.verdict==='scored'&&p.score>=threshold).map(p=>p.score)),verdict:'scored',reason:'已补入图像小块直接识别且核验通过的刻度，图表仍待复核'};}

 if(!accepted&&isCode(r.text)){const patched=patchVerifiedDetails(base,[...parts,...patches],threshold);if(patched!==base)return {accepted:true,partial:true,text:patched,parts:[...parts,...patches],score:Math.min(...[...parts,...patches].filter(p=>p.verdict==='scored'&&p.score>=threshold).map(p=>p.score)),verdict:'scored',reason:'已修正通过小块核验的 SQL 标点；其余内容仍待复核'};}
 return {accepted,text:accepted&&code?base:text,parts,contexts,patches,coverage,rasterCoverage,whole,wholeScore:whole.score,score:accepted?Math.min(whole.score,...(contextPasses(contexts,parts.length,threshold)?contexts:parts).map(p=>p.score)):whole.score,verdict:'scored',reason:accepted?'小块复读逐块核验通过':`细节复读仍有不一致（${parts.filter(p=>p.score<threshold||p.verdict!=='scored').length} 个小块；整段分数 ${Number.isFinite(whole.score)?whole.score.toFixed(3):'不可用'}）；保留候选和原文待复核`};
}
async function detailImage(page,part){
 const image=await imageFromURL('data:image/png;base64,'+await croppedData(page,part)),scale=Math.min(3,1800/image.width),pad=24,canvas=document.createElement('canvas');
 canvas.width=Math.round(image.width*scale)+pad*2;canvas.height=Math.round(image.height*scale)+pad*2;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,pad,pad,image.width*scale,image.height*scale);return canvas.toDataURL('image/png').split(',')[1];
}

async function auditContinuations(doc){
 const request=checkedRequest(call,()=>state.cancelled);
 const words=wordEvidence(doc.pages.flatMap(p=>p.regions.filter(r=>!r.aggregate).map(r=>r.text)));
 const ordered=doc.pages.flatMap((page,pageIndex)=>readingOrder(page.regions.filter(r=>r.auto&&!/caption|title/.test(r.layoutLabel||'')&&!/^\d+$/.test(r.text.trim()))).map(r=>({page,pageIndex,r})));
 const audits=[];
 for(let i=0;i<ordered.length-1;i++){
  if(state.cancelled)break;const a=ordered[i],b=ordered[i+1],candidate=continuationCandidate(doc,a.pageIndex,a.r,b.pageIndex,b.r,words);if(!candidate)continue;
  const audit={...candidate,accepted:false};audits.push(audit);$('status').textContent='自动校对：核验跨栏 / 跨页断词…';
  try{
   const readWindow=async depth=>{
   const ends=[];
   for(const [item,last] of [[a,true],[b,false]]){
    const image=await imageFromURL('data:image/png;base64,'+await croppedData(item.page,item.r)),c=document.createElement('canvas');c.width=image.width;c.height=image.height;const cx=c.getContext('2d');cx.drawImage(image,0,0);
    const boxes=detailBoxes(c.width,c.height,cx.getImageData(0,0,c.width,c.height).data);if(!boxes.length)throw Error('未找到可靠的续接行');
    if(boxes.length<Math.min(depth,2))throw Error('续接上下文行数不足');const selected=last?boxes.slice(-depth):boxes.slice(0,depth),box=[Math.min(...selected.map(b=>b[0])),Math.min(...selected.map(b=>b[1])),Math.max(...selected.map(b=>b[2])),Math.max(...selected.map(b=>b[3]))],part={bbox:[box[0]+item.r.bbox[0],box[1]+item.r.bbox[1],box[2]+item.r.bbox[0],box[3]+item.r.bbox[1]]};
    const png=await detailImage(item.page,part),read=await request('Recognize',png,'text');ends.push({png,text:read.text,bbox:part.bbox,page:item.pageIndex});
   }
   const tail=ends[0].text.match(/([A-Za-z]{2,})-\s*$/),head=ends[1].text.match(/^([a-z]{2,})\b/);if(!tail||!head||tail[1]+head[1]!==candidate.word)throw Error('两端独立复读与断词候选不一致');
   const images=await Promise.all(ends.map(e=>imageFromURL('data:image/png;base64,'+e.png))),canvas=document.createElement('canvas');canvas.width=Math.max(...images.map(im=>im.width));const gap=12,pad=24;canvas.height=images.reduce((n,im)=>n+im.height-pad*2,0)+pad*2+gap;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);let y=pad;for(const im of images){ctx.drawImage(im,pad,pad,im.width-pad*2,im.height-pad*2,pad,y,im.width-pad*2,im.height-pad*2);y+=im.height-pad*2+gap;}
   const png=canvas.toDataURL('image/png').split(',')[1],literal=ends.map(e=>e.text).join('\n'),expected=ends[0].text.replace(/-\s*$/,'')+ends[1].text.trimStart();
   const reread=await request('Recognize',png,'text');await ensureLocalJev();if(state.cancelled)throw Error('已取消');
   const good=await request('Verify',png,expected,'text',''),alternative=await request('Verify',png,literal,'text','');
   return {ends:ends.map(({png,...rest})=>rest),expected,reread:reread.text,score:good.score,verdict:good.verdict,alternativeScore:alternative.score,alternativeVerdict:alternative.verdict};
   };
   Object.assign(audit,await readWindow(1),{accepted:!state.cancelled});
   if(!candidate.lexicalEvidence){audit.extra=await readWindow(2);audit.additional=await readWindow(3);}
   audit.accepted=acceptedContinuation(doc,audit,state.settings.threshold??.9);
  }catch(e){audit.accepted=false;audit.error=readableError(e)}
 }
 if(state.docs.includes(doc)&&!state.cancelled)doc.continuationAudits=audits;persist();render();
}
