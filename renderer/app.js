import { Peer, VIDEO_CODECS } from './peer.js';
import { Capture, PRESETS, DEFAULT_PRESET } from './capture.js';
import { StatsMonitor } from './stats.js';
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
let capture = null;
let stats = null;
let inSession = false;
let recoveryTimer = null;
let audioStats = null;
let remoteShare = null;     // { name } while the peer is sharing
let peerStopped = false;

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

function showConnectStep(step) {
  $('connect-home').hidden = step !== 'home';
  $('host-flow').hidden = step !== 'host';
  $('guest-flow').hidden = step !== 'guest';
}

function resetConnect(message = '', kind = '') {
  if (peer && !inSession) peer.close();
  peer = null;
  ['join-code', 'invite-out', 'answer-in', 'answer-out'].forEach((id) => { $(id).value = ''; });
  setBusy(false);
  showConnectStep('home');
  setStatus(message, kind);
}

function setBusy(busy) {
  ['create-invite', 'join', 'connect'].forEach((id) => { $(id).disabled = busy; });
}

function newPeer() {
  const p = new Peer({ turn: settings.turn, videoCodec: settings.videoCodec, debugAudio: !!config.debugAudio });
  p.addEventListener('state', (e) => onConnectionState(p, e.detail));
  p.addEventListener('message', (e) => onPeerMessage(p, e.detail));
  return p;
}

$('create-invite').addEventListener('click', async () => {
  setBusy(true);
  setStatus('Creating invite…', 'busy');
  try {
    peer = newPeer();
    $('invite-out').value = await peer.createInvite();
    showConnectStep('host');
    setStatus('');
  } catch (err) {
    resetConnect(`Couldn't create an invite: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
});

$('join').addEventListener('click', async () => {
  const code = $('join-code').value.trim();
  if (!code) return setStatus('Paste an invite code first.', 'error');
  setBusy(true);
  setStatus('Reading invite…', 'busy');
  const p = newPeer();
  try {
    const answer = await p.acceptInvite(code);
    peer = p;
    $('answer-out').value = answer;
    showConnectStep('guest');
    setStatus('Waiting for your peer to paste the answer…', 'busy');
  } catch (err) {
    p.close();
    setStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
});

$('connect').addEventListener('click', async () => {
  const code = $('answer-in').value.trim();
  if (!code) return setStatus('Paste the answer code first.', 'error');
  setBusy(true);
  try {
    await peer.acceptAnswer(code);
    setStatus('Connecting…', 'busy');
  } catch (err) {
    setBusy(false);
    setStatus(err.message, 'error');
  }
});

document.querySelectorAll('.cancel').forEach((b) => b.addEventListener('click', () => resetConnect()));

document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  const text = $(b.dataset.copy).value;
  await navigator.clipboard.writeText(text);
  b.textContent = 'Copied';
  b.classList.add('done');
  setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1600);
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
    if (inSession) endSession('Connection lost.');
    else resetConnect("Couldn't establish a direct connection. Make a new invite and paste codes promptly. If it keeps failing, see the README's NAT section.", 'error');
  }
}

function onPeerMessage(p, msg) {
  if (p !== peer) return;
  console.log(`peer message: ${JSON.stringify(msg)}`);
  switch (msg.type) {
    case 'share-started':
      remoteShare = { name: msg.name || '' };
      peerStopped = false;
      $('remote-video').play().catch(() => {});
      updateStage();
      break;
    case 'share-stopped':
      remoteShare = null;
      peerStopped = true;
      updateStage();
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
window.addEventListener('beforeunload', () => { if (peer) peer.close(); });

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
  $('local-video').srcObject = new MediaStream([capture.videoTrack]);
  updateShareUi();
}

async function stopShare(notify = true) {
  if (!capture) return;
  const old = capture;
  capture = null;
  audioStats = null;
  if (peer) await peer.setOutgoing({});
  old.stop();
  $('local-video').srcObject = null;
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
  $('self-preview').hidden = !sharing || !settings.showPreview;
  $('preview-btn').classList.toggle('on', settings.showPreview);
  $('stats-btn').classList.toggle('on', settings.showStats);
  $('stats').hidden = !settings.showStats;
  $('quality-select').value = settings.presetKey;
  $('detail-toggle').checked = settings.detail;
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
  if (config.logStats) console.log(`stats ${JSON.stringify({ ...s, audioBuffer: audioStats })}`);
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
  if (config.auto === 'host') {
    $('create-invite').click();
    const invite = await waitFor(() => $('invite-out').value);
    await window.screenlink.devWrite('invite.sdp', peer.pc.localDescription.sdp);
    await window.screenlink.devWrite('invite.txt', invite);
    console.log(`auto: invite written (${invite.length} chars)`);
    $('answer-in').value = await waitFor(() => read('answer.txt'));
    if (config.autoDelayMs) await sleep(Number(config.autoDelayMs));
    $('connect').click();
  } else if (config.auto === 'guest') {
    $('join-code').value = await waitFor(() => read('invite.txt'));
    $('join').click();
    const answer = await waitFor(() => $('answer-out').value);
    await window.screenlink.devWrite('answer.sdp', peer.pc.localDescription.sdp);
    await window.screenlink.devWrite('answer.txt', answer);
    console.log(`auto: answer written (${answer.length} chars)`);
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
