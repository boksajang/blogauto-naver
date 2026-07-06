const fs = require("node:fs");
const path = require("node:path");

const LEGACY_NAVER_SEARCH_URL = "https://search.naver.com/search.naver?where=web&query={query}";
const DEFAULT_NAVER_SEARCH_URL = "https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query={query}";
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_ASPECT_RATIOS = new Set([DEFAULT_IMAGE_ASPECT_RATIO, "9:16", "1:1"]);

const DEFAULT_SETTINGS = {
  naverId: "",
  blogId: "",
  naverPassword: "",
  topic: "",
  keyword: "",
  category: "",
  codexCmdPath: "codex.cmd",
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
  maxBodyImages: 2,
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
  if (!normalized.naverSearchUrl || normalized.naverSearchUrl === LEGACY_NAVER_SEARCH_URL) {
    normalized.naverSearchUrl = DEFAULT_NAVER_SEARCH_URL;
  }
  normalized.imageAspectRatio = normalizeImageAspectRatio(normalized.imageAspectRatio);
  normalized.titleImageAspectRatio = normalizeImageAspectRatio(normalized.titleImageAspectRatio || normalized.imageAspectRatio);
  normalized.bodyImageAspectRatio = normalizeImageAspectRatio(normalized.bodyImageAspectRatio || normalized.imageAspectRatio);
  return normalized;
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
    return normalizeSettings(merged);
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
  ensureSettingsFile,
  normalizeImageAspectRatio,
  readSettings,
  writeSettings,
  getSettingsPath
};
