import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { ProjectManager, APP_ID, VERSION, atomicJson, parse, problem } from './manager.mjs';
import { UnifiedProjects } from './wsl-sources.mjs';
import { createReadOnlyViewer } from './viewer.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
function nativePickFolder(){
  return new Promise((done,fail)=>execFile('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',join(HERE,'pick-folder.ps1')],{windowsHide:true,encoding:'utf8',maxBuffer:128000},(err,stdout)=>{
    if(err)return fail(problem('FOLDER_PICKER_ERROR','无法打开文件夹选择窗口，请使用输入路径方式。'));
    const result=parse(stdout.trim());if(!result)return fail(problem('FOLDER_PICKER_ERROR','没有读取到选择的文件夹。'));done(result);
  }));
}
export async function createWorkbench(options={}){
  const manager=new ProjectManager(options);
  const projects=new UnifiedProjects(manager,options.wslSources||[]);
  const runningFile=join(manager.dataDirectory,'running.json');
  let baseUrl;
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{
    const host=`127.0.0.1:${server.address().port}`;
    if(req.headers.host!==host)return json(res,403,{error:'请使用本机工作台地址。'});
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url=new URL(req.url,baseUrl);
    try{
      if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{app:APP_ID,version:VERSION,pid:process.pid,dataDirectory:manager.dataDirectory});
      if(req.method==='GET'&&url.pathname==='/api/projects')return json(res,200,await projects.catalog());
      if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,{...await projects.state(url.searchParams.get('project')),baseUrl});
      if(req.method==='POST'&&['/api/project','/api/change'].includes(url.pathname)){
        if(req.headers.origin!==baseUrl||req.headers['x-project-board']!=='1'||!String(req.headers['content-type']||'').startsWith('application/json'))return json(res,403,{error:'请从项目工作台页面保存。'});
        let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>400000)throw problem('INVALID_INPUT','提交内容过长。');chunks.push(chunk);}
        const body=parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw problem('INVALID_INPUT','提交格式不正确。');
        if(url.pathname==='/api/change')return json(res,200,await projects.change(body));
        if(body.action==='pick-folder')return json(res,200,{ok:true,...await(options.pickFolder||nativePickFolder)()});
        if(body.action==='open')return json(res,200,await projects.open(body));
        if(body.action==='create')return json(res,200,await projects.open(body,'create'));
        if(body.action==='switch')return json(res,200,await projects.switch(body.key));
        if(['open-state-folder','open-program-folder'].includes(body.action)){
          const folder=body.action==='open-state-folder'?projects.stateFolder(body.sourceId):manager.environment.workbenchDirectory;
          if((!body.sourceId||body.sourceId==='windows')&&!existsSync(folder))throw problem('WORKSPACE_NOT_FOUND','这个目录尚未建立。');
          if(!options.skipNativeOpen)spawn('explorer.exe',[folder],{detached:true,stdio:'ignore'}).unref();
          return json(res,200,{ok:true});
        }
        if(body.action==='open-folder'){
          const folder=await projects.folder(body.projectKey);if(!options.skipNativeOpen)spawn('explorer.exe',[folder],{detached:true,stdio:'ignore'}).unref();return json(res,200,{ok:true});
        }
        throw problem('INVALID_INPUT','未知项目操作。');
      }
      if(req.method!=='GET')return json(res,405,{error:'不支持此请求。'});
      const files={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
      const file=files[url.pathname];if(!file)return json(res,404,{error:'没有这个页面。'});
      res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-cache'});res.end(readFileSync(join(HERE,'ui',file[0])));
    }catch(error){
      const code=error.code||'INTERNAL_ERROR'; const conflict=/CONFLICT|OWNED|CLAIMED|EXISTS|COMPLETED|STATE_BUSY/.test(code);
      const messages={REVISION_CONFLICT:'项目已有新修改，请刷新核对。当前输入仍保留。',ACCEPTANCE_CRITERIA_UNMET:'完成依据没有覆盖全部条件。',TASK_CLAIMED:'任务已被其他成员承接。'};
      json(res,conflict?409:400,{ok:false,code,error:messages[code]||error.message});
    }
  });
  try{await new Promise((done,fail)=>{server.once('error',fail);server.listen(options.port??0,'127.0.0.1',done);});}catch(error){projects.close();manager.close();throw error;}
  baseUrl=`http://127.0.0.1:${server.address().port}`;
  let viewer=null,viewerError=null;
  if(options.remoteView?.enabled){
    try{if(!options.remoteView.publicHost||!options.remoteView.allowedLogin)throw new Error('远程查看尚未完成账号配置。');viewer=await createReadOnlyViewer({...options.remoteView,upstream:baseUrl});}
    catch(error){viewerError=error.message;console.error('远程查看未启动：'+viewerError);}
  }
  if(options.publishRunning!==false)atomicJson(runningFile,{app:APP_ID,version:VERSION,pid:process.pid,baseUrl,port:server.address().port,startedAt:new Date().toISOString(),...(viewer?{viewer:{baseUrl:viewer.baseUrl,publicUrl:viewer.publicUrl}}:{}),...(viewerError?{viewerError}:{})});
  const close=async()=>{if(viewer)await viewer.close();await new Promise(done=>server.close(()=>{projects.close();manager.close();if(options.publishRunning!==false&&parse(existsSync(runningFile)?readFileSync(runningFile,'utf8'):'',{})?.pid===process.pid)unlinkSync(runningFile);done();}));};
  return {server,manager,projects,baseUrl,viewer,close};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),opts={};
  for(let i=0;i<args.length;i+=2){const field={'--data-dir':'dataDirectory','--storage-root':'storageRoot','--port':'port','--pick-root':'pickRoot','--config-file':'configFile'}[args[i]];if(!field)throw new Error('未知参数');opts[field]=field==='port'?Number(args[i+1]):resolve(args[i+1]);}
  if(opts.configFile){const config=JSON.parse(readFileSync(opts.configFile,'utf8').replace(/^\uFEFF/,''));opts.wslSources=config.wslSources||[];opts.remoteView=config.remoteView;}
  if(opts.pickRoot){const selected=opts.pickRoot;opts.pickFolder=async()=>({workspaceRoot:selected});}
  let app;try{app=await createWorkbench(opts);}catch(error){if(error.code!=='EADDRINUSE')throw error;app=await createWorkbench({...opts,port:0});}console.log(app.baseUrl);
  process.on('SIGTERM',()=>app.close().then(()=>process.exit(0)));process.on('SIGINT',()=>app.close().then(()=>process.exit(0)));
}
