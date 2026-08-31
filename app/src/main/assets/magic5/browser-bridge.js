(() => {
  'use strict';
  if (window.AndroidRemote) return;

  // Browser-only compatibility shim. It deliberately contains no sessions,
  // projects, messages, or canned replies: previews start in a clean state.
  const snapshot = {
    device: { name: 'DSH Desktop' },
    state: 'idle',
    phase: 'idle',
    usage: {},
    projects: [],
    recent: [],
  };
  window.AndroidRemote = {
    getSettings: () => ({}),
    getSnapshot: () => snapshot,
    isConnected: () => false,
    connect: () => {},
    disconnect: () => {},
    requestSnapshot: () => {},
    requestHistory: () => false,
    activateSession: () => false,
    requestSessionContext: () => false,
    sendPrompt: () => false,
    stopTask: () => false,
    continueTask: () => false,
  };
})();
