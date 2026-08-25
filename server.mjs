import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameState, TICK_RATE } from './src/game-state.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const MAX_BODY_BYTES = 16 * 1024;

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
});

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

function sendError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      reject(Object.assign(new Error('content_type'), { status: 415 }));
      request.resume();
      return;
    }
    const statedLength = Number(request.headers['content-length']);
    if (Number.isFinite(statedLength) && statedLength > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('body_too_large'), { status: 413 }));
      request.resume();
      return;
    }
    const chunks = [];
    let length = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('body_too_large'), { status: 413 }));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError('object_required');
        resolveBody(body);
      } catch {
        reject(Object.assign(new Error('invalid_json'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function cleanName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18);
  return cleaned || fallback;
}

function safeTokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function newToken() {
  return randomBytes(24).toString('base64url');
}

function newRoomCode(rooms) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const random = randomBytes(6);
    let code = '';
    for (const byte of random) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error('room_code_exhausted');
}

function extractCredentials(request, url, body = {}) {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : undefined;
  return {
    playerId: body.playerId ?? url.searchParams.get('playerId') ?? undefined,
    token: body.token ?? url.searchParams.get('token') ?? request.headers['x-player-token'] ?? bearer,
  };
}

function authenticate(record, credentials) {
  if (!record || typeof credentials.token !== 'string') return null;
  if (typeof credentials.playerId === 'string') {
    const session = record.sessions.get(credentials.playerId);
    return session && safeTokenEqual(session.token, credentials.token) ? session : null;
  }
  for (const session of record.sessions.values()) {
    if (safeTokenEqual(session.token, credentials.token)) return session;
  }
  return null;
}

function playerResponse(record, session) {
  const player = record.game.players.get(session.playerId);
  return {
    roomCode: record.code,
    playerId: session.playerId,
    token: session.token,
    role: player.role,
    mode: record.mode,
    state: record.game.snapshot(),
  };
}

function isWithinRoot(root, candidate) {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

async function serveStatic(request, response, url, publicRoot) {
  if (!['GET', 'HEAD'].includes(request.method)) return false;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendError(response, 400, 'bad_path', '请求路径编码无效。');
    return true;
  }
  if (pathname.includes('\0') || pathname.split('/').some((segment) => segment === '..' || segment.startsWith('.'))) {
    sendError(response, 403, 'forbidden_path', '禁止访问该路径。');
    return true;
  }
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let candidate = resolve(publicRoot, requested);
  if (!isWithinRoot(publicRoot, candidate)) {
    sendError(response, 403, 'forbidden_path', '禁止访问该路径。');
    return true;
  }
  try {
    let info = await stat(candidate);
    if (info.isDirectory()) {
      candidate = resolve(candidate, 'index.html');
      if (!isWithinRoot(publicRoot, candidate)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
      info = await stat(candidate);
    }
    if (!info.isFile()) throw Object.assign(new Error('not_file'), { code: 'ENOENT' });
    const type = MIME_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream';
    const etag = `W/\"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}\"`;
    const headers = {
      ...securityHeaders(),
      'Content-Type': type,
      'Content-Length': info.size,
      ETag: etag,
      'Cache-Control': requested.startsWith('assets/') ? 'public, max-age=86400' : 'no-cache',
    };
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, headers);
      response.end();
      return true;
    }
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return true;
    }
    const stream = createReadStream(candidate);
    stream.on('error', () => {
      if (!response.headersSent) sendError(response, 500, 'read_failed', '静态文件读取失败。');
      else response.destroy();
    });
    stream.pipe(response);
  } catch (error) {
    if (error?.code === 'EACCES') sendError(response, 403, 'forbidden_path', '禁止访问该路径。');
    else sendError(response, 404, 'not_found', '未找到该资源。');
  }
  return true;
}

function validateInput(body) {
  if (!Number.isSafeInteger(body.seq) || body.seq < 0) return { error: 'seq 必须是非负安全整数。' };
  const result = { seq: body.seq };
  for (const key of ['move', 'aim']) {
    const vector = body[key] ?? {};
    if (
      vector === null
      || typeof vector !== 'object'
      || !Number.isFinite(vector.x ?? 0)
      || !Number.isFinite(vector.y ?? 0)
      || Math.abs(vector.x ?? 0) > 1.001
      || Math.abs(vector.y ?? 0) > 1.001
    ) return { error: `${key} 必须包含 -1 到 1 之间的 x、y。` };
    result[key] = { x: vector.x ?? 0, y: vector.y ?? 0 };
  }
  for (const key of ['attack', 'interact', 'dodge']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') return { error: `${key} 必须是布尔值。` };
    result[key] = body[key] === true;
  }
  return { value: result };
}

export function createGameServer({
  publicDir = resolve(MODULE_DIR, 'public'),
  tickRate = TICK_RATE,
  broadcastRate = 15,
  roomTtlMs = 30 * 60 * 1000,
  emptyRoomTtlMs = 5 * 60 * 1000,
  maxRoomAgeMs = 6 * 60 * 60 * 1000,
  cleanupIntervalMs = 10_000,
  clock = Date.now,
  maxRooms = 200,
} = {}) {
  const publicRoot = resolve(publicDir);
  const rooms = new Map();
  const creationWindows = new Map();
  let simulationTimer = null;
  let cleanupTimer = null;
  let heartbeatTimer = null;
  let previousTickTime = clock();

  function closeRoom(record, reason = 'expired') {
    for (const client of record.clients) {
      client.response.write(`event: ${reason}\ndata: ${JSON.stringify({ roomCode: record.code })}\n\n`);
      client.response.end();
    }
    record.clients.clear();
    rooms.delete(record.code);
  }

  function cleanupRooms() {
    const current = clock();
    for (const record of rooms.values()) {
      const hasConnectedHuman = [...record.sessions.values()].some((session) => session.connected);
      const idleLimit = hasConnectedHuman ? roomTtlMs : emptyRoomTtlMs;
      if (current - record.lastActive > idleLimit || current - record.createdAt > maxRoomAgeMs) closeRoom(record);
    }
    for (const [ip, timestamps] of creationWindows) {
      const recent = timestamps.filter((timestamp) => current - timestamp < 60_000);
      if (recent.length) creationWindows.set(ip, recent);
      else creationWindows.delete(ip);
    }
  }

  function broadcast(record) {
    if (record.clients.size === 0) return;
    const payload = `event: state\ndata: ${JSON.stringify(record.game.snapshot())}\n\n`;
    for (const client of record.clients) {
      if (!client.response.destroyed) client.response.write(payload);
    }
  }

  function startTimers() {
    if (simulationTimer) return;
    previousTickTime = clock();
    let broadcastAccumulator = 0;
    simulationTimer = setInterval(() => {
      const current = clock();
      const measured = (current - previousTickTime) / 1000;
      previousTickTime = current;
      const dt = measured > 0 && measured < 0.25 ? measured : 1 / tickRate;
      broadcastAccumulator += dt;
      for (const record of rooms.values()) record.game.update(dt);
      if (broadcastAccumulator >= 1 / broadcastRate) {
        broadcastAccumulator %= 1 / broadcastRate;
        for (const record of rooms.values()) broadcast(record);
      }
    }, 1000 / tickRate);
    cleanupTimer = setInterval(cleanupRooms, cleanupIntervalMs);
    heartbeatTimer = setInterval(() => {
      for (const record of rooms.values()) {
        for (const client of record.clients) {
          if (!client.response.destroyed) client.response.write(`: heartbeat ${clock()}\n\n`);
        }
      }
    }, 15_000);
    simulationTimer.unref?.();
    cleanupTimer.unref?.();
    heartbeatTimer.unref?.();
  }

  function stopTimers() {
    clearInterval(simulationTimer);
    clearInterval(cleanupTimer);
    clearInterval(heartbeatTimer);
    simulationTimer = null;
    cleanupTimer = null;
    heartbeatTimer = null;
  }

  function rateLimitCreation(request) {
    const ip = request.socket.remoteAddress ?? 'unknown';
    const current = clock();
    const timestamps = (creationWindows.get(ip) ?? []).filter((timestamp) => current - timestamp < 60_000);
    if (timestamps.length >= 12) return false;
    timestamps.push(current);
    creationWindows.set(ip, timestamps);
    return true;
  }

  function rateLimitInput(session) {
    const current = clock();
    if (current - session.inputWindowStarted >= 1000) {
      session.inputWindowStarted = current;
      session.inputCount = 0;
    }
    session.inputCount += 1;
    return session.inputCount <= 90;
  }

  function makeSession(record, { name, role }) {
    const playerId = randomUUID();
    const token = newToken();
    const publicPlayer = record.game.addPlayer({ playerId, id: playerId, name, role });
    const session = {
      playerId,
      token,
      connected: true,
      sseConnections: 0,
      inputWindowStarted: clock(),
      inputCount: 0,
    };
    record.sessions.set(playerId, session);
    return { session, publicPlayer };
  }

  const server = http.createServer(async (request, response) => {
    response.on('error', () => {});
    const base = `http://${request.headers.host ?? '127.0.0.1'}`;
    let url;
    try {
      url = new URL(request.url ?? '/', base);
    } catch {
      sendError(response, 400, 'bad_url', '请求地址无效。');
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...securityHeaders(), Allow: 'GET, HEAD, POST, OPTIONS' });
      response.end();
      return;
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, rooms: rooms.size, tickRate });
      return;
    }

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      if (!rateLimitCreation(request)) {
        sendError(response, 429, 'rate_limited', '创建房间过于频繁，请稍后再试。');
        return;
      }
      if (rooms.size >= maxRooms) {
        sendError(response, 503, 'room_capacity', '当前房间数量已达上限。');
        return;
      }
      try {
        const body = await readJson(request);
        const mode = body.mode ?? 'coop';
        if (!['coop', 'solo'].includes(mode)) {
          sendError(response, 400, 'invalid_mode', 'mode 只能是 coop 或 solo。');
          return;
        }
        const code = newRoomCode(rooms);
        const game = new GameState({ code, mode, now: clock });
        const record = {
          code,
          mode,
          game,
          sessions: new Map(),
          clients: new Set(),
          createdAt: clock(),
          lastActive: clock(),
        };
        rooms.set(code, record);
        const { session } = makeSession(record, {
          name: cleanName(body.name, '先锋猎人'),
          role: 'vanguard',
        });
        if (mode === 'solo') {
          game.addPlayer({ id: `ai-${randomUUID()}`, name: '雾灯 · 莉娅', role: 'ranger', isAI: true });
        }
        sendJson(response, 201, playerResponse(record, session));
      } catch (error) {
        const status = error?.status ?? 500;
        sendError(response, status, error?.message ?? 'create_failed', status === 500 ? '创建房间失败。' : '请求内容无效。');
      }
      return;
    }

    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|events|state|input|reconnect|restart))?$/);
    if (match) {
      const code = match[1].toUpperCase();
      const action = match[2];
      if (!ROOM_CODE_PATTERN.test(code)) {
        sendError(response, 400, 'invalid_room_code', '房间码应为六位字母或数字。');
        return;
      }
      const record = rooms.get(code);
      if (!record) {
        sendError(response, 404, 'room_not_found', '房间不存在或已经过期。');
        return;
      }

      if (action === 'join' && request.method === 'POST') {
        if (record.mode !== 'coop') {
          sendError(response, 409, 'solo_room', '单人试炼房间不能加入。');
          return;
        }
        if (record.sessions.size >= 2) {
          sendError(response, 409, 'room_full', '该房间已有两名猎人。');
          return;
        }
        try {
          const body = await readJson(request);
          const { session } = makeSession(record, {
            name: cleanName(body.name, '游侠猎人'),
            role: 'ranger',
          });
          record.lastActive = clock();
          sendJson(response, 200, playerResponse(record, session));
        } catch (error) {
          const status = error?.status ?? 500;
          sendError(response, status, error?.message ?? 'join_failed', status === 500 ? '加入房间失败。' : '请求内容无效。');
        }
        return;
      }

      if (action === 'events' && request.method === 'GET') {
        const session = authenticate(record, extractCredentials(request, url));
        if (!session) {
          sendError(response, 401, 'invalid_session', '身份令牌无效，请重新加入。');
          return;
        }
        session.connected = true;
        session.sseConnections += 1;
        record.game.setConnected(session.playerId, true);
        record.lastActive = clock();
        response.writeHead(200, {
          ...securityHeaders(),
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders?.();
        response.write(`retry: 1500\nevent: state\ndata: ${JSON.stringify(record.game.snapshot())}\n\n`);
        const client = { response, session };
        record.clients.add(client);
        let closed = false;
        const disconnect = () => {
          if (closed) return;
          closed = true;
          record.clients.delete(client);
          session.sseConnections = Math.max(0, session.sseConnections - 1);
          if (session.sseConnections === 0) {
            session.connected = false;
            record.game.setConnected(session.playerId, false);
          }
        };
        request.on('close', disconnect);
        response.on('close', disconnect);
        return;
      }

      if (action === 'state' && request.method === 'GET') {
        const session = authenticate(record, extractCredentials(request, url));
        if (!session) {
          sendError(response, 401, 'invalid_session', '身份令牌无效，请重新加入。');
          return;
        }
        sendJson(response, 200, record.game.snapshot());
        return;
      }

      if (['input', 'reconnect', 'restart'].includes(action) && request.method === 'POST') {
        try {
          const body = await readJson(request);
          const session = authenticate(record, extractCredentials(request, url, body));
          if (!session) {
            sendError(response, 401, 'invalid_session', '身份令牌无效，请重新加入。');
            return;
          }
          record.lastActive = clock();

          if (action === 'input') {
            if (!rateLimitInput(session)) {
              sendError(response, 429, 'rate_limited', '输入发送过于频繁。');
              return;
            }
            const validated = validateInput(body);
            if (validated.error) {
              sendError(response, 400, 'invalid_input', validated.error);
              return;
            }
            const accepted = record.game.setInput(session.playerId, validated.value, validated.value.seq);
            sendJson(response, accepted ? 202 : 200, { accepted, seq: validated.value.seq });
            return;
          }

          if (action === 'reconnect') {
            session.connected = true;
            record.game.setConnected(session.playerId, true);
            sendJson(response, 200, playerResponse(record, session));
            return;
          }

          const transition = record.game.restartCampaign({ transitionToken: body.transitionToken });
          if (!transition.accepted) {
            sendError(response, 409, 'restart_unavailable', '换关令牌无效，或当前阶段尚未结算。');
            return;
          }
          broadcast(record);
          sendJson(response, 200, { restarted: true, ...transition, state: record.game.snapshot() });
        } catch (error) {
          const status = error?.status ?? 500;
          sendError(response, status, error?.message ?? 'request_failed', status === 500 ? '处理请求失败。' : '请求内容无效。');
        }
        return;
      }

      sendError(response, 405, 'method_not_allowed', '该操作不支持此请求方法。');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendError(response, 404, 'api_not_found', '接口不存在。');
      return;
    }

    await serveStatic(request, response, url, publicRoot);
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  server.on('listening', startTimers);
  server.on('close', stopTimers);

  return {
    server,
    rooms,
    cleanupRooms,
    async listen({ port = 0, host = '127.0.0.1' } = {}) {
      if (server.listening) return server.address();
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolveListen();
        });
      });
      return server.address();
    },
    async close() {
      for (const record of [...rooms.values()]) closeRoom(record, 'shutdown');
      stopTimers();
      if (!server.listening) return;
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

function parsePort(value) {
  const port = Number(value ?? 3000);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 3000;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const host = process.env.HOST || '127.0.0.1';
  const port = parsePort(process.env.PORT);
  const app = createGameServer();
  app.listen({ port, host })
    .then(() => {
      console.log(`雾港猎团已启动：http://${host}:${port}`);
      console.log('按 Ctrl+C 停止服务器。');
    })
    .catch((error) => {
      console.error('服务器启动失败：', error.message);
      process.exitCode = 1;
    });

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
