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

fs.mkdirSync(CONV_DIR, { recursive: true });
fs.mkdirSync(ATTACH_DIR, { recursive: true });

const conversations = new Map();
const clients = new Map();

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
  fs.writeFile(file, JSON.stringify(conv), (err) => {
    if (err) console.error('保存对话失败:', err.message);
  });
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
  const topic = safeTopic(decodeURIComponent(parts[1]));
  const wsAuth = !SYNC_TOKEN || url.searchParams.get('key') === SYNC_TOKEN;
  console.log('[ws] connect', topic, 'auth=' + wsAuth);
  if(SYNC_TOKEN && url.searchParams.get('key') !== SYNC_TOKEN){ socket.destroy(); return; }
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
        msg.conv.updatedAt = Date.now();
        saveConv(topic, msg.conv);
        broadcast(topic, { type: 'state', conv: msg.conv }, ws);
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
    json(res, 200, { ok: true, service: 'yingzi-sync', version: 1 });
    return;
  }

  if (parts[0] === 'api' && parts.length >= 2) {
    if(!authorized(req, url)){ json(res, 401, { ok: false, error: 'unauthorized' }); return; }
    const topic = safeTopic(decodeURIComponent(parts[1]));

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
        let body = '';
        req.setEncoding('utf8');
        for await (const chunk of req) body += chunk;
        let conv = null;
        try {
          conv = JSON.parse(body);
        } catch (err) {
          json(res, 400, { ok: false, error: 'bad_json' });
          return;
        }
        if (!conv || !Array.isArray(conv.messages)) {
          json(res, 400, { ok: false, error: 'bad_conv' });
          return;
        }
        if (Array.isArray(conv.messages) && conv.messages.length > 2000) {
          conv.messages = conv.messages.slice(-2000);
        }
        conv.topic = topic;
        conv.updatedAt = Date.now();
        saveConv(topic, conv);
        broadcast(topic, { type: 'state', conv });
        json(res, 200, { ok: true, updatedAt: conv.updatedAt });
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
      const out = fs.createWriteStream(filePath);
      req.pipe(out);
      await new Promise((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
      });
      const host = req.headers.host || 'localhost:' + PORT;
      const protocol = req.socket.encrypted ? 'https' : 'http';
      const downloadUrl =
        protocol + '://' + host + '/api/' + encodeURIComponent(topic) + '/attachments/' + id + '/' + encodeURIComponent(filename);
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
      const filename = parts.slice(4).join('/');
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

server.listen(PORT, HOST, () => {
  console.log('英子起飞 · 群聊同步服务器已启动');
  console.log('本机访问:   http://127.0.0.1:' + PORT);
  console.log('健康检查:   http://127.0.0.1:' + PORT + '/health');
  console.log('局域网/虚拟网: 用电脑的局域网 IP 或 Tailscale IP 替换 127.0.0.1');
  console.log('数据目录:   ' + DATA_DIR);
});
