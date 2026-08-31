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
  const groupSettingEditorLayer = $('groupSettingEditorLayer');
  const sidebarLayer = $('sidebarLayer');
  const chatPage = $('chatPage');
  const remoteView = $('remoteView');
  const settingsView = $('settingsView');
  const groupSettingsView = $('groupSettingsView');
  const scheduleView = $('scheduleView');
  const apiProjectsView = $('apiProjectsView');
  const apiProjectView = $('apiProjectView');
  const apiProjectCreateLayer = $('apiProjectCreateLayer');
  const apiProjectPickerLayer = $('apiProjectPickerLayer');
  const projectMenuLayer = $('projectMenuLayer');
  const projectMenuPopover = $('projectMenuPopover');
  const apiProjectNoteLayer = $('apiProjectNoteLayer');
  const conversationRenameLayer = $('conversationRenameLayer');
  const splash = $('splash');
  let splashDone = false;
  let keepComposerKeyboard = false;
  let exitBackDeadline = 0;
  let shouldPlaySplash = false;
  try {
    shouldPlaySplash = !isBrowserPreview && !sessionStorage.getItem('magic5.chat.splash-shown');
    if (shouldPlaySplash) sessionStorage.setItem('magic5.chat.splash-shown', '1');
  } catch (_) { shouldPlaySplash = !isBrowserPreview; }
  const finishSplash = () => {
    if (splashDone) return;
    splashDone = true;
    if (splash) splash.hidden = true;
    if (chatPage.hidden) chatPage.hidden = false;
    requestTitleMarqueeMeasure();
  };

  const DEFAULT_CONFIG = { base_url: 'https://api.deepseek.com', api_key: '', model: 'deepseek-chat', system_prompt: '' };
  const STORAGE_KEY = 'deepseek.chat.conversations.v3';
  const PROJECTS_STORAGE_KEY = 'deepseek.chat.projects.v2';
  const CONFIG_KEY = 'deepseek.chat.api.v1';
  const API_MODELS_KEY = 'deepseek.chat.api.models.v1';
  const GROUP_SETTINGS_KEY = 'deepseek.chat.group.settings.v1';
  const DEFAULT_GROUP_SETTINGS = {
    chat: { model: 'deepseek-chat', effort: 'auto', prompt: '' },
    reasoner: { model: 'deepseek-reasoner', effort: 'auto', prompt: '' },
  };
  const state = { conversations: [], projects: [], activeId: 'today', selectedProject: null, api: { ...DEFAULT_CONFIG }, apiModels: ['deepseek-chat', 'deepseek-reasoner'], selectedEffort: 'auto', groupSettings: {}, groupEditor: null, projectName: '', pendingAttachment: null, request: null, toastTimer: null, pendingRemoteMessages: [], pendingRemoteRoute: '', apiTestPending: false, settingsReturnView: 'chat', menuProjectId: '', projectRenameId: '', projectNoteId: '', longPressActive: false };
  const scheduleToday = new Date();
  let scheduleMonthCursor = new Date(scheduleToday.getFullYear(), scheduleToday.getMonth(), 1);

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
  window.DshShellBack = () => { remoteView.hidden = true; settingsView.hidden = true; groupSettingsView.hidden = true; if (scheduleView) scheduleView.hidden = true; chatPage.hidden = false; renderMessages(); };
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
  // P0 BUG-005: 旧版 clearLegacyDemoState 会在升级后整键删除全部会话/项目/群聊
  // 存储，属于破坏性清理。现改为正式迁移入口：先写完整快照备份（可审计回滚），
  // 再按"精确演示签名"只剔除已知的演示对话行，用户真实数据一律保留。
  const MIGRATION_MARKER = 'deepseek.chat.migration.v2.done';
  const MIGRATION_BACKUP = 'deepseek.chat.migration.v2.backup';
  const MIGRATION_KEYS = [
    STORAGE_KEY,
    PROJECTS_STORAGE_KEY,
    'deepseek.chat.conversations.v2',
    'deepseek.chat.projects.v1',
    'dsh.group.conversations.v1',
    'deepseek.chat.group.settings.v1',
  ];
  // 仅当某条对话与历史演示种子完全一致（两三条、逐字匹配）时才视为演示数据。
  const DEMO_SEED_TEXTS = ['帮我整理一下今天的想法', '好的，我先把你的想法整理成几个清晰的方向。'];
  const isSeedDemoConversation = (row) => Array.isArray(row?.messages)
    && row.messages.length === 2
    && row.messages.every((message, index) => String(message?.text || '') === DEMO_SEED_TEXTS[index] && !message?.attachment);
  const migrateLegacyState = () => {
    try {
      if (localStorage.getItem(MIGRATION_MARKER) === '1') return;
      const snapshot = {};
      MIGRATION_KEYS.forEach((key) => {
        const raw = localStorage.getItem(key);
        if (raw != null) snapshot[key] = raw;
      });
      try { localStorage.setItem(MIGRATION_BACKUP, JSON.stringify(snapshot)); } catch (_) {}
      [STORAGE_KEY, 'deepseek.chat.conversations.v2'].forEach((key) => {
        const raw = localStorage.getItem(key);
        if (raw == null) return;
        let rows;
        try { rows = JSON.parse(raw); } catch (_) { return; }
        if (!Array.isArray(rows)) return;
        const filtered = rows.filter((row) => !isSeedDemoConversation(row));
        if (filtered.length !== rows.length) {
          try { localStorage.setItem(key, JSON.stringify(filtered)); } catch (_) {}
        }
      });
      localStorage.setItem(MIGRATION_MARKER, '1');
    } catch (_) {}
  };
  const loadConversations = () => {
    const stored = safeJson(localStorage.getItem(STORAGE_KEY), []);
    const valid = Array.isArray(stored) ? stored.filter((item) => item && item.id && Array.isArray(item.messages)) : [];
    state.conversations = valid;
    if (!state.conversations.length) state.conversations = [defaultConversation()];
    if (!state.conversations.some((item) => item.id === state.activeId)) state.activeId = state.conversations[0].id;
  };
  // 草稿（_draft: true）只存在内存，绝不写入 localStorage：新建对话后即使一个字
  // 都没发，切走重进也不会在最近聊天里残留空对话；发送首条消息时才转正落库。
  const saveConversations = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.conversations.filter((item) => !item._draft).slice(0, 30))); } catch (_) {} };
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
  const isGroupConversation = (conversation) => Boolean(conversation?.isGroup === true || String(conversation?.kind || '').toLowerCase() === 'group' || String(conversation?.title || '').trim() === '项目讨论群');
  const groupMemberCount = (conversation) => {
    const explicit = Number(conversation?.memberCount);
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
    if (Array.isArray(conversation?.members) && conversation.members.length) return conversation.members.length;
    return 6;
  };
  const formatTitle = (value) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > 24 ? `${text.slice(0, 24)}…` : (text || '新对话'); };
  const numericValue = (...values) => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return number;
    }
    return null;
  };
  const estimateTokens = (conversation) => Math.ceil((conversation?.messages || []).reduce((total, message) => total + String(message?.text || '').trim().length, 0) / 2);
  // DeepSeek 官方峰谷价（元 / 百万 tokens，2026-08-17 起生效）：
  // 高峰=每日 9:00–12:00、14:00–18:00（北京时间）；空闲=其余时间，价格减半。
  // deepseek-chat / deepseek-reasoner 已并入 V4-Flash 计费。
  const PRICE_TABLE = [
    { test: /v4-pro|deepseek-pro/, valley: { hit: 0.15, miss: 4.5, output: 13.5 }, peak: { hit: 0.3, miss: 9, output: 27 } },
    { test: /v4-flash|deepseek-chat|deepseek-reasoner|flash/, valley: { hit: 0.05, miss: 1.5, output: 4.5 }, peak: { hit: 0.1, miss: 3, output: 9 } },
  ];
  const DEFAULT_PRICE = { valley: { hit: 0.05, miss: 1.5, output: 4.5 }, peak: { hit: 0.1, miss: 3, output: 9 } };
  // 模型上下文窗口：DeepSeek V4 家族（V4 Flash / V4 Pro / vision-exp，含
  // deepseek-chat / deepseek-reasoner 别名）上下文均为 1,048,576 tokens（1M），
  // 最大输出 393,216（384K）。未收录模型回退旧默认 64K（仅估算展示用；
  // API 若通过 usage 下发 context_limit / contextLimit / limit 则优先采用）。
  const MODEL_CONTEXT_WINDOWS = [
    { test: /v4|deepseek-chat|deepseek-reasoner|flash|pro/, limit: 1_048_576 },
  ];
  const contextLimitFor = (model) => {
    const name = String(model || '').toLowerCase();
    const entry = MODEL_CONTEXT_WINDOWS.find((rule) => rule.test.test(name));
    return entry ? entry.limit : 65536;
  };
  const PEAK_HOURS = [[9, 12], [14, 18]];
  const isPeakNow = (date = new Date()) => { const beijing = new Date(date.getTime() + 8 * 3600_000); const hour = beijing.getUTCHours(); return PEAK_HOURS.some(([start, end]) => hour >= start && hour < end); };
  const priceFor = (model, when = new Date()) => {
    const override = (state.api && state.api.prices) || {};
    const hit = Number(override.hit); const miss = Number(override.miss); const output = Number(override.output);
    if ([hit, miss, output].some((value) => Number.isFinite(value) && value > 0)) {
      const fallback = priceForTable(model, when);
      return { hit: Number.isFinite(hit) && hit > 0 ? hit : fallback.hit, miss: Number.isFinite(miss) && miss > 0 ? miss : fallback.miss, output: Number.isFinite(output) && output > 0 ? output : fallback.output, kind: 'custom' };
    }
    return priceForTable(model, when);
  };
  const priceForTable = (model, when) => {
    const name = String(model || '').toLowerCase();
    const entry = PRICE_TABLE.find((rule) => rule.test.test(name));
    const rates = entry || DEFAULT_PRICE;
    const kind = isPeakNow(when) ? 'peak' : 'valley';
    return { ...(rates[kind] || rates.valley), kind };
  };
  const usageTokens = (usage) => {
    const source = usage && typeof usage === 'object' ? usage : {};
    const prompt = numericValue(source.prompt_tokens, source.promptTokens) ?? 0;
    const details = source.prompt_tokens_details || source.promptTokensDetails || {};
    const hit = numericValue(source.prompt_cache_hit_tokens, source.promptCacheHitTokens, details.cached_tokens, details.cachedTokens) ?? 0;
    const miss = numericValue(source.prompt_cache_miss_tokens, source.promptCacheMissTokens) ?? Math.max(0, prompt - hit);
    const output = numericValue(source.completion_tokens, source.completionTokens) ?? 0;
    const total = numericValue(source.total_tokens, source.totalTokens, source.tokens, source.total) ?? (prompt + output);
    return { total, input: prompt, hit, miss, output };
  };
  const roundCost = (usage, model) => {
    if (!usage || typeof usage !== 'object') return null;
    const provided = numericValue(usage.cost, usage.total_cost, usage.totalCost);
    const tokens = usageTokens(usage);
    if (provided !== null) return { cost: provided, estimated: false, tokens, kind: '' };
    const price = priceFor(model);
    const per = (count, rate) => (count > 0 && rate > 0) ? (count / 1_000_000) * rate : 0;
    const cost = per(tokens.hit, price.hit) + per(tokens.miss, price.miss) + per(tokens.output, price.output);
    if (!(cost > 0)) return null;
    return { cost, estimated: false, tokens, kind: price.kind };
  };
  const assistantMessages = (conversation) => (conversation?.messages || []).filter((message) => message.role === 'assistant');
  const totalAssistantCost = (conversation) => assistantMessages(conversation).reduce((sum, message) => { const cost = Number(message.cost); return Number.isFinite(cost) && cost > 0 ? sum + cost : sum; }, 0);
  const lastRoundMessage = (conversation) => { const list = assistantMessages(conversation); for (let i = list.length - 1; i >= 0; i--) { const message = list[i]; if (message.usage || message.estimatedTokens || Number.isFinite(Number(message.cost)) || message.text) return message; } return null; };
  const conversationTokensTotal = (conversation) => {
    let total = 0; let measured = false;
    assistantMessages(conversation).forEach((message) => {
      if (message.usage && typeof message.usage === 'object') { const tokens = usageTokens(message.usage); total += tokens.total || (tokens.input + tokens.output); measured = true; }
      else if (message.estimatedTokens) { total += Number(message.estimatedTokens.input || 0) + Number(message.estimatedTokens.output || 0); measured = true; }
    });
    const fallbackUsage = (conversation?.usage || {});
    return measured ? total : (numericValue(fallbackUsage.total_tokens, fallbackUsage.totalTokens, fallbackUsage.tokens, fallbackUsage.total) ?? estimateTokens(conversation));
  };
  const conversationMetrics = (conversation = activeConversation()) => {
    const usage = conversation?.usage && typeof conversation.usage === 'object' ? conversation.usage : {};
    const limit = numericValue(usage.context_limit, usage.contextLimit, usage.limit) ?? contextLimitFor(state.api.model);
    const total = conversationTokensTotal(conversation);
    const used = Math.min(limit, total);
    let roundCostValue = 0; let roundEstimated = false; let roundTokens = null;
    const round = lastRoundMessage(conversation);
    if (round) {
      const priced = Number.isFinite(Number(round.cost))
        ? { cost: Number(round.cost), estimated: Boolean(round.costEstimated), tokens: round.usage ? usageTokens(round.usage) : (round.estimatedTokens ? { total: Number(round.estimatedTokens.input || 0) + Number(round.estimatedTokens.output || 0), input: Number(round.estimatedTokens.input || 0), hit: 0, miss: Number(round.estimatedTokens.input || 0), output: Number(round.estimatedTokens.output || 0) } : null) }
        : (round.usage ? roundCost(round.usage, round.model || state.api.model) : null);
      if (priced) { roundCostValue = priced.cost || 0; roundEstimated = Boolean(priced.estimated); roundTokens = priced.tokens || null; }
    } else {
      const fallback = roundCost(usage, state.api.model);
      if (fallback) { roundCostValue = fallback.cost; roundEstimated = true; roundTokens = fallback.tokens; }
    }
    const costTotal = totalAssistantCost(conversation) || Number(conversation?.cost) || 0;
    let tokensIn = 0; let tokensOut = 0; let anyEstimated = false; const rateKinds = new Set();
    assistantMessages(conversation).forEach((message) => {
      if (message.usage && typeof message.usage === 'object') { const tokens = usageTokens(message.usage); tokensIn += tokens.input; tokensOut += tokens.output; }
      else if (message.estimatedTokens) { tokensIn += Number(message.estimatedTokens.input || 0); tokensOut += Number(message.estimatedTokens.output || 0); }
      if (message.costEstimated) anyEstimated = true;
      if (Number.isFinite(Number(message.cost)) && Number(message.cost) > 0 && message.rateKind) rateKinds.add(String(message.rateKind));
    });
    return { total, limit, used, remaining: Math.max(0, limit - used), percent: limit ? Math.min(100, (used / limit) * 100) : 0, roundCost: roundCostValue, roundEstimated, roundTokens, costTotal, tokensIn, tokensOut, costEstimatedAny: anyEstimated, rateKinds: [...rateKinds] };
  };
  const formatNumber = (value) => Number(value || 0).toLocaleString('en-US');
  const formatTokens = (value) => { const n = Number(value || 0); return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(Math.round(n)); };
  const formatCost = (value, estimated = false) => { const v = Number(value || 0); return `${estimated ? '≈' : ''}¥${v >= 0.01 ? v.toFixed(2) : v.toFixed(4)}`; };
  const applyUsage = (conversation, payload) => {
    const usage = payload?.usage || payload?.data?.usage;
    if (!conversation || !usage || typeof usage !== 'object') return;
    conversation.usage = { ...(conversation.usage || {}), ...usage };
    const cost = numericValue(usage.cost, usage.total_cost, usage.totalCost);
    if (cost !== null) conversation.cost = cost;
  };
  // 一轮结束：把 usage / 费用核算落到这条 assistant 消息上（无 usage 时按字数估算，
  // allowEstimate=false 用于失败轮次，避免把报错也算成费用）。
  const finishRound = (request, payload, allowEstimate = true) => {
    const extra = (payload && (payload.usage || (payload.data && payload.data.usage))) || {};
    const merged = { ...(request.roundUsage || {}), ...(extra && typeof extra === 'object' ? extra : {}) };
    if (Object.keys(merged).length) request.assistant.usage = merged;
    const priced = Object.keys(merged).length ? roundCost(merged, state.api.model) : null;
    if (priced) {
      request.assistant.cost = priced.cost; request.assistant.costEstimated = Boolean(priced.estimated); request.assistant.rateKind = priced.kind || '';
    } else if (allowEstimate) {
      const price = priceFor(state.api.model);
      const estIn = Math.ceil(Number(request.userChars || 0) / 2);
      const estOut = Math.ceil(String(request.assistant.text || '').trim().length / 2);
      if (estIn > 0 || estOut > 0) {
        const cost = (estIn / 1_000_000) * price.miss + (estOut / 1_000_000) * price.output;
        if (cost > 0) { request.assistant.cost = cost; request.assistant.costEstimated = true; request.assistant.estimatedTokens = { input: estIn, output: estOut }; request.assistant.rateKind = price.kind || ''; }
      }
    }
    request.conversation.cost = totalAssistantCost(request.conversation);
  };
  const renderContextCard = () => {
    const data = conversationMetrics();
    const usedPercent = Math.max(0, Math.round(data.percent));
    const remainingPercent = 100 - usedPercent;
    const setText = (id, value) => { const node = $(id); if (node) node.textContent = value; };
    setText('contextRemaining', `剩余 ${remainingPercent}%`);
    setText('contextRemainingTokens', `${formatNumber(data.remaining)} token`);
    setText('contextConversationTokens', formatNumber(data.total));
    setText('contextCost', formatCost(data.costTotal, data.costEstimatedAny));
    const detail = $('contextCostDetail');
    if (detail) {
      const parts = [];
      if ((data.tokensIn || data.tokensOut) > 0) parts.push(`累计输入 ${formatTokens(data.tokensIn)} / 输出 ${formatTokens(data.tokensOut)} token`);
      const kindLabel = data.rateKinds.length === 1 ? ({ peak: '高峰价', valley: '空闲价', custom: '自定义单价' }[data.rateKinds[0]] || '') : (data.rateKinds.length > 1 ? '混合时段价' : '');
      if (kindLabel) parts.push(kindLabel);
      if (data.costEstimatedAny || !(data.tokensIn || data.tokensOut)) parts.push('按单价估算');
      detail.textContent = parts.join(' · ');
    }
    const fill = $('contextProgressFill'); if (fill) fill.style.width = `${usedPercent}%`;
    const dot = document.querySelector('.context-button-dot'); if (dot) dot.style.setProperty('--context-percent', `${usedPercent}%`);
    const ring = $('contextUsageRing'); if (ring) ring.style.setProperty('--context-percent', `${usedPercent}%`);
    const button = $('contextButton'); if (button) button.setAttribute('aria-label', `上下文用量，已使用 ${usedPercent}%，剩余 ${remainingPercent}%`);
  };
  const renderRecentChats = () => {
    const list = document.querySelector('.sidebar-recent-list');
    if (!list) return;
    list.innerHTML = '';
    state.conversations.filter((conversation) => !conversation._draft && !String(conversation?.projectName || '').trim()).slice().sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 8).forEach((conversation) => {
      const title = String(conversation.title || '新对话');
      const isGroup = isGroupConversation(conversation);
      const button = document.createElement('button'); button.className = `sidebar-recent-item${isGroup ? ' is-group' : ''}`; button.type = 'button'; button.dataset.conversationId = conversation.id; button.setAttribute('aria-label', isGroup ? `${title}，群聊` : title);
      if (isGroup) { const icon = document.createElement('img'); icon.className = 'sidebar-recent-icon'; icon.src = '../icons/people-fill.svg?v=shell-v1'; icon.alt = ''; icon.setAttribute('aria-hidden', 'true'); button.appendChild(icon); }
      const label = document.createElement('span'); label.className = 'sidebar-recent-title'; label.textContent = title; button.appendChild(label);
      button.onclick = () => { cleanupDraftConversation(); state.activeId = conversation.id; closeSidebar(); renderMessages(); }; list.appendChild(button);
    });
  };
  // 标题胶囊溢出检测：超出可用宽度时加 is-marquee，横向循环滚动显示全称。
  // 可用宽度取胶囊内容宽（含 padding 之外的部分），文本宽度用 scrollWidth（不受布局截断影响）。
  const syncTitleMarquee = () => {
    if (chatPage.hidden) return; // 开屏/隐藏期间布局不可用，跳过等待下一次重测
    const title = $('conversationTitle'); const pill = title?.closest('.conversation-title-pill');
    if (!title || !pill) return;
    const pillStyle = getComputedStyle(pill);
    const padX = (parseFloat(pillStyle.paddingLeft) || 0) + (parseFloat(pillStyle.paddingRight) || 0);
    const available = Math.max(0, pill.clientWidth - padX);
    const shift = Math.max(0, title.scrollWidth - available);
    if (shift > 1 && available > 0) {
      pill.classList.add('is-marquee');
      pill.style.setProperty('--marquee-shift', `-${Math.round(shift)}px`);
      pill.style.setProperty('--marquee-duration', `${Math.min(10, Math.max(4.5, shift / 32 + 2.5)).toFixed(2)}s`);
    } else {
      pill.classList.remove('is-marquee');
    }
  };
  const requestTitleMarqueeMeasure = () => {
    requestAnimationFrame(syncTitleMarquee);
    setTimeout(syncTitleMarquee, 160); // 字体加载/布局稳定后兜底重测
    setTimeout(syncTitleMarquee, 520);
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
    const group = isGroupConversation(conversation);
    $('conversationTitle').textContent = conversation?.title || '今天的灵感';
    const titlePill = $('conversationTitle')?.closest('.conversation-title-pill');
    titlePill?.classList.toggle('is-group', group);
    const groupIcon = $('conversationGroupIcon');
    if (groupIcon) { groupIcon.hidden = !group; groupIcon.setAttribute('aria-hidden', String(!group)); }
    const memberCount = $('conversationMemberCount');
    if (memberCount) { memberCount.hidden = !group; memberCount.textContent = group ? `${groupMemberCount(conversation)} 位成员` : ''; }
    ['chatModelButton', 'chatEffortButton'].forEach((id) => { const button = $(id); if (button) { button.hidden = group; button.setAttribute('aria-hidden', String(group)); } });
    const groupSettings = document.querySelector('[data-feature-action="group-settings"]');
    if (groupSettings) { groupSettings.hidden = !group; groupSettings.setAttribute('aria-hidden', String(!group)); }
    if ($('featureMenuTitle')) $('featureMenuTitle').textContent = conversation?.title || '今天的灵感';
    setConversationFolder(conversation?.projectName || ''); renderRecentChats(); renderContextCard(); requestTitleMarqueeMeasure();
  };
  // 仅对最新一条消息播放入场动画（renderMessages 每帧重建节点，
  // 若直接给气泡挂动画会在流式渲染时反复重播）。
  const animateLastMessage = () => {
    const node = conversationContent?.lastElementChild;
    if (!node) return;
    node.classList.add('is-new');
    setTimeout(() => node.classList.remove('is-new'), 460);
  };
  const tapTick = () => { try { navigator.vibrate?.(10); } catch (_) {} };

  const showChatPage = () => {
    closeOverlays(); closeSidebar();
    [settingsView, groupSettingsView, scheduleView, remoteView, apiProjectsView, apiProjectView].forEach((view) => { if (view) view.hidden = true; });
    chatPage.hidden = false; renderMessages();
  };
  const showGroupSettingsView = () => {
    const conversation = activeConversation();
    if (!isGroupConversation(conversation)) { showToast('群聊设置仅适用于群聊'); return; }
    cleanupDraftConversation(); closeOverlays(); closeSidebar();
    [settingsView, scheduleView, chatPage, remoteView, apiProjectsView, apiProjectView].forEach((view) => { if (view) view.hidden = true; });
    groupSettingsView.hidden = false; renderGroupSettings();
  };
  const closeGroupSettingsView = () => {
    if (!groupSettingsView || groupSettingsView.hidden) return;
    groupSettingsView.hidden = true; chatPage.hidden = false; renderMessages();
  };
  const scheduleDateKey = (date) => {
    const value = date instanceof Date ? date : new Date(date);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  };
  const scheduleMonthLabel = (date) => `${date.getFullYear()}年${date.getMonth() + 1}月`;
  const renderScheduleCalendar = () => {
    const heading = $('scheduleCalendarHeading');
    const grid = $('scheduleCalendarGrid');
    if (heading) heading.textContent = scheduleMonthLabel(scheduleMonthCursor);
    if (!grid) return;
    const year = scheduleMonthCursor.getFullYear();
    const month = scheduleMonthCursor.getMonth();
    const firstDayOffset = (new Date(year, month, 1).getDay() + 6) % 7;
    const monthDays = new Date(year, month + 1, 0).getDate();
    const totalCells = Math.ceil((firstDayOffset + monthDays) / 7) * 7;
    const todayKey = scheduleDateKey(scheduleToday);
    grid.replaceChildren();
    for (let index = 0; index < totalCells; index += 1) {
      const date = new Date(year, month, index - firstDayOffset + 1);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'schedule-day';
      cell.setAttribute('role', 'gridcell');
      cell.textContent = String(date.getDate());
      cell.setAttribute('aria-label', date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }));
      if (date.getMonth() !== month) cell.classList.add('is-outside');
      if (scheduleDateKey(date) === todayKey) { cell.classList.add('is-today'); cell.setAttribute('aria-current', 'date'); }
      cell.addEventListener('click', () => {
        if (date.getMonth() !== month) {
          scheduleMonthCursor = new Date(date.getFullYear(), date.getMonth(), 1);
          renderScheduleCalendar();
          return;
        }
        document.querySelectorAll('.schedule-day.is-selected').forEach((node) => node.classList.remove('is-selected'));
        cell.classList.add('is-selected');
        showToast(`${date.getMonth() + 1}月${date.getDate()}日 · 日程编辑即将开放`);
      });
      grid.append(cell);
    }
  };
  const renderScheduleView = () => {
    renderScheduleCalendar();
    const planProgress = $('schedulePlanProgress');
    if (planProgress) planProgress.textContent = '0/0';
    const goalProgressBar = $('scheduleGoalProgressBar');
    if (goalProgressBar) goalProgressBar.style.width = '0%';
  };
  const showScheduleView = () => {
    cleanupDraftConversation(); closeOverlays(); closeSidebar();
    [settingsView, groupSettingsView, remoteView, chatPage, apiProjectsView, apiProjectView].forEach((view) => { if (view) view.hidden = true; });
    if (!scheduleView) return;
    scheduleView.hidden = false;
    renderScheduleView();
  };
  const attachProjectRowPress = (row, project) => {
    let timer = null; let startX = 0; let startY = 0;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    row.addEventListener('pointerdown', (event) => {
      cancel(); startX = event.clientX; startY = event.clientY;
      timer = setTimeout(() => { timer = null; state.longPressActive = true; openProjectMenu(project, event.clientX, event.clientY); try { navigator.vibrate?.(25); } catch (_) {} }, 520);
    });
    row.addEventListener('pointermove', (event) => { if (timer && Math.hypot(event.clientX - startX, event.clientY - startY) > 14) cancel(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => row.addEventListener(name, cancel));
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); state.longPressActive = true; openProjectMenu(project, event.clientX, event.clientY); });
  };
  const renderApiProjects = () => {
    const list = $('apiProjectsList'); const empty = $('apiProjectsEmpty'); if (!list || !empty) return;
    const query = String($('apiProjectsSearch')?.value || '').trim().toLocaleLowerCase();
    const projects = state.projects.filter((project) => !query || String(project.name || '').toLocaleLowerCase().includes(query)).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    list.replaceChildren();
    projects.forEach((project) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'api-project-row'; row.dataset.projectId = String(project.id || '');
      row.innerHTML = '<span class="api-project-row-icon"><img src="../icons/folder2.svg" alt=""></span><span class="api-project-row-copy"><strong class="api-project-row-title"></strong><small class="api-project-row-date"></small></span>';
      row.querySelector('.api-project-row-title').textContent = String(project.name || '项目');
      row.querySelector('.api-project-row-date').textContent = apiProjectDate(project);
      attachProjectRowPress(row, project);
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
    const meta = $('apiProjectMeta'); if (meta) meta.textContent = project.note || 'API 对话';
    const root = $('apiProjectChats'); const empty = $('apiProjectEmpty'); if (!root || !empty) return;
    const query = String($('apiProjectSearch')?.value || '').trim().toLocaleLowerCase();
    const projectKey = String(project.name || '').trim().toLocaleLowerCase();
    const chats = state.conversations.filter((conversation) => !conversation._draft && String(conversation?.projectName || '').trim().toLocaleLowerCase() === projectKey && (!query || String(conversation.title || '').toLocaleLowerCase().includes(query))).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
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
    cleanupDraftConversation();
    closeOverlays(); closeSidebar();
    [chatPage, settingsView, groupSettingsView, scheduleView, remoteView, apiProjectView].forEach((view) => { if (view) view.hidden = true; });
    apiProjectsView.hidden = false; renderApiProjects();
  };
  const showApiProject = (project) => {
    if (!project) return;
    cleanupDraftConversation();
    closeOverlays(); closeSidebar(); state.selectedProject = project;
    [chatPage, settingsView, groupSettingsView, scheduleView, remoteView, apiProjectsView].forEach((view) => { if (view) view.hidden = true; });
    apiProjectView.hidden = false; renderApiProject();
  };
  const openApiProjectCreate = () => {
    closeOverlays(); if (!apiProjectCreateLayer) return;
    state.projectRenameId = ''; $('apiProjectCreateTitle').textContent = '新建项目'; $('apiProjectCreateConfirm').textContent = '创建项目';
    apiProjectCreateLayer.hidden = false; const input = $('apiProjectNameInput'); if (input) { input.value = ''; setTimeout(() => input.focus(), 0); }
  };
  const closeApiProjectCreate = () => { if (apiProjectCreateLayer) apiProjectCreateLayer.hidden = true; };
  const openApiProjectRename = (project) => {
    closeOverlays(); if (!apiProjectCreateLayer || !project) return;
    state.projectRenameId = String(project.id); $('apiProjectCreateTitle').textContent = '编辑项目'; $('apiProjectCreateConfirm').textContent = '保存';
    apiProjectCreateLayer.hidden = false; const input = $('apiProjectNameInput'); if (input) { input.value = project.name || ''; setTimeout(() => input.focus(), 0); }
  };
  const closeApiProjectNote = () => { if (apiProjectNoteLayer) apiProjectNoteLayer.hidden = true; };
  const openApiProjectNote = (project) => {
    closeOverlays(); if (!apiProjectNoteLayer || !project) return;
    state.projectNoteId = String(project.id); $('apiProjectNoteInput').value = project.note || '';
    apiProjectNoteLayer.hidden = false; setTimeout(() => { const input = $('apiProjectNoteInput'); if (input) input.focus(); }, 0);
  };
  const saveApiProjectNote = () => {
    const project = state.projects.find((item) => String(item.id) === String(state.projectNoteId));
    if (!project) { closeApiProjectNote(); return; }
    project.note = String($('apiProjectNoteInput')?.value || '').trim(); project.updatedAt = Date.now();
    saveProjects(); closeApiProjectNote(); showToast('项目说明已保存');
  };
  const currentMenuProject = () => state.projects.find((project) => String(project.id) === String(state.menuProjectId)) || null;
  const openProjectMenu = (project, x, y) => {
    if (!projectMenuLayer || !projectMenuPopover || !project) return;
    closeOverlays();
    state.menuProjectId = String(project.id);
    const confirmBlock = $('projectMenuConfirm'); if (confirmBlock) confirmBlock.hidden = true;
    projectMenuLayer.hidden = false;
    const rect = projectMenuPopover.getBoundingClientRect();
    const width = rect.width || 252; const height = rect.height || 246;
    const pad = 10;
    const left = Math.max(pad, Math.min(x - 34, window.innerWidth - width - pad));
    const top = y + 14 + height > window.innerHeight - pad ? Math.max(pad, y - height - 14) : y + 14;
    projectMenuPopover.style.left = `${Math.round(left)}px`; projectMenuPopover.style.top = `${Math.round(top)}px`;
  };
  const executeProjectAction = (action) => {
    const project = currentMenuProject(); if (!project) return;
    if (action === 'pin') { project.pinned = !project.pinned; project.updatedAt = Date.now(); saveProjects(); renderApiProjects(); closeOverlays(); showToast(project.pinned ? '已置顶项目' : '已取消置顶'); return; }
    if (action === 'rename') { openApiProjectRename(project); return; }
    if (action === 'note') { openApiProjectNote(project); return; }
    if (action === 'delete') { const confirmBlock = $('projectMenuConfirm'); if (confirmBlock) confirmBlock.hidden = false; return; }
  };
  const deleteCurrentProject = () => {
    const project = currentMenuProject(); if (!project) { closeOverlays(); return; }
    const name = project.name;
    state.projects = state.projects.filter((item) => item.id !== project.id);
    state.conversations.forEach((conversation) => { if (conversation.projectName === name) conversation.projectName = ''; });
    if (state.selectedProject && state.selectedProject.id === project.id) state.selectedProject = null;
    saveProjects(); saveConversations(); closeOverlays();
    renderApiProjects(); showApiProjects(); showToast('项目已删除');
  };
  const createApiProject = () => {
    const input = $('apiProjectNameInput'); const name = String(input?.value || '').trim();
    if (!name) { showToast('请输入项目名称'); input?.focus(); return; }
    if (state.projectRenameId) {
      const project = state.projects.find((item) => String(item.id) === String(state.projectRenameId));
      if (!project) { state.projectRenameId = ''; closeApiProjectCreate(); return; }
      const oldName = project.name;
      if (name !== oldName && state.projects.some((item) => item.id !== project.id && item.name === name)) { showToast('已存在同名项目'); return; }
      project.name = name; project.updatedAt = Date.now();
      state.conversations.forEach((conversation) => { if (conversation.projectName === oldName) conversation.projectName = name; });
      if (state.selectedProject && state.selectedProject.id === project.id) { state.selectedProject = project; renderApiProject(); }
      saveProjects(); saveConversations(); state.projectRenameId = ''; closeApiProjectCreate(); renderApiProjects(); showToast('项目已重命名'); return;
    }
    const existing = apiProjectByName(name);
    if (existing) { closeApiProjectCreate(); showApiProject(existing); showToast('已打开这个项目'); return; }
    const now = Date.now(); const project = { id: `api-project-${now}`, name, createdAt: now, updatedAt: now };
    state.projects.unshift(project); saveProjects(); closeApiProjectCreate(); showApiProject(project); showToast('项目已创建');
  };
  // 草稿清理：切到其他对话 / 项目 / 设置 / Remote（以及再次新建对话）时调用。
  // 活动草稿若没有任何消息且输入框为空、无附件 → 从内存移除（不写 localStorage，
  // 避免最近聊天残留空对话）；若有输入内容未发送 → 保留在内存（仍不落库），
  // 回到该对话时依旧可见，直到 sendMessage 发送首条消息才转正。
  const cleanupDraftConversation = () => {
    const drafts = state.conversations.filter((item) => item._draft);
    if (!drafts.length) return;
    const hasInlineText = Boolean(messageInput && String(messageInput.value || '').trim());
    const hasAttachment = Boolean(state.pendingAttachment);
    const alive = drafts.filter((draft) => draft.id === state.activeId && ((draft.messages || []).length > 0 || hasInlineText || hasAttachment));
    if (alive.length === drafts.length) return;
    state.conversations = state.conversations.filter((item) => !item._draft || alive.includes(item));
    if (!state.conversations.length) state.conversations = [defaultConversation()];
    if (!state.conversations.some((item) => item.id === state.activeId)) state.activeId = state.conversations[0].id;
  };
  const startApiProjectChat = () => {
    const project = state.selectedProject; if (!project) return;
    cleanupDraftConversation();
    const id = `api-chat-${Date.now()}`;
    state.conversations.unshift({ id, title: '新对话', projectName: project.name, updatedAt: Date.now(), messages: [], _draft: true });
    state.activeId = id; showChatPage(); messageInput?.focus();
  };
  const startOrdinaryChat = () => {
    cleanupDraftConversation();
    const id = `api-chat-${Date.now()}`;
    state.conversations.unshift({ id, title: '新对话', projectName: '', updatedAt: Date.now(), messages: [], _draft: true });
    state.activeId = id; showChatPage(); messageInput?.focus(); showToast('已打开新对话');
  };
  const openConversationRename = () => {
    if (!conversationRenameLayer) return;
    const conversation = activeConversation();
    const input = $('conversationRenameInput');
    if (input) { input.value = conversation?.title || ''; setTimeout(() => input.focus(), 0); }
    conversationRenameLayer.hidden = false;
  };
  const closeConversationRename = () => { if (conversationRenameLayer) conversationRenameLayer.hidden = true; };
  const saveConversationRename = () => {
    const conversation = activeConversation();
    const input = $('conversationRenameInput');
    if (!conversation || !input) { closeConversationRename(); return; }
    const name = String(input.value || '').trim();
    if (!name) { showToast('请输入对话名称'); input.focus(); return; }
    conversation.title = name;
    saveConversations(); closeConversationRename(); renderMessages(); showToast('已重命名对话');
  };

  const closeOverlays = () => { attachmentLayer.hidden = true; featureLayer.hidden = true; if (apiProjectPickerLayer) apiProjectPickerLayer.hidden = true; if (chatSelectorLayer) chatSelectorLayer.hidden = true; if (contextLayer) contextLayer.hidden = true; if (groupSettingEditorLayer) groupSettingEditorLayer.hidden = true; if (projectMenuLayer) projectMenuLayer.hidden = true; closeApiProjectCreate(); closeApiProjectNote(); closeConversationRename(); state.groupEditor = null; $('attachmentButton')?.setAttribute('aria-expanded', 'false'); $('featureButton')?.setAttribute('aria-expanded', 'false'); $('chatModelButton')?.setAttribute('aria-expanded', 'false'); $('chatEffortButton')?.setAttribute('aria-expanded', 'false'); $('contextButton')?.setAttribute('aria-expanded', 'false'); };
  const closeSidebar = () => { sidebarLayer.hidden = true; $('menuButton')?.setAttribute('aria-expanded', 'false'); };
  const openSidebar = () => { closeOverlays(); sidebarLayer.hidden = false; $('menuButton')?.setAttribute('aria-expanded', 'true'); };
  const showRemoteView = (route = 'remote') => { cleanupDraftConversation(); closeOverlays(); closeSidebar(); closeApiProjectCreate(); [settingsView, groupSettingsView, scheduleView, chatPage, apiProjectsView, apiProjectView].forEach((view) => { if (view) view.hidden = true; }); remoteView.hidden = false; syncRemoteFrameInsets(); requestRemoteRoute(route); };
  const showSettingsView = (returnView = 'chat') => { cleanupDraftConversation(); closeOverlays(); closeSidebar(); closeApiProjectCreate(); state.settingsReturnView = returnView === 'remote' ? 'remote' : 'chat'; remoteView.hidden = true; groupSettingsView.hidden = true; if (scheduleView) scheduleView.hidden = true; chatPage.hidden = true; apiProjectsView.hidden = true; apiProjectView.hidden = true; settingsView.hidden = false; loadConfigIntoForm(); };
  const closeSettingsView = () => { settingsView.hidden = true; if (state.settingsReturnView === 'remote') { remoteView.hidden = false; chatPage.hidden = true; if (scheduleView) scheduleView.hidden = true; syncRemoteFrameInsets(); return; } remoteView.hidden = true; if (scheduleView) scheduleView.hidden = true; apiProjectsView.hidden = true; apiProjectView.hidden = true; chatPage.hidden = false; renderMessages(); };
  // 展开态（键盘弹出、输入框有焦点）点开附件/模型/思考等级/上下文弹层时保持输入栏展开：
  // 这些文件内没有任何 blur 逻辑，按 pointerdown 记录焦点状态，弹层打开后重新聚焦 messageInput 兜底。
  const restoreComposerFocus = () => {
    if (!keepComposerKeyboard) return;
    keepComposerKeyboard = false;
    setTimeout(() => { try { messageInput?.focus({ preventScroll: true }); } catch (_) { messageInput?.focus(); } }, 0);
  };
  const openOverlay = (layer, trigger) => { closeOverlays(); layer.hidden = false; trigger?.setAttribute('aria-expanded', 'true'); restoreComposerFocus(); };

  const setApiStatus = (message, kind = '') => { const node = $('apiSettingsStatus'); node.textContent = message || ''; node.className = `api-settings-status${kind ? ` ${kind}` : ''}`; };
  const updateApiDot = (stateName) => { const dot = $('apiStatusDot'); if (!dot) return; dot.className = `api-status-dot ${stateName}`; dot.setAttribute('aria-label', stateName === 'online' ? '已配置' : stateName === 'testing' ? '测试中' : '未配置'); };
  const effortLabel = (value) => ({ auto: '自动', high: '高', max: '最高' }[String(value || 'auto')] || '自动');
  const syncChatSelectors = () => {
    const model = String(state.api.model || 'deepseek-chat');
    const modelLabel = $('chatModelLabel'); if (modelLabel) modelLabel.textContent = model;
    const effortLabelNode = $('chatEffortLabel'); if (effortLabelNode) effortLabelNode.textContent = effortLabel(state.selectedEffort);
    document.querySelectorAll('[data-chat-model]').forEach((button) => button.classList.toggle('is-selected', button.dataset.chatModel === model));
    document.querySelectorAll('[data-chat-effort]').forEach((button) => button.classList.toggle('is-selected', button.dataset.chatEffort === (state.selectedEffort || 'auto')));
    applyPricePlaceholders();
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
  const openChatSelector = (trigger, mode = '') => { closeOverlays(); if (!chatSelectorLayer) return; const selectedMode = mode || (trigger?.id === 'chatEffortButton' ? 'effort' : 'model'); const popover = chatSelectorLayer.querySelector('.chat-selector-popover'); if (popover) popover.dataset.mode = selectedMode; chatSelectorLayer.hidden = false; trigger?.setAttribute('aria-expanded', 'true'); syncChatSelectors(); restoreComposerFocus(); };
  const openContextCard = () => { closeOverlays(); if (!contextLayer) return; renderContextCard(); contextLayer.hidden = false; $('contextButton')?.setAttribute('aria-expanded', 'true'); restoreComposerFocus(); };
  const loadApiConfig = () => {
    let stored = null; try { stored = native?.getApiConfig?.() || localStorage.getItem(CONFIG_KEY); } catch (_) {}
    const config = safeJson(stored, {}); state.api = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) }; if (!state.api.base_url) state.api.base_url = DEFAULT_CONFIG.base_url; state.selectedEffort = String(config?.effort || 'auto'); const remembered = safeJson(localStorage.getItem(API_MODELS_KEY), []); if (Array.isArray(remembered)) state.apiModels = [...new Set([...state.apiModels, ...remembered.map((item) => String(item || '').trim()).filter(Boolean)])]; if (state.api.model) state.apiModels = [...new Set([...state.apiModels, String(state.api.model)])]; renderApiModels();
  };
  const loadGroupSettings = () => {
    const stored = safeJson(localStorage.getItem(GROUP_SETTINGS_KEY), {});
    const source = stored && typeof stored === 'object' ? stored : {};
    state.groupSettings = Object.keys(DEFAULT_GROUP_SETTINGS).reduce((result, member) => {
      const defaults = DEFAULT_GROUP_SETTINGS[member]; const saved = source[member] && typeof source[member] === 'object' ? source[member] : {};
      result[member] = { ...defaults, ...saved, model: String(saved.model || defaults.model), effort: String(saved.effort || defaults.effort), prompt: String(saved.prompt || defaults.prompt) };
      return result;
    }, {});
  };
  const saveGroupSettings = () => { try { localStorage.setItem(GROUP_SETTINGS_KEY, JSON.stringify(state.groupSettings)); } catch (_) {} };
  const renderGroupSettings = () => {
    const root = $('groupSettingsView'); if (!root) return;
    root.querySelectorAll('[data-group-member]').forEach((block) => {
      const member = block.dataset.groupMember || ''; const settings = state.groupSettings[member] || DEFAULT_GROUP_SETTINGS[member] || {};
      block.querySelectorAll('[data-group-value]').forEach((node) => {
        const setting = node.dataset.groupValue || '';
        node.textContent = setting === 'effort' ? effortLabel(settings[setting]) : setting === 'prompt' ? (settings.prompt ? '已编辑提示词' : '编辑提示词') : String(settings[setting] || '');
      });
    });
  };
  const closeGroupSettingEditor = () => { if (groupSettingEditorLayer) groupSettingEditorLayer.hidden = true; state.groupEditor = null; };
  const openGroupSettingEditor = (member, setting) => {
    if (!groupSettingEditorLayer || !state.groupSettings[member]) return;
    closeOverlays();
    state.groupEditor = { member, setting, value: state.groupSettings[member][setting] || '' };
    const memberLabel = $('groupSettingEditorMember'); const title = $('groupSettingEditorTitle'); const options = $('groupSettingEditorOptions'); const promptWrap = $('groupPromptEditorWrap'); const prompt = $('groupPromptEditor');
    if (memberLabel) memberLabel.textContent = member === 'reasoner' ? 'deepseek-reasoner' : 'deepseek-chat';
    if (title) title.textContent = setting === 'model' ? '模型' : setting === 'effort' ? '思考程度' : '提示词';
    if (options) options.replaceChildren();
    if (promptWrap) promptWrap.hidden = setting !== 'prompt';
    if (prompt) prompt.value = setting === 'prompt' ? String(state.groupSettings[member].prompt || '') : '';
    if (setting !== 'prompt' && options) {
      const values = setting === 'model' ? [...new Set([...state.apiModels, 'deepseek-chat', 'deepseek-reasoner'])] : ['auto', 'high', 'max'];
      values.forEach((value) => {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'group-editor-option'; row.dataset.value = value;
        const label = document.createElement('span'); label.textContent = setting === 'effort' ? effortLabel(value) : value;
        const tick = document.createElement('i'); tick.textContent = '✓'; tick.setAttribute('aria-hidden', 'true'); row.append(label, tick); row.classList.toggle('is-selected', value === state.groupEditor.value); options.append(row);
      });
    }
    groupSettingEditorLayer.hidden = false;
  };
  const saveGroupSettingEditor = () => {
    const editor = state.groupEditor; if (!editor || !state.groupSettings[editor.member]) { closeGroupSettingEditor(); return; }
    const prompt = $('groupPromptEditor');
    if (editor.setting === 'prompt') editor.value = String(prompt?.value || '').trim();
    state.groupSettings[editor.member][editor.setting] = editor.value || (editor.setting === 'effort' ? 'auto' : DEFAULT_GROUP_SETTINGS[editor.member][editor.setting]);
    saveGroupSettings(); renderGroupSettings(); closeGroupSettingEditor(); showToast('成员设置已保存');
  };
  const parsePriceValue = (node) => { const value = Number(String(node?.value || '').trim()); return Number.isFinite(value) && value > 0 ? value : 0; };
  const readPriceInputs = () => ({ hit: parsePriceValue($('priceHitInput')), miss: parsePriceValue($('priceMissInput')), output: parsePriceValue($('priceOutputInput')) });
  const applyPricePlaceholders = () => { const price = priceFor(state.api.model); const set = (id, value) => { const node = $(id); if (node) node.placeholder = String(value); }; set('priceHitInput', price.hit); set('priceMissInput', price.miss); set('priceOutputInput', price.output); };
  const loadConfigIntoForm = () => { $('apiBaseInput').value = state.api.base_url || DEFAULT_CONFIG.base_url; $('apiKeyInput').value = state.api.api_key || ''; const price = state.api.prices || {}; $('priceHitInput').value = price.hit || ''; $('priceMissInput').value = price.miss || ''; $('priceOutputInput').value = price.output || ''; updateApiDot(state.api.api_key ? 'online' : 'offline'); syncChatSelectors(); if (!$('apiSettingsStatus').textContent) setApiStatus(state.api.api_key ? '已配置 DeepSeek API' : '尚未配置 API Key'); };
  const saveApiConfig = () => {
    const config = { base_url: normalizeApiBase($('apiBaseInput').value || ''), api_key: String($('apiKeyInput').value || '').trim(), model: String(state.api.model || 'deepseek-chat').trim(), system_prompt: state.api.system_prompt || '', effort: state.selectedEffort || 'auto' };
    const prices = readPriceInputs(); if (prices.hit || prices.miss || prices.output) config.prices = prices;
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
    if (name === 'usage') { const usage = (data.usage && typeof data.usage === 'object') ? data.usage : {}; request.roundUsage = { ...(request.roundUsage || {}), ...usage }; return; }
    if (name === 'delta' || name === 'reasoning') { if (name === 'delta') request.assistant.text += String(data.text || ''); request.assistant.pending = false; renderMessages(); return; }
    if (name === 'done' || name === 'complete') { finish(); if (name === 'complete') request.assistant.text = String(data.text || request.assistant.text || ''); finishRound(request, data); request.assistant.pending = false; state.request = null; request.conversation.updatedAt = Date.now(); saveConversations(); renderMessages(); animateLastMessage(); renderContextCard(); showToast('DeepSeek 已回复'); return; }
    if (name === 'error') { finish(); finishRound(request, data, false); request.assistant.pending = false; request.assistant.error = true; request.assistant.text = request.assistant.text || `生成失败：${String(data.message || '请检查 API 配置')}`; state.request = null; saveConversations(); renderMessages(); animateLastMessage(); renderContextCard(); showToast(String(data.message || 'DeepSeek 请求失败')); }
  };
  window.DeepSeekEvents = { onEvent: handleApiEvent };
  const sendNativeApi = (conversation) => { if (!native || typeof native.streamChat !== 'function') return false; native.streamChat(JSON.stringify({ url: apiEndpoint(), apiKey: state.api.api_key, payload: { model: state.api.model || 'deepseek-chat', messages: buildMessages(conversation), stream: true, stream_options: { include_usage: true } } })); return true; };
  const sendBrowserApi = async (conversation, request) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await fetch(apiEndpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(state.api.api_key ? { Authorization: `Bearer ${state.api.api_key}` } : {}) }, body: JSON.stringify({ model: state.api.model || 'deepseek-chat', messages: buildMessages(conversation), stream: true, stream_options: { include_usage: true } }), signal: controller.signal });
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
    const conversation = activeConversation();
    // 发送首条消息（或附件）= 草稿转正：去除 _draft 标记并确保处于
    // state.conversations（否则 push），随后 saveConversations 落库。
    if (conversation?._draft) delete conversation._draft;
    if (!state.conversations.some((item) => item === conversation)) state.conversations.unshift(conversation);
    const attachment = state.pendingAttachment ? { ...state.pendingAttachment } : null; const user = { role: 'user', text: value, attachment }; conversation.messages.push(user);
    if (conversation.messages.filter((item) => item.role === 'user').length === 1 || conversation.title === '今天的灵感') conversation.title = formatTitle(value || attachment?.name || '图片对话');
    conversation.updatedAt = Date.now(); const assistant = { role: 'assistant', text: '', pending: true }; conversation.messages.push(assistant); state.pendingAttachment = null; attachmentInput.value = ''; messageInput.value = ''; messageInput.style.height = '42px'; renderAttachment(); renderMessages(); animateLastMessage(); tapTick();
    if (!state.api.api_key) { assistant.pending = false; assistant.error = true; assistant.text = '还没有配置 API Key，请到设置中完成配置后再发送。'; saveConversations(); renderMessages(); showToast('请先配置 API Key'); showSettingsView(); return; }
    const request = { conversation, assistant, userChars: (value || '').length }; state.request = request; saveConversations();
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
    testBrowserApi().then((models) => { if (models.length) { state.apiModels = models; try { localStorage.setItem(API_MODELS_KEY, JSON.stringify(models)); } catch (_) {} if (!models.includes(state.api.model)) state.api.model = models[0]; renderApiModels(); persistChatSelection(); } setApiStatus(models.length ? `连接成功 · ${models.length} 个模型` : '连接成功', 'success'); }).catch((error) => { const message = error?.name === 'AbortError' ? 'API 检测超时，请检查网络' : error.message; setApiStatus(`连接失败：${message}`, 'error'); }).finally(() => { state.apiTestPending = false; setApiTestBusy(false); });
  };
  const handleFeatureAction = (action) => {
    const conversation = activeConversation();
    closeOverlays();
    if (!conversation) return;
    if (action === 'pin') {
      conversation.pinned = !conversation.pinned; conversation.updatedAt = Date.now(); saveConversations(); renderRecentChats(); showToast(conversation.pinned ? '已置顶当前对话' : '已取消置顶'); return;
    }
    if (action === 'rename') { openConversationRename(); return; }
    if (action === 'schedule') { showScheduleView(); return; }
    if (action === 'group-settings') { if (isGroupConversation(conversation)) showGroupSettingsView(); return; }
    if (action === 'project') { if (conversation.projectName) { showToast(`已在项目「${conversation.projectName}」中`); return; } if (!state.projects.length) { showApiProjects(); openApiProjectCreate(); return; } openApiProjectPicker(); return; }
    if (action === 'files') { const count = (conversation.messages || []).filter((message) => message.attachment).length; showToast(count ? `本对话有 ${count} 个已上传文件` : '本对话暂无已上传文件'); return; }
    if (action === 'find') { showToast('可在聊天内容中查找'); messageInput.focus(); return; }
    if (action === 'archive') { conversation.archived = true; conversation.updatedAt = Date.now(); saveConversations(); showToast('已归档当前对话'); return; }
    if (action === 'delete') {
      if (conversation._draft) {
        // 草稿从未落库，直接移除即可；保持至少一个默认对话
        state.conversations = state.conversations.filter((item) => item.id !== conversation.id);
        if (!state.conversations.length) state.conversations = [defaultConversation()];
        state.activeId = state.conversations[0]?.id || 'today';
      } else if (state.conversations.length <= 1) { conversation.messages = []; conversation.title = '今天的灵感'; conversation.projectName = ''; conversation.usage = {}; conversation.updatedAt = Date.now(); }
      else { state.conversations = state.conversations.filter((item) => item.id !== conversation.id); state.activeId = state.conversations[0]?.id || 'today'; }
      saveConversations(); renderMessages(); showToast('已删除当前对话');
    }
  };
  const baseApiHandler = window.DeepSeekEvents.onEvent;
  window.DeepSeekEvents.onEvent = (name, raw) => { if (name === 'test' && state.apiTestPending) { const data = safeJson(raw, {}); const models = Array.isArray(data.models) ? data.models.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean) : []; if (models.length) { state.apiModels = models; try { localStorage.setItem(API_MODELS_KEY, JSON.stringify(models)); } catch (_) {} if (!models.includes(state.api.model)) state.api.model = models[0]; renderApiModels(); persistChatSelection(); } setApiStatus(data.ok ? (data.message || '连接成功') : (data.message || '连接失败'), data.ok ? 'success' : 'error'); setApiTestBusy(false); state.apiTestPending = false; updateApiDot(data.ok ? 'online' : 'offline'); return; } baseApiHandler(name, raw); };

  $('attachmentButton').onclick = () => openOverlay(attachmentLayer, $('attachmentButton')); $('featureButton').onclick = () => openOverlay(featureLayer, $('featureButton')); $('contextButton').onclick = openContextCard; $('chatModelButton').onclick = () => openChatSelector($('chatModelButton'), 'model'); $('chatEffortButton').onclick = () => openChatSelector($('chatEffortButton'), 'effort'); document.querySelectorAll('[data-close-overlay]').forEach((node) => { node.onclick = closeOverlays; });
  // 展开态点击弹层按钮时记录输入框是否有焦点（pointerdown 早于任何焦点转移），
  // 弹层打开后据此恢复 messageInput 焦点、保持键盘与输入栏展开。
  ['attachmentButton', 'featureButton', 'chatModelButton', 'chatEffortButton', 'contextButton'].forEach((id) => {
    $(id)?.addEventListener('pointerdown', () => { keepComposerKeyboard = document.activeElement === messageInput; }, { passive: true });
  });
  document.querySelectorAll('[data-feature-action]').forEach((button) => { button.onclick = () => handleFeatureAction(button.dataset.featureAction || ''); });
  $('apiProjectPickerList')?.addEventListener('click', (event) => { const row = event.target.closest('.api-project-picker-row'); if (!row) return; addActiveChatToApiProject(state.projects.find((project) => String(project.id) === String(row.dataset.projectId))); });
  $('apiProjectPickerCreate')?.addEventListener('click', () => { closeOverlays(); openApiProjectCreate(); });
  projectMenuPopover?.addEventListener('click', (event) => { const button = event.target.closest('[data-project-action]'); if (button) executeProjectAction(button.dataset.projectAction || ''); });
  $('projectMenuConfirmCancel')?.addEventListener('click', () => { const block = $('projectMenuConfirm'); if (block) block.hidden = true; });
  $('projectMenuConfirmDelete')?.addEventListener('click', deleteCurrentProject);
  $('apiProjectNoteCancel')?.addEventListener('click', closeApiProjectNote);
  $('apiProjectNoteConfirm')?.addEventListener('click', saveApiProjectNote);
  $('apiProjectNoteScrim')?.addEventListener('click', closeApiProjectNote);
  $('apiProjectNoteInput')?.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeApiProjectNote(); if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') saveApiProjectNote(); });
  $('chatModelOptions')?.addEventListener('click', (event) => { const button = event.target.closest('[data-chat-model]'); if (!button) return; state.api.model = button.dataset.chatModel || 'deepseek-chat'; persistChatSelection(); syncChatSelectors(); closeOverlays(); showToast(`已切换到 ${state.api.model}`); });
  document.querySelectorAll('[data-chat-effort]').forEach((button) => { button.onclick = () => { state.selectedEffort = button.dataset.chatEffort || 'auto'; persistChatSelection(); syncChatSelectors(); closeOverlays(); showToast(`思考等级：${effortLabel(state.selectedEffort)}`); }; });
  document.querySelectorAll('[data-attachment-kind]').forEach((button) => { button.onclick = () => { closeOverlays(); attachmentInput.accept = button.dataset.attachmentKind === 'image' ? 'image/*' : '*/*'; attachmentInput.click(); }; });
  attachmentInput.onchange = () => { const file = attachmentInput.files?.[0]; if (file) setAttachment(file); };
  $('menuButton').onclick = openSidebar; document.querySelectorAll('[data-close-sidebar]').forEach((node) => { node.onclick = closeSidebar; });
  $('sidebarProjectsButton')?.addEventListener('click', showApiProjects); $('sidebarNewChatButton')?.addEventListener('click', startOrdinaryChat); $('sidebarSettingsButton').onclick = () => showSettingsView('chat'); $('sidebarRemoteButton').onclick = () => showRemoteView('remote');
  $('apiProjectsBackButton')?.addEventListener('click', showChatPage);
  $('apiProjectsAddButton')?.addEventListener('click', openApiProjectCreate);
  $('apiProjectsSearch')?.addEventListener('input', renderApiProjects);
  $('apiProjectsList')?.addEventListener('click', (event) => { if (state.longPressActive) { state.longPressActive = false; return; } const row = event.target.closest('.api-project-row'); if (!row) return; showApiProject(state.projects.find((project) => String(project.id) === String(row.dataset.projectId))); });
  $('apiProjectBackButton')?.addEventListener('click', showApiProjects);
  $('apiProjectSearch')?.addEventListener('input', renderApiProject);
  $('apiProjectChats')?.addEventListener('click', (event) => { const row = event.target.closest('.api-project-chat-row'); if (!row) return; cleanupDraftConversation(); state.activeId = String(row.dataset.conversationId || ''); showChatPage(); });
  $('apiProjectComposeButton')?.addEventListener('click', startApiProjectChat);
  $('apiProjectCreateScrim')?.addEventListener('click', closeApiProjectCreate);
  $('apiProjectCreateCancel')?.addEventListener('click', closeApiProjectCreate);
  $('apiProjectCreateConfirm')?.addEventListener('click', createApiProject);
  $('apiProjectNameInput')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); createApiProject(); } if (event.key === 'Escape') closeApiProjectCreate(); });
  $('conversationRenameScrim')?.addEventListener('click', closeConversationRename);
  $('conversationRenameCancel')?.addEventListener('click', closeConversationRename);
  $('conversationRenameConfirm')?.addEventListener('click', saveConversationRename);
  $('conversationRenameInput')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); saveConversationRename(); } if (event.key === 'Escape') closeConversationRename(); });
  $('shellSettingsCheckUpdateButton')?.addEventListener('click', () => {
    const remoteUpdateButton = remoteFrame?.contentDocument?.getElementById('updateButton');
    if (!remoteUpdateButton) { showToast('更新服务尚未就绪，请稍后重试'); return; }
    setShellUpdateIcon(shellUpdateMode, true);
    try { remoteUpdateButton.click(); showToast(shellUpdateMode === 'download' ? '正在下载更新…' : '正在检查更新…'); }
    catch (_) { setShellUpdateIcon(shellUpdateMode, false); showToast('暂时无法检查更新'); }
  });
  $('settingsBackButton').onclick = closeSettingsView;
  $('groupSettingsBackButton')?.addEventListener('click', closeGroupSettingsView);
  $('scheduleBackButton')?.addEventListener('click', showChatPage);
  $('scheduleMoreButton')?.addEventListener('click', () => showToast('日程更多设置即将开放'));
  $('schedulePreviousMonth')?.addEventListener('click', () => { scheduleMonthCursor = new Date(scheduleMonthCursor.getFullYear(), scheduleMonthCursor.getMonth() - 1, 1); renderScheduleCalendar(); });
  $('scheduleNextMonth')?.addEventListener('click', () => { scheduleMonthCursor = new Date(scheduleMonthCursor.getFullYear(), scheduleMonthCursor.getMonth() + 1, 1); renderScheduleCalendar(); });
  $('scheduleTodayButton')?.addEventListener('click', () => { scheduleMonthCursor = new Date(scheduleToday.getFullYear(), scheduleToday.getMonth(), 1); renderScheduleCalendar(); });
  $('schedulePlanAddButton')?.addEventListener('click', () => showToast('日程编辑即将开放'));
  $('scheduleNoteAddButton')?.addEventListener('click', () => showToast('日程记录即将开放'));
  $('scheduleAiButton')?.addEventListener('click', () => showSettingsView('chat'));
  $('groupSettingsMoreButton')?.addEventListener('click', () => showToast('群聊设置已打开'));
  $('groupSettingsSave')?.addEventListener('click', () => { saveGroupSettings(); closeGroupSettingsView(); showToast('群聊设置已保存'); });
  document.querySelectorAll('.group-setting-row').forEach((button) => {
    button.addEventListener('click', () => {
      const member = button.closest('[data-group-member]')?.dataset.groupMember || '';
      const setting = button.dataset.groupSetting || '';
      openGroupSettingEditor(member, setting);
    });
  });
  $('groupSettingEditorOptions')?.addEventListener('click', (event) => {
    const option = event.target.closest('.group-editor-option'); if (!option || !state.groupEditor) return;
    state.groupEditor.value = option.dataset.value || '';
    document.querySelectorAll('.group-editor-option').forEach((row) => row.classList.toggle('is-selected', row === option));
  });
  $('groupSettingEditorCancel')?.addEventListener('click', closeGroupSettingEditor);
  $('groupSettingEditorSave')?.addEventListener('click', saveGroupSettingEditor);
  document.querySelectorAll('[data-project-name]').forEach((button) => { button.onclick = () => { const project = button.dataset.projectName || ''; const conversation = activeConversation(); conversation.projectName = project; conversation.updatedAt = Date.now(); saveConversations(); showToast(`已选择项目：${project}`); renderMessages(); }; });
  $('composer').onsubmit = (event) => { event.preventDefault(); sendMessage(); }; messageInput.oninput = () => { messageInput.style.height = '42px'; messageInput.style.height = `${Math.min(112, messageInput.scrollHeight)}px`; }; $('apiSaveButton').onclick = saveApiConfig; $('apiTestButton').onclick = testApi;
  messageInput.onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } };
  // 标题滚动测量兜底：字体就绪、胶囊尺寸变化、窗口变化时重测
  try { document.fonts?.ready?.then(() => syncTitleMarquee()); } catch (_) {}
  window.addEventListener('resize', syncTitleMarquee);
  const titlePill = $('conversationTitle')?.closest('.conversation-title-pill');
  if (titlePill && 'ResizeObserver' in window) { try { new ResizeObserver(() => syncTitleMarquee()).observe(titlePill); } catch (_) {} }
  window.addEventListener('keydown', (event) => { if (event.key !== 'Escape') return; if (!settingsView.hidden) closeSettingsView(); else if (groupSettingEditorLayer && !groupSettingEditorLayer.hidden) closeGroupSettingEditor(); else if (groupSettingsView && !groupSettingsView.hidden) closeGroupSettingsView(); else if (scheduleView && !scheduleView.hidden) showChatPage(); else { closeOverlays(); closeSidebar(); } });
  window.handleSystemBack = () => {
    if (!settingsView.hidden) { closeSettingsView(); return true; }
    if (groupSettingEditorLayer && !groupSettingEditorLayer.hidden) { closeGroupSettingEditor(); return true; }
    if (groupSettingsView && !groupSettingsView.hidden) { closeGroupSettingsView(); return true; }
    if (scheduleView && !scheduleView.hidden) { showChatPage(); return true; }
    if (apiProjectCreateLayer && !apiProjectCreateLayer.hidden) { closeApiProjectCreate(); return true; }
    if (conversationRenameLayer && !conversationRenameLayer.hidden) { closeConversationRename(); return true; }
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
    if (!attachmentLayer.hidden || !featureLayer.hidden || (chatSelectorLayer && !chatSelectorLayer.hidden) || (contextLayer && !contextLayer.hidden)) { closeOverlays(); return true; }
    // 主页（无任何弹层/页面可关闭）：第一次返回提示，2 秒内再次返回才放行退出
    const now = Date.now();
    if (now > exitBackDeadline) { exitBackDeadline = now + 2000; showToast('再按一次退出'); return true; }
    exitBackDeadline = 0;
    return false;
  };

  migrateLegacyState();
  loadConversations(); loadProjects(); loadApiConfig(); loadGroupSettings(); renderMessages();
  // 开屏：仅本次应用启动播一次（sessionStorage 标记；预览模式跳过）。
  // 播放期间 chatPage 保持 hidden（开屏盖在其上），结束后移除遮罩并触发 view-in 入场。
  if (shouldPlaySplash && splash) {
    splash.addEventListener('animationend', (event) => { if (event.target === splash && event.animationName === 'splash-cycle') finishSplash(); });
    setTimeout(finishSplash, 1100); // 兜底：动画事件缺失时也不卡住界面
    requestAnimationFrame(() => { if (!splashDone) splash.classList.add('splash-play'); });
  } else {
    finishSplash();
  }
})();
