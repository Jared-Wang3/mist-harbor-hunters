import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARENA,
  GameState,
  createSoloGame,
  GAME_OBSTACLES,
  GAME_SPECS,
  GAME_STAGES,
  STATE_VERSION,
} from '../src/game-state.mjs';
import { deserializeGame, serializeGame } from '../worker/index.mjs';

test('敌人与单人 AI 会稳定绕过集市残墙继续接近目标', () => {
  const wall = GAME_OBSTACLES.find((obstacle) => obstacle.id === 'marsh-flood-wall');
  const centerY = wall.y + wall.height / 2;

  const game = new GameState({ code: 'NAV234', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  game.enemies.clear();
  const enemy = game._spawnEnemy('crawler', {
    x: wall.x - GAME_SPECS.enemies.crawler.radius - 12,
    y: centerY,
    zoneId: 'sunk_market',
    awake: true,
    countsForZone: false,
  });
  const [first, second] = [...game.players.values()];
  for (const player of [first, second]) {
    player.x = wall.x + wall.width + 300;
    player.y = centerY + (player === first ? 0 : 80);
    player.invulnerable = 99;
  }
  let enemyDetour = 0;
  for (let index = 0; index < 240; index += 1) {
    game.update(0.05);
    enemyDetour = Math.max(enemyDetour, Math.abs(enemy.y - centerY));
    assert.equal(circleOverlapsObstacle(enemy, enemy.radius, wall), false);
  }
  assert.ok(enemy.x > wall.x + wall.width + enemy.radius, '敌人应越过墙体而不是持续顶墙');
  assert.ok(enemyDetour > wall.height / 2, '敌人路径应实际绕过墙体端点');

  const solo = createSoloGame({ code: 'AINAV2', rng: () => 0.2, playerId: 'human' });
  solo.enemies.clear();
  const human = solo.players.get('human');
  const ai = [...solo.players.values()].find((player) => player.isAI);
  human.x = wall.x + wall.width + 300;
  human.y = centerY;
  human.invulnerable = 99;
  ai.x = wall.x - ai.radius - 12;
  ai.y = centerY;
  ai.invulnerable = 99;
  let aiDetour = 0;
  for (let index = 0; index < 240; index += 1) {
    solo.update(0.05);
    aiDetour = Math.max(aiDetour, Math.abs(ai.y - centerY));
    assert.equal(circleOverlapsObstacle(ai, ai.radius, wall), false);
  }
  assert.ok(ai.x > wall.x + wall.width + ai.radius, 'solo AI 应绕墙后继续跟随真人');
  assert.ok(aiDetour > wall.height / 2, 'solo AI 应选择稳定的墙端绕行路径');
});

function circleOverlapsObstacle(point, radius, obstacle) {
  if (obstacle.shape === 'circle') {
    return Math.hypot(point.x - obstacle.x, point.y - obstacle.y) < radius + obstacle.radius;
  }
  const nearestX = Math.max(obstacle.x, Math.min(obstacle.x + obstacle.width, point.x));
  const nearestY = Math.max(obstacle.y, Math.min(obstacle.y + obstacle.height, point.y));
  return Math.hypot(point.x - nearestX, point.y - nearestY) < radius;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [x, y] = polygon[index];
    const [previousX, previousY] = polygon[previous];
    const crosses = (y > point.y) !== (previousY > point.y)
      && point.x < ((previousX - x) * (point.y - y)) / (previousY - y) + x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function circleInsideWalkableArea(point, radius, walkablePolygons) {
  const samples = [point];
  for (let index = 0; index < 32; index += 1) {
    const angle = (Math.PI * 2 * index) / 32;
    samples.push({
      x: point.x + Math.cos(angle) * radius,
      y: point.y + Math.sin(angle) * radius,
    });
  }
  return samples.every((sample) => walkablePolygons.some((entry) => pointInPolygon(sample, entry.points)));
}

function pointToSegmentDistanceSquared(point, segment) {
  const edgeX = segment.bx - segment.ax;
  const edgeY = segment.by - segment.ay;
  const lengthSquared = edgeX * edgeX + edgeY * edgeY;
  const progress = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - segment.ax) * edgeX + (point.y - segment.ay) * edgeY) / lengthSquared))
    : 0;
  const dx = point.x - (segment.ax + edgeX * progress);
  const dy = point.y - (segment.ay + edgeY * progress);
  return dx * dx + dy * dy;
}

function circleInsideStageWalkable(point, radius, stage) {
  if (!stage.walkablePolygons.some((entry) => pointInPolygon(point, entry.points))) return false;
  return stage.walkableBoundarySegments.every((segment) =>
    pointToSegmentDistanceSquared(point, segment) >= (radius - 0.0001) ** 2,
  );
}

function stagePointAvailable(point, radius, stage) {
  return circleInsideStageWalkable(point, radius, stage)
    && !stage.obstacles.some((obstacle) => circleOverlapsObstacle(point, radius, obstacle));
}

function reachableStageCells(stage, origin, radius = 24, cellSize = 40) {
  const minimumX = ARENA.padding + radius;
  const minimumY = ARENA.padding + radius;
  const columns = Math.floor((ARENA.width - minimumX * 2) / cellSize) + 1;
  const rows = Math.floor((ARENA.height - minimumY * 2) / cellSize) + 1;
  const coordinates = (index) => ({
    x: minimumX + (index % columns) * cellSize,
    y: minimumY + Math.floor(index / columns) * cellSize,
  });
  const valid = new Uint8Array(columns * rows);
  for (let index = 0; index < valid.length; index += 1) {
    valid[index] = stagePointAvailable(coordinates(index), radius, stage) ? 1 : 0;
  }
  const nearestValidIndex = (point) => {
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let index = 0; index < valid.length; index += 1) {
      if (!valid[index]) continue;
      const candidate = coordinates(index);
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    }
    return nearest;
  };
  const start = nearestValidIndex(origin);
  const queue = start >= 0 ? [start] : [];
  const reachable = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const column = current % columns;
    const row = Math.floor(current / columns);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nextColumn = column + dx;
      const nextRow = row + dy;
      if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
      const next = nextRow * columns + nextColumn;
      if (valid[next] && !reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  return {
    reaches: (point) => reachable.has(nearestValidIndex(point)),
  };
}

function routeExists(from, to, radius = 28, cellSize = 64) {
  const minimumX = ARENA.padding + radius;
  const minimumY = ARENA.padding + radius;
  const columns = Math.floor((ARENA.width - minimumX * 2) / cellSize) + 1;
  const rows = Math.floor((ARENA.height - minimumY * 2) / cellSize) + 1;
  const coordinates = (index) => ({
    x: minimumX + (index % columns) * cellSize,
    y: minimumY + Math.floor(index / columns) * cellSize,
  });
  const indexFor = (point) => {
    const column = Math.max(0, Math.min(columns - 1, Math.round((point.x - minimumX) / cellSize)));
    const row = Math.max(0, Math.min(rows - 1, Math.round((point.y - minimumY) / cellSize)));
    return row * columns + column;
  };
  const blocked = (index) => GAME_OBSTACLES.some((obstacle) => circleOverlapsObstacle(coordinates(index), radius, obstacle));
  const start = indexFor(from);
  const goal = indexFor(to);
  if (blocked(start) || blocked(goal)) return false;
  const queue = [start];
  const visited = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === goal) return true;
    const column = current % columns;
    const row = Math.floor(current / columns);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nextColumn = column + dx;
      const nextRow = row + dy;
      if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
      const next = nextRow * columns + nextColumn;
      if (!visited.has(next) && !blocked(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function addCoopPair(game) {
  game.addPlayer({ id: 'vanguard', name: '阿岚', role: 'vanguard' });
  game.addPlayer({ id: 'ranger', name: '弦月', role: 'ranger' });
}

function holdStill(overrides = {}) {
  return {
    move: { x: 0, y: 0 },
    aim: { x: 1, y: 0 },
    attack: false,
    interact: false,
    dodge: false,
    skill: false,
    ...overrides,
  };
}

function defeatZone(game, zoneId, ownerId = 'vanguard') {
  for (let wave = 0; wave < 12 && !game.zoneStates.get(zoneId).cleared; wave += 1) {
    const enemies = [...game.enemies.values()].filter((candidate) =>
      candidate.zoneId === zoneId && candidate.status === 'active' && candidate.hp > 0,
    );
    for (const enemy of enemies) game._damageEnemy(enemy, enemy.hp + 1, ownerId);
    for (const enemy of game.enemies.values()) {
      if (enemy.status === 'defeated') enemy.deathRemaining = 0;
    }
    game._updateEnemyTombstones(0.05);
    game._replenishEncounterQueues({ force: true });
  }
  assert.equal(game.zoneStates.get(zoneId).cleared, true, `${zoneId} 应在有限补充波次内清空`);
}

function collectSeal(game, zoneId, playerId = 'vanguard') {
  const player = game.players.get(playerId);
  const seal = game.collectibles.get(`seal-${zoneId}`);
  player.x = seal.x;
  player.y = seal.y;
  game.setInput(playerId, holdStill({ interact: true }), player.lastSeq + 1);
  game.update(0.05);
  game.setInput(playerId, holdStill(), player.lastSeq + 1);
}

test('合作房等待第二名玩家，满员后开始三关战役的第一关', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop', rng: () => 0.2, now: () => 1000 });
  game.addPlayer({ id: 'one', name: '先锋', role: 'vanguard' });
  let state = game.snapshot();
  assert.equal(state.stateVersion, STATE_VERSION);
  assert.equal(state.stage.status, 'waiting');
  assert.equal(state.objective.step, 'assemble');

  game.addPlayer({ id: 'two', name: '游侠', role: 'ranger' });
  state = game.snapshot();
  assert.equal(state.stage.id, 'stage-01');
  assert.equal(state.stage.mapKey, 'stage-01');
  assert.equal(state.stage.title, '晴潮雾港');
  assert.equal(state.stage.objectiveNoun, '雾印');
  assert.equal(state.stage.total, 3);
  assert.equal(state.stage.status, 'active');
  assert.equal(state.enemies.length, 21);
  assert.equal(state.players.length, 2);
  assert.equal(state.arena.width, 5120);
  assert.equal(state.arena.height, 2880);
  assert.equal(state.arena.viewportWidth, 1280);
  assert.equal(state.arena.viewportHeight, 720);
  assert.ok(state.zones.length >= 5);
  assert.equal(state.collectibles.filter((item) => item.kind === 'seal').length, 3);
  assert.equal(state.exit.unlocked, false);
  assert.throws(() => game.addPlayer({ id: 'three' }), /room_full/);
});

test('大型地图公开固定地形障碍，关键探索点保持可达且未被覆盖', () => {
  const game = new GameState({ code: 'MAP234', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  const snapshot = game.snapshot();
  assert.equal(snapshot.obstacles.length, GAME_OBSTACLES.length);
  assert.ok(snapshot.obstacles.length >= 18);
  assert.ok(snapshot.obstacles.every((obstacle) =>
    obstacle.solid === true
    && ['rect', 'circle'].includes(obstacle.shape)
    && typeof obstacle.kind === 'string'
    && ['terrain-boundary', 'v6-prop'].includes(obstacle.visualKind)
    && typeof obstacle.name === 'string',
  ));
  assert.ok(snapshot.obstacles.some((obstacle) => obstacle.terrainBoundary === true));
  assert.ok(snapshot.obstacles.some((obstacle) =>
    obstacle.visualKind === 'v6-prop'
    && typeof obstacle.asset === 'string'
    && Array.isArray(obstacle.anchor)
    && Number.isFinite(obstacle.scale),
  ));
  assert.ok(snapshot.surfaceZones.length > 0);
  assert.ok(Array.isArray(snapshot.movementZones));
  assert.ok(snapshot.ambientEmitters.length > 0);

  assert.deepEqual(GAME_STAGES.map(({ id, mapKey, title }) => ({ id, mapKey, title })), [
    { id: 'stage-01', mapKey: 'stage-01', title: '晴潮雾港' },
    { id: 'stage-02', mapKey: 'stage-02', title: '赤灯潮市' },
    { id: 'stage-03', mapKey: 'stage-03', title: '云汐天关' },
  ]);
  for (const stage of GAME_STAGES) {
    assert.ok(stage.objectiveNoun.length > 0);
    assert.ok(stage.obstacles.every((obstacle) => typeof obstacle.visualKind === 'string'));
  }

  const route = [
    { ...GAME_STAGES[0].spawn, label: '营地出生点' },
    ...GAME_STAGES[0].zones.filter((zone) => zone.kind === 'hunt').map((zone) => ({
      ...zone.center, label: zone.name,
    })),
    { ...GAME_STAGES[0].boss, label: 'Boss 场' },
    { x: snapshot.exit.x, y: snapshot.exit.y, label: '出口' },
  ];
  for (const point of route) {
    assert.equal(
      GAME_OBSTACLES.some((obstacle) => circleOverlapsObstacle(point, 28, obstacle)),
      false,
      `${point.label} 不应被障碍覆盖`,
    );
  }
  for (let index = 1; index < route.length; index += 1) {
    assert.equal(routeExists(route[index - 1], route[index]), true, `${route[index - 1].label} 到 ${route[index].label} 应有通路`);
  }
});

test('三关可行走联集跨接缝连通，出生点可抵达全部任务目标', () => {
  for (const stage of GAME_STAGES) {
    assert.ok(stage.walkableBoundarySegments.length > 0, `${stage.id} 应预计算真实联集外边界`);
    const actualSpawn = { x: stage.spawn.x - 46, y: stage.spawn.y + 18 };
    const reachable = reachableStageCells(stage, actualSpawn);
    const targets = [
      ...stage.objectives.map((objective) => ({ ...objective, label: objective.id })),
      { ...stage.boss, label: 'boss' },
      { ...stage.exit, label: 'exit' },
    ];
    for (const target of targets) {
      assert.equal(reachable.reaches(target), true, `${stage.id} 出生点应可抵达 ${target.label}`);
    }
  }

  const stage = GAME_STAGES[1];
  assert.equal(
    circleInsideStageWalkable({ x: 3410, y: 1840 }, 34, stage),
    true,
    '相邻多边形联集接缝不应成为 brute 的隐形墙',
  );
});

test('服务器碰撞阻止玩家和敌人穿过残墙，弹体也会被实体地形拦截', () => {
  const game = new GameState({ code: 'WALL23', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  game.enemies.clear();
  const wall = GAME_OBSTACLES.find((obstacle) => obstacle.id === 'marsh-flood-wall');
  const hunter = game.players.get('vanguard');
  const teammate = game.players.get('ranger');
  hunter.x = wall.x - hunter.radius - 1;
  hunter.y = wall.y + wall.height / 2;
  hunter.invulnerable = 99;
  teammate.x = 800;
  teammate.y = 800;
  teammate.invulnerable = 99;
  game.setInput(hunter.id, holdStill({ move: { x: 1, y: 0 } }), 1);
  for (let index = 0; index < 30; index += 1) game.update(0.05);
  assert.ok(hunter.x <= wall.x - hunter.radius + 0.02, '玩家圆形碰撞体不能穿过矩形残墙');
  assert.equal(circleOverlapsObstacle(hunter, hunter.radius, wall), false);

  const enemy = game._spawnEnemy('crawler', {
    x: wall.x + wall.width / 2,
    y: wall.y + wall.height / 2,
    zoneId: 'sunk_market',
    countsForZone: false,
  });
  game._clampActor(enemy);
  assert.equal(circleOverlapsObstacle(enemy, enemy.radius, wall), false, '敌人也必须被推出实体障碍');

  game.projectiles.clear();
  game._spawnProjectile({
    owner: hunter.id,
    team: 'hunters',
    kind: 'test_harpoon',
    x: wall.x - 45,
    y: wall.y + wall.height / 2,
    vx: 720,
    vy: 0,
    radius: 7,
    damage: 1,
    ttl: 1,
  });
  for (let index = 0; index < 5; index += 1) game._updateProjectiles(0.05);
  assert.equal(game.projectiles.size, 0, '弹体接触墙体后应销毁');
});

test('服务器与公开快照共同阻止角色走入深水和云渊', () => {
  const game = new GameState({ code: 'VOID24', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  game.phaseIndex = 2;
  game._startStage({ resetProgress: false });
  game.enemies.clear();

  const hunter = game.players.get('vanguard');
  hunter.x = 2500;
  hunter.y = 720;
  hunter.invulnerable = 99;
  game.setInput(hunter.id, holdStill({ move: { x: 0, y: -1 } }), 1);

  for (let index = 0; index < 45; index += 1) {
    game.update(1 / 30);
  }

  assert.equal(
    circleInsideWalkableArea(hunter, hunter.radius, game.phase.walkablePolygons),
    true,
    `玩家不应从听雷云台北缘走入云渊：${hunter.x},${hunter.y}`,
  );
  const snapshot = game.snapshot();
  assert.deepEqual(snapshot.walkablePolygons, game.phase.walkablePolygons, '客户端必须收到同一份可行走边界');
});

test('输入序号防重放，先锋击杀由服务器判定并给全队经验', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop', rng: () => 0.3 });
  addCoopPair(game);
  const player = game.players.get('vanguard');
  const teammate = game.players.get('ranger');
  const target = [...game.enemies.values()][0];
  target.x = player.x + 60;
  target.y = player.y;
  target.homeX = target.x;
  target.homeY = target.y;
  target.hp = 1;

  assert.equal(game.setInput('vanguard', holdStill({ attack: true }), 4), true);
  assert.equal(game.setInput('vanguard', holdStill(), 4), false);
  game.update(1 / 30);
  assert.equal(game.enemies.has(target.id), true, '死亡敌人应短暂保留供客户端播放倒地动作');
  let defeated = game.snapshot().enemies.find((enemy) => enemy.id === target.id);
  assert.equal(defeated.status, 'defeated');
  assert.equal(defeated.action, 'down');
  assert.equal(defeated.hp, 0);
  assert.ok(defeated.deathRemaining >= 0.75 && defeated.deathRemaining <= 0.8);
  assert.equal(player.xp, target.xpValue);
  assert.equal(teammate.xp, target.xpValue);
  assert.equal(player.kills, 1);
  assert.equal(game.snapshot().players.find((item) => item.id === 'vanguard').action, 'attack');

  assert.equal(game._damageEnemy(target, 999, 'vanguard'), false, 'tombstone 不可被重复结算');
  assert.equal(player.xp, target.xpValue);
  assert.equal(player.kills, 1);
  for (let index = 0; index < 7; index += 1) game.update(0.05);
  defeated = game.snapshot().enemies.find((enemy) => enemy.id === target.id);
  assert.equal(defeated.status, 'defeated', '0.35 秒后仍应可见');
  assert.ok(defeated.deathRemaining >= 0.4);
  for (let index = 0; index < 10; index += 1) game.update(0.05);
  assert.equal(game.enemies.has(target.id), false, '0.8 秒后才从权威状态删除');
});

test('同一模拟帧内的后续输入不会吞掉闪避或技能', () => {
  const game = new GameState({ code: 'STICKY', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  const vanguard = game.players.get('vanguard');
  const ranger = game.players.get('ranger');

  assert.equal(game.setInput(vanguard.id, holdStill({
    move: { x: 1, y: 0 },
    aim: { x: 0, y: 1 },
    attack: true,
    interact: true,
    dodge: true,
  }), 10), true);
  assert.equal(game.setInput(vanguard.id, holdStill({
    move: { x: 0, y: 1 },
    aim: { x: -1, y: 0 },
  }), 11), true);
  assert.equal(game.setInput(ranger.id, holdStill({ skill: true }), 20), true);
  assert.equal(game.setInput(ranger.id, holdStill(), 21), true);
  assert.deepEqual(vanguard.input, {
    move: { x: 0, y: 1 },
    aim: { x: -1, y: 0 },
    attack: false,
    interact: false,
    dodge: true,
    skill: false,
  }, '连续状态取最新输入，只有一次性动作保持待消费');
  game.update(1 / 30);

  assert.ok(vanguard.dodgeCooldown > 1.5, '后续输入不能覆盖尚未消费的闪避');
  assert.deepEqual(vanguard.dodgeVector, { x: 1, y: 0 }, '闪避方向应锁定触发动作的原始移动帧');
  assert.ok(ranger.skillCooldown > 0.3, '后续输入不能覆盖尚未消费的技能');
  const players = new Map(game.snapshot().players.map((player) => [player.id, player]));
  assert.equal(players.get(vanguard.id).lastProcessedInputSeq, 11);
  assert.equal(players.get(ranger.id).lastProcessedInputSeq, 21);
  assert.equal(vanguard.input.dodge, false, '闪避应在本次 update 后消费');
  assert.equal(ranger.input.skill, false, '技能应在本次 update 后消费');
});

test('ACK 后断连仍按原方向恰好消费一次性动作且只清空旧 held 输入', () => {
  const game = new GameState({ code: 'ACKCUT', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  const vanguard = game.players.get('vanguard');
  const ranger = game.players.get('ranger');

  assert.equal(game.setInput(vanguard.id, holdStill({
    aim: { x: 0, y: -1 },
    move: { x: 0, y: 0 },
    attack: true,
    interact: true,
    dodge: true,
  }), 30), true);
  assert.equal(game.snapshot().players.find((player) => player.id === vanguard.id).lastProcessedInputSeq, 30);
  game.setConnected(vanguard.id, false);
  assert.deepEqual(vanguard.input, holdStill({ dodge: true }), '断连只保留待消费动作，不能保留移动、攻击或互动');
  game.setConnected(vanguard.id, true);
  assert.equal(game.setInput(vanguard.id, holdStill({
    move: { x: 1, y: 0 },
    aim: { x: 1, y: 0 },
    attack: true,
    interact: true,
  }), 31), true);
  assert.equal(vanguard.input.dodge, true, '重连后的新 held 帧不能覆盖已 ACK 的闪避');

  assert.equal(game.setInput(ranger.id, holdStill({ skill: true }), 40), true);
  game.setConnected(ranger.id, false);
  assert.deepEqual(ranger.input, holdStill({ skill: true }), '断连应保留已 ACK、尚未步进的技能');
  game.setConnected(ranger.id, true);
  assert.equal(game.setInput(ranger.id, holdStill({ move: { x: 0, y: 1 } }), 41), true);

  game.update(1 / 30);
  assert.deepEqual(vanguard.dodgeVector, { x: 0, y: -1 }, '闪避必须使用触发时的原始 aim，而不是重连后的新移动');
  assert.ok(vanguard.dodgeCooldown > 1.5);
  assert.ok(ranger.skillCooldown > 0.3);
  assert.equal(vanguard.input.dodge, false);
  assert.equal(vanguard.pendingDodgeVector, null, '闪避消费后必须清理方向锁存');
  assert.equal(ranger.input.skill, false);
  assert.deepEqual(vanguard.input.move, { x: 1, y: 0 }, '动作消费后应继续使用重连后的新 held 移动');
  assert.equal(vanguard.input.attack, true);
  assert.equal(vanguard.input.interact, true);
  assert.deepEqual(ranger.input.move, { x: 0, y: 1 });

  assert.equal(game.setInput(vanguard.id, holdStill({ dodge: true }), 31), false, '重复序号不能再次锁存闪避');
  assert.equal(game.setInput(ranger.id, holdStill({ skill: true }), 41), false, '重复序号不能再次锁存技能');
  game.update(1 / 30);
  assert.equal(game.effects.filter((effect) => effect.kind === 'dodge').length, 1);
  assert.equal(game.effects.filter((effect) => effect.kind === 'ranger_control_empty').length, 1);
});

test('待消费闪避方向可持久化恢复，旧检查点可推导且换关会清理锁存', () => {
  const game = new GameState({ code: 'LATCH1', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  assert.equal(game.setInput('vanguard', holdStill({
    move: { x: 0.6, y: 0.8 },
    aim: { x: -1, y: 0 },
    dodge: true,
  }), 50), true);

  const restored = deserializeGame(serializeGame(game), { code: game.code, mode: game.mode });
  const restoredPlayer = restored.players.get('vanguard');
  assert.deepEqual(restoredPlayer.pendingDodgeVector, { x: 0.6, y: 0.8 });
  restored.setConnected(restoredPlayer.id, false);
  restored.setConnected(restoredPlayer.id, true);
  restored.update(1 / 30);
  assert.deepEqual(restoredPlayer.dodgeVector, { x: 0.6, y: 0.8 });
  assert.equal(restoredPlayer.pendingDodgeVector, null);

  const legacy = new GameState({ code: 'LATCH0', mode: 'coop', rng: () => 0.2 });
  addCoopPair(legacy);
  legacy.setInput('vanguard', holdStill({ aim: { x: 0, y: 1 }, dodge: true }), 60);
  delete legacy.players.get('vanguard').pendingDodgeVector;
  const restoredLegacy = deserializeGame(serializeGame(legacy), { code: legacy.code, mode: legacy.mode });
  assert.deepEqual(restoredLegacy.players.get('vanguard').pendingDodgeVector, { x: 0, y: 1 });

  restoredLegacy._completeExpedition();
  const transitionToken = restoredLegacy.snapshot().stage.transitionToken;
  assert.equal(restoredLegacy.restartCampaign({ transitionToken }).accepted, true);
  const resetPlayer = restoredLegacy.players.get('vanguard');
  assert.equal(resetPlayer.input.dodge, false);
  assert.equal(resetPlayer.input.skill, false);
  assert.equal(resetPlayer.pendingDodgeVector, null);
});

test('公开玩家快照确认已处理输入并暴露精确动作预测状态', () => {
  const game = new GameState({ code: 'ACK234', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  const player = game.players.get('vanguard');
  assert.equal(game.setInput(player.id, holdStill(), 27), true);
  player.dodgeTime = 0.24;
  player.dodgeVector = { x: 0.6, y: -0.8 };
  player.shotSlowRemaining = 0.19;

  const publicPlayer = game.snapshot().players.find((candidate) => candidate.id === player.id);
  assert.deepEqual({
    lastProcessedInputSeq: publicPlayer.lastProcessedInputSeq,
    dodgeRemaining: publicPlayer.dodgeRemaining,
    dodgeVector: publicPlayer.dodgeVector,
    shotSlowRemaining: publicPlayer.shotSlowRemaining,
  }, {
    lastProcessedInputSeq: 27,
    dodgeRemaining: 0.2,
    dodgeVector: { x: 0.6, y: -0.8 },
    shotSlowRemaining: 0.2,
  });
});

test('游侠发射服务器弹体并命中怪物', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop', rng: () => 0.4 });
  addCoopPair(game);
  const ranger = game.players.get('ranger');
  const target = [...game.enemies.values()][0];
  target.x = ranger.x + 145;
  target.y = ranger.y;
  target.homeX = target.x;
  target.homeY = target.y;
  const originalHp = target.hp;
  game.setInput('ranger', holdStill({ attack: true }), 1);
  for (let i = 0; i < 8; i += 1) game.update(1 / 30);
  assert.ok(target.hp < originalHp, '弹体应由权威循环判定命中');
});

test('种子化遭遇按关卡范围生成、固定经验预算并受实体队列上限约束', () => {
  const first = new GameState({ code: 'SEED24', mode: 'coop', rng: () => 0.2 });
  const second = new GameState({ code: 'SEED24', mode: 'coop', rng: () => 0.9 });
  addCoopPair(first);
  addCoopPair(second);
  assert.equal(first.encounterSeed, second.encounterSeed);
  assert.deepEqual([...first.encounterPlan], [...second.encounterPlan]);

  const expectedBudgets = [645, 785, 865];
  for (let stageIndex = 0; stageIndex < GAME_STAGES.length; stageIndex += 1) {
    const stage = GAME_STAGES[stageIndex];
    const rules = stage.encounterRules;
    const records = [...first.encounterPlan.values()];
    assert.equal(records.length, 3);
    for (const [zoneId, record] of first.encounterPlan) {
      const zone = stage.zones.find((entry) => entry.id === zoneId);
      assert.ok(record.target >= rules.countRange[0] && record.target <= rules.countRange[1]);
      assert.equal(record.entries.length, record.target);
      assert.ok(record.entries.every((entry) =>
        entry.x >= zone.x
        && entry.x <= zone.x + zone.width
        && entry.y >= zone.y
        && entry.y <= zone.y + zone.height
        && !stage.obstacles.some((obstacle) =>
          circleOverlapsObstacle(entry, GAME_SPECS.enemies[entry.type].radius, obstacle),
        )
        && circleInsideStageWalkable(entry, GAME_SPECS.enemies[entry.type].radius, stage),
      ));
      const melee = record.entries.filter((entry) => ['crawler', 'brute'].includes(entry.type)).length;
      const ranged = record.entries.filter((entry) => ['spitter', 'siren'].includes(entry.type)).length;
      const sirens = record.entries.filter((entry) => entry.type === 'siren').length;
      assert.ok(melee >= rules.minMelee);
      assert.ok(ranged >= rules.minRanged);
      assert.ok(sirens <= rules.maxSiren);
    }
    const xpTotal = records.flatMap((record) => record.entries)
      .reduce((total, entry) => total + entry.xpValue, 0);
    assert.equal(xpTotal, expectedBudgets[stageIndex]);
    const materialized = [...first.enemies.values()].filter((enemy) =>
      enemy.countsForZone && !enemy.boss,
    );
    assert.equal(materialized.length, 21);
    for (const zone of stage.zones.filter((entry) => entry.kind === 'hunt')) {
      assert.equal(materialized.filter((enemy) => enemy.zoneId === zone.id).length, 7);
    }

    if (stageIndex < GAME_STAGES.length - 1) {
      first._completeExpedition();
      const transitionToken = first.snapshot().stage.transitionToken;
      assert.equal(first.restartCampaign({ transitionToken }).accepted, true);
    }
  }
});

test('遭遇队列在墓碑消失后补位，并把全关同时苏醒数限制为十四', () => {
  const game = new GameState({ code: 'CAPS24', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  const zone = game.phase.zones.find((entry) => entry.kind === 'hunt');
  const initialIds = new Set([...game.enemies.values()].map((enemy) => enemy.encounterId));
  const victim = [...game.enemies.values()].find((enemy) => enemy.zoneId === zone.id);
  const initialRemaining = game.zoneStates.get(zone.id).remaining;
  game._damageEnemy(victim, victim.hp + 1, 'vanguard');
  assert.equal(game.zoneStates.get(zone.id).remaining, initialRemaining - 1);
  victim.deathRemaining = 0;
  for (const player of game.players.values()) player.invulnerable = 99;
  game.update(0.01);
  const materialized = [...game.enemies.values()].filter((enemy) => enemy.countsForZone && !enemy.boss);
  assert.equal(materialized.length, 21);
  assert.ok(materialized.some((enemy) => !initialIds.has(enemy.encounterId)), '队列应补入新的计划实体');

  const hunter = game.players.get('vanguard');
  let offset = 0;
  for (const enemy of materialized) {
    enemy.x = hunter.x + 100 + (offset % 5) * 3;
    enemy.y = hunter.y + Math.floor(offset / 5) * 3;
    enemy.homeX = enemy.x;
    enemy.homeY = enemy.y;
    enemy.awake = false;
    offset += 1;
  }
  game.update(0.01);
  assert.equal(materialized.filter((enemy) => enemy.awake).length, 14);
});

test('重刃普攻破甲并短硬直，守潮阵减伤、护队友且强制近敌转火', () => {
  const game = new GameState({ code: 'VANG24', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  game.enemies.clear();
  for (const zoneId of game.encounterQueues.keys()) game.encounterQueues.set(zoneId, []);
  const vanguard = game.players.get('vanguard');
  const ranger = game.players.get('ranger');
  const target = game._spawnEnemy('brute', {
    x: vanguard.x + 82,
    y: vanguard.y,
    zoneId: game.phase.zones.find((zone) => zone.kind === 'hunt').id,
    countsForZone: false,
  });
  const originalHp = target.hp;
  game._playerAttack(vanguard, GAME_SPECS.players.vanguard);
  const firstDamage = originalHp - target.hp;
  assert.equal(firstDamage, 32);
  assert.equal(target.armorBreakRemaining, 2.5);
  assert.equal(target.rootRemaining, 0.06);
  const afterFirst = target.hp;
  game._playerAttack(vanguard, GAME_SPECS.players.vanguard);
  assert.ok(afterFirst - target.hp > firstDamage, '后续命中应获得 15% 破甲增伤');

  vanguard.attackCooldown = 0;
  game.setInput('vanguard', holdStill({ skill: true, attack: true }), 1);
  game.update(1 / 30);
  assert.ok(vanguard.guardRemaining > 1.5);
  assert.ok(vanguard.skillCooldown > 7.9);
  assert.equal(target.tauntTargetId, vanguard.id);
  const hpBeforeGuardedAttack = target.hp;
  game.setInput('vanguard', holdStill({ attack: true }), 2);
  game.update(1 / 30);
  assert.equal(target.hp, hpBeforeGuardedAttack, '守潮阵持续时不能同时普攻');

  vanguard.invulnerable = 0;
  ranger.invulnerable = 0;
  const vanguardHp = vanguard.hp;
  const rangerHp = ranger.hp;
  game._damagePlayer(vanguard, 100);
  game._damagePlayer(ranger, 100);
  assert.equal(vanguardHp - vanguard.hp, 35);
  assert.equal(rangerHp - ranger.hp, 65);
  const state = game.snapshot();
  assert.ok(state.players.find((player) => player.id === 'vanguard').guardRemaining > 0);
});

test('枪手短射程叠加三层标记，控场消耗标记且射击期间降速', () => {
  const game = new GameState({ code: 'RANG24', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  game.enemies.clear();
  for (const zoneId of game.encounterQueues.keys()) game.encounterQueues.set(zoneId, []);
  const ranger = game.players.get('ranger');
  const vanguard = game.players.get('vanguard');
  vanguard.invulnerable = 99;
  ranger.facing = { x: 1, y: 0 };
  const target = game._spawnEnemy('brute', {
    x: ranger.x + 145,
    y: ranger.y,
    countsForZone: false,
  });
  for (let shot = 0; shot < 3; shot += 1) {
    game._playerAttack(ranger, GAME_SPECS.players.ranger);
    for (let tick = 0; tick < 12; tick += 1) game._updateProjectiles(1 / 60);
  }
  assert.equal(target.markStacks, 3);
  assert.equal(target.markRemaining, 3.2);
  game.setInput('ranger', holdStill({ skill: true }), 1);
  game.update(1 / 30);
  assert.equal(target.markStacks, 0);
  assert.equal(target.slowMultiplier, 0.65);
  assert.ok(target.slowRemaining > 2.1);
  assert.ok(target.rootRemaining > 0.2 && target.rootRemaining <= 0.25);
  assert.ok(ranger.skillCooldown > 6.4);

  game.enemies.clear();
  game.projectiles.clear();
  const distant = game._spawnEnemy('crawler', {
    x: ranger.x + 650,
    y: ranger.y,
    countsForZone: false,
  });
  const distantHp = distant.hp;
  game._playerAttack(ranger, GAME_SPECS.players.ranger);
  const projectile = [...game.projectiles.values()][0];
  assert.equal(projectile.ttl, 0.78);
  assert.equal(Math.hypot(projectile.vx, projectile.vy), 720);
  for (let tick = 0; tick < 60; tick += 1) game._updateProjectiles(1 / 60);
  assert.equal(distant.hp, distantHp, '鱼叉不应再命中 650 距离外的目标');

  game.enemies.clear();
  ranger.shotSlowRemaining = 0.22;
  const previousX = ranger.x;
  game.setInput('ranger', holdStill({ move: { x: 1, y: 0 } }), 2);
  game.update(0.05);
  assert.ok(Math.abs(ranger.x - previousX - 260 * 0.65 * 0.05) < 0.02);
});

test('movementZones 同时约束权威移速，并在天关风区施加有限风推', () => {
  const game = new GameState({ code: 'MOVE24', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  game.enemies.clear();
  for (const zoneId of game.encounterQueues.keys()) game.encounterQueues.set(zoneId, []);
  const vanguard = game.players.get('vanguard');
  const ranger = game.players.get('ranger');
  vanguard.x = 1000;
  vanguard.y = 2200;
  ranger.x = 700;
  ranger.y = 2450;
  const previousX = vanguard.x;
  game.setInput('vanguard', holdStill({ move: { x: 1, y: 0 } }), 1);
  game.update(0.05);
  assert.ok(Math.abs(vanguard.x - previousX - 245 * 0.82 * 0.05) < 0.02);

  game.phaseIndex = 2;
  game._startStage({ resetProgress: false });
  game.enemies.clear();
  for (const zoneId of game.encounterQueues.keys()) game.encounterQueues.set(zoneId, []);
  vanguard.x = 1300;
  vanguard.y = 2000;
  ranger.x = 800;
  ranger.y = 2500;
  game.setInput('vanguard', holdStill(), 2);
  const beforeWind = { x: vanguard.x, y: vanguard.y };
  game.update(0.05);
  assert.ok(vanguard.x > beforeWind.x);
  assert.ok(vanguard.y < beforeWind.y);
  assert.ok(Math.hypot(vanguard.x - beforeWind.x, vanguard.y - beforeWind.y) <= 245 * 0.18 * 0.05 + 0.01);
});

test('单人枪手 AI 在中距离低速横移，并会主动引爆多目标标记', () => {
  const game = createSoloGame({ code: 'AISK24', rng: () => 0.2, playerId: 'human' });
  game.enemies.clear();
  for (const zoneId of game.encounterQueues.keys()) game.encounterQueues.set(zoneId, []);
  const ai = [...game.players.values()].find((player) => player.isAI);
  const first = game._spawnEnemy('crawler', {
    x: ai.x + 240,
    y: ai.y,
    countsForZone: false,
  });
  first.markStacks = 1;
  first.markRemaining = 3;
  const second = game._spawnEnemy('crawler', {
    x: ai.x + 250,
    y: ai.y + 45,
    countsForZone: false,
  });
  second.markStacks = 1;
  second.markRemaining = 3;
  game._updateAIInput(ai);
  assert.ok(Math.abs(Math.hypot(ai.input.move.x, ai.input.move.y) - 0.45) < 0.001);
  assert.equal(ai.input.attack, true);
  assert.equal(ai.input.skill, true);
});

test('第三猎场单人 AI 能从真实出生点依次追到三个封印目标附近', () => {
  const game = createSoloGame({ code: 'AIPATH', rng: () => 0.2, playerId: 'human' });
  game.phaseIndex = 2;
  game._startStage({ resetProgress: false });
  game.enemies.clear();
  for (const zoneId of game.encounterQueues.keys()) game.encounterQueues.set(zoneId, []);

  const human = game.players.get('human');
  const ai = [...game.players.values()].find((player) => player.isAI);
  assert.equal(ai.x, game.phase.spawn.x + 46);
  assert.equal(ai.y, game.phase.spawn.y - 18);

  for (const target of game.phase.objectives) {
    let reached = false;
    for (let index = 0; index < 45 * 20; index += 1) {
      human.x = target.x;
      human.y = target.y;
      game.update(0.05);
      assert.equal(
        circleInsideStageWalkable(ai, ai.radius, game.phase),
        true,
        `${target.id}：AI 追踪途中必须完整留在可行走区域`,
      );
      if (Math.hypot(ai.x - target.x, ai.y - target.y) <= 200) {
        reached = true;
        break;
      }
    }
    assert.equal(reached, true, `${target.id}：AI 应在 45 秒内追到实际目标附近`);
  }
});

test('第一猎场的多种随机遭遇都不会被 AI 枪手无伤瞬间清空', () => {
  for (const code of ['BAL123', 'RRXYZ2', 'BGPQRS', 'NGNPQR']) {
    const game = createSoloGame({ code, rng: () => 0.2, playerId: 'human' });
    const human = game.players.get('human');
    const ai = [...game.players.values()].find((player) => player.isAI);
    const zone = game.phase.zones.find((entry) => entry.kind === 'hunt');
    let humanHits = 0;
    const damagePlayer = game._damagePlayer.bind(game);
    game._damagePlayer = (player, amount) => {
      const previousHp = player.hp;
      const result = damagePlayer(player, amount);
      if (player === human && player.hp < previousHp) humanHits += 1;
      return result;
    };
    human.x = zone.center.x;
    human.y = zone.center.y;
    ai.x = zone.center.x - 80;
    ai.y = zone.center.y + 30;

    for (let index = 0; index < 12 * 30; index += 1) game.update(1 / 30);

    assert.ok(
      game.zoneStates.get(zone.id).remaining >= 2,
      `${code}：12 秒后猎场至少应剩余 2 只怪`,
    );
    assert.ok(ai.kills <= 6, `${code}：枪手短射程与射击节奏必须限制前期清场速度`);
    assert.ok(humanHits > 0, `${code}：接敌后真人必须实际受到至少一次伤害`);
  }
});

test('队友持续互动可以救起倒地玩家，倒地动作会公开', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop', rng: () => 0.5 });
  addCoopPair(game);
  const rescuer = game.players.get('vanguard');
  const downed = game.players.get('ranger');
  rescuer.invulnerable = 99;
  downed.invulnerable = 0;
  downed.x = rescuer.x + 45;
  downed.y = rescuer.y;
  game._damagePlayer(downed, GAME_SPECS.players.ranger.maxHp + 10);
  assert.equal(downed.status, 'downed');
  assert.equal(game.snapshot().players.find((player) => player.id === 'ranger').action, 'down');
  game.setInput('vanguard', holdStill({ interact: true }), 1);

  for (let i = 0; i < 39; i += 1) game.update(0.05);
  assert.equal(downed.status, 'active');
  assert.equal(downed.hp, Math.round(downed.maxHp * 0.46));
  assert.equal(rescuer.revives, 1);
  assert.equal(game.snapshot().players.find((player) => player.id === 'vanguard').revives, 1);
});

test('敌人只在局部警戒范围内激活，越过牵引范围会回巢并恢复', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  const enemy = [...game.enemies.values()][0];
  const player = game.players.get('vanguard');
  assert.equal(enemy.awake, false);
  player.x = enemy.x - 100;
  player.y = enemy.y;
  player.invulnerable = 99;
  game.update(0.05);
  assert.equal(enemy.awake, true);
  enemy.hp -= 10;
  player.x = ARENA.width - 200;
  player.y = 200;
  const teammate = game.players.get('ranger');
  teammate.x = ARENA.width - 260;
  teammate.y = 260;
  teammate.invulnerable = 99;
  for (let i = 0; i < 240; i += 1) game.update(0.05);
  assert.equal(enemy.awake, false);
  assert.equal(enemy.hp, enemy.maxHp);
  assert.ok(Math.hypot(enemy.x - enemy.homeX, enemy.y - enemy.homeY) < 10);
});

test('清理三个区域后逐一拾取雾印并激活 Boss', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  const hunter = game.players.get('vanguard');
  hunter.invulnerable = 99;

  for (const zoneId of ['salt_marsh', 'sunk_market', 'lighthouse_ruins']) {
    defeatZone(game, zoneId);
    const seal = game.collectibles.get(`seal-${zoneId}`);
    assert.equal(game.zoneStates.get(zoneId).cleared, true);
    assert.equal(seal.available, true);
    collectSeal(game, zoneId);
  }

  assert.equal(game.run.sealsCollected, 3);
  assert.equal(game.run.bossActivated, true);
  const boss = [...game.enemies.values()].find((enemy) => enemy.boss);
  assert.ok(boss);
  const state = game.snapshot();
  assert.equal(state.objective.step, 'defeat_boss');
  assert.equal(state.progress.sealsCollected, 3);
});

test('击败第一关 Boss 后必须双人都在出口持续互动约一秒才能结算关卡', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  for (const zoneId of ['salt_marsh', 'sunk_market', 'lighthouse_ruins']) {
    defeatZone(game, zoneId);
    collectSeal(game, zoneId);
  }
  const boss = [...game.enemies.values()].find((enemy) => enemy.boss);
  game._damageEnemy(boss, boss.hp + 1, 'vanguard');
  assert.equal(game.snapshot().exit.unlocked, true);

  const [first, second] = [...game.players.values()];
  for (const player of [first, second]) {
    player.x = game.snapshot().exit.x;
    player.y = game.snapshot().exit.y;
    player.invulnerable = 99;
  }
  game.setInput(first.id, holdStill({ interact: true }), first.lastSeq + 1);
  for (let i = 0; i < 22; i += 1) game.update(0.05);
  assert.equal(game.stageStatus, 'active', '只有一人互动不能离开');
  assert.equal(game.run.exitProgress, 0);

  game.setInput(second.id, holdStill({ interact: true }), second.lastSeq + 1);
  for (let i = 0; i < 20; i += 1) game.update(0.05);
  assert.equal(game.stageStatus, 'stage_complete');
  assert.equal(game.result.status, 'stage_complete');
  const completed = game.snapshot();
  assert.equal(completed.objective.step, 'stage_complete');
  assert.match(completed.stage.transitionToken, /^[0-9a-f-]{36}$/i);
  assert.ok(completed.result.elapsed >= 1);
  assert.equal(completed.result.kills, completed.players.reduce((total, player) => total + player.kills, 0));
  assert.equal(completed.result.revives, 0);
});

test('出口判胜在当前 tick 立即终止战斗，不会被残留敌人覆盖为全灭', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop', rng: () => 0 });
  addCoopPair(game);
  game.enemies.clear();
  game.run.sealsCollected = 3;
  game.run.bossActivated = true;
  game.run.bossDefeated = true;
  game.run.exitUnlocked = true;
  game.run.exitProgress = 0.99;
  const exit = game.snapshot().exit;

  let enemyOffset = 0;
  for (const player of game.players.values()) {
    player.x = exit.x;
    player.y = exit.y;
    player.hp = 1;
    player.invulnerable = 0;
    game.setInput(player.id, holdStill({ interact: true }), player.lastSeq + 1);
    const enemy = game._spawnEnemy('crawler', {
      x: exit.x + (enemyOffset += 2),
      y: exit.y,
      zoneId: 'fog_heart',
      awake: true,
      countsForZone: false,
    });
    enemy.attackCooldown = 0;
    enemy.homeX = exit.x;
    enemy.homeY = exit.y;
  }

  game.update(0.02);
  const state = game.snapshot();
  assert.equal(state.stage.status, 'stage_complete');
  assert.equal(state.result.status, 'stage_complete');
  assert.ok(state.players.every((player) => player.status === 'active' && player.hp === 1));
  assert.equal(state.exit.progress, 1);
});

test('单人试炼的出口只要求真人，AI 会跟随并参与战斗', () => {
  const game = createSoloGame({ code: 'SOLO22', rng: () => 0.2, playerId: 'human' });
  const human = game.players.get('human');
  const ai = [...game.players.values()].find((player) => player.isAI);
  game.enemies.clear();
  human.x += 500;
  const previousX = ai.x;
  game.update(0.05);
  assert.ok(ai.x > previousX, '没有附近敌人时 AI 应跟随真人');

  game.run.sealsCollected = 3;
  game.run.bossActivated = true;
  game.run.bossDefeated = true;
  game.run.exitUnlocked = true;
  human.x = game.snapshot().exit.x;
  human.y = game.snapshot().exit.y;
  game.setInput('human', holdStill({ interact: true }), human.lastSeq + 1);
  for (let i = 0; i < 20; i += 1) game.update(0.05);
  assert.equal(game.stageStatus, 'stage_complete');
});

test('幂等换关令牌只推进一次，等级成长跨关保留，第三关才进入胜利', () => {
  const game = new GameState({ code: 'STG234', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  game._awardPartyXp(80);
  const carriedLevels = [...game.players.values()].map((player) => player.level);
  const carriedPower = [...game.players.values()].map((player) => player.power);

  game._completeExpedition();
  let state = game.snapshot();
  const firstToken = state.stage.transitionToken;
  assert.equal(state.stage.index, 1);
  assert.equal(state.stage.status, 'stage_complete');

  const firstAdvance = game.restartCampaign({ transitionToken: firstToken });
  assert.deepEqual(firstAdvance, {
    accepted: true,
    action: 'advance',
    alreadyApplied: false,
  });
  state = game.snapshot();
  assert.equal(state.stage.index, 2);
  assert.equal(state.stage.mapKey, 'stage-02');
  assert.equal(state.stage.title, '赤灯潮市');
  assert.deepEqual(state.players.map((player) => player.level), carriedLevels);
  assert.deepEqual(state.players.map((player) => player.power), carriedPower);
  assert.ok(state.players.every((player) => player.hp === player.maxHp));

  const duplicate = game.restartCampaign({ transitionToken: firstToken });
  assert.deepEqual(duplicate, {
    accepted: true,
    action: 'advance',
    alreadyApplied: true,
  });
  assert.equal(game.snapshot().stage.index, 2);
  assert.equal(game.restartCampaign({ transitionToken: 'stale-token' }).accepted, false);

  game._completeExpedition();
  const secondToken = game.snapshot().stage.transitionToken;
  assert.equal(game.restartCampaign({ transitionToken: secondToken }).accepted, true);
  state = game.snapshot();
  assert.equal(state.stage.index, 3);
  assert.equal(state.stage.mapKey, 'stage-03');
  assert.equal(state.stage.title, '云汐天关');
  assert.deepEqual(state.players.map((player) => player.level), carriedLevels);

  game._completeExpedition();
  state = game.snapshot();
  assert.equal(state.stage.status, 'victory');
  assert.equal(state.result.status, 'victory');
  assert.match(state.stage.transitionToken, /^[0-9a-f-]{36}$/i);

  const restarted = game.restartCampaign({ transitionToken: state.stage.transitionToken });
  assert.deepEqual(restarted, {
    accepted: true,
    action: 'restart',
    alreadyApplied: false,
  });
  state = game.snapshot();
  assert.equal(state.stage.index, 1);
  assert.equal(state.stage.status, 'active');
  assert.ok(state.players.every((player) => player.level === 1 && player.power === 1));
});

test('升级增加伤害与生命，全队共享经验但击杀数归最后一击玩家', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  const first = game.players.get('vanguard');
  const second = game.players.get('ranger');
  const oldFirstHp = first.maxHp;
  const oldSecondHp = second.maxHp;
  game._awardPartyXp(80);
  assert.equal(first.level, 2);
  assert.equal(second.level, 2);
  assert.equal(first.power, 1.06);
  assert.equal(second.power, 1.06);
  assert.equal(first.maxHp, Math.round(oldFirstHp * 1.05));
  assert.equal(second.maxHp, Math.round(oldSecondHp * 1.05));
  assert.ok(first.maxHp > oldFirstHp);
  assert.ok(second.maxHp > oldSecondHp);
});

test('全灭回营地但保留等级、雾印、死去怪物，存活敌人回巢满血', () => {
  const game = new GameState({ code: 'ABC234', mode: 'coop', rng: () => 0.6 });
  addCoopPair(game);
  defeatZone(game, 'salt_marsh');
  collectSeal(game, 'salt_marsh');
  game._awardPartyXp(80);
  const alive = [...game.enemies.values()].find((enemy) => enemy.status === 'active');
  alive.hp = 1;
  alive.x += 140;
  const enemyCount = [...game.enemies.values()].filter((enemy) => enemy.status === 'active').length;
  const levels = [...game.players.values()].map((player) => player.level);

  for (const player of game.players.values()) {
    player.invulnerable = 0;
    game._damagePlayer(player, player.maxHp + 1);
  }
  game.update(1 / 30);
  assert.equal(game.snapshot().result.status, 'wipe');
  assert.equal(game.snapshot().stage.status, 'resetting');
  for (let i = 0; i < 50; i += 1) game.update(0.05);

  const state = game.snapshot();
  assert.equal(state.stage.status, 'active');
  assert.equal(state.result, null);
  assert.equal(state.progress.sealsCollected, 1);
  assert.equal(state.enemies.length, enemyCount);
  assert.deepEqual(state.players.map((player) => player.level), levels);
  assert.ok(state.players.every((player) => player.status === 'active' && player.hp === player.maxHp));
  assert.equal(alive.hp, alive.maxHp);
  assert.equal(alive.x, alive.homeX);
  assert.equal(alive.y, alive.homeY);
});
