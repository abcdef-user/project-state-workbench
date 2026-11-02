import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configFile = join(root, 'workbench', 'workbench.json');
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) : {};
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const dataDirectory = resolve(option('--data-dir') || (config.dataDirectory
  ? resolve(dirname(configFile), config.dataDirectory)
  : join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ProjectWorkbench')));
const runningFile = join(dataDirectory, 'running.json');
try {
  if (!existsSync(runningFile)) {
    console.log('该数据目录没有已登记的工作台实例。');
  } else {
    const running = JSON.parse(readFileSync(runningFile, 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(running.baseUrl) || !Number.isSafeInteger(running.pid) || running.pid <= 0)
      throw new Error('运行记录无效，未停止任何进程。');
    let health;
    try { health = await fetch(running.baseUrl + '/api/health', { signal: AbortSignal.timeout(2500) }).then(r => r.json()); }
    catch { throw new Error('无法核验运行实例，未停止任何进程。'); }
    if (health.app !== 'project-workbench' || health.pid !== running.pid ||
        typeof health.dataDirectory !== 'string' || resolve(health.dataDirectory) !== dataDirectory)
      throw new Error('运行实例与所选数据目录不匹配，未停止任何进程。');
    process.kill(running.pid, 'SIGTERM');
    let stopped = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const current = await fetch(running.baseUrl + '/api/health', { signal: AbortSignal.timeout(500) }).then(r => r.json());
        if (current.pid !== running.pid) { stopped = true; break; }
      } catch { stopped = true; break; }
      await new Promise(done => setTimeout(done, 150));
    }
    if (!stopped) throw new Error('已请求停止，但实例仍在响应；未发送强制终止请求。');
    console.log('该数据目录的工作台已停止。再次 npm start 将读取新配置。');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
