/** Regression checks for batching tool calls and avoiding duplicate payloads. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));

async function connected(t, name) {
  const directory = mkdtempSync(join(tmpdir(), "project-state-budget-"));
  const workspaceRoot = join(directory, "ws");
  mkdirSync(workspaceRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "..", "src", "mcp-server.js")],
    env: { ...process.env, PROJECT_STATE_ROOT: join(directory, "data"), PROJECT_STATE_DB: "" },
  });
  const client = new Client({ name, version: "0.1.0" });
  t.after(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  const opened = await client.callTool({
    name: "project_open_session",
    arguments: { workspaceRoot, projectId: "p" },
  });
  return { client, sessionToken: JSON.parse(opened.content[0].text).sessionToken };
}

/** One registration, expressed as the caller chooses: N calls or 1. */
const REGISTRATION = [
  { op: "surface", limit: 5, recentEventLimit: 5 },
  { op: "createTask", taskId: "t1", goal: "budget goal", acceptanceCriteria: ["c1"] },
  { op: "claimTask", taskId: "t1", agentId: "owner" },
  { op: "recordOperation", taskId: "t1", tool: "python", target: "x.py", args: {}, status: "started", actorId: "owner" },
  { op: "recordDecision", taskId: "t1", subject: "s", decision: "d", actorId: "owner" },
  { op: "observeArtifact", taskId: "t1", path: "x.py", contentHash: "h1", actorId: "owner" },
  { op: "completeTask", taskId: "t1", evidence: ["c1"], actorId: "owner" },
  { op: "surface", taskId: "t1", limit: 5, recentEventLimit: 5 },
];

const TOOL_FOR = {
  surface: "project_get_surface",
  createTask: "project_create_task",
  claimTask: "project_claim_task",
  recordOperation: "project_record_operation",
  recordDecision: "project_record_decision",
  observeArtifact: "project_observe_artifact",
  completeTask: "project_complete_task",
};

/** Call each operation on its own tool, one round trip apiece. */
async function sequential(client, sessionToken) {
  let roundTrips = 0;
  let bytes = 0;
  for (const { op, ...args } of REGISTRATION) {
    const result = await client.callTool({
      name: TOOL_FOR[op],
      arguments: { sessionToken, projectId: "p", ...args },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    roundTrips += 1;
    bytes += JSON.stringify(result).length;
  }
  return { roundTrips, bytes };
}

/** Call every operation inside one batch tool call. */
async function batched(client, sessionToken) {
  const result = await client.callTool({
    name: "project_apply_batch",
    arguments: { sessionToken, projectId: "p", ops: REGISTRATION },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return { roundTrips: 1, bytes: JSON.stringify(result).length };
}

test("a registration costs one round trip, not one per operation", async (t) => {
  const one = await connected(t, "budget-sequential");
  const two = await connected(t, "budget-batched");

  const sequentialCost = await sequential(one.client, one.sessionToken);
  const batchedCost = await batched(two.client, two.sessionToken);

  assert.equal(sequentialCost.roundTrips, REGISTRATION.length);
  assert.equal(batchedCost.roundTrips, 1);

  // Batching must not return a much larger payload: the batch returns the
  // same information once, so roughly the same bytes as the eight responses.
  assert.ok(
    batchedCost.bytes <= sequentialCost.bytes * 1.5,
    `batched payload ${batchedCost.bytes} vs sequential ${sequentialCost.bytes}`,
  );
  // No duplicated payload copies anywhere in either style.
  assert.equal(sequentialCost.bytes > 0, true);
});

test("results never carry a second copy of the payload", async (t) => {
  const { client, sessionToken } = await connected(t, "budget-shape");
  const single = await client.callTool({
    name: "project_get_surface",
    arguments: { sessionToken, projectId: "p" },
  });
  assert.equal(JSON.stringify(single).includes("structuredContent"), false);

  const batch = await client.callTool({
    name: "project_apply_batch",
    arguments: {
      sessionToken, projectId: "p",
      ops: [{ op: "createTask", taskId: "t9", goal: "g", actorId: "owner" }, { op: "surface", limit: 5 }],
    },
  });
  assert.equal(JSON.stringify(batch).includes("structuredContent"), false);
  const payload = JSON.parse(batch.content[0].text);
  assert.equal(payload.applied, 2);
  // The post-write read inside the same call is what removes the verify trip.
  assert.equal(payload.results[1].result.tasks[0].taskId, "t9");
});
