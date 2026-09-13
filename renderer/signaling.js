// Serverless signaling: a session description (with every ICE candidate baked in) is
// compressed by the main process (deflate + SDP dictionary) into a code people paste to each other.

const PREFIX = 'SL2-';

// TCP host candidates (port 9, "active") can't connect to another ScreenLink and only bloat the code.
function stripTcpCandidates(sdp) {
  return sdp.split('\r\n').filter((l) => !(l.startsWith('a=candidate:') && / tcp /i.test(l))).join('\r\n');
}

export async function encodeCode(description) {
  const json = JSON.stringify({ t: description.type, s: stripTcpCandidates(description.sdp) });
  return PREFIX + await window.screenlink.packCode(json);
}

export async function decodeCode(code, expectedType) {
  const clean = String(code).replace(/\s+/g, '');
  if (!clean.startsWith(PREFIX)) {
    throw new Error(/^SL\d-/.test(clean)
      ? 'That code is from a different ScreenLink version. Both of you need the same version.'
      : "That doesn't look like a ScreenLink code.");
  }
  let parsed;
  try {
    parsed = JSON.parse(await window.screenlink.unpackCode(clean.slice(PREFIX.length)));
  } catch {
    throw new Error('The code is incomplete or corrupted. Copy the whole thing and try again.');
  }
  if (parsed.t !== expectedType) {
    throw new Error(expectedType === 'offer'
      ? 'This is an answer code. Paste it on the computer that created the invite.'
      : 'This is an invite code. Paste the answer code your peer sent back.');
  }
  return { type: parsed.t, sdp: parsed.s };
}

export function waitForIceGathering(pc, timeoutMs = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
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
