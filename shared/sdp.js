// Session description helpers shared by the desktop app and the web viewer.

// TCP host candidates (port 9, "active") can't connect to another ScreenLink and only bloat the code.
export function stripTcpCandidates(sdp) {
  return sdp.split('\r\n').filter((l) => !(l.startsWith('a=candidate:') && / tcp /i.test(l))).join('\r\n');
}

export function waitForIceGathering(pc, timeoutMs = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  const started = performance.now();
  return new Promise((resolve) => {
    const done = () => {
      console.debug(`ice gathering: ${pc.iceGatheringState} after ${Math.round(performance.now() - started)} ms`);
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => { if (pc.iceGatheringState === 'complete') done(); };
    // Unreachable STUN servers can stall gathering; whatever was found by then is used.
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

// ---- SDP munging -----------------------------------------------------------
// WebRTC configures each side from a different description:
//   - the Opus *encoder* and the bandwidth estimate read the REMOTE description
//   - the Opus *decoder* reads the LOCAL description, and without stereo=1 it mixes
//     stereo packets down to mono
// So stereo is added to both; the start bitrate only matters on the remote side.

function addFmtpParams(sdp, payloadType, params) {
  const lines = sdp.split('\r\n');
  const prefix = `a=fmtp:${payloadType} `;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  if (idx === -1) {
    const rtpmap = lines.findIndex((l) => l.startsWith(`a=rtpmap:${payloadType} `));
    if (rtpmap === -1) return sdp;
    lines.splice(rtpmap + 1, 0, prefix + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(';'));
    return lines.join('\r\n');
  }
  const existing = new Map(lines[idx].slice(prefix.length).split(';').filter(Boolean).map((kv) => {
    const eq = kv.indexOf('=');
    return [kv.slice(0, eq).trim(), kv.slice(eq + 1)];
  }));
  for (const [k, v] of Object.entries(params)) existing.set(k, String(v));
  lines[idx] = prefix + [...existing].map(([k, v]) => `${k}=${v}`).join(';');
  return lines.join('\r\n');
}

function payloadTypesFor(sdp, codecPattern) {
  const re = new RegExp(`^a=rtpmap:(\\d+) ${codecPattern}/`, 'gim');
  return [...sdp.matchAll(re)].map((m) => m[1]);
}

const OPUS_STEREO = { stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: 256000, useinbandfec: 1 };

export function mungeLocalSdp(sdp) {
  let out = sdp;
  for (const pt of payloadTypesFor(out, 'opus')) out = addFmtpParams(out, pt, OPUS_STEREO);
  return out;
}

export function mungeRemoteSdp(sdp) {
  let out = mungeLocalSdp(sdp);
  // Start the video bandwidth estimate high instead of ramping up from ~300 kbps.
  for (const pt of payloadTypesFor(out, '(?:H264|VP8|VP9|AV1)')) {
    out = addFmtpParams(out, pt, { 'x-google-start-bitrate': 3000 });
  }
  return out;
}
