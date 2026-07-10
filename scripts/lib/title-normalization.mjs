const EDITION_SUFFIX = /^(\d{2,4}新版|新版|经典版|纪念版|修订版|完整版|全\d+册|电子书|精装版|平装版|典藏版|译者.*|出版社.*)$/u;

export function normalizeDisplayTitle(sourceTitle, requestedTitle = "") {
  const preferred = String(requestedTitle || "").normalize("NFKC").replace(/[《》]/gu, "").trim();
  const source = String(sourceTitle || "").normalize("NFKC").replace(/[\u0000]/gu, "").replace(/\s+/gu, " ").trim();
  let title = preferred || source;
  title = title.replace(/^《(.+)》$/u, "$1").trim();

  const bracketedWithSuffix = title.match(/^《(.+?)》[（(]([^（）()]*)[）)]$/u);
  if (bracketedWithSuffix && EDITION_SUFFIX.test(bracketedWithSuffix[2].trim())) {
    title = bracketedWithSuffix[1].trim();
  }

  const parenthetical = title.match(/^(.*?)[（(]([^（）()]*)[）)]$/u);
  if (parenthetical && EDITION_SUFFIX.test(parenthetical[2].trim())) title = parenthetical[1].trim();

  const colon = title.match(/^(.+?)[：:](.+)$/u);
  if (colon && /新版|纪念|修订|完整版|电子书|精装|平装|典藏|作品精选|[“”"]/u.test(colon[2])) {
    title = colon[1].trim();
  }

  return title.slice(0, 80) || "待确认书名";
}
