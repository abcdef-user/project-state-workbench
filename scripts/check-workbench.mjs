import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of ['verify.mjs', 'verify-viewer.mjs']) {
  const result = spawnSync(process.execPath, [resolve(root, 'workbench', file)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, PROJECT_STATE_ROOT: '', PROJECT_STATE_DB: '' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
