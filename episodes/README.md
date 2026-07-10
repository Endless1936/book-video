# Episodes

每期视频一个文件夹，只保存本期差异化内容，不复制核心视频代码。

推荐结构：

```text
episodes/book-slug/
  brief.json        # 书籍信息、主情绪、目标人群、视觉方向
  script.csv        # 唯一现行字幕/旁白文本
  prompts.csv       # 唯一现行 AI 生图方案
  images/           # AI 生成图片，git 忽略
  audio/            # 口播、ASR、body-timings.json，git 忽略
  renders/          # 渲染结果，git 忽略
```

维护原则：

- `templates/` 维护共享视频代码和检查清单。
- `episodes/` 只维护每本书自己的文案、配置和提示词。
- 音频版必须确认口播匹配的 `script.csv` 版本。
- 新方案生成成功后覆盖旧方案；文本历史交给 Git，媒体旧版不归档。
- 当前只保留最新有效图片、音频和 render，错误版和过期预览及时删除。
- A/B 对比文件只能临时放在 `tmp/`，确认选择后删除。
