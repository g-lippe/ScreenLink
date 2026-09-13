const {
  app, BrowserWindow, Menu, MessageChannelMain, desktopCapturer, ipcMain, net, protocol, session, shell,
} = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');

// ---- CLI flags -------------------------------------------------------------
// --profile=<name>   separate userData, so two instances can run on one machine
// --devtools         open DevTools on start
// --auto=host|guest  dev automation: exchange codes through files in --exchange-dir
// --auto-share=<screen|window-name-substring>   dev automation: start sharing once connected
// --auto-preset=<key> / --auto-delay-ms=<n>    dev automation: preset to share with / delay before host connects
// --log-stats        print the stats overlay to stdout every second
// --snap=<file.png>  dev: save a screenshot of the window every 3 seconds
function flag(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const profile = flag('profile');
if (typeof profile === 'string' && /^[\w-]+$/.test(profile)) {
  app.setPath('userData', path.join(app.getPath('appData'), `ScreenLink-${profile}`));
}

const devConfig = {
  profile: typeof profile === 'string' ? profile : null,
  auto: flag('auto') || null,
  exchangeDir: flag('exchange-dir') || null,
  autoShare: flag('auto-share') || null,
  autoPreset: flag('auto-preset') || null,
  autoDelayMs: flag('auto-delay-ms') || null,
  autoOpen: flag('auto-open') || null,
  autoScript: flag('auto-script') || null,
  debugAudio: !!flag('debug-audio'),
  autoMute: !!flag('auto-mute'),
  logStats: !!flag('log-stats'),
};

// Serve the renderer from app://screenlink/ instead of file:// so ES modules, the
// AudioWorklet and CSP 'self' all behave like a normal secure origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const RENDERER_DIR = path.join(__dirname, 'renderer');
const HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'audio-capture.exe')
  : path.join(__dirname, 'bin', 'audio-capture.exe');

let win = null;
let pendingCapture = null; // { id, loopbackAudio } set right before the renderer calls getDisplayMedia
let helper = null;         // { proc, port }

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0e1016',
    title: devConfig.profile ? `ScreenLink (${devConfig.profile})` : 'ScreenLink',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // keep stats/audio running while minimized
    },
  });

  win.loadURL('app://screenlink/index.html');
  if (flag('devtools')) win.webContents.openDevTools({ mode: 'detach' });

  const snap = flag('snap');
  if (typeof snap === 'string') {
    const timer = setInterval(async () => {
      if (!win) return clearInterval(timer);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(snap, image.toPNG());
    }, 3000);
  }

  win.webContents.on('console-message', (event) => {
    const tag = devConfig.profile ? `[${devConfig.profile}]` : '[renderer]';
    console.log(`${tag} ${event.message}`);
  });

  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    stopHelper();
    win = null;
  });
}

function buildMenu() {
  const template = [
    { role: 'fileMenu' },
    { role: 'viewMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'WebRTC internals',
          click: () => {
            const w = new BrowserWindow({ width: 1100, height: 800, title: 'WebRTC internals' });
            w.loadURL('chrome://webrtc-internals');
          },
        },
        { label: 'Toggle DevTools', click: () => win && win.webContents.toggleDevTools() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- Renderer file server --------------------------------------------------
function serveRenderer(request) {
  const { pathname } = new URL(request.url);
  const filePath = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname)));
  if (!filePath.startsWith(RENDERER_DIR + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  return net.fetch(pathToFileURL(filePath).toString());
}

// ---- Capture sources -------------------------------------------------------
async function listSources() {
  const ownIds = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 384, height: 216 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => !ownIds.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
}

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const wanted = pendingCapture;
    pendingCapture = null;
    if (!wanted) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === wanted.id);
      if (!source) return callback({});
      const grant = { video: source };
      if (wanted.loopbackAudio) grant.audio = 'loopback';
      callback(grant);
    } catch (err) {
      console.error('display media handler failed:', err);
      callback({});
    }
  }, { useSystemPicker: false });
}

// ---- Native audio helper ---------------------------------------------------
function helperAvailable() {
  return process.platform === 'win32' && fs.existsSync(HELPER_PATH);
}

function stopHelper() {
  if (!helper) return;
  const { proc, port } = helper;
  helper = null;
  try { port.close(); } catch { /* already closed */ }
  if (proc.exitCode === null) proc.kill();
}

function startHelper(sourceId, scope) {
  stopHelper();
  if (!helperAvailable()) return { ok: false, reason: 'missing' };

  // window:<HWND>:0 → capture that app's process tree (unless the user asked for all audio).
  // otherwise       → capture everything except ScreenLink, so received audio isn't echoed back.
  const args = ['--parent-pid', String(process.pid)];
  const windowMatch = scope === 'system' ? null : /^window:(\d+):/.exec(sourceId);
  if (windowMatch) args.push('--include-hwnd', windowMatch[1]);
  else args.push('--exclude-pid', String(process.pid));

  const proc = spawn(HELPER_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const { port1, port2 } = new MessageChannelMain();
  helper = { proc, port: port1 };

  // stdout carries float32 frames; chunks can split a sample, so carry the remainder over.
  let carry = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usable = data.length - (data.length % 4);
    carry = data.subarray(usable);
    if (!usable) return;
    // Copy into a standalone ArrayBuffer: Node Buffers are slices of a shared pool.
    const ab = new ArrayBuffer(usable);
    new Uint8Array(ab).set(data.subarray(0, usable));
    try { port1.postMessage(ab); } catch { /* port closed */ }
  });
  proc.stderr.on('data', (d) => console.log(`[audio-capture] ${d.toString().trim()}`));
  proc.on('error', (err) => console.error('audio-capture failed to start:', err));
  proc.on('exit', (code) => {
    console.log(`[audio-capture] exited with code ${code}`);
    if (helper && helper.proc === proc) {
      try { port1.postMessage({ type: 'ended', code }); } catch { /* port closed */ }
      helper = null;
    }
  });

  port1.start();
  win.webContents.postMessage('audio-port', null, [port2]);
  return { ok: true, mode: windowMatch ? 'app' : 'system-except-self' };
}

// ---- Connection codes --------------------------------------------------------
// Session descriptions are deflated against a dictionary of typical ScreenLink SDP text, so the
// boilerplate costs almost nothing and codes fit in one chat message (Discord caps at 2000 chars).
// Changing the dictionary breaks compatibility between versions: bump the code prefix with it.
const SDP_DICTIONARY = fs.readFileSync(path.join(__dirname, 'sdp-dictionary.txt'));

function packCode(text) {
  return zlib.deflateRawSync(Buffer.from(text, 'utf8'), { level: 9, dictionary: SDP_DICTIONARY }).toString('base64url');
}

function unpackCode(b64) {
  return zlib.inflateRawSync(Buffer.from(b64, 'base64url'), { dictionary: SDP_DICTIONARY }).toString('utf8');
}

// ---- Dev automation: exchange codes through files --------------------------
function exchangePath(name) {
  if (!devConfig.exchangeDir) throw new Error('--exchange-dir not set');
  return path.join(devConfig.exchangeDir, name);
}

// ---- IPC -------------------------------------------------------------------
ipcMain.handle('get-config', () => ({
  ...devConfig,
  helperAvailable: helperAvailable(),
  platform: process.platform,
  version: app.getVersion(),
}));
ipcMain.handle('list-sources', () => listSources());
ipcMain.handle('code-pack', (_e, text) => packCode(String(text)));
ipcMain.handle('code-unpack', (_e, b64) => unpackCode(String(b64)));
ipcMain.handle('prepare-capture', (_e, { id, loopbackAudio }) => {
  pendingCapture = { id, loopbackAudio: !!loopbackAudio };
  return true;
});
ipcMain.handle('audio-start', (_e, { sourceId, scope }) => startHelper(sourceId, scope));
ipcMain.handle('audio-stop', () => { stopHelper(); return true; });
ipcMain.handle('dev-write', (_e, { name, text }) => {
  fs.writeFileSync(exchangePath(name), text, 'utf8');
  return true;
});
ipcMain.handle('dev-read', (_e, { name }) => {
  const p = exchangePath(name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
});

app.whenReady().then(() => {
  protocol.handle('app', serveRenderer);
  installDisplayMediaHandler();
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => {
  stopHelper();
  app.quit();
});
