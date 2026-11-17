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
 let running=false,ready=false,settings={modelDir:'/tmp/models',enginePath:'/tmp/server',ocrURL:'http://127.0.0.1:18499',model:'minicpm-ocr',cpuOnly:false,threshold:.9,jevURL:'http://127.0.0.1:18520/v1/rm/score',jevMode:'local',jevModel:'MiniCPM-OCR-Jev'};
 window.starts=0;window.saves=0;window.slowStart=false;
 window.go={main:{App:{GetSettings:async()=>settings,SaveSettings:async s=>{if(window.failSave)throw Error('磁盘只读');window.saves++;settings=s},EngineStatus:async()=>({running,ready,missing:[],platform:'test'}),LocalJevStatus:async()=>({installed:true,running:false,ready:false}),StartEngine:async()=>{window.starts++;if(window.failStart)throw Error('模型文件无效');running=true;if(!window.slowStart)setTimeout(()=>{if(running)ready=true},1600)},StopEngine:async()=>{running=false;ready=false},StartLocalJev:async()=>{throw Error('核验测试错误')}}}};
 window.runtime={EventsOn:()=>{},OnFileDrop:()=>{}};
});
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#settings-open').click();
 assert.equal(await page.locator('#engine-stop').isDisabled(),true);assert.equal(await page.locator('#settings-save').isDisabled(),true);assert.match(await page.locator('#jev-status').textContent(),/待机/);
 await page.locator('#engine-check').click();await page.waitForFunction(()=>document.querySelector('#ocr-status').textContent.includes('检查完成'));
 await page.locator('#engine-start').click();assert.equal(await page.locator('#engine-start').isDisabled(),true);assert.equal(await page.locator('#engine-stop').isEnabled(),true);
 await page.locator('#settings-close').click();await page.locator('#settings-open').click();assert.equal(await page.locator('#engine-start').isDisabled(),true);
 await page.waitForFunction(()=>document.querySelector('#ocr-status').textContent.includes('启动成功'));assert.equal(await page.locator('#engine-start').isDisabled(),true);assert.equal(await page.evaluate(()=>window.starts),1);
 await page.locator('#cpu-only').check();assert.match(await page.locator('#cpu-help').textContent(),/先点击“停止”/);assert.equal(await page.locator('#settings-save').isDisabled(),true);
 await page.locator('#settings-close').click();await page.locator('#settings-open').click();assert.equal(await page.locator('#cpu-only').isChecked(),true);assert.match(await page.locator('#settings-draft').textContent(),/未保存/);
 await page.locator('#engine-stop').click();await page.waitForFunction(()=>document.querySelector('#ocr-status').textContent.includes('已停止'));assert.equal(await page.locator('#settings-save').isEnabled(),true);
 await page.evaluate(()=>window.failSave=true);await page.locator('#settings-save').click();await page.waitForFunction(()=>document.querySelector('#settings-status').textContent.includes('磁盘只读'));assert.equal(await page.locator('#settings-save').isEnabled(),true);
 await page.evaluate(()=>window.failSave=false);await page.locator('#settings-save').click();await page.waitForFunction(()=>document.querySelector('#settings-status').textContent.includes('设置已保存'));assert.match(await page.locator('#cpu-help').textContent(),/已保存：仅 CPU/);assert.equal(await page.locator('#settings-save').isDisabled(),true);
 await page.evaluate(()=>window.slowStart=true);await page.locator('#engine-start').click();await page.waitForFunction(()=>document.querySelector('#ocr-status').textContent.includes('已等待'));await page.locator('#engine-stop').click();await page.waitForFunction(()=>document.querySelector('#ocr-status').textContent.includes('已停止'));await page.waitForTimeout(1200);assert.match(await page.locator('#ocr-status').textContent(),/已停止/);assert.equal(await page.locator('#engine-start').isEnabled(),true);
 await page.evaluate(()=>window.failStart=true);await page.locator('#engine-start').click();await page.waitForFunction(()=>document.querySelector('#ocr-status').textContent.includes('模型文件无效'));assert.equal(await page.locator('#engine-check').isEnabled(),true);
 const saves=await page.evaluate(()=>window.saves);await page.locator('#jev-start').click();await page.waitForFunction(()=>document.querySelector('#jev-status').textContent.includes('核验测试错误'));assert.equal(await page.evaluate(()=>window.saves),saves);assert.equal(await page.locator('#jev-check').isEnabled(),true);
 assert.deepEqual(errors,[]);console.log('PASS: offline/ready controls, automatic loading, reopen during loading, draft preservation, CPU stop-save workflow, save failure recovery, loading cancellation, start failure, independent Jev startup');
}finally{await browser.close();await new Promise(r=>server.close(r))}
