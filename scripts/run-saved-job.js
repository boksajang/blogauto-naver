const path = require("node:path");
const { normalizeImageAspectRatio, readSettings } = require("../src/lib/settings");
const { readAccountStore, getAccountProfileDir } = require("../src/lib/accountStore");
const { ensureRuntimeFiles, readHistory, appendHistory } = require("../src/lib/history");
const { collectSearchResults } = require("../src/lib/search");
const { runCodexGeneration } = require("../src/lib/codexRunner");
const { normalizeAgentResult, getPreviewImages } = require("../src/lib/imageAssets");
const { createEmbedding, cosineSimilarity } = require("../src/lib/embedding");
const { publishToNaver } = require("../src/lib/naverPublisher");

function log(message, level = "info") {
  const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
  const safe = String(message || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/password\s*[:=]\s*\S+/gi, "password=[redacted]");
  if (!safe.trim()) return;
  console.log(`[${new Date().toLocaleTimeString()}] ${prefix} ${safe}`);
}

function todayLabel() {
  const now = new Date();
  return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
}

function sanitizeNaverTag(value) {
  return String(value || "")
    .replace(/^#+/, "")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function buildTags(topic, keyword, articleTags) {
  return [...new Set([
    topic,
    keyword,
    ...(Array.isArray(articleTags) ? articleTags : [])
  ]
    .flatMap((item) => String(item || "").split(/[,\n#]+/))
    .map(sanitizeNaverTag)
    .filter(Boolean))]
    .slice(0, 29);
}

function summarizeSourceQuality(searchResults, topicMode = "manual") {
  const results = Array.isArray(searchResults) ? searchResults : [];
  const withExcerpt = results.filter((item) => String(item?.excerpt || "").trim().length >= 80);
  const usable = results.filter((item) => {
    const excerptLength = String(item?.excerpt || "").trim().length;
    const contentLength = Number(item?.contentLength || 0);
    return excerptLength >= 120 || contentLength >= 300;
  });
  const topicMatched = results.filter((item) => Array.isArray(item?.relevance?.topicMatchedTerms) && item.relevance.topicMatchedTerms.length);
  const requiresTopicMatch = String(topicMode || "manual") !== "auto";
  const status = usable.length && (!requiresTopicMatch || topicMatched.length) ? "usable" : "insufficient";
  return {
    status,
    totalCandidates: results.length,
    extractedCandidates: withExcerpt.length,
    usableExtractedCandidates: usable.length,
    topicMatchedCandidates: topicMatched.length,
    reason: status === "usable"
      ? "검색 후보에서 사용할 수 있는 본문 발췌가 확보되었습니다."
      : "검색 후보에서 사용할 수 있는 본문 발췌가 부족합니다. 주제/키워드 오타 또는 검색 결과 불일치 가능성이 있습니다."
  };
}

function detectCodexSourceFailure(result) {
  const status = String(result?.status || "").toLowerCase();
  const explicitReason = String(result?.failureReason || result?.reason || "").trim();
  if (["failed", "failure", "source_failed", "insufficient_sources"].includes(status)) {
    return explicitReason || "본문 발췌 실패: Codex가 발행 가능한 근거 자료를 확보하지 못했습니다.";
  }
  if (explicitReason) return explicitReason;
  return "";
}

function todayLabel() {
  const now = new Date();
  return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
}

function pickAccountAndCategory(runtimeRoot, settings) {
  const store = readAccountStore(runtimeRoot, settings);
  const account = store.accounts.find((item) => item.id === store.selectedAccountId)
    || store.accounts.find((item) => item.checked !== false)
    || null;
  const categoryItem = (account?.categories || []).find((item) => item.checked !== false) || null;
  const category = categoryItem?.name || settings.category || "";
  const keyword = categoryItem?.keyword || settings.keyword || "";
  return { account, category, keyword };
}

async function main() {
  const runtimeRoot = process.env.BLOGAUTO_RUNTIME_ROOT
    ? path.resolve(process.env.BLOGAUTO_RUNTIME_ROOT)
    : path.resolve(__dirname, "..", "dist", "runtime");
  ensureRuntimeFiles(runtimeRoot);
  const settings = readSettings(runtimeRoot);
  const { account, category, keyword } = pickAccountAndCategory(runtimeRoot, settings);

  let topic = String(settings.topic || "").trim();
  const naverId = String(account?.naverId || settings.naverId || "").trim();
  const blogId = String(account?.blogId || settings.blogId || naverId).trim();
  const naverPassword = String(account?.naverPassword || settings.naverPassword || "");
  const codexCmdPath = "codex.cmd";
  const shouldPublish = settings.publishAfterGenerate === true;
  const publishVisibility = String(settings.publishVisibility || (settings.publishPrivate === false ? "public" : "private"));
  const publishPrivate = publishVisibility !== "public";
  const jobId = `job_${Date.now()}`;
  const jobDir = path.join(runtimeRoot, "jobs", jobId);
  const tokenUsage = { total: 0 };

  if (!category) throw new Error("user-settings.json에 category 값이 없습니다.");
  if (String(settings.topicMode || "manual") === "auto") {
    topic = "";
  }
  if (!topic && String(settings.topicMode || "manual") !== "auto") {
    throw new Error("user-settings.json에 topic 값이 없습니다.");
  }
  if (shouldPublish && !naverId) {
    throw new Error("발행까지 진행하려면 user-settings.json 또는 account-categories.json의 Naver ID가 필요합니다.");
  }

  log(`작업 시작: ${jobId}`);
  const currentDateLabel = todayLabel();
  const history = readHistory(runtimeRoot);
  const titleHistory = history
    .filter((entry) => String(entry.blog_id || "") === blogId)
    .filter((entry) => Array.isArray(entry.embedding))
    .map((entry) => ({ title: entry.title, embedding: entry.embedding }));

  const codexResult = await runCodexGeneration({
    codexCmdPath,
    runtimeRoot,
    jobDir,
    topic,
    keyword,
    category,
    topicMode: settings.topicMode || "manual",
    searchResults: [],
    currentDateLabel,
    includeTitleImage: settings.includeTitleImage !== false,
    imageAspectRatio: normalizeImageAspectRatio(settings.imageAspectRatio),
    maxBodyImages: Number.isFinite(Number(settings.maxBodyImages)) ? Number(settings.maxBodyImages) : 2,
    sourceQuality: { status: "not_requested" },
    historyTitles: titleHistory.map((item) => item.title),
    onTokenUsage: (usage) => {
      tokenUsage.total = Number(usage.total || 0);
      log(`토큰 사용량 ${tokenUsage.total.toLocaleString()} tokens`);
    },
    onSearchNeeded: async (researchResult) => {
      const searchTopic = String(
        researchResult.topicThesis
        || researchResult.finalTitle
        || researchResult.selectedTitle
        || topic
        || `${category} ${keyword}`.trim()
      ).trim();
      log(`Research/Title Agent 요청으로 검색 후보 수집 시작: ${researchResult.searchNeed || "normal"}`);
      const searchResults = await collectSearchResults({
        topic: searchTopic,
        keyword: keyword || category,
        topicMode: settings.topicMode || "manual",
        primaryProvider: settings.primarySearchProvider || "naver",
        fallbackProvider: settings.fallbackSearchProvider || "google",
        naverSearchUrl: settings.naverSearchUrl,
        googleSearchUrl: settings.googleSearchUrl
      }, log);
      const sourceQuality = summarizeSourceQuality(searchResults, settings.topicMode || "manual");
      if (sourceQuality.status === "insufficient") {
        log(sourceQuality.reason, "warn");
      }
      log(`검색 후보 ${searchResults.length}개 수집`);
      return { searchResults, sourceQuality };
    }
  }, log);
  if (codexResult.tokenUsage?.total) {
    tokenUsage.total = Number(codexResult.tokenUsage.total || 0);
  }
  const sourceFailureReason = detectCodexSourceFailure(codexResult);
  if (sourceFailureReason) {
    appendHistory(runtimeRoot, {
      id: jobId,
      create_at: new Date().toISOString(),
      account_id: account?.id || "",
      blog_id: blogId,
      title: "",
      topic,
      keyword,
      status: "failed",
      embedding_model: "local-hash-v1",
      embedding: createEmbedding(`${topic} ${keyword}`.trim() || topic),
      token_total: tokenUsage.total,
      reason: sourceFailureReason
    });
    log(sourceFailureReason, "error");
    return;
  }

  const agentResult = normalizeAgentResult({
    runtimeRoot,
    jobDir,
    topic,
    keyword,
    includeTitleImage: settings.includeTitleImage !== false,
    maxBodyImages: Number.isFinite(Number(settings.maxBodyImages)) ? Number(settings.maxBodyImages) : 2,
    currentDateLabel,
    result: codexResult
  });
  for (const note of agentResult.notes || []) {
    log(note, note.includes("이미지") ? "warn" : "info");
  }
  log(`제목: ${agentResult.title}`);
  log(`이미지 미리보기 ${getPreviewImages(agentResult).length}개`);

  const embedding = createEmbedding(agentResult.title);
  let maxSimilarity = 0;
  for (const item of titleHistory) {
    maxSimilarity = Math.max(maxSimilarity, cosineSimilarity(embedding, item.embedding));
  }
  if (maxSimilarity >= 0.75) {
    appendHistory(runtimeRoot, {
      id: jobId,
      create_at: new Date().toISOString(),
      account_id: account?.id || "",
      blog_id: blogId,
      title: agentResult.title,
      topic,
      keyword,
      status: "duplicate_retry",
      embedding_model: "local-hash-v1",
      embedding,
      token_total: tokenUsage.total,
      reason: `기존 제목과 cosine similarity ${maxSimilarity.toFixed(3)}`
    });
    log(`중복 제목으로 중단: ${maxSimilarity.toFixed(3)}`, "warn");
    return;
  }

  const tags = buildTags(topic, keyword, agentResult.tags);
  let status = "generated";
  let reason = "";

  if (shouldPublish) {
    log("Naver 비공개 발행 시작");
    await publishToNaver({
      naverId,
      blogId,
      naverPassword,
      category,
      publishPrivate,
      publishVisibility,
      publishScheduleMode: settings.publishScheduleMode || "now",
      reserveAfterHours: Number(settings.reserveAfterHours || 0),
      title: agentResult.title,
      article: agentResult.article,
      titleImagePath: agentResult.titleImagePath,
      bodyImages: agentResult.bodyImages,
      breakSentencesInBody: settings.breakSentencesInBody !== false,
      tags,
      domNotes: settings.naverEditorDomNotes || "",
      browserProfileDir: account ? getAccountProfileDir(runtimeRoot, account) : path.join(runtimeRoot, "browser-profile"),
      log
    });
    status = "success";
    log("Naver 비공개 발행 완료");
  } else {
    reason = "publishAfterGenerate=false";
    log("본문 생성 완료, 발행은 실행하지 않음");
  }

  appendHistory(runtimeRoot, {
    id: jobId,
    create_at: new Date().toISOString(),
    account_id: account?.id || "",
    blog_id: blogId,
    title: agentResult.title,
    topic,
    keyword,
    status,
    embedding_model: "local-hash-v1",
    embedding,
    token_total: tokenUsage.total,
    reason
  });
}

main().catch((error) => {
  console.error(`[${new Date().toLocaleTimeString()}] ERROR ${error.message}`);
  process.exit(1);
});
