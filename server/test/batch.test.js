import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));

async function connected(t, name, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), "project-state-batch-"));
  const workspaceRoot = join(directory, "ws");
  mkdirSync(workspaceRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "..", "src", "mcp-server.js")],
    env: { ...process.env, PROJECT_STATE_ROOT: join(directory, "data"), PROJECT_STATE_DB: "", ...env },
  });
  const client = new Client({ name, version: "0.1.0" });
  t.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  return { client, workspaceRoot, directory };
}

function payload(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse(result.content[0].text);
}

async function open(client, workspaceRoot, projectId, taskId) {
  const opened = await client.callTool({
    name: "project_open_session",
    arguments: { workspaceRoot, projectId, ...(taskId ? { taskId } : {}) },
  });
  return payload(opened).sessionToken;
}

test("one batch call performs a whole registration: read, writes, verify", async (t) => {
  const { client, workspaceRoot } = await connected(t, "batch-registration");
  const sessionToken = await open(client, workspaceRoot, "p");

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes("project_apply_batch"));

  const before = payload(await client.callTool({
    name: "project_get_surface",
    arguments: { sessionToken, projectId: "p", limit: 5 },
  }));
  assert.equal(before.revision, 0);

  // Everything a registration needs, in ONE call: read, six writes, re-read.
  // The single-call discipline is the point — each extra call is another full
  // model request carrying the whole conversation.
  const batch = payload(await client.callTool({
    name: "project_apply_batch",
    arguments: {
      sessionToken,
      projectId: "p",
      actorId: "owner",
      ops: [
        { op: "surface", limit: 5, recentEventLimit: 5 },
        { op: "createTask", taskId: "t1", goal: "batch goal", acceptanceCriteria: ["c1", "c2"] },
        { op: "claimTask", taskId: "t1", agentId: "owner" },
        { op: "recordOperation", taskId: "t1", tool: "python", target: "x.py", args: {}, status: "started" },
        { op: "recordDecision", taskId: "t1", subject: "s", decision: "d", status: "accepted", evidence: ["e"] },
        { op: "observeArtifact", taskId: "t1", path: "x.py", contentHash: "h1" },
        { op: "completeTask", taskId: "t1", evidence: ["c1", "c2"] },
        { op: "surface", taskId: "t1", limit: 5, recentEventLimit: 5 },
      ],
    },
  }));

  assert.equal(batch.applied, 8);
  assert.equal(batch.failed, 0);
  assert.equal(batch.revision, 6, "one revision per write, not one per batch");
  assert.equal(batch.results.length, 8);
  assert.deepEqual(batch.results.map((entry) => entry.op), [
    "surface", "createTask", "claimTask", "recordOperation",
    "recordDecision", "observeArtifact", "completeTask", "surface",
  ]);
  assert.equal(batch.results[0].result.revision, 0, "the leading read happens before the writes");
  assert.equal(batch.results[7].result.tasks[0].status, "completed");
  assert.equal(batch.results[7].result.tasks[0].ownerAgent, "owner");
  assert.equal(batch.results[7].result.decisions[0].status, "accepted");
  assert.equal(batch.results[7].result.artifacts[0].contentHash, "h1");
  assert.equal(batch.results[7].result.operations[0].status, "started");
  assert.equal(batch.results[7].result.recentEvents.length > 0, true);
  assert.equal(batch.workspace.rootPath, workspaceRoot);
});

test("a batch inherits the session task scope and a batch-level actorId", async (t) => {
  const { client, workspaceRoot } = await connected(t, "batch-scope");
  const sessionToken = await open(client, workspaceRoot, "p", "scoped");

  const batch = payload(await client.callTool({
    name: "project_apply_batch",
    arguments: {
      sessionToken,
      actorId: "owner",
      ops: [
        { op: "createTask", goal: "scoped goal" },
        { op: "observeArtifact", path: "f.md", contentHash: "h" },
        { op: "surface", limit: 5 },
      ],
    },
  }));
  assert.equal(batch.failed, 0);
  assert.equal(batch.results[0].result.taskId, "scoped");
  assert.equal(batch.results[2].result.task.taskId, "scoped");
  assert.equal(batch.results[2].result.artifacts[0].observedBy, "owner");
});

test("a batch is one transaction: a failing operation rolls the whole thing back", async (t) => {
  const { client, workspaceRoot } = await connected(t, "batch-atomic");
  const sessionToken = await open(client, workspaceRoot, "p");

  const failed = await client.callTool({
    name: "project_apply_batch",
    arguments: {
      sessionToken,
      actorId: "owner",
      ops: [
        { op: "createTask", taskId: "kept", goal: "g" },
        { op: "claimTask", taskId: "missing", agentId: "owner" },
      ],
    },
  });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /TASK_NOT_FOUND/);

  const surface = payload(await client.callTool({
    name: "project_get_surface",
    arguments: { sessionToken, projectId: "p", limit: 10 },
  }));
  assert.equal(surface.revision, 0);
  assert.equal(surface.tasks.length, 0);
});

test("continueOnError keeps the successful operations and reports the rest", async (t) => {
  const { client, workspaceRoot } = await connected(t, "batch-soft");
  const sessionToken = await open(client, workspaceRoot, "p");

  const batch = payload(await client.callTool({
    name: "project_apply_batch",
    arguments: {
      sessionToken,
      actorId: "owner",
      continueOnError: true,
      ops: [
        { op: "claimTask", taskId: "missing", agentId: "owner" },
        { op: "createTask", taskId: "t1", goal: "g" },
      ],
    },
  }));
  assert.equal(batch.applied, 1);
  assert.equal(batch.failed, 1);
  assert.equal(batch.results[0].ok, false);
  assert.equal(batch.results[0].error.code, "TASK_NOT_FOUND");
  assert.equal(batch.results[1].ok, true);
});

test("a batch-level actorId covers claimTask, and a batched read carries the workspace", async (t) => {
  const { client, workspaceRoot } = await connected(t, "batch-actorid");
  const sessionToken = await open(client, workspaceRoot, "p");

  const batch = payload(await client.callTool({
    name: "project_apply_batch",
    arguments: {
      sessionToken,
      projectId: "p",
      actorId: "owner",
      ops: [
        { op: "createTask", taskId: "t1", goal: "g" },
        { op: "claimTask", taskId: "t1" },
        { op: "surface", taskId: "t1", limit: 5 },
      ],
    },
  }));

  assert.equal(batch.failed, 0, JSON.stringify(batch.results));
  assert.equal(batch.results[2].result.tasks[0].ownerAgent, "owner");
  // Same shape as project_get_surface: the surface fields plus the workspace.
  assert.equal(batch.results[2].result.workspace.rootPath, workspaceRoot);
  assert.equal(typeof batch.results[2].result.revision, "number");
});

test("a batch checks the project revision once, and rejects unknown operations", async (t) => {
  const { client, workspaceRoot } = await connected(t, "batch-cas");
  const sessionToken = await open(client, workspaceRoot, "p");
  const call = (arguments_) => client.callTool({ name: "project_apply_batch", arguments: { sessionToken, ...arguments_ } });

  const first = payload(await call({ actorId: "owner", ops: [{ op: "createTask", taskId: "t1", goal: "g" }] }));
  assert.equal(first.revision, 1);

  const stale = await call({
    actorId: "owner",
    expectedRevision: 0,
    ops: [{ op: "createTask", taskId: "t2", goal: "g" }],
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /REVISION_CONFLICT/);

  const fresh = payload(await call({
    actorId: "owner",
    expectedRevision: 1,
    ops: [{ op: "createTask", taskId: "t2", goal: "g" }],
  }));
  assert.equal(fresh.revision, 2);

  // The tool's own schema rejects an unknown operation before the handler runs;
  // the core keeps the same guard for the CLI and DSH adapters.
  const unknown = await call({ ops: [{ op: "dropDatabase" }] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Invalid option|UNKNOWN_BATCH_OP/);

  const empty = await call({ ops: [] });
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /Invalid|INVALID_INPUT/);
});

test("the duplicated structuredContent copy stays off unless asked for", async (t) => {
  const plain = await connected(t, "batch-shape");
  const plainToken = await open(plain.client, plain.workspaceRoot, "p");
  const single = await plain.client.callTool({
    name: "project_get_surface",
    arguments: { sessionToken: plainToken, projectId: "p" },
  });
  assert.equal(single.structuredContent, undefined);
  assert.equal(typeof JSON.parse(single.content[0].text).revision, "number");

  const duplicated = await connected(t, "batch-shape-legacy", { PROJECT_STATE_STRUCTURED_CONTENT: "1" });
  const legacyToken = await open(duplicated.client, duplicated.workspaceRoot, "p");
  const both = await duplicated.client.callTool({
    name: "project_get_surface",
    arguments: { sessionToken: legacyToken, projectId: "p" },
  });
  assert.equal(typeof both.structuredContent.revision, "number");
  assert.equal(both.content[0].text.length > 0, true);
});

test("the CLI and the core keep their own batch guards", async () => {
  const { dispatch } = await import("../src/cli.js");
  const { ProjectStateStore } = await import("../src/store.js");
  const store = new ProjectStateStore(":memory:");
  try {
    const applied = dispatch(store, "apply-batch", {
      projectId: "p",
      ops: [
        { op: "createTask", taskId: "t", goal: "g", actorId: "owner" },
        { op: "surface", limit: 3 },
      ],
    });
    assert.equal(applied.applied, 2);
    assert.equal(applied.revision, 1);
    assert.equal(applied.results[1].result.tasks[0].taskId, "t");
    assert.throws(
      () => dispatch(store, "apply-batch", { projectId: "p", ops: [{ op: "nope" }] }),
      (error) => error.code === "UNKNOWN_BATCH_OP",
    );
    assert.throws(
      () => dispatch(store, "apply-batch", { projectId: "p", ops: [] }),
      (error) => error.code === "INVALID_INPUT",
    );
  } finally {
    store.close();
  }
});
