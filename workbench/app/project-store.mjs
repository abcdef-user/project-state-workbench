import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const RULE_ID = 'D-PROJECT-REGISTRATION-RULES';
const SETTINGS_ID = 'D-PROJECT-SETTINGS';
const ACTOR = 'user';
const parse = (s, fallback = null) => { try { return JSON.parse(s); } catch { return fallback; } };
const clock = () => new Date().toISOString();
const cell = value => String(value ?? '').replaceAll('|', '／').replace(/\r?\n/g, ' ');
const statusName = { pending: '待办', running: '进行中', completed: '已完成', proposed: '待讨论', accepted: '已确认', invalidated: '已撤销' };
const eventName = { task_created: '新增任务', task_claimed: '开始任务', task_released: '退回待办', task_completed: '完成任务', task_updated: '修改任务', task_reopened: '重新打开', decision_recorded: '新增决定', decision_updated: '修改决定', artifact_observed: '登记文件', artifact_changed: '文件变化', operation_succeeded: '操作成功', operation_failed: '操作失败', operation_started: '开始操作' };

function cleanText(value, label, max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw problem('INVALID_INPUT', `${label}不能为空，且需控制在${max}字以内。`);
  return value.trim();
}
function cleanCriteria(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw problem('INVALID_INPUT', '请填写1至50条完成条件。');
  const result = value.map(v => cleanText(v, '完成条件', 4000));
  if (new Set(result).size !== result.length) throw problem('INVALID_INPUT', '完成条件不能重复。');
  return result;
}
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function atomicText(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
}

export function safeName(v) { return String(v).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0,70) || 'project'; }
export function defaultSettings(entry) { return { name:entry.name || entry.projectId, description:'', goal:'', taskPrefix:'TASK-', phases:[], administrativeTaskIds:[], ...(entry.initialSettings || {}) }; }
function initialRules(entry) { return entry.initialRules || '- 目标与范围通过讨论明确，建议和已确认决定分开记录。\n- 任务写清完成条件，完成须有实际产物和核验依据。\n- 计划与成果分别记录，不编造进度。\n- 变更保留原因、前后内容与历史。\n- 未知与冲突明确标记，按证据修正。'; }
function cleanSettings(raw, taskIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw problem('INVALID_INPUT','项目设置格式不正确。');
  const name=cleanText(raw.name,'项目名称',120), description=String(raw.description||'').trim(), goal=String(raw.goal||'').trim(), taskPrefix=String(raw.taskPrefix||'TASK-').trim();
  if(description.length>6000 || goal.length>12000) throw problem('INVALID_INPUT','项目说明过长。');
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,24}$/.test(taskPrefix)) throw problem('INVALID_INPUT','任务前缀请使用英文字母、数字、横线或下划线，并以字母开始。');
  if(!Array.isArray(raw.phases)||raw.phases.length>40) throw problem('INVALID_INPUT','阶段数量应在0至40之间。');
  const ids=new Set(), assigned=new Set();
  const phases=raw.phases.map(p=>{
    const id=cleanText(p.id||'P-'+randomUUID().slice(0,8),'阶段编号',80), name=cleanText(p.name,'阶段名称',100), text=String(p.text||'').trim();
    if(ids.has(id)||text.length>2000||!Array.isArray(p.tasks)) throw problem('INVALID_INPUT','阶段信息无效或编号重复。');
    ids.add(id); const tasks=p.tasks.map(String);
    for(const t of tasks){if(!taskIds.has(t)) throw problem('INVALID_INPUT','阶段中包含不存在的任务，请刷新。');if(assigned.has(t)) throw problem('INVALID_INPUT','同一任务只能归属一个阶段。');assigned.add(t);}
    return {id,name,text,tasks};
  });
  const administrativeTaskIds=Array.isArray(raw.administrativeTaskIds)?[...new Set(raw.administrativeTaskIds.map(String))]:[];
  if(administrativeTaskIds.some(id=>!taskIds.has(id))) throw problem('INVALID_INPUT','辅助任务中包含不存在的任务。');
  return {name,description,goal,taskPrefix,phases,administrativeTaskIds};
}

export function createProjectContext(store, entry) {
  const db = store.db, projectId = entry.projectId;
  const outputRoot = entry.outputRoot || join(entry.workspaceRoot, '项目状态', safeName(projectId));
  const backups = join(outputRoot, '状态备份');
  let exportWarning = null, exportedRevision = -1;
  function state() {
    db.exec('BEGIN DEFERRED');
    try {
      const project = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId);
      const tasks = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, task_id').all(projectId).map(t => ({
        taskId: t.task_id, goal: t.goal, acceptanceCriteria: parse(t.acceptance_criteria_json, []), status: t.status,
        ownerAgent: t.owner_agent, version: t.version, completionEvidence: parse(t.completion_evidence_json, []), createdAt: t.created_at, updatedAt: t.updated_at,
      }));
      const decisions = db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY revision').all(projectId).map(d => ({
        decisionId: d.decision_id, subject: d.subject, decision: d.decision, evidence: parse(d.evidence_json, []), status: d.status,
        actorId: d.actor_id, revision: d.revision, createdAt: d.created_at, updatedAt: d.updated_at,
      }));
      const events = db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY project_revision DESC').all(projectId).map(e => ({
        eventId: e.event_id, taskId: e.task_id, actorId: e.actor_id, type: e.event_type, objectType: e.object_type,
        objectId: e.object_id, payload: parse(e.payload_json, {}), revision: e.project_revision, createdAt: e.created_at,
      }));
      const artifacts = db.prepare('SELECT * FROM artifacts WHERE project_id = ?').all(projectId);
      const operations = db.prepare('SELECT * FROM operations WHERE project_id = ? ORDER BY revision DESC').all(projectId).map(o => ({
        operationId: o.operation_id, taskId: o.task_id, tool: o.tool_name, target: o.target, status: o.status,
        result: parse(o.result_json), revision: o.revision, createdAt: o.created_at,
      }));
      const settingsValue=parse(decisions.find(d=>d.decisionId===SETTINGS_ID)?.decision,null);
      const settings=settingsValue&&typeof settingsValue==='object'&&!Array.isArray(settingsValue)?{...defaultSettings(entry),...settingsValue}:defaultSettings(entry);
      const ruleDecisions=decisions.filter(d=>d.decisionId.endsWith('REGISTRATION-RULES'));
      const rule=ruleDecisions.find(d=>d.decisionId===RULE_ID)||ruleDecisions.at(-1);
      const internalDecisionIds=[SETTINGS_ID,RULE_ID,...ruleDecisions.map(d=>d.decisionId)];
      const result = { projectKey:entry.key, project:{key:entry.key,name:settings.name,description:settings.description,goal:settings.goal,projectId,workspaceRoot:entry.workspaceRoot}, settings,phases:settings.phases,internalDecisionIds,projectId, workspaceRoot: entry.workspaceRoot, revision: project.revision, updatedAt: project.updated_at,
        readAt: clock(), tasks, decisions, events, artifacts, operations, rules: rule?.decision ?? initialRules(entry),
        exportWarning, canEdit: true, baseUrl: null };
      result.tasks=tasks.map(t=>({...t,isAdministrative:settings.administrativeTaskIds.includes(t.taskId)}));
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function exportState(value) {
    const data = { ...value, canEdit: false, exportWarning: null };
    atomicText(join(outputRoot, '当前状态.json'), JSON.stringify(data, null, 2) + '\n');
    if (entry.snapshotPath) atomicText(entry.snapshotPath, 'window.PROJECT_SNAPSHOT = ' + JSON.stringify(data).replaceAll('<', '\\u003c') + ';\n');
    let md = `# 当前项目状态\n\n项目：${projectId}。版本：${value.revision}。导出时间：${value.readAt}（UTC）。\n\n此文件由项目看板从共享数据库生成；修改请使用看板，避免下次导出覆盖。早期方案以历史身份保留。\n\n## 任务\n\n| ID | 状态 | 承接者 | 目标 |\n|---|---|---|---|\n`;
    for (const t of value.tasks) md += `| ${cell(t.taskId)} | ${statusName[t.status] ?? t.status} | ${cell(t.ownerAgent || '未领取')} | ${cell(t.goal)} |\n`;
    md += '\n## 任务完成条件\n';
    for (const t of value.tasks) {
      md += `\n### ${t.taskId}\n\n${t.goal}\n\n`;
      for (const c of t.acceptanceCriteria) md += '- ' + c + '\n';
      if (t.completionEvidence.length) md += '\n完成证据：\n\n```json\n' + JSON.stringify(t.completionEvidence, null, 2) + '\n```\n';
    }
    md += '\n## 决定\n';
    for (const d of value.decisions) md += `\n### ${d.subject}\n\n状态：${statusName[d.status] ?? d.status}；ID：${d.decisionId}。\n\n${d.decision}\n`;
    md += '\n## 历史变更\n\n| 版本 | 时间（UTC） | 事件 | 对象 | 操作者 |\n|---|---|---|---|---|\n';
    for (const e of value.events) md += `| ${e.revision} | ${e.createdAt} | ${eventName[e.type] ?? e.type} | ${cell(e.objectId)} | ${cell(e.actorId)} |\n`;
    md += '\n完整事件载荷与操作结果保存在同目录“当前状态.json”。\n';
    atomicText(join(outputRoot, '当前状态.md'), md);
    atomicText(join(outputRoot, '项目登记约定.md'), '# 项目登记约定\n\n由项目看板导出。修改请在看板“登记原则”页保存。\n\n' + value.rules + '\n');
    atomicText(join(outputRoot, '项目设置.json'), JSON.stringify(value.settings,null,2)+'\n');
    exportedRevision = value.revision;
    exportWarning = null;
  }
  function sync() {
    const value = state();
    if (exportedRevision !== value.revision || exportWarning) {
      try { exportState(value); } catch (error) { exportWarning = '共享状态已保存，但本地文档导出失败：' + error.message; }
    }
    return { ...value, exportWarning };
  }
  function backup() {
    mkdirSync(backups, { recursive: true });
    const name = clock().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6) + '.db';
    db.prepare('VACUUM INTO ?').run(join(backups, name));
  }
  function taskRow(id) {
    const row = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND task_id = ?').get(projectId, id);
    if (!row) throw problem('TASK_NOT_FOUND', '此任务不存在，请刷新。');
    return row;
  }
  function ownTask(id, version) {
    const row = taskRow(id);
    if (row.version !== version) throw problem('TASK_VERSION_CONFLICT', '这项任务已被其他操作修改，请刷新后核对。');
    if (row.owner_agent && row.owner_agent !== ACTOR) throw problem('TASK_OWNED_BY_OTHER', '此任务由其他成员承接。请先用“收回任务”说明原因。');
    return row;
  }
  function customTaskChange(body, reopen = false) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const project = db.prepare('SELECT revision FROM projects WHERE project_id = ?').get(projectId);
      if (project.revision !== body.expectedRevision) throw problem('REVISION_CONFLICT', '项目有新修改，请刷新后再保存。当前输入仍保留在窗口中。');
      const row = reopen ? taskRow(body.taskId) : ownTask(body.taskId, body.expectedTaskVersion);
      if (reopen && row.version !== body.expectedTaskVersion) throw problem('TASK_VERSION_CONFLICT', '任务有新修改，请刷新。');
      if (reopen && row.status !== 'completed') throw problem('INVALID_STATE', '只有已完成的任务需要重新打开。');
      if (!reopen && row.status === 'completed') throw problem('TASK_COMPLETED', '修改完成任务前，请先重新打开并说明原因。');
      const reason = reopen ? cleanText(body.reason, '重新打开的原因', 3000) : String(body.reason ?? '').trim();
      const before = { goal: row.goal, acceptanceCriteria: parse(row.acceptance_criteria_json, []), status: row.status, ownerAgent: row.owner_agent, completionEvidence: parse(row.completion_evidence_json, []) };
      const after = reopen ? { ...before, status: 'pending', ownerAgent: null, completionEvidence: [] }
        : { ...before, goal: cleanText(body.goal, '任务说明', 6000), acceptanceCriteria: cleanCriteria(body.acceptanceCriteria) };
      if (!reopen && before.goal === after.goal && JSON.stringify(before.acceptanceCriteria) === JSON.stringify(after.acceptanceCriteria)) {
        db.exec('ROLLBACK'); return { unchanged: true };
      }
      const revision = project.revision + 1, timestamp = clock();
      db.prepare('UPDATE projects SET revision = ?, updated_at = ? WHERE project_id = ?').run(revision, timestamp, projectId);
      db.prepare('UPDATE tasks SET goal=?, acceptance_criteria_json=?, status=?, owner_agent=?, completion_evidence_json=?, version=version+1, updated_at=? WHERE project_id=? AND task_id=?')
        .run(after.goal, JSON.stringify(after.acceptanceCriteria), after.status, after.ownerAgent, JSON.stringify(after.completionEvidence), timestamp, projectId, body.taskId);
      db.prepare('INSERT INTO events(event_id,project_id,task_id,actor_id,event_type,object_type,object_id,payload_json,idempotency_key,project_revision,caused_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), projectId, body.taskId, ACTOR, reopen ? 'task_reopened' : 'task_updated', 'task', body.taskId, JSON.stringify({ before, after, reason, interface: 'project-workbench' }), null, revision, null, timestamp);
      db.exec('COMMIT');
      return { revision };
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  function mutate(body) {
    if (!Number.isInteger(body.expectedRevision)) throw problem('INVALID_INPUT', '缺少当前项目版本，请刷新。');
    const current = db.prepare('SELECT revision FROM projects WHERE project_id = ?').get(projectId).revision;
    if (current !== body.expectedRevision) throw problem('REVISION_CONFLICT', '项目已有新修改。请刷新后核对；当前输入不会自动覆盖。');
    const allowed = new Set(['create-task', 'update-task', 'start-task', 'release-task', 'complete-task', 'reopen-task', 'save-decision', 'save-rules','save-settings']);
    if (!allowed.has(body.action)) throw problem('INVALID_INPUT', '不支持此操作。');
    backup();
    const base = { projectId, actorId: ACTOR, expectedRevision: body.expectedRevision };
    let result;
    if (body.action === 'create-task') {
      const taskId = cleanText(body.taskId, '任务ID', 80);
      if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw problem('INVALID_INPUT', '任务ID请使用英文字母、数字、横线或下划线。');
      result = store.createTask({ ...base, taskId, goal: cleanText(body.goal, '任务说明', 6000), acceptanceCriteria: cleanCriteria(body.acceptanceCriteria) });
    } else if (body.action === 'update-task') result = customTaskChange(body);
    else if (body.action === 'reopen-task') result = customTaskChange(body, true);
    else if (body.action === 'start-task') result = store.claimTask({ ...base, taskId: body.taskId, agentId: ACTOR, expectedTaskVersion: body.expectedTaskVersion });
    else if (body.action === 'release-task') result = store.releaseTask({ ...base, taskId: body.taskId, reason: cleanText(body.reason, '退回待办的原因', 3000), expectedTaskVersion: body.expectedTaskVersion, force: body.force === true });
    else if (body.action === 'complete-task') {
      ownTask(body.taskId, body.expectedTaskVersion);
      if (!Array.isArray(body.evidence) || body.evidence.some(e => typeof e !== 'object' || !e || typeof e.proof !== 'string' || !e.proof.trim())) throw problem('EVIDENCE_REQUIRED', '请为每条完成条件填写实际产物或核验说明。');
      result = store.completeTask({ ...base, taskId: body.taskId, evidence: body.evidence, expectedTaskVersion: body.expectedTaskVersion });
    } else if (body.action === 'save-decision') {
      result = store.recordDecision({ ...base, decisionId: body.decisionId || 'D-USER-' + randomUUID().slice(0, 8), subject: cleanText(body.subject, '议题', 500), decision: cleanText(body.decision, '决定内容'), status: body.status, evidence: Array.isArray(body.evidence) ? body.evidence.map(e => cleanText(e, '依据', 4000)) : [] });
    } else if (body.action === 'save-settings') {
      const taskIds=new Set(db.prepare('SELECT task_id FROM tasks WHERE project_id=?').all(projectId).map(t=>t.task_id));
      const settings=cleanSettings(body.settings,taskIds);
      result=store.recordDecision({...base,decisionId:SETTINGS_ID,subject:'项目设置',decision:JSON.stringify(settings),status:'accepted',evidence:['用户在项目工作台保存项目名称、目标、阶段和任务分类设置。']});
    } else if (body.action === 'save-rules') {
      result = store.recordDecision({ ...base, decisionId: RULE_ID, subject: '本项目登记约定', decision: cleanText(body.rules, '登记约定', 16000), status: 'accepted', evidence: ['用户在本地项目看板主动保存登记约定。', String(body.reason || '更新项目协作约定')] });
    }
    return { result, state: sync() };
  }

  return {state, sync, mutate, store, entry};
}
