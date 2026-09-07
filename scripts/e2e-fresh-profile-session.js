const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const runtimeRoot = path.join(root, "runtime");
const { readAccountStore } = require(path.join(root, "src", "lib", "accountStore.js"));
const { checkNaverSession } = require(path.join(root, "src", "lib", "naverPublisher.js"));

function latestSuccessfulHistory() {
  return fs.readFileSync(path.join(runtimeRoot, "blog_history.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .reverse()
    .find((entry) => entry.status === "success") || null;
}

async function main() {
  const latest = latestSuccessfulHistory();
  if (!latest) throw new Error("성공 이력에서 테스트 계정을 찾지 못했습니다.");
  const store = readAccountStore(runtimeRoot);
  const account = store.accounts.find((item) => item.id === latest.account_id);
  if (!account) throw new Error(`테스트 계정을 찾지 못했습니다: ${latest.account_id}`);
  const blogId = account.blogId || latest.blog_id || account.naverId;
  if (!blogId) throw new Error("빈 프로필 로그인 E2E에는 Blog ID가 필요합니다.");

  const freshProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "blogauto-naver-captcha-"));
  console.log(`격리 임시 프로필: ${path.basename(freshProfileDir)}`);
  console.log("새 Chrome 프로필에서 로그인 화면이 열리면 아이디·비밀번호와 CAPTCHA를 모두 직접 입력해 주세요.");

  try {
    const result = await checkNaverSession({
      blogId,
      browserProfileDir: freshProfileDir,
      interactiveLogin: true,
      keepOpen: false,
      requireEditor: true,
      failOnLoginRequired: false,
      securityCheckTimeout: 10 * 60 * 1000,
      editorCheckTimeout: 2 * 60 * 1000,
      log(message, level = "info") {
        console.log(`[${String(level).toUpperCase()}] ${message}`);
      }
    });
    console.log(`빈 프로필 세션 E2E 결과: ${result.status} (${result.reason || "no reason"})`);
    if (result.status !== "valid") process.exitCode = 2;
  } finally {
    fs.rmSync(freshProfileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    console.log("격리 임시 프로필을 삭제했습니다.");
  }
}

main().catch((error) => {
  console.error(`빈 프로필 세션 E2E 실패 [${error.code || "ERROR"}]: ${error.message}`);
  process.exit(1);
});
