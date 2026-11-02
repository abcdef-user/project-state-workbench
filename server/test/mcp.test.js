import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));

function confirmedClient(name) {
  return new Client({ name, version: "0.1.0" });
}

/**
 * Read a tool result's payload.
 *
 * Results carry ONE copy of the payload, as `content[0].text` JSON: the host
 * records everything a tool returns into the transcript, so emitting the same
 * object a second time as `structuredContent` doubled every result's characters
 * (measured: 50.7% of all shared-state result bytes). `structuredContent` is
 * still available behind PROJECT_STATE_STRUCTURED_CONTENT=1.
 */
function payload(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal(result.structuredContent, undefined, "results must not duplicate the payload");
  return JSON.parse(result.content[0].text);
}

async function openSession(client, workspaceRoot, projectId, taskId = undefined) {
  const opened = await client.callTool({
    name: "project_open_session",
    arguments: { workspaceRoot, projectId, ...(taskId ? { taskId } : {}) },
  });
  assert.notEqual(opened.isError, true);
  return payload(opened).sessionToken;
}

test("MCP server exposes the shared-state tools", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "project-state-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "..", "src", "mcp-server.js")],
    env: { ...process.env, PROJECT_STATE_DB: join(directory, "state.db") },
  });
  const client = confirmedClient("shared-state-test");
  t.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "project_open_session"));
  assert.ok(tools.tools.some((tool) => tool.name === "project_close_session"));
  assert.ok(tools.tools.some((tool) => tool.name === "project_get_surface"));
  assert.ok(tools.tools.some((tool) => tool.name === "project_record_operation"));

  const blocked = await client.callTool({
    name: "project_get_surface",
    arguments: { sessionToken: randomUUID(), projectId: "demo" },
  });
  assert.equal(blocked.isError, true);

  const sessionToken = await openSession(client, directory, "demo");

  const created = await client.callTool({
    name: "project_create_task",
    arguments: {
      sessionToken,
      projectId: "demo",
      taskId: "task-1",
      goal: "验证共享状态",
      acceptanceCriteria: ["第二个对话可读取"],
      actorId: "test",
    },
  });
  assert.notEqual(created.isError, true);

  const surface = await client.callTool({
    name: "project_get_surface",
    arguments: { sessionToken, projectId: "demo", taskId: "task-1" },
  });
  assert.notEqual(surface.isError, true);
  assert.equal(payload(surface).task.goal, "验证共享状态");

  const closed = await client.callTool({
    name: "project_close_session",
    arguments: { sessionToken },
  });
  assert.equal(payload(closed).closed, true);
  const blockedAfterClose = await client.callTool({
    name: "project_get_surface",
    arguments: { sessionToken, projectId: "demo" },
  });
  assert.equal(blockedAfterClose.isError, true);
});

test("MCP server routes calls by workspace root", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "project-state-routed-mcp-"));
  const firstRoot = join(directory, "workspace-a");
  const secondRoot = join(directory, "workspace-b");
  mkdirSync(firstRoot);
  mkdirSync(secondRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "..", "src", "mcp-server.js")],
    env: { ...process.env, PROJECT_STATE_ROOT: join(directory, "state"), PROJECT_STATE_DB: "" },
  });
  const client = confirmedClient("workspace-routing-test");
  t.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);

  const tokens = new Map();
  for (const [workspaceRoot, goal] of [[firstRoot, "workspace A"], [secondRoot, "workspace B"]]) {
    const sessionToken = await openSession(client, workspaceRoot, "same");
    tokens.set(workspaceRoot, sessionToken);
    const created = await client.callTool({
      name: "project_create_task",
      arguments: {
        sessionToken, projectId: "same", taskId: "task-1", goal,
        acceptanceCriteria: [], actorId: "test",
      },
    });
    assert.notEqual(created.isError, true);
  }

  const firstSurface = await client.callTool({
    name: "project_get_surface",
    arguments: { sessionToken: tokens.get(firstRoot), projectId: "same", taskId: "task-1" },
  });
  const secondSurface = await client.callTool({
    name: "project_get_surface",
    arguments: { sessionToken: tokens.get(secondRoot), projectId: "same", taskId: "task-1" },
  });
  assert.equal(payload(firstSurface).task.goal, "workspace A");
  assert.equal(payload(secondSurface).task.goal, "workspace B");
  assert.notEqual(
    payload(firstSurface).workspace.workspaceId,
    payload(secondSurface).workspace.workspaceId,
  );
});

test('new tools support scoped transitions, release, pagination and retained sessions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'project-state-integration-'));
  const workspaceRoot = join(directory, 'ws'); mkdirSync(workspaceRoot);
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(here, '..', 'src', 'mcp-server.js')],
    env: { ...process.env, PROJECT_STATE_ROOT: join(directory, 'data'), PROJECT_STATE_DB: '' },
  });
  const client = confirmedClient('runtime-regression');
  t.after(async () => {
    await client.close();
    const child = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(child.startsWith('project-state-integration-') && !isAbsolute(child) && !child.startsWith('..'));
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const sessionToken = await openSession(client, workspaceRoot, 'p', 'a');
  const call = (name, params = {}) => client.callTool({ name, arguments: { sessionToken, projectId: 'p', ...params } });
  const ok = async (name, params = {}) => {
    const result = await call(name, params);
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return payload(result);
  };
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes('project_release_task'));
  assert.ok(tools.includes('project_get_operation'));
  await ok('project_create_task', { taskId: 'a', goal: 'integration' });
  const claimed = await ok('project_claim_task', { taskId: 'a', agentId: 'owner' });
  const operation = { tool: 'inspect', target: 'x', args: { b: 2, a: 1 }, actorId: 'owner' };
  const started = await ok('project_record_operation', { ...operation, status: 'started' });
  const operationId = started.operation.operationId;
  const value = { text: 'x'.repeat(12000) };
  await ok('project_record_operation', { ...operation, operationId, status: 'succeeded', result: value });
  const surface = await ok('project_get_surface', { limit: 1, offsets: { operations: 0 } });
  assert.equal(surface.operations[0].status, 'succeeded');
  assert.equal(surface.operations[0].resultOmitted, true);
  assert.ok(surface.pagination.recentEvents);
  assert.equal((await call('project_get_surface', { taskId: 'b' })).isError, true);
  assert.equal((await call('project_get_operation', { taskId: 'b', operationId })).isError, true);
  let offset = 0, json = '';
  do {
    const chunk = await ok('project_get_operation', { operationId, resultOffset: offset });
    json += chunk.resultJson; offset = chunk.nextResultOffset;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(json), value);
  await ok('project_release_task', { taskId: 'a', actorId: 'other', reason: 'handoff', force: true, expectedTaskVersion: claimed.task.version });
  await ok('project_claim_task', { taskId: 'a', agentId: 'next' });
  assert.equal(relative(directory, workspaceRoot), 'ws'); renameSync(workspaceRoot, join(directory, 'renamed'));
  assert.equal((await ok('project_get_surface')).task.ownerAgent, 'next');
  const reopened = await openSession(client, workspaceRoot, 'p', 'a');
  const restored = await client.callTool({ name: 'project_get_surface', arguments: { sessionToken: reopened, projectId: 'p' } });
  assert.equal(payload(restored).task.ownerAgent, 'next');
  await client.callTool({ name: 'project_close_session', arguments: { sessionToken } });
  assert.equal((await call('project_get_operation', { operationId })).isError, true);
});
