import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectStateStore, StateError } from "../src/store.js";
import { WorkspaceStoreRouter } from "../src/workspace-store.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-state-"));
  const store = new ProjectStateStore(join(directory, "state.db"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

function createTask(store) {
  return store.createTask({
    projectId: "modeling",
    taskId: "task-1",
    goal: "建立订单事实表",
    acceptanceCriteria: ["确认粒度", "验证主键"],
    actorId: "user",
  });
}

test("a second conversation can read state written by the first", (t) => {
  const store = fixture(t);
  createTask(store);
  store.claimTask({ projectId: "modeling", taskId: "task-1", agentId: "agent-a" });
  store.observeArtifact({
    projectId: "modeling",
    taskId: "task-1",
    path: "models/orders.sql",
    contentHash: "hash-v1",
    summary: "订单模型初稿",
    actorId: "agent-a",
  });

  const surfaceForAgentB = store.getSurface({ projectId: "modeling", taskId: "task-1" });
  assert.equal(surfaceForAgentB.task.ownerAgent, "agent-a");
  assert.equal(surfaceForAgentB.artifacts[0].contentHash, "hash-v1");
  assert.equal(surfaceForAgentB.artifacts[0].summary, "订单模型初稿");
});

test("successful equivalent operations are deduplicated", (t) => {
  const store = fixture(t);
  createTask(store);
  const first = store.recordOperation({
    projectId: "modeling",
    taskId: "task-1",
    tool: "profile_dataset",
    target: "raw.orders",
    argsHash: "args-1",
    targetVersion: "snapshot-1",
    status: "succeeded",
    result: { rows: 100 },
    actorId: "agent-a",
  });
  const revisionAfterFirst = first.revision;
  const second = store.recordOperation({
    projectId: "modeling",
    taskId: "task-1",
    tool: "profile_dataset",
    target: "raw.orders",
    argsHash: "args-1",
    targetVersion: "snapshot-1",
    status: "succeeded",
    result: { rows: 100 },
    actorId: "agent-b",
  });

  assert.equal(second.duplicate, true);
  assert.equal(store.getSurface({ projectId: "modeling" }).revision, revisionAfterFirst);
  assert.equal(store.getSurface({ projectId: "modeling" }).operations.length, 1);
});

test("operations become stale when their target artifact changes", (t) => {
  const store = fixture(t);
  createTask(store);
  store.observeArtifact({
    projectId: "modeling", taskId: "task-1", path: "raw/orders.csv",
    contentHash: "hash-v1", summary: "原始订单", actorId: "agent-a",
  });
  store.recordOperation({
    projectId: "modeling", taskId: "task-1", tool: "inspect_file",
    target: "raw/orders.csv", argsHash: "all-columns", targetVersion: "hash-v1",
    status: "succeeded", result: { columns: 8 }, actorId: "agent-a",
  });
  assert.equal(store.getSurface({ projectId: "modeling", taskId: "task-1" }).operations[0].stale, false);

  const update = store.observeArtifact({
    projectId: "modeling", taskId: "task-1", path: "raw/orders.csv",
    contentHash: "hash-v2", summary: "原始订单已更新", actorId: "agent-b",
  });
  const surface = store.getSurface({ projectId: "modeling", taskId: "task-1" });
  assert.equal(update.changed, true);
  assert.equal(surface.operations[0].stale, true);
  assert.equal(surface.recentEvents[0].type, "artifact_changed");
});

test("revision and ownership conflicts are rejected", (t) => {
  const store = fixture(t);
  const created = createTask(store);
  store.claimTask({
    projectId: "modeling", taskId: "task-1", agentId: "agent-a",
    expectedRevision: created.revision,
  });

  assert.throws(
    () => store.observeArtifact({
      projectId: "modeling", taskId: "task-1", path: "x.csv", contentHash: "1",
      actorId: "agent-b", expectedRevision: created.revision,
    }),
    (error) => error instanceof StateError && error.code === "REVISION_CONFLICT",
  );
  assert.throws(
    () => store.claimTask({ projectId: "modeling", taskId: "task-1", agentId: "agent-b" }),
    (error) => error instanceof StateError && error.code === "TASK_CLAIMED",
  );
});

test("completion requires evidence for every acceptance criterion", (t) => {
  const store = fixture(t);
  createTask(store);
  store.claimTask({ projectId: "modeling", taskId: "task-1", agentId: "agent-a" });

  assert.throws(
    () => store.completeTask({
      projectId: "modeling", taskId: "task-1", actorId: "agent-a",
      evidence: [{ criterion: "确认粒度", proof: "profile-1" }],
    }),
    (error) => error instanceof StateError && error.code === "ACCEPTANCE_CRITERIA_UNMET",
  );

  const completed = store.completeTask({
    projectId: "modeling",
    taskId: "task-1",
    actorId: "agent-a",
    evidence: [
      { criterion: "确认粒度", proof: "profile-1" },
      { criterion: "验证主键", proof: "test-1" },
    ],
  });
  assert.equal(completed.task.status, "completed");
});

test("accepted decisions require evidence", (t) => {
  const store = fixture(t);
  createTask(store);
  assert.throws(
    () => store.recordDecision({
      projectId: "modeling", taskId: "task-1", subject: "订单粒度",
      decision: "一行一个订单", status: "accepted", evidence: [], actorId: "agent-a",
    }),
    (error) => error instanceof StateError && error.code === "EVIDENCE_REQUIRED",
  );

  const recorded = store.recordDecision({
    projectId: "modeling", taskId: "task-1", subject: "订单粒度",
    decision: "一行一个订单", status: "accepted", evidence: ["profile-1"], actorId: "agent-a",
  });
  assert.equal(recorded.decision.status, "accepted");
});

test("workspaces with the same name use separate databases", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-state-"));
  const firstRoot = join(directory, "first", "modeling");
  const secondRoot = join(directory, "second", "modeling");
  const dataRoot = join(directory, "state");
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  const router = new WorkspaceStoreRouter({ dataRoot });
  t.after(() => {
    router.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const first = router.open(firstRoot);
  const second = router.open(secondRoot);
  first.store.createTask({
    projectId: "same-project", taskId: "task-1", goal: "first workspace",
    acceptanceCriteria: [], actorId: "test",
  });
  second.store.createTask({
    projectId: "same-project", taskId: "task-1", goal: "second workspace",
    acceptanceCriteria: [], actorId: "test",
  });

  assert.notEqual(first.workspace.workspaceId, second.workspace.workspaceId);
  assert.notEqual(first.workspace.databasePath, second.workspace.databasePath);
  assert.equal(first.store.getSurface({ projectId: "same-project", taskId: "task-1" }).task.goal, "first workspace");
  assert.equal(second.store.getSurface({ projectId: "same-project", taskId: "task-1" }).task.goal, "second workspace");
  const metadata = JSON.parse(readFileSync(join(first.workspace.stateDirectory, "workspace.json"), "utf8"));
  assert.equal(metadata.rootPath, first.workspace.rootPath);
});
