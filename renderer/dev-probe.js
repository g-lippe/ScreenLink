// Dev-only (--debug-audio): logs the 440/660 Hz tone strength per channel of an audio track, to find
// where the test pattern's stereo (440 Hz left, 660 Hz right) gets mixed down.
const RATE = 48000;

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

export function probeTrack(track, label) {
  const ctx = new AudioContext({ sampleRate: RATE });
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const split = ctx.createChannelSplitter(2);
  const analysers = [0, 1].map((ch) => {
    const a = ctx.createAnalyser();
    a.fftSize = 32768;
    split.connect(a, ch);
    return a;
  });
  source.connect(split);
  const buf = new Float32Array(32768);
  const timer = setInterval(() => {
    const parts = analysers.map((a, ch) => {
      a.getFloatTimeDomainData(buf);
      return `${ch ? 'R' : 'L'} 440=${goertzel(buf, 440).toFixed(4)} 660=${goertzel(buf, 660).toFixed(4)}`;
    });
    console.log(`probe ${label}: channels=${source.channelCount} ${parts.join(' | ')}`);
  }, 3000);
  return () => { clearInterval(timer); ctx.close(); };
}
