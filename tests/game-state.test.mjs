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

test('敌人与单人 AI 会稳定绕过集市残墙继续接近目标', () => {
  const wall = GAME_OBSTACLES.find((obstacle) => obstacle.id === 'market-arcade-wall');
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
    ...overrides,
  };
}

function defeatZone(game, zoneId, ownerId = 'vanguard') {
  for (const enemy of [...game.enemies.values()].filter((candidate) => candidate.zoneId === zoneId)) {
    game._damageEnemy(enemy, enemy.hp + 1, ownerId);
  }
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
  assert.equal(state.enemies.length, 18);
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
  assert.ok(snapshot.obstacles.length >= 12 && snapshot.obstacles.length <= 18);
  assert.ok(snapshot.obstacles.every((obstacle) =>
    obstacle.solid === true
    && ['rect', 'circle'].includes(obstacle.shape)
    && typeof obstacle.kind === 'string'
    && ['rock', 'wall', 'bridge', 'stall', 'tower', 'gate', 'pillar'].includes(obstacle.visualKind)
    && typeof obstacle.name === 'string',
  ));

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
    { x: 520, y: 2440, label: '营地出生点' },
    { x: 1620, y: 2240, label: '盐雾湿地' },
    { x: 2640, y: 1280, label: '沉没集市' },
    { x: 4140, y: 2020, label: '灯塔遗址' },
    { x: 4380, y: 650, label: 'Boss 场' },
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

test('服务器碰撞阻止玩家和敌人穿过残墙，弹体也会被实体地形拦截', () => {
  const game = new GameState({ code: 'WALL23', mode: 'coop', rng: () => 0.2 });
  addCoopPair(game);
  game.enemies.clear();
  const wall = GAME_OBSTACLES.find((obstacle) => obstacle.id === 'market-arcade-wall');
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
  assert.equal(player.xp, GAME_SPECS.enemies.crawler.xpValue);
  assert.equal(teammate.xp, GAME_SPECS.enemies.crawler.xpValue);
  assert.equal(player.kills, 1);
  assert.equal(game.snapshot().players.find((item) => item.id === 'vanguard').action, 'attack');

  assert.equal(game._damageEnemy(target, 999, 'vanguard'), false, 'tombstone 不可被重复结算');
  assert.equal(player.xp, GAME_SPECS.enemies.crawler.xpValue);
  assert.equal(player.kills, 1);
  for (let index = 0; index < 7; index += 1) game.update(0.05);
  defeated = game.snapshot().enemies.find((enemy) => enemy.id === target.id);
  assert.equal(defeated.status, 'defeated', '0.35 秒后仍应可见');
  assert.ok(defeated.deathRemaining >= 0.4);
  for (let index = 0; index < 10; index += 1) game.update(0.05);
  assert.equal(game.enemies.has(target.id), false, '0.8 秒后才从权威状态删除');
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
  assert.equal(first.power, 1.1);
  assert.equal(second.power, 1.1);
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
