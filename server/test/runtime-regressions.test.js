import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, renameSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ProjectStateStore } from '../src/store.js';
import { WorkspaceStoreRouter } from '../src/workspace-store.js';
import { SURFACE_BYTES } from '../src/surface.js';

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'shared-state-regression-'));
  t.after(() => {
    const child = relative(resolve(tmpdir()), resolve(root));
    assert.ok(child.startsWith('shared-state-regression-') && !child.startsWith('..') && !isAbsolute(child));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function memory(t) { const s = new ProjectStateStore(); t.after(() => s.close()); return s; }
const base = { projectId: 'p', taskId: 'a', tool: 'inspect', target: 'x', argsHash: 'h', actorId: 'owner' };
const task = (s, taskId = 'a') => s.createTask({ projectId: 'p', taskId, goal: 'test', acceptanceCriteria: ['verified'] });
const errorCode = (code) => (error) => error.code === code;

test('one operation advances, preserves its identity and history, and protects terminal state', (t) => {
  const s = memory(t); task(s);
  const started = s.recordOperation({ ...base, status: 'started' });
  const operationId = started.operation.operationId;
  assert.throws(() => s.recordOperation({ ...base, status: 'succeeded' }), errorCode('OPERATION_IN_PROGRESS'));
  assert.throws(() => s.recordOperation({ ...base, operationId, actorId: 'other', status: 'succeeded' }), errorCode('OPERATION_OWNED_BY_OTHER'));
  const finished = s.recordOperation({ ...base, operationId, status: 'succeeded', result: { ok: true } });
  assert.equal(finished.operation.operationId, operationId);
  assert.equal(finished.operation.createdAt, started.operation.createdAt);
  assert.equal(finished.operation.status, 'succeeded');
  assert.equal(s.getSurface({ projectId: 'p' }).operations.length, 1);
  const events = s.getSurface({ projectId: 'p' }).recentEvents;
  assert.equal(events[0].causedBy, started.eventId);
  assert.equal(events[1].type, 'operation_started');
  assert.equal(s.recordOperation({ ...base, status: 'succeeded' }).duplicate, true);
  assert.throws(() => s.recordOperation({ ...base, operationId, status: 'failed' }), errorCode('INVALID_OPERATION_TRANSITION'));
  assert.throws(() => s.recordOperation({ ...base, operationId, target: 'changed', status: 'succeeded' }), errorCode('OPERATION_ID_CONFLICT'));
});

test('failed operations can be retried with a new identity', (t) => {
  const s = memory(t);
  const start = s.recordOperation({ ...base, status: 'started' });
  s.recordOperation({ ...base, operationId: start.operation.operationId, status: 'failed' });
  const retry = s.recordOperation({ ...base, status: 'started' });
  assert.notEqual(retry.operation.operationId, start.operation.operationId);
  s.recordOperation({ ...base, operationId: retry.operation.operationId, status: 'succeeded' });
});

test('equivalent cross-task reuse creates a task-local record and does not repeat it', (t) => {
  const s = memory(t); task(s); task(s, 'b');
  const a = s.recordOperation({ ...base, status: 'succeeded', result: { value: 42 } });
  const b = s.recordOperation({ ...base, taskId: 'b', status: 'started' });
  assert.equal(b.duplicate, true);
  assert.equal(b.reusedFrom, a.operation.operationId);
  assert.equal(b.operation.taskId, 'b');
  assert.deepEqual(b.operation.result, { value: 42 });
  assert.equal(s.getSurface({ projectId: 'p', taskId: 'b' }).operations.length, 1);
  assert.equal(s.recordOperation({ ...base, taskId: 'b', status: 'started' }).operation.operationId, b.operation.operationId);
  assert.equal(s.getSurface({ projectId: 'p' }).operations.length, 2);
  assert.throws(() => s.getOperation({ projectId: 'p', taskId: 'a', operationId: b.operation.operationId }), errorCode('OPERATION_NOT_FOUND'));
});

test('canonical argument hashing is order independent and key collisions do not reuse other tuples', (t) => {
  const s = memory(t);
  const { argsHash, ...argsBase } = base;
  s.recordOperation({ ...argsBase, args: { a: 1, b: { x: 2, y: 3 } }, status: 'succeeded' });
  assert.equal(s.recordOperation({ ...argsBase, args: { b: { y: 3, x: 2 }, a: 1 }, status: 'succeeded' }).duplicate, true);
  assert.throws(() => s.recordOperation({ ...base, args: {}, status: 'succeeded' }), errorCode('ARGS_HASH_MISMATCH'));
  s.recordOperation({ ...base, idempotencyKey: 'custom', status: 'succeeded' });
  assert.equal(s.recordOperation({ ...base, target: 'different', idempotencyKey: 'custom', status: 'succeeded' }).duplicate, false);
});

test('release requires ownership or a version-checked force and leaves an audit trail', (t) => {
  const s = memory(t); task(s);
  const claimed = s.claimTask({ projectId: 'p', taskId: 'a', agentId: 'owner' });
  const release = { projectId: 'p', taskId: 'a', actorId: 'other', reason: 'owner stopped' };
  assert.throws(() => s.releaseTask(release), errorCode('TASK_OWNED_BY_OTHER'));
  assert.throws(() => s.releaseTask({ ...release, force: true }), errorCode('TASK_VERSION_REQUIRED'));
  assert.throws(() => s.releaseTask({ ...release, force: true, expectedTaskVersion: 1 }), errorCode('TASK_VERSION_CONFLICT'));
  s.releaseTask({ ...release, force: true, expectedTaskVersion: claimed.task.version });
  assert.equal(s.getSurface({ projectId: 'p' }).recentEvents[0].payload.previousOwner, 'owner');
  s.claimTask({ projectId: 'p', taskId: 'a', agentId: 'next' });
  s.releaseTask({ ...release, actorId: 'next' });
  s.claimTask({ projectId: 'p', taskId: 'a', agentId: 'last' });
  s.completeTask({ projectId: 'p', taskId: 'a', actorId: 'last', evidence: ['verified'] });
  assert.throws(() => s.releaseTask({ ...release, actorId: 'last' }), errorCode('TASK_COMPLETED'));
});

test('Surface is bounded, strips legacy results and paginates without losing operations', (t) => {
  const s = memory(t);
  for (let i = 0; i < 150; i++) s.recordOperation({ ...base, target: String(i), status: 'succeeded', result: { text: 'x'.repeat(3000) } });
  // An old database may still contain full event payloads; do not rewrite its history.
  const legacy = JSON.stringify({ result: { text: 'legacy'.repeat(20000) }, status: 'succeeded' });
  s.db.prepare('UPDATE events SET payload_json = ? WHERE project_revision = 150').run(legacy);
  const first = s.getSurface({ projectId: 'p' });
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= SURFACE_BYTES);
  assert.equal(first.operations.length, 20);
  assert.equal(first.recentEvents.length, 30);
  assert.ok(first.operations.every((op) => !Object.hasOwn(op, 'result')));
  assert.ok(first.recentEvents.every((event) => !Object.hasOwn(event.payload, 'result')));
  assert.equal(s.db.prepare('SELECT payload_json FROM events WHERE project_revision = 150').get().payload_json, legacy);
  const seen = new Set(); let offset = 0;
  do {
    const page = s.getSurface({ projectId: 'p', offsets: { operations: offset }, expectedRevision: first.revision });
    for (const op of page.operations) { assert.ok(!seen.has(op.operationId)); seen.add(op.operationId); }
    offset = page.pagination.operations.nextOffset;
  } while (offset !== null);
  assert.equal(seen.size, 150);
  task(s);
  assert.throws(() => s.getSurface({ projectId: 'p', expectedRevision: first.revision }), errorCode('REVISION_CONFLICT'));
});

test('large summaries remain bounded and chunked operation results reconstruct exactly', (t) => {
  const s = memory(t);
  s.createTask({ projectId: 'p', taskId: 'a', goal: '大'.repeat(100000) });
  for (let i = 0; i < 40; i++) s.recordDecision({ projectId: 'p', subject: String(i), decision: '文'.repeat(10000), actorId: 'owner', evidence: ['proof'.repeat(20000)] });
  const result = { text: '结果😀'.repeat(6000) };
  const saved = s.recordOperation({ ...base, status: 'succeeded', result });
  const surface = s.getSurface({ projectId: 'p', taskId: 'a', limit: 100 });
  assert.ok(Buffer.byteLength(JSON.stringify(surface)) <= SURFACE_BYTES);
  assert.ok(surface.task.omittedFields.includes('goal'));
  assert.equal(saved.operation.resultOmitted, true);
  let offset = 0, json = '';
  do {
    const chunk = s.getOperation({ projectId: 'p', operationId: saved.operation.operationId, resultOffset: offset, resultLimit: 1024 });
    json += chunk.resultJson; offset = chunk.nextResultOffset;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(json), result);
});

test('staleness uses target metadata even outside the artifact page or current task attribution', (t) => {
  const s = memory(t);
  s.recordOperation({ ...base, targetVersion: 'old', status: 'succeeded' });
  s.observeArtifact({ projectId: 'p', taskId: 'b', path: 'x', contentHash: 'new', actorId: 'other' });
  s.observeArtifact({ projectId: 'p', path: 'newest', contentHash: 'v', actorId: 'other' });
  const surface = s.getSurface({ projectId: 'p', taskId: 'a', limit: 1 });
  assert.equal(surface.artifacts[0].path, 'newest');
  assert.equal(surface.operations[0].stale, true);
});

test('a Surface retains one snapshot when another connection writes between its reads', (t) => {
  const root = directory(t);
  const a = new ProjectStateStore(join(root, 'state.db'));
  const b = new ProjectStateStore(join(root, 'state.db'));
  try {
    task(a);
    const prepare = a.db.prepare.bind(a.db); let injected = false;
    a.db.prepare = (sql) => {
      if (!injected && sql.startsWith('SELECT * FROM tasks')) { injected = true; task(b, 'b'); }
      return prepare(sql);
    };
    const surface = a.getSurface({ projectId: 'p' });
    assert.equal(injected, true);
    assert.equal(surface.revision, 1);
    assert.equal(surface.tasks.length, 1);
    assert.equal(b.getSurface({ projectId: 'p' }).revision, 2);
  } finally { b.close(); a.close(); }
});

test('a separate process can release a write lock while the caller waits', async (t) => {
  const root = directory(t), db = join(root, 'lock.db');
  const s = new ProjectStateStore(db);
  const source = new URL('../src/store.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { ProjectStateStore } from ${JSON.stringify(source)};
    const s = new ProjectStateStore(${JSON.stringify(db)});
    s.db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    setTimeout(() => { s.db.exec('ROLLBACK'); s.close(); process.disconnect(); }, 150);
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    const start = performance.now();
    task(s);
    assert.ok(performance.now() - start >= 80);
    assert.equal(s.getSurface({ projectId: 'p' }).tasks.length, 1);
    const [code] = await exited;
    assert.equal(code, 0);
  } finally { child.kill(); s.close(); }
});

test('expired busy wait is actionable and leaves no partial transaction', (t) => {
  const root = directory(t);
  const a = new ProjectStateStore(join(root, 'state.db')), b = new ProjectStateStore(join(root, 'state.db'));
  try {
    b.db.exec('PRAGMA busy_timeout = 20'); a.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => task(b), errorCode('STATE_BUSY'));
    a.db.exec('ROLLBACK'); task(b);
    assert.equal(b.getSurface({ projectId: 'p' }).revision, 1);
  } finally { b.close(); a.close(); }
});

test('missing workspace recovers from retained metadata after router restart', (t) => {
  const root = directory(t), ws = join(root, 'ws'), dataRoot = join(root, 'data');
  mkdirSync(ws);
  const router = new WorkspaceStoreRouter({ dataRoot });
  const original = router.open(ws); task(original.store); router.close();
  assert.equal(relative(root, ws), 'ws'); renameSync(ws, join(root, 'moved'));
  const next = new WorkspaceStoreRouter({ dataRoot });
  try {
    const restored = next.open(ws);
    assert.equal(restored.workspace.databasePath, original.workspace.databasePath);
    assert.equal(restored.store.getSurface({ projectId: 'p' }).tasks.length, 1);
    assert.equal(restored.workspace.recovered, true);
    assert.equal(JSON.parse(readFileSync(join(original.workspace.stateDirectory, 'workspace.json'), 'utf8')).rootPath, original.workspace.rootPath);
  } finally { next.close(); }
});

test('a missing workspace recovers through an alias of its surviving parent', (t) => {
  const root=directory(t), actual=join(root,'actual-parent'), alias=join(root,'alias-parent');
  mkdirSync(actual);symlinkSync(actual,alias,process.platform==='win32'?'junction':'dir');
  const ws=join(alias,'ws');mkdirSync(ws);
  const dataRoot=join(root,'states'),first=new WorkspaceStoreRouter({dataRoot});
  const original=first.open(ws);task(original.store);first.close();
  renameSync(join(actual,'ws'),join(actual,'moved'));
  const next=new WorkspaceStoreRouter({dataRoot});
  try{const restored=next.open(ws);assert.equal(restored.workspace.databasePath,original.workspace.databasePath);assert.equal(restored.store.getSurface({projectId:'p'}).tasks.length,1);}
  finally{next.close();}
});

test('an omitted projectId defaults to the workspace directory name', (t) => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const root = directory(t);
  const ws = join(root, 'my-project');
  mkdirSync(ws);
  const env = { ...process.env, PROJECT_STATE_DB: '', PROJECT_STATE_ROOT: join(root, 'data'), PROJECT_STATE_WORKSPACE: '', NODE_NO_WARNINGS: '1' };
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });

  const created = run(['--workspace', ws, 'create-task', '{"taskId":"t1","goal":"default project"}']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(JSON.parse(created.stdout).result.status, 'pending');

  const surface = run(['--workspace', ws, 'get-surface', '{}']);
  assert.equal(surface.status, 0, surface.stderr);
  const read = JSON.parse(surface.stdout).result;
  assert.equal(read.projectId, 'my-project');
  assert.equal(read.tasks.length, 1);
});

test('CLI errors preserve request IDs and handle missing workspaces and unterminated input', (t) => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  // NODE_NO_WARNINGS keeps Node's `ExperimentalWarning: SQLite` off stderr, which
  // this test parses as pure JSON; the warning is environment-dependent (absent
  // on the Node 24 build where the suite was first verified).
  const env = { ...process.env, PROJECT_STATE_DB: '', PROJECT_STATE_ROOT: '', PROJECT_STATE_WORKSPACE: '', NODE_NO_WARNINGS: '1' };
  const run = spawnSync(process.execPath, [cli, '--db', ':memory:'], { env, encoding: 'utf8', input: '{"id":7,"method":"close"}\n{"id":8,"method":"get-surface","params":{"projectId":"p"}}' });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].id, 7); assert.equal(lines[0].error.code, 'UNKNOWN_METHOD');
  assert.equal(lines[1].id, 8); assert.equal(lines[1].ok, true);
  const root = directory(t);
  const missing = spawnSync(process.execPath, [cli, '--root', root, '--workspace', join(root, 'absent'), 'get-surface', '{"projectId":"p"}'], { env, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'WORKSPACE_NOT_FOUND');
});
