// UI integration test with an explicitly mocked native bridge. Real inference is
// tested separately against the local llama-server; no fixture ships in the app.
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=resolve('frontend/dist');
const server=createServer(async(req,res)=>{try{if(req.url.startsWith('/wails/')){res.setHeader('Content-Type','text/javascript');res.end('');return}const path=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]==='/'?'/index.html':req.url.split('?')[0]));if(!path.startsWith(root+'/'))throw Error('bad path');res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm'})[extname(path)]||'application/octet-stream');res.end(await readFile(path))}catch(e){res.statusCode=404;res.end('not found')}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
const page=await browser.newPage({viewport:{width:1320,height:860}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>{
 window.testCalls={copied:'',exported:null,verified:0,recognized:0};
 let settings={ocrURL:'http://127.0.0.1:18499',model:'minicpm-ocr',jevURL:'http://127.0.0.1:18520/v1/rm/score',jevMode:'local',threshold:.9,modelDir:'/tmp/models',enginePath:'/tmp/llama-server'};
 window.go={main:{App:{GetSettings:async()=>settings,LocalJevStatus:async()=>({installed:true,ready:true,running:true}),StartLocalJev:async()=>{},StopLocalJev:async()=>{},SaveSettings:async s=>{settings=s},EngineStatus:async()=>({running:true,ready:true,missing:[],platform:'test'}),DetectLayout:async()=>({model:'TEST-layout',regions:[{bbox:[50,50,550,200],category:'text',label:'title'},{bbox:[50,220,550,900],category:'text',label:'plain text'},{bbox:[600,220,1100,900],category:'text',label:'plain text'}]}),Recognize:async()=>({text:'段落内容 '+(++window.testCalls.recognized),model:'TEST-FIXTURE'}),Verify:async(_image,_text,category)=>{if(window.holdVerify)await new Promise(resolve=>window.releaseVerify=resolve);window.testCalls.category=category;window.testCalls.verified++;if(window.testFail)throw Error('测试核验故障');return{score:window.testScore??(window.testCalls.verified===2?.2:.96),verdict:'scored',detail:''}},CopyText:async t=>{window.testCalls.copied=t},Export:async(name,format,content)=>{window.testCalls.exported={name,format,content};return'/test/result.'+format},Cancel:async()=>{},ChooseDocuments:async()=>window.testInput||[]}}};
 window.runtime={EventsOn:()=>{},OnFileDrop:()=>{}};
});
const previous=JSON.parse(await readFile(process.env.PAPERLENS_OCR_JSON,'utf8'));
const pdf=await readFile(process.env.PAPERLENS_PDF);
await page.addInitScript(({previous,data})=>{
 let pi=0,ri=0,active=[];window.proofCalls=0;window.testInput=[{name:'timescaledb.pdf',mime:'application/pdf',data}];
 Object.assign(window.go.main.App,{
 DetectLayout:async()=>{active=previous.pages[pi++].regions.filter(r=>r.auto);ri=0;return {model:'fixture-real-layout',regions:active.map(r=>({bbox:r.bbox,category:r.type,label:r.layoutLabel}))}},
 Recognize:async()=>({text:active[ri].text,model:'fixture-prior-OCR'}),
 Verify:async()=>{const r=active[ri++];window.proofCalls++;return {score:r.score,verdict:r.verdict,detail:r.detail}}
 });
},{previous,data:pdf.toString('base64')});
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#import').click();await page.waitForFunction(()=>document.querySelector('#pages-count').textContent==='7 页');
 await page.locator('#recognize-all').click();await page.waitForFunction(()=>window.proofCalls===103&&!document.body.classList.contains('busy'),null,{timeout:120000});
 await page.locator('#proof-open').click();assert.match(await page.locator('#proof-text').inputValue(),/Postgres/);assert.doesNotMatch(await page.locator('#proof-text').inputValue(),/Postgrs/);await page.locator('#proof-close').click();
 await page.locator('#export-format').selectOption('json');await page.locator('#export').click();const exported=JSON.parse((await page.evaluate(()=>window.testCalls.exported)).content);
 assert.equal(exported.pages.length,7);assert.ok(exported.pages.every(p=>['ready','partial'].includes(p.status)));const all=exported.pages.map(p=>p.text).join('\n');for(const term of ['error_msg','errno','loc.region','SERVER','Single-row inserts','Batched inserts'])assert.ok(all.includes(term),term);
 await mkdir('build/test-artifacts',{recursive:true});await writeFile('build/test-artifacts/automatic-proof.json',JSON.stringify(exported,null,2));
 await page.locator('#all-copy').click();assert.match(await page.evaluate(()=>window.testCalls.copied),/第 7 页/);
 // Re-importing identical pages attaches reference instead of duplicating or discarding edits.
 await page.locator('#import').click();await page.waitForTimeout(800);assert.equal(await page.locator('#documents button').count(),1);
 await page.evaluate(()=>new Promise(resolve=>{const req=indexedDB.open('paperlens',1);req.onsuccess=()=>{const db=req.result,tx=db.transaction('documents','readwrite'),store=tx.objectStore('documents'),all=store.getAll();all.onsuccess=()=>{for(const d of all.result){delete d.sourceDigest;store.put(d)}};tx.oncomplete=resolve}}));await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await page.locator('#import').click();await page.waitForTimeout(1200);assert.equal(await page.locator('#documents button').count(),1,'legacy source backfill must preserve original results');
 assert.deepEqual(errors,[]);console.log('PASS: real 7-page PDF text extraction, 103 prior OCR fixtures, automatic proof, restored SQL and captions, full copy/export, re-import keeps document');
}finally{await browser.close();await new Promise(r=>server.close(r))}
