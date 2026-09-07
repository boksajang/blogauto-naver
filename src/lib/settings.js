const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LEGACY_NAVER_SEARCH_URL = "https://search.naver.com/search.naver?where=web&query={query}";
const DEFAULT_NAVER_SEARCH_URL = "https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query={query}";
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_ASPECT_RATIOS = new Set([DEFAULT_IMAGE_ASPECT_RATIO, "9:16", "1:1"]);
const CODEX_MODEL_IDS = new Set([
  "",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex"
]);

const DEFAULT_SETTINGS = {
  blogId: "",
  topic: "",
  keyword: "",
  category: "",
  codexCmdPath: "codex.cmd",
  codexModel: "",
  primarySearchProvider: "naver",
  fallbackSearchProvider: "google",
  naverSearchUrl: DEFAULT_NAVER_SEARCH_URL,
  googleSearchUrl: "https://www.google.com/search?q={query}&num=20&hl=ko",
  naverEditorDomNotes: "",
  publishAfterGenerate: false,
  publishPrivate: true,
  topicMode: "manual",
  repeatTermMinutes: 60,
  publishVisibility: "private",
  publishScheduleMode: "now",
  reserveAfterHours: 3,
  publishToTistoryAfterNaver: false,
  tistoryBlogId: "",
  tistorySessionStatus: "unknown",
  tistorySessionCheckedAt: "",
  includeTitleImage: true,
  imageAspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
  titleImageAspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
  bodyImageAspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
  maxBodyImages: 10,
  breakSentencesInBody: true,
  agentModels: {
    main: "high",
    research: "high",
    writer: "high",
    image: "medium"
  },
  codexRateLimits: null,
  agentHarnessMode: "lean"
};

function getSettingsPath(runtimeRoot) {
  return path.join(runtimeRoot, "user-settings.json");
}

function ensureSettingsFile(runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const settingsPath = getSettingsPath(runtimeRoot);
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, "utf8");
  }
}

function normalizeSettings(settings) {
  const normalized = { ...settings };
  if (!String(normalized.blogId || "").trim() && String(normalized.naverId || "").trim()) {
    normalized.blogId = String(normalized.naverId).trim();
  }
  delete normalized.naverId;
  delete normalized.naverPassword;
  delete normalized.password;
  if (!normalized.naverSearchUrl || normalized.naverSearchUrl === LEGACY_NAVER_SEARCH_URL) {
    normalized.naverSearchUrl = DEFAULT_NAVER_SEARCH_URL;
  }
  normalized.imageAspectRatio = normalizeImageAspectRatio(normalized.imageAspectRatio);
  normalized.titleImageAspectRatio = normalizeImageAspectRatio(normalized.titleImageAspectRatio || normalized.imageAspectRatio);
  normalized.bodyImageAspectRatio = normalizeImageAspectRatio(normalized.bodyImageAspectRatio || normalized.imageAspectRatio);
  normalized.maxBodyImages = normalizeMaxBodyImages(normalized.maxBodyImages);
  normalized.codexModel = normalizeCodexModel(normalized.codexModel);
  return normalized;
}

function normalizeMaxBodyImages(value) {
  if (value === undefined || value === null || String(value).trim() === "") return 10;
  return Number(value) > 0 ? 10 : 0;
}

function isDefaultCodexCmdPath(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "codex" || normalized === "codex.cmd" || normalized === "codex.exe";
}

function findDesktopCodexExecutable() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const codexBinRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  if (!fs.existsSync(codexBinRoot)) return "";

  const candidates = [];
  try {
    for (const entry of fs.readdirSync(codexBinRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(codexBinRoot, entry.name, "codex.exe");
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
  } catch {
    return "";
  }

  const rootCandidate = path.join(codexBinRoot, "codex.exe");
  if (fs.existsSync(rootCandidate)) candidates.push(rootCandidate);

  return candidates
    .map((candidate) => {
      try {
        return { candidate, mtimeMs: fs.statSync(candidate).mtimeMs };
      } catch {
        return { candidate, mtimeMs: 0 };
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.candidate || "";
}

function resolveCodexCmdPath(value) {
  const raw = String(value || "").trim();
  if (!isDefaultCodexCmdPath(raw)) return raw;
  return findDesktopCodexExecutable() || raw || DEFAULT_SETTINGS.codexCmdPath;
}

function normalizeCodexModel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return CODEX_MODEL_IDS.has(normalized) ? normalized : "";
}

function normalizeImageAspectRatio(value) {
  const normalized = String(value || "").trim();
  return IMAGE_ASPECT_RATIOS.has(normalized) ? normalized : DEFAULT_IMAGE_ASPECT_RATIO;
}

function readSettings(runtimeRoot) {
  ensureSettingsFile(runtimeRoot);
  try {
    const raw = fs.readFileSync(getSettingsPath(runtimeRoot), "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      agentModels: {
        ...DEFAULT_SETTINGS.agentModels,
        ...(parsed.agentModels || {})
      }
    };
    if (!Object.prototype.hasOwnProperty.call(parsed, "titleImageAspectRatio")) {
      merged.titleImageAspectRatio = parsed.imageAspectRatio;
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, "bodyImageAspectRatio")) {
      merged.bodyImageAspectRatio = parsed.imageAspectRatio;
    }
    const normalized = normalizeSettings(merged);
    if (
      Object.prototype.hasOwnProperty.call(parsed, "naverId")
      || Object.prototype.hasOwnProperty.call(parsed, "naverPassword")
      || Object.prototype.hasOwnProperty.call(parsed, "password")
    ) {
      try {
        fs.writeFileSync(getSettingsPath(runtimeRoot), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      } catch {
        // A read-only legacy file must not prevent the already sanitized settings from loading.
      }
    }
    return normalized;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(runtimeRoot, nextSettings) {
  ensureSettingsFile(runtimeRoot);
  const current = readSettings(runtimeRoot);
  const merged = {
    ...current,
    ...Object.fromEntries(Object.entries(nextSettings || {}).filter(([, value]) => value !== undefined))
  };
  const normalized = normalizeSettings(merged);
  fs.writeFileSync(getSettingsPath(runtimeRoot), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_NAVER_SEARCH_URL,
  DEFAULT_IMAGE_ASPECT_RATIO,
  normalizeCodexModel,
  resolveCodexCmdPath,
  ensureSettingsFile,
  normalizeImageAspectRatio,
  normalizeMaxBodyImages,
  readSettings,
  writeSettings,
  getSettingsPath
};
