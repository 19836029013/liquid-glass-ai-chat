#!/usr/bin/env node
/* 英子起飞 · 群聊同步服务器
 * 零依赖 Node.js：HTTP 存消息/传文件 + WebSocket 实时推送。
 * 默认端口 8787，可环境变量 PORT 覆盖。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const CONV_DIR = path.join(DATA_DIR, 'convs');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const SYNC_TOKEN = (process.env.SYNC_TOKEN || '').trim();
const MAX_STATE_BYTES = Number(process.env.MAX_STATE_BYTES || 2 * 1024 * 1024);
const MAX_ATTACHMENT_BYTES = Number(process.env.MAX_ATTACHMENT_BYTES || 10 * 1024 * 1024);
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 2000);

fs.mkdirSync(CONV_DIR, { recursive: true });
fs.mkdirSync(ATTACH_DIR, { recursive: true });

const conversations = new Map();
const clients = new Map();
const writeQueues = new Map();

function loadConversations() {
  for (const file of fs.readdirSync(CONV_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const conv = JSON.parse(fs.readFileSync(path.join(CONV_DIR, file), 'utf8'));
      const topic = conv.topic || path.basename(file, '.json');
      conversations.set(topic, conv);
    } catch (err) {
      console.error('读取数据失败:', file, err.message);
    }
  }
}
loadConversations();

function safeTopic(topic) {
  return String(topic || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
}

function saveConv(topic, conv) {
  conversations.set(topic, conv);
  const file = path.join(CONV_DIR, safeTopic(topic) + '.json');
  const previous = writeQueues.get(topic) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => fs.promises.writeFile(file, JSON.stringify(conv), 'utf8'))
    .catch((err) => console.error('保存对话失败:', err.message));
  writeQueues.set(topic, next);
  return next;
}

function messageKey(message) {
  if (message && message.id != null) return 'id:' + String(message.id);
  const attachment = message && message.attachment ? JSON.stringify(message.attachment) : '';
  return 'fallback:' + [message?.role, message?.content, message?.createdAt, attachment].join('|');
}

function mergeConversation(existing, incoming, topic) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  const byKey = new Map();
  const messages = [];
  const add = (message) => {
    if (!message || typeof message !== 'object') return;
    const key = messageKey(message);
    const prior = byKey.get(key);
    if (prior) {
      // Keep the latest delivery state while retaining a completed response.
      Object.assign(prior, message);
      return;
    }
    const copy = { ...message };
    byKey.set(key, copy);
    messages.push(copy);
  };
  for (const message of Array.isArray(base.messages) ? base.messages : []) add(message);
  for (const message of Array.isArray(next.messages) ? next.messages : []) add(message);

  messages.sort((a, b) => {
    const seqA = Number(a.serverSeq || 0);
    const seqB = Number(b.serverSeq || 0);
    if (seqA && seqB && seqA !== seqB) return seqA - seqB;
    return Number(a.createdAt || 0) - Number(b.createdAt || 0);
  });
  let serverSeq = messages.reduce((max, message) => Math.max(max, Number(message.serverSeq || 0)), 0);
  for (const message of messages) {
    if (!message.serverSeq) message.serverSeq = ++serverSeq;
  }
  const clipped = messages.slice(-MAX_MESSAGES);

  const membersByKey = new Map();
  for (const member of [
    ...(Array.isArray(base.members) ? base.members : []),
    ...(Array.isArray(next.members) ? next.members : []),
  ]) {
    if (!member || typeof member !== 'object') continue;
    const key = String(member.id || member.name || member.nickname || membersByKey.size);
    membersByKey.set(key, { ...(membersByKey.get(key) || {}), ...member });
  }
  return {
    ...base,
    ...next,
    topic: safeTopic(topic || next.topic || base.topic),
    messages: clipped,
    members: [...membersByKey.values()],
    updatedAt: Date.now(),
  };
}

async function readRequestBody(req, maxBytes) {
  const length = Number(req.headers['content-length'] || 0);
  if (length > maxBytes) {
    req.resume();
    const error = new Error('payload_too_large');
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const error = new Error('payload_too_large');
      error.code = 'PAYLOAD_TOO_LARGE';
      req.destroy();
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Filename,X-Sync-Token',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function authorized(req, url){
  if(!SYNC_TOKEN)return true;
  return (req.headers['x-sync-token']||'')===SYNC_TOKEN || (url.searchParams.get('key')||'')===SYNC_TOKEN;
}

/* ---------- WebSocket ---------- */
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    len = Number(big);
    off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  const mask = masked ? buf.subarray(off, off + 4) : null;
  const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, consumed: off + maskLen + len };
}

function sendFrame(ws, str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81;
  try {
    ws.socket.write(Buffer.concat([header, payload]));
  } catch (err) {}
}

function broadcast(topic, obj, except) {
  const set = clients.get(topic);
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const ws of set) {
    if (ws !== except) sendFrame(ws, data);
  }
}

function attachWs(req, socket) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'ws' || parts.length < 2) {
    socket.destroy();
    return;
  }
  let decodedTopic;
  try {
    decodedTopic = decodeURIComponent(parts[1]);
  } catch (err) {
    socket.destroy();
    return;
  }
  const topic = safeTopic(decodedTopic);
  const presentedToken = String(req.headers['x-sync-token'] || url.searchParams.get('key') || '');
  const wsAuth = !SYNC_TOKEN || presentedToken === SYNC_TOKEN;
  console.log('[ws] connect', topic, 'auth=' + wsAuth);
  if (!wsAuth) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const ws = { socket, topic };
  if (!clients.has(topic)) clients.set(topic, new Set());
  clients.get(topic).add(ws);

  const conv = conversations.get(topic);
  if (conv) sendFrame(ws, JSON.stringify({ type: 'state', conv }));

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // A sync frame is a complete JSON conversation. Close peers that send an
    // oversized frame before it can accumulate unbounded memory.
    if (buffer.length > MAX_STATE_BYTES + 1024) {
      socket.destroy();
      return;
    }
    for (;;) {
      const frame = parseFrame(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.consumed);
      if (frame.opcode === 8) {
        socket.end();
        return;
      }
      if (frame.opcode !== 1) continue;
      let msg = null;
      try {
        msg = JSON.parse(frame.payload.toString('utf8'));
      } catch (err) {
        continue;
      }
      if (msg && msg.type === 'sync' && msg.conv && Array.isArray(msg.conv.messages)) {
        const conv = mergeConversation(conversations.get(topic), msg.conv, topic);
        saveConv(topic, conv);
        broadcast(topic, { type: 'state', conv }, ws);
      }
    }
  });
  socket.on('close', () => {
    const set = clients.get(topic);
    if (set) set.delete(ws);
  });
  socket.on('error', () => {
    try {
      socket.destroy();
    } catch (err) {}
  });
}

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  console.log('[http]', new Date().toISOString(), req.method, url.pathname, 'auth=' + authorized(req, url));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Filename,X-Sync-Token',
    });
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    json(res, 200, { ok: true, service: 'yingzi-sync', version: 2 });
    return;
  }

  if (parts[0] === 'api' && parts.length >= 2) {
    if(!authorized(req, url)){ json(res, 401, { ok: false, error: 'unauthorized' }); return; }
    let topicPart;
    try { topicPart = decodeURIComponent(parts[1]); }
    catch (err) { json(res, 400, { ok: false, error: 'bad_topic' }); return; }
    const topic = safeTopic(topicPart);

    if (parts.length === 2) {
      if (req.method === 'GET') {
        const conv = conversations.get(topic);
        if (!conv) {
          json(res, 404, { ok: false, error: 'not_found' });
          return;
        }
        json(res, 200, { ok: true, conv });
        return;
      }
      if (req.method === 'POST') {
        let conv = null;
        try {
          conv = JSON.parse((await readRequestBody(req, MAX_STATE_BYTES)).toString('utf8'));
        } catch (err) {
          if (err.code === 'PAYLOAD_TOO_LARGE') {
            json(res, 413, { ok: false, error: 'payload_too_large', maxBytes: MAX_STATE_BYTES });
            return;
          }
          json(res, 400, { ok: false, error: 'bad_json' });
          return;
        }
        if (!conv || !Array.isArray(conv.messages)) {
          json(res, 400, { ok: false, error: 'bad_conv' });
          return;
        }
        conv = mergeConversation(conversations.get(topic), conv, topic);
        saveConv(topic, conv);
        broadcast(topic, { type: 'state', conv });
        json(res, 200, { ok: true, updatedAt: conv.updatedAt, messageCount: conv.messages.length });
        return;
      }
    }

    if (parts.length >= 3 && parts[2] === 'attachments' && req.method === 'PUT') {
      const filename = String(req.headers.filename || 'file')
        .replace(/[\\/:*?"<>|]/g, '_')
        .slice(0, 120);
      const id = crypto.randomBytes(8).toString('hex');
      const dir = path.join(ATTACH_DIR, safeTopic(topic));
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, id + '-' + filename);
      let payload;
      try {
        payload = await readRequestBody(req, MAX_ATTACHMENT_BYTES);
      } catch (err) {
        if (err.code === 'PAYLOAD_TOO_LARGE') {
          json(res, 413, { ok: false, error: 'attachment_too_large', maxBytes: MAX_ATTACHMENT_BYTES });
          return;
        }
        json(res, 400, { ok: false, error: 'attachment_read_failed' });
        return;
      }
      await fs.promises.writeFile(filePath, payload);
      const host = req.headers.host || 'localhost:' + PORT;
      const protocol = req.socket.encrypted ? 'https' : 'http';
      const authQuery = SYNC_TOKEN ? '?key=' + encodeURIComponent(SYNC_TOKEN) : '';
      const downloadUrl =
        protocol + '://' + host + '/api/' + encodeURIComponent(topic) + '/attachments/' + id + '/' + encodeURIComponent(filename) + authQuery;
      json(res, 200, {
        ok: true,
        attachment: {
          url: downloadUrl,
          name: filename,
          type: req.headers['content-type'] || 'application/octet-stream',
        },
      });
      return;
    }

    if (parts.length >= 5 && parts[2] === 'attachments' && req.method === 'GET') {
      const id = parts[3];
      let filename;
      try {
        filename = decodeURIComponent(parts.slice(4).join('/'));
      } catch (err) {
        res.writeHead(400);
        res.end('bad filename');
        return;
      }
      filename = path.basename(filename).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
      const dir = path.resolve(path.join(ATTACH_DIR, safeTopic(topic)));
      const filePath = path.resolve(path.join(dir, id + '-' + filename));
      if (!filePath.startsWith(dir + path.sep) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.zip': 'application/zip',
      }[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  json(res, 404, { ok: false, error: 'not_found' });
});

server.on('upgrade', attachWs);

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, () => {
    console.log('英子起飞 · 群聊同步服务器已启动');
    console.log('本机访问:   http://127.0.0.1:' + PORT);
    console.log('健康检查:   http://127.0.0.1:' + PORT + '/health');
    console.log('局域网/虚拟网: 用电脑的局域网 IP 或 Tailscale IP 替换 127.0.0.1');
    console.log('数据目录:   ' + DATA_DIR);
  });
}

export { server, mergeConversation, safeTopic, readRequestBody };
