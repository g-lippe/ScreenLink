// One-code rendezvous: the host shares a short code, and both sides swap their WebRTC session
// descriptions through public MQTT brokers used as a mailbox. Several brokers are used at once,
// so one being down doesn't matter. Everything sent is AES-GCM encrypted with a key derived
// from the code, and the topic name is derived from it too, so brokers see neither the code nor
// the IP addresses inside the descriptions. Media never touches the brokers; it goes peer-to-peer.
//
// Protocol (all messages carry {id, from}; `to` addresses one peer):
//   guest → hello {device, viewOnly}   repeated until an offer arrives
//   host  → offer {to, sdp}            resent whenever the same guest says hello again
//   guest → answer {to, sdp}           resent until the connection is up
//   host  → busy {to}                  the invite already has a connected guest

import { MqttClient } from './mqtt.js';

export const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];

const TOPIC_PREFIX = 'screenlink/v1/';
const KDF_SALT = 'screenlink/rendezvous/v1';
const KDF_ITERATIONS = 150000;

// Crockford base32: no I, L, O or U, so codes survive being read aloud or retyped.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const randomId = () => toHex(crypto.getRandomValues(new Uint8Array(8)));

export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  const chars = Array.from(bytes, (b) => ALPHABET[b % 32]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Accepts "7K3M-QX9P", "7k3mqx9p", or a link ending in #7K3M-QX9P. Returns "7K3MQX9P" or null. */
export function normalizeRoomCode(input) {
  let text = String(input || '').trim();
  const hash = text.indexOf('#');
  if (hash !== -1) text = text.slice(hash + 1);
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== CODE_LENGTH) return null;
  for (const ch of clean) if (!ALPHABET.includes(ch)) return null;
  return clean;
}

export function formatRoomCode(code) {
  const clean = normalizeRoomCode(code) || code;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

// A slow KDF makes brute-forcing a code from an observed topic name impractical.
async function deriveRoom(code) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(normalizeRoomCode(code)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(KDF_SALT), iterations: KDF_ITERATIONS },
    base,
    384,
  ));
  const key = await crypto.subtle.importKey('raw', bits.slice(16, 48), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic: TOPIC_PREFIX + toHex(bits.slice(0, 16)), key };
}

/**
 * An encrypted, deduplicated mailbox shared by everyone who knows the code.
 * Events: 'message' {detail: msg}
 */
export class RelayChannel extends EventTarget {
  static async open(code, { brokers = BROKERS, timeoutMs = 8000 } = {}) {
    const channel = new RelayChannel();
    const { topic, key } = await deriveRoom(code);
    channel.topic = topic;
    channel.key = key;
    const attempts = brokers.map(async (url) => {
      const client = new MqttClient(url);
      await client.connect(timeoutMs);
      await client.subscribe(topic, timeoutMs);
      client.addEventListener('message', (e) => channel.#receive(e.detail));
      channel.clients.push(client);
      return url;
    });
    // Resolve as soon as one broker is ready; the others keep joining in the background.
    try {
      await Promise.any(attempts);
    } catch {
      channel.close();
      throw new Error("Couldn't reach any connection relay. Check your internet connection, or use Manual connection.");
    }
    return channel;
  }

  constructor() {
    super();
    this.peerId = randomId();
    this.clients = [];
    this.seen = new Set();
    this.closed = false;
  }

  get brokerCount() {
    return this.clients.filter((c) => c.connected).length;
  }

  async send(msg) {
    if (this.closed) return;
    const plain = encoder.encode(JSON.stringify({ ...msg, id: randomId(), from: this.peerId }));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, plain));
    const payload = new Uint8Array(iv.length + cipher.length);
    payload.set(iv);
    payload.set(cipher, iv.length);
    for (const client of this.clients) {
      if (client.connected) client.publish(this.topic, payload);
    }
  }

  async #receive({ topic, payload }) {
    if (this.closed || topic !== this.topic || payload.length < 13) return;
    let msg;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(0, 12) }, this.key, payload.slice(12));
      msg = JSON.parse(decoder.decode(plain));
    } catch {
      return; // not ours, or tampered with
    }
    // Every broker delivers its own copy, and our own messages come back to us.
    if (!msg.id || this.seen.has(msg.id) || msg.from === this.peerId) return;
    if (msg.to && msg.to !== this.peerId) return;
    this.seen.add(msg.id);
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) client.close();
  }
}

const connectedPromise = (peer) => new Promise((resolve, reject) => {
  const onState = (e) => {
    if (e.detail === 'connected') { peer.removeEventListener('state', onState); resolve(); }
    if (e.detail === 'failed' || e.detail === 'closed') { peer.removeEventListener('state', onState); reject(new Error('failed')); }
  };
  peer.addEventListener('state', onState);
});

/**
 * Host side. Waits for a guest, then negotiates over the channel.
 *   createPeer() → Peer   (called once up front, and again only if a guest has to be replaced)
 * Events: 'guest' {detail: {device, viewOnly}}, 'connected' {detail: peer}
 * The channel closes itself once a guest is connected.
 */
export class RoomHost extends EventTarget {
  static async open(code, { createPeer }) {
    const host = new RoomHost();
    host.createPeer = createPeer;
    // The offer doesn't depend on who joins, and ICE gathering can take seconds (unanswered
    // STUN requests run into a timeout), so it's prepared while the invite waits for a guest.
    host.#prepareOffer();
    try {
      host.channel = await RelayChannel.open(code);
    } catch (err) {
      host.spare.peer.close();
      throw err;
    }
    host.channel.addEventListener('message', (e) => host.#onMessage(e.detail).catch((err) => console.warn('rendezvous host:', err)));
    return host;
  }

  constructor() {
    super();
    this.spare = null;   // { peer, offer: Promise<sdp> } prepared ahead of time
    this.guest = null;   // { id, offer, peer, answered }
    this.connected = false;
  }

  #prepareOffer() {
    const peer = this.createPeer();
    const offer = peer.createOffer();
    offer.catch(() => {});
    this.spare = { peer, offer };
  }

  async #onMessage(msg) {
    if (msg.type === 'hello') {
      if (this.connected) return this.channel.send({ type: 'busy', to: msg.from });
      if (this.guest && this.guest.id === msg.from) {
        // Same guest again: our offer probably got lost.
        if (this.guest.offer) await this.channel.send({ type: 'offer', to: msg.from, sdp: this.guest.offer });
        return;
      }
      // A new guest replaces one that never finished connecting (e.g. they reloaded the page).
      if (this.guest) {
        this.guest.peer.close();
        this.#prepareOffer();
      }
      const { peer, offer } = this.spare;
      this.spare = null;
      const info = { device: msg.device || 'desktop', viewOnly: !!msg.viewOnly };
      const guest = { id: msg.from, offer: null, peer, answered: false };
      this.guest = guest;
      this.dispatchEvent(new CustomEvent('guest', { detail: info }));
      connectedPromise(peer).then(() => {
        if (this.guest !== guest) return;
        this.connected = true;
        this.dispatchEvent(new CustomEvent('connected', { detail: peer }));
        // Give a lost-then-resent answer a moment to settle before leaving the mailbox.
        setTimeout(() => this.close(), 3000);
      }, () => {});
      guest.offer = await offer;
      if (this.guest === guest) await this.channel.send({ type: 'offer', to: guest.id, sdp: guest.offer });
    } else if (msg.type === 'answer' && this.guest && msg.from === this.guest.id && !this.guest.answered) {
      this.guest.answered = true;
      await this.guest.peer.acceptAnswer(msg.sdp);
    }
  }

  close() {
    if (this.spare) { this.spare.peer.close(); this.spare = null; }
    this.channel.close();
  }
}

/**
 * Guest side. Resolves with the connected Peer, or rejects with a user-facing error.
 *   createPeer() → Peer
 *   onStatus(text) → progress updates for the UI
 *   signal: AbortSignal to cancel
 */
export async function joinRoom(code, { createPeer, device = 'desktop', viewOnly = false, onStatus = () => {}, signal, timeoutMs = 20000 }) {
  onStatus('Reaching the connection relays…');
  const channel = await RelayChannel.open(code);
  if (signal && signal.aborted) { channel.close(); throw new DOMException('cancelled', 'AbortError'); }
  onStatus('Looking for the host…');

  return new Promise((resolve, reject) => {
    let peer = null;
    let answer = null;
    let hostId = null;
    const timers = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      timers.forEach(clearInterval);
      timers.forEach(clearTimeout);
      channel.close();
      if (err) {
        if (peer && peer.pc.connectionState !== 'connected') peer.close();
        reject(err);
      } else {
        resolve(peer);
      }
    };

    const hello = () => channel.send({ type: 'hello', device, viewOnly });
    hello();
    timers.push(setInterval(() => { if (!peer) hello(); }, 2000));
    timers.push(setTimeout(() => {
      if (!peer) finish(new Error("The host didn't respond. Check the code, and make sure their invite is still open."));
    }, timeoutMs));
    if (signal) signal.addEventListener('abort', () => finish(new DOMException('cancelled', 'AbortError')));

    channel.addEventListener('message', async (e) => {
      const msg = e.detail;
      try {
        if (msg.type === 'busy') {
          finish(new Error('Someone else already joined this invite. Ask the host for a new one.'));
        } else if (msg.type === 'offer' && !peer) {
          hostId = msg.from;
          onStatus('Connecting…');
          peer = createPeer();
          connectedPromise(peer).then(() => finish(null), () => finish(new Error(
            "Couldn't establish a direct connection. Try again; if it keeps failing, see the README's NAT section.",
          )));
          answer = await peer.acceptOffer(msg.sdp);
          const sendAnswer = () => channel.send({ type: 'answer', to: hostId, sdp: answer });
          await sendAnswer();
          // Resend until connected, in case the answer got lost on the way.
          timers.push(setInterval(sendAnswer, 3000));
          timers.push(setTimeout(() => finish(new Error("Couldn't connect to the host in time. Try again.")), 30000));
        }
      } catch (err) {
        finish(err);
      }
    });
  });
}
