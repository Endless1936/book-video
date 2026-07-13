import fs from "node:fs";
import path from "node:path";
import { slugifyEpisodeName } from "./lib/episode-slug.mjs";

const ROOT = process.cwd();
const [episodeName, version = "A_reference_like"] = process.argv.slice(2);

if (!episodeName) {
  console.error("Usage: node scripts/create-episode-preview.mjs <episode-name> [script-version]");
  process.exit(1);
}

const episodeDir = path.join(ROOT, "episodes", episodeName);
const briefPath = path.join(episodeDir, "brief.json");
const scriptPath = path.join(episodeDir, "script.csv");
const imagesDir = path.join(episodeDir, "images");
const audioTimingsPath = path.join(episodeDir, "audio", "body-timings.json");

const workSlug = slugifyEpisodeName(episodeName);
const workDir = path.join(ROOT, "tmp", `preview-${workSlug}`);
const introDir = path.join(workDir, "intro");
const bodyDir = path.join(workDir, "body");

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8").trim();
  const lines = text.split(/\r?\n/);
  const headers = parseCsvLine(lines.shift());
  return lines.map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

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

function getIntroBooks(brief) {
  const fallback = [
    ["书名一", "作者一"],
    ["书名二", "作者二"],
    ["书名三", "作者三"],
    ["书名四", "作者四"],
    ["书名五", "作者五"],
    ["书名六", "作者六"],
  ];
  const books = Array.isArray(brief.introBooks) ? brief.introBooks : fallback;
  return Array.from({ length: 6 }, (_, index) => {
    const book = books[index] || fallback[index];
    return {
      title: book.title || `书名${index + 1}`,
      author: book.author || `作者${index + 1}`,
    };
  });
}

function createIntro(brief) {
  const displayTitle = getDisplayTitle(brief);
  const titleLayout = getTitleLayout(displayTitle);
  const introBooks = getIntroBooks(brief);
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
  if (!fs.existsSync(audioTimingsPath)) return null;
  const raw = JSON.parse(fs.readFileSync(audioTimingsPath, "utf8"));
  if (raw.scriptVersion && raw.scriptVersion !== version) {
    console.warn(`Ignoring body timings for ${raw.scriptVersion}; current script version is ${version}`);
    return null;
  }
  const byOrder = new Map((raw.captions || []).map((item) => [Number(item.order), item]));
  return {
    duration: Number(raw.duration),
    byOrder,
  };
}

function createBody(brief, rows, audioTimings) {
  const displayTitle = getDisplayTitle(brief);
  const titleLayout = getTitleLayout(displayTitle);
  fs.mkdirSync(path.join(bodyDir, "media"), { recursive: true });
  copyFile(path.join(imagesDir, "result-bridge.png"), path.join(bodyDir, "media", "00-result-bridge.png"));
  copyFile(path.join(imagesDir, "atmosphere-1.png"), path.join(bodyDir, "media", "01-atmosphere.png"));
  copyFile(path.join(imagesDir, "atmosphere-2.png"), path.join(bodyDir, "media", "02-atmosphere.png"));
  copyFile(path.join(imagesDir, "atmosphere-3.png"), path.join(bodyDir, "media", "03-atmosphere.png"));

  let cursor = 0.72;
  const timings = rows.map((row) => {
    const order = Number(row.order);
    const audioTiming = audioTimings?.byOrder.get(order);
    if (audioTiming) {
      const start = Math.max(0, Number(audioTiming.start));
      const end = Math.max(start + 0.8, Number(audioTiming.end));
      return { selector: `.c${row.order}`, start: Number(start.toFixed(2)), hold: Number((end - start).toFixed(2)) };
    }
    const duration = Number(row.duration_hint || 2);
    const item = { selector: `.c${row.order}`, start: Number(cursor.toFixed(2)), hold: Math.max(1.05, Number((duration - 0.42).toFixed(2))) };
    cursor += duration;
    return item;
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
      return `      <div class="caption c${row.order}${small}"><span>${esc(row.text)}</span></div>`;
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
      .caption span { display: block; white-space: nowrap; }
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
        tl.fromTo(selector, { opacity: 0, y: 18, scaleX: 0.86, scaleY: 0.985 }, { opacity: 1, y: 0, scaleX: 1, scaleY: 1, duration: 0.34, ease: "power4.out" }, start);
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
const rows = readCsv(scriptPath)
  .filter((row) => row.version === version)
  .sort((a, b) => Number(a.order) - Number(b.order));

if (!rows.length) {
  console.error(`No script rows found for version ${version}`);
  process.exit(1);
}

createIntro(brief);
createBody(brief, rows, readOptionalBodyTimings(version));

console.log(workDir);
