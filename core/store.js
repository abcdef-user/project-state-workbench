import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { boundSurface, COLLECTIONS } from "./surface.js";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new StateError('INVALID_INPUT', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export class StateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StateError";
    this.code = code;
    this.details = details;
  }
}

const now = () => new Date().toISOString();
const encode = (value) => JSON.stringify(value ?? null);
const decode = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StateError("INVALID_INPUT", `${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new StateError("INVALID_INPUT", `${name} must be an array`);
  }
  return value;
}

/**
 * Operations `applyBatch` accepts, in the same names the single-shot tools use.
 *
 * Reads and writes mix freely inside one batch: that is the whole point — one
 * model round trip for read + write + verify instead of one per operation.
 */
export const BATCH_OPS = Object.freeze([
  "surface", "getOperation",
  "createTask", "claimTask", "releaseTask", "observeArtifact",
  "recordOperation", "recordDecision", "completeTask",
]);

/** Upper bound on one batch, so a single call cannot become an unbounded write. */
export const BATCH_MAX_OPS = 64;

function rowToTask(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    goal: row.goal,
    acceptanceCriteria: decode(row.acceptance_criteria_json, []),
    status: row.status,
    ownerAgent: row.owner_agent,
    version: row.version,
    completionEvidence: decode(row.completion_evidence_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToArtifact(row) {
  return {
    path: row.path,
    taskId: row.task_id,
    contentHash: row.content_hash,
    summary: row.summary,
    observedBy: row.observed_by,
    observedAt: row.observed_at,
    revision: row.revision,
    sourceEventId: row.source_event_id,
  };
}

function rowToOperation(row, includeResult = true) {
  return {
    operationId: row.operation_id,
    taskId: row.task_id,
    tool: row.tool_name,
    target: row.target,
    argsHash: row.args_hash,
    targetVersion: row.target_version,
    status: row.status,
    ...(includeResult && Buffer.byteLength(row.result_json) <= 8192
      ? { result: decode(row.result_json) } : { resultOmitted: true }),
    resultSize: Buffer.byteLength(row.result_json),
    idempotencyKey: row.idempotency_key,
    actorId: row.actor_id,
    revision: row.revision,
    eventId: row.event_id,
    createdAt: row.created_at,
  };
}

function rowToDecision(row) {
  return {
    decisionId: row.decision_id,
    taskId: row.task_id,
    subject: row.subject,
    decision: row.decision,
    evidence: decode(row.evidence_json, []),
    status: row.status,
    actorId: row.actor_id,
    revision: row.revision,
    eventId: row.event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectStateStore {
  /** Non-null only while `applyBatch` owns the transaction. */
  #batch = null;

  constructor(dbPath = ":memory:") {
    this.dbPath = dbPath === ":memory:" ? dbPath : resolve(dbPath);
    if (this.dbPath !== ":memory:") mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    // Configure before WAL/schema initialization, which can also contend for locks.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (this.dbPath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.#initSchema();
  }

  close() {
    this.db.close();
  }

  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT,
        actor_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT,
        project_revision INTEGER NOT NULL,
        caused_by TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_project_revision
        ON events(project_id, project_revision DESC);
      CREATE INDEX IF NOT EXISTS idx_events_task
        ON events(project_id, task_id, project_revision DESC);

      CREATE TABLE IF NOT EXISTS tasks (
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_agent TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        completion_evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, task_id),
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        task_id TEXT,
        content_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        observed_by TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        source_event_id TEXT NOT NULL,
        PRIMARY KEY(project_id, path),
        FOREIGN KEY(project_id) REFERENCES projects(project_id),
        FOREIGN KEY(source_event_id) REFERENCES events(event_id)
      );

      CREATE TABLE IF NOT EXISTS operations (
        project_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        task_id TEXT,
        tool_name TEXT NOT NULL,
        target TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        target_version TEXT,
        status TEXT NOT NULL,
        result_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, operation_id),
        FOREIGN KEY(project_id) REFERENCES projects(project_id),
        FOREIGN KEY(event_id) REFERENCES events(event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_operations_idempotency
        ON operations(project_id, idempotency_key, status);

      CREATE TABLE IF NOT EXISTS decisions (
        project_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        task_id TEXT,
        subject TEXT NOT NULL,
        decision TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        status TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, decision_id),
        FOREIGN KEY(project_id) REFERENCES projects(project_id),
        FOREIGN KEY(event_id) REFERENCES events(event_id)
      );
    `);
  }

  #ensureProject(projectId) {
    const timestamp = now();
    this.db.prepare(`
      INSERT OR IGNORE INTO projects(project_id, revision, created_at, updated_at)
      VALUES (?, 0, ?, ?)
    `).run(projectId, timestamp, timestamp);
  }

  #appendEvent({ projectId, taskId = null, actorId, eventType, objectType, objectId, payload, revision, idempotencyKey = null, causedBy = null }) {
    const eventId = randomUUID();
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO events(
        event_id, project_id, task_id, actor_id, event_type, object_type,
        object_id, payload_json, idempotency_key, project_revision,
        caused_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId, projectId, taskId, actorId, eventType, objectType,
      objectId, encode(payload), idempotencyKey, revision, causedBy, createdAt,
    );
    return { eventId, createdAt };
  }

  #beginImmediate() {
    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (error) {
      if (error.errcode === 5 || error.errcode === 6) {
        throw new StateError('STATE_BUSY', 'state database is busy; retry after refreshing the Surface');
      }
      throw error;
    }
  }

  #currentRevision(projectId) {
    return this.db.prepare("SELECT revision FROM projects WHERE project_id = ?").get(projectId);
  }

  /** Run one mutation body and bump the project revision; never owns the transaction. */
  #change(projectId, project, change) {
    const revision = project.revision + 1;
    const outcome = change(revision) ?? {};
    if (outcome.noChange) return outcome.result;
    this.db.prepare("UPDATE projects SET revision = ?, updated_at = ? WHERE project_id = ?")
      .run(revision, now(), projectId);
    return { ...outcome, revision };
  }

  #mutate(projectId, expectedRevision, change) {
    // Inside applyBatch the transaction is already open and the single
    // optimistic check already ran, so the body runs in place.
    if (this.#batch !== null) return this.#change(projectId, this.#currentRevision(projectId), change);
    this.#beginImmediate();
    try {
      this.#ensureProject(projectId);
      const project = this.#currentRevision(projectId);
      if (expectedRevision !== undefined && expectedRevision !== null && project.revision !== expectedRevision) {
        throw new StateError("REVISION_CONFLICT", "project state changed; refresh the Surface before writing", {
          expectedRevision,
          actualRevision: project.revision,
        });
      }
      const result = this.#change(projectId, project, change);
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  /**
   * Apply several operations in ONE transaction and ONE optimistic check.
   *
   * This exists because the cost of a shared-state write is not the write: it
   * is the full-context model round trip that each separate tool call costs.
   * Batching read+write+verify into a single call turns a registration from
   * ~10 round trips into one, without giving up the event chain, the revision
   * CAS, dedup, or evidence validation — every operation runs the same code
   * path as its single-shot tool.
   *
   * @param input.ops - ordered `{op, ...args}`; reads (`surface`, `getOperation`)
   *   and writes may mix, and later operations see earlier ones.
   * @param input.expectedRevision - checked ONCE, before the first operation.
   * @param input.continueOnError - when true, a failing operation is reported in
   *   place and the rest still run; SQL-level failures always abort the batch.
   * @returns the per-operation outcomes, the new revision, and the counts.
   */
  applyBatch({ projectId, expectedRevision = null, ops, continueOnError = false }) {
    projectId = requireString(projectId, "projectId");
    requireArray(ops, "ops");
    if (ops.length === 0) throw new StateError("INVALID_INPUT", "ops must contain at least one operation");
    if (ops.length > BATCH_MAX_OPS) {
      throw new StateError("INVALID_INPUT", `ops must contain at most ${BATCH_MAX_OPS} operations`);
    }
    ops.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new StateError("INVALID_INPUT", `ops[${index}] must be an object`);
      }
      if (!BATCH_OPS.includes(entry.op)) {
        throw new StateError("UNKNOWN_BATCH_OP", `ops[${index}].op must be one of: ${BATCH_OPS.join(", ")}`);
      }
    });
    if (this.#batch !== null) throw new StateError("INVALID_INPUT", "applyBatch cannot be nested");

    this.#beginImmediate();
    try {
      this.#ensureProject(projectId);
      const project = this.#currentRevision(projectId);
      if (expectedRevision !== undefined && expectedRevision !== null && project.revision !== expectedRevision) {
        throw new StateError("REVISION_CONFLICT", "project state changed; refresh the Surface before writing", {
          expectedRevision,
          actualRevision: project.revision,
        });
      }

      this.#batch = { projectId, expectedRevision };
      const results = [];
      for (const [index, entry] of ops.entries()) {
        const { op, ...args } = entry;
        try {
          results.push({ index, op, ok: true, result: this.#batchOp(op, projectId, args) });
        } catch (error) {
          // Only modelled state failures are survivable; anything the database
          // raised may have left the transaction unusable.
          if (!continueOnError || !(error instanceof StateError)) throw error;
          results.push({
            index, op, ok: false,
            error: { code: error.code, message: error.message, details: error.details },
          });
        }
      }
      this.db.exec("COMMIT;");
      const revision = this.#currentRevision(projectId).revision;
      return {
        projectId,
        revision,
        applied: results.filter((entry) => entry.ok).length,
        failed: results.filter((entry) => !entry.ok).length,
        results,
      };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    } finally {
      this.#batch = null;
    }
  }

  #batchOp(op, projectId, args) {
    if (op === "surface") {
      return this.#readSurface({ taskId: null, ...args, projectId });
    }
    if (op === "getOperation") return this.getOperation({ ...args, projectId });
    // Writes: the batch checked the project revision once, at the start. A
    // per-operation expectedRevision would fight the operations before it.
    return this[op]({ ...args, projectId, expectedRevision: null });
  }

  createTask({ projectId, taskId, goal, acceptanceCriteria = [], actorId = "system", expectedRevision = null }) {
    projectId = requireString(projectId, "projectId");
    taskId = requireString(taskId, "taskId");
    goal = requireString(goal, "goal");
    actorId = requireString(actorId, "actorId");
    requireArray(acceptanceCriteria, "acceptanceCriteria");
    acceptanceCriteria.forEach((item, index) => requireString(item, `acceptanceCriteria[${index}]`));

    return this.#mutate(projectId, expectedRevision, (revision) => {
      const existing = this.db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND task_id = ?").get(projectId, taskId);
      if (existing) throw new StateError("TASK_EXISTS", `task ${taskId} already exists`);
      const timestamp = now();
      const { eventId } = this.#appendEvent({
        projectId, taskId, actorId, eventType: "task_created", objectType: "task", objectId: taskId,
        payload: { goal, acceptanceCriteria }, revision,
      });
      this.db.prepare(`
        INSERT INTO tasks(
          project_id, task_id, goal, acceptance_criteria_json, status,
          owner_agent, version, completion_evidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', NULL, 1, '[]', ?, ?)
      `).run(projectId, taskId, goal, encode(acceptanceCriteria), timestamp, timestamp);
      return { eventId, taskId, status: "pending" };
    });
  }

  claimTask({ projectId, taskId, agentId, expectedRevision = null, expectedTaskVersion = null }) {
    projectId = requireString(projectId, "projectId");
    taskId = requireString(taskId, "taskId");
    agentId = requireString(agentId, "agentId");

    return this.#mutate(projectId, expectedRevision, (revision) => {
      const row = this.db.prepare("SELECT * FROM tasks WHERE project_id = ? AND task_id = ?").get(projectId, taskId);
      if (!row) throw new StateError("TASK_NOT_FOUND", `task ${taskId} does not exist`);
      if (expectedTaskVersion !== null && row.version !== expectedTaskVersion) {
        throw new StateError("TASK_VERSION_CONFLICT", "task changed; refresh the Surface before claiming", {
          expectedTaskVersion,
          actualTaskVersion: row.version,
        });
      }
      if (row.owner_agent === agentId && row.status === "running") {
        return { noChange: true, result: { task: rowToTask(row), duplicate: true } };
      }
      if (row.status === "completed") throw new StateError("TASK_COMPLETED", `task ${taskId} is already completed`);
      if (row.owner_agent && row.owner_agent !== agentId) {
        throw new StateError("TASK_CLAIMED", `task ${taskId} is owned by ${row.owner_agent}`, { ownerAgent: row.owner_agent });
      }

      const { eventId } = this.#appendEvent({
        projectId, taskId, actorId: agentId, eventType: "task_claimed", objectType: "task", objectId: taskId,
        payload: { ownerAgent: agentId }, revision,
      });
      this.db.prepare(`
        UPDATE tasks SET owner_agent = ?, status = 'running', version = version + 1, updated_at = ?
        WHERE project_id = ? AND task_id = ?
      `).run(agentId, now(), projectId, taskId);
      const task = this.db.prepare("SELECT * FROM tasks WHERE project_id = ? AND task_id = ?").get(projectId, taskId);
      return { eventId, task: rowToTask(task), duplicate: false };
    });
  }

  releaseTask({ projectId, taskId, actorId, reason, force = false, expectedRevision = null, expectedTaskVersion = null }) {
    projectId = requireString(projectId, 'projectId');
    taskId = requireString(taskId, 'taskId');
    actorId = requireString(actorId, 'actorId');
    reason = requireString(reason, 'reason');
    if (typeof force !== 'boolean') throw new StateError('INVALID_INPUT', 'force must be boolean');
    if (force && expectedTaskVersion === null) {
      throw new StateError('TASK_VERSION_REQUIRED', 'forced release requires the observed task version');
    }
    return this.#mutate(projectId, expectedRevision, (revision) => {
      const row = this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND task_id = ?').get(projectId, taskId);
      if (!row) throw new StateError('TASK_NOT_FOUND', `task ${taskId} does not exist`);
      if (expectedTaskVersion !== null && row.version !== expectedTaskVersion) {
        throw new StateError('TASK_VERSION_CONFLICT', 'task changed; refresh before releasing');
      }
      if (row.status === 'completed') throw new StateError('TASK_COMPLETED', 'completed tasks cannot be released');
      if (!row.owner_agent) return { noChange: true, result: { task: rowToTask(row), duplicate: true } };
      if (row.owner_agent !== actorId && !force) throw new StateError('TASK_OWNED_BY_OTHER', 'only the owner can release this task without force');
      const { eventId } = this.#appendEvent({
        projectId, taskId, actorId, eventType: 'task_released', objectType: 'task', objectId: taskId,
        payload: { previousOwner: row.owner_agent, force, reason }, revision,
      });
      this.db.prepare("UPDATE tasks SET owner_agent = NULL, status = 'pending', version = version + 1, updated_at = ? WHERE project_id = ? AND task_id = ?")
        .run(now(), projectId, taskId);
      return { eventId, task: rowToTask(this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND task_id = ?').get(projectId, taskId)) };
    });
  }

  observeArtifact({ projectId, taskId = null, path, contentHash, summary = "", actorId, expectedRevision = null }) {
    projectId = requireString(projectId, "projectId");
    path = requireString(path, "path");
    contentHash = requireString(contentHash, "contentHash");
    actorId = requireString(actorId, "actorId");
    if (taskId !== null) taskId = requireString(taskId, "taskId");
    if (typeof summary !== "string") throw new StateError("INVALID_INPUT", "summary must be a string");

    return this.#mutate(projectId, expectedRevision, (revision) => {
      const previous = this.db.prepare("SELECT * FROM artifacts WHERE project_id = ? AND path = ?").get(projectId, path);
      const eventType = previous && previous.content_hash !== contentHash ? "artifact_changed" : "artifact_observed";
      const { eventId, createdAt } = this.#appendEvent({
        projectId, taskId, actorId, eventType, objectType: "artifact", objectId: path,
        payload: { path, contentHash, previousHash: previous?.content_hash ?? null, summary }, revision,
      });
      this.db.prepare(`
        INSERT INTO artifacts(
          project_id, path, task_id, content_hash, summary, observed_by,
          observed_at, revision, source_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, path) DO UPDATE SET
          task_id = excluded.task_id,
          content_hash = excluded.content_hash,
          summary = excluded.summary,
          observed_by = excluded.observed_by,
          observed_at = excluded.observed_at,
          revision = excluded.revision,
          source_event_id = excluded.source_event_id
      `).run(projectId, path, taskId, contentHash, summary, actorId, createdAt, revision, eventId);
      return { eventId, changed: Boolean(previous && previous.content_hash !== contentHash), previousHash: previous?.content_hash ?? null };
    });
  }

  recordOperation({
    projectId, taskId = null, tool, target, argsHash, args, targetVersion = null,
    status, result = null, actorId, operationId = randomUUID(), idempotencyKey = null,
    expectedRevision = null,
  }) {
    projectId = requireString(projectId, "projectId");
    tool = requireString(tool, "tool");
    target = requireString(target, "target");
    if (args !== undefined) {
      const computed = createHash('sha256').update(canonicalJson(args)).digest('hex');
      if (argsHash !== undefined && argsHash !== computed) throw new StateError('ARGS_HASH_MISMATCH', 'argsHash does not match canonical args');
      argsHash = computed;
    }
    argsHash = requireString(argsHash, "argsHash");
    status = requireString(status, "status");
    actorId = requireString(actorId, "actorId");
    operationId = requireString(operationId, "operationId");
    if (taskId !== null) taskId = requireString(taskId, "taskId");
    if (!new Set(["started", "succeeded", "failed"]).has(status)) {
      throw new StateError("INVALID_INPUT", "status must be started, succeeded, or failed");
    }
    idempotencyKey ??= `${tool}:${target}:${argsHash}:${targetVersion ?? ""}`;
    idempotencyKey = requireString(idempotencyKey, 'idempotencyKey');

    return this.#mutate(projectId, expectedRevision, (revision) => {
      const own = this.db.prepare('SELECT * FROM operations WHERE project_id = ? AND operation_id = ?').get(projectId, operationId);
      const matches = (row) => row.tool_name === tool && row.target === target
        && row.args_hash === argsHash && row.target_version === targetVersion && row.idempotency_key === idempotencyKey;
      if (own && (!matches(own) || own.task_id !== taskId)) {
        throw new StateError('OPERATION_ID_CONFLICT', 'operationId belongs to a different operation or task');
      }
      let reusedFrom = null;
      if (own) {
        if (own.actor_id !== actorId) throw new StateError('OPERATION_OWNED_BY_OTHER', 'only the recording actor can advance this operation');
        if (own.status === status) return { noChange: true, result: { operation: rowToOperation(own), duplicate: true } };
        if (own.status !== 'started' || status === 'started') {
          throw new StateError('INVALID_OPERATION_TRANSITION', 'terminal operations are immutable; use a new operationId for a retry');
        }
      } else {
        // Match the tuple too: delimiter collisions or a custom key must never reuse unrelated results.
        const previous = this.db.prepare(`
        SELECT * FROM operations
        WHERE project_id = ? AND idempotency_key = ? AND tool_name = ? AND target = ?
          AND args_hash = ? AND target_version IS ? AND status IN ('started', 'succeeded')
        ORDER BY (task_id IS ?) DESC, revision DESC LIMIT 1
        `).get(projectId, idempotencyKey, tool, target, argsHash, targetVersion, taskId);
        if (previous?.status === 'started') {
          throw new StateError('OPERATION_IN_PROGRESS', 'an equivalent operation is already running; advance its operationId', { operationId: previous.operation_id });
        }
        if (previous?.status === 'succeeded') {
          if (previous.task_id === taskId) return { noChange: true, result: { operation: rowToOperation(previous), duplicate: true } };
          // Keep task attribution while reusing the project's equivalent successful result.
          reusedFrom = previous;
          status = 'succeeded';
          result = decode(previous.result_json);
        }
      }

      const eventType = `operation_${status}`;
      const { eventId, createdAt } = this.#appendEvent({
        projectId, taskId, actorId, eventType, objectType: "operation", objectId: operationId,
        payload: { tool, target, argsHash, targetVersion, status, resultRef: operationId, reusedFrom: reusedFrom?.operation_id ?? null },
        revision, idempotencyKey, causedBy: own?.event_id ?? reusedFrom?.event_id ?? null,
      });
      this.db.prepare(`
        INSERT INTO operations(
          project_id, operation_id, task_id, tool_name, target, args_hash,
          target_version, status, result_json, idempotency_key, actor_id,
          revision, event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, operation_id) DO UPDATE SET
          status = excluded.status, result_json = excluded.result_json,
          revision = excluded.revision, event_id = excluded.event_id
      `).run(
        projectId, operationId, taskId, tool, target, argsHash,
        targetVersion, status, encode(result), idempotencyKey, actorId,
        revision, eventId, createdAt,
      );
      const operation = this.db.prepare("SELECT * FROM operations WHERE project_id = ? AND operation_id = ?")
        .get(projectId, operationId);
      return { operation: rowToOperation(operation), duplicate: Boolean(reusedFrom), reusedFrom: reusedFrom?.operation_id ?? null, eventId };
    });
  }

  getOperation({ projectId, taskId = null, operationId, resultOffset = 0, resultLimit = 8192 }) {
    projectId = requireString(projectId, 'projectId');
    operationId = requireString(operationId, 'operationId');
    integer(resultOffset, 'resultOffset', 0, Number.MAX_SAFE_INTEGER);
    integer(resultLimit, 'resultLimit', 1, 8192);
    const row = this.db.prepare('SELECT * FROM operations WHERE project_id = ? AND operation_id = ?').get(projectId, operationId);
    if (!row || (taskId !== null && row.task_id !== null && row.task_id !== taskId)) {
      throw new StateError('OPERATION_NOT_FOUND', 'operation does not exist in the requested scope');
    }
    const end = resultOffset + resultLimit;
    return { operation: rowToOperation(row, false), resultJson: row.result_json.slice(resultOffset, end),
      resultOffset, nextResultOffset: end < row.result_json.length ? end : null };
  }

  recordDecision({
    projectId, taskId = null, subject, decision, evidence = [], status = "proposed",
    actorId, decisionId = randomUUID(), expectedRevision = null,
  }) {
    projectId = requireString(projectId, "projectId");
    subject = requireString(subject, "subject");
    decision = requireString(decision, "decision");
    actorId = requireString(actorId, "actorId");
    decisionId = requireString(decisionId, "decisionId");
    if (taskId !== null) taskId = requireString(taskId, "taskId");
    requireArray(evidence, "evidence");
    if (!new Set(["proposed", "accepted", "invalidated"]).has(status)) {
      throw new StateError("INVALID_INPUT", "status must be proposed, accepted, or invalidated");
    }
    if (status === "accepted" && evidence.length === 0) {
      throw new StateError("EVIDENCE_REQUIRED", "accepted decisions require evidence");
    }

    return this.#mutate(projectId, expectedRevision, (revision) => {
      const previous = this.db.prepare("SELECT * FROM decisions WHERE project_id = ? AND decision_id = ?")
        .get(projectId, decisionId);
      const eventType = previous ? "decision_updated" : "decision_recorded";
      const { eventId, createdAt } = this.#appendEvent({
        projectId, taskId, actorId, eventType, objectType: "decision", objectId: decisionId,
        payload: { subject, decision, evidence, status, previousStatus: previous?.status ?? null }, revision,
      });
      this.db.prepare(`
        INSERT INTO decisions(
          project_id, decision_id, task_id, subject, decision, evidence_json,
          status, actor_id, revision, event_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, decision_id) DO UPDATE SET
          task_id = excluded.task_id,
          subject = excluded.subject,
          decision = excluded.decision,
          evidence_json = excluded.evidence_json,
          status = excluded.status,
          actor_id = excluded.actor_id,
          revision = excluded.revision,
          event_id = excluded.event_id,
          updated_at = excluded.updated_at
      `).run(
        projectId, decisionId, taskId, subject, decision, encode(evidence),
        status, actorId, revision, eventId, createdAt, createdAt,
      );
      const stored = this.db.prepare("SELECT * FROM decisions WHERE project_id = ? AND decision_id = ?")
        .get(projectId, decisionId);
      return { decision: rowToDecision(stored), eventId };
    });
  }

  completeTask({ projectId, taskId, evidence, actorId, expectedRevision = null, expectedTaskVersion = null }) {
    projectId = requireString(projectId, "projectId");
    taskId = requireString(taskId, "taskId");
    actorId = requireString(actorId, "actorId");
    requireArray(evidence, "evidence");
    if (evidence.length === 0) throw new StateError("EVIDENCE_REQUIRED", "task completion requires evidence");

    return this.#mutate(projectId, expectedRevision, (revision) => {
      const row = this.db.prepare("SELECT * FROM tasks WHERE project_id = ? AND task_id = ?").get(projectId, taskId);
      if (!row) throw new StateError("TASK_NOT_FOUND", `task ${taskId} does not exist`);
      if (row.status === "completed") {
        return { noChange: true, result: { task: rowToTask(row), duplicate: true } };
      }
      if (row.owner_agent && row.owner_agent !== actorId) {
        throw new StateError("TASK_OWNED_BY_OTHER", `task ${taskId} is owned by ${row.owner_agent}`);
      }
      if (expectedTaskVersion !== null && row.version !== expectedTaskVersion) {
        throw new StateError("TASK_VERSION_CONFLICT", "task changed; refresh the Surface before completing", {
          expectedTaskVersion,
          actualTaskVersion: row.version,
        });
      }

      const criteria = decode(row.acceptance_criteria_json, []);
      const covered = new Set(evidence.map((item) => typeof item === "string" ? item : item?.criterion));
      const missing = criteria.filter((criterion) => !covered.has(criterion));
      if (missing.length > 0) {
        throw new StateError("ACCEPTANCE_CRITERIA_UNMET", "completion evidence does not cover every acceptance criterion", { missing });
      }

      const { eventId } = this.#appendEvent({
        projectId, taskId, actorId, eventType: "task_completed", objectType: "task", objectId: taskId,
        payload: { evidence }, revision,
      });
      this.db.prepare(`
        UPDATE tasks SET status = 'completed', completion_evidence_json = ?,
          version = version + 1, updated_at = ?
        WHERE project_id = ? AND task_id = ?
      `).run(encode(evidence), now(), projectId, taskId);
      const task = this.db.prepare("SELECT * FROM tasks WHERE project_id = ? AND task_id = ?").get(projectId, taskId);
      return { task: rowToTask(task), duplicate: false, eventId };
    });
  }

  getSurface(params) {
    this.db.exec('BEGIN DEFERRED');
    try {
      const result = this.#readSurface(params);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #readSurface({ projectId, taskId = null, recentEventLimit = 30, limit = 20, offsets = {}, expectedRevision = null }) {
    projectId = requireString(projectId, "projectId");
    if (taskId !== null) taskId = requireString(taskId, "taskId");
    integer(limit, 'limit', 1, 100);
    integer(recentEventLimit, 'recentEventLimit', 1, 200);
    if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) throw new StateError('INVALID_INPUT', 'offsets must be an object');
    offsets = Object.fromEntries(COLLECTIONS.map((key) => [key, integer(offsets[key] ?? 0, key, 0, Number.MAX_SAFE_INTEGER)]));
    const project = this.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId);
    if (expectedRevision !== null && (project?.revision ?? 0) !== expectedRevision) {
      throw new StateError('REVISION_CONFLICT', 'state changed between pages; restart pagination');
    }
    if (!project) {
      return boundSurface({
        projectId, revision: 0, generatedAt: now(), task: null, tasks: [], artifacts: [],
        operations: [], decisions: [], recentEvents: [],
      }, offsets, Object.fromEntries(COLLECTIONS.map((key) => [key, false])));
    }

    const more = {};
    const page = (key, rows, size = limit) => {
      more[key] = rows.length > size;
      return rows.slice(0, size);
    };
    const taskRows = page('tasks', this.db.prepare(`SELECT * FROM tasks WHERE project_id = ? AND (? IS NULL OR task_id = ?)
      ORDER BY updated_at DESC, task_id LIMIT ? OFFSET ?`).all(projectId, taskId, taskId, limit + 1, offsets.tasks));
    const artifacts = this.db.prepare(`
      SELECT * FROM artifacts
      WHERE project_id = ? AND (? IS NULL OR task_id IS NULL OR task_id = ?)
      ORDER BY revision DESC, path LIMIT ? OFFSET ?
    `).all(projectId, taskId, taskId, limit + 1, offsets.artifacts);
    // Staleness uses the actual target record, never the possibly paginated artifact list.
    const operations = this.db.prepare(`
      SELECT o.*, a.content_hash AS current_hash FROM operations o
      LEFT JOIN artifacts a ON a.project_id = o.project_id AND a.path = o.target
      WHERE o.project_id = ? AND (? IS NULL OR o.task_id IS NULL OR o.task_id = ?)
      ORDER BY o.revision DESC, o.operation_id LIMIT ? OFFSET ?
    `).all(projectId, taskId, taskId, limit + 1, offsets.operations);
    const decisions = this.db.prepare(`
      SELECT * FROM decisions
      WHERE project_id = ? AND (? IS NULL OR task_id IS NULL OR task_id = ?)
      ORDER BY revision DESC, decision_id LIMIT ? OFFSET ?
    `).all(projectId, taskId, taskId, limit + 1, offsets.decisions);
    const eventRows = this.db.prepare(`
      SELECT * FROM events
      WHERE project_id = ? AND (? IS NULL OR task_id IS NULL OR task_id = ?)
      ORDER BY project_revision DESC, event_id LIMIT ? OFFSET ?
    `).all(projectId, taskId, taskId, recentEventLimit + 1, offsets.recentEvents);
    const recentEvents = page('recentEvents', eventRows, recentEventLimit).map((row) => ({
      eventId: row.event_id,
      taskId: row.task_id,
      actorId: row.actor_id,
      type: row.event_type,
      objectType: row.object_type,
      objectId: row.object_id,
      payload: (() => {
        const payload = decode(row.payload_json, {});
        if (row.object_type === 'operation' && Object.hasOwn(payload, 'result')) {
          delete payload.result;
          payload.resultRef = row.object_id;
        }
        return payload;
      })(),
      idempotencyKey: row.idempotency_key,
      revision: row.project_revision,
      causedBy: row.caused_by,
      createdAt: row.created_at,
    }));

    const tasks = taskRows.map(rowToTask);
    return boundSurface({
      projectId,
      revision: project.revision,
      generatedAt: now(),
      task: taskId ? rowToTask(this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND task_id = ?').get(projectId, taskId)) : null,
      tasks,
      artifacts: page('artifacts', artifacts).map(rowToArtifact),
      operations: page('operations', operations).map((row) => ({ ...rowToOperation(row, false),
        stale: Boolean(row.target_version && row.current_hash && row.current_hash !== row.target_version) })),
      decisions: page('decisions', decisions).map(rowToDecision),
      recentEvents,
    }, offsets, more);
  }
}
