# 雾港猎团 · 美术方向

## 已确认方向

本项目采用「明亮国风木刻 / 剪纸」作为正式美术方向：

- 造型：粗细不完全均匀的深色刻线、纸雕式大轮廓、少量套色错位与手工印刷纹理。
- 气质：冒险、热闹、带民俗感；避免阴沉恐怖、暗黑写实和玻璃拟态。
- 配色：海蓝、浅青、米白为大面积色；朱橙与暖金用于操作、危险和关键反馈。
- 可读性：人物和怪物以清晰剪影优先，战斗场景中央保持低细节，UI（用户界面）使用不透明纸张色块。
- 地形：可行走区域、深水、平台边缘与实体障碍必须在正常游戏画面中直接可见，不能依赖 Debug（调试）轮廓才读得懂。

## v6 正式世界系统

v6 以 semantic-first world（语义优先世界）取代旧版整张概念图放大方案。每关的可走路线、深水／运河／云渊阻挡、速度区域、道具脚点与 ambient emitter（环境动态发射器）先定义在 `src/world-v6/stage-0N.json`，地面和前景再从模块化源图生成。以下旧 v5/v1 场景与碰撞图集章节仅保留为历史规格，不再被生产客户端引用。

每关固定包含：

- 4 张至少 1024×1024 的 seamless surface（无缝地表）。
- 6 张至少 768×768 的 transparent foreground prop（透明前景道具）。
- 1 张透明 edge decal（边缘贴花）。
- 16 张 1280×720 地面块、1 张 512×288 概览、1 张 1024×1024 地表图集、1 张 1536×768 前景图集。
- 16 张 320×180 RGB data texture（RGB 数据纹理），R/G/B 分别承载水或云、岸线或风、光／倒影／环境雾的合成强度；不使用 Alpha 存储数据，避免 Canvas 预乘透明度丢失颜色通道。

运行时严格按「地面 → 世界坐标动态层 → 地面效果 → 道具／敌人／角色脚点纵深 → 环境覆盖 → 战争迷雾 → HUD」绘制。碰撞坐标与可见道具锚点分离：服务端使用 `x/y` 和尺寸，客户端使用 `visualX/visualY`、`anchor` 与 `scale`，避免高建筑的视觉中心破坏碰撞脚点。

## 色彩令牌

| 用途 | 色值 |
| --- | --- |
| 深海墨线 | `#173f4a` |
| 海蓝 | `#2c9aae` |
| 深海蓝 | `#176f7d` |
| 米纸 | `#fff3cf` |
| 亮米纸 | `#fffaf0` |
| 浅海青 | `#b9e4df` |
| 朱橙 | `#e9674e` |
| 深朱红 | `#b94135` |
| 暖金 | `#f4bd45` |

## 动画图集契约

`vanguard-anim-v3.png` 与 `ranger-anim-v3.png` 是当前两名主角的正式 8 × 6 透明 PNG（便携式网络图形）动画图集。移动端优化后的每格为 128 × 128，六行依次为：

1. 待机
2. 奔跑
3. 攻击
4. 受伤
5. 倒地
6. 职业技能（守潮阵 / 缚潮印）

两个图集统一采用脚底锚点，由客户端按照服务端 `action` / `actionSeq` 与本地移动状态选择动作。`sprites-v2.webp` 中的前两格只保留为头像和加载失败回退。

主要敌人也使用相同的 8 × 6、128 × 128 单元格契约：`crawler-anim-v4.png`、`brute-anim-v4.png`、`siren-anim-v4.png` 与 `fog-colossus-anim-v4.png`。

第二、第三关首领延用同一契约：`lantern-regent-anim-v1.png` 对应赤灯摄政，`tide-tortoise-anim-v1.png` 对应云汐潮甲。角色和首领动画只在真正进入镜头或首领阶段后采用 lazy loading（懒加载），避免手机在开始主页一次解码全部动作表。

## 三关世界场景契约（v5 归档）

三个独立关卡均对应 5120 × 2880 游戏世界，并由同一张母图机械切成 4 × 4 的 WebP（网页图像格式）地图块。每块为 1280 × 720，`row` 与 `column` 均从 0 到 3：

- 第一关「晴潮雾港」：高质量重绘现有旅程，从左下猎团营地，经盐雾湿地、沉没集市与灯塔遗址，到达右上潮雾之心。正式地图块为 `world/stage-01/map-r{row}-c{column}-v5.webp`。
- 第二关「赤灯潮市」：从左下登陆埠进入运河潮市，经赤灯商廊、中央集市、货栈与水闸，抵达右上万灯戏台与摄政门。正式地图块为 `world/stage-02/map-r{row}-c{column}-v1.webp`。
- 第三关「云汐天关」：从左下悬崖云港出发，经悬索桥、云钟庭院与烽灯台，登上右上金色天关。正式地图块为 `world/stage-03/map-r{row}-c{column}-v1.webp`。

客户端只加载相机附近地图块，并在离开关卡后释放旧关卡资源。每关另有一张 512 × 288 的 `overview`：

- `world/stage-01/overview-v5.webp`
- `world/stage-02/overview-v1.webp`
- `world/stage-03/overview-v1.webp`

这些旧 `overview` 与 `world-map-v4.webp` 仅作历史归档，不得再作为战斗场景、航路预览或加载失败回退。

## 透明碰撞地形契约（v5 归档）

正式碰撞地形使用带 Alpha（透明通道）的栅格图集，并按服务端下发的障碍物坐标覆盖在地图块之上。普通玩家必须直接看见实体地形；几何碰撞线只用于调试，不能成为正式画面的唯一提示。

### 共用地形

`world/terrain-common-v1.webp` 为 1536 × 768、4 列 × 2 行，每格 384 × 384，按行优先排列：

| 行列 | 地形 | 选择规则 |
| --- | --- | --- |
| r0c0 | 猎团小屋 | `visualKind=stall` 且 `kind=shack`，或 ID 含 `supply-hut` |
| r0c1 | 断栈桥 | `visualKind=bridge` 默认 |
| r0c2 | 沉舟 | `visualKind=bridge` 且 ID 含 `skiff` |
| r0c3 | 暗礁 | `visualKind=rock` |
| r1c0 | 矮墙 | `visualKind=wall` |
| r1c1 | 货摊 | `visualKind=stall` 默认 |
| r1c2 | 塔基 | `visualKind=tower` |
| r1c3 | 石柱 | `visualKind=pillar` |

### 第二关专属地形

`world/stage-02/terrain-stage-02-v1.webp` 为 1024 × 1024、2 列 × 2 行，每格 512 × 512：

| 行列 | 地形 | 覆盖键 |
| --- | --- | --- |
| r0c0 | 赤灯牌坊 | `pillar`；也可供 `gate` |
| r0c1 | 水闸机 | `wall` |
| r1c0 | 万灯戏台 | `tower` |
| r1c1 | 货龛 | `stall` |

`bridge` 与 `rock` 继续使用共用图集。

### 第三关专属地形

`world/stage-03/terrain-stage-03-v1.webp` 为 1024 × 1024、2 列 × 2 行，每格 512 × 512：

| 行列 | 地形 | 覆盖键 |
| --- | --- | --- |
| r0c0 | 云桥锚座 | `bridge` |
| r0c1 | 云钟 | `pillar` |
| r1c0 | 天坛 | `tower` |
| r1c1 | 归潮门 | `gate` 或出口地标 |

`rock`、`wall` 与 `stall` 继续使用共用图集。专属图集只按已声明的键局部覆盖共用图集，不能整张替代；查找顺序为「关卡专属键 → 共用特例 → 共用键 → 石柱回退」。

## 其他图集

`sprites-v2.webp` 为 3 × 2 透明图集，顺序为：

1. 重刃猎人
2. 符文枪手
3. 雾爪兽 / 通用小怪
4. 灯姬 / 远程雾兽
5. 潮卫 / 重甲怪
6. 雾港之母 / 首领

`icons-v2.webp` 为 3 × 2 透明图集，顺序为：

1. 重刃斩
2. 符文弹
3. 救援
4. 药葫芦
5. 猎团契约
6. 首领纹章

## 制作约束

- 场景、角色与图标必须使用真实栅格美术，不以 SVG（可缩放矢量图形）、圆形或方块代替。
- 角色图集保持透明背景、足部基线和视角一致，任何部件不得跨格。
- 移动端静态场景优先输出 WebP；逐帧透明角色图集使用经原图验收的 PNG，避免透明 WebP 编码产生色块。
- 原始高清 PNG、透明中间件、生成提示词和 QA（质量保证）截图按版本保存在 `art-source/v2/` 至 `art-source/v6/`。
- v6 三关只能通过 `scripts/build-world-v6.py` 从语义 JSON 与模块源图生成，禁止逐块手工修图；旧 `scripts/build-world-tiles.py` 只负责归档资源。
- 前景图集必须四角透明、单元格互不串格；客户端按资产键复用，不为每个障碍重复解码图片。
- 正式运行素材使用带版本号的文件名，避免 CDN（内容分发网络）旧缓存。

## 移动端资源预算

- 单张 1280 × 720 v6 地面块压缩体积不超过 750 KB；单张概览不超过 170 KB。
- 相机最多保留 4 张可见地图块，并预取至多 1 张相邻块；5 张地图块的 RGBA（红绿蓝透明通道）解码内存约 17.58 MiB。
- 每关地表图集不超过 900 KB，透明前景图集不超过 1.8 MB；动态遮罩按地面块同步加载与释放。
- 每张首领图集解码约 3 MiB，只在首领阶段加载。
- 不同时保留两个关卡的地图块或专属地形。预计第一关场景峰值约 22.1 MiB，第二、第三关约 26.1 MiB，首领阶段约 29.1 MiB；以上不含角色图集和画布。

## 当前正式素材

- `cover-v2.webp`：大厅封面
- `arena-v2.webp`：旧单屏战斗场景（仅归档）
- `sprites-v2.webp`：角色与怪物回退图集
- `icons-v2.webp`：技能与系统图标
- `mark-v2.webp`：猎团印章
- `vanguard-anim-v3.png`：重刃猎人逐帧动画
- `ranger-anim-v3.png`：符文枪手逐帧动画
- `crawler-anim-v4.png`：雾爪兽逐帧动画
- `brute-anim-v4.png`：潮卫逐帧动画
- `siren-anim-v4.png`：灯姬逐帧动画
- `fog-colossus-anim-v4.png`：雾潮巨像首领逐帧动画
- `lantern-regent-anim-v1.png`：赤灯摄政首领逐帧动画
- `tide-tortoise-anim-v1.png`：云汐潮甲首领逐帧动画
- `world/stage-0N/ground-r{row}-c{column}-v6.webp`：三关各 4 × 4 正式地面块
- `world/stage-0N/overview-v6.webp`：三关正式航路概览
- `world/stage-0N/surface-v6.webp`：三关各自的 2 × 2 地表图集
- `world/stage-0N/foreground-v6.webp` 与 `foreground-v6.json`：三关透明前景图集及锚点清单
- `world/stage-0N/ambient-mask-r{row}-c{column}-v6.png`：三关动态环境遮罩
- 旧 `map-*-v5/v1`、`terrain-*-v1` 与 `world-map-v4.webp`：仅归档，不作加载失败回退

## 可复现构建

v6 模块化源图保存在 `art-source/v6/`，完整规则与提示词见 `PIPELINE.md` 和 `PROMPTS.md`。在项目根目录执行：

```powershell
python -m pip install -r requirements-world-v6.txt
npm run validate:world-v6
npm run build:world-v6
```

可用 `--stage stage-01`、`stage-02` 或 `stage-03` 限定关卡。旧首领动作母表仍保存在 `art-source/v5/`，需要重建时单独执行 `python scripts/build-world-tiles.py --kind bosses`。构建后运行：

```powershell
node --test tests/art-direction.test.mjs
```
