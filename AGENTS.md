# Book Automation Agent Guide

This repository is an open-source, natural-language workflow for producing short book videos. Keep reusable code, templates, owned assets, and distilled methods in Git. Keep credentials, private book data, downloaded reference videos, generated episode work, and account data local.

## First Run

When the user asks to initialize the project:

1. Check Node.js 22+, FFmpeg, HyperFrames availability, and bitmap image-generation capability.
2. Check whether `assets/models/whisper/ggml-base.bin` exists. If missing, run `node scripts/download-whisper-model.mjs` after user approval for network access.
3. Ask once whether to enable WeChat Reading integration.
4. If confirmed, install the official Tencent skill locally or through the agent's skill installer. Do not vendor its source into this repository.
5. Run `scripts/init.mjs`. It creates local state and the private pipeline file. It collects `WEREAD_API_KEY` only through hidden TTY input, writes `.env` with mode `0600`, never logs the key, and never accepts it as a command argument.
6. If WeChat Reading is declined or unavailable, continue with public research or a user-provided title.

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
- Music, SFX, and voiceover assets may be committed only when the user has the right to redistribute them.

## Script Rules

Read `docs/book-video-playbook.md` before drafting. The first line must immediately create resonance. Use short, natural lines and concrete scenes. Let the book support the viewer's emotion instead of becoming an academic summary. Avoid “你是不是”, “不是……而是……” formulas, mechanical parallelism, arrogant instruction, and CTA language. End with emotional aftertaste.

## Dependencies And Licensing

Project-owned files are Apache-2.0. HyperFrames and WeChat Reading are external Apache-2.0 dependencies. GSAP is an external runtime under Webflow's separate Standard No-Charge License. FFmpeg, fonts, image-generation services, models, and user media keep their own terms.

## Validation

Before publication, scan reachable Git history for secrets and private media, verify no full reference transcript remains, run Node syntax checks, and run the shared template lint/validate/inspect checks. A clean clone must initialize with and without WeChat Reading.
