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
  assert.match(source, /map-r/, '地图瓦片路径应按行列生成');
  assert.match(source, /stageTileCache|tileCache/, '客户端应维护有限地图瓦片缓存');
  assert.match(source, /(?:\.delete\(|\.clear\(\))/, '换关或离开视野后应释放旧瓦片引用');
  assert.doesNotMatch(source, /world-map-v4\.webp/, '旧的单张放大背景不应继续作为生产地图');
});

test('正常游戏画面用位图地形表现权威碰撞体，而非只在调试模式显示', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');

  assert.match(source, /terrain-common-v1\.webp/, '应加载三关共用的透明地形图集');
  assert.match(source, /function\s+drawTerrainObstacle\s*\(/, '应有独立的可见地形绘制函数');
  assert.match(source, /visualKind/, '地形图集选择应由服务端权威碰撞体的 visualKind 驱动');
  assert.match(source, /entityKind:\s*[\"']terrain[\"']/, '可碰撞地形应进入世界 y 轴排序，而不是永远压在角色脚下');
  assert.match(source, /drawTerrainObstacle\s*\(/, '生产渲染路径必须实际绘制地形');
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
  assert.match(source, /animation\?\.load\(\);[\s\S]{0,80}?animation\?\.ready/, '仅在可见角色进入 drawActor 时启动动画加载');
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
    const map = await readFile(path.join(assetsRoot, 'world', 'stage-01', `map-r${row}-c${column}-v5.webp`));
    const mapSize = imageSize(map);
    transferBytes += map.length;
    decodedBytes += mapSize.width * mapSize.height * 4;
  }
  for (const name of ['terrain-common-v1.webp', 'stage-01/overview-v5.webp']) {
    const buffer = await readFile(path.join(assetsRoot, 'world', name));
    const { width, height } = imageSize(buffer);
    transferBytes += buffer.length;
    decodedBytes += width * height * 4;
  }

  assert.ok(transferBytes <= 10 * 1024 * 1024, `当前关地图与动画传输体积 ${transferBytes}B 超过 10MiB`);
  assert.ok(decodedBytes <= 52 * 1024 * 1024, `当前关地图与动画解码体积 ${decodedBytes}B 超过 52MiB`);
});
