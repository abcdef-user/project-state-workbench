const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process');
const args=process.argv.slice(2),noOpen=args.includes('--no-open');
function option(key){const i=args.indexOf(key);return i<0?null:args[i+1];}
const configFile=path.join(__dirname,'..','workbench.json');
const config=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,'')):{};
const configuredPath=value=>typeof value==='string'&&value?path.resolve(path.dirname(configFile),value):null;
const dataDirectory=path.resolve(option('--data-dir')||configuredPath(config.dataDirectory)||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'ProjectWorkbench'));
const storageRoot=option('--storage-root')||configuredPath(config.storageRoot),folder=option('--folder');
fs.mkdirSync(dataDirectory,{recursive:true});
const runningFile=path.join(dataDirectory,'running.json'),lockPath=path.join(dataDirectory,'startup.lock');
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
function request(url,body){return new Promise((done,fail)=>{
  const u=new URL(url),text=body?JSON.stringify(body):null;
  const req=http.request(u,{agent:false,method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Project-Board':'1',Origin:u.origin,'Content-Length':Buffer.byteLength(text)}:{}},res=>{let data='';res.setEncoding('utf8');res.on('data',s=>data+=s);res.on('end',()=>{try{const result=JSON.parse(data);if(res.statusCode>=400)return fail(new Error(result.error||'本地服务返回错误。'));done(result);}catch(e){fail(e);}});});
  req.setTimeout(body?45000:2000,()=>req.destroy(new Error('连接超时')));req.on('error',fail);if(text)req.write(text);req.end();
});}
async function existing(){const run=readJson(runningFile);if(!run?.baseUrl||!/^http:\/\/127\.0\.0\.1:\d+$/.test(run.baseUrl))return null;try{const health=await request(run.baseUrl+'/api/health');return health.app==='project-workbench'&&path.resolve(health.dataDirectory)===dataDirectory?run:null;}catch{return null;}}
async function main(){
  let current=await existing(),locked=false;
  if(!current){
    try{fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,createdAt:Date.now()}),{flag:'wx'});locked=true;}catch(e){
      if(e.code!=='EEXIST')throw e;
      const lock=readJson(lockPath);let alive=true;try{if(lock?.pid)process.kill(lock.pid,0);else alive=Date.now()-fs.statSync(lockPath).mtimeMs<20000;}catch{alive=false;}
      if(!alive){fs.unlinkSync(lockPath);fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid}),{flag:'wx'});locked=true;}
    }
    try{
      if(locked){
        const serverArgs=[path.join(__dirname,'server.mjs'),'--data-dir',dataDirectory,'--port',option('--port')||'8769'];if(storageRoot)serverArgs.push('--storage-root',path.resolve(storageRoot));
        if(fs.existsSync(configFile))serverArgs.push('--config-file',configFile);
        const out=fs.openSync(path.join(dataDirectory,'运行.log'),'a'),err=fs.openSync(path.join(dataDirectory,'错误.log'),'a');
        const child=cp.spawn(process.execPath,serverArgs,{detached:true,windowsHide:true,stdio:['ignore',out,err],cwd:__dirname});child.unref();fs.closeSync(out);fs.closeSync(err);
      }
      for(let i=0;i<60&&!current;i++){await wait(200);current=await existing();}
      if(!current)throw new Error('工作台没有成功启动，请查看 '+path.join(dataDirectory,'错误.log'));
    }finally{if(locked&&readJson(lockPath)?.pid===process.pid){try{fs.unlinkSync(lockPath);}catch{}}}
  }
  let url=current.baseUrl+'/';
  if(folder){const opened=await request(current.baseUrl+'/api/project',{action:'open',workspaceRoot:folder.startsWith('/')?folder:path.resolve(folder)});if(opened.projectKey)url+='?project='+encodeURIComponent(opened.projectKey)+'#overview';}
  if(!noOpen){
    const script="[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); $address=[Console]::In.ReadToEnd().Trim(); Start-Process -FilePath $address -ErrorAction Stop";
    const opened=cp.spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',script],{input:url,encoding:'utf8',windowsHide:true,timeout:20000});
    if(opened.error||opened.status!==0)throw new Error('页面没有打开。'+(opened.error?.message||opened.stderr||'请检查默认浏览器。'));
  }
  process.stdout.write(JSON.stringify({url,pid:current.pid,dataDirectory})+'\n');
}
main().catch(error=>{
  fs.appendFileSync(path.join(dataDirectory,'启动错误.log'),new Date().toISOString()+' '+error.stack+'\n','utf8');
  if(!noOpen)cp.spawnSync('powershell.exe',['-NoProfile','-WindowStyle','Hidden','-Command',"[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show([Console]::In.ReadToEnd(), '项目工作台') | Out-Null"],{input:error.message,encoding:'utf8',windowsHide:true});
  console.error(error.message);process.exitCode=1;
});
