import stage01World from './world-v6/stage-01.json' with { type: 'json' };
import stage02World from './world-v6/stage-02.json' with { type: 'json' };
import stage03World from './world-v6/stage-03.json' with { type: 'json' };

const WORLD_DEFINITIONS = Object.freeze({
  'stage-01': stage01World,
  'stage-02': stage02World,
  'stage-03': stage03World,
});

const ENCOUNTER_RULES = Object.freeze({
  'stage-01': Object.freeze({
    countRange: Object.freeze([8, 11]),
    perZoneMaterializedTarget: 7,
    globalMaterializedCap: 21,
    globalAwakeCap: 14,
    xpBudget: 645,
    weights: Object.freeze({ crawler: 0.52, spitter: 0.27, brute: 0.21 }),
    minMelee: 2,
    minRanged: 1,
    maxSiren: 0,
  }),
  'stage-02': Object.freeze({
    countRange: Object.freeze([10, 13]),
    perZoneMaterializedTarget: 7,
    globalMaterializedCap: 21,
    globalAwakeCap: 14,
    xpBudget: 785,
    weights: Object.freeze({ crawler: 0.34, spitter: 0.26, brute: 0.25, siren: 0.15 }),
    minMelee: 2,
    minRanged: 1,
    maxSiren: 2,
  }),
  'stage-03': Object.freeze({
    countRange: Object.freeze([12, 15]),
    perZoneMaterializedTarget: 7,
    globalMaterializedCap: 21,
    globalAwakeCap: 14,
    xpBudget: 865,
    weights: Object.freeze({ crawler: 0.24, spitter: 0.26, brute: 0.3, siren: 0.2 }),
    minMelee: 2,
    minRanged: 1,
    maxSiren: 3,
  }),
});

const GEOMETRY_HASHES = Object.freeze({
  'stage-01': 'v6-harbor-shelf-7f3c',
  'stage-02': 'v6-canal-banks-c492',
  'stage-03': 'v6-sky-bridges-f92a',
});

const GEOMETRY_EPSILON = 0.000001;

const PROP_NAMES = Object.freeze({
  'hunter-hut': '猎人棚屋',
  'broken-pier': '断裂码头',
  'reef-cluster': '潮蚀岩礁',
  'flood-wall': '浸水矮墙',
  'market-stall': '雾港棚摊',
  'lighthouse-base': '灯塔基座',
  'landing-arch': '赤灯泊门',
  'canal-bridge': '运河石桥',
  'sluice-machine': '潮闸机括',
  'cargo-shrine': '货箱灯龛',
  'opera-stage': '水戏台',
  'regent-gate': '摄政门',
  'sky-dock': '云舟泊台',
  'bridge-anchor': '天桥锚柱',
  'cloud-bell': '听风云钟',
  'beacon-tower': '云汐烽台',
  'heavenly-altar': '天关祭台',
  'return-gate': '归潮天门',
});

function freezePoint(point) {
  return Object.freeze({ ...point });
}

function freezePolygon(points) {
  return Object.freeze(points.map(([x, y]) => Object.freeze([x, y])));
}

function freezeSurfaceZone(zone) {
  return Object.freeze({
    ...zone,
    polygons: Object.freeze(zone.polygons.map(freezePolygon)),
  });
}

function freezeMovementZone(zone) {
  return Object.freeze({
    ...zone,
    vector: zone.vector ? freezePoint(zone.vector) : undefined,
    polygons: Object.freeze(zone.polygons.map(freezePolygon)),
  });
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
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

function pointInPolygonUnion(point, polygons) {
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

function addSegmentBreakpoints(breakpoints, start, end, otherStart, otherEnd) {
  const edgeX = end[0] - start[0];
  const edgeY = end[1] - start[1];
  const otherX = otherEnd[0] - otherStart[0];
  const otherY = otherEnd[1] - otherStart[1];
  const offsetX = otherStart[0] - start[0];
  const offsetY = otherStart[1] - start[1];
  const denominator = cross(edgeX, edgeY, otherX, otherY);
  if (Math.abs(denominator) > GEOMETRY_EPSILON) {
    const along = cross(offsetX, offsetY, otherX, otherY) / denominator;
    const across = cross(offsetX, offsetY, edgeX, edgeY) / denominator;
    if (along >= -GEOMETRY_EPSILON && along <= 1 + GEOMETRY_EPSILON
      && across >= -GEOMETRY_EPSILON && across <= 1 + GEOMETRY_EPSILON) {
      breakpoints.push(Math.max(0, Math.min(1, along)));
    }
    return;
  }
  if (Math.abs(cross(offsetX, offsetY, edgeX, edgeY)) > GEOMETRY_EPSILON) return;
  const lengthSquared = edgeX * edgeX + edgeY * edgeY;
  if (lengthSquared <= GEOMETRY_EPSILON) return;
  for (const point of [otherStart, otherEnd]) {
    const projection = ((point[0] - start[0]) * edgeX + (point[1] - start[1]) * edgeY) / lengthSquared;
    if (projection >= -GEOMETRY_EPSILON && projection <= 1 + GEOMETRY_EPSILON) {
      breakpoints.push(Math.max(0, Math.min(1, projection)));
    }
  }
}

function buildWalkableBoundarySegments(walkablePolygons) {
  const polygons = walkablePolygons.map((entry) => entry.points);
  const boundary = [];
  const seen = new Set();
  for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex += 1) {
    const polygon = polygons[polygonIndex];
    for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex += 1) {
      const start = polygon[edgeIndex];
      const end = polygon[(edgeIndex + 1) % polygon.length];
      const breakpoints = [0, 1];
      for (let otherPolygonIndex = 0; otherPolygonIndex < polygons.length; otherPolygonIndex += 1) {
        const other = polygons[otherPolygonIndex];
        for (let otherEdgeIndex = 0; otherEdgeIndex < other.length; otherEdgeIndex += 1) {
          if (polygonIndex === otherPolygonIndex && edgeIndex === otherEdgeIndex) continue;
          addSegmentBreakpoints(
            breakpoints,
            start,
            end,
            other[otherEdgeIndex],
            other[(otherEdgeIndex + 1) % other.length],
          );
        }
      }
      const ordered = [...new Set(breakpoints.map((value) => Math.round(value * 1e9) / 1e9))]
        .sort((left, right) => left - right);
      const edgeX = end[0] - start[0];
      const edgeY = end[1] - start[1];
      const edgeLength = Math.hypot(edgeX, edgeY);
      if (edgeLength <= GEOMETRY_EPSILON) continue;
      const normalX = -edgeY / edgeLength;
      const normalY = edgeX / edgeLength;
      for (let index = 1; index < ordered.length; index += 1) {
        const from = ordered[index - 1];
        const to = ordered[index];
        if (to - from <= GEOMETRY_EPSILON) continue;
        const midpoint = (from + to) / 2;
        const midpointX = start[0] + edgeX * midpoint;
        const midpointY = start[1] + edgeY * midpoint;
        const probeDistance = Math.min(0.05, edgeLength * (to - from) * 0.1);
        const insideLeft = pointInPolygonUnion({
          x: midpointX + normalX * probeDistance,
          y: midpointY + normalY * probeDistance,
        }, polygons);
        const insideRight = pointInPolygonUnion({
          x: midpointX - normalX * probeDistance,
          y: midpointY - normalY * probeDistance,
        }, polygons);
        if (insideLeft === insideRight) continue;
        const ax = start[0] + edgeX * from;
        const ay = start[1] + edgeY * from;
        const bx = start[0] + edgeX * to;
        const by = start[1] + edgeY * to;
        const forward = ax < bx || (Math.abs(ax - bx) <= GEOMETRY_EPSILON && ay <= by);
        const keyValues = forward ? [ax, ay, bx, by] : [bx, by, ax, ay];
        const key = keyValues.map((value) => Math.round(value * 1e6)).join(':');
        if (seen.has(key)) continue;
        seen.add(key);
        boundary.push(Object.freeze({ ax, ay, bx, by }));
      }
    }
  }
  return Object.freeze(boundary);
}

function buildObstacles(world) {
  const terrain = world.blockedRegions.map((region) => Object.freeze({
    ...region,
    name: region.kind === 'cloud_void' ? '云渊边界' : region.kind === 'canal_water' ? '深水运河' : '深潮水域',
    visualKind: 'terrain-boundary',
    terrainBoundary: true,
    solid: true,
  }));
  const props = world.props.map((prop) => Object.freeze({
    ...prop.collision,
    id: prop.id,
    name: PROP_NAMES[prop.asset] ?? prop.id,
    kind: 'world_prop',
    visualKind: 'v6-prop',
    asset: prop.asset,
    visualX: prop.x,
    visualY: prop.y,
    anchor: Object.freeze([...prop.anchor]),
    scale: prop.scale,
    solid: true,
  }));
  return Object.freeze([...terrain, ...props]);
}

function buildEncounters(world, enemyTypes) {
  return Object.freeze(world.encounterAnchors.map((anchor, index) => Object.freeze({
    ...anchor,
    type: enemyTypes[index % enemyTypes.length],
  })));
}

function defineStage(definition) {
  const world = WORLD_DEFINITIONS[definition.id];
  if (!world) throw new Error(`Missing v6 world definition for ${definition.id}`);
  const walkablePolygons = Object.freeze(world.walkablePolygons.map((entry) => Object.freeze({
    ...entry,
    points: freezePolygon(entry.points),
  })));
  return Object.freeze({
    id: definition.id,
    mapKey: definition.id,
    worldVersion: 6,
    geometryHash: GEOMETRY_HASHES[definition.id],
    title: definition.title,
    objectiveNoun: definition.objectiveNoun,
    objectiveLabel: definition.objectiveLabel,
    bossLabel: definition.bossLabel,
    completionTitle: definition.completionTitle,
    completionMessage: definition.completionMessage,
    spawn: freezePoint(world.spawn),
    exit: Object.freeze({ ...world.exit }),
    boss: Object.freeze({ ...definition.boss, ...world.boss }),
    zones: Object.freeze(world.zones.map((zone) => Object.freeze({
      ...zone,
      center: freezePoint(zone.center),
    }))),
    obstacles: buildObstacles(world),
    encounters: buildEncounters(world, definition.enemyTypes),
    encounterAnchors: Object.freeze(world.encounterAnchors.map((anchor) => Object.freeze({ ...anchor }))),
    encounterRules: ENCOUNTER_RULES[definition.id],
    objectives: Object.freeze(world.objectives.map((objective) => Object.freeze({ ...objective }))),
    walkablePolygons,
    walkableBoundarySegments: buildWalkableBoundarySegments(walkablePolygons),
    surfaceZones: Object.freeze(world.surfaceZones.map(freezeSurfaceZone)),
    movementZones: Object.freeze(world.movementZones.map(freezeMovementZone)),
    ambientEmitters: Object.freeze(world.ambientEmitters.map((emitter) => Object.freeze({ ...emitter }))),
  });
}

export const GAME_STAGES = Object.freeze([
  defineStage({
    id: 'stage-01', title: '晴潮雾港', objectiveNoun: '雾印',
    objectiveLabel: '清理三个猎场，拾取雾印', bossLabel: '前往潮雾之心，击败雾潮巨像',
    completionTitle: '晴潮航路已开', completionMessage: '雾印照亮旧港航道，猎团可以继续深入赤灯潮市。',
    enemyTypes: ['crawler', 'crawler', 'spitter', 'brute'],
    boss: { type: 'fog_colossus', name: '雾潮巨像', epithet: '潮雾之心' },
  }),
  defineStage({
    id: 'stage-02', title: '赤灯潮市', objectiveNoun: '潮灯',
    objectiveLabel: '肃清三处潮市，重新点亮潮灯', bossLabel: '穿过摄政门，击败赤灯摄政',
    completionTitle: '赤灯潮市复明', completionMessage: '三盏潮灯重新燃起，云汐天关的升潮航线已经显现。',
    enemyTypes: ['crawler', 'spitter', 'brute', 'siren'],
    boss: { type: 'lantern_regent', name: '赤灯摄政', epithet: '潮市守门人' },
  }),
  defineStage({
    id: 'stage-03', title: '云汐天关', objectiveNoun: '天关印',
    objectiveLabel: '稳住三座云汐台，收回天关印', bossLabel: '登上潮天峰，击败云汐潮甲',
    completionTitle: '云汐天关重启', completionMessage: '猎团贯通三关，晴潮重新回到雾港。',
    enemyTypes: ['crawler', 'spitter', 'brute', 'siren'],
    boss: { type: 'tide_tortoise', name: '云汐潮甲', epithet: '天关镇潮兽' },
  }),
]);
