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
 window.calls=[];window.setup={supported:true,platform:'test',python:'',node:'',ocrModels:false,ocrEngine:false,verification:false,complete:false};
 const settings={modelDir:'/tmp/models',enginePath:'/tmp/server',ocrURL:'http://127.0.0.1:18499',model:'minicpm-ocr',cpuOnly:true,threshold:.9,jevURL:'http://127.0.0.1:18520/v1/rm/score',jevMode:'local',jevModel:'MiniCPM-OCR-Jev'};
 window.go={main:{App:{GetSettings:async()=>settings,SetupStatus:async()=>({...window.setup,complete:window.setup.ocrModels&&window.setup.ocrEngine&&window.setup.verification}),EngineStatus:async()=>({ready:!!window.ocr&&!window.loading,running:!!window.ocr,missing:[],platform:'test'}),LocalJevStatus:async()=>({installed:window.setup.verification,ready:!!window.jev,running:!!window.jev}),InstallSetupRuntime:async()=>{window.calls.push('environment');if(window.runtimeFail)throw Error('runtime download interrupted');window.setup.python='/private/python';window.setup.node='/private/node'},StopEngine:async()=>{window.ocr=false;window.calls.push('stopOCR')},StopLocalJev:async()=>{window.jev=false;window.calls.push('stopJev')},DownloadModels:async()=>{window.calls.push('models');if(window.hold)await new Promise((resolve,reject)=>window.release={resolve,reject});window.setup.ocrModels=true},InstallEngine:async()=>{window.calls.push('engine');if(window.fail)throw Error('download interrupted');window.setup.ocrEngine=true},InstallLocalJev:async()=>{window.calls.push('jev');window.setup.verification=true},StartEngine:async()=>{window.calls.push('startOCR');if(window.ocr)throw Error('already running');window.ocr=true},StartLocalJev:async()=>window.jev=true,CheckSetupRuntime:async()=>window.calls.push('runtime'),Cancel:async()=>{window.calls.push('cancel');window.release?.reject(Error('cancelled'))}}}};
 window.runtime={EventsOn:()=>{},OnFileDrop:()=>{}};
});
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.querySelector('#onboarding').open);
 assert.equal(await page.locator('#onboarding-start').isEnabled(),true);
 assert.equal(await page.locator('#onboarding-python-link').count(),0);
 assert.equal(await page.locator('#onboarding-node-link').count(),0);
 await page.evaluate(()=>window.runtimeFail=true);
 await page.locator('#onboarding-start').click();await page.waitForFunction(()=>document.querySelector('#onboarding-message').textContent.includes('runtime download interrupted'));
 assert.equal(await page.evaluate(()=>window.calls.includes('models')),false);
 await page.evaluate(()=>{window.runtimeFail=false;window.fail=true});
 await page.locator('#onboarding-start').click();await page.waitForFunction(()=>document.querySelector('#onboarding-message').textContent.includes('download interrupted'));
 assert.equal(await page.evaluate(()=>window.setup.ocrModels),true);assert.equal(await page.evaluate(()=>window.setup.verification),false);
 await page.evaluate(()=>window.fail=false);await page.locator('#onboarding-start').click();
 await page.waitForFunction(()=>document.querySelector('#onboarding-message').textContent.includes('准备完成'));
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x==='environment').length),2);
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x==='models').length),1);assert.ok((await page.evaluate(()=>window.calls)).includes('runtime'));
 await page.locator('#onboarding-start').click();await page.waitForFunction(()=>document.querySelector('#onboarding-message').textContent.includes('准备完成'));
 assert.equal(await page.evaluate(()=>window.calls.filter(x=>x==='startOCR').length),1);
 await page.locator('#onboarding-close').click();assert.equal(await page.locator('#onboarding').isVisible(),false);
 // Simulate model cleanup, then cancellation and reentry while download is pending.
 await page.evaluate(()=>{window.setup.ocrModels=false;window.hold=true;window.calls=[]});await page.locator('#onboarding-open').click();await page.locator('#onboarding-start').click();
 await page.waitForFunction(()=>!!window.release);await page.locator('#onboarding-close').click();await page.locator('#onboarding-open').click();assert.equal(await page.locator('#onboarding-start').isDisabled(),true);
 await page.locator('#onboarding-cancel').click();await page.waitForFunction(()=>document.querySelector('#onboarding-message').textContent.startsWith('已取消。'));
 assert.equal(await page.evaluate(()=>window.setup.ocrModels),false);assert.deepEqual(await page.evaluate(()=>window.calls),['stopOCR','models','cancel','stopOCR','stopJev']);
 assert.equal(await page.locator('#onboarding-start').isEnabled(),true);
 // Main task cancellation must also cancel a wizard running in the background.
 await page.evaluate(()=>{window.setup.ocrModels=true;window.hold=false;window.loading=true;window.calls=[]});
 await page.locator('#onboarding-start').click();await page.waitForFunction(()=>window.calls.includes('startOCR'));
 await page.locator('#onboarding-close').click();await page.locator('#settings-open').click();await page.locator('#setup-cancel').click();await page.locator('#settings-close').click();
 await page.locator('#onboarding-open').click();await page.waitForFunction(()=>document.querySelector('#onboarding-message').textContent.startsWith('已取消。'));
 assert.equal(await page.evaluate(()=>window.ocr),false);assert.equal(await page.evaluate(()=>window.calls.includes('runtime')),false);
 assert.deepEqual(errors,[]);
 console.log('PASS onboarding: automatic private environment, runtime failure/retry, first-run, failure/retry skip, readiness, background/reopen, cancellation and deleted models');
}finally{await browser.close();await new Promise(r=>server.close(r))}
