import fs from "node:fs";
import path from "node:path";

export function resolveVoiceProfile(root, episodeDir = "") {
  const assetsDir = path.join(root, "assets", "template-audio");
  const config = JSON.parse(fs.readFileSync(path.join(assetsDir, "voice-profiles.json"), "utf8"));
  const briefPath = episodeDir ? path.join(episodeDir, "brief.json") : "";
  const brief = briefPath && fs.existsSync(briefPath)
    ? JSON.parse(fs.readFileSync(briefPath, "utf8"))
    : {};
  const profileId = String(brief.voice_profile || config.defaultProfile || "").trim();
  const profile = config.profiles?.[profileId];
  if (!profile) {
    throw new Error('Unknown voice_profile "' + profileId + '". Choose one of: '
      + Object.keys(config.profiles || {}).join(", ") + ".");
  }
  const assetsRoot = path.resolve(assetsDir);
  const introPath = path.resolve(assetsRoot, profile.intro);
  const referencePath = path.resolve(assetsRoot, profile.reference);
  if (!introPath.startsWith(assetsRoot + path.sep)
    || !referencePath.startsWith(assetsRoot + path.sep)) {
    throw new Error('Voice profile "' + profileId + '" points outside assets/template-audio.');
  }
  if (!fs.existsSync(introPath) || !fs.existsSync(referencePath)) {
    throw new Error('Voice profile "' + profileId + '" is missing its intro or reference audio.');
  }
  return { id: profileId, label: String(profile.label || profileId), introPath, referencePath };
}
