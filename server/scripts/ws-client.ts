/**
 * Scripted WebSocket client for testing notification delivery.
 *   npx tsx scripts/ws-client.ts --user admin --pass ... [--device-id <uuid>] [--no-ack] [--read] [--for 60]
 * Logs in as a device, connects to /ws, prints every message, acks notifications
 * (unless --no-ack) and optionally sends read receipts.
 */
import WebSocket from 'ws';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? 'true' : process.argv[i + 1]) : d;
};
const base = arg('server', 'http://127.0.0.1:8780')!;
const ack = arg('no-ack') === undefined;
const read = arg('read') !== undefined;
const seconds = Number(arg('for', '0'));

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: arg('user', 'admin'), password: arg('pass'), deviceName: arg('name', 'ws-client'), platform: 'cli', deviceId: arg('device-id') }),
});
if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
const tok = (await login.json()) as { accessToken: string; deviceId: string };
console.log(`device ${tok.deviceId}`);

const seen = new Set<string>();
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${tok.accessToken}`);
ws.on('open', () => ws.send(JSON.stringify({ t: 'hello' })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'notification') {
    const dup = seen.has(m.n.id);
    seen.add(m.n.id);
    console.log(`${new Date().toISOString()} NOTIFICATION ${m.n.id.slice(0, 8)} ${m.n.title} | ${m.n.body} | img=${m.n.imageUrl ? 'yes' : 'no'}${dup ? ' (redelivery)' : ''}`);
    if (ack) ws.send(JSON.stringify({ t: 'ack', ids: [m.n.id] }));
    if (read) ws.send(JSON.stringify({ t: 'read', ids: [m.n.id] }));
  } else if (m.t !== 'camera.status' || arg('verbose')) {
    console.log(`${new Date().toISOString()} ${m.t} ${JSON.stringify(m).slice(0, 160)}`);
  }
});
ws.on('close', (c, r) => {
  console.log(`closed ${c} ${r}`);
  process.exit(0);
});
if (seconds) setTimeout(() => ws.close(), seconds * 1000);
