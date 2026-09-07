const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { _private } = require(path.join(root, "src", "lib", "naverPublisher.js"));

function createLoginStatePage(states) {
  let index = 0;
  const current = () => states[Math.min(index, states.length - 1)];

  return {
    stateReads() {
      return index + 1;
    },
    isClosed() {
      return false;
    },
    async goto() {},
    url() {
      return current().url;
    },
    locator(selector) {
      if (selector === "body") {
        return {
          async innerText() {
            return current().bodyText || "";
          }
        };
      }
      return {
        async count() {
          const count = current().loginInputs || 0;
          index = Math.min(index + 1, states.length - 1);
          return count;
        },
        nth() {
          return {
            async isVisible() {
              return true;
            }
          };
        }
      };
    }
  };
}

async function run() {
  const publisherSource = fs.readFileSync(path.join(root, "src", "lib", "naverPublisher.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
  const selectors = { idInput: "#id", passwordInput: "#pw" };
  const captcha = {
    url: "https://nid.naver.com/nidlogin.login?mode=number",
    bodyText: "보안 확인 자동입력 방지"
  };
  const editor = {
    url: "https://blog.naver.com/test-blog/postwrite",
    bodyText: "스마트에디터 글쓰기"
  };
  const login = {
    url: "https://nid.naver.com/nidlogin.login",
    bodyText: "로그인",
    loginInputs: 2
  };
  const testOptions = {
    securityCheckTimeout: 100,
    securityCheckPollInterval: 1,
    securityCheckStableReads: 1
  };

  assert.equal(
    _private.looksLikeSecurityCheck(captcha.url, captcha.bodyText),
    true,
    "Naver CAPTCHA must be classified as a security check"
  );
  assert.equal(
    _private.looksLikeSecurityCheck(editor.url, "본문에서 보안 확인 방법을 설명합니다."),
    false,
    "ordinary blog text must not be classified as a security check"
  );
  assert.match(
    publisherSource,
    /const stateAfterSecurityCheck = await waitForSecurityCheckComplete[\s\S]*stateAfterSecurityCheck\.state === "login_required"[\s\S]*await completeLoginIfNeeded\(page, selectors, options, log\)/,
    "initial CAPTCHA completion must continue through an interactive login screen before target verification"
  );
  assert.doesNotMatch(
    publisherSource,
    /humanFill\(page, selectors\.(?:idInput|passwordInput)|loginSubmit:|Naver 로그인 제출 버튼/,
    "Naver credentials and login submission must never be automated"
  );
  assert.match(
    publisherSource,
    /아이디와 비밀번호를 직접 입력해 주세요[\s\S]*await waitForLoginComplete/,
    "manual Naver login must wait in the open browser until the user completes it"
  );
  assert.match(
    publisherSource,
    /recoverSessionDuringWork:\s*true[\s\S]*for \(;;\)[\s\S]*NAVER_AUTHORING_RESTART_REQUIRED[\s\S]*브라우저를 닫지 않고/,
    "mid-authoring CAPTCHA recovery must retry authoring in the same browser instead of escaping to context cleanup"
  );
  assert.match(
    publisherSource,
    /resumeDraftAfterSessionRecovery === true[\s\S]*resumeExistingDraftDialog/,
    "post-login editor recovery must prefer resuming the Naver draft instead of cancelling it"
  );
  assert.match(
    mainSource,
    /verifyPublishSessionBeforeGeneration[\s\S]*checkNaverSession\(\{[\s\S]*interactiveLogin:\s*true/,
    "pre-generation session checks must stay interactive after CAPTCHA instead of closing as expired"
  );

  const resolvedState = await _private.waitForSecurityCheckComplete(
    createLoginStatePage([captcha, editor]),
    selectors,
    () => {},
    testOptions
  );
  assert.equal(resolvedState.state, "available", "solved CAPTCHA must resume the active session");

  await _private.completeLoginIfNeeded(
    createLoginStatePage([captcha, editor]),
    selectors,
    { ...testOptions, failOnLoginRequired: true },
    () => {}
  );

  const unstableLoginTransition = createLoginStatePage([login, editor, login, editor, editor]);
  await _private.waitForLoginComplete(
    unstableLoginTransition,
    () => {},
    100,
    selectors,
    0
  );
  assert.ok(
    unstableLoginTransition.stateReads() >= 5,
    "a single transient non-login page must not be accepted as completed login"
  );

  const restartError = _private.authoringRestartRequiredError("본문 입력");
  assert.equal(restartError.code, "NAVER_AUTHORING_RESTART_REQUIRED");

  const postWritePage = createLoginStatePage([captcha, editor]);
  const verifiedPostWrite = await _private.verifyPostWriteSession(
    { pages: () => [postWritePage] },
    postWritePage,
    selectors,
    testOptions,
    editor.url,
    () => {}
  );
  assert.equal(verifiedPostWrite.status, "valid", "postwrite verification must continue after a solved CAPTCHA");
  assert.equal(verifiedPostWrite.reason, "postwrite_session_available");

  await _private.assertNaverSessionActive(
    createLoginStatePage([captcha, editor]),
    selectors,
    () => {},
    "본문 입력",
    testOptions
  );

  await assert.rejects(
    _private.assertNaverSessionActive(
      createLoginStatePage([captcha, login]),
      selectors,
      () => {},
      "본문 입력",
      testOptions
    ),
    (error) => error && error.code === "SESSION_EXPIRED",
    "a real login screen after CAPTCHA must still expire the session"
  );

  await assert.rejects(
    _private.waitForSecurityCheckComplete(
      createLoginStatePage([captcha]),
      selectors,
      () => {},
      { securityCheckTimeout: 10, securityCheckPollInterval: 1, securityCheckStableReads: 1 }
    ),
    (error) => error && error.code === "SECURITY_CHECK_TIMEOUT",
    "an unsolved CAPTCHA must time out without being mislabeled as session expiration"
  );

  console.log("Naver CAPTCHA session transition checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
