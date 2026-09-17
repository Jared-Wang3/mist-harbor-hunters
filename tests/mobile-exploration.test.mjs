import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');

test('手机启动主页面保持大触点、单列航路预览与可滚动玩法说明', async () => {
  const [html, css] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'styles.css'), 'utf8'),
  ]);

  for (const id of ['mainMenuPanel', 'startGameBtn', 'quickJoinBtn', 'howToPlayBtn', 'howToPlayDialog']) {
    assert.match(html, new RegExp('id=\"' + id + '\"', 'i'), '手机启动页缺少 ' + id);
  }
  assert.match(
    css,
    /\.main-menu-actions\s+\.action-button\s*\{[\s\S]{0,220}?min-height\s*:\s*(?:4[4-9]|[5-9]\d)px/i,
    '主菜单操作按钮必须至少提供 44px 触控高度',
  );
  assert.match(
    css,
    /\.how-to-dialog\s*\{[\s\S]{0,500}?max-height\s*:[^;]+dvh[\s\S]{0,220}?overflow-y\s*:\s*auto/i,
    '玩法说明必须限制在动态视口内并允许自身滚动',
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)[\s\S]*?\.stage-route-preview\s*\{[\s\S]{0,180}?grid-template-columns\s*:\s*1fr/i,
    '手机上的三章航路预览必须改为单列',
  );
});

test('手机采用独立移动与瞄准双摇杆，支持两个触点同时输入', async () => {
  const [html, source] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
  ]);

  assert.match(html, /id=["']moveStick["'][^>]*aria-label=["'][^"']*移动[^"']*["']/i);
  assert.match(
    html,
    /id=["'](?:aimStick|attackStick)["'][^>]*aria-label=["'][^"']*(?:瞄准|攻击)[^"']*["']/i,
    '右侧必须是可拖动的瞄准/攻击摇杆，不是只能点一下的按钮',
  );
  assert.match(source, /byId\s*\(\s*["'](?:aimStick|attackStick)["']\s*\)/i, '右摇杆必须被客户端实际绑定');
  assert.match(source, /(?:moveStickPointer|joystickPointer)\s*:/, '移动摇杆应跟踪自己的 pointerId');
  assert.match(source, /(?:aimStickPointer|attackPointer)\s*:/, '瞄准摇杆应跟踪自己的 pointerId');
  assert.match(source, /(?:updateAimStick|updateAttackStick|updateAimFromAttackControl)\s*\(/, '拖动右摇杆应连续更新瞄准方向');
  assert.match(source, /setPointerCapture\s*\(/, '摇杆应捕获触点，防止手指滑出后丢失输入');
});

test('手机游戏区适配真实横竖屏视口，不强制把 16:9 战斗板缩在中央', async () => {
  const [html, css, source] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'styles.css'), 'utf8'),
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
  ]);

  assert.match(html, /viewport-fit\s*=\s*cover/i);
  assert.match(css, /height\s*:\s*100dvh/i);
  for (const edge of ['left', 'right', 'bottom']) {
    assert.match(css, new RegExp(`env\\(safe-area-inset-${edge}\\)`, 'i'));
  }

  assert.match(
    css,
    /@media[\s\S]*?\.canvas-frame\s*\{[\s\S]{0,500}?(?:aspect-ratio\s*:\s*(?:auto|unset)|width\s*:\s*100(?:vw|%)[\s\S]{0,180}?height\s*:\s*(?:100%|calc\())/i,
    '移动端 Canvas 容器应占满可用视口，而非继续固定 16:9',
  );
  assert.match(
    source,
    /(?:desiredScale|cameraScale|uniformScale)\s*=\s*Math\.(?:min|max)\s*\([^;]*?width\s*\/[^;]*?height\s*\//i,
    '相机应从横纵视口比例计算一个统一缩放值',
  );
});

test('探索触控保留攻击、角色技能、闪避、互动，并允许多指并发', async () => {
  const [html, source] = await Promise.all([
    readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    readFile(path.join(publicRoot, 'app.js'), 'utf8'),
  ]);

  for (const id of ['touchSkill', 'touchDodge', 'touchInteract']) {
    assert.match(html, new RegExp(`id=["']${id}["']`, 'i'), `缺少 ${id} 触控按钮`);
  }
  assert.match(source, /pointerdown[\s\S]{0,500}?preventDefault\s*\(\)/i);
  assert.match(source, /pointercancel/i, '系统中断触点时必须释放摇杆/按钮状态');
  assert.match(source, /lostpointercapture/i, '失去触点捕获时必须清理持续攻击或移动');
  assert.match(source, /bindHoldButton\s*\(\s*ui\.touchSkill\s*,\s*["']skill["']\s*\)/, '触屏技能按钮必须实际绑定 controls.skill');
  assert.doesNotMatch(
    source,
    /document\.addEventListener\s*\(\s*["']touch(?:start|move)["'][\s\S]{0,160}?preventDefault\s*\(\)/i,
    '不应在 document 级别拦截所有触摸，避免双指操作被吞掉',
  );
});
