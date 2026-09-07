const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const runtimeRoot = path.join(root, "runtime");
const { readAccountStore, getAccountProfileDir } = require(path.join(root, "src", "lib", "accountStore.js"));
const { checkNaverSession } = require(path.join(root, "src", "lib", "naverPublisher.js"));

function latestSuccessfulHistory() {
  const historyPath = path.join(runtimeRoot, "blog_history.jsonl");
  const rows = fs.readFileSync(historyPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return rows.reverse().find((row) => row.status === "success") || null;
}

async function run() {
  const latest = latestSuccessfulHistory();
  if (!latest) throw new Error("성공 이력에서 테스트 기준 작업을 찾지 못했습니다.");

  const store = readAccountStore(runtimeRoot);
  const account = store.accounts.find((item) => item.id === latest.account_id);
  if (!account) throw new Error(`마지막 성공 작업의 계정을 찾지 못했습니다: ${latest.account_id}`);

  const browserProfileDir = getAccountProfileDir(runtimeRoot, account);
  console.log(`기준 성공 작업: ${latest.id} / ${latest.title}`);
  console.log(`세션 프로필: ${path.basename(browserProfileDir)}`);

  const result = await checkNaverSession({
    blogId: account.blogId || latest.blog_id || account.naverId,
    browserProfileDir,
    interactiveLogin: false,
    keepOpen: false,
    requireEditor: true,
    securityCheckTimeout: 2 * 60 * 1000,
    log(message, level = "info") {
      console.log(`[${level}] ${message}`);
    }
  });

  console.log(`실제 세션 검사 결과: ${result.status} (${result.reason || "no reason"})`);
  if (result.status !== "valid") process.exitCode = 2;
}

run().catch((error) => {
  console.error(`실제 세션 검사 실패 [${error.code || "ERROR"}]: ${error.message}`);
  process.exit(1);
});
