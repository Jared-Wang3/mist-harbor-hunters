import { GameState, TICK_RATE } from '../src/game-state.mjs';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const MAX_BODY_BYTES = 16 * 1024;
const BROADCAST_RATE = 15;
const ACTIVE_ROOM_TTL_MS = 30 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_ROOM_AGE_MS = 6 * 60 * 60 * 1000;
const CHECKPOINT_INTERVAL_MS = 2_000;
const ACTIVITY_FLUSH_INTERVAL_MS = 5_000;

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

function json(body, status = 200, extraHeaders = undefined) {
  const headers = new Headers({
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders ?? {}),
  });
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(status, code, message) {
  return json({ error: { code, message } }, status);
}

function withSecurityHeaders(response) {
  if (response.status === 101 || response.webSocket) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readJsonObject(request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('content_type'), { status: 415 });
  }
  const statedLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(statedLength) && statedLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error('body_too_large'), { status: 413 });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error('body_too_large'), { status: 413 });
  }
  try {
    const body = text ? JSON.parse(text) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('object_required');
    return body;
  } catch (error) {
    if (error?.status) throw error;
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

function cleanName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18);
  return cleaned || fallback;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function newRoomCode() {
  let code = '';
  for (const byte of randomBytes(6)) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  return code;
}

function newToken() {
  let binary = '';
  for (const byte of randomBytes(24)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function newPlayerId() {
  return crypto.randomUUID();
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index % Math.max(1, left.length)) || 0)
      ^ (right.charCodeAt(index % Math.max(1, right.length)) || 0);
  }
  return difference === 0;
}

function extractCredentials(request, url, body = undefined) {
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  return {
    playerId: body?.playerId ?? url.searchParams.get('playerId') ?? undefined,
    token: body?.token
      ?? url.searchParams.get('token')
      ?? request.headers.get('x-player-token')
      ?? bearer,
  };
}

export function validateInput(body) {
  if (!Number.isSafeInteger(body?.seq) || body.seq < 0) {
    return { error: 'seq 必须是非负安全整数。' };
  }
  const value = { seq: body.seq };
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
    value[key] = { x: vector.x ?? 0, y: vector.y ?? 0 };
  }
  for (const key of ['attack', 'interact', 'dodge']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      return { error: `${key} 必须是布尔值。` };
    }
    value[key] = body[key] === true;
  }
  return { value };
}

function encodeStructured(value) {
  if (value instanceof Map) {
    return { __mistHarborType: 'Map', entries: [...value.entries()].map(([key, item]) => [key, encodeStructured(item)]) };
  }
  if (value instanceof Set) {
    return { __mistHarborType: 'Set', values: [...value].map(encodeStructured) };
  }
  if (Array.isArray(value)) return value.map(encodeStructured);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeStructured(item)]));
  }
  return value;
}

function decodeStructured(value) {
  if (Array.isArray(value)) return value.map(decodeStructured);
  if (!value || typeof value !== 'object') return value;
  if (value.__mistHarborType === 'Map' && Array.isArray(value.entries)) {
    return new Map(value.entries.map(([key, item]) => [key, decodeStructured(item)]));
  }
  if (value.__mistHarborType === 'Set' && Array.isArray(value.values)) {
    return new Set(value.values.map(decodeStructured));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeStructured(item)]));
}

export function serializeGame(game) {
  const state = {};
  for (const [key, value] of Object.entries(game)) {
    if (key === 'rng' || key === 'now') continue;
    state[key] = encodeStructured(value);
  }
  return JSON.stringify(state);
}

export function deserializeGame(serialized, { code, mode, now = Date.now } = {}) {
  const parsed = decodeStructured(JSON.parse(serialized));
  const restoredCode = code ?? parsed?.code ?? 'LOCAL0';
  const restoredMode = mode ?? parsed?.mode ?? 'coop';
  const game = new GameState({ code: restoredCode, mode: restoredMode, now });

  if (parsed?.stateVersion === game.stateVersion) {
    Object.assign(game, parsed);
    game.normalizeRestoredState();
  } else {
    // v1/v2 checkpoints use retired world layouts. Keep reconnect identity for
    // both and safe numeric growth for v2, but start the new v3 campaign at
    // stage one instead of assigning incompatible world/objective collections.
    const migratingV2 = parsed?.stateVersion === 2;
    const legacyEntries = parsed?.players instanceof Map
      ? [...parsed.players.entries()]
      : Object.entries(parsed?.players ?? {});
    const migratedPlayers = [];
    for (const [legacyId, legacyPlayer] of legacyEntries.slice(0, 2)) {
      const id = legacyPlayer?.id ?? legacyId;
      const fallbackRole = game.players.size === 0 ? 'vanguard' : 'ranger';
      const role = ['vanguard', 'ranger'].includes(legacyPlayer?.role) ? legacyPlayer.role : fallbackRole;
      game.addPlayer({
        id,
        name: legacyPlayer?.name,
        role,
        isAI: legacyPlayer?.isAI === true,
      });
      const migrated = game.players.get(id);
      migrated.lastSeq = Number.isSafeInteger(legacyPlayer?.lastSeq) ? legacyPlayer.lastSeq : -1;
      if (!migrated.isAI) game.setConnected(id, legacyPlayer?.connected !== false);
      migratedPlayers.push([migrated, legacyPlayer]);
    }
    if (migratingV2) {
      for (const [migrated, legacyPlayer] of migratedPlayers) {
        const level = Number.isFinite(legacyPlayer?.level)
          ? Math.max(1, Math.min(50, Math.floor(legacyPlayer.level)))
          : 1;
        migrated.level = level;
        migrated.xp = Number.isFinite(legacyPlayer?.xp) ? Math.max(0, legacyPlayer.xp) : 0;
        migrated.xpToNext = Number.isFinite(legacyPlayer?.xpToNext)
          ? Math.max(1, legacyPlayer.xpToNext)
          : migrated.xpToNext;
        migrated.power = Number.isFinite(legacyPlayer?.power)
          ? Math.max(1, legacyPlayer.power)
          : 1 + (level - 1) * 0.1;
        migrated.maxHp = Number.isFinite(legacyPlayer?.maxHp)
          ? Math.max(1, legacyPlayer.maxHp)
          : migrated.maxHp;
        migrated.hp = migrated.maxHp;
        migrated.kills = Number.isFinite(legacyPlayer?.kills) ? Math.max(0, Math.floor(legacyPlayer.kills)) : 0;
        migrated.revives = Number.isFinite(legacyPlayer?.revives) ? Math.max(0, Math.floor(legacyPlayer.revives)) : 0;
      }
    }
  }

  game.code = restoredCode;
  game.mode = restoredMode;
  game.now = now;
  game.rng = Math.random;
  return game;
}

function rowsFrom(cursor) {
  if (!cursor) return [];
  if (typeof cursor.toArray === 'function') return cursor.toArray();
  return Array.from(cursor);
}

function websocketText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return '';
}

/**
 * One SQLite-backed Durable Object owns exactly one room code. The game loop is
 * deliberately kept resident while a stage is active: a 30 Hz authoritative
 * simulation cannot hibernate between WebSocket messages without losing time.
 */
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.game = null;
    this.code = null;
    this.mode = null;
    this.createdAt = 0;
    this.lastActive = 0;
    this.sessions = new Map();
    this.sockets = new Map();
    this.sseClients = new Set();
    this.simulationTimer = null;
    this.previousTickAt = 0;
    this.lastCheckpointAt = 0;
    this.lastActivityFlushAt = 0;
    this.broadcastAccumulator = 0;
    this.lastHeartbeatAt = 0;
    this.schemaReady = false;

    const initialize = async () => {
      this.createSchema();
      await this.restore();
    };
    this.ready = state.blockConcurrencyWhile
      ? state.blockConcurrencyWhile(initialize)
      : initialize();
  }

  createSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        code TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL,
        game_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS player_sessions (
        player_id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
    `);
    this.schemaReady = true;
  }

  async restore() {
    const row = rowsFrom(this.sql.exec(
      'SELECT code, mode, created_at, last_active, game_json FROM room_state WHERE singleton = 1 LIMIT 1',
    ))[0];
    if (!row) return;

    this.code = row.code;
    this.mode = row.mode;
    this.createdAt = Number(row.created_at);
    this.lastActive = Number(row.last_active);
    try {
      this.game = deserializeGame(row.game_json, { code: this.code, mode: this.mode });
    } catch {
      await this.expireRoom();
      return;
    }

    const sessionRows = rowsFrom(this.sql.exec(
      'SELECT player_id, token, created_at FROM player_sessions ORDER BY created_at ASC',
    ));
    for (const sessionRow of sessionRows) {
      const session = {
        playerId: sessionRow.player_id,
        token: sessionRow.token,
        createdAt: Number(sessionRow.created_at),
        connected: false,
        socketCount: 0,
        sseCount: 0,
        inputWindowStarted: Date.now(),
        inputCount: 0,
      };
      this.sessions.set(session.playerId, session);
      this.game.setConnected(session.playerId, false);
    }

    if (typeof this.state.getWebSockets === 'function') {
      for (const socket of this.state.getWebSockets()) {
        let attachment;
        try { attachment = socket.deserializeAttachment(); } catch { attachment = null; }
        const session = attachment?.playerId ? this.sessions.get(attachment.playerId) : null;
        if (!session) {
          try { socket.close(4001, 'invalid_session'); } catch {}
          continue;
        }
        this.sockets.set(socket, { playerId: session.playerId, hibernating: true });
        session.socketCount += 1;
        session.connected = true;
        this.game.setConnected(session.playerId, true);
      }
    }

    if (this.isExpired(Date.now())) {
      await this.expireRoom();
      return;
    }
    this.scheduleExpiration();
    if (this.hasLiveTransport() && !['waiting', 'stage_complete', 'victory'].includes(this.game.stageStatus)) {
      this.startSimulation();
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === '/internal/create' && request.method === 'POST') {
      return this.handleCreate(request);
    }

    if (!this.game || this.isExpired(Date.now())) {
      if (this.game) await this.expireRoom();
      return errorResponse(404, 'room_not_found', '房间不存在或已经过期。');
    }

    const action = url.pathname.match(/^\/api\/rooms\/[^/]+\/(join|events|state|input|reconnect|restart|socket|bot)$/)?.[1];
    if (!action) return errorResponse(404, 'api_not_found', '接口不存在。');

    if (action === 'join' && request.method === 'POST') return this.handleJoin(request);
    if (action === 'state' && request.method === 'GET') return this.handleState(request, url);
    if (action === 'input' && request.method === 'POST') return this.handleInput(request, url);
    if (action === 'reconnect' && request.method === 'POST') return this.handleReconnect(request, url);
    if (action === 'restart' && request.method === 'POST') return this.handleRestart(request, url);
    if (action === 'socket' && request.method === 'GET') return this.handleSocket(request, url);
    if (action === 'events' && request.method === 'GET') return this.handleEvents(request, url);
    if (action === 'bot' && request.method === 'POST' && this.mode === 'solo') {
      return json({ accepted: true, state: this.game.snapshot() });
    }
    return errorResponse(405, 'method_not_allowed', '该操作不支持此请求方法。');
  }

  async handleCreate(request) {
    if (!this.schemaReady) this.createSchema();
    let body;
    try {
      body = await readJsonObject(request);
    } catch (error) {
      return errorResponse(error.status ?? 400, error.message, '请求内容无效。');
    }
    const code = (request.headers.get('x-room-code') ?? '').toUpperCase();
    const mode = body.mode ?? 'coop';
    if (!ROOM_CODE_PATTERN.test(code)) return errorResponse(400, 'invalid_room_code', '房间码格式无效。');
    if (!['coop', 'solo'].includes(mode)) return errorResponse(400, 'invalid_mode', 'mode 只能是 coop 或 solo。');
    // Check after the only request-body await so two concurrent create attempts
    // cannot both observe an empty object and claim the same deterministic ID.
    if (this.game && !this.isExpired(Date.now())) {
      return errorResponse(409, 'room_exists', '房间码已经被占用。');
    }
    if (this.game) {
      await this.expireRoom();
      if (this.game) return errorResponse(409, 'room_exists', '房间码已经被占用。');
    }

    const timestamp = Date.now();
    this.code = code;
    this.mode = mode;
    this.createdAt = timestamp;
    this.lastActive = timestamp;
    this.game = new GameState({ code, mode });
    const session = this.makeSession({ name: cleanName(body.name, '先锋猎人'), role: 'vanguard' });
    if (mode === 'solo') {
      this.game.addPlayer({ id: `ai-${newPlayerId()}`, name: '雾灯 · 莉娅', role: 'ranger', isAI: true });
    }
    this.persistRoom(true);
    this.scheduleExpiration();
    return json(this.playerResponse(session), 201);
  }

  async handleJoin(request) {
    if (this.mode !== 'coop') return errorResponse(409, 'solo_room', '单人试炼房间不能加入。');
    let body;
    try {
      body = await readJsonObject(request);
    } catch (error) {
      return errorResponse(error.status ?? 400, error.message, '请求内容无效。');
    }
    // Capacity is checked after body parsing. From here through makeSession there
    // is no await, so the Durable Object cannot interleave a competing join.
    if (this.sessions.size >= 2) return errorResponse(409, 'room_full', '该房间已有两名猎人。');
    const session = this.makeSession({ name: cleanName(body.name, '游侠猎人'), role: 'ranger' });
    this.touch(session, true);
    this.persistRoom(true);
    this.startSimulation();
    this.broadcastSnapshot();
    return json(this.playerResponse(session));
  }

  async handleState(request, url) {
    const session = this.authenticate(extractCredentials(request, url));
    if (!session) return errorResponse(401, 'invalid_session', '身份令牌无效，请重新加入。');
    return json(this.game.snapshot());
  }

  async handleInput(request, url) {
    let body;
    try {
      body = await readJsonObject(request);
    } catch (error) {
      return errorResponse(error.status ?? 400, error.message, '请求内容无效。');
    }
    const session = this.authenticate(extractCredentials(request, url, body));
    if (!session) return errorResponse(401, 'invalid_session', '身份令牌无效，请重新加入。');
    if (!this.rateLimitInput(session)) return errorResponse(429, 'rate_limited', '输入发送过于频繁。');
    const validated = validateInput(body);
    if (validated.error) return errorResponse(400, 'invalid_input', validated.error);
    const accepted = this.game.setInput(session.playerId, validated.value, validated.value.seq);
    this.touch(session, true);
    return json({ accepted, seq: validated.value.seq }, accepted ? 202 : 200);
  }

  async handleReconnect(request, url) {
    let body;
    try {
      body = await readJsonObject(request);
    } catch (error) {
      return errorResponse(error.status ?? 400, error.message, '请求内容无效。');
    }
    const session = this.authenticate(extractCredentials(request, url, body));
    if (!session) return errorResponse(401, 'invalid_session', '身份令牌无效，请重新加入。');
    this.touch(session, true);
    this.game.setConnected(session.playerId, true);
    this.persistRoom(true);
    this.startSimulation();
    return json(this.playerResponse(session));
  }

  async handleRestart(request, url) {
    let body;
    try {
      body = await readJsonObject(request);
    } catch (error) {
      return errorResponse(error.status ?? 400, error.message, '请求内容无效。');
    }
    const session = this.authenticate(extractCredentials(request, url, body));
    if (!session) return errorResponse(401, 'invalid_session', '身份令牌无效，请重新加入。');
    const transition = this.game.restartCampaign({ transitionToken: body.transitionToken });
    if (!transition.accepted) {
      return errorResponse(409, 'restart_unavailable', '换关令牌无效，或当前阶段尚未结算。');
    }
    this.touch(session, true);
    this.persistRoom(true);
    this.startSimulation();
    this.broadcastSnapshot();
    return json({ restarted: true, ...transition, state: this.game.snapshot() });
  }

  handleSocket(request, url) {
    if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
      return errorResponse(426, 'upgrade_required', '该接口需要 WebSocket Upgrade。');
    }
    const credentials = extractCredentials(request, url);
    if (typeof credentials.playerId !== 'string' || typeof credentials.token !== 'string') {
      return errorResponse(401, 'invalid_session', '身份令牌无效，请重新加入。');
    }
    const session = this.authenticate(credentials);
    if (!session) return errorResponse(401, 'invalid_session', '身份令牌无效，请重新加入。');
    if (typeof WebSocketPair !== 'function') {
      return errorResponse(501, 'websocket_unavailable', '当前运行环境不支持 WebSocket。');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const canHibernate = typeof this.state.acceptWebSocket === 'function';
    if (canHibernate) {
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ playerId: session.playerId });
    } else {
      server.accept();
    }
    this.sockets.set(server, { playerId: session.playerId, hibernating: canHibernate });
    session.socketCount += 1;
    this.touch(session, true);
    this.game.setConnected(session.playerId, true);

    if (!canHibernate) {
      server.addEventListener('message', (event) => {
        this.handleSocketMessage(server, event).catch(() => {
          try { server.close(1011, 'message_failed'); } catch {}
        });
      });
      const close = () => this.detachSocket(server);
      server.addEventListener('close', close);
      server.addEventListener('error', close);
    }
    server.send(JSON.stringify({ type: 'state', state: this.game.snapshot() }));
    this.startSimulation();

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: SECURITY_HEADERS,
    });
  }

  async handleSocketMessage(socket, event) {
    let metadata = this.sockets.get(socket);
    if (!metadata && typeof socket.deserializeAttachment === 'function') {
      try {
        const attachment = socket.deserializeAttachment();
        if (attachment?.playerId) {
          metadata = { playerId: attachment.playerId, hibernating: true };
          this.sockets.set(socket, metadata);
        }
      } catch {}
    }
    if (!metadata) return;
    const text = websocketText(event.data);
    if (!text || new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      socket.send(JSON.stringify({ type: 'error', error: { code: 'invalid_message' } }));
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      socket.send(JSON.stringify({ type: 'error', error: { code: 'invalid_json' } }));
      return;
    }
    const session = this.sessions.get(metadata.playerId);
    if (!session) {
      socket.close(4001, 'invalid_session');
      return;
    }
    if (message.type === 'ping') {
      this.touch(session, true);
      socket.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));
      return;
    }
    if (message.type === 'restart') {
      const transition = this.game.restartCampaign({ transitionToken: message.transitionToken });
      if (transition.accepted) {
        this.touch(session, true);
        this.persistRoom(true);
        this.startSimulation();
        this.broadcastSnapshot();
      }
      socket.send(JSON.stringify({
        type: 'restart', restarted: transition.accepted, ...transition, state: this.game.snapshot(),
      }));
      return;
    }
    const candidate = message.type === 'input' ? (message.input ?? message) : message;
    const validated = validateInput(candidate);
    if (validated.error || !this.rateLimitInput(session)) {
      socket.send(JSON.stringify({
        type: 'ack',
        accepted: false,
        seq: candidate?.seq,
        error: validated.error ? 'invalid_input' : 'rate_limited',
      }));
      return;
    }
    const accepted = this.game.setInput(session.playerId, validated.value, validated.value.seq);
    this.touch(session, true);
    socket.send(JSON.stringify({ type: 'ack', accepted, seq: validated.value.seq }));
  }

  async webSocketMessage(socket, message) {
    await this.ready;
    return this.handleSocketMessage(socket, { data: message });
  }

  async webSocketClose(socket) {
    await this.ready;
    this.detachSocket(socket);
  }

  async webSocketError(socket) {
    await this.ready;
    this.detachSocket(socket);
  }

  handleEvents(request, url) {
    const session = this.authenticate(extractCredentials(request, url));
    if (!session) return errorResponse(401, 'invalid_session', '身份令牌无效，请重新加入。');
    if (typeof TransformStream !== 'function') {
      return errorResponse(501, 'stream_unavailable', '当前运行环境不支持事件流。');
    }
    const stream = new TransformStream();
    const client = {
      playerId: session.playerId,
      writer: stream.writable.getWriter(),
      pending: false,
      queuedPayload: null,
      closed: false,
    };
    this.sseClients.add(client);
    session.sseCount += 1;
    this.touch(session, true);
    this.game.setConnected(session.playerId, true);
    this.writeSse(client, `retry: 1500\nevent: state\ndata: ${JSON.stringify(this.game.snapshot())}\n\n`);
    this.startSimulation();
    request.signal?.addEventListener('abort', () => this.detachSse(client), { once: true });
    return new Response(stream.readable, {
      headers: {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  }

  makeSession({ name, role }) {
    const timestamp = Date.now();
    const playerId = newPlayerId();
    const session = {
      playerId,
      token: newToken(),
      createdAt: timestamp,
      connected: true,
      socketCount: 0,
      sseCount: 0,
      inputWindowStarted: timestamp,
      inputCount: 0,
    };
    this.game.addPlayer({ id: playerId, name, role });
    this.sessions.set(playerId, session);
    this.sql.exec(
      'INSERT INTO player_sessions (player_id, token, created_at) VALUES (?, ?, ?)',
      playerId,
      session.token,
      timestamp,
    );
    return session;
  }

  authenticate(credentials) {
    if (typeof credentials?.token !== 'string') return null;
    if (typeof credentials.playerId === 'string') {
      const session = this.sessions.get(credentials.playerId);
      return session && constantTimeEqual(session.token, credentials.token) ? session : null;
    }
    for (const session of this.sessions.values()) {
      if (constantTimeEqual(session.token, credentials.token)) return session;
    }
    return null;
  }

  playerResponse(session) {
    const player = this.game.players.get(session.playerId);
    return {
      roomCode: this.code,
      playerId: session.playerId,
      token: session.token,
      role: player.role,
      mode: this.mode,
      state: this.game.snapshot(),
    };
  }

  rateLimitInput(session) {
    const timestamp = Date.now();
    if (timestamp - session.inputWindowStarted >= 1_000) {
      session.inputWindowStarted = timestamp;
      session.inputCount = 0;
    }
    session.inputCount += 1;
    return session.inputCount <= 90;
  }

  touch(session, connected = false) {
    const timestamp = Date.now();
    this.lastActive = timestamp;
    if (session && connected) {
      session.connected = true;
      this.game.setConnected(session.playerId, true);
    }
    if (timestamp - this.lastActivityFlushAt >= ACTIVITY_FLUSH_INTERVAL_MS) {
      this.sql.exec('UPDATE room_state SET last_active = ? WHERE singleton = 1', timestamp);
      this.lastActivityFlushAt = timestamp;
      this.scheduleExpiration();
    }
  }

  persistRoom(force = false) {
    if (!this.game) return;
    const timestamp = Date.now();
    if (!force && timestamp - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
    this.sql.exec(
      `INSERT INTO room_state (singleton, code, mode, created_at, last_active, game_json)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         code = excluded.code,
         mode = excluded.mode,
         created_at = excluded.created_at,
         last_active = excluded.last_active,
         game_json = excluded.game_json`,
      this.code,
      this.mode,
      this.createdAt,
      this.lastActive,
      serializeGame(this.game),
    );
    this.lastCheckpointAt = timestamp;
    this.lastActivityFlushAt = timestamp;
  }

  startSimulation() {
    if (
      this.simulationTimer
      || !this.game
      || !this.hasLiveTransport()
      || ['waiting', 'stage_complete', 'victory'].includes(this.game.stageStatus)
    ) return;
    this.previousTickAt = Date.now();
    this.broadcastAccumulator = 0;
    this.simulationTimer = setInterval(() => this.simulationStep(), 1_000 / TICK_RATE);
    this.simulationTimer.unref?.();
  }

  stopSimulation() {
    if (!this.simulationTimer) return;
    clearInterval(this.simulationTimer);
    this.simulationTimer = null;
  }

  simulationStep() {
    if (!this.game) {
      this.stopSimulation();
      return;
    }
    const timestamp = Date.now();
    const measured = (timestamp - this.previousTickAt) / 1_000;
    this.previousTickAt = timestamp;
    const delta = measured > 0 && measured < 0.25 ? measured : 1 / TICK_RATE;
    this.game.update(delta);
    this.broadcastAccumulator += delta;
    if (this.broadcastAccumulator >= 1 / BROADCAST_RATE) {
      this.broadcastAccumulator %= 1 / BROADCAST_RATE;
      this.broadcastSnapshot();
    }
    this.persistRoom(false);
    if (['stage_complete', 'victory'].includes(this.game.stageStatus)) {
      this.persistRoom(true);
      this.broadcastSnapshot();
      this.stopSimulation();
    }
  }

  broadcastSnapshot() {
    if (!this.game) return;
    const snapshot = this.game.snapshot();
    const websocketPayload = JSON.stringify({ type: 'state', state: snapshot });
    for (const socket of this.sockets.keys()) {
      try { socket.send(websocketPayload); } catch { this.detachSocket(socket); }
    }
    const ssePayload = `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of this.sseClients) this.writeSse(client, ssePayload);

    const timestamp = Date.now();
    if (timestamp - this.lastHeartbeatAt >= 15_000) {
      this.lastHeartbeatAt = timestamp;
      for (const client of this.sseClients) this.writeSse(client, `: heartbeat ${timestamp}\n\n`);
    }
  }

  writeSse(client, payload) {
    if (client.closed) return;
    if (client.pending) {
      client.queuedPayload = payload;
      return;
    }
    client.pending = true;
    client.writer.write(new TextEncoder().encode(payload))
      .then(() => {
        client.pending = false;
        const queued = client.queuedPayload;
        client.queuedPayload = null;
        if (queued) this.writeSse(client, queued);
      })
      .catch(() => this.detachSse(client));
  }

  detachSocket(socket) {
    const metadata = this.sockets.get(socket);
    if (!metadata) return;
    this.sockets.delete(socket);
    const session = this.sessions.get(metadata.playerId);
    if (!session) return;
    session.socketCount = Math.max(0, session.socketCount - 1);
    this.updateConnectionAfterDetach(session);
  }

  detachSse(client) {
    if (client.closed) return;
    client.closed = true;
    this.sseClients.delete(client);
    try { client.writer.close().catch(() => {}); } catch {}
    const session = this.sessions.get(client.playerId);
    if (!session) return;
    session.sseCount = Math.max(0, session.sseCount - 1);
    this.updateConnectionAfterDetach(session);
  }

  updateConnectionAfterDetach(session) {
    if (session.socketCount > 0 || session.sseCount > 0) return;
    session.connected = false;
    this.game?.setConnected(session.playerId, false);
    this.persistRoom(true);
    if (!this.hasLiveTransport()) this.stopSimulation();
    this.scheduleExpiration();
  }

  hasLiveTransport() {
    return this.sockets.size > 0 || this.sseClients.size > 0;
  }

  hasConnectedHuman() {
    return this.hasLiveTransport();
  }

  expiresAt() {
    const idleTtl = this.hasConnectedHuman() ? ACTIVE_ROOM_TTL_MS : EMPTY_ROOM_TTL_MS;
    return Math.min(this.lastActive + idleTtl, this.createdAt + MAX_ROOM_AGE_MS);
  }

  isExpired(timestamp) {
    return Boolean(this.game) && timestamp >= this.expiresAt();
  }

  scheduleExpiration() {
    if (!this.game || typeof this.state.storage.setAlarm !== 'function') return;
    this.state.storage.setAlarm(this.expiresAt());
  }

  async alarm() {
    await this.ready;
    if (!this.game) return;
    if (this.isExpired(Date.now())) await this.expireRoom();
    else this.scheduleExpiration();
  }

  async expireRoom() {
    for (const socket of this.sockets.keys()) {
      try { socket.close(4000, 'room_expired'); } catch {}
    }
    for (const client of this.sseClients) {
      this.writeSse(client, `event: expired\ndata: ${JSON.stringify({ roomCode: this.code })}\n\n`);
      this.detachSse(client);
    }
    this.stopSimulation();
    this.clearStoredRoom();
    if (typeof this.state.storage.deleteAll === 'function') {
      await this.state.storage.deleteAll();
      this.schemaReady = false;
    } else if (typeof this.state.storage.deleteAlarm === 'function') {
      await this.state.storage.deleteAlarm();
    }
  }

  clearStoredRoom() {
    if (this.schemaReady) {
      this.sql.exec('DELETE FROM player_sessions');
      this.sql.exec('DELETE FROM room_state');
    }
    this.game = null;
    this.code = null;
    this.mode = null;
    this.createdAt = 0;
    this.lastActive = 0;
    this.sessions.clear();
    this.sockets.clear();
    this.sseClients.clear();
  }
}

async function createRoom(request, env) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch (error) {
    return errorResponse(error.status ?? 400, error.message, '请求内容无效。');
  }
  const mode = body.mode ?? 'coop';
  if (!['coop', 'solo'].includes(mode)) return errorResponse(400, 'invalid_mode', 'mode 只能是 coop 或 solo。');
  if (!env.ROOMS) return errorResponse(503, 'rooms_binding_missing', '房间服务尚未配置。');

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = newRoomCode();
    const id = env.ROOMS.idFromName(code);
    const stub = env.ROOMS.get(id);
    const response = await stub.fetch(new Request('https://room.internal/internal/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Room-Code': code },
      body: JSON.stringify({ ...body, mode }),
    }));
    if (response.status !== 409) return withSecurityHeaders(response);
  }
  return errorResponse(503, 'room_code_exhausted', '暂时无法分配房间码，请重试。');
}

async function routeApi(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...SECURITY_HEADERS, Allow: 'GET, HEAD, POST, OPTIONS' },
    });
  }
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({
      ok: true,
      rooms: null,
      tickRate: TICK_RATE,
      broadcastRate: BROADCAST_RATE,
      platform: 'cloudflare-workers',
    });
  }
  if (url.pathname === '/api/rooms' && request.method === 'POST') return createRoom(request, env);

  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|events|state|input|reconnect|restart|socket|bot))?$/);
  if (!match) return errorResponse(404, 'api_not_found', '接口不存在。');
  const code = match[1].toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) return errorResponse(400, 'invalid_room_code', '房间码应为六位字母或数字。');
  if (!match[2]) return errorResponse(405, 'method_not_allowed', '该操作不支持此请求方法。');
  if (!env.ROOMS) return errorResponse(503, 'rooms_binding_missing', '房间服务尚未配置。');
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  return withSecurityHeaders(await stub.fetch(request));
}

export const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return routeApi(request, env);
    if (!env.ASSETS) return errorResponse(503, 'assets_binding_missing', '静态资源尚未配置。');
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

export default worker;
