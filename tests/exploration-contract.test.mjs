import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GameState } from '../src/game-state.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const assetsRoot = path.join(publicRoot, 'assets');

function startCoopGame() {
  const game = new GameState({
    code: 'EXP234',
    mode: 'coop',
    rng: () => 0.37,
    now: () => 1_000,
  });
  game.addPlayer({ id: 'vanguard', name: '先锋', role: 'vanguard' });
  game.addPlayer({ id: 'ranger', name: '游侠', role: 'ranger' });
  return game;
}

function imageSize(buffer) {
  if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF', '动画图集必须是有效 PNG 或 WebP');
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WEBP', '动画图集缺少 WEBP 签名');
  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  throw new Error(`不支持的 WebP 数据块：${chunk}`);
}

function functionDeclaration(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `客户端缺少 ${name}`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let paramsEnd = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    if (source[index] === '(') paramsDepth += 1;
    if (source[index] === ')') paramsDepth -= 1;
    if (paramsDepth === 0) {
      paramsEnd = index;
      break;
    }
  }
  const bodyStart = source.indexOf('{', paramsEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`无法解析 ${name} 函数体`);
}

test('运行时版本覆盖 JSON import attributes 的稳定 Node 版本', async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.engines?.node, '>=20.18.3');
});

test('客户端仅在权威输入尚未确认时抑制反向位置纠偏', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const snapshotHandler = functionDeclaration(source, 'handleSnapshot');
  assert.match(snapshotHandler, /shouldSuppressBackwardCorrection\s*\(\s*\{[\s\S]*?moving,[\s\S]*?hasProcessedInputSeq/);
  assert.match(snapshotHandler, /pendingInputs:\s*runtime\.pendingInputs[\s\S]*?confirmedMove:\s*runtime\.lastConfirmedMove/);
  assert.match(snapshotHandler, /backwardTolerance:\s*moving\s*\?\s*authorityLeadTolerance\(movementSpeed,\s*runtime\.rtt\)/);
});

test('远征世界明显大于单屏，并公开区域、探索物与出口状态', () => {
  const state = startCoopGame().snapshot();
  const viewportWidth = Number(state.arena?.viewportWidth || 1_280);
  const viewportHeight = Number(state.arena?.viewportHeight || 720);

  assert.ok(
    Number(state.arena?.width) >= viewportWidth * 2.5,
    `世界宽度 ${state.arena?.width} 仍接近单屏 ${viewportWidth}`,
  );
  assert.ok(
    Number(state.arena?.height) >= viewportHeight * 2.5,
    `世界高度 ${state.arena?.height} 仍接近单屏 ${viewportHeight}`,
  );

  assert.ok(Array.isArray(state.zones) && state.zones.length >= 3, '地图至少应有三个可辨识区域');
  assert.ok(
    state.zones.every((zone) => zone.id && (zone.label || zone.name)),
    '每个区域应有稳定 id 和面向玩家的名称',
  );
  assert.ok(
    Array.isArray(state.walkablePolygons) && state.walkablePolygons.length > 0,
    '权威快照必须公开与地表一致的可行走多边形',
  );
  assert.ok(
    Array.isArray(state.walkableBoundarySegments) && state.walkableBoundarySegments.length > 0,
    '权威快照必须公开多边形联集的真实外边界',
  );

  const seals = (state.collectibles || []).filter((item) => item.kind === 'seal');
  assert.ok(seals.length >= 3, '探索目标至少应包含三枚可收集封印');
  assert.ok(state.exit && Number.isFinite(state.exit.x) && Number.isFinite(state.exit.y), '快照应公开地图出口位置');
  assert.equal(typeof state.exit.unlocked, 'boolean', '出口必须公开锁定/解锁状态');

  assert.ok(state.progress && Number.isFinite(state.progress.sealsCollected), '快照应公开远征进度');
  assert.ok(
    Number(state.progress.sealsRequired) >= 3,
    '出口解锁前应要求完成多区域探索目标',
  );
});

test('客户端预测使用权威可行走多边形阻止穿水与坠入云渊', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const renderFrame = functionDeclaration(source, 'renderFrame');
  assert.match(
    renderFrame,
    /walkablePolygons:\s*runtime\.snapshot\.walkablePolygons[\s\S]*?walkableBoundarySegments:\s*runtime\.snapshot\.walkableBoundarySegments/,
    '本地预测必须消费快照中的可行走多边形',
  );
});

test('玩家拥有等级进度，实际击杀会获得经验而非只显示静态 UI', () => {
  const game = startCoopGame();
  const vanguard = game.players.get('vanguard');
  const ranger = game.players.get('ranger');
  assert.ok(Number.isFinite(vanguard.level) && vanguard.level >= 1, '玩家应从有效等级开始');
  assert.ok(Number.isFinite(vanguard.xp), '玩家应有经验值');
  assert.ok(Number(vanguard.xpToNext) > 0, '玩家应有下一等级经验门槛');

  const target = [...game.enemies.values()].find((enemy) => !enemy.boss) || [...game.enemies.values()][0];
  assert.ok(target, '远征开始后应存在可战斗的敌人');
  target.x = vanguard.x + 48;
  target.y = vanguard.y;
  target.hp = 1;
  const before = { vanguard: vanguard.xp, ranger: ranger.xp };

  game.setInput('vanguard', {
    move: { x: 0, y: 0 },
    aim: { x: 1, y: 0 },
    attack: true,
  }, 1);
  game.update(1 / 30);

  assert.ok(
    vanguard.xp > before.vanguard || ranger.xp > before.ranger,
    '击杀应让至少一名队员的经验值真实增长',
  );
  const playerSnapshot = game.snapshot().players.find((player) => player.id === 'vanguard');
  assert.ok(Number.isFinite(playerSnapshot.level) && Number.isFinite(playerSnapshot.xp), '等级与经验必须同步给客户端');
});

test('客户端提供可测试的跟随相机和双向坐标变换', async () => {
  const motion = await import('../public/client-motion.mjs');
  for (const helper of ['computeCameraViewport', 'worldToScreen', 'screenToWorld']) {
    assert.equal(typeof motion[helper], 'function', `client-motion.mjs 应导出 ${helper}`);
  }

  const camera = motion.computeCameraViewport(
    { x: 2_400, y: 1_400, scale: 1 },
    { width: 1_280, height: 720 },
    { width: 5_120, height: 2_880 },
  );
  assert.ok(Number.isFinite(camera.x) && Number.isFinite(camera.y), '相机应返回有效世界位置');
  assert.ok(Math.abs(camera.x - 2_400) < 0.001 && Math.abs(camera.y - 1_400) < 0.001, '相机应能跟到大世界中部');

  const worldPoint = { x: 2_733.25, y: 1_612.5 };
  const screenPoint = motion.worldToScreen(worldPoint, camera);
  const roundTrip = motion.screenToWorld(screenPoint, camera);
  assert.ok(Math.abs(roundTrip.x - worldPoint.x) < 0.001);
  assert.ok(Math.abs(roundTrip.y - worldPoint.y) < 0.001);
});

test('主画布使用统一相机投影，不再把整个世界横纵分别压进一屏', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');

  assert.match(source, /(?:computeCameraViewport|updateFollowCamera)\s*\(/, '渲染循环应更新跟随相机');
  assert.match(source, /worldToScreen\s*\(/, '世界实体应经统一相机变换投影到屏幕');
  assert.doesNotMatch(
    source,
    /const\s+scaleX\s*=\s*width\s*\/\s*worldWidth[\s\S]{0,180}?const\s+scaleY\s*=\s*height\s*\/\s*worldHeight/,
    '不能再把完整世界按横纵两个比例非等比压缩进 Canvas',
  );
});

test('三关地图按可见瓦片加载，离开关卡后释放旧地图', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');

  for (const key of ['stage-01', 'stage-02', 'stage-03']) {
    assert.ok(source.includes(key), `客户端地图注册表缺少 ${key}`);
  }
  assert.match(source, /visibleTileRange\s*\(/, '地图渲染应只计算当前相机可见瓦片');
  assert.match(source, /ground-r/, 'v6 地表瓦片路径应按行列生成');
  assert.match(source, /ambient-mask-r/, '环境遮罩应跟随可见瓦片加载');
  assert.match(source, /ambient-mask-r\$\{row\}-c\$\{column\}-v6\.png\?channels=rgb-v1/, 'RGB 遮罩必须使用新 URL 绕过已发布 RGBA 缓存');
  assert.match(source, /geometryRevision:\s*"f92a"/, '第三关几何更新必须携带新的静态资源缓存版本');
  assert.match(source, /\?geometry=\$\{config\.geometryRevision\}/, '第三关地表必须用几何版本绕过旧云渊缓存');
  assert.match(source, /stageTileCache|tileCache/, '客户端应维护有限地图瓦片缓存');
  assert.match(source, /(?:\.delete\(|\.clear\(\))/, '换关或离开视野后应释放旧瓦片引用');
  assert.doesNotMatch(source, /world-map-v4\.webp/, '旧的单张放大背景不应继续作为生产地图');
});

test('首屏先画低清全图，HD 地块解码完成前不撤掉背景兜底', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const arena = functionDeclaration(source, 'drawArena');

  assert.match(source, /function drawStageOverview\s*\(/, '客户端应复用大厅的 overview-v6 作为首屏低清全图');
  const overviewIndex = arena.indexOf('drawStageOverview(state, camera)');
  const syncIndex = arena.indexOf('syncStageTileCache(state, camera)');
  const tileIndex = arena.indexOf('drawStageTiles(state, camera, groundTiles)');
  assert.ok(syncIndex >= 0 && syncIndex < overviewIndex, '同一渲染帧应先启动 HD 地块请求，再判断是否需要低清全图');
  assert.ok(overviewIndex < tileIndex, 'HD 地块应逐块覆盖低清全图');
  assert.match(
    arena,
    /runtime\.visibleGroundReady\s*=\s*groundTiles\.length\s*>\s*0\s*&&\s*groundTiles\.every/,
    '只有全部可见地块解码完成后才能宣布首屏地表就绪',
  );
  assert.match(arena, /!runtime\.visibleGroundReady\s*&&\s*drawStageOverview/, 'HD 地块未齐时必须持续显示低清全图');
  assert.match(arena, /runtime\.visibleGroundReady\s*\|\|\s*visibleGroundSettled[\s\S]*?stageEnhancementsUnlocked\s*=\s*true/, '地块成功或有限重试耗尽后都应解锁其余画面层');
});

test('低清全图按世界比例裁切到当前镜头', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const image = { complete: true, naturalWidth: 512, naturalHeight: 288 };
  const calls = [];
  const ctx = { drawImage(...args) { calls.push(args); } };
  const drawStageOverview = new Function(
    'stageVisualKeyFrom',
    'stageOverviewImages',
    'stageWorldRegistry',
    'safeNumber',
    'MAP_TILE_COLUMNS',
    'MAP_TILE_ROWS',
    'clamp',
    'ctx',
    `${functionDeclaration(source, 'drawStageOverview')}\nreturn drawStageOverview;`,
  )(
    () => 'stage-01',
    { 'stage-01': image },
    { 'stage-01': { tileWidth: 1_280, tileHeight: 720 } },
    (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    4,
    4,
    (value, min, max) => Math.min(max, Math.max(min, value)),
    ctx,
  );

  const drawn = drawStageOverview(
    { arena: { width: 5_120, height: 2_880 } },
    {
      left: 1_920,
      top: 1_080,
      right: 3_200,
      bottom: 1_800,
      x: 2_560,
      y: 1_440,
      scale: 1,
      screenWidth: 1_280,
      screenHeight: 720,
    },
  );

  assert.equal(drawn, true);
  assert.deepEqual(calls[0], [image, 192, 108, 128, 72, 0, 0, 1_280, 720]);
});

test('图片等待异步解码后才可绘制，失败请求只做有限重试', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const timers = [];
  const images = [];
  let now = 0;
  const fakeWindow = {
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    },
    setTimeout(callback, delay) {
      const timer = { callback, cleared: false, delay, id: timers.length + 1 };
      timers.push(timer);
      return timer.id;
    },
  };
  class FakeImage {
    constructor() {
      this.listeners = new Map();
      this.naturalWidth = 1280;
      this.naturalHeight = 720;
      this.resolveDecode = null;
      images.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    decode() {
      return new Promise((resolve) => { this.resolveDecode = resolve; });
    }

    emit(type) {
      return this.listeners.get(type)?.();
    }

    removeAttribute() {}
  }
  const loadImage = new Function(
    'window',
    'Image',
    'Date',
    'IMAGE_LOAD_RETRY_LIMIT',
    'IMAGE_LOAD_RETRY_DELAY_MS',
    'IMAGE_LOAD_RETRY_COOLDOWN_MS',
    'IMAGE_LOAD_RETRY_CYCLE_LIMIT',
    `${functionDeclaration(source, 'loadImage')}\nreturn loadImage;`,
  )(fakeWindow, FakeImage, { now: () => now }, 2, 250, 10_000, 2);

  const decoded = loadImage('ground.webp', { lazy: true });
  decoded.load({ priority: 'high' });
  assert.equal(images[0].fetchPriority, 'high', '可见地块应向浏览器声明高优先级');
  const decodePending = images[0].emit('load');
  assert.equal(decoded.ready, false, 'load 事件后、decode 完成前不得覆盖低清全图');
  images[0].resolveDecode();
  await decodePending;
  assert.equal(decoded.ready, true, 'decode 完成后 HD 地块才可进入绘制');

  const failing = loadImage('broken.webp', { lazy: true });
  failing.load({ priority: 'low' });
  const exhaustFailureCycle = () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      images.at(-1).emit('error');
      const retry = timers.find((timer) => !timer.cleared);
      if (attempt < 2) {
        assert.ok(retry, `第 ${attempt + 1} 次失败后应安排重试`);
        retry.cleared = true;
        retry.callback();
      } else {
        assert.equal(retry, undefined, '一轮达到上限后不得立即继续重试');
      }
    }
  };
  exhaustFailureCycle();
  assert.equal(failing.failed, true, '重试耗尽后应保留失败状态并继续显示兜底');
  const firstCycleImages = images.length;
  failing.load({ priority: 'high' });
  assert.equal(images.length, firstCycleImages, '冷却期内每帧调用 load 也不得产生新请求');

  now = 10_001;
  failing.load({ priority: 'high' });
  assert.equal(images.length, firstCycleImages + 1, '冷却后只允许一轮有界恢复请求');
  assert.equal(images.at(-1).fetchPriority, 'high', '恢复请求应使用当前可见优先级');
  exhaustFailureCycle();
  const allImages = images.length;
  now = 20_002;
  failing.load({ priority: 'high' });
  assert.equal(images.length, allImages, '永久损坏资源达到总上限后不得终身循环请求');
});

test('可见地块优先，预取、环境遮罩、前景图集和动画延后加载', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const tileSync = functionDeclaration(source, 'syncStageTileCache');
  const arena = functionDeclaration(source, 'drawArena');
  const actor = functionDeclaration(source, 'drawActor');
  const prop = functionDeclaration(source, 'drawV6Prop');

  assert.match(tileSync, /visible[\s\S]*?load\(\{\s*priority:\s*["']high["']\s*\}\)/, '可见地块必须高优先级加载');
  assert.match(
    tileSync,
    /visibleTiles\.every[\s\S]*?prefetch[\s\S]*?load\(\{\s*priority:\s*["']high["']\s*\}\)/,
    '唯一邻接预取只可在可见地块就绪后以创建时高优先级加载',
  );
  assert.match(source, /MAX_STAGE_TILE_REQUESTS\s*=\s*MAX_STAGE_TILE_CACHE\s*\+\s*1/, '在途地块必须有硬上限');
  assert.match(tileSync, /stageTileCache\.size\s*>=\s*MAX_STAGE_TILE_REQUESTS[\s\S]*?includeLoading:\s*true/, '快速转向时必须允许淘汰过时的在途地块');
  assert.match(tileSync, /lastUsed/, '地块缓存应按最近使用保留');
  assert.match(tileSync, /stageTileCache\.size\s*>\s*MAX_STAGE_TILE_CACHE/, '请求稳定后必须收敛回解码缓存上限');
  assert.match(arena, /stageEnhancementsUnlocked[\s\S]*?drawStageAmbientMasks\([^)]*\{\s*load:\s*runtime\.visibleGroundReady\s*\}/, '环境遮罩不得与首屏可见地块抢带宽');
  assert.match(prop, /if\s*\(!runtime\.stageEnhancementsUnlocked\)\s*return false/, '前景图集应等首屏地表成功或失败收敛后再请求');
  assert.match(actor, /runtime\.stageEnhancementsUnlocked[\s\S]*?animation\?\.load\(\{\s*priority:\s*["']low["']\s*\}\)/, '逐帧动画应等首屏地表成功或失败收敛后低优先级加载');
});

test('地块失败收敛后其余画面层解锁且不会因换瓦片闪退', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const runtime = {
    visibleGroundReady: false,
    stageEnhancementsUnlocked: false,
    debugCollision: false,
  };
  let tiles = [{ asset: { ready: false, failed: true, loading: false } }];
  const ambientLoads = [];
  const drawArena = new Function(
    'ctx',
    'runtime',
    'syncStageTileCache',
    'drawStageOverview',
    'drawStageSurface',
    'drawStageTiles',
    'drawStageAmbientMasks',
    'drawStageDynamics',
    'drawZoneLandmarks',
    'drawObstacles',
    `${functionDeclaration(source, 'drawArena')}\nreturn drawArena;`,
  )(
    { fillStyle: '', fillRect() {} },
    runtime,
    () => tiles,
    () => true,
    () => {},
    () => {},
    (_state, _camera, _time, options) => ambientLoads.push(options.load),
    () => {},
    () => {},
    () => {},
  );

  drawArena({}, {}, 1_280, 720, 0);
  assert.equal(runtime.stageEnhancementsUnlocked, true, '失败地块有限重试耗尽后不应永久阻塞其余美术');
  assert.deepEqual(ambientLoads, [false], 'HD 未就绪时只绘制已缓存增强层，不应启动竞争请求');

  tiles = [{ asset: { ready: false, failed: false, loading: true } }];
  drawArena({}, {}, 1_280, 720, 16);
  assert.equal(runtime.stageEnhancementsUnlocked, true, '镜头移动到新瓦片时增强层解锁状态应保持');
  assert.deepEqual(ambientLoads, [false, false]);
});

test('快速转向时地块请求保持硬上限并收敛到 LRU 缓存', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const runtime = { stageTileCache: new Map(), stageTileUse: 0 };
  const makeAsset = ({ loading = true, ready = false } = {}) => ({
    ready,
    failed: false,
    loading,
    priority: '',
    released: false,
    load({ priority }) { this.priority = priority; },
    release() { this.loading = false; this.released = true; },
  });
  for (let index = 0; index < 6; index += 1) {
    runtime.stageTileCache.set(`stale-${index}`, {
      key: `stale-${index}`,
      lastUsed: index,
      asset: makeAsset(),
    });
  }
  const desired = {
    visible: Array.from({ length: 4 }, (_, index) => ({
      key: `visible-${index}`,
      stageKey: 'stage-01',
      row: 2 + Math.floor(index / 2),
      column: index % 2,
    })),
    prefetch: null,
  };
  const syncStageTileCache = new Function(
    'desiredStageTiles',
    'runtime',
    'MAX_STAGE_TILE_REQUESTS',
    'MAX_STAGE_TILE_CACHE',
    'safeNumber',
    'loadImage',
    'stageTilePath',
    `${functionDeclaration(source, 'syncStageTileCache')}\nreturn syncStageTileCache;`,
  )(
    () => desired,
    runtime,
    6,
    5,
    (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    () => makeAsset(),
    () => 'tile.webp',
  );

  const visible = syncStageTileCache({}, {});
  assert.equal(runtime.stageTileCache.size, 6, '在途请求不得超过四块可见地块加两个保留位');
  assert.equal([...runtime.stageTileCache.keys()].filter((key) => key.startsWith('stale-')).length, 2);
  assert.equal(visible.length, 4);
  assert.ok(visible.every((tile) => tile.asset.priority === 'high'), '新可见地块必须全部高优先级请求');

  for (const cached of runtime.stageTileCache.values()) {
    cached.asset.loading = false;
    cached.asset.ready = true;
  }
  syncStageTileCache({}, {});
  assert.equal(runtime.stageTileCache.size, 5, '请求完成后应收敛到五块解码缓存');
});

test('v6 地表、环境、实体与前景道具按世界坐标分层渲染', async () => {
  const source = (await readFile(path.join(publicRoot, 'app.js'), 'utf8')).replace(/\r\n?/g, '\n');
  const arena = source.match(/function drawArena\(state, camera, width, height, time\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function stageTilePath/);
  assert.ok(arena, '应保留独立地表渲染入口');
  const surfaceIndex = arena[1].indexOf('drawStageSurface(state, camera)');
  const groundIndex = arena[1].indexOf('drawStageTiles(state, camera');
  const ambientIndex = arena[1].indexOf('drawStageAmbientMasks(state, camera');
  const dynamicIndex = arena[1].indexOf('drawStageDynamics(state, camera, time)');
  assert.ok(surfaceIndex >= 0 && surfaceIndex < groundIndex, '程序化 surface 兜底应先于不透明 ground');
  assert.ok(groundIndex < ambientIndex && ambientIndex < dynamicIndex, '环境遮罩和动态光水云应位于 ground 之上');
  assert.match(source, /const surfaceAssetOrder/, '客户端必须声明各关地表图集顺序');
  assert.match(source, /surfaceAssetOrder\[stageKey\]\?\.indexOf\(zone\.surface\)/, '地表图集必须按材质名选格，不能按区域顺序错配');
  assert.match(source, /function drawV6Prop\s*\(/, '前景道具必须从图集独立绘制');
  assert.match(source, /sortY:\s*v6Prop\s*\?\s*safeNumber\(obstacle\.visualY/, 'v6 道具必须用 visualY 与角色共同 y-sort');
  assert.match(source, /terrainBoundary[\s\S]{0,140}?terrain-boundary/, '权威边界碰撞体不得画成道具');
  for (const helper of ['drawDynamicWater', 'drawDynamicLantern', 'drawDynamicCloud']) {
    assert.match(source, new RegExp(`function ${helper}\\s*\\(`), `缺少关卡世界坐标动态骨架 ${helper}`);
  }
});

test('客户端提交 Q/触屏角色技能并展示权威冷却与战斗状态', async () => {
  const [html, source] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
  ]);
  for (const id of ['skillSlot', 'skillCooldown', 'skillName', 'touchSkill', 'touchSkillCooldown']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `技能 HUD 缺少 ${id}`);
  }
  assert.match(source, /event\.code\s*===\s*["']KeyQ["'][\s\S]{0,100}?controls\.skill\s*=\s*true/, 'Q 键必须写入 controls.skill');
  assert.match(source, /skill:\s*controls\.skill/, '网络输入 payload 必须携带 skill boolean');
  assert.match(source, /player\?\.skillCooldown/, 'HUD 必须读取服务端 skillCooldown');
  assert.match(source, /guardRemaining/, '重刃守潮阵必须有可见状态');
  for (const field of ['armorBreakRemaining', 'markStacks', 'markRemaining', 'slowRemaining', 'rootRemaining']) {
    assert.ok(source.includes(field), `客户端缺少敌人状态视觉 ${field}`);
  }
});

test('Q 与触屏技能快速点按会锁存到发送成功，释放事件不会提前清零', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const controls = {
    move: { x: 0, y: 0 },
    aim: { x: 1, y: 0 },
    attack: false,
    interact: false,
    dodge: false,
    skill: false,
  };
  const keys = new Set();
  const ui = { gameView: { hidden: false } };
  class FakeInputElement {}
  const keyboardHandlers = new Function(
    'ui',
    'HTMLInputElement',
    'stageBlocksInput',
    'keys',
    'controls',
    'updateKeyboardMovement',
    `${functionDeclaration(source, 'onKeyDown')}\n${functionDeclaration(source, 'onKeyUp')}\nreturn { onKeyDown, onKeyUp };`,
  )(ui, FakeInputElement, () => false, keys, controls, () => {});
  const keyEvent = {
    code: 'KeyQ',
    repeat: false,
    target: {},
    preventDefault() {},
  };
  keyboardHandlers.onKeyDown(keyEvent);
  keyboardHandlers.onKeyUp(keyEvent);
  assert.equal(controls.skill, true, 'Q 在 50ms 输入采样前松开也必须保留一次技能触发');

  const bindHoldButton = new Function(
    'controls',
    'stageBlocksInput',
    `${functionDeclaration(source, 'bindHoldButton')}\nreturn bindHoldButton;`,
  )(controls, () => false);
  const makeButton = () => {
    const listeners = new Map();
    return {
      listeners,
      classList: { add() {}, remove() {} },
      addEventListener(type, listener) { listeners.set(type, listener); },
      setPointerCapture() {},
      releasePointerCapture() {},
    };
  };
  const pointerEvent = { pointerId: 7, preventDefault() {} };

  controls.skill = false;
  const skillButton = makeButton();
  bindHoldButton(skillButton, 'skill', { latch: true });
  skillButton.listeners.get('pointerdown')(pointerEvent);
  skillButton.listeners.get('pointerup')(pointerEvent);
  assert.equal(controls.skill, true, '触屏技能快速点按必须锁存到下一次成功发送');

  controls.interact = false;
  const interactButton = makeButton();
  bindHoldButton(interactButton, 'interact');
  interactButton.listeners.get('pointerdown')(pointerEvent);
  interactButton.listeners.get('pointerup')(pointerEvent);
  assert.equal(controls.interact, false, '互动按钮仍应保持按住/释放语义');

  assert.match(functionDeclaration(source, 'clearMovement'), /controls\.skill\s*=\s*false/, '失焦或阻断时仍必须清空技能锁存');
  const sendInput = functionDeclaration(source, 'sendInput');
  assert.match(sendInput, /socket\.send[\s\S]*?if \(input\.skill\) controls\.skill = false/, 'WebSocket 成功发送后必须消费技能锁存');
  assert.match(sendInput, /await request[\s\S]*?if \(input\.skill\) controls\.skill = false/, 'HTTP 成功发送后必须消费技能锁存');
});

test('正常游戏画面用 v6 前景图集表现道具碰撞体，边界碰撞体保持隐形', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');

  assert.match(source, /foreground-v6\.webp/, '应加载当前关 v6 前景道具图集');
  assert.doesNotMatch(source, /terrain-(?:common|stage)-[^'`]*-v1\.webp/, '生产路径不得请求旧 v1 地形图集');
  assert.match(source, /function\s+drawTerrainObstacle\s*\(/, '应有独立的可见地形绘制函数');
  assert.match(source, /visualKind/, '地形图集选择应由服务端权威碰撞体的 visualKind 驱动');
  assert.match(source, /entityKind:\s*[\"']terrain[\"']/, '可碰撞地形应进入世界 y 轴排序，而不是永远压在角色脚下');
  assert.match(source, /drawTerrainObstacle\s*\(/, '生产渲染路径必须实际绘制地形');
  assert.match(source, /obstacle\.terrainBoundary[\s\S]{0,100}?return/, '不可行区边界不得被画成道具');
});

test('探索 HUD 包含小地图、战争迷雾和屏外目标/队友指示', async () => {
  const [html, source] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
  ]);
  const frontend = `${html}\n${source}`;

  assert.match(frontend, /minimap/i, '应实现小地图而不是只显示当前战斗板');
  assert.match(source, /function\s+(?:draw|render)[\w]*(?:Fog|MistOfWar)/i, '应有独立的战争迷雾绘制逻辑');
  assert.match(
    source,
    /function\s+(?:draw|render)[\w]*(?:Offscreen|EdgeIndicator)/i,
    '应对屏外队友或出口绘制边缘指示',
  );
  assert.match(source, /discovered|explored/i, '小地图或迷雾必须受实际探索状态驱动');
});

test('v3 角色动画使用真实位图多帧图集，并在运行时切换动作帧', async () => {
  const names = await readdir(assetsRoot);
  const sheets = names.filter((name) => (
    /v3/i.test(name)
      && /(?:anim|sprite|vanguard|ranger|hunter|enemy)/i.test(name)
      && /\.(?:png|webp)$/i.test(name)
  ));
  const requiredSheets = ['vanguard-anim-v3.png', 'ranger-anim-v3.png'];
  for (const playerSheet of requiredSheets) {
    assert.ok(sheets.includes(playerSheet), `缺少双人主角动画图集 ${playerSheet}`);
  }

  const [source, motion] = await Promise.all([
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
    readFile(path.join(publicRoot, 'client-motion.mjs'), 'utf8'),
  ]);
  const frontend = `${source}\n${motion}`;
  const legacy = await readFile(path.join(assetsRoot, 'sprites-v2.webp'));

  for (const name of requiredSheets) {
    const buffer = await readFile(path.join(assetsRoot, name));
    assert.ok(buffer.length >= 12_000, `${name} 体积过小，疑似占位图或改名文件`);
    assert.equal(buffer.equals(legacy), false, `${name} 不能只是 sprites-v2.webp 的复制改名`);
    const { width, height } = imageSize(buffer);
    assert.ok(width >= 512 && height >= 256, `${name} 的 ${width}×${height} 不足以容纳可读多帧动作`);
    assert.ok(frontend.includes(`assets/${name}`), `${name} 必须被实际渲染代码引用`);
  }

  for (const state of ['idle', 'attack', 'hurt', 'down']) {
    assert.match(frontend, new RegExp(`['\"\`]${state}['\"\`]`, 'i'), `动画状态表缺少 ${state}`);
  }
  assert.match(frontend, /['"`](?:walk|run)['"`]/i, '动画状态表缺少 walk/run 移动循环');
  assert.match(frontend, /(?:frameIndex|frameCount|animationFrame|animFrame|currentFrame)/i, '动画必须计算当前帧');
  assert.match(frontend, /(?:actionSeq|action|status)[\s\S]{0,500}?(?:frameIndex|animFrame|animation)/i, '动作帧应由服务端动作/角色状态驱动');
  assert.match(frontend, /drawImage\s*\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*,[^)]*,[^)]*,[^)]*,[^)]*\)/i, '应使用九参数 drawImage 裁切图集帧');
});

test('主要敌人与三关首领也使用真实逐帧动作图集', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  const required = [
    'crawler-anim-v4.png',
    'brute-anim-v4.png',
    'siren-anim-v4.png',
    'fog-colossus-anim-v4.png',
    'lantern-regent-anim-v1.png',
    'tide-tortoise-anim-v1.png',
  ];
  for (const name of required) {
    const buffer = await readFile(path.join(assetsRoot, name));
    const size = imageSize(buffer);
    assert.ok(buffer.length >= 100_000, `${name} 体积过小，疑似静态占位`);
    assert.ok(size.width >= 1_024 && size.width % 8 === 0, `${name} 必须是至少1024像素宽的8列逐帧图集`);
    assert.ok(size.height >= 768 && size.height % 6 === 0, `${name} 必须是至少768像素高的6行动作图集`);
    assert.ok(source.includes(`assets/${name}`), `${name} 必须被运行时加载`);
  }
  for (const key of ['crawler', 'brute', 'siren', 'fog_colossus', 'lantern_regent', 'tide_tortoise']) {
    assert.match(source, new RegExp(`${key}[\\s\\S]{0,120}?loadImage`), `${key} 动画必须注册到动画资源表`);
  }
});

test('动画图集按可见角色懒加载，生产画面默认不显示碰撞调试几何', async () => {
  const [source, html] = await Promise.all([
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
  ]);
  const registry = source.match(/const animationAssets\s*=\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(registry, '应保留独立的动画资源注册表');
  assert.equal((registry[1].match(/\{\s*lazy:\s*true\s*\}/g) || []).length, 8, '八张独立动画图集都必须延迟请求');
  assert.match(source, /animation\?\.load\([^;]*\);[\s\S]{0,100}?animation\?\.ready/, '仅在可见角色进入 drawActor 时启动动画加载');
  assert.match(source, /debugCollision:[^\n]+===\s*["']1["']/, '碰撞调试层只能由 ?debugCollision=1 显式开启');
  assert.match(source, /if\s*\(runtime\.debugCollision\)\s*\{\s*drawZoneLandmarks\(state, camera\);\s*drawObstacles\(state, camera\);\s*\}/, '粗路线、区域框与碰撞体必须位于调试开关内');
  assert.doesNotMatch(html, /<link\b[^>]*rel=["']preload["'][^>]*arena-v2\.webp/i, '旧竞技场图片不应继续预加载');
  assert.doesNotMatch(source, /if\s*\(defeated\s*&&\s*entity\.entityKind\s*===\s*["']enemy["']\)\s*return/, '敌人死亡后应播放 down 墓碑动画而不是立即跳过绘制');
  assert.match(source, /entity\.entityKind\s*===\s*["']enemy["'][^\n]+!defeated\)\s*drawEntityHealth/, '死亡墓碑不得继续显示血条');
});

test('手机探索美术仅预算当前地图、当前首领和有限瓦片', async () => {
  const commonAnimationNames = [
    'vanguard-anim-v3.png',
    'ranger-anim-v3.png',
    'crawler-anim-v4.png',
    'brute-anim-v4.png',
    'siren-anim-v4.png',
  ];
  const bossAnimationNames = [
    'fog-colossus-anim-v4.png',
    'lantern-regent-anim-v1.png',
    'tide-tortoise-anim-v1.png',
  ];
  let transferBytes = 0;
  let decodedBytes = 0;
  for (const name of commonAnimationNames) {
    const buffer = await readFile(path.join(assetsRoot, name));
    const { width, height } = imageSize(buffer);
    transferBytes += buffer.length;
    decodedBytes += width * height * 4;
  }
  const bossBudgets = await Promise.all(bossAnimationNames.map(async (name) => {
    const buffer = await readFile(path.join(assetsRoot, name));
    const { width, height } = imageSize(buffer);
    return { transfer: buffer.length, decoded: width * height * 4 };
  }));
  transferBytes += Math.max(...bossBudgets.map((budget) => budget.transfer));
  decodedBytes += Math.max(...bossBudgets.map((budget) => budget.decoded));

  for (let index = 0; index < 5; index += 1) {
    const row = Math.floor(index / 2);
    const column = index % 2;
    const map = await readFile(path.join(assetsRoot, 'world', 'stage-01', `ground-r${row}-c${column}-v6.webp`));
    const mapSize = imageSize(map);
    transferBytes += map.length;
    decodedBytes += mapSize.width * mapSize.height * 4;
    const mask = await readFile(path.join(assetsRoot, 'world', 'stage-01', `ambient-mask-r${row}-c${column}-v6.png`));
    const maskSize = imageSize(mask);
    transferBytes += mask.length;
    decodedBytes += maskSize.width * maskSize.height * 4;
  }
  for (const name of ['stage-01/surface-v6.webp', 'stage-01/foreground-v6.webp', 'stage-01/overview-v6.webp']) {
    const buffer = await readFile(path.join(assetsRoot, 'world', name));
    const { width, height } = imageSize(buffer);
    transferBytes += buffer.length;
    decodedBytes += width * height * 4;
  }

  assert.ok(transferBytes <= 10 * 1024 * 1024, `当前关地图与动画传输体积 ${transferBytes}B 超过 10MiB`);
  assert.ok(decodedBytes <= 52 * 1024 * 1024, `当前关地图与动画解码体积 ${decodedBytes}B 超过 52MiB`);
});
