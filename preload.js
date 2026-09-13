const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenlink', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  listSources: () => ipcRenderer.invoke('list-sources'),
  packCode: (text) => ipcRenderer.invoke('code-pack', text),
  unpackCode: (b64) => ipcRenderer.invoke('code-unpack', b64),
  prepareCapture: (id, loopbackAudio) => ipcRenderer.invoke('prepare-capture', { id, loopbackAudio }),
  startAudio: (sourceId, scope) => ipcRenderer.invoke('audio-start', { sourceId, scope }),
  stopAudio: () => ipcRenderer.invoke('audio-stop'),
  devWrite: (name, text) => ipcRenderer.invoke('dev-write', { name, text }),
  devRead: (name) => ipcRenderer.invoke('dev-read', { name }),
});

// MessagePorts can't cross contextBridge, so forward the audio port to the main world
// with window.postMessage. The renderer hands it straight to the AudioWorklet.
ipcRenderer.on('audio-port', (event) => {
  window.postMessage({ type: 'screenlink-audio-port' }, '*', event.ports);
});
