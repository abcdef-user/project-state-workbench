import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { buildDigest, buildMirror, buildPolicySection, createAgentGate, mirrorFileName, SharedStateService, writeMirror } from '../lib/handlers.js';
import { Config } from '../lib/index.js';

/** One isolated data root plus two workspace directories. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shared-state-'));
  const wsA = join(root, 'alpha');
  const wsB = join(root, 'beta');
  mkdirSync(wsA);
  mkdirSync(wsB);
  // Windows keeps the SQLite files locked until every handle is released, and
  // several tests never close their service (Linux deletes open files happily).
  // Retry briefly, then leave the temp directory rather than failing the test in
  // a teardown hook — the assertions are what this suite is for.
  t.after(async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return { dataRoot: join(root, 'data'), wsA, wsB };
}

const caller = (cwd, sessionId = 'session-a', agentPreset = null) => ({ cwd, sessionId, agentPreset });

/** Assert a thrown StateError carries a specific code (messages are prose). */
function throwsCode(run, code) {
  assert.throws(run, (error) => {
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('two conversations in one workspace share state', (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');
  const b = caller(wsA, 'session-b');

  service.createTask(a, { taskId: 'task-1', goal: '跑通共享状态', acceptanceCriteria: ['对话 B 可读取'] });
  const read = service.surface(b, {});
  assert.equal(read.surface.tasks.length, 1);
  assert.equal(read.surface.tasks[0].taskId, 'task-1');
  assert.equal(read.workspace.name, 'alpha');
});

test('different workspaces stay isolated even with the same name', (t) => {
  const { dataRoot, wsA } = fixture(t);
  const sibling = join(wsA, '..', 'alpha-copy');
  mkdirSync(sibling, { recursive: true });
  const service = new SharedStateService({ dataRoot, enabledByDefault: true });
  t.after(() => { service.close(); rmSync(sibling, { recursive: true, force: true }); });

  service.createTask(caller(wsA, 'session-a'), { taskId: 'task-1', goal: '只在 alpha' });
  const other = service.surface(caller(sibling, 'session-b'), {});
  assert.equal(other.surface.tasks.length, 0);
});

test('a disabled conversation cannot read or write', (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: false });
  t.after(() => service.close());

  throwsCode(() => service.surface(caller(wsA), {}), 'SHARED_STATE_DISABLED');
  service.setEnabled('session-a', true);
  assert.equal(service.surface(caller(wsA), {}).surface.revision, 0);
});

test('writes are attributed to the calling session, not a model claim', (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true });
  t.after(() => service.close());

  const created = service.createTask(caller(wsA, 'session-a'), { taskId: 'task-1', goal: 'x' });
  assert.equal(created.taskId, 'task-1');
  assert.equal(created.status, 'pending');
  const claimed = service.claimTask(caller(wsA, 'session-a'), { taskId: 'task-1' });
  assert.equal(claimed.task.ownerAgent, 'dsh:session-a');
  throwsCode(() => service.claimTask(caller(wsA, 'session-b'), { taskId: 'task-1' }), 'TASK_CLAIMED');
});

test('stale revisions are rejected so conversations cannot overwrite each other', (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');

  const first = service.createTask(a, { taskId: 'task-1', goal: 'x' });
  assert.equal(first.revision, 1);
  throwsCode(
    () => service.createTask(a, { taskId: 'task-2', goal: 'y', expectedRevision: 0 }),
    'REVISION_CONFLICT',
  );
});

test('equivalent successful operations are deduplicated across conversations', async (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');
  const b = caller(wsA, 'session-b');
  const operation = { tool: 'bash', target: 'solve.py', args: { cmd: 'python solve.py' }, status: 'succeeded' };
  service.createTask(a, { taskId: 'task-a', goal: 'A' });
  service.createTask(b, { taskId: 'task-b', goal: 'B' });

  const first = await service.recordOperation(a, { ...operation, taskId: 'task-a', operationId: 'op-1' });
  assert.equal(first.duplicate, false);
  const second = await service.recordOperation(b, { ...operation, taskId: 'task-b', operationId: 'op-2' });
  assert.equal(second.duplicate, true);
  assert.equal(second.reusedFrom, 'op-1');
  assert.equal(second.operation.actorId, 'dsh:session-b');
  assert.equal(second.operation.taskId, 'task-b');
});

test('oversized operation results spill instead of bloating the store', async (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true, spillBytes: 256 });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');

  const small = await service.recordOperation(a, {
    tool: 'bash', target: 'a.txt', status: 'succeeded', args: { cmd: 'cat a.txt' },
    result: { ok: true }, operationId: 'op-small',
  });
  assert.deepEqual(small.operation.result, { ok: true });

  const saved = [];
  const big = await service.recordOperation(a, {
    tool: 'bash', target: 'b.txt', status: 'succeeded', args: { cmd: 'cat b.txt' },
    operationId: 'op-big', result: { payload: 'x'.repeat(400) },
  }, async (content, label) => { saved.push({ content, label }); return { locator: '/tmp/spill/result.json', retrievalHint: 'read it' }; });
  assert.equal(saved.length, 1);
  assert.equal(big.operation.result.spilled, true);
  assert.equal(big.operation.result.resultRef, '/tmp/spill/result.json');
  assert.equal(JSON.parse(big.operation.result.preview).payload.length, 400);
  assert.match(big.operation.result.retrievalHint, /read it/);
});

test('digest carries only what a new conversation needs, and stays bounded', () => {
  const surface = {
    projectId: 'demo', revision: 7, generatedAt: '2026-09-09T20:00:00.000Z',
    tasks: [
      { taskId: 'task-1', goal: '实现 DSH 适配层', status: 'in_progress', ownerAgent: 'dsh:session-a' },
      { taskId: 'task-2', goal: '已完成的旧任务', status: 'completed' },
    ],
    artifacts: [{ path: 'dsh/lib/index.js' }],
    decisions: [{ status: 'accepted', subject: '数据层', decision: '复用 SQLite 内核' }],
    pagination: { tasks: { hasMore: false }, artifacts: { hasMore: false } },
  };
  const digest = buildDigest({ projectId: 'demo', workspaceName: 'agent', surface });
  assert.match(digest, /revision 7/);
  assert.match(digest, /task-1/);
  assert.doesNotMatch(digest, /task-2/);
  assert.match(digest, /复用 SQLite 内核/);
  assert.match(digest, /shared_state_surface/);

  const tiny = buildDigest({ projectId: 'demo', workspaceName: 'agent', surface, maxChars: 80 });
  assert.ok(tiny.length <= 80, `digest should be bounded, got ${tiny.length}`);
  assert.equal(buildDigest({ projectId: 'demo', workspaceName: 'agent', surface: { revision: 0 } }), '');
});

test('policy section states the discipline', () => {
  const text = buildPolicySection();
  for (const needle of ['shared_state_surface', 'shared_state_record_operation', 'shared_state_observe_artifact', 'shared_state_complete_task', '/shared off']) {
    assert.match(text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('config schema applies defaults and rejects unknown keys', () => {
  const validated = Config['~standard'].validate({ enabledByDefault: false });
  assert.equal(validated.value.enabledByDefault, false);
  assert.equal(validated.value.digestMaxChars, 1200);

  const unknown = Config['~standard'].validate({ nope: 1 });
  assert.ok(unknown.issues?.length === 1);

  const wrongType = Config['~standard'].validate({ spillBytes: 'big' });
  assert.match(wrongType.issues[0].message, /spillBytes/);

  const empty = Config['~standard'].validate(undefined);
  assert.equal(empty.value.projectId, null);
});

test('a session on a default-on preset starts enabled', (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, defaultOnPresets: ['shared-state'] });
  t.after(() => service.close());

  assert.equal(service.isEnabled(caller(wsA, 's1', 'shared-state')), true);
  assert.equal(service.isEnabled(caller(wsA, 's2', 'standard-principles')), false);
  service.setEnabled('s2', true);
  assert.equal(service.isEnabled(caller(wsA, 's2', 'standard-principles')), true);
  service.setEnabled('s1', false);
  assert.equal(service.isEnabled(caller(wsA, 's1', 'shared-state')), false);
});

test('the mirror file is written on write and on read, and stays bounded', (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true, mirrorDir: '.dsh/shared-state', mirrorMaxChars: 4096 });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');
  const mirror = join(wsA, '.dsh', 'shared-state', 'alpha.md');

  assert.equal(existsSync(mirror), false, 'no mirror before any shared-state activity');
  service.createTask(a, { taskId: 'task-1', goal: '镜像验证', acceptanceCriteria: ['文件存在'] });
  assert.ok(existsSync(mirror), 'write creates the mirror');
  const text = readFileSync(mirror, 'utf8');
  assert.match(text, /# 共享状态 · alpha/);
  assert.match(text, /revision：\*\*1\*\*/);
  assert.match(text, /task-1/);
  assert.match(text, /只读镜像/);

  service.recordDecision(a, { subject: '镜像', decision: '每次读写后刷新', status: 'proposed' });
  assert.match(readFileSync(mirror, 'utf8'), /revision：\*\*2\*\*/);

  // A read refreshes too, so a write from another harness shows up on the next read.
  service.surface(a, {});
  assert.ok(readFileSync(mirror, 'utf8').length <= 4096);
  assert.match(buildMirror({
    projectId: 'alpha', workspace: { rootPath: wsA },
    surface: { revision: 1, generatedAt: 'now', tasks: [], decisions: [], artifacts: [], operations: [] },
  }), /revision：\*\*1\*\*/);
});

test('a disabled session writes no mirror', (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: false });
  t.after(() => service.close());
  assert.throws(() => service.surface(caller(wsA), {}), /off for this conversation/);
  assert.equal(existsSync(join(wsA, '.dsh', 'shared-state', 'alpha.md')), false);
});

test('writeMirror is atomic and reports the target path', (t) => {
  const { dataRoot, wsA } = fixture(t);
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const target = writeMirror(wsA, '.dsh/mirror.md', 'hello');
  assert.equal(target, join(wsA, '.dsh', 'mirror.md'));
  assert.equal(readFileSync(target, 'utf8'), 'hello');
  assert.equal(writeMirror(wsA, '.dsh/mirror.md', 'second'), target);
  assert.equal(readFileSync(target, 'utf8'), 'second');
});

test('the agent gate masks tools only while a conversation is off', () => {
  const restricted = [];
  const lifted = [];
  let enabled = false;
  const gate = createAgentGate({
    isEnabled: () => enabled,
    toolNames: ['a', 'b'],
    restrict: (agent, names) => { restricted.push([agent.session.id, names]); return () => lifted.push(agent.session.id); },
  });
  const agent = { session: { id: 's1' } };

  gate.apply(agent);
  gate.apply(agent);
  assert.equal(restricted.length, 1, 'idempotent per session');
  assert.deepEqual(restricted[0], ['s1', ['a', 'b']]);

  enabled = true;
  gate.apply(agent);
  assert.deepEqual(lifted, ['s1']);
  assert.equal(gate.size(), 0);

  enabled = false;
  gate.apply(agent);
  assert.equal(gate.size(), 1);
  gate.release('s1');
  assert.deepEqual(lifted, ['s1', 's1']);
  assert.equal(gate.size(), 0);
});

test('one workspace holds several projects with separate state and mirrors', (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true, mirrorDir: '.dsh/shared-state' });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');

  service.createTask({ ...a, projectId: 'math' }, { taskId: 't1', goal: '建模' });
  service.createTask({ ...a, projectId: 'paper' }, { taskId: 't1', goal: '写论文' });
  service.recordDecision({ ...a, projectId: 'paper' }, { subject: '投稿', decision: '先投 A 刊' });

  assert.equal(service.surface({ ...a, projectId: 'math' }, {}).surface.revision, 1);
  const paper = service.surface({ ...a, projectId: 'paper' }, {}).surface;
  assert.equal(paper.revision, 2);
  assert.equal(paper.decisions.length, 1);
  assert.equal(paper.tasks[0].goal, '写论文');

  const mathMirror = join(wsA, '.dsh', 'shared-state', 'math.md');
  const paperMirror = join(wsA, '.dsh', 'shared-state', 'paper.md');
  assert.ok(existsSync(mathMirror) && existsSync(paperMirror), 'one mirror per project');
  assert.match(readFileSync(mathMirror, 'utf8'), /# 共享状态 · math/);
  assert.match(readFileSync(paperMirror, 'utf8'), /写论文/);
  assert.doesNotMatch(readFileSync(mathMirror, 'utf8'), /写论文/);
});

test('a session declaration sets the project default without locking the argument', (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');
  const b = caller(wsA, 'session-b');

  assert.equal(service.projectOf(a), null);
  assert.equal(service.surface(a, {}).surface.projectId, 'alpha', 'falls back to the workspace directory name');
  assert.equal(service.setProject('session-a', 'math'), 'math');
  service.createTask(a, { taskId: 't1', goal: '在 math 里' });
  assert.equal(service.surface(a, {}).surface.projectId, 'math');
  assert.equal(service.surface(b, {}).surface.projectId, 'alpha', 'other sessions keep their own default');
  // An explicit argument still wins over the declaration.
  assert.equal(service.surface(a, { projectId: 'alpha' }).surface.tasks.length, 0);
  assert.equal(service.setProject('session-a', null), null);
  assert.equal(service.surface(a, {}).surface.projectId, 'alpha', 'clearing the declaration restores the default');
});

test('mirror file names are filesystem-safe', () => {
  assert.equal(mirrorFileName('math'), 'math.md');
  assert.equal(mirrorFileName('a/b c'), 'a-b c.md');
  assert.equal(mirrorFileName(''), 'default.md');
  assert.equal(mirrorFileName(undefined), 'default.md');
  assert.equal(mirrorFileName('x'.repeat(200)).length, 83);
});

// ── batched operations (2026-09-27 round-trip optimisation) ─────────────────
// The plugin's cost is the model round trip per tool call, not the SQLite write.
// These tests pin the batched path: one call per registration, same semantics.

test('one batched call performs a whole registration under session identity', async (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');

  const batch = await service.applyBatch(a, {
    ops: [
      { op: 'surface', limit: 5, recentEventLimit: 5 },
      { op: 'createTask', taskId: 'task-1', goal: 'batched', acceptanceCriteria: ['c1'] },
      { op: 'claimTask', taskId: 'task-1' },
      { op: 'recordOperation', taskId: 'task-1', tool: 'python', target: 'x.py', args: {}, status: 'started' },
      { op: 'observeArtifact', taskId: 'task-1', path: 'x.py', contentHash: 'h1' },
      { op: 'completeTask', taskId: 'task-1', evidence: ['c1'] },
      { op: 'surface', taskId: 'task-1', limit: 5 },
    ],
  });

  assert.equal(batch.applied, 7);
  assert.equal(batch.failed, 0);
  assert.equal(batch.revision, 5, 'one revision per write, not one per batch');
  assert.equal(batch.results[0].result.surface.revision, 0, 'the leading read precedes the writes');
  const final = batch.results[6].result.surface;
  assert.equal(final.tasks[0].status, 'completed');
  // Identity comes from the session, never from the model.
  assert.equal(final.tasks[0].ownerAgent, 'dsh:session-a');
  assert.equal(final.artifacts[0].observedBy, 'dsh:session-a');
  assert.equal(batch.workspace.name, 'alpha');
  // The mirror is refreshed by the batch like by any other write, and a batched
  // read reports it, so it is shaped exactly like `shared_state_surface`.
  assert.equal(existsSync(join(wsA, '.dsh', 'shared-state', 'alpha.md')), true);
  assert.equal(typeof batch.results[6].result.mirror, 'string');
});

test('a batch cannot forge identity: the session always wins', async (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');

  // Every standalone tool overwrites actorId/agentId with the session identity.
  // A batch op carrying its own value must be discarded the same way, otherwise
  // one conversation could claim tasks and attribute decisions as another.
  const batch = await service.applyBatch(a, {
    ops: [
      { op: 'createTask', taskId: 'task-1', goal: 'x', actorId: 'dsh:VICTIM' },
      { op: 'claimTask', taskId: 'task-1', agentId: 'dsh:VICTIM', actorId: 'dsh:VICTIM' },
      { op: 'observeArtifact', taskId: 'task-1', path: 'x.py', contentHash: 'h', actorId: 'dsh:VICTIM' },
      { op: 'recordDecision', taskId: 'task-1', subject: 's', decision: 'd', actorId: 'dsh:VICTIM' },
      { op: 'recordOperation', taskId: 'task-1', tool: 'python', target: 'x.py', args: {}, status: 'started', actorId: 'dsh:VICTIM' },
      { op: 'surface', taskId: 'task-1', limit: 5 },
    ],
  });
  assert.equal(batch.failed, 0);
  const surface = batch.results[5].result.surface;
  assert.equal(surface.tasks[0].ownerAgent, 'dsh:session-a');
  assert.equal(surface.artifacts[0].observedBy, 'dsh:session-a');
  assert.equal(surface.decisions[0].actorId, 'dsh:session-a');
  assert.equal(surface.operations[0].actorId, 'dsh:session-a');
  assert.equal(surface.recentEvents.every((event) => event.actorId === 'dsh:session-a'), true);
  assert.equal(JSON.stringify(surface).includes('VICTIM'), false);
});

test('a malformed ops entry fails as input, not as a crash', async (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');

  // The adapter maps `ops` before the core validates it, so it must defend itself.
  await assert.rejects(service.applyBatch(a, { ops: 'surface' }), (error) => error.code === 'INVALID_INPUT');
  await assert.rejects(service.applyBatch(a, { ops: [null] }), (error) => error.code === 'INVALID_INPUT');
  await assert.rejects(service.applyBatch(a, { ops: ['surface'] }), (error) => error.code === 'INVALID_INPUT');
  await assert.rejects(service.applyBatch(a, {}), (error) => error.code === 'INVALID_INPUT');
  // The core still owns the rest of the validation.
  await assert.rejects(service.applyBatch(a, { ops: [] }), (error) => error.code === 'INVALID_INPUT');
  await assert.rejects(service.applyBatch(a, { ops: [{ op: 'nope' }] }), (error) => error.code === 'UNKNOWN_BATCH_OP');
});

test('a batch checks the revision once and rolls back as a unit', async (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');

  const first = await service.applyBatch(a, {
    ops: [{ op: 'createTask', taskId: 'task-1', goal: 'x' }],
  });
  assert.equal(first.revision, 1);

  await assert.rejects(
    service.applyBatch(a, { expectedRevision: 0, ops: [{ op: 'createTask', taskId: 'task-2', goal: 'x' }] }),
    (error) => error.code === 'REVISION_CONFLICT',
  );

  await assert.rejects(
    service.applyBatch(a, {
      ops: [
        { op: 'createTask', taskId: 'task-3', goal: 'x' },
        { op: 'claimTask', taskId: 'missing' },
      ],
    }),
    (error) => error.code === 'TASK_NOT_FOUND',
  );
  const surface = service.surface(a, { limit: 10 }).surface;
  assert.equal(surface.revision, 1, 'the rolled-back batch left no revision behind');
  assert.deepEqual(surface.tasks.map((task) => task.taskId), ['task-1']);

  const soft = await service.applyBatch(a, {
    continueOnError: true,
    ops: [
      { op: 'claimTask', taskId: 'missing' },
      { op: 'createTask', taskId: 'task-4', goal: 'x' },
    ],
  });
  assert.equal(soft.applied, 1);
  assert.equal(soft.failed, 1);
  assert.equal(soft.results[0].error.code, 'TASK_NOT_FOUND');
});

test('oversized results still spill when they arrive inside a batch', async (t) => {
  const { dataRoot, wsA } = fixture(t);
  const service = new SharedStateService({ dataRoot, enabledByDefault: true, spillBytes: 64 });
  t.after(() => service.close());
  const a = caller(wsA, 'session-a');
  const saved = [];
  const spill = async (content, label) => {
    saved.push({ content, label });
    return { locator: `/tmp/${label}` };
  };

  const batch = await service.applyBatch(a, {
    ops: [
      { op: 'recordOperation', tool: 'python', target: 'x.py', args: {}, status: 'succeeded', result: { big: 'x'.repeat(200) } },
    ],
  }, spill);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].label, 'operation-result.json');
  const stored = batch.results[0].result.operation;
  assert.equal(stored.result.spilled, true);
  assert.equal(stored.result.resultRef, '/tmp/operation-result.json');
  assert.equal(stored.result.resultBytes > 64, true);
});

test('the injected discipline tells conversations to batch', () => {
  const policy = buildPolicySection();
  assert.match(policy, /shared_state_apply/);
  assert.match(policy, /一个往返做完一件事/);
  const digest = buildDigest({
    projectId: 'alpha', workspaceName: 'alpha',
    surface: { revision: 3, generatedAt: 'now', tasks: [], decisions: [], artifacts: [] },
  });
  assert.match(digest, /shared_state_apply/);
});
