import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { dirname,resolve,join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createWorkbench } from './app/server.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const root=mkdtempSync(join(tmpdir(),'workbench-verification-'));mkdirSync(root,{recursive:true});
const run=mkdtempSync(join(root,'run-')),dataDirectory=join(run,'app-data'),storageRoot=join(run,'states');
const folderA=join(run,'研究项目'),folderB=join(run,'活动筹备');mkdirSync(folderA);mkdirSync(folderB);
const app=await createWorkbench({dataDirectory,storageRoot,port:0,publishRunning:false,pickFolder:async()=>({workspaceRoot:folderA}),skipNativeOpen:true});
const checks=[];
async function get(path){const res=await fetch(app.baseUrl+path);assert.equal(res.status,200);return res.json();}
async function post(path,body,expected=200,origin=app.baseUrl){const res=await fetch(app.baseUrl+path,{method:'POST',headers:{'Content-Type':'application/json','X-Project-Board':'1',Origin:origin},body:JSON.stringify(body)});const reply=await res.json();assert.equal(res.status,expected,JSON.stringify(reply));return reply;}
const state=key=>get('/api/state?project='+key);
const task=(s,id='TASK-01')=>s.tasks.find(t=>t.taskId===id);
let startedPid;
try{
  assert.equal((await get('/api/projects')).projects.length,0);assert((await get('/api/state')).needProject);checks.push('空白启动只显示项目首页，没有业务预设');
  const needs=await post('/api/project',{action:'open',workspaceRoot:folderA});assert(needs.needsCreation);assert.equal((await get('/api/projects')).projects.length,0);checks.push('打开空目录只询问新建，不自动创建或覆盖');
  let a=await post('/api/project',{action:'create',workspaceRoot:folderA,name:'学习研究',goal:'整理问题并验证结果'}),b=await post('/api/project',{action:'create',workspaceRoot:folderB,name:'活动筹备'});
  const keyA=a.projectKey,keyB=b.projectKey;assert.notEqual(keyA,keyB);assert.equal(a.state.phases.length,0);assert(!/EUV|Blender/.test(JSON.stringify(a.state)));checks.push('不同类型项目都能创建，初始阶段为空');
  await post('/api/project',{action:'create',workspaceRoot:folderA,name:'不能覆盖'},409);checks.push('新建不能覆盖已有项目');
  let sa=a.state,sb=b.state;
  sa=(await post('/api/change',{action:'create-task',projectKey:keyA,expectedRevision:sa.revision,taskId:'TASK-01',goal:'研究问题',acceptanceCriteria:['有可复查的记录']})).state;
  sb=(await post('/api/change',{action:'create-task',projectKey:keyB,expectedRevision:sb.revision,taskId:'TASK-01',goal:'确定活动场地',acceptanceCriteria:['场地已核实']})).state;
  assert.equal(task(await state(keyA)).goal,'研究问题');assert.equal(task(await state(keyB)).goal,'确定活动场地');checks.push('相同任务编号在不同项目中互不影响');
  await post('/api/project',{action:'switch',key:keyB});
  sa=(await post('/api/change',{action:'update-task',projectKey:keyA,expectedRevision:sa.revision,expectedTaskVersion:task(sa).version,taskId:'TASK-01',goal:'研究问题（已调整）',acceptanceCriteria:['有可复查的记录'],reason:'验证多标签隔离'})).state;
  assert.equal(task(await state(keyB)).goal,'确定活动场地');assert.equal(sa.events[0].payload.before.goal,'研究问题');checks.push('其他页面切换项目后，保存仍写入原项目并保留前后记录');
  await post('/api/change',{action:'update-task',expectedRevision:sa.revision,taskId:'TASK-01',goal:'缺项目标识',acceptanceCriteria:['不应写入']},400);checks.push('缺少项目标识不能保存');
  await post('/api/change',{action:'update-task',projectKey:keyA,expectedRevision:0,expectedTaskVersion:task(sa).version,taskId:'TASK-01',goal:'旧状态',acceptanceCriteria:['不应覆盖']},409);checks.push('旧版本写入被拒绝');
  sa=(await post('/api/change',{action:'create-task',projectKey:keyA,expectedRevision:sa.revision,taskId:'NOTE-01',goal:'登记材料',acceptanceCriteria:['已登记']})).state;
  const settings={...sa.settings,name:'我的学习项目',description:'项目设置可以修改',taskPrefix:'LEARN-',phases:[{id:'P1',name:'问题整理',text:'确认对象',tasks:['TASK-01']},{id:'P2',name:'结果核查',text:'',tasks:[]}],administrativeTaskIds:['NOTE-01']};
  sa=(await post('/api/change',{action:'save-settings',projectKey:keyA,expectedRevision:sa.revision,settings})).state;
  assert.equal(sa.project.name,'我的学习项目');assert.equal(sa.phases.length,2);assert.equal(task(sa,'NOTE-01').isAdministrative,true);assert(sa.internalDecisionIds.includes('D-PROJECT-SETTINGS'));checks.push('项目目标、阶段、任务归属和辅助标记可配置并进入历史');
  const bad={...settings,phases:[...settings.phases,{id:'P3',name:'重复归属',text:'',tasks:['TASK-01']}]};
  await post('/api/change',{action:'save-settings',projectKey:keyA,expectedRevision:sa.revision,settings:bad},400);assert.equal((await state(keyA)).revision,sa.revision);checks.push('阶段重复归属被拒绝且不推进版本');
  await post('/api/change',{action:'complete-task',projectKey:keyA,expectedRevision:sa.revision,expectedTaskVersion:task(sa).version,taskId:'TASK-01',evidence:[]},400);
  sa=(await post('/api/change',{action:'complete-task',projectKey:keyA,expectedRevision:sa.revision,expectedTaskVersion:task(sa).version,taskId:'TASK-01',evidence:[{criterion:'有可复查的记录',proof:'隔离测试已保留记录'}]})).state;assert.equal(task(sa).status,'completed');checks.push('完成仍要求覆盖全部条件的依据');
  sa=(await post('/api/change',{action:'reopen-task',projectKey:keyA,expectedRevision:sa.revision,expectedTaskVersion:task(sa).version,taskId:'TASK-01',reason:'需要继续核查'})).state;assert(sa.events.some(e=>e.type==='task_completed'));checks.push('重新打开保留过去的完成历史');
  sa=(await post('/api/change',{action:'save-rules',projectKey:keyA,expectedRevision:sa.revision,rules:'- 所有结果须可核查。'})).state;assert.equal(sa.rules,'- 所有结果须可核查。');checks.push('各项目分别保存登记约定');
  await post('/api/change',{action:'create-task',projectKey:keyA,expectedRevision:sa.revision,taskId:'BAD',goal:'跨站写入',acceptanceCriteria:['不应写入']},403,'https://example.invalid');checks.push('跨站写入被拒绝');
  const cat=await get('/api/projects');assert.equal(cat.projects.find(p=>p.key===keyA).taskCount,1);assert.equal(cat.projects.find(p=>p.key===keyA).name,'我的学习项目');checks.push('最近项目显示当前名称和实际任务统计');
  await post('/api/project',{action:'create',workspaceRoot:folderA,projectId:'另一命名空间',name:'同目录的另一个项目'});
  assert((await post('/api/project',{action:'open',workspaceRoot:folderA})).needsProjectChoice);checks.push('同目录多项目要求选择，不自动混合');
  const mirror=join(folderA,'项目状态','研究项目','当前状态.json');assert(existsSync(mirror));assert.equal(JSON.parse(readFileSync(mirror,'utf8')).projectKey,keyA);checks.push('项目目录自动导出可读状态和约定');
  await app.close();
  const reopened=await createWorkbench({dataDirectory,storageRoot,port:0,publishRunning:false});assert.equal(reopened.manager.state(keyA).project.name,'我的学习项目');await reopened.close();checks.push('重启后项目列表、设置、任务和历史保留');
  const runtime=process.execPath,startup=join(HERE,'app/start.cjs'),startupData=join(run,'startup-data');
  const launchArgs=[startup,'--no-open','--data-dir',startupData,'--storage-root',storageRoot,'--port','8769'];
  const first=JSON.parse(execFileSync(runtime,launchArgs,{encoding:'utf8',timeout:20000}));startedPid=first.pid;
  const second=JSON.parse(execFileSync(runtime,launchArgs,{encoding:'utf8',timeout:20000}));assert.equal(first.pid,second.pid);assert.equal(first.url,second.url);checks.push('一键启动在地址冲突时自动避让，重复启动复用同一服务');
  const stopScript=join(HERE,'../scripts/stop-workbench.mjs');
  const realRunning=JSON.parse(readFileSync(join(startupData,'running.json'),'utf8'));
  writeFileSync(join(startupData,'running.json'),JSON.stringify({...realRunning,pid:process.pid}),'utf8');
  let rejected=false;try{execFileSync(runtime,[stopScript,'--data-dir',startupData],{encoding:'utf8',timeout:10000,stdio:'pipe'});}catch{rejected=true;}
  assert(rejected);assert.equal((await fetch(first.url+'api/health')).status,200);checks.push('停止入口拒绝进程与健康信息不匹配的运行记录');
  writeFileSync(join(startupData,'running.json'),JSON.stringify(realRunning),'utf8');
  execFileSync(runtime,[stopScript,'--data-dir',startupData],{encoding:'utf8',timeout:10000});startedPid=null;
  checks.push('停止入口仅停止已核验的本数据目录工作台');
  const moved=join(run,'任意位置 带空格','app');mkdirSync(moved,{recursive:true});cpSync(join(HERE,'app'),moved,{recursive:true});
  const movedStart=JSON.parse(execFileSync(runtime,[join(moved,'start.cjs'),'--no-open','--data-dir',startupData,'--storage-root',storageRoot],{encoding:'utf8',timeout:20000}));startedPid=movedStart.pid;assert(movedStart.url.startsWith('http://127.0.0.1:'));checks.push('程序放到带空格的新目录仍可启动');
  const report={passed:checks.length,checks,runDirectory:run,fixtureOnly:true};writeFileSync(join(run,'验证结果.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report,null,2));
}finally{try{await app.close();}catch{}if(startedPid)try{process.kill(startedPid);}catch{}}
