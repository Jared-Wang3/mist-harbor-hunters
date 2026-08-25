import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import worker, {
  GameRoom,
  deserializeGame,
  serializeGame,
  validateInput,
} from '../worker/index.mjs';
import { GameState, STATE_VERSION } from '../src/game-state.mjs';

class MemorySql {
  constructor() {
    this.room = null;
    this.sessions = new Map();
  }

  exec(query, ...bindings) {
    const normalized = query.replace(/\s+/g, ' ').trim().toUpperCase();
    if (normalized.startsWith('CREATE TABLE')) return [];
    if (normalized.startsWith('SELECT CODE, MODE')) return this.room ? [{ ...this.room }] : [];
    if (normalized.startsWith('SELECT PLAYER_ID')) {
      return [...this.sessions.values()]
        .sort((left, right) => left.created_at - right.created_at)
        .map((row) => ({ ...row }));
    }
    if (normalized.startsWith('INSERT INTO PLAYER_SESSIONS')) {
      const [player_id, token, created_at] = bindings;
      this.sessions.set(player_id, { player_id, token, created_at });
      return [];
    }
    if (normalized.startsWith('INSERT INTO ROOM_STATE')) {
      const [code, mode, created_at, last_active, game_json] = bindings;
      this.room = { code, mode, created_at, last_active, game_json };
      return [];
    }
    if (normalized.startsWith('UPDATE ROOM_STATE SET LAST_ACTIVE')) {
      if (this.room) this.room.last_active = bindings[0];
      return [];
    }
    if (normalized === 'DELETE FROM PLAYER_SESSIONS') {
      this.sessions.clear();
      return [];
    }
    if (normalized === 'DELETE FROM ROOM_STATE') {
      this.room = null;
      return [];
    }
    throw new Error(`Unexpected SQL in test: ${query}`);
  }
}

class MemoryDurableState {
  constructor(sql = new MemorySql()) {
    this.deleteAllCalls = 0;
    this.storage = {
      sql,
      alarmAt: null,
      setAlarm: async (timestamp) => { this.storage.alarmAt = timestamp; },
      deleteAlarm: async () => { this.storage.alarmAt = null; },
      deleteAll: async () => {
        this.deleteAllCalls += 1;
        sql.room = null;
        sql.sessions.clear();
        this.storage.alarmAt = null;
      },
    };
  }

  blockConcurrencyWhile(callback) {
    return callback();
  }
}

class MemoryNamespace {
  constructor() {
    this.rooms = new Map();
  }

  idFromName(name) {
    return name;
  }

  get(id) {
    if (!this.rooms.has(id)) {
      const durable = new GameRoom(new MemoryDurableState(), {});
      this.rooms.set(id, durable);
    }
    const durable = this.rooms.get(id);
    return { fetch: (request) => durable.fetch(request) };
  }

  stop() {
    for (const room of this.rooms.values()) room.stopSimulation();
  }
}

function jsonRequest(url, body, method = 'POST') {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Wrangler 使用 ASSETS 与 SQLite Durable Object migration', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.main, './worker/index.mjs');
  assert.equal(config.assets.binding, 'ASSETS');
  assert.deepEqual(config.assets.run_worker_first, ['/api/*']);
  assert.equal(config.durable_objects.bindings[0].name, 'ROOMS');
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['GameRoom'] }]);
  assert.equal('exports' in config, false);
});

test('输入校验强制序号、有限向量与布尔按键', () => {
  assert.equal(validateInput({ move: {}, aim: {} }).error.includes('seq'), true);
  assert.equal(validateInput({ seq: 1, move: { x: 2 }, aim: {} }).error.includes('move'), true);
  assert.equal(validateInput({ seq: 1, move: {}, aim: {}, attack: 'yes' }).error.includes('attack'), true);
  assert.deepEqual(validateInput({ seq: 1, move: { x: 0.5 }, aim: { y: -1 }, attack: true }).value, {
    seq: 1,
    move: { x: 0.5, y: 0 },
    aim: { x: 0, y: -1 },
    attack: true,
    interact: false,
    dodge: false,
  });
});

test('v3 三关状态的 Map/Set、等级、结算令牌可以写入 SQLite 检查点后恢复', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop' });
  game.addPlayer({ id: 'p1', role: 'vanguard' });
  game.addPlayer({ id: 'p2', role: 'ranger' });
  game._bossAdds.add(0.72);
  game.run.sealsCollected = 2;
  game.players.get('p1').level = 3;
  game._completeExpedition();
  const transitionToken = game.snapshot().stage.transitionToken;
  const gameJson = serializeGame(game);
  const restored = deserializeGame(gameJson, { code: 'ABC234', mode: 'coop' });
  assert.equal(restored.stateVersion, STATE_VERSION);
  assert.equal(restored.players instanceof Map, true);
  assert.equal(restored.players.get('p1').id, 'p1');
  assert.equal(restored.players.get('p1').level, 3);
  assert.equal(restored._bossAdds instanceof Set, true);
  assert.equal(restored._bossAdds.has(0.72), true);
  assert.equal(restored.zoneStates instanceof Map, true);
  assert.equal(restored.collectibles instanceof Map, true);
  assert.equal(restored.run.sealsCollected, 2);
  assert.equal(restored.snapshot().stage.status, 'stage_complete');
  assert.equal(restored.snapshot().stage.transitionToken, transitionToken);
});

test('v2 单关检查点安全迁移到 v3 第一关并保留玩家身份与等级成长', () => {
  const v2Json = serializeGame({
    stateVersion: 2,
    code: 'V2234A',
    mode: 'coop',
    players: new Map([
      ['v2-one', {
        id: 'v2-one', name: '旧潮先锋', role: 'vanguard', level: 4, xp: 45,
        xpToNext: 260, power: 1.3, maxHp: 186, kills: 17, revives: 2, lastSeq: 31,
      }],
      ['v2-two', {
        id: 'v2-two', name: '旧潮游侠', role: 'ranger', level: 3, xp: 15,
        xpToNext: 200, power: 1.2, maxHp: 122, kills: 9, revives: 1, lastSeq: 24,
      }],
    ]),
    enemies: new Map([['retired-enemy', { id: 'retired-enemy' }]]),
    phaseIndex: 0,
    stageStatus: 'victory',
  });
  const restored = deserializeGame(v2Json, { code: 'V2234A', mode: 'coop' });
  const state = restored.snapshot();
  assert.equal(state.stateVersion, STATE_VERSION);
  assert.equal(state.stage.id, 'stage-01');
  assert.equal(state.stage.status, 'active');
  assert.equal(restored.enemies.has('retired-enemy'), false);
  assert.deepEqual(state.players.map((player) => player.level), [4, 3]);
  assert.deepEqual(state.players.map((player) => player.xp), [45, 15]);
  assert.deepEqual(state.players.map((player) => player.kills), [17, 9]);
  assert.deepEqual(state.players.map((player) => player.revives), [2, 1]);
  assert.equal(restored.players.get('v2-one').lastSeq, 31);
});

test('v1 单屏检查点只迁移玩家身份，不会覆盖新的 v3 三关世界', () => {
  const legacyJson = serializeGame({
    code: 'OLD234',
    mode: 'coop',
    players: new Map([
      ['old-one', { id: 'old-one', name: '旧先锋', role: 'vanguard', lastSeq: 19 }],
      ['old-two', { id: 'old-two', name: '旧游侠', role: 'ranger' }],
    ]),
    enemies: new Map([['legacy-enemy', { id: 'legacy-enemy', x: 10, y: 10 }]]),
    phaseIndex: 2,
    stageStatus: 'victory',
  });
  const restored = deserializeGame(legacyJson, { code: 'OLD234', mode: 'coop' });
  const state = restored.snapshot();
  assert.equal(restored.stateVersion, STATE_VERSION);
  assert.deepEqual([...restored.players.keys()], ['old-one', 'old-two']);
  assert.equal(restored.players.get('old-one').lastSeq, 19);
  assert.equal(state.stage.id, 'stage-01');
  assert.equal(state.stage.mapKey, 'stage-01');
  assert.equal(state.stage.status, 'active');
  assert.equal(state.arena.width, 5120);
  assert.equal(restored.enemies.has('legacy-enemy'), false);
  assert.equal(state.enemies.length, 18);
});

test('Worker 完成创建、固定角色加入、令牌校验、防重放与重连', async (t) => {
  const namespace = new MemoryNamespace();
  t.after(() => namespace.stop());
  const env = { ROOMS: namespace };

  const createdResponse = await worker.fetch(jsonRequest('https://game.example/api/rooms', {
    mode: 'coop',
    name: '阿岚',
  }), env);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(created.role, 'vanguard');
  assert.equal(created.state.stage.status, 'waiting');
  assert.ok(created.token.length >= 30);

  const joinedResponse = await worker.fetch(jsonRequest(
    `https://game.example/api/rooms/${created.roomCode}/join`,
    { name: '弦月' },
  ), env);
  assert.equal(joinedResponse.status, 200);
  const joined = await joinedResponse.json();
  assert.equal(joined.role, 'ranger');
  assert.equal(joined.state.players.length, 2);
  assert.equal(joined.state.stage.status, 'active');

  const full = await worker.fetch(jsonRequest(
    `https://game.example/api/rooms/${created.roomCode}/join`,
    { name: '第三人' },
  ), env);
  assert.equal(full.status, 409);

  const input = {
    playerId: created.playerId,
    token: created.token,
    seq: 8,
    move: { x: 1, y: 0 },
    aim: { x: 1, y: 0 },
    attack: true,
    interact: false,
    dodge: false,
  };
  const accepted = await worker.fetch(jsonRequest(
    `https://game.example/api/rooms/${created.roomCode}/input`, input,
  ), env);
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).accepted, true);

  const replayed = await worker.fetch(jsonRequest(
    `https://game.example/api/rooms/${created.roomCode}/input`, input,
  ), env);
  assert.equal(replayed.status, 200);
  assert.equal((await replayed.json()).accepted, false);

  const wrongToken = await worker.fetch(new Request(
    `https://game.example/api/rooms/${created.roomCode}/state?playerId=${created.playerId}&token=wrong`,
  ), env);
  assert.equal(wrongToken.status, 401);

  const reconnect = await worker.fetch(jsonRequest(
    `https://game.example/api/rooms/${created.roomCode}/reconnect`,
    { token: created.token },
  ), env);
  assert.equal(reconnect.status, 200);
  assert.equal((await reconnect.json()).token, created.token);

  const socketWithoutUpgrade = await worker.fetch(new Request(
    `https://game.example/api/rooms/${created.roomCode}/socket?playerId=${created.playerId}&token=${created.token}`,
  ), env);
  assert.equal(socketWithoutUpgrade.status, 426);
});

test('Worker /restart 持久化幂等换关并广播下一关权威状态', async (t) => {
  const namespace = new MemoryNamespace();
  t.after(() => namespace.stop());
  const env = { ROOMS: namespace };
  const createdResponse = await worker.fetch(jsonRequest('https://game.example/api/rooms', {
    mode: 'coop',
    name: '潮门先锋',
  }), env);
  const created = await createdResponse.json();
  await worker.fetch(jsonRequest(
    'https://game.example/api/rooms/' + created.roomCode + '/join',
    { name: '潮门游侠' },
  ), env);
  const room = namespace.rooms.get(created.roomCode);
  room.game._awardPartyXp(80);
  room.game._completeExpedition();
  const transitionToken = room.game.snapshot().stage.transitionToken;

  const advancedResponse = await worker.fetch(jsonRequest(
    'https://game.example/api/rooms/' + created.roomCode + '/restart',
    { playerId: created.playerId, token: created.token, transitionToken },
  ), env);
  assert.equal(advancedResponse.status, 200);
  const advanced = await advancedResponse.json();
  assert.equal(advanced.accepted, true);
  assert.equal(advanced.action, 'advance');
  assert.equal(advanced.alreadyApplied, false);
  assert.equal(advanced.state.stage.index, 2);
  assert.equal(advanced.state.stage.mapKey, 'stage-02');
  assert.ok(advanced.state.players.every((player) => player.level === 2));
  assert.match(room.sql.room.game_json, /pendingTransitionToken/);

  const duplicateResponse = await worker.fetch(jsonRequest(
    'https://game.example/api/rooms/' + created.roomCode + '/restart',
    { playerId: created.playerId, token: created.token, transitionToken },
  ), env);
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.alreadyApplied, true);
  assert.equal(duplicate.state.stage.index, 2);
});

test('solo 创建 AI，SQLite 重建后同一 token 仍可恢复会话', async (t) => {
  const sql = new MemorySql();
  const firstState = new MemoryDurableState(sql);
  const first = new GameRoom(firstState, {});
  t.after(() => first.stopSimulation());
  const createdResponse = await first.fetch(new Request('https://room.internal/internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Code': 'SLMN22' },
    body: JSON.stringify({ mode: 'solo', name: '独行猎人' }),
  }));
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.state.players.filter((player) => player.isAI).length, 1);
  first.stopSimulation();
  first.persistRoom(true);

  const restored = new GameRoom(new MemoryDurableState(sql), {});
  t.after(() => restored.stopSimulation());
  const reconnect = await restored.fetch(jsonRequest(
    'https://game.example/api/rooms/SLMN22/reconnect',
    { playerId: created.playerId, token: created.token },
  ));
  assert.equal(reconnect.status, 200);
  const data = await reconnect.json();
  assert.equal(data.playerId, created.playerId);
  assert.equal(data.token, created.token);
  assert.equal(data.state.players.length, 2);
});

test('等待房不启动 30Hz；变为 active 才启动，最后实时连接离开即停止', async (t) => {
  const room = new GameRoom(new MemoryDurableState(), {});
  t.after(() => room.stopSimulation());
  const response = await room.fetch(new Request('https://room.internal/internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Code': 'WATT22' },
    body: JSON.stringify({ mode: 'coop', name: '守灯人' }),
  }));
  assert.equal(response.status, 201);
  const created = await response.json();
  const session = room.sessions.get(created.playerId);
  const fakeSocket = { send() {} };
  session.socketCount = 1;
  room.sockets.set(fakeSocket, { playerId: session.playerId, hibernating: true });
  room.startSimulation();
  assert.equal(room.simulationTimer, null, 'waiting 阶段应允许 WebSocket 休眠');

  const joined = await room.fetch(jsonRequest('https://game.example/api/rooms/WATT22/join', { name: '巡雾人' }));
  assert.equal(joined.status, 200);
  assert.ok(room.simulationTimer, 'active 阶段应以 30Hz 模拟');
  room.detachSocket(fakeSocket);
  assert.equal(room.simulationTimer, null, '最后实时传输断开应立即停止模拟');

  session.socketCount = 1;
  room.sockets.set(fakeSocket, { playerId: session.playerId, hibernating: true });
  room.game._completeExpedition();
  room.startSimulation();
  assert.equal(room.simulationTimer, null, 'stage_complete 应允许 WebSocket 休眠等待幂等换关请求');
  room.detachSocket(fakeSocket);
});

test('构造器遇到已过期检查点会 deleteAll，而不是只留下空 SQLite 表', async () => {
  const sql = new MemorySql();
  const firstState = new MemoryDurableState(sql);
  const first = new GameRoom(firstState, {});
  const created = await first.fetch(new Request('https://room.internal/internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Code': 'DEAD22' },
    body: JSON.stringify({ mode: 'coop', name: '旧契约' }),
  }));
  assert.equal(created.status, 201);
  sql.room.created_at = 0;
  sql.room.last_active = 0;

  const restoredState = new MemoryDurableState(sql);
  const restored = new GameRoom(restoredState, {});
  await restored.ready;
  assert.equal(restored.game, null);
  assert.equal(restoredState.deleteAllCalls, 1);
  assert.equal(restored.schemaReady, false);
  assert.equal(sql.room, null);
});

test('alarm 到期会清理 SQLite 房间；非 API 请求由 ASSETS binding 服务', async () => {
  const state = new MemoryDurableState();
  const room = new GameRoom(state, {});
  const created = await room.fetch(new Request('https://room.internal/internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Code': 'ALD234' },
    body: JSON.stringify({ mode: 'coop', name: '旧猎人' }),
  }));
  const credentials = await created.json();
  for (const session of room.sessions.values()) session.connected = false;
  room.createdAt = 0;
  room.lastActive = 0;
  await room.alarm();
  assert.equal(state.storage.sql.room, null);
  const gone = await room.fetch(new Request(
    `https://game.example/api/rooms/ALD234/state?token=${credentials.token}`,
  ));
  assert.equal(gone.status, 404);

  const asset = await worker.fetch(new Request('https://game.example/assets/cover.png'), {
    ASSETS: { fetch: async () => new Response('asset', { headers: { 'Content-Type': 'image/png' } }) },
  });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'asset');
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
});
