import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from '../server.mjs';

let temporaryPublic;
let app;
let baseUrl;

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { response, json };
}

async function disconnectLastSse(session) {
  const controller = new AbortController();
  const query = new URLSearchParams({ playerId: session.playerId, token: session.token });
  const response = await fetch(`${baseUrl}/api/rooms/${session.roomCode}/events?${query}`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await reader.cancel().catch(() => {});

  const record = app.rooms.get(session.roomCode);
  const storedSession = record.sessions.get(session.playerId);
  for (let attempt = 0; attempt < 50 && storedSession.connected; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
  assert.equal(storedSession.connected, false, '最后一个 SSE 断开后应进入离线状态');
  assert.equal(record.game.players.get(session.playerId).connected, false);
  return { record, storedSession };
}

before(async () => {
  temporaryPublic = await mkdtemp(join(tmpdir(), 'mist-harbor-test-'));
  await writeFile(join(temporaryPublic, 'index.html'), '<!doctype html><title>雾港猎团</title>', 'utf8');
  app = createGameServer({ publicDir: temporaryPublic, cleanupIntervalMs: 60_000 });
  const address = await app.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app?.close();
  await rm(temporaryPublic, { recursive: true, force: true });
});

test('静态首页、健康检查与路径保护可用', async () => {
  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /雾港猎团/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).tickRate, 30);

  const traversal = await fetch(`${baseUrl}/%2e%2e%2fserver.mjs`);
  assert.equal(traversal.status, 403);
});

test('创建、加入、满房、输入防重放与令牌重连形成完整合作流程', async () => {
  const created = await post('/api/rooms', { mode: 'coop', name: '阿岚' });
  assert.equal(created.response.status, 201);
  assert.match(created.json.roomCode, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(created.json.role, 'vanguard');
  assert.equal(created.json.state.stage.status, 'waiting');
  assert.ok(created.json.token.length >= 30);

  const joined = await post(`/api/rooms/${created.json.roomCode}/join`, { name: '弦月' });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.json.role, 'ranger');
  assert.equal(joined.json.state.stage.status, 'active');
  assert.equal(joined.json.state.stage.title, '晴潮雾港');
  assert.equal(joined.json.state.stage.id, 'stage-01');
  assert.equal(joined.json.state.stage.mapKey, 'stage-01');
  assert.equal(joined.json.state.arena.width, 5120);
  assert.equal(joined.json.state.collectibles.filter((item) => item.kind === 'seal').length, 3);
  assert.ok(joined.json.state.surfaceZones.length > 0);
  assert.ok(Array.isArray(joined.json.state.movementZones));
  assert.ok(joined.json.state.ambientEmitters.length > 0);
  assert.equal(joined.json.state.players.length, 2);

  const full = await post(`/api/rooms/${created.json.roomCode}/join`, { name: '第三人' });
  assert.equal(full.response.status, 409);
  assert.equal(full.json.error.code, 'room_full');

  const inputBody = {
    playerId: created.json.playerId,
    token: created.json.token,
    seq: 1,
    move: { x: 1, y: 0 },
    aim: { x: 1, y: 0 },
    attack: true,
    interact: false,
    dodge: false,
    skill: true,
  };
  const accepted = await post(`/api/rooms/${created.json.roomCode}/input`, inputBody);
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.json.accepted, true);
  const replayed = await post(`/api/rooms/${created.json.roomCode}/input`, inputBody);
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.json.accepted, false);
  const invalidSkill = await post(`/api/rooms/${created.json.roomCode}/input`, {
    ...inputBody,
    seq: 2,
    skill: 'yes',
  });
  assert.equal(invalidSkill.response.status, 400);
  assert.equal(invalidSkill.json.error.code, 'invalid_input');

  const invalidToken = await fetch(
    `${baseUrl}/api/rooms/${created.json.roomCode}/state?playerId=${created.json.playerId}&token=wrong`,
  );
  assert.equal(invalidToken.status, 401);

  const stateResponse = await fetch(
    `${baseUrl}/api/rooms/${created.json.roomCode}/state?token=${encodeURIComponent(created.json.token)}`,
  );
  assert.equal(stateResponse.status, 200, '只给 token 时也应识别玩家');
  const state = await stateResponse.json();
  assert.equal(state.room.code, created.json.roomCode);
  assert.ok(Array.isArray(state.enemies));
  assert.ok(Array.isArray(state.projectiles));

  const reconnected = await post(`/api/rooms/${created.json.roomCode}/reconnect`, {
    playerId: created.json.playerId,
    token: created.json.token,
  });
  assert.equal(reconnected.response.status, 200);
  assert.equal(reconnected.json.playerId, created.json.playerId);
  assert.equal(reconnected.json.token, created.json.token);
});

test('Node /restart 使用结算令牌幂等推进下一关并保留成长', async () => {
  const created = await post('/api/rooms', { mode: 'coop', name: '换潮先锋' });
  await post('/api/rooms/' + created.json.roomCode + '/join', { name: '换潮游侠' });
  const record = app.rooms.get(created.json.roomCode);
  record.game._awardPartyXp(80);
  record.game._completeExpedition();
  const completed = record.game.snapshot();
  const transitionToken = completed.stage.transitionToken;
  assert.equal(completed.stage.status, 'stage_complete');

  const stale = await post('/api/rooms/' + created.json.roomCode + '/restart', {
    playerId: created.json.playerId,
    token: created.json.token,
    transitionToken: 'stale-token',
  });
  assert.equal(stale.response.status, 409);
  assert.equal(record.game.snapshot().stage.index, 1);

  const advanced = await post('/api/rooms/' + created.json.roomCode + '/restart', {
    playerId: created.json.playerId,
    token: created.json.token,
    transitionToken,
  });
  assert.equal(advanced.response.status, 200);
  assert.equal(advanced.json.accepted, true);
  assert.equal(advanced.json.action, 'advance');
  assert.equal(advanced.json.alreadyApplied, false);
  assert.equal(advanced.json.state.stage.index, 2);
  assert.equal(advanced.json.state.stage.mapKey, 'stage-02');
  assert.ok(advanced.json.state.players.every((player) => player.level === 2));

  const duplicate = await post('/api/rooms/' + created.json.roomCode + '/restart', {
    playerId: created.json.playerId,
    token: created.json.token,
    transitionToken,
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.json.accepted, true);
  assert.equal(duplicate.json.alreadyApplied, true);
  assert.equal(duplicate.json.state.stage.index, 2);
});

test('单人试炼自动加入 AI，SSE 立即推送可渲染状态', async () => {
  const created = await post('/api/rooms', { mode: 'solo', name: '独行猎人' });
  assert.equal(created.response.status, 201);
  assert.equal(created.json.state.players.length, 2);
  assert.equal(created.json.state.players.filter((player) => player.isAI).length, 1);

  const controller = new AbortController();
  const response = await fetch(
    `${baseUrl}/api/rooms/${created.json.roomCode}/events?playerId=${created.json.playerId}&token=${encodeURIComponent(created.json.token)}`,
    { signal: controller.signal },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = await reader.read();
  const chunk = new TextDecoder().decode(first.value);
  assert.match(chunk, /event: state/);
  assert.match(chunk, /"arena"/);
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('Node SSE 断开后纯 HTTP fallback 的 /state 会恢复在线状态', async () => {
  const created = await post('/api/rooms', { mode: 'solo', name: '轮询守灯人' });
  const { record, storedSession } = await disconnectLastSse(created.json);
  const disconnectedAt = record.lastActive;
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));

  const query = new URLSearchParams({
    playerId: created.json.playerId,
    token: created.json.token,
  });
  const response = await fetch(`${baseUrl}/api/rooms/${created.json.roomCode}/state?${query}`);
  const state = await response.json();
  const player = state.players.find((candidate) => candidate.id === created.json.playerId);

  assert.equal(response.status, 200);
  assert.equal(storedSession.connected, true);
  assert.equal(player.connected, true);
  assert.ok(record.lastActive > disconnectedAt, '合法状态轮询应刷新房间活动时间');
});

test('Node SSE 断开后纯 HTTP fallback 的 /input 会恢复在线并仍可过关', async () => {
  const created = await post('/api/rooms', { mode: 'solo', name: '断流猎人' });
  const { record, storedSession } = await disconnectLastSse(created.json);
  const player = record.game.players.get(created.json.playerId);
  player.x = record.game.phase.exit.x;
  player.y = record.game.phase.exit.y;
  player.invulnerable = 99;
  record.game.run.sealsCollected = record.game.run.sealsRequired;
  record.game.run.bossActivated = true;
  record.game.run.bossDefeated = true;
  record.game.run.exitUnlocked = true;

  const input = await post(`/api/rooms/${created.json.roomCode}/input`, {
    playerId: created.json.playerId,
    token: created.json.token,
    seq: 1,
    move: { x: 0, y: 0 },
    aim: { x: 1, y: 0 },
    attack: false,
    interact: true,
    dodge: false,
    skill: false,
  });

  assert.equal(input.response.status, 202);
  assert.equal(input.json.accepted, true);
  assert.equal(storedSession.connected, true);
  assert.equal(player.connected, true);
  assert.equal(player.input.interact, true, '恢复连接不能覆盖本次合法输入');
  for (let tick = 0; tick < 20; tick += 1) record.game.update(0.05);
  assert.equal(record.game.snapshot().stage.status, 'stage_complete');
});

test('Node 循环固定步长追赶 100ms/250ms 延迟且限制单轮追赶量', async () => {
  let now = 1_000;
  const deltas = [];
  const timing = createGameServer({
    publicDir: temporaryPublic,
    clock: () => now,
  });
  timing.rooms.set('TIMING', {
    code: 'TIMING',
    game: { update: (delta) => deltas.push(delta) },
    clients: new Set(),
    sessions: new Map(),
  });

  const runDelayedFrame = (elapsedMs) => {
    deltas.length = 0;
    now += elapsedMs;
    return timing.simulationStep?.();
  };

  try {
    const hundredMs = runDelayedFrame(100);
    assert.equal(deltas.length, 3, '100ms 延迟应追赶三个 30Hz 固定步长');
    assert.ok(deltas.every((delta) => Math.abs(delta - 1 / 30) < 1e-9));
    assert.ok(Math.abs(hundredMs.simulatedSeconds + hundredMs.pendingSeconds - 0.1) < 1e-9);

    const quarterSecond = runDelayedFrame(250);
    assert.equal(deltas.length, 7, '250ms 延迟应执行七步并保留不足一步的余量');
    assert.ok(Math.abs(quarterSecond.simulatedSeconds + quarterSecond.pendingSeconds - 0.25) < 1e-9);

    const capped = runDelayedFrame(2_000);
    assert.equal(deltas.length, 8, '长时间停顿单轮最多追赶八步');
    assert.ok(deltas.every((delta) => Math.abs(delta - 1 / 30) < 1e-9), '追赶不得传入巨型 dt');
    assert.ok(capped.simulatedSeconds <= 8 / 30 + 1e-9);
    assert.ok(capped.droppedSeconds > 1.7, '超过安全窗口的陈旧时间必须丢弃');
  } finally {
    await timing.close();
  }
});

test('过期房间会关闭并拒绝后续访问', async () => {
  const expiring = createGameServer({
    publicDir: temporaryPublic,
    roomTtlMs: 10,
    emptyRoomTtlMs: 10,
    cleanupIntervalMs: 60_000,
  });
  const address = await expiring.listen();
  const expiringBase = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${expiringBase}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'coop' }),
    });
    const room = await response.json();
    const record = expiring.rooms.get(room.roomCode);
    record.lastActive -= 100;
    expiring.cleanupRooms();
    assert.equal(expiring.rooms.has(room.roomCode), false);
    const gone = await fetch(`${expiringBase}/api/rooms/${room.roomCode}/state?token=${room.token}`);
    assert.equal(gone.status, 404);
  } finally {
    await expiring.close();
  }
});
