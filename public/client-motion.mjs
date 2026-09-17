const PLAYER_SPEED = Object.freeze({
  vanguard: 245,
  ranger: 260,
});
const ROLE_ACTION_MOVE_MULTIPLIER = 0.65;
const DODGE_SPEED = 610;
const RANGER_SHOT_INTERVAL_MS = 400;
const RANGER_SHOT_SLOW_MS = 200;
const INPUT_SIGNATURE_REFRESH_MS = 450;
const MIN_LOCAL_PREDICTION_HORIZON_MS = 900;
const MAX_LOCAL_PREDICTION_HORIZON_MS = 2_000;
const WALKABLE_FALLBACK_SAMPLES = 32;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function inputSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

export function queuePendingInput(buffer, input, sentAt, limit = 64) {
  if (!Array.isArray(buffer)) throw new TypeError('pending input buffer must be an array');
  const seq = inputSequence(input?.seq);
  if (seq === null) return null;
  const existing = buffer.find((entry) => entry.seq === seq);
  if (existing) return existing;
  const entry = {
    ...input,
    seq,
    move: { x: finite(input?.move?.x), y: finite(input?.move?.y) },
    aim: { x: finite(input?.aim?.x), y: finite(input?.aim?.y) },
    sentAt: finite(sentAt),
    acknowledged: false,
  };
  buffer.push(entry);
  while (buffer.length > Math.max(1, Math.floor(finite(limit, 64)))) buffer.shift();
  return entry;
}

export function acknowledgePendingInput(buffer, acknowledgement) {
  if (!Array.isArray(buffer)) throw new TypeError('pending input buffer must be an array');
  const seq = inputSequence(acknowledgement?.seq);
  if (seq === null) return false;
  const index = buffer.findIndex((entry) => entry.seq === seq);
  if (index < 0) return false;
  if (acknowledgement?.accepted === false) {
    buffer.splice(index, 1);
    return false;
  }
  buffer[index].acknowledged = true;
  return true;
}

export function pruneProcessedInputs(buffer, lastProcessedInputSeq) {
  if (!Array.isArray(buffer)) throw new TypeError('pending input buffer must be an array');
  const processed = inputSequence(lastProcessedInputSeq);
  if (processed === null) return 0;
  const previousLength = buffer.length;
  const retained = buffer.filter((entry) => entry.seq > processed);
  buffer.splice(0, buffer.length, ...retained);
  return previousLength - buffer.length;
}

export function pendingOneShotRetry(buffer, lastProcessedInputSeq = -1) {
  if (!Array.isArray(buffer)) throw new TypeError('pending input buffer must be an array');
  const processed = inputSequence(lastProcessedInputSeq) ?? -1;
  return buffer.find((entry) => entry.seq > processed
    && entry.acknowledged !== true
    && (entry.dodge === true || entry.skill === true)) ?? null;
}

export function shouldSendInput(signature, lastSignature, elapsedMs, force = false) {
  return force === true
    || signature !== lastSignature
    || Math.max(0, finite(elapsedMs)) >= INPUT_SIGNATURE_REFRESH_MS;
}

export function localPredictionHorizonMs(rttMs = 0) {
  return clamp(
    Math.max(MIN_LOCAL_PREDICTION_HORIZON_MS, finite(rttMs) * 2 + 250),
    MIN_LOCAL_PREDICTION_HORIZON_MS,
    MAX_LOCAL_PREDICTION_HORIZON_MS,
  );
}

export function authorityLeadTolerance(speed, rttMs = 0) {
  const measuredRtt = Math.max(0, finite(rttMs));
  const effectiveRtt = measuredRtt > 0 ? measuredRtt : 250;
  const authorityAgeMs = clamp(effectiveRtt + 50, 120, 2_000);
  return Math.max(0, finite(speed)) * authorityAgeMs / 1000;
}

export function advanceRangerShotPrediction(state = {}, options = {}) {
  const now = Math.max(0, finite(options.now));
  let readyAt = Math.max(0, finite(state.readyAt));
  let slowUntil = Math.max(0, finite(state.slowUntil));
  if (options.attacking === true && now >= readyAt) {
    // The 30 Hz authority quantizes its 0.38 s cooldown and 0.22 s movement
    // penalty to a 0.4 s firing interval with 0.2 s of slowed movement.
    readyAt = now + RANGER_SHOT_INTERVAL_MS;
    slowUntil = Math.max(slowUntil, now + RANGER_SHOT_SLOW_MS);
  }
  return {
    readyAt,
    slowUntil,
    shotSlowRemaining: Math.max(0, (slowUntil - now) / 1000),
  };
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

function predictionSpeed(role, shotSlowRemaining, guarding) {
  const ranger = /ranger|gunner|gun|rune|range/i.test(String(role || ''));
  const slowedByAction = ranger ? finite(shotSlowRemaining) > 0 : guarding;
  return roleSpeed(role) * (slowedByAction ? ROLE_ACTION_MOVE_MULTIPLIER : 1);
}

function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const currentX = finite(currentPoint?.[0] ?? currentPoint?.x);
    const currentY = finite(currentPoint?.[1] ?? currentPoint?.y);
    const previousX = finite(previousPoint?.[0] ?? previousPoint?.x);
    const previousY = finite(previousPoint?.[1] ?? previousPoint?.y);
    const edgeX = currentX - previousX;
    const edgeY = currentY - previousY;
    const pointX = finite(point?.x) - previousX;
    const pointY = finite(point?.y) - previousY;
    const cross = Math.abs(pointX * edgeY - pointY * edgeX);
    const edgeLength = Math.hypot(edgeX, edgeY);
    const dot = pointX * edgeX + pointY * edgeY;
    if (cross <= Math.max(0.0001, edgeLength * 0.000001)
      && dot >= -0.0001
      && dot <= edgeX * edgeX + edgeY * edgeY + 0.0001) return true;
  }
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const currentX = finite(currentPoint?.[0] ?? currentPoint?.x);
    const currentY = finite(currentPoint?.[1] ?? currentPoint?.y);
    const previousX = finite(previousPoint?.[0] ?? previousPoint?.x);
    const previousY = finite(previousPoint?.[1] ?? previousPoint?.y);
    const crosses = (currentY > finite(point?.y)) !== (previousY > finite(point?.y))
      && finite(point?.x) < ((previousX - currentX) * (finite(point?.y) - currentY)) / (previousY - currentY) + currentX;
    if (crosses) inside = !inside;
  }
  return inside;
}

function walkablePoints(entry) {
  if (Array.isArray(entry?.points)) return entry.points;
  return Array.isArray(entry) ? entry : [];
}

function pointInWalkableArea(point, walkablePolygons) {
  const polygons = Array.isArray(walkablePolygons) ? walkablePolygons : [];
  if (polygons.length === 0) return true;
  return polygons.some((entry) => pointInPolygon(point, walkablePoints(entry)));
}

function pointToSegmentDistanceSquared(point, segment) {
  const edgeX = finite(segment?.bx) - finite(segment?.ax);
  const edgeY = finite(segment?.by) - finite(segment?.ay);
  const lengthSquared = edgeX * edgeX + edgeY * edgeY;
  const progress = lengthSquared > 0
    ? clamp(
      ((finite(point?.x) - finite(segment?.ax)) * edgeX
        + (finite(point?.y) - finite(segment?.ay)) * edgeY) / lengthSquared,
      0,
      1,
    )
    : 0;
  const nearestX = finite(segment?.ax) + edgeX * progress;
  const nearestY = finite(segment?.ay) + edgeY * progress;
  const dx = finite(point?.x) - nearestX;
  const dy = finite(point?.y) - nearestY;
  return dx * dx + dy * dy;
}

function circleInsideWalkableArea(circle, walkablePolygons, boundarySegments = []) {
  const polygons = Array.isArray(walkablePolygons) ? walkablePolygons : [];
  if (polygons.length === 0) return true;
  const radius = Math.max(0, finite(circle?.radius));
  if (!pointInWalkableArea(circle, polygons)) return false;
  if (Array.isArray(boundarySegments) && boundarySegments.length > 0) {
    const minimumDistance = Math.max(0, radius - 0.0001);
    const minimumSquared = minimumDistance * minimumDistance;
    return boundarySegments.every((segment) =>
      pointToSegmentDistanceSquared(circle, segment) >= minimumSquared,
    );
  }
  for (let index = 0; index < WALKABLE_FALLBACK_SAMPLES; index += 1) {
    const angle = (Math.PI * 2 * index) / WALKABLE_FALLBACK_SAMPLES;
    if (!pointInWalkableArea({
      x: finite(circle?.x) + Math.cos(angle) * radius,
      y: finite(circle?.y) + Math.sin(angle) * radius,
    }, polygons)) return false;
  }
  return true;
}

function movementInfluence(position, zones, baseSpeed) {
  let multiplier = 1;
  let pushX = 0;
  let pushY = 0;
  for (const zone of Array.isArray(zones) ? zones : []) {
    const polygons = Array.isArray(zone?.polygons) ? zone.polygons : [];
    if (!polygons.some((polygon) => pointInPolygon(position, polygon))) continue;
    multiplier = Math.min(multiplier, clamp(finite(zone.multiplier, 1), 0.1, 1));
    if (zone.kind !== 'wind' || !zone.vector) continue;
    const vectorX = finite(zone.vector.x);
    const vectorY = finite(zone.vector.y);
    const vectorLength = Math.hypot(vectorX, vectorY);
    const vectorScale = vectorLength > 1 ? 1 / vectorLength : 1;
    pushX += vectorX * vectorScale * baseSpeed * 0.18;
    pushY += vectorY * vectorScale * baseSpeed * 0.18;
  }
  const maximumPush = Math.max(0, baseSpeed) * 0.18;
  const pushLength = Math.hypot(pushX, pushY);
  if (pushLength > maximumPush && pushLength > 0) {
    pushX *= maximumPush / pushLength;
    pushY *= maximumPush / pushLength;
  }
  return { multiplier, push: { x: pushX, y: pushY } };
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
  const obstacles = Array.isArray(options.obstacles) ? options.obstacles : [];
  const walkablePolygons = Array.isArray(options.walkablePolygons) ? options.walkablePolygons : [];
  const walkableBoundarySegments = Array.isArray(options.walkableBoundarySegments)
    ? options.walkableBoundarySegments
    : [];
  const resolveCandidate = (candidate) => {
    const resolved = {
      x: clamp(finite(candidate?.x), padding + radius, arenaWidth - padding - radius),
      y: clamp(finite(candidate?.y), padding + radius, arenaHeight - padding - radius),
      radius,
    };
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
    return resolved;
  };
  const candidate = resolveCandidate(position);
  if (circleInsideWalkableArea(candidate, walkablePolygons, walkableBoundarySegments)) {
    return { x: candidate.x, y: candidate.y };
  }

  const previous = options.previousPosition ? resolveCandidate(options.previousPosition) : null;
  if (!previous || !circleInsideWalkableArea(previous, walkablePolygons, walkableBoundarySegments)) {
    return { x: candidate.x, y: candidate.y };
  }
  const alternatives = [];
  if (Math.abs(candidate.x - previous.x) > 0.0001) {
    alternatives.push(resolveCandidate({ x: candidate.x, y: previous.y }));
  }
  if (Math.abs(candidate.y - previous.y) > 0.0001) {
    alternatives.push(resolveCandidate({ x: previous.x, y: candidate.y }));
  }
  const slide = alternatives
    .filter((resolved) => circleInsideWalkableArea(resolved, walkablePolygons, walkableBoundarySegments))
    .sort((left, right) => (
      Math.hypot(right.x - previous.x, right.y - previous.y)
      - Math.hypot(left.x - previous.x, left.y - previous.y)
    ))[0];
  if (slide) return { x: slide.x, y: slide.y };

  let minimum = 0;
  let maximum = 1;
  let nearest = previous;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const progress = (minimum + maximum) / 2;
    const probe = resolveCandidate({
      x: previous.x + (candidate.x - previous.x) * progress,
      y: previous.y + (candidate.y - previous.y) * progress,
    });
    if (circleInsideWalkableArea(probe, walkablePolygons, walkableBoundarySegments)) {
      nearest = probe;
      minimum = progress;
    } else {
      maximum = progress;
    }
  }
  return { x: nearest.x, y: nearest.y };
}

export function predictLocalPosition(position, options = {}) {
  const radius = Math.max(0, finite(options.radius, 24));
  const dodging = finite(options.dodgeRemaining) > 0;
  const movement = dodging ? (options.dodgeVector ?? options.move) : options.move;
  const moveX = finite(movement?.x);
  const moveY = finite(movement?.y);
  const magnitude = Math.hypot(moveX, moveY);
  const scale = magnitude > 1 ? 1 / magnitude : 1;
  const dt = clamp(finite(options.dt), 0, 0.05);
  const baseSpeed = roleSpeed(options.role);
  const speed = dodging
    ? DODGE_SPEED
    : predictionSpeed(
      options.role,
      options.shotSlowRemaining,
      options.guarding === true || finite(options.guardRemaining) > 0,
    );
  const environment = movementInfluence(position, options.movementZones, baseSpeed);
  return resolveObstacleCollisions({
    x: finite(position?.x) + (moveX * scale * speed * environment.multiplier + environment.push.x) * dt,
    y: finite(position?.y) + (moveY * scale * speed * environment.multiplier + environment.push.y) * dt,
  }, { ...options, previousPosition: position });
}

export function shouldSuppressBackwardCorrection({
  moving = false,
  hasProcessedInputSeq = false,
  pendingInputs = [],
  confirmedMove = null,
} = {}) {
  if (!moving) return false;
  if (!hasProcessedInputSeq) return true;
  if (!Array.isArray(pendingInputs) || pendingInputs.length === 0) return false;
  if (!confirmedMove) return true;
  const confirmedX = finite(confirmedMove.x);
  const confirmedY = finite(confirmedMove.y);
  return pendingInputs.some((input) => input?.dodge === true
    || input?.skill === true
    || Math.hypot(
      finite(input?.move?.x) - confirmedX,
      finite(input?.move?.y) - confirmedY,
    ) >= 0.05);
}

export function reconcileLocalPosition(predicted, authoritative, move = {}, hardSnapDistance = 160, options = {}) {
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
  const backwardLimit = options.suppressBackwardCorrection ? 0 : hardDistance * 0.35;
  const backwardTolerance = Math.max(0, finite(options.backwardTolerance));
  const correctableForwardError = forwardError < 0
    ? Math.min(0, forwardError + backwardTolerance)
    : forwardError;
  const catchUp = clamp(correctableForwardError, -backwardLimit, hardDistance);
  const configuredBackwardCorrectionLimit = Number(options.maxBackwardCorrection);
  const maximumBackwardCorrection = Number.isFinite(configuredBackwardCorrectionLimit)
    ? Math.max(0, configuredBackwardCorrectionLimit)
    : Infinity;
  const forwardCorrection = Math.max(catchUp * 0.22, -maximumBackwardCorrection);
  let correctionX = lateralX * 0.22 + directionX * forwardCorrection;
  let correctionY = lateralY * 0.22 + directionY * forwardCorrection;
  const configuredCorrectionLimit = Number(options.maxCorrection);
  const maximumCorrection = Number.isFinite(configuredCorrectionLimit)
    ? Math.max(0, configuredCorrectionLimit)
    : Infinity;
  const correctionLength = Math.hypot(correctionX, correctionY);
  if (correctionLength > maximumCorrection) {
    correctionX *= maximumCorrection / correctionLength;
    correctionY *= maximumCorrection / correctionLength;
  }
  return {
    x: finite(predicted.x) + correctionX,
    y: finite(predicted.y) + correctionY,
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
  if (/special|skill|charge|guard|mark|roar|summon|技能|蓄力/.test(action)) return 'special';
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
