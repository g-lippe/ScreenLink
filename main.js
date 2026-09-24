const {
  app, BrowserWindow, Menu, MessageChannelMain, desktopCapturer, ipcMain, net, protocol, session, shell,
} = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const qrcode = require('qrcode-generator');
const pkg = require('./package.json');

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
  autoManual: !!flag('auto-manual'),
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
const SHARED_DIR = path.join(__dirname, 'shared');
const WEB_DIR = path.join(__dirname, 'web');
const WEB_VIEWER_URL = (pkg.screenlink && pkg.screenlink.webViewerUrl) || '';
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
    stopBridge();
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
// app://screenlink/shared/* comes from shared/ (also used by the web viewer), the rest from renderer/.
function resolveUnder(root, relative) {
  const filePath = path.normalize(path.join(root, relative));
  return filePath.startsWith(root + path.sep) ? filePath : null;
}

function serveRenderer(request) {
  const pathname = decodeURIComponent(new URL(request.url).pathname);
  const filePath = pathname.startsWith('/shared/')
    ? resolveUnder(SHARED_DIR, pathname.slice('/shared/'.length))
    : resolveUnder(RENDERER_DIR, pathname);
  if (!filePath) return new Response('Forbidden', { status: 403 });
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

// ---- QR codes ------------------------------------------------------------------
function qrDataUrl(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// ---- LAN bridge: phones on the same Wi-Fi watch what this desktop receives -------
// A small HTTP server hands out the web viewer (web/ + shared/) and two JSON endpoints. The
// actual WebRTC work happens in the renderer, which owns the session's tracks. The token is in
// the URL's #fragment, so it never shows up in request lines; the API checks it on every call.
const BRIDGE_PORT = 47823;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
let bridge = null; // { server, token, port }
const bridgeRequests = new Map(); // id → { resolve, reject, timer }
let nextBridgeRequest = 1;

function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      found.push({
        name,
        address: a.address,
        virtual: /vEthernet|VirtualBox|VMware|Hyper-V|WSL|vbox|docker|Loopback/i.test(name),
        private: /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address),
      });
    }
  }
  // Physical adapters with private addresses (Wi-Fi, Ethernet) first; Tailscale's 100.x and
  // virtual adapters last.
  return found.sort((x, y) => (x.virtual - y.virtual) || (y.private - x.private));
}

function askRenderer(kind, data, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!win) return reject(new Error('ScreenLink window is closed'));
    const id = nextBridgeRequest++;
    const timer = setTimeout(() => { bridgeRequests.delete(id); reject(new Error('timed out')); }, timeoutMs);
    bridgeRequests.set(id, { resolve, reject, timer });
    win.webContents.send('bridge-request', { id, kind, data });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function tokenMatches(token) {
  if (!bridge || typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(bridge.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleBridgeRequest(req, res) {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://bridge').pathname);
    if (req.method === 'POST' && (pathname === '/bridge/join' || pathname === '/bridge/answer')) {
      const body = await readJson(req);
      if (!tokenMatches(body.token)) return send(403, { error: 'This link has expired. Scan the QR code on your desktop again.' });
      const result = await askRenderer(pathname === '/bridge/join' ? 'join' : 'answer', body);
      return send(200, result);
    }
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    const filePath = pathname.startsWith('/shared/')
      ? resolveUnder(SHARED_DIR, pathname.slice('/shared/'.length))
      : resolveUnder(WEB_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(404, 'Not found', 'text/plain');
    send(200, fs.readFileSync(filePath), MIME[path.extname(filePath)] || 'application/octet-stream');
  } catch (err) {
    send(500, { error: err.message });
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => { server.off('error', reject); resolve(server.address().port); });
  });
}

async function startBridge() {
  if (!bridge) {
    const server = http.createServer((req, res) => { handleBridgeRequest(req, res); });
    let port;
    try {
      port = await listen(server, BRIDGE_PORT);
    } catch {
      port = await listen(server, 0); // the usual port is taken: any free one will do
    }
    bridge = { server, port, token: crypto.randomBytes(16).toString('base64url') };
  }
  const urls = lanAddresses().map((a) => ({ name: a.name, url: `http://${a.address}:${bridge.port}/#bridge=${bridge.token}` }));
  return { urls, qr: urls.length ? qrDataUrl(urls[0].url) : null };
}

function stopBridge() {
  if (!bridge) return;
  bridge.server.close();
  if (bridge.server.closeAllConnections) bridge.server.closeAllConnections();
  bridge = null;
}

// ---- Dev automation: exchange codes through files --------------------------
function exchangePath(name) {
  if (!devConfig.exchangeDir) throw new Error('--exchange-dir not set');
  return path.join(devConfig.exchangeDir, name);
}

// ---- IPC -------------------------------------------------------------------
ipcMain.handle('get-config', () => ({
  ...devConfig,
  webViewerUrl: WEB_VIEWER_URL,
  helperAvailable: helperAvailable(),
  platform: process.platform,
  version: app.getVersion(),
}));
ipcMain.handle('list-sources', () => listSources());
ipcMain.handle('qr', (_e, text) => qrDataUrl(String(text)));
ipcMain.handle('bridge-start', () => startBridge());
ipcMain.handle('bridge-stop', () => { stopBridge(); return true; });
ipcMain.handle('bridge-reply', (_e, { id, result, error }) => {
  const pending = bridgeRequests.get(id);
  if (!pending) return false;
  bridgeRequests.delete(id);
  clearTimeout(pending.timer);
  if (error) pending.reject(new Error(error)); else pending.resolve(result);
  return true;
});
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
  stopBridge();
  app.quit();
});
