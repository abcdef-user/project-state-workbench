/* 通用本机项目工作台。所有业务名称、阶段、编号与进度均来自当前项目状态。 */
(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const names = { pending: '待办', running: '进行中', completed: '已完成', proposed: '待讨论', accepted: '已确认', invalidated: '已撤销' };
  const types = {
    task_created: '新增任务', task_claimed: '开始任务', task_released: '退回待办', task_completed: '完成任务',
    task_updated: '修改任务', task_reopened: '重新打开任务', decision_recorded: '新增决定', decision_updated: '修改决定',
    artifact_observed: '登记文件', artifact_changed: '文件变化', operation_succeeded: '操作成功',
    operation_failed: '操作失败', operation_started: '开始操作', settings_updated: '更新项目设置',
    project_settings_updated: '更新项目设置', settings_saved: '保存项目设置', rules_updated: '更新项目约定',
    project_created: '新建项目'
  };
  const VIEWS = ['overview', 'tasks', 'decisions', 'history', 'rules', 'settings'];
  const VIEW_LABELS = { overview: '项目总览', tasks: '任务看板', decisions: '讨论与决定', history: '历史记录', rules: '登记原则', settings: '项目设置' };
  const initialHash = location.hash.slice(1);
  const initialKey = new URLSearchParams(location.search).get('project');

  let data = null;
  let projects = [];
  let homeEnvironment = null;
  let homeSourceFilter = 'all';
  let sourceError = '';
  let readOnly = false;
  const viewMode = value => {
    readOnly = Boolean(value); document.body.classList.toggle('read-only',readOnly);
    for (const [selector,copy] of [
      ['.sidebar-bottom .home-only p','查看电脑上已有的项目、任务与历史。此入口只读，电脑上的新修改会自动更新。'],
      ['.page-footer > span:first-child','此入口仅供查看；电脑端的新修改会自动更新。'],
      ['#offline-banner','暂时无法连接电脑。请确认电脑开机、联网并运行工作台，再刷新页面。']
    ]) { const node=$(selector); if(node){node.dataset.localCopy ||= node.textContent;node.textContent=readOnly?copy:node.dataset.localCopy;} }
  };
  let lastProjectKey = null;
  let projectKey = initialKey || null;
  let home = !initialKey;
  let live = false;
  let homeLoading = true;
  let homeError = '';
  let view = VIEWS.includes(initialHash) ? initialHash : 'overview';
  let taskSearch = '';
  let phaseFilter = '';
  let showAdmin = false;
  let decisionFilter = 'all';
  let taskLayout = 'list';
  let historyRevision = null;
  let dialogContext = null;
  let dialogBaseline = null;
  let rulesDirty = false;
  let settingsDirty = false;
  let rulesRevision = null;
  let settingsRevision = null;
  let settingsDraft = null;
  let toastTimer = null;
  let busy = false;

  const editable = () => Boolean(live && data && data.canEdit && !sourceError && !readOnly);
  const sourceKind = item => item?.sourceKind === 'wsl' ? 'wsl' : 'windows';
  const sourceLabel = item => item?.sourceLabel || (sourceKind(item) === 'wsl' ? 'WSL' : 'Windows');
  const sourceBadge = item => `<span class="source-badge ${sourceKind(item)}">${esc(sourceLabel(item))}</span>`;
  const disabled = () => editable() ? '' : ' disabled';
  const settings = () => data?.settings || {};
  const phases = () => Array.isArray(settings().phases) ? settings().phases : [];
  const internalIds = () => new Set(Array.isArray(data?.internalDecisionIds) ? data.internalDecisionIds : []);
  const isAdmin = task => Boolean(task?.isAdministrative);
  const implementation = () => (data?.tasks || []).filter(task => !isAdmin(task));
  const publicDecisions = () => (data?.decisions || []).filter(decision => !internalIds().has(decision.decisionId));
  const currentKey = () => data?.projectKey || projectKey;
  const projectName = () => settings().name || data?.project?.name || '未命名项目';
  const projectGoal = () => settings().goal || data?.project?.goal || '';
  const projectDescription = () => settings().description || data?.project?.description || '';
  const taskPrefix = () => settings().taskPrefix || 'TASK-';
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  const lines = value => String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const short = (value, size = 110) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > size ? text.slice(0, size) + '…' : text;
  };
  const ownerName = task => task?.ownerAgent === 'user' ? '我' : task?.ownerAgent || '未领取';
  const phaseOf = task => phases().find(item => Array.isArray(item.tasks) && item.tasks.includes(task?.taskId)) || null;
  const phaseName = task => phaseOf(task)?.name || '未分阶段';
  const pill = (status, label) => `<span class="pill ${status === 'running' || status === 'proposed' ? 'amber' : status === 'completed' || status === 'accepted' ? 'green' : status === 'invalidated' ? 'gray' : ''}">${esc(label || names[status] || status)}</span>`;
  const button = (label, action, extra = '', cls = '') => `<button class="button ${cls}" type="button" data-action="${action}" ${extra}>${label}</button>`;
  const field = (label, input, note = '') => `<label class="field"><span>${esc(label)}</span>${input.replace(/^<(textarea|input|select)\b/, '<$1 aria-label="' + esc(label) + '"')}${note ? `<small>${esc(note)}</small>` : ''}</label>`;
  const emptyState = (title, text, actions = '') => `<div class="empty"><strong>${esc(title)}</strong><p>${esc(text)}</p>${actions ? `<div class="empty-actions">${actions}</div>` : ''}</div>`;

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    const node = $('#toast');
    node.textContent = message;
    node.className = 'toast' + (error ? ' error' : '');
    node.hidden = false;
    toastTimer = setTimeout(() => { node.hidden = true; }, error ? 8000 : 3600);
  }

  function formError(message) {
    if ($('#editor').open) {
      const node = $('#editor-error');
      node.textContent = message;
      node.hidden = false;
      node.scrollIntoView({ block: 'nearest' });
    } else {
      const node = $('#settings-error');
      if (node) {
        node.textContent = message;
        node.hidden = false;
      } else {
        toast(message, true);
      }
    }
  }

  function connection() {
    const connectionNode = $('#connection');
    connectionNode.className = 'connection' + (live ? ' live' : '');
    connectionNode.innerHTML = `<b></b>${live ? (readOnly?'只读查看 · 已连接':'已连接本机状态') : '电脑暂未连接'}`;
    const revisionNode = $('#revision');
    revisionNode.hidden = home || !data;
    revisionNode.textContent = data ? `第 ${data.revision ?? '—'} 版` : '';
    $('#offline-banner').hidden = live;
    $('#export-banner').hidden = !data?.exportWarning && !sourceError;
    $('#export-banner').textContent = sourceError || data?.exportWarning || '';
    $('#last-updated').textContent = data?.readAt ? `读取于 ${time(data.readAt)} · 北京时间` : (live ? '本机服务已就绪' : '');
    $('#nav-task-count').textContent = data ? implementation().filter(task => task.status !== 'completed').length : '—';
  }

  function updateUrl() {
    const url = new URL(location.href);
    if (home) {
      url.searchParams.delete('project');
      url.hash = '';
    } else if (projectKey) {
      url.searchParams.set('project', projectKey);
      url.hash = view;
    }
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  async function requestJson(path, options = {}) {
    try {
      const response = await fetch(path, { cache: 'no-store', ...options });
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) {
        const error = new Error(payload?.error || `请求失败（${response.status}）`);
        error.httpStatus = response.status;
        error.code = payload?.code;
        throw error;
      }
      live = true;
      return payload;
    } catch (error) {
      if (error.httpStatus) throw error;
      live = false;
      connection();
      throw new Error('无法连接本机服务，不能保存或打开项目。已填写的内容仍保留，请确认工作台仍在运行后重试。');
    }
  }

  function projectRequest(body) {
    return requestJson('/api/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Project-Board': '1' },
      body: JSON.stringify(body)
    });
  }

  function stateRequest(key) {
    return requestJson(`/api/state?project=${encodeURIComponent(key)}`);
  }

  function setBusy(value) {
    busy = value;
    document.body.classList.toggle('is-busy', value);
    $$('#editor-actions button, .settings-actions button, .rules-actions button, .home-actions button').forEach(node => {
      if (value) node.setAttribute('aria-busy', 'true');
      else node.removeAttribute('aria-busy');
    });
  }

  function syncChrome() {
    document.body.classList.toggle('home-mode', home);
    const activeView = home ? null : view;
    $$('.nav-item[data-view]').forEach(node => {
      const active = node.dataset.view === activeView;
      node.classList.toggle('active', active);
      if (active) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    const homeNav = $('.nav-home');
    homeNav?.classList.toggle('active', home);
    if (home) homeNav?.setAttribute('aria-current', 'page');
    else homeNav?.removeAttribute('aria-current');

    $('#breadcrumb-current').textContent = home ? '全域项目' : VIEW_LABELS[view] || '项目总览';
    const crumbProject = $('#breadcrumb-project');
    const crumbSep = $('#breadcrumb-sep-project');
    crumbProject.hidden = home || !data;
    crumbSep.hidden = home || !data;
    crumbProject.textContent = data ? projectName() : '';
    $('#switch-project').hidden = home;
    $('#revision').hidden = home || !data;

    if (data) {
      $('#sidebar-project-name').textContent = projectName();
      $('#sidebar-project-desc').textContent = short(projectDescription() || projectGoal() || '暂无项目简介', 64);
      const pathNode = $('#sidebar-project-path');
      pathNode.textContent = data.project?.workspaceRoot || '';
      pathNode.title = data.project?.workspaceRoot || '';
      let sourceNode = $('#sidebar-project-source');
      if (!sourceNode) { sourceNode = document.createElement('div'); sourceNode.id = 'sidebar-project-source'; pathNode.before(sourceNode); }
      sourceNode.innerHTML = sourceBadge(data.project) + (sourceError ? '<small>来源暂未连接</small>' : '');
    }
    connection();
  }

  function normalizeEnvironment(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const strings = values => [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean))];
    const storageRoots = strings(raw.storageRoots);
    const warnings = strings(raw.warnings);
    const emptyWorkspaces = (Array.isArray(raw.emptyWorkspaces) ? raw.emptyWorkspaces : [])
      .filter(item => item && typeof item === 'object')
      .map(item => ({ name: String(item.name || '').trim(), workspaceRoot: String(item.workspaceRoot || '').trim() }))
      .filter(item => item.name || item.workspaceRoot);
    const count = Number(raw.workspaceCount);
    return {
      scope: String(raw.scope || ''),
      storageRoots,
      dataDirectory: String(raw.dataDirectory || '').trim(),
      workbenchDirectory: String(raw.workbenchDirectory || '').trim(),
      workspaceCount: Number.isFinite(count) && count >= 0 ? Math.floor(count) : null,
      emptyWorkspaces,
      warnings,
      sources: Array.isArray(raw.sources) ? raw.sources : [{id:'windows',label:'Windows',kind:'windows',available:true,storageRoot:storageRoots[0],dataDirectory:raw.dataDirectory}]
    };
  }

  function homeProjectCard(project, index) {
    const total = Number(project.taskCount) || 0;
    const done = Number(project.completedCount) || 0;
    const percent = total ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
    const missing = Boolean(project.missing);
    const unavailable = Boolean(project.sourceUnavailable);
    const isLast = project.key === lastProjectKey;
    return `<article class="home-project-card${missing ? ' is-missing' : ''}" data-project="${esc(project.key)}">
      <div class="home-card-top">
        <span class="home-card-index">${String(index + 1).padStart(2, '0')}</span>
        <div class="home-card-title">
          <span class="eyebrow">${isLast ? '上次打开 / LAST' : 'SHARED PROJECT'}</span>
          <h3>${esc(project.name || '未命名项目')}</h3>
        </div>
        ${missing ? '<span class="pill gray">文件夹不可用</span>' : isLast ? '<span class="pill">上次打开</span>' : ''}
      </div>
      <p class="home-card-desc">${esc(project.description || (readOnly?'暂无项目简介。':'暂无项目简介，打开后可以补充目标与说明。'))}</p>
      <div class="home-path" title="${esc(project.workspaceRoot || '')}">${esc(project.workspaceRoot || '路径未知')}</div>
      <div class="source-row">${sourceBadge(project)}${unavailable ? '<span class="source-warning">来源暂未连接 · 上次记录</span>' : ''}</div>
      <div class="home-card-stats">
        <span><b>${total}</b> 项任务</span>
        <span><b>${done}</b> 项完成</span>
        <span>${total ? `${percent}%` : '尚未开始'}</span>
      </div>
      <div class="home-progress" aria-hidden="true"><span style="width:${percent}%"></span></div>
      <div class="home-card-actions">
        ${missing ? '<span class="compact-note">请恢复原文件夹后再打开</span>' : button('打开项目', 'switch-project', `data-id="${esc(project.key)}"${unavailable ? ' disabled' : ''}`, 'primary compact')}
        ${missing ? '' : button('打开文件夹', 'open-folder-home', `data-id="${esc(project.key)}"${unavailable ? ' disabled' : ''}`, 'quiet compact')}
      </div>
    </article>`;
  }

  function renderHome() {
    syncChrome();
    const allProjects = Array.isArray(projects) ? projects : [];
    const visibleProjects = allProjects.filter(p => homeSourceFilter === 'all' || sourceKind(p) === homeSourceFilter);
    const last = allProjects.find(project => project.key === lastProjectKey) || null;
    const environment = homeEnvironment;
    const storageRoots = environment?.storageRoots || [];
    const primaryStorageRoot = storageRoots[0] || environment?.dataDirectory || '';
    const dataDirectory = environment?.dataDirectory || '';
    const workbenchDirectory = environment?.workbenchDirectory || '';
    const emptyWorkspaces = environment?.emptyWorkspaces || [];
    const emptyCount = emptyWorkspaces.length;
    const workspaceCount = environment?.workspaceCount;
    const warnings = environment?.warnings || [];
    const warningPanel = warnings.length ? `<section class="home-warning" role="alert"><div class="home-warning-mark" aria-hidden="true">!</div><div><strong>环境提示</strong><ul>${warnings.map(warning => `<li>${esc(warning)}</li>`).join('')}</ul></div></section>` : '';
    const workspaceSummary = workspaceCount === null || typeof workspaceCount === 'undefined'
      ? '项目来自共享状态汇总'
      : `扫描到 ${workspaceCount} 个工作区${emptyCount ? `，其中 ${emptyCount} 个尚未建立项目` : ''}`;
    let cardArea = '';
    if (homeLoading && !allProjects.length) {
      cardArea = '<div class="home-loading"><span class="spinner" aria-hidden="true"></span><strong>正在读取全域项目…</strong><p>项目列表来自本机共享状态，不会访问网络。</p></div>';
    } else if (homeError && !allProjects.length) {
      cardArea = `<div class="home-empty error-empty"><span class="home-empty-mark">!</span><h3>暂时无法读取项目列表</h3><p>${esc(homeError)}</p><div class="empty-actions">${button('重新读取', 'reload-projects', '', 'primary')}${button('打开项目文件夹', 'open-existing-folder', '', 'quiet')}</div></div>`;
    } else if (!allProjects.length) {
      cardArea = `<div class="home-empty"><span class="home-empty-mark">＋</span><h3>共享状态里还没有项目</h3><p>${emptyCount ? `已扫描到 ${emptyCount} 个工作区尚未建立项目。` : ''}打开项目文件夹读取已有项目，或在空文件夹里新建一个项目。</p><div class="empty-actions">${button('打开项目文件夹', 'open-existing-folder', '', 'primary')}${button('新建项目', 'new-project', '', 'quiet')}</div></div>`;
    } else {
      cardArea = visibleProjects.length ? `<div class="home-project-grid">${visibleProjects.map(homeProjectCard).join('')}</div>` : emptyState('这个来源还没有项目','可切换“全部”查看其它来源，或打开对应的项目文件夹。');
    }
    const pendingWorkspaces = allProjects.length && emptyCount
      ? `<div class="home-pending-note"><span aria-hidden="true"></span><p>另有 ${emptyCount} 个工作区尚未建立项目，因此不会显示为空项目。</p></div>`
      : '';

    $('#content').innerHTML = `<div class="home-shell">
      <section class="home-hero">
        <div class="home-hero-copy">
          <div class="eyebrow">GLOBAL WORKBENCH / 本机全域</div>
          <h1>所有项目，<br>集中在这里。</h1>
          <p>自动列出共享状态中已经建立的全部项目。任务、讨论、约定和历史沿用各项目原有的共享状态记录。</p>
          <div class="home-actions">
            ${button('打开项目文件夹', 'open-existing-folder', '', 'primary')}
            ${button('新建项目', 'new-project', '', 'quiet')}
            ${button('输入文件夹路径', 'enter-folder-path', '', 'text-button')}
            ${last && !last.missing && !last.sourceUnavailable ? button('继续上次项目', 'switch-project', `data-id="${esc(last.key)}"`, 'text-button') : ''}
          </div>
          <div class="home-footnote"><span>共享状态自动汇总</span><span>项目数据留在本机</span><span>每次修改保留历史</span></div>
        </div>
        <div class="home-orbit" aria-hidden="true">
          <span class="orbit-ring ring-one"></span>
          <span class="orbit-ring ring-two"></span>
          <span class="orbit-core"><b>${allProjects.length}</b><small>个项目</small></span>
          <span class="orbit-node node-one"></span>
          <span class="orbit-node node-two"></span>
          <span class="orbit-label label-one">全域汇总</span>
          <span class="orbit-label label-two">共享状态</span>
          <span class="orbit-label label-three">可追溯</span>
        </div>
      </section>
      ${warningPanel}
      <section class="home-recent">
        <div class="section-header home-section-head">
          <div><div class="eyebrow">ALL PROJECTS / 全域项目</div><h2>全部项目</h2><p class="home-section-copy">自动列出共享状态中已经建立的项目，访问先后不影响是否显示。</p></div>
          <span>显示 ${visibleProjects.length} / 共 ${allProjects.length} 个项目</span>
        </div>
        <div class="source-filters" role="group" aria-label="项目来源筛选">${[['all','全部'],['windows','Windows'],['wsl','WSL']].map(([kind,label])=>button(`${label} <small>${kind==='all'?allProjects.length:allProjects.filter(p=>sourceKind(p)===kind).length}</small>`, 'filter-source', `data-id="${kind}" aria-pressed="${homeSourceFilter===kind}"`, homeSourceFilter===kind?'primary compact':'quiet compact')).join('')}</div>
        ${pendingWorkspaces}
        ${cardArea}
      </section>
      <section class="home-environment">
        <div class="section-header home-section-head">
          <div><div class="eyebrow">LOCAL PATHS / 本机位置</div><h2>数据与程序位置</h2><p class="home-section-copy">${esc(workspaceSummary)}</p></div>
        </div>
        <div class="home-env-grid">
          ${(environment?.sources || []).map(source=>`<article class="home-env-card">
            <div class="home-env-head"><div><span>${source.kind==='wsl'?'WSL':'WINDOWS'} / SHARED STATE</span><h3>${esc(source.label)}</h3></div><span class="pill ${source.available?'green':'amber'}">${source.available?'已连接':'暂未连接'}</span></div>
            <p class="home-env-help">${Number(source.projectCount)||0} 个项目 · ${Number(source.workspaceCount)||0} 个工作区${source.distribution?' · '+esc(source.distribution):''}</p>
            ${source.error?`<p class="source-warning">${esc(source.error)}</p>`:''}
            <div class="home-env-path"><span>共享状态目录</span><code>${esc(source.storageRoot || '未提供')}</code></div>
            ${source.dataDirectory?`<div class="home-env-path"><span>入口登记与连接记录</span><code>${esc(source.dataDirectory)}</code></div>`:''}
            <div class="home-env-actions">${button('打开共享状态目录','open-state-folder',`data-id="${esc(source.id)}"${source.available?'':' disabled'}`,'quiet compact')}</div>
          </article>`).join('')}
          <article class="home-env-card">
            <div class="home-env-head"><div><span>WORKBENCH</span><h3>工作台程序</h3></div><b>02</b></div>
            <div class="home-env-path"><span>程序目录</span><code>${esc(workbenchDirectory || '服务未提供目录信息')}</code></div>
            <p class="home-env-help">程序与共享状态分开保存；项目数据不会被写进程序目录。</p>
            <div class="home-env-actions">${button('打开工作台目录', 'open-program-folder', workbenchDirectory ? '' : 'disabled', 'quiet compact')}</div>
          </article>
        </div>
      </section>
    </div>`;
  }

  async function loadProjects(options = {}) {
    const silent = Boolean(options.silent);
    if (!silent) {
      homeLoading = true;
      homeError = '';
      if (home) renderHome();
    }
    try {
      const reply = await requestJson('/api/projects');
      viewMode(reply.readOnly);
      projects = Array.isArray(reply.projects) ? reply.projects : [];
      homeEnvironment = normalizeEnvironment(reply.environment);
      lastProjectKey = reply.lastProjectKey || null;
      homeError = '';
      live = true;
    } catch (error) {
      homeError = error.message;
      live = false;
    } finally {
      homeLoading = false;
      if (home) renderHome();
      connection();
    }
  }

  function receiveState(state, key, options = {}) {
    if (!state) return;
    const fresh = Boolean(options.fresh);
    if (fresh && $('#editor').open) $('#editor').close();
    data = state;
    viewMode(state.readOnly);
    sourceError = '';
    projectKey = state.projectKey || key || projectKey;
    home = false;
    live = true;
    if (fresh && options.resetView) view = 'overview';
    if (!VIEWS.includes(view)) view = 'overview';
    if (fresh) {
      taskSearch = '';
      phaseFilter = '';
      showAdmin = false;
      decisionFilter = 'all';
      taskLayout = 'list';
      historyRevision = null;
      rulesDirty = false;
      settingsDirty = false;
      settingsDraft = null;
      rulesRevision = data.revision;
      settingsRevision = data.revision;
    } else {
      if (!rulesDirty) rulesRevision = data.revision;
      if (!settingsDirty) settingsRevision = data.revision;
    }
    updateUrl();
    render();
  }

  function currentDialogSnapshot() {
    return $$('#editor-body input, #editor-body textarea, #editor-body select').map((node, index) => {
      const value = node.type === 'checkbox' || node.type === 'radio' ? (node.checked ? '1' : '0') : node.value;
      return `${index}:${value}`;
    }).join('\u0001');
  }

  function editorHasPotentialChanges() {
    if (!$('#editor').open || !dialogContext || dialogBaseline === null) return false;
    return currentDialogSnapshot() !== dialogBaseline;
  }

  function confirmLeave(message = '当前有尚未保存的修改。离开后这些输入会丢失，继续吗？') {
    if (!rulesDirty && !settingsDirty && !editorHasPotentialChanges()) return true;
    return window.confirm(message);
  }

  function resetUnsaved() {
    rulesDirty = false;
    settingsDirty = false;
    settingsDraft = null;
    if ($('#editor').open) $('#editor').close();
  }

  function goHome() {
    if (home) {
      renderHome();
      return;
    }
    if (!confirmLeave()) return;
    resetUnsaved();
    home = true;
    data = null;
    projectKey = null;
    view = 'overview';
    historyRevision = null;
    updateUrl();
    renderHome();
    loadProjects({ silent: Boolean(projects.length) });
  }

  async function switchToProject(key) {
    if (!key || busy) return;
    if (!home && !confirmLeave('切换项目会离开当前工作区，尚未保存的输入会丢失。继续吗？')) return;
    setBusy(true);
    try {
      const reply = readOnly ? {ok:true,state:await stateRequest(key),projectKey:key} : await projectRequest({ action: 'switch', key });
      if (!reply?.ok || !reply.state) throw new Error(reply?.error || '没有读到这个项目');
      receiveState(reply.state, reply.projectKey || key, { fresh: true, resetView: true });
      toast(`已打开「${projectName()}」`);
    } catch (error) {
      toast(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function openFolder(pathKey = currentKey()) {
    if (!pathKey || busy) return;
    setBusy(true);
    try {
      const reply = await projectRequest({ action: 'open-folder', projectKey: pathKey });
      if (!reply?.ok) throw new Error(reply?.error || '无法打开项目文件夹');
      toast('已在文件管理器中打开项目文件夹');
    } catch (error) {
      toast(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function openEnvironmentFolder(action, sourceId) {
    if (busy) return;
    const label = action === 'open-state-folder' ? '共享状态目录' : '工作台程序目录';
    setBusy(true);
    try {
      const reply = await projectRequest({ action, ...(action === 'open-state-folder' && sourceId ? {sourceId} : {}) });
      if (!reply?.ok) throw new Error(reply?.error || `无法打开${label}`);
      toast(`已在文件管理器中打开${label}`);
    } catch (error) {
      toast(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function pickFolder(intent) {
    if (busy) return;
    setBusy(true);
    toast('请在本机文件夹选择窗口中选择项目目录');
    try {
      const reply = await projectRequest({ action: 'pick-folder' });
      if (reply?.canceled) {
        toast('已取消选择');
        return;
      }
      if (!reply?.workspaceRoot) throw new Error('没有取得所选文件夹路径');
      await probeFolder(reply.workspaceRoot, intent);
    } catch (error) {
      toast(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function probeFolder(workspaceRoot, intent) {
    const reply = await projectRequest({ action: 'open', workspaceRoot });
    if (reply?.needsProjectChoice) {
      showProjectChoice(reply, workspaceRoot, intent);
      return;
    }
    if (reply?.needsCreation) {
      showCreateProject(reply.workspaceRoot || workspaceRoot, reply.suggestedName || '', intent);
      return;
    }
    if (reply?.ok && reply.state) {
      if (intent === 'new') {
        showExistingFolder(reply, workspaceRoot);
        return;
      }
      receiveState(reply.state, reply.projectKey, { fresh: true, resetView: true });
      toast(`已打开「${projectName()}」`);
      return;
    }
    throw new Error(reply?.error || '无法确认这个文件夹中的项目');
  }

  function showProjectChoice(reply, workspaceRoot, intent) {
    const choices = Array.isArray(reply.projects) ? reply.projects : [];
    openDialog('选择项目 / PROJECT', '这个文件夹里有多个项目', `
      <div class="note-box">请选择要打开的项目。工作台只读取你选中的这一项。</div>
      <div class="path-inline" title="${esc(workspaceRoot)}">${esc(workspaceRoot)}</div>
      <div class="choice-list">${choices.map((item, index) => `<button class="choice-row" type="button" data-action="choose-project" data-id="${index}"><span><strong>${esc(item.name || '未命名项目')}</strong><small>${esc(item.projectId || '')}</small></span><span aria-hidden="true">↗</span></button>`).join('')}</div>
      ${intent === 'new' ? '<p class="compact-note">这是已有项目。新建项目不能覆盖它；请改用其他空文件夹。</p>' : ''}
    `, button('换个文件夹', 'pick-other', '', 'quiet push-left') + button('取消', 'close-editor', '', 'quiet'), { mode: 'project-choice', workspaceRoot, choices, intent });
  }

  function showCreateProject(workspaceRoot, suggestedName, intent) {
    const fallback = String(workspaceRoot || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '新项目';
    openDialog('新建项目 / CREATE', '在这个文件夹建立项目', `
      <div class="note-box">这里还没有项目。项目名称可以与文件夹名称不同；之后仍可在“项目设置”中修改。</div>
      <div class="path-inline" title="${esc(workspaceRoot)}">${esc(workspaceRoot)}</div>
      ${field('项目名称', `<input id="new-project-name" value="${esc(suggestedName || fallback)}" autocomplete="off">`, '会显示在项目首页与侧栏。')}
      ${field('项目目标（选填）', `<textarea id="new-project-goal" placeholder="这个项目最终要解决什么？"></textarea>`, '目标可以稍后在项目设置中补充。')}
      <p class="compact-note">${intent === 'new' ? '确认后会建立独立项目记录，并在项目目录生成可读导出。' : '如果只是打开已有项目，请重新选择对应文件夹。'}</p>
    `, button('换个文件夹', 'pick-other', '', 'quiet push-left') + button('取消', 'close-editor', '', 'quiet') + button('创建项目', 'create-project', '', 'primary'), { mode: 'create-project', workspaceRoot, intent });
  }

  function showExistingFolder(reply, workspaceRoot) {
    openDialog('已有项目 / EXISTING', '这个文件夹里已经有项目', `
      <div class="note-box">为避免覆盖已有数据，新建流程不会写入这个文件夹。你可以直接打开其中的项目，或换一个空文件夹。</div>
      <div class="path-inline" title="${esc(workspaceRoot)}">${esc(workspaceRoot)}</div>
      <div class="choice-list"><div class="choice-row static"><span><strong>${esc(reply?.state?.project?.name || reply?.state?.settings?.name || '已有项目')}</strong><small>${esc(workspaceRoot)}</small></span></div></div>
    `, button('换个文件夹', 'pick-other', '', 'quiet push-left') + button('取消', 'close-editor', '', 'quiet') + button('打开已有项目', 'open-existing-reply', '', 'primary'), { mode: 'existing-project', workspaceRoot, intent: 'open', reply });
  }

  async function chooseProject(index) {
    const context = dialogContext;
    const choice = context?.choices?.[Number(index)];
    if (!choice) return;
    setBusy(true);
    try {
      const reply = await projectRequest({ action: 'open', workspaceRoot: context.workspaceRoot, projectId: choice.projectId });
      if (reply?.needsCreation) {
        showCreateProject(reply.workspaceRoot || context.workspaceRoot, reply.suggestedName || '', context.intent);
        return;
      }
      if (!reply?.ok || !reply.state) throw new Error(reply?.error || '无法打开所选项目');
      receiveState(reply.state, reply.projectKey, { fresh: true, resetView: true });
      toast(`已打开「${projectName()}」`);
    } catch (error) {
      formError(error.message);
      toast(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function createProject() {
    const context = dialogContext;
    if (!context?.workspaceRoot) return;
    const name = $('#new-project-name')?.value.trim() || '';
    const goal = $('#new-project-goal')?.value.trim() || '';
    if (!name) {
      formError('请填写项目名称。');
      $('#new-project-name')?.focus();
      return;
    }
    setBusy(true);
    try {
      const reply = await projectRequest({ action: 'create', workspaceRoot: context.workspaceRoot, name, goal });
      if (!reply?.ok || !reply.state) throw new Error(reply?.error || '新建项目失败');
      receiveState(reply.state, reply.projectKey, { fresh: true, resetView: true });
      toast(`已新建并打开「${projectName()}」`);
    } catch (error) {
      formError(error.message);
      toast(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  function openDialog(kicker, name, body, actions, context = {}) {
    dialogContext = { ...context, key: currentKey(), revision: data?.revision ?? null };
    $('#editor-kicker').textContent = kicker;
    $('#editor-title').textContent = name;
    $('#editor-body').innerHTML = body;
    $('#editor-actions').innerHTML = actions;
    $('#editor-error').hidden = true;
    $('#editor-error').textContent = '';
    dialogBaseline = currentDialogSnapshot();
    if (!$('#editor').open) $('#editor').showModal();
  }

  async function performChange(body, options = {}) {
    const key = options.key || currentKey();
    if (!editable()) {
      formError('本机服务未连接或当前项目只读，不能保存修改。');
      return null;
    }
    if (!key) {
      formError('没有识别到当前项目，不能写入。请先打开一个项目。');
      return null;
    }
    if (busy) return null;
    setBusy(true);
    const settingsError = $('#settings-error');
    if (settingsError) settingsError.hidden = true;
    $('#editor-error').hidden = true;
    try {
      const reply = await requestJson('/api/change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Project-Board': '1' },
        body: JSON.stringify({ ...body, projectKey: key })
      });
      if (!reply?.ok) throw new Error(reply?.error || '保存失败');
      if (reply.state?.projectKey && reply.state.projectKey !== key) throw new Error('返回的项目与当前页面不一致，已停止写入。');
      if (options.onSuccess) options.onSuccess(reply);
      receiveState(reply.state, key, { fresh: false });
      if (options.close !== false) $('#editor').close();
      toast(reply.state?.exportWarning || `已保存 · 第 ${reply.state?.revision} 版`, Boolean(reply.state?.exportWarning));
      return reply;
    } catch (error) {
      formError(error.message);
      toast(error.message, true);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function heading(eyebrow, name, description, action = '') {
    return `<div class="page-heading"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(name)}</h1><p class="subtle">${esc(description)}</p></div>${action}</div>`;
  }

  function summary(event) {
    const payload = event?.payload || {};
    if (event.type === 'task_created') return payload.goal || '新增了一项任务';
    if (event.type === 'task_updated') return (payload.reason ? payload.reason + ' · ' : '') + (payload.after?.goal || '调整了任务说明与完成条件');
    if (event.type === 'task_reopened' || event.type === 'task_released') return payload.reason || '任务回到待办';
    if (event.type === 'task_claimed') return '承接者：' + (payload.ownerAgent === 'user' ? '我' : payload.ownerAgent || '未注明');
    if (event.type === 'task_completed') return `已登记 ${payload.evidence?.length || 0} 项完成依据`;
    if (event.type.startsWith('decision_')) return `${payload.subject || '讨论议题'} · ${names[payload.status] || payload.status || ''}`;
    if (event.type.startsWith('artifact_')) return payload.summary || '已观察文件版本';
    if (event.type.startsWith('operation_')) return payload.target?.split(/[\\/]/).pop() || event.objectId;
    if (event.type === 'project_created') return payload.name || payload.projectName || '建立了本机项目';
    if (event.type.includes('settings')) return payload.summary || '项目资料、阶段或任务归属已更新';
    if (event.type.includes('rules')) return '项目协作约定已更新';
    return event.objectId || '项目状态发生变化';
  }

  function overview() {
    const tasks = implementation();
    const done = tasks.filter(task => task.status === 'completed').length;
    const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
    const counts = {
      pending: tasks.filter(task => task.status === 'pending').length,
      running: tasks.filter(task => task.status === 'running').length,
      completed: done
    };
    const phaseList = phases();
    const currentPhase = phaseList.find(item => {
      const list = tasks.filter(task => Array.isArray(item.tasks) && item.tasks.includes(task.taskId));
      return list.some(task => task.status !== 'completed');
    }) || null;
    const nextTask = tasks.find(task => task.status === 'running') || tasks.find(task => task.status === 'pending') || null;
    const publicList = publicDecisions();
    const proposed = publicList.filter(item => item.status === 'proposed');
    const accepted = publicList.filter(item => item.status === 'accepted');
    const goal = projectGoal();
    const description = projectDescription();
    const recent = (data.events || []).slice(0, 4);

    const phaseSection = phaseList.length ? `<section class="overview-phases">
      <div class="section-header"><h2>项目阶段</h2><span>${phaseList.length} 个阶段 · 点击查看关联任务</span></div>
      <div class="phase-grid">${phaseList.map((item, index) => {
        const list = tasks.filter(task => Array.isArray(item.tasks) && item.tasks.includes(task.taskId));
        const count = list.filter(task => task.status === 'completed').length;
        const phasePercent = list.length ? Math.round(count / list.length * 100) : 0;
        return `<button class="phase-card${item === currentPhase ? ' current' : ''}" type="button" data-action="phase" data-id="${esc(item.id)}">
          <div class="number">${esc(item.id || String(index + 1).padStart(2, '0'))}${item === currentPhase ? '<b>当前推进</b>' : ''}</div>
          <h3>${esc(item.name || '未命名阶段')}</h3>
          <p>${esc(item.text || '没有填写阶段说明。')}</p>
          <div class="phase-track"><span style="width:${phasePercent}%"></span></div>
          <div class="bottom"><span>${list.length ? `${count} / ${list.length} 项完成` : '未关联任务'}</span><span aria-hidden="true">↗</span></div>
        </button>`;
      }).join('')}</div>
    </section>` : `<section class="overview-phases">
      <div class="section-header"><h2>项目阶段</h2><span>可选配置</span></div>
      <div class="panel settings-empty"><span class="empty-symbol" aria-hidden="true">—</span><div><h3>还没有设置阶段</h3><p>阶段不是必填项。你可以直接管理任务，也可以按自己的项目方法在设置中增加阶段。</p></div>${button('配置阶段', 'goto-settings', '', 'quiet compact')}</div>
    </section>`;

    return heading('PROJECT / 01', '项目总览', description || '从真实目标、任务与讨论进入当前项目。所有数字均由本机共享状态计算。', button('查看全部任务 ↗', 'goto-tasks', '', 'quiet')) + `
    <div class="hero">
      <section class="project-card">
        <div class="project-top"><span class="eyebrow">PROJECT OBJECTIVE / 项目目标</span>${currentPhase ? pill('running', currentPhase.name) : ''}</div>
        <h2 class="goal-copy">${esc(goal || '尚未填写项目目标')}</h2>
        <p>${esc(description || (goal ? '项目简介尚未填写，可在项目设置中补充对象、边界与交付说明。' : '目标与简介仍为空。先写下项目要解决的问题，再开始拆分任务。'))}</p>
        <div class="project-meta"><span>${phaseList.length} 个阶段</span><span>${tasks.length} 项实施任务</span><span>${proposed.length} 项议题待讨论</span></div>
        ${goal ? '' : `<div class="focus-actions">${button('补充项目目标', 'goto-settings', '', 'compact quiet')}</div>`}
      </section>
      <section class="progress-card">
        <div class="progress-top"><span class="eyebrow">实施任务 / PROGRESS</span><span class="progress-percent">${percent}%</span></div>
        <div class="progress-main">
          <div class="progress-ring" style="--pct:${percent}"><div><strong>${done}</strong><small> / ${tasks.length}</small><span>已完成</span></div></div>
          <div class="progress-breakdown"><span><i></i>待办<b>${counts.pending}</b></span><span><i></i>进行中<b>${counts.running}</b></span><span><i></i>已完成<b>${counts.completed}</b></span></div>
        </div>
        ${tasks.length ? '' : `<div class="progress-empty">还没有实施任务。${button('新增第一项任务', 'new-task', disabled(), 'compact text-button')}</div>`}
      </section>
    </div>
    <div class="overview-layout">
      <div>
        ${phaseSection}
        <section class="recent-section">
          <div class="section-header"><h2>最近变化</h2><button class="text-link" type="button" data-action="goto-history">全部历史 ↗</button></div>
          ${recent.length ? `<div class="panel recent-panel">${recent.map(event => `<div class="recent-row"><span class="recent-dot"></span><span>${esc(types[event.type] || event.type)}<span class="muted">${esc(short(summary(event), 95))}</span></span><span class="date">${esc(time(event.createdAt))}</span></div>`).join('')}</div>` : '<div class="panel recent-panel"><div class="recent-row"><span class="recent-dot"></span><span>还没有历史记录。<span class="muted">第一次保存后，这里会出现可追溯的变化。</span></span><span class="date">—</span></div></div>'}
        </section>
      </div>
      <aside class="overview-side">
        <section class="panel next-panel">
          <div class="panel-kicker">NEXT / 下一步<span>${nextTask?.status === 'running' ? '正在推进' : '按当前状态'}</span></div>
          ${nextTask ? `<button class="next-task" type="button" data-action="edit-task" data-id="${esc(nextTask.taskId)}"><span class="task-id">${esc(nextTask.taskId)} · ${esc(phaseName(nextTask))}</span><strong>${esc(short(nextTask.goal, 96))}</strong><small><span>${nextTask.acceptanceCriteria?.length || 0} 条完成条件</span><span>打开任务 ↗</span></small></button>` : `<div class="panel-empty-copy"><p>${tasks.length ? '当前实施任务均已完成。' : '当前还没有实施任务。'}</p>${button('新增任务 ＋', 'new-task', disabled(), 'compact quiet')}</div>`}
        </section>
        <section class="panel focus-panel">
          <div class="panel-kicker">DISCUSS / 待讨论<span>${proposed.length} 项</span></div>
          ${proposed.length ? proposed.slice(0, 3).map(item => `<div class="focus-topic"><h3>${esc(item.subject)}</h3><p>${esc(short(item.decision, 90))}</p><button class="text-link" type="button" data-action="edit-decision" data-id="${esc(item.decisionId)}">查看 / 继续讨论 ↗</button></div>`).join('') : `<div class="panel-empty-copy"><span class="pill gray">还没有待讨论议题</span><p>建议与结论分开记录，确认前不会进入共同方向。</p>${button('记录一个新议题 ＋', 'new-decision', disabled(), 'compact quiet')}</div>`}
        </section>
        <section class="panel facts">
          <div class="section-header"><h2>已确认方向</h2><span>${accepted.length} 项</span></div>
          ${accepted.length ? accepted.slice(0, 4).map(item => `<button class="fact" type="button" data-action="edit-decision" data-id="${esc(item.decisionId)}"><span class="fact-label">CONFIRMED</span><span>${esc(item.subject)}</span></button>`).join('') : '<p class="facts-empty">还没有已确认的方向。待讨论议题只有在你确认并填写依据后，才会出现在这里。</p>'}
        </section>
      </aside>
    </div>`;
  }

  function nextTaskId() {
    const prefix = taskPrefix();
    const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp('^' + escapeRegExp(prefix) + '(\\d+)$', 'i');
    const numbers = (data.tasks || []).map(task => matcher.exec(task.taskId)).filter(Boolean).map(match => Number(match[1]));
    let number = Math.max(0, ...numbers) + 1;
    let candidate = prefix + String(number).padStart(2, '0');
    const used = new Set((data.tasks || []).map(task => task.taskId));
    while (used.has(candidate)) {
      number += 1;
      candidate = prefix + String(number).padStart(2, '0');
    }
    return candidate;
  }

  function tasksPage() {
    const total = implementation().length;
    if (phaseFilter && !phases().some(item => item.id === phaseFilter) && phaseFilter !== '__unassigned') phaseFilter = '';
    const phaseOptions = phases().map(item => `<option value="${esc(item.id)}" ${phaseFilter === item.id ? 'selected' : ''}>${esc(item.name || item.id)}</option>`).join('');
    return heading('WORK / 02', '任务看板', '点开任务即可查看、修改或推进。完成条件与依据会随任务一起保留，辅助任务不进入实施进度。', button('＋ 新增任务', 'new-task', disabled(), 'primary')) + `
    <div class="toolbar">
      <input class="search" id="task-search" aria-label="搜索任务" placeholder="搜索任务、编号或内容…" value="${esc(taskSearch)}">
      <select id="phase-filter" aria-label="筛选阶段"><option value="">全部阶段</option>${phaseOptions}${phases().length ? `<option value="__unassigned" ${phaseFilter === '__unassigned' ? 'selected' : ''}>未分阶段</option>` : ''}</select>
      <div class="tabs">${[['list', '任务列表'], ['board', '状态看板']].map(([key, label]) => `<button type="button" data-action="task-layout" data-id="${key}" class="${taskLayout === key ? 'active' : ''}">${label}</button>`).join('')}</div>
      <label class="summary-count"><input id="show-admin" type="checkbox" ${showAdmin ? 'checked' : ''}> 显示辅助任务</label>
      <span class="toolbar-note" id="task-result-count">共 ${total} 项实施任务</span>
    </div>
    <div id="task-columns"></div>`;
  }

  function filteredTasks() {
    let tasks = [...(data.tasks || [])];
    if (!showAdmin) tasks = tasks.filter(task => !isAdmin(task));
    if (phaseFilter === '__unassigned') tasks = tasks.filter(task => !phaseOf(task));
    else if (phaseFilter) tasks = tasks.filter(task => phaseOf(task)?.id === phaseFilter);
    const query = taskSearch.trim().toLowerCase();
    if (query) {
      tasks = tasks.filter(task => [task.taskId, task.goal, (task.acceptanceCriteria || []).join(' '), phaseName(task)]
        .join(' ').toLowerCase().includes(query));
    }
    return tasks;
  }

  function columns() {
    const container = $('#task-columns');
    if (!container || !data) return;
    const tasks = filteredTasks();
    const countNode = $('#task-result-count');
    if (countNode) countNode.textContent = `显示 ${tasks.length} 项${showAdmin ? '（含辅助）' : ''}`;
    if (!tasks.length) {
      const allEmpty = (data.tasks || []).length === 0;
      container.innerHTML = emptyState(
        allEmpty ? '这个项目还没有任务' : '没有匹配的任务',
        allEmpty ? '直接从第一项要做的事情开始。完成条件稍后也可以补充。' : '可以调整搜索词、阶段筛选，或显示辅助任务。',
        allEmpty ? button('＋ 新增第一项任务', 'new-task', disabled(), 'primary') : button('清除筛选', 'clear-task-filters', '', 'quiet')
      );
      return;
    }
    if (taskLayout === 'list') {
      container.innerHTML = `<div class="task-list">${tasks.map(task => `<button class="task-row task-${esc(task.status)}" type="button" data-action="edit-task" data-id="${esc(task.taskId)}" title="${esc(task.goal)}">
        <span class="task-id">${esc(task.taskId)}</span>
        <span class="task-main"><strong>${esc(task.goal)}</strong><small>${esc(phaseName(task))}${isAdmin(task) ? ' · <span class="task-admin">辅助任务</span>' : ''}</small></span>
        <span class="task-cond"><b>${task.acceptanceCriteria?.length || 0}</b> 条条件</span>
        <span class="task-owner">${esc(ownerName(task))}</span>
        <span class="task-status">${pill(task.status)}</span>
        <span class="task-arrow" aria-hidden="true">↗</span>
      </button>`).join('')}</div>`;
      return;
    }
    container.innerHTML = `<div class="kanban">${['pending', 'running', 'completed'].map(status => {
      const list = tasks.filter(task => task.status === status);
      return `<section class="column"><div class="column-heading"><span class="status-dot ${status}"></span><strong>${names[status]}</strong><span class="count">${list.length}</span></div>${list.length ? list.map(task => `<button class="task-card" type="button" data-action="edit-task" data-id="${esc(task.taskId)}"><div class="task-top"><span>${esc(task.taskId)}</span><span class="task-tag">${esc(phaseName(task))}${isAdmin(task) ? ' · 辅助' : ''}</span></div><h3>${esc(task.goal)}</h3><div class="meta"><span>${task.acceptanceCriteria?.length || 0} 条完成条件</span><span class="owner">${esc(ownerName(task))}</span></div></button>`).join('') : '<div class="empty column-empty">这里还没有任务</div>'}</section>`;
    }).join('')}</div>`;
  }

  function evidenceText(item) {
    if (typeof item === 'string') return item;
    const proof = item?.proof;
    const value = typeof proof === 'string' ? proof : JSON.stringify(proof ?? '');
    return `${item?.criterion || '完成依据'}：${value}`;
  }

  function editTask(id) {
    const task = (data.tasks || []).find(item => item.taskId === id);
    if (!task) return;
    const own = !task.ownerAgent || task.ownerAgent === 'user';
    const locked = !editable() || !own || task.status === 'completed';
    let actions = button('关闭', 'close-editor', '', 'quiet');
    if (editable()) {
      if (task.status === 'completed') actions += button('重新打开', 'reopen-task-dialog', '', 'quiet');
      else if (!own) actions += button('收回任务', 'release-task-dialog', '', 'quiet');
      else {
        if (task.status === 'pending') actions += button('开始任务', 'start-task', '', 'quiet');
        if (task.status === 'running') actions += button('退回待办', 'release-task-dialog', '', 'quiet');
        actions += button('登记完成', 'complete-task-dialog', '', 'quiet') + button('保存修改', 'save-task', '', 'primary');
      }
    }
    const completion = (task.completionEvidence || []).length
      ? '<div class="note-box"><strong>已登记完成依据</strong><br>' + (task.completionEvidence || []).map(item => esc(evidenceText(item))).join('<br><br>') + '</div>'
      : '';
    const phaseText = phaseOf(task) ? `阶段：${phaseOf(task).name}` : '未分阶段';
    openDialog(task.taskId, editable() ? '任务详情与修改' : '任务详情', `
      <div class="drawer-meta">${pill(task.status)}${isAdmin(task) ? '<span class="pill gray">辅助任务</span>' : ''}<small>${esc(phaseText)} · 承接者：${esc(ownerName(task))} · 任务第 ${task.version} 版</small></div>
      ${task.status === 'completed' ? '<div class="note-box">已完成任务保留验收记录。如需调整，请先重新打开并说明原因。</div>' : !own ? '<div class="note-box">此任务已有承接者。你可以查看；如需调整，请先收回任务并说明原因。</div>' : ''}
      ${field('任务说明', `<textarea id="task-goal" ${locked ? 'readonly' : ''}>${esc(task.goal)}</textarea>`)}
      ${field('完成条件', `<textarea class="criteria-area" id="task-criteria" ${locked ? 'readonly' : ''}>${esc((task.acceptanceCriteria || []).join('\n'))}</textarea>`, '每行一条，说明怎样判断这项任务完成。')}
      ${!locked ? field('修改说明（选填）', '<input id="task-reason" placeholder="这次调整的原因…">') : ''}
      ${completion}
    `, actions, { mode: 'task', task });
  }

  function taskInputChanged() {
    if (!dialogContext?.task || !$('#task-goal') || !$('#task-criteria')) return false;
    return $('#task-goal').value.trim() !== String(dialogContext.task.goal || '').trim()
      || JSON.stringify(lines($('#task-criteria').value)) !== JSON.stringify(dialogContext.task.acceptanceCriteria || []);
  }

  function needSaved() {
    if (taskInputChanged()) {
      toast('先保存任务说明与完成条件，再推进状态。', true);
      return false;
    }
    return true;
  }

  function openCompletion() {
    if (!needSaved()) return;
    const task = dialogContext.task;
    const criteria = task.acceptanceCriteria || [];
    if (!criteria.length) {
      formError('这项任务还没有完成条件。请先补充至少一条，再登记完成。');
      return;
    }
    openDialog(task.taskId, '登记任务完成', `
      <div class="note-box">请为每条条件填写实际产物位置、测得结果或核验说明。保存后任务才会记为完成，记录会进入历史。</div>
      ${criteria.map((criterion, index) => `<label class="evidence-item"><strong>${index + 1}. ${esc(criterion)}</strong><textarea data-proof="${index}" aria-label="第 ${index + 1} 条完成依据" placeholder="实际产物、核验结果或可复查位置…"></textarea></label>`).join('')}
    `, button('返回任务', 'back-task', '', 'quiet') + button('保存完成记录', 'confirm-complete', '', 'primary'), { mode: 'completion', task });
  }

  function reasonDialog(reopen = false) {
    if (!reopen && !needSaved()) return;
    const task = dialogContext.task;
    openDialog(task.taskId, reopen ? '重新打开任务' : '退回待办 / 收回任务', `
      <div class="note-box">${reopen ? '之前的完成记录会保留在历史中。重新打开后，任务回到待办。' : '任务将回到未领取状态，承接关系与原因会保留在历史中。'}</div>
      ${field('原因', '<textarea id="action-reason" placeholder="请说明这次调整的原因…"></textarea>', '收回别人的任务或重新打开已完成任务时，必须写明原因。')}
    `, button('返回任务', 'back-task', '', 'quiet') + button(reopen ? '重新打开' : '确认退回待办', reopen ? 'confirm-reopen' : 'confirm-release', '', 'primary'), { mode: 'reason', task });
  }

  function newTask() {
    openDialog('新增工作 / TASK', '新增任务', `
      ${field('任务编号', `<input id="new-task-id" value="${esc(nextTaskId())}" autocomplete="off">`, `默认使用当前项目的编号前缀「${taskPrefix()}」，可以修改，但不能与已有任务重复。`)}
      ${field('任务说明', '<textarea id="new-task-goal" placeholder="要完成什么？依赖哪些已有结果？"></textarea>')}
      ${field('完成条件', '<textarea class="criteria-area" id="new-task-criteria" placeholder="每行一条完成条件…"></textarea>', '至少写一条。完成后需要逐条填写依据。')}
    `, button('取消', 'close-editor', '', 'quiet') + button('创建任务', 'create-task', '', 'primary'), { mode: 'new-task' });
  }

  function createTask() {
    const taskId = $('#new-task-id').value.trim();
    const goal = $('#new-task-goal').value.trim();
    const criteria = lines($('#new-task-criteria').value);
    if (!taskId) { formError('请填写任务编号。'); return; }
    if (!goal) { formError('请填写任务说明。'); return; }
    if (!criteria.length) { formError('请至少填写一条完成条件。'); return; }
    if ((data.tasks || []).some(task => task.taskId === taskId)) { formError('这个任务编号已经存在，请换一个。'); return; }
    return performChange({ action: 'create-task', expectedRevision: dialogContext.revision, taskId, goal, acceptanceCriteria: criteria }, { key: dialogContext.key });
  }

  function taskBase() {
    return {
      expectedRevision: dialogContext.revision,
      expectedTaskVersion: dialogContext.task.version,
      taskId: dialogContext.task.taskId
    };
  }

  function decisionsPage() {
    const all = publicDecisions();
    if (!['all', 'proposed', 'accepted', 'invalidated'].includes(decisionFilter)) decisionFilter = 'all';
    const list = all.filter(item => decisionFilter === 'all' || item.status === decisionFilter);
    const counts = {
      all: all.length,
      proposed: all.filter(item => item.status === 'proposed').length,
      accepted: all.filter(item => item.status === 'accepted').length,
      invalidated: all.filter(item => item.status === 'invalidated').length
    };
    const meta = {
      proposed: { title: '待讨论', note: '方案与建议仍在讨论，未确认前不视为共同方向。' },
      accepted: { title: '已确认', note: '已经形成共识，并记录了依据或确认内容。' },
      invalidated: { title: '已撤销', note: '不再作为当前方向，但记录继续保留以便追溯。' }
    };
    const groups = decisionFilter === 'all' ? ['proposed', 'accepted', 'invalidated'] : [decisionFilter];
    const card = item => `<article class="decision-card" data-tone="${esc(item.status)}">${pill(item.status)}<h3>${esc(item.subject)}</h3><p>${esc(item.decision)}</p><div class="decision-foot"><span>更新于 ${esc(time(item.updatedAt))} · ${item.evidence?.length || 0} 条依据</span>${button('查看 / 修改', 'edit-decision', `data-id="${esc(item.decisionId)}"`, 'compact quiet')}</div></article>`;
    return heading('CONSENSUS / 03', '讨论与决定', '待讨论的建议与已确认的方向分开记录。只有确认并填写依据的内容，才会进入共同方向。', button('＋ 新增议题', 'new-decision', disabled(), 'primary')) + `
      <div class="toolbar">
        <div class="tabs">${[['all', '全部'], ['proposed', '待讨论'], ['accepted', '已确认'], ['invalidated', '已撤销']].map(([status, label]) => `<button type="button" data-action="decision-filter" data-id="${status}" class="${decisionFilter === status ? 'active' : ''}">${label}<b>${counts[status]}</b></button>`).join('')}</div>
        <span class="toolbar-note">共 ${list.length} 项议题${all.length ? '' : ' · 尚无议题'}</span>
      </div>
      ${all.length ? `<div class="decision-sections">${groups.map(status => {
        const items = list.filter(item => item.status === status);
        if (!items.length && decisionFilter !== 'all') return `<div class="empty">此分类暂无议题。切换到“全部”可查看其他内容。</div>`;
        if (!items.length) return '';
        return `<section class="decision-group" data-tone="${status}"><div class="group-head"><div class="group-title"><i></i><h2>${meta[status].title}</h2><b>${items.length}</b></div><p>${meta[status].note}</p></div><div class="decision-grid">${items.map(card).join('')}</div></section>`;
      }).join('')}</div>` : emptyState('还没有讨论议题', '把一个尚未确定的问题记下来，先标为待讨论；形成依据后再确认，避免把建议误当成结论。', button('＋ 记录第一个议题', 'new-decision', disabled(), 'primary'))}`;
  }

  function editDecision(id, preset = null) {
    const decision = id ? (data.decisions || []).find(item => item.decisionId === id) : null;
    const item = decision || preset || { subject: '', decision: '', evidence: [], status: 'proposed' };
    const evidence = (item.evidence || []).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n');
    openDialog(id || '共同讨论', id ? '查看与修改决定' : '新增议题', `
      ${field('议题', `<input id="decision-subject" value="${esc(item.subject)}" ${editable() ? '' : 'readonly'}>`)}
      ${field('内容', `<textarea class="criteria-area" id="decision-text" ${editable() ? '' : 'readonly'}>${esc(item.decision)}</textarea>`)}
      ${field('当前状态', `<select id="decision-status" ${editable() ? '' : 'disabled'}>${[['proposed', '待讨论 · 方案或建议'], ['accepted', '已确认 · 已形成结论'], ['invalidated', '已撤销 · 保留历史']].map(([status, label]) => `<option value="${status}" ${item.status === status ? 'selected' : ''}>${label}</option>`).join('')}</select>`, '“待讨论”不等于共同方向。确认前请补充依据或达成共识的内容。')}
      ${field('依据 / 原因', `<textarea id="decision-evidence" ${editable() ? '' : 'readonly'}>${esc(evidence)}</textarea>`, '每行一条。确认结论时至少填写一条。')}
    `, button('关闭', 'close-editor', '', 'quiet') + (editable() ? button('保存决定', 'save-decision', '', 'primary') : ''), { mode: 'decision', decisionId: id || null });
  }

  function saveDecision() {
    const subject = $('#decision-subject').value.trim();
    const decision = $('#decision-text').value.trim();
    const status = $('#decision-status').value;
    const evidence = lines($('#decision-evidence').value);
    if (!subject) { formError('请填写议题。'); return; }
    if (!decision) { formError('请填写议题内容。'); return; }
    if (status === 'accepted' && !evidence.length) {
      formError('确认结论前，请至少填写一条依据或达成共识的内容。');
      return;
    }
    return performChange({ action: 'save-decision', expectedRevision: dialogContext.revision, decisionId: dialogContext.decisionId, subject, decision, status, evidence }, { key: dialogContext.key });
  }

  function historicalCounts(revision) {
    const tasks = new Map();
    const decisions = new Map();
    const hidden = internalIds();
    const events = [...(data.events || [])].filter(event => Number(event.revision) <= revision).reverse();
    for (const event of events) {
      if (event.objectType === 'task') {
        if (event.type === 'task_created' || event.type === 'task_released' || event.type === 'task_reopened') tasks.set(event.objectId, 'pending');
        if (event.type === 'task_claimed') tasks.set(event.objectId, 'running');
        if (event.type === 'task_completed') tasks.set(event.objectId, 'completed');
        if (event.type === 'task_updated' && event.payload?.after?.status) tasks.set(event.objectId, event.payload.after.status);
      }
      if (event.objectType === 'decision' && !hidden.has(event.objectId) && event.payload?.status) {
        decisions.set(event.objectId, event.payload.status);
      }
    }
    return { total: tasks.size, completed: [...tasks.values()].filter(status => status === 'completed').length, decisions: decisions.size };
  }

  function eventTone(event) {
    if (['task_completed', 'decision_recorded'].includes(event.type) && event.payload?.status === 'accepted') return 'green';
    if (event.type === 'task_completed') return 'green';
    if (event.type === 'task_released' || event.type === 'task_reopened' || event.payload?.status === 'invalidated') return 'red';
    if (event.type === 'task_claimed' || event.payload?.status === 'proposed') return 'amber';
    if (event.type.includes('settings') || event.type.includes('rules') || event.type === 'project_created') return 'blue';
    return 'gray';
  }

  function settingsDiff(before, after) {
    const old = before || {};
    const next = after || {};
    const formatPhases = value => (Array.isArray(value) ? value : []).map(phase => `${phase.id || '—'} · ${phase.name || '未命名'}（${Array.isArray(phase.tasks) ? phase.tasks.length : 0} 项）`).join('\n') || '无阶段';
    const formatAdmins = value => (Array.isArray(value) ? value : []).join('、') || '无';
    return `<div class="diff settings-diff">
      <div><h4>修改前</h4><dl><dt>项目名称</dt><dd>${esc(old.name || '—')}</dd><dt>目标</dt><dd>${esc(old.goal || '—')}</dd><dt>简介</dt><dd>${esc(old.description || '—')}</dd><dt>编号前缀</dt><dd>${esc(old.taskPrefix || '—')}</dd></dl><pre>${esc(formatPhases(old.phases))}</pre><p class="diff-label">辅助任务：${esc(formatAdmins(old.administrativeTaskIds))}</p></div>
      <div><h4>修改后</h4><dl><dt>项目名称</dt><dd>${esc(next.name || '—')}</dd><dt>目标</dt><dd>${esc(next.goal || '—')}</dd><dt>简介</dt><dd>${esc(next.description || '—')}</dd><dt>编号前缀</dt><dd>${esc(next.taskPrefix || '—')}</dd></dl><pre>${esc(formatPhases(next.phases))}</pre><p class="diff-label">辅助任务：${esc(formatAdmins(next.administrativeTaskIds))}</p></div>
    </div>`;
  }

  function eventDetail(event) {
    const payload = event.payload || {};
    if (payload.before && payload.after && (event.type.includes('settings') || payload.after.phases || payload.after.taskPrefix)) return settingsDiff(payload.before, payload.after);
    if (payload.before && payload.after) {
      const render = value => {
        if (!value || typeof value !== 'object') return `<p>${esc(value || '—')}</p>`;
        return `<p><strong>${esc(value.goal || '任务')}</strong></p>${value.acceptanceCriteria ? '<ul>' + value.acceptanceCriteria.map(item => `<li>${esc(item)}</li>`).join('') + '</ul>' : ''}<span class="pill ${value.status === 'completed' ? 'green' : value.status === 'running' ? 'amber' : ''}">${esc(names[value.status] || value.status || '—')}</span>`;
      };
      return `<div class="diff"><div><h4>修改前</h4>${render(payload.before)}</div><div><h4>修改后</h4>${render(payload.after)}</div></div>${payload.reason ? `<p>修改原因：${esc(payload.reason)}</p>` : ''}`;
    }
    if (event.type.startsWith('decision_')) {
      return `<p>${esc(payload.decision || '')}</p><p class="muted">依据 / 原因：</p><ul>${(payload.evidence || []).map(item => `<li>${esc(typeof item === 'string' ? item : JSON.stringify(item))}</li>`).join('') || '<li>尚未填写</li>'}</ul>`;
    }
    if (event.type === 'task_completed') return (payload.evidence || []).map(item => `<p><strong>${esc(typeof item === 'string' ? '完成依据' : item.criterion)}</strong><br>${esc(typeof item === 'string' ? item : typeof item.proof === 'string' ? item.proof : JSON.stringify(item.proof))}</p>`).join('') || '<p class="muted">没有可显示的完成依据。</p>';
    if (event.type === 'task_created') return `<p>${esc(payload.goal || '')}</p><ul>${(payload.acceptanceCriteria || []).map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
    if (event.type === 'task_released' || event.type === 'task_reopened') return `<p>${esc(payload.reason || '没有填写原因')}</p>`;
    if (event.type === 'project_created') return `<p>项目：${esc(payload.name || payload.projectName || event.objectId || '')}</p>${payload.workspaceRoot ? `<p class="muted">位置：${esc(payload.workspaceRoot)}</p>` : ''}`;
    if (event.type.includes('rules')) return `<pre>${esc(payload.rules || payload.after || JSON.stringify(payload, null, 2))}</pre>`;
    if (payload && Object.keys(payload).length) return `<pre>${esc(JSON.stringify(payload, null, 2))}</pre>`;
    return '<p class="muted">这一事件没有附加详情。</p>';
  }

  function historyPage() {
    const maximum = Math.max(1, Number(data.revision) || 1);
    const revision = Math.min(maximum, Math.max(1, historyRevision ?? (Number(data.revision) || 1)));
    const counts = historicalCounts(revision);
    const list = [...(data.events || [])]
      .filter(event => Number(event.revision) <= revision)
      .sort((a, b) => (Number(b.revision) - Number(a.revision)) || (new Date(b.createdAt) - new Date(a.createdAt)));
    return heading('TRACE / 04', '历史记录', '拖动时间线查看当时的任务与决定数量；展开事件可以看到修改前后与完成依据。', button('回到最新', 'history-latest', '', 'quiet'))
      + `<section class="panel history-controls">
        <div><strong id="history-version">第 ${revision} 版 ${revision === Number(data.revision) ? '· 当前最新' : '· 历史状态'}</strong><input id="history-slider" type="range" min="1" max="${maximum}" value="${revision}" aria-label="查看历史版本" ${maximum === 1 ? 'disabled' : ''}><div class="intro-row"><span>首次登记</span><span>第 ${Number(data.revision) || 0} 版</span></div></div>
        <div class="history-stats"><span><b>${counts.total}</b>当时任务</span><span><b>${counts.completed}</b>已完成</span><span><b>${counts.decisions}</b>决定</span></div>
      </section>
      <div class="history-list">${list.length ? list.map(event => {
        const tone = eventTone(event);
        const mark = { green: '✓', amber: '·', red: '↺', blue: '◆', gray: '—' }[tone] || '·';
        const objectLabel = event.objectType === 'artifact' ? String(event.objectId || '').split(/[\\/]/).pop() : event.objectId;
        return `<details class="event event-${tone}"><summary><div class="event-head"><span class="event-badge" aria-hidden="true">${mark}</span><span class="pill">第 ${event.revision ?? '—'} 版</span><strong>${esc(types[event.type] || event.type)}</strong><time>${esc(time(event.createdAt))}</time></div><p class="event-summary">${esc(summary(event))}</p></summary><div class="event-detail"><p class="muted">操作者：${esc(event.actorId === 'user' ? '我（用户）' : event.actorId || '未注明')} · 对象：${esc(objectLabel || '—')}</p>${eventDetail(event)}</div></details>`;
      }).join('') : emptyState('还没有历史事件', '任务、讨论或项目设置的第一次保存会在这里留下记录。')}</div>`;
  }

  function cloneSettings() {
    const source = settings();
    const sourcePhases = Array.isArray(source.phases) ? source.phases : (Array.isArray(data?.phases) ? data.phases : []);
    const adminIds = new Set(Array.isArray(source.administrativeTaskIds) ? source.administrativeTaskIds : []);
    for (const task of data?.tasks || []) if (isAdmin(task)) adminIds.add(task.taskId);
    return {
      name: source.name || data?.project?.name || '',
      description: source.description ?? data?.project?.description ?? '',
      goal: source.goal ?? data?.project?.goal ?? '',
      taskPrefix: source.taskPrefix || 'TASK-',
      phases: sourcePhases.map(phase => ({
        id: String(phase.id || '').trim(),
        name: String(phase.name || '').trim(),
        text: String(phase.text || ''),
        tasks: [...new Set((Array.isArray(phase.tasks) ? phase.tasks : []).map(String))]
      })),
      administrativeTaskIds: [...adminIds]
    };
  }

  function ensureSettingsDraft() {
    if (!settingsDraft) {
      settingsDraft = cloneSettings();
      if (!settingsDirty) settingsRevision = data?.revision ?? null;
    }
    return settingsDraft;
  }

  function currentSettingsDraft() {
    return settingsDraft || cloneSettings();
  }

  function draftPhaseOf(taskId) {
    return currentSettingsDraft().phases.find(phase => phase.tasks.includes(taskId)) || null;
  }

  function updateSettingsDirtyUI() {
    $$('[data-settings-state]').forEach(node => {
      node.textContent = settingsDirty ? '有未保存的修改' : '所有设置已保存';
      node.classList.toggle('dirty', settingsDirty);
    });
    $$('[data-action="save-settings"]').forEach(node => {
      if (settingsDirty) node.classList.add('has-changes');
      else node.classList.remove('has-changes');
    });
  }

  function markSettingsDirty() {
    settingsDirty = true;
    updateSettingsDirtyUI();
    syncSettingsDerivedUI();
  }

  function syncSettingsDerivedUI() {
    if (view !== 'settings' || !settingsDraft) return;
    const draft = settingsDraft;
    const labels = new Map(draft.phases.map(phase => [phase.id, phase.name || phase.id]));
    $$('select[data-task-phase]').forEach(select => {
      Array.from(select.options).forEach(option => { if (option.value && labels.has(option.value)) option.textContent = labels.get(option.value); });
    });
    $$('.phase-edit-card[data-phase-index]').forEach(card => {
      const phase = draft.phases[Number(card.dataset.phaseIndex)];
      if (!phase) return;
      const count = phase.tasks.length;
      const counter = card.querySelector('.phase-count');
      const detail = card.querySelector('.phase-count-box');
      if (counter) counter.textContent = `${count} 项任务`;
      if (detail) detail.textContent = count ? `${count} 项任务已归入此阶段` : '还没有任务归入';
      card.querySelector('[data-action="remove-phase"]')?.setAttribute('aria-label', `删除阶段 ${phase.name || phase.id}`);
    });
    const projectTitle = $('.project-facts h3');
    if (projectTitle) projectTitle.textContent = draft.name.trim() || '未命名项目';
    const prefixHelp = $('#setting-prefix')?.parentElement.querySelector('small');
    if (prefixHelp) prefixHelp.textContent = `新建任务会使用「${draft.taskPrefix || 'TASK-'}」作为编号前缀。`;
    const counters = $$('.project-facts dd');
    if (counters.length >= 4) {
      counters[2].textContent = `${draft.phases.reduce((sum,p)=>sum+p.tasks.length,0)} 项`;
      counters[3].textContent = `${draft.administrativeTaskIds.length} 项`;
    }
  }

  function nextPhaseId() {
    const used = new Set(currentSettingsDraft().phases.map(phase => phase.id));
    let number = 1;
    while (used.has('P' + number)) number += 1;
    return 'P' + number;
  }

  function settingsPage() {
    if (!settingsDirty) settingsRevision = data.revision;
    const draft = ensureSettingsDraft();
    const taskList = data.tasks || [];
    const phaseCards = draft.phases.map((phase, index) => {
      const count = phase.tasks.length;
      return `<article class="phase-edit-card" data-phase-index="${index}">
        <div class="phase-edit-head"><span class="phase-id">${esc(phase.id || '阶段')}</span><span class="phase-count">${count} 项任务</span><button class="icon-button phase-remove" type="button" data-action="remove-phase" data-id="${index}" aria-label="删除阶段 ${esc(phase.name || phase.id)}">×</button></div>
        <div class="settings-grid">
          <label class="field"><span>阶段名称</span><input data-phase-field="name" data-phase-index="${index}" value="${esc(phase.name)}" placeholder="例如：资料核查"></label>
          <label class="field"><span>任务归属</span><div class="phase-count-box">${count ? `${count} 项任务已归入此阶段` : '还没有任务归入'}</div></label>
          <label class="field settings-wide"><span>阶段说明</span><textarea data-phase-field="text" data-phase-index="${index}" placeholder="说明这个阶段的完成边界；可以留空。">${esc(phase.text)}</textarea></label>
        </div>
      </article>`;
    }).join('');

    const assignmentRows = taskList.length ? taskList.map(task => {
      const assigned = draftPhaseOf(task.taskId);
      const adminChecked = draft.administrativeTaskIds.includes(task.taskId);
      return `<div class="assign-row">
        <div class="assign-task"><span class="task-id">${esc(task.taskId)}</span><span><strong>${esc(task.goal)}</strong><small>${esc(names[task.status] || task.status)} · ${esc(ownerName(task))}</small></span></div>
        <label class="admin-check" title="辅助任务不计入实施进度"><input type="checkbox" data-admin-task="${esc(task.taskId)}" ${adminChecked ? 'checked' : ''}> 辅助</label>
        <select data-task-phase="${esc(task.taskId)}" aria-label="${esc(task.taskId)} 的阶段归属"><option value="">未分阶段</option>${draft.phases.map(phase => `<option value="${esc(phase.id)}" ${assigned?.id === phase.id ? 'selected' : ''}>${esc(phase.name || phase.id)}</option>`).join('')}</select>
      </div>`;
    }).join('') : `<div class="settings-empty"><span class="empty-symbol" aria-hidden="true">—</span><div><h3>还没有任务</h3><p>先保存项目资料，然后去任务页新增任务；任务归属会在这里出现。</p></div>${button('去新增任务', 'goto-tasks', '', 'quiet compact')}</div>`;

    const name = draft.name.trim();
    const prefix = draft.taskPrefix.trim();
    return heading('SETTINGS / 06', '项目设置', '项目名称、目标、阶段与任务归属都在这里维护。阶段可以留空，保存后会进入历史记录。') + `
      <div class="settings-layout">
        <div class="settings-main">
          <section class="panel settings-panel">
            <div class="section-header"><h2>项目资料</h2><span>显示在首页、侧栏与总览</span></div>
            <div class="settings-grid">
              <label class="field settings-wide"><span>项目名称</span><input id="setting-name" value="${esc(draft.name)}" maxlength="120" placeholder="例如：毕业设计项目"></label>
              <label class="field settings-wide"><span>项目目标</span><textarea id="setting-goal" placeholder="这个项目最终要解决什么？">${esc(draft.goal)}</textarea></label>
              <label class="field settings-wide"><span>项目简介</span><textarea id="setting-description" placeholder="说明对象、范围与协作方式；可以留空。">${esc(draft.description)}</textarea></label>
              <label class="field"><span>任务编号前缀</span><input id="setting-prefix" value="${esc(draft.taskPrefix)}" maxlength="24" placeholder="TASK-"><small>新建任务会从「${esc(prefix || 'TASK-')}01」开始自动编号。</small></label>
            </div>
          </section>

          <section class="panel settings-panel">
            <div class="section-header settings-section-head"><div><h2>项目阶段</h2><span>${draft.phases.length ? `${draft.phases.length} 个阶段` : '可以留空'}</span></div>${button('＋ 新增阶段', 'add-phase', '', 'quiet compact')}</div>
            ${draft.phases.length ? `<div class="phase-editor">${phaseCards}</div>` : `<div class="settings-empty"><span class="empty-symbol" aria-hidden="true">—</span><div><h3>还没有阶段</h3><p>阶段不是必需项。你可以按自己的项目方法添加，也可以只管理任务。</p></div>${button('添加第一个阶段', 'add-phase', '', 'quiet compact')}</div>`}
          </section>

          <section class="panel settings-panel">
            <div class="section-header"><h2>任务归属与类型</h2><span>每项任务可选择一个阶段</span></div>
            ${assignmentRows}
            ${taskList.length ? '<p class="settings-help">辅助任务不计入实施进度与下一步建议，但仍可在任务页查看、搜索和追溯。删除阶段不会删除任务。</p>' : ''}
          </section>

          <div class="settings-actions panel">
            <div id="settings-error" class="inline-error" role="alert" hidden></div>
            <div class="settings-save-row"><span data-settings-state class="${settingsDirty ? 'dirty' : ''}">${settingsDirty ? '有未保存的修改' : '所有设置已保存'}</span>${button('保存设置', 'save-settings', disabled(), 'primary')}</div>
          </div>
        </div>
        <aside class="settings-side">
          <section class="panel project-facts">
            <div class="eyebrow">CURRENT PROJECT</div>
            <h3>${esc(name || '未命名项目')}</h3>
            <dl>
              <dt>项目文件夹</dt><dd class="path-value">${esc(data.project?.workspaceRoot || '—')}</dd>
              <dt>任务</dt><dd>${taskList.length} 项</dd>
              <dt>已分阶段</dt><dd>${taskList.filter(task => draftPhaseOf(task.taskId)).length} 项</dd>
              <dt>辅助任务</dt><dd>${draft.administrativeTaskIds.length} 项</dd>
            </dl>
            <div class="project-fact-actions">${button('打开项目文件夹', 'open-folder', '', 'quiet compact')}</div>
          </section>
          <section class="panel settings-help-card">
            <h3>修改如何生效</h3>
            <ul><li>输入不会自动保存；点击“保存设置”后才写入。</li><li>轮询刷新不会覆盖尚未保存的设置或约定。</li><li>保存失败会保留当前输入，可调整后重试。</li><li>阶段和辅助标记会进入历史，可追溯修改前后。</li></ul>
          </section>
        </aside>
      </div>`;
  }

  function markRulesDirty() {
    rulesDirty = true;
    $$('[data-rules-state]').forEach(node => {
      node.textContent = '有未保存的修改';
      node.classList.add('dirty');
    });
  }

  function handleSettingsInput(target) {
    const draft = ensureSettingsDraft();
    if (target.id === 'setting-name') draft.name = target.value;
    else if (target.id === 'setting-goal') draft.goal = target.value;
    else if (target.id === 'setting-description') draft.description = target.value;
    else if (target.id === 'setting-prefix') draft.taskPrefix = target.value;
    else if (target.dataset.phaseField) {
      const index = Number(target.dataset.phaseIndex);
      const phase = draft.phases[index];
      if (phase) phase[target.dataset.phaseField] = target.value;
    } else {
      return;
    }
    markSettingsDirty();
  }

  function assignTaskToPhase(taskId, phaseId) {
    const draft = ensureSettingsDraft();
    for (const phase of draft.phases) phase.tasks = phase.tasks.filter(id => id !== taskId);
    if (phaseId) draft.phases.find(phase => phase.id === phaseId)?.tasks.push(taskId);
    markSettingsDirty();
  }

  function toggleAdministrative(taskId, checked) {
    const draft = ensureSettingsDraft();
    const set = new Set(draft.administrativeTaskIds);
    if (checked) set.add(taskId);
    else set.delete(taskId);
    draft.administrativeTaskIds = [...set];
    markSettingsDirty();
  }

  function addPhase() {
    const draft = ensureSettingsDraft();
    draft.phases.push({ id: nextPhaseId(), name: '新阶段', text: '', tasks: [] });
    markSettingsDirty();
    render();
    const input = $(`[data-phase-field="name"][data-phase-index="${draft.phases.length - 1}"]`);
    input?.focus();
    input?.select();
  }

  function removePhase(index) {
    const draft = ensureSettingsDraft();
    const phase = draft.phases[index];
    if (!phase) return;
    if (!window.confirm(`删除阶段「${phase.name || phase.id}」？阶段内的任务不会被删除，会回到“未分阶段”。`)) return;
    draft.phases.splice(index, 1);
    markSettingsDirty();
    render();
  }

  function saveSettings() {
    const draft = ensureSettingsDraft();
    const name = draft.name.trim();
    const prefix = draft.taskPrefix.trim();
    const cleanedPhases = draft.phases.map((phase, index) => ({
      id: String(phase.id || nextPhaseId()).trim(),
      name: String(phase.name || '').trim(),
      text: String(phase.text || '').trim(),
      tasks: [...new Set((phase.tasks || []).filter(taskId => (data.tasks || []).some(task => task.taskId === taskId)))]
    }));
    if (!name) {
      formError('请填写项目名称。');
      $('#setting-name')?.focus();
      return;
    }
    if (!prefix) {
      formError('请填写任务编号前缀。');
      $('#setting-prefix')?.focus();
      return;
    }
    const emptyPhase = cleanedPhases.findIndex(phase => !phase.name);
    if (emptyPhase >= 0) {
      formError(`第 ${emptyPhase + 1} 个阶段还没有名称。`);
      $(`[data-phase-field="name"][data-phase-index="${emptyPhase}"]`)?.focus();
      return;
    }
    if (new Set(cleanedPhases.map(phase => phase.id)).size !== cleanedPhases.length) {
      formError('阶段标识发生重复，请刷新页面后重试。');
      return;
    }
    const seen = new Set();
    for (const phase of cleanedPhases) {
      phase.tasks = phase.tasks.filter(taskId => {
        if (seen.has(taskId)) return false;
        seen.add(taskId);
        return true;
      });
    }
    const settingsPayload = {
      name,
      description: String(draft.description || '').trim(),
      goal: String(draft.goal || '').trim(),
      taskPrefix: prefix,
      phases: cleanedPhases,
      administrativeTaskIds: [...new Set((draft.administrativeTaskIds || []).filter(taskId => (data.tasks || []).some(task => task.taskId === taskId)))]
    };
    const revision = settingsRevision ?? data.revision;
    return performChange({ action: 'save-settings', expectedRevision: revision, settings: settingsPayload }, {
      close: false,
      key: currentKey(),
      onSuccess(reply) {
        settingsDirty = false;
        settingsDraft = null;
        settingsRevision = reply.state?.revision ?? revision;
      }
    });
  }

  function saveRules() {
    if (!rulesRevision && rulesRevision !== 0) rulesRevision = data.revision;
    return performChange({ action: 'save-rules', expectedRevision: rulesRevision, rules: $('#rules-text').value }, {
      close: false,
      key: currentKey(),
      onSuccess(reply) {
        rulesDirty = false;
        rulesRevision = reply.state?.revision ?? rulesRevision;
      }
    });
  }

  function rulesPage() {
    if (!rulesDirty) rulesRevision = data.revision;
    return heading('AGREEMENT / 05', '登记原则', '左侧是可以共同修改的项目约定。右侧是工作台执行的数据保护规则，只读说明。') + `
      <div class="rules-layout">
        <section class="panel rules-editor">
          <div class="section-header"><h2>项目协作约定</h2><span>可修改 · 保存后保留历史</span></div>
          <label class="field"><span>共同约定</span><textarea id="rules-text" ${editable() ? '' : 'readonly'} placeholder="可以写下这个项目如何讨论、如何确认、如何验收。">${esc(data.rules || '')}</textarea><small>这段文字会共享给所有打开本项目的人。保存前请确认没有把待讨论建议写成结论。</small></label>
          <div class="rules-actions"><span data-rules-state class="${rulesDirty ? 'dirty' : 'muted'}">${rulesDirty ? '有未保存的修改' : '尚未修改'}</span>${button('保存约定', 'save-rules', disabled(), 'primary')}</div>
        </section>
        <aside class="panel system-rules">
          <h3>当前服务的保护规则</h3>
          <span class="pill gray">说明 · 此处不修改程序规则</span>
          <ul><li>保存前核对项目版本，避免覆盖别人的更新。</li><li>已被承接的任务保持占用；收回时说明原因。</li><li>完成任务需为全部条件填写实际依据。</li><li>任务、决定、设置与约定的变化保留历史。</li><li>保存前自动备份项目共享状态。</li><li>页面只连接这台电脑上的工作台服务。</li></ul>
          <p>登记成功表示记录已经保存，不等于项目结果已经通过真实性核验；仍须对照实际产物检查。</p>
        </aside>
      </div>`;
  }

  function render() {
    if (home || !data) {
      home = true;
      renderHome();
      return;
    }
    syncChrome();
    const renderers = { overview, tasks: tasksPage, decisions: decisionsPage, history: historyPage, rules: rulesPage, settings: settingsPage };
    if (!VIEWS.includes(view)) view = 'overview';
    $('#breadcrumb-current').textContent = VIEW_LABELS[view];
    $('#content').innerHTML = renderers[view]();
    if (view === 'tasks') columns();
    if (view === 'settings') updateSettingsDirtyUI();
  }

  function goto(next) {
    if (!VIEWS.includes(next) || !data) return;
    if (next === view) {
      updateUrl();
      return;
    }
    if (!confirmLeave()) return;
    if (rulesDirty || settingsDirty) {
      rulesDirty = false;
      settingsDirty = false;
      settingsDraft = null;
    }
    if (view === 'settings' && !settingsDirty) settingsDraft = null;
    if ($('#editor').open) $('#editor').close();
    view = next;
    updateUrl();
    render();
    $('#content').focus({ preventScroll: true });
  }

  async function refresh(announce = false) {
    if (home) {
      await loadProjects({ silent: true });
      if (announce) toast(live ? '项目列表已刷新' : (homeError || '无法连接本机服务'), !live);
      return;
    }
    if (!projectKey || busy) return;
    const key = projectKey;
    try {
      const latest = await stateRequest(key);
      if (key !== projectKey) return;
      if (latest?.needProject) throw new Error('这个项目已经无法读取，请返回全域项目重新选择。');
      const changed = !data || latest.revision !== data.revision || !live || Boolean(sourceError);
      sourceError = '';
      data = latest;
      viewMode(latest.readOnly);
      live = true;
      if (!rulesDirty) rulesRevision = data.revision;
      if (!settingsDirty) {
        settingsRevision = data.revision;
        if (view === 'settings') settingsDraft = null;
      }
      if (rulesDirty || settingsDirty) {
        connection();
        if (announce) toast('已读取最新状态；你尚未保存的修改仍保留。');
        return;
      }
      if (changed) render();
      else connection();
      if (announce) toast('已读取最新共享状态。');
    } catch (error) {
      if (error.code === 'SOURCE_UNAVAILABLE') {
        sourceError = `当前项目来源暂未连接。${error.message} Windows 项目仍可从全域项目中打开。`;
        live = true;
        if (!rulesDirty && !settingsDirty && !$('#editor').open) render();
      } else if (!error.httpStatus) live = false;
      connection();
      if (announce) toast(error.message, true);
    }
  }

  async function handleAction(name, id) {
    switch (name) {
      case 'go-home': return goHome();
      case 'filter-source': homeSourceFilter = ['all','windows','wsl'].includes(id) ? id : 'all'; return renderHome();
      case 'enter-folder-path': return openDialog('打开项目 / FOLDER','输入项目文件夹路径',field('文件夹完整路径','<input id="folder-path-input" autocomplete="off" placeholder="/home/用户名/项目">','Windows 与已连接的 WSL 路径均可。'),button('取消','close-editor','','quiet')+button('读取文件夹','probe-folder-path','','primary'),{mode:'folder-path'});
      case 'probe-folder-path': {
        const path = $('#folder-path-input')?.value.trim();
        if (!path) return formError('请填写文件夹完整路径。');
        setBusy(true);
        try { await probeFolder(path,'open'); } finally { setBusy(false); }
        return;
      }
      case 'open-existing-folder': return pickFolder('open');
      case 'new-project': return pickFolder('new');
      case 'reload-projects': return loadProjects();
      case 'switch-project': return switchToProject(id);
      case 'open-folder':
      case 'open-folder-home': return openFolder(id || currentKey());
      case 'open-state-folder':
      case 'open-program-folder': return openEnvironmentFolder(name,id);
      case 'choose-project': return chooseProject(id);
      case 'pick-other': {
        if (!confirmLeave('换一个文件夹会关闭当前窗口，已填写的内容会丢失。继续吗？')) return;
        const intent = dialogContext?.intent || 'open';
        if ($('#editor').open) $('#editor').close();
        return pickFolder(intent);
      }
      case 'create-project': return createProject();
      case 'open-existing-reply': {
        const reply = dialogContext?.reply;
        if (reply?.state) {
          receiveState(reply.state, reply.projectKey, { fresh: true, resetView: true });
          toast(`已打开「${projectName()}」`);
        } else if (reply?.projectKey) await switchToProject(reply.projectKey);
        return;
      }
      case 'goto-tasks': return goto('tasks');
      case 'goto-history': return goto('history');
      case 'goto-settings': return goto('settings');
      case 'phase': phaseFilter = id; return goto('tasks');
      case 'new-task': return newTask();
      case 'task-layout': taskLayout = id; return render();
      case 'clear-task-filters': taskSearch = ''; phaseFilter = ''; showAdmin = false; return render();
      case 'edit-task': return editTask(id);
      case 'close-editor':
        if (!confirmLeave('编辑窗口里有尚未保存的输入。关闭后会丢失，继续吗？')) return;
        return $('#editor').close();
      case 'back-task':
        if (!confirmLeave('返回任务详情会放弃这里已填写的内容。继续吗？')) return;
        return editTask(dialogContext?.task?.taskId);
      case 'save-task': {
        const goal = $('#task-goal').value.trim();
        const criteria = lines($('#task-criteria').value);
        if (!goal) { formError('请填写任务说明。'); return; }
        if (!criteria.length) { formError('请至少填写一条完成条件。'); return; }
        return performChange({ ...taskBase(), action: 'update-task', goal, acceptanceCriteria: criteria, reason: $('#task-reason')?.value || '' }, { key: dialogContext.key });
      }
      case 'create-task': return createTask();
      case 'start-task':
        if (!needSaved()) return;
        return performChange({ ...taskBase(), action: 'start-task' }, { key: dialogContext.key });
      case 'complete-task-dialog': return openCompletion();
      case 'release-task-dialog': return reasonDialog(false);
      case 'reopen-task-dialog': return reasonDialog(true);
      case 'confirm-release':
      case 'confirm-reopen': {
        const reason = $('#action-reason')?.value.trim() || '';
        if (!reason) { formError('请说明这次调整的原因。'); $('#action-reason')?.focus(); return; }
        if (name === 'confirm-release') return performChange({ ...taskBase(), action: 'release-task', reason, force: dialogContext.task.ownerAgent !== 'user' }, { key: dialogContext.key });
        return performChange({ ...taskBase(), action: 'reopen-task', reason }, { key: dialogContext.key });
      }
      case 'confirm-complete': {
        const evidence = (dialogContext?.task?.acceptanceCriteria || []).map((criterion, index) => ({
          criterion,
          proof: $(`[data-proof="${index}"]`)?.value.trim() || ''
        }));
        if (evidence.some(item => !item.proof)) {
          formError('请为每条完成条件填写实际产物、核验结果或可复查位置。');
          return;
        }
        return performChange({ ...taskBase(), action: 'complete-task', evidence }, { key: dialogContext.key });
      }
      case 'new-decision': return editDecision(null);
      case 'edit-decision': return editDecision(id);
      case 'decision-filter': decisionFilter = id; return render();
      case 'save-decision': return saveDecision();
      case 'history-latest': historyRevision = null; return render();
      case 'save-rules': return saveRules();
      case 'add-phase': return addPhase();
      case 'remove-phase': return removePhase(Number(id));
      case 'save-settings': return saveSettings();
      default: return undefined;
    }
  }

  document.addEventListener('click', event => {
    const nav = event.target.closest('[data-view]');
    if (nav) {
      goto(nav.dataset.view);
      return;
    }
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;
    Promise.resolve(handleAction(target.dataset.action, target.dataset.id)).catch(error => toast(error.message, true));
  });

  document.addEventListener('input', event => {
    const target = event.target;
    if (target.id === 'task-search') {
      taskSearch = target.value;
      columns();
    } else if (target.id === 'history-slider') {
      historyRevision = Number(target.value);
      render();
      requestAnimationFrame(() => $('#history-slider')?.focus());
    } else if (target.id === 'rules-text') {
      markRulesDirty();
    } else if (['setting-name', 'setting-goal', 'setting-description', 'setting-prefix'].includes(target.id) || target.dataset.phaseField) {
      handleSettingsInput(target);
    }
  });

  document.addEventListener('change', event => {
    const target = event.target;
    if (target.id === 'phase-filter') {
      phaseFilter = target.value;
      columns();
    } else if (target.id === 'show-admin') {
      showAdmin = target.checked;
      columns();
    } else if (target.dataset.taskPhase) {
      assignTaskToPhase(target.dataset.taskPhase, target.value);
      render();
    } else if (target.dataset.adminTask) {
      toggleAdministrative(target.dataset.adminTask, target.checked);
      render();
    }
  });

  $('#editor-form').addEventListener('submit', event => event.preventDefault());
  $('#close-editor').addEventListener('click', () => {
    if (!confirmLeave('编辑窗口里有尚未保存的输入。关闭后会丢失，继续吗？')) return;
    $('#editor').close();
  });
  $('#editor').addEventListener('cancel', event => {
    if (editorHasPotentialChanges() && !window.confirm('编辑窗口里有尚未保存的输入。关闭后会丢失，继续吗？')) event.preventDefault();
  });
  $('#editor').addEventListener('close', () => { dialogContext = null; dialogBaseline = null; });
  $('#refresh').addEventListener('click', () => refresh(true));
  window.addEventListener('beforeunload', event => {
    if (rulesDirty || settingsDirty || editorHasPotentialChanges()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('hashchange', () => {
    if (home) return;
    const next = location.hash.slice(1);
    if (!VIEWS.includes(next) || next === view) return;
    if (!confirmLeave()) {
      history.replaceState(null, '', `?project=${encodeURIComponent(projectKey)}#${view}`);
      return;
    }
    rulesDirty = false;
    settingsDirty = false;
    settingsDraft = null;
    view = next;
    render();
  });

  function boot() {
    if (home) {
      renderHome();
      loadProjects();
      return;
    }
    syncChrome();
    $('#content').innerHTML = '<div class="loading">正在打开项目…</div>';
    (async () => {
      try {
        const reply = await stateRequest(projectKey);
        if (reply?.needProject) throw new Error('没有找到这个项目，请从“全域项目”重新选择。');
        receiveState(reply, reply.projectKey || projectKey, { fresh: true });
      } catch (error) {
        home = true;
        data = null;
        projectKey = null;
        view = 'overview';
        homeLoading = false;
        homeError = error.message;
        updateUrl();
        renderHome();
        toast(error.message, true);
      }
    })();
  }

  boot();
  setInterval(() => {
    if (!document.hidden) refresh(false);
  }, 15000);
})();
