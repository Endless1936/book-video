# Body Template

正文模板由脚本生成临时工程，不手动复制。

固定标准：

- 第一帧沿用 `result-bridge.png`，和开场结果页无跳变衔接。
- 后续使用 2-3 张 AI 氛围图，慢推近和交叉淡入。
- 书名和作者顶部常驻。
- 字幕使用 `script.csv` 文本和 `audio/body-timings.json` 时间。
- 时间轴生成：`node scripts/create-body-timings.mjs "<book>" <script-version>`；以语音停顿映射脚本行，Whisper 文本仅供 Agent 复核。停顿不足时按语音时长和脚本提示估算并继续生成。

正式生产入口：

```bash
node scripts/render-episode-final.mjs "<book>" <script-version> <bgm-name>
```

复用降级测试：

```bash
npm run smoke:timings -- "<book>" <script-version>
npm run smoke:timings -- "<book>" <script-version> --render --bgm "<bgm-name>"
```

测试复制本地剧集，不修改原剧集。默认覆盖时间轴缺失、损坏、版本过期和单条时间异常；`--render` 额外输出正常版与降级版 MP4。
