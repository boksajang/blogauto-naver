const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const DEFAULT_AGENT_MODELS = {
  main: "high",
  research: "high",
  writer: "high",
  image: "medium",
  imageStyle: "medium"
};
const VALID_AGENT_MODEL_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const IMAGE_ASPECT_RATIOS = new Set([DEFAULT_IMAGE_ASPECT_RATIO, "9:16", "1:1"]);
const CODEX_USAGE_LIMIT_TYPES = new Set([
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached"
]);
const AGENT_DISPLAY_NAMES = {
  main: "Main Agent",
  research: "Research/Title Agent",
  writer: "Writer Agent",
  image: "Image Worker",
  imageStyle: "Image Style Agent"
};

function normalizeAgentModels(models = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_AGENT_MODELS).map(([agent, fallback]) => {
    const value = String(models?.[agent] || fallback);
    return [agent, VALID_AGENT_MODEL_EFFORTS.has(value) ? value : fallback];
  }));
}

function modelEffortForAgent(options, agent) {
  return normalizeAgentModels(options.agentModels)[agent] || DEFAULT_AGENT_MODELS[agent] || "high";
}

function normalizeImageAspectRatio(value) {
  const normalized = String(value || "").trim();
  return IMAGE_ASPECT_RATIOS.has(normalized) ? normalized : DEFAULT_IMAGE_ASPECT_RATIO;
}

function agentDisplayName(agent) {
  return AGENT_DISPLAY_NAMES[String(agent || "").toLowerCase()] || "Agent";
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function normalizeRateLimitType(value) {
  return String(value || "")
    .replace(/^["']|["']$/g, "")
    .trim()
    .replace(/[A-Z]/g, (char, index) => `${index ? "_" : ""}${char.toLowerCase()}`)
    .replace(/__+/g, "_")
    .replace(/^rate_limit_reached_type[:=]/i, "")
    .trim()
    .toLowerCase();
}

function createCodexUsageLimitError(rateLimitType = "", detail = "") {
  const normalizedType = normalizeRateLimitType(rateLimitType);
  const isUsageLimit = CODEX_USAGE_LIMIT_TYPES.has(normalizedType) || /usage_limit/i.test(normalizedType);
  const message = isUsageLimit
    ? "Codex 사용량 한도(5시간 또는 주간 한도)에 도달해 작업을 중단합니다. 한도가 초기화된 뒤 다시 실행해 주세요."
    : "Codex 한도에 도달해 작업을 중단합니다. 한도가 초기화되거나 제한이 해제된 뒤 다시 실행해 주세요.";
  const error = new Error(message);
  error.code = "CODEX_USAGE_LIMIT";
  error.codexRateLimitType = normalizedType || "unknown";
  error.codexLimitDetail = String(detail || "").slice(0, 1000);
  return error;
}

function isCodexUsageLimitError(error) {
  return error?.code === "CODEX_USAGE_LIMIT";
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

function collectRateLimitReachedTypes(value, found = [], depth = 0) {
  if (!value || depth > 8) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectRateLimitReachedTypes(item, found, depth + 1);
    return found;
  }
  if (typeof value !== "object") return found;
  for (const [key, nested] of Object.entries(value)) {
    if (["rate_limit_reached_type", "rateLimitReachedType", "x-codex-rate-limit-reached-type"].includes(key)) {
      const type = normalizeRateLimitType(nested);
      if (type && type !== "null" && type !== "undefined") found.push(type);
    }
    collectRateLimitReachedTypes(nested, found, depth + 1);
  }
  return found;
}

function detectCodexUsageLimitSignal(line) {
  const text = stripAnsi(line).trim();
  if (!text) return null;

  const parsed = tryParseJsonLine(text);
  const jsonTypes = parsed ? collectRateLimitReachedTypes(parsed) : [];
  const directMatch = text.match(/\b(workspace_owner_usage_limit_reached|workspace_member_usage_limit_reached)\b/i);
  const type = normalizeRateLimitType(jsonTypes[0] || directMatch?.[1] || "");
  if (CODEX_USAGE_LIMIT_TYPES.has(type)) {
    return { type, detail: text };
  }

  if (/\bUsageLimitExceeded\b/i.test(text)) {
    return { type: "usage_limit_exceeded", detail: text };
  }
  if (/\busage[_ -]?limit\b/i.test(text) && /\b(reached|exceeded|exhausted|hit)\b/i.test(text)) {
    return { type: "usage_limit_message", detail: text };
  }
  return null;
}

function jsonTokenTotal(event) {
  const payload = event?.payload || event || {};
  const candidates = [
    payload?.info?.total_token_usage?.total_tokens,
    payload?.info?.last_token_usage?.total_tokens,
    payload?.info?.total_tokens,
    payload?.total_token_usage?.total_tokens,
    payload?.last_token_usage?.total_tokens,
    payload?.total_tokens,
    event?.info?.total_token_usage?.total_tokens,
    event?.info?.last_token_usage?.total_tokens,
    event?.total_token_usage?.total_tokens
  ];
  for (const candidate of candidates) {
    const total = Number(candidate);
    if (Number.isFinite(total) && total >= 0) return total;
  }
  return null;
}

function normalizeTokenNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function tokenUsageFromInfo(info = {}) {
  const totalUsage = info?.total_token_usage || null;
  const lastUsage = info?.last_token_usage || null;
  const grossTotal = normalizeTokenNumber(totalUsage?.total_tokens);
  const inputTokens = normalizeTokenNumber(totalUsage?.input_tokens);
  const cachedInputTokens = normalizeTokenNumber(totalUsage?.cached_input_tokens);
  const outputTokens = normalizeTokenNumber(totalUsage?.output_tokens);
  const lastTotal = normalizeTokenNumber(lastUsage?.total_tokens);
  const lastInputTokens = normalizeTokenNumber(lastUsage?.input_tokens);
  const lastCachedInputTokens = normalizeTokenNumber(lastUsage?.cached_input_tokens);
  const lastOutputTokens = normalizeTokenNumber(lastUsage?.output_tokens);

  let total = null;
  if (inputTokens !== null || outputTokens !== null) {
    total = Math.max(0, (inputTokens || 0) - (cachedInputTokens || 0)) + (outputTokens || 0);
  } else if (grossTotal !== null) {
    total = grossTotal;
  } else if (lastInputTokens !== null || lastOutputTokens !== null) {
    total = Math.max(0, (lastInputTokens || 0) - (lastCachedInputTokens || 0)) + (lastOutputTokens || 0);
  } else if (lastTotal !== null) {
    total = lastTotal;
  }

  if (total === null && grossTotal === null && lastTotal === null) return null;
  return {
    total: total || 0,
    grossTotal: grossTotal ?? lastTotal ?? total ?? 0,
    inputTokens: inputTokens || 0,
    cachedInputTokens: cachedInputTokens || 0,
    outputTokens: outputTokens || 0,
    lastTotal: lastTotal || 0,
    lastInputTokens: lastInputTokens || 0,
    lastCachedInputTokens: lastCachedInputTokens || 0,
    lastOutputTokens: lastOutputTokens || 0
  };
}

function jsonTokenUsage(event) {
  const payload = event?.payload || event || {};
  const candidates = [
    payload?.info,
    payload,
    event?.info,
    event
  ];
  for (const candidate of candidates) {
    const usage = tokenUsageFromInfo(candidate);
    if (usage) return usage;
  }
  const total = jsonTokenTotal(event);
  return total === null ? null : { total, grossTotal: total };
}

function normalizePercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, percent));
}

function normalizeCodexRateLimitWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = normalizePercent(window.used_percent ?? window.usedPercent);
  const remainingPercent = usedPercent === null ? null : Number((100 - usedPercent).toFixed(2));
  const windowMinutes = Number(window.window_minutes ?? window.windowMinutes);
  return {
    usedPercent,
    remainingPercent,
    windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
    resetsAt: String(window.resets_at ?? window.resetsAt ?? "")
  };
}

function normalizeCodexRateLimits(rawRateLimits) {
  if (!rawRateLimits || typeof rawRateLimits !== "object") return null;
  const primary = normalizeCodexRateLimitWindow(rawRateLimits.primary);
  const secondary = normalizeCodexRateLimitWindow(rawRateLimits.secondary);
  if (!primary && !secondary) return null;
  return {
    limitId: String(rawRateLimits.limit_id ?? rawRateLimits.limitId ?? ""),
    limitName: rawRateLimits.limit_name ?? rawRateLimits.limitName ?? null,
    primary,
    secondary,
    credits: rawRateLimits.credits ?? null,
    planType: String(rawRateLimits.plan_type ?? rawRateLimits.planType ?? ""),
    rateLimitReachedType: normalizeRateLimitType(rawRateLimits.rate_limit_reached_type ?? rawRateLimits.rateLimitReachedType ?? ""),
    updatedAt: new Date().toISOString()
  };
}

function jsonRateLimits(event) {
  const payload = event?.payload || event || {};
  const candidates = [
    payload?.info?.rate_limits,
    payload?.rate_limits,
    event?.info?.rate_limits,
    event?.rate_limits
  ];
  for (const candidate of candidates) {
    const normalized = normalizeCodexRateLimits(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function codexSessionsRoot() {
  const codexHome = String(process.env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}

function listRecentSessionFiles(root, limit = 80) {
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

function readLatestCodexRateLimitsFromSessions() {
  const files = listRecentSessionFiles(codexSessionsRoot());
  for (const filePath of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/).reverse();
    for (const line of lines) {
      const parsed = tryParseJsonLine(line);
      if (!parsed) continue;
      const rateLimits = jsonRateLimits(parsed);
      if (!rateLimits) continue;
      rateLimits.updatedAt = String(parsed.timestamp || rateLimits.updatedAt || new Date().toISOString());
      rateLimits.source = "codex-session";
      return {
        source: "codex-session",
        tokenUsage: {
          ...(jsonTokenUsage(parsed) || { total: 0, grossTotal: jsonTokenTotal(parsed) || 0 }),
          rateLimits
        },
        rateLimits
      };
    }
  }
  return null;
}

function normalizePathForSearch(value) {
  return String(value || "")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
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

function readLatestCodexTokenUsageFromSessions({
  sinceMs = 0,
  jobDir = "",
  resultFileName = ""
} = {}) {
  const expectedResultPath = resultFileName && jobDir
    ? normalizePathForSearch(path.join(jobDir, resultFileName))
    : "";
  const expectedFileName = normalizePathForSearch(resultFileName);
  const files = listRecentSessionFiles(codexSessionsRoot(), 120);
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      if (sinceMs && stat.mtimeMs < sinceMs - 10000) continue;
    } catch {
      continue;
    }

    let raw = "";
    try {
      raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    } catch {
      continue;
    }

    if (expectedResultPath && !sessionMatchesJob(raw, jobDir, path.join(jobDir, resultFileName))) continue;

    let latestUsage = null;
    let latestRateLimits = null;
    let updatedAt = "";
    for (const line of raw.split(/\r?\n/)) {
      const parsed = tryParseJsonLine(line);
      if (!parsed) continue;
      const parsedUsage = jsonTokenUsage(parsed);
      if (parsedUsage) {
        latestUsage = parsedUsage;
        updatedAt = String(parsed.timestamp || updatedAt || "");
      }
      const parsedRateLimits = jsonRateLimits(parsed);
      if (parsedRateLimits) {
        latestRateLimits = parsedRateLimits;
        latestRateLimits.updatedAt = String(parsed.timestamp || latestRateLimits.updatedAt || new Date().toISOString());
        latestRateLimits.source = "codex-session";
        updatedAt = String(parsed.timestamp || updatedAt || "");
      }
    }
    if (latestUsage || latestRateLimits) {
      return {
        source: "codex-session",
        sessionFile: filePath,
        updatedAt,
        tokenUsage: {
          ...(latestUsage || { total: 0, grossTotal: 0 }),
          rateLimits: latestRateLimits
        },
        rateLimits: latestRateLimits
      };
    }
  }
  return null;
}

function pushAssistantContentText(content, texts) {
  if (typeof content === "string") {
    texts.push(content);
    return;
  }
  if (!content) return;
  if (Array.isArray(content)) {
    for (const item of content) pushAssistantContentText(item, texts);
    return;
  }
  if (typeof content !== "object") return;
  if (typeof content.text === "string") texts.push(content.text);
  if (typeof content.output_text === "string") texts.push(content.output_text);
  if (typeof content.message === "string") texts.push(content.message);
}

function extractAssistantOutputTexts(event) {
  const payload = event?.payload || event || {};
  const item = payload.item || payload.payload || payload;
  const texts = [];

  if (payload.type === "agent_message" && typeof payload.message === "string") {
    texts.push(payload.message);
  }
  if (payload.type === "response_item" && item?.role === "assistant") {
    pushAssistantContentText(item.content, texts);
  }
  if (item?.type === "message" && item?.role === "assistant") {
    pushAssistantContentText(item.content, texts);
  }
  if (item?.type === "agent_message" && typeof item.message === "string") {
    texts.push(item.message);
  }
  if (payload.type === "agent_message_delta" && typeof payload.delta === "string") {
    texts.push(payload.delta);
  }
  return texts;
}

function isUsefulCodexFeedback(line) {
  const text = stripAnsi(line).trim();
  if (!text) return false;
  if (looksLikeMojibake(text)) return false;
  if (/^OpenAI Codex\b/i.test(text)) return false;
  if (/^-{3,}$/.test(text)) return false;
  if (/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(text)) return false;
  if (/^(user|assistant)$/i.test(text)) return false;
  if (/^BLOGAUTO_RESULT_READY$/i.test(text)) return false;
  if (/^mcp:/i.test(text)) return false;
  if (/codex_core::tools::router/i.test(text)) return false;
  if (/codex_core_plugins::manifest/i.test(text)) return false;
  if (/ignoring interface\.defaultPrompt/i.test(text)) return false;
  if (/^Wall time:/i.test(text)) return false;
  if (/^Output:/i.test(text)) return false;
  if (/ConvertFrom-Json|CategoryInfo|FullyQualifiedErrorId/i.test(text)) return false;
  if (/^(Get-Content|Invoke-WebRequest|Set-Content|Out-File|Copy-Item|Move-Item|Remove-Item)\s*:/i.test(text)) return false;
  if (/Cannot find path|because it does not exist|원격 서버에 연결할 수 없습니다|액세스가 거부되었습니다|AccessException|PermissionDenied|Exception\b|At line:/i.test(text)) return false;
  if (/^위치\s+줄|^At line:/i.test(text)) return false;
  if (/^\+\s+/.test(text)) return false;
  if (/^[\{\}\],]+$/.test(text)) return false;
  const inlineJsonFragment = text.startsWith("{") || text.startsWith("[")
    ? text.slice(1).trimStart()
    : "";
  if (inlineJsonFragment.startsWith("\"") && inlineJsonFragment.indexOf("\":") > 1) return false;
  const inlineJsonColonIndex = inlineJsonFragment.indexOf(":");
  if (inlineJsonColonIndex > 0 && /^[A-Za-z0-9_$-]+$/.test(inlineJsonFragment.slice(0, inlineJsonColonIndex))) return false;
  if (/^"[^"]+"\s*:\s*/.test(text)) return false;
  if (/^"[^"]*"\s*,?$/.test(text)) return false;
  if (/^\d{4}-\d{2}-\d{2}T.*\b(WARN|DEBUG|TRACE)\b/i.test(text)) return false;
  if (/^\d{4}-\d{2}-\d{2}T.*\bERROR\b.*codex_core/i.test(text)) return false;
  if (/^\[?codex\]?\s*mcp:/i.test(text)) return false;
  return true;
}

function looksLikeMojibake(text) {
  const value = String(text || "");
  if (value.includes("\uFFFD")) return true;
  const questionMarks = (value.match(/\?/g) || []).length;
  const cjkMarkers = (value.match(/[一-龥燎-刺]/g) || []).length;
  if (questionMarks >= 2 && cjkMarkers >= 2) return true;
  const markerCount = [
    "怨", "寃", "湲", "醫", "諛", "蹂", "吏", "泥", "理", "踰", "援", "紐",
    "묒", "떖", "쇰", "ъ", "꽦", "쒕", "떎", "쒖", "섏", "먯", "꾩", "낅", "뺤", "앸", "뻽", "듬", "땲",
    "씤", "덈", "쓣", "쓽", "쟻", "젙", "룞", "쉶", "깆", "낵", "쓬", "븯"
  ].reduce((count, marker) => count + (value.includes(marker) ? 1 : 0), 0);
  return (markerCount >= 2 && questionMarks >= 1) || markerCount >= 4;
}

function shouldSuppressWriterFeedback(agent, level) {
  return agent === "writer" && !["warn", "error"].includes(String(level || "info"));
}

function shouldForwardRawCodexOutput(options = {}) {
  return options.debugCodexRawOutput === true || process.env.BLOGAUTO_DEBUG_CODEX_RAW === "1";
}

function parseTokenLine(text, tokenState) {
  const cleaned = stripAnsi(text).trim();
  if (!cleaned) return null;
  const sameLine = cleaned.match(/tokens?\s+used\s*:?\s*([0-9][0-9,]*)/i);
  if (sameLine) {
    const total = Number(sameLine[1].replace(/,/g, ""));
    return Number.isFinite(total) ? total : null;
  }
  if (/tokens?\s+used/i.test(cleaned)) {
    tokenState.awaitingValue = true;
    return null;
  }
  if (tokenState.awaitingValue) {
    const nextLine = cleaned.match(/^([0-9][0-9,]*)$/);
    tokenState.awaitingValue = false;
    if (nextLine) {
      const total = Number(nextLine[1].replace(/,/g, ""));
      return Number.isFinite(total) ? total : null;
    }
  }
  return null;
}

function parseProgressLine(text, options = {}) {
  const match = String(text || "").trim().match(/^BLOGAUTO_PROGRESS:\s*(.+)$/i);
  if (!match) return null;
  const code = match[1].trim().toLowerCase();
  const bodyImageLimit = Math.min(10, Math.max(0, Number.isFinite(Number(options.maxBodyImages)) ? Number(options.maxBodyImages) : 2));
  const usesImages = options.includeTitleImage !== false || bodyImageLimit > 0;
  if (code === "image" && !usesImages) return null;
  const labels = {
    research: "리서치 흐름 분석 중",
    title: "제목 선정 중",
    source_review: "검색 후보 검토 중",
    date_filter: "기간성 정보 검증 중",
    writer: "Writer Agent 작성 중",
    article: "본문 작성 중",
    main_review: "Main Agent 최종 검수 중",
    image: "이미지 생성 중",
    save: "결과 저장 중"
  };
  return labels[code] || match[1].trim();
}

function compactSearchResultsForPrompt(searchResults, {
  maxResults = 12,
  excerptChars = 700
} = {}) {
  return rankSearchResultsForPrompt(searchResults)
    .slice(0, maxResults)
    .map((item, index) => {
      const relevance = item?.relevance || {};
      return {
        sourceId: String(item?.sourceId || `source-${index + 1}`),
        provider: String(item?.provider || ""),
        title: String(item?.title || ""),
        url: String(item?.url || ""),
        fetchedUrl: String(item?.fetchedUrl || ""),
        contentLength: Number(item?.contentLength || 0),
        excerpt: String(item?.excerpt || "").replace(/\s+/g, " ").trim().slice(0, excerptChars),
        relevance: {
          score: Number(relevance.score || 0),
          topicMatchedTerms: Array.isArray(relevance.topicMatchedTerms) ? relevance.topicMatchedTerms.slice(0, 8) : [],
          keywordMatchedTerms: Array.isArray(relevance.keywordMatchedTerms) ? relevance.keywordMatchedTerms.slice(0, 8) : [],
          officialSource: relevance.officialSource === true,
          institutionalSource: relevance.institutionalSource === true,
          independentSource: relevance.independentSource === true,
          blogTrustedSource: relevance.blogTrustedSource === true,
          lowTrustSource: relevance.lowTrustSource === true,
          currentFactSignal: relevance.currentFactSignal === true,
          strictEvidence: relevance.strictEvidence === true,
          authorityEvidence: relevance.authorityEvidence === true,
          independentEvidence: relevance.independentEvidence === true
        }
      };
    });
}

function searchResultPromptKey(item) {
  return String(item?.fetchedUrl || item?.url || item?.title || "").trim().toLowerCase();
}

function isAuthorityPromptCandidate(item) {
  const relevance = item?.relevance || {};
  return relevance.officialSource === true || relevance.institutionalSource === true;
}

function isIndependentPromptCandidate(item) {
  return item?.relevance?.independentSource === true;
}

function isStrongPromptCandidate(item) {
  const relevance = item?.relevance || {};
  return relevance.strictEvidence === true
    && relevance.currentFactSignal === true
    && relevance.lowTrustSource !== true
    && Number(relevance.score || 0) >= 8;
}

function scoreSearchResultForPrompt(item) {
  return Number(item?.relevance?.score || 0);
}

function uniquePromptCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = searchResultPromptKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function rankSearchResultsForPrompt(searchResults) {
  const items = Array.isArray(searchResults) ? searchResults.filter(Boolean) : [];
  const authorityItems = items
    .filter(isAuthorityPromptCandidate)
    .sort((a, b) => scoreSearchResultForPrompt(b) - scoreSearchResultForPrompt(a));
  const independentItems = items
    .filter((item) => !isAuthorityPromptCandidate(item) && isIndependentPromptCandidate(item))
    .sort((a, b) => scoreSearchResultForPrompt(b) - scoreSearchResultForPrompt(a));
  const strongItems = items
    .filter((item) => !isAuthorityPromptCandidate(item) && !isIndependentPromptCandidate(item) && isStrongPromptCandidate(item))
    .sort((a, b) => scoreSearchResultForPrompt(b) - scoreSearchResultForPrompt(a));
  return uniquePromptCandidates([...authorityItems, ...independentItems, ...strongItems, ...items]);
}

function isMissingCodexResultFileError(error) {
  return /Codex result file was not created:/i.test(String(error?.message || ""));
}

function buildPrompt({
  topic,
  keyword,
  category,
  searchResults,
  historyTitles,
  jobDir,
  runtimeRoot,
  currentDateLabel,
  includeTitleImage = true,
  maxBodyImages = 2,
  sourceQuality = null,
  topicMode = "manual",
  researchTitleResult = null,
  excludedTopics = "",
  publishPurpose = "",
  preferredTone = "",
  freshnessLevel = "auto",
  writerRevisionFeedback = "",
  writerAttempt = 1,
  maxWriterAttempts = 1,
  accountImageStylePrompt = ""
}) {
  const resultPath = path.join(jobDir, "agent-result.json");
  const imageDir = path.join(runtimeRoot || path.dirname(path.dirname(jobDir)), "image");
  const bodyImageLimit = Math.min(10, Math.max(0, Number.isFinite(Number(maxBodyImages)) ? Number(maxBodyImages) : 2));
  const usesImages = includeTitleImage !== false || bodyImageLimit > 0;
  const researchSearchNeed = String(researchTitleResult?.searchNeed || "").toLowerCase();
  const writerContract = buildWriterContract(researchTitleResult, {
    topic,
    keyword,
    category,
    publishPurpose,
    preferredTone,
    topicMode,
    currentDateLabel
  });
  fs.mkdirSync(imageDir, { recursive: true });

  return [
    "You are generating a Korean Naver Blog post for a local desktop automation app.",
    "Do not include credentials or ask for secrets.",
    `Topic: ${topic}`,
    `Topic mode: ${topicMode}`,
    `Optional keyword: ${keyword || "(none)"}`,
    `Category: ${category}`,
    `Category excluded topics: ${excludedTopics || "(agent decides)"}`,
    `Category publishing direction: ${publishPurpose || "(agent decides)"}`,
    `Preferred tone: ${preferredTone || "(agent decides)"}`,
    "- Tone priority: explicit Preferred tone > Writer Contract tone > default human Naver Blog voice. If Preferred tone conflicts with default style rules, follow Preferred tone while preserving factual accuracy, safety, and title/body promise.",
    `Freshness level: ${freshnessLevel || "auto"}`,
    researchTitleResult ? `Research/Title selected title: ${researchTitleResult.finalTitle || researchTitleResult.selectedTitle || ""}` : "",
    `Current writing date: ${currentDateLabel || new Date().toISOString().slice(0, 10)}`,
    `Output JSON path: ${resultPath}`,
    `App image directory for later app-side copy: ${imageDir}`,
    "",
    "Progress logging:",
    "- Print only these concise progress lines as each stage begins. Do not print scripts, code, shell commands, or tool internals.",
    "- BLOGAUTO_PROGRESS: source_review",
    "- BLOGAUTO_PROGRESS: date_filter",
    "- BLOGAUTO_PROGRESS: article",
    "- BLOGAUTO_PROGRESS: save",
    "",
    writerRevisionFeedback ? "Revision retry:" : "",
    writerRevisionFeedback ? `- This is Writer retry attempt ${writerAttempt}/${maxWriterAttempts}. Keep the Research/Title final title and rewrite the article JSON to fix the issues below.` : "",
    writerRevisionFeedback ? `- Revision instructions from Main Agent or previous Writer result: ${writerRevisionFeedback}` : "",
    writerRevisionFeedback ? "- Overwrite the same Output JSON path with the corrected result. Do not explain the retry in the article." : "",
    writerRevisionFeedback ? "" : "",
    researchTitleResult ? "Writer contract (highest priority):" : "",
    researchTitleResult ? JSON.stringify(writerContract, null, 2) : "",
    researchTitleResult ? "- The Writer Contract is the only writing brief. Use source candidates and the full Research/Title handoff only to support facts, limits, and source boundaries." : "",
    researchTitleResult ? "- If the full handoff or source candidates conflict with the Writer Contract, keep the selected title/topic and return status \"failed\" rather than drifting." : "",
    researchTitleResult ? "- Category publishing direction may include topic-selection notes for Research/Title Agent. As Writer Agent, treat it only as category scope and reader intent, not as an instruction to perform research, select a topic, or change the selected title." : "",
    researchTitleResult ? "- If Writer Contract says currentBridgeRequired is true, the article must explain both the older anchorEvent and the currentPeg/progress. If currentBridgeSatisfied is not true or currentPeg is missing, return status \"failed\" instead of writing a stale current-issue article." : "",
    researchTitleResult ? "" : "",
    "Instruction harness:",
    researchTitleResult ? "- You are the Writer Agent. Do not create a new topic and do not change the selected title from the Research/Title Agent." : "",
    researchTitleResult ? "- Use the Writer Contract above as the writing boundary. If it is insufficient, return status \"failed\" instead of inventing facts." : "",
    "- Editorial priority order: Writer Contract > Research/Title finalTitle and topicThesis > confirmed facts/source boundaries > Category publishing direction > Optional keyword.",
    "- Treat uncertainty, source boundaries, and source limitations as guardrails. They are not article material by themselves.",
    "- Treat Writer Contract safetyBoundaries as internal publishing limits. Convert them into supported reader decisions only when the sources provide useful action; otherwise fail instead of describing the article's own limits.",
    "- When facts come from source review, rewrite them as reader-facing subject-state sentences. Do not make the article sound like the writer is reporting that something was observed, checked, or confirmed.",
    "- Use confirmation or verification framing only for the reader's next check on uncertain or variable details, not as the default way to state confirmed menus, programs, facts, or conditions.",
    "- Before writing, map the selected title to reader questions. A successful post must answer those questions with supported information, not fill sections with reminders that information is uncertain.",
    "- Every section must move the reader forward with at least one concrete value item: a confirmed fact, a practical step, a decision criterion, a comparison, a consequence, or a next-check path supported by the handoff.",
    "- If you can only write broad cautions, repeated verification advice, or a vague overview that does not answer the selected title, return status \"failed\" instead of padding the article.",
    "- If Topic mode is manual, treat Topic as the fixed editorial thesis. Category and Optional keyword are only routing/tagging context and must never override, broaden, rename, or replace the Topic.",
    "- If Topic mode is auto and Topic is only a seed generated from Category/Optional keyword, derive one narrow current thesis from the strongest source candidates. After deriving it, treat that thesis as the fixed article topic.",
    "- Before choosing sources or writing, parse Topic into: main subject, controlling event/action, angle, and the reader question the article must answer.",
    "- If Topic contains an event word such as suspension, shutdown, discontinued, ended, launch, outage, price increase, policy change, controversy, recall, application, recruitment, exhibition, or deadline, that event/action is the controlling angle.",
    "- Example: for a Topic like 'recent Fable 5 service suspension issue', Fable 5 is the subject and service/access suspension is the controlling event. Do not turn it into a generic Claude Code update, AI agent trend, or model comparison article.",
    "- Do not drift into adjacent categories just because a high-ranking result is popular. If a candidate does not directly help explain the Topic thesis, discard it even when it matches Category or Optional keyword.",
    "- Always interpret sources relative to the Current writing date. Use that date only as an internal validation reference.",
    "- Harness step 1: lock the Topic thesis from Topic mode and Topic. Only in auto mode may Category/Optional keyword be used to derive that thesis.",
    "- Harness step 2: discard candidates that do not directly support the locked Topic thesis, including broad background pages that only mention related entities.",
    "- Harness step 3: for date-bound material, discard expired events, closed applications, past deadlines, and outdated schedules using Current writing date.",
    "- Harness step 4: write a reader-facing Naver Blog article by summarizing, explaining, and reorganizing only the remaining relevant extracted excerpts. Do not create an unsupported generic article.",
    "- Harness step 5: before saving JSON, check date handling. The title must not contain the Current writing date. The article must not mention the writing date as a meta value such as 작성일, 작성일자, 오늘 날짜, or 현재 날짜.",
    "- Exception: if the title or body claims 접수중, 모집중, 신청 가능, 현재 운영, current availability, or another current/date-bound status, the article body must include a concise confirmation 기준일 such as '2026년 6월 18일 기준'. This required 기준일 is not a date leak.",
    "- If a true date-leak check fails, rewrite the title/article silently until only allowed 기준일 usage remains. Do not print 'date leak check failed' or mention this internal check in the article.",
    "",
    researchSearchNeed === "skip"
      ? "Research/Title Agent judged that external search can be skipped. Use the Writer Contract as the writing boundary, avoid current/date-bound claims, and do not invent specific facts."
      : "Use the extracted source candidates below as the factual basis. Each candidate may include title, url, fetchedUrl, excerpt, contentLength, and relevance.",
    JSON.stringify(compactSearchResultsForPrompt(searchResults, {
      maxResults: 8,
      excerptChars: 700
    }), null, 2),
    researchTitleResult ? "Full Research/Title handoff for factual support only:" : "",
    researchTitleResult ? JSON.stringify(researchTitleResult, null, 2) : "",
    "",
    "Source quality summary:",
    JSON.stringify(sourceQuality || { status: "unknown" }, null, 2),
    "- If Source quality status is \"insufficient\", immediately write the failed JSON described below and stop. Do not write an explanatory article.",
    "- If Source quality status is \"skipped\", continue only when the Research/Title Agent marked searchNeed as \"skip\" and the topic is not fact-risky or current/date-bound.",
    "- If sourceQuality.topicMatchedCandidates is 0 for a manual Topic, treat it as insufficient support unless the excerpts clearly use synonyms for the same subject/event.",
    "- Even when Source quality status is \"usable\", you must still fail if the excerpts cannot answer the locked Topic thesis. Broad related information is not enough.",
    "- If Source quality says independentEvidenceRequired is true, do not write from Naver blog candidates alone. The article needs at least one official/institutional source or independent editorial source candidate supporting the core launch/release/announcement fact.",
    "- Failure is a normal valid output. If you cannot support the post from extracted excerpts, you must set status to \"failed\". Do not try to be helpful by writing a caveat-filled article.",
    "",
    "Existing titles for duplicate awareness:",
    JSON.stringify(historyTitles.slice(0, 80), null, 2),
    "",
    "Required output:",
    "- Write a JSON file at the exact Output JSON path.",
    "- The JSON file must be UTF-8 and Korean text must not be mojibake or escaped into a broken encoding.",
    "- JSON shape: { \"status\": \"success\" | \"failed\", \"failureReason\": string, \"title\": string, \"article\": string, \"tags\": string[], \"bodyImages\": [{\"sequence\": number, \"path\": string, \"prompt\": string}], \"titleImagePath\": string, \"titleImagePrompt\": string, \"notes\": string[] }.",
    "- If the extracted excerpts are missing, too thin, unrelated to the locked Topic thesis, or cannot support a publishable post, do not write an explanatory article.",
    "- In that failure case, set status to \"failed\", set failureReason to a concise Korean reason, set title and article to empty strings, set bodyImages to [], set titleImagePath to \"\", and put the reason in notes.",
    "- In a failure case, do not generate images and do not write article sections explaining why writing is difficult.",
    "- Only set status to \"success\" when the remaining extracted excerpts support a real article.",
    "- If status is \"failed\", the desktop app will record failure history and stop the cycle. That is the correct behavior.",
    "- Article must be Korean, Naver Blog SEO oriented, 1500-2000 Korean characters when possible.",
    researchTitleResult ? "- The article must fulfill the Writer Contract: articleMission, selectedTitle, topicThesis, readerPromise, firstSectionFocus, mustAnswer, mustCover, mustNotDo, and current bridge fields when required." : "",
    researchTitleResult ? "- The article must also fulfill the Writer Contract readerValueChecklist. If it cannot, return status \"failed\"." : "",
    researchSearchNeed === "skip"
      ? "- Because search was skipped by Research/Title Agent, write from stable general explanation and the handoff only. Do not invent current facts, dates, amounts, conditions, official claims, or personal experience."
      : "- Do not write a fresh generic article from prior knowledge. Summarize and reorganize the extracted candidate excerpts.",
    "- Build the title from the locked Topic thesis and directly supporting excerpts, not from Category, Optional keyword, or a broad common theme.",
    "- The article must synthesize overlapping facts, dates, names, programs, events, products, releases, causes, effects, reactions, and implications found in excerpts that support the locked Topic thesis.",
    "- Do not copy source sentences verbatim. Rewrite in original Korean while preserving factual meaning.",
    "- If the excerpts are too thin or unrelated to the locked Topic thesis, fail with status \"failed\". Do not put source problems inside the article body.",
    "- Write like an excellent Korean Naver blogger/editor, not like an internal research report. The article body must not use meta words such as candidate, excerpt, provided material, search result, source quality, notes, or report.",
    "- Default human Naver Blog voice: sound like a real person organizing the issue for a reader. Use a warm but not chatty lead, mix sentence lengths, include reader-facing transitions such as what this means, why readers search for it, what to check before acting, and avoid stiff summary-report cadence.",
    "- Unless Preferred tone explicitly asks otherwise, the opening should start from the reader's situation or curiosity before moving into facts. Do not fake personal experience, visits, purchases, or emotions that were not provided.",
    "- The article body must never narrate the agent's research process, source collection process, or verification workflow.",
    "- The article body must speak directly to the reader about the selected subject, not about the article's own coverage choices, writing limits, or internal validation decisions.",
    "- Category publishing direction is internal guidance. Do not copy it into the article body, do not justify the category, and do not open with a defensive contrast such as 'this is not a general guide/advice'.",
    "- The first section must answer the title from the reader's point of view: what the topic is, who should care, why it matters, and what the reader should understand or check next.",
    "- When the topic uses an older anchorEvent as a current issue, the first section must bridge it to the currentPeg: current status, recent procedure, new ruling/order, settlement/dismissal, policy change, official position shift, or another source-backed reason it matters now.",
    "- Source attribution is allowed only as reader-facing verification guidance. Do not make source verification itself the main content.",
    "- For policy, support program, recruitment, education, training, money, price, schedule, deadline, or application topics, include practical reader sections for target/eligibility, support details, application or checking path, variable items to verify, and cautions. If the handoff cannot support those sections, fail instead of writing a shallow article.",
    "- Do not make uncertainty the article's main structure. For reader-risk topics, use one concise caution where needed, then focus on supported facts, usable paths, criteria, and reader decisions. If those are not available, fail.",
    "- The reader should feel the post is explaining the Topic itself: what happened, why it matters, what is confirmed, what is uncertain, who is affected, and what to watch next.",
    "- For issue/news topics, keep the controlling event visible from title through every section. Background context is allowed only when it explains that event.",
    "- Do not repeat the generated title as a plain article line. The app will place the title as a Naver quote block at the top of the post.",
    "- Do not mention the current writing date in the title. In the article body, mention it only when it is needed as a factual 확인 기준일 for current/date-bound status such as 접수중, 모집중, 신청 가능, 현재 운영, prices, schedules, deadlines, policy/support conditions, or official announcements.",
    "- Structure the article into readable sections when the topic naturally has steps, criteria, examples, pros/cons, or enumerated points.",
    "- For each section heading, put a standalone marker line in article exactly like [SECTION - 소제목].",
    "- Every section marker must start with \"[SECTION - \" and end with \"]\" on the same standalone line. Never omit the closing bracket.",
    "- If you would write 첫째/둘째/첫 번째/두 번째 as an item label, convert that item label into a [SECTION - ...] marker instead of keeping it inside a paragraph.",
    "- Section marker text must be concise, natural Korean, reader-facing, and suitable as a Naver Blog section heading. Avoid headings that describe research/source process instead of reader value.",
    "- For events, job fairs, exhibitions, contests, applications, recruitment notices, sales, deadlines, or any date-bound information: exclude anything whose event date, application period, deadline, or relevant operating period is already past relative to the Current writing date.",
    "- If a date-bound candidate has no confirmable current or future date from an official/reliable source, do not present it as an upcoming/current opportunity. You may mention it only as a general example without implying availability.",
    "- Prefer official/current pages for date-bound information and record in notes that outdated or unconfirmed date-bound candidates were excluded when applicable.",
    bodyImageLimit > 0
      ? "- Insert image markers exactly as [IMAGE INSERT - 1], [IMAGE INSERT - 2], etc where images belong."
      : "- Do not insert any [IMAGE INSERT - n] markers in the article body.",
    bodyImageLimit > 0
      ? `- Prepare no more than ${bodyImageLimit} body image prompts. Put each prompt in bodyImages[].prompt, keep bodyImages[].path empty, and do not generate actual image files.`
      : "- Do not generate body images. Set bodyImages to an empty array.",
    includeTitleImage
      ? "- Prepare one title image prompt in titleImagePrompt and keep titleImagePath empty. Do not generate an actual title image file."
      : "- Do not prepare a title image. Set titleImagePath and titleImagePrompt to empty strings.",
    usesImages
      ? "- Actual image generation is handled later by Image Worker. Writer Agent must only provide grounded prompts and marker positions."
      : "- Since no images were requested, do not perform an image prompt or image-generation stage and do not write image-generation notes.",
    usesImages ? "- Image prompts must be concrete and content-grounded, not abstract decorative art. Avoid vague prompts like network glow, futuristic background, abstract data waves, generic robot, or unrelated stock-style visuals." : "",
    usesImages && accountImageStylePrompt ? "- Account-specific image style prompt: apply this style when drafting titleImagePrompt and bodyImages[].prompt, while keeping the article facts and each section context primary." : "",
    usesImages && accountImageStylePrompt ? accountImageStylePrompt : "",
    usesImages && accountImageStylePrompt ? "- If the account style conflicts with title text policy, body no-text policy, or verified facts, follow the app policy and facts first." : "",
    includeTitleImage ? "- The title image must summarize the whole article across sections. Base it on the article's central entities, issue, relationship, or timeline, so a reader can infer the article topic before reading." : "",
    includeTitleImage ? "- Title image prompts may request short Korean headline text, key verified numbers, period, benefit, or condition text when it helps summarize the whole article. Keep text short and do not invent unverified facts." : "",
    bodyImageLimit > 0 ? "- Each body image must summarize the nearby section where its [IMAGE INSERT - n] marker appears. Use concrete nouns, named products/people/places/events, and the section's key comparison or process." : "",
    usesImages ? "- When writing image prompts, include the article title or section heading context, 2-4 concrete visual elements from the extracted facts, and a clear Korean blog editorial style. Do not invent facts that are not in the article." : "",
    bodyImageLimit > 0 ? "- Body image prompts must keep the existing no-text policy: avoid readable text, Korean paragraphs, long labels, UI copy, and text-heavy charts. Prefer visual composition, objects, scenes, icons, and simple non-textual cues." : "",
    usesImages ? "- Do not return an image directory path as an image path. Each path must include the concrete image filename such as .png, .jpg, .jpeg, or .webp." : "",
    usesImages ? "- Do not call image generation tools. Do not spend time trying PowerShell, shell copy, or Node copy workarounds for images." : "",
    "- For automatic/current-information topics, avoid generic how-to guide titles such as '~찾는 법', '~확인법', '~가이드' unless the user explicitly asked for a how-to guide.",
    "- Choose a concrete current angle that fits the category and keyword. Examples: for news categories, cover a specific recent issue or trend; for job categories, cover currently valid openings/programs/events; for tech categories, cover a specific product, model, policy, release, or market change.",
    "- Do not force every category into opportunities, programs, or events. Let the category and source candidates decide the article angle.",
    "- Do not write filler, do not exaggerate claims, and do not create an advertisement.",
    "- Tags must not include more than 29 values.",
    "",
    "After writing the JSON file, print one final line: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildResearchTitlePrompt({
  topic,
  keyword,
  category,
  searchResults,
  historyTitles,
  jobDir,
  currentDateLabel,
  sourceQuality = null,
  topicMode = "manual",
  excludedTopics = "",
  publishPurpose = "",
  preferredTone = "",
  freshnessLevel = "auto",
  keywordLanes = [],
  recommendedKeywordLanes = [],
  researchRevisionContext = ""
}) {
  const resultPath = path.join(jobDir, "research-title-result.json");
  const hasSearchCandidates = Array.isArray(searchResults) && searchResults.length > 0;
  const laneList = Array.isArray(keywordLanes) ? keywordLanes : [];
  const recommendedLaneList = Array.isArray(recommendedKeywordLanes) ? recommendedKeywordLanes : [];
  return [
    "You are the Research/Title Agent for a Korean Naver Blog automation app.",
    "Do not write the article body. Do not generate images.",
    `Category: ${category}`,
    `Category keyword: ${keyword || "(none)"}`,
    `User direct topic: ${topic || "(none)"}`,
    `Topic mode: ${topicMode}`,
    `Current writing date: ${currentDateLabel || new Date().toISOString().slice(0, 10)}`,
    `Excluded topics: ${excludedTopics || "(agent decides)"}`,
    `Publish purpose: ${publishPurpose || "(agent decides)"}`,
    `Preferred tone: ${preferredTone || "(agent decides)"}`,
    "- Tone priority: if Preferred tone is provided, it is the highest style signal for finalTitle and writerContract.tone. Default hook and human-blog guidance apply only when they do not conflict with Preferred tone.",
    `Freshness level: ${freshnessLevel || "auto"}`,
    "",
    "Keyword lanes:",
    JSON.stringify(laneList, null, 2),
    "Recommended keyword lane order from HISTORY:",
    JSON.stringify(recommendedLaneList, null, 2),
    "- In auto topic mode, treat Category keyword as a lane pool, not as one search query.",
    "- Select one narrow topicLane first, preferably from the recommended order, then derive the title and searchQueries inside that lane.",
    "- In auto topic mode, the selected topicLane is only a discovery lane. It is not itself the article subject or final title.",
    "- After search candidates are provided, PASS only when finalTitle is anchored to a concrete source-backed subject, event/action, tension, consequence, or reader decision point found inside that lane.",
    "- Do not PASS a lane-level or category-level title that could fit many unrelated items, such as a generic question about whether the lane matters. If no concrete anchor is available, return REVISION with sharper discovery searchQueries or BLOCK.",
    "- When returning REVISION because the concrete anchor is missing, make searchQueries/coreQuestions/uncertainItems describe the missing facts and discovery intent, not just the lane name.",
    "- Do not repeatedly choose the original first keyword just because it appears first. HISTORY order is provided to reduce repetition.",
    "- Do not combine all keyword lanes into one search query.",
    `Output JSON path: ${resultPath}`,
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: research",
    "- BLOGAUTO_PROGRESS: title",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Core rules:",
    hasSearchCandidates
      ? "- Search/source candidates are provided because the Research/Title Agent or the app determined they are needed. Analyze them as signals and facts, not as copy material."
      : "- No NAVER/GOOGLE search candidates have been collected yet. First judge whether search is needed from the input itself; do not assume search was already performed.",
    hasSearchCandidates
      ? ""
      : "- When search candidates are absent, do not perform web searches, browser actions, network fetches, or shell/file reads for research. Decide searchNeed from the user's category/topic/keyword only, then write the output JSON. Use shell only if it is needed to write the JSON result file.",
    "- If a user direct topic exists and topicMode is manual, preserve that topic. Search results can refine expression and verify facts, but must not replace the user's topic.",
    "- If no direct topic exists or topicMode is auto, derive one narrow candidate topic from a single Keyword lane. If current facts are required, return searchNeed light/normal/strict and wait for app-provided search candidates instead of verifying facts yourself.",
    "- If topicMode is auto and search candidates are present, use the candidates to select a concrete anchor before finalTitle. Do not summarize the common denominator of several keyword lanes.",
    "- Treat Current writing date as an internal freshness reference, not as title material. Put a year/month in finalTitle only when that date is part of the confirmed event, policy, product, deadline, edition, or source-backed fact itself.",
    "- Current bridge rule: when a selected topic is anchored in an older event but framed as a current issue, separate anchorEvent from currentPeg. anchorEvent is the original event/date; currentPeg is the source-backed current reason to write now, such as recent progress, ruling, order, discovery, settlement, dismissal, official statement, policy change, deadline, application status, product change, price/schedule update, or similar current development.",
    "- For strict/current topics, if anchorEvent exists and currentPeg cannot be confirmed from usable sources, do not return PASS. Return REVISION/BLOCK and make searchQueries seek the currentPeg rather than repeating only the old event.",
    "- If currentBridgeRequired is true, currentBridgeSatisfied may be true only when currentPeg has a date/summary and at least one usable source boundary or usable source supports it.",
    "- Determine search need as one of: skip, light, normal, strict. Map freshness level low/medium/high to lighter or stricter research, but official/current facts still require strict handling.",
    "- Use searchNeed \"skip\" only for stable concept/explanation/opinion/experience-style topics that can be written safely without current facts.",
    "- Use searchNeed \"light\", \"normal\", or \"strict\" when current search flow, NAVER exposure, Google/official fact checks, or official/current sources are needed.",
    "- If search candidates are absent and searchNeed is light/normal/strict, return status \"REVISION\" quickly unless the topic must be blocked immediately. In that case, describe what search or official facts are needed in writerBrief, coreQuestions, and notes.",
    "- If search candidates are absent and searchNeed is skip, you may return PASS/REVISION with a safe title and writer brief.",
    "- Separate confirmed facts from interpretation.",
    "- For policy, support programs, law, tax, recruitment, prices, schedules, application conditions, official announcements, or reader-risk topics, require official or reliable sources.",
    "- If Source quality summary says authorityEvidenceRequired is true and authorityEvidenceCandidates is 0, do not treat trusted blog candidates as final authority. Use them only as discovery clues.",
    "- In that case, extract agency names, program names, application channels, notice titles, dates, and PDF/notice hints from the blog candidates. If the blog includes an official link, use that source boundary; if not, return REVISION with narrow searchQueries aimed at the official/institutional website so the app can crawl it directly.",
    "- If Source quality summary says independentEvidenceRequired is true and independentEvidenceCandidates is 0, do not return PASS from blog candidates alone. Return REVISION with broad web searchQueries aimed at official pages or independent editorial coverage; do not downgrade into a vague commentary article.",
    "- For AI/technology launch, release, announcement, model, product, chip, roadmap, market, or earnings topics, Naver blog candidates are discovery clues unless official/institutional or independent editorial candidates also support the core fact.",
    "- Return BLOCK when facts are insufficient, sources conflict, the direct topic cannot be preserved, or a publishable title cannot be supported.",
    "- Do not copy source titles. Extract search flow, reader interest, repeated angles, and gaps.",
    "- Include writerContract as the compact Writer handoff. It must define the reader-facing article mission, selected title, topic thesis, reader promise, first section focus, required answers, reader coverage items, confirmed facts, safety boundaries, source boundaries, current bridge requirements, and must-not-do items.",
    "- In writerContract, keep article fields for reader value only. Put limitations, unsupported variables, source gaps, and publishing constraints into safetyBoundaries, uncertainItems, sourceBoundaries, or mustNotDo instead of turning them into coverage or section structure.",
    "- writerContract must not narrate the search process, source collection process, or verification workflow. Put process detail in searchFlowSummary or notes, not in the Writer handoff.",
    "",
    researchRevisionContext ? "Revision context from previous agent step:" : "",
    researchRevisionContext || "",
    researchRevisionContext ? "- Use this context to repair the Writer Contract and source boundaries. Do not merely repeat the previous PASS if the Writer could not support the article." : "",
    researchRevisionContext ? "" : "",
    `Search candidates already collected: ${hasSearchCandidates ? "yes" : "no"}`,
    "Search/source candidates:",
    JSON.stringify(compactSearchResultsForPrompt(searchResults, {
      maxResults: 6,
      excerptChars: 420
    }), null, 2),
    "",
    "Source quality summary:",
    JSON.stringify(sourceQuality || { status: "unknown" }, null, 2),
    "",
    "Existing titles for duplicate awareness:",
    JSON.stringify((historyTitles || []).slice(0, 80), null, 2),
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"PASS\" | \"REVISION\" | \"BLOCK\", \"failureReason\": string, \"finalTitle\": string, \"topicThesis\": string, \"topicLane\": string, \"selectedKeywordIndexes\": number[], \"selectedKeywordPhrases\": string[], \"searchQueries\": string[], \"anchorEvent\": {\"name\": string, \"date\": string, \"summary\": string}, \"currentPeg\": {\"date\": string, \"summary\": string, \"sourceIds\": string[]}, \"currentBridgeRequired\": boolean, \"currentBridgeSatisfied\": boolean, \"directTopicPreserved\": boolean, \"factBased\": boolean, \"searchNeed\": \"skip\" | \"light\" | \"normal\" | \"strict\", \"searchFlowSummary\": string, \"repeatedTopics\": string[], \"competitionGaps\": string[], \"coreQuestions\": string[], \"mustCover\": string[], \"avoidDirections\": string[], \"confirmedFacts\": string[], \"uncertainItems\": string[], \"usableSources\": [{\"sourceId\": string, \"title\": string, \"url\": string, \"reason\": string}], \"titleCandidates\": [{\"title\": string, \"reason\": string, \"risk\": string}], \"writerBrief\": string, \"writerContract\": { \"articleMission\": string, \"selectedTitle\": string, \"topicThesis\": string, \"targetReader\": string, \"readerPromise\": string, \"firstSectionFocus\": string, \"mustAnswer\": string[], \"mustCover\": string[], \"mustNotDo\": string[], \"confirmedFacts\": string[], \"uncertainItems\": string[], \"sourceBoundaries\": string[], \"safetyBoundaries\": string[], \"recommendedStructure\": string[], \"currentBridgeRequired\": boolean, \"currentBridgeSatisfied\": boolean, \"anchorEvent\": object, \"currentPeg\": object, \"tone\": string }, \"notes\": string[] }.",
    "- topicLane, selectedKeywordIndexes, selectedKeywordPhrases, and searchQueries are required in auto topic mode. searchQueries must be narrow and must not contain the full Category keyword pool.",
    "- For REVISION, searchQueries must carry the next-step research intent from the missing facts. Do not leave the app with only a broad category or keyword-lane phrase.",
    "- anchorEvent/currentPeg/currentBridgeRequired/currentBridgeSatisfied are required. Use empty strings/arrays only when no older anchorEvent exists and explain that in notes.",
    "- If status is BLOCK, keep finalTitle empty unless a safe non-publishable working title is useful, and explain failureReason concisely in Korean.",
    "- If status is PASS or REVISION, finalTitle must be a Korean Naver Blog title that is click-worthy without exaggeration.",
    "- Naver-home title judgment: act like an editor choosing one homepage card, not a template filler. The title should combine a concrete subject, a confirmed event/action/tension, and the reader curiosity created by this specific topic.",
    "- In auto topic mode, reject your own title if replacing the concrete subject/event with another item from the same keyword lane would leave the title essentially unchanged.",
    "- Build at least three titleCandidates from different editorial angles before choosing finalTitle: event-first, reader-question-first, and consequence-first. Pick the one that feels least generic and most tied to the verified topic.",
    "- A good title should fail if the named entity/event can be swapped out and the title still works for many unrelated posts. Rewrite until the title depends on the actual subject, source-backed facts, and reader promise.",
    "- Do not append a generic freshness or preparation suffix just to make the title look timely. Avoid vague guide-title cadence, keyword stuffing, and unsupported sensational words.",
    "- If Preferred tone conflicts with the default Naver-home judgment, Preferred tone wins.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildMainReviewPrompt({
  topic,
  keyword,
  category,
  topicMode = "manual",
  jobDir,
  currentDateLabel,
  researchTitleResult,
  writerResult,
  finalTitle,
  preferredTone = ""
}) {
  const resultPath = path.join(jobDir, "main-review-result.json");
  const writerContract = buildWriterContract(researchTitleResult, {
    topic,
    keyword,
    category,
    topicMode,
    currentDateLabel,
    finalTitle,
    preferredTone
  });
  return [
    "You are the Main Agent for a Korean Naver Blog automation app.",
    "This is the final review step. Do not act as a separate Review Agent.",
    "Do not rewrite the article. Judge whether it can proceed to preview/publish.",
    `Category: ${category}`,
    `Category keyword: ${keyword || "(none)"}`,
    `User direct topic: ${topic || "(none)"}`,
    `Topic mode: ${topicMode}`,
    `Current writing date: ${currentDateLabel || new Date().toISOString().slice(0, 10)}`,
    `Research/Title final title: ${finalTitle}`,
    `Preferred tone: ${preferredTone || "(agent decides)"}`,
    `Output JSON path: ${resultPath}`,
    "",
    "Writer contract used for review:",
    JSON.stringify(writerContract, null, 2),
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: main_review",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Main Agent final review scope:",
    "- You are responsible for the entire final publishability judgment, not only title/article matching.",
    "- Review the Research/Title Agent result, Writer Agent result, selected title, article body, tags, image directions/notes, facts, uncertainty, source use, and risk expressions together.",
    "- Do not trust Writer status by itself. Independently judge whether the output followed the harness principles.",
    "- Use the Writer Contract as the shared writing/review contract. Check articleMission, selectedTitle, topicThesis, readerPromise, firstSectionFocus, mustAnswer, mustCover, and mustNotDo.",
    "- Also check readerValueChecklist. A post that is safe but vague, caveat-heavy, or mostly tells readers to verify elsewhere is not publishable if it fails to answer the title promise.",
    "- Also check currentBridgeRequired, currentBridgeSatisfied, anchorEvent, and currentPeg from the Writer Contract. A current-issue article based only on an older anchorEvent must not pass.",
    "- Return REVISION if the body follows search/source/research-process flow instead of fulfilling the Writer Contract, even when the facts are technically true.",
    "",
    "Title review:",
    "- The final title must match the category and the Research/Title Agent finalTitle.",
    "- If topicMode is manual and a user direct topic exists, the final title and body must preserve that topic. Category or keyword must not replace it.",
    "- The title must include the core keyword naturally, have Naver-home clickability, avoid clickbait, and be answerable by the body.",
    "- Naver-home title review expects an editorial homepage-card title tied to the specific subject, event/action/tension, and reader promise. It must not pass only because it has a generic hook phrase.",
    "- In auto topic mode, the title must not be only a keyword-lane or category-level generalization. It needs a concrete source-backed anchor from the Research result, such as a named subject, event/action, tension, consequence, or decision point.",
    "- Return REVISION when a title could still work after swapping in many unrelated subjects from the same selected keyword lane.",
    "- Date words in the title must be source-backed story material, not decoration from Current writing date. Explicit Preferred tone wins style conflicts unless it creates clickbait, unsupported claims, or a title/body mismatch.",
    "- The body must directly answer the question or promise implied by the title.",
    "- If the title promises a guide, checklist, reason, comparison, application path, or decision help, the body must deliver that exact reader value with supported specifics. Generic warnings or broad background do not satisfy the title.",
    "",
    "Factuality review:",
    "- For fact-based topics, only confirmed facts from the Research/Title handoff and usable sources may be used.",
    "- Conditions, dates, amounts, targets, application methods, prices, schedules, official claims, statistics, and policy details must not be invented.",
    "- If a confirmation 기준일/current 기준 is needed for 접수중, 모집중, 신청 가능, 현재 운영, current availability, prices, schedules, deadlines, policy/support conditions, or official announcements but absent or misused, do not PASS.",
    "- If currentBridgeRequired is true, PASS only when currentBridgeSatisfied is true and the body explains the currentPeg as the reason the older anchorEvent matters now. If the article only retells the anchorEvent, return BLOCK or REVISION.",
    "- Facts and interpretation must be distinguishable. Uncertain items must not become definite claims.",
    "",
    "Search/source-use review:",
    "- The article must not copy search-result sentences, Naver top-post structure, source titles, or source paragraph order.",
    "- Search results may be used as signals, facts, reader-interest clues, and gap analysis only. They must not be pasted together into a new article.",
    "- If official or reliable sources are required but missing, return BLOCK.",
    "",
    "Body quality review:",
    "- The introduction must be natural, the flow must be readable, and the article must not be a mechanical list.",
    "- Unless explicit Preferred tone asks for a stricter style, return REVISION when the post reads like a stiff report, press-summary, bullet rewrite, or generic encyclopedia entry instead of a human Naver Blog explanation.",
    "- Return REVISION when the article appears to fill space with broad cautions, repeated verification reminders, or vague statements instead of giving concrete reader-facing information tied to the selected title.",
    "- Each major section must advance the title promise. It should provide at least one useful unit such as a confirmed fact, practical step, decision criterion, comparison, consequence, or supported next-check path.",
    "- If multiple sections mainly say that details are uncertain or should be checked elsewhere, the article is not reader-facing enough to PASS.",
    "- Do not reject a stylistic choice solely for differing from the default human-blog voice when explicit Preferred tone requested that style and the article remains reader-facing and accurate.",
    "- Keyword repetition must not be excessive.",
    "- [SECTION - ...] markers are intentional app markers for Naver section headings. They are allowed in the Writer Agent article field and must not be treated as exposed internal text or a body quality failure.",
    "- The article must not expose internal words such as source candidate, source quality, prompt, JSON, agent, report, handoff, or review as reader-facing text.",
    "- Return REVISION when the article speaks about its own writing choices, coverage limits, or validation posture instead of explaining the selected subject directly to the reader.",
    "- Return REVISION when confirmed facts are repeatedly framed as source-observation or writer-observation statements instead of subject-state explanations for the reader.",
    "- The first section and opening paragraph must explain the article topic itself, not how the agent verified sources. Return REVISION if the lead reads like a research report or source-verification memo.",
    "- Return REVISION if the opening explains category exclusions, defends what the article is not, or copies category publishing direction instead of starting with the selected subject and reader value.",
    "- For policy/support/recruitment/training topics, PASS only when the body gives practical reader value: target/eligibility, support details, application or checking path, variable items to verify, and cautions when supported by sources.",
    "- For policy/support/recruitment/training topics, a caution-only article is not enough. If eligibility, support details, path, or decision criteria are not sufficiently supported, return BLOCK or REVISION instead of passing a vague filler article.",
    "- The article must not pretend to have personal experience unless the user provided that experience.",
    "",
    "Risk expression review:",
    "- Reject exaggerated income claims, fear-driven claims, unsupported future certainty, and expressions like 100%, 무조건, 완전 자동, 곧 사라진다, 충격, 대박 when used as unsupported hooks.",
    "- Reader-risk information must be blocked when uncertain, especially policy, support programs, law, tax, jobs, money, prices, schedules, applications, and official announcements.",
    "",
    "Final verdict rules:",
    "- Return PASS only if every review area can be published as-is.",
    "- Return REVISION if the issue is fixable by rewriting without new research, but do not rewrite it here.",
    "- Return BLOCK if facts are insufficient, sources conflict, official/current evidence is missing, the article is unsupported, the direct topic changed, or publishing could mislead readers.",
    "",
    "Research/Title Agent result:",
    JSON.stringify(researchTitleResult || {}, null, 2),
    "",
    "Writer Agent result:",
    JSON.stringify(writerResult || {}, null, 2),
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"PASS\" | \"REVISION\" | \"BLOCK\", \"failureReason\": string, \"titleReviewPass\": boolean, \"articleAnswersTitle\": boolean, \"topicPreserved\": boolean, \"factualityPass\": boolean, \"currentBridgePass\": boolean, \"sourceUsePass\": boolean, \"bodyQualityPass\": boolean, \"riskExpressionPass\": boolean, \"writerContractPass\": boolean, \"readerFacingArticlePass\": boolean, \"noResearchProcessNarrationPass\": boolean, \"publishable\": boolean, \"issues\": string[], \"revisionInstructions\": string[], \"notes\": string[] }.",
    "- Use Korean for failureReason, issues, revisionInstructions, and notes.",
    "- If status is PASS, failureReason must be empty and every boolean review field must be true.",
    "- If status is REVISION or BLOCK, failureReason must concisely explain why it cannot be published as-is.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildWriterContractRefinementPrompt({
  jobDir,
  researchTitleResult,
  draftWriterContract,
  sourceQuality
}) {
  const resultPath = path.join(jobDir, "writer-contract-result.json");
  return [
    "You are the Main Agent contract refinement step for a Korean Naver Blog automation app.",
    "Your task is semantic classification, not article writing.",
    "Read the Research/Title result and the draft Writer Contract.",
    "Refine the Writer Contract so the Writer Agent receives a clean article brief.",
    `Output JSON path: ${resultPath}`,
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: main_review",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Semantic role rules:",
    "- Keep reader-facing article content in articleMission, readerPromise, firstSectionFocus, mustAnswer, mustCover, confirmedFacts, and recommendedStructure.",
    "- Put internal publishing limits, unsupported variables, source gaps, verification boundaries, and risk controls in safetyBoundaries, uncertainItems, sourceBoundaries, or mustNotDo.",
    "- Do not use token overlap, wording similarity, or phrase matching. Judge by meaning and field role.",
    "- Convert source-observation wording into subject-state wording before handing it to the Writer Agent.",
    "- Confirmed facts should read as what exists, where it belongs, what changes, who is affected, or what action the reader can take.",
    "- Keep verification wording only when the reader's actual task is to verify an uncertain variable or official condition.",
    "- mustCover and recommendedStructure must describe what useful subject matter the reader should learn, not what the writer should avoid saying.",
    "- safetyBoundaries are not article material. They protect the article from unsupported claims.",
    "- If the available confirmed facts cannot support a useful reader-facing article, return status failed instead of turning limitations into the article's main content.",
    "- Preserve the selected title, topic thesis, target reader, current bridge fields, and factual limits unless they are internally inconsistent.",
    "",
    "Draft Writer Contract:",
    JSON.stringify(draftWriterContract || {}, null, 2),
    "",
    "Research/Title Agent result:",
    JSON.stringify(researchTitleResult || {}, null, 2),
    "",
    "Source quality summary:",
    JSON.stringify(sourceQuality || { status: "unknown" }, null, 2),
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"success\" | \"failed\", \"failureReason\": string, \"writerContract\": { \"articleMission\": string, \"selectedTitle\": string, \"topicThesis\": string, \"targetReader\": string, \"readerPromise\": string, \"firstSectionFocus\": string, \"mustAnswer\": string[], \"mustCover\": string[], \"mustNotDo\": string[], \"confirmedFacts\": string[], \"uncertainItems\": string[], \"sourceBoundaries\": string[], \"safetyBoundaries\": string[], \"recommendedStructure\": string[], \"readerValueChecklist\": string[], \"currentBridgeRequired\": boolean, \"currentBridgeSatisfied\": boolean, \"anchorEvent\": object, \"currentPeg\": object, \"tone\": string }, \"notes\": string[] }.",
    "- If status is failed, explain why the contract cannot support a publishable reader-facing article.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildImageStylePrompt({
  jobDir,
  sampleImagePath,
  sampleImageHash = ""
}) {
  const resultPath = path.join(jobDir, "image-style-result.json");
  return [
    "You are the Image Style Agent for a Korean Naver Blog automation app.",
    "Analyze the local sample image and write a reusable image style prompt.",
    "Do not generate images. Do not write article content.",
    `Sample image path: ${sampleImagePath}`,
    `Sample image hash: ${sampleImageHash || "(unknown)"}`,
    `Output JSON path: ${resultPath}`,
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: image",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Style prompt requirements:",
    "- Describe visual style only: composition, layout, palette, lighting, texture, camera/framing, graphic treatment, typography style if visible, and overall mood.",
    "- Make it reusable for future Korean Naver Blog title thumbnails and body support images.",
    "- Do not identify private people, infer sensitive traits, or copy exact text from the sample image.",
    "- Do not include article-specific facts, dates, products, programs, or claims from the sample image.",
    "- Keep the prompt concrete enough for image generation and under 1200 Korean/English characters.",
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"success\" | \"failed\", \"failureReason\": string, \"imageStylePrompt\": string, \"notes\": string[] }.",
    "- If the image cannot be inspected, set status to \"failed\" and explain the reason concisely in Korean.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function buildImageWorkerPrompt({
  jobDir,
  runtimeRoot,
  includeTitleImage = true,
  imageAspectRatio = DEFAULT_IMAGE_ASPECT_RATIO,
  titleImageAspectRatio,
  bodyImageAspectRatio,
  maxBodyImages = 2,
  writerResult,
  finalTitle,
  accountImageStylePrompt = ""
}) {
  const resultPath = path.join(jobDir, "image-worker-result.json");
  const imageDir = path.join(runtimeRoot || path.dirname(path.dirname(jobDir)), "image");
  const selectedTitleImageAspectRatio = normalizeImageAspectRatio(titleImageAspectRatio || imageAspectRatio);
  const selectedBodyImageAspectRatio = normalizeImageAspectRatio(bodyImageAspectRatio || imageAspectRatio);
  const bodyImageLimit = Math.min(10, Math.max(0, Number.isFinite(Number(maxBodyImages)) ? Number(maxBodyImages) : 2));
  fs.mkdirSync(imageDir, { recursive: true });
  return [
    "You are the Image Worker for a Korean Naver Blog automation app.",
    "You are not a content agent. Do not rewrite the title, article, tags, facts, or structure.",
    "Generate only the requested reference images from the Writer Agent image prompts.",
    `Final title: ${finalTitle || writerResult?.title || ""}`,
    `Image output directory: ${imageDir}`,
    `Output JSON path: ${resultPath}`,
    "",
    "Progress logging:",
    "- BLOGAUTO_PROGRESS: image",
    "- BLOGAUTO_PROGRESS: save",
    "",
    "Image generation scope:",
    includeTitleImage ? "- Generate one title image when titleImagePrompt is available." : "- Do not generate a title image.",
    bodyImageLimit > 0 ? `- Generate no more than ${bodyImageLimit} body images from bodyImages[].prompt.` : "- Do not generate body images.",
    `- Requested title image aspect ratio: ${selectedTitleImageAspectRatio}.`,
    `- Requested body image aspect ratio: ${selectedBodyImageAspectRatio}.`,
    "- Generate title images in the requested title image aspect ratio and body images in the requested body image aspect ratio.",
    "- Keep each selected orientation and do not substitute a different ratio unless the image tool cannot support it.",
    "- Do not run shell, PowerShell, Node, Python, Copy-Item, cp, move, or file-copy commands for images.",
    "- Image Worker must not copy image files into the app image directory. The desktop app will copy returned image paths later.",
    "- If image generation returns a file outside the app image directory, return that original generated file path as-is.",
    "- If image generation fails or the tool is unavailable, return empty paths and put the reason in notes.",
    "- If image generation returns a concrete existing image file path ending in .png, .jpg, .jpeg, or .webp, return that path.",
    "- If the image tool responds with generated image data but without a concrete file path, do not paste base64 into the JSON. Leave paths empty and note that the generated image data is available in the Codex session; the desktop app will save it as an image file.",
    "- Use the exact sequence numbers from bodyImages[].sequence.",
    "- Paths must point to concrete .png, .jpg, .jpeg, or .webp files. Do not return a directory path.",
    "- Prefer concrete editorial blog visuals that summarize the article or nearby section. Avoid abstract decorative backgrounds.",
    accountImageStylePrompt ? "- Apply this account-specific visual style prompt unless it conflicts with factual accuracy, no-text rules, or the article context:" : "",
    accountImageStylePrompt ? accountImageStylePrompt : "",
    "",
    "Title image policy:",
    includeTitleImage ? "- The title image is the representative thumbnail for the whole article, not a generic background." : "- Title image generation is disabled.",
    includeTitleImage ? `- The title image must use aspect ratio ${selectedTitleImageAspectRatio}.` : "",
    includeTitleImage ? "- Korean text is allowed in the title image when it helps summarize the article. Use only short headline/key-point text, verified numbers, periods, benefits, or conditions from the article." : "",
    includeTitleImage ? "- Do not add long Korean paragraphs, fake official marks, unverified amounts, unverified dates, or labels that are not supported by the article." : "",
    includeTitleImage ? "- A card-style Korean blog thumbnail with a clear headline, central subject, and 2-4 visual fact cues is acceptable." : "",
    "",
    "Body image policy:",
    bodyImageLimit > 0 ? "- Body images keep the existing policy: avoid readable Korean text, paragraphs, long labels, UI copy, and text-heavy charts." : "- Body image generation is disabled.",
    bodyImageLimit > 0 ? `- Every body image must use aspect ratio ${selectedBodyImageAspectRatio}.` : "",
    bodyImageLimit > 0 ? "- Body images should visually support the nearby section with objects, scenes, icons, or process cues." : "",
    "",
    "Writer Agent image handoff:",
    JSON.stringify({
      titleImagePrompt: writerResult?.titleImagePrompt || "",
      bodyImages: Array.isArray(writerResult?.bodyImages) ? writerResult.bodyImages.slice(0, bodyImageLimit) : [],
      article: writerResult?.article || ""
    }, null, 2),
    "",
    "Required output:",
    "- Write a UTF-8 JSON file at the exact Output JSON path.",
    "- JSON shape: { \"status\": \"success\" | \"partial\" | \"failed\", \"failureReason\": string, \"titleImagePath\": string, \"bodyImages\": [{\"sequence\": number, \"path\": string, \"prompt\": string}], \"notes\": string[] }.",
    "- If no image prompt is available, return status \"failed\", empty image paths, and a concise Korean note.",
    "- If some images succeed and some fail, return status \"partial\" with successful paths and notes for failures.",
    "- Status \"success\" is allowed only when every requested image has a concrete image file path.",
    "- Print one final line after writing the file: BLOGAUTO_RESULT_READY"
  ].filter((line) => line !== "").join("\n");
}

function mergeImageWorkerResult(writerResult, imageResult, options = {}) {
  const bodyImageLimit = Math.min(10, Math.max(0, Number.isFinite(Number(options.maxBodyImages)) ? Number(options.maxBodyImages) : 2));
  const writerBodyImages = Array.isArray(writerResult?.bodyImages) ? writerResult.bodyImages : [];
  const generatedBodyImages = Array.isArray(imageResult?.bodyImages) ? imageResult.bodyImages : [];
  const mergedBodyImages = generatedBodyImages
    .filter((item) => String(item?.path || "").trim())
    .slice(0, bodyImageLimit)
    .map((item) => ({
      sequence: Number(item.sequence || 0),
      path: String(item.path || ""),
      prompt: String(item.prompt || writerBodyImages.find((writerImage) => Number(writerImage.sequence) === Number(item.sequence))?.prompt || "")
    }))
    .filter((item) => item.sequence > 0);

  const notes = [
    ...(Array.isArray(imageResult?.notes) ? imageResult.notes : [])
  ];
  if (imageResult && String(imageResult.status || "").toLowerCase() !== "success") {
    const reason = String(imageResult.failureReason || "").trim();
    notes.push(reason || "이미지 Worker가 일부 또는 전체 이미지를 생성하지 못했습니다. 이미지 삽입은 가능한 항목만 진행합니다.");
  }

  return {
    ...writerResult,
    titleImagePath: options.includeTitleImage === false ? "" : String(imageResult?.titleImagePath || ""),
    bodyImages: mergedBodyImages,
    notes
  };
}

function readAgentResult(jobDir, fileName = "agent-result.json") {
  const resultPath = path.join(jobDir, fileName);
  if (!fs.existsSync(resultPath)) {
    throw new Error(`Codex result file was not created: ${fileName}`);
  }
  const raw = fs.readFileSync(resultPath, "utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    throw new Error(`Codex Agent 결과 JSON 파싱 실패(${fileName}): ${message}`);
  }
}

function preserveAgentFile(jobDir, fromName, toName) {
  const fromPath = path.join(jobDir, fromName);
  const toPath = path.join(jobDir, toName);
  if (fs.existsSync(fromPath)) {
    fs.copyFileSync(fromPath, toPath);
  }
}

function removeAgentResultFile(jobDir, fileName) {
  const resultPath = path.join(jobDir, fileName);
  if (fs.existsSync(resultPath)) {
    fs.rmSync(resultPath, { force: true });
  }
}

function compactTextList(values) {
  return (Array.isArray(values) ? values : [values])
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function uniqueCompactTextList(values, limit = 8) {
  const seen = new Set();
  const result = [];
  for (const value of compactTextList(values)) {
    const key = value.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function firstCompactText(values, fallback = "") {
  return compactTextList(values)[0] || fallback;
}

function summarizeUsableSourcesForContract(sources, limit = 5) {
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, limit)
    .map((source) => uniqueCompactTextList([
      source?.sourceId ? `id: ${source.sourceId}` : "",
      source?.title ? `title: ${source.title}` : "",
      source?.url ? `url: ${source.url}` : "",
      source?.reason ? `use: ${source.reason}` : ""
    ], 4).join(" / "))
    .filter(Boolean);
}

function recommendedStructureForContract(researchResult = {}) {
  const factBased = Boolean(researchResult?.factBased);
  const searchNeed = String(researchResult?.searchNeed || "").toLowerCase();
  const mustCover = uniqueCompactTextList(researchResult?.mustCover, 8).join(" ");
  const title = String(researchResult?.finalTitle || researchResult?.selectedTitle || "").toLowerCase();
  const factRiskText = `${title} ${mustCover}`;
  const isReaderRiskTopic = factBased
    || searchNeed === "strict"
    || /policy|support|program|recruit|job|application|deadline|price|tax|law|grant|loan|education|training|schedule/i.test(factRiskText);

  if (isReaderRiskTopic) {
    return [
      "Open by answering the title promise from the reader's point of view.",
      "Explain the confirmed subject, current status, and who is affected.",
      "Cover eligibility/target, key details, checking or application path, variable items to verify, and cautions when the handoff supports them.",
      "Separate confirmed facts from interpretation and uncertainty.",
      "Close with what the reader should check next."
    ];
  }

  return [
    "Open by answering the title promise from the reader's point of view.",
    "Explain why this topic matters now or why readers care.",
    "Develop the main points in reader-facing sections tied to the selected title.",
    "Mention limits or uncertainty without turning the post into a research memo.",
    "Close with a concise practical takeaway."
  ];
}

function readerValueChecklistForContract(researchResult = {}) {
  const factBased = Boolean(researchResult?.factBased);
  const searchNeed = String(researchResult?.searchNeed || "").toLowerCase();
  const mustAnswerCount = uniqueCompactTextList(researchResult?.mustAnswer || researchResult?.coreQuestions, 8).length;
  const mustCoverCount = uniqueCompactTextList(researchResult?.mustCover, 10).length;
  const confirmedFactCount = uniqueCompactTextList(researchResult?.confirmedFacts, 12).length;
  const isFactRiskTopic = factBased || searchNeed === "strict";
  return [
    "Every section must answer a reader question implied by the selected title, not merely restate that the reader should verify something elsewhere.",
    "Each section should add at least one concrete reader value item: a confirmed fact, a practical step, a decision criterion, a comparison, a consequence, or a next-check path supported by the handoff.",
    "Uncertainty and source boundaries are constraints for safe writing, not the main article material. Turn necessary uncertainty into a short practical caution or fail if it dominates the article.",
    "If the supported material cannot produce several specific reader-facing sections tied to the title promise, return status failed instead of padding with broad advice or repeated caveats.",
    isFactRiskTopic
      ? "For fact-risk topics, the article must still be useful: explain what is confirmed, what the reader can do with it, and exactly which variable items to check next when supported."
      : "For explanatory topics, keep the subject, event, cause, effect, and reader takeaway visible through the whole article.",
    `Support snapshot: mustAnswer=${mustAnswerCount}, mustCover=${mustCoverCount}, confirmedFacts=${confirmedFactCount}.`
  ].filter(Boolean);
}

function buildWriterContract(researchResult = {}, context = {}) {
  const hasRefinedWriterContract = researchResult?.writerContractRefined === true;
  const finalTitle = firstCompactText([
    researchResult?.finalTitle,
    researchResult?.selectedTitle,
    context.finalTitle,
    context.topic
  ]);
  const topicThesis = firstCompactText([
    researchResult?.topicThesis,
    researchResult?.writerBrief,
    context.topic,
    finalTitle
  ], finalTitle);
  const coreQuestions = uniqueCompactTextList(researchResult?.coreQuestions, 8);
  const mustCover = uniqueCompactTextList(researchResult?.mustCover, 10);
  const confirmedFacts = uniqueCompactTextList(researchResult?.confirmedFacts, 12);
  const uncertainItems = uniqueCompactTextList(researchResult?.uncertainItems, 8);
  const avoidDirections = uniqueCompactTextList(researchResult?.avoidDirections, 10);
  const anchorEvent = {
    name: firstCompactText([
      researchResult?.writerContract?.anchorEvent?.name,
      researchResult?.anchorEvent?.name
    ]),
    date: firstCompactText([
      researchResult?.writerContract?.anchorEvent?.date,
      researchResult?.anchorEvent?.date
    ]),
    summary: firstCompactText([
      researchResult?.writerContract?.anchorEvent?.summary,
      researchResult?.anchorEvent?.summary
    ])
  };
  const currentPeg = {
    date: firstCompactText([
      researchResult?.writerContract?.currentPeg?.date,
      researchResult?.currentPeg?.date
    ]),
    summary: firstCompactText([
      researchResult?.writerContract?.currentPeg?.summary,
      researchResult?.currentPeg?.summary
    ]),
    sourceIds: uniqueCompactTextList([
      researchResult?.writerContract?.currentPeg?.sourceIds,
      researchResult?.currentPeg?.sourceIds
    ], 6)
  };
  const currentBridgeRequired = researchResult?.writerContract?.currentBridgeRequired === true
    || researchResult?.currentBridgeRequired === true;
  const currentBridgeSatisfied = researchResult?.writerContract?.currentBridgeSatisfied === true
    || researchResult?.currentBridgeSatisfied === true;

  return {
    articleMission: firstCompactText([
      researchResult?.writerContract?.articleMission,
      topicThesis,
      finalTitle
    ], "Write the selected article promised by the final title."),
    selectedTitle: finalTitle,
    topicThesis,
    targetReader: firstCompactText([
      researchResult?.writerContract?.targetReader,
      researchResult?.targetReader
    ], "Readers who need to understand this selected topic and decide what to check next."),
    readerPromise: firstCompactText([
      researchResult?.writerContract?.readerPromise,
      coreQuestions.length ? coreQuestions.join(" / ") : "",
      researchResult?.writerBrief
    ], "Answer the selected title directly with useful reader-facing context."),
    firstSectionFocus: firstCompactText([
      researchResult?.writerContract?.firstSectionFocus
    ], "Start with the topic promised by the title from the reader's point of view. Do not begin with source collection, search flow, or verification-process narration."),
    mustAnswer: uniqueCompactTextList([
      researchResult?.writerContract?.mustAnswer,
      hasRefinedWriterContract ? [] : coreQuestions
    ], 8),
    mustCover: uniqueCompactTextList([
      researchResult?.writerContract?.mustCover,
      hasRefinedWriterContract ? [] : mustCover
    ], 12),
    mustNotDo: uniqueCompactTextList([
      researchResult?.writerContract?.mustNotDo,
      avoidDirections,
      "Do not create a new topic or change the selected title.",
      "Do not narrate the agent's search, source collection, or verification workflow as article content.",
      "Do not turn the opening section into a source report.",
      "Do not use category direction or keywords to broaden the article away from the selected title.",
      "Do not copy category publishing direction into the article body.",
      "Do not open by explaining what the article is not. Start with the selected subject and the reader value directly."
    ], 12),
    confirmedFacts: uniqueCompactTextList([
      researchResult?.writerContract?.confirmedFacts,
      confirmedFacts
    ], 12),
    uncertainItems: uniqueCompactTextList([
      researchResult?.writerContract?.uncertainItems,
      uncertainItems
    ], 8),
    sourceBoundaries: uniqueCompactTextList([
      researchResult?.writerContract?.sourceBoundaries,
      summarizeUsableSourcesForContract(researchResult?.usableSources)
    ], 8),
    safetyBoundaries: uniqueCompactTextList([
      researchResult?.writerContract?.safetyBoundaries,
      uncertainItems,
      researchResult?.writerContract?.sourceBoundaries,
      summarizeUsableSourcesForContract(researchResult?.usableSources)
    ], 12),
    recommendedStructure: uniqueCompactTextList([
      researchResult?.writerContract?.recommendedStructure,
      hasRefinedWriterContract ? [] : recommendedStructureForContract(researchResult)
    ], 8),
    readerValueChecklist: uniqueCompactTextList([
      researchResult?.writerContract?.readerValueChecklist,
      readerValueChecklistForContract(researchResult)
    ], 8),
    currentBridgeRequired,
    currentBridgeSatisfied,
    anchorEvent,
    currentPeg,
    tone: firstCompactText([
      context.preferredTone,
      researchResult?.writerContract?.tone
    ], "Korean Naver Blog editorial tone; human, reader-facing, practical, clear, and non-clickbait.")
  };
}

function summarizeAgentReason(values, fallback, maxLength = 700) {
  const text = compactTextList(values)
    .map((value) => stripAnsi(value).replace(/\s+/g, " ").trim())
    .filter((value) => value && !looksLikeMojibake(value))
    .join(" / ")
    .trim();
  return (text || fallback).slice(0, maxLength);
}

function researchRevisionReason(researchResult) {
  return summarizeAgentReason([
    researchResult?.failureReason,
    researchResult?.notes,
    researchResult?.uncertainItems
  ], "Research/Title Agent가 본문 작성 전 추가 확인이 필요하다고 판단했습니다.");
}

function currentBridgeIssueReason(researchResult) {
  if (researchResult?.currentBridgeRequired !== true) return "";
  if (researchResult?.currentBridgeSatisfied === true) return "";
  return summarizeAgentReason([
    researchResult?.failureReason,
    researchResult?.currentPeg?.summary,
    researchResult?.uncertainItems,
    researchResult?.notes
  ], "과거 anchorEvent를 현재 이슈로 다루려면 현재 진행 상황이나 최근 변화(currentPeg)가 확인되어야 합니다.");
}

function isResearchSourceFailure(researchResult) {
  const searchNeed = String(researchResult?.searchNeed || "").toLowerCase();
  if (!["light", "normal", "strict"].includes(searchNeed)) return false;

  const status = String(researchResult?.status || "").toUpperCase();
  const text = compactTextList([
    researchResult?.failureReason,
    researchResult?.searchFlowSummary,
    researchResult?.coreQuestions,
    researchResult?.mustCover,
    researchResult?.confirmedFacts,
    researchResult?.uncertainItems,
    researchResult?.usableSources,
    researchResult?.writerBrief,
    researchResult?.writerContract?.sourceBoundaries,
    researchResult?.notes
  ]).join(" / ");

  if (!text) return status === "REVISION";
  return /근거|자료|출처|발췌|검색\s*후보|공식|지도|네이버지도|카카오맵|확인.*부족|부족.*확인|관련되지|관련성이\s*없|직접\s*관련|source|insufficient|unsupported|cannot\s+support|not\s+enough|official|map/i.test(text);
}

function isAuthoritySourceQualityFailure(sourceQuality) {
  return sourceQuality?.status === "insufficient"
    && sourceQuality?.authorityEvidenceRequired === true
    && Number(sourceQuality?.authorityEvidenceCandidates || 0) === 0;
}

function authoritySourceQualityIssueReason(sourceQuality) {
  if (!isAuthoritySourceQualityFailure(sourceQuality)) return "";
  return sourceQuality.reason
    || "블로그 후보는 주제 단서로 확인되었지만 공식/기관 근거가 부족합니다. 공식 원문 보강 검색이 필요합니다.";
}

function writerOutputIssueReason(writerResult) {
  const writerStatus = String(writerResult?.status || "").toLowerCase();
  const writerReason = summarizeAgentReason([
    writerResult?.failureReason,
    writerResult?.notes,
    writerResult?.revisionInstructions
  ], "Writer Agent가 본문 작성에 실패했습니다.");

  if (writerStatus === "failed") return writerReason;
  if (!writerStatus) return "Writer Agent 상태값이 비어 있습니다.";
  if (writerStatus !== "success") return `Writer Agent 상태값이 유효하지 않습니다: ${writerStatus}`;
  if (!String(writerResult?.article || "").trim()) {
    return "Writer Agent가 본문(article)을 비워 반환했습니다.";
  }
  if (!Array.isArray(writerResult?.tags) || writerResult.tags.filter(Boolean).length === 0) {
    return "Writer Agent가 태그(tags)를 반환하지 않았습니다.";
  }
  return "";
}

function isSourceInsufficientWriterIssue(reason, writerResult, researchResult) {
  const text = compactTextList([
    reason,
    writerResult?.failureReason,
    writerResult?.notes,
    researchResult?.failureReason,
    researchResult?.notes,
    researchResult?.uncertainItems
  ]).join(" / ");
  if (String(researchResult?.status || "").toUpperCase() === "REVISION") return true;
  return /근거|자료|출처|발췌|검색\s*후보|공식|확인.*부족|부족.*확인|관련되지|관련성이\s*없|직접\s*관련|source|insufficient|unsupported|cannot\s+support/i.test(text);
}

function retryableWriterFailureReason(writerResult, researchResult) {
  const issueReason = writerOutputIssueReason(writerResult);
  if (!issueReason) return "";
  if (isSourceInsufficientWriterIssue(issueReason, writerResult, researchResult)) {
    return "";
  }
  return issueReason;
}

function revisionFeedbackFrom(mainReviewResult, writerResult) {
  return compactTextList([
    mainReviewResult?.failureReason,
    mainReviewResult?.revisionInstructions,
    mainReviewResult?.issues,
    mainReviewResult?.notes,
    writerResult?.failureReason,
    writerResult?.notes
  ]).join(" / ").slice(0, 4000);
}

function mainReviewPassIssueReason(mainReviewResult) {
  if (String(mainReviewResult?.status || "").toUpperCase() !== "PASS") return "";
  const requiredTrueFields = [
    ["titleReviewPass", "title review"],
    ["articleAnswersTitle", "article answers title"],
    ["topicPreserved", "topic preserved"],
    ["factualityPass", "factuality"],
    ["currentBridgePass", "current bridge"],
    ["sourceUsePass", "source use"],
    ["bodyQualityPass", "body quality"],
    ["riskExpressionPass", "risk expressions"],
    ["writerContractPass", "writer contract"],
    ["readerFacingArticlePass", "reader-facing article"],
    ["noResearchProcessNarrationPass", "no research-process narration"],
    ["publishable", "publishable"]
  ];
  const failedFields = requiredTrueFields
    .filter(([field]) => mainReviewResult?.[field] !== true)
    .map(([, label]) => label);
  if (failedFields.length) {
    return `Main Agent returned PASS but required review checks failed: ${failedFields.join(", ")}`;
  }
  const failureReason = String(mainReviewResult?.failureReason || "").trim();
  if (failureReason) {
    return `Main Agent returned PASS with a failure reason: ${failureReason}`;
  }
  return "";
}

async function runCodexTask({
  options,
  prompt,
  promptFileName,
  resultFileName,
  log = () => {},
  tokenOffset = 0,
  grossTokenOffset = 0,
  agentTokenOffset = 0,
  agent = "main"
}) {
  fs.writeFileSync(path.join(options.jobDir, promptFileName), prompt, "utf8");
  removeAgentResultFile(options.jobDir, resultFileName);
  const outputState = { section: "meta" };
  const tokenState = {
    awaitingValue: false,
    total: 0,
    grossTotal: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    lastTotal: 0,
    lastInputTokens: 0,
    lastCachedInputTokens: 0,
    lastOutputTokens: 0,
    rateLimits: null
  };
  let taskEffort = modelEffortForAgent(options, agent);
  let finalTokenUsageLogged = false;
  let taskStartedAt = Date.now();

  const recoverTokenUsageFromSession = () => {
    if (tokenState.total > 0 && tokenState.rateLimits) return;
    const recovered = readLatestCodexTokenUsageFromSessions({
      sinceMs: taskStartedAt,
      jobDir: options.jobDir,
      resultFileName
    });
    if (!recovered?.tokenUsage) return;
    const recoveredTotal = Number(recovered.tokenUsage.total || 0);
    if (recoveredTotal > 0 && tokenState.total <= 0) {
      Object.assign(tokenState, {
        total: recoveredTotal,
        grossTotal: Number(recovered.tokenUsage.grossTotal || recoveredTotal || 0),
        inputTokens: Number(recovered.tokenUsage.inputTokens || 0),
        cachedInputTokens: Number(recovered.tokenUsage.cachedInputTokens || 0),
        outputTokens: Number(recovered.tokenUsage.outputTokens || 0),
        lastTotal: Number(recovered.tokenUsage.lastTotal || 0),
        lastInputTokens: Number(recovered.tokenUsage.lastInputTokens || 0),
        lastCachedInputTokens: Number(recovered.tokenUsage.lastCachedInputTokens || 0),
        lastOutputTokens: Number(recovered.tokenUsage.lastOutputTokens || 0)
      });
    }
    if (!tokenState.rateLimits && recovered.tokenUsage.rateLimits) {
      tokenState.rateLimits = recovered.tokenUsage.rateLimits;
    }
  };

  const reportTokenUsage = ({ final = false } = {}) => {
    const taskTokens = Number(tokenState.total || 0);
    const taskGrossTokens = Number(tokenState.grossTotal || taskTokens || 0);
    const cumulativeTokens = tokenOffset + taskTokens;
    const cumulativeGrossTokens = grossTokenOffset + taskGrossTokens;
    const agentCumulativeTokens = agentTokenOffset + taskTokens;
    if (typeof options.onTokenUsage === "function") {
      options.onTokenUsage({
        total: cumulativeTokens,
        grossTotal: cumulativeGrossTokens,
        inputTokens: Number(tokenState.inputTokens || 0),
        cachedInputTokens: Number(tokenState.cachedInputTokens || 0),
        outputTokens: Number(tokenState.outputTokens || 0),
        lastTotal: Number(tokenState.lastTotal || 0),
        rateLimits: tokenState.rateLimits,
        agent,
        agentTotal: agentCumulativeTokens,
        agentDelta: taskTokens,
        agentGrossDelta: taskGrossTokens,
        final: Boolean(final)
      });
    }
    if (final && taskTokens > 0 && !finalTokenUsageLogged) {
      finalTokenUsageLogged = true;
      log(`${agentDisplayName(agent)} 토큰 사용량: ${agentCumulativeTokens.toLocaleString()} tokens`, "info", agent);
    }
  };

  const handleOutputLine = (line, level = "info") => {
    const text = stripAnsi(line).trim();
    if (!text) return;

    const parsedJson = tryParseJsonLine(text);
    if (parsedJson) {
      const parsedRateLimits = jsonRateLimits(parsedJson);
      if (parsedRateLimits) {
        tokenState.rateLimits = parsedRateLimits;
      }
      const parsedUsage = jsonTokenUsage(parsedJson);
      if (parsedUsage || parsedRateLimits) {
        if (parsedUsage) {
          Object.assign(tokenState, {
            total: Number(parsedUsage.total || 0),
            grossTotal: Number(parsedUsage.grossTotal || parsedUsage.total || 0),
            inputTokens: Number(parsedUsage.inputTokens || 0),
            cachedInputTokens: Number(parsedUsage.cachedInputTokens || 0),
            outputTokens: Number(parsedUsage.outputTokens || 0),
            lastTotal: Number(parsedUsage.lastTotal || 0),
            lastInputTokens: Number(parsedUsage.lastInputTokens || 0),
            lastCachedInputTokens: Number(parsedUsage.lastCachedInputTokens || 0),
            lastOutputTokens: Number(parsedUsage.lastOutputTokens || 0)
          });
        }
        reportTokenUsage();
      }
      for (const assistantText of extractAssistantOutputTexts(parsedJson)) {
        String(assistantText || "")
          .split(/\r?\n/)
          .forEach((nestedLine) => {
            const assistantProgress = parseProgressLine(nestedLine, options);
            if (assistantProgress) {
              log(`Codex 단계: ${assistantProgress}`, "info", agent);
            }
          });
      }
      return;
    }

    const progress = parseProgressLine(text, options);
    if (progress) {
      log(`Codex 단계: ${progress}`, "info", agent);
      return;
    }

    const parsedTokens = parseTokenLine(text, tokenState);
    if (parsedTokens !== null) {
      tokenState.total = parsedTokens;
      tokenState.grossTotal = parsedTokens;
      reportTokenUsage();
      return;
    }

    if (/^user$/i.test(text)) {
      outputState.section = "user";
      return;
    }
    if (/^assistant$/i.test(text)) {
      outputState.section = "assistant";
      return;
    }
    if (outputState.section === "user") {
      return;
    }
    if (outputState.section === "assistant") {
      return;
    }
    if (shouldForwardRawCodexOutput(options) && isUsefulCodexFeedback(text) && !shouldSuppressWriterFeedback(agent, level)) {
      log(text, level, agent);
    }
  };

  const executeCodex = () => new Promise((resolve, reject) => {
    const child = spawn(options.codexCmdPath, [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      `model_reasoning_effort=${taskEffort}`,
      "-"
    ], {
      cwd: options.jobDir,
      windowsHide: false,
      shell: process.platform === "win32"
    });

    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    const streamBuffers = { info: "", warn: "" };
    const processOutputLine = (line, level = "info") => {
      if (settled) return;
      const limitSignal = detectCodexUsageLimitSignal(line);
      if (limitSignal) {
        const parsedLimitJson = tryParseJsonLine(stripAnsi(line).trim());
        const limitRateLimits = parsedLimitJson ? jsonRateLimits(parsedLimitJson) : null;
        if (limitRateLimits) {
          tokenState.rateLimits = limitRateLimits;
          reportTokenUsage();
        }
        const limitError = createCodexUsageLimitError(limitSignal.type, limitSignal.detail);
        log(limitError.message, "error", agent);
        child.kill();
        settle(limitError);
        return;
      }
      handleOutputLine(line, level);
    };

    const handleChunk = (chunk, level = "info") => {
      const key = level === "warn" ? "warn" : "info";
      streamBuffers[key] += String(chunk);
      const lines = streamBuffers[key].split(/\r?\n/);
      streamBuffers[key] = lines.pop() || "";
      for (const line of lines) {
        processOutputLine(line, level);
      }
    };

    const flushStreamBuffers = () => {
      for (const [key, buffered] of Object.entries(streamBuffers)) {
        if (!buffered) continue;
        streamBuffers[key] = "";
        processOutputLine(buffered, key === "warn" ? "warn" : "info");
      }
    };

    child.stdout.on("data", (chunk) => handleChunk(chunk));
    child.stderr.on("data", (chunk) => handleChunk(chunk, "warn"));
    child.stdin.end(prompt);
    child.on("error", (error) => settle(new Error(`codex.cmd 실행 실패: ${error.message}`)));
    child.on("close", (code) => {
      flushStreamBuffers();
      if (code === 0) settle();
      else settle(new Error(`codex.cmd가 종료 코드 ${code}로 실패했습니다.`));
    });
  });

  try {
    taskStartedAt = Date.now();
    await executeCodex();
  } catch (error) {
    if (isCodexUsageLimitError(error)) {
      throw error;
    }
    if (taskEffort !== "xhigh") {
      throw error;
    }
    log("xhigh 호출이 실패하여 high로 낮춰 다시 실행합니다.", "warn", agent);
    taskEffort = "high";
    tokenState.awaitingValue = false;
    tokenState.total = 0;
    tokenState.grossTotal = 0;
    tokenState.inputTokens = 0;
    tokenState.cachedInputTokens = 0;
    tokenState.outputTokens = 0;
    tokenState.lastTotal = 0;
    tokenState.lastInputTokens = 0;
    tokenState.lastCachedInputTokens = 0;
    tokenState.lastOutputTokens = 0;
    tokenState.rateLimits = null;
    finalTokenUsageLogged = false;
    removeAgentResultFile(options.jobDir, resultFileName);
    taskStartedAt = Date.now();
    await executeCodex();
  }
  recoverTokenUsageFromSession();
  reportTokenUsage({ final: true });

  return {
    ...readAgentResult(options.jobDir, resultFileName),
    tokenUsage: {
      total: tokenState.total,
      grossTotal: tokenState.grossTotal,
      inputTokens: tokenState.inputTokens,
      cachedInputTokens: tokenState.cachedInputTokens,
      outputTokens: tokenState.outputTokens,
      lastTotal: tokenState.lastTotal,
      lastInputTokens: tokenState.lastInputTokens,
      lastCachedInputTokens: tokenState.lastCachedInputTokens,
      lastOutputTokens: tokenState.lastOutputTokens,
      rateLimits: tokenState.rateLimits
    }
  };
}

async function fetchCodexUsageSnapshot({
  codexCmdPath = "codex.cmd",
  cwd = process.cwd(),
  timeoutMs = 30000
} = {}) {
  const sessionSnapshot = readLatestCodexRateLimitsFromSessions();
  if (sessionSnapshot?.rateLimits) {
    return sessionSnapshot;
  }

  return new Promise((resolve) => {
    const child = spawn(codexCmdPath, [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "-c",
      "model_reasoning_effort=low",
      "-"
    ], {
      cwd,
      windowsHide: true,
      shell: process.platform === "win32"
    });

    let settled = false;
    let latestRateLimits = null;
    let latestTokens = 0;
    let timer = null;
    const finish = (unavailableReason = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!child.killed) {
        child.kill();
      }
      const fallbackSnapshot = readLatestCodexRateLimitsFromSessions();
      if (!latestRateLimits && fallbackSnapshot?.rateLimits) {
        resolve(fallbackSnapshot);
        return;
      }
      if (unavailableReason) {
        resolve({
          source: "unavailable",
          unavailableReason,
          tokenUsage: {
            total: latestTokens,
            rateLimits: null
          },
          rateLimits: null
        });
        return;
      }
      resolve({
        source: "codex-exec",
        tokenUsage: {
          total: latestTokens,
          rateLimits: latestRateLimits
        },
        rateLimits: latestRateLimits
      });
    };
    timer = setTimeout(() => {
      if (latestRateLimits) {
        finish();
      } else {
        finish("Codex 사용량 정보를 제한 시간 안에 읽지 못했습니다.");
      }
    }, timeoutMs);

    const handleChunk = (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .forEach((line) => {
          if (settled) return;
          const text = stripAnsi(line).trim();
          if (!text) return;
          const parsed = tryParseJsonLine(text);
          if (!parsed) return;
          const parsedTokens = jsonTokenTotal(parsed);
          if (parsedTokens !== null) {
            latestTokens = parsedTokens;
          }
          const parsedRateLimits = jsonRateLimits(parsed);
          if (parsedRateLimits) {
            latestRateLimits = parsedRateLimits;
            finish();
          }
        });
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);
    child.on("error", (error) => finish(`codex.cmd 사용량 확인 실패: ${error.message}`));
    child.on("close", (code) => {
      if (settled) return;
      if (latestRateLimits) {
        finish();
      } else {
        const reason = code === 0
          ? "codex.cmd 사용량 조회는 정상 종료됐지만 rate_limits가 포함되지 않아 배지를 갱신하지 못했습니다."
          : `codex.cmd 사용량 조회가 종료 코드 ${code}로 끝났고 rate_limits가 포함되지 않아 배지를 갱신하지 못했습니다.`;
        finish(reason);
      }
    });
    child.stdin.end("Return exactly OK.");
  });
}

async function runCodexGeneration(options, log = () => {}) {
  let effectiveOptions = {
    ...options,
    agentModels: normalizeAgentModels(options.agentModels),
    searchResults: Array.isArray(options.searchResults) ? options.searchResults : [],
    sourceQuality: options.sourceQuality || { status: "not_requested" }
  };
  const agentTokenTotals = {
    main: 0,
    research: 0,
    writer: 0,
    image: 0,
    imageStyle: 0
  };
  const agentGrossTokenTotals = {
    main: 0,
    research: 0,
    writer: 0,
    image: 0,
    imageStyle: 0
  };
  let totalTokens = 0;
  let totalGrossTokens = 0;
  let latestRateLimits = null;
  const rememberRateLimits = (result) => {
    if (result?.tokenUsage?.rateLimits) {
      latestRateLimits = result.tokenUsage.rateLimits;
    }
  };
  const tokenUsageSnapshot = () => ({
    total: totalTokens,
    grossTotal: totalGrossTokens,
    rateLimits: latestRateLimits,
    agents: { ...agentTokenTotals },
    grossAgents: { ...agentGrossTokenTotals }
  });

  const accountImageStyle = effectiveOptions.accountImageStyle || {};
  const sampleImagePath = String(accountImageStyle.sampleImagePath || "").trim();
  let accountImageStylePrompt = sampleImagePath ? String(accountImageStyle.imageStylePrompt || "").trim() : "";
  const sampleImageHash = String(accountImageStyle.sampleImageHash || "").trim();
  const sourceHash = String(accountImageStyle.imageStylePromptSourceImageHash || "").trim();
  const styleStatus = String(accountImageStyle.imageStylePromptStatus || "").trim();
  const needsStylePrompt = sampleImagePath
    && (!accountImageStylePrompt || styleStatus === "missing" || styleStatus === "stale" || styleStatus === "failed" || (sourceHash && sampleImageHash && sourceHash !== sampleImageHash));
  if (needsStylePrompt) {
    log("Image Style Agent sample image analysis start", "info", "imageStyle");
    const styleResult = await runCodexTask({
      options: effectiveOptions,
      prompt: buildImageStylePrompt({
        jobDir: effectiveOptions.jobDir,
        sampleImagePath,
        sampleImageHash
      }),
      promptFileName: "image-style-prompt.txt",
      resultFileName: "image-style-result.json",
      log,
      tokenOffset: totalTokens,
      grossTokenOffset: totalGrossTokens,
      agentTokenOffset: agentTokenTotals.imageStyle,
      agent: "imageStyle"
    });
    totalTokens += Number(styleResult.tokenUsage?.total || 0);
    totalGrossTokens += Number(styleResult.tokenUsage?.grossTotal || styleResult.tokenUsage?.total || 0);
    agentTokenTotals.imageStyle += Number(styleResult.tokenUsage?.total || 0);
    agentGrossTokenTotals.imageStyle += Number(styleResult.tokenUsage?.grossTotal || styleResult.tokenUsage?.total || 0);
    rememberRateLimits(styleResult);
    const generatedStylePrompt = String(styleResult.imageStylePrompt || "").trim();
    if (String(styleResult.status || "").toLowerCase() === "success" && generatedStylePrompt) {
      accountImageStylePrompt = generatedStylePrompt;
      log("Image Style Agent sample image analysis complete", "info", "imageStyle");
      if (typeof options.onAccountImageStylePrompt === "function") {
        options.onAccountImageStylePrompt({
          status: "success",
          imageStylePrompt: accountImageStylePrompt,
          sampleImageHash
        });
      }
    } else {
      const failureReason = String(styleResult.failureReason || "Image style prompt generation failed.").trim();
      accountImageStylePrompt = "";
      log(`Image Style Agent failed: ${failureReason}`, "warn", "imageStyle");
      if (typeof options.onAccountImageStylePrompt === "function") {
        options.onAccountImageStylePrompt({
          status: "failed",
          imageStylePrompt: "",
          sampleImageHash,
          failureReason
        });
      }
    }
  }
  effectiveOptions = {
    ...effectiveOptions,
    accountImageStylePrompt
  };

  let researchResult = await runCodexTask({
    options: effectiveOptions,
    prompt: buildResearchTitlePrompt(effectiveOptions),
    promptFileName: "research-title-prompt.txt",
    resultFileName: "research-title-result.json",
    log,
    agent: "research"
  });

  totalTokens += Number(researchResult.tokenUsage?.total || 0);
  totalGrossTokens += Number(researchResult.tokenUsage?.grossTotal || researchResult.tokenUsage?.total || 0);
  agentTokenTotals.research += Number(researchResult.tokenUsage?.total || 0);
  agentGrossTokenTotals.research += Number(researchResult.tokenUsage?.grossTotal || researchResult.tokenUsage?.total || 0);
  rememberRateLimits(researchResult);
  log(`Research/Title Agent 분석 완료: ${String(researchResult.status || "UNKNOWN").toUpperCase()}`, "info", "research");
  if (typeof options.onResearchTitle === "function") {
    options.onResearchTitle(researchResult);
  }

  let researchStatus = String(researchResult.status || "").toUpperCase();
  let requestedSearchNeed = String(researchResult.searchNeed || "").toLowerCase();
  const validSearchNeeds = new Set(["skip", "light", "normal", "strict"]);
  let needsSearch = ["light", "normal", "strict"].includes(requestedSearchNeed);
  const maxResearchSearchRounds = 2;
  let researchSearchRound = 0;
  while (
    needsSearch
    && typeof options.onSearchNeeded === "function"
    && researchSearchRound < maxResearchSearchRounds
    && (
      effectiveOptions.searchResults.length === 0
      || (
        ["REVISION", "BLOCK"].includes(researchStatus)
        && isResearchSourceFailure(researchResult)
      )
      || isAuthoritySourceQualityFailure(effectiveOptions.sourceQuality)
    )
  ) {
    researchSearchRound += 1;
    const searchRoundLabel = researchSearchRound === 1
      ? `Research/Title Agent 검색 필요 판단: ${requestedSearchNeed}`
      : `Research/Title Agent 근거 부족으로 보강 재검색 (${researchSearchRound}/${maxResearchSearchRounds}): ${requestedSearchNeed}`;
    log(searchRoundLabel, "info", "research");
    preserveAgentFile(
      options.jobDir,
      "research-title-prompt.txt",
      researchSearchRound === 1 ? "research-title-initial-prompt.txt" : `research-title-before-search-${researchSearchRound}.txt`
    );
    preserveAgentFile(
      options.jobDir,
      "research-title-result.json",
      researchSearchRound === 1 ? "research-title-initial-result.json" : `research-title-before-search-${researchSearchRound}.json`
    );
    const searchPayload = await options.onSearchNeeded(researchResult, {
      round: researchSearchRound,
      previousSearchResults: effectiveOptions.searchResults,
      sourceQuality: effectiveOptions.sourceQuality
    });
    effectiveOptions = {
      ...effectiveOptions,
      searchResults: Array.isArray(searchPayload?.searchResults) ? searchPayload.searchResults : [],
      sourceQuality: searchPayload?.sourceQuality || { status: "unknown" }
    };
    try {
      researchResult = await runCodexTask({
        options: effectiveOptions,
        prompt: buildResearchTitlePrompt(effectiveOptions),
        promptFileName: researchSearchRound === 1 ? "research-title-prompt.txt" : `research-title-search-${researchSearchRound}-prompt.txt`,
        resultFileName: "research-title-result.json",
        log,
        tokenOffset: totalTokens,
        grossTokenOffset: totalGrossTokens,
        agentTokenOffset: agentTokenTotals.research,
        agent: "research"
      });
      if (researchSearchRound > 1) {
        preserveAgentFile(
          options.jobDir,
          "research-title-result.json",
          `research-title-search-${researchSearchRound}-result.json`
        );
      }
    } catch (error) {
      if (!isMissingCodexResultFileError(error)) {
        throw error;
      }
      const reason = compactTextList([
        "추가 검색 후 Research/Title Agent가 결과 파일을 생성하지 못했습니다.",
        effectiveOptions.sourceQuality?.reason,
        researchResult?.failureReason
      ]).join(" / ");
      log(reason, "warn", "research");
      researchResult = {
        ...researchResult,
        status: researchStatus || researchResult?.status || "BLOCK",
        failureReason: researchResult?.failureReason || reason,
        notes: compactTextList([researchResult?.notes, reason])
      };
      break;
    }
    totalTokens += Number(researchResult.tokenUsage?.total || 0);
    totalGrossTokens += Number(researchResult.tokenUsage?.grossTotal || researchResult.tokenUsage?.total || 0);
    agentTokenTotals.research += Number(researchResult.tokenUsage?.total || 0);
    agentGrossTokenTotals.research += Number(researchResult.tokenUsage?.grossTotal || researchResult.tokenUsage?.total || 0);
    rememberRateLimits(researchResult);
    log(`Research/Title Agent 재분석 완료: ${String(researchResult.status || "UNKNOWN").toUpperCase()}`, "info", "research");
    if (typeof options.onResearchTitle === "function") {
      options.onResearchTitle(researchResult);
    }
    researchStatus = String(researchResult.status || "").toUpperCase();
    requestedSearchNeed = String(researchResult.searchNeed || "").toLowerCase();
    needsSearch = ["light", "normal", "strict"].includes(requestedSearchNeed);
  }

  const authoritySourceIssue = authoritySourceQualityIssueReason(effectiveOptions.sourceQuality);
  if (authoritySourceIssue) {
    log(`Research/Title Agent 공식 근거 보강 실패: ${authoritySourceIssue}`, "warn", "research");
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: authoritySourceIssue,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: compactTextList([authoritySourceIssue, researchResult.notes]),
      researchTitleResult: {
        ...researchResult,
        status: researchStatus === "PASS" ? "REVISION" : researchResult.status,
        failureReason: researchResult.failureReason || authoritySourceIssue
      },
      tokenUsage: tokenUsageSnapshot()
    };
  }

  if (!validSearchNeeds.has(requestedSearchNeed)) {
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: "Research/Title Agent가 검색 필요 수준을 명확히 판단하지 못했습니다.",
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: Array.isArray(researchResult.notes) ? researchResult.notes : [],
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  if (needsSearch && effectiveOptions.searchResults.length === 0) {
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: "Research/Title Agent가 검색이 필요하다고 판단했지만 사용할 수 있는 검색 후보가 확보되지 않았습니다.",
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: Array.isArray(researchResult.notes) ? researchResult.notes : [],
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  if (requestedSearchNeed === "skip" && effectiveOptions.searchResults.length === 0) {
    effectiveOptions = {
      ...effectiveOptions,
      sourceQuality: {
        status: "skipped",
        reason: "Research/Title Agent가 외부 검색 없이 진행 가능하다고 판단했습니다."
      }
    };
  }

  if (researchStatus === "BLOCK" || String(researchResult.status || "").toLowerCase() === "failed") {
    const researchReason = researchResult.failureReason || "Research/Title Agent가 본문 작성 가능한 제목을 만들지 못했습니다.";
    log(`Research/Title Agent 중단: ${researchReason}`, "warn", "research");
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: researchReason,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: Array.isArray(researchResult.notes) ? researchResult.notes : [],
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  if (researchStatus === "REVISION") {
    const researchReason = researchRevisionReason(researchResult);
    log(`Research/Title Agent가 본문 작성 가능 상태가 아닙니다: ${researchReason}`, "warn", "research");
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: researchReason,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: compactTextList([researchReason, researchResult.notes]),
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  const currentBridgeIssue = currentBridgeIssueReason(researchResult);
  if (currentBridgeIssue) {
    log(`Research/Title Agent ?꾩옱???뚯쓣 ?뺤씤?섏? 紐삵뻽?듬땲?? ${currentBridgeIssue}`, "warn", "research");
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: currentBridgeIssue,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: compactTextList([currentBridgeIssue, researchResult.notes]),
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  let finalTitle = String(researchResult.finalTitle || "").trim();
  if (!finalTitle) {
    return {
      status: "failed",
      failurePhase: "research",
      failureReason: "Research/Title Agent가 최종 제목을 확정하지 못했습니다.",
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: Array.isArray(researchResult.notes) ? researchResult.notes : [],
      researchTitleResult: researchResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  const refineWriterContract = async (promptFileName = "writer-contract-prompt.txt") => {
    const draftWriterContract = buildWriterContract(researchResult, {
      topic: finalTitle || effectiveOptions.topic,
      finalTitle,
      preferredTone: effectiveOptions.preferredTone || ""
    });
    log("Main Agent Writer Contract 의미 정리 시작", "info", "main");
    const contractResult = await runCodexTask({
      options: effectiveOptions,
      prompt: buildWriterContractRefinementPrompt({
        jobDir: effectiveOptions.jobDir,
        researchTitleResult: researchResult,
        draftWriterContract,
        sourceQuality: effectiveOptions.sourceQuality
      }),
      promptFileName,
      resultFileName: "writer-contract-result.json",
      log,
      tokenOffset: totalTokens,
      grossTokenOffset: totalGrossTokens,
      agentTokenOffset: agentTokenTotals.main,
      agent: "main"
    });
    totalTokens += Number(contractResult.tokenUsage?.total || 0);
    totalGrossTokens += Number(contractResult.tokenUsage?.grossTotal || contractResult.tokenUsage?.total || 0);
    agentTokenTotals.main += Number(contractResult.tokenUsage?.total || 0);
    agentGrossTokenTotals.main += Number(contractResult.tokenUsage?.grossTotal || contractResult.tokenUsage?.total || 0);
    rememberRateLimits(contractResult);
    const contractStatus = String(contractResult.status || "").toLowerCase();
    if (contractStatus !== "success" || !contractResult.writerContract || typeof contractResult.writerContract !== "object") {
      return {
        ok: false,
        reason: String(contractResult.failureReason || "Main Agent가 Writer Contract를 발행 가능한 의미 구조로 정리하지 못했습니다.").trim(),
        result: contractResult
      };
    }
    researchResult = {
      ...researchResult,
      writerContract: contractResult.writerContract,
      writerContractRefined: true,
      notes: compactTextList([researchResult.notes, contractResult.notes])
    };
    log("Main Agent Writer Contract 의미 정리 완료", "info", "main");
    return { ok: true, result: contractResult };
  };

  const initialContractRefinement = await refineWriterContract();
  if (!initialContractRefinement.ok) {
    return {
      status: "failed",
      failurePhase: "main_review",
      failureReason: initialContractRefinement.reason,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: compactTextList([initialContractRefinement.reason, initialContractRefinement.result?.notes]),
      researchTitleResult: researchResult,
      mainReviewResult: initialContractRefinement.result,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  const maxReviewAttempts = String(effectiveOptions.topicMode || "").toLowerCase() === "auto" ? 3 : 1;
  let writerResult = null;
  let mainReviewResult = null;
  let mainReviewStatus = "";
  let writerRevisionFeedback = "";
  let writerSupplementSearchUsed = false;

  for (let attempt = 1; attempt <= maxReviewAttempts; attempt += 1) {
    log(`Writer Agent 본문 작성 시작 (${attempt}/${maxReviewAttempts})`, "info", "writer");
    writerResult = await runCodexTask({
      options: effectiveOptions,
      prompt: buildPrompt({
        ...effectiveOptions,
        topic: finalTitle || options.topic,
        researchTitleResult: researchResult,
        writerRevisionFeedback,
        writerAttempt: attempt,
        maxWriterAttempts: maxReviewAttempts
      }),
      promptFileName: attempt === 1 ? "prompt.txt" : `prompt-retry-${attempt}.txt`,
      resultFileName: "agent-result.json",
      log,
      tokenOffset: totalTokens,
      grossTokenOffset: totalGrossTokens,
      agentTokenOffset: agentTokenTotals.writer,
      agent: "writer"
    });
    totalTokens += Number(writerResult.tokenUsage?.total || 0);
    totalGrossTokens += Number(writerResult.tokenUsage?.grossTotal || writerResult.tokenUsage?.total || 0);
    agentTokenTotals.writer += Number(writerResult.tokenUsage?.total || 0);
    agentGrossTokenTotals.writer += Number(writerResult.tokenUsage?.grossTotal || writerResult.tokenUsage?.total || 0);
    rememberRateLimits(writerResult);

    const writerIssueReason = writerOutputIssueReason(writerResult);
    if (writerIssueReason) {
      log(`Writer Agent 작성 실패: ${writerIssueReason}`, "warn", "writer");
      const writerSourceIssue = isSourceInsufficientWriterIssue(writerIssueReason, writerResult, researchResult);
      if (writerSourceIssue && !writerSupplementSearchUsed && typeof options.onSearchNeeded === "function") {
        writerSupplementSearchUsed = true;
        researchSearchRound += 1;
        const forcedSearchNeed = ["light", "normal", "strict"].includes(requestedSearchNeed)
          ? requestedSearchNeed
          : "normal";
        log(`Writer Agent가 근거 부족을 감지해 Research/Title 보강 검색을 1회 요청합니다: ${writerIssueReason}`, "warn", "main");
        preserveAgentFile(
          options.jobDir,
          attempt === 1 ? "prompt.txt" : `prompt-retry-${attempt}.txt`,
          `writer-source-search-before-prompt-${attempt}.txt`
        );
        preserveAgentFile(
          options.jobDir,
          "agent-result.json",
          `writer-source-search-before-result-${attempt}.json`
        );
        const supplementalResearchResult = {
          ...researchResult,
          status: "REVISION",
          searchNeed: forcedSearchNeed,
          failureReason: compactTextList([
            researchResult.failureReason,
            `Writer Agent 근거 부족: ${writerIssueReason}`
          ]).join(" / "),
          searchFlowSummary: compactTextList([
            researchResult.searchFlowSummary,
            `Writer Agent가 선택 제목을 뒷받침할 직접 근거가 부족하다고 판단했습니다: ${writerIssueReason}`
          ]).join(" / "),
          uncertainItems: compactTextList([
            researchResult.uncertainItems,
            writerIssueReason
          ]),
          notes: compactTextList([
            researchResult.notes,
            `Writer Agent 근거 부족 보강 검색 요청: ${writerIssueReason}`
          ])
        };
        const searchPayload = await options.onSearchNeeded(supplementalResearchResult, {
          round: researchSearchRound,
          previousSearchResults: effectiveOptions.searchResults,
          sourceQuality: effectiveOptions.sourceQuality,
          writerSupplement: true,
          writerIssueReason
        });
        effectiveOptions = {
          ...effectiveOptions,
          searchResults: Array.isArray(searchPayload?.searchResults) ? searchPayload.searchResults : [],
          sourceQuality: searchPayload?.sourceQuality || { status: "unknown" },
          researchRevisionContext: [
            "Writer Agent reported insufficient support after Research/Title PASS.",
            `Writer issue: ${writerIssueReason}`,
            "Re-check whether the selected title, topicThesis, writerContract, confirmedFacts, usableSources, and sourceBoundaries are directly supported by the expanded search candidates.",
            "If the expanded candidates still cannot support the title promise, return REVISION or BLOCK instead of PASS."
          ].join("\n")
        };
        preserveAgentFile(
          options.jobDir,
          "research-title-result.json",
          "research-title-writer-source-search-before-result.json"
        );
        researchResult = await runCodexTask({
          options: effectiveOptions,
          prompt: buildResearchTitlePrompt(effectiveOptions),
          promptFileName: "research-title-writer-source-search-prompt.txt",
          resultFileName: "research-title-result.json",
          log,
          tokenOffset: totalTokens,
          grossTokenOffset: totalGrossTokens,
          agentTokenOffset: agentTokenTotals.research,
          agent: "research"
        });
        preserveAgentFile(
          options.jobDir,
          "research-title-result.json",
          "research-title-writer-source-search-result.json"
        );
        totalTokens += Number(researchResult.tokenUsage?.total || 0);
        totalGrossTokens += Number(researchResult.tokenUsage?.grossTotal || researchResult.tokenUsage?.total || 0);
        agentTokenTotals.research += Number(researchResult.tokenUsage?.total || 0);
        agentGrossTokenTotals.research += Number(researchResult.tokenUsage?.grossTotal || researchResult.tokenUsage?.total || 0);
        rememberRateLimits(researchResult);
        log(`Research/Title Agent Writer 보강 검색 후 재분석 완료: ${String(researchResult.status || "UNKNOWN").toUpperCase()}`, "info", "research");
        if (typeof options.onResearchTitle === "function") {
          options.onResearchTitle(researchResult);
        }
        researchStatus = String(researchResult.status || "").toUpperCase();
        requestedSearchNeed = String(researchResult.searchNeed || "").toLowerCase();
        needsSearch = ["light", "normal", "strict"].includes(requestedSearchNeed);

        const supplementalAuthorityIssue = authoritySourceQualityIssueReason(effectiveOptions.sourceQuality);
        if (supplementalAuthorityIssue) {
          log(`Research/Title Agent Writer 보강 검색 후에도 공식 근거가 부족합니다: ${supplementalAuthorityIssue}`, "warn", "research");
          return {
            status: "failed",
            failurePhase: "research",
            failureReason: supplementalAuthorityIssue,
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([supplementalAuthorityIssue, researchResult.notes, writerIssueReason]),
            researchTitleResult: {
              ...researchResult,
              status: researchStatus === "PASS" ? "REVISION" : researchResult.status,
              failureReason: researchResult.failureReason || supplementalAuthorityIssue
            },
            tokenUsage: tokenUsageSnapshot()
          };
        }
        if (researchStatus === "BLOCK" || String(researchResult.status || "").toLowerCase() === "failed") {
          const researchReason = researchResult.failureReason || "Research/Title Agent가 보강 검색 후에도 본문 작성 가능한 제목을 만들지 못했습니다.";
          log(`Research/Title Agent Writer 보강 검색 후 중단: ${researchReason}`, "warn", "research");
          return {
            status: "failed",
            failurePhase: "research",
            failureReason: researchReason,
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([researchResult.notes, writerIssueReason]),
            researchTitleResult: researchResult,
            tokenUsage: tokenUsageSnapshot()
          };
        }
        if (researchStatus === "REVISION") {
          const researchReason = researchRevisionReason(researchResult);
          log(`Research/Title Agent Writer 보강 검색 후에도 본문 작성 가능 상태가 아닙니다: ${researchReason}`, "warn", "research");
          return {
            status: "failed",
            failurePhase: "research",
            failureReason: researchReason,
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([researchReason, researchResult.notes, writerIssueReason]),
            researchTitleResult: researchResult,
            tokenUsage: tokenUsageSnapshot()
          };
        }
        const supplementalCurrentBridgeIssue = currentBridgeIssueReason(researchResult);
        if (supplementalCurrentBridgeIssue) {
          log(`Research/Title Agent Writer 보강 검색 후에도 현재 연결 근거가 부족합니다: ${supplementalCurrentBridgeIssue}`, "warn", "research");
          return {
            status: "failed",
            failurePhase: "research",
            failureReason: supplementalCurrentBridgeIssue,
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([supplementalCurrentBridgeIssue, researchResult.notes, writerIssueReason]),
            researchTitleResult: researchResult,
            tokenUsage: tokenUsageSnapshot()
          };
        }
        finalTitle = String(researchResult.finalTitle || "").trim();
        if (!finalTitle) {
          return {
            status: "failed",
            failurePhase: "research",
            failureReason: "Research/Title Agent가 보강 검색 후에도 최종 제목을 확정하지 못했습니다.",
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([researchResult.notes, writerIssueReason]),
            researchTitleResult: researchResult,
            tokenUsage: tokenUsageSnapshot()
          };
        }
        const supplementalContractRefinement = await refineWriterContract("writer-contract-writer-source-search-prompt.txt");
        if (!supplementalContractRefinement.ok) {
          return {
            status: "failed",
            failurePhase: "main_review",
            failureReason: supplementalContractRefinement.reason,
            title: "",
            article: "",
            tags: [],
            bodyImages: [],
            titleImagePath: "",
            notes: compactTextList([supplementalContractRefinement.reason, supplementalContractRefinement.result?.notes, writerIssueReason]),
            researchTitleResult: researchResult,
            mainReviewResult: supplementalContractRefinement.result,
            tokenUsage: tokenUsageSnapshot()
          };
        }
        writerRevisionFeedback = "";
        attempt = Math.max(0, attempt - 1);
        log(`Writer Agent 근거 보강 후 본문 작성을 다시 시도합니다 (${attempt + 1}/${maxReviewAttempts})`, "warn", "main");
        continue;
      }
      const writerRetryReason = retryableWriterFailureReason(writerResult, researchResult);
      if (writerRetryReason && attempt < maxReviewAttempts) {
        writerRevisionFeedback = writerRetryReason;
        const retryLabel = /date\s*leak|작성일|작성일자|오늘\s*날짜|현재\s*날짜|기준일/i.test(writerRetryReason)
          ? "Writer Agent 날짜/기준일 수정이 필요해 다시 시도합니다"
          : "Writer Agent 결과 수정이 필요해 다시 시도합니다";
        log(`${retryLabel} (${attempt + 1}/${maxReviewAttempts})`, "warn", "main");
        continue;
      }
      return {
        status: "failed",
        failurePhase: "writer",
        failureReason: writerIssueReason,
        title: "",
        article: "",
        tags: [],
        bodyImages: [],
        titleImagePath: "",
        notes: compactTextList([writerIssueReason, writerResult?.notes]),
        researchTitleResult: researchResult,
        tokenUsage: tokenUsageSnapshot()
      };
    }

    log(`Writer Agent 본문 작성 완료 (${attempt}/${maxReviewAttempts})`, "info", "writer");
    log(`Main Agent 최종 검수 시작 (${attempt}/${maxReviewAttempts})`, "info", "main");
    mainReviewResult = await runCodexTask({
      options: effectiveOptions,
      prompt: buildMainReviewPrompt({
        ...effectiveOptions,
        researchTitleResult: researchResult,
        writerResult,
        finalTitle
      }),
      promptFileName: attempt === 1 ? "main-review-prompt.txt" : `main-review-retry-${attempt}.txt`,
      resultFileName: "main-review-result.json",
      log,
      tokenOffset: totalTokens,
      grossTokenOffset: totalGrossTokens,
      agentTokenOffset: agentTokenTotals.main,
      agent: "main"
    });
    totalTokens += Number(mainReviewResult.tokenUsage?.total || 0);
    totalGrossTokens += Number(mainReviewResult.tokenUsage?.grossTotal || mainReviewResult.tokenUsage?.total || 0);
    agentTokenTotals.main += Number(mainReviewResult.tokenUsage?.total || 0);
    agentGrossTokenTotals.main += Number(mainReviewResult.tokenUsage?.grossTotal || mainReviewResult.tokenUsage?.total || 0);
    rememberRateLimits(mainReviewResult);

    mainReviewStatus = String(mainReviewResult.status || "").toUpperCase();
    const mainReviewPassIssue = mainReviewPassIssueReason(mainReviewResult);
    log(`Main Agent 최종 검수 결과: ${mainReviewStatus || "UNKNOWN"}`, mainReviewStatus === "PASS" ? "info" : "warn", "main");
    if (mainReviewPassIssue) {
      log(`Main Agent PASS verification failed: ${mainReviewPassIssue}`, "warn", "main");
    }
    if (mainReviewStatus === "PASS" && !mainReviewPassIssue) {
      break;
    }
    if ((mainReviewStatus === "REVISION" || mainReviewPassIssue) && attempt < maxReviewAttempts) {
      writerRevisionFeedback = compactTextList([
        mainReviewPassIssue,
        revisionFeedbackFrom(mainReviewResult, writerResult)
      ]).join(" / ").slice(0, 4000);
      log(`Main Agent 수정 요청으로 다시 시도합니다 (${attempt + 1}/${maxReviewAttempts})`, "warn", "main");
      continue;
    }

    const reviewReason = mainReviewPassIssue
      || String(mainReviewResult.failureReason || "").trim()
      || "Main Agent 최종 검수에서 발행 가능 기준을 통과하지 못했습니다.";
    return {
      status: "failed",
      failurePhase: "main_review",
      failureReason: reviewReason,
      title: "",
      article: "",
      tags: [],
      bodyImages: [],
      titleImagePath: "",
      notes: [
        reviewReason,
        ...((Array.isArray(mainReviewResult.issues) ? mainReviewResult.issues : []))
      ],
      researchTitleResult: researchResult,
      mainReviewResult,
      tokenUsage: tokenUsageSnapshot()
    };
  }

  let finalWriterResult = {
    ...writerResult,
    title: finalTitle || String(writerResult.title || "").trim()
  };
  const bodyImageLimit = Math.min(10, Math.max(0, Number.isFinite(Number(effectiveOptions.maxBodyImages)) ? Number(effectiveOptions.maxBodyImages) : 2));
  const usesImages = effectiveOptions.includeTitleImage !== false || bodyImageLimit > 0;
  if (usesImages) {
    log("Image Worker 이미지 생성 시작", "info", "main");
    try {
      const imageWorkerResult = await runCodexTask({
        options: effectiveOptions,
        prompt: buildImageWorkerPrompt({
          ...effectiveOptions,
          writerResult: finalWriterResult,
          finalTitle
        }),
        promptFileName: "image-worker-prompt.txt",
        resultFileName: "image-worker-result.json",
        log,
        tokenOffset: totalTokens,
        grossTokenOffset: totalGrossTokens,
        agentTokenOffset: agentTokenTotals.image,
        agent: "image"
      });
      totalTokens += Number(imageWorkerResult.tokenUsage?.total || 0);
      totalGrossTokens += Number(imageWorkerResult.tokenUsage?.grossTotal || imageWorkerResult.tokenUsage?.total || 0);
      agentTokenTotals.image += Number(imageWorkerResult.tokenUsage?.total || 0);
      agentGrossTokenTotals.image += Number(imageWorkerResult.tokenUsage?.grossTotal || imageWorkerResult.tokenUsage?.total || 0);
      rememberRateLimits(imageWorkerResult);
      const imageStatus = String(imageWorkerResult.status || "").toLowerCase();
      if (imageStatus !== "success") {
        log("Image Worker 이미지 생성 완료, 파일 저장 중입니다.", "info", "main");
      } else {
        log("Image Worker 이미지 생성 완료", "info", "main");
      }
      finalWriterResult = mergeImageWorkerResult(finalWriterResult, imageWorkerResult, effectiveOptions);
    } catch (error) {
      if (isCodexUsageLimitError(error)) {
        throw error;
      }
      log(`Image Worker 실패: ${error.message}. 이미지 삽입 없이 본문 작성을 계속합니다.`, "warn", "main");
      finalWriterResult = mergeImageWorkerResult(finalWriterResult, {
        status: "failed",
        failureReason: error.message,
        titleImagePath: "",
        bodyImages: [],
        notes: [`Image Worker 실패: ${error.message}`]
      }, effectiveOptions);
    }
  }

  return {
    ...finalWriterResult,
    researchTitleResult: researchResult,
    mainReviewResult,
    tokenUsage: tokenUsageSnapshot()
  };
}

module.exports = {
  runCodexGeneration,
  fetchCodexUsageSnapshot,
  _private: {
    compactSearchResultsForPrompt,
    rankSearchResultsForPrompt,
    buildWriterContract
  }
};
