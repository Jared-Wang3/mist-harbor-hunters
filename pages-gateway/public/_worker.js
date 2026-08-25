export async function forwardToGame(request, env) {
  if (!env?.GAME || typeof env.GAME.fetch !== 'function') {
    return Response.json(
      { ok: false, error: 'game_backend_unavailable' },
      { status: 503 },
    );
  }
  return env.GAME.fetch(request);
}

export default { fetch: forwardToGame };
