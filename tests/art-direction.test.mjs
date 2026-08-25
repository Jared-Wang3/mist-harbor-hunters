import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const assetsRoot = path.join(publicRoot, 'assets');
const worldAssetsRoot = path.join(assetsRoot, 'world');

const v2Assets = {
  'cover-v2.webp': { minWidth: 800, minHeight: 450 },
  'arena-v2.webp': { minWidth: 800, minHeight: 450 },
  'sprites-v2.webp': { minWidth: 256, minHeight: 256 },
  'icons-v2.webp': { minWidth: 256, minHeight: 128 },
  'mark-v2.webp': { minWidth: 128, minHeight: 128 },
};

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

function webpHasAlpha(buffer) {
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF', 'WebP 缺少 RIFF 签名');
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WEBP', 'WebP 文件签名无效');

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunk = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = buffer.readUInt32LE(offset + 4);
    if (chunk === 'ALPH') return true;
    if (chunk === 'VP8X' && offset + 9 <= buffer.length) {
      return (buffer[offset + 8] & 0x10) !== 0;
    }
    offset += 8 + length + (length % 2);
  }
  return false;
}

function readPngInfo(buffer) {
  assert.equal(
    buffer.subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
    'PNG 文件签名无效',
  );
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', 'PNG 缺少 IHDR');
  const colorType = buffer[25];
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    hasAlpha: colorType === 4 || colorType === 6,
  };
}

test('三关地图均机械导出 4×4 高清地图块和独立概览', async () => {
  const stages = [
    { directory: 'stage-01', version: 'v5' },
    { directory: 'stage-02', version: 'v1' },
    { directory: 'stage-03', version: 'v1' },
  ];

  for (const stage of stages) {
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const name = 'map-r' + row + '-c' + column + '-' + stage.version + '.webp';
        const buffer = await readFile(path.join(worldAssetsRoot, stage.directory, name));
        const size = readWebpSize(buffer);
        assert.deepEqual(size, { width: 1280, height: 720 }, stage.directory + '/' + name + ' 尺寸错误');
        assert.ok(buffer.length >= 40_000, stage.directory + '/' + name + ' 体积过小，疑似空白占位');
        assert.ok(buffer.length <= 700_000, stage.directory + '/' + name + ' 超过移动端单块预算');
      }
    }

    const overviewName = 'overview-' + stage.version + '.webp';
    const overview = await readFile(path.join(worldAssetsRoot, stage.directory, overviewName));
    assert.deepEqual(
      readWebpSize(overview),
      { width: 512, height: 288 },
      stage.directory + '/' + overviewName + ' 尺寸错误',
    );
    assert.ok(overview.length >= 8_000, stage.directory + '/' + overviewName + ' 体积过小');
    assert.ok(overview.length <= 160_000, stage.directory + '/' + overviewName + ' 超过主页概览预算');
  }
});

test('正式碰撞地形图集使用透明 WebP，普通画面可按障碍键绘制', async () => {
  const atlases = [
    { file: 'terrain-common-v1.webp', width: 1536, height: 768 },
    { file: 'stage-02/terrain-stage-02-v1.webp', width: 1024, height: 1024 },
    { file: 'stage-03/terrain-stage-03-v1.webp', width: 1024, height: 1024 },
  ];

  for (const atlas of atlases) {
    const buffer = await readFile(path.join(worldAssetsRoot, ...atlas.file.split('/')));
    assert.deepEqual(
      readWebpSize(buffer),
      { width: atlas.width, height: atlas.height },
      atlas.file + ' 尺寸错误',
    );
    assert.ok(webpHasAlpha(buffer), atlas.file + ' 必须保留透明通道');
    assert.ok(buffer.length >= 30_000, atlas.file + ' 体积过小，疑似空白占位');
    assert.ok(buffer.length <= 900_000, atlas.file + ' 超过移动端地形图集预算');
  }
});

test('第二、第三关首领图集符合 8×6 透明 PNG 动画契约', async () => {
  for (const name of ['lantern-regent-anim-v1.png', 'tide-tortoise-anim-v1.png']) {
    const buffer = await readFile(path.join(assetsRoot, name));
    const info = readPngInfo(buffer);
    assert.deepEqual(
      { width: info.width, height: info.height },
      { width: 1024, height: 768 },
      name + ' 必须是 8×6 个 128px 单元',
    );
    assert.ok(info.hasAlpha, name + ' 必须是带 Alpha 的 PNG');
    assert.ok(buffer.length >= 100_000, name + ' 体积过小，疑似空白占位');
    assert.ok(buffer.length <= 1_200_000, name + ' 超过移动端首领图集预算');
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ruleBody(css, selectorPattern) {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\}`, 'i'));
  assert.ok(match, `样式表缺少规则：${selectorPattern}`);
  return match[1];
}

function rootColorVariables(css) {
  const root = ruleBody(css, ':root');
  return new Map(
    [...root.matchAll(/(--[\w-]+)\s*:\s*(#[\da-f]{3,8}|rgba?\([^)]*\))/gi)]
      .map((match) => [match[1], match[2]]),
  );
}

function relativeLuminance(red, green, blue) {
  const channels = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function parseColor(token) {
  if (token.startsWith('#')) {
    let value = token.slice(1);
    if (value.length === 3 || value.length === 4) {
      value = [...value].map((character) => character.repeat(2)).join('');
    }
    const hasAlpha = value.length === 8;
    return {
      red: Number.parseInt(value.slice(0, 2), 16),
      green: Number.parseInt(value.slice(2, 4), 16),
      blue: Number.parseInt(value.slice(4, 6), 16),
      alpha: hasAlpha ? Number.parseInt(value.slice(6, 8), 16) / 255 : 1,
    };
  }

  const values = token.match(/[\d.]+/g)?.map(Number) || [];
  return {
    red: values[0] || 0,
    green: values[1] || 0,
    blue: values[2] || 0,
    alpha: values.length > 3 ? values[3] : 1,
  };
}

function backgroundColors(rule, variables) {
  const declarations = [...rule.matchAll(/\bbackground(?:-color)?\s*:\s*([^;]+);/gi)]
    .map((match) => match[1]);
  const tokens = [];

  for (const declaration of declarations) {
    for (const match of declaration.matchAll(/var\((--[\w-]+)\)|#[\da-f]{3,8}|rgba?\([^)]*\)/gi)) {
      const token = match[0].startsWith('var(') ? variables.get(match[1]) : match[0];
      if (token) tokens.push(parseColor(token));
    }
  }
  return tokens;
}

test('明亮国风版画 v2 美术包完整存在，且不是旧素材的复制改名', async () => {
  for (const [name, expectation] of Object.entries(v2Assets)) {
    const file = path.join(assetsRoot, name);
    const buffer = await readFile(file);
    assert.ok(buffer.length >= 4_096, `${name} 体积异常，不能是空白占位资源`);

    const size = readWebpSize(buffer);
    assert.ok(
      size.width >= expectation.minWidth && size.height >= expectation.minHeight,
      `${name} 分辨率 ${size.width}×${size.height} 低于要求 `
        + `${expectation.minWidth}×${expectation.minHeight}`,
    );

    const legacyName = name.replace('-v2', '');
    try {
      const legacy = await readFile(path.join(assetsRoot, legacyName));
      assert.equal(
        buffer.equals(legacy),
        false,
        `${name} 与旧版 ${legacyName} 完全相同，不能只复制改名冒充新版美术`,
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
});

test('页面、CSS 与 Canvas 客户端均明确引用正式版本美术资源', async () => {
  const [html, css, source] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'styles.css'), 'utf8'),
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
  ]);
  const frontend = `${html}\n${css}\n${source}`;

  for (const name of Object.keys(v2Assets).filter((asset) => asset !== 'arena-v2.webp')) {
    assert.ok(frontend.includes(`assets/${name}`), `客户端必须引用 assets/${name}`);
  }

  assert.match(html, /<img\b[^>]*src=["']assets\/cover-v2\.webp["']/i);
  assert.match(html, /<link\b[^>]*rel=["']icon["'][^>]*href=["']assets\/mark-v2\.webp["']/i);
  assert.match(css, /background-image\s*:\s*url\(["']?assets\/icons-v2\.webp["']?\)/i);
  assert.match(css, /background-image\s*:\s*url\(["']?assets\/sprites-v2\.webp["']?\)/i);
  for (const name of ['sprites-v2.webp', 'icons-v2.webp']) {
    assert.match(
      source,
      new RegExp(`loadImage\\(["']assets/${escapeRegExp(name)}["']\\)`),
      `Canvas 必须加载 ${name}`,
    );
  }
  for (const stage of ['stage-01', 'stage-02', 'stage-03']) {
    assert.ok(source.includes(stage), `Canvas 地图注册表必须包含 ${stage}`);
  }
  assert.match(source, /visibleTileRange\s*\(/i, 'Canvas 必须按镜头加载地图块');
  assert.match(source, /terrain-common-v1\.webp/i, 'Canvas 必须加载可见碰撞地形图集');
  assert.doesNotMatch(source, /world-map-v4\.webp/i, '生产客户端不应继续加载旧单张地图');
  assert.doesNotMatch(frontend, /assets\/arena-v2\.webp/i, '三关地图版本不应继续加载旧单屏竞技场');

  assert.doesNotMatch(
    frontend,
    /assets\/(?:cover|arena|sprites|icons|mark)\.webp(?:["')\s]|$)/i,
    '客户端不应继续引用无版本号的旧版美术资源',
  );
});

test('主要界面表面采用明亮纸色与海色，而不是近黑暗黑底色', async () => {
  const [html, css] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'styles.css'), 'utf8'),
  ]);
  const variables = rootColorVariables(css);

  assert.match(css, /:root\s*\{[\s\S]*?color-scheme\s*:\s*light\s*;/i);
  for (const token of ['--paper', '--paper-light', '--sea-light', '--coral', '--ink']) {
    assert.ok(variables.has(token), `明亮版画调色板缺少 ${token}`);
  }

  const themeColor = html.match(/<meta\b[^>]*name=["']theme-color["'][^>]*content=["'](#[\da-f]{3,8})["']/i)?.[1];
  assert.ok(themeColor, '页面必须声明明亮的 theme-color');
  const theme = parseColor(themeColor);
  assert.ok(
    relativeLuminance(theme.red, theme.green, theme.blue) >= 0.65,
    `theme-color ${themeColor} 仍然过暗`,
  );

  const majorSurfaces = new Map([
    ['页面底色', 'html\\s*,\\s*body'],
    ['站点外壳', '\\.site-shell'],
    ['大厅', '\\.lobby-view'],
    ['契约卡片', '\\.contract-card'],
    ['游戏视图', '\\.game-view'],
    ['游戏顶栏', '\\.game-topbar'],
  ]);

  for (const [label, selector] of majorSurfaces) {
    const colors = backgroundColors(ruleBody(css, selector), variables);
    assert.ok(colors.length > 0, `${label}必须有明确的背景颜色`);
    const hasLightFoundation = colors.some((color) => (
      color.alpha >= 0.7 && relativeLuminance(color.red, color.green, color.blue) >= 0.45
    ));
    assert.ok(hasLightFoundation, `${label}仍由近黑色主导，未落实 A 方向的明亮配色`);
  }
});

test('新版角色仍由位图图集绘制，不回退为 SVG 或几何角色占位', async () => {
  const [files, source] = await Promise.all([
    walk(publicRoot),
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
  ]);
  const textFiles = files.filter((file) => /\.(?:html|css|m?js)$/i.test(file));
  const frontendText = (await Promise.all(textFiles.map((file) => readFile(file, 'utf8')))).join('\n');

  assert.deepEqual(
    files.filter((file) => path.extname(file).toLowerCase() === '.svg'),
    [],
    'public 中不得出现 SVG 角色或图标占位文件',
  );
  assert.doesNotMatch(
    frontendText,
    /<\s*\/?\s*svg\b|data:image\/svg\+xml|image\/svg\+xml|[\w./-]+\.svg(?:[?#"')\s]|$)/i,
  );

  const actorStart = source.indexOf('function drawActor(');
  const actorEnd = source.indexOf('function drawEntityHealth(', actorStart);
  assert.ok(actorStart >= 0 && actorEnd > actorStart, '客户端必须保留独立的角色绘制函数');
  const actorBody = source.slice(actorStart, actorEnd);
  assert.match(actorBody, /assets\.sprites\.ready[\s\S]*?ctx\.drawImage\s*\(/);

  const fallbackStart = actorBody.lastIndexOf('} else {');
  assert.ok(fallbackStart >= 0, '素材尚未加载时必须有可访问的文字降级提示');
  assert.doesNotMatch(
    actorBody.slice(fallbackStart),
    /ctx\.(?:arc|ellipse|rect|roundRect|fillRect|strokeRect)\s*\(/,
    '素材加载失败时不得用圆形或方块冒充角色',
  );
});

test('明亮 UI 改版后仍保留合格的手机双摇杆触控', async () => {
  const [html, css, source] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'styles.css'), 'utf8'),
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
  ]);

  assert.match(html, /user-scalable\s*=\s*no/i);
  assert.match(html, /viewport-fit\s*=\s*cover/i);
  for (const edge of ['left', 'right', 'bottom']) {
    assert.match(css, new RegExp(`env\\(safe-area-inset-${edge}\\)`, 'i'));
  }

  const touchButton = ruleBody(css, '\\.touch-button');
  const minWidth = Number(touchButton.match(/min-width\s*:\s*(\d+)px/i)?.[1]);
  const minHeight = Number(touchButton.match(/min-height\s*:\s*(\d+)px/i)?.[1]);
  assert.ok(minWidth >= 48 && minHeight >= 48, '手机按钮点击热区不得小于 48×48px');
  assert.match(css, /\.mobile-controls\s*\{[\s\S]{0,500}?display\s*:\s*flex/i);
  assert.match(source, /function bindAttackButton\s*\(/);
  assert.match(source, /function aimAtNearestEnemy\s*\(/);
  assert.match(source, /pointerdown[\s\S]{0,300}?preventDefault\s*\(\)/);
});
