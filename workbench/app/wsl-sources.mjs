import { spawn } from 'node:child_process';
import { join, posix } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { atomicJson, parse, problem } from './manager.mjs';

const origin=s=>({sourceId:s.id,sourceLabel:s.label,sourceKind:s.kind});
const local={id:'windows',label:process.platform==='win32'?'Windows':'本机',kind:'windows'};

export class WslSource {
  constructor(config,dataDirectory){
    if(!/^[a-z0-9_-]+$/.test(config.id)||config.id==='windows'||!config.distribution||![config.bridgePath,config.nodeExecutable,config.storageRoot,config.dataDirectory].every(v=>typeof v==='string'&&v.startsWith('/')))throw problem('WSL_CONFIG_INVALID','WSL 连接配置不完整。');
    this.config={...config,label:config.label||'WSL · '+config.distribution,kind:'wsl'};
    this.pending=new Map();this.sequence=0;this.child=null;this.ready=null;this.retryAt=0;
    this.cachePath=join(dataDirectory,'source-'+config.id+'.json');
    this.cached=parse(existsSync(this.cachePath)?readFileSync(this.cachePath,'utf8'):'',null);
  }
  prefix(key){return `wsl:${this.config.id}:${key}`;}
  state(value){return value?.project?{...value,projectKey:this.prefix(value.projectKey),project:{...value.project,key:this.prefix(value.project.key),...origin(this.config)}}:value;}
  reply(value){return {...value,...(value.projectKey?{projectKey:this.prefix(value.projectKey)}:{}),...(value.state?{state:this.state(value.state)}:{})};}
  async start(){
    if(this.ready)return this.ready;
    if(Date.now()<this.retryAt)throw problem('SOURCE_UNAVAILABLE',this.lastError||'WSL 暂时无法连接。');
    this.ready=new Promise((done,fail)=>{
      const c=this.config,options=Buffer.from(JSON.stringify({storageRoot:c.storageRoot,dataDirectory:c.dataDirectory})).toString('base64');
      const child=spawn('wsl.exe',['-d',c.distribution,'--exec',c.nodeExecutable,c.bridgePath,options],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      this.child=child;
      let buffer='',stderr='';
      const timer=setTimeout(()=>broken('连接 WSL 超时，请检查发行版是否可启动。'),15000);
      const broken=message=>{
        if(this.child!==child)return;
        clearTimeout(timer);this.lastError=message;this.retryAt=Date.now()+30000;this.child=null;this.ready=null;
        fail(problem('SOURCE_UNAVAILABLE',message));
        for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.fail(problem('SOURCE_UNAVAILABLE',message));}this.pending.clear();
        child.stdin.destroy();child.kill();
      };
      child.on('error',error=>broken('无法启动 WSL：'+error.message));
      child.on('exit',()=>broken('WSL 连接已断开。'+(stderr.trim()? ' '+stderr.trim().slice(-400):'')));
      child.stdin.on('error',()=>broken('无法向 WSL 发送请求。'));
      child.stderr.setEncoding('utf8');child.stderr.on('data',part=>{stderr=(stderr+part).slice(-4000);});
      child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{
        buffer+=part;if(Buffer.byteLength(buffer)>32*1024*1024)return broken('WSL 返回内容过长。');
        let split;
        while((split=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,split);buffer=buffer.slice(split+1);
          let value;try{value=JSON.parse(line);}catch{return broken('WSL 返回格式不正确。');}
          if(value.ready){if(value.protocol!==1)return broken('WSL 连接程序版本不匹配。');clearTimeout(timer);this.lastError=null;done();continue;}
          const p=this.pending.get(value.id);if(!p)continue;clearTimeout(p.timer);this.pending.delete(value.id);
          value.ok?p.done(value.result):p.fail(problem(value.error?.code||'WSL_ERROR',value.error?.message||'WSL 操作失败。'));
        }
      });
    });
    return this.ready;
  }
  async request(method,args={}){
    await this.start();
    return new Promise((done,fail)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pending.delete(id);fail(problem('SOURCE_UNAVAILABLE','WSL 操作超时。请刷新核对结果后再操作。'));this.close();},20000);
      this.pending.set(id,{done,fail,timer});
      this.child.stdin.write(JSON.stringify({id,method,args})+'\n');
    });
  }
  async catalog(){
    let available=true,error;
    try{this.cached=await this.request('catalog');atomicJson(this.cachePath,this.cached);}
    catch(e){available=false;error=e.message;}
    const cached=this.cached||{projects:[],environment:{workspaceCount:0,emptyWorkspaces:[],warnings:[]}};
    return {projects:cached.projects.map(p=>({...p,key:this.prefix(p.key),...origin(this.config),sourceUnavailable:!available})),environment:cached.environment,source:{...origin(this.config),id:this.config.id,label:this.config.label,kind:'wsl',available,error,projectCount:cached.projects.length,workspaceCount:cached.environment.workspaceCount,storageRoot:this.config.storageRoot,dataDirectory:this.config.dataDirectory,distribution:this.config.distribution}};
  }
  unc(folder){if(typeof folder!=='string'||!folder.startsWith('/'))throw problem('INVALID_INPUT','WSL 文件夹路径无效。');return '\\\\wsl.localhost\\'+this.config.distribution+posix.normalize(folder).replaceAll('/','\\');}
  close(){const child=this.child;this.child=null;this.ready=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.fail(problem('SOURCE_UNAVAILABLE','WSL 连接已关闭。'));}this.pending.clear();if(child){child.stdin.end();const timer=setTimeout(()=>child.kill(),2000);timer.unref();child.once('exit',()=>clearTimeout(timer));}}
}

export class UnifiedProjects {
  constructor(manager,configs=[]){this.manager=manager;this.sources=configs.filter(c=>c.enabled!==false).map(c=>new WslSource(c,manager.dataDirectory));if(new Set(this.sources.map(s=>s.config.id)).size!==this.sources.length)throw problem('WSL_CONFIG_INVALID','WSL 来源编号重复。');}
  route(key){if(typeof key!=='string'||!key.startsWith('wsl:'))return null;const match=/^wsl:([^:]+):([a-f0-9]{24})$/.exec(key),source=match&&this.sources.find(s=>s.config.id===match[1]);if(!source)throw problem('PROJECT_NOT_FOUND','没有找到此 WSL 项目来源。');return {source,key:match[2]};}
  async catalog(){
    const native=this.manager.catalog(),remote=await Promise.all(this.sources.map(s=>s.catalog()));
    const projects=[...native.projects.map(p=>({...p,...origin(local)})),...remote.flatMap(r=>r.projects)];
    const env=native.environment;
    const sources=[{...local,available:true,projectCount:native.projects.length,workspaceCount:env.workspaceCount,storageRoot:this.manager.storageRoots[0],dataDirectory:this.manager.dataDirectory},...remote.map(r=>r.source)];
    return {...native,projects,environment:{...env,sources,workspaceCount:sources.reduce((n,s)=>n+(s.workspaceCount||0),0),emptyWorkspaces:[...env.emptyWorkspaces.map(e=>({...e,...origin(local)})),...remote.flatMap(r=>(r.environment.emptyWorkspaces||[]).map(e=>({...e,sourceId:r.source.id,sourceLabel:r.source.label,sourceKind:'wsl'})))],warnings:[...env.warnings,...remote.flatMap(r=>r.source.available?(r.environment.warnings||[]).map(w=>r.source.label+'：'+w):[r.source.label+'：'+r.source.error])]}};
  }
  async state(key){const r=this.route(key);return r?r.source.state(await r.source.request('state',{key:r.key})):this.localState(this.manager.state(key));}
  localState(s){return s.project?{...s,project:{...s.project,...origin(local)}}:s;}
  async change(body){const r=this.route(body.projectKey);if(!r){const result=this.manager.change(body);return {...result,state:this.localState(result.state)};}return r.source.reply(await r.source.request('change',{...body,projectKey:r.key}));}
  remember(key){this.manager.registry.lastProjectKey=key;this.manager.persist();}
  async switch(key){const r=this.route(key);if(!r){const result=this.manager.switch(key);return {...result,state:this.localState(result.state)};}const result=r.source.reply(await r.source.request('switch',{key:r.key}));this.remember(result.projectKey);return result;}
  folderRoute(body){
    const value=body.workspaceRoot;
    const match=typeof value==='string'&&/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(value);
    let source;
    if(match)source=this.sources.find(s=>s.config.distribution.toLowerCase()===match[1].toLowerCase());
    else if(body.sourceId&&body.sourceId!=='windows')source=this.sources.find(s=>s.config.id===body.sourceId);
    else if(process.platform==='win32'&&typeof value==='string'&&value.startsWith('/')&&this.sources.length===1)source=this.sources[0];
    if((match||body.sourceId&&body.sourceId!=='windows'||process.platform==='win32'&&typeof value==='string'&&value.startsWith('/'))&&!source)throw problem('SOURCE_REQUIRED','请选择已连接的 WSL 来源。');
    if(!source)return null;
    const workspaceRoot=match?(match[2]||'/').replaceAll('\\','/'):value;
    if(typeof workspaceRoot!=='string'||!workspaceRoot.startsWith('/'))throw problem('INVALID_INPUT','请输入 WSL 的完整文件夹路径。');
    return {source,body:{...body,workspaceRoot:posix.normalize(workspaceRoot)}};
  }
  async open(body,action='open'){const r=this.folderRoute(body);if(!r){const result=this.manager[action](body);return result.state?{...result,state:this.localState(result.state)}:result;}const result=r.source.reply(await r.source.request(action,r.body));if(result.projectKey)this.remember(result.projectKey);return {...result,sourceId:r.source.config.id};}
  async folder(key){const r=this.route(key);return r?r.source.unc((await r.source.request('folder',{key:r.key})).workspaceRoot):this.manager.context(key).entry.workspaceRoot;}
  stateFolder(id){if(!id||id==='windows')return this.manager.storageRoots[0];const s=this.sources.find(s=>s.config.id===id);if(!s)throw problem('SOURCE_REQUIRED','没有找到此来源。');return s.unc(s.config.storageRoot);}
  close(){this.sources.forEach(s=>s.close());}
}
