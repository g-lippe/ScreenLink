// Polls RTCPeerConnection.getStats() once a second and condenses it into what matters for a
// screen share: resolution, fps, bitrate, codec, hardware vs software encode, and the network path.

export class StatsMonitor {
  constructor(pc, onSample, intervalMs = 1000) {
    this.pc = pc;
    this.onSample = onSample;
    this.prev = new Map();
    this.timer = setInterval(() => this.sample().catch(() => {}), intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  #kbps(id, bytes, timestamp) {
    const prev = this.prev.get(id);
    this.prev.set(id, { bytes, timestamp });
    if (!prev || timestamp <= prev.timestamp) return 0;
    return Math.round(((bytes - prev.bytes) * 8) / (timestamp - prev.timestamp)); // bytes/ms → kbps
  }

  async sample() {
    const report = await this.pc.getStats();
    const byId = new Map();
    report.forEach((s) => byId.set(s.id, s));
    const codecName = (id) => {
      const c = id && byId.get(id);
      if (!c) return '';
      const name = c.mimeType.split('/')[1];
      return c.channels === 2 ? `${name} stereo` : name;
    };

    const out = { sendVideo: null, recvVideo: null, sendAudio: null, recvAudio: null, net: null };
    let captureFps = null;
    report.forEach((s) => {
      if (s.type === 'media-source' && s.kind === 'video') captureFps = Math.round(s.framesPerSecond || 0);
      if (s.type === 'outbound-rtp' && s.kind === 'video') {
        out.sendVideo = {
          width: s.frameWidth || 0,
          height: s.frameHeight || 0,
          fps: Math.round(s.framesPerSecond || 0),
          kbps: this.#kbps(s.id, s.bytesSent, s.timestamp),
          codec: codecName(s.codecId),
          encoder: s.encoderImplementation || '',
          hardware: s.powerEfficientEncoder,
          limitation: s.qualityLimitationReason,
        };
      } else if (s.type === 'inbound-rtp' && s.kind === 'video') {
        out.recvVideo = {
          width: s.frameWidth || 0,
          height: s.frameHeight || 0,
          fps: Math.round(s.framesPerSecond || 0),
          kbps: this.#kbps(s.id, s.bytesReceived, s.timestamp),
          codec: codecName(s.codecId),
          decoder: s.decoderImplementation || '',
          hardware: s.powerEfficientDecoder,
          lost: s.packetsLost || 0,
          freezes: s.freezeCount || 0,
        };
      } else if (s.type === 'outbound-rtp' && s.kind === 'audio') {
        out.sendAudio = { kbps: this.#kbps(s.id, s.bytesSent, s.timestamp), codec: codecName(s.codecId) };
      } else if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        out.recvAudio = {
          kbps: this.#kbps(s.id, s.bytesReceived, s.timestamp),
          codec: codecName(s.codecId),
          lost: s.packetsLost || 0,
          jitterMs: Math.round((s.jitter || 0) * 1000),
          level: Number((s.audioLevel || 0).toFixed(3)),
        };
      } else if (s.type === 'transport' && s.selectedCandidatePairId) {
        const pair = byId.get(s.selectedCandidatePairId);
        if (pair) {
          const local = byId.get(pair.localCandidateId) || {};
          const remote = byId.get(pair.remoteCandidateId) || {};
          out.net = {
            rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
            availableKbps: pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate / 1000) : null,
            path: `${local.candidateType || '?'} ⇄ ${remote.candidateType || '?'}`,
            protocol: local.protocol || '',
            relayed: local.candidateType === 'relay' || remote.candidateType === 'relay',
          };
        }
      }
    });
    if (out.sendVideo) out.sendVideo.captureFps = captureFps;
    this.onSample(out);
    return out;
  }
}
