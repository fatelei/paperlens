// First-run setup uses the same native operations as advanced settings.
export function createOnboarding({call,available,busy,isCancelled=()=>false,onBusy,onDone}) {
 const $=id=>document.getElementById(id),dialog=$('onboarding');
 let snapshot=null,running=false,checking=false,cancelled=false,finished=false,started=0,timer=null,phase='';
 const elapsed=()=>{const seconds=Math.floor((Date.now()-started)/1000);return `${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;};
 const message=(text,tone='info')=>{ $('onboarding-message').textContent=text;$('onboarding-message').dataset.tone=tone; };
 function render(){
  const s=snapshot,dependencies=!!s?.python&&!!s?.node;
  $('onboarding-runtime').textContent=dependencies?'已准备':'将由应用自动下载并安装';
  $('onboarding-platform').textContent=s?`${s.platform} · ${s.supported?'支持本机安装':'暂不支持此平台，请使用 macOS Apple Silicon 或 Windows x64'}`:'正在检查本机环境…';
  for(const [id,ready] of [['ocr',s?.ocrModels&&s?.ocrEngine],['jev',s?.verification]]){$('onboarding-'+id).textContent=ready?'已安装':'待安装';}
  $('onboarding-start').disabled=running||checking||!s?.supported;
  $('onboarding-start').textContent=running?'正在准备…':finished?'重新检查连接':s?.complete?'启动并检查连接':'开始 / 继续安装';
  $('onboarding-refresh').disabled=running||checking;$('onboarding-source').disabled=running||checking;
  $('onboarding-cancel').hidden=!running;$('onboarding-cancel').disabled=cancelled;
  $('onboarding-close').textContent=running?'后台继续':finished?'开始使用':'稍后设置';

 }
 async function refresh(){
  if(running||checking)return;checking=true;finished=false;overall(0);$('onboarding-phase').textContent='整体阶段：等待开始';$('onboarding-task').textContent='当前任务：检查本机安装状态';$('onboarding-progress').hidden=true;$('onboarding-progress-label').textContent='检查后可开始安装或启动连接检查。';render();
  try{snapshot=await call('SetupStatus');message(snapshot.complete?'模型与环境已安装，点击下方按钮启动并检查连接。':snapshot.supported?'点击开始即可自动准备所需组件，无需安装其他软件；下载中断后可继续。':'本机平台暂不支持自动安装。');}
  catch(e){snapshot=null;message('环境检查失败：'+String(e?.message||e)+'。请重新检查。','error')}
  finally{checking=false;$('onboarding-task').textContent=snapshot?.complete?'当前任务：等待启动与连接检查':snapshot?'当前任务：等待开始安装':'当前任务：环境检查失败';render()}
 }
 async function open(){
  if(!dialog.open)dialog.showModal();
  if(!available()){message('请在 PaperLens 桌面应用中使用安装引导。','error');render();return;}
  if(!running)await refresh();else render();
 }
 const guard=()=>{if(cancelled||isCancelled())throw Error('已取消');};
 async function request(name,...args){guard();const result=await call(name,...args);guard();return result;}
 function overall(step){
  for(let i=1;i<=4;i++){const el=$('setup-step-'+i);el.dataset.state=i<step?'done':i===step?'active':'pending';el.querySelector('span').textContent=i<step?'已完成':i===step?(step===4?'已就绪':'进行中'):'等待开始';if(i===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');}
 }
 function task(text,percent){
  $('onboarding-task').textContent='当前任务：'+text;
  const downloading=/下载/.test(text)&&!/(校验|检查|解压|已完成|下载完成|已下载|已存在)/.test(text);
  const measured=downloading&&Number.isFinite(percent)&&percent>0&&percent<1;
  $('onboarding-progress').hidden=false;
  if(measured){$('onboarding-progress').value=percent;$('onboarding-progress-label').textContent=`当前文件已下载 ${Math.floor(percent*100)}% · 不代表整体安装进度`;}
  else{$('onboarding-progress').removeAttribute('value');$('onboarding-progress-label').textContent=downloading&&percent>=1?'当前文件已接收完，正在进入校验或下一项任务，安装尚未结束。':'正在处理此任务，暂无法估算百分比，请稍候…';}
 }
 function stage(text,step=2){phase=text;overall(step);$('onboarding-phase').textContent=`整体阶段 ${step} / 4 · ${['','环境准备','下载与安装','启动检查'][step]}`;task(text);message(text);}
 function stopped(label){$('onboarding-task').textContent=label;$('onboarding-progress').hidden=true;$('onboarding-progress-label').textContent='已完成的文件保留，重试将继续检查和安装。';for(let i=1;i<=4;i++){const el=$('setup-step-'+i);if(el.dataset.state==='active')el.querySelector('span').textContent=label;}}

 async function waitReady(kind){
  const name=kind==='ocr'?'OCR':'核验';stage(`正在加载${name}模型并检查连接…`,3);
  const initial=await request(kind==='ocr'?'EngineStatus':'LocalJevStatus');
  if(initial.ready)return;
  if(!initial.running)await request(kind==='ocr'?'StartEngine':'StartLocalJev');
  const deadline=Date.now()+240000;
  while(Date.now()<deadline){const s=await request(kind==='ocr'?'EngineStatus':'LocalJevStatus');if(s.ready)return;if(!s.running)throw Error(name+'服务已退出，请重试并检查模型设置。');await new Promise(r=>setTimeout(r,1000));guard();}
  throw Error(name+'加载超时，模型文件已保留，可重试连接检查。');
 }
 async function start(){
  if(running||checking)return;
  if(busy()){message('当前还有任务正在运行，请完成或取消后再安装。','warning');return;}
  running=true;cancelled=false;finished=false;started=Date.now();onBusy(true);render();
  timer=setInterval(()=>{$('onboarding-elapsed').textContent=`已用时 ${elapsed()} · 可后台继续或取消`;},1000);
  try{
   stage('检查已安装组件',1);snapshot=await request('SetupStatus');render();
   if(!snapshot.supported)throw Error('此平台暂不支持自动安装');
   if(!snapshot.python||!snapshot.node){await request('StopLocalJev');stage('正在自动准备应用运行环境…',1);await request('InstallSetupRuntime');snapshot=await request('SetupStatus');render();}
   if(!snapshot.ocrModels||!snapshot.ocrEngine){await request('StopEngine');}
   if(!snapshot.ocrModels){stage('下载 OCR 模型（约 2 GB）');await request('DownloadModels',$('onboarding-source').value);snapshot.ocrModels=true;render();}
   if(!snapshot.ocrEngine){stage('安装 OCR 推理引擎');await request('InstallEngine');snapshot.ocrEngine=true;render();}
   if(!snapshot.verification){await request('StopLocalJev');stage('安装独立核验与版面分析（模型约 2.7 GB）');await request('InstallLocalJev');snapshot.verification=true;render();}
   stage('检查已安装文件',3);snapshot=await request('SetupStatus');if(!snapshot.complete)throw Error('仍有组件未安装完整，请重试。');
   await waitReady('ocr');await waitReady('jev');stage('检查浏览器、渲染与版面环境',3);await request('CheckSetupRuntime');
   guard();finished=true;overall(4);$('onboarding-progress').hidden=false;$('onboarding-progress').value=1;$('onboarding-phase').textContent='整体阶段 4 / 4 · 准备完成';$('onboarding-task').textContent='当前任务：全部检查通过';$('onboarding-progress-label').textContent='整体安装完成，可以开始识别文档。';
   message('准备完成：OCR、独立核验和版面分析均已就绪，可以导入文档开始识别。','success');
  }catch(e){
   if(cancelled||isCancelled()){await Promise.allSettled([call('StopEngine'),call('StopLocalJev')]);message('已取消。已完成的下载保留，下次点击“开始 / 继续安装”即可重试。','warning');}
   else message('准备失败：'+String(e?.message||e)+' 已完成的文件保留，可重新检查后重试。','error');
  }finally{if(!finished)stopped(cancelled||isCancelled()?'安装已取消':'安装未完成');clearInterval(timer);running=false;onBusy(false);$('onboarding-elapsed').textContent=`本次用时 ${elapsed()}`;render();await onDone().catch(()=>{});}
 }
 $('onboarding-start').onclick=start;$('onboarding-refresh').onclick=refresh;
 $('onboarding-close').onclick=()=>dialog.close();
 $('onboarding-cancel').onclick=async()=>{cancelled=true;message('正在取消，请稍候…');render();try{await call('Cancel')}catch(e){message('取消请求失败，请稍候重试：'+String(e),'error');cancelled=false;render()}};
 for(const id of ['onboarding-open','onboarding-settings'])$(id).onclick=()=>{$('settings').close();open()};
 return {open,progress:p=>{if(running&&!cancelled&&!isCancelled())task(p.message,p.percent)},auto:async()=>{if(!available())return;try{snapshot=await call('SetupStatus');if(!snapshot.complete)await open()}catch{await open()}}};
}
