import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';

const dataDir = await fs.mkdtemp(`${os.tmpdir()}\\dsh-sync-test-`);
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.SYNC_TOKEN = 'test-token';

const { server, mergeConversation } = await import('./server.js');
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });
});

function url(topic, suffix = '') {
  return `${baseUrl}/api/${encodeURIComponent(topic)}${suffix}?key=test-token`;
}

function websocketFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    throw new Error('test frame unexpectedly large');
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

test('health is public and state requires the sync token', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  const unauthorized = await fetch(`${baseUrl}/api/test-topic`);
  assert.equal(unauthorized.status, 401);
});

test('state writes merge concurrent message ids instead of overwriting', async () => {
  const first = { topic: 'merge', title: '群聊', messages: [{ id: 'a', role: 'user', content: 'one', createdAt: 1 }] };
  const second = { topic: 'merge', messages: [{ id: 'b', role: 'user', content: 'two', createdAt: 2 }] };
  const [a, b] = await Promise.all([
    fetch(url('merge'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(first) }),
    fetch(url('merge'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(second) }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const result = await fetch(url('merge'));
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.deepEqual(body.conv.messages.map((message) => message.id).sort(), ['a', 'b']);
  assert.ok(body.conv.messages.every((message) => Number.isInteger(message.serverSeq)));
});

test('websocket sends current state and accepts sync frames', async () => {
  await fetch(url('socket'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'before-ws', role: 'user', content: 'hello', createdAt: 1 }] }),
  });
  const port = server.address().port;
  const socket = net.createConnection({ host: '127.0.0.1', port });
  let received = '';
  const initialState = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket state timeout')), 1000);
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (received.includes('"type":"state"') && received.includes('before-ws')) {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.on('error', reject);
  });
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    `GET /ws/socket?key=test-token HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${port}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`
  );
  await initialState;
  socket.write(websocketFrame(JSON.stringify({ type: 'sync', conv: { messages: [{ id: 'from-ws', role: 'user', content: 'ws', createdAt: 2 }] } })));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const state = await (await fetch(url('socket'))).json();
  assert.deepEqual(state.conv.messages.map((message) => message.id).sort(), ['before-ws', 'from-ws']);
  socket.destroy();
});

test('mergeConversation deduplicates ids and unions members', () => {
  const merged = mergeConversation(
    { messages: [{ id: 'same', content: 'old' }], members: [{ id: 'one', name: 'A' }] },
    { messages: [{ id: 'same', content: 'new' }, { id: 'other', content: 'two' }], members: [{ id: 'two', name: 'B' }] },
    'demo'
  );
  assert.equal(merged.messages.length, 2);
  assert.equal(merged.messages.find((message) => message.id === 'same').content, 'new');
  assert.deepEqual(merged.members.map((member) => member.id).sort(), ['one', 'two']);
});

test('attachments are bounded and can be downloaded with encoded names', async () => {
  const upload = await fetch(url('files', '/attachments'), {
    method: 'PUT',
    headers: { filename: 'hello world.txt', 'content-type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  const download = await fetch(uploaded.attachment.url);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'hello');

  const tooLarge = await fetch(url('files', '/attachments'), {
    method: 'PUT',
    headers: { filename: 'too-large.bin', 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  assert.equal(tooLarge.status, 413);
});
