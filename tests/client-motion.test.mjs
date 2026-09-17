import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  acknowledgePendingInput,
  advanceRangerShotPrediction,
  appendSnapshot,
  authorityLeadTolerance,
  computeCameraViewport,
  computeEdgeIndicator,
  interpolateSnapshot,
  isWorldPointVisible,
  localPredictionHorizonMs,
  predictLocalPosition,
  pruneProcessedInputs,
  queuePendingInput,
  reconcileLocalPosition,
  resolveAnimationState,
  screenToWorld,
  selectAnimationFrame,
  selectCanvasDpr,
  shouldSuppressBackwardCorrection,
  updateFollowCamera,
  visibleTileRange,
  worldToScreen,
} from '../public/client-motion.mjs';
import { GameState } from '../src/game-state.mjs';

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

  const staleAuthority = reconcileLocalPosition(
    { x: 700, y: 400 },
    { x: 519, y: 420 },
    { x: 1, y: 0 },
    360,
    { suppressBackwardCorrection: true },
  );
  assert.equal(staleAuthority.x, 700, '持续移动时不应沿移动方向回拉到高延迟旧位置');
  assert.ok(staleAuthority.y > 400 && staleAuthority.y < 420, '横向权威误差仍应渐进纠正');

  const turningAfterGap = reconcileLocalPosition(
    { x: 700, y: 400 },
    { x: 519, y: 400 },
    { x: 0, y: 1 },
    360,
    { suppressBackwardCorrection: true, maxCorrection: 9 },
  );
  const lateralCorrection = 700 - turningAfterGap.x;
  assert.ok(lateralCorrection > 0, '转向后仍应保留真实横向碰撞与权威纠偏');
  assert.ok(lateralCorrection <= 9.001, `高 RTT 直角转向单帧横跳不应超过 9px，实际 ${lateralCorrection.toFixed(2)}px`);

  for (const angle of [90, 105, 120, 135, 150, 165, 180]) {
    const radians = angle * Math.PI / 180;
    const move = { x: Math.cos(radians), y: Math.sin(radians) };
    const turned = reconcileLocalPosition(
      { x: 700, y: 400 },
      { x: 519, y: 400 },
      move,
      360,
      {
        suppressBackwardCorrection: true,
        maxCorrection: 9,
      },
    );
    const correction = Math.hypot(turned.x - 700, turned.y - 400);
    assert.ok(correction > 0 && correction <= 9.001, `${angle}° 渐进转向不能把旧滞后变成 ${correction.toFixed(2)}px 前冲`);
  }

  const ordinaryCatchUp = reconcileLocalPosition(
    { x: 500, y: 400 },
    { x: 530, y: 400 },
    { x: 1, y: 0 },
    360,
    { suppressBackwardCorrection: true, maxCorrection: 9 },
  );
  assert.ok(ordinaryCatchUp.x > 506, '正常同向前方权威纠偏不应被转向保护误限速');

  const stoppedAfterGap = reconcileLocalPosition(
    { x: 700, y: 400 },
    { x: 519, y: 400 },
    { x: 0, y: 0 },
    360,
    { suppressBackwardCorrection: true },
  );
  assert.ok(stoppedAfterGap.x < 700 && stoppedAfterGap.x > 519, '松开移动后仍应向权威位置收敛');
});

test('输入已获权威确认后，持续移动也会收敛服务端碰撞位移', () => {
  assert.equal(shouldSuppressBackwardCorrection({
    moving: true,
    hasProcessedInputSeq: false,
    pendingInputCount: 0,
  }), true, '旧协议没有确认序号时应继续保护移动预测');
  assert.equal(shouldSuppressBackwardCorrection({
    moving: true,
    hasProcessedInputSeq: true,
    pendingInputs: [{ move: { x: 1, y: 0 } }],
    confirmedMove: { x: 1, y: 0 },
  }), false, '现代快照应使用网络领先容差，而不是因刷新输入永久关闭碰撞纠偏');
  assert.equal(shouldSuppressBackwardCorrection({
    moving: true,
    hasProcessedInputSeq: true,
    pendingInputs: [{ move: { x: 0, y: 1 } }],
    confirmedMove: { x: 1, y: 0 },
  }), true, '尚未确认的转向不能被旧方向快照向后拉扯');
  assert.equal(shouldSuppressBackwardCorrection({
    moving: true,
    hasProcessedInputSeq: true,
    pendingInputs: [{ move: { x: 1, y: 0 }, dodge: true }],
    confirmedMove: { x: 1, y: 0 },
  }), true, '尚未确认的闪避不能参与普通移动纠偏');
  assert.equal(shouldSuppressBackwardCorrection({
    moving: true,
    hasProcessedInputSeq: true,
    pendingInputCount: 0,
  }), false, '全部输入已确认后必须允许服务端碰撞位移回收误差');

  let predicted = { x: 64.1, y: 0 };
  let authoritative = { x: 0, y: 0 };
  for (let tick = 0; tick < 240; tick += 1) {
    predicted.x += 4;
    authoritative.x += 4;
    predicted = reconcileLocalPosition(
      predicted,
      authoritative,
      { x: 1, y: 0 },
      300.5,
      {
        suppressBackwardCorrection: shouldSuppressBackwardCorrection({
          moving: true,
          hasProcessedInputSeq: true,
          pendingInputs: [],
          confirmedMove: { x: 1, y: 0 },
        }),
        maxCorrection: 9,
      },
    );
  }
  assert.ok(
    Math.abs(predicted.x - authoritative.x) < 0.01,
    `服务端分离造成的预测误差应在持续移动中收敛，实际仍差 ${Math.abs(predicted.x - authoritative.x).toFixed(2)}px`,
  );

  const speed = 245;
  const frameDistance = speed / 60;
  const leadTolerance = authorityLeadTolerance(speed, 407);
  const worstAuthorityLead = speed * (407 + 77) / 1000;
  const simulateWeakNetwork = (collisionOffset) => {
    let serverX = 0;
    let visualX = collisionOffset;
    let previousVisualX = visualX;
    let smallestFrameDelta = Infinity;
    for (let frame = 1; frame <= 180; frame += 1) {
      serverX += frameDistance;
      visualX += frameDistance;
      if (frame % 4 === 0) {
        visualX = reconcileLocalPosition(
          { x: visualX, y: 0 },
          { x: serverX - worstAuthorityLead, y: 0 },
          { x: 1, y: 0 },
          300.5,
          {
            backwardTolerance: leadTolerance,
            maxBackwardCorrection: 2,
            maxCorrection: 9,
          },
        ).x;
      }
      smallestFrameDelta = Math.min(smallestFrameDelta, visualX - previousVisualX);
      previousVisualX = visualX;
    }
    return { error: visualX - serverX, smallestFrameDelta };
  };
  const normalWeakNetwork = simulateWeakNetwork(0);
  const collidedWeakNetwork = simulateWeakNetwork(64.1);
  assert.ok(
    Math.abs(collidedWeakNetwork.error) < 11,
    `407ms RTT 下碰撞增量仍残留 ${collidedWeakNetwork.error.toFixed(2)}px`,
  );
  assert.ok(
    Math.abs(collidedWeakNetwork.error - normalWeakNetwork.error) < 0.5,
    '服务端碰撞增量应收敛回正常弱网预测基线',
  );
  assert.ok(
    Math.min(normalWeakNetwork.smallestFrameDelta, collidedWeakNetwork.smallestFrameDelta) > 0,
    '弱网纠偏不能让持续前进出现反向跳帧',
  );
});

test('枪手只在服务端射击减速计时内降低移动速度', () => {
  const options = {
    move: { x: 1, y: 0 },
    role: 'ranger',
    dt: 0.05,
    radius: 21,
    arena: { width: 1600, height: 900 },
  };
  const origin = { x: 400, y: 400 };
  const running = predictLocalPosition(origin, options);
  const holdingAttack = predictLocalPosition(origin, { ...options, attacking: true });
  assert.equal(holdingAttack.x, running.x, '按住攻击键不能让枪手在整个冷却周期持续减速');
  const firing = predictLocalPosition(origin, { ...options, shotSlowRemaining: 0.12 });
  assert.ok(Math.abs((firing.x - origin.x) / (running.x - origin.x) - 0.65) < 1e-9);

  const vanguardRunning = predictLocalPosition(origin, { ...options, role: 'vanguard' });
  const vanguardAttacking = predictLocalPosition(origin, { ...options, role: 'vanguard', attacking: true });
  assert.equal(vanguardAttacking.x, vanguardRunning.x, '重刃普通攻击不应继承枪手的开火移速惩罚');
  const vanguardGuarding = predictLocalPosition(origin, { ...options, role: 'vanguard', guarding: true });
  assert.ok(Math.abs((vanguardGuarding.x - origin.x) / (vanguardRunning.x - origin.x) - 0.65) < 1e-9);
});

test('枪手持续边跑边射击时本地计时不会累计显著权威位移误差', async () => {
  const game = new GameState({ code: 'SHOTSYNC', mode: 'coop', rng: () => 0.2 });
  game.addPlayer({ id: 'vanguard', name: '重刃', role: 'vanguard' });
  game.addPlayer({ id: 'ranger', name: '枪手', role: 'ranger' });
  game.phaseIndex = 1;
  game._startStage({ resetProgress: false });
  game.enemies.clear();
  for (const zoneId of game.encounterQueues.keys()) game.encounterQueues.set(zoneId, []);
  const vanguard = game.players.get('vanguard');
  const ranger = game.players.get('ranger');
  vanguard.x = 500;
  vanguard.y = 500;
  ranger.x = 2950;
  ranger.y = 500;
  const startingX = ranger.x;
  game.setInput('ranger', {
    move: { x: -1, y: 0 },
    aim: { x: -1, y: 0 },
    attack: true,
    interact: false,
    dodge: false,
    skill: false,
  }, 1);

  for (let tick = 0; tick < 150; tick += 1) game.update(1 / 30);

  let predicted = { x: startingX, y: ranger.y };
  let shotPrediction = {};
  for (let frame = 0; frame < 300; frame += 1) {
    shotPrediction = advanceRangerShotPrediction(shotPrediction, {
      attacking: true,
      now: frame * (1000 / 60),
    });
    predicted = predictLocalPosition(predicted, {
      move: { x: -1, y: 0 },
      role: 'ranger',
      shotSlowRemaining: shotPrediction.shotSlowRemaining,
      dt: 1 / 60,
      radius: 21,
      arena: { width: 5120, height: 2880, padding: 64 },
      movementZones: game.phase.movementZones,
    });
  }

  const error = Math.abs(predicted.x - ranger.x);
  assert.ok(error < 12, `连续跑射 5 秒后本地与权威误差不应累计，实际 ${error.toFixed(2)}px`);
  assert.ok(ranger.x - (startingX - 260 * 0.92 * 5) > 180, '若不预测每枪减速，旧实现会累计数百像素领先');
  const source = await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8');
  assert.match(source, /advanceRangerShotPrediction\(runtime\.rangerShotPrediction/, '渲染预测必须接入逐枪本地减速计时');
});

test('闪避预测立即使用服务端冲刺速度且仍遵守碰撞与边界', () => {
  const arena = { width: 1200, height: 800, padding: 64 };
  const origin = { x: 300, y: 400 };
  const dashed = predictLocalPosition(origin, {
    move: { x: 1, y: 0 },
    dodgeVector: { x: 1, y: 0 },
    dodgeRemaining: 0.19,
    role: 'vanguard',
    dt: 0.05,
    radius: 24,
    arena,
  });
  assert.ok(Math.abs(dashed.x - origin.x - 610 * 0.05) < 1e-9, '闪避首帧应按 610 速度预测');

  const wall = { id: 'wall', shape: 'rect', x: 500, y: 180, width: 100, height: 360 };
  let position = { x: 460, y: 340 };
  for (let frame = 0; frame < 12; frame += 1) {
    position = predictLocalPosition(position, {
      move: { x: 1, y: 0 },
      dodgeVector: { x: 1, y: 0 },
      dodgeRemaining: 0.19,
      role: 'vanguard',
      dt: 0.05,
      radius: 24,
      arena,
      obstacles: [wall],
    });
  }
  assert.ok(position.x <= wall.x - 24, `闪避预测越过矩形墙面：${position.x}`);

  const atWorldEdge = predictLocalPosition(
    { x: 90, y: 90 },
    {
      move: { x: -1, y: -1 },
      dodgeVector: { x: -1, y: -1 },
      dodgeRemaining: 0.19,
      role: 'vanguard',
      dt: 0.05,
      radius: 24,
      arena,
    },
  );
  assert.deepEqual(atWorldEdge, { x: 88, y: 88 }, '闪避预测不能越过世界 padding');
});

test('407ms RTT 与 696ms 快照空洞期间持续移动不会在 260ms 后硬回拉冻结', async () => {
  const source = (await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8')).replace(/\r\n?/g, '\n');
  const renderFrame = source.match(/function renderFrame\(time\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function drawArena/);
  assert.ok(renderFrame, '应保留 requestAnimationFrame 渲染循环');
  assert.doesNotMatch(
    renderFrame[1],
    /snapshotAge\s*>\s*MAX_LOCAL_PREDICTION_LEAD_MS[\s\S]*?reconcileLocalPosition\([^;]+,\s*1\)/,
    '弱网快照空洞期间不能每帧硬拉回同一份旧快照',
  );
  assert.match(renderFrame[1], /localPredictionHorizonMs\(runtime\.rtt\)/, '预测窗口应根据实测 RTT 覆盖 696ms 空洞');
});

test('客户端消费输入 ACK，并等快照确认 lastProcessedInputSeq 后清理待确认输入', async () => {
  const source = (await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8')).replace(/\r\n?/g, '\n');
  const handleAck = source.match(/function handleInputAck\(acknowledgement[\s\S]*?\{([\s\S]*?)\n\s*\}\n\n\s*function connectWebSocket/);
  assert.match(source, /parsed\?\.type\s*===\s*["']ack["'][\s\S]*?handleInputAck\(parsed\)/, 'WebSocket ACK 必须进入输入确认处理');
  assert.match(source, /pendingInputs/, '客户端应维护待确认输入队列');
  assert.match(source, /lastProcessedInputSeq/, '权威快照应按最后处理的输入序号推进确认水位');
  assert.ok(handleAck);
  assert.match(handleAck[1], /idempotentRetry\s*\|\|\s*pending\?\.idempotentRetryPending/, 'WS 原 seq 重投的 false ACK 也必须按幂等确认处理');
});

test('键盘与触控闪避共用即时锁存，并在服务器回包前执行本地冷却', async () => {
  const source = (await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8')).replace(/\r\n?/g, '\n');
  const beginDodge = source.match(/function beginLocalDodge\(\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function onKeyDown/);
  assert.ok(beginDodge, '应保留本地闪避锁存入口');
  assert.match(beginDodge[1], /localDodgeUntil/, '按下闪避后应立即启动 0.19 秒本地冲刺');
  assert.match(beginDodge[1], /localDodgeCooldownUntil/, '服务器回包前应阻止假二次闪避');
  assert.match(source, /property\s*===\s*["']dodge["'][\s\S]*?beginLocalDodge\(\)/, '触控闪避也必须走同一即时锁存入口');
  const stationaryDirection = beginDodge[1].slice(beginDodge[1].indexOf('if (length <= 0.1)'));
  assert.ok(
    stationaryDirection.indexOf('controls.aim') >= 0
      && stationaryDirection.indexOf('controls.aim') < stationaryDirection.indexOf('local.facing'),
    '静止闪避应优先使用本次最新 input.aim，再回退到旧快照 facing',
  );
});

test('WS 断线前未 ACK 的 one-shot 使用原序号幂等重投', async () => {
  const motion = await import('../public/client-motion.mjs');
  assert.equal(typeof motion.pendingOneShotRetry, 'function', '应能从待确认队列选出可幂等重投的 one-shot');

  const pending = [];
  queuePendingInput(pending, {
    seq: 201,
    move: { x: 1, y: 0 },
    aim: { x: 0, y: -1 },
    dodge: true,
    skill: false,
  }, 1_000);
  queuePendingInput(pending, {
    seq: 202,
    move: { x: 1, y: 0 },
    aim: { x: 0, y: -1 },
    dodge: false,
    skill: true,
  }, 1_050);
  acknowledgePendingInput(pending, { seq: 202, accepted: true });

  const retry = motion.pendingOneShotRetry(pending, 200);
  assert.equal(retry?.seq, 201, '未 ACK 的闪避必须复用原 seq，避免 ACK 丢失时重复执行');
  assert.equal(retry?.dodge, true);
  assert.deepEqual(retry?.move, { x: 1, y: 0 }, '重投必须保留断线前原始移动，不能混入切换后的 held input');
  assert.deepEqual(retry?.aim, { x: 0, y: -1 }, '重投必须保留触发闪避时的原始 aim');
  assert.equal(motion.pendingOneShotRetry(pending, 201), null, '快照水位已处理的动作不得重投');
});

test('WS 切换 fallback 会绕过签名去重立即刷新 held input', async () => {
  const motion = await import('../public/client-motion.mjs');
  assert.equal(typeof motion.shouldSendInput, 'function', '输入去重应提供显式强制刷新入口');
  assert.equal(motion.shouldSendInput('held', 'held', 100, false), false);
  assert.equal(motion.shouldSendInput('held', 'held', 100, true), true, '传输切换不能等待 450ms 去重窗口');

  const source = (await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8')).replace(/\r\n?/g, '\n');
  const startLegacy = source.match(/function startLegacyTransport\(\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function stopLegacyTransport/);
  const sendInputSource = source.match(/async function sendInput\(\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function roundInput/);
  assert.ok(startLegacy, '应保留 fallback 传输入口');
  assert.ok(sendInputSource, '应保留统一输入发送入口');
  assert.match(startLegacy[1], /forceInputRefresh\s*=\s*true/, '切换 fallback 时必须标记下一份 held input 强制发送');
  assert.match(sendInputSource[1], /pendingOneShotRetry/, 'fallback 必须检查断线前未确认的 one-shot');
  assert.match(sendInputSource[1], /retryInput\.idempotentRetryPending\s*=\s*true/, '原 seq 重投必须标记后续 WS ACK 为幂等确认');
  assert.match(
    sendInputSource[1],
    /retryInput\s*\?[\s\S]*?move:\s*\{\s*\.\.\.retryInput\.move\s*\}[\s\S]*?aim:\s*\{\s*\.\.\.retryInput\.aim\s*\}/,
    '同 seq 重投必须使用 pending entry 的完整原始输入，再另发最新 held input',
  );
});

test('fallback HTTP 仍在飞行时恢复的 WebSocket 不受 HTTP 锁阻断', async () => {
  const source = (await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8')).replace(/\r\n?/g, '\n');
  const sendInputSource = source.match(/async function sendInput\(\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function roundInput/);
  assert.ok(sendInputSource, '应保留统一输入发送入口');
  assert.match(
    sendInputSource[1],
    /if\s*\(\s*!realtime\s*&&\s*runtime\.inputInFlight\s*\)\s*return/,
    'HTTP in-flight 锁只能阻断 fallback，WebSocket 恢复后必须继续实时发送',
  );
  assert.doesNotMatch(
    sendInputSource[1],
    /if\s*\(\s*runtime\.inputInFlight\s*\)\s*return/,
    '不能用全局 HTTP 锁阻断已恢复的 WebSocket',
  );
});

test('换关、离开与新会话用 generation 和 request token 隔离旧输入请求', async () => {
  const source = (await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8')).replace(/\r\n?/g, '\n');
  const enterSession = source.match(/async function enterSession\(data, mode\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*async function restoreStoredSession/);
  const handleSnapshot = source.match(/function handleSnapshot\(state\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function playersFrom/);
  const leaveHunt = source.match(/function leaveHunt\(\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*async function copyRoomCode/);
  const sendInputSource = source.match(/async function sendInput\(\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function roundInput/);
  assert.ok(enterSession && handleSnapshot && leaveHunt && sendInputSource);
  assert.match(source, /inputRequestGeneration/, '运行时必须维护输入请求 generation');
  assert.match(source, /inputRequestToken/, '每个 HTTP 输入请求必须有独立 token');
  assert.match(enterSession[1], /invalidateInputRequests\(\)/, '新会话必须隔离旧请求完成回调');
  assert.match(handleSnapshot[1], /stageVisualKey[\s\S]*?invalidateInputRequests\(\)/, '换关必须隔离旧请求完成回调');
  assert.match(leaveHunt[1], /invalidateInputRequests\(\)/, '离开必须隔离旧请求完成回调');
  assert.match(
    sendInputSource[1],
    /requestGeneration[\s\S]*?requestToken[\s\S]*?inputRequestIsCurrent/,
    '旧请求响应、错误与 finally 改状态前必须校验 generation、token 和会话身份',
  );
});

test('输入确认队列只在 ACK 后标记，并由权威处理序号清理', () => {
  const pending = [];
  queuePendingInput(pending, { seq: 101, move: { x: 1, y: 0 }, attack: false }, 1_000);
  queuePendingInput(pending, { seq: 102, move: { x: 0, y: 1 }, attack: true }, 1_050);
  assert.deepEqual(pending.map(({ seq, acknowledged }) => [seq, acknowledged]), [[101, false], [102, false]]);

  assert.equal(acknowledgePendingInput(pending, { seq: 101, accepted: true }), true);
  assert.equal(pending[0].acknowledged, true);
  assert.equal(pruneProcessedInputs(pending, 101), 1);
  assert.deepEqual(pending.map(({ seq }) => seq), [102]);

  assert.equal(acknowledgePendingInput(pending, { seq: 102, accepted: false }), false);
  assert.equal(pending.length, 0, '被服务端拒绝的输入不应继续参与预测');
});

test('实测 407ms RTT 的本地预测窗口覆盖 696ms 快照空洞', () => {
  assert.ok(localPredictionHorizonMs(407) > 696);
  assert.ok(localPredictionHorizonMs(0) >= 900, '首次 RTT 探测完成前也应覆盖已观测空洞');
  assert.ok(localPredictionHorizonMs(10_000) <= 2_000, '失联时预测窗口仍需有明确上限');
});

test('本地预测同步水地减速与风区轻推', () => {
  const polygon = [[[300, 300], [500, 300], [500, 500], [300, 500]]];
  const origin = { x: 400, y: 400 };
  const base = {
    role: 'ranger',
    dt: 0.05,
    radius: 21,
    arena: { width: 1600, height: 900 },
  };
  const running = predictLocalPosition(origin, { ...base, move: { x: 1, y: 0 } });
  const slowed = predictLocalPosition(origin, {
    ...base,
    move: { x: 1, y: 0 },
    movementZones: [{ kind: 'slow', multiplier: 0.82, polygons: polygon }],
  });
  assert.ok(Math.abs((slowed.x - origin.x) / (running.x - origin.x) - 0.82) < 1e-9);

  const wind = predictLocalPosition(origin, {
    ...base,
    move: { x: 0, y: 0 },
    movementZones: [{ kind: 'wind', multiplier: 0.88, vector: { x: 1, y: 0 }, polygons: polygon }],
  });
  assert.ok(Math.abs(wind.x - origin.x - 260 * 0.18 * 0.05) < 1e-9);
  assert.equal(wind.y, origin.y);
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
  const source = (await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8')).replace(/\r\n?/g, '\n');
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

test('本地预测沿可行走边界滑动，不会先穿进深水再等待服务器回拉', () => {
  const arena = { width: 600, height: 600, padding: 0 };
  const walkablePolygons = [{
    id: 'test-island',
    points: [[100, 100], [500, 100], [500, 500], [100, 500]],
  }];
  let position = { x: 150, y: 130 };
  for (let frame = 0; frame < 60; frame += 1) {
    position = predictLocalPosition(position, {
      move: { x: 1, y: -1 },
      role: 'vanguard',
      dt: 1 / 30,
      radius: 24,
      arena,
      obstacles: [],
      walkablePolygons,
    });
  }

  assert.ok(position.x > 300, `角色碰到岸线后仍应沿岸滑动：${position.x}`);
  assert.ok(position.y >= 124, `角色圆形碰撞体不应越出陆地：${position.y}`);
});

test('本地预测把相邻多边形视为联集，不会在内部接缝制造隐形墙', () => {
  const arena = { width: 240, height: 200, padding: 0 };
  const walkablePolygons = [
    { id: 'left', points: [[20, 20], [120, 20], [120, 180], [20, 180]] },
    { id: 'right', points: [[100, 20], [220, 20], [220, 180], [100, 180]] },
  ];
  const walkableBoundarySegments = [
    { ax: 20, ay: 20, bx: 220, by: 20 },
    { ax: 220, ay: 20, bx: 220, by: 180 },
    { ax: 220, ay: 180, bx: 20, by: 180 },
    { ax: 20, ay: 180, bx: 20, by: 20 },
  ];
  let position = { x: 80, y: 100 };
  for (let frame = 0; frame < 60; frame += 1) {
    position = predictLocalPosition(position, {
      move: { x: 1, y: 0 },
      role: 'vanguard',
      dt: 1 / 30,
      radius: 10,
      arena,
      obstacles: [],
      walkablePolygons,
      walkableBoundarySegments,
    });
  }
  assert.ok(position.x > 120, `角色必须能穿过联集内部接缝：${position.x}`);
  assert.ok(position.x <= 210.001, `角色必须停在联集真实外边界：${position.x}`);
});

test('粗指针手机限制 DPR，稳定渲染像素预算', () => {
  assert.equal(selectCanvasDpr(3, true), 1.5);
  assert.equal(selectCanvasDpr(2, false), 1.75);
  assert.equal(selectCanvasDpr(1, true), 1);
});

test('渲染循环不再每帧读取画布布局', async () => {
  const source = (await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8')).replace(/\r\n?/g, '\n');
  const renderFrame = source.match(/function renderFrame\(time\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*function drawArena/);
  assert.ok(renderFrame, '应保留 requestAnimationFrame 渲染循环');
  assert.doesNotMatch(renderFrame[1], /resizeCanvas\s*\(/, '尺寸读取只应由 resize/observer 事件触发');
  assert.match(source, /interpolateSnapshot\s*\(/, '渲染应使用平滑后的状态');
  assert.match(source, /predictLocalPosition\s*\(/, '本地玩家应在服务器状态返回前先行预测');
  assert.match(source, /obstacles:\s*runtime\.snapshot\.obstacles/, '本地预测必须使用服务器快照中的地标碰撞体');
});

test('结算面板正确读取远征秒数并汇总击杀与救援', async () => {
  const source = (await readFile(path.join(projectRoot, 'public', 'app.js'), 'utf8')).replace(/\r\n?/g, '\n');
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
  assert.equal(resolveAnimationState({ action: 'skill' }, false), 'special');
  const frame = selectAnimationFrame({ action: 'attack' }, 350, { startedAt: 100, frameCount: 8 });
  assert.equal(frame.row, 2);
  assert.ok(frame.column >= 0 && frame.column < 8);
});
