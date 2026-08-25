# v4 世界与怪物美术生成记录

本轮使用 Codex 内置 ImageGen 生成连续世界母图和四类怪物动作母表，未使用 CLI fallback。正式运行资产位于 `public/assets/`，可追溯源图与透明中间件保存在本目录。

## 连续港镇地图

提示词要求一张明亮国风木刻 / 剪纸风的俯视三分之四视角海港群岛地图，形成一块可连续行走的世界：左下是猎团营地与篝火，中下是盐雾湿地和木栈道，中部是沉没集市，右下是灯塔遗址，上右是金色祭坛和发光撤离门。区域之间必须由可读道路、桥梁和浅滩连接，使用海蓝、浅青、米纸、朱橙、暖金与深海墨线，不画 UI、文字、格线或角色。源图 `world-map-source.png` 保留完整构图；正式 `world-map-v4.webp` 裁成 16:9 并以高质量重采样输出为 3072 × 1728。

## 怪物动作母表

共同约束：纯 `#FF00FF` 色键背景、同一角色身份与比例、俯视三分之四视角、面向右侧、无阴影 / 场景 / 文字 / 格线。4 列 × 5 行依次表现待机、奔跑、攻击、受伤和倒地，每行四个不同姿势。后处理移除色键并按 `0,1,2,3,2,1,0,1` 编为 8 × 6 透明 PNG；移动端正式规格为每格 128 × 128。

- `crawler-contact-source.png`：浅海青四足雾爪兽，珊瑚角、卷云尾，攻击有扑咬和水纹爪痕。
- `brute-contact-source.png`：青金重甲潮卫，珊瑚冠、弯刀与盾牌，攻击有举刀、劈砍和水花冲击。
- `siren-contact-source.png`：白发灯姬，米白与浅青长衣、符灯和雾带，攻击释放蓝色潮雾。
- `boss-contact-source.png`：雾港之母，深青金冠、白发、多条海雾触腕和潮水法术，体量显著大于普通敌人。

正式资产：

- `public/assets/crawler-anim-v4.png`
- `public/assets/brute-anim-v4.png`
- `public/assets/siren-anim-v4.png`
- `public/assets/fog-colossus-anim-v4.png`
