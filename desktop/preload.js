/**
 * 只暴露「更多」菜单需要的三个原生动作。
 * 页面本身仍然没有 Node 能力（sandbox + contextIsolation）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bmfApp', {
  openLogs: () => ipcRenderer.send('bmf:open-logs'),
  about: () => ipcRenderer.send('bmf:about'),
  quit: () => ipcRenderer.send('bmf:quit'),
  toggleFullscreen: () => ipcRenderer.send('bmf:toggle-fullscreen'),
  toggleDevTools: () => ipcRenderer.send('bmf:toggle-devtools'),
  openBrowser: () => ipcRenderer.send('bmf:open-browser'),
});
