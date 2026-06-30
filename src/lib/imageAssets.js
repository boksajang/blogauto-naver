const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function codexSessionsRoot() {
  const codexHome = String(process.env.CODEX_HOME || "").trim()
    || path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
  return path.join(codexHome, "sessions");
}

function safeTopicName(topic) {
  return String(topic || "blog")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

function listImageFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const stat = fs.statSync(dir);
  if (stat.isFile()) return isImageFile(dir) ? [dir] : [];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile() && isImageFile(filePath);
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

function listRecentSessionFiles(root, limit = 100) {
  if (!root || !fs.existsSync(root)) return [];
  const stack = [root];
  const files = [];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const stat = fs.statSync(fullPath);
        files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((file) => file.path);
}

function normalizePathForSearch(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function tryParseJsonLine(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function sessionCwdFromRaw(raw) {
  for (const line of String(raw || "").split(/\r?\n/).slice(0, 40)) {
    const parsed = tryParseJsonLine(line);
    if (!parsed) continue;
    const cwd = parsed?.payload?.cwd;
    if (typeof cwd === "string" && cwd.trim()) return cwd;
  }
  return "";
}

function sessionMatchesJob(raw, jobDir, resultPath) {
  const normalizedJobDir = normalizePathForSearch(jobDir);
  const normalizedResultPath = normalizePathForSearch(resultPath);
  const sessionCwd = sessionCwdFromRaw(raw);
  if (sessionCwd) {
    return normalizePathForSearch(sessionCwd) === normalizedJobDir;
  }
  const searchable = normalizePathForSearch(raw);
  return searchable.includes(normalizedResultPath) || searchable.includes(normalizedJobDir);
}

function resolveImageSource(jobDir, rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(jobDir, value);
}

function copyIfExists(source, target) {
  if (!source || !fs.existsSync(source)) return "";
  const sourceStat = fs.statSync(source);
  if (sourceStat.isDirectory()) {
    const [firstImage] = listImageFiles(source);
    if (!firstImage) return "";
    return copyIfExists(firstImage, target);
  }
  if (!sourceStat.isFile() || !isImageFile(source)) return "";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

function copyImageOrWarn(source, target, warnings, label) {
  try {
    const copied = copyIfExists(source, target);
    if (!copied) {
      warnings.push(`${label} 파일을 찾거나 복사하지 못했습니다: ${source}`);
    }
    return copied;
  } catch (error) {
    warnings.push(`${label} 복사 실패: ${source} (${error.message})`);
    return "";
  }
}

function imageExtensionFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return ".png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (
    buffer.slice(0, 4).toString("ascii") === "RIFF"
    && buffer.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  return "";
}

function decodeImageResultPayload(value) {
  let raw = String(value || "").trim();
  if (!raw) return null;
  const dataUrl = raw.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (dataUrl) {
    raw = dataUrl[2].trim();
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw) || raw.length < 200) return null;
  try {
    const buffer = Buffer.from(raw.replace(/\s+/g, ""), "base64");
    const extension = imageExtensionFromBuffer(buffer);
    if (!extension) return null;
    return { buffer, extension };
  } catch {
    return null;
  }
}

function extractCodexImageResults(parsed) {
  const payload = parsed?.payload || parsed || {};
  const candidates = [];
  if (payload?.type === "image_generation_end" || payload?.type === "image_generation_call") {
    candidates.push({
      id: String(payload.call_id || payload.id || ""),
      result: payload.result
    });
  }
  if (parsed?.type === "response_item" && payload?.type === "image_generation_call") {
    candidates.push({
      id: String(payload.call_id || payload.id || ""),
      result: payload.result
    });
  }
  return candidates
    .map((candidate) => ({
      id: candidate.id,
      image: decodeImageResultPayload(candidate.result)
    }))
    .filter((candidate) => candidate.image);
}

function imageRecoveryStartMs(jobDir) {
  const preferred = [
    path.join(jobDir, "image-worker-prompt.txt"),
    path.join(jobDir, "prompt.txt")
  ];
  for (const filePath of preferred) {
    try {
      if (fs.existsSync(filePath)) return fs.statSync(filePath).mtimeMs;
    } catch {
      // Try the next candidate.
    }
  }
  try {
    return fs.statSync(jobDir).mtimeMs;
  } catch {
    return Date.now();
  }
}

function recoverCodexSessionImages(jobDir, limit = 5) {
  const startedAt = imageRecoveryStartMs(jobDir);
  const earliest = startedAt - 2 * 60 * 1000;
  const resultPath = path.join(jobDir, "image-worker-result.json");
  const outputDir = path.join(jobDir, "recovered-images");
  const recovered = [];
  const seen = new Set();

  for (const sessionFile of listRecentSessionFiles(codexSessionsRoot(), 120)) {
    if (recovered.length >= limit) break;
    let stat = null;
    try {
      stat = fs.statSync(sessionFile);
    } catch {
      continue;
    }
    if (stat.mtimeMs < earliest) continue;

    let raw = "";
    try {
      raw = fs.readFileSync(sessionFile, "utf8").replace(/^\uFEFF/, "");
    } catch {
      continue;
    }
    if (!sessionMatchesJob(raw, jobDir, resultPath)) {
      continue;
    }

    for (const line of raw.split(/\r?\n/)) {
      if (recovered.length >= limit) break;
      if (!/image_generation_(end|call)/i.test(line)) continue;
      const parsed = tryParseJsonLine(line);
      if (!parsed) continue;
      for (const item of extractCodexImageResults(parsed)) {
        if (recovered.length >= limit) break;
        const key = item.id || `${item.image.extension}:${item.image.buffer.length}:${item.image.buffer.slice(0, 24).toString("base64")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fs.mkdirSync(outputDir, { recursive: true });
        const target = path.join(outputDir, `codex-image-${recovered.length + 1}${item.image.extension}`);
        fs.writeFileSync(target, item.image.buffer);
        recovered.push(target);
      }
    }
  }

  return recovered;
}

function findRecentCodexImages(jobDir, limit = 5) {
  const sessionRecovered = recoverCodexSessionImages(jobDir, limit);
  if (sessionRecovered.length >= limit) {
    return sessionRecovered.slice(0, limit);
  }
  let recentFiles = [];
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const root = path.join(home, ".codex", "generated_images");
    if (!fs.existsSync(root)) return sessionRecovered.slice(0, limit);

    const promptPath = path.join(jobDir, "prompt.txt");
    const jobStartedAt = fs.existsSync(promptPath)
      ? fs.statSync(promptPath).mtimeMs
      : fs.statSync(jobDir).mtimeMs;
    const earliest = jobStartedAt - 60 * 1000;
    const latest = Date.now() + 60 * 1000;

    recentFiles = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .map((dir) => {
        try {
          const stat = fs.statSync(dir);
          return { dir, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((entry) => entry.mtimeMs >= earliest && entry.mtimeMs <= latest)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .flatMap((entry) => listImageFiles(entry.dir))
      .map((filePath) => {
        try {
          const stat = fs.statSync(filePath);
          return { filePath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((entry) => entry.mtimeMs >= earliest && entry.mtimeMs <= latest)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .map((entry) => entry.filePath)
      .slice(0, Math.max(0, limit - sessionRecovered.length));
  } catch {
    return sessionRecovered;
  }
  return [...sessionRecovered, ...recentFiles].slice(0, limit);
}

function insertMissingImageMarkers(article, images) {
  const cleanArticle = String(article || "");
  if (!images.length || /\[IMAGE INSERT\s*-\s*\d+\]/i.test(cleanArticle)) {
    return cleanArticle;
  }
  const markerLines = images.map((item) => `[IMAGE INSERT - ${item.sequence}]`).join("\n\n");
  const firstBreak = cleanArticle.indexOf("\n\n");
  if (firstBreak === -1) {
    return `${cleanArticle}\n\n${markerLines}`;
  }
  return `${cleanArticle.slice(0, firstBreak)}\n\n${markerLines}\n\n${cleanArticle.slice(firstBreak + 2)}`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeCurrentDateMentions(value, currentDateLabel) {
  let text = String(value || "");
  const patterns = [
    /현재\s*날짜\s*기준(?:으로)?/g,
    /오늘\s*날짜\s*기준(?:으로)?/g,
    /작성\s*일자?\s*기준(?:으로)?/g,
    /작성\s*시점\s*기준(?:으로)?/g,
    /현재\s*\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일\s*기준(?:으로)?/g,
    /\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일\s*기준(?:으로)?/g
  ];
  if (currentDateLabel) {
    const escaped = escapeRegExp(currentDateLabel).replace(/\\ /g, "\\s*");
    patterns.push(new RegExp(`${escaped}\\s*기준(?:으로)?`, "g"));
    patterns.push(new RegExp(escaped, "g"));
  }
  for (const pattern of patterns) {
    text = text.replace(pattern, "");
  }
  return text
    .replace(/[^\S\r\n]{2,}/g, " ")
    .replace(/[^\S\r\n]+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function imageStorageFailureNoteScope(note) {
  const text = String(note || "");
  const isImageNote = /이미지|image|bodyImages|titleImagePath|generated_images/i.test(text);
  const isFailureNote = /(복사|저장|실패|오류|권한|쓰기 가능 루트 밖|EPERM|operation not permitted|unavailable|비워|empty|찾을 수 없|제공하지 못|생성 원본 이미지 경로)/i.test(text);
  if (!isImageNote || !isFailureNote) return "";

  const titleScoped = /titleImagePath|타이틀|제목|title image/i.test(text);
  const bodyScoped = /bodyImages|본문|body image/i.test(text);
  if (titleScoped && !bodyScoped) return "title";
  if (bodyScoped && !titleScoped) return "body";
  return "any";
}

function shouldKeepImageStorageFailureNote(note, titleImagePath, bodyImages) {
  const scope = imageStorageFailureNoteScope(note);
  if (!scope) return true;
  const hasTitleImage = Boolean(titleImagePath);
  const hasBodyImage = Array.isArray(bodyImages) && bodyImages.length > 0;
  if (scope === "title") return !hasTitleImage;
  if (scope === "body") return !hasBodyImage;
  return !(hasTitleImage || hasBodyImage);
}

function normalizeAgentResult({
  runtimeRoot,
  jobDir,
  topic,
  result,
  includeTitleImage = true,
  maxBodyImages = 2,
  currentDateLabel = ""
}) {
  const title = removeCurrentDateMentions(String(result.title || "").trim(), currentDateLabel);
  let article = removeCurrentDateMentions(String(result.article || "").trim(), currentDateLabel);
  const bodyImageLimit = Math.min(10, Math.max(0, Number.isFinite(Number(maxBodyImages)) ? Number(maxBodyImages) : 2));
  if (!title) {
    throw new Error("Codex 결과에 제목이 없습니다.");
  }
  if (!article) {
    throw new Error("Codex 결과에 본문이 없습니다.");
  }

  const imageRoot = path.join(runtimeRoot, "image");
  const safeTopic = safeTopicName(topic);
  const bodyImages = [];
  const imageWarnings = [];
  const resultNotes = Array.isArray(result.notes) ? result.notes : [];
  const imagesRequested = includeTitleImage || bodyImageLimit > 0;

  if (bodyImageLimit === 0) {
    article = article.replace(/\n?\[IMAGE INSERT\s*-\s*\d+\]\n?/gi, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  for (const item of bodyImageLimit > 0 && Array.isArray(result.bodyImages) ? result.bodyImages.slice(0, bodyImageLimit) : []) {
    const sequence = Number(item.sequence || bodyImages.length + 1);
    const source = resolveImageSource(jobDir, item.path);
    const target = path.join(imageRoot, `${safeTopic}_img_${sequence}.png`);
    const copied = copyImageOrWarn(source, target, imageWarnings, `본문 이미지 ${sequence}`);
    if (copied) {
      bodyImages.push({
        sequence,
        path: copied,
        prompt: String(item.prompt || "")
      });
    }
  }

  let titleImagePath = "";
  if (includeTitleImage && result.titleImagePath) {
    const source = resolveImageSource(jobDir, result.titleImagePath);
    titleImagePath = copyImageOrWarn(source, path.join(imageRoot, `${safeTopic}_img_title.png`), imageWarnings, "타이틀 이미지");
  }

  const shouldRecoverGeneratedImages = imagesRequested
    && bodyImages.length === 0
    && !titleImagePath;
  if (shouldRecoverGeneratedImages) {
    const recovered = findRecentCodexImages(jobDir, bodyImageLimit + (includeTitleImage ? 1 : 0));
    if (recovered.length) {
      const bodySources = includeTitleImage ? recovered.slice(1) : recovered;
      if (includeTitleImage) {
        titleImagePath = copyImageOrWarn(recovered[0], path.join(imageRoot, `${safeTopic}_img_title.png`), imageWarnings, "타이틀 이미지 복구");
      }
      for (const [index, source] of bodySources.slice(0, bodyImageLimit).entries()) {
        const sequence = index + 1;
        const copied = copyImageOrWarn(source, path.join(imageRoot, `${safeTopic}_img_${sequence}.png`), imageWarnings, `본문 이미지 ${sequence} 복구`);
        if (copied) {
          bodyImages.push({
            sequence,
            path: copied,
            prompt: "Codex generated image recovered from local generated_images cache."
          });
        }
      }
      article = insertMissingImageMarkers(article, bodyImages);
      imageWarnings.push(`Codex 이미지 결과 ${recovered.length}개를 파일로 저장했습니다.`);
    }
  }

  if (imagesRequested && bodyImages.length === 0 && !titleImagePath) {
    imageWarnings.push("생성된 이미지 파일이 없습니다.");
  }

  return {
    title,
    article,
    tags: Array.isArray(result.tags) ? result.tags : [],
    bodyImages,
    titleImagePath,
    notes: [
      ...resultNotes.filter((note) => {
        if (!imagesRequested && /이미지|image/i.test(String(note || ""))) {
          return false;
        }
        return shouldKeepImageStorageFailureNote(note, titleImagePath, bodyImages);
      }),
      ...imageWarnings
    ],
    imageWarnings
  };
}

function getPreviewImages(agentResult) {
  const images = [];
  if (agentResult.titleImagePath) {
    images.push({
      role: "title",
      sequence: "title",
      path: agentResult.titleImagePath,
      url: pathToFileURL(agentResult.titleImagePath).toString()
    });
  }
  for (const item of agentResult.bodyImages) {
    images.push({
      role: "body",
      sequence: item.sequence,
      path: item.path,
      url: pathToFileURL(item.path).toString()
    });
  }
  return images;
}

module.exports = {
  normalizeAgentResult,
  getPreviewImages
};
