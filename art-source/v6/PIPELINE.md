# 雾港猎团 v6 模块化世界管线

v6 不再把一张概念图放大后切成地图。每关由四类 seamless surface（无缝地表）、六类 transparent foreground prop（透明前景道具）、一类 edge decal（边缘贴花）和一份 semantic world data（语义世界数据）共同生成。

## 单一职责

- `src/world-v6/stage-0N.json`：玩法几何、区域、刷怪锚点、阻挡、道具脚点与 ambient emitter（环境动态发射器）。
- `art-source/v6/stage-0N/surfaces/`：至少 1024×1024 的正交俯视无缝地表源图。
- `art-source/v6/stage-0N/props/`：至少 768×768、透明背景、完整轮廓的前景道具源图。
- `art-source/v6/stage-0N/edge-decal-source.png`：透明、可重复铺设的水岸／运河／云崖边缘贴花。
- `scripts/build-world-v6.py`：只做下采样、语义合成、图集打包、动态遮罩与地图切片；不把低分辨率概念图上采样为正式地图。

旧 `art-source/v5/` 与旧地图块仅作历史归档，生产客户端不引用。

## 构建

构建环境需要 Python 3.10 或更高版本，并按项目根目录的 `requirements-world-v6.txt` 安装固定版本依赖。

```powershell
python -m pip install -r requirements-world-v6.txt
npm run validate:world-v6
npm run build:world-v6
```

可只检查或构建一关：

```powershell
python -B scripts/build-world-v6.py --stage stage-01 --validate-only
python -B scripts/build-world-v6.py --stage stage-01
```

构建器会检查源图最低尺寸、透明通道、透明四角和地表边缘差异。地表即使存在轻微边缘色差，也会使用 mirror normalization（镜像归一化）连续铺设，避免 4×4 地图块接缝。

### Transparent matting（透明抠图）记录

当前内置 ImageGen 对部分道具会把棋盘格或白底烘焙进 RGB。经用户明确授权，v6 道具采用以下可复现的技术整理：

1. ImageGen 仍负责完整主体创作，背景要求为均匀 `#FF00FF` chroma key（色键）或纯白；主体禁止使用该背景色。
2. 本地只对与画布边界连通的背景做 flood-fill（泛洪填充）和色差遮罩，不重绘主体。
3. 轮廓使用约 4 px feather（羽化），并清理半透明边缘的白色／洋红色 matte spill（底色污染）。
4. 已有真 Alpha 但贴边的图只允许等比缩小并增加透明 padding（留白），不得拉伸或裁掉主体。
5. 每张最终图必须复核四角 Alpha=0、Alpha 范围 0–255、细绳与内孔保留，并分别在亮／暗底检查白边、棋盘残留和色键污染。

## 输出契约

每关输出到 `public/assets/world/stage-0N/`：

- `ground-r0-c0-v6.webp` 至 `ground-r3-c3-v6.webp`：16 张 1280×720 地面块。
- `overview-v6.webp`：512×288 航路概览。
- `surface-v6.webp`：1024×1024，2×2、每格 512 的地表图集。
- `foreground-v6.webp`：1536×768，4×2、每格 384 的透明前景图集。
- `foreground-v6.json`：前景单元、锚点与可见内容边界。
- `ambient-mask-r0-c0-v6.png` 至 `ambient-mask-r3-c3-v6.png`：16 张 320×180 RGB data texture（RGB 数据纹理）。

动态遮罩通道固定为：

- R：water/cloud（海水、运河或云海）。
- G：edge/foam/wind（水岸泡沫或风流）。
- B：glow/reflection/fog（灯光、倒影与环境雾）的合成强度。

动态遮罩必须保存为不含 Alpha 的 RGB PNG。浏览器 Canvas 会对透明图像做 premultiplied alpha（预乘透明度）处理，透明像素中的 RGB 数据无法可靠读取，因此禁止把语义数据写入 Alpha 或全透明像素的颜色通道。

## Runtime（运行时）分层

正式绘制顺序为：地面块 → 世界坐标动态水／云／光 → 收集物与地面效果 → 前景道具、敌人与角色按脚点 y-sort（纵深排序）→ 环境覆盖层 → 战争迷雾 → 指示器与 HUD。

`terrain-boundary` 只参与服务端碰撞，不能额外绘制；`v6-prop` 使用 `visualX`、`visualY`、`anchor` 与 `scale` 绘制，碰撞仍使用自身 `x`、`y`、`width`／`height`／`radius`。

## 验收

- 三关 `geometryHash`、可走路线、阻挡与出生／出口均不同。
- 出生点、目标、Boss 和 encounter anchor（遭遇锚点）不得压在碰撞体中。
- 角色、敌人与 AI 不能越过深水、运河或云渊。
- 每关至少三件高前景道具能正确遮住角色下半身，并在角色走到前方时退到角色之后。
- 静止镜头中仍能看到水纹、倒影、云流或风纹按世界坐标移动；镜头移动时效果不能粘在屏幕上。
- 地图块边界不得出现亮线、断纹或相位跳变。
- v6 资源加载后，生产代码不得请求旧 v5/v1 世界地图或旧地形图集。
