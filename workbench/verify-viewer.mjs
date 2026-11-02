import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createWorkbench} from './app/server.mjs';
import {createReadOnlyViewer} from './app/viewer.mjs';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {gunzipSync} from 'node:zlib';
const root=mkdtempSync(join(tmpdir(),'workbench-viewer-'));mkdirSync(root,{recursive:true});
const folder=join(root,'fixture');mkdirSync(folder);
const app=await createWorkbench({dataDirectory:join(root,'hub'),storageRoot:join(root,'states'),publishRunning:false,skipNativeOpen:true});
const entry=app.manager.create({workspaceRoot:folder,name:'平板只读测试'});
const viewer=await createReadOnlyViewer({upstream:app.baseUrl,publicHost:'fixture.example.ts.net:8443',allowedLogin:'owner@example.invalid'});
const checks=[];
const headers={host:'fixture.example.ts.net:8443','tailscale-user-login':'owner@example.invalid'};
async function get(path='/api/projects',extra={}){return new Promise((done,fail)=>{const request=http.get(viewer.baseUrl+path,{headers:{...headers,...extra},agent:false},response=>{let text='';response.setEncoding('utf8');response.on('data',s=>text+=s);response.on('end',()=>done({status:response.statusCode,json:async()=>JSON.parse(text)}));});request.on('error',fail);});}
async function document(encoding){return new Promise((done,fail)=>{http.get(viewer.baseUrl+'/',{headers:{...headers,'accept-encoding':encoding},agent:false},response=>{const chunks=[];response.on('data',part=>chunks.push(part));response.on('end',()=>done({headers:response.headers,bytes:Buffer.concat(chunks)}));}).on('error',fail);});}
try{
 assert.equal(viewer.server.address().address,'127.0.0.1');checks.push('只读入口仅监听本机回环地址');
 assert.equal((await get('/',{'tailscale-user-login':''})).status,403);assert.equal((await get('/api/projects',{'tailscale-user-login':'other@example.invalid'})).status,403);checks.push('缺少身份或非获准账号均无法读取页面与项目');
 assert.equal((await get('/',{host:'evil.example'})).status,403);checks.push('非指定访问域名被拒绝');
 const catalog=await (await get()).json();assert(catalog.readOnly);assert.equal(catalog.projects.length,1);checks.push('获准身份可读取原项目列表，明确标记只读');
 const packedCatalog=await new Promise((done,fail)=>http.get(viewer.baseUrl+'/api/projects',{headers:{...headers,'accept-encoding':'gzip'},agent:false},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>done({encoding:response.headers['content-encoding'],data:Buffer.concat(chunks)}));}).on('error',fail));
 assert.equal(packedCatalog.encoding,'gzip');const decodedCatalog=JSON.parse(gunzipSync(packedCatalog.data));assert.equal(decodedCatalog.projects.length,1);assert.equal(decodedCatalog.readOnly,true);checks.push('压缩后的项目数据仍完整保留来源与只读标记');
 let state=await (await get('/api/state?project='+entry.projectKey)).json();assert(state.readOnly);assert.equal(state.canEdit,false);assert.equal(state.projectKey,entry.projectKey);checks.push('项目详情与原版本一致，编辑能力关闭');
 for(const method of ['POST','PUT','DELETE','PATCH']){
  const response=await fetch(viewer.baseUrl+'/api/change',{method,headers:{...headers,'content-type':'application/json'},body:JSON.stringify({action:'create-task',projectKey:entry.projectKey,expectedRevision:state.revision,taskId:'BAD',goal:'不允许写入',acceptanceCriteria:['不应写入']})});assert.equal(response.status,405);
 }
 assert.equal(app.manager.state(entry.projectKey).tasks.length,0);checks.push('所有写入方法被入口拒绝，原状态没有变化');
 for(const path of ['/api/project','/workbench.json','/../workbench.json','/api/state?project=x&action=create'])assert((await get(path)).status>=400);checks.push('不能调用文件夹操作、下载连接配置或增加未知读取参数');
 const localHeaders={Origin:app.baseUrl,'Content-Type':'application/json','X-Project-Board':'1'};
 const saved=await fetch(app.baseUrl+'/api/change',{method:'POST',headers:localHeaders,body:JSON.stringify({action:'create-task',projectKey:entry.projectKey,expectedRevision:state.revision,taskId:'LOCAL-01',goal:'电脑端继续编辑',acceptanceCriteria:['平板随后可见']})});assert.equal(saved.status,200);checks.push('电脑原编辑入口保持可用');
 state=await(await get('/api/state?project='+entry.projectKey)).json();assert.equal(state.tasks[0].taskId,'LOCAL-01');checks.push('电脑新修改可在只读入口即时读取');
 for(const path of ['/','/app.js','/style.css'])assert.equal((await get(path)).status,200);checks.push('页面及本地资源均能经只读入口读取');
 const bundled=await document('gzip');assert.equal(bundled.headers['content-encoding'],'gzip');assert.equal(Number(bundled.headers['content-length']),bundled.bytes.length);
 const html=gunzipSync(bundled.bytes).toString('utf8');assert(html.includes('<style>'));assert(!html.includes('href="/style.css"'));assert(!html.includes('src="/app.js"'));assert(html.includes('function renderHome()'));
 const scriptNonce=/<script nonce="([^"]+)">/.exec(html)?.[1];assert(scriptNonce);assert(bundled.headers['content-security-policy'].includes("'nonce-"+scriptNonce+"'"));assert(html.indexOf('<script nonce=')>html.indexOf('id="editor"'));checks.push('私网页面一次包含完整样式与程序，程序位于页面内容之后且受随机 nonce 保护');
 assert(bundled.bytes.length<Buffer.byteLength(html)*0.35);checks.push('页面压缩后小于原体积35%，减少移动私网传输量');
 const plain=await document('gzip;q=0, identity');assert.equal(plain.headers['content-encoding'],undefined);assert(plain.bytes.toString('utf8').includes('<style>'));checks.push('不支持或禁用压缩的浏览器仍能读取完整页面');
 assert.equal((await get('/?project='+entry.projectKey)).status,200);assert.equal((await get('/index.html?project='+entry.projectKey)).status,200);assert.equal((await get('/?action=create')).status,400);checks.push('可刷新或收藏带项目的页面地址，未知参数仍被拒绝');
 const preview=await createReadOnlyViewer({upstream:app.baseUrl});try{assert.equal((await fetch(preview.baseUrl+'/api/projects')).status,200);assert.equal((await fetch(preview.baseUrl+'/api/change',{method:'POST'})).status,405);}finally{await preview.close();}checks.push('仅本机的预览模式仍然阻止写入');
 const integrated=await createWorkbench({dataDirectory:join(root,'integrated-hub'),storageRoot:join(root,'states'),publishRunning:false,remoteView:{enabled:true,port:0,publicHost:'fixture.example.ts.net:8443',allowedLogin:'owner@example.invalid'}});
 try{assert(integrated.viewer);assert.equal((await fetch(integrated.viewer.baseUrl+'/api/projects',{headers:{'tailscale-user-login':'owner@example.invalid'}})).status,200);assert.equal((await fetch(integrated.baseUrl+'/api/health')).status,200);}finally{await integrated.close();}checks.push('正常启动同时建立独立查看入口，电脑服务与查看服务共同关闭');
 const incomplete=await createWorkbench({dataDirectory:join(root,'incomplete-hub'),storageRoot:join(root,'states'),publishRunning:false,remoteView:{enabled:true}});
 try{assert.equal(incomplete.viewer,null);assert.equal((await fetch(incomplete.baseUrl+'/api/health')).status,200);}finally{await incomplete.close();}checks.push('远程配置未完成时保留电脑工作台可用，不提前开放查看');
 const privateHttp=await createReadOnlyViewer({upstream:app.baseUrl,scheme:'http',publicHost:'fixture.example.ts.net:8080',allowedLogin:'owner@example.invalid'});
 try{assert.equal(privateHttp.publicUrl,'http://fixture.example.ts.net:8080');assert.equal((await fetch(privateHttp.baseUrl+'/api/projects')).status,403);const result=await fetch(privateHttp.baseUrl+'/api/state?project='+entry.projectKey,{headers:{'tailscale-user-login':'owner@example.invalid'}}).then(r=>r.json());assert.equal(result.baseUrl,privateHttp.publicUrl);assert.equal(result.canEdit,false);}finally{await privateHttp.close();}checks.push('私网 HTTP 使用同一身份与只读保护，返回正确地址');
 const report={passed:checks.length,checks,fixtureOnly:true,externalDeviceNotYetConnected:true};writeFileSync(join(root,'只读入口验证.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report,null,2));
}finally{await viewer.close();await app.close();}
