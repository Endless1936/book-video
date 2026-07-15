# Book Video

这是一个通过自然语言制作图书带货短视频的开源工作流。它把选书、文案、氛围图、旁白对齐和成片制作组织成一套可复用的流程。

Copyright (c) 2026 prototech, endless, and 未济.

## 如何使用

你不需要先学习代码或命令。打开 Codex 后，直接用自然语言描述你想做的图书视频即可。

如果是第一次使用，Codex 会先自动检查和准备本地环境。需要你确认的地方，它会直接问你。

## 制作步骤

1. 告诉 Codex 你要做哪本书，或者让它推荐五本适合做短视频的书。
2. Codex 确认书名、作者和版本，并在对话中用代码块完整展示可直接复制到剪映的配音稿，第一行包含书名，同时保存为本地脚本文件。
3. 你直接在对话中审核文案；确认后，Codex 生成氛围图和视频画面。
4. 你用剪映或其他工具导出口播 MP3，并把文件路径告诉 Codex。
5. Codex 用 ASR 生成时间参考，以 `script.csv` 为字幕真源，对齐字幕、混入 BGM，并渲染最终 MP4。
6. 如果你要求替换文案、图片或音频，Codex 会生成新方案，通过检查后覆盖旧方案。

## 全自动制作

你可以明确要求 Codex 连续完成一集，例如：

- “全自动制作《我与地坛》，中间不用问我确认。”
- “全自动选一本关于孤独与成长的书，并做成视频。”
- “批量制作《我与地坛》《人间草木》，单本失败时继续下一本。”

全自动模式会覆盖普通流程的人工审批门（包括文案确认），但仅对当次指定的单集有效。普通制作和之后的其他视频仍会按原流程请你确认。

第一次制作时，Codex 会在剪映中选择一个自然、克制的普通话叙事音色，并把选择保存在本地 `.book-video-config.json` 中；之后的制作会自动复用它。如果界面或运行中断，再次要求 Codex 继续即可：它会读取 `episodes/<书名>/production-state.json` ，从下一个未完成阶段恢复，而不是重做已成功的步骤。

### 命令行入口

以下命令主要用于调试或与 Codex 协作：

```bash
node scripts/auto-produce.mjs book "我与地坛"
node scripts/auto-produce.mjs auto --theme "孤独与自我成长"
node scripts/auto-produce.mjs batch "我与地坛" "人间草木"
node scripts/auto-produce.mjs resume "我与地坛"
```

独立运行 CLI 只会输出 JSON Agent action，其中命令动作使用结构化的 `inputs: { executable, args }`；它不会自己操作剪映或生成图片。完整自动化由 Codex 解析这些动作，用内置位图生成能力制作氛围图，并通过 Codex Computer Use 操作剪映界面。Node.js 不会也不应直接控制剪映。每个动作成功后，Agent 会用 `scripts/record-production-stage.mjs` 记录阶段，再调用 `resume` 继续。

你也可以直接用自然语言操作，例如：

- “你好。”
- “推荐五本适合做情绪共鸣类视频的书。”
- “我想制作一本关于孤独和自我成长的书。”
- “把当前文案换成我提供的版本。”
- “这版视频不满意，请保留模板，替换图片和文案。”

## 参考来源

本项目的图书视频工作流参考了[原帖](https://x.com/369Serena/status/2073398014333321498)，特此致谢。

## 版权与许可

本项目的代码、文档和可复用模板采用 [Apache-2.0](LICENSE) 发布，版权方为 prototech（组织名），endless（网名）。Apache-2.0 不代表它自动覆盖第三方工具、字体、模型、图片生成服务或媒体素材。

仓库包含四首默认 BGM，位于 `assets/bgm/`：`城南花已开.mp3`、`红色高跟鞋.mp3`、`起风了.mp3`、`如愿.mp3`。项目维护者已确认这些文件可以随本项目公开再发布；它们的来源和授权状态记录在 `templates/shared-video-template/ASSET_PROVENANCE.csv` 中。将音频用于其他商业场景时，仍需遵守对应授权范围。

更详细的内部生产规则见 `AGENTS.md` 和 `docs/book-video-playbook.md`。
