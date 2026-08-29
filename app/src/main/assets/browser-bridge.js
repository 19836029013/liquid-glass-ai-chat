(() => {
  'use strict';
  if (window.AndroidRemote) return;

  const now = Date.now();
  const sessionId = 'browser-preview-main';
  const projectId = 'browser-preview-dsh';
  const snapshot = {
    device: { name: 'MagicBook' },
    project: { id: projectId, name: 'dsh插件' },
    session: { id: sessionId, title: 'Remote DSH', updatedAt: now },
    state: 'idle',
    phase: 'idle',
    usage: {
      contextUsed: 16100,
      contextLimit: 262000,
      systemPrompt: 1600,
      tools: 6800,
      messages: 7100,
    },
    provider: { name: 'Console Go', id: 'console-go' },
    modelSelection: { provider: 'opengo', model: 'hy3', reasoningEffort: '' },
    modelCatalog: [{
      provider: 'opengo',
      providerName: 'open-go',
      models: [
        { id: 'kimi-k3' },
        { id: 'ox-alpha-free', reasoningEfforts: ['low', 'high', 'max'] },
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-flash-vision-exp', reasoningEfforts: ['off', 'low', 'medium', 'high'] },
        { id: 'qwen3.8-max' },
        { id: 'hy3' },
        { id: 'gpt-5.6-luna' },
        { id: 'grok-4.5' },
      ],
    }],
    permissions: {
      current: 'workspace-write',
      options: [
        { value: 'workspace-write', name: '工作区写入', description: '在工作区中运行命令' },
        { value: 'danger-full-access', name: '完全访问', description: '完全访问计算机（风险较高）' },
      ],
    },
    updatedAt: now,
    projects: [
      { id: projectId, name: 'dsh插件', asset: 'folder2.svg' },
      { id: 'browser-preview-dsapp', name: 'dsAPP', asset: 'folder2.svg' },
      { id: 'browser-preview-pc', name: '电脑整理', asset: 'folder2.svg' },
      { id: 'browser-preview-html', name: 'HTML', asset: 'folder2.svg' },
    ],
    recent: [
      { id: sessionId, title: 'Remote DSH', projectId, projectName: 'dsh插件', updatedAt: now },
      { id: 'browser-preview-update', title: '排查更新下载卡住问题', projectId, projectName: 'dsh插件', updatedAt: now - 4 * 60 * 60 * 1000 },
      { id: 'browser-preview-polish', title: '优化 dsh 回复版面', projectId, projectName: 'dsh插件', updatedAt: now - 5 * 60 * 60 * 1000 },
      { id: 'browser-preview-quota', title: '确认编码是否消耗额度', projectId: 'browser-preview-dsapp', projectName: 'dsAPP', updatedAt: now - 8 * 60 * 60 * 1000 },
    ],
    lastMessage: '明白。前一版只能证明交互，不符合你的要求。',
  };

  const history = [
    { id: 'h1', seq: 1, timestamp: now - 7000, kind: 'bubble', text: '逻辑不仅要，更重要的是我现在要像素级的复刻和精准' },
    { id: 'h2', seq: 2, timestamp: now - 6000, kind: 'event', icon: 'chat-think.png', text: 'Planning pixel-accurate calibration' },
    { id: 'h3', seq: 3, timestamp: now - 5000, kind: 'note', text: '明白。前一版只能证明交互，不符合你的要求。\n接下来我会以你这台 Magic5 Pro 的真实截图和真实视口为基准，按像素逐项对齐：外框、状态栏、顶部胶囊、字体、字号、行高、间距、图标和底部输入栏。' },
    { id: 'h4', seq: 4, timestamp: now - 4000, kind: 'event', icon: 'chat-read.png', text: 'SKILL.md' },
    { id: 'h5', seq: 5, timestamp: now - 3000, kind: 'event', icon: 'chat-terminal.png', text: '命令执行' },
  ];

  const emit = (socket, message, delay = 0) => {
    setTimeout(() => socket.onmessage?.({ data: JSON.stringify(message) }), delay);
  };

  class BrowserPreviewSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = BrowserPreviewSocket.CONNECTING;
      setTimeout(() => {
        this.readyState = BrowserPreviewSocket.OPEN;
        this.onopen?.();
      }, 24);
    }
    send(raw) {
      const message = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
      if (message.type === 'session.snapshot.request') {
        emit(this, { type: 'session.snapshot', data: snapshot }, 10);
        return;
      }
      if (message.type === 'session.history.request') {
        emit(this, { type: 'session.history', data: { sessionId: message.data?.sessionId || sessionId, items: history, hasMore: false, nextBefore: null } }, 20);
        return;
      }
      if (message.type === 'prompt.send') {
        emit(this, { type: 'agent.thinking', sessionId, timestamp: Date.now(), data: { summary: '正在同步 DSH 事件' } }, 120);
        emit(this, { type: 'assistant.message', sessionId, timestamp: Date.now() + 240, data: { text: '已收到消息，正在从 DSH 同步。' } }, 260);
        emit(this, { type: 'session.completed', sessionId, timestamp: Date.now() + 480, data: { state: 'idle' } }, 520);
      }
    }
    close() {
      this.readyState = BrowserPreviewSocket.CLOSED;
      this.onclose?.({ code: 1000, reason: 'preview closed' });
    }
  }
  BrowserPreviewSocket.OPEN = 1;
  window.WebSocket = BrowserPreviewSocket;
  window.AndroidRemote = {
    getSettings: () => ({ endpoint: 'ws://browser-preview.invalid/ws', token: '' }),
    getSnapshot: () => snapshot,
    connect: () => {},
    disconnect: () => {},
    requestSnapshot: () => {},
    sendPrompt: (text, attachmentsJson, targetSessionId) => {
      const target = String(targetSessionId || sessionId);
      const deliver = (message, delay = 0) => setTimeout(() => window.DshRemote?.onNativeMessage?.(JSON.stringify(message)), delay);
      deliver({ type: 'control.result', sessionId: target, data: { ok: true, type: 'prompt.send', state: 'queued', sessionId: target } }, 20);
      deliver({ type: 'user.message', sessionId: target, timestamp: Date.now() + 50, data: { text: String(text || ''), sessionId: target } }, 70);
      deliver({ type: 'agent.thinking', sessionId: target, timestamp: Date.now() + 100, data: { summary: '正在整理你的消息' } }, 140);
      deliver({ type: 'assistant.message', sessionId: target, timestamp: Date.now() + 280, data: { text: '浏览器预览已收到消息，DSH 正在同步处理。' } }, 320);
      deliver({ type: 'session.completed', sessionId: target, timestamp: Date.now() + 440, data: { state: 'idle' } }, 520);
    },
    stopTask: (targetSessionId) => {
      const target = String(targetSessionId || sessionId);
      window.DshRemote?.onNativeMessage?.(JSON.stringify({ type: 'control.result', sessionId: target, data: { ok: true, type: 'task.stop', state: 'paused', sessionId: target } }));
    },
    continueTask: (targetSessionId) => {
      const target = String(targetSessionId || sessionId);
      window.DshRemote?.onNativeMessage?.(JSON.stringify({ type: 'control.result', sessionId: target, data: { ok: true, type: 'task.continue', state: 'queued', sessionId: target } }));
    },
  };
})();
