const ZONE_LAYOUT = Object.freeze([
  { kind: 'safe', x: 0, y: 1880, width: 1260, height: 1000, center: { x: 560, y: 2420 }, hasSeal: false },
  { kind: 'hunt', x: 860, y: 1640, width: 1640, height: 1240, center: { x: 1620, y: 2240 }, hasSeal: true },
  { kind: 'hunt', x: 1660, y: 600, width: 1900, height: 1320, center: { x: 2640, y: 1280 }, hasSeal: true },
  { kind: 'hunt', x: 3220, y: 1240, width: 1900, height: 1580, center: { x: 4140, y: 2020 }, hasSeal: true },
  { kind: 'boss', x: 3560, y: 0, width: 1560, height: 1260, center: { x: 4380, y: 620 }, hasSeal: false },
]);

const BASE_OBSTACLES = Object.freeze([
  { id: 'camp-supply-hut', name: '补给棚屋', kind: 'shack', visualKind: 'stall', shape: 'rect', x: 180, y: 2040, width: 260, height: 190 },
  { id: 'camp-broken-pier', name: '断裂码头', kind: 'dock_ruin', visualKind: 'bridge', shape: 'rect', x: 760, y: 2640, width: 300, height: 90 },
  { id: 'marsh-sunken-skiff', name: '沉没小舟', kind: 'dock_ruin', visualKind: 'bridge', shape: 'rect', x: 970, y: 2500, width: 250, height: 100 },
  { id: 'marsh-west-reef', name: '西侧岩礁', kind: 'reef', visualKind: 'rock', shape: 'circle', x: 1210, y: 1810, radius: 95 },
  { id: 'marsh-flood-wall', name: '浸水矮墙', kind: 'wall', visualKind: 'wall', shape: 'rect', x: 1660, y: 1770, width: 360, height: 90 },
  { id: 'marsh-east-reef', name: '东侧岩礁', kind: 'reef', visualKind: 'rock', shape: 'circle', x: 2160, y: 2730, radius: 100 },
  { id: 'market-canvas-stalls', name: '倾倒棚摊', kind: 'stall', visualKind: 'stall', shape: 'rect', x: 1900, y: 1120, width: 280, height: 150 },
  { id: 'market-arcade-wall', name: '集市残墙', kind: 'wall', visualKind: 'wall', shape: 'rect', x: 2220, y: 760, width: 100, height: 350 },
  { id: 'market-wrecked-quay', name: '货栈废墟', kind: 'dock_ruin', visualKind: 'bridge', shape: 'rect', x: 2720, y: 1370, width: 340, height: 100 },
  { id: 'market-fountain', name: '潮蚀石台', kind: 'reef', visualKind: 'rock', shape: 'circle', x: 3060, y: 800, radius: 100 },
  { id: 'ruins-lower-wall', name: '灯塔下墙', kind: 'wall', visualKind: 'wall', shape: 'rect', x: 3370, y: 1930, width: 430, height: 90 },
  { id: 'ruins-tide-reef', name: '潮沟岩礁', kind: 'reef', visualKind: 'rock', shape: 'circle', x: 4040, y: 2310, radius: 120 },
  { id: 'ruins-tower-base', name: '旧塔基座', kind: 'tower', visualKind: 'tower', shape: 'circle', x: 4590, y: 1480, radius: 120 },
  { id: 'ruins-broken-quay', name: '崩塌长堤', kind: 'dock_ruin', visualKind: 'bridge', shape: 'rect', x: 4480, y: 2420, width: 380, height: 90 },
  { id: 'heart-cliff-wall', name: '雾心断崖', kind: 'wall', visualKind: 'wall', shape: 'rect', x: 3630, y: 800, width: 400, height: 100 },
  { id: 'heart-bell-pillar', name: '残钟石柱', kind: 'pillar', visualKind: 'pillar', shape: 'circle', x: 4080, y: 300, radius: 90 },
  { id: 'heart-east-reef', name: '出口岩礁', kind: 'reef', visualKind: 'rock', shape: 'circle', x: 4830, y: 800, radius: 105 },
]);

const ENCOUNTER_LAYOUT = Object.freeze([
  [0, 1220, 2280], [0, 1450, 2050], [0, 1840, 2420], [0, 2020, 2110], [0, 1660, 2640], [0, 2180, 2520],
  [1, 2040, 1460], [1, 2420, 1040], [1, 2860, 1520], [1, 3200, 980], [1, 2700, 820], [1, 3300, 1640],
  [2, 3520, 2240], [2, 4050, 2560], [2, 4580, 2280], [2, 3820, 1760], [2, 4740, 1740], [2, 4320, 1420],
]);
const OBJECTIVE_LAYOUT = Object.freeze([[2180, 2480], [3060, 1260], [4480, 1940]]);

function defineStage(definition) {
  const zoneIds = definition.zones.map((entry) => entry.id);
  return Object.freeze({
    id: definition.id,
    mapKey: definition.id,
    title: definition.title,
    objectiveNoun: definition.objectiveNoun,
    objectiveLabel: definition.objectiveLabel,
    bossLabel: definition.bossLabel,
    completionTitle: definition.completionTitle,
    completionMessage: definition.completionMessage,
    spawn: Object.freeze({ x: 520, y: 2440 }),
    exit: Object.freeze({ x: 4720, y: 330, radius: 118, holdSeconds: 1 }),
    boss: Object.freeze({ ...definition.boss, zoneId: zoneIds[4], x: 4380, y: 650 }),
    zones: Object.freeze(definition.zones.map((entry, index) => Object.freeze({
      ...ZONE_LAYOUT[index], ...entry, center: Object.freeze({ ...ZONE_LAYOUT[index].center }),
    }))),
    obstacles: Object.freeze(BASE_OBSTACLES.map((entry) => Object.freeze({
      ...entry,
      id: definition.id === 'stage-01' ? entry.id : `${definition.id}-${entry.id}`,
      name: definition.id === 'stage-01' ? entry.name : `${definition.title}·${entry.name}`,
      solid: true,
    }))),
    encounters: Object.freeze(ENCOUNTER_LAYOUT.map(([zoneIndex, x, y], index) => Object.freeze({
      zoneId: zoneIds[zoneIndex + 1], type: definition.enemyTypes[index], x, y,
    }))),
    objectives: Object.freeze(OBJECTIVE_LAYOUT.map(([x, y], index) => Object.freeze({
      id: `seal-${zoneIds[index + 1]}`, kind: 'seal', zoneId: zoneIds[index + 1], x, y, radius: 54,
    }))),
  });
}

export const GAME_STAGES = Object.freeze([
  defineStage({
    id: 'stage-01', title: '晴潮雾港', objectiveNoun: '雾印',
    objectiveLabel: '清理三个猎场，拾取雾印', bossLabel: '前往潮雾之心，击败雾潮巨像',
    completionTitle: '晴潮航路已开', completionMessage: '雾印照亮旧港航道，猎团可以继续深入赤灯潮市。',
    zones: [{ id: 'camp', name: '猎团营地' }, { id: 'salt_marsh', name: '盐雾湿地' }, { id: 'sunk_market', name: '沉没集市' }, { id: 'lighthouse_ruins', name: '灯塔遗址' }, { id: 'fog_heart', name: '潮雾之心' }],
    enemyTypes: ['crawler', 'crawler', 'crawler', 'spitter', 'spitter', 'brute', 'crawler', 'crawler', 'spitter', 'spitter', 'brute', 'siren', 'crawler', 'crawler', 'spitter', 'brute', 'brute', 'siren'],
    boss: { type: 'fog_colossus', name: '雾潮巨像', epithet: '潮雾之心' },
  }),
  defineStage({
    id: 'stage-02', title: '赤灯潮市', objectiveNoun: '潮灯',
    objectiveLabel: '肃清三处潮市，重新点亮潮灯', bossLabel: '穿过摄政门，击败赤灯摄政',
    completionTitle: '赤灯潮市复明', completionMessage: '三盏潮灯重新燃起，云汐天关的升潮航线已经显现。',
    zones: [{ id: 'red_camp', name: '赤灯前哨' }, { id: 'ember_wharf', name: '余烬长埠' }, { id: 'tide_bazaar', name: '潮汐商廊' }, { id: 'lantern_court', name: '万灯庭院' }, { id: 'regent_gate', name: '摄政门' }],
    enemyTypes: ['crawler', 'crawler', 'spitter', 'spitter', 'brute', 'siren', 'crawler', 'spitter', 'spitter', 'brute', 'brute', 'siren', 'crawler', 'spitter', 'brute', 'brute', 'siren', 'siren'],
    boss: { type: 'lantern_regent', name: '赤灯摄政', epithet: '潮市守门人' },
  }),
  defineStage({
    id: 'stage-03', title: '云汐天关', objectiveNoun: '天关印',
    objectiveLabel: '稳住三座云汐台，收回天关印', bossLabel: '登上潮天峰，击败云汐潮甲',
    completionTitle: '云汐天关重启', completionMessage: '猎团贯通三关，晴潮重新回到雾港。',
    zones: [{ id: 'sky_haven', name: '云舟泊地' }, { id: 'cloud_bridge', name: '垂云长桥' }, { id: 'storm_terrace', name: '听雷云台' }, { id: 'celestial_gate', name: '天关门廊' }, { id: 'tide_summit', name: '潮天峰' }],
    enemyTypes: ['crawler', 'crawler', 'spitter', 'brute', 'brute', 'siren', 'crawler', 'spitter', 'brute', 'brute', 'siren', 'siren', 'crawler', 'spitter', 'brute', 'brute', 'siren', 'siren'],
    boss: { type: 'tide_tortoise', name: '云汐潮甲', epithet: '天关镇潮兽' },
  }),
]);
