/**
 * Integration check against the REAL Harness registries: the plugin is loaded
 * into a live cordis context with the real tool and system-prompt services, so
 * this proves the cordis contract (named exports, config schema, tool schemas,
 * prompt contributions) rather than just the handler logic.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as plugin from '../lib/index.js';

/** A minimal agent stand-in: the plugin only reads session id and cwd. */
const agentFor = (cwd, sessionId) => ({ session: { id: sessionId, header: { cwd } } });

async function mount(t, config = {}, beforePlugin = null) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shared-state-plugin-'));
  const workspace = join(root, 'agent');
  mkdirSync(workspace);
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(CommandRuntime);
  beforePlugin?.(ctx);
  const fiber = await ctx.plugin(plugin, { dataRoot: join(root, 'data'), ...config });
  t.after(async () => {
    // Dispose the real host before deleting files: Windows keeps SQLite handles open.
    await fiber.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { ctx, workspace, root, pluginScope: fiber.ctx };
}

test('the plugin mounts on real registries and exposes its ten tools', async (t) => {
  const { ctx, workspace } = await mount(t);
  const agent = agentFor(workspace, 'session-a');
  const names = [
    'shared_state_apply',
    'shared_state_claim_task', 'shared_state_complete_task', 'shared_state_create_task',
    'shared_state_observe_artifact', 'shared_state_record_decision', 'shared_state_record_operation',
    'shared_state_release_task', 'shared_state_status', 'shared_state_surface',
  ];
  // Scope visibility in a bare context is not the deployment's scope chain, so
  // prove registration by dispatch: an unregistered name fails as UNKNOWN_TOOL.
  for (const name of names) {
    const result = await ctx.tools.execute({
      name, arguments: {}, callId: `call-${name}`, agent, signal: new AbortController().signal,
    });
    assert.doesNotMatch(JSON.stringify(result.content), /UNKNOWN_TOOL|unknown tool/i, `${name} is not registered`);
  }
  const unknown = await ctx.tools.execute({
    name: 'shared_state_not_a_tool', arguments: {}, callId: 'call-unknown', agent,
    signal: new AbortController().signal,
  });
  assert.match(JSON.stringify(unknown.content), /unknown tool/i);
});

test('a tool call writes state another session reads through the real registry', async (t) => {
  const { ctx, workspace } = await mount(t, { enabledByDefault: true });
  const sessionA = agentFor(workspace, 'session-a');
  const sessionB = agentFor(workspace, 'session-b');

  const created = await ctx.tools.execute({
    name: 'shared_state_create_task',
    arguments: { taskId: 'task-1', goal: '跨对话延续', acceptanceCriteria: ['B 可读'] },
    callId: 'call-1',
    agent: sessionA,
    signal: new AbortController().signal,
  });
  assert.equal(created.isError, false, JSON.stringify(created));

  const read = await ctx.tools.execute({
    name: 'shared_state_surface',
    arguments: {},
    callId: 'call-2',
    agent: sessionB,
    signal: new AbortController().signal,
  });
  assert.equal(read.isError, false, JSON.stringify(read));
  assert.equal(read.value.surface.tasks.length, 1);
  assert.equal(read.value.surface.tasks[0].taskId, 'task-1');
  assert.equal(read.value.workspace.name, 'agent');
});

test('the prompt carries the policy section and a bounded digest', async (t) => {
  const { ctx, workspace } = await mount(t, { enabledByDefault: true });
  const agent = agentFor(workspace, 'session-a');
  await ctx.tools.execute({
    name: 'shared_state_create_task',
    arguments: { taskId: 'task-1', goal: '实现适配层' },
    callId: 'call-1', agent, signal: new AbortController().signal,
  });

  const assembly = await ctx.systemPrompt.assemble({ agent });
  const policy = assembly.sections.find((section) => section.name === 'shared-state:policy');
  assert.match(policy.text, /shared_state_surface/);
  const digest = assembly.contexts.find((entry) => entry.name === 'shared-state:digest');
  assert.match(digest.text, /task-1/);
  assert.match(digest.text, /revision 1/);
});

test('a disabled session gets no policy and no digest', async (t) => {
  const { ctx, workspace } = await mount(t, { enabledByDefault: false });
  const agent = agentFor(workspace, 'session-a');
  const assembly = await ctx.systemPrompt.assemble({ agent });
  // A disabled session contributes no content: the entry is either absent or empty.
  const policy = assembly.sections.find((section) => section.name === 'shared-state:policy');
  const digest = assembly.contexts.find((entry) => entry.name === 'shared-state:digest');
  assert.ok(policy === undefined || policy.text === '', JSON.stringify(policy));
  assert.ok(digest === undefined || digest.text === '', JSON.stringify(digest));

  const denied = await ctx.tools.execute({
    name: 'shared_state_surface', arguments: {}, callId: 'call-1', agent,
    signal: new AbortController().signal,
  });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /SHARED_STATE_DISABLED/);
});

test('/shared off revokes access and /shared on restores it', async (t) => {
  // A bare context has no real agent scope, so capture the registration instead
  // of asking the registry to resolve it for a stand-in agent.
  let command;
  const { ctx, workspace } = await mount(t, { enabledByDefault: true }, (ctx) => {
    const register = ctx.commands.register.bind(ctx.commands);
    ctx.commands.register = (definition) => {
      if (definition.name === 'shared') command = definition;
      return register(definition);
    };
  });
  const agent = agentFor(workspace, 'session-a');
  assert.ok(command, '/shared is registered');
  const invoke = (rawInput) => command.handler({
    commandId: 'cmd-1', agent, rawInput, attachments: [], signal: new AbortController().signal,
  });

  const status = await invoke('status');
  assert.equal(status.kind, 'success');
  assert.match(status.text, /"enabled": true/);

  const off = await invoke('off');
  assert.equal(off.kind, 'success');
  const denied = await ctx.tools.execute({
    name: 'shared_state_surface', arguments: {}, callId: 'call-off', agent,
    signal: new AbortController().signal,
  });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /SHARED_STATE_DISABLED/);

  const on = await invoke('on');
  assert.equal(on.kind, 'success');
  const allowed = await ctx.tools.execute({
    name: 'shared_state_surface', arguments: {}, callId: 'call-on', agent,
    signal: new AbortController().signal,
  });
  assert.equal(allowed.isError, false, JSON.stringify(allowed));

  const usage = await invoke('nonsense');
  assert.equal(usage.kind, 'error');
});

test("/shared project declares the conversation project", async (t) => {
  let command;
  const { ctx, workspace } = await mount(t, { enabledByDefault: true }, (ctx) => {
    const register = ctx.commands.register.bind(ctx.commands);
    ctx.commands.register = (definition) => {
      if (definition.name === 'shared') command = definition;
      return register(definition);
    };
  });
  const agent = agentFor(workspace, 'session-a');
  const invoke = (rawInput) => command.handler({
    commandId: 'cmd-1', agent, rawInput, attachments: [], signal: new AbortController().signal,
  });
  const call = (name, args) => ctx.tools.execute({
    name, arguments: args, callId: `call-${name}`, agent, signal: new AbortController().signal,
  });

  const before = await call('shared_state_status', {});
  assert.equal(before.value.projectId, 'agent', 'unnamed default is the workspace directory name');

  const declared = await invoke('project math');
  assert.equal(declared.kind, 'success');
  assert.match(declared.text, /math/);

  await call('shared_state_create_task', { taskId: 't1', goal: '在 math 里' });
  const surface = await call('shared_state_surface', {});
  assert.equal(surface.value.surface.projectId, 'math');
  assert.equal(surface.value.surface.tasks.length, 1);

  const status = await call('shared_state_status', {});
  assert.equal(status.value.projectId, 'math');
  assert.equal(status.value.declaredProject, 'math');
  assert.match(status.value.mirror, /math\.md$/);
  assert.ok(existsSync(join(workspace, '.dsh', 'shared-state', 'math.md')), 'per-project mirror exists');

  const cleared = await invoke('project');
  assert.equal(cleared.kind, 'success');
  assert.match(cleared.text, /math/);
});
