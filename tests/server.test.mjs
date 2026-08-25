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
  };
  const accepted = await post(`/api/rooms/${created.json.roomCode}/input`, inputBody);
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.json.accepted, true);
  const replayed = await post(`/api/rooms/${created.json.roomCode}/input`, inputBody);
  assert.equal(replayed.response.status, 200);
  assert.equal(replayed.json.accepted, false);

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
