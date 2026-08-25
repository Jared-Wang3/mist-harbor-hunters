import { chromium } from 'file:///C:/Users/wjm19/.gstack/repos/gstack/node_modules/playwright/index.mjs';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = 'http://127.0.0.1:4317';
const outputDir = resolve('art-source/qa-exploration-v4-20260813');
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const assetNames = [
  'world-map-v4.webp',
  'vanguard-anim-v3.png',
  'ranger-anim-v3.png',
  'crawler-anim-v4.png',
  'brute-anim-v4.png',
  'siren-anim-v4.png',
  'fog-colossus-anim-v4.png',
];

const report = {
  runAt: new Date().toISOString(),
  baseUrl,
  desktop: {},
  mobile: {},
  coop: {},
};

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
  return { status: response.status, json };
}

async function getState(session) {
  const response = await fetch(`${baseUrl}/api/rooms/${session.roomCode}/state?token=${encodeURIComponent(session.token)}`);
  const json = await response.json();
  if (!response.ok) throw new Error(`state: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function playerFrom(state, playerId) {
  const players = Array.isArray(state.players) ? state.players : Object.values(state.players || {});
  return players.find((player) => player.id === playerId);
}

function attachDiagnostics(page, bucket) {
  bucket.console = [];
  bucket.pageErrors = [];
  bucket.requestFailures = [];
  bucket.httpErrors = [];
  bucket.responses = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      bucket.console.push({ type: message.type(), text: message.text() });
    }
  });
  page.on('pageerror', (error) => bucket.pageErrors.push(String(error?.stack || error)));
  page.on('requestfailed', (request) => bucket.requestFailures.push({ url: request.url(), error: request.failure()?.errorText || 'unknown' }));
  page.on('response', (response) => {
    const url = response.url();
    if (url.startsWith(baseUrl)) bucket.responses.push({ url, status: response.status() });
    if (response.status() >= 400) bucket.httpErrors.push({ url, status: response.status() });
  });
}

async function startSolo(page, name) {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#hunterName').fill(name);
  await page.locator('#soloBtn').click();
  await page.waitForSelector('#gameView:not([hidden])', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('#roomCodeDisplay')?.textContent?.trim() !== '------');
  await page.waitForTimeout(1_400);
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('mistharbor.session.v1')));
}

async function holdKeys(page, keys, milliseconds) {
  for (const key of keys) await page.keyboard.down(key);
  try {
    await page.waitForTimeout(milliseconds);
  } finally {
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
  }
  await page.waitForTimeout(350);
}

async function inspectAssets(page) {
  return page.evaluate(async (names) => {
    const results = {};
    for (const name of names) {
      const image = new Image();
      image.src = `assets/${name}`;
      try {
        await image.decode();
        results[name] = {
          loaded: true,
          width: image.naturalWidth,
          height: image.naturalHeight,
        };
        if (/anim-/.test(name)) {
          const columns = 8;
          const rows = 6;
          const sw = Math.floor(image.naturalWidth / columns);
          const sh = Math.floor(image.naturalHeight / rows);
          const canvas = document.createElement('canvas');
          canvas.width = sw;
          canvas.height = sh;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const rowDiffs = [];
          for (let row = 0; row < rows; row += 1) {
            ctx.clearRect(0, 0, sw, sh);
            ctx.drawImage(image, 0, row * sh, sw, sh, 0, 0, sw, sh);
            const a = ctx.getImageData(0, 0, sw, sh).data;
            ctx.clearRect(0, 0, sw, sh);
            ctx.drawImage(image, sw, row * sh, sw, sh, 0, 0, sw, sh);
            const b = ctx.getImageData(0, 0, sw, sh).data;
            let changedPixels = 0;
            for (let i = 0; i < a.length; i += 4) {
              if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]) > 12) changedPixels += 1;
            }
            rowDiffs.push({ row, changedPixels, ratio: changedPixels / (sw * sh) });
          }
          results[name].cell = { width: sw, height: sh };
          results[name].rowFrameDiffs = rowDiffs;
        }
      } catch (error) {
        results[name] = { loaded: false, error: String(error) };
      }
    }
    return results;
  }, assetNames);
}

async function inspectMapPatches(page) {
  return page.evaluate(async () => {
    const image = new Image();
    image.src = 'assets/world-map-v4.webp';
    await image.decode();
    const columns = 4;
    const rows = 3;
    const sample = 48;
    const canvas = document.createElement('canvas');
    canvas.width = sample;
    canvas.height = sample;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const hashes = [];
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        ctx.clearRect(0, 0, sample, sample);
        const sw = image.naturalWidth / columns;
        const sh = image.naturalHeight / rows;
        ctx.drawImage(image, x * sw, y * sh, sw, sh, 0, 0, sample, sample);
        const pixels = ctx.getImageData(0, 0, sample, sample).data;
        let hash = 2166136261;
        for (let i = 0; i < pixels.length; i += 17) {
          hash ^= pixels[i];
          hash = Math.imul(hash, 16777619);
        }
        hashes.push((hash >>> 0).toString(16));
      }
    }
    return { patches: hashes.length, uniqueHashes: new Set(hashes).size, hashes };
  });
}

function intersects(a, b) {
  if (!a || !b) return false;
  return Math.max(a.left, b.left) < Math.min(a.right, b.right)
    && Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
}

async function inspectMobileLayout(page) {
  const layout = await page.evaluate(() => {
    const selectors = {
      topbar: '.game-topbar',
      canvasFrame: '#canvasFrame',
      mobileControls: '#mobileControls',
      moveStick: '#moveStick',
      aimStick: '#aimStick',
      touchDodge: '#touchDodge',
      touchInteract: '#touchInteract',
      objective: '.objective-card',
      exploration: '.exploration-hud',
      party: '.party-hud',
      orientationHint: '.orientation-hint',
    };
    const result = {};
    for (const [key, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      const style = element ? getComputedStyle(element) : null;
      const rect = element?.getBoundingClientRect();
      result[key] = element ? {
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        insideViewport: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      } : null;
    }
    result.viewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, coarse: matchMedia('(pointer: coarse)').matches };
    return result;
  });
  const pairs = [
    ['moveStick', 'aimStick'],
    ['mobileControls', 'party'],
    ['mobileControls', 'objective'],
    ['mobileControls', 'exploration'],
    ['objective', 'exploration'],
    ['party', 'exploration'],
  ];
  layout.overlaps = Object.fromEntries(pairs.map(([a, b]) => [`${a}:${b}`, intersects(layout[a], layout[b])]));
  return layout;
}

const browser = await chromium.launch({ headless: true, executablePath: chromePath });
try {
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const desktopPage = await desktopContext.newPage();
  attachDiagnostics(desktopPage, report.desktop);
  const desktopSession = await startSolo(desktopPage, 'QA桌面猎人');
  report.desktop.session = { roomCode: desktopSession.roomCode, playerId: desktopSession.playerId, role: desktopSession.role };
  report.desktop.assets = await inspectAssets(desktopPage);
  report.desktop.mapPatchAudit = await inspectMapPatches(desktopPage);

  let state = await getState(desktopSession);
  let player = playerFrom(state, desktopSession.playerId);
  report.desktop.initial = { x: player.x, y: player.y, hp: player.hp, area: await desktopPage.locator('#areaName').textContent() };
  await desktopPage.screenshot({ path: resolve(outputDir, 'desktop-initial.png') });
  const initialCanvas = await desktopPage.locator('#gameCanvas').screenshot({ path: resolve(outputDir, 'desktop-initial-canvas.png') });
  report.desktop.initial.canvasHash = digest(initialCanvas);

  await holdKeys(desktopPage, ['a'], 420);
  await holdKeys(desktopPage, ['w'], 1_350);
  state = await getState(desktopSession);
  const collisionFirst = playerFrom(state, desktopSession.playerId);
  await holdKeys(desktopPage, ['w'], 850);
  state = await getState(desktopSession);
  const collisionSecond = playerFrom(state, desktopSession.playerId);
  report.desktop.collision = {
    first: { x: collisionFirst.x, y: collisionFirst.y },
    second: { x: collisionSecond.x, y: collisionSecond.y },
    blockedDelta: Math.hypot(collisionSecond.x - collisionFirst.x, collisionSecond.y - collisionFirst.y),
  };
  await desktopPage.screenshot({ path: resolve(outputDir, 'desktop-obstacle-collision.png') });

  await holdKeys(desktopPage, ['s'], 1_350);
  await holdKeys(desktopPage, ['d'], 450);
  await holdKeys(desktopPage, ['w', 'd'], 3_250);
  await holdKeys(desktopPage, ['d'], 1_450);
  state = await getState(desktopSession);
  player = playerFrom(state, desktopSession.playerId);
  report.desktop.saltMarsh = {
    x: player.x,
    y: player.y,
    hp: player.hp,
    action: player.action,
    area: await desktopPage.locator('#areaName').textContent(),
    enemiesVisibleInState: state.enemies.filter((enemy) => Math.hypot(enemy.x - player.x, enemy.y - player.y) < 900).map((enemy) => ({ id: enemy.id, type: enemy.type, action: enemy.action, x: enemy.x, y: enemy.y })),
  };
  await desktopPage.screenshot({ path: resolve(outputDir, 'desktop-salt-marsh.png') });
  await desktopPage.keyboard.down('j');
  await desktopPage.waitForTimeout(120);
  const attackA = await desktopPage.locator('#gameCanvas').screenshot({ path: resolve(outputDir, 'desktop-attack-frame-a.png') });
  await desktopPage.waitForTimeout(140);
  const attackB = await desktopPage.locator('#gameCanvas').screenshot({ path: resolve(outputDir, 'desktop-attack-frame-b.png') });
  await desktopPage.keyboard.up('j');
  report.desktop.attackFrames = { a: digest(attackA), b: digest(attackB), visuallyChanged: digest(attackA) !== digest(attackB) };
  report.desktop.resource404s = report.desktop.httpErrors.filter((entry) => entry.status === 404 && /\/assets\//.test(entry.url));
  await desktopContext.close();

  const mobileContext = await browser.newContext({
    viewport: { width: 844, height: 390 },
    screen: { width: 844, height: 390 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36',
  });
  const mobilePage = await mobileContext.newPage();
  attachDiagnostics(mobilePage, report.mobile);
  const mobileSession = await startSolo(mobilePage, 'QA手机猎人');
  report.mobile.session = { roomCode: mobileSession.roomCode, playerId: mobileSession.playerId, role: mobileSession.role };
  report.mobile.layout = await inspectMobileLayout(mobilePage);
  report.mobile.assets = await inspectAssets(mobilePage);
  await mobilePage.screenshot({ path: resolve(outputDir, 'mobile-844x390.png') });
  report.mobile.resource404s = report.mobile.httpErrors.filter((entry) => entry.status === 404 && /\/assets\//.test(entry.url));
  await mobileContext.close();

  const created = await post('/api/rooms', { mode: 'coop', name: 'QA联机甲' });
  const joined = await post(`/api/rooms/${created.json.roomCode}/join`, { name: 'QA联机乙' });
  const stateFromHostBefore = await getState(created.json);
  const hostBefore = playerFrom(stateFromHostBefore, created.json.playerId);
  await post(`/api/rooms/${created.json.roomCode}/input`, {
    playerId: created.json.playerId,
    token: created.json.token,
    seq: 1,
    move: { x: 1, y: 0 },
    aim: { x: 1, y: 0 },
    attack: false,
    interact: false,
    dodge: false,
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
  await post(`/api/rooms/${created.json.roomCode}/input`, {
    playerId: created.json.playerId,
    token: created.json.token,
    seq: 2,
    move: { x: 0, y: 0 },
    aim: { x: 1, y: 0 },
    attack: false,
    interact: false,
    dodge: false,
  });
  const [stateFromHost, stateFromGuest] = await Promise.all([getState(created.json), getState(joined.json)]);
  const hostAfter = playerFrom(stateFromHost, created.json.playerId);
  report.coop = {
    roomCode: created.json.roomCode,
    createStatus: created.status,
    joinStatus: joined.status,
    stage: stateFromHost.stage,
    playersFromHost: stateFromHost.players.map((entry) => ({ id: entry.id, role: entry.role, x: entry.x, y: entry.y })),
    playersFromGuest: stateFromGuest.players.map((entry) => ({ id: entry.id, role: entry.role, x: entry.x, y: entry.y })),
    hostMoved: Math.hypot(hostAfter.x - hostBefore.x, hostAfter.y - hostBefore.y),
    snapshotsAgree: JSON.stringify(stateFromHost.players.map((entry) => [entry.id, entry.x, entry.y])) === JSON.stringify(stateFromGuest.players.map((entry) => [entry.id, entry.x, entry.y])),
  };
} finally {
  await browser.close();
  await writeFile(resolve(outputDir, 'qa-result.json'), JSON.stringify(report, null, 2), 'utf8');
}

console.log(JSON.stringify(report, null, 2));
