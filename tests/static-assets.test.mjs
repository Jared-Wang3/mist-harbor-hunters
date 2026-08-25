import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const indexPath = path.join(publicRoot, 'index.html');

const requiredAssets = {
  'arena-v2.webp': { minWidth: 800, minHeight: 450 },
  'sprites-v2.webp': { minWidth: 256, minHeight: 256 },
  'icons-v2.webp': { minWidth: 256, minHeight: 128 },
  'cover-v2.webp': { minWidth: 800, minHeight: 450 },
  'mark-v2.webp': { minWidth: 128, minHeight: 128 },
};

const explorationStages = [
  { directory: 'stage-01', version: 'v5' },
  { directory: 'stage-02', version: 'v1' },
  { directory: 'stage-03', version: 'v1' },
];

const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);

async function walk(directory) {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    if (entry.isFile()) files.push(target);
  }
  return files;
}

async function loadFrontend() {
  const roots = ['public', 'src', 'client', 'app'];
  const discovered = (await Promise.all(
    roots.map((root) => walk(path.join(projectRoot, root))),
  )).flat();
  const files = [...new Set(discovered)]
    .filter((file) => textExtensions.has(path.extname(file).toLowerCase()))
    .filter((file) => !file.includes(`${path.sep}assets${path.sep}`));

  assert.ok(files.length > 0, '应至少存在一个前端源码文件');

  const contents = await Promise.all(files.map(async (file) => ({
    file,
    text: await readFile(file, 'utf8'),
  })));

  return {
    files,
    text: contents.map(({ file, text: source }) => (
      `\n/* ${path.relative(projectRoot, file)} */\n${source}`
    )).join('\n'),
  };
}

function readWebpSize(buffer) {
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF', 'WebP 缺少 RIFF 签名');
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WEBP', 'WebP 文件签名无效');
  const chunk = buffer.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    assert.equal(buffer.subarray(23, 26).toString('hex'), '9d012a', 'WebP VP8 帧头无效');
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    assert.equal(buffer[20], 0x2f, 'WebP VP8L 帧头无效');
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  throw new Error(`不支持的 WebP 数据块：${chunk}`);
}

function openingTags(source, tagName) {
  return [...source.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gi'))]
    .map((match) => match[0]);
}

function hasAttribute(tag, name, expectedValue) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  if (!match) return false;
  return expectedValue === undefined || expectedValue.test(match[2]);
}

function openingTagWithId(source, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return openingTags(source, '[^\\s>]+').find((tag) => (
    hasAttribute(tag, 'id', new RegExp('^' + escaped + '$', 'i'))
  ));
}

test('五张 v2 美术资产是真实且具有可用分辨率的栅格图片', async () => {
  for (const [name, expectation] of Object.entries(requiredAssets)) {
    const assetPath = path.join(publicRoot, 'assets', name);
    const buffer = await readFile(assetPath);
    assert.ok(buffer.length >= 4_096, `${name} 体积异常，不能是空白占位文件`);

    const size = readWebpSize(buffer);
    assert.ok(
      size.width >= expectation.minWidth && size.height >= expectation.minHeight,
      `${name} 分辨率 ${size.width}×${size.height} 低于要求 `
        + `${expectation.minWidth}×${expectation.minHeight}`,
    );
  }
});

test('探索版按镜头加载三关地图块，不回退为单张放大贴图', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');
  for (const stage of explorationStages) {
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const name = 'map-r' + row + '-c' + column + '-' + stage.version + '.webp';
        const buffer = await readFile(path.join(publicRoot, 'assets', 'world', stage.directory, name));
        assert.deepEqual(readWebpSize(buffer), { width: 1280, height: 720 });
      }
    }
    assert.ok(source.includes(stage.directory), '客户端地图注册表缺少 ' + stage.directory);
  }
  assert.match(source, /visibleTileRange\s*\(/, '客户端必须按相机视口计算可见地图块');
  assert.match(source, /stageTileCache|tileCache/, '客户端必须维护有限地图块缓存');
  assert.match(source, /map-r/, '客户端必须按行列生成地图块路径');
  assert.doesNotMatch(source, /world-map-v4\.webp/, '生产地图不得继续加载旧的单张放大背景');
  assert.doesNotMatch(source, /for\s*\([^)]*row[^)]*\)[\s\S]{0,500}?drawImage\(assets\.arena/i, '世界地图不得继续逐格重复单屏竞技场');
});

test('前端明确引用场景、角色、图标和封面资产', async () => {
  const frontend = await loadFrontend();

  for (const name of Object.keys(requiredAssets).filter((asset) => asset !== 'arena-v2.webp')) {
    assert.ok(
      frontend.text.includes(`assets/${name}`),
      `前端必须引用 assets/${name}`,
    );
  }

  assert.ok(/sprites-v2\.webp/i.test(frontend.text), '角色渲染必须使用 sprites-v2.webp');
  assert.ok(
    /assets\.sprites\.(?:ready|image)[\s\S]{0,1200}?drawImage\s*\(/.test(frontend.text),
    'Canvas 的角色分支必须通过 drawImage 绘制 sprites.webp，而不是几何占位',
  );
});

test('前端不使用 SVG 或圆形、方块角色占位', async () => {
  const frontend = await loadFrontend();
  const publicFiles = await walk(publicRoot);
  const svgFiles = publicFiles.filter((file) => path.extname(file).toLowerCase() === '.svg');

  assert.deepEqual(svgFiles, [], 'public 中不得出现 SVG 文件');
  assert.doesNotMatch(
    frontend.text,
    /<\s*\/?\s*svg\b|data:image\/svg\+xml|image\/svg\+xml|createElementNS\s*\([^)]*svg|[\w./-]+\.svg(?:[?#"')\s]|$)/i,
    '前端不得包含内联 SVG、SVG data URL 或 SVG 引用',
  );

  assert.doesNotMatch(
    frontend.text,
    /(?:player|hunter|hero|character)(?:Circle|Square|Dot|Block|Shape)|(?:circle|square|dot|block)(?:Player|Hunter|Hero|Character)/i,
    '不得以 circle/square/dot/block 命名角色占位图形',
  );
  assert.doesNotMatch(
    frontend.text,
    /<(?:div|span)\b[^>]*class\s*=\s*(["'])[^"']*(?:(?:player|hunter|hero|character)[-_ ](?:circle|square|dot|block)|(?:circle|square|dot|block)[-_ ](?:player|hunter|hero|character))[^"']*\1/i,
    '不得用圆点或方块 DOM 元素冒充角色',
  );
});

test('契约大厅提供完整的单人与双人联机入口', async () => {
  const { text } = await loadFrontend();

  for (const label of ['建立双人契约', '输入 6 位房间码', '加入猎团', '单人试炼']) {
    assert.ok(text.includes(label), `菜单缺少“${label}”`);
  }

  assert.match(text, /maxlength\s*=\s*(["'])6\1/i, '房间码输入框应限制为 6 位');
  assert.match(text, /autocomplete\s*=\s*(["'])off\1/i, '房间码不应被浏览器自动填充');
});

test('正式启动主页面分流到契约大厅、快速加入与玩法说明', async () => {
  const html = await readFile(indexPath, 'utf8');
  const mainMenu = openingTagWithId(html, 'mainMenuPanel');
  const contract = openingTagWithId(html, 'contractPanel');
  assert.ok(mainMenu, '缺少默认显示的 mainMenuPanel');
  assert.doesNotMatch(mainMenu, /\bhidden(?:\s|>|=)/i, 'mainMenuPanel 应作为默认启动页面显示');
  assert.ok(contract, '现有契约大厅应保留为 contractPanel');
  assert.match(contract, /\bhidden(?:\s|>|=)/i, 'contractPanel 初始应隐藏');

  const startButton = openingTagWithId(html, 'startGameBtn');
  const quickJoinButton = openingTagWithId(html, 'quickJoinBtn');
  const guideButton = openingTagWithId(html, 'howToPlayBtn');
  const backButton = openingTagWithId(html, 'backToMenuBtn');
  assert.ok(startButton && hasAttribute(startButton, 'aria-controls', /^contractPanel$/), '开始游戏必须指向契约大厅');
  assert.ok(quickJoinButton && hasAttribute(quickJoinButton, 'aria-controls', /^contractPanel$/), '快速加入必须指向契约大厅');
  assert.ok(guideButton && hasAttribute(guideButton, 'aria-haspopup', /^dialog$/), '玩法说明按钮必须声明打开对话框');
  assert.ok(guideButton && hasAttribute(guideButton, 'aria-controls', /^howToPlayDialog$/), '玩法说明按钮必须关联说明对话框');
  assert.ok(backButton && hasAttribute(backButton, 'aria-controls', /^mainMenuPanel$/), '契约大厅必须提供返回主菜单按钮');

  const guideDialog = openingTagWithId(html, 'howToPlayDialog');
  assert.ok(guideDialog && /^<dialog\b/i.test(guideDialog), '玩法与操作应使用原生 dialog');
  assert.ok(hasAttribute(guideDialog, 'aria-labelledby', /^howToPlayTitle$/), '玩法说明对话框必须具有可访问标题');
  assert.ok(openingTagWithId(html, 'closeHowToPlayBtn'), '玩法说明对话框必须提供显式关闭按钮');

  const images = openingTags(html, 'img');
  for (const imageSource of [
    'assets/world/stage-01/overview-v5.webp',
    'assets/world/stage-02/overview-v1.webp',
    'assets/world/stage-03/overview-v1.webp',
  ]) {
    const escaped = imageSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const preview = images.find((tag) => hasAttribute(tag, 'src', new RegExp('^' + escaped + '$', 'i')));
    assert.ok(preview, '三章航路预览缺少 ' + imageSource);
    assert.ok(hasAttribute(preview, 'alt', /.+/), imageSource + ' 必须提供替代文本');
  }
});

test('页面具备菜单与游戏所需的基础无障碍标记', async () => {
  const html = await readFile(indexPath, 'utf8');

  assert.match(html, /<html\b[^>]*\blang\s*=\s*(["'])zh(?:-CN)?\1/i, '页面必须声明中文语言');
  assert.match(html, /<meta\b[^>]*\bname\s*=\s*(["'])viewport\1/i, '页面必须设置移动端 viewport');

  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
  assert.ok(buttons.length >= 3, '菜单至少应有建房、加入和单人试炼按钮');
  for (const [button, attributes, contents] of buttons) {
    const visibleName = contents.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.ok(
      hasAttribute(attributes, 'aria-label') || visibleName,
      `按钮缺少可访问名称：${button}`,
    );
  }

  const canvases = [...html.matchAll(/<canvas\b([^>]*)>([\s\S]*?)<\/canvas>/gi)];
  assert.ok(canvases.length > 0, '应存在游戏 Canvas');
  for (const [, attributes, fallback] of canvases) {
    assert.match(attributes, /\baria-label\s*=\s*(["']).+?\1/i, 'Canvas 缺少中文 aria-label');
    assert.ok(fallback.replace(/<[^>]+>/g, '').trim(), 'Canvas 必须提供 fallback 文案');
  }

  const labels = [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*(["'])(.*?)\1[^>]*>/gi)]
    .map((match) => match[2]);
  assert.ok(labels.length > 0, '房间码输入框必须有可见 label');
  for (const id of labels) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(html, new RegExp(`<input\\b[^>]*\\bid\\s*=\\s*(["'])${escaped}\\1`, 'i'));
  }

  const statusTags = openingTags(html, '[^\\s>]+').filter((tag) => (
    hasAttribute(tag, 'role', /^status$/i)
  ));
  assert.ok(
    statusTags.some((tag) => hasAttribute(tag, 'aria-live', /^polite$/i)),
    '状态或错误提示必须使用 role="status" 与 aria-live="polite"',
  );

  const dialogTags = openingTags(html, '[^\\s>]+').filter((tag) => (
    hasAttribute(tag, 'role', /^dialog$/i)
  ));
  assert.ok(
    dialogTags.some((tag) => hasAttribute(tag, 'aria-modal', /^true$/i)),
    '结算弹层必须使用 role="dialog" 与 aria-modal="true"',
  );

  assert.match(html, /\shidden(?:\s|>|=)/i, '非当前视图应通过 hidden 隐藏');
});

test('客户端优先使用同源 WebSocket 并保留本地兼容传输', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');

  assert.match(source, /\/api\/rooms\/\$\{encodeURIComponent\(roomCode\)\}\/socket\?\$\{query\}/);
  assert.match(source, /url\.protocol\s*=\s*window\.location\.protocol\s*===\s*["']https:["']\s*\?\s*["']wss:["']/);
  assert.match(source, /parsed\?\.type\s*===\s*["']state["'][\s\S]{0,100}handleSnapshot\(parsed\.state\)/);
  assert.doesNotMatch(source, /handleSnapshot\(parsed\?\.state\s*\|\|\s*parsed\?\.snapshot\s*\|\|\s*parsed\)/, 'ack 或 pong 不得覆盖游戏状态');
  assert.match(source, /send\(JSON\.stringify\(\{\s*type:\s*["']input["'],\s*\.\.\.input\s*\}\)\)/);
  assert.doesNotMatch(source, /send\(JSON\.stringify\(\{\s*type:\s*["']input["'],\s*\.\.\.payload\s*\}\)\)/, 'WebSocket 输入帧不得重复携带长期凭证');
  assert.match(source, /runtime\.snapshot\?\.stage\?\.status\s*===\s*["']waiting["'][\s\S]{0,40}return/, '等待第二名玩家时不得用空输入阻止 Durable Object 休眠');
  assert.match(source, /sessionStorage\.getItem\(sessionStorageKey\)/, '刷新后必须读取已保存的手机会话');
  assert.match(source, /\/reconnect["'`]/, '刷新后必须通过服务端恢复自己的房间席位');
  assert.match(source, /runtime\.inputSeq\s*=\s*Date\.now\(\)/, '重连后的输入序号不得从零开始');
  assert.match(source, /new EventSource\(/, 'WebSocket 失败时必须仍可回退 SSE');
  assert.match(source, /\/input["'`],\s*\{[\s\S]{0,100}method:\s*["']POST["']/i, '本地 Node 必须仍可通过 POST 提交输入');
});

test('手机触控具备安全区、抗误触缩放和双摇杆瞄准', async () => {
  const [html, css, source] = await Promise.all([
    readFile(indexPath, 'utf8'),
    readFile(path.join(publicRoot, 'styles.css'), 'utf8'),
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
  ]);

  assert.match(html, /user-scalable\s*=\s*no/i);
  assert.match(html, /viewport-fit\s*=\s*cover/i);
  assert.match(css, /env\(safe-area-inset-(?:left|right|bottom)\)/i);
  assert.match(css, /\.touch-button\s*\{[\s\S]{0,300}min-width:\s*56px[\s\S]{0,80}min-height:\s*56px/i);
  assert.match(css, /\.game-view\s*\{[\s\S]{0,250}height:\s*100dvh/i);
  assert.match(source, /function bindAttackButton\(/);
  assert.match(source, /function aimAtNearestEnemy\(/);
  assert.match(source, /pointerdown[\s\S]{0,260}preventDefault\(\)/);
});

test('poll fallback stays smooth and never overlaps slow requests', async () => {
  const source = await readFile(path.join(publicRoot, 'app.js'), 'utf8');

  assert.match(source, /FALLBACK_POLL_INTERVAL_MS\s*=\s*180/);
  assert.match(source, /MAX_LOCAL_PREDICTION_LEAD_MS\s*=\s*260/);
  assert.match(source, /snapshotAge\s*>\s*MAX_LOCAL_PREDICTION_LEAD_MS/);
  assert.match(source, /STATE_STALE_AFTER_MS\s*=\s*1000/);
  assert.match(source, /Date\.now\(\)\s*-\s*runtime\.lastStateAt\s*<=\s*STATE_STALE_AFTER_MS/);
  assert.match(source, /if\s*\(!runtime\.session\s*\|\|\s*runtime\.pollInFlight\)\s*return/);
  assert.match(source, /runtime\.pollInFlight\s*=\s*true/);
  assert.match(source, /finally\s*\{\s*runtime\.pollInFlight\s*=\s*false/);
});
