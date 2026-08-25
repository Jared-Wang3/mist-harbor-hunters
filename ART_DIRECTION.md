# 雾港猎团 · 美术方向

## 已确认方向

本项目采用「明亮国风木刻 / 剪纸」作为正式美术方向：

- 造型：粗细不完全均匀的深色刻线、纸雕式大轮廓、少量套色错位与手工印刷纹理。
- 气质：冒险、热闹、带民俗感；避免阴沉恐怖、暗黑写实和玻璃拟态。
- 配色：海蓝、浅青、米白为大面积色；朱橙与暖金用于操作、危险和关键反馈。
- 可读性：人物和怪物以清晰剪影优先，战斗场景中央保持低细节，UI（用户界面）使用不透明纸张色块。
- 地形：可行走区域、深水、平台边缘与实体障碍必须在正常游戏画面中直接可见，不能依赖 Debug（调试）轮廓才读得懂。

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
6. 预留技能行（当前未由服务端触发）

两个图集统一采用脚底锚点，由客户端按照服务端 `action` / `actionSeq` 与本地移动状态选择动作。`sprites-v2.webp` 中的前两格只保留为头像和加载失败回退。

主要敌人也使用相同的 8 × 6、128 × 128 单元格契约：`crawler-anim-v4.png`、`brute-anim-v4.png`、`siren-anim-v4.png` 与 `fog-colossus-anim-v4.png`。

第二、第三关首领延用同一契约：`lantern-regent-anim-v1.png` 对应赤灯摄政，`tide-tortoise-anim-v1.png` 对应云汐潮甲。角色和首领动画只在真正进入镜头或首领阶段后采用 lazy loading（懒加载），避免手机在开始主页一次解码全部动作表。

## 三关世界场景契约

三个独立关卡均对应 5120 × 2880 游戏世界，并由同一张母图机械切成 4 × 4 的 WebP（网页图像格式）地图块。每块为 1280 × 720，`row` 与 `column` 均从 0 到 3：

- 第一关「晴潮雾港」：高质量重绘现有旅程，从左下猎团营地，经盐雾湿地、沉没集市与灯塔遗址，到达右上潮雾之心。正式地图块为 `world/stage-01/map-r{row}-c{column}-v5.webp`。
- 第二关「赤灯潮市」：从左下登陆埠进入运河潮市，经赤灯商廊、中央集市、货栈与水闸，抵达右上万灯戏台与摄政门。正式地图块为 `world/stage-02/map-r{row}-c{column}-v1.webp`。
- 第三关「云汐天关」：从左下悬崖云港出发，经悬索桥、云钟庭院与烽灯台，登上右上金色天关。正式地图块为 `world/stage-03/map-r{row}-c{column}-v1.webp`。

客户端只加载相机附近地图块，并在离开关卡后释放旧关卡资源。每关另有一张 512 × 288 的 `overview`：

- `world/stage-01/overview-v5.webp`
- `world/stage-02/overview-v1.webp`
- `world/stage-03/overview-v1.webp`

`overview` 只用于开始主页的三章航路预览、小地图与加载占位，不得放大作为战斗场景铺底。`world-map-v4.webp` 仅保留为旧版归档和加载失败回退。

## 透明碰撞地形契约

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
- 原始高清 PNG、透明中间件、生成提示词和 QA（质量保证）截图按版本保存在 `art-source/v2/`、`art-source/v3/`、`art-source/v4/` 与 `art-source/v5/`。
- 三张关卡母图只能通过 `scripts/build-world-tiles.py` 机械导出地图块和概览，禁止逐块手工修图，以免相邻块出现接缝。
- 地形图集必须四角透明、单元格互不串格；客户端按地形键复用，不为每个障碍重复解码图片。
- 正式运行素材使用带版本号的文件名，避免 CDN（内容分发网络）旧缓存。

## 移动端资源预算

- 单张 1280 × 720 地图块压缩体积不超过 700 KB；单张概览不超过 160 KB。
- 相机最多保留 4 张可见地图块，并预取至多 1 张相邻块；5 张地图块的 RGBA（红绿蓝透明通道）解码内存约 17.58 MiB。
- 共用地形图集解码约 4.5 MiB；第二、第三关专属地形各约 4 MiB。
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
- `world/stage-01/map-r{row}-c{column}-v5.webp`：晴潮雾港 4 × 4 地图块
- `world/stage-01/overview-v5.webp`：晴潮雾港航路概览
- `world/stage-02/map-r{row}-c{column}-v1.webp`：赤灯潮市 4 × 4 地图块
- `world/stage-02/overview-v1.webp`：赤灯潮市航路概览
- `world/stage-03/map-r{row}-c{column}-v1.webp`：云汐天关 4 × 4 地图块
- `world/stage-03/overview-v1.webp`：云汐天关航路概览
- `world/terrain-common-v1.webp`：三关共用透明碰撞地形图集
- `world/stage-02/terrain-stage-02-v1.webp`：赤灯潮市透明碰撞地形图集
- `world/stage-03/terrain-stage-03-v1.webp`：云汐天关透明碰撞地形图集
- `world-map-v4.webp`：旧版单图地图（仅归档与加载失败回退）

## 可复现构建

母图、透明地形母表与首领动作母表保存在 `art-source/v5/`；完整提示词见 `art-source/v5/PROMPTS.md`。在项目根目录执行：

```powershell
python scripts/build-world-tiles.py
```

可用 `--kind maps`、`--kind terrain` 或 `--kind bosses` 只重建一类资产；地图还可用 `--stage stage-01`、`stage-02` 或 `stage-03` 限定关卡。构建后运行：

```powershell
node --test tests/art-direction.test.mjs
```
