// Dev-only: checks each public broker and a full encrypted round trip through the relay channel.
//   node dev/relay-test.mjs
import { MqttClient } from '../shared/mqtt.js';
import { BROKERS, RelayChannel, newRoomCode } from '../shared/rendezvous.js';

for (const url of BROKERS) {
  const started = Date.now();
  const client = new MqttClient(url);
  try {
    await client.connect(8000);
    await client.subscribe(`screenlink/v1/test-${Math.random().toString(16).slice(2)}`);
    console.log(`ok    ${url} (${Date.now() - started} ms)`);
  } catch (err) {
    console.log(`FAIL  ${url}: ${err.message}`);
  } finally {
    client.close();
  }
}

const code = newRoomCode();
const a = await RelayChannel.open(code);
const b = await RelayChannel.open(code);
await new Promise((r) => setTimeout(r, 2500)); // let the slower brokers join too
console.log(`code ${code}: A on ${a.brokerCount} brokers, B on ${b.brokerCount} brokers`);

const received = [];
b.addEventListener('message', (e) => received.push(e.detail));
const started = Date.now();
await a.send({ type: 'hello', payload: 'x'.repeat(6000) });
await new Promise((r) => setTimeout(r, 2000));
console.log(`B received ${received.length} message(s) (duplicates are dropped), first after <2 s: ${received[0] ? received[0].type : 'none'}`);

const stranger = await RelayChannel.open(newRoomCode());
let leaked = 0;
stranger.addEventListener('message', () => leaked++);
await a.send({ type: 'secret' });
await new Promise((r) => setTimeout(r, 1500));
console.log(`channel with another code received ${leaked} message(s)`);
console.log(`round trip test took ${Date.now() - started} ms`);
a.close();
b.close();
stranger.close();
