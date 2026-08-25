# v5 三关地图、地形与首领美术生成记录

本轮使用 Codex 内置 ImageGen（图像生成）生成三张关卡母图、三张透明地形母表和两张首领动作母表，未使用 CLI fallback（命令行回退方案）。所有母图只作为可追溯源文件；正式运行资产由 `scripts/build-world-tiles.py` 机械导出，禁止逐块手工修图。

## 共同美术约束

- 方向：明亮国风木刻 / 剪纸，俯视三分之四视角，手工深色刻线、轻微套色错位与纸张纹理。
- 色彩：深海墨线 `#173f4a`、海蓝 `#2c9aae`、深海蓝 `#176f7d`、米纸 `#fff3cf`、亮米纸 `#fffaf0`、浅海青 `#b9e4df`、朱橙 `#e9674e`、深朱红 `#b94135`、暖金 `#f4bd45`。
- 可读性：道路、桥梁、浅滩、平台边缘和碰撞轮廓必须一眼可读；战斗中心保持低细节。
- 禁止项：UI（用户界面）、文字、数字、图标、地图格线、无关角色、密集微装饰、暗黑写实和照片质感。

## 第一关 · 晴潮雾港

源图：`stage-01-map-master.png`

提示词：

> Create a production-quality 16:9 raster master map for a top-down three-quarter-view cooperative action game, titled only conceptually “Clear-Tide Mist Harbor”; do not render any title or text. Preserve this fixed five-region journey and spatial order: a welcoming hunters’ camp with canvas tents and a warm coral fire in the lower-left; pale-cyan salt-fog marshes with broad boardwalks across the lower-middle; a sunken market plaza with roof islands in the center; a broken lighthouse ruin and tidal causeway in the lower-right; and a large golden fog-heart gate and boss clearing in the upper-right. Connect every region with unmistakable wide roads, bridges, shallow-water flats, and readable choke points. Make walkable ground clearly lighter and calmer than deep water. Use bright Chinese folk woodblock print and layered papercut aesthetics, hand-inked uneven navy outlines, restrained print misregistration, subtle rice-paper grain, sea blue and pale cyan foundations, warm rice-paper stone, coral-orange danger accents, and small warm-gold objectives. Upgrade the old harbor composition into a richly authored world while keeping all combat pads low-detail and collision silhouettes easy to see. Fixed overhead game-map composition, no horizon, no characters, no creatures, no UI, no lettering, no numerals, no legend, no border, no grid, no vignette, no photorealism, no gloomy horror, no dense microdetail in traversal routes.

正式输出：

- `public/assets/world/stage-01/map-r{row}-c{column}-v5.webp`
- `public/assets/world/stage-01/overview-v5.webp`

## 第二关 · 赤灯潮市

源图：`stage-02-map-master.png`

提示词：

> Create a production-quality 16:9 raster master map for a top-down three-quarter-view cooperative action game, conceptually “Crimson Lantern Tide Market”; render no title or text. Preserve this fixed left-to-right rising expedition route: a lower-left landing wharf and safe camp; a canal bazaar with broad timber walks and clustered awnings; a spacious central tide-market plaza designed as a low-detail combat arena; a right-side cargo quarter with visible sluice machinery and water channels; and an upper-right crimson lantern opera fortress with a large round boss court and a single ceremonial gate. All spaces must connect through wide readable roads, bridges, lock gates, and shallow-water crossings; the critical path must remain obvious at gameplay zoom. Bright Chinese folk woodblock print and layered papercut style, hand-inked uneven dark-navy contours, mild print misregistration, subtle paper fiber. Use sea blue, pale cyan and rice paper as the foundation, with coral red and warm gold dominant around lanterns, market roofs, objectives, and the boss fortress. Strong visual separation between safe walkable ground, deep water, raised collision obstacles, and dangerous machinery. No characters, no creatures, no UI, no writing, no symbols that resemble letters, no numerals, no legend, no border, no grid, no horizon, no photorealism, no black horror palette, and no clutter in combat centers.

正式输出：

- `public/assets/world/stage-02/map-r{row}-c{column}-v1.webp`
- `public/assets/world/stage-02/overview-v1.webp`

## 第三关 · 云汐天关

源图：`stage-03-map-master.png`

提示词：

> Create a production-quality 16:9 raster master map for a top-down three-quarter-view cooperative action game, conceptually “Cloud-Tide Heavenly Pass”; render no title or text. Preserve this fixed ascending journey: a lower-left cliff-edge sky harbor with a small safe landing; a chain of broad suspended bridges crossing luminous sea-cloud voids; a spacious central cloud-bell garden and combat court; right-side beacon terraces with stepped causeways; and an upper-right monumental warm-gold return gate on the highest platform, with a clear circular boss arena before it. The entire playable route must be continuous, unmistakable, and readable at gameplay zoom. Use bright Chinese folk woodblock print and layered papercut aesthetics, uneven deep-sea-navy ink contours, restrained print misregistration, subtle rice-paper texture, rice white and pale cyan cloud fields, sea-blue shadow planes, coral wayfinding accents, and warm gold on bells, beacons, and the final gate. Make platform edges, bridge footprints, walls, and collision silhouettes high-contrast; leave combat centers broad and low-detail. No characters, no creatures, no UI, no lettering, no numerals, no legend, no frame, no grid, no horizon, no photorealistic clouds, no dark horror, and no noisy decorative carpet over walkable areas.

正式输出：

- `public/assets/world/stage-03/map-r{row}-c{column}-v1.webp`
- `public/assets/world/stage-03/overview-v1.webp`

## 三关共用碰撞地形

源图：`terrain-common-source.png`

提示词：

> Create one transparent PNG environment-sprite contact sheet for a top-down three-quarter-view 2D action game. Strictly arrange exactly eight isolated collision obstacles in 4 columns by 2 rows, row-major order: (1) a compact rice-paper hunter hut with teal roof and coral rope, (2) a broken wooden pier segment with a strong rectangular footprint, (3) a small half-sunken skiff, (4) a jagged pale-cyan reef cluster, (5) a low warm-stone harbor wall, (6) a coral-and-gold market stall, (7) a round ruined lighthouse base, (8) a carved tide-stone pillar. Genuine fully transparent background and transparent cell gutters; no colored backdrop, no checkerboard, no visible grid, no dividers, no labels, no text, no numerals, no characters, no loose particles crossing cells. Keep every object centered with generous safe margins and nothing touching or crossing its cell. Consistent top-down three-quarter camera, consistent light from upper-left, clear grounded footprint, deep-sea-navy woodcut outlines, bright Chinese papercut shapes, sea blue, pale cyan, rice paper, coral and warm-gold palette. Prioritize a bold readable collision silhouette at small gameplay size; restrained interior detail, no photorealism, no cast shadow extending outside the object.

单元顺序（4 × 2，行优先）：猎团小屋、断栈桥、沉舟、暗礁、矮墙、货摊、灯塔塔基、潮纹石柱。

正式输出：`public/assets/world/terrain-common-v1.webp`，1536 × 768。

## 赤灯潮市专属碰撞地形

源图：`terrain-stage-02-source.png`

提示词：

> Create one transparent PNG environment-sprite contact sheet for the “Crimson Lantern Tide Market” level of a top-down three-quarter-view 2D action game. Strictly arrange exactly four isolated large collision landmarks in 2 columns by 2 rows, row-major order: (1) a crimson lantern ceremonial arch with a clearly readable base on both sides, (2) a chunky teal-and-brass canal sluice mechanism, (3) a compact raised opera platform with coral canopy and warm-gold trim, (4) a stacked cargo shrine made from rice-paper crates, ropes, lanterns and a small offering niche. Genuine fully transparent background and transparent gutters; no colored backdrop, no checkerboard, no visible grid, no dividers, no labels, no text, no letters, no numerals, no characters, no floating scenery. Center each landmark in its own cell with large margins and no overlap. Bright Chinese folk woodblock and layered papercut style, uneven deep-sea-navy outlines, mild print texture, consistent top-down three-quarter camera and upper-left lighting. Use sea blue and pale cyan support colors with coral red and warm gold as the distinctive level accents. Strong uncomplicated ground footprint and collision silhouette, low interior noise, no photorealism, no shadow crossing cell boundaries.

单元顺序（2 × 2，行优先）：赤灯牌坊、水闸机、万灯戏台、货龛。

正式输出：`public/assets/world/stage-02/terrain-stage-02-v1.webp`，1024 × 1024。

## 云汐天关专属碰撞地形

源图：`terrain-stage-03-source.png`

提示词：

> Create one transparent PNG environment-sprite contact sheet for the “Cloud-Tide Heavenly Pass” level of a top-down three-quarter-view 2D action game. Strictly arrange exactly four isolated large collision landmarks in 2 columns by 2 rows, row-major order: (1) a massive suspended-bridge anchor carved with tide-cloud motifs, (2) a broad bronze-and-gold cloud bell on a compact stone frame, (3) a low circular heavenly altar with pale-cyan inlay and coral wayfinding ribbons, (4) a monumental but compact golden return-gate fragment with a clearly readable base. Genuine fully transparent background and transparent gutters; no colored backdrop, no checkerboard, no visible grid, no separators, no labels, no text, no letters, no numerals, no characters, no cloud floor connecting objects. Center each landmark with generous margins; nothing may touch or cross a cell boundary. Bright Chinese folk woodblock print and layered papercut style, deep-sea-navy uneven contour ink, subtle paper grain, consistent top-down three-quarter camera and upper-left lighting. Rice paper and pale cyan dominate, with sea-blue shadow planes, coral guide accents and warm-gold sacred metal. Bold collision-readable footprint, restrained detail, no photorealism, no long cast shadows.

单元顺序（2 × 2，行优先）：云桥锚座、云钟、天坛、归潮门。

正式输出：`public/assets/world/stage-03/terrain-stage-03-v1.webp`，1024 × 1024。

## 赤灯摄政动作母表

源图：`lantern-regent-contact-source.png`

提示词：

> Create a strict transparent PNG animation contact sheet for one single boss character, the Lantern Regent of the Crimson Tide Market, in a bright Chinese folk woodblock and layered papercut style. Exactly 4 columns by 5 rows, twenty isolated full-body poses, equal cells, consistent identity, scale, costume, camera and foot anchor in every cell. Row 1 idle: four subtly different breathing and lantern-sway poses. Row 2 run: four distinct forward stride poses. Row 3 attack: four readable stages of a sweeping lantern-scepter attack that releases a compact coral tide arc. Row 4 hurt: four recoil poses. Row 5 down: four progressive collapse poses ending on the ground. The boss is an imposing masked regent in layered rice-paper, teal and coral ceremonial robes, with a warm-gold crown, a large red tide lantern and a short scepter; broad asymmetric sleeves but a clean readable silhouette. Top-down three-quarter game camera, facing generally right, upper-left lighting, uneven deep-sea-navy ink contours, subtle print texture. Genuine fully transparent background and transparent gutters. No environment, no floor, no backdrop color, no checkerboard, no visible grid lines, no cell borders, no labels, no text, no numerals, no extra characters, no detached props, no pose crossing cell boundaries, no long shadows, no photorealism. Keep every pose centered with large safe margins and all body parts inside its cell.

正式输出：`public/assets/lantern-regent-anim-v1.png`，8 × 6，每格 128 × 128，总尺寸 1024 × 768。四帧按 `0,1,2,3,2,1,0,1` 扩展，预留第六行复用倒地行。

## 云汐潮甲动作母表

源图：`tide-tortoise-contact-source.png`

提示词：

> Create a strict transparent PNG animation contact sheet for one single boss creature, the Tide Tortoise guardian of the Cloud-Tide Heavenly Pass, in a bright Chinese folk woodblock and layered papercut style. Exactly 4 columns by 5 rows, twenty isolated full-body poses, equal cells, identical creature identity, scale, camera and ground anchor in every cell. Row 1 idle: four breathing, head and tail-shift poses. Row 2 run: four heavy charging stride poses. Row 3 attack: four readable stages of a shell slam and compact pale-cyan tide burst. Row 4 hurt: four stagger and recoil poses. Row 5 down: four progressive collapse poses ending low on the ground. The creature is a massive but friendly-readable mythic tortoise, pale rice-paper body, teal limbs, deep-sea-blue shadow plates, a warm-gold pagoda-like shell crown, coral ribbons, small cloud-tide horns and a strong broad silhouette. Top-down three-quarter game camera, facing generally right, upper-left lighting, uneven dark-navy woodcut contours, layered papercut shapes, subtle print texture. Genuine fully transparent background and gutters. No environment, no cloud floor, no backdrop color, no checkerboard, no visible grid, no cell borders, no labels, no text, no numerals, no extra creatures, no detached effects outside the pose, no overlap across cells, no long shadows, no photorealism. Center every pose with generous safe margins and keep the full shell, head, limbs, tail and effects inside each cell.

正式输出：`public/assets/tide-tortoise-anim-v1.png`，8 × 6，每格 128 × 128，总尺寸 1024 × 768。四帧按 `0,1,2,3,2,1,0,1` 扩展，预留第六行复用倒地行。

## ImageGen 输出映射

本次内置 ImageGen 返回目录：

```text
C:\Users\wjm19\.codex\generated_images\01a031d1-863c-7e22-bfc5-af65cfa4a209\
```

| ImageGen 文件 | 复制为 | 原图规格 |
| --- | --- | --- |
| `exec-7a3e8d5f-0822-444e-9e5a-d1fa2ac05a38.png` | `stage-01-map-master.png` | 1672 × 941，3,408,223 B |
| `exec-82be33cf-f203-4ca8-90ee-1d22246fbe86.png` | `stage-02-map-master.png` | 1672 × 941，3,496,890 B |
| `exec-b032de8d-a02f-404d-b71e-c4d052c1861f.png` | `stage-03-map-master.png` | 1672 × 941，3,347,841 B |
| `exec-3f951407-54f0-4911-96ef-c6066c3086bb.png` | `terrain-common-source.png` | 1536 × 1024，2,964,666 B |
| `exec-74125b08-89b8-49e0-862a-f1cecf496e4b.png` | `terrain-stage-02-source.png` | 1536 × 1024，2,996,339 B |
| `exec-e5699388-4960-4a32-af5f-4c556282c5f1.png` | `terrain-stage-03-source.png` | 1536 × 1024，2,789,978 B |
| `exec-e41af959-1951-4cab-a337-f3a87464194e.png` | `lantern-regent-contact-source.png` | 1122 × 1402，2,475,254 B |
| `exec-8388a9db-43d0-492f-a09c-5c1b6f10b714.png` | `tide-tortoise-contact-source.png` | 1122 × 1402，2,700,909 B |

三张地形母表均含真实 Alpha（透明通道）且四角透明。两张首领母表均为 20 / 20 单元非空且四角透明：

- 赤灯摄政母表的不透明覆盖率（阈值 24）为 43.53%。
- 云汐潮甲母表的不透明覆盖率（阈值 24）为 47.77%。

## 机械导出

在项目根目录执行：

```powershell
python scripts/build-world-tiles.py
```

脚本执行以下机械步骤：

1. 将三张地图母图统一裁切 / 重采样到 5120 × 2880。
2. 每关输出 16 张 1280 × 720 地图块和一张 512 × 288 概览。
3. 将透明地形母表规范化为共用 4 × 2、关卡专属 2 × 2 图集。
4. 将两张 4 × 5 首领母表输出为 8 × 6、每格 128 × 128 的透明 PNG。

只重建指定类别或关卡：

```powershell
python scripts/build-world-tiles.py --kind maps --stage stage-01
python scripts/build-world-tiles.py --kind terrain
python scripts/build-world-tiles.py --kind bosses
```

脚本依赖 Pillow；如果默认 `python` 缺少 `PIL` 模块，应切换到已安装 Pillow 的 Python 运行时，不能手工改写导出文件。

## 正式产物体积

| 资产组 | 文件数 | 压缩体积 |
| --- | ---: | ---: |
| 第一关地图块 | 16 | 1,957,906 B |
| 第一关概览 | 1 | 59,270 B |
| 第二关地图块 | 16 | 2,011,590 B |
| 第二关概览 | 1 | 59,758 B |
| 第二关专属地形 | 1 | 372,660 B |
| 第三关地图块 | 16 | 1,868,950 B |
| 第三关概览 | 1 | 58,270 B |
| 第三关专属地形 | 1 | 392,314 B |
| 共用地形 | 1 | 452,218 B |
| 赤灯摄政图集 | 1 | 575,249 B |
| 云汐潮甲图集 | 1 | 697,705 B |

`public/assets/world/` 共 54 个文件，合计 7,232,936 B。

## 验证

```powershell
node --test tests/art-direction.test.mjs
```

资产契约应验证：

- 三关各 16 张地图块均为 1280 × 720，概览均为 512 × 288。
- 每张地图块不小于 40 KB 且不超过 700 KB；概览不超过 160 KB。
- 三张地形图集均保留 Alpha。
- 两张首领图集均为 1024 × 768 的透明 PNG。
