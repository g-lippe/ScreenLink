// Plays float32 stereo PCM from audio-capture.exe into the Web Audio graph.
// Chunks arrive on a MessagePort straight from the main process, so they never touch the
// renderer's main thread. A ring buffer absorbs jitter between the capture clock and the
// AudioContext clock: prime to ~40ms. The two clocks drift apart slowly (measured ~4ms/min), so
// past ~100ms one sample frame per render quantum is skipped (inaudible), and past ~200ms
// the buffer jumps straight back to the target.

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const CAPACITY = SAMPLE_RATE * CHANNELS;               // 1s of interleaved samples
const TARGET = Math.round(0.04 * SAMPLE_RATE) * CHANNELS;
const HIGH = Math.round(0.1 * SAMPLE_RATE) * CHANNELS;
const MAX = Math.round(0.2 * SAMPLE_RATE) * CHANNELS;

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(CAPACITY);
    this.read = 0;
    this.write = 0;
    this.size = 0;
    this.primed = false;
    this.stats = { underruns: 0, dropped: 0, peak: 0 };
    this.lastReport = 0;
    this.ended = false;

    this.port.onmessage = (e) => {
      if (e.data && e.data.source) {
        const source = e.data.source;
        source.onmessage = (m) => this.onData(m.data);
        source.start();
      }
    };
  }

  onData(data) {
    if (!(data instanceof ArrayBuffer)) {
      if (data && data.type === 'ended') {
        this.ended = true;
        this.port.postMessage({ type: 'ended', code: data.code });
      }
      return;
    }
    const samples = new Float32Array(data);
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.write] = samples[i];
      this.write = (this.write + 1) % CAPACITY;
    }
    this.size += samples.length;
    if (this.size > MAX) {
      const drop = this.size - TARGET;
      this.read = (this.read + drop) % CAPACITY;
      this.size -= drop;
      this.stats.dropped += drop / CHANNELS;
    }
    if (!this.primed && this.size >= TARGET) this.primed = true;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];
    const frames = left.length;

    if (this.primed && this.size >= frames * CHANNELS) {
      if (this.size > HIGH + frames * CHANNELS) {
        this.read = (this.read + CHANNELS) % CAPACITY;
        this.size -= CHANNELS;
        this.stats.dropped += 1;
      }
      for (let i = 0; i < frames; i++) {
        left[i] = this.ring[this.read];
        right[i] = this.ring[(this.read + 1) % CAPACITY];
        this.read = (this.read + 2) % CAPACITY;
      }
      this.size -= frames * CHANNELS;
    } else {
      // Underrun (e.g. a stalled helper or a hiccup in the pipe).
      // Output silence and re-prime so playback resumes with a cushion.
      if (this.primed) this.stats.underruns++;
      this.primed = false;
      left.fill(0);
      if (right !== left) right.fill(0);
    }

    this.stats.peak = Math.max(this.stats.peak, this.size);
    if (currentTime - this.lastReport >= 1) {
      this.lastReport = currentTime;
      this.port.postMessage({
        type: 'stats',
        bufferedMs: (this.size / CHANNELS / SAMPLE_RATE) * 1000,
        peakMs: (this.stats.peak / CHANNELS / SAMPLE_RATE) * 1000,
        underruns: this.stats.underruns,
        droppedMs: (this.stats.dropped / SAMPLE_RATE) * 1000,
      });
      this.stats.peak = 0;
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
