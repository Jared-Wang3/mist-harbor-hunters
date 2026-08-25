const PLAYER_SPEED = Object.freeze({
  vanguard: 245,
  ranger: 275,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function snapshotOrder(state) {
  return {
    tick: Number.isFinite(Number(state?.tick)) ? Number(state.tick) : -1,
    serverTime: Number.isFinite(Number(state?.serverTime)) ? Number(state.serverTime) : -1,
  };
}

export function isSnapshotNewer(current, incoming) {
  if (!incoming || typeof incoming !== 'object') return false;
  if (!current || typeof current !== 'object') return true;
  const previous = snapshotOrder(current);
  const next = snapshotOrder(incoming);
  if (next.tick !== previous.tick) return next.tick > previous.tick;
  return next.serverTime > previous.serverTime;
}

export function appendSnapshot(buffer, state, receivedAt, limit = 8) {
  if (!Array.isArray(buffer)) throw new TypeError('snapshot buffer must be an array');
  const latest = buffer.at(-1)?.state;
  if (!isSnapshotNewer(latest, state)) return false;
  if (latest && snapshotBoundaryChanged(latest, state)) buffer.length = 0;
  buffer.push({ state, receivedAt: finite(receivedAt) });
  while (buffer.length > Math.max(2, finite(limit, 8))) buffer.shift();
  return true;
}

function snapshotBoundaryChanged(previous, next) {
  const previousStatus = previous?.stage?.status;
  const nextStatus = next?.stage?.status;
  if (previousStatus !== nextStatus) return true;

  const previousById = new Map((previous?.players ?? []).map((player) => [player.id, player]));
  return (next?.players ?? []).some((player) => {
    const before = previousById.get(player.id);
    if (!before) return false;
    const distance = Math.hypot(finite(player.x) - finite(before.x), finite(player.y) - finite(before.y));
    return distance > 260 || before.status !== player.status;
  });
}

function lerp(from, to, amount) {
  return finite(from) + (finite(to) - finite(from)) * amount;
}

function interpolateFacing(from, to, amount) {
  if (!from && !to) return undefined;
  const x = lerp(from?.x, to?.x, amount);
  const y = lerp(from?.y, to?.y, amount);
  const length = Math.hypot(x, y);
  if (length < 0.001) return { x: 1, y: 0 };
  return { x: x / length, y: y / length };
}

function interpolateEntities(previous = [], next = [], amount) {
  const previousById = new Map(previous.map((entity) => [entity.id, entity]));
  return next.map((entity) => {
    const before = previousById.get(entity.id);
    if (!before) return entity;
    const blended = {
      ...entity,
      x: lerp(before.x, entity.x, amount),
      y: lerp(before.y, entity.y, amount),
    };
    if (before.facing || entity.facing) blended.facing = interpolateFacing(before.facing, entity.facing, amount);
    return blended;
  });
}

function blendSnapshots(previous, next, amount) {
  return {
    ...next,
    players: interpolateEntities(previous.players, next.players, amount),
    enemies: interpolateEntities(previous.enemies, next.enemies, amount),
    projectiles: interpolateEntities(previous.projectiles, next.projectiles, amount),
  };
}

export function interpolateSnapshot(buffer, renderNow, delayMs = 100, maxExtrapolationMs = 80) {
  if (!Array.isArray(buffer) || buffer.length === 0) return null;
  if (buffer.length === 1) return buffer[0].state;

  const latestEntry = buffer.at(-1);
  const latestTime = finite(latestEntry.state.serverTime);
  const targetTime = latestTime
    + Math.max(0, finite(renderNow) - finite(latestEntry.receivedAt))
    - Math.max(0, finite(delayMs, 100));
  const firstTime = finite(buffer[0].state.serverTime);
  if (targetTime <= firstTime) return buffer[0].state;

  for (let index = 1; index < buffer.length; index += 1) {
    const previous = buffer[index - 1].state;
    const next = buffer[index].state;
    const previousTime = finite(previous.serverTime);
    const nextTime = finite(next.serverTime, previousTime);
    if (targetTime <= nextTime) {
      const span = Math.max(1, nextTime - previousTime);
      return blendSnapshots(previous, next, clamp((targetTime - previousTime) / span, 0, 1));
    }
  }

  const previous = buffer.at(-2).state;
  const latest = latestEntry.state;
  const span = Math.max(1, latestTime - finite(previous.serverTime, latestTime - 1));
  const extrapolation = clamp(targetTime - latestTime, 0, Math.max(0, finite(maxExtrapolationMs, 80)));
  return blendSnapshots(previous, latest, 1 + extrapolation / span);
}

function roleSpeed(role) {
  return /ranger|gunner|gun|rune|range/i.test(String(role || ''))
    ? PLAYER_SPEED.ranger
    : PLAYER_SPEED.vanguard;
}

function pushCircleOutOfObstacle(circle, obstacle) {
  const radius = Math.max(0, finite(circle?.radius));
  const obstacleX = finite(obstacle?.x);
  const obstacleY = finite(obstacle?.y);
  const epsilon = 0.01;

  if (obstacle?.shape === 'circle') {
    const obstacleRadius = Math.max(0, finite(obstacle.radius));
    const dx = finite(circle.x) - obstacleX;
    const dy = finite(circle.y) - obstacleY;
    const minimum = radius + obstacleRadius;
    const squaredDistance = dx * dx + dy * dy;
    if (squaredDistance >= minimum * minimum) return false;
    if (squaredDistance < 0.000001) {
      circle.x = obstacleX + minimum + epsilon;
      return true;
    }
    const actualDistance = Math.sqrt(squaredDistance);
    const push = minimum - actualDistance + epsilon;
    circle.x += (dx / actualDistance) * push;
    circle.y += (dy / actualDistance) * push;
    return true;
  }

  const left = obstacleX;
  const right = obstacleX + Math.max(0, finite(obstacle?.width));
  const top = obstacleY;
  const bottom = obstacleY + Math.max(0, finite(obstacle?.height));
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

  const exits = [
    { distance: Math.abs(circle.x - left), axis: 'x', value: left - radius - epsilon },
    { distance: Math.abs(right - circle.x), axis: 'x', value: right + radius + epsilon },
    { distance: Math.abs(circle.y - top), axis: 'y', value: top - radius - epsilon },
    { distance: Math.abs(bottom - circle.y), axis: 'y', value: bottom + radius + epsilon },
  ].sort((a, b) => a.distance - b.distance);
  circle[exits[0].axis] = exits[0].value;
  return true;
}

/** Mirrors the authoritative server's bounds and landmark collision pass. */
export function resolveObstacleCollisions(position, options = {}) {
  const radius = Math.max(0, finite(options.radius, 24));
  const padding = Math.max(0, finite(options.arena?.padding));
  const arenaWidth = Math.max((padding + radius) * 2, finite(options.arena?.width, 1600));
  const arenaHeight = Math.max((padding + radius) * 2, finite(options.arena?.height, 900));
  const resolved = {
    x: clamp(finite(position?.x), padding + radius, arenaWidth - padding - radius),
    y: clamp(finite(position?.y), padding + radius, arenaHeight - padding - radius),
    radius,
  };
  const obstacles = Array.isArray(options.obstacles) ? options.obstacles : [];

  for (let pass = 0; pass < 4; pass += 1) {
    let collided = false;
    for (const obstacle of obstacles) {
      if (!obstacle || typeof obstacle !== 'object') continue;
      if (pushCircleOutOfObstacle(resolved, obstacle)) collided = true;
    }
    resolved.x = clamp(resolved.x, padding + radius, arenaWidth - padding - radius);
    resolved.y = clamp(resolved.y, padding + radius, arenaHeight - padding - radius);
    if (!collided) break;
  }

  return { x: resolved.x, y: resolved.y };
}

export function predictLocalPosition(position, options = {}) {
  const radius = Math.max(0, finite(options.radius, 24));
  const moveX = finite(options.move?.x);
  const moveY = finite(options.move?.y);
  const magnitude = Math.hypot(moveX, moveY);
  const scale = magnitude > 1 ? 1 / magnitude : 1;
  const dt = clamp(finite(options.dt), 0, 0.05);
  const speed = roleSpeed(options.role);
  return resolveObstacleCollisions({
    x: finite(position?.x) + moveX * scale * speed * dt,
    y: finite(position?.y) + moveY * scale * speed * dt,
  }, options);
}

export function reconcileLocalPosition(predicted, authoritative, move = {}, hardSnapDistance = 160) {
  if (!authoritative) return predicted ?? null;
  if (!predicted) return { x: finite(authoritative.x), y: finite(authoritative.y) };
  const errorX = finite(authoritative.x) - finite(predicted.x);
  const errorY = finite(authoritative.y) - finite(predicted.y);
  const errorDistance = Math.hypot(errorX, errorY);
  const moveX = finite(move.x);
  const moveY = finite(move.y);
  const moveLength = Math.hypot(moveX, moveY);
  const hardDistance = Math.max(1, finite(hardSnapDistance, 160));
  if (errorDistance >= hardDistance) {
    return { x: finite(authoritative.x), y: finite(authoritative.y) };
  }

  if (moveLength < 0.05) {
    return {
      x: finite(predicted.x) + errorX * 0.3,
      y: finite(predicted.y) + errorY * 0.3,
    };
  }

  const directionX = moveX / moveLength;
  const directionY = moveY / moveLength;
  const forwardError = errorX * directionX + errorY * directionY;
  const lateralX = errorX - forwardError * directionX;
  const lateralY = errorY - forwardError * directionY;
  // Authority may legitimately be behind after a dropped input or a server
  // collision. Correct both directions, but slowly enough to avoid a snap.
  const catchUp = clamp(forwardError, -hardDistance * 0.35, hardDistance);
  return {
    x: finite(predicted.x) + (lateralX + directionX * catchUp) * 0.22,
    y: finite(predicted.y) + (lateralY + directionY * catchUp) * 0.22,
  };
}

export function selectCanvasDpr(devicePixelRatio, coarsePointer = false) {
  const ratio = Math.max(1, finite(devicePixelRatio, 1));
  return Math.min(ratio, coarsePointer ? 1.5 : 1.75);
}

function normalizedWorld(world = {}) {
  return {
    width: Math.max(1, finite(world.width, 1280)),
    height: Math.max(1, finite(world.height, 720)),
    padding: Math.max(0, finite(world.padding, 0)),
  };
}

/**
 * Builds the visible world rectangle for a centre-based camera. `scale` is the
 * number of CSS pixels used for one world unit. The returned camera is clamped
 * so that a wide or tall screen never exposes space outside the map.
 */
export function computeCameraViewport(camera = {}, viewport = {}, world = {}) {
  const bounds = normalizedWorld(world);
  const screenWidth = Math.max(1, finite(viewport.width, 1280));
  const screenHeight = Math.max(1, finite(viewport.height, 720));
  const scale = clamp(finite(camera.scale, 1), 0.25, 4);
  const viewWidth = Math.min(bounds.width, screenWidth / scale);
  const viewHeight = Math.min(bounds.height, screenHeight / scale);
  const halfWidth = viewWidth / 2;
  const halfHeight = viewHeight / 2;
  const minimumX = Math.min(bounds.width / 2, bounds.padding + halfWidth);
  const maximumX = Math.max(bounds.width / 2, bounds.width - bounds.padding - halfWidth);
  const minimumY = Math.min(bounds.height / 2, bounds.padding + halfHeight);
  const maximumY = Math.max(bounds.height / 2, bounds.height - bounds.padding - halfHeight);
  const x = clamp(finite(camera.x, bounds.width / 2), minimumX, maximumX);
  const y = clamp(finite(camera.y, bounds.height / 2), minimumY, maximumY);

  return {
    x,
    y,
    scale,
    left: x - viewWidth / 2,
    top: y - viewHeight / 2,
    right: x + viewWidth / 2,
    bottom: y + viewHeight / 2,
    width: viewWidth,
    height: viewHeight,
    screenWidth,
    screenHeight,
  };
}

/** Smooth, frame-rate-independent follow camera. */
export function updateFollowCamera(camera, target, dt, options = {}) {
  const world = normalizedWorld(options.world);
  const viewport = options.viewport || {};
  const desiredScale = clamp(finite(options.scale, camera?.scale ?? 1), 0.25, 4);
  const startX = finite(camera?.x, target?.x ?? world.width / 2);
  const startY = finite(camera?.y, target?.y ?? world.height / 2);
  const stiffness = Math.max(0.01, finite(options.stiffness, 9));
  const amount = options.immediate ? 1 : 1 - Math.exp(-stiffness * clamp(finite(dt), 0, 0.1));
  const next = {
    x: lerp(startX, finite(target?.x, startX), amount),
    y: lerp(startY, finite(target?.y, startY), amount),
    scale: lerp(finite(camera?.scale, desiredScale), desiredScale, amount),
  };
  return computeCameraViewport(next, viewport, world);
}

export function worldToScreen(point, camera) {
  const scale = Math.max(0.0001, finite(camera?.scale, 1));
  return {
    x: (finite(point?.x) - finite(camera?.left)) * scale,
    y: (finite(point?.y) - finite(camera?.top)) * scale,
  };
}

export function screenToWorld(point, camera) {
  const scale = Math.max(0.0001, finite(camera?.scale, 1));
  return {
    x: finite(camera?.left) + finite(point?.x) / scale,
    y: finite(camera?.top) + finite(point?.y) / scale,
  };
}

export function isWorldPointVisible(point, camera, margin = 0) {
  const padding = Math.max(0, finite(margin));
  const x = finite(point?.x);
  const y = finite(point?.y);
  return x >= finite(camera?.left) - padding
    && x <= finite(camera?.right) + padding
    && y >= finite(camera?.top) - padding
    && y <= finite(camera?.bottom) + padding;
}

export function visibleTileRange(camera, tileWidth = 1280, tileHeight = 720, world = {}) {
  const bounds = normalizedWorld(world);
  const width = Math.max(1, finite(tileWidth, 1280));
  const height = Math.max(1, finite(tileHeight, 720));
  return {
    startColumn: clamp(Math.floor(finite(camera?.left) / width), 0, Math.max(0, Math.ceil(bounds.width / width) - 1)),
    endColumn: clamp(Math.floor((finite(camera?.right) - 0.001) / width), 0, Math.max(0, Math.ceil(bounds.width / width) - 1)),
    startRow: clamp(Math.floor(finite(camera?.top) / height), 0, Math.max(0, Math.ceil(bounds.height / height) - 1)),
    endRow: clamp(Math.floor((finite(camera?.bottom) - 0.001) / height), 0, Math.max(0, Math.ceil(bounds.height / height) - 1)),
  };
}

/** Returns a screen-edge marker for a world point, or null while on screen. */
export function computeEdgeIndicator(target, camera, padding = 34) {
  const screen = worldToScreen(target, camera);
  const width = Math.max(1, finite(camera?.screenWidth, finite(camera?.width) * finite(camera?.scale, 1)));
  const height = Math.max(1, finite(camera?.screenHeight, finite(camera?.height) * finite(camera?.scale, 1)));
  const inset = clamp(finite(padding, 34), 0, Math.min(width, height) / 2);
  if (screen.x >= inset && screen.x <= width - inset && screen.y >= inset && screen.y <= height - inset) return null;

  const centerX = width / 2;
  const centerY = height / 2;
  const dx = screen.x - centerX;
  const dy = screen.y - centerY;
  const ratioX = Math.abs(dx) > 0.001 ? (width / 2 - inset) / Math.abs(dx) : Infinity;
  const ratioY = Math.abs(dy) > 0.001 ? (height / 2 - inset) / Math.abs(dy) : Infinity;
  const amount = Math.min(ratioX, ratioY);
  return {
    x: centerX + dx * amount,
    y: centerY + dy * amount,
    angle: Math.atan2(dy, dx),
    distance: Math.hypot(dx, dy) / Math.max(0.0001, finite(camera?.scale, 1)),
  };
}

const ANIMATION_ROWS = Object.freeze({
  idle: 0,
  run: 1,
  attack: 2,
  hurt: 3,
  down: 4,
  special: 5,
});

export function resolveAnimationState(entity = {}, moving = false) {
  const status = String(entity.status || '').toLowerCase();
  const action = String(entity.action || '').toLowerCase();
  if (/down|dead|defeat|death|倒|死亡/.test(`${status} ${action}`) || finite(entity.hp, 1) <= 0) return 'down';
  if (entity.hit || entity.hurt || /hurt|hit|stagger|受伤|受击/.test(action)) return 'hurt';
  if (/attack|shoot|slash|cast|strike|攻击|射击|挥砍/.test(action)) return 'attack';
  if (/special|charge|roar|summon|技能|蓄力/.test(action)) return 'special';
  if (moving || /run|walk|move|chase|移动|追击/.test(action) || Math.hypot(finite(entity.vx), finite(entity.vy)) > 4) return 'run';
  return 'idle';
}

export function selectAnimationFrame(entity = {}, timeMs = 0, options = {}) {
  const state = options.state || resolveAnimationState(entity, options.moving);
  const frameCount = Math.max(1, Math.floor(finite(options.frameCount, state === 'hurt' ? 4 : 8)));
  const duration = Math.max(16, finite(
    options.frameDuration,
    state === 'run' ? 82 : state === 'attack' ? 62 : state === 'down' ? 85 : 120,
  ));
  const start = finite(options.startedAt, finite(entity.actionStartedAt, finite(entity.actionAt, 0)));
  const elapsed = Math.max(0, finite(timeMs) - start);
  const looping = options.looping ?? (state === 'idle' || state === 'run' || state === 'special');
  const rawFrame = Math.floor(elapsed / duration);
  return {
    state,
    row: ANIMATION_ROWS[state] ?? 0,
    column: looping ? rawFrame % frameCount : Math.min(frameCount - 1, rawFrame),
    frameCount,
  };
}
