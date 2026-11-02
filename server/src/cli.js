#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from 'node:url';
import { StateError } from "./store.js";
import { WorkspaceStoreRouter } from "./workspace-store.js";

const aliases = {
  "create-task": "createTask",
  create_task: "createTask",
  "get-surface": "getSurface",
  get_surface: "getSurface",
  "claim-task": "claimTask",
  claim_task: "claimTask",
  "observe-artifact": "observeArtifact",
  observe_artifact: "observeArtifact",
  "record-operation": "recordOperation",
  record_operation: "recordOperation",
  "record-decision": "recordDecision",
  record_decision: "recordDecision",
  "complete-task": "completeTask",
  complete_task: "completeTask",
  'release-task': 'releaseTask',
  release_task: 'releaseTask',
  'get-operation': 'getOperation',
  get_operation: 'getOperation',
  // One call for a whole registration; see core/store.js applyBatch.
  'apply-batch': 'applyBatch',
  apply_batch: 'applyBatch',
  applyBatch: 'applyBatch',
};

function serializeError(error) {
  return {
    ok: false,
    error: {
      code: error instanceof StateError ? error.code : "INTERNAL_ERROR",
      message: error.message,
      details: error instanceof StateError ? error.details : {},
    },
  };
}

export function dispatch(store, method, params) {
  const resolved = aliases[method] ?? method;
  if (!Object.values(aliases).includes(resolved)) {
    throw new StateError("UNKNOWN_METHOD", `unknown method: ${method}`);
  }
  return store[resolved](params ?? {});
}

async function main() {
  const args = process.argv.slice(2);
  let dbPath = process.env.PROJECT_STATE_DB ?? null;
  let dataRoot = process.env.PROJECT_STATE_ROOT ?? "./data/workspaces";
  let workspaceRoot = process.env.PROJECT_STATE_WORKSPACE ?? process.cwd();
  const dbIndex = args.indexOf("--db");
  if (dbIndex >= 0) {
    dbPath = args[dbIndex + 1];
    args.splice(dbIndex, 2);
  }
  const rootIndex = args.indexOf("--root");
  if (rootIndex >= 0) {
    dataRoot = args[rootIndex + 1];
    args.splice(rootIndex, 2);
  }
  const workspaceIndex = args.indexOf("--workspace");
  if (workspaceIndex >= 0) {
    workspaceRoot = args[workspaceIndex + 1];
    args.splice(workspaceIndex, 2);
  }
  let router;
  try {
    router = dbPath
      ? new WorkspaceStoreRouter({ dbPath })
      : new WorkspaceStoreRouter({ dataRoot, defaultWorkspaceRoot: workspaceRoot });
    const { store, workspace } = router.open(workspaceRoot);

    if (args.length > 0) {
      const method = args[0];
      const params = args[1] ? JSON.parse(args[1]) : {};
      // Same default as the MCP and DSH adapters: an omitted projectId means
      // "this workspace's project", named after the workspace directory.
      if (params.projectId === undefined && workspace) params.projectId = workspace.name;
      const result = dispatch(store, method, params);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        workspace: workspace ? {
          workspaceId: workspace.workspaceId,
          rootPath: workspace.rootPath,
          databasePath: workspace.databasePath,
        } : null,
        result,
      }, null, 2)}\n`);
      return;
    }

    process.stdin.setEncoding("utf8");
    let buffer = "";
    const respond = (line) => {
      if (!line.trim()) return;
      let request;
      try {
        request = JSON.parse(line);
        const params = request.params ?? {};
        if (params.projectId === undefined && workspace) params.projectId = workspace.name;
        const result = dispatch(store, request.method, params);
        process.stdout.write(`${JSON.stringify({ id: request.id ?? null, ok: true, result })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ id: request?.id ?? null, ...serializeError(error) })}\n`);
      }
    };
    for await (const chunk of process.stdin) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        respond(line);
      }
    }
    respond(buffer);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(serializeError(error), null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    router?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
