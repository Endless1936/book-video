# Body Template

正文模板由脚本生成临时工程，不手动复制。

固定标准：

- 第一帧沿用 `result-bridge.png`，和开场结果页无跳变衔接。
- 后续使用 2-3 张 AI 氛围图，慢推近和交叉淡入。
- 书名和作者顶部常驻。
- 字幕使用 `script.csv` 文本和 `audio/body-timings.json` 时间。

正式生产入口：

```bash
node scripts/render-episode-final.mjs "<book>" <script-version> <bgm-name>
```
