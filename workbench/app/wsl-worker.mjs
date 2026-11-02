// Native Linux owner of WSL SQLite access. Only the configured parent uses this stdio protocol.
import { createInterface } from 'node:readline';
import { ProjectManager } from './manager.mjs';

const options=JSON.parse(Buffer.from(process.argv[2]||'', 'base64').toString('utf8'));
const manager=new ProjectManager(options);
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
send({ready:true,protocol:1,nodeVersion:process.versions.node});
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of input){
  let request;
  try{
    request=JSON.parse(line);
    const {method,args={}}=request;
    let result;
    switch(method){
      case 'catalog':result=manager.catalog();break;
      case 'state':result=manager.state(args.key);break;
      case 'switch':result=manager.switch(args.key);break;
      case 'open':result=manager.open(args);break;
      case 'create':result=manager.create(args);break;
      case 'change':result=manager.change(args);break;
      case 'folder':result={workspaceRoot:manager.context(args.key).entry.workspaceRoot};break;
      default:throw Object.assign(new Error('未知的 WSL 操作。'),{code:'INVALID_INPUT'});
    }
    send({id:request.id,ok:true,result});
  }catch(error){send({id:request?.id,ok:false,error:{code:error.code||'WSL_ERROR',message:error.message}});}
}
manager.close();
