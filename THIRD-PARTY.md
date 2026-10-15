# 第三方素材与致谢

## dsh-whale-musume（鲸鲸看板娘）

- 仓库：https://github.com/Sutera-Diffusus/dsh-whale-musume
- 作者：Sutera-Diffusus 及其贡献者
- 许可：MIT
- 本项目使用的部分：`vendor/whale/` —— 即上游的 `assets/` 目录（桌宠表现层
  `dsh-whale-moe.js`、纯函数状态机 `whale-moe-core.js`、样式 `dsh-whale-moe.css`、
  校准表 `peek-calibration.json`、以及 `generated/` 下 90+ 张立绘），外加上游 LICENSE 原文。
- 上游版权声明见 `vendor/whale/LICENSE`。

上游是 DSH（DeepSeek Harness）的一个插件，形态是"网页内的看板娘"。
本项目**只复用它的桌宠本体素材**，另外写了一个 Electron 宿主，
让它脱离浏览器、成为可以浮在桌面上的独立挂件。

上游的 MIT 许可允许复制、修改、再分发，条件是保留版权声明与许可原文——
这就是 `vendor/whale/LICENSE` 存在的原因。**修改上游素材时请保留该文件。**

## 同步上游

```bash
npm run sync:upstream              # 取上游最新 release tag
npm run sync:upstream -- v2.1.0    # 指定 tag
npm run check:vendor               # 校验素材完整性
```

同步记录写在 `vendor/upstream.json`（上游仓库、tag、同步时间）。

## dsh-pet（闲时动作动画素材）

- 仓库：https://github.com/PC2005-cloud/dsh-pet
- 作者：pc2005-cloud 及其贡献者
- 许可：MIT（npm 包 `dsh-pet`，描述："吃白饭的蓝色大肥鱼，赖在 DeepSeek Harness 里不走了……"）
- 本项目使用的部分：`src/pet/anim/webm/` —— 从该插件的 `assets/webm/` 取 **91 段闲时动作
  视频**（小动作 / 玩耍 / 吃什么 / 时节 四类全量；未取工作状态、余额、碎碎念等事件类）。
  另参考其 `assets/config.jsonc` 的动作分类与权重，移植为我们闲时随机链的动作池
  （见 `src/pet/anim/anims.js` 的 `ACTION_POOL` / `ACTION_MENU`）。

上游同样是 DSH（DeepSeek Harness）插件，形态是"网页内会随机表演动作的桌宠"。
本项目**只复用它的动作视频素材与动作分类思路**，播放层（video 覆盖、随机链、
空闲三段式规则）是我们在 Electron 宿主里另写的。

上游的 MIT 许可允许复制、修改、再分发，条件是保留版权声明与许可原文——
**许可原文随素材一起放在 `src/pet/anim/LICENSE`**（会随打包一起分发）。
**修改或替换这批素材时请保留该文件。**

## Electron

- 许可：MIT
- 用途：桌面窗口宿主（透明置顶、点击穿透、托盘）。
