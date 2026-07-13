# Book Automation

这是一个通过自然语言制作图书带货短视频的开源工作流。

## 准备环境

1. 安装 Codex，并把本仓库 clone 到本地。
2. 准备 Node.js 22+、FFmpeg 和网络访问能力。Codex 初始化时会检查这些条件。
3. 下载本地 ASR 所需的 Whisper 模型：

   ```bash
   node scripts/download-whisper-model.mjs
   ```

   脚本会把 `ggml-base.bin` 放到 `assets/models/whisper/ggml-base.bin`。

4. 在 Codex 中说：“初始化这个图书视频项目。” Codex 会运行初始化检查，并询问是否启用微信读书。启用后，它会引导你在本地配置 API Key；拒绝启用也可以继续用公开资料或指定书目制作。

## 制作步骤

1. 告诉 Codex 你要做哪本书，或者让它推荐五本适合做短视频的书。
2. Codex 确认书名、作者和版本，并写出一版视频文案。
3. 你审核文案；确认后，Codex 生成氛围图和视频画面。
4. 你用剪映或其他工具导出口播 MP3，并把文件路径告诉 Codex。
5. Codex 用 ASR 生成时间参考，以 `script.csv` 为字幕真源，对齐字幕、混入 BGM，并渲染最终 MP4。
6. 如果你要求替换文案、图片或音频，Codex 会生成新方案，通过检查后覆盖旧方案。

你也可以直接用自然语言操作，例如：

- “推荐五本适合做情绪共鸣类视频的书。”
- “我想制作一本关于孤独和自我成长的书。”
- “把当前文案换成我提供的版本。”
- “这版视频不满意，请保留模板，替换图片和文案。”

项目采用 Apache-2.0。微信读书、HyperFrames、GSAP、FFmpeg、字体和媒体文件各自遵循自己的许可条款。

更详细的内部生产规则见 `AGENTS.md` 和 `docs/book-video-playbook.md`。
