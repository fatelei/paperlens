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
 window.go={main:{App:{GetSettings:async()=>settings,LocalJevStatus:async()=>({installed:true,ready:true,running:true}),StartLocalJev:async()=>{},StopLocalJev:async()=>{},SaveSettings:async s=>{settings=s},EngineStatus:async()=>({running:true,ready:true,missing:[],platform:'test'}),DetectLayout:async()=>({model:'TEST-layout',regions:[{bbox:[50,50,550,200],category:'text',label:'title'},{bbox:[50,220,550,900],category:'text',label:'plain text'},{bbox:[600,220,1100,900],category:'text',label:'plain text'}]}),Recognize:async()=>({text:'段落内容 '+(++window.testCalls.recognized),model:'TEST-FIXTURE'}),Verify:async(_image,_text,category)=>{if(window.holdVerify)await new Promise(resolve=>window.releaseVerify=resolve);window.testCalls.category=category;window.testCalls.verified++;if(window.testFail)throw Error('测试核验故障');return{score:window.testScore??([2,3,4].includes(window.testCalls.verified)?.2:.96),verdict:'scored',detail:''}},CopyText:async t=>{window.testCalls.copied=t},Export:async(name,format,content)=>{window.testCalls.exported={name,format,content};return'/test/result.'+format},Cancel:async()=>{},ChooseDocuments:async()=>window.testInput||[]}}};
 window.runtime={EventsOn:()=>{},OnFileDrop:()=>{}};
});
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#sample').click();await page.locator('#output-version').selectOption('ocr');await page.locator('#recognize').click();await page.waitForFunction(()=>window.testCalls.verified>=5&&!document.body.classList.contains('busy'));
 assert.equal(await page.locator('#regions button').count(),4);assert.equal(await page.locator('.region-box.warning').count(),0);assert.equal(await page.locator('.full-page').count(),0);
 await page.locator('#all-copy').click();assert.match(await page.evaluate(()=>window.testCalls.copied),/^段落内容 1\n\n段落内容 2\n\n段落内容 \d+$/);
 await page.locator('#regions button').nth(2).click();assert.equal(await page.locator('#editor').inputValue(),'段落内容 2');await page.locator('#editor').fill('修正第二段');
 await page.locator('#all-copy').click();assert.match(await page.evaluate(()=>window.testCalls.copied),/段落内容 1\n\n修正第二段\n\n段落内容 \d+/);
 await page.evaluate(()=>window.holdVerify=true);await page.locator('#verify').click();await page.waitForFunction(()=>!!window.releaseVerify);await page.locator('#editor').fill('核验时再次修改');
 await page.evaluate(()=>window.testInput=[]);await page.locator('#import').click();await page.evaluate(()=>window.releaseVerify());await page.waitForFunction(()=>!document.body.classList.contains('busy'));assert.equal(await page.locator('#score-badge').textContent(),'未核验');
 await page.locator('#review').click();assert.equal(await page.locator('.region-box.warning').count(),0);
 await page.locator('#export-format').selectOption('json');await page.locator('#export').click();const out=JSON.parse((await page.evaluate(()=>window.testCalls.exported)).content);assert.equal(out.pages[0].regions[1].auto,true);
 await page.waitForTimeout(400);await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await page.locator('#output-version').selectOption('ocr');assert.equal(await page.locator('#regions button').count(),4);await page.locator('#all-copy').click();assert.match(await page.evaluate(()=>window.testCalls.copied),/核验时再次修改/);
 assert.deepEqual(errors,[]);console.log('PASS: automatic layout, bounded retry calls, reading order merge, low paragraph only, edits update full copy, concurrent import, stale score rejection, export and persistence');
}finally{await browser.close();await new Promise(r=>server.close(r))}
