import { encodeCode, decodeCode, waitForIceGathering, mungeLocalSdp, mungeRemoteSdp } from './signaling.js';

const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export const VIDEO_CODECS = ['H264', 'AV1', 'VP9', 'VP8'];

// Offers only what's needed: the preferred video codec (for H.264, only packetization-mode=1,
// which hardware encoders use), VP8 as a universal fallback, RTX for retransmissions, and Opus.
// Every extra codec adds ~6 SDP lines, and the SDP ends up in a code people paste into chat.
function preferCodecs(transceiver, kind, preferredName) {
  const caps = RTCRtpReceiver.getCapabilities(kind);
  if (!caps || !transceiver.setCodecPreferences) return;
  const is = (c, name) => c.mimeType.toLowerCase() === `${kind}/${name}`.toLowerCase();
  let chosen;
  if (kind === 'audio') {
    chosen = caps.codecs.filter((c) => is(c, 'opus'));
  } else {
    const family = (name) => caps.codecs.filter((c) => is(c, name)
      && (name !== 'H264' || /packetization-mode=1/.test(c.sdpFmtpLine || '')));
    chosen = [...family(preferredName), ...(preferredName === 'VP8' ? [] : family('VP8'))];
    chosen.push(...caps.codecs.filter((c) => is(c, 'rtx')));
  }
  try { transceiver.setCodecPreferences(chosen); } catch (err) { console.warn('setCodecPreferences failed', err); }
}

/**
 * One peer-to-peer session. Both sides own exactly one video and one audio transceiver,
 * both sendrecv, negotiated once. Sharing only swaps tracks with replaceTrack(), so the
 * pasted codes are never needed again, and both people can share at the same time.
 *
 * Events: 'state' {detail: connectionState}, 'message' {detail: object}, 'closed'
 */
export class Peer extends EventTarget {
  constructor({ turn, videoCodec = 'H264', debugAudio = false } = {}) {
    super();
    const iceServers = [...STUN_SERVERS];
    if (turn && turn.url) iceServers.push({ urls: turn.url, username: turn.username, credential: turn.credential });
    this.videoCodec = videoCodec;
    this.debugAudio = debugAudio;
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', encodedInsertableStreams: debugAudio });
    this.videoTx = null;
    this.audioTx = null;
    this.dc = null;
    this.closed = false;

    this.pc.addEventListener('connectionstatechange', () => {
      this.dispatchEvent(new CustomEvent('state', { detail: this.pc.connectionState }));
    });
  }

  // ---- Host --------------------------------------------------------------
  async createInvite() {
    this.videoTx = this.pc.addTransceiver('video', { direction: 'sendrecv' });
    this.audioTx = this.pc.addTransceiver('audio', { direction: 'sendrecv' });
    // The host picks the codecs; the guest's answer just follows the offer's order.
    preferCodecs(this.videoTx, 'video', this.videoCodec);
    preferCodecs(this.audioTx, 'audio', 'opus');
    this.#setupTransceivers();
    this.#openDataChannel();
    await this.#setLocal(await this.pc.createOffer());
    await waitForIceGathering(this.pc);
    return encodeCode(this.pc.localDescription);
  }

  async acceptAnswer(code) {
    const answer = await decodeCode(code, 'answer');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: mungeRemoteSdp(answer.sdp) });
  }

  // ---- Guest -------------------------------------------------------------
  async acceptInvite(code) {
    const offer = await decodeCode(code, 'offer');
    await this.pc.setRemoteDescription({ type: 'offer', sdp: mungeRemoteSdp(offer.sdp) });
    for (const tx of this.pc.getTransceivers()) {
      tx.direction = 'sendrecv';
      if (tx.receiver.track.kind === 'video') this.videoTx = tx;
      else this.audioTx = tx;
    }
    if (!this.videoTx || !this.audioTx) throw new Error('The invite is missing audio or video. Is it from ScreenLink?');
    this.#setupTransceivers();
    this.#openDataChannel();
    await this.#setLocal(await this.pc.createAnswer());
    await waitForIceGathering(this.pc);
    return encodeCode(this.pc.localDescription);
  }

  // ---- Shared --------------------------------------------------------------
  async #setLocal(description) {
    try {
      await this.pc.setLocalDescription({ type: description.type, sdp: mungeLocalSdp(description.sdp) });
    } catch (err) {
      // If a future Chromium rejects local munging, fall back to mono playback rather than failing.
      console.warn(`local SDP munge rejected (${err.message}); audio will play back in mono`);
      await this.pc.setLocalDescription(description);
    }
  }

  #setupTransceivers() {
    if (this.debugAudio) this.#installOpusProbe();
  }

  // Dev-only: counts Opus packets whose TOC byte has the stereo flag set.
  #installOpusProbe() {
    const counts = { sent: [0, 0], received: [0, 0] };
    const probe = (endpoint, key) => {
      const { readable, writable } = endpoint.createEncodedStreams();
      readable.pipeThrough(new TransformStream({
        transform(frame, controller) {
          if (key && frame.data.byteLength) counts[key][(new Uint8Array(frame.data)[0] & 0x04) ? 1 : 0]++;
          controller.enqueue(frame);
        },
      })).pipeTo(writable);
    };
    probe(this.audioTx.sender, 'sent');
    probe(this.audioTx.receiver, 'received');
    probe(this.videoTx.sender, null);
    probe(this.videoTx.receiver, null);
    setInterval(() => console.log(`opus probe ${JSON.stringify(counts)} (counts are [mono, stereo])`), 3000);
  }

  #openDataChannel() {
    // Negotiated with a fixed id on both sides: no 'datachannel' event race.
    this.dc = this.pc.createDataChannel('control', { negotiated: true, id: 0, ordered: true });
    this.dc.addEventListener('open', () => this.dispatchEvent(new Event('channel-open')));
    this.dc.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    });
  }

  send(msg) {
    if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(msg));
  }

  get remoteStream() {
    if (!this._remoteStream) {
      this._remoteStream = new MediaStream([this.videoTx.receiver.track, this.audioTx.receiver.track]);
    }
    return this._remoteStream;
  }

  async setOutgoing({ videoTrack, audioTrack }) {
    await this.videoTx.sender.replaceTrack(videoTrack || null);
    await this.audioTx.sender.replaceTrack(audioTrack || null);
  }

  async setAudioTrack(audioTrack) {
    await this.audioTx.sender.replaceTrack(audioTrack || null);
  }

  /** Apply a quality preset to the video sender (bitrate, fps, degradation behavior). */
  async applyVideoParams({ maxBitrate, maxFramerate, detail }) {
    const sender = this.videoTx.sender;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    const enc = params.encodings[0];
    enc.maxBitrate = maxBitrate;
    enc.maxFramerate = maxFramerate;
    enc.scaleResolutionDownBy = 1;
    enc.priority = 'high';
    enc.networkPriority = 'high';
    params.degradationPreference = detail ? 'maintain-resolution' : 'maintain-framerate';
    try {
      await sender.setParameters(params);
    } catch (err) {
      // Older builds reject degradationPreference; contentHint on the track covers it.
      delete params.degradationPreference;
      await sender.setParameters(params);
    }

    const audioSender = this.audioTx.sender;
    const aParams = audioSender.getParameters();
    if (aParams.encodings && aParams.encodings.length) {
      aParams.encodings[0].maxBitrate = 256000;
      aParams.encodings[0].priority = 'high';
      try { await audioSender.setParameters(aParams); } catch (err) { console.warn('audio setParameters failed', err); }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.send({ type: 'bye' }); } catch { /* channel gone */ }
    // Give the bye a moment to flush before tearing the connection down.
    setTimeout(() => this.pc.close(), 150);
    this.dispatchEvent(new Event('closed'));
  }
}
