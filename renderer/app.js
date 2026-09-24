import { Peer, VIDEO_CODECS, iceServersWith } from './shared/peer.js';
import { RoomHost, joinRoom, newRoomCode, normalizeRoomCode, formatRoomCode } from './shared/rendezvous.js';
import { StatsMonitor } from './shared/stats.js';
import { encodeCode, decodeCode } from './signaling.js';
import { Capture, PRESETS, DEFAULT_PRESET } from './capture.js';
import { openPicker } from './picker.js';
import { probeTrack } from './dev-probe.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const config = await window.screenlink.getConfig();

// ---- Settings (per profile, localStorage) --------------------------------------
const SETTINGS_KEY = 'screenlink.settings';
const settings = {
  presetKey: DEFAULT_PRESET,
  detail: false,
  audio: true,
  audioScope: 'app',
  volume: 100,
  muted: false,
  showStats: false,
  showPreview: true,
  videoCodec: 'H264',
  turn: { url: '', username: '', credential: '' },
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch { /* defaults */ }
if (!PRESETS[settings.presetKey]) settings.presetKey = DEFAULT_PRESET;
const saveSettings = () => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
};

// ---- State ---------------------------------------------------------------------
let peer = null;
let roomHost = null;        // RoomHost while an invite is open
let joinAbort = null;       // AbortController while joining with a code
let inviteCode = null;
let capture = null;
let stats = null;
let inSession = false;
let recoveryTimer = null;
let audioStats = null;
let remoteShare = null;     // { name } while the peer is sharing
let peerStopped = false;
let remoteInfo = { device: 'desktop', viewOnly: false };

// ---- Connect view --------------------------------------------------------------
function showView(name) {
  $('connect-view').hidden = name !== 'connect';
  $('session-view').hidden = name !== 'session';
}

function setStatus(text, kind = '') {
  const el = $('connect-status');
  el.textContent = text || '';
  el.className = `status ${kind}`;
}

function setInlineStatus(id, text, kind = 'busy') {
  const el = $(id);
  el.textContent = text;
  el.className = `status inline ${kind}`;
}

const STEPS = ['connect-home', 'host-flow', 'join-flow', 'manual-host-flow', 'manual-guest-flow'];
function showConnectStep(step) {
  for (const id of STEPS) $(id).hidden = id !== step;
  $('manual-entry').hidden = step !== 'connect-home';
}

// Leaves the relays. abortJoin=false when the join just succeeded: its peer is now the session.
function closeRendezvous({ abortJoin = true } = {}) {
  if (roomHost) { roomHost.close(); roomHost = null; }
  if (joinAbort && abortJoin) joinAbort.abort();
  joinAbort = null;
  inviteCode = null;
}

function resetConnect(message = '', kind = '') {
  closeRendezvous();
  if (peer && !inSession) peer.close();
  peer = null;
  ['join-code', 'invite-out', 'answer-in', 'answer-out'].forEach((id) => { $(id).value = ''; });
  setBusy(false);
  showConnectStep('connect-home');
  setStatus(message, kind);
}

function setBusy(busy) {
  ['create-invite', 'join', 'connect', 'manual-create'].forEach((id) => { $(id).disabled = busy; });
}

function newPeer() {
  const p = new Peer({ iceServers: iceServersWith(settings.turn), videoCodec: settings.videoCodec, debugAudio: !!config.debugAudio });
  p.addEventListener('state', (e) => onConnectionState(p, e.detail));
  p.addEventListener('message', (e) => onPeerMessage(p, e.detail));
  p.addEventListener('channel-open', () => p.send({ type: 'hello', device: 'desktop', viewOnly: false, version: config.version }));
  return p;
}

function inviteLink(code) {
  return config.webViewerUrl ? `${config.webViewerUrl}#${code}` : code;
}

// Host: one short code, exchanged over the public relays.
$('create-invite').addEventListener('click', async () => {
  setBusy(true);
  setStatus('Creating invite…', 'busy');
  const code = newRoomCode();
  try {
    const host = await RoomHost.open(code, {
      createPeer: () => {
        peer = newPeer();
        return peer;
      },
    });
    roomHost = host;
    inviteCode = code;
    host.addEventListener('guest', (e) => {
      remoteInfo = e.detail;
      setInlineStatus('host-status', e.detail.viewOnly ? 'A phone is joining…' : 'Your friend is joining…');
    });
    $('invite-code').textContent = code;
    $('invite-qr').src = await window.screenlink.qr(inviteLink(code));
    setInlineStatus('host-status', 'Waiting for your friend to join… Keep this window open.');
    showConnectStep('host-flow');
    setStatus('');
  } catch (err) {
    resetConnect(err.message, 'error');
  } finally {
    setBusy(false);
  }
});

async function copyWithFeedback(button, text) {
  await navigator.clipboard.writeText(text);
  const label = button.textContent;
  button.textContent = 'Copied';
  button.classList.add('done');
  setTimeout(() => { button.textContent = label; button.classList.remove('done'); }, 1600);
}
$('copy-code').addEventListener('click', (e) => { if (inviteCode) copyWithFeedback(e.currentTarget, inviteCode); });
$('copy-link').addEventListener('click', (e) => { if (inviteCode) copyWithFeedback(e.currentTarget, inviteLink(inviteCode)); });

// Guest: a short code or link joins over the relays; a long SL2- code is a manual invite.
$('join').addEventListener('click', () => joinWith($('join-code').value.trim()));
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });

async function joinWith(input) {
  if (!input) return setStatus('Enter an invite code first.', 'error');
  if (/^SL\d-/i.test(input)) return joinManual(input);
  const code = normalizeRoomCode(input);
  if (!code) return setStatus("That doesn't look like an invite code. It should look like 7K3M-QX9P.", 'error');

  setStatus('');
  $('joining-code').textContent = formatRoomCode(code);
  showConnectStep('join-flow');
  joinAbort = new AbortController();
  try {
    await joinRoom(code, {
      createPeer: () => {
        remoteInfo = { device: 'desktop', viewOnly: false };
        peer = newPeer();
        return peer;
      },
      device: 'desktop',
      onStatus: (text) => setInlineStatus('join-status', text),
      signal: joinAbort.signal,
    });
    joinAbort = null;
  } catch (err) {
    if (err.name === 'AbortError') return;
    joinAbort = null;
    if (!inSession) resetConnect(err.message, 'error');
  }
}

// ---- Manual codes (fallback without relays) ---------------------------------------
$('manual-create').addEventListener('click', async () => {
  setBusy(true);
  setStatus('Creating manual invite…', 'busy');
  try {
    peer = newPeer();
    remoteInfo = { device: 'desktop', viewOnly: false };
    $('invite-out').value = await encodeCode('offer', await peer.createOffer());
    showConnectStep('manual-host-flow');
    setStatus('');
  } catch (err) {
    resetConnect(`Couldn't create an invite: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
});

async function joinManual(code) {
  setBusy(true);
  setStatus('Reading invite…', 'busy');
  const p = newPeer();
  try {
    const offer = await decodeCode(code, 'offer');
    const answer = await p.acceptOffer(offer);
    peer = p;
    remoteInfo = { device: 'desktop', viewOnly: false };
    $('answer-out').value = await encodeCode('answer', answer);
    showConnectStep('manual-guest-flow');
    setStatus('Waiting for your peer to paste the answer…', 'busy');
  } catch (err) {
    p.close();
    setStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

$('connect').addEventListener('click', async () => {
  const code = $('answer-in').value.trim();
  if (!code) return setStatus('Paste the answer code first.', 'error');
  setBusy(true);
  try {
    await peer.acceptAnswer(await decodeCode(code, 'answer'));
    setStatus('Connecting…', 'busy');
  } catch (err) {
    setBusy(false);
    setStatus(err.message, 'error');
  }
});

document.querySelectorAll('.cancel').forEach((b) => b.addEventListener('click', () => resetConnect()));

document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
  copyWithFeedback(b, $(b.dataset.copy).value);
}));

// ---- Connection lifecycle ------------------------------------------------------
function onConnectionState(p, state) {
  if (p !== peer) return;
  console.log(`connection state: ${state}`);
  if (state === 'connected') {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    setBanner('');
    if (!inSession) enterSession();
  } else if (state === 'disconnected' && inSession) {
    setBanner('Connection interrupted. Trying to recover…');
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => endSession('Connection lost.'), 15000);
  } else if (state === 'failed') {
    if (inSession) {
      endSession('Connection lost.');
    } else if (roomHost) {
      // The invite stays open, so the guest can simply try again.
      peer = null;
      setInlineStatus('host-status', "That attempt couldn't connect. The invite is still open: ask them to join again.", 'error');
    } else if (!joinAbort) {
      resetConnect("Couldn't establish a direct connection. Try a new invite; if it keeps failing, see the README's NAT section.", 'error');
    }
  }
}

function onPeerMessage(p, msg) {
  if (p !== peer) return;
  console.log(`peer message: ${JSON.stringify(msg)}`);
  switch (msg.type) {
    case 'hello':
      remoteInfo = { device: msg.device || 'desktop', viewOnly: !!msg.viewOnly };
      updateStage();
      break;
    case 'share-started':
      remoteShare = { name: msg.name || '' };
      peerStopped = false;
      $('remote-video').play().catch(() => {});
      updateStage();
      bridgeBroadcast({ type: 'share-started', name: remoteShare.name });
      break;
    case 'share-stopped':
      remoteShare = null;
      peerStopped = true;
      updateStage();
      bridgeBroadcast({ type: 'share-stopped' });
      break;
    case 'bye':
      endSession('Your peer disconnected.');
      break;
    default:
      break;
  }
}

function enterSession() {
  inSession = true;
  closeRendezvous({ abortJoin: false });
  if (config.auto) {
    const opus = (sdp) => (sdp.match(/a=fmtp:\d+ .*useinbandfec.*/g) || []).join(' || ');
    console.log(`sdp local  opus: ${opus(peer.pc.localDescription.sdp)}`);
    console.log(`sdp remote opus: ${opus(peer.pc.remoteDescription.sdp)}`);
  }
  showView('session');
  setStatus('');
  const video = $('remote-video');
  video.srcObject = peer.remoteStream;
  applyVolume();
  video.play().catch(() => {});
  remoteShare = null;
  peerStopped = false;
  updateShareUi();
  stats = new StatsMonitor(peer.pc, renderStats);
  if (config.debugAudio) probeTrack(peer.audioTx.receiver.track, 'received track');
  if (capture) peer.send({ type: 'share-started', name: capture.source.name });
}

async function endSession(reason) {
  if (!inSession) return;
  console.log(`session ended: ${reason}`);
  inSession = false;
  clearTimeout(recoveryTimer);
  stopBridge();
  if (capture) { capture.stop(); capture = null; }
  if (stats) { stats.stop(); stats = null; }
  if (peer) peer.close();
  peer = null;
  $('remote-video').srcObject = null;
  $('local-video').srcObject = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setBanner('');
  showView('connect');
  resetConnect(reason, reason === 'Disconnected.' ? '' : 'error');
}

$('disconnect-btn').addEventListener('click', () => endSession('Disconnected.'));
window.addEventListener('beforeunload', () => {
  if (peer) peer.close();
  closeRendezvous();
  stopBridge();
});

function setBanner(text, kind = '') {
  const b = $('banner');
  b.textContent = text;
  b.className = `banner ${kind}`;
  b.hidden = !text;
}

// ---- Sharing -------------------------------------------------------------------
async function beginShare({ source, presetKey, detail, audio, audioScope = settings.audioScope }) {
  Object.assign(settings, { presetKey, detail, audio, audioScope });
  saveSettings();

  const switching = !!capture;
  if (switching) await stopShare(false);
  const next = new Capture(source, { presetKey, detail, audio, audioScope, helperAvailable: config.helperAvailable });
  try {
    await next.start();
    if (!inSession) throw new Error('the session ended');
  } catch (err) {
    console.error(`capture failed: ${err.name}: ${err.message}`);
    next.stop();
    if (switching && peer) peer.send({ type: 'share-stopped' });
    setBanner(`Couldn't capture "${source.name}": ${err.message}`, 'error');
    setTimeout(() => setBanner(''), 6000);
    return;
  }
  capture = next;
  capture.addEventListener('ended', () => { if (capture === next) stopShare(); });
  capture.addEventListener('audio-stats', (e) => { audioStats = e.detail; });
  capture.addEventListener('audio-ended', () => {
    if (capture === next) setBanner('Audio capture stopped unexpectedly. Video is still being shared.');
  });

  if (config.debugAudio && capture.audioTrack) probeTrack(capture.audioTrack, 'outgoing track');
  await peer.setOutgoing({ videoTrack: capture.videoTrack, audioTrack: capture.audioTrack });
  await applyQuality();
  peer.send({ type: 'share-started', name: source.name, kind: source.kind });
  updateShareUi();
}

async function stopShare(notify = true) {
  if (!capture) return;
  const old = capture;
  capture = null;
  audioStats = null;
  if (peer) await peer.setOutgoing({});
  old.stop();
  if (notify && peer) peer.send({ type: 'share-stopped' });
  updateShareUi();
}

async function applyQuality() {
  if (!capture || !peer) return;
  const preset = PRESETS[settings.presetKey];
  try {
    await capture.setPreset(settings.presetKey);
    capture.setDetail(settings.detail);
    await peer.applyVideoParams({ maxBitrate: preset.bitrate, maxFramerate: preset.fps, detail: settings.detail });
  } catch (err) {
    console.warn('applying quality failed', err);
  }
}

const AUDIO_MODE_TEXT = {
  app: "Sharing this app's audio",
  'system-except-self': 'Sharing computer audio',
  system: 'Sharing all computer audio (includes what you hear from your peer)',
  none: 'No audio',
};

function updateStage() {
  $('remote-label').hidden = !remoteShare;
  $('stage-empty').hidden = !!remoteShare;
  if (remoteShare) {
    $('remote-name').textContent = remoteShare.name ? `Watching ${remoteShare.name}` : 'Watching';
    return;
  }
  if (remoteInfo.viewOnly) {
    $('stage-empty-text').textContent = capture
      ? `You're sharing ${capture.source.name}. Your friend is watching on a phone.`
      : 'Your friend is watching on a phone. Click Share to start.';
    return;
  }
  const peerText = peerStopped ? 'Your peer stopped sharing.' : "Your peer isn't sharing.";
  $('stage-empty-text').textContent = capture
    ? `You're sharing ${capture.source.name}. ${peerText}`
    : peerStopped ? peerText : 'Neither of you is sharing yet.';
}

function updateShareUi() {
  updateStage();
  const sharing = !!capture;
  $('share-btn').hidden = sharing;
  $('stop-btn').hidden = !sharing;
  $('sharing-pill').hidden = !sharing;
  $('preview-btn').classList.toggle('on', settings.showPreview);
  $('stats-btn').classList.toggle('on', settings.showStats);
  $('stats').hidden = !settings.showStats;
  $('quality-select').value = settings.presetKey;
  $('detail-toggle').checked = settings.detail;
  updatePreview();
  if (sharing) {
    $('sharing-name').textContent = `Sharing ${capture.source.name}`;
    let text = AUDIO_MODE_TEXT[capture.audioMode];
    if (capture.audioMode === 'none' && settings.audio && capture.source.kind === 'window' && !config.helperAvailable) {
      text = 'No audio: app audio needs audio-capture.exe';
    }
    $('audio-mode').textContent = text;
  } else {
    $('audio-mode').textContent = '';
  }
}

// The self-preview only renders while this window has focus: a hidden or background preview
// would just spend GPU time drawing frames nobody looks at.
let windowFocused = document.hasFocus();
function updatePreview() {
  const box = $('self-preview');
  const video = $('local-video');
  box.hidden = !capture || !settings.showPreview;
  const live = !box.hidden && windowFocused && !document.hidden;
  box.classList.toggle('paused', !box.hidden && !live);
  if (live) {
    if (video.srcObject?.getVideoTracks()[0] !== capture.videoTrack) video.srcObject = new MediaStream([capture.videoTrack]);
    video.play().catch(() => {});
  } else if (video.srcObject) {
    video.srcObject = null;
  }
}
window.addEventListener('focus', () => { windowFocused = true; updatePreview(); });
window.addEventListener('blur', () => { windowFocused = false; updatePreview(); });
document.addEventListener('visibilitychange', updatePreview);

$('share-btn').addEventListener('click', async () => {
  const choice = await openPicker({ ...settings, helperAvailable: config.helperAvailable });
  if (choice && inSession) await beginShare(choice);
});
$('stop-btn').addEventListener('click', () => stopShare());

$('quality-select').replaceChildren(...Object.entries(PRESETS).map(([key, p]) => {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = p.label;
  return opt;
}));
$('quality-select').addEventListener('change', async (e) => {
  settings.presetKey = e.target.value;
  saveSettings();
  await applyQuality();
});
$('detail-toggle').addEventListener('change', async (e) => {
  settings.detail = e.target.checked;
  saveSettings();
  await applyQuality();
});

// ---- Phone bridge (same Wi-Fi) ---------------------------------------------------
// Phones that open the bridge page get their own WebRTC connection from this app, carrying
// the tracks this app receives from the peer. The main process only relays the two HTTP calls.
const bridgePeers = new Map(); // viewerId → Peer
let bridgeOn = false;

function updatePhoneCount() {
  const connected = [...bridgePeers.values()].filter((p) => p.pc.connectionState === 'connected').length;
  $('phone-count').hidden = !connected;
  $('phone-count').textContent = connected;
  $('phone-btn').classList.toggle('on', bridgeOn);
  $('phone-status').textContent = connected
    ? `${connected} phone${connected === 1 ? '' : 's'} watching.`
    : 'No phone connected yet.';
}

function bridgeBroadcast(msg) {
  for (const p of bridgePeers.values()) p.send(msg);
}

function stopBridge() {
  for (const p of bridgePeers.values()) p.close();
  bridgePeers.clear();
  if (bridgeOn) window.screenlink.stopBridge();
  bridgeOn = false;
  updatePhoneCount();
}

async function handleBridgeRequest(kind, data) {
  if (!inSession || !peer) throw new Error("This computer isn't in a ScreenLink session right now.");
  if (kind === 'join') {
    const viewerId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    // Same machine or same Wi-Fi: host candidates are enough, no STUN round trips.
    const bp = new Peer({ iceServers: [], sendOnly: true, videoCodec: 'H264' });
    bridgePeers.set(viewerId, bp);
    bp.addEventListener('state', async (e) => {
      if (e.detail === 'connected') {
        await bp.applyVideoParams({ maxBitrate: 8_000_000 }).catch(() => {});
      } else if (e.detail === 'failed' || e.detail === 'closed') {
        bridgePeers.delete(viewerId);
        bp.close();
      }
      updatePhoneCount();
    });
    bp.addEventListener('message', (e) => {
      if (e.detail.type === 'bye') { bridgePeers.delete(viewerId); bp.close(); updatePhoneCount(); }
    });
    bp.addEventListener('channel-open', () => {
      bp.send({ type: 'hello', device: 'desktop-bridge', version: config.version });
      bp.send(remoteShare ? { type: 'share-started', name: remoteShare.name } : { type: 'share-stopped' });
    });
    const sdp = await bp.createOffer();
    await bp.setOutgoing({ videoTrack: peer.videoTx.receiver.track, audioTrack: peer.audioTx.receiver.track });
    return { viewerId, sdp };
  }
  if (kind === 'answer') {
    const bp = bridgePeers.get(data.viewerId);
    if (!bp) throw new Error('This phone connection expired. Reload the page.');
    await bp.acceptAnswer(data.sdp);
    return { ok: true };
  }
  throw new Error(`unknown bridge request ${kind}`);
}

window.screenlink.onBridgeRequest(async ({ id, kind, data }) => {
  try {
    window.screenlink.bridgeReply({ id, result: await handleBridgeRequest(kind, data) });
  } catch (err) {
    window.screenlink.bridgeReply({ id, error: err.message });
  }
});

$('phone-btn').addEventListener('click', async () => {
  const info = await window.screenlink.startBridge();
  bridgeOn = true;
  if (!info.urls.length) {
    $('phone-url').textContent = 'No network connection found.';
    $('phone-qr').removeAttribute('src');
  } else {
    $('phone-qr').src = info.qr;
    $('phone-url').textContent = info.urls[0].url;
    $('phone-other').hidden = info.urls.length < 2;
    $('phone-urls').replaceChildren(...info.urls.slice(1).map((u) => {
      const li = document.createElement('li');
      li.textContent = `${u.url}  (${u.name})`;
      return li;
    }));
  }
  updatePhoneCount();
  $('phone-dialog').showModal();
});
$('phone-stop').addEventListener('click', () => {
  stopBridge();
  $('phone-dialog').close();
});

// ---- Playback controls ---------------------------------------------------------
function applyVolume() {
  const video = $('remote-video');
  video.volume = settings.volume / 100;
  video.muted = settings.muted;
  $('volume').value = settings.volume;
  $('mute-btn').querySelector('use').setAttribute('href', settings.muted || settings.volume === 0 ? '#i-muted' : '#i-volume');
}
$('volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  settings.muted = false;
  applyVolume();
  saveSettings();
});
$('mute-btn').addEventListener('click', () => {
  settings.muted = !settings.muted;
  applyVolume();
  saveSettings();
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen().catch(() => {});
}
$('fullscreen-btn').addEventListener('click', toggleFullscreen);
$('remote-video').addEventListener('dblclick', toggleFullscreen);

$('preview-btn').addEventListener('click', () => {
  settings.showPreview = !settings.showPreview;
  saveSettings();
  updateShareUi();
});
$('stats-btn').addEventListener('click', () => {
  settings.showStats = !settings.showStats;
  saveSettings();
  updateShareUi();
});

// ---- Stats overlay -------------------------------------------------------------
const mbps = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mb/s` : `${kbps} kb/s`);

function statLine(label, value, cls = '') {
  const row = document.createElement('div');
  if (cls) row.className = cls;
  row.textContent = label ? `${label} ${value}` : value;
  return row;
}

function renderStats(s) {
  if (config.logStats) console.log(`stats ${JSON.stringify({ ...s, audioBuffer: audioStats, phones: bridgePeers.size })}`);
  if (!settings.showStats) return;
  const box = $('stats');
  const nodes = [];
  const heading = (t) => { const h = document.createElement('h4'); h.textContent = t; nodes.push(h); };

  if (capture && s.sendVideo) {
    const v = s.sendVideo;
    heading('Sending');
    nodes.push(statLine('', `${v.width}×${v.height} · ${v.fps} fps · ${mbps(v.kbps)}`, v.fps >= 29 && v.height >= 720 ? 'ok' : 'warn'));
    nodes.push(statLine('', `${v.codec} · ${v.encoder || '…'}${v.hardware ? ' (GPU)' : ''}`));
    if (v.limitation && v.limitation !== 'none') nodes.push(statLine('limited by', v.limitation, 'warn'));
    if (s.sendAudio) nodes.push(statLine('audio', `${s.sendAudio.codec} · ${mbps(s.sendAudio.kbps)}`));
    if (audioStats) {
      nodes.push(statLine('capture buffer', `${Math.round(audioStats.bufferedMs)} ms · underruns ${audioStats.underruns}`));
    }
  }
  if (s.recvVideo && s.recvVideo.kbps > 0) {
    const v = s.recvVideo;
    heading('Receiving');
    nodes.push(statLine('', `${v.width}×${v.height} · ${v.fps} fps · ${mbps(v.kbps)}`));
    nodes.push(statLine('', [v.codec, v.decoder].filter(Boolean).join(' · ') + (v.hardware ? ' (GPU)' : '')));
    nodes.push(statLine('lost', `${v.lost} pkts · freezes ${v.freezes}`, v.freezes ? 'warn' : ''));
    if (s.recvAudio && s.recvAudio.kbps > 0) nodes.push(statLine('audio', `${s.recvAudio.codec} · ${mbps(s.recvAudio.kbps)} · level ${s.recvAudio.level}`));
  }
  if (s.net) {
    heading('Network');
    nodes.push(statLine('', `${s.net.path} · ${s.net.protocol}${s.net.relayed ? ' (relayed)' : ''}`));
    const est = s.net.availableKbps ? ` · est. up ${mbps(s.net.availableKbps)}` : '';
    nodes.push(statLine('rtt', `${s.net.rttMs ?? '?'} ms${est}`));
  }
  box.replaceChildren(...nodes);
}

// ---- Settings dialog -----------------------------------------------------------
$('set-codec').replaceChildren(...VIDEO_CODECS.map((c) => {
  const opt = document.createElement('option');
  opt.value = c;
  opt.textContent = c;
  return opt;
}));
$('settings-btn').addEventListener('click', () => {
  $('set-codec').value = settings.videoCodec;
  $('set-turn-url').value = settings.turn.url;
  $('set-turn-user').value = settings.turn.username;
  $('set-turn-pass').value = settings.turn.credential;
  $('helper-status').textContent = config.helperAvailable
    ? 'Per-app audio: audio-capture.exe found.'
    : 'Per-app audio: audio-capture.exe not found. Screen shares use all computer audio, and app shares have no audio.';
  $('settings').showModal();
});
$('settings-save').addEventListener('click', () => {
  settings.videoCodec = $('set-codec').value;
  settings.turn = {
    url: $('set-turn-url').value.trim(),
    username: $('set-turn-user').value.trim(),
    credential: $('set-turn-pass').value,
  };
  saveSettings();
  $('settings').close();
});

// ---- Dev automation (--auto=host|guest --exchange-dir=…) -------------------------
async function waitFor(check, intervalMs = 250) {
  for (;;) {
    const v = await check();
    if (v) return v;
    await sleep(intervalMs);
  }
}

async function runAutomation() {
  settings.showStats = true;
  if (config.autoMute) { settings.muted = true; applyVolume(); }
  const read = (name) => window.screenlink.devRead(name);
  const manual = !!config.autoManual;
  if (config.auto === 'host' && manual) {
    $('manual-create').click();
    const invite = await waitFor(() => $('invite-out').value);
    await window.screenlink.devWrite('invite.sdp', peer.pc.localDescription.sdp);
    await window.screenlink.devWrite('invite.txt', invite);
    console.log(`auto: manual invite written (${invite.length} chars)`);
    $('answer-in').value = await waitFor(() => read('answer.txt'));
    if (config.autoDelayMs) await sleep(Number(config.autoDelayMs));
    $('connect').click();
  } else if (config.auto === 'guest' && manual) {
    $('join-code').value = await waitFor(() => read('invite.txt'));
    $('join').click();
    const answer = await waitFor(() => $('answer-out').value);
    await window.screenlink.devWrite('answer.sdp', peer.pc.localDescription.sdp);
    await window.screenlink.devWrite('answer.txt', answer);
    console.log(`auto: manual answer written (${answer.length} chars)`);
  } else if (config.auto === 'host') {
    const started = Date.now();
    $('create-invite').click();
    const code = await waitFor(() => inviteCode);
    await window.screenlink.devWrite('invite.txt', code);
    console.log(`auto: invite ${code} ready after ${Date.now() - started} ms (link ${inviteLink(code)})`);
  } else if (config.auto === 'guest') {
    const code = await waitFor(() => read('invite.txt'));
    const started = Date.now();
    $('join-code').value = code;
    $('join').click();
    await waitFor(() => inSession);
    console.log(`auto: joined ${code} after ${Date.now() - started} ms`);
  }
  if (config.autoOpen === 'picker' || config.autoOpen === 'picker-apps') {
    await waitFor(() => inSession);
    $('share-btn').click();
    if (config.autoOpen === 'picker-apps') {
      document.querySelector('[data-tab="window"]').click();
      const card = await waitFor(() => document.querySelector('#source-grid .source-card'));
      card.click();
    }
  }
  if (config.autoOpen === 'phone') {
    await waitFor(() => inSession);
    $('phone-btn').click();
    const url = await waitFor(() => $('phone-url').textContent);
    console.log(`auto: phone bridge at ${url}`);
  }
  if (config.autoShare) {
    await waitFor(() => inSession);
    await sleep(500);
    await autoShare(config.autoShare, config.autoPreset || settings.presetKey);
  }
  // --auto-script="wait:5,stop,share:screen,preset:720p30,disconnect"
  if (config.autoScript) {
    await waitFor(() => inSession);
    for (const step of String(config.autoScript).split(',')) {
      const [cmd, arg] = step.split(':');
      console.log(`auto: step ${step}`);
      if (cmd === 'wait') await sleep(Number(arg) * 1000);
      else if (cmd === 'share') await autoShare(arg, config.autoPreset || settings.presetKey);
      else if (cmd === 'stop') await stopShare();
      else if (cmd === 'preset') { $('quality-select').value = arg; $('quality-select').dispatchEvent(new Event('change')); }
      else if (cmd === 'disconnect') $('disconnect-btn').click();
      else if (cmd === 'focus' || cmd === 'blur') window.dispatchEvent(new Event(cmd));
      else if (cmd === 'preview-state') {
        const v = $('local-video');
        console.log(`auto: preview ${$('self-preview').classList.contains('paused') ? 'paused' : 'live'}, rendering=${!!v.srcObject && !v.paused}`);
      }
    }
  }
}

async function autoShare(wanted, presetKey) {
  const sources = await window.screenlink.listSources();
  const needle = String(wanted).toLowerCase();
  const source = needle === 'screen'
    ? sources.find((s) => s.kind === 'screen')
    : sources.find((s) => s.kind === 'window' && s.name.toLowerCase().includes(needle));
  if (!source) return console.log(`auto: no source matching "${wanted}"`);
  console.log(`auto: sharing ${source.id} "${source.name}"`);
  await beginShare({ source, presetKey, detail: settings.detail, audio: settings.audio });
  if (capture) console.log(`auto: track settings ${JSON.stringify(capture.settings)} audio=${capture.audioMode}`);
}

// ---- Boot ----------------------------------------------------------------------
showView('connect');
resetConnect();
applyVolume();
if (config.auto) runAutomation().catch((err) => console.error(`auto: ${err.stack || err}`));
