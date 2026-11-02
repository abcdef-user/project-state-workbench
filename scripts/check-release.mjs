import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const auditRoot = process.argv.includes('--root') ? resolve(process.argv[process.argv.indexOf('--root') + 1]) : root;
const excluded = new Set(['node_modules', '.git', '.local-data', '.verification', '.release', '__pycache__']);
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name)) return [];
    const name = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link: ${relative(auditRoot, name)}`);
    return entry.isDirectory() ? walk(name) : [name];
  });
}
let files;
try {
  files = execFileSync('git', ['-C', auditRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\0').filter(Boolean).map(file => join(auditRoot, file));
  if (!files.length) files = walk(auditRoot);
} catch { files = walk(auditRoot); }
const violations = [];
const secretRules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['tailscale-key', /\btskey-(?:auth|api|client)-[A-Za-z0-9_-]{15,}/],
  ['api-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['embedded-credentials', /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ['private-tailnet', /\b(?!example\b)[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net\b/i],
  ['personal-home', /(?:[A-Z]:[\\/]Users[\\/](?!example(?:[\\/]|\b)|<)[^\s'"<>]+|\/home\/(?!example(?:\/|\b)|<)[a-z0-9_-]+\/)/i],
  ['email-address', /\b[A-Z0-9._%+-]+@(?![^\s@]*\.(?:invalid|test)\b|example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i]
];
for (const file of files) {
  const name = relative(auditRoot, file).replaceAll('\\', '/');
  const segments = name.split('/');
  if (segments.some(part => ['data','partitions','node_modules','runtime','.verification','项目状态','.shared-state'].includes(part)) ||
      /(?:\.(?:db(?:-wal|-shm)?|sqlite3?|log|exe|dll|zip|pem|pfx|p12|key)|(?:^|\/)(?:workbench|projects|running|workspace|bootstrap)\.json)$/.test(name)) {
    violations.push({ file: name, rule: 'non-source-content' }); continue;
  }
  const bytes = readFileSync(file);
  if (bytes.includes(0)) { violations.push({ file: name, rule: 'unexpected-binary' }); continue; }
  if (statSync(file).size > 2_000_000) violations.push({ file: name, rule: 'oversized-source' });
  const content = bytes.toString('utf8');
  for (const [rule, pattern] of secretRules) if (pattern.test(content)) violations.push({ file: name, rule });
}
for (const name of ['store.js', 'surface.js', 'workspace-store.js']) {
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (hash(join(auditRoot, 'core', name)) !== hash(join(auditRoot, 'workbench/app/engine', name)))
    violations.push({ file: `workbench/app/engine/${name}`, rule: 'engine-copy-drift' });
}
if (violations.length) {
  console.error(JSON.stringify({ ok: false, files: files.length, violations }, null, 2));
  process.exitCode = 1;
} else console.log(JSON.stringify({ ok: true, files: files.length, message: 'Source-only and pattern checks passed. This is not a guarantee that every secret or rights issue is detectable.' }));
