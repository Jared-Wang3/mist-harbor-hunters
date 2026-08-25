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
} from "./client-motion.mjs";

(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const byId = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const safeNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  // Last-resort transport only. At 180ms the existing 100ms interpolation
  // buffer bridges the interval instead of freezing for 1.5 seconds.
  const FALLBACK_POLL_INTERVAL_MS = 180;
  const MAX_LOCAL_PREDICTION_LEAD_MS = 260;
  const STATE_WATCHDOG_INTERVAL_MS = 500;
  const STATE_STALE_AFTER_MS = 1000;
  const MAP_TILE_COLUMNS = 4;
  const MAP_TILE_ROWS = 4;
  const MAX_VISIBLE_TILES = 4;
  const MAX_STAGE_TILE_CACHE = MAX_VISIBLE_TILES + 1;

  const ui = {
    lobbyView: byId("lobbyView"),
    gameView: byId("gameView"),
    mainMenuPanel: byId("mainMenuPanel"),
    contractPanel: byId("contractPanel"),
    homeLink: byId("homeLink"),
    startGameBtn: byId("startGameBtn"),
    quickJoinBtn: byId("quickJoinBtn"),
    howToPlayBtn: byId("howToPlayBtn"),
    howToPlayDialog: byId("howToPlayDialog"),
    closeHowToPlayBtn: byId("closeHowToPlayBtn"),
    backToMenuBtn: byId("backToMenuBtn"),
    hunterName: byId("hunterName"),
    roomCodeInput: byId("roomCodeInput"),
    createRoomBtn: byId("createRoomBtn"),
    soloBtn: byId("soloBtn"),
    joinForm: byId("joinForm"),
    joinBtn: byId("joinBtn"),
    loadingVeil: byId("loadingVeil"),
    loadingText: byId("loadingText"),
    toast: byId("toast"),
    serverStatus: byId("serverStatus"),
    serverStatusText: byId("serverStatusText"),
    roomCodeDisplay: byId("roomCodeDisplay"),
    waitRoomCode: byId("waitRoomCode"),
    copyCodeBtn: byId("copyCodeBtn"),
    copyWaitCodeBtn: byId("copyWaitCodeBtn"),
    leaveBtn: byId("leaveBtn"),
    connectionBadge: byId("connectionBadge"),
    connectionText: byId("connectionText"),
    canvas: byId("gameCanvas"),
    canvasFrame: byId("canvasFrame"),
    waitOverlay: byId("waitOverlay"),
    phaseBanner: byId("phaseBanner"),
    phaseEyebrow: byId("phaseEyebrow"),
    phaseTitle: byId("phaseTitle"),
    bossHud: byId("bossHud"),
    bossName: byId("bossName"),
    bossEpithet: byId("bossEpithet"),
    bossHealth: byId("bossHealth"),
    bossHealthLag: byId("bossHealthLag"),
    bossHpText: byId("bossHpText"),
    bossPhaseText: byId("bossPhaseText"),
    stageLabel: byId("stageLabel"),
    objectiveTitle: byId("objectiveTitle"),
    objectiveDetail: byId("objectiveDetail"),
    objectiveProgress: byId("objectiveProgress"),
    downedNotice: byId("downedNotice"),
    downedTitle: byId("downedTitle"),
    downedDetail: byId("downedDetail"),
    reviveProgress: byId("reviveProgress"),
    primarySkillIcon: byId("primarySkillIcon"),
    primarySkillName: byId("primarySkillName"),
    touchAttackIcon: byId("touchAttackIcon"),
    resultOverlay: byId("resultOverlay"),
    resultEyebrow: byId("resultEyebrow"),
    resultTitle: byId("resultTitle"),
    resultMessage: byId("resultMessage"),
    resultTime: byId("resultTime"),
    resultKills: byId("resultKills"),
    resultRevives: byId("resultRevives"),
    restartBtn: byId("restartBtn"),
    returnLobbyBtn: byId("returnLobbyBtn"),
    moveStick: byId("moveStick"),
    moveKnob: byId("moveKnob"),
    touchAttack: byId("touchAttack"),
    touchInteract: byId("touchInteract"),
    touchDodge: byId("touchDodge"),
    aimStick: byId("aimStick"),
    minimap: byId("minimapCanvas"),
    areaName: byId("areaName"),
    sealStatus: byId("sealStatus"),
    exitStatus: byId("exitStatus")
  };

  const playerUi = [1, 2].map((number) => ({
    card: byId(`playerCard${number === 1 ? "One" : "Two"}`),
    name: byId(`player${number === 1 ? "One" : "Two"}Name`),
    role: byId(`player${number === 1 ? "One" : "Two"}Role`),
    health: byId(`player${number === 1 ? "One" : "Two"}Health`),
    hpText: byId(`player${number === 1 ? "One" : "Two"}HpText`),
    status: byId(`player${number === 1 ? "One" : "Two"}Status`),
    level: byId(`player${number === 1 ? "One" : "Two"}Level`),
    xp: byId(`player${number === 1 ? "One" : "Two"}Xp`),
    portrait: $(`#playerCard${number === 1 ? "One" : "Two"} .hud-portrait`)
  }));

  const ctx = ui.canvas.getContext("2d", { alpha: false, desynchronized: true });
  const minimapCtx = ui.minimap?.getContext("2d", { alpha: false });
  const canvasSans = getComputedStyle(document.documentElement).getPropertyValue("--sans").trim() || "sans-serif";
  const sessionStorageKey = "mistharbor.session.v1";
  const keys = new Set();
  const controls = {
    move: { x: 0, y: 0 },
    aim: { x: 1, y: 0 },
    attack: false,
    interact: false,
    dodge: false
  };

  const runtime = {
    session: null,
    snapshot: null,
    socket: null,
    socketFallbackTimer: 0,
    socketRetryTimer: 0,
    socketEverOpened: false,
    legacyStarted: false,
    eventSource: null,
    pollTimer: 0,
    pollInFlight: false,
    stateWatchdogTimer: 0,
    inputTimer: 0,
    inputInFlight: false,
    inputSeq: 0,
    lastInputSignature: "",
    lastInputAt: 0,
    lastStateAt: 0,
    snapshotBuffer: [],
    localVisual: null,
    lastPredictionMove: { x: 0, y: 0 },
    localStoppedAt: 0,
    lastFrameAt: 0,
    pingTimer: 0,
    pingStartedAt: 0,
    rtt: 0,
    bossLagTimer: 0,
    lastStageKey: "",
    phaseTimer: 0,
    toastTimer: 0,
    joystickPointer: null,
    attackPointer: null,
    canvasAttackPointer: null,
    canvasWidth: 1600,
    canvasHeight: 900,
    dpr: 1,
    canvasRect: null,
    moveStickRect: null,
    attackRect: null,
    coarsePointer: window.matchMedia?.("(pointer: coarse)")?.matches === true,
    camera: null,
    cameraView: null,
    knownZones: new Set(),
    lastMinimapAt: 0,
    animationClocks: new Map(),
    stageVisualKey: "",
    stageTileCache: new Map(),
    debugCollision: new URLSearchParams(window.location.search).get("debugCollision") === "1",
    fogCanvas: typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1) : document.createElement("canvas"),
    resultShown: false,
    transitionInFlight: false,
    leaving: false
  };

  const animationAssets = {
    vanguard: loadImage("assets/vanguard-anim-v3.png", { lazy: true }),
    ranger: loadImage("assets/ranger-anim-v3.png", { lazy: true }),
    crawler: loadImage("assets/crawler-anim-v4.png", { lazy: true }),
    brute: loadImage("assets/brute-anim-v4.png", { lazy: true }),
    siren: loadImage("assets/siren-anim-v4.png", { lazy: true }),
    fog_colossus: loadImage("assets/fog-colossus-anim-v4.png", { lazy: true }),
    lantern_regent: loadImage("assets/lantern-regent-anim-v1.png", { lazy: true }),
    tide_tortoise: loadImage("assets/tide-tortoise-anim-v1.png", { lazy: true })
  };
  animationAssets.spitter = animationAssets.crawler;

  const assets = {
    sprites: loadImage("assets/sprites-v2.webp"),
    icons: loadImage("assets/icons-v2.webp"),
    animations: animationAssets
  };

  const stageWorldRegistry = Object.freeze({
    "stage-01": Object.freeze({ version: "v5", tileWidth: 1280, tileHeight: 720 }),
    "stage-02": Object.freeze({ version: "v1", tileWidth: 1280, tileHeight: 720 }),
    "stage-03": Object.freeze({ version: "v1", tileWidth: 1280, tileHeight: 720 })
  });

  const terrainAssets = {
    common: loadImage("assets/world/terrain-common-v1.webp", { lazy: true }),
    "stage-02": loadImage("assets/world/stage-02/terrain-stage-02-v1.webp", { lazy: true }),
    "stage-03": loadImage("assets/world/stage-03/terrain-stage-03-v1.webp", { lazy: true })
  };

  const commonTerrainCells = Object.freeze({
    bridge: Object.freeze({ column: 1, row: 0, columns: 4, rows: 2 }),
    rock: Object.freeze({ column: 3, row: 0, columns: 4, rows: 2 }),
    wall: Object.freeze({ column: 0, row: 1, columns: 4, rows: 2 }),
    stall: Object.freeze({ column: 1, row: 1, columns: 4, rows: 2 }),
    tower: Object.freeze({ column: 2, row: 1, columns: 4, rows: 2 }),
    pillar: Object.freeze({ column: 3, row: 1, columns: 4, rows: 2 }),
    gate: Object.freeze({ column: 3, row: 1, columns: 4, rows: 2 })
  });

  const stageTerrainCells = Object.freeze({
    "stage-02": Object.freeze({
      pillar: Object.freeze({ column: 0, row: 0, columns: 2, rows: 2 }),
      gate: Object.freeze({ column: 0, row: 0, columns: 2, rows: 2 }),
      wall: Object.freeze({ column: 1, row: 0, columns: 2, rows: 2 }),
      tower: Object.freeze({ column: 0, row: 1, columns: 2, rows: 2 }),
      stall: Object.freeze({ column: 1, row: 1, columns: 2, rows: 2 })
    }),
    "stage-03": Object.freeze({
      bridge: Object.freeze({ column: 0, row: 0, columns: 2, rows: 2 }),
      pillar: Object.freeze({ column: 1, row: 0, columns: 2, rows: 2 }),
      tower: Object.freeze({ column: 0, row: 1, columns: 2, rows: 2 }),
      gate: Object.freeze({ column: 1, row: 1, columns: 2, rows: 2 })
    })
  });

  function loadImage(src, { lazy = false } = {}) {
    const record = {
      image: null,
      ready: false,
      failed: false,
      requested: false,
      generation: 0,
      src,
      load() {
        if (record.requested) return record;
        record.requested = true;
        record.failed = false;
        const generation = ++record.generation;
        const image = new Image();
        record.image = image;
        image.decoding = "async";
        image.addEventListener("load", () => {
          if (record.generation !== generation || record.image !== image) return;
          record.ready = true;
        });
        image.addEventListener("error", () => {
          if (record.generation !== generation || record.image !== image) return;
          record.failed = true;
        });
        image.src = src;
        return record;
      },
      release() {
        record.generation += 1;
        const image = record.image;
        record.image = null;
        record.ready = false;
        record.failed = false;
        record.requested = false;
        if (image) {
          try { image.removeAttribute("src"); } catch {}
        }
      }
    };
    if (!lazy) record.load();
    return record;
  }

  function setLoading(visible, text = "正在书写契约…") {
    ui.loadingText.textContent = text;
    ui.loadingVeil.hidden = !visible;
    ui.createRoomBtn.disabled = visible;
    ui.soloBtn.disabled = visible;
    ui.joinBtn.disabled = visible;
    if (ui.startGameBtn) ui.startGameBtn.disabled = visible;
    if (ui.quickJoinBtn) ui.quickJoinBtn.disabled = visible;
  }

  function showLobbyPanel(panel, focusTarget = null) {
    const showContract = panel === "contract";
    if (ui.mainMenuPanel) ui.mainMenuPanel.hidden = showContract;
    if (ui.contractPanel) ui.contractPanel.hidden = !showContract;
    if (focusTarget) window.setTimeout(() => focusTarget.focus({ preventScroll: true }), 20);
  }

  function showMainMenu({ focus = true } = {}) {
    showLobbyPanel("menu", focus ? ui.startGameBtn : null);
  }

  function showContractPanel({ focusJoin = false } = {}) {
    showLobbyPanel("contract", focusJoin ? ui.roomCodeInput : ui.createRoomBtn);
  }

  function openHowToPlay() {
    if (!ui.howToPlayDialog || ui.howToPlayDialog.open) return;
    if (typeof ui.howToPlayDialog.showModal === "function") ui.howToPlayDialog.showModal();
    else ui.howToPlayDialog.setAttribute("open", "");
  }

  function stageVisualKeyFrom(state) {
    const supplied = String(state?.stage?.mapKey || state?.stage?.id || "");
    if (stageWorldRegistry[supplied]) return supplied;
    const index = clamp(Math.floor(safeNumber(state?.stage?.index, 1)), 1, 3);
    return `stage-${String(index).padStart(2, "0")}`;
  }

  function stageBlocksInput(status = runtime.snapshot?.stage?.status) {
    return ["waiting", "frozen", "resetting", "stage_complete", "victory"].includes(String(status || "").toLowerCase());
  }

  function releaseStageTileCache() {
    for (const tile of runtime.stageTileCache.values()) tile.asset.release();
    runtime.stageTileCache.clear();
  }

  function bossAnimationForStage(stageKey) {
    if (stageKey === "stage-02") return "lantern_regent";
    if (stageKey === "stage-03") return "tide_tortoise";
    return "fog_colossus";
  }

  function releaseStageSpecificAssets(stageKey) {
    releaseStageTileCache();
    if (!stageKey) return;
    terrainAssets[stageKey]?.release();
    assets.animations[bossAnimationForStage(stageKey)]?.release();
  }

  function clearMinimap() {
    if (!minimapCtx || !ui.minimap) return;
    minimapCtx.clearRect(0, 0, ui.minimap.width, ui.minimap.height);
  }

  function showToast(message, isError = false, duration = 2600) {
    window.clearTimeout(runtime.toastTimer);
    ui.toast.textContent = message;
    ui.toast.classList.toggle("is-error", isError);
    ui.toast.hidden = false;
    runtime.toastTimer = window.setTimeout(() => { ui.toast.hidden = true; }, duration);
  }

  function friendlyError(error, fallback = "雾港没有回应，请稍后再试") {
    const message = String(error?.message || "");
    if (/404|not found/i.test(message)) return "没有找到这份契约，请核对房间码";
    if (/full|已满|409/i.test(message)) return "猎团已经满员";
    if (/401|403|token|身份/i.test(message)) return "契约凭证已经失效，请重新加入";
    if (/fetch|network|连接|Failed/i.test(message)) return "暂时无法连接雾港航路";
    return message && message.length < 80 ? message : fallback;
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeoutMs = Math.max(250, safeNumber(options.timeoutMs, 9000));
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
      const response = await fetch(path, {
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(fetchOptions.headers || {})
        }
      });
      const raw = await response.text();
      let data = {};
      if (raw) {
        try { data = JSON.parse(raw); } catch { data = { message: raw }; }
      }
      if (!response.ok) {
        const detail = data.error || data.message || response.statusText;
        throw new Error(`${response.status}: ${detail}`);
      }
      return data;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function hunterName() {
    return ui.hunterName.value.trim().slice(0, 12) || "无名猎人";
  }

  async function createHunt(mode) {
    setLoading(true, mode === "solo" ? "正在点亮试炼雾灯…" : "正在书写双人契约…");
    try {
      const data = await request("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ mode, name: hunterName() })
      });
      await enterSession(data, mode);
    } catch (error) {
      showToast(friendlyError(error), true);
      setServerStatus(false);
    } finally {
      setLoading(false);
    }
  }

  async function joinHunt(event) {
    event.preventDefault();
    const code = ui.roomCodeInput.value.trim().toUpperCase().replace(/\s/g, "");
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      showToast("请输入完整的 6 位房间码", true);
      ui.roomCodeInput.focus();
      return;
    }
    setLoading(true, "正在寻找这份猎团契约…");
    try {
      const data = await request(`/api/rooms/${encodeURIComponent(code)}/join`, {
        method: "POST",
        body: JSON.stringify({ name: hunterName() })
      });
      await enterSession({ ...data, roomCode: data.roomCode || code }, "coop");
    } catch (error) {
      showToast(friendlyError(error), true);
    } finally {
      setLoading(false);
    }
  }

  function normalizeSession(data, mode) {
    const roomCode = String(data.roomCode || data.code || data.room?.code || "").toUpperCase();
    const playerId = String(data.playerId || data.player?.id || data.id || "");
    const token = String(data.token || data.accessToken || "");
    if (!roomCode || !playerId || !token) throw new Error("服务器没有返回完整的契约凭证");
    return {
      roomCode,
      playerId,
      token,
      role: data.role || data.player?.role || "heavy",
      mode: data.mode || data.room?.mode || mode || "coop",
      name: hunterName()
    };
  }

  async function enterSession(data, mode) {
    releaseStageSpecificAssets(runtime.stageVisualKey);
    runtime.session = normalizeSession(data, mode);
    runtime.snapshot = null;
    runtime.snapshotBuffer.length = 0;
    runtime.localVisual = null;
    runtime.camera = null;
    runtime.cameraView = null;
    runtime.knownZones.clear();
    runtime.animationClocks.clear();
    runtime.stageVisualKey = "";
    runtime.lastMinimapAt = 0;
    runtime.lastPredictionMove = { x: 0, y: 0 };
    runtime.localStoppedAt = 0;
    runtime.lastFrameAt = 0;
    runtime.socketEverOpened = false;
    runtime.inputSeq = Date.now();
    runtime.lastInputSignature = "";
    runtime.lastInputAt = 0;
    runtime.resultShown = false;
    runtime.transitionInFlight = false;
    runtime.lastStageKey = "";
    runtime.leaving = false;
    try { sessionStorage.setItem(sessionStorageKey, JSON.stringify(runtime.session)); } catch {}
    ui.roomCodeDisplay.textContent = runtime.session.roomCode;
    ui.waitRoomCode.textContent = runtime.session.roomCode;
    ui.resultOverlay.hidden = true;
    ui.restartBtn.disabled = false;
    if (ui.howToPlayDialog?.open) ui.howToPlayDialog.close();
    ui.lobbyView.hidden = true;
    ui.gameView.hidden = false;
    document.body.classList.add("is-playing");
    ui.waitOverlay.hidden = runtime.session.mode === "solo";
    configureLocalRole(runtime.session.role);
    if (data?.state || data?.snapshot) handleSnapshot(data.state || data.snapshot);
    setConnection("connecting", "正在连接雾港…");
    resizeCanvas();
    connectEvents();
    startInputLoop();
    window.setTimeout(() => ui.canvas.focus({ preventScroll: true }), 50);
  }

  async function restoreStoredSession() {
    let stored;
    try {
      stored = JSON.parse(sessionStorage.getItem(sessionStorageKey) || "null");
    } catch {
      try { sessionStorage.removeItem(sessionStorageKey); } catch {}
      return;
    }
    if (!stored?.roomCode || !stored?.token) return;

    if (stored.name) ui.hunterName.value = String(stored.name).slice(0, 12);
    setLoading(true, "正在重新点亮上次的契约…");
    try {
      const data = await request(`/api/rooms/${encodeURIComponent(stored.roomCode)}/reconnect`, {
        method: "POST",
        body: JSON.stringify({ playerId: stored.playerId, token: stored.token })
      });
      await enterSession({ ...stored, ...data, roomCode: data.roomCode || stored.roomCode }, stored.mode);
      showToast("已回到上次的猎团契约");
    } catch (error) {
      const message = String(error?.message || "");
      if (/401|403|404|invalid_session|not found/i.test(message)) {
        try { sessionStorage.removeItem(sessionStorageKey); } catch {}
      } else {
        setServerStatus(false);
      }
    } finally {
      setLoading(false);
    }
  }

  function credentials(extra = {}) {
    return {
      playerId: runtime.session?.playerId,
      token: runtime.session?.token,
      ...extra
    };
  }

  function setServerStatus(online) {
    ui.serverStatus.classList.toggle("is-offline", !online);
    ui.serverStatusText.textContent = online ? "雾港航路畅通" : "雾港航路不稳";
    const dot = ui.serverStatus.querySelector(".status-dot");
    if (dot) {
      dot.style.background = online ? "" : "var(--danger)";
      dot.style.boxShadow = online ? "" : "0 0 10px var(--danger)";
    }
  }

  function setConnection(state, text) {
    ui.connectionBadge.classList.toggle("is-connecting", state === "connecting");
    ui.connectionBadge.classList.toggle("is-offline", state === "offline");
    ui.connectionText.textContent = text;
  }

  function connectEvents() {
    closeConnection();
    if (!runtime.session) return;

    runtime.legacyStarted = false;
    startStateWatchdog();
    if ("WebSocket" in window) {
      connectWebSocket();
    } else {
      startLegacyTransport();
    }

    window.setTimeout(() => {
      if (!runtime.session || runtime.snapshot) return;
      if (!socketIsOpen()) startLegacyTransport();
      else ensurePolling();
    }, 2200);
  }

  function websocketUrl() {
    const { roomCode, playerId, token } = runtime.session;
    const query = new URLSearchParams({ playerId, token });
    const url = new URL(`/api/rooms/${encodeURIComponent(roomCode)}/socket?${query}`, window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }

  function socketIsOpen() {
    return Boolean(runtime.socket && runtime.socket.readyState === window.WebSocket.OPEN);
  }

  function stopPingLoop() {
    window.clearInterval(runtime.pingTimer);
    runtime.pingTimer = 0;
    runtime.pingStartedAt = 0;
  }

  function sendSocketPing() {
    if (!socketIsOpen()) return;
    if (runtime.pingStartedAt && performance.now() - runtime.pingStartedAt < 5000) return;
    runtime.pingStartedAt = performance.now();
    try {
      runtime.socket.send(JSON.stringify({ type: "ping" }));
    } catch {
      runtime.pingStartedAt = 0;
    }
  }

  function startPingLoop() {
    stopPingLoop();
    sendSocketPing();
    runtime.pingTimer = window.setInterval(sendSocketPing, 2500);
  }

  function handlePong() {
    if (!runtime.pingStartedAt) return;
    runtime.rtt = Math.max(0, performance.now() - runtime.pingStartedAt);
    runtime.pingStartedAt = 0;
    ui.connectionBadge.title = `WebSocket RTT ${Math.round(runtime.rtt)} ms`;
    ui.connectionBadge.dataset.quality = runtime.rtt > 450 ? "poor" : runtime.rtt > 250 ? "fair" : "good";
  }

  function connectWebSocket() {
    if (!runtime.session || runtime.leaving || !("WebSocket" in window)) return;
    window.clearTimeout(runtime.socketRetryTimer);
    runtime.socketRetryTimer = 0;

    let socket;
    try {
      socket = new WebSocket(websocketUrl());
    } catch {
      startLegacyTransport();
      return;
    }

    runtime.socket = socket;
    setConnection("connecting", "正在建立实时航路…");
    window.clearTimeout(runtime.socketFallbackTimer);
    runtime.socketFallbackTimer = window.setTimeout(() => {
      if (runtime.socket !== socket || socket.readyState === window.WebSocket.OPEN) return;
      runtime.socket = null;
      startLegacyTransport();
      try { socket.close(); } catch {}
    }, 2200);

    socket.addEventListener("open", () => {
      if (runtime.socket !== socket || !runtime.session) return;
      window.clearTimeout(runtime.socketFallbackTimer);
      runtime.socketFallbackTimer = 0;
      runtime.socketEverOpened = true;
      stopLegacyTransport();
      startPingLoop();
      setConnection("online", "实时契约已连接");
      setServerStatus(true);
    });

    socket.addEventListener("message", (event) => {
      if (runtime.socket !== socket) return;
      try {
        const parsed = JSON.parse(event.data);
        if (parsed?.type === "pong") handlePong();
        else if (parsed?.type === "state" && parsed.state) handleSnapshot(parsed.state);
        else if (parsed?.state) handleSnapshot(parsed.state);
        else if (parsed?.snapshot) handleSnapshot(parsed.snapshot);
      } catch {
        setConnection("connecting", "正在校准猎场状态…");
      }
    });

    socket.addEventListener("error", () => {
      if (runtime.socket !== socket || runtime.leaving || !runtime.session) return;
      startLegacyTransport();
    });

    socket.addEventListener("close", () => {
      window.clearTimeout(runtime.socketFallbackTimer);
      runtime.socketFallbackTimer = 0;
      if (runtime.socket !== socket) return;
      runtime.socket = null;
      stopPingLoop();
      if (runtime.leaving || !runtime.session) return;
      setConnection("offline", "实时航路中断，正在重连…");
      startLegacyTransport();
      if (runtime.socketEverOpened) scheduleWebSocketReconnect();
    });
  }

  function scheduleWebSocketReconnect() {
    if (runtime.socketRetryTimer || runtime.leaving || !runtime.session) return;
    runtime.socketRetryTimer = window.setTimeout(() => {
      runtime.socketRetryTimer = 0;
      if (!runtime.socket && runtime.session && !runtime.leaving) connectWebSocket();
    }, 1800);
  }

  function startLegacyTransport() {
    if (!runtime.session || runtime.legacyStarted) return;
    runtime.legacyStarted = true;
    const { roomCode, playerId, token } = runtime.session;
    const query = new URLSearchParams({ playerId, token });
    if ("EventSource" in window) {
      const source = new EventSource(`/api/rooms/${encodeURIComponent(roomCode)}/events?${query}`);
      runtime.eventSource = source;
      source.addEventListener("open", () => {
        stopPolling();
        if (!socketIsOpen()) setConnection("online", "兼容航路已连接");
        setServerStatus(true);
      });
      const receive = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          handleSnapshot(parsed.state || parsed.snapshot || parsed);
        } catch {
          setConnection("connecting", "正在校准猎场状态…");
        }
      };
      source.addEventListener("state", receive);
      source.addEventListener("message", receive);
      source.addEventListener("error", () => {
        if (runtime.leaving || !runtime.session) return;
        if (!socketIsOpen()) setConnection("offline", "信号中断，正在重连…");
        ensurePolling();
      });
    } else {
      setConnection("connecting", "正在同步猎场…");
      ensurePolling();
    }
  }

  function stopLegacyTransport() {
    if (runtime.eventSource) {
      runtime.eventSource.close();
      runtime.eventSource = null;
    }
    stopPolling();
    runtime.legacyStarted = false;
  }

  function stopPolling() {
    window.clearInterval(runtime.pollTimer);
    runtime.pollTimer = 0;
  }

  function closeConnection() {
    window.clearTimeout(runtime.socketFallbackTimer);
    window.clearTimeout(runtime.socketRetryTimer);
    runtime.socketFallbackTimer = 0;
    runtime.socketRetryTimer = 0;
    stopPingLoop();
    stopStateWatchdog();
    const socket = runtime.socket;
    runtime.socket = null;
    if (socket) {
      try { socket.close(1000, "leaving"); } catch {}
    }
    stopLegacyTransport();
  }

  function ensurePolling() {
    if (runtime.pollTimer || !runtime.session) return;
    pollSnapshot();
    runtime.pollTimer = window.setInterval(pollSnapshot, FALLBACK_POLL_INTERVAL_MS);
  }

  function stopStateWatchdog() {
    window.clearInterval(runtime.stateWatchdogTimer);
    runtime.stateWatchdogTimer = 0;
  }

  function startStateWatchdog() {
    stopStateWatchdog();
    runtime.lastStateAt = Date.now();
    runtime.stateWatchdogTimer = window.setInterval(() => {
      if (!runtime.session || runtime.leaving) return;
      if (Date.now() - runtime.lastStateAt <= STATE_STALE_AFTER_MS) return;
      ensurePolling();
      if (socketIsOpen() && runtime.pingStartedAt && performance.now() - runtime.pingStartedAt > 5000) {
        try { runtime.socket.close(4000, "state timeout"); } catch {}
      }
    }, STATE_WATCHDOG_INTERVAL_MS);
  }

  async function pollSnapshot() {
    if (!runtime.session || runtime.pollInFlight) return;
    const session = runtime.session;
    const { roomCode, playerId, token } = session;
    const query = new URLSearchParams({ playerId, token });
    runtime.pollInFlight = true;
    try {
      const data = await request(`/api/rooms/${encodeURIComponent(roomCode)}/state?${query}`, {
        headers: {},
        timeoutMs: 1000,
      });
      if (runtime.session !== session) return;
      handleSnapshot(data.state || data.snapshot || data);
      if (!socketIsOpen()) setConnection("online", "契约已连接");
    } catch {
      if (runtime.session === session && !socketIsOpen()) {
        setConnection("offline", "信号中断，正在重连…");
      }
    } finally {
      runtime.pollInFlight = false;
    }
  }

  function reconciliationMove(now = performance.now()) {
    if (Math.hypot(controls.move.x, controls.move.y) >= 0.05) return controls.move;
    const grace = clamp((runtime.rtt || 250) + 150, 300, 800);
    if (runtime.localStoppedAt && now - runtime.localStoppedAt < grace) return runtime.lastPredictionMove;
    return controls.move;
  }

  function handleSnapshot(state) {
    if (!state || typeof state !== "object") return;
    const previousTick = safeNumber(runtime.snapshot?.tick, -1);
    const nextTick = safeNumber(state.tick, -1);
    const previousServerTime = safeNumber(runtime.snapshot?.serverTime, -1);
    const nextServerTime = safeNumber(state.serverTime, -1);
    if (runtime.snapshot && (nextTick < previousTick || (nextTick === previousTick && nextServerTime <= previousServerTime))) return;
    const nextStageVisualKey = stageVisualKeyFrom(state);
    if (runtime.stageVisualKey && nextStageVisualKey !== runtime.stageVisualKey) {
      releaseStageSpecificAssets(runtime.stageVisualKey);
      runtime.snapshot = null;
      runtime.snapshotBuffer.length = 0;
      runtime.localVisual = null;
      runtime.camera = null;
      runtime.cameraView = null;
      runtime.knownZones.clear();
      runtime.animationClocks.clear();
      runtime.lastMinimapAt = 0;
      runtime.lastFrameAt = 0;
      runtime.lastPredictionMove = { x: 0, y: 0 };
      runtime.localStoppedAt = 0;
      runtime.lastInputSignature = "";
      runtime.lastInputAt = 0;
      runtime.inputSeq = Date.now();
      runtime.inputInFlight = false;
      runtime.resultShown = false;
      runtime.transitionInFlight = false;
      runtime.lastStageKey = "";
      ui.resultOverlay.hidden = true;
      ui.restartBtn.disabled = false;
      clearMovement();
      clearMinimap();
    }
    runtime.stageVisualKey = nextStageVisualKey;
    const receivedAt = performance.now();
    if (!appendSnapshot(runtime.snapshotBuffer, state, receivedAt)) return;
    runtime.snapshot = state;
    runtime.lastStateAt = Date.now();
    const local = playersFrom(state).find((player) => player.id === runtime.session?.playerId);
    if (local) {
      if (local.status === "active") {
        runtime.localVisual = reconcileLocalPosition(runtime.localVisual, local, reconciliationMove(receivedAt));
      } else {
        runtime.localVisual = { x: safeNumber(local.x), y: safeNumber(local.y) };
      }
    }
    if (stageBlocksInput(state.stage?.status)) clearMovement();
    updateHud(state);
  }

  function playersFrom(state = runtime.snapshot) {
    if (!state) return [];
    if (Array.isArray(state.players)) return state.players;
    return state.players && typeof state.players === "object" ? Object.values(state.players) : [];
  }

  function enemiesFrom(state = runtime.snapshot) {
    return Array.isArray(state?.enemies) ? state.enemies : [];
  }

  function isGunner(role) {
    return /gun|rune|range|符文|枪/i.test(String(role || ""));
  }

  function roleLabel(role) {
    return isGunner(role) ? "符文枪手" : "重刃猎人";
  }

  function configureLocalRole(role) {
    const gunner = isGunner(role);
    ui.primarySkillIcon.className = `asset-icon ${gunner ? "icon-shot" : "icon-slash"}`;
    ui.touchAttackIcon.className = `asset-icon ${gunner ? "icon-shot" : "icon-slash"}`;
    ui.primarySkillName.textContent = gunner ? "符文弹" : "重刃斩";
  }

  function updateHud(state) {
    const players = playersFrom(state).slice().sort((a, b) => {
      if (a.id === runtime.session?.playerId) return -1;
      if (b.id === runtime.session?.playerId) return 1;
      return Number(Boolean(a.isAI)) - Number(Boolean(b.isAI));
    });

    playerUi.forEach((view, index) => updatePlayerCard(view, players[index], index));

    const mode = state.room?.mode || runtime.session?.mode;
    const readyPlayers = players.filter((player) => player.connected !== false);
    const waiting = mode !== "solo" && (state.stage?.status === "waiting" || readyPlayers.length < 2);
    ui.waitOverlay.hidden = !waiting;

    const stage = state.stage || {};
    const stageIndex = safeNumber(stage.index, 0);
    const stageTotal = safeNumber(stage.total, 3);
    const rawStageTitle = String(stage.title || stage.name || "雾港外环");
    const stageTitle = rawStageTitle.replace(/^第[一二三四五六七八九十\d]+幕\s*[·・.、-]?\s*/, "");
    ui.stageLabel.textContent = `${chineseStage(stageIndex)} · ${stageTitle}`;

    const objective = state.objective || {};
    ui.objectiveTitle.textContent = objective.label || objective.title || objectiveText(objective.kind);
    ui.objectiveDetail.textContent = objective.detail || objective.description || "与同伴并肩完成当前狩猎目标";
    const current = safeNumber(objective.current, 0);
    const target = safeNumber(objective.target, 0);
    ui.objectiveProgress.textContent = target > 0 ? `${current} / ${target}` : "进行中";

    updateExplorationHud(state, players);

    const boss = enemiesFrom(state).find((enemy) => enemy.boss || /boss|mother|母|首领/i.test(String(enemy.type || enemy.name || "")));
    updateBoss(boss, state);
    updateDowned(players);
    maybeShowPhase(stage, boss);
    updateResult(state.result || resultFromStage(stage), state);
  }

  function updatePlayerCard(view, player, index) {
    const fallbackRole = index === 0 ? "heavy" : "gunner";
    const role = player?.role || fallbackRole;
    const gunner = isGunner(role);
    view.card.classList.toggle("is-local", Boolean(player && player.id === runtime.session?.playerId));
    view.card.classList.toggle("is-downed", Boolean(player && /down|倒/i.test(player.status || "")));
    view.name.textContent = player?.name || (index === 0 ? "等待猎人" : "等待猎人");
    view.role.textContent = roleLabel(role);
    view.portrait.className = `hud-portrait ${gunner ? "sprite-gunner" : "sprite-hunter"}`;
    view.health.parentElement.classList.toggle("teal-track", gunner);
    const maxHp = Math.max(1, safeNumber(player?.maxHp, 100));
    const hp = clamp(safeNumber(player?.hp, player ? maxHp : 0), 0, maxHp);
    view.health.style.width = `${(hp / maxHp) * 100}%`;
    view.hpText.textContent = player ? `${Math.ceil(hp)} / ${Math.ceil(maxHp)}` : "-- / --";
    const level = Math.max(1, Math.floor(safeNumber(player?.level, 1)));
    const xp = Math.max(0, safeNumber(player?.xp, 0));
    const xpTarget = Math.max(1, safeNumber(player?.xpToNext ?? player?.nextLevelXp, 80 + (level - 1) * 60));
    if (view.level) view.level.textContent = player ? `Lv.${level}` : "Lv.--";
    if (view.xp) view.xp.style.width = `${clamp((xp / xpTarget) * 100, 0, 100)}%`;
    if (!player) view.status.textContent = "尚未加入";
    else if (player.connected === false) view.status.textContent = "连接中断";
    else if (/down|倒/i.test(player.status || "")) view.status.textContent = "等待救援";
    else if (player.isAI) view.status.textContent = "契约灯偶";
    else view.status.textContent = player.id === runtime.session?.playerId ? "你" : "并肩作战";
  }

  function zonesFrom(state = runtime.snapshot) {
    if (Array.isArray(state?.zones) && state.zones.length) return state.zones;
    if (state?.zones && typeof state.zones === "object") return Object.values(state.zones);
    const arena = state?.arena || {};
    const width = Math.max(1280, safeNumber(arena.width, 1280));
    const height = Math.max(720, safeNumber(arena.height, 720));
    if (width <= 1600 && height <= 900) return [{ id: "old-harbor", name: "旧盐巷", x: 0, y: 0, width, height, discovered: true }];
    return [
      { id: "camp", name: "猎团营地", x: 0, y: height * 0.66, width: width * 0.28, height: height * 0.34 },
      { id: "marsh", name: "白盐沼泽", x: 0, y: height * 0.28, width: width * 0.43, height: height * 0.42 },
      { id: "market", name: "沉没集市", x: width * 0.28, y: height * 0.5, width: width * 0.42, height: height * 0.5 },
      { id: "ruins", name: "灯塔遗址", x: width * 0.4, y: 0, width: width * 0.36, height: height * 0.52 },
      { id: "heart", name: "雾心断崖", x: width * 0.68, y: 0, width: width * 0.32, height }
    ];
  }

  function zoneBounds(zone, state = runtime.snapshot) {
    const source = zone?.bounds || zone || {};
    const arena = state?.arena || {};
    const width = Math.max(1, safeNumber(source.width ?? source.w, safeNumber(source.radius, 0) * 2 || safeNumber(arena.width, 1280)));
    const height = Math.max(1, safeNumber(source.height ?? source.h, safeNumber(source.radius, 0) * 2 || safeNumber(arena.height, 720)));
    const centered = source.radius != null || source.centerX != null;
    const x = centered
      ? safeNumber(source.centerX ?? source.x) - width / 2
      : safeNumber(source.x ?? source.left, 0);
    const y = centered
      ? safeNumber(source.centerY ?? source.y) - height / 2
      : safeNumber(source.y ?? source.top, 0);
    return { x, y, width, height };
  }

  function zoneAt(point, state = runtime.snapshot) {
    if (!point) return null;
    return zonesFrom(state).find((zone) => {
      const bounds = zoneBounds(zone, state);
      return safeNumber(point.x) >= bounds.x && safeNumber(point.x) <= bounds.x + bounds.width
        && safeNumber(point.y) >= bounds.y && safeNumber(point.y) <= bounds.y + bounds.height;
    }) || null;
  }

  function zoneIdentifier(zone, index = 0) {
    return String(zone?.id ?? zone?.zoneId ?? zone?.name ?? index);
  }

  function updateExplorationHud(state, players) {
    const local = players.find((player) => player.id === runtime.session?.playerId) || players[0];
    const currentZone = zoneAt(local, state);
    const zones = zonesFrom(state);
    zones.forEach((zone, index) => {
      if (zone.discovered || zone.visited || zone.cleared) runtime.knownZones.add(zoneIdentifier(zone, index));
    });
    if (currentZone) runtime.knownZones.add(zoneIdentifier(currentZone, zones.indexOf(currentZone)));
    if (ui.areaName) ui.areaName.textContent = currentZone?.name || currentZone?.title || state.area?.name || "迷雾边界";

    const progress = state.progress || state.run || {};
    const collected = safeNumber(progress.sealsCollected ?? progress.collectedSeals ?? state.objective?.current, 0);
    const required = Math.max(1, safeNumber(progress.sealsRequired ?? progress.requiredSeals ?? state.objective?.target, 3));
    const unlocked = Boolean(progress.exitUnlocked ?? state.exit?.unlocked ?? state.exit?.open);
    if (ui.sealStatus) ui.sealStatus.textContent = `印记 ${Math.floor(collected)} / ${Math.floor(required)}`;
    if (ui.exitStatus) ui.exitStatus.textContent = unlocked ? "出口已开启" : collected >= required ? "寻找雾心首领" : "出口尚未显现";
    ui.exitStatus?.classList.toggle("is-open", unlocked);
  }

  function updateBoss(boss, state) {
    ui.bossHud.hidden = !boss;
    if (!boss) {
      window.clearTimeout(runtime.bossLagTimer);
      runtime.bossLagTimer = 0;
      return;
    }
    const maxHp = Math.max(1, safeNumber(boss.maxHp, 1));
    const hp = clamp(safeNumber(boss.hp, maxHp), 0, maxHp);
    const percent = (hp / maxHp) * 100;
    ui.bossHealth.style.width = `${percent}%`;
    window.clearTimeout(runtime.bossLagTimer);
    runtime.bossLagTimer = window.setTimeout(() => {
      ui.bossHealthLag.style.width = `${percent}%`;
      runtime.bossLagTimer = 0;
    }, 180);
    ui.bossName.textContent = boss.name || enemyLabel(boss.type) || "雾港之母";
    ui.bossEpithet.textContent = boss.epithet || "潮渊的慈母";
    ui.bossHpText.textContent = `${Math.ceil(hp)} / ${Math.ceil(maxHp)}`;
    const phase = safeNumber(boss.phase ?? state.stage?.phase, percent > 66 ? 1 : percent > 33 ? 2 : 3);
    ui.bossPhaseText.textContent = `${chineseNumber(phase)}阶段`;
  }

  function updateDowned(players) {
    const local = players.find((player) => player.id === runtime.session?.playerId);
    const downed = players.find((player) => /down|倒/i.test(player.status || ""));
    ui.downedNotice.hidden = !downed;
    if (!downed) return;
    const isLocal = downed.id === runtime.session?.playerId;
    ui.downedTitle.textContent = isLocal ? "你倒下了" : `${downed.name || "同伴"}倒下了`;
    ui.downedDetail.textContent = isLocal ? "坚持住，等待同伴靠近救援" : "靠近并按住 E / K 进行救援";
    const current = safeNumber(downed.reviveProgress, 0);
    const needed = Math.max(1, safeNumber(downed.reviveNeeded, 100));
    const progress = clamp(Math.round((current / needed) * 100), 0, 100);
    ui.reviveProgress.textContent = progress > 0 ? `${progress}%` : (isLocal ? "…" : "E");
    if (local && /down|倒/i.test(local.status || "")) clearMovement();
  }

  function maybeShowPhase(stage, boss) {
    const phase = boss?.phase ?? stage.phase ?? "";
    const key = `${stage.index ?? ""}|${stage.id ?? ""}|${stage.status ?? ""}|${phase}`;
    if (!runtime.lastStageKey) {
      runtime.lastStageKey = key;
      return;
    }
    if (key === runtime.lastStageKey) return;
    runtime.lastStageKey = key;
    const status = String(stage.status || "");
    if (/waiting/i.test(status)) return;
    const bossPhase = safeNumber(phase, 0);
    showPhaseBanner(
      bossPhase > 1 ? "首领异变" : "猎场推进",
      bossPhase > 1 ? `雾港之母 · ${chineseNumber(bossPhase)}阶段` : (stage.title || "深入迷雾")
    );
  }

  function showPhaseBanner(eyebrow, title) {
    window.clearTimeout(runtime.phaseTimer);
    ui.phaseEyebrow.textContent = eyebrow;
    ui.phaseTitle.textContent = title;
    ui.phaseBanner.hidden = false;
    runtime.phaseTimer = window.setTimeout(() => { ui.phaseBanner.hidden = true; }, 2600);
  }

  function resultFromStage(stage) {
    const status = String(stage?.status || "").toLowerCase();
    if (status === "stage_complete" || status === "victory") {
      return { status, transitionToken: stage?.transitionToken };
    }
    if (/complete|win/i.test(status)) return { status: "victory", transitionToken: stage?.transitionToken };
    if (/wipe|defeat|fail/i.test(stage?.status || "")) return { status: "wipe" };
    return null;
  }

  function updateResult(result, state) {
    if (!result) {
      runtime.resultShown = false;
      ui.resultOverlay.hidden = true;
      ui.restartBtn.hidden = true;
      return;
    }
    const status = String(result.status || "").toLowerCase();
    const stageComplete = status === "stage_complete";
    const victory = status === "victory" || /win|complete/.test(status);
    const wipe = /wipe|defeat|fail/.test(status);
    const canTransition = stageComplete || status === "victory" || wipe;
    if (!runtime.resultShown) {
      runtime.resultShown = true;
      ui.resultOverlay.hidden = false;
      clearMovement();
    }
    ui.resultEyebrow.innerHTML = `<span></span>${stageComplete ? "STAGE COMPLETE" : victory ? "HUNT COMPLETE" : "COVENANT BROKEN"}<span></span>`;
    ui.resultTitle.textContent = result.title || (stageComplete ? `${state.stage?.title || "本章"}完成` : victory ? "狩猎完成" : "猎团覆灭");
    ui.resultMessage.textContent = result.message || (stageComplete
      ? "本章航路已经贯通。整备完成后，与同伴一同进入下一关。"
      : victory ? "钟声终于盖过了潮声。今夜，雾港得以安眠。" : "迷雾吞没了最后一盏灯。整顿装备，再度签下契约。");
    ui.restartBtn.hidden = !canTransition;
    ui.restartBtn.disabled = runtime.transitionInFlight;
    ui.restartBtn.textContent = stageComplete ? "进入下一关" : wipe ? "立即重整" : "重启远征";
    const legacyElapsedMs = Math.max(0, safeNumber(result.durationMs ?? result.elapsedMs ?? state.elapsedMs, 0));
    const elapsedSeconds = Math.max(0, safeNumber(result.elapsed ?? state.progress?.elapsed, legacyElapsedMs / 1000));
    const totals = playersFrom(state).reduce((summary, player) => ({
      kills: summary.kills + Math.max(0, Math.floor(safeNumber(player.kills, 0))),
      revives: summary.revives + Math.max(0, Math.floor(safeNumber(player.revives, 0)))
    }), { kills: 0, revives: 0 });
    ui.resultTime.textContent = formatDuration(legacyElapsedMs || elapsedSeconds * 1000);
    ui.resultKills.textContent = String(Math.max(0, Math.floor(safeNumber(result.kills ?? result.defeated ?? state.stats?.kills, totals.kills))));
    ui.resultRevives.textContent = String(Math.max(0, Math.floor(safeNumber(result.revives ?? state.stats?.revives, totals.revives))));
  }

  function chineseStage(index) {
    const value = Math.max(1, index || 1);
    return `第${chineseNumber(value)}幕`;
  }

  function chineseNumber(value) {
    return ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"][clamp(Math.round(value), 0, 9)] || String(value);
  }

  function objectiveText(kind) {
    const text = String(kind || "").toLowerCase();
    if (text.includes("kill") || text.includes("hunt")) return "肃清雾兽";
    if (text.includes("boss")) return "击败雾港之母";
    if (text.includes("survive")) return "守住雾灯";
    if (text.includes("interact") || text.includes("seal")) return "激活猎团封印";
    return "追随引路钟声";
  }

  function enemyLabel(type) {
    const value = String(type || "").toLowerCase();
    if (/mother|boss|colossus|母/.test(value)) return "雾港之母";
    if (/guard|tide|brute|守卫/.test(value)) return "深潮守卫";
    if (/lantern|spitter|siren|骸/.test(value)) return "灯骸";
    if (/claw|beast|爪/.test(value)) return "雾爪兽";
    return "雾中异兽";
  }

  function formatDuration(value) {
    const milliseconds = safeNumber(value, 0);
    if (milliseconds <= 0) return "--:--";
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  async function restartHunt() {
    if (!runtime.session || runtime.transitionInFlight) return;
    const status = String(runtime.snapshot?.stage?.status || "").toLowerCase();
    const resultStatus = String(runtime.snapshot?.result?.status || "").toLowerCase();
    const recovering = status === "resetting" && /wipe|defeat|fail/.test(resultStatus);
    if (!['stage_complete', 'victory'].includes(status) && !recovering) return;
    const transitionToken = runtime.snapshot?.stage?.transitionToken || runtime.snapshot?.result?.transitionToken;
    if (!recovering && !transitionToken) {
      showToast("换关凭证尚未同步，请稍候", true);
      return;
    }
    runtime.transitionInFlight = true;
    ui.restartBtn.disabled = true;
    setLoading(true, recovering ? "正在整顿猎团装备…" : status === "stage_complete" ? "正在开启下一道潮路…" : "正在重启远征航路…");
    try {
      const data = await request(`/api/rooms/${encodeURIComponent(runtime.session.roomCode)}/restart`, {
        method: "POST",
        body: JSON.stringify(credentials(recovering ? {} : { transitionToken }))
      });
      runtime.resultShown = false;
      runtime.lastStageKey = "";
      ui.resultOverlay.hidden = true;
      if (data?.state || data?.snapshot) handleSnapshot(data.state || data.snapshot);
      const action = data?.action;
      const message = data?.alreadyApplied
        ? "航路状态已与猎团同步"
        : action === "advance" ? "下一关航路已经开启" : action === "recover" ? "猎团已回到营地" : "新的远征已经开始";
      showToast(message);
    } catch (error) {
      showToast(friendlyError(error, "暂时无法切换航路"), true);
    } finally {
      runtime.transitionInFlight = false;
      const currentStatus = String(runtime.snapshot?.stage?.status || "").toLowerCase();
      const currentResultStatus = String(runtime.snapshot?.result?.status || "").toLowerCase();
      const canRetry = currentStatus === "resetting" && /wipe|defeat|fail/.test(currentResultStatus);
      ui.restartBtn.disabled = !["stage_complete", "victory"].includes(currentStatus) && !canRetry;
      setLoading(false);
    }
  }

  function leaveHunt() {
    runtime.leaving = true;
    closeConnection();
    stopInputLoop();
    releaseStageSpecificAssets(runtime.stageVisualKey);
    runtime.session = null;
    runtime.snapshot = null;
    runtime.snapshotBuffer.length = 0;
    runtime.localVisual = null;
    runtime.camera = null;
    runtime.cameraView = null;
    runtime.knownZones.clear();
    runtime.animationClocks.clear();
    runtime.stageVisualKey = "";
    runtime.lastPredictionMove = { x: 0, y: 0 };
    runtime.localStoppedAt = 0;
    runtime.lastFrameAt = 0;
    runtime.resultShown = false;
    runtime.transitionInFlight = false;
    clearMovement();
    clearMinimap();
    document.body.classList.remove("is-playing");
    try { sessionStorage.removeItem(sessionStorageKey); } catch {}
    ui.resultOverlay.hidden = true;
    ui.waitOverlay.hidden = true;
    ui.gameView.hidden = true;
    ui.lobbyView.hidden = false;
    ui.roomCodeInput.value = "";
    showContractPanel();
  }

  async function copyRoomCode() {
    const code = runtime.session?.roomCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const temp = document.createElement("textarea");
      temp.value = code;
      temp.setAttribute("readonly", "");
      temp.style.position = "fixed";
      temp.style.opacity = "0";
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      temp.remove();
    }
    showToast(`房间码 ${code} 已复制`);
  }

  /* Input */
  function updateKeyboardMovement() {
    const left = keys.has("KeyA") || keys.has("ArrowLeft");
    const right = keys.has("KeyD") || keys.has("ArrowRight");
    const up = keys.has("KeyW") || keys.has("ArrowUp");
    const down = keys.has("KeyS") || keys.has("ArrowDown");
    let x = Number(right) - Number(left);
    let y = Number(down) - Number(up);
    const length = Math.hypot(x, y) || 1;
    controls.move.x = x / length;
    controls.move.y = y / length;
  }

  function onKeyDown(event) {
    if (ui.gameView.hidden || event.target instanceof HTMLInputElement || stageBlocksInput()) return;
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
      keys.add(event.code);
      updateKeyboardMovement();
      event.preventDefault();
    }
    if (["Space", "KeyJ"].includes(event.code)) {
      controls.attack = true;
      event.preventDefault();
    }
    if (["KeyE", "KeyK"].includes(event.code)) {
      controls.interact = true;
      event.preventDefault();
    }
    if (["ShiftLeft", "ShiftRight"].includes(event.code)) {
      controls.dodge = true;
      event.preventDefault();
    }
  }

  function onKeyUp(event) {
    keys.delete(event.code);
    updateKeyboardMovement();
    if (["Space", "KeyJ"].includes(event.code)) controls.attack = false;
    if (["KeyE", "KeyK"].includes(event.code)) controls.interact = false;
    if (["ShiftLeft", "ShiftRight"].includes(event.code)) controls.dodge = false;
  }

  function clearMovement() {
    keys.clear();
    if (Math.hypot(controls.move.x, controls.move.y) >= 0.05) {
      runtime.lastPredictionMove = { ...controls.move };
      runtime.localStoppedAt = performance.now();
    }
    controls.move.x = 0;
    controls.move.y = 0;
    controls.attack = false;
    controls.interact = false;
    controls.dodge = false;
    runtime.joystickPointer = null;
    runtime.attackPointer = null;
    runtime.canvasAttackPointer = null;
    ui.moveKnob.style.transform = "translate(-50%, -50%)";
    ui.touchAttack.classList.remove("is-pressed");
    ui.touchAttack.style.transform = "translate(0, 0)";
    ui.touchInteract.classList.remove("is-pressed");
    ui.touchDodge.classList.remove("is-pressed");
  }

  function updateAimFromPointer(event) {
    const rect = runtime.canvasRect || ui.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pointerX = clamp(event.clientX - rect.left, 0, rect.width);
    const pointerY = clamp(event.clientY - rect.top, 0, rect.height);
    const local = playersFrom().find((player) => player.id === runtime.session?.playerId);
    const worldPointer = runtime.cameraView
      ? screenToWorld({ x: pointerX, y: pointerY }, runtime.cameraView)
      : { x: pointerX, y: pointerY };
    const dx = safeNumber(worldPointer.x) - safeNumber(local?.x, worldPointer.x - 1);
    const dy = safeNumber(worldPointer.y) - safeNumber(local?.y, worldPointer.y);
    const length = Math.hypot(dx, dy);
    if (length > 3) {
      controls.aim.x = dx / length;
      controls.aim.y = dy / length;
    }
  }

  function bindHoldButton(button, property) {
    const release = (event) => {
      event.preventDefault();
      controls[property] = false;
      button.classList.remove("is-pressed");
      try { button.releasePointerCapture(event.pointerId); } catch {}
    };
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (stageBlocksInput()) return;
      controls[property] = true;
      button.classList.add("is-pressed");
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener("pointermove", (event) => event.preventDefault());
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", () => {
      controls[property] = false;
      button.classList.remove("is-pressed");
    });
  }

  function updateAimFromAttackControl(event) {
    const rect = runtime.attackRect || ui.touchAttack.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const length = Math.hypot(dx, dy);
    if (length > Math.max(8, rect.width * 0.12)) {
      controls.aim.x = dx / length;
      controls.aim.y = dy / length;
    }
    const maximum = rect.width * .16;
    const amount = length > maximum && length > 0 ? maximum / length : 1;
    ui.touchAttack.style.transform = `translate(${dx * amount}px, ${dy * amount}px)`;
  }

  function aimAtNearestEnemy() {
    const local = playersFrom().find((player) => player.id === runtime.session?.playerId);
    if (!local) return;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const enemy of enemiesFrom()) {
      if (safeNumber(enemy.hp, 1) <= 0 || /dead|defeat/i.test(String(enemy.status || ""))) continue;
      const dx = safeNumber(enemy.x) - safeNumber(local.x);
      const dy = safeNumber(enemy.y) - safeNumber(local.y);
      const distance = Math.hypot(dx, dy);
      if (distance > 0 && distance < Math.min(nearestDistance, 760)
        && (!runtime.cameraView || isWorldPointVisible(enemy, runtime.cameraView, 120))) {
        nearest = { dx, dy };
        nearestDistance = distance;
      }
    }
    if (nearest) {
      controls.aim.x = nearest.dx / nearestDistance;
      controls.aim.y = nearest.dy / nearestDistance;
    }
  }

  function bindAttackButton(surface, visual = surface) {
    const release = (event) => {
      if (event.pointerId !== runtime.attackPointer) return;
      event.preventDefault();
      runtime.attackPointer = null;
      controls.attack = false;
      visual.classList.remove("is-pressed");
      visual.style.transform = "translate(0, 0)";
      try { surface.releasePointerCapture(event.pointerId); } catch {}
    };
    surface.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (stageBlocksInput()) return;
      runtime.attackPointer = event.pointerId;
      runtime.attackRect = surface.getBoundingClientRect();
      controls.attack = true;
      visual.classList.add("is-pressed");
      surface.setPointerCapture(event.pointerId);
      aimAtNearestEnemy();
      updateAimFromAttackControl(event);
    });
    surface.addEventListener("pointermove", (event) => {
      if (event.pointerId !== runtime.attackPointer) return;
      event.preventDefault();
      updateAimFromAttackControl(event);
    });
    surface.addEventListener("pointerup", release);
    surface.addEventListener("pointercancel", release);
    surface.addEventListener("lostpointercapture", () => {
      runtime.attackPointer = null;
      controls.attack = false;
      visual.classList.remove("is-pressed");
      visual.style.transform = "translate(0, 0)";
    });
  }

  function updateJoystick(event) {
    event.preventDefault();
    const rect = runtime.moveStickRect || ui.moveStick.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const maxDistance = rect.width * 0.31;
    const distance = Math.hypot(dx, dy);
    const scale = distance > maxDistance ? maxDistance / distance : 1;
    const limitedX = dx * scale;
    const limitedY = dy * scale;
    controls.move.x = clamp(dx / maxDistance, -1, 1);
    controls.move.y = clamp(dy / maxDistance, -1, 1);
    const magnitude = Math.hypot(controls.move.x, controls.move.y);
    if (magnitude > 1) {
      controls.move.x /= magnitude;
      controls.move.y /= magnitude;
    }
    ui.moveKnob.style.transform = `translate(calc(-50% + ${limitedX}px), calc(-50% + ${limitedY}px))`;
  }

  function startInputLoop() {
    stopInputLoop();
    runtime.inputTimer = window.setInterval(sendInput, 50);
  }

  function stopInputLoop() {
    window.clearInterval(runtime.inputTimer);
    runtime.inputTimer = 0;
    runtime.inputInFlight = false;
  }

  async function sendInput() {
    if (!runtime.session || runtime.resultShown || runtime.snapshot?.stage?.status === "waiting") return;
    if (stageBlocksInput()) {
      clearMovement();
      return;
    }
    const input = {
      seq: ++runtime.inputSeq,
      move: { x: roundInput(controls.move.x), y: roundInput(controls.move.y) },
      aim: { x: roundInput(controls.aim.x), y: roundInput(controls.aim.y) },
      attack: controls.attack,
      interact: controls.interact,
      dodge: controls.dodge
    };
    const payload = credentials(input);
    const signature = JSON.stringify(input, ["move", "aim", "attack", "interact", "dodge", "x", "y"]);
    const now = Date.now();
    if (signature === runtime.lastInputSignature && now - runtime.lastInputAt < 450) return;

    if (socketIsOpen()) {
      try {
        runtime.socket.send(JSON.stringify({ type: "input", ...input }));
        runtime.lastInputSignature = signature;
        runtime.lastInputAt = now;
        return;
      } catch {
        startLegacyTransport();
        try { runtime.socket?.close(); } catch {}
      }
    }

    if (runtime.inputInFlight) return;
    runtime.lastInputSignature = signature;
    runtime.lastInputAt = now;
    runtime.inputInFlight = true;
    try {
      await request(`/api/rooms/${encodeURIComponent(runtime.session.roomCode)}/input`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
    } catch (error) {
      if (!runtime.leaving) setConnection("offline", "指令延迟，正在重连…");
    } finally {
      runtime.inputInFlight = false;
    }
  }

  function roundInput(value) {
    return Math.round(clamp(safeNumber(value), -1, 1) * 1000) / 1000;
  }

  /* Canvas */
  function resizeCanvas() {
    const rect = ui.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = selectCanvasDpr(window.devicePixelRatio || 1, runtime.coarsePointer);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (ui.canvas.width !== width || ui.canvas.height !== height) {
      ui.canvas.width = width;
      ui.canvas.height = height;
    }
    runtime.canvasWidth = rect.width;
    runtime.canvasHeight = rect.height;
    runtime.dpr = dpr;
    runtime.canvasRect = rect;
    runtime.moveStickRect = null;
    runtime.attackRect = null;
  }

  function renderFrame(time) {
    window.requestAnimationFrame(renderFrame);
    if (ui.gameView.hidden || !ctx) {
      runtime.lastFrameAt = 0;
      return;
    }
    const dt = runtime.lastFrameAt ? clamp((time - runtime.lastFrameAt) / 1000, 0, 0.05) : 0;
    runtime.lastFrameAt = time;
    const width = runtime.canvasWidth;
    const height = runtime.canvasHeight;
    ctx.setTransform(runtime.dpr, 0, 0, runtime.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!runtime.snapshot) {
      drawArena(null, null, width, height, time);
      drawCanvasText("正在穿过雾港边界…", width / 2, height / 2, 15);
      return;
    }
    let renderState = interpolateSnapshot(runtime.snapshotBuffer, time, 100) || runtime.snapshot;
    const local = playersFrom(runtime.snapshot).find((player) => player.id === runtime.session?.playerId);
    if (local?.status === "active") {
      const moveMagnitude = Math.hypot(controls.move.x, controls.move.y);
      if (moveMagnitude >= 0.05) {
        runtime.lastPredictionMove = { ...controls.move };
        runtime.localStoppedAt = 0;
      } else if (!runtime.localStoppedAt && Math.hypot(runtime.lastPredictionMove.x, runtime.lastPredictionMove.y) >= 0.05) {
        runtime.localStoppedAt = time;
      }
      const snapshotAge = Date.now() - runtime.lastStateAt;
      if (snapshotAge > MAX_LOCAL_PREDICTION_LEAD_MS) {
        runtime.localVisual = reconcileLocalPosition(runtime.localVisual, local, { x: 0, y: 0 }, 1);
      } else {
        runtime.localVisual = predictLocalPosition(runtime.localVisual || local, {
          move: controls.move,
          role: local.role,
          dt,
          radius: local.radius,
          arena: runtime.snapshot.arena,
          obstacles: runtime.snapshot.obstacles,
        });
      }
      renderState = {
        ...renderState,
        players: playersFrom(renderState).map((player) => player.id === local.id ? {
          ...player,
          x: runtime.localVisual.x,
          y: runtime.localVisual.y,
          facing: Math.hypot(controls.aim.x, controls.aim.y) > 0.1 ? { ...controls.aim } : player.facing,
          action: controls.attack ? "attack" : player.action,
        } : player),
      };
    }
    const renderLocal = playersFrom(renderState).find((player) => player.id === runtime.session?.playerId) || local;
    const arena = renderState.arena || {};
    const world = {
      width: Math.max(1, safeNumber(arena.width, 1280)),
      height: Math.max(1, safeNumber(arena.height, 720)),
      padding: Math.max(0, safeNumber(arena.padding, 0)),
    };
    const logicalWidth = Math.max(720, safeNumber(arena.viewportWidth, 1280));
    const logicalHeight = Math.max(480, safeNumber(arena.viewportHeight, 720));
    const desiredScale = Math.max(width / logicalWidth, height / logicalHeight);
    const target = renderLocal || { x: world.width / 2, y: world.height / 2 };
    if (!runtime.camera) {
      runtime.camera = computeCameraViewport(
        { x: target.x, y: target.y, scale: desiredScale },
        { width, height },
        world,
      );
    }
    runtime.camera = updateFollowCamera(runtime.camera, target, dt, {
      world,
      viewport: { width, height },
      scale: desiredScale,
      stiffness: 10,
    });
    runtime.cameraView = runtime.camera;
    drawArena(renderState, runtime.camera, width, height, time);
    drawWorld(renderState, runtime.camera, width, height, time);
    drawMistOfWar(renderState, runtime.camera, width, height, time);
    drawOffscreenIndicators(renderState, runtime.camera, width, height);
    if (time - runtime.lastMinimapAt >= 120) {
      drawMinimap(renderState);
      runtime.lastMinimapAt = time;
    }
  }

  function drawArena(state, camera, width, height, time) {
    if (!state || !camera) {
      const gradient = ctx.createRadialGradient(width * 0.5, height * 0.45, 10, width * 0.5, height * 0.5, width * 0.8);
      gradient.addColorStop(0, "#fff8e7");
      gradient.addColorStop(0.62, "#d6eee7");
      gradient.addColorStop(1, "#70c8cb");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      return;
    }

    ctx.fillStyle = "#b9e4df";
    ctx.fillRect(0, 0, width, height);
    drawStageTiles(state, camera);

    if (runtime.debugCollision) {
      drawZoneLandmarks(state, camera);
      drawObstacles(state, camera);
    }
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = "#fffaf0";
    for (let i = 0; i < 10; i += 1) {
      const x = ((i * 197 + time * 0.007) % (width + 180)) - 90;
      const y = height * (0.08 + ((i * 41) % 84) / 100);
      ctx.beginPath();
      ctx.ellipse(x, y, 55 + (i % 3) * 20, 5 + (i % 2) * 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function stageTilePath(stageKey, row, column) {
    const config = stageWorldRegistry[stageKey] || stageWorldRegistry["stage-01"];
    return `assets/world/${stageKey}/map-r${row}-c${column}-${config.version}.webp`;
  }

  function stageTileDescriptor(stageKey, row, column) {
    const config = stageWorldRegistry[stageKey] || stageWorldRegistry["stage-01"];
    return {
      key: `${stageKey}:${row}:${column}`,
      stageKey,
      row,
      column,
      x: column * config.tileWidth,
      y: row * config.tileHeight,
      width: config.tileWidth,
      height: config.tileHeight
    };
  }

  function desiredStageTiles(state, camera) {
    const stageKey = stageVisualKeyFrom(state);
    const config = stageWorldRegistry[stageKey] || stageWorldRegistry["stage-01"];
    const world = state.arena || {
      width: config.tileWidth * MAP_TILE_COLUMNS,
      height: config.tileHeight * MAP_TILE_ROWS
    };
    const range = visibleTileRange(camera, config.tileWidth, config.tileHeight, world);
    const visible = [];
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let column = range.startColumn; column <= range.endColumn; column += 1) {
        visible.push(stageTileDescriptor(stageKey, row, column));
      }
    }
    visible.sort((left, right) => {
      const leftDistance = Math.hypot(left.x + left.width / 2 - camera.x, left.y + left.height / 2 - camera.y);
      const rightDistance = Math.hypot(right.x + right.width / 2 - camera.x, right.y + right.height / 2 - camera.y);
      return leftDistance - rightDistance;
    });
    const limitedVisible = visible.slice(0, MAX_VISIBLE_TILES);
    const visibleKeys = new Set(limitedVisible.map((tile) => tile.key));
    const movement = Math.hypot(controls.move.x, controls.move.y) > 0.05 ? controls.move : runtime.lastPredictionMove;
    const targetX = camera.x + safeNumber(movement.x) * config.tileWidth * 0.72;
    const targetY = camera.y + safeNumber(movement.y) * config.tileHeight * 0.72;
    const neighbors = [];
    for (const tile of limitedVisible) {
      for (const [rowOffset, columnOffset] of [[-1, 0], [0, 1], [1, 0], [0, -1]]) {
        const row = tile.row + rowOffset;
        const column = tile.column + columnOffset;
        if (row < 0 || row >= MAP_TILE_ROWS || column < 0 || column >= MAP_TILE_COLUMNS) continue;
        const candidate = stageTileDescriptor(stageKey, row, column);
        if (!visibleKeys.has(candidate.key)) neighbors.push(candidate);
      }
    }
    const uniqueNeighbors = [...new Map(neighbors.map((tile) => [tile.key, tile])).values()];
    uniqueNeighbors.sort((left, right) => (
      Math.hypot(left.x + left.width / 2 - targetX, left.y + left.height / 2 - targetY)
      - Math.hypot(right.x + right.width / 2 - targetX, right.y + right.height / 2 - targetY)
    ));
    return { visible: limitedVisible, prefetch: uniqueNeighbors[0] || null };
  }

  function syncStageTileCache(state, camera) {
    const desired = desiredStageTiles(state, camera);
    const retained = [...desired.visible, ...(desired.prefetch ? [desired.prefetch] : [])];
    const retainedKeys = new Set(retained.map((tile) => tile.key));
    for (const [key, cached] of runtime.stageTileCache) {
      if (retainedKeys.has(key)) continue;
      cached.asset.release();
      runtime.stageTileCache.delete(key);
    }
    for (const tile of retained.slice(0, MAX_STAGE_TILE_CACHE)) {
      let cached = runtime.stageTileCache.get(tile.key);
      if (!cached) {
        cached = {
          ...tile,
          asset: loadImage(stageTilePath(tile.stageKey, tile.row, tile.column), { lazy: true })
        };
        runtime.stageTileCache.set(tile.key, cached);
      }
      cached.asset.load();
    }
    return desired.visible.map((tile) => runtime.stageTileCache.get(tile.key)).filter(Boolean);
  }

  function drawStageTiles(state, camera) {
    for (const tile of syncStageTileCache(state, camera)) {
      const topLeft = worldToScreen(tile, camera);
      const width = tile.width * camera.scale + 1;
      const height = tile.height * camera.scale + 1;
      if (tile.asset.ready && tile.asset.image) {
        ctx.drawImage(tile.asset.image, 0, 0, tile.asset.image.naturalWidth, tile.asset.image.naturalHeight, topLeft.x, topLeft.y, width, height);
      } else {
        drawMapTileFallback(tile, topLeft.x, topLeft.y, width, height);
      }
    }
  }

  function drawMapTileFallback(tile, x, y, width, height) {
    const failed = tile.asset.failed;
    const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
    gradient.addColorStop(0, failed ? "#d49b78" : "#d9eee3");
    gradient.addColorStop(1, failed ? "#7ba8a4" : "#8dcac2");
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, width, height);
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = "#173f4a";
    ctx.lineWidth = 1;
    const spacing = Math.max(24, 58 * runtime.cameraView.scale);
    for (let offset = -height; offset < width; offset += spacing) {
      ctx.beginPath();
      ctx.moveTo(x + offset, y + height);
      ctx.lineTo(x + offset + height, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function obstacleGeometry(obstacle) {
    if (obstacle.shape === "circle") {
      const radius = Math.max(1, safeNumber(obstacle.radius, 40));
      return {
        centerX: safeNumber(obstacle.x),
        centerY: safeNumber(obstacle.y),
        footprintWidth: radius * 2,
        footprintHeight: radius * 2,
        bottom: safeNumber(obstacle.y) + radius,
        radius
      };
    }
    const width = Math.max(1, safeNumber(obstacle.width, 80));
    const height = Math.max(1, safeNumber(obstacle.height, 80));
    return {
      centerX: safeNumber(obstacle.x) + width / 2,
      centerY: safeNumber(obstacle.y) + height / 2,
      footprintWidth: width,
      footprintHeight: height,
      bottom: safeNumber(obstacle.y) + height,
      radius: Math.hypot(width, height) / 2
    };
  }

  function commonTerrainCell(obstacle) {
    const visualKind = String(obstacle.visualKind || "pillar").toLowerCase();
    const identity = `${obstacle.id || ""} ${obstacle.kind || ""}`.toLowerCase();
    if (visualKind === "stall" && (/shack/.test(identity) || /supply-hut/.test(identity))) {
      return { column: 0, row: 0, columns: 4, rows: 2 };
    }
    if (visualKind === "bridge" && /skiff/.test(identity)) {
      return { column: 2, row: 0, columns: 4, rows: 2 };
    }
    return commonTerrainCells[visualKind] || commonTerrainCells.pillar;
  }

  function terrainAtlasFrame(obstacle) {
    const stageKey = runtime.stageVisualKey || stageVisualKeyFrom(runtime.snapshot);
    const visualKind = String(obstacle.visualKind || "pillar").toLowerCase();
    const overrideCell = stageTerrainCells[stageKey]?.[visualKind];
    const overrideAsset = overrideCell ? terrainAssets[stageKey] : null;
    if (overrideAsset) {
      overrideAsset.load();
      if (overrideAsset.ready && overrideAsset.image) return { asset: overrideAsset, cell: overrideCell };
    }
    terrainAssets.common.load();
    if (terrainAssets.common.ready && terrainAssets.common.image) {
      return { asset: terrainAssets.common, cell: commonTerrainCell(obstacle) };
    }
    return null;
  }

  function drawTerrainObstacle(obstacle, camera) {
    const geometry = obstacleGeometry(obstacle);
    const anchor = worldToScreen({ x: geometry.centerX, y: geometry.bottom }, camera);
    const visualKind = String(obstacle.visualKind || "pillar").toLowerCase();
    const wide = ["wall", "bridge"].includes(visualKind);
    const worldDrawWidth = clamp(geometry.footprintWidth * (wide ? 1.24 : 1.42), 120, 560);
    const worldDrawHeight = Math.max(geometry.footprintHeight * (wide ? 1.8 : 2.25), worldDrawWidth * (wide ? 0.56 : 0.82));
    const drawWidth = worldDrawWidth * camera.scale;
    const drawHeight = worldDrawHeight * camera.scale;
    const frame = terrainAtlasFrame(obstacle);
    if (frame) {
      const image = frame.asset.image;
      const sourceWidth = image.naturalWidth / frame.cell.columns;
      const sourceHeight = image.naturalHeight / frame.cell.rows;
      ctx.drawImage(
        image,
        frame.cell.column * sourceWidth,
        frame.cell.row * sourceHeight,
        sourceWidth,
        sourceHeight,
        anchor.x - drawWidth / 2,
        anchor.y - drawHeight,
        drawWidth,
        drawHeight
      );
      return;
    }
    drawTerrainFallback(obstacle, anchor.x, anchor.y, drawWidth, drawHeight);
  }

  function drawTerrainFallback(obstacle, x, y, width, height) {
    const visualKind = String(obstacle.visualKind || "pillar").toLowerCase();
    const palette = {
      rock: ["#577f82", "#d6eee7"],
      wall: ["#b56c40", "#ffe0b4"],
      bridge: ["#785947", "#e7aa86"],
      stall: ["#c64f40", "#f4bd45"],
      tower: ["#176f7d", "#fff3cf"],
      gate: ["#176f7d", "#f4bd45"],
      pillar: ["#577f82", "#fff3cf"]
    }[visualKind] || ["#577f82", "#fff3cf"];
    ctx.save();
    ctx.globalAlpha = 0.96;
    ctx.fillStyle = palette[0];
    ctx.beginPath();
    ctx.moveTo(x - width * 0.42, y);
    ctx.quadraticCurveTo(x - width * 0.5, y - height * 0.42, x - width * 0.22, y - height * 0.72);
    ctx.quadraticCurveTo(x, y - height, x + width * 0.24, y - height * 0.7);
    ctx.quadraticCurveTo(x + width * 0.5, y - height * 0.38, x + width * 0.42, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = palette[1];
    ctx.globalAlpha = 0.82;
    ctx.font = `900 ${clamp(width * 0.16, 11, 26)}px ${canvasSans}`;
    ctx.textAlign = "center";
    ctx.fillText(obstacle.name || "地标", x, y - height * 0.28, width * 0.74);
    ctx.restore();
  }

  function drawObstacles(state, camera) {
    const obstacles = collectionFrom(state.obstacles);
    for (const obstacle of obstacles) {
      const center = obstacle.shape === "circle"
        ? { x: safeNumber(obstacle.x), y: safeNumber(obstacle.y) }
        : { x: safeNumber(obstacle.x) + safeNumber(obstacle.width) / 2, y: safeNumber(obstacle.y) + safeNumber(obstacle.height) / 2 };
      const radius = obstacle.shape === "circle"
        ? safeNumber(obstacle.radius, 40)
        : Math.hypot(safeNumber(obstacle.width), safeNumber(obstacle.height)) / 2;
      if (!isWorldPointVisible(center, camera, radius + 40)) continue;
      const point = worldToScreen(center, camera);
      ctx.save();
      ctx.fillStyle = "rgba(23,63,74,.26)";
      ctx.strokeStyle = "rgba(255,243,207,.44)";
      ctx.lineWidth = clamp(camera.scale * 2, 1, 4);
      if (obstacle.shape === "circle") {
        ctx.beginPath();
        ctx.arc(point.x, point.y, Math.max(3, safeNumber(obstacle.radius) * camera.scale), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        const width = safeNumber(obstacle.width) * camera.scale;
        const height = safeNumber(obstacle.height) * camera.scale;
        ctx.fillRect(point.x - width / 2, point.y - height / 2, width, height);
        ctx.strokeRect(point.x - width / 2, point.y - height / 2, width, height);
      }
      ctx.restore();
    }
  }

  function drawZoneLandmarks(state, camera) {
    const zones = zonesFrom(state);
    zones.forEach((zone, index) => {
      const bounds = zoneBounds(zone, state);
      if (!isWorldPointVisible({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, camera, Math.max(bounds.width, bounds.height) / 2)) return;
      const topLeft = worldToScreen({ x: bounds.x, y: bounds.y }, camera);
      const width = bounds.width * camera.scale;
      const height = bounds.height * camera.scale;
      const palette = ["rgba(244,189,69,.08)", "rgba(125,178,152,.11)", "rgba(44,154,174,.1)", "rgba(233,103,78,.08)", "rgba(23,63,74,.14)"];
      ctx.save();
      ctx.fillStyle = palette[index % palette.length];
      ctx.fillRect(topLeft.x, topLeft.y, width, height);
      ctx.strokeStyle = "rgba(23,63,74,.2)";
      ctx.lineWidth = Math.max(1, camera.scale * 2);
      ctx.setLineDash([16 * camera.scale, 12 * camera.scale]);
      ctx.strokeRect(topLeft.x + 5, topLeft.y + 5, width - 10, height - 10);
      ctx.setLineDash([]);
      const center = worldToScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, camera);
      ctx.fillStyle = "rgba(255,248,231,.76)";
      ctx.font = `800 ${clamp(17 * camera.scale, 10, 19)}px ${canvasSans}`;
      ctx.textAlign = "center";
      ctx.fillText(zone.name || zone.title || `区域 ${index + 1}`, center.x, center.y);
      ctx.restore();
    });

    const world = state.arena || {};
    const route = [
      { x: safeNumber(world.width, 1280) * .09, y: safeNumber(world.height, 720) * .86 },
      { x: safeNumber(world.width, 1280) * .28, y: safeNumber(world.height, 720) * .65 },
      { x: safeNumber(world.width, 1280) * .47, y: safeNumber(world.height, 720) * .7 },
      { x: safeNumber(world.width, 1280) * .57, y: safeNumber(world.height, 720) * .35 },
      { x: safeNumber(world.width, 1280) * .9, y: safeNumber(world.height, 720) * .16 },
    ];
    ctx.save();
    ctx.strokeStyle = "rgba(255,243,207,.52)";
    ctx.lineWidth = clamp(52 * camera.scale, 18, 60);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    route.forEach((point, index) => {
      const screen = worldToScreen(point, camera);
      if (index) ctx.lineTo(screen.x, screen.y); else ctx.moveTo(screen.x, screen.y);
    });
    ctx.stroke();
    ctx.strokeStyle = "rgba(181,108,64,.35)";
    ctx.lineWidth = clamp(3 * camera.scale, 1, 4);
    ctx.setLineDash([13, 17]);
    ctx.stroke();
    ctx.restore();
  }

  function drawWorld(state, camera, width, height, time) {
    const project = (entity) => worldToScreen(entity, camera);

    const local = playersFrom(state).find((player) => player.id === runtime.session?.playerId);
    if (local && local.status !== "downed") drawAimGuide(local, camera);

    drawCollectibles(state, camera, time);
    drawEffects(state.effects, camera, time);

    const terrainEntities = collectionFrom(state.obstacles).map((obstacle) => {
      const geometry = obstacleGeometry(obstacle);
      return {
        ...obstacle,
        x: geometry.centerX,
        y: geometry.centerY,
        radius: geometry.radius,
        sortY: geometry.bottom,
        entityKind: "terrain",
        terrainObstacle: obstacle
      };
    });
    const entities = [
      ...terrainEntities,
      ...enemiesFrom(state).map((entity) => ({ ...entity, entityKind: "enemy" })),
      ...playersFrom(state).map((entity) => ({ ...entity, entityKind: "player" }))
    ].filter((entity) => isWorldPointVisible(entity, camera, Math.max(180, safeNumber(entity.radius)))).sort((a, b) => (
      safeNumber(a.sortY, a.y) - safeNumber(b.sortY, b.y)
    ));

    for (const entity of entities) {
      if (entity.entityKind === "terrain") {
        drawTerrainObstacle(entity.terrainObstacle, camera);
        continue;
      }
      const point = project(entity);
      const baseRadius = Math.max(15, safeNumber(entity.radius, entity.entityKind === "player" ? 24 : 21));
      const boss = entity.boss || /mother|boss|母/i.test(String(entity.type || entity.name || ""));
      const size = baseRadius * (boss ? 5.6 : entity.elite ? 4.4 : entity.entityKind === "player" ? 4.1 : 3.8) * camera.scale;
      drawActor(entity, point.x, point.y, size, time);
    }

    for (const projectile of Array.isArray(state.projectiles) ? state.projectiles : []) {
      if (!isWorldPointVisible(projectile, camera, 80)) continue;
      const point = project(projectile);
      const size = Math.max(13, safeNumber(projectile.radius, 7) * 3.2 * camera.scale);
      drawProjectile(projectile, point.x, point.y, size, time);
    }
  }

  function drawAimGuide(player, camera) {
    const origin = worldToScreen(player, camera);
    const facing = player.facing || controls.aim;
    const fx = safeNumber(facing.x, controls.aim.x);
    const fy = safeNumber(facing.y, controls.aim.y);
    const length = isGunner(player.role) ? 145 : 82;
    const targetX = origin.x + fx * length * camera.scale;
    const targetY = origin.y + fy * length * camera.scale;
    ctx.save();
    ctx.strokeStyle = isGunner(player.role) ? "rgba(23, 111, 125, .68)" : "rgba(216, 81, 61, .62)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 7]);
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y - 8);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(targetX, targetY, 8, 0, Math.PI * 2);
    ctx.moveTo(targetX - 12, targetY);
    ctx.lineTo(targetX + 12, targetY);
    ctx.moveTo(targetX, targetY - 12);
    ctx.lineTo(targetX, targetY + 12);
    ctx.stroke();
    ctx.restore();
  }

  function collectionFrom(value) {
    if (Array.isArray(value)) return value;
    return value && typeof value === "object" ? Object.values(value) : [];
  }

  function exitFrom(state) {
    const exit = state?.exit || state?.run?.exit || state?.progress?.exit;
    if (!exit || typeof exit !== "object") return null;
    const position = exit.position || exit;
    return { ...exit, x: safeNumber(position.x), y: safeNumber(position.y) };
  }

  function drawCollectibles(state, camera, time) {
    const collectibles = collectionFrom(state.collectibles).filter((item) => item.available !== false && !item.collected);
    const exit = exitFrom(state);
    if (exit && (exit.discovered || exit.unlocked || exit.open || state.run?.exitUnlocked || state.progress?.exitUnlocked)) {
      collectibles.push({ ...exit, id: exit.id || "expedition-exit", kind: "exit", exit: true });
    }
    for (const item of collectibles) {
      if (!isWorldPointVisible(item, camera, 130)) continue;
      const point = worldToScreen(item, camera);
      const pulse = 1 + Math.sin(time * 0.004 + String(item.id || "").length) * 0.08;
      const size = clamp((item.exit ? 112 : 76) * camera.scale * pulse, 34, item.exit ? 132 : 94);
      ctx.save();
      ctx.globalAlpha = item.available === false ? 0.35 : 1;
      ctx.fillStyle = item.exit ? "rgba(44,154,174,.22)" : "rgba(244,189,69,.24)";
      ctx.beginPath();
      ctx.arc(point.x, point.y, size * .54, 0, Math.PI * 2);
      ctx.fill();
      if (assets.icons.ready) {
        const image = assets.icons.image;
        const sw = image.naturalWidth / 3;
        const sh = image.naturalHeight / 2;
        const index = item.exit ? 3 : 4;
        ctx.drawImage(image, (index % 3) * sw, Math.floor(index / 3) * sh, sw, sh, point.x - size / 2, point.y - size * .72, size, size);
      } else {
        drawCanvasText(item.exit ? "出口" : "印", point.x, point.y, 14);
      }
      ctx.restore();
    }
  }

  function drawMistOfWar(state, camera, width, height) {
    const fog = runtime.fogCanvas;
    const fogWidth = Math.max(1, Math.ceil(width / 4));
    const fogHeight = Math.max(1, Math.ceil(height / 4));
    if (fog.width !== fogWidth) fog.width = fogWidth;
    if (fog.height !== fogHeight) fog.height = fogHeight;
    const fogCtx = fog.getContext("2d");
    if (!fogCtx) return;
    fogCtx.setTransform(1, 0, 0, 1, 0, 0);
    fogCtx.clearRect(0, 0, fogWidth, fogHeight);
    fogCtx.fillStyle = "rgba(23,63,74,.36)";
    fogCtx.fillRect(0, 0, fogWidth, fogHeight);

    fogCtx.save();
    fogCtx.globalCompositeOperation = "destination-out";
    for (const player of playersFrom(state)) {
      if (player.connected === false) continue;
      const point = worldToScreen(player, camera);
      const x = point.x / 4;
      const y = point.y / 4;
      const radius = clamp(500 * camera.scale / 4, 68, 160);
      const reveal = fogCtx.createRadialGradient(x, y, radius * .38, x, y, radius);
      reveal.addColorStop(0, "rgba(0,0,0,1)");
      reveal.addColorStop(.68, "rgba(0,0,0,.9)");
      reveal.addColorStop(1, "rgba(0,0,0,0)");
      fogCtx.fillStyle = reveal;
      fogCtx.beginPath();
      fogCtx.arc(x, y, radius, 0, Math.PI * 2);
      fogCtx.fill();
    }
    fogCtx.restore();

    const zones = zonesFrom(state);
    fogCtx.save();
    fogCtx.fillStyle = "rgba(13,42,47,.56)";
    zones.forEach((zone, index) => {
      const id = zoneIdentifier(zone, index);
      if (runtime.knownZones.has(id) || zone.discovered || zone.explored || zone.visited) return;
      const bounds = zoneBounds(zone, state);
      const topLeft = worldToScreen({ x: bounds.x, y: bounds.y }, camera);
      fogCtx.fillRect(topLeft.x / 4, topLeft.y / 4, bounds.width * camera.scale / 4, bounds.height * camera.scale / 4);
    });
    fogCtx.restore();
    ctx.drawImage(fog, 0, 0, fogWidth, fogHeight, 0, 0, width, height);
  }

  function drawOffscreenIndicators(state, camera, width, height) {
    const localId = runtime.session?.playerId;
    const candidates = playersFrom(state)
      .filter((player) => player.id !== localId && player.connected !== false)
      .map((player) => ({ point: player, label: /down|倒/i.test(player.status || "") ? "同伴倒下" : "同伴", color: "#2c9aae", priority: 2 }));
    const exit = exitFrom(state);
    const exitKnown = exit && (exit.discovered || exit.unlocked || exit.open || state.run?.exitUnlocked || state.progress?.exitUnlocked);
    if (exitKnown) candidates.push({ point: exit, label: exit.unlocked || exit.open ? "出口" : "雾门", color: "#f4bd45", priority: 1 });
    candidates.sort((a, b) => b.priority - a.priority);
    for (const candidate of candidates) {
      const marker = computeEdgeIndicator(candidate.point, camera, runtime.coarsePointer ? 62 : 42);
      if (!marker) continue;
      ctx.save();
      ctx.translate(marker.x, marker.y);
      ctx.rotate(marker.angle);
      ctx.fillStyle = candidate.color;
      ctx.strokeStyle = "rgba(23,63,74,.88)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(13, 0);
      ctx.lineTo(-8, -9);
      ctx.lineTo(-5, 0);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.font = `800 10px ${canvasSans}`;
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,248,231,.96)";
      ctx.strokeStyle = "rgba(23,63,74,.9)";
      ctx.lineWidth = 3;
      const label = `${candidate.label} ${Math.max(1, Math.round(marker.distance / 10) * 10)}m`;
      ctx.strokeText(label, marker.x, clamp(marker.y + 22, 14, height - 8));
      ctx.fillText(label, marker.x, clamp(marker.y + 22, 14, height - 8));
      ctx.restore();
    }
  }

  function drawMinimap(state) {
    if (!minimapCtx || !ui.minimap) return;
    const width = ui.minimap.width;
    const height = ui.minimap.height;
    const world = state.arena || {};
    const worldWidth = Math.max(1, safeNumber(world.width, 1280));
    const worldHeight = Math.max(1, safeNumber(world.height, 720));
    const sx = width / worldWidth;
    const sy = height / worldHeight;
    minimapCtx.fillStyle = "#173f4a";
    minimapCtx.fillRect(0, 0, width, height);
    zonesFrom(state).forEach((zone, index) => {
      const bounds = zoneBounds(zone, state);
      const known = runtime.knownZones.has(zoneIdentifier(zone, index)) || zone.discovered || zone.explored || zone.visited;
      minimapCtx.fillStyle = known ? ["#ffe0b4", "#b9e4df", "#8fd0cb", "#f4bd45", "#e7aa86"][index % 5] : "#244f59";
      minimapCtx.fillRect(bounds.x * sx, bounds.y * sy, Math.max(2, bounds.width * sx), Math.max(2, bounds.height * sy));
      minimapCtx.strokeStyle = "rgba(23,63,74,.55)";
      minimapCtx.strokeRect(bounds.x * sx, bounds.y * sy, Math.max(2, bounds.width * sx), Math.max(2, bounds.height * sy));
    });
    const exit = exitFrom(state);
    if (exit && (exit.discovered || exit.unlocked || exit.open || state.run?.exitUnlocked || state.progress?.exitUnlocked)) {
      minimapCtx.fillStyle = "#f4bd45";
      minimapCtx.fillRect(exit.x * sx - 3, exit.y * sy - 3, 6, 6);
    }
    for (const player of playersFrom(state)) {
      minimapCtx.fillStyle = player.id === runtime.session?.playerId ? "#d8513d" : "#176f7d";
      minimapCtx.beginPath();
      minimapCtx.arc(player.x * sx, player.y * sy, player.id === runtime.session?.playerId ? 4 : 3, 0, Math.PI * 2);
      minimapCtx.fill();
    }
  }

  function actorSpriteIndex(entity) {
    if (entity.entityKind === "player") return isGunner(entity.role) ? 1 : 0;
    const value = String(entity.type || entity.name || "").toLowerCase();
    if (entity.boss || /mother|boss|colossus|母/.test(value)) return 5;
    if (/guard|tide|brute|守卫/.test(value)) return 4;
    if (/lantern|skeleton|spitter|siren|骸/.test(value)) return 3;
    return 2;
  }

  function animationAssetKey(entity) {
    if (entity.entityKind === "player") return isGunner(entity.role) ? "ranger" : "vanguard";
    const value = String(entity.type || entity.name || "").toLowerCase();
    if (/lantern[_ -]?regent|赤灯摄政/.test(value)) return "lantern_regent";
    if (/tide[_ -]?tortoise|云汐潮甲/.test(value)) return "tide_tortoise";
    if (entity.boss || /mother|boss|colossus|母/.test(value)) return "fog_colossus";
    if (/brute|guard|tide|守卫/.test(value)) return "brute";
    if (/siren|skeleton|骸/.test(value)) return "siren";
    if (/spitter|lantern|吐|灯/.test(value)) return "spitter";
    return "crawler";
  }

  function animatedPose(entity, time) {
    const id = String(entity.id || `${entity.entityKind}-${animationAssetKey(entity)}`);
    let clock = runtime.animationClocks.get(id);
    const actionKey = `${entity.actionSeq ?? ""}|${entity.action ?? ""}|${entity.status ?? ""}`;
    const isLocal = entity.id === runtime.session?.playerId;
    const movingByInput = isLocal && Math.hypot(controls.move.x, controls.move.y) > .08;
    const moved = clock ? Math.hypot(safeNumber(entity.x) - clock.x, safeNumber(entity.y) - clock.y) > .18 : false;
    if (!clock) clock = { x: safeNumber(entity.x), y: safeNumber(entity.y), at: time, actionKey, startedAt: time };
    if (clock.actionKey !== actionKey) {
      clock.actionKey = actionKey;
      clock.startedAt = time;
    }
    const state = resolveAnimationState(entity, movingByInput || moved);
    const frame = selectAnimationFrame(entity, time, {
      state,
      moving: movingByInput || moved,
      startedAt: clock.startedAt,
      frameCount: 8,
      looping: state === "idle" || state === "run" || state === "special",
    });
    clock.x = safeNumber(entity.x);
    clock.y = safeNumber(entity.y);
    clock.at = time;
    runtime.animationClocks.set(id, clock);
    return frame;
  }

  function drawActor(entity, x, y, size, time) {
    const spriteIndex = actorSpriteIndex(entity);
    const downed = /down|dead|defeat|倒|死亡/i.test(`${entity.status || ""} ${entity.action || ""}`) || safeNumber(entity.hp, 1) <= 0;
    const defeated = /dead|defeat|死亡/i.test(entity.status || "") || safeNumber(entity.hp, 1) <= 0;
    const pose = animatedPose(entity, time);
    const bob = downed || pose.state === "attack" ? 0 : Math.sin(time * 0.004 + String(entity.id || "").length) * size * 0.012;
    const facingX = safeNumber(entity.facing?.x, entity.vx ?? 1);
    const actorAlpha = defeated
      ? clamp(safeNumber(entity.deathRemaining, .28) / .75, .28, 1)
      : entity.connected === false ? 0.55 : 1;

    ctx.save();
    ctx.globalAlpha = actorAlpha;
    ctx.fillStyle = "rgba(23, 63, 74, .26)";
    ctx.beginPath();
    ctx.ellipse(x, y + size * 0.14, size * 0.26, size * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const animation = assets.animations[animationAssetKey(entity)];
    animation?.load();
    if (animation?.ready) {
      const image = animation.image;
      const columns = 8;
      const rows = 6;
      const sw = image.naturalWidth / columns;
      const sh = image.naturalHeight / rows;
      const frameIndex = pose.column;
      const sx = frameIndex * sw;
      const sy = pose.row * sh;
      ctx.save();
      ctx.globalAlpha = actorAlpha;
      ctx.translate(x, y + bob);
      if (facingX < -0.08) ctx.scale(-1, 1);
      if (pose.state === "hurt") ctx.filter = "brightness(1.45) saturate(.6)";
      ctx.drawImage(image, sx, sy, sw, sh, -size / 2, -size * .8, size, size);
      ctx.restore();
    } else if (assets.sprites.ready) {
      const image = assets.sprites.image;
      const sw = image.naturalWidth / 3;
      const sh = image.naturalHeight / 2;
      const sx = (spriteIndex % 3) * sw;
      const sy = Math.floor(spriteIndex / 3) * sh;
      ctx.save();
      ctx.globalAlpha = actorAlpha;
      ctx.translate(x, y + bob);
      if (facingX < -0.08) ctx.scale(-1, 1);
      if (downed) {
        ctx.rotate(Math.PI / 2.25);
        ctx.filter = "grayscale(.72) brightness(.62)";
      } else if (entity.hit || entity.hurt) {
        ctx.filter = "brightness(1.75) saturate(.35)";
      }
      ctx.drawImage(image, sx, sy, sw, sh, -size / 2, -size * 0.76, size, size);
      ctx.restore();
    } else {
      const label = entity.entityKind === "player" ? roleLabel(entity.role) : enemyLabel(entity.type);
      drawCanvasText(label, x, y, Math.max(9, size * 0.14));
    }

    if (entity.entityKind === "enemy" && !entity.boss && !defeated) drawEntityHealth(entity, x, y - size * 0.58, size * 0.5);
    if (entity.entityKind === "player") drawPlayerLabel(entity, x, y - size * 0.66, size);
  }

  function drawEntityHealth(entity, x, y, width) {
    const maxHp = Math.max(1, safeNumber(entity.maxHp, 1));
    const ratio = clamp(safeNumber(entity.hp, maxHp) / maxHp, 0, 1);
    if (ratio >= 0.999) return;
    ctx.save();
    ctx.fillStyle = "rgba(23, 63, 74, .76)";
    ctx.fillRect(x - width / 2, y, width, 4);
    ctx.fillStyle = entity.elite ? "#f4bd45" : "#e9674e";
    ctx.fillRect(x - width / 2 + 1, y + 1, Math.max(0, (width - 2) * ratio), 2);
    ctx.restore();
  }

  function drawPlayerLabel(entity, x, y, size) {
    ctx.save();
    ctx.font = `600 ${clamp(size * 0.1, 8, 12)}px ${canvasSans}`;
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(255, 250, 240, .96)";
    ctx.shadowBlur = runtime.coarsePointer ? 2 : 5;
    ctx.fillStyle = entity.id === runtime.session?.playerId ? "#b94135" : "#176f7d";
    ctx.fillText(entity.name || (entity.isAI ? "契约灯偶" : "猎人"), x, y);
    ctx.restore();
  }

  function drawProjectile(projectile, x, y, size, time) {
    const rune = /rune|shot|bullet|符文/i.test(String(projectile.kind || projectile.type || ""));
    const fromMist = projectile.team === "mist" || /mist|siren|fog/i.test(String(projectile.kind || ""));
    if (assets.icons.ready) {
      const image = assets.icons.image;
      const sw = image.naturalWidth / 3;
      const sh = image.naturalHeight / 2;
      const index = fromMist ? 5 : rune ? 1 : 0;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(time * 0.004);
      ctx.shadowColor = rune ? "#2c9aae" : "#e9674e";
      ctx.shadowBlur = runtime.coarsePointer ? 2 : 12;
      ctx.drawImage(image, (index % 3) * sw, Math.floor(index / 3) * sh, sw, sh, -size / 2, -size / 2, size, size);
      ctx.restore();
    } else {
      drawCanvasText(rune ? "符" : "斩", x, y, Math.max(8, size * 0.65));
    }
  }

  function drawEffects(effects, camera, time) {
    if (!Array.isArray(effects)) return;
    for (const effect of effects) {
      if (!isWorldPointVisible(effect, camera, 100)) continue;
      const point = worldToScreen(effect, camera);
      const radius = Math.max(12, safeNumber(effect.radius, 28) * camera.scale);
      const kind = String(effect.kind || effect.type || "").toLowerCase();
      ctx.save();
      ctx.globalAlpha = clamp(safeNumber(effect.alpha, 0.65), 0, 1);
      ctx.lineWidth = Math.max(1, radius * 0.06);
      ctx.strokeStyle = /revive|heal|救援/.test(kind) ? "#2c9aae" : /hit|damage/.test(kind) ? "#e9674e" : "#f4bd45";
      if (/slash|attack|swing/.test(kind)) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, -1.2, 1.15);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius * (0.86 + Math.sin(time * 0.01) * 0.08), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawCanvasText(text, x, y, fontSize = 12) {
    ctx.save();
    ctx.font = `600 ${fontSize}px "Noto Serif SC", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(23, 63, 74, .94)";
    ctx.shadowColor = "rgba(255, 250, 240, .96)";
    ctx.shadowBlur = runtime.coarsePointer ? 1 : 4;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /* Events */
  ui.startGameBtn?.addEventListener("click", () => showContractPanel());
  ui.quickJoinBtn?.addEventListener("click", () => showContractPanel({ focusJoin: true }));
  ui.howToPlayBtn?.addEventListener("click", openHowToPlay);
  ui.backToMenuBtn?.addEventListener("click", () => showMainMenu());
  ui.homeLink?.addEventListener("click", (event) => {
    event.preventDefault();
    if (!ui.lobbyView.hidden) showMainMenu();
  });
  ui.closeHowToPlayBtn?.addEventListener("click", () => {
    if (typeof ui.howToPlayDialog?.close !== "function") ui.howToPlayDialog?.removeAttribute("open");
  });
  ui.createRoomBtn.addEventListener("click", () => createHunt("coop"));
  ui.soloBtn.addEventListener("click", () => createHunt("solo"));
  ui.joinForm.addEventListener("submit", joinHunt);
  ui.roomCodeInput.addEventListener("input", () => {
    ui.roomCodeInput.value = ui.roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  });
  ui.copyCodeBtn.addEventListener("click", copyRoomCode);
  ui.copyWaitCodeBtn.addEventListener("click", copyRoomCode);
  ui.leaveBtn.addEventListener("click", leaveHunt);
  ui.returnLobbyBtn.addEventListener("click", leaveHunt);
  ui.restartBtn.addEventListener("click", restartHunt);

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", clearMovement);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearMovement(); });
  window.addEventListener("resize", resizeCanvas, { passive: true });
  window.addEventListener("beforeunload", closeConnection);

  ui.canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse" && event.pointerId !== runtime.canvasAttackPointer) return;
    if (event.pointerType !== "mouse") event.preventDefault();
    updateAimFromPointer(event);
  });
  ui.canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (stageBlocksInput()) return;
    updateAimFromPointer(event);
    if (event.button !== 0) return;
    controls.attack = true;
    if (event.pointerType !== "mouse") {
      runtime.canvasAttackPointer = event.pointerId;
      ui.canvas.setPointerCapture(event.pointerId);
    }
  });
  window.addEventListener("pointerup", (event) => {
    if (event.pointerType === "mouse" && event.button === 0) controls.attack = false;
    if (event.pointerId === runtime.canvasAttackPointer) {
      event.preventDefault();
      runtime.canvasAttackPointer = null;
      controls.attack = false;
      try { ui.canvas.releasePointerCapture(event.pointerId); } catch {}
    }
  });
  ui.canvas.addEventListener("pointercancel", (event) => {
    if (event.pointerId !== runtime.canvasAttackPointer) return;
    runtime.canvasAttackPointer = null;
    controls.attack = false;
  });
  ui.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  ui.canvas.addEventListener("dblclick", (event) => event.preventDefault());

  ui.moveStick.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (stageBlocksInput()) return;
    runtime.joystickPointer = event.pointerId;
    runtime.moveStickRect = ui.moveStick.getBoundingClientRect();
    ui.moveStick.setPointerCapture(event.pointerId);
    updateJoystick(event);
  });
  ui.moveStick.addEventListener("pointermove", (event) => {
    if (event.pointerId === runtime.joystickPointer) updateJoystick(event);
  });
  const releaseJoystick = (event) => {
    if (event.pointerId !== runtime.joystickPointer) return;
    event.preventDefault();
    runtime.joystickPointer = null;
    controls.move.x = 0;
    controls.move.y = 0;
    ui.moveKnob.style.transform = "translate(-50%, -50%)";
  };
  ui.moveStick.addEventListener("pointerup", releaseJoystick);
  ui.moveStick.addEventListener("pointercancel", releaseJoystick);
  bindAttackButton(ui.aimStick, ui.touchAttack);
  bindHoldButton(ui.touchInteract, "interact");
  bindHoldButton(ui.touchDodge, "dodge");

  ui.canvasFrame.addEventListener("touchmove", (event) => {
    if (!ui.gameView.hidden) event.preventDefault();
  }, { passive: false });

  window.addEventListener("orientationchange", () => window.setTimeout(resizeCanvas, 80), { passive: true });
  window.visualViewport?.addEventListener("resize", resizeCanvas, { passive: true });

  if ("ResizeObserver" in window) new ResizeObserver(resizeCanvas).observe(ui.canvasFrame);
  window.requestAnimationFrame(renderFrame);
  setServerStatus(true);
  showMainMenu({ focus: false });
  restoreStoredSession();
})();
