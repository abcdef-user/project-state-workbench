#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { BATCH_MAX_OPS, BATCH_OPS, StateError } from "./store.js";
import { WorkspaceStoreRouter } from "./workspace-store.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultDataRoot = join(moduleDir, "..", "data", "workspaces");
if (!process.env.PROJECT_STATE_ROOT && !process.env.PROJECT_STATE_DB) {
  process.stderr.write(`PROJECT_STATE_ROOT is not configured; using ${defaultDataRoot}. Set a stable data directory before installing/updating the plugin.\n`);
}
const router = new WorkspaceStoreRouter({
  dbPath: process.env.PROJECT_STATE_DB || null,
  dataRoot: process.env.PROJECT_STATE_ROOT || defaultDataRoot,
  defaultWorkspaceRoot: process.env.PROJECT_STATE_WORKSPACE || null,
});
/**
 * Whether to ALSO return `structuredContent` next to the text content.
 *
 * Off by default: the host records both copies verbatim in the transcript, and
 * over 43 real calls that duplicate copy was 50.7% of every shared-state result
 * character — re-sent, and re-charged, on every later request of the
 * conversation. Set PROJECT_STATE_STRUCTURED_CONTENT=1 to restore the old shape
 * for a client that needs the typed field.
 */
const EMIT_STRUCTURED_CONTENT = process.env.PROJECT_STATE_STRUCTURED_CONTENT === "1";

const server = new McpServer(
  { name: "project-shared-state", version: "0.5.0" },
  {
    // Keep this SHORT. The host prepends the server instructions to EVERY tool
    // description, so a long paragraph is paid once per tool per catalog dump
    // (the previous wording was 48% of the shared-state declaration block,
    // repeated 11 times). The full authorization policy lives in README.md.
    instructions: "OFF until the user enables this plugin in the conversation. Data tools need the token from project_open_session; never fabricate, reuse, or echo it.",
  },
);
const sessions = new Map();

const optionalRevision = z.number().int().nonnegative().optional();
/**
 * Optional on every tool: omitted means "the project this conversation opened",
 * which defaults to the workspace directory name — the SAME default the DSH
 * adapter uses, so an unnamed project is shared across harnesses instead of
 * splitting into two namespaces.
 */
const projectIdSchema = z.string().min(1).optional();
const workspaceRootSchema = z.string().min(1).describe(
  "Absolute root path of the current workspace. Required to select its isolated state database.",
);
const sessionTokenSchema = z.string().uuid().describe(
  "In-memory token returned by project_open_session for this conversation.",
);

function requireSession(params) {
  const session = sessions.get(params.sessionToken);
  if (!session) {
    throw new StateError(
      "SHARED_STATE_DISABLED",
      "shared state is not enabled for this conversation; ask the user before opening a session",
    );
  }
  if (params.projectId !== undefined && params.projectId !== session.projectId) {
    throw new StateError("SESSION_SCOPE_VIOLATION", "session token belongs to another project");
  }
  if (session.taskId && params.taskId && params.taskId !== session.taskId) {
    throw new StateError("SESSION_SCOPE_VIOLATION", "session token belongs to another task");
  }
  return session;
}

function useStore(params, action) {
  const session = requireSession(params);
  const scopedParams = {
    ...params,
    projectId: params.projectId ?? session.projectId,
    ...session.taskId && !params.taskId ? { taskId: session.taskId } : {},
  };
  const { store, workspace } = session.opened;
  // The workspace is handed to the action so a batched read can carry the same
  // shape as its standalone tool, not just the batch envelope.
  const result = action(store, scopedParams, workspace);
  if (!workspace) return result;
  return {
    ...result,
    workspace: {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      rootPath: workspace.rootPath,
    },
  };
}

async function response(action) {
  try {
    const result = await action();
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      ...EMIT_STRUCTURED_CONTENT ? { structuredContent: result } : {},
    };
  } catch (error) {
    const body = {
      code: error instanceof StateError ? error.code : "INTERNAL_ERROR",
      message: error.message,
      details: error instanceof StateError ? error.details : {},
    };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  }
}

server.registerTool("project_open_session", {
  description: "Enable shared state after the user explicitly selects/attaches this plugin or asks to use shared state in the current conversation.",
  inputSchema: {
    workspaceRoot: workspaceRootSchema,
    projectId: projectIdSchema,
    taskId: z.string().min(1).optional(),
  },
}, (params) => response(() => {
  const opened = router.open(params.workspaceRoot);
  const { workspace } = opened;
  const sessionToken = randomUUID();
  const session = {
    sessionToken,
    opened,
    workspaceRoot: params.workspaceRoot,
    projectId: params.projectId ?? workspace?.name ?? 'default',
    taskId: params.taskId ?? null,
    openedAt: new Date().toISOString(),
  };
  sessions.set(sessionToken, session);
  return {
    enabled: true,
    sessionToken,
    scope: { projectId: session.projectId, taskId: session.taskId },
    workspace: workspace ? {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      rootPath: workspace.rootPath,
    } : null,
  };
}));

server.registerTool("project_close_session", {
  description: "Disable shared-state access for the current conversation by invalidating its in-memory token. Call this when the user asks to stop sharing.",
  inputSchema: { sessionToken: sessionTokenSchema },
}, (params) => response(() => {
  const closed = sessions.delete(params.sessionToken);
  return { enabled: false, closed };
}));

server.registerTool("project_get_surface", {
  description: "Read a bounded summary. Follow pagination offsets with expectedRevision; refresh from page one if the revision changes. Full results: project_get_operation.",
  inputSchema: {
    sessionToken: sessionTokenSchema,
    projectId: projectIdSchema,
    taskId: z.string().min(1).optional(),
    recentEventLimit: z.number().int().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offsets: z.object(Object.fromEntries(['tasks', 'artifacts', 'operations', 'decisions', 'recentEvents']
      .map((key) => [key, z.number().int().nonnegative().optional()]))).optional(),
    expectedRevision: optionalRevision,
  },
}, (params) => response(() => useStore(params, (store, scoped) => store.getSurface(scoped))));

server.registerTool("project_create_task", {
  description: "Create a project task with explicit acceptance criteria.",
  inputSchema: {
    sessionToken: sessionTokenSchema,
    projectId: projectIdSchema,
    taskId: z.string().min(1),
    goal: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).default([]),
    actorId: z.string().min(1).default("system"),
    expectedRevision: optionalRevision,
  },
}, (params) => response(() => useStore(params, (store, scoped) => store.createTask(scoped))));

server.registerTool("project_claim_task", {
  description: "Claim a task for one Agent. Rejects conflicting claims.",
  inputSchema: {
    sessionToken: sessionTokenSchema,
    projectId: projectIdSchema,
    taskId: z.string().min(1),
    agentId: z.string().min(1),
    expectedRevision: optionalRevision,
    expectedTaskVersion: z.number().int().positive().optional(),
  },
}, (params) => response(() => useStore(params, (store, scoped) => store.claimTask(scoped))));

server.registerTool('project_release_task', {
  description: 'Release a task with a reason. Force release requires the observed expectedTaskVersion; completed tasks cannot be released.',
  inputSchema: {
    sessionToken: sessionTokenSchema, projectId: projectIdSchema, taskId: z.string().min(1),
    actorId: z.string().min(1), reason: z.string().min(1), force: z.boolean().optional(),
    expectedRevision: optionalRevision, expectedTaskVersion: z.number().int().positive().optional(),
  },
}, (params) => response(() => useStore(params, (store, scoped) => store.releaseTask(scoped))));

server.registerTool('project_get_operation', {
  description: 'Read one operation and a chunk of its stored result JSON without rerunning the original tool. Concatenate resultJson chunks using nextResultOffset.',
  inputSchema: {
    sessionToken: sessionTokenSchema, projectId: projectIdSchema, taskId: z.string().min(1).optional(),
    operationId: z.string().min(1), resultOffset: z.number().int().nonnegative().optional(),
    resultLimit: z.number().int().min(1).max(8192).optional(),
  },
}, (params) => response(() => useStore(params, (store, scoped) => store.getOperation(scoped))));

server.registerTool("project_observe_artifact", {
  description: "Record an observed file or artifact version and summary.",
  inputSchema: {
    sessionToken: sessionTokenSchema,
    projectId: projectIdSchema,
    taskId: z.string().min(1).optional(),
    path: z.string().min(1),
    contentHash: z.string().min(1),
    summary: z.string().default(""),
    actorId: z.string().min(1),
    expectedRevision: optionalRevision,
  },
}, (params) => response(() => useStore(params, (store, scoped) => store.observeArtifact(scoped))));

server.registerTool("project_record_operation", {
  description: "Record an operation. Advance started using its returned operationId and the same actor. Supply args for canonical hashing or argsHash. Equivalent successes are reused with task-local attribution.",
  inputSchema: {
    sessionToken: sessionTokenSchema,
    projectId: projectIdSchema,
    taskId: z.string().min(1).optional(),
    tool: z.string().min(1),
    target: z.string().min(1),
    argsHash: z.string().min(1).optional(),
    args: z.unknown().optional(),
    targetVersion: z.string().optional(),
    status: z.enum(["started", "succeeded", "failed"]),
    result: z.unknown().optional(),
    actorId: z.string().min(1),
    operationId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1).optional(),
    expectedRevision: optionalRevision,
  },
}, (params) => response(() => useStore(params, (store, scoped) => store.recordOperation(scoped))));

server.registerTool("project_record_decision", {
  description: "Record a proposed, accepted, or invalidated project decision.",
  inputSchema: {
    sessionToken: sessionTokenSchema,
    projectId: projectIdSchema,
    taskId: z.string().min(1).optional(),
    subject: z.string().min(1),
    decision: z.string().min(1),
    evidence: z.array(z.unknown()).default([]),
    status: z.enum(["proposed", "accepted", "invalidated"]).default("proposed"),
    actorId: z.string().min(1),
    decisionId: z.string().min(1).optional(),
    expectedRevision: optionalRevision,
  },
}, (params) => response(() => useStore(params, (store, scoped) => store.recordDecision(scoped))));

server.registerTool("project_complete_task", {
  description: "Complete a task only when evidence covers every acceptance criterion.",
  inputSchema: {
    sessionToken: sessionTokenSchema,
    projectId: projectIdSchema,
    taskId: z.string().min(1),
    evidence: z.array(z.union([
      z.string().min(1),
      z.object({ criterion: z.string().min(1), proof: z.unknown().optional() }).passthrough(),
    ])).min(1),
    actorId: z.string().min(1),
    expectedRevision: optionalRevision,
    expectedTaskVersion: z.number().int().positive().optional(),
  },
}, (params) => response(() => useStore(params, (store, scoped) => store.completeTask(scoped))));

/**
 * One batch entry: the operation name plus that operation's own arguments.
 *
 * `passthrough` matters — anything else would strip the operation-specific
 * fields before the handler ever sees them.
 */
const batchOpSchema = z.object({
  op: z.enum(BATCH_OPS),
}).passthrough();

server.registerTool("project_apply_batch", {
  description: "Apply several shared-state operations in ONE round trip, in order; reads (`surface`, `getOperation`) and writes may mix, and later operations see earlier ones. PREFER THIS over one call per operation: every separate tool call costs a full model request carrying the whole conversation, so a registration split across 10 calls costs ~10x a registration batched into one. The whole batch is one transaction with one `expectedRevision` check; a failing operation rolls the batch back unless `continueOnError` is set. `actorId` and the session task scope are defaults for operations that omit them.",
  inputSchema: {
    sessionToken: sessionTokenSchema,
    projectId: projectIdSchema,
    taskId: z.string().min(1).optional(),
    actorId: z.string().min(1).optional(),
    expectedRevision: optionalRevision,
    continueOnError: z.boolean().optional(),
    ops: z.array(batchOpSchema).min(1).max(BATCH_MAX_OPS).describe(
      "Ordered operations. Each is `{op, ...arguments of that operation}`.",
    ),
  },
}, (params) => response(() => useStore(params, (store, scoped, workspace) => {
  const ops = params.ops.map(({ op, ...args }) => ({
    op,
    // Batch-level defaults only; an operation's own value always wins. For
    // `claimTask` the batch-level actorId covers `agentId`, the identity field
    // that operation uses.
    ...scoped.taskId && args.taskId === undefined ? { taskId: scoped.taskId } : {},
    ...params.actorId !== undefined && args.actorId === undefined ? { actorId: params.actorId } : {},
    ...op === "claimTask" && params.actorId !== undefined && args.agentId === undefined
      ? { agentId: params.actorId } : {},
    ...args,
  }));
  const batch = store.applyBatch({
    projectId: scoped.projectId,
    expectedRevision: params.expectedRevision ?? null,
    ops,
    continueOnError: Boolean(params.continueOnError),
  });
  if (!workspace) return batch;
  // A batched read must look like `project_get_surface`, which returns the
  // surface fields with the workspace alongside them.
  const results = batch.results.map((entry) => (entry.ok && entry.op === "surface"
    ? {
      ...entry,
      result: {
        ...entry.result,
        workspace: {
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          rootPath: workspace.rootPath,
        },
      },
    }
    : entry));
  return { ...batch, results };
})));

async function shutdown() {
  sessions.clear();
  router.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
