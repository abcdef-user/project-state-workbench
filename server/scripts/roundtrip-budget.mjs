#!/usr/bin/env node
/** Compare measured tool-call counts and returned JSON sizes for one fixture. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));

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
  surface: "project_get_surface", createTask: "project_create_task", claimTask: "project_claim_task",
  recordOperation: "project_record_operation", recordDecision: "project_record_decision",
  observeArtifact: "project_observe_artifact", completeTask: "project_complete_task",
};

async function session(directory, label) {
  const workspaceRoot = join(directory, label);
  mkdirSync(workspaceRoot, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "..", "src", "mcp-server.js")],
    env: { ...process.env, PROJECT_STATE_ROOT: join(directory, "data"), PROJECT_STATE_DB: "" },
  });
  const client = new Client({ name: "roundtrip-budget", version: "0.1.0" });
  await client.connect(transport);
  const opened = await client.callTool({ name: "project_open_session", arguments: { workspaceRoot, projectId: "p" } });
  return { client, sessionToken: JSON.parse(opened.content[0].text).sessionToken };
}

async function sequential(client, sessionToken) {
  let bytes = 0;
  for (const { op, ...args } of REGISTRATION) {
    const result = await client.callTool({ name: TOOL_FOR[op], arguments: { sessionToken, projectId: "p", ...args } });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    bytes += JSON.stringify(result).length;
  }
  return { roundTrips: REGISTRATION.length, bytes };
}

async function batched(client, sessionToken) {
  const result = await client.callTool({ name: "project_apply_batch", arguments: { sessionToken, projectId: "p", ops: REGISTRATION } });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return { roundTrips: 1, bytes: JSON.stringify(result).length };
}

const directory = mkdtempSync(join(tmpdir(), "project-state-budget-report-"));
try {
  const one = await session(directory, "sequential");
  const two = await session(directory, "batched");
  const rows = [
    ["逐条调用（每个操作一个工具）", await sequential(one.client, one.sessionToken)],
    ["单次批量 project_apply_batch", await batched(two.client, two.sessionToken)],
  ];
  await one.client.close();
  await two.client.close();

  console.log(JSON.stringify({fixtureOnly:true, rows:rows.map(([style,value])=>({style,...value})), note:'Protocol call counts and returned JSON code units only; not a billing or usage-quota estimate.'},null,2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
