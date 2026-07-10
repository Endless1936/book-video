import { createHash } from "node:crypto";

export function slugifyEpisodeName(name) {
  const ascii = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const digest = createHash("sha1").update(name).digest("hex").slice(0, 10);
  return ascii ? `${ascii}-${digest}` : `book-${digest}`;
}
