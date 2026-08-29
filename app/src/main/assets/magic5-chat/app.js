(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const previewQuery = new URLSearchParams(location.search);
  const isBrowserPreview = previewQuery.has('preview');
  const native = window.AndroidRemote || null;
  const remoteFrame = $('remoteApp');
  let shellUpdateMode = 'check';
  const setShellUpdateIcon = (mode = 'check', busy = false) => {
    const button = $('shellSettingsCheckUpdateButton');
    if (!button) return;
    const image = button.querySelector('img');
    const download = mode === 'download';
    shellUpdateMode = download ? 'download' : 'check';
    if (image) image.src = `../icons/settings-generated/${download ? 'download' : 'update'}.png?v=selected-set-2`;
    button.setAttribute('aria-label', download ? '下载更新' : '检查更新');
    button.setAttribute('aria-busy', String(Boolean(busy)));
    button.classList.toggle('is-checking', Boolean(busy));
    button.disabled = Boolean(busy);
  };
  const messageInput = $('messageInput');
  const conversationContent = $('conversationContent');
  const conversationFolder = $('conversationFolder');
  const attachmentInput = $('attachmentInput');
  const attachmentPreview = $('attachmentPreview');
  const attachmentLayer = $('attachmentLayer');
  const featureLayer = $('featureLayer');
  const chatSelectorLayer = $('chatSelectorLayer');
  const contextLayer = $('contextLayer');
  const sidebarLayer = $('sidebarLayer');
  const chatPage = $('chatPage');
  const remoteView = $('remoteView');
  const settingsView = $('settingsView');
  const apiProjectsView = $('apiProjectsView');
  const apiProjectView = $('apiProjectView');
  const apiProjectCreateLayer = $('apiProjectCreateLayer');
  const apiProjectPickerLayer = $('apiProjectPickerLayer');

  const DEFAULT_CONFIG = { base_url: 'https://api.deepseek.com', api_key: '', model: 'deepseek-chat', system_prompt: '' };
  const STORAGE_KEY = 'deepseek.chat.conversations.v2';
  const PROJECTS_STORAGE_KEY = 'deepseek.chat.projects.v1';
  const CONFIG_KEY = 'deepseek.chat.api.v1';
  const state = { conversations: [], projects: [], activeId: 'today', selectedProject: null, api: { ...DEFAULT_CONFIG }, apiModels: ['deepseek-chat', 'deepseek-reasoner'], selectedEffort: 'auto', projectName: '', pendingAttachment: null, request: null, toastTimer: null, pendingRemoteMessages: [], pendingRemoteRoute: '', apiTestPending: false, settingsReturnView: 'chat' };

  const safeJson = (value, fallback) => { try { return typeof value === 'string' ? JSON.parse(value) : (value ?? fallback); } catch (_) { return fallback; } };
  const showToast = (message) => { const toast = $('toast'); if (!toast) return; toast.textContent = String(message || ''); toast.classList.add('show'); clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2200); };
  const setConversationFolder = (folderName) => {
    const value = String(folderName || '').trim();
    if (conversationFolder) {
      conversationFolder.hidden = !value;
      conversationFolder.querySelector('span').textContent = value;
      conversationFolder.closest('.conversation-title-pill')?.classList.toggle('no-project', !value);
      conversationFolder.closest('.conversation-title-pill')?.classList.toggle('has-project', Boolean(value));
    }
    state.projectName = value;
  };
  window.setConversationFolder = setConversationFolder;

  // MainActivity owns the WebSocket queue. Forward DSH frames to the embedded
  // Remote page; file-picked frames also feed the chat composer.
  const forwardRemoteMessage = (payload) => {
    const parsed = safeJson(payload, null);
    if (parsed?.type === 'file-picked') window.dispatchEvent(new CustomEvent('native-file-picked', { detail: parsed }));
    if (parsed?.type === 'open-session') showRemoteView();
    const target = remoteFrame?.contentWindow?.DshRemote;
    if (target && typeof target.onNativeMessage === 'function') { try { target.onNativeMessage(payload); return; } catch (_) {} }
    state.pendingRemoteMessages.push(payload);
    if (state.pendingRemoteMessages.length > 80) state.pendingRemoteMessages.shift();
  };
  window.DshRemote = { onNativeMessage: forwardRemoteMessage };
  const syncRemoteFrameInsets = () => {
    const frameRoot = remoteFrame?.contentDocument?.documentElement;
    if (!frameRoot) return;
    const root = document.documentElement;
    frameRoot.style.setProperty('--native-safe-top', '0px');
    ['--native-safe-bottom', '--native-keyboard-bottom'].forEach((name) => { const value = getComputedStyle(root).getPropertyValue(name).trim(); if (value) frameRoot.style.setProperty(name, value); });
  };
  const requestRemoteRoute = (route) => {
    const value = route === 'projects' ? 'projects' : 'remote';
    state.pendingRemoteRoute = value;
    try { remoteFrame?.contentWindow?.postMessage({ type: 'dsh-shell-route', route: value }, '*'); } catch (_) {}
  };
  remoteFrame?.addEventListener('load', () => {
    syncRemoteFrameInsets();
    const queue = state.pendingRemoteMessages; state.pendingRemoteMessages = []; queue.forEach(forwardRemoteMessage);
    if (state.pendingRemoteRoute) {
      try { remoteFrame.contentWindow.postMessage({ type: 'dsh-shell-route', route: state.pendingRemoteRoute }, '*'); } catch (_) {}
    }
  });
  window.addEventListener('resize', syncRemoteFrameInsets);
  window.DshShellBack = () => { remoteView.hidden = true; settingsView.hidden = true; chatPage.hidden = false; renderMessages(); };
  window.addEventListener('message', (event) => {
    if (event.source !== remoteFrame?.contentWindow) return;
    if (event.data?.type === 'dsh-shell-back') window.DshShellBack();
    if (event.data?.type === 'dsh-open-shell-settings') showSettingsView('remote');
    if (event.data?.type === 'dsh-update-state') {
      const status = String(event.data.status || '');
      const busy = ['update-checking', 'update-started', 'update-progress'].includes(status);
      const mode = ['update-available', 'update-started', 'update-progress'].includes(status) ? 'download' : 'check';
      setShellUpdateIcon(mode, busy);
    }
  });
  const syncKeyboardInset = () => {
    const viewport = window.visualViewport;
    const inset = viewport ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)) : 0;
    document.documentElement.style.setProperty('--native-keyboard-bottom', `${inset}px`);
  };
  window.visualViewport?.addEventListener('resize', syncKeyboardInset);
  window.visualViewport?.addEventListener('scroll', syncKeyboardInset);
  window.addEventListener('resize', syncKeyboardInset);
  syncKeyboardInset();

  const defaultConversation = () => ({ id: 'today', title: '今天的灵感', projectName: '', updatedAt: Date.now(), messages: [] });
  const loadConversations = () => {
    const stored = safeJson(localStorage.getItem(STORAGE_KEY), []);
    state.conversations = Array.isArray(stored) ? stored.filter((item) => item && item.id && Array.isArray(item.messages)) : [];
    if (!state.conversations.length) state.conversations = [defaultConversation()];
    if (!state.conversations.some((item) => item.id === state.activeId)) state.activeId = state.conversations[0].id;
  };
  const saveConversations = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.conversations.slice(0, 30))); } catch (_) {} };
  const loadProjects = () => {
    const stored = safeJson(localStorage.getItem(PROJECTS_STORAGE_KEY), []);
    state.projects = Array.isArray(stored) ? stored.filter((item) => item && String(item.name || '').trim()) : [];
    // Older builds only stored the project name on a conversation. Preserve
    // those API projects without importing anything from the Remote iframe.
    const seen = new Set(state.projects.map((item) => String(item.name).trim().toLocaleLowerCase()));
    state.conversations.forEach((conversation) => {
      const name = String(conversation?.projectName || '').trim();
      const key = name.toLocaleLowerCase();
      if (!name || seen.has(key)) return;
      state.projects.push({ id: `api-project-${key.replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 40)}`, name, createdAt: Number(conversation.updatedAt || Date.now()), updatedAt: Number(conversation.updatedAt || Date.now()) });
      seen.add(key);
    });
    saveProjects();
  };
  const saveProjects = () => { try { localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(state.projects.slice(0, 50))); } catch (_) {} };
  const apiProjectByName = (name) => state.projects.find((item) => String(item.name || '').trim().toLocaleLowerCase() === String(name || '').trim().toLocaleLowerCase());
  const apiProjectDate = (project) => {
    const time = Number(project?.updatedAt || project?.createdAt || 0);
    if (!Number.isFinite(time) || time <= 0) return '今天';
    const date = new Date(time); const now = new Date();
    return date.toDateString() === now.toDateString() ? '今天' : `${date.getMonth() + 1}月 ${date.getDate()}日`;
  };
  const formatProjectChatTime = (timestamp) => {
    const time = Number(timestamp || 0); if (!Number.isFinite(time) || time <= 0) return '';
    const date = new Date(time); const now = new Date();
    if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${date.getMonth() + 1}月 ${date.getDate()}日`;
  };
  const activeConversation = () => state.conversations.find((item) => item.id === state.activeId) || state.conversations[0];
  const formatTitle = (value) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > 24 ? `${text.slice(0, 24)}…` : (text || '新对话'); };
  const numericValue = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number;
    }
    return null;
  };
  const estimateTokens = (conversation) => Math.ceil((conversation?.messages || []).reduce((total, message) => total + String(message?.text || '').trim().length, 0) / 2);
  const conversationMetrics = (conversation = activeConversation()) => {
    const usage = conversation?.usage && typeof conversation.usage === 'object' ? conversation.usage : {};
    const total = numericValue(usage.total_tokens, usage.totalTokens, usage.tokens, usage.total) ?? estimateTokens(conversation);
    const limit = numericValue(usage.context_limit, usage.contextLimit, usage.limit) ?? 65536;
    const used = Math.min(limit, numericValue(usage.context_used, usage.contextUsed, total, usage.prompt_tokens, usage.promptTokens) ?? total);
    const cost = numericValue(usage.cost, usage.total_cost, usage.totalCost, conversation?.cost) ?? 0;
    return { total, limit, used, remaining: Math.max(0, limit - used), cost, percent: limit ? Math.min(100, (used / limit) * 100) : 0 };
  };
  const formatNumber = (value) => Number(value || 0).toLocaleString('en-US');
  const formatCost = (value) => `¥${Number(value || 0).toFixed(2)}`;
  const applyUsage = (conversation, payload) => {
    const usage = payload?.usage || payload?.data?.usage;
    if (!conversation || !usage || typeof usage !== 'object') return;
    conversation.usage = { ...(conversation.usage || {}), ...usage };
    const cost = numericValue(usage.cost, usage.total_cost, usage.totalCost);
    if (cost !== null) conversation.cost = cost;
  };
  const renderContextCard = () => {
    const data = conversationMetrics();
    const usedPercent = Math.max(0, Math.round(data.percent));
    const remainingPercent = 100 - usedPercent;
    const setText = (id, value) => { const node = $(id); if (node) node.textContent = value; };
    setText('contextRemaining', `${remainingPercent}%`);
    setText('contextRemainingTokens', formatNumber(data.remaining));
    setText('contextConversationTokens', formatNumber(data.total));
    setText('contextCost', formatCost(data.cost));
    const fill = $('contextProgressFill'); if (fill) fill.style.width = `${usedPercent}%`;
    const dot = document.querySelector('.context-button-dot'); if (dot) dot.style.setProperty('--context-percent', `${usedPercent}%`);
    const ring = $('contextUsageRing'); if (ring) ring.style.setProperty('--context-percent', `${usedPercent}%`);
    const button = $('contextButton'); if (button) button.setAttribute('aria-label', `上下文用量，已使用 ${usedPercent}%，剩余 ${remainingPercent}%`);
  };
  const renderRecentChats = () => {
    const list = document.querySelector('.sidebar-recent-list');
    if (!list) return;
    list.innerHTML = '';
    state.conversations.filter((conversation) => !String(conversation?.projectName || '').trim()).slice().sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 8).forEach((conversation) => {
      const button = document.createElement('button'); button.className = 'sidebar-recent-item'; button.type = 'button'; button.dataset.conversationId = conversation.id; button.textContent = conversation.title || '新对话';
      button.onclick = () => { state.activeId = conversation.id; closeSidebar(); renderMessages(); }; list.appendChild(button);
    });
  };
  const renderMessages = () => {
    const conversation = activeConversation();
    conversationContent.innerHTML = '';
    (conversation?.messages || []).forEach((message) => {
      const node = document.createElement(message.role === 'assistant' ? 'p' : 'div');
      node.className = `${message.role === 'user' ? 'user-message' : 'assistant-message'}${message.pending ? ' is-pending' : ''}${message.error ? ' is-error' : ''}`;
      node.textContent = message.text || (message.pending ? '正在思考…' : '');
      if (message.attachment?.type?.startsWith('image/') && message.attachment.dataUrl) { const image = document.createElement('img'); image.src = message.attachment.dataUrl; image.alt = message.attachment.name || '图片附件'; image.className = 'message-image'; node.append(document.createElement('br'), image); }
      conversationContent.appendChild(node);
    });
    const scroll = $('messageScroll'); if (scroll) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    $('conversationTitle').textContent = conversation?.title || '今天的灵感';
    if ($('featureMenuTitle')) $('featureMenuTitle').textContent = conversation?.title || '今天的灵感';
    setConversationFolder(conversation?.projectName || ''); renderRecentChats(); renderContextCard();
  };

  const showChatPage = () => {
    closeOverlays(); closeSidebar();
    [settingsView, remoteView, apiProjectsView, apiProjectView].forEach((view) => { if (view) view.hidden = true; });
    chatPage.hidden = false; renderMessages();
  };
  const renderApiProjects = () => {
    const list = $('apiProjectsList'); const empty = $('apiProjectsEmpty'); if (!list || !empty) return;
    const query = String($('apiProjectsSearch')?.value || '').trim().toLocaleLowerCase();
    const projects = state.projects.filter((project) => !query || String(project.name || '').toLocaleLowerCase().includes(query));
    list.replaceChildren();
    projects.forEach((project) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'api-project-row'; row.dataset.projectId = String(project.id || '');
      row.innerHTML = '<span class="api-project-row-icon"><img src="../icons/folder2.svg" alt=""></span><span class="api-project-row-copy"><strong class="api-project-row-title"></strong><small class="api-project-row-date"></small></span>';
      row.querySelector('.api-project-row-title').textContent = String(project.name || '项目');
      row.querySelector('.api-project-row-date').textContent = apiProjectDate(project);
      list.append(row);
    });
    empty.hidden = projects.length > 0;
  };
  const renderApiProjectPicker = () => {
    const root = $('apiProjectPickerList'); if (!root) return;
    root.replaceChildren();
    if (!state.projects.length) {
      const empty = document.createElement('p'); empty.className = 'api-project-picker-empty'; empty.textContent = '还没有 API 项目'; root.append(empty); return;
    }
    state.projects.slice(0, 30).forEach((project) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'api-project-picker-row'; row.dataset.projectId = String(project.id || '');
      row.innerHTML = '<img src="../icons/folder2.svg" alt=""><span></span>';
      row.querySelector('span').textContent = String(project.name || '项目'); root.append(row);
    });
  };
  const openApiProjectPicker = () => { closeOverlays(); if (!apiProjectPickerLayer) return; renderApiProjectPicker(); apiProjectPickerLayer.hidden = false; };
  const addActiveChatToApiProject = (project) => {
    const conversation = activeConversation(); if (!conversation || !project) return;
    conversation.projectName = project.name; conversation.updatedAt = Date.now(); project.updatedAt = conversation.updatedAt;
    saveConversations(); saveProjects(); closeOverlays(); renderMessages(); showToast(`已添加到「${project.name}」`);
  };
  const renderApiProject = () => {
    const project = state.selectedProject; if (!project) return;
    const title = $('apiProjectTitle'); if (title) title.textContent = project.name || '项目';
    const meta = $('apiProjectMeta'); if (meta) meta.textContent = 'API 对话';
    const root = $('apiProjectChats'); const empty = $('apiProjectEmpty'); if (!root || !empty) return;
    const query = String($('apiProjectSearch')?.value || '').trim().toLocaleLowerCase();
    const projectKey = String(project.name || '').trim().toLocaleLowerCase();
    const chats = state.conversations.filter((conversation) => String(conversation?.projectName || '').trim().toLocaleLowerCase() === projectKey && (!query || String(conversation.title || '').toLocaleLowerCase().includes(query))).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    root.replaceChildren();
    chats.forEach((conversation) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'api-project-chat-row'; row.dataset.conversationId = String(conversation.id || '');
      row.innerHTML = '<span class="api-project-chat-title"></span><time class="api-project-chat-time"></time>';
      row.querySelector('.api-project-chat-title').textContent = conversation.title || '新对话';
      row.querySelector('.api-project-chat-time').textContent = formatProjectChatTime(conversation.updatedAt);
      root.append(row);
    });
    empty.hidden = chats.length > 0;
  };
  const showApiProjects = () => {
    closeOverlays(); closeSidebar();
    [chatPage, settingsView, remoteView, apiProjectView].forEach((view) => { if (view) view.hidden = true; });
    apiProjectsView.hidden = false; renderApiProjects();
  };
  const showApiProject = (project) => {
    if (!project) return;
    closeOverlays(); closeSidebar(); state.selectedProject = project;
    [chatPage, settingsView, remoteView, apiProjectsView].forEach((view) => { if (view) view.hidden = true; });
    apiProjectView.hidden = false; renderApiProject();
  };
  const openApiProjectCreate = () => {
    closeOverlays(); if (!apiProjectCreateLayer) return;
    apiProjectCreateLayer.hidden = false; const input = $('apiProjectNameInput'); if (input) { input.value = ''; setTimeout(() => input.focus(), 0); }
  };
  const closeApiProjectCreate = () => { if (apiProjectCreateLayer) apiProjectCreateLayer.hidden = true; };
  const createApiProject = () => {
    const input = $('apiProjectNameInput'); const name = String(input?.value || '').trim();
    if (!name) { showToast('请输入项目名称'); input?.focus(); return; }
    const existing = apiProjectByName(name);
    if (existing) { closeApiProjectCreate(); showApiProject(existing); showToast('已打开这个项目'); return; }
    const now = Date.now(); const project = { id: `api-project-${now}`, name, createdAt: now, updatedAt: now };
    state.projects.unshift(project); saveProjects(); closeApiProjectCreate(); showApiProject(project); showToast('项目已创建');
  };
  const startApiProjectChat = () => {
    const project = state.selectedProject; if (!project) return;
    const id = `api-chat-${Date.now()}`;
    state.conversations.unshift({ id, title: '新对话', projectName: project.name, updatedAt: Date.now(), messages: [] });
    state.activeId = id; saveConversations(); showChatPage(); messageInput?.focus();
  };
  const startOrdinaryChat = () => {
    const id = `api-chat-${Date.now()}`;
    state.conversations.unshift({ id, title: '新对话', projectName: '', updatedAt: Date.now(), messages: [] });
    state.activeId = id; saveConversations(); showChatPage(); messageInput?.focus(); showToast('已打开新对话');
  };

  const closeOverlays = () => { attachmentLayer.hidden = true; featureLayer.hidden = true; if (apiProjectPickerLayer) apiProjectPickerLayer.hidden = true; if (chatSelectorLayer) chatSelectorLayer.hidden = true; if (contextLayer) contextLayer.hidden = true; closeApiProjectCreate(); $('attachmentButton')?.setAttribute('aria-expanded', 'false'); $('featureButton')?.setAttribute('aria-expanded', 'false'); $('chatModelButton')?.setAttribute('aria-expanded', 'false'); $('chatEffortButton')?.setAttribute('aria-expanded', 'false'); $('contextButton')?.setAttribute('aria-expanded', 'false'); };
  const closeSidebar = () => { sidebarLayer.hidden = true; $('menuButton')?.setAttribute('aria-expanded', 'false'); };
  const openSidebar = () => { closeOverlays(); sidebarLayer.hidden = false; $('menuButton')?.setAttribute('aria-expanded', 'true'); };
  const showRemoteView = (route = 'remote') => { closeOverlays(); closeSidebar(); closeApiProjectCreate(); [settingsView, chatPage, apiProjectsView, apiProjectView].forEach((view) => { if (view) view.hidden = true; }); remoteView.hidden = false; syncRemoteFrameInsets(); requestRemoteRoute(route); };
  const showSettingsView = (returnView = 'chat') => { closeOverlays(); closeSidebar(); closeApiProjectCreate(); state.settingsReturnView = returnView === 'remote' ? 'remote' : 'chat'; remoteView.hidden = true; chatPage.hidden = true; apiProjectsView.hidden = true; apiProjectView.hidden = true; settingsView.hidden = false; loadConfigIntoForm(); };
  const closeSettingsView = () => { settingsView.hidden = true; if (state.settingsReturnView === 'remote') { remoteView.hidden = false; chatPage.hidden = true; syncRemoteFrameInsets(); return; } remoteView.hidden = true; apiProjectsView.hidden = true; apiProjectView.hidden = true; chatPage.hidden = false; renderMessages(); };
  const openOverlay = (layer, trigger) => { closeOverlays(); layer.hidden = false; trigger?.setAttribute('aria-expanded', 'true'); };

  const setApiStatus = (message, kind = '') => { const node = $('apiSettingsStatus'); node.textContent = message || ''; node.className = `api-settings-status${kind ? ` ${kind}` : ''}`; };
  const updateApiDot = (stateName) => { const dot = $('apiStatusDot'); if (!dot) return; dot.className = `api-status-dot ${stateName}`; dot.setAttribute('aria-label', stateName === 'online' ? '已配置' : stateName === 'testing' ? '测试中' : '未配置'); };
  const effortLabel = (value) => ({ auto: '自动', high: '高', max: '最高' }[String(value || 'auto')] || '自动');
  const syncChatSelectors = () => {
    const model = String(state.api.model || 'deepseek-chat');
    const modelLabel = $('chatModelLabel'); if (modelLabel) modelLabel.textContent = model;
    const effortLabelNode = $('chatEffortLabel'); if (effortLabelNode) effortLabelNode.textContent = effortLabel(state.selectedEffort);
    document.querySelectorAll('[data-chat-model]').forEach((button) => button.classList.toggle('is-selected', button.dataset.chatModel === model));
    document.querySelectorAll('[data-chat-effort]').forEach((button) => button.classList.toggle('is-selected', button.dataset.chatEffort === (state.selectedEffort || 'auto')));
  };
  const renderApiModels = () => {
    const root = $('chatModelOptions'); if (!root) return;
    const models = [...new Set((Array.isArray(state.apiModels) ? state.apiModels : []).map((item) => String(item || '').trim()).filter(Boolean))];
    root.replaceChildren(...models.map((model) => {
      const row = document.createElement('button'); row.className = 'selector-row'; row.type = 'button'; row.dataset.selectorGroup = 'model'; row.dataset.chatModel = model;
      const label = document.createElement('span'); label.textContent = model; const tick = document.createElement('i'); tick.setAttribute('aria-hidden', 'true'); tick.textContent = '✓'; row.append(label, tick); return row;
    }));
    syncChatSelectors();
  };
  const persistChatSelection = () => { try { const config = { ...state.api, effort: state.selectedEffort || 'auto' }; native?.saveApiConfig?.(JSON.stringify(config)); localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch (_) {} };
  const openChatSelector = (trigger, mode = '') => { closeOverlays(); if (!chatSelectorLayer) return; const selectedMode = mode || (trigger?.id === 'chatEffortButton' ? 'effort' : 'model'); const popover = chatSelectorLayer.querySelector('.chat-selector-popover'); if (popover) popover.dataset.mode = selectedMode; chatSelectorLayer.hidden = false; trigger?.setAttribute('aria-expanded', 'true'); syncChatSelectors(); };
  const openContextCard = () => { closeOverlays(); if (!contextLayer) return; renderContextCard(); contextLayer.hidden = false; $('contextButton')?.setAttribute('aria-expanded', 'true'); };
  const loadApiConfig = () => {
    let stored = null; try { stored = native?.getApiConfig?.() || localStorage.getItem(CONFIG_KEY); } catch (_) {}
    const config = safeJson(stored, {}); state.api = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) }; if (!state.api.base_url) state.api.base_url = DEFAULT_CONFIG.base_url; state.selectedEffort = String(config?.effort || 'auto'); if (state.api.model) state.apiModels = [...new Set([...state.apiModels, String(state.api.model)])]; renderApiModels();
  };
  const loadConfigIntoForm = () => { $('apiBaseInput').value = state.api.base_url || DEFAULT_CONFIG.base_url; $('apiKeyInput').value = state.api.api_key || ''; updateApiDot(state.api.api_key ? 'online' : 'offline'); syncChatSelectors(); if (!$('apiSettingsStatus').textContent) setApiStatus(state.api.api_key ? '已配置 DeepSeek API' : '尚未配置 API Key'); };
  const saveApiConfig = () => {
    const config = { base_url: normalizeApiBase($('apiBaseInput').value || ''), api_key: String($('apiKeyInput').value || '').trim(), model: String(state.api.model || 'deepseek-chat').trim(), system_prompt: state.api.system_prompt || '', effort: state.selectedEffort || 'auto' };
    if (!config.base_url) { setApiStatus('请填写 API 地址', 'error'); return false; }
    if (!/^https?:\/\//i.test(config.base_url)) { setApiStatus('API 地址必须以 http:// 或 https:// 开头', 'error'); return false; }
    state.api = config; try { native?.saveApiConfig?.(JSON.stringify(config)); localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch (_) {}
    updateApiDot(config.api_key ? 'online' : 'offline'); setApiStatus(config.api_key ? '配置已保存，可开始聊天' : '地址已保存，请填写 API Key 后再发送', config.api_key ? 'success' : ''); return true;
  };

  const renderAttachment = () => {
    if (!state.pendingAttachment) { attachmentPreview.hidden = true; attachmentPreview.innerHTML = ''; return; }
    const attachment = state.pendingAttachment; attachmentPreview.hidden = false; attachmentPreview.innerHTML = '';
    const chip = document.createElement('div'); chip.className = 'attachment-chip';
    if (attachment.dataUrl && attachment.type.startsWith('image/')) { const image = document.createElement('img'); image.src = attachment.dataUrl; image.alt = ''; chip.appendChild(image); }
    const label = document.createElement('span'); label.textContent = attachment.name || '附件'; chip.appendChild(label);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.setAttribute('aria-label', '移除附件'); remove.textContent = '×'; remove.onclick = clearAttachment; attachmentPreview.append(chip, remove);
  };
  const clearAttachment = () => { state.pendingAttachment = null; attachmentInput.value = ''; renderAttachment(); };
  const readFile = (file) => new Promise((resolve) => {
    if (!file || !file.type.startsWith('image/')) { resolve({ name: file?.name || '附件', type: file?.type || 'application/octet-stream', size: file?.size || 0 }); return; }
    const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, type: file.type, size: file.size, dataUrl: String(reader.result || '') }); reader.onerror = () => resolve({ name: file.name, type: file.type, size: file.size }); reader.readAsDataURL(file);
  });
  const setAttachment = async (file) => { state.pendingAttachment = await readFile(file); renderAttachment(); messageInput.focus(); };
  window.addEventListener('native-file-picked', (event) => { const data = event.detail?.data || {}; if (data.error) { showToast(data.message || '图片处理失败'); return; } const dataUrl = data.dataUrl || (data.data ? `data:${data.mediaType || 'image/jpeg'};base64,${data.data}` : ''); if (dataUrl) { state.pendingAttachment = { name: data.name || 'photo.jpg', type: data.mediaType || 'image/jpeg', dataUrl }; renderAttachment(); } });

  const normalizeApiBase = (value) => String(value || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  const apiEndpoint = () => `${normalizeApiBase(state.api.base_url || DEFAULT_CONFIG.base_url)}/chat/completions`;
  const buildMessages = (conversation) => {
    const messages = []; if (state.api.system_prompt) messages.push({ role: 'system', content: state.api.system_prompt });
    (conversation.messages || []).filter((item) => !item.pending && item.text).forEach((item) => { const content = item.attachment?.dataUrl && item.attachment.type?.startsWith('image/') ? [{ type: 'text', text: item.text || '请看这张图片。' }, { type: 'image_url', image_url: { url: item.attachment.dataUrl } }] : item.text; messages.push({ role: item.role, content }); });
    return messages;
  };
  const handleApiEvent = (name, raw) => {
    const data = safeJson(raw, raw || {}); const request = state.request; if (!request) return;
    applyUsage(request.conversation, data);
    const finish = () => { if (request.watchdog) { clearTimeout(request.watchdog); request.watchdog = null; } };
    if (name === 'delta' || name === 'reasoning') { if (name === 'delta') request.assistant.text += String(data.text || ''); request.assistant.pending = false; renderMessages(); return; }
    if (name === 'done' || name === 'complete') { finish(); if (name === 'complete') request.assistant.text = String(data.text || request.assistant.text || ''); request.assistant.pending = false; state.request = null; request.conversation.updatedAt = Date.now(); saveConversations(); renderMessages(); showToast('DeepSeek 已回复'); return; }
    if (name === 'error') { finish(); request.assistant.pending = false; request.assistant.error = true; request.assistant.text = request.assistant.text || `生成失败：${String(data.message || '请检查 API 配置')}`; state.request = null; saveConversations(); renderMessages(); showToast(String(data.message || 'DeepSeek 请求失败')); }
  };
  window.DeepSeekEvents = { onEvent: handleApiEvent };
  const sendNativeApi = (conversation) => { if (!native || typeof native.streamChat !== 'function') return false; native.streamChat(JSON.stringify({ url: apiEndpoint(), apiKey: state.api.api_key, payload: { model: state.api.model || 'deepseek-chat', messages: buildMessages(conversation), stream: true } })); return true; };
  const sendBrowserApi = async (conversation, request) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch(apiEndpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(state.api.api_key ? { Authorization: `Bearer ${state.api.api_key}` } : {}) }, body: JSON.stringify({ model: state.api.model || 'deepseek-chat', messages: buildMessages(conversation), stream: true }), signal: controller.signal });
      if (!response.ok) { const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim(); throw new Error(`API ${response.status}${detail ? `：${detail.slice(0, 240)}` : ''}`); }
      if (!response.body) { const json = await response.json(); applyUsage(conversation, json); request.assistant.text = json?.choices?.[0]?.message?.content || ''; return; }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let finished = false;
      const consume = (flush = false) => {
        const blocks = buffer.split(/\r?\n\r?\n/);
        if (flush) { buffer = ''; } else { buffer = blocks.pop() || ''; }
        blocks.forEach((block) => {
          const value = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
          if (!value) return;
          if (value === '[DONE]') { finished = true; return; }
          const parsed = safeJson(value, null); if (!parsed) return;
          applyUsage(conversation, parsed);
          const delta = parsed?.choices?.[0]?.delta || {};
          const text = delta.content || '';
          if (text) { request.assistant.pending = false; request.assistant.text += String(text); renderMessages(); }
        });
      };
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); consume(false); }
      buffer += decoder.decode();
      if (buffer.trim()) consume(true);
      if (!finished && !request.assistant.text) throw new Error('API 返回了空回复');
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('API 回复超时，请检查网络或稍后重试');
      throw error;
    } finally { clearTimeout(timeout); }
  };
  const browserModelEndpoints = (base) => {
    const value = normalizeApiBase(base);
    const root = value.replace(/\/v1$/i, '');
    return [...new Set([`${value}/models`, `${root}/v1/models`])];
  };
  const testBrowserApi = async () => {
    const base = normalizeApiBase(state.api.base_url);
    const headers = state.api.api_key ? { Authorization: `Bearer ${state.api.api_key}` } : {};
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let lastError = null;
    try {
      for (const endpoint of browserModelEndpoints(base)) {
        try {
          const response = await fetch(endpoint, { headers, signal: controller.signal });
          if (!response.ok) {
            const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim();
            throw new Error(`API ${response.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
          }
          const body = await response.json().catch(() => ({}));
          const models = Array.isArray(body?.data)
            ? body.data.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean)
            : [];
          if (models.length) return models;
          lastError = new Error('模型列表为空');
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          lastError = error;
        }
      }
      const response = await fetch(apiEndpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ model: state.api.model || 'deepseek-chat', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }), signal: controller.signal });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim();
        throw new Error(`API ${response.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
      }
      return [];
    } finally {
      clearTimeout(timeout);
    }
  };
  const sendMessage = async () => {
    if (state.request) { showToast('上一条消息还在生成，请稍候'); return; }
    const value = messageInput.value.trim(); if (!value && !state.pendingAttachment) { showToast('先输入一条消息'); messageInput.focus(); return; }
    const conversation = activeConversation(); const attachment = state.pendingAttachment ? { ...state.pendingAttachment } : null; const user = { role: 'user', text: value, attachment }; conversation.messages.push(user);
    if (conversation.messages.filter((item) => item.role === 'user').length === 1 || conversation.title === '今天的灵感') conversation.title = formatTitle(value || attachment?.name || '图片对话');
    conversation.updatedAt = Date.now(); const assistant = { role: 'assistant', text: '', pending: true }; conversation.messages.push(assistant); state.pendingAttachment = null; attachmentInput.value = ''; messageInput.value = ''; messageInput.style.height = '42px'; renderAttachment(); renderMessages();
    if (!state.api.api_key) { assistant.pending = false; assistant.error = true; assistant.text = '还没有配置 API Key，请到设置中完成配置后再发送。'; saveConversations(); renderMessages(); showToast('请先配置 API Key'); showSettingsView(); return; }
    const request = { conversation, assistant }; state.request = request; saveConversations();
    try {
      if (sendNativeApi(conversation)) {
        // 原生流式通道是异步的：Java 侧稍后通过 DeepSeekEvents.onEvent 回传
        // delta / reasoning / done / error。这里绝不能立即清空 state.request 或
        // 撤销 pending，否则回传事件会被 handleApiEvent 开头（state.request 为空）
        // 直接丢弃，导致发送后始终不回复（旧版 bug）。
        // 兜底看门狗：超出 Java 侧读取超时（180s）仍未完成时，转为可见错误。
        request.watchdog = setTimeout(() => {
          if (state.request !== request) return;
          assistant.pending = false; assistant.error = true;
          assistant.text = assistant.text || '生成失败：等待回复超时，请检查网络后重试';
          state.request = null; saveConversations(); renderMessages(); showToast('DeepSeek 请求超时');
        }, 190_000);
      } else {
        await sendBrowserApi(conversation, request);
        if (state.request === request) { assistant.pending = false; state.request = null; saveConversations(); renderMessages(); }
      }
    }
    catch (error) { if (state.request !== request) return; assistant.pending = false; assistant.error = true; assistant.text = `生成失败：${error.message || '网络请求失败'}`; state.request = null; saveConversations(); renderMessages(); showToast('DeepSeek 请求失败'); }
  };

  const setApiTestBusy = (busy) => { $('apiTestButton').disabled = busy; $('apiSaveButton').disabled = busy; updateApiDot(busy ? 'testing' : (state.api.api_key ? 'online' : 'offline')); };
  const testApi = () => {
    if (!saveApiConfig()) return; setApiTestBusy(true); setApiStatus('正在测试连接…');
    const request = JSON.stringify({ base_url: state.api.base_url, api_key: state.api.api_key, model: state.api.model });
    if (native?.testApi) { state.apiTestPending = true; native.testApi(request); return; }
    testBrowserApi().then((models) => { if (models.length) { state.apiModels = models; if (!models.includes(state.api.model)) state.api.model = models[0]; renderApiModels(); persistChatSelection(); } setApiStatus(models.length ? `连接成功 · ${models.length} 个模型` : '连接成功', 'success'); }).catch((error) => { const message = error?.name === 'AbortError' ? 'API 检测超时，请检查网络' : error.message; setApiStatus(`连接失败：${message}`, 'error'); }).finally(() => { state.apiTestPending = false; setApiTestBusy(false); });
  };
  const handleFeatureAction = (action) => {
    const conversation = activeConversation();
    closeOverlays();
    if (!conversation) return;
    if (action === 'pin') {
      conversation.pinned = !conversation.pinned; conversation.updatedAt = Date.now(); saveConversations(); renderRecentChats(); showToast(conversation.pinned ? '已置顶当前对话' : '已取消置顶'); return;
    }
    if (action === 'project') { if (conversation.projectName) { showToast(`已在项目「${conversation.projectName}」中`); return; } if (!state.projects.length) { showApiProjects(); openApiProjectCreate(); return; } openApiProjectPicker(); return; }
    if (action === 'files') { const count = (conversation.messages || []).filter((message) => message.attachment).length; showToast(count ? `本对话有 ${count} 个已上传文件` : '本对话暂无已上传文件'); return; }
    if (action === 'find') { showToast('可在聊天内容中查找'); messageInput.focus(); return; }
    if (action === 'archive') { conversation.archived = true; conversation.updatedAt = Date.now(); saveConversations(); showToast('已归档当前对话'); return; }
    if (action === 'delete') {
      if (state.conversations.length <= 1) { conversation.messages = []; conversation.title = '今天的灵感'; conversation.projectName = ''; conversation.usage = {}; conversation.updatedAt = Date.now(); }
      else { state.conversations = state.conversations.filter((item) => item.id !== conversation.id); state.activeId = state.conversations[0]?.id || 'today'; }
      saveConversations(); renderMessages(); showToast('已删除当前对话');
    }
  };
  const baseApiHandler = window.DeepSeekEvents.onEvent;
  window.DeepSeekEvents.onEvent = (name, raw) => { if (name === 'test' && state.apiTestPending) { const data = safeJson(raw, {}); const models = Array.isArray(data.models) ? data.models.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean) : []; if (models.length) { state.apiModels = models; if (!models.includes(state.api.model)) state.api.model = models[0]; renderApiModels(); persistChatSelection(); } setApiStatus(data.ok ? (data.message || '连接成功') : (data.message || '连接失败'), data.ok ? 'success' : 'error'); setApiTestBusy(false); state.apiTestPending = false; updateApiDot(data.ok ? 'online' : 'offline'); return; } baseApiHandler(name, raw); };

  $('attachmentButton').onclick = () => openOverlay(attachmentLayer, $('attachmentButton')); $('featureButton').onclick = () => openOverlay(featureLayer, $('featureButton')); $('contextButton').onclick = openContextCard; $('chatModelButton').onclick = () => openChatSelector($('chatModelButton'), 'model'); $('chatEffortButton').onclick = () => openChatSelector($('chatEffortButton'), 'effort'); document.querySelectorAll('[data-close-overlay]').forEach((node) => { node.onclick = closeOverlays; });
  document.querySelectorAll('[data-feature-action]').forEach((button) => { button.onclick = () => handleFeatureAction(button.dataset.featureAction || ''); });
  $('apiProjectPickerList')?.addEventListener('click', (event) => { const row = event.target.closest('.api-project-picker-row'); if (!row) return; addActiveChatToApiProject(state.projects.find((project) => String(project.id) === String(row.dataset.projectId))); });
  $('apiProjectPickerCreate')?.addEventListener('click', () => { closeOverlays(); openApiProjectCreate(); });
  $('chatModelOptions')?.addEventListener('click', (event) => { const button = event.target.closest('[data-chat-model]'); if (!button) return; state.api.model = button.dataset.chatModel || 'deepseek-chat'; persistChatSelection(); syncChatSelectors(); closeOverlays(); showToast(`已切换到 ${state.api.model}`); });
  document.querySelectorAll('[data-chat-effort]').forEach((button) => { button.onclick = () => { state.selectedEffort = button.dataset.chatEffort || 'auto'; persistChatSelection(); syncChatSelectors(); closeOverlays(); showToast(`思考等级：${effortLabel(state.selectedEffort)}`); }; });
  document.querySelectorAll('[data-attachment-kind]').forEach((button) => { button.onclick = () => { closeOverlays(); attachmentInput.accept = button.dataset.attachmentKind === 'image' ? 'image/*' : '*/*'; attachmentInput.click(); }; });
  attachmentInput.onchange = () => { const file = attachmentInput.files?.[0]; if (file) setAttachment(file); };
  $('menuButton').onclick = openSidebar; document.querySelectorAll('[data-close-sidebar]').forEach((node) => { node.onclick = closeSidebar; });
  $('sidebarProjectsButton')?.addEventListener('click', showApiProjects); $('sidebarNewChatButton')?.addEventListener('click', startOrdinaryChat); $('sidebarSettingsButton').onclick = () => showSettingsView('chat'); $('sidebarRemoteButton').onclick = () => showRemoteView('remote');
  $('apiProjectsBackButton')?.addEventListener('click', showChatPage);
  $('apiProjectsAddButton')?.addEventListener('click', openApiProjectCreate);
  $('apiProjectsSearch')?.addEventListener('input', renderApiProjects);
  $('apiProjectsList')?.addEventListener('click', (event) => { const row = event.target.closest('.api-project-row'); if (!row) return; showApiProject(state.projects.find((project) => String(project.id) === String(row.dataset.projectId))); });
  $('apiProjectBackButton')?.addEventListener('click', showApiProjects);
  $('apiProjectSearch')?.addEventListener('input', renderApiProject);
  $('apiProjectChats')?.addEventListener('click', (event) => { const row = event.target.closest('.api-project-chat-row'); if (!row) return; state.activeId = String(row.dataset.conversationId || ''); showChatPage(); });
  $('apiProjectComposeButton')?.addEventListener('click', startApiProjectChat);
  $('apiProjectCreateScrim')?.addEventListener('click', closeApiProjectCreate);
  $('apiProjectCreateCancel')?.addEventListener('click', closeApiProjectCreate);
  $('apiProjectCreateConfirm')?.addEventListener('click', createApiProject);
  $('apiProjectNameInput')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); createApiProject(); } if (event.key === 'Escape') closeApiProjectCreate(); });
  $('shellSettingsCheckUpdateButton')?.addEventListener('click', () => {
    const remoteUpdateButton = remoteFrame?.contentDocument?.getElementById('updateButton');
    if (!remoteUpdateButton) { showToast('更新服务尚未就绪，请稍后重试'); return; }
    setShellUpdateIcon(shellUpdateMode, true);
    try { remoteUpdateButton.click(); showToast(shellUpdateMode === 'download' ? '正在下载更新…' : '正在检查更新…'); }
    catch (_) { setShellUpdateIcon(shellUpdateMode, false); showToast('暂时无法检查更新'); }
  });
  $('settingsBackButton').onclick = closeSettingsView;
  document.querySelectorAll('[data-project-name]').forEach((button) => { button.onclick = () => { const project = button.dataset.projectName || ''; const conversation = activeConversation(); conversation.projectName = project; conversation.updatedAt = Date.now(); saveConversations(); showToast(`已选择项目：${project}`); renderMessages(); }; });
  $('composer').onsubmit = (event) => { event.preventDefault(); sendMessage(); }; messageInput.oninput = () => { messageInput.style.height = '42px'; messageInput.style.height = `${Math.min(112, messageInput.scrollHeight)}px`; }; $('apiSaveButton').onclick = saveApiConfig; $('apiTestButton').onclick = testApi;
  messageInput.onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } };
  window.addEventListener('keydown', (event) => { if (event.key !== 'Escape') return; if (!settingsView.hidden) closeSettingsView(); else { closeOverlays(); closeSidebar(); } });
  window.handleSystemBack = () => {
    if (!settingsView.hidden) { closeSettingsView(); return true; }
    if (apiProjectCreateLayer && !apiProjectCreateLayer.hidden) { closeApiProjectCreate(); return true; }
    if (apiProjectPickerLayer && !apiProjectPickerLayer.hidden) { closeOverlays(); return true; }
    if (apiProjectView && !apiProjectView.hidden) { showApiProjects(); return true; }
    if (apiProjectsView && !apiProjectsView.hidden) { showChatPage(); return true; }
    if (!remoteView.hidden) {
      try {
        const innerHandler = remoteFrame?.contentWindow?.handleSystemBack;
        if (typeof innerHandler === 'function' && innerHandler()) return true;
      } catch (_) {}
      window.DshShellBack();
      return true;
    }
    if (!sidebarLayer.hidden) { closeSidebar(); return true; }
    if (!attachmentLayer.hidden || !featureLayer.hidden || !chatSelectorLayer?.hidden || !contextLayer?.hidden) { closeOverlays(); return true; }
    return false;
  };

  loadConversations(); loadProjects(); loadApiConfig(); renderMessages();
})();
