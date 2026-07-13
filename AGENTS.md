# Book Video Agent Guide

This repository is an open-source, natural-language workflow for producing short book videos. Keep reusable code, templates, owned assets, and distilled methods in Git. Keep credentials, private book data, downloaded reference videos, generated episode work, and account data local.

## Startup Checklist

For the first user message in this repository, including a simple greeting such as "你好", run the startup checklist before normal task work unless `.book-automation-state.json` already exists and the user is asking an unrelated repository-maintenance question.

1. Resolve the current repository root with `git rev-parse --show-toplevel`; never hard-code a previous clone path. Check Codex capabilities first: the HyperFrames plugin/Skill and built-in bitmap image generation are capabilities, not user-installed project dependencies. Use them directly when available; do not ask the user to install a separate image model or HyperFrames Skill.
2. Check local runtime prerequisites in one pass by running `node scripts/init.mjs` from the resolved repository root. Do not replace this with an ad-hoc `command -v` plus parsed `--version` output: FFmpeg and FFprobe commonly write version banners to stderr, so a blank stdout is not a missing-command signal. Trust the command exit status and the JSON check result. If Node.js 22+, `npx`, FFmpeg/FFprobe, or `whisper-cli` are missing, report the complete list and ask for one confirmation before installing them. After confirmation, the Agent may install them with the available platform package manager; never install or change system packages silently. The repository does not auto-install these through a project script.
3. Check the model at `<repo-root>/assets/models/whisper/ggml-base.bin` using file existence and size, not `ls` output alone; a valid file is at least 100 MB. If missing, ask to download it as part of the confirmed setup, then run `node scripts/download-whisper-model.mjs`. If the download fails, first look for an enabled computer proxy or proxy environment variable; use it for a retry with `--proxy`, asking the user to enable their proxy when none is active. Do not change system network settings silently. If that fails, give the user the browser URL `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin`, then install the user-provided file with `node scripts/download-whisper-model.mjs --from "<local-path>"`.
4. Ensure the official Tencent WeChat Reading Skill is installed and enabled through the agent's skill installer when absent; do not ask whether to enable it and do not vendor its source into this repository.
5. If `WEREAD_API_KEY` is missing, ask only whether the user wants to configure the integration. After confirmation, open [微信读书 Skills 官网](https://weread.qq.com/r/weread-skills) with the browser/computer tool and explicitly tell the user: “请在页面获取 API Key，完成后回到本对话把 Key 发给 Agent。” After the user sends it, store it in local `.env` with mode `0600`; never echo or log the key, and never accept it as a command argument. If the user declines key configuration, continue with public research.
6. Run `scripts/init.mjs` after the dependency and Skill checks. It creates local state and the private pipeline file without asking a second WeChat Reading enablement question.

After a body voiceover is supplied, run `node scripts/create-body-timings.mjs "<book>" <script-version>`. It writes Whisper output under the local episode audio folder and creates `body-timings.json` from speech pauses. The default skips the spoken title/author segment; use `--skip-leading 0` when the audio starts directly with the first script line.

Initialization must be idempotent. It must not reinstall a verified skill, overwrite a valid key, reset user choices, or duplicate CSV columns.

## Book Selection

- If the user names a book, use it after verifying title and author.
- If `data/book-pipeline.csv` is missing, header-only, or has no usable candidates, ask one question covering preferred genre, emotional theme, or audience.
- With a preference, search according to it. Without a preference, search literary/philosophical books with strong emotional resonance for young adults.
- Recommend five candidates and mark one top recommendation. Wait for book selection before drafting.
- Use WeChat Reading highlights, reviews, and book metadata when available. Public sources are supplemental.

## Book Metadata

Use `display_title` for folder names, visible labels, and scripts. Keep the exact source result in `source_title`; never overwrite it during normalization. Keep `source_book_id` and `source_channel` for provenance. Ambiguous editions, guides, summaries, or author mismatches require review.

## Production Gates

1. After book selection, create one active script and send it for approval.
2. Only after script approval, generate prompts and 2-3 AI atmosphere images plus the result bridge.
3. When body voiceover is supplied, process it with the `story` preset, use ASR only for timing, and keep `script.csv` as subtitle truth.
4. Mix the shared intro, gear SFX, and a user-selected or randomly chosen BGM. Render the final video only after the relevant media is present.
5. Replace old episode media only after the new output passes technical checks. Keep one active script, prompt set, image set, audio set, and render.

If the user explicitly requests fully automatic production, the script approval gate may be skipped for that episode only.

## Visual And Audio Rules

- Use the shared template in `templates/shared-video-template/` as the only visual baseline.
- Keep the glass-shard intro, rolling list, stable title/author, atmosphere-first body, slow push-in, crossfade, and white text with black shadow.
- Meaningful visuals must be AI-generated bitmaps. Do not use SVG as the main visual.
- Do not use card UI, visible watermarks, copied frames, book-cover mockups, or literal image prompts that weaken atmosphere.
- Keep videos under 60 seconds unless the user explicitly changes the limit.
- Music, SFX, and voiceover assets may be committed only when the user has the right to redistribute them. The four default BGM files under `assets/bgm/` are tracked with project-maintainer redistribution authorization recorded in `templates/shared-video-template/ASSET_PROVENANCE.csv`; do not add new media without the same confirmation.

## Script Rules

Read `docs/book-video-playbook.md` before drafting. The first line must immediately create resonance. Use short, natural lines and concrete scenes. Let the book support the viewer's emotion instead of becoming an academic summary. Avoid “你是不是”, “不是……而是……” formulas, mechanical parallelism, arrogant instruction, and CTA language. End with emotional aftertaste.

## Dependencies And Licensing

Project-owned code, documentation, and reusable templates are Apache-2.0. Copyright (c) 2026 prototech, endless, and 未济. HyperFrames and WeChat Reading are external dependencies. GSAP is an external runtime under Webflow's separate Standard No-Charge License. FFmpeg, fonts, image-generation services, models, BGM, and other user media keep their own terms.

## Validation

Before publication, run `npm run check`, scan reachable Git history for secrets and private media, verify no full reference transcript remains, and confirm a clean clone initializes with and without WeChat Reading.
