// Dev-only: reads float32 stereo 48 kHz PCM on stdin and prints, once per second, the RMS of
// each channel plus the strength of the test pattern's tones (440 Hz left, 660 Hz right) in
// each channel. Stereo that survived the trip shows 440 only on L and 660 only on R.
//   audio-capture.exe --include-pid 1234 | node dev/pcm-level.js
const RATE = 48000;
const TONES = [440, 660];

// Goertzel algorithm: magnitude of one frequency over a block of samples.
function goertzel(samples, freq) {
  const k = 2 * Math.cos((2 * Math.PI * freq) / RATE);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / (samples.length / 2);
}

let carry = Buffer.alloc(0);
const left = new Float32Array(RATE);
const right = new Float32Array(RATE);
let n = 0;
let total = 0;

process.stdout.on('error', () => process.exit(0)); // e.g. piped into `head`

process.stdin.on('data', (chunk) => {
  const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
  const usable = data.length - (data.length % 8);
  for (let i = 0; i < usable; i += 8) {
    left[n] = data.readFloatLE(i);
    right[n] = data.readFloatLE(i + 4);
    n++;
    if (n === RATE) {
      const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
      const tones = (a) => TONES.map((f) => `${f}Hz=${goertzel(a, f).toFixed(4)}`).join(' ');
      console.log(`L rms=${rms(left).toFixed(4)} ${tones(left)} | R rms=${rms(right).toFixed(4)} ${tones(right)}`);
      n = 0;
    }
  }
  total += usable / 8;
  carry = data.subarray(usable);
});
process.stdin.on('end', () => console.log(`end, frames=${total}`));
