import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildEstimatedCaptionTimings } from "./lib/body-timings.mjs";
import { readCsv } from "./lib/csv.mjs";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import { isFileFingerprintCurrent } from "./lib/media-validation.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { WorkflowError, installWorkflowDiagnostics } from "./lib/workflow-diagnostics.mjs";

const ROOT = process.cwd();
const FALLBACK_CAPTION_START = 1.5;
const [episodeName, requestedVersion] = process.argv.slice(2);

installWorkflowDiagnostics({
  root: ROOT,
  command: "node scripts/create-episode-preview.mjs",
  stage: "preview_generation",
  nextActions: [
    "Inspect brief.json, script.csv, and the required episode images.",
    "Repair the missing or invalid artifact, then rerun preview generation.",
    "Timing warnings may use the duration fallback; missing visual or script inputs must be corrected.",
  ],
});

if (!episodeName) {
  throw new WorkflowError("Usage: node scripts/create-episode-preview.mjs <episode-name> [script-version]", {
    code: "invalid_arguments",
  });
}

const episodeDir = path.join(ROOT, "episodes", episodeName);
const version = resolveScriptVersion(episodeDir, requestedVersion);
const briefPath = path.join(episodeDir, "brief.json");
const scriptPath = path.join(episodeDir, "script.csv");
const imagesDir = path.join(episodeDir, "images");
const audioTimingsPath = path.join(episodeDir, "audio", "body-timings.json");
const bodyVoicePath = path.join(episodeDir, "audio", "body-voiceover.mp3");

const workSlug = slugifyEpisodeName(episodeName);
const workDir = path.join(ROOT, "tmp", `preview-${workSlug}`);
const introDir = path.join(workDir, "intro");
const bodyDir = path.join(workDir, "body");
const defaultIntroBooksPath = path.join(ROOT, "templates", "shared-video-template", "intro", "default-book-list.json");

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getTitleLayout(title) {
  const wrappedTitle = `《${title}》`;
  const fontSize = Math.max(46, Math.min(82, Math.floor(660 / Math.max(1, wrappedTitle.length + 1))));
  const authorTop = fontSize >= 70 ? 166 : 140;
  return { wrappedTitle, fontSize, authorTop };
}

function getDisplayTitle(brief) {
  return brief.display_title || brief.displayTitle || brief.title;
}

function getIntroBooks() {
  if (!fs.existsSync(defaultIntroBooksPath)) {
    throw new Error(`Missing fixed intro book list: ${defaultIntroBooksPath}`);
  }
  const books = JSON.parse(fs.readFileSync(defaultIntroBooksPath, "utf8"));
  if (!Array.isArray(books) || books.length !== 6 || books.some((book) => !book?.title || !book?.author)) {
    throw new Error("Fixed intro book list must contain exactly six real books with authors");
  }
  return books.map((book) => ({ title: String(book.title).trim(), author: String(book.author).trim() }));
}

function wrapCaptionText(text, maxClauseChars = 12) {
  const clauses = [];
  let current = "";
  for (const char of Array.from(String(text || "").trim())) {
    current += char;
    if (/[，。！？；：,.!?;:]/u.test(char)) {
      clauses.push(current);
      current = "";
    }
  }
  if (current) clauses.push(current);

  const lines = clauses.flatMap((clause) => {
    const chars = Array.from(clause);
    if (chars.length <= maxClauseChars) return [clause];
    const chunkCount = Math.ceil(chars.length / maxClauseChars);
    const chunkSize = Math.ceil(chars.length / chunkCount);
    return Array.from({ length: chunkCount }, (_, index) =>
      chars.slice(index * chunkSize, (index + 1) * chunkSize).join(""),
    );
  });
  return lines.map((line) => esc(line)).join("<br />");
}

function createIntro(brief) {
  const displayTitle = getDisplayTitle(brief);
  const titleLayout = getTitleLayout(displayTitle);
  const introBooks = getIntroBooks();
  fs.mkdirSync(introDir, { recursive: true });
  fs.cpSync(
    path.join(ROOT, "templates", "shared-video-template", "intro", "media"),
    path.join(introDir, "media"),
    { recursive: true },
  );
  copyFile(path.join(ROOT, "templates", "shared-video-template", "intro", "package.json"), path.join(introDir, "package.json"));
  let html = fs.readFileSync(path.join(ROOT, "templates", "shared-video-template", "intro", "index.html"), "utf8");
  html = html
    .replaceAll('<div class="page-title">{{TARGET_TITLE}}</div>', `<div class="page-title" style="font-size: ${titleLayout.fontSize}px;">${esc(titleLayout.wrappedTitle)}</div>`)
    .replaceAll('<div class="page-author">{{TARGET_AUTHOR}}</div>', `<div class="page-author" style="top: ${titleLayout.authorTop}px;">${esc(`${brief.author} / 著`)}</div>`)
    .replaceAll("{{TARGET_TITLE}}", titleLayout.wrappedTitle)
    .replaceAll("{{TARGET_AUTHOR}}", `${brief.author} / 著`);
  introBooks.forEach((book, index) => {
    html = html
      .replaceAll(`{{LIST_TITLE_${index + 1}}}`, `《${book.title}》`)
      .replaceAll(`{{LIST_AUTHOR_${index + 1}}}`, `${book.author} / 著`);
  });
  fs.writeFileSync(path.join(introDir, "index.html"), html);
  copyFile(path.join(imagesDir, "result-bridge.png"), path.join(introDir, "media", "pages", "result.png"));
}

function readOptionalBodyTimings(version) {
  const fallbackDuration = readAudioDuration(bodyVoicePath);
  if (!fs.existsSync(audioTimingsPath)) {
    if (fallbackDuration) console.warn("Missing body-timings.json; using script duration hints for captions");
    return fallbackDuration ? { duration: fallbackDuration, byOrder: new Map() } : null;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(audioTimingsPath, "utf8"));
  } catch (error) {
    console.warn(`Could not read body-timings.json; using script duration hints: ${error.message}`);
    return fallbackDuration ? { duration: fallbackDuration, byOrder: new Map() } : null;
  }
  if (raw.scriptVersion && raw.scriptVersion !== version) {
    console.warn(`Ignoring body timings for ${raw.scriptVersion}; using script duration hints for ${version}`);
    return fallbackDuration ? { duration: fallbackDuration, byOrder: new Map() } : null;
  }
  if (!isFileFingerprintCurrent(bodyVoicePath, raw.audioFingerprint)) {
    console.warn("Ignoring body timings because the voiceover changed or has no fingerprint; using script duration hints");
    return fallbackDuration ? { duration: fallbackDuration, byOrder: new Map() } : null;
  }
  if (raw.alignment?.requiresAgentReview) {
    console.warn(
      `Body timings need Agent review (${raw.alignment.method || "unknown method"}): `
      + `${raw.alignment.reason || "low-confidence ASR alignment"}`,
    );
  }
  const byOrder = new Map((raw.captions || []).map((item) => [Number(item.order), item]));
  return {
    duration: Number(raw.duration) || fallbackDuration,
    byOrder,
  };
}

function readAudioDuration(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { cwd: ROOT, encoding: "utf8", shell: false },
  );
  const duration = Number(result.stdout?.trim());
  return result.status === 0 && Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function createBody(brief, rows, audioTimings) {
  const displayTitle = getDisplayTitle(brief);
  const titleLayout = getTitleLayout(displayTitle);
  fs.mkdirSync(path.join(bodyDir, "media"), { recursive: true });
  copyFile(path.join(imagesDir, "result-bridge.png"), path.join(bodyDir, "media", "00-result-bridge.png"));
  copyFile(path.join(imagesDir, "atmosphere-1.png"), path.join(bodyDir, "media", "01-atmosphere.png"));
  copyFile(path.join(imagesDir, "atmosphere-2.png"), path.join(bodyDir, "media", "02-atmosphere.png"));
  copyFile(path.join(imagesDir, "atmosphere-3.png"), path.join(bodyDir, "media", "03-atmosphere.png"));

  const estimatedByOrder = audioTimings?.duration && audioTimings.byOrder.size === 0
    ? new Map(buildEstimatedCaptionTimings(
      rows,
      [{ start: FALLBACK_CAPTION_START, end: Math.max(FALLBACK_CAPTION_START + 0.3, audioTimings.duration - 0.2) }],
      audioTimings.duration,
      0,
    ).map((item) => [item.order, item]))
    : new Map();
  let cursor = audioTimings?.duration ? FALLBACK_CAPTION_START : 0.72;
  const speechTimings = rows.map((row) => {
    const order = Number(row.order);
    const audioTiming = audioTimings?.byOrder.get(order) || estimatedByOrder.get(order);
    const start = Number(audioTiming?.start);
    const end = Number(audioTiming?.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const safeStart = Math.max(0, start);
      const safeEnd = Math.max(safeStart + 0.3, end);
      cursor = Math.max(cursor, safeEnd + 0.12);
      return { selector: `.c${row.order}`, start: safeStart, end: safeEnd };
    }
    const duration = Number(row.duration_hint || 2);
    const item = { selector: `.c${row.order}`, start: cursor, end: cursor + Math.max(1.05, duration - 0.42) };
    cursor += duration;
    return item;
  });
  const timings = speechTimings.map((item, index) => {
    const start = Math.max(0, item.start - 0.12);
    const nextStart = speechTimings[index + 1]?.start;
    const desiredEnd = item.end + 0.12;
    const nextDisplayStart = Number.isFinite(nextStart) ? Math.max(0, nextStart - 0.12) : null;
    const end = nextDisplayStart === null ? desiredEnd : Math.min(desiredEnd, nextDisplayStart - 0.02);
    return {
      selector: item.selector,
      start: Number(start.toFixed(2)),
      hold: Number(Math.max(0.3, end - start).toFixed(2)),
    };
  });
  const lastCaptionEnd = timings.reduce((max, item) => Math.max(max, item.start + item.hold), 0);
  const duration = audioTimings?.duration
    ? Number(audioTimings.duration.toFixed(2))
    : Number((cursor + 0.8).toFixed(2));
  const safeDuration = Number(Math.max(duration, lastCaptionEnd + 0.4).toFixed(2));
  const sceneTwo = Number((safeDuration * 0.34).toFixed(2));
  const sceneThree = Number((safeDuration * 0.67).toFixed(2));

  const captionHtml = rows
    .map((row) => {
      const small = row.text.length >= 9 ? " small" : "";
      return `      <div class="caption c${row.order}${small}"><span>${wrapCaptionText(row.text)}</span></div>`;
    })
    .join("\n");

  const revealJs = timings
    .map((item) => `      revealCaption("${item.selector}", ${item.start}, ${item.hold});`)
    .join("\n");

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=720, height=960" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { box-sizing: border-box; }
      @font-face { font-family: "DeYiHei"; src: local("DeYiHei"), local("DeYi Hei"), local("德意黑"); }
      @font-face { font-family: "德意黑"; src: local("德意黑"), local("DeYiHei"), local("DeYi Hei"); }
      @font-face { font-family: "STHeiti"; src: local("STHeiti"), local("STHeitiSC-Medium"); }
      @font-face { font-family: "Hiragino Sans GB"; src: local("Hiragino Sans GB"); }
      html, body { width: 720px; height: 960px; margin: 0; overflow: hidden; background: #000; }
      body { font-family: "DeYiHei", "德意黑", "STHeiti", "Hiragino Sans GB", sans-serif; color: #fff; }
      #root { position: relative; width: 720px; height: 960px; overflow: hidden; background: #000; }
      .scene { position: absolute; inset: 0; opacity: 0; overflow: hidden; }
      .scene:first-of-type { opacity: 1; }
      .photo { position: absolute; inset: -22px; z-index: 1; background-size: cover; background-position: center; background-repeat: no-repeat; transform-origin: 50% 50%; will-change: transform; }
      .bridge .photo { inset: 0; background-image: url("media/00-result-bridge.png"); }
      .s1 .photo { background-image: url("media/01-atmosphere.png"); }
      .s2 .photo { background-image: url("media/02-atmosphere.png"); }
      .s3 .photo { background-image: url("media/03-atmosphere.png"); }
      .book-mark { position: absolute; inset: 0; z-index: 8; text-align: center; color: #fff; opacity: 1; transform-origin: 50% 120px; }
      .book-title { position: absolute; left: 28px; right: 28px; top: 70px; display: block; font-size: ${titleLayout.fontSize}px; line-height: 1; font-weight: 900; letter-spacing: 0.04em; white-space: nowrap; text-shadow: 0 7px 18px rgba(0, 0, 0, 0.96); }
      .book-author { position: absolute; left: 36px; right: 36px; top: ${titleLayout.authorTop}px; display: block; font-size: 34px; line-height: 1; font-weight: 900; letter-spacing: 0.06em; white-space: nowrap; text-shadow: 0 5px 14px rgba(0, 0, 0, 0.96); }
      .caption { position: absolute; left: 34px; right: 34px; bottom: 126px; z-index: 9; color: #fff; text-align: center; font-size: 56px; line-height: 1.16; font-weight: 900; letter-spacing: 0; opacity: 0; transform-origin: 50% 55%; will-change: transform, opacity; text-shadow: 0 7px 18px rgba(0, 0, 0, 0.96); }
      .caption span { display: block; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
      .caption.small { font-size: 50px; }
    </style>
  </head>
  <body>
    <main id="root" data-composition-id="main" data-start="0" data-duration="${safeDuration}" data-width="720" data-height="960">
      <section class="scene bridge" data-layout-ignore><div class="photo" data-layout-ignore></div></section>
      <section class="scene s1" data-layout-ignore><div class="photo" data-layout-ignore></div></section>
      <section class="scene s2" data-layout-ignore><div class="photo" data-layout-ignore></div></section>
      <section class="scene s3" data-layout-ignore><div class="photo" data-layout-ignore></div></section>
      <div class="book-mark" data-layout-ignore>
        <span class="book-title">${esc(titleLayout.wrappedTitle)}</span>
        <span class="book-author">${esc(brief.author)} / 著</span>
      </div>
${captionHtml}
    </main>
    <script>
      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
      tl.fromTo(".s1", { opacity: 0 }, { opacity: 1, duration: 0.58, ease: "sine.inOut" }, 0.32);
      tl.to(".bridge", { opacity: 0, duration: 0.58, ease: "sine.inOut" }, 0.32);
      tl.fromTo(".bridge .photo", { scale: 1.035, x: 0, y: 0 }, { scale: 1.045, x: 0, y: 0, duration: 0.9, ease: "sine.inOut" }, 0);
      tl.fromTo(".s1 .photo", { scale: 1.035, x: 8, y: -4 }, { scale: 1.105, x: -16, y: 12, duration: ${sceneTwo + 1.2}, ease: "sine.inOut" }, 0);
      tl.fromTo(".s2", { opacity: 0 }, { opacity: 1, duration: 0.72, ease: "sine.inOut" }, ${sceneTwo});
      tl.to(".s1", { opacity: 0, duration: 0.72, ease: "sine.inOut" }, ${sceneTwo});
      tl.fromTo(".s2 .photo", { scale: 1.035, x: -10, y: 6 }, { scale: 1.095, x: 14, y: -8, duration: ${sceneThree - sceneTwo + 1.2}, ease: "sine.inOut" }, ${sceneTwo});
      tl.fromTo(".s3", { opacity: 0 }, { opacity: 1, duration: 0.76, ease: "sine.inOut" }, ${sceneThree});
      tl.to(".s2", { opacity: 0, duration: 0.76, ease: "sine.inOut" }, ${sceneThree});
      tl.fromTo(".s3 .photo", { scale: 1.035, x: 10, y: 8 }, { scale: 1.1, x: -12, y: -8, duration: ${safeDuration - sceneThree}, ease: "sine.inOut" }, ${sceneThree});
      function revealCaption(selector, start, hold) {
        tl.fromTo(selector, { opacity: 0, y: 12, scaleX: 0.92, scaleY: 0.99 }, { opacity: 1, y: 0, scaleX: 1, scaleY: 1, duration: 0.16, ease: "power3.out" }, start);
        tl.set(selector, { opacity: 0, y: -10 }, start + hold);
      }
${revealJs}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;

  fs.writeFileSync(path.join(bodyDir, "index.html"), html);
  fs.writeFileSync(
    path.join(bodyDir, "package.json"),
    JSON.stringify(
      {
        name: `preview-${workSlug}-body`,
        private: true,
        type: "module",
        scripts: {
          check: "npx --yes hyperframes@0.7.33 lint && npx --yes hyperframes@0.7.33 validate && npx --yes hyperframes@0.7.33 inspect --at 0.8,4,8,12,18,24,30,36,42",
          render: "npx --yes hyperframes@0.7.33 render --quality standard --output renders/body.mp4",
        },
      },
      null,
      2,
    ),
  );
}

cleanDir(workDir);

const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
const rows = readCsv(scriptPath).rows
  .filter((row) => row.version === version)
  .sort((a, b) => Number(a.order) - Number(b.order));

if (!rows.length) {
  throw new Error(`No script rows found for version ${version}`);
}
const scriptValidation = validateBodyScript(rows);
if (scriptValidation.errors.length) throw new Error(scriptValidation.errors.join("；"));

createIntro(brief);
createBody(brief, rows, readOptionalBodyTimings(version));

console.log(workDir);
