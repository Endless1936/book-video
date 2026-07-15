# Book Video Agent Guide

This repository is an open-source, natural-language workflow for producing short book videos. Keep reusable code, templates, owned assets, and distilled methods in Git. Keep credentials, private book data, downloaded reference videos, generated episode work, and account data local.

## Startup Checklist

For the first user message in this repository, including a simple greeting such as "你好", run the startup checklist before normal task work unless `.book-automation-state.json` already exists and the user is asking an unrelated repository-maintenance question.

1. Resolve the current repository root with `git rev-parse --show-toplevel`; never hard-code a previous clone path. Check Codex capabilities first: the HyperFrames plugin/Skill and built-in bitmap image generation are capabilities, not user-installed project dependencies. Use them directly when available; do not ask the user to install a separate image model or HyperFrames Skill.
2. Check local runtime prerequisites in one pass by running `node scripts/init.mjs` from the resolved repository root. Do not replace this with an ad-hoc `command -v` plus parsed `--version` output: FFmpeg and FFprobe commonly write version banners to stderr, so a blank stdout is not a missing-command signal. Trust the command exit status and the JSON check result. If Node.js 22+, `npx`, FFmpeg/FFprobe, or `whisper-cli` are missing, report the complete list and ask for one confirmation before installing them. After confirmation, the Agent may install them with the available platform package manager; never install or change system packages silently. The repository does not auto-install these through a project script.
3. HyperFrames runs through `npx hyperframes@0.7.33`, so the first check or render may need npm registry access even when the HyperFrames Skill is available. If `npx` reports `ENETUNREACH`, `EACCES`, `ENOTFOUND`, `ENOTCACHED`, registry access blocked, or a system network policy failure, classify it as an environment/network issue and immediately retry the same check/render with the execution tool's network-capable escalation. Do not ask the user for a second confirmation or ask them to repeat the workflow. Only report the blocker if the escalation itself is denied or fails. Try the local npm cache with `npx --offline` only as a quick fallback; it cannot replace network access when the package is not cached.
4. Check the model at `<repo-root>/assets/models/whisper/ggml-base.bin` using file existence and size, not `ls` output alone; a valid file is at least 100 MB. If missing, ask to download it as part of the confirmed setup, then run `node scripts/download-whisper-model.mjs`. If the download fails, first look for an enabled computer proxy or proxy environment variable; use it for a retry with `--proxy`, asking the user to enable their proxy when none is active. Do not change system network settings silently. If that fails, give the user the browser URL `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`, then install the user-provided file with `node scripts/download-whisper-model.mjs --from "<local-path>"`.
5. Ensure the official Tencent WeChat Reading Skill is installed and enabled through the agent's skill installer when absent; do not ask whether to enable it and do not vendor its source into this repository.
6. If the initialization result reports `wereadApiKey: true` or `weread: enabled`, treat WeChat Reading as configured and never ask for the key again. Only when the result reports it is missing, ask whether to configure the integration. After confirmation, open [微信读书 Skills 官网](https://weread.qq.com/r/weread-skills) with the browser/computer tool and explicitly tell the user: “请在页面获取 API Key，完成后回到本对话把 Key 发给 Agent。” After the user sends it, store it in local `.env` with mode `0600`; never echo or log the key, and never accept it as a command argument. If the user declines key configuration, continue with public research.
7. Run `scripts/init.mjs` after the dependency and Skill checks. It creates local state and the private pipeline file without asking a second WeChat Reading enablement question.

After a body voiceover is supplied, run `node scripts/create-body-timings.mjs "<book>" [script-version]`. When the version is omitted, the Agent resolves it from `brief.json` or the unique version in `script.csv`. It writes Whisper output under the local episode audio folder and creates `body-timings.json` from speech pauses. The default skips the spoken title/author segment; use `--skip-leading 0` when the audio starts directly with the first script line.

Initialization must be idempotent. It must not reinstall a verified skill, overwrite a valid key, reset user choices, or duplicate CSV columns.

## Book Selection

- If the user names a book, use it after verifying title and author.
- If `data/book-pipeline.csv` is missing, header-only, or has no usable candidates, ask one question covering preferred genre, emotional theme, or audience.
- With a preference, search according to it. Without a preference, search literary/philosophical books with strong emotional resonance for young adults.
- After every candidate search, write the complete result set to the local ignored `data/book-pipeline.csv` before recommending. Use `node scripts/record-book-candidates.mjs <candidates.json>` so fields are normalized and duplicate results are merged; never only present search results in chat.
- Recommend five candidates from the recorded rows and mark one top recommendation. Wait for book selection before drafting.
- When the WeChat Reading Skill is installed and configured, use it flexibly as the preferred research source for book metadata, popular highlights, and public reviews during book discovery and script preparation. Treat its results as research signals, not copy to reproduce. Public sources and user-provided material remain valid supplements or fallbacks when the Skill has no useful result.

## Book Metadata

Use `display_title` for folder names, visible labels, and scripts. Keep the exact source result in `source_title`; never overwrite it during normalization. Keep `source_book_id` and `source_channel` for provenance. Ambiguous editions, guides, summaries, or author mismatches require review.

## Production Gates

1. After book selection, create a provisional `script.csv` and run `node scripts/validate-script.mjs "<book>"` before showing any draft to the user. If it fails, shorten and revise internally, then validate again; never send an over-limit draft for approval. Only after it passes, send one active script for approval. The response must include the complete copy-ready voiceover in one Markdown fenced code block. The first line must be the display title in the form `《书名》`, followed immediately by every line to be read aloud. Do not put CSV headers, order numbers, author labels, timing data, or explanations inside the block. A `script.csv` attachment or file path is supplementary and must never be the only presentation; the whole block must be directly copyable into Jianying for audio generation.
The copy-ready script should target 18-20 total lines including the title. Hard limits are 22 total lines including the title, at most 21 body rows in `script.csv`, and about 220 Chinese characters in the body. This gate belongs to the drafting stage; audio timing and final rendering checks are secondary safeguards, not the first validation point.
2. Only after script approval, generate prompts and 2-3 AI atmosphere images plus the result bridge.
3. When body voiceover is supplied, process it with the `story` preset, use ASR only for timing, and keep `script.csv` as subtitle truth.
4. Mix the shared intro, gear SFX, and a user-selected or randomly chosen BGM. Render the final video only after the relevant media is present.
5. Replace old episode media only after the new output passes technical checks. Keep one active script, prompt set, image set, audio set, and render.
6. After a final render or preview succeeds, embed the actual local media in the same reply with an absolute-path Markdown media reference, for example `![最终视频](/absolute/path/to/final.mp4)`. Never provide only a filesystem path and ask the user to locate or open the file. Include the path and brief technical metadata below the preview as supplementary text.

The intro book list is a fixed six-book template list stored in `templates/shared-video-template/intro/default-book-list.json`. It is independent of `book-pipeline.example.csv`, and the target book may appear in the rolling list before the final reveal. Placeholder labels such as `书名一` or `作者一` are forbidden.

If the user explicitly requests fully automatic production, the script approval gate may be skipped for that episode only.

### Fully Automatic Agent Loop

When the user explicitly requests fully automatic production, run `node scripts/auto-produce.mjs` and parse the emitted JSON action. This mode overrides the ordinary human approval gates, including script approval, for that episode only; do not ask for approval between its stages. It does not change the approval rules for later episodes or ordinary production.

For each `action_required` response, execute exactly one emitted action and produce exactly its `expectedOutputs`. For `run_command`, execute the structured `inputs.executable` with `inputs.args` as separate arguments; never reconstruct a shell command from them. After the output exists, run `node scripts/record-production-stage.mjs "<book>" "<stage>" success`, then run `node scripts/auto-produce.mjs resume "<book>"`. Continue until the response status is `complete` or the configured retry limit is exhausted. On an action failure, record it with `record-production-stage.mjs <book> <stage> failure <message>` before deciding whether to retry.

Use WeChat Reading for research when it is configured and public research otherwise. For `generate_images`, use Codex's built-in bitmap image generation. For `generate_jianying_voiceover`, Codex must use Computer Use to operate Jianying; Node.js only emits the action and must never attempt to invoke Computer Use or control Jianying directly. Build the pasted text with `buildVoiceoverText()` from the active `brief.json` and `script.csv`; never retype, edit, or paraphrase it.

Before starting the Jianying export, record the task start time. Accept only an MP3 created after that time, at least 1 KB, and with a positive duration reported by `ffprobe`. Store the selected voice in local `.book-video-config.json`. Reuse it on later runs; if it is absent, choose a natural, restrained Mandarin narrative voice once and update the config.

Before any fully automatic `book`, `auto`, or `batch` start, validate the complete `.book-video-config.json` schema and require a real successful `jianyingCapability` probe for Unicode text commit and export. Never fabricate this status. The current environment remains blocked until that real smoke test passes; repository checks alone are not evidence of a delivered MP4.

If UI operation fails, save a screenshot under `episodes/<book>/ui-failures/`, record the stage failure through `failStage()` (via `record-production-stage.mjs ... failure`), and retry no more than the configured limit. For `verify_and_report`, inspect representative extracted frames for blank frames, placeholder text, and subtitle overflow. Write explicit boolean results to `production-report.json.visualChecks.blankFrames`, `.placeholderText`, and `.subtitleOverflow` before recording `verified` success; all three must be `true`, and any `false` blocks completion.

In batch mode, a terminal failure for one book must not stop the remaining books. Continue with the next book and include every success and failure in the final batch summary.

Resume a batch with the emitted structured `batch --resume <batch-id>` arguments; never create a replacement batch. The atomic batch state is authoritative for order, position, results, timestamps, failed stage, and resume recommendation. A failure becomes terminal when persisted attempts reach that stage's configured limit. External research, bitmap generation, Jianying UI work, and visual inspection remain Codex actions, not standalone Node.js capabilities.

Artifact gates parse `brief.json` and `prompts.csv`, decode the four required named images, probe the attempt-new MP3, and require exactly one non-empty probed MP4 with a video stream. The report must state subtitle and image counts plus intro voice, body voice, BGM, and gear SFX results.

## Visual And Audio Rules

- Use the shared template in `templates/shared-video-template/` as the only visual baseline.
- Keep the glass-shard intro, rolling list, stable title/author, atmosphere-first body, slow push-in, crossfade, and white text with black shadow.
- Meaningful visuals must be AI-generated bitmaps. Do not use SVG as the main visual.
- Do not use card UI, visible watermarks, copied frames, book-cover mockups, or literal image prompts that weaken atmosphere.
- Body subtitles must be generated from `script.csv` plus `body-timings.json`; incomplete caption timing is a render-blocking error. Long Chinese lines must wrap within the 720px frame and remain visible.
- Keep each script row as one complete spoken unit for ASR alignment. The renderer first breaks at commas, periods, question marks, and similar punctuation; each clause stays within roughly 12 Chinese characters. If one clause is longer, it is balanced across multiple visual lines without changing the source text.
- Keep videos under 60 seconds unless the user explicitly changes the limit.
- Music, SFX, and voiceover assets may be committed only when the user has the right to redistribute them. The four default BGM files under `assets/bgm/` are tracked with project-maintainer redistribution authorization recorded in `templates/shared-video-template/ASSET_PROVENANCE.csv`; do not add new media without the same confirmation.

## Script Rules

Read `docs/book-video-playbook.md` before drafting. The first line must immediately create resonance. Use short, natural lines and concrete scenes. Let the book support the viewer's emotion instead of becoming an academic summary. Avoid “你是不是”, “不是……而是……” formulas, mechanical parallelism, arrogant instruction, and CTA language. End with emotional aftertaste.

When WeChat Reading is available, consult its book details, popular highlights, and public reviews before drafting so the script has concrete material and a reliable emotional entry point. Use the Skill to inform the writing, not to copy long excerpts or replace independent judgment.

## Dependencies And Licensing

Project-owned code, documentation, and reusable templates are Apache-2.0. Copyright (c) 2026 prototech, endless, and 未济. HyperFrames and WeChat Reading are external dependencies. GSAP is an external runtime under Webflow's separate Standard No-Charge License. FFmpeg, fonts, image-generation services, models, BGM, and other user media keep their own terms.

## Validation

Before publication, run `npm run check`; if HyperFrames is not cached, retry through the execution tool's network-capable escalation, then scan reachable Git history for secrets and private media, verify no full reference transcript remains, and confirm a clean clone initializes with and without WeChat Reading.

## Delivery

Every rendered video must be shown directly in the conversation using an absolute local-path Markdown media reference. This applies to final videos and silent visual previews; a path-only response is incomplete.
