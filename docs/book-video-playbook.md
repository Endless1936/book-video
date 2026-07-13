# Book Video Playbook

这是唯一有效的图书带货视频生产 SOP。共享模板位于 `templates/shared-video-template/`；每期只替换书籍信息、文案、AI 图片、正文口播和 BGM。

## Workflow

1. 初始化：检查环境，按用户确认启用可选的微信读书 skill，创建本地 pipeline。
2. 选书：读取本地候选池；没有候选时先询问偏好，再搜索五本并标出首选。
3. 书目确认：确认书名、作者、版本和 `display_title`。
4. 文案确认：按本文的脚本原则只写一版文案，等待用户确认。
5. 图片制作：确认后生成 2-3 张 AI 氛围图和一张结果桥接图，记录提示词和来源。
6. 音频制作：接收用户的正文口播 MP3，应用故事感旁白处理；没有音频时只出纯画面预览。
7. 对齐渲染：ASR 只提供时间参考，`script.csv` 是字幕真源；裁剪 BGM 到视频长度并完成混音。
8. 验收替换：检查画幅、时长、字幕、音频和模板连续性。新方案通过技术检查后覆盖旧方案，保持每期只有一套活动资产。

## Fixed Output Rules

- `720x960`, `30fps`, 3:4。
- 玻璃碎片拼接开场、书单滚动、短黑场、结果页定格。
- 结果页进入正文时无跳变；书名和作者持续常驻。
- 正文使用 2-3 张 AI 氛围图慢推近和交叉淡入。
- 文字使用白色德意黑风格和纯黑文字阴影，不加黑色承托层或卡片 UI。
- 默认不超过 60 秒。

## Script Rules

- 第一句必须直接抓住观众，不先介绍书，也不铺垫“这本书适合谁”。
- 使用短句、口语化表达和具体生活场景，让情绪先成立，再自然带出书和作者。
- 书籍是情绪和信任的支点，不要写成书评、剧情梗概或主题讲解。
- 画面以氛围感优先，不必逐句解释文案；如果贴合文案会削弱画面，就保留意境。
- 结尾留下余味，不做 CTA，不写购物车、下单、推荐语。

避免：

- “你是不是”式营销开头。
- “不是……而是……”这类重复的 AI 论证句。
- 机械排比和口号化总结。
- “这本书告诉我们”这类生硬讲解。
- 高高在上的劝导语气。

## Active Episode Contract

```text
episodes/<book>/
  brief.json
  script.csv
  prompts.csv
  images/       # local, ignored
  audio/        # local, ignored
  renders/      # local, ignored
```

`script.csv` 使用 `display_title` 关联的书籍和唯一活动版本；它是字幕文本真源。`prompts.csv` 记录当前图片提示词、生成工具、来源和审核状态。

## Audio Contract

- Shared intro voice and gear SFX are local template media.
- Body voiceover starts with the formal book introduction.
- Process voiceover with the `story` preset.
- Store ASR timing with a matching `scriptVersion`; never use raw ASR text as final subtitles.
- If BGM is not specified, choose one available track at random. Commit music, SFX, and voiceover files only when redistribution rights are clear.

## Replacement Policy

Generate replacements under `tmp/`, validate them, then overwrite the active episode files and remove superseded media. Git preserves tracked text history; media history is intentionally not retained. A/B copies are temporary only and require explicit user approval.

## Copyright Boundary

Do not copy reference-video transcripts, long book excerpts, book reviews, popular-highlight dumps, downloaded social-media videos, user voice recordings, music, or account data into tracked files. Keep only independently worded production guidance in this playbook.
