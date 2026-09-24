import { waitForIceGathering, mungeLocalSdp, mungeRemoteSdp } from './sdp.js';

export const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export const VIDEO_CODECS = ['H264', 'AV1', 'VP9', 'VP8'];

export function iceServersWith(turn) {
  const servers = [...STUN_SERVERS];
  if (turn && turn.url) servers.push({ urls: turn.url, username: turn.username, credential: turn.credential });
  return servers;
}

// Offers only what's needed: the preferred video codec (for H.264, only packetization-mode=1,
// which hardware encoders use), VP8 as a universal fallback, RTX for retransmissions, and Opus.
// Every extra codec adds ~6 SDP lines, and manual codes carry the whole SDP.
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
  if (!chosen.length) return;
  try { transceiver.setCodecPreferences(chosen); } catch (err) { console.warn('setCodecPreferences failed', err); }
}

/**
 * One peer-to-peer session. Each side owns exactly one video and one audio transceiver,
 * negotiated once. Sharing only swaps tracks with replaceTrack(), so the connection never
 * has to be renegotiated, and both people can share at the same time.
 *
 * Directions: normally sendrecv. `receiveOnly` is for the phone viewer, which can't share;
 * `sendOnly` is for the desktop's LAN bridge, which forwards what it receives to a phone.
 *
 * Events: 'state' {detail: connectionState}, 'message' {detail: object}, 'channel-open', 'closed'
 */
export class Peer extends EventTarget {
  constructor({ iceServers = STUN_SERVERS, videoCodec = 'H264', receiveOnly = false, sendOnly = false, debugAudio = false } = {}) {
    super();
    this.videoCodec = videoCodec;
    this.direction = receiveOnly ? 'recvonly' : sendOnly ? 'sendonly' : 'sendrecv';
    this.debugAudio = debugAudio;
    const config = { iceServers, bundlePolicy: 'max-bundle' };
    if (debugAudio) config.encodedInsertableStreams = true;
    this.pc = new RTCPeerConnection(config);
    this.videoTx = null;
    this.audioTx = null;
    this.dc = null;
    this.closed = false;

    this.pc.addEventListener('connectionstatechange', () => {
      this.dispatchEvent(new CustomEvent('state', { detail: this.pc.connectionState }));
    });
  }

  /** Offerer: returns the offer SDP with every ICE candidate included. */
  async createOffer() {
    this.videoTx = this.pc.addTransceiver('video', { direction: this.direction });
    this.audioTx = this.pc.addTransceiver('audio', { direction: this.direction });
    // The offerer picks the codecs; the answer just follows the offer's order.
    preferCodecs(this.videoTx, 'video', this.videoCodec);
    preferCodecs(this.audioTx, 'audio', 'opus');
    this.#afterTransceivers();
    await this.#setLocal(await this.pc.createOffer());
    await waitForIceGathering(this.pc);
    return this.pc.localDescription.sdp;
  }

  /** Answerer: applies the offer and returns the answer SDP with every ICE candidate included. */
  async acceptOffer(sdp) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: mungeRemoteSdp(sdp) });
    for (const tx of this.pc.getTransceivers()) {
      tx.direction = this.direction;
      if (tx.receiver.track.kind === 'video') this.videoTx = tx;
      else this.audioTx = tx;
    }
    if (!this.videoTx || !this.audioTx) throw new Error('The invite is missing audio or video. Is it from ScreenLink?');
    this.#afterTransceivers();
    await this.#setLocal(await this.pc.createAnswer());
    await waitForIceGathering(this.pc);
    return this.pc.localDescription.sdp;
  }

  async acceptAnswer(sdp) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: mungeRemoteSdp(sdp) });
  }

  async #setLocal(description) {
    try {
      await this.pc.setLocalDescription({ type: description.type, sdp: mungeLocalSdp(description.sdp) });
    } catch (err) {
      // If a browser rejects local munging, fall back to mono playback rather than failing.
      console.warn(`local SDP munge rejected (${err.message}); audio will play back in mono`);
      await this.pc.setLocalDescription(description);
    }
  }

  #afterTransceivers() {
    this.#openDataChannel();
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

  /** Apply a quality preset to the video sender (bitrate, fps, degradation behavior). */
  async applyVideoParams({ maxBitrate, maxFramerate, detail }) {
    const sender = this.videoTx.sender;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    const enc = params.encodings[0];
    enc.maxBitrate = maxBitrate;
    if (maxFramerate) enc.maxFramerate = maxFramerate;
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
