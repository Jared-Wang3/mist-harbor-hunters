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
  assert.equal(validateInput({ seq: 1, move: {}, aim: {}, skill: 'yes' }).error.includes('skill'), true);
  assert.deepEqual(validateInput({ seq: 1, move: { x: 0.5 }, aim: { y: -1 }, attack: true }).value, {
    seq: 1,
    move: { x: 0.5, y: 0 },
    aim: { x: 0, y: -1 },
    attack: true,
    interact: false,
    dodge: false,
    skill: false,
  });
});

test('v4 三关状态的 Map/Set、遭遇计划、等级与结算令牌可以写入 SQLite 检查点后恢复', () => {
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
  assert.equal(restored.encounterPlan instanceof Map, true);
  assert.equal(restored.encounterQueues instanceof Map, true);
  assert.equal(restored.encounterSeed, game.encounterSeed);
  assert.deepEqual([...restored.encounterPlan], [...game.encounterPlan]);
  assert.deepEqual([...restored.encounterQueues], [...game.encounterQueues]);
  assert.equal(restored.run.sealsCollected, 2);
  assert.equal(restored.snapshot().stage.status, 'stage_complete');
  assert.equal(restored.snapshot().stage.transitionToken, transitionToken);
});

test('v3 检查点原地迁移到 v4，保留战局实体并采用新成长曲线', () => {
  const legacy = new GameState({ code: 'V3234A', mode: 'coop', rng: () => 0.2 });
  legacy.addPlayer({ id: 'v3-one', name: '旧潮重刃', role: 'vanguard' });
  legacy.addPlayer({ id: 'v3-two', name: '旧潮枪手', role: 'ranger' });
  const player = legacy.players.get('v3-one');
  player.level = 3;
  player.power = 1.2;
  player.maxHp = 174;
  player.hp = 87;
  const enemyIds = [...legacy.enemies.keys()];
  legacy.stateVersion = 3;
  delete legacy.encounterPlan;
  delete legacy.encounterQueues;
  delete legacy.encounterSeed;
  delete legacy.stageSerial;

  const restored = deserializeGame(serializeGame(legacy), { code: 'V3234A', mode: 'coop' });
  assert.equal(restored.stateVersion, STATE_VERSION);
  assert.deepEqual([...restored.enemies.keys()], enemyIds);
  assert.equal(restored.players.get('v3-one').power, 1.12);
  assert.equal(restored.players.get('v3-one').maxHp, 165);
  assert.equal(restored.players.get('v3-one').hp, 82.5);
  assert.equal(restored.encounterPlan instanceof Map, true);
  assert.equal(restored.encounterQueues instanceof Map, true);
  assert.ok([...restored.encounterQueues.values()].every((queue) => queue.length === 0));
});

test('v2 单关检查点安全迁移到 v4 第一关并保留玩家身份与等级成长', () => {
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
  assert.equal(restored.players.get('v2-one').power, 1.18);
  assert.equal(restored.players.get('v2-one').maxHp, 173);
});

test('v1 单屏检查点只迁移玩家身份，不会覆盖新的 v4 三关世界', () => {
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
  assert.equal(state.enemies.length, 21);
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
    skill: true,
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

test('无实时传输时 /input + /state 轮询推进 active 房间且保持等待房休眠', async (t) => {
  const activeRoom = new GameRoom(new MemoryDurableState(), {});
  const waitingRoom = new GameRoom(new MemoryDurableState(), {});
  t.after(() => {
    activeRoom.stopSimulation();
    waitingRoom.stopSimulation();
  });

  const activeResponse = await activeRoom.fetch(new Request('https://room.internal/internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Code': 'PALL22' },
    body: JSON.stringify({ mode: 'solo', name: '巡雾人' }),
  }));
  const active = await activeResponse.json();
  let now = 1_000;
  activeRoom.clock = () => now;
  const inputResponse = await activeRoom.fetch(jsonRequest(
    'https://game.example/api/rooms/PALL22/input',
    {
      playerId: active.playerId,
      token: active.token,
      seq: 1,
      move: { x: 1, y: 0 },
      aim: { x: 1, y: 0 },
      attack: false,
      interact: false,
      dodge: false,
      skill: false,
    },
  ));
  assert.equal(inputResponse.status, 202);
  assert.equal(activeRoom.simulationTimer, null, 'poll-only 房间不能常驻 30Hz 计时器');

  now += 100;
  const stateResponse = await activeRoom.fetch(new Request(
    `https://game.example/api/rooms/PALL22/state?playerId=${active.playerId}&token=${active.token}`,
  ));
  const state = await stateResponse.json();
  assert.equal(state.tick, 3, '100ms 轮询间隔应追赶三个固定步长');
  assert.equal(state.players.find((player) => player.id === active.playerId).lastProcessedInputSeq, 1);
  assert.equal(activeRoom.simulationTimer, null, '请求驱动推进后 Durable Object 仍应允许休眠');

  const waitingResponse = await waitingRoom.fetch(new Request('https://room.internal/internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Code': 'WATT23' },
    body: JSON.stringify({ mode: 'coop', name: '守灯人' }),
  }));
  const waiting = await waitingResponse.json();
  waitingRoom.clock = () => now;
  await waitingRoom.fetch(new Request(
    `https://game.example/api/rooms/WATT23/state?playerId=${waiting.playerId}&token=${waiting.token}`,
  ));
  now += 100;
  const waitingStateResponse = await waitingRoom.fetch(new Request(
    `https://game.example/api/rooms/WATT23/state?playerId=${waiting.playerId}&token=${waiting.token}`,
  ));
  const waitingState = await waitingStateResponse.json();
  assert.equal(waitingState.stage.status, 'waiting');
  assert.equal(waitingState.tick, 0, 'waiting 阶段不能被轮询推进');
  assert.equal(waitingRoom.simulationTimer, null, 'waiting 阶段应保持 Durable Object 休眠策略');
});

test('Worker 断连后 /state 恢复 waiting/active HTTP fallback 且不覆盖既有输入', async (t) => {
  const waitingRoom = new GameRoom(new MemoryDurableState(), {});
  const activeRoom = new GameRoom(new MemoryDurableState(), {});
  t.after(() => {
    waitingRoom.stopSimulation();
    activeRoom.stopSimulation();
  });
  const waitingCreated = await (await waitingRoom.fetch(new Request('https://room.internal/internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Code': 'FALL22' },
    body: JSON.stringify({ mode: 'coop', name: '候潮人' }),
  }))).json();
  const waitingSession = waitingRoom.sessions.get(waitingCreated.playerId);
  waitingSession.connected = false;
  waitingRoom.game.setConnected(waitingCreated.playerId, false);
  const waitingInactiveAt = Date.now() - 4 * 60_000;
  waitingRoom.lastActive = waitingInactiveAt;
  const waitingState = await (await waitingRoom.fetch(new Request(
    `https://game.example/api/rooms/FALL22/state?playerId=${waitingCreated.playerId}&token=${waitingCreated.token}`,
  ))).json();
  assert.equal(waitingSession.connected, true);
  assert.equal(waitingState.players.find((player) => player.id === waitingCreated.playerId).connected, true);
  assert.ok(waitingRoom.lastActive > waitingInactiveAt, 'waiting 状态轮询应刷新活动时间');
  assert.equal(waitingRoom.isExpired(Date.now() + 2 * 60_000), false, '活跃轮询房不能沿用断连前的空房期限');
  assert.equal(waitingRoom.simulationTimer, null);

  const activeCreated = await (await activeRoom.fetch(new Request('https://room.internal/internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Code': 'FALL23' },
    body: JSON.stringify({ mode: 'solo', name: '巡潮人' }),
  }))).json();
  const activeSession = activeRoom.sessions.get(activeCreated.playerId);
  const activePlayer = activeRoom.game.players.get(activeCreated.playerId);
  activeRoom.game.setInput(activeCreated.playerId, {
    move: { x: 1, y: 0 },
    aim: { x: 1, y: 0 },
    attack: false,
    interact: true,
    dodge: false,
    skill: false,
  }, 1);
  const existingInput = structuredClone(activePlayer.input);
  activeSession.connected = false;
  activePlayer.connected = false;
  const activeInactiveAt = Date.now() - 4 * 60_000;
  activeRoom.lastActive = activeInactiveAt;
  let now = 1_000;
  activeRoom.clock = () => now;
  const activeStateUrl = `https://game.example/api/rooms/FALL23/state?playerId=${activeCreated.playerId}&token=${activeCreated.token}`;
  const activeState = await (await activeRoom.fetch(new Request(activeStateUrl))).json();
  assert.equal(activeSession.connected, true);
  assert.equal(activeState.players.find((player) => player.id === activeCreated.playerId).connected, true);
  assert.deepEqual(activePlayer.input, existingInput, '恢复 connected 不能清空已接受的移动/互动输入');
  assert.ok(activeRoom.lastActive > activeInactiveAt, 'active 状态轮询应刷新活动时间');
  assert.equal(activeRoom.isExpired(Date.now() + 2 * 60_000), false);
  assert.equal(activeRoom.simulationTimer, null);

  now += 100;
  const advanced = await (await activeRoom.fetch(new Request(activeStateUrl))).json();
  assert.equal(advanced.tick - activeState.tick, 3, '恢复连接不应破坏 poll-only 固定步长时钟');
});

test('poll-only 终局等待后换关会重置时钟且只推进换关后的真实时间', async (t) => {
  const room = new GameRoom(new MemoryDurableState(), {});
  t.after(() => room.stopSimulation());
  const createdResponse = await room.fetch(new Request('https://room.internal/internal/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Code': 'RSET22' },
    body: JSON.stringify({ mode: 'solo', name: '守潮人' }),
  }));
  const created = await createdResponse.json();
  let now = 1_000;
  room.clock = () => now;
  const stateUrl = `https://game.example/api/rooms/RSET22/state?playerId=${created.playerId}&token=${created.token}`;
  await room.fetch(new Request(stateUrl));

  room.game._completeExpedition();
  room.stopSimulation();
  room.simulationAccumulator = 0.02;
  room.broadcastAccumulator = 0.04;
  const transitionToken = room.game.snapshot().stage.transitionToken;
  now += 60_000;
  const restartedResponse = await room.fetch(jsonRequest(
    'https://game.example/api/rooms/RSET22/restart',
    { playerId: created.playerId, token: created.token, transitionToken },
  ));
  const restarted = await restartedResponse.json();
  assert.equal(restartedResponse.status, 200);
  assert.equal(restarted.accepted, true);
  assert.equal(restarted.alreadyApplied, false);
  const tickAfterRestart = restarted.state.tick;
  const rebasedAt = room.previousTickAt;
  const restartSimulationAccumulator = room.simulationAccumulator;
  const restartBroadcastAccumulator = room.broadcastAccumulator;

  now += 100;
  const polled = await (await room.fetch(new Request(stateUrl))).json();
  assert.equal(polled.tick - tickAfterRestart, 3, '首次 poll 只能推进换关后真实经过的 100ms');
  assert.equal(rebasedAt, now - 100, '换关成功时应立即重建模拟时钟基线');
  assert.equal(restartSimulationAccumulator, 0);
  assert.equal(restartBroadcastAccumulator, 0);
  assert.equal(room.simulationTimer, null, 'poll-only 换关后仍应允许 Durable Object 休眠');
});

test('Durable Object 固定步长追赶 100ms/250ms 延迟且限制单轮追赶量', async () => {
  const room = new GameRoom(new MemoryDurableState(), {});
  await room.ready;
  let now = 1_000;
  const deltas = [];
  let broadcasts = 0;
  room.clock = () => now;
  room.game = {
    stageStatus: 'active',
    update: (delta) => deltas.push(delta),
  };
  room.persistRoom = () => {};
  room.broadcastSnapshot = () => { broadcasts += 1; };

  const runDelayedFrame = (elapsedMs) => {
    deltas.length = 0;
    broadcasts = 0;
    room.previousTickAt = now;
    room.simulationAccumulator = 0;
    room.broadcastAccumulator = 0;
    now += elapsedMs;
    return room.simulationStep();
  };

  const hundredMs = runDelayedFrame(100);
  assert.equal(deltas.length, 3, '100ms 延迟应追赶三个 30Hz 固定步长');
  assert.ok(deltas.every((delta) => Math.abs(delta - 1 / 30) < 1e-9));
  assert.ok(Math.abs(hundredMs.simulatedSeconds + hundredMs.pendingSeconds - 0.1) < 1e-9);
  assert.equal(broadcasts, 1, '广播累计应跟随已模拟步长');

  const quarterSecond = runDelayedFrame(250);
  assert.equal(deltas.length, 7, '250ms 延迟应执行七步并保留不足一步的余量');
  assert.ok(Math.abs(quarterSecond.simulatedSeconds + quarterSecond.pendingSeconds - 0.25) < 1e-9);

  const capped = runDelayedFrame(2_000);
  assert.equal(deltas.length, 8, '长时间停顿单轮最多追赶八步');
  assert.ok(deltas.every((delta) => Math.abs(delta - 1 / 30) < 1e-9), '追赶不得传入巨型 dt');
  assert.ok(capped.simulatedSeconds <= 8 / 30 + 1e-9);
  assert.ok(capped.droppedSeconds > 1.7, '超过安全窗口的陈旧时间必须丢弃');
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
