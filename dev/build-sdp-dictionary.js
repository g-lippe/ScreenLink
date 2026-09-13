// Dev-only: rebuilds sdp-dictionary.txt from a real offer + answer written by an --auto run
// (invite.sdp / answer.sdp in the exchange dir). Personal and per-session values (IP addresses,
// ICE credentials, fingerprints, SSRCs, stream ids) are replaced with neutral placeholders.
//   node dev/build-sdp-dictionary.js <exchange-dir>
// Changing the dictionary changes the code format: bump PREFIX in renderer/signaling.js.
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) throw new Error('usage: node dev/build-sdp-dictionary.js <exchange-dir>');

function neutralize(sdp) {
  const out = [];
  let candidatesAdded = false;
  for (const line of sdp.split('\r\n')) {
    if (line.startsWith('a=candidate:')) {
      if (!candidatesAdded) {
        out.push('a=candidate:1000000000 1 udp 2122260223 192.168.0.2 50000 typ host generation 0 network-id 1');
        out.push('a=candidate:2000000000 1 udp 1686052607 203.0.113.9 50000 typ srflx raddr 192.168.0.2 rport 50000 generation 0 network-id 1');
        candidatesAdded = true;
      }
      continue;
    }
    out.push(line
      .replace(/^o=- \d+/, 'o=- 1000000000000000000')
      .replace(/^(c=IN IP4 ).*/, '$10.0.0.0')
      .replace(/^(m=\w+ )\d+/, '$19')
      .replace(/^(a=ice-ufrag:).*/, '$1AAAA')
      .replace(/^(a=ice-pwd:).*/, '$1AAAAAAAAAAAAAAAAAAAAAAA')
      .replace(/^(a=fingerprint:sha-256 ).*/, '$1')
      .replace(/^(a=ssrc(?:-group:FID)?:?)[\d ]+/, '$11000000000 ')
      .replace(/cname:\S+/, 'cname:AAAAAAAAAAAAAAAA')
      .replace(/\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?/gi, '-'));
  }
  return out.join('\r\n');
}

const offer = neutralize(fs.readFileSync(path.join(dir, 'invite.sdp'), 'utf8'));
const answer = neutralize(fs.readFileSync(path.join(dir, 'answer.sdp'), 'utf8'));
// zlib matches nearer dictionary bytes more cheaply, so the most common text (the offer) goes last.
// Codes are JSON, so the dictionary is too (CRLFs appear as escaped \r\n).
const dictionary = JSON.stringify({ t: 'answer', s: answer }) + JSON.stringify({ t: 'offer', s: offer });
fs.writeFileSync(path.join(__dirname, '..', 'sdp-dictionary.txt'), dictionary);
console.log(`wrote sdp-dictionary.txt (${dictionary.length} bytes)`);
