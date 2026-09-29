import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildEstimatedCaptionTimings } from "./lib/body-timings.mjs";
import { readCsv } from "./lib/csv.mjs";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";
import { resolvePreviewBodyTimings } from "./lib/preview-body-timings.mjs";
import { resolveScriptVersion } from "./lib/script-version.mjs";
import { validateBodyScript } from "./lib/script-policy.mjs";
import { assertRenderTimingPreflight } from "./lib/workflow-state.mjs";
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
assertRenderTimingPreflight(episodeDir);
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

// Split caption rows into visual scenes of 3-5 rows each.
// Cuts prefer natural pauses (big gap between consecutive rows) and balanced durations.
function segmentCaptionRows(rows, minSize = 3, maxSize = 5) {
  const n = rows.length;
  if (n <= maxSize) return [{ start: rows[0].start, end: rows[n - 1].end, rows }];
  const dp = Array.from({ length: n + 1 }, () => ({ cost: Infinity, prev: -1 }));
  dp[0] = { cost: 0, prev: -1 };
  const totalDur = Math.max(0.1, rows[n - 1].end - rows[0].start);
  const ideal = totalDur / Math.max(1, Math.ceil(n / maxSize));
  for (let i = minSize; i <= n; i++) {
    for (let s = minSize; s <= maxSize; s++) {
      const j = i - s;
      if (j < 0 || !Number.isFinite(dp[j].cost)) continue;
      const segDur = rows[i - 1].end - rows[j].start;
      const gap = j === 0 ? 0 : rows[j].start - rows[j - 1].end;
      const cost = dp[j].cost + Math.pow(segDur - ideal, 2) * 0.05 - gap * 1.5;
      if (cost < dp[i].cost) dp[i] = { cost, prev: j };
    }
  }
  const segs = [];
  let i = n;
  while (i > 0) {
    const j = dp[i].prev;
    if (j < 0) break;
    segs.unshift({ start: rows[j].start, end: rows[i - 1].end, rows: rows.slice(j, i) });
    i = j;
  }
  return segs;
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
  fs.mkdirSync(path.join(introDir, "fonts"), { recursive: true });
  copyFile(
    path.join(ROOT, "templates", "shared-video-template", "body", "fonts", "SmileySans-Oblique.ttf"),
    path.join(introDir, "fonts", "SmileySans-Oblique.ttf"),
  );
  copyFile(
    path.join(ROOT, "templates", "shared-video-template", "body", "fonts", "LICENSE.txt"),
    path.join(introDir, "fonts", "LICENSE.txt"),
  );
  copyFile(path.join(imagesDir, "result-bridge.png"), path.join(introDir, "media", "pages", "result.png"));
}

function readOptionalBodyTimings(version, rows) {
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
  const resolved = resolvePreviewBodyTimings(raw, {
    version,
    scriptPath,
    voicePath: bodyVoicePath,
    expectedOrders: rows.map((row) => row.order),
    fallbackDuration,
  });
  if (resolved.warning) console.warn(resolved.warning);
  return resolved.timings;
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
  // result-bridge.png is the fixed opening bridge behind the book-title card.
  // Body content scenes use atmosphere-1..N in order (one per DP segment).
  const bridgeImage = path.join(imagesDir, "result-bridge.png");
  const sceneImageSources = [];
  for (let i = 1; fs.existsSync(path.join(imagesDir, `atmosphere-${i}.png`)); i++) {
    sceneImageSources.push(path.join(imagesDir, `atmosphere-${i}.png`));
  }
  if (fs.existsSync(bridgeImage)) {
    copyFile(bridgeImage, path.join(bodyDir, "media", "scene-bridge.jpg"));
  }
  fs.mkdirSync(path.join(bodyDir, "fonts"), { recursive: true });
  copyFile(
    path.join(ROOT, "templates", "shared-video-template", "body", "fonts", "SmileySans-Oblique.ttf"),
    path.join(bodyDir, "fonts", "SmileySans-Oblique.ttf"),
  );
  copyFile(
    path.join(ROOT, "templates", "shared-video-template", "body", "fonts", "LICENSE.txt"),
    path.join(bodyDir, "fonts", "LICENSE.txt"),
  );

  // The book title (order 1) is already shown as the big top title card;
  // do NOT repeat it as a bottom subtitle.
  const captionRows = rows.filter((row) => Number(row.order) !== 1);

  const estimatedByOrder = audioTimings?.duration && audioTimings.byOrder.size === 0
    ? new Map(buildEstimatedCaptionTimings(
      rows,
      [{ start: FALLBACK_CAPTION_START, end: Math.max(FALLBACK_CAPTION_START + 0.3, audioTimings.duration - 0.2) }],
      audioTimings.duration,
      0,
    ).map((item) => [item.order, item]))
    : new Map();
  let cursor = audioTimings?.duration ? FALLBACK_CAPTION_START : 0.72;
  const speechTimings = captionRows.map((row) => {
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
  const segments = segmentCaptionRows(speechTimings, 3, 5);
  if (segments.length !== sceneImageSources.length) {
    throw new Error(`Need ${segments.length} scene images (3-5 rows each) in images/ but found ${sceneImageSources.length}`);
  }
  segments.forEach((seg, i) => copyFile(sceneImageSources[i], path.join(bodyDir, "media", `scene-${i}.jpg`)));
  console.log(`[scenes] ${segments.length} scenes: ` + segments.map((s) => `${s.rows.length}行@${s.start.toFixed(1)}s`).join(" | "));

  const captionHtml = captionRows
    .map((row) => {
      const small = row.text.length >= 9 ? " small" : "";
      return `      <div class="caption c${row.order}${small}"><span>${wrapCaptionText(row.text)}</span></div>`;
    })
    .join("\n");

  const revealJs = timings
    .map((item) => `      revealCaption("${item.selector}", ${item.start}, ${item.hold});`)
    .join("\n");

  const bodyStart = segments[0].start; // bridge covers the book-title moment up to first subtitle
  const sceneCss = [
    `      .sc-bridge .photo { background-image: url("media/scene-bridge.jpg"); }`,
    ...segments.map((_, i) => `      .sc${i} .photo { background-image: url("media/scene-${i}.jpg"); }`),
  ].join("\n");
  const sceneHtml = [
    `<section class="scene sc-bridge" data-layout-ignore><div class="photo" data-layout-ignore></div></section>`,
    ...segments.map((_, i) => `<section class="scene sc${i}" data-layout-ignore><div class="photo" data-layout-ignore></div></section>`),
  ].join("\n      ");
  const sceneTl = [];
  // Bridge is the opening title-card scene; crossfade into body scene0 at first subtitle.
  sceneTl.push(`      tl.fromTo(".sc-bridge .photo", { scale: 1.03, x: 0, y: 0 }, { scale: 1.06, x: 0, y: 0, duration: ${Number((bodyStart + 0.6).toFixed(2))}, ease: "sine.inOut" }, 0);`);
  sceneTl.push(`      tl.fromTo(".sc0", { opacity: 0 }, { opacity: 1, duration: 0.7, ease: "sine.inOut" }, ${bodyStart});`);
  sceneTl.push(`      tl.to(".sc-bridge", { opacity: 0, duration: 0.7, ease: "sine.inOut" }, ${bodyStart});`);
  sceneTl.push(`      tl.fromTo(".sc0 .photo", { scale: 1.035, x: 8, y: -4 }, { scale: 1.105, x: -16, y: 12, duration: ${Number((safeDuration - bodyStart).toFixed(2))}, ease: "sine.inOut" }, ${bodyStart});`);
  for (let i = 1; i < segments.length; i++) {
    const t = segments[i].start;
    const dur = Number((safeDuration - t).toFixed(2));
    const dirX = i % 2 === 0 ? -12 : 14;
    const dirY = i % 2 === 0 ? -8 : 10;
    sceneTl.push(`      tl.fromTo(".sc${i}", { opacity: 0 }, { opacity: 1, duration: 0.7, ease: "sine.inOut" }, ${t});`);
    sceneTl.push(`      tl.to(".sc${i - 1}", { opacity: 0, duration: 0.7, ease: "sine.inOut" }, ${t});`);
    sceneTl.push(`      tl.fromTo(".sc${i} .photo", { scale: 1.035, x: ${-dirX}, y: ${-dirY} }, { scale: 1.1, x: ${dirX}, y: ${dirY}, duration: ${dur}, ease: "sine.inOut" }, ${t});`);
  }
  const sceneTimeline = sceneTl.join("\n");

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=720, height=960" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { box-sizing: border-box; }
      @font-face { font-family: "Smiley Sans"; src: url("fonts/SmileySans-Oblique.ttf") format("truetype"); font-weight: 900; font-display: block; }
      @font-face { font-family: "Noto Sans CJK SC"; src: local("Noto Sans CJK SC"); }
      html, body { width: 720px; height: 960px; margin: 0; overflow: hidden; background: #000; }
      body { font-family: "Smiley Sans", "Noto Sans CJK SC", sans-serif; color: #fff; }
      #root { position: relative; width: 720px; height: 960px; overflow: hidden; background: #000; }
      .scene { position: absolute; inset: 0; opacity: 0; overflow: hidden; }
      .scene:first-of-type { opacity: 1; }
      .photo { position: absolute; inset: -22px; z-index: 1; background-size: cover; background-position: center; background-repeat: no-repeat; transform-origin: 50% 50%; will-change: transform; }
${sceneCss}
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
${sceneHtml}
      <div class="book-mark" data-layout-ignore>
        <span class="book-title">${esc(titleLayout.wrappedTitle)}</span>
        <span class="book-author">${esc(brief.author)} / 著</span>
      </div>
${captionHtml}
    </main>
    <script>
      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
${sceneTimeline}
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
const scriptValidation = validateBodyScript(rows, { episodeTitle: getDisplayTitle(brief) });
if (scriptValidation.errors.length) throw new Error(scriptValidation.errors.join("；"));

createIntro(brief);
createBody(brief, rows, readOptionalBodyTimings(version, rows));

console.log(workDir);
