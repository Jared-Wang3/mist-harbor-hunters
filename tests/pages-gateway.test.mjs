import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardToGame } from '../pages-gateway/public/_worker.js';

test('Pages 网关将原始请求完整转发给游戏 Worker', async () => {
  const request = new Request('https://mist-harbor-hunt.pages.dev/api/health');
  let forwarded;
  const response = await forwardToGame(request, {
    GAME: {
      async fetch(received) {
        forwarded = received;
        return Response.json({ ok: true, gateway: 'pages' });
      },
    },
  });
  assert.equal(forwarded, request);
  assert.deepEqual(await response.json(), { ok: true, gateway: 'pages' });
});

test('Pages 网关在服务绑定缺失时给出明确错误', async () => {
  const response = await forwardToGame(new Request('https://example.test/'), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'game_backend_unavailable');
});
