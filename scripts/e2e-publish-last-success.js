const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const runtimeRoot = path.join(root, "runtime");
const { readSettings, normalizeMaxBodyImages } = require(path.join(root, "src", "lib", "settings.js"));
const { readAccountStore, getAccountProfileDir } = require(path.join(root, "src", "lib", "accountStore.js"));
const { normalizeAgentResult } = require(path.join(root, "src", "lib", "imageAssets.js"));
const { publishToNaver } = require(path.join(root, "src", "lib", "naverPublisher.js"));

function log(message, level = "info") {
  console.log(`[${new Date().toLocaleTimeString()}] ${String(level).toUpperCase()} ${message}`);
}

function readLatestSuccess() {
  const historyPath = path.join(runtimeRoot, "blog_history.jsonl");
  const entries = fs.readFileSync(historyPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return entries.reverse().find((entry) => entry.status === "success") || null;
}

function withExactGeneratedImages(jobDir, rawResult) {
  const imageResultPath = path.join(jobDir, "image-worker-result.json");
  if (!fs.existsSync(imageResultPath)) {
    throw new Error("마지막 성공 작업의 image-worker-result.json을 찾지 못했습니다.");
  }
  const imageResult = JSON.parse(fs.readFileSync(imageResultPath, "utf8"));
  if (imageResult.status !== "success") {
    throw new Error(`마지막 성공 작업의 이미지 결과가 성공 상태가 아닙니다: ${imageResult.status}`);
  }

  const imageBySequence = new Map(
    (imageResult.bodyImages || []).map((item) => [Number(item.sequence), item])
  );
  const bodyImages = (rawResult.bodyImages || []).map((item, index) => {
    const sequence = Number(item.sequence || index + 1);
    const generated = imageBySequence.get(sequence);
    if (!generated?.path || !fs.existsSync(generated.path)) {
      throw new Error(`마지막 성공 작업의 본문 이미지 ${sequence} 파일을 찾지 못했습니다.`);
    }
    return { ...item, sequence, path: generated.path };
  });
  if (!imageResult.titleImagePath || !fs.existsSync(imageResult.titleImagePath)) {
    throw new Error("마지막 성공 작업의 타이틀 이미지 파일을 찾지 못했습니다.");
  }

  return {
    ...rawResult,
    titleImagePath: imageResult.titleImagePath,
    bodyImages
  };
}

async function main() {
  const latest = readLatestSuccess();
  if (!latest) throw new Error("성공한 작업 이력을 찾지 못했습니다.");

  const jobDir = path.join(runtimeRoot, "jobs", latest.id);
  const resultPath = path.join(jobDir, "agent-result.json");
  if (!fs.existsSync(resultPath)) {
    throw new Error(`마지막 성공 작업 결과가 없습니다: ${latest.id}`);
  }

  const settings = readSettings(runtimeRoot);
  const store = readAccountStore(runtimeRoot, settings);
  const account = store.accounts.find((item) => item.id === latest.account_id);
  if (!account) throw new Error(`마지막 성공 작업 계정을 찾지 못했습니다: ${latest.account_id}`);
  const categoryItem = (account.categories || []).find((item) => item.checked !== false);
  const category = categoryItem?.name || latest.category || settings.category || "";
  if (!category) throw new Error("E2E 발행에 사용할 네이버 카테고리를 찾지 못했습니다.");

  const rawResult = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const exactResult = withExactGeneratedImages(jobDir, rawResult);
  const agentResult = normalizeAgentResult({
    runtimeRoot,
    jobDir,
    topic: latest.topic || latest.title,
    result: exactResult,
    includeTitleImage: true,
    maxBodyImages: normalizeMaxBodyImages(settings.maxBodyImages),
    currentDateLabel: ""
  });
  if (!agentResult.titleImagePath || agentResult.bodyImages.length !== exactResult.bodyImages.length) {
    throw new Error("마지막 성공 작업의 정확한 이미지 세트를 준비하지 못했습니다.");
  }

  log("Codex/검색/이미지 생성 없이 마지막 성공 결과를 그대로 재사용합니다.");
  log(`기준 작업: ${latest.id}`);
  log(`제목: ${agentResult.title}`);
  log(`본문 ${agentResult.article.length.toLocaleString()}자 / 타이틀 이미지 1장 / 본문 이미지 ${agentResult.bodyImages.length}장`);
  log("E2E 게시물은 네이버 비공개·즉시 발행으로 진행합니다.", "warn");

  await publishToNaver({
    accountId: account.id,
    blogId: account.blogId || latest.blog_id || account.naverId,
    category,
    publishPrivate: true,
    publishVisibility: "private",
    publishScheduleMode: "now",
    reserveAfterHours: 0,
    failOnLoginRequired: false,
    title: agentResult.title,
    article: agentResult.article,
    titleImagePath: agentResult.titleImagePath,
    bodyImages: agentResult.bodyImages,
    breakSentencesInBody: settings.breakSentencesInBody !== false,
    tags: agentResult.tags,
    domNotes: settings.naverEditorDomNotes || "",
    browserProfileDir: getAccountProfileDir(runtimeRoot, account),
    log
  });

  log("E2E 비공개 발행이 완료되었습니다.");
}

main().catch((error) => {
  console.error(`[${new Date().toLocaleTimeString()}] ERROR [${error.code || "ERROR"}] ${error.message}`);
  process.exit(1);
});
