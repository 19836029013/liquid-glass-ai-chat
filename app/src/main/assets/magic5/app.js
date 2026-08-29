(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const native = window.AndroidRemote || null;
  const state = { snapshot: {}, connected: false, connectionState: 'retrying', replying: false, composerExpanded: false, selectorKind: '', selectedPermission: 'workspace-write', selectedModel: { provider: 'opengo', model: 'hy3', reasoningEffort: '' }, selectedEffort: '', modelSelectionTouched: false, permissionSelectionTouched: false, events: [], chatLocalItems: [], sessionHistory: {}, historyWarmInFlight: false, historyWarmSessionId: '', renderedChat: { sessionId: '', keys: [] }, lastEventAt: 0, selectedChat: null, selectedProject: null, chatOrigin: 'home', pinnedIds: [], archivedIds: [], renamedTitles: {}, autoFollowChat: true, followResumeTimer: null, programmaticScrollUntil: 0, pendingImages: [] };
  let settings = { endpoint: '', token: '' };
  let toastTimer = null;
  let liveSocket = null;
  let updateMode = 'check';
  let updateTimer = null;

  // Keep this fallback in sync with deepseek-harness/settings.yaml. Native snapshots
  // may provide a richer catalog; the fallback keeps the browser simulator faithful.
  const DSH_MODEL_CATALOG = [{
    provider: 'opengo',
    providerName: 'open-go',
    models: [
      { id: 'kimi-k3' },
      { id: 'ox-alpha-free', reasoningEfforts: ['low', 'high', 'max'] },
      { id: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-flash-vision-exp', reasoningEfforts: ['off', 'low', 'medium', 'high'], supportsImage: true },
      { id: 'qwen3.8-max' },
      { id: 'hy3' },
      { id: 'gpt-5.6-luna' },
      { id: 'grok-4.5' },
    ],
  }];
  const DSH_PERMISSION_OPTIONS = [
    { value: 'workspace-write', name: '工作区写入', description: '在工作区中运行命令' },
    { value: 'danger-full-access', name: '完全访问', description: '完全访问计算机（风险较高）' },
  ];
  const EFFORT_NAMES = { off: '关闭', low: '低', medium: '中', high: '高', max: '最高' };

  const safeJson = (value, fallback = {}) => {
    try { return typeof value === 'string' ? JSON.parse(value) : (value || fallback); }
    catch (_) { return fallback; }
  };
  const readLocal = (key, fallback) => {
    try { return safeJson(window.localStorage?.getItem(key), fallback); }
    catch (_) { return fallback; }
  };
  const writeLocal = (key, value) => {
    try { window.localStorage?.setItem(key, JSON.stringify(value)); }
    catch (_) {}
  };
  state.pinnedIds = Array.isArray(readLocal('dsh.remote.pinnedIds', [])) ? readLocal('dsh.remote.pinnedIds', []) : [];
  state.archivedIds = Array.isArray(readLocal('dsh.remote.archivedIds', [])) ? readLocal('dsh.remote.archivedIds', []) : [];
  state.renamedTitles = readLocal('dsh.remote.renamedTitles', {});
  const text = (id, value, fallback = '—') => { $(id).textContent = value === undefined || value === null || value === '' ? fallback : String(value); };
  const showToast = (message) => {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
  };
  const stateName = (value) => ({ running: '正在工作', waiting: '等待处理', completed: '已完成', failed: '执行失败', idle: '等待 DSH' }[value] || value || '等待 DSH');
  const phaseName = (value) => ({ starting: '启动', thinking: '思考', tool: '工具', terminal: '命令', approval: '审批', completed: '完成', failed: '失败' }[value] || value || '—');
  const syncWebKeyboardInset = () => {
    const viewport = window.visualViewport;
    const inset = viewport ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)) : 0;
    document.documentElement.style.setProperty('--web-keyboard-bottom', `${inset}px`);
  };
  const keepComposerVisible = () => {
    if ($('dashboardView')?.hidden) return;
    const scroller = $('chatScroll');
    if (!scroller) return;
    requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }));
  };
  const keepSearchVisible = (input) => {
    syncWebKeyboardInset();
    window.setTimeout(() => input?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }), 180);
  };
  const isChatAtBottom = (scroller = $('chatScroll')) => Boolean(scroller) && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 30;
  const clearFollowResume = () => {
    clearTimeout(state.followResumeTimer);
    state.followResumeTimer = null;
  };
  const scheduleFollowResume = () => {
    clearFollowResume();
    state.followResumeTimer = setTimeout(() => {
      if (isChatAtBottom()) state.autoFollowChat = true;
    }, 2000);
  };
  const followChatProgress = (behavior = 'smooth') => {
    if (!state.autoFollowChat) return;
    requestAnimationFrame(() => {
      const scroller = $('chatScroll');
      if (!scroller || !state.autoFollowChat) return;
      state.programmaticScrollUntil = performance.now() + 520;
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    });
  };
  const activeChatSessionId = () => String(state.selectedChat?.id || state.snapshot?.session?.id || '');
  const eventTimestamp = (event, fallback = 0) => Number(event?.timestamp || event?.time || fallback || 0);
  const itemKey = (item, index) => String(item.id || `${item.kind || 'item'}:${item.seq ?? ''}:${item.timestamp ?? ''}:${index}`);
  const samePrefix = (whole, prefix) => prefix.every((value, index) => whole[index] === value);
  const sameSuffix = (whole, suffix) => suffix.every((value, index) => whole[whole.length - suffix.length + index] === value);
  const HISTORY_WARM_ITEM_TARGET = 360;
  let viewTransitionTimer = null;

  function requestSessionHistory(sessionId, { beforeSeq, limit = 72 } = {}) {
    const id = String(sessionId || '');
    if (!id || !liveSocketOpen()) return false;
    const history = state.sessionHistory[id] || { items: [], hasMore: true, nextBefore: null, loading: false, lastTimestamp: 0 };
    if (history.loading || (beforeSeq !== undefined && !history.hasMore)) return false;
    history.loading = true;
    state.sessionHistory[id] = history;
    const sent = sendLiveMessage('session.history.request', { sessionId: id, beforeSeq, limit });
    if (!sent) history.loading = false;
    return sent;
  }

  function warmRecentHistories() {
    if (state.historyWarmInFlight || !liveSocketOpen()) return false;
    const uniqueIds = new Set();
    const candidates = [
      state.snapshot?.session?.id,
      ...(Array.isArray(state.snapshot?.recent) ? state.snapshot.recent.map((item) => item?.id) : []),
    ].map((value) => String(value || '')).filter((id) => id && !uniqueIds.has(id) && (uniqueIds.add(id) || true));
    for (const sessionId of candidates) {
      const history = state.sessionHistory[sessionId] || { items: [], hasMore: true, nextBefore: null, loading: false, lastTimestamp: 0 };
      if (history.loading || !history.hasMore || history.items.length >= HISTORY_WARM_ITEM_TARGET) continue;
      const beforeSeq = history.items.length ? history.nextBefore : undefined;
      if (history.items.length && beforeSeq === null) continue;
      state.historyWarmInFlight = true;
      state.historyWarmSessionId = sessionId;
      const requested = requestSessionHistory(sessionId, { beforeSeq, limit: 120 });
      if (!requested) {
        state.historyWarmInFlight = false;
        state.historyWarmSessionId = '';
      }
      return requested;
    }
    return false;
  }

  function requestOlderHistory() {
    const id = activeChatSessionId();
    const history = state.sessionHistory[id];
    if (history?.hasMore && !history.loading && history.nextBefore !== null) requestSessionHistory(id, { beforeSeq: history.nextBefore });
  }
  const eventName = (type) => ({
    'session.started': '会话启动', 'session.completed': '会话完成', 'session.failed': '会话失败',
    'agent.thinking': '思考摘要', 'tool.started': '工具开始', 'tool.completed': '工具完成',
    'terminal.started': '命令开始', 'terminal.output': '终端输出', 'terminal.completed': '命令完成',
    'file.changed': '文件变更', 'approval.required': '等待审批', 'approval.resolved': '审批处理',
    'assistant.message': '收到回复', 'progress.updated': '进度更新', status: '连接状态'
  }[type] || type || '事件');
  const eventDetail = (event) => {
    const d = event.data || {};
    return d.summary || d.label || d.command || d.text || d.message || d.path || d.title || d.detail || '';
  };

  const chatSeedItems = [
    { kind: 'bubble', text: 'ge":"Error from provider\n(Console Go): Upstream\nrequest failed: [1210] This\nmodel always engages in\nthinking and cannot be\ndisabled; please use low,\nhigh, or max"' },
    { kind: 'event', icon: 'chat-think.png', text: 'Diagnosing model thinking disable error' },
    { kind: 'note', text: '这个报错不是手机同步问题，而是当前模型被\nDSH 以“关闭思考”模式调用了；该模型强制要求\nlow / high / max 之一。我先定位 DSH 里对应\n的思考参数配置。' },
    { kind: 'event', icon: 'chat-terminal.png', text: '命令执行' },
    { kind: 'event', icon: 'chat-think.png', text: 'Adjusting model settings to low/high/\nmax' },
    { kind: 'event', icon: 'chat-terminal.png', text: '命令执行' },
    { kind: 'event', icon: 'chat-think.png', text: 'Investigating provider reasoning effort\nmapping' },
    { kind: 'event', icon: 'chat-terminal.png', text: '命令执行' },
  ];
  const shortHomeTitle = (value) => {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    return clean.length > 36 ? `${clean.slice(0, 35)}…` : clean;
  };
  const formatRecentTime = (value) => {
    const timestamp = Number(value || 0);
    if (!timestamp) return '—';
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1) return '现在';
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时`;
    const days = Math.floor(hours / 24);
    return days < 30 ? `${days}天` : `${Math.floor(days / 30)}个月`;
  };

  function renderHome() {
    const projectRoot = $('homeProjects');
    const recentRoot = $('homeRecent');
    if (!projectRoot || !recentRoot) return;
    const query = String($('homeSearch')?.value || '').trim().toLowerCase();
    const snapshot = state.snapshot || {};
    const session = snapshot.session || {};
    const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
    const recent = Array.isArray(snapshot.recent) ? snapshot.recent : [];
    const fallbackProject = snapshot.project?.name ? [{ id: snapshot.project.id || 'current', name: snapshot.project.name }] : [];
    const visibleProjects = projects.length ? projects : fallbackProject;
    const currentState = String(snapshot.state || '').toLowerCase();
    const deviceName = snapshot.device?.name || 'DSH Desktop';
    text('homeDevice', deviceName);
    text('drawerDevice', deviceName);
    const currentRecent = recent.length ? recent : (session.title ? [{ id: session.id, title: session.title, updatedAt: snapshot.updatedAt }] : []);

    projectRoot.replaceChildren();
    visibleProjects.filter((item) => !query || String(item.name || '').toLowerCase().includes(query)).forEach((item) => {
      const projectId = String(item.id || '');
      const row = document.createElement('button');
      row.className = 'home-row project-row';
      row.dataset.projectId = projectId;
      row.dataset.projectName = String(item.name || item.title || 'DSH');
      row.innerHTML = `<img class="home-row-icon" src="./icons/${item.asset || 'folder2.svg'}" alt=""><span class="home-row-title"></span>`;
      row.querySelector('.home-row-title').textContent = shortHomeTitle(row.dataset.projectName);
      projectRoot.append(row);
    });

    recentRoot.replaceChildren();
    const pinned = new Set((state.pinnedIds || []).map(String));
    const archived = new Set((state.archivedIds || []).map(String));
    const visibleRecent = currentRecent
      .filter((item) => !archived.has(String(item.id || '')))
      .sort((a, b) => Number(pinned.has(String(b.id || ''))) - Number(pinned.has(String(a.id || ''))));
    visibleRecent.filter((item) => {
      const itemId = String(item.id || '');
      const title = state.renamedTitles[itemId] || item.title || '';
      return !query || String(title).toLowerCase().includes(query);
    }).forEach((item, index) => {
      const row = document.createElement('button');
      row.className = 'home-row recent-row';
      row.dataset.recentIndex = String(index);
      row.dataset.sessionId = String(item.id || '');
      row.dataset.sessionTitle = String(state.renamedTitles[String(item.id || '')] || item.title || '未命名会话');
      row.innerHTML = '<span class="home-row-title"></span>';
      row.querySelector('.home-row-title').textContent = shortHomeTitle(row.dataset.sessionTitle);
      const active = state.connected && item.id && item.id === session.id && (currentState === 'running' || currentState === 'waiting');
      if (active) {
        const spinner = document.createElement('span');
        spinner.className = 'recent-spinner';
        spinner.setAttribute('aria-label', '正在同步');
        row.append(spinner);
      } else {
        const meta = document.createElement('span');
        meta.className = 'recent-meta';
        meta.append(document.createTextNode(formatRecentTime(item.updatedAt)));
        row.append(meta);
      }
      recentRoot.append(row);
    });
    $('homeDeviceDot')?.classList.toggle('offline', !state.connected);
  }

  function renderProject() {
    const selected = state.selectedProject;
    if (!selected) return;
    const snapshot = state.snapshot || {};
    const allRecent = Array.isArray(snapshot.recent) ? snapshot.recent : [];
    const session = snapshot.session || {};
    const fallback = session.title ? [{ id: session.id, title: session.title, projectId: snapshot.project?.id, projectName: snapshot.project?.name, updatedAt: snapshot.updatedAt }] : [];
    const recent = allRecent.length ? allRecent : fallback;
    const archived = new Set((state.archivedIds || []).map(String));
    const query = String($('projectSearch')?.value || '').trim().toLowerCase();
    const chats = recent
      .filter((item) => String(item.projectId || '') === String(selected.id || ''))
      .filter((item) => !archived.has(String(item.id || '')))
      .filter((item) => !query || String(state.renamedTitles[String(item.id || '')] || item.title || '').toLowerCase().includes(query));
    text('projectTitle', selected.name, '项目');
    text('projectDevice', snapshot.device?.name || 'DSH Desktop', 'DSH Desktop');
    text('projectConnection', state.connected ? '已连接' : (state.connectionState === 'retrying' ? '正在重试' : '未连接'));
    const root = $('projectChats');
    root.replaceChildren();
    chats.forEach((item) => {
      const row = document.createElement('button');
      const id = String(item.id || '');
      row.className = 'project-session-row';
      row.dataset.sessionId = id;
      row.dataset.sessionTitle = String(state.renamedTitles[id] || item.title || '未命名会话');
      row.dataset.projectId = String(selected.id || '');
      row.dataset.projectName = String(selected.name || 'DSH');
      row.innerHTML = '<span class="project-session-title"></span><span class="project-session-time"></span>';
      row.querySelector('.project-session-title').textContent = shortHomeTitle(row.dataset.sessionTitle);
      row.querySelector('.project-session-time').textContent = formatRecentTime(item.updatedAt);
      root.append(row);
    });
    text('projectEmpty', chats.length ? '没有更多线程' : (query ? '未找到相关会话' : '这个项目还没有可同步的会话'));
  }

  function setAppMode(mode) {
    document.body.classList.toggle('home-mode', mode === 'home');
    document.body.classList.toggle('project-mode', mode === 'project');
    document.body.classList.toggle('dashboard-mode', mode === 'dashboard');
  }

  function switchView(mode, { animate = true, direction } = {}) {
    const views = { home: $('homeView'), project: $('projectView'), dashboard: $('dashboardView') };
    const entering = views[mode];
    const leaving = Object.values(views).find((view) => view && view !== entering && !view.hidden);
    if (!entering) return;
    clearTimeout(viewTransitionTimer);
    Object.values(views).forEach((view) => view?.classList.remove('view-transition-layer', 'view-enter-forward', 'view-exit-forward', 'view-enter-back', 'view-exit-back'));
    if (!leaving || !animate || !entering.hidden) {
      entering.hidden = false;
      Object.values(views).forEach((view) => { if (view && view !== entering) view.hidden = true; });
      setAppMode(mode);
      return;
    }
    entering.hidden = false;
    leaving.hidden = false;
    setAppMode(mode);
    const forward = direction === undefined ? mode !== 'home' : Boolean(direction);
    entering.classList.add('view-transition-layer', forward ? 'view-enter-forward' : 'view-enter-back');
    leaving.classList.add('view-transition-layer', forward ? 'view-exit-forward' : 'view-exit-back');
    viewTransitionTimer = setTimeout(() => {
      leaving.hidden = true;
      Object.values(views).forEach((view) => view?.classList.remove('view-transition-layer', 'view-enter-forward', 'view-exit-forward', 'view-enter-back', 'view-exit-back'));
    }, 385);
  }

  function showHome(options) {
    closeChatMenu();
    setContextUsageOpen(false);
    closeNewChatPicker();
    switchView('home', options);
    renderHome();
  }

  function showDashboard(options) {
    switchView('dashboard', options);
    renderSnapshot();
  }

  function showProject(options) {
    switchView('project', options);
    renderProject();
  }

  function openChat({ id, title, projectId = '', projectName = '', origin = 'home' } = {}) {
    state.selectedChat = { id: String(id || ''), title: String(title || 'DSH Remote'), projectId: String(projectId || ''), projectName: String(projectName || 'DSH') };
    state.chatOrigin = origin;
    state.autoFollowChat = true;
    clearFollowResume();
    showDashboard();
    if (!state.sessionHistory[state.selectedChat.id]?.items?.length) requestSessionHistory(state.selectedChat.id, { limit: 120 });
  }

  function renderNewChatProjects() {
    const root = $('newChatProjectList');
    if (!root) return;
    const snapshotProjects = Array.isArray(state.snapshot?.projects) ? state.snapshot.projects : [];
    const projects = snapshotProjects.length ? snapshotProjects : [
      { id: 'new-chat-dsh', name: 'dsh插件', asset: 'folder2.svg' },
      { id: 'new-chat-dsapp', name: 'dsAPP', asset: 'folder2.svg' },
      { id: 'new-chat-pc', name: '电脑整理', asset: 'folder2.svg' },
    ];
    root.replaceChildren();
    projects.slice(0, 30).forEach((project) => {
      const row = document.createElement('button');
      row.className = 'new-chat-project-row';
      row.type = 'button';
      row.dataset.projectId = String(project.id || '');
      row.dataset.projectName = String(project.name || project.title || '项目');
      const icon = document.createElement('img');
      icon.src = `./icons/${project.asset || 'folder2.svg'}`;
      icon.alt = '';
      const label = document.createElement('span');
      label.textContent = row.dataset.projectName;
      row.append(icon, label);
      root.append(row);
    });
  }

  function closeNewChatPicker() {
    const layer = $('newChatLayer');
    if (layer) layer.hidden = true;
  }

  function openNewChatPicker() {
    closeChatMenu();
    setContextUsageOpen(false);
    closeAttachmentMenu();
    renderNewChatProjects();
    const list = $('newChatProjectList');
    if (list) list.hidden = false;
    $('newChatLayer').hidden = false;
  }

  function startDraftChat(projectId, projectName) {
    state.selectedChat = {
      id: `draft:${Date.now()}`,
      title: '新对话',
      projectId: String(projectId || ''),
      projectName: String(projectName || '新项目'),
    };
    state.chatOrigin = 'home';
    state.autoFollowChat = true;
    state.chatLocalItems = [];
    state.renderedChat = { sessionId: '', keys: [] };
    clearFollowResume();
    closeNewChatPicker();
    showDashboard();
    setTimeout(() => $('promptInput')?.focus(), 120);
  }

  function handleNewChatAction(action) {
    if (action === 'history') {
      const list = $('newChatProjectList');
      const button = document.querySelector('[data-new-chat-action="history"]');
      const hidden = Boolean(list?.hidden);
      if (list) list.hidden = !hidden;
      button?.setAttribute('aria-expanded', String(hidden));
      return;
    }
    if (action === 'new-project') {
      showToast('新建项目流程已预留，当前先完成界面设计');
    }
  }

  function liveChatItems() {
    const snapshot = state.snapshot || {};
    const sessionId = activeChatSessionId();
    const history = state.sessionHistory[sessionId];
    const items = [];
    const hasAssistantEvent = state.events.some((event) => String(event.sessionId || snapshot.session?.id || '') === sessionId && event.type === 'assistant.message');
    const timeOf = (value, fallback) => {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      const parsed = Date.parse(String(value || ''));
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    let sequence = 0;
    if (Array.isArray(history?.items)) {
      history.items.forEach((item, index) => {
        items.push({ ...item, timestamp: timeOf(item.timestamp, index + 1), sequence: sequence++ });
      });
    }
    const liveFloor = Number(history?.lastTimestamp || 0);
    if (!history?.items?.length && snapshot.lastMessage && !hasAssistantEvent && (!sessionId || sessionId === String(snapshot.session?.id || ''))) {
      items.push({ kind: 'note', text: String(snapshot.lastMessage), timestamp: timeOf(snapshot.updatedAt, 0), sequence: sequence++ });
    }
    state.events.forEach((event, index) => {
      const eventSessionId = String(event.sessionId || snapshot.session?.id || '');
      if (eventSessionId !== sessionId || eventTimestamp(event) <= liveFloor) return;
      const detail = eventDetail(event) || eventName(event.type);
      if (!detail) return;
      const item = event.type === 'assistant.message'
        ? { kind: 'note', text: detail }
        : { kind: 'event', icon: chatEventIcon(event), text: detail };
      items.push({ ...item, id: event.id || `live:${eventSessionId}:${eventTimestamp(event, index + 1)}:${index}`, timestamp: timeOf(eventTimestamp(event, index + 1), index + 1), sequence: sequence++ });
    });
    state.chatLocalItems.forEach((item, index) => {
      if (String(item.sessionId || '') !== sessionId) return;
      items.push({ ...item, timestamp: timeOf(item.timestamp, Date.now() + index), sequence: sequence++ });
    });
    return items.sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
  }

  function chatEventIcon(event) {
    const type = String(event?.type || '').toLowerCase();
    const data = event?.data || {};
    const tool = `${data.tool || ''} ${data.name || ''} ${data.label || ''}`.toLowerCase();
    if (type === 'agent.thinking' || type === 'progress.updated' || type.includes('thinking')) return 'chat-think.png';
    if (tool.includes('grep') || tool.includes('glob') || tool.includes('search')) return 'chat-grep.png';
    if (tool.includes('read') || tool.includes('file') || type.includes('file')) return 'chat-read.png';
    if (type.includes('terminal') || type.includes('command')) return 'chat-terminal.png';
    if (type.startsWith('tool.')) return 'chat-grep.png';
    return 'chat-think.png';
  }

  function chatItemElement(item) {
    if (item.kind === 'bubble') {
      const bubble = document.createElement('div');
      bubble.className = 'chat-user-bubble';
      if (item.text) bubble.append(document.createTextNode(String(item.text)));
      const images = Array.isArray(item.images) ? item.images : [];
      if (images.length) {
        const gallery = document.createElement('div');
        gallery.className = 'chat-message-images';
        images.forEach((image) => {
          const source = String(image?.dataUrl || image?.src || '');
          if (!source.startsWith('data:image/')) return;
          const img = document.createElement('img');
          img.src = source;
          img.alt = String(image?.name || '已发送图片');
          img.loading = 'lazy';
          gallery.append(img);
        });
        if (gallery.children.length) bubble.append(gallery);
      }
      return bubble;
    }
    if (item.kind === 'note') {
      const note = document.createElement('div');
      note.className = 'chat-note';
      note.textContent = item.text;
      return note;
    }
    const row = document.createElement('div');
    row.className = 'chat-event-row';
    row.innerHTML = `<img src="./icons/${item.icon}" alt=""><span class="chat-event-label"></span>`;
    row.querySelector('.chat-event-label').textContent = item.text;
    return row;
  }

  function renderChat() {
    const root = $('chatItems');
    if (!root) return;
    const project = state.snapshot?.project || {};
    const session = state.snapshot?.session || {};
    const selectedChat = state.selectedChat || {};
    const projectName = String(selectedChat.projectName || project.name || '').trim() || 'dsAPP';
    const chatTitle = selectedChat.title || state.renamedTitles[String(selectedChat.id || session.id || '')] || session.title || '确认编码是否消耗额度';
    text('chatTitle', chatTitle);
    text('chatMenuTitle', chatTitle, 'Remote DSH');
    text('chatProject', selectedChat.projectName || projectName);
    text('chatDevice', state.snapshot?.device?.name || 'DSH Desktop');
    renderConnection();
    const sessionId = activeChatSessionId();
    const items = liveChatItems();
    const keys = items.map(itemKey);
    const previous = state.renderedChat;
    const sameSession = previous.sessionId === sessionId;
    const scroller = $('chatScroll');
    if (sameSession && previous.keys.length === keys.length && samePrefix(keys, previous.keys)) return;
    if (sameSession && previous.keys.length && samePrefix(keys, previous.keys)) {
      const fragment = document.createDocumentFragment();
      items.slice(previous.keys.length).forEach((item) => fragment.append(chatItemElement(item)));
      root.append(fragment);
      state.renderedChat = { sessionId, keys };
      followChatProgress();
      return;
    }
    if (sameSession && previous.keys.length && sameSuffix(keys, previous.keys)) {
      const priorHeight = root.scrollHeight;
      const fragment = document.createDocumentFragment();
      items.slice(0, keys.length - previous.keys.length).forEach((item) => fragment.append(chatItemElement(item)));
      root.prepend(fragment);
      state.renderedChat = { sessionId, keys };
      if (scroller && !state.autoFollowChat) scroller.scrollTop += root.scrollHeight - priorHeight;
      else followChatProgress('auto');
      return;
    }
    root.replaceChildren(...items.map(chatItemElement));
    state.renderedChat = { sessionId, keys };
    followChatProgress('auto');
  }

  function normalizeWsEndpoint(endpoint, token) {
    let value = String(endpoint || '').trim();
    if (value.startsWith('http://')) value = `ws://${value.slice(7)}`;
    if (value.startsWith('https://')) value = `wss://${value.slice(8)}`;
    const url = new URL(value);
    if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
    else if (!url.pathname.endsWith('/ws')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
    if (token && !url.searchParams.has('token')) url.searchParams.set('token', token);
    return url.toString();
  }

  function liveSocketOpen() {
    return liveSocket && liveSocket.readyState === WebSocket.OPEN;
  }

  function sendLiveMessage(type, data = {}, raw = false) {
    if (!liveSocketOpen()) return false;
    const message = raw ? { type } : {
      version: 1,
      type,
      timestamp: Date.now(),
      sessionId: state.snapshot.session?.id || null,
      projectId: state.snapshot.project?.id || null,
      data,
    };
    try { liveSocket.send(JSON.stringify(message)); return true; }
    catch (_) { return false; }
  }

  function openLiveSocket(endpoint, token) {
    if (liveSocket) { try { liveSocket.close(); } catch (_) {} }
    let url;
    try { url = normalizeWsEndpoint(endpoint, token); }
    catch (error) {
      $('settingsStatus').textContent = `地址格式错误：${error.message || '无法解析'}`;
      showToast('Bridge 地址格式错误');
      return;
    }
    const socket = new WebSocket(url);
    liveSocket = socket;
    socket.onopen = () => {
      if (liveSocket !== socket) return;
      state.connected = true;
      state.connectionState = 'online';
      $('settingsStatus').textContent = '已连接到 Bridge';
      showToast('已连接 DSH');
      sendLiveMessage('session.snapshot.request', {}, true);
      renderSnapshot();
    };
    socket.onmessage = (event) => {
      if (liveSocket === socket) handleMessage(event.data);
    };
    socket.onerror = () => {
      if (liveSocket === socket && socket.readyState !== WebSocket.OPEN) {
        state.connectionState = 'retrying';
        $('settingsStatus').textContent = 'WebSocket 无法建立，正在重试……';
      }
    };
    socket.onclose = (event) => {
      if (liveSocket !== socket) return;
      liveSocket = null;
      state.connected = false;
      state.connectionState = 'retrying';
      state.replying = false;
      state.historyWarmInFlight = false;
      state.historyWarmSessionId = '';
      const reason = event.reason || `WebSocket 已关闭（${event.code}）`;
      $('settingsStatus').textContent = `连接失败：${reason}`;
      renderSnapshot();
    };
  }

  function renderConnection() {
    const online = state.connected;
    const connectionState = online ? 'online' : (state.connectionState || 'retrying');
    $('drawerDot')?.classList.toggle('online', online);
    if ($('drawerState')) $('drawerState').textContent = online ? '已连接' : '未连接';
    const deviceDot = $('chatDeviceDot');
    deviceDot?.classList.toggle('online', connectionState === 'online');
    deviceDot?.classList.toggle('retrying', connectionState === 'retrying');
    deviceDot?.classList.toggle('offline', connectionState === 'offline');
    deviceDot?.setAttribute('aria-label', connectionState === 'online' ? '已连接' : connectionState === 'retrying' ? '正在重试' : '未连接');
    const retryText = $('chatRetryText');
    if (retryText) {
      retryText.textContent = connectionState === 'retrying' ? '正在重试' : '';
      retryText.setAttribute('aria-hidden', connectionState === 'retrying' ? 'false' : 'true');
    }
    $('sendButton').disabled = false;
    syncComposerState();
  }

  function numericUsageValue(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'object') {
      return numericUsageValue(value.tokens ?? value.count ?? value.value ?? value.amount ?? value.used);
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const raw = String(value).trim().replace(/,/g, '');
    const match = raw.match(/^(-?\d+(?:\.\d+)?)\s*([kKmM])?$/);
    if (!match) return null;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return null;
    const factor = match[2]?.toLowerCase() === 'm' ? 1e6 : match[2]?.toLowerCase() === 'k' ? 1e3 : 1;
    return base * factor;
  }

  function firstUsageValue(...values) {
    for (const value of values) {
      const number = numericUsageValue(value);
      if (number !== null) return number;
    }
    return null;
  }

  function compactTokenCount(value) {
    const number = numericUsageValue(value);
    if (number === null) return '—';
    if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 10e6 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (number >= 1000) return `${(number / 1000).toFixed(number >= 100000 ? 0 : 1).replace(/\.0$/, '')}K`;
    return `${Math.round(number)}`;
  }

  function tokenLabel(value) {
    const compact = compactTokenCount(value);
    return compact === '—' ? compact : `~${compact}`;
  }

  function providerField(provider, raw, names) {
    for (const name of names) {
      const value = provider?.[name] ?? raw?.[name];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function providerAmount(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'number' && Number.isFinite(value)) return `$${value.toFixed(4)}`;
    return String(value);
  }

  function contextUsageData() {
    const snapshot = state.snapshot || {};
    const raw = snapshot.usage || snapshot.contextUsage || snapshot.tokenUsage || {};
    const context = raw.context || snapshot.context || {};
    const breakdown = raw.breakdown || raw.categories || {};
    const used = firstUsageValue(raw.contextUsed, raw.used, context.used, snapshot.contextUsed);
    const limit = firstUsageValue(raw.contextLimit, raw.limit, context.limit, snapshot.contextLimit);
    const derivedPercent = used !== null && limit > 0 ? used / limit * 100 : null;
    const percent = firstUsageValue(raw.percent, context.percent, raw.contextPercent, derivedPercent);
    const systemPrompt = firstUsageValue(raw.systemPrompt, raw.system, context.systemPrompt, breakdown.systemPrompt);
    const tools = firstUsageValue(raw.tools, raw.tool, context.tools, breakdown.tools);
    const messages = firstUsageValue(raw.messages, raw.chatMessages, context.messages, breakdown.messages);
    const provider = typeof snapshot.provider === 'object' ? snapshot.provider : {};
    const providerName = String(provider.name || provider.label || provider.id || snapshot.providerName || raw.providerName || (typeof snapshot.provider === 'string' ? snapshot.provider : '')).trim();
    return {
      percent: Math.max(0, Math.min(100, percent === null ? 0 : percent)),
      used,
      limit,
      systemPrompt,
      tools,
      messages,
      providerName,
      spend: providerField(provider, raw, ['spend', 'cost', 'consumed']),
      balance: providerField(provider, raw, ['balance', 'remainingBalance']),
    };
  }

  function renderContextUsage() {
    const data = contextUsageData();
    const percent = Math.round(data.percent);
    text('contextUsagePercent', `${percent}%`);
    text('contextUsageTotal', data.used !== null && data.limit !== null ? `~${compactTokenCount(data.used)} / ${compactTokenCount(data.limit)}` : '—');
    text('contextSystemPrompt', tokenLabel(data.systemPrompt));
    text('contextTools', tokenLabel(data.tools));
    text('contextMessages', tokenLabel(data.messages));
    $('contextUsageRing')?.style.setProperty('--usage-percent', `${percent}%`);
    const fill = $('contextUsageTrackFill');
    if (fill) fill.style.width = `${percent}%`;
    const providerInfo = $('contextProviderInfo');
    if (providerInfo) {
      const isDeepSeek = /deepseek/i.test(`${data.providerName} ${state.snapshot?.provider?.id || ''}`);
      if (isDeepSeek) {
        providerInfo.hidden = false;
        providerInfo.textContent = `DeepSeek 官方 API · 消费 ${providerAmount(data.spend)} · 余额 ${providerAmount(data.balance)}`;
      } else {
        providerInfo.hidden = true;
        providerInfo.textContent = '';
      }
    }
  }

  function modelDisplayName(model) {
    const id = String(model?.id || model?.model || '—');
    const names = {
      'gpt-5.6-luna': 'GPT-5.6 Luna',
      'grok-4.5': 'Grok 4.5',
      'deepseek-v4-flash': 'DeepSeek V4 Flash',
      'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash Vision',
    };
    return String(model?.name || names[id] || id);
  }

  function normalizeEfforts(model) {
    const direct = model?.reasoningEfforts || model?.reasoning?.efforts || model?.reasoning?.levels;
    if (Array.isArray(direct)) return direct.map((item) => String(typeof item === 'object' ? item.id || item.value || '' : item)).filter(Boolean);
    if (direct && typeof direct === 'object') return Object.keys(direct);
    return [];
  }

  function modelDirectory() {
    const raw = state.snapshot?.modelCatalog || state.snapshot?.modelDirectory || state.snapshot?.models;
    let groups = [];
    if (Array.isArray(raw)) groups = raw.some((group) => Array.isArray(group?.models)) ? raw : [{ provider: 'opengo', providerName: 'open-go', models: raw }];
    else if (Array.isArray(raw?.groups)) groups = raw.groups;
    else if (Array.isArray(raw?.routable)) groups = [{ provider: 'opengo', providerName: 'open-go', models: raw.routable }];
    if (!groups.length) groups = DSH_MODEL_CATALOG;
    return groups.map((group) => ({
      provider: String(group.provider || group.providerId || group.id || 'opengo'),
      providerName: String(group.providerName || group.displayName || group.name || group.provider || 'open-go'),
      models: (Array.isArray(group.models) ? group.models : []).map((model) => ({
        ...model,
        id: String(model.id || model.model || ''),
        name: modelDisplayName(model),
        reasoningEfforts: normalizeEfforts(model),
      })).filter((model) => model.id),
    })).filter((group) => group.models.length);
  }

  function currentModelSelection() {
    const snapshotSelection = state.snapshot?.modelSelection || state.snapshot?.currentModel || state.snapshot?.models?.current || {};
    if (!state.modelSelectionTouched && (snapshotSelection.model || snapshotSelection.id)) {
      return {
        provider: String(snapshotSelection.provider || snapshotSelection.providerId || 'opengo'),
        model: String(snapshotSelection.model || snapshotSelection.id),
        reasoningEffort: String(snapshotSelection.reasoningEffort || snapshotSelection.effort || ''),
      };
    }
    return state.selectedModel;
  }

  function currentModelInfo() {
    const selection = currentModelSelection();
    for (const group of modelDirectory()) {
      const model = group.models.find((item) => item.id === selection.model);
      if (model) return { ...model, provider: group.provider, providerName: group.providerName };
    }
    return { id: selection.model || 'hy3', name: selection.model || 'hy3', reasoningEfforts: [], provider: selection.provider || 'opengo', providerName: 'open-go' };
  }

  function modelSupportsImage(model) {
    if (!model) return false;
    const input = model.input || model.inputs || model.modalities || [];
    if (Array.isArray(input) && input.some((mode) => String(mode).toLowerCase() === 'image')) return true;
    if (model.supportsImage === true) return true;
    const id = String(model.id || model.model || model.slug || model.name || '');
    return /vision|image/i.test(id);
  }

  function currentModelSupportsImage() {
    return modelSupportsImage(currentModelInfo());
  }

  function syncImageCapabilityRow() {
    const row = document.querySelector('[data-attachment-action="image"]');
    if (!row) return;
    const enabled = currentModelSupportsImage();
    row.classList.toggle('is-disabled', !enabled);
    row.setAttribute('aria-disabled', String(!enabled));
    const label = row.querySelector('span');
    if (label) label.textContent = enabled ? '上传照片' : '上传照片（当前模型不支持）';
  }

  function renderPendingImages() {
    const strip = $('chatComposerImages');
    if (!strip) return;
    strip.innerHTML = '';
    const images = state.pendingImages || [];
    if (!images.length) { strip.hidden = true; return; }
    strip.hidden = false;
    images.forEach((image, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-image-chip';
      chip.setAttribute('aria-label', '移除图片 ' + (image.name || (index + 1)));
      const thumb = document.createElement('img');
      thumb.src = image.dataUrl || '';
      thumb.alt = image.name || '图片';
      const number = document.createElement('span');
      number.textContent = String(index + 1);
      chip.append(thumb, number);
      chip.onclick = () => {
        state.pendingImages.splice(index, 1);
        renderPendingImages();
        showToast('已移除图片');
      };
      strip.append(chip);
    });
  }

  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const src = String(reader.result || '');
        if (!src) { reject(new Error('读取失败')); return; }
        const image = new Image();
        image.onload = () => {
          const MAX = 1600;
          let width = image.naturalWidth || image.width;
          let height = image.naturalHeight || image.height;
          const scale = Math.min(1, MAX / Math.max(width || 1, height || 1));
          width = Math.max(1, Math.round((width || 1) * scale));
          height = Math.max(1, Math.round((height || 1) * scale));
          let dataUrl = '';
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.fillStyle = '#fff';
              ctx.fillRect(0, 0, width, height);
              ctx.drawImage(image, 0, 0, width, height);
            }
            const quality = Math.max(.56, .82 - attempt * .07);
            dataUrl = canvas.toDataURL('image/jpeg', quality);
            if (dataUrl.length <= 760000 || attempt === 4) break;
            width = Math.max(480, Math.round(width * .82));
            height = Math.max(480, Math.round(height * .82));
          }
          const comma = dataUrl.indexOf(',');
          const header = dataUrl.slice(0, comma);
          const data = dataUrl.slice(comma + 1);
          const mime = (header.match(/^data:([^;]+)/) || [])[1] || 'image/jpeg';
          resolve({ name: file.name || 'photo', mimeType: mime, mediaType: mime, data, dataUrl });
          reader._cleanup = null;
        };
        image.onerror = () => reject(new Error('图片解码失败'));
        image.src = src;
      };
      reader.onerror = () => reject(new Error('读取失败'));
      reader.readAsDataURL(file);
    });
  }

  function permissionDirectory() {
    const options = state.snapshot?.permissions?.options || state.snapshot?.permissionOptions;
    if (!Array.isArray(options) || !options.length) return DSH_PERMISSION_OPTIONS;
    return options.map((option) => ({
      value: String(option.value || option.id || option.name || ''),
      name: String(option.name || option.label || option.value || option.id || ''),
      description: String(option.description || option.detail || ''),
    })).filter((option) => option.value);
  }

  function currentPermission() {
    if (!state.permissionSelectionTouched) {
      const value = state.snapshot?.permissions?.current || state.snapshot?.permission || state.snapshot?.permissionPreset;
      if (value) return String(typeof value === 'object' ? value.value || value.id || value.name || '' : value);
    }
    return state.selectedPermission;
  }

  function effortDisplayName(value) { return EFFORT_NAMES[String(value || '')] || String(value || '默认'); }

  function renderComposerOptions() {
    const selectedModel = currentModelSelection();
    const model = currentModelInfo();
    const effort = selectedModel.reasoningEffort || state.selectedEffort || '';
    text('modelLabel', effort ? `${model.name} ${effortDisplayName(effort)}` : model.name, 'hy3');
    $('permissionButton')?.setAttribute('aria-expanded', String(state.selectorKind === 'permission'));
    $('modelButton')?.setAttribute('aria-expanded', String(state.selectorKind === 'model-root' || state.selectorKind === 'model' || state.selectorKind === 'effort'));
    $('effortButton')?.setAttribute('aria-expanded', String(state.selectorKind === 'effort'));
    $('modelButton')?.setAttribute('title', model.reasoningEfforts.length ? `模型：${model.name}；思考程度：${model.reasoningEfforts.map(effortDisplayName).join('、')}` : `模型：${model.name}；默认思考程度`);
    const effortButton = $('effortButton');
    if (effortButton) {
      effortButton.disabled = false;
      effortButton.title = model.reasoningEfforts.length ? `可选：${model.reasoningEfforts.map(effortDisplayName).join('、')}` : '当前模型未声明推理强度';
    }
  }

  function selectorPayloadButton(payload, name, description, selected) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chat-selector-option${selected ? ' is-selected' : ''}`;
    button.dataset.selectorPayload = encodeURIComponent(JSON.stringify(payload));
    const copy = document.createElement('span');
    copy.className = 'chat-selector-option-copy';
    const title = document.createElement('span');
    title.className = 'chat-selector-option-name';
    title.textContent = name;
    copy.append(title);
    if (description) {
      const detail = document.createElement('span');
      detail.className = 'chat-selector-option-description';
      detail.textContent = description;
      copy.append(detail);
    }
    const check = document.createElement('span');
    check.className = `chat-selector-check${selected ? '' : ' is-empty'}`;
    check.textContent = '✓';
    button.append(copy, check);
    return button;
  }

  function selectorNavigationButton(target, name, description) {
    const button = selectorPayloadButton({ kind: 'navigate', target }, name, description, false);
    button.classList.add('is-navigation');
    const check = button.querySelector('.chat-selector-check');
    if (check) {
      check.classList.remove('is-empty');
      check.classList.add('is-chevron');
      check.textContent = '';
    }
    return button;
  }

  function renderSelector() {
    const layer = $('chatSelectorLayer');
    const options = $('chatSelectorOptions');
    if (!layer || !options) return;
    options.replaceChildren();
    const kind = state.selectorKind;
    const card = $('chatSelectorCard');
    card?.classList.remove('is-model-root', 'is-model', 'is-effort', 'is-permission');
    card?.classList.add(`is-${kind || 'permission'}`);
    text('chatSelectorTitle', kind === 'permission' ? '权限' : kind === 'model-root' ? '选择' : kind === 'model' ? '模型' : '智力');
    if (kind === 'permission') {
      const current = currentPermission();
      permissionDirectory().forEach((item) => options.append(selectorPayloadButton({ kind, value: item.value }, item.name, item.description, item.value === current)));
    } else if (kind === 'model-root') {
      const model = currentModelInfo();
      const effort = currentModelSelection().reasoningEffort || state.selectedEffort || '';
      options.append(selectorNavigationButton('model', '模型选择', model.name));
      options.append(selectorNavigationButton('effort', '智力选择', effort ? effortDisplayName(effort) : '默认'));
    } else if (kind === 'model') {
      const current = currentModelSelection();
      modelDirectory().forEach((group) => {
        const heading = document.createElement('div');
        heading.className = 'chat-selector-group-label';
        heading.textContent = group.providerName;
        options.append(heading);
        group.models.forEach((model) => {
          const efforts = model.reasoningEfforts.length ? `智力：${model.reasoningEfforts.map(effortDisplayName).join(' / ')}` : '未声明推理强度';
          options.append(selectorPayloadButton({ kind, provider: group.provider, model: model.id }, model.name, efforts, model.id === current.model && group.provider === current.provider));
        });
      });
    } else {
      const model = currentModelInfo();
      const current = currentModelSelection().reasoningEffort || state.selectedEffort || '';
      const efforts = model.reasoningEfforts.length ? model.reasoningEfforts : [''];
      efforts.forEach((value) => options.append(selectorPayloadButton({ kind, value }, effortDisplayName(value), '', value === current)));
    }
    layer.hidden = false;
    card?.classList.remove('chat-card-reenter');
    void card?.offsetWidth;
    card?.classList.add('chat-card-reenter');
  }

  function closeSelector() {
    state.selectorKind = '';
    $('chatSelectorLayer').hidden = true;
    renderComposerOptions();
    syncComposerState();
  }

  function openSelector(kind) {
    closeAttachmentMenu();
    closeChatMenu();
    setContextUsageOpen(false);
    state.composerExpanded = true;
    state.selectorKind = kind;
    renderComposerOptions();
    renderSelector();
    syncComposerState();
    preserveFocusedComposer();
    playComposerFeedback(kind === 'permission' ? 'permissionButton' : 'modelButton');
  }

  function chooseSelectorPayload(payload) {
    if (!payload) return;
    if (payload.kind === 'navigate') {
      state.selectorKind = payload.target === 'effort' ? 'effort' : 'model';
      renderComposerOptions();
      renderSelector();
      syncComposerState();
      return;
    }
    if (payload.kind === 'permission') {
      state.selectedPermission = String(payload.value || 'workspace-write');
      state.permissionSelectionTouched = true;
      closeSelector();
      playComposerFeedback('permissionButton');
      preserveFocusedComposer();
      showToast(`已选择权限：${state.selectedPermission}`);
      if (state.connected) control('sendPrompt', `/permission ${state.selectedPermission}`);
      return;
    }
    if (payload.kind === 'model') {
      state.selectedModel = { provider: String(payload.provider || 'opengo'), model: String(payload.model || 'hy3'), reasoningEffort: '' };
      state.selectedEffort = '';
      state.modelSelectionTouched = true;
      const model = currentModelInfo();
      closeSelector();
      playComposerFeedback('modelButton');
      preserveFocusedComposer();
      syncImageCapabilityRow();
      showToast(`已选择模型：${model.name}`);
      return;
    }
    state.selectedEffort = String(payload.value || '');
    state.selectedModel = { ...currentModelSelection(), reasoningEffort: state.selectedEffort };
    state.modelSelectionTouched = true;
    closeSelector();
    playComposerFeedback('modelButton');
    preserveFocusedComposer();
    showToast(`已选择智力：${effortDisplayName(state.selectedEffort)}`);
  }

  function playComposerFeedback(id) {
    const target = $(id);
    if (!target) return;
    target.classList.remove('chat-composer-control-feedback');
    void target.offsetWidth;
    target.classList.add('chat-composer-control-feedback');
    window.setTimeout(() => target.classList.remove('chat-composer-control-feedback'), 380);
  }

  function preserveFocusedComposer() {
    const input = $('promptInput');
    if (!input || document.activeElement !== input) return;
    state.composerExpanded = true;
    syncComposerState();
    requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      syncWebKeyboardInset();
      window.setTimeout(keepComposerVisible, 40);
    });
  }

  function syncComposerState() {
    const button = $('stopButton');
    if (!button) return;
    const active = state.replying;
    const composer = $('chatComposer');
    const input = $('promptInput');
    const expanded = state.composerExpanded || Boolean(input?.value);
    composer?.classList.toggle('is-expanded', expanded);
    $('chatAttachmentLayer')?.classList.toggle('composer-expanded', expanded);
    button.disabled = !state.connected;
    button.classList.toggle('replying', active);
    button.classList.toggle('sending', !active);
    button.setAttribute('aria-label', active ? '停止 DSH 回复' : '发送消息');
    renderComposerOptions();
  }

  function renderSnapshot() {
    const s = state.snapshot || {};
    const project = s.project || {};
    const session = s.session || {};
    if ($('drawerProject')) text('drawerProject', project.name, 'DSH');
    renderConnection();
    renderComposerOptions();
    renderContextUsage();
    if (!$('homeView').hidden) renderHome();
    if (!$('projectView').hidden) renderProject();
    if (!$('dashboardView').hidden) renderChat();
  }

  function renderEvents() {
    if (!$('dashboardView').hidden) renderChat();
  }

  function handleMessage(raw) {
    const message = safeJson(raw, {});
    if (!message || typeof message !== 'object') return;
    const type = message.type || '';
    const nativeMessage = message.source === 'native';
    if (nativeMessage && liveSocketOpen() && type !== 'status') return;
    if (type === 'status') {
      const status = message.data?.status || 'disconnected';
      if (nativeMessage && liveSocketOpen() && ['connecting', 'connected', 'disconnected', 'offline'].includes(status)) return;
      if (status === 'connected' || status === 'control-ok') {
        state.connected = true;
        state.connectionState = 'online';
      }
      if (status === 'connecting') state.connectionState = 'retrying';
      if (status === 'disconnected') {
        state.connected = false;
        state.connectionState = 'retrying';
        state.replying = false;
      }
      if (status === 'offline') {
        state.connected = false;
        state.connectionState = 'offline';
        state.replying = false;
      }
      if (status === 'control-error') showToast(message.data?.message || '控制失败');
      if (status === 'connected') showToast('已连接 DSH');
      if (status === 'disconnected') {
        const reason = message.data?.message || '无法连接 Bridge';
        $('settingsStatus').textContent = `连接失败：${reason}`;
        showToast(`连接失败：${reason}`);
      }
      if (status === 'connecting') $('settingsStatus').textContent = '正在连接 Bridge……';
      if (status.startsWith('update-')) clearTimeout(updateTimer);
      if (status === 'update-checking') {
        updateMode = 'check';
        $('updateButton').textContent = '检查更新';
        $('settingsStatus').textContent = '正在检查更新……';
      }
      if (status === 'update-current') {
        updateMode = 'check';
        $('updateButton').textContent = '检查更新';
        $('settingsStatus').textContent = message.data?.message || '已是最新版';
        showToast(message.data?.message || '已是最新版');
      }
      if (status === 'update-available') {
        updateMode = 'download';
        $('updateButton').textContent = `下载 ${message.data?.latestVersion || '新版本'}`;
        $('settingsStatus').textContent = message.data?.message || '发现新版本，可以下载安装。';
        showToast(message.data?.message || '发现新版本');
      }
      if (status === 'update-started') {
        updateMode = 'check';
        $('updateButton').textContent = '检查更新';
        $('settingsStatus').textContent = '正在从电脑下载更新……';
        showToast('正在下载更新');
      }
      if (status === 'update-progress') {
        updateMode = 'check';
        $('updateButton').textContent = '下载中…';
        $('settingsStatus').textContent = message.data?.message || '正在从电脑下载更新……';
      }
      if (status === 'update-downloaded') {
        $('settingsStatus').textContent = '更新包已下载，正在打开安装确认。';
        showToast('请在系统窗口确认安装');
      }
      if (status === 'update-error') {
        updateMode = 'check';
        $('updateButton').textContent = '重新检查';
        $('settingsStatus').textContent = `更新失败：${message.data?.message || '无法下载更新'}`;
        showToast(`更新失败：${message.data?.message || '无法下载更新'}`);
      }
    } else if (type === 'session.history') {
      const data = message.data || {};
      const sessionId = String(data.sessionId || '');
      if (sessionId) {
        const history = state.sessionHistory[sessionId] || { items: [], hasMore: true, nextBefore: null, loading: false, lastTimestamp: 0 };
        const existing = new Map(history.items.map((item) => [itemKey(item), item]));
        (Array.isArray(data.items) ? data.items : []).forEach((item) => existing.set(itemKey(item), item));
        history.items = [...existing.values()].sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0) || Number(left.timestamp || 0) - Number(right.timestamp || 0));
        history.hasMore = Boolean(data.hasMore);
        history.nextBefore = data.nextBefore === null || data.nextBefore === undefined ? null : Number(data.nextBefore);
        history.loading = false;
        history.lastTimestamp = history.items.reduce((latest, item) => Math.max(latest, Number(item.timestamp || 0)), 0);
        state.sessionHistory[sessionId] = history;
        if (state.historyWarmSessionId === sessionId) {
          state.historyWarmInFlight = false;
          state.historyWarmSessionId = '';
          warmRecentHistories();
        }
      }
    } else if (type === 'session.snapshot') {
      state.snapshot = message.data || {};
      const snapshotState = String(state.snapshot.state || '').toLowerCase();
      const snapshotPhase = String(state.snapshot.phase || '').toLowerCase();
      state.replying = snapshotState === 'waiting' || (snapshotState === 'running' && ['thinking', 'tool', 'terminal'].includes(snapshotPhase));
      warmRecentHistories();
    } else if (type === 'control.result') {
      if (message.data?.ok === false) showToast(message.data.error || '控制失败');
      else showToast('命令已发送到 DSH');
    } else if (type === 'error') {
      showToast(message.data?.message || 'Bridge 返回错误');
    } else if (type) {
      if (['agent.thinking', 'tool.started', 'terminal.started', 'progress.updated', 'approval.required', 'approval.resolved'].includes(type)) state.replying = true;
      if (type === 'session.completed' || type === 'session.failed') state.replying = false;
      state.events.push(message);
      if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
      state.lastEventAt = Date.now();
      if (type === 'session.completed' || type === 'session.failed') renderSnapshot();
    }
    renderSnapshot(); renderEvents();
  }
  window.DshRemote = { onNativeMessage: handleMessage };

  function openSettings() {
    $('endpointInput').value = settings.endpoint || '';
    $('tokenInput').value = settings.token || '';
    $('settingsStatus').textContent = '';
    $('settingsModal').hidden = false;
  }
  function closeSettings() { $('settingsModal').hidden = true; }
  function currentSessionId() {
    return String(state.selectedChat?.id || state.snapshot?.session?.id || '');
  }
  function currentChatTitle() {
    const id = currentSessionId();
    return String(state.selectedChat?.title || state.renamedTitles[id] || state.snapshot?.session?.title || 'Remote DSH');
  }
  function openChatMenu() {
    closeAttachmentMenu();
    closeSelector();
    setContextUsageOpen(false);
    text('chatMenuTitle', currentChatTitle(), 'Remote DSH');
    $('chatMenuLayer').hidden = false;
  }
  function closeChatMenu() { $('chatMenuLayer').hidden = true; }
  function setContextUsageOpen(open) {
    const layer = $('contextUsageLayer');
    if (!layer) return;
    layer.hidden = !open;
    $('contextUsageButton')?.setAttribute('aria-expanded', String(Boolean(open)));
    if (open) {
      closeChatMenu();
      closeAttachmentMenu();
      closeSelector();
      renderContextUsage();
    }
  }
  function openAttachmentMenu() {
    closeChatMenu();
    closeSelector();
    setContextUsageOpen(false);
    $('chatAttachmentLayer').hidden = false;
    syncImageCapabilityRow();
    preserveFocusedComposer();
    playComposerFeedback('sendButton');
    requestAnimationFrame(refreshCommandMarquees);
  }
  function closeAttachmentMenu() { $('chatAttachmentLayer').hidden = true; }
  function refreshCommandMarquees() {
    document.querySelectorAll('.chat-command-description').forEach((description) => {
      description.classList.remove('marquee');
      description.style.removeProperty('--chat-command-marquee-distance');
      description.style.removeProperty('--chat-command-marquee-duration');
      const overflow = Math.max(0, description.scrollWidth - description.clientWidth);
      if (overflow <= 4) return;
      description.style.setProperty('--chat-command-marquee-distance', `${-overflow}px`);
      description.style.setProperty('--chat-command-marquee-duration', `${Math.min(14, Math.max(6, 5 + overflow / 24))}s`);
      description.classList.add('marquee');
    });
  }
  function chooseDshCommand(name) {
    closeAttachmentMenu();
    const input = $('promptInput');
    if (!input) return;
    state.composerExpanded = true;
    input.value = `/${String(name || '').trim()} `;
    input.style.height = 'auto';
    input.style.height = `${Math.min(112, input.scrollHeight)}px`;
    syncComposerState();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  function choosePhoto() {
    closeAttachmentMenu();
    if (!currentModelSupportsImage()) {
      showToast('当前模型不支持图片，请切换到支持图片的模型（如 deepseek-v4-flash-vision-exp）');
      return;
    }
    $('chatAttachmentInput')?.click();
  }
  async function copyToClipboard(value) {
    if (!value) { showToast('当前会话没有可复制的 ID'); return; }
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else throw new Error('clipboard unavailable');
    } catch (_) {
      const helper = document.createElement('textarea');
      helper.value = value;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.append(helper);
      helper.select();
      try { document.execCommand('copy'); } catch (_) {}
      helper.remove();
    }
    showToast('会话 ID 已复制');
  }
  function handleChatMenu(action) {
    const id = currentSessionId();
    if (action === 'copy') {
      closeChatMenu();
      copyToClipboard(id);
      return;
    }
    if (action === 'pin') {
      if (!id) { closeChatMenu(); showToast('当前会话没有可置顶的 ID'); return; }
      const index = state.pinnedIds.indexOf(id);
      if (index >= 0) {
        state.pinnedIds.splice(index, 1);
        showToast('已取消置顶');
      } else {
        state.pinnedIds.unshift(id);
        showToast('已置顶');
      }
      writeLocal('dsh.remote.pinnedIds', state.pinnedIds);
      closeChatMenu();
      renderHome();
      renderProject();
      return;
    }
    if (action === 'rename') {
      closeChatMenu();
      const next = window.prompt('重命名会话', currentChatTitle());
      if (next && next.trim()) {
        const title = next.trim();
        state.selectedChat = { ...(state.selectedChat || {}), id, title };
        if (id) state.renamedTitles[id] = title;
        writeLocal('dsh.remote.renamedTitles', state.renamedTitles);
        renderChat();
        renderHome();
        renderProject();
        showToast('已重命名');
      }
      return;
    }
    if (action === 'archive') {
      closeChatMenu();
      if (id && !state.archivedIds.includes(id)) {
        state.archivedIds.push(id);
        writeLocal('dsh.remote.archivedIds', state.archivedIds);
      }
      showToast('已归档');
      if (state.chatOrigin === 'project') showProject({ direction: false });
      else showHome();
    }
  }
  function connect() {
    const endpoint = $('endpointInput').value.trim();
    const token = $('tokenInput').value.trim();
    if (!endpoint) { $('settingsStatus').textContent = '请填写 Bridge WebSocket 地址。'; return; }
    settings = { endpoint, token };
    $('settingsStatus').textContent = '正在连接……';
    if (native) native.connect(endpoint, token);
    openLiveSocket(endpoint, token);
    closeSettings();
  }
  function disconnect() {
    if (liveSocket) { try { liveSocket.close(); } catch (_) {} liveSocket = null; }
    if (native) native.disconnect();
    state.connected = false; state.connectionState = 'offline'; renderConnection(); closeSettings(); showToast('已断开');
  }
  function control(method, ...args) {
    const liveControl = {
      sendPrompt: ['prompt.send', (() => {
        const payload = { text: String(args[0] || '') };
        const source = Array.isArray(args[1]) ? args[1] : (state.pendingImages || []);
        const attachments = source.map((image) => ({
          name: image.name || 'photo',
          mediaType: image.mediaType || image.mimeType || 'image/jpeg',
          data: image.data || '',
        }));
        if (attachments.length) payload.attachments = attachments;
        return payload;
      })()],
      stopTask: ['task.stop', {}],
      continueTask: ['task.continue', {}],
      resolveApproval: [args[0] ? 'approval.allow' : 'approval.deny', { requestId: String(args[1] || '') }],
    }[method];
    if (liveControl && sendLiveMessage(liveControl[0], liveControl[1])) return;
    if (method === 'requestSnapshot' && sendLiveMessage('session.snapshot.request', {}, true)) return;
    if (!native) { showToast('当前环境没有 Android 远程服务'); return; }
    if (method === 'sendPrompt' && typeof native.sendPrompt === 'function') {
      const attachments = liveControl?.[1]?.attachments || [];
      native.sendPrompt(String(args[0] || ''), JSON.stringify(attachments));
      return;
    }
    native[method](...args);
  }

  $('closeDrawer').onclick = () => { $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); $('drawerScrim').hidden = true; };
  $('drawerScrim').onclick = $('closeDrawer').onclick;
  $('settingsButton').onclick = openChatMenu;
  $('contextUsageButton').onclick = () => setContextUsageOpen(true);
  $('homeMoreButton').onclick = openSettings;
  $('homeBackButton').onclick = () => {
    showToast('当前已经是首页');
  };
  $('projectBackButton').onclick = () => showHome({ direction: false });
  $('chatBackButton').onclick = () => {
    closeAttachmentMenu();
    closeSelector();
    setContextUsageOpen(false);
    if (state.chatOrigin === 'project') showProject({ direction: false });
    else showHome();
  };
  $('homeComposeButton').onclick = openNewChatPicker;
  $('newChatScrim').onclick = closeNewChatPicker;
  document.querySelectorAll('[data-new-chat-action]').forEach((button) => {
    button.onclick = () => {
      if (button.dataset.newChatAction === 'history' || button.dataset.newChatAction === 'new-project') {
        handleNewChatAction(button.dataset.newChatAction);
        return;
      }
    };
  });
  $('newChatProjectList').onclick = (event) => {
    const row = event.target.closest('.new-chat-project-row');
    if (!row) return;
    startDraftChat(row.dataset.projectId, row.dataset.projectName);
  };
  $('homeSearch').addEventListener('input', renderHome);
  $('homeSearch').addEventListener('focus', (event) => keepSearchVisible(event.currentTarget));
  $('homeProjects').onclick = (event) => {
    const row = event.target.closest('.project-row');
    if (!row) return;
    state.selectedProject = {
      id: String(row.dataset.projectId || ''),
      name: String(row.dataset.projectName || '项目'),
    };
    showProject();
  };
  $('homeRecent').onclick = (event) => {
    const row = event.target.closest('.recent-row');
    if (!row) return;
    const recent = Array.isArray(state.snapshot?.recent) ? state.snapshot.recent : [];
    const current = recent.find((item) => String(item.id || '') === String(row.dataset.sessionId || '')) || {};
    openChat({
      id: row.dataset.sessionId || state.snapshot.session?.id,
      title: row.dataset.sessionTitle || state.snapshot.session?.title,
      projectId: current.projectId,
      projectName: current.projectName || state.snapshot.project?.name || 'DSH',
      origin: 'home',
    });
  };
  $('projectSearch').addEventListener('input', renderProject);
  $('projectSearch').addEventListener('focus', (event) => keepSearchVisible(event.currentTarget));
  $('projectChats').onclick = (event) => {
    const row = event.target.closest('.project-session-row');
    if (!row) return;
    openChat({
      id: row.dataset.sessionId,
      title: row.dataset.sessionTitle,
      projectId: row.dataset.projectId,
      projectName: row.dataset.projectName,
      origin: 'project',
    });
  };
  $('projectComposeButton').onclick = () => {
    state.chatOrigin = 'project';
    showDashboard();
    setTimeout(() => $('promptInput')?.focus(), 80);
  };
  $('drawerSettings').onclick = openSettings;
  $('drawerRefresh').onclick = () => { control('requestSnapshot'); showToast('正在刷新状态'); };
  $('closeSettings').onclick = closeSettings;
  $('chatMenuScrim').onclick = closeChatMenu;
  $('contextUsageScrim').onclick = () => setContextUsageOpen(false);
  $('chatAttachmentScrim').onclick = closeAttachmentMenu;
  $('chatSelectorScrim').onclick = closeSelector;
  document.querySelectorAll('[data-chat-menu]').forEach((button) => {
    button.onclick = () => handleChatMenu(button.dataset.chatMenu);
  });
  document.querySelectorAll('[data-chat-command]').forEach((button) => {
    button.onclick = () => chooseDshCommand(button.dataset.chatCommand);
  });
  document.querySelector('[data-attachment-action="image"]')?.addEventListener('click', choosePhoto);
  $('permissionButton').onclick = () => openSelector('permission');
  $('modelButton').onclick = () => openSelector('model-root');
  $('effortButton')?.addEventListener('click', () => openSelector('effort'));
  ['sendButton', 'permissionButton', 'modelButton', 'effortButton'].forEach((id) => {
    $(id)?.addEventListener('pointerdown', (event) => {
      if (document.activeElement === $('promptInput')) event.preventDefault();
    });
  });
  document.querySelector('.chat-attachment-card')?.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') && document.activeElement === $('promptInput')) event.preventDefault();
  });
  $('chatSelectorOptions')?.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') && document.activeElement === $('promptInput')) event.preventDefault();
  });
  $('chatSelectorOptions').onclick = (event) => {
    const option = event.target.closest('[data-selector-payload]');
    if (!option) return;
    try { chooseSelectorPayload(JSON.parse(decodeURIComponent(option.dataset.selectorPayload || ''))); }
    catch (_) { showToast('选择项读取失败'); }
  };
  $('chatAttachmentInput')?.addEventListener('change', async () => {
    const files = Array.from($('chatAttachmentInput').files || []);
    if (!files.length) return;
    $('chatAttachmentInput').value = '';
    if (!currentModelSupportsImage()) {
      showToast('当前模型不支持图片，请切换到支持图片的模型');
      return;
    }
    let added = 0;
    for (const file of files) {
      try {
        const image = await fileToImage(file);
        if (!image) continue;
        state.pendingImages = state.pendingImages || [];
        state.pendingImages.push(image);
        added++;
      } catch (_) { /* skip unreadable images */ }
    }
    if (added) {
      renderPendingImages();
      showToast(added === 1 ? '已添加图片，发送时会一并传给 DSH' : `已添加 ${added} 张图片`);
    } else {
      showToast('图片添加失败，请换一张试试');
    }
  });
  $('saveConnectButton').onclick = connect;
  $('updateButton').onclick = () => {
    if (!native || typeof native.checkForUpdate !== 'function' || typeof native.downloadUpdate !== 'function') {
      $('settingsStatus').textContent = '当前环境没有 Android 更新服务。';
      showToast('当前环境没有 Android 更新服务');
      return;
    }
    clearTimeout(updateTimer);
    if (updateMode === 'download') {
      try { native.downloadUpdate(); }
      catch (error) {
        $('settingsStatus').textContent = `更新启动失败：${error.message || '无法启动'}`;
        showToast('更新启动失败');
      }
      return;
    }
    $('settingsStatus').textContent = '正在检查更新……';
    $('updateButton').textContent = '检查中…';
    showToast('正在检查更新');
    try { native.checkForUpdate(); }
    catch (error) {
      $('settingsStatus').textContent = `检查失败：${error.message || '无法启动'}`;
      $('updateButton').textContent = '重新检查';
      return;
    }
    updateTimer = setTimeout(() => {
      $('settingsStatus').textContent = '检查更新超时，请确认 Bridge 正在运行。';
      $('updateButton').textContent = '重新检查';
      showToast('检查更新超时');
    }, 15000);
  };
  $('disconnectButton').onclick = disconnect;
  $('stopButton').onclick = () => {
    if (state.replying) {
      state.replying = false;
      syncComposerState();
      renderSnapshot();
      control('stopTask');
      return;
    }
    sendPrompt();
  };
  function sendPrompt() {
    const value = $('promptInput').value.trim();
    const images = Array.isArray(state.pendingImages) ? state.pendingImages : [];
    if (!value && !images.length) { $('promptInput').focus(); return; }
    if (state.connected) {
      state.replying = true;
      syncComposerState();
    }
    state.autoFollowChat = true;
    clearFollowResume();
    state.chatLocalItems.push({
      id: `local:${Date.now()}`,
      sessionId: activeChatSessionId(),
      kind: 'bubble',
      text: value,
      images: images.map((image) => ({ name: image.name, dataUrl: image.dataUrl })),
      timestamp: Date.now(),
    });
    renderChat();
    control('sendPrompt', value, images);
    state.pendingImages = [];
    renderPendingImages();
    $('promptInput').value = '';
    $('promptInput').style.height = 'auto';
    state.composerExpanded = false;
    syncComposerState();
  }
  $('sendButton').onclick = openAttachmentMenu;
  $('promptInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendPrompt(); }
  });
  $('promptInput').addEventListener('focus', () => {
    state.composerExpanded = true;
    syncComposerState();
    syncWebKeyboardInset();
    setTimeout(keepComposerVisible, 180);
  });
  $('promptInput').addEventListener('blur', () => {
    setTimeout(() => {
      if (!$('promptInput').value && !state.selectorKind) {
        state.composerExpanded = false;
        syncComposerState();
      }
    }, 120);
  });
  $('promptInput').addEventListener('input', () => { state.composerExpanded = true; $('promptInput').style.height = 'auto'; $('promptInput').style.height = `${Math.min(112, $('promptInput').scrollHeight)}px`; syncComposerState(); });
  $('chatScroll').addEventListener('pointerdown', () => {
    state.programmaticScrollUntil = 0;
    state.autoFollowChat = false;
    clearFollowResume();
  }, { passive: true });
  $('chatScroll').addEventListener('pointerup', () => {
    if (isChatAtBottom()) scheduleFollowResume();
  }, { passive: true });
  $('chatScroll').addEventListener('scroll', () => {
    if (performance.now() < state.programmaticScrollUntil) return;
    if (!isChatAtBottom()) {
      state.autoFollowChat = false;
      clearFollowResume();
      if ($('chatScroll').scrollTop < 120) requestOlderHistory();
      return;
    }
    if (!state.autoFollowChat) scheduleFollowResume();
  }, { passive: true });
  window.visualViewport?.addEventListener('resize', () => { syncWebKeyboardInset(); setTimeout(keepComposerVisible, 40); });
  window.visualViewport?.addEventListener('scroll', syncWebKeyboardInset);
  window.addEventListener('resize', () => { syncWebKeyboardInset(); refreshCommandMarquees(); });

  settings = safeJson(native?.getSettings?.(), {});
  state.snapshot = safeJson(native?.getSnapshot?.(), {});
  state.replying = String(state.snapshot?.state || '').toLowerCase() === 'waiting' || (
    String(state.snapshot?.state || '').toLowerCase() === 'running' &&
    ['thinking', 'tool', 'terminal'].includes(String(state.snapshot?.phase || '').toLowerCase())
  );
  syncWebKeyboardInset();
  renderHome();
  renderSnapshot(); renderEvents();
  if (settings.endpoint) {
    if (native) native.connect(settings.endpoint, settings.token || '');
    openLiveSocket(settings.endpoint, settings.token || '');
  }
})();
