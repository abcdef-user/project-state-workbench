/**
 * Cross-conversation shared state for DeepSeek Harness.
 *
 * The workspace is the sharing unit and the session is the caller: this plugin
 * never asks the model for a workspace path, a session token, or an actor id.
 * It registers ten tools over the SQLite core shared with the Codex
 * `project-shared-state` plugin, injects a bounded state digest once per
 * session, and holds each conversation to the shared-state discipline.
 *
 * Tool definitions carry raw JSON Schema rather than `defineTool` output, so the
 * plugin's only runtime dependency is the core package — the Harness supplies
 * the registries through `ctx`.
 *
 * @module dsh-shared-state
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StateError } from 'project-shared-state-core/store';
import {
  BATCH_MAX_OPS, BATCH_OPS, buildDigest, buildPolicySection, createAgentGate, DIGEST_MAX_CHARS,
  DEFAULT_MIRROR_MAX_CHARS, DEFAULT_MIRROR_DIR, DEFAULT_SPILL_BYTES, SharedStateService,
} from './handlers.js';

export {
  buildDigest, buildMirror, buildPolicySection, createAgentGate, DIGEST_MAX_CHARS,
  DEFAULT_MIRROR_DIR, DEFAULT_SPILL_BYTES, mirrorFileName, SharedStateService, writeMirror,
} from './handlers.js';

export const name = 'shared-state';
export const inject = ['tools', 'systemPrompt'];

const CONFIG_DEFAULTS = {
  /**
   * This harness's PARTITION root — deliberately NOT the Codex plugin's
   * PROJECT_STATE_ROOT. Two adapters share state only when they point at the
   * same root; this deployment splits them (Codex = research, DSH = review) so
   * neither harness can bump the other's project revisions. See dsh/README.md.
   */
  dataRoot: join(homedir(), '.local', 'share', 'project-state-workbench', 'dsh', 'workspaces'),
  /** Whether EVERY session may use shared state without `/shared on`. */
  enabledByDefault: false,
  /** Preset ids whose sessions start enabled. Naming one IS the per-conversation opt-in. */
  defaultOnPresets: ['shared-state'],
  /** Fixed project id; defaults to the workspace directory name. */
  projectId: null,
  /** Injected digest ceiling in code units. */
  digestMaxChars: DIGEST_MAX_CHARS,
  /** Results larger than this many bytes spill to `ctx.spillStore`. */
  spillBytes: DEFAULT_SPILL_BYTES,
  /** Workspace-relative directory for the read-only mirrors, one file per project; `null` disables. */
  mirrorDir: DEFAULT_MIRROR_DIR,
  /** Mirror file ceiling in code units. */
  mirrorMaxChars: DEFAULT_MIRROR_MAX_CHARS,
  /**
   * Whether the plugin hides its tools per agent while that conversation is off.
   * Requires a host-plane mount with the `agents` registry; a disabled agent then
   * pays no tool-catalog cost at all.
   */
  gateByAgent: true,
};

/** Minimal Standard Schema: cordis only needs `~standard.validate`. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-shared-state',
    validate(value) {
      const issues = [];
      const config = { ...CONFIG_DEFAULTS };
      if (value !== undefined && value !== null) {
        if (typeof value !== 'object' || Array.isArray(value)) {
          issues.push({ message: 'config must be an object' });
        } else {
          for (const [key, entry] of Object.entries(value)) {
            if (!Object.hasOwn(CONFIG_DEFAULTS, key)) {
              issues.push({ message: `unknown config key: ${key}`, path: [key] });
              continue;
            }
            const fallback = CONFIG_DEFAULTS[key];
            const valid = fallback === null
              ? typeof entry === 'string' || entry === null
              : Array.isArray(fallback)
                ? Array.isArray(entry) && entry.every((item) => typeof item === 'string')
                : typeof entry === typeof fallback;
            if (!valid) {
              issues.push({ message: `${key} must be ${fallback === null ? 'a string or null' : Array.isArray(fallback) ? 'an array of strings' : `a ${typeof fallback}`}`, path: [key] });
              continue;
            }
            config[key] = entry;
          }
        }
      }
      return issues.length > 0 ? { issues } : { value: config };
    },
  },
};

/** Canonical output declaration: annotation-only schema, JSON text rendering. */
const OUTPUT = {
  schema: {},
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

const S = (description) => ({ type: 'string', description });
const N = (description) => ({ type: 'number', description });
const B = (description) => ({ type: 'boolean', description });
/** Any lossless JSON value (annotation-only schema). */
const ANY = (description) => ({ description });
const ARR = (description, items = {}) => ({ type: 'array', items, description });

const PROJECT = S('Project id inside this workspace. Defaults to the workspace directory name.');
const TASK = S('Task id.');
const REVISION = N('Project revision read from the last surface; writes fail with REVISION_CONFLICT when it moved.');
const TASK_VERSION = N('Task version read from the last surface.');

/** Every tool this plugin registers, as one declarative table. */
const TOOLS = [
  {
    name: 'shared_state_surface',
    description: 'Read the bounded shared-state surface for this workspace: tasks, observed artifacts, operations, decisions, and recent events. Always read it before starting work another conversation may have begun. Follow pagination with the offsets returned per collection and pass the first page revision as expectedRevision.',
    properties: {
      projectId: PROJECT, taskId: TASK,
      limit: N('Rows per collection, 1-100 (default 20).'),
      recentEventLimit: N('Recent events, 1-200 (default 30).'),
      offsets: ANY('Per-collection offsets from the previous page.'),
      expectedRevision: REVISION,
    },
    run: (service, caller, args) => service.surface(caller, args),
  },
  {
    name: 'shared_state_apply',
    description: 'PREFER THIS: apply several shared-state operations in ONE tool call, in order. Reads (`surface`, `getOperation`) and writes may mix, and later operations see earlier ones. Every separate tool call is another model request that re-sends the whole conversation, so a nine-operation registration split across nine calls costs roughly nine times one batched call. The batch is one transaction with one `expectedRevision` check; a failing operation rolls it back unless `continueOnError` is set. Read the state, register the work, and verify the result in a single round trip.',
    properties: {
      projectId: PROJECT,
      expectedRevision: REVISION,
      continueOnError: B('Report a failing operation in place and keep going, instead of rolling the whole batch back.'),
      ops: {
        type: 'array',
        minItems: 1,
        maxItems: BATCH_MAX_OPS,
        description: `Ordered operations, each \`{op, ...arguments of that operation}\`. Ops: ${BATCH_OPS.join(', ')}.`,
        items: {
          type: 'object',
          required: ['op'],
          properties: { op: { type: 'string', enum: [...BATCH_OPS], description: 'Operation name.' } },
          additionalProperties: true,
        },
      },
    },
    required: ['ops'],
    run: (service, caller, args, ctx, exec) => service.applyBatch(caller, args, spillBackend(ctx, exec)),
  },
  {
    name: 'shared_state_create_task',
    description: 'Create or refresh a task in shared state with explicit acceptance criteria, so another conversation can continue it.',
    properties: {
      projectId: PROJECT, taskId: TASK,
      goal: S('What the task must achieve, one line.'),
      acceptanceCriteria: ARR('Conditions that must hold before completion.', { type: 'string' }),
      expectedRevision: REVISION,
    },
    required: ['taskId', 'goal'],
    run: (service, caller, args) => service.createTask(caller, args),
  },
  {
    name: 'shared_state_claim_task',
    description: 'Claim a task for this conversation. Conflicting claims are rejected; release it when you stop working.',
    properties: {
      projectId: PROJECT, taskId: TASK,
      expectedRevision: REVISION, expectedTaskVersion: TASK_VERSION,
    },
    required: ['taskId'],
    run: (service, caller, args) => service.claimTask(caller, args),
  },
  {
    name: 'shared_state_release_task',
    description: "Release a claimed task with a reason. Recovering another actor's abandoned claim needs force plus the observed expectedTaskVersion.",
    properties: {
      projectId: PROJECT, taskId: TASK,
      reason: S('Why the task is being released.'),
      force: B('Release a claim held by another actor.'),
      expectedRevision: REVISION, expectedTaskVersion: TASK_VERSION,
    },
    required: ['taskId', 'reason'],
    run: (service, caller, args) => service.releaseTask(caller, args),
  },
  {
    name: 'shared_state_observe_artifact',
    description: 'Record an observed file or artifact version with its content hash. Observing a changed hash marks operations against the old version stale.',
    properties: {
      projectId: PROJECT, taskId: TASK,
      path: S('Workspace-relative or absolute path.'),
      contentHash: S('Hash of the observed content (e.g. sha256).'),
      summary: S('One line describing the change.'),
      expectedRevision: REVISION,
    },
    required: ['path', 'contentHash'],
    run: (service, caller, args) => service.observeArtifact(caller, args),
  },
  {
    name: 'shared_state_record_operation',
    description: 'Record a side-effecting operation. Record started first, then advance the SAME operationId with the same tool/target/args to succeeded or failed. Equivalent successful operations are reused instead of rerun; oversized results are spilled to a file whose path is returned as resultRef.',
    properties: {
      projectId: PROJECT, taskId: TASK,
      tool: S('Tool or command name.'),
      target: S('What the operation acts on (usually a path).'),
      status: { type: 'string', enum: ['started', 'succeeded', 'failed'], description: 'Lifecycle state.' },
      args: ANY('Canonical arguments; hashed for equivalence. Object keys are sorted.'),
      argsHash: S('Precomputed hash; must match args when both are given.'),
      targetVersion: S('Content hash the operation read; enables staleness detection.'),
      result: ANY('Result payload. Keep it a summary or file reference; large payloads spill.'),
      operationId: S('Returned by started; required to advance that operation.'),
      idempotencyKey: S('Override the derived dedup key.'),
      expectedRevision: REVISION,
    },
    required: ['tool', 'target', 'status'],
    run: (service, caller, args, ctx, exec) => service.recordOperation(caller, args, spillBackend(ctx, exec)),
  },
  {
    name: 'shared_state_record_decision',
    description: 'Record a decision other conversations must respect. Accepting a decision requires evidence.',
    properties: {
      projectId: PROJECT, taskId: TASK,
      subject: S('What the decision is about.'),
      decision: S('The decision, one line.'),
      evidence: ARR('Proof supporting the decision.'),
      status: { type: 'string', enum: ['proposed', 'accepted', 'invalidated'], description: 'Defaults to proposed.' },
      decisionId: S('Reuse to update an existing decision.'),
      expectedRevision: REVISION,
    },
    required: ['subject', 'decision'],
    run: (service, caller, args) => service.recordDecision(caller, args),
  },
  {
    name: 'shared_state_complete_task',
    description: 'Complete a task. Rejected unless the evidence covers every acceptance criterion.',
    properties: {
      projectId: PROJECT, taskId: TASK,
      evidence: ARR('One entry per acceptance criterion: the criterion string, or {criterion, proof}.'),
      expectedRevision: REVISION, expectedTaskVersion: TASK_VERSION,
    },
    required: ['taskId', 'evidence'],
    run: (service, caller, args) => service.completeTask(caller, args),
  },
  {
    name: 'shared_state_status',
    description: 'Report whether shared state is on for this conversation, which workspace store and project it uses, and the current revision and record counts. Pass projectId to inspect another project in the same workspace.',
    properties: { projectId: PROJECT },
    run: (service, caller, args) => service.status({ ...caller, projectId: args.projectId }),
  },
];

/** The model-facing names this plugin can mask per agent. */
const TOOL_NAMES = TOOLS.map((tool) => tool.name);

/** Turn a core error into a model-readable `CODE: message` failure. */
async function guarded(run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StateError) throw new Error(`${error.code}: ${error.message}`);
    throw error;
  }
}

/**
 * Register the shared-state tools, prompt contributions, and `/shared` command.
 *
 * @param ctx - registrant context carrying the tool, prompt, and command registries.
 * @param config - validated {@link Config} value.
 */
export function apply(ctx, config) {
  const service = new SharedStateService({
    dataRoot: config.dataRoot,
    enabledByDefault: config.enabledByDefault,
    defaultOnPresets: config.defaultOnPresets,
    projectId: config.projectId,
    spillBytes: config.spillBytes,
    mirrorDir: config.mirrorDir,
    mirrorMaxChars: config.mirrorMaxChars,
  });
  ctx.effect(() => () => service.close(), 'shared-state: SQLite handle lifetime');

  const callerOfAgent = (agent) => {
    const session = agent?.session;
    return { sessionId: session?.id, cwd: session?.header?.cwd, agentPreset: session?.header?.agentPreset };
  };
  const callerOf = (exec) => callerOfAgent(exec?.agent);

  // Per-agent gating: an off conversation does not merely get refused — the
  // plugin's tools are masked out of ITS catalog, so it pays no schema tokens. Verified
  // against the real registry: `restrict` on one agent scope leaves every other
  // agent and the global view untouched.
  const gate = createAgentGate({
    isEnabled: (agent) => service.isEnabled(callerOfAgent(agent)),
    toolNames: TOOL_NAMES,
    restrict: (agent, names) => {
      let lift;
      agent.ctx?.inject?.(['tools'], (scoped) => { lift = scoped.tools.restrict({ deny: names }); });
      return () => lift?.();
    },
  });
  const gateAgent = (agent) => { if (config.gateByAgent) gate.apply(agent); };
  if (config.gateByAgent) {
    ctx.inject(['agents'], (agentsCtx) => {
      for (const agent of agentsCtx.agents.list()) gate.apply(agent);
      agentsCtx.on('agent/created', ({ agent }) => gate.apply(agent));
      agentsCtx.on('agent/disposed', ({ agent }) => gate.release(agent?.session?.id));
    });
  }

  for (const tool of TOOLS) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.properties,
        ...tool.required === undefined ? {} : { required: tool.required },
      },
      output: OUTPUT,
      execute: (args, exec) => guarded(() => tool.run(service, callerOf(exec), args, ctx, exec)),
    });
  }

  ctx.systemPrompt.section({
    name: 'shared-state:policy',
    order: 620,
    text: (context) => (service.isEnabled(callerOfAgent(context?.agent)) ? buildPolicySection() : ''),
  });

  const digests = new Map();
  ctx.systemPrompt.context({
    name: 'shared-state:digest',
    order: 620,
    text: (context) => {
      const session = context?.agent?.session;
      if (!session || !service.isEnabled(callerOfAgent(context?.agent))) return '';
      const cached = digests.get(session.id);
      if (cached !== undefined) return cached;
      let text = '';
      try {
        const { surface, workspace } = service.surface({ sessionId: session.id, cwd: session.header.cwd });
        text = buildDigest({
          projectId: surface.projectId, workspaceName: workspace.name, surface,
          maxChars: config.digestMaxChars,
        });
      } catch {
        text = '';
      }
      digests.set(session.id, text);
      return text;
    },
  });

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'shared',
      description: "Turn cross-conversation shared state on or off, or declare this conversation's project",
      input: { hint: '[on|off|status|project [name]]' },
      handler: ({ agent, rawInput }) => {
        const session = agent?.session;
        if (!session) return { kind: 'error', text: '/shared requires a session.' };
        const input = rawInput.trim();
        const [verb, ...rest] = input.split(/\s+/);
        const action = (verb || 'status').toLowerCase();

        // `/shared project [name]` declares this conversation's project. One
        // workspace holds many independent projects; the declaration only sets
        // the default, and a tool call's own projectId still overrides it.
        if (action === 'project') {
          const name = rest.join(' ').trim();
          if (name === '') {
            const caller = callerOfAgent(agent);
            const current = service.projectOf(caller);
            const status = service.status(caller);
            return { kind: 'success', text: current === null
              ? `本会话未声明项目；默认落到工作区目录名（当前为 ${status.projectId ?? '未知'}）。`
              : `本会话项目：${current}（库内 projectId=${status.projectId ?? '未知'}）。` };
          }
          const resolved = service.setProject(session.id, name);
          digests.delete(session.id);
          return { kind: 'success', text: `本会话项目已设为 ${resolved}。之后的读写默认落在它；工具参数仍可临时覆盖。` };
        }

        if (action === 'on') {
          service.setEnabled(session.id, true);
          digests.delete(session.id);
          gateAgent(agent);
          return { kind: 'success', text: '共享状态已开启（工具已加入本会话目录）。开工前先读 shared_state_surface；读写尽量合并进同一次 shared_state_apply。' };
        }
        if (action === 'off') {
          service.setEnabled(session.id, false);
          gateAgent(agent);
          return { kind: 'success', text: '共享状态已关闭；本会话不再读写工作区状态，工具也已从目录移除。' };
        }
        if (action === 'status') {
          const status = service.status({ sessionId: session.id, cwd: session.header.cwd });
          return { kind: 'success', text: JSON.stringify(status, null, 2) };
        }
        return { kind: 'error', text: 'Usage: /shared [on|off|status|project [name]]' };
      },
    });
  });
}

/** Build the spill callback handed to oversized operation results, when a backend exists. */
function spillBackend(ctx, exec) {
  const store = ctx.get('spillStore');
  if (!store || typeof store.saveText !== 'function') return null;
  const sessionId = exec?.agent?.session?.id;
  if (sessionId === undefined) return null;
  return async (content, label) => store.saveText({
    owner: { sessionId },
    source: { toolName: 'shared_state_record_operation', callId: exec.callId, label },
    suggestedName: label,
    content,
  });
}
