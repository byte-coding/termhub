const { contextBridge, ipcRenderer } = require('electron');

function on(channel) {
  return (fn) => {
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('termhub', {
  init: () => ipcRenderer.invoke('state:init'),
  createSession: (opts) => ipcRenderer.invoke('session:create', opts),
  resumeSession: (id, cols, rows, restored) => ipcRenderer.invoke('session:resume', id, cols, rows, restored),
  history: (id) => ipcRenderer.invoke('session:history', id),
  rename: (id, title) => ipcRenderer.invoke('session:rename', id, title),
  pin: (id, pinned) => ipcRenderer.invoke('session:pin', id, pinned),
  remove: (id) => ipcRenderer.invoke('session:delete', id),
  kill: (id) => ipcRenderer.invoke('session:kill', id),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  sessionMenu: (id) => ipcRenderer.send('menu:session', id),
  setFullScreen: (on) => ipcRenderer.send('win:fullscreen', on),
  setBadge: (count) => ipcRenderer.send('app:badge', count),
  terminalMenu: (hasSelection) => ipcRenderer.send('menu:terminal', hasSelection),
  onData: on('pty:data'),
  onExit: on('pty:exit'),
  onRemoved: on('pty:removed'),
  onSessions: on('sessions:changed'),
  onAction: on('ui:action'),
  onRename: on('ui:rename'),
  onResume: on('ui:resume'),
  onNew: on('ui:new'),
  onFullscreen: on('ui:fullscreen'),
});
