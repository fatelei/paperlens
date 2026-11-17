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
 window.go={main:{App:{GetSettings:async()=>settings,LocalJevStatus:async()=>({installed:true,ready:true,running:true}),StartLocalJev:async()=>{},StopLocalJev:async()=>{},SaveSettings:async s=>{settings=s},EngineStatus:async()=>({running:true,ready:true,missing:[],platform:'test'}),DetectLayout:async()=>({coverageChecked:true,model:'TEST-layout',regions:[{bbox:[50,50,550,200],category:'text',label:'title'},{bbox:[50,220,550,900],category:'text',label:'plain text'},{bbox:[600,220,1100,900],category:'text',label:'plain text'}]}),Recognize:async()=>({text:'段落内容 '+(++window.testCalls.recognized),model:'TEST-FIXTURE'}),Verify:async(_image,_text,category)=>{if(window.holdVerify)await new Promise(resolve=>window.releaseVerify=resolve);window.testCalls.category=category;window.testCalls.verified++;if(window.testFail)throw Error('测试核验故障');return{score:window.testScore??(window.testCalls.verified===2?.2:.96),verdict:'scored',detail:''}},CopyText:async t=>{window.testCalls.copied=t},Export:async(name,format,content)=>{window.testCalls.exported={name,format,content};return'/test/result.'+format},Cancel:async()=>{},ChooseDocuments:async()=>window.testInput||[]}}};
 window.runtime={EventsOn:()=>{},OnFileDrop:()=>{}};
});
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#sample').click();await page.locator('#recognize').click();await page.waitForFunction(()=>window.testCalls.verified===4&&!document.body.classList.contains('busy'));
 assert.equal(await page.locator('.region-box.warning').count(),0);
 assert.match(await page.locator('#editor').inputValue(),/段落内容 3/);assert.doesNotMatch(await page.locator('#editor').inputValue(),/段落内容 2/);
 await page.locator('#copy-current').click();assert.equal(await page.evaluate(()=>window.testCalls.copied),await page.locator('#editor').inputValue());
 assert.equal(await page.locator('#editor').evaluate(e=>e.readOnly),true);
 await page.locator('#output-version').selectOption('ocr');assert.match(await page.locator('#editor').inputValue(),/段落内容 2/);
 await page.locator('#regions button').nth(2).click();assert.equal(await page.locator('#editor').evaluate(e=>e.readOnly),false);
 await page.locator('#output-version').selectOption('proof');assert.equal(await page.locator('#editor').inputValue(),'段落内容 3');assert.equal(await page.locator('#editor').evaluate(e=>e.readOnly),true);
 await page.locator('#regions button').first().click();await page.locator('#next-change').click();assert.match(await page.locator('#proof-status').textContent(),/本页 1 处变化/);

 await page.locator('#proof-open').click();assert.match(await page.locator('#proof-text').inputValue(),/段落内容 3/);assert.doesNotMatch(await page.locator('#proof-text').inputValue(),/段落内容 2/);await page.locator('#proof-close').click();
 await page.locator('#export-format').selectOption('json');await page.locator('#export').click();let result=JSON.parse((await page.evaluate(()=>window.testCalls.exported)).content);assert.equal(result.pages[0].source,'local-retry');assert.equal(result.pages[0].changes.length,1);assert.equal(result.pages[0].changes[0].before,'段落内容 2');
 await page.evaluate(()=>{window.go.main.App.DetectLayout=async()=>({coverageChecked:true,model:'test',regions:[{bbox:[50,50,550,200],category:'text'},{bbox:[50,220,550,900],category:'text'},{bbox:[600,220,1100,900],category:'text'},{bbox:[50,950,550,1020],category:'text',label:'caption'}]})});
 await page.locator('#auto-correct').click();await page.waitForFunction(()=>window.testCalls.verified===5&&!document.body.classList.contains('busy'));await page.locator('#export').click();result=JSON.parse((await page.evaluate(()=>window.testCalls.exported)).content);assert.ok(result.pages[0].changes.some(c=>c.kind==='insert'));assert.equal(result.pages[0].parts.length,4);
 await page.waitForTimeout(400);await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await page.locator('#proof-open').click();assert.match(await page.locator('#proof-text').inputValue(),/段落内容 3/);assert.match(await page.locator('#proof-text').inputValue(),/段落内容 5/);
 assert.deepEqual(errors,[]);console.log('PASS: image correction retry, new Jev score, no raw overwrite, missed region recovery, corrected export, persistence');
}finally{await browser.close();await new Promise(r=>server.close(r))}
