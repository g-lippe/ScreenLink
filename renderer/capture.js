export const PRESETS = {
  '720p30':   { label: '720p · 30 fps',    width: 1280, height: 720,  fps: 30, bitrate: 4_000_000 },
  '1080p30':  { label: '1080p · 30 fps',   width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  '1080p60':  { label: '1080p · 60 fps',   width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 },
  'source60': { label: 'Source · 60 fps',  width: null, height: null, fps: 60, bitrate: 15_000_000 },
};
export const DEFAULT_PRESET = '1080p30';

function videoConstraints(preset) {
  const c = { frameRate: { ideal: preset.fps, max: preset.fps } };
  if (preset.width) {
    c.width = { max: preset.width };
    c.height = { max: preset.height };
  }
  return c;
}

function waitForAudioPort() {
  let cancel;
  const promise = new Promise((resolve) => {
    const onMessage = (e) => {
      if (e.source !== window || !e.data || e.data.type !== 'screenlink-audio-port') return;
      window.removeEventListener('message', onMessage);
      resolve(e.ports[0]);
    };
    window.addEventListener('message', onMessage);
    cancel = () => window.removeEventListener('message', onMessage);
  });
  return { promise, cancel };
}

/**
 * A local share: one video track from the chosen screen/window plus an optional audio track.
 *   - native helper available → app-only audio (window) or all-but-ScreenLink audio (screen)
 *   - helper missing          → Chromium system loopback for screens, no audio for windows
 *
 * Events: 'ended' (source closed), 'audio-stats' {detail}, 'audio-ended'
 */
export class Capture extends EventTarget {
  constructor(source, { presetKey, detail, audio, audioScope = 'app', helperAvailable }) {
    super();
    this.source = source;
    this.audioScope = audioScope; // window shares: 'app' (just that app) or 'system' (all but ScreenLink)
    this.presetKey = presetKey;
    this.detail = detail;
    this.wantAudio = audio;
    this.helperAvailable = helperAvailable;
    this.videoTrack = null;
    this.audioTrack = null;
    this.audioMode = 'none'; // 'app' | 'system-except-self' | 'system' | 'none'
    this.ctx = null;
  }

  get preset() { return PRESETS[this.presetKey]; }

  async start() {
    const useHelper = this.wantAudio && this.helperAvailable;
    const useLoopback = this.wantAudio && !this.helperAvailable && this.source.kind === 'screen';

    await window.screenlink.prepareCapture(this.source.id, useLoopback);
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints(this.preset),
        audio: useLoopback,
      });
    } catch (err) {
      if (!useLoopback) throw err;
      // System loopback can fail (e.g. no default output device); still share the video.
      console.warn(`loopback audio failed (${err.name}: ${err.message}); retrying video only`);
      this.audioError = err.message;
      await window.screenlink.prepareCapture(this.source.id, false);
      stream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints(this.preset), audio: false });
    }

    this.videoTrack = stream.getVideoTracks()[0];
    this.videoTrack.contentHint = this.detail ? 'detail' : 'motion';
    this.videoTrack.addEventListener('ended', () => this.dispatchEvent(new Event('ended')));

    if (useLoopback && stream.getAudioTracks().length) {
      this.audioTrack = stream.getAudioTracks()[0];
      this.audioTrack.contentHint = 'music';
      this.audioMode = 'system';
    }
    if (useHelper) {
      try {
        this.audioTrack = await this.#startHelperAudio();
      } catch (err) {
        console.error('native audio capture failed', err);
        this.audioTrack = null;
      }
    }
    return this;
  }

  async #startHelperAudio() {
    const port = waitForAudioPort();
    const result = await window.screenlink.startAudio(this.source.id, this.audioScope);
    if (!result.ok) {
      port.cancel();
      return null;
    }
    const sourcePort = await port.promise;

    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('pcm-worklet.js');
    const node = new AudioWorkletNode(this.ctx, 'pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e) => {
      if (e.data.type === 'stats') this.dispatchEvent(new CustomEvent('audio-stats', { detail: e.data }));
      if (e.data.type === 'ended') this.dispatchEvent(new CustomEvent('audio-ended', { detail: e.data }));
    };
    node.port.postMessage({ source: sourcePort }, [sourcePort]);

    const dest = this.ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    node.connect(dest);
    await this.ctx.resume();

    const track = dest.stream.getAudioTracks()[0];
    track.contentHint = 'music';
    this.audioMode = result.mode;
    return track;
  }

  async setPreset(presetKey) {
    this.presetKey = presetKey;
    if (this.videoTrack) await this.videoTrack.applyConstraints(videoConstraints(this.preset));
  }

  setDetail(detail) {
    this.detail = detail;
    if (this.videoTrack) this.videoTrack.contentHint = detail ? 'detail' : 'motion';
  }

  get settings() {
    return this.videoTrack ? this.videoTrack.getSettings() : {};
  }

  stop() {
    if (this.videoTrack) this.videoTrack.stop();
    if (this.audioTrack) this.audioTrack.stop();
    if (this.ctx) this.ctx.close();
    if (this.audioMode === 'app' || this.audioMode === 'system-except-self') window.screenlink.stopAudio();
    this.videoTrack = null;
    this.audioTrack = null;
    this.ctx = null;
  }
}
