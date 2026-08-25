import assert from 'node:assert/strict';

const baseUrl = (process.argv[2] || process.env.REMOTE_BASE_URL || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(baseUrl)) {
  throw new Error('Usage: node scripts/remote-smoke.mjs https://your-game.example');
}

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const payload = await response.json();
  assert.ok(response.ok, `${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}

function socketUrl(session) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/api/rooms/${session.roomCode}/socket`;
  url.search = new URLSearchParams({ playerId: session.playerId, token: session.token });
  return url.href;
}

function openSocket(session) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(session));
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 12_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket connection failed'));
    }, { once: true });
  });
}

function waitForState(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', receive);
      reject(new Error('WebSocket state timeout'));
    }, 12_000);
    const receive = (event) => {
      let payload;
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      const state = payload.type === 'state' ? payload.state : null;
      if (!state || !predicate(state)) return;
      clearTimeout(timer);
      socket.removeEventListener('message', receive);
      resolve(state);
    };
    socket.addEventListener('message', receive);
  });
}

const health = await jsonRequest('/api/health', { headers: {} });
assert.equal(health.ok, true);

const [mapArt, playerArt] = await Promise.all([
  fetch(`${baseUrl}/assets/world-map-v4.webp`),
  fetch(`${baseUrl}/assets/vanguard-anim-v3.png`),
]);
assert.equal(mapArt.status, 200);
assert.match(mapArt.headers.get('content-type') || '', /image\/webp/i);
assert.ok(Number(mapArt.headers.get('content-length') || 0) > 1_000_000);
assert.equal(playerArt.status, 200);
assert.match(playerArt.headers.get('content-type') || '', /image\/png/i);
assert.ok(Number(playerArt.headers.get('content-length') || 0) > 100_000);

const host = await jsonRequest('/api/rooms', {
  method: 'POST',
  body: JSON.stringify({ mode: 'coop', name: '远程验收一号' }),
});
const guest = await jsonRequest(`/api/rooms/${host.roomCode}/join`, {
  method: 'POST',
  body: JSON.stringify({ name: '远程验收二号' }),
});

const [hostSocket, guestSocket] = await Promise.all([openSocket(host), openSocket(guest)]);
try {
  const [hostState, guestState] = await Promise.all([
    waitForState(hostSocket, (state) => state.stage?.status === 'active'),
    waitForState(guestSocket, (state) => state.stage?.status === 'active'),
  ]);
  assert.equal(hostState.players.length, 2);
  assert.equal(guestState.players.length, 2);
  assert.ok(hostState.enemies.length > 0);
  assert.equal(hostState.arena.width, 5_120);
  assert.equal(hostState.arena.height, 2_880);
  assert.ok(hostState.zones.length >= 5);
  assert.ok(hostState.obstacles.length >= 10);
  assert.ok(hostState.players.every((player) => player.level >= 1 && typeof player.action === 'string'));
  assert.equal(hostState.exit.unlocked, false);

  const nextState = waitForState(hostSocket, (state) => state.tick > hostState.tick);
  hostSocket.send(JSON.stringify({
    type: 'input',
    seq: Date.now(),
    move: { x: 1, y: 0 },
    aim: { x: 1, y: 0 },
    attack: true,
    interact: false,
    dodge: false,
  }));
  await nextState;

  console.log(JSON.stringify({
    ok: true,
    roomCode: host.roomCode,
    players: hostState.players.map((player) => player.role),
    stage: hostState.stage.id,
    transport: 'websocket',
    art: 'continuous-map-and-animated-sprites',
    world: `${hostState.arena.width}x${hostState.arena.height}`,
    zones: hostState.zones.length,
  }));
} finally {
  hostSocket.close();
  guestSocket.close();
}
