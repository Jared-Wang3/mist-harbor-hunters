import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  appendSnapshot,
  computeCameraViewport,
  computeEdgeIndicator,
  interpolateSnapshot,
  isWorldPointVisible,
  predictLocalPosition,
  reconcileLocalPosition,
  resolveAnimationState,
  screenToWorld,
  selectAnimationFrame,
  selectCanvasDpr,
  updateFollowCamera,
  visibleTileRange,
  worldToScreen,
} from '../public/client-motion.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function snapshot(tick, serverTime, x) {
  return {
    tick,
    serverTime,
    arena: { width: 1600, height: 900 },
    players: [{ id: 'remote', x, y: 200, facing: { x: 1, y: 0 } }],
    enemies: [{ id: 'enemy', x: x + 100, y: 300 }],
    projectiles: [],
    effects: [],
  };
}

test('快照缓冲拒绝乱序状态，避免轮询覆盖实时状态', () => {
  const buffer = [];
  assert.equal(appendSnapshot(buffer, snapshot(10, 1_000, 100), 50), true);
  assert.equal(appendSnapshot(buffer, snapshot(9, 1_020, 80), 70), false);
  assert.equal(appendSnapshot(buffer, snapshot(10, 999, 90), 80), false);
  assert.equal(appendSnapshot(buffer, snapshot(11, 1_060, 116), 110), true);
  assert.deepEqual(buffer.map(({ state }) => state.tick), [10, 11]);
});

test('15Hz 网络快照可以在 60Hz 渲染帧之间平滑插值', () => {
  const buffer = [];
  appendSnapshot(buffer, snapshot(1, 1_000, 0), 100);
  appendSnapshot(buffer, snapshot(2, 1_100, 100), 200);

  const first = interpolateSnapshot(buffer, 200, 75);
  const second = interpolateSnapshot(buffer, 216.667, 75);
  const third = interpolateSnapshot(buffer, 233.334, 75);
  const positions = [first, second, third].map((state) => state.players[0].x);

  assert.ok(positions[0] > 0 && positions[0] < 100);
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
  assert.ok(Math.max(positions[1] - positions[0], positions[2] - positions[1]) < 20);
});

test('本地移动立即预测，并在静止时柔和收敛到权威位置', () => {
  const moved = predictLocalPosition(
    { x: 400, y: 400 },
    { move: { x: 1, y: 0 }, role: 'vanguard', dt: 1 / 60, radius: 24, arena: { width: 1600, height: 900 } },
  );
  assert.ok(moved.x > 404, '输入后的下一渲染帧就应看到角色移动');

  const reconciled = reconcileLocalPosition(moved, { x: moved.x + 20, y: moved.y }, { x: 0, y: 0 });
  assert.ok(reconciled.x > moved.x && reconciled.x < moved.x + 20, '小误差应渐进收敛而不是跳变');

  const snapped = reconcileLocalPosition(moved, { x: moved.x + 220, y: moved.y }, { x: 0, y: 0 });
  assert.equal(snapped.x, moved.x + 220, '大误差应立即服从服务器权威位置');

  const networkBehind = reconcileLocalPosition({ x: 700, y: 400 }, { x: 420, y: 400 }, { x: 1, y: 0 });
  assert.equal(networkBehind.x, 420, '预测领先超过上限时必须立即服从服务器权威位置');
});

test('stage transitions and teleports break the interpolation timeline', () => {
  const buffer = [];
  const active = snapshot(10, 1_000, 700);
  active.stage = { status: 'active' };
  appendSnapshot(buffer, active, 100);

  const resetting = snapshot(11, 1_050, 700);
  resetting.stage = { status: 'resetting' };
  appendSnapshot(buffer, resetting, 150);
  assert.equal(buffer.length, 1);

  const respawned = snapshot(12, 1_100, 100);
  respawned.stage = { status: 'resetting' };
  appendSnapshot(buffer, respawned, 200);
  assert.equal(buffer.length, 1);
  assert.equal(interpolateSnapshot(buffer, 250).players[0].x, 100);
});

test('客户端换关时清空旧地图插值并携带幂等换关令牌', async () => {
  const source = await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8');
  const handleSnapshot = source.match(/function handleSnapshot\(state\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function playersFrom/);
  const restartHunt = source.match(/async function restartHunt\(\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function leaveHunt/);

  assert.ok(handleSnapshot, '应保留独立快照入口');
  assert.match(handleSnapshot[1], /stageVisualKey|mapKey/, '快照入口应识别关卡地图身份');
  assert.match(handleSnapshot[1], /snapshotBuffer\.length\s*=\s*0/, '换关必须丢弃上一关插值快照');
  assert.match(handleSnapshot[1], /camera\s*=\s*null/, '换关必须重置旧地图镜头');
  assert.ok(restartHunt, '应保留统一结算动作入口');
  assert.match(restartHunt[1], /transitionToken/, '进入下一关必须携带服务端签发的幂等令牌');
  assert.match(source, /transitionInFlight/, '客户端应阻止同一结算按钮连续提交');
  assert.match(source, /立即重整/, '全灭结算仍应保留立即重整入口');
  assert.match(restartHunt[1], /recovering[\s\S]*?wipe/, '全灭重整不得错误要求换关令牌');
});

test('本地预测遵守矩形与圆形地标碰撞，持续输入也不会穿墙', () => {
  const arena = { width: 1200, height: 800, padding: 64 };
  const rectangle = { id: 'wall', shape: 'rect', x: 500, y: 180, width: 100, height: 360 };
  let position = { x: 450, y: 340 };
  for (let frame = 0; frame < 120; frame += 1) {
    position = predictLocalPosition(position, {
      move: { x: 1, y: 0 },
      role: 'vanguard',
      dt: 1 / 20,
      radius: 24,
      arena,
      obstacles: [rectangle],
    });
  }
  assert.ok(position.x <= rectangle.x - 24, `预测位置越过矩形墙面：${position.x}`);

  const circle = { id: 'tower', shape: 'circle', x: 400, y: 660, radius: 50 };
  position = { x: 290, y: 660 };
  for (let frame = 0; frame < 120; frame += 1) {
    position = predictLocalPosition(position, {
      move: { x: 1, y: 0 },
      role: 'ranger',
      dt: 1 / 20,
      radius: 24,
      arena,
      obstacles: [circle],
    });
  }
  assert.ok(position.x <= circle.x - circle.radius - 24, `预测位置越过圆形地标：${position.x}`);

  const atWorldEdge = predictLocalPosition(
    { x: 0, y: 0 },
    { move: { x: -1, y: -1 }, radius: 24, arena, obstacles: [] },
  );
  assert.deepEqual(atWorldEdge, { x: 88, y: 88 }, '客户端世界边界必须包含服务端的地图 padding');
});

test('粗指针手机限制 DPR，稳定渲染像素预算', () => {
  assert.equal(selectCanvasDpr(3, true), 1.5);
  assert.equal(selectCanvasDpr(2, false), 1.75);
  assert.equal(selectCanvasDpr(1, true), 1);
});

test('渲染循环不再每帧读取画布布局', async () => {
  const source = await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8');
  const renderFrame = source.match(/function renderFrame\(time\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function drawArena/);
  assert.ok(renderFrame, '应保留 requestAnimationFrame 渲染循环');
  assert.doesNotMatch(renderFrame[1], /resizeCanvas\s*\(/, '尺寸读取只应由 resize/observer 事件触发');
  assert.match(source, /interpolateSnapshot\s*\(/, '渲染应使用平滑后的状态');
  assert.match(source, /predictLocalPosition\s*\(/, '本地玩家应在服务器状态返回前先行预测');
  assert.match(source, /obstacles:\s*runtime\.snapshot\.obstacles/, '本地预测必须使用服务器快照中的地标碰撞体');
});

test('结算面板正确读取远征秒数并汇总击杀与救援', async () => {
  const source = await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8');
  const updateResult = source.match(/function updateResult\(result, state\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function chineseStage/);
  assert.ok(updateResult, '应保留独立的结算面板更新函数');
  assert.match(updateResult[1], /result\.elapsed\s*\?\?\s*state\.progress\?\.elapsed/, '新快照的 elapsed 秒数应用于结算时长');
  assert.match(updateResult[1], /playersFrom\(state\)\.reduce/, '旧快照缺少总数时应从玩家数据汇总');
  assert.match(updateResult[1], /player\.kills/, '击杀总数应汇总玩家 kills');
  assert.match(updateResult[1], /player\.revives/, '救援总数应汇总玩家 revives，缺省为 0');
  assert.doesNotMatch(updateResult[1], /resultRevives\.textContent\s*=\s*[^;]*["']--["']/, '救援数不应回退为 --');
});

test('大世界相机跟随玩家并在地图四边钳制', () => {
  const world = { width: 5120, height: 2880, padding: 64 };
  const viewport = { width: 1280, height: 720 };
  const corner = computeCameraViewport({ x: 10, y: 10, scale: 1 }, viewport, world);
  assert.equal(corner.left, 64);
  assert.equal(corner.top, 64);
  const followed = updateFollowCamera(corner, { x: 2800, y: 1600 }, 1 / 60, { world, viewport, scale: 1 });
  assert.ok(followed.x > corner.x && followed.x < 2800);
  assert.ok(followed.y > corner.y && followed.y < 1600);
  const farCorner = computeCameraViewport({ x: 9999, y: 9999, scale: 1 }, viewport, world);
  assert.equal(farCorner.right, world.width - world.padding);
  assert.equal(farCorner.bottom, world.height - world.padding);
});

test('世界坐标与屏幕坐标可往返，视口裁剪和可见瓦片正确', () => {
  const camera = computeCameraViewport({ x: 2500, y: 1400, scale: 1.25 }, { width: 1000, height: 600 }, { width: 5120, height: 2880 });
  const point = { x: 2718.5, y: 1284.25 };
  const screen = worldToScreen(point, camera);
  const roundTrip = screenToWorld(screen, camera);
  assert.ok(Math.abs(roundTrip.x - point.x) < 1e-9);
  assert.ok(Math.abs(roundTrip.y - point.y) < 1e-9);
  assert.equal(isWorldPointVisible(point, camera), true);
  assert.equal(isWorldPointVisible({ x: 1, y: 1 }, camera), false);
  const range = visibleTileRange(camera, 960, 720, { width: 5120, height: 2880 });
  assert.ok(range.endColumn >= range.startColumn);
  assert.ok(range.endRow >= range.startRow);
});

test('屏外目标被投影到画面边缘，画面内目标无需箭头', () => {
  const camera = computeCameraViewport({ x: 2000, y: 1400, scale: 1 }, { width: 1280, height: 720 }, { width: 5120, height: 2880 });
  assert.equal(computeEdgeIndicator({ x: 2000, y: 1400 }, camera), null);
  const right = computeEdgeIndicator({ x: 5000, y: 1400 }, camera, 40);
  assert.ok(right.x <= 1240 && right.x >= 1239);
  assert.ok(Math.abs(right.angle) < 0.001);
});

test('动作状态有明确优先级并输出 8 列 6 行动画帧', () => {
  assert.equal(resolveAnimationState({ action: 'attack' }, true), 'attack');
  assert.equal(resolveAnimationState({ action: 'attack', hurt: true }, true), 'hurt');
  assert.equal(resolveAnimationState({ action: 'attack', status: 'downed' }, true), 'down');
  assert.equal(resolveAnimationState({}, true), 'run');
  const frame = selectAnimationFrame({ action: 'attack' }, 350, { startedAt: 100, frameCount: 8 });
  assert.equal(frame.row, 2);
  assert.ok(frame.column >= 0 && frame.column < 8);
});
