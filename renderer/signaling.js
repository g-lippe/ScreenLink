// Manual connection codes, the fallback when the public relays can't be reached: a session
// description (with every ICE candidate baked in) is compressed by the main process (deflate +
// SDP dictionary) into a code, and the two people paste codes to each other.

import { stripTcpCandidates } from './shared/sdp.js';

const PREFIX = 'SL2-';

export async function encodeCode(type, sdp) {
  const json = JSON.stringify({ t: type, s: stripTcpCandidates(sdp) });
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
  return parsed.s;
}
