// First-run setup uses the same native operations as advanced settings.
export function createOnboarding({call,available,busy,isCancelled=()=>false,onBusy,onDone}) {
 const $=id=>document.getElementById(id),dialog=$('onboarding');
 let snapshot=null,running=false,checking=false,cancelled=false,finished=false,started=0,timer=null,phase='';
 const message=(text,tone='info')=>{ $('onboarding-message').textContent=text;$('onboarding-message').dataset.tone=tone; };
 function render(){
  const s=snapshot,needRuntime=!s?.verification,dependencies=!!s?.python&&!!s?.node;
  $('onboarding-python').textContent=s?.python?'Python 已找到':'Python 3.12+ · 未找到';
  $('onboarding-node').textContent=s?.node?'Node.js 已找到':'Node.js · 未找到';
  $('onboarding-python-link').hidden=!!s?.python;$('onboarding-node-link').hidden=!!s?.node;
  $('onboarding-platform').textContent=s?`${s.platform} · ${s.supported?'支持本机安装':'暂不支持此平台，请使用 macOS Apple Silicon 或 Windows x64'}`:'正在检查本机环境…';
  for(const [id,ready] of [['ocr',s?.ocrModels&&s?.ocrEngine],['jev',s?.verification]]){$('onboarding-'+id).textContent=ready?'已安装':'待安装';}
  $('onboarding-start').disabled=running||checking||!s?.supported||(needRuntime&&!dependencies);
  $('onboarding-start').textContent=running?'正在准备…':finished?'重新检查连接':s?.complete?'启动并检查连接':'开始 / 继续安装';
  $('onboarding-refresh').disabled=running||checking;$('onboarding-source').disabled=running||checking;
  $('onboarding-cancel').hidden=!running;$('onboarding-cancel').disabled=cancelled;
  $('onboarding-close').textContent=running?'后台继续':finished?'开始使用':'稍后设置';
  $('onboarding-runtime-help').hidden=!needRuntime||dependencies;
 }
 async function refresh(){
  if(running||checking)return;checking=true;render();
  try{snapshot=await call('SetupStatus');message(snapshot.complete?'模型与环境已安装，点击下方按钮启动并检查连接。':snapshot.supported?'请完成环境检查，然后开始安装；下载中断后可继续。':'本机平台暂不支持自动安装。');}
  catch(e){snapshot=null;message('环境检查失败：'+String(e?.message||e)+'。请重新检查。','error')}
  finally{checking=false;render()}
 }
 async function open(){
  if(!dialog.open)dialog.showModal();
  if(!available()){message('请在 PaperLens 桌面应用中使用安装引导。','error');render();return;}
  if(!running)await refresh();else render();
 }
 const guard=()=>{if(cancelled||isCancelled())throw Error('已取消');};
 async function request(name,...args){guard();const result=await call(name,...args);guard();return result;}
 function stage(text){phase=text;$('onboarding-phase').textContent=text;$('onboarding-progress').removeAttribute('value');message(text);}
 async function waitReady(kind){
  const name=kind==='ocr'?'OCR':'核验';stage(`正在加载${name}模型并检查连接…`);
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
  timer=setInterval(()=>{$('onboarding-elapsed').textContent=`已用时 ${Math.floor((Date.now()-started)/1000)} 秒 · 可后台继续或取消`;},1000);
  try{
   snapshot=await request('SetupStatus');render();
   if(!snapshot.supported)throw Error('此平台暂不支持自动安装');
   if(!snapshot.verification&&(!snapshot.python||!snapshot.node))throw Error('请先安装缺少的 Python / Node.js，再重新检查。');
   if(!snapshot.ocrModels||!snapshot.ocrEngine){await request('StopEngine');}
   if(!snapshot.ocrModels){stage('1 / 3 · 下载 OCR 模型（约 2 GB）');await request('DownloadModels',$('onboarding-source').value);snapshot.ocrModels=true;render();}
   if(!snapshot.ocrEngine){stage('1 / 3 · 安装 OCR 推理引擎');await request('InstallEngine');snapshot.ocrEngine=true;render();}
   if(!snapshot.verification){await request('StopLocalJev');stage('2 / 3 · 安装独立核验与版面分析（模型约 2.7 GB）');await request('InstallLocalJev');snapshot.verification=true;render();}
   stage('3 / 3 · 检查已安装文件');snapshot=await request('SetupStatus');if(!snapshot.complete)throw Error('仍有组件未安装完整，请重试。');
   await waitReady('ocr');await waitReady('jev');await request('CheckSetupRuntime');
   guard();finished=true;$('onboarding-progress').value=1;phase='安装完成';$('onboarding-phase').textContent=phase;
   message('准备完成：OCR、独立核验和版面分析均已就绪，可以导入文档开始识别。','success');
  }catch(e){
   if(cancelled||isCancelled()){await Promise.allSettled([call('StopEngine'),call('StopLocalJev')]);message('已取消。已完成的下载保留，下次点击“开始 / 继续安装”即可重试。','warning');}
   else message('准备失败：'+String(e?.message||e)+' 已完成的文件保留，可重新检查后重试。','error');
  }finally{clearInterval(timer);running=false;onBusy(false);$('onboarding-elapsed').textContent=`本次用时 ${Math.floor((Date.now()-started)/1000)} 秒`;render();await onDone().catch(()=>{});}
 }
 $('onboarding-start').onclick=start;$('onboarding-refresh').onclick=refresh;
 $('onboarding-close').onclick=()=>dialog.close();
 $('onboarding-cancel').onclick=async()=>{cancelled=true;message('正在取消，请稍候…');render();try{await call('Cancel')}catch(e){message('取消请求失败，请稍候重试：'+String(e),'error');cancelled=false;render()}};
 for(const component of ['python','node'])$('onboarding-'+component+'-link').onclick=()=>call('OpenSetupDownload',component).catch(e=>message(String(e),'error'));
 for(const id of ['onboarding-open','onboarding-settings'])$(id).onclick=()=>{$('settings').close();open()};
 return {open,progress:p=>{if(running){$('onboarding-phase').textContent=phase+' · '+p.message;if(p.percent>0)$('onboarding-progress').value=Math.min(1,p.percent);else $('onboarding-progress').removeAttribute('value');}},auto:async()=>{if(!available())return;try{snapshot=await call('SetupStatus');if(!snapshot.complete)await open()}catch{await open()}}};
}
