import { randomUUID } from 'node:crypto';
import { GAME_STAGES } from './game-stages.mjs';

export const TICK_RATE = 30;
export const STATE_VERSION = 3;
export const ARENA = Object.freeze({
  width: 5120,
  height: 2880,
  padding: 64,
  viewportWidth: 1280,
  viewportHeight: 720,
});
export const WORLD = ARENA;

const SPAWN = Object.freeze({ x: 520, y: 2440 });
const EXIT = Object.freeze({ x: 4720, y: 330, radius: 118, holdSeconds: 1 });
const BOSS_SPAWN = Object.freeze({ x: 4380, y: 650 });
const ENEMY_TOMBSTONE_SECONDS = 0.8;

// Static collision landmarks. The client receives the same records in every
// snapshot so art can be layered over the exact server-authoritative shapes.
// They intentionally sit beside the expedition's broad route instead of
// forming gates: players can approach every hunt zone, seal, boss, and exit
// from more than one direction.
const OBSTACLE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'camp-supply-hut', name: '补给棚屋', kind: 'shack', shape: 'rect', x: 180, y: 2040, width: 260, height: 190, solid: true }),
  Object.freeze({ id: 'camp-broken-pier', name: '断裂码头', kind: 'dock_ruin', shape: 'rect', x: 760, y: 2640, width: 300, height: 90, solid: true }),
  Object.freeze({ id: 'marsh-sunken-skiff', name: '沉没小舟', kind: 'dock_ruin', shape: 'rect', x: 970, y: 2500, width: 250, height: 100, solid: true }),
  Object.freeze({ id: 'marsh-west-reef', name: '西侧岩礁', kind: 'reef', shape: 'circle', x: 1210, y: 1810, radius: 95, solid: true }),
  Object.freeze({ id: 'marsh-flood-wall', name: '浸水矮墙', kind: 'wall', shape: 'rect', x: 1660, y: 1770, width: 360, height: 90, solid: true }),
  Object.freeze({ id: 'marsh-east-reef', name: '东侧岩礁', kind: 'reef', shape: 'circle', x: 2160, y: 2730, radius: 100, solid: true }),
  Object.freeze({ id: 'market-canvas-stalls', name: '倾倒棚摊', kind: 'stall', shape: 'rect', x: 1900, y: 1120, width: 280, height: 150, solid: true }),
  Object.freeze({ id: 'market-arcade-wall', name: '集市残墙', kind: 'wall', shape: 'rect', x: 2220, y: 760, width: 100, height: 350, solid: true }),
  Object.freeze({ id: 'market-wrecked-quay', name: '货栈废墟', kind: 'dock_ruin', shape: 'rect', x: 2720, y: 1370, width: 340, height: 100, solid: true }),
  Object.freeze({ id: 'market-fountain', name: '潮蚀石台', kind: 'reef', shape: 'circle', x: 3060, y: 800, radius: 100, solid: true }),
  Object.freeze({ id: 'ruins-lower-wall', name: '灯塔下墙', kind: 'wall', shape: 'rect', x: 3370, y: 1930, width: 430, height: 90, solid: true }),
  Object.freeze({ id: 'ruins-tide-reef', name: '潮沟岩礁', kind: 'reef', shape: 'circle', x: 4040, y: 2310, radius: 120, solid: true }),
  Object.freeze({ id: 'ruins-tower-base', name: '旧塔基座', kind: 'tower', shape: 'circle', x: 4590, y: 1480, radius: 120, solid: true }),
  Object.freeze({ id: 'ruins-broken-quay', name: '崩塌长堤', kind: 'dock_ruin', shape: 'rect', x: 4480, y: 2420, width: 380, height: 90, solid: true }),
  Object.freeze({ id: 'heart-cliff-wall', name: '雾心断崖', kind: 'wall', shape: 'rect', x: 3630, y: 800, width: 400, height: 100, solid: true }),
  Object.freeze({ id: 'heart-bell-pillar', name: '残钟石柱', kind: 'pillar', shape: 'circle', x: 4080, y: 300, radius: 90, solid: true }),
  Object.freeze({ id: 'heart-east-reef', name: '出口岩礁', kind: 'reef', shape: 'circle', x: 4830, y: 800, radius: 105, solid: true }),
]);

const PLAYER_SPECS = Object.freeze({
  vanguard: { maxHp: 150, speed: 245, radius: 24, attackCooldown: 0.48 },
  ranger: { maxHp: 105, speed: 275, radius: 21, attackCooldown: 0.3 },
});

const ENEMY_SPECS = Object.freeze({
  crawler: {
    hp: 58, speed: 112, radius: 21, damage: 10, attackRange: 49, attackCooldown: 1.05, xpValue: 20,
  },
  spitter: {
    hp: 46, speed: 76, radius: 20, damage: 8, attackRange: 440, attackCooldown: 1.7, xpValue: 25,
  },
  brute: {
    hp: 210, speed: 68, radius: 34, damage: 21, attackRange: 67, attackCooldown: 1.4, xpValue: 60,
  },
  siren: {
    hp: 135, speed: 82, radius: 27, damage: 12, attackRange: 510, attackCooldown: 1.45, xpValue: 70,
  },
  fog_colossus: {
    hp: 1150, speed: 53, radius: 61, damage: 27, attackRange: 92, attackCooldown: 1.25, xpValue: 250,
  },
  lantern_regent: {
    hp: 1350, speed: 58, radius: 62, damage: 29, attackRange: 96, attackCooldown: 1.2, xpValue: 300,
  },
  tide_tortoise: {
    hp: 1650, speed: 46, radius: 70, damage: 32, attackRange: 104, attackCooldown: 1.35, xpValue: 360,
  },
});

const PHASES = GAME_STAGES;

const ZONE_DEFINITIONS = Object.freeze([
  {
    id: 'camp', name: '猎团营地', kind: 'safe', x: 0, y: 1880, width: 1260, height: 1000,
    center: { x: 560, y: 2420 }, hasSeal: false,
  },
  {
    id: 'salt_marsh', name: '盐雾湿地', kind: 'hunt', x: 860, y: 1640, width: 1640, height: 1240,
    center: { x: 1620, y: 2240 }, hasSeal: true,
  },
  {
    id: 'sunk_market', name: '沉没集市', kind: 'hunt', x: 1660, y: 600, width: 1900, height: 1320,
    center: { x: 2640, y: 1280 }, hasSeal: true,
  },
  {
    id: 'lighthouse_ruins', name: '灯塔遗址', kind: 'hunt', x: 3220, y: 1240, width: 1900, height: 1580,
    center: { x: 4140, y: 2020 }, hasSeal: true,
  },
  {
    id: 'fog_heart', name: '潮雾之心', kind: 'boss', x: 3560, y: 0, width: 1560, height: 1260,
    center: { x: 4380, y: 620 }, hasSeal: false,
  },
]);

const ZONE_BY_ID = new Map(ZONE_DEFINITIONS.map((zone) => [zone.id, zone]));

const ENCOUNTERS = Object.freeze([
  { zoneId: 'salt_marsh', type: 'crawler', x: 1220, y: 2280 },
  { zoneId: 'salt_marsh', type: 'crawler', x: 1450, y: 2050 },
  { zoneId: 'salt_marsh', type: 'crawler', x: 1840, y: 2420 },
  { zoneId: 'salt_marsh', type: 'spitter', x: 2020, y: 2110 },
  { zoneId: 'salt_marsh', type: 'spitter', x: 1660, y: 2640 },
  { zoneId: 'salt_marsh', type: 'brute', x: 2180, y: 2520 },

  { zoneId: 'sunk_market', type: 'crawler', x: 2040, y: 1460 },
  { zoneId: 'sunk_market', type: 'crawler', x: 2420, y: 1040 },
  { zoneId: 'sunk_market', type: 'spitter', x: 2860, y: 1520 },
  { zoneId: 'sunk_market', type: 'spitter', x: 3200, y: 980 },
  { zoneId: 'sunk_market', type: 'brute', x: 2700, y: 820 },
  { zoneId: 'sunk_market', type: 'siren', x: 3300, y: 1640 },

  { zoneId: 'lighthouse_ruins', type: 'crawler', x: 3520, y: 2240 },
  { zoneId: 'lighthouse_ruins', type: 'crawler', x: 4050, y: 2560 },
  { zoneId: 'lighthouse_ruins', type: 'spitter', x: 4580, y: 2280 },
  { zoneId: 'lighthouse_ruins', type: 'brute', x: 3820, y: 1760 },
  { zoneId: 'lighthouse_ruins', type: 'brute', x: 4740, y: 1740 },
  { zoneId: 'lighthouse_ruins', type: 'siren', x: 4320, y: 1420 },
]);

const SEAL_POSITIONS = Object.freeze({
  salt_marsh: { x: 2180, y: 2480 },
  sunk_market: { x: 3060, y: 1260 },
  lighthouse_ruins: { x: 4480, y: 1940 },
});

const EMPTY_INPUT = Object.freeze({
  move: { x: 0, y: 0 },
  aim: { x: 1, y: 0 },
  attack: false,
  interact: false,
  dodge: false,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function normalized(x, y, fallback = { x: 0, y: 0 }) {
  const length = Math.hypot(x, y);
  if (length < 0.0001) return { ...fallback };
  return { x: x / length, y: y / length };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function publicNumber(value) {
  return Math.round(finite(value) * 10) / 10;
}

function safeName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 18);
  return cleaned || fallback;
}

function xpNeededForLevel(level) {
  return 80 + Math.max(0, level - 1) * 60;
}

function zoneContains(zone, actor, margin = 0) {
  return actor.x >= zone.x - margin
    && actor.x <= zone.x + zone.width + margin
    && actor.y >= zone.y - margin
    && actor.y <= zone.y + zone.height + margin;
}

function circleIntersectsObstacle(circle, obstacle, margin = 0) {
  const radius = Math.max(0, finite(circle?.radius)) + Math.max(0, finite(margin));
  if (obstacle.shape === 'circle') {
    const minimum = radius + obstacle.radius;
    const dx = finite(circle?.x) - obstacle.x;
    const dy = finite(circle?.y) - obstacle.y;
    return dx * dx + dy * dy < minimum * minimum;
  }
  const nearestX = clamp(finite(circle?.x), obstacle.x, obstacle.x + obstacle.width);
  const nearestY = clamp(finite(circle?.y), obstacle.y, obstacle.y + obstacle.height);
  const dx = finite(circle?.x) - nearestX;
  const dy = finite(circle?.y) - nearestY;
  return dx * dx + dy * dy < radius * radius;
}

function pushCircleOutOfObstacle(circle, obstacle) {
  const radius = Math.max(0, finite(circle?.radius));
  const epsilon = 0.01;
  if (obstacle.shape === 'circle') {
    const dx = finite(circle.x) - obstacle.x;
    const dy = finite(circle.y) - obstacle.y;
    const minimum = radius + obstacle.radius;
    const squaredDistance = dx * dx + dy * dy;
    if (squaredDistance >= minimum * minimum) return false;
    if (squaredDistance < 0.000001) {
      circle.x = obstacle.x + minimum + epsilon;
      return true;
    }
    const actualDistance = Math.sqrt(squaredDistance);
    const push = minimum - actualDistance + epsilon;
    circle.x += (dx / actualDistance) * push;
    circle.y += (dy / actualDistance) * push;
    return true;
  }

  const left = obstacle.x;
  const right = obstacle.x + obstacle.width;
  const top = obstacle.y;
  const bottom = obstacle.y + obstacle.height;
  const nearestX = clamp(finite(circle.x), left, right);
  const nearestY = clamp(finite(circle.y), top, bottom);
  const dx = finite(circle.x) - nearestX;
  const dy = finite(circle.y) - nearestY;
  const squaredDistance = dx * dx + dy * dy;
  if (squaredDistance >= radius * radius) return false;

  if (squaredDistance > 0.000001) {
    const actualDistance = Math.sqrt(squaredDistance);
    const push = radius - actualDistance + epsilon;
    circle.x += (dx / actualDistance) * push;
    circle.y += (dy / actualDistance) * push;
    return true;
  }

  // The actor's centre is inside (or exactly on) the rectangle. Choose the
  // nearest edge, which is both deterministic and gives natural wall sliding.
  const exits = [
    { distance: Math.abs(circle.x - left), axis: 'x', value: left - radius - epsilon },
    { distance: Math.abs(right - circle.x), axis: 'x', value: right + radius + epsilon },
    { distance: Math.abs(circle.y - top), axis: 'y', value: top - radius - epsilon },
    { distance: Math.abs(bottom - circle.y), axis: 'y', value: bottom + radius + epsilon },
  ].sort((a, b) => a.distance - b.distance);
  circle[exits[0].axis] = exits[0].value;
  return true;
}

function segmentIntersectsObstacle(from, to, obstacle, clearance = 0) {
  const padding = Math.max(0, finite(clearance));
  const dx = finite(to?.x) - finite(from?.x);
  const dy = finite(to?.y) - finite(from?.y);

  if (obstacle.shape === 'circle') {
    const radius = obstacle.radius + padding;
    const lengthSquared = dx * dx + dy * dy;
    const projection = lengthSquared > 0.000001
      ? clamp(((obstacle.x - from.x) * dx + (obstacle.y - from.y) * dy) / lengthSquared, 0, 1)
      : 0;
    const nearestX = from.x + dx * projection;
    const nearestY = from.y + dy * projection;
    const offsetX = nearestX - obstacle.x;
    const offsetY = nearestY - obstacle.y;
    return offsetX * offsetX + offsetY * offsetY <= radius * radius;
  }

  const bounds = {
    left: obstacle.x - padding,
    right: obstacle.x + obstacle.width + padding,
    top: obstacle.y - padding,
    bottom: obstacle.y + obstacle.height + padding,
  };
  let minimumTime = 0;
  let maximumTime = 1;
  for (const [origin, delta, minimum, maximum] of [
    [from.x, dx, bounds.left, bounds.right],
    [from.y, dy, bounds.top, bounds.bottom],
  ]) {
    if (Math.abs(delta) < 0.000001) {
      if (origin < minimum || origin > maximum) return false;
      continue;
    }
    const first = (minimum - origin) / delta;
    const second = (maximum - origin) / delta;
    minimumTime = Math.max(minimumTime, Math.min(first, second));
    maximumTime = Math.min(maximumTime, Math.max(first, second));
    if (maximumTime < minimumTime) return false;
  }
  return maximumTime >= 0 && minimumTime <= 1;
}

function stableParity(value) {
  let hash = 0;
  for (const character of String(value ?? '')) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 2;
}

/**
 * Server-authoritative state for one two-hunter expedition. Networking
 * credentials deliberately stay outside this class so snapshots cannot leak
 * reconnect tokens.
 */
export class GameState {
  constructor({ code = 'LOCAL0', mode = 'coop', rng = Math.random, now = Date.now } = {}) {
    if (!['coop', 'solo'].includes(mode)) throw new TypeError('mode must be coop or solo');
    this.stateVersion = STATE_VERSION;
    this.code = code;
    this.mode = mode;
    this.rng = rng;
    this.now = now;
    this.tick = 0;
    this.players = new Map();
    this.enemies = new Map();
    this.projectiles = new Map();
    this.effects = [];
    this.phaseIndex = 0;
    this.phaseKills = 0;
    this.stageStatus = 'waiting';
    this.transitionRemaining = 0;
    this.result = null;
    this.pendingTransitionToken = null;
    this.lastAppliedTransitionToken = null;
    this.lastAppliedTransitionAction = null;
    this._enemySerial = 0;
    this._projectileSerial = 0;
    this._effectSerial = 0;
    this._bossAdds = new Set();
    this.run = this._newRun();
    this.zoneStates = this._newZoneStates();
    this.collectibles = this._newCollectibles();
  }

  get phase() {
    return PHASES[this.phaseIndex] ?? PHASES[0];
  }

  get ready() {
    if (this.players.size !== 2) return false;
    if (this.mode === 'solo') {
      return [...this.players.values()].filter((player) => !player.isAI).length === 1;
    }
    return [...this.players.values()].every((player) => !player.isAI);
  }

  addPlayer({ id = randomUUID(), name, role, isAI = false } = {}) {
    if (this.players.size >= 2) throw new Error('room_full');
    if (this.players.has(id)) throw new Error('duplicate_player');
    const chosenRole = role ?? (this.players.size === 0 ? 'vanguard' : 'ranger');
    if (!PLAYER_SPECS[chosenRole]) throw new TypeError('invalid_role');
    const spec = PLAYER_SPECS[chosenRole];
    const slot = this.players.size;
    const player = {
      id,
      name: safeName(name, isAI ? '雾灯守卫' : `猎人 ${slot + 1}`),
      role: chosenRole,
      isAI: Boolean(isAI),
      connected: true,
      x: this.phase.spawn.x + (slot === 0 ? -46 : 46),
      y: this.phase.spawn.y + (slot === 0 ? 18 : -18),
      radius: spec.radius,
      facing: slot === 0 ? { x: 1, y: 0 } : { x: -1, y: 0 },
      hp: spec.maxHp,
      maxHp: spec.maxHp,
      status: 'active',
      reviveProgress: 0,
      reviveNeeded: 1.8,
      bleedOut: 14,
      dodgeCooldown: 0,
      attackCooldown: 0,
      invulnerable: 0,
      dodgeTime: 0,
      dodgeVector: { x: 0, y: 0 },
      lastSeq: -1,
      input: structuredClone(EMPTY_INPUT),
      level: 1,
      xp: 0,
      xpToNext: xpNeededForLevel(1),
      power: 1,
      kills: 0,
      revives: 0,
      action: 'idle',
      actionSeq: 0,
      actionTime: 0,
    };
    this.players.set(id, player);
    if (this.ready && this.stageStatus === 'waiting') this._startExpedition();
    return this._publicPlayer(player);
  }

  setConnected(playerId, connected) {
    const player = this.players.get(playerId);
    if (!player || player.isAI) return false;
    player.connected = Boolean(connected);
    if (!connected) player.input = structuredClone(EMPTY_INPUT);
    return true;
  }

  setInput(playerId, input, seq = undefined) {
    const player = this.players.get(playerId);
    if (!player || player.isAI) return false;
    if (Number.isSafeInteger(seq)) {
      if (seq <= player.lastSeq) return false;
      player.lastSeq = seq;
    }

    const move = input?.move ?? {};
    const aim = input?.aim ?? {};
    const moveVector = normalized(
      clamp(finite(move.x), -1, 1),
      clamp(finite(move.y), -1, 1),
    );
    const rawMoveLength = Math.min(1, Math.hypot(finite(move.x), finite(move.y)));
    moveVector.x *= rawMoveLength;
    moveVector.y *= rawMoveLength;
    const aimVector = normalized(
      clamp(finite(aim.x, player.facing.x), -1, 1),
      clamp(finite(aim.y, player.facing.y), -1, 1),
      player.facing,
    );
    player.input = {
      move: moveVector,
      aim: aimVector,
      attack: input?.attack === true,
      interact: input?.interact === true,
      dodge: input?.dodge === true,
    };
    return true;
  }

  restartCampaign({ transitionToken } = {}) {
    const token = typeof transitionToken === 'string' ? transitionToken : null;
    if (token && token === this.lastAppliedTransitionToken) {
      return {
        accepted: true,
        action: this.lastAppliedTransitionAction,
        alreadyApplied: true,
      };
    }
    if (!this.ready) return { accepted: false, action: null, alreadyApplied: false };

    if (this.stageStatus === 'resetting' && this.result?.status === 'wipe') {
      this._recoverFromWipe();
      return { accepted: true, action: 'recover', alreadyApplied: false };
    }
    if (!['stage_complete', 'victory'].includes(this.stageStatus)) {
      return { accepted: false, action: null, alreadyApplied: false };
    }
    if (!token || token !== this.pendingTransitionToken) {
      return { accepted: false, action: null, alreadyApplied: false };
    }

    const action = this.stageStatus === 'victory' ? 'restart' : 'advance';
    this.lastAppliedTransitionToken = token;
    this.lastAppliedTransitionAction = action;
    this.pendingTransitionToken = null;
    if (action === 'restart') {
      this.phaseIndex = 0;
      this._startStage({ resetProgress: true });
    } else {
      this.phaseIndex += 1;
      this._startStage({ resetProgress: false });
    }
    return { accepted: true, action, alreadyApplied: false };
  }

  /** Restore-time hardening for partially written or early-v2 checkpoints. */
  normalizeRestoredState() {
    this.stateVersion = STATE_VERSION;
    this.phaseIndex = clamp(Math.floor(finite(this.phaseIndex)), 0, PHASES.length - 1);
    if (!(this.players instanceof Map)) this.players = new Map(Object.entries(this.players ?? {}));
    if (!(this.enemies instanceof Map)) this.enemies = new Map(Object.entries(this.enemies ?? {}));
    if (!(this.projectiles instanceof Map)) this.projectiles = new Map(Object.entries(this.projectiles ?? {}));
    if (!(this.zoneStates instanceof Map)) this.zoneStates = this._newZoneStates();
    if (!(this.collectibles instanceof Map)) this.collectibles = this._newCollectibles();
    if (!(this._bossAdds instanceof Set)) this._bossAdds = new Set();
    if (!Array.isArray(this.effects)) this.effects = [];
    this.run = { ...this._newRun(), ...(this.run ?? {}) };
    this.pendingTransitionToken = typeof this.pendingTransitionToken === 'string'
      ? this.pendingTransitionToken
      : null;
    this.lastAppliedTransitionToken = typeof this.lastAppliedTransitionToken === 'string'
      ? this.lastAppliedTransitionToken
      : null;
    this.lastAppliedTransitionAction = ['advance', 'restart'].includes(this.lastAppliedTransitionAction)
      ? this.lastAppliedTransitionAction
      : null;

    for (const [id, player] of this.players) {
      const spec = PLAYER_SPECS[player.role] ?? PLAYER_SPECS.vanguard;
      const level = Math.max(1, Math.floor(finite(player.level, 1)));
      Object.assign(player, {
        id: player.id ?? id,
        radius: finite(player.radius, spec.radius),
        level,
        xp: Math.max(0, finite(player.xp)),
        xpToNext: Math.max(1, finite(player.xpToNext, xpNeededForLevel(level))),
        power: Math.max(1, finite(player.power, 1 + (level - 1) * 0.1)),
        kills: Math.max(0, Math.floor(finite(player.kills))),
        revives: Math.max(0, Math.floor(finite(player.revives))),
        action: typeof player.action === 'string' ? player.action : 'idle',
        actionSeq: Math.max(0, Math.floor(finite(player.actionSeq))),
        actionTime: Math.max(0, finite(player.actionTime)),
        input: player.input ?? structuredClone(EMPTY_INPUT),
      });
    }

    for (const [id, enemy] of this.enemies) {
      const spec = ENEMY_SPECS[enemy.type] ?? ENEMY_SPECS.crawler;
      const status = enemy.status === 'defeated' ? 'defeated' : 'active';
      Object.assign(enemy, {
        id: enemy.id ?? id,
        homeX: finite(enemy.homeX, enemy.x),
        homeY: finite(enemy.homeY, enemy.y),
        aggroRadius: finite(enemy.aggroRadius, 560),
        leashRadius: finite(enemy.leashRadius, enemy.boss ? 1080 : 820),
        awake: Boolean(enemy.awake),
        facing: enemy.facing ?? { x: 1, y: 0 },
        action: typeof enemy.action === 'string' ? enemy.action : 'idle',
        actionSeq: Math.max(0, Math.floor(finite(enemy.actionSeq))),
        actionTime: Math.max(0, finite(enemy.actionTime)),
        xpValue: finite(enemy.xpValue, spec.xpValue),
        name: typeof enemy.name === 'string' ? enemy.name : null,
        epithet: typeof enemy.epithet === 'string' ? enemy.epithet : null,
        bossPattern: enemy.boss ? 'radial' : null,
        countsForZone: enemy.countsForZone !== false,
        status,
        deathRemaining: status === 'defeated'
          ? clamp(finite(enemy.deathRemaining, ENEMY_TOMBSTONE_SECONDS), 0, ENEMY_TOMBSTONE_SECONDS)
          : 0,
      });
    }

    const zoneDefaults = this._newZoneStates();
    for (const zone of this.phase.zones) {
      const defaults = zoneDefaults.get(zone.id);
      this.zoneStates.set(zone.id, { ...defaults, ...(this.zoneStates.get(zone.id) ?? {}) });
      if (zone.hasSeal && !this.collectibles.has(`seal-${zone.id}`)) {
        const position = this.phase.objectives.find((entry) => entry.zoneId === zone.id);
        this.collectibles.set(`seal-${zone.id}`, {
          ...position, available: false, collected: false, collectedBy: null,
        });
      }
    }
    if (['stage_complete', 'victory'].includes(this.stageStatus) && !this.pendingTransitionToken) {
      this.pendingTransitionToken = randomUUID();
    }
    if (this.result && ['stage_complete', 'victory'].includes(this.stageStatus)) {
      this.result.transitionToken = this.pendingTransitionToken;
    }
  }

  update(deltaSeconds) {
    const dt = clamp(finite(deltaSeconds), 0, 0.05);
    if (dt <= 0) return;
    this.tick += 1;
    this._updateEffects(dt);
    this._updateEnemyTombstones(dt);

    if (['waiting', 'stage_complete', 'victory'].includes(this.stageStatus)) return;

    if (this.stageStatus === 'resetting') {
      this.transitionRemaining = Math.max(0, this.transitionRemaining - dt);
      if (this.result) this.result.restartIn = publicNumber(this.transitionRemaining);
      if (this.transitionRemaining <= 0) this._recoverFromWipe();
      return;
    }

    this.run.elapsed += dt;
    for (const player of this.players.values()) {
      if (player.isAI) this._updateAIInput(player);
      player.attackCooldown = Math.max(0, player.attackCooldown - dt);
      player.dodgeCooldown = Math.max(0, player.dodgeCooldown - dt);
      player.invulnerable = Math.max(0, player.invulnerable - dt);
      player.actionTime = Math.max(0, finite(player.actionTime) - dt);
    }

    for (const enemy of this.enemies.values()) {
      enemy.actionTime = Math.max(0, finite(enemy.actionTime) - dt);
    }

    this._updatePlayers(dt);
    this._updateInteractions(dt);
    // Reaching the exit is an atomic terminal event. Do not allow enemies,
    // projectiles, or the wipe check later in this tick to overwrite victory.
    if (['stage_complete', 'victory'].includes(this.stageStatus)) return;
    this._updateEnemies(dt);
    this._updateProjectiles(dt);
    this._separateActors();
    this._updateDiscovery();

    if ([...this.players.values()].every((player) => player.status !== 'active')) {
      this._beginWipe();
    }
  }

  snapshot() {
    const boss = [...this.enemies.values()].find((enemy) => enemy.boss && enemy.status === 'active');
    const objective = this._objectiveSnapshot(boss);
    return {
      stateVersion: this.stateVersion,
      serverTime: this.now(),
      tick: this.tick,
      room: { code: this.code, mode: this.mode, capacity: 2 },
      arena: { ...ARENA },
      stage: {
        index: this.phaseIndex + 1,
        total: PHASES.length,
        id: this.phase.id,
        mapKey: this.phase.mapKey,
        title: this.phase.title,
        objectiveNoun: this.phase.objectiveNoun,
        status: this.stageStatus,
        transitionRemaining: publicNumber(this.transitionRemaining),
        transitionToken: this.pendingTransitionToken,
      },
      objective,
      progress: {
        sealsCollected: this.run.sealsCollected,
        sealsRequired: this.run.sealsRequired,
        bossActivated: this.run.bossActivated,
        bossDefeated: this.run.bossDefeated,
        exitUnlocked: this.run.exitUnlocked,
        exitProgress: publicNumber(this.run.exitProgress),
        elapsed: publicNumber(this.run.elapsed),
      },
      zones: this.phase.zones.map((zone) => ({
        id: zone.id,
        name: zone.name,
        kind: zone.kind,
        x: zone.x,
        y: zone.y,
        width: zone.width,
        height: zone.height,
        center: { ...zone.center },
        hasSeal: zone.hasSeal,
        ...this.zoneStates.get(zone.id),
      })),
      obstacles: this.phase.obstacles.map((obstacle) => ({ ...obstacle })),
      collectibles: [...this.collectibles.values()].map((collectible) => ({ ...collectible })),
      exit: {
        ...this.phase.exit,
        unlocked: this.run.exitUnlocked,
        discovered: Boolean(this.zoneStates.get(this.phase.boss.zoneId)?.discovered),
        progress: publicNumber(this.run.exitProgress),
      },
      players: [...this.players.values()].map((player) => this._publicPlayer(player)),
      enemies: [...this.enemies.values()].map((enemy) => this._publicEnemy(enemy)),
      projectiles: [...this.projectiles.values()].map((projectile) => ({
        id: projectile.id,
        owner: projectile.owner,
        team: projectile.team,
        kind: projectile.kind,
        x: publicNumber(projectile.x),
        y: publicNumber(projectile.y),
        vx: publicNumber(projectile.vx),
        vy: publicNumber(projectile.vy),
        radius: projectile.radius,
      })),
      effects: this.effects.map((effect) => ({
        id: effect.id,
        kind: effect.kind,
        x: publicNumber(effect.x),
        y: publicNumber(effect.y),
        radius: publicNumber(effect.radius),
        ttl: publicNumber(effect.ttl),
      })),
      result: this.result ? { ...this.result } : null,
    };
  }

  _newRun() {
    return {
      sealsRequired: this.phase.objectives.length,
      sealsCollected: 0,
      bossActivated: false,
      bossDefeated: false,
      exitUnlocked: false,
      exitProgress: 0,
      elapsed: 0,
    };
  }

  _newZoneStates() {
    return new Map(this.phase.zones.map((zone) => [zone.id, {
      discovered: zone.kind === 'safe',
      cleared: zone.kind === 'safe',
      remaining: zone.kind === 'hunt'
        ? this.phase.encounters.filter((entry) => entry.zoneId === zone.id).length
        : 0,
    }]));
  }

  _newCollectibles() {
    return new Map(this.phase.objectives.map((objective) => [
      objective.id,
      {
        ...objective,
        available: false,
        collected: false,
        collectedBy: null,
      },
    ]));
  }

  _startExpedition() {
    this.phaseIndex = 0;
    this.lastAppliedTransitionToken = null;
    this.lastAppliedTransitionAction = null;
    this._startStage({ resetProgress: true });
  }

  _startStage({ resetProgress = false } = {}) {
    this.stateVersion = STATE_VERSION;
    this.phaseKills = 0;
    this.stageStatus = 'active';
    this.transitionRemaining = 0;
    this.result = null;
    this.pendingTransitionToken = null;
    this.enemies.clear();
    this.projectiles.clear();
    this.effects.length = 0;
    this._bossAdds.clear();
    this.run = this._newRun();
    this.zoneStates = this._newZoneStates();
    this.collectibles = this._newCollectibles();
    this._resetPlayers({ resetProgress });
    for (const encounter of this.phase.encounters) this._spawnEnemy(encounter.type, encounter);
  }

  /** Compatibility shim for old administrative/tests code. */
  _startPhase() {
    this._startExpedition();
  }

  _resetPlayers({ resetProgress = false } = {}) {
    let slot = 0;
    for (const player of this.players.values()) {
      const spec = PLAYER_SPECS[player.role];
      if (resetProgress) {
        player.level = 1;
        player.xp = 0;
        player.xpToNext = xpNeededForLevel(1);
        player.power = 1;
        player.kills = 0;
        player.revives = 0;
        player.maxHp = spec.maxHp;
      }
      player.x = this.phase.spawn.x + (slot === 0 ? -46 : 46);
      player.y = this.phase.spawn.y + (slot === 0 ? 18 : -18);
      player.hp = player.maxHp;
      player.status = 'active';
      player.reviveProgress = 0;
      player.bleedOut = 14;
      player.attackCooldown = 0;
      player.dodgeCooldown = 0;
      player.invulnerable = 1.1;
      player.dodgeTime = 0;
      player.input = structuredClone(EMPTY_INPUT);
      player.actionTime = 0;
      this._setAction(player, 'idle');
      slot += 1;
    }
  }

  _recoverFromWipe() {
    this.stageStatus = 'active';
    this.transitionRemaining = 0;
    this.result = null;
    this.run.exitProgress = 0;
    this.projectiles.clear();
    this._resetPlayers({ resetProgress: false });
    for (const [enemyId, enemy] of this.enemies) {
      if (enemy.status === 'defeated') {
        this.enemies.delete(enemyId);
        continue;
      }
      enemy.x = enemy.homeX;
      enemy.y = enemy.homeY;
      enemy.hp = enemy.maxHp;
      enemy.awake = false;
      enemy.attackCooldown = 0.4;
      enemy.specialCooldown = enemy.boss ? 1.8 : 0;
      enemy.actionTime = 0;
      enemy.navigation = null;
      this._setAction(enemy, 'idle');
    }
  }

  _spawnEnemy(type, position = {}) {
    const spec = ENEMY_SPECS[type];
    if (!spec) throw new TypeError(`unknown enemy type: ${type}`);
    const boss = position.boss === true;
    const x = clamp(finite(position.x, this.phase.boss.x), ARENA.padding, ARENA.width - ARENA.padding);
    const y = clamp(finite(position.y, this.phase.boss.y), ARENA.padding, ARENA.height - ARENA.padding);
    const enemy = {
      id: `e${++this._enemySerial}`,
      type,
      zoneId: position.zoneId ?? (boss ? this.phase.boss.zoneId : this.phase.zones[2].id),
      x,
      y,
      homeX: x,
      homeY: y,
      radius: spec.radius,
      hp: spec.hp,
      maxHp: spec.hp,
      status: 'active',
      elite: boss || ['brute', 'siren'].includes(type),
      boss,
      name: boss ? position.name ?? this.phase.boss.name : null,
      epithet: boss ? position.epithet ?? this.phase.boss.epithet : null,
      bossPattern: boss ? 'radial' : null,
      attackCooldown: this.rng() * 0.5,
      specialCooldown: boss ? 1.8 : 0,
      aggroRadius: boss ? 760 : 560,
      leashRadius: boss ? 1080 : 820,
      awake: Boolean(position.awake),
      facing: { x: -1, y: 0 },
      action: 'idle',
      actionSeq: 0,
      actionTime: 0,
      xpValue: spec.xpValue,
      countsForZone: position.countsForZone !== false,
      deathRemaining: 0,
    };
    this.enemies.set(enemy.id, enemy);
    return enemy;
  }

  _updatePlayers(dt) {
    for (const player of this.players.values()) {
      if (player.status === 'downed') {
        this._setAction(player, 'down');
        player.bleedOut = Math.max(0, player.bleedOut - dt);
        if (player.bleedOut <= 0) {
          player.status = 'eliminated';
          player.reviveProgress = 0;
        }
        continue;
      }
      if (player.status !== 'active') {
        this._setAction(player, 'down');
        continue;
      }

      const spec = PLAYER_SPECS[player.role];
      const aimLength = Math.hypot(player.input.aim.x, player.input.aim.y);
      if (aimLength > 0.2) player.facing = normalized(player.input.aim.x, player.input.aim.y, player.facing);
      else if (Math.hypot(player.input.move.x, player.input.move.y) > 0.1) {
        player.facing = normalized(player.input.move.x, player.input.move.y, player.facing);
      }

      if (player.input.dodge && player.dodgeCooldown <= 0 && player.dodgeTime <= 0) {
        const desired = Math.hypot(player.input.move.x, player.input.move.y) > 0.1
          ? normalized(player.input.move.x, player.input.move.y)
          : player.facing;
        player.dodgeVector = desired;
        player.dodgeTime = 0.19;
        player.invulnerable = 0.28;
        player.dodgeCooldown = 1.55;
        this._setAction(player, 'move', 0.2, true);
        this._addEffect('dodge', player.x, player.y, 0.3, 42);
      }
      player.input.dodge = false;

      let moving = false;
      if (player.dodgeTime > 0) {
        player.dodgeTime = Math.max(0, player.dodgeTime - dt);
        player.x += player.dodgeVector.x * 610 * dt;
        player.y += player.dodgeVector.y * 610 * dt;
        moving = true;
      } else {
        player.x += player.input.move.x * spec.speed * dt;
        player.y += player.input.move.y * spec.speed * dt;
        moving = Math.hypot(player.input.move.x, player.input.move.y) > 0.08;
      }
      this._clampActor(player);

      if (player.input.attack && player.attackCooldown <= 0) this._playerAttack(player, spec);
      if (player.actionTime <= 0) this._setAction(player, moving ? 'move' : 'idle');
    }
  }

  _playerAttack(player, spec) {
    player.attackCooldown = spec.attackCooldown;
    this._setAction(player, 'attack', player.role === 'vanguard' ? 0.3 : 0.2, true);
    if (player.role === 'vanguard') {
      const reach = 106;
      this._addEffect('vanguard_slash', player.x + player.facing.x * 52, player.y + player.facing.y * 52, 0.22, reach);
      for (const enemy of [...this.enemies.values()]) {
        if (enemy.status !== 'active' || enemy.hp <= 0) continue;
        const dx = enemy.x - player.x;
        const dy = enemy.y - player.y;
        const d = Math.hypot(dx, dy);
        if (d > reach + enemy.radius) continue;
        const direction = normalized(dx, dy);
        if (direction.x * player.facing.x + direction.y * player.facing.y < -0.08) continue;
        this._damageEnemy(enemy, Math.round(34 * player.power), player.id);
      }
    } else {
      const direction = normalized(player.facing.x, player.facing.y, { x: 1, y: 0 });
      this._spawnProjectile({
        owner: player.id,
        team: 'hunters',
        kind: 'harpoon',
        x: player.x + direction.x * 31,
        y: player.y + direction.y * 31,
        vx: direction.x * 720,
        vy: direction.y * 720,
        radius: 7,
        damage: Math.round(27 * player.power),
        ttl: 1.45,
      });
    }
  }

  _updateInteractions(dt) {
    const reviveTouched = new Set();
    for (const rescuer of this.players.values()) {
      if (rescuer.status !== 'active' || !rescuer.input.interact) continue;
      const downed = [...this.players.values()].find((candidate) =>
        candidate.id !== rescuer.id
        && candidate.status === 'downed'
        && distance(rescuer, candidate) <= rescuer.radius + candidate.radius + 74,
      );
      if (downed) {
        reviveTouched.add(downed.id);
        downed.reviveProgress += dt;
        this._addEffect('revive_spark', downed.x, downed.y, 0.18, 30 + downed.reviveProgress * 8);
        if (downed.reviveProgress >= downed.reviveNeeded) {
          downed.status = 'active';
          downed.hp = Math.round(downed.maxHp * 0.46);
          downed.bleedOut = 14;
          downed.reviveProgress = 0;
          downed.invulnerable = 1.4;
          rescuer.revives = Math.max(0, Math.floor(finite(rescuer.revives))) + 1;
          this._setAction(downed, 'idle', 0, true);
          this._addEffect('revived', downed.x, downed.y, 0.8, 76);
        }
        continue;
      }

      const collectible = [...this.collectibles.values()].find((candidate) =>
        candidate.available
        && !candidate.collected
        && distance(rescuer, candidate) <= rescuer.radius + candidate.radius + 34,
      );
      if (collectible) this._collectSeal(collectible, rescuer);
    }

    for (const player of this.players.values()) {
      if (player.status === 'downed' && !reviveTouched.has(player.id)) {
        player.reviveProgress = Math.max(0, player.reviveProgress - dt * 0.35);
      }
    }

    if (!this.run.exitUnlocked) {
      this.run.exitProgress = 0;
      return;
    }
    const required = this.mode === 'solo'
      ? [...this.players.values()].filter((player) => !player.isAI)
      : [...this.players.values()].filter((player) => !player.isAI);
    const allHolding = required.length === (this.mode === 'solo' ? 1 : 2)
      && required.every((player) =>
        player.connected !== false
        && player.status === 'active'
        && player.input.interact
        && distance(player, this.phase.exit) <= this.phase.exit.radius + player.radius,
      );
    this.run.exitProgress = allHolding ? Math.min(this.phase.exit.holdSeconds, this.run.exitProgress + dt) : 0;
    if (this.run.exitProgress >= this.phase.exit.holdSeconds) this._completeExpedition();
  }

  _collectSeal(collectible, player) {
    if (collectible.collected || !collectible.available) return;
    collectible.collected = true;
    collectible.available = false;
    collectible.collectedBy = player.id;
    this.run.sealsCollected = Math.min(this.run.sealsRequired, this.run.sealsCollected + 1);
    this._addEffect('seal_collected', collectible.x, collectible.y, 1.1, 94);
    if (this.run.sealsCollected >= this.run.sealsRequired && !this.run.bossActivated) {
      this.run.bossActivated = true;
      const boss = this._spawnEnemy(this.phase.boss.type, {
        ...this.phase.boss,
        boss: true,
        awake: false,
        countsForZone: true,
      });
      const bossZone = this.zoneStates.get(this.phase.boss.zoneId);
      if (bossZone) bossZone.remaining = 1;
      this._addEffect('boss_awakened', boss.x, boss.y, 2, 180);
    }
  }

  _navigationSegmentClear(from, to, radius) {
    return !this.phase.obstacles.some((obstacle) =>
      segmentIntersectsObstacle(from, to, obstacle, radius),
    );
  }

  _firstNavigationBlocker(from, to, radius) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const obstacle of this.phase.obstacles) {
      if (!segmentIntersectsObstacle(from, to, obstacle, radius)) continue;
      const obstacleCenter = obstacle.shape === 'circle'
        ? obstacle
        : { x: obstacle.x + obstacle.width / 2, y: obstacle.y + obstacle.height / 2 };
      const d = distance(from, obstacleCenter);
      if (d < nearestDistance) {
        nearest = obstacle;
        nearestDistance = d;
      }
    }
    return nearest;
  }

  _navigationWaypoints(actor, obstacle) {
    const clearance = actor.radius + 24;
    if (obstacle.shape === 'rect') {
      const left = obstacle.x - clearance;
      const right = obstacle.x + obstacle.width + clearance;
      const top = obstacle.y - clearance;
      const bottom = obstacle.y + obstacle.height + clearance;
      return [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ];
    }

    const radius = obstacle.radius + clearance;
    return Array.from({ length: 8 }, (_, index) => {
      const angle = (Math.PI * 2 * index) / 8;
      return {
        x: obstacle.x + Math.cos(angle) * radius,
        y: obstacle.y + Math.sin(angle) * radius,
      };
    });
  }

  _autonomousDirection(actor, desired, destination, navigationKey) {
    const fallback = normalized(desired.x, desired.y, actor.facing);
    const goal = {
      x: finite(destination?.x, actor.x + fallback.x * 480),
      y: finite(destination?.y, actor.y + fallback.y * 480),
    };
    const key = String(navigationKey ?? 'move');

    if (actor.navigation?.key !== key) actor.navigation = null;
    if (this._navigationSegmentClear(actor, goal, actor.radius)) {
      actor.navigation = null;
      return fallback;
    }

    if (actor.navigation) {
      const waypoint = actor.navigation.waypoint;
      if (distance(actor, waypoint) > Math.max(12, actor.radius * 0.65)
        && this._navigationSegmentClear(actor, waypoint, actor.radius)) {
        return normalized(waypoint.x - actor.x, waypoint.y - actor.y, fallback);
      }
      actor.navigation = null;
    }

    const blocker = this._firstNavigationBlocker(actor, goal, actor.radius);
    if (blocker) {
      const tieDirection = stableParity(actor.id) === 0 ? 1 : -1;
      const waypoints = this._navigationWaypoints(actor, blocker);
      const candidates = waypoints
        .map((waypoint, index) => {
          const reachable = this._navigationSegmentClear(actor, waypoint, actor.radius);
          const onwardClear = this._navigationSegmentClear(waypoint, goal, actor.radius);
          const pathCost = distance(actor, waypoint) + distance(waypoint, goal) + (onwardClear ? 0 : 260);
          const tieRank = tieDirection > 0 ? index : waypoints.length - index;
          return { waypoint, reachable, pathCost: pathCost + tieRank * 0.001 };
        })
        .filter((candidate) => candidate.reachable)
        .sort((a, b) => a.pathCost - b.pathCost);
      if (candidates.length > 0) {
        actor.navigation = { key, obstacleId: blocker.id, waypoint: candidates[0].waypoint };
        return normalized(
          candidates[0].waypoint.x - actor.x,
          candidates[0].waypoint.y - actor.y,
          fallback,
        );
      }
    }

    // Last-resort local steering for a tightly packed corner. The actor id
    // fixes the preferred side, preventing left/right oscillation per tick.
    const preferredSign = stableParity(actor.id) === 0 ? 1 : -1;
    for (const degrees of [90, -90, 60, -60, 30, -30].map((value) => value * preferredSign)) {
      const radians = (degrees * Math.PI) / 180;
      const candidate = {
        x: fallback.x * Math.cos(radians) - fallback.y * Math.sin(radians),
        y: fallback.x * Math.sin(radians) + fallback.y * Math.cos(radians),
      };
      const probe = { x: actor.x + candidate.x * 64, y: actor.y + candidate.y * 64 };
      if (this._navigationSegmentClear(actor, probe, actor.radius)) return candidate;
    }
    return { x: 0, y: 0 };
  }

  _moveAutonomous(actor, desired, destination, navigationKey, distancePerSecond, dt) {
    const direction = this._autonomousDirection(actor, desired, destination, navigationKey);
    actor.x += direction.x * distancePerSecond * dt;
    actor.y += direction.y * distancePerSecond * dt;
    this._clampActor(actor);
    return direction;
  }

  _updateAIInput(player) {
    const empty = structuredClone(EMPTY_INPUT);
    if (player.status !== 'active') {
      player.navigation = null;
      player.input = empty;
      return;
    }
    const teammate = [...this.players.values()].find((other) => other.id !== player.id);
    if (teammate?.status === 'downed') {
      const d = distance(player, teammate);
      const direction = normalized(teammate.x - player.x, teammate.y - player.y, player.facing);
      const move = d > 70
        ? this._autonomousDirection(player, direction, teammate, `revive:${teammate.id}`)
        : { x: 0, y: 0 };
      player.input = {
        ...empty,
        move,
        aim: direction,
        interact: d <= player.radius + teammate.radius + 72,
        dodge: d > 180 && this._nearestEnemyDistance(player, 220) < 95 && player.dodgeCooldown <= 0,
      };
      return;
    }

    const nearbyTarget = this._nearestEnemy(player, 620)
      ?? (teammate ? this._nearestEnemy(teammate, 540) : null);
    if (!nearbyTarget) {
      if (!teammate || teammate.status !== 'active') {
        player.navigation = null;
        player.input = empty;
        return;
      }
      const d = distance(player, teammate);
      const toward = normalized(teammate.x - player.x, teammate.y - player.y, player.facing);
      const move = d > 185
        ? this._autonomousDirection(player, toward, teammate, `follow:${teammate.id}`)
        : { x: 0, y: 0 };
      if (d <= 185) player.navigation = null;
      player.input = {
        ...empty,
        move,
        aim: d > 20 ? toward : player.facing,
      };
      return;
    }

    const d = distance(player, nearbyTarget);
    const toward = normalized(nearbyTarget.x - player.x, nearbyTarget.y - player.y, player.facing);
    let move = { x: 0, y: 0 };
    if (player.role === 'ranger') {
      if (d > 350) move = toward;
      else if (d < 205) move = { x: -toward.x, y: -toward.y };
      else move = { x: -toward.y * 0.45, y: toward.x * 0.45 };
    } else if (d > 78) move = toward;
    if (Math.hypot(move.x, move.y) > 0.01) {
      const advancing = move.x * toward.x + move.y * toward.y > 0.45;
      const destination = advancing
        ? nearbyTarget
        : { x: player.x + move.x * 480, y: player.y + move.y * 480 };
      move = this._autonomousDirection(
        player,
        move,
        destination,
        `${advancing ? 'hunt' : 'space'}:${nearbyTarget.id}`,
      );
    } else {
      player.navigation = null;
    }
    player.input = {
      move,
      aim: toward,
      attack: d <= (player.role === 'ranger' ? 650 : 125),
      interact: false,
      dodge: d < 86 && player.dodgeCooldown <= 0,
    };
  }

  _updateEnemies(dt) {
    for (const enemy of [...this.enemies.values()]) {
      if (enemy.status === 'defeated') continue;
      const spec = ENEMY_SPECS[enemy.type];
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - dt);
      enemy.specialCooldown = Math.max(0, enemy.specialCooldown - dt);
      const nearest = this._nearestActivePlayer(enemy);

      if (!enemy.awake) {
        if (nearest && distance(enemy, nearest) <= enemy.aggroRadius) enemy.awake = true;
        else {
          if (enemy.actionTime <= 0) this._setAction(enemy, 'idle');
          continue;
        }
      }

      const targetTooFar = !nearest || distance({ x: enemy.homeX, y: enemy.homeY }, nearest) > enemy.leashRadius;
      const enemyTooFar = distance(enemy, { x: enemy.homeX, y: enemy.homeY }) > enemy.leashRadius;
      if (targetTooFar || enemyTooFar) {
        const homeDistance = distance(enemy, { x: enemy.homeX, y: enemy.homeY });
        if (homeDistance > 8) {
          const homeward = normalized(enemy.homeX - enemy.x, enemy.homeY - enemy.y, enemy.facing);
          enemy.facing = this._moveAutonomous(
            enemy,
            homeward,
            { x: enemy.homeX, y: enemy.homeY },
            'return-home',
            spec.speed * 1.15,
            dt,
          );
          if (enemy.actionTime <= 0) this._setAction(enemy, 'move');
        } else {
          enemy.x = enemy.homeX;
          enemy.y = enemy.homeY;
          enemy.hp = enemy.maxHp;
          enemy.awake = false;
          enemy.navigation = null;
          if (enemy.actionTime <= 0) this._setAction(enemy, 'idle');
        }
        continue;
      }

      const d = distance(enemy, nearest);
      const toward = normalized(nearest.x - enemy.x, nearest.y - enemy.y, enemy.facing);
      enemy.facing = toward;
      let moving = false;
      if (enemy.type === 'spitter' || enemy.type === 'siren') {
        if (d > spec.attackRange * 0.82) {
          this._moveAutonomous(enemy, toward, nearest, `hunt:${nearest.id}`, spec.speed, dt);
          moving = true;
        } else if (d < 180) {
          const retreat = { x: -toward.x, y: -toward.y };
          this._moveAutonomous(
            enemy,
            retreat,
            { x: enemy.x + retreat.x * 420, y: enemy.y + retreat.y * 420 },
            `retreat:${nearest.id}`,
            spec.speed * 0.75,
            dt,
          );
          moving = true;
        } else {
          enemy.navigation = null;
        }
        if (d <= spec.attackRange && enemy.attackCooldown <= 0) {
          enemy.attackCooldown = spec.attackCooldown;
          this._setAction(enemy, 'attack', 0.35, true);
          this._spawnProjectile({
            owner: enemy.id,
            team: 'mist',
            kind: enemy.type === 'siren' ? 'siren_orb' : 'mist_spit',
            x: enemy.x + toward.x * enemy.radius,
            y: enemy.y + toward.y * enemy.radius,
            vx: toward.x * (enemy.type === 'siren' ? 315 : 265),
            vy: toward.y * (enemy.type === 'siren' ? 315 : 265),
            radius: enemy.type === 'siren' ? 11 : 8,
            damage: spec.damage,
            ttl: 2.4,
          });
        }
      } else if (d > spec.attackRange) {
        const speedScale = enemy.boss && enemy.hp < enemy.maxHp * 0.5 ? 1.22 : 1;
        this._moveAutonomous(enemy, toward, nearest, `hunt:${nearest.id}`, spec.speed * speedScale, dt);
        moving = true;
      } else if (enemy.attackCooldown <= 0) {
        enemy.navigation = null;
        enemy.attackCooldown = spec.attackCooldown;
        this._setAction(enemy, 'attack', enemy.boss ? 0.5 : 0.3, true);
        this._damagePlayer(nearest, spec.damage);
        this._addEffect(enemy.boss ? 'boss_slam' : 'enemy_strike', nearest.x, nearest.y, 0.3, enemy.boss ? 105 : 46);
      }

      if (enemy.boss) this._updateBossSpecial(enemy);
      if (enemy.actionTime <= 0) this._setAction(enemy, moving ? 'move' : 'idle');
      this._clampActor(enemy);
    }
  }

  _updateBossSpecial(boss) {
    const ratio = boss.hp / boss.maxHp;
    for (const threshold of [0.72, 0.36]) {
      if (ratio <= threshold && !this._bossAdds.has(threshold)) {
        this._bossAdds.add(threshold);
        this._spawnEnemy('crawler', {
          x: boss.x - 90, y: boss.y + 60, zoneId: boss.zoneId, awake: true, countsForZone: false,
        });
        this._spawnEnemy('crawler', {
          x: boss.x + 90, y: boss.y + 60, zoneId: boss.zoneId, awake: true, countsForZone: false,
        });
        this._addEffect('fog_summon', boss.x, boss.y, 1.1, 145);
      }
    }
    if (boss.specialCooldown > 0) return;
    boss.specialCooldown = ratio < 0.5 ? 1.55 : 2.15;
    this._setAction(boss, 'attack', 0.62, true);
    const shots = ratio < 0.5 ? 12 : 8;
    const offset = this.tick * 0.07;
    for (let i = 0; i < shots; i += 1) {
      const angle = offset + (Math.PI * 2 * i) / shots;
      this._spawnProjectile({
        owner: boss.id,
        team: 'mist',
        kind: 'fog_wave',
        x: boss.x + Math.cos(angle) * boss.radius,
        y: boss.y + Math.sin(angle) * boss.radius,
        vx: Math.cos(angle) * 245,
        vy: Math.sin(angle) * 245,
        radius: 12,
        damage: 12,
        ttl: 3.2,
      });
    }
    this._addEffect('boss_pulse', boss.x, boss.y, 0.7, 132);
  }

  _spawnProjectile(projectile) {
    const id = `q${++this._projectileSerial}`;
    this.projectiles.set(id, { id, ...projectile });
  }

  _updateProjectiles(dt) {
    for (const projectile of [...this.projectiles.values()]) {
      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;
      projectile.ttl -= dt;
      if (
        projectile.ttl <= 0
        || projectile.x < -80
        || projectile.y < -80
        || projectile.x > ARENA.width + 80
        || projectile.y > ARENA.height + 80
      ) {
        this.projectiles.delete(projectile.id);
        continue;
      }
      if (this.phase.obstacles.some((obstacle) => circleIntersectsObstacle(projectile, obstacle))) {
        this._addEffect('projectile_blocked', projectile.x, projectile.y, 0.18, 24);
        this.projectiles.delete(projectile.id);
        continue;
      }
      if (projectile.team === 'hunters') {
        const hit = [...this.enemies.values()].find((enemy) =>
          enemy.status === 'active'
          && enemy.hp > 0
          && distance(projectile, enemy) <= projectile.radius + enemy.radius,
        );
        if (hit) {
          this._damageEnemy(hit, projectile.damage, projectile.owner);
          this._addEffect('harpoon_hit', projectile.x, projectile.y, 0.24, 38);
          this.projectiles.delete(projectile.id);
        }
      } else {
        const hit = [...this.players.values()].find((player) =>
          player.status === 'active'
          && player.invulnerable <= 0
          && distance(projectile, player) <= projectile.radius + player.radius,
        );
        if (hit) {
          this._damagePlayer(hit, projectile.damage);
          this._addEffect('mist_hit', projectile.x, projectile.y, 0.26, 42);
          this.projectiles.delete(projectile.id);
        }
      }
    }
  }

  _damageEnemy(enemy, amount, ownerId = undefined) {
    if (!this.enemies.has(enemy.id) || enemy.status !== 'active' || enemy.hp <= 0) return false;
    enemy.awake = true;
    enemy.hp = Math.max(0, enemy.hp - Math.max(0, finite(amount)));
    if (enemy.hp > 0) {
      this._setAction(enemy, 'hurt', 0.16, true);
      return false;
    }
    enemy.status = 'defeated';
    enemy.hp = 0;
    enemy.awake = false;
    enemy.deathRemaining = ENEMY_TOMBSTONE_SECONDS;
    enemy.navigation = null;
    this._setAction(enemy, 'down', ENEMY_TOMBSTONE_SECONDS, true);
    for (const projectile of [...this.projectiles.values()]) {
      if (projectile.owner === enemy.id) this.projectiles.delete(projectile.id);
    }
    this.phaseKills += 1;
    const owner = this.players.get(ownerId);
    if (owner) owner.kills += 1;
    this._awardPartyXp(enemy.xpValue);
    this._addEffect(enemy.boss ? 'boss_defeated' : 'enemy_defeated', enemy.x, enemy.y, enemy.boss ? 1.6 : 0.5, enemy.radius * 1.8);

    if (enemy.boss) {
      this.run.bossDefeated = true;
      this.run.exitUnlocked = true;
      this.run.exitProgress = 0;
      const bossZone = this.zoneStates.get(this.phase.boss.zoneId);
      if (bossZone) {
        bossZone.cleared = true;
        bossZone.remaining = 0;
      }
      return true;
    }
    if (enemy.countsForZone) this._syncZoneAfterKill(enemy.zoneId);
    return true;
  }

  _awardPartyXp(amount) {
    const gained = Math.max(0, Math.round(finite(amount)));
    if (gained <= 0) return;
    for (const player of this.players.values()) {
      player.xp += gained;
      while (player.xp >= player.xpToNext) {
        player.xp -= player.xpToNext;
        player.level += 1;
        player.xpToNext = xpNeededForLevel(player.level);
        player.power = Math.round((1 + (player.level - 1) * 0.1) * 100) / 100;
        const oldMax = player.maxHp;
        player.maxHp = Math.round(PLAYER_SPECS[player.role].maxHp * (1 + (player.level - 1) * 0.08));
        if (player.status === 'active') {
          player.hp = Math.min(player.maxHp, player.hp + (player.maxHp - oldMax) + Math.round(player.maxHp * 0.2));
        }
        this._addEffect('level_up', player.x, player.y, 1.2, 88);
      }
    }
  }

  _syncZoneAfterKill(zoneId) {
    const state = this.zoneStates.get(zoneId);
    if (!state || state.cleared) return;
    state.remaining = [...this.enemies.values()].filter((enemy) =>
      enemy.zoneId === zoneId && enemy.countsForZone && enemy.status === 'active' && enemy.hp > 0,
    ).length;
    if (state.remaining > 0) return;
    state.cleared = true;
    const seal = this.collectibles.get(`seal-${zoneId}`);
    if (seal && !seal.collected) seal.available = true;
    const zone = this.phase.zones.find((entry) => entry.id === zoneId);
    this._addEffect('zone_cleared', zone?.center.x ?? seal?.x ?? 0, zone?.center.y ?? seal?.y ?? 0, 1.5, 150);
  }

  _damagePlayer(player, amount) {
    if (player.status !== 'active' || player.invulnerable > 0) return false;
    player.hp = Math.max(0, player.hp - Math.max(0, finite(amount)));
    player.invulnerable = 0.22;
    if (player.hp > 0) {
      this._setAction(player, 'hurt', 0.2, true);
      return false;
    }
    player.status = 'downed';
    player.reviveProgress = 0;
    player.bleedOut = 14;
    player.input.attack = false;
    this._setAction(player, 'down', 0, true);
    this._addEffect('player_downed', player.x, player.y, 0.9, 82);
    return true;
  }

  _beginWipe() {
    if (['resetting', 'stage_complete', 'victory'].includes(this.stageStatus)) return;
    this.stageStatus = 'resetting';
    this.transitionRemaining = 2.4;
    this.projectiles.clear();
    this.run.exitProgress = 0;
    this.result = {
      status: 'wipe',
      title: '猎团失守',
      message: '即将从猎团营地重新集结，探索进度会保留。',
      restartIn: this.transitionRemaining,
      ...this._resultStats(),
    };
  }

  _completeExpedition() {
    if (['stage_complete', 'victory'].includes(this.stageStatus)) return;
    const finalStage = this.phaseIndex === PHASES.length - 1;
    this.stageStatus = finalStage ? 'victory' : 'stage_complete';
    this.pendingTransitionToken = randomUUID();
    this.run.exitProgress = this.phase.exit.holdSeconds;
    this.projectiles.clear();
    this.result = {
      status: this.stageStatus,
      title: finalStage ? '雾港重见灯火' : this.phase.completionTitle,
      message: this.phase.completionMessage,
      transitionToken: this.pendingTransitionToken,
      ...this._resultStats(),
    };
    this._addEffect(finalStage ? 'victory' : 'stage_complete', this.phase.exit.x, this.phase.exit.y, 2.8, 240);
  }

  _updateDiscovery() {
    for (const zone of this.phase.zones) {
      if (this.zoneStates.get(zone.id)?.discovered) continue;
      if ([...this.players.values()].some((player) => player.status === 'active' && zoneContains(zone, player, 80))) {
        this.zoneStates.get(zone.id).discovered = true;
      }
    }
  }

  _resultStats() {
    let kills = 0;
    let revives = 0;
    for (const player of this.players.values()) {
      kills += Math.max(0, Math.floor(finite(player.kills)));
      revives += Math.max(0, Math.floor(finite(player.revives)));
    }
    return {
      elapsed: publicNumber(this.run.elapsed),
      kills,
      revives,
    };
  }

  _objectiveSnapshot(boss) {
    if (this.stageStatus === 'waiting') {
      return {
        kind: 'waiting',
        step: 'assemble',
        label: '等待另一名猎人加入',
        current: this.players.size,
        target: 2,
      };
    }
    if (this.stageStatus === 'stage_complete') {
      const next = PHASES[this.phaseIndex + 1];
      return {
        kind: 'transition',
        step: 'stage_complete',
        label: `${this.phase.title}已完成，前往${next.title}`,
        current: 1,
        target: 1,
      };
    }
    if (this.stageStatus === 'victory') {
      return {
        kind: 'victory',
        step: 'complete',
        label: '三关贯通，雾港重见灯火',
        current: 1,
        target: 1,
      };
    }
    if (this.run.sealsCollected < this.run.sealsRequired) {
      return {
        kind: 'seals',
        step: 'collect_seals',
        label: this.phase.objectiveLabel,
        current: this.run.sealsCollected,
        target: this.run.sealsRequired,
      };
    }
    if (!this.run.bossDefeated) {
      const target = ENEMY_SPECS[this.phase.boss.type].hp;
      return {
        kind: 'boss',
        step: 'defeat_boss',
        label: this.phase.bossLabel,
        current: boss ? target - Math.max(0, boss.hp) : 0,
        target,
      };
    }
    return {
      kind: 'exit',
      step: 'reach_exit',
      label: this.mode === 'solo' ? '前往灯塔出口并按住互动' : '两名猎人一同在灯塔出口按住互动',
      current: publicNumber(this.run.exitProgress),
      target: this.phase.exit.holdSeconds,
    };
  }

  _nearestActivePlayer(origin) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const player of this.players.values()) {
      if (player.status !== 'active') continue;
      const d = distance(origin, player);
      if (d < nearestDistance) {
        nearest = player;
        nearestDistance = d;
      }
    }
    return nearest;
  }

  _nearestEnemy(origin, maximumDistance = Infinity) {
    let nearest = null;
    let nearestDistance = maximumDistance;
    for (const enemy of this.enemies.values()) {
      if (enemy.status !== 'active' || enemy.hp <= 0) continue;
      const d = distance(origin, enemy);
      if (d < nearestDistance) {
        nearest = enemy;
        nearestDistance = d;
      }
    }
    return nearest;
  }

  _nearestEnemyDistance(origin, maximumDistance = Infinity) {
    const enemy = this._nearestEnemy(origin, maximumDistance);
    return enemy ? distance(origin, enemy) : Infinity;
  }

  _separateActors() {
    const actors = [
      ...[...this.players.values()].filter((player) => player.status === 'active'),
      ...[...this.enemies.values()].filter((enemy) => enemy.status === 'active' && enemy.hp > 0),
    ];
    for (let i = 0; i < actors.length; i += 1) {
      for (let j = i + 1; j < actors.length; j += 1) {
        const a = actors[i];
        const b = actors[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const minimum = (a.radius + b.radius) * 0.82;
        if (d >= minimum || d < 0.001) continue;
        const push = (minimum - d) * 0.5;
        const nx = dx / d;
        const ny = dy / d;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
        this._clampActor(a);
        this._clampActor(b);
      }
    }
  }

  _clampActor(actor) {
    actor.x = clamp(actor.x, ARENA.padding + actor.radius, ARENA.width - ARENA.padding - actor.radius);
    actor.y = clamp(actor.y, ARENA.padding + actor.radius, ARENA.height - ARENA.padding - actor.radius);
    // A handful of passes resolve corners or the rare overlap between an
    // actor separation push and a landmark. The obstacle count is deliberately
    // small, keeping this deterministic pass inexpensive at 30 Hz.
    for (let pass = 0; pass < 4; pass += 1) {
      let collided = false;
      for (const obstacle of this.phase.obstacles) {
        if (pushCircleOutOfObstacle(actor, obstacle)) collided = true;
      }
      actor.x = clamp(actor.x, ARENA.padding + actor.radius, ARENA.width - ARENA.padding - actor.radius);
      actor.y = clamp(actor.y, ARENA.padding + actor.radius, ARENA.height - ARENA.padding - actor.radius);
      if (!collided) break;
    }
  }

  _setAction(actor, action, duration = 0, forceSequence = false) {
    if (actor.action !== action || forceSequence) actor.actionSeq = Math.max(0, finite(actor.actionSeq)) + 1;
    actor.action = action;
    actor.actionTime = Math.max(finite(actor.actionTime), duration);
  }

  _addEffect(kind, x, y, ttl, radius) {
    this.effects.push({ id: `fx${++this._effectSerial}`, kind, x, y, ttl, radius });
    if (this.effects.length > 80) this.effects.splice(0, this.effects.length - 80);
  }

  _updateEffects(dt) {
    for (const effect of this.effects) effect.ttl -= dt;
    this.effects = this.effects.filter((effect) => effect.ttl > 0);
  }

  _updateEnemyTombstones(dt) {
    for (const [enemyId, enemy] of this.enemies) {
      if (enemy.status !== 'defeated') continue;
      enemy.hp = 0;
      enemy.awake = false;
      enemy.action = 'down';
      enemy.deathRemaining = Math.max(0, finite(enemy.deathRemaining) - dt);
      if (enemy.deathRemaining <= 0) this.enemies.delete(enemyId);
    }
  }

  _publicPlayer(player) {
    return {
      id: player.id,
      name: player.name,
      role: player.role,
      isAI: player.isAI,
      connected: player.connected,
      x: publicNumber(player.x),
      y: publicNumber(player.y),
      radius: player.radius,
      facing: { x: publicNumber(player.facing.x), y: publicNumber(player.facing.y) },
      hp: publicNumber(player.hp),
      maxHp: player.maxHp,
      status: player.status,
      reviveProgress: publicNumber(player.reviveProgress),
      reviveNeeded: player.reviveNeeded,
      bleedOut: publicNumber(player.bleedOut),
      dodgeCooldown: publicNumber(player.dodgeCooldown),
      attackCooldown: publicNumber(player.attackCooldown),
      level: player.level,
      xp: player.xp,
      xpToNext: player.xpToNext,
      power: player.power,
      kills: player.kills,
      revives: player.revives,
      action: player.action,
      actionSeq: player.actionSeq,
    };
  }

  _publicEnemy(enemy) {
    return {
      id: enemy.id,
      type: enemy.type,
      zoneId: enemy.zoneId,
      x: publicNumber(enemy.x),
      y: publicNumber(enemy.y),
      homeX: publicNumber(enemy.homeX),
      homeY: publicNumber(enemy.homeY),
      radius: enemy.radius,
      hp: publicNumber(enemy.hp),
      maxHp: enemy.maxHp,
      status: enemy.status,
      elite: enemy.elite,
      boss: enemy.boss,
      name: enemy.name,
      epithet: enemy.epithet,
      awake: enemy.awake,
      facing: { x: publicNumber(enemy.facing.x), y: publicNumber(enemy.facing.y) },
      action: enemy.action,
      actionSeq: enemy.actionSeq,
      deathRemaining: publicNumber(enemy.deathRemaining),
      xpValue: enemy.xpValue,
    };
  }
}

export function createSoloGame(options = {}) {
  const game = new GameState({ ...options, mode: 'solo' });
  game.addPlayer({ id: options.playerId ?? 'player-1', name: options.playerName, role: 'vanguard' });
  game.addPlayer({ id: options.aiId ?? 'ai-ranger', name: '雾灯 · 莉薇', role: 'ranger', isAI: true });
  return game;
}

export { GAME_STAGES };
export const GAME_PHASES = PHASES;
export const GAME_ZONES = GAME_STAGES[0].zones;
export const GAME_OBSTACLES = GAME_STAGES[0].obstacles;
export const GAME_SPECS = Object.freeze({ players: PLAYER_SPECS, enemies: ENEMY_SPECS });
