import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';

// This loopback-only gateway is the sole target of Tailscale Serve. Never proxy the editor port.
export async function createReadOnlyViewer({upstream,port=0,publicHost,allowedLogin,scheme='https'}={}){
  const backend=new URL(upstream);
  if(backend.hostname!=='127.0.0.1'||backend.protocol!=='http:')throw new Error('只读入口必须连接本机工作台。');
  if(publicHost&&(!/^[a-z0-9.-]+\.ts\.net(?::\d+)?$/i.test(publicHost)||!allowedLogin))throw new Error('远程入口须配置有效域名和获准查看的登录账号。');
  if(!['http','https'].includes(scheme))throw new Error('查看入口协议无效。');
  const paths=new Set(['/','/index.html','/app.js','/style.css','/api/projects','/api/state','/api/health']);
  let baseUrl;
  const json=(res,status,value)=>{res.setHeader('Cache-Control','no-store');staticReply(res.req,res,status,'application/json; charset=utf-8',Buffer.from(JSON.stringify(value),'utf8'));};
  const staticReply=(req,res,status,type,body)=>{
    const compressed=body.length>512&&/(?:^|,)\s*gzip\b(?![^,]*;\s*q=0(?:\.0*)?(?:\s*,|\s*$))/i.test(req.headers['accept-encoding']||'');
    const payload=compressed?gzipSync(body):body;
    res.writeHead(status,{'Content-Type':type,'Content-Length':payload.length,Vary:'Accept-Encoding',...(compressed?{'Content-Encoding':'gzip'}:{})});res.end(payload);
  };
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const validHosts=[`127.0.0.1:${server.address().port}`,...(publicHost?[publicHost]:[])];
    if(!validHosts.includes(req.headers.host))return json(res,403,{error:'请使用指定的查看地址。'});
    // Serve strips forged incoming identity headers and inserts the authenticated user's login.
    if(allowedLogin&&req.headers['tailscale-user-login']!==allowedLogin)return json(res,403,{code:'VIEWER_FORBIDDEN',error:'请使用获准账号连接 Tailscale 后再打开。'});
    if(req.method!=='GET')return json(res,405,{code:'READ_ONLY',error:'平板入口仅供查看，修改请使用本机工作台。'});
    try{
      const url=new URL(req.url,baseUrl);
      if(!paths.has(url.pathname))return json(res,404,{error:'没有这个页面。'});
      if(url.pathname==='/api/health')return json(res,200,{app:'project-workbench-viewer',readOnly:true});
      const projectPage=['/','/index.html','/api/state'].includes(url.pathname);
      if(!projectPage&&url.search)return json(res,400,{error:'查看请求无效。'});
      if(projectPage&&[...url.searchParams.keys()].some(key=>key!=='project'))return json(res,400,{error:'查看请求无效。'});
      const target=new URL(url.pathname+url.search,backend);
      const response=await fetch(target,{redirect:'error',signal:AbortSignal.timeout(40000),headers:{Accept:req.headers.accept||'*/*'}});
      if(url.pathname.startsWith('/api/')){
        const value=await response.json();
        if(!response.ok)return json(res,response.status,value);
        return json(res,200,{...value,readOnly:true,canEdit:false,...(value.environment?{environment:{...value.environment,readOnly:true}}:{}),...(url.pathname==='/api/state'?{baseUrl:publicHost?scheme+'://'+publicHost:baseUrl}:{})});
      }
      const type=response.headers.get('content-type')||'text/plain; charset=utf-8';
      if(response.ok&&type.startsWith('text/html')){
        // One compressed document avoids partially styled pages on slower mobile private links.
        const resources=await Promise.all(['/style.css','/app.js'].map(async path=>{
          const result=await fetch(new URL(path,backend),{redirect:'error',signal:AbortSignal.timeout(15000)});
          if(!result.ok)throw new Error('页面资源读取失败。');return result.text();
        }));
        const nonce=randomBytes(18).toString('base64');
        const css=resources[0].replace(/<\/style/gi,'<\\/style'),script=resources[1].replace(/<\/script/gi,'<\\/script');
        let html=await response.text();
        html=html.replace('<link rel="stylesheet" href="/style.css">',()=>`<style>${css}</style>`)
          .replace('<script defer src="/app.js"></script>','')
          .replace('</body>',()=>`<script nonce="${nonce}">${script}</script>\n</body>`);
        res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
        return staticReply(req,res,response.status,type,Buffer.from(html,'utf8'));
      }
      staticReply(req,res,response.status,type,Buffer.from(await response.arrayBuffer()));
    }catch{return json(res,502,{code:'UPSTREAM_UNAVAILABLE',error:'电脑上的工作台暂时无法读取，请稍后刷新。'});}
  });
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',done);});
  baseUrl=`http://127.0.0.1:${server.address().port}`;
  return {server,baseUrl,publicUrl:publicHost?scheme+'://'+publicHost:null,close:()=>new Promise(done=>server.close(done))};
}
