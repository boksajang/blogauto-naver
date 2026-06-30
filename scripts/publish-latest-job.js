const fs = require("node:fs");
const path = require("node:path");
const { readSettings } = require("../src/lib/settings");
const { readAccountStore, getAccountProfileDir } = require("../src/lib/accountStore");
const { normalizeAgentResult } = require("../src/lib/imageAssets");
const { publishToNaver } = require("../src/lib/naverPublisher");
const { appendHistory, ensureRuntimeFiles } = require("../src/lib/history");
const { createEmbedding } = require("../src/lib/embedding");

function log(message, level = "info") {
  const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
  const safe = String(message || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/password\s*[:=]\s*\S+/gi, "password=[redacted]");
  if (!safe.trim()) return;
  console.log(`[${new Date().toLocaleTimeString()}] ${prefix} ${safe}`);
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

function detectCodexSourceFailure(result) {
  const status = String(result?.status || "").toLowerCase();
  const explicitReason = String(result?.failureReason || result?.reason || "").trim();
  if (["failed", "failure", "source_failed", "insufficient_sources"].includes(status)) {
    return explicitReason || "본문 발췌 실패: Codex가 발행 가능한 근거 자료를 확보하지 못했습니다.";
  }
  if (explicitReason) return explicitReason;
  return "";
}

function latestJobDir(runtimeRoot) {
  const jobsRoot = path.join(runtimeRoot, "jobs");
  const jobs = fs.readdirSync(jobsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(jobsRoot, entry.name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .filter((entry) => fs.existsSync(path.join(entry.fullPath, "agent-result.json")))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!jobs.length) {
    throw new Error("agent-result.json이 있는 작업 폴더를 찾지 못했습니다.");
  }
  return jobs[0].fullPath;
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
  const topic = String(settings.topic || "").trim();
  const naverId = String(account?.naverId || settings.naverId || "").trim();
  const blogId = String(account?.blogId || settings.blogId || naverId).trim();
  const naverPassword = String(account?.naverPassword || settings.naverPassword || "");
  const jobDir = latestJobDir(runtimeRoot);
  const rawResult = JSON.parse(fs.readFileSync(path.join(jobDir, "agent-result.json"), "utf8"));
  const sourceFailureReason = detectCodexSourceFailure(rawResult);
  if (sourceFailureReason) {
    throw new Error(sourceFailureReason);
  }
  const agentResult = normalizeAgentResult({
    runtimeRoot,
    jobDir,
    topic,
    keyword,
    includeTitleImage: settings.includeTitleImage !== false,
    maxBodyImages: Number.isFinite(Number(settings.maxBodyImages)) ? Number(settings.maxBodyImages) : 2,
    currentDateLabel: "",
    result: rawResult
  });

  if (!naverId) {
    throw new Error("발행 테스트에는 저장된 Naver ID가 필요합니다.");
  }
  if (!category) {
    throw new Error("발행 테스트에는 저장된 category가 필요합니다.");
  }

  log(`최신 작업 재사용: ${path.basename(jobDir)}`);
  log(`제목: ${agentResult.title}`);
  await publishToNaver({
    naverId,
    blogId,
    naverPassword,
    category,
    publishPrivate: settings.publishPrivate !== false,
    publishVisibility: settings.publishVisibility || (settings.publishPrivate === false ? "public" : "private"),
    publishScheduleMode: settings.publishScheduleMode || "now",
    reserveAfterHours: Number(settings.reserveAfterHours || 0),
    title: agentResult.title,
    article: agentResult.article,
    titleImagePath: agentResult.titleImagePath,
    bodyImages: agentResult.bodyImages,
    breakSentencesInBody: settings.breakSentencesInBody !== false,
    tags: buildTags(topic, keyword, agentResult.tags),
    domNotes: settings.naverEditorDomNotes || "",
    browserProfileDir: account ? getAccountProfileDir(runtimeRoot, account) : path.join(runtimeRoot, "browser-profile"),
    log
  });
  appendHistory(runtimeRoot, {
    id: `${path.basename(jobDir)}_publish_${Date.now()}`,
    create_at: new Date().toISOString(),
    blog_id: blogId,
    title: agentResult.title,
    topic,
    keyword,
    status: "success",
    embedding_model: "local-hash-v1",
    embedding: createEmbedding(agentResult.title),
    token_total: 0,
    reason: "publish:latest 테스트 경로에서 발행 완료"
  });
  log("blog_history.jsonl에 발행 성공 기록을 남겼습니다.");
}

main().catch((error) => {
  console.error(`[${new Date().toLocaleTimeString()}] ERROR ${error.message}`);
  process.exit(1);
});
