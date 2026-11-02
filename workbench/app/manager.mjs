import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, basename, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ProjectStateStore } from './engine/store.js';
import { describeWorkspace } from './engine/workspace-store.js';
import { createProjectContext, defaultSettings } from './project-store.mjs';

export const APP_ID = 'project-workbench';
export const VERSION = '1.3.2';
export const SETTINGS_ID = 'D-PROJECT-SETTINGS';
export const parse = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };
export const problem = (code, message) => Object.assign(new Error(message), { code });
export const defaultDataDirectory = () => join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ProjectWorkbench');
export function atomicJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8'); renameSync(temporary, path);
}
export function detectSharedRoot() {
  const base = join(homedir(), '.codex', 'plugins', 'cache', 'personal', 'project-shared-state');
  if (!existsSync(base)) return null;
  const versions = readdirSync(base).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    try {
      const config = JSON.parse(readFileSync(join(base, version, '.mcp.json'), 'utf8'));
      const root = Object.values(config.mcpServers || {}).find(v => v.env?.PROJECT_STATE_ROOT)?.env.PROJECT_STATE_ROOT;
      if (typeof root === 'string' && isAbsolute(root)) return resolve(root);
    } catch {}
  }
  return null;
}
function canonicalFolder(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory()) throw problem('WORKSPACE_NOT_FOUND', '请选择一个存在的项目文件夹。');
  return realpathSync.native(resolve(value));
}
const identityPath=p=>process.platform==='win32'?p.toLowerCase():p;
function samePath(a,b) { return identityPath(resolve(a)) === identityPath(resolve(b)); }
function keyFor(root, database, project) { return createHash('sha256').update([identityPath(root), identityPath(database), project].join('\0')).digest('hex').slice(0,24); }
function readProjects(databasePath) {
  if (!existsSync(databasePath)) return [];
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare('SELECT project_id,revision,updated_at FROM projects ORDER BY updated_at DESC').all().map(p => {
      const settings = parse(db.prepare('SELECT decision FROM decisions WHERE project_id=? AND decision_id=?').get(p.project_id, SETTINGS_ID)?.decision, {});
      return { projectId:p.project_id, name:settings?.name || p.project_id, revision:p.revision, updatedAt:p.updated_at };
    });
  } finally { db.close(); }
}

export class ProjectManager {
  constructor(options = {}) {
    this.dataDirectory = resolve(options.dataDirectory || defaultDataDirectory());
    mkdirSync(this.dataDirectory, {recursive:true});
    this.registryPath = join(this.dataDirectory, 'projects.json');
    const saved = parse(existsSync(this.registryPath) ? readFileSync(this.registryPath,'utf8') : '', null);
    if (saved === null && existsSync(this.registryPath)) throw problem('REGISTRY_INVALID', '项目列表文件无法读取。请保留原文件并检查备份，不会覆盖它。');
    this.registry = saved || {version:1,projects:[],lastProjectKey:null};
    this.contexts = new Map();
    const nativeRoot = options.storageRoot ? null : process.env.PROJECT_STATE_ROOT || detectSharedRoot();
    this.storageRoots = [...new Set([options.storageRoot || nativeRoot || join(this.dataDirectory,'workspaces'), ...(options.storageRoot ? [] : [join(this.dataDirectory,'workspaces')])].map(root=>resolve(root)))];
    const bootstrap = parse(existsSync(join(this.dataDirectory,'bootstrap.json')) ? readFileSync(join(this.dataDirectory,'bootstrap.json'),'utf8') : '', {});
    for (const e of bootstrap.entries || []) {
      if (!existsSync(e.workspaceRoot) || !existsSync(e.databasePath)) continue;
      const root=canonicalFolder(e.workspaceRoot), key=keyFor(root,resolve(e.databasePath),e.projectId);
      if(!this.registry.projects.some(p=>p.key===key)) this.registry.projects.push({...e,workspaceRoot:root,databasePath:resolve(e.databasePath),key});
    }
    this.discover();
    this.persist();
  }
  persist() { atomicJson(this.registryPath,this.registry); }
  discover() {
    const warnings=[], emptyWorkspaces=[];
    let workspaceCount=0, changed=false;
    for(const storageRoot of this.storageRoots){
      if(!existsSync(storageRoot)) continue;
      let folders, actualRoot;
      try { actualRoot=realpathSync.native(storageRoot);folders=readdirSync(storageRoot,{withFileTypes:true}); }
      catch { warnings.push('无法读取共享状态目录：'+storageRoot);continue; }
      for(const folder of folders){
        if(!folder.isDirectory() || folder.isSymbolicLink()) continue;
        const stateDirectory=join(storageRoot,folder.name), metadataPath=join(stateDirectory,'workspace.json'), databasePath=join(stateDirectory,'state.db');
        if(!existsSync(metadataPath)||!existsSync(databasePath)) continue;
        try{
          const actualDirectory=realpathSync.native(stateDirectory);
          if(!actualDirectory.toLowerCase().startsWith((actualRoot+sep).toLowerCase())) throw new Error('工作区目录超出共享状态位置。');
          const metadata=parse(readFileSync(metadataPath,'utf8'));
          if(!metadata || typeof metadata.rootPath!=='string' || !isAbsolute(metadata.rootPath)) throw new Error('工作区元数据无效。');
          const workspaceRoot=existsSync(metadata.rootPath)?canonicalFolder(metadata.rootPath):resolve(metadata.rootPath);
          const projects=readProjects(databasePath);workspaceCount++;
          if(!projects.length) emptyWorkspaces.push({name:metadata.name||basename(workspaceRoot),workspaceRoot});
          for(const project of projects){
            const key=keyFor(workspaceRoot,resolve(databasePath),project.projectId);
            if(this.registry.projects.some(p=>p.key===key)) continue;
            this.registry.projects.push({key,workspaceRoot,databasePath:resolve(databasePath),projectId:project.projectId,name:project.name,discovered:true});
            changed=true;
          }
        }catch(error){warnings.push('未能读取工作区 '+folder.name+'：'+error.message);}
      }
    }
    this.environment={scope:'global',storageRoots:this.storageRoots,dataDirectory:this.dataDirectory,workbenchDirectory:resolve(dirname(fileURLToPath(import.meta.url)),'..'),workspaceCount,emptyWorkspaces,warnings};
    if(changed) this.persist();
  }
  context(key) {
    if(typeof key !== 'string' || !key) throw problem('PROJECT_REQUIRED','请先选择一个项目。');
    const entry=this.registry.projects.find(p=>p.key===key);
    if(!entry) throw problem('PROJECT_NOT_FOUND','此项目尚未连接，请从项目首页打开。');
    if(!existsSync(entry.workspaceRoot)||!existsSync(entry.databasePath)) throw problem('PROJECT_MISSING','项目文件夹或共享记录已移动，请重新选择项目文件夹。');
    if(!this.contexts.has(key)) this.contexts.set(key,createProjectContext(new ProjectStateStore(entry.databasePath),entry));
    return this.contexts.get(key);
  }
  catalog() {
    this.discover();
    const projects=this.registry.projects.map(e=>{
      let info={key:e.key,name:e.name||e.initialSettings?.name||e.projectId,description:e.description||e.initialSettings?.description||'',workspaceRoot:e.workspaceRoot,projectId:e.projectId,taskCount:0,completedCount:0,missing:!existsSync(e.workspaceRoot)||!existsSync(e.databasePath)};
      if(!info.missing){
        let db;
        try{
          db=new DatabaseSync(e.databasePath,{readOnly:true});
          const settings=parse(db.prepare('SELECT decision FROM decisions WHERE project_id=? AND decision_id=?').get(e.projectId,SETTINGS_ID)?.decision,null)||defaultSettings(e);
          const tasks=db.prepare('SELECT task_id,status FROM tasks WHERE project_id=?').all(e.projectId).filter(t=>!(settings.administrativeTaskIds||[]).includes(t.task_id));
          info={...info,name:settings.name,description:settings.description,taskCount:tasks.length,completedCount:tasks.filter(t=>t.status==='completed').length};
        }catch{info.missing=true;}finally{db?.close();}
      }
      return info;
    });
    return {projects,lastProjectKey:this.registry.lastProjectKey,environment:this.environment};
  }
  inspect(value) {
    this.discover();
    const workspaceRoot=canonicalFolder(value);
    const known=this.registry.projects.filter(e=>samePath(e.workspaceRoot,workspaceRoot)&&existsSync(e.databasePath));
    const databases=[...new Set([...known.map(e=>e.databasePath),...this.storageRoots.map(root=>describeWorkspace(workspaceRoot,root).databasePath)])];
    for(const databasePath of databases){
      let projects;
      try{projects=readProjects(databasePath);}catch{throw problem('DATABASE_READ_ERROR','现有共享记录无法读取，已保留原文件。');}
      if(projects.length) return {workspaceRoot,databasePath,projects};
    }
    return {workspaceRoot,projects:[]};
  }
  register(entry) {
    const key=keyFor(entry.workspaceRoot,entry.databasePath,entry.projectId);
    if(!this.registry.projects.some(e=>e.key===key)) this.registry.projects.push({...entry,key});
    this.registry.lastProjectKey=key; this.persist();
    return {ok:true,projectKey:key,state:this.context(key).sync()};
  }
  open(body) {
    const found=this.inspect(body.workspaceRoot);
    if(!found.projects.length) return {ok:true,needsCreation:true,workspaceRoot:found.workspaceRoot,suggestedName:basename(found.workspaceRoot)};
    if(!body.projectId&&found.projects.length>1) return {ok:true,needsProjectChoice:true,workspaceRoot:found.workspaceRoot,projects:found.projects};
    const selected=body.projectId ? found.projects.find(p=>p.projectId===body.projectId) : found.projects[0];
    if(!selected) throw problem('PROJECT_NOT_FOUND','此文件夹内没有选择的项目。');
    return this.register({workspaceRoot:found.workspaceRoot,databasePath:found.databasePath,projectId:selected.projectId,name:selected.name});
  }
  create(body) {
    const workspaceRoot=canonicalFolder(body.workspaceRoot), name=String(body.name||'').trim(), goal=String(body.goal||'').trim();
    if(!name||name.length>120||goal.length>12000) throw problem('INVALID_INPUT','请填写合适的项目名称与目标。');
    const projectId=String(body.projectId||basename(workspaceRoot)).trim();
    if(!projectId||projectId.length>150) throw problem('INVALID_INPUT','项目名称过长。');
    const existing=this.inspect(workspaceRoot);
    if(existing.projects.some(p=>p.projectId===projectId)) throw problem('PROJECT_EXISTS','这个文件夹已经有项目，请使用“打开项目”。');
    const workspace=describeWorkspace(workspaceRoot,this.storageRoots[0]);
    const databasePath=existing.databasePath||workspace.databasePath;
    mkdirSync(workspace.stateDirectory,{recursive:true});
    const metadata=join(workspace.stateDirectory,'workspace.json');
    if(!existsSync(metadata)) writeFileSync(metadata,JSON.stringify({workspaceId:workspace.workspaceId,name:workspace.name,rootPath:workspace.rootPath,createdAt:new Date().toISOString()},null,2),'utf8');
    const entry={workspaceRoot,databasePath,projectId,name};
    const settings={...defaultSettings(entry),name,goal};
    const store=new ProjectStateStore(databasePath);
    try { store.recordDecision({projectId,actorId:'user',decisionId:SETTINGS_ID,subject:'项目设置',decision:JSON.stringify(settings),status:'accepted',evidence:['用户在通用项目工作台主动新建项目。'],expectedRevision:0}); }
    finally{store.close();}
    return this.register(entry);
  }
  switch(key) { const context=this.context(key);this.registry.lastProjectKey=key;this.persist();return {ok:true,projectKey:key,state:context.sync()}; }
  state(key) {
    if(!key) return {needProject:true,project:null,projectKey:null,tasks:[],decisions:[],events:[],operations:[],artifacts:[],phases:[],settings:{phases:[]},internalDecisionIds:[],revision:0,rules:'',canEdit:false,readAt:new Date().toISOString()};
    return this.context(key).sync();
  }
  change(body) { return {ok:true,...this.context(body.projectKey).mutate(body)}; }
  close() { for(const c of this.contexts.values())c.store.close();this.contexts.clear(); }
}
