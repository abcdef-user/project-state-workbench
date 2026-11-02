/**
 * Host-neutral logic for the DSH shared-state plugin.
 *
 * Everything here is plain Node: the workspace-scoped SQLite core, the bounded
 * digest a new conversation receives once, the read-only mirror any
 * conversation can `read`, and the per-session on/off switch. Cordis wiring,
 * tool schemas, per-agent tool gating, and the spill backend live in
 * `index.js`, so this module is testable without a running Harness.
 *
 * @module dsh-shared-state/handlers
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { BATCH_MAX_OPS, BATCH_OPS, StateError } from 'project-shared-state-core/store';
import { WorkspaceStoreRouter } from 'project-shared-state-core/workspace-store';

/** Hard ceiling for the injected digest, in UTF-16 code units. */
export const DIGEST_MAX_CHARS = 1200;
/** Results at or below this byte size stay inline; larger ones spill. */
export const DEFAULT_SPILL_BYTES = 8192;
/** Workspace-relative directory holding one read-only mirror per project; `null` disables it. */
export const DEFAULT_MIRROR_DIR = '.dsh/shared-state';
/** Ceiling for the mirror file, in UTF-16 code units. */
export const DEFAULT_MIRROR_MAX_CHARS = 16384;

/**
 * The batch vocabulary lives in the core, so the tool schema, the adapter and
 * `applyBatch` cannot drift apart. Re-exported for the tool registry.
 */
export { BATCH_MAX_OPS, BATCH_OPS };

/** Operations that must carry an actor identity; this adapter supplies it. */
const WRITE_OPS = new Set([
  'createTask', 'claimTask', 'releaseTask', 'observeArtifact',
  'recordOperation', 'recordDecision', 'completeTask',
]);

/** Collapse whitespace and truncate, so one record never eats the digest. */
export function oneLine(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/**
 * Render the bounded cross-conversation digest injected once per session.
 *
 * The digest carries only what a NEW conversation needs to continue without
 * reading any earlier transcript: the project revision, unfinished work, the
 * latest decisions, and which files moved. It never carries result bodies.
 *
 * @param input - a bounded surface plus its identity.
 * @returns markdown text, at most `maxChars` code units.
 */
export function buildDigest({ projectId, workspaceName, surface, maxChars = DIGEST_MAX_CHARS }) {
  if (!surface || surface.revision === 0) return '';
  const lines = [`## 共享状态（跨对话）`, ``,
    `项目 \`${oneLine(projectId, 60)}\` · 工作区 ${oneLine(workspaceName ?? '', 60)} · revision ${surface.revision} · 更新 ${oneLine(surface.generatedAt, 30)}`, ``];
  const openTasks = (surface.tasks ?? []).filter((task) => task.status !== 'completed').slice(0, 5);
  if (openTasks.length > 0) {
    lines.push(`进行中任务 (${openTasks.length}${surface.pagination?.tasks?.hasMore ? '+' : ''})：`);
    for (const task of openTasks) {
      const owner = task.ownerAgent ? ` @${oneLine(task.ownerAgent, 24)}` : '';
      lines.push(`- \`${oneLine(task.taskId, 40)}\` ${oneLine(task.goal, 70)}${owner}`);
    }
    lines.push('');
  }
  const decisions = (surface.decisions ?? []).slice(0, 4);
  if (decisions.length > 0) {
    lines.push(`最近决策：`);
    for (const decision of decisions) {
      lines.push(`- [${oneLine(decision.status, 12)}] ${oneLine(decision.subject, 40)} → ${oneLine(decision.decision, 60)}`);
    }
    lines.push('');
  }
  const artifacts = (surface.artifacts ?? []).slice(0, 5);
  if (artifacts.length > 0) {
    lines.push(`已观察文件 (${artifacts.length}${surface.pagination?.artifacts?.hasMore ? '+' : ''})：`
      + artifacts.map((artifact) => `\`${oneLine(artifact.path, 50)}\``).join(' '));
    lines.push('');
  }
  lines.push('完整状态用 `shared_state_surface` 读取（含分页）；读写尽量合并进同一次 `shared_state_apply`。');
  const text = lines.join('\n').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Render the read-only mirror any conversation (or any other harness) can read
 * from the workspace without loading a single tool schema.
 *
 * @param input - a bounded surface, its identity, and the workspace root.
 * @returns markdown text, at most `maxChars` code units.
 */
export function buildMirror({ projectId, workspace, surface, maxChars = DEFAULT_MIRROR_MAX_CHARS }) {
  if (!surface) return '';
  const lines = [
    '<!-- 自动生成，请勿手改。由 dsh-shared-state 插件在每次读写共享状态后刷新。 -->',
    `# 共享状态 · ${oneLine(projectId, 80)}`,
    '',
    `- 工作区：\`${workspace?.rootPath ?? ''}\``,
    `- revision：**${surface.revision}**`,
    `- 生成时间：${oneLine(surface.generatedAt, 40)}`,
    '',
    '本文件是只读镜像：任何对话都可以直接 `read` 它；写入必须用共享状态工具（`/shared on`）。',
    '',
  ];
  const tasks = surface.tasks ?? [];
  if (tasks.length > 0) {
    lines.push(`## 任务（${tasks.length}${surface.pagination?.tasks?.hasMore ? '+' : ''}）`, '',
      '| taskId | 状态 | 负责人 | 目标 |', '|---|---|---|---|');
    for (const task of tasks) {
      lines.push(`| \`${oneLine(task.taskId, 40)}\` | ${oneLine(task.status, 12)} | ${oneLine(task.ownerAgent ?? '-', 32)} | ${oneLine(task.goal, 90)} |`);
    }
    lines.push('');
  }
  const decisions = surface.decisions ?? [];
  if (decisions.length > 0) {
    lines.push(`## 决策（${decisions.length}${surface.pagination?.decisions?.hasMore ? '+' : ''}）`, '');
    for (const decision of decisions) {
      lines.push(`- **[${oneLine(decision.status, 12)}]** ${oneLine(decision.subject, 60)} → ${oneLine(decision.decision, 120)}`
        + `${(decision.evidence ?? []).length > 0 ? `（证据 ${decision.evidence.length} 条）` : ''}`);
    }
    lines.push('');
  }
  const artifacts = surface.artifacts ?? [];
  if (artifacts.length > 0) {
    lines.push(`## 已观察文件（${artifacts.length}${surface.pagination?.artifacts?.hasMore ? '+' : ''}）`, '');
    for (const artifact of artifacts) {
      lines.push(`- \`${oneLine(artifact.path, 100)}\` ${oneLine(artifact.contentHash, 24)}`
        + `${artifact.summary ? ` — ${oneLine(artifact.summary, 80)}` : ''}`);
    }
    lines.push('');
  }
  const operations = surface.operations ?? [];
  if (operations.length > 0) {
    lines.push(`## 最近操作（${operations.length}${surface.pagination?.operations?.hasMore ? '+' : ''}）`, '');
    for (const operation of operations) {
      lines.push(`- \`${oneLine(operation.tool, 40)}\` ${oneLine(operation.target, 80)} → ${oneLine(operation.status, 12)}`
        + `${operation.stale ? ' **stale**' : ''} · ${oneLine(operation.actorId, 40)}`);
    }
    lines.push('');
  }
  const text = lines.join('\n').trimEnd();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}\n…（已截断）\n` : `${text}\n`;
}

/** Make a project id safe as one file name. */
export function mirrorFileName(projectId) {
  const cleaned = String(projectId ?? '').normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 80);
  return `${cleaned || 'default'}.md`;
}

/** Write the mirror atomically; a failure never breaks the state operation that produced it. */
export function writeMirror(rootPath, mirrorPath, text) {
  const target = isAbsolute(mirrorPath) ? mirrorPath : join(rootPath, mirrorPath);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temporary, text, { encoding: 'utf8' });
    renameSync(temporary, target);
    return target;
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    return undefined;
  }
}

/**
 * Track one restriction per off conversation.
 *
 * `restrict` is injected so the gate stays testable: the real implementation
 * calls `agent.ctx.tools.restrict({ deny })`, which masks the tools out of THAT
 * agent's catalog only. Idempotent per session, and `release` unwinds it.
 *
 * @param input - the enablement probe, the names to mask, and the restriction sink.
 * @returns `apply(agent)`, `release(sessionId)`, and `size()`.
 */
export function createAgentGate({ isEnabled, toolNames, restrict }) {
  const lifts = new Map();
  return {
    apply(agent) {
      const session = agent?.session;
      if (!session) return;
      if (isEnabled(agent)) {
        lifts.get(session.id)?.();
        lifts.delete(session.id);
        return;
      }
      if (lifts.has(session.id)) return;
      const lift = restrict(agent, toolNames);
      if (typeof lift === 'function') lifts.set(session.id, lift);
    },
    release(sessionId) {
      lifts.get(sessionId)?.();
      lifts.delete(sessionId);
    },
    size() {
      return lifts.size;
    },
  };
}

/** The discipline a shared-state conversation is held to, injected as a prompt section. */
export function buildPolicySection() {
  return [
    '## 共享状态纪律（工作区级，跨对话）',
    '',
    '本会话已开启共享状态。状态属于**工作区**，同一工作区的其他对话会读到它；不要把它当作本对话私有。',
    '',
    '- **一个往返做完一件事**：把「读 surface → 写 → 复核」放进同一次 `shared_state_apply`（ops 顺序执行、同一事务、一次 `expectedRevision` 校验）。每多一次工具调用就是多一次模型请求、多一次整段上下文重发——这是本插件唯一显著的成本。',
    '- 开始实现前先读状态：单独的 `shared_state_surface`，或把 `surface` 作为 `shared_state_apply` 的第一个 op；分页要继续时带上首页的 `revision` 作为 `expectedRevision`。',
    '- 有副作用的操作先用 `shared_state_record_operation` 记 `started`，完成后用同一 `operationId` 推进为 `succeeded`/`failed`；等价操作会被服务端去重，不要重复执行。',
    '- 改动文件后调用 `shared_state_observe_artifact` 记录路径与内容哈希；哈希变化会让旧操作标记为 `stale`。',
    '- 影响后续对话的决定调用 `shared_state_record_decision`（`accepted` 需要证据）。',
    '- 只有证据覆盖全部验收条件时才能调用 `shared_state_complete_task`。',
    '- 用户要求关闭时调用 `/shared off`。',
  ].join('\n');
}

/** Resolve one caller's workspace-scoped store and project id. */
export class SharedStateService {
  #router;
  #config;
  #enabled = new Map();

  /**
   * @param config - data root, default enablement, project id, spill threshold, mirror settings.
   */
  #projects = new Map();

  constructor({
    dataRoot, enabledByDefault = false, defaultOnPresets = [], projectId = null,
    spillBytes = DEFAULT_SPILL_BYTES, mirrorDir = DEFAULT_MIRROR_DIR,
    mirrorMaxChars = DEFAULT_MIRROR_MAX_CHARS,
  }) {
    this.#router = new WorkspaceStoreRouter({ dataRoot });
    this.#config = { enabledByDefault, defaultOnPresets, projectId, spillBytes, mirrorDir, mirrorMaxChars };
  }

  /**
   * Declare which project this conversation writes to. One workspace holds many
   * independent projects; this is the per-session default, and a tool call's own
   * `projectId` still overrides it.
   */
  setProject(sessionId, projectId) {
    if (sessionId === undefined || sessionId === null) return null;
    if (projectId === null || projectId === '') this.#projects.delete(sessionId);
    else this.#projects.set(sessionId, projectId);
    return this.projectOf({ sessionId }) ?? null;
  }

  /** Resolve a caller's project id WITHOUT opening the store: session > config > workspace name. */
  projectOf(caller) {
    return caller?.projectId ?? this.#projects.get(caller?.sessionId) ?? this.#config.projectId ?? null;
  }

  /** Release every open SQLite handle. */
  close() {
    this.#router.close();
  }

  /**
   * Whether this conversation may read or write shared state.
   *
   * A session naming one of `defaultOnPresets` starts enabled; `/shared on|off`
   * overrides either default for the rest of that session.
   *
   * @param caller - the calling session's identity.
   * @returns the effective switch.
   */
  isEnabled(caller) {
    const sessionId = caller?.sessionId;
    if (sessionId === undefined || sessionId === null) return false;
    const explicit = this.#enabled.get(sessionId);
    if (explicit !== undefined) return explicit;
    if (this.#config.enabledByDefault) return true;
    return this.#config.defaultOnPresets.includes(caller.agentPreset);
  }

  /** Set the per-session switch; returns the effective value. */
  setEnabled(sessionId, enabled) {
    this.#enabled.set(sessionId, enabled);
    return enabled;
  }

  #require(caller) {
    if (caller?.sessionId === undefined || caller.sessionId === null) {
      throw new StateError('SHARED_STATE_UNAVAILABLE', 'shared state requires a calling session');
    }
    if (!this.isEnabled(caller)) {
      throw new StateError('SHARED_STATE_DISABLED', 'shared state is off for this conversation; run /shared on');
    }
    return caller;
  }

  #open(caller) {
    this.#require(caller);
    if (typeof caller.cwd !== 'string' || caller.cwd.trim() === '') {
      throw new StateError('WORKSPACE_REQUIRED', 'the calling session has no workspace directory');
    }
    const { store, workspace } = this.#router.open(caller.cwd);
    const projectId = this.projectOf(caller) ?? workspace.name;
    return { store, workspace, projectId };
  }

  /** Derive the actor id recorded on every write: the session, not a model claim. */
  actorOf(caller) {
    return `dsh:${caller.sessionId}`;
  }

  /** Refresh one project's mirror from a surface read; never throws. */
  #refreshMirror(store, workspace, projectId) {
    if (this.#config.mirrorDir === null) return undefined;
    try {
      const surface = store.getSurface({ projectId, limit: 100, recentEventLimit: 1 });
      const text = buildMirror({
        projectId, workspace, surface, maxChars: this.#config.mirrorMaxChars,
      });
      return writeMirror(workspace.rootPath, join(this.#config.mirrorDir, mirrorFileName(projectId)), text);
    } catch {
      return undefined;
    }
  }

  /**
   * Read the bounded surface.
   * @returns the core surface plus workspace identity.
   */
  surface(caller, args = {}) {
    const { store, workspace, projectId } = this.#open(caller);
    const surface = store.getSurface({ ...args, projectId: args.projectId ?? projectId });
    const mirror = this.#refreshMirror(store, workspace, args.projectId ?? projectId);
    return { workspace: workspaceId(workspace), surface, ...mirror === undefined ? {} : { mirror } };
  }

  /** Create a project task. The core rejects an existing taskId with TASK_EXISTS. */
  createTask(caller, args) {
    const { store, workspace, projectId } = this.#open(caller);
    const result = store.createTask({
      ...args, projectId: args.projectId ?? projectId, actorId: this.actorOf(caller),
    });
    this.#refreshMirror(store, workspace, args.projectId ?? projectId);
    return { workspace: workspaceId(workspace), ...result };
  }

  /** Claim a task for this conversation's actor. */
  claimTask(caller, args) {
    const { store, workspace, projectId } = this.#open(caller);
    const result = store.claimTask({
      ...args, projectId: args.projectId ?? projectId, agentId: this.actorOf(caller),
    });
    this.#refreshMirror(store, workspace, args.projectId ?? projectId);
    return { workspace: workspaceId(workspace), ...result };
  }

  /** Release a claimed task, optionally forcing a stale owner's claim. */
  releaseTask(caller, args) {
    const { store, workspace, projectId } = this.#open(caller);
    const result = store.releaseTask({
      ...args, projectId: args.projectId ?? projectId, actorId: this.actorOf(caller),
    });
    this.#refreshMirror(store, workspace, args.projectId ?? projectId);
    return { workspace: workspaceId(workspace), ...result };
  }

  /** Record an observed file version. */
  observeArtifact(caller, args) {
    const { store, workspace, projectId } = this.#open(caller);
    const result = store.observeArtifact({
      ...args, projectId: args.projectId ?? projectId, actorId: this.actorOf(caller),
    });
    this.#refreshMirror(store, workspace, args.projectId ?? projectId);
    return { workspace: workspaceId(workspace), ...result };
  }

  /**
   * Record an operation, spilling oversized results.
   *
   * @param spill - optional async `(content, label) => {locator, bytes}` backend.
   * @returns the stored operation; `result` is replaced by a locator when spilled.
   */
  async recordOperation(caller, args, spill = null) {
    const { store, workspace, projectId } = this.#open(caller);
    const result = await this.#spillResult(args.result ?? null, spill);
    const stored = store.recordOperation({
      ...args, result, projectId: args.projectId ?? projectId, actorId: this.actorOf(caller),
    });
    this.#refreshMirror(store, workspace, args.projectId ?? projectId);
    return { workspace: workspaceId(workspace), ...stored };
  }

  /** Spill an oversized operation result to the host, when a backend exists. */
  async #spillResult(result, spill) {
    if (result === null || spill === null) return result;
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) <= this.#config.spillBytes) return result;
    const saved = await spill(encoded, 'operation-result.json');
    return {
      spilled: true,
      resultRef: saved?.locator ?? null,
      resultBytes: Buffer.byteLength(encoded),
      preview: encoded.slice(0, 2000),
      retrievalHint: saved?.retrievalHint ?? 'read the resultRef path',
    };
  }

  /**
   * Apply several operations in ONE tool call — the point is round trips, not SQL.
   *
   * Every separate tool call is another model request that re-sends the whole
   * conversation, and the Codex 5-hour window is charged on those prompt tokens.
   * A registration expressed as one `shared_state_apply` costs one request
   * instead of one per operation, while every operation still runs the core's
   * own code path: same event chain, same revision CAS, same dedup, same
   * evidence rules, all inside one transaction.
   *
   * @param spill - optional async backend; oversized operation results spill
   *   BEFORE the transaction opens, since spilling is not transactional.
   */
  async applyBatch(caller, args, spill = null) {
    const { store, workspace, projectId } = this.#open(caller);
    const actorId = this.actorOf(caller);
    const target = args.projectId ?? projectId;
    // Validate before mapping: this adapter touches `ops` before the core does,
    // and a malformed entry must surface as INVALID_INPUT, not as a TypeError.
    if (!Array.isArray(args.ops)) {
      throw new StateError('INVALID_INPUT', 'ops must be an array of operations');
    }
    const ops = [];
    for (const entry of args.ops) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new StateError('INVALID_INPUT', 'every op must be an object carrying an "op" name');
      }
      const { op, ...rest } = entry;
      const scoped = { ...rest };
      if (op === 'recordOperation') scoped.result = await this.#spillResult(rest.result ?? null, spill);
      // Identity is the SESSION, never the model: an actorId/agentId inside the op
      // is DISCARDED, exactly as the standalone tools discard it (they overwrite
      // with `this.actorOf(caller)`). Letting an op win here would let one
      // conversation claim tasks and attribute decisions as another.
      if (WRITE_OPS.has(op)) scoped.actorId = actorId;
      if (op === 'claimTask') scoped.agentId = actorId;
      ops.push({ op, ...scoped });
    }
    const result = store.applyBatch({
      projectId: target,
      expectedRevision: args.expectedRevision ?? null,
      ops,
      continueOnError: Boolean(args.continueOnError),
    });
    const mirror = this.#refreshMirror(store, workspace, target);
    // Keep a batched read shaped exactly like the standalone `shared_state_surface`
    // — same `{workspace, surface}` wrapper and the same `mirror` path.
    const results = result.results.map((entry) => (entry.ok && entry.op === 'surface'
      ? {
        ...entry,
        result: {
          workspace: workspaceId(workspace), surface: entry.result,
          ...mirror === undefined ? {} : { mirror },
        },
      }
      : entry));
    return { workspace: workspaceId(workspace), ...result, results };
  }

  /** Record a project decision. */
  recordDecision(caller, args) {
    const { store, workspace, projectId } = this.#open(caller);
    const result = store.recordDecision({
      ...args, projectId: args.projectId ?? projectId, actorId: this.actorOf(caller),
    });
    this.#refreshMirror(store, workspace, args.projectId ?? projectId);
    return { workspace: workspaceId(workspace), ...result };
  }

  /** Complete a task once evidence covers every acceptance criterion. */
  completeTask(caller, args) {
    const { store, workspace, projectId } = this.#open(caller);
    const result = store.completeTask({
      ...args, projectId: args.projectId ?? projectId, actorId: this.actorOf(caller),
    });
    this.#refreshMirror(store, workspace, args.projectId ?? projectId);
    return { workspace: workspaceId(workspace), ...result };
  }

  /** Cheap identity/health probe, including the mirror path and record counts. */
  status(caller) {
    if (!this.isEnabled(caller)) {
      return { enabled: false, workspace: null, projectId: null, declaredProject: null, revision: 0, counts: null, mirror: null };
    }
    const { store, workspace, projectId } = this.#open(caller);
    const surface = store.getSurface({ projectId, limit: 1, recentEventLimit: 1 });
    const mirror = this.#refreshMirror(store, workspace, projectId);
    return {
      enabled: true,
      workspace: { ...workspaceId(workspace), databasePath: workspace.databasePath },
      projectId,
      declaredProject: this.projectOf(caller),
      revision: surface.revision,
      counts: {
        tasks: surface.tasks.length, artifacts: surface.artifacts.length,
        operations: surface.operations.length, decisions: surface.decisions.length,
      },
      mirror: mirror ?? null,
    };
  }
}

function workspaceId(workspace) {
  return { workspaceId: workspace.workspaceId, name: workspace.name, rootPath: workspace.rootPath };
}
