# v6 美术生成提示词档案

所有源图均使用内置 ImageGen 生成。旧关卡概览只用于 palette and shape language（色板与造型语言）参考，不作为可放大的正式地图底图。

## 全局风格锁

共同要求：明亮东方海雾幻想、手绘国风版画与克制水墨晕染结合、面向 2D top-down action game（俯视动作游戏）、造型清楚、低频大色块与可读材质细节兼具。禁止文字、标志、水印、人物、敌人、UI、透视地平线、摄影景深和单向强光。

Surface（地表）共同尾词：

> Orthographic top-down seamless square material texture, perfectly tileable on all four edges, even ambient illumination, no object, no landmark, no border, no frame, no directional shadow, no text. Preserve natural medium-scale variation without a recognizable repeated centerpiece. Minimum 1024×1024.

Prop（前景道具）共同尾词：

> One complete isolated game prop, elevated three-quarter top-down view consistent with an orthographic 2D action map, fully visible silhouette and clear ground contact/foot point, no cropped part, no scenery, no character, no text, no frame. Place it on a perfectly uniform flat chroma-key magenta #FF00FF backdrop; the prop itself must contain no magenta or purple. No gradient, texture, checkerboard, floor plane or cast shadow. Minimum 768×768.

Edge decal（边缘贴花）共同尾词：

> One long continuous modular edge strip across the middle third, horizontally repeatable with matching left/right endpoints, on a perfectly uniform flat chroma-key magenta #FF00FF backdrop. Large empty areas above and below; no text or frame. Minimum 768×768. The approved local matting step converts only the backdrop to Alpha.

## Stage 01 · 晴潮雾港

Surface：

- `sand-stone-source.png`：潮湿浅沙与青灰港石碎片，暖纸色基底，稀疏贝壳粉和盐蚀裂纹。
- `marsh-mud-source.png`：青褐盐沼泥、浅水光斑、细碎芦苇根痕，不能出现完整植株。
- `boardwalk-source.png`：旧杉木栈板、铜钉、盐白磨损，板缝方向可读但无独立码头轮廓。
- `deep-water-source.png`：青绿深潮水面、柔和墨蓝流纹与少量乳白反光，不出现岸线。

Prop：

- `hunter-hut-source.png`：轻巧猎人棚屋，青瓦、旧木、卷起的防潮帘与小型铜灯。
- `broken-pier-source.png`：断裂木码头一段，残桩、绳索、青铜包角，脚点位于近端桥头。
- `reef-cluster-source.png`：数块潮蚀青灰礁石与少量贝壳，整体轮廓紧凑。
- `flood-wall-source.png`：低矮浸水石墙，盐白侵蚀、铜制加固与缺口。
- `market-stall-source.png`：倾斜港市棚摊，褪色朱红帆布、旧木台与少量空篮。
- `lighthouse-base-source.png`：旧灯塔下半部石基，青灰圆形台座、铜箍与一段残梯。

Edge：`edge-decal-source.png` 为青绿潮线、乳白泡沫、稀疏芦苇根和湿边水墨晕染。

## Stage 02 · 赤灯潮市

Surface：

- `market-stone-source.png`：暖灰潮市石板、暗红砖缝、零散铜屑。
- `wet-brick-source.png`：湿润深红砖面、柔和灯色反射、磨平边角。
- `timber-wharf-source.png`：深栗色商埠木板、黄铜铆钉与潮湿磨痕。
- `canal-water-source.png`：深青运河水、碎金红灯倒影、缓慢横向涟漪，不出现岸线。

Prop：

- `landing-arch-source.png`：赤灯泊门，砖石拱、铜灯架与轻薄红绸。
- `canal-bridge-source.png`：短跨石木运河桥，低栏、铜钉、两端脚点清楚。
- `sluice-machine-source.png`：古代潮闸机括，青铜齿轮、木制轮轴与石基。
- `cargo-shrine-source.png`：货箱堆成的小灯龛，红漆木箱、铜灯、系绳。
- `opera-stage-source.png`：小型水戏台，朱红檐、木台、卷起帘幕，正面脚点清楚。
- `regent-gate-source.png`：威严摄政门，红砖石基、铜门框、成排赤灯。

Edge：`edge-decal-source.png` 为深青运河边、湿砖反光、碎金灯影与少量水草。

## Stage 03 · 云汐天关

Surface：

- `heavenly-stone-source.png`：浅玉灰天关石面、淡青云纹、细小风蚀纹理。
- `gold-inlay-source.png`：浅石底上的克制金线嵌纹与圆形潮汐符号碎片，不构成完整徽章。
- `bridge-deck-source.png`：青白天桥石板、铜金包边、平行风纹磨痕。
- `cloud-void-source.png`：淡青白云海、深浅层叠墨云与柔和天光，不出现地面或岛缘。

Prop：

- `sky-dock-source.png`：云舟泊台，浅石基、青木悬臂与金属系泊环。
- `bridge-anchor-source.png`：厚重天桥锚柱，玉灰石、铜金束带与浮云纹。
- `cloud-bell-source.png`：高挑云钟架，青铜钟、浅石柱与飘带。
- `beacon-tower-source.png`：细长云汐烽台，浅石塔、青金灯室与风向片。
- `heavenly-altar-source.png`：低矮天关祭台，圆形玉石层台与克制金线。
- `return-gate-source.png`：归潮天门，浅玉石双柱、青金梁与半透明云帘。

Edge：`edge-decal-source.png` 为云崖白边、卷云碎片、青金风纹和稀薄高空雾带。
