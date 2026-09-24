// ScreenLink web viewer: watch-only, for phones (and any browser without the app).
//   https://…/ScreenLink/#7K3M-QX9P        joins a session through the public relays
//   http://<desktop>:47823/#bridge=<token>  watches what a desktop on the same Wi-Fi receives
import { Peer, STUN_SERVERS } from './shared/peer.js';
import { joinRoom, normalizeRoomCode, formatRoomCode } from './shared/rendezvous.js';
import { StatsMonitor } from './shared/stats.js';

const $ = (id) => document.getElementById(id);
const hash = decodeURIComponent(location.hash.slice(1));
const bridgeToken = hash.startsWith('bridge=') ? hash.slice('bridge='.length) : null;

let peer = null;
let stats = null;
let joinAbort = null;
let wakeLock = null;
let hostName = 'them';
let userLeft = false;

// ---- Join ----------------------------------------------------------------------
function setStatus(text, kind = '') {
  $('join-status').textContent = text;
  $('join-status').className = `status ${kind}`;
}

function showView(name) {
  $('join-view').hidden = name !== 'join';
  $('watch-view').hidden = name !== 'watch';
}

if (bridgeToken) {
  $('code-field').hidden = true;
  $('join-subtitle').textContent = 'Watch what your computer is receiving, on this phone.';
  $('watch').textContent = 'Start watching';
} else {
  const prefill = () => {
    const code = normalizeRoomCode(decodeURIComponent(location.hash.slice(1)));
    if (code) $('code').value = formatRoomCode(code);
  };
  prefill();
  window.addEventListener('hashchange', prefill);
}

$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('watch').click(); });
$('watch').addEventListener('click', () => {
  // This tap is the user gesture browsers want before playing sound: bless the video element now.
  const video = $('video');
  video.muted = false;
  video.play().catch(() => {});
  start();
});

async function start() {
  userLeft = false;
  $('watch').disabled = true;
  try {
    if (bridgeToken) await startBridge();
    else await startRelay();
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(err.message, 'error');
    if (peer) { peer.close(); peer = null; }
  } finally {
    $('watch').disabled = false;
  }
}

function newPeer(iceServers) {
  const p = new Peer({ iceServers, receiveOnly: true });
  p.addEventListener('channel-open', () => p.send({ type: 'hello', device: 'phone', viewOnly: true }));
  p.addEventListener('message', (e) => onMessage(e.detail));
  p.addEventListener('state', (e) => onState(p, e.detail));
  return p;
}

async function startRelay() {
  const code = normalizeRoomCode($('code').value);
  if (!code) throw new Error('Enter the invite code. It looks like 7K3M-QX9P.');
  if (!window.crypto || !crypto.subtle) throw new Error('This page needs a secure (https) connection to join with a code.');
  history.replaceState(null, '', `#${formatRoomCode(code)}`);
  joinAbort = new AbortController();
  await joinRoom(code, {
    createPeer: () => (peer = newPeer(STUN_SERVERS)),
    device: 'phone',
    viewOnly: true,
    onStatus: (text) => setStatus(text, 'busy'),
    signal: joinAbort.signal,
  });
  joinAbort = null;
}

async function bridgeCall(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: bridgeToken, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The computer answered ${res.status}.`);
  return data;
}

async function startBridge() {
  setStatus('Connecting to your computer…', 'busy');
  hostName = 'your computer';
  const { viewerId, sdp } = await bridgeCall('/bridge/join', {});
  // Same Wi-Fi: local addresses are all that's needed.
  peer = newPeer([]);
  const answer = await peer.acceptOffer(sdp);
  await bridgeCall('/bridge/answer', { viewerId, sdp: answer });
}

// ---- Session -------------------------------------------------------------------
function onState(p, state) {
  if (p !== peer) return;
  if (state === 'connected') {
    setBanner('');
    if ($('watch-view').hidden) enterWatch();
  } else if (state === 'disconnected') {
    setBanner('Connection interrupted. Trying to recover…');
  } else if (state === 'failed') {
    endWatch("Lost the connection.");
  }
}

function onMessage(msg) {
  switch (msg.type) {
    case 'hello':
      if (msg.device === 'desktop-bridge') hostName = 'your computer';
      break;
    case 'share-started':
      setLabel(msg.name);
      break;
    case 'share-stopped':
      setLabel(null);
      break;
    case 'bye':
      endWatch(bridgeToken ? 'Your computer ended the session.' : 'The host ended the session.');
      break;
    default:
      break;
  }
}

function enterWatch() {
  setStatus('');
  showView('watch');
  const video = $('video');
  video.srcObject = peer.remoteStream;
  playWithSound();
  setLabel(null);
  stats = new StatsMonitor(peer.pc, renderStats);
  keepAwake();
  wakeControls();
}

function playWithSound() {
  const video = $('video');
  video.muted = false;
  video.play().then(updateMute).catch(() => {
    // Autoplay with sound was refused: play muted and offer a button.
    video.muted = true;
    video.play().catch(() => {});
    $('unmute').hidden = false;
    updateMute();
  });
}

function setLabel(name) {
  const sharing = name !== null && name !== undefined;
  $('label').hidden = !sharing;
  $('waiting').hidden = sharing;
  $('label-text').textContent = name ? name : 'Live';
  $('waiting-text').textContent = bridgeToken
    ? "Connected to your computer. Nothing is being shared with it right now."
    : `Connected. Waiting for ${hostName} to share…`;
  if (sharing) $('video').play().catch(() => {});
}

function endWatch(reason) {
  if (stats) { stats.stop(); stats = null; }
  if (peer) { peer.close(); peer = null; }
  $('video').srcObject = null;
  releaseWake();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  showView('join');
  setStatus(reason, userLeft ? '' : 'error');
  $('watch').textContent = bridgeToken ? 'Watch again' : 'Watch';
}

function setBanner(text) {
  $('banner').textContent = text;
  $('banner').hidden = !text;
}

// ---- Controls ------------------------------------------------------------------
function updateMute() {
  const muted = $('video').muted;
  $('mute-btn').querySelector('use').setAttribute('href', muted ? '#i-muted' : '#i-volume');
  $('mute-btn').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

$('unmute').addEventListener('click', (e) => {
  e.stopPropagation();
  $('video').muted = false;
  $('video').play().catch(() => {});
  $('unmute').hidden = true;
  updateMute();
});
$('mute-btn').addEventListener('click', () => {
  $('video').muted = !$('video').muted;
  if (!$('video').muted) $('unmute').hidden = true;
  updateMute();
});
$('full-btn').addEventListener('click', async () => {
  const stage = $('stage');
  const video = $('video');
  if (document.fullscreenElement) return document.exitFullscreen();
  if (stage.requestFullscreen) {
    await stage.requestFullscreen().catch(() => {});
    // Screens are landscape: turn the phone's layout with it where the browser allows.
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } else if (video.webkitEnterFullscreen) {
    video.webkitEnterFullscreen(); // iPhone Safari only lets the video element go fullscreen
  }
});
$('stats-btn').addEventListener('click', () => {
  $('stats').hidden = !$('stats').hidden;
  $('stats-btn').classList.toggle('on', !$('stats').hidden);
});
$('leave-btn').addEventListener('click', () => {
  userLeft = true;
  endWatch('You left the session.');
});

// Controls fade out after a few seconds; a tap brings them back.
let idleTimer = null;
function wakeControls() {
  $('stage').classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!$('label').hidden) $('stage').classList.add('idle');
  }, 3500);
}
$('stage').addEventListener('click', wakeControls);

// ---- Keep the screen on while watching ---------------------------------------------
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported, or not allowed right now */ }
}
function releaseWake() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && peer && !$('watch-view').hidden) keepAwake();
});

// ---- Stats ---------------------------------------------------------------------
const mbps = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${kbps} kb/s`);
function renderStats(s) {
  if ($('stats').hidden) return;
  const lines = [];
  if (s.recvVideo) {
    const v = s.recvVideo;
    lines.push(`${v.width}×${v.height} · ${v.fps} fps`);
    lines.push(`${v.codec} · ${mbps(v.kbps)}`);
    lines.push(`lost ${v.lost} · freezes ${v.freezes}`);
  }
  if (s.recvAudio) lines.push(`audio ${s.recvAudio.codec} · ${mbps(s.recvAudio.kbps)}`);
  if (s.net) lines.push(`${s.net.path} · rtt ${s.net.rttMs ?? '?'} ms`);
  $('stats').textContent = lines.join('\n') || 'No stream yet';
}

window.addEventListener('pagehide', () => {
  if (joinAbort) joinAbort.abort();
  if (peer) peer.close();
});
