// Minimal MQTT 3.1.1 client over WebSocket: just enough to use a public broker as a mailbox
// (connect, subscribe, QoS 0 publish, keep-alive). Works in browsers, Electron and Node 22+.
//
// Events: 'message' {detail: {topic, payload: Uint8Array}}, 'close'

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function remainingLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

function mqttString(text) {
  const bytes = encoder.encode(text);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
}

function packet(type, body) {
  const len = remainingLength(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = type;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

export class MqttClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.buffer = new Uint8Array(0);
    this.nextPacketId = 1;
    this.pending = new Map(); // packet id → resolve (SUBACK)
    this.onConnack = null;
    this.pingTimer = null;
    this.closed = false;
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const fail = (err) => { this.close(); reject(err); };
      const timer = setTimeout(() => fail(new Error(`timed out connecting to ${this.url}`)), timeoutMs);
      try {
        this.ws = new WebSocket(this.url, 'mqtt');
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => {
        const clientId = `sl-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
        // Protocol "MQTT", level 4 (3.1.1), clean session, 30 s keep-alive.
        const body = [...mqttString('MQTT'), 4, 0x02, 0, 30, ...mqttString(clientId)];
        this.ws.send(packet(0x10, body));
      };
      this.onConnack = (code) => {
        clearTimeout(timer);
        if (code !== 0) return fail(new Error(`${this.url} refused the connection (code ${code})`));
        this.pingTimer = setInterval(() => this.#send(new Uint8Array([0xc0, 0])), 20000);
        resolve(this);
      };
      this.ws.onmessage = (e) => this.#receive(new Uint8Array(e.data));
      this.ws.onerror = () => { clearTimeout(timer); fail(new Error(`couldn't reach ${this.url}`)); };
      this.ws.onclose = () => {
        clearTimeout(timer);
        if (!this.closed) {
          this.close();
          reject(new Error(`${this.url} closed the connection`));
        }
      };
    });
  }

  subscribe(topic, timeoutMs = 8000) {
    const id = this.nextPacketId++;
    const body = [id >> 8, id & 0xff, ...mqttString(topic), 0];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('subscribe timed out')); }, timeoutMs);
      this.pending.set(id, (ok) => {
        clearTimeout(timer);
        if (ok) resolve(); else reject(new Error('subscription refused'));
      });
      this.#send(packet(0x82, body));
    });
  }

  publish(topic, payload) {
    const topicBytes = mqttString(topic);
    const body = new Uint8Array(topicBytes.length + payload.length);
    body.set(topicBytes);
    body.set(payload, topicBytes.length);
    this.#send(packet(0x30, body));
  }

  get connected() {
    return !this.closed && this.ws && this.ws.readyState === 1;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(new Uint8Array([0xe0, 0]));
      if (this.ws) this.ws.close();
    } catch { /* already gone */ }
    this.dispatchEvent(new Event('close'));
  }

  #send(bytes) {
    if (this.connected) this.ws.send(bytes);
  }

  // A WebSocket frame can hold part of a packet or several packets, so buffer and slice.
  #receive(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    let offset = 0;
    for (;;) {
      if (merged.length - offset < 2) break;
      let length = 0;
      let multiplier = 1;
      let i = offset + 1;
      let complete = false;
      for (; i < merged.length && i < offset + 5; i++) {
        length += (merged[i] & 0x7f) * multiplier;
        multiplier *= 128;
        if ((merged[i] & 0x80) === 0) { complete = true; i++; break; }
      }
      if (!complete || merged.length < i + length) break;
      this.#handle(merged[offset], merged.subarray(i, i + length));
      offset = i + length;
    }
    this.buffer = merged.slice(offset);
  }

  #handle(header, body) {
    switch (header >> 4) {
      case 2: // CONNACK
        if (this.onConnack) this.onConnack(body[1]);
        break;
      case 9: { // SUBACK
        const id = (body[0] << 8) | body[1];
        const done = this.pending.get(id);
        this.pending.delete(id);
        if (done) done(body[2] !== 0x80);
        break;
      }
      case 3: { // PUBLISH
        const qos = (header >> 1) & 0x03;
        const topicLength = (body[0] << 8) | body[1];
        const topic = decoder.decode(body.subarray(2, 2 + topicLength));
        const payload = body.slice(2 + topicLength + (qos > 0 ? 2 : 0));
        this.dispatchEvent(new CustomEvent('message', { detail: { topic, payload } }));
        break;
      }
      default: // PINGRESP and anything else: nothing to do
        break;
    }
  }
}
