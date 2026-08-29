(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const native = window.AndroidRemote || null;
  const previewQuery = new URLSearchParams(window.location.search);
  const browserPreview = previewQuery.get('preview') === 'magic5pro';
  const embeddedRemote = previewQuery.get('embedded') === '1';
  const state = { snapshot: {}, connected: false, connectionState: 'retrying', replying: false, composerExpanded: false, composerFocusGuardUntil: 0, selectorKind: '', selectedPermission: 'workspace-write', selectedModel: { provider: 'opengo', model: 'hy3', reasoningEffort: '' }, selectedEffort: '', modelSelectionTouched: false, permissionSelectionTouched: false, events: [], eventHistory: {}, chatLocalItems: [], sessionHistory: {}, sessionAliases: {}, sessionContextUsage: {}, historyWarmInFlight: false, historyWarmSessionId: '', openingChatSessionId: '', creatingChatProject: null, pendingDraftPrompt: null, renderedChat: { sessionId: '', keys: [] }, expandedThinkingIds: {}, lastEventAt: 0, selectedChat: null, selectedProject: null, projectOrigin: 'home', chatOrigin: 'home', pinnedIds: [], archivedIds: [], renamedTitles: {}, expandedSessionGroups: {}, localProjects: [], autoFollowChat: true, followResumeTimer: null, programmaticScrollUntil: 0, pendingImages: [] };
  let settings = { endpoint: '', token: '' };
  let toastTimer = null;
  let liveSocket = null;
  let liveReconnectTimer = null;
  let liveReconnectAttempt = 0;
  let liveSocketManualClose = false;
  let updateMode = 'check';
  let updateTimer = null;
  const announceUpdateState = (status, data = {}) => {
    if (window.parent !== window) {
      try { window.parent.postMessage({ type: 'dsh-update-state', status, data }, '*'); } catch (_) {}
    }
  };
  const setSettingsUpdateIcon = (mode = 'check', busy = false) => {
    const button = $('settingsCheckUpdateButton');
    if (!button) return;
    const image = button.querySelector('img');
    const download = mode === 'download';
    if (image) image.src = `./icons/settings-generated/${download ? 'download' : 'update'}.png?v=selected-set-2`;
    button.setAttribute('aria-label', download ? '下载更新' : '检查更新');
    button.setAttribute('aria-busy', String(Boolean(busy)));
    button.classList.toggle('is-checking', Boolean(busy));
    button.disabled = Boolean(busy);
    const actionButton = $('updateButton');
    if (actionButton) actionButton.disabled = Boolean(busy);
  };
  const armUpdateTimeout = (operation = 'check') => {
    const downloading = operation === 'download';
    const message = downloading ? '下载更新超时，请确认 Bridge 正在运行。' : '检查更新超时，请确认 Bridge 正在运行。';
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateMode = 'check';
      setSettingsUpdateIcon('check', false);
      $('settingsStatus').textContent = message;
      $('updateButton').textContent = '重新检查';
      showToast(downloading ? '下载更新超时' : '检查更新超时');
      announceUpdateState('update-error', { message });
    }, downloading ? 120000 : 15000);
  };

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
  const DSH_FOLDER_ICON = 'folder2.svg';

  const PROJECTS_STORAGE_KEY = 'dsh.remote.localProjects';
  const projectNameKey = (value) => String(value || '').trim().toLocaleLowerCase();
  const isVirtualProject = (project) => {
    const id = projectNameKey(project?.id);
    const name = projectNameKey(project?.name || project?.title);
    return ['all', 'created', 'mine', 'shared', '全部', '我创建的', '与你共享'].includes(id)
      || ['全部', '我创建的', '与你共享', 'all', 'my projects', 'shared with you'].includes(name);
  };
  const projectCatalog = () => {
    const remoteProjects = Array.isArray(state.snapshot?.projects) ? state.snapshot.projects : [];
    const localProjects = Array.isArray(state.localProjects) ? state.localProjects : [];
    const merged = [...remoteProjects, ...localProjects].filter((project) => {
      const name = String(project?.name || project?.title || '').trim();
      return name && !isVirtualProject(project);
    });
    const seen = new Set();
    return merged.filter((project) => {
      const key = String(project?.id || '').trim() || projectNameKey(project?.name || project?.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

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
  state.expandedSessionGroups = readLocal('dsh.remote.expandedSessionGroups', {});
  state.localProjects = readLocal(PROJECTS_STORAGE_KEY, []);
  if (!Array.isArray(state.localProjects)) state.localProjects = [];
  const cleanLocalProjects = state.localProjects.filter((project) => !isVirtualProject(project));
  if (cleanLocalProjects.length !== state.localProjects.length) {
    state.localProjects = cleanLocalProjects;
    writeLocal(PROJECTS_STORAGE_KEY, state.localProjects);
  }
  if (!state.expandedSessionGroups || typeof state.expandedSessionGroups !== 'object' || Array.isArray(state.expandedSessionGroups)) state.expandedSessionGroups = {};
  const text = (id, value, fallback = '—') => { $(id).textContent = value === undefined || value === null || value === '' ? fallback : String(value); };
  const escapeAttribute = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const showToast = (message) => {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
  };
  const stateName = (value) => ({ running: '正在工作', waiting: '等待处理', paused: '已暂停', completed: '已完成', failed: '执行失败', idle: '等待 DSH' }[value] || value || '等待 DSH');
  const phaseName = (value) => ({ starting: '启动', thinking: '思考', tool: '工具', terminal: '命令', approval: '审批', completed: '完成', failed: '失败' }[value] || value || '—');
  const collapseComposerIfKeyboardClosed = () => {
    const input = $('promptInput');
    const webInset = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--web-keyboard-bottom'), 10) || 0;
    const nativeInset = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--native-keyboard-bottom'), 10) || 0;
    if (!state.composerExpanded || webInset > 0 || nativeInset > 0 || input?.value || state.selectorKind || $('chatAttachmentLayer')?.hidden === false) return;
    if (Date.now() < state.composerFocusGuardUntil) {
      window.setTimeout(collapseComposerIfKeyboardClosed, 180);
      return;
    }
    state.composerExpanded = false;
    if (input) input.style.height = 'auto';
    syncComposerState();
  };
  const syncWebKeyboardInset = () => {
    const viewport = window.visualViewport;
    const inset = viewport ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)) : 0;
    document.documentElement.style.setProperty('--web-keyboard-bottom', `${inset}px`);
    const input = $('promptInput');
    // Android may keep the textarea focused after the IME is dismissed. Do not
    // use activeElement as the keyboard signal; the native/web insets are the
    // source of truth and collapse the composer after the IME animation settles.
    if (inset <= 0 && input) window.setTimeout(collapseComposerIfKeyboardClosed, 140);
    // When the IME rises, scroll the newest message above the keyboard so the
    // composer never covers it. Defer past the layout animation for stability.
    if (inset > 0) window.setTimeout(keepComposerVisible, 240);
  };
  const syncComposerViewport = () => {
    const composer = $('chatComposer');
    if (!composer) return;
    const rect = composer.getBoundingClientRect();
    // Measure reserve as the gap between the composer top and the scroll
    // container's bottom. Using the scroller's bottom (rather than the viewport
    // height) makes the keyboard/safe-area offsets cancel out, so the reserve is
    // exactly the composer's own blocked height and is not double-counted by the
    // .chat-scroll padding that also adds the same keyboard/safe terms.
    const scroller = $('chatScroll');
    const scrollRect = scroller ? scroller.getBoundingClientRect() : null;
    const blocked = scrollRect
      ? Math.max(0, Math.round(scrollRect.bottom - rect.top))
      : Math.max(0, Math.round((window.visualViewport?.height || window.innerHeight || 0) - rect.top));
    document.documentElement.style.setProperty('--chat-composer-reserve', `${blocked + 18}px`);
    syncWebKeyboardInset();
  };
  // The composer expand/collapse animation animates padding, and growing the
  // textarea changes height. Both shift the composer's top edge, so re-measure
  // the reserve and re-pin the newest message once either animation settles.
  // Otherwise the reserve stays locked to the mid-animation size and the last
  // message is left underneath the grown composer.
  $('chatComposer')?.addEventListener('transitionend', (event) => {
    if (event?.propertyName !== 'height' && event?.propertyName !== 'padding') return;
    requestAnimationFrame(() => {
      syncComposerViewport();
      const scroller = $('chatScroll');
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    });
  }, { passive: true });
  const keepComposerVisible = () => {
    if ($('dashboardView')?.hidden) return;
    const scroller = $('chatScroll');
    if (!scroller) return;
    requestAnimationFrame(() => {
      syncComposerViewport();
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    });
  };
  const keepSearchVisible = (input) => {
    syncWebKeyboardInset();
    window.setTimeout(() => input?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }), 180);
  };
  const isChatAtBottom = (scroller = $('chatScroll')) => Boolean(scroller) && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 30;
  const updateScrollBottomButton = () => {
    const scroller = $('chatScroll');
    const button = $('chatScrollBottom');
    if (!scroller || !button) return;
    const visible = scroller.scrollHeight - scroller.clientHeight > 20 && !isChatAtBottom(scroller);
    button.classList.toggle('is-visible', visible);
    button.setAttribute('aria-hidden', String(!visible));
  };
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
      syncComposerViewport();
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    });
  };
  // A chat view is reused between conversations.  On Android WebView its
  // previous scroll offset can survive a view transition, which opened a new
  // DSH chat in the middle of the transcript.  Pin a newly opened chat to
  // the newest message before and after the DOM settles.
  const snapChatToLatest = () => {
    state.autoFollowChat = true;
    state.programmaticScrollUntil = performance.now() + 900;
    const snap = () => {
      const scroller = $('chatScroll');
      if (!scroller) return;
      syncComposerViewport();
      scroller.scrollTop = scroller.scrollHeight;
      updateScrollBottomButton();
    };
    requestAnimationFrame(() => {
      snap();
      requestAnimationFrame(snap);
      window.setTimeout(snap, 90);
    });
  };
  const canonicalSessionId = (value) => {
    let id = String(value || '');
    const seen = new Set();
    while (id && state.sessionAliases?.[id] && !seen.has(id)) {
      seen.add(id);
      id = String(state.sessionAliases[id] || '');
    }
    return id;
  };
  const isSyntheticSessionId = (value) => /^(dsh-|preview-session-|draft:)/i.test(String(value || ''));
  const mergeSessionHistory = (fromId, toId) => {
    const from = String(fromId || '');
    const to = String(toId || '');
    if (!from || !to || from === to) return;
    const source = state.sessionHistory[from];
    if (!source) return;
    const target = state.sessionHistory[to] || { items: [], hasMore: true, nextBefore: null, loading: false, loadingOlder: false, loadingTimer: null, lastTimestamp: 0, lastSeq: 0 };
    const merged = new Map();
    [...(target.items || []), ...(source.items || [])].forEach((item, index) => {
      const key = String(item.id || `${item.kind || 'item'}:${item.seq ?? ''}:${item.timestamp ?? ''}:${index}`);
      merged.set(key, item);
    });
    target.items = [...merged.values()].sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0) || Number(left.timestamp || 0) - Number(right.timestamp || 0));
    target.lastTimestamp = Math.max(Number(target.lastTimestamp || 0), Number(source.lastTimestamp || 0));
    target.lastSeq = Math.max(Number(target.lastSeq || 0), Number(source.lastSeq || 0));
    target.hasMore = Boolean(target.hasMore || source.hasMore);
    if (target.nextBefore === null || target.nextBefore === undefined) target.nextBefore = source.nextBefore ?? null;
    state.sessionHistory[to] = target;
    if (target !== source) clearTimeout(source.loadingTimer);
    delete state.sessionHistory[from];
    const sourceEvents = state.eventHistory[from];
    if (Array.isArray(sourceEvents)) {
      const targetEvents = state.eventHistory[to] || [];
      const mergedEvents = new Map();
      [...targetEvents, ...sourceEvents].forEach((event, index) => mergedEvents.set(eventHistoryKey(event, index), event));
      state.eventHistory[to] = [...mergedEvents.values()].slice(-1200);
      delete state.eventHistory[from];
    }
  };
  const linkSessionIds = (fromId, toId) => {
    const from = canonicalSessionId(fromId);
    const to = canonicalSessionId(toId);
    if (!from || !to || from === to) return to || from;
    state.sessionAliases[from] = to;
    mergeSessionHistory(from, to);
    state.chatLocalItems.forEach((item) => {
      if (String(item.sessionId || '') === from) item.sessionId = to;
    });
    return to;
  };
  const reconcileCurrentSession = (nextId, previousSnapshotId = state.snapshot?.session?.id) => {
    const next = String(nextId || '');
    if (!next) return '';
    const previous = String(previousSnapshotId || '');
    const selected = String(state.selectedChat?.id || '');
    // A temporary draft/probe ID may legitimately be replaced once DSH creates
    // the real session.  Two real DSH IDs must never be linked, even if a
    // delayed snapshot changes the active session while the user is reading a
    // different history.  Linking real IDs is what made the SVG conversation
    // appear to contain messages from another chat.
    const previousIsSynthetic = isSyntheticSessionId(previous);
    const selectedIsSynthetic = isSyntheticSessionId(selected);
    if (previousIsSynthetic && previous !== next && (!selected || selected === previous || selectedIsSynthetic)) linkSessionIds(previous, next);
    if (selectedIsSynthetic && selected !== next) linkSessionIds(selected, next);
    if (state.selectedChat && selected && canonicalSessionId(selected) === next) state.selectedChat.id = next;
    return canonicalSessionId(next);
  };
  const activeChatSessionId = () => canonicalSessionId(state.selectedChat?.id || state.snapshot?.session?.id || '');
  const eventSessionId = (event, fallback = '') => String(event?.sessionId || event?.data?.sessionId || event?.data?.session?.id || event?.session?.id || fallback || '');
  const eventHistoryKey = (event, index = 0) => {
    const data = event?.data || {};
    const type = String(event?.type || data.type || '');
    const id = String(event?.id || data.eventId || data.id || '');
    const sourceSeq = String(data.sourceSeq ?? data.seq ?? event?.seq ?? '');
    const timestamp = String(event?.timestamp || event?.time || data.timestamp || data.time || '');
    const messageId = String(data.messageId || data.replyId || '');
    const payload = String(data.text ?? data.delta ?? data.chunk ?? data.content ?? data.message ?? data.summary ?? data.label ?? '');
    return id ? `id:${id}` : `${type}|${sourceSeq}|${timestamp}|${messageId}|${payload}|${index}`;
  };
  const rememberSessionEvent = (event, fallbackSessionId = '') => {
    const sessionId = canonicalSessionId(eventSessionId(event, fallbackSessionId));
    if (!sessionId) return;
    const normalized = eventSessionId(event) ? event : { ...event, sessionId };
    const bucket = state.eventHistory[sessionId] || [];
    const key = eventHistoryKey(normalized);
    const existingIndex = bucket.findIndex((item, index) => eventHistoryKey(item, index) === key);
    if (existingIndex >= 0) bucket[existingIndex] = normalized;
    else bucket.push(normalized);
    // Keep enough live events for a long response plus a queued follow-up,
    // without allowing a noisy terminal stream to grow the WebView forever.
    if (bucket.length > 1200) bucket.splice(0, bucket.length - 1200);
    state.eventHistory[sessionId] = bucket;
  };
  const eventsForSession = (sessionId) => {
    const id = canonicalSessionId(sessionId);
    const cached = state.eventHistory[id];
    if (Array.isArray(cached)) return cached;
    return state.events.filter((event) => canonicalSessionId(eventSessionId(event, id)) === id);
  };
  const hasExplicitEventTimestamp = (event) => [event?.timestamp, event?.time, event?.data?.timestamp, event?.data?.time, event?.createdAt, event?.data?.createdAt].some((value) => value !== undefined && value !== null && value !== '');
  const eventTimestamp = (event, fallback = 0) => Number(event?.timestamp || event?.time || event?.data?.timestamp || event?.data?.time || event?.createdAt || event?.data?.createdAt || fallback || 0);
  const itemIdentityKey = (item, index) => String(item.id || `${item.kind || 'item'}:${item.seq ?? ''}:${item.timestamp ?? ''}:${index}`);
  const itemKey = (item, index) => {
    const identity = itemIdentityKey(item, index);
    const textValue = String(item.text || '');
    const imageValue = Array.isArray(item.images) ? item.images.map((image) => String(typeof image === 'string' ? image : (image?.name || image?.dataUrl || ''))).join('|') : '';
    return `${identity}:${item.kind || ''}:${item.icon || ''}:${textValue}:${imageValue}`;
  };
  const samePrefix = (whole, prefix) => prefix.every((value, index) => whole[index] === value);
  const sameSuffix = (whole, suffix) => suffix.every((value, index) => whole[whole.length - suffix.length + index] === value);
  const HISTORY_WARM_ITEM_TARGET = 360;
  const HISTORY_PRELOAD_MIN_DISTANCE = 440;
  let viewTransitionTimer = null;
  let chatTouchStartY = null;

  function transportOpen() {
    return Boolean((native && state.connected && typeof native.requestHistory === 'function') || liveSocketOpen());
  }

  function activateChatSession(sessionId) {
    const id = canonicalSessionId(String(sessionId || ''));
    if (!id || !transportOpen()) return false;
    if (native && state.connected && typeof native.activateSession === 'function') return Boolean(native.activateSession(id));
    return sendLiveMessage('session.activate', { sessionId: id });
  }

  function requestSessionContext(sessionId) {
    const id = canonicalSessionId(String(sessionId || ''));
    if (!id || !transportOpen()) return false;
    if (native && state.connected && typeof native.requestSessionContext === 'function') return Boolean(native.requestSessionContext(id));
    return sendLiveMessage('session.context.request', { sessionId: id });
  }

  function requestSessionHistory(sessionId, { beforeSeq, limit = 72, refresh = false } = {}) {
    const id = canonicalSessionId(String(sessionId || ''));
    if (!id || isSyntheticSessionId(id) || !transportOpen()) return false;
    const history = state.sessionHistory[id] || { items: [], hasMore: true, nextBefore: null, loading: false, loadingOlder: false, loadingTimer: null, lastTimestamp: 0 };
    if (history.loading || (beforeSeq !== undefined && !history.hasMore)) return false;
    history.loading = true;
    history.loadingOlder = beforeSeq !== undefined;
    clearTimeout(history.loadingTimer);
    state.sessionHistory[id] = history;
    const sent = native && state.connected && refresh && typeof native.refreshHistory === 'function'
      ? Boolean(native.refreshHistory(id, limit))
      : native && state.connected && typeof native.requestHistory === 'function'
        ? Boolean(native.requestHistory(id, beforeSeq === undefined ? -1 : Number(beforeSeq), limit))
        : sendLiveMessage('session.history.request', { sessionId: id, beforeSeq, limit, refresh });
    if (!sent) {
      history.loading = false;
      history.loadingOlder = false;
    } else if (history.loadingOlder) {
      // Do not leave the quiet preload hint on screen forever if a connection
      // drops between request and response. The next scroll can safely retry.
      history.loadingTimer = setTimeout(() => {
        if (!history.loading) return;
        history.loading = false;
        history.loadingOlder = false;
        history.loadingTimer = null;
        queueRender();
      }, 10000);
    }
    queueRender();
    return sent;
  }

  function warmRecentHistories() {
    if (state.historyWarmInFlight || !transportOpen()) return false;
    const uniqueIds = new Set();
    const candidates = [
      state.snapshot?.session?.id,
      ...(Array.isArray(state.snapshot?.recent) ? state.snapshot.recent.map((item) => item?.id) : []),
    ].map((value) => canonicalSessionId(String(value || ''))).filter((id) => id && !uniqueIds.has(id) && (uniqueIds.add(id) || true));
    for (const sessionId of candidates) {
      const history = state.sessionHistory[sessionId] || { items: [], hasMore: true, nextBefore: null, loading: false, loadingOlder: false, loadingTimer: null, lastTimestamp: 0 };
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
    if (history?.hasMore && !history.loading && history.nextBefore !== null) requestSessionHistory(id, { beforeSeq: history.nextBefore, limit: 120 });
  }
  function refreshActiveChat() {
    const id = activeChatSessionId();
    if (!id || !transportOpen()) { showToast('当前未连接 Bridge'); return; }
    state.sessionHistory[id] = { items: [], hasMore: true, nextBefore: null, loading: false, loadingOlder: false, loadingTimer: null, lastTimestamp: 0, lastSeq: 0 };
    state.renderedChat = { sessionId: '', keys: [], identityKeys: [] };
    // A pull-to-refresh starts at the top. Keep that position while the
    // refreshed pages arrive instead of treating it like a new reply and
    // animating back to the latest message.
    state.autoFollowChat = false;
    clearFollowResume();
    activateChatSession(id);
    requestSessionHistory(id, { limit: 120, refresh: true });
    control('requestSnapshot');
    showToast('正在刷新当前对话');
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
    for (const value of [d.thought, d.reasoning, d.analysis, d.thinking, d.summary, d.label, d.command, d.text, d.content, d.reply, d.response, d.delta, d.chunk, d.textDelta, d.message, d.path, d.title, d.detail]) {
      const result = textFromStreamValue(value);
      if (result) return result;
    }
    return '';
  };
  const textFromStreamValue = (value) => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((part) => textFromStreamValue(part)).filter(Boolean).join('\n');
    if (!value || typeof value !== 'object') return '';
    for (const key of ['text', 'content', 'message', 'summary', 'detail', 'thought', 'reasoning', 'analysis', 'output', 'delta', 'chunk']) {
      if (value[key] !== undefined && value[key] !== null) {
        const result = textFromStreamValue(value[key]);
        if (result) return result;
      }
    }
    return '';
  };
  const streamText = (event) => {
    const d = event?.data || {};
    for (const value of [d.text, d.content, d.reply, d.response, d.body, d.markdown, d.lastMessage, d.delta, d.chunk, d.textDelta, d.message]) {
      const result = textFromStreamValue(value);
      if (result) return result;
    }
    return '';
  };
  const isInternalRuntimeContextText = (value) => {
    const textValue = String(value || '').trim();
    if (!textValue) return false;
    return /^Current runtime context\.\s*This snapshot supersedes earlier runtime-context snapshots\./i.test(textValue)
      || /^Current DSH file policy:/i.test(textValue)
      || /^当前运行时上下文[：:]/.test(textValue)
      || /^当前 DSH 文件策略[：:]/.test(textValue);
  };
  const isInternalRuntimeContextItem = (item) => {
    const kind = String(item?.kind || item?.type || '').toLowerCase();
    const textValue = item?.text || item?.content || item?.message || '';
    return kind.includes('context') || isInternalRuntimeContextText(textValue);
  };
  const streamIsDelta = (event) => {
    const d = event?.data || {};
    return d.delta === true || d.append === true || d.isDelta === true || d.mode === 'delta' || d.chunk !== undefined || d.textDelta !== undefined;
  };
  const mergeStreamText = (previous, incoming, event) => {
    const next = String(incoming || '');
    if (!next) return String(previous || '');
    const before = String(previous || '');
    if (!before || (!streamIsDelta(event) && next.startsWith(before))) return next;
    if (streamIsDelta(event)) return before + next;
    return next;
  };

  const thinkingEventType = (value) => {
    const type = String(value || '').toLowerCase();
    return type === 'agent.thinking' || type.includes('thinking') || type.includes('reasoning') || type.includes('thought');
  };
  const thinkingItemText = (item) => {
    for (const value of [item?.thought, item?.reasoning, item?.analysis, item?.thinking, item?.summary, item?.detail, item?.text, item?.content, item?.message]) {
      const result = textFromStreamValue(value);
      if (result) return result;
    }
    return '';
  };
  const normalizeChatHistoryItem = (item) => {
    const type = item?.type || item?.eventType || item?.event || item?.kind;
    if (!thinkingEventType(type) && !/^\s*(think|思考)\s*[·:：]/i.test(String(item?.text || ''))) return item;
    return { ...item, kind: 'thinking', icon: item.icon || 'chat-think.png', title: 'Think', text: thinkingItemText(item) || '思考中' };
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

  function seedBrowserChatPreview() {
    if (!browserPreview) return;
    document.body.classList.add('browser-preview');
    const sessionId = 'preview-session-remote';
    const now = Date.now();
    const previewItems = [
      { kind: 'bubble', text: '帮我把聊天内容也放进模拟机里，看看真实的 DSH 回复效果。', timestamp: now - 126000 },
      { kind: 'thinking', icon: 'chat-think.png', title: 'Think', text: 'Wait — the folder tab: rows 20-35 left region x15-60 is solid, but rows 36-40 are empty. That means the folder tab is a separate band from the body. I am checking the boundary before continuing.', timestamp: now - 119000 },
      { kind: 'event', icon: 'chat-grep.png', text: '读取项目状态 · remote-preview', timestamp: now - 111000 },
      { kind: 'event', icon: 'chat-terminal.png', text: '命令执行 · 检查消息同步链路', timestamp: now - 103000 },
      { kind: 'note', text: '我先检查当前会话的消息流，再把最终结果同步到手机端。\n预览中会保留思考、工具、正文和用户气泡。', timestamp: now - 92000 },
      { kind: 'bubble', text: '好的，继续检查回复和滚动效果。', timestamp: now - 76000 },
      { kind: 'event', icon: 'chat-read.png', text: '阅读 · app.js / styles.css', timestamp: now - 68000 },
      { kind: 'event', icon: 'chat-terminal.png', text: '命令执行 · 生成网页预览', timestamp: now - 59000 },
      { kind: 'note', text: '网页模拟已经加载了示例聊天。\n\n你可以：\n- 上下滑动查看历史消息；\n- 滑离底部后点击屏幕下方的箭头回到底部；\n- 点击输入栏、加号、权限或模型区域测试交互。', timestamp: now - 43000 },
      { kind: 'event', icon: 'chat-think.png', text: '会话完成', timestamp: now - 24000 },
      { kind: 'note', text: '这是一条最终示例回复。之后接入真实 Bridge 时，这些内容会替换为 DSH 实时事件和完整正文。', timestamp: now - 9000 },
    ];
    state.snapshot = {
      project: { id: 'preview-project', name: 'dsh插件' },
      projects: [{ id: 'preview-project', name: 'dsh插件', asset: 'folder2.svg' }],
      recent: [{ id: sessionId, title: 'Remote DSH · 聊天预览', projectId: 'preview-project', projectName: 'dsh插件', updatedAt: now }],
      session: { id: sessionId, title: 'Remote DSH · 聊天预览' },
      device: { name: 'MagicBook' },
      state: 'completed',
      phase: 'completed',
      updatedAt: now,
      usage: { percent: 39, contextUsed: 389000, contextLimit: 1000000, systemPrompt: 1600, tools: 6800, messages: 7100 },
    };
    state.selectedChat = { id: sessionId, title: 'Remote DSH · 聊天预览', projectId: 'preview-project', projectName: 'dsh插件' };
    state.chatOrigin = 'home';
    state.sessionHistory[sessionId] = { items: previewItems, hasMore: false, nextBefore: null, loading: false, loadingOlder: false, loadingTimer: null, lastTimestamp: now, lastSeq: previewItems.length };
    state.connected = true;
    state.connectionState = 'online';
    state.replying = false;
    state.autoFollowChat = true;
  }
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

  // DSH marks child-agent sessions with rows.subagent.val.identity and may
  // additionally provide a parentSessionId. Keep this classification in the
  // client so formal conversations and subagents remain visibly distinct even
  // when the parent is outside the Bridge's recent-session window.
  function getSessionRole(item) {
    // Different Bridge/DSH builds have exposed the same projection at a few
    // equivalent paths. Read all of them so an app update does not silently
    // turn child-agent sessions back into ordinary conversations.
    const rawValues = [
      item?.subagent,
      item?.rows?.subagent,
      item?.rows?.subagent?.val,
      item?.projections?.values?.subagent,
      item?.metadata?.subagent,
      item?.identity?.subagent,
    ].filter((value) => value !== undefined && value !== null);
    const identities = rawValues.flatMap((value) => [
      value?.identity,
      value?.val?.identity,
      value?.value?.identity,
      value?.subagent?.identity,
      value,
    ]);
    const identity = identities.find((value) => value && typeof value === 'object'
      && (value.label || value.mode || value.seq !== undefined)) || {};
    const parentSessionId = String(
      item?.parentSessionId
      || identity?.parentSessionId
      || rawValues.find((value) => value?.parentSessionId)?.parentSessionId
      || '',
    ).trim();
    const label = String(
      identity?.label
      || item?.subagentLabel
      || rawValues.find((value) => value?.label)?.label
      || '',
    ).trim();
    const hasStructuredIdentity = rawValues.some((value) => value && typeof value === 'object' && Object.keys(value).length);
    const title = String(item?.title || item?.name || '').trim();
    // Older DSH projections did not carry rows.subagent into the recent list,
    // but their generated child-session titles still contain these stable
    // child-agent prefixes. This fallback is deliberately narrow so ordinary
    // user conversations are not relabelled.
    const inferredFromTitle = /^(?:你是只读(?:代码调研助手|核验子代理)|你是一个(?:只读代码调研助手|代码调研助手)|你是(?:资深(?: Web| Android)? 前端工程师|实现助手)|你要为[“"]DSH 手机远程)/.test(title);
    const isSubagent = Boolean(parentSessionId || label || hasStructuredIdentity || inferredFromTitle);
    return { isSubagent, parentSessionId, label, inferredFromTitle };
  }

  function buildSessionRows(items) {
    const source = Array.isArray(items) ? items : [];
    const byId = new Map(source.map((item) => [String(item?.id || ''), item]));
    const children = new Map();
    const roots = [];
    source.forEach((item) => {
      const role = getSessionRole(item);
      const parentId = role.parentSessionId;
      if (parentId && byId.has(parentId) && parentId !== String(item?.id || '')) {
        const list = children.get(parentId) || [];
        list.push(item);
        children.set(parentId, list);
      } else {
        roots.push(item);
      }
    });
    const rows = [];
    const append = (item, depth = 0) => {
      const id = String(item?.id || '');
      const role = getSessionRole(item);
      const childItems = children.get(id) || [];
      const expanded = childItems.length > 0 && state.expandedSessionGroups[id] === true;
      rows.push({ item, role, depth, groupId: id, childCount: childItems.length, expanded });
      if (expanded) childItems.forEach((child) => append(child, depth + 1));
    };
    roots.forEach((item) => append(item));
    return rows;
  }

  function toggleSessionGroup(groupId) {
    const id = String(groupId || '').trim();
    if (!id) return;
    state.expandedSessionGroups[id] = state.expandedSessionGroups[id] !== true;
    writeLocal('dsh.remote.expandedSessionGroups', state.expandedSessionGroups);
    if (!$('homeView')?.hidden) renderHome();
    if (!$('projectView')?.hidden) renderProject();
  }

  function sessionGroupToggleMarkup(row) {
    if (!row.childCount) return '';
    const expanded = row.expanded;
    return `<span class="session-group-toggle${expanded ? ' is-expanded' : ''}" data-toggle-subagents="true" data-group-id="${escapeAttribute(row.groupId)}" aria-expanded="${expanded}" aria-label="${expanded ? '收起子代理' : '展开子代理'}"><span class="session-group-chevron" aria-hidden="true"></span><span class="session-group-count">${row.childCount}</span></span>`;
  }

  function subagentTitle(item, fallbackTitle) {
    const role = getSessionRole(item);
    if (!role.isSubagent) return fallbackTitle;
    return role.label || fallbackTitle || '子代理';
  }

  function renderHome() {
    const projectRoot = $('homeProjects');
    if (!projectRoot) return;
    const query = String($('homeSearch')?.value || '').trim().toLowerCase();
    const snapshot = state.snapshot || {};
    const projects = projectCatalog();
    const visibleProjects = projects;
    const deviceName = snapshot.device?.name || 'MagicBook';
    if ($('homeDevice')) text('homeDevice', deviceName);
    text('drawerDevice', deviceName);

    projectRoot.replaceChildren();
    visibleProjects.filter((item) => !query || String(item.name || '').toLowerCase().includes(query)).forEach((item) => {
      const projectId = String(item.id || '');
      const row = document.createElement('button');
      row.className = 'home-row project-row';
      row.type = 'button';
      row.dataset.projectId = projectId;
      row.dataset.projectName = String(item.name || item.title || 'DSH');
      row.dataset.projectCwd = String(item.cwd || item.path || '');
      row.dataset.projectWorkspaceId = String(item.workspaceId || '');
      row.innerHTML = `<img class="home-row-icon" src="./icons/${DSH_FOLDER_ICON}" alt=""><span class="home-row-title"></span>`;
      row.querySelector('.home-row-title').textContent = shortHomeTitle(row.dataset.projectName);
      projectRoot.append(row);
    });
    const homeConnectionState = state.connected ? 'online' : (state.connectionState || 'retrying');
    updateConnectionDot($('homeDeviceDot'), homeConnectionState);
  }

  function projectDateLabel(project) {
    const projectId = String(project?.id || '').trim();
    const projectName = projectNameKey(project?.name || project?.title);
    const recent = (Array.isArray(state.snapshot?.recent) ? state.snapshot.recent : []).find((item) => {
      return (projectId && String(item?.projectId || '').trim() === projectId) || (projectName && projectNameKey(item?.projectName || item?.project) === projectName);
    });
    const rawTimestamp = Number(project?.updatedAt || project?.lastActivityAt || project?.createdAt || project?.updated_at || project?.last_activity_at || project?.created_at || project?.date || recent?.updatedAt || recent?.lastActivityAt || recent?.createdAt || state.snapshot?.updatedAt || 0);
    const timestamp = rawTimestamp > 0 && rawTimestamp < 100000000000 ? rawTimestamp * 1000 : rawTimestamp;
    const date = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : new Date();
    if (Number.isNaN(date.getTime())) return '今天';
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return '今天';
    return `${date.getMonth() + 1}月 ${date.getDate()}日`;
  }

  function renderProjects() {
    const root = $('projectsList');
    const empty = $('projectsEmpty');
    if (!root || !empty) return;
    const query = String($('projectsSearch')?.value || '').trim().toLowerCase();
    const projects = projectCatalog().filter((project) => {
      const name = String(project?.name || project?.title || '').trim().toLowerCase();
      return !query || name.includes(query);
    });
    root.replaceChildren();
    projects.forEach((project) => {
      const row = document.createElement('button');
      row.className = 'projects-row';
      row.type = 'button';
      row.dataset.projectId = String(project.id || '');
      row.dataset.projectName = String(project.name || project.title || '项目');
      row.dataset.projectCwd = String(project.cwd || project.path || '');
      row.dataset.projectWorkspaceId = String(project.workspaceId || '');
      row.innerHTML = '<span class="projects-row-icon"><img src="./icons/folder2.svg" alt=""></span><span class="projects-row-copy"><strong class="projects-row-title"></strong><small class="projects-row-date"></small></span>';
      row.querySelector('.projects-row-title').textContent = row.dataset.projectName;
      row.querySelector('.projects-row-date').textContent = projectDateLabel(project);
      row.querySelector('.projects-row-date').hidden = false;
      root.append(row);
    });
    empty.hidden = projects.length > 0;
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
    const chats = buildSessionRows(recent
      .filter((item) => String(item.projectId || '') === String(selected.id || ''))
      .filter((item) => !archived.has(String(item.id || ''))));
    text('projectTitle', selected.name, '项目');
    text('projectDevice', snapshot.device?.name || 'DSH Desktop', 'DSH Desktop');
    text('projectConnection', state.connected ? '已连接' : (state.connectionState === 'retrying' ? '正在重试' : '未连接'));
    const root = $('projectChats');
    root.replaceChildren();
    chats.filter(({ item, role }) => {
      const id = String(item.id || '');
      const title = state.renamedTitles[id] || item.title || '';
      const displayTitle = role.isSubagent ? subagentTitle(item, title) : title;
      return !query || String(title).toLowerCase().includes(query) || String(displayTitle).toLowerCase().includes(query);
    }).forEach((sessionRow) => {
      const { item, role } = sessionRow;
      const row = document.createElement('button');
      const id = String(item.id || '');
      row.className = `project-session-row${role.isSubagent ? ' subagent-row' : ''}${sessionRow.depth > 0 ? ' subagent-child-row' : ''}`;
      row.dataset.sessionId = id;
      row.dataset.sessionTitle = String(state.renamedTitles[id] || item.title || '未命名会话');
      row.dataset.projectId = String(selected.id || '');
      row.dataset.projectName = String(selected.name || 'DSH');
      row.style.setProperty('--session-depth', String(sessionRow.depth));
      const groupToggle = sessionGroupToggleMarkup(sessionRow);
      row.innerHTML = role.isSubagent
        ? `${groupToggle}<img class="subagent-icon" src="./icons/bot.svg" alt=""><span class="project-session-title"></span><span class="subagent-badge">子代理</span><span class="project-session-time"></span>`
        : `${groupToggle}<span class="project-session-title"></span><span class="project-session-time"></span>`;
      row.querySelector('.project-session-title').textContent = shortHomeTitle(role.isSubagent ? subagentTitle(item, row.dataset.sessionTitle) : row.dataset.sessionTitle);
      if (role.isSubagent) row.title = role.label ? `子代理：${role.label}` : '子代理';
      row.querySelector('.project-session-time').textContent = formatRecentTime(item.updatedAt);
      root.append(row);
    });
    text('projectEmpty', chats.length ? '没有更多线程' : (query ? '未找到相关会话' : '这个项目还没有可同步的会话'));
  }

  function setAppMode(mode) {
    document.body.classList.toggle('home-mode', mode === 'home');
    document.body.classList.toggle('projects-mode', mode === 'projects');
    document.body.classList.toggle('project-mode', mode === 'project');
    document.body.classList.toggle('dashboard-mode', mode === 'dashboard');
    document.body.classList.toggle('settings-mode', mode === 'settings');
  }

  function switchView(mode, { animate = true, direction } = {}) {
    const views = { home: $('homeView'), projects: $('projectsView'), project: $('projectView'), dashboard: $('dashboardView'), settings: $('settingsView') };
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
    closeProjectCreate();
    switchView('home', options);
    renderHome();
  }

  function showProjects(options) {
    closeChatMenu();
    setContextUsageOpen(false);
    closeNewChatPicker();
    closeProjectCreate();
    switchView('projects', options);
    renderProjects();
  }

  function openProjectCreate() {
    closeNewChatPicker();
    closeChatMenu();
    setContextUsageOpen(false);
    const layer = $('projectCreateLayer');
    const input = $('projectNameInput');
    if (!layer || !input) return;
    input.value = '';
    layer.hidden = false;
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  function closeProjectCreate() {
    const layer = $('projectCreateLayer');
    if (layer) layer.hidden = true;
  }

  function createProjectFromForm() {
    const input = $('projectNameInput');
    const name = String(input?.value || '').replace(/\s+/g, ' ').trim();
    if (!name) {
      input?.focus({ preventScroll: true });
      showToast('请输入项目名称');
      return;
    }
    const project = {
      id: `local-project-${Date.now()}`,
      name,
      cwd: '',
      workspaceId: '',
      createdAt: Date.now(),
      localOnly: true,
    };
    state.localProjects = [project, ...(Array.isArray(state.localProjects) ? state.localProjects : [])];
    writeLocal(PROJECTS_STORAGE_KEY, state.localProjects);
    closeProjectCreate();
    showProjects({ direction: true });
    showToast('项目已创建');
  }

  function showSettings(options) {
    if (embeddedRemote && window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'dsh-open-shell-settings' }, '*');
      return;
    }
    closeChatMenu();
    setContextUsageOpen(false);
    closeNewChatPicker();
    switchView('settings', options);
    renderSettings();
  }

  function showDashboard(options) {
    switchView('dashboard', options);
    renderSnapshot();
  }

  function showProject(options) {
    switchView('project', options);
    renderProject();
  }

  function renderSettings() {
    const snapshot = state.snapshot || {};
    const device = snapshot.device || snapshot.machine || {};
    const deviceName = device.name || snapshot.deviceName || 'MagicBook';
    text('settingsDesktopName', deviceName);
    text('settingsDesktopStatus', state.connected ? '已连接' : '未连接');
    text('settingsVersionNumber', 'v1.12.6');
    text('settingsVersionState', '已是最新版');
    text('settingsVersionNote', '当前已安装最新版本');
  }

  function openChat({ id, title, projectId = '', projectName = '', origin = 'home' } = {}) {
    state.selectedChat = { id: canonicalSessionId(String(id || '')), title: String(title || 'DSH Remote'), projectId: String(projectId || ''), projectName: String(projectName || 'DSH') };
    state.chatOrigin = origin;
    state.autoFollowChat = true;
    state.openingChatSessionId = state.selectedChat.id;
    clearFollowResume();
    showDashboard();
    if (!isSyntheticSessionId(state.selectedChat.id)) activateChatSession(state.selectedChat.id);
    // Even a warmed cache needs a current first page: it may have been
    // rendered while another conversation was on screen.  Snap immediately,
    // then refresh the newest page without discarding older cached pages.
    requestAnimationFrame(() => {
      renderChat();
      snapChatToLatest();
    });
    if (!isSyntheticSessionId(state.selectedChat.id)) requestSessionHistory(state.selectedChat.id, { limit: 120, refresh: true });
  }

  function renderNewChatProjects() {
    const root = $('newChatProjectList');
    if (!root) return;
    const projects = projectCatalog();
    root.replaceChildren();
    if (!projects.length) {
      const empty = document.createElement('div');
      empty.className = 'new-chat-project-empty';
      empty.textContent = '暂无可用历史项目';
      root.append(empty);
      return;
    }
    projects.slice(0, 30).forEach((project) => {
      const row = document.createElement('button');
      row.className = 'new-chat-project-row';
      row.type = 'button';
      row.dataset.projectId = String(project.id || '');
      row.dataset.projectName = String(project.name || project.title || '项目');
      row.dataset.projectCwd = String(project.cwd || project.path || '');
      row.dataset.projectWorkspaceId = String(project.workspaceId || '');
      const icon = document.createElement('img');
      icon.src = `./icons/${DSH_FOLDER_ICON}`;
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

  function startDraftChat(projectId, projectName, projectCwd = '', origin = 'home', workspaceId = '') {
    const id = String(projectId || '');
    const project = projectCatalog().find((item) => String(item?.id || '') === id) || {};
    const cwd = String(projectCwd || project.cwd || project.path || '').trim();
    if (!cwd) {
      showToast('无法定位此项目目录，暂不能新建对话');
      return false;
    }
    if (!transportOpen()) {
      showToast('请先连接 DSH 后再新建对话');
      return false;
    }
    // Opening a project is only a phone-side draft. DSH creates the real
    // session lazily when the user sends the first message, so selecting a
    // project cannot leave hidden blank sessions in the desktop history.
    state.creatingChatProject = {
      id,
      name: String(projectName || project.name || '新项目'),
      cwd,
      origin,
      // Empty for cwd-only projects (not registered workspaces); only a real
      // workspace id makes DSH attach the new conversation to that workspace.
      workspaceId: String(project.workspaceId || workspaceId || '').trim(),
    };
    closeNewChatPicker();
    openChat({
      id: `draft:${id}:${Date.now()}`,
      title: '新对话',
      projectId: id,
      projectName: state.creatingChatProject.name,
      origin,
    });
    showToast('已打开新对话，发送消息后才会同步到 DSH');
    return true;
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
      closeNewChatPicker();
      openProjectCreate();
    }
  }

  function liveChatItems() {
    const snapshot = state.snapshot || {};
    const sessionId = activeChatSessionId();
    const history = state.sessionHistory[sessionId];
    const items = [];
    const streamedReplies = new Map();
    const remoteBubbleCounts = new Map();
    const remoteSourceSeqs = new Set();
    const sessionEvents = eventsForSession(sessionId);
    const hasAssistantEvent = sessionEvents.some((event) => String(event.type || event.data?.type || '').toLowerCase() === 'assistant.message');
    const timeOf = (value, fallback) => {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      const parsed = Date.parse(String(value || ''));
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    let sequence = 0;
    if (Array.isArray(history?.items)) {
      history.items.forEach((item, index) => {
        const normalized = { ...normalizeChatHistoryItem(item), timestamp: timeOf(item.timestamp, index + 1), sequence: sequence++ };
        if (isInternalRuntimeContextItem(normalized)) return;
        items.push(normalized);
        if (normalized.kind === 'bubble') {
          const key = `${String(normalized.text || '')}|${Array.isArray(normalized.images) ? normalized.images.length : 0}`;
          remoteBubbleCounts.set(key, (remoteBubbleCounts.get(key) || 0) + 1);
        }
      });
    }
    const liveFloor = Number(history?.lastTimestamp || 0);
    const historyFloorSeq = Number(history?.lastSeq || history?.items?.reduce((max, item) => Math.max(max, Number(item.seq || 0)), 0) || 0);
    if (!history?.items?.length && snapshot.lastMessage && !hasAssistantEvent && (!sessionId || sessionId === String(snapshot.session?.id || ''))) {
      items.push({ kind: 'note', text: String(snapshot.lastMessage), timestamp: timeOf(snapshot.updatedAt, 0), sequence: sequence++ });
    }
    sessionEvents.forEach((event, index) => {
      const eventType = String(event.type || event.data?.type || '').trim();
      const resolvedSessionId = canonicalSessionId(eventSessionId(event, sessionId));
      // Live DSH packets carry no wall-clock time: the Bridge forwards only
      // the payload. An index-based fallback would order every streamed item
      // before the optimistic local bubble (timestamp = Date.now() at send),
      // putting the user's bubble below the reply in a freshly created
      // conversation until history loads. Arrival time shares the local
      // bubble's scale, so the bubble (created first) sorts above the reply.
      const timestamp = hasExplicitEventTimestamp(event)
        ? eventTimestamp(event, 0)
        : Date.now();
      const sourceSeq = Number(event.data?.sourceSeq || event.data?.seq || event.seq || 0);
      // History pages can contain the queued user message while the previous
      // assistant reply is still streaming.  Its timestamp is therefore later
      // than that live reply; filtering assistant packets by the history time
      // floor would blank the reply until DSH finishes.  Sequence de-duplication
      // below still removes packets that are already represented in history.
      const staleByTime = eventType !== 'assistant.message'
        && hasExplicitEventTimestamp(event) && liveFloor > 0 && timestamp <= liveFloor;
      // A queued follow-up is timestamped after the assistant's still-streaming
      // reply.  Never use the newest local bubble as a floor for assistant
      // events: that made the in-progress previous turn disappear as soon as
      // the user sent another message.
      if (resolvedSessionId !== sessionId || staleByTime) return;
      if (sourceSeq && (sourceSeq <= historyFloorSeq || remoteSourceSeqs.has(sourceSeq))) return;
      if (sourceSeq) remoteSourceSeqs.add(sourceSeq);
      const detail = eventDetail(event) || eventName(eventType);
      if (!detail) return;
      if (eventType === 'user.message') {
        const value = streamText(event) || detail;
        if (isInternalRuntimeContextText(value)) return;
        if (value) {
          const key = `${String(value)}|0`;
          remoteBubbleCounts.set(key, (remoteBubbleCounts.get(key) || 0) + 1);
          items.push({ kind: 'bubble', text: value, id: event.id || `live:${resolvedSessionId}:user:${timestamp}:${index}`, timestamp, sequence: sequence++ });
        }
        return;
      }
      if (eventType === 'assistant.message') {
        // Bridge may deliver a full cumulative message or a one-token delta.
        // Render one stable note and update its text instead of adding a new
        // message for every packet. Inline images (data URLs) ride on the same
        // note so a desktop DSH reply keeps its pictures on the phone.
        const replyKey = String(event.data?.messageId || event.data?.replyId || event.data?.id || `${resolvedSessionId}:assistant`);
        const previous = streamedReplies.get(replyKey);
        const merged = mergeStreamText(previous?.text || '', streamText(event) || detail, event);
        const images = Array.isArray(event.data?.images) ? event.data.images : [];
        if (previous) {
          previous.text = merged;
          previous.timestamp = timestamp;
          if (images.length) previous.images = images;
        } else {
          const item = { kind: 'note', text: merged, id: `live:${resolvedSessionId}:assistant:${replyKey}`, timestamp, sequence: sequence++ };
          if (images.length) item.images = images;
          streamedReplies.set(replyKey, item);
          items.push(item);
        }
        return;
      }
      const eventId = event.id || event.data?.id || `live:${resolvedSessionId}:${timestamp}:${index}`;
      if (eventType === 'approval.required') {
        const approvalData = event.data || {};
        items.push({
          kind: 'approval',
          requestId: String(approvalData.requestId || approvalData.id || ''),
          tool: String(approvalData.tool || approvalData.title || ''),
          detail: String(approvalData.detail || approvalData.reason || ''),
          sessionId: resolvedSessionId,
          id: eventId,
          timestamp,
          sequence: sequence++,
        });
        return;
      }
      if (thinkingEventType(eventType)) {
        items.push({ kind: 'thinking', title: 'Think', icon: 'chat-think.png', text: detail, id: eventId, timestamp, sequence: sequence++ });
        return;
      }
      items.push({ kind: 'event', icon: chatEventIcon({ ...event, type: eventType }), text: detail, id: eventId, timestamp, sequence: sequence++ });
    });
    state.chatLocalItems.forEach((item, index) => {
      if (canonicalSessionId(String(item.sessionId || '')) !== sessionId) return;
      const key = `${String(item.text || '')}|${Array.isArray(item.images) ? item.images.length : 0}`;
      const remoteCount = remoteBubbleCounts.get(key) || 0;
      if (remoteCount > 0) {
        remoteBubbleCounts.set(key, remoteCount - 1);
        return;
      }
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
      if (item.deliveryState && item.deliveryState !== 'accepted') {
        bubble.dataset.deliveryState = String(item.deliveryState);
        const status = document.createElement('span');
        status.className = 'chat-message-status';
        status.textContent = item.deliveryState === 'failed' ? '发送失败'
          : item.deliveryState === 'processing' ? '处理中'
            : item.deliveryState === 'paused' ? '已暂停'
              : '排队中';
        bubble.append(status);
      }
      return bubble;
    }
    if (item.kind === 'note') {
      const note = document.createElement('div');
      note.className = 'chat-note';
      note.textContent = item.text;
      const images = Array.isArray(item.images) ? item.images : [];
      if (images.length) {
        const gallery = document.createElement('div');
        gallery.className = 'chat-message-images';
        images.forEach((image) => {
          const source = typeof image === 'string' ? image : String(image?.dataUrl || image?.src || '');
          if (!source.startsWith('data:image/')) return;
          const img = document.createElement('img');
          img.src = source;
          img.alt = 'DSH 图片';
          img.loading = 'lazy';
          gallery.append(img);
        });
        if (gallery.children.length) note.append(gallery);
      }
      return note;
    }
    if (item.kind === 'thinking') {
      const identity = String(item.id || `thinking:${item.timestamp || ''}:${item.sequence || ''}`);
      const card = document.createElement('section');
      const expanded = Boolean(state.expandedThinkingIds[identity]);
      card.className = `chat-thinking-card${expanded ? ' is-expanded' : ''}`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'chat-thinking-toggle';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-label', expanded ? '收起思考内容' : '展开思考内容');
      toggle.innerHTML = `<img class="chat-thinking-icon" src="./icons/${item.icon || 'chat-think.png'}" alt=""><span class="chat-thinking-title">${item.title || 'Think'}</span><span class="chat-thinking-chevron" aria-hidden="true">⌄</span>`;
      const body = document.createElement('div');
      body.className = 'chat-thinking-content';
      body.textContent = String(item.text || '思考中');
      toggle.addEventListener('click', () => {
        const next = !card.classList.contains('is-expanded');
        state.expandedThinkingIds[identity] = next;
        card.classList.toggle('is-expanded', next);
        toggle.setAttribute('aria-expanded', String(next));
        toggle.setAttribute('aria-label', next ? '收起思考内容' : '展开思考内容');
      });
      card.append(toggle, body);
      return card;
    }
    if (item.kind === 'approval') {
      const card = document.createElement('section');
      card.className = 'chat-approval-card';
      const requestId = String(item.requestId || '');
      const tool = String(item.tool || '');
      const detail = String(item.detail || '');
      const heading = document.createElement('div');
      heading.className = 'chat-approval-heading';
      heading.innerHTML = `<img class="chat-approval-icon" src="./icons/tools-icons8.png" alt=""><span class="chat-approval-title">请求执行工具</span>`;
      const desc = document.createElement('div');
      desc.className = 'chat-approval-desc';
      desc.textContent = tool || detail || 'DSH 请求执行一个操作';
      const buttons = document.createElement('div');
      buttons.className = 'chat-approval-actions';
      const allow = document.createElement('button');
      allow.type = 'button';
      allow.className = 'chat-approval-btn allow';
      allow.textContent = '允许';
      const deny = document.createElement('button');
      deny.type = 'button';
      deny.className = 'chat-approval-btn deny';
      deny.textContent = '拒绝';
      allow.addEventListener('click', () => approveResolution(requestId, true, String(item.sessionId || '')));
      deny.addEventListener('click', () => approveResolution(requestId, false, String(item.sessionId || '')));
      buttons.append(deny, allow);
      card.append(heading, desc, buttons);
      return card;
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
    const historyLoading = $('chatHistoryLoading');
    const activeHistory = state.sessionHistory[sessionId];
    if (historyLoading) historyLoading.hidden = !Boolean(activeHistory?.loadingOlder);
    updateScrollBottomButton();
    const items = liveChatItems();
    const keys = items.map(itemKey);
    const previous = state.renderedChat;
    const sameSession = previous.sessionId === sessionId;
    const scroller = $('chatScroll');
    if (sameSession && previous.keys.length === keys.length && samePrefix(keys, previous.keys)) return;
    const identityKeys = items.map((item, index) => `${itemIdentityKey(item, index)}:${item.kind || ''}`);
    const previousIdentityKeys = Array.isArray(previous.identityKeys) ? previous.identityKeys : [];
    // Streaming replies change their text on every packet. Keep the existing
    // DOM for those stable items and replace only the changed node, otherwise
    // the whole transcript flashes and loses the scroll momentum.
    if (sameSession && previousIdentityKeys.length === identityKeys.length
      && identityKeys.every((value, index) => value === previousIdentityKeys[index])) {
      let changed = false;
      [...root.children].forEach((element, index) => {
        if (keys[index] === previous.keys[index]) return;
        const next = chatItemElement(items[index]);
        next.classList.add('chat-item-update');
        element.replaceWith(next);
        changed = true;
      });
      state.renderedChat = { sessionId, keys, identityKeys };
      if (changed) followChatProgress();
      return;
    }
    if (sameSession && previous.keys.length && samePrefix(keys, previous.keys)) {
      const fragment = document.createDocumentFragment();
      items.slice(previous.keys.length).forEach((item) => {
        const element = chatItemElement(item);
        element.classList.add('chat-item-enter');
        fragment.append(element);
      });
      root.append(fragment);
      state.renderedChat = { sessionId, keys, identityKeys };
      followChatProgress();
      return;
    }
    if (sameSession && previous.keys.length && sameSuffix(keys, previous.keys)) {
      const priorHeight = root.scrollHeight;
      const fragment = document.createDocumentFragment();
      items.slice(0, keys.length - previous.keys.length).forEach((item) => {
        const element = chatItemElement(item);
        element.classList.add('chat-history-enter');
        fragment.append(element);
      });
      root.prepend(fragment);
      state.renderedChat = { sessionId, keys, identityKeys };
      if (scroller && !state.autoFollowChat) scroller.scrollTop += root.scrollHeight - priorHeight;
      else followChatProgress('auto');
      return;
    }
    root.replaceChildren(...items.map(chatItemElement));
    state.renderedChat = { sessionId, keys, identityKeys };
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
      sessionId: currentSessionId() || state.snapshot.session?.id || null,
      projectId: state.snapshot.project?.id || null,
      data,
    };
    try { liveSocket.send(JSON.stringify(message)); return true; }
    catch (_) { return false; }
  }

  function openLiveSocket(endpoint, token) {
    liveSocketManualClose = false;
    clearTimeout(liveReconnectTimer);
    liveReconnectTimer = null;
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
      liveReconnectAttempt = 0;
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
      if (!liveSocketManualClose) {
        const delay = Math.min(30000, Math.max(1000, 1000 * (2 ** Math.min(liveReconnectAttempt++, 5))));
        $('settingsStatus').textContent = `连接失败，${Math.ceil(delay / 1000)} 秒后重试…`;
        liveReconnectTimer = setTimeout(() => {
          liveReconnectTimer = null;
          openLiveSocket(endpoint, token);
        }, delay);
      }
    };
  }

  function updateConnectionDot(element, connectionState) {
    if (!element) return;
    element.classList.toggle('online', connectionState === 'online');
    element.classList.toggle('retrying', connectionState === 'retrying');
    element.classList.toggle('offline', connectionState === 'offline');
    element.setAttribute('aria-label', connectionState === 'online' ? '已连接' : connectionState === 'retrying' ? '正在重试' : '未连接');
  }

  function renderConnection() {
    const online = state.connected;
    const connectionState = online ? 'online' : (state.connectionState || 'retrying');
    $('drawerDot')?.classList.toggle('online', online);
    if ($('drawerState')) $('drawerState').textContent = online ? '已连接' : '未连接';
    updateConnectionDot($('homeDeviceDot'), connectionState);
    const deviceDot = $('chatDeviceDot');
    updateConnectionDot(deviceDot, connectionState);
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
    const activeSessionId = activeChatSessionId();
    const raw = state.sessionContextUsage[activeSessionId]
      || snapshot.usage || snapshot.contextUsage || snapshot.tokenUsage || {};
    const context = raw.context || snapshot.context || {};
    const breakdown = raw.breakdown || raw.categories || raw.contextBreakdown || snapshot.contextBreakdown || {};
    const pressure = raw.contextPressure || snapshot.contextPressure || {};
    const used = firstUsageValue(raw.contextUsed, raw.used, context.used, pressure.pressureTokens, pressure.projectedTokens, snapshot.contextUsed);
    const limit = firstUsageValue(raw.contextLimit, raw.limit, context.limit, pressure.contextWindow, snapshot.contextLimit);
    const derivedPercent = used !== null && limit > 0 ? used / limit * 100 : null;
    const percent = firstUsageValue(raw.percent, context.percent, raw.contextPercent, derivedPercent);
    const systemPrompt = firstUsageValue(raw.systemPrompt, raw.system, context.systemPrompt, breakdown.systemPrompt, breakdown.systemTokens);
    const tools = firstUsageValue(raw.tools, raw.tool, context.tools, breakdown.tools, breakdown.toolsTokens);
    const messages = firstUsageValue(raw.messages, raw.chatMessages, context.messages, breakdown.messages, breakdown.messageTokens);
    const provider = typeof snapshot.provider === 'object' && snapshot.provider !== null ? snapshot.provider : {};
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
    // 相册入口本身不能被模型目录状态禁用：目录接口可能暂时没有返回，
    // 但 WebView 仍然应该允许用户选择图片，随后把附件交给 DSH 判断。
    const enabled = true;
    row.classList.remove('is-disabled');
    row.setAttribute('aria-disabled', 'false');
    const label = row.querySelector('span');
    if (label) label.textContent = '上传照片';
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

  function updateScrollIndicator(scroller, indicator, thumb) {
    if (!scroller || !indicator || !thumb) return;
    const scrollable = scroller.scrollHeight - scroller.clientHeight;
    if (scrollable <= 1 || scroller.clientHeight <= 0) {
      indicator.classList.remove('is-visible');
      return;
    }
    const trackHeight = indicator.clientHeight;
    const thumbHeight = Math.max(18, Math.round(trackHeight * scroller.clientHeight / scroller.scrollHeight));
    const travel = Math.max(0, trackHeight - thumbHeight);
    const offset = travel * Math.min(1, Math.max(0, scroller.scrollTop / scrollable));
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${offset}px)`;
    indicator.classList.add('is-visible');
  }

  function updateScrollIndicators() {
    updateScrollIndicator($('chatCommandScroll'), $('chatCommandScrollbar'), $('chatCommandScrollbarThumb'));
    updateScrollIndicator($('chatSelectorOptions'), $('chatSelectorScrollbar'), $('chatSelectorScrollbarThumb'));
  }

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
    requestAnimationFrame(updateScrollIndicators);
  }

  function closeSelector() {
    const input = $('promptInput');
    const keepComposerFocus = document.activeElement === input || Date.now() < state.composerFocusGuardUntil;
    state.selectorKind = '';
    $('chatSelectorLayer').hidden = true;
    renderComposerOptions();
    syncComposerState();
    if (keepComposerFocus) preserveFocusedComposer(true);
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
      if (state.connected || liveSocketOpen()) control('selectModel', state.selectedModel.provider, state.selectedModel.model, state.selectedModel.reasoningEffort);
      return;
    }
    state.selectedEffort = String(payload.value || '');
    state.selectedModel = { ...currentModelSelection(), reasoningEffort: state.selectedEffort };
    state.modelSelectionTouched = true;
    closeSelector();
    playComposerFeedback('modelButton');
    preserveFocusedComposer();
    showToast(`已选择智力：${effortDisplayName(state.selectedEffort)}`);
    if (state.connected || liveSocketOpen()) control('selectModel', state.selectedModel.provider, state.selectedModel.model, state.selectedModel.reasoningEffort);
  }

  function playComposerFeedback(id) {
    const target = $(id);
    if (!target) return;
    try { navigator.vibrate?.(7); } catch (_) { /* vibration is optional */ }
    target.classList.remove('chat-composer-control-feedback');
    void target.offsetWidth;
    target.classList.add('chat-composer-control-feedback');
    window.setTimeout(() => target.classList.remove('chat-composer-control-feedback'), 380);
  }

  function preserveFocusedComposer(force = false) {
    const input = $('promptInput');
    if (!input || (!force && document.activeElement !== input)) return;
    if (force) state.composerFocusGuardUntil = Date.now() + 900;
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
    requestAnimationFrame(syncComposerViewport);
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
    if (!$('projectsView')?.hidden) renderProjects();
    if (!$('settingsView')?.hidden) renderSettings();
    if (!$('projectView').hidden) renderProject();
    if (!$('dashboardView').hidden) renderChat();
  }

  function renderEvents() {
    if (!$('dashboardView').hidden) renderChat();
  }

  let renderFramePending = false;
  function queueRender() {
    if (renderFramePending) return;
    renderFramePending = true;
    const flush = () => {
      renderFramePending = false;
      renderSnapshot();
      renderEvents();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  function handleMessage(raw) {
    const message = safeJson(raw, {});
    if (!message || typeof message !== 'object') return;
    const type = message.type || '';
    const nativeMessage = message.source === 'native';
    if (nativeMessage && !native && liveSocketOpen() && type !== 'status') return;
    if (type === 'open-session') {
      const data = message.data || {};
      const id = canonicalSessionId(String(data.id || data.sessionId || ''));
      if (id) {
        openChat({
          id,
          title: String(data.title || 'DSH Remote'),
          projectId: String(data.projectId || ''),
          projectName: String(data.projectName || 'DSH'),
          origin: 'notification',
        });
      }
      return;
    }
    if (type === 'status') {
      const status = message.data?.status || 'disconnected';
      announceUpdateState(status, message.data || {});
      if (nativeMessage && !native && liveSocketOpen() && ['connecting', 'connected', 'disconnected', 'offline'].includes(status)) return;
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
      if (status === 'connected') {
        showToast('已连接 DSH');
        if (nativeMessage && native) {
          native.requestSnapshot?.();
          setTimeout(warmRecentHistories, 80);
        }
      }
      if (status === 'disconnected') {
        const reason = message.data?.message || '无法连接 Bridge';
        $('settingsStatus').textContent = `连接失败：${reason}`;
        showToast(`连接失败：${reason}`);
      }
      if (status === 'connecting') $('settingsStatus').textContent = '正在连接 Bridge……';
      if (status.startsWith('update-')) clearTimeout(updateTimer);
      if (status === 'update-checking') {
        updateMode = 'check';
        setSettingsUpdateIcon('check', true);
        armUpdateTimeout('check');
        $('updateButton').textContent = '检查更新';
        $('settingsStatus').textContent = '正在检查更新……';
      }
      if (status === 'update-current') {
        updateMode = 'check';
        setSettingsUpdateIcon('check', false);
        $('updateButton').textContent = '检查更新';
        $('settingsStatus').textContent = message.data?.message || '已是最新版';
        showToast(message.data?.message || '已是最新版');
      }
      if (status === 'update-available') {
        updateMode = 'download';
        setSettingsUpdateIcon('download', false);
        $('updateButton').textContent = `下载 ${message.data?.latestVersion || '新版本'}`;
        $('settingsStatus').textContent = message.data?.message || '发现新版本，可以下载安装。';
        showToast(message.data?.message || '发现新版本');
      }
      if (status === 'update-started') {
        updateMode = 'check';
        setSettingsUpdateIcon('download', true);
        armUpdateTimeout('download');
        $('updateButton').textContent = '检查更新';
        $('settingsStatus').textContent = '正在从电脑下载更新……';
        showToast('正在下载更新');
      }
      if (status === 'update-progress') {
        updateMode = 'check';
        setSettingsUpdateIcon('download', true);
        armUpdateTimeout('download');
        $('updateButton').textContent = '下载中…';
        $('settingsStatus').textContent = message.data?.message || '正在从电脑下载更新……';
      }
      if (status === 'update-downloaded') {
        updateMode = 'check';
        setSettingsUpdateIcon('check', false);
        $('updateButton').textContent = '检查更新';
        $('settingsStatus').textContent = '更新包已下载，正在打开安装确认。';
        showToast('请在系统窗口确认安装');
      }
      if (status === 'update-error') {
        updateMode = 'check';
        setSettingsUpdateIcon('check', false);
        $('updateButton').textContent = '重新检查';
        $('settingsStatus').textContent = `更新失败：${message.data?.message || '无法下载更新'}`;
        showToast(`更新失败：${message.data?.message || '无法下载更新'}`);
      }
    } else if (type === 'session.history') {
      const data = message.data || {};
      const rawSessionId = String(data.sessionId || '');
      // A history response can belong to any recent conversation because we
      // warm them in the background. It must never be treated as proof that
      // the *current* DSH session changed: doing so aliases/merges the active
      // session with the warmed one and makes two conversations appear mixed.
      // Only session.snapshot is allowed to reconcile a synthetic/current id.
      const sessionId = canonicalSessionId(rawSessionId);
      if (sessionId) {
        const history = state.sessionHistory[sessionId] || { items: [], hasMore: true, nextBefore: null, loading: false, loadingOlder: false, loadingTimer: null, lastTimestamp: 0 };
        const existing = new Map(history.items.map((item, index) => [itemIdentityKey(item, index), item]));
        (Array.isArray(data.items) ? data.items : []).forEach((item, index) => existing.set(itemIdentityKey(item, index), item));
        history.items = [...existing.values()].sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0) || Number(left.timestamp || 0) - Number(right.timestamp || 0));
        history.hasMore = Boolean(data.hasMore);
        history.nextBefore = data.nextBefore === null || data.nextBefore === undefined ? null : Number(data.nextBefore);
        history.lastSeq = Math.max(
          Number(history.lastSeq || 0),
          Number(data.lastSeq || 0),
          ...(history.items.map((item) => Number(item.seq || 0))),
        );
        clearTimeout(history.loadingTimer);
        history.loadingTimer = null;
        history.loading = false;
        history.loadingOlder = false;
        history.lastTimestamp = history.items.reduce((latest, item) => Math.max(latest, Number(item.timestamp || 0)), 0);
        state.sessionHistory[sessionId] = history;
        if (state.openingChatSessionId === sessionId) {
          // The first history page is always the newest page.  Jump straight
          // to its bottom after the DOM exists, so opening any conversation
          // never leaves the user stranded in the middle of its transcript.
          state.openingChatSessionId = '';
          state.autoFollowChat = true;
          requestAnimationFrame(() => {
            renderChat();
            snapChatToLatest();
          });
        }
        if (state.historyWarmSessionId === sessionId) {
          state.historyWarmInFlight = false;
          state.historyWarmSessionId = '';
          warmRecentHistories();
        }
      }
    } else if (type === 'session.snapshot') {
      const incomingSnapshot = message.data || {};
      const previousSnapshotId = String(state.snapshot?.session?.id || '');
      const incomingSessionId = String(incomingSnapshot.session?.id || '');
      if (incomingSessionId) reconcileCurrentSession(incomingSessionId, previousSnapshotId);
      state.snapshot = incomingSnapshot;
      const snapshotState = String(state.snapshot.state || '').toLowerCase();
      const snapshotPhase = String(state.snapshot.phase || '').toLowerCase();
      state.connected = native ? Boolean(native.isConnected?.()) : state.connected;
      state.replying = snapshotState === 'waiting' || (snapshotState === 'running' && !['completed', 'failed', 'idle'].includes(snapshotPhase));
      const snapshotSessionId = canonicalSessionId(incomingSessionId || state.snapshot?.session?.id || '');
      const pending = [...state.chatLocalItems].reverse().find((item) => {
        if (item.kind !== 'bubble' || !item.deliveryState || item.deliveryState === 'accepted') return false;
        return !snapshotSessionId || canonicalSessionId(item.sessionId) === snapshotSessionId;
      });
      if (pending) {
        if (snapshotState === 'failed') pending.deliveryState = 'failed';
        else if (snapshotState === 'running') pending.deliveryState = 'processing';
        else if (snapshotState === 'waiting') pending.deliveryState = 'queued';
        // When DSH finishes replying (completed / idle), the message is no longer
        // pending: clear the status label so it stops showing "排队中/处理中".
        else if (snapshotState === 'completed' || snapshotState === 'idle') pending.deliveryState = '';
      }
      if (incomingSessionId && state.selectedChat && canonicalSessionId(state.selectedChat.id) === canonicalSessionId(incomingSessionId)) {
        state.selectedChat.id = canonicalSessionId(incomingSessionId);
      }
      if (incomingSessionId && (incomingSnapshot.contextUsage || incomingSnapshot.usage)) {
        state.sessionContextUsage[canonicalSessionId(incomingSessionId)] = incomingSnapshot.contextUsage || incomingSnapshot.usage;
      }
      warmRecentHistories();
    } else if (type === 'file-picked') {
      const picked = message.data || {};
      if (picked.error) {
        showToast('图片添加失败，请换一张试试');
      } else if (picked.dataUrl) {
        state.pendingImages = state.pendingImages || [];
        const comma = String(picked.dataUrl || '').indexOf(',');
        const header = String(picked.dataUrl || '').slice(0, comma);
        const mime = (header.match(/^data:([^;]+)/) || [])[1] || 'image/jpeg';
        state.pendingImages.push({
          name: picked.name || 'photo',
          mimeType: mime,
          mediaType: mime,
          data: (comma >= 0 ? String(picked.dataUrl).slice(comma + 1) : String(picked.dataUrl || '')),
          dataUrl: String(picked.dataUrl || ''),
        });
        renderPendingImages();
        showToast('已添加图片，发送时会一并传给 DSH');
      }
    } else if (type === 'session.created') {
      const created = message.data || {};
      const sessionId = canonicalSessionId(String(created.sessionId || ''));
      const creating = state.creatingChatProject;
      const pending = state.pendingDraftPrompt;
      state.creatingChatProject = null;
      state.pendingDraftPrompt = null;
      if (!sessionId) {
        showToast('新建对话失败：DSH 未返回会话 ID');
        return;
      }
      // Only enter the chat after DSH confirms its real session id.  Keep
      // local bubbles from every other conversation: creating a new session
      // must not erase an in-flight or queued turn in the chat the user was
      // reading.
      state.renderedChat = { sessionId: '', keys: [] };
      openChat({
        id: sessionId,
        title: String(created.title || '新对话'),
        projectId: String(created.projectId || creating?.id || ''),
        projectName: String(created.projectName || creating?.name || '项目'),
        origin: creating?.origin || 'home',
      });
      if (pending) {
        $('promptInput').value = pending.text;
        state.pendingImages = pending.images || [];
        renderPendingImages();
        sendPrompt();
      } else {
        showToast('已在当前项目新建对话');
      }
    } else if (type === 'session.context') {
      const data = message.data || {};
      const sessionId = canonicalSessionId(String(data.sessionId || ''));
      if (sessionId && data.usage) state.sessionContextUsage[sessionId] = data.usage;
    } else if (type === 'control.result') {
      const result = message.data || {};
      const resultSessionId = canonicalSessionId(String(result.sessionId || state.snapshot?.session?.id || ''));
      const resultState = String(result.state || result.status || result.phase || (result.type === 'prompt.send' && result.ok !== false ? 'queued' : '')).toLowerCase();
      const isQueueState = /queue|queued|wait|pending|排队|等待/.test(resultState);
      const isProcessingState = /run|start|process|think|tool|terminal|执行|思考|工具|命令/.test(resultState);
      const pending = [...state.chatLocalItems].reverse().find((item) => {
        if (item.kind !== 'bubble' || !item.deliveryState || item.deliveryState === 'accepted') return false;
        return !resultSessionId || canonicalSessionId(item.sessionId) === resultSessionId;
      });
      if (pending) {
        if (result.ok === false) pending.deliveryState = 'failed';
        else if (isProcessingState && !isQueueState) pending.deliveryState = 'processing';
        else pending.deliveryState = 'queued';
      }
      if (result.ok === false) showToast(result.error || '控制失败');
      else if (isProcessingState && !isQueueState) showToast('DSH 已开始处理');
      else showToast('已交给 DSH，正在排队');
    } else if (type === 'error') {
      showToast(message.data?.message || 'Bridge 返回错误');
    } else if (type) {
      if (['session.started', 'agent.thinking', 'tool.started', 'tool.completed', 'terminal.started', 'terminal.output', 'progress.updated', 'file.changed', 'approval.required', 'approval.resolved', 'assistant.message', 'user.message', 'session.completed', 'session.failed', 'session.paused'].includes(type)) {
        state.replying = true;
        const eventSession = canonicalSessionId(eventSessionId(message, activeChatSessionId() || state.snapshot?.session?.id));
        rememberSessionEvent(message, eventSession);
        const pending = [...state.chatLocalItems].reverse().find((item) => item.kind === 'bubble' && item.deliveryState && item.deliveryState !== 'accepted' && canonicalSessionId(item.sessionId) === eventSession);
        if (pending) {
          if (type === 'user.message' || type === 'session.completed') pending.deliveryState = 'accepted';
          else if (type === 'session.failed') pending.deliveryState = 'failed';
          else if (type === 'session.paused') pending.deliveryState = 'paused';
          else pending.deliveryState = 'processing';
        }
      }
      if (type === 'session.completed' || type === 'session.failed') state.replying = false;
      state.events.push(message);
      if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
      state.lastEventAt = Date.now();
      // Rendering is coalesced below so a burst of streamed events never
      // blocks the WebView main thread with one full layout per packet.
    }
    queueRender();
  }
  window.DshRemote = {
    onNativeMessage: handleMessage,
    onNativeMessages: (messages) => {
      if (!Array.isArray(messages)) return;
      messages.forEach(handleMessage);
    },
  };

  // The DeepSeek shell keeps one embedded Remote page and routes its two
  // navigation entries through postMessage. Keep the embedded page in sync
  // without introducing a second navigation layer.
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const route = String(event.data?.route || '');
    if (event.data?.type !== 'dsh-shell-route') return;
    if (route === 'projects') showProjects({ animate: false });
    else showHome({ animate: false });
  });

  function openSettings() {
    $('endpointInput').value = settings.endpoint || '';
    $('tokenInput').value = settings.token || '';
    $('settingsStatus').textContent = '';
    $('settingsModal').hidden = false;
  }
  function closeSettings() { $('settingsModal').hidden = true; }
  function currentSessionId() {
    return activeChatSessionId();
  }
  // Resolve a DSH tool-approval from the phone. Uses the approval event's own
  // sessionId (never the active chat's) so an approval from another session is
  // routed back correctly. Mirrors the control() resolveApproval mapping but
  // carries the session explicitly.
  function approveResolution(requestId, allow, sessionId) {
    const normalized = String(sessionId || currentSessionId() || '');
    if (native && typeof native.resolveApproval === 'function') {
      native.resolveApproval(Boolean(allow), String(requestId || ''), normalized);
      return;
    }
    const type = allow ? 'approval.allow' : 'approval.deny';
    const payload = { version: 1, type, timestamp: Date.now(), sessionId: normalized || null, projectId: state.snapshot?.project?.id || null, data: { requestId: String(requestId || '') } };
    if (sendLiveMessage(type, payload.data)) return;
    showToast('当前环境无法回传审批');
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
      requestSessionContext(activeChatSessionId());
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
    requestAnimationFrame(refreshCommandMarquees);
  }
  function closeAttachmentMenu() {
    const layer = $('chatAttachmentLayer');
    if (!layer) return;
    const input = $('promptInput');
    const keepComposerFocus = document.activeElement === input || Date.now() < state.composerFocusGuardUntil;
    layer.hidden = true;
    if (keepComposerFocus) {
      preserveFocusedComposer(true);
    } else if (!input?.value && !state.selectorKind && document.activeElement !== input) {
      state.composerExpanded = false;
      syncComposerState();
    }
  }
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
    updateScrollIndicators();
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
    else openLiveSocket(endpoint, token);
    closeSettings();
  }
  function disconnect() {
    liveSocketManualClose = true;
    clearTimeout(liveReconnectTimer);
    liveReconnectTimer = null;
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
      selectModel: ['session.selectModel', (() => ({ provider: String(args[0] || ''), model: String(args[1] || ''), reasoningEffort: String(args[2] || '') }))()],
    }[method];
    if (native) {
      if (method === 'sendPrompt' && typeof native.sendPrompt === 'function') {
        const attachments = liveControl?.[1]?.attachments || [];
        native.sendPrompt(String(args[0] || ''), JSON.stringify(attachments), currentSessionId());
        return true;
      }
      if (method === 'requestSnapshot' && typeof native.requestSnapshot === 'function') {
        native.requestSnapshot();
        return true;
      }
      if (method === 'stopTask' && typeof native.stopTask === 'function') {
        native.stopTask(currentSessionId());
        return true;
      }
      if (method === 'continueTask' && typeof native.continueTask === 'function') {
        native.continueTask(currentSessionId());
        return true;
      }
      if (method === 'resolveApproval' && typeof native.resolveApproval === 'function') {
        native.resolveApproval(Boolean(args[0]), String(args[1] || ''), currentSessionId());
        return true;
      }
      if (typeof native[method] === 'function') {
        native[method](...args);
        return true;
      }
    }
    if (liveControl) return Boolean(sendLiveMessage(liveControl[0], liveControl[1]));
    if (method === 'requestSnapshot') return Boolean(sendLiveMessage('session.snapshot.request', {}, true));
    if (!native) showToast('当前环境没有 Android 远程服务');
    return false;
  }

  $('closeDrawer').onclick = () => { $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); $('drawerScrim').hidden = true; };
  $('drawerScrim').onclick = $('closeDrawer').onclick;
  $('drawerProjects').onclick = () => { $('closeDrawer').click(); showProjects(); };
  $('drawerRemote').onclick = () => { $('closeDrawer').click(); showHome(); };
  $('settingsButton').onclick = openChatMenu;
  $('contextUsageButton').onclick = () => setContextUsageOpen(true);
  $('homeMoreButton').onclick = showSettings;
  $('homeBackButton').onclick = () => {
    if (embeddedRemote && window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'dsh-shell-back' }, '*');
      return;
    }
    showToast('当前已经是首页');
  };
  $('projectsBackButton').onclick = () => showHome({ direction: false });
  $('projectsAddButton').onclick = openProjectCreate;
  // A project opened from Remote's home list returns to that same Remote
  // surface. The dedicated project catalog keeps its own back destination.
  $('projectBackButton').onclick = () => {
    if (state.projectOrigin === 'projects') showProjects({ direction: false });
    else showHome({ direction: false });
  };
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
    startDraftChat(row.dataset.projectId, row.dataset.projectName, row.dataset.projectCwd, 'home', row.dataset.projectWorkspaceId || '');
  };
  $('homeSearch').addEventListener('input', renderHome);
  $('homeSearch').addEventListener('focus', (event) => keepSearchVisible(event.currentTarget));
  $('projectsSearch').addEventListener('input', renderProjects);
  $('projectsSearch').addEventListener('focus', (event) => keepSearchVisible(event.currentTarget));
  $('homeProjects').onclick = (event) => {
    const row = event.target.closest('.project-row');
    if (!row) return;
    state.selectedProject = {
      id: String(row.dataset.projectId || ''),
      name: String(row.dataset.projectName || '项目'),
      cwd: String(row.dataset.projectCwd || ''),
      workspaceId: String(row.dataset.projectWorkspaceId || ''),
    };
    state.projectOrigin = 'home';
    showProject();
  };
  $('projectsList').onclick = (event) => {
    const row = event.target.closest('.projects-row');
    if (!row) return;
    state.selectedProject = {
      id: String(row.dataset.projectId || ''),
      name: String(row.dataset.projectName || '项目'),
      cwd: String(row.dataset.projectCwd || ''),
      workspaceId: String(row.dataset.projectWorkspaceId || ''),
    };
    state.projectOrigin = 'projects';
    showProject();
  };
  $('projectCreateScrim').onclick = closeProjectCreate;
  $('projectCreateCancel').onclick = closeProjectCreate;
  $('projectCreateConfirm').onclick = createProjectFromForm;
  $('projectNameInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createProjectFromForm();
    } else if (event.key === 'Escape') {
      closeProjectCreate();
    }
  });
  $('projectSearch').addEventListener('input', renderProject);
  $('projectSearch').addEventListener('focus', (event) => keepSearchVisible(event.currentTarget));
  $('projectChats').onclick = (event) => {
    const groupToggle = event.target.closest('[data-toggle-subagents]');
    if (groupToggle) {
      event.preventDefault();
      event.stopPropagation();
      toggleSessionGroup(groupToggle.dataset.groupId);
      return;
    }
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
    const project = state.selectedProject || {};
    startDraftChat(project.id, project.name, project.cwd, 'project', project.workspaceId || '');
  };
  $('settingsBackButton').onclick = () => showHome({ direction: false });
  $('settingsMoreButton').onclick = openSettings;
  $('settingsCheckUpdateButton').onclick = () => $('updateButton')?.click();
  $('drawerSettings').onclick = openSettings;
  $('drawerRefresh').onclick = () => { control('requestSnapshot'); showToast('正在刷新状态'); };
  $('closeSettings').onclick = closeSettings;
  $('chatMenuScrim').onclick = closeChatMenu;
  $('contextUsageScrim').onclick = () => setContextUsageOpen(false);
  $('chatAttachmentScrim').onclick = closeAttachmentMenu;
  $('chatSelectorScrim').onclick = closeSelector;
  ['chatAttachmentScrim', 'chatSelectorScrim', 'contextUsageScrim'].forEach((id) => {
    $(id)?.addEventListener('pointerdown', (event) => {
      if (document.activeElement === $('promptInput')) {
        event.preventDefault();
        state.composerFocusGuardUntil = Date.now() + 900;
      }
    });
  });
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
      if (document.activeElement === $('promptInput')) {
        event.preventDefault();
        state.composerFocusGuardUntil = Date.now() + 900;
      }
    });
  });
  document.querySelector('.chat-attachment-card')?.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') && document.activeElement === $('promptInput')) event.preventDefault();
  });
  $('chatCommandScroll')?.addEventListener('scroll', updateScrollIndicators, { passive: true });
  $('chatSelectorOptions')?.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') && document.activeElement === $('promptInput')) {
      event.preventDefault();
      state.composerFocusGuardUntil = Date.now() + 900;
    }
  });
  $('chatSelectorOptions')?.addEventListener('scroll', updateScrollIndicators, { passive: true });
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
      setSettingsUpdateIcon(updateMode, false);
      $('settingsStatus').textContent = '当前环境没有 Android 更新服务。';
      showToast('当前环境没有 Android 更新服务');
      announceUpdateState('update-error', { message: '当前环境没有 Android 更新服务。' });
      return;
    }
    clearTimeout(updateTimer);
    if (updateMode === 'download') {
      setSettingsUpdateIcon('download', true);
      announceUpdateState('update-started');
      try { native.downloadUpdate(); armUpdateTimeout('download'); }
      catch (error) {
        setSettingsUpdateIcon('download', false);
        $('settingsStatus').textContent = `更新启动失败：${error.message || '无法启动'}`;
        showToast('更新启动失败');
        announceUpdateState('update-error', { message: error.message || '无法启动更新' });
      }
      return;
    }
    setSettingsUpdateIcon('check', true);
    announceUpdateState('update-checking');
    $('settingsStatus').textContent = '正在检查更新……';
    $('updateButton').textContent = '检查中…';
    showToast('正在检查更新');
    try { native.checkForUpdate(); }
    catch (error) {
      setSettingsUpdateIcon('check', false);
      $('settingsStatus').textContent = `检查失败：${error.message || '无法启动'}`;
      $('updateButton').textContent = '重新检查';
      announceUpdateState('update-error', { message: error.message || '无法启动检查更新' });
      return;
    }
    armUpdateTimeout('check');
  };
  if (embeddedRemote) {
    document.body.classList.add('embedded-remote');
    $('homeBackButton')?.setAttribute('aria-label', '返回聊天');
  }
  window.handleSystemBack = () => {
    const drawer = $('drawer');
    if (drawer && drawer.getAttribute('aria-hidden') === 'false') { $('closeDrawer')?.click(); return true; }
    if (!$('settingsView')?.hidden) { showHome({ direction: false }); return true; }
    if (!$('projectsView')?.hidden) { showHome({ direction: false }); return true; }
    if (!$('projectView')?.hidden) {
      if (state.projectOrigin === 'projects') showProjects({ direction: false });
      else showHome({ direction: false });
      return true;
    }
    if (!$('dashboardView')?.hidden) { showHome({ direction: false }); return true; }
    if (embeddedRemote) { window.parent?.postMessage({ type: 'dsh-shell-back' }, '*'); return true; }
    return false;
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
    const input = $('promptInput');
    const value = input.value.trim();
    const images = Array.isArray(state.pendingImages) ? state.pendingImages : [];
    if (!value && !images.length) { $('promptInput').focus(); return; }
    const activeId = activeChatSessionId();
    if (isSyntheticSessionId(activeId) && String(activeId).startsWith('draft:')) {
      const creating = state.creatingChatProject;
      if (!creating) {
        showToast('新对话项目已失效，请重新选择项目');
        return;
      }
      if (state.pendingDraftPrompt) {
        showToast('正在为 DSH 创建会话，请稍候');
        return;
      }
      state.pendingDraftPrompt = { text: value, images: images.map((image) => ({ ...image })) };
      const sent = native && state.connected && typeof native.createSession === 'function'
        ? Boolean(native.createSession(creating.cwd, creating.id, creating.name, creating.workspaceId || ''))
        : sendLiveMessage('session.create', {
          cwd: creating.cwd,
          projectId: creating.id,
          projectName: creating.name,
          workspaceId: creating.workspaceId || '',
        });
      if (!sent) {
        state.pendingDraftPrompt = null;
        showToast('新建对话失败：连接不可用');
        return;
      }
      state.replying = true;
      state.pendingImages = [];
      input.value = '';
      input.style.height = 'auto';
      renderPendingImages();
      syncComposerState();
      showToast('正在创建 DSH 会话…');
      return;
    }
    const keyboardInset = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--native-keyboard-bottom'), 10) || 0;
    const webKeyboardInset = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--web-keyboard-bottom'), 10) || 0;
    // Establish the final composer geometry before inserting the outgoing
    // bubble. This reserves the expanded composer area in the transcript so
    // the just-sent message can never render underneath it.
    state.composerExpanded = document.activeElement === input || keyboardInset > 0 || webKeyboardInset > 0;
    syncComposerState();
    syncComposerViewport();
    if (state.connected) {
      state.replying = true;
      syncComposerState();
    }
    state.autoFollowChat = true;
    clearFollowResume();
    const localItem = {
      id: `local:${Date.now()}`,
      sessionId: activeChatSessionId(),
      kind: 'bubble',
      text: value,
      images: images.map((image) => ({ name: image.name, dataUrl: image.dataUrl })),
      timestamp: Date.now(),
      // This is only the local hand-off state. It must not be presented as a
      // completed DSH turn until Bridge emits a real event for this session.
      deliveryState: (state.connected || liveSocketOpen()) ? 'queued' : 'failed',
    };
    state.chatLocalItems.push(localItem);
    renderChat();
    const handedOff = control('sendPrompt', value, images);
    if (!handedOff) {
      localItem.deliveryState = 'failed';
      showToast('发送失败：当前未连接 DSH');
    }
    state.pendingImages = [];
    renderPendingImages();
    input.value = '';
    input.style.height = 'auto';
    syncComposerState();
    requestAnimationFrame(() => {
      syncComposerViewport();
      followChatProgress('smooth');
    });
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
      if (Date.now() < state.composerFocusGuardUntil) {
        preserveFocusedComposer(true);
        return;
      }
      if (!$('promptInput').value && !state.selectorKind && $('chatAttachmentLayer')?.hidden !== false) {
        state.composerExpanded = false;
        syncComposerState();
      }
    }, 120);
  });
  $('promptInput').addEventListener('input', () => { state.composerExpanded = true; $('promptInput').style.height = 'auto'; $('promptInput').style.height = `${Math.min(112, $('promptInput').scrollHeight)}px`; syncComposerState(); setTimeout(keepComposerVisible, 60); });
  $('chatScroll').addEventListener('pointerdown', () => {
    state.programmaticScrollUntil = 0;
    state.autoFollowChat = false;
    clearFollowResume();
  }, { passive: true });
  $('chatScroll').addEventListener('touchstart', (event) => {
    state.programmaticScrollUntil = 0;
    state.autoFollowChat = false;
    clearFollowResume();
    chatTouchStartY = event.touches?.[0]?.clientY ?? null;
  }, { passive: true });
  $('chatScroll').addEventListener('touchend', (event) => {
    const endY = event.changedTouches?.[0]?.clientY ?? null;
    const distance = chatTouchStartY === null || endY === null ? 0 : endY - chatTouchStartY;
    chatTouchStartY = null;
    if (distance > 72 && $('chatScroll').scrollTop <= 4) refreshActiveChat();
    if (isChatAtBottom()) scheduleFollowResume();
  }, { passive: true });
  $('chatScroll').addEventListener('touchcancel', () => { chatTouchStartY = null; }, { passive: true });
  $('chatScroll').addEventListener('wheel', (event) => {
    if (event.deltaY < 0) {
      state.programmaticScrollUntil = 0;
      state.autoFollowChat = false;
      clearFollowResume();
    }
  }, { passive: true });
  $('chatScroll').addEventListener('pointerup', () => {
    if (isChatAtBottom()) scheduleFollowResume();
  }, { passive: true });
  $('chatScroll').addEventListener('scroll', () => {
    updateScrollBottomButton();
    if (performance.now() < state.programmaticScrollUntil) return;
    if (!isChatAtBottom()) {
      state.autoFollowChat = false;
      clearFollowResume();
      // Preload well before the user reaches the top.  The returned page is
      // prepended while preserving the exact visual anchor, so there is no
      // empty edge or blocking pause at the end of the current history.
      const preloadDistance = Math.max(HISTORY_PRELOAD_MIN_DISTANCE, Math.round($('chatScroll').clientHeight * .82));
      if ($('chatScroll').scrollTop < preloadDistance) requestOlderHistory();
      return;
    }
    if (!state.autoFollowChat) scheduleFollowResume();
  }, { passive: true });
  $('chatScrollBottom').onclick = () => {
    const scroller = $('chatScroll');
    if (!scroller) return;
    clearFollowResume();
    state.autoFollowChat = true;
    state.programmaticScrollUntil = performance.now() + 1400;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    window.setTimeout(updateScrollBottomButton, 420);
  };
  window.visualViewport?.addEventListener('resize', () => { syncWebKeyboardInset(); syncComposerViewport(); setTimeout(keepComposerVisible, 40); });
  window.visualViewport?.addEventListener('scroll', syncWebKeyboardInset);
  window.addEventListener('resize', () => { syncWebKeyboardInset(); syncComposerViewport(); refreshCommandMarquees(); updateScrollIndicators(); });

  settings = safeJson(native?.getSettings?.(), {});
  // Built-in Bridge endpoint/token for the single-user setup. When nothing is
  // stored yet (fresh install / cleared data), use these instead of making the
  // user type them in the settings panel every time.
  const BUILTIN_ENDPOINT = 'ws://192.168.1.4:8788/ws';
  const BUILTIN_TOKEN = 'CsRAoEQIuWeLxbPBVb_VJKufHGAcHrdB';
  if (!settings || !settings.endpoint) {
    settings = { endpoint: BUILTIN_ENDPOINT, token: BUILTIN_TOKEN };
  }
  // Native returns the same event envelope used by the live Bridge
  // ("session.snapshot" + "data").  Unwrap it here as well, otherwise
  // a cold-started WebView sees the envelope rather than its projects/recent
  // arrays until another event happens to arrive.
  const initialSnapshotMessage = safeJson(native?.getSnapshot?.(), {});
  state.snapshot = initialSnapshotMessage?.type === 'session.snapshot'
    ? (initialSnapshotMessage.data || {})
    : initialSnapshotMessage;
  seedBrowserChatPreview();
  // A snapshot's `online` flag describes DSH, not this phone's WebSocket.
  // Query the native transport directly so a WebView that missed an early
  // broadcast still renders the real connection state.
  state.connected = browserPreview ? true : Boolean(native?.isConnected?.());
  state.connectionState = state.connected ? 'online' : 'retrying';
  state.replying = String(state.snapshot?.state || '').toLowerCase() === 'waiting' || (
    String(state.snapshot?.state || '').toLowerCase() === 'running' &&
    !['completed', 'failed', 'idle'].includes(String(state.snapshot?.phase || '').toLowerCase())
  );
  syncWebKeyboardInset();
  if (browserPreview && previewQuery.get('view') === 'chat') showDashboard({ animate: false });
  else renderHome();
  renderSnapshot(); renderEvents();
  // Single-user setup: connect to the built-in LAN Bridge endpoint so the app
  // pairs with the computer on the same WLAN/hotspot with no configuration.
  // The user can still change it in settings; that change is stored and used
  // from then on, but a fresh install always starts on the built-in endpoint.
  const connectEndpoint = BUILTIN_ENDPOINT;
  const connectToken = BUILTIN_TOKEN;
  if (connectEndpoint) {
    if (native) native.connect(connectEndpoint, connectToken);
    else openLiveSocket(connectEndpoint, connectToken);
  }
  if (native?.isConnected) {
    setInterval(() => {
      const connected = Boolean(native.isConnected());
      if (connected === state.connected) return;
      state.connected = connected;
      state.connectionState = connected ? 'online' : 'retrying';
      renderConnection();
    }, 1200);
  }
})();
