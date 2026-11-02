"""Install the native stdio companion without touching any project database."""
import argparse
import base64
import io
import json
from pathlib import Path
import subprocess
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser()
parser.add_argument("--distribution", default="Ubuntu")
parser.add_argument("--linux-root", required=True)
parser.add_argument("--program-dir", type=Path)
parser.add_argument("--source-id", default="ubuntu")
parser.add_argument("--fixture", action="store_true")
args = parser.parse_args()
app = Path(__file__).resolve().parent
bundle = io.BytesIO()
with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in ["wsl-worker.mjs", "manager.mjs", "project-store.mjs", "engine/store.js", "engine/surface.js", "engine/workspace-store.js"]:
        archive.write(app / name, "app/" + name)
    archive.writestr("package.json", '{"type":"module"}\n')
payload = {"root": args.linux_root, "fixture": args.fixture, "bundle": base64.b64encode(bundle.getvalue()).decode()}
installer = r'''
import pathlib,sys,json,base64,zipfile,io,sqlite3,shutil,datetime
p=json.loads(base64.b64decode(PAYLOAD))
root=pathlib.Path(p['root']).resolve()
if not root.is_absolute() or not (root/'data/workspaces').is_dir(): raise RuntimeError('请选择已有的 WSL 共享状态根目录。')
stamp=datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
destination=root/('workbench-bridge-test-'+stamp if p['fixture'] else 'workbench-bridge')
marker=destination/'.workbench-bridge'
if destination.exists() and not marker.exists(): raise RuntimeError('连接程序目录已有其他内容，未覆盖。')
if destination.exists():
 backup=root/'data/workbench-bridge/backups'/stamp
 backup.mkdir(parents=True)
 for f in destination.rglob('*'):
  if f.is_file():
   target=backup/f.relative_to(destination);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(f,target)
destination.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(io.BytesIO(base64.b64decode(p['bundle']))) as z:
 for name in z.namelist():
  target=(destination/name).resolve()
  if not target.is_relative_to(destination): raise RuntimeError('连接程序路径越界。')
  target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(z.read(name))
marker.write_text('ProjectWorkbench stdio bridge 1.2.0\n',encoding='utf-8')
storage=root/'data/workspaces'
data=root/'data/workbench-bridge'
records=[]
if p['fixture']:
 storage=destination/'fixture/states';data=destination/'fixture/hub';storage.mkdir(parents=True)
 for source in (root/'data/workspaces').glob('*/state.db'):
  folder=storage/source.parent.name;folder.mkdir()
  meta=json.loads((source.parent/'workspace.json').read_text(encoding='utf-8'))
  workspace=destination/'fixture/folders'/source.parent.name;workspace.mkdir(parents=True)
  meta['rootPath']=str(workspace);(folder/'workspace.json').write_text(json.dumps(meta,ensure_ascii=False),encoding='utf-8')
  old=sqlite3.connect(source.as_uri()+'?mode=ro',uri=True);new=sqlite3.connect(folder/'state.db');old.backup(new)
  records.append({'workspace':source.parent.name,'rootPath':str(workspace),'projects':[{'projectId':r[0],'revision':r[1],'tasks':r[2],'events':r[3]} for r in new.execute('SELECT p.project_id,p.revision,(SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.project_id),(SELECT COUNT(*) FROM events e WHERE e.project_id=p.project_id) FROM projects p')]})
  old.close();new.close()
node=shutil.which('node')
if not node: raise RuntimeError('WSL 中未找到 Node.js。')
version=__import__('subprocess').check_output([node,'--version'],text=True).strip()
parts=[int(v) for v in version.lstrip('v').split('.')[:2]]
if tuple(parts)<(22,5): raise RuntimeError('WSL Node.js 需要 22.5 或更高版本。')
print(json.dumps({'bridgePath':str(destination/'app/wsl-worker.mjs'),'nodeExecutable':node,'storageRoot':str(storage),'dataDirectory':str(data),'nodeVersion':version,'records':records},ensure_ascii=False))
'''
installer = "PAYLOAD=" + repr(base64.b64encode(json.dumps(payload).encode()).decode()) + "\n" + installer
run = subprocess.run(["wsl.exe", "-d", args.distribution, "--exec", "/usr/bin/python3", "-"], input=installer.encode(), capture_output=True)
if run.returncode:
    raise RuntimeError(run.stderr.decode("utf-8", errors="replace") or run.stdout.decode("utf-8", errors="replace"))
result = json.loads(run.stdout.decode("utf-8"))
config = {"id": args.source_id, "label": "WSL · " + args.distribution, "distribution": args.distribution, "enabled": True, **{k: result[k] for k in ("bridgePath", "nodeExecutable", "storageRoot", "dataDirectory")}}
if args.program_dir:
    if args.fixture:
        raise RuntimeError("测试副本不能写入正式连接配置。")
    config_file = args.program_dir.resolve() / "workbench.json"
    current = json.loads(config_file.read_text(encoding="utf-8-sig"))
    config_file.with_name("workbench.before-wsl.json").write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    current["wslSources"] = [s for s in current.get("wslSources", []) if s["id"] != args.source_id] + [config]
    temporary = config_file.with_suffix(".wsl.tmp")
    temporary.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(config_file)
print(json.dumps({"source": config, "nodeVersion": result["nodeVersion"], "records": result["records"]}, ensure_ascii=False, indent=2))
